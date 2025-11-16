// api/telegram.js
// Robust Vercel webhook -> tries multiple require locations and supports BOT_MODULE_PATH env var.
// Keeps verbose logs so you can see what path succeeded in Vercel logs.

const path = require('path');

let botSingleton = null;
let botInitPromise = null;

function tryRequireAt(p) {
  try {
    const m = require(p);
    if (m) return m;
    return null;
  } catch (e) {
    // return the error so we can report it later
    return e;
  }
}

function tryRequireBotModule() {
  // If user set BOT_MODULE_PATH env var, try that first (relative to project root)
  const envPath = process.env.BOT_MODULE_PATH;
  const tried = [];
  if (envPath) {
    const candidate = path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
    tried.push(candidate);
    const m = tryRequireAt(candidate);
    if (m && !(m instanceof Error)) return { module: m, resolved: candidate };
  }

  // Candidate list (both relative to project root and to this file's dir)
  const roots = [process.cwd(), __dirname];
  const bases = [
    'src/bot',
    'src/bot.js',
    'bot',
    'bot.js',
    'src/index',
    'src/index.js',
    'index',
    'index.js',
    './dist/src/bot', // in case built output is there
  ];

  for (const r of roots) {
    for (const b of bases) {
      const candidate = path.resolve(r, b);
      tried.push(candidate);
      const m = tryRequireAt(candidate);
      if (m && !(m instanceof Error)) {
        return { module: m, resolved: candidate };
      }
    }
  }

  // last-ditch: try package.json main if present
  try {
    const pkg = require(path.resolve(process.cwd(), 'package.json'));
    if (pkg && pkg.main) {
      const candidate = path.resolve(process.cwd(), pkg.main);
      tried.push(candidate);
      const m = tryRequireAt(candidate);
      if (m && !(m instanceof Error)) return { module: m, resolved: candidate };
    }
  } catch (_) {}

  const err = new Error('Could not require bot module from tried paths: ' + tried.join(', '));
  err.tried = tried;
  throw err;
}

async function getBotSingleton() {
  if (botSingleton) return botSingleton;
  if (!botInitPromise) {
    botInitPromise = (async () => {
      const info = tryRequireBotModule();
      const mod = info.module;
      const resolved = info.resolved;
      console.log('[webhook] loaded bot module from:', resolved);
      // possible shapes:
      // 1) module.exports.initBot = function
      // 2) module.exports.default.initBot = function
      // 3) module.exports = Telegraf bot instance
      // 4) module.exports.initBot returns a bot or a promise resolving to a bot
      let factory = null;
      if (typeof mod.initBot === 'function') factory = mod.initBot;
      else if (mod.default && typeof mod.default.initBot === 'function') factory = mod.default.initBot;
      else if (typeof mod === 'function' && typeof mod.handleUpdate === 'function') {
        // mod itself is a bot instance
        botSingleton = mod;
        return botSingleton;
      } else if (mod && typeof mod.handleUpdate === 'function') {
        botSingleton = mod;
        return botSingleton;
      } else {
        throw new Error('Bot module found but does not export initBot() or a bot instance.');
      }

      const maybeBot = factory();
      const bot = (maybeBot && typeof maybeBot.then === 'function') ? await maybeBot : maybeBot;
      if (!bot || typeof bot.handleUpdate !== 'function') {
        throw new Error('initBot did not return a valid Telegraf bot (missing handleUpdate).');
      }
      botSingleton = bot;
      return botSingleton;
    })();
  }
  return botInitPromise;
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, now: new Date().toISOString() });

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,GET');
    return res.status(405).send('Method Not Allowed');
  }

  const expected = process.env.WEBHOOK_SECRET || process.env.VERCEL_WEBHOOK_SECRET || process.env.NETLIFY_WEBHOOK_SECRET;
  const provided = (req.query && (req.query.token || req.query.secret)) || null;
  if (expected) {
    if (!provided || provided !== expected) {
      console.error('[webhook] Missing/invalid secret. Provided:', provided ? '[REDACTED]' : 'none');
      return res.status(403).send('Missing or wrong token.');
    }
  }

  // robust body parsing (Vercel usually provides req.body)
  let update = null;
  try {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      update = req.body;
    } else if (req.rawBody) {
      try { update = JSON.parse(req.rawBody.toString()); } catch (e) { update = req.body; }
    } else {
      try { update = JSON.parse(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {})); } catch(e) { update = req.body; }
    }
  } catch (e) {
    console.error('[webhook] Failed to parse body:', e && (e.stack || e.message));
    return res.status(400).send('Bad Request - invalid JSON');
  }

  if (!update || Object.keys(update).length === 0) {
    console.error('[webhook] Empty update payload received');
    return res.status(400).send('Bad Request - empty update');
  }

  try {
    const bot = await getBotSingleton();
    await bot.handleUpdate(update, undefined);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('[webhook] Failed to handle update:', err && (err.stack || err.message));
    // Show which module was attempted (if available)
    if (err.tried) console.error('[webhook] tried paths:', err.tried.slice(0,10));
    return res.status(500).send('Server error processing update');
  }
};

module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '12mb'
    }
  }
};
