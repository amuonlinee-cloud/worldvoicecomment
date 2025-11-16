// api/telegram.js
// Vercel serverless webhook handler for telegram.
// Expects src/bot.js to export initBot() that returns a Telegraf bot instance.

const assert = require('assert');

let botSingleton = null;
let botInitPromise = null;

function tryRequireBotModule() {
  // try multiple relative paths (api/telegram.js runs from project root on Vercel)
  const tryPaths = [
    './src/bot',
    '../src/bot', // in case file layout differs
    './bot',
    '../bot'
  ];
  for (const p of tryPaths) {
    try {
      // require resolves relative to this file
      // use require.resolve to check presence
      // plain require and test export
      const m = require(p);
      if (m && typeof m.initBot === 'function') return m;
      // older patterns might export default or the bot directly
      if (m && typeof m === 'function' && m.handleUpdate) {
        // m is a bot instance
        return { initBot: async () => m };
      }
    } catch (e) {
      // ignore and try next
    }
  }
  throw new Error('Could not require src/bot (tried multiple paths).');
}

async function getBotSingleton() {
  if (botSingleton) return botSingleton;
  if (!botInitPromise) {
    botInitPromise = (async () => {
      const mod = tryRequireBotModule();
      if (!mod || typeof mod.initBot !== 'function') throw new Error('Could not require src/bot (expected initBot export)');
      const bot = await mod.initBot();
      if (!bot || typeof bot.handleUpdate !== 'function') {
        throw new Error('Bot returned from initBot is invalid (no handleUpdate).');
      }
      botSingleton = bot;
      return botSingleton;
    })();
  }
  return botInitPromise;
}

module.exports = async function handler(req, res) {
  // Protect endpoint by token query param if WEBHOOK_SECRET provided in Vercel env
  const expected = process.env.WEBHOOK_SECRET || process.env.VERCEL_WEBHOOK_SECRET || process.env.NETLIFY_WEBHOOK_SECRET;
  const provided = (req.query && (req.query.token || req.query.secret)) || null;

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, msg: 'debug ok', time: new Date().toISOString() });
  }

  // Only allow POST for Telegram updates
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  if (expected) {
    if (!provided || provided !== expected) {
      // Return 403 so Telegram stops delivering updates to wrong url
      res.status(403).send('Missing or wrong token.');
      return;
    }
  } // if no expected secret defined, allow through (use WITH CAUTION)

  let update = null;
  try {
    update = req.body;
    if (!update || Object.keys(update).length === 0) {
      // maybe raw buffer?
      try { update = JSON.parse(Buffer.from(req.rawBody || req.body || '').toString() || '{}'); } catch(_) { update = req.body; }
    }
  } catch (e) {
    console.error('Invalid JSON body', e && e.message);
    // respond 200 to avoid repeated attempts, but log for debugging
    res.status(400).send('Bad Request');
    return;
  }

  try {
    const bot = await getBotSingleton();
    // Let the bot handle the update
    await bot.handleUpdate(update, undefined);
    // reply quickly
    res.status(200).send('OK');
  } catch (e) {
    console.error('[webhook] Failed to handle update:', e && (e.stack || e.message));
    // Respond 500 for visibility; you can change to 200 to stop Telegram retries (but 500 surfaces error in logs)
    res.status(500).send('Server error processing update');
  }
};
