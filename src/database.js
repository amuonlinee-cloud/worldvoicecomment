// src/database.js
// Supabase wrapper used by bot.js — requires SUPABASE_URL and SUPABASE_KEY envs.
// Exports supabase client + helper functions used by bot.js.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY env var.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

/* ---- Helpers ---- */
async function safeMaybeSingle(query) {
  // query is a supabase query promise
  try {
    // For new supabase client patterns (returns { data, error })
    const res = await query;
    if (res && typeof res.maybeSingle === 'function') {
      // rarely used path
      return await res.maybeSingle();
    }
    return res;
  } catch (e) {
    throw e;
  }
}

/* ---- Users ---- */
async function ensureUserRow(user) {
  if (!user || !user.id) return null;
  const row = {
    telegram_id: Number(user.id),
    username: user.username || null,
    first_name: user.first_name || null,
    updated_at: new Date().toISOString()
  };
  try {
    const { data, error } = await supabase
      .from('users')
      .upsert(row, { onConflict: ['telegram_id'], returning: 'representation' })
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) {
    console.error('ensureUserRow err', e);
    throw e;
  }
}

/* ---- Threads (videos) ----
  columns used:
    id, social_link, canonical_link, provider, provider_id, creator_telegram_id, created_at
*/
async function findOrCreateThread(link, creatorTelegramId = null) {
  if (!link) throw new Error('Missing link');
  try {
    // canonicalization/normalization is done outside (utils.normalizeVideoUrl)
    // We'll search by social_link or canonical_link or provider/provider_id.
    const normalizedCanonical = String(link).trim().toLowerCase();

    // Try exact match on social_link OR canonical_link
    const { data: found1, error: e1 } = await supabase
      .from('threads')
      .select('*')
      .or(`social_link.eq.${normalizedCanonical},canonical_link.eq.${normalizedCanonical}`)
      .limit(1)
      .maybeSingle();

    if (e1) {
      // continue, but log
      console.warn('findOrCreateThread search err', e1.message || e1);
    }
    if (found1) {
      // optionally set creator_telegram_id if provided and not set
      if (creatorTelegramId && !found1.creator_telegram_id) {
        try {
          await supabase.from('threads').update({ creator_telegram_id: creatorTelegramId }).eq('id', found1.id);
          found1.creator_telegram_id = creatorTelegramId;
        } catch (uerr) { /* ignore */ }
      }
      return found1;
    }

    // Insert new thread
    const row = {
      social_link: link,
      canonical_link: null,
      provider: null,
      provider_id: null,
      creator_telegram_id: creatorTelegramId || null,
      created_at: new Date().toISOString()
    };
    const { data, error } = await supabase.from('threads').insert([row]).select().maybeSingle();
    if (error) {
      // Attempt a forgiving re-fetch (race)
      const { data: refetch } = await supabase.from('threads').select('*').or(`social_link.eq.${normalizedCanonical},canonical_link.eq.${normalizedCanonical}`).limit(1).maybeSingle();
      if (refetch) return refetch;
      throw error;
    }
    return data;
  } catch (e) {
    console.error('findOrCreateThread err', e);
    throw e;
  }
}

async function getThreadById(id) {
  if (!id) return null;
  try {
    const { data } = await supabase.from('threads').select('*').eq('id', id).limit(1).maybeSingle();
    return data || null;
  } catch (e) {
    console.error('getThreadById err', e);
    return null;
  }
}

async function listThreadsByCreator(telegramId) {
  try {
    const { data, error } = await supabase.from('threads').select('*').eq('creator_telegram_id', telegramId).order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.error('listThreadsByCreator err', e);
    throw e;
  }
}

