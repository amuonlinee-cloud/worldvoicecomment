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

    // Pass the update to telegraf to handle it
    // Using handleUpdate is serverless-friendly (no bot.launch / polling).
    await bot.handleUpdate(req.body, res);

    // If bot.handleUpdate didn't end the response, ensure we send 200
    if (!res.headersSent) res.status(200).send('OK');
  } catch (err) {
    console.error('telegram webhook handler error', err);
    // respond 200 to Telegram if you want to avoid repeated deliveries,
    // but during debugging 500 is useful. We'll return 500 here.
    res.status(500).send('Server error');
  }
};
