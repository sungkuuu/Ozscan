// Copy-signal engine: which A-grade entries are worth telling a follower about.
//
// The raw feed is unusable as a product — grading showed A wallets alone fire
// tens of fills a day in bursts. Three filters (designed 2026-08-21) turn that
// into a handful of real signals:
//   1. episode merge  — consecutive BUY fills in the same market within 5 min
//                       are one decision, not many
//   2. new entry only — the wallet's prior net exposure in that market must be
//                       ~zero; adding to a position is not a new opinion
//   3. size floor     — the episode must be in that wallet's own top decile;
//                       "large" is relative to the wallet, not an absolute $
//
// Modes:
//   node copy-signal.mjs backtest [days]   — replay history, print what would
//                                            have fired (no side effects)
//   node copy-signal.mjs run               — live loop; posts to Telegram when
//                                            BOT_TOKEN + COPY_CHAT_ID are set,
//                                            logs otherwise. Cursor survives
//                                            restarts via copy_signal_state.
//
// Reads the same DB the frozen collector writes; touches nothing it owns.

import { readFileSync } from 'fs';
import { Pool } from 'pg';

const DB_URL = process.env.DATABASE_URL
  || readFileSync(`${process.env.HOME}/OzScan/backups/.db_url`, 'utf8').trim();
const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

const EPISODE_GAP_S = 300;     // fills closer than this are one episode
const NEW_ENTRY_MAX_USD = 100; // prior net exposure below this counts as "new"
const SIZE_PCTL = 0.90;        // episode must clear the wallet's own p90
const LOOKBACK_DAYS = 60;      // history used for position state and p90
const PRICE_MIN = 5, PRICE_MAX = 95; // same band the grade uses
// Full-coverage polling surfaced a class of A wallets that spray flat ~$400
// bets across dozens of minor-league markets — profitable, but 34 signals a
// day is a feed, not a signal. Conviction needs an absolute floor too.
const SIGNAL_MIN_USD = Number(process.env.SIGNAL_MIN_USD || 1000);

// ---------------------------------------------------------------------------

async function loadFills(sinceTs) {
  const { rows } = await pool.query(`
    SELECT s.address, s.condition_id, s.outcome, s.action, s.size::float, s.price::float,
           s.timestamp::bigint AS ts, s.market, s.slug
    FROM smart_alerts s
    JOIN wallet_grades g ON g.address = s.address
    WHERE g.grade = 'A'
      AND s.outcome IS NOT NULL AND s.size > 0
      AND s.timestamp >= $1
    ORDER BY s.timestamp`, [sinceTs]);
  return rows;
}

