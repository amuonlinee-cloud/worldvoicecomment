// src/bot.js
// Restored + cleaned bot using Supabase only; link normalization restored; buy flow reverted to confirm/cancel.
// - No in-memory fallback for persistence
// - Replies decrement balance
// - Report flow asks for reason and sends to admins
// - Pending actions cancel when user presses other main keyboard buttons
// - Admin notification posting included
//
// Requirements: set SUPABASE_URL, SUPABASE_KEY, TELEGRAM_BOT_TOKEN, ADMIN_IDS in env

const { Telegraf, Markup } = require('telegraf');
const db = require('./database');   // MUST exist and export supabase + functions
const utils = require('./utils');
const debug = (...args) => console.log('[bot]', ...args);

// config
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const WHATSAPP_ADMIN = (process.env.WHATSAPP_ADMIN || '').replace(/\D/g,'');
const WHATSAPP_LINK = WHATSAPP_ADMIN ? `https://wa.me/${WHATSAPP_ADMIN}` : null;

const PAYMENT_PACKAGES = [
  { id: 'pkg1', label: '25 comments - 12 ETB', credits: 25, amount: 12 },
  { id: 'pkg2', label: '60 comments - 27 ETB', credits: 60, amount: 27 },
  { id: 'pkg3', label: '130 comments - 49 ETB', credits: 130, amount: 49 },
  { id: 'pkg4', label: '240 comments - 89 ETB', credits: 240, amount: 89 }
];

const MAIN_KB = Markup.keyboard([
  ['🎥 Add Comment', '➕ Add My Video'],
  ['🔖 Track Video', '🎧 Listen Comments'],
  ['💬 My Comments', '🔎 Search'],
  ['⭐ Favorites', '🔔 Notifications'],
  ['🛒 Buy', '🆘 Support'],
  ['💰 Balance']
], { columns: 2 }).resize();

// pending actions map per user
const Pending = new Map(); // key: telegramId -> { type: '...', ... }

// helper: cancel pending when user presses main keyboard
function maybeCancelPendingForMain(telegramId) {
  if (Pending.has(telegramId)) {
    Pending.delete(telegramId);
  }
}

// helper: admin check
function isAdmin(id) {
  return ADMIN_IDS.includes(Number(id));
}

