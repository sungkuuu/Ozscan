// Backfill market resolutions for every condition_id seen in smart_alerts.
// Writes market_resolutions(condition_id, closed, winning_outcome, ...).
// Self-validating: gamma has silently changed/ignored its filter params
// (2026-08-20: both conditionId= and condition_ids= returned an unrelated
// default listing), so every response is checked against the requested id
// and we lock onto the first endpoint that actually works.
// Resumable. Run: node resolution-backfill.mjs

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

// SHARD="i/n" lets n parallel runners split the id space disjointly.
// Driver reads the precomputed label_queue table when it exists — four
// concurrent 35GB DISTINCT scans of smart_alerts caused a lock pileup that
// stalled the live collector for hours (2026-08-26). Never scan here again.
const [SHARD_I, SHARD_N] = (process.env.SHARD || '0/1').split('/').map(Number);
const { rows: [{ exists: hasQueue }] } = await pool.query(
  `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='label_queue') AS exists`);
const { rows } = hasQueue
  ? await pool.query(`
      SELECT condition_id FROM label_queue
      WHERE condition_id NOT IN (SELECT condition_id FROM market_resolutions)
        AND mod(abs(hashtext(condition_id)), $1) = $2
    `, [SHARD_N, SHARD_I])
  : await pool.query(`
      SELECT DISTINCT condition_id FROM smart_alerts
      WHERE condition_id IS NOT NULL AND condition_id ~ '^0x[0-9a-fA-F]{64}$'
        AND condition_id NOT IN (SELECT condition_id FROM market_resolutions)
        AND mod(abs(hashtext(condition_id)), $1) = $2
    `, [SHARD_N, SHARD_I]);
const ids = rows.map((r) => r.condition_id);
console.log(`Resolutions to fetch (shard ${SHARD_I}/${SHARD_N}, queue=${hasQueue}): ${ids.length}`);

let blockStreak = 0;

async function get(url) {
  const res = await fetch(url);
  // 404 is a genuine "no such market" (our data holds a few truncated
  // condition_ids) — not a block. Don't count it toward the block streak.
  if (res.status === 404) return null;
  if (!res.ok) {
    blockStreak++;
    if (blockStreak >= 6) { console.log(`HTTP ${res.status} x6 — exiting, resume later`); process.exit(2); }
    console.log(`HTTP ${res.status} on ${url.slice(0, 60)}, backoff ${30 * blockStreak}s`);
    await sleep(30_000 * blockStreak);
    return undefined; // caller retries
  }
  blockStreak = 0;
  try { return await res.json(); } catch { return null; }
}

// Normalizers return {question, closed, winning, prices, endDate} ONLY when
// the response is verifiably the requested market; else null.
const eq = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

const ENDPOINTS = [
  {
    name: 'clob-single',
    fetch: async (id) => {
      const m = await get(`https://clob.polymarket.com/markets/${id}`);
      if (m === undefined) return undefined;
      if (!m || !eq(m.condition_id, id)) return null;
      const winTok = (m.tokens || []).find((t) => t.winner === true);
      return {
        question: m.question || null,
        closed: m.closed === true || m.archived === true,
        winning: winTok ? String(winTok.outcome) : null,
        prices: m.tokens ? JSON.stringify(m.tokens.map((t) => t.price)) : null,
        endDate: m.end_date_iso || null,
      };
    },
  },
  {
    name: 'gamma-condition_ids',
    fetch: async (id) => {
      const body = await get(`https://gamma-api.polymarket.com/markets?condition_ids=${id}`);
      if (body === undefined) return undefined;
      const m = (Array.isArray(body) ? body : []).find((x) => eq(x.conditionId || x.condition_id, id));
      if (!m) return null;
      let winning = m.winningOutcome ?? m.winning_outcome ?? null;
      let prices = null;
      try {
        const p = m.outcomePrices ? (Array.isArray(m.outcomePrices) ? m.outcomePrices : JSON.parse(m.outcomePrices)) : null;
        prices = p ? JSON.stringify(p) : null;
        if (!winning && p && m.outcomes) {
          const outs = Array.isArray(m.outcomes) ? m.outcomes : JSON.parse(m.outcomes);
          const idx = p.findIndex((x) => parseFloat(x) > 0.99);
          if (idx >= 0 && outs[idx]) winning = String(outs[idx]);
        }
      } catch (_) {}
      return {
        question: m.question || null,
        closed: m.closed === true || m.resolved === true || m.active === false,
        winning, prices,
        endDate: m.endDate || m.end_date_iso || null,
      };
    },
  },
];

let locked = null;         // endpoint proven to work
let probeFails = 0, done = 0, found = 0, notFound = 0;

// Throughput knobs. Defaults stay polite; raise via env once an endpoint is
// locked and the API is clearly tolerating the load. The blockStreak guard
// above still backs off and exits on repeated non-OK responses.
const PACE_MS = Number(process.env.PACE_MS ?? 450);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 1);

async function handle(id) {
  let result = null, matchedBy = null;
  const order = locked ? [locked] : ENDPOINTS;
  for (const ep of order) {
    let r;
    do { r = await ep.fetch(id); } while (r === undefined); // undefined = retry after backoff
    if (r) { result = r; matchedBy = ep; break; }
    await sleep(300);
  }
  done++;
  if (result) {
    if (!locked) { locked = matchedBy; console.log(`Endpoint locked: ${matchedBy.name}`); }
    probeFails = 0; found++;
    await pool.query(
      `INSERT INTO market_resolutions (condition_id, question, closed, winning_outcome, outcome_prices, end_date)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (condition_id) DO UPDATE SET closed=EXCLUDED.closed,
         winning_outcome=EXCLUDED.winning_outcome, outcome_prices=EXCLUDED.outcome_prices, fetched_at=NOW()`,
      [id, result.question, result.closed, result.winning, result.prices, result.endDate]
    );
  } else {
    notFound++;
    if (!locked && ++probeFails >= 30) {
      console.log('FATAL: 30 markets in a row matched by NO endpoint — API shapes changed again. Not marking anything.');
      process.exit(3);
    }
    if (locked) {
      // genuine not-found on a proven endpoint — mark so we don't refetch
      await pool.query(
        `INSERT INTO market_resolutions (condition_id, closed) VALUES ($1, NULL) ON CONFLICT DO NOTHING`, [id]
      );
    }
  }
  if (done % 500 === 0) console.log(`${done}/${ids.length} (found ${found}, notFound ${notFound})`);
  await sleep(PACE_MS);
}

// Probe serially until an endpoint is locked, then widen to CONCURRENCY lanes.
let cursor = 0;
while (cursor < ids.length && !locked) await handle(ids[cursor++]);

const rest = ids.slice(cursor);
const lanes = Array.from({ length: Math.max(1, CONCURRENCY) }, async (_, lane) => {
  for (let i = lane; i < rest.length; i += CONCURRENCY) await handle(rest[i]);
});
await Promise.all(lanes);

console.log(`DONE — ${done} processed, ${found} found, ${notFound} not found`);
await pool.end();
