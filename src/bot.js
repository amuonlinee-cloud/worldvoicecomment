// src/bot.js
// World Voice Comment — updated to ensure setThreadCreator and to auto-cancel pending flows when user switches actions

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
  const m = String(s).match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
};
utils.encodeShortCode = utils.encodeShortCode || function (id) {
  if (id === undefined || id === null) return '';
  const v = Number(id) || 0;
  return v.toString(36).toUpperCase().padStart(6, '0');
};
utils.decodeShortCode = utils.decodeShortCode || function (code) {
  if (!code) return null;
  try { return parseInt(String(code).toLowerCase(), 36); } catch (e) { return null; }
};
// normalizeVideoUrl in your utils should return { canonicalLink, provider, id } — fallback uses original
utils.normalizeVideoUrl = utils.normalizeVideoUrl || (async (url) => ({ canonicalLink: url }));
utils.isSupportedLink = utils.isSupportedLink || (s => !!s && /tiktok\.com|youtube\.com|youtu\.be|vm\.tiktok\.com/i.test(s));

// safeDb wrappers
const safeDb = db || {};

// ---------- Config ----------
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

const PendingMap = new Map();

async function safeSend(fn, ...args) {
  try { return await fn(...args); } catch (e) { console.error('safeSend error', e && (e.stack || e)); return null; }
}

// unified getUserBalance using safeDb
async function getUserBalance(telegramId) {
  try {
    if (!safeDb || !safeDb.getUserBalance) return 0;
    return await safeDb.getUserBalance(telegramId);
  } catch (e) {
    console.error('getUserBalance err', e && e.message);
    return 0;
  }
}

// unified credit and decrement wrappers using safeDb
async function creditUser(telegramId, creditsToAdd) {
  try {
    if (!safeDb || !safeDb.creditUser) throw new Error('DB creditUser not available');
    return await safeDb.creditUser(telegramId, creditsToAdd);
  } catch (e) {
    console.error('creditUser err', e && e.message);
    throw e;
  }
}
async function decrementUserBalance(telegramId, amount = 1) {
  try {
    if (!safeDb || !safeDb.decrementUserBalance) throw new Error('DB decrementUserBalance not available');
    return await safeDb.decrementUserBalance(telegramId, amount);
  } catch (e) {
    console.error('decrementUserBalance err', e && e.message);
    throw e;
  }
}

// Reaction counts (unchanged)
async function getReactionCounts(commentId) {
  try {
    if (safeDb && safeDb.supabase) {
      const heartQ = await safeDb.supabase.from('reactions').select('id', { count: 'exact' }).eq('comment_id', commentId).eq('type', 'heart');
      const laughQ = await safeDb.supabase.from('reactions').select('id', { count: 'exact' }).eq('comment_id', commentId).eq('type', 'laugh');
      const dislikeQ = await safeDb.supabase.from('reactions').select('id', { count: 'exact' }).eq('comment_id', commentId).eq('type', 'dislike');
      return {
        heart: (heartQ && heartQ.count) ? heartQ.count : 0,
        laugh: (laughQ && laughQ.count) ? laughQ.count : 0,
        dislike: (dislikeQ && dislikeQ.count) ? dislikeQ.count : 0
      };
    }
  } catch (e) { console.error('getReactionCounts supabase err', e); }
  return { heart: 0, laugh: 0, dislike: 0 };
}

async function buildActionsInline(commentId, userId) {
  const reactionCounts = await getReactionCounts(commentId);
  const isFav = await safeDb.isFavorite(userId, commentId).catch(e => { console.error('isFavorite err', e); return false; });
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
    Markup.button.callback('🗑 Delete', `delete_comment|${commentId}`)
  ];
  return Markup.inlineKeyboard([row1, row2, row3]);
}

