// src/bot.js
// Full Telegram bot implementation for WorldVoiceComment
// Requires: telegraf, ./database, ./utils
// Exports: initBot() -> returns Telegraf instance (serverless-friendly)

const { Telegraf, Markup } = require('telegraf');

// small logger
const log = (...args) => console.log('[bot]', ...args);

// load utils and db wrapper
let utils;
try {
  utils = require('./utils');
} catch (e) {
  console.error('Could not load ./utils — falling back to minimal helpers', e && e.message);
  utils = {};
}
let db;
try {
  db = require('./database');
} catch (e) {
  console.error('Could not load database wrapper', e && (e.stack || e.message));
  db = null;
}

// Env config
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const WHATSAPP_ADMIN = (process.env.WHATSAPP_ADMIN || '').replace(/\D/g, '') || '251962058608';
const WHATSAPP_LINK = `https://wa.me/${WHATSAPP_ADMIN}`;

// Payment packages (editable)
const PAYMENT_PACKAGES = [
  { key: 'pkg_25_12', label: '25 comments — 12 ETB', credits: 25, amount: 12 },
  { key: 'pkg_60_27', label: '60 comments — 27 ETB', credits: 60, amount: 27 },
  { key: 'pkg_130_49', label: '130 comments — 49 ETB', credits: 130, amount: 49 },
  { key: 'pkg_240_89', label: '240 comments — 89 ETB', credits: 240, amount: 89 },
];

// keyboard
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

