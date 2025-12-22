// src/bot.js
// Full bot code: uses database.js wrapper above.
// - Shows thumbnail when link shared (if available via utils.normalizeVideoUrl or YouTube id).
// - Robust error messages when DB unreachable.
// - Favorites, reactions, payments, replies supported.

const { Telegraf, Markup } = require('telegraf');

const utils = (() => {
  try { return require('./utils'); } catch (e) { return {}; }
})();

const db = (() => {
  try { return require('./database'); } catch (e) { console.error('Could not load database wrapper', e && e.message); return null; }
})();

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

function isAdmin(id) { return ADMIN_IDS.map(Number).includes(Number(id)); }
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

const Pending = new Map();

// small wrappers that call db.* where available and fall back
async function ensureUserRow(user) { try { if (db && db.ensureUserRow) return await db.ensureUserRow(user); } catch(e){console.error('ensureUserRow err',e);} return null; }
async function getUserBalance(id) { try { if (db && db.getUserBalance) return await db.getUserBalance(id); } catch(e){console.error('getUserBalance err',e);} return 0; }
async function creditUser(id, amount) { try { if (db && db.creditUser) return await db.creditUser(id, amount); } catch(e){console.error('creditUser err',e); throw e;} }
async function decrementUserBalance(id, amount) { try { if (db && db.decrementUserBalance) return await db.decrementUserBalance(id, amount); } catch(e){console.error('decrementUserBalance err',e); throw e;} }
async function findOrCreateThread(link, creator) { try { if (db && db.findOrCreateThread) return await db.findOrCreateThread(link, creator); } catch(e){console.error('findOrCreateThread err',e);} return { id: Date.now(), social_link: link, canonical_link: link, thumbnail: null, creator_telegram_id: creator || null }; }
async function getThreadById(id) { try { if (db && db.getThreadById) return await db.getThreadById(id); } catch(e){console.error('getThreadById err',e);} return null; }
async function listThreadsByCreator(id) { try { if (db && db.listThreadsByCreator) return await db.listThreadsByCreator(id); } catch(e){console.error('listThreadsByCreator err',e);} return []; }
async function insertVoiceComment(payload) { try { if (db && db.insertVoiceComment) return await db.insertVoiceComment(payload); } catch(e){console.error('insertVoiceComment err',e); throw e;} }
async function listCommentsByThread(threadId, offset=0, limit=15) { try { if (db && db.listCommentsByThread) return await db.listCommentsByThread(threadId, offset, limit); } catch(e){console.error('listCommentsByThread err',e);} return { data: [] }; }
async function listCommentsByUser(id) { try { if (db && db.listCommentsByUser) return await db.listCommentsByUser(id); } catch(e){console.error('listCommentsByUser err',e);} return []; }
async function getCommentById(id) { try { if (db && db.getCommentById) return await db.getCommentById(id); } catch(e){console.error('getCommentById err',e);} return null; }
async function insertReplyRow(payload) { try { if (db && db.insertReplyRow) return await db.insertReplyRow(payload); } catch(e){console.error('insertReplyRow err',e); throw e;} }
async function listReplies(commentId) { try { if (db && db.listReplies) return await db.listReplies(commentId); } catch(e){console.error('listReplies err',e);} return []; }
async function toggleFavoriteRow(id, commentId) { try { if (db && db.toggleFavoriteRow) return await db.toggleFavoriteRow(id, commentId); } catch(e){console.error('toggleFavoriteRow err',e);} return { removed:false }; }
async function isFavorite(id, commentId) { try { if (db && db.isFavorite) return await db.isFavorite(id, commentId); } catch(e){console.error('isFavorite err',e);} return false; }
async function listFavoritesForUser(id) { try { if (db && db.listFavoritesForUser) return await db.listFavoritesForUser(id); } catch(e){console.error('listFavoritesForUser err',e);} return []; }
async function toggleReactionLocal(id, commentId, type) { try { if (db && db.toggleReaction) return await db.toggleReaction(id, commentId, type); } catch(e){console.error('toggleReaction err',e);} return null; }
async function getReactionCountsLocal(commentId) { try { if (db && db.getReactionCounts) return await db.getReactionCounts(commentId); } catch(e){console.error('getReactionCounts err',e);} return { heart:0, laugh:0, dislike:0 }; }
async function createPaymentRequest(payload) { try { if (db && db.createPaymentRequest) return await db.createPaymentRequest(payload); } catch(e){console.error('createPaymentRequest err',e);} return null; }
async function getPaymentById(id) { try { if (db && db.getPaymentById) return await db.getPaymentById(id); } catch(e){console.error('getPaymentById err',e);} return null; }
async function updatePaymentStatusLocal(id, status, updates) { try { if (db && db.updatePaymentStatus) return await db.updatePaymentStatus(id, status, updates); } catch(e){console.error('updatePaymentStatus err',e);} return null; }
async function addNotificationRow(payload) { try { if (db && db.addNotificationRow) return await db.addNotificationRow(payload); } catch(e){console.error('addNotificationRow err',e);} return null; }
async function listNotificationsLocal(id) { try { if (db && db.listNotifications) return await db.listNotifications(id); } catch(e){console.error('listNotifications err',e);} return { data: [] }; }
async function isUsingSupabaseLocal() { try { if (db && typeof db.isUsingSupabase === 'function') return db.isUsingSupabase(); } catch(e){} return false; }

