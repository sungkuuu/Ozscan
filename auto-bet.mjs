// Live-test executor: one small buy per copy signal, or a recorded reason why not.
//
// The signal engine decides *what* to follow; this file only decides whether
// the pre-registered rules allow a $BET_USD order right now and, if so, sends
// it. Every path ends in a row — a fill in copy_signal_fills, or a skip with
// its reason — because a ledger with holes is indistinguishable from a ledger
// that was curated after the fact, and the whole test exists to rule that out.
//
// Modes (AUTO_BET_MODE):
//   unset  — off; the engine only notifies
//   dry    — reads the book and records what it *would* do in copy_signal_dryrun.
//            No key needed, nothing signed.
//   live   — places FAK market buys as the EOA in TRADER_PRIVATE_KEY.
//
// The private key is only ever read from the environment. Nothing here logs,
// stores, or forwards it.

import { createPublicClient, createSecureClient, OrderSide, OrderType } from '@polymarket/client';

// `AssetType` exists only in the type definitions: it is a declared enum that
// the runtime bundle never exports (2026-09-10: importing it stopped the
// engine). The wire value is the plain string.
const COLLATERAL = 'COLLATERAL';

const MODE = process.env.AUTO_BET_MODE || '';
const BET_USD = Number(process.env.BET_USD || 2);          // per signal, equal stakes
const BET_CAP_USD = Number(process.env.BET_CAP_USD || 50); // total open exposure
const WALK_CENTS = Number(process.env.BET_WALK_CENTS || 2); // how far past best ask we accept
const BUILDER_CODE = process.env.POLYMARKET_BUILDER_CODE || undefined;

