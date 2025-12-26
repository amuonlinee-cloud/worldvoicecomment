// src/database.js
// Supabase wrapper used by bot.js — requires SUPABASE_URL and SUPABASE_KEY envs.
// Exports functions used by src/bot.js: ensureUserRow, findOrCreateThread, listThreadsByCreator,
// createPaymentRequest, updatePaymentStatus, insertVoiceComment, listCommentsByThread, getCommentById,
// insertReplyRow, listReplies, toggleFavoriteRow, listFavoritesForUser, insertReactionRow,
// addNotificationRow, listNotifications, insertReport, deleteCommentById, deleteThreadById, supabase

const { createClient } = require('@supabase/supabase-js');
const utils = require('./utils');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_KEY env var.');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// Helper to generate lookup candidates
function _candidates(original, normalized) {
  const set = new Set();
  if (normalized && normalized.canonicalLink) set.add(normalized.canonicalLink.toLowerCase());
  set.add(String(original).trim().replace(/[)\]\.]+$/g,'').toLowerCase());
  return Array.from(set);
}

async function ensureUserRow(user) {
  if (!user || !user.id) return null;
  try {
    const row = { telegram_id: user.id, username: user.username || null, first_name: user.first_name || null, updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from('users').upsert(row, { onConflict: ['telegram_id'] }).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) { console.error('ensureUserRow err', e && e.message); throw e; }
}

async function findOrCreateThread(link, creatorTelegramId=null) {
  if (!link) throw new Error('Missing link');
  try {
    const normalized = await utils.normalizeVideoUrl(link);
    const candidates = _candidates(link, normalized);
    // try canonical matches
    for (const cand of candidates) {
      try {
        const { data } = await supabase.from('threads').select('*').or(`canonical_link.ilike.${cand},social_link.ilike.${cand}`).limit(1).maybeSingle();
        if (data) return data;
      } catch (e) { /* continue */ }
    }
    // provider lookup
    if (normalized && normalized.provider && normalized.id) {
      try {
        const { data } = await supabase.from('threads').select('*').eq('provider', normalized.provider).eq('provider_id', String(normalized.id)).limit(1).maybeSingle();
        if (data) return data;
      } catch (e) {}
    }
    // create new
    const row = {
      social_link: link,
      canonical_link: normalized && normalized.canonicalLink ? normalized.canonicalLink : null,
      provider: normalized && normalized.provider ? normalized.provider : null,
      provider_id: normalized && normalized.id ? String(normalized.id) : null,
      creator_telegram_id: creatorTelegramId || null,
      created_at: new Date().toISOString()
    };
    const { data, error } = await supabase.from('threads').insert([row]).select().maybeSingle();
    if (error) {
      console.error('findOrCreateThread insert error', error);
      // try fetch again
      for (const cand of candidates) {
        try {
          const { data: retry } = await supabase.from('threads').select('*').or(`canonical_link.ilike.${cand},social_link.ilike.${cand}`).limit(1).maybeSingle();
          if (retry) return retry;
        } catch (e) {}
      }
      throw error;
    }
    return data;
  } catch (e) {
    console.error('findOrCreateThread err', e && (e.message || e));
    throw e;
  }
}

async function listThreadsByCreator(telegramId) {
  try {
    const { data, error } = await supabase.from('threads').select('*').eq('creator_telegram_id', telegramId).order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (e) { console.error('listThreadsByCreator err', e); throw e; }
}

// payments
async function createPaymentRequest(payload) {
  try {
    const insertRow = Object.assign({ status: 'pending', created_at: new Date().toISOString() }, payload);
    const { data, error } = await supabase.from('payment_requests').insert([insertRow]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) { console.error('createPaymentRequest err', e); throw e; }
}
async function getPaymentById(id) {
  try {
    const { data } = await supabase.from('payment_requests').select('*').eq('id', id).limit(1).maybeSingle();
    return data;
  } catch (e) { console.error('getPaymentById err', e); throw e; }
}
async function updatePaymentStatus(id, status, updates={}) {
  try {
    const payload = Object.assign({ status }, updates);
    const { data, error } = await supabase.from('payment_requests').update(payload).eq('id', id).select().maybeSingle();
    if (error) return { error };
    return { data };
  } catch (e) { console.error('updatePaymentStatus err', e); throw e; }
}

// comments
async function insertVoiceComment(row) {
  try {
    const insertRow = Object.assign({}, row, { created_at: new Date().toISOString() });
    const { data, error } = await supabase.from('voice_comments').insert([insertRow]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) { console.error('insertVoiceComment err', e); throw e; }
}

async function listCommentsByThread(threadId, offset=0, limit=15) {
  try {
    const { data, error } = await supabase.from('voice_comments').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (error) return { error };
    return { data: data || [] };
  } catch (e) { console.error('listCommentsByThread err', e); return { error: e }; }
}

async function listCommentsByUser(telegramId, limit = 100) {
  try {
    const { data } = await supabase.from('voice_comments').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(limit);
    return data || [];
  } catch (e) { console.error('listCommentsByUser err', e); throw e; }
}

async function getCommentById(id) {
  try {
    const { data } = await supabase.from('voice_comments').select('*').eq('id', id).limit(1).maybeSingle();
    return data || null;
  } catch (e) { console.error('getCommentById err', e); return null; }
}

// replies
async function insertReplyRow(row) {
  try {
    const insertRow = Object.assign({}, row, { created_at: new Date().toISOString() });
    const { data, error } = await supabase.from('replies').insert([insertRow]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) { console.error('insertReplyRow err', e); throw e; }
}
async function listReplies(commentId) {
  try {
    const { data } = await supabase.from('replies').select('*').eq('comment_id', commentId).order('created_at', { ascending: true });
    return data || [];
  } catch (e) { console.error('listReplies err', e); return []; }
}

// favorites
async function toggleFavoriteRow(telegramId, commentId) {
  try {
    const { data: exists } = await supabase.from('favorites').select('*').eq('telegram_id', telegramId).eq('comment_id', commentId).limit(1).maybeSingle();
    if (exists) {
      await supabase.from('favorites').delete().eq('id', exists.id);
      return { removed: true };
    } else {
      const { data } = await supabase.from('favorites').insert([{ telegram_id: telegramId, comment_id: commentId }]).select().maybeSingle();
      return { removed: false, data };
    }
  } catch (e) { console.error('toggleFavoriteRow err', e); throw e; }
}
async function isFavorite(telegramId, commentId) {
  try {
    const { data } = await supabase.from('favorites').select('*').eq('telegram_id', telegramId).eq('comment_id', commentId).limit(1).maybeSingle();
    return !!data;
  } catch (e) { console.error('isFavorite err', e); return false; }
}
async function listFavoritesForUser(telegramId) {
  try {
    const { data } = await supabase.from('favorites').select('voice_comments(*)').eq('telegram_id', telegramId);
    const arr = (data || []).map(r => r.voice_comments).filter(Boolean);
    return arr;
  } catch (e) { console.error('listFavoritesForUser err', e); return []; }
}

// reactions
async function insertReactionRow(row) {
  try {
    const insertRow = Object.assign({}, row, { created_at: new Date().toISOString() });
    const { data, error } = await supabase.from('reactions').insert([insertRow]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) { console.error('insertReactionRow err', e); throw e; }
}

// notifications & reports
async function addNotificationRow(row) {
  try {
    const insertRow = Object.assign({}, row, { created_at: new Date().toISOString() });
    const { data, error } = await supabase.from('notifications').insert([insertRow]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) { console.error('addNotificationRow err', e); throw e; }
}
async function listNotifications(telegramId) {
  try {
    const { data } = await supabase.from('notifications').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(50);
    return data || [];
  } catch (e) { console.error('listNotifications err', e); return []; }
}

async function insertReport(row) {
  try {
    const insertRow = Object.assign({}, row, { created_at: new Date().toISOString(), status: 'open' });
    const { data, error } = await supabase.from('reports').insert([insertRow]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) { console.error('insertReport err', e); throw e; }
}

async function deleteCommentById(id) {
  try {
    await supabase.from('voice_comments').delete().eq('id', id);
    // remove replies
    await supabase.from('replies').delete().eq('comment_id', id);
    return { deleted: true };
  } catch (e) { console.error('deleteCommentById err', e); return { error: e }; }
}
async function deleteThreadById(id) {
  try {
    await supabase.from('threads').delete().eq('id', id);
    // delete comments & replies belonging to that thread
    const { data: comments } = await supabase.from('voice_comments').select('id').eq('thread_id', id);
    if (comments && comments.length) {
      for (const c of comments) {
        await deleteCommentById(c.id);
      }
    }
    return { deleted: true };
  } catch (e) { console.error('deleteThreadById err', e); return { error: e }; }
}

module.exports = {
  supabase,
  ensureUserRow,
  findOrCreateThread,
  listThreadsByCreator,
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
  isFavorite,
  listFavoritesForUser,
  insertReactionRow,
  addNotificationRow,
  listNotifications,
  insertReport,
  deleteCommentById,
  deleteThreadById
};
