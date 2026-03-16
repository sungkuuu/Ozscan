require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const app = express();

// PostgreSQL connection
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

// Telegram bot (only if BOT_TOKEN is set)
let bot = null;
if (process.env.BOT_TOKEN) {
  bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(
      chatId,
      'OzScan - Prediction Market Intelligence. Commands coming soon.'
    );
  });
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ozscan' });
});

app.listen(PORT, () => {
  console.log(`OzScan server running on port ${PORT}`);
});
