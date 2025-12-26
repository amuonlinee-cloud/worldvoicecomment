// src/bot.js
// World Voice Comment — fixed: canonical lookups, balance decrement, replies reporting, favorites link, pending flow fixes

const { Telegraf, Markup } = require('telegraf');
const debugLog = (...args) => console.log('[bot]', ...args);

// Defensive require: database and utils might throw at import, so wrap
let db;
try {
  db = require('./database');
  if (!db) {
    debugLog('Warning: ./database required but returned falsy. Using minimal fallback.');
    db = {};
  }
} catch (e) {
  debugLog('Warning: could not require ./database — using fallback db shim.', e && e.message);
  db = {};
}

let utils;
try {
  utils = require('./utils');
  if (!utils) {
    debugLog('Warning: ./utils required but returned falsy. Using fallback helpers.');
    utils = {};
  }
} catch (e) {
  debugLog('Warning: could not require ./utils — using fallback utils shim.', e && e.message);
  utils = {};
}

// small utils fallbacks
utils.normalizeInput = utils.normalizeInput || function (s) { return (s || '').toString().trim(); };
utils.extractFirstUrl = utils.extractFirstUrl || function (s) {
  if (!s) return null;
  const m = String(s).match(/https?:\/\/[^\s)]+/i);
  return m ? m[0].replace(/[),.]+$/,'') : null;
};
utils.encodeShortCode = utils.encodeShortCode || function (id) {
  if (!id) return '';
  const v = Number(id) || 0;
  return v.toString(36).toUpperCase().padStart(6, '0');
};
utils.decodeShortCode = utils.decodeShortCode || function (code) {
  if (!code) return null;
  try { return parseInt(String(code).toLowerCase(), 36); } catch (e) { return null; }
};
utils.normalizeVideoUrl = utils.normalizeVideoUrl || (async (url) => ({ canonicalLink: url }));
utils.isSupportedLink = utils.isSupportedLink || (s => !!s && /tiktok\.com|youtube\.com|youtu\.be|vm\.tiktok\.com/i.test(s));

// Config from env
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const WHATSAPP_ADMIN = (process.env.WHATSAPP_ADMIN || '').replace(/\D/g,'');
const WHATSAPP_LINK = WHATSAPP_ADMIN ? `https://wa.me/${WHATSAPP_ADMIN}` : null;

if (!BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN env var');
  // don't throw to allow linting; initBot will throw on launch
}

const PAYMENT_PACKAGES = [
  { id: 'pkg1', label: '25 comments - 12 ETB', credits: 25, amount: 12 },
  { id: 'pkg2', label: '60 comments - 27 ETB', credits: 60, amount: 27 },
  { id: 'pkg3', label: '130 comments - 49 ETB', credits: 130, amount: 49 },
  { id: 'pkg4', label: '240 comments - 89 ETB', credits: 240, amount: 89 }
];

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

// Pending actions map
const PendingMap = new Map(); // telegramId => { type: '...', ... }

// SUPABASE checks are done in db wrapper
const safeDb = {}; // we'll wrap db functions to avoid crashes
safeDb.supabase = db && db.supabase ? db.supabase : null;
safeDb.ensureUserRow = db.ensureUserRow || (async (user) => {
  if (!user || !user.id) return null;
  if (safeDb.supabase) {
    try {
      const row = { telegram_id: user.id, username: user.username || null, first_name: user.first_name || null, created_at: new Date().toISOString() };
      const { data, error } = await safeDb.supabase.from('users').upsert(row, { onConflict: ['telegram_id'] }).select().maybeSingle();
      if (error) throw error;
      return data;
    } catch (e) { debugLog('ensureUserRow supabase err', e && e.message); return null; }
  }
  return null;
});

safeDb.findOrCreateThread = db.findOrCreateThread || (async (link, creatorTelegramId = null) => {
  if (!link) throw new Error('Missing link');
  if (safeDb.supabase) {
    try {
      const norm = await utils.normalizeVideoUrl(link).catch(()=>({ canonicalLink: link }));
      // try canonical
      const cand = (norm && norm.canonicalLink) ? norm.canonicalLink : link;
      const { data: found } = await safeDb.supabase.from('threads').select('*').ilike('canonical_link', cand).limit(1).maybeSingle().catch(()=>({ data: null }));
      if (found) return found;
      // fallback insert
      const row = { social_link: link, canonical_link: norm && norm.canonicalLink ? norm.canonicalLink : null, provider: norm && norm.provider ? norm.provider : null, provider_id: norm && norm.id ? String(norm.id) : null, creator_telegram_id: creatorTelegramId || null, created_at: new Date().toISOString() };
      const { data, error } = await safeDb.supabase.from('threads').insert([row]).select().maybeSingle();
      if (error) {
        const { data: re } = await safeDb.supabase.from('threads').select('*').ilike('social_link', link).limit(1).maybeSingle();
        return re || null;
      }
      return data;
    } catch (e) {
      console.error('safe findOrCreateThread err', e && e.message);
      // last resort: return a fake thread
      return { id: Date.now(), social_link: link, created_at: new Date().toISOString(), canonical_link: link };
    }
  }
  // no db
  return { id: Date.now(), social_link: link, created_at: new Date().toISOString(), canonical_link: link };
});

