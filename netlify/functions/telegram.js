// netlify/functions/telegram.js
// Minimal webhook receiver for Telegram (Netlify function)
// Place this at repo root: netlify/functions/telegram.js

exports.handler = async function (event, context) {
  try {
    // Validate query token
    const qs = event.queryStringParameters || {};
    const token = qs.token || '';
    const expected = process.env.NETLIFY_WEBHOOK_SECRET || '';
    if (!expected || token !== expected) {
      return {
        statusCode: 403,
        body: JSON.stringify({ ok: false, error: 'invalid webhook token' }),
      };
    }

    // Accept only POST
    if (event.httpMethod !== 'POST') {
      return { statusCode: 200, body: 'OK' }; // respond to GET health-checks
    }

    // event.body is the raw JSON payload sent by Telegram
    let update;
    try {
      update = event.body ? JSON.parse(event.body) : {};
    } catch (err) {
      console.error('failed to parse body', err);
      return { statusCode: 400, body: 'bad request' };
    }

    // Log the update so you can see it in Netlify function logs
    console.log('Telegram update received:', JSON.stringify(update).slice(0, 10000));

    // TODO: forward update to your bot logic here (e.g. require a handler)
    // For now, just ack Telegram so it stops retrying.
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('Unhandled error in webhook func', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'internal' }) };
  }
};
