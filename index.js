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

async function fetchKalshiMarkets() {
  try {
    console.log('[Kalshi] Fetching markets...');
    const res = await fetch('https://api.elections.kalshi.com/trade-api/v2/markets?limit=5');
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
    return markets
      .map((m) => ({
        ticker: m.ticker,
        title: m.title || m.name || '',
        yesPrice: parseFloat(m.yes_ask_dollars),
      }))
      .filter((m) => m.title && !Number.isNaN(m.yesPrice) && m.yesPrice > 0 && m.yesPrice < 1);
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

    console.log('[Arb] Polymarket sample market:', JSON.stringify(markets[0], null, 2));

    return markets
      .map(m => {
        const price = m.tokens?.[0]?.price ?? m.outcomePrices?.[0] ?? null;
        return {
          slug: m.condition_id || m.slug || '',
          question: m.question || m.title || '',
          price: price !== null ? parseFloat(price) : null,
        };
      })
      .filter(m => m.question && m.price !== null && m.price > 0 && m.price < 1);
  } catch (e) {
    console.error('[Arb] Polymarket odds error:', e.message);
    return [];
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
  try {
    const [kalshi, poly] = await Promise.all([fetchKalshiOdds(), fetchPolymarketOdds()]);
    console.log('[Arb] Kalshi markets:', kalshi.length, 'Polymarket markets:', poly.length);

    for (const k of kalshi) {
      let best = null;
      let bestScore = 0;
      for (const p of poly) {
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

      if (bot && process.env.ADMIN_CHAT_ID) {
        const title = k.title || best.question;
        const msg = [
          '🔄 ARBITRAGE ALERT',
          '',
          `Event: ${title}`,
          `Polymarket: ${(polyPrice * 100).toFixed(1)}%`,
          `Kalshi: ${(kalshiPrice * 100).toFixed(1)}%`,
          `Gap: ${(gap * 100).toFixed(1)}%`,
          '',
          `Buy ${lowerPlatform === 'Polymarket' ? 'YES on Polymarket' : 'YES on Kalshi'}, Sell ${higherPlatform === 'Polymarket' ? 'YES on Polymarket' : 'YES on Kalshi'}`,
          `Expected profit: ~${(gap * 100 - 1).toFixed(1)}%`,
          '',
          'ozscan.xyz',
        ].join('\n');
        try {
          await bot.sendMessage(process.env.ADMIN_CHAT_ID, msg);
        } catch (err) {
          console.error('[Arb] Telegram send failed:', err.message);
        }
      }
    }
  } catch (e) {
    console.error('[Arb] detectArbitrage error:', e.message);
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

    const whale = {
      tradeId,
      market: String(market),
      side: side === 'BUY' ? 'YES' : side === 'SELL' ? 'NO' : side || '—',
      size: usdcValue,
      price: price * 100,
      timestamp: Number(t.timestamp) || 0,
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
      `INSERT INTO whale_trades (trade_id, market, side, size, price, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (trade_id) DO NOTHING`,
      [
        whale.tradeId,
        whale.market,
        whale.side,
        whale.size,
        whale.price,
        whale.timestamp,
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

      if (pool) {
        await pool.query(
          `
  INSERT INTO whale_trades (trade_id, market, side, size, price, timestamp)
  VALUES ($1, $2, $3, $4, $5, to_timestamp($6))
  ON CONFLICT (trade_id) DO NOTHING
`,
          [w.tradeId, w.market, w.side, w.size, w.price, w.timestamp]
        );
      }
    }
  } catch (e) {
    console.error('[Polymarket] Error:', e.message);
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ozscan' });
});

// Start server and whale polling
app.listen(PORT, async () => {
  console.log(`OzScan server running on port ${PORT}`);
  await ensureWhaleTradesTable();
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
  }
  runWhaleDetection();
  setInterval(runWhaleDetection, POLL_INTERVAL_MS);
});

setTimeout(fetchKalshiMarkets, 5000);

setInterval(detectArbitrage, 5 * 60 * 1000);