// helpers
function encodeShortCode(id) { try { if (utils && utils.encodeShortCode) return utils.encodeShortCode(id); } catch(e){} return String(id); }
function decodeShortCode(code) { try { if (utils && utils.decodeShortCode) return utils.decodeShortCode(code); } catch(e){} return null; }

// build inline actions
async function buildActionsInline(commentId, userId) {
  const reactionCounts = await getReactionCountsLocal(commentId).catch(()=>({ heart:0,laugh:0,dislike:0 }));
  const fav = await isFavorite(userId, commentId).catch(()=>false);
  const favLabel = fav ? '★ Favorite' : '☆ Favorite';
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

// thumbnail helper: use normalized thumbnail if provided; fallback to youtube construct
function thumbnailForThread(threadRow) {
  if (!threadRow) return null;
  if (threadRow.thumbnail) return threadRow.thumbnail;
  if (threadRow.provider && threadRow.provider.toLowerCase().includes('youtube') && threadRow.provider_id) {
    return `https://img.youtube.com/vi/${threadRow.provider_id}/hqdefault.jpg`;
  }
  // utils.normalizeVideoUrl might produce thumbnail; otherwise null
  return null;
}

// show replies (simple)
async function showRepliesForComment(ctx, commentId, page=1, perPage=10) {
  try{
    const rows = await listReplies(commentId);
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
      const next = page + 1;
      await ctx.reply('More replies...', Markup.inlineKeyboard([[ Markup.button.callback('More replies', `list_replies|${commentId}|${next}`) ]]));
    }
  } catch(e){ console.error('showRepliesForComment err', e); await ctx.reply('Error listing replies.'); }
}