export async function createAutoBet(pool, notify) {
  if (MODE !== 'dry' && MODE !== 'live') return null;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS copy_signal_fills (
      signal_id  integer PRIMARY KEY REFERENCES copy_signals(id),
      fill_cents numeric,
      usd        numeric,
      note       text,
      filled_at  timestamptz DEFAULT now())`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS copy_signal_dryrun (
      signal_id integer PRIMARY KEY REFERENCES copy_signals(id),
      would_usd numeric, best_ask numeric, max_price numeric, min_order numeric,
      note text, at timestamptz DEFAULT now())`);

  let client, address = null;
  if (MODE === 'live') {
    const key = process.env.TRADER_PRIVATE_KEY;
    if (!key) throw new Error('AUTO_BET_MODE=live but TRADER_PRIVATE_KEY is not set');
    const [{ privateKey }, { privateKeyToAccount }, { polygon }, { http }] = await Promise.all([
      import('@polymarket/client/viem'), import('viem/accounts'), import('viem/chains'), import('viem'),
    ]);
    address = privateKeyToAccount(key).address;
    // `wallet` = the signer itself: trade as a plain EOA. No Deposit Wallet,
    // no relayer, no Polymarket account — only pUSD and a little POL for the
    // one-time approvals. Nothing on polymarket.com has to be touched.
    client = await createSecureClient({
      signer: privateKey(key, { chain: polygon, transport: http(process.env.POLYGON_RPC_URL) }),
      wallet: address,
    });
    await client.setupTradingApprovals();
    const bal = await client.fetchBalanceAllowance({ assetType: COLLATERAL });
    await notify(`auto-bet LIVE as ${address}\ncollateral balance ${JSON.stringify(bal)}\n$${BET_USD} per signal, cap $${BET_CAP_USD}`);
  } else {
    client = createPublicClient();
    await notify(`auto-bet DRY RUN — reading books, signing nothing. $${BET_USD} per signal, cap $${BET_CAP_USD}`);
  }

  const skip = async (signalId, reason, extra = {}) => {
    if (MODE === 'live') {
      await pool.query(`INSERT INTO copy_signal_fills (signal_id, fill_cents, usd, note) VALUES ($1, NULL, NULL, $2)
                        ON CONFLICT (signal_id) DO NOTHING`, [signalId, reason]);
    } else {
      await pool.query(`INSERT INTO copy_signal_dryrun (signal_id, would_usd, best_ask, max_price, min_order, note)
                        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (signal_id) DO NOTHING`,
        [signalId, BET_USD, extra.bestAsk ?? null, extra.maxPrice ?? null, extra.minOrder ?? null, `skip: ${reason}`]);
    }
    await notify(`#${signalId} skip — ${reason}`);
  };

  // Open exposure = every recorded fill whose market has not settled.
  const openExposure = async () => {
    const { rows: [r] } = await pool.query(`
      SELECT COALESCE(SUM(f.usd), 0) AS usd
      FROM copy_signal_fills f
      JOIN copy_signals cs ON cs.id = f.signal_id
      LEFT JOIN market_resolutions r ON r.condition_id = cs.condition_id
      WHERE f.usd IS NOT NULL AND NOT COALESCE(r.closed AND r.winning_outcome IS NOT NULL, false)`);
    return Number(r.usd);
  };

  return async function autoBet(signalId, s, conditionId) {
    const { rows: [done] } = await pool.query(
      `SELECT 1 FROM copy_signal_fills WHERE signal_id = $1 UNION ALL SELECT 1 FROM copy_signal_dryrun WHERE signal_id = $1`, [signalId]);
    if (done) return;

    const { rows: [tok] } = await pool.query(`
      SELECT asset_id FROM smart_alerts
      WHERE condition_id = $1 AND lower(outcome) = lower($2) AND asset_id IS NOT NULL LIMIT 1`, [conditionId, s.outcome]);
    if (!tok) return skip(signalId, 'no token id on the wallet fill');

    // Rule: capital exhausted is a mechanical skip, recorded like any other.
    const exposure = await openExposure();
    if (exposure + BET_USD > BET_CAP_USD) return skip(signalId, `cap: $${exposure.toFixed(2)} open of $${BET_CAP_USD}`);

    let book;
    try { book = await client.fetchOrderBook({ assetId: tok.asset_id }); }
    catch (e) { return skip(signalId, `book unavailable: ${e.message.slice(0, 80)}`); }
    if (!book.asks?.length) return skip(signalId, 'no asks');
    // Asks arrive highest first; the best one is the last.
    const bestAsk = Number(book.asks[book.asks.length - 1].price);
    const maxPrice = Math.min(0.99, bestAsk + WALK_CENTS / 100);
    const minOrder = Number(book.minOrderSize || 0);
    const extra = { bestAsk, maxPrice, minOrder };
    if (minOrder && BET_USD / bestAsk < minOrder) return skip(signalId, `min-order ${minOrder} shares > $${BET_USD} buys ${(BET_USD / bestAsk).toFixed(1)}`, extra);
    if (bestAsk > 0.95) return skip(signalId, `ask ${(bestAsk * 100).toFixed(1)}¢ above the 95¢ grade window`, extra);

    if (MODE === 'dry') {
      await pool.query(`INSERT INTO copy_signal_dryrun (signal_id, would_usd, best_ask, max_price, min_order, note)
                        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (signal_id) DO NOTHING`,
        [signalId, BET_USD, bestAsk, maxPrice, minOrder, 'would buy']);
      return notify(`#${signalId} DRY — would buy $${BET_USD} of "${s.outcome}" at ≤ ${(maxPrice * 100).toFixed(1)}¢ (best ask ${(bestAsk * 100).toFixed(1)}¢, wallet paid ${s.avgPrice}¢)`);
    }

    let res;
    try {
      res = await client.placeMarketOrder({
        assetId: tok.asset_id, side: OrderSide.BUY, amount: BET_USD,
        maxPrice: maxPrice.toFixed(2), orderType: OrderType.FAK, builderCode: BUILDER_CODE,
      });
    } catch (e) { return skip(signalId, `order error: ${e.message.slice(0, 100)}`); }
    if (!res.ok) return skip(signalId, `rejected ${res.code}: ${res.message}`.slice(0, 120));

    const usd = Number(res.makingAmount), shares = Number(res.takingAmount);
    if (!(shares > 0)) return skip(signalId, `${res.status}, nothing filled`);
    const fillCents = Math.round((usd / shares) * 1000) / 10;
    await pool.query(`INSERT INTO copy_signal_fills (signal_id, fill_cents, usd, note) VALUES ($1, $2, $3, $4)
                      ON CONFLICT (signal_id) DO NOTHING`, [signalId, fillCents, usd, `order ${res.orderId}`]);
    await notify(`#${signalId} FILLED — $${usd.toFixed(2)} for ${shares.toFixed(2)} sh of "${s.outcome}" at ${fillCents}¢ (wallet paid ${s.avgPrice}¢, best ask was ${(bestAsk * 100).toFixed(1)}¢)`);
  };
}
