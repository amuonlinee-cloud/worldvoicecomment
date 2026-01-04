// src/bot.js
// Full bot.js — main Telegraf flows for WorldVoiceComment
// Requires matching src/database.js and src/utils.js to exist in the same project.

const { Telegraf, Markup } = require('telegraf');
const db = require('./database');   // will provide matching implementation next
const utils = require('./utils');   // will provide matching implementation next

// ----- Config / env vars -----
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const SERVICE_WHATSAPP = process.env.WHATSAPP_ADMIN || null; // optional admin contact

// Payment recipient info (display to users)
const PAY_TELEBIRR_NUMBER = process.env.PAY_TELEBIRR_NUMBER || '0962058608';
const PAY_CBE_NUMBER = process.env.PAY_CBE_NUMBER || '1000555367884';
const PAY_RECIPIENT_NAME = process.env.PAY_RECIPIENT_NAME || 'WorldVoiceComment';

// Packages available for purchase
const PAYMENT_PACKAGES = [
  { id: 'p1', label: '25 comments — 12 ETB', credits: 25, amount: 12 },
  { id: 'p2', label: '60 comments — 27 ETB', credits: 60, amount: 27 },
  { id: 'p3', label: '130 comments — 49 ETB', credits: 130, amount: 49 },
  { id: 'p4', label: '240 comments — 89 ETB', credits: 240, amount: 89 }
];

// ----- Helpers -----
function isAdmin(telegramId) {
  return ADMIN_IDS.includes(Number(telegramId));
}

// Pending actions map for each user: Map<telegramId, pendingObject>
const Pending = new Map();

// Build the main keyboard shown to users; admin sees extra Post button
function buildMainKeyboard(telegramId) {
  const admin = isAdmin(telegramId);
  const rows = [
    ['🎥 Add Comment', '🎧 Listen Comments'],
    ['💬 My Comments', '🔎 Search Code'],
    ['⭐ Favorites', '🔔 Notifications'],
    ['🛒 Buy', '📞 Support'],
    ['💰 Balance'],
  ];
  // Make Post visible only to admins
  if (admin) rows[0].push('📣 Post');
  return Markup.keyboard(rows, { columns: 2 }).resize();
}

// Inline markup for comment (shows reply, favorite, show replies, report, reactions, delete if owner or admin)
async function buildCommentInline(commentId, fromUserId) {
  const buttons = [];

  // Reply & Favorite row
  buttons.push([
    Markup.button.callback('💬 Reply', `reply_menu|${commentId}`),
    Markup.button.callback('☆ Favorite', `fav_toggle|${commentId}`)
  ]);

  // Show replies & Report
  // show replies count
  const replyCount = await db.countRepliesForComment(commentId).catch(()=>0);
  buttons.push([
    Markup.button.callback(`▶ Replies (${replyCount})`, `show_replies|${commentId}|1`),
    Markup.button.callback('🚩 Report', `report_comment|${commentId}`)
  ]);

  // Reaction row (simple set)
  buttons.push([
    Markup.button.callback('❤️', `react|comment|${commentId}|heart`),
    Markup.button.callback('😂', `react|comment|${commentId}|laugh`),
    Markup.button.callback('😮', `react|comment|${commentId}|wow`)
  ]);

  // Delete if owner or admin
  const comment = await db.getCommentById(commentId).catch(()=>null);
  if (comment) {
    if (Number(comment.user_telegram_id) === Number(fromUserId) || isAdmin(fromUserId)) {
      buttons.push([ Markup.button.callback('🗑 Delete', `delete_comment|${commentId}`) ]);
    }
  }

  return Markup.inlineKeyboard(buttons);
}

// Inline markup for reply (only reactions + report; admin can delete)
function buildReplyInline(replyId, commentId, fromUserId) {
  const rows = [
    [ Markup.button.callback('❤️', `react|reply|${replyId}|heart`), Markup.button.callback('🚩 Report', `report_reply|${replyId}|${commentId}`) ]
  ];
  if (isAdmin(fromUserId)) rows.push([ Markup.button.callback('🗑 Admin Delete', `admin_delete_reply|${replyId}`) ]);
  return Markup.inlineKeyboard(rows);
}