// send comments page
async function sendCommentsPage(ctx, threadId, offset = 0, limit = 15) {
  try {
    if (!(await isUsingSupabaseLocal())) return ctx.reply('Persistence unavailable (DB unreachable).');
    const res = await listCommentsByThread(threadId, offset, limit).catch(()=>({ data: [] }));
    const rows = (res && res.data) ? res.data : (Array.isArray(res) ? res : []);
    if (!rows || rows.length === 0) return ctx.reply('No comments yet.');
    for (const c of rows) {
      const inline = await buildActionsInline(c.id, ctx.from.id);
      if (c.telegram_file_id) {
        await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${new Date(c.created_at).toLocaleString()}` });
        await ctx.reply(encodeShortCode(c.id), inline);
      } else {
        await ctx.reply('Comment (no voice).', inline);
      }
    }
  } catch (e) { console.error('sendCommentsPage err', e); await ctx.reply('Error while fetching comments.'); }
}

// Notifications command
async function handleNotificationsCommand(ctx) {
  try {
    if (!(await isUsingSupabaseLocal())) return ctx.reply('Persistence unavailable (DB unreachable).');
    const res = await listNotificationsLocal(ctx.from.id).catch(()=>({ data: [] }));
    const rows = (res && res.data) ? res.data : [];
    if (!rows || rows.length === 0) return ctx.reply('No notifications yet.', mainKeyboard());
    for (const n of rows) {
      await ctx.reply(n.message || '(notification)');
    }
    await ctx.reply('End of notifications.', mainKeyboard());
  } catch (e) { console.error('handleNotificationsCommand err', e); await ctx.reply('Could not fetch notifications.'); }
}

// My Comments command
async function handleMyComments(ctx) {
  try {
    if (!(await isUsingSupabaseLocal())) return ctx.reply('Persistence unavailable (DB unreachable).');
    const rows = await listCommentsByUser(ctx.from.id);
    if (!rows || rows.length === 0) return ctx.reply('You have no comments yet.');
    for (const c of rows) {
      const inline = await buildActionsInline(c.id, ctx.from.id);
      if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'You'} • ${new Date(c.created_at).toLocaleString()}` });
      else await ctx.reply('Comment (no voice).');
      await ctx.reply(encodeShortCode(c.id), inline);
      const thr = await getThreadById(c.thread_id);
      if (thr) await ctx.reply(`Video: ${thr.social_link || thr.canonical_link || '(unknown)'}`);
    }
    await ctx.reply('End of your comments.', mainKeyboard());
  } catch(e){ console.error('handleMyComments err', e); await ctx.reply('Could not fetch your comments.'); }
}

