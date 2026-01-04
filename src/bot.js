// src/bot.js
// Complete bot implementation for WorldVoiceComment
// Expects: ./database.js and ./utils.js to exist and match the DB schema we installed.

const { Telegraf, Markup } = require('telegraf');
const db = require('./database');
const utils = require('./utils');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const SERVICE_WHATSAPP = process.env.WHATSAPP_ADMIN || null;

const PAY_TELEBIRR_NUMBER = process.env.PAY_TELEBIRR_NUMBER || '0962058608';
const PAY_CBE_NUMBER = process.env.PAY_CBE_NUMBER || '1000555367884';
const PAY_RECIPIENT_NAME = process.env.PAY_RECIPIENT_NAME || 'WorldVoiceComment';

// Payment packages
const PAYMENT_PACKAGES = [
  { id: 'p1', label: '25 comments — 12 ETB', credits: 25, amount: 12 },
  { id: 'p2', label: '60 comments — 27 ETB', credits: 60, amount: 27 },
  { id: 'p3', label: '130 comments — 49 ETB', credits: 130, amount: 49 },
  { id: 'p4', label: '240 comments — 89 ETB', credits: 240, amount: 89 }
];

function isAdmin(telegramId) {
  return ADMIN_IDS.includes(Number(telegramId));
}

// Pending actions map: Map<telegramId, pendingObject>
const Pending = new Map();

// Build user keyboard (admin sees Post)
function buildMainKeyboard(telegramId) {
  const admin = isAdmin(telegramId);
  const rows = [
    ['🎥 Add Comment', '🎧 Listen Comments'],
    ['💬 My Comments', '🔎 Search Code'],
    ['⭐ Favorites', '🔔 Notifications'],
    ['🛒 Buy', '📞 Support'],
    ['💰 Balance']
  ];
  if (admin) rows[0].push('📣 Post');
  return Markup.keyboard(rows, { columns: 2 }).resize();
}

// Build inline buttons for comment (main voice comment)
async function buildCommentInline(commentId, fromUserId) {
  try {
    const rows = [];
    // Reply + Favorite
    const fav = await db.supabase.from('favorites').select('*').eq('user_telegram_id', fromUserId).eq('comment_id', commentId).limit(1).maybeSingle().catch(()=>({data:null}));
    const favLabel = (fav && fav.data) ? '★ Favorited' : '☆ Favorite';
    rows.push([ Markup.button.callback('💬 Reply', `reply_menu|${commentId}`), Markup.button.callback(favLabel, `fav_toggle|${commentId}`) ]);

    // Show replies and report
    const replyCount = await db.countRepliesForComment(commentId).catch(()=>0);
    rows.push([ Markup.button.callback(`▶ Replies (${replyCount})`, `show_replies|${commentId}|1`), Markup.button.callback('🚩 Report', `report_comment|${commentId}`) ]);

    // Reactions row
    rows.push([ Markup.button.callback('❤️', `react|comment|${commentId}|heart`), Markup.button.callback('😂', `react|comment|${commentId}|laugh`), Markup.button.callback('😮', `react|comment|${commentId}|wow`) ]);

    // Delete if owner or admin
    const comment = await db.getCommentById(commentId).catch(()=>null);
    if (comment) {
      if (Number(comment.user_telegram_id) === Number(fromUserId) || isAdmin(fromUserId)) {
        rows.push([ Markup.button.callback('🗑 Delete', `delete_comment|${commentId}`) ]);
      }
    }
    return Markup.inlineKeyboard(rows);
  } catch (e) {
    // fallback
    return Markup.inlineKeyboard([[ Markup.button.callback('🚩 Report', `report_comment|${commentId}`) ]]);
  }
}

// Build inline for reply (replies only show reaction + report; admin can delete)
function buildReplyInline(replyId, commentId, fromUserId) {
  const rows = [
    [ Markup.button.callback('❤️', `react|reply|${replyId}|heart`), Markup.button.callback('🚩 Report', `report_reply|${replyId}|${commentId}`) ]
  ];
  if (isAdmin(fromUserId)) rows.push([ Markup.button.callback('🗑 Admin Delete', `admin_delete_reply|${replyId}`) ]);
  return Markup.inlineKeyboard(rows);
}

