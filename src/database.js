// src/database.js
// Supabase wrapper for the bot. Exports functions used by src/bot.js
// Updated: ensures credits/canonical_link/tracked_videos exists in recommended schema,
// safer fallbacks and explicit listUsers output.

const { createClient } = require('@supabase/supabase-js');
const utils = require('./utils');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY environment variables');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  global: { headers: { 'x-client-info': 'worldvoice-bot' } }
});

// simple ping
async function ping() {
  try {
    const res = await supabase.from('users').select('telegram_id').limit(1);
    return !res.error;
  } catch (e) {
    return false;
  }
}

/* -------------------------
   Users & balances
   ------------------------- */
async function ensureUser(user) {
  const telegram_id = (typeof user === 'object' && user && user.id) ? Number(user.id) : Number(user);
  if (!telegram_id) throw new Error('Invalid telegram id for ensureUser');

  const up = {
    telegram_id,
    username: (user && user.username) || null,
    updated_at: new Date().toISOString()
  };

  const res = await supabase
    .from('users')
    .upsert(up, { onConflict: ['telegram_id'], returning: 'representation' })
    .select();
  if (res.error) throw res.error;
  return (res.data && res.data[0]) || null;
}

async function getBalance(telegramId) {
  const res = await supabase.from('users').select('balance').eq('telegram_id', telegramId).limit(1);
  if (res.error) throw res.error;
  const row = (res.data && res.data[0]) || null;
  return (row && typeof row.balance === 'number') ? row.balance : 0;
}

async function changeBalance(telegramId, delta) {
  await ensureUser(telegramId).catch(()=>null);
  const cur = await supabase.from('users').select('balance').eq('telegram_id', telegramId).limit(1);
  if (cur.error) throw cur.error;
  const current = (cur.data && cur.data[0] && Number(cur.data[0].balance)) || 0;
  const next = Math.max(0, Number(current) + Number(delta));
  const res = await supabase.from('users').update({ balance: next }).eq('telegram_id', telegramId).select();
  if (res.error) throw res.error;
  return (res.data && res.data[0]) || null;
}

/* -------------------------
   Threads (videos) - normalization aware
   ------------------------- */
async function findOrCreateThread(link, creatorTelegramId = null) {
  const info = utils.normalizeVideoUrl(link) || {};
  const normalized = info.normalized_link || link;

  // try to find existing by normalized_link or original_link
  let find;
  try {
    // select common columns only to avoid schema errors if optional columns don't exist
    find = await supabase
      .from('threads')
      .select('id, original_link, normalized_link, provider, provider_id, thumbnail, canonical_link, created_at, creator_telegram_id')
      .or(`normalized_link.eq.${normalized},original_link.eq.${link}`)
      .limit(1);
  } catch (e) {
    throw new Error('Threads table missing or schema mismatch: ' + (e.message || e));
  }
  if (find.error) throw find.error;
  if (find.data && find.data.length > 0) {
    const existing = find.data[0];
    if (creatorTelegramId && !existing.creator_telegram_id) {
      await supabase.from('threads').update({ creator_telegram_id: creatorTelegramId }).eq('id', existing.id).catch(()=>null);
      existing.creator_telegram_id = creatorTelegramId;
    }
    return existing;
  }

  const insertRow = {
    original_link: link,
    normalized_link: normalized,
    provider: info.provider || null,
    provider_id: info.provider_id || null,
    thumbnail: info.thumbnail || null,
    canonical_link: info.canonical_link || null,
    created_at: new Date().toISOString(),
    creator_telegram_id: creatorTelegramId || null
  };

  const inserted = await supabase.from('threads').insert([insertRow]).select();
  if (inserted.error) {
    // retry find to handle race
    const retry = await supabase
      .from('threads')
      .select('id, original_link, normalized_link, provider, provider_id, thumbnail, canonical_link, created_at, creator_telegram_id')
      .or(`normalized_link.eq.${normalized},original_link.eq.${link}`)
      .limit(1);
    if (retry.error) throw retry.error;
    if (retry.data && retry.data.length > 0) return retry.data[0];
    throw inserted.error;
  }
  return (inserted.data && inserted.data[0]) || null;
}

