// Backfill the 2026-04-19 → 2026-08-19 collection gap for smart_profiles wallets.
// Rows are inserted with collector_version 'backfill-gap-20260819' and created_at=NOW(),
// so they are honestly marked as backfill (lag >> 5min), never as real-time signals.
// Resumable: completed wallets are recorded in backfill-state.json.
// Run: node backfill-gap.mjs   (untracked file — not part of the deployed app)

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Pool } from 'pg';

const DB_URL = readFileSync(`${process.env.HOME}/OzScan/backups/.db_url`, 'utf8').trim();
const START = 1776556800; // 2026-04-19 00:00 UTC (slight overlap with old data; dedup via ON CONFLICT)
const END = Math.floor(Date.now() / 1000);
const STATE_FILE = `${process.env.HOME}/OzScan/Ozscan/backfill-state.json`;
const SKIP_TYPES = new Set(['REWARD', 'REDEEM', 'MERGE', 'SPLIT']);
const VERSION = 'backfill-gap-20260819';

const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { done: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mapRow(a, addr) {
  const rawTs = a.timestamp || 0;
  const ts = typeof rawTs === 'number' ? (rawTs > 1e12 ? Math.floor(rawTs / 1000) : rawTs) : Math.floor(new Date(rawTs).getTime() / 1000);
  const txHash = a.transactionHash || null;
  const assetIdK = a.asset || null;
  const actionK = a.side ? String(a.side).toUpperCase() : null;
  // Same composite dedup key as the live collector: one tx can carry multiple fills
  const tradeId = txHash ? [txHash, assetIdK || '', actionK || '', a.price ?? '', a.size ?? ''].join(':') : (a.id || null);
  if (!tradeId || !ts) return null;
  const side = (a.outcome || a.side || a.type || '').toUpperCase();
  return {
    tradeId, txHash, addr, ts,
    market: a.title || a.question || a.slug || 'Unknown market',
    sideNorm: side === 'BUY' ? 'YES' : side === 'SELL' ? 'NO' : side || '—',
    size: parseFloat(a.usdcSize || a.size || a.amount || 0),
    priceDb: parseFloat(a.price || 0) * 100,
    conditionId: a.conditionId || null,
    slug: a.slug || null,
    eventSlug: a.eventSlug || null,
    action: a.side ? String(a.side).toUpperCase() : null,
    outcome: a.outcome != null ? String(a.outcome) : null,
    assetId: a.asset || null,
    // raw payload intentionally NOT stored for backfill rows: the 5GB Hobby
    // volume hit 95% (2026-08-20) and backfill rows are re-fetchable anyway.
    raw: null,
  };
}

async function insertBatch(rows) {
  if (rows.length === 0) return 0;
  const cols = 17;
  const values = rows.map((_, i) => `(${Array.from({ length: cols }, (_, j) => `$${i * cols + j + 1}`).join(',')})`);
  const params = rows.flatMap((r) => [r.tradeId, r.addr, r.market, r.sideNorm, r.size, r.priceDb, r.conditionId, r.slug, r.eventSlug, r.ts, r.action, r.outcome, r.assetId, r.raw, VERSION, r.txHash, 'p1']);
  const res = await pool.query(
    `INSERT INTO smart_alerts (trade_id, address, market, side, size, price, condition_id, slug, event_slug, timestamp, action, outcome, asset_id, raw, collector_version, transaction_hash, parser_version)
     VALUES ${values.join(',')} ON CONFLICT (trade_id) DO NOTHING`,
    params
  );
  // whale_trades duplication skipped for backfill: redundant copy of the same
  // fills, and the volume has no room for it. smart_alerts is the analysis source.
  return res.rowCount;
}

let blockStreak = 0;

async function backfillWallet(addr) {
  let end = END;
  let lastMin = Infinity;
  let fetched = 0, inserted = 0, pages = 0;
  while (true) {
    const url = `https://data-api.polymarket.com/activity?user=${addr}&limit=500&start=${START}&end=${end}`;
    let acts;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        // 451/403 with Cloudflare error 1026 = IP ban from crawling too fast.
        // Back off hard and give up after a few tries — hammering extends the ban.
        blockStreak++;
        if (blockStreak >= 5) {
          console.log(`  HTTP ${res.status} x${blockStreak} — likely IP ban, exiting gracefully. Resume later.`);
          process.exit(2);
        }
        const wait = 60_000 * blockStreak;
        console.log(`  HTTP ${res.status}, backing off ${wait / 1000}s (${blockStreak}/5)`);
        await sleep(wait);
        continue;
      }
      blockStreak = 0;
      acts = await res.json();
    } catch (e) { console.log(`  fetch error ${e.message}, retrying in 10s`); await sleep(10_000); continue; }
    if (!Array.isArray(acts) || acts.length === 0) break;
    pages++;
    fetched += acts.length;
    const rows = [];
    const seen = new Set();
    let minTs = Infinity;
    for (const a of acts) {
      const type = (a.type || '').toUpperCase();
      const m = mapRow(a, addr);
      if (m && m.ts < minTs) minTs = m.ts;
      if (SKIP_TYPES.has(type) || !m || seen.has(m.tradeId)) continue;
      seen.add(m.tradeId);
      rows.push(m);
    }
    for (let i = 0; i < rows.length; i += 200) inserted += await insertBatch(rows.slice(i, i + 200));
    if (minTs === Infinity || minTs <= START) break;
    end = minTs >= lastMin ? minTs - 1 : minTs; // avoid same-second infinite loop
    lastMin = minTs;
    await sleep(1500); // polite pace — 350ms earned an IP ban on 2026-08-20
  }
  return { fetched, inserted, pages };
}

const { rows: wrows } = await pool.query('SELECT address FROM smart_profiles ORDER BY address');
const wallets = wrows.map((r) => r.address).filter((w) => !state.done.includes(w));
console.log(`Backfill ${START}..${END} — ${wallets.length} wallets remaining (${state.done.length} done)`);
for (const [i, addr] of wallets.entries()) {
  const t0 = Date.now();
  const { fetched, inserted, pages } = await backfillWallet(addr);
  state.done.push(addr);
  writeFileSync(STATE_FILE, JSON.stringify(state));
  console.log(`[${state.done.length}/${wrows.length}] ${addr.slice(0, 10)}… fetched=${fetched} inserted=${inserted} pages=${pages} ${(Date.now() - t0) / 1000 | 0}s`);
}
console.log('DONE');
await pool.end();
