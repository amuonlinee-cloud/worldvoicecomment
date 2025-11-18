/*
 api/bot-loader.js
 Simple loader that exports initBot() and points to the real bot file.
 Edit the require path below ONLY if your bot is NOT at src/bot.js
*/
let mod = null;
try {
  mod = require('../src/bot'); // <= change this if your bot lives somewhere else
} catch (e1) {
  try { mod = require('../bot'); } catch (e2) {
    throw new Error('bot-loader: could not require ../src/bot or ../bot; adjust path.');
  }
}

if (!mod) throw new Error('bot-loader: loaded module is null');

if (typeof mod.initBot === 'function') {
  module.exports.initBot = async () => mod.initBot();
} else if (mod.default && typeof mod.default.initBot === 'function') {
  module.exports.initBot = async () => mod.default.initBot();
} else if (mod && typeof mod.handleUpdate === 'function') {
  module.exports.initBot = async () => mod;
} else {
  throw new Error('bot-loader: loaded module does not export initBot() or a bot instance');
}
