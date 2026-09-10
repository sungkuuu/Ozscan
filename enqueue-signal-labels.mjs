// Queues every copy-signal market that still needs a settlement label, so the
// live record cannot silently stall the way it did on 2026-09-10 — when 30
// signal markets sat unlabeled and the live column read "nothing settled"
// while a dozen of them had already resolved. resolution-backfill.mjs drains
// the queue right after this on the same runner.

import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const { rows } = await pool.query(`
  INSERT INTO label_queue (condition_id)
  SELECT DISTINCT cs.condition_id
  FROM copy_signals cs
  LEFT JOIN market_resolutions r ON r.condition_id = cs.condition_id
  WHERE cs.condition_id ~ '^0x[0-9a-fA-F]{64}$'
    AND (r.condition_id IS NULL
         OR (NOT COALESCE(r.closed, false)
             AND (r.end_date IS NULL OR r.end_date::timestamptz < now())))
  ON CONFLICT DO NOTHING
  RETURNING condition_id`);

console.log(`queued ${rows.length} signal markets for labeling`);
await pool.end();