// fallback utils if missing
utils.normalizeInput = utils.normalizeInput || (s => (s || '').toString().trim());
utils.extractFirstUrl = utils.extractFirstUrl || (s => {
  if (!s) return null;
  const m = String(s).match(/https?:\/\/[^\s]+/i);
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
utils.normalizeVideoUrl = utils.normalizeVideoUrl || (async (link) => {
  // minimal normalizer: return canonicalLink and provider/provider_id if youtube
  const out = { canonicalLink: (link || '').toString().trim(), provider: null, id: null, thumbnail: null };
  try {
    const u = new URL(link);
    const host = u.hostname.toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      out.provider = 'youtube';
      let vid = null;
      if (host.includes('youtu.be')) vid = u.pathname.slice(1);
      else vid = u.searchParams.get('v');
      if (vid) {
        out.id = vid;
        out.thumbnail = `https://img.youtube.com/vi/${vid}/hqdefault.jpg`;
      }
      out.canonicalLink = `https://youtube.com/watch?v=${vid || ''}`;
    }
    // fallback: canonical is trimmed link
  } catch (e) {}
  return out;
});
utils.isSupportedLink = utils.isSupportedLink || (s => !!s && /tiktok\.com|youtube\.com|youtu\.be|vm\.tiktok\.com/i.test(s));

// DB wrapper safe calls (if db not loaded, use memory fallback inside db module)
async function safeEnsureUserRow(user) {
  try { if (db && db.ensureUserRow) return await db.ensureUserRow(user); } catch (e) { console.error('ensureUserRow err', e && e.message); }
  return null;
}
async function safeGetUserBalance(telegramId) {
  try { if (db && db.getUserBalance) return await db.getUserBalance(telegramId); } catch (e) { console.error('getUserBalance err', e && e.message); }
  return 0;
}
async function safeCreditUser(telegramId, amount) {
  try { if (db && db.creditUser) return await db.creditUser(telegramId, amount); } catch (e) { console.error('creditUser err', e && e.message); throw e; }
}
async function safeDecrementUserBalance(telegramId, amount) {
  try { if (db && db.decrementUserBalance) return await db.decrementUserBalance(telegramId, amount); } catch (e) { console.error('decrementUserBalance err', e && e.message); throw e; }
}
async function safeFindOrCreateThread(link, creator) {
  try { if (db && db.findOrCreateThread) return await db.findOrCreateThread(link, creator); } catch (e) { console.error('findOrCreateThread err', e && e.message); }
  // fallback
  return { id: Date.now(), social_link: link, canonical_link: link, creator_telegram_id: creator || null, thumbnail: null };
}
async function safeGetThreadById(id) {
  try { if (db && db.getThreadById) return await db.getThreadById(id); } catch (e) { console.error('getThreadById err', e && e.message); }
  return null;
}
async function safeListThreadsByCreator(telegramId) {
  try { if (db && db.listThreadsByCreator) return await db.listThreadsByCreator(telegramId); } catch (e) { console.error('listThreadsByCreator err', e && e.message); }
  return [];
}
async function safeInsertVoiceComment(payload) {
  try { if (db && db.insertVoiceComment) return await db.insertVoiceComment(payload); } catch (e) { console.error('insertVoiceComment err', e && e.message); throw e; }
}
async function safeListCommentsByThread(threadId, offset=0, limit=15) {
  try { if (db && db.listCommentsByThread) return await db.listCommentsByThread(threadId, offset, limit); } catch (e) { console.error('listCommentsByThread err', e && e.message); }
  return { data: [] };
}
async function safeListCommentsByUser(telegramId) {
  try { if (db && db.listCommentsByUser) return await db.listCommentsByUser(telegramId); } catch (e) { console.error('listCommentsByUser err', e && e.message); }
  return [];
}
async function safeGetCommentById(id) {
  try { if (db && db.getCommentById) return await db.getCommentById(id); } catch (e) { console.error('getCommentById err', e && e.message); }
  return null;
}
async function safeInsertReplyRow(payload) {
  try { if (db && db.insertReplyRow) return await db.insertReplyRow(payload); } catch (e) { console.error('insertReplyRow err', e && e.message); throw e; }
}
async function safeListReplies(commentId) {
  try { if (db && db.listReplies) return await db.listReplies(commentId); } catch (e) { console.error('listReplies err', e && e.message); }
  return [];
}
async function safeToggleFavorite(telegramId, commentId) {
  try { if (db && db.toggleFavoriteRow) return await db.toggleFavoriteRow(telegramId, commentId); } catch (e) { console.error('toggleFavoriteRow err', e && e.message); }
  return { removed: false };
}
async function safeIsFavorite(telegramId, commentId) {
  try { if (db && db.isFavorite) return await db.isFavorite(telegramId, commentId); } catch (e) { console.error('isFavorite err', e && e.message); }
  return false;
}
async function safeListFavoritesForUser(telegramId) {
  try { if (db && db.listFavoritesForUser) return await db.listFavoritesForUser(telegramId); } catch (e) { console.error('listFavoritesForUser err', e && e.message); }
  return [];
}
async function safeToggleReaction(telegramId, commentId, type) {
  try { if (db && db.toggleReaction) return await db.toggleReaction(telegramId, commentId, type); } catch (e) { console.error('toggleReaction err', e && e.message); }
  return null;
}
async function safeGetReactionCounts(commentId) {
  try { if (db && db.getReactionCounts) return await db.getReactionCounts(commentId); } catch (e) { console.error('getReactionCounts err', e && e.message); }
  return { heart:0, laugh:0, dislike:0 };
}
async function safeCreatePaymentRequest(payload) {
  try { if (db && db.createPaymentRequest) return await db.createPaymentRequest(payload); } catch (e) { console.error('createPaymentRequest err', e && e.message); }
  return null;
}
async function safeGetPaymentById(id) {
  try { if (db && db.getPaymentById) return await db.getPaymentById(id); } catch (e) { console.error('getPaymentById err', e && e.message); }
  return null;
}
async function safeUpdatePaymentStatus(id, status, updates = {}) {
  try { if (db && db.updatePaymentStatus) return await db.updatePaymentStatus(id, status, updates); } catch (e) { console.error('updatePaymentStatus err', e && e.message); }
  return null;
}
async function safeAddNotificationRow(payload) {
  try { if (db && db.addNotificationRow) return await db.addNotificationRow(payload); } catch (e) { console.error('addNotificationRow err', e && e.message); }
  return null;
}
async function safeListNotifications(telegramId) {
  try { if (db && db.listNotifications) return await db.listNotifications(telegramId); } catch (e) { console.error('listNotifications err', e && e.message); }
  return { data: [] };
}
async function safeIsUsingSupabase() {
  try { if (db && typeof db.isUsingSupabase === 'function') return db.isUsingSupabase(); } catch (e) {}
  return false;
}

// Pending actions map: telegramId -> { type, ... }
const PendingMap = new Map();

// helper: short code encode/decode
function shortEncode(id) { try { return utils.encodeShortCode(id); } catch (e) { return String(id); } }
function shortDecode(code) { try { return utils.decodeShortCode(code); } catch (e) { return null; } }

// build inline for comment
async function buildActionsInline(commentId, userId) {
  const counts = await safeGetReactionCounts(commentId).catch(()=>({ heart:0,laugh:0,dislike:0 }));
  const fav = await safeIsFavorite(userId, commentId).catch(()=>false);
  const favLabel = fav ? '★ Favorite' : '☆ Favorite';
  const row1 = [
    Markup.button.callback(`❤️ ${counts.heart||0}`, `react|${commentId}|heart`),
    Markup.button.callback(`😂 ${counts.laugh||0}`, `react|${commentId}|laugh`),
    Markup.button.callback(`👎 ${counts.dislike||0}`, `react|${commentId}|dislike`)
  ];
  const row2 = [
    Markup.button.callback(favLabel, `fav|${commentId}`),
    Markup.button.callback('▶️ Show replies', `list_replies|${commentId}|1`),
    Markup.button.callback('💬 Reply', `replymenu|${commentId}`)
  ];
  const row3 = [
    Markup.button.callback('🚩 Report', `report|${commentId}`),
    Markup.button.callback('🗑 Delete', `delete_comment|${commentId}`)
  ];
  return Markup.inlineKeyboard([row1, row2, row3]);
}

// thumbnail helper
function thumbnailForThread(threadRow) {
  if (!threadRow) return null;
  if (threadRow.thumbnail) return threadRow.thumbnail;
  if (threadRow.provider && threadRow.provider.toLowerCase().includes('youtube') && threadRow.provider_id) {
    return `https://img.youtube.com/vi/${threadRow.provider_id}/hqdefault.jpg`;
  }
  // fallback to utils if present
  return (threadRow && threadRow.canonical_link) ? null : null;
}

// show replies for comment
async function showRepliesForComment(ctx, commentId, page = 1, perPage = 10) {
  try {
    const rows = await safeListReplies(commentId);
    if (!rows || rows.length === 0) return ctx.reply('No replies yet.');
    const start = (page-1)*perPage;
    const chunk = rows.slice(start, start+perPage);
    for (const r of chunk) {
      if (r.telegram_file_id) {
        await ctx.replyWithVoice(r.telegram_file_id, { caption: `↳ ${r.replier_first_name || r.replier_username || 'User'}` });
      } else if (r.reply_text) {
        await ctx.reply(`↳ ${r.replier_first_name || r.replier_username || 'User'}: ${r.reply_text}`);
      } else {
        await ctx.reply(`↳ ${r.replier_first_name || r.replier_username || 'User'}`);
      }
    }
    if (rows.length > start + chunk.length) {
      await ctx.reply('More replies:', Markup.inlineKeyboard([[ Markup.button.callback('More replies', `list_replies|${commentId}|${page+1}`) ]]));
    }
  } catch (e) {
    console.error('showRepliesForComment err', e && e.message);
    await ctx.reply('Error listing replies.');
  }
}

// send comments page (listen)
async function sendCommentsPage(ctx, threadId, offset = 0, limit = 15) {
  try {
    if (!(await safeIsUsingSupabase())) return ctx.reply('Persistence unavailable (DB unreachable).');
    const res = await safeListCommentsByThread(threadId, offset, limit).catch(()=>({ data: [] }));
    const rows = (res && res.data) ? res.data : (Array.isArray(res) ? res : []);
    if (!rows || rows.length === 0) return ctx.reply('No comments yet for this video.');
    for (const c of rows) {
      const inline = await buildActionsInline(c.id, ctx.from.id);
      if (c.telegram_file_id) {
        await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${new Date(c.created_at).toLocaleString()}` });
        await ctx.reply(shortEncode(c.id), inline);
      } else {
        await ctx.reply('Comment (no voice saved).', inline);
      }
    }
  } catch (e) {
    console.error('sendCommentsPage err', e && e.message);
    await ctx.reply('Error while fetching comments.');
  }
}

// show favorites
async function showFavoritesCommand(ctx) {
  try {
    if (!(await safeIsUsingSupabase())) return ctx.reply('Persistence unavailable (DB unreachable).');
    const rows = await safeListFavoritesForUser(ctx.from.id);
    if (!rows || rows.length === 0) return ctx.reply('No favorites yet.', mainKeyboard());
    for (const c of rows) {
      if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${new Date(c.created_at).toLocaleString()}` });
      else await ctx.reply('Favorite comment (no voice).');
      await ctx.reply(shortEncode(c.id), await buildActionsInline(c.id, ctx.from.id));
      const thr = await safeGetThreadById(c.thread_id);
      if (thr) await ctx.reply(`Video: ${thr.social_link || thr.canonical_link || '(unknown)'}`);
    }
    await ctx.reply('End of favorites.', mainKeyboard());
  } catch (e) {
    console.error('showFavoritesCommand err', e && e.message);
    await ctx.reply('Could not fetch favorites.');
  }
}

