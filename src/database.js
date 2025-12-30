// src/database.js
// Supabase wrapper matching bot.js (tracking, comments, replies, payments, favorites, reactions, notifications, reports)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY env vars.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  global: { headers: { 'x-from': 'worldvoice-bot' } }
});

/* --- Helper: safe single --- */
async function maybeSingle(queryPromise) {
  const res = await queryPromise;
  // supabase v2 returns { data, error }
  if (res && ('error' in res) && res.error) throw res.error;
  return res.data ?? null;
}

/* --- Users --- */
async function ensureUserRow(user) {
  // Accept either object { id, username, first_name } or numeric id
  const telegram_id = typeof user === 'object' && user.id ? Number(user.id) : Number(user);
  if (!telegram_id) throw new Error('Invalid user id');
  const row = {
    telegram_id,
    username: user && user.username ? user.username : null,
    first_name: user && user.first_name ? user.first_name : null,
    updated_at: new Date().toISOString()
  };
  const res = await supabase
    .from('users')
    .upsert(row, { onConflict: ['telegram_id'], returning: 'representation' })
    .select()
    .maybeSingle();
  if (res.error) throw res.error;
  return res.data;
}

/* --- Threads (videos) --- */
async function findOrCreateThread(link, creatorTelegramId = null) {
  if (!link) throw new Error('Missing link');
  const normalized = String(link).trim();

  // Try to find by canonical_link or social_link or normalized_link
  const { data: found, error: findErr } = await supabase
    .from('threads')
    .select('*')
    .or(`social_link.eq.${normalized},canonical_link.eq.${normalized},normalized_link.eq.${normalized}`)
    .limit(1)
    .maybeSingle();
  if (findErr) {
    console.warn('findOrCreateThread findErr', findErr);
  }
  if (found) {
    // update creator_telegram_id if provided and missing
    if (creatorTelegramId && !found.creator_telegram_id) {
      await supabase.from('threads').update({ creator_telegram_id: creatorTelegramId }).eq('id', found.id).catch(()=>null);
      found.creator_telegram_id = creatorTelegramId;
    }
    return found;
  }

  // insert new
  const insert = {
    social_link: link,
    canonical_link: null,
    normalized_link: normalized,
    provider: null,
    provider_id: null,
    creator_telegram_id: creatorTelegramId || null,
    created_at: new Date().toISOString()
  };
  const { data, error } = await supabase.from('threads').insert([insert]).select().maybeSingle();
  if (error) {
    // race: try to re-fetch
    const { data: re } = await supabase
      .from('threads')
      .select('*')
      .or(`social_link.eq.${normalized},canonical_link.eq.${normalized},normalized_link.eq.${normalized}`)
      .limit(1)
      .maybeSingle();
    if (re) return re;
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

async function listThreadsByCreator(telegramId) {
  const { data, error } = await supabase.from('threads').select('*').eq('creator_telegram_id', telegramId).order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/* --- Tracked videos helpers --- */
async function trackThread(tracker_telegram_id, thread_id) {
  if (!tracker_telegram_id || !thread_id) throw new Error('Missing args');
  const row = { tracker_telegram_id, thread_id, created_at: new Date().toISOString() };
  const { data, error } = await supabase.from('tracked_videos').upsert(row, { onConflict: ['tracker_telegram_id', 'thread_id'], returning: 'representation' }).select().maybeSingle();
  if (error) throw error;
  return data;
}

async function listTrackedByUser(tracker_telegram_id) {
  const { data, error } = await supabase
    .from('tracked_videos')
    .select('id,thread_id,created_at,threads(*)')
    .eq('tracker_telegram_id', tracker_telegram_id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  // flatten threads for convenience
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

/* --- Payments --- */
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

/* --- Voice comments --- */
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

/* --- Replies --- */
async function insertReplyRow(row) {
  // Accepts row that may or may not contain duration; ensure only known columns passed
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

/* --- Favorites --- */
async function toggleFavoriteRow(telegramId, commentId) {
  const { data: exists, error: e } = await supabase.from('favorites').select('*').eq('telegram_id', telegramId).eq('comment_id', commentId).limit(1).maybeSingle();
  if (e) throw e;
  if (exists) {
    await supabase.from('favorites').delete().eq('id', exists.id);
    return { removed: true };
  } else {
    const { data, error } = await supabase.from('favorites').insert([{ telegram_id: telegramId, comment_id: commentId }]).select().maybeSingle();
    if (error) throw error;
    return { removed: false, data };
  }
}
async function listFavoritesForUser(telegramId) {
  // return voice_comments rows
  const { data, error } = await supabase.from('favorites').select('voice_comments(*)').eq('telegram_id', telegramId);
  if (error) throw error;
  const arr = (data || []).map(r => r.voice_comments).filter(Boolean);
  return arr;
}

/* --- Reactions --- */
async function insertReactionRow(row) {
  const insertRow = Object.assign({}, row, { created_at: new Date().toISOString() });
  const { data, error } = await supabase.from('reactions').insert([insertRow]).select().maybeSingle();
  if (error) throw error;
  return data;
}

/* --- Notifications & Reports --- */
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

/* --- Deletes --- */
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
async function deleteThreadById(id) {
  try {
    const { data: comments } = await supabase.from('voice_comments').select('id').eq('thread_id', id);
    if (comments && comments.length) {
      for (const c of comments) {
        await deleteCommentById(c.id).catch(()=>null);
      }
    }
    await supabase.from('threads').delete().eq('id', id);
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
  deleteCommentById,
  deleteThreadById
};
