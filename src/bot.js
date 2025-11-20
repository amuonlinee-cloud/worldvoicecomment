// path: src/bot.js
// Complete corrected bot implementation (CommonJS).
// - Exports: initBot() and handleUpdate(update)
// - Safe to require() even when env vars are missing (defensive requires)
// - Supports polling (LOCAL_POLLING) and webhook modes
// - Implements: users, threads, voice_comments, replies (with reports), favorites, reactions,
//   payment request flow (create + proof), admin notifications, reply reporting with admin actions.
// - Uses db methods from ./database and helpers from ./utils if available; falls back gracefully.

const debugLog = (...args) => console.log('[bot]', ...args);

// Defensive requires so module can be required on Vercel even if envs missing
let Telegraf, Markup;
try {
  ({ Telegraf, Markup } = require('telegraf'));
} catch (e) {
  debugLog('telegraf not available at require time:', e && e.message);
  // Provide minimal shims so code referencing these doesn't crash on require.
  Telegraf = null;
  Markup = {
    inlineKeyboard: (...r) => ({ reply_markup: { inline_keyboard: r[0] || [] } }),
    button: {
      callback: (t, d) => ({ text: t, callback_data: d }),
      url: (t, u) => ({ text: t, url: u }),
      switchToCurrentChat: (t, q) => ({ text: t, switch_inline_query_current_chat: q })
    }
  };
}

let db = null;
try {
  db = require('./database');
} catch (e) {
  debugLog('Warning: ./database require failed:', e && e.message);
  // minimal fallback DB surface to avoid throws during require
  db = {
    initSupabase: () => { throw new Error('SUPABASE_NOT_CONFIGURED'); },
    setAdminNotifier: () => {},
    ensureUser: async () => ({}),
    findOrCreateThread: async () => ({}),
    addVoiceComment: async () => ({}),
    listCommentsForThread: async () => [],
    addReply: async () => ({}),
    listRepliesForComment: async () => [],
    toggleFavorite: async () => ({}),
    listFavoritesForUser: async () => [],
    addReaction: async () => ({}),
    createPaymentRequest: async () => ({}),
    attachPaymentProof: async () => ({}),
    reportReply: async () => ({}),
    getReplyById: async () => null,
    getCommentById: async () => null,
    deleteReplyById: async () => true,
    setReportStatus: async () => ({}),
    listTopComments: async () => [],
  };
}

let utils = null;
try {
  utils = require('./utils');
} catch (e) {
  debugLog('Warning: ./utils require failed:', e && e.message);
  utils = {
    normalizeInput: (s) => (s || '').toString().trim(),
    extractFirstUrl: (s) => {
      if (!s) return null;
      const m = s.match(/https?:\/\/[^\s]+/i);
      return m ? m[0] : null;
    },
    isSupportedLink: (u) => {
      if (!u) return false;
      const x = u.toLowerCase();
      return x.includes('youtu') || x.includes('tiktok.com') || x.includes('vm.tiktok.com');
    },
    normalizeVideoUrl: (u) => u,
    encodeShortcodeForComment: (id) => (id ? `vc${Number(id).toString(36)}` : null),
    decodeShortcodeToCommentId: (code) => {
      if (!code || !code.startsWith('vc')) return null;
      return parseInt(code.slice(2), 36);
    }
  };
}

// Environment and configuration
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(s => Number(s));
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const LOCAL_POLLING = process.env.LOCAL_POLLING === '1' || process.env.LOCAL_POLLING === 'true';
const CBE_NUMBER = process.env.CBE_NUMBER || process.env.PAYMENT_CBE || '';
const TELEBIRR_NUMBER = process.env.TELEBIRR_NUMBER || process.env.PAYMENT_TELEBIRR || '';
const WHATSAPP_ADMIN = process.env.WHATSAPP_ADMIN || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || process.env.WEBHOOK_TOKEN || '';
const NODE_ENV = process.env.NODE_ENV || 'production';

// In-memory ephemeral pending flows (acceptable for simple bot)
const pendingVoiceForThread = new Map(); // telegramId -> { thread_id }
const pendingReplyForComment = new Map(); // telegramId -> { comment_id }
const pendingPaymentRequest = new Map(); // telegramId -> { payment_request_id }
const pendingReportReason = new Map(); // telegramId -> { reply_id }

// Internal variables
let botInstance = null;
let initialized = false;

