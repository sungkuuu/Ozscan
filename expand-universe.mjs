// Universe expansion: grade ~1,200 wallets instead of the stale April 64.
//
// Sources: (a) every wallet already observed making $2K+ trades in
// whale_trades, (b) the current Polymarket leaderboard (top profit/volume),
// fetched here because runner IPs are clean while the local machine is banned.
//
// Progress lives in the grade_universe table, not a runner-local file, so any
// number of 45-minute workflow runs converge on completion. Each run works
// until the time budget expires, then exits cleanly.
//
// Guards: window bounded to 2026-04-02+ (keeps the label universe bounded),
// per-wallet page cap (mega-bots can't eat the run), DB size ceiling 27GB.

import { readFileSync } from 'fs';
import { Pool } from 'pg';

const DB_URL = process.env.DATABASE_URL
  || readFileSync(`${process.env.HOME}/OzScan/backups/.db_url`, 'utf8').trim();
const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const START = 1775088000;                       // 2026-04-02 00:00 UTC
const END = Math.floor(Date.now() / 1000);
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MIN || 40) * 60_000;
const MAX_PAGES = Number(process.env.MAX_PAGES || 300);   // 150K fills cap per wallet
const DB_CEILING = 27 * 1024 ** 3;   // volume grown to 30GB on 8/24; keep 3GB headroom
const VERSION = 'universe-20260824';
const t0 = Date.now();

await pool.query(`
  CREATE TABLE IF NOT EXISTS grade_universe (
    address TEXT PRIMARY KEY,
    source TEXT,
    added_at TIMESTAMPTZ DEFAULT NOW(),
    backfilled_at TIMESTAMPTZ,
    fills INT
  )`);

// --- 1. Seed --------------------------------------------------------------
const { rows: [{ count: seeded }] } = await pool.query(`SELECT count(*) FROM grade_universe`);
if (Number(seeded) === 0) {
  const a = await pool.query(`
    INSERT INTO grade_universe (address, source)
    SELECT DISTINCT LOWER(proxy_wallet), 'whale-feed' FROM whale_trades
    WHERE proxy_wallet ~ '^0x[0-9a-fA-F]{40}$'
    ON CONFLICT DO NOTHING`);
  // the 64 April wallets are already fully backfilled — mark them done
  const b = await pool.query(`
    UPDATE grade_universe g SET backfilled_at = NOW(), source = 'april-seed'
    FROM smart_profiles p WHERE LOWER(p.address) = g.address`);
  console.log(`Seeded ${a.rowCount} whale-feed wallets, ${b.rowCount} marked as april-seed (done)`);
}

// --- 2. Leaderboard cohort (once) -----------------------------------------
const { rows: [{ count: lbCount }] } = await pool.query(
  `SELECT count(*) FROM grade_universe WHERE source = 'leaderboard'`);
if (Number(lbCount) === 0) {
  // data-api.polymarket.com/v1/leaderboard superseded the old lb-api host;
  // limit caps at 50, so page with offset to reach the top 100 per board.
  let added = 0;
  for (const orderBy of ['PNL', 'VOL']) {
    for (const timePeriod of ['MONTH', 'WEEK']) {
      for (const offset of [0, 50]) {
        try {
          const res = await fetch(`https://data-api.polymarket.com/v1/leaderboard?category=OVERALL&timePeriod=${timePeriod}&orderBy=${orderBy}&limit=50&offset=${offset}`);
          if (!res.ok) { console.log(`leaderboard ${orderBy}/${timePeriod}/${offset}: HTTP ${res.status}`); continue; }
          const body = await res.json();
          const list = Array.isArray(body) ? body : (body?.leaderboard || body?.data || []);
          for (const e of list) {
            const addr = String(e.proxyWallet || e.wallet || e.address || '').toLowerCase();
            if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
            const r = await pool.query(
              `INSERT INTO grade_universe (address, source) VALUES ($1, 'leaderboard') ON CONFLICT DO NOTHING`, [addr]);
            added += r.rowCount;
          }
        } catch (e) { console.log(`leaderboard ${orderBy}/${timePeriod}/${offset}: ${e.message}`); }
        await sleep(1000);
      }
    }
  }
  console.log(`Leaderboard cohort: +${added} wallets`);
}

