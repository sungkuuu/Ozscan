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

// Free tier is delayed on purpose: the live feed is the product, this is the
// receipt. DELAY_H also sets what the page promises, so they cannot drift.
const DELAY_H = 24;

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
  WHERE s.ts < EXTRACT(EPOCH FROM now()) - ${DELAY_H} * 3600
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
<td class="addr">${short(s.address)}</td>
<td class="l">${esc((s.market || s.slug || '').slice(0, 58))}</td>
<td class="l"><strong>${esc(s.outcome)}</strong></td>
<td class="num">${Number(s.avg_price).toFixed(1)}¢</td>
<td class="num">${money(s.size_usd)}</td>
<td class="grade-cell">${verdict}</td>
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
  <h1>One alert when a graded wallet commits.</h1>
  <p class="standfirst">A-grade wallets place over a thousand fills a day between them. Almost none of it is worth acting on. This is the part that is: a wallet that passed the walk-forward, opening a new position, large by its own standard.</p>

  <dl class="specimen">
    <div class="spec"><dt>Signals sent</dt><dd>${tot.n}<small>since ${new Date(Number(tot.first_ts) * 1000).toISOString().slice(0, 10)}</small></dd></div>
    <div class="spec"><dt>Per day</dt><dd>${perDay}<small>not a feed</small></dd></div>
    <div class="spec"><dt>Wallets firing</dt><dd>${tot.wallets}<small>of ${(await pool.query(`SELECT count(*) n FROM wallet_grades WHERE grade='A'`)).rows[0].n} graded A</small></dd></div>
    <div class="spec"><dt>Median size</dt><dd>${money(tot.avg_size)}<small>their money, not ours</small></dd></div>
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
  <h2>The last ${sigs.length} signals</h2>
  <p class="sec-note">Delayed ${DELAY_H} hours, which is why you can read them here for free. W/L is the settled outcome; <span class="flag">open</span> means the market has not resolved yet. Nothing is removed after the fact — this table is the record, wins and losses both.</p>
  ${settled.length ? `<p><strong>${wins} of ${settled.length}</strong> settled signals on this page won. The rest are still open.</p>` : ''}
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
  <h2>Getting it live</h2>
  <p>The delayed table above is the whole product, ${DELAY_H} hours late. Live delivery is a limited number of seats, and the limit is not a sales tactic: the follow price we measured exists because few people are racing for it. Every extra follower on the same wallet narrows that, and we would rather cap it than sell an edge we are diluting. That reasoning, and the measurement behind it, is on the <a href="/evidence/">evidence page</a>.</p>
  <p>If you want a seat, write to <a href="mailto:contact@assayscore.com?subject=Signals%20seat">contact@assayscore.com</a> — tell us what you trade and roughly what size, and we will tell you whether there is room and what it costs. Builders wanting the grades inside their own product should use the <a href="/api/">free API</a> instead; that is not seat-limited.</p>
  <p><strong>What this is not.</strong> Not advice, not managed money, not a guarantee. We hold no assets, sign no transactions and route no orders. Grades come from settled outcomes only, and the conditions the result depends on — hold to resolution, liquidity, an uncrowded market — are published in full rather than buried. Prediction markets are not available everywhere; check what applies where you are.</p>
</section>

<footer>
  <span>Grades and method on the <a href="/">report page</a> · <a href="/evidence/">how it was tested</a> · <a href="/api/">API</a></span>
  <span>Signals delayed ${DELAY_H}h · rebuilt ${new Date().toISOString().slice(0, 10)}</span>
</footer>

</div>
</body>
</html>`;

mkdirSync(`${ROOT}/site/public/signals`, { recursive: true });
writeFileSync(`${ROOT}/site/public/signals/index.html`, head + body);
console.log(`Built site/public/signals/index.html — ${tot.n} signals total, ${sigs.length} shown (${DELAY_H}h delay), ${wins}/${settled.length} settled won`);
await pool.end();
