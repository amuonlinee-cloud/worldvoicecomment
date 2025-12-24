// src/bot.js
// Full merged bot: old working logic + link normalization + DB fallback
const { Telegraf, Markup } = require('telegraf');

// tiny logger
const log = (...args) => console.log('[bot]', ...args);

// Defensive requires
let db;
try { db = require('./database'); } catch (e) { console.error('[bot] could not load database module:', e && e.message); db = null; }
let utils;
try { utils = require('./utils'); } catch (e) { console.error('[bot] could not load utils module:', e && e.message); utils = null; }

// Environment and admin config
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const WHATSAPP_ADMIN = (process.env.WHATSAPP_ADMIN || '').replace(/\D/g, '') || '';
const WHATSAPP_LINK = WHATSAPP_ADMIN ? `https://wa.me/${WHATSAPP_ADMIN}` : 'https://wa.me/';

// Payment packages
const PAYMENT_PACKAGES = [
  { key: 'pkg_25_12', label: '25 comments — 12 ETB', credits: 25, amount: 12 },
  { key: 'pkg_60_27', label: '60 comments — 27 ETB', credits: 60, amount: 27 },
  { key: 'pkg_130_49', label: '130 comments — 49 ETB', credits: 130, amount: 49 },
  { key: 'pkg_240_89', label: '240 comments — 89 ETB', credits: 240, amount: 89 },
];

// fallback utils if module missing
if (!utils) {
  utils = {
    normalizeInput: s => (s || '').toString().trim(),
    extractFirstUrl: text => {
      if (!text) return null;
      const m = String(text).match(/\bhttps?:\/\/[^\s)]+/i);
      return m ? m[0].replace(/[),.]+$/,'') : null;
    },
    encodeShortCode: id => {
      if (!id && id !== 0) return '';
      return (Number(id) || 0).toString(36).toUpperCase().padStart(6,'0');
    },
    decodeShortCode: code => {
      if (!code) return null;
      try { return parseInt(String(code).replace(/[^0-9A-Za-z]/g,'').toLowerCase(), 36); } catch(e) { return null; }
    },
    normalizeVideoUrl: async (link) => ({ canonicalLink: link, provider: null, id: null, thumbnail: null }),
    isSupportedLink: s => !!s && /\b(tiktok\.com|vm\.tiktok\.com|youtube\.com|youtu\.be)\b/i.test(s)
  };
}

