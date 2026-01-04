// src/bot.js
const { Telegraf, Markup } = require('telegraf');
const db = require('./database');
const utils = require('./utils');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const WHATSAPP_ADMIN = (process.env.WHATSAPP_ADMIN || '').replace(/\D/g,'');
const WHATSAPP_LINK = WHATSAPP_ADMIN ? `https://wa.me/${WHATSAPP_ADMIN}` : null;

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');

const PAYMENT_RECIPIENT = {
  telebirr_number: process.env.PAY_TELEBIRR_NUMBER || '0962058608',
  cbe_number: process.env.PAY_CBE_NUMBER || '1000555367884',
  telebirr_name: 'WorldVoiceComment',
  cbe_name: 'WorldVoiceComment'
};

const PAYMENT_PACKAGES = [
  { id: 'pkg1', label: '25 comments - 12 ETB', credits: 25, amount: 12 },
  { id: 'pkg2', label: '60 comments - 27 ETB', credits: 60, amount: 27 },
  { id: 'pkg3', label: '130 comments - 49 ETB', credits: 130, amount: 49 },
  { id: 'pkg4', label: '240 comments - 89 ETB', credits: 240, amount: 89 }
];

function isAdmin(id) { return ADMIN_IDS.includes(Number(id)); }
const Pending = new Map();

function userKeyboard(isAdminUser = false) {
  const base = [
    ['🎥 Add Comment', '🎧 Listen Comments'],
    ['💬 My Comments', '🔎 Search'],
    ['⭐ Favorites', '🔔 Notifications'],
    ['🛒 Buy', '📞 Support'],
    ['💰 Balance']
  ];
  if (isAdminUser) {
    // add admin-only Post button
    base[0].push('📣 Post'); // small trick: admin sees Post
  }
  return Markup.keyboard(base, { columns: 2 }).resize();
}

// Helper: send thread preview (thumbnail if available)
async function sendThreadPreviewMessage(ctx, thread) {
  if (!thread) return;
  try {
    // thread includes social_link, canonical_link, normalized_link
    const link = thread.social_link || thread.canonical_link || thread.normalized_link;
    const norm = await utils.normalizeVideoUrl(link).catch(()=>null);
    if (norm && norm.thumbnail) {
      await ctx.replyWithPhoto(norm.thumbnail, { caption: link });
      return;
    }
    await ctx.reply(link || 'Video link');
  } catch (e) { await ctx.reply(thread.social_link || thread.canonical_link || 'Video'); }
}

// Build inline keyboard for a comment (replies count, favorite toggle, reactions, report, delete if own)
async function buildCommentInlineButtons(commentId, ctxUserId) {
  // Favorite label
  try {
    const favQuery = await db.supabase.from('favorites').select('*').eq('telegram_id', ctxUserId).eq('comment_id', commentId).limit(1).maybeSingle();
    const favRow = favQuery && (favQuery.data || favQuery);
    const favLabel = favRow ? '★ Favorited' : '☆ Favorite';

    // Count replies
    const rcount = await db.supabase.from('replies').select('id', { count: 'exact' }).eq('comment_id', commentId).catch(()=>({ count: 0 }));
    const repliesCount = rcount && rcount.count ? Number(rcount.count) : 0;

    const rows = [
      [ Markup.button.callback('💬 Reply', `replymenu|${commentId}`), Markup.button.callback(favLabel, `fav|${commentId}`) ],
      [ Markup.button.callback(`▶️ Show replies (${repliesCount})`, `list_replies|${commentId}|1`), Markup.button.callback('🚩 Report', `report|${commentId}`) ],
      [ Markup.button.callback('❤️', `react|${commentId}|heart`), Markup.button.callback('😂', `react|${commentId}|laugh`) ]
    ];
    // allow delete if owner or admin
    const comment = await db.getCommentById(commentId).catch(()=>null);
    if (comment && Number(comment.telegram_id) === Number(ctxUserId)) rows.push([ Markup.button.callback('🗑 Delete', `delete_my_comment|${commentId}`) ]);
    if (isAdmin(ctxUserId)) rows.push([ Markup.button.callback('🗑 Admin Delete', `admin_delete_comment|${commentId}`) ]);
    return Markup.inlineKeyboard(rows);
  } catch (e) {
    return Markup.inlineKeyboard([[ Markup.button.callback('🚩 Report', `report|${commentId}`) ]]);
  }
}

