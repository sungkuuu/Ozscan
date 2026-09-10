// Execution ledger for the live test.
//
// The point of putting real money behind the feed is not the P&L — it is the
// one number no history can give us: what a signal actually filled at, versus
// the last-traded price a minute after it (copy_signal_followprice.px_60).
// Every signal acted on gets a row here, wins and losses alike; a ledger that
// only records the ones that worked is the highlight reel this site exists to
// call out.
//
//   node ledger.mjs <signal_id> <fill_cents> <usd> [note]   record a fill
//   node ledger.mjs skip <signal_id> [reason]               record a deliberate pass
//   node ledger.mjs report                                  fills vs px_60, realised P&L

import pg from 'pg';
import { readFileSync } from 'fs';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    || readFileSync(`${process.env.HOME}/OzScan/backups/.db_url`, 'utf8').trim(),
  ssl: { rejectUnauthorized: false },
});
await pool.query(`
  CREATE TABLE IF NOT EXISTS copy_signal_fills (
    signal_id  integer PRIMARY KEY REFERENCES copy_signals(id),
    fill_cents numeric,          -- null = skipped on purpose
    usd        numeric,
    note       text,
    filled_at  timestamptz DEFAULT now()
  )`);

const [a, b, c, ...rest] = process.argv.slice(2);

if (a === 'report') {
  const { rows } = await pool.query(`
    SELECT cs.id, to_char(to_timestamp(cs.ts), 'MM-DD HH24:MI') t, left(cs.market, 34) m, cs.outcome,
           l.fill_cents, l.usd, f.px_60, cs.avg_price wallet_px,
           CASE WHEN r.closed AND r.winning_outcome IS NOT NULL
                THEN lower(regexp_replace(cs.outcome,'[^a-z0-9]','','gi'))
                   = lower(regexp_replace(r.winning_outcome,'[^a-z0-9]','','gi')) END won
    FROM copy_signal_fills l
    JOIN copy_signals cs ON cs.id = l.signal_id
    LEFT JOIN copy_signal_followprice f ON f.signal_id = cs.id
    LEFT JOIN market_resolutions r ON r.condition_id = cs.condition_id
    ORDER BY cs.ts`);
  const acted = rows.filter((r) => r.fill_cents != null);
  console.log(`${rows.length} rows, ${acted.length} filled, ${rows.length - acted.length} skipped`);
  for (const r of rows) {
    const gap = r.fill_cents != null && r.px_60 != null ? (Number(r.fill_cents) - Number(r.px_60)).toFixed(1) : '—';
    console.log(`#${r.id} ${r.t} ${r.m.padEnd(34)} ${String(r.outcome).slice(0, 12).padEnd(12)} fill ${r.fill_cents ?? 'skip'}¢ px60 ${r.px_60 ?? '—'} gap ${gap} $${r.usd ?? ''} ${r.won == null ? 'open' : r.won ? 'W' : 'L'}`);
  }
  const gaps = acted.filter((r) => r.px_60 != null).map((r) => Number(r.fill_cents) - Number(r.px_60));
  if (gaps.length) {
    gaps.sort((x, y) => x - y);
    console.log(`\nfill − px_60 (¢): n=${gaps.length} median ${gaps[Math.floor(gaps.length / 2)].toFixed(1)} mean ${(gaps.reduce((x, y) => x + y, 0) / gaps.length).toFixed(1)}`);
  }
  const settled = acted.filter((r) => r.won != null);
  if (settled.length) {
    const pnl = settled.reduce((s, r) => s + (r.won ? Number(r.usd) * (100 - Number(r.fill_cents)) / Number(r.fill_cents) : -Number(r.usd)), 0);
    const stake = settled.reduce((s, r) => s + Number(r.usd), 0);
    console.log(`settled ${settled.length}: ${settled.filter((r) => r.won).length} won, P&L $${pnl.toFixed(2)} on $${stake.toFixed(2)} staked (${(100 * pnl / stake).toFixed(1)}%)`);
  }
} else if (a === 'skip' && b) {
  await pool.query(`INSERT INTO copy_signal_fills (signal_id, fill_cents, usd, note) VALUES ($1, NULL, NULL, $2)
                    ON CONFLICT (signal_id) DO UPDATE SET fill_cents = NULL, usd = NULL, note = EXCLUDED.note`, [Number(b), [c, ...rest].filter(Boolean).join(' ') || null]);
  console.log(`signal ${b}: skipped`);
} else if (a && b && c) {
  await pool.query(`INSERT INTO copy_signal_fills (signal_id, fill_cents, usd, note) VALUES ($1, $2, $3, $4)
                    ON CONFLICT (signal_id) DO UPDATE SET fill_cents = EXCLUDED.fill_cents, usd = EXCLUDED.usd, note = EXCLUDED.note, filled_at = now()`,
    [Number(a), Number(b), Number(c), rest.join(' ') || null]);
  console.log(`signal ${a}: filled at ${b}¢ for $${c}`);
} else {
  console.log('usage: node ledger.mjs <signal_id> <fill_cents> <usd> [note] | skip <signal_id> [reason] | report');
}
await pool.end();
