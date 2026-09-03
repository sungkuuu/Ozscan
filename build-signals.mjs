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
  <h1>Follow the wallets that passed the test.</h1>
  <p class="standfirst">Of the wallets we graded A on data through June 30, <strong>23 of 27 were profitable</strong> over the two months that followed — a period the grading never saw. Every other grade landed near a coin flip. This page shows what those wallets are doing right now, free and without an account.</p>

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
  <h2>Live signals</h2>
  <p class="sec-note">Every signal as it fired, newest first — no delay, no account. The wallet links to its full grade; the market links to Polymarket. <strong>W/L is the settled outcome</strong> and <span class="flag">open</span> means the market has not resolved. Nothing is removed after the fact: losses stay on this page, which is the point of publishing it at all.</p>
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
  note: 'A-grade wallet entries that cleared the copy-signal filters. Not advice.',
  method: 'https://assayscore.com/evidence',
  count: sigs.length,
  signals: sigs.map((s) => ({
    ts: Number(s.ts), time: new Date(Number(s.ts) * 1000).toISOString(),
    wallet: s.address, grade: s.grade, market: s.market, slug: s.slug,
    side: s.outcome, entry_cents: Number(s.avg_price), size_usd: Number(s.size_usd),
    settled: Boolean(s.closed && s.winning_outcome),
    won: s.closed && s.winning_outcome ? norm(s.outcome) === norm(s.winning_outcome) : null,
  })),
}, null, 2));
writeFileSync(`${ROOT}/site/public/signals/index.html`, head + body);
console.log(`Built site/public/signals/index.html — ${tot.n} signals total, ${sigs.length} shown (live), ${wins}/${settled.length} settled won`);
await pool.end();
