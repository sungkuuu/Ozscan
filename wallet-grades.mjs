// Wallet copyability grading — the product core.
// Turns raw wallet history into a per-wallet grade answering: "is this wallet's
// activity worth following, and could a follower actually have captured it?"
//
// Inputs : smart_alerts (clean-schema rows: action/outcome/asset_id present)
//          market_resolutions (settled outcomes)
//          clv_pilot_episodes (detection-price markouts, Apr window)
// Output : wallet_grades table + console table
// Run    : node wallet-grades.mjs

import { readFileSync } from 'fs';
import { Pool } from 'pg';

const DB_URL = process.env.DATABASE_URL
  || readFileSync(`${process.env.HOME}/OzScan/backups/.db_url`, 'utf8').trim();
const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

const MIN_RESOLVED = Number(process.env.MIN_RESOLVED || 50);
const MIN_MARKETS = Number(process.env.MIN_MARKETS || 20); // one sliced longshot != a record
// Walk-forward support: restrict the scoring window and write to a side table,
// so a training-period grade can be tested against a later, unseen period.
const WIN_START = Number(process.env.WINDOW_START || 0);
const WIN_END = Number(process.env.WINDOW_END || 9999999999);
const TABLE = (process.env.GRADES_TABLE || 'wallet_grades').replace(/[^a-z_]/g, '');

await pool.query(`
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    address TEXT PRIMARY KEY,
    grade TEXT, score NUMERIC,
    resolved_bets INT, resolved_markets INT, win_pct NUMERIC, roi_staked_pct NUMERIC, roi_equal_pct NUMERIC,
    pnl_usd NUMERIC, staked_usd NUMERIC,
    top1_pnl_share_pct NUMERIC, bets_per_active_day NUMERIC, median_bet_usd NUMERIC,
    avg_entry_cents NUMERIC, sports_share_pct NUMERIC,
    clv_1h_cents NUMERIC, clv_episodes INT,
    first_bet DATE, last_bet DATE, active_days INT,
    flags TEXT[], computed_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

// --- per-wallet metrics -----------------------------------------------------
const sql = `
WITH bets AS (
  SELECT s.address, s.condition_id, s.size, s.price, s.market, s.timestamp,
         (LOWER(regexp_replace(s.outcome,'[^a-z0-9]','','gi')) = LOWER(regexp_replace(r.winning_outcome,'[^a-z0-9]','','gi'))) AS won,
         CASE WHEN LOWER(regexp_replace(s.outcome,'[^a-z0-9]','','gi')) = LOWER(regexp_replace(r.winning_outcome,'[^a-z0-9]','','gi'))
              THEN s.size * (100 - s.price) / s.price ELSE -s.size END AS pnl
  FROM smart_alerts s
  JOIN market_resolutions r ON r.condition_id = s.condition_id
  WHERE s.action = 'BUY' AND s.outcome IS NOT NULL
    AND s.price BETWEEN 5 AND 95 AND s.size > 0
    AND r.closed IS TRUE AND r.winning_outcome IS NOT NULL
    AND s.timestamp >= ${WIN_START} AND s.timestamp < ${WIN_END}
),
per AS (
  SELECT address,
    count(*) AS resolved_bets,
    count(DISTINCT condition_id) AS resolved_markets,
    ROUND(100.0 * count(*) FILTER (WHERE won) / count(*), 1) AS win_pct,
    ROUND(SUM(pnl)) AS pnl_usd,
    ROUND(SUM(size)) AS staked_usd,
    ROUND(100.0 * SUM(pnl) / NULLIF(SUM(size), 0), 1) AS roi_staked_pct,
    ROUND(AVG(100.0 * pnl / NULLIF(size, 0)), 1) AS roi_equal_pct,
    ROUND(MAX(pnl)) AS best_bet_pnl,
    ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY size)::numeric, 1) AS median_bet_usd,
    ROUND(AVG(price), 1) AS avg_entry_cents,
    ROUND(100.0 * count(*) FILTER (WHERE market ~* 'ITF|ATP|WTA|vs\\.|vs |NBA|MLB|NHL|NFL') / count(*), 1) AS sports_share_pct,
    count(DISTINCT to_timestamp(timestamp)::date) AS active_days,
    MIN(to_timestamp(timestamp))::date AS first_bet,
    MAX(to_timestamp(timestamp))::date AS last_bet
  FROM bets GROUP BY address
),
pace AS (
  SELECT address, count(*)::numeric / GREATEST(count(DISTINCT to_timestamp(timestamp)::date), 1) AS bets_per_active_day
  FROM smart_alerts WHERE action IS NOT NULL AND timestamp >= ${WIN_START} AND timestamp < ${WIN_END} GROUP BY address
),
clv AS (
  SELECT address, ROUND(AVG(mk_1h) * 100, 2) AS clv_1h_cents, count(*) AS clv_episodes
  FROM clv_pilot_episodes WHERE kind = 'signal' AND mk_1h IS NOT NULL GROUP BY address
)
SELECT p.*, COALESCE(pc.bets_per_active_day, 0) AS bets_per_active_day,
       c.clv_1h_cents, COALESCE(c.clv_episodes, 0) AS clv_episodes
