// api/telegram.js
// Robust Vercel webhook handler for Telegram + safe bot loader.
//
// Expects one of these to be true:
// - your bot exports `initBot()` from ./src/bot.js (or ../src/bot.js, ./bot.js, ../bot.js)
// - OR your bot module exports the bot instance itself (handleUpdate present)
//
// Important: do NOT call bot.launch() in the module when deploying to Vercel.
// Use `if (require.main === module) { bot.launch(); }` guard in your bot file
// so it only launches polling when run directly (local dev).

const util = require('util');

let botSingleton = null;
let botInitPromise = null;

function tryRequireBotModule() {
  const tryPaths = [
    './src/bot',
    '../src/bot',
    './bot',
    '../bot',
    './src/index',
    '../src/index'
  ];
  let lastErr = null;
  for (const p of tryPaths) {
    try {
      const m = require(p);
      if (!m) continue;
      // module exports initBot factory
      if (typeof m.initBot === 'function') return m;
      // module might export default with initBot
      if (m.default && typeof m.default.initBot === 'function') return m.default;
      // module might be a bot instance directly
      if (typeof m === 'function' && m.handleUpdate) return { initBot: async () => m };
      if (m && typeof m.handleUpdate === 'function') return { initBot: async () => m };
    } catch (e) {
      lastErr = e;
      // try next path
    }
  }
  const msg = 'Could not require bot module from any of the tried paths: ' + tryPaths.join(', ');
  const err = new Error(msg);
  err.cause = lastErr;
  throw err;
}

async function getBotSingleton() {
  if (botSingleton) return botSingleton;
  if (!botInitPromise) {
    botInitPromise = (async () => {
      const mod = tryRequireBotModule();
      if (!mod || typeof mod.initBot !== 'function') {
        throw new Error('Bot module loaded but does not export initBot()');
      }
      const maybeBot = mod.initBot();
      // support initBot returning either promise or direct instance
      const bot = (maybeBot && typeof maybeBot.then === 'function') ? await maybeBot : maybeBot;
      if (!bot || typeof bot.handleUpdate !== 'function') {
        throw new Error('initBot did not return a valid Telegraf bot (missing handleUpdate)');
      }
      botSingleton = bot;
      return botSingleton;
    })();
  }
  return botInitPromise;
}

/**
 * Vercel handler
 * - Accepts optional secret as query param `token` or `secret` if WEBHOOK_SECRET present in env
 * - Supports GET health check
 */
module.exports = async function handler(req, res) {
  // quick health check
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, now: new Date().toISOString() });
  }

  // Only POST allowed for Telegram updates
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,GET');
    return res.status(405).send('Method Not Allowed');
  }

  // optional secret protection (set WEBHOOK_SECRET or VERCEL_WEBHOOK_SECRET in Vercel env)
  const expected = process.env.WEBHOOK_SECRET || process.env.VERCEL_WEBHOOK_SECRET || process.env.NETLIFY_WEBHOOK_SECRET;
  const provided = (req.query && (req.query.token || req.query.secret)) || null;
  if (expected) {
    if (!provided || provided !== expected) {
      console.error('[webhook] Missing or invalid secret. Provided:', provided ? '[REDACTED]' : 'none');
      // 403 so Telegram will consider it a client error (but you might prefer 200 to stop retries)
      return res.status(403).send('Missing or wrong token.');
    }
  }

  // parse update robustly: Vercel usually gives req.body parsed already,
  // but fall back to rawBody or manual parse if empty
  let update = null;
  try {
    // if library already parsed JSON as object
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      update = req.body;
    } else if (req.rawBody) {
      // in some runtimes rawBody exists
      try {
        update = JSON.parse(req.rawBody.toString());
      } catch (e) {
        update = req.body;
      }
    } else {
      // as last resort try to parse req.body as string
      try {
        const maybe = (typeof req.body === 'string') ? req.body : JSON.stringify(req.body || {});
        update = JSON.parse(maybe || '{}');
      } catch (e) {
        update = req.body;
      }
    }
  } catch (e) {
    console.error('[webhook] Failed to parse body:', e && (e.stack || e.message));
    return res.status(400).send('Bad Request - invalid JSON');
  }

  if (!update || Object.keys(update).length === 0) {
    // Nothing to process
    console.error('[webhook] Empty update payload received');
    return res.status(400).send('Bad Request - empty update');
  }

  try {
    const bot = await getBotSingleton();
    // let Telegraf process the update
    await bot.handleUpdate(update, undefined);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('[webhook] Failed to handle update:', err && (err.stack || err.message));
    // return 500 so the error is visible in Vercel logs. If Telegram retries are undesirable,
    // change to 200 to stop retries, but you'll lose visibility of errors in retries.
    return res.status(500).send('Server error processing update');
  }
};

// Increase body parser limit so media updates don't fail — Vercel-specific export
module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb' // increase if you expect larger incoming media
    }
  }
};
