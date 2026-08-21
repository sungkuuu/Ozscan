// Settlement feed — the loop no other tracker closes.
// Other tools show entries and stop. This walks each tracked bet all the way
// to settlement: what a wallet bought, what it paid, how it resolved, and what
// that does to its running record.
//
// Sections: SETTLED (closed since last run) · OPEN (live exposure) · SCOREBOARD
// Output  : feed.json + feed.md (post-ready digest)
// Run     : node settlement-feed.mjs   [DAYS=3]

import { readFileSync, writeFileSync } from 'fs';
import { Pool } from 'pg';

const DB_URL = process.env.DATABASE_URL
  || readFileSync(`${process.env.HOME}/OzScan/backups/.db_url`, 'utf8').trim();
const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
const DAYS = Number(process.env.DAYS || 3);
const MIN_USD = Number(process.env.MIN_USD || 1000);

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const money = (v) => {
  const s = v < 0 ? '-' : '';
  const x = Math.abs(Number(v));
  if (x >= 1e6) return `${s}$${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `${s}$${(x / 1e3).toFixed(0)}K`;
  return `${s}$${x.toFixed(0)}`;
};
const trim = (s, n = 68) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

// --- SETTLED: bets whose market closed within the window --------------------
const { rows: settled } = await pool.query(`
  SELECT s.address, s.market, s.outcome, s.size, s.price, s.timestamp,
         r.winning_outcome, r.end_date,
         (LOWER(regexp_replace(s.outcome,'[^a-z0-9]','','gi')) = LOWER(regexp_replace(r.winning_outcome,'[^a-z0-9]','','gi'))) AS won,
         CASE WHEN LOWER(regexp_replace(s.outcome,'[^a-z0-9]','','gi')) = LOWER(regexp_replace(r.winning_outcome,'[^a-z0-9]','','gi'))
              THEN s.size * (100 - s.price) / s.price ELSE -s.size END AS pnl,
         to_timestamp(s.timestamp)::date AS entry_date, r.end_date::timestamptz::date AS resolve_date,
         ROUND(EXTRACT(EPOCH FROM (r.end_date::timestamptz - to_timestamp(s.timestamp))) / 86400.0, 1) AS held_days
  FROM smart_alerts s
  JOIN market_resolutions r ON r.condition_id = s.condition_id
  WHERE s.action = 'BUY' AND s.outcome IS NOT NULL AND s.size >= $1
    AND s.price BETWEEN 5 AND 95
    AND r.closed IS TRUE AND r.winning_outcome IS NOT NULL AND r.end_date IS NOT NULL
    AND r.end_date::timestamptz > NOW() - ($2 || ' days')::interval
    AND r.end_date::timestamptz <= NOW()
  ORDER BY ABS(CASE WHEN LOWER(regexp_replace(s.outcome,'[^a-z0-9]','','gi')) = LOWER(regexp_replace(r.winning_outcome,'[^a-z0-9]','','gi'))
                    THEN s.size * (100 - s.price) / s.price ELSE -s.size END) DESC
  LIMIT 25`, [MIN_USD, DAYS]);

// --- OPEN: live exposure, biggest first -------------------------------------
const { rows: open } = await pool.query(`
  SELECT s.address, s.market, s.outcome, s.size, s.price, s.timestamp, r.end_date
  FROM smart_alerts s
  LEFT JOIN market_resolutions r ON r.condition_id = s.condition_id
  WHERE s.action = 'BUY' AND s.outcome IS NOT NULL AND s.size >= $1
    AND s.price BETWEEN 5 AND 95
    AND s.timestamp > EXTRACT(EPOCH FROM NOW() - INTERVAL '10 days')
    AND (r.condition_id IS NULL OR r.closed IS NOT TRUE)
    AND (r.end_date IS NULL OR r.end_date::timestamptz > NOW())
  ORDER BY s.size DESC LIMIT 15`, [MIN_USD * 5]);

// --- SCOREBOARD: running record, graded wallets only ------------------------
const { rows: board } = await pool.query(`
  SELECT address, grade, resolved_bets, win_pct, roi_staked_pct, pnl_usd, last_bet
  FROM wallet_grades WHERE grade IN ('A','B','C') ORDER BY score DESC LIMIT 10`);

// Same wallet on both sides of one market is liquidity provision, not a call.
const { rows: twoSided } = await pool.query(`
  SELECT s.address, s.condition_id, MIN(s.market) AS market,
         count(DISTINCT s.outcome) AS sides, ROUND(SUM(s.size)) AS usd
  FROM smart_alerts s
  WHERE s.action = 'BUY' AND s.outcome IS NOT NULL AND s.size >= $1
    AND s.timestamp > EXTRACT(EPOCH FROM NOW() - INTERVAL '10 days')
  GROUP BY s.address, s.condition_id
  HAVING count(DISTINCT s.outcome) > 1
  ORDER BY SUM(s.size) DESC LIMIT 5`, [MIN_USD]);

const stamp = new Date().toISOString().slice(0, 10);
const md = [];
md.push(`# Settlement feed — ${stamp}`);
md.push(`\nWhat tracked wallets bet, and how it actually turned out.\n`);

md.push(`\n## Settled in the last ${DAYS} days\n`);
if (settled.length === 0) md.push(`_No settlements above ${money(MIN_USD)} in this window._`);
else md.push(`Largest settled positions, capped at three per wallet.\n`);
const perWallet = new Map();
const digest = settled.filter((r) => {
  const n = (perWallet.get(r.address) || 0) + 1;
  perWallet.set(r.address, n);
  return n <= 3;   // at most 3 lines per wallet
}).slice(0, 12);
for (const r of digest) {
  const res = r.won ? '✅ WON' : '❌ LOST';
  md.push(`- **${short(r.address)}** · ${trim(r.market)}`);
  // end_date is nominal for sports markets, so a signed hold time is unreliable
  const held = Number(r.held_days) > 0 ? `, held ${r.held_days}d` : '';
  md.push(`  · bet **${money(r.size)}** on _${r.outcome}_ at ${Number(r.price).toFixed(0)}¢${held} → ${res} **${money(r.pnl)}** (entered ${day(r.entry_date)} → settled ${day(r.resolve_date)} as ${r.winning_outcome})`);
}

md.push(`\n## Open exposure now\n`);
if (open.length === 0) md.push(`_No open positions above ${money(MIN_USD * 5)}._`);
for (const r of open.slice(0, 10)) {
  const ends = day(r.end_date);
  md.push(`- **${short(r.address)}** · ${money(r.size)} on _${r.outcome}_ at ${Number(r.price).toFixed(0)}¢ — ${trim(r.market)} (resolves ${ends})`);
}

md.push(`\n## Running record — followable wallets only\n`);
md.push(`| Grade | Wallet | Settled bets | Win | ROI | Net P&L |`);
md.push(`|---|---|---:|---:|---:|---:|`);
for (const w of board) {
  md.push(`| ${w.grade} | \`${short(w.address)}\` | ${Number(w.resolved_bets).toLocaleString()} | ${w.win_pct}% | ${w.roi_staked_pct}% | ${money(w.pnl_usd)} |`);
}
if (twoSided.length) {
  md.push(`\n## Two-sided activity\n`);
  md.push(`These wallets bought _both_ outcomes of the same market — liquidity provision, not a directional call. Read their entries accordingly.\n`);
  for (const t of twoSided) md.push(`- **${short(t.address)}** · ${money(t.usd)} across ${t.sides} outcomes — ${trim(t.market)}`);
}

md.push(`\n_Grades measure copyability, not skill. A wallet can be highly profitable and still ungradeable — see the ratings report._`);

// write beside the repo, not a hardcoded home path — CI runs elsewhere
const OUT = process.env.OUT_DIR || process.cwd();
writeFileSync(`${OUT}/feed.md`, md.join('\n'));
writeFileSync(`${OUT}/feed.json`, JSON.stringify({ stamp, settled, open, board }, null, 2));
console.log(md.join('\n'));
console.log(`\n--- settled:${settled.length} open:${open.length} board:${board.length}`);
await pool.end();
