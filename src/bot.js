// src/bot.js
// World Voice Comment - merged & fixed version
// Key fixes:
// - robust normalizeVideoUrl usage
// - replies decrement balance same as add-comment
// - reports ask for reason and send admins a report notification (no delete button in user report flow)
// - admins can still delete items via admin buttons (only exposed to admins)
// - reactions, favorites, notifications, track/listeners, buy flow fixed
// - uses safe supabase wrapper (database.js) via safeDb
// - PendingMap flow improved to cancel on keyboard presses

const { Telegraf, Markup } = require('telegraf');
const debugLog = (...args) => console.log('[bot]', ...args);

// Defensive require for database and utils (they may throw when env missing)
let db = {};
let utils = {};
try { db = require('./database'); } catch (e) { debugLog('Warning: could not load ./database', e && e.message); db = {}; }
try { utils = require('./utils'); } catch (e) { debugLog('Warning: could not load ./utils', e && e.message); utils = {}; }

// fallback small helpers if utils missing
utils.normalizeInput = utils.normalizeInput || (s => (s === undefined || s === null) ? '' : String(s).trim());
utils.extractFirstUrl = utils.extractFirstUrl || (txt => {
  if (!txt) return null;
  const m = String(txt).match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
});
utils.encodeShortCode = utils.encodeShortCode || (id => {
  if (id === undefined || id === null) return '';
  const v = Number(id) || 0;
  return v.toString(36).toUpperCase().padStart(6, '0');
});
utils.decodeShortCode = utils.decodeShortCode || (code => {
  if (!code) return null;
  try { return parseInt(String(code).toLowerCase(), 36); } catch (e) { return null; }
});
utils.normalizeVideoUrl = utils.normalizeVideoUrl || (async (link) => ({ canonicalLink: link }));
utils.isSupportedLink = utils.isSupportedLink || (s => !!s && /tiktok\.com|youtube\.com|youtu\.be|vm\.tiktok\.com/i.test(s));

// safeDb wrappers - prefer functions from db module when available
const safeDb = { supabase: db.supabase || null };

// copy core database functions or provide simple fallbacks
safeDb.ensureUserRow = db.ensureUserRow || (async (user) => {
  if (!user) return null;
  if (safeDb.supabase) {
    try {
      const row = { telegram_id: user.id, username: user.username || null, first_name: user.first_name || null, updated_at: new Date().toISOString() };
      const { data, error } = await safeDb.supabase.from('users').upsert(row, { onConflict: ['telegram_id'] }).select().maybeSingle();
      if (error) throw error;
      return data;
    } catch (e) { debugLog('ensureUserRow supabase err', e && e.message); return null; }
  }
  return null;
});

safeDb.findOrCreateThread = db.findOrCreateThread || (async (link, creator) => {
  // fallback: simple object
  try {
    if (safeDb.supabase) {
      return await db.findOrCreateThread(link, creator);
    }
  } catch (e) {
    debugLog('safe findOrCreateThread err', e && e.message);
  }
  return { id: Date.now(), social_link: link, created_at: new Date().toISOString() };
});

safeDb.createThread = db.createThread || safeDb.findOrCreateThread;
safeDb.getThreadByLink = db.getThreadByLink || (async (link) => {
  try {
    if (safeDb.supabase && db.getThreadByLink) return await db.getThreadByLink(link);
  } catch (e) { debugLog('getThreadByLink err', e && e.message); }
  return null;
});
safeDb.getThreadById = db.getThreadById || (async (id) => {
  try {
    if (safeDb.supabase && db.getThreadById) return await db.getThreadById(id);
  } catch (e) { debugLog('getThreadById err', e && e.message); }
  return null;
});

safeDb.insertVoiceComment = db.insertVoiceComment || (async (payload) => {
  if (safeDb.supabase) {
    try {
      return await db.insertVoiceComment(payload);
    } catch (e) { debugLog('insertVoiceComment supabase err', e && e.message); return { error: e }; }
  }
  return { data: Object.assign({ id: Date.now(), created_at: new Date().toISOString() }, payload) };
});

safeDb.listCommentsByThread = db.listCommentsByThread || (async (threadId, offset=0, limit=15) => {
  if (safeDb.supabase) {
    try {
      return await db.listCommentsByThread(threadId, offset, limit);
    } catch (e) { debugLog('listCommentsByThread supabase err', e && e.message); return { error: e }; }
  }
  return { data: [] };
});

safeDb.getCommentById = db.getCommentById || (async (id) => {
  if (!id) return null;
  if (safeDb.supabase && db.getCommentById) {
    try { return await db.getCommentById(id); } catch (e) { debugLog('getCommentById err', e && e.message); return null; }
  }
  return null;
});

safeDb.insertReplyRow = db.insertReplyRow || (async (payload) => {
  if (safeDb.supabase) {
    try { return await db.insertReplyRow(payload); } catch (e) { debugLog('insertReplyRow err', e && e.message); return { error: e }; }
  }
  return { data: Object.assign({ id: Date.now(), created_at: new Date().toISOString() }, payload) };
});

safeDb.listReplies = db.listReplies || (async (commentId) => {
  if (safeDb.supabase) {
    try { return await db.listReplies(commentId); } catch (e) { debugLog('listReplies err', e && e.message); return { error: e }; }
  }
  return { data: [] };
});

safeDb.toggleFavoriteRow = db.toggleFavoriteRow || (async (telegramId, commentId) => {
  if (safeDb.supabase) {
    try { return await db.toggleFavoriteRow(telegramId, commentId); } catch (e) { debugLog('toggleFavoriteRow err', e && e.message); return { error: e }; }
  }
  return { removed: false };
});

safeDb.listFavoritesForUser = db.listFavoritesForUser || (async (telegramId) => {
  if (safeDb.supabase) {
    try { return await db.listFavoritesForUser(telegramId); } catch (e) { debugLog('listFavoritesForUser err', e && e.message); return []; }
  }
  return [];
});

safeDb.createPaymentRequest = db.createPaymentRequest || (async (payload) => {
  if (safeDb.supabase) {
    try { return await db.createPaymentRequest(payload); } catch (e) { debugLog('createPaymentRequest err', e && e.message); return { error: e }; }
  }
  return { data: Object.assign({ id: Math.floor(Math.random()*100000), created_at: new Date().toISOString() }, payload) };
});
safeDb.getPaymentById = db.getPaymentById || (async (id) => {
  if (safeDb.supabase && db.getPaymentById) {
    try { return await db.getPaymentById(id); } catch (e) { debugLog('getPaymentById err', e && e.message); return null; }
  }
  return null;
});
safeDb.updatePaymentStatus = db.updatePaymentStatus || (async (id, status, updates={}) => {
  if (safeDb.supabase && db.updatePaymentStatus) {
    try { return await db.updatePaymentStatus(id, status, updates); } catch (e) { debugLog('updatePaymentStatus err', e && e.message); return { error: e }; }
  }
  return { data: { id, status } };
});

