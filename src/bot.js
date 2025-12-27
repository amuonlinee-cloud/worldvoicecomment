// src/bot.js
// Full bot.js implementing:
// - user-facing payment details WITHOUT payment ID (only recipient name & numbers + copy buttons -> send only the number)
// - admin approve/reject payment proof (approve credits user's balance)
// - text/photo replies free, voice replies cost (balance check + notification if zero)
// - voice comments and voice replies: send voice only, then send unique code as separate text message (keyboard attached to code message)
// - reactions: single reaction per user, changeable; counts shown on buttons and updated live
// - replies paginated (5 per page) with reaction/report buttons
// - admin can delete any content
// - report flows for comments and replies (store in reports table, notify admins)
// - Supabase-only persistence via db.supabase (no in-memory fallback)

const { Telegraf, Markup } = require('telegraf');
const db = require('./database');    // expects supabase + helper functions
const utils = require('./utils');    // expects normalizeVideoUrl, extractFirstUrl, encodeShortCode, decodeShortCode
const debug = (...args) => console.log('[bot]', ...args);

// env
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const WHATSAPP_ADMIN = (process.env.WHATSAPP_ADMIN || '').replace(/\D/g,'');
const WHATSAPP_LINK = WHATSAPP_ADMIN ? `https://wa.me/${WHATSAPP_ADMIN}` : null;

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN env var.');

// Payment recipient details shown to users (no payment id)
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

// Pending map per user to track expected next action
const Pending = new Map();

// Helper: is admin
function isAdmin(id) {
  return ADMIN_IDS.includes(Number(id));
}

// Helper: get reaction counts for a comment
async function getReactionCounts(commentId) {
  try {
    const { data, error } = await db.supabase
      .from('reactions')
      .select('type, count:count(*)', { count: 'exact' })
      .eq('comment_id', commentId)
      .group('type');
    // Note: supabase-js doesn't support group in select shorthand; fallback to SQL
  } catch (e) {
    // fallback raw SQL
  }
  // Fallback: run SQL for counts grouped by type
  try {
    const sql = `select type, count(*) as cnt from reactions where comment_id = ${commentId} group by type`;
    const { data, error } = await db.supabase.rpc('sql', { q: sql }).catch(()=>({ error: true }));
    // Not all Supabase projects have sql rpc; simpler: run select then aggregate client-side
  } catch (e) {
    // fallback to client-side grouping
  }
  // Simpler and compatible: fetch all reactions for comment and aggregate
  try {
    const { data: rows } = await db.supabase.from('reactions').select('type').eq('comment_id', commentId);
    const counts = {};
    (rows || []).forEach(r => { counts[r.type] = (counts[r.type] || 0) + 1; });
    return counts;
  } catch (e) {
    console.error('getReactionCounts err', e);
    return {};
  }
}

// build inline keyboard for code message (reactions, favorite, reply, show replies, report, admin-delete)
async function buildCodeInline(commentId, ctxUserId) {
  const counts = await getReactionCounts(commentId);
  const heart = `❤️ ${counts.heart || 0}`;
  const laugh = `😂 ${counts.laugh || 0}`;
  const dislike = `👎 ${counts.dislike || 0}`;

  const rows = [
    [ Markup.button.callback(heart, `react|${commentId}|heart`), Markup.button.callback(laugh, `react|${commentId}|laugh`), Markup.button.callback(dislike, `react|${commentId}|dislike`) ],
    [ Markup.button.callback('☆ Favorite', `fav|${commentId}`), Markup.button.callback('💬 Reply', `replymenu|${commentId}`), Markup.button.callback('▶️ Show replies', `list_replies|${commentId}|1`) ],
    [ Markup.button.callback('🚩 Report', `report|${commentId}`) ]
  ];
  if (isAdmin(ctxUserId)) {
    rows.push([ Markup.button.callback('🗑 Admin Delete', `admin_delete_comment|${commentId}`) ]);
  }
  return Markup.inlineKeyboard(rows);
}

