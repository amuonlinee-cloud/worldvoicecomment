// src/bot.js
// Updated bot implementing:
// - replies UI: reply items show only reaction, code, report (no reply button)
// - "Show replies (N)" displays number of replies and paginates 5 per page
// - code messages show only the short code (e.g. 0000W)
// - robust report flow: if DB insert fails still notify admins and confirm to user
// - favorites & search show video thumbnail + link if available
// - tracking: findOrCreateThread updates thread.creator_telegram_id when user tracks an existing thread
// - uses src/database.js and src/utils.js

const { Telegraf, Markup } = require('telegraf');
const db = require('./database');   // must export supabase and helper functions
const utils = require('./utils');   // must export normalizeVideoUrl, extractFirstUrl, encodeShortCode, decodeShortCode
const debug = (...args) => console.log('[bot]', ...args);

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
  return Markup.keyboard([
    ['🎥 Add Comment', '➕ Add My Video'],
    ['🔖 Track Video', '🎧 Listen Comments'],
    ['💬 My Comments', '🔎 Search'],
    ['⭐ Favorites', '🔔 Notifications'],
    ['🛒 Buy', '🆘 Support'],
    ['💰 Balance']
  ], { columns: 2 }).resize();
}

// Pending actions map: telegramId -> pending object
const Pending = new Map();

function isAdmin(id) { return ADMIN_IDS.includes(Number(id)); }

// Get replies count for a comment
async function getRepliesCount(commentId) {
  try {
    const res = await db.supabase.from('replies').select('id', { count: 'exact' }).eq('comment_id', commentId);
    if (res && typeof res.count === 'number') return Number(res.count);
    // fallback: fetch rows and count
    const { data } = await db.supabase.from('replies').select('id').eq('comment_id', commentId);
    return (data || []).length;
  } catch (e) {
    console.error('getRepliesCount err', e);
    return 0;
  }
}

// Get reaction counts (simple client-side aggregate)
async function getReactionCounts(commentId) {
  try {
    const { data } = await db.supabase.from('reactions').select('type').eq('comment_id', commentId);
    const counts = {};
    (data || []).forEach(r => { counts[r.type] = (counts[r.type] || 0) + 1; });
    return counts;
  } catch (e) {
    console.error('getReactionCounts err', e);
    return {};
  }
}

// Build inline keyboard under the CODE message (for a comment)
async function buildCodeInline(commentId, ctxUserId) {
  const rCounts = await getReactionCounts(commentId);
  const heart = `❤️ ${rCounts.heart || 0}`;
  const laugh = `😂 ${rCounts.laugh || 0}`;
  const dislike = `👎 ${rCounts.dislike || 0}`;

  // replies count for button label
  const repliesCount = await getRepliesCount(commentId);
  const showRepliesLabel = `Show replies (${repliesCount})`;

  const rows = [
    [ Markup.button.callback(heart, `react|${commentId}|heart`), Markup.button.callback(laugh, `react|${commentId}|laugh`), Markup.button.callback(dislike, `react|${commentId}|dislike`) ],
    [ Markup.button.callback('☆ Favorite', `fav|${commentId}`), Markup.button.callback('▶️ ' + showRepliesLabel, `list_replies|${commentId}|1`) ],
    [ Markup.button.callback('🚩 Report', `report|${commentId}`) ]
  ];
  if (isAdmin(ctxUserId)) rows.push([ Markup.button.callback('🗑 Admin Delete', `admin_delete_comment|${commentId}`) ]);
  return Markup.inlineKeyboard(rows);
}

// Build inline for a reply (only reaction and report, no reply button)
function buildReplyInline(replyId, ctxUserId, commentId) {
  const rows = [
    [ Markup.button.callback('❤️', `rreact|${replyId}|heart`), Markup.button.callback('🚩 Report', `rreport|${replyId}|${commentId}`) ]
  ];
  if (isAdmin(ctxUserId)) rows.push([ Markup.button.callback('🗑 Admin Delete Reply', `admin_delete_reply|${replyId}`) ]);
  return Markup.inlineKeyboard(rows);
}

// Refresh inline keyboard counts (try edit)
async function refreshCodeInline(ctx, commentId) {
  try {
    const inline = await buildCodeInline(commentId, ctx.from.id);
    try { await ctx.editMessageReplyMarkup(inline.reply_markup); } catch (e) { /* ignore non-editable messages */ }
  } catch (e) { console.error('refreshCodeInline err', e); }
}

// Helper ensure user
async function ensureUser(user) {
  try { return await db.ensureUserRow(user); } catch (e) { console.error('ensureUser err', e); }
}