// showRepliesForComment — robust to various DB return shapes + pagination + report buttons for replies
async function showRepliesForComment(ctx, commentId, page = 1, perPage = 10) {
  try {
    const raw = await safeDb.listReplies(commentId);
    let rows = [];
    if (!raw) rows = [];
    else if (Array.isArray(raw)) rows = raw;
    else if (raw.data && Array.isArray(raw.data)) rows = raw.data;
    else rows = [];

    if (!rows || rows.length === 0) {
      return ctx.reply('No replies yet.');
    }

    const start = (page - 1) * perPage;
    const chunk = rows.slice(start, start + perPage);
    for (const r of chunk) {
      // send reply content
      if (r.telegram_file_id && !r.reply_text && !r.reply_photo_url) {
        try { await ctx.replyWithVoice(r.telegram_file_id, { caption: `↳ ${r.replier_first_name || r.replier_username || 'User'}` }); } catch (e) { console.error('reply voice send err', e); }
      } else if (r.reply_photo_url || r.telegram_file_id) {
        try {
          const photoId = r.reply_photo_url || r.telegram_file_id;
          await ctx.replyWithPhoto(photoId, { caption: `↳ ${r.replier_first_name || r.replier_username || 'User'}` });
        } catch (e) { console.error('reply photo send err', e); }
      } else if (r.reply_text) {
        await ctx.reply(`↳ ${r.replier_first_name || r.replier_username || 'User'}: ${r.reply_text}`);
      } else {
        await ctx.reply(`↳ ${r.replier_first_name || r.replier_username || 'User'}`);
      }

      // provide a small report keyboard for this reply (report by text or voice)
      try {
        const inline = Markup.inlineKeyboard([
          [ Markup.button.callback('🚩 Report text', `report_reply_text|${r.id}`), Markup.button.callback('🎙 Report voice', `report_reply_voice|${r.id}`) ]
        ]);
        await ctx.reply('Reply options:', inline);
      } catch (e) { /* ignore */ }
    }

    // more button if needed
    if (rows.length > start + chunk.length) {
      const next = page + 1;
      await ctx.reply('More replies:', Markup.inlineKeyboard([[Markup.button.callback('More replies', `list_replies|${commentId}|${next}`)]]));
    }

  } catch (e) {
    console.error('showRepliesForComment error', e);
    await ctx.reply('Error listing replies.');
  }
}

// notifications command handler (reusable)
async function handleNotificationsCommand(ctx) {
  try {
    const res = await safeDb.listNotifications(ctx.from.id).catch(()=>({ data: [] }));
    const rows = (res && res.data) ? res.data : (Array.isArray(res) ? res : (res || []));
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
      } catch (e) { /* ignore */ }
      await ctx.reply(text);
    }
    await ctx.reply('End of notifications.', mainKeyboard());
  } catch (e) {
    console.error('/notifications db err', e);
    await ctx.reply('Could not fetch notifications.');
  }
}