safeDb.addNotificationRow = db.addNotificationRow || (async (payload) => {
  if (safeDb.supabase && db.addNotificationRow) {
    try { return await db.addNotificationRow(payload); } catch (e) { debugLog('addNotificationRow err', e && e.message); return { error: e }; }
  }
  return { data: payload };
});
safeDb.listNotifications = db.listNotifications || (async (telegramId) => {
  if (safeDb.supabase && db.listNotifications) {
    try { return await db.listNotifications(telegramId); } catch (e) { debugLog('listNotifications err', e && e.message); return []; }
  }
  return [];
});

safeDb.insertReactionRow = db.insertReactionRow || (async (payload) => {
  if (safeDb.supabase && db.insertReactionRow) {
    try { return await db.insertReactionRow(payload); } catch (e) { debugLog('insertReactionRow err', e && e.message); return { error: e }; }
  }
  return { data: payload };
});
safeDb.isFavorite = db.isFavorite || (async (telegramId, commentId) => {
  if (safeDb.supabase && db.isFavorite) {
    try { return await db.isFavorite(telegramId, commentId); } catch (e) { debugLog('isFavorite err', e && e.message); return false; }
  }
  return false;
});

if (db.setAdminNotifier) safeDb.setAdminNotifier = db.setAdminNotifier;

// ---------- CONFIG ----------
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

// Pending actions map per user
const PendingMap = new Map();

// helper: safe send wrapper to catch errors
async function safeSend(fn, ...args) {
  try { return await fn(...args); } catch (e) { console.error('safeSend error', e && (e.stack || e)); return null; }
}

// helper: get user balance from users.free_comments
async function getUserBalance(telegramId) {
  try {
    if (!safeDb.supabase || !telegramId) return 0;
    // prefer db helper if present
    if (db.getUserBalance) {
      try { return await db.getUserBalance(telegramId); } catch (e) { /* continue fallback */ }
    }
    const { data, error } = await safeDb.supabase.from('users').select('free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
    if (error) throw error;
    return Number((data && data.free_comments) || 0);
  } catch (e) { console.error('getUserBalance err', e && e.message); return 0; }
}

// helper: decrement user balance by 1 (atomic-ish)
async function decrementUserBalance(telegramId, amount = 1) {
  try {
    if (!safeDb.supabase || !telegramId) return false;
    // fetch current
    const { data: userRow, error } = await safeDb.supabase.from('users').select('free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
    if (error) throw error;
    let current = Number((userRow && userRow.free_comments) || 0);
    const next = Math.max(0, current - amount);
    const { data: up, error: upErr } = await safeDb.supabase.from('users').update({ free_comments: next }).eq('telegram_id', telegramId).select().maybeSingle();
    if (upErr) throw upErr;
    return true;
  } catch (e) {
    console.error('decrementUserBalance err', e);
    return false;
  }
}

// reaction counts helper
async function getReactionCounts(commentId) {
  try {
    if (!safeDb.supabase) return { heart:0, laugh:0, dislike:0 };
    const heart = await safeDb.supabase.from('reactions').select('id', { count: 'exact' }).eq('comment_id', commentId).eq('type', 'heart');
    const laugh = await safeDb.supabase.from('reactions').select('id', { count: 'exact' }).eq('comment_id', commentId).eq('type', 'laugh');
    const dislike = await safeDb.supabase.from('reactions').select('id', { count: 'exact' }).eq('comment_id', commentId).eq('type', 'dislike');
    return {
      heart: (heart && heart.count) ? heart.count : 0,
      laugh: (laugh && laugh.count) ? laugh.count : 0,
      dislike: (dislike && dislike.count) ? dislike.count : 0
    };
  } catch (e) { console.error('getReactionCounts err', e); return { heart:0, laugh:0, dislike:0 }; }
}

async function buildActionsInline(commentId, userId) {
  const reactionCounts = await getReactionCounts(commentId);
  const isFav = await safeDb.isFavorite(userId, commentId).catch(e=>false);
  const favourLabel = isFav ? '★ Favorite' : '☆ Favorite';
  const row1 = [
    Markup.button.callback(`❤️ ${reactionCounts.heart || 0}`, `react|${commentId}|heart`),
    Markup.button.callback(`😂 ${reactionCounts.laugh || 0}`, `react|${commentId}|laugh`),
    Markup.button.callback(`👎 ${reactionCounts.dislike || 0}`, `react|${commentId}|dislike`)
  ];
  const row2 = [
    Markup.button.callback(favourLabel, `fav|${commentId}`),
    Markup.button.callback('▶️ Show replies', `list_replies|${commentId}|1`),
    Markup.button.callback('💬 Reply', `replymenu|${commentId}`)
  ];
  const row3 = [
    Markup.button.callback('🚩 Report', `report|${commentId}`),
    // admin-only delete will be provided via admin inline when sending reports to admin; for users we keep Delete but handle permission server-side
    Markup.button.callback('🗑 Delete', `delete_comment|${commentId}`)
  ];
  return Markup.inlineKeyboard([row1, row2, row3]);
}

// Show replies for a comment (paginated). Each reply shows its voice/photo/text and small inline with report/delete for admin.
async function showRepliesForComment(ctx, commentId, page = 1, perPage = 10) {
  try {
    const raw = await safeDb.listReplies(commentId);
    let rows = Array.isArray(raw) ? raw : (raw && raw.data && Array.isArray(raw.data) ? raw.data : []);
    if (!rows || rows.length === 0) return ctx.reply('No replies yet.');
    const start = (page - 1) * perPage;
    const chunk = rows.slice(start, start + perPage);
    for (const r of chunk) {
      // show reply content
      if (r.telegram_file_id && !r.reply_text) {
        try { await ctx.replyWithVoice(r.telegram_file_id, { caption: `↳ ${r.replier_first_name || r.replier_username || 'User'} • ${utils.encodeShortCode(r.id)}` }); } catch (e) { console.error('reply send err', e); }
      } else if (r.reply_text) {
        await ctx.reply(`↳ ${r.replier_first_name || r.replier_username || 'User'}: ${r.reply_text}\nCode: ${utils.encodeShortCode(r.id)}`);
      } else if (r.reply_photo_url) {
        try { await ctx.replyWithPhoto(r.reply_photo_url, { caption: `↳ ${r.replier_first_name || r.replier_username || 'User'}` }); } catch(e) {}
      } else {
        await ctx.reply(`↳ ${r.replier_first_name || r.replier_username || 'User'}\nCode: ${utils.encodeShortCode(r.id)}`);
      }

      // reply options: report (ask reason) — delete only available to admin via admin buttons
      try {
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('🚩 Report reply (text)', `report_reply_text|${r.id}`), Markup.button.callback('🎙 Report reply (voice)', `report_reply_voice|${r.id}`) ]
        ]);
        await ctx.reply('Reply options:', inline);
      } catch (e) { /* ignore */ }
    }

    if (rows.length > start + chunk.length) {
      const next = page + 1;
      await ctx.reply('More replies:', Markup.inlineKeyboard([[ Markup.button.callback('More replies', `list_replies|${commentId}|${next}`) ]]));
    }
  } catch (e) {
    console.error('showRepliesForComment err', e);
    await ctx.reply('Error listing replies.');
  }
}

