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

    // IMPORTANT: do NOT pass `res` into handleUpdate here. Passing the Node response object
    // allows Telegraf to write to the response and may cause double responses (ERR_HTTP_HEADERS_SENT).
    // Instead, call handleUpdate(update) and send our own HTTP 200 once.
    await bot.handleUpdate(req.body);

    // Respond once to Telegram
    if (!res.headersSent) return res.status(200).send('OK');
  } catch (err) {
    console.error('telegram webhook handler error', err);
    // During debugging return 500; in production you may prefer 200 to avoid repeated deliveries.
    try {
      if (!res.headersSent) return res.status(500).send('Server error');
    } catch (e) { /* ignore */ }
  }
};
