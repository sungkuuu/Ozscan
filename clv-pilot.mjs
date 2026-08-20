// CLV pilot per CLV_EXPERIMENT_DESIGN.md — real-time window 4/2–4/19.
// Episodes: clean BUY fills (restore-rt-20260820) merged per (wallet, asset)
// with 5-min gaps, observed_at joined from the April live rows (created_at,
// lag<5min) via transaction_hash. copy_price = first token price AFTER
// detection; markouts at +5m/+30m/+1h/+24h vs 2 random-time controls.
// Resumable per asset. Run: node clv-pilot.mjs

import { readFileSync } from 'fs';
import { Pool } from 'pg';

const DB_URL = process.env.DATABASE_URL
  || readFileSync(`${process.env.HOME}/OzScan/backups/.db_url`, 'utf8').trim();
const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WIN_START = 1775088000;            // 2026-04-02 00:00 UTC
const WIN_END = 1776643200;              // 2026-04-20 00:00 UTC
const RESTORE_TAG = 'restore-rt-20260820';
const MAX_WALLET_FILLS_PER_DAY = 5000;   // bot/MM cutoff (tennis bot ~13k/day)
const MIN_EPISODE_USD = 100;
const HORIZONS = { m5: 300, m30: 1800, h1: 3600, h24: 86400 };
const TOL = { m5: 1800, m30: 1800, h1: 1800, h24: 10800 };

// Single-writer lock: the 6-hourly pipeline-tick can overlap a running
// dispatch, and two writers would double-count episodes into the stats.
const lockConn = await pool.connect();
const { rows: [lk] } = await lockConn.query('SELECT pg_try_advisory_lock(918273645) AS ok');
if (!lk.ok) { console.log('Another clv-pilot holds the lock — exiting.'); process.exit(0); }

await pool.query(`
  CREATE TABLE IF NOT EXISTS clv_pilot_episodes (
    id SERIAL PRIMARY KEY,
    kind TEXT NOT NULL,              -- 'signal' | 'control'
    address TEXT, asset_id TEXT, condition_id TEXT, market TEXT,
    fills INT, usd NUMERIC, vwap_entry_cents NUMERIC,
    first_fill_ts BIGINT, observed_at TIMESTAMPTZ, detect_lag_s NUMERIC,
    copy_price NUMERIC,              -- 0..1
    mk_5m NUMERIC, mk_30m NUMERIC, mk_1h NUMERIC, mk_24h NUMERIC,
    split TEXT                       -- 'explore' (4/2-4/10) | 'validate' (4/11-4/19)
  )
`);

// --- 1. Build signal episodes in SQL ---------------------------------------
const epSql = `
WITH clean AS (
  SELECT n.address, n.asset_id, n.condition_id, n.market, n.timestamp AS ts,
         n.size AS usd_fill, n.price AS cents, n.transaction_hash
  FROM smart_alerts n
  WHERE n.collector_version = $1 AND n.action = 'BUY'
    AND n.price >= 5 AND n.price <= 95 AND n.asset_id IS NOT NULL
    AND n.timestamp >= ${WIN_START} AND n.timestamp < ${WIN_END}
),
obs AS (
  SELECT o.trade_id AS tx, MIN(o.created_at) AS observed_at
  FROM smart_alerts o
  WHERE o.created_at >= '2026-04-02' AND o.created_at < '2026-04-20'
    AND EXTRACT(EPOCH FROM (o.created_at - to_timestamp(o.timestamp))) < 300
  GROUP BY o.trade_id
),
sellers AS (
  SELECT DISTINCT address, asset_id, timestamp AS sell_ts
  FROM smart_alerts
  WHERE collector_version = $1 AND action = 'SELL' AND asset_id IS NOT NULL
),
botwallets AS (
  SELECT address FROM smart_alerts
  WHERE collector_version = $1
  GROUP BY address
  HAVING COUNT(*)::float / GREATEST(COUNT(DISTINCT to_timestamp(timestamp)::date),1) > ${MAX_WALLET_FILLS_PER_DAY}
),
joined AS (
  SELECT c.*, obs.observed_at
  FROM clean c JOIN obs ON obs.tx = c.transaction_hash
  WHERE c.address NOT IN (SELECT address FROM botwallets)
),
gaps AS (
  SELECT *, CASE WHEN ts - LAG(ts) OVER (PARTITION BY address, asset_id ORDER BY ts) > 300
       OR LAG(ts) OVER (PARTITION BY address, asset_id ORDER BY ts) IS NULL THEN 1 ELSE 0 END AS new_ep
  FROM joined
),
eps AS (
  SELECT *, SUM(new_ep) OVER (PARTITION BY address, asset_id ORDER BY ts) AS ep_no FROM gaps
),
agg AS (
  SELECT address, asset_id, MIN(condition_id) AS condition_id, MIN(market) AS market, ep_no,
    COUNT(*) AS fills, SUM(usd_fill) AS usd,
    SUM(usd_fill * cents) / NULLIF(SUM(usd_fill),0) AS vwap_cents,
    MIN(ts) AS first_ts, MAX(ts) AS last_ts, MIN(observed_at) AS observed_at
  FROM eps GROUP BY address, asset_id, ep_no
)
SELECT a.* FROM agg a
WHERE a.usd >= ${MIN_EPISODE_USD}
  AND NOT EXISTS (
    SELECT 1 FROM sellers s
    WHERE s.address = a.address AND s.asset_id = a.asset_id
      AND s.sell_ts BETWEEN a.first_ts - 1800 AND a.last_ts + 1800
  )
ORDER BY a.asset_id, a.first_ts
`;
// Guard: don't compute on a half-finished restore — episodes marked done on
// partial data would never be recomputed. Proceed only once restore inserts
// have been quiet for 30 minutes.
const { rows: [g] } = await pool.query(
  `SELECT count(*) AS n, EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) AS quiet_s
   FROM smart_alerts WHERE collector_version = $1`, [RESTORE_TAG]
);
if (Number(g.n) === 0) { console.log('Restore data not present yet — exiting.'); process.exit(0); }
if (Number(g.quiet_s) < 1800) { console.log(`Restore still inserting (quiet ${Math.round(g.quiet_s)}s < 1800s) — exiting.`); process.exit(0); }