safeDb.getThreadById = db.getThreadById || (async (id) => {
  if (!safeDb.supabase) return null;
  try {
    const { data } = await safeDb.supabase.from('threads').select('*').eq('id', id).limit(1).maybeSingle();
    return data || null;
  } catch (e) { console.error('getThreadById err', e); return null; }
});

safeDb.createPaymentRequest = db.createPaymentRequest || (async (payload) => {
  if (!safeDb.supabase) throw new Error('DB missing');
  const row = Object.assign({ status: 'pending', created_at: new Date().toISOString() }, payload);
  const { data, error } = await safeDb.supabase.from('payment_requests').insert([row]).select().maybeSingle();
  if (error) throw error;
  return data;
});
safeDb.updatePaymentStatus = db.updatePaymentStatus || (async (id, status, updates={}) => {
  if (!safeDb.supabase) throw new Error('DB missing');
  const payload = Object.assign({ status }, updates);
  const { data, error } = await safeDb.supabase.from('payment_requests').update(payload).eq('id', id).select().maybeSingle();
  if (error) throw error;
  return data;
});

safeDb.insertVoiceComment = db.insertVoiceComment || (async (row) => {
  if (!safeDb.supabase) throw new Error('DB missing');
  const insertRow = Object.assign({}, row, { created_at: new Date().toISOString() });
  const { data, error } = await safeDb.supabase.from('voice_comments').insert([insertRow]).select().maybeSingle();
  if (error) throw error;
  return data;
});

safeDb.listCommentsByThread = db.listCommentsByThread || (async (threadId, offset=0, limit=15) => {
  if (!safeDb.supabase) throw new Error('DB missing');
  const { data, error } = await safeDb.supabase.from('voice_comments').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).range(offset, offset+limit-1);
  if (error) throw error;
  return data || [];
});

safeDb.getCommentById = db.getCommentById || (async (id) => {
  if (!safeDb.supabase) return null;
  const { data } = await safeDb.supabase.from('voice_comments').select('*').eq('id', id).limit(1).maybeSingle();
  return data || null;
});

safeDb.insertReplyRow = db.insertReplyRow || (async (row) => {
  if (!safeDb.supabase) throw new Error('DB missing');
  const insertRow = Object.assign({}, row, { created_at: new Date().toISOString() });
  const { data, error } = await safeDb.supabase.from('replies').insert([insertRow]).select().maybeSingle();
  if (error) throw error;
  return data;
});

safeDb.toggleFavoriteRow = db.toggleFavoriteRow || (async (telegramId, commentId) => {
  if (!safeDb.supabase) throw new Error('DB missing');
  const { data: exists } = await safeDb.supabase.from('favorites').select('*').eq('telegram_id', telegramId).eq('comment_id', commentId).limit(1).maybeSingle();
  if (exists) {
    await safeDb.supabase.from('favorites').delete().eq('id', exists.id);
    return { removed: true };
  } else {
    const { data } = await safeDb.supabase.from('favorites').insert([{ telegram_id: telegramId, comment_id: commentId }]).select().maybeSingle();
    return { removed: false, data };
  }
});

safeDb.listFavoritesForUser = db.listFavoritesForUser || (async (telegramId) => {
  if (!safeDb.supabase) return [];
  const { data } = await safeDb.supabase.from('favorites').select('voice_comments(*)').eq('telegram_id', telegramId);
  const arr = (data || []).map(r => r.voice_comments).filter(Boolean);
  return arr;
});

safeDb.insertReactionRow = db.insertReactionRow || (async (row) => {
  if (!safeDb.supabase) throw new Error('DB missing');
  const r = Object.assign({}, row, { created_at: new Date().toISOString() });
  const { data, error } = await safeDb.supabase.from('reactions').insert([r]).select().maybeSingle();
  if (error) throw error;
  return data;
});

safeDb.addNotificationRow = db.addNotificationRow || (async (row) => {
  if (!safeDb.supabase) throw new Error('DB missing');
  const r = Object.assign({}, row, { created_at: new Date().toISOString() });
  const { data, error } = await safeDb.supabase.from('notifications').insert([r]).select().maybeSingle();
  if (error) throw error;
  return data;
});
safeDb.listNotifications = db.listNotifications || (async (telegramId) => {
  if (!safeDb.supabase) return [];
  const { data } = await safeDb.supabase.from('notifications').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(50);
  return data || [];
});

