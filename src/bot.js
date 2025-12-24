// src/bot.js
// Full bot implementation — use with src/database.js and src/utils.js
const { Telegraf, Markup } = require('telegraf');

// quick logger wrapper
const log = (...args) => console.log('[bot]', ...args);

// Try load database and utils
let DB = null;
try { DB = require('./database'); } catch (e) { console.error('[bot] could not load database module:', e && (e.message || e)); }
let utils = null;
try { utils = require('./utils'); } catch (e) { console.error('[bot] could not load utils module:', e && (e.message || e)); }

// Fallback simple utils (shouldn't be hit if src/utils.js exists)
if (!utils) {
  utils = {
    normalizeInput: s => (s||'').toString().trim(),
    extractFirstUrl: s => { if (!s) return null; const m = String(s).match(/\bhttps?:\/\/[^\s)]+/i); return m?m[0].replace(/[),.]+$/,''):null; },
    normalizeVideoUrl: async (link) => ({ canonicalLink: (link||'').toString().trim(), provider: null, id: null, thumbnail: null }),
    encodeShortCode: id => { try { return (Number(id)||0).toString(36).toUpperCase().padStart(6,'0'); } catch(e){return ''; } },
    decodeShortCode: code => { try { return parseInt(String(code).replace(/[^0-9A-Za-z]/g,'').toLowerCase(), 36); } catch(e) { return null; } },
    isSupportedLink: s => !!s && /\b(tiktok\.com|vm\.tiktok\.com|youtube\.com|youtu\.be)\b/i.test(s)
  };
}

// Database wrappers (call DB.* if available)
const db = {
  isUsingSupabase: async () => DB && DB.isUsingSupabase ? (await DB.isUsingSupabase()) : false,
  ensureUserRow: async u => DB && DB.ensureUserRow ? DB.ensureUserRow(u) : null,
  getUserBalance: async id => DB && DB.getUserBalance ? DB.getUserBalance(id) : 0,
  creditUser: async (id, amount) => DB && DB.creditUser ? DB.creditUser(id, amount) : null,
  decrementUserBalance: async (id, amount) => DB && DB.decrementUserBalance ? DB.decrementUserBalance(id, amount) : { error: 'db_missing' },
  findOrCreateThread: async (link, creator) => DB && DB.findOrCreateThread ? DB.findOrCreateThread(link, creator) : { id: Date.now(), social_link: link, canonical_link: link },
  getThreadByLink: async (l) => DB && DB.getThreadByLink ? DB.getThreadByLink(l) : null,
  getThreadById: async id => DB && DB.getThreadById ? DB.getThreadById(id) : null,
  listThreadsByCreator: async id => DB && DB.listThreadsByCreator ? DB.listThreadsByCreator(id) : [],
  insertVoiceComment: async p => DB && DB.insertVoiceComment ? DB.insertVoiceComment(p) : ({ id: Date.now(), ...p }),
  listCommentsByThread: async (tid, offset=0, limit=15) => DB && DB.listCommentsByThread ? DB.listCommentsByThread(tid, offset, limit) : { data: [] },
  listCommentsByUser: async uid => DB && DB.listCommentsByUser ? DB.listCommentsByUser(uid) : [],
  getCommentById: async id => DB && DB.getCommentById ? DB.getCommentById(id) : null,
  insertReplyRow: async p => DB && DB.insertReplyRow ? DB.insertReplyRow(p) : ({ id: Date.now(), ...p }),
  listReplies: async cid => DB && DB.listReplies ? DB.listReplies(cid) : [],
  toggleFavorite: async (uid, cid) => DB && DB.toggleFavoriteRow ? DB.toggleFavoriteRow(uid, cid) : { removed: false },
  isFavorite: async (uid, cid) => DB && DB.isFavorite ? DB.isFavorite(uid, cid) : false,
  listFavoritesForUser: async uid => DB && DB.listFavoritesForUser ? DB.listFavoritesForUser(uid) : [],
  toggleReaction: async (uid, cid, type) => DB && DB.toggleReaction ? DB.toggleReaction(uid, cid, type) : { added: true },
  getReactionCounts: async cid => DB && DB.getReactionCounts ? DB.getReactionCounts(cid) : { heart:0, laugh:0, dislike:0 },
  createPaymentRequest: async p => DB && DB.createPaymentRequest ? DB.createPaymentRequest(p) : ({ id: Date.now(), ...p }),
  getPaymentById: async id => DB && DB.getPaymentById ? DB.getPaymentById(id) : null,
  updatePaymentStatus: async (id, status, updates) => DB && DB.updatePaymentStatus ? DB.updatePaymentStatus(id, status, updates) : { data: { id, status, ...updates } },
  addNotificationRow: async p => DB && DB.addNotificationRow ? DB.addNotificationRow(p) : { data: p },
  listNotifications: async uid => DB && DB.listNotifications ? DB.listNotifications(uid) : { data: [] },
  insertReport: async p => DB && DB.insertReport ? DB.insertReport(p) : { id: Date.now(), ...p },
  listReports: async f => DB && DB.listReports ? DB.listReports(f) : [],
  deleteCommentById: async id => DB && DB.deleteCommentById ? DB.deleteCommentById(id) : { deleted: true },
  deleteThreadById: async id => DB && DB.deleteThreadById ? DB.deleteThreadById(id) : { deleted: true }
};

