// src/database.js
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_KEY');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// Helper to safely return .data or throw error
async function runQuery(q) {
  const res = await q;
  if (res.error) throw res.error;
  return res.data;
}

/* USERS */
async function ensureUserRow(userOrId) {
  const telegram_id = (typeof userOrId === 'object' && userOrId.id) ? Number(userOrId.id) : Number(userOrId);
  if (!telegram_id) throw new Error('Invalid telegram id');
  const up = {
    telegram_id,
    username: (userOrId && userOrId.username) ? userOrId.username : null,
    first_name: (userOrId && userOrId.first_name) ? userOrId.first_name : null,
    updated_at: new Date().toISOString()
  };
  const { data, error } = await supabase.from('users').upsert(up, { onConflict: ['telegram_id'], returning: 'representation' }).select().maybeSingle();
  if (error) throw error;
  return data;
}

/* THREADS */
async function findOrCreateThread(link, creatorTelegramId = null) {
  if (!link) throw new Error('Missing link');
  const norm = await (async () => {
    // dynamic import of utils to avoid cycles; but utils is simple so require
    const utils = require('./utils');
    return utils.normalizeVideoUrl(link);
  })();

  const normalized_key = norm.normalized_link;
  // try to find
  const { data: existing } = await supabase.from('threads').select('*').or(`normalized_link.eq.${normalized_key},social_link.eq.${link},canonical_link.eq.${link}`).limit(1).maybeSingle();
  if (existing) {
    // update creator if missing
    if (creatorTelegramId && !existing.creator_telegram_id) {
      await supabase.from('threads').update({ creator_telegram_id: creatorTelegramId }).eq('id', existing.id).catch(()=>null);
      existing.creator_telegram_id = creatorTelegramId;
    }
    return existing;
  }
  // insert thread row
  const insertRow = {
    social_link: link,
    canonical_link: norm.canonical_link || link,
    normalized_link: normalized_key,
    provider: norm.provider || null,
    provider_id: norm.provider_id || null,
    creator_telegram_id: creatorTelegramId || null,
    created_at: new Date().toISOString()
  };
  const { data, error } = await supabase.from('threads').insert([insertRow]).select().maybeSingle();
  if (error) {
    // race - try fetch again
    const { data: fallback } = await supabase.from('threads').select('*').or(`normalized_link.eq.${normalized_key},social_link.eq.${link},canonical_link.eq.${link}`).limit(1).maybeSingle();
    if (fallback) return fallback;
    throw error;
  }
  return data;
}