FROM per p LEFT JOIN pace pc ON pc.address = p.address LEFT JOIN clv c ON c.address = p.address
WHERE p.resolved_bets >= ${MIN_RESOLVED} AND p.resolved_markets >= ${MIN_MARKETS}
ORDER BY p.roi_staked_pct DESC NULLS LAST
`;
const { rows } = await pool.query(sql);
console.log(`Wallets with >=${MIN_RESOLVED} resolved bets: ${rows.length}\n`);

// --- grading ----------------------------------------------------------------
// Score is deliberately conservative: realized ROI only counts when it survives
// concentration and weighting checks, and pace/CLV gate whether a human could
// have followed it at all.
function grade(w) {
  const flags = [];
  const roiS = Number(w.roi_staked_pct ?? 0);
  const roiE = Number(w.roi_equal_pct ?? 0);
  const top1 = w.staked_usd > 0 && w.pnl_usd > 0
    ? Math.min(100, (Number(w.best_bet_pnl) / Number(w.pnl_usd)) * 100) : 0;
  const pace = Number(w.bets_per_active_day);
  const clv = w.clv_1h_cents === null ? null : Number(w.clv_1h_cents);

  if (pace > 500) flags.push('bot-pace');
  if (top1 > 30) flags.push('single-bet-driven');
  if (Math.sign(roiS) !== Math.sign(roiE) && roiS !== 0 && roiE !== 0) flags.push('weighting-flip');
  if (Number(w.avg_entry_cents) > 80) flags.push('favorite-heavy');
  if (Number(w.resolved_bets) < 100) flags.push('thin-sample');
  // Dormancy is measured from the end of the scoring window, not wall-clock: a
  // walk-forward run that stops at June 30 must not mark every wallet dormant
  // just because today is later.
  const asOfMs = Math.min(Date.now(), WIN_END * 1000);
  const daysSinceLast = (asOfMs / 86400000) - (new Date(w.last_bet).getTime() / 86400000);
  if (daysSinceLast > 30) flags.push('dormant');
  if (clv !== null && clv < 0) flags.push('negative-clv');

  // score: robust ROI (min of the two weightings) minus penalties
  let score = Math.max(-50, Math.min(50, Math.min(roiS, roiE)));
  if (flags.includes('bot-pace')) score -= 25;
  if (flags.includes('single-bet-driven')) score -= 15;
  if (flags.includes('weighting-flip')) score -= 15;
  if (flags.includes('thin-sample')) score -= 10;
  if (clv !== null) score += Math.max(-10, Math.min(10, clv * 5));

  if (flags.includes('dormant')) score = Math.min(score, 5);   // can't follow what no longer trades
  let g;
  if (score >= 20 && flags.length === 0) g = 'A';
  else if (score >= 10) g = 'B';
  else if (score >= 0) g = 'C';
  else if (score >= -15) g = 'D';
  else g = 'F';
  return { g, score: Math.round(score * 10) / 10, top1: Math.round(top1 * 10) / 10, flags };
}

for (const w of rows) {
  const { g, score, top1, flags } = grade(w);
  await pool.query(
    `INSERT INTO ${TABLE} (address, grade, score, resolved_bets, resolved_markets, win_pct, roi_staked_pct, roi_equal_pct,
       pnl_usd, staked_usd, top1_pnl_share_pct, bets_per_active_day, median_bet_usd, avg_entry_cents,
       sports_share_pct, clv_1h_cents, clv_episodes, first_bet, last_bet, active_days, flags, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
     ON CONFLICT (address) DO UPDATE SET grade=EXCLUDED.grade, score=EXCLUDED.score,
       resolved_bets=EXCLUDED.resolved_bets, resolved_markets=EXCLUDED.resolved_markets, win_pct=EXCLUDED.win_pct, roi_staked_pct=EXCLUDED.roi_staked_pct,
       roi_equal_pct=EXCLUDED.roi_equal_pct, pnl_usd=EXCLUDED.pnl_usd, staked_usd=EXCLUDED.staked_usd,
       top1_pnl_share_pct=EXCLUDED.top1_pnl_share_pct, bets_per_active_day=EXCLUDED.bets_per_active_day,
       median_bet_usd=EXCLUDED.median_bet_usd, avg_entry_cents=EXCLUDED.avg_entry_cents,
       sports_share_pct=EXCLUDED.sports_share_pct, clv_1h_cents=EXCLUDED.clv_1h_cents,
       clv_episodes=EXCLUDED.clv_episodes, first_bet=EXCLUDED.first_bet, last_bet=EXCLUDED.last_bet,
       active_days=EXCLUDED.active_days, flags=EXCLUDED.flags, computed_at=NOW()`,
    [w.address, g, score, w.resolved_bets, w.resolved_markets, w.win_pct, w.roi_staked_pct, w.roi_equal_pct, w.pnl_usd,
     w.staked_usd, top1, w.bets_per_active_day, w.median_bet_usd, w.avg_entry_cents, w.sports_share_pct,
     w.clv_1h_cents, w.clv_episodes, w.first_bet, w.last_bet, w.active_days, flags]
  );
}

const { rows: out } = await pool.query(
  `SELECT grade, LEFT(address,10)||'…' AS wallet, score, resolved_bets AS bets, win_pct, roi_staked_pct AS roi,
          roi_equal_pct AS roi_eq, pnl_usd, ROUND(bets_per_active_day) AS pace, clv_1h_cents AS clv,
          last_bet, array_to_string(flags,',') AS flags
   FROM ${TABLE} ORDER BY score DESC`);
console.table(out);
const { rows: dist } = await pool.query(`SELECT grade, count(*) FROM ${TABLE} GROUP BY 1 ORDER BY 1`);
console.log('\nGrade distribution:', dist.map(d => `${d.grade}:${d.count}`).join('  '));
await pool.end();
