// netlify/functions/telegram.js
const { URL } = require('url');
const { Telegraf } = require('telegraf');

// NOTE: make sure TELEGRAM_BOT_TOKEN and NETLIFY_WEBHOOK_SECRET are set in Netlify env
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.NETLIFY_WEBHOOK_SECRET;

if (!BOT_TOKEN) {
  console.error('MISSING TELEGRAM_BOT_TOKEN env');
}

// Keep bot instance cached across warm Lambda invocations
let bot;
function getBot() {
  if (bot) return bot;
  bot = new Telegraf(BOT_TOKEN);

  // IMPORTANT: load your bot handlers here (or require your bot.js that exports a register function)
  // Example: require('../../src/bot_factory')(bot)  OR initialize inside this file.
  //
  // If you already have a function initBot() in src/bot.js that returns a Telegraf instance,
  // you can require and call it here instead. For simplicity you can have your src/bot.js expose
  // a "registerHandlers" function that receives bot and attaches all handlers.

  // Example:
  // const register = require('../../src/netlify_bot_init');
  // register(bot);

  // If your current src/bot.js returns a full Telegraf instance and calls bot.launch(),
  // do NOT call launch() here. Instead refactor so this function only registers handlers.
  //
  return bot;
}

exports.handler = async function (event, context) {
  try {
    // verify webhook secret in query param
    const url = new URL((process.env.NETLIFY_SITE_URL || 'https://example.com') + (event.path || ''));
    // Netlify passes query params on event.queryStringParameters
    const token = (event.queryStringParameters && event.queryStringParameters.token) || '';

    if (!WEBHOOK_SECRET || token !== WEBHOOK_SECRET) {
      return {
        statusCode: 404,
        body: 'Not found'
      };
    }

    // Create bot if not already
    const bot = getBot();

    // parse body (incoming Telegram update)
    const update = event.body && typeof event.body === 'string' ? JSON.parse(event.body) : event.body;

    // Telegraf expects to get update and return promise
    await bot.handleUpdate(update, context);

    return {
      statusCode: 200,
      body: 'OK'
    };
  } catch (err) {
    console.error('netlify webhook error', err);
    return {
      statusCode: 500,
      body: 'Internal Server Error'
    };
  }
};
