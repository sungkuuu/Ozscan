// Regenerate the public ratings page from the database.
// The first version of this page was assembled by hand, so the numbers could
// not be refreshed as outcome labels landed. This rebuilds it from
// wallet_grades every time: node build-report.mjs && (cd site && npx wrangler deploy)

import { readFileSync, writeFileSync } from 'fs';
import { Pool } from 'pg';

const DB_URL = process.env.DATABASE_URL
  || readFileSync(`${process.env.HOME}/OzScan/backups/.db_url`, 'utf8').trim();
const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
const ROOT = process.env.REPO_DIR || `${process.env.HOME}/OzScan/Ozscan`;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (a) => `${a.slice(0, 10)}…${a.slice(-4)}`;
const money = (v) => {
  const n = Number(v), s = n < 0 ? '-' : '', x = Math.abs(n);
  if (x >= 1e6) return `${s}$${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `${s}$${(x / 1e3).toFixed(0)}K`;
  return `${s}$${x.toFixed(0)}`;
};
const FLAG = { 'bot-pace': 'bot pace', 'weighting-flip': 'weighting flip', 'single-bet-driven': 'single-bet driven',
  'negative-clv': 'negative CLV', 'favorite-heavy': 'favorite heavy', 'thin-sample': 'thin sample' };

const { rows: g } = await pool.query(`SELECT * FROM wallet_grades ORDER BY score DESC`);
if (g.length === 0) { console.error('wallet_grades is empty — run wallet-grades.mjs first'); process.exit(1); }

const { rows: [m] } = await pool.query(`
  SELECT (SELECT count(*) FROM wallet_grades) AS wallets,
         (SELECT SUM(resolved_bets) FROM wallet_grades) AS bets,
         (SELECT SUM(staked_usd) FROM wallet_grades) AS staked,
         (SELECT SUM(pnl_usd) FROM wallet_grades) AS pnl,
         (SELECT count(*) FROM market_resolutions WHERE closed IS TRUE AND winning_outcome IS NOT NULL) AS labelled,
         (SELECT count(DISTINCT condition_id) FROM smart_alerts WHERE condition_id ~ '^0x[0-9a-fA-F]{64}$') AS universe,
         (SELECT count(*) FROM clv_pilot_episodes WHERE kind = 'signal') AS episodes`);

const { rows: [clv] } = await pool.query(`
  SELECT ROUND(AVG(mk_1h) FILTER (WHERE split = 'validate') * 100, 2) AS validate_1h
  FROM clv_pilot_episodes WHERE kind = 'signal' AND mk_1h IS NOT NULL`);

const top = g[0];
const dist = ['A', 'B', 'C', 'D', 'F'].map((k) => [k, g.filter((w) => w.grade === k).length]).filter(([, n]) => n > 0);
const cov = Math.round((Number(m.labelled) / Number(m.universe)) * 100);
const today = new Date().toISOString().slice(0, 10);
const botMost = [...g].sort((a, b) => Number(b.pnl_usd) - Number(a.pnl_usd))[0];

// At ~1,000 graded wallets a full table stops being readable; the grade
// distribution carries the aggregate story and the table shows the top of it.
const TABLE_CAP = 50;
const shown = g.slice(0, TABLE_CAP);

const rows = shown.map((w, i) => {
  const clvTxt = w.clv_1h_cents === null ? '—' : `${Number(w.clv_1h_cents) >= 0 ? '+' : ''}${Number(w.clv_1h_cents).toFixed(2)}¢`;
  const clvCls = w.clv_1h_cents === null ? '' : (Number(w.clv_1h_cents) < 0 ? ' neg' : ' pos');
  const flags = (w.flags && w.flags.length)
    ? w.flags.map((f) => `<span class="flag">${esc(FLAG[f] || f)}</span>`).join('')
    : '<span class="flag none">none</span>';
  return `<tr>
<td class="num idx">${String(i + 1).padStart(2, '0')}</td>
<td class="grade-cell"><span class="stamp g-${w.grade.toLowerCase()}">${w.grade}</span></td>
<td class="addr" title="${esc(w.address)}">${short(w.address)}</td>
<td class="num">${Number(w.resolved_bets).toLocaleString()}</td>
<td class="num">${Number(w.win_pct).toFixed(1)}%</td>
<td class="num ${Number(w.roi_staked_pct) > 0 ? 'pos' : 'neg'}">${Number(w.roi_staked_pct) >= 0 ? '+' : ''}${Number(w.roi_staked_pct).toFixed(1)}%</td>
<td class="num ${Number(w.roi_equal_pct) > 0 ? 'pos' : 'neg'}">${Number(w.roi_equal_pct) >= 0 ? '+' : ''}${Number(w.roi_equal_pct).toFixed(1)}%</td>
<td class="num ${Number(w.pnl_usd) > 0 ? 'pos' : 'neg'}">${money(w.pnl_usd)}</td>
<td class="num">${Number(w.bets_per_active_day).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
<td class="num${clvCls}">${clvTxt}</td>
<td class="flags">${flags}</td>
</tr>`;
}).join('\n');

const head = readFileSync(`${ROOT}/site/head.tmpl.html`, 'utf8');
const body = `
<body>
<div class="wrap">

<header class="masthead">
  <div class="eyebrow">Report 001 · Data through ${today}</div>
  <h1>Polymarket Copyability Ratings</h1>
  <p class="standfirst">${m.wallets} tracked wallets, graded on one question: could a follower have captured what this wallet did? Profit alone does not answer it.</p>

  <dl class="specimen">
    <div class="spec"><dt>Wallets graded</dt><dd>${m.wallets}<small>≥50 settled bets</small></dd></div>
    <div class="spec"><dt>Settled bets</dt><dd>${Number(m.bets).toLocaleString()}<small>BUY, 5–95¢</small></dd></div>
    <div class="spec"><dt>Capital staked</dt><dd>${money(m.staked)}<small>net P&amp;L ${money(m.pnl)}</small></dd></div>
    <div class="spec"><dt>Markets resolved</dt><dd>${Number(m.labelled).toLocaleString()}<small>${cov}% of universe</small></dd></div>
    <div class="spec"><dt>Copy episodes</dt><dd>${Number(m.episodes).toLocaleString()}<small>priced at detection</small></dd></div>
  </dl>
</header>

<section>
  <h2>Grade distribution</h2>
  <p class="sec-note">Grades run A (followable and profitable) to F (not followable, whatever the profit).</p>
  <div class="dist">
${dist.map(([k, n]) => `    <span class="d-${k.toLowerCase()}" style="flex:${n} 1 0%">${k} ${n}</span>`).join('\n')}
  </div>
  <div class="dist-key">
    <span>A · clean on every check</span><span>B · minor flag</span><span>C · marginal, no demonstrated edge</span><span>D · profitable but compromised</span><span>F · not copyable</span>
  </div>
</section>

<section>
  <h2>The finding</h2>
  <div class="callout">
    <div class="eyebrow">Headline result</div>
    <h3>The most profitable wallet on this list earns ${'AEF'.includes(botMost.grade) ? 'an' : 'a'} ${botMost.grade}.</h3>
    <p>Wallet <code>${short(botMost.address)}</code> made <strong>${money(botMost.pnl_usd)}</strong> across ${Number(botMost.resolved_bets).toLocaleString()} settled bets — and averages <strong>${Number(botMost.bets_per_active_day).toLocaleString(undefined, { maximumFractionDigits: 0 })} fills per active day</strong>. No human follows that, and by the time a follower sees the fill, the price that produced the edge is gone.</p>
    <p>Across all ${Number(m.episodes).toLocaleString()} copy episodes measured at detection price, the one-hour markout was <strong>${clv.validate_1h}¢ in the held-out validation window</strong> — statistically indistinguishable from buying the same markets at random times. Profit is concentrated in wallets whose edge is execution speed, and execution speed does not transfer to a follower.</p>
  </div>
</section>

<section>
  <h2>Ratings${g.length > TABLE_CAP ? ` — top ${TABLE_CAP} of ${g.length}` : ''}</h2>
  <p class="sec-note">${g.length > TABLE_CAP ? `The ${TABLE_CAP} highest-scoring wallets of ${g.length} graded; the distribution above covers the rest. ` : ''}Sorted by score. ROI is shown two ways on purpose: staked-weighted and equal-weighted. When the two disagree in sign, the record is carried by a handful of large bets rather than a repeatable process.</p>
  <div class="tablewrap">
    <table>
      <thead><tr>
        <th class="l">#</th><th class="l">Grade</th><th class="l">Wallet</th>
        <th>Settled</th><th>Win</th><th>ROI staked</th><th>ROI equal</th><th>Net P&amp;L</th>
        <th>Fills/day</th><th>CLV 1h</th><th class="l">Flags</th>
      </tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
</section>

<section>
  <h2>How a grade is built</h2>
  <p class="sec-note">Every input is measured from settled outcomes and public order history. Nothing is self-reported.</p>
  <div class="method">
    <div><h4>Realized return</h4><p>Profit and loss recomputed from entry price and settled outcome, not from the wallet's displayed balance. Staked-weighted and equal-weighted, both reported.</p></div>
    <div><h4>Concentration</h4><p>Share of total profit produced by the single best bet. Above 30% the record is one lucky position, not a method.</p></div>
    <div><h4>Follow pace</h4><p>Fills per active day. Above 500 the wallet is machine-operated and a human follower cannot replicate its entries.</p></div>
    <div><h4>Copy price value</h4><p>Price movement over the hour after our detection, entered at the price a follower could actually have paid — never at the whale's own fill.</p></div>
    <div><h4>Sample floor</h4><p>Minimum 50 settled bets. Below 100 the wallet carries a thin-sample flag regardless of its record.</p></div>
    <div><h4>Entry level</h4><p>Average entry in cents. Wallets living above 80¢ post high win rates by construction; the grade discounts this.</p></div>
  </div>
</section>

<section class="prose">
  <h2>What this report does not claim</h2>
  <p>Detection latency here is one to five minutes. A faster observer might measure different short-horizon values, and nothing in this data speaks to sub-minute copying.</p>
  <p>Outcome labels currently cover ${Number(m.labelled).toLocaleString()} of ${Number(m.universe).toLocaleString()} markets these wallets traded (${cov}%) and continue to accumulate; grades are recomputed as they land.</p>
  <p>A grade of F is not a verdict on a trader. It says the wallet's edge is not transferable to someone watching from outside — which is a statement about copyability, not about skill.</p>
</section>

<footer>
  <span>Method and grade inputs published in full · addresses are public onchain identifiers</span>
  <span>Report 001 · rebuilt ${today}</span>
</footer>

</div>
</body>
</html>`;

writeFileSync(`${ROOT}/site/public/index.html`, head + body);
console.log(`Rebuilt site/public/index.html — ${g.length} wallets, ${cov}% label coverage, validation 1h ${clv.validate_1h}¢`);
await pool.end();
