// netlify/functions/telegram.js
// Robust Netlify function wrapper for Telegram webhook.
// Expects NETLIFY_WEBHOOK_SECRET env and your src/bot.js exporting initBot() (does NOT call bot.launch()).

const { initBot } = require('../../src/bot');

let botSingletonPromise = null;
async function getBot() {
  if (!botSingletonPromise) {
    // initBot may be sync or async — normalize to a promise
    botSingletonPromise = Promise.resolve().then(() => initBot());
  }
  return botSingletonPromise;
}

exports.handler = async (event, context) => {
  const secret = process.env.NETLIFY_WEBHOOK_SECRET;
  const qs = event.queryStringParameters || {};
  const method = (event.httpMethod || 'GET').toUpperCase();

  // Health check
  if (method === 'GET') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, msg: 'debug ok', time: new Date().toISOString() })
    };
  }

  // Only accept POST for Telegram updates
  if (method !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Token check
  if (!secret || !qs.token || qs.token !== secret) {
    console.error('Missing or wrong token. Provided:', qs.token, 'Expected secret present?', !!secret);
    return { statusCode: 403, body: 'Missing or invalid token' };
  }

  // Parse incoming body
  let update;
  try {
    update = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (err) {
    console.error('Invalid JSON from Telegram webhook:', err);
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // Acquire bot instance
  let bot;
  try {
    bot = await getBot();
    if (!bot || typeof bot.handleUpdate !== 'function') {
      console.error('Bot returned from initBot is invalid (no handleUpdate). Bot:', !!bot);
      return { statusCode: 500, body: 'Bot not initialized correctly' };
    }
  } catch (err) {
    console.error('Failed to initialize bot singleton:', err && (err.stack || err));
    // return 200 to avoid Telegram marking webhook down repeatedly — but log the error
    return { statusCode: 200, body: 'OK (bot init error logged)' };
  }

  // Forward update to Telegraf and catch any runtime errors
  try {
    await bot.handleUpdate(update);
    return { statusCode: 200, body: 'Webhook received and token OK' };
  } catch (err) {
    // Log full error for debugging in Netlify logs
    console.error('Error in bot.handleUpdate:', err && (err.stack || err));

    // Try to notify admins (optional) — safe best-effort
    try {
      const adminsEnv = process.env.ADMIN_IDS || '';
      const admins = adminsEnv.split(',').map(s => s.trim()).filter(Boolean);
      if (admins.length > 0 && bot.telegram && typeof bot.telegram.sendMessage === 'function') {
        const short = (update.message && update.message.text) ? update.message.text.slice(0,200) : 'update';
        for (const adm of admins) {
          try {
            await bot.telegram.sendMessage(Number(adm), `⚠️ Bot error occurred while handling an update.\nMessage preview: ${short}\nError: ${err.message || 'unknown'}`);
          } catch (e) { /* ignore send errors */ }
        }
      }
    } catch (notifyErr) {
      console.error('Failed to notify admins:', notifyErr && (notifyErr.stack || notifyErr));
    }

    // Return 200 so Telegram stops sending repeated failure marks; the error is logged
    return { statusCode: 200, body: 'OK (error logged)' };
  }
};