// Configuration from environment
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const WHATSAPP_ADMIN = (process.env.WHATSAPP_ADMIN || '').replace(/\D/g, '') || '';
const WHATSAPP_LINK = WHATSAPP_ADMIN ? `https://wa.me/${WHATSAPP_ADMIN}` : 'https://wa.me/';
const PAYMENT_PACKAGES = [
  { key: 'p1', label: '25 comments — 12 ETB', credits: 25, amount: 12 },
  { key: 'p2', label: '60 comments — 27 ETB', credits: 60, amount: 27 },
  { key: 'p3', label: '130 comments — 49 ETB', credits: 130, amount: 49 },
  { key: 'p4', label: '240 comments — 89 ETB', credits: 240, amount: 89 }
];

// Pending actions map with metadata and timeout
// { userId -> { type, ts, data... } }
const Pending = new Map();
const PENDING_TIMEOUT_MS = 2 * 60 * 1000; // auto cancel after 2 minutes

function setPending(userId, obj) {
  const payload = Object.assign({}, obj, { ts: Date.now() });
  Pending.set(userId, payload);
  return payload;
}
function getPending(userId) {
  const p = Pending.get(userId);
  if (!p) return null;
  if (Date.now() - (p.ts || 0) > PENDING_TIMEOUT_MS) { Pending.delete(userId); return null; }
  return p;
}
function clearPending(userId) { Pending.delete(userId); }

// Helper short code encode/decode
function encodeShort(id) { try { return utils.encodeShortCode ? utils.encodeShortCode(id) : (Number(id)||0).toString(36).toUpperCase().padStart(6,'0'); } catch(e){ return String(id); } }
function decodeShort(code) { try { return utils.decodeShortCode ? utils.decodeShortCode(code) : parseInt(String(code).replace(/[^0-9a-z]/gi,''), 36); } catch(e){ return null; } }

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

// Inline builder for comment actions
async function buildCommentInline(commentId, userId) {
  const counts = await db.getReactionCounts(commentId).catch(()=>({ heart:0, laugh:0, dislike:0 }));
  const fav = await db.isFavorite(userId, commentId).catch(()=>false);
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

// Send comment list for a thread (with inline)
async function sendCommentsList(ctx, threadId, offset = 0, limit = 15) {
  try {
    if (!(await db.isUsingSupabase()).catch(()=>false)) {
      // we still allow mem DB — above check returns false if mem
    }
    const res = await db.listCommentsByThread(threadId, offset, limit).catch(()=>({ data: [] }));
    const rows = (res && res.data) ? res.data : (Array.isArray(res) ? res : []);
    if (!rows || rows.length === 0) return ctx.reply('No comments yet for this video.');
    for (const c of rows) {
      const inline = await buildCommentInline(c.id, ctx.from.id);
      if (c.telegram_file_id) {
        await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${new Date(c.created_at || Date.now()).toLocaleString()}` }).catch(()=>{});
        await ctx.reply(encodeShort(c.id), inline);
      } else {
        await ctx.reply('(Comment saved but no voice file) ' + encodeShort(c.id), inline);
      }
    }
  } catch (e) {
    console.error('sendCommentsList error', e && (e.stack || e.message));
    await ctx.reply('Error fetching comments.');
  }
}

// Show user's favorites
async function showFavorites(ctx) {
  try {
    if (!(await db.isUsingSupabase()).catch(()=>false)) { /* mem or supabase either ok */ }
    const rows = await db.listFavoritesForUser(ctx.from.id).catch(()=>[]);
    if (!rows || rows.length === 0) return ctx.reply('No favorites yet.', mainKeyboard());
    for (const c of rows) {
      const inline = await buildCommentInline(c.id, ctx.from.id);
      if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${new Date(c.created_at || Date.now()).toLocaleString()}`});
      else await ctx.reply('Favorite comment (no voice)');
      await ctx.reply(encodeShort(c.id), inline);
      const thr = await db.getThreadById(c.thread_id).catch(()=>null);
      if (thr) await ctx.reply(`Video: ${thr.social_link || thr.canonical_link || '(unknown)'}`);
    }
    await ctx.reply('End of favorites.', mainKeyboard());
  } catch (e) {
    console.error('showFavorites err', e && e.message);
    await ctx.reply('Could not fetch favorites.');
  }
}