// Balance helpers
async function getBalance(telegramId) {
  try {
    const { data } = await db.supabase.from('users').select('free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
    return Number((data && data.free_comments) || 0);
  } catch (e) { console.error('getBalance err', e); throw e; }
}
async function creditUser(telegramId, amount) {
  try {
    const { data } = await db.supabase.from('users').select('free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
    const current = Number((data && data.free_comments) || 0);
    const next = current + Number(amount || 0);
    const { data: updated, error } = await db.supabase.from('users').update({ free_comments: next }).eq('telegram_id', telegramId).select().maybeSingle();
    if (error) throw error;
    return updated;
  } catch (e) { console.error('creditUser err', e); throw e; }
}
async function debitUser(telegramId, amount) {
  try {
    const { data } = await db.supabase.from('users').select('free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
    const current = Number((data && data.free_comments) || 0);
    if (current < amount) return { error: 'insufficient' };
    const next = current - amount;
    const { data: updated, error } = await db.supabase.from('users').update({ free_comments: next }).eq('telegram_id', telegramId).select().maybeSingle();
    if (error) throw error;
    return updated;
  } catch (e) { console.error('debitUser err', e); throw e; }
}

// Send a page of comments for a thread
async function sendCommentsPage(ctx, threadId, page = 1, perPage = 5) {
  try {
    const offset = (page - 1) * perPage;
    const { data: comments, error } = await db.supabase.from('voice_comments').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).range(offset, offset + perPage - 1);
    if (error) throw error;
    if (!comments || comments.length === 0) return ctx.reply('No comments yet.', MAIN_KB());
    for (const c of comments) {
      if (c.telegram_file_id) {
        try { await ctx.replyWithVoice(c.telegram_file_id); } catch (e) {}
      } else {
        await ctx.reply(c.reply_text || '(no voice)');
      }
      // send CODE as plain code (only the code text) with keyboard
      const code = utils.encodeShortCode(c.id);
      const inline = await buildCodeInline(c.id, ctx.from.id);
      await ctx.reply(`${code}`, inline);
    }
    // pagination: check total comments for the thread
    const countRes = await db.supabase.from('voice_comments').select('id', { count: 'exact' }).eq('thread_id', threadId);
    const total = (countRes && countRes.count) ? Number(countRes.count) : 0;
    if (offset + perPage < total) {
      await ctx.reply('More comments:', Markup.inlineKeyboard([ [ Markup.button.callback('More', `listen|${threadId}|${page+1}`) ] ]));
    }
  } catch (e) {
    console.error('sendCommentsPage err', e);
    await ctx.reply('Could not list comments.');
  }
}

// Init bot
async function initBot() {
  const bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    try {
      await ensureUser(ctx.from);
      const bal = await getBalance(ctx.from.id).catch(()=>0);
      await ctx.reply(`Welcome! You have *${bal}* comments available.`, { parse_mode: 'Markdown' });
      await ctx.reply('Use the keyboard below.', MAIN_KB());
    } catch (e) {
      console.error('start err', e);
      await ctx.reply('Welcome. (error reading balance)');
      await ctx.reply('Use the keyboard below.', MAIN_KB());
    }
  });

  bot.command('support', async (ctx) => {
    try { await ctx.reply(WHATSAPP_LINK ? `Contact admin via WhatsApp: ${WHATSAPP_LINK}` : 'Contact admin (WhatsApp not configured).'); } catch (e) {}
  });

  bot.command('notifications', async (ctx) => {
    try {
      const rows = await db.listNotifications(ctx.from.id);
      if (!rows || rows.length === 0) return ctx.reply('No notifications.');
      for (const n of rows.slice(0,5)) await ctx.reply(n.message || '(notification)');
    } catch (e) { console.error('notifications err', e); await ctx.reply('Could not fetch notifications.'); }
  });

  // Buy handler
  bot.hears(/🛒 buy|^buy$/i, async (ctx) => {
    try {
      Pending.delete(ctx.from.id);
      const inline = PAYMENT_PACKAGES.map(p => [ Markup.button.callback(p.label, `select_pkg|${p.id}`) ]);
      inline.push([ Markup.button.callback('Contact support', 'contact_whatsapp') ]);
      await ctx.reply('Choose a package:', Markup.inlineKeyboard(inline));
    } catch (e) { console.error('buy show err', e); await ctx.reply('Could not show packages.'); }
  });

  // text handling (main)
  bot.on('text', async (ctx) => {
    const txt = (ctx.message && ctx.message.text) || '';
    const uid = ctx.from.id;
    const normalized = txt.trim().toLowerCase();
    const mainLabels = ['🎥 add comment','➕ add my video','🔖 track video','🎧 listen comments','💬 my comments','🔎 search','⭐ favorites','🔔 notifications','🛒 buy','🆘 support','💰 balance'];
    if (mainLabels.includes(normalized)) Pending.delete(uid);

    const pending = Pending.get(uid);

    // Report reason for comment
    if (pending && pending.type === 'await_report_reason' && pending.commentId) {
      Pending.delete(uid);
      const reason = txt.trim();
      try {
        await db.insertReport({ reporter_telegram_id: uid, comment_id: pending.commentId, reason });
        // notify admins with voice preview if available
        const comment = await db.getCommentById(pending.commentId).catch(()=>null);
        const thread = comment ? await db.getThreadById(comment.thread_id).catch(()=>null) : null;
        const header = `🚨 Report: ${utils.encodeShortCode(pending.commentId)}\nReporter: ${ctx.from.username || ctx.from.first_name} (${uid})\nReason: ${reason}\nVideo: ${thread ? (thread.social_link || thread.canonical_link) : '(unknown)'}`;
        for (const adm of ADMIN_IDS) {
          try {
            if (comment && comment.telegram_file_id) await bot.telegram.sendVoice(adm, comment.telegram_file_id, { caption: header });
            else await bot.telegram.sendMessage(adm, header);
          } catch (e) { console.error('notify admin report err', e); }
        }
        return ctx.reply('Thank you — your report was sent to admins.');
      } catch (err) {
        // If DB insert fails, still notify admins and confirm to user
        console.error('insertReport err', err);
        try {
          const comment = await db.getCommentById(pending.commentId).catch(()=>null);
          const thread = comment ? await db.getThreadById(comment.thread_id).catch(()=>null) : null;
          const header = `🚨 Report (DB failed to save): ${utils.encodeShortCode(pending.commentId)}\nReporter: ${ctx.from.username || ctx.from.first_name} (${uid})\nReason: ${reason}\nVideo: ${thread ? (thread.social_link || thread.canonical_link) : '(unknown)'}`;
          for (const adm of ADMIN_IDS) {
            try {
              if (comment && comment.telegram_file_id) await bot.telegram.sendVoice(adm, comment.telegram_file_id, { caption: header });
              else await bot.telegram.sendMessage(adm, header);
            } catch (e) {}
          }
        } catch (e2) { console.error('notify admin fallback err', e2); }
        return ctx.reply('Report submitted (could not save locally, admins were notified).');
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
        return ctx.reply('Thank you — your reply report was sent to admins.');
      } catch (err) {
        console.error('insertReport reply err', err);
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendMessage(adm, `🚨 Reply Report (DB failed): reply #${pending.replyId}\nReporter: ${ctx.from.username || ctx.from.first_name} (${uid})\nReason: ${reason}`); } catch(e) {}
        }
        return ctx.reply('Report submitted (could not save locally, admins were notified).');
      }
    }

    // pending upload proof (text)
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
        return ctx.reply('Proof sent to admin (DB failed to save locally).');
      }
    }

    // search pending
    if (pending && pending.type === 'await_search_code') {
      Pending.delete(uid);
      const code = txt.trim();
      const id = utils.decodeShortCode(code);
      if (!id) return ctx.reply('Invalid code.');
      try {
        const comment = await db.getCommentById(id);
        if (!comment) return ctx.reply('Comment not found.');
        // find thread for thumbnail
        const thread = comment.thread_id ? await db.getThreadById(comment.thread_id).catch(()=>null) : null;
        let thumb = null;
        if (thread && thread.social_link) {
          try {
            const norm = await utils.normalizeVideoUrl(thread.social_link).catch(()=>null);
            if (norm && norm.thumbnail) thumb = norm.thumbnail;
          } catch (e) {}
        }
        // send thumbnail + link if available, then voice and code
        if (thumb) {
          await ctx.replyWithPhoto(thumb, { caption: thread ? (thread.social_link || '') : '' });
        } else if (thread && thread.social_link) {
          await ctx.reply(thread.social_link);
        }
        if (comment.telegram_file_id) await ctx.replyWithVoice(comment.telegram_file_id);
        await ctx.reply(utils.encodeShortCode(comment.id), await buildCodeInline(comment.id, uid));
        return;
      } catch (e) { console.error('search code err', e); return ctx.reply('Error searching code.'); }
    }

    // if message contains URL -> create/find thread and present actions
    const candidateUrl = utils.extractFirstUrl(txt);
    if (candidateUrl) {
      try {
        const thread = await db.findOrCreateThread(candidateUrl, null);
        const norm = await utils.normalizeVideoUrl(candidateUrl).catch(()=>({ canonicalLink: candidateUrl }));
        if (norm && norm.thumbnail) await ctx.replyWithPhoto(norm.thumbnail, { caption: `Video: ${thread.social_link || thread.canonical_link || candidateUrl}` });
        else await ctx.reply(`Video: ${thread.social_link || thread.canonical_link || candidateUrl}`);
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('🎙 Add Voice Comment', `addvoice|${thread.id}`), Markup.button.callback('🎧 Listen Comments', `listen|${thread.id}|1`) ]
        ]);
        return ctx.reply('What would you like to do?', inline);
      } catch (e) { console.error('thread create/find err', e); return ctx.reply('Could not process link.'); }
    }

    // main keyboard text handlers
    if (/^\s*🎥 add comment\s*$|^add comment$/i.test(txt)) {
      Pending.set(uid, { type: 'await_link_for_add' });
      return ctx.reply('Send the TikTok/YouTube link to add a voice comment for.');
    }
    if (/^\s*➕ add my video\s*$|^add my video$/i.test(txt)) {
      Pending.set(uid, { type: 'await_link_for_track' });
      return ctx.reply('Send your video link to track. (This will set it as your tracked video)');
    }
    if (/^\s*🔖 track video\s*$|^track video$/i.test(txt)) {
      try {
        const { data } = await db.supabase.from('threads').select('*').eq('creator_telegram_id', uid).order('created_at', { ascending: false });
        if (!data || data.length === 0) return ctx.reply('You have not tracked any videos yet.');
        for (const t of data) {
          const inline = Markup.inlineKeyboard([[ Markup.button.callback('🎧 Listen Comments', `listen|${t.id}|1`), Markup.button.callback('🗑 Delete tracked', `delete_thread|${t.id}`) ]]);
          await ctx.reply(`${t.social_link || t.canonical_link}`, inline);
        }
      } catch (e) { console.error('track list err', e); return ctx.reply('Could not list tracked videos.'); }
      return;
    }
    if (/^\s*🎧 listen comments\s*$|^listen comments$/i.test(txt)) {
      Pending.set(uid, { type: 'await_link_for_listen' });
      return ctx.reply('Send the video link to listen comments or click one of your tracked videos.');
    }
    if (/^\s*💬 my comments\s*$|^my comments$/i.test(txt)) {
      try {
        const { data } = await db.supabase.from('voice_comments').select('*').eq('telegram_id', uid).order('created_at', { ascending: false }).limit(50);
        if (!data || data.length === 0) return ctx.reply('You have no comments yet.');
        for (const c of data) {
          if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id);
          await ctx.reply(utils.encodeShortCode(c.id), await buildCodeInline(c.id, uid));
        }
        return;
      } catch (e) { console.error('my comments err', e); return ctx.reply('Could not fetch your comments.'); }
    }
    if (/^\s*⭐ favorites\s*$|^favorites$/i.test(txt)) {
      try {
        const favs = await db.listFavoritesForUser(uid);
        if (!favs || favs.length === 0) return ctx.reply('No favorites.');
        for (const f of favs) {
          // get thread to show thumbnail
          const thread = f.thread_id ? await db.getThreadById(f.thread_id).catch(()=>null) : null;
          let thumb = null;
          if (thread && thread.social_link) {
            try { const n = await utils.normalizeVideoUrl(thread.social_link).catch(()=>null); if (n && n.thumbnail) thumb = n.thumbnail; } catch(e) {}
          }
          if (thumb) await ctx.replyWithPhoto(thumb, { caption: thread ? thread.social_link : '' });
          if (f.telegram_file_id) await ctx.replyWithVoice(f.telegram_file_id);
          await ctx.reply(utils.encodeShortCode(f.id), await buildCodeInline(f.id, uid));
        }
        return;
      } catch (e) { console.error('favorites err', e); return ctx.reply('Could not fetch favorites.'); }
    }
    if (/^\s*🔎 search\s*$|^search$/i.test(txt)) {
      Pending.set(uid, { type: 'await_search_code' });
      return ctx.reply('Send the short code (e.g. 0000A9).');
    }
    if (/^\s*💰 balance\s*$|^balance$/i.test(txt)) {
      try {
        const bal = await getBalance(uid);
        return ctx.reply(`Your balance: *${bal}*`, { parse_mode: 'Markdown' });
      } catch (e) { console.error('balance err', e); return ctx.reply('Could not fetch balance.'); }
    }

    // awaiting add comment link
    if (pending && pending.type === 'await_link_for_add') {
      Pending.delete(uid);
      const link = utils.extractFirstUrl(txt) || txt;
      if (!link) return ctx.reply('No link detected.');
      try {
        const thread = await db.findOrCreateThread(link, null);
        Pending.set(uid, { type: 'await_add_comment_voice', threadId: thread.id });
        return ctx.reply('Now send the voice. (Voice replies cost 1 credit — you will be charged if you post.)');
      } catch (e) { console.error('await_link_for_add err', e); return ctx.reply('Could not prepare add comment.'); }
    }

    // awaiting track link
    if (pending && pending.type === 'await_link_for_track') {
      Pending.delete(uid);
      const link = utils.extractFirstUrl(txt) || txt;
      if (!link) return ctx.reply('No link detected.');
      try {
        const thread = await db.findOrCreateThread(link, uid);
        // if thread exists but creator not set, update it
        try {
          if (thread && (!thread.creator_telegram_id || Number(thread.creator_telegram_id) !== Number(uid))) {
            await db.supabase.from('threads').update({ creator_telegram_id: uid }).eq('id', thread.id);
          }
        } catch (e) { console.error('update thread creator err', e); }
        return ctx.reply('Video tracked. You will be notified on replies.');
      } catch (e) { console.error('track err', e); return ctx.reply('Could not track video.'); }
    }

    if (pending && pending.type === 'await_link_for_listen') {
      Pending.delete(uid);
      const link = utils.extractFirstUrl(txt) || txt;
      if (!link) return ctx.reply('No link detected.');
      try {
        const thread = await db.findOrCreateThread(link, null);
        return sendCommentsPage(ctx, thread.id, 1);
      } catch (e) { console.error('listen err', e); return ctx.reply('Could not list comments for that video.'); }
    }

    return ctx.reply('I did not understand. Press a button or send a video link.', MAIN_KB());
  });

  // photo handler (upload proof, or reply-photo)
  bot.on('photo', async (ctx) => {
    try {
      const uid = ctx.from.id;
      const pending = Pending.get(uid);
      const photos = ctx.message.photo || [];
      const best = photos[photos.length - 1];
      if (!best) return ctx.reply('No photo found.');

      if (pending && pending.type === 'await_upload_proof' && pending.paymentId) {
        Pending.delete(uid);
        try {
          await db.updatePaymentStatus(pending.paymentId, 'proof_submitted', { proof_telegram_file_id: best.file_id });
          const inline = Markup.inlineKeyboard([
            [ Markup.button.callback('✅ Approve', `admin_approve|${pending.paymentId}`), Markup.button.callback('❌ Reject', `admin_reject|${pending.paymentId}`) ]
          ]);
          for (const adm of ADMIN_IDS) {
            try { await bot.telegram.sendPhoto(adm, best.file_id, { caption: `Payment proof for #${pending.paymentId} by ${uid}`, reply_markup: inline.reply_markup }); } catch(e) {}
          }
          return ctx.reply('Proof received. Admins will review.');
        } catch (e) {
          console.error('upload proof save err', e);
          for (const adm of ADMIN_IDS) {
            try { await bot.telegram.sendPhoto(adm, best.file_id, { caption: `Payment proof (db failed) for #${pending.paymentId} by ${uid}` }); } catch(e) {}
          }
          return ctx.reply('Proof sent to admins (DB failed to save).');
        }
      }

      // reply photo flow (free)
      if (pending && pending.type === 'await_reply_photo' && pending.commentId) {
        Pending.delete(uid);
        try {
          const inserted = await db.insertReplyRow({
            comment_id: pending.commentId,
            replier_telegram_id: uid,
            replier_username: ctx.from.username || null,
            replier_first_name: ctx.from.first_name || null,
            telegram_file_id: best.file_id,
            duration: 0
          });
          // notify owner
          const comment = await db.getCommentById(pending.commentId).catch(()=>null);
          if (comment && comment.telegram_id && comment.telegram_id !== uid) {
            await db.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply (photo) to your comment ${utils.encodeShortCode(comment.id)}`, meta: { comment_id: comment.id } }).catch(()=>null);
          }
          // show saved reply: send photo then code(with report/react inline)
          await ctx.replyWithPhoto(best.file_id);
          await ctx.reply(utils.encodeShortCode(inserted.id), buildReplyInline(inserted.id, uid, pending.commentId));
          return;
        } catch (e) { console.error('reply_photo err', e); return ctx.reply('Could not save reply photo.'); }
      }

      return ctx.reply('No expected photo action.');
    } catch (e) { console.error('photo handler err', e); return ctx.reply('Photo handling error.'); }
  });

  // voice handler (add comment or reply)
  bot.on('voice', async (ctx) => {
    try {
      const uid = ctx.from.id;
      const pending = Pending.get(uid);
      if (!pending) return ctx.reply('No expected action for voice now.');
      const voice = ctx.message.voice;
      if (!voice) return ctx.reply('No voice found.');

      // Add comment voice
      if (pending.type === 'await_add_comment_voice' && pending.threadId) {
        const bal = await getBalance(uid).catch(()=>0);
        if (bal <= 0) return ctx.reply('Pay before comment. Your balance is 0.');
        Pending.delete(uid);
        try {
          const inserted = await db.insertVoiceComment({
            thread_id: pending.threadId,
            telegram_id: uid,
            username: ctx.from.username || null,
            first_name: ctx.from.first_name || null,
            telegram_file_id: voice.file_id,
            duration: voice.duration || 0
          });
          await debitUser(uid, 1).catch(()=>null);
          await ctx.replyWithVoice(voice.file_id);
          await ctx.reply(utils.encodeShortCode(inserted.id), await buildCodeInline(inserted.id, uid));
          // notify thread creator
          const thread = await db.getThreadById(pending.threadId).catch(()=>null);
          if (thread && thread.creator_telegram_id && thread.creator_telegram_id !== uid) {
            await db.addNotificationRow({ telegram_id: thread.creator_telegram_id, message: `New comment on your tracked video: ${utils.encodeShortCode(inserted.id)}`, meta: { comment_id: inserted.id } }).catch(()=>null);
          }
          return;
        } catch (e) { console.error('insertVoiceComment err', e); return ctx.reply('Could not save voice comment.'); }
      }

      // Reply voice
      if (pending.type === 'await_reply_voice' && pending.commentId) {
        const bal = await getBalance(uid).catch(()=>0);
        if (bal <= 0) return ctx.reply('Pay before comment. Your balance is 0.');
        Pending.delete(uid);
        try {
          const inserted = await db.insertReplyRow({
            comment_id: pending.commentId,
            replier_telegram_id: uid,
            replier_username: ctx.from.username || null,
            replier_first_name: ctx.from.first_name || null,
            telegram_file_id: voice.file_id,
            duration: voice.duration || 0
          });
          await debitUser(uid, 1).catch(()=>null);
          await ctx.replyWithVoice(voice.file_id);
          await ctx.reply(utils.encodeShortCode(inserted.id), buildReplyInline(inserted.id, uid, pending.commentId));
          // notify original comment owner
          const comment = await db.getCommentById(pending.commentId).catch(()=>null);
          if (comment && comment.telegram_id && comment.telegram_id !== uid) {
            await db.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply to your comment ${utils.encodeShortCode(comment.id)}`, meta: { comment_id: comment.id } }).catch(()=>null);
          }
          return;
        } catch (e) { console.error('insertReplyRow err', e); return ctx.reply('Could not save reply.'); }
      }

      // report reply voice (if used)
      if (pending.type === 'report_reply_voice' && pending.replyId) {
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
          return ctx.reply('Voice report submitted (DB failed to save).');
        }
      }

      return ctx.reply('No expected action for voice now.');
    } catch (e) { console.error('voice handler err', e); return ctx.reply('Could not handle voice.'); }
  });

  // callback queries
  bot.on('callback_query', async (ctx) => {
    try {
      const data = ctx.callbackQuery && ctx.callbackQuery.data;
      if (!data) return ctx.answerCbQuery();
      const parts = data.split('|');
      const cmd = parts[0];
      const a1 = parts[1];
      const a2 = parts[2];

      // cancel pending on callback
      Pending.delete(ctx.from.id);

      // contact whatsapp
      if (cmd === 'contact_whatsapp') { await ctx.answerCbQuery(); return ctx.reply(WHATSAPP_LINK || 'WhatsApp not configured.'); }

      // select package
      if (cmd === 'select_pkg') {
        const pkgId = a1;
        const pkg = PAYMENT_PACKAGES.find(p => p.id === pkgId);
        if (!pkg) return ctx.answerCbQuery('Invalid package');
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback(`Confirm ${pkg.label}`, `confirm_pkg|${pkg.id}`), Markup.button.callback('Cancel', 'cancel_action') ]
        ]);
        await ctx.reply(`You selected ${pkg.label}. Confirm to get payment details.`, inline);
        return ctx.answerCbQuery();
      }

      // confirm package: create payment request and show payment numbers (no ID)
      if (cmd === 'confirm_pkg') {
        const pkgId = a1;
        const pkg = PAYMENT_PACKAGES.find(p => p.id === pkgId);
        if (!pkg) return ctx.answerCbQuery('Invalid package');
        try {
          const created = await db.createPaymentRequest({ telegram_id: ctx.from.id, package_name: pkg.label, comments_amount: pkg.credits, amount: pkg.amount, status: 'pending' });
          const txt = `${PAYMENT_RECIPIENT.telebirr_name}\nTELEBIRR: ${PAYMENT_RECIPIENT.telebirr_number}\n${PAYMENT_RECIPIENT.cbe_name}\nCBE: ${PAYMENT_RECIPIENT.cbe_number}\nAmount: ${pkg.amount} ETB\n\nCopy the number below to your banking app and pay. After payment press Upload Proof.`;
          const inline = Markup.inlineKeyboard([
            [ Markup.button.callback('Copy TELEBIRR', `copy_number|${PAYMENT_RECIPIENT.telebirr_number}`), Markup.button.callback('Copy CBE', `copy_number|${PAYMENT_RECIPIENT.cbe_number}`) ],
            [ Markup.button.callback('Upload Proof', `upload_proof|${created.id}`) ],
            [ Markup.button.url('Contact admin', WHATSAPP_LINK || 'https://t.me/' + (ADMIN_IDS[0] || '')) ]
          ]);
          await ctx.reply(txt);
          await ctx.reply('Payment options:', inline);
          for (const adm of ADMIN_IDS) {
            try { await bot.telegram.sendMessage(adm, `New payment request #${created.id} by ${ctx.from.id} — ${pkg.label}`); } catch(e) {}
          }
        } catch (e) { console.error('confirm_pkg err', e); await ctx.reply('Could not create payment request. Contact support.'); }
        return ctx.answerCbQuery();
      }

      // copy number -> send plain number
      if (cmd === 'copy_number') {
        const number = a1;
        await ctx.answerCbQuery('Number sent');
        return ctx.reply(number);
      }

      // upload proof
      if (cmd === 'upload_proof') {
        const pid = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_upload_proof', paymentId: pid });
        await ctx.answerCbQuery();
        return ctx.reply(`Send the proof image or paste the link for payment #${pid}.`);
      }

      // add voice
      if (cmd === 'addvoice') {
        const threadId = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_add_comment_voice', threadId });
        await ctx.answerCbQuery('Send voice to add as comment');
        return ctx.reply('Send voice now. (Voice costs 1 credit)');
      }

      // listen comments (pagination)
      if (cmd === 'listen') {
        const threadId = Number(a1);
        const page = Number(a2 || 1);
        await sendCommentsPage(ctx, threadId, page);
        return ctx.answerCbQuery();
      }

      // reply menu: gives types (text/photo free, voice costs)
      if (cmd === 'replymenu') {
        const commentId = Number(a1);
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('Reply Text (free)', `reply_text|${commentId}`), Markup.button.callback('Reply Photo (free)', `reply_photo|${commentId}`) ],
          [ Markup.button.callback('Reply Voice (costs 1)', `reply_voice|${commentId}`) ]
        ]);
        await ctx.reply('Choose reply type:', inline);
        await ctx.answerCbQuery();
        return;
      }

      if (cmd === 'reply_text') {
        const commentId = Number(a1);
        Pending.set(ctx.from.id, { type: 'reply_text', commentId });
        await ctx.answerCbQuery('Send text reply now');
        return ctx.reply('Send your reply text now.');
      }
      if (cmd === 'reply_photo') {
        const commentId = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_reply_photo', commentId });
        await ctx.answerCbQuery('Send photo to reply');
        return ctx.reply('Send your photo to reply now (free).');
      }
      if (cmd === 'reply_voice') {
        const commentId = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_reply_voice', commentId });
        await ctx.answerCbQuery('Send voice reply now');
        return ctx.reply('Send your voice reply now (costs 1 credit).');
      }

      // report comment: ask reason
      if (cmd === 'report') {
        const commentId = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_report_reason', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain why you are reporting this comment (short text).');
      }

      // report reply: ask reason
      if (cmd === 'rreport') {
        const replyId = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_report_reason_reply', replyId });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain why you are reporting this reply (short text).');
      }

      // reactions for comment
      if (cmd === 'react') {
        const commentId = Number(a1);
        const type = a2;
        try {
          const { data: existing } = await db.supabase.from('reactions').select('*').eq('comment_id', commentId).eq('telegram_id', ctx.from.id).limit(1).maybeSingle();
          if (existing) {
            if (existing.type === type) await db.supabase.from('reactions').delete().eq('id', existing.id);
            else await db.supabase.from('reactions').update({ type }).eq('id', existing.id);
          } else {
            await db.supabase.from('reactions').insert([{ comment_id: commentId, telegram_id: ctx.from.id, type }]);
          }
          await ctx.answerCbQuery('Saved');
          await refreshCodeInline(ctx, commentId);
        } catch (e) { console.error('react err', e); await ctx.answerCbQuery('Error'); }
        return;
      }

      // reactions for reply
      if (cmd === 'rreact') {
        const replyId = Number(a1);
        const type = a2;
        try {
          const { data: existing } = await db.supabase.from('reactions').select('*').eq('reply_id', replyId).eq('telegram_id', ctx.from.id).limit(1).maybeSingle();
          if (existing) {
            if (existing.type === type) await db.supabase.from('reactions').delete().eq('id', existing.id);
            else await db.supabase.from('reactions').update({ type }).eq('id', existing.id);
          } else {
            await db.supabase.from('reactions').insert([{ reply_id: replyId, telegram_id: ctx.from.id, type }]);
          }
          await ctx.answerCbQuery('Saved');
        } catch (e) { console.error('rreact err', e); await ctx.answerCbQuery('Error'); }
        return;
      }

      // favorite toggle
      if (cmd === 'fav') {
        const commentId = Number(a1);
        try {
          const res = await db.toggleFavoriteRow(ctx.from.id, commentId);
          await ctx.answerCbQuery(res.removed ? 'Favorite removed' : 'Favorite added');
        } catch (e) { console.error('fav err', e); await ctx.answerCbQuery('Error'); }
        return;
      }

      // list replies
      if (cmd === 'list_replies') {
        const commentId = Number(a1);
        const page = Number(a2 || 1);
        try {
          const perPage = 5;
          const offset = (page - 1) * perPage;
          const { data: replies } = await db.supabase.from('replies').select('*').eq('comment_id', commentId).order('created_at', { ascending: true }).range(offset, offset + perPage - 1);
          if (!replies || replies.length === 0) { await ctx.reply('No replies yet.'); await ctx.answerCbQuery(); return; }
          for (const r of replies) {
            if (r.telegram_file_id) await ctx.replyWithVoice(r.telegram_file_id, { caption: `${r.replier_first_name || r.replier_username || 'User'}` });
            else await ctx.reply(`${r.replier_first_name || r.replier_username || 'User'}: ${r.reply_text || '(no text)'}`);
            await ctx.reply(utils.encodeShortCode(r.id), buildReplyInline(r.id, ctx.from.id, commentId));
          }
          // next page
          const countRes = await db.supabase.from('replies').select('id', { count: 'exact' }).eq('comment_id', commentId);
          const total = (countRes && countRes.count) ? Number(countRes.count) : 0;
          if (offset + perPage < total) {
            await ctx.reply('More replies:', Markup.inlineKeyboard([ [ Markup.button.callback('More', `list_replies|${commentId}|${page+1}`) ] ]));
          }
          return ctx.answerCbQuery();
        } catch (e) { console.error('list_replies err', e); await ctx.answerCbQuery('Error'); return; }
      }

      // admin delete comment
      if (cmd === 'admin_delete_comment') {
        const commentId = Number(a1);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          await db.deleteCommentById(commentId);
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
          await db.supabase.from('replies').delete().eq('id', replyId);
          await ctx.answerCbQuery('Deleted');
          return ctx.reply(`Reply ${utils.encodeShortCode(replyId)} deleted by admin.`);
        } catch (e) { console.error('admin_delete_reply err', e); await ctx.answerCbQuery('Error deleting.'); }
        return;
      }

      // delete tracked thread
      if (cmd === 'delete_thread') {
        const tid = Number(a1);
        try {
          const thread = await db.getThreadById(tid).catch(()=>null);
          if (!thread) { await ctx.answerCbQuery('Not found'); return; }
          if (thread.creator_telegram_id === ctx.from.id || isAdmin(ctx.from.id)) {
            await db.deleteThreadById(tid);
            await ctx.reply('Tracked video deleted.');
          } else await ctx.answerCbQuery('Not authorized');
          return ctx.answerCbQuery();
        } catch (e) { console.error('delete_thread err', e); await ctx.answerCbQuery('Error'); }
      }

      // cancel
      if (cmd === 'cancel_action') {
        Pending.delete(ctx.from.id);
        await ctx.answerCbQuery();
        return ctx.reply('Action cancelled.', MAIN_KB());
      }

      // admin approve
      if (cmd === 'admin_approve') {
        const pid = Number(a1);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          const payment = await db.getPaymentById(pid);
          if (!payment) { await ctx.answerCbQuery('Payment not found'); return; }
          await creditUser(payment.telegram_id, payment.comments_amount);
          await db.updatePaymentStatus(pid, 'approved', { approved_by: ctx.from.id, approved_at: new Date().toISOString() });
          await ctx.answerCbQuery('Approved');
          await bot.telegram.sendMessage(payment.telegram_id, `Your payment was approved by admin. You received ${payment.comments_amount} comments.`);
          return ctx.reply(`Payment #${pid} approved and ${payment.comments_amount} credits added to user ${payment.telegram_id}.`);
        } catch (e) { console.error('admin_approve err', e); await ctx.answerCbQuery('Error approving'); }
        return;
      }

      if (cmd === 'admin_reject') {
        const pid = Number(a1);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          await db.updatePaymentStatus(pid, 'rejected', { rejected_by: ctx.from.id, rejected_at: new Date().toISOString() });
          await ctx.answerCbQuery('Rejected');
          return ctx.reply(`Payment #${pid} rejected by admin.`);
        } catch (e) { console.error('admin_reject err', e); await ctx.answerCbQuery('Error rejecting'); }
        return;
      }

      return ctx.answerCbQuery();
    } catch (e) {
      console.error('callback_query err', e);
      try { await ctx.answerCbQuery('Error'); } catch(_) {}
    }
  });

  // text handler for reply_text pending
  bot.on('text', async (ctx) => {
    const uid = ctx.from.id;
    const pending = Pending.get(uid);
    if (!pending) return;
    if (pending.type === 'reply_text' && pending.commentId) {
      Pending.delete(uid);
      try {
        const inserted = await db.insertReplyRow({
          comment_id: pending.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          reply_text: ctx.message.text
        });
        await ctx.reply('Reply saved.');
        const comment = await db.getCommentById(pending.commentId).catch(()=>null);
        if (comment && comment.telegram_id && comment.telegram_id !== uid) {
          await db.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply to your comment ${utils.encodeShortCode(comment.id)}`, meta: { comment_id: comment.id } }).catch(()=>null);
        }
      } catch (e) { console.error('reply_text insert err', e); await ctx.reply('Could not save reply.'); }
    }
  });

  return bot;
}

module.exports = { initBot };