// handle my comments
async function handleMyComments(ctx) {
  try {
    if (!(await safeIsUsingSupabase())) return ctx.reply('Persistence unavailable (DB unreachable).');
    const rows = await safeListCommentsByUser(ctx.from.id);
    if (!rows || rows.length === 0) return ctx.reply('You have no comments yet.');
    for (const c of rows) {
      const inline = await buildActionsInline(c.id, ctx.from.id);
      if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'You'} • ${new Date(c.created_at).toLocaleString()}` });
      else await ctx.reply('Comment (no voice).');
      await ctx.reply(shortEncode(c.id), inline);
      const thr = await safeGetThreadById(c.thread_id);
      if (thr) await ctx.reply(`Video: ${thr.social_link || thr.canonical_link || '(unknown)'}`);
    }
    await ctx.reply('End of your comments.', mainKeyboard());
  } catch (e) {
    console.error('handleMyComments err', e && e.message);
    await ctx.reply('Could not fetch your comments.');
  }
}

// Notifications handler (admin & user)
async function handleNotificationsCommand(ctx) {
  try {
    if (!(await safeIsUsingSupabase())) return ctx.reply('Persistence unavailable (DB unreachable).');
    const res = await safeListNotifications(ctx.from.id).catch(()=>({ data: [] }));
    const rows = (res && res.data) ? res.data : [];
    if (!rows || rows.length === 0) return ctx.reply('No notifications yet.', mainKeyboard());
    for (const n of rows) {
      await ctx.reply(n.message || '(notification)');
    }
    await ctx.reply('End of notifications.', mainKeyboard());
  } catch (e) {
    console.error('handleNotificationsCommand err', e && e.message);
    await ctx.reply('Could not fetch notifications.');
  }
}

// create payment request flow (sends payment details & buttons)
async function createPaymentRequestFlow(ctx, pkg, bot) {
  try {
    const created = await safeCreatePaymentRequest({
      telegram_id: ctx.from.id,
      package_name: pkg.label,
      comments_amount: pkg.credits,
      amount: pkg.amount,
      method: 'manual',
      status: 'pending'
    }).catch(err => {
      console.error('createPaymentRequest (bg) err', err && (err.message || err));
      return null;
    });

    const requestRow = (created && created.data) ? created.data : created;
    const pid = requestRow && requestRow.id ? requestRow.id : Math.floor(Math.random() * 100000);

    // Payment details — customize owner name/account here
    const telebirr = '0962058608';
    const cbeAcc = '1000555367884';
    const bankText = `*Payment details*\n\nTELEBIRR: \`${telebirr}\` (AMANUEL DESSALEGN ASFAW)\nCBE Account: \`${cbeAcc}\` (AMANUEL DESSALEGN ASFAW)\n\nAmount: *${pkg.amount} ETB*\n\nAfter payment press "Upload Proof" below then send the screenshot/photo or paste the payment link.\nOr use: /payproof ${pid}`;

    const inline = Markup.inlineKeyboard([
      [ Markup.button.callback('Copy TELEBIRR', `copy_tel|${telebirr}`), Markup.button.callback('Copy CBE', `copy_acc|${cbeAcc}`) ],
      [ Markup.button.callback('Upload Proof (photo/link)', `start_upload_proof|${pid}`) ],
      [ Markup.button.url('Contact admin (WhatsApp)', `${WHATSAPP_LINK}?text=Payment%20for%20request%20${pid}`) ]
    ]);

    await ctx.replyWithMarkdown(bankText).catch(()=>ctx.reply(bankText));
    await ctx.reply('Payment options:', inline);

    // notify admins
    (async () => {
      for (const adm of ADMIN_IDS) {
        try {
          const uname = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || `${ctx.from.id}`);
          await bot.telegram.sendMessage(Number(adm), `🆕 New payment request #${pid} by ${ctx.from.id} (${uname}) — ${pkg.label} — ${pkg.amount} ETB`).catch(()=>{});
        } catch (err) { /* ignore */ }
      }
    })();

  } catch (e) {
    console.error('createPaymentRequestFlow err', e && e.message);
    await ctx.reply('Could not create payment request. Please contact support.');
  }
}

