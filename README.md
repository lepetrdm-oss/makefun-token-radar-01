# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/lepetrdm-oss/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/lepetrdm-oss/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A radar for protocol token launches. Every pre-token protocol in the sealed snapshot is
priced by a value model **fitted on the tokens that already trade**, blind-tested three
ways, and ranked by **expected launch value** — fitted value × the odds it ever records
a token — with a P10–P90 range and a farm plan netted to a verdict for each row. Built
for [make.fun's Build the best token launch radar bounty](https://make.fun/bounty/token-radar-01).

## The model (radar-3)

Nothing on the page is asserted: every number is fitted or counted from the snapshot
itself (DefiLlama protocol data, fetched 2026-11-14; see the snapshot's own `source`
field). The whole pipeline is `lib/model.ts`, and the dashboard re-derives every board
row from the shipped parameters in the browser — the integrity strip on the board shows
the result.

**Fitted value.** `log(market cap)` is regressed on `log(TVL)`, a signed-log 7-day
growth feature and a centred log-age term, fitted by Huber-IRLS over the traded tokens
with a real price (market cap ≥ $1M) whose cap prices their own protocol — 94 tokens —
then corrected by per-category residual offsets shrunk toward zero. Fitted coefficients:
intercept 10.499, TVL slope 0.340, growth slope +0.229, age slope −0.470.

**Blind-tested three ways** (every test refits the whole pipeline):

| Test | n | Median miss | Shipped-range coverage |
| --- | --- | --- | --- |
| Leave-one-out | 74 | ×2.9 (median \|log err\| 1.05) | 77.0% |
| Older → newer (fit oldest 60%, price newest 40%) | 30 | ×2.3 (0.85) | 83.3% |
| Walk-forward, 4 chronological folds | 55 | ×2.5 (0.91) | 83.6% |

**Ranges.** Each row's P10–P90 band is the pooled blind-miss distribution of all three
tests, split young (<540 days with no token) / seasoned and shrunk toward the pooled
band: 80.5% of blind actuals land inside the band their row would have carried.

**Token odds.** The board is ranked by fitted value × odds, not by value alone. The
odds model is a base rate (54.9% of all 758 protocols record a token) moved by three
likelihood ratios counted from the universe itself: age band (26.1% of under-6-month
protocols record a token vs 79.1% of over-3-year ones), sector, and a growth cell
stratified by age band before pooling. Held out by slug halves, its mean prediction is
0.585 against an actual share of 0.549, with a Brier score of 0.205 against 0.248 for
always predicting the base rate.

**Farm plans, netted.** Each plan assumes a reward pool of 5% of fitted value competed
for by farmer capital of 25% of TVL, sizes a deposit on a $50–$5,000 ladder, and nets
the expected slice (after token odds) against gas + swap fees and forgone yield at
4.5%/yr. The verdict is **FARM** when the best size nets ≥ $250 at ≥ $50 per active
hour, **THIN** when it nets positive below that bar, **SKIP** when no size breaks even;
every row shows its break-even ticket and $/hour. Board spread: 96 FARM, 81 THIN,
20 SKIP.

**The ledger.** All 758 protocols are accounted for exactly once: 197 ranked pre-token
rows (the whole 40-protocol watchlist included), 128 traded at a recorded price, 288
recording a token with no price above zero, 129 wrapped/staked/bridged products, 11
versioned deployments of a ranked protocol, 5 named for a wrapped asset. Traded
protocols are never ranked as pre-token.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json
```

`main.ts` (Node 22, standard library only, no network) reads the sealed snapshot,
writes `out/board.json` and `out/data.js`, copies `dashboard/` and `screenshots/` into
`out/`, and writes `out/dossier.json` with the vendored make.fun library. Two runs
write identical bytes. The dashboard is a static page: open `out/dashboard/index.html`
with `out/data.js` beside it, or serve `out/` with any static server. `data.js` at this
repository's root is the same generated dataset, kept so the dashboard can be previewed
on GitHub Pages.

## The dashboard

- **Board** — all 197 rows with TVL, 7-day growth, age, fitted value, P10–P90 range,
  token odds, expected value and farm verdict; sortable, filterable by chain, category,
  verdict, minimum TVL, watchlist and text; an integrity strip re-derives every row
  from the fitted parameters and reports the match.
- **Detail** (`?view=detail&protocol=<slug>`) — the full working for one protocol:
  every value term, the odds factors with their peer counts, the netted farm table,
  the 7-step plan, and the page's own re-derived numbers for the row.
- **Model & proof** — the fitted coefficients, the three blind tests, the category
  offsets, the odds tables with their held-out calibration, and the farm assumptions.
- **Ledger 758/758** — every protocol in the snapshot with the reason it is ranked,
  traded, unpriced or set aside.
- **Traded anchors** — the fit set sampled across the size range, each token's actual
  price beside the price its own fitted curve gives it.
