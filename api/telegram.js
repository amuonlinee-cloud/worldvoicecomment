// api/telegram.js
const { initBot } = require('../src/bot');
let botPromise;

const EXPECTED_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).send('OK - Telegram webhook endpoint');

  if (EXPECTED_SECRET) {
    const header = req.headers['x-telegram-bot-api-secret-token'];
    if (!header || header !== EXPECTED_SECRET) {
      console.warn('Webhook secret mismatch', header);
      return res.status(401).send('Unauthorized');
    }
  }
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    if (!botPromise) botPromise = initBot();
    const bot = await botPromise;
    // Do not pass res; use handleUpdate only with body
    await bot.handleUpdate(req.body);
    if (!res.headersSent) res.status(200).send('OK');
  } catch (err) {
    console.error('telegram webhook handler error', err && (err.stack || err));
    if (!res.headersSent) res.status(500).send('Server error');
  }
};