// Group one wallet+market+outcome's BUY fills into episodes; track net USD.
function buildEpisodes(fills) {
  const byKey = new Map();
  for (const f of fills) {
    const key = `${f.address}|${f.condition_id}|${(f.outcome || '').toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(f);
  }
  const episodes = [];
  for (const fills of byKey.values()) {
    let netUsd = 0, open = null;
    for (const f of fills) {
      if (f.action === 'BUY') {
        if (open && f.ts - open.lastTs <= EPISODE_GAP_S) {
          open.sizeUsd += f.size;
          open.lastTs = f.ts;
          open.prices.push(f.price);
        } else {
          if (open) episodes.push(open);
          open = {
            address: f.address, condition_id: f.condition_id, outcome: f.outcome,
            market: f.market, slug: f.slug,
            startTs: f.ts, lastTs: f.ts, sizeUsd: f.size, prices: [f.price],
            preNetUsd: netUsd,
          };
        }
        netUsd += f.size;
      } else { // SELL closes exposure; approximation in USD terms
        netUsd -= f.size;
        if (open) { episodes.push(open); open = null; }
      }
    }
    if (open) episodes.push(open);
  }
  return episodes.sort((a, b) => a.startTs - b.startTs);
}

function p90(sorted) {
  if (!sorted.length) return Infinity;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * SIZE_PCTL))];
}

// The three filters. `thresholds` maps address -> p90 episode size.
function signalOf(ep, thresholds) {
  const avgPrice = ep.prices.reduce((s, p) => s + p, 0) / ep.prices.length;
  if (avgPrice < PRICE_MIN || avgPrice > PRICE_MAX) return null;
  if (ep.preNetUsd > NEW_ENTRY_MAX_USD) return null;            // not a new opinion
  const floor = thresholds.get(ep.address) ?? Infinity;
  if (ep.sizeUsd < floor) return null;                          // small for this wallet
  if (ep.sizeUsd < SIGNAL_MIN_USD) return null;                 // small in absolute terms
  return {
    ts: ep.startTs, address: ep.address, market: ep.market, slug: ep.slug,
    outcome: ep.outcome, avgPrice: Math.round(avgPrice * 10) / 10,
    sizeUsd: Math.round(ep.sizeUsd), walletP90: Math.round(floor),
  };
}

function computeThresholds(episodes) {
  const sizes = new Map();
  for (const ep of episodes) {
    if (!sizes.has(ep.address)) sizes.set(ep.address, []);
    sizes.get(ep.address).push(ep.sizeUsd);
  }
  const t = new Map();
  for (const [addr, arr] of sizes) t.set(addr, p90(arr.sort((a, b) => a - b)));
  return t;
}


// --- live poller ------------------------------------------------------------
// The frozen collector only sees wallets in its own live set; most A wallets
// entered the universe by backfill and go stale the moment a backfill run
// ends (measured 2026-09-03: 37 of 38 idle ~8.6d — the run boundary, not the
// wallets). This tops up A-wallet fills from the activity API using the exact
// row mapping and conflict key expand-universe.mjs uses, marked with its own
// collector_version so provenance stays auditable. Local IPs are banned by
// Polymarket — this only works from Railway or an Actions runner.

const POLL_VERSION = 'copy-poll-v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadAList() {
  const { rows } = await pool.query(`SELECT address FROM wallet_grades WHERE grade='A'`);
  return rows.map((r) => r.address);
}

async function pollWallet(addr, sinceTs) {
  const url = `https://data-api.polymarket.com/activity?user=${addr}&limit=100&start=${sinceTs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const acts = await res.json();
  if (!Array.isArray(acts) || !acts.length) return 0;
  const rows = []; const seen = new Set();
  for (const a of acts) {
    const type = (a.type || '').toUpperCase();
    if (['REWARD', 'REDEEM', 'MERGE', 'SPLIT'].includes(type)) continue;
    const rawTs = a.timestamp || 0;
    const ts = typeof rawTs === 'number' ? (rawTs > 1e12 ? Math.floor(rawTs / 1000) : rawTs) : Math.floor(new Date(rawTs).getTime() / 1000);
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
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const cols = 14;
    const values = chunk.map((_, j) => `(${Array.from({ length: cols }, (_, k) => `$${j * cols + k + 1}`).join(',')},'${POLL_VERSION}','p1')`);
    const r = await pool.query(
      `INSERT INTO smart_alerts (trade_id, address, market, side, size, price, condition_id, slug, event_slug, timestamp, action, outcome, asset_id, transaction_hash, collector_version, parser_version)
       VALUES ${values.join(',')} ON CONFLICT (trade_id) DO NOTHING`, chunk.flat());
    inserted += r.rowCount;
  }
  return inserted;
}

async function pollSweep(wallets, sinceTs) {
  let total = 0, errors = 0;
  for (const addr of wallets) {
    try { total += await pollWallet(addr, sinceTs); }
    catch { errors++; }
    await sleep(300);
  }
  return { total, errors };
}
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmtTs = (ts) => new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ');

function fmtSignal(s) {
  return [
    `🟢 A-grade entry — ${short(s.address)}`,
    `${s.market || s.slug}`,
    `${s.outcome} @ ${s.avgPrice}¢ · $${s.sizeUsd.toLocaleString()} (wallet p90 $${s.walletP90.toLocaleString()})`,
    `polymarket.com/market/${s.slug}`,
    `Grade basis: assayscore.com/evidence — settled outcomes, not advice.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------

async function backtest(days) {
  const now = Math.floor(Date.now() / 1000);
  const since = now - (days + LOOKBACK_DAYS) * 86400;
  const cut = now - days * 86400;
  const fills = await loadFills(since);
  const episodes = buildEpisodes(fills);
  // thresholds from the lookback period only — no peeking at the test window
  const thresholds = computeThresholds(episodes.filter((e) => e.startTs < cut));
  const windowEps = episodes.filter((e) => e.startTs >= cut);
  const signals = windowEps.map((e) => signalOf(e, thresholds)).filter(Boolean);

  console.log(`창: ${days}일 | A지갑 체결 ${fills.filter((f) => f.ts >= cut).length}건 → 에피소드 ${windowEps.length} → 신호 ${signals.length}`);
  const perDay = new Map();
  for (const s of signals) {
    const d = new Date(s.ts * 1000).toISOString().slice(0, 10);
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  for (const [d, n] of [...perDay].sort()) console.log(`  ${d}: ${n}건`);
  console.log('');
  for (const s of signals) {
    console.log(`[${fmtTs(s.ts)}] ${short(s.address)} ${s.outcome} @${s.avgPrice}¢ $${s.sizeUsd.toLocaleString()}  ${(s.market || s.slug || '').slice(0, 60)}`);
  }
  await pool.end();
}

async function run() {
  await pool.query(`CREATE TABLE IF NOT EXISTS copy_signal_state (k TEXT PRIMARY KEY, v TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS copy_signals (
    id SERIAL PRIMARY KEY, ts BIGINT, address TEXT, condition_id TEXT, outcome TEXT,
    market TEXT, slug TEXT, avg_price NUMERIC, size_usd NUMERIC, wallet_p90 NUMERIC,
    created_at TIMESTAMPTZ DEFAULT now())`);

  const bot = process.env.BOT_TOKEN && process.env.COPY_CHAT_ID
    ? new (await import('node-telegram-bot-api')).default(process.env.BOT_TOKEN)
    : null;

  // Warm position state and thresholds from the lookback window.
  const now = Math.floor(Date.now() / 1000);
  let fills = await loadFills(now - LOOKBACK_DAYS * 86400);
  let episodes = buildEpisodes(fills);
  let thresholds = computeThresholds(episodes);
  const { rows: [cur] } = await pool.query(`SELECT v FROM copy_signal_state WHERE k='last_ts'`);
  let lastTs = cur ? Number(cur.v) : now;
  let aList = await loadAList();
  let tick = 0;

  console.log(`live: ${aList.size ?? aList.length} A wallets, thresholds for ${thresholds.size}, cursor ${fmtTs(lastTs)}`);
  for (;;) {
    try {
      // sweep the activity API every ~60s; refresh the A list every ~10 min
      if (tick % 6 === 0) {
        const sw = await pollSweep(aList, Math.floor(Date.now() / 1000) - 7200);
        if (sw.total || sw.errors) console.log(`poll: +${sw.total} fills, ${sw.errors} errors`);
      }
      if (tick % 60 === 59) aList = await loadAList();
      const fresh = await loadFills(lastTs - EPISODE_GAP_S * 2); // overlap for episode merging
      const eps = buildEpisodes(fresh).filter((e) => e.startTs > lastTs);
      for (const ep of eps) {
        const s = signalOf(ep, thresholds);
        lastTs = Math.max(lastTs, ep.startTs);
        if (!s) continue;
        await pool.query(
          `INSERT INTO copy_signals (ts,address,condition_id,outcome,market,slug,avg_price,size_usd,wallet_p90)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [s.ts, s.address, ep.condition_id, s.outcome, s.market, s.slug, s.avgPrice, s.sizeUsd, s.walletP90]);
        const text = fmtSignal(s);
        if (bot) await bot.sendMessage(process.env.COPY_CHAT_ID, text, { disable_web_page_preview: true });
        else console.log('\n' + text);
      }
      await pool.query(
        `INSERT INTO copy_signal_state (k,v) VALUES ('last_ts',$1)
         ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [String(lastTs)]);
    } catch (e) {
      console.error('cycle error:', e.message);
    }
    tick++;
    await sleep(10_000);
  }
}

// One poll sweep and exit — for testing from an Actions runner (local IPs are banned).
async function pollOnce() {
  const aList = await loadAList();
  const sw = await pollSweep(aList, Math.floor(Date.now() / 1000) - 86400);
  const { rows: [f] } = await pool.query(
    `SELECT count(*) n, ROUND(EXTRACT(EPOCH FROM now())-MAX(timestamp)) age_s
     FROM smart_alerts WHERE collector_version=$1`, ['copy-poll-v1']);
  console.log(`pollonce: ${aList.length} wallets swept, +${sw.total} fills inserted, ${sw.errors} errors`);
  console.log(`copy-poll rows total: ${f.n}, newest fill ${f.age_s}s ago`);
  await pool.end();
}

const isCli = (process.argv[1] || '').includes('copy-signal');
const [modeArg, arg] = process.argv.slice(2);
const mode = modeArg || process.env.MODE; // data-job.yml passes MODE (it runs scripts without args)
if (isCli && mode === 'backtest') await backtest(Number(arg) || 7);
else if (isCli && mode === 'run') await run();
else if (isCli && mode === 'pollonce') await pollOnce();
else if (!isCli && process.env.COPY_SIGNALS_ENABLED === 'true') run(); // imported by the worker
else if (isCli) { console.log('usage: node copy-signal.mjs backtest [days] | run | pollonce'); await pool.end(); }