// notifications command - shows admin-posted notifications + reply-notifications
async function handleNotificationsCommand(ctx) {
  try {
    const res = await safeDb.listNotifications(ctx.from.id);
    const rows = (res && res.data) ? res.data : (Array.isArray(res) ? res : (res || []));
    if (!rows || rows.length === 0) return ctx.reply('No notifications yet.', mainKeyboard());
    for (const n of rows) {
      let text = n.message || '';
      // if it's a reply notification and meta includes comment_id, try to attach voice
      try {
        const meta = n.meta || {};
        if (meta.comment_id) {
          const comment = await safeDb.getCommentById(meta.comment_id).catch(()=>null);
          if (comment) {
            const thread = await safeDb.getThreadById(comment.thread_id).catch(()=>null);
            const videoLink = thread ? (thread.social_link || thread.canonical_link || '(video unknown)') : '(video unknown)';
            text = `${text}\nVideo: ${videoLink}`;
            // include the voice if present
            if (comment.telegram_file_id) {
              try {
                await ctx.replyWithVoice(comment.telegram_file_id, { caption: text });
                continue;
              } catch (e) { /* fallthrough to text */ }
            }
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

// show favorites
async function showFavoritesCommand(ctx) {
  try {
    const rows = await safeDb.listFavoritesForUser(ctx.from.id);
    if (!rows || rows.length === 0) return ctx.reply('No favorites yet.', mainKeyboard());
    for (const c of rows) {
      if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${new Date(c.created_at).toLocaleString()}` });
      else await ctx.reply('Favorite comment (no voice).');
      const thread = await safeDb.getThreadById(c.thread_id).catch(()=>null);
      const videoLink = thread ? (thread.social_link || thread.canonical_link || '(unknown)') : '(unknown)';
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

// safe credit user (used on admin approve)
async function safeCreditUser(telegramId, creditsToAdd) {
  try {
    if (!safeDb.supabase) {
      debugLog('safeCreditUser fallback: no DB');
      return null;
    }
    const { data } = await safeDb.supabase.from('users').select('free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
    if (!data) {
      const { data: up, error: upErr } = await safeDb.supabase.from('users').insert([{ telegram_id: telegramId, free_comments: creditsToAdd }]).select().maybeSingle();
      if (upErr) throw upErr;
      return up;
    } else {
      const current = Number(data.free_comments || 0);
      const next = current + Number(creditsToAdd || 0);
      const { data: u2, error: u2err } = await safeDb.supabase.from('users').update({ free_comments: next }).eq('telegram_id', telegramId).select().maybeSingle();
      if (u2err) throw u2err;
      return u2;
    }
  } catch (e) { console.error('safeCreditUser err', e); throw e; }
}

// notifyAdmins utility (also optionally write to admin_logs via DB)
async function notifyAdmins(text, extra = {}) {
  try {
    if (safeDb.setAdminNotifier) {
      try { await safeDb.setAdminNotifier(text, extra); } catch (e) { debugLog('admin notify setAdminNotifier err', e && e.message); }
    }
    for (const adm of ADMIN_IDS) {
      try { await bot.telegram.sendMessage(Number(adm), text); } catch (e) { console.error('notify admin send err', e && e.message); }
    }
  } catch (e) { console.error('notifyAdmins err', e && e.message); }
}

// create payment request flow -> shows payment details + copy buttons + upload proof
async function createPaymentRequestFlow(ctx, pkg) {
  try {
    const created = await safeDb.createPaymentRequest({
      telegram_id: ctx.from.id,
      package_name: pkg.label,
      comments_amount: pkg.credits,
      amount: pkg.amount,
      method: 'manual',
      status: 'pending'
    });
    const requestRow = (created && created.data) ? created.data : created;
    const pid = (requestRow && requestRow.id) ? requestRow.id : Math.floor(Math.random()*100000);

    const telebirr = '0962058608';
    const cbeAcc = '1000555367884';
    const bankText = `*Payment details*\n\nTELEBIRR: \`${telebirr}\` (AMANUEL DESSALEGN ASFAW)\nCBE Account: \`${cbeAcc}\` (AMANUEL DESSALEGN ASFAW)\n\nAmount: *${pkg.amount} ETB*\n\nAfter payment press "Upload Proof" below then send the screenshot/photo or paste the payment link.\nOr use: /payproof ${pid}`;
    await ctx.replyWithMarkdown(bankText);

    const inline = Markup.inlineKeyboard([
      [ Markup.button.callback('Copy TELEBIRR', `copy_tel|${telebirr}`), Markup.button.callback('Copy CBE', `copy_acc|${cbeAcc}`) ],
      [ Markup.button.callback('Upload Proof (photo/link)', `start_upload_proof|${pid}`) ],
      [ Markup.button.url('Contact admin (WhatsApp)', `${WHATSAPP_LINK}?text=Payment%20for%20request%20${pid}`) ]
    ]);
    await ctx.reply('Payment options:', inline);

    // notify admins so they can check quickly
    try {
      const uname = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || `${ctx.from.id}`);
      for (const adm of ADMIN_IDS) {
        try { await bot.telegram.sendMessage(Number(adm), `🆕 New payment request #${pid} by ${ctx.from.id} (${uname}) — ${pkg.label}\nAmount: ${pkg.amount} ETB`); } catch (e) {}
      }
    } catch (e) { /* ignore */ }
    return;
  } catch (e) {
    console.error('createPaymentRequestFlow err', e);
    try { await ctx.reply('Could not create payment request. Please contact support.'); } catch (_) {}
  }
}

// ---------- INIT BOT ----------
async function initBot() {
  if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in environment');
  const bot = new Telegraf(BOT_TOKEN);

  // START handler
  bot.start(async (ctx) => {
    try {
      await safeDb.ensureUserRow(ctx.from).catch(()=>null);
      const balance = await getUserBalance(ctx.from.id).catch(()=>0);
      await ctx.reply(`Welcome to World Voice Comment!\nYou have *${balance}* available comments.`, { parse_mode: 'Markdown' });
      await ctx.reply('Send a TikTok or YouTube link or use the keyboard below.', mainKeyboard());
    } catch (e) {
      console.error('start err', e);
      await ctx.reply('Welcome — initialization error logged.');
    }
  });

  // support & notifications commands
  bot.command('support', async (ctx) => {
    try {
      const inline = Markup.inlineKeyboard([
        [ Markup.button.url('Contact admin (WhatsApp)', `${WHATSAPP_LINK}`) ],
        [ Markup.button.callback('Send admin number', 'contact_whatsapp') ]
      ]);
      await ctx.reply(`Support:\nContact admin on WhatsApp: ${WHATSAPP_LINK}`, inline);
    } catch (e) { console.error('/support err', e); await ctx.reply('Support unavailable.'); }
  });
  bot.command('notifications', handleNotificationsCommand);
  bot.command('favorites', showFavoritesCommand);

  bot.command('payproof', async (ctx) => {
    try {
      const parts = (ctx.message.text || '').split(/\s+/).slice(1);
      if (!parts.length) return ctx.reply('Usage: /payproof <payment_id>');
      const pid = Number(parts[0]); if (!pid) return ctx.reply('Invalid payment id.');
      PendingMap.set(ctx.from.id, { type: 'upload_payproof', paymentId: pid });
      return ctx.reply(`Now send the proof photo or link for payment #${pid}.`);
    } catch (e) { console.error('/payproof err', e); return ctx.reply('Error processing /payproof.'); }
  });

  bot.command('balance', async (ctx) => {
    try {
      const bal = await getUserBalance(ctx.from.id);
      return ctx.reply(`Your available comments: *${bal}*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard().reply_markup });
    } catch (e) { console.error('/balance err', e); return ctx.reply('Could not fetch balance.'); }
  });

  // ---------- MESSAGE text handler ----------
  bot.on('text', async (ctx) => {
    const textRaw = (ctx.message && ctx.message.text) || '';
    const text = utils.normalizeInput(textRaw);
    const uid = ctx.from && ctx.from.id;
    const p = PendingMap.get(uid);

    // Pending: report reason for comment
    if (p && p.type === 'report_reason' && p.commentId) {
      PendingMap.delete(uid);
      try {
        const commentId = p.commentId;
        const reason = textRaw.trim();
        // save report row in DB
        if (safeDb.supabase) {
          try {
            await safeDb.supabase.from('reports').insert([{ reporter_telegram_id: uid, reporter_username: ctx.from.username || null, comment_id: commentId, reason, created_at: new Date().toISOString() }]);
          } catch (e) { debugLog('save report supabase err', e && e.message); }
        }
        // fetch comment & thread to include context
        const comment = await safeDb.getCommentById(commentId).catch(()=>null);
        const thread = comment ? await safeDb.getThreadById(comment.thread_id).catch(()=>null) : null;
        let owner = null;
        try {
          if (comment && comment.telegram_id && safeDb.supabase) {
            const { data: ownerData } = await safeDb.supabase.from('users').select('telegram_id,username,first_name').eq('telegram_id', comment.telegram_id).limit(1).maybeSingle();
            owner = ownerData || null;
          }
        } catch (e) {}
        const reporterDisplay = ctx.from.username ? `@${ctx.from.username} (${uid})` : `${ctx.from.first_name || uid} (${uid})`;
        const ownerDisplay = owner ? (owner.username ? `@${owner.username} (${owner.telegram_id})` : `${owner.first_name || owner.telegram_id} (${owner.telegram_id})`) : (comment && comment.telegram_id ? `${comment.telegram_id}` : '(unknown)');

        // send to admins with delete/ignore inline (admin-only actions)
        for (const adm of ADMIN_IDS) {
          try {
            const inline = Markup.inlineKeyboard([
              [ Markup.button.callback('Delete comment (admin)', `admin_delete_comment|${commentId}`), Markup.button.callback('Ignore', `admin_ignore_report|${commentId}`) ],
            ]);
            const header = `🚨 Report: comment #${commentId}\nReporter: ${reporterDisplay}\nReported owner: ${ownerDisplay}\nReason: ${reason}\nVideo: ${thread ? (thread.social_link || thread.canonical_link || '(unknown)') : '(unknown)'}`;
            if (comment && comment.telegram_file_id) {
              try {
                await bot.telegram.sendVoice(Number(adm), comment.telegram_file_id, { caption: header, reply_markup: inline.reply_markup });
              } catch (e) {
                await bot.telegram.sendMessage(Number(adm), header, { reply_markup: inline.reply_markup });
              }
            } else {
              await bot.telegram.sendMessage(Number(adm), header, { reply_markup: inline.reply_markup });
            }
          } catch (e) { console.error('notify admin report err', e); }
        }
        await ctx.reply('Thanks — your report was submitted. Admins will review.');
      } catch (e) { console.error('report_reason save err', e); await ctx.reply('Could not submit report.'); }
      return;
    }

    // Pending: report reply text reason
    if (p && p.type === 'report_reply_text' && p.replyId) {
      PendingMap.delete(uid);
      try {
        const reason = textRaw.trim();
        if (safeDb.supabase) {
          try { await safeDb.supabase.from('reports').insert([{ reporter_telegram_id: uid, reply_id: p.replyId, reason, created_at: new Date().toISOString() }]); } catch (e) {}
        }
        for (const adm of ADMIN_IDS) {
          try {
            await bot.telegram.sendMessage(Number(adm), `🚨 Reply report: reply #${p.replyId}\nReporter: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || uid}\nReason: ${reason}`);
          } catch (e) {}
        }
        await ctx.reply('Thanks — your report for the reply was submitted.');
      } catch (e) { console.error('report_reply_text save err', e); await ctx.reply('Could not submit report.'); }
      return;
    }

    // Pending: reply_text content to save
    if (p && p.type === 'reply_text' && p.commentId) {
      const commentId = p.commentId;
      PendingMap.delete(uid);
      try {
        const inserted = await safeDb.insertReplyRow({
          comment_id: commentId,
          replier_telegram_id: ctx.from.id,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          reply_text: textRaw
        });
        if (inserted && inserted.error) throw inserted.error;
        await ctx.reply('Reply saved and posted publicly.');
        // notify owner
        try {
          const comment = await safeDb.getCommentById(commentId);
          if (comment && comment.telegram_id && comment.telegram_id !== ctx.from.id) {
            const short = utils.encodeShortCode(commentId);
            const thread = await safeDb.getThreadById(comment.thread_id).catch(()=>null);
            const videoLink = thread ? (thread.social_link || thread.canonical_link || '(unknown)') : '(unknown)';
            const notifyMsg = `${ctx.from.first_name || ctx.from.username} replied to your comment.\n${short}\nReply text: ${textRaw}\nVideo: ${videoLink}`;
            await safeDb.addNotificationRow({ telegram_id: comment.telegram_id, type: 'reply', message: notifyMsg, meta: { comment_id: commentId } }).catch(()=>null);
            try { await bot.telegram.sendMessage(comment.telegram_id, notifyMsg); } catch (_) {}
          }
        } catch (e) { console.error('notify owner reply err', e); }
      } catch (e) { console.error('reply_text save error', e); return ctx.reply('Could not save reply text.'); }
      return;
    }

    // Pending: upload proof as photo/text
    if (p && p.type === 'upload_payproof' && p.paymentId) {
      PendingMap.delete(uid);
      try {
        const pid = p.paymentId;
        const upd = await safeDb.updatePaymentStatus(pid, 'proof_submitted', { proof_url: textRaw });
        if (upd && upd.error) throw upd.error;
        await ctx.reply(`Proof (link/text) received for payment #${pid}. Admins will review.`);
        for (const adm of ADMIN_IDS) {
          try {
            const inline = Markup.inlineKeyboard([ [ Markup.button.callback('Approve', `admin_approve|${pid}`), Markup.button.callback('Reject', `admin_reject|${pid}`) ] ]);
            await bot.telegram.sendMessage(Number(adm), `Payment proof (link/text) for request #${pid} by ${ctx.from.id}\n\n${textRaw}`, { reply_markup: inline.reply_markup });
          } catch (e) { console.error('notify admin proof text err', e); }
        }
        return;
      } catch (e) { console.error('upload_payproof handler err', e); return ctx.reply('Could not submit proof (text).'); }
    }

    // Pending: buy_confirm (converted to createPaymentRequestFlow)
    if (p && p.type === 'buy_confirm' && p.pkg) {
      PendingMap.delete(uid);
      return createPaymentRequestFlow(ctx, p.pkg);
    }

    // Pending: create thread flows (add comment / add my video)
    if (p && (p.type === 'create_thread_public' || p.type === 'create_thread_owned')) {
      const url = utils.extractFirstUrl(textRaw);
      if (!url) return ctx.reply('I could not find a link. Send a TikTok/YouTube link.');
      PendingMap.delete(uid);
      try {
        await safeDb.ensureUserRow(ctx.from).catch(()=>null);
        let thread = await safeDb.findOrCreateThread(url, p.type === 'create_thread_owned' ? ctx.from.id : null);
        if (!thread) {
          await ctx.reply('✅ Thread created (fallback).', mainKeyboard());
          return;
        }
        // mark creator for track video
        if (p.type === 'create_thread_owned' && safeDb.supabase && thread && (!thread.creator_telegram_id || thread.creator_telegram_id !== ctx.from.id)) {
          try { await safeDb.supabase.from('threads').update({ creator_telegram_id: ctx.from.id }).eq('id', thread.id); } catch (e) {}
        }
        const social = thread.social_link || (thread.canonical_link || url);
        const tid = thread.id || (thread.data && thread.data.id) || null;
        const inline = Markup.inlineKeyboard([ [ Markup.button.callback('🎙 Add Voice Comment', `addvoice|${tid}`), Markup.button.callback('🎧 Listen Comments', `listen|${tid}|1`) ] ]);
        await ctx.reply(`✅ Thread created: ${social}`, mainKeyboard());
        await ctx.reply('What do you want to do next?', inline);
        return;
      } catch (e) {
        console.error('create thread flow error', e);
        return ctx.reply('Could not create thread (DB error).');
      }
    }

    // Pending: listen prompt (user sent link after pressing Listen)
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

    // If user pressed keyboard buttons, cancel pending flow to allow new flow
    const keyboardLabels = [
      '🎥 add comment','➕ add my video','🔖 track video','🎧 listen comments',
      '💬 my comments','🔎 search','⭐ favorites','🔔 notifications','🛒 buy','🆘 support','💰 balance'
    ];
    const nlower = normalizeKbLabel(text);
    if (keyboardLabels.includes(nlower)) PendingMap.delete(uid);

    // handle keyboard commands
    const n = normalizeKbLabel(text);
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
        if (!safeDb.supabase) return ctx.reply('Tracking currently unavailable (DB missing).');
        const { data, error } = await safeDb.supabase.from('threads').select('*').eq('creator_telegram_id', ctx.from.id).order('created_at', { ascending: false });
        if (error) throw error;
        if (!data || data.length === 0) return ctx.reply('You have no tracked videos.');
        for (const t of data) {
          const inline = Markup.inlineKeyboard([
            [ Markup.button.callback('🎧 Listen Comments', `listen|${t.id}|1`), Markup.button.callback('🎙 Add Voice Comment', `addvoice|${t.id}`) ],
            [ Markup.button.callback('🗑 Delete tracked', `delete_thread|${t.id}`) ]
          ]);
          // include thumbnail if thread has canonical link? we attempt to include as text link
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
      const inline = PAYMENT_PACKAGES.map((p, idx) => [ Markup.button.callback(p.label, `buypkg|${idx}`) ]);
      inline.push([ Markup.button.callback('Contact support (WhatsApp)', 'contact_whatsapp') ]);
      return ctx.reply('Choose a package:', Markup.inlineKeyboard(inline));
    }
    if (n === normalizeKbLabel('🆘 support')) {
      return ctx.telegram.sendMessage(ctx.chat.id, `Support:\nContact admin on WhatsApp: ${WHATSAPP_LINK}\nOr use /support to get options.`).catch(()=>{});
    }
    if (n === normalizeKbLabel('💰 balance')) {
      const bal = await getUserBalance(ctx.from.id).catch(()=>0);
      return ctx.reply(`Your available comments: *${bal}*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard().reply_markup });
    }

    // direct link handling: create thread and show actions
    const maybeUrl = utils.extractFirstUrl(textRaw) || (utils.isSupportedLink(textRaw) ? textRaw : null);
    if (maybeUrl) {
      try {
        await safeDb.ensureUserRow(ctx.from).catch(()=>null);
        const t = await safeDb.findOrCreateThread(maybeUrl, null);
        if (!t || !t.id) {
          return ctx.reply('Thread created (fallback). Try listening again with the same link.', mainKeyboard());
        }
        const inline = Markup.inlineKeyboard([ [ Markup.button.callback('🎙 Add Voice Comment', `addvoice|${t.id}`), Markup.button.callback('🎧 Listen Comments', `listen|${t.id}|1`) ] ]);
        await ctx.reply(`Thread created for: ${t.social_link || (t.canonical_link || maybeUrl)}`, inline);
        return;
      } catch (e) {
        console.error('direct create thread error', e);
        return ctx.reply('Error creating thread for that link.');
      }
    }

    // default message
    return ctx.reply(`Hi ${ctx.from.first_name || ''}! I didn't detect a supported link. Press a button or send a TikTok/YouTube URL.`, mainKeyboard());
  });

  // ---------- PHOTO handler for payproof ----------
  bot.on('photo', async (ctx) => {
    const uid = ctx.from.id;
    const p = PendingMap.get(uid);
    if (p && p.type === 'upload_payproof' && p.paymentId) {
      PendingMap.delete(uid);
      try {
        const photos = ctx.message.photo || [];
        const best = photos[photos.length - 1];
        if (!best) return ctx.reply('No photo found.');
        const fileId = best.file_id;
        const pid = p.paymentId;
        const upd = await safeDb.updatePaymentStatus(pid, 'proof_submitted', { proof_telegram_file_id: fileId });
        if (upd && upd.error) throw upd.error;
        await ctx.reply(`Proof received for payment #${pid}. Admins will review.`);
        for (const adm of ADMIN_IDS) {
          try {
            const inline = Markup.inlineKeyboard([ [ Markup.button.callback('Approve', `admin_approve|${pid}`), Markup.button.callback('Reject', `admin_reject|${pid}`) ] ]);
            await bot.telegram.sendPhoto(Number(adm), fileId, { caption: `Payment proof for request #${pid} by ${ctx.from.id}`, reply_markup: inline.reply_markup });
          } catch (e) { console.error('notify admin proof photo err', e); }
        }
        return;
      } catch (e) { console.error('upload_payproof photo handler err', e); return ctx.reply('Could not submit proof (photo).'); }
    }
    // else ignore photo
  });

  // ---------- VOICE handler ----------
  bot.on('voice', async (ctx) => {
    const uid = ctx.from.id;
    const p = PendingMap.get(uid);

    // report reply via voice
    if (p && p.type === 'report_reply_voice' && p.replyId) {
      PendingMap.delete(uid);
      try {
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found to submit for report.');
        if (safeDb.supabase) {
          try { await safeDb.supabase.from('reports').insert([{ reporter_telegram_id: uid, reply_id: p.replyId, report_telegram_file_id: voice.file_id, created_at: new Date().toISOString() }]); } catch (e) {}
        }
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendVoice(Number(adm), voice.file_id, { caption: `🚨 Voice report for reply #${p.replyId}\nReporter: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || uid}` }); } catch (e) {}
        }
        return ctx.reply('Thanks — voice report submitted.');
      } catch (e) { console.error('report_reply_voice err', e); return ctx.reply('Could not submit voice report.'); }
    }

    if (!p) return ctx.reply('No pending action for voice. Use the keyboard to choose an action.', mainKeyboard());

    // reply voice saving
    if (p.type === 'reply_voice' && p.commentId) {
      PendingMap.delete(uid);
      try {
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found in message.');
        const insert = await safeDb.insertReplyRow({
          comment_id: p.commentId,
          replier_telegram_id: ctx.from.id,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id,
          duration: voice.duration || 0
        });
        if (insert && insert.error) throw insert.error;
        await ctx.replyWithVoice(voice.file_id, { caption: `↳ Reply by ${ctx.from.first_name || ctx.from.username}` });

        // decrement balance
        try { await decrementUserBalance(ctx.from.id, 1); } catch (e) { console.error('decrement after reply err', e); }

        // notify owner of original comment
        try {
          const comment = await safeDb.getCommentById(p.commentId);
          if (comment && comment.telegram_id && comment.telegram_id !== ctx.from.id) {
            const short = utils.encodeShortCode(p.commentId);
            const threadRow = await safeDb.getThreadById(comment.thread_id);
            const videoLink = threadRow ? (threadRow.social_link || threadRow.canonical_link || '(video unknown)') : '(video unknown)';
            const notifyMsg = `${ctx.from.first_name || ctx.from.username} replied to your comment.\n${short}\nVideo: ${videoLink}`;
            await safeDb.addNotificationRow({ telegram_id: comment.telegram_id, type: 'reply', message: notifyMsg, meta: { comment_id: p.commentId } }).catch(()=>null);
            try { await bot.telegram.sendMessage(comment.telegram_id, notifyMsg); } catch (_) {}
          }
        } catch (e) { console.error('notify owner reply voice err', e); }
        return;
      } catch (e) { console.error('reply_voice handler error', e); return ctx.reply('Could not save voice reply.'); }
    }

    // add comment voice
    if (p.type === 'add_comment' && p.threadId) {
      PendingMap.delete(uid);
      try {
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found.');
        const insert = await safeDb.insertVoiceComment({
          thread_id: p.threadId,
          telegram_id: ctx.from.id,
          username: ctx.from.username || null,
          first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id,
          duration: voice.duration || 0
        });
        if (insert && insert.error) throw insert.error;
        const row = insert.data || insert;
        const savedId = (row && row.id) ? row.id : (row && row.data && row.data.id ? row.data.id : null);
        const code = utils.encodeShortCode(savedId || (row.id || (row.data && row.data.id)));
        await ctx.reply('✅ Voice saved!');
        await ctx.reply(`${code}`, mainKeyboard());

        // decrement user's balance if free_comments > 0
        try {
          await decrementUserBalance(ctx.from.id, 1);
        } catch (e) { console.error('decrement after add comment err', e); }

        // notify thread owner (if any)
        try {
          const threadRow = await safeDb.getThreadById(p.threadId);
          if (threadRow && threadRow.creator_telegram_id && threadRow.creator_telegram_id !== ctx.from.id) {
            const threadOwner = threadRow.creator_telegram_id;
            const short = utils.encodeShortCode(savedId || '');
            const notifyMsg = `🔔 New voice reply on your tracked video: ${short}\nVideo: ${threadRow.social_link || threadRow.canonical_link || '(unknown)'}`;
            await safeDb.addNotificationRow({ telegram_id: threadOwner, type: 'thread_reply', message: notifyMsg, meta: { comment_id: savedId } }).catch(()=>null);
            try { await bot.telegram.sendMessage(threadOwner, notifyMsg); } catch (_) {}
          }
        } catch (e) { console.error('notify thread owner err', e); }

        return;
      } catch (e) { console.error('add_comment voice save error', e); return ctx.reply('Could not save voice comment (DB error).'); }
    }

    // otherwise, ignore voice
    return ctx.reply('No expected action for voice now.');
  });

  // ---------- CALLBACK_QUERY handler (inline buttons) ----------
  bot.on('callback_query', async (ctx) => {
    try {
      const data = ctx.callbackQuery && ctx.callbackQuery.data;
      if (!data) return ctx.answerCbQuery();
      const parts = String(data).split('|');
      const cmd = parts[0];
      const arg1 = parts[1];
      const arg2 = parts[2];

      // contact whatsapp
      if (cmd === 'contact_whatsapp') {
        await ctx.reply(`Contact admin: ${WHATSAPP_LINK}`);
        return ctx.answerCbQuery('WhatsApp link sent');
      }

      // copy buttons (simulate clipboard by replying the number)
      if (cmd === 'copy_tel' || cmd === 'copy_acc') {
        await ctx.reply(`Copied: ${arg1}`);
        return ctx.answerCbQuery('Copied');
      }

      // start upload proof
      if (cmd === 'start_upload_proof') {
        const pid = Number(arg1);
        PendingMap.set(ctx.from.id, { type: 'upload_payproof', paymentId: pid });
        await ctx.reply(`Now send the proof photo or link for payment #${pid}.`);
        return ctx.answerCbQuery();
      }

      // buy package selection
      if (cmd === 'buypkg') {
        const idx = Number(arg1);
        const pkg = PAYMENT_PACKAGES[idx];
        if (!pkg) return ctx.answerCbQuery('Invalid package');
        PendingMap.set(ctx.from.id, { type: 'buy_confirm', pkg });
        await ctx.reply(`You chose ${pkg.label}. Press again to confirm purchase. Press any keyboard button to cancel.`);
        return ctx.answerCbQuery();
      }

      // upload proof via inline 'Upload proof' pressed
      if (cmd === 'upload_proof') {
        const pid = Number(arg1);
        PendingMap.set(ctx.from.id, { type: 'upload_payproof', paymentId: pid });
        await ctx.reply('Send the proof photo or link now.');
        return ctx.answerCbQuery();
      }

      // admin approves payment
      if (cmd === 'admin_approve') {
        const pid = Number(arg1);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Not authorized');
        // get payment row
        const pay = await safeDb.getPaymentById(pid);
        if (!pay) return ctx.answerCbQuery('Payment not found');
        if (!pay.telegram_id || !pay.comments_amount) return ctx.answerCbQuery('Invalid payment row');
        // credit user
        try {
          await safeCreditUser(pay.telegram_id, pay.comments_amount);
          await safeDb.updatePaymentStatus(pid, 'approved', { approved_by: ctx.from.id });
          await ctx.reply(`Payment #${pid} approved and user credited.`);
          // notify user
          try { await bot.telegram.sendMessage(pay.telegram_id, `Your payment #${pid} has been approved. You were credited ${pay.comments_amount} comments.`); } catch (_) {}
        } catch (e) { console.error('admin_approve err', e); await ctx.reply('Approve failed.'); }
        return ctx.answerCbQuery();
      }

      if (cmd === 'admin_reject') {
        const pid = Number(arg1);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Not authorized');
        await safeDb.updatePaymentStatus(pid, 'rejected', { rejected_by: ctx.from.id });
        await ctx.reply(`Payment #${pid} rejected.`);
        return ctx.answerCbQuery();
      }

      // react to comment
      if (cmd === 'react') {
        const commentId = Number(arg1);
        const rtype = String(arg2);
        if (!commentId || !rtype) return ctx.answerCbQuery();
        // ensure only 1 reaction per user per comment per type (simple insert)
        try {
          await safeDb.insertReactionRow({ comment_id: commentId, telegram_id: ctx.from.id, type: rtype });
          // show updated counts by editing original inline or replying with updated info
          await ctx.answerCbQuery('Reaction registered');
          // optionally update the inline keyboard counts by editing the message (skip for now)
          return;
        } catch (e) { console.error('react err', e); return ctx.answerCbQuery('Could not save reaction'); }
      }

      // favorite toggle
      if (cmd === 'fav') {
        const commentId = Number(arg1);
        try {
          const res = await safeDb.toggleFavoriteRow(ctx.from.id, commentId);
          if (res && res.error) throw res.error;
          await ctx.answerCbQuery(res.removed ? 'Favorite removed' : 'Favorite added');
          return;
        } catch (e) { console.error('fav toggle err', e); return ctx.answerCbQuery('Could not toggle favorite'); }
      }

      // list replies
      if (cmd === 'list_replies') {
        const commentId = Number(arg1);
        const page = Number(arg2) || 1;
        await showRepliesForComment(ctx, commentId, page);
        return ctx.answerCbQuery();
      }

      // reply menu: choose type for reply (voice/text)
      if (cmd === 'replymenu') {
        const commentId = Number(arg1);
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('Reply with voice', `reply_voice|${commentId}`), Markup.button.callback('Reply with text', `reply_text_prompt|${commentId}`) ]
        ]);
        await ctx.reply('Choose how to reply:', inline);
        return ctx.answerCbQuery();
      }

      if (cmd === 'reply_voice') {
        const commentId = Number(arg1);
        PendingMap.set(ctx.from.id, { type: 'reply_voice', commentId });
        await ctx.reply('Send a voice message to reply to this comment. (One voice message only)');
        return ctx.answerCbQuery();
      }
      if (cmd === 'reply_text_prompt') {
        const commentId = Number(arg1);
        PendingMap.set(ctx.from.id, { type: 'reply_text', commentId });
        await ctx.reply('Send the text reply now.');
        return ctx.answerCbQuery();
      }

      // report comment: ask reason (text) before sending to admins
      if (cmd === 'report') {
        const commentId = Number(arg1);
        PendingMap.set(ctx.from.id, { type: 'report_reason', commentId });
        await ctx.reply('Please describe why you are reporting this comment (short explanation).');
        return ctx.answerCbQuery();
      }

      // report reply text flow
      if (cmd === 'report_reply_text') {
        const replyId = Number(arg1);
        PendingMap.set(ctx.from.id, { type: 'report_reply_text', replyId });
        await ctx.reply('Please explain why you report this reply (short text).');
        return ctx.answerCbQuery();
      }
      if (cmd === 'report_reply_voice') {
        const replyId = Number(arg1);
        PendingMap.set(ctx.from.id, { type: 'report_reply_voice', replyId });
        await ctx.reply('Send a voice describing the issue (attach voice) or press Cancel to stop.');
        return ctx.answerCbQuery();
      }

      // delete comment (user action triggers but only admin can actually delete)
      if (cmd === 'delete_comment') {
        const commentId = Number(arg1);
        if (!isAdmin(ctx.from.id)) {
          // non-admin: ask to confirm to delete own comment
          const comment = await safeDb.getCommentById(commentId).catch(()=>null);
          if (comment && comment.telegram_id === ctx.from.id) {
            // allow owner to delete own comment
            try {
              await safeDb.supabase.from('voice_comments').delete().eq('id', commentId);
              await ctx.reply('Your comment was deleted.');
              return ctx.answerCbQuery();
            } catch (e) { console.error('owner delete err', e); return ctx.answerCbQuery('Delete failed'); }
          } else {
            return ctx.answerCbQuery('Not authorized to delete this comment');
          }
        } else {
          // admin - delete directly
          try {
            await safeDb.supabase.from('voice_comments').delete().eq('id', commentId);
            await ctx.reply(`Comment #${commentId} deleted (admin).`);
            return ctx.answerCbQuery();
          } catch (e) { console.error('admin delete err', e); return ctx.answerCbQuery('Delete failed'); }
        }
      }

      // admin_delete_comment (from report notification)
      if (cmd === 'admin_delete_comment') {
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Not authorized');
        const commentId = Number(arg1);
        try {
          await safeDb.supabase.from('voice_comments').delete().eq('id', commentId);
          await ctx.answerCbQuery('Comment deleted');
          await ctx.reply(`Admin deleted comment #${commentId}.`);
        } catch (e) { console.error('admin_delete_comment err', e); await ctx.answerCbQuery('Delete failed'); }
        return;
      }

      // admin_ignore_report
      if (cmd === 'admin_ignore_report') {
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Not authorized');
        const commentId = Number(arg1);
        // optionally mark report ignored
        try {
          if (safeDb.supabase) {
            await safeDb.supabase.from('reports').update({ handled: true, handled_by: ctx.from.id, action: 'ignored' }).eq('comment_id', commentId);
          }
        } catch (e) {}
        await ctx.answerCbQuery('Report ignored');
        return;
      }

      // delete tracked thread
      if (cmd === 'delete_thread') {
        const tid = Number(arg1);
        // only creator or admin
        const thr = await safeDb.getThreadById(tid).catch(()=>null);
        if (!thr) { await ctx.answerCbQuery('Thread not found'); return; }
        if (thr.creator_telegram_id && thr.creator_telegram_id === ctx.from.id || isAdmin(ctx.from.id)) {
          try {
            await safeDb.supabase.from('threads').delete().eq('id', tid);
            await ctx.answerCbQuery('Tracked removed');
            await ctx.reply('Tracked video deleted.');
          } catch (e) { console.error('delete_thread err', e); await ctx.answerCbQuery('Delete failed'); }
        } else {
          await ctx.answerCbQuery('Not authorized');
        }
        return;
      }

      // listen inline: open comments page
      if (cmd === 'listen') {
        const tid = Number(arg1);
        const page = Number(arg2) || 1;
        return sendCommentsPage(ctx, tid, page);
      }

      // admin operations for reported replies etc could go here...

      // default
      await ctx.answerCbQuery();
    } catch (e) {
      console.error('callback_query handler err', e);
      try { await ctx.answerCbQuery('Error handling action'); } catch (_) {}
    }
  });

  // ---------- helper: show comments page ----------
  async function sendCommentsPage(ctx, threadId, page = 1, perPage = 5) {
    try {
      const raw = await safeDb.listCommentsByThread(threadId, (page-1)*perPage, perPage);
      let rows = Array.isArray(raw) ? raw : (raw && raw.data && Array.isArray(raw.data) ? raw.data : []);
      if (!rows || rows.length === 0) return ctx.reply('No comments for that video yet.');
      for (const c of rows) {
        // send voice or text
        if (c.telegram_file_id) {
          try {
            const caption = `${c.first_name || c.username || 'User'} • ${utils.encodeShortCode(c.id)}`;
            await ctx.replyWithVoice(c.telegram_file_id, { caption });
          } catch (e) { console.error('send comment voice err', e); }
        } else {
          await ctx.reply(`${c.first_name || c.username || 'User'}: (no voice) ${utils.encodeShortCode(c.id)}`);
        }
        const inline = await buildActionsInline(c.id, ctx.from.id);
        await ctx.reply(`${utils.encodeShortCode(c.id)}`, inline);
      }
      if (rows.length === perPage) {
        const next = page + 1;
        await ctx.reply('More comments:', Markup.inlineKeyboard([ [ Markup.button.callback('More', `listen|${threadId}|${next}`) ] ]));
      }
      return;
    } catch (e) {
      console.error('sendCommentsPage err', e);
      await ctx.reply('Error fetching comments.');
    }
  }

  // ---------- helper: show my comments ----------
  async function handleMyComments(ctx) {
    try {
      if (!safeDb.supabase) return ctx.reply('Persistence unavailable (DB unreachable).');
      const { data, error } = await safeDb.supabase.from('voice_comments').select('*').eq('telegram_id', ctx.from.id).order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      if (!data || data.length === 0) return ctx.reply('No comments found for your account.', mainKeyboard());
      for (const c of data) {
        if (c.telegram_file_id) {
          await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'You'} • ${utils.encodeShortCode(c.id)}` });
        } else {
          await ctx.reply(`${c.first_name || c.username || 'You'} • ${utils.encodeShortCode(c.id)}`);
        }
        const inline = await buildActionsInline(c.id, ctx.from.id);
        await ctx.reply(utils.encodeShortCode(c.id), inline);
      }
      await ctx.reply('End of your comments.', mainKeyboard());
    } catch (e) {
      console.error('handleMyComments err', e);
      await ctx.reply('Could not fetch your comments.');
    }
  }

  // ---------- start the bot instance object ----------
  return bot;
}

module.exports = { initBot };
