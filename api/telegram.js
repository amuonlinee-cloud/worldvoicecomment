// api/telegram.js
// CommonJS serverless handler for Vercel that forwards Telegram updates to src/bot.js
// - Verifies optional secret token header if WEBHOOK_SECRET is set.
// - Uses require() because src/bot.js is CommonJS (exports.handleUpdate).
// - Returns quickly with proper HTTP codes and logs errors.

const getRawBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', err => reject(err));
  });

module.exports = async (req, res) => {
  try {
    // Health check for browser / Vercel probe
    if (req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end('OK');
      return;
    }

    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }

    // Optional secret token verification (Telegram's setWebhook secret_token -> header X-Telegram-Bot-Api-Secret-Token)
    const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
    if (WEBHOOK_SECRET) {
      const header = (req.headers['x-telegram-bot-api-secret-token'] || req.headers['x-telegram-bot-secret-token'] || '').toString();
      if (!header || header !== WEBHOOK_SECRET) {
        console.warn('telegram webhook: secret token mismatch');
        res.statusCode = 401;
        res.end('Unauthorized');
        return;
      }
    }

    // Read raw body and parse JSON (Telegram sends JSON)
    const raw = await getRawBody(req);
    let update;
    try {
      update = raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn('telegram webhook: invalid JSON body', e && e.message);
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }

    // Require your bot module (CommonJS). Adjust path if your bot file lives elsewhere.
    // Your uploaded bot.js exports handleUpdate / initBot (CommonJS). See src/bot.js in your repo.
    const botModule = require('../src/bot.js');
    const handleUpdate = botModule && (botModule.handleUpdate || (botModule.default && botModule.default.handleUpdate));

    if (!handleUpdate || typeof handleUpdate !== 'function') {
      console.error('telegram webhook: bot handler not found (expect handleUpdate(update))');
      res.statusCode = 500;
      res.end('Server misconfigured');
      return;
    }

    // Forward update to your bot and wait for it to process it (so errors are visible in logs)
    try {
      await Promise.resolve(handleUpdate(update));
    } catch (err) {
      // bot processing error — log and continue returning 200 (so Telegram won't rapidly retry)
      console.error('telegram webhook: bot.handleUpdate threw:', err && (err.stack || err.message));
      // still respond 200 to avoid webhook flood — admins will be notified by your bot if needed
    }

    // Success
    res.statusCode = 200;
    res.end('OK');
  } catch (err) {
    console.error('telegram webhook handler top-level error:', err && (err.stack || err.message));
    res.statusCode = 500;
    res.end('Internal Server Error');
  }
};
