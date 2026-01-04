// src/database.js
const { createClient } = require('@supabase/supabase-js');
const utils = require('./utils');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_KEY');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

// small helper
async function maybeSingle(promise) {
  const res = await promise;
  if (res.error) throw res.error;
  return res.data ?? res;
}

/* -------------------------
   User helpers
   ------------------------- */
async function ensureUser(user) {
  const telegram_id = (typeof user === 'object' && user.id) ? Number(user.id) : Number(user);
  if (!telegram_id) throw new Error('Invalid telegram id');

  const row = {
    telegram_id,
    username: user.username || null,
    balance: 0
  };

  // upsert
  const res = await supabase
    .from('users')
    .upsert(row, { onConflict: ['telegram_id'], returning: 'representation' })
    .select()
    .maybeSingle();

  if (res.error) throw res.error;
  return res.data || res;
}

async function getBalance(telegramId) {
  const res = await supabase.from('users').select('balance').eq('telegram_id', telegramId).limit(1).maybeSingle();
  if (res.error) throw res.error;
  const data = res.data || res;
  return (data && typeof data.balance === 'number') ? data.balance : 0;
}

async function changeBalance(telegramId, delta) {
  // ensure user exists
  await ensureUser(telegramId).catch(()=>null);
  const cur = await supabase.from('users').select('balance').eq('telegram_id', telegramId).limit(1).maybeSingle();
  if (cur.error) throw cur.error;
  const current = (cur.data || cur).balance ?? 0;
  const next = Math.max(0, Number(current) + Number(delta));
  const res = await supabase.from('users').update({ balance: next }).eq('telegram_id', telegramId).select().maybeSingle();
  if (res.error) throw res.error;
  return res.data || res;
}

/* -------------------------
   Threads (videos)
   ------------------------- */
async function findOrCreateThread(link, creatorTelegramId = null) {
  const normInfo = await utils.normalizeVideoUrl(link).catch(()=>({ canonical_link: link, normalized_link: link, provider: 'generic' }));
  const normalized = normInfo.normalized_link || link;

  // try to find
  const find = await supabase.from('threads')
    .select('*')
    .or(`normalized_link.eq.${normalized},original_link.eq.${link}`)
    .limit(1)
    .maybeSingle();

  if (find.error) {
    // If threads table doesn't exist or other error, throw
    throw find.error;
  }
  if (find.data) {
    // update creator if missing
    if (creatorTelegramId && !find.data.creator_telegram_id) {
      await supabase.from('threads').update({ creator_telegram_id: creatorTelegramId }).eq('id', find.data.id).catch(()=>null);
      find.data.creator_telegram_id = creatorTelegramId;
    }
    return find.data;
  }

  // insert
  const insertRow = {
    original_link: link,
    normalized_link: normalized,
    creator_telegram_id: creatorTelegramId || null,
    created_at: new Date().toISOString()
  };

  const inserted = await supabase.from('threads').insert([insertRow]).select().maybeSingle();
  if (inserted.error) {
    // race: try to fetch again
    const retry = await supabase.from('threads').select('*').or(`normalized_link.eq.${normalized},original_link.eq.${link}`).limit(1).maybeSingle();
    if (retry.error) throw retry.error;
    if (retry.data) return retry.data;
    throw inserted.error;
  }
  return inserted.data;
}

async function getThreadById(id) {
  const res = await supabase.from('threads').select('*').eq('id', id).limit(1).maybeSingle();
  if (res.error) throw res.error;
  return res.data || res;
}

/* -------------------------
   Voice comments
   ------------------------- */
async function insertComment({ thread_id, user_telegram_id, file_id, duration = 0 }) {
  const insertRow = {
    thread_id: thread_id || null,
    user_telegram_id,
    file_id,
    duration: Number(duration) || 0,
    created_at: new Date().toISOString()
  };

  const res = await supabase.from('voice_comments').insert([insertRow]).select().maybeSingle();
  if (res.error) throw res.error;
  let row = res.data || res;
  // generate unique code (base36) and save into unique_code if column exists
  try {
    const code = utils.encodeShortCode(row.id);
    // attempt to update unique_code column; if column missing, ignore
    await supabase.from('voice_comments').update({ unique_code: code }).eq('id', row.id).catch(()=>null);
    row.unique_code = code;
  } catch (e) { /* ignore */ }
  return row;
}

async function getCommentById(id) {
  const res = await supabase.from('voice_comments').select('*').eq('id', id).limit(1).maybeSingle();
  if (res.error) throw res.error;
  return res.data || res;
}

async function listCommentsByThread(threadId, limit = 10, offset = 0) {
  const res = await supabase.from('voice_comments').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (res.error) throw res.error;
  return res.data || res;
}

async function listMyComments(telegramId) {
  const res = await supabase.from('voice_comments').select('*').eq('user_telegram_id', telegramId).order('created_at', { ascending: false });
  if (res.error) throw res.error;
  return res.data || res;
}

async function countCommentsForThread(threadId) {
  const res = await supabase.from('voice_comments').select('id', { count: 'exact' }).eq('thread_id', threadId);
  if (res.error) return 0;
  return res.count || 0;
}

