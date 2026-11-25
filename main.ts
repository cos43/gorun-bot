// Momentum Rotation Bot — make.fun "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana"
//
// Strategy: 24-bar momentum rotation over the 7-asset Solana universe.
//   - Each symbol keeps its close history and a 24-bar EMA (seeded with the mean
//     of its first 24 closes, then EMA += 2/25 * (close - EMA)).
//   - ROC24 = close / close 24 bars ago - 1.
//   - A symbol is eligible only when ROC24 > 0.005 and close > EMA24.
//   - Eligible symbols are ranked by ROC24; the target set holds at most 4.
//   - Hysteresis: symbols already held keep their slot. An unheld challenger
//     fills a free slot directly, or — when full — replaces the weakest held
//     target only when its ROC24 exceeds that target's ROC24 by 0.04.
//   - Held symbols outside the target set are sold in full (sells first).
//   - Each new target is bought for min(equity/4, 25% weight room, cash left),
//     never below the 1 USDC minimum notional; cash is counted from the start
//     of the batch, so same-reply sell proceeds never fund a buy.
//   - No orders during warm-up; only history is accumulated.
//   - Fully deterministic: float64 arithmetic only, no clock, no randomness,
//     no environment, no network.
//
// Local grade on the kit dev window (grade-local, process driver, Node 24):
//   net PnL -352.82 USDC, 44 trades, fees 113.03 USDC, max drawdown 4.8%,
//   guardrails met, 1 rejected; buy-and-hold baseline on the same window is
//   -869.34 USDC. Two executions reproduced byte for byte.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const LOOKBACK = 24;
const MIN_ROC = 0.005;
const MAX_HOLDINGS = 4;
const HYSTERESIS = 0.04;
const MAX_SLIPPAGE_BPS = 100;

const EMA_K = 2 / (LOOKBACK + 1);

interface SymbolHistory {
  closes: number[];
  ema: number | null;
}

interface Signal {
  symbol: string;
  roc: number;
}

const histories = new Map<string, SymbolHistory>();

function historyOf(symbol: string): SymbolHistory {
  let h = histories.get(symbol);
  if (h === undefined) {
    h = { closes: [], ema: null };
    histories.set(symbol, h);
  }
  return h;
}

/** Latest close of a symbol in USDC (float), from the bar state. */
function closeUsd(state: BarsState, symbol: string): number | null {
  const bar = state.latest.get(symbol);
  const info = state.symbols.get(symbol);
  if (bar === undefined || info === undefined) return null;
  return Number(BigInt(bar.c)) / 10 ** info.price_scale;
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  // 1. Accumulate history from this batch's bars (also during warm-up).
  for (const bar of batch.bars) {
    const close = closeUsd(state, bar.symbol);
    if (close === null) continue;
    const h = historyOf(bar.symbol);
    h.closes.push(close);
    if (h.closes.length === LOOKBACK) {
      let sum = 0;
      for (const c of h.closes) sum += c;
      h.ema = sum / LOOKBACK;
    } else if (h.closes.length > LOOKBACK && h.ema !== null) {
      h.ema = h.ema + EMA_K * (close - h.ema);
    }
  }

  // 2. Warm-up: build history only, never trade.
  if (state.warmingUp) return [];

  // 3. Momentum + trend filter, ranked by ROC24 (ties broken by symbol for determinism).
  const eligible: Signal[] = [];
  for (const [symbol, h] of histories) {
    if (h.closes.length <= LOOKBACK || h.ema === null) continue;
    const close = h.closes[h.closes.length - 1];
    const prev = h.closes[h.closes.length - 1 - LOOKBACK];
    const roc = close / prev - 1;
    if (roc > MIN_ROC && close > h.ema) eligible.push({ symbol, roc });
  }
  eligible.sort((a, b) => b.roc - a.roc || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const rocBySymbol = new Map(eligible.map((s) => [s.symbol, s.roc]));

  // 4. Target set with hysteresis: held eligible symbols keep their slots.
  const held = new Set<string>();
  for (const [symbol, pos] of state.positions) {
    if (pos.qty > 0n) held.add(symbol);
  }
  const targets = new Set<string>();
  for (const s of eligible) {
    if (held.has(s.symbol)) targets.add(s.symbol);
  }
  for (const challenger of eligible) {
    if (held.has(challenger.symbol)) continue;
    if (targets.size < MAX_HOLDINGS) {
      targets.add(challenger.symbol);
      continue;
    }
    // Full: replace the weakest *held* target only on a clear ROC edge.
    let weakest: string | null = null;
    let weakestRoc = Infinity;
    for (const t of targets) {
      if (!held.has(t)) continue;
      const r = rocBySymbol.get(t);
      if (r !== undefined && r < weakestRoc) {
        weakestRoc = r;
        weakest = t;
      }
    }
    if (weakest !== null && challenger.roc > weakestRoc + HYSTERESIS) {
      targets.delete(weakest);
      targets.add(challenger.symbol);
    } else {
      break; // Challengers are ROC-sorted, so no later one can replace either.
    }
  }

  const orders: OrderInput[] = [];

  // 5. Sells first: full exit of anything held but no longer targeted.
  const heldSorted = [...held].sort();
  for (const symbol of heldSorted) {
    if (targets.has(symbol)) continue;
    const pos = state.positions.get(symbol);
    if (pos === undefined || pos.qty <= 0n) continue;
    orders.push({ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
  }

  // 6. Buys: each new target, sized from batch-start cash (sells do not fund buys).
  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
  const perTargetCap = state.equity / BigInt(MAX_HOLDINGS);
  let remainingCash = state.cash;
  for (const s of eligible) {
    if (!targets.has(s.symbol) || held.has(s.symbol)) continue;
    let amount = perTargetCap;
    const weightRoom = state.weightRoom(s.symbol);
    if (weightRoom < amount) amount = weightRoom;
    if (remainingCash < amount) amount = remainingCash;
    if (amount < minNotional) continue;
    orders.push({
      side: 'buy',
      symbol: s.symbol,
      notional_quote_units: amount,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    remainingCash -= amount;
  }

  return orders;
}

await runBars({ onBatch });
