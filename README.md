# Assay Score

Copyability ratings for Polymarket wallets. The question is not who made money —
it is whether a follower could have captured what a wallet did. The most
profitable wallet in the graded set made $15.3M and averages over 21,000 fills
per active day; nobody follows that, because by the time the fill is visible the
price that produced it is gone.

Live at **[assayscore.com](https://assayscore.com)** — ratings, per-wallet lookup,
the walk-forward evidence, and a free API. The method is published in full at
[/evidence](https://assayscore.com/evidence), including the wallet universe and
its selection bias.

## What's in here

### Grading

| File | Role |
|---|---|
| `grade-spec.mjs` | Every threshold in one place — flags, penalties, cutoffs, the ROI formulas. **The scorer and the published methodology page both read this**, so a rule cannot change in one and not the other. |
| `wallet-grades.mjs` | Computes grades from settled outcomes. `WINDOW_START`/`WINDOW_END` scope the scoring window; `GRADES_TABLE` writes elsewhere (used for walk-forward runs). |
| `expand-universe.mjs` | Grows the wallet universe from the trade feed and public leaderboards; resumable via the `grade_universe` table. |
| `resolution-backfill.mjs` | Fetches market resolutions — the outcome labels every grade depends on. Shardable with `SHARD=i/n`. |

A wallet needs 50 settled bets to be graded. A grade of **A** requires a score of
20 **and no flags at all**; three of the seven flags carry no point penalty, so
one of them alone caps an otherwise strong wallet at B. That is deliberate — the
flags describe ways a record can be true and still not be followable.

### Copy signals

`copy-signal.mjs` turns A-grade activity into something a person can act on.
Raw flow is not a product: A wallets alone fire over a thousand fills a day.
Three filters plus a size floor reduce that to roughly ten signals:

1. **Episode merge** — BUY fills in the same market within five minutes are one
   decision, not many.
2. **New entry only** — prior net exposure in that market must be near zero.
   Adding to a position is not a new opinion.
3. **Relative size** — the episode must clear that wallet's own p90. "Large" is
   relative to the wallet, not to a dollar figure.
4. **Absolute floor** — `SIGNAL_MIN_USD` (default 1000), because some profitable
   wallets spray flat small bets across dozens of minor markets.

```
node copy-signal.mjs backtest [days]   # replay history, no side effects
node copy-signal.mjs run               # live loop; Telegram if configured
node copy-signal.mjs pollonce          # one poll sweep, then exit
```

The live loop also tops up A-wallet fills from the activity API, because the
collector only watches its own live set. Signals are written to `copy_signals`;
the cursor lives in `copy_signal_state`, so restarts do not replay or skip.

### Site

`build-report.mjs`, `build-lookup.mjs`, `build-evidence.mjs` and `build-api.mjs`
generate the static site from the database — the ratings table, `/check`,
`/evidence`, and the JSON API plus per-wallet badges. `site-nav.mjs` and
`site/head.tmpl.html` are shared. Rebuild and deploy:

```
node build-report.mjs && (cd site && npx wrangler deploy)
```

Pages are regenerated rather than hand-edited so the numbers can never drift
from the database.

### Collector

`index.js` is the frozen worker: it watches the trade feed, records fills into
`smart_alerts`, and resolves settled markets. It is deliberately not extended —
new work goes in separate modules over the same database. The copy-signal engine
starts only when `COPY_SIGNALS_ENABLED=true`, so a deploy alone changes nothing.

## Running it

Needs Node 22 and `DATABASE_URL` (Postgres). Scripts are resumable: re-running
after a timeout continues rather than restarting.

Polymarket blocks some regions, so collection runs from a server or a CI runner
rather than a laptop. `.github/workflows/data-job.yml` dispatches any script on a
clean runner; `expand-universe.yml`, `daily-feed.yml` and `data-freshness.yml`
handle universe growth, the daily settlement digest, and a staleness alarm that
fires if collection stops.

## What the ratings do not claim

The published result is conditional, and the conditions are on the evidence page:
it depends on holding to resolution, on liquidity (only some entries had a
followable price within five minutes), and on the market staying uncrowded — that
last one erodes as copying grows, including from lists like this one. B grade did
not work and F was not a loss. None of it is financial advice.

Read-only throughout: no assets held, no transactions signed, no orders routed.
