// path: api/telegram.js
// Vercel serverless handler for Telegram webhook
// Validates ?token=WEBHOOK_SECRET or header x-webhook-secret
// Tries several require paths for src/bot, then calls initBot() or handleUpdate() and awaits processing.

const util = require('util');

const CANDIDATES = [
  './src/bot',
  '../src/bot',
  './bot',
  '../bot'
];

let cached = {
  module: null,
  handleUpdate: null,
  initCalled: false,
  initResult: null
};

function log(...args) {
  console.log('[webhook]', ...args);
}

async function tryRequireBot() {
  if (cached.module) return cached.module;
  let mod = null;
  for (const p of CANDIDATES) {
    try {
      // use require.resolve to check path
      mod = require(p);
      log('required bot from', p);
      cached.module = mod;
      return mod;
    } catch (e) {
      // ignore require error and try next
    }
  }
  // As a last attempt, try dynamic import of typical compiled paths
  try {
    mod = require('./src/bot.js');
    cached.module = mod;
    return mod;
  } catch (e) {
    // nothing else
  }
  return null;
}

async function ensureInit() {
  // returns handleUpdate function that accepts update
  if (cached.handleUpdate) return cached.handleUpdate;

  const mod = await tryRequireBot();
  if (!mod) {
    log('bot module not found in candidate paths.');
    return null;
  }

  // Priority: if module exports handleUpdate directly
  if (typeof mod.handleUpdate === 'function') {
    cached.handleUpdate = mod.handleUpdate.bind(mod);
    log('using module.handleUpdate');
    return cached.handleUpdate;
  }

  // If module exports initBot
  if (typeof mod.initBot === 'function') {
    try {
      // call once and reuse returned object
      if (!cached.initCalled) {
        cached.initCalled = true;
        const maybe = await mod.initBot(); // may throw if env misconfigured
        cached.initResult = maybe || {};
      }
      const r = cached.initResult;
      if (!r) {
        log('initBot returned falsy value');
      }
      // r.handleUpdate, r.bot.handleUpdate, or mod.handleUpdate
      if (r && typeof r.handleUpdate === 'function') {
        cached.handleUpdate = r.handleUpdate.bind(r);
        log('using initBot().handleUpdate');
        return cached.handleUpdate;
      }
      if (r && r.bot && typeof r.bot.handleUpdate === 'function') {
        cached.handleUpdate = r.bot.handleUpdate.bind(r.bot);
        log('using initBot().bot.handleUpdate');
        return cached.handleUpdate;
      }
      // fallback to module.handleUpdate again
      if (typeof mod.handleUpdate === 'function') {
        cached.handleUpdate = mod.handleUpdate.bind(mod);
        log('using module.handleUpdate (fallback after init)');
        return cached.handleUpdate;
      }

      log('initBot succeeded but no handleUpdate found in returned object.');
      return null;
    } catch (e) {
      log('initBot() threw:', e && (e.stack || e.message));
      // propagate so caller can decide response behavior
      throw e;
    }
  }

  log('bot module found but no initBot() or handleUpdate() export detected.');
  return null;
}

module.exports = async function handler(req, res) {
  try {
    // Accept GET for simple health-check
    if (req.method === 'GET') {
      return res.status(200).send('ok');
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST,GET');
      return res.status(405).send('Method Not Allowed');
    }

    const token = (req.query && req.query.token) || req.headers['x-webhook-secret'] || req.headers['x-telegram-bot-api-secret-token'];

    if (process.env.WEBHOOK_SECRET && token !== process.env.WEBHOOK_SECRET) {
      log('invalid webhook token attempt:', token);
      return res.status(403).send('invalid token');
    }

    const update = req.body;
    if (!update) {
      log('no update body received');
      return res.status(400).send('no update body');
    }

    // Ensure bot init and obtain handler
    let handle = null;
    try {
      handle = await ensureInit();
    } catch (e) {
      // initBot threw (likely missing env); decide response
      log('initBot threw during ensureInit:', e && (e.stack || e.message));
      if (process.env.WEBHOOK_STRICT === '1') {
        // strict mode for debugging — return 500 so deploy logs show failures
        return res.status(500).json({ ok: false, error: 'bot init failed', detail: String(e && (e.message || e)) });
      } else {
        // non-strict: return 200 so Telegram doesn't keep retrying loudly
        log('non-strict mode: returning 200 despite bot init failure');
        return res.status(200).json({ ok: true, note: 'bot not initialized; logged on server' });
      }
    }

    if (!handle) {
      log('no handleUpdate available after init');
      if (process.env.WEBHOOK_STRICT === '1') {
        return res.status(500).json({ ok: false, error: 'no handler available' });
      } else {
        return res.status(200).json({ ok: true, note: 'no handler available; logged' });
      }
    }

    // Call the bot update handler and await processing so work completes before returning.
    try {
      await handle(update);
    } catch (err) {
      // If the bot handler throws, log and respond 500 (or 200 in non-strict mode)
      log('bot.handleUpdate threw:', err && (err.stack || err.message));
      if (process.env.WEBHOOK_STRICT === '1') {
        return res.status(500).json({ ok: false, error: 'handler error', detail: String(err && (err.message || err)) });
      } else {
        // respond 200 to avoid Telegram spam; admins should check logs
        return res.status(200).json({ ok: true, note: 'handler error logged' });
      }
    }

    // success
    return res.status(200).json({ ok: true });
  } catch (outer) {
    log('unexpected error in webhook handler:', outer && (outer.stack || outer.message));
    if (process.env.WEBHOOK_STRICT === '1') {
      return res.status(500).json({ ok: false, error: 'unexpected' });
    } else {
      return res.status(200).json({ ok: true, note: 'unexpected error logged' });
    }
  }
};