// DB safe helpers (use db if available, otherwise warn and fallback in-memory is inside database.js)
const DB = db || null;
async function ensureUserRow(u) { if (DB && DB.ensureUserRow) return DB.ensureUserRow(u); return null; }
async function getUserBalance(uid) { if (DB && DB.getUserBalance) return DB.getUserBalance(uid); return 0; }
async function creditUser(uid, amount) { if (DB && DB.creditUser) return DB.creditUser(uid, amount); throw new Error('DB not available'); }
async function decrementUserBalance(uid, amount) { if (DB && DB.decrementUserBalance) return DB.decrementUserBalance(uid, amount); throw new Error('DB not available'); }
async function findOrCreateThread(link, creator) { if (DB && DB.findOrCreateThread) return DB.findOrCreateThread(link, creator); if (DB && DB.createThread) return DB.createThread(link, creator); return { id: Date.now(), social_link: link, canonical_link: link }; }
async function getThreadByLink(link) { if (DB && DB.getThreadByLink) return DB.getThreadByLink(link); return null; }
async function getThreadById(id) { if (DB && DB.getThreadById) return DB.getThreadById(id); return null; }
async function listThreadsByCreator(uid) { if (DB && DB.listThreadsByCreator) return DB.listThreadsByCreator(uid); return []; }
async function insertVoiceComment(payload) { if (DB && DB.insertVoiceComment) return DB.insertVoiceComment(payload); throw new Error('DB not available'); }
async function listCommentsByThread(threadId, offset=0, limit=15) { if (DB && DB.listCommentsByThread) return DB.listCommentsByThread(threadId, offset, limit); return { data: [] }; }
async function listCommentsByUser(uid) { if (DB && DB.listCommentsByUser) return DB.listCommentsByUser(uid); return []; }
async function getCommentById(id) { if (DB && DB.getCommentById) return DB.getCommentById(id); return null; }
async function insertReplyRow(payload) { if (DB && DB.insertReplyRow) return DB.insertReplyRow(payload); throw new Error('DB not available'); }
async function listReplies(commentId) { if (DB && DB.listReplies) return DB.listReplies(commentId); return []; }
async function toggleFavorite(telegramId, commentId) { if (DB && DB.toggleFavoriteRow) return DB.toggleFavoriteRow(telegramId, commentId); return { removed: false }; }
async function isFavorite(telegramId, commentId) { if (DB && DB.isFavorite) return DB.isFavorite(telegramId, commentId); return false; }
async function listFavoritesForUser(uid) { if (DB && DB.listFavoritesForUser) return DB.listFavoritesForUser(uid); return []; }
async function toggleReaction(telegramId, commentId, type) { if (DB && DB.toggleReaction) return DB.toggleReaction(telegramId, commentId, type); return null; }
async function getReactionCounts(commentId) { if (DB && DB.getReactionCounts) return DB.getReactionCounts(commentId); return { heart:0, laugh:0, dislike:0 }; }
async function createPaymentRequest(payload) { if (DB && DB.createPaymentRequest) return DB.createPaymentRequest(payload); return null; }
async function getPaymentById(id) { if (DB && DB.getPaymentById) return DB.getPaymentById(id); return null; }
async function updatePaymentStatus(id, status, updates={}) { if (DB && DB.updatePaymentStatus) return DB.updatePaymentStatus(id, status, updates); return null; }
async function addNotificationRow(payload) { if (DB && DB.addNotificationRow) return DB.addNotificationRow(payload); return null; }
async function listNotifications(telegramId) { if (DB && DB.listNotifications) return DB.listNotifications(telegramId); return { data: [] }; }
async function isUsingSupabase() { if (DB && typeof DB.isUsingSupabase === 'function') return DB.isUsingSupabase(); return false; }

// Pending actions map
const PendingMap = new Map();

// Keyboards
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

// Short code helpers
function shortEncode(id) { return utils.encodeShortCode ? utils.encodeShortCode(id) : String(id); }
function shortDecode(code) { return utils.decodeShortCode ? utils.decodeShortCode(code) : null; }

// Build inline actions for comment messages
async function buildActionsInline(commentId, userId) {
  const counts = await getReactionCounts(commentId).catch(()=>({ heart:0,laugh:0,dislike:0 }));
  const fav = await isFavorite(userId, commentId).catch(()=>false);
  const favLabel = fav ? '★ Favorite' : '☆ Favorite';
  const row1 = [
    Markup.button.callback(`❤️ ${counts.heart||0}`, `react|${commentId}|heart`),
    Markup.button.callback(`😂 ${counts.laugh||0}`, `react|${commentId}|laugh`),
    Markup.button.callback(`👎 ${counts.dislike||0}`, `react|${commentId}|dislike`),
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

// Send comments (listen)
async function sendCommentsPage(ctx, threadId, offset = 0, limit = 15) {
  try {
    if (!(await isUsingSupabase())) return ctx.reply('Persistence unavailable (DB unreachable).');
    const res = await listCommentsByThread(threadId, offset, limit).catch(()=>({ data: [] }));
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
    console.error('sendCommentsPage error', e && (e.stack || e.message));
    await ctx.reply('Error while fetching comments.');
  }
}

// Show favorites
async function showFavoritesCommand(ctx) {
  try {
    if (!(await isUsingSupabase())) return ctx.reply('Persistence unavailable (DB unreachable).');
    const rows = await listFavoritesForUser(ctx.from.id);
    if (!rows || rows.length === 0) return ctx.reply('No favorites yet.', mainKeyboard());
    for (const c of rows) {
      if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${new Date(c.created_at).toLocaleString()}` });
      else await ctx.reply('Favorite comment (no voice).');
      await ctx.reply(shortEncode(c.id), await buildActionsInline(c.id, ctx.from.id));
      const thr = await getThreadById(c.thread_id);
      if (thr) await ctx.reply(`Video: ${thr.social_link || thr.canonical_link || '(unknown)'}`);
    }
    await ctx.reply('End of favorites.', mainKeyboard());
  } catch (e) {
    console.error('showFavoritesCommand err', e && e.message);
    await ctx.reply('Could not fetch favorites.');
  }
}

// Handle My Comments
async function handleMyComments(ctx) {
  try {
    if (!(await isUsingSupabase())) return ctx.reply('Persistence unavailable (DB unreachable).');
    const rows = await listCommentsByUser(ctx.from.id);
    if (!rows || rows.length === 0) return ctx.reply('You have no comments yet.');
    for (const c of rows) {
      const inline = await buildActionsInline(c.id, ctx.from.id);
      if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'You'} • ${new Date(c.created_at).toLocaleString()}` });
      else await ctx.reply('Comment (no voice).');
      await ctx.reply(shortEncode(c.id), inline);
      const thr = await getThreadById(c.thread_id);
      if (thr) await ctx.reply(`Video: ${thr.social_link || thr.canonical_link || '(unknown)'}`);
    }
    await ctx.reply('End of your comments.', mainKeyboard());
  } catch (e) {
    console.error('handleMyComments err', e && e.message);
    await ctx.reply('Could not fetch your comments.');
  }
}