// Show my comments
async function showMyComments(ctx) {
  try {
    if (!(await db.isUsingSupabase()).catch(()=>false)) {}
    const rows = await db.listCommentsByUser(ctx.from.id).catch(()=>[]);
    if (!rows || rows.length === 0) return ctx.reply('You have no comments yet.', mainKeyboard());
    for (const c of rows) {
      const inline = await buildCommentInline(c.id, ctx.from.id);
      if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'You'} • ${new Date(c.created_at || Date.now()).toLocaleString()}`});
      else await ctx.reply('Comment (no voice).');
      await ctx.reply(encodeShort(c.id), inline);
      const thr = await db.getThreadById(c.thread_id).catch(()=>null);
      if (thr) await ctx.reply(`Video: ${thr.social_link || thr.canonical_link || '(unknown)'}`);
    }
    await ctx.reply('End of your comments.', mainKeyboard());
  } catch (e) {
    console.error('showMyComments err', e && e.message);
    await ctx.reply('Could not fetch your comments.');
  }
}

// Handle notifications
async function showNotifications(ctx) {
  try {
    const res = await db.listNotifications(ctx.from.id).catch(()=>({ data: [] }));
    const rows = (res && res.data) ? res.data : [];
    if (!rows || rows.length === 0) return ctx.reply('No notifications yet.', mainKeyboard());
    for (const n of rows) {
      await ctx.reply(n.message || '(notification)');
    }
    await ctx.reply('End of notifications.', mainKeyboard());
  } catch (e) {
    console.error('showNotifications err', e && e.message);
    await ctx.reply('Could not fetch notifications.');
  }
}

// Admin search comment by code (e.g. #ABC123)
async function adminSearchByCode(ctx, code) {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only.');
  const id = decodeShort(code);
  if (!id) return ctx.reply('Invalid code.');
  const comment = await db.getCommentById(id).catch(()=>null);
  if (!comment) return ctx.reply('Not found.');
  const inline = Markup.inlineKeyboard([[Markup.button.callback('Delete', `admin_delete_comment|${id}`)]]);
  if (comment.telegram_file_id) {
    await ctx.replyWithVoice(comment.telegram_file_id, { caption: `Comment #${id}`, reply_markup: inline.reply_markup }).catch(()=>ctx.reply(`Comment #${id}`));
  } else {
    await ctx.reply(`Comment #${id}`, inline);
  }
}

// is admin?
function isAdmin(id) { return ADMIN_IDS.includes(Number(id)); }

// Payment flow: create request and immediately show copy & upload options
async function startPaymentFlow(ctx, pkg) {
  try {
    const created = await db.createPaymentRequest({
      telegram_id: ctx.from.id,
      package_name: pkg.label,
      comments_amount: pkg.credits,
      amount: pkg.amount,
      method: 'manual',
      status: 'pending',
      created_at: new Date().toISOString()
    }).catch(err => {
      console.error('createPaymentRequest err', err && (err.message || err));
      return null;
    });
    const pid = (created && created.id) ? created.id : Math.floor(Math.random()*900000) + 10000;
    const telebirr = '0962058608';
    const cbe = '1000555367884';
    const msg = `*Payment details*\n\nTELEBIRR: \`${telebirr}\`\nCBE Account: \`${cbe}\`\n\nAmount: *${pkg.amount} ETB*\nRequest ID: ${pid}\n\nAfter you pay, upload proof (photo or link) using the button below.`;
    const inline = Markup.inlineKeyboard([
      [ Markup.button.callback('Copy TELEBIRR', `copy_tel|${telebirr}`), Markup.button.callback('Copy CBE', `copy_acc|${cbe}`) ],
      [ Markup.button.callback('Upload Proof (photo/link)', `start_upload_proof|${pid}`) ],
      [ Markup.button.url('Contact admin (WhatsApp)', `${WHATSAPP_LINK}?text=Payment%20for%20request%20${pid}`) ]
    ]);
    await ctx.replyWithMarkdown(msg).catch(()=>ctx.reply(msg));
    await ctx.reply('Payment actions:', inline);

    // notify admin
    (async () => {
      for (const adm of ADMIN_IDS) {
        try { await ctx.telegram.sendMessage(Number(adm), `🆕 New payment request #${pid} by ${ctx.from.id} — ${pkg.label} — ${pkg.amount} ETB`).catch(()=>{}); } catch(e){}
      }
    })();
  } catch (e) {
    console.error('startPaymentFlow err', e && e.message);
    await ctx.reply('Could not create payment request.');
  }
}