/* -------------------------
   Replies
   ------------------------- */
async function insertReply({ comment_id, user_telegram_id, type = 'text', file_id = null, text = null, duration = 0 }) {
  const insertRow = {
    comment_id,
    user_telegram_id,
    type,
    file_id,
    text,
    duration: Number(duration) || 0,
    created_at: new Date().toISOString()
  };
  const res = await supabase.from('replies').insert([insertRow]).select().maybeSingle();
  if (res.error) throw res.error;
  const row = res.data || res;
  // generate unique_code if column exists
  try {
    const code = utils.encodeShortCode(row.id);
    await supabase.from('replies').update({ unique_code: code }).eq('id', row.id).catch(()=>null);
    row.unique_code = code;
  } catch (e) {}
  return row;
}

async function getReplyById(id) {
  const res = await supabase.from('replies').select('*').eq('id', id).limit(1).maybeSingle();
  if (res.error) throw res.error;
  return res.data || res;
}

async function listReplies(commentId, limit = 10, offset = 0) {
  const res = await supabase.from('replies').select('*').eq('comment_id', commentId).order('created_at', { ascending: true }).range(offset, offset + limit - 1);
  if (res.error) throw res.error;
  return res.data || res;
}

async function countRepliesForComment(commentId) {
  const res = await supabase.from('replies').select('id', { count: 'exact' }).eq('comment_id', commentId);
  if (res.error) return 0;
  return res.count || 0;
}

/* -------------------------
   Favorites
   ------------------------- */
async function toggleFavorite(user_telegram_id, comment_id) {
  // check exists
  const check = await supabase.from('favorites').select('*').eq('user_telegram_id', user_telegram_id).eq('comment_id', comment_id).limit(1).maybeSingle();
  if (check.error) throw check.error;
  if (check.data) {
    await supabase.from('favorites').delete().eq('id', check.data.id).catch(()=>null);
    return { added: false };
  } else {
    const insert = await supabase.from('favorites').insert([{ user_telegram_id, comment_id, created_at: new Date().toISOString() }]).select().maybeSingle();
    if (insert.error) throw insert.error;
    return { added: true };
  }
}

async function listFavorites(user_telegram_id) {
  // fetch favorites and map to voice_comments
  const res = await supabase.from('favorites').select('comment_id').eq('user_telegram_id', user_telegram_id);
  if (res.error) throw res.error;
  const ids = (res.data || res).map(r => r.comment_id);
  if (!ids || ids.length === 0) return [];
  const comments = await supabase.from('voice_comments').select('*').in('id', ids).order('created_at', { ascending: false });
  if (comments.error) throw comments.error;
  return comments.data || comments;
}

/* -------------------------
   Reactions
   ------------------------- */
async function toggleReaction({ user_telegram_id, target_type, target_id, emoji }) {
  // unique per user,target
  const res = await supabase.from('reactions').select('*').eq('user_telegram_id', user_telegram_id).eq('target_type', target_type).eq('target_id', target_id).limit(1).maybeSingle();
  if (res.error) throw res.error;
  const exists = res.data;
  if (exists) {
    if (exists.emoji === emoji) {
      // remove
      await supabase.from('reactions').delete().eq('id', exists.id).catch(()=>null);
      return { removed: true };
    } else {
      // update emoji
      await supabase.from('reactions').update({ emoji }).eq('id', exists.id).catch(()=>null);
      return { changed: true };
    }
  } else {
    await supabase.from('reactions').insert([{ user_telegram_id, target_type, target_id, emoji, created_at: new Date().toISOString() }]).catch(()=>null);
    return { added: true };
  }
}

/* -------------------------
   Reports
   ------------------------- */
async function insertReport({ reporter_telegram_id, target_type, target_id, reason }) {
  const res = await supabase.from('reports').insert([{ reporter_telegram_id, target_type, target_id, reason, created_at: new Date().toISOString() }]).select().maybeSingle();
  if (res.error) throw res.error;
  return res.data || res;
}

/* -------------------------
   Notifications
   ------------------------- */
async function insertNotification({ user_telegram_id, type, payload }) {
  const row = { user_telegram_id, type, payload: payload ? JSON.stringify(payload) : null, created_at: new Date().toISOString() };
  const res = await supabase.from('notifications').insert([row]).select().maybeSingle();
  if (res.error) throw res.error;
  return res.data || res;
}

async function listNotifications(user_telegram_id) {
  const res = await supabase.from('notifications').select('*').eq('user_telegram_id', user_telegram_id).order('created_at', { ascending: false }).limit(100);
  if (res.error) throw res.error;
  // parse payload
  return (res.data || res).map(r => {
    try { r.payload = r.payload ? JSON.parse(r.payload) : null; } catch (e) { /* ignore */ }
    return r;
  });
}

/* -------------------------
   Trackers (optional table)
   If tracked_videos table exists, this will use it; otherwise returns [].
   ------------------------- */
async function listTrackersForThread(thread_id) {
  try {
    const res = await supabase.from('tracked_videos').select('*').eq('thread_id', thread_id);
    if (res.error) return [];
    return res.data || [];
  } catch (e) {
    return [];
  }
}