// sendThreadPreview: shows link and thumbnail if utils returns thumbnail
async function sendThreadPreview(ctx, thread) {
  if (!thread) return;
  try {
    const normalized = thread.normalized_link || thread.original_link;
    const info = await utils.normalizeVideoUrl(thread.original_link || normalized);
    if (info && info.thumbnail) {
      await ctx.replyWithPhoto(info.thumbnail, { caption: thread.original_link || normalized });
      return;
    }
    await ctx.reply(thread.original_link || normalized);
  } catch (e) {
    await ctx.reply(thread.original_link || 'Video link');
  }
}

// Build payment keyboard for confirm step
function buildPaymentKeyboard(paymentRequestId) {
  return Markup.inlineKeyboard([
    [ Markup.button.callback('Copy TELEBIRR', `copy_number|${PAY_TELEBIRR_NUMBER}`), Markup.button.callback('Copy CBE', `copy_number|${PAY_CBE_NUMBER}`) ],
    [ Markup.button.callback('Upload Proof', `upload_proof|${paymentRequestId}`) ]
  ]);
}

// Encode/Decode shortcodes shown to users are handled in utils
// utils.encodeShortCode / utils.decodeShortCode

// ----- Initialize Bot -----
function initBot() {
  const bot = new Telegraf(BOT_TOKEN);

  // Start
  bot.start(async (ctx) => {
    try {
      // ensure user exists
      await db.ensureUser(ctx.from).catch(()=>null);
      await ctx.reply(`Welcome ${ctx.from.first_name || ''}!`, buildMainKeyboard(ctx.from.id));
    } catch (e) {
      console.error('start err', e);
      await ctx.reply('Welcome!', buildMainKeyboard(ctx.from.id));
    }
  });

  // POST (admin-only) - text/photo/voice
  bot.hears('📣 Post', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    Pending.set(ctx.from.id, { type: 'await_admin_post' });
    return ctx.reply('Send the post content (text/photo/voice). It will be broadcast to users.');
  });

  // Support
  bot.hears(/[📞] Support|support/i, async (ctx) => {
    if (SERVICE_WHATSAPP) return ctx.reply(`Contact admin: ${SERVICE_WHATSAPP}`);
    return ctx.reply('Contact admin via Telegram.');
  });

  // Buy flow
  bot.hears(/🛒 Buy|buy/i, async (ctx) => {
    const inline = PAYMENT_PACKAGES.map(p => [ Markup.button.callback(p.label, `pkg_select|${p.id}`) ]);
    inline.push([ Markup.button.callback('Contact admin', `contact_admin`) ]);
    await ctx.reply('Choose a package:', Markup.inlineKeyboard(inline));
  });

  // Balance
  bot.hears(/💰 Balance|balance/i, async (ctx) => {
    try {
      const balance = await db.getBalance(ctx.from.id);
      await ctx.reply(`Your available comments: *${balance}*`, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('balance err', e);
      await ctx.reply('Could not fetch balance.');
    }
  });

  // Add Comment
  bot.hears(/🎥 Add Comment|add comment/i, async (ctx) => {
    Pending.set(ctx.from.id, { type: 'await_link_add' });
    return ctx.reply('Send the TikTok / YouTube link you want to add a voice comment for.');
  });

  // Listen Comments
  bot.hears(/🎧 Listen Comments|listen comments/i, async (ctx) => {
    Pending.set(ctx.from.id, { type: 'await_link_listen' });
    return ctx.reply('Send the TikTok / YouTube link to listen comments.');
  });

  // My Comments
  bot.hears(/💬 My Comments|my comments/i, async (ctx) => {
    try {
      const rows = await db.listMyComments(ctx.from.id);
      if (!rows || rows.length === 0) return ctx.reply('You have no comments yet.');
      for (const c of rows) {
        // show thread preview if possible
        if (c.thread_id) {
          const thread = await db.getThreadById(c.thread_id).catch(()=>null);
          if (thread) await sendThreadPreview(ctx, thread);
        }
        // send voice then code under it
        if (c.file_id) await ctx.replyWithVoice(c.file_id);
        const code = utils.encodeShortCode(c.id);
        await ctx.reply(`${code}`, await buildCommentInline(c.id, ctx.from.id));
      }
    } catch (e) {
      console.error('my comments err', e);
      await ctx.reply('Could not fetch your comments.');
    }
  });

  // Favorites
  bot.hears(/⭐ Favorites|favorites/i, async (ctx) => {
    try {
      const favs = await db.listFavorites(ctx.from.id);
      if (!favs || favs.length === 0) return ctx.reply('You have no favorites yet.');
      for (const f of favs) {
        if (f.thread_id) {
          const thread = await db.getThreadById(f.thread_id).catch(()=>null);
          if (thread) await sendThreadPreview(ctx, thread);
        }
        if (f.file_id) await ctx.replyWithVoice(f.file_id);
        await ctx.reply(utils.encodeShortCode(f.id), await buildCommentInline(f.id, ctx.from.id));
      }
    } catch (e) {
      console.error('favorites err', e);
      await ctx.reply('Could not fetch favorites.');
    }
  });

  // Search Code
  bot.hears(/🔎 Search Code|search code|search/i, async (ctx) => {
    Pending.set(ctx.from.id, { type: 'await_search_code' });
    return ctx.reply('Send the code (example: 1FZ) to search a comment or reply.');
  });

  // Notifications
  bot.hears(/🔔 Notifications|notifications/i, async (ctx) => {
    try {
      const notes = await db.listNotifications(ctx.from.id);
      if (!notes || notes.length === 0) return ctx.reply('No notifications yet.');
      for (const n of notes) {
        await ctx.reply(`• ${n.type} — ${JSON.stringify(n.payload || {})}`);
      }
    } catch (e) {
      console.error('notifications err', e);
      await ctx.reply('Could not fetch notifications.');
    }
  });

  // Generic text handler — this covers many pending flows (link send, report reasons, upload proof text, reply text)
  bot.on('text', async (ctx) => {
    const uid = ctx.from.id;
    const txt = ctx.message.text ? ctx.message.text.trim() : '';
    const pending = Pending.get(uid);

    // Admin Post (text)
    if (pending && pending.type === 'await_admin_post' && isAdmin(uid)) {
      Pending.delete(uid);
      try {
        // Save admin post
        await db.createAdminPost({ content_type: 'text', content: txt }).catch(()=>null);
        // Broadcast to users (capped)
        const users = await db.listUsers(500);
        for (const u of users) {
          try { await ctx.telegram.sendMessage(u.telegram_id, `📣 Admin Post:\n\n${txt}`); } catch (e) {}
        }
        return ctx.reply('Post published.');
      } catch (e) {
        console.error('admin post text err', e);
        return ctx.reply('Could not publish post.');
      }
    }

    // Upload proof as text (user paste payment transaction link)
    if (pending && pending.type === 'await_upload_proof' && pending.paymentId) {
      Pending.delete(uid);
      try {
        await db.submitPaymentProof(pending.paymentId, { proof_text: txt }).catch(()=>null);
        // notify admins
        for (const adm of ADMIN_IDS) {
          try { await ctx.telegram.sendMessage(adm, `Payment proof submitted by ${uid} — payment id: ${pending.paymentId}`); } catch (e) {}
        }
        return ctx.reply('Proof received. Admins will review.');
      } catch (e) {
        console.error('upload proof text err', e);
        return ctx.reply('Could not submit proof. Try again.');
      }
    }

    // Report reason for comment or reply
    if (pending && pending.type === 'await_report_reason') {
      const { targetType, targetId } = pending;
      Pending.delete(uid);
      try {
        await db.insertReport({ reporter_telegram_id: uid, target_type: targetType, target_id: targetId, reason: txt });
        // notify admin
        for (const adm of ADMIN_IDS) {
          try { await ctx.telegram.sendMessage(adm, `🚨 Report: ${targetType} ${targetId}\nReporter: ${uid}\nReason: ${txt}`); } catch (e) {}
        }
        return ctx.reply('Report sent to admins.');
      } catch (e) {
        console.error('report reason err', e);
        return ctx.reply('Could not submit report.');
      }
    }

    // Search code handler
    if (pending && pending.type === 'await_search_code') {
      Pending.delete(uid);
      const code = txt;
      const id = utils.decodeShortCode(code);
      if (!id) return ctx.reply('Invalid code format.');
      // Try comment first
      try {
        const comment = await db.getCommentById(id);
        if (comment) {
          // send thread preview
          if (comment.thread_id) {
            const thread = await db.getThreadById(comment.thread_id).catch(()=>null);
            if (thread) await sendThreadPreview(ctx, thread);
          }
          if (comment.file_id) await ctx.replyWithVoice(comment.file_id);
          return ctx.reply(utils.encodeShortCode(comment.id), await buildCommentInline(comment.id, uid));
        }
        // else try reply
        const reply = await db.getReplyById(id);
        if (reply) {
          if (reply.file_id) await ctx.replyWithVoice(reply.file_id);
          return ctx.reply(utils.encodeShortCode(reply.id), buildReplyInline(reply.id, reply.comment_id, uid));
        }
        return ctx.reply('Not found.');
      } catch (e) {
        console.error('search code err', e);
        return ctx.reply('Error searching code.');
      }
    }

    // Add comment: user sent a link
    if (pending && pending.type === 'await_link_add') {
      Pending.delete(uid);
      const link = utils.extractFirstUrl(txt) || txt;
      if (!link) return ctx.reply('No link detected. Send a valid TikTok or YouTube link.');
      try {
        const normalized = await utils.normalizeVideoUrl(link);
        // findOrCreateThread returns thread row
        const thread = await db.findOrCreateThread(link, uid);
        Pending.set(uid, { type: 'await_voice_for_add', threadId: thread.id });
        return ctx.reply('Send your voice now to add comment (costs 1 credit).');
      } catch (e) {
        console.error('await_link_add err', e);
        return ctx.reply('Could not process the link.');
      }
    }

    // Listen comments: user sent a link
    if (pending && pending.type === 'await_link_listen') {
      Pending.delete(uid);
      const link = utils.extractFirstUrl(txt) || txt;
      if (!link) return ctx.reply('No link detected. Send a valid link.');
      try {
        const thread = await db.findOrCreateThread(link, null);
        if (!thread) return ctx.reply('No comments for this video yet.');
        // Show first page of comments
        await sendCommentsForThread(ctx, thread.id, 1);
        return;
      } catch (e) {
        console.error('await_link_listen err', e);
        return ctx.reply('Could not process the link.');
      }
    }

    // Reply text: when pending.reply_text
    if (pending && pending.type === 'await_reply_text') {
      const commentId = pending.commentId;
      Pending.delete(uid);
      try {
        const inserted = await db.insertReply({
          comment_id: commentId,
          user_telegram_id: uid,
          type: 'text',
          text: txt
        });
        // notify owner of comment
        const comment = await db.getCommentById(commentId).catch(()=>null);
        if (comment && comment.user_telegram_id && Number(comment.user_telegram_id) !== Number(uid)) {
          await db.insertNotification({ user_telegram_id: comment.user_telegram_id, type: 'reply', payload: { comment_id: commentId, reply_id: inserted.id } }).catch(()=>null);
          try { await ctx.telegram.sendMessage(comment.user_telegram_id, `You have a new reply to your comment ${utils.encodeShortCode(comment.id)}`); } catch (e) {}
        }
        await ctx.reply('Reply saved.');
      } catch (e) {
        console.error('reply text save err', e);
        await ctx.reply('Could not save reply.');
      }
      return;
    }

    // Default fallback
    return ctx.reply('I did not understand. Use the keyboard or send a video link.', buildMainKeyboard(uid));
  });

  // Photo handler
  bot.on('photo', async (ctx) => {
    const uid = ctx.from.id;
    const pending = Pending.get(uid);
    const photos = ctx.message.photo || [];
    const file = photos[photos.length - 1];
    if (!file) return ctx.reply('No photo detected.');

    // Admin post photo
    if (pending && pending.type === 'await_admin_post' && isAdmin(uid)) {
      Pending.delete(uid);
      try {
        await db.createAdminPost({ content_type: 'photo', file_id: file.file_id }).catch(()=>null);
        // broadcast
        const users = await db.listUsers(500);
        for (const u of users) {
          try { await ctx.telegram.sendPhoto(u.telegram_id, file.file_id, { caption: '📣 Admin Post' }); } catch (e) {}
        }
        return ctx.reply('Post published.');
      } catch (e) {
        console.error('admin post photo err', e);
        return ctx.reply('Could not publish post.');
      }
    }

    // Upload proof photo
    if (pending && pending.type === 'await_upload_proof' && pending.paymentId) {
      Pending.delete(uid);
      try {
        await db.submitPaymentProof(pending.paymentId, { proof_file_id: file.file_id }).catch(()=>null);
        for (const adm of ADMIN_IDS) {
          try { await ctx.telegram.sendPhoto(adm, file.file_id, { caption: `Payment proof from ${uid} — payment id ${pending.paymentId}` }); } catch (e) {}
        }
        return ctx.reply('Proof uploaded. Admins will review.');
      } catch (e) {
        console.error('upload proof photo err', e);
        return ctx.reply('Could not submit proof.');
      }
    }

    // Reply photo (free)
    if (pending && pending.type === 'await_reply_photo' && pending.commentId) {
      Pending.delete(uid);
      try {
        const inserted = await db.insertReply({
          comment_id: pending.commentId,
          user_telegram_id: uid,
          type: 'photo',
          file_id: file.file_id
        });
        // notify comment owner
        const comment = await db.getCommentById(pending.commentId).catch(()=>null);
        if (comment && comment.user_telegram_id && Number(comment.user_telegram_id) !== Number(uid)) {
          await db.insertNotification({ user_telegram_id: comment.user_telegram_id, type: 'reply', payload: { comment_id: comment.id, reply_id: inserted.id } }).catch(()=>null);
          try { await ctx.telegram.sendMessage(comment.user_telegram_id, `You have a new reply to your comment ${utils.encodeShortCode(comment.id)}`); } catch (e) {}
        }
        await ctx.replyWithPhoto(file.file_id);
        await ctx.reply(utils.encodeShortCode(inserted.id), buildReplyInline(inserted.id, pending.commentId, uid));
        return;
      } catch (e) {
        console.error('reply photo save err', e);
        return ctx.reply('Could not save reply photo.');
      }
    }

    return ctx.reply('No expected photo action.');
  });

  // Voice handler
  bot.on('voice', async (ctx) => {
    const uid = ctx.from.id;
    const pending = Pending.get(uid);
    const voice = ctx.message.voice;
    if (!voice) return ctx.reply('No voice found.');

    // Admin post voice
    if (pending && pending.type === 'await_admin_post' && isAdmin(uid)) {
      Pending.delete(uid);
      try {
        await db.createAdminPost({ content_type: 'voice', file_id: voice.file_id }).catch(()=>null);
        const users = await db.listUsers(500);
        for (const u of users) {
          try { await ctx.telegram.sendVoice(u.telegram_id, voice.file_id, { caption: '📣 Admin Post' }); } catch (e) {}
        }
        return ctx.reply('Post published.');
      } catch (e) {
        console.error('admin post voice err', e);
        return ctx.reply('Could not publish post.');
      }
    }

    // Upload proof voice
    if (pending && pending.type === 'await_upload_proof' && pending.paymentId) {
      Pending.delete(uid);
      try {
        await db.submitPaymentProof(pending.paymentId, { proof_file_id: voice.file_id }).catch(()=>null);
        for (const adm of ADMIN_IDS) {
          try { await ctx.telegram.sendVoice(adm, voice.file_id, { caption: `Payment proof from ${uid}` }); } catch (e) {}
        }
        return ctx.reply('Proof uploaded. Admins will review.');
      } catch (e) {
        console.error('upload proof voice err', e);
        return ctx.reply('Could not submit proof.');
      }
    }

    // Add comment voice (cost)
    if (pending && pending.type === 'await_voice_for_add' && pending.threadId) {
      try {
        // Check balance
        const balance = await db.getBalance(uid);
        if (balance <= 0) return ctx.reply('Pay before comment — your balance is 0.');
        Pending.delete(uid);
        // insert voice comment
        const inserted = await db.insertComment({
          thread_id: pending.threadId,
          user_telegram_id: uid,
          file_id: voice.file_id,
          duration: voice.duration || 0
        });
        // debit 1 credit
        await db.changeBalance(uid, -1).catch(()=>null);
        // send voice then code under it
        await ctx.replyWithVoice(voice.file_id);
        await ctx.reply(utils.encodeShortCode(inserted.id), await buildCommentInline(inserted.id, uid));
        // Notify trackers of thread
        const trackers = await db.listTrackersForThread(pending.threadId).catch(()=>[]);
        for (const t of trackers) {
          if (Number(t.user_telegram_id) !== Number(uid)) {
            try { await ctx.telegram.sendMessage(t.user_telegram_id, `New comment on a tracked video`); } catch (e) {}
            await db.insertNotification({ user_telegram_id: t.user_telegram_id, type: 'tracked_comment', payload: { comment_id: inserted.id } }).catch(()=>null);
          }
        }
        return;
      } catch (e) {
        console.error('insert comment err', e);
        return ctx.reply('Could not save voice comment.');
      }
    }

    // Reply voice (cost)
    if (pending && pending.type === 'await_reply_voice' && pending.commentId) {
      try {
        const balance = await db.getBalance(uid);
        if (balance <= 0) return ctx.reply('Pay before comment — your balance is 0.');
        Pending.delete(uid);
        const inserted = await db.insertReply({
          comment_id: pending.commentId,
          user_telegram_id: uid,
          type: 'voice',
          file_id: voice.file_id,
          duration: voice.duration || 0
        });
        await db.changeBalance(uid, -1).catch(()=>null);
        // notify owner
        const comment = await db.getCommentById(pending.commentId).catch(()=>null);
        if (comment && comment.user_telegram_id && Number(comment.user_telegram_id) !== Number(uid)) {
          await db.insertNotification({ user_telegram_id: comment.user_telegram_id, type: 'reply', payload: { comment_id: comment.id, reply_id: inserted.id } }).catch(()=>null);
          try { await ctx.telegram.sendMessage(comment.user_telegram_id, `New reply to your comment ${utils.encodeShortCode(comment.id)}`); } catch (e) {}
        }
        await ctx.replyWithVoice(voice.file_id);
        await ctx.reply(utils.encodeShortCode(inserted.id), buildReplyInline(inserted.id, pending.commentId, uid));
        return;
      } catch (e) {
        console.error('insert reply voice err', e);
        return ctx.reply('Could not save reply.');
      }
    }

    return ctx.reply('No expected action for voice now.');
  });

  // Callback query handler (inline buttons)
  bot.on('callback_query', async (ctx) => {
    const q = ctx.callbackQuery;
    const uid = ctx.from.id;
    if (!q || !q.data) return ctx.answerCbQuery();
    const data = q.data;
    const parts = data.split('|');
    const cmd = parts[0];

    // Clear user's pending when they click an inline button (prevents stale pending)
    Pending.delete(uid);

    try {
      // ========== Payment package select ==========
      if (cmd === 'pkg_select') {
        const pkgId = parts[1];
        const pkg = PAYMENT_PACKAGES.find(p => p.id === pkgId);
        if (!pkg) return ctx.answerCbQuery('Package not found');
        // Confirm step: show confirm & cancel
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback(`Confirm ${pkg.label}`, `pkg_confirm|${pkgId}`), Markup.button.callback('Cancel', `pkg_cancel`) ]
        ]);
        await ctx.reply(`You selected ${pkg.label}. Press Confirm to get payment details.`, inline);
        return ctx.answerCbQuery();
      }

      if (cmd === 'pkg_confirm') {
        const pkgId = parts[1];
        const pkg = PAYMENT_PACKAGES.find(p => p.id === pkgId);
        if (!pkg) return ctx.answerCbQuery('Package not found');

        // create payment request in DB
        const payment = await db.createPaymentRequest({ user_telegram_id: uid, package_name: pkg.label, amount: pkg.amount, credits: pkg.credits });
        // Provide payment details (without showing internal DB id in public)
        const text = `Pay to:\n${PAY_RECIPIENT_NAME}\nTELEBIRR: ${PAY_TELEBIRR_NUMBER}\nCBE: ${PAY_CBE_NUMBER}\nAmount: ${pkg.amount} ETB\n\nAfter payment, press Upload Proof and send photo or link.`;
        await ctx.reply(text, buildPaymentKeyboard(payment.id));
        // notify admins with payment id (admins need internal id)
        for (const adm of ADMIN_IDS) {
          try { await ctx.telegram.sendMessage(adm, `New payment request by ${uid}: ${pkg.label} — payment id ${payment.id}`); } catch (e) {}
        }
        return ctx.answerCbQuery();
      }

      if (cmd === 'pkg_cancel') {
        await ctx.answerCbQuery('Cancelled');
        return ctx.reply('Purchase cancelled.', buildMainKeyboard(uid));
      }

      // copy number
      if (cmd === 'copy_number') {
        const number = parts[1];
        await ctx.answerCbQuery('Number shown');
        return ctx.reply(number);
      }

      // upload_proof
      if (cmd === 'upload_proof') {
        const paymentId = Number(parts[1]);
        Pending.set(uid, { type: 'await_upload_proof', paymentId });
        await ctx.answerCbQuery();
        return ctx.reply('Send proof image or paste proof link now.');
      }

      // contact_admin
      if (cmd === 'contact_admin') {
        await ctx.answerCbQuery();
        if (SERVICE_WHATSAPP) return ctx.reply(`Contact admin: ${SERVICE_WHATSAPP}`);
        return ctx.reply(`Contact admin via Telegram.`);
      }

      // favorite toggle
      if (cmd === 'fav_toggle') {
        const commentId = Number(parts[1]);
        try {
          const toggled = await db.toggleFavorite(uid, commentId);
          await ctx.answerCbQuery(toggled.added ? 'Added to favorite' : 'Removed favorite');
          // update inline markup on message (best effort)
          try {
            await ctx.editMessageReplyMarkup((await buildCommentInline(commentId, uid)).reply_markup).catch(()=>null);
          } catch (e) {}
        } catch (e) {
          console.error('fav_toggle err', e);
          await ctx.answerCbQuery('Error toggling favorite');
        }
        return;
      }

      // reply menu
      if (cmd === 'reply_menu') {
        const commentId = Number(parts[1]);
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('Reply Text (free)', `reply_text|${commentId}`), Markup.button.callback('Reply Photo (free)', `reply_photo|${commentId}`) ],
          [ Markup.button.callback('Reply Voice (costs 1)', `reply_voice|${commentId}`) ],
          [ Markup.button.callback('Cancel', `cancel`) ]
        ]);
        await ctx.reply('Choose reply type:', inline);
        return ctx.answerCbQuery();
      }

      // reply_text
      if (cmd === 'reply_text') {
        const commentId = Number(parts[1]);
        Pending.set(uid, { type: 'await_reply_text', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Send your text reply now.');
      }

      // reply_photo
      if (cmd === 'reply_photo') {
        const commentId = Number(parts[1]);
        Pending.set(uid, { type: 'await_reply_photo', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Send photo now (free).');
      }

      // reply_voice
      if (cmd === 'reply_voice') {
        const commentId = Number(parts[1]);
        Pending.set(uid, { type: 'await_reply_voice', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Send voice now (costs 1 credit).');
      }

      // show_replies with pagination
      if (cmd === 'show_replies') {
        const commentId = Number(parts[1]);
        const page = Number(parts[2] || 1);
        await ctx.answerCbQuery();
        await sendRepliesForComment(ctx, commentId, page);
        return;
      }

      // show thread comments (listen)
      if (cmd === 'show_comments') {
        const threadId = Number(parts[1]);
        const page = Number(parts[2] || 1);
        await ctx.answerCbQuery();
        await sendCommentsForThread(ctx, threadId, page);
        return;
      }

      // report comment
      if (cmd === 'report_comment') {
        const commentId = Number(parts[1]);
        Pending.set(uid, { type: 'await_report_reason', targetType: 'comment', targetId: commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain briefly why you report this comment.');
      }

      // report_reply
      if (cmd === 'report_reply') {
        const replyId = Number(parts[1]);
        const commentId = Number(parts[2]);
        Pending.set(uid, { type: 'await_report_reason', targetType: 'reply', targetId: replyId, commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain briefly why you report this reply.');
      }

      // delete comment (user or admin)
      if (cmd === 'delete_comment') {
        const commentId = Number(parts[1]);
        const comment = await db.getCommentById(commentId);
        if (!comment) { await ctx.answerCbQuery('Not found'); return ctx.reply('Comment not found.'); }
        if (Number(comment.user_telegram_id) !== Number(uid) && !isAdmin(uid)) { await ctx.answerCbQuery('Not authorized'); return ctx.reply('Not authorized to delete.'); }
        await db.deleteComment(commentId).catch(()=>null);
        await ctx.answerCbQuery('Deleted');
        return ctx.reply('Comment deleted.');
      }

      // admin_delete_reply
      if (cmd === 'admin_delete_reply') {
        if (!isAdmin(uid)) { await ctx.answerCbQuery('Admin only'); return; }
        const replyId = Number(parts[1]);
        await db.deleteReply(replyId).catch(()=>null);
        await ctx.answerCbQuery('Deleted');
        return ctx.reply('Reply deleted.');
      }

      // approve payment (admin)
      if (cmd === 'approve_payment') {
        if (!isAdmin(uid)) { await ctx.answerCbQuery('Admin only'); return; }
        const paymentId = Number(parts[1]);
        try {
          const payment = await db.getPayment(paymentId);
          if (!payment) { await ctx.answerCbQuery('Payment not found'); return ctx.reply('Payment not found.'); }
          // credit user
          await db.creditUser(payment.user_telegram_id, payment.credits).catch(()=>null);
          await db.setPaymentStatus(paymentId, 'approved', { approved_by: uid }).catch(()=>null);
          try { await ctx.telegram.sendMessage(payment.user_telegram_id, `Your payment request is approved. You received ${payment.credits} comments.`); } catch (e) {}
          await ctx.answerCbQuery('Approved');
          return ctx.reply('Payment approved and credited.');
        } catch (e) {
          console.error('approve_payment err', e);
          await ctx.answerCbQuery('Error approving');
          return ctx.reply('Error approving payment.');
        }
      }

      // cancel button
      if (cmd === 'cancel') {
        Pending.delete(uid);
        await ctx.answerCbQuery('Cancelled');
        return ctx.reply('Cancelled.', buildMainKeyboard(uid));
      }

      // copy number quick response (just reveal)
      if (cmd === 'copy_number') {
        const number = parts[1];
        await ctx.answerCbQuery('Number shown');
        return ctx.reply(number);
      }

      // react to comment or reply (toggle/change)
      if (cmd === 'react') {
        // format: react|targetType|targetId|emoji
        const targetType = parts[1]; // comment or reply
        const targetId = Number(parts[2]);
        const emoji = parts[3];
        try {
          await db.toggleReaction({ user_telegram_id: uid, target_type: targetType, target_id: targetId, emoji });
          await ctx.answerCbQuery('Saved');
          return;
        } catch (e) {
          console.error('react err', e);
          await ctx.answerCbQuery('Error');
          return;
        }
      }

      return ctx.answerCbQuery();
    } catch (e) {
      console.error('callback_query handler err', e);
      try { await ctx.answerCbQuery('Error'); } catch (e) {}
      return;
    }
  });

  // ========== helper functions inside bot.js ==========

  // send comments for a thread with pagination
  async function sendCommentsForThread(ctx, threadId, page = 1) {
    try {
      const perPage = 6;
      const offset = (page - 1) * perPage;
      const comments = await db.listCommentsByThread(threadId, perPage, offset);
      if (!comments || comments.length === 0) return ctx.reply('No comments for this video yet.');
      for (const c of comments) {
        // preview thread (only on first comment)
        const thread = await db.getThreadById(threadId).catch(()=>null);
        if (thread) await sendThreadPreview(ctx, thread);
        // send voice
        if (c.file_id) await ctx.replyWithVoice(c.file_id);
        // send code below the voice
        await ctx.reply(utils.encodeShortCode(c.id), await buildCommentInline(c.id, ctx.from.id));
      }
      // pagination
      const total = await db.countCommentsForThread(threadId);
      if (offset + perPage < total) {
        await ctx.reply('More comments:', Markup.inlineKeyboard([[ Markup.button.callback('More', `show_comments|${threadId}|${page+1}`) ]]));
      }
    } catch (e) {
      console.error('sendCommentsForThread err', e);
      await ctx.reply('Could not list comments for this video.');
    }
  }

  // send replies for a comment with pagination
  async function sendRepliesForComment(ctx, commentId, page = 1) {
    try {
      const perPage = 5;
      const offset = (page - 1) * perPage;
      const replies = await db.listReplies(commentId, perPage, offset);
      if (!replies || replies.length === 0) return ctx.reply('No replies yet.');
      for (const r of replies) {
        if (r.type === 'voice' && r.file_id) {
          await ctx.replyWithVoice(r.file_id, { caption: `Reply by ${r.user_telegram_id}` });
        } else if (r.type === 'photo' && r.file_id) {
          await ctx.replyWithPhoto(r.file_id, { caption: `Reply by ${r.user_telegram_id}` });
        } else {
          await ctx.reply(`${r.user_telegram_id}: ${r.text || ''}`);
        }
        await ctx.reply(utils.encodeShortCode(r.id), buildReplyInline(r.id, commentId, ctx.from.id));
      }
      const total = await db.countRepliesForComment(commentId);
      if (offset + perPage < total) {
        await ctx.reply('More replies:', Markup.inlineKeyboard([[ Markup.button.callback('More', `show_replies|${commentId}|${page+1}`) ]]));
      }
    } catch (e) {
      console.error('sendRepliesForComment err', e);
      await ctx.reply('Could not list replies.');
    }
  }

  // ========== end helper functions ==========

  // Launch: in serverless environment we will not call bot.launch() here.
  // But if running locally, you can start polling:
  if (process.env.NODE_ENV !== 'production') {
    bot.launch().then(()=>console.log('Bot launched (polling)'));
  }

  return bot;
}

// Export initializer for serverless wrapper
module.exports = { initBot };
