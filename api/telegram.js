// api/telegram.js
// CommonJS style — works on Vercel Node runtime (Node 18+)
const { initBot } = require('../src/bot');

let botPromise; // keep the bot across cold-starts in module scope

// Optionally require secret to match Telegram secret_token header
const EXPECTED_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;

module.exports = async (req, res) => {
  // quick health endpoint
  if (req.method === 'GET') {
    return res.status(200).send('OK - Telegram webhook endpoint');
  }

  // optional secret_token check (recommended)
  if (EXPECTED_SECRET) {
    const header = req.headers['x-telegram-bot-api-secret-token'];
    if (!header || header !== EXPECTED_SECRET) {
      console.warn('Webhook secret mismatch', header);
      return res.status(401).send('Unauthorized');
    }
  }

  // Telegram sends JSON body
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    if (!botPromise) botPromise = initBot(); // returns a Telegraf instance (your code)
    const bot = await botPromise;

    // Pass the update to telegraf to handle it (serverless-friendly)
    // DO NOT pass `res` into handleUpdate — let us control the HTTP response here.
    await bot.handleUpdate(req.body);

    // send 200 to Telegram
    if (!res.headersSent) res.status(200).send('OK');
  } catch (err) {
    console.error('telegram webhook handler error', err);
    if (!res.headersSent) {
      // respond 500 so Telegram may retry; change to 200 if you prefer no retries.
      res.status(500).send('Server error');
    } else {
      // headers already sent (rare) — just end
      try { res.end(); } catch (_) {}
    }
  }
};