async function getThreadById(id) {
  const res = await supabase.from('threads').select('id, original_link, normalized_link, provider, provider_id, thumbnail, canonical_link, created_at, creator_telegram_id').eq('id', id).limit(1);
  if (res.error) throw res.error;
  return (res.data && res.data[0]) || null;
}

/* -------------------------
   Tracked videos
   ------------------------- */
async function trackThread(user_telegram_id, thread_id) {
  const row = { user_telegram_id, thread_id, created_at: new Date().toISOString() };
  try {
    const res = await supabase.from('tracked_videos').upsert(row, { onConflict: ['user_telegram_id','thread_id'], returning: 'representation' }).select();
    if (res.error) throw res.error;
    return (res.data && res.data[0]) || null;
  } catch (e) {
    throw new Error('Could not track video (tracked_videos table missing?)');
  }
}

async function untrackThread(user_telegram_id, thread_id) {
  try {
    const res = await supabase.from('tracked_videos').delete().eq('user_telegram_id', user_telegram_id).eq('thread_id', thread_id);
    if (res.error) throw res.error;
    return { removed: true };
  } catch (e) {
    throw new Error('Could not untrack video');
  }
}

async function listTrackedByUser(user_telegram_id) {
  try {
    const res = await supabase.from('tracked_videos').select('thread_id,created_at,threads(*)').eq('user_telegram_id', user_telegram_id).order('created_at', { ascending: false });
    if (res.error) return [];
    return (res.data || []).map(r => {
      const thread = r.threads || null;
      return thread ? Object.assign({ tracked_created_at: r.created_at }, thread) : { thread_id: r.thread_id, created_at: r.created_at };
    });
  } catch (e) {
    return [];
  }
}

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
   Voice comments & replies
   ------------------------- */
async function insertComment({ thread_id, user_telegram_id, file_id, duration = 0 }) {
  const row = {
    thread_id: thread_id || null,
    user_telegram_id,
    file_id,
    duration: Number(duration) || 0,
    created_at: new Date().toISOString()
  };
  const res = await supabase.from('voice_comments').insert([row]).select();
  if (res.error) throw res.error;
  const saved = (res.data && res.data[0]) || null;
  if (saved) {
    try {
      const code = utils.encodeShortCode(saved.id);
      await supabase.from('voice_comments').update({ unique_code: code }).eq('id', saved.id).catch(()=>null);
      saved.unique_code = code;
    } catch (e) {}
  }
  return saved;
}

async function getCommentById(id) {
  const res = await supabase.from('voice_comments').select('*').eq('id', id).limit(1);
  if (res.error) throw res.error;
  return (res.data && res.data[0]) || null;
}

async function listCommentsByThread(threadId, limit = 10, offset = 0) {
  const res = await supabase.from('voice_comments').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (res.error) throw res.error;
  return res.data || [];
}

async function listMyComments(telegramId) {
  const res = await supabase.from('voice_comments').select('*').eq('user_telegram_id', telegramId).order('created_at', { ascending: false });
  if (res.error) throw res.error;
  return res.data || [];
}

async function countCommentsForThread(threadId) {
  const res = await supabase.from('voice_comments').select('id', { count: 'exact' }).eq('thread_id', threadId);
  if (res.error) return 0;
  return res.count || 0;
}

async function insertReply({ comment_id, user_telegram_id, type = 'text', file_id = null, text = null, duration = 0 }) {
  const row = {
    comment_id,
    user_telegram_id,
    type,
    file_id,
    text,
    duration: Number(duration) || 0,
    created_at: new Date().toISOString()
  };
  const res = await supabase.from('replies').insert([row]).select();
  if (res.error) throw res.error;
  const saved = (res.data && res.data[0]) || null;
  if (saved) {
    try {
      const code = utils.encodeShortCode(saved.id);
      await supabase.from('replies').update({ unique_code: code }).eq('id', saved.id).catch(()=>null);
      saved.unique_code = code;
    } catch (e) {}
  }
  return saved;
}

