// api/telegram.js (debug version - logs loader errors)
const botLoader = require('./bot-loader');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, now: new Date().toISOString() });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,GET');
    return res.status(405).send('Method Not Allowed');
  }

  let update;
  try { update = req.body && Object.keys(req.body).length ? req.body : JSON.parse(req.rawBody || '{}'); } catch (e) { update = req.body; }

  if (!update || Object.keys(update).length === 0) {
    console.error('[webhook] empty update');
    return res.status(400).send('empty update');
  }

  try {
    const bot = await botLoader.initBot();
    await bot.handleUpdate(update, undefined);
    return res.status(200).send('OK');
  } catch (err) {
    // Very verbose debug logging for loader errors
    console.error('[webhook] Bot init/load error:', err && (err.stack || err.message));
    if (err.loaderDebug) {
      console.error('[webhook] loaderDebug (initBot failure):', JSON.stringify(err.loaderDebug, null, 2));
    }
    if (err.loaderAttempts) {
      console.error('[webhook] loaderAttempts (require failures):', JSON.stringify(err.loaderAttempts, null, 2));
    }
    // If the required module itself threw an exception earlier, it might be nested in err.cause or err.error
    return res.status(500).send('Server error - see function logs');
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '12mb' } } };