/* -------------------------
   Payments
   - createPaymentRequest returns a row object and ensures a 'credits' property in returned object
   - getPayment returns row and `credits` property if present or encoded in proof
   ------------------------- */
async function createPaymentRequest({ user_telegram_id, package_name, amount, credits = 0 }) {
  // try to insert credits column if exists
  try {
    const res = await supabase.from('payment_requests').insert([{ user_telegram_id, package_name, amount, credits, proof: null, status: 'pending', created_at: new Date().toISOString() }]).select().maybeSingle();
    if (res.error) {
      // try without credits column (table might not have it)
      const re2 = await supabase.from('payment_requests').insert([{ user_telegram_id, package_name, amount, proof: JSON.stringify({ credits }), status: 'pending', created_at: new Date().toISOString() }]).select().maybeSingle();
      if (re2.error) throw re2.error;
      const row = re2.data || re2;
      row.credits = Number(credits || 0);
      return row;
    }
    const row = res.data || res;
    row.credits = Number(credits || row.credits || 0);
    return row;
  } catch (e) {
    throw e;
  }
}

async function getPayment(paymentId) {
  const res = await supabase.from('payment_requests').select('*').eq('id', paymentId).limit(1).maybeSingle();
  if (res.error) throw res.error;
  const row = res.data || res;
  // attempt to find credits: prefer row.credits else look inside proof JSON if present
  let credits = row.credits ?? null;
  if ((credits === null || credits === undefined) && row.proof) {
    try {
      const parsed = JSON.parse(row.proof);
      if (parsed && parsed.credits) credits = Number(parsed.credits);
    } catch (e) {
      credits = credits;
    }
  }
  row.credits = Number(credits || 0);
  return row;
}

async function setPaymentStatus(paymentId, status, updates = {}) {
  const payload = Object.assign({}, updates, { status });
  const res = await supabase.from('payment_requests').update(payload).eq('id', paymentId).select().maybeSingle();
  if (res.error) throw res.error;
  return res.data || res;
}

async function submitPaymentProof(paymentId, { proof_text = null, proof_file_id = null }) {
  const payload = {};
  if (proof_text) payload.proof = proof_text;
  if (proof_file_id) payload.proof = proof_file_id;
  payload.status = 'proof_submitted';
  const res = await supabase.from('payment_requests').update(payload).eq('id', paymentId).select().maybeSingle();
  if (res.error) throw res.error;
  return res.data || res;
}

/* admin: credit user */
async function creditUser(user_telegram_id, credits) {
  // ensure user
  await ensureUser(user_telegram_id).catch(()=>null);
  const cur = await supabase.from('users').select('balance').eq('telegram_id', user_telegram_id).limit(1).maybeSingle();
  if (cur.error) throw cur.error;
  const current = (cur.data || cur).balance ?? 0;
  const next = Number(current) + Number(credits || 0);
  const res = await supabase.from('users').update({ balance: next }).eq('telegram_id', user_telegram_id).select().maybeSingle();
  if (res.error) throw res.error;
  return res.data || res;
}

/* -------------------------
   Admin posts
   ------------------------- */
async function createAdminPost({ content_type, content = null, file_id = null }) {
  const res = await supabase.from('admin_posts').insert([{ content_type, content, file_id, created_at: new Date().toISOString() }]).select().maybeSingle();
  if (res.error) throw res.error;
  return res.data || res;
}

/* -------------------------
   Misc helpers
   ------------------------- */
async function listUsers(limit = 500) {
  const res = await supabase.from('users').select('telegram_id').limit(limit);
  if (res.error) throw res.error;
  return res.data || res;
}

async function deleteComment(commentId) {
  // rely on FK cascade to remove replies; delete related favorites/reactions explicitly
  await supabase.from('favorites').delete().eq('comment_id', commentId).catch(()=>null);
  await supabase.from('reactions').delete().eq('target_type', 'comment').eq('target_id', commentId).catch(()=>null);
  const res = await supabase.from('voice_comments').delete().eq('id', commentId).select().maybeSingle();
  if (res.error) throw res.error;
  return res.data || res;
}

async function deleteReply(replyId) {
  await supabase.from('reactions').delete().eq('target_type', 'reply').eq('target_id', replyId).catch(()=>null);
  const res = await supabase.from('replies').delete().eq('id', replyId).select().maybeSingle();
  if (res.error) throw res.error;
  return res.data || res;
}

module.exports = {
  supabase,
  ensureUser,
  getBalance,
  changeBalance,
  findOrCreateThread,
  getThreadById,
  insertComment,
  getCommentById,
  listCommentsByThread,
  listMyComments,
  countCommentsForThread,
  insertReply,
  getReplyById,
  listReplies,
  countRepliesForComment,
  toggleFavorite,
  listFavorites,
  toggleReaction,
  insertReport,
  insertNotification,
  listNotifications,
  listTrackersForThread,
  createPaymentRequest,
  getPayment,
  setPaymentStatus,
  submitPaymentProof,
  creditUser,
  createAdminPost,
  listUsers,
  deleteComment,
  deleteReply,
};
