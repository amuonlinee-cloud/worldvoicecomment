// path: api/telegram.js
// Vercel serverless webhook handler for Telegram updates.
// Validates query token against WEBHOOK_SECRET and forwards update to bot.handleUpdate.

const express = require('express'); // serversless wrappers frequently support express-like handlers
const bodyParser = require('body-parser');

module.exports = async function handler(req, res) {
  // Minimal compatibility wrapper so file can be used both as a Vercel api and in local server if required.
  // For Vercel, you typically export (req,res) directly. This module export returns a function that Vercel will call.
  // However for safety, we detect and handle both direct invocation and module use.

  // Implementation expects req, res passed by platform.
  try {
    // Verify secret token passed as query param ?token=
    const expected = process.env.WEBHOOK_SECRET || process.env.WEBHOOK_TOKEN || null;
    const provided = (req.query && (req.query.token || req.query.secret)) || (req.headers && (req.headers['x-webhook-secret'] || req.headers['x-telegram-secret']));
    if (!expected) {
      console.warn('[webhook] WEBHOOK_SECRET not configured; refusing to accept updates for security.');
      res.status(403).send('Webhook secret not configured on server');
      return;
    }
    if (!provided || String(provided) !== String(expected)) {
      console.warn('[webhook] invalid webhook token attempt');
      res.status(403).send('Invalid token');
      return;
    }

    // parse body as JSON
    const update = req.body;
    if (!update) {
      res.status(400).send('No update payload');
      return;
    }

    // robustly require the bot module from possible paths
    let botModule = null;
    try {
      botModule = require('../src/bot');
    } catch (e1) {
      try {
        botModule = require('./src/bot');
      } catch (e2) {
        console.error('[webhook] cannot require src/bot:', e1.message, e2.message);
      }
    }

    if (!botModule || !botModule.initBot) {
      console.error('[webhook] bot module missing initBot; cannot handle update');
      // respond 200 to avoid repeated retries, but log
      res.status(200).send('bot not available');
      return;
    }

    const botObj = await botModule.initBot();
    if (!botObj) {
      console.error('[webhook] initBot returned nothing');
      res.status(200).send('init error');
      return;
    }

    // call handleUpdate asynchronously but respond immediately where possible
    try {
      // Pass the update to bot.handleUpdate
      if (botObj.handleUpdate) {
        // Do not await long: schedule processing and return 200 quickly.
        botObj.handleUpdate(update).catch((err) => {
          console.error('[webhook] handleUpdate failed:', err?.message || err);
        });
        res.status(200).send('ok');
        return;
      } else if (botObj.bot && botObj.bot.handleUpdate) {
        botObj.bot.handleUpdate(update).catch((err) => {
          console.error('[webhook] bot.handleUpdate failed:', err?.message || err);
        });
        res.status(200).send('ok');
        return;
      } else {
        console.error('[webhook] no handleUpdate method found on bot object');
        res.status(200).send('no handler');
        return;
      }
    } catch (err) {
      console.error('[webhook] update dispatch failed synchronously', err?.message || err);
      res.status(500).send('dispatch error');
      return;
    }
  } catch (err) {
    console.error('[webhook] top-level error', err?.message || err);
    try { res.status(500).send('internal error'); } catch (e) {}
    return;
  }
};
