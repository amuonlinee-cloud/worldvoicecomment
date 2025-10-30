// netlify/functions/telegram.js
// Debug webhook for Telegram -> Netlify. Accepts GET and POST.
// Expects ?token=SECRET and process.env.NETLIFY_WEBHOOK_SECRET set in Netlify site settings.

exports.handler = async function (event, context) {
  try {
    const secretEnv = process.env.NETLIFY_WEBHOOK_SECRET || '';
    const token = (event.queryStringParameters && event.queryStringParameters.token) || '';

    // quick human-friendly logs:
    console.log('--- netlify debug telegram function ---');
    console.log('Method:', event.httpMethod);
    console.log('Path:', event.path);
    console.log('Query:', JSON.stringify(event.queryStringParameters || {}));
    console.log('Headers:', JSON.stringify(event.headers || {}));
    console.log('Body preview:', event.body ? event.body.slice(0, 1000) : null);

    if (!token) {
      return { statusCode: 400, body: 'Missing token query param' };
    }
    if (!secretEnv) {
      return { statusCode: 500, body: 'Missing NETLIFY_WEBHOOK_SECRET env on server' };
    }
    if (token !== secretEnv) {
      return { statusCode: 401, body: 'Invalid token' };
    }

    // Accept both GET (health) and POST (webhook)
    if (event.httpMethod === 'GET') {
      return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'debug ok', time: new Date().toISOString() }) };
    }

    // For POST, echo minimal info so you can see Telegram's payload
    let parsed = null;
    try { parsed = event.body ? JSON.parse(event.body) : null; } catch (e) { parsed = { raw: event.body }; }
    console.log('Parsed payload keys:', parsed ? Object.keys(parsed).slice(0,10) : null);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        received: !!event.body,
        keys: parsed ? Object.keys(parsed) : null,
        note: 'Webhook received and token OK'
      })
    };
  } catch (err) {
    console.error('Function error', err);
    return { statusCode: 500, body: 'Internal error' };
  }
};