async function getReplyById(id) {
  const res = await supabase.from('replies').select('*').eq('id', id).limit(1);
  if (res.error) throw res.error;
  return (res.data && res.data[0]) || null;
}

async function listReplies(commentId, limit = 10, offset = 0) {
  const res = await supabase.from('replies').select('*').eq('comment_id', commentId).order('created_at', { ascending: true }).range(offset, offset + limit - 1);
  if (res.error) throw res.error;
  return res.data || [];
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
  const check = await supabase.from('favorites').select('*').eq('user_telegram_id', user_telegram_id).eq('comment_id', comment_id).limit(1);
  if (check.error) throw check.error;
  if (check.data && check.data.length > 0) {
    await supabase.from('favorites').delete().eq('id', check.data[0].id).catch(()=>null);
    return { added: false };
  } else {
    const ins = await supabase.from('favorites').insert([{ user_telegram_id, comment_id, created_at: new Date().toISOString() }]).select();
    if (ins.error) throw ins.error;
    return { added: true };
  }
}

async function listFavorites(user_telegram_id) {
  const res = await supabase.from('favorites').select('comment_id').eq('user_telegram_id', user_telegram_id);
  if (res.error) throw res.error;
  const ids = (res.data || []).map(r => r.comment_id);
  if (!ids.length) return [];
  const comments = await supabase.from('voice_comments').select('*').in('id', ids).order('created_at', { ascending: false });
  if (comments.error) throw comments.error;
  return comments.data || [];
}

/* -------------------------
   Reactions
   ------------------------- */
