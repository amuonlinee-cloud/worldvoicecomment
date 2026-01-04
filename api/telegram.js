// api/telegram.js
// CommonJS serverless webhook for Vercel. Loads your bot (src/bot.js) and forwards updates.
// Make sure TELEGRAM_WEBHOOK_SECRET (optional) matches the header if you configured Telegram secret.

const { initBot } = require('../src/bot');

let botPromise; // keep the bot instance across cold starts

const EXPECTED_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;

module.exports = async (req, res) => {
  // Health check
  if (req.method === 'GET') {
    res.status(200).send('OK - Telegram webhook endpoint');
    return;
  }

  // Only accept POST for Telegram updates
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // Optional secret header check
  if (EXPECTED_SECRET) {
    const header = req.headers['x-telegram-bot-api-secret-token'];
    if (!header || header !== EXPECTED_SECRET) {
      console.warn('Webhook secret mismatch', header);
      res.status(401).send('Unauthorized');
      return;
    }
  }

  try {
    if (!botPromise) botPromise = initBot(); // returns Telegraf instance
    const bot = await botPromise;

    // Forward update to Telegraf. Do NOT pass `res` into handleUpdate here.
    // Let this handler send the HTTP response after handleUpdate resolves.
    await bot.handleUpdate(req.body);

    // If telegraf didn't set response, respond OK
    if (!res.headersSent) res.status(200).send('OK');
  } catch (err) {
    console.error('telegram webhook handler error', err);
    // If anything failed, send 500
    if (!res.headersSent) res.status(500).send('Server error');
  }
};