async function getThreadById(id) {
  if (!id) return null;
  const { data, error } = await supabase.from('threads').select('*').eq('id', id).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

/* TRACKED VIDEOS (kept but not used in user thread actions) */
async function trackThread(tracker_telegram_id, thread_id) {
  const row = { tracker_telegram_id, thread_id, created_at: new Date().toISOString() };
  const { data, error } = await supabase.from('tracked_videos').upsert(row, { onConflict: ['tracker_telegram_id','thread_id'], returning: 'representation' }).select().maybeSingle();
  if (error) throw error;
  return data;
}
async function listTrackedByUser(tracker_telegram_id) {
  const { data, error } = await supabase.from('tracked_videos').select('id,thread_id,created_at,threads(*)').eq('tracker_telegram_id', tracker_telegram_id).order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(r => Object.assign({ id: r.id, thread_id: r.thread_id, created_at: r.created_at }, r.threads || {}));
}
async function listTrackersForThread(thread_id) {
  const { data, error } = await supabase.from('tracked_videos').select('*').eq('thread_id', thread_id);
  if (error) throw error;
  return data || [];
}
async function untrackThread(tracker_telegram_id, thread_id) {
  const { error } = await supabase.from('tracked_videos').delete().eq('tracker_telegram_id', tracker_telegram_id).eq('thread_id', thread_id);
  if (error) throw error;
  return { removed: true };
}

/* PAYMENTS */
async function createPaymentRequest(payload) {
  const row = Object.assign({ status: 'pending', created_at: new Date().toISOString() }, payload);
  const { data, error } = await supabase.from('payment_requests').insert([row]).select().maybeSingle();
  if (error) throw error;
  return data;
}
async function getPaymentById(id) {
  const { data, error } = await supabase.from('payment_requests').select('*').eq('id', id).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}
async function updatePaymentStatus(id, status, updates = {}) {
  const payload = Object.assign({ status }, updates);
  const { data, error } = await supabase.from('payment_requests').update(payload).eq('id', id).select().maybeSingle();
  if (error) throw error;
  return data;
}

/* VOICE COMMENTS */
async function insertVoiceComment(row) {
  const insertRow = Object.assign({}, row, { created_at: new Date().toISOString() });
  const { data, error } = await supabase.from('voice_comments').insert([insertRow]).select().maybeSingle();
  if (error) throw error;
  return data;
}
async function listCommentsByThread(threadId, offset = 0, limit = 15) {
  const { data, error } = await supabase.from('voice_comments').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
}
async function listCommentsByUser(telegramId, limit = 100) {
  const { data, error } = await supabase.from('voice_comments').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}
async function getCommentById(id) {
  const { data, error } = await supabase.from('voice_comments').select('*').eq('id', id).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

/* REPLIES */
async function insertReplyRow(row) {
  const allowed = ['comment_id','replier_telegram_id','replier_username','replier_first_name','telegram_file_id','reply_text','duration','created_at'];
  const insertRow = {};
  for (const k of allowed) if (k in row) insertRow[k] = row[k];
  if (!insertRow.created_at) insertRow.created_at = new Date().toISOString();
  const { data, error } = await supabase.from('replies').insert([insertRow]).select().maybeSingle();
  if (error) throw error;
  return data;
}
async function listReplies(commentId, offset = 0, limit = 50) {
  const { data, error } = await supabase.from('replies').select('*').eq('comment_id', commentId).order('created_at', { ascending: true }).range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
}

/* FAVORITES */
async function toggleFavoriteRow(telegramId, commentId) {
  const { data: exists, error } = await supabase.from('favorites').select('*').eq('telegram_id', telegramId).eq('comment_id', commentId).limit(1).maybeSingle();
  if (error) throw error;
  if (exists) {
    await supabase.from('favorites').delete().eq('id', exists.id);
    return { removed: true };
  } else {
    const { data: d, error: e } = await supabase.from('favorites').insert([{ telegram_id: telegramId, comment_id: commentId }]).select().maybeSingle();
    if (e) throw e;
    return { removed: false, data: d };
  }
}
async function listFavoritesForUser(telegramId) {
  const { data, error } = await supabase.from('favorites').select('voice_comments(*)').eq('telegram_id', telegramId);
  if (error) throw error;
  return (data || []).map(r => r.voice_comments).filter(Boolean);
}

/* REACTIONS */
async function insertReactionRow(row) {
  const insertRow = Object.assign({}, row, { created_at: new Date().toISOString() });
  const { data, error } = await supabase.from('reactions').insert([insertRow]).select().maybeSingle();
  if (error) throw error;
  return data;
}

/* NOTIFICATIONS & REPORTS */
async function addNotificationRow(row) {
  const insertRow = Object.assign({}, row, { created_at: new Date().toISOString() });
  const { data, error } = await supabase.from('notifications').insert([insertRow]).select().maybeSingle();
  if (error) throw error;
  return data;
}
async function listNotifications(telegramId) {
  const { data, error } = await supabase.from('notifications').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return data || [];
}
async function insertReport(row) {
  const insertRow = Object.assign({}, row, { created_at: new Date().toISOString(), status: 'open' });
  const { data, error } = await supabase.from('reports').insert([insertRow]).select().maybeSingle();
  if (error) throw error;
  return data;
}

/* DELETES */
async function deleteCommentById(id) {
  try {
    await supabase.from('favorites').delete().eq('comment_id', id);
    await supabase.from('reactions').delete().eq('comment_id', id);
    await supabase.from('replies').delete().eq('comment_id', id);
    await supabase.from('voice_comments').delete().eq('id', id);
    return { deleted: true };
  } catch (e) {
    return { error: e };
  }
}

module.exports = {
  supabase,
  ensureUserRow,
  findOrCreateThread,
  getThreadById,
  listThreadsByCreator,
  trackThread,
  listTrackedByUser,
  listTrackersForThread,
  untrackThread,
  createPaymentRequest,
  getPaymentById,
  updatePaymentStatus,
  insertVoiceComment,
  listCommentsByThread,
  listCommentsByUser,
  getCommentById,
  insertReplyRow,
  listReplies,
  toggleFavoriteRow,
  listFavoritesForUser,
  insertReactionRow,
  addNotificationRow,
  listNotifications,
  insertReport,
  deleteCommentById
};
