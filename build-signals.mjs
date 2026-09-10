// Build the /signals page — the product surface.
//
// The rest of the site is a report: it tells you what we measured. This page
// is the thing a visitor can act on. It answers, in order: what arrives, what
// you do with it, what it costs you to be late, and how to get it live.
//
//   node build-signals.mjs && (cd site && npx wrangler deploy)

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { nav } from './site-nav.mjs';
import { Pool } from 'pg';

const DB_URL = process.env.DATABASE_URL
  || readFileSync(`${process.env.HOME}/OzScan/backups/.db_url`, 'utf8').trim();
const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
const ROOT = process.env.REPO_DIR || `${process.env.HOME}/OzScan/Ozscan`;

// No delay and no gate. Capping access at zero users was backwards — the
// crowding problem the evidence page describes is real at hundreds of
// followers, not at none. Until there is demand to ration, the page is the
// product: live, free, nothing to sign.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const money = (v) => `$${Math.round(Number(v)).toLocaleString()}`;

const { rows: sigs } = await pool.query(`
  SELECT s.ts, s.address, s.outcome, s.market, s.slug, s.avg_price, s.size_usd,
         g.grade, g.score,
         r.winning_outcome, r.closed
  FROM copy_signals s
  LEFT JOIN wallet_grades g ON g.address = s.address
  LEFT JOIN market_resolutions r ON r.condition_id = s.condition_id
  ORDER BY s.ts DESC
  LIMIT 40`);

const { rows: [tot] } = await pool.query(`
  SELECT count(*) n,
         count(DISTINCT address) wallets,
         ROUND(AVG(size_usd)) avg_size,
         MIN(ts) first_ts
  FROM copy_signals`);

// Settled-only scoreboard. Silence is not a win: only resolved markets count.
const settled = sigs.filter((s) => s.closed && s.winning_outcome);
const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const wins = settled.filter((s) => norm(s.outcome) === norm(s.winning_outcome)).length;

// Scoreboard, split in two. Everything before go-live (2026-09-04) was
// backfilled: the engine replayed history with the A list as it stood that
// day, so wallets that earned their A during August had their August trades
// scored — selection with hindsight. The clean cut keeps only wallets that
// were already A on grades computed from bets through 8/4, and counts one
// bet per event (four signals on one match are one outcome, not four).
// Signals detected live carry none of that, and they are the only rows that
// deserve the word "record". They get their own column, however small.
//
// Returns are at the price one minute after the signal (follow-price.mjs),
// because the wallet's own fill price is not one a reader can get. Win rate
// alone is the trap this product argues against — a 90% hit rate at 90¢
// loses money — so the return sits beside it, on equal stakes.
const GO_LIVE = 1788480000; // 2026-09-04T00:00Z
const { rows: [{ has_asof }] } = await pool.query(
  `SELECT to_regclass('wallet_grades_asof_aug') IS NOT NULL AS has_asof`);
const cohortSql = (where) => `
  WITH s AS (
    SELECT cs.id, cs.ts, cs.avg_price, f.px_60,
           lower(regexp_replace(cs.outcome,'[^a-z0-9]','','gi'))
             = lower(regexp_replace(r.winning_outcome,'[^a-z0-9]','','gi')) AS won,
           COALESCE((SELECT a.event_slug FROM smart_alerts a
                     WHERE a.condition_id = cs.condition_id AND a.event_slug IS NOT NULL LIMIT 1),
                    cs.condition_id) AS ev
    FROM copy_signals cs
    JOIN market_resolutions r ON r.condition_id = cs.condition_id
    LEFT JOIN copy_signal_followprice f ON f.signal_id = cs.id
    WHERE r.closed AND r.winning_outcome IS NOT NULL AND ${where}),
  d AS (SELECT DISTINCT ON (ev) * FROM s ORDER BY ev, ts)   -- one bet per event
  SELECT count(*) AS settled, count(*) FILTER (WHERE won) AS won,
         ROUND(AVG(px_60), 1) AS avg_entry, count(px_60) AS priced,
         ROUND(100.0 * AVG(CASE WHEN won THEN (100 - px_60) / px_60 ELSE -1 END)
               FILTER (WHERE px_60 IS NOT NULL), 1) AS roi
  FROM d`;
const { rows: [back] } = await pool.query(cohortSql(
  has_asof
    ? `cs.ts < ${GO_LIVE} AND EXISTS (SELECT 1 FROM wallet_grades_asof_aug g WHERE g.address = cs.address AND g.grade = 'A')`
    : `cs.ts < ${GO_LIVE}`));
const { rows: [live] } = await pool.query(cohortSql(`cs.ts >= ${GO_LIVE}`));
const { rows: [backAll] } = await pool.query(`
  SELECT count(*) AS n FROM copy_signals cs JOIN market_resolutions r ON r.condition_id = cs.condition_id
  WHERE r.closed AND r.winning_outcome IS NOT NULL AND cs.ts < ${GO_LIVE}`);