const { rows: episodes } = await pool.query(epSql, [RESTORE_TAG]);
console.log(`Signal episodes: ${episodes.length} across ${new Set(episodes.map(e => e.asset_id)).size} assets, ${new Set(episodes.map(e => e.address)).size} wallets`);
if (episodes.length === 0) { console.log('Nothing to do'); process.exit(0); }

// Resume: skip assets already computed
const doneAssets = new Set(
  (await pool.query(`SELECT DISTINCT asset_id FROM clv_pilot_episodes`)).rows.map(r => r.asset_id)
);

// --- 2. Per asset: price series → markouts ---------------------------------
const byAsset = new Map();
for (const e of episodes) {
  if (!byAsset.has(e.asset_id)) byAsset.set(e.asset_id, []);
  byAsset.get(e.asset_id).push(e);
}
const assets = [...byAsset.keys()].filter(a => !doneAssets.has(a));
console.log(`Assets to price: ${assets.length} (${doneAssets.size} already done)`);

const priceAt = (hist, t, tolAfter) => {
  // first observation at or after t, within tolerance
  let lo = 0, hi = hist.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hist[mid].t >= t) { ans = hist[mid]; hi = mid - 1; } else lo = mid + 1;
  }
  return ans && ans.t - t <= tolAfter ? ans.p : null;
};

// prices-history rejected an 18-day span at fidelity=1 (HTTP 400), and the
// local IP is banned so variants can't be probed from here: try them in order
// on the first asset and lock onto whichever returns a usable series.
const VARIANTS = [
  (a, s, e) => `https://clob.polymarket.com/prices-history?market=${a}&startTs=${s}&endTs=${e}&fidelity=1`,
  (a, s, e) => `https://clob.polymarket.com/prices-history?market=${a}&startTs=${s}&endTs=${e}`,
  (a, s, e) => `https://clob.polymarket.com/prices-history?market=${a}&startTs=${s}&endTs=${e}&fidelity=10`,
  (a) => `https://clob.polymarket.com/prices-history?market=${a}&interval=max&fidelity=1`,
];
let lockedVariant = null;

