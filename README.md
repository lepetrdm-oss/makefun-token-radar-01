# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/lepetrdm-oss/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/lepetrdm-oss/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A radar for protocol token launches: every pre-token protocol DefiLlama tracks, ranked by
a comps-calibrated implied value, with a farm plan for each one. Built for
[make.fun's Build the best token launch radar bounty](https://make.fun/bounty/token-radar-01).

## The model (radar-2)

Implied value is what a protocol's token would be worth if it traded like the tokens
that already trade in its own category:

```
implied = TVL x comps_multiple x growth x maturity x early x breadth
```

- **comps_multiple**: the category's median market-cap-per-TVL among live-token protocols,
  shrunk toward the global median (x0.21) when the category has few live comps, clamped to
  x0.05–x1.50. No protocol name is ever special-cased.
- **growth**: 1 + clamp(7-day TVL change, −50%, +100%) / 100 × 0.6.
- **maturity**: 0.70 + min(age with no token, 1095 days) / 1095 × 0.30.
- **early**: ×1.15 when a protocol is under a year old and growing over 10%.
- **breadth**: +3% per extra chain, up to 5.

The board covers the whole 40-protocol watchlist plus the strongest early pre-token
protocols below the floor (300 rows). Live-token protocols are set aside at market value
and never ranked. Every row carries a 7-step farm plan derived from its own record —
category, chain, TVL and age — with what each step costs and how long it takes.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json
```

`main.ts` (Node 22, standard library only) reads the sealed snapshot, writes
`out/board.json` and `out/data.js`, copies `dashboard/` and `screenshots/` into `out/`,
and writes `out/dossier.json` with the vendored make.fun library. The dashboard is a
static page with no network: open `out/dashboard/index.html` with `out/data.js` beside
it, or serve `out/` with any static server. `data.js` at this repository's root is the
same generated dataset, kept so the dashboard can be previewed on GitHub Pages.

## The dashboard

- The ranked board, sortable by implied value, TVL, 7-day growth, age or name.
- Filters: text search, chain, category, watchlist-only, minimum implied value.
- A detail view for every protocol (`?view=detail&protocol=<slug>`), showing the
  model's multipliers and the farm plan; a filtered view (`?view=filtered&chain=<chain>`).
- A live-token view, and a model panel showing the comps table the ranking used.
