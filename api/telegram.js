// api/telegram.js
// CommonJS serverless webhook for Vercel. Loads your bot (src/bot.js) and forwards updates.

const { initBot } = require('../src/bot');

let botPromise; // keep the bot instance across cold starts
const EXPECTED_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    res.status(200).send('OK - Telegram webhook endpoint');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  if (EXPECTED_SECRET) {
    const header = req.headers['x-telegram-bot-api-secret-token'];
    if (!header || header !== EXPECTED_SECRET) {
      console.warn('Webhook secret mismatch', header);
      res.status(401).send('Unauthorized');
      return;
    }
  }

  try {
    if (!botPromise) botPromise = initBot();
    const bot = await botPromise;
    // Forward update to telegraf
    await bot.handleUpdate(req.body);
    if (!res.headersSent) res.status(200).send('OK');
  } catch (err) {
    console.error('telegram webhook handler error', err);
    if (!res.headersSent) res.status(500).send('Server error');
  }
};