// Build reply inline (replies have reaction + report only)
function buildReplyInline(replyId, ctxUserId, commentId) {
  const rows = [
    [ Markup.button.callback('❤️', `rreact|${replyId}|heart`), Markup.button.callback('🚩 Report', `rreport|${replyId}|${commentId}`) ]
  ];
  if (isAdmin(ctxUserId)) rows.push([ Markup.button.callback('🗑 Admin Delete Reply', `admin_delete_reply|${replyId}`) ]);
  return Markup.inlineKeyboard(rows);
}

// Helper: show comments page (threadId, page)
async function sendCommentsPage(ctx, threadId, page = 1) {
  try {
    const perPage = 8;
    const offset = (page - 1) * perPage;
    const comments = await db.listCommentsByThread(threadId, offset, perPage);
    if (!comments || comments.length === 0) return ctx.reply('No comments for this video yet.');

    for (const c of comments) {
      // show thumbnail & link
      const thread = await db.getThreadById(c.thread_id).catch(()=>null);
      if (thread) await sendThreadPreviewMessage(ctx, thread);
      if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id);
      // send code under voice
      await ctx.reply(utils.encodeShortCode(c.id), await buildCommentInlineButtons(c.id, ctx.from.id));
    }

    // pagination
    const countRes = await db.supabase.from('voice_comments').select('id', { count: 'exact' }).eq('thread_id', threadId);
    const total = countRes && countRes.count ? Number(countRes.count) : 0;
    if (offset + perPage < total) {
      await ctx.reply('More comments:', Markup.inlineKeyboard([[ Markup.button.callback('More', `listen|${threadId}|${page+1}`) ]]));
    }
  } catch (e) {
    console.error('sendCommentsPage err', e);
    return ctx.reply('Could not fetch comments.');
  }
}