safeDb.insertReport = db.insertReport || (async (row) => {
  if (!safeDb.supabase) throw new Error('DB missing');
  const r = Object.assign({}, row, { created_at: new Date().toISOString(), status: 'open' });
  const { data, error } = await safeDb.supabase.from('reports').insert([r]).select().maybeSingle();
  if (error) throw error;
  return data;
});

safeDb.deleteCommentById = db.deleteCommentById || (async (id) => {
  if (!safeDb.supabase) throw new Error('DB missing');
  await safeDb.supabase.from('voice_comments').delete().eq('id', id);
  await safeDb.supabase.from('replies').delete().eq('comment_id', id);
  return { deleted: true };
});

safeDb.deleteThreadById = db.deleteThreadById || (async (id) => {
  if (!safeDb.supabase) throw new Error('DB missing');
  await safeDb.supabase.from('threads').delete().eq('id', id);
  const { data: comments } = await safeDb.supabase.from('voice_comments').select('id').eq('thread_id', id);
  if (comments && comments.length) for (const c of comments) await safeDb.deleteCommentById(c.id).catch(()=>null);
  return { deleted: true };
});

// helpers
function isAdmin(id) { return ADMIN_IDS.includes(Number(id)); }

async function getUserBalance(telegramId) {
  if (!safeDb.supabase) throw new Error('DB missing');
  const { data } = await safeDb.supabase.from('users').select('free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
  return Number((data && data.free_comments) || 0);
}

async function decrementUserBalance(telegramId, amount = 1) {
  if (!safeDb.supabase) throw new Error('DB missing');
  const { data } = await safeDb.supabase.from('users').select('free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
  const current = Number((data && data.free_comments) || 0);
  if (current < amount) return { error: 'insufficient' };
  const next = current - amount;
  const { data: updated, error } = await safeDb.supabase.from('users').update({ free_comments: next }).eq('telegram_id', telegramId).select().maybeSingle();
  if (error) throw error;
  return updated;
}

// notify admins
async function notifyAdmins(bot, text, opts) {
  for (const adm of ADMIN_IDS) {
    try { await bot.telegram.sendMessage(Number(adm), text, opts); } catch (e) { console.error('notify admin err', e && e.message); }
  }
}

// send comments (paginated)
async function sendCommentsPage(ctx, threadId, page = 1, perPage = 5) {
  try {
    const offset = (page - 1) * perPage;
    const data = await safeDb.listCommentsByThread(threadId, offset, perPage);
    if (!data || data.length === 0) return ctx.reply('No comments yet.');
    for (const c of data) {
      try {
        if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${new Date(c.created_at).toLocaleString()}` });
        else await ctx.reply(`${c.first_name || c.username || 'User'} • ${new Date(c.created_at).toLocaleString()}`);
      } catch (e) {}
      const inline = buildActionsInline(c.id, ctx.from.id);
      await ctx.reply(`Code: ${utils.encodeShortCode(c.id)}`, inline);
    }
    if (data.length === perPage) {
      await ctx.reply('More comments:', Markup.inlineKeyboard([ [ Markup.button.callback('More', `listen|${threadId}|${page+1}`) ] ]));
    }
  } catch (e) {
    console.error('sendCommentsPage error', e);
    return ctx.reply('Error while fetching comments.');
  }
}

// build action inline keyboard for a comment
function buildActionsInline(commentId, userId) {
  const rows = [
    [ Markup.button.callback('❤️', `react|${commentId}|heart`), Markup.button.callback('😂', `react|${commentId}|laugh`), Markup.button.callback('👎', `react|${commentId}|dislike`) ],
    [ Markup.button.callback('☆ Favorite', `fav|${commentId}`), Markup.button.callback('▶️ Show replies', `list_replies|${commentId}|1`), Markup.button.callback('💬 Reply', `replymenu|${commentId}`) ],
    [ Markup.button.callback('🚩 Report', `report|${commentId}`), Markup.button.callback('🗑 Delete', `delete_comment|${commentId}`) ]
  ];
  return Markup.inlineKeyboard(rows);
}

// Handlers
async function handleNotificationsCommand(ctx) {
  try {
    const rows = await safeDb.listNotifications(ctx.from.id);
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
      } catch (e) {}
      await ctx.reply(text);
    }
    await ctx.reply('End of notifications.', mainKeyboard());
  } catch (e) {
    console.error('/notifications db err', e);
    await ctx.reply('Could not fetch notifications.');
  }
}

// start/init
async function initBot() {
  if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in environment');

  const bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    try {
      await safeDb.ensureUserRow(ctx.from).catch(()=>null);
      await ctx.reply('Welcome to World Voice Comment! Send a TikTok or YouTube link or use the keyboard below.', mainKeyboard());
    } catch (e) {
      console.error('onStart err', e);
      try { await ctx.reply('Welcome — initialization error logged.'); } catch (_) {}
    }
  });

  bot.command('support', async (ctx) => {
    try {
      const inline = Markup.inlineKeyboard([
        [Markup.button.url('Contact admin (WhatsApp)', `${WHATSAPP_LINK}`)],
        [Markup.button.callback('Contact admin number', 'contact_whatsapp')]
      ]);
      await ctx.reply(`Support:\nContact admin on WhatsApp: ${WHATSAPP_LINK || '(not configured)'}`, inline);
    } catch (e) {
      console.error('/support err', e);
      await ctx.reply('Support unavailable. Try contacting admin via WhatsApp.');
    }
  });

  bot.command('notifications', handleNotificationsCommand);

  // BUY flow: show packages -> confirm/cancel -> create payment -> show copy/paste + upload proof
  bot.hears(/🛒 buy|^buy$/i, async (ctx) => {
    try {
      PendingMap.delete(ctx.from.id);
      const rows = PAYMENT_PACKAGES.map(p => [ Markup.button.callback(p.label, `select_pkg|${p.id}`) ]);
      rows.push([ Markup.button.callback('Contact support', 'contact_whatsapp') ]);
      await ctx.reply('Choose a package:', Markup.inlineKeyboard(rows));
    } catch (e) { console.error('buy hears err', e); await ctx.reply('Could not show packages.'); }
  });

  bot.on('text', async (ctx) => {
    const text = (ctx.message && ctx.message.text) || '';
    const uid = ctx.from.id;
    // cancel pending if user presses a main keyboard label
    const normalized = text.trim().toLowerCase();
    const mainLabels = ['🎥 add comment','➕ add my video','🔖 track video','🎧 listen comments','💬 my comments','🔎 search','⭐ favorites','🔔 notifications','🛒 buy','🆘 support','💰 balance'];
    if (mainLabels.includes(normalized)) {
      PendingMap.delete(uid);
    }

    // handle pending flows first
    const pending = PendingMap.get(uid);

    // report reason pending
    if (pending && pending.type === 'await_report_reason' && pending.commentId) {
      PendingMap.delete(uid);
      const reason = text.trim();
      try {
        await safeDb.insertReport({ reporter_telegram_id: uid, comment_id: pending.commentId, reason });
      } catch (e) { console.error('insertReport err', e); }
      const comment = await safeDb.getCommentById(pending.commentId).catch(()=>null);
      const thread = comment ? await safeDb.getThreadById(comment.thread_id).catch(()=>null) : null;
      const header = `🚨 Report: ${utils.encodeShortCode(pending.commentId)}\nReporter: ${ctx.from.username || ctx.from.first_name} (${uid})\nReason: ${reason}\nVideo: ${thread ? (thread.social_link || thread.canonical_link) : '(unknown)'}`;
      try {
        for (const adm of ADMIN_IDS) {
          if (comment && comment.telegram_file_id) {
            await bot.telegram.sendVoice(Number(adm), comment.telegram_file_id, { caption: header });
          } else {
            await bot.telegram.sendMessage(Number(adm), header);
          }
        }
      } catch (e) { console.error('notify admin report err', e); }
      await ctx.reply('Thank you. Your report was sent to admins.');
      return;
    }

    // search code pending
    if (pending && pending.type === 'await_search_code') {
      PendingMap.delete(uid);
      const code = text.trim();
      const id = utils.decodeShortCode(code);
      if (!id) return ctx.reply('Invalid code.');
      const comment = await safeDb.getCommentById(id).catch(()=>null);
      if (!comment) return ctx.reply('Comment not found.');
      if (comment.telegram_file_id) await ctx.replyWithVoice(comment.telegram_file_id, { caption: `Comment ${code}` });
      else await ctx.reply(`Comment ${code} (no voice).`);
      return;
    }

    // pending upload proof (text)
    if (pending && pending.type === 'await_upload_proof' && pending.paymentId) {
      PendingMap.delete(uid);
      try {
        await safeDb.updatePaymentStatus(pending.paymentId, 'proof_submitted', { proof_link: text.trim() });
        for (const adm of ADMIN_IDS) await bot.telegram.sendMessage(Number(adm), `Payment proof for #${pending.paymentId} received: ${text.trim()}`);
        await ctx.reply('Proof received. Admins will review.');
      } catch (e) { console.error('upload proof text err', e); await ctx.reply('Could not submit proof.'); }
      return;
    }

    // if message contains a link -> create/find thread and show options
    const candidateUrl = utils.extractFirstUrl(text);
    if (candidateUrl) {
      try {
        const thread = await safeDb.findOrCreateThread(candidateUrl, null);
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('🎙 Add Voice Comment', `addvoice|${thread.id}`), Markup.button.callback('🎧 Listen Comments', `listen|${thread.id}|1`) ]
        ]);
        // try to include thumbnail if normalize returned one (we attempt to normalize)
        let norm = null;
        try { norm = await utils.normalizeVideoUrl(candidateUrl); } catch (_) { norm = null; }
        if (norm && norm.thumbnail) {
          await ctx.replyWithPhoto(norm.thumbnail, { caption: `Thread: ${thread.social_link || thread.canonical_link || candidateUrl}` });
        } else {
          await ctx.reply(`Thread: ${thread.social_link || thread.canonical_link || candidateUrl}`);
        }
        await ctx.reply('What next?', inline);
      } catch (e) {
        console.error('create/find thread err', e);
        await ctx.reply('Could not create thread (DB error).');
      }
      return;
    }

    // main keyboard actions by text
    if (/^\s*🎥 add comment\s*$|^add comment$/i.test(text)) {
      PendingMap.set(uid, { type: 'await_link_for_add' });
      return ctx.reply('Send the TikTok/YouTube link for which you want to add a voice comment.');
    }
    if (/^\s*➕ add my video\s*$|^add my video$/i.test(text)) {
      PendingMap.set(uid, { type: 'await_link_track' });
      return ctx.reply('Send the link of your own video to track.');
    }
    if (/^\s*🔖 track video\s*$|^track video$/i.test(text)) {
      try {
        const threads = await safeDb.supabase ? await safeDb.supabase.from('threads').select('*').eq('creator_telegram_id', ctx.from.id).order('created_at', { ascending: false }) : { data: [] };
        const rows = (threads && threads.data) ? threads.data : (Array.isArray(threads) ? threads : []);
        if (!rows || rows.length === 0) return ctx.reply('You have not tracked any videos yet.');
        for (const t of rows) {
          const inline = Markup.inlineKeyboard([ [ Markup.button.callback('🎧 Listen Comments', `listen|${t.id}|1`), Markup.button.callback('🗑 Delete tracked', `delete_thread|${t.id}`) ] ]);
          await ctx.reply(`${t.social_link || t.canonical_link || '(no link)'} (tracked)`, inline);
        }
      } catch (e) { console.error('track list err', e); return ctx.reply('Could not list tracked videos.'); }
      return;
    }
    if (/^\s*🎧 listen comments\s*$|^listen comments$/i.test(text)) {
      PendingMap.set(uid, { type: 'await_link_for_listen' });
      return ctx.reply('Send a TikTok/YouTube link or click a tracked video to listen comments.');
    }
    if (/^\s*💬 my comments\s*$|^my comments$/i.test(text)) {
      try {
        if (!safeDb.supabase) return ctx.reply('Persistence unavailable (DB unreachable).');
        const { data, error } = await safeDb.supabase.from('voice_comments').select('*').eq('telegram_id', ctx.from.id).order('created_at', { ascending: false }).limit(30);
        if (error) throw error;
        if (!data || data.length === 0) return ctx.reply('You have no comments yet.');
        for (const c of data) {
          if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'You'} • ${new Date(c.created_at).toLocaleString()}` });
          else await ctx.reply('Comment: (no voice saved)');
          const inline = buildActionsInline(c.id, ctx.from.id);
          await ctx.reply(`Code: ${utils.encodeShortCode(c.id)}`, inline);
          const thr = await safeDb.getThreadById(c.thread_id).catch(()=>null);
          if (thr) await ctx.reply(`Video: ${thr.social_link || thr.canonical_link || '(unknown)'}`);
        }
        await ctx.reply('End of your comments.', mainKeyboard());
      } catch (e) { console.error('/my comments error', e); await ctx.reply('Could not fetch your comments.'); }
      return;
    }
    if (/^\s*⭐ favorites\s*$|^favorites$/i.test(text)) {
      try {
        const favs = await safeDb.listFavoritesForUser(ctx.from.id);
        if (!favs || favs.length === 0) return ctx.reply('No favorites.');
        for (const f of favs) {
          if (f.telegram_file_id) await ctx.replyWithVoice(f.telegram_file_id, { caption: `Favorite ${utils.encodeShortCode(f.id)}` });
          else await ctx.reply(`Favorite ${utils.encodeShortCode(f.id)}`);
          await ctx.reply('Options:', buildActionsInline(f.id, ctx.from.id));
        }
      } catch (e) { console.error('favorites err', e); await ctx.reply('Could not fetch favorites.'); }
      return;
    }
    if (/^\s*🔎 search\s*$|^search$/i.test(text)) {
      PendingMap.set(uid, { type: 'await_search_code' });
      return ctx.reply('Send the short code (e.g. 0000A9) or /search CODE');
    }
    if (/^\s*💰 balance\s*$|^balance$/i.test(text)) {
      try {
        if (!safeDb.supabase) return ctx.reply('Persistence unavailable (DB unreachable).');
        const b = await getUserBalance(ctx.from.id);
        return ctx.reply(`Your balance: *${b}*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard().reply_markup });
      } catch (e) { console.error('balance err', e); return ctx.reply('Could not fetch balance.'); }
    }

    // pending link for add comment
    if (pending && pending.type === 'await_link_for_add') {
      PendingMap.delete(uid);
      const url = candidateUrl || text;
      if (!url) return ctx.reply('No link detected.');
      try {
        const thread = await safeDb.findOrCreateThread(url, null);
        PendingMap.set(uid, { type: 'await_add_comment_voice', threadId: thread.id });
        return ctx.reply('Now send the voice message to add as a comment to that video.');
      } catch (e) { console.error('await_link_for_add err', e); return ctx.reply('Could not prepare adding comment.'); }
    }

    if (pending && pending.type === 'await_link_track') {
      PendingMap.delete(uid);
      const url = candidateUrl || text;
      if (!url) return ctx.reply('No link detected.');
      try {
        const t = await safeDb.findOrCreateThread(url, ctx.from.id);
        return ctx.reply('Video tracked. You will be notified on replies.');
      } catch (e) { console.error('track err', e); return ctx.reply('Could not track video.'); }
    }

    if (pending && pending.type === 'await_link_for_listen') {
      PendingMap.delete(uid);
      const url = candidateUrl || text;
      if (!url) return ctx.reply('No link detected.');
      try {
        const thread = await safeDb.getThreadByLink ? await safeDb.getThreadByLink(url) : await safeDb.findOrCreateThread(url, null);
        if (!thread) return ctx.reply('No comments for that video yet.');
        await sendCommentsPage(ctx, thread.id, 1);
      } catch (e) { console.error('listen err', e); await ctx.reply('Could not list comments.'); }
      return;
    }

    return ctx.reply('I did not understand that. Press a button or send a video link.', mainKeyboard());
  });

  // photos (upload proof)
  bot.on('photo', async (ctx) => {
    try {
      const uid = ctx.from.id;
      const pending = PendingMap.get(uid);
      if (!pending) return ctx.reply('No matching pending action for photo.', mainKeyboard());
      // upload proof
      if (pending.type === 'await_upload_proof' && pending.paymentId) {
        PendingMap.delete(uid);
        const photos = ctx.message.photo || [];
        const best = photos[photos.length - 1];
        if (!best) return ctx.reply('No photo found.');
        await safeDb.updatePaymentStatus(pending.paymentId, 'proof_submitted', { proof_telegram_file_id: best.file_id }).catch(e => { throw e; });
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendPhoto(Number(adm), best.file_id, { caption: `Payment proof for #${pending.paymentId} by ${ctx.from.id}` }); } catch(e) {}
        }
        return ctx.reply('Proof received. Admins will review.');
      }
      return ctx.reply('No matching pending action for photo.', mainKeyboard());
    } catch (e) { console.error('photo handler err', e); return ctx.reply('Photo handling error.'); }
  });

  // voice messages
  bot.on('voice', async (ctx) => {
    try {
      const uid = ctx.from.id;
      const pending = PendingMap.get(uid);
      if (!pending) return ctx.reply('No expected action for voice now.');
      const voice = ctx.message && ctx.message.voice;
      if (!voice) return ctx.reply('No voice found.');

      if (pending.type === 'await_add_comment_voice' && pending.threadId) {
        PendingMap.delete(uid);
        const inserted = await safeDb.insertVoiceComment({
          thread_id: pending.threadId,
          telegram_id: uid,
          username: ctx.from.username || null,
          first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id,
          duration: voice.duration || 0
        });
        // decrement balance
        try { await decrementUserBalance(uid, 1).catch(()=>null); } catch(_) {}
        const id = inserted && inserted.id ? inserted.id : null;
        await ctx.reply('Voice comment saved. Code: ' + utils.encodeShortCode(id), mainKeyboard());
        // notify thread creator if tracked
        const thread = await safeDb.getThreadById(pending.threadId).catch(()=>null);
        if (thread && thread.creator_telegram_id && thread.creator_telegram_id !== uid) {
          await safeDb.addNotificationRow({ telegram_id: thread.creator_telegram_id, message: `New comment on your tracked video: ${utils.encodeShortCode(id)}`, meta: { comment_id: id } }).catch(()=>null);
        }
        return;
      }

      if (pending.type === 'reply_voice' && pending.commentId) {
        PendingMap.delete(uid);
        const inserted = await safeDb.insertReplyRow({
          comment_id: pending.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id,
          duration: voice.duration || 0
        });
        // decrement
        try { await decrementUserBalance(uid, 1).catch(()=>null); } catch(_) {}
        await ctx.replyWithVoice(voice.file_id, { caption: `Reply saved • ${utils.encodeShortCode(inserted.id)}` });
        const comment = await safeDb.getCommentById(pending.commentId).catch(()=>null);
        if (comment && comment.telegram_id && comment.telegram_id !== uid) {
          await safeDb.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply to your comment ${utils.encodeShortCode(comment.id)}`, meta: { comment_id: comment.id } }).catch(()=>null);
        }
        return;
      }

      if (pending.type === 'report_reply_voice' && pending.replyId) {
        PendingMap.delete(uid);
        await safeDb.insertReport({ reporter_telegram_id: uid, reply_id: pending.replyId, report_telegram_file_id: voice.file_id }).catch(()=>null);
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendVoice(Number(adm), voice.file_id, { caption: `Reply report: reply #${pending.replyId} by ${ctx.from.username || ctx.from.first_name}` }); } catch(e) {}
        }
        return ctx.reply('Voice report submitted. Admins will review.');
      }

      return ctx.reply('No expected action for voice now.');
    } catch (e) { console.error('voice handler err', e); return ctx.reply('Could not handle voice.'); }
  });

  // callback_query
  bot.on('callback_query', async (ctx) => {
    try {
      // cancel pending on any callback (user intent overrides)
      PendingMap.delete(ctx.from.id);
      const data = ctx.callbackQuery && ctx.callbackQuery.data;
      if (!data) return ctx.answerCbQuery();
      const parts = data.split('|');
      const cmd = parts[0];

      if (cmd === 'contact_whatsapp') {
        await ctx.answerCbQuery();
        return ctx.reply(WHATSAPP_LINK || 'WhatsApp not configured.');
      }

      if (cmd === 'select_pkg') {
        const pkgId = parts[1];
        const pkg = PAYMENT_PACKAGES.find(p => p.id === pkgId);
        if (!pkg) return ctx.answerCbQuery('Invalid package');
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback(`Confirm ${pkg.label}`, `confirm_pkg|${pkg.id}`), Markup.button.callback('Cancel', 'cancel_action') ]
        ]);
        await ctx.reply(`You selected ${pkg.label}. Confirm to get payment details.`, inline);
        return ctx.answerCbQuery();
      }

      if (cmd === 'confirm_pkg') {
        const pkgId = parts[1];
        const pkg = PAYMENT_PACKAGES.find(p => p.id === pkgId);
        if (!pkg) return ctx.answerCbQuery('Invalid package');
        try {
          const created = await safeDb.createPaymentRequest({ telegram_id: ctx.from.id, package_name: pkg.label, comments_amount: pkg.credits, amount: pkg.amount, status: 'pending' });
          const pid = created && created.id ? created.id : Date.now();
          const telebirr = '0962058608';
          const cbeAcc = '1000555367884';
          const txt = `Payment #${pid}\nTELEBIRR: ${telebirr}\nCBE: ${cbeAcc}\nAmount: ${pkg.amount} ETB\nAfter payment press Upload Proof and send screenshot or use /payproof ${pid}`;
          const inline = Markup.inlineKeyboard([
            [ Markup.button.callback('Copy TELEBIRR', `copy|${telebirr}`), Markup.button.callback('Copy CBE', `copy|${cbeAcc}`) ],
            [ Markup.button.callback('Upload Proof', `upload_proof|${pid}`) ],
            [ Markup.button.url('Contact admin', WHATSAPP_LINK || 'https://t.me/' + (ADMIN_IDS[0] || '')) ]
          ]);
          await ctx.reply(txt);
          await ctx.reply('Payment options:', inline);
          for (const adm of ADMIN_IDS) {
            try { await bot.telegram.sendMessage(Number(adm), `New payment request #${pid} by ${ctx.from.id} — ${pkg.label}`); } catch(e) {}
          }
        } catch (e) {
          console.error('createPaymentRequestFlow err', e);
          await ctx.reply('Could not create payment request. Contact support.');
        }
        return ctx.answerCbQuery();
      }

      if (cmd === 'copy') {
        await ctx.answerCbQuery('Copied (sent as message)');
        await ctx.reply(`Copied: ${parts[1]}`);
        return;
      }

      if (cmd === 'upload_proof') {
        const pid = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'await_upload_proof', paymentId: pid });
        await ctx.reply(`Send the proof image or paste the link for payment #${pid}.`);
        return ctx.answerCbQuery();
      }

      if (cmd === 'addvoice') {
        const threadId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'await_add_comment_voice', threadId });
        await ctx.reply('Send voice to add as comment.');
        return ctx.answerCbQuery();
      }

      if (cmd === 'listen') {
        const threadId = Number(parts[1]);
        const page = Number(parts[2] || 1);
        await sendCommentsPage(ctx, threadId, page);
        return ctx.answerCbQuery();
      }

      if (cmd === 'replymenu') {
        const commentId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'reply_choice', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Reply options:\n• Send voice to add voice reply\n• Send text to add text reply\n(Your next message will be used)');
      }

      if (cmd === 'reply_voice') {
        const commentId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'reply_voice', commentId });
        await ctx.answerCbQuery('Send voice reply now');
        return ctx.reply('🎙 Send your voice reply now.');
      }
      if (cmd === 'reply_text') {
        const commentId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'reply_text', commentId });
        await ctx.answerCbQuery('Send reply text now');
        return ctx.reply('✍️ Send your reply text now.');
      }
      if (cmd === 'report') {
        const commentId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'await_report_reason', commentId });
        await ctx.reply('Please explain why you are reporting this comment (short text).');
        return ctx.answerCbQuery();
      }

      if (cmd === 'delete_comment') {
        const commentId = Number(parts[1]);
        const comment = await safeDb.getCommentById(commentId).catch(()=>null);
        if (!comment) { await ctx.answerCbQuery('Comment not found'); return; }
        if (comment.telegram_id === ctx.from.id || isAdmin(ctx.from.id)) {
          await safeDb.deleteCommentById(commentId).catch(e => console.error('delete comment err', e));
          await ctx.reply('Comment deleted.');
        } else {
          await ctx.answerCbQuery('Not authorized');
        }
        return ctx.answerCbQuery();
      }

      if (cmd === 'react') {
        const commentId = Number(parts[1]);
        const type = parts[2];
        try {
          await safeDb.insertReactionRow({ comment_id: commentId, telegram_id: ctx.from.id, type });
          await ctx.answerCbQuery('Reaction saved');
        } catch (e) { console.error('react insert err', e); await ctx.answerCbQuery('Could not save reaction'); }
        return;
      }

      if (cmd === 'fav') {
        const commentId = Number(parts[1]);
        try {
          const res = await safeDb.toggleFavoriteRow(ctx.from.id, commentId);
          await ctx.answerCbQuery(res.removed ? 'Favorite removed' : 'Favorite added');
        } catch (e) { console.error('fav err', e); await ctx.answerCbQuery('Could not toggle favorite'); }
        return;
      }

      if (cmd === 'delete_thread') {
        const tid = Number(parts[1]);
        const thread = await safeDb.getThreadById(tid).catch(()=>null);
        if (!thread) { await ctx.answerCbQuery('Not found'); return; }
        if (thread.creator_telegram_id === ctx.from.id || isAdmin(ctx.from.id)) {
          await safeDb.deleteThreadById(tid).catch(e => console.error('delete thread err', e));
          await ctx.reply('Tracked video deleted.');
        } else await ctx.answerCbQuery('Not authorized');
        return ctx.answerCbQuery();
      }

      if (cmd === 'cancel_action') {
        PendingMap.delete(ctx.from.id);
        await ctx.reply('Action cancelled.', mainKeyboard());
        return ctx.answerCbQuery('Cancelled');
      }

      if (cmd === 'list_replies') {
        const commentId = Number(parts[1]);
        await ctx.answerCbQuery();
        return showRepliesForComment(ctx, commentId);
      }

      // admin actions
      if (cmd === 'admin_delete_comment') {
        const commentId = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          await safeDb.deleteCommentById(commentId).catch(e => { throw e; });
          await ctx.answerCbQuery('Comment deleted');
          return ctx.reply(`Comment #${commentId} deleted by admin.`);
        } catch (e) { console.error('admin_delete_comment err', e); await ctx.answerCbQuery('Could not delete comment'); return; }
      }
    } catch (err) {
      console.error('callback_query err', err && (err.stack || err));
      try { await ctx.answerCbQuery('Error'); } catch (_) {}
    }
  });

  // text handler for reply_text pending
  bot.on('text', async (ctx) => {
    const uid = ctx.from.id;
    const pending = PendingMap.get(uid);
    if (!pending) return;
    if (pending.type === 'reply_text' && pending.commentId) {
      PendingMap.delete(uid);
      try {
        const inserted = await safeDb.insertReplyRow({
          comment_id: pending.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          reply_text: ctx.message.text
        });
        try { await decrementUserBalance(uid, 1).catch(()=>null); } catch(_) {}
        await ctx.reply('Reply saved.');
        const comment = await safeDb.getCommentById(pending.commentId).catch(()=>null);
        if (comment && comment.telegram_id && comment.telegram_id !== uid) {
          await safeDb.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply to your comment ${utils.encodeShortCode(comment.id)}`, meta: { comment_id: comment.id } }).catch(()=>null);
        }
      } catch (e) { console.error('reply_text insert err', e); await ctx.reply('Could not save reply text.'); }
    }
  });

  // helper to show replies
  async function showRepliesForComment(ctx, commentId) {
    try {
      const replies = await safeDb.listReplies ? await safeDb.listReplies(commentId) : [];
      if (!replies || replies.length === 0) return ctx.reply('No replies yet.');
      for (const r of replies) {
        if (r.telegram_file_id) {
          try { await ctx.replyWithVoice(r.telegram_file_id, { caption: `${r.replier_first_name || r.replier_username || 'User'}` }); } catch (e) {}
        } else {
          await ctx.reply(`${r.replier_first_name || r.replier_username || 'User'}: ${r.reply_text || '(no text)'}`);
        }
      }
      await ctx.reply('End of replies.');
    } catch (e) { console.error('showRepliesForComment error', e); await ctx.reply('Error listing replies.'); }
  }

  // Expose bot
  return bot;
}

module.exports = { initBot };