/** createBotInstance(): construct or return existing bot */
function createBotInstance() {
  if (botInstance) return botInstance;

  if (!Telegraf || !BOT_TOKEN) {
    debugLog('Telegraf missing or TELEGRAM_BOT_TOKEN not set. Creating dummy handler.');
    // create dummy object with handleUpdate and telegram.getMe minimal
    botInstance = {
      telegram: {
        getMe: async () => ({ id: 0, username: 'bot_stub' }),
        sendMessage: async () => { debugLog('[bot-stub] sendMessage called'); }
      },
      handleUpdate: async (update) => {
        debugLog('[bot-stub] handleUpdate called. update keys:', Object.keys(update || {}).slice(0, 10));
      },
      launch: async () => { debugLog('[bot-stub] launch called'); },
      stop: async () => { debugLog('[bot-stub] stop called'); }
    };
    return botInstance;
  }

  try {
    botInstance = new Telegraf(BOT_TOKEN);
    debugLog('Created Telegraf instance');
  } catch (e) {
    debugLog('Failed to create Telegraf instance, falling back to stub:', e && e.message);
    botInstance = {
      telegram: { getMe: async () => ({ id: 0, username: 'bot_stub' }) },
      handleUpdate: async (u) => debugLog('[bot-stub] handleUpdate', Object.keys(u || {})),
      launch: async () => {},
      stop: async () => {}
    };
  }
  return botInstance;
}

/** notifyAdmins helper: tries DB notifier then telegram messages */
async function notifyAdminsViaBot(message, opts = {}) {
  // try db.notifyAdmins if present
  try {
    if (db && typeof db.notifyAdmins === 'function') {
      await db.notifyAdmins(message, opts.meta || {});
    }
  } catch (e) {
    debugLog('db.notifyAdmins failed:', e && e.message);
  }

  // also attempt to DM admins via bot if possible
  try {
    const bot = createBotInstance();
    if (!bot || !bot.telegram) return;
    for (const id of ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(id, `[Admin] ${message}`);
      } catch (e) {
        debugLog('Failed to notify admin via telegram:', id, e && e.message);
      }
    }
  } catch (e) {
    debugLog('notifyAdminsViaBot failure:', e && e.message);
  }
}