// --- 3. Backfill loop (same mapping as the live collector) ----------------
let blockStreak = 0;
async function backfillWallet(addr) {
  let end = END, lastMin = Infinity, inserted = 0, pages = 0;
  while (pages < MAX_PAGES) {
    let acts;
    try {
      const res = await fetch(`https://data-api.polymarket.com/activity?user=${addr}&limit=500&start=${START}&end=${end}`);
      if (res.status === 404) break;
      if (!res.ok) {
        blockStreak++;
        if (blockStreak >= 5) { console.log(`HTTP ${res.status} x5 — exiting for this run`); process.exit(2); }
        await sleep(30_000 * blockStreak); continue;
      }
      blockStreak = 0;
      acts = await res.json();
    } catch (e) { await sleep(10_000); continue; }
    if (!Array.isArray(acts) || acts.length === 0) break;
    pages++;
    const rows = []; const seen = new Set(); let minTs = Infinity;
    for (const a of acts) {
      const type = (a.type || '').toUpperCase();
      const rawTs = a.timestamp || 0;
      const ts = typeof rawTs === 'number' ? (rawTs > 1e12 ? Math.floor(rawTs / 1000) : rawTs) : Math.floor(new Date(rawTs).getTime() / 1000);
      if (ts < minTs) minTs = ts;
      if (['REWARD', 'REDEEM', 'MERGE', 'SPLIT'].includes(type)) continue;
      const txHash = a.transactionHash || null;
      const assetId = a.asset || null;
      const action = a.side ? String(a.side).toUpperCase() : null;
      const tradeId = txHash ? [txHash, assetId || '', action || '', a.price ?? '', a.size ?? ''].join(':') : (a.id || null);
      if (!tradeId || !ts || seen.has(tradeId)) continue;
      seen.add(tradeId);
      const side = (a.outcome || a.side || a.type || '').toUpperCase();
      rows.push([tradeId, addr, a.title || a.slug || 'Unknown market',
        side === 'BUY' ? 'YES' : side === 'SELL' ? 'NO' : side || '—',
        parseFloat(a.usdcSize || a.size || a.amount || 0), parseFloat(a.price || 0) * 100,
        a.conditionId || null, a.slug || null, a.eventSlug || null, ts,
        action, a.outcome != null ? String(a.outcome) : null, assetId, txHash]);
    }
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const cols = 14;
      const values = chunk.map((_, j) => `(${Array.from({ length: cols }, (_, k) => `$${j * cols + k + 1}`).join(',')},'${VERSION}','p1')`);
      const res = await pool.query(
        `INSERT INTO smart_alerts (trade_id, address, market, side, size, price, condition_id, slug, event_slug, timestamp, action, outcome, asset_id, transaction_hash, collector_version, parser_version)
         VALUES ${values.join(',')} ON CONFLICT (trade_id) DO NOTHING`, chunk.flat());
      inserted += res.rowCount;
    }
    if (minTs === Infinity || minTs <= START) break;
    end = minTs >= lastMin ? minTs - 1 : minTs;
    lastMin = minTs;
    await sleep(1000);
  }
  return { inserted, pages };
}

let done = 0;
while (Date.now() - t0 < TIME_BUDGET_MS) {
  const { rows: [sz] } = await pool.query(`SELECT pg_database_size(current_database()) AS s`);
  if (Number(sz.s) > DB_CEILING) { console.log('DB ceiling 27GB reached — stopping. Review before continuing.'); process.exit(3); }

  const { rows: next } = await pool.query(
    `SELECT address FROM grade_universe WHERE backfilled_at IS NULL ORDER BY added_at LIMIT 1`);
  if (next.length === 0) { console.log('UNIVERSE COMPLETE — nothing left to backfill.'); break; }
  const addr = next[0].address;
  const { inserted, pages } = await backfillWallet(addr);
  await pool.query(`UPDATE grade_universe SET backfilled_at = NOW(), fills = $2 WHERE address = $1`, [addr, inserted]);
  done++;
  if (done % 10 === 0) {
    const { rows: [p] } = await pool.query(
      `SELECT count(*) FILTER (WHERE backfilled_at IS NOT NULL) AS d, count(*) AS t FROM grade_universe`);
    console.log(`[${p.d}/${p.t}] this run: ${done} wallets`);
  }
}
const { rows: [fin] } = await pool.query(
  `SELECT count(*) FILTER (WHERE backfilled_at IS NOT NULL) AS d, count(*) AS t FROM grade_universe`);
console.log(`Run finished: ${done} wallets this run — universe ${fin.d}/${fin.t}`);
await pool.end();
