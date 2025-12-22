// src/bot.js
// Full bot implementation — fixed: handleNotificationsCommand defined, save comments, favorites, track listing, buy confirm flow.

const { Telegraf, Markup } = require('telegraf');
const debugLog = (...args) => console.log('[bot]', ...args);

// load database wrapper and utils (both should be present)
let dbapi;
try {
  dbapi = require('./database');
} catch (e) {
  console.error('Could not require ./database', e && e.message);
  dbapi = null;
}
let utils;
try {
  utils = require('./utils');
} catch (e) {
  console.error('Could not require ./utils', e && e.message);
  utils = {};
}

// safe util fallbacks
utils.normalizeInput = utils.normalizeInput || (s => (s||'').toString().trim());
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
utils.normalizeVideoUrl = utils.normalizeVideoUrl || (async (url) => ({ canonicalLink: url }));
utils.isSupportedLink = utils.isSupportedLink || (s => !!s && /tiktok\.com|youtube\.com|youtu\.be|vm\.tiktok\.com/i.test(s));

// config and packages
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const WHATSAPP_ADMIN = (process.env.WHATSAPP_ADMIN || '').replace(/\D/g, '') || '251962058608';
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

// DB wrappers with safe fallbacks to avoid crashing if dbapi missing
async function ensureUserRow(user) {
  try { if (dbapi && dbapi.ensureUserRow) return await dbapi.ensureUserRow(user); } catch (e) { console.error('ensureUserRow err', e && e.message); }
  return null;
}
async function getUserBalance(telegramId) {
  try { if (dbapi && dbapi.getUserBalance) return await dbapi.getUserBalance(telegramId); } catch (e) { console.error('getUserBalance err', e && e.message); }
  return 0;
}
async function creditUser(telegramId, amount) {
  try { if (dbapi && dbapi.creditUser) return await dbapi.creditUser(telegramId, amount); } catch (e) { console.error('creditUser err', e && e.message); throw e; }
}
async function decrementUserBalance(telegramId, amount) {
  try { if (dbapi && dbapi.decrementUserBalance) return await dbapi.decrementUserBalance(telegramId, amount); } catch (e) { console.error('decrementUserBalance err', e && e.message); throw e; }
}
async function findOrCreateThread(link, creator) {
  try { if (dbapi && dbapi.findOrCreateThread) return await dbapi.findOrCreateThread(link, creator); } catch (e) { console.error('findOrCreateThread err', e && e.message); }
  // fallback: minimal thread object
  return { id: Date.now(), social_link: link, canonical_link: link, creator_telegram_id: creator || null, created_at: new Date().toISOString() };
}
async function getThreadById(id) {
  try { if (dbapi && dbapi.getThreadById) return await dbapi.getThreadById(id); } catch (e) { console.error('getThreadById err', e && e.message); }
  return null;
}
async function listThreadsByCreator(telegramId) {
  try { if (dbapi && dbapi.listThreadsByCreator) return await dbapi.listThreadsByCreator(telegramId); } catch (e) { console.error('listThreadsByCreator err', e && e.message); }
  return [];
}
async function insertVoiceComment(payload) {
  try { if (dbapi && dbapi.insertVoiceComment) return await dbapi.insertVoiceComment(payload); } catch (e) { console.error('insertVoiceComment err', e && e.message); throw e; }
}
async function listCommentsByThread(threadId, offset = 0, limit = 15) {
  try { if (dbapi && dbapi.listCommentsByThread) return await dbapi.listCommentsByThread(threadId, offset, limit); } catch (e) { console.error('listCommentsByThread err', e && e.message); }
  return { data: [] };
}
async function listCommentsByUser(telegramId) {
  try { if (dbapi && dbapi.listCommentsByUser) return await dbapi.listCommentsByUser(telegramId); } catch (e) { console.error('listCommentsByUser err', e && e.message); }
  return [];
}
async function getCommentById(id) {
  try { if (dbapi && dbapi.getCommentById) return await dbapi.getCommentById(id); } catch (e) { console.error('getCommentById err', e && e.message); }
  return null;
}
async function insertReplyRow(payload) {
  try { if (dbapi && dbapi.insertReplyRow) return await dbapi.insertReplyRow(payload); } catch (e) { console.error('insertReplyRow err', e && e.message); throw e; }
}
async function listReplies(commentId) {
  try { if (dbapi && dbapi.listReplies) return await dbapi.listReplies(commentId); } catch (e) { console.error('listReplies err', e && e.message); }
  return [];
}
async function toggleFavoriteRow(telegramId, commentId) {
  try { if (dbapi && dbapi.toggleFavoriteRow) return await dbapi.toggleFavoriteRow(telegramId, commentId); } catch (e) { console.error('toggleFavoriteRow err', e && e.message); }
  return { removed: false };
}
async function listFavoritesForUser(telegramId) {
  try { if (dbapi && dbapi.listFavoritesForUser) return await dbapi.listFavoritesForUser(telegramId); } catch (e) { console.error('listFavoritesForUser err', e && e.message); }
  return [];
}
async function toggleReaction(telegramId, commentId, type) {
  try { if (dbapi && dbapi.toggleReaction) return await dbapi.toggleReaction(telegramId, commentId, type); } catch (e) { console.error('toggleReaction err', e && e.message); }
  return null;
}
async function getReactionCounts(commentId) {
  try { if (dbapi && dbapi.getReactionCounts) return await dbapi.getReactionCounts(commentId); } catch (e) { console.error('getReactionCounts err', e && e.message); }
  return { heart:0, laugh:0, dislike:0 };
}
async function createPaymentRequest(payload) {
  try { if (dbapi && dbapi.createPaymentRequest) return await dbapi.createPaymentRequest(payload); } catch (e) { console.error('createPaymentRequest err', e && e.message); }
  return null;
}
async function getPaymentById(id) {
  try { if (dbapi && dbapi.getPaymentById) return await dbapi.getPaymentById(id); } catch (e) { console.error('getPaymentById err', e && e.message); }
  return null;
}
async function updatePaymentStatus(id, status, updates = {}) {
  try { if (dbapi && dbapi.updatePaymentStatus) return await dbapi.updatePaymentStatus(id, status, updates); } catch (e) { console.error('updatePaymentStatus err', e && e.message); }
  return null;
}
async function addNotificationRow(payload) {
  try { if (dbapi && dbapi.addNotificationRow) return await dbapi.addNotificationRow(payload); } catch (e) { console.error('addNotificationRow err', e && e.message); }
  return null;
}
async function listNotifications(telegramId) {
  try { if (dbapi && dbapi.listNotifications) return await dbapi.listNotifications(telegramId); } catch (e) { console.error('listNotifications err', e && e.message); }
  return { data: [] };
}
async function isUsingSupabase() {
  try { if (dbapi && typeof dbapi.isUsingSupabase === 'function') return dbapi.isUsingSupabase(); } catch (e) {}
  // if dbapi doesn't expose it, assume true (best effort)
  return true;
}

