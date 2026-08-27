// Emit the public grade-lookup API as static assets under site/public/api/v0.
// Static-by-design: files regenerate with every regrade, so the API is exactly
// as fresh as the grades and needs no server, database exposure, or auth.
// Run: node build-api.mjs   (then deploy the site worker)

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { nav } from './site-nav.mjs';
import { Pool } from 'pg';

const DB_URL = process.env.DATABASE_URL
  || readFileSync(`${process.env.HOME}/OzScan/backups/.db_url`, 'utf8').trim();
const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
const ROOT = process.env.REPO_DIR || `${process.env.HOME}/OzScan/Ozscan`;
const API = `${ROOT}/site/public/api`;

const { rows: g } = await pool.query(`SELECT * FROM wallet_grades ORDER BY score DESC`);
if (g.length === 0) { console.error('wallet_grades is empty — run wallet-grades.mjs first'); process.exit(1); }

const { rows: [m] } = await pool.query(`
  SELECT (SELECT count(*) FROM market_resolutions WHERE closed IS TRUE AND winning_outcome IS NOT NULL) AS labelled,
         (SELECT count(DISTINCT condition_id) FROM smart_alerts WHERE condition_id ~ '^0x[0-9a-fA-F]{64}$') AS universe`);

const generated = new Date().toISOString();
const num = (v) => (v === null || v === undefined ? null : Number(v));
const entry = (w) => ({
  address: w.address.toLowerCase(),
  grade: w.grade,
  score: num(w.score),
  resolved_bets: num(w.resolved_bets),
  resolved_markets: num(w.resolved_markets),
  win_pct: num(w.win_pct),
  roi_staked_pct: num(w.roi_staked_pct),
  roi_equal_pct: num(w.roi_equal_pct),
  pnl_usd: num(w.pnl_usd),
  top1_pnl_share_pct: num(w.top1_pnl_share_pct),
  bets_per_active_day: num(w.bets_per_active_day),
  avg_entry_cents: num(w.avg_entry_cents),
  clv_1h_cents: num(w.clv_1h_cents),
  first_bet: w.first_bet, last_bet: w.last_bet, active_days: num(w.active_days),
  flags: w.flags || [],
  computed_at: w.computed_at,
});

const meta = {
  generated_at: generated,
  wallets_graded: g.length,
  label_coverage_pct: Math.round((Number(m.labelled) / Number(m.universe)) * 100),
  method: 'https://assayscore.com',
  grade_scale: { A: 'clean on every check', B: 'minor flag', C: 'marginal, no demonstrated edge', D: 'profitable but compromised', F: 'not copyable' },
  disclaimer: 'Copyability assessment computed from settled outcomes and public order history. Not financial advice.',
};

mkdirSync(`${API}/v0/wallet`, { recursive: true });
mkdirSync(`${API}/v0/badge`, { recursive: true });

writeFileSync(`${API}/v0/grades.json`, JSON.stringify({ ...meta, grades: g.map(entry) }, null, 1));
for (const w of g) writeFileSync(`${API}/v0/wallet/${w.address.toLowerCase()}.json`, JSON.stringify({ ...entry(w), ...{ generated_at: generated } }, null, 1));

// --- grade badge SVG (shields-style, <img> one-liner for builders) ----------
const COLOR = { A: '#2E7D52', B: '#4C7F6B', C: '#7E7A52', D: '#A8742C', F: '#A33B2E' };
const badge = (grade) => `<svg xmlns="http://www.w3.org/2000/svg" width="76" height="20" role="img" aria-label="assay: ${grade}">
<rect width="52" height="20" rx="3" fill="#24292f"/>
<rect x="52" width="24" height="20" fill="${COLOR[grade]}"/>
<rect x="52" width="4" height="20" fill="${COLOR[grade]}"/>
<rect width="76" height="20" rx="3" fill="none"/>
<g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-anchor="middle">
<text x="26" y="14" font-size="11">assay</text>
<text x="64" y="14" font-size="11" font-weight="bold">${grade}</text>
</g></svg>`;
for (const w of g) writeFileSync(`${API}/v0/badge/${w.address.toLowerCase()}.svg`, badge(w.grade));

// --- docs page --------------------------------------------------------------
const head = readFileSync(`${ROOT}/site/head.tmpl.html`, 'utf8');
const docs = `
<body>
<div class="wrap">

${nav('/api/')}
<header class="masthead">
  <div class="eyebrow">Assay Score · Grade API v0</div>
  <h1>Grade lookup API</h1>
  <p class="standfirst">Read-only. Static snapshots regenerated with every regrade — currently ${g.length} wallets, ${meta.label_coverage_pct}% outcome-label coverage. No key, no rate card, CORS open.</p>
</header>

<section>
  <h2>Endpoints</h2>
  <div class="tablewrap"><table>
    <thead><tr><th class="l">Path</th><th class="l">Returns</th></tr></thead>
    <tbody>
      <tr><td class="l"><code>/api/v0/grades.json</code></td><td class="l">Every graded wallet with full metrics</td></tr>
      <tr><td class="l"><code>/api/v0/wallet/&lt;address&gt;.json</code></td><td class="l">One wallet (lowercase 0x address). 404 = not graded yet</td></tr>
      <tr><td class="l"><code>/api/v0/badge/&lt;address&gt;.svg</code></td><td class="l">Grade badge — embed with a single <code>&lt;img&gt;</code> tag</td></tr>
    </tbody>
  </table></div>
</section>

<section>
  <h2>Example</h2>
  <p><code>curl https://assayscore.com/api/v0/wallet/${g[0].address.toLowerCase()}.json</code></p>
  <p>Badge: <img src="/api/v0/badge/${g[0].address.toLowerCase()}.svg" alt="assay grade badge" style="vertical-align:middle"> — <code>&lt;img src="https://assayscore.com/api/v0/badge/&lt;address&gt;.svg"&gt;</code></p>
</section>

<section class="prose">
  <h2>Grades</h2>
  <p>A · clean on every check — B · minor flag — C · marginal, no demonstrated edge — D · profitable but compromised — F · not copyable. Method and inputs are published in full on the <a href="/">report page</a>.</p>
  <p>Every input is recomputed from settled outcomes and public order history; nothing is self-reported. This is a copyability assessment, not financial advice, and a grade is not a verdict on a trader's skill.</p>
</section>

<footer>
  <span>Contact: contact@assayscore.com</span>
  <span>v0 · rebuilt ${generated.slice(0, 10)}</span>
</footer>
</div>
</body>
</html>`;
writeFileSync(`${API}/index.html`, head + docs);

// CORS + modest caching for everything under /api
writeFileSync(`${ROOT}/site/public/_headers`, `/api/*
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=300
`);

console.log(`API built: ${g.length} wallets, ${meta.label_coverage_pct}% coverage — grades.json + ${g.length} wallet files + ${g.length} badges + docs`);
await pool.end();
