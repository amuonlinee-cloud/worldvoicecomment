// src/bot.js
// Full bot implementation for World Voice Comment
// - Uses a database wrapper (./database) that supports Supabase or an in-memory fallback
// - Enforces balance when adding comments
// - Reaction toggles (one reaction per user per comment)
// - Report system stored in DB and admin /reports /report commands
// - Tracks videos when user selects "➕ Add My Video"
// - Early-cancel pending flows when user switches actions or types /cancel

const { Telegraf, Markup } = require('telegraf');
const debugLog = (...args) => console.log('[bot]', ...args);

// Defensive requires
let safeDb;
try {
  safeDb = require('./database');
  if (!safeDb) {
    console.warn('[bot] ./database returned falsy, using minimal shim');
    safeDb = {};
  }
} catch (e) {
  console.warn('[bot] could not require ./database, using minimal shim', e && e.message);
  safeDb = {};
}

let utils;
try {
  utils = require('./utils');
  if (!utils) {
    console.warn('[bot] ./utils returned falsy, using fallbacks');
    utils = {};
  }
} catch (e) {
  console.warn('[bot] could not require ./utils, using fallbacks', e && e.message);
  utils = {};
}

// small utils fallbacks (only when missing in provided utils.js)
utils.normalizeInput = utils.normalizeInput || function (s) { return (s || '').toString().trim(); };
utils.extractFirstUrl = utils.extractFirstUrl || function (s) {
  if (!s) return null;
  const m = String(s).match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
};
utils.encodeShortCode = utils.encodeShortCode || function (id) {
  if (id === undefined || id === null) return '';
  const v = Number(id) || 0;
  return v.toString(36).toUpperCase().padStart(6, '0');
};
utils.decodeShortCode = utils.decodeShortCode || function (code) {
  if (!code) return null;
  try { return parseInt(String(code).toLowerCase(), 36); } catch (e) { return null; }
};
utils.normalizeVideoUrl = utils.normalizeVideoUrl || (async (url) => ({ canonicalLink: url }));
utils.isSupportedLink = utils.isSupportedLink || (s => !!s && /tiktok\.com|youtube\.com|youtu\.be|vm\.tiktok\.com/i.test(s));

// ---------- Config ----------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const WHATSAPP_ADMIN = (process.env.WHATSAPP_ADMIN || '251962058608').replace(/\D/g, '');
const WHATSAPP_LINK = `https://wa.me/${WHATSAPP_ADMIN}`;

const PAYMENT_PACKAGES = [
  { key: 'pkg_25_12', label: '25 comments - 12 ETB', credits: 25, amount: 12 },
  { key: 'pkg_60_27', label: '60 comments - 27 ETB', credits: 60, amount: 27 },
  { key: 'pkg_130_49', label: '130 comments - 49 ETB', credits: 130, amount: 49 },
  { key: 'pkg_240_89', label: '240 comments - 89 ETB', credits: 240, amount: 89 }
];

function isAdmin(telegramId) {
  if (!telegramId) return false;
  return ADMIN_IDS.map(Number).includes(Number(telegramId));
}

function mainKeyboard() {
  return Markup.keyboard([
    ['🎥 Add Comment', '➕ Add My Video'],
    ['🔖 Track Video', '🎧 Listen Comments'],
    ['💬 My Comments', '🔎 Search'],
    ['⭐ Favorites', '🔔 Notifications'],
    ['🛒 Buy', '🆘 Support'],
    ['💰 Balance']
  ], { columns: 2 }).resize();
}
function normalizeKbLabel(s) { return (s||'').toString().trim().toLowerCase(); }

const PendingMap = new Map();

// ---------- DB wrappers ----------
async function ensureUserRow(user) {
  try { if (safeDb && safeDb.ensureUserRow) return await safeDb.ensureUserRow(user); } catch (e) { console.error('ensureUserRow err', e); }
  return null;
}
async function getUserBalance(telegramId) {
  try { if (safeDb && safeDb.getUserBalance) return await safeDb.getUserBalance(telegramId); } catch (e) { console.error('getUserBalance err', e); }
  return 0;
}
async function creditUser(telegramId, amount) {
  try { if (safeDb && safeDb.creditUser) return await safeDb.creditUser(telegramId, amount); } catch (e) { console.error('creditUser err', e); throw e; }
}
async function decrementUserBalance(telegramId, amount) {
  try { if (safeDb && safeDb.decrementUserBalance) return await safeDb.decrementUserBalance(telegramId, amount); } catch (e) { console.error('decrementUserBalance err', e); throw e; }
}

// reaction counts wrapper
async function getReactionCounts(commentId) {
  try { if (safeDb && safeDb.getReactionCounts) return await safeDb.getReactionCounts(commentId); } catch (e) { console.error('getReactionCounts err', e); }
  return { heart:0, laugh:0, dislike:0 };
}
async function toggleReaction(telegramId, commentId, type) {
  try { if (safeDb && safeDb.toggleReaction) return await safeDb.toggleReaction(telegramId, commentId, type); } catch (e) { console.error('toggleReaction err', e); }
  return null;
}

// ---------- Inline building ----------
async function buildActionsInline(commentId, userId) {
  const reactionCounts = await getReactionCounts(commentId).catch(()=>({ heart:0, laugh:0, dislike:0 }));
  let isFav = false;
  try { if (safeDb && safeDb.isFavorite) isFav = await safeDb.isFavorite(userId, commentId); } catch (e) { console.error('isFavorite err', e); }
  const favourLabel = isFav ? '★ Favorite' : '☆ Favorite';
  const row1 = [
    Markup.button.callback(`❤️ ${reactionCounts.heart||0}`, `react|${commentId}|heart`),
    Markup.button.callback(`😂 ${reactionCounts.laugh||0}`, `react|${commentId}|laugh`),
    Markup.button.callback(`👎 ${reactionCounts.dislike||0}`, `react|${commentId}|dislike`)
  ];
  const row2 = [
    Markup.button.callback(favourLabel, `fav|${commentId}`),
    Markup.button.callback('▶️ Show replies', `list_replies|${commentId}|1`),
    Markup.button.callback('💬 Reply', `replymenu|${commentId}`)
  ];
  const row3 = [
    Markup.button.callback('🚩 Report', `report|${commentId}`),
    Markup.button.callback('🗑 Delete', `delete_comment|${commentId}`)
  ];
  return Markup.inlineKeyboard([row1, row2, row3]);
}

