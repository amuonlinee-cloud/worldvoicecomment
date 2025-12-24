// api/telegram.js
// CommonJS style — serverless-friendly webhook for Telegraf

const { initBot } = require('../src/bot');

let botPromise; // keep the bot instance across cold-starts in module scope

// Optional secret to match Telegram secret_token header (recommended)
const EXPECTED_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;

module.exports = async (req, res) => {
  // health check
  if (req.method === 'GET') {
    return res.status(200).send('OK - Telegram webhook endpoint');
  }

  // only allow POST for webhook updates
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // optional secret header check
  if (EXPECTED_SECRET) {
    const header = req.headers['x-telegram-bot-api-secret-token'];
    if (!header || header !== EXPECTED_SECRET) {
      console.warn('Webhook secret mismatch', header);
      return res.status(401).send('Unauthorized');
    }
  }

  // parse update safely — Vercel sometimes gives rawBody or parsed body
  let update = req.body;
  try {
    if (!update || (typeof update !== 'object') || Object.keys(update).length === 0) {
      if (req.rawBody) {
        try { update = JSON.parse(Buffer.from(req.rawBody).toString()); } catch (_) { update = req.body; }
      }
    }
  } catch (e) {
    console.error('Failed to parse request body', e);
    return res.status(400).send('Bad Request');
  }

  try {
    if (!botPromise) botPromise = initBot(); // returns Telegraf instance (your src/bot.js)
    const bot = await botPromise;

    // Pass update only. Do NOT pass the express "res" object to Telegraf.
    // handleUpdate is serverless-friendly.
    await bot.handleUpdate(update);

    // Send exactly one 200 response here
    return res.status(200).send('OK');
  } catch (err) {
    console.error('telegram webhook handler error', err && (err.stack || err.message || err));
    // Return 500 so you can see the error in Vercel logs during debugging.
    return res.status(500).send('Server error');
  }
};