// ====================== Important helper: Notifications command ======================
async function handleNotificationsCommand(ctx) {
  try {
    if (!(await isUsingSupabase())) return ctx.reply('Persistence unavailable (DB unreachable).');
    const res = await listNotifications(ctx.from.id).catch(()=>({ data: [] }));
    const rows = (res && res.data) ? res.data : (Array.isArray(res) ? res : []);
    if (!rows || rows.length === 0) return ctx.reply('No notifications yet.', mainKeyboard());
    for (const n of rows) {
      let text = n.message || '';
      try {
        const meta = n.meta || {};
        if (meta.comment_id) {
          const comment = await getCommentById(meta.comment_id).catch(()=>null);
          if (comment) {
            const thr = await getThreadById(comment.thread_id).catch(()=>null);
            const videoLink = thr ? thr.social_link : '(video unknown)';
            text = `${text}\nVideo: ${videoLink}`;
          }
        }
      } catch (e) { /* ignore */ }
      await ctx.reply(text);
    }
    await ctx.reply('End of notifications.', mainKeyboard());
  } catch (e) {
    console.error('handleNotificationsCommand err', e);
    await ctx.reply('Could not fetch notifications.');
  }
}

// build inline actions for a comment
async function buildActionsInline(commentId, userId) {
  const reactionCounts = await getReactionCounts(commentId).catch(()=>({ heart:0, laugh:0, dislike:0 }));
  let isFav = false;
  try { isFav = (dbapi && dbapi.isFavorite) ? await dbapi.isFavorite(userId, commentId) : false; } catch (e) { console.error('isFavorite check err', e && e.message); }
  const favLabel = isFav ? '★ Favorite' : '☆ Favorite';
  const row1 = [
    Markup.button.callback(`❤️ ${reactionCounts.heart||0}`, `react|${commentId}|heart`),
    Markup.button.callback(`😂 ${reactionCounts.laugh||0}`, `react|${commentId}|laugh`),
    Markup.button.callback(`👎 ${reactionCounts.dislike||0}`, `react|${commentId}|dislike`)
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

// show replies for a comment (safe)
async function showRepliesForComment(ctx, commentId, page = 1, perPage = 10) {
  try {
    const raw = await listReplies(commentId);
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
        [Markup.button.callback('🚩 Report reply', `report_reply|${r.id}`), Markup.button.callback('🗑 Delete reply', `delete_reply|${r.id}`)]
      ]);
      if (r.telegram_file_id && !r.reply_text) {
        await ctx.replyWithVoice(r.telegram_file_id, { caption: `↳ ${r.replier_first_name || r.replier_username || 'User'}` });
        await ctx.reply('Reply options:', inline);
      } else if (r.reply_text) {
        await ctx.reply(`↳ ${r.replier_first_name || r.replier_username || 'User'}: ${r.reply_text}`);
        await ctx.reply('Reply options:', inline);
      } else {
        await ctx.reply(`↳ ${r.replier_first_name || r.replier_username || 'User'}`);
        await ctx.reply('Reply options:', inline);
      }
    }

    if (rows.length > start + chunk.length) {
      const next = page + 1;
      await ctx.reply('More replies:', Markup.inlineKeyboard([[Markup.button.callback('More replies', `list_replies|${commentId}|${next}`)]]));
    }
  } catch (e) {
    console.error('showRepliesForComment err', e);
    await ctx.reply('Error listing replies.');
  }
}

