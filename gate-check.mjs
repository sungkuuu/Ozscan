// Gate A — the pre-registered decision on whether the copy-signal product lives.
//
// Written before the sample was complete, and deliberately mechanical: the point
// of pre-registering is that nobody gets to choose the rule once the numbers are
// visible. Run it, read the verdict, act on it.
//
// THE RULE (owner-approved 2026-09-10, amended 2026-09-14 — frozen, do not edit
// the constants below to make a verdict come out differently):
//
//   Sample   signals detected live (ts >= 2026-09-04T00:00Z), that the executor
//            recorded as fillable in copy_signal_dryrun ("would buy"), whose
//            market has since settled with a winning outcome. One per event —
//            four signals on one match are one outcome, not four.
//   Entry    the executor's recorded best ask, plus 2c. The 2c is the FAK
//            maxPrice band: a real order can fill that much worse than the quote
//            it was placed against. Read, never the wallet's own fill price.
//   Fee      Polymarket taker fee, sports rate. Charged on top of the stake, so
//            the effective price per share is p * (1 + rate * (1 - p)).
//   Pass     n >= 30 AND the 95% bootstrap lower bound on equal-stake return > 0.
//
// Amendment note (2026-09-14): the original wording said "actual fill price",
// which only exists once real money is placed. The executor's recorded ask is
// the closest obtainable substitute and is biased optimistic — it ignores book
// depth and the latency between quote and order. The 2c band and the fee are
// added to push it back past neutral, so a pass here should survive real fills.
// The correction can only make passing harder, which is why it was allowed.

import pg from 'pg';
import { readFileSync } from 'fs';

const GO_LIVE = 1788480000;   // 2026-09-04T00:00Z
const MIN_N = 30;
const SLIPPAGE_CENTS = 2;
const FEE_RATE = 0.05;        // sports taker; crypto markets are 0.07, reported as a sensitivity
const BOOTSTRAP = 20000;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    || readFileSync(`${process.env.HOME}/OzScan/backups/.db_url`, 'utf8').trim(),
  ssl: { rejectUnauthorized: false },
  options: '-c timezone=UTC -c statement_timeout=60000',
});

const { rows } = await pool.query(`
  SELECT DISTINCT ON (ev) * FROM (
    SELECT cs.id, cs.ts, cs.market, cs.outcome, cs.avg_price::float AS wallet_px,
           d.best_ask::float AS ask,
           lower(regexp_replace(cs.outcome,'[^a-z0-9]','','gi'))
             = lower(regexp_replace(r.winning_outcome,'[^a-z0-9]','','gi')) AS won,
           COALESCE((SELECT a.event_slug FROM smart_alerts a
                     WHERE a.condition_id = cs.condition_id AND a.event_slug IS NOT NULL LIMIT 1),
                    cs.condition_id) AS ev
    FROM copy_signals cs
    JOIN copy_signal_dryrun d ON d.signal_id = cs.id AND d.note LIKE 'would buy%'
    JOIN market_resolutions r ON r.condition_id = cs.condition_id
    WHERE cs.ts >= $1 AND r.closed AND r.winning_outcome IS NOT NULL
      AND d.best_ask IS NOT NULL) t
  ORDER BY ev, ts`, [GO_LIVE]);

const ret = (askDollars, won, feeRate) => {
  const p = Math.min(0.99, askDollars + SLIPPAGE_CENTS / 100);
  const eff = p * (1 + feeRate * (1 - p));   // fee is paid on top of the stake
  return won ? (1 - eff) / eff : -1;
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

const returns = rows.map((r) => ret(r.ask, r.won, FEE_RATE));
const n = returns.length;

console.log(`GATE A — ${new Date().toISOString().slice(0, 16)}Z`);
console.log(`sample: ${n} settled, fillable, event-deduplicated live signals (need ${MIN_N})`);

if (!n) { console.log('\nno scoreable signals yet.'); await pool.end(); process.exit(0); }

for (const r of rows) {
  const p = Math.min(0.99, r.ask + SLIPPAGE_CENTS / 100);
  console.log(`  #${String(r.id).padEnd(4)} ${new Date(Number(r.ts) * 1000).toISOString().slice(5, 10)} ${r.won ? 'W' : 'L'} ` +
    `${String(r.market).slice(0, 38).padEnd(38)} wallet ${String(r.wallet_px).padStart(5)}c  ask ${(r.ask * 100).toFixed(1).padStart(5)}c  entry ${(p * 100).toFixed(1).padStart(5)}c`);
}

const obs = mean(returns);
const bs = [];
for (let i = 0; i < BOOTSTRAP; i++) {
  let s = 0;
  for (let j = 0; j < n; j++) s += returns[Math.floor(Math.random() * n)];
  bs.push(s / n);
}
bs.sort((a, b) => a - b);
const lo = bs[Math.floor(BOOTSTRAP * 0.025)], hi = bs[Math.floor(BOOTSTRAP * 0.975)];

console.log(`\nwins            ${rows.filter((r) => r.won).length}/${n}`);
console.log(`equal-stake ROI ${(100 * obs).toFixed(1)}%`);
console.log(`95% CI          [${(100 * lo).toFixed(1)}%, ${(100 * hi).toFixed(1)}%]`);

// Not part of the rule. Crypto markets carry a 0.07 taker rate; if the verdict
// flips between the two, the sample is too thin to be leaning on either.
const hi7 = mean(rows.map((r) => ret(r.ask, r.won, 0.07)));
console.log(`(sensitivity: at the 7% crypto fee rate, ROI would be ${(100 * hi7).toFixed(1)}%)`);

const enough = n >= MIN_N, positive = lo > 0;
console.log(`\n  n >= ${MIN_N}          ${enough ? 'YES' : `NO (${MIN_N - n} more needed)`}`);
console.log(`  CI lower > 0     ${positive ? 'YES' : 'NO'}`);
console.log(`\nVERDICT: ${enough && positive ? 'PASS' : enough ? 'FAIL — close the copy-signal track' : 'UNDECIDED — keep collecting'}`);

await pool.end();
