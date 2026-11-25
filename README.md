# Momentum Rotation Bot

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/cos43/gorun-bot/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/cos43/gorun-bot/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny paper-trading bot for the make.fun competition
[Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1).
It trades hourly Solana bars (FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF)
via the `agent-fun/bars-replay/v1` line protocol.

## Strategy

24-bar momentum rotation, at most 4 holdings:

- Each symbol keeps its close history and a 24-bar EMA, seeded with the mean
  of its first 24 closes and updated with `EMA += 2/25 * (close - EMA)`.
- Momentum: `ROC24 = close / close 24 bars ago - 1`.
- A symbol is eligible only when `ROC24 > 0.005` and `close > EMA24`.
- Eligible symbols are ranked by ROC24; the target set holds at most 4.
- Hysteresis: symbols already held keep their slot. An unheld challenger fills
  a free slot directly, or — when full — replaces the weakest held target only
  when its ROC24 exceeds that target's ROC24 by 0.04.
- Held symbols outside the target set are sold in full (sells first).
- Each new target is bought for `min(equity/4, 25% weight room, cash left)`,
  never below the 1 USDC minimum notional. Cash is counted from the start of
  the batch, so same-reply sell proceeds never fund a buy.
- No orders during warm-up; only history is accumulated.
- Fully deterministic: float64 arithmetic only, no clock, no randomness,
  no environment, no network.

## Run

Grade locally with the competition kit (Node 22.18+):

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver docker
```

Or run the bot directly against a replay harness speaking
`agent-fun/bars-replay/v1` on stdin/stdout:

```sh
node main.ts
```

`main.ts` is the entrypoint; `vendor/makefun-bars.ts` is the kit's protocol
shim, vendored unchanged.