/** registerHandlers(bot) : attach telegraf handlers */
function registerHandlers(bot) {
  // Use direct handlers only if real Telegraf exists
  if (!bot || typeof bot.on !== 'function') {
    debugLog('Bot instance does not support telegraf handlers (stub). Skipping registration.');
    return;
  }

  // Set db admin notifier if available
  if (db && typeof db.setAdminNotifier === 'function') {
    db.setAdminNotifier(async (msg) => {
      await notifyAdminsViaBot(msg);
    });
  }

  // /start
  bot.start(async (ctx) => {
    try {
      const user = ctx.from || {};
      await (db.ensureUser ? db.ensureUser(user) : Promise.resolve());
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add voice comment', 'start_add_voice_hint'), Markup.button.callback('🎧 Listen comments (paste link)', 'start_listen_hint')],
        [Markup.button.callback('💳 Buy', 'open_buy_menu'), Markup.button.callback('🛠️ Support', 'support')],
        [Markup.button.callback('🏆 Top Voices', 'show_top_voices')]
      ]);
      await ctx.reply(`Welcome ${user.first_name || user.username || 'friend'}! Send a YouTube or TikTok link and I'll track it. Use /help for commands.`, kb);
    } catch (err) {
      debugLog('/start handler error', err && err.message);
      await notifyAdminsViaBot(`[BOT ERROR] /start failed: ${err && err.message}`);
    }
  });

  // /help
  bot.command('help', async (ctx) => {
    await ctx.reply(
`Commands:
/start - register and welcome
/help - this message
/myfavorites - list your favorites
/mycomments - list your posted comments
/buy - buy comments package
/topvoices - show popular voice comments

Flow:
• Paste a YouTube/TikTok link -> press Add voice comment or Listen comments.
• Add voice comment -> send a voice message or audio file.
• Buy -> pick package -> choose payment method -> press Send proof -> upload a screenshot/photo.`
    );
  });

  // /myfavorites
  bot.command('myfavorites', async (ctx) => {
    try {
      const items = await (db.listFavoritesForUser ? db.listFavoritesForUser(ctx.from.id) : []);
      if (!items || items.length === 0) return ctx.reply('You have no favorites yet.');
      const lines = items.map(i => `• comment ${i.comment_id} — saved at ${new Date(i.created_at).toLocaleString()}`);
      await ctx.reply(lines.join('\n'));
    } catch (e) {
      debugLog('/myfavorites error', e && e.message);
      await ctx.reply('Failed to fetch favorites.');
    }
  });

  // /mycomments
  bot.command('mycomments', async (ctx) => {
    try {
      const sup = (db.initSupabase && db.initSupabase()) || null;
      if (!sup || !sup.from) {
        return ctx.reply('DB not configured.');
      }
      const { data } = await sup.from('voice_comments').select('*').eq('telegram_id', ctx.from.id).order('created_at', { ascending: false }).limit(50);
      if (!data || data.length === 0) return ctx.reply('You have not posted comments yet.');
      for (const c of data) {
        try {
          await ctx.replyWithVoice(c.telegram_file_id, { caption: `ID: ${c.id} | Posted: ${new Date(c.created_at).toLocaleString()}` });
        } catch (e) {
          await ctx.reply(`ID: ${c.id} | file not available`);
        }
      }
    } catch (e) {
      debugLog('/mycomments error', e && e.message);
      await ctx.reply('Failed to fetch your comments.');
    }
  });

  // /topvoices
  bot.command('topvoices', async (ctx) => {
    try {
      const top = await (db.listTopComments ? db.listTopComments(10) : []);
      if (!top || top.length === 0) return ctx.reply('No voice comments yet.');
      for (const c of top) {
        try {
          await ctx.replyWithVoice(c.telegram_file_id, { caption: `ID:${c.id} | Fav:${c.favorites_count || 0} | React:${c.reactions_count || 0}` });
        } catch (e) {
          await ctx.reply(`ID:${c.id} | [voice unavailable]`);
        }
      }
    } catch (e) {
      debugLog('/topvoices error', e && e.message);
      await ctx.reply('Failed to fetch top voices.');
    }
  });

  // Heuristics: react to messages containing links
  bot.hears(/https?:\/\//i, async (ctx) => {
    try {
      const text = ctx.message && (ctx.message.text || ctx.message.caption || '');
      const url = utils.extractFirstUrl ? utils.extractFirstUrl(text) : null;
      if (!url || !(utils.isSupportedLink ? utils.isSupportedLink(url) : url)) {
        return ctx.reply('I only support YouTube and TikTok links for now. Paste a supported link.');
      }
      const normalized = (utils.normalizeVideoUrl ? utils.normalizeVideoUrl(url) : url);
      const thread = await (db.findOrCreateThread ? db.findOrCreateThread(url, ctx.from && ctx.from.id, normalized) : { id: null, social_link: url });
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add voice comment', `add_voice:${thread.id}`), Markup.button.callback('🎧 Listen comments', `listen:${thread.id}:0`)],
        [Markup.button.callback('💳 Buy', 'open_buy_menu'), Markup.button.callback('🛠️ Support', 'support')],
        [Markup.button.url('🔗 Open source link', thread.social_link)]
      ]);
      await ctx.reply(`Thread tracked: ${thread.social_link}`, kb);
    } catch (e) {
      debugLog('link handler error', e && e.message);
      await ctx.reply('Failed to process link. Try again later.');
      await notifyAdminsViaBot(`[BOT ERROR] link handling failed: ${e && e.message}`);
    }
  });

  // Inline action handlers

  bot.action('start_add_voice_hint', async (ctx) => {
    await ctx.answerCbQuery('Paste a supported link first, then press Add voice comment for that thread.');
  });

  bot.action('start_listen_hint', async (ctx) => {
    await ctx.answerCbQuery('Paste a supported link then use Listen comments to browse that thread.');
  });

  // Add voice flow start
  bot.action(/add_voice:(\d+)/, async (ctx) => {
    try {
      const thread_id = Number(ctx.match[1]);
      if (!thread_id) return ctx.answerCbQuery('Invalid thread id');
      pendingVoiceForThread.set(ctx.from.id, { thread_id });
      await ctx.answerCbQuery('Please send a voice note or audio file now.');
      await ctx.reply('Send your voice message for this thread now (voice message or audio file).');
    } catch (e) {
      debugLog('add_voice action error', e && e.message);
      await ctx.answerCbQuery('Failed to start add voice flow.');
    }
  });

  // Listen comments paginated
  bot.action(/listen:(\d+):(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const thread_id = Number(ctx.match[1]);
      const offset = Number(ctx.match[2] || 0);
      const comments = await (db.listCommentsForThread ? db.listCommentsForThread(thread_id, 15, offset) : []);
      if (!comments || comments.length === 0) {
        return ctx.reply('No comments yet for this thread.');
      }
      for (const comment of comments) {
        const caption = `By: ${comment.first_name || comment.username || comment.telegram_id}\nPosted: ${new Date(comment.created_at).toLocaleString()}\nID: ${comment.id}`;
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback('↩ Reply', `reply:${comment.id}`), Markup.button.callback('⭐ Favorite', `fav:${comment.id}`)],
          [Markup.button.callback('😊 React', `react_menu:${comment.id}`), Markup.button.callback('🔗 Share', `share:${comment.id}`)]
        ]);
        try {
          await ctx.replyWithVoice(comment.telegram_file_id, { caption, reply_markup: keyboard.reply_markup });
        } catch (e) {
          await ctx.reply(`${caption}\n[voice unavailable]`, keyboard);
        }

        // show recent replies for this comment (if any)
        const replies = await (db.listRepliesForComment ? db.listRepliesForComment(comment.id) : []);
        if (replies && replies.length) {
          for (const r of replies.slice(-10)) {
            const rCaption = `Reply by ${r.replier_first_name || r.replier_username || r.replier_telegram_id}\n${r.reply_text ? `${r.reply_text}\n` : ''}ID: ${r.id}`;
            const rKb = Markup.inlineKeyboard([
              [Markup.button.callback('🚨 Report', `report_reply:${r.id}`)]
            ]);
            try {
              if (r.telegram_file_id) {
                await ctx.replyWithVoice(r.telegram_file_id, { caption: rCaption, reply_markup: rKb.reply_markup });
              } else {
                await ctx.reply(`${rCaption}\n[no voice file]`, rKb);
              }
            } catch (e) {
              await ctx.reply(`${rCaption}\n[reply unavailable]`, rKb);
            }
          }
        }
      }

      const moreKb = Markup.inlineKeyboard([[Markup.button.callback('More ➕', `listen:${thread_id}:${offset + comments.length}`)]]);
      await ctx.reply('--- Page end ---', moreKb);
    } catch (e) {
      debugLog('listen action error', e && e.message);
      await ctx.answerCbQuery('Failed to fetch comments.');
    }
  });

  // Reply to comment
  bot.action(/reply:(\d+)/, async (ctx) => {
    try {
      const comment_id = Number(ctx.match[1]);
      pendingReplyForComment.set(ctx.from.id, { comment_id });
      await ctx.answerCbQuery('You can reply with text or voice now.');
      await ctx.reply('Send your reply (text or voice).');
    } catch (e) {
      debugLog('reply action error', e && e.message);
      await ctx.answerCbQuery('Failed to start reply flow.');
    }
  });

  // Favorite toggle
  bot.action(/fav:(\d+)/, async (ctx) => {
    try {
      const comment_id = Number(ctx.match[1]);
      const result = await (db.toggleFavorite ? db.toggleFavorite(comment_id, ctx.from.id) : {});
      if (result.added) {
        await ctx.answerCbQuery('Added to favorites');
        await ctx.reply('✅ Added to favorites.');
      } else if (result.removed) {
        await ctx.answerCbQuery('Removed from favorites');
        await ctx.reply('❌ Removed from favorites.');
      } else {
        await ctx.answerCbQuery('Toggled favorite');
      }
    } catch (e) {
      debugLog('fav action error', e && e.message);
      await ctx.answerCbQuery('Failed to toggle favorite');
    }
  });

  // Reaction menu and action
  bot.action(/react_menu:(\d+)/, async (ctx) => {
    try {
      const comment_id = Number(ctx.match[1]);
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback('👍', `react:${comment_id}:👍`), Markup.button.callback('❤️', `react:${comment_id}:❤️`), Markup.button.callback('😂', `react:${comment_id}:😂`)]
      ]);
      await ctx.reply('Choose reaction:', kb);
      await ctx.answerCbQuery();
    } catch (e) {
      debugLog('react_menu error', e && e.message);
      await ctx.answerCbQuery('Failed to open reaction menu');
    }
  });

  bot.action(/react:(\d+):(.+)/, async (ctx) => {
    try {
      const comment_id = Number(ctx.match[1]);
      const emoji = ctx.match[2];
      await (db.addReaction ? db.addReaction(comment_id, ctx.from.id, emoji) : null);
      await ctx.answerCbQuery('Reaction recorded');
    } catch (e) {
      debugLog('react action error', e && e.message);
      await ctx.answerCbQuery('Failed to record reaction');
    }
  });

  // Share shortcode
  bot.action(/share:(\d+)/, async (ctx) => {
    try {
      const comment_id = Number(ctx.match[1]);
      const shortcode = (utils.encodeShortcodeForComment ? utils.encodeShortcodeForComment(comment_id) : `vc${comment_id}`);
      await ctx.answerCbQuery();
      await ctx.reply(`Shareable code: ${shortcode}`);
    } catch (e) {
      debugLog('share action error', e && e.message);
      await ctx.answerCbQuery('Failed to create share code');
    }
  });

  // BUY flow — open menu
  bot.action('open_buy_menu', async (ctx) => {
    try {
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback('Small - 10 - $2.99', 'buy_package:small'), Markup.button.callback('Medium - 50 - $9.99', 'buy_package:medium')],
        [Markup.button.callback('Large - 200 - $29.99', 'buy_package:large')],
        [Markup.button.callback('Cancel', 'buy_cancel')]
      ]);
      await ctx.reply('Choose a package:', kb);
      await ctx.answerCbQuery();
    } catch (e) {
      debugLog('open_buy_menu error', e && e.message);
      await ctx.answerCbQuery('Failed to open buy menu');
    }
  });

  bot.action('buy_cancel', async (ctx) => {
    await ctx.answerCbQuery('Purchase canceled');
  });

  bot.action(/buy_package:(.+)/, async (ctx) => {
    try {
      const pkg = String(ctx.match[1]);
      const mapping = { small: { amount: 2.99, comments: 10 }, medium: { amount: 9.99, comments: 50 }, large: { amount: 29.99, comments: 200 } };
      const chosen = mapping[pkg] || { amount: 0, comments: 0 };
      const created = await (db.createPaymentRequest ? db.createPaymentRequest({ telegram_id: ctx.from.id, package_name: pkg, comments_amount: chosen.comments, amount: chosen.amount, method: 'manual' }) : { id: 0 });
      pendingPaymentRequest.set(ctx.from.id, { payment_request_id: created.id });

      const txt = [
        `Payment request created (#${created.id})`,
        `Package: ${pkg} — ${chosen.comments} comments`,
        `Amount: $${chosen.amount}`,
        '',
        'Choose a payment method and use the buttons to get account details quickly. After paying, press Send proof and upload a screenshot/photo of your payment so admins can verify.'
      ].join('\n');

      const kb = Markup.inlineKeyboard([
        [Markup.button.callback('Send CBE number', `send_number:CBE:${created.id}`), Markup.button.switchToCurrentChat('Prefill CBE', CBE_NUMBER || '')],
        [Markup.button.callback('Send Telebirr number', `send_number:TELEBIRR:${created.id}`), Markup.button.switchToCurrentChat('Prefill Telebirr', TELEBIRR_NUMBER || '')],
        [Markup.button.callback('Send proof (upload now)', `send_proof:${created.id}`)]
      ]);
      await ctx.reply(txt, kb);
      await ctx.answerCbQuery();
    } catch (e) {
      debugLog('buy_package error', e && e.message);
      await ctx.answerCbQuery('Failed to create payment request');
    }
  });

  bot.action(/send_number:(CBE|TELEBIRR):(\d+)/, async (ctx) => {
    try {
      const method = ctx.match[1];
      const prId = Number(ctx.match[2]);
      const number = method === 'CBE' ? CBE_NUMBER : TELEBIRR_NUMBER;
      if (!number) {
        await ctx.answerCbQuery('Payment number not set.');
        return;
      }
      await ctx.answerCbQuery(`Sending ${method} number`);
      await ctx.reply(`Use this ${method} number to pay:\n${number}\n\nAfter payment, press "Send proof" and upload a screenshot/photo.`);
      // update payment request method if DB available
      try {
        const sup = db.initSupabase && db.initSupabase();
        if (sup && sup.from) {
          await sup.from('payment_requests').update({ method }).eq('id', prId);
        }
      } catch (e) {
        debugLog('failed to update payment_request method', e && e.message);
      }
    } catch (e) {
      debugLog('send_number action error', e && e.message);
      await ctx.answerCbQuery('Failed to send number');
    }
  });

  bot.action(/send_proof:(\d+)/, async (ctx) => {
    try {
      const prId = Number(ctx.match[1]);
      pendingPaymentRequest.set(ctx.from.id, { payment_request_id: prId });
      await ctx.answerCbQuery('Please upload payment proof (photo/document).');
      await ctx.reply('Please send your payment proof now (photo or document). Do not click anything else — just upload the proof.');
    } catch (e) {
      debugLog('send_proof action error', e && e.message);
      await ctx.answerCbQuery('Failed to start proof flow');
    }
  });

  bot.action('support', async (ctx) => {
    try {
      const lines = [
        'Support & Help:',
        `Admins: ${ADMIN_IDS.join(', ') || 'not configured'}`,
        `WhatsApp: ${WHATSAPP_ADMIN || 'not set'}`,
        '',
        'For payments: choose Buy -> pick a package -> choose a method -> press Send proof and upload a screenshot/photo.'
      ];
      await ctx.reply(lines.join('\n'));
      await ctx.answerCbQuery();
    } catch (e) {
      debugLog('support action error', e && e.message);
      await ctx.answerCbQuery('Failed to open support info');
    }
  });

  // Report reply flow: user presses report then sends reason; admins get notified with voice + actions
  bot.action(/report_reply:(\d+)/, async (ctx) => {
    try {
      const reply_id = Number(ctx.match[1]);
      pendingReportReason.set(ctx.from.id, { reply_id });
      await ctx.answerCbQuery('Please send a short reason for reporting this reply (e.g., spam, abusive).');
      await ctx.reply('Send a short reason for the report (one-line). Example: "spam" or "offensive language".');
    } catch (e) {
      debugLog('report_reply action error', e && e.message);
      await ctx.answerCbQuery('Failed to start report flow');
    }
  });

  // Admin actions: delete reply by id and mark report status, or ignore report
  bot.action(/admin_delete_reply:(\d+):(\d+)/, async (ctx) => {
    try {
      const reply_id = Number(ctx.match[1]);
      const report_id = Number(ctx.match[2]);
      await (db.deleteReplyById ? db.deleteReplyById(reply_id) : null);
      await (db.setReportStatus ? db.setReportStatus(report_id, 'deleted', `deleted by admin ${ctx.from.id}`) : null);
      await ctx.answerCbQuery('Reply deleted and report marked as deleted.');
      await ctx.reply(`Reply ${reply_id} deleted by admin ${ctx.from.id}.`);
    } catch (e) {
      debugLog('admin_delete_reply error', e && e.message);
      await ctx.answerCbQuery('Failed to delete reply.');
    }
  });

  bot.action(/admin_ignore_report:(\d+)/, async (ctx) => {
    try {
      const report_id = Number(ctx.match[1]);
      await (db.setReportStatus ? db.setReportStatus(report_id, 'ignored', `ignored by admin ${ctx.from.id}`) : null);
      await ctx.answerCbQuery('Report ignored.');
      await ctx.reply(`Report ${report_id} ignored by admin ${ctx.from.id}.`);
    } catch (e) {
      debugLog('admin_ignore_report error', e && e.message);
      await ctx.answerCbQuery('Failed to ignore report.');
    }
  });

  // Admin view comment action (send main voice)
  bot.action(/view_comment:(\d+):(\d+)/, async (ctx) => {
    try {
      const comment_id = Number(ctx.match[1]);
      const comment = await (db.getCommentById ? db.getCommentById(comment_id) : null);
      if (!comment) {
        await ctx.answerCbQuery('Comment not found');
        return;
      }
      try {
        await ctx.replyWithVoice(comment.telegram_file_id, { caption: `Main voice ID: ${comment.id}` });
      } catch (e) {
        await ctx.reply(`Main voice ID: ${comment.id} | file unavailable`);
      }
      await ctx.answerCbQuery();
    } catch (e) {
      debugLog('view_comment action error', e && e.message);
      await ctx.answerCbQuery('Failed to show comment');
    }
  });

  // Generic fallback callback to avoid stuck spinner
  bot.on('callback_query', async (ctx) => {
    try {
      await ctx.answerCbQuery();
    } catch (e) {
      // ignore
    }
  });

  // Message handler: handles pending proof uploads, add voice, replies, report reasons
  bot.on(['voice', 'audio', 'document', 'photo', 'message', 'text'], async (ctx) => {
    try {
      const from = ctx.from;

      // Payment proof flow
      if (pendingPaymentRequest.has(from.id) && (ctx.message.photo || ctx.message.document || ctx.message.voice || ctx.message.audio)) {
        const pending = pendingPaymentRequest.get(from.id);
        const paymentRequestId = pending.payment_request_id;
        let proofId = null;
        if (ctx.message.document) proofId = ctx.message.document.file_id;
        else if (ctx.message.photo) proofId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        else if (ctx.message.voice) proofId = ctx.message.voice.file_id;
        else if (ctx.message.audio) proofId = ctx.message.audio.file_id;
        if (proofId) {
          await (db.attachPaymentProof ? db.attachPaymentProof(paymentRequestId, proofId) : null);
          pendingPaymentRequest.delete(from.id);
          await ctx.reply('Payment proof received. Admins will verify your payment. Thank you!');
        } else {
          await ctx.reply('Could not detect a file. Please send a photo or document as proof.');
        }
        return;
      }

      // Add voice comment flow
      if (pendingVoiceForThread.has(from.id) && (ctx.message.voice || ctx.message.audio || ctx.message.document)) {
        const pending = pendingVoiceForThread.get(from.id);
        const thread_id = pending.thread_id;
        let file_id = null;
        let duration = null;
        if (ctx.message.voice) {
          file_id = ctx.message.voice.file_id;
          duration = ctx.message.voice.duration;
        } else if (ctx.message.audio) {
          file_id = ctx.message.audio.file_id;
          duration = ctx.message.audio.duration || null;
        } else if (ctx.message.document) {
          file_id = ctx.message.document.file_id;
        }
        if (!file_id) {
          await ctx.reply('Could not find a file. Please send a voice message or audio file.');
          return;
        }
        const stored = await (db.addVoiceComment ? db.addVoiceComment({
          thread_id,
          telegram_id: from.id,
          username: from.username || null,
          first_name: from.first_name || null,
          telegram_file_id: file_id,
          duration
        }) : { id: null });
        pendingVoiceForThread.delete(from.id);
        const shortcode = (utils.encodeShortcodeForComment ? utils.encodeShortcodeForComment(stored.id) : `vc${stored.id}`);
        await ctx.reply(`Stored voice comment. Shareable code: ${shortcode}`);
        return;
      }

      // Reply flow
      if (pendingReplyForComment.has(from.id)) {
        const pending = pendingReplyForComment.get(from.id);
        const comment_id = pending.comment_id;
        let reply_text = ctx.message.text || null;
        let telegram_file_id = null;
        if (ctx.message.voice) telegram_file_id = ctx.message.voice.file_id;
        else if (ctx.message.audio) telegram_file_id = ctx.message.audio.file_id;
        else if (ctx.message.document) telegram_file_id = ctx.message.document.file_id;
        else if (ctx.message.photo) telegram_file_id = ctx.message.photo[ctx.message.photo.length - 1].file_id;

        await (db.addReply ? db.addReply({
          comment_id,
          replier_telegram_id: from.id,
          replier_username: from.username || null,
          replier_first_name: from.first_name || null,
          reply_text,
          reply_photo_url: null,
          telegram_file_id
        }) : null);

        pendingReplyForComment.delete(from.id);
        await ctx.reply('Reply saved. Thank you!');
        return;
      }

      // Report reason flow
      if (pendingReportReason.has(from.id)) {
        const pending = pendingReportReason.get(from.id);
        const reply_id = pending.reply_id;
        const reason = ctx.message.text ? ctx.message.text.trim() : (ctx.message.caption || '');
        if (!reason || reason.length < 2) {
          await ctx.reply('Please send a short reason (one-line), for example: "spam" or "offensive language".');
          return;
        }
        const report = await (db.reportReply ? db.reportReply({
          reply_id,
          reporter_telegram_id: from.id,
          reporter_username: from.username || null,
          reason
        }) : { id: null });
        pendingReportReason.delete(from.id);
        await ctx.reply('Thank you — your report has been submitted to the admins.');

        // notify admins with context and actions
        try {
          const replyRow = await (db.getReplyById ? db.getReplyById(reply_id) : null);
          const comment = replyRow ? await (db.getCommentById ? db.getCommentById(replyRow.comment_id) : null) : null;
          const caption = [
            `🚨 Report: reply #${reply_id}`,
            `Reporter: ${from.first_name || from.username || from.id} (${from.id})`,
            `Reason: ${reason}`,
            `Report ID: ${report.id || 'N/A'}`,
            comment ? `Main voice ID: ${comment.id}` : 'Main voice: unknown'
          ].join('\n');

          const adminButtons = Markup.inlineKeyboard([
            [Markup.button.callback('🗑️ Delete reply', `admin_delete_reply:${reply_id}:${report.id || 0}`), Markup.button.callback('⛔ Ignore report', `admin_ignore_report:${report.id || 0}`)],
            [Markup.button.callback('🔎 View comment', `view_comment:${comment ? comment.id : 0}:${report.id || 0}`)]
          ]);

          if (replyRow && replyRow.telegram_file_id) {
            for (const adminId of ADMIN_IDS) {
              try {
                await bot.telegram.sendVoice(adminId, replyRow.telegram_file_id, { caption, reply_markup: adminButtons.reply_markup });
              } catch (err) {
                await bot.telegram.sendMessage(adminId, `${caption}\n[Could not deliver voice file]`, { reply_markup: adminButtons.reply_markup });
              }
            }
          } else {
            for (const adminId of ADMIN_IDS) {
              try {
                await bot.telegram.sendMessage(adminId, `${caption}\n[No voice file attached to this reply]`, { reply_markup: adminButtons.reply_markup });
              } catch (e) {
                debugLog('failed to message admin', adminId, e && e.message);
              }
            }
          }
        } catch (err) {
          debugLog('notify admins about report failed', err && err.message);
          await notifyAdminsViaBot(`[REPORT ERROR] notify admins failed for report ${report.id || 'N/A'}: ${err && err.message}`);
        }
        return;
      }

      // default
      if (ctx.message.text && ctx.message.text.startsWith('/')) return;
      await ctx.reply('Send a supported video link (YouTube/TikTok) or use /help for available commands.');
    } catch (e) {
      debugLog('message handler error', e && (e.stack || e.message));
      await notifyAdminsViaBot(`[BOT ERROR] message processing failed: ${e && e.message}`);
      try { await ctx.reply('An error occurred processing your message.'); } catch (ignore) {}
    }
  });

  // global error capture for telegraf
  bot.catch(async (err) => {
    debugLog('Telegraf caught error', err && (err.stack || err.message));
    await notifyAdminsViaBot(`[BOT ERROR] Telegraf exception: ${err && err.message}`);
  });
}