// Build payment keyboard for copy & upload
function buildPaymentKeyboard(paymentId) {
  return Markup.inlineKeyboard([
    [ Markup.button.callback('Copy TELEBIRR', `copy_number|${PAY_TELEBIRR_NUMBER}`), Markup.button.callback('Copy CBE', `copy_number|${PAY_CBE_NUMBER}`) ],
    [ Markup.button.callback('Upload Proof', `upload_proof|${paymentId}`) ]
  ]);
}

// Send thread preview (thumbnail if available). Optionally supply showTrackForUserId to display track/untrack prompt.
async function sendThreadPreview(ctx, thread, showTrackForUserId = null) {
  try {
    const info = await utils.normalizeVideoUrl(thread.original_link || thread.normalized_link);
    if (info && info.thumbnail) {
      await ctx.replyWithPhoto(info.thumbnail, { caption: thread.original_link || info.canonical_link || thread.normalized_link });
    } else {
      await ctx.reply(thread.original_link || thread.normalized_link || 'Video link');
    }
    if (showTrackForUserId) {
      // check if tracking
      const trackers = await db.listTrackedByUser(showTrackForUserId).catch(()=>[]);
      const isTracking = trackers.some(t => Number(t.thread_id) === Number(thread.id));
      const kb = Markup.inlineKeyboard([[ isTracking ? Markup.button.callback('🔕 Untrack', `untrack|${thread.id}`) : Markup.button.callback('🔔 Track', `track|${thread.id}`) ]]);
      await ctx.reply('Tracking options:', kb);
    }
  } catch (e) {
    await ctx.reply(thread.original_link || 'Video link');
  }
}

// Helper: send a page of comments for a thread (pagination)
async function sendCommentsForThread(ctx, threadId, page = 1) {
  try {
    const perPage = 6;
    const offset = (page - 1) * perPage;
    const comments = await db.listCommentsByThread(threadId, perPage, offset);
    if (!comments || comments.length === 0) return ctx.reply('No comments for this video yet.');
    const thread = await db.getThreadById(threadId).catch(()=>null);
    if (thread) await sendThreadPreview(ctx, thread, ctx.from.id);
    for (const c of comments) {
      if (c.file_id) await ctx.replyWithVoice(c.file_id);
      await ctx.reply(utils.encodeShortCode(c.id), await buildCommentInline(c.id, ctx.from.id));
    }
    const total = await db.countCommentsForThread(threadId);
    if (offset + perPage < total) {
      await ctx.reply('More comments:', Markup.inlineKeyboard([[ Markup.button.callback('More', `show_comments|${threadId}|${page+1}`) ]]));
    }
  } catch (e) {
    console.error('sendCommentsForThread err', e);
    await ctx.reply('Could not list comments for that video.');
  }
}

// Helper: send replies for a comment with pagination
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