/* ---------- Initialize bot ---------- */
async function initBot() {
  const bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    try {
      await db.ensureUserRow(ctx.from).catch(()=>null);
      const balQ = await db.supabase.from('users').select('free_comments').eq('telegram_id', ctx.from.id).limit(1).maybeSingle().catch(()=>null);
      const bal = (balQ && (balQ.data || balQ).free_comments) ? Number((balQ.data || balQ).free_comments) : 0;
      await ctx.reply(`Welcome — available comments: *${bal}*`, { parse_mode: 'Markdown' });
      await ctx.reply('Use the keyboard below.', userKeyboard(isAdmin(ctx.from.id)));
    } catch (e) {
      console.error('start err', e);
      await ctx.reply('Welcome. Use the keyboard below.', userKeyboard(isAdmin(ctx.from.id)));
    }
  });

  // Admin post trigger text and keyboard
  bot.hears('📣 Post', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    Pending.set(ctx.from.id, { type: 'await_admin_post' });
    return ctx.reply('Send the post content (text/photo/voice/document). It will be broadcast to users.');
  });

  // Support
  bot.hears(/📞 Support|support/i, async (ctx) => {
    if (WHATSAPP_LINK) return ctx.reply(`Contact admin: ${WHATSAPP_LINK}`);
    return ctx.reply('Contact admin via Telegram.');
  });

  // Buy flow
  bot.hears(/🛒 Buy|buy/i, async (ctx) => {
    const inline = PAYMENT_PACKAGES.map(p => [ Markup.button.callback(p.label, `select_pkg|${p.id}`) ]);
    inline.push([ Markup.button.callback('Contact admin', 'contact_whatsapp') ]);
    return ctx.reply('Choose a package:', Markup.inlineKeyboard(inline));
  });

  // Balance
  bot.hears(/💰 Balance|balance/i, async (ctx) => {
    try {
      const q = await db.supabase.from('users').select('free_comments').eq('telegram_id', ctx.from.id).limit(1).maybeSingle();
      const bal = q && (q.data || q).free_comments ? Number((q.data || q).free_comments) : 0;
      return ctx.reply(`Your balance: *${bal}*`, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('balance err', e);
      return ctx.reply('Could not fetch balance.');
    }
  });

  // Add Comment command
  bot.hears(/🎥 Add Comment|add comment/i, async (ctx) => {
    Pending.set(ctx.from.id, { type: 'await_link_for_add' });
    return ctx.reply('Send the TikTok/YouTube link to add a voice comment for.');
  });

  // Listen Comments command
  bot.hears(/🎧 Listen Comments|listen comments/i, async (ctx) => {
    Pending.set(ctx.from.id, { type: 'await_link_for_listen' });
    return ctx.reply('Send the video link to listen comments.');
  });

  // My Comments
  bot.hears(/💬 My Comments|my comments/i, async (ctx) => {
    try {
      const rows = await db.listCommentsByUser(ctx.from.id);
      if (!rows || rows.length === 0) return ctx.reply('You have no comments yet.');
      for (const c of rows) {
        const thread = c.thread_id ? await db.getThreadById(c.thread_id).catch(()=>null) : null;
        if (thread) await sendThreadPreviewMessage(ctx, thread);
        if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id);
        await ctx.reply(utils.encodeShortCode(c.id), await buildCommentInlineButtons(c.id, ctx.from.id));
      }
    } catch (e) {
      console.error('my comments err', e);
      return ctx.reply('Could not fetch your comments.');
    }
  });

  // Favorites
  bot.hears(/⭐ Favorites|favorites/i, async (ctx) => {
    try {
      const favs = await db.listFavoritesForUser(ctx.from.id);
      if (!favs || favs.length === 0) return ctx.reply('No favorites yet.');
      for (const f of favs) {
        if (f.thread_id) {
          const thread = await db.getThreadById(f.thread_id).catch(()=>null);
          if (thread) await sendThreadPreviewMessage(ctx, thread);
        }
        if (f.telegram_file_id) await ctx.replyWithVoice(f.telegram_file_id);
        await ctx.reply(utils.encodeShortCode(f.id), await buildCommentInlineButtons(f.id, ctx.from.id));
      }
    } catch (e) {
      console.error('favorites err', e);
      return ctx.reply('Could not fetch favorites.');
    }
  });

  // Search code
  bot.hears(/🔎 Search|search/i, async (ctx) => {
    Pending.set(ctx.from.id, { type: 'await_search_code' });
    return ctx.reply('Send the short code (e.g. 1FZ).');
  });

  // Generic text handler
  bot.on('text', async (ctx) => {
    const txt = ctx.message.text;
    const uid = ctx.from.id;
    const pending = Pending.get(uid);

    // Admin post content
    if (pending && pending.type === 'await_admin_post' && isAdmin(uid)) {
      Pending.delete(uid);
      const text = txt.trim();
      try {
        await db.addNotificationRow({ telegram_id: null, message: text, meta: { admin_id: uid, type: 'admin_post' } }).catch(()=>null);
        // broadcast to users: fetch users then send (be cautious if large user base)
        const { data: users } = await db.supabase.from('users').select('telegram_id').limit(500).catch(()=>({ data: [] }));
        if (users && users.length) {
          for (const u of users) {
            try { await bot.telegram.sendMessage(u.telegram_id, `📣 Admin post:\n\n${text}`); } catch (e) {}
          }
        }
        return ctx.reply('Post published.');
      } catch (e) {
        console.error('admin_post_text err', e);
        return ctx.reply('Could not publish post.');
      }
    }

    // Upload proof text (do not show payment id to user)
    if (pending && pending.type === 'await_upload_proof' && pending.paymentId) {
      Pending.delete(uid);
      try {
        const proofText = txt.trim();
        await db.updatePaymentStatus(pending.paymentId, 'proof_submitted', { proof_link: proofText }).catch(()=>null);
        // notify admins with payment id (admins need id)
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendMessage(adm, `Payment proof submitted by ${uid}. Review and approve.`); } catch (e) {}
        }
        return ctx.reply('Proof received. Admins will review.');
      } catch (e) {
        console.error('upload proof text err', e);
        return ctx.reply('Could not submit proof. Try again.');
      }
    }

    // Report reason for a comment
    if (pending && pending.type === 'await_report_reason' && pending.commentId) {
      Pending.delete(uid);
      try {
        const reason = txt.trim();
        await db.insertReport({ reporter_telegram_id: uid, comment_id: pending.commentId, reason });
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendMessage(adm, `🚨 Report: comment ${pending.commentId}\nReporter: ${uid}\nReason: ${reason}`); } catch (e) {}
        }
        return ctx.reply('Report submitted to admins.');
      } catch (e) {
        console.error('report reason err', e);
        return ctx.reply('Could not submit report.');
      }
    }

    // Search code handler
    if (pending && pending.type === 'await_search_code') {
      Pending.delete(uid);
      const code = txt.trim();
      const id = utils.decodeShortCode(code);
      if (!id) return ctx.reply('Invalid code. Make sure you typed it correctly.');
      try {
        const comment = await db.getCommentById(id);
        if (!comment) return ctx.reply('Comment not found.');
        if (comment.thread_id) {
          const thread = await db.getThreadById(comment.thread_id).catch(()=>null);
          if (thread) await sendThreadPreviewMessage(ctx, thread);
        }
        if (comment.telegram_file_id) await ctx.replyWithVoice(comment.telegram_file_id);
        return ctx.reply(utils.encodeShortCode(comment.id), await buildCommentInlineButtons(comment.id, uid));
      } catch (e) {
        console.error('search code err', e);
        return ctx.reply('Error searching code.');
      }
    }

    // Add comment link provided
    if (pending && pending.type === 'await_link_for_add') {
      Pending.delete(uid);
      const link = utils.extractFirstUrl(txt) || txt.trim();
      if (!link) return ctx.reply('No link detected. Send video link.');
      try {
        const thread = await db.findOrCreateThread(link, uid).catch(()=>null);
        if (!thread) return ctx.reply('Could not process the link.');
        Pending.set(uid, { type: 'await_add_comment_voice', threadId: thread.id });
        return ctx.reply('Now send the voice to add as a comment. (voice costs 1 credit)');
      } catch (e) {
        console.error('await_link_for_add err', e);
        return ctx.reply('Could not process the link.');
      }
    }

    // Listen comments link provided
    if (pending && pending.type === 'await_link_for_listen') {
      Pending.delete(uid);
      const link = utils.extractFirstUrl(txt) || txt.trim();
      if (!link) return ctx.reply('No link detected.');
      try {
        const thread = await db.findOrCreateThread(link, null).catch(()=>null);
        if (!thread || !thread.id) return ctx.reply('No comments for this video yet.');
        return sendCommentsPage(ctx, thread.id, 1);
      } catch (e) {
        console.error('listen link err', e);
        return ctx.reply('Could not list comments for that video.');
      }
    }

    // Reply text (should be set by replymenu)
    if (pending && pending.type === 'reply_text' && pending.commentId) {
      Pending.delete(uid);
      try {
        const inserted = await db.insertReplyRow({
          comment_id: pending.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          reply_text: txt.trim()
        });
        // Notify owner
        const comment = await db.getCommentById(pending.commentId).catch(()=>null);
        if (comment && comment.telegram_id && Number(comment.telegram_id) !== Number(uid)) {
          await db.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply to your comment ${utils.encodeShortCode(comment.id)}`, meta: { comment_id: comment.id } }).catch(()=>null);
          try { await bot.telegram.sendMessage(comment.telegram_id, `New reply to your comment ${utils.encodeShortCode(comment.id)}`); } catch (e) {}
        }
        await ctx.reply('Reply saved.');
      } catch (e) {
        console.error('reply_text save err', e);
        return ctx.reply('Could not save reply.');
      }
    }

    // default
    return ctx.reply('I did not understand. Press a button or send a video link.', userKeyboard(isAdmin(uid)));
  });

  // Photo handler (reply photo, admin post photo, upload proof photo)
  bot.on('photo', async (ctx) => {
    const uid = ctx.from.id;
    const pending = Pending.get(uid);
    const photos = ctx.message.photo || [];
    const file = photos[photos.length - 1];
    if (!file) return ctx.reply('No photo found.');

    // Admin post
    if (pending && pending.type === 'await_admin_post' && isAdmin(uid)) {
      Pending.delete(uid);
      try {
        await db.addNotificationRow({ telegram_id: null, message: '(photo post)', meta: { admin_id: uid, telegram_file_id: file.file_id, type: 'photo' } }).catch(()=>null);
        const { data: users } = await db.supabase.from('users').select('telegram_id').limit(500).catch(()=>({ data: [] }));
        if (users && users.length) {
          for (const u of users) {
            try { await bot.telegram.sendPhoto(u.telegram_id, file.file_id, { caption: '📣 Admin post' }); } catch (e) {}
          }
        }
        return ctx.reply('Post published.');
      } catch (e) {
        console.error('admin post photo err', e);
        return ctx.reply('Could not publish post.');
      }
    }

    // Upload proof
    if (pending && pending.type === 'await_upload_proof' && pending.paymentId) {
      Pending.delete(uid);
      try {
        await db.updatePaymentStatus(pending.paymentId, 'proof_submitted', { proof_telegram_file_id: file.file_id }).catch(()=>null);
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendPhoto(adm, file.file_id, { caption: `Payment proof submitted by ${uid}` }); } catch (e) {}
        }
        return ctx.reply('Proof received. Admins will review.');
      } catch (e) {
        console.error('upload proof photo err', e);
        return ctx.reply('Could not submit proof.');
      }
    }

    // Reply photo (free)
    if (pending && pending.type === 'await_reply_photo' && pending.commentId) {
      Pending.delete(uid);
      try {
        const inserted = await db.insertReplyRow({
          comment_id: pending.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          telegram_file_id: file.file_id
        });
        const comment = await db.getCommentById(pending.commentId).catch(()=>null);
        if (comment && comment.telegram_id && Number(comment.telegram_id) !== Number(uid)) {
          await db.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply to your comment ${utils.encodeShortCode(comment.id)}` }).catch(()=>null);
          try { await bot.telegram.sendMessage(comment.telegram_id, `New reply to your comment ${utils.encodeShortCode(comment.id)}`); } catch (e) {}
        }
        await ctx.replyWithPhoto(file.file_id);
        await ctx.reply(utils.encodeShortCode(inserted.id), buildReplyInline(inserted.id, uid, pending.commentId));
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
    const pending = Pending.get(uid);
    const voice = ctx.message.voice;
    if (!voice) return ctx.reply('No voice found.');

    // Admin post voice
    if (pending && pending.type === 'await_admin_post' && isAdmin(uid)) {
      Pending.delete(uid);
      try {
        await db.addNotificationRow({ telegram_id: null, message: '(voice post)', meta: { admin_id: uid, telegram_file_id: voice.file_id, type: 'voice' } }).catch(()=>null);
        const { data: users } = await db.supabase.from('users').select('telegram_id').limit(500).catch(()=>({ data: [] }));
        if (users && users.length) {
          for (const u of users) {
            try { await bot.telegram.sendVoice(u.telegram_id, voice.file_id, { caption: '📣 Admin post' }); } catch (e) {}
          }
        }
        return ctx.reply('Post published.');
      } catch (e) {
        console.error('admin post voice err', e);
        return ctx.reply('Could not publish post.');
      }
    }

    // Upload proof voice (unlikely but handle)
    if (pending && pending.type === 'await_upload_proof' && pending.paymentId) {
      Pending.delete(uid);
      try {
        await db.updatePaymentStatus(pending.paymentId, 'proof_submitted', { proof_telegram_file_id: voice.file_id }).catch(()=>null);
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendVoice(adm, voice.file_id, { caption: `Payment proof submitted by ${uid}` }); } catch (e) {}
        }
        return ctx.reply('Proof received. Admins will review.');
      } catch (e) {
        console.error('upload proof voice err', e);
        return ctx.reply('Could not submit proof.');
      }
    }

    // Add comment voice
    if (pending && pending.type === 'await_add_comment_voice' && pending.threadId) {
      // check balance
      try {
        const userRow = await db.supabase.from('users').select('free_comments').eq('telegram_id', uid).limit(1).maybeSingle();
        const bal = (userRow && (userRow.data || userRow).free_comments) ? Number((userRow.data || userRow).free_comments) : 0;
        if (bal <= 0) return ctx.reply('Pay before comment. Your balance is 0.');
        Pending.delete(uid);
        const inserted = await db.insertVoiceComment({
          thread_id: pending.threadId,
          telegram_id: uid,
          username: ctx.from.username || null,
          first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id
        });
        // debit 1 credit
        await db.ensureUserRow(uid).catch(()=>null);
        await db.supabase.from('users').upsert({ telegram_id: uid, free_comments: Math.max(0, bal - 1) }, { onConflict: ['telegram_id'] }).catch(()=>null);
        // send voice then code (code under voice)
        await ctx.replyWithVoice(voice.file_id);
        await ctx.reply(utils.encodeShortCode(inserted.id), await buildCommentInlineButtons(inserted.id, uid));
        // notify trackers of this thread (match by thread's normalized link)
        try {
          const trackers = await db.listTrackersForThread(pending.threadId);
          if (trackers && trackers.length) {
            for (const t of trackers) {
              if (Number(t.tracker_telegram_id) !== Number(uid)) {
                await db.addNotificationRow({ telegram_id: t.tracker_telegram_id, message: `New comment on tracked video`, meta: { comment_id: inserted.id } }).catch(()=>null);
                try { await bot.telegram.sendMessage(t.tracker_telegram_id, `New comment on a video you track`); } catch (e) {}
              }
            }
          }
        } catch (e) { /* ignore tracker notify errors */ }
        return;
      } catch (e) {
        console.error('insertVoiceComment err', e);
        return ctx.reply('Could not save voice comment.');
      }
    }

    // Reply voice
    if (pending && pending.type === 'await_reply_voice' && pending.commentId) {
      // check balance
      try {
        const userRow = await db.supabase.from('users').select('free_comments').eq('telegram_id', uid).limit(1).maybeSingle();
        const bal = (userRow && (userRow.data || userRow).free_comments) ? Number((userRow.data || userRow).free_comments) : 0;
        if (bal <= 0) return ctx.reply('Pay before comment. Your balance is 0.');
        Pending.delete(uid);
        const inserted = await db.insertReplyRow({
          comment_id: pending.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id
        });
        // debit credit
        await db.ensureUserRow(uid).catch(()=>null);
        await db.supabase.from('users').upsert({ telegram_id: uid, free_comments: Math.max(0, bal - 1) }, { onConflict: ['telegram_id'] }).catch(()=>null);
        // notify comment owner
        const comment = await db.getCommentById(pending.commentId).catch(()=>null);
        if (comment && comment.telegram_id && Number(comment.telegram_id) !== Number(uid)) {
          await db.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply to your comment ${utils.encodeShortCode(comment.id)}` }).catch(()=>null);
          try { await bot.telegram.sendMessage(comment.telegram_id, `New reply to your comment ${utils.encodeShortCode(comment.id)}`); } catch (e) {}
        }
        await ctx.replyWithVoice(voice.file_id);
        await ctx.reply(utils.encodeShortCode(inserted.id), buildReplyInline(inserted.id, uid, pending.commentId));
        return;
      } catch (e) {
        console.error('insertReplyRow err', e);
        return ctx.reply('Could not save reply.');
      }
    }

    return ctx.reply('No expected action for voice now.');
  });

  // Callback queries handler
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery && ctx.callbackQuery.data;
    if (!data) return ctx.answerCbQuery();
    const parts = data.split('|');
    const cmd = parts[0], a1 = parts[1], a2 = parts[2];

    Pending.delete(ctx.from.id); // clear pending on any callback

    try {
      if (cmd === 'select_pkg') {
        const pkg = PAYMENT_PACKAGES.find(p => p.id === a1);
        if (!pkg) return ctx.answerCbQuery('Invalid package');
        const inline = Markup.inlineKeyboard([[ Markup.button.callback(`Confirm ${pkg.label}`, `confirm_pkg|${pkg.id}`), Markup.button.callback('Cancel', 'cancel_action') ]]);
        await ctx.reply(`You selected ${pkg.label}. Confirm to get payment details.`, inline);
        return ctx.answerCbQuery();
      }

      if (cmd === 'confirm_pkg') {
        const pkg = PAYMENT_PACKAGES.find(p => p.id === a1);
        if (!pkg) return ctx.answerCbQuery('Invalid package');
        try {
          const created = await db.createPaymentRequest({ telegram_id: ctx.from.id, package_name: pkg.label, comments_amount: pkg.credits, amount: pkg.amount });
          // Provide payment details without showing payment id to user
          const paymentText = `${PAYMENT_RECIPIENT.telebirr_name}\nTELEBIRR: ${PAYMENT_RECIPIENT.telebirr_number}\n${PAYMENT_RECIPIENT.cbe_name}\nCBE: ${PAYMENT_RECIPIENT.cbe_number}\nAmount: ${pkg.amount} ETB\n\nCopy the number and pay, then press Upload Proof.`;
          const inline = Markup.inlineKeyboard([
            [ Markup.button.callback('Copy TELEBIRR', `copy_number|${PAYMENT_RECIPIENT.telebirr_number}`), Markup.button.callback('Copy CBE', `copy_number|${PAYMENT_RECIPIENT.cbe_number}`) ],
            [ Markup.button.callback('Upload Proof', `upload_proof|${created.id}`) ],
            [ Markup.button.url('Contact admin', WHATSAPP_LINK || 'https://t.me/' + (ADMIN_IDS[0] || '')) ]
          ]);
          await ctx.reply(paymentText);
          await ctx.reply('Payment options:', inline);
          // notify admins with payment id
          for (const adm of ADMIN_IDS) {
            try { await bot.telegram.sendMessage(adm, `New payment request by ${ctx.from.id} — ${pkg.label}. ID: ${created.id}`); } catch (e) {}
          }
          return ctx.answerCbQuery();
        } catch (e) {
          console.error('confirm_pkg err', e);
          return ctx.reply('Could not create payment request. Contact support.');
        }
      }

      if (cmd === 'copy_number') {
        await ctx.answerCbQuery('Number shown');
        return ctx.reply(a1);
      }

      if (cmd === 'upload_proof') {
        const pid = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_upload_proof', paymentId: pid });
        await ctx.answerCbQuery();
        return ctx.reply('Send the proof image or paste the link. (The payment id will not be shown to other users.)');
      }

      if (cmd === 'addvoice') {
        const threadId = a1 ? Number(a1) : null;
        if (!threadId) {
          await ctx.answerCbQuery('No thread id');
          return ctx.reply('Could not find the video.');
        }
        Pending.set(ctx.from.id, { type: 'await_add_comment_voice', threadId });
        await ctx.answerCbQuery('Send voice to add as comment');
        return ctx.reply('Send voice now. (voice costs 1 credit)');
      }

      if (cmd === 'listen') {
        const threadId = a1 ? Number(a1) : null;
        const page = Number(a2 || 1);
        if (!threadId) { await ctx.answerCbQuery('No thread'); return; }
        await sendCommentsPage(ctx, threadId, page);
        return ctx.answerCbQuery();
      }

      // reply menu
      if (cmd === 'replymenu') {
        const commentId = Number(a1);
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('Reply Text (free)', `reply_text|${commentId}`), Markup.button.callback('Reply Photo (free)', `reply_photo|${commentId}`) ],
          [ Markup.button.callback('Reply Voice (costs 1)', `reply_voice|${commentId}`) ]
        ]);
        await ctx.reply('Choose reply type:', inline);
        return ctx.answerCbQuery();
      }

      if (cmd === 'reply_text') {
        Pending.set(ctx.from.id, { type: 'reply_text', commentId: Number(a1) });
        await ctx.answerCbQuery('Send text reply now');
        return ctx.reply('Send your reply text now.');
      }
      if (cmd === 'reply_photo') {
        Pending.set(ctx.from.id, { type: 'await_reply_photo', commentId: Number(a1) });
        await ctx.answerCbQuery('Send photo to reply');
        return ctx.reply('Send your photo to reply now (free).');
      }
      if (cmd === 'reply_voice') {
        Pending.set(ctx.from.id, { type: 'await_reply_voice', commentId: Number(a1) });
        await ctx.answerCbQuery('Send voice reply now');
        return ctx.reply('Send your voice reply now (costs 1 credit).');
      }

      // react to comment
      if (cmd === 'react') {
        const commentId = Number(a1), type = a2;
        try {
          const { data: existing } = await db.supabase.from('reactions').select('*').eq('comment_id', commentId).eq('telegram_id', ctx.from.id).limit(1).maybeSingle();
          const exists = existing && (existing.data || existing);
          if (exists) {
            if (exists.type === type) await db.supabase.from('reactions').delete().eq('id', exists.id).catch(()=>null);
            else await db.supabase.from('reactions').update({ type }).eq('id', exists.id).catch(()=>null);
          } else await db.insertReactionRow({ comment_id: commentId, telegram_id: ctx.from.id, type });
          await ctx.answerCbQuery('Saved');
          // refresh inline markup (best effort)
          try { await ctx.editMessageReplyMarkup((await buildCommentInlineButtons(commentId, ctx.from.id)).reply_markup).catch(()=>null); } catch (e) {}
        } catch (e) {
          console.error('react err', e);
          await ctx.answerCbQuery('Error');
        }
        return;
      }

      // react to reply
      if (cmd === 'rreact') {
        const replyId = Number(a1), type = a2;
        try {
          const { data: existing } = await db.supabase.from('reactions').select('*').eq('reply_id', replyId).eq('telegram_id', ctx.from.id).limit(1).maybeSingle();
          const exists = existing && (existing.data || existing);
          if (exists) {
            if (exists.type === type) await db.supabase.from('reactions').delete().eq('id', exists.id).catch(()=>null);
            else await db.supabase.from('reactions').update({ type }).eq('id', exists.id).catch(()=>null);
          } else await db.insertReactionRow({ reply_id: replyId, telegram_id: ctx.from.id, type });
          await ctx.answerCbQuery('Saved');
        } catch (e) { console.error('rreact err', e); await ctx.answerCbQuery('Error'); }
        return;
      }

      // favorite toggle
      if (cmd === 'fav') {
        const id = Number(a1);
        try {
          const res = await db.toggleFavoriteRow(ctx.from.id, id);
          await ctx.answerCbQuery(res.removed ? 'Favorite removed' : 'Favorite added');
          try { await ctx.editMessageReplyMarkup((await buildCommentInlineButtons(id, ctx.from.id)).reply_markup).catch(()=>null); } catch (e) {}
        } catch (e) { console.error('fav err', e); await ctx.answerCbQuery('Error'); }
        return;
      }

      // list replies
      if (cmd === 'list_replies') {
        const commentId = Number(a1), page = Number(a2 || 1);
        try {
          const perPage = 5, offset = (page - 1) * perPage;
          const replies = await db.listReplies(commentId, offset, perPage);
          if (!replies || replies.length === 0) { await ctx.reply('No replies yet.'); await ctx.answerCbQuery(); return; }
          for (const r of replies) {
            if (r.telegram_file_id) await ctx.replyWithVoice(r.telegram_file_id, { caption: r.replier_first_name || r.replier_username || 'User' });
            else await ctx.reply(`${r.replier_first_name || r.replier_username || 'User'}: ${r.reply_text || '(no text)'}`);
            await ctx.reply(utils.encodeShortCode(r.id), buildReplyInline(r.id, ctx.from.id, commentId));
          }
          const countRes = await db.supabase.from('replies').select('id', { count: 'exact' }).eq('comment_id', commentId);
          const total = (countRes && countRes.count) ? Number(countRes.count) : 0;
          if (offset + perPage < total) await ctx.reply('More replies:', Markup.inlineKeyboard([[ Markup.button.callback('More', `list_replies|${commentId}|${page+1}`) ]]));
          return ctx.answerCbQuery();
        } catch (e) { console.error('list_replies err', e); await ctx.answerCbQuery('Error'); }
        return;
      }

      // report comment
      if (cmd === 'report') {
        Pending.set(ctx.from.id, { type: 'await_report_reason', commentId: Number(a1) });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain in short why you report this comment.');
      }

      // report reply
      if (cmd === 'rreport') {
        Pending.set(ctx.from.id, { type: 'await_report_reason', replyId: Number(a1) });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain in short why you report this reply.');
      }

      // delete my comment
      if (cmd === 'delete_my_comment') {
        const commentId = Number(a1);
        try {
          const comment = await db.getCommentById(commentId);
          if (!comment) { await ctx.answerCbQuery('Not found'); return; }
          if (Number(comment.telegram_id) !== Number(ctx.from.id) && !isAdmin(ctx.from.id)) { await ctx.answerCbQuery('Not authorized'); return; }
          await db.deleteCommentById(commentId).catch(()=>null);
          await ctx.answerCbQuery('Deleted');
          return ctx.reply('Comment deleted.');
        } catch (e) { console.error('delete_my_comment err', e); await ctx.answerCbQuery('Error'); }
        return;
      }

      // admin approve payment
      if (cmd === 'admin_approve') {
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        const pid = Number(a1);
        try {
          const payment = await db.getPaymentById(pid);
          if (!payment) { await ctx.answerCbQuery('Payment not found'); return; }
          await db.ensureUserRow(payment.telegram_id).catch(()=>null);
          const userQ = await db.supabase.from('users').select('free_comments').eq('telegram_id', payment.telegram_id).limit(1).maybeSingle();
          const current = userQ && (userQ.data || userQ).free_comments ? Number((userQ.data || userQ).free_comments) : 0;
          const newBal = current + Number(payment.comments_amount || 0);
          await db.supabase.from('users').upsert({ telegram_id: payment.telegram_id, free_comments: newBal }, { onConflict: ['telegram_id'] }).catch(()=>null);
          await db.updatePaymentStatus(pid, 'approved', { approved_by: ctx.from.id, approved_at: new Date().toISOString() }).catch(()=>null);
          try { await bot.telegram.sendMessage(payment.telegram_id, `Your payment was approved. You received ${payment.comments_amount} comments.`); } catch (e) {}
          await ctx.answerCbQuery('Approved');
          return ctx.reply(`Payment approved and credited.`);
        } catch (e) {
          console.error('admin_approve err', e);
          await ctx.answerCbQuery('Error Approving');
          return ctx.reply('Error approving payment.');
        }
      }

      // cancel action
      if (cmd === 'cancel_action') {
        Pending.delete(ctx.from.id);
        await ctx.answerCbQuery();
        return ctx.reply('Canceled.', userKeyboard(isAdmin(ctx.from.id)));
      }

      return ctx.answerCbQuery();
    } catch (e) {
      console.error('callback err', e);
      return ctx.answerCbQuery('Error');
    }
  });

  return bot;
}

module.exports = { initBot };
