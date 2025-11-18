/*
  api/telegram.js  — debug-friendly webhook loader for Vercel
  Overwrites conflicted file to resolve merge; logs BOT_MODULE_PATH and tried paths.
*/
const path = require('path');

let botSingleton = null;
let botInitPromise = null;

function tryRequireAt(p) {
  try {
    const resolved = require.resolve(p);
    const m = require(resolved);
    return { module: m, resolved };
  } catch (e) {
    return { err: e, attempted: p };
  }
}

function tryRequireBotModule() {
  const tried = [];
  // 1) env override
  const envPath = process.env.BOT_MODULE_PATH;
  if (envPath) {
    const cand = path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
    tried.push(cand);
    const r = tryRequireAt(cand);
    if (r && r.module) return { module: r.module, resolved: r.resolved, tried };
    if (!cand.endsWith('.js')) {
      const candJs = cand + '.js';
      tried.push(candJs);
      const r2 = tryRequireAt(candJs);
      if (r2 && r2.module) return { module: r2.module, resolved: r2.resolved, tried };
    }
  }

  // 2) try common locations relative to project root (/var/task) and __dirname
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
    'dist/src/bot',
    './api/bot-loader.js'
  ];

  for (const r of roots) {
    for (const b of bases) {
      const candidate = path.resolve(r, b);
      tried.push(candidate);
      const rr = tryRequireAt(candidate);
      if (rr && rr.module) return { module: rr.module, resolved: rr.resolved, tried };
      if (!candidate.endsWith('.js')) {
        const candidateJs = candidate + '.js';
        tried.push(candidateJs);
        const rr2 = tryRequireAt(candidateJs);
        if (rr2 && rr2.module) return { module: rr2.module, resolved: rr2.resolved, tried };
      }
    }
  }

  // 3) package.json main fallback
  try {
    const pkg = require(path.resolve(process.cwd(), 'package.json'));
    if (pkg && pkg.main) {
      const candidate = path.resolve(process.cwd(), pkg.main);
      tried.push(candidate);
      const r = tryRequireAt(candidate);
      if (r && r.module) return { module: r.module, resolved: r.resolved, tried };
    }
  } catch (_) {}

  const err = new Error('Could not require bot module. Tried paths: ' + JSON.stringify(tried, null, 2));
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
      console.log('[webhook] BOT_MODULE_PATH:', process.env.BOT_MODULE_PATH || null);
      console.log('[webhook] loaded bot module from:', resolved);
      let factory = null;
      if (typeof mod.initBot === 'function') factory = mod.initBot;
      else if (mod.default && typeof mod.default.initBot === 'function') factory = mod.default.initBot;
      else if (mod && typeof mod.handleUpdate === 'function') {
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
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      now: new Date().toISOString(),
      BOT_MODULE_PATH: process.env.BOT_MODULE_PATH || null,
      cwd: process.cwd(),
      dirname: __dirname
    });
  }

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

  let update = null;
  try {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) update = req.body;
    else if (req.rawBody) update = JSON.parse(req.rawBody.toString());
    else update = JSON.parse(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
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
    if (err.tried) console.error('[webhook] tried paths:', err.tried);
    return res.status(500).send('Server error processing update');
  }
};

module.exports.config = {
  api: { bodyParser: { sizeLimit: '12mb' } }
};