/* ---- Payments ---- */
async function createPaymentRequest(payload) {
  try {
    const insertRow = Object.assign({ status: 'pending', created_at: new Date().toISOString() }, payload);
    const { data, error } = await supabase.from('payment_requests').insert([insertRow]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) {
    console.error('createPaymentRequest err', e);
    throw e;
  }
}

async function getPaymentById(id) {
  try {
    const { data } = await supabase.from('payment_requests').select('*').eq('id', id).limit(1).maybeSingle();
    return data || null;
  } catch (e) {
    console.error('getPaymentById err', e);
    return null;
  }
}

async function updatePaymentStatus(id, status, updates = {}) {
  try {
    const payload = Object.assign({ status }, updates);
    const { data, error } = await supabase.from('payment_requests').update(payload).eq('id', id).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) {
    console.error('updatePaymentStatus err', e);
    throw e;
  }
}

/* ---- Voice comments ---- */
async function insertVoiceComment(row) {
  try {
    const insertRow = Object.assign({}, row, { created_at: new Date().toISOString() });
    const { data, error } = await supabase.from('voice_comments').insert([insertRow]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) {
    console.error('insertVoiceComment err', e);
    throw e;
  }
}

async function listCommentsByThread(threadId, offset = 0, limit = 15) {
  try {
    const { data, error } = await supabase.from('voice_comments').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.error('listCommentsByThread err', e);
    throw e;
  }
}

async function listCommentsByUser(telegramId, limit = 100) {
  try {
    const { data, error } = await supabase.from('voice_comments').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.error('listCommentsByUser err', e);
    throw e;
  }
}

async function getCommentById(id) {
  try {
    const { data } = await supabase.from('voice_comments').select('*').eq('id', id).limit(1).maybeSingle();
    return data || null;
  } catch (e) {
    console.error('getCommentById err', e);
    return null;
  }
}

/* ---- Replies ---- */
async function insertReplyRow(row) {
  try {
    const insertRow = Object.assign({}, row, { created_at: new Date().toISOString() });
    const { data, error } = await supabase.from('replies').insert([insertRow]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) {
    console.error('insertReplyRow err', e);
    throw e;
  }
}

async function listReplies(commentId, offset = 0, limit = 50) {
  try {
    const { data, error } = await supabase.from('replies').select('*').eq('comment_id', commentId).order('created_at', { ascending: true }).range(offset, offset + limit - 1);
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.error('listReplies err', e);
    throw e;
  }
}

/* ---- Favorites ---- */
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
  } catch (e) {
    console.error('toggleFavoriteRow err', e);
    throw e;
  }
}

async function listFavoritesForUser(telegramId) {
  try {
    // Join favorites -> voice_comments
    const { data } = await supabase.from('favorites').select('voice_comments(*)').eq('telegram_id', telegramId);
    const arr = (data || []).map(r => r.voice_comments).filter(Boolean);
    return arr;
  } catch (e) {
    console.error('listFavoritesForUser err', e);
    return [];
  }
}

/* ---- Reactions ---- */
async function insertReactionRow(row) {
  try {
    const insertRow = Object.assign({}, row, { created_at: new Date().toISOString() });
    const { data, error } = await supabase.from('reactions').insert([insertRow]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) {
    console.error('insertReactionRow err', e);
    throw e;
  }
}

/* ---- Notifications & Reports ---- */
async function addNotificationRow(row) {
  try {
    const insertRow = Object.assign({}, row, { created_at: new Date().toISOString() });
    const { data, error } = await supabase.from('notifications').insert([insertRow]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) {
    console.error('addNotificationRow err', e);
    throw e;
  }
}

async function listNotifications(telegramId) {
  try {
    const { data } = await supabase.from('notifications').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(50);
    return data || [];
  } catch (e) {
    console.error('listNotifications err', e);
    return [];
  }
}

async function insertReport(row) {
  try {
    const insertRow = Object.assign({}, row, { created_at: new Date().toISOString(), status: 'open' });
    const { data, error } = await supabase.from('reports').insert([insertRow]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) {
    console.error('insertReport err', e);
    throw e;
  }
}

/* ---- Delete helpers ---- */
async function deleteCommentById(id) {
  try {
    await supabase.from('favorites').delete().eq('comment_id', id);
    await supabase.from('reactions').delete().eq('comment_id', id);
    await supabase.from('replies').delete().eq('comment_id', id);
    await supabase.from('voice_comments').delete().eq('id', id);
    return { deleted: true };
  } catch (e) {
    console.error('deleteCommentById err', e);
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
    console.error('deleteThreadById err', e);
    return { error: e };
  }
}

module.exports = {
  supabase,
  ensureUserRow,
  findOrCreateThread,
  getThreadById,
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
  listFavoritesForUser,
  insertReactionRow,
  addNotificationRow,
  listNotifications,
  insertReport,
  deleteCommentById,
  deleteThreadById
};
