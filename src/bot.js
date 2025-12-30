// src/bot.js
// Main Telegraf bot implementation for WorldVoiceComment
// - Fixes reply saving (avoid sending duration if DB doesn't have it)
// - Tracks videos per-user (requires db.trackThread + db.listTrackedByUser)
// - Admin post flow (📣 Post) for broadcasting notifications
// - Robust admin approve flow (ensure user row exists before credit)
// - Favorites + My Comments now show video link & thumbnail
// - Replies saved and user notified immediately

const { Telegraf, Markup } = require('telegraf');
const db = require('./database');   // will provide full implementation next
const utils = require('./utils');   // must include: extractFirstUrl, normalizeVideoUrl, encodeShortCode, decodeShortCode
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const WHATSAPP_ADMIN = (process.env.WHATSAPP_ADMIN || '').replace(/\D/g,'');
const WHATSAPP_LINK = WHATSAPP_ADMIN ? `https://wa.me/${WHATSAPP_ADMIN}` : null;

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN env var.');

const PAYMENT_RECIPIENT = {
  telebirr_name: 'WorldVoiceComment',
  telebirr_number: '0962058608',
  cbe_name: 'WorldVoiceComment',
  cbe_number: '1000555367884'
};

const PAYMENT_PACKAGES = [
  { id: 'pkg1', label: '25 comments - 12 ETB', credits: 25, amount: 12 },
  { id: 'pkg2', label: '60 comments - 27 ETB', credits: 60, amount: 27 },
  { id: 'pkg3', label: '130 comments - 49 ETB', credits: 130, amount: 49 },
  { id: 'pkg4', label: '240 comments - 89 ETB', credits: 240, amount: 89 }
];

function MAIN_KB() {
  // Replace Support with Post (📣 Post) as requested
  return Markup.keyboard([
    ['🎥 Add Comment', '➕ Add My Video'],
    ['🔖 Track Video', '🎧 Listen Comments'],
    ['💬 My Comments', '🔎 Search'],
    ['⭐ Favorites', '🔔 Notifications'],
    ['🛒 Buy', '📣 Post'],
    ['💰 Balance']
  ], { columns: 2 }).resize();
}

const Pending = new Map();

function isAdmin(id) { return ADMIN_IDS.includes(Number(id)); }
const debug = (...args) => console.log('[bot]', ...args);

/* ---------- Helpers ---------- */

async function ensureUserRowSafe(userOrId) {
  try {
    if (!userOrId) return null;
    if (typeof userOrId === 'object' && userOrId.id) {
      return await db.ensureUserRow(userOrId).catch(()=>null);
    }
    // numeric id -> ensure exists
    return await db.ensureUserRow({ id: userOrId }).catch(()=>null);
  } catch (e) {
    console.error('ensureUserRowSafe err', e);
    return null;
  }
}

async function sendThreadPreview(ctx, thread) {
  try {
    if (!thread) return;
    if (thread.social_link || thread.canonical_link) {
      const link = thread.social_link || thread.canonical_link;
      try {
        const norm = await utils.normalizeVideoUrl(link).catch(()=>null);
        if (norm && norm.thumbnail) {
          await ctx.replyWithPhoto(norm.thumbnail, { caption: link });
          return;
        }
      } catch (e) { /* ignore */ }
      await ctx.reply(link);
    }
  } catch (e) { /* ignore */ }
}

async function buildCommentInline(commentId, ctxUserId) {
  // Build inline keyboard for main comments (includes Reply/ Favorite / Show replies / Report / Delete)
  const reactionCounts = await db.supabase.from('reactions').select('type', { count: 'exact' }).eq('comment_id', commentId).maybeSingle().catch(()=>null);
  // We'll not rely strictly on reactionCounts.count; just display basic buttons.
  const favState = await (async () => {
    try {
      const r = await db.supabase.from('favorites').select('*').eq('telegram_id', ctxUserId).eq('comment_id', commentId).limit(1).maybeSingle();
      return !!(r && r.data || r);
    } catch (e) { return false; }
  })();
  const favLabel = favState ? '★ Favorited' : '☆ Favorite';
  const repliesCount = await (async () => {
    try {
      const r = await db.supabase.from('replies').select('id', { count: 'exact' }).eq('comment_id', commentId);
      return r && r.count ? Number(r.count) : 0;
    } catch (e) { return 0; }
  })();
  const rows = [
    [ Markup.button.callback('💬 Reply', `replymenu|${commentId}`), Markup.button.callback(favLabel, `fav|${commentId}`) ],
    [ Markup.button.callback(`▶️ Show replies (${repliesCount})`, `list_replies|${commentId}|1`), Markup.button.callback('🚩 Report', `report|${commentId}`) ]
  ];
  // add delete button if owner
  const comment = await db.getCommentById(commentId).catch(()=>null);
  if (comment && Number(comment.telegram_id) === Number(ctxUserId)) rows.push([ Markup.button.callback('🗑 Delete', `delete_my_comment|${commentId}`) ]);
  if (isAdmin(ctxUserId)) rows.push([ Markup.button.callback('🗑 Admin Delete', `admin_delete_comment|${commentId}`) ]);
  return Markup.inlineKeyboard(rows);
}

function buildReplyInline(replyId, ctxUserId, commentId) {
  // Replies only have reaction + report (no nested reply)
  const rows = [
    [ Markup.button.callback('❤️', `rreact|${replyId}|heart`), Markup.button.callback('🚩 Report', `rreport|${replyId}|${commentId}`) ]
  ];
  if (isAdmin(ctxUserId)) rows.push([ Markup.button.callback('🗑 Admin Delete Reply', `admin_delete_reply|${replyId}`) ]);
  return Markup.inlineKeyboard(rows);
}