async function handleNotificationsCommand(ctx) {
  try {
    if (!(await isUsingSupabase())) return ctx.reply('Persistence unavailable (DB unreachable).');
    const res = await listNotifications(ctx.from.id).catch(()=>({ data: [] }));
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

// Payment flow: create request and show copy/paste options immediately
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
      console.error('createPaymentRequest (bg) err', err && (err.message || err));
      return null;
    });

    const requestRow = created && (created.data || created) ? (created.data || created) : null;
    const pid = requestRow && requestRow.id ? requestRow.id : Math.floor(Math.random() * 100000);

    const telebirr = '0962058608';
    const cbeAcc = '1000555367884';
    const bankText = `*Payment details*\n\nTELEBIRR: \`${telebirr}\`\nCBE Account: \`${cbeAcc}\`\n\nAmount: *${pkg.amount} ETB*\nRequest ID: ${pid}\n\nAfter payment press "Upload Proof" below then send the screenshot/photo or paste the payment link.`;

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
        } catch (err) {}
      }
    })();

  } catch (e) {
    console.error('createPaymentRequestFlow err', e && e.message);
    await ctx.reply('Could not create payment request. Please contact support.');
  }
}

// admin search comment by code
async function adminSearchCommentByCode(ctx, code) {
  try {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only');
    const id = shortDecode(code);
    if (!id) return ctx.reply('Invalid code.');
    const comment = await getCommentById(id);
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

// isAdmin
function isAdmin(id) {
  if (!id) return false;
  return ADMIN_IDS.map(Number).includes(Number(id));
}

// Bot init
async function initBot() {
  if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in environment');
  const bot = new Telegraf(BOT_TOKEN);

  // start
  bot.start(async (ctx) => {
    try {
      await ensureUserRow(ctx.from).catch(()=>null);
      const bal = await getUserBalance(ctx.from.id).catch(()=>0);
      await ctx.reply(`Welcome to World Voice Comment!\nYou have *${bal}* available comments.`, { parse_mode: 'Markdown' });
      await ctx.reply('Send a TikTok or YouTube link or use the keyboard below.', mainKeyboard());
    } catch (e) {
      console.error('start err', e && e.message);
      try { await ctx.reply('Welcome — init error logged.'); } catch (_) {}
    }
  });

  // simple commands
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
    const bal = await getUserBalance(ctx.from.id).catch(()=>0);
    return ctx.reply(`Your available comments: *${bal}*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard().reply_markup });
  });
  bot.command('favorites', async (ctx) => showFavoritesCommand(ctx));
  bot.command('my', async (ctx) => handleMyComments(ctx));
  bot.command('reportsearch', async (ctx) => {
    const parts = (ctx.message.text || '').split(/\s+/).slice(1);
    if (!parts.length) return ctx.reply('Usage: /reportsearch <CODE>');
    return adminSearchCommentByCode(ctx, parts[0]);
  });

  // text handler
  bot.on('text', async (ctx) => {
    const textRaw = (ctx.message && ctx.message.text) || '';
    const text = utils.normalizeInput ? utils.normalizeInput(textRaw) : (textRaw||'').toString().trim();
    const uid = ctx.from && ctx.from.id;
    let p = PendingMap.get(uid);

    // cancel pending if user hits a keyboard label
    const keyboardLabels = [
      '🎥 add comment','➕ add my video','🔖 track video','🎧 listen comments',
      '💬 my comments','🔎 search','⭐ favorites','🔔 notifications','🛒 buy','🆘 support','💰 balance'
    ];
    const labelLower = (text || '').toString().trim().toLowerCase();
    if (keyboardLabels.includes(labelLower)) {
      if (p) { PendingMap.delete(uid); p = null; }
    }

    // keyboard command handlers
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
        if (!(await isUsingSupabase())) return ctx.reply('Persistence unavailable (DB unreachable).');
        const rows = await listThreadsByCreator(ctx.from.id);
        if (!rows || rows.length === 0) return ctx.reply('You have no tracked videos.');
        for (const t of rows) {
          const thumb = t.thumbnail || (t.provider && t.provider.includes('youtube') && t.provider_id ? `https://img.youtube.com/vi/${t.provider_id}/hqdefault.jpg` : null);
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
      const bal = await getUserBalance(ctx.from.id).catch(()=>0);
      return ctx.reply(`Your available comments: *${bal}*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard().reply_markup });
    }

    // URL detection -> create thread / listening
    const maybeUrl = utils.extractFirstUrl ? utils.extractFirstUrl(textRaw) : null;
    if (maybeUrl) {
      try {
        await ensureUserRow(ctx.from).catch(()=>null);
        const creatorId = (p && p.type === 'create_thread_owned') ? ctx.from.id : null;
        const t = await findOrCreateThread(maybeUrl, creatorId);
        if (!t || !t.id) {
          return ctx.reply('Thread created (fallback). Try listening again with the same link.', mainKeyboard());
        }
        if (creatorId && t && t.id) {
          try { if (DB && DB.setThreadCreator) await DB.setThreadCreator(t.id, creatorId); } catch (_) {}
        }
        const thumb = t.thumbnail || (t.provider && t.provider.includes('youtube') && t.provider_id ? `https://img.youtube.com/vi/${t.provider_id}/hqdefault.jpg` : null);
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('🎙 Add Voice Comment', `addvoice|${t.id}`), Markup.button.callback('🎧 Listen Comments', `listen|${t.id}|1`) ]
        ]);
        if (thumb) await ctx.replyWithPhoto(thumb, { caption: `Thread created for: ${t.social_link || t.canonical_link || maybeUrl}`, reply_markup: inline.reply_markup });
        else await ctx.reply(`Thread created for: ${t.social_link || t.canonical_link || maybeUrl}`, inline);
        return;
      } catch (e) {
        console.error('direct create thread error', e && e.message);
        return ctx.reply('Error creating thread for that link.');
      }
    }

    // pending search prompt handling
    const pend = PendingMap.get(uid);
    if (pend && pend.type === 'search_prompt') {
      PendingMap.delete(uid);
      return handleSearchByCode(ctx, textRaw.trim());
    }

    return ctx.reply(`I didn't detect a supported link. Press a button or send a TikTok/YouTube URL.`, mainKeyboard());
  });

  // voice handler for adding comments and replies
  bot.on('voice', async (ctx) => {
    const uid = ctx.from.id;
    const p = PendingMap.get(uid);
    if (!p) return ctx.reply('No pending action for voice. Use the keyboard to choose an action.', mainKeyboard());

    // reply voice
    if ((p.type === 'reply_choice' || p.type === 'reply_voice') && p.commentId) {
      PendingMap.delete(uid);
      try {
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found in message.');
        await insertReplyRow({
          comment_id: p.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id,
          duration: voice.duration || 0,
          created_at: new Date().toISOString()
        });
        await ctx.replyWithVoice(voice.file_id, { caption: `↳ Reply by ${ctx.from.first_name || ctx.from.username}` });

        // notify comment owner
        try {
          const comment = await getCommentById(p.commentId);
          if (comment && comment.telegram_id && comment.telegram_id !== uid) {
            const code = shortEncode(p.commentId);
            const threadRow = await getThreadById(comment.thread_id);
            const videoLink = threadRow ? threadRow.social_link : '(video unknown)';
            const text = `${ctx.from.first_name || ctx.from.username} replied to your comment.\n${code}\nVideo: ${videoLink}`;
            await addNotificationRow({ telegram_id: comment.telegram_id, type: 'reply', message: text, meta: { comment_id: p.commentId } }).catch(()=>null);
            try { await bot.telegram.sendMessage(comment.telegram_id, text); } catch (_) {}
          }
        } catch (e) { console.error('notify owner reply err', e && e.message); }

        return;
      } catch (e) {
        console.error('reply_voice handler error', e && (e.stack || e.message));
        return ctx.reply('Could not save voice reply.');
      }
    }

    // add comment to thread
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
        const row = insert && (insert.data || insert) ? (insert.data || insert) : null;
        const savedId = row && row.id ? row.id : null;
        const code = shortEncode(savedId || '');
        await ctx.reply('✅ Voice saved!');
        await ctx.reply(`${code}`, mainKeyboard());

        // decrement balance best-effort
        try {
          const dec = await decrementUserBalance(uid, 1).catch(err => ({ error: err && err.message }));
          if (dec && dec.error) {
            console.error('decrementUserBalance reported error', dec);
            try { await ctx.reply('Note: could not decrement your balance (admin will review).'); } catch (_) {}
          }
        } catch (e) { console.error('decrementUserBalance err', e && e.message); }

        // notify tracked owner
        try {
          const threadRow = await getThreadById(p.threadId);
          if (threadRow && threadRow.creator_telegram_id && threadRow.creator_telegram_id !== uid) {
            const notif = `🔔 New voice comment on your tracked video by ${ctx.from.first_name || ctx.from.username}\nVideo: ${threadRow.social_link}\nCode: ${code}`;
            await addNotificationRow({ telegram_id: threadRow.creator_telegram_id, type: 'reply', message: notif, meta: { thread_id: p.threadId, comment_id: savedId } }).catch(()=>null);
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

  // photo handler => upload proof
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
        const upd = await updatePaymentStatus(p.paymentId, 'proof_submitted', { proof_telegram_file_id: fileId });
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

  // callback_query handler
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

      // add voice
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
          console.error('react handler err', e && e.message);
          await ctx.answerCbQuery('Could not record reaction');
        }
        return;
      }

      // favorite toggle
      if (cmd === 'fav') {
        const commentId = Number(parts[1]);
        try {
          const result = await toggleFavorite(ctx.from.id, commentId);
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
        return (async () => {
          const rows = await listReplies(commentId);
          if (!rows || rows.length === 0) return ctx.reply('No replies yet.');
          const start = (page-1)*10;
          const chunk = rows.slice(start, start+10);
          for (const r of chunk) {
            if (r.telegram_file_id) await ctx.replyWithVoice(r.telegram_file_id, { caption: `↳ ${r.replier_first_name || r.replier_username || 'User'}` });
            else if (r.reply_text) await ctx.reply(`↳ ${r.replier_first_name || r.replier_username || 'User'}: ${r.reply_text}`);
            else await ctx.reply(`↳ ${r.replier_first_name || r.replier_username || 'User'}`);
          }
          if (rows.length > start + chunk.length) await ctx.reply('More replies available.');
        })();
      }

      // reply menu
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
          if (DB && DB.deleteCommentById) {
            const r = await DB.deleteCommentById(commentId);
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

      if (cmd === 'delete_thread') {
        const threadId = Number(parts[1]);
        try {
          if (DB && DB.deleteThreadById) {
            const r = await DB.deleteThreadById(threadId);
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

      // BUY flow
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
          const payment = await getPaymentById(paymentId);
          if (!payment) { await ctx.answerCbQuery('Not found'); return; }
          if (payment.status === 'approved') { await ctx.answerCbQuery('Already approved'); return; }
          await updatePaymentStatus(paymentId, 'approved').catch(()=>null);
          const credits = Number(payment.comments_amount || 0) || 0;
          try {
            await creditUser(payment.telegram_id, credits);
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
          await updatePaymentStatus(paymentId, 'rejected');
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

      await ctx.answerCbQuery();
    } catch (e) {
      console.error('callback_query top error', e && (e.stack || e.message));
      try { await ctx.answerCbQuery('Error handling button'); } catch (_) {}
    }
  });

  // text messages used for pending reply_text, report_reason, upload proof link
  bot.on('message', async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    const uid = ctx.from.id;
    const p = PendingMap.get(uid);
    if (!p) return;

    // reply text
    if (p.type === 'reply_text' && p.commentId) {
      PendingMap.delete(uid);
      try {
        await insertReplyRow({
          comment_id: p.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          reply_text: ctx.message.text,
          created_at: new Date().toISOString()
        });
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
        if (DB && DB.insertReport) {
          await DB.insertReport({
            reporter_telegram_id: uid,
            reporter_username: ctx.from.username || null,
            comment_id: p.commentId,
            reason: ctx.message.text,
            status: 'open',
            created_at: new Date().toISOString()
          });
        } else {
          // fallback: notify admins immediately
          for (const adm of ADMIN_IDS) {
            try {
              await bot.telegram.sendMessage(Number(adm), `🚨 Report: comment #${p.commentId}\nReporter: ${uid}\nReason: ${ctx.message.text}`);
            } catch (e) {}
          }
        }
        await ctx.reply('Report submitted. Admins will review.');
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendMessage(Number(adm), `🚨 New report for comment #${p.commentId}\nReporter: ${uid}\nReason: ${ctx.message.text}`); } catch (e) {}
        }
        return;
      } catch (e) {
        console.error('report_reason save err', e && e.message);
        return ctx.reply('Could not submit report.');
      }
    }

    // upload proof link
    if (p.type === 'upload_payproof' && p.paymentId) {
      PendingMap.delete(uid);
      try {
        const link = ctx.message.text.trim();
        await updatePaymentStatus(p.paymentId, 'proof_link_submitted', { proof_link: link });
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
  });

  bot.catch((err, ctx) => {
    console.error('Bot catch error', err && (err.stack || err.message), ctx && ctx.updateType);
  });

  return bot;
}

// helper search by code
async function handleSearchByCode(ctx, code) {
  try {
    const id = shortDecode((code || '').toUpperCase());
    if (!id) return ctx.reply('Invalid code.');
    const comment = await getCommentById(id);
    if (!comment) return ctx.reply('No voice found for that code.');
    if (comment.telegram_file_id) await ctx.replyWithVoice(comment.telegram_file_id, { caption: `${comment.first_name || comment.username || 'User'} • ${new Date(comment.created_at).toLocaleString()}` });
    else await ctx.reply('Comment found but no voice stored.');
    const inline = await buildActionsInline(comment.id, ctx.from.id);
    const thread = await getThreadById(comment.thread_id);
    const videoLink = thread ? thread.social_link : '(video unknown)';
    await ctx.reply(`Video: ${videoLink}`, inline);
  } catch (e) {
    console.error('handleSearchByCode err', e && e.message);
    await ctx.reply('Search failed.');
  }
}

module.exports = { initBot };