// send comments page (listen)
async function sendCommentsPage(ctx, threadId, offset = 0, limit = 15) {
  try {
    if (!(await isUsingSupabase())) return ctx.reply('Persistence unavailable (DB unreachable).');

    const res = await listCommentsByThread(threadId, offset, limit).catch(()=>({ data: [] }));
    const rows = (res && res.data) ? res.data : (Array.isArray(res) ? res : []);
    if (!rows || rows.length === 0) return ctx.reply('No comments yet for that video.');

    for (const c of rows) {
      const inline = await buildActionsInline(c.id, ctx.from.id);
      if (c.telegram_file_id) {
        try { await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${new Date(c.created_at).toLocaleString()}` }); } catch (e) { console.error('replyWithVoice err', e); }
      } else {
        await ctx.reply('Comment (no voice stored).');
      }
      await ctx.reply(utils.encodeShortCode(c.id), inline);
    }
    return;
  } catch (e) {
    console.error('sendCommentsPage error', e);
    return ctx.reply('Error while fetching comments.');
  }
}

// show favorites
async function showFavoritesCommand(ctx) {
  try {
    if (!(await isUsingSupabase())) return ctx.reply('Persistence unavailable (DB unreachable).');
    const rows = await listFavoritesForUser(ctx.from.id).catch(()=>[]);
    if (!rows || rows.length === 0) return ctx.reply('No favorites yet.', mainKeyboard());
    for (const c of rows) {
      if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${new Date(c.created_at).toLocaleString()}` });
      else await ctx.reply('Favorite comment (no voice stored).');
      const inline = await buildActionsInline(c.id, ctx.from.id);
      await ctx.reply(utils.encodeShortCode(c.id), inline);
      const thr = await getThreadById(c.thread_id).catch(()=>null);
      if (thr) await ctx.reply(`Video: ${thr.social_link || thr.canonical_link || '(unknown)'}`);
    }
    await ctx.reply('End of favorites.', mainKeyboard());
  } catch (e) { console.error('showFavoritesCommand err', e); await ctx.reply('Could not fetch favorites.'); }
}

