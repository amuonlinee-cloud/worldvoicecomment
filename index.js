// path: index.js
// Local express server for testing the webhook endpoint and for optional polling mode.
// Usage: cp .env.example .env && edit && npm start
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const { initBot } = require('./src/bot');

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || process.env.WEBHOOK_TOKEN || null;
const LOCAL_POLLING = process.env.LOCAL_POLLING === '1' || process.env.LOCAL_POLLING === 'true';

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

app.get('/api/telegram', (req, res) => {
  res.json({ ok: true, info: 'health - send POST with ?token=...' });
});

app.post('/api/telegram', async (req, res) => {
  const token = req.query.token || req.headers['x-webhook-secret'];
  if (!WEBHOOK_SECRET) {
    console.warn('[webhook] WEBHOOK_SECRET not set locally. Rejecting.');
    return res.status(403).send('WEBHOOK_SECRET not set');
  }
  if (String(token) !== String(WEBHOOK_SECRET)) {
    console.warn('[webhook] invalid token on local POST');
    return res.status(403).send('invalid token');
  }

  const update = req.body;
  if (!update) return res.status(400).send('no update');

  try {
    const botObj = await initBot();
    if (botObj && botObj.handleUpdate) {
      // handle but return quickly
      botObj.handleUpdate(update).catch(err => {
        console.error('[local] handleUpdate error', err?.message || err);
      });
      return res.status(200).send('ok');
    } else {
      console.error('[local] initBot missing handleUpdate');
      return res.status(500).send('bot not ready');
    }
  } catch (err) {
    console.error('[local] POST /api/telegram error', err?.message || err);
    return res.status(500).send('server error');
  }
});

app.listen(PORT, async () => {
  console.log(`[web] local server listening on http://localhost:${PORT}`);
  // initialize bot (may launch polling if LOCAL_POLLING=1)
  try {
    await initBot();
  } catch (err) {
    console.error('[web] bot init failed at startup', err?.message || err);
  }
  if (!LOCAL_POLLING) {
    console.log('[web] Running in webhook mode locally; POST to /api/telegram?token=YOUR_SECRET');
  } else {
    console.log('[web] Running in polling mode (LOCAL_POLLING=1)');
  }
});