// ---------- Replies display (attached inline) ----------
async function showRepliesForComment(ctx, commentId, page = 1, perPage = 10) {
  try {
    const raw = await safeDb.listReplies(commentId);
    let rows = [];
    if (!raw) rows = [];
    else if (Array.isArray(raw)) rows = raw;
    else if (raw.data && Array.isArray(raw.data)) rows = raw.data;
    else rows = [];

    if (!rows || rows.length === 0) return ctx.reply('No replies yet.');

    const start = (page - 1) * perPage;
    const chunk = rows.slice(start, start + perPage);

    for (const r of chunk) {
      const inline = Markup.inlineKeyboard([
        [ Markup.button.callback('🚩 Report reply', `report_reply|${r.id}`), Markup.button.callback('🗑 Delete reply', `delete_reply|${r.id}`) ],
        [ Markup.button.callback('Reply text', `replytext|${r.comment_id}`), Markup.button.callback('Reply voice', `replyvoice|${r.comment_id}`) ]
      ]);

      if (r.telegram_file_id && !r.reply_text && !r.reply_photo_url) {
        try { await ctx.replyWithVoice(r.telegram_file_id, { caption: `↳ ${r.replier_first_name || r.replier_username || 'User'}`, reply_markup: inline.reply_markup }); } catch (e) { console.error('reply voice send err', e); }
      } else if (r.reply_photo_url || r.telegram_file_id) {
        try {
          const photoId = r.reply_photo_url || r.telegram_file_id;
          await ctx.replyWithPhoto(photoId, { caption: `↳ ${r.replier_first_name || r.replier_username || 'User'}`, reply_markup: inline.reply_markup });
        } catch (e) { console.error('reply photo send err', e); }
      } else if (r.reply_text) {
        await ctx.reply(`↳ ${r.replier_first_name || r.replier_username || 'User'}: ${r.reply_text}`, { reply_markup: inline.reply_markup });
      } else {
        await ctx.reply(`↳ ${r.replier_first_name || r.replier_username || 'User'}`, { reply_markup: inline.reply_markup });
      }
    }

    if (rows.length > start + chunk.length) {
      const next = page + 1;
      await ctx.reply('More replies:', Markup.inlineKeyboard([[Markup.button.callback('More replies', `list_replies|${commentId}|${next}`)]]));
    }
  } catch (e) {
    console.error('showRepliesForComment error', e);
    await ctx.reply('Error listing replies.');
  }
}

// ---------- Helpers ----------
async function sendCommentsPage(ctx, threadId, offset = 0, limit = 15) {
  try {
    const res = await safeDb.listCommentsByThread(threadId, offset, limit).catch(()=>({ data: [] }));
    const data = (res && res.data) ? res.data : (Array.isArray(res) ? res : []);
    if (!data || data.length === 0) return ctx.reply('No comments yet for this video.');
    for (const c of data) {
      try {
        const inline = await buildActionsInline(c.id, ctx.from.id);
        if (c.telegram_file_id) {
          await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${new Date(c.created_at).toLocaleString()}`, reply_markup: inline.reply_markup });
        } else {
          await ctx.reply(`Comment by ${c.first_name || c.username || 'User'}`, { reply_markup: inline.reply_markup });
        }
        const thr = await safeDb.getThreadById(c.thread_id).catch(()=>null);
        if (thr) await ctx.reply(`Video: ${thr.social_link || thr.canonical_link || '(unknown)'}`);
      } catch (e) { console.error('sendCommentsPage per comment err', e); }
    }
    if ((data || []).length === limit) {
      const next = Math.floor(offset/limit) + 2;
      await ctx.reply(`Page ${Math.floor(offset/limit) + 1}`, Markup.inlineKeyboard([[Markup.button.callback('More', `listen|${threadId}|${next}`)]]));
    }
    return;
  } catch (e) {
    console.error('sendCommentsPage error', e);
    return ctx.reply('Error while fetching comments.');
  }
}

// notifications
async function handleNotificationsCommand(ctx) {
  try {
    const res = await safeDb.listNotifications(ctx.from.id).catch(()=>({ data: [] }));
    const rows = (res && res.data) ? res.data : (Array.isArray(res) ? res : (res || []));
    if (!rows || rows.length === 0) return ctx.reply('No notifications yet.', mainKeyboard());
    for (const n of rows) {
      let text = n.message || '';
      try {
        const meta = n.meta || {};
        if (meta.comment_id) {
          const comment = await safeDb.getCommentById(meta.comment_id).catch(()=>null);
          if (comment) {
            const thr = await safeDb.getThreadById(comment.thread_id).catch(()=>null);
            const videoLink = thr ? thr.social_link : '(video unknown)';
            text = `${text}\nVideo: ${videoLink}`;
          }
        }
      } catch (e) { /* ignore */ }
      await ctx.reply(text);
    }
    await ctx.reply('End of notifications.', mainKeyboard());
  } catch (e) {
    console.error('/notifications db err', e);
    await ctx.reply('Could not fetch notifications.');
  }
}

// favorites
async function showFavoritesCommand(ctx) {
  try {
    const favRows = await safeDb.listFavoritesForUser(ctx.from.id);
    if (!favRows || favRows.length === 0) return ctx.reply('No favorites yet.', mainKeyboard());
    for (const c of favRows) {
      if (c.telegram_file_id) {
        await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${new Date(c.created_at).toLocaleString()}` });
      } else {
        await ctx.reply('Favorite comment (no voice stored).');
      }
      let videoLink = '(video unknown)';
      try {
        const thread = await safeDb.getThreadById(c.thread_id);
        if (thread) videoLink = thread.social_link || thread.canonical_link || videoLink;
      } catch (e) {}
      const inline = await buildActionsInline(c.id, ctx.from.id);
      await ctx.reply(utils.encodeShortCode(c.id), inline);
      await ctx.reply(`Video: ${videoLink}`);
    }
    await ctx.reply('End of favorites.', mainKeyboard());
  } catch (e) {
    console.error('showFavoritesCommand err', e);
    await ctx.reply('Could not fetch favorites.');
  }
}