// favorites listing helper (exposed to keyboard flow)
async function showFavoritesCommand(ctx) {
  try {
    const favRows = await safeDb.listFavoritesForUser(ctx.from.id);
    if (!favRows || favRows.length === 0) return ctx.reply('No favorites yet.', mainKeyboard());
    for (const c of favRows) {
      if (c.telegram_file_id) {
        await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${new Date(c.created_at).toLocaleString()}` });
      } else {
        await ctx.reply('Favorite comment (no voice stored).');
      }
      let videoLink = '(video unknown)';
      try {
        const thread = await safeDb.getThreadById(c.thread_id);
        if (thread) videoLink = thread.social_link || thread.canonical_link || videoLink;
      } catch (e) {}
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

async function listFavoritesForUser(telegramId) {
  try {
    return await safeDb.listFavoritesForUser(telegramId);
  } catch (e) { console.error('listFavoritesForUser err', e); return []; }
}

// ---------- initBot ----------
async function initBot() {
  if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in environment');

  const bot = new Telegraf(BOT_TOKEN);

  // notify admins utility
  async function notifyAdmins(text, extra = {}) {
    try {
      if (safeDb.setAdminNotifier) {
        try {
          await safeDb.setAdminNotifier(text, extra);
        } catch (e) { debugLog('safeDb.setAdminNotifier err', e && e.message); }
      }
      for (const adm of ADMIN_IDS) {
        try { await bot.telegram.sendMessage(Number(adm), text); } catch (e) { console.error('notifyAdmins send err', e && e.message); }
      }
    } catch (e) { console.error('notifyAdmins err', e && e.message); }
  }

  // START
  bot.start(async (ctx) => {
    try {
      await safeDb.ensureUserRow(ctx.from).catch(()=>null);
      const balance = await getUserBalance(ctx.from.id).catch(()=>0);
      await ctx.reply(`Welcome to World Voice Comment!\nYou have *${balance}* available comments.`, { parse_mode: 'Markdown' });
      await ctx.reply('Send a TikTok or YouTube link or use the keyboard below.', mainKeyboard());
    } catch (e) {
      console.error('onStart err', e);
      try { await ctx.reply('Welcome — initialization error logged.'); } catch (_) {}
    }
  });

  // /support command
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

  // /notifications command handled above
  bot.command('notifications', handleNotificationsCommand);

  // /favorites uses helper
  bot.command('favorites', async (ctx) => showFavoritesCommand(ctx));

  // /payproof command
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

  // /balance command
  bot.command('balance', async (ctx) => {
    try {
      const bal = await getUserBalance(ctx.from.id);
      return ctx.reply(`Your available comments: *${bal}*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard().reply_markup });
    } catch (e) {
      console.error('/balance err', e);
      return ctx.reply('Could not fetch balance.');
    }
  });

  // createPaymentRequestFlow uses copy buttons + upload proof
  async function createPaymentRequestFlow(ctx, pkg) {
    try {
      const created = await safeDb.createPaymentRequest({
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

      // Send details and inline keyboard together in same message
      try {
        await ctx.replyWithMarkdown(bankText, { reply_markup: inline.reply_markup });
      } catch (e) {
        try { await ctx.reply(bankText, inline); } catch (ee) { /* ignore */ }
      }

      // notify admins in background
      (async () => {
        for (const adm of ADMIN_IDS) {
          try {
            const uname = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || `${ctx.from.id}`);
            await bot.telegram.sendMessage(Number(adm), `🆕 New payment request (client pid ${pid}) by ${ctx.from.id} (${uname}) — ${pkg.label}\nAmount: ${pkg.amount} ETB`).catch(()=>{});
          } catch (err) { /* ignore */ }
        }
      })();

      return;
    } catch (e) {
      console.error('createPaymentRequestFlow err', e);
      try { await ctx.reply('Could not create payment request. Please contact support/WhatsApp.'); } catch (_) {}
      return;
    }
  }

  // ---------- message handler ----------
  bot.on('text', async (ctx) => {
    const textRaw = (ctx.message && ctx.message.text) || '';
    const text = utils.normalizeInput(textRaw);
    const uid = ctx.from && ctx.from.id;
    let p = PendingMap.get(uid);

    // --- EARLY cancel: if user clicked a keyboard label, a slash command, or typed "cancel"/"ignore",
    // cancel previous pending flows before processing them
    const keyboardLabels = [
      '🎥 add comment','➕ add my video','🔖 track video','🎧 listen comments',
      '💬 my comments','🔎 search','⭐ favorites','🔔 notifications','🛒 buy','🆘 support','💰 balance'
    ];
    const nlower = normalizeKbLabel(text);
    const isSlash = (textRaw || '').trim().startsWith('/');
    const isCancel = ['cancel','ignore','back','exit'].includes((textRaw||'').trim().toLowerCase());
    if (isSlash || isCancel || keyboardLabels.includes(nlower)) {
      if (p) {
        PendingMap.delete(uid);
        p = null;
      }
    }
    // --- end early cancel

    // after early cancellation, continue with pending processing for cases where user actually intended to reply
    p = PendingMap.get(uid);

    // process pending handlers first (so reply/photo/text flows are not accidentally cancelled)
    if (p && p.type === 'report_reason' && p.commentId) {
      PendingMap.delete(uid);
      try {
        const commentId = p.commentId;
        const reason = textRaw.trim();
        if (safeDb.supabase) {
          try {
            await safeDb.supabase.from('reports').insert([{ reporter_telegram_id: uid, reporter_username: ctx.from.username || null, comment_id: commentId, reason: reason, created_at: new Date().toISOString() }]);
          } catch (e) { /* ignore */ }
        }
        const comment = await safeDb.getCommentById(commentId).catch(()=>null);
        const thread = comment ? await safeDb.getThreadById(comment.thread_id).catch(()=>null) : null;
        let owner = null;
        try {
          if (comment && comment.telegram_id) {
            owner = await safeDb.getUserByTelegramId ? await safeDb.getUserByTelegramId(comment.telegram_id) : null;
          }
        } catch (e) { /* ignore */ }

        const reporterDisplay = ctx.from.username ? `@${ctx.from.username} (${uid})` : `${ctx.from.first_name || uid} (${uid})`;
        const ownerDisplay = owner ? (owner.username ? `@${owner.username} (${owner.telegram_id})` : `${owner.first_name || owner.telegram_id} (${owner.telegram_id})`) : (comment && comment.telegram_id ? `${comment.telegram_id}` : '(unknown)');

        for (const adm of ADMIN_IDS) {
          try {
            const inline = Markup.inlineKeyboard([
              [Markup.button.callback('Delete comment', `admin_delete_comment|${commentId}`), Markup.button.callback('Ignore', `admin_ignore_report|${commentId}`)]
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
          } catch (e) { console.error('notify admin report reason err', e); }
        }
        await ctx.reply('Thanks — your report was submitted. Admins will review.');
      } catch (e) {
        console.error('report_reason save err', e);
        await ctx.reply('Could not submit report. Try again later.');
      }
      return;
    }

    if (p && p.type === 'report_reply_text' && p.replyId) {
      PendingMap.delete(uid);
      try {
        const reason = textRaw.trim();
        if (safeDb.supabase) {
          try {
            await safeDb.supabase.from('reports').insert([{ reporter_telegram_id: uid, reporter_username: ctx.from.username || null, reply_id: p.replyId, reason: reason, created_at: new Date().toISOString() }]);
          } catch (e) { /* ignore */ }
        }
        for (const adm of ADMIN_IDS) {
          try {
            const msg = `🚨 Report: reply #${p.replyId}\nReporter: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || uid}\nReason: ${reason}`;
            await bot.telegram.sendMessage(Number(adm), msg);
          } catch (e) { console.error('notify admin report reply text err', e); }
        }
        await ctx.reply('Thanks — your report for the reply was submitted.');
      } catch (e) {
        console.error('report_reply_text save err', e);
        await ctx.reply('Could not submit report. Try again later.');
      }
      return;
    }

    if (p && p.type === 'reply_text') {
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
        const comment = await safeDb.getCommentById(commentId);
        if (comment && comment.telegram_id && comment.telegram_id !== ctx.from.id) {
          const short = utils.encodeShortCode(commentId);
          const threadRow = await safeDb.getThreadById(comment.thread_id);
          const videoLink = threadRow ? threadRow.social_link : '(video unknown)';
          const notifyMsg = `${ctx.from.first_name || ctx.from.username} replied to your comment.\n${short}\nReply text: ${textRaw}\nVideo: ${videoLink}`;
          await safeDb.addNotificationRow({ telegram_id: comment.telegram_id, type: 'reply', message: notifyMsg, meta: { comment_id: commentId } }).catch(()=>null);
          try { await bot.telegram.sendMessage(comment.telegram_id, notifyMsg); } catch (_) {}
        }
        return;
      } catch (e) {
        console.error('reply_text save error', e);
        return ctx.reply('Could not save reply text.');
      }
    }

    // handle text proof for payment
    if (p && p.type === 'upload_payproof' && p.paymentId && textRaw && !ctx.message.photo) {
      PendingMap.delete(uid);
      try {
        const pid = p.paymentId;
        const upd = await safeDb.updatePaymentStatus(pid, 'proof_submitted', { proof_url: textRaw });
        if (upd && upd.error) throw upd.error;
        await ctx.reply(`Proof (link/text) received for payment #${pid}. Admins will review.`);

        for (const adm of ADMIN_IDS) {
          try {
            const inline = Markup.inlineKeyboard([
              [Markup.button.callback('Approve', `admin_approve|${pid}`), Markup.button.callback('Reject', `admin_reject|${pid}`)]
            ]);
            await bot.telegram.sendMessage(Number(adm), `Payment proof (link/text) for request #${pid} by ${ctx.from.id}\n\n${textRaw}`, { reply_markup: inline.reply_markup });
          } catch (e) { console.error('notify admin proof text err', e); }
        }
        return;
      } catch (e) {
        console.error('upload_payproof text handler err', e);
        return ctx.reply('Could not submit proof (text).');
      }
    }

    if (p && p.type === 'buy_confirm' && p.pkg) {
      PendingMap.delete(uid);
      return createPaymentRequestFlow(ctx, p.pkg);
    }

    if (p && (p.type === 'create_thread_public' || p.type === 'create_thread_owned')) {
      const url = utils.extractFirstUrl(textRaw);
      if (!url) return ctx.reply('I could not find a link. Send a TikTok or YouTube link.');
      PendingMap.delete(uid);
      try {
        await safeDb.ensureUserRow(ctx.from).catch(()=>null);
        // pass creator id when user selected "Add My Video"
        const creatorId = (p.type === 'create_thread_owned') ? ctx.from.id : null;
        let thread = await safeDb.findOrCreateThread(url, creatorId);
        if (!thread) {
          await ctx.reply('✅ Thread created (fallback).', mainKeyboard());
          return;
        }
        // ensure creator stored if requested and DB didn't set it on insert (best-effort)
        if (p.type === 'create_thread_owned') {
          try {
            if (thread && thread.id) {
              await safeDb.setThreadCreator(thread.id, ctx.from.id).catch(()=>null);
            }
          } catch (e) { /* ignore */ }
        }

        const social = thread.social_link || (thread.canonical_link || url);
        const tid = thread.id || (thread.data && thread.data.id) || null;
        const inline = Markup.inlineKeyboard([
          [Markup.button.callback('🎙 Add Voice Comment', `addvoice|${tid}`), Markup.button.callback('🎧 Listen Comments', `listen|${tid}|1`)]
        ]);
        await ctx.reply(`✅ Thread created: ${social}`, mainKeyboard());
        await ctx.reply('What do you want to do next?', inline);
        return;
      } catch (e) {
        console.error('create thread flow error', e);
        return ctx.reply('Could not create thread (DB error).');
      }
    }

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

    // After pending processing, now check whether the user sent a keyboard label — (this is safe too)
    if (keyboardLabels.includes(nlower)) {
      PendingMap.delete(uid);
    }

    // Keyboard flows
    const n = nlower;
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
        const rows = await safeDb.listThreadsByCreator(ctx.from.id);
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
      const inline = PAYMENT_PACKAGES.map((p, idx) => [Markup.button.callback(p.label, `buypkg|${idx}`)]);
      inline.push([Markup.button.callback('Contact support (WhatsApp)', 'contact_whatsapp')]);
      return ctx.reply('Choose a package:', Markup.inlineKeyboard(inline));
    }
    if (n === normalizeKbLabel('🆘 support')) {
      return ctx.telegram.sendMessage(ctx.chat.id, `Support:\nContact admin on WhatsApp: ${WHATSAPP_LINK}\nOr use /support to get options.`).catch(()=>{});
    }
    if (n === normalizeKbLabel('💰 balance')) {
      const bal = await getUserBalance(ctx.from.id).catch(()=>0);
      return ctx.reply(`Your available comments: *${bal}*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard().reply_markup });
    }

    // direct link handling — normalize + create thread
    const maybeUrl = utils.extractFirstUrl(textRaw) || (utils.isSupportedLink(textRaw) ? textRaw : null);
    if (maybeUrl) {
      try {
        await safeDb.ensureUserRow(ctx.from).catch(()=>null);
        const t = await safeDb.findOrCreateThread(maybeUrl, null);
        if (!t || !t.id) {
          return ctx.reply('Thread created (fallback). Try listening again with the same link.', mainKeyboard());
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

    // handle search input (short code)
    const pAfter = PendingMap.get(uid);
    if (pAfter && pAfter.type === 'search_prompt') {
      PendingMap.delete(uid);
      const code = textRaw.trim();
      return handleSearchByCode(ctx, code);
    }

    // default
    return ctx.reply(`Hi ${ctx.from.first_name || ''}! I didn't detect a supported link. Press a button or send a TikTok/YouTube URL.`, mainKeyboard());
  });

  // voice handler (reply voice / add comment / report reply voice)
  bot.on('voice', async (ctx) => {
    const uid = ctx.from.id;
    const p = PendingMap.get(uid);

    // report for a reply using voice
    if (p && p.type === 'report_reply_voice' && p.replyId) {
      PendingMap.delete(uid);
      try {
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found to submit for report.');
        if (safeDb.supabase) {
          try {
            await safeDb.supabase.from('reports').insert([{ reporter_telegram_id: uid, reporter_username: ctx.from.username || null, reply_id: p.replyId, report_telegram_file_id: voice.file_id, created_at: new Date().toISOString() }]);
          } catch (e) { /* ignore */ }
        }
        for (const adm of ADMIN_IDS) {
          try {
            await bot.telegram.sendVoice(Number(adm), voice.file_id, { caption: `🚨 Voice report for reply #${p.replyId}\nReporter: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || uid}` });
          } catch (e) { console.error('notify admin report reply voice err', e); }
        }
        return ctx.reply('Thanks — voice report submitted.');
      } catch (e) {
        console.error('report_reply_voice err', e);
        return ctx.reply('Could not submit voice report.');
      }
    }

    if (!p) return ctx.reply('No pending action for voice. Use the keyboard to choose an action.', mainKeyboard());

    if (p.type === 'reply_voice' || p.type === 'reply_choice') {
      PendingMap.delete(uid);
      try {
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found in message.');
        const insert = await safeDb.insertReplyRow({
          comment_id: p.commentId,
          replier_telegram_id: ctx.from.id,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          telegram_file_id: voice.file_id
        });
        if (insert && insert.error) throw insert.error;
        await ctx.replyWithVoice(voice.file_id, { caption: `↳ Reply by ${ctx.from.first_name || ctx.from.username}` });

        // notify owner
        try {
          const comment = await safeDb.getCommentById(p.commentId);
          if (comment && comment.telegram_id && comment.telegram_id !== ctx.from.id) {
            const short = utils.encodeShortCode(p.commentId);
            const threadRow = await safeDb.getThreadById(comment.thread_id);
            const videoLink = threadRow ? threadRow.social_link : '(video unknown)';
            const text = `${ctx.from.first_name || ctx.from.username} replied to your comment.\n${short}\nVideo: ${videoLink}`;
            await safeDb.addNotificationRow({ telegram_id: comment.telegram_id, type: 'reply', message: text, meta: { comment_id: p.commentId } }).catch(()=>null);
            try { await bot.telegram.sendMessage(comment.telegram_id, text); } catch (_) {}
          }
        } catch (e) { console.error('notify owner reply voice err', e); }

        return;
      } catch (e) {
        console.error('reply_voice handler error', e);
        return ctx.reply('Could not save voice reply.');
      }
    }

    // add comment voice
    if (p.type === 'add_comment' && p.threadId) {
      PendingMap.delete(uid);

      // NEW: enforce balance check
      try {
        const balance = await getUserBalance(ctx.from.id).catch(()=>0);
        if (Number(balance) <= 0) {
          return ctx.reply('Insufficient credits. Please buy a package first (🛒 Buy). Your comment was not saved.');
        }
      } catch (e) {
        console.error('balance check err before add_comment', e);
        return ctx.reply('Could not verify your balance. Try again later or contact support.');
      }

      try {
        const voice = ctx.message.voice;
        if (!voice) return ctx.reply('No voice found.');
        const insert = await safeDb.insertVoiceComment({
          thread_id: p.threadId,
          telegram_id: ctx.from.id,
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

        // decrement user's free_comments now (use safeDb.decrementUserBalance)
        try {
          const dec = await decrementUserBalance(ctx.from.id, 1).catch(err => ({ error: err && err.message }));
          if (dec && dec.error) {
            console.error('decrementUserBalance reported error', dec);
            try { await ctx.reply('Note: could not decrement your balance (admin will review).'); } catch (_) {}
          }
        } catch (e) {
          console.error('decrementUserBalance error', e);
        }

        try {
          const threadRow = await safeDb.getThreadById(p.threadId);
          if (threadRow && threadRow.creator_telegram_id && threadRow.creator_telegram_id !== ctx.from.id) {
            const notif = `🔔 New voice comment on your tracked video by ${ctx.from.first_name || ctx.from.username}\nVideo: ${threadRow.social_link}\nCode: ${code}`;
            await safeDb.addNotificationRow({ telegram_id: threadRow.creator_telegram_id, type: 'reply', message: notif, meta: { thread_id: p.threadId, comment_id: savedId } }).catch(()=>null);
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

  // photo handler (proof or reply photo)
  bot.on('photo', async (ctx) => {
    const uid = ctx.from.id;
    const p = PendingMap.get(uid);
    if (!p) return ctx.reply('Photo received but no pending action. Use the keyboard or commands.');

    // photo report for a reply (if pending)
    if (p && p.type === 'report_reply_photo' && p.replyId) {
      PendingMap.delete(uid);
      try {
        const photos = ctx.message.photo || [];
        const largest = photos[photos.length - 1];
        const fileId = largest && largest.file_id;
        if (safeDb.supabase) {
          try {
            await safeDb.supabase.from('reports').insert([{ reporter_telegram_id: uid, reporter_username: ctx.from.username || null, reply_id: p.replyId, report_telegram_file_id: fileId, created_at: new Date().toISOString() }]);
          } catch (e) { /* ignore */ }
        }
        for (const adm of ADMIN_IDS) {
          try {
            await bot.telegram.sendPhoto(Number(adm), fileId, { caption: `🚨 Photo report for reply #${p.replyId}\nReporter: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || uid}` });
          } catch (e) { console.error('notify admin report reply photo err', e); }
        }
        return ctx.reply('Thanks — photo report submitted.');
      } catch (e) {
        console.error('report_reply_photo err', e);
        return ctx.reply('Could not submit photo report.');
      }
    }

    if (p.type === 'upload_payproof' && p.paymentId) {
      PendingMap.delete(uid);
      try {
        const photos = ctx.message.photo || [];
        const largest = photos[photos.length - 1];
        const fileId = largest && largest.file_id;
        const upd = await safeDb.updatePaymentStatus(p.paymentId, 'proof_submitted', { proof_telegram_file_id: fileId });
        if (upd && upd.error) throw upd.error;
        await ctx.reply(`Proof received for payment #${p.paymentId}. Admins will review.`);

        for (const adm of ADMIN_IDS) {
          try {
            const inline = Markup.inlineKeyboard([
              [Markup.button.callback('Approve', `admin_approve|${p.paymentId}`), Markup.button.callback('Reject', `admin_reject|${p.paymentId}`)]
            ]);
            await bot.telegram.sendPhoto(Number(adm), fileId, { caption: `Payment proof for request #${p.paymentId} by ${ctx.from.id}`, reply_markup: inline.reply_markup });
          } catch (e) { console.error('notify admin photo err', e); }
        }
        return;
      } catch (e) {
        console.error('upload_payproof photo handler error', e);
        return ctx.reply('Could not submit proof.');
      }
    }

    if (p.type === 'reply_photo' && p.commentId) {
      PendingMap.delete(uid);
      try {
        const photos = ctx.message.photo || [];
        const last = photos[photos.length - 1];
        const fileId = last.file_id;
        const insert = await safeDb.insertReplyRow({
          comment_id: p.commentId,
          replier_telegram_id: ctx.from.id,
          replier_username: ctx.from.username || null,
          replier_first_name: ctx.from.first_name || null,
          reply_photo_url: null,
          telegram_file_id: fileId
        });
        if (insert && insert.error) throw insert.error;
        await ctx.replyWithPhoto(fileId, { caption: `↳ Photo reply by ${ctx.from.first_name || ctx.from.username}` });
        return;
      } catch (e) {
        console.error('reply_photo save error', e);
        return ctx.reply('Could not save photo reply.');
      }
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
      // listen command (pagination)
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

      if (cmd === 'react') {
        const commentId = Number(parts[1]);
        const rType = parts[2];
        try {
          const inserted = await safeDb.insertReactionRow({ comment_id: commentId, telegram_id: ctx.from.id, type: rType });
          if (inserted && inserted.error) throw inserted.error;
          try {
            const msg = ctx.callbackQuery.message;
            if (msg && msg.chat && msg.message_id) {
              const inline = await buildActionsInline(commentId, ctx.from.id);
              await ctx.telegram.editMessageReplyMarkup(msg.chat.id, msg.message_id, null, inline.reply_markup);
            }
          } catch (e) {}
          await ctx.answerCbQuery('Reaction registered');
        } catch (e) {
          console.error('react handler err', e);
          await ctx.answerCbQuery('Could not record reaction');
        }
        return;
      }

      if (cmd === 'fav') {
        const commentId = Number(parts[1]);
        try {
          const result = await safeDb.toggleFavoriteRow(ctx.from.id, commentId);
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
        return ctx.reply('Reply options:\n• Send voice to add voice reply\n• Send text to add text reply\n• Send photo to add photo reply\n(Your next message will be used)');
      }

      if (cmd === 'replytext') {
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

      if (cmd === 'replyphoto') {
        const commentId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'reply_photo', commentId });
        await ctx.answerCbQuery('Send photo reply now');
        return ctx.reply('📷 Send a photo to reply with an image.');
      }

      if (cmd === 'report') {
        const commentId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'report_reason', commentId });
        await ctx.answerCbQuery();
        return ctx.reply('Please explain why you report this comment. Send a short message describing the issue.');
      }

      if (cmd === 'report_reply_text') {
        const replyId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'report_reply_text', replyId });
        await ctx.answerCbQuery();
        return ctx.reply('Please send a short text describing why you report this reply.');
      }
      if (cmd === 'report_reply_voice') {
        const replyId = Number(parts[1]);
        PendingMap.set(ctx.from.id, { type: 'report_reply_voice', replyId });
        await ctx.answerCbQuery();
        return ctx.reply('Send your voice describing the report now (or send a photo).');
      }

      if (cmd === 'admin_delete_comment') {
        const commentId = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        try {
          if (safeDb.supabase) {
            const { error } = await safeDb.supabase.from('voice_comments').delete().eq('id', commentId);
            if (error) throw error;
          } else {
            try { /* mem fallback delete */ state && null; } catch (_) {}
          }
          await ctx.answerCbQuery('Comment deleted');
          return ctx.reply(`Comment #${commentId} deleted by admin.`);
        } catch (e) {
          console.error('admin_delete_comment err', e);
          await ctx.answerCbQuery('Could not delete comment');
          return;
        }
      }

      if (cmd === 'admin_ignore_report') {
        const commentId = Number(parts[1]);
        if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only');
        await ctx.answerCbQuery('Ignored report');
        return;
      }

      if (cmd === 'delete_comment') {
        const commentId = Number(parts[1]);
        try {
          if (safeDb.supabase) {
            const { error } = await safeDb.supabase.from('voice_comments').delete().eq('id', commentId);
            if (error) throw error;
          } else {
            try { /* mem fallback */ } catch (_) {}
          }
          await ctx.answerCbQuery('Deleted');
          return ctx.reply('Comment deleted.');
        } catch (e) {
          console.error('delete_comment err', e);
          await ctx.answerCbQuery('Not found or could not delete.');
          return;
        }
      }

      if (cmd === 'delete_thread') {
        const threadId = Number(parts[1]);
        try {
          if (safeDb.supabase) {
            const { error } = await safeDb.supabase.from('threads').delete().eq('id', threadId);
            if (error) throw error;
          }
          await ctx.answerCbQuery('Tracked video deleted');
          return ctx.reply('Tracked video removed.');
        } catch (e) {
          console.error('delete_thread err', e);
          await ctx.answerCbQuery('Could not delete tracked video.');
          return;
        }
      }

      if (cmd === 'buypkg') {
        const idx = Number(parts[1]);
        const pkg = PAYMENT_PACKAGES[idx];
        if (!pkg) { await ctx.answerCbQuery('Invalid package'); return; }

        try { await ctx.answerCbQuery(); } catch (_) {}

        try {
          PendingMap.set(ctx.from.id, { type: 'buy_confirm', pkg });
          return await createPaymentRequestFlow(ctx, pkg);
        } catch (e) {
          console.error('buypkg handler err', e);
          await ctx.answerCbQuery('Error starting purchase');
          return;
        }
      }

      if (cmd === 'contact_whatsapp') {
        await ctx.answerCbQuery();
        return ctx.reply(`Contact admin: ${WHATSAPP_LINK}`);
      }

      if (cmd === 'copy_tel') {
        const number = parts[1] || '0962058608';
        await ctx.answerCbQuery('Number sent to chat');
        try {
          await bot.telegram.sendMessage(ctx.from.id, `${number}`);
        } catch (e) { console.error('copy_tel send err', e); }
        return;
      }
      if (cmd === 'copy_acc') {
        const number = parts[1] || '1000555367884';
        await ctx.answerCbQuery('Account sent to chat');
        try {
          await bot.telegram.sendMessage(ctx.from.id, `${number}`);
        } catch (e) { console.error('copy_acc send err', e); }
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
          const payment = await safeDb.getPaymentById(paymentId);
          if (!payment) { await ctx.answerCbQuery('Not found'); return; }
          if (payment.status === 'approved') { await ctx.answerCbQuery('Already approved'); return; }
          const up = await safeDb.updatePaymentStatus(paymentId, 'approved');
          if (up && up.error) throw up.error;

          const credits = Number(payment.comments_amount || 0) || 0;
          try {
            await safeDb.creditUser(payment.telegram_id, credits);
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
          const payment = await safeDb.getPaymentById(paymentId);
          if (!payment) { await ctx.answerCbQuery('Not found'); return; }
          const up = await safeDb.updatePaymentStatus(paymentId, 'rejected');
          if (up && up.error) throw up.error;
          await ctx.answerCbQuery('Payment rejected');
          try { await bot.telegram.sendMessage(payment.telegram_id, `Your payment #${paymentId} was rejected. Contact admin.`); } catch (_) {}
          return;
        } catch (e) {
          console.error('admin_reject err', e);
          await ctx.answerCbQuery('Error rejecting payment');
          return;
        }
      }

      await ctx.answerCbQuery();
    } catch (e) {
      console.error('callback_query top error', e);
      try { await ctx.answerCbQuery('Error handling button'); } catch (_) {}
    }
  });

  // sendCommentsPage (uses safeDb.listCommentsByThread)
  async function sendCommentsPage(ctx, threadId, offset = 0, limit = 15) {
    try {
      const res = await safeDb.listCommentsByThread(threadId, offset, limit).catch(()=>({ data: [] }));
      const data = (res && res.data) ? res.data : (Array.isArray(res) ? res : []);
      if (!data || data.length === 0) return ctx.reply('No comments yet for this video.');
      for (const c of data) {
        try {
          if (c.telegram_file_id) {
            await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'User'} • ${new Date(c.created_at).toLocaleString()}` });
          } else {
            await ctx.reply(`Comment by ${c.first_name || c.username || 'User'}`);
          }
          const inline = await buildActionsInline(c.id, ctx.from.id);
          await ctx.reply(utils.encodeShortCode(c.id), inline);
          const thr = await safeDb.getThreadById(c.thread_id).catch(()=>null);
          if (thr) await ctx.reply(`Video: ${thr.social_link || thr.canonical_link || '(unknown)'}`);
        } catch (e) { console.error('sendCommentsPage per comment err', e); }
      }
      if ((data || []).length === limit) {
        const next = Math.floor(offset/limit) + 2;
        await ctx.reply(`Page ${Math.floor(offset/limit) + 1}`, Markup.inlineKeyboard([
          [Markup.button.callback('More', `listen|${threadId}|${next}`)]
        ]));
      }
      return;
    } catch (e) {
      console.error('sendCommentsPage error', e);
      return ctx.reply('Error while fetching comments.');
    }
  }

  async function handleSearchByCode(ctx, code) {
    try {
      const id = utils.decodeShortCode((code || '').toUpperCase());
      if (!id) return ctx.reply('Invalid code.');
      const comment = await safeDb.getCommentById(id);
      if (!comment) return ctx.reply('No voice found for that code.');
      if (comment.telegram_file_id) {
        try { await ctx.replyWithVoice(comment.telegram_file_id, { caption: `${comment.first_name || comment.username || 'User'} • ${new Date(comment.created_at).toLocaleString()}` }); } catch (e) {}
      } else {
        await ctx.reply('Comment found but no voice stored.');
      }
      const inline = await buildActionsInline(comment.id, ctx.from.id);
      const thread = await safeDb.getThreadById(comment.thread_id);
      const videoLink = thread ? thread.social_link : '(video unknown)';
      await ctx.reply(`Stats: (reactions shown on buttons)\nVideo: ${videoLink}`, inline);
    } catch (e) { console.error('handleSearchByCode error', e); await ctx.reply('Search failed.'); }
  }

  async function handleMyComments(ctx) {
    try {
      const rows = await safeDb.listCommentsByUser(ctx.from.id);
      if (!rows || rows.length === 0) return ctx.reply('You have no comments yet.');
      for (const c of rows) {
        if (c.telegram_file_id) await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || 'You'} • ${new Date(c.created_at).toLocaleString()}` });
        else await ctx.reply('Comment: (no voice saved)');
        const inline = await buildActionsInline(c.id, ctx.from.id);
        await ctx.reply(utils.encodeShortCode(c.id), inline);
        const thr = await safeDb.getThreadById(c.thread_id).catch(()=>null);
        if (thr) await ctx.reply(`Video: ${thr.social_link || thr.canonical_link || '(unknown)'}`);
      }
      await ctx.reply('End of your comments.', mainKeyboard());
    } catch (e) { console.error('/my comments error', e); await ctx.reply('Could not fetch your comments.'); }
  }

  bot.command('my', handleMyComments);

  // Expose bot
  return bot;
}

module.exports = { initBot };
