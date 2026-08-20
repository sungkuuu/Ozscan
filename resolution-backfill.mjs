// Backfill market resolutions for every condition_id seen in smart_alerts.
// Writes market_resolutions(condition_id, closed, winning_outcome, ...) so
// win rates and resolution P&L become computable. Resumable: already-fetched
// condition_ids are skipped. Run: node resolution-backfill.mjs
// (DATABASE_URL env or ~/OzScan/backups/.db_url)

import { readFileSync } from 'fs';
import { Pool } from 'pg';

const DB_URL = process.env.DATABASE_URL
  || readFileSync(`${process.env.HOME}/OzScan/backups/.db_url`, 'utf8').trim();
const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await pool.query(`
  CREATE TABLE IF NOT EXISTS market_resolutions (
    condition_id TEXT PRIMARY KEY,
    question TEXT,
    closed BOOLEAN,
    winning_outcome TEXT,
    outcome_prices TEXT,
    end_date TEXT,
    fetched_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

const { rows } = await pool.query(`
  SELECT DISTINCT condition_id FROM smart_alerts
  WHERE condition_id IS NOT NULL AND condition_id LIKE '0x%'
    AND condition_id NOT IN (SELECT condition_id FROM market_resolutions)
`);
const ids = rows.map((r) => r.condition_id);
console.log(`Resolutions to fetch: ${ids.length}`);

let blockStreak = 0;
let done = 0, found = 0;

// gamma ignores the plural condition_ids param (verified 8/20 — batch lookups
// matched almost nothing); the singular conditionId param is proven by the
// worker's resolve loop. One call per market it is.
async function fetchOne(id) {
  while (true) {
    let res;
    try {
      res = await fetch(`https://gamma-api.polymarket.com/markets?conditionId=${id}`);
    } catch (e) { console.log(`fetch err ${e.message}, retry 10s`); await sleep(10_000); continue; }
    if (!res.ok) {
      blockStreak++;
      if (blockStreak >= 5) { console.log(`HTTP ${res.status} x5 — exiting, resume later`); process.exit(2); }
      console.log(`HTTP ${res.status}, backoff ${60 * blockStreak}s`);
      await sleep(60_000 * blockStreak);
      continue;
    }
    blockStreak = 0;
    const body = await res.json();
    return Array.isArray(body) ? body[0] : body;
  }
}

for (const id of ids) {
  {
    const m = await fetchOne(id);
    done++;
    if (!m) {
      // Not in gamma (old/removed market) — record as unknown so we don't refetch
      await pool.query(
        `INSERT INTO market_resolutions (condition_id, closed) VALUES ($1, NULL) ON CONFLICT DO NOTHING`,
        [id]
      );
      continue;
    }
    found++;
    const closed = m.closed === true || m.resolved === true || m.active === false;
    let winning = m.winningOutcome ?? m.winning_outcome ?? null;
    let prices = null;
    try {
      const p = m.outcomePrices ? (Array.isArray(m.outcomePrices) ? m.outcomePrices : JSON.parse(m.outcomePrices)) : null;
      prices = p ? JSON.stringify(p) : null;
      // Derive winner from final prices when gamma doesn't name it
      if (!winning && closed && p && m.outcomes) {
        const outs = Array.isArray(m.outcomes) ? m.outcomes : JSON.parse(m.outcomes);
        const idx = p.findIndex((x) => parseFloat(x) > 0.99);
        if (idx >= 0 && outs[idx]) winning = String(outs[idx]);
      }
    } catch (_) {}
    await pool.query(
      `INSERT INTO market_resolutions (condition_id, question, closed, winning_outcome, outcome_prices, end_date)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (condition_id) DO UPDATE SET closed = EXCLUDED.closed,
         winning_outcome = EXCLUDED.winning_outcome, outcome_prices = EXCLUDED.outcome_prices, fetched_at = NOW()`,
      [id, m.question || null, closed, winning, prices, m.endDate || m.end_date_iso || null]
    );
  }
  if (done % 500 === 0) console.log(`${done}/${ids.length} processed (${found} found)`);
  await sleep(450);
}
console.log(`DONE — ${done} processed, ${found} found in gamma`);
await pool.end();
