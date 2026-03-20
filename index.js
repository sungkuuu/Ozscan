require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const fetch = require('node-fetch');

const PORT = process.env.PORT || 3000;
const TRADES_URL = 'https://clob.polymarket.com/trades?limit=100&size_threshold=1000';
const TRADES_URL_FALLBACK = 'https://data-api.polymarket.com/trades?limit=50';
const WHALE_SIZE_USDC = 2000;
const POLL_INTERVAL_MS = 60 * 1000;

const app = express();

app.use(express.static('public'));

// PostgreSQL connection
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

// Trade IDs we've already sent an alert for (avoid duplicates)
const alertedTradeIds = new Set();

setInterval(() => {
  alertedTradeIds.clear();
  console.log('[Whale] Cleared alerted trade IDs cache');
}, 60 * 60 * 1000);

/**
 * Fetch recent trades from Polymarket CLOB.
 * @returns {Promise<Array>} Array of recent trades
 */
async function fetchPolymarketTrades() {
  console.log('[Polymarket] Fetching trades...');
  const headers = {};
  if (process.env.POLYMARKET_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.POLYMARKET_API_KEY}`;
  }
  let res = await fetch(TRADES_URL, { headers });
  if (!res.ok && res.status === 401) {
    res = await fetch(TRADES_URL_FALLBACK);
  }
  console.log('[Polymarket] Response status:', res.status);
  if (!res.ok) {
    throw new Error(`Polymarket trades API error: ${res.status}`);
  }
  const data = await res.json();
  const trades = Array.isArray(data) ? data : [];
  console.log('[Polymarket] Trades count:', trades.length);
  console.log('[Polymarket] Sample trade fields:', JSON.stringify(trades[0], null, 2));
  return trades;
}

async function ensureSmartMoneyWalletsTable() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS smart_money_wallets (
      id SERIAL PRIMARY KEY,
      address TEXT UNIQUE NOT NULL,
      label TEXT,
      total_profit NUMERIC DEFAULT 0,
      win_rate NUMERIC DEFAULT 0,
      trade_count INTEGER DEFAULT 0,
      last_updated TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function fetchKalshiMarkets() {
  try {
    console.log('[Kalshi] Fetching markets...');
    const res = await fetch('https://api.elections.kalshi.com/trade-api/v2/markets?limit=100');
    console.log('[Kalshi] Response status:', res.status);
    const data = await res.json();
    const markets = data.markets || [];
    console.log('[Kalshi] Markets count:', markets.length);
    if (markets[0]) console.log('[Kalshi] Sample:', JSON.stringify(markets[0], null, 2));
  } catch(e) {
    console.error('[Kalshi] Error:', e.message);
    console.error('[Kalshi] Error stack:', e.stack);
  }
}

async function fetchKalshiOdds() {
  try {
    const res = await fetch('https://api.elections.kalshi.com/trade-api/v2/markets?limit=100&status=open');
    if (!res.ok) {
      console.error('[Arb] Kalshi odds error status:', res.status);
      return [];
    }
    const data = await res.json();
    const markets = data.markets || [];
    console.log('[Arb] Kalshi raw market sample:', JSON.stringify(markets[0]));
    console.log('[Arb] Kalshi total markets before filter:', markets.length);
    const kalshiOdds = markets
      .filter((m) => {
        const title = m.title || m.question || '';
        const commaCount = (title.match(/,/g) || []).length;
        return commaCount <= 3;
      })
      .filter(
        (m) =>
          m.yes_ask_dollars !== '0.0000' && m.yes_ask_dollars !== '1.0000'
      )
      .map((m) => ({
        ticker: m.ticker,
        title: m.title || m.name || '',
        yesPrice: parseFloat(m.yes_ask_dollars),
      }))
      .filter((m) => m.title && !Number.isNaN(m.yesPrice) && m.yesPrice > 0 && m.yesPrice < 1);
    console.log('[Arb] Kalshi sample item:', JSON.stringify(kalshiOdds[0]));
    return kalshiOdds;
  } catch (e) {
    console.error('[Arb] Kalshi odds error:', e.message);
    return [];
  }
}

async function fetchPolymarketOdds() {
  try {
    const res = await fetch('https://clob.polymarket.com/markets?limit=100');
    if (!res.ok) {
      console.error('[Arb] Polymarket odds error status:', res.status);
      return [];
    }
    const data = await res.json();
    const markets = data.data || (Array.isArray(data) ? data : []);

    console.log('[Arb] Polymarket markets:', markets.length);

    const polyOdds = markets
      .map(m => {
        const price = parseFloat(m.tokens?.[0]?.price ?? 0);
        return { slug: m.condition_id || '', question: m.question || '', price };
      })
      .filter(m => m.question && m.price > 0.01 && m.price < 0.99);
    console.log('[Arb] Polymarket sample item:', JSON.stringify(polyOdds[0]));
    return polyOdds;
  } catch (e) {
    console.error('[Arb] Polymarket odds error:', e.message);
    return [];
  }
}

async function fetchPolymarketTopMarketsForOdds() {
  // Try clob API first, fall back to gamma-api
  let markets = [];
  try {
    const res = await fetch('https://clob.polymarket.com/markets?limit=100');
    if (res.ok) {
      const data = await res.json();
      markets = data.data || (Array.isArray(data) ? data : []);
      console.log('[Odds] clob API returned', markets.length, 'markets');
    } else {
      console.warn('[Odds] clob API status:', res.status, '— falling back to gamma-api');
    }
  } catch (e) {
    console.warn('[Odds] clob API failed:', e.message, '— falling back to gamma-api');
  }

  if (markets.length === 0) {
    try {
      const res = await fetch('https://gamma-api.polymarket.com/markets?limit=100&active=true');
      if (!res.ok) throw new Error(`gamma-api status: ${res.status}`);
      const data = await res.json();
      markets = Array.isArray(data) ? data : [];
      console.log('[Odds] gamma-api returned', markets.length, 'markets');
    } catch (e) {
      console.error('[Odds] gamma-api also failed:', e.message);
      return [];
    }
  }

  const result = markets
    .map((m) => {
      const price = parseFloat(m.tokens?.[0]?.price ?? m.outcomePrices?.[0] ?? m.price ?? 0);
      return {
        market_id: m.condition_id || m.conditionId || m.id || m.slug || '',
        question: m.question || m.title || '',
        price,
      };
    })
    .filter((m) => m.market_id && m.question && m.price > 0 && m.price < 1);
  console.log('[Odds] Parsed', result.length, 'valid markets for snapshots');
  return result;
}

async function ensureOddsSnapshotsTable() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS odds_snapshots (
      id SERIAL PRIMARY KEY,
      market_id TEXT,
      question TEXT,
      price NUMERIC,
      recorded_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function runOddsMovementDetection() {
  if (!pool) return;
  try {
    const current = await fetchPolymarketTopMarketsForOdds();
    if (current.length === 0) {
      console.warn('[Odds] No markets fetched — skipping snapshot');
      return;
    }

    // Save snapshots
    const values = [];
    const params = [];
    let i = 1;
    for (const m of current) {
      values.push(`($${i++}, $${i++}, $${i++})`);
      params.push(m.market_id, m.question, m.price);
    }
    await pool.query(
      `INSERT INTO odds_snapshots (market_id, question, price) VALUES ${values.join(', ')}`,
      params
    );
    console.log(`[Odds] Saved ${current.length} snapshots`);

    // Fetch previous snapshots ~30 minutes ago (latest snapshot at or before that point)
    const marketIds = current.map((m) => m.market_id);
    const prevResult = await pool.query(
      `
      SELECT DISTINCT ON (market_id)
        market_id,
        price
      FROM odds_snapshots
      WHERE recorded_at <= NOW() - INTERVAL '30 minutes'
        AND market_id = ANY($1)
      ORDER BY market_id, recorded_at DESC
    `,
      [marketIds]
    );
    const prevMap = new Map(prevResult.rows.map((r) => [r.market_id, parseFloat(r.price)]));

    for (const m of current) {
      const prev = prevMap.get(m.market_id);
      if (typeof prev !== 'number' || Number.isNaN(prev)) continue;
      const move = m.price - prev;
      if (Math.abs(move) < 0.10) continue;

      if (bot && process.env.ADMIN_CHAT_ID) {
        const sign = move >= 0 ? '+' : '-';
        const msg = [
          '⚡ ODDS SPIKE',
          `${m.question}`,
          `${(prev * 100).toFixed(0)}% → ${(m.price * 100).toFixed(0)}%`,
          `Move: ${sign}${(Math.abs(move) * 100).toFixed(0)}%`,
          'ozscan.xyz',
        ].join('\n');
        try {
          await bot.sendMessage(process.env.ADMIN_CHAT_ID, msg);
        } catch (e) {
          console.error('[Odds] Telegram send failed:', e.message);
        }
      }
    }
  } catch (e) {
    console.error('[Odds] Movement detection error:', e.message);
  }
}

function keywordScore(a, b) {
  const aw = a.toLowerCase().split(/\W+/).filter(Boolean);
  const bw = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  let score = 0;
  for (const w of aw) {
    if (bw.has(w)) score += 1;
  }
  return score;
}

async function detectArbitrage() {
  console.log('[Arb] Starting arbitrage detection...');
  try {
    const [kalshiOdds, polyOdds] = await Promise.all([
      fetchKalshiOdds(),
      fetchPolymarketOdds(),
    ]);
    console.log(
      '[Arb] Kalshi count:',
      kalshiOdds.length,
      'Polymarket count:',
      polyOdds.length
    );

    console.log('[Arb] Kalshi sample:', JSON.stringify(kalshiOdds[0]));
    console.log('[Arb] Polymarket sample:', JSON.stringify(polyOdds[0]));

    for (const k of kalshiOdds) {
      for (const p of polyOdds) {
        const kWords = k.title.toLowerCase().split(/\s+/);
        const pWords = p.question.toLowerCase().split(/\s+/);
        const shared = kWords.filter(w => w.length > 4 && pWords.includes(w));
        if (shared.length >= 2) {
          console.log('[Arb] Match found:', k.title, '<=>', p.question, 'gap:', Math.abs(k.yesPrice - p.price).toFixed(2));
        }
      }
    }

    for (const k of kalshiOdds) {
      let best = null;
      let bestScore = 0;
      for (const p of polyOdds) {
        const s = keywordScore(k.title, p.question);
        if (s > bestScore) {
          bestScore = s;
          best = p;
        }
      }
      if (!best || bestScore < 3) continue;

      const polyPrice = best.price;
      const kalshiPrice = k.yesPrice;
      const gap = Math.abs(polyPrice - kalshiPrice);
      if (gap <= 0.05) continue;

      const lowerPlatform = polyPrice < kalshiPrice ? 'Polymarket' : 'Kalshi';
      const higherPlatform = polyPrice > kalshiPrice ? 'Polymarket' : 'Kalshi';
      // Arbitrage Telegram alerts disabled
    }
  } catch (e) {
    console.error('[Arb] Fatal error:', e.message, e.stack);
  }
}

/**
 * Filter trades where USDC value (size * price) >= threshold.
 * Polymarket size is in shares; real USDC = size * price.
 * @param {Array} trades - Raw trade objects from API
 * @returns {Array<{ tradeId: string, market: string, side: string, size: number, price: number, timestamp: number }>}
 */
function detectWhales(trades) {
  const whaleTrades = [];
  for (const t of trades) {
    console.log('[Polymarket] Checking trade size:', t.size || t.usdcSize);
    const usdcValue = parseFloat(t.size) * parseFloat(t.price);
    console.log('[Polymarket] USDC value:', usdcValue.toFixed(2));
    if (Number.isNaN(usdcValue)) continue;
    if (usdcValue < WHALE_SIZE_USDC) continue; // whale threshold $5K

    const size = parseFloat(t.size);
    const price = parseFloat(t.price);
    const tradeId =
      t.transactionHash ||
      t.id ||
      `${t.conditionId || t.asset || 'unknown'}-${t.timestamp}-${size}-${price}`;
    const market = t.title || t.slug || t.conditionId || t.asset || 'Unknown market';
    const side = (t.outcome || t.side || '').toUpperCase();
    const proxyWallet = t.proxyWallet;

    const conditionId = t.conditionId || t.condition_id || null;
    const slug = t.slug || null;

    const whale = {
      tradeId,
      market: String(market),
      side: side === 'BUY' ? 'YES' : side === 'SELL' ? 'NO' : side || '—',
      size: usdcValue,
      price: price * 100,
      timestamp: Number(t.timestamp) || 0,
      proxyWallet: proxyWallet || null,
      conditionId,
      slug,
    };
    console.log('[Whale] Detected:', JSON.stringify(whale));
    whaleTrades.push(whale);
  }
  return whaleTrades;
}

/**
 * Ensure whale_trades table exists.
 */
async function ensureWhaleTradesTable() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whale_trades (
      id SERIAL PRIMARY KEY,
      trade_id TEXT UNIQUE NOT NULL,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      size NUMERIC NOT NULL,
      price NUMERIC NOT NULL,
      timestamp BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Store a whale trade in the database.
 */
async function storeWhaleTrade(whale) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO whale_trades (trade_id, market, side, size, price, timestamp, proxy_wallet, condition_id, slug)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (trade_id) DO NOTHING`,
      [
        whale.tradeId,
        whale.market,
        whale.side,
        whale.size,
        whale.price,
        whale.timestamp,
        whale.proxyWallet,
        whale.conditionId,
        whale.slug,
      ]
    );
  } catch (err) {
    console.error('Failed to store whale trade:', err.message);
  }
}