// handle my comments (list)
async function handleMyComments(ctx) {
  try {
    if (!(await isUsingSupabase())) return ctx.reply('Persistence unavailable (DB unreachable).');
    const rows = await listCommentsByUser(ctx.from.id);
    if (!rows || rows.length === 0) return ctx.reply('You have no comments yet.');
    for (const c of rows) {
      const inline = await buildActionsInline(c.id, ctx.from.id);
      if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'You'} • ${new Date(c.created_at).toLocaleString()}` });
      else await ctx.reply('Comment: (no voice saved)');
      await ctx.reply(utils.encodeShortCode(c.id), inline);
      const thr = await getThreadById(c.thread_id).catch(()=>null);
      if (thr) await ctx.reply(`Video: ${thr.social_link || thr.canonical_link || '(unknown)'}`);
    }
    await ctx.reply('End of your comments.', mainKeyboard());
  } catch (e) { console.error('handleMyComments err', e); await ctx.reply('Could not fetch your comments.'); }
}

// helper: notify admins
async function notifyAdmins(bot, text, extra = {}) {
  try {
    if (dbapi && dbapi.setAdminNotifier) {
      try { await dbapi.setAdminNotifier(text, extra); } catch (e) {}
    }
    for (const adm of ADMIN_IDS) {
      try { await bot.telegram.sendMessage(Number(adm), text); } catch (e) { console.error('notify admin err', e && e.message); }
    }
  } catch (e) { console.error('notifyAdmins err', e && e.message); }
}

// create payment request flow (used after confirm)
async function createPaymentRequestFlow(ctx, pkg, bot) {
  try {
    const created = await createPaymentRequest({
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

    await ctx.replyWithMarkdown(bankText).catch(()=>ctx.reply(bankText));
    await ctx.reply('Payment options:', inline);

    // notify admins
    (async () => {
      for (const adm of ADMIN_IDS) {
        try {
          const uname = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || `${ctx.from.id}`);
          await bot.telegram.sendMessage(Number(adm), `🆕 New payment request #${pid} by ${ctx.from.id} (${uname}) — ${pkg.label}\nAmount: ${pkg.amount} ETB`).catch(()=>{});
        } catch (err) { /* ignore */ }
      }
    })();

    return;
  } catch (e) {
    console.error('createPaymentRequestFlow err', e);
    await ctx.reply('Could not create payment request. Please contact support.');
    return;
  }
}