async function fetchSeries(asset, startTs, endTs) {
  const order = lockedVariant ? [lockedVariant] : VARIANTS;
  for (const v of order) {
    let res;
    try { res = await fetch(v(asset, startTs, endTs)); }
    catch (e) { console.log(`fetch err ${e.message}, retry 10s`); await sleep(10_000); return undefined; }
    if (res.status === 400 || res.status === 404) continue;   // wrong shape / no data
    if (!res.ok) {
      blockStreak++;
      if (blockStreak >= 5) { console.log(`HTTP ${res.status} x5 — exiting, resume later`); process.exit(2); }
      console.log(`HTTP ${res.status}, backoff ${60 * blockStreak}s`); await sleep(60_000 * blockStreak);
      return undefined;
    }
    blockStreak = 0;
    let body; try { body = await res.json(); } catch { continue; }
    const h = (body?.history || []).map(x => ({ t: Number(x.t), p: Number(x.p) })).sort((a, b) => a.t - b.t);
    if (h.length >= 5) {
      if (!lockedVariant) { lockedVariant = v; console.log(`Price variant locked: ${v(asset, startTs, endTs).replace(asset, 'ASSET')}`); }
      return h;
    }
  }
  return [];   // genuinely no series
}

let blockStreak = 0, processedAssets = 0, written = 0, noSeries = 0;
for (const asset of assets) {
  // Per-asset window bounded by that asset's own episodes (+12h before for
  // controls, +25h after for the 24h markout) instead of the full 18 days.
  const epTs = byAsset.get(asset).map(e => Number(e.first_ts));
  const wStart = Math.max(WIN_START - 43200, Math.min(...epTs) - 43200);
  const wEnd = Math.max(...epTs) + 90000;
  let hist = await fetchSeries(asset, wStart, wEnd);
  if (hist === undefined) continue;   // retry/backoff already handled

  const eps = byAsset.get(asset);
  if (hist.length < 5) {
    noSeries++;
    for (const e of eps)
      await pool.query(`INSERT INTO clv_pilot_episodes (kind, address, asset_id, condition_id, market, fills, usd, vwap_entry_cents, first_fill_ts, observed_at, detect_lag_s, copy_price, split)
        VALUES ('signal',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11)`,
        [e.address, e.asset_id, e.condition_id, e.market, e.fills, e.usd, e.vwap_cents, e.first_ts, e.observed_at, null, splitOf(e.first_ts)]);
  } else {
    for (const e of eps) {
      const obsTs = Math.floor(new Date(e.observed_at).getTime() / 1000);
      const lag = obsTs - Number(e.first_ts);
      const copy = priceAt(hist, obsTs, 600);
      const mk = {};
      for (const [k, h] of Object.entries(HORIZONS)) {
        const p = copy !== null ? priceAt(hist, obsTs + h, TOL[k]) : null;
        mk[k] = p !== null && copy !== null ? p - copy : null;
      }
      await pool.query(`INSERT INTO clv_pilot_episodes (kind, address, asset_id, condition_id, market, fills, usd, vwap_entry_cents, first_fill_ts, observed_at, detect_lag_s, copy_price, mk_5m, mk_30m, mk_1h, mk_24h, split)
        VALUES ('signal',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [e.address, e.asset_id, e.condition_id, e.market, e.fills, e.usd, e.vwap_cents, e.first_ts, e.observed_at, lag, copy, mk.m5, mk.m30, mk.h1, mk.h24, splitOf(e.first_ts)]);
      written++;
      // 2 random-time controls on the same asset (same series, uniform over window)
      for (let c = 0; c < 2; c++) {
        const span = hist[hist.length - 1].t - 86400 - hist[0].t;
        if (span <= 0) break;
        const rt = hist[0].t + ((Number(e.first_ts) * 2654435761 + c * 97561) % span); // deterministic pseudo-random
        const ccopy = priceAt(hist, rt, 600);
        const cmk = {};
        for (const [k, h] of Object.entries(HORIZONS)) {
          const p = ccopy !== null ? priceAt(hist, rt + h, TOL[k]) : null;
          cmk[k] = p !== null && ccopy !== null ? p - ccopy : null;
        }
        await pool.query(`INSERT INTO clv_pilot_episodes (kind, address, asset_id, condition_id, first_fill_ts, copy_price, mk_5m, mk_30m, mk_1h, mk_24h, split)
          VALUES ('control',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [e.address, e.asset_id, e.condition_id, rt, ccopy, cmk.m5, cmk.m30, cmk.h1, cmk.h24, splitOf(rt)]);
      }
    }
  }
  processedAssets++;
  if (processedAssets % 200 === 0) console.log(`${processedAssets}/${assets.length} assets, ${written} episodes written, ${noSeries} without series`);
  await sleep(700);
}

function splitOf(ts) {
  return Number(ts) < 1775865600 ? 'explore' : 'validate'; // 2026-04-11 00:00 UTC
}

console.log(`DONE — assets ${processedAssets}, episodes ${written}, no-series assets ${noSeries}`);
await pool.end();