async function toggleReaction({ user_telegram_id, target_type, target_id, emoji }) {
  const res = await supabase.from('reactions').select('*').eq('user_telegram_id', user_telegram_id).eq('target_type', target_type).eq('target_id', target_id).limit(1);
  if (res.error) throw res.error;
  const exists = (res.data && res.data[0]) || null;
  if (exists) {
    if (exists.emoji === emoji) {
      await supabase.from('reactions').delete().eq('id', exists.id).catch(()=>null);
      return { removed: true };
    } else {
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
  const row = { reporter_telegram_id, target_type, target_id, reason, created_at: new Date().toISOString() };
  const res = await supabase.from('reports').insert([row]).select();
  if (res.error) throw res.error;
  return (res.data && res.data[0]) || null;
}

/* -------------------------
   Notifications
   ------------------------- */
async function insertNotification({ user_telegram_id, type, payload }) {
  const row = { user_telegram_id, type, payload: payload ? JSON.stringify(payload) : null, created_at: new Date().toISOString() };
  const res = await supabase.from('notifications').insert([row]).select();
  if (res.error) throw res.error;
  return (res.data && res.data[0]) || null;
}

async function listNotifications(user_telegram_id) {
  const res = await supabase.from('notifications').select('*').eq('user_telegram_id', user_telegram_id).order('created_at', { ascending: false }).limit(200);
  if (res.error) throw res.error;
  return (res.data || []).map(r => {
    try { r.payload = r.payload ? JSON.parse(r.payload) : null; } catch (e) { r.payload = r.payload; }
    return r;
  });
}

/* -------------------------
   Payments and admin actions
   ------------------------- */
async function createPaymentRequest({ user_telegram_id, package_name, amount, credits = 0 }) {
  // try insert with credits column; if it fails, fallback to using 'proof' JSON
  try {
    const res = await supabase.from('payment_requests').insert([{ user_telegram_id, package_name, amount, credits, proof: null, status: 'pending', created_at: new Date().toISOString() }]).select();
    if (res.error) {
      // fallback: insert with proof storing credits
      const res2 = await supabase.from('payment_requests').insert([{ user_telegram_id, package_name, amount, proof: JSON.stringify({ credits }), status: 'pending', created_at: new Date().toISOString() }]).select();
      if (res2.error) throw res2.error;
      const row = (res2.data && res2.data[0]) || null;
      if (row) row.credits = Number(credits || 0);
      return row;
    }
    const row = (res.data && res.data[0]) || null;
    if (row && (row.credits === null || row.credits === undefined)) row.credits = Number(credits || 0);
    return row;
  } catch (e) {
    throw e;
  }
}

async function getPayment(paymentId) {
  const res = await supabase.from('payment_requests').select('*').eq('id', paymentId).limit(1);
  if (res.error) throw res.error;
  const row = (res.data && res.data[0]) || null;
  if (!row) return null;
  // ensure credits
  let credits = row.credits ?? null;
  if ((credits === null || credits === undefined) && row.proof) {
    try {
      const parsed = typeof row.proof === 'string' ? JSON.parse(row.proof) : row.proof;
      if (parsed && parsed.credits) credits = Number(parsed.credits);
    } catch (e) { credits = credits; }
  }
  row.credits = Number(credits || 0);
  return row;
}

async function setPaymentStatus(paymentId, status, updates = {}) {
  const payload = Object.assign({}, updates, { status });
  const res = await supabase.from('payment_requests').update(payload).eq('id', paymentId).select();
  if (res.error) throw res.error;
  return (res.data && res.data[0]) || null;
}

async function submitPaymentProof(paymentId, { proof_text = null, proof_file_id = null }) {
  const payload = {};
  if (proof_text) payload.proof = proof_text;
  if (proof_file_id) payload.proof = proof_file_id;
  payload.status = 'proof_submitted';
  const res = await supabase.from('payment_requests').update(payload).eq('id', paymentId).select();
  if (res.error) throw res.error;
  return (res.data && res.data[0]) || null;
}

async function creditUser(user_telegram_id, credits) {
  await ensureUser(user_telegram_id).catch(()=>null);
  const cur = await supabase.from('users').select('balance').eq('telegram_id', user_telegram_id).limit(1);
  if (cur.error) throw cur.error;
  const current = (cur.data && cur.data[0] && Number(cur.data[0].balance)) || 0;
  const next = Number(current) + Number(credits || 0);
  const res = await supabase.from('users').update({ balance: next }).eq('telegram_id', user_telegram_id).select();
  if (res.error) throw res.error;
  return (res.data && res.data[0]) || null;
}

/* -------------------------
   Admin posts & misc
   ------------------------- */
async function createAdminPost({ content_type, content = null, file_id = null }) {
  const res = await supabase.from('admin_posts').insert([{ content_type, content, file_id, created_at: new Date().toISOString() }]).select();
  if (res.error) throw res.error;
  return (res.data && res.data[0]) || null;
}

async function listUsers(limit = 500) {
  const res = await supabase.from('users').select('telegram_id').limit(limit);
  if (res.error) throw res.error;
  const rows = res.data || [];
  // Flatten numeric ids and filter nulls
  return rows.map(r => r.telegram_id).filter(Boolean);
}

async function deleteComment(commentId) {
  await supabase.from('favorites').delete().eq('comment_id', commentId).catch(()=>null);
  await supabase.from('reactions').delete().eq('target_type','comment').eq('target_id', commentId).catch(()=>null);
  const res = await supabase.from('voice_comments').delete().eq('id', commentId).select();
  if (res.error) throw res.error;
  return (res.data && res.data[0]) || null;
}

async function deleteReply(replyId) {
  await supabase.from('reactions').delete().eq('target_type','reply').eq('target_id', replyId).catch(()=>null);
  const res = await supabase.from('replies').delete().eq('id', replyId).select();
  if (res.error) throw res.error;
  return (res.data && res.data[0]) || null;
}

module.exports = {
  supabase,
  ping,
  ensureUser,
  getBalance,
  changeBalance,
  findOrCreateThread,
  getThreadById,
  trackThread,
  untrackThread,
  listTrackedByUser,
  listTrackersForThread,
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
  createPaymentRequest,
  getPayment,
  setPaymentStatus,
  submitPaymentProof,
  creditUser,
  createAdminPost,
  listUsers,
  deleteComment,
  deleteReply
};