// ---------------------- init bot ----------------------
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

  // admin: db mode check
  bot.command('dbmode', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only');
    try {
      const using = (dbapi && typeof dbapi.isUsingSupabase === 'function' && dbapi.isUsingSupabase()) ? 'supabase' : 'memory (fallback)';
      return ctx.reply(`DB mode: ${using}`);
    } catch (e) {
      console.error('/dbmode err', e);
      return ctx.reply('Could not determine DB mode.');
    }
  });

  // notifications command uses defined handler
  bot.command('notifications', handleNotificationsCommand);

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

  bot.command('reports', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only');
    try {
      const rows = await (dbapi && dbapi.listReports ? dbapi.listReports({ status: 'open' }) : []).catch(()=>[]);
      if (!rows || rows.length === 0) return ctx.reply('No open reports.');
      for (const r of rows.slice(0, 30)) {
        const summary = `Report #${r.id} • ${r.status}\nReporter: ${r.reporter_username || r.reporter_telegram_id}\nTarget comment: ${r.comment_id || r.reply_id || '(none)'}\nReason: ${r.reason || '(no reason)'}\nCreated: ${r.created_at ? new Date(r.created_at).toLocaleString() : '(unknown)'}`;
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

  bot.command('balance', async (ctx) => {
    const bal = await getUserBalance(ctx.from.id);
    return ctx.reply(`Your available comments: *${bal}*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard().reply_markup });
  });

  bot.command('favorites', async (ctx) => showFavoritesCommand(ctx));

  bot.command('my', handleMyComments);

  // text handler
  bot.on('text', async (ctx) => {
    const textRaw = (ctx.message && ctx.message.text) || '';
    const text = utils.normalizeInput(textRaw);
    const uid = ctx.from && ctx.from.id;
    let p = PendingMap.get(uid);

    // cancel pending on keyboard action or slash commands
    const keyboardLabels = [
      '🎥 add comment','➕ add my video','🔖 track video','🎧 listen comments',
      '💬 my comments','🔎 search','⭐ favorites','🔔 notifications','🛒 buy','🆘 support','💰 balance'
    ];
    const nlower = normalizeKbLabel(text);
    const isSlash = (textRaw || '').trim().startsWith('/');
    const isCancel = ['cancel','ignore','back','exit'].includes((textRaw||'').trim().toLowerCase());
    if (isSlash || isCancel || keyboardLabels.includes(nlower)) {
      if (p) { PendingMap.delete(uid); p = null; }
    }

    // Keyboard choices
    if (nlower === normalizeKbLabel('🎥 add comment')) {
      PendingMap.set(uid, { type: 'create_thread_public' });
      return ctx.reply('Send TikTok/YouTube link for which you want to add a comment (or press a tracked video).');
    }
    if (nlower === normalizeKbLabel('➕ add my video')) {
      PendingMap.set(uid, { type: 'create_thread_owned' });
      return ctx.reply('Send the link of your video to track it (we will notify you when comments arrive).');
    }
    if (nlower === normalizeKbLabel('🔖 track video')) {
      try {
        if (!(await isUsingSupabase())) return ctx.reply('Persistence unavailable (DB unreachable).');
        const rows = await listThreadsByCreator(ctx.from.id);
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
    if (nlower === normalizeKbLabel('🎧 listen comments')) {
      PendingMap.set(uid, { type: 'listen_prompt' });
      return ctx.reply('Send a TikTok/YouTube link or click a tracked video to listen comments.');
    }
    if (nlower === normalizeKbLabel('💬 my comments')) {
      return handleMyComments(ctx);
    }
    if (nlower === normalizeKbLabel('⭐ favorites')) {
      return showFavoritesCommand(ctx);
    }
    if (nlower === normalizeKbLabel('🔎 search')) {
      PendingMap.set(uid, { type: 'search_prompt' });
      return ctx.reply('Send the short code (e.g. 0000A9) or use /search CODE.');
    }
    if (nlower === normalizeKbLabel('🔔 notifications')) {
      return handleNotificationsCommand(ctx);
    }
    if (nlower === normalizeKbLabel('🛒 buy')) {
      const inline = PAYMENT_PACKAGES.map((p, idx) => [Markup.button.callback(p.label, `buypkg|${idx}`)]);
      inline.push([Markup.button.callback('Contact support (WhatsApp)', 'contact_whatsapp')]);
      return ctx.reply('Choose a package:', Markup.inlineKeyboard(inline));
    }
    if (nlower === normalizeKbLabel('🆘 support')) {
      return ctx.telegram.sendMessage(ctx.chat.id, `Support:\nContact admin on WhatsApp: ${WHATSAPP_LINK}\nOr use /support to get options.`).catch(()=>{});
    }
    if (nlower === normalizeKbLabel('💰 balance')) {
      const bal = await getUserBalance(ctx.from.id).catch(()=>0);
      return ctx.reply(`Your available comments: *${bal}*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard().reply_markup });
    }

    // direct link handling -> create thread
    const maybeUrl = utils.extractFirstUrl(textRaw) || (utils.isSupportedLink(textRaw) ? textRaw : null);
    if (maybeUrl) {
      try {
        await ensureUserRow(ctx.from).catch(()=>null);
        const creatorId = (p && p.type === 'create_thread_owned') ? ctx.from.id : null;
        const t = await findOrCreateThread(maybeUrl, creatorId);
        if (!t || !t.id) {
          return ctx.reply('Thread created (fallback). Try listening again with the same link.', mainKeyboard());
        }
        if (creatorId && t && t.id) {
          try { if (dbapi && dbapi.setThreadCreator) await dbapi.setThreadCreator(t.id, creatorId); } catch (e) {}
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

    return ctx.reply(`Hi ${ctx.from.first_name || ''}! I didn't detect a supported link. Press a button or send a TikTok/YouTube URL.`, mainKeyboard());
  });

  // voice handler
  bot.on('voice', async (ctx) => {
    const uid = ctx.from.id;
    const p = PendingMap.get(uid);

    if (!p) return ctx.reply('No pending action for voice. Use the keyboard to choose an action.', mainKeyboard());

    if ((p.type === 'reply_choice' || p.type === 'reply_voice') && p.commentId) {
      PendingMap.delete(uid);
      try {
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found in message.');
        const insert = await insertReplyRow({
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
          const comment = await getCommentById(p.commentId);
          if (comment && comment.telegram_id && comment.telegram_id !== uid) {
            const short = utils.encodeShortCode(p.commentId);
            const threadRow = await getThreadById(comment.thread_id);
            const videoLink = threadRow ? threadRow.social_link : '(video unknown)';
            const text = `${ctx.from.first_name || ctx.from.username} replied to your comment.\n${short}\nVideo: ${videoLink}`;
            await addNotificationRow({ telegram_id: comment.telegram_id, type: 'reply', message: text, meta: { comment_id: p.commentId } }).catch(()=>null);
            try { await bot.telegram.sendMessage(comment.telegram_id, text); } catch (_) {}
          }
        } catch (e) { console.error('notify owner reply voice err', e); }

        return;
      } catch (e) {
        console.error('reply_voice handler error', e);
        return ctx.reply('Could not save voice reply.');
      }
    }

    if (p.type === 'add_comment' && p.threadId) {
      PendingMap.delete(uid);
      try {
        if (!(await isUsingSupabase())) return ctx.reply('Cannot save comment: persistence unavailable (DB unreachable).');

        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found.');
        const insert = await insertVoiceComment({
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

        // decrement balance best-effort
        try {
          const dec = await decrementUserBalance(uid, 1).catch(err => ({ error: err && err.message }));
          if (dec && dec.error) {
            console.error('decrementUserBalance reported error', dec);
            try { await ctx.reply('Note: could not decrement your balance (admin will review).'); } catch (_) {}
          }
        } catch (e) { console.error('decrementUserBalance err', e); }

        // notify tracked owner if any
        try {
          const threadRow = await getThreadById(p.threadId);
          if (threadRow && threadRow.creator_telegram_id && threadRow.creator_telegram_id !== uid) {
            const notif = `🔔 New voice comment on your tracked video by ${ctx.from.first_name || ctx.from.username}\nVideo: ${threadRow.social_link}\nCode: ${code}`;
            await addNotificationRow({ telegram_id: threadRow.creator_telegram_id, type: 'reply', message: notif, meta: { thread_id: p.threadId, comment_id: savedId } }).catch(()=>null);
            try { await bot.telegram.sendMessage(threadRow.creator_telegram_id, notif); } catch (_) {}
          }
        } catch (e) { console.error('notify tracked owner err', e); }

        return;
      } catch (e) {
        console.error('add_comment voice save error', e);
        return ctx.reply('Could not save voice comment (DB error).');
      }
    }

    return ctx.reply('No expected action for voice now.', mainKeyboard());
  });

  // photo handler (upload proof)
  bot.on('photo', async (ctx) => {
    const uid = ctx.from.id;
    const p = PendingMap.get(uid);
    if (!p) return ctx.reply('Photo received but no pending action. Use the keyboard or commands.');

    if (p.type === 'upload_payproof' && p.paymentId) {
      PendingMap.delete(uid);
      try {
        const photos = ctx.message.photo || [];
        const largest = photos[photos.length - 1];
        const fileId = largest && largest.file_id;
        const upd = await updatePaymentStatus(p.paymentId, 'proof_submitted', { proof_telegram_file_id: fileId });
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

      // reaction handling
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
          } catch (e) { /* ignore UI update errors */ }
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
          const result = await toggleFavoriteRow(ctx.from.id, commentId);
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
        return ctx.reply('Reply options:\n• Send voice to add voice reply\n• Send text to add text reply\n(Your next message will be used)');
      }

      if (cmd === 'replytext' || cmd === 'replytext_alt') {
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

      if (cmd === 'report') {
        const commentId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'report_reason', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain why you report this comment. Send a short message describing the issue.');
      }

      if (cmd === 'delete_comment') {
        const commentId = Number(parts[1]);
        try {
          const r = await (dbapi && dbapi.deleteCommentById ? dbapi.deleteCommentById(commentId) : null);
          if (r && r.error) throw r.error;
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
          const r = await (dbapi && dbapi.deleteReplyById ? dbapi.deleteReplyById(replyId) : null);
          if (r && r.error) throw r.error;
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
          const r = await (dbapi && dbapi.deleteThreadById ? dbapi.deleteThreadById(threadId) : null);
          if (r && r.error) throw r.error;
          await ctx.answerCbQuery('Tracked video deleted');
          return ctx.reply('Tracked video removed.');
        } catch (e) {
          console.error('delete_thread err', e);
          await ctx.answerCbQuery('Could not delete tracked video.');
          return;
        }
      }

      // BUY flow
      if (cmd === 'buypkg') {
        const idx = Number(parts[1]);
        const pkg = PAYMENT_PACKAGES[idx];
        if (!pkg) { await ctx.answerCbQuery('Invalid package'); return; }
        const inline = Markup.inlineKeyboard([
          [Markup.button.callback(`Confirm: ${pkg.label}`, `confirm_buy|${idx}`), Markup.button.callback('Cancel', `cancel_buy|${idx}`)]
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

      if (cmd === 'admin_approve') {
        const paymentId = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          const payment = await getPaymentById(paymentId);
          if (!payment) { await ctx.answerCbQuery('Not found'); return; }
          if (payment.status === 'approved') { await ctx.answerCbQuery('Already approved'); return; }
          await updatePaymentStatus(paymentId, 'approved');
          const credits = Number(payment.comments_amount || 0) || 0;
          try {
            await creditUser(payment.telegram_id, credits);
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
          const payment = await getPaymentById(paymentId);
          if (!payment) { await ctx.answerCbQuery('Not found'); return; }
          await updatePaymentStatus(paymentId, 'rejected');
          await ctx.answerCbQuery('Payment rejected');
          try { await bot.telegram.sendMessage(payment.telegram_id, `Your payment #${paymentId} was rejected. Contact admin.`); } catch (_) {}
          return;
        } catch (e) {
          console.error('admin_reject err', e);
          await ctx.answerCbQuery('Error rejecting payment');
          return;
        }
      }

      if (cmd === 'contact_whatsapp') {
        await ctx.answerCbQuery();
        return ctx.reply(`Contact admin: ${WHATSAPP_LINK}`);
      }

      // admin actions: view_report, admin_delete_comment, admin_delete_reply, admin_ignore_report
      if (cmd === 'view_report') {
        const rid = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        const r = await (dbapi && dbapi.getReportById ? dbapi.getReportById(rid) : null);
        if (!r) { await ctx.answerCbQuery('Not found'); return; }
        const detail = `Report #${r.id}\nStatus: ${r.status}\nReporter: ${r.reporter_username || r.reporter_telegram_id}\nTarget comment: ${r.comment_id || ''}\nTarget reply: ${r.reply_id || ''}\nReason: ${r.reason || '(none)'}\nCreated: ${r.created_at ? new Date(r.created_at).toLocaleString() : '(unknown)'}`;
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
          const r = await (dbapi && dbapi.deleteCommentById ? dbapi.deleteCommentById(commentId) : null);
          if (r && r.error) throw r.error;
          await ctx.answerCbQuery('Comment deleted');
          await ctx.reply(`Comment #${commentId} deleted by admin.`);
          return;
        } catch (e) {
          console.error('admin_delete_comment err', e);
          await ctx.answerCbQuery('Could not delete comment');
          return;
        }
      }

      if (cmd === 'resolve_report' || cmd === 'admin_ignore_report') {
        const rid = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          if (dbapi && dbapi.deleteReport) await dbapi.deleteReport(rid).catch(()=>null);
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

  // helper: decode code and show comment
  async function handleSearchByCode(ctx, code) {
    try {
      const id = utils.decodeShortCode((code || '').toUpperCase());
      if (!id) return ctx.reply('Invalid code.');
      const comment = await getCommentById(id);
      if (!comment) return ctx.reply('No voice found for that code.');
      if (comment.telegram_file_id) {
        try { await ctx.replyWithVoice(comment.telegram_file_id, { caption: `${comment.first_name || comment.username || 'User'} • ${new Date(comment.created_at).toLocaleString()}` }); } catch (e) {}
      } else {
        await ctx.reply('Comment found but no voice stored.');
      }
      const inline = await buildActionsInline(comment.id, ctx.from.id);
      const thread = await getThreadById(comment.thread_id);
      const videoLink = thread ? thread.social_link : '(video unknown)';
      await ctx.reply(`Video: ${videoLink}`, inline);
    } catch (e) { console.error('handleSearchByCode error', e); await ctx.reply('Search failed.'); }
  }

  return bot;
}

module.exports = { initBot };