/** initBot() - initializes bot and registers handlers (if real telegraf) */
async function initBot() {
  const bot = createBotInstance();

  // register handlers only once and only if real telegraf is present
  if (!initialized) {
    // register handlers if bot supports .on (Telegraf)
    try {
      registerHandlers(bot);
    } catch (e) {
      debugLog('registerHandlers failed:', e && e.message);
      await notifyAdminsViaBot(`[BOT ERROR] registerHandlers failed: ${e && e.message}`);
    }
    // Launch polling locally if requested (LOCAL_POLLING)
    if (LOCAL_POLLING && bot && typeof bot.launch === 'function') {
      try {
        await bot.launch();
        debugLog('bot launched in polling mode');
      } catch (e) {
        debugLog('bot.launch failed:', e && e.message);
        await notifyAdminsViaBot(`[BOT ERROR] bot.launch failed: ${e && e.message}`);
      }
    } else {
      debugLog('LOCAL_POLLING not enabled; webhook mode expected');
    }
    initialized = true;
  }

  // return object useful for serverless handler
  return {
    bot,
    handleUpdate: async (update) => {
      if (!bot) return;
      if (typeof bot.handleUpdate === 'function') {
        try {
          await bot.handleUpdate(update);
        } catch (e) {
          debugLog('handleUpdate threw:', e && (e.stack || e.message));
          await notifyAdminsViaBot(`[BOT ERROR] handleUpdate threw: ${e && e.message}`);
        }
      } else {
        debugLog('bot has no handleUpdate function');
      }
    }
  };
}

/** handleUpdate(update) - convenience exported function for serverless */
async function handleUpdate(update) {
  const r = await initBot();
  if (r && typeof r.handleUpdate === 'function') return r.handleUpdate(update);
  debugLog('handleUpdate: no handler available after init');
  return;
}

module.exports = { initBot, handleUpdate };