// my comments
async function handleMyComments(ctx) {
  try {
    const rows = await safeDb.listCommentsByUser(ctx.from.id);
    if (!rows || rows.length === 0) return ctx.reply('You have no comments yet.');
    for (const c of rows) {
      const inline = await buildActionsInline(c.id, ctx.from.id);
      if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'You'} • ${new Date(c.created_at).toLocaleString()}`, reply_markup: inline.reply_markup });
      else await ctx.reply('Comment: (no voice saved)', { reply_markup: inline.reply_markup });
      const thr = await safeDb.getThreadById(c.thread_id).catch(()=>null);
      if (thr) await ctx.reply(`Video: ${thr.social_link || thr.canonical_link || '(unknown)'}`);
    }
    await ctx.reply('End of your comments.', mainKeyboard());
  } catch (e) { console.error('/my comments error', e); await ctx.reply('Could not fetch your comments.'); }
}

// search by code
async function handleSearchByCode(ctx, code) {
  try {
    const id = utils.decodeShortCode((code || '').toUpperCase());
    if (!id) return ctx.reply('Invalid code.');
    const comment = await safeDb.getCommentById(id);
    if (!comment) return ctx.reply('No voice found for that code.');
    if (comment.telegram_file_id) {
      try { await ctx.replyWithVoice(comment.telegram_file_id, { caption: `${comment.first_name || comment.username || 'User'} • ${new Date(comment.created_at).toLocaleString()}` }); } catch (e) {}
    } else {
      await ctx.reply('Comment found but no voice stored.');
    }
    const inline = await buildActionsInline(comment.id, ctx.from.id);
    const thread = await safeDb.getThreadById(comment.thread_id);
    const videoLink = thread ? thread.social_link : '(video unknown)';
    await ctx.reply(`Stats: (reactions shown on buttons)\nVideo: ${videoLink}`, inline);
  } catch (e) { console.error('handleSearchByCode error', e); await ctx.reply('Search failed.'); }
}

// ---------- Init Bot ----------
async function initBot() {
  if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in environment');

  const bot = new Telegraf(BOT_TOKEN);

  // start
  bot.start(async (ctx) => {
    try {
      await ensureUserRow(ctx.from).catch(()=>null);
      const balance = await getUserBalance(ctx.from.id).catch(()=>0);
      await ctx.reply(`Welcome to World Voice Comment!\nYou have *${balance}* available comments.`, { parse_mode: 'Markdown' });
      await ctx.reply('Send a TikTok or YouTube link or use the keyboard below.', mainKeyboard());
    } catch (e) {
      console.error('onStart err', e);
      try { await ctx.reply('Welcome — initialization error logged.'); } catch (_) {}
    }
  });

  // support
  bot.command('support', async (ctx) => {
    try {
      const inline = Markup.inlineKeyboard([
        [Markup.button.url('Contact admin (WhatsApp)', `${WHATSAPP_LINK}`)],
        [Markup.button.callback('Send admin number', 'contact_whatsapp')]
      ]);
      await ctx.reply(`Support:\nContact admin on WhatsApp: ${WHATSAPP_LINK}`, inline);
    } catch (e) {
      console.error('/support err', e);
      await ctx.reply('Support unavailable. Try contacting admin via WhatsApp.');
    }
  });

  // admin: reports listing
  bot.command('reports', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only');
    try {
      const rows = await safeDb.listReports({ status: 'open' }).catch(()=>[]);
      if (!rows || rows.length === 0) return ctx.reply('No open reports.');
      for (const r of rows.slice(0, 30)) {
        const summary = `Report #${r.id} • ${r.status}\nReporter: ${r.reporter_username || r.reporter_telegram_id}\nTarget comment: ${r.comment_id || r.reply_id || '(none)'}\nReason: ${r.reason || '(no reason)'}\nCreated: ${new Date(r.created_at).toLocaleString()}`;
        const inline = Markup.inlineKeyboard([
          [Markup.button.callback('View details', `view_report|${r.id}`), Markup.button.callback('Delete comment', `admin_delete_comment|${r.comment_id || 0}`)],
          [Markup.button.callback('Ignore', `admin_ignore_report|${r.id}`)]
        ]);
        await ctx.reply(summary, inline);
      }
    } catch (e) {
      console.error('/reports err', e);
      await ctx.reply('Could not list reports.');
    }
  });

  // admin: view one report
  bot.command('report', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only');
    try {
      const parts = (ctx.message.text || '').split(/\s+/).slice(1);
      if (!parts || parts.length === 0) return ctx.reply('Usage: /report <report_id>');
      const rid = Number(parts[0]);
      if (!rid) return ctx.reply('Invalid report id');
      const r = await safeDb.getReportById(rid);
      if (!r) return ctx.reply('Report not found');
      const detail = `Report #${r.id}\nStatus: ${r.status}\nReporter: ${r.reporter_username || r.reporter_telegram_id}\nTarget comment: ${r.comment_id || ''}\nTarget reply: ${r.reply_id || ''}\nReason: ${r.reason || '(none)'}\nCreated: ${new Date(r.created_at).toLocaleString()}`;
      const inline = Markup.inlineKeyboard([
        [Markup.button.callback('Delete comment', `admin_delete_comment|${r.comment_id || 0}`), Markup.button.callback('Ignore', `admin_ignore_report|${r.id}`)],
        [Markup.button.callback('Mark resolved', `resolve_report|${r.id}`)]
      ]);
      await ctx.reply(detail, inline);
    } catch (e) {
      console.error('/report err', e);
      await ctx.reply('Could not fetch report');
    }
  });

  // payproof command
  bot.command('payproof', async (ctx) => {
    try {
      const parts = (ctx.message.text || '').split(/\s+/).slice(1);
      if (!parts.length) return ctx.reply('Usage: /payproof <payment_id>');
      const pid = Number(parts[0]);
      if (!pid) return ctx.reply('Invalid payment id.');
      PendingMap.set(ctx.from.id, { type: 'upload_payproof', paymentId: pid });
      return ctx.reply(`Now send the proof photo or link for payment #${pid}.`);
    } catch (e) { console.error('/payproof err', e); return ctx.reply('Error processing /payproof.'); }
  });

  // balance
  bot.command('balance', async (ctx) => {
    const bal = await getUserBalance(ctx.from.id);
    return ctx.reply(`Your available comments: *${bal}*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard().reply_markup });
  });

  // ---------- message handler ----------
  bot.on('text', async (ctx) => {
    const textRaw = (ctx.message && ctx.message.text) || '';
    const text = utils.normalizeInput(textRaw);
    const uid = ctx.from && ctx.from.id;
    let p = PendingMap.get(uid);

    // EARLY cancel if user sends a keyboard label, /command, or typed cancel words
    const keyboardLabels = [
      '🎥 add comment','➕ add my video','🔖 track video','🎧 listen comments',
      '💬 my comments','🔎 search','⭐ favorites','🔔 notifications','🛒 buy','🆘 support','💰 balance'
    ];
    const nlower = normalizeKbLabel(text);
    const isSlash = (textRaw || '').trim().startsWith('/');
    const isCancel = ['cancel','ignore','back','exit'].includes((textRaw||'').trim().toLowerCase());
    if (isSlash || isCancel || keyboardLabels.includes(nlower)) {
      if (p) {
        PendingMap.delete(uid);
        p = null;
      }
    }

    // re-read pending after cancel
    p = PendingMap.get(uid);

    // pending handlers: report reason, reply text, upload proof (text), buy_confirm, create_thread flows
    if (p && p.type === 'report_reason' && p.commentId) {
      PendingMap.delete(uid);
      try {
        const commentId = p.commentId;
        const reason = (textRaw || '').trim();
        const inserted = await safeDb.insertReport({ reporter_telegram_id: uid, reporter_username: ctx.from.username || null, comment_id: commentId, reason });
        if (inserted && inserted.error) throw inserted.error;
        await ctx.reply('Report submitted. Admins will review it. Thank you.');
      } catch (e) {
        console.error('report_reason save err', e);
        await ctx.reply('Could not submit report. Try again later.');
      }
      return;
    }

    if (p && p.type === 'report_reply_reason' && p.replyId) {
      PendingMap.delete(uid);
      try {
        const inserted = await safeDb.insertReport({ reporter_telegram_id: uid, reporter_username: ctx.from.username || null, reply_id: p.replyId, reason: (textRaw||'').trim() });
        if (inserted && inserted.error) throw inserted.error;
        await ctx.reply('Report submitted for the reply. Admins will review it.');
      } catch (e) {
        console.error('report_reply save err', e);
        await ctx.reply('Could not submit reply report. Try again later.');
      }
      return;
    }

    if (p && p.type === 'reply_text' && p.commentId) {
      PendingMap.delete(uid);
      try {
        const inserted = await safeDb.insertReplyRow({
          comment_id: p.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          reply_text: textRaw
        });
        if (inserted && inserted.error) throw inserted.error;
        await ctx.reply('Reply saved and posted publicly.');
        // notify owner
        try {
          const comment = await safeDb.getCommentById(p.commentId).catch(()=>null);
          if (comment && comment.telegram_id && comment.telegram_id !== uid) {
            const short = utils.encodeShortCode(p.commentId);
            const threadRow = await safeDb.getThreadById(comment.thread_id);
            const videoLink = threadRow ? threadRow.social_link : '(video unknown)';
            const notifyMsg = `${ctx.from.first_name || ctx.from.username} replied to your comment.\n${short}\nReply text: ${textRaw}\nVideo: ${videoLink}`;
            await safeDb.addNotificationRow({ telegram_id: comment.telegram_id, type: 'reply', message: notifyMsg, meta: { comment_id: p.commentId } }).catch(()=>null);
            try { await bot.telegram.sendMessage(comment.telegram_id, notifyMsg); } catch (_) {}
          }
        } catch (e) { console.error('notify owner reply text err', e); }
      } catch (e) {
        console.error('reply_text save error', e);
        await ctx.reply('Could not save reply text.');
      }
      return;
    }

    if (p && p.type === 'upload_payproof' && p.paymentId && textRaw && !ctx.message.photo) {
      PendingMap.delete(uid);
      try {
        const pid = p.paymentId;
        const upd = await safeDb.updatePaymentStatus(pid, 'proof_submitted', { proof_url: textRaw });
        if (upd && upd.error) throw upd.error;
        await ctx.reply(`Proof (link/text) received for payment #${pid}. Admins will review.`);
        for (const adm of ADMIN_IDS) {
          try {
            const inline = Markup.inlineKeyboard([
              [Markup.button.callback('Approve', `admin_approve|${pid}`), Markup.button.callback('Reject', `admin_reject|${pid}`)]
            ]);
            await bot.telegram.sendMessage(Number(adm), `Payment proof (link/text) for request #${pid} by ${uid}\n\n${textRaw}`, { reply_markup: inline.reply_markup });
          } catch (e) { console.error('notify admin proof text err', e); }
        }
      } catch (e) {
        console.error('upload_payproof text handler err', e);
        await ctx.reply('Could not submit proof (text).');
      }
      return;
    }

    if (p && p.type === 'buy_confirm' && p.pkg) {
      PendingMap.delete(uid);
      return createPaymentRequestFlow(ctx, p.pkg);
    }

    if (p && (p.type === 'create_thread_public' || p.type === 'create_thread_owned')) {
      const url = utils.extractFirstUrl(textRaw);
      if (!url) return ctx.reply('I could not find a link. Send a TikTok or YouTube link.');
      PendingMap.delete(uid);
      try {
        await ensureUserRow(ctx.from).catch(()=>null);
        const creatorId = (p.type === 'create_thread_owned') ? uid : null;
        let thread = await safeDb.findOrCreateThread(url, creatorId);
        if (!thread) {
          await ctx.reply('✅ Thread created (fallback).', mainKeyboard());
          return;
        }
        if (p.type === 'create_thread_owned' && thread && thread.id) {
          try { await safeDb.setThreadCreator(thread.id, uid).catch(()=>null); } catch (e) {}
        }
        const social = thread.social_link || (thread.canonical_link || url);
        const tid = thread.id || (thread.data && thread.data.id) || null;
        const inline = Markup.inlineKeyboard([
          [Markup.button.callback('🎙 Add Voice Comment', `addvoice|${tid}`), Markup.button.callback('🎧 Listen Comments', `listen|${tid}|1`)]
        ]);
        await ctx.reply(`✅ Thread created: ${social}`, mainKeyboard());
        await ctx.reply('What do you want to do next?', inline);
      } catch (e) {
        console.error('create thread flow error', e);
        await ctx.reply('Could not create thread (DB error).');
      }
      return;
    }

    if (p && p.type === 'listen_prompt') {
      PendingMap.delete(uid);
      const url = utils.extractFirstUrl(textRaw);
      if (!url) return ctx.reply('I could not find a link in your message.');
      try {
        const normalized = await utils.normalizeVideoUrl(url).catch(()=>({ canonicalLink: url }));
        let thread = null;
        if (normalized && normalized.canonicalLink) thread = await safeDb.getThreadByLink(normalized.canonicalLink);
        if (!thread && normalized && normalized.provider && normalized.id) {
          try { thread = await safeDb.getThreadByLink(url); } catch(_) { thread = null; }
        }
        if (!thread) thread = await safeDb.getThreadByLink(url);
        if (!thread) return ctx.reply('No comments for that video yet.');
        return sendCommentsPage(ctx, thread.id, 0);
      } catch (e) {
        console.error('listen_prompt handling error', e);
        return ctx.reply('Error while fetching comments.');
      }
    }

    // After pending processing, keyboard labels
    if (keyboardLabels.includes(nlower)) {
      PendingMap.delete(uid);
    }

    // keyboard flows
    const n = nlower;
    if (n === normalizeKbLabel('🎥 add comment')) {
      PendingMap.set(uid, { type: 'create_thread_public' });
      return ctx.reply('Send TikTok/YouTube link for which you want to add a comment (or press a tracked video).');
    }
    if (n === normalizeKbLabel('➕ add my video')) {
      PendingMap.set(uid, { type: 'create_thread_owned' });
      return ctx.reply('Send the link of your video to track it (we will notify you when comments arrive).');
    }
    if (n === normalizeKbLabel('🔖 track video')) {
      try {
        const rows = await safeDb.listThreadsByCreator(ctx.from.id);
        if (!rows || rows.length === 0) return ctx.reply('You have no tracked videos.');
        for (const t of rows) {
          const inline = Markup.inlineKeyboard([
            [Markup.button.callback('🎧 Listen Comments', `listen|${t.id}|1`), Markup.button.callback('🎙 Add Voice Comment', `addvoice|${t.id}`)],
            [Markup.button.callback('🗑 Delete tracked', `delete_thread|${t.id}`)]
          ]);
          await ctx.reply(`${t.social_link}`, inline);
        }
        return;
      } catch (e) {
        console.error('Track Video list error', e);
        return ctx.reply('Could not list tracked videos.');
      }
    }
    if (n === normalizeKbLabel('🎧 listen comments')) {
      PendingMap.set(uid, { type: 'listen_prompt' });
      return ctx.reply('Send a TikTok/YouTube link or click a tracked video to listen comments.');
    }
    if (n === normalizeKbLabel('💬 my comments')) {
      return handleMyComments(ctx);
    }
    if (n === normalizeKbLabel('⭐ favorites')) {
      return showFavoritesCommand(ctx);
    }
    if (n === normalizeKbLabel('🔎 search')) {
      PendingMap.set(uid, { type: 'search_prompt' });
      return ctx.reply('Send the short code (e.g. 0000A9) or use /search CODE.');
    }
    if (n === normalizeKbLabel('🔔 notifications')) {
      return handleNotificationsCommand(ctx);
    }
    if (n === normalizeKbLabel('🛒 buy')) {
      const inline = PAYMENT_PACKAGES.map((p, idx) => [Markup.button.callback(p.label, `buypkg|${idx}`)]);
      inline.push([Markup.button.callback('Contact support (WhatsApp)', 'contact_whatsapp')]);
      return ctx.reply('Choose a package:', Markup.inlineKeyboard(inline));
    }
    if (n === normalizeKbLabel('🆘 support')) {
      return ctx.telegram.sendMessage(ctx.chat.id, `Support:\nContact admin on WhatsApp: ${WHATSAPP_LINK}\nOr use /support to get options.`).catch(()=>{});
    }
    if (n === normalizeKbLabel('💰 balance')) {
      const bal = await getUserBalance(ctx.from.id).catch(()=>0);
      return ctx.reply(`Your available comments: *${bal}*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard().reply_markup });
    }

    // direct link handling
    const maybeUrl = utils.extractFirstUrl(textRaw) || (utils.isSupportedLink(textRaw) ? textRaw : null);
    if (maybeUrl) {
      try {
        await ensureUserRow(ctx.from).catch(()=>null);
        const creatorId = (p && p.type === 'create_thread_owned') ? ctx.from.id : null;
        const t = await safeDb.findOrCreateThread(maybeUrl, creatorId);
        if (!t || !t.id) {
          return ctx.reply('Thread created (fallback). Try listening again with the same link.', mainKeyboard());
        }
        if (creatorId && t && t.id) {
          try { await safeDb.setThreadCreator(t.id, creatorId).catch(()=>null); } catch (e) {}
        }
        const inline = Markup.inlineKeyboard([
          [Markup.button.callback('🎙 Add Voice Comment', `addvoice|${t.id}`), Markup.button.callback('🎧 Listen Comments', `listen|${t.id}|1`)]
        ]);
        await ctx.reply(`Thread created for: ${t.social_link || (t.canonical_link || maybeUrl)}`, inline);
        return;
      } catch (e) {
        console.error('direct create thread error', e);
        return ctx.reply('Error creating thread for that link.');
      }
    }

    // search prompt handling
    const pAfter = PendingMap.get(uid);
    if (pAfter && pAfter.type === 'search_prompt') {
      PendingMap.delete(uid);
      const code = textRaw.trim();
      return handleSearchByCode(ctx, code);
    }

    // default
    return ctx.reply(`Hi ${ctx.from.first_name || ''}! I didn't detect a supported link. Press a button or send a TikTok/YouTube URL.`, mainKeyboard());
  });

  // ---------- voice handler ----------
  bot.on('voice', async (ctx) => {
    const uid = ctx.from.id;
    const p = PendingMap.get(uid);

    // pending reply_voice or report reply voice etc handled here
    if (!p) return ctx.reply('No pending action for voice. Use the keyboard to choose an action.', mainKeyboard());

    // reply voice flow
    if (p.type === 'reply_voice' && p.commentId) {
      PendingMap.delete(uid);
      try {
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found in message.');
        const insert = await safeDb.insertReplyRow({
          comment_id: p.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id
        });
        if (insert && insert.error) throw insert.error;
        await ctx.replyWithVoice(voice.file_id, { caption: `↳ Reply by ${ctx.from.first_name || ctx.from.username}` });

        // notify owner
        try {
          const comment = await safeDb.getCommentById(p.commentId);
          if (comment && comment.telegram_id && comment.telegram_id !== uid) {
            const short = utils.encodeShortCode(p.commentId);
            const threadRow = await safeDb.getThreadById(comment.thread_id);
            const videoLink = threadRow ? threadRow.social_link : '(video unknown)';
            const text = `${ctx.from.first_name || ctx.from.username} replied to your comment.\n${short}\nVideo: ${videoLink}`;
            await safeDb.addNotificationRow({ telegram_id: comment.telegram_id, type: 'reply', message: text, meta: { comment_id: p.commentId } }).catch(()=>null);
            try { await bot.telegram.sendMessage(comment.telegram_id, text); } catch (_) {}
          }
        } catch (e) { console.error('notify owner reply voice err', e); }

        return;
      } catch (e) {
        console.error('reply_voice handler error', e);
        return ctx.reply('Could not save voice reply.');
      }
    }

    // add comment voice
    if (p.type === 'add_comment' && p.threadId) {
      PendingMap.delete(uid);

      // enforce balance
      try {
        const balance = await getUserBalance(uid).catch(()=>0);
        if (Number(balance) <= 0) return ctx.reply('Insufficient credits. Please buy a package first (🛒 Buy). Your comment was not saved.');
      } catch (e) {
        console.error('balance check err before add_comment', e);
        return ctx.reply('Could not verify your balance. Try again later or contact support.');
      }

      try {
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found.');
        const insert = await safeDb.insertVoiceComment({
          thread_id: p.threadId,
          telegram_id: uid,
          username: ctx.from.username || null,
          first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id,
          duration: voice.duration || 0,
          created_at: new Date().toISOString()
        });
        if (insert && insert.error) throw insert.error;
        const row = insert.data || insert;
        const savedId = (row && row.id) ? row.id : (row && row.data && row.data.id ? row.data.id : null);
        const code = utils.encodeShortCode(savedId || (row.id || (row.data && row.data.id)));
        await ctx.reply('✅ Voice saved!');
        await ctx.reply(`${code}`, mainKeyboard());

        // decrement user's free_comments now
        try {
          const dec = await decrementUserBalance(uid, 1).catch(err => ({ error: err && err.message }));
          if (dec && dec.error) {
            console.error('decrementUserBalance reported error', dec);
            try { await ctx.reply('Note: could not decrement your balance (admin will review).'); } catch (_) {}
          }
        } catch (e) {
          console.error('decrementUserBalance error', e);
        }

        // notify tracked owner if any
        try {
          const threadRow = await safeDb.getThreadById(p.threadId);
          if (threadRow && threadRow.creator_telegram_id && threadRow.creator_telegram_id !== uid) {
            const notif = `🔔 New voice comment on your tracked video by ${ctx.from.first_name || ctx.from.username}\nVideo: ${threadRow.social_link}\nCode: ${code}`;
            await safeDb.addNotificationRow({ telegram_id: threadRow.creator_telegram_id, type: 'reply', message: notif, meta: { thread_id: p.threadId, comment_id: savedId } }).catch(()=>null);
            try { await bot.telegram.sendMessage(threadRow.creator_telegram_id, notif); } catch (_) {}
          }
        } catch (e) { console.error('notify tracked owner err', e); }

        return;
      } catch (e) {
        console.error('add_comment voice save error', e);
        return ctx.reply('Could not save voice comment (DB error).');
      }
    }

    // report reply voice pending
    if (p.type === 'report_reply_voice' && p.replyId) {
      PendingMap.delete(uid);
      try {
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found to report.');
        const inserted = await safeDb.insertReport({ reporter_telegram_id: uid, reporter_username: ctx.from.username || null, reply_id: p.replyId, report_telegram_file_id: voice.file_id, reason: '(voice report)' });
        if (inserted && inserted.error) throw inserted.error;
        await ctx.reply('Voice report submitted. Admins will review it.');
      } catch (e) {
        console.error('report_reply_voice err', e);
        await ctx.reply('Could not submit voice report.');
      }
      return;
    }

    return ctx.reply('No expected action for voice now.', mainKeyboard());
  });

  // ---------- photo handler ----------
  bot.on('photo', async (ctx) => {
    const uid = ctx.from.id;
    const p = PendingMap.get(uid);
    if (!p) return ctx.reply('Photo received but no pending action. Use the keyboard or commands.');

    // upload payproof
    if (p.type === 'upload_payproof' && p.paymentId) {
      PendingMap.delete(uid);
      try {
        const photos = ctx.message.photo || [];
        const largest = photos[photos.length - 1];
        const fileId = largest && largest.file_id;
        const upd = await safeDb.updatePaymentStatus(p.paymentId, 'proof_submitted', { proof_telegram_file_id: fileId });
        if (upd && upd.error) throw upd.error;
        await ctx.reply(`Proof received for payment #${p.paymentId}. Admins will review.`);
        for (const adm of ADMIN_IDS) {
          try {
            const inline = Markup.inlineKeyboard([
              [Markup.button.callback('Approve', `admin_approve|${p.paymentId}`), Markup.button.callback('Reject', `admin_reject|${p.paymentId}`)]
            ]);
            await bot.telegram.sendPhoto(Number(adm), fileId, { caption: `Payment proof for request #${p.paymentId} by ${uid}`, reply_markup: inline.reply_markup });
          } catch (e) { console.error('notify admin photo err', e); }
        }
      } catch (e) {
        console.error('upload_payproof photo handler error', e);
        await ctx.reply('Could not submit proof.');
      }
      return;
    }

    // reply photo
    if (p.type === 'reply_photo' && p.commentId) {
      PendingMap.delete(uid);
      try {
        const photos = ctx.message.photo || [];
        const last = photos[photos.length - 1];
        const fileId = last.file_id;
        const insert = await safeDb.insertReplyRow({
          comment_id: p.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          reply_photo_url: null,
          telegram_file_id: fileId
        });
        if (insert && insert.error) throw insert.error;
        await ctx.replyWithPhoto(fileId, { caption: `↳ Photo reply by ${ctx.from.first_name || ctx.from.username}` });
      } catch (e) {
        console.error('reply_photo save error', e);
        await ctx.reply('Could not save photo reply.');
      }
      return;
    }

    // report reply photo
    if (p.type === 'report_reply_photo' && p.replyId) {
      PendingMap.delete(uid);
      try {
        const photos = ctx.message.photo || [];
        const largest = photos[photos.length - 1];
        const fileId = largest && largest.file_id;
        const inserted = await safeDb.insertReport({ reporter_telegram_id: uid, reporter_username: ctx.from.username || null, reply_id: p.replyId, report_telegram_file_id: fileId, reason: '(photo report)' });
        if (inserted && inserted.error) throw inserted.error;
        await ctx.reply('Photo report submitted. Admins will review it.');
      } catch (e) {
        console.error('report_reply_photo err', e);
        await ctx.reply('Could not submit photo report.');
      }
      return;
    }

    return ctx.reply('No matching pending action for photo.', mainKeyboard());
  });

  // ---------- callback_query ----------
  bot.on('callback_query', async (ctx) => {
    try { PendingMap.delete(ctx.from.id); } catch (_) {}
    const data = ctx.callbackQuery && ctx.callbackQuery.data;
    if (!data) return ctx.answerCbQuery();
    const parts = data.split('|');
    const cmd = parts[0];

    try {
      // listen comments pagination
      if (cmd === 'listen') {
        const threadId = Number(parts[1]);
        const page = Number(parts[2] || 1);
        return sendCommentsPage(ctx, threadId, (page-1)*15);
      }

      if (cmd === 'addvoice') {
        const threadId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'add_comment', threadId });
        await ctx.answerCbQuery();
        return ctx.reply('Send your voice now to add it to this thread.');
      }

      if (cmd === 'react') {
        const commentId = Number(parts[1]);
        const rType = parts[2];
        try {
          const result = await toggleReaction(ctx.from.id, commentId, rType);
          const inline = await buildActionsInline(commentId, ctx.from.id);
          try {
            const msg = ctx.callbackQuery.message;
            if (msg && msg.chat && msg.message_id) {
              await ctx.telegram.editMessageReplyMarkup(msg.chat.id, msg.message_id, null, inline.reply_markup);
            }
          } catch (e) {}
          if (result && result.added) await ctx.answerCbQuery('Reaction added');
          else if (result && result.updated) await ctx.answerCbQuery('Reaction updated');
          else if (result && result.removed) await ctx.answerCbQuery('Reaction removed');
          else await ctx.answerCbQuery('Reaction handled');
        } catch (e) {
          console.error('react handler err', e);
          await ctx.answerCbQuery('Could not record reaction');
        }
        return;
      }

      if (cmd === 'fav') {
        const commentId = Number(parts[1]);
        try {
          const result = await safeDb.toggleFavoriteRow(ctx.from.id, commentId);
          await ctx.answerCbQuery(result.removed ? 'Favorite removed' : 'Favorite added');
          try {
            const msg = ctx.callbackQuery.message;
            if (msg && msg.chat && msg.message_id) {
              const inline = await buildActionsInline(commentId, ctx.from.id);
              await ctx.telegram.editMessageReplyMarkup(msg.chat.id, msg.message_id, null, inline.reply_markup);
            }
          } catch (e) {}
        } catch (e) {
          console.error('fav handler err', e);
          await ctx.answerCbQuery('Could not toggle favorite');
        }
        return;
      }

      if (cmd === 'list_replies') {
        const commentId = Number(parts[1]);
        const page = Number(parts[2] || 1);
        await ctx.answerCbQuery();
        return showRepliesForComment(ctx, commentId, page, 10);
      }

      if (cmd === 'replymenu') {
        const commentId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'reply_choice', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Reply options:\n• Send voice to add voice reply\n• Send text to add text reply\n• Send photo to add photo reply\n(Your next message will be used)');
      }

      if (cmd === 'replytext') {
        const commentId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'reply_text', commentId });
        await ctx.answerCbQuery('Send reply text now');
        return ctx.reply('✍️ Send your reply text now.');
      }

      if (cmd === 'replyvoice') {
        const commentId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'reply_voice', commentId });
        await ctx.answerCbQuery('Send voice reply now');
        return ctx.reply('🎙 Send your voice reply now.');
      }

      if (cmd === 'replyphoto') {
        const commentId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'reply_photo', commentId });
        await ctx.answerCbQuery('Send photo reply now');
        return ctx.reply('📷 Send a photo to reply with an image.');
      }

      if (cmd === 'report') {
        const commentId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'report_reason', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain why you report this comment. Send a short message describing the issue.');
      }

      if (cmd === 'report_reply') {
        const replyId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'report_reply_reason', replyId });
        await ctx.answerCbQuery();
        return ctx.reply('Please send a short text describing why you report this reply.');
      }

      if (cmd === 'report_reply_voice') {
        const replyId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'report_reply_voice', replyId });
        await ctx.answerCbQuery();
        return ctx.reply('Send your voice describing the report now (or send a photo).');
      }

      if (cmd === 'delete_comment') {
        const commentId = Number(parts[1]);
        try {
          if (safeDb.supabase) {
            const { error } = await safeDb.supabase.from('voice_comments').delete().eq('id', commentId);
            if (error) throw error;
          } else {
            // mem fallback deletion handled in database.js; here we attempt generic deletion if available
            try { if (safeDb.deleteCommentById) await safeDb.deleteCommentById(commentId); } catch (_) {}
          }
          await ctx.answerCbQuery('Deleted');
          return ctx.reply('Comment deleted.');
        } catch (e) {
          console.error('delete_comment err', e);
          await ctx.answerCbQuery('Not found or could not delete.');
          return;
        }
      }

      if (cmd === 'delete_reply') {
        const replyId = Number(parts[1]);
        try {
          if (safeDb.supabase) {
            const { error } = await safeDb.supabase.from('replies').delete().eq('id', replyId);
            if (error) throw error;
          } else {
            try { if (safeDb.deleteReplyById) await safeDb.deleteReplyById(replyId); } catch (_) {}
          }
          await ctx.answerCbQuery('Reply deleted');
          return ctx.reply('Reply deleted.');
        } catch (e) {
          console.error('delete_reply err', e);
          await ctx.answerCbQuery('Not found or could not delete reply.');
          return;
        }
      }

      if (cmd === 'delete_thread') {
        const threadId = Number(parts[1]);
        try {
          if (safeDb.supabase) {
            const { error } = await safeDb.supabase.from('threads').delete().eq('id', threadId);
            if (error) throw error;
          } else {
            try { if (safeDb.deleteThreadById) await safeDb.deleteThreadById(threadId); } catch (_) {}
          }
          await ctx.answerCbQuery('Tracked video deleted');
          return ctx.reply('Tracked video removed.');
        } catch (e) {
          console.error('delete_thread err', e);
          await ctx.answerCbQuery('Could not delete tracked video.');
          return;
        }
      }

      if (cmd === 'buypkg') {
        const idx = Number(parts[1]);
        const pkg = PAYMENT_PACKAGES[idx];
        if (!pkg) { await ctx.answerCbQuery('Invalid package'); return; }
        try { await ctx.answerCbQuery(); } catch (_) {}
        try {
          PendingMap.set(ctx.from.id, { type: 'buy_confirm', pkg });
          return await createPaymentRequestFlow(ctx, pkg);
        } catch (e) {
          console.error('buypkg handler err', e);
          await ctx.answerCbQuery('Error starting purchase');
          return;
        }
      }

      if (cmd === 'contact_whatsapp') {
        await ctx.answerCbQuery();
        return ctx.reply(`Contact admin: ${WHATSAPP_LINK}`);
      }

      if (cmd === 'copy_tel') {
        const number = parts[1] || '0962058608';
        await ctx.answerCbQuery('Number sent to chat');
        try { await bot.telegram.sendMessage(ctx.from.id, `${number}`); } catch (e) { console.error('copy_tel send err', e); }
        return;
      }
      if (cmd === 'copy_acc') {
        const number = parts[1] || '1000555367884';
        await ctx.answerCbQuery('Account sent to chat');
        try { await bot.telegram.sendMessage(ctx.from.id, `${number}`); } catch (e) { console.error('copy_acc send err', e); }
        return;
      }

      if (cmd === 'start_upload_proof') {
        const paymentId = Number(parts[1]);
        if (!paymentId) { await ctx.answerCbQuery('Invalid payment id'); return; }
        PendingMap.set(ctx.from.id, { type: 'upload_payproof', paymentId });
        await ctx.answerCbQuery();
        await ctx.reply(`Send the payment proof (photo or link) now for payment #${paymentId}.`);
        return;
      }

      // admin approve/reject
      if (cmd === 'admin_approve') {
        const paymentId = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          const payment = await safeDb.getPaymentById(paymentId);
          if (!payment) { await ctx.answerCbQuery('Not found'); return; }
          if (payment.status === 'approved') { await ctx.answerCbQuery('Already approved'); return; }
          const up = await safeDb.updatePaymentStatus(paymentId, 'approved');
          if (up && up.error) throw up.error;

          const credits = Number(payment.comments_amount || 0) || 0;
          try {
            await safeDb.creditUser(payment.telegram_id, credits);
          } catch (e) {
            console.error('admin_approve creditUser err', e);
            await ctx.answerCbQuery('Payment approved but crediting failed (admin must credit manually)');
            try { await bot.telegram.sendMessage(payment.telegram_id, `Your payment #${paymentId} was approved but we could not credit your account automatically. Contact admin.`); } catch (_) {}
            return;
          }
          await ctx.answerCbQuery('Payment approved & credited');
          try { await bot.telegram.sendMessage(payment.telegram_id, `Your payment #${paymentId} was approved. Credited ${credits} comments.`); } catch (_) {}
          return;
        } catch (e) {
          console.error('admin_approve err', e);
          await ctx.answerCbQuery('Error approving payment');
          return;
        }
      }

      if (cmd === 'admin_reject') {
        const paymentId = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          const payment = await safeDb.getPaymentById(paymentId);
          if (!payment) { await ctx.answerCbQuery('Not found'); return; }
          const up = await safeDb.updatePaymentStatus(paymentId, 'rejected');
          if (up && up.error) throw up.error;
          await ctx.answerCbQuery('Payment rejected');
          try { await bot.telegram.sendMessage(payment.telegram_id, `Your payment #${paymentId} was rejected. Contact admin.`); } catch (_) {}
          return;
        } catch (e) {
          console.error('admin_reject err', e);
          await ctx.answerCbQuery('Error rejecting payment');
          return;
        }
      }

      // admin report view
      if (cmd === 'view_report') {
        const rid = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        const r = await safeDb.getReportById(rid);
        if (!r) { await ctx.answerCbQuery('Not found'); return; }
        const detail = `Report #${r.id}\nStatus: ${r.status}\nReporter: ${r.reporter_username || r.reporter_telegram_id}\nTarget comment: ${r.comment_id || ''}\nTarget reply: ${r.reply_id || ''}\nReason: ${r.reason || '(none)'}\nCreated: ${new Date(r.created_at).toLocaleString()}`;
        const inline = Markup.inlineKeyboard([
          [Markup.button.callback('Delete comment', `admin_delete_comment|${r.comment_id || 0}`), Markup.button.callback('Ignore', `admin_ignore_report|${r.id}`)],
          [Markup.button.callback('Mark resolved', `resolve_report|${r.id}`)]
        ]);
        await ctx.reply(detail, inline);
        await ctx.answerCbQuery();
        return;
      }

      if (cmd === 'admin_delete_comment') {
        const commentId = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          if (safeDb.supabase) {
            const { error } = await safeDb.supabase.from('voice_comments').delete().eq('id', commentId);
            if (error) throw error;
          } else {
            try { if (safeDb.deleteCommentById) await safeDb.deleteCommentById(commentId); } catch (_) {}
          }
          await ctx.answerCbQuery('Comment deleted');
          await ctx.reply(`Comment #${commentId} deleted by admin.`);
          return;
        } catch (e) {
          console.error('admin_delete_comment err', e);
          await ctx.answerCbQuery('Could not delete comment');
          return;
        }
      }

      if (cmd === 'admin_ignore_report' || cmd === 'resolve_report') {
        const rid = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          await safeDb.deleteReport(rid).catch(()=>null);
          await ctx.answerCbQuery('Report handled');
          await ctx.reply(`Report #${rid} marked handled by admin.`);
          return;
        } catch (e) {
          console.error('admin_ignore_report err', e);
          await ctx.answerCbQuery('Error handling report');
          return;
        }
      }

      await ctx.answerCbQuery();
    } catch (e) {
      console.error('callback_query top error', e);
      try { await ctx.answerCbQuery('Error handling button'); } catch (_) {}
    }
  });

  // ---------- createPaymentRequestFlow (used by buy) ----------
  async function createPaymentRequestFlow(ctx, pkg) {
    try {
      const created = await safeDb.createPaymentRequest({
        telegram_id: ctx.from.id,
        package_name: pkg.label,
        comments_amount: pkg.credits,
        amount: pkg.amount,
        method: 'manual',
        status: 'pending'
      }).catch(err => {
        console.error('createPaymentRequest (bg) err', err && err.message);
        return null;
      });

      const requestRow = (created && created.data) ? created.data : created;
      const pid = requestRow && requestRow.id ? requestRow.id : Math.floor(Math.random() * 100000);

      const telebirr = '0962058608';
      const cbeAcc = '1000555367884';
      const bankText = `*Payment details*\n\nTELEBIRR: \`${telebirr}\` (AMANUEL DESSALEGN ASFAW)\nCBE Account: \`${cbeAcc}\` (AMANUEL DESSALEGN ASFAW)\n\nAmount: *${pkg.amount} ETB*\n\nAfter payment press "Upload Proof" below then send the screenshot/photo or paste the payment link.\nOr use: /payproof ${pid}`;

      const inline = Markup.inlineKeyboard([
        [ Markup.button.callback('Copy TELEBIRR', `copy_tel|${telebirr}`), Markup.button.callback('Copy CBE', `copy_acc|${cbeAcc}`) ],
        [ Markup.button.callback('Upload Proof (photo/link)', `start_upload_proof|${pid}`) ],
        [ Markup.button.url('Contact admin (WhatsApp)', `${WHATSAPP_LINK}?text=Payment%20for%20request%20${pid}`) ]
      ]);

      try {
        await ctx.replyWithMarkdown(bankText, { reply_markup: inline.reply_markup });
      } catch (e) {
        try { await ctx.reply(bankText, inline); } catch (ee) { /* ignore */ }
      }

      // notify admins
      (async () => {
        for (const adm of ADMIN_IDS) {
          try {
            const uname = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || `${ctx.from.id}`);
            await bot.telegram.sendMessage(Number(adm), `🆕 New payment request (client pid ${pid}) by ${ctx.from.id} (${uname}) — ${pkg.label}\nAmount: ${pkg.amount} ETB`).catch(()=>{});
          } catch (err) { /* ignore */ }
        }
      })();

      return;
    } catch (e) {
      console.error('createPaymentRequestFlow err', e);
      try { await ctx.reply('Could not create payment request. Please contact support/WhatsApp.'); } catch (_) {}
      return;
    }
  }

  // ---------- Misc: /my command ----------
  bot.command('my', handleMyComments);

  // Return bot instance
  return bot;
}

module.exports = { initBot };