// build inline for reply item (report, react)
function buildReplyInline(replyId, ctxUserId, commentId) {
  // React for replies uses same handlers but replyId scope; we'll prefix with 'rreact'
  const rows = [
    [ Markup.button.callback('❤️', `rreact|${replyId}|heart`), Markup.button.callback('🚩 Report', `rreport|${replyId}|${commentId}`) ]
  ];
  if (isAdmin(ctxUserId)) rows.push([ Markup.button.callback('🗑 Admin Delete Reply', `admin_delete_reply|${replyId}`) ]);
  return Markup.inlineKeyboard(rows);
}

// helper to edit the keyboard counts of the message where callback was pressed
async function refreshCodeInline(ctx, commentId) {
  try {
    const inline = await buildCodeInline(commentId, ctx.from.id);
    // edit reply markup of the message that holds the keyboard
    try { await ctx.editMessageReplyMarkup(inline.reply_markup); } catch (e) { /* message might be voice message or not editable; ignore */ }
  } catch (e) { console.error('refreshCodeInline err', e); }
}

// ensure user row exists
async function ensureUser(user) {
  try { return await db.ensureUserRow(user); } catch (e) { console.error('ensureUser err', e); }
}

// helper get balance
async function getBalance(telegramId) {
  try {
    const { data } = await db.supabase.from('users').select('free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
    return Number((data && data.free_comments) || 0);
  } catch (e) {
    console.error('getBalance err', e);
    throw e;
  }
}

// helper credit user safely (add credits)
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

// helper debit user (decrease)
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

// send comments (paginated)
async function sendCommentsPage(ctx, threadId, page=1, perPage=5) {
  try {
    const offset = (page - 1) * perPage;
    const { data: comments, error } = await db.supabase.from('voice_comments').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).range(offset, offset + perPage - 1);
    if (error) throw error;
    if (!comments || comments.length === 0) return ctx.reply('No comments yet.', MAIN_KB());
    for (const c of comments) {
      // send voice (no code attached)
      if (c.telegram_file_id) {
        try { await ctx.replyWithVoice(c.telegram_file_id); } catch (e) { /* ignore */ }
      } else {
        await ctx.reply(c.reply_text || '(no voice)');
      }
      // then send code message with keyboard
      const code = utils.encodeShortCode(c.id);
      const inline = await buildCodeInline(c.id, ctx.from.id);
      await ctx.reply(`Code: ${code}`, inline);
    }
    // pagination
    const countRes = await db.supabase.from('voice_comments').select('id', { count: 'exact' }).eq('thread_id', threadId);
    const total = (countRes && countRes.count) ? Number(countRes.count) : 0;
    if (offset + perPage < total) {
      await ctx.reply('More replies:', Markup.inlineKeyboard([[ Markup.button.callback('More', `listen|${threadId}|${page+1}`) ]]));
    }
  } catch (e) {
    console.error('sendCommentsPage err', e);
    await ctx.reply('Could not list comments.');
  }
}