// get user balance from DB users.free_comments
async function getUserBalance(telegramId) {
  try {
    const sb = db.supabase;
    const { data, error } = await sb.from('users').select('free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
    if (error) throw error;
    return Number((data && data.free_comments) || 0);
  } catch (e) {
    console.error('getUserBalance err', e && (e.message || e));
    throw e;
  }
}

async function decrementUserBalance(telegramId, amount = 1) {
  try {
    const sb = db.supabase;
    const { data: userRow, error } = await sb.from('users').select('free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
    if (error) throw error;
    const current = Number((userRow && userRow.free_comments) || 0);
    if (current < amount) return { error: 'insufficient' };
    const next = current - amount;
    const { data, error: upErr } = await sb.from('users').update({ free_comments: next }).eq('telegram_id', telegramId).select().maybeSingle();
    if (upErr) throw upErr;
    return { data };
  } catch (e) {
    console.error('decrementUserBalance err', e);
    throw e;
  }
}

// notify admins utility
async function notifyAdmins(text, opts = {}) {
  try {
    for (const admin of ADMIN_IDS) {
      try { await bot.telegram.sendMessage(admin, text, opts); } catch (e) { console.error('notify admin send err', e); }
    }
  } catch (e) { console.error('notifyAdmins err', e); }
}

// Build inline keyboard for comment (reactions, fav, replies, report, delete)
async function buildCommentInline(commentId, userId) {
  const inline = Markup.inlineKeyboard([
    [
      Markup.button.callback('❤️', `react|${commentId}|heart`),
      Markup.button.callback('😂', `react|${commentId}|laugh`),
      Markup.button.callback('👎', `react|${commentId}|dislike`)
    ],
    [
      Markup.button.callback('☆ Favorite', `fav|${commentId}`),
      Markup.button.callback('▶️ Show replies', `list_replies|${commentId}|1`),
      Markup.button.callback('💬 Reply', `replymenu|${commentId}`)
    ],
    [
      Markup.button.callback('🚩 Report', `report|${commentId}`),
      Markup.button.callback('🗑 Delete', `delete_comment|${commentId}`)
    ]
  ]);
  return inline;
}

// Send comments for a thread (paginated)
async function sendCommentsPage(ctx, threadId, page=1, perPage=5) {
  try {
    const { data } = await db.listCommentsByThread(threadId, (page-1)*perPage, perPage);
    if (!data || data.length === 0) return ctx.reply('No comments yet.');
    for (const c of data) {
      if (c.telegram_file_id) {
        await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${utils.encodeShortCode(c.id)}` });
      } else {
        await ctx.reply(`${c.first_name || c.username || 'User'} • ${utils.encodeShortCode(c.id)}`);
      }
      const inline = await buildCommentInline(c.id, ctx.from.id);
      await ctx.reply(`Code: ${utils.encodeShortCode(c.id)}`, inline);
    }
    if (data.length === perPage) {
      await ctx.reply('More comments:', Markup.inlineKeyboard([[ Markup.button.callback('More', `listen|${threadId}|${page+1}`) ]]));
    }
  } catch (e) {
    console.error('sendCommentsPage err', e);
    await ctx.reply('Error while fetching comments.');
  }
}

// HANDLE: start
const initBot = async () => {
  const botInstance = new Telegraf(BOT_TOKEN);
  global.bot = botInstance;

  botInstance.start(async (ctx) => {
    try {
      const user = ctx.from;
      await db.ensureUserRow(user);
      const balance = await getUserBalance(user.id);
      await ctx.reply(`Welcome! You have *${balance}* comments available.`, { parse_mode: 'Markdown' });
      await ctx.reply('Use the keyboard below.', MAIN_KB);
    } catch (e) {
      console.error('start err', e);
      await ctx.reply('Welcome. (error reading balance)');
    }
  });

  // HELP/SUPPORT
  botInstance.command('support', async (ctx) => {
    const txt = WHATSAPP_LINK ? `Contact admin via WhatsApp: ${WHATSAPP_LINK}` : 'Contact admin (no WhatsApp configured).';
    await ctx.reply(txt);
  });

  // NOTIFICATIONS
  botInstance.command('notifications', async (ctx) => {
    try {
      const rows = await db.listNotifications(ctx.from.id);
      if (!rows || rows.length === 0) return ctx.reply('No notifications.');
      for (const n of rows) {
        await ctx.reply(n.message || '(notification)');
      }
    } catch (e) {
      console.error('notifications err', e);
      await ctx.reply('Could not fetch notifications.');
    }
  });

  // BUY: show packages and confirm/cancel inline (reverted to the confirm/cancel flow you wanted)
  botInstance.hears(/🛒 buy|^buy$/i, async (ctx) => {
    maybeCancelPendingForMain(ctx.from.id);
    const inline = PAYMENT_PACKAGES.map(p => [ Markup.button.callback(p.label, `select_pkg|${p.id}`) ]);
    inline.push([ Markup.button.callback('Contact support', 'contact_whatsapp') ]);
    await ctx.reply('Choose a package:', Markup.inlineKeyboard(inline));
  });

  // TEXT handler: keyboard & link flows
  botInstance.on('text', async (ctx) => {
    const text = (ctx.message && ctx.message.text) || '';
    const uid = ctx.from.id;
    // cancel pending if user presses a main keyboard label
    const normalized = text.trim().toLowerCase();
    const mainLabels = ['🎥 add comment','➕ add my video','🔖 track video','🎧 listen comments','💬 my comments','🔎 search','⭐ favorites','🔔 notifications','🛒 buy','🆘 support','💰 balance'];
    if (mainLabels.includes(normalized)) maybeCancelPendingForMain(uid);

    // Pending handlers first
    const pending = Pending.get(uid);

    // If pending expecting report reason
    if (pending && pending.type === 'await_report_reason' && pending.commentId) {
      Pending.delete(uid);
      const reason = text.trim();
      try {
        await db.insertReport({ reporter_telegram_id: uid, comment_id: pending.commentId, reason });
      } catch (e) { console.error('insertReport err', e); }
      // notify admins with the reported voice if exists
      const comment = await db.getCommentById(pending.commentId).catch(()=>null);
      const thread = comment ? await db.getThreadById(comment.thread_id).catch(()=>null) : null;
      const header = `🚨 Report: ${utils.encodeShortCode(pending.commentId)}\nReporter: ${ctx.from.username || ctx.from.first_name} (${uid})\nReason: ${reason}\nVideo: ${thread ? (thread.social_link || thread.canonical_link) : '(unknown)'}`;
      for (const adm of ADMIN_IDS) {
        try {
          if (comment && comment.telegram_file_id) {
            await botInstance.telegram.sendVoice(adm, comment.telegram_file_id, { caption: header });
          } else {
            await botInstance.telegram.sendMessage(adm, header);
          }
        } catch (e) { console.error('notify admin report err', e); }
      }
      await ctx.reply('Thank you. Your report was sent to admins.');
      return;
    }

    // Pending expecting search code
    if (pending && pending.type === 'await_search_code') {
      Pending.delete(uid);
      const code = text.trim();
      let id = utils.decodeShortCode(code);
      if (!id) return ctx.reply('Invalid code.');
      const comment = await db.getCommentById(id).catch(()=>null);
      if (!comment) return ctx.reply('Comment not found.');
      if (comment.telegram_file_id) await ctx.replyWithVoice(comment.telegram_file_id, { caption: `Comment ${code}` });
      else await ctx.reply(`Comment ${code} (no voice).`);
      return;
    }

    // Pending: upload payment proof text
    if (pending && pending.type === 'await_upload_proof' && pending.paymentId) {
      Pending.delete(uid);
      try {
        await db.updatePaymentStatus(pending.paymentId, 'proof_submitted', { proof_link: text.trim() });
        // notify admins
        for (const adm of ADMIN_IDS) {
          await botInstance.telegram.sendMessage(adm, `Payment proof for #${pending.paymentId} received:\n${text.trim()}`);
        }
        await ctx.reply('Proof received. Admins will review.');
      } catch (e) {
        console.error('upload proof text err', e);
        await ctx.reply('Could not submit proof.');
      }
      return;
    }

    // If message contains a link -> create/find thread and show options
    const candidateUrl = utils.extractFirstUrl(text);
    if (candidateUrl) {
      try {
        const thread = await db.findOrCreateThread(candidateUrl, null);
        await ctx.reply(`Thread: ${thread.social_link || thread.canonical_link || candidateUrl}`);
        await ctx.reply('What next?', Markup.inlineKeyboard([[ Markup.button.callback('🎙 Add Voice Comment', `addvoice|${thread.id}`), Markup.button.callback('🎧 Listen Comments', `listen|${thread.id}|1`) ]]));
      } catch (e) {
        console.error('create/find thread err', e);
        await ctx.reply('Could not create thread (DB error).');
      }
      return;
    }

    // MAIN KEYBOARD text handlers
    if (/^\s*🎥 add comment\s*$|^add comment$/i.test(text)) {
      Pending.set(uid, { type: 'await_link_for_add' });
      return ctx.reply('Send the TikTok/YouTube link for which you want to add a voice comment.');
    }
    if (/^\s*➕ add my video\s*$|^add my video$/i.test(text)) {
      Pending.set(uid, { type: 'await_link_track' });
      return ctx.reply('Send the link of your own video to track.');
    }
    if (/^\s*🔖 track video\s*$|^track video$/i.test(text)) {
      try {
        const threads = await db.listThreadsByCreator(ctx.from.id);
        if (!threads || threads.length === 0) return ctx.reply('You have not tracked any videos yet.');
        for (const t of threads) {
          await ctx.reply(`${t.social_link || t.canonical_link} (tracked)`, Markup.inlineKeyboard([[ Markup.button.callback('🎧 Listen Comments', `listen|${t.id}|1`), Markup.button.callback('🗑 Delete tracked', `delete_thread|${t.id}`) ]]));
        }
      } catch (e) { console.error('track list err', e); return ctx.reply('Could not list tracked videos.'); }
      return;
    }
    if (/^\s*🎧 listen comments\s*$|^listen comments$/i.test(text)) {
      Pending.set(uid, { type: 'await_link_for_listen' });
      return ctx.reply('Send a TikTok/YouTube link or click a tracked video to listen comments.');
    }
    if (/^\s*💬 my comments\s*$|^my comments$/i.test(text)) {
      try {
        const rows = await db.listCommentsByUser(ctx.from.id);
        if (!rows || rows.length === 0) return ctx.reply('No comments found.');
        for (const c of rows) {
          if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `Your comment ${utils.encodeShortCode(c.id)}` });
          else await ctx.reply(`Your comment ${utils.encodeShortCode(c.id)}`);
          await ctx.reply('Options:', await buildCommentInline(c.id, ctx.from.id));
        }
      } catch (e) { console.error('my comments err', e); await ctx.reply('Could not fetch your comments.'); }
      return;
    }
    if (/^\s*⭐ favorites\s*$|^favorites$/i.test(text)) {
      try {
        const favs = await db.listFavoritesForUser(ctx.from.id);
        if (!favs || favs.length === 0) return ctx.reply('No favorites.');
        for (const f of favs) {
          if (f.telegram_file_id) await ctx.replyWithVoice(f.telegram_file_id, { caption: `Favorite ${utils.encodeShortCode(f.id)}` });
          else await ctx.reply(`Favorite ${utils.encodeShortCode(f.id)}`);
          await ctx.reply('Options:', await buildCommentInline(f.id, ctx.from.id));
        }
      } catch (e) { console.error('favorites err', e); await ctx.reply('Could not fetch favorites.'); }
      return;
    }
    if (/^\s*🔎 search\s*$|^search$/i.test(text)) {
      Pending.set(uid, { type: 'await_search_code' });
      return ctx.reply('Send the short code (e.g. 0000A9) or /search CODE');
    }
    if (/^\s*💰 balance\s*$|^balance$/i.test(text)) {
      try {
        const b = await getUserBalance(ctx.from.id);
        return ctx.reply(`Your balance: *${b}*`, { parse_mode: 'Markdown', reply_markup: MAIN_KB.reply_markup });
      } catch (e) { return ctx.reply('Could not fetch balance.'); }
    }

    // If pending expecting a link for actions:
    if (pending && pending.type === 'await_link_for_add') {
      Pending.delete(uid);
      const url = candidateUrl || text;
      if (!url) return ctx.reply('No link detected.');
      try {
        const thread = await db.findOrCreateThread(url, null);
        Pending.set(uid, { type: 'await_add_comment_voice', threadId: thread.id });
        return ctx.reply('Now send the voice message to add as a comment to that video.');
      } catch (e) { console.error('await_link_for_add err', e); return ctx.reply('Could not prepare adding comment.'); }
    }

    if (pending && pending.type === 'await_link_track') {
      Pending.delete(uid);
      const url = candidateUrl || text;
      if (!url) return ctx.reply('No link detected.');
      try {
        const t = await db.findOrCreateThread(url, ctx.from.id);
        return ctx.reply('Video tracked. You will be notified on replies.');
      } catch (e) { console.error('track err', e); return ctx.reply('Could not track video.'); }
    }

    if (pending && pending.type === 'await_link_for_listen') {
      Pending.delete(uid);
      const url = candidateUrl || text;
      if (!url) return ctx.reply('No link detected.');
      try {
        const thread = await db.getThreadByLink(url);
        if (!thread) return ctx.reply('No comments for that video yet.');
        await sendCommentsPage(ctx, thread.id, 1);
      } catch (e) { console.error('listen err', e); await ctx.reply('Could not list comments.'); }
      return;
    }

    // default fallback
    return ctx.reply('I did not understand that. Press a button or send a video link.', MAIN_KB);
  });

  // PHOTO handling (upload payment proof)
  botInstance.on('photo', async (ctx) => {
    const uid = ctx.from.id;
    const pending = Pending.get(uid);
    if (!pending) return;
    if (pending.type === 'await_upload_proof' && pending.paymentId) {
      Pending.delete(uid);
      try {
        const photos = ctx.message.photo; // array
        const best = photos[photos.length - 1];
        const fileId = best.file_id;
        await db.updatePaymentStatus(pending.paymentId, 'proof_submitted', { proof_telegram_file_id: fileId });
        for (const adm of ADMIN_IDS) {
          await botInstance.telegram.sendPhoto(adm, fileId, { caption: `Payment proof for #${pending.paymentId} by ${ctx.from.id}` });
        }
        await ctx.reply('Proof received. Admins will review.');
      } catch (e) { console.error('photo upload proof err', e); await ctx.reply('Could not upload proof.'); }
    }
  });

  // VOICE handling (add comment or reply)
  botInstance.on('voice', async (ctx) => {
    const uid = ctx.from.id;
    const pending = Pending.get(uid);
    if (!pending) return ctx.reply('No expected action for voice right now.');
    // Add comment voice
    if (pending.type === 'await_add_comment_voice' && pending.threadId) {
      Pending.delete(uid);
      const voice = ctx.message.voice;
      if (!voice) return ctx.reply('No voice found.');
      try {
        const inserted = await db.insertVoiceComment({
          thread_id: pending.threadId,
          telegram_id: uid,
          username: ctx.from.username || null,
          first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id,
          duration: voice.duration || 0
        });
        // decrement balance
        await decrementUserBalance(uid, 1).catch(e => console.error('decrement after add comment err', e));
        const id = inserted && inserted.id ? inserted.id : null;
        await ctx.reply('Voice comment saved. Code: ' + utils.encodeShortCode(id), MAIN_KB);
        // notify thread owner if tracked
        const thread = await db.getThreadById(pending.threadId).catch(()=>null);
        if (thread && thread.creator_telegram_id && thread.creator_telegram_id !== uid) {
          await db.addNotificationRow({ telegram_id: thread.creator_telegram_id, message: `New comment on your tracked video: ${utils.encodeShortCode(id)}`, meta: { comment_id: id } }).catch(()=>null);
        }
      } catch (e) { console.error('insertVoiceComment err', e); return ctx.reply('Could not save voice comment (DB error).'); }
      return;
    }

    // Reply voice
    if (pending.type === 'await_reply_voice' && pending.commentId) {
      Pending.delete(uid);
      const voice = ctx.message.voice;
      if (!voice) return ctx.reply('No voice found.');
      try {
        const inserted = await db.insertReplyRow({
          comment_id: pending.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id,
          duration: voice.duration || 0
        });
        await decrementUserBalance(uid, 1).catch(e => console.error('decrement after reply err', e));
        await ctx.replyWithVoice(voice.file_id, { caption: `Reply saved • ${utils.encodeShortCode(inserted.id)}` });
        // notify original comment owner
        const comment = await db.getCommentById(pending.commentId).catch(()=>null);
        if (comment && comment.telegram_id && comment.telegram_id !== uid) {
          await db.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply to your comment ${utils.encodeShortCode(comment.id)}`, meta: { comment_id: comment.id } }).catch(()=>null);
        }
      } catch (e) { console.error('insertReplyRow err', e); return ctx.reply('Could not save reply.'); }
      return;
    }

    // report reply via voice (pending)
    if (pending.type === 'await_report_reply_voice' && pending.replyId) {
      Pending.delete(uid);
      const voice = ctx.message.voice;
      try {
        await db.insertReport({ reporter_telegram_id: uid, reply_id: pending.replyId, report_telegram_file_id: voice.file_id });
        // notify admins
        for (const adm of ADMIN_IDS) {
          await botInstance.telegram.sendVoice(adm, voice.file_id, { caption: `Reply report: reply #${pending.replyId} by ${ctx.from.username || ctx.from.first_name}` });
        }
        await ctx.reply('Voice report submitted. Admins will review.');
      } catch (e) { console.error('report reply voice err', e); await ctx.reply('Could not send report.'); }
      return;
    }

    return ctx.reply('No expected action for voice now.');
  });

  // CALLBACKS
  botInstance.on('callback_query', async (ctx) => {
    try {
      const data = ctx.callbackQuery && ctx.callbackQuery.data;
      if (!data) return ctx.answerCbQuery();
      const parts = data.split('|');
      const cmd = parts[0];
      const a1 = parts[1];
      const a2 = parts[2];

      // contact whatsapp
      if (cmd === 'contact_whatsapp') {
        await ctx.reply(WHATSAPP_LINK || 'WhatsApp not configured');
        return ctx.answerCbQuery();
      }

      // select package -> show confirm/cancel inline (reverted)
      if (cmd === 'select_pkg') {
        const pkg = PAYMENT_PACKAGES.find(p => p.id === a1);
        if (!pkg) return ctx.answerCbQuery('Invalid package');
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback(`Confirm ${pkg.label}`, `confirm_pkg|${pkg.id}`), Markup.button.callback('Cancel', 'cancel_action') ]
        ]);
        await ctx.reply(`You selected ${pkg.label}. Confirm to get payment details.`, inline);
        return ctx.answerCbQuery();
      }

      // Confirm package -> create payment request and show payment details
      if (cmd === 'confirm_pkg') {
        const pkg = PAYMENT_PACKAGES.find(p => p.id === a1);
        if (!pkg) return ctx.answerCbQuery('Invalid package');
        try {
          const created = await db.createPaymentRequest({ telegram_id: ctx.from.id, package_name: pkg.label, comments_amount: pkg.credits, amount: pkg.amount, status: 'pending' });
          const pid = created.id;
          // show payment details and copy buttons
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
          // inform admins
          for (const adm of ADMIN_IDS) {
            await botInstance.telegram.sendMessage(adm, `New payment request #${pid} by ${ctx.from.id} — ${pkg.label}`);
          }
        } catch (e) {
          console.error('createPaymentRequestFlow err', e);
          await ctx.reply('Could not create payment request. Contact support.');
        }
        return ctx.answerCbQuery();
      }

      // copy click
      if (cmd === 'copy') {
        await ctx.answerCbQuery('Copied (sent as message)');
        await ctx.reply(`Copied: ${a1}`);
        return;
      }

      // upload proof (set pending)
      if (cmd === 'upload_proof') {
        const pid = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_upload_proof', paymentId: pid });
        await ctx.reply(`Send the proof image or paste the link for payment #${pid}.`);
        return ctx.answerCbQuery();
      }

      // add voice inline
      if (cmd === 'addvoice') {
        const threadId = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_add_comment_voice', threadId });
        await ctx.reply('Send voice to add as comment.');
        return ctx.answerCbQuery();
      }

      // listen inline -> display comments page
      if (cmd === 'listen') {
        const threadId = Number(a1);
        const page = Number(a2) || 1;
        await sendCommentsPage(ctx, threadId, page);
        return ctx.answerCbQuery();
      }

      // reply menu
      if (cmd === 'replymenu') {
        const commentId = Number(a1);
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('Reply with voice', `reply_voice|${commentId}`), Markup.button.callback('Reply with text', `reply_text|${commentId}`) ]
        ]);
        await ctx.reply('Choose reply type:', inline);
        return ctx.answerCbQuery();
      }
      if (cmd === 'reply_voice') {
        const commentId = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_reply_voice', commentId });
        await ctx.reply('Send voice now.');
        return ctx.answerCbQuery();
      }
      if (cmd === 'reply_text') {
        const commentId = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_reply_text', commentId });
        await ctx.reply('Send reply text now.');
        return ctx.answerCbQuery();
      }

      // report comment -> ask for reason text
      if (cmd === 'report') {
        const commentId = Number(a1);
        Pending.set(ctx.from.id, { type: 'await_report_reason', commentId });
        await ctx.reply('Please explain why you are reporting this comment (short text).');
        return ctx.answerCbQuery();
      }

      // delete comment (only owner or admin)
      if (cmd === 'delete_comment') {
        const commentId = Number(a1);
        const comment = await db.getCommentById(commentId).catch(()=>null);
        if (!comment) { await ctx.answerCbQuery('Comment not found'); return; }
        if (comment.telegram_id === ctx.from.id || isAdmin(ctx.from.id)) {
          await db.deleteCommentById(commentId).catch(e => console.error('delete comment err', e));
          await ctx.reply('Comment deleted.');
        } else {
          await ctx.answerCbQuery('Not authorized');
        }
        return ctx.answerCbQuery();
      }

      // react
      if (cmd === 'react') {
        const commentId = Number(a1);
        const type = a2;
        try {
          await db.insertReactionRow({ comment_id: commentId, telegram_id: ctx.from.id, type });
          await ctx.answerCbQuery('Reaction saved');
        } catch (e) { console.error('react insert err', e); await ctx.answerCbQuery('Could not save reaction'); }
        return;
      }

      // fav toggle
      if (cmd === 'fav') {
        const commentId = Number(a1);
        try {
          const res = await db.toggleFavoriteRow(ctx.from.id, commentId);
          await ctx.answerCbQuery(res.removed ? 'Favorite removed' : 'Favorite added');
        } catch (e) { console.error('fav err', e); await ctx.answerCbQuery('Could not toggle favorite'); }
        return;
      }

      // delete tracked thread
      if (cmd === 'delete_thread') {
        const tid = Number(a1);
        const thread = await db.getThreadById(tid).catch(()=>null);
        if (!thread) { await ctx.answerCbQuery('Not found'); return; }
        if (thread.creator_telegram_id === ctx.from.id || isAdmin(ctx.from.id)) {
          await db.deleteThreadById(tid).catch(e => console.error('delete thread err', e));
          await ctx.reply('Tracked video deleted.');
        } else await ctx.answerCbQuery('Not authorized');
        return ctx.answerCbQuery();
      }

      // search => open search prompt
      if (cmd === 'start_search') {
        Pending.set(ctx.from.id, { type: 'await_search_code' });
        await ctx.reply('Send the code (e.g. 0000A9).');
        return ctx.answerCbQuery();
      }

      // cancel action
      if (cmd === 'cancel_action') {
        Pending.delete(ctx.from.id);
        await ctx.reply('Action cancelled.', MAIN_KB);
        return ctx.answerCbQuery('Cancelled');
      }

      return ctx.answerCbQuery();
    } catch (err) {
      console.error('callback_query err', err && (err.stack || err));
      try { await ctx.answerCbQuery('Error'); } catch (_) {}
    }
  });

  // Text replies used for reply_text pending
  botInstance.on('text', async (ctx) => {
    const uid = ctx.from.id;
    const pending = Pending.get(uid);
    if (!pending) return;
    if (pending.type === 'await_reply_text' && pending.commentId) {
      Pending.delete(uid);
      try {
        const inserted = await db.insertReplyRow({
          comment_id: pending.commentId,
          replier_telegram_id: uid,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          reply_text: ctx.message.text
        });
        await decrementUserBalance(uid, 1).catch(e => console.error('decrement after reply text err', e));
        await ctx.reply('Reply saved.');
        // notify owner
        const comment = await db.getCommentById(pending.commentId).catch(()=>null);
        if (comment && comment.telegram_id && comment.telegram_id !== uid) {
          await db.addNotificationRow({ telegram_id: comment.telegram_id, message: `New reply to your comment ${utils.encodeShortCode(comment.id)}`, meta: { comment_id: comment.id } }).catch(()=>null);
        }
      } catch (e) { console.error('reply_text insert err', e); await ctx.reply('Could not save reply text.'); }
    }
  });

  return botInstance;
};

module.exports = { initBot };
