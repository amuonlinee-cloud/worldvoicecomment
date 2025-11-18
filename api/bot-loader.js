// api/bot-loader.js
// Lazy loader that tries several candidate paths and logs full error details.
// Exports initBot() which either returns a Telegraf bot or throws with detailed info.

const path = require('path');

const candidates = [
  './src/bot',
  './src/bot.js',
  './bot',
  './bot.js',
  './dist/src/bot',
  '../src/bot',
  '../bot',
  './index',
  './index.js',
  './api/src/bot',
  './api/bot'
];

function tryRequireCandidate(relPath) {
  const abs = path.resolve(process.cwd(), relPath);
  try {
    const mod = require(abs);
    return { ok: true, module: mod, resolved: abs };
  } catch (err) {
    return { ok: false, error: err, attempted: abs };
  }
}

module.exports.initBot = async function initBot() {
  const results = [];
  for (const c of candidates) {
    const r = tryRequireCandidate(c);
    results.push(r);
    if (r.ok) {
      // Normalize shapes
      const m = r.module;
      try {
        if (typeof m.initBot === 'function') {
          const maybe = m.initBot();
          const bot = (maybe && typeof maybe.then === 'function') ? await maybe : maybe;
          if (bot && typeof bot.handleUpdate === 'function') return bot;
          throw new Error('initBot returned invalid bot (missing handleUpdate)');
        } else if (m && typeof m.handleUpdate === 'function') {
          return m;
        } else if (m && m.default && typeof m.default.initBot === 'function') {
          const maybe = m.default.initBot();
          const bot = (maybe && typeof maybe.then === 'function') ? await maybe : maybe;
          if (bot && typeof bot.handleUpdate === 'function') return bot;
          throw new Error('default.initBot returned invalid bot');
        } else {
          throw new Error('module loaded but does not export initBot() or a bot instance');
        }
      } catch (innerErr) {
        // If module loaded but initBot threw, return debug info
        const info = {
          message: innerErr.message,
          stack: innerErr.stack,
          resolved: r.resolved,
          note: 'module required successfully but initBot() or returned bot threw'
        };
        const err = new Error('initBot failure; see loader.debug');
        err.loaderDebug = info;
        throw err;
      }
    }
  }

  // If we get here, none of the candidates required successfully.
  const aggregated = results.map(x => ({
    attempted: x.attempted || x.resolved,
    ok: !!x.ok,
    error: x.ok ? null : (x.error && x.error.message)
  }));
  const msg = 'Could not require any candidate module. Attempts: ' + JSON.stringify(aggregated, null, 2);
  const err = new Error(msg);
  err.loaderAttempts = aggregated;
  throw err;
};