// helper: admin search by code
async function adminSearchCommentByCode(ctx, code) {
  try {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only');
    const id = shortDecode(code);
    if (!id) return ctx.reply('Invalid code.');
    const comment = await safeGetCommentById(id);
    if (!comment) return ctx.reply('Not found.');
    const inline = Markup.inlineKeyboard([[ Markup.button.callback('Delete', `admin_delete_comment|${id}`) ]]);
    if (comment.telegram_file_id) {
      await ctx.replyWithVoice(comment.telegram_file_id, { caption: `Comment #${id}`, reply_markup: inline.reply_markup });
    } else {
      await ctx.reply(`Comment #${id} (no voice)`, inline);
    }
  } catch (e) {
    console.error('adminSearchCommentByCode err', e && e.message);
    await ctx.reply('Search failed.');
  }
}

// ====== Bot init ======
async function initBot() {
  if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in environment');

  const bot = new Telegraf(BOT_TOKEN);

  // Start / Welcome
  bot.start(async (ctx) => {
    try {
      await safeEnsureUserRow(ctx.from).catch(()=>null);
      const bal = await safeGetUserBalance(ctx.from.id).catch(()=>0);
      await ctx.reply(`Welcome to World Voice Comment!\nYou have *${bal}* available comments.`, { parse_mode: 'Markdown' });
      await ctx.reply('Send a TikTok or YouTube link or use the keyboard below.', mainKeyboard());
    } catch (e) {
      console.error('start err', e && e.message);
      try { await ctx.reply('Welcome — initialization error logged.'); } catch (__) {}
    }
  });

  // admin-only command: check DB mode
  bot.command('dbmode', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only');
    try {
      const using = (db && typeof db.isUsingSupabase === 'function' && db.isUsingSupabase()) ? 'supabase' : 'memory (fallback)';
      return ctx.reply(`DB mode: ${using}`);
    } catch (e) {
      console.error('/dbmode err', e && e.message);
      return ctx.reply('Could not determine DB mode.');
    }
  });

  bot.command('notifications', async (ctx) => { return handleNotificationsCommand(ctx); });
  bot.command('support', async (ctx) => {
    const inline = Markup.inlineKeyboard([[ Markup.button.url('Contact admin (WhatsApp)', WHATSAPP_LINK) ]]);
    return ctx.reply(`Support: ${WHATSAPP_LINK}`, inline);
  });

  bot.command('payproof', async (ctx) => {
    const parts = (ctx.message.text || '').split(/\s+/).slice(1);
    if (!parts.length) return ctx.reply('Usage: /payproof <payment_id>');
    const pid = Number(parts[0]) || null;
    if (!pid) return ctx.reply('Invalid payment id.');
    PendingMap.set(ctx.from.id, { type: 'upload_payproof', paymentId: pid });
    return ctx.reply(`Now send the proof photo or link for payment #${pid}.`);
  });

  bot.command('balance', async (ctx) => {
    const bal = await safeGetUserBalance(ctx.from.id).catch(()=>0);
    return ctx.reply(`Your available comments: *${bal}*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard().reply_markup });
  });

  bot.command('favorites', async (ctx) => showFavoritesCommand(ctx));
  bot.command('my', async (ctx) => handleMyComments(ctx));
  bot.command('reportsearch', async (ctx) => {
    const parts = (ctx.message.text || '').split(/\s+/).slice(1);
    if (!parts.length) return ctx.reply('Usage: /reportsearch <CODE>');
    return adminSearchCommentByCode(ctx, parts[0]);
  });

  // Handle plain text messages
  bot.on('text', async (ctx) => {
    const textRaw = (ctx.message && ctx.message.text) || '';
    const text = utils.normalizeInput(textRaw);
    const uid = ctx.from && ctx.from.id;
    let p = PendingMap.get(uid);

    // cancel pending when user presses a main keyboard label
    const keyboardLabels = [
      '🎥 add comment','➕ add my video','🔖 track video','🎧 listen comments',
      '💬 my comments','🔎 search','⭐ favorites','🔔 notifications','🛒 buy','🆘 support','💰 balance'
    ];
    const labelLower = (text || '').toString().trim().toLowerCase();
    if (keyboardLabels.includes(labelLower)) {
      if (p) { PendingMap.delete(uid); p = null; }
    }

    // handle keyboard choices
    if (labelLower === '🎥 add comment') {
      PendingMap.set(uid, { type: 'create_thread_public' });
      return ctx.reply('Send TikTok/YouTube link for which you want to add a comment (or click a tracked video).');
    }
    if (labelLower === '➕ add my video') {
      PendingMap.set(uid, { type: 'create_thread_owned' });
      return ctx.reply('Send the link of your video to track it (we will notify you when comments arrive).');
    }
    if (labelLower === '🔖 track video') {
      try {
        if (!(await safeIsUsingSupabase())) return ctx.reply('Persistence unavailable (DB unreachable).');
        const rows = await safeListThreadsByCreator(ctx.from.id);
        if (!rows || rows.length === 0) return ctx.reply('You have no tracked videos.');
        for (const t of rows) {
          const thumb = thumbnailForThread(t);
          const inline = Markup.inlineKeyboard([
            [Markup.button.callback('🎧 Listen Comments', `listen|${t.id}|1`), Markup.button.callback('🎙 Add Voice Comment', `addvoice|${t.id}`)],
            [Markup.button.callback('🗑 Delete tracked', `delete_thread|${t.id}`)]
          ]);
          if (thumb) await ctx.replyWithPhoto(thumb, { caption: t.social_link, reply_markup: inline.reply_markup });
          else await ctx.reply(t.social_link, inline);
        }
        return;
      } catch (e) {
        console.error('Track Video list error', e && e.message);
        return ctx.reply('Could not list tracked videos.');
      }
    }
    if (labelLower === '🎧 listen comments') {
      PendingMap.set(uid, { type: 'listen_prompt' });
      return ctx.reply('Send a TikTok/YouTube link or click a tracked video to listen comments.');
    }
    if (labelLower === '💬 my comments') {
      return handleMyComments(ctx);
    }
    if (labelLower === '⭐ favorites') {
      return showFavoritesCommand(ctx);
    }
    if (labelLower === '🔎 search') {
      PendingMap.set(uid, { type: 'search_prompt' });
      return ctx.reply('Send the short code (e.g. 00A1B2) or use /reportsearch CODE.');
    }
    if (labelLower === '🔔 notifications') {
      return handleNotificationsCommand(ctx);
    }
    if (labelLower === '🛒 buy') {
      const inline = PAYMENT_PACKAGES.map((p, idx) => [ Markup.button.callback(p.label, `buypkg|${idx}`) ]);
      inline.push([ Markup.button.callback('Contact support (WhatsApp)', 'contact_whatsapp') ]);
      return ctx.reply('Choose a package:', Markup.inlineKeyboard(inline));
    }
    if (labelLower === '🆘 support') {
      return ctx.reply(`Support:\nContact admin on WhatsApp: ${WHATSAPP_LINK}`);
    }
    if (labelLower === '💰 balance') {
      const bal = await safeGetUserBalance(ctx.from.id).catch(()=>0);
      return ctx.reply(`Your available comments: *${bal}*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard().reply_markup });
    }

    // URL detection -> create thread
    const maybeUrl = utils.extractFirstUrl(textRaw) || (utils.isSupportedLink(textRaw) ? textRaw : null);
    if (maybeUrl) {
      try {
        await safeEnsureUserRow(ctx.from).catch(()=>null);
        const creatorId = (p && p.type === 'create_thread_owned') ? ctx.from.id : null;
        const t = await safeFindOrCreateThread(maybeUrl, creatorId);
        if (!t || !t.id) {
          return ctx.reply('Thread created (fallback). Try listening again with the same link.', mainKeyboard());
        }
        if (creatorId && t && t.id) {
          try { if (db && db.setThreadCreator) await db.setThreadCreator(t.id, creatorId); } catch (e) {}
        }
        const thumb = thumbnailForThread(t);
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('🎙 Add Voice Comment', `addvoice|${t.id}`), Markup.button.callback('🎧 Listen Comments', `listen|${t.id}|1`) ]
        ]);
        if (thumb) await ctx.replyWithPhoto(thumb, { caption: `Thread created for: ${t.social_link || (t.canonical_link || maybeUrl)}`, reply_markup: inline.reply_markup });
        else await ctx.reply(`Thread created for: ${t.social_link || (t.canonical_link || maybeUrl)}`, inline);
        return;
      } catch (e) {
        console.error('direct create thread error', e && e.message);
        return ctx.reply('Error creating thread for that link.');
      }
    }

    // pending 'search by code' flow
    const pend = PendingMap.get(uid);
    if (pend && pend.type === 'search_prompt') {
      PendingMap.delete(uid);
      return handleSearchByCode(ctx, textRaw.trim());
    }

    // if not a link and no keyboard action
    return ctx.reply(`I didn't detect a supported link. Press a button or send a TikTok/YouTube URL.`, mainKeyboard());
  });

  // voice handler
  bot.on('voice', async (ctx) => {
    const uid = ctx.from.id;
    const p = PendingMap.get(uid);
    if (!p) return ctx.reply('No pending action for voice. Use the keyboard to choose an action.', mainKeyboard());

    // reply voice flows
    if ((p.type === 'reply_choice' || p.type === 'reply_voice') && p.commentId) {
      PendingMap.delete(uid);
      try {
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found in message.');
        const inserted = await safeInsertReplyRow({
          comment_id: p.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id,
          created_at: new Date().toISOString()
        });
        if (inserted && inserted.error) throw inserted.error;
        await ctx.replyWithVoice(voice.file_id, { caption: `↳ Reply by ${ctx.from.first_name || ctx.from.username}` });

        // notify comment owner
        try {
          const comment = await safeGetCommentById(p.commentId);
          if (comment && comment.telegram_id && comment.telegram_id !== uid) {
            const code = shortEncode(p.commentId);
            const threadRow = await safeGetThreadById(comment.thread_id);
            const videoLink = threadRow ? threadRow.social_link : '(video unknown)';
            const text = `${ctx.from.first_name || ctx.from.username} replied to your comment.\n${code}\nVideo: ${videoLink}`;
            await safeAddNotificationRow({ telegram_id: comment.telegram_id, type: 'reply', message: text, meta: { comment_id: p.commentId } }).catch(()=>null);
            try { await bot.telegram.sendMessage(comment.telegram_id, text); } catch (_) {}
          }
        } catch (e) { console.error('notify owner reply err', e && e.message); }

        return;
      } catch (e) {
        console.error('reply_voice handler error', e && e.message);
        return ctx.reply('Could not save voice reply.');
      }
    }

    // add comment to thread
    if (p.type === 'add_comment' && p.threadId) {
      PendingMap.delete(uid);
      try {
        if (!(await safeIsUsingSupabase())) return ctx.reply('Cannot save comment: persistence unavailable (DB unreachable).');
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found.');
        const insert = await safeInsertVoiceComment({
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
        const savedId = (row && row.id) ? row.id : null;
        const code = shortEncode(savedId || '');
        await ctx.reply('✅ Voice saved!');
        await ctx.reply(`${code}`, mainKeyboard());

        // decrement balance best-effort
        try {
          const dec = await safeDecrementUserBalance(uid, 1).catch(err => ({ error: err && err.message }));
          if (dec && dec.error) {
            console.error('decrementUserBalance reported error', dec);
            try { await ctx.reply('Note: could not decrement your balance (admin will review).'); } catch (_) {}
          }
        } catch (e) { console.error('decrementUserBalance err', e && e.message); }

        // notify tracked owner
        try {
          const threadRow = await safeGetThreadById(p.threadId);
          if (threadRow && threadRow.creator_telegram_id && threadRow.creator_telegram_id !== uid) {
            const notif = `🔔 New voice comment on your tracked video by ${ctx.from.first_name || ctx.from.username}\nVideo: ${threadRow.social_link}\nCode: ${code}`;
            await safeAddNotificationRow({ telegram_id: threadRow.creator_telegram_id, type: 'reply', message: notif, meta: { thread_id: p.threadId, comment_id: savedId } }).catch(()=>null);
            try { await bot.telegram.sendMessage(threadRow.creator_telegram_id, notif); } catch (_) {}
          }
        } catch (e) { console.error('notify tracked owner err', e && e.message); }

        return;
      } catch (e) {
        console.error('add_comment voice save error', e && (e.stack || e.message));
        return ctx.reply('Could not save voice comment (DB error).');
      }
    }

    return ctx.reply('No expected action for voice now.', mainKeyboard());
  });

  // photo handler (upload proof)
  bot.on('photo', async (ctx) => {
    const uid = ctx.from.id;
    const p = PendingMap.get(uid);
    if (!p) return ctx.reply('Photo received but no pending action.');

    if (p.type === 'upload_payproof' && p.paymentId) {
      PendingMap.delete(uid);
      try {
        const photos = ctx.message.photo || [];
        const largest = photos[photos.length - 1];
        const fileId = largest && largest.file_id;
        const upd = await safeUpdatePaymentStatus(p.paymentId, 'proof_submitted', { proof_telegram_file_id: fileId });
        if (upd && upd.error) throw upd.error;
        await ctx.reply(`Proof received for payment #${p.paymentId}. Admins will review.`);
        for (const adm of ADMIN_IDS) {
          try {
            const inline = Markup.inlineKeyboard([[ Markup.button.callback('Approve', `admin_approve|${p.paymentId}`), Markup.button.callback('Reject', `admin_reject|${p.paymentId}`) ]]);
            await bot.telegram.sendPhoto(Number(adm), fileId, { caption: `Payment proof for request #${p.paymentId} by ${uid}`, reply_markup: inline.reply_markup });
          } catch (e) { console.error('notify admin photo err', e && e.message); }
        }
      } catch (e) {
        console.error('upload_payproof photo handler error', e && (e.stack || e.message));
        await ctx.reply('Could not submit proof.');
      }
      return;
    }

    return ctx.reply('No matching pending action for photo.', mainKeyboard());
  });

  // callback queries (buttons)
  bot.on('callback_query', async (ctx) => {
    try { PendingMap.delete(ctx.from.id); } catch (_) {}
    const data = ctx.callbackQuery && ctx.callbackQuery.data;
    if (!data) return ctx.answerCbQuery();
    const parts = data.split('|');
    const cmd = parts[0];

    try {
      // listen comments
      if (cmd === 'listen') {
        const threadId = Number(parts[1]);
        const page = Number(parts[2] || 1);
        await ctx.answerCbQuery();
        return sendCommentsPage(ctx, threadId, (page-1)*15);
      }

      // add voice button -> set pending
      if (cmd === 'addvoice') {
        const threadId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'add_comment', threadId });
        await ctx.answerCbQuery();
        return ctx.reply('Send your voice now to add it to this thread.');
      }

      // reactions
      if (cmd === 'react') {
        const commentId = Number(parts[1]);
        const rType = parts[2];
        try {
          const result = await safeToggleReaction(ctx.from.id, commentId, rType);
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
          console.error('react handler err', e && e.message);
          await ctx.answerCbQuery('Could not record reaction');
        }
        return;
      }

      // favorite toggle
      if (cmd === 'fav') {
        const commentId = Number(parts[1]);
        try {
          const result = await safeToggleFavorite(ctx.from.id, commentId);
          await ctx.answerCbQuery(result.removed ? 'Favorite removed' : 'Favorite added');
          try {
            const msg = ctx.callbackQuery.message;
            if (msg && msg.chat && msg.message_id) {
              const inline = await buildActionsInline(commentId, ctx.from.id);
              await ctx.telegram.editMessageReplyMarkup(msg.chat.id, msg.message_id, null, inline.reply_markup);
            }
          } catch (e) {}
        } catch (e) {
          console.error('fav handler err', e && e.message);
          await ctx.answerCbQuery('Could not toggle favorite');
        }
        return;
      }

      // list replies
      if (cmd === 'list_replies') {
        const commentId = Number(parts[1]);
        const page = Number(parts[2] || 1);
        await ctx.answerCbQuery();
        return showRepliesForComment(ctx, commentId, page, 10);
      }

      // reply menu -> set pending
      if (cmd === 'replymenu') {
        const commentId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'reply_choice', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Reply options:\n• Send voice to add voice reply\n• Send text to add text reply\n(Your next message will be used)');
      }

      if (cmd === 'replyvoice') {
        const commentId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'reply_voice', commentId });
        await ctx.answerCbQuery('Send voice reply now');
        return ctx.reply('🎙 Send your voice reply now.');
      }

      if (cmd === 'report') {
        const commentId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'report_reason', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain why you report this comment. Send a short message describing the issue.');
      }

      if (cmd === 'delete_comment') {
        const commentId = Number(parts[1]);
        try {
          if (db && db.deleteCommentById) {
            const r = await db.deleteCommentById(commentId);
            if (r && r.error) throw r.error;
            await ctx.answerCbQuery('Deleted');
            return ctx.reply('Comment deleted.');
          } else {
            await ctx.answerCbQuery('Delete unsupported');
            return ctx.reply('Delete unsupported on this deployment.');
          }
        } catch (e) {
          console.error('delete_comment err', e && e.message);
          await ctx.answerCbQuery('Not found or could not delete.');
        }
        return;
      }

      if (cmd === 'delete_reply') {
        const replyId = Number(parts[1]);
        try {
          if (db && db.deleteReplyById) {
            const r = await db.deleteReplyById(replyId);
            if (r && r.error) throw r.error;
            await ctx.answerCbQuery('Reply deleted');
            return ctx.reply('Reply deleted.');
          }
        } catch (e) {
          console.error('delete_reply err', e && e.message);
          await ctx.answerCbQuery('Could not delete reply');
        }
        return;
      }

      if (cmd === 'delete_thread') {
        const threadId = Number(parts[1]);
        try {
          if (db && db.deleteThreadById) {
            const r = await db.deleteThreadById(threadId);
            if (r && r.error) throw r.error;
            await ctx.answerCbQuery('Tracked video deleted');
            return ctx.reply('Tracked video removed.');
          }
        } catch (e) {
          console.error('delete_thread err', e && e.message);
          await ctx.answerCbQuery('Could not delete tracked video');
        }
        return;
      }

      // BUY flow: choose package -> confirm -> create request
      if (cmd === 'buypkg') {
        const idx = Number(parts[1]);
        const pkg = PAYMENT_PACKAGES[idx];
        if (!pkg) { await ctx.answerCbQuery('Invalid package'); return; }
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback(`Confirm: ${pkg.label}`, `confirm_buy|${idx}`), Markup.button.callback('Cancel', `cancel_buy|${idx}`) ]
        ]);
        await ctx.answerCbQuery();
        return ctx.reply(`You chose: ${pkg.label}\nPress Confirm to proceed or Cancel to go back.`, inline);
      }

      if (cmd === 'confirm_buy') {
        const idx = Number(parts[1]);
        const pkg = PAYMENT_PACKAGES[idx];
        if (!pkg) { await ctx.answerCbQuery('Invalid package'); return; }
        await ctx.answerCbQuery('Creating payment request...');
        return createPaymentRequestFlow(ctx, pkg, bot);
      }

      if (cmd === 'cancel_buy') {
        await ctx.answerCbQuery('Purchase cancelled');
        return ctx.reply('Purchase cancelled.', mainKeyboard());
      }

      if (cmd === 'copy_tel') {
        const number = parts[1] || '0962058608';
        await ctx.answerCbQuery('Number sent to chat');
        try { await bot.telegram.sendMessage(ctx.from.id, `${number}`); } catch (e) { console.error('copy_tel send err', e && e.message); }
        return;
      }
      if (cmd === 'copy_acc') {
        const number = parts[1] || '1000555367884';
        await ctx.answerCbQuery('Account sent to chat');
        try { await bot.telegram.sendMessage(ctx.from.id, `${number}`); } catch (e) { console.error('copy_acc send err', e && e.message); }
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

      // admin approve
      if (cmd === 'admin_approve') {
        const paymentId = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          const payment = await safeGetPaymentById(paymentId);
          if (!payment) { await ctx.answerCbQuery('Not found'); return; }
          if (payment.status === 'approved') { await ctx.answerCbQuery('Already approved'); return; }
          await safeUpdatePaymentStatus(paymentId, 'approved').catch(()=>null);
          const credits = Number(payment.comments_amount || 0) || 0;
          try {
            await safeCreditUser(payment.telegram_id, credits);
          } catch (e) {
            console.error('admin_approve creditUser err', e && e.message);
            await ctx.answerCbQuery('Payment approved but crediting failed (admin must credit manually)');
            try { await bot.telegram.sendMessage(payment.telegram_id, `Your payment #${paymentId} was approved but we could not credit your account automatically. Contact admin.`); } catch (_) {}
            return;
          }
          await ctx.answerCbQuery('Payment approved & credited');
          try { await bot.telegram.sendMessage(payment.telegram_id, `Your payment #${paymentId} was approved. Credited ${credits} comments.`); } catch (_) {}
          return;
        } catch (e) {
          console.error('admin_approve err', e && e.message);
          await ctx.answerCbQuery('Error approving payment');
          return;
        }
      }

      if (cmd === 'admin_reject') {
        const paymentId = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          await safeUpdatePaymentStatus(paymentId, 'rejected');
          await ctx.answerCbQuery('Payment rejected');
          return;
        } catch (e) {
          console.error('admin_reject err', e && e.message);
          await ctx.answerCbQuery('Error rejecting payment');
          return;
        }
      }

      if (cmd === 'contact_whatsapp') {
        await ctx.answerCbQuery();
        return ctx.reply(`Contact admin: ${WHATSAPP_LINK}`);
      }

      // admin: view_report, delete, resolve omitted for brevity but available via db wrapper
      await ctx.answerCbQuery();
    } catch (e) {
      console.error('callback_query top error', e && (e.stack || e.message));
      try { await ctx.answerCbQuery('Error handling button'); } catch (_) {}
    }
  });

  // text replies as pending reply_text or report_reason
  bot.on('message', async (ctx) => {
    // Handle plain text responses depending on pending type
    if (!ctx.message || !ctx.message.text) return;
    const uid = ctx.from.id;
    const p = PendingMap.get(uid);
    if (!p) return;

    // reply text
    if (p.type === 'reply_text' && p.commentId) {
      PendingMap.delete(uid);
      try {
        const inserted = await safeInsertReplyRow({
          comment_id: p.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          reply_text: ctx.message.text,
          created_at: new Date().toISOString()
        });
        if (inserted && inserted.error) throw inserted.error;
        await ctx.reply('Text reply saved.');
        return;
      } catch (e) {
        console.error('reply_text save err', e && e.message);
        return ctx.reply('Could not save text reply.');
      }
    }

    // report reason
    if (p.type === 'report_reason' && p.commentId) {
      PendingMap.delete(uid);
      try {
        if (db && db.insertReport) {
          await db.insertReport({
            reporter_telegram_id: uid,
            reporter_username: ctx.from.username || null,
            comment_id: p.commentId,
            reason: ctx.message.text,
            status: 'open',
            created_at: new Date().toISOString()
          });
        } else {
          // fallback: send to admins immediately
          for (const adm of ADMIN_IDS) {
            try {
              await bot.telegram.sendMessage(Number(adm), `🚨 Report: comment #${p.commentId}\nReporter: ${ctx.from.id}\nReason: ${ctx.message.text}`);
            } catch (e) {}
          }
        }
        await ctx.reply('Report submitted. Admins will review.');
        // optionally notify admins with quick link
        for (const adm of ADMIN_IDS) {
          try {
            await bot.telegram.sendMessage(Number(adm), `🚨 New report for comment #${p.commentId}\nReporter: ${ctx.from.id}\nReason: ${ctx.message.text}\nUse /reportsearch CODE to find it.`);
          } catch (e) {}
        }
        return;
      } catch (e) {
        console.error('report_reason save err', e && e.message);
        return ctx.reply('Could not submit report.');
      }
    }

    // upload proof link (if user pasted a URL as proof)
    if (p.type === 'upload_payproof' && p.paymentId) {
      PendingMap.delete(uid);
      try {
        const link = ctx.message.text.trim();
        await safeUpdatePaymentStatus(p.paymentId, 'proof_link_submitted', { proof_link: link });
        await ctx.reply(`Proof link received for payment #${p.paymentId}. Admins will review.`);
        for (const adm of ADMIN_IDS) {
          try {
            const inline = Markup.inlineKeyboard([[ Markup.button.callback('Approve', `admin_approve|${p.paymentId}`), Markup.button.callback('Reject', `admin_reject|${p.paymentId}`) ]]);
            await bot.telegram.sendMessage(Number(adm), `Payment proof (link) for #${p.paymentId} by ${uid}:\n${link}`, inline);
          } catch (e) { console.error('notify admin link err', e && e.message); }
        }
      } catch (e) {
        console.error('upload proof link err', e && e.message);
        await ctx.reply('Could not submit proof link.');
      }
      return;
    }

    // If pending was waiting for a link (create_thread_public/owned/listen_prompt)
    if (p && (p.type === 'create_thread_public' || p.type === 'create_thread_owned' || p.type === 'listen_prompt')) {
      // let the text handler above handle it via the URL path; so do nothing here.
      return;
    }
  });

  // small catch-all error logger
  bot.catch((err, ctx) => {
    console.error('Bot catch error', err && (err.stack || err.message), ctx && ctx.updateType);
  });

  return bot;
}

// helper: admin check
function isAdmin(telegramId) {
  if (!telegramId) return false;
  return ADMIN_IDS.map(Number).includes(Number(telegramId));
}

// helper: handle search by code for regular users
async function handleSearchByCode(ctx, code) {
  try {
    const id = shortDecode((code || '').toUpperCase());
    if (!id) return ctx.reply('Invalid code.');
    const comment = await safeGetCommentById(id);
    if (!comment) return ctx.reply('No voice found for that code.');
    if (comment.telegram_file_id) await ctx.replyWithVoice(comment.telegram_file_id, { caption: `${comment.first_name || comment.username || 'User'} • ${new Date(comment.created_at).toLocaleString()}` });
    else await ctx.reply('Comment found but no voice stored.');
    const inline = await buildActionsInline(comment.id, ctx.from.id);
    const thread = await safeGetThreadById(comment.thread_id);
    const videoLink = thread ? thread.social_link : '(video unknown)';
    await ctx.reply(`Video: ${videoLink}`, inline);
  } catch (e) {
    console.error('handleSearchByCode err', e && e.message);
    await ctx.reply('Search failed.');
  }
}

module.exports = { initBot };
