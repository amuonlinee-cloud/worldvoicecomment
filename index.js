// index.js — local + webhook entry
const express = require('express');
const bodyParser = require('body-parser');

(async () => {
  try {
    const { initBot } = require('./src/bot');
    if (!initBot) throw new Error('initBot export not found in ./src/bot');

    const bot = await initBot();
    console.log('[bot] initBot returned');

    // debug: confirm token and connectivity
    try {
      const me = await bot.telegram.getMe();
      console.log('[bot] connected as:', me.username || me.id);
    } catch (e) {
      console.error('[bot] getMe failed — token/connectivity problem:', e && e.message);
    }

    // Launch polling when LOCAL_POLLING is set to '1' (string) or 1 (number)
    if (process.env.LOCAL_POLLING === '1' || process.env.LOCAL_POLLING === 'true' || process.env.LOCAL_POLLING === 1) {
      await bot.launch();
      console.log('[bot] launched in POLLING mode');
    } else {
      console.log('[bot] LOCAL_POLLING not set — bot not launched in polling (webhook expected)');
    }

    // small express app for local debugging and for webhook usage (Vercel uses its own handler,
    // but this keeps parity for local testing)
    const app = express();
    app.use(bodyParser.json());

    app.get('/', (req, res) => res.send('ok'));

    // webhook endpoint (Vercel-style: POST /api/telegram?token=SECRET)
    app.post('/api/telegram', async (req, res) => {
      const qToken = req.query.token || req.headers['x-webhook-secret'];
      if (process.env.WEBHOOK_SECRET && qToken !== process.env.WEBHOOK_SECRET) {
        console.warn('[webhook] invalid token', qToken);
        return res.status(403).send('invalid token');
      }
      try {
        await bot.handleUpdate(req.body);
        return res.json({ ok: true });
      } catch (e) {
        console.error('[webhook] handleUpdate error', e && (e.stack || e.message));
        return res.status(500).json({ ok: false, error: e && e.message });
      }
    });

    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`[web] local server listening on http://localhost:${port}`));

    // graceful stop (optional)
    process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
    process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });

  } catch (err) {
    console.error('Fatal start error', err && (err.stack || err.message));
    process.exit(1);
  }
})();
