require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const fetch = require('node-fetch');

const PORT = process.env.PORT || 3000;
const TRADES_URL = 'https://clob.polymarket.com/trades?limit=50';
const TRADES_URL_FALLBACK = 'https://data-api.polymarket.com/trades?limit=50';
const WHALE_SIZE_USDC = 10000;
const POLL_INTERVAL_MS = 60 * 1000;

const app = express();

// PostgreSQL connection
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

// Trade IDs we've already sent an alert for (avoid duplicates)
const alertedTradeIds = new Set();

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
  return trades;
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
    if (Number.isNaN(usdcValue)) continue;
    if (usdcValue < WHALE_SIZE_USDC) continue;

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
          `Amount: $${w.size.toFixed(0)}`,
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
  runWhaleDetection();
  setInterval(runWhaleDetection, POLL_INTERVAL_MS);
});