/**
 * Run one whale-detection cycle: fetch trades, detect whales, alert and store.
 */
async function runWhaleDetection() {
  try {
    const trades = await fetchPolymarketTrades();
    const whales = detectWhales(trades);

    const walletMap = {};
    for (const t of trades) {
      const w = t.proxyWallet;
      if (!w) continue;
      if (!walletMap[w]) walletMap[w] = { count: 0, totalUsdc: 0, markets: [], pseudonym: t.pseudonym || '' };
      const uv = parseFloat(t.size) * parseFloat(t.price);
      walletMap[w].count++;
      walletMap[w].totalUsdc += uv;
      walletMap[w].markets.push(t.title);
    }

    for (const [wallet, data] of Object.entries(walletMap)) {
      const uniqueMarkets = new Set(data.markets).size;
      if (data.count >= 3 && data.totalUsdc >= 500 && uniqueMarkets <= 5) {
        console.log('[SmartMoney] Detected:', wallet, data.count, data.totalUsdc);
        if (bot && process.env.ADMIN_CHAT_ID) {
          const msg = `🧠 SMART MONEY — Polymarket\n\nWallet: ${wallet.slice(0,8)}... (${data.pseudonym})\nBets: ${data.count} trades\nTotal: $${data.totalUsdc.toFixed(0)} USDC\nMarkets: ${[...new Set(data.markets)].slice(0,3).join(', ')}\n\nozscan.xyz`;
          try {
            await bot.sendMessage(process.env.ADMIN_CHAT_ID, msg);
          } catch (err) {
            console.error('Telegram send failed:', err.message);
          }
        }
      }
    }

    for (const w of whales) {
      if (alertedTradeIds.has(w.tradeId)) continue;
      alertedTradeIds.add(w.tradeId);

      await storeWhaleTrade(w);

      if (bot && process.env.ADMIN_CHAT_ID) {
        const text = [
          '🐋 WHALE ALERT — Polymarket',
          '',
          `Market: ${w.market}`,
          `Side: ${w.side}`,
          `Amount: $${w.size.toFixed(0)} USDC`,
          `Price: ${w.price.toFixed(1)}%`,
          '',
          'ozscan.xyz',
        ].join('\n');
        try {
          await bot.sendMessage(process.env.ADMIN_CHAT_ID, text);
        } catch (err) {
          console.error('Telegram send failed:', err.message);
        }
      }
    }
  } catch (e) {
    console.error('[Polymarket] Error:', e.message);
  }
}