const pct = (v) => (v == null ? '—' : `${Number(v) >= 0 ? '+' : ''}${v}%`);
const sign = (v) => (v == null ? '' : Number(v) > 0 ? 'pos' : 'neg');

const days = tot.first_ts ? Math.max(1, Math.round((Date.now() / 1000 - Number(tot.first_ts)) / 86400)) : 1;
const perDay = (Number(tot.n) / days).toFixed(1);

const rows = sigs.map((s) => {
  const won = s.closed && s.winning_outcome ? norm(s.outcome) === norm(s.winning_outcome) : null;
  const verdict = won === null
    ? '<span class="flag">open</span>'
    : won ? '<span class="stamp g-a">W</span>' : '<span class="stamp g-f">L</span>';
  return `<tr>
<td class="num idx">${new Date(Number(s.ts) * 1000).toISOString().slice(5, 16).replace('T', ' ')}</td>
<td class="grade-cell">${s.grade ? `<span class="stamp g-${s.grade.toLowerCase()}">${s.grade}</span>` : '—'}</td>
<td class="addr"><a href="/check/?a=${s.address}" title="${s.address}">${short(s.address)}</a></td>
<td class="l">${s.slug ? `<a href="https://polymarket.com/market/${esc(s.slug)}" rel="nofollow noopener" target="_blank">${esc((s.market || s.slug).slice(0, 58))}</a>` : esc((s.market || '').slice(0, 58))}</td>
<td class="l"><strong>${esc(s.outcome)}</strong></td>
<td class="num">${Number(s.avg_price).toFixed(1)}¢</td>
<td class="num">${money(s.size_usd)}</td>
<td class="grade-cell">${verdict}${Number(s.ts) < GO_LIVE ? ' <span class="flag" title="replayed from history before the engine went live on 2026-09-04">backfill</span>' : ''}</td>
</tr>`;
}).join('\n');

const head = readFileSync(`${ROOT}/site/head.tmpl.html`, 'utf8')
  .replace('<title>Polymarket Copyability Ratings</title>', '<title>Signals — Assay Score</title>');

