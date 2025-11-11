// path: src/database.js
// Lazy Supabase client wrapper and DB functions.
// Safe to require even when env vars are missing.

const { createClient } = require('@supabase/supabase-js');

let supabase = null;
let adminNotifier = null; // function (message) => Promise<void>

function initSupabase() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL || null;
  const key = process.env.SUPABASE_KEY || null;
  if (!url || !key) {
    // Return a minimal fake client to avoid crashes; real calls will throw when attempted.
    console.warn('[db] SUPABASE not configured — DB functions will fail until SUPABASE_URL and SUPABASE_KEY are set.');
    supabase = {
      from: () => ({ select: async () => { throw new Error('SUPABASE_NOT_CONFIGURED'); } })
    };
    return supabase;
  }
  supabase = createClient(url, key, { auth: { persistSession: false } });
  return supabase;
}

function setAdminNotifier(fn) {
  adminNotifier = fn;
}

async function notifyAdmins(message, meta = {}) {
  try {
    // Insert into notifications table
    const db = initSupabase();
    if (db && db.from) {
      await db.from('notifications').insert({
        telegram_id: null,
        type: 'admin',
        message: message,
        meta
      });
    }
  } catch (err) {
    console.error('[db] Failed to insert notification:', err?.message || err);
  }

  if (adminNotifier) {
    try {
      await adminNotifier(String(message).slice(0, 4000));
    } catch (err) {
      console.error('[db] adminNotifier failed:', err?.message || err);
    }
  } else {
    console.log('[db] adminNotifier not set; message:', message);
  }
}

// USER helpers
async function ensureUser(telegramUser = {}) {
  const db = initSupabase();
  if (!db || !db.from) throw new Error('SUPABASE_NOT_CONFIGURED');
  const telegram_id = telegramUser.id;
  try {
    const { data: existing } = await db.from('users').select('*').eq('telegram_id', telegram_id).limit(1);
    if (existing && existing.length) {
      // update username/first_name if changed
      const user = existing[0];
      if (user.username !== (telegramUser.username || null) || user.first_name !== (telegramUser.first_name || null)) {
        await db.from('users').update({
          username: telegramUser.username || null,
          first_name: telegramUser.first_name || null
        }).eq('telegram_id', telegram_id);
      }
      return user;
    } else {
      const toInsert = {
        telegram_id,
        username: telegramUser.username || null,
        first_name: telegramUser.first_name || null,
        free_comments: 0
      };
      const { data } = await db.from('users').insert(toInsert).select().single();
      return data;
    }
  } catch (err) {
    console.error('[db] ensureUser error:', err?.message || err);
    await notifyAdmins(`[DB ERROR] ensureUser failed: ${err?.message}`, { user: telegramUser });
    throw err;
  }
}

// THREAD helpers
async function findOrCreateThread(social_link, creator_telegram_id = null, normalized_link = null) {
  const db = initSupabase();
  if (!db || !db.from) throw new Error('SUPABASE_NOT_CONFIGURED');
  try {
    const { data: found } = await db.from('threads').select('*').eq('social_link', social_link).limit(1);
    if (found && found.length) return found[0];
    const { data } = await db.from('threads').insert({
      social_link,
      creator_telegram_id,
      normalized_link
    }).select().single();
    return data;
  } catch (err) {
    console.error('[db] findOrCreateThread error:', err?.message || err);
    await notifyAdmins(`[DB ERROR] findOrCreateThread failed: ${err?.message}`, { social_link });
    throw err;
  }
}

// COMMENTS
async function addVoiceComment({ thread_id, telegram_id, username, first_name, telegram_file_id, duration }) {
  const db = initSupabase();
  if (!db || !db.from) throw new Error('SUPABASE_NOT_CONFIGURED');
  try {
    const { data } = await db.from('voice_comments').insert({
      thread_id,
      telegram_id,
      username: username || null,
      first_name: first_name || null,
      telegram_file_id,
      duration
    }).select().single();
    return data;
  } catch (err) {
    console.error('[db] addVoiceComment error:', err?.message || err);
    await notifyAdmins(`[DB ERROR] addVoiceComment failed: ${err?.message}`, { thread_id, telegram_id });
    throw err;
  }
}

async function listCommentsForThread(thread_id, limit = 15, offset = 0) {
  const db = initSupabase();
  if (!db || !db.from) throw new Error('SUPABASE_NOT_CONFIGURED');
  try {
    const { data } = await db.from('voice_comments')
      .select('*')
      .eq('thread_id', thread_id)
      .order('created_at', { ascending: false })
      .limit(limit)
      .offset(offset);
    return data || [];
  } catch (err) {
    console.error('[db] listCommentsForThread error:', err?.message || err);
    await notifyAdmins(`[DB ERROR] listCommentsForThread failed: ${err?.message}`, { thread_id });
    throw err;
  }
}

async function getCommentById(id) {
  const db = initSupabase();
  if (!db || !db.from) throw new Error('SUPABASE_NOT_CONFIGURED');
  const { data } = await db.from('voice_comments').select('*').eq('id', id).limit(1);
  return data && data[0] ? data[0] : null;
}