// init bot
async function initBot() {
  const bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    try {
      await ensureUser(ctx.from);
      const balance = await getBalance(ctx.from.id).catch(()=>0);
      await ctx.reply(`Welcome! You have *${balance}* comments available.`, { parse_mode: 'Markdown' });
      await ctx.reply('Use the keyboard below.', MAIN_KB());
    } catch (e) {
      console.error('start err', e);
      await ctx.reply('Welcome. (error reading balance)');
      await ctx.reply('Use the keyboard below.', MAIN_KB());
    }
  });

  // support command
  bot.command('support', async (ctx) => {
    try {
      await ctx.reply(WHATSAPP_LINK ? `Contact admin via WhatsApp: ${WHATSAPP_LINK}` : 'Contact admin (WhatsApp not configured).');
    } catch (e) { console.error('/support err', e); }
  });

  // notifications command (admin posts are in notifications table)
  bot.command('notifications', async (ctx) => {
    try {
      const rows = await db.listNotifications(ctx.from.id);
      if (!rows || rows.length === 0) return ctx.reply('No notifications.');
      for (const n of rows.slice(0,5)) {
        await ctx.reply(n.message || '(notification)');
      }
      // simple pagination as needed omitted for brevity
    } catch (e) { console.error('/notifications err', e); await ctx.reply('Could not fetch notifications.'); }
  });

  // Buy: show packages with label buttons; when clicked -> show confirm/cancel
  bot.hears(/🛒 buy|^buy$/i, async (ctx) => {
    try {
      Pending.delete(ctx.from.id);
      const inline = PAYMENT_PACKAGES.map(p => [ Markup.button.callback(p.label, `select_pkg|${p.id}`) ]);
      inline.push([ Markup.button.callback('Contact support', 'contact_whatsapp') ]);
      await ctx.reply('Choose a package:', Markup.inlineKeyboard(inline));
    } catch (e) { console.error('buy err', e); await ctx.reply('Could not show packages.'); }
  });

  // general text handler
  bot.on('text', async (ctx) => {
    const txt = (ctx.message && ctx.message.text) || '';
    const uid = ctx.from.id;
    // cancel pending if main keyboard pressed
    const normalized = txt.trim().toLowerCase();
    const main = ['🎥 add comment','➕ add my video','🔖 track video','🎧 listen comments','💬 my comments','🔎 search','⭐ favorites','🔔 notifications','🛒 buy','🆘 support','💰 balance'];
    if (main.includes(normalized)) Pending.delete(uid);

    // pending checks
    const pending = Pending.get(uid);

    // report reason for comment
    if (pending && pending.type === 'await_report_reason' && pending.commentId) {
      Pending.delete(uid);
      const reason = txt.trim();
      try {
        await db.insertReport({ reporter_telegram_id: uid, comment_id: pending.commentId, reason });
        const comment = await db.getCommentById(pending.commentId).catch(()=>null);
        const thread = comment ? await db.getThreadById(comment.thread_id).catch(()=>null) : null;
        const header = `🚨 Report: ${utils.encodeShortCode(pending.commentId)}\nReporter: ${ctx.from.username || ctx.from.first_name} (${uid})\nReason: ${reason}\nVideo: ${thread ? (thread.social_link || thread.canonical_link) : '(unknown)'}`;
        for (const adm of ADMIN_IDS) {
          try {
            if (comment && comment.telegram_file_id) await bot.telegram.sendVoice(adm, comment.telegram_file_id, { caption: header });
            else await bot.telegram.sendMessage(adm, header);
          } catch (e) { console.error('notify admin report err', e); }
        }
        return ctx.reply('Thank you — report sent to admins.');
      } catch (e) { console.error('report reason err', e); return ctx.reply('Could not submit report.'); }
    }

    // report reason for reply
    if (pending && pending.type === 'await_report_reason_reply' && pending.replyId) {
      Pending.delete(uid);
      const reason = txt.trim();
      try {
        await db.insertReport({ reporter_telegram_id: uid, reply_id: pending.replyId, reason });
        for (const adm of ADMIN_IDS) {
          try {
            await bot.telegram.sendMessage(adm, `🚨 Reply Report: reply #${pending.replyId}\nReporter: ${ctx.from.username || ctx.from.first_name} (${uid})\nReason: ${reason}`);
          } catch (e) {}
        }
        return ctx.reply('Thank you — reply report sent to admins.');
      } catch (e) { console.error('report reply reason err', e); return ctx.reply('Could not submit reply report.'); }
    }

    // pending upload proof (text)
    if (pending && pending.type === 'await_upload_proof' && pending.paymentId) {
      Pending.delete(uid);
      try {
        await db.updatePaymentStatus(pending.paymentId, 'proof_submitted', { proof_link: txt.trim() });
        // notify admins with approve/reject inline
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('✅ Approve', `admin_approve|${pending.paymentId}`), Markup.button.callback('❌ Reject', `admin_reject|${pending.paymentId}`) ]
        ]);
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendMessage(adm, `Payment proof for #${pending.paymentId} received by ${uid}.`, inline); } catch(e) {}
        }
        return ctx.reply('Proof received. Admins will review.');
      } catch (e) { console.error('upload proof text err', e); return ctx.reply('Could not submit proof.'); }
    }

    // search pending
    if (pending && pending.type === 'await_search_code') {
      Pending.delete(uid);
      const code = txt.trim();
      const id = utils.decodeShortCode(code);
      if (!id) return ctx.reply('Invalid code.');
      const comment = await db.getCommentById(id).catch(()=>null);
      if (!comment) return ctx.reply('Comment not found.');
      if (comment.telegram_file_id) await ctx.replyWithVoice(comment.telegram_file_id);
      await ctx.reply(`Code: ${utils.encodeShortCode(id)}`, await buildCodeInline(id, uid));
      return;
    }

    // if message contains a URL -> treat as thread link
    const url = utils.extractFirstUrl(txt);
    if (url) {
      try {
        const thread = await db.findOrCreateThread(url, null);
        const norm = await utils.normalizeVideoUrl(url).catch(()=>({ canonicalLink: url }));
        if (norm && norm.thumbnail) await ctx.replyWithPhoto(norm.thumbnail, { caption: `Video: ${thread.social_link || thread.canonical_link || url}` });
        else await ctx.reply(`Video: ${thread.social_link || thread.canonical_link || url}`);
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('🎙 Add Voice Comment', `addvoice|${thread.id}`), Markup.button.callback('🎧 Listen Comments', `listen|${thread.id}|1`) ]
        ]);
        return ctx.reply('What would you like to do?', inline);
      } catch (e) { console.error('thread create err', e); return ctx.reply('Could not process the link.'); }
    }

    // main button handlers via text
    if (/^\s*🎥 add comment\s*$|^add comment$/i.test(txt)) {
      Pending.set(uid, { type: 'await_link_for_add' });
      return ctx.reply('Send the TikTok/YouTube link to add a voice comment for.');
    }
    if (/^\s*➕ add my video\s*$|^add my video$/i.test(txt)) {
      Pending.set(uid, { type: 'await_link_for_track' });
      return ctx.reply('Send your video link to track.');
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
          await ctx.reply(`Code: ${utils.encodeShortCode(c.id)}`, await buildCodeInline(c.id, uid));
        }
        return;
      } catch (e) { console.error('my comments err', e); return ctx.reply('Could not fetch your comments.'); }
    }
    if (/^\s*⭐ favorites\s*$|^favorites$/i.test(txt)) {
      try {
        const favs = await db.listFavoritesForUser(uid);
        if (!favs || favs.length === 0) return ctx.reply('No favorites.');
        for (const f of favs) {
          if (f.telegram_file_id) await ctx.replyWithVoice(f.telegram_file_id);
          await ctx.reply(`Code: ${utils.encodeShortCode(f.id)}`, await buildCodeInline(f.id, uid));
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
        const balance = await getBalance(uid);
        return ctx.reply(`Your balance: *${balance}*`, { parse_mode: 'Markdown' });
      } catch (e) { console.error('balance err', e); return ctx.reply('Could not fetch balance.'); }
    }

    // pending link for add comment
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

    if (pending && pending.type === 'await_link_for_listen') {
      Pending.delete(uid);
      const link = utils.extractFirstUrl(txt) || txt;
      if (!link) return ctx.reply('No link detected.');
      try {
        const thread = await db.findOrCreateThread(link, null);
        return sendCommentsPage(ctx, thread.id, 1);
      } catch (e) { console.error('listen err', e); return ctx.reply('Could not list comments for that video.'); }
    }

    // other fallback
    return ctx.reply('I did not understand. Press a button or send a video link.', MAIN_KB());
  });

  // photo handler (for upload proof or reply-photo)
  bot.on('photo', async (ctx) => {
    try {
      const uid = ctx.from.id;
      const pending = Pending.get(uid);
      const photos = ctx.message.photo || [];
      const best = photos[photos.length - 1];
      if (!best) return ctx.reply('No photo found.');
      // upload proof
      if (pending && pending.type === 'await_upload_proof' && pending.paymentId) {
        Pending.delete(uid);
        await db.updatePaymentStatus(pending.paymentId, 'proof_submitted', { proof_telegram_file_id: best.file_id });
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('✅ Approve', `admin_approve|${pending.paymentId}`), Markup.button.callback('❌ Reject', `admin_reject|${pending.paymentId}`) ]
        ]);
        for (const adm of ADMIN_IDS) {
          try { await bot.telegram.sendPhoto(adm, best.file_id, { caption: `Payment proof for #${pending.paymentId} by ${uid}`, reply_markup: inline.reply_markup }); } catch(e) {}
        }
        return ctx.reply('Proof received. Admins will review.');
      }

      // reply-photo (free) — if user had chosen to reply to a comment with photo
      if (pending && pending.type === 'await_reply_photo' && pending.commentId) {
        Pending.delete(uid);
        // insert row in replies table with telegram_file_id
        try {
          const inserted = await db.insertReplyRow({
            comment_id: pending.commentId,
            replier_telegram_id: uid,
            replier_username: ctx.from.username || null,
            replier_first_name: ctx.from.first_name || null,
            telegram_file_id: best.file_id,
            duration: 0
          });
          // notify original comment owner
          const comment = await db.getCommentById(pending.commentId).catch(()=>null);
          if (comment && comment.telegram_id && comment.telegram_id !== uid) {
            await db.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply (photo) to your comment ${utils.encodeShortCode(comment.id)}`, meta: { comment_id: comment.id } }).catch(()=>null);
          }
          // show the reply and attach report button
          await bot.telegram.sendPhoto(ctx.chat.id, best.file_id, { caption: `Reply saved • ${utils.encodeShortCode(inserted.id)}`, reply_markup: buildReplyInline(inserted.id, uid, pending.commentId).reply_markup });
          return;
        } catch (e) { console.error('reply_photo insert err', e); return ctx.reply('Could not save reply photo.'); }
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

      // Add comment voice (costs 1 credit)
      if (pending.type === 'await_add_comment_voice' && pending.threadId) {
        // check balance
        const balance = await getBalance(uid).catch(()=>0);
        if (balance <= 0) return ctx.reply('Pay before comment. Your balance is 0.');
        Pending.delete(uid);
        // insert comment
        try {
          const inserted = await db.insertVoiceComment({
            thread_id: pending.threadId,
            telegram_id: uid,
            username: ctx.from.username || null,
            first_name: ctx.from.first_name || null,
            telegram_file_id: voice.file_id,
            duration: voice.duration || 0
          });
          // debit 1 credit
          await debitUser(uid, 1).catch(()=>null);
          // send voice (no code attached)
          await ctx.replyWithVoice(voice.file_id);
          // send code separate
          const code = utils.encodeShortCode(inserted.id);
          await ctx.reply(`Code: ${code}`, await buildCodeInline(inserted.id, uid));
          // notify thread creator if tracked
          const thread = await db.getThreadById(pending.threadId).catch(()=>null);
          if (thread && thread.creator_telegram_id && thread.creator_telegram_id !== uid) {
            await db.addNotificationRow({ telegram_id: thread.creator_telegram_id, message: `New comment on tracked video: ${code}`, meta: { comment_id: inserted.id } }).catch(()=>null);
          }
        } catch (e) { console.error('insertVoiceComment err', e); return ctx.reply('Could not save voice comment.'); }
        return;
      }

      // Reply voice (costs 1 credit)
      if (pending.type === 'await_reply_voice' && pending.commentId) {
        const balance = await getBalance(uid).catch(()=>0);
        if (balance <= 0) return ctx.reply('Pay before comment. Your balance is 0.');
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
          // send voice then code
          await ctx.replyWithVoice(voice.file_id);
          await ctx.reply(`Code: ${utils.encodeShortCode(inserted.id)}`, buildReplyInline(inserted.id, uid, pending.commentId));
          // notify original comment owner
          const comment = await db.getCommentById(pending.commentId).catch(()=>null);
          if (comment && comment.telegram_id && comment.telegram_id !== uid) {
            await db.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply to your comment ${utils.encodeShortCode(comment.id)}`, meta: { comment_id: comment.id } }).catch(()=>null);
          }
        } catch (e) { console.error('insertReplyRow err', e); return ctx.reply('Could not save reply.'); }
        return;
      }

      // Report with voice for reply (if used)
      if (pending.type === 'report_reply_voice' && pending.replyId) {
        Pending.delete(uid);
        try {
          await db.insertReport({ reporter_telegram_id: uid, reply_id: pending.replyId, report_telegram_file_id: voice.file_id });
          for (const adm of ADMIN_IDS) {
            try { await bot.telegram.sendVoice(adm, voice.file_id, { caption: `Reply report: reply #${pending.replyId} by ${ctx.from.username || ctx.from.first_name}` }); } catch(e) {}
          }
          return ctx.reply('Voice report submitted. Admins will review.');
        } catch (e) { console.error('report reply voice err', e); return ctx.reply('Could not send report.'); }
      }

      return ctx.reply('No expected action for voice now.');
    } catch (e) { console.error('voice handler err', e); return ctx.reply('Could not handle voice.'); }
  });

  // callback_query handler (all inline actions)
  bot.on('callback_query', async (ctx) => {
    try {
      const q = ctx.callbackQuery;
      const data = q && q.data;
      if (!data) return ctx.answerCbQuery();
      const parts = data.split('|');
      const cmd = parts[0];
      const a1 = parts[1];
      const a2 = parts[2];

      // cancel any pending on explicit callback
      Pending.delete(ctx.from.id);

      // contact whatsapp
      if (cmd === 'contact_whatsapp') {
        await ctx.answerCbQuery();
        return ctx.reply(WHATSAPP_LINK || 'WhatsApp not configured.');
      }

      // select package -> show confirm/cancel
      if (cmd === 'select_pkg') {
        const pkgId = a1;
        const pkg = PAYMENT_PACKAGES.find(p => p.id === pkgId);
        if (!pkg) return ctx.answerCbQuery('Invalid package.');
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback(`Confirm ${pkg.label}`, `confirm_pkg|${pkg.id}`), Markup.button.callback('Cancel', 'cancel_action') ]
        ]);
        await ctx.reply(`You selected ${pkg.label}. Confirm to get payment details.`, inline);
        return ctx.answerCbQuery();
      }

      // confirm package: create payment request in DB and show payment numbers (no payment id)
      if (cmd === 'confirm_pkg') {
        const pkgId = a1;
        const pkg = PAYMENT_PACKAGES.find(p => p.id === pkgId);
        if (!pkg) return ctx.answerCbQuery('Invalid package');
        try {
          const created = await db.createPaymentRequest({ telegram_id: ctx.from.id, package_name: pkg.label, comments_amount: pkg.credits, amount: pkg.amount, status: 'pending' });
          // user-facing message: show recipient name and numbers + copy buttons (no payment id)
          const txt = `${PAYMENT_RECIPIENT.telebirr_name}\nTELEBIRR: ${PAYMENT_RECIPIENT.telebirr_number}\n${PAYMENT_RECIPIENT.cbe_name}\nCBE: ${PAYMENT_RECIPIENT.cbe_number}\nAmount: ${pkg.amount} ETB\n\nCopy number then pay using your banking app. After payment, press Upload Proof.`;
          const inline = Markup.inlineKeyboard([
            [ Markup.button.callback('Copy TELEBIRR', `copy_number|${PAYMENT_RECIPIENT.telebirr_number}`), Markup.button.callback('Copy CBE', `copy_number|${PAYMENT_RECIPIENT.cbe_number}`) ],
            [ Markup.button.callback('Upload Proof', `upload_proof|${created.id}`) ],
            [ Markup.button.url('Contact admin', WHATSAPP_LINK || 'https://t.me/' + (ADMIN_IDS[0] || '')) ]
          ]);
          await ctx.reply(txt);
          await ctx.reply('Payment options:', inline);
          // notify admins with payment id and user
          for (const adm of ADMIN_IDS) {
            try { await bot.telegram.sendMessage(adm, `New payment request #${created.id} by user ${ctx.from.id} — ${pkg.label}`); } catch(e) {}
          }
        } catch (e) {
          console.error('confirm_pkg err', e);
          await ctx.reply('Could not create payment request. Contact support.');
        }
        return ctx.answerCbQuery();
      }

      // copy_number: when clicked, send only the number to user (no "Copied:" prefix)
      if (cmd === 'copy_number') {
        const number = a1;
        await ctx.answerCbQuery('Number sent');
        return ctx.reply(number);
      }

      // upload proof -> set pending
      if (cmd === 'upload_proof') {
        const pid = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_upload_proof', paymentId: pid });
        await ctx.answerCbQuery();
        return ctx.reply(`Send the proof photo or paste the proof link for your payment.`);
      }

      // add voice via inline
      if (cmd === 'addvoice') {
        const threadId = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_add_comment_voice', threadId });
        await ctx.answerCbQuery('Send voice to add as comment');
        return ctx.reply('Send voice now. (Voice costs 1 credit)');
      }

      // listen comments
      if (cmd === 'listen') {
        const threadId = Number(a1);
        const page = Number(a2 || 1);
        await sendCommentsPage(ctx, threadId, page);
        return ctx.answerCbQuery();
      }

      // reply menu: offer text/photo/voice; text/photo free; voice costs
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

      // report comment -> ask reason
      if (cmd === 'report') {
        const commentId = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_report_reason', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain why you are reporting this comment (short text).');
      }

      // report reply -> ask or immediate
      if (cmd === 'rreport') {
        const replyId = Number(a1);
        // ask reason
        Pending.set(ctx.from.id, { type: 'await_report_reason_reply', replyId });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain why you are reporting this reply (short text).');
      }

      // reactions for comments
      if (cmd === 'react') {
        const commentId = Number(a1);
        const type = a2;
        try {
          // fetch existing reaction by this user on this comment
          const { data: existing } = await db.supabase.from('reactions').select('*').eq('comment_id', commentId).eq('telegram_id', ctx.from.id).limit(1).maybeSingle();
          if (existing) {
            if (existing.type === type) {
              // same reaction => remove
              await db.supabase.from('reactions').delete().eq('id', existing.id);
            } else {
              // update type
              await db.supabase.from('reactions').update({ type }).eq('id', existing.id);
            }
          } else {
            // insert
            await db.supabase.from('reactions').insert([{ comment_id: commentId, telegram_id: ctx.from.id, type }]);
          }
          await ctx.answerCbQuery('Saved');
          // refresh counts on that message
          await refreshCodeInline(ctx, commentId);
        } catch (e) {
          console.error('react handler err', e);
          await ctx.answerCbQuery('Error');
        }
        return;
      }

      // reaction for replies (prefixed rreact) — similar logic, reply scoped
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
        } catch (e) { console.error('fav err', e); await ctx.answerCbQuery('Error'); }
        return;
      }

      // show replies for a comment (paginated)
      if (cmd === 'list_replies') {
        const commentId = Number(a1);
        const page = Number(a2 || 1);
        try {
          const perPage = 5;
          const offset = (page - 1) * perPage;
          const { data: replies } = await db.supabase.from('replies').select('*').eq('comment_id', commentId).order('created_at', { ascending: true }).range(offset, offset + perPage - 1);
          if (!replies || replies.length === 0) { await ctx.reply('No replies yet.'); return ctx.answerCbQuery(); }
          for (const r of replies) {
            if (r.telegram_file_id) await ctx.replyWithVoice(r.telegram_file_id, { caption: `${r.replier_first_name || r.replier_username || 'User'}` });
            else await ctx.reply(`${r.replier_first_name || r.replier_username || 'User'}: ${r.reply_text || '(no text)'}`);
            await ctx.reply(`Code: ${utils.encodeShortCode(r.id)}`, buildReplyInline(r.id, ctx.from.id, commentId));
          }
          // next page
          const { count } = await db.supabase.from('replies').select('id', { count: 'exact' }).eq('comment_id', commentId);
          const total = count || 0;
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

      // delete thread (tracked video)
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

      // cancel action
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
          // credit user
          await creditUser(payment.telegram_id, payment.comments_amount);
          await db.updatePaymentStatus(pid, 'approved', { approved_by: ctx.from.id, approved_at: new Date().toISOString() });
          await ctx.answerCbQuery('Approved');
          await bot.telegram.sendMessage(payment.telegram_id, `Your payment was approved by admin. You received ${payment.comments_amount} comments.`);
          return ctx.reply(`Payment #${pid} approved and ${payment.comments_amount} credits added to user ${payment.telegram_id}.`);
        } catch (e) { console.error('admin_approve err', e); await ctx.answerCbQuery('Error approving'); }
        return;
      }

      // admin reject payment
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

  // text reply handler for reply_text pending or report reason
  bot.on('text', async (ctx) => {
    const uid = ctx.from.id;
    const pending = Pending.get(uid);
    if (!pending) return;
    // reply_text
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
        // text reply free -> no debit
        await ctx.reply('Reply saved.');
        const comment = await db.getCommentById(pending.commentId).catch(()=>null);
        if (comment && comment.telegram_id && comment.telegram_id !== uid) {
          await db.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply to your comment ${utils.encodeShortCode(comment.id)}`, meta: { comment_id: comment.id } }).catch(()=>null);
        }
      } catch (e) { console.error('reply_text insert err', e); await ctx.reply('Could not save reply.'); }
    }
    // other text pending handled above (upload_proof, report reasons, search)
  });

  return bot;
}

module.exports = { initBot };