const body = `
<body>
<div class="wrap">

${nav('/signals/')}

<header class="masthead">
  <div class="crest">
    <img src="/mark.png" srcset="/mark.png 1x, /mark@2x.png 2x" width="52" height="52" alt="">
    <div class="eyebrow">Assay Score · Signals</div>
  </div>
  <h1>Follow the wallets that passed the test.</h1>
  <p class="standfirst">Of the wallets we graded A on data through June 30, <strong>23 of 27 were profitable</strong> over the two months that followed — a period the grading never saw. Every other grade landed near a coin flip. This page shows what those wallets are doing right now, free and without an account.</p>

  <dl class="specimen">
    <div class="spec"><dt>Signals sent</dt><dd>${tot.n}<small>since ${new Date(Number(tot.first_ts) * 1000).toISOString().slice(0, 10)}</small></dd></div>
    <div class="spec"><dt>Per day</dt><dd>${perDay}<small>not a feed</small></dd></div>
    <div class="spec"><dt>Wallets firing</dt><dd>${tot.wallets}<small>of ${(await pool.query(`SELECT count(*) n FROM wallet_grades WHERE grade='A'`)).rows[0].n} graded A</small></dd></div>
    <div class="spec"><dt>Backfill, clean</dt><dd>${back.won}/${back.settled}<small>won · ${pct(back.roi)} at +1 min</small></dd></div>
    <div class="spec"><dt>Live record</dt><dd class="${sign(live.roi)}">${Number(live.settled) ? `${live.won}/${live.settled}` : '0/0'}<small>${Number(live.priced) ? `won · ${pct(live.roi)} at +1 min` : 'settled so far'}</small></dd></div>
  </dl>
</header>

<section>
  <h2>What you do with one</h2>
  <div class="method">
    <div><h4>1 · It arrives</h4><p>Wallet, market, side, the price it filled at, and how big the position is relative to that wallet's own history. Nothing else — no score to interpret, no chart to read.</p></div>
    <div><h4>2 · You decide</h4><p>Open the market and take the same side, or don't. We route no orders and hold no funds; you trade on Polymarket yourself. A signal is not a recommendation.</p></div>
    <div><h4>3 · You hold to resolution</h4><p>This matters more than speed. The edge we measured only survives if you hold until the market settles. Selling an hour later erased it in testing.</p></div>
  </div>
</section>

<section>
  <h2>Live signals</h2>
  <p class="sec-note">Every signal as it fired, newest first — no delay, no account. The wallet links to its full grade; the market links to Polymarket. <strong>W/L is the settled outcome</strong> and <span class="flag">open</span> means the market has not resolved. Nothing is removed after the fact: losses stay on this page, which is the point of publishing it at all.</p>
  <p><strong>Two columns, kept apart on purpose.</strong> The engine went live on 4 September. Everything before that date was <em>backfilled</em>: history replayed against the A list as it stood, which means wallets that earned their A in August had their August trades scored — selection with the benefit of hindsight. The clean cut above keeps only wallets that were already A on grades computed from bets through 4 August, and counts one bet per event, since four signals on one match are one outcome. That leaves <strong>${back.won} of ${back.settled}</strong> (of ${backAll.n} backfilled settlements in total), returning <strong>${pct(back.roi)}</strong> on equal stakes at the price a minute after the signal. Its 95% interval reaches below zero. It is evidence of direction, not proof.</p>
  <p>The <strong>live record</strong> is the only column that earns the word: signals detected as they happened, no replay, no hindsight. It reads <strong>${Number(live.settled) ? `${live.won} of ${live.settled}` : 'nothing settled yet'}</strong>${Number(live.priced) ? `, ${pct(live.roi)} at +1 min` : ''}. At the current rate it needs a few weeks to say anything on its own, and this page will show whatever it says.</p>
  <p>Both returns are measured at the last traded price one minute after the signal, not the offer you would have to lift, so a real fill is worse. And the edge is in holding: buying a minute after the signal and selling fifteen minutes later returned about nothing; only positions carried to resolution — a median of about a week — showed the return.</p>
  <div class="tablewrap">
    <table>
      <thead><tr>
        <th>Time (UTC)</th><th class="l">Grade</th><th class="l">Wallet</th><th class="l">Market</th>
        <th class="l">Side</th><th>Entry</th><th>Size</th><th class="l">Result</th>
      </tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
</section>

<section class="prose">
  <h2>Getting it as it happens</h2>
  <p>Refreshing a page is a poor way to catch a signal, so the same feed is available two other ways, both free:</p>
  <div class="method">
    <div><h4>Telegram</h4><p>Signals pushed the moment they fire, in the format below. Ask at <a href="mailto:contact@assayscore.com?subject=Signals%20on%20Telegram">contact@assayscore.com</a> and we will send the channel link.</p></div>
    <div><h4>JSON</h4><p><code>GET /api/v0/signals.json</code> — the same rows this page renders, for anyone wiring their own alerting. No key, no rate card, CORS open.</p></div>
    <div><h4>Grades API</h4><p>Building your own tool? <a href="/api/">The grade API</a> gives you every wallet's rating directly, which is usually what you actually want.</p></div>
  </div>
  <h3 class="sub">What one looks like</h3>
  <pre class="sample">🟢 A-grade entry — 0xb7ab…a2d1
US Open, Qualification ATP: Raul Brancaccio vs Thiago Seyboth Wild
Thiago Seyboth Wild @ 57.1¢ · $9,193 (wallet p90 $5,100)
polymarket.com/market/us-open-qualification-atp-...
Grade basis: assayscore.com/evidence — settled outcomes, not advice.</pre>
  <p><strong>What this is not.</strong> Not advice, not managed money, not a guarantee. We hold no assets, sign no transactions and route no orders. Grades come from settled outcomes only, and the conditions the result depends on — hold to resolution, liquidity, an uncrowded market — are published in full rather than buried. Prediction markets are not available everywhere; check what applies where you are.</p>
</section>

<footer>
  <span>Grades and method on the <a href="/">report page</a> · <a href="/evidence/">how it was tested</a> · <a href="/api/">API</a></span>
  <span>Live · rebuilt ${new Date().toISOString().slice(0, 10)}</span>
</footer>

</div>
</body>
</html>`;

mkdirSync(`${ROOT}/site/public/signals`, { recursive: true });
mkdirSync(`${ROOT}/site/public/api/v0`, { recursive: true });
writeFileSync(`${ROOT}/site/public/api/v0/signals.json`, JSON.stringify({
  generated_at: new Date().toISOString(),
  note: 'A-grade wallet entries that cleared the copy-signal filters. Rows with backfilled=true were replayed from history before go-live (2026-09-04) and were not detected live. Not advice.',
  method: 'https://assayscore.com/evidence',
  count: sigs.length,
  signals: sigs.map((s) => ({
    ts: Number(s.ts), time: new Date(Number(s.ts) * 1000).toISOString(),
    wallet: s.address, grade: s.grade, market: s.market, slug: s.slug,
    side: s.outcome, entry_cents: Number(s.avg_price), size_usd: Number(s.size_usd),
    backfilled: Number(s.ts) < GO_LIVE,
    settled: Boolean(s.closed && s.winning_outcome),
    won: s.closed && s.winning_outcome ? norm(s.outcome) === norm(s.winning_outcome) : null,
  })),
}, null, 2));
writeFileSync(`${ROOT}/site/public/signals/index.html`, head + body);
console.log(`Built site/public/signals/index.html — ${tot.n} signals, backfill clean ${back.won}/${back.settled} ${pct(back.roi)}, live ${live.won}/${live.settled} ${pct(live.roi)}`);
await pool.end();