function guessConditionIdFromTrade(trade) {
  // Polymarket trade objects vary; we store `market` as a string derived from API fields.
  // For resolution we need a conditionId suitable for:
  //   https://clob.polymarket.com/markets/{conditionId}
  const side = String(trade?.market || '');
  const tId = String(trade?.trade_id || '');

  // Condition IDs are typically 0x-prefixed hex.
  const condFromMarket = side.match(/0x[a-fA-F0-9]{10,}/)?.[0];
  if (condFromMarket) return condFromMarket;

  // Fallback: sometimes our derived trade_id embeds conditionId as the first segment.
  const firstSeg = tId.split('-')[0];
  const condFromTradeId = firstSeg.match(/0x[a-fA-F0-9]{10,}/)?.[0] || firstSeg;
  if (condFromTradeId && condFromTradeId.length > 10) return condFromTradeId;

  // Last resort: hope `market` already is conditionId.
  return trade?.market || null;
}

async function checkResolvedTrades() {
  if (!pool) return;
  try {
    const unresolved = await pool.query(
      `SELECT * FROM whale_trades WHERE resolved = FALSE OR resolved IS NULL`
    );
    const trades = unresolved.rows || [];
    if (trades.length === 0) return;

    console.log('[Resolve] Checking unresolved trades:', trades.length);

    for (const t of trades) {
      const conditionId = t.condition_id || guessConditionIdFromTrade(t);
      if (!conditionId) continue;

      const url = `https://gamma-api.polymarket.com/markets?conditionId=${conditionId}`;
      let res;
      try {
        res = await fetch(url);
      } catch (e) {
        console.error(`[Resolve] Error for ${conditionId}: ${e.message}`);
        continue;
      }
      if (!res.ok) {
        console.error(`[Resolve] Error for ${conditionId}: HTTP ${res.status}`);
        continue;
      }

      let body;
      try {
        body = await res.json();
      } catch (e) {
        console.error(`[Resolve] Error for ${conditionId}: ${e.message}`);
        continue;
      }
      const data = Array.isArray(body) ? body[0] : body;
      if (!data) {
        console.log(`[Resolve] Market ${conditionId}: no data returned`);
        continue;
      }

      const closed = Boolean(
        data.closed === true ||
        data.resolved === true ||
        data.active === false
      );

      // Determine winning outcome from gamma API response
      const winningOutcome = (data.winningOutcome ?? data.winning_outcome ?? '').toUpperCase();

      console.log(`[Resolve] Market ${conditionId}: closed=${closed}, winner=${winningOutcome || 'N/A'}`);

      if (!closed) continue;
      const side = String(t.side || '').toUpperCase();

      let won = null;
      if (winningOutcome) {
        // Direct match: gamma API tells us which outcome won (e.g. "Yes", "No")
        won = side === winningOutcome;
      } else {
        // Fallback: derive from final price (YES token price)
        const finalPriceRaw =
          data.outcomePrices
            ? (Array.isArray(data.outcomePrices) ? data.outcomePrices[0] : JSON.parse(data.outcomePrices)[0])
            : data.tokens?.[0]?.price ?? data.price ?? null;
        const fp = parseFloat(finalPriceRaw);
        if (!Number.isNaN(fp)) {
          const yesWon = fp > 0.99;
          const noWon = fp < 0.01;
          if (side === 'YES') won = yesWon;
          else if (side === 'NO') won = noWon;
        }
      }

      const wonVal = won === null ? false : Boolean(won);

      // Extract final price for record
      let finalPrice = null;
      try {
        const prices = data.outcomePrices
          ? (Array.isArray(data.outcomePrices) ? data.outcomePrices : JSON.parse(data.outcomePrices))
          : null;
        finalPrice = prices ? parseFloat(prices[0]) : parseFloat(data.tokens?.[0]?.price ?? data.price);
      } catch (_) {}

      await pool.query(
        `UPDATE whale_trades
         SET resolved = TRUE,
             won = $1,
             final_price = $2
         WHERE trade_id = $3`,
        [wonVal, Number.isNaN(finalPrice) ? null : finalPrice, t.trade_id]
      );
    }
  } catch (e) {
    console.error('[Resolve] Resolved trades check error:', e.message, e.stack);
  }
}

