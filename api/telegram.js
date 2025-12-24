// api/telegram.js
// Serverless webhook handler for Vercel — safe single-response pattern

const { initBot } = require('../src/bot');

let botPromise;

const EXPECTED_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).send('OK - Telegram webhook endpoint');
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  if (EXPECTED_SECRET) {
    const header = req.headers['x-telegram-bot-api-secret-token'];
    if (!header || header !== EXPECTED_SECRET) {
      console.warn('Webhook secret mismatch', header);
      return res.status(401).send('Unauthorized');
    }
  }

  let update = req.body;
  try {
    if (!update || (typeof update !== 'object') || Object.keys(update).length === 0) {
      if (req.rawBody) {
        try { update = JSON.parse(Buffer.from(req.rawBody).toString()); } catch (_) { update = req.body; }
      }
    }
  } catch (e) {
    console.error('Failed to parse request body', e && e.message);
    return res.status(400).send('Bad Request');
  }

  try {
    if (!botPromise) botPromise = initBot();
    const bot = await botPromise;
    await bot.handleUpdate(update);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('telegram webhook handler error', err && (err.stack || err.message));
    return res.status(500).send('Server error');
  }
};
