// path: src/bot.js
// Telegraf bot entry. Exports initBot() which returns { bot, handleUpdate }
// Safe to require even if envs missing.

const { Telegraf, Markup } = require('telegraf');
const db = require('./database');
const utils = require('./utils');

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(s => Number(s));
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const LOCAL_POLLING = process.env.LOCAL_POLLING === '1' || process.env.LOCAL_POLLING === 'true';

// temporary in-memory state for user flows
const pendingVoiceForThread = new Map(); // key: telegramId -> {thread_id}
const pendingReplyForComment = new Map(); // key: telegramId -> {comment_id}
const pendingPaymentRequest = new Map(); // key: telegramId -> {payment_request_id}

let _botInstance = null;

function createBotInstance() {
  if (!_botInstance) {
    if (!BOT_TOKEN) {
      console.warn('[bot] TELEGRAM_BOT_TOKEN not set — bot will not fully initialize until token is provided.');
      // create a minimal stub that won't do API calls
      _botInstance = new Telegraf(''); // empty token ok for construction but will error on network calls
    } else {
      _botInstance = new Telegraf(BOT_TOKEN, { telegram: { agent: undefined } });
    }
  }
  return _botInstance;
}

async function initBot() {
  const bot = createBotInstance();

  // attach admin notifier from db
  db.setAdminNotifier(async (message) => {
    try {
      const admins = ADMIN_IDS;
      if (!admins || !admins.length) {
        console.log('[bot] No ADMIN_IDS configured; admin notification:', message);
        return;
      }
      for (const adminId of admins) {
        try {
          await bot.telegram.sendMessage(adminId, `Admin notice:\n${message}`);
        } catch (err) {
          console.error('[bot] failed to notify admin', adminId, err?.message || err);
        }
      }
    } catch (err) {
      console.error('[bot] adminNotifier error', err?.message || err);
    }
  });

  // command handlers
  bot.start(async (ctx) => {
    try {
      const user = ctx.from || {};
      await db.ensureUser(user);
      await ctx.reply(`Welcome ${user.first_name || user.username || 'friend'}! Send me a YouTube or TikTok link and I'll track it. Use /help for commands.`);
    } catch (err) {
      console.error('[bot] /start error', err?.message || err);
      await ctx.reply('Sorry, something went wrong registering you. Contact admin.');
      await db.notifyAdmins(`[BOT ERROR] /start failed: ${err?.message}`, { user: ctx.from });
    }
  });

  bot.hears(/https?:\/\//i, async (ctx) => {
    // user pasted a link
    try {
      const text = ctx.message.text || '';
      const url = utils.extractFirstUrl(text);
      if (!url || !utils.isSupportedLink(url)) {
        return ctx.reply('I only support YouTube and TikTok links for now. Paste a supported link.');
      }
      const normalized = utils.normalizeVideoUrl(url);
      const thread = await db.findOrCreateThread(url, ctx.from && ctx.from.id, normalized);
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add voice comment', `add_voice:${thread.id}`), Markup.button.callback('🎧 Listen comments', `listen:${thread.id}:0`)]
      ]);
      await ctx.reply(`Thread tracked: ${thread.social_link}`, kb);
    } catch (err) {
      console.error('[bot] link handler error', err?.message || err);
      await ctx.reply('Failed to process link. Try again later.');
      await db.notifyAdmins(`[BOT ERROR] link handling failed: ${err?.message}`, { ctx_from: ctx.from });
    }
  });

  // callback queries handler
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery && ctx.callbackQuery.data;
    const from = ctx.callbackQuery && ctx.callbackQuery.from;
    if (!data) return ctx.answerCbQuery();
    try {
      if (data.startsWith('add_voice:')) {
        const thread_id = Number(data.split(':')[1]);
        pendingVoiceForThread.set(from.id, { thread_id });
        await ctx.answerCbQuery('Please send a voice note or audio file now (voice message or audio).');
        await ctx.reply('Send your voice message for this thread now. You can record a Telegram voice message or send an audio file.');
        return;
      }
      if (data.startsWith('listen:')) {
        const parts = data.split(':');
        const thread_id = Number(parts[1]);
        const offset = Number(parts[2] || 0);
        await ctx.answerCbQuery();
        const comments = await db.listCommentsForThread(thread_id, 15, offset);
        if (!comments || comments.length === 0) {
          await ctx.reply('No comments yet for this thread.');
          return;
        }
        for (const comment of comments) {
          // send voice message with inline buttons
          const caption = `By: ${comment.first_name || comment.username || comment.telegram_id}\nPosted: ${new Date(comment.created_at).toLocaleString()}\nID: ${comment.id}`;
          const buttons = [
            [Markup.button.callback('↩ Reply', `reply:${comment.id}`), Markup.button.callback('⭐ Favorite', `fav:${comment.id}`)],
            [Markup.button.callback('😊 React', `react_menu:${comment.id}`), Markup.button.callback('🔗 Share', `share:${comment.id}`)]
          ];
          try {
            await ctx.replyWithVoice(comment.telegram_file_id, { caption, reply_markup: { inline_keyboard: buttons } });
          } catch (e) {
            // fallback: send text if cannot send voice file
            await ctx.reply(`${caption}\n[file unavailable]`, Markup.inlineKeyboard(buttons));
          }
        }
        // More button
        const moreKb = Markup.inlineKeyboard([
          [Markup.button.callback('More ➕', `listen:${thread_id}:${offset + comments.length}`)]
        ]);
        await ctx.reply('--- Page end ---', moreKb);
        return;
      }
      if (data.startsWith('reply:')) {
        const comment_id = Number(data.split(':')[1]);
        pendingReplyForComment.set(from.id, { comment_id });
        await ctx.answerCbQuery('You can reply with text or a voice message now.');
        await ctx.reply('Send your reply (text or voice).');
        return;
      }
      if (data.startsWith('fav:')) {
        const comment_id = Number(data.split(':')[1]);
        await db.toggleFavorite(comment_id, from.id);
        await ctx.answerCbQuery('Toggled favorite');
        return;
      }
      if (data.startsWith('react_menu:')) {
        const comment_id = Number(data.split(':')[1]);
        const kb = Markup.inlineKeyboard([
          [Markup.button.callback('👍', `react:${comment_id}:👍`), Markup.button.callback('❤️', `react:${comment_id}:❤️`), Markup.button.callback('😂', `react:${comment_id}:😂`)]
        ]);
        await ctx.reply('Choose reaction:', kb);
        await ctx.answerCbQuery();
        return;
      }
      if (data.startsWith('react:')) {
        const parts = data.split(':');
        const comment_id = Number(parts[1]);
        const emoji = parts[2];
        await db.addReaction(comment_id, from.id, emoji);
        await ctx.answerCbQuery('Reaction recorded');
        return;
      }
      if (data.startsWith('share:')) {
        const comment_id = Number(data.split(':')[1]);
        const shortcode = require('./utils').encodeShortcodeForComment(comment_id);
        await ctx.answerCbQuery();
        await ctx.reply(`Shareable code: ${shortcode}\nOthers can use this to find the comment.`);
        return;
      }
      if (data.startsWith('buy_package:')) {
        // simple inline handling
        const parts = data.split(':');
        const pkg = parts[1];
        const created = await db.createPaymentRequest({ telegram_id: from.id, package_name: pkg, comments_amount: 50, amount: 9.99, method: 'manual' });
        pendingPaymentRequest.set(from.id, { payment_request_id: created.id });
        await ctx.reply(`Payment request created (#${created.id}). Please send proof (screenshot or file).`);
        await ctx.answerCbQuery();
        return;
      }
      await ctx.answerCbQuery();
    } catch (err) {
      console.error('[bot] callback_query error', err?.message || err);
      await ctx.answerCbQuery('Operation failed. Try again later.');
      await db.notifyAdmins(`[BOT ERROR] callback processing failed: ${err?.message}`, { data, from });
    }
  });

  // text replies & voice messages handling for pending flows
  bot.on(['voice', 'audio', 'message'], async (ctx) => {
    try {
      const from = ctx.from;
      // Payment proof flow
      if (pendingPaymentRequest.has(from.id) && (ctx.message.photo || ctx.message.document || ctx.message.voice || ctx.message.audio)) {
        const pending = pendingPaymentRequest.get(from.id);
        const paymentRequestId = pending.payment_request_id;
        // store proof file id prefer document or photo last size or voice.file_id
        let proofId = null;
        if (ctx.message.document) proofId = ctx.message.document.file_id;
        else if (ctx.message.audio) proofId = ctx.message.audio.file_id;
        else if (ctx.message.voice) proofId = ctx.message.voice.file_id;
        else if (ctx.message.photo) {
          const photoArr = ctx.message.photo;
          proofId = photoArr[photoArr.length - 1].file_id;
        }
        if (proofId) {
          await db.attachPaymentProof(paymentRequestId, proofId);
          pendingPaymentRequest.delete(from.id);
          await ctx.reply('Payment proof received. Admins will verify and update your request.');
        } else {
          await ctx.reply('Could not detect a file. Send a photo, document, audio, or voice message as proof.');
        }
        return;
      }

      // Add voice comment flow
      if (pendingVoiceForThread.has(from.id) && (ctx.message.voice || ctx.message.audio || ctx.message.document)) {
        const pending = pendingVoiceForThread.get(from.id);
        const thread_id = pending.thread_id;
        // get file id & duration
        let file_id = null;
        let duration = null;
        if (ctx.message.voice) {
          file_id = ctx.message.voice.file_id;
          duration = ctx.message.voice.duration;
        } else if (ctx.message.audio) {
          file_id = ctx.message.audio.file_id;
          duration = ctx.message.audio.duration || null;
        } else if (ctx.message.document) {
          file_id = ctx.message.document.file_id;
        }
        if (!file_id) {
          await ctx.reply('Could not find a file. Please send a voice message or audio file.');
          return;
        }
        const stored = await db.addVoiceComment({
          thread_id,
          telegram_id: from.id,
          username: from.username || null,
          first_name: from.first_name || null,
          telegram_file_id: file_id,
          duration
        });
        pendingVoiceForThread.delete(from.id);
        const shortcode = utils.encodeShortcodeForComment(stored.id);
        await ctx.reply(`Stored voice comment. Shareable code: ${shortcode}`);
        return;
      }

      // Reply flow
      if (pendingReplyForComment.has(from.id)) {
        const pending = pendingReplyForComment.get(from.id);
        const comment_id = pending.comment_id;
        // if message has text or voice or audio or photo
        let reply_text = ctx.message.text || null;
        let telegram_file_id = null;
        let reply_photo_url = null;
        if (ctx.message.voice) {
          telegram_file_id = ctx.message.voice.file_id;
        } else if (ctx.message.audio) {
          telegram_file_id = ctx.message.audio.file_id;
        } else if (ctx.message.document) {
          telegram_file_id = ctx.message.document.file_id;
        } else if (ctx.message.photo) {
          const photo = ctx.message.photo[ctx.message.photo.length - 1];
          telegram_file_id = photo.file_id;
        }
        await db.addReply({
          comment_id,
          replier_telegram_id: from.id,
          replier_username: from.username || null,
          replier_first_name: from.first_name || null,
          reply_text,
          reply_photo_url,
          telegram_file_id
        });
        pendingReplyForComment.delete(from.id);
        await ctx.reply('Reply saved. Thank you!');
        return;
      }

      // Default help
      if (ctx.message.text && ctx.message.text.startsWith('/')) {
        // allow commands to be handled by command handlers
        return;
      }

      // Otherwise ignore or guide
      await ctx.reply('Send a supported video link (YouTube/TikTok) or use /help for available commands.');
    } catch (err) {
      console.error('[bot] message handler error', err?.message || err);
      await ctx.reply('An error occurred processing your message.');
      await db.notifyAdmins(`[BOT ERROR] message processing failed: ${err?.message}`, { from: ctx.from });
    }
  });

  // commands: /myfavorites /mycomments /help /buy
  bot.command('myfavorites', async (ctx) => {
    try {
      const list = await db.listFavoritesForUser(ctx.from.id);
      if (!list || list.length === 0) return ctx.reply('You have no favorites yet.');
      const lines = list.slice(0, 20).map(r => `• comment ${r.comment_id} (saved at ${new Date(r.created_at).toLocaleString()})`);
      await ctx.reply(lines.join('\n'));
    } catch (err) {
      console.error('[bot] /myfavorites error', err?.message || err);
      await ctx.reply('Failed to fetch favorites.');
    }
  });

  bot.command('mycomments', async (ctx) => {
    try {
      const dbClient = require('./database');
      const sup = dbClient.initSupabase();
      // naive query via direct table
      const { data } = await sup.from('voice_comments').select('*').eq('telegram_id', ctx.from.id).order('created_at', { ascending: false }).limit(50);
      if (!data || data.length === 0) return ctx.reply('You have not posted comments yet.');
      for (const c of data) {
        try {
          await ctx.replyWithVoice(c.telegram_file_id, { caption: `ID: ${c.id} | Posted: ${new Date(c.created_at).toLocaleString()}` });
        } catch (e) {
          await ctx.reply(`ID: ${c.id} | file not available`);
        }
      }
    } catch (err) {
      console.error('[bot] /mycomments error', err?.message || err);
      await ctx.reply('Failed to fetch your comments.');
    }
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(`
Commands:
  /start - register and welcome
  /help - this message
  /myfavorites - list your favorites
  /mycomments - list your submitted comments
  /buy - buy a comments package
Flow:
- Send a YouTube/TikTok link to track a thread.
- Use 'Add voice comment' to attach a voice message to a thread.
- Use 'Listen comments' to browse and interact with comments.
`);
  });

  bot.command('buy', async (ctx) => {
    try {
      // show sample packages
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback('Small pack - 10 comments - $2.99', 'buy_package:small')],
        [Markup.button.callback('Medium pack - 50 comments - $9.99', 'buy_package:medium')],
        [Markup.button.callback('Large pack - 200 comments - $29.99', 'buy_package:large')]
      ]);
      await ctx.reply('Choose a package:', kb);
    } catch (err) {
      console.error('[bot] /buy error', err?.message || err);
      await ctx.reply('Failed to show packages.');
    }
  });

  // error telemetry
  bot.catch(async (err) => {
    console.error('[bot] Telegraf error', err?.message || err);
    await db.notifyAdmins(`[BOT ERROR] Telegraf caught exception: ${err?.message}`, {});
  });

  // Launch if polling mode requested
  if (LOCAL_POLLING) {
    try {
      await bot.launch();
      console.log('[bot] launched in polling mode');
    } catch (err) {
      console.error('[bot] failed to launch in polling mode', err?.message || err);
    }
  } else {
    console.log('[bot] initBot done (webhook mode expected)');
  }

  return { bot, handleUpdate: async (update) => bot.handleUpdate(update) };
}

module.exports = { initBot, createBotInstance };