// Helper: when user sends a keyboard label or recognized command -> clear pending
function shouldCancelPendingForText(text) {
  if (!text) return false;
  const t = text.toString().trim().toLowerCase();
  const labels = ['🎥 add comment','➕ add my video','🔖 track video','🎧 listen comments','💬 my comments','🔎 search','⭐ favorites','🔔 notifications','🛒 buy','🆘 support','💰 balance'];
  return labels.includes(t);
}

// Initialize bot
async function initBot() {
  if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN env var');
  const bot = new Telegraf(BOT_TOKEN);

  bot.start(async ctx => {
    try {
      await db.ensureUserRow(ctx.from).catch(()=>null);
      const bal = await db.getUserBalance(ctx.from.id).catch(()=>0);
      await ctx.reply(`Welcome! You have *${bal}* available comments.`, { parse_mode: 'Markdown' });
      await ctx.reply('Send a TikTok or YouTube link or use the keyboard below.', mainKeyboard());
    } catch (e) {
      console.error('start err', e && e.message);
      await ctx.reply('Welcome — an error occurred while initializing.');
    }
  });

  // Commands
  bot.command('notifications', ctx => showNotifications(ctx));
  bot.command('favorites', ctx => showFavorites(ctx));
  bot.command('mycomments', ctx => showMyComments(ctx));
  bot.command('reportsearch', ctx => {
    const parts = (ctx.message.text||'').split(/\s+/).slice(1);
    if (!parts.length) return ctx.reply('Usage: /reportsearch <CODE>');
    return adminSearchByCode(ctx, parts[0]);
  });
  bot.command('balance', async ctx => {
    const b = await db.getUserBalance(ctx.from.id).catch(()=>0);
    return ctx.reply(`Your available comments: *${b}*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard().reply_markup });
  });

  // Text and keyboards handler
  bot.on('text', async ctx => {
    const textRaw = (ctx.message && ctx.message.text) || '';
    const text = (utils.normalizeInput ? utils.normalizeInput(textRaw) : String(textRaw).trim());
    const uid = ctx.from.id;

    // auto-cancel pending if user presses a keyboard label or types another recognized action
    if (shouldCancelPendingForText(text)) {
      const p = getPending(uid);
      if (p) {
        clearPending(uid);
        try { await ctx.reply('Previous action canceled.'); } catch(e){}
      }
    }

    // If they send a code like "ABC123" while pending to search, handle it
    const maybeCodeOnly = textRaw.trim().replace(/^#/, '');
    if (getPending(uid) && getPending(uid).type === 'search_prompt' && maybeCodeOnly.length <= 12 && /^[0-9A-Za-z]+$/.test(maybeCodeOnly)) {
      clearPending(uid);
      return handleSearchCode(ctx, maybeCodeOnly);
    }

    // Keyboard labels support (lowercase)
    const label = text.toString().toLowerCase();

    // Map label actions
    if (label === '🎥 add comment') { setPending(uid, { type: 'create_thread_public' }); return ctx.reply('Send the TikTok/YouTube link you want to add a voice comment to.'); }
    if (label === '➕ add my video') { setPending(uid, { type: 'create_thread_owned' }); return ctx.reply('Send the link of your video to track it and receive notifications.'); }
    if (label === '🔖 track video') {
      try {
        const rows = await db.listThreadsByCreator(uid).catch(()=>[]);
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
        console.error('track video list err', e && e.message);
        return ctx.reply('Could not list tracked videos.');
      }
    }
    if (label === '🎧 listen comments') { setPending(uid, { type: 'listen_prompt' }); return ctx.reply('Send a TikTok/YouTube link (or click a tracked video) to listen comments.'); }
    if (label === '💬 my comments') { return showMyComments(ctx); }
    if (label === '⭐ favorites') { return showFavorites(ctx); }
    if (label === '🔎 search') { setPending(uid, { type: 'search_prompt' }); return ctx.reply('Send the short code (e.g. 00A1B2) or paste a link.'); }
    if (label === '🔔 notifications') { return showNotifications(ctx); }
    if (label === '🛒 buy') {
      const inline = PAYMENT_PACKAGES.map((p, idx) => [ Markup.button.callback(p.label, `buypkg|${idx}`) ]);
      inline.push([Markup.button.callback('Contact support', 'contact_whatsapp')]);
      return ctx.reply('Choose a package:', Markup.inlineKeyboard(inline));
    }
    if (label === '🆘 support') {
      return ctx.reply(`Support: ${WHATSAPP_LINK}`);
    }
    if (label === '💰 balance') {
      const b = await db.getUserBalance(uid).catch(()=>0);
      return ctx.reply(`Your available comments: *${b}*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard().reply_markup });
    }

    // If user sends a link (URL) — treat as thread creation/listen
    const maybeUrl = utils.extractFirstUrl ? utils.extractFirstUrl(textRaw) : null;
    if (maybeUrl) {
      const p = getPending(uid);
      try {
        const creatorId = (p && p.type === 'create_thread_owned') ? uid : null;
        const t = await db.findOrCreateThread(maybeUrl, creatorId).catch(err => { throw err; });
        if (!t) return ctx.reply('Could not create thread.');
        // auto-cancel pending if it was waiting for a link
        if (p && (p.type === 'create_thread_public' || p.type === 'create_thread_owned' || p.type === 'listen_prompt')) clearPending(uid);

        // show thumbnail (if available) and actions
        const thumb = t.thumbnail || null;
        const inline = Markup.inlineKeyboard([[Markup.button.callback('🎙 Add Voice Comment', `addvoice|${t.id}`), Markup.button.callback('🎧 Listen Comments', `listen|${t.id}|1`)]]);
        if (thumb) await ctx.replyWithPhoto(thumb, { caption: `Thread: ${t.social_link || maybeUrl}`, reply_markup: inline.reply_markup });
        else await ctx.reply(`Thread: ${t.social_link || maybeUrl}`, inline);
        return;
      } catch (e) {
        console.error('url create/listen err', e && (e.stack || e.message));
        return ctx.reply('Error processing the link.');
      }
    }

    // If pending search_prompt and user types a code or text -> handle search
    const pend = getPending(uid);
    if (pend && pend.type === 'search_prompt') {
      clearPending(uid);
      return handleSearchCode(ctx, textRaw.trim());
    }

    // If nothing matched
    return ctx.reply('I did not detect a supported link or action. Press a button or send a TikTok/YouTube URL.', mainKeyboard());
  });

  // Voice message handler (for add comment or reply)
  bot.on('voice', async ctx => {
    const uid = ctx.from.id;
    const p = getPending(uid);
    if (!p) return ctx.reply('No pending action for voice. Use the keyboard to choose an action.', mainKeyboard());
    // auto-cancel if expired
    if (!getPending(uid)) return ctx.reply('Pending action expired. Try again.');

    // Replying to a comment (voice)
    if ((p.type === 'reply_choice' || p.type === 'reply_voice') && p.commentId) {
      clearPending(uid);
      try {
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice file found.');
        const saved = await db.insertReplyRow({
          comment_id: p.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id,
          duration: voice.duration || 0,
          created_at: new Date().toISOString()
        }).catch(e => { throw e; });
        await ctx.replyWithVoice(voice.file_id, { caption: `↳ Reply by ${ctx.from.first_name || ctx.from.username || 'User'}` });
        // notify comment owner if possible
        try {
          const comment = await db.getCommentById(p.commentId).catch(()=>null);
          if (comment && comment.telegram_id && comment.telegram_id !== uid) {
            const code = encodeShort(p.commentId);
            const threadRow = await db.getThreadById(comment.thread_id).catch(()=>null);
            const videoLink = threadRow ? threadRow.social_link : '(video unknown)';
            const text = `${ctx.from.first_name || ctx.from.username} replied to your comment.\n${code}\nVideo: ${videoLink}`;
            await db.addNotificationRow({ telegram_id: comment.telegram_id, type: 'reply', message: text, meta: { comment_id: p.commentId } }).catch(()=>null);
            try { await bot.telegram.sendMessage(comment.telegram_id, text); } catch (e) {}
          }
        } catch (e) { console.error('notify reply owner err', e && e.message); }
        return;
      } catch (e) {
        console.error('reply_voice save err', e && (e.stack || e.message));
        return ctx.reply('Could not save voice reply.');
      }
    }

    // Add a voice comment to a thread
    if (p.type === 'add_comment' && p.threadId) {
      clearPending(uid);
      try {
        if (!(await db.isUsingSupabase()).catch(()=>false)) {
          // continue even if no supabase
        }
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found.');
        // check balance before saving if necessary
        const bal = await db.getUserBalance(uid).catch(()=>0);
        if (Number(bal || 0) <= 0) {
          // allow if your system allows unpaid comments? respond accordingly
          return ctx.reply('You have zero balance. Please buy a package to post comments.');
        }
        const inserted = await db.insertVoiceComment({
          thread_id: p.threadId,
          telegram_id: uid,
          username: ctx.from.username || null,
          first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id,
          duration: voice.duration || 0,
          created_at: new Date().toISOString()
        }).catch(e => { throw e; });
        const savedId = (inserted && inserted.id) ? inserted.id : null;
        const code = encodeShort(savedId || '');
        await ctx.reply('✅ Voice saved!');
        await ctx.reply(code, mainKeyboard());

        // Decrement balance, best-effort
        try {
          const dec = await db.decrementUserBalance(uid, 1).catch(err => ({ error: err && err.message }));
          if (dec && dec.error) {
            console.error('decrementUserBalance error', dec);
            await ctx.reply('Note: could not decrement your balance automatically; admin will review.');
          }
        } catch (e) { console.error('decrementUserBalance err', e && e.message); }

        // Notify tracked owner
        try {
          const threadRow = await db.getThreadById(p.threadId).catch(()=>null);
          if (threadRow && threadRow.creator_telegram_id && threadRow.creator_telegram_id !== uid) {
            const notif = `🔔 New voice comment on your tracked video by ${ctx.from.first_name || ctx.from.username}\nVideo: ${threadRow.social_link}\nCode: ${code}`;
            await db.addNotificationRow({ telegram_id: threadRow.creator_telegram_id, type: 'reply', message: notif, meta: { thread_id: p.threadId, comment_id: savedId } }).catch(()=>null);
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

  // Photo handler (upload proof)
  bot.on('photo', async ctx => {
    const uid = ctx.from.id;
    const p = getPending(uid);
    if (!p || p.type !== 'upload_payproof') return ctx.reply('Photo received but no pending action.');
    clearPending(uid);
    try {
      const photos = ctx.message.photo || [];
      const largest = photos[photos.length - 1];
      const fileId = largest && largest.file_id;
      const upd = await db.updatePaymentStatus(p.paymentId, 'proof_submitted', { proof_telegram_file_id: fileId }).catch(()=>null);
      await ctx.reply(`Proof received for payment #${p.paymentId}. Admins will review.`);
      for (const adm of ADMIN_IDS) {
        try {
          const inline = Markup.inlineKeyboard([[Markup.button.callback('Approve', `admin_approve|${p.paymentId}`), Markup.button.callback('Reject', `admin_reject|${p.paymentId}`)]]);
          await bot.telegram.sendPhoto(Number(adm), fileId, { caption: `Payment proof for request #${p.paymentId} by ${uid}`, reply_markup: inline.reply_markup }).catch(()=>{});
        } catch (e) { console.error('notify admin photo err', e && e.message); }
      }
    } catch (e) {
      console.error('upload_payproof photo handler error', e && e.message);
      await ctx.reply('Could not submit proof.');
    }
  });

  // callback_query handler (buttons)
  bot.on('callback_query', async ctx => {
    const data = ctx.callbackQuery && ctx.callbackQuery.data;
    if (!data) return ctx.answerCbQuery();
    // Clear pending on any button action by user
    clearPending(ctx.from.id);

    const parts = data.split('|');
    const cmd = parts[0];

    try {
      if (cmd === 'listen') {
        const threadId = Number(parts[1]);
        const page = Number(parts[2] || 1);
        await ctx.answerCbQuery();
        return sendCommentsList(ctx, threadId, (page-1)*15);
      }

      if (cmd === 'addvoice') {
        const threadId = Number(parts[1]);
        setPending(ctx.from.id, { type: 'add_comment', threadId });
        await ctx.answerCbQuery();
        return ctx.reply('Send your voice now to add to this thread.');
      }

      if (cmd === 'react') {
        const commentId = Number(parts[1]);
        const rType = parts[2];
        try {
          const result = await db.toggleReaction(ctx.from.id, commentId, rType);
          const inline = await buildCommentInline(commentId, ctx.from.id);
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

      if (cmd === 'fav') {
        const commentId = Number(parts[1]);
        try {
          const result = await db.toggleFavorite(ctx.from.id, commentId);
          await ctx.answerCbQuery(result.removed ? 'Favorite removed' : 'Favorite added');
          try {
            const msg = ctx.callbackQuery.message;
            if (msg && msg.chat && msg.message_id) {
              const inline = await buildCommentInline(commentId, ctx.from.id);
              await ctx.telegram.editMessageReplyMarkup(msg.chat.id, msg.message_id, null, inline.reply_markup);
            }
          } catch (e) {}
        } catch (e) {
          console.error('fav handler err', e && e.message);
          await ctx.answerCbQuery('Could not toggle favorite');
        }
        return;
      }

      if (cmd === 'list_replies') {
        const commentId = Number(parts[1]);
        await ctx.answerCbQuery();
        const rows = await db.listReplies(commentId).catch(()=>[]);
        if (!rows || rows.length === 0) return ctx.reply('No replies yet.');
        for (const r of rows) {
          if (r.telegram_file_id) await ctx.replyWithVoice(r.telegram_file_id, { caption: `↳ ${r.replier_first_name || r.replier_username || 'User'}` }).catch(()=>{});
          else if (r.reply_text) await ctx.reply(`↳ ${r.replier_first_name || r.replier_username || 'User'}: ${r.reply_text}`).catch(()=>{});
          else await ctx.reply(`↳ ${r.replier_first_name || r.replier_username || 'User'}`);
        }
        return;
      }

      if (cmd === 'replymenu') {
        const commentId = Number(parts[1]);
        setPending(ctx.from.id, { type: 'reply_choice', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Reply options:\n• Send voice to add voice reply\n• Send text to add text reply\n(Your next message will be used)');
      }

      if (cmd === 'replyvoice') {
        const commentId = Number(parts[1]);
        setPending(ctx.from.id, { type: 'reply_voice', commentId });
        await ctx.answerCbQuery('Send voice reply now');
        return ctx.reply('🎙 Send your voice reply now.');
      }

      if (cmd === 'report') {
        const commentId = Number(parts[1]);
        setPending(ctx.from.id, { type: 'report_reason', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain why you report this comment. Send a short message describing the issue.');
      }

      if (cmd === 'delete_comment') {
        const commentId = Number(parts[1]);
        try {
          const r = await db.deleteCommentById(commentId).catch(()=>({ error: 'not supported' }));
          if (r && r.error) { await ctx.answerCbQuery('Could not delete'); return ctx.reply('Delete unsupported or failed.'); }
          await ctx.answerCbQuery('Deleted');
          return ctx.reply('Comment deleted.');
        } catch (e) {
          console.error('delete_comment err', e && e.message);
          await ctx.answerCbQuery('Not found or could not delete.');
        }
        return;
      }

      if (cmd === 'delete_thread') {
        const threadId = Number(parts[1]);
        try {
          const r = await db.deleteThreadById(threadId).catch(()=>({ error: 'not supported' }));
          if (r && r.error) { await ctx.answerCbQuery('Could not delete'); return ctx.reply('Delete unsupported.'); }
          await ctx.answerCbQuery('Tracked video deleted');
          return ctx.reply('Tracked video removed.');
        } catch (e) {
          console.error('delete_thread err', e && e.message);
          await ctx.answerCbQuery('Could not delete tracked video');
        }
        return;
      }

      // Buy flow
      if (cmd === 'buypkg') {
        const idx = Number(parts[1]);
        const pkg = PAYMENT_PACKAGES[idx];
        if (!pkg) { await ctx.answerCbQuery('Invalid package'); return; }
        const inline = Markup.inlineKeyboard([[ Markup.button.callback(`Confirm: ${pkg.label}`, `confirm_buy|${idx}`), Markup.button.callback('Cancel', `cancel_buy|${idx}`) ]]);
        await ctx.answerCbQuery();
        return ctx.reply(`You chose: ${pkg.label}\nPress Confirm to proceed or Cancel to go back.`, inline);
      }
      if (cmd === 'confirm_buy') {
        const idx = Number(parts[1]);
        const pkg = PAYMENT_PACKAGES[idx];
        if (!pkg) { await ctx.answerCbQuery('Invalid package'); return; }
        await ctx.answerCbQuery('Creating payment request...');
        return startPaymentFlow(ctx, pkg);
      }
      if (cmd === 'cancel_buy') {
        await ctx.answerCbQuery('Purchase cancelled');
        return ctx.reply('Purchase cancelled.', mainKeyboard());
      }
      if (cmd === 'copy_tel' || cmd === 'copy_acc') {
        const value = parts[1] || '';
        await ctx.answerCbQuery('Sent to chat');
        try { await bot.telegram.sendMessage(ctx.from.id, `${value}`); } catch (e) { console.error('copy send err', e && e.message); }
        return;
      }
      if (cmd === 'start_upload_proof') {
        const paymentId = Number(parts[1]);
        if (!paymentId) { await ctx.answerCbQuery('Invalid payment id'); return; }
        setPending(ctx.from.id, { type: 'upload_payproof', paymentId });
        await ctx.answerCbQuery();
        await ctx.reply(`Send the payment proof (photo or link) now for payment #${paymentId}.`);
        return;
      }

      // admin approve/reject
      if (cmd === 'admin_approve') {
        const paymentId = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          const payment = await db.getPaymentById(paymentId).catch(()=>null);
          if (!payment) { await ctx.answerCbQuery('Not found'); return; }
          if (payment.status === 'approved') { await ctx.answerCbQuery('Already approved'); return; }
          await db.updatePaymentStatus(paymentId, 'approved').catch(()=>null);
          const credits = Number(payment.comments_amount || 0) || 0;
          try {
            await db.creditUser(payment.telegram_id, credits);
          } catch (e) {
            console.error('admin_approve creditUser err', e && e.message);
            await ctx.answerCbQuery('Approved; but crediting failed');
            try { await bot.telegram.sendMessage(payment.telegram_id, `Your payment #${paymentId} was approved but we could not credit automatically. Contact admin.`); } catch(_) {}
            return;
          }
          await ctx.answerCbQuery('Payment approved & credited');
          try { await bot.telegram.sendMessage(payment.telegram_id, `Your payment #${paymentId} was approved. Credited ${credits} comments.`); } catch(_) {}
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
          await db.updatePaymentStatus(paymentId, 'rejected');
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

      // admin delete comment by code
      if (cmd === 'admin_delete_comment') {
        const commentId = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        const del = await db.deleteCommentById(commentId).catch(()=>({error:'err'}));
        if (del && del.error) { await ctx.answerCbQuery('Could not delete'); return ctx.reply('Failed to delete.'); }
        await ctx.answerCbQuery('Deleted');
        return ctx.reply('Comment deleted.');
      }

      await ctx.answerCbQuery();
    } catch (e) {
      console.error('callback_query handling top error', e && (e.stack || e.message));
      try { await ctx.answerCbQuery('Error handling action'); } catch (_) {}
    }
  });

  // Generic message handler for pending text actions (reply text, report reason, upload proof link)
  bot.on('message', async ctx => {
    if (!ctx.message || !ctx.message.text) return;
    const uid = ctx.from.id;
    const p = getPending(uid);
    if (!p) return;

    // reply text
    if (p.type === 'reply_text' && p.commentId) {
      clearPending(uid);
      try {
        await db.insertReplyRow({
          comment_id: p.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          reply_text: ctx.message.text,
          created_at: new Date().toISOString()
        }).catch(()=>null);
        return ctx.reply('Text reply saved.');
      } catch (e) {
        console.error('reply_text save err', e && e.message);
        return ctx.reply('Could not save text reply.');
      }
    }

    // report reason
    if (p.type === 'report_reason' && p.commentId) {
      clearPending(uid);
      try {
        const report = {
          reporter_telegram_id: uid,
          reporter_username: ctx.from.username || null,
          comment_id: p.commentId,
          reason: ctx.message.text,
          status: 'open',
          created_at: new Date().toISOString()
        };
        if (db && db.insertReport) await db.insertReport(report).catch(()=>null);
        // notify admins immediately
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendMessage(Number(adm), `🚨 Report: comment #${p.commentId}\nReporter: ${uid}\nReason: ${ctx.message.text}`); } catch(_) {}
        }
        return ctx.reply('Report submitted. Admins will review.');
      } catch (e) {
        console.error('report_reason save err', e && e.message);
        return ctx.reply('Could not submit report.');
      }
    }

    // upload proof link
    if (p.type === 'upload_payproof' && p.paymentId) {
      clearPending(uid);
      try {
        const link = ctx.message.text.trim();
        await db.updatePaymentStatus(p.paymentId, 'proof_link_submitted', { proof_link: link }).catch(()=>null);
        await ctx.reply(`Proof link received for payment #${p.paymentId}. Admins will review.`);
        for (const adm of ADMIN_IDS) {
          try {
            const inline = Markup.inlineKeyboard([[Markup.button.callback('Approve', `admin_approve|${p.paymentId}`), Markup.button.callback('Reject', `admin_reject|${p.paymentId}`)]]);
            await bot.telegram.sendMessage(Number(adm), `Payment proof (link) for #${p.paymentId} by ${uid}:\n${link}`, inline).catch(()=>{});
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
    console.error('Bot catch err', err && (err.stack || err.message), ctx && ctx.updateType);
  });

  return bot;
}

// Helper: handle search by short code
async function handleSearchCode(ctx, code) {
  try {
    const id = decodeShort(code);
    if (!id) return ctx.reply('Invalid code.');
    const comment = await db.getCommentById(id).catch(()=>null);
    if (!comment) return ctx.reply('No voice found for that code.');
    if (comment.telegram_file_id) await ctx.replyWithVoice(comment.telegram_file_id, { caption: `${comment.first_name || comment.username || 'User'} • ${new Date(comment.created_at || Date.now()).toLocaleString()}` });
    else await ctx.reply('Comment found but no voice stored.');
    const inline = await buildCommentInline(comment.id, ctx.from.id);
    const thread = await db.getThreadById(comment.thread_id).catch(()=>null);
    const videoLink = thread ? thread.social_link : '(video unknown)';
    await ctx.reply(`Video: ${videoLink}`, inline);
  } catch (e) {
    console.error('handleSearchCode err', e && e.message);
    await ctx.reply('Search failed.');
  }
}

module.exports = { initBot };
