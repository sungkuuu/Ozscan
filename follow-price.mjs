// What price could a follower actually get?
//
// The signals table records the price the A-grade wallet paid. That is not the
// price someone reading the feed can buy at: the fill has already moved the
// book, and the reader arrives seconds to minutes later. Every published return
// so far is computed at the wallet's price, which flatters the feed by an
// unknown amount — this script measures that amount instead of assuming it.
//
// Our own trade feed cannot answer it (it only watches graded wallets, and for
// all 41 settled signals there was no other wallet in the feed trading that
// market afterwards). So this reads the CLOB's own price history around each
// signal. Polymarket blocks the office IP, so run it on a runner:
//   gh workflow run data-job.yml -f script=follow-price.mjs
// and .github/workflows/follow-price.yml runs it every six hours.
//
// Writes one row per signal into copy_signal_followprice; re-running updates.

import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const OFFSETS = [60, 300, 900, 3600];   // +1m, +5m, +15m, +1h
const PACE_MS = Number(process.env.PACE_MS || 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function history(tokenId, startTs, endTs) {
  const url = `https://clob.polymarket.com/prices-history?market=${tokenId}`
    + `&startTs=${startTs}&endTs=${endTs}&fidelity=1`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const body = await res.json();
  return (body.history || []).map((h) => ({ t: Number(h.t), p: Number(h.p) }));
}

// First quote at or after the target instant. A gap means nothing traded, which
// is itself the answer for that offset — leave it null rather than guessing.
function priceAt(hist, target) {
  const after = hist.filter((h) => h.t >= target);
  return after.length ? after[0] : null;
}

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS copy_signal_followprice (
      signal_id   integer PRIMARY KEY,
      token_id    text,
      wallet_px   numeric,
      px_60       numeric,
      px_300      numeric,
      px_900      numeric,
      px_3600     numeric,
      n_points    integer,
      measured_at timestamptz DEFAULT now()
    )`);

  // Every signal at least 70 minutes old that has not been measured yet. The
  // CLOB history is permanent, so measuring before settlement is fine — and
  // necessary: the live test compares real fills against px_60 while the
  // market is still open, and the scoreboard scores whatever settles later.
  const { rows: signals } = await pool.query(`
    SELECT cs.id, cs.ts, cs.address, cs.condition_id, cs.outcome, cs.avg_price
    FROM copy_signals cs
    LEFT JOIN copy_signal_followprice f ON f.signal_id = cs.id
    WHERE f.signal_id IS NULL AND cs.ts <= EXTRACT(EPOCH FROM now()) - 4200
    ORDER BY cs.ts`);

  console.log(`${signals.length} signals to measure`);
  let done = 0, missing = 0;

  for (const s of signals) {
    // The outcome's CLOB token id is on the wallet's own fill.
    const { rows: [fill] } = await pool.query(`
      SELECT asset_id FROM smart_alerts
      WHERE condition_id = $1 AND lower(outcome) = lower($2) AND asset_id IS NOT NULL
      LIMIT 1`, [s.condition_id, s.outcome]);
    if (!fill) { missing++; continue; }

    const ts = Number(s.ts);
    let hist;
    try {
      hist = await history(fill.asset_id, ts - 120, ts + 4200);
    } catch (e) {
      console.error(`signal ${s.id}: ${e.message}`);
      await sleep(2000);
      continue;
    }

    const at = OFFSETS.map((o) => priceAt(hist, ts + o));
    await pool.query(`
      INSERT INTO copy_signal_followprice
        (signal_id, token_id, wallet_px, px_60, px_300, px_900, px_3600, n_points)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (signal_id) DO UPDATE SET
        px_60=EXCLUDED.px_60, px_300=EXCLUDED.px_300, px_900=EXCLUDED.px_900,
        px_3600=EXCLUDED.px_3600, n_points=EXCLUDED.n_points, measured_at=now()`,
      [s.id, fill.asset_id, s.avg_price,
       ...at.map((h) => (h ? h.p * 100 : null)), hist.length]);

    done++;
    if (done % 10 === 0) console.log(`  ${done}/${signals.length}`);
    await sleep(PACE_MS);
  }

  console.log(`measured ${done}, no token id ${missing}`);

  const { rows: [sum] } = await pool.query(`
    SELECT count(*) n,
           count(px_300) has_300,
           ROUND(AVG(wallet_px), 1) avg_wallet,
           ROUND(AVG(px_60), 1)  avg_60,
           ROUND(AVG(px_300), 1) avg_300,
           ROUND(AVG(px_3600), 1) avg_3600
    FROM copy_signal_followprice`);
  console.log(sum);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
