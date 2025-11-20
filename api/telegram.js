// path: api/telegram.js
// Robust Vercel webhook handler for the voice-comment bot.
// Accepts many shapes from src/bot: direct handleUpdate export, initBot returning Telegraf instance,
// initBot returning { bot, handleUpdate }, or module exporting the bot directly.

const CANDIDATES = [
  './src/bot',
  '../src/bot',
  './bot',
  '../bot',
  './src/bot.js',
  '../src/bot.js'
];

function log(...args) {
  console.log('[webhook]', ...args);
}

async function tryRequireCandidate() {
  for (const p of CANDIDATES) {
    try {
      const mod = require(p);
      log('required bot module from', p);
      return { mod, path: p };
    } catch (err) {
      // keep trying
      // not logging full stack to avoid noise, but log message
      log(`require ${p} failed: ${err && err.message}`);
    }
  }
  log('no bot module found in candidate paths');
  return null;
}

function isTelegrafLike(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return typeof obj.handleUpdate === 'function' && obj.telegram;
}

async function initAndExtractHandler() {
  const found = await tryRequireCandidate();
  if (!found) return { error: 'bot_module_not_found' };
  const { mod, path } = found;

  // 1) module exports handleUpdate directly
  if (typeof mod.handleUpdate === 'function') {
    log('using module.handleUpdate (direct export)');
    return { handler: mod.handleUpdate.bind(mod), info: 'module.handleUpdate' };
  }

  // 2) module exports initBot -> call it and inspect return
  if (typeof mod.initBot === 'function') {
    try {
      log('calling initBot() from', path);
      const res = await mod.initBot();

      // If initBot returned a Telegraf instance
      if (isTelegrafLike(res)) {
        log('initBot() returned Telegraf-like instance (has handleUpdate). Using bot.handleUpdate');
        return { handler: res.handleUpdate.bind(res), info: 'initBot_returned_telegraf' };
      }

      // If initBot returned an object that contains handleUpdate
      if (res && typeof res.handleUpdate === 'function') {
        log('initBot() returned object with handleUpdate');
        return { handler: res.handleUpdate.bind(res), info: 'initBot_returned_handleUpdate' };
      }

      // If initBot returned an object with .bot which is Telegraf-like
      if (res && res.bot && isTelegrafLike(res.bot)) {
        log('initBot() returned { bot } where bot is Telegraf-like. Using bot.handleUpdate');
        return { handler: res.bot.handleUpdate.bind(res.bot), info: 'initBot_returned_obj_bot' };
      }

      // Lastly, maybe module itself is the Telegraf instance or has a handleUpdate property not found earlier
      if (isTelegrafLike(mod)) {
        log('module itself appears Telegraf-like');
        return { handler: mod.handleUpdate.bind(mod), info: 'module_telegraf_like' };
      }

      log('initBot() returned but no usable handler found. Returned keys: ' + Object.keys(res || {}).join(','));
      return { error: 'initBot_no_handler', detail: Object.keys(res || {}) };
    } catch (err) {
      log('initBot() threw:', err && (err.stack || err.message));
      return { error: 'initBot_threw', detail: err && (err.stack || err.message) };
    }
  }

  // 3) module itself might be a Telegraf instance
  if (isTelegrafLike(mod)) {
    log('module is Telegraf-like');
    return { handler: mod.handleUpdate.bind(mod), info: 'module_telegraf' };
  }

  // fallback
  log('module found but no initBot and no handleUpdate');
  return { error: 'module_no_init_or_handle' };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') return res.status(200).send('ok');

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET,POST');
      return res.status(405).send('Method Not Allowed');
    }

    // validate token
    const token = (req.query && req.query.token) || req.headers['x-webhook-secret'] || req.headers['x-telegram-bot-api-secret-token'];
    if (process.env.WEBHOOK_SECRET && token !== process.env.WEBHOOK_SECRET) {
      log('invalid webhook token', token);
      return res.status(403).send('invalid token');
    }

    if (!req.body) {
      log('no body in request');
      return res.status(400).send('no body');
    }

    const initResult = await initAndExtractHandler();

    if (initResult.handler) {
      try {
        await initResult.handler(req.body);
        return res.status(200).json({ ok: true, info: initResult.info || null });
      } catch (err) {
        log('handler threw:', err && (err.stack || err.message));
        if (process.env.WEBHOOK_STRICT === '1') {
          return res.status(500).json({ ok: false, error: 'handler_error', detail: String(err && (err.stack || err.message)) });
        } else {
          // swallow but log
          return res.status(200).json({ ok: true, note: 'handler error logged' });
        }
      }
    } else {
      log('no handler available after init:', initResult.error, initResult.detail || '');
      if (process.env.WEBHOOK_STRICT === '1') {
        return res.status(500).json({ ok: false, error: initResult.error, detail: initResult.detail || '' });
      } else {
        return res.status(200).json({ ok: true, note: 'no handler available; logged' });
      }
    }
  } catch (outer) {
    log('unexpected error in webhook:', outer && (outer.stack || outer.message));
    if (process.env.WEBHOOK_STRICT === '1') {
      return res.status(500).json({ ok: false, error: 'unexpected', detail: String(outer && (outer.stack || outer.message)) });
    } else {
      return res.status(200).json({ ok: true, note: 'unexpected error logged' });
    }
  }
};
