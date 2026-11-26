# Pump.fun Sharpe Sprint — Clean-Surge Paper Bot — "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" (make.fun)

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/loneboy1/pump-fun-sharpe-sprint-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/loneboy1/pump-fun-sharpe-sprint-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A deterministic paper-trading bot for the pump.fun bonding-curve replay
(`pumpfun-replay/v2`). Paper trading only — no keys, no exchange access, no
live trading of any kind. Node 22, zero dependencies, no network, no clock,
no randomness: every decision derives from the replay stream, so two
executions agree byte for byte.

## Strategy: clean surge, wide exit

Every rule that chases a move already in progress loses to the 2-slot fill
latency on this replay — the crossing trade is the spike, and a fill 2 slots
later buys its top. So this bot only buys a surge that has already confirmed,
and only while it is still young and cheap:

- **Entry:** in a coin's first 5 slots, only when at least 6 distinct
  non-creator wallets have bought, net buy flow is at least 0.02 SOL, the
  price has run 10–50% off its create price, the creator has put in at most
  2 SOL and has not sold, and real SOL is 0.5–30. One buy per coin, 0.05 SOL
  (at most 1% of real reserves, at least 0.01 SOL so every round trip clears
  the guardrail's 0.01 SOL bar).
- **Exit:** +80% take-profit, −25% stop, 500 slots maximum, or the moment the
  creator sells. A tight buy slippage (500 bps) refuses spike tops for free —
  a rejected buy costs nothing — and a rejected exit sell retries next batch
  instead of orphaning the position. Exit decisions compare the position's
  sell value against its full round-trip cost (curve cost plus both tx fees).
- **No trailing stop:** the grid showed every trailing variant cuts the
  runners short and lowers both net and Sharpe. No adds, no probes, no
  averaging down.

## Measured on the full dev window

Backtested on the kit's FULL 24h dev dataset (all 3 parts, not the kit
pilot sim's part-00000 only) with a local simulator implementing the
replay's market model (2-slot fills, persistent self-impact, curve fees
from the landing trade, 105000-lamport tx fees, seeded 2% tx failure,
closes on complete and at end of data):

**net +0.3291 SOL over 74 round trips on 74 distinct mints (28 wins,
37.8% win rate), per-trip Sharpe +0.200, hourly Sharpe ≈ +0.279,
max drawdown 1.16%, 148 fills, 1 failed tx, 9 slippage rejections.**
Window halves −0.000 / +0.329 SOL: the first half breaks even and the
second half carries the profit, and the single best coin contributes
+0.114 SOL of the net — so these numbers are calibration, not a promise.
The final window is a different 6h, and the ranking metric there is the
house scorer's hourly Sharpe.

Grid search behind the defaults (all on the full dev set): the fast-exit
sniper from the Replay Sprint precedent nets −0.50 SOL here; tightening
entry to 6 buyers / 5 slots / +10–50% run-up and widening the exit to
+80%/−25%/500 slots moves it to +0.33 SOL. A 0.10 SOL stake adds almost
nothing (net +0.346, Sharpe +0.201) for more concentration, so the bot
keeps 0.05 SOL.

## Run it

The grader runs `node /bot/main.ts` with the replay on stdin and expects
one reply per batch on stdout. Locally, the kit grades it with:

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot <repo> --bundle <transcripts.tar.gz>
```

## Files

- `main.ts` — the entrypoint (wires the strategy to the replay)
- `strategy.ts` — the bot (launch books, surge entries, wide exits)
- `vendor/makefun-bot.ts` — the kit's replay shim, vendored byte for byte
- `package.json` — metadata, no dependencies
- `README.md` — this file
- `LICENSE` — MIT

---

<sub>Entered on [make.fun](https://make.fun/?ref=ramtieragent&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