// ---------- Initialize bot ----------
function initBot() {
  const bot = new Telegraf(BOT_TOKEN);

  // /start
  bot.start(async (ctx) => {
    try {
      await db.ensureUser(ctx.from).catch(()=>null);
      const balance = await db.getBalance(ctx.from.id).catch(()=>0);
      await ctx.reply(`Welcome ${ctx.from.first_name || ''}! Your available comments: *${balance}*`, { parse_mode: 'Markdown' });
      await ctx.reply('Use the keyboard below.', buildMainKeyboard(ctx.from.id));
    } catch (e) {
      console.error('start err', e);
      await ctx.reply('Welcome!', buildMainKeyboard(ctx.from.id));
    }
  });

  // Admin Post (makes broadcast)
  bot.hears('📣 Post', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    Pending.set(ctx.from.id, { type: 'await_admin_post' });
    return ctx.reply('Send the post content (text/photo/voice). It will be broadcast to users.');
  });

  // Support
  bot.hears(/📞 Support|support/i, async (ctx) => {
    if (SERVICE_WHATSAPP) return ctx.reply(`Contact admin: ${SERVICE_WHATSAPP}`);
    return ctx.reply('Contact admin via Telegram.');
  });

  // Buy
  bot.hears(/🛒 Buy|buy/i, async (ctx) => {
    const inline = PAYMENT_PACKAGES.map(p => [ Markup.button.callback(p.label, `pkg_select|${p.id}`) ]);
    inline.push([ Markup.button.callback('Contact admin', `contact_admin`) ]);
    return ctx.reply('Choose a package:', Markup.inlineKeyboard(inline));
  });

  // Balance
  bot.hears(/💰 Balance|balance/i, async (ctx) => {
    try {
      const bal = await db.getBalance(ctx.from.id);
      return ctx.reply(`Your available comments: *${bal}*`, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('balance err', e);
      return ctx.reply('Could not fetch balance.');
    }
  });

  // Add Comment (start link)
  bot.hears(/🎥 Add Comment|add comment/i, async (ctx) => {
    Pending.set(ctx.from.id, { type: 'await_link_add' });
    return ctx.reply('Send the TikTok / YouTube link you want to add a voice comment for.');
  });

  // Listen Comments (start link)
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
        if (c.thread_id) {
          const thread = await db.getThreadById(c.thread_id).catch(()=>null);
          if (thread) await sendThreadPreview(ctx, thread);
        }
        if (c.file_id) await ctx.replyWithVoice(c.file_id);
        await ctx.reply(utils.encodeShortCode(c.id), await buildCommentInline(c.id, ctx.from.id));
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

  // Search code
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

  // Generic text handler: many pending flows funnel here
  bot.on('text', async (ctx) => {
    const uid = ctx.from.id;
    const text = ctx.message.text ? ctx.message.text.trim() : '';
    const pending = Pending.get(uid);

    // Admin post text
    if (pending && pending.type === 'await_admin_post' && isAdmin(uid)) {
      Pending.delete(uid);
      try {
        await db.createAdminPost({ content_type: 'text', content: text }).catch(()=>null);
        const users = await db.listUsers(500).catch(()=>[]);
        for (const u of users) {
          try { await ctx.telegram.sendMessage(u.telegram_id, `📣 Admin Post:\n\n${text}`); } catch (e) {}
        }
        return ctx.reply('Post published.');
      } catch (e) {
        console.error('admin post text err', e);
        return ctx.reply('Could not publish post.');
      }
    }

    // Upload proof as text (payment)
    if (pending && pending.type === 'await_upload_proof' && pending.paymentId) {
      Pending.delete(uid);
      try {
        await db.submitPaymentProof(pending.paymentId, { proof_text: text }).catch(()=>null);
        // notify admins with approve/reject inline buttons
        for (const adm of ADMIN_IDS) {
          try {
            await ctx.telegram.sendMessage(adm, `Payment proof submitted by ${uid} — payment id: ${pending.paymentId}`, Markup.inlineKeyboard([
              [ Markup.button.callback('✅ Approve', `approve_payment|${pending.paymentId}`), Markup.button.callback('❌ Reject', `reject_payment|${pending.paymentId}`) ]
            ]));
          } catch (e) {}
        }
        return ctx.reply('Proof received. Admins will review.');
      } catch (e) {
        console.error('upload proof text err', e);
        return ctx.reply('Could not submit proof. Try again or send a photo.');
      }
    }

    // Report reason
    if (pending && pending.type === 'await_report_reason') {
      const { targetType, targetId } = pending;
      Pending.delete(uid);
      try {
        await db.insertReport({ reporter_telegram_id: uid, target_type: targetType, target_id: targetId, reason: text });
        for (const adm of ADMIN_IDS) {
          try { await ctx.telegram.sendMessage(adm, `🚨 Report: ${targetType} ${targetId}\nReporter: ${uid}\nReason: ${text}`); } catch (e) {}
        }
        return ctx.reply('Report sent to admins.');
      } catch (e) {
        console.error('report reason err', e);
        return ctx.reply('Could not submit report.');
      }
    }

    // Search code
    if (pending && pending.type === 'await_search_code') {
      Pending.delete(uid);
      const code = text;
      const id = utils.decodeShortCode(code);
      if (!id) return ctx.reply('Invalid code format.');
      try {
        const comment = await db.getCommentById(id);
        if (comment) {
          if (comment.thread_id) {
            const thread = await db.getThreadById(comment.thread_id).catch(()=>null);
            if (thread) await sendThreadPreview(ctx, thread);
          }
          if (comment.file_id) await ctx.replyWithVoice(comment.file_id);
          return ctx.reply(utils.encodeShortCode(comment.id), await buildCommentInline(comment.id, uid));
        }
        const reply = await db.getReplyById(id);
        if (reply) {
          if (reply.type === 'voice' && reply.file_id) await ctx.replyWithVoice(reply.file_id);
          else if (reply.type === 'photo' && reply.file_id) await ctx.replyWithPhoto(reply.file_id);
          else await ctx.reply(reply.text || '(text)');
          return ctx.reply(utils.encodeShortCode(reply.id), buildReplyInline(reply.id, reply.comment_id, uid));
        }
        return ctx.reply('Not found.');
      } catch (e) {
        console.error('search code err', e);
        return ctx.reply('Error searching code.');
      }
    }

    // Add comment flow: received link
    if (pending && pending.type === 'await_link_add') {
      Pending.delete(uid);
      const link = utils.extractFirstUrl(text) || text;
      if (!link) return ctx.reply('No link detected. Send a TikTok or YouTube link.');
      try {
        const thread = await db.findOrCreateThread(link, uid);
        Pending.set(uid, { type: 'await_voice_for_add', threadId: thread.id });
        return ctx.reply('Now send your voice to add as comment (costs 1 credit).');
      } catch (e) {
        console.error('await_link_add err', e);
        return ctx.reply('Could not process the link.');
      }
    }

    // Listen comments: received link
    if (pending && pending.type === 'await_link_listen') {
      Pending.delete(uid);
      const link = utils.extractFirstUrl(text) || text;
      if (!link) return ctx.reply('No link detected.');
      try {
        const thread = await db.findOrCreateThread(link, null);
        if (!thread) return ctx.reply('No comments yet for this video.');
        // show comments with track button
        await sendThreadPreview(ctx, thread, uid);
        return sendCommentsForThread(ctx, thread.id, 1);
      } catch (e) {
        console.error('await_link_listen err', e);
        return ctx.reply('Could not list comments for this link.');
      }
    }

    // Reply text (pending.reply_text)
    if (pending && pending.type === 'await_reply_text' && pending.commentId) {
      const commentId = pending.commentId;
      Pending.delete(uid);
      try {
        const inserted = await db.insertReply({ comment_id: commentId, user_telegram_id: uid, type: 'text', text });
        const comment = await db.getCommentById(commentId).catch(()=>null);
        if (comment && comment.user_telegram_id && Number(comment.user_telegram_id) !== Number(uid)) {
          await db.insertNotification({ user_telegram_id: comment.user_telegram_id, type: 'reply', payload: { comment_id: comment.id, reply_id: inserted.id } }).catch(()=>null);
          try { await ctx.telegram.sendMessage(comment.user_telegram_id, `New reply to your comment ${utils.encodeShortCode(comment.id)}`); } catch (e) {}
        }
        return ctx.reply('Reply saved.');
      } catch (e) {
        console.error('reply text save err', e);
        return ctx.reply('Could not save reply.');
      }
    }

    // Fallback
    return ctx.reply('I did not understand — press a button or send a video link.', buildMainKeyboard(uid));
  });

  // Photo handler
  bot.on('photo', async (ctx) => {
    const uid = ctx.from.id;
    const photos = ctx.message.photo || [];
    const file = photos[photos.length - 1];
    if (!file) return ctx.reply('No photo detected.');
    const pending = Pending.get(uid);

    // Admin post photo
    if (pending && pending.type === 'await_admin_post' && isAdmin(uid)) {
      Pending.delete(uid);
      try {
        await db.createAdminPost({ content_type: 'photo', file_id: file.file_id }).catch(()=>null);
        const users = await db.listUsers(500).catch(()=>[]);
        for (const u of users) {
          try { await ctx.telegram.sendPhoto(u.telegram_id, file.file_id, { caption: '📣 Admin Post' }); } catch (e) {}
        }
        return ctx.reply('Post published.');
      } catch (e) {
        console.error('admin post photo err', e);
        return ctx.reply('Could not publish post.');
      }
    }

    // Upload proof photo (payment)
    if (pending && pending.type === 'await_upload_proof' && pending.paymentId) {
      Pending.delete(uid);
      try {
        await db.submitPaymentProof(pending.paymentId, { proof_file_id: file.file_id }).catch(()=>null);
        // notify admins with approve/reject buttons
        for (const adm of ADMIN_IDS) {
          try {
            await ctx.telegram.sendPhoto(adm, file.file_id, { caption: `Payment proof from ${uid} — id ${pending.paymentId}` });
            await ctx.telegram.sendMessage(adm, `Review payment id ${pending.paymentId}:`, Markup.inlineKeyboard([
              [ Markup.button.callback('✅ Approve', `approve_payment|${pending.paymentId}`), Markup.button.callback('❌ Reject', `reject_payment|${pending.paymentId}`) ]
            ]));
          } catch (e) {}
        }
        return ctx.reply('Proof uploaded. Admins will review.');
      } catch (e) {
        console.error('upload_proof photo err', e);
        return ctx.reply('Could not submit proof.');
      }
    }

    // Reply photo
    if (pending && pending.type === 'await_reply_photo' && pending.commentId) {
      const commentId = pending.commentId;
      Pending.delete(uid);
      try {
        const inserted = await db.insertReply({ comment_id: commentId, user_telegram_id: uid, type: 'photo', file_id: file.file_id });
        const comment = await db.getCommentById(commentId).catch(()=>null);
        if (comment && comment.user_telegram_id && Number(comment.user_telegram_id) !== Number(uid)) {
          await db.insertNotification({ user_telegram_id: comment.user_telegram_id, type: 'reply', payload: { comment_id: comment.id, reply_id: inserted.id } }).catch(()=>null);
          try { await ctx.telegram.sendMessage(comment.user_telegram_id, `You have a new reply to your comment ${utils.encodeShortCode(comment.id)}`); } catch (e) {}
        }
        await ctx.replyWithPhoto(file.file_id);
        await ctx.reply(utils.encodeShortCode(inserted.id), buildReplyInline(inserted.id, commentId, uid));
        return;
      } catch (e) {
        console.error('reply_photo err', e);
        return ctx.reply('Could not save reply photo.');
      }
    }

    return ctx.reply('No expected photo action.');
  });

  // Voice handler
  bot.on('voice', async (ctx) => {
    const uid = ctx.from.id;
    const voice = ctx.message.voice;
    if (!voice) return ctx.reply('No voice detected.');
    const pending = Pending.get(uid);

    // Admin post voice
    if (pending && pending.type === 'await_admin_post' && isAdmin(uid)) {
      Pending.delete(uid);
      try {
        await db.createAdminPost({ content_type: 'voice', file_id: voice.file_id }).catch(()=>null);
        const users = await db.listUsers(500).catch(()=>[]);
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
          try {
            await ctx.telegram.sendVoice(adm, voice.file_id, { caption: `Payment proof from ${uid} — id ${pending.paymentId}` });
            await ctx.telegram.sendMessage(adm, `Review payment id ${pending.paymentId}:`, Markup.inlineKeyboard([
              [ Markup.button.callback('✅ Approve', `approve_payment|${pending.paymentId}`), Markup.button.callback('❌ Reject', `reject_payment|${pending.paymentId}`) ]
            ]));
          } catch (e) {}
        }
        return ctx.reply('Proof uploaded. Admins will review.');
      } catch (e) {
        console.error('upload proof voice err', e);
        return ctx.reply('Could not submit proof.');
      }
    }

    // Add comment voice (costs 1 credit)
    if (pending && pending.type === 'await_voice_for_add' && pending.threadId) {
      try {
        const balance = await db.getBalance(uid).catch(()=>0);
        if (balance <= 0) return ctx.reply('Pay before comment — your balance is 0.');
        Pending.delete(uid);
        const inserted = await db.insertComment({ thread_id: pending.threadId, user_telegram_id: uid, file_id: voice.file_id, duration: voice.duration || 0 });
        // debit 1 credit
        await db.changeBalance(uid, -1).catch(()=>null);
        await ctx.replyWithVoice(voice.file_id);
        await ctx.reply(utils.encodeShortCode(inserted.id), await buildCommentInline(inserted.id, uid));
        // notify trackers of thread
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

    // Reply voice (costs 1 credit)
    if (pending && pending.type === 'await_reply_voice' && pending.commentId) {
      try {
        const balance = await db.getBalance(uid).catch(()=>0);
        if (balance <= 0) return ctx.reply('Pay before comment — your balance is 0.');
        Pending.delete(uid);
        const inserted = await db.insertReply({ comment_id: pending.commentId, user_telegram_id: uid, type: 'voice', file_id: voice.file_id, duration: voice.duration || 0 });
        await db.changeBalance(uid, -1).catch(()=>null);
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

  // Callback query handler: implement all commands
  bot.on('callback_query', async (ctx) => {
    try {
      const q = ctx.callbackQuery;
      if (!q || !q.data) return ctx.answerCbQuery();
      const uid = ctx.from.id;
      const data = q.data;
      const parts = data.split('|');
      const cmd = parts[0];

      // clear pending on button press to avoid stale state
      Pending.delete(uid);

      // ----------------- Payment package select / confirm -----------------
      if (cmd === 'pkg_select') {
        const pkgId = parts[1];
        const pkg = PAYMENT_PACKAGES.find(p => p.id === pkgId);
        if (!pkg) { await ctx.answerCbQuery('Package not found'); return; }
        // Show confirm/cancel inline
        const inline = Markup.inlineKeyboard([ [ Markup.button.callback(`Confirm ${pkg.label}`, `pkg_confirm|${pkgId}`), Markup.button.callback('Cancel', `pkg_cancel`) ] ]);
        await ctx.reply(`You selected ${pkg.label}. Press Confirm to get payment details.`, inline);
        await ctx.answerCbQuery();
        return;
      }

      if (cmd === 'pkg_confirm') {
        const pkgId = parts[1];
        const pkg = PAYMENT_PACKAGES.find(p => p.id === pkgId);
        if (!pkg) { await ctx.answerCbQuery('Package not found'); return; }
        // create payment request
        const payment = await db.createPaymentRequest({ user_telegram_id: uid, package_name: pkg.label, amount: pkg.amount, credits: pkg.credits });
        // send details (no internal payment id shown publicly except to user)
        const text = `Pay to:\n${PAY_RECIPIENT_NAME}\nTELEBIRR: ${PAY_TELEBIRR_NUMBER}\nCBE: ${PAY_CBE_NUMBER}\nAmount: ${pkg.amount} ETB\n\nAfter payment, press Upload Proof and send photo or link.`;
        await ctx.reply(text, buildPaymentKeyboard(payment.id));
        // notify admins with internal id
        for (const adm of ADMIN_IDS) {
          try { await ctx.telegram.sendMessage(adm, `New payment request by ${uid}: ${pkg.label} — payment id ${payment.id}`); } catch (e) {}
        }
        await ctx.answerCbQuery();
        return;
      }

      if (cmd === 'pkg_cancel') {
        await ctx.answerCbQuery('Cancelled');
        await ctx.reply('Purchase cancelled.', buildMainKeyboard(uid));
        return;
      }

      // copy number (just reveal)
      if (cmd === 'copy_number') {
        const number = parts[1];
        await ctx.answerCbQuery('Number shown');
        await ctx.reply(number);
        return;
      }

      // upload_proof (begins awaiting proof)
      if (cmd === 'upload_proof') {
        const paymentId = Number(parts[1]);
        Pending.set(uid, { type: 'await_upload_proof', paymentId });
        await ctx.answerCbQuery();
        await ctx.reply('Send proof image or paste proof link now.');
        return;
      }

      // contact_admin
      if (cmd === 'contact_admin') {
        await ctx.answerCbQuery();
        if (SERVICE_WHATSAPP) return ctx.reply(`Contact admin: ${SERVICE_WHATSAPP}`);
        return ctx.reply('Contact admin via Telegram.');
      }

      // ----------------- Favorite toggle -----------------
      if (cmd === 'fav_toggle' || cmd === 'fav') {
        const commentId = Number(parts[1]);
        try {
          const res = await db.toggleFavorite(uid, commentId);
          await ctx.answerCbQuery(res.added ? 'Added to favorites' : 'Removed from favorites');
          // try to update the message inline markup (best-effort)
          try {
            await ctx.editMessageReplyMarkup((await buildCommentInline(commentId, uid)).reply_markup).catch(()=>null);
          } catch (e) {}
        } catch (e) {
          console.error('fav_toggle err', e);
          await ctx.answerCbQuery('Error toggling favorite');
        }
        return;
      }

      // ----------------- Reply menu -----------------
      if (cmd === 'reply_menu' || cmd === 'replymenu') {
        const commentId = Number(parts[1]);
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('Reply Text (free)', `reply_text|${commentId}`), Markup.button.callback('Reply Photo (free)', `reply_photo|${commentId}`) ],
          [ Markup.button.callback('Reply Voice (costs 1)', `reply_voice|${commentId}`) ],
          [ Markup.button.callback('Cancel', `cancel`) ]
        ]);
        await ctx.reply('Choose reply type:', inline);
        await ctx.answerCbQuery();
        return;
      }

      if (cmd === 'reply_text') {
        const commentId = Number(parts[1]);
        Pending.set(uid, { type: 'await_reply_text', commentId });
        await ctx.answerCbQuery();
        await ctx.reply('Send your text reply now.');
        return;
      }

      if (cmd === 'reply_photo') {
        const commentId = Number(parts[1]);
        Pending.set(uid, { type: 'await_reply_photo', commentId });
        await ctx.answerCbQuery();
        await ctx.reply('Send photo now (free).');
        return;
      }

      if (cmd === 'reply_voice') {
        const commentId = Number(parts[1]);
        Pending.set(uid, { type: 'await_reply_voice', commentId });
        await ctx.answerCbQuery();
        await ctx.reply('Send voice now (costs 1 comment credit).');
        return;
      }

      // ----------------- Show replies & show comments -----------------
      if (cmd === 'show_replies' || cmd === 'list_replies') {
        const commentId = Number(parts[1]);
        const page = Number(parts[2] || 1);
        await ctx.answerCbQuery();
        return sendRepliesForComment(ctx, commentId, page);
      }

      if (cmd === 'show_comments' || cmd === 'show_comments' || cmd === 'show_comments') {
        const threadId = Number(parts[1]);
        const page = Number(parts[2] || 1);
        await ctx.answerCbQuery();
        return sendCommentsForThread(ctx, threadId, page);
      }

      // shortcut used elsewhere: listen|threadId|page
      if (cmd === 'listen' || cmd === 'show_comments' || cmd === 'show_comments') {
        const threadId = Number(parts[1]);
        const page = Number(parts[2] || 1);
        await ctx.answerCbQuery();
        return sendCommentsForThread(ctx, threadId, page);
      }

      // ----------------- Show comments (used by callback 'show_comments') -----------------
      if (cmd === 'show_comments') {
        const threadId = Number(parts[1]);
        const page = Number(parts[2] || 1);
        await ctx.answerCbQuery();
        return sendCommentsForThread(ctx, threadId, page);
      }

      // ----------------- Report flows -----------------
      if (cmd === 'report_comment') {
        const commentId = Number(parts[1]);
        Pending.set(uid, { type: 'await_report_reason', targetType: 'comment', targetId: commentId });
        await ctx.answerCbQuery();
        await ctx.reply('Please explain briefly why you report this comment.');
        return;
      }

      if (cmd === 'report_reply') {
        const replyId = Number(parts[1]);
        const commentId = Number(parts[2]);
        Pending.set(uid, { type: 'await_report_reason', targetType: 'reply', targetId: replyId, commentId });
        await ctx.answerCbQuery();
        await ctx.reply('Please explain briefly why you report this reply.');
        return;
      }

      // ----------------- Delete/comment deletion -----------------
      if (cmd === 'delete_comment' || cmd === 'delete_my_comment') {
        const commentId = Number(parts[1]);
        try {
          const comment = await db.getCommentById(commentId).catch(()=>null);
          if (!comment) { await ctx.answerCbQuery('Not found'); return ctx.reply('Comment not found.'); }
          if (Number(comment.user_telegram_id) !== Number(uid) && !isAdmin(uid)) { await ctx.answerCbQuery('Not authorized'); return ctx.reply('Not authorized to delete.'); }
          await db.deleteComment(commentId).catch(()=>null);
          await ctx.answerCbQuery('Deleted');
          return ctx.reply('Comment deleted.');
        } catch (e) {
          console.error('delete_comment err', e);
          await ctx.answerCbQuery('Error deleting');
          return ctx.reply('Could not delete comment.');
        }
      }

      if (cmd === 'admin_delete_comment') {
        if (!isAdmin(uid)) { await ctx.answerCbQuery('Admin only'); return; }
        const commentId = Number(parts[1]);
        await db.deleteComment(commentId).catch(()=>null);
        await ctx.answerCbQuery('Deleted by admin');
        return ctx.reply('Comment deleted by admin.');
      }

      if (cmd === 'admin_delete_reply') {
        if (!isAdmin(uid)) { await ctx.answerCbQuery('Admin only'); return; }
        const replyId = Number(parts[1]);
        await db.deleteReply(replyId).catch(()=>null);
        await ctx.answerCbQuery('Reply deleted');
        return ctx.reply('Reply deleted by admin.');
      }

      // ----------------- Payment approve / reject -----------------
      if (cmd === 'approve_payment') {
        if (!isAdmin(uid)) { await ctx.answerCbQuery('Admin only'); return; }
        const paymentId = Number(parts[1]);
        try {
          const payment = await db.getPayment(paymentId);
          if (!payment) { await ctx.answerCbQuery('Payment not found'); return ctx.reply('Payment not found.'); }
          await db.creditUser(payment.user_telegram_id, payment.credits || 0).catch(()=>null);
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

      if (cmd === 'reject_payment') {
        if (!isAdmin(uid)) { await ctx.answerCbQuery('Admin only'); return; }
        const paymentId = Number(parts[1]);
        try {
          const payment = await db.getPayment(paymentId);
          if (!payment) { await ctx.answerCbQuery('Payment not found'); return ctx.reply('Payment not found.'); }
          await db.setPaymentStatus(paymentId, 'rejected', { rejected_by: uid }).catch(()=>null);
          try { await ctx.telegram.sendMessage(payment.user_telegram_id, 'Your payment request was rejected by admin. Contact support.'); } catch (e) {}
          await ctx.answerCbQuery('Rejected');
          return ctx.reply('Payment rejected.');
        } catch (e) {
          console.error('reject_payment err', e);
          await ctx.answerCbQuery('Error rejecting');
          return ctx.reply('Error rejecting payment.');
        }
      }

      // ----------------- Track / Untrack -----------------
      if (cmd === 'track') {
        const threadId = Number(parts[1]);
        try {
          await db.trackThread(ctx.from.id, threadId);
          await ctx.answerCbQuery('Video tracked');
          return ctx.reply('This video is now tracked. You will receive notifications when new comments are added.');
        } catch (e) {
          console.error('track err', e);
          await ctx.answerCbQuery('Could not track');
          return ctx.reply('Could not track the video (table missing?).');
        }
      }

      if (cmd === 'untrack') {
        const threadId = Number(parts[1]);
        try {
          await db.untrackThread(ctx.from.id, threadId);
          await ctx.answerCbQuery('Tracking removed');
          return ctx.reply('You stopped tracking this video.');
        } catch (e) {
          console.error('untrack err', e);
          await ctx.answerCbQuery('Could not untrack');
          return ctx.reply('Could not untrack the video.');
        }
      }

      // ----------------- React (comment or reply) -----------------
      // react|targetType|targetId|emoji
      if (cmd === 'react') {
        const targetType = parts[1]; // 'comment' or 'reply'
        const targetId = Number(parts[2]);
        const emoji = parts[3];
        try {
          await db.toggleReaction({ user_telegram_id: uid, target_type: targetType, target_id: targetId, emoji });
          await ctx.answerCbQuery('Saved');
        } catch (e) {
          console.error('react err', e);
          await ctx.answerCbQuery('Error');
        }
        return;
      }

      // convenience react for replies (rreact)
      if (cmd === 'rreact') {
        const replyId = Number(parts[1]);
        const emoji = parts[2];
        try {
          await db.toggleReaction({ user_telegram_id: uid, target_type: 'reply', target_id: replyId, emoji });
          await ctx.answerCbQuery('Saved');
        } catch (e) {
          console.error('rreact err', e);
          await ctx.answerCbQuery('Error');
        }
        return;
      }

      // ----------------- Report reply (flow) -----------------
      if (cmd === 'report_reply') {
        const replyId = Number(parts[1]);
        const commentId = Number(parts[2]);
        Pending.set(uid, { type: 'await_report_reason', targetType: 'reply', targetId: replyId, commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain briefly why you report this reply.');
      }

      // Cancel
      if (cmd === 'cancel') {
        Pending.delete(uid);
        await ctx.answerCbQuery('Cancelled');
        return ctx.reply('Cancelled.', buildMainKeyboard(uid));
      }

      // Show more comments or replies - handled earlier
      await ctx.answerCbQuery();
      return;
    } catch (err) {
      console.error('callback_query handler err', err);
      try { await ctx.answerCbQuery('Error'); } catch (e) {}
      return;
    }
  });

  // Launch for local debugging
  if (process.env.NODE_ENV !== 'production') {
    bot.launch().then(()=>console.log('Bot launched (polling)'));
  }

  return bot;
}

// Export initializer
module.exports = { initBot };