// REPLIES
async function addReply({ comment_id, replier_telegram_id, replier_username, replier_first_name, reply_text = null, reply_photo_url = null, telegram_file_id = null }) {
  const db = initSupabase();
  if (!db || !db.from) throw new Error('SUPABASE_NOT_CONFIGURED');
  try {
    const { data } = await db.from('replies').insert({
      comment_id,
      replier_telegram_id,
      replier_username: replier_username || null,
      replier_first_name: replier_first_name || null,
      reply_text,
      reply_photo_url,
      telegram_file_id
    }).select().single();
    return data;
  } catch (err) {
    console.error('[db] addReply error:', err?.message || err);
    await notifyAdmins(`[DB ERROR] addReply failed: ${err?.message}`, { comment_id, replier_telegram_id });
    throw err;
  }
}

async function listRepliesForComment(comment_id) {
  const db = initSupabase();
  if (!db || !db.from) throw new Error('SUPABASE_NOT_CONFIGURED');
  const { data } = await db.from('replies').select('*').eq('comment_id', comment_id).order('created_at', { ascending: true });
  return data || [];
}

// FAVORITES
async function toggleFavorite(comment_id, telegram_id) {
  const db = initSupabase();
  if (!db || !db.from) throw new Error('SUPABASE_NOT_CONFIGURED');
  try {
    const { data: exists } = await db.from('favorites').select('*').eq('comment_id', comment_id).eq('telegram_id', telegram_id).limit(1);
    if (exists && exists.length) {
      await db.from('favorites').delete().eq('id', exists[0].id);
      return { removed: true };
    } else {
      const { data } = await db.from('favorites').insert({ comment_id, telegram_id }).select().single();
      return { added: true, id: data.id };
    }
  } catch (err) {
    console.error('[db] toggleFavorite error:', err?.message || err);
    await notifyAdmins(`[DB ERROR] toggleFavorite failed: ${err?.message}`, { comment_id, telegram_id });
    throw err;
  }
}

async function listFavoritesForUser(telegram_id) {
  const db = initSupabase();
  if (!db || !db.from) throw new Error('SUPABASE_NOT_CONFIGURED');
  const { data } = await db.from('favorites').select('*,voice_comments(*)').eq('telegram_id', telegram_id).order('created_at', { ascending: false });
  return data || [];
}

// REACTIONS
async function addReaction(comment_id, telegram_id, type) {
  const db = initSupabase();
  if (!db || !db.from) throw new Error('SUPABASE_NOT_CONFIGURED');
  try {
    const { data } = await db.from('reactions').insert({ comment_id, telegram_id, type }).select().single();
    return data;
  } catch (err) {
    console.error('[db] addReaction error:', err?.message || err);
    await notifyAdmins(`[DB ERROR] addReaction failed: ${err?.message}`, { comment_id, telegram_id, type });
    throw err;
  }
}

async function countReactions(comment_id) {
  const db = initSupabase();
  if (!db || !db.rpc) throw new Error('SUPABASE_NOT_CONFIGURED');
  try {
    const { data } = await db.from('reactions').select('*').eq('comment_id', comment_id);
    return data ? data.length : 0;
  } catch (err) {
    console.error('[db] countReactions error:', err?.message || err);
    return 0;
  }
}

// PAYMENTS
async function createPaymentRequest({ telegram_id, package_name, comments_amount, amount, method }) {
  const db = initSupabase();
  if (!db || !db.from) throw new Error('SUPABASE_NOT_CONFIGURED');
  try {
    const { data } = await db.from('payment_requests').insert({
      telegram_id,
      package_name,
      comments_amount,
      amount,
      method,
      status: 'pending'
    }).select().single();
    // notify admins
    await notifyAdmins(`[PAYMENT REQUEST] ${telegram_id} requested ${package_name} ${comments_amount} comments for ${amount} (${method})`, { payment_request_id: data.id });
    return data;
  } catch (err) {
    console.error('[db] createPaymentRequest error:', err?.message || err);
    await notifyAdmins(`[DB ERROR] createPaymentRequest failed: ${err?.message}`, { telegram_id });
    throw err;
  }
}

async function attachPaymentProof(payment_request_id, proof_telegram_file_id) {
  const db = initSupabase();
  if (!db || !db.from) throw new Error('SUPABASE_NOT_CONFIGURED');
  try {
    const { data } = await db.from('payment_requests').update({
      proof_telegram_file_id,
      status: 'proof_submitted'
    }).eq('id', payment_request_id).select().single();
    await notifyAdmins(`[PAYMENT PROOF] request ${payment_request_id} proof submitted`, { payment_request_id, proof_telegram_file_id });
    return data;
  } catch (err) {
    console.error('[db] attachPaymentProof error:', err?.message || err);
    await notifyAdmins(`[DB ERROR] attachPaymentProof failed: ${err?.message}`, { payment_request_id });
    throw err;
  }
}

module.exports = {
  initSupabase,
  setAdminNotifier,
  notifyAdmins,
  ensureUser,
  findOrCreateThread,
  addVoiceComment,
  listCommentsForThread,
  getCommentById,
  addReply,
  listRepliesForComment,
  toggleFavorite,
  listFavoritesForUser,
  addReaction,
  countReactions,
  createPaymentRequest,
  attachPaymentProof
};