// Telegram bot (only if BOT_TOKEN is set)
let bot = null;
if (process.env.BOT_TOKEN) {
  bot = new TelegramBot(process.env.BOT_TOKEN);

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(
      chatId,
      'OzScan - Prediction Market Intelligence. Commands coming soon.'
    );
  });

  setTimeout(async () => {
    try {
      await bot.deleteWebHook();
      bot.startPolling({ restart: false });
      console.log('✅ Telegram polling started');
      await fetchKalshiMarkets();
    } catch (e) {
      console.error('Telegram start error:', e.message);
    }
  }, 3000);
}

app.get('/api/whales', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const result = await pool.query('SELECT * FROM whale_trades ORDER BY timestamp DESC LIMIT 50');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/wallet/:address', async (req, res) => {
  if (!pool) return res.json({ wallet: req.params.address, trades: [], summary: {} });
  try {
    const addr = req.params.address;
    const trades = await pool.query(
      `SELECT market, side, size, price, timestamp, resolved, won, final_price, slug
       FROM whale_trades
       WHERE proxy_wallet = $1
       ORDER BY timestamp DESC
       LIMIT 100`,
      [addr]
    );
    const summary = await pool.query(
      `SELECT
         COUNT(*) as total_bets,
         SUM(size) as total_volume,
         SUM(CASE WHEN won=TRUE THEN 1 ELSE 0 END) as wins,
         COUNT(CASE WHEN resolved=TRUE THEN 1 END) as resolved,
         CASE WHEN COUNT(CASE WHEN resolved=TRUE THEN 1 END) > 0
           THEN ROUND(
             SUM(CASE WHEN won=TRUE THEN 1 ELSE 0 END)::numeric
             / COUNT(CASE WHEN resolved=TRUE THEN 1 END) * 100
           ) ELSE NULL END as win_rate
       FROM whale_trades
       WHERE proxy_wallet = $1`,
      [addr]
    );
    res.json({ wallet: addr, trades: trades.rows, summary: summary.rows[0] || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats', async (req, res) => {
  if (!pool) return res.json({ total_trades: 0, total_volume: 0, avg_bet: 0, max_bet: 0 });
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_trades,
        COALESCE(SUM(size::numeric), 0) as total_volume,
        COALESCE(AVG(size::numeric), 0) as avg_bet,
        COALESCE(MAX(size::numeric), 0) as max_bet
      FROM whale_trades
    `);
    res.json(result.rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/smart-money', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const result = await pool.query(`
      SELECT
        proxy_wallet as address,
        COUNT(*) as trade_count,
        SUM(size) as total_volume,
        MAX(size) as biggest_bet,
        CASE WHEN COUNT(CASE WHEN resolved=TRUE THEN 1 END) > 0
          THEN ROUND(
            SUM(CASE WHEN won=TRUE THEN 1 ELSE 0 END)::numeric
            / COUNT(CASE WHEN resolved=TRUE THEN 1 END) * 100
          )
          ELSE NULL
        END as win_rate
      FROM whale_trades
      WHERE proxy_wallet IS NOT NULL
      GROUP BY proxy_wallet
      ORDER BY total_volume DESC
      LIMIT 20
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/wallet-stats', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const result = await pool.query(`
      SELECT 
        proxy_wallet as address,
        COUNT(*) as total_bets,
        SUM(CASE WHEN won=TRUE THEN 1 ELSE 0 END) as wins,
        ROUND(
          SUM(CASE WHEN won=TRUE THEN 1 ELSE 0 END)::numeric
          / NULLIF(COUNT(CASE WHEN resolved=TRUE THEN 1 END), 0) * 100
        ) as win_rate,
        SUM(size) as total_volume
      FROM whale_trades
      WHERE proxy_wallet IS NOT NULL AND resolved = TRUE
      GROUP BY proxy_wallet
      ORDER BY win_rate DESC, total_bets DESC
      LIMIT 20
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/odds-spikes', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const result = await pool.query(`
      WITH latest AS (
        SELECT DISTINCT ON (market_id)
          market_id, question, price, recorded_at
        FROM odds_snapshots
        ORDER BY market_id, recorded_at DESC
      ),
      prev AS (
        SELECT DISTINCT ON (market_id)
          market_id, price AS prev_price
        FROM odds_snapshots
        WHERE recorded_at <= NOW() - INTERVAL '30 minutes'
        ORDER BY market_id, recorded_at DESC
      )
      SELECT
        l.market_id,
        l.question,
        l.price AS current_price,
        p.prev_price,
        (l.price - p.prev_price) AS change,
        EXTRACT(EPOCH FROM (NOW() - l.recorded_at)) AS seconds_ago
      FROM latest l
      JOIN prev p ON l.market_id = p.market_id
      WHERE ABS(l.price - p.prev_price) >= 0.10
      ORDER BY ABS(l.price - p.prev_price) DESC
      LIMIT 30
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/resolve-test', (req, res) => {
  checkResolvedTrades();
  res.json({ status: 'triggered' });
});

app.get('/api/odds-debug', async (req, res) => {
  if (!pool) return res.json({ error: 'no db' });
  try {
    const total = await pool.query('SELECT COUNT(*) as count FROM odds_snapshots');
    const recent = await pool.query(
      `SELECT COUNT(*) as count FROM odds_snapshots WHERE recorded_at > NOW() - INTERVAL '1 hour'`
    );
    const latest = await pool.query(
      'SELECT market_id, question, price, recorded_at FROM odds_snapshots ORDER BY recorded_at DESC LIMIT 5'
    );
    res.json({
      total_snapshots: Number(total.rows[0].count),
      last_hour: Number(recent.rows[0].count),
      latest: latest.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ozscan' });
});

// Start server and whale polling
app.listen(PORT, async () => {
  console.log(`OzScan server running on port ${PORT}`);
  await ensureWhaleTradesTable();
  await ensureOddsSnapshotsTable();
  await ensureSmartMoneyWalletsTable();
  if (pool) {
    await pool.query(`
  CREATE TABLE IF NOT EXISTS whale_trades (
    id SERIAL PRIMARY KEY,
    trade_id TEXT UNIQUE,
    market TEXT,
    side TEXT,
    size NUMERIC,
    price NUMERIC,
    timestamp TIMESTAMPTZ,
    created_at TIMESTAMP DEFAULT NOW()
  )
`);
    await pool.query(
      `ALTER TABLE whale_trades ADD COLUMN IF NOT EXISTS proxy_wallet TEXT;`
    );

    await pool.query(
      `ALTER TABLE whale_trades ADD COLUMN IF NOT EXISTS condition_id TEXT;`
    );
    await pool.query(
      `ALTER TABLE whale_trades ADD COLUMN IF NOT EXISTS slug TEXT;`
    );
    await pool.query(
      `ALTER TABLE whale_trades ADD COLUMN IF NOT EXISTS resolved BOOLEAN DEFAULT FALSE;`
    );
    await pool.query(
      `ALTER TABLE whale_trades ADD COLUMN IF NOT EXISTS won BOOLEAN;`
    );
    await pool.query(
      `ALTER TABLE whale_trades ADD COLUMN IF NOT EXISTS final_price NUMERIC;`
    );
  }
  runWhaleDetection();
  setInterval(runWhaleDetection, POLL_INTERVAL_MS);
  setInterval(runOddsMovementDetection, 5 * 60 * 1000);
});

setTimeout(fetchKalshiMarkets, 5000);
setTimeout(checkResolvedTrades, 5000);
setInterval(checkResolvedTrades, 60 * 60 * 1000);

// Arbitrage feature disabled
// detectArbitrage();
// setInterval(detectArbitrage, 5 * 60 * 1000);