async function refreshInlineForComment(ctx, commentId) {
  try {
    const inline = await buildCommentInline(commentId, ctx.from.id);
    try { await ctx.editMessageReplyMarkup(inline.reply_markup); } catch (e) { /* ignore */ }
  } catch (e) { /* ignore */ }
}

/* ---------- Bot initialization ---------- */

async function initBot() {
  const bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    try {
      await ensureUserRowSafe(ctx.from);
      const { data } = await db.supabase.from('users').select('free_comments').eq('telegram_id', ctx.from.id).limit(1).maybeSingle().catch(()=>({ data: null }));
      const bal = (data && data.free_comments) ? Number(data.free_comments) : 0;
      await ctx.reply(`Welcome! You have *${bal}* comments available.`, { parse_mode: 'Markdown' });
      await ctx.reply('Use the keyboard below.', MAIN_KB());
    } catch (e) {
      console.error('start err', e);
      await ctx.reply('Welcome. (error reading balance)');
      await ctx.reply('Use the keyboard below.', MAIN_KB());
    }
  });

  // Admin Post command/button
  bot.hears(/📣 post|^\/post$/i, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');
    Pending.set(ctx.from.id, { type: 'await_admin_post' });
    return ctx.reply('Send the post content (text, photo, document, voice). This will be broadcast to users and saved as a notification.');
  });

  bot.command('support', async (ctx) => {
    // If user asks support, show admin contact
    return ctx.reply(WHATSAPP_LINK ? `Contact admin via WhatsApp: ${WHATSAPP_LINK}` : 'Contact admin (WhatsApp not configured).');
  });

  // Notifications command
  bot.command('notifications', async (ctx) => {
    try {
      const rows = await db.listNotifications(ctx.from.id).catch(()=>[]);
      if (!rows || rows.length === 0) return ctx.reply('No notifications.');
      for (const n of rows.slice(0, 10)) {
        await ctx.reply(n.message || '(notification)');
      }
    } catch (e) {
      console.error('notifications err', e);
      return ctx.reply('Could not fetch notifications.');
    }
  });

  // Buy keyboard
  bot.hears(/🛒 buy|^buy$/i, async (ctx) => {
    Pending.delete(ctx.from.id);
    const inline = PAYMENT_PACKAGES.map(p => [ Markup.button.callback(p.label, `select_pkg|${p.id}`) ]);
    inline.push([ Markup.button.callback('Contact admin', 'contact_whatsapp') ]);
    return ctx.reply('Choose a package:', Markup.inlineKeyboard(inline));
  });

  // Main text handler
  bot.on('text', async (ctx) => {
    const txt = (ctx.message && ctx.message.text) || '';
    const uid = ctx.from.id;
    const normalized = txt.trim().toLowerCase();

    // clear pending when main KB used
    const mainLabels = ['🎥 add comment','➕ add my video','🔖 track video','🎧 listen comments','💬 my comments','🔎 search','⭐ favorites','🔔 notifications','🛒 buy','📣 post','💰 balance'];
    if (mainLabels.includes(normalized)) Pending.delete(uid);

    const pending = Pending.get(uid);

    // Handle admin post content (text)
    if (pending && pending.type === 'await_admin_post') {
      Pending.delete(uid);
      try {
        const messageText = txt.trim();
        // Save notification row
        await db.addNotificationRow({ telegram_id: null, message: messageText, meta: { admin_id: uid, type: 'admin_post' } }).catch(()=>null);
        // Broadcast to users up to 200 at a time
        const { data: users } = await db.supabase.from('users').select('telegram_id').limit(500); // safe upper limit; change as needed
        if (users && users.length) {
          for (const u of users) {
            try { await bot.telegram.sendMessage(u.telegram_id, `📣 Admin post:\n\n${messageText}`); } catch (e) {}
          }
        }
        return ctx.reply('Post published and notifications sent.');
      } catch (e) {
        console.error('admin post text err', e);
        return ctx.reply('Could not publish post.');
      }
    }

    // Report reason for comment
    if (pending && pending.type === 'await_report_reason' && pending.commentId) {
      Pending.delete(uid);
      const reason = txt.trim();
      try {
        await db.insertReport({ reporter_telegram_id: uid, comment_id: pending.commentId, reason });
        const comment = await db.getCommentById(pending.commentId).catch(()=>null);
        const thread = comment ? await db.getThreadById(comment.thread_id).catch(()=>null) : null;
        const adminMsg = `🚨 Report: ${utils.encodeShortCode(pending.commentId)}\nReporter: ${ctx.from.username || ctx.from.first_name} (${uid})\nReason: ${reason}\nVideo: ${thread ? (thread.social_link || thread.canonical_link) : '(unknown)'}`;
        for (const adm of ADMIN_IDS) {
          try {
            if (comment && comment.telegram_file_id) await bot.telegram.sendVoice(adm, comment.telegram_file_id, { caption: adminMsg });
            else await bot.telegram.sendMessage(adm, adminMsg);
          } catch (e) {}
        }
        return ctx.reply('Report submitted. Admins have been notified.');
      } catch (e) {
        console.error('insertReport err', e);
        // fallback: notify admins
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendMessage(adm, `🚨 Report (DB failed): Reporter: ${ctx.from.id}\nComment: ${pending.commentId}\nReason: ${reason}`); } catch(e) {}
        }
        return ctx.reply('Report submitted. Admins have been notified (DB save failed).');
      }
    }

    // Report reason for reply
    if (pending && pending.type === 'await_report_reason_reply' && pending.replyId) {
      Pending.delete(uid);
      const reason = txt.trim();
      try {
        await db.insertReport({ reporter_telegram_id: uid, reply_id: pending.replyId, reason });
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendMessage(adm, `🚨 Reply Report: reply #${pending.replyId}\nReporter: ${ctx.from.username || ctx.from.first_name} (${uid})\nReason: ${reason}`); } catch(e) {}
        }
        return ctx.reply('Report submitted. Admins have been notified.');
      } catch (e) {
        console.error('insertReport reply err', e);
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendMessage(adm, `🚨 Reply Report (DB failed): reply #${pending.replyId}\nReporter: ${ctx.from.username || ctx.from.first_name} (${uid})\nReason: ${reason}`); } catch(e) {}
        }
        return ctx.reply('Report submitted. Admins have been notified (DB save failed).');
      }
    }

    // Upload proof text (if pending)
    if (pending && pending.type === 'await_upload_proof' && pending.paymentId) {
      Pending.delete(uid);
      try {
        await db.updatePaymentStatus(pending.paymentId, 'proof_submitted', { proof_link: txt.trim() });
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('✅ Approve', `admin_approve|${pending.paymentId}`), Markup.button.callback('❌ Reject', `admin_reject|${pending.paymentId}`) ]
        ]);
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendMessage(adm, `Payment proof for #${pending.paymentId} by ${uid}`, inline); } catch(e) {}
        }
        return ctx.reply('Proof received. Admins will review.');
      } catch (e) {
        console.error('upload proof text err', e);
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendMessage(adm, `Payment proof (text) for #${pending.paymentId} by ${uid}: ${txt}`); } catch(e) {}
        }
        return ctx.reply('Proof sent to admin (DB save failed).');
      }
    }

    // Search short code pending
    if (pending && pending.type === 'await_search_code') {
      Pending.delete(uid);
      const code = txt.trim();
      const id = utils.decodeShortCode(code);
      if (!id) return ctx.reply('Invalid code.');
      try {
        const comment = await db.getCommentById(id);
        if (!comment) return ctx.reply('Comment not found.');
        // show thumbnail & video link if available
        const thread = comment.thread_id ? await db.getThreadById(comment.thread_id).catch(()=>null) : null;
        if (thread && (thread.social_link || thread.canonical_link)) {
          const link = thread.social_link || thread.canonical_link;
          const norm = await utils.normalizeVideoUrl(link).catch(()=>null);
          if (norm && norm.thumbnail) await ctx.replyWithPhoto(norm.thumbnail, { caption: link });
          else await ctx.reply(link);
        }
        if (comment.telegram_file_id) await ctx.replyWithVoice(comment.telegram_file_id);
        await ctx.reply(utils.encodeShortCode(comment.id), await buildCommentInline(comment.id, uid));
        return;
      } catch (e) {
        console.error('search code err', e);
        return ctx.reply('Error searching code.');
      }
    }

    // If text contains URL, show thread actions
    const maybeUrl = utils.extractFirstUrl(txt);
    if (maybeUrl) {
      // Try to normalize; if normalization fails, fallback to raw link
      let thread;
      try {
        // find or create thread (db.findOrCreateThread must exist)
        thread = await db.findOrCreateThread(maybeUrl, null).catch(()=>null);
      } catch (e) {
        console.error('findOrCreateThread err', e);
      }
      if (!thread) {
        // Fallback: create a minimal thread object so UI still works
        thread = { id: null, social_link: maybeUrl, canonical_link: maybeUrl };
      }
      try {
        await sendThreadPreview(ctx, thread);
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('🎙 Add Voice Comment', `addvoice|${thread.id || ''}`), Markup.button.callback('🎧 Listen Comments', `listen|${thread.id || ''}|1`) ],
          [ Markup.button.callback('🔖 Track Video', `track|${thread.id || ''}`) ]
        ]);
        return ctx.reply('What would you like to do?', inline);
      } catch (e) {
        console.error('thread action err', e);
        return ctx.reply('Could not process the link.'); // user-reported message
      }
    }

    // Handle main keyboard texts
    if (/^\s*🎥 add comment\s*$|^add comment$/i.test(txt)) {
      Pending.set(uid, { type: 'await_link_for_add' });
      return ctx.reply('Send the TikTok/YouTube link to add a voice comment for.');
    }
    if (/^\s*➕ add my video\s*$|^add my video$/i.test(txt)) {
      Pending.set(uid, { type: 'await_link_for_track' });
      return ctx.reply('Send your video link to track (it will be added to your tracked videos).');
    }
    if (/^\s*🔖 track video\s*$|^track video$/i.test(txt)) {
      // List tracked videos for this user (db.listTrackedByUser required)
      try {
        const tracked = await db.listTrackedByUser(ctx.from.id).catch(()=>[]);
        if (!tracked || tracked.length === 0) return ctx.reply('You have not tracked any videos yet.');
        for (const t of tracked) {
          const inline = Markup.inlineKeyboard([[ Markup.button.callback('🎧 Listen Comments', `listen|${t.thread_id}|1`), Markup.button.callback('🗑 Delete tracked', `untrack|${t.thread_id}`) ]]);
          await sendThreadPreview(ctx, t);
          await ctx.reply('Tracked video:', inline);
        }
        return;
      } catch (e) {
        console.error('track list err', e);
        return ctx.reply('Could not list tracked videos.');
      }
    }
    if (/^\s*🎧 listen comments\s*$|^listen comments$/i.test(txt)) {
      Pending.set(uid, { type: 'await_link_for_listen' });
      return ctx.reply('Send the video link to listen comments or click one of your tracked videos.');
    }
    if (/^\s*💬 my comments\s*$|^my comments$/i.test(txt)) {
      try {
        const rows = await db.listCommentsByUser(uid).catch(()=>[]);
        if (!rows || rows.length === 0) return ctx.reply('You have no comments yet.');
        for (const c of rows) {
          // show thread context
          const thread = c.thread_id ? await db.getThreadById(c.thread_id).catch(()=>null) : null;
          if (thread && (thread.social_link || thread.canonical_link)) {
            const norm = await utils.normalizeVideoUrl(thread.social_link || thread.canonical_link).catch(()=>null);
            if (norm && norm.thumbnail) await ctx.replyWithPhoto(norm.thumbnail, { caption: thread.social_link || thread.canonical_link });
            else await ctx.reply(thread.social_link || thread.canonical_link);
          }
          if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id);
          await ctx.reply(utils.encodeShortCode(c.id), await buildCommentInline(c.id, uid));
        }
        return;
      } catch (e) {
        console.error('my comments err', e);
        return ctx.reply('Could not fetch your comments.');
      }
    }
    if (/^\s*⭐ favorites\s*$|^favorites$/i.test(txt)) {
      try {
        const favs = await db.listFavoritesForUser(uid).catch(()=>[]);
        if (!favs || favs.length === 0) return ctx.reply('No favorites.');
        for (const f of favs) {
          const thread = f.thread_id ? await db.getThreadById(f.thread_id).catch(()=>null) : null;
          if (thread && (thread.social_link || thread.canonical_link)) {
            const norm = await utils.normalizeVideoUrl(thread.social_link || thread.canonical_link).catch(()=>null);
            if (norm && norm.thumbnail) await ctx.replyWithPhoto(norm.thumbnail, { caption: thread.social_link || thread.canonical_link });
            else await ctx.reply(thread.social_link || thread.canonical_link);
          }
          if (f.telegram_file_id) await ctx.replyWithVoice(f.telegram_file_id);
          await ctx.reply(utils.encodeShortCode(f.id), await buildCommentInline(f.id, uid));
        }
        return;
      } catch (e) {
        console.error('favorites err', e);
        return ctx.reply('Could not fetch favorites.');
      }
    }
    if (/^\s*🔎 search\s*$|^search$/i.test(txt)) {
      Pending.set(uid, { type: 'await_search_code' });
      return ctx.reply('Send the short code (e.g. 0000A9).');
    }
    if (/^\s*💰 balance\s*$|^balance$/i.test(txt)) {
      try {
        const { data } = await db.supabase.from('users').select('free_comments').eq('telegram_id', uid).limit(1).maybeSingle().catch(()=>({ data: null }));
        const bal = (data && data.free_comments) ? Number(data.free_comments) : 0;
        return ctx.reply(`Your balance: *${bal}*`, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('balance err', e);
        return ctx.reply('Could not fetch balance.');
      }
    }

    // awaiting add comment link
    if (pending && pending.type === 'await_link_for_add') {
      Pending.delete(uid);
      const link = utils.extractFirstUrl(txt) || txt;
      if (!link) return ctx.reply('No link detected.');
      try {
        const thread = await db.findOrCreateThread(link, null).catch(async (err) => {
          console.error('findOrCreateThread fallback err', err);
          // fallback create basic thread via DB insert (if findOrCreateThread fails)
          return await db.findOrCreateThread(link, null).catch(()=>({ id: null, social_link: link, canonical_link: link }));
        });
        Pending.set(uid, { type: 'await_add_comment_voice', threadId: thread.id });
        return ctx.reply('Now send the voice. (Voice comments cost 1 credit)');
      } catch (e) {
        console.error('await_link_for_add err', e);
        return ctx.reply('Could not prepare add comment.');
      }
    }

    // awaiting track link: user wants to track the video (allow unlimited tracking)
    if (pending && pending.type === 'await_link_for_track') {
      Pending.delete(uid);
      const link = utils.extractFirstUrl(txt) || txt;
      if (!link) return ctx.reply('No link detected.');
      try {
        const thread = await db.findOrCreateThread(link, null).catch(()=>null);
        if (!thread) {
          // create fallback thread using DB
          // (db.findOrCreateThread should create it; if not, we create a minimal stub)
          const insertedThread = await db.supabase.from('threads').insert([{ social_link: link, canonical_link: link, created_at: new Date().toISOString() }]).select().maybeSingle().catch(()=>null);
          if (insertedThread && insertedThread.data) thread = insertedThread.data;
        }
        // track for this user: db.trackThread(userId, threadId)
        try {
          await db.trackThread(ctx.from.id, thread.id);
        } catch (e) {
          console.error('db.trackThread err', e);
        }
        return ctx.reply('Video tracked. You will be notified on replies.');
      } catch (e) {
        console.error('track err', e);
        return ctx.reply('Could not track video.');
      }
    }

    // awaiting listen link
    if (pending && pending.type === 'await_link_for_listen') {
      Pending.delete(uid);
      const link = utils.extractFirstUrl(txt) || txt;
      if (!link) return ctx.reply('No link detected.');
      try {
        const thread = await db.findOrCreateThread(link, null).catch(()=>null);
        if (!thread || !thread.id) return ctx.reply('No comments found for this video.');
        return sendCommentsPage(ctx, thread.id, 1);
      } catch (e) {
        console.error('listen err', e);
        return ctx.reply('Could not list comments for that video.');
      }
    }

    return ctx.reply('I did not understand. Press a button or send a video link.', MAIN_KB());
  });

  /* ---------- Photo handler ---------- */
  bot.on('photo', async (ctx) => {
    const uid = ctx.from.id;
    const pending = Pending.get(uid);
    const photos = ctx.message.photo || [];
    const best = photos[photos.length - 1];
    if (!best) return ctx.reply('No photo found.');

    // Admin post photo
    if (pending && pending.type === 'await_admin_post' && isAdmin(uid)) {
      Pending.delete(uid);
      try {
        await db.addNotificationRow({ telegram_id: null, message: '(photo post)', meta: { admin_id: uid, type: 'photo', telegram_file_id: best.file_id } }).catch(()=>null);
        // Broadcast: naive send to users (be careful with huge user base)
        const { data: users } = await db.supabase.from('users').select('telegram_id').limit(500).catch(()=>({ data: [] }));
        if (users && users.length) {
          for (const u of users) {
            try { await bot.telegram.sendPhoto(u.telegram_id, best.file_id, { caption: '📣 Admin post' }); } catch (e) {}
          }
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
        await db.updatePaymentStatus(pending.paymentId, 'proof_submitted', { proof_telegram_file_id: best.file_id });
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('✅ Approve', `admin_approve|${pending.paymentId}`), Markup.button.callback('❌ Reject', `admin_reject|${pending.paymentId}`) ]
        ]);
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendPhoto(adm, best.file_id, { caption: `Payment proof for #${pending.paymentId} by ${uid}`, reply_markup: inline.reply_markup }); } catch (e) {}
        }
        return ctx.reply('Proof received. Admins will review.');
      } catch (e) {
        console.error('upload proof photo err', e);
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendPhoto(adm, best.file_id, { caption: `Payment proof (db failed) for #${pending.paymentId} by ${uid}` }); } catch (e) {}
        }
        return ctx.reply('Proof sent to admins (DB save failed).');
      }
    }

    // Reply photo saving (free)
    if (pending && pending.type === 'await_reply_photo' && pending.commentId) {
      Pending.delete(uid);
      try {
        // build row without duration (the replies table may not have 'duration')
        const row = {
          comment_id: pending.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          telegram_file_id: best.file_id,
          reply_text: null
        };
        const inserted = await db.insertReplyRow(row);
        // Notify comment owner immediately
        const comment = await db.getCommentById(pending.commentId).catch(()=>null);
        if (comment && comment.telegram_id && Number(comment.telegram_id) !== Number(uid)) {
          await db.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply (photo) to your comment ${utils.encodeShortCode(comment.id)}`, meta: { comment_id: comment.id } }).catch(()=>null);
          try { await bot.telegram.sendMessage(comment.telegram_id, `New reply to your comment ${utils.encodeShortCode(comment.id)}`); } catch (e) {}
        }
        await ctx.replyWithPhoto(best.file_id);
        await ctx.reply(utils.encodeShortCode(inserted.id), buildReplyInline(inserted.id, uid, pending.commentId));
        return;
      } catch (e) {
        console.error('reply_photo err', e);
        return ctx.reply('Could not save reply photo.');
      }
    }

    return ctx.reply('No expected photo action.');
  });

  /* ---------- Voice handler ---------- */
  bot.on('voice', async (ctx) => {
    const uid = ctx.from.id;
    const pending = Pending.get(uid);
    if (!pending) return ctx.reply('No expected action for voice now.');
    const voice = ctx.message.voice;
    if (!voice) return ctx.reply('No voice found.');

    // Admin post voice
    if (pending && pending.type === 'await_admin_post' && isAdmin(uid)) {
      Pending.delete(uid);
      try {
        // Save notification
        await db.addNotificationRow({ telegram_id: null, message: '(voice post)', meta: { admin_id: uid, type: 'voice', telegram_file_id: voice.file_id } }).catch(()=>null);
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

    // Add comment voice
    if (pending && pending.type === 'await_add_comment_voice' && pending.threadId) {
      // check balance
      const balRow = await db.supabase.from('users').select('free_comments').eq('telegram_id', uid).limit(1).maybeSingle().catch(()=>({ data: null }));
      const bal = (balRow && balRow.data && balRow.data.free_comments) ? Number(balRow.data.free_comments) : 0;
      if (bal <= 0) return ctx.reply('Pay before comment. Your balance is 0.');
      Pending.delete(uid);
      try {
        // build row, avoid sending duration property if DB doesn't have it
        const row = {
          thread_id: pending.threadId,
          telegram_id: uid,
          username: ctx.from.username || null,
          first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id
        };
        // insert
        const inserted = await db.insertVoiceComment(row);
        // debit 1 credit (ensure user row exists)
        await ensureUserRowSafe(uid);
        await db.supabase.from('users').update({ free_comments: Math.max(0, (bal - 1)) }).eq('telegram_id', uid).catch(()=>null);
        // send voice + code
        await ctx.replyWithVoice(voice.file_id);
        await ctx.reply(utils.encodeShortCode(inserted.id), await buildCommentInline(inserted.id, uid));
        // notify thread trackers (tracked users)
        try {
          const trackers = await db.listTrackersForThread(pending.threadId).catch(()=>[]);
          if (trackers && trackers.length) {
            for (const t of trackers) {
              if (Number(t.tracker_telegram_id) !== Number(uid)) {
                await db.addNotificationRow({ telegram_id: t.tracker_telegram_id, message: `New comment on tracked video: ${utils.encodeShortCode(inserted.id)}`, meta: { comment_id: inserted.id } }).catch(()=>null);
                try { await bot.telegram.sendMessage(t.tracker_telegram_id, `New comment on a video you track: ${utils.encodeShortCode(inserted.id)}`); } catch (e) {}
              }
            }
          }
        } catch (e) { /* ignore */ }
        return;
      } catch (e) {
        console.error('insertVoiceComment err', e);
        return ctx.reply('Could not save voice comment.');
      }
    }

    // Reply voice
    if (pending && pending.type === 'await_reply_voice' && pending.commentId) {
      // check balance
      const balRow = await db.supabase.from('users').select('free_comments').eq('telegram_id', uid).limit(1).maybeSingle().catch(()=>({ data: null }));
      const bal = (balRow && balRow.data && balRow.data.free_comments) ? Number(balRow.data.free_comments) : 0;
      if (bal <= 0) return ctx.reply('Pay before comment. Your balance is 0.');
      Pending.delete(uid);
      try {
        const row = {
          comment_id: pending.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id
        };
        const inserted = await db.insertReplyRow(row); // db must handle insert properly
        // debit user 1
        await ensureUserRowSafe(uid);
        await db.supabase.from('users').update({ free_comments: Math.max(0, (bal - 1)) }).eq('telegram_id', uid).catch(()=>null);
        // notify original comment owner directly & via notification row
        const comment = await db.getCommentById(pending.commentId).catch(()=>null);
        if (comment && comment.telegram_id && Number(comment.telegram_id) !== Number(uid)) {
          await db.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply to your comment ${utils.encodeShortCode(comment.id)}`, meta: { comment_id: comment.id } }).catch(()=>null);
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

    // report reply voice (if used)
    if (pending && pending.type === 'report_reply_voice' && pending.replyId) {
      Pending.delete(uid);
      try {
        await db.insertReport({ reporter_telegram_id: uid, reply_id: pending.replyId, report_telegram_file_id: voice.file_id });
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendVoice(adm, voice.file_id, { caption: `Reply report: reply #${pending.replyId} by ${ctx.from.username || ctx.from.first_name}` }); } catch(e) {}
        }
        return ctx.reply('Voice report submitted. Admins will review.');
      } catch (e) {
        console.error('report reply voice err', e);
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendVoice(adm, voice.file_id, { caption: `Reply report (DB failed): reply #${pending.replyId} by ${ctx.from.username || ctx.from.first_name}` }); } catch(e) {}
        }
        return ctx.reply('Voice report submitted (admins notified).');
      }
    }

    return ctx.reply('No expected action for voice now.');
  });

  /* ---------- Callback queries ---------- */
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery && ctx.callbackQuery.data;
    if (!data) return ctx.answerCbQuery();
    const parts = data.split('|');
    const cmd = parts[0];
    const a1 = parts[1];
    const a2 = parts[2];

    // cancel any pending action when callback used
    Pending.delete(ctx.from.id);

    try {
      // contact whatsapp
      if (cmd === 'contact_whatsapp') { await ctx.answerCbQuery(); return ctx.reply(WHATSAPP_LINK || 'WhatsApp not configured.'); }

      // package selection & confirm
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
          const created = await db.createPaymentRequest({ telegram_id: ctx.from.id, package_name: pkg.label, comments_amount: pkg.credits, amount: pkg.amount, status: 'pending' });
          const paymentText = `${PAYMENT_RECIPIENT.telebirr_name}\nTELEBIRR: ${PAYMENT_RECIPIENT.telebirr_number}\n${PAYMENT_RECIPIENT.cbe_name}\nCBE: ${PAYMENT_RECIPIENT.cbe_number}\nAmount: ${pkg.amount} ETB\n\nCopy the number below to your banking app and pay. After payment press Upload Proof.`;
          const inline = Markup.inlineKeyboard([
            [ Markup.button.callback('Copy TELEBIRR', `copy_number|${PAYMENT_RECIPIENT.telebirr_number}`), Markup.button.callback('Copy CBE', `copy_number|${PAYMENT_RECIPIENT.cbe_number}`) ],
            [ Markup.button.callback('Upload Proof', `upload_proof|${created.id}`) ],
            [ Markup.button.url('Contact admin', WHATSAPP_LINK || 'https://t.me/' + (ADMIN_IDS[0] || '')) ]
          ]);
          await ctx.reply(paymentText);
          await ctx.reply('Payment options:', inline);
          for (const adm of ADMIN_IDS) {
            try { await bot.telegram.sendMessage(adm, `New payment request #${created.id} by ${ctx.from.id} — ${pkg.label}`); } catch(e) {}
          }
        } catch (e) {
          console.error('confirm_pkg err', e);
          return ctx.reply('Could not create payment request. Contact support.');
        }
        return ctx.answerCbQuery();
      }

      if (cmd === 'copy_number') {
        await ctx.answerCbQuery('Number sent');
        return ctx.reply(a1);
      }

      if (cmd === 'upload_proof') {
        const pid = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_upload_proof', paymentId: pid });
        await ctx.answerCbQuery();
        return ctx.reply(`Send the proof image or paste the link for payment #${pid}.`);
      }

      // add voice for thread
      if (cmd === 'addvoice') {
        const threadId = a1 ? Number(a1) : null;
        if (!threadId) {
          await ctx.answerCbQuery('No thread id.');
          return ctx.reply('Sorry, could not find thread id for this video.');
        }
        Pending.set(ctx.from.id, { type: 'await_add_comment_voice', threadId });
        await ctx.answerCbQuery('Send voice to add as comment');
        return ctx.reply('Send voice now. (Voice costs 1 credit)');
      }

      // listen comments pagination
      if (cmd === 'listen') {
        const threadId = a1 ? Number(a1) : null;
        const page = Number(a2 || 1);
        if (!threadId) return ctx.answerCbQuery('No thread.');
        await sendCommentsPage(ctx, threadId, page);
        return ctx.answerCbQuery();
      }

      // track a thread (via button)
      if (cmd === 'track') {
        const threadId = a1 ? Number(a1) : null;
        if (!threadId) return ctx.answerCbQuery('No thread.');
        try {
          await db.trackThread(ctx.from.id, threadId);
          await ctx.answerCbQuery('Tracked');
          return ctx.reply('Video tracked. You will be notified on replies.');
        } catch (e) {
          console.error('track callback err', e);
          await ctx.answerCbQuery('Error');
          return ctx.reply('Could not track the video.');
        }
      }

      // reply menu for comments
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

      // report comment -> ask reason
      if (cmd === 'report') {
        Pending.set(ctx.from.id, { type: 'await_report_reason', commentId: Number(a1) });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain why you are reporting this comment (short text).');
      }

      // report reply -> ask reason
      if (cmd === 'rreport') {
        Pending.set(ctx.from.id, { type: 'await_report_reason_reply', replyId: Number(a1) });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain why you are reporting this reply (short text).');
      }

      // reactions (comment)
      if (cmd === 'react') {
        const commentId = Number(a1);
        const type = a2;
        try {
          const { data: existing } = await db.supabase.from('reactions').select('*').eq('comment_id', commentId).eq('telegram_id', ctx.from.id).limit(1).maybeSingle().catch(()=>({ data: null }));
          const exists = existing && existing.data ? existing.data : existing;
          if (exists) {
            if (exists.type === type) await db.supabase.from('reactions').delete().eq('id', exists.id).catch(()=>null);
            else await db.supabase.from('reactions').update({ type }).eq('id', exists.id).catch(()=>null);
          } else {
            await db.insertReactionRow({ comment_id: commentId, telegram_id: ctx.from.id, type }).catch(()=>null);
          }
          await ctx.answerCbQuery('Saved');
          await refreshInlineForComment(ctx, commentId);
        } catch (e) {
          console.error('react err', e);
          await ctx.answerCbQuery('Error');
        }
        return;
      }

      // reactions (reply)
      if (cmd === 'rreact') {
        const replyId = Number(a1);
        const type = a2;
        try {
          const { data: existing } = await db.supabase.from('reactions').select('*').eq('reply_id', replyId).eq('telegram_id', ctx.from.id).limit(1).maybeSingle().catch(()=>({ data: null }));
          const exists = existing && existing.data ? existing.data : existing;
          if (exists) {
            if (exists.type === type) await db.supabase.from('reactions').delete().eq('id', exists.id).catch(()=>null);
            else await db.supabase.from('reactions').update({ type }).eq('id', exists.id).catch(()=>null);
          } else {
            await db.insertReactionRow({ reply_id: replyId, telegram_id: ctx.from.id, type }).catch(()=>null);
          }
          await ctx.answerCbQuery('Saved');
        } catch (e) {
          console.error('rreact err', e);
          await ctx.answerCbQuery('Error');
        }
        return;
      }

      // favorite toggle
      if (cmd === 'fav') {
        const commentId = Number(a1);
        try {
          const res = await db.toggleFavoriteRow(ctx.from.id, commentId);
          await ctx.answerCbQuery(res.removed ? 'Favorite removed' : 'Favorite added');
          // refresh inline to update label
          await refreshInlineForComment(ctx, commentId);
        } catch (e) {
          console.error('fav err', e);
          await ctx.answerCbQuery('Error');
        }
        return;
      }

      // list replies for a comment (paginated)
      if (cmd === 'list_replies') {
        const commentId = Number(a1);
        const page = Number(a2 || 1);
        try {
          const perPage = 5;
          const offset = (page - 1) * perPage;
          const { data: replies } = await db.supabase.from('replies').select('*').eq('comment_id', commentId).order('created_at', { ascending: true }).range(offset, offset + perPage - 1);
          if (!replies || replies.length === 0) { await ctx.reply('No replies yet.'); await ctx.answerCbQuery(); return; }
          for (const r of replies) {
            if (r.telegram_file_id) await ctx.replyWithVoice(r.telegram_file_id, { caption: r.replier_first_name || r.replier_username || 'User' });
            else await ctx.reply(`${r.replier_first_name || r.replier_username || 'User'}: ${r.reply_text || '(no text)'}`);
            await ctx.reply(utils.encodeShortCode(r.id), buildReplyInline(r.id, ctx.from.id, commentId));
          }
          const countRes = await db.supabase.from('replies').select('id', { count: 'exact' }).eq('comment_id', commentId);
          const total = (countRes && countRes.count) ? Number(countRes.count) : 0;
          if (offset + perPage < total) {
            await ctx.reply('More replies:', Markup.inlineKeyboard([ [ Markup.button.callback('More', `list_replies|${commentId}|${page+1}`) ] ]));
          }
          return ctx.answerCbQuery();
        } catch (e) {
          console.error('list_replies err', e);
          await ctx.answerCbQuery('Error');
        }
        return;
      }

      // delete my comment
      if (cmd === 'delete_my_comment') {
        const commentId = Number(a1);
        try {
          const comment = await db.getCommentById(commentId).catch(()=>null);
          if (!comment) { await ctx.answerCbQuery('Not found'); return; }
          if (Number(comment.telegram_id) !== Number(ctx.from.id) && !isAdmin(ctx.from.id)) { await ctx.answerCbQuery('Not authorized'); return; }
          await db.deleteCommentById(commentId).catch(()=>null);
          await ctx.answerCbQuery('Deleted');
          return ctx.reply(`Comment ${utils.encodeShortCode(commentId)} deleted.`);
        } catch (e) { console.error('delete_my_comment err', e); await ctx.answerCbQuery('Error deleting.'); }
        return;
      }

      // admin delete comment
      if (cmd === 'admin_delete_comment') {
        const commentId = Number(a1);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          await db.deleteCommentById(commentId).catch(()=>null);
          await ctx.answerCbQuery('Deleted');
          return ctx.reply(`Comment ${utils.encodeShortCode(commentId)} deleted by admin.`);
        } catch (e) { console.error('admin_delete_comment err', e); await ctx.answerCbQuery('Error deleting.'); }
        return;
      }

      // admin delete reply
      if (cmd === 'admin_delete_reply') {
        const replyId = Number(a1);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          await db.supabase.from('replies').delete().eq('id', replyId).catch(()=>null);
          await ctx.answerCbQuery('Deleted');
          return ctx.reply(`Reply ${utils.encodeShortCode(replyId)} deleted by admin.`);
        } catch (e) { console.error('admin_delete_reply err', e); await ctx.answerCbQuery('Error deleting.'); }
        return;
      }

      // untrack (delete tracked entry)
      if (cmd === 'untrack') {
        const threadId = Number(a1);
        try {
          await db.untrackThread(ctx.from.id, threadId).catch(()=>null);
          await ctx.answerCbQuery('Untracked');
          return ctx.reply('Stopped tracking this video.');
        } catch (e) {
          console.error('untrack err', e);
          await ctx.answerCbQuery('Error');
        }
        return;
      }

      // cancel
      if (cmd === 'cancel_action') {
        Pending.delete(ctx.from.id);
        await ctx.answerCbQuery();
        return ctx.reply('Action cancelled.', MAIN_KB());
      }

      // admin approve payment
      if (cmd === 'admin_approve') {
        const pid = Number(a1);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          const payment = await db.getPaymentById(pid);
          if (!payment) { await ctx.answerCbQuery('Payment not found'); return; }
          // ensure user exists
          await ensureUserRowSafe(payment.telegram_id);
          // credit user: fetch current and update (safe)
          const { data } = await db.supabase.from('users').select('free_comments').eq('telegram_id', payment.telegram_id).limit(1).maybeSingle().catch(()=>({ data: null }));
          const current = (data && data.free_comments) ? Number(data.free_comments) : 0;
          const next = current + Number(payment.comments_amount || 0);
          await db.supabase.from('users').upsert({ telegram_id: payment.telegram_id, free_comments: next }).catch(()=>null);
          await db.updatePaymentStatus(pid, 'approved', { approved_by: ctx.from.id, approved_at: new Date().toISOString() }).catch(()=>null);
          await ctx.answerCbQuery('Approved');
          try { await bot.telegram.sendMessage(payment.telegram_id, `Your payment was approved by admin. You received ${payment.comments_amount} comments.`); } catch (e) {}
          return ctx.reply(`Payment #${pid} approved and ${payment.comments_amount} credits added to user ${payment.telegram_id}.`);
        } catch (e) {
          console.error('admin_approve err', e);
          await ctx.answerCbQuery('Error Approving');
          return ctx.reply('Error approving payment.');
        }
      }

      if (cmd === 'admin_reject') {
        const pid = Number(a1);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          await db.updatePaymentStatus(pid, 'rejected', { rejected_by: ctx.from.id, rejected_at: new Date().toISOString() }).catch(()=>null);
          await ctx.answerCbQuery('Rejected');
          return ctx.reply(`Payment #${pid} rejected by admin.`);
        } catch (e) {
          console.error('admin_reject err', e);
          await ctx.answerCbQuery('Error rejecting');
        }
        return;
      }

      return ctx.answerCbQuery();
    } catch (err) {
      console.error('callback_query processing err', err);
      try { await ctx.answerCbQuery('Error'); } catch (_) {}
    }
  });

  /* ---------- Text follow-up handler for reply_text ---------- */
  bot.on('text', async (ctx) => {
    const uid = ctx.from.id;
    const pending = Pending.get(uid);
    if (!pending) return;
    if (pending.type === 'reply_text' && pending.commentId) {
      Pending.delete(uid);
      try {
        const row = {
          comment_id: pending.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          reply_text: ctx.message.text
        };
        const inserted = await db.insertReplyRow(row);
        // notify owner
        const comment = await db.getCommentById(pending.commentId).catch(()=>null);
        if (comment && comment.telegram_id && Number(comment.telegram_id) !== Number(uid)) {
          await db.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply to your comment ${utils.encodeShortCode(comment.id)}`, meta: { comment_id: comment.id } }).catch(()=>null);
          try { await bot.telegram.sendMessage(comment.telegram_id, `New reply to your comment ${utils.encodeShortCode(comment.id)}`); } catch (e) {}
        }
        return ctx.reply('Reply saved.');
      } catch (e) {
        console.error('reply_text insert err', e);
        return ctx.reply('Could not save reply.');
      }
    }
  });

  return bot;
}

module.exports = { initBot };