// Favorites command
async function showFavoritesCommand(ctx) {
  try {
    if (!(await isUsingSupabaseLocal())) return ctx.reply('Persistence unavailable (DB unreachable).');
    const rows = await listFavoritesForUser(ctx.from.id);
    if (!rows || rows.length === 0) return ctx.reply('No favorites yet.', mainKeyboard());
    for (const c of rows) {
      if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${new Date(c.created_at).toLocaleString()}` });
      else await ctx.reply('Favorite comment (no voice).');
      await ctx.reply(encodeShortCode(c.id), await buildActionsInline(c.id, ctx.from.id));
      const thr = await getThreadById(c.thread_id);
      if (thr) await ctx.reply(`Video: ${thr.social_link || thr.canonical_link || '(unknown)'}`);
    }
    await ctx.reply('End of favorites.', mainKeyboard());
  } catch(e){ console.error('showFavoritesCommand err',e); await ctx.reply('Could not fetch favorites.'); }
}

// Payment request creator (after confirm)
async function createPaymentRequestFlow(ctx, pkg, bot) {
  try {
    const created = await createPaymentRequest({
      telegram_id: ctx.from.id,
      package_name: pkg.label,
      comments_amount: pkg.credits,
      amount: pkg.amount,
      method: 'manual',
      status: 'pending'
    }).catch(err => { console.error('createPaymentRequest err', err); return null; });

    const row = (created && created.data) ? created.data : created;
    const pid = row && row.id ? row.id : Math.floor(Math.random()*100000);

    const telebirr = '0962058608';
    const cbeAcc = '1000555367884';
    const bankText = `*Payment details*\n\nTELEBIRR: \`${telebirr}\`\nCBE Account: \`${cbeAcc}\`\n\nAmount: *${pkg.amount} ETB*\n\nAfter payment press "Upload Proof" below then send the screenshot/photo or paste the payment link.\nOr use: /payproof ${pid}`;

    const inline = Markup.inlineKeyboard([
      [ Markup.button.callback('Copy TELEBIRR', `copy_tel|${telebirr}`), Markup.button.callback('Copy CBE', `copy_acc|${cbeAcc}`) ],
      [ Markup.button.callback('Upload Proof (photo/link)', `start_upload_proof|${pid}`) ],
      [ Markup.button.url('Contact admin (WhatsApp)', `${WHATSAPP_LINK}?text=Payment%20for%20request%20${pid}`) ]
    ]);

    await ctx.replyWithMarkdown(bankText).catch(()=>ctx.reply(bankText));
    await ctx.reply('Payment options:', inline);

    (async ()=> {
      for (const adm of ADMIN_IDS) {
        try { await bot.telegram.sendMessage(Number(adm), `🆕 New payment request #${pid} by ${ctx.from.id} — ${pkg.label} (${pkg.amount} ETB)`); } catch(e){}
      }
    })();

    return;
  } catch(e){ console.error('createPaymentRequestFlow err', e); await ctx.reply('Could not create payment request.'); }
}

// search by code
async function handleSearchByCode(ctx, code) {
  try {
    const id = decodeShortCode((code||'').toUpperCase());
    if (!id) return ctx.reply('Invalid code.');
    const comment = await getCommentById(id);
    if (!comment) return ctx.reply('No voice found for that code.');
    if (comment.telegram_file_id) await ctx.replyWithVoice(comment.telegram_file_id, { caption: `${comment.first_name || comment.username || 'User'} • ${new Date(comment.created_at).toLocaleString()}` });
    else await ctx.reply('Comment found but no voice stored.');
    const inline = await buildActionsInline(comment.id, ctx.from.id);
    const thread = await getThreadById(comment.thread_id);
    const videoLink = thread ? thread.social_link : '(video unknown)';
    await ctx.reply(`Video: ${videoLink}`, inline);
  } catch(e){ console.error('handleSearchByCode err', e); await ctx.reply('Search failed.'); }
}

// build bot
async function initBot() {
  if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');

  const bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    try {
      await ensureUserRow(ctx.from).catch(()=>null);
      const bal = await getUserBalance(ctx.from.id).catch(()=>0);
      await ctx.reply(`Welcome!\nYou have *${bal}* available comments.`, { parse_mode:'Markdown' });
      await ctx.reply('Send a TikTok or YouTube link or use the keyboard below.', mainKeyboard());
    } catch(e){ console.error('start err', e); try{await ctx.reply('Welcome — error logged');}catch(_){} }
  });

  bot.command('dbmode', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('Admin only');
    try {
      const mode = (db && typeof db.isUsingSupabase === 'function' && db.isUsingSupabase()) ? 'supabase' : 'memory (fallback)';
      return ctx.reply(`DB mode: ${mode}`);
    } catch(e){ console.error('/dbmode err', e); return ctx.reply('Could not determine DB mode.'); }
  });

  bot.command('notifications', handleNotificationsCommand);
  bot.command('support', async (ctx)=> {
    const inline = Markup.inlineKeyboard([[ Markup.button.url('Contact admin (WhatsApp)', WHATSAPP_LINK) ]]);
    await ctx.reply(`Support: ${WHATSAPP_LINK}`, inline);
  });
  bot.command('payproof', async (ctx)=>{
    const parts = (ctx.message.text || '').split(/\s+/).slice(1);
    if (!parts.length) return ctx.reply('Usage: /payproof <payment_id>');
    const pid = Number(parts[0]);
    if (!pid) return ctx.reply('Invalid payment id');
    Pending.set(ctx.from.id, { type:'upload_payproof', paymentId: pid });
    return ctx.reply(`Send the proof (photo or link) for payment #${pid}`);
  });
  bot.command('balance', async (ctx)=> {
    const bal = await getUserBalance(ctx.from.id).catch(()=>0);
    return ctx.reply(`Your available comments: *${bal}*`, { parse_mode:'Markdown', reply_markup: mainKeyboard().reply_markup });
  });
  bot.command('favorites', showFavoritesCommand);
  bot.command('my', handleMyComments);

  // handle text
  bot.on('text', async (ctx) => {
    const textRaw = (ctx.message && ctx.message.text) || '';
    const txt = (utils && utils.normalizeInput) ? utils.normalizeInput(textRaw) : (textRaw||'').trim();
    const uid = ctx.from.id;
    let p = Pending.get(uid);

    // cancel on certain inputs
    const labels = ['🎥 add comment','➕ add my video','🔖 track video','🎧 listen comments','💬 my comments','🔎 search','⭐ favorites','🔔 notifications','🛒 buy','🆘 support','💰 balance'];
    const nlower = (txt||'').toString().trim().toLowerCase();
    const isSlash = (textRaw||'').trim().startsWith('/');
    const isCancel = ['cancel','back','ignore','exit'].includes((textRaw||'').trim().toLowerCase());
    if (isSlash || isCancel || labels.includes(nlower)) { if (p) { Pending.delete(uid); p = null; } }

    // keyboard flows
    if (nlower === '🎥 add comment') { Pending.set(uid, { type:'create_thread_public' }); return ctx.reply('Send TikTok/YouTube link for which you want to add a comment.'); }
    if (nlower === '➕ add my video') { Pending.set(uid, { type:'create_thread_owned' }); return ctx.reply('Send the link of your video to track it.'); }
    if (nlower === '🔖 track video') {
      try {
        if (!(await isUsingSupabaseLocal())) return ctx.reply('Persistence unavailable (DB unreachable).');
        const rows = await listThreadsByCreator(ctx.from.id);
        if (!rows || rows.length === 0) return ctx.reply('You have no tracked videos.');
        for (const t of rows) {
          const thumb = thumbnailForThread(t);
          const inline = Markup.inlineKeyboard([[ Markup.button.callback('🎧 Listen Comments', `listen|${t.id}|1`), Markup.button.callback('🎙 Add Voice Comment', `addvoice|${t.id}`) ], [ Markup.button.callback('🗑 Delete tracked', `delete_thread|${t.id}`) ]]);
          if (thumb) await ctx.replyWithPhoto(thumb, { caption: t.social_link, reply_markup: inline.reply_markup });
          else await ctx.reply(t.social_link, inline);
        }
        return;
      } catch(e){ console.error('track video list err',e); return ctx.reply('Could not list tracked videos.'); }
    }
    if (nlower === '🎧 listen comments') { Pending.set(uid, { type:'listen_prompt' }); return ctx.reply('Send the TikTok/YouTube link (or click a tracked video).'); }
    if (nlower === '💬 my comments') return handleMyComments(ctx);
    if (nlower === '⭐ favorites') return showFavoritesCommand(ctx);
    if (nlower === '🔎 search') { Pending.set(uid, { type:'search_prompt' }); return ctx.reply('Send the short code (e.g. 00A1B2) or use /search CODE'); }
    if (nlower === '🔔 notifications') return handleNotificationsCommand(ctx);
    if (nlower === '🛒 buy') {
      const inline = PAYMENT_PACKAGES.map((p, idx)=>([ Markup.button.callback(p.label, `buypkg|${idx}`) ]));
      inline.push([ Markup.button.callback('Contact support (WhatsApp)', 'contact_whatsapp') ]);
      return ctx.reply('Choose a package:', Markup.inlineKeyboard(inline));
    }
    if (nlower === '🆘 support') return ctx.reply(`Support: ${WHATSAPP_LINK}`);
    if (nlower === '💰 balance') {
      const bal = await getUserBalance(ctx.from.id).catch(()=>0);
      return ctx.reply(`Your available comments: *${bal}*`, { parse_mode:'Markdown', reply_markup: mainKeyboard().reply_markup });
    }

    // detect URL
    const maybeUrl = (utils && utils.extractFirstUrl) ? utils.extractFirstUrl(textRaw) : (/\bhttps?:\/\/[^\s]+\b/i.exec(textRaw) || [null])[0];
    if (maybeUrl) {
      try {
        await ensureUserRow(ctx.from).catch(()=>null);
        const creator = (p && p.type === 'create_thread_owned') ? ctx.from.id : null;
        const t = await findOrCreateThread(maybeUrl, creator);
        if (!t || !t.id) return ctx.reply('Thread created (fallback). Try listening again with the same link.', mainKeyboard());
        if (creator && t && t.id && db && db.setThreadCreator) try { await db.setThreadCreator(t.id, creator); } catch(e){}

        // show thumbnail if available
        const thumb = thumbnailForThread(t);
        const inline = Markup.inlineKeyboard([[ Markup.button.callback('🎙 Add Voice Comment', `addvoice|${t.id}`), Markup.button.callback('🎧 Listen Comments', `listen|${t.id}|1`) ]]);
        if (thumb) {
          try { await ctx.replyWithPhoto(thumb, { caption: `Thread created for: ${t.social_link || maybeUrl}`, reply_markup: inline.reply_markup }); } catch(e) { await ctx.reply(`Thread created for: ${t.social_link || maybeUrl}`, inline); }
        } else {
          await ctx.reply(`Thread created for: ${t.social_link || maybeUrl}`, inline);
        }
        return;
      } catch(e){ console.error('direct create thread err', e); return ctx.reply('Error creating thread for that link.'); }
    }

    // search prompt handling
    const pend = Pending.get(uid);
    if (pend && pend.type === 'search_prompt') {
      Pending.delete(uid);
      return handleSearchByCode(ctx, textRaw.trim());
    }

    return ctx.reply(`I didn't detect a supported link or command. Press a button or send a TikTok/YouTube URL.`, mainKeyboard());
  });

  // voice handler
  bot.on('voice', async (ctx) => {
    const uid = ctx.from.id;
    const p = Pending.get(uid);
    if (!p) return ctx.reply('No pending action for voice.', mainKeyboard());

    // reply voice
    if ((p.type === 'reply_choice' || p.type === 'reply_voice') && p.commentId) {
      Pending.delete(uid);
      try {
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found in message.');
        const inserted = await insertReplyRow({
          comment_id: p.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id
        });
        if (inserted && inserted.error) throw inserted.error;
        await ctx.replyWithVoice(voice.file_id, { caption: `↳ Reply by ${ctx.from.first_name || ctx.from.username || 'User'}` });

        // notify owner
        try {
          const comment = await getCommentById(p.commentId);
          if (comment && comment.telegram_id && comment.telegram_id !== uid) {
            const short = encodeShortCode(p.commentId);
            const threadRow = await getThreadById(comment.thread_id);
            const videoLink = threadRow ? threadRow.social_link : '(video unknown)';
            const text = `${ctx.from.first_name || ctx.from.username} replied to your comment.\n${short}\n${videoLink}`;
            await addNotificationRow({ telegram_id: comment.telegram_id, type: 'reply', message: text, meta: { comment_id: p.commentId } }).catch(()=>null);
            try { await bot.telegram.sendMessage(comment.telegram_id, text); } catch(_) {}
          }
        } catch(e){ console.error('notify owner reply err', e); }
        return;
      } catch(e){ console.error('reply_voice handler err', e); return ctx.reply('Could not save voice reply.'); }
    }

    // add comment voice
    if (p.type === 'add_comment' && p.threadId) {
      Pending.delete(uid);
      try {
        if (!(await isUsingSupabaseLocal())) return ctx.reply('Cannot save comment: persistence unavailable (DB unreachable).');
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
        const savedId = row && row.id ? row.id : (row && row.data && row.data.id ? row.data.id : null);
        const code = encodeShortCode(savedId || row.id || '');
        await ctx.reply('✅ Voice saved!');
        await ctx.reply(`${code}`, mainKeyboard());

        // decrement user balance best-effort
        try {
          const dec = await decrementUserBalance(uid, 1).catch(err => ({ error: err && err.message }));
          if (dec && dec.error) {
            console.error('decrementUserBalance reported', dec);
            await ctx.reply('Note: could not decrement your balance (admin will review).');
          }
        } catch (e) { console.error('decrement err', e); }

        // notify tracked owner
        try {
          const threadRow = await getThreadById(p.threadId);
          if (threadRow && threadRow.creator_telegram_id && threadRow.creator_telegram_id !== uid) {
            const notif = `🔔 New voice comment on your tracked video by ${ctx.from.first_name || ctx.from.username}\nVideo: ${threadRow.social_link}\nCode: ${code}`;
            await addNotificationRow({ telegram_id: threadRow.creator_telegram_id, type: 'reply', message: notif, meta: { thread_id: p.threadId, comment_id: savedId } }).catch(()=>null);
            try { await bot.telegram.sendMessage(threadRow.creator_telegram_id, notif); } catch(_) {}
          }
        } catch(e){ console.error('notify tracked owner err', e); }
        return;
      } catch(e){ console.error('add_comment voice save error', e); return ctx.reply('Could not save voice comment (DB error).'); }
    }

    return ctx.reply('No expected action for voice now.', mainKeyboard());
  });

  // photo handler (upload proof)
  bot.on('photo', async (ctx) => {
    const uid = ctx.from.id;
    const p = Pending.get(uid);
    if (!p) return ctx.reply('Photo received but no pending action.');

    if (p.type === 'upload_payproof' && p.paymentId) {
      Pending.delete(uid);
      try {
        const photos = ctx.message.photo || [];
        const largest = photos[photos.length - 1];
        const fileId = largest && largest.file_id;
        const upd = await updatePaymentStatusLocal(p.paymentId, 'proof_submitted', { proof_telegram_file_id: fileId });
        if (upd && upd.error) throw upd.error;
        await ctx.reply(`Proof received for payment #${p.paymentId}. Admins will review.`);
        for (const adm of ADMIN_IDS) {
          try {
            const inline = Markup.inlineKeyboard([[ Markup.button.callback('Approve', `admin_approve|${p.paymentId}`), Markup.button.callback('Reject', `admin_reject|${p.paymentId}`) ]]);
            await bot.telegram.sendPhoto(Number(adm), fileId, { caption: `Payment proof for request #${p.paymentId} by ${uid}`, reply_markup: inline.reply_markup });
          } catch(e){ console.error('notify admin photo err', e); }
        }
      } catch(e){ console.error('upload_payproof photo handler error', e); await ctx.reply('Could not submit proof.'); }
      return;
    }

    return ctx.reply('No matching pending action for photo.');
  });

  // callback queries
  bot.on('callback_query', async (ctx) => {
    try { Pending.delete(ctx.from.id); } catch(_) {}
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
        Pending.set(ctx.from.id, { type:'add_comment', threadId });
        await ctx.answerCbQuery();
        return ctx.reply('Send your voice now to add it to this thread.');
      }

      if (cmd === 'react') {
        const commentId = Number(parts[1]);
        const rType = parts[2];
        try {
          const result = await toggleReactionLocal(ctx.from.id, commentId, rType);
          const inline = await buildActionsInline(commentId, ctx.from.id);
          try {
            const msg = ctx.callbackQuery.message;
            if (msg && msg.chat && msg.message_id) await ctx.telegram.editMessageReplyMarkup(msg.chat.id, msg.message_id, null, inline.reply_markup);
          } catch(e){}
          if (result && result.added) await ctx.answerCbQuery('Reaction added');
          else if (result && result.updated) await ctx.answerCbQuery('Reaction updated');
          else if (result && result.removed) await ctx.answerCbQuery('Reaction removed');
          else await ctx.answerCbQuery('Reaction handled');
        } catch(e){ console.error('react handler err', e); await ctx.answerCbQuery('Could not record reaction'); }
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
          } catch(e){}
        } catch(e){ console.error('fav handler err', e); await ctx.answerCbQuery('Could not toggle favorite'); }
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
        Pending.set(ctx.from.id, { type:'reply_choice', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Reply options:\n• Send voice to add voice reply\n• Send text to add text reply\n(Your next message will be used)');
      }

      if (cmd === 'replyvoice') {
        const commentId = Number(parts[1]);
        Pending.set(ctx.from.id, { type:'reply_voice', commentId });
        await ctx.answerCbQuery('Send voice reply now');
        return ctx.reply('Send voice reply now.');
      }

      if (cmd === 'report') {
        const commentId = Number(parts[1]);
        Pending.set(ctx.from.id, { type:'report_reason', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain why you report this comment.');
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
        } catch(e){ console.error('delete_comment err', e); await ctx.answerCbQuery('Not found or could not delete.'); }
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
        } catch(e){ console.error('delete_reply err', e); await ctx.answerCbQuery('Could not delete reply'); }
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
        } catch(e){ console.error('delete_thread err', e); await ctx.answerCbQuery('Could not delete tracked video'); }
        return;
      }

      // Buy flow
      if (cmd === 'buypkg') {
        const idx = Number(parts[1]);
        const pkg = PAYMENT_PACKAGES[idx];
        if (!pkg) { await ctx.answerCbQuery('Invalid package'); return; }
        const inline = Markup.inlineKeyboard([ [ Markup.button.callback(`Confirm: ${pkg.label}`, `confirm_buy|${idx}`), Markup.button.callback('Cancel', `cancel_buy|${idx}`) ] ]);
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
        try { await bot.telegram.sendMessage(ctx.from.id, `${number}`); } catch(e){ console.error('copy_tel send err', e); }
        return;
      }
      if (cmd === 'copy_acc') {
        const number = parts[1] || '1000555367884';
        await ctx.answerCbQuery('Account sent to chat');
        try { await bot.telegram.sendMessage(ctx.from.id, `${number}`); } catch(e){ console.error('copy_acc send err', e); }
        return;
      }

      if (cmd === 'start_upload_proof') {
        const paymentId = Number(parts[1]);
        if (!paymentId) { await ctx.answerCbQuery('Invalid payment id'); return; }
        Pending.set(ctx.from.id, { type:'upload_payproof', paymentId });
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
          await updatePaymentStatusLocal(paymentId, 'approved');
          const credits = Number(payment.comments_amount || 0) || 0;
          try {
            await creditUser(payment.telegram_id, credits);
          } catch(e){ console.error('creditUser err', e); await ctx.answerCbQuery('Payment approved but crediting failed'); try{ await bot.telegram.sendMessage(payment.telegram_id, `Payment #${paymentId} approved but auto-credit failed. Contact admin.`)}catch(_){} return; }
          await ctx.answerCbQuery('Payment approved & credited');
          try { await bot.telegram.sendMessage(payment.telegram_id, `Your payment #${paymentId} was approved. Credited ${credits} comments.`); } catch(_) {}
          return;
        } catch(e){ console.error('admin_approve err', e); await ctx.answerCbQuery('Error approving payment'); return; }
      }

      if (cmd === 'admin_reject') {
        const paymentId = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          await updatePaymentStatusLocal(paymentId, 'rejected');
          await ctx.answerCbQuery('Payment rejected');
          return;
        } catch(e){ console.error('admin_reject err', e); await ctx.answerCbQuery('Error rejecting payment'); return; }
      }

      if (cmd === 'contact_whatsapp') {
        await ctx.answerCbQuery();
        return ctx.reply(`Contact admin: ${WHATSAPP_LINK}`);
      }

      // admin report actions omitted for brevity (they exist in DB wrapper)
      await ctx.answerCbQuery();
    } catch(e){ console.error('callback top err', e); try{ await ctx.answerCbQuery('Error handling button'); }catch(_){} }
  });

  return bot;
}

module.exports = { initBot };
