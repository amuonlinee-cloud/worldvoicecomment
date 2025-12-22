// src/database.js
// Supabase wrapper for World Voice Comment
// Improved: robust findOrCreateThread using normalization and safe fallbacks.

const { createClient } = require('@supabase/supabase-js');
const utils = require('./utils');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('DIAG ERROR: Supabase env vars missing: SUPABASE_URL, SUPABASE_KEY. Add them to your .env or host env.');
  // export minimal API so bot can start (but persistence won't work)
  module.exports = {
    supabase: null,
    ensureUserRow: async () => null,
    findOrCreateThread: async (link, creator) => ({ id: Date.now(), social_link: link, creator_telegram_id: creator, created_at: new Date().toISOString(), canonical_link: link }),
    getThreadById: async (id) => null,
    getThreadByLink: async (link) => null,
    createPaymentRequest: async (payload) => Object.assign({ id: Math.floor(Math.random()*100000), created_at: new Date().toISOString() }, payload),
    getPaymentById: async () => null,
    updatePaymentStatus: async () => ({ data: null }),
    insertVoiceComment: async (p) => Object.assign({ id: Date.now(), created_at: new Date().toISOString() }, p),
    listCommentsByThread: async () => ({ data: [] }),
    getCommentById: async () => null,
    insertReplyRow: async (p) => Object.assign({ id: Date.now(), created_at: new Date().toISOString() }, p),
    listReplies: async () => [],
    toggleFavoriteRow: async () => ({ removed: false }),
    listFavoritesForUser: async () => [],
    insertReactionRow: async (p) => Object.assign({ id: Date.now(), created_at: new Date().toISOString() }, p),
    isFavorite: async () => false,
    addNotificationRow: async () => ({})
  };
  return;
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

function _buildLookupCandidates(originalLink, normalized) {
  const candidates = [];
  if (normalized && normalized.canonicalLink) candidates.push(normalized.canonicalLink);
  try {
    candidates.push(String(originalLink).trim().replace(/[)\]\.]+$/g, '').toLowerCase().replace(/\/$/,''));
  } catch (e) {}
  try {
    if (normalized && normalized.canonicalLink) candidates.push(String(normalized.canonicalLink).replace(/\/$/,''));
  } catch (e) {}
  return Array.from(new Set(candidates.filter(Boolean)));
}

async function ensureUserRow(user) {
  if (!user || !user.id) return null;
  try {
    const row = {
      telegram_id: user.id,
      username: user.username || null,
      first_name: user.first_name || null,
      created_at: new Date().toISOString()
    };
    const { data, error } = await supabase.from('users').upsert(row, { onConflict: ['telegram_id'] }).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) {
    console.error('ensureUserRow err', e && e.message);
    throw e;
  }
}

async function findOrCreateThread(link, creatorTelegramId = null) {
  if (!link) throw new Error('Missing link');
  try {
    let normalized;
    try { normalized = await utils.normalizeVideoUrl(link); } catch (e) { normalized = { canonicalLink: link }; }
    const provider = normalized && normalized.provider ? normalized.provider : null;
    const providerId = normalized && normalized.id ? String(normalized.id) : null;

    const candidates = _buildLookupCandidates(link, normalized);

    // Try canonical_link candidates (if column exists). If the column is missing, the query will error - catch and continue.
    for (const cand of candidates) {
      try {
        const { data: found, error } = await supabase.from('threads').select('*').ilike('canonical_link', cand).limit(1).maybeSingle();
        if (error) {
          console.error('findOrCreateThread canonical lookup candidate err', (error && (error.message || error)) || error);
          continue;
        }
        if (found) return found;
      } catch (e) {
        console.error('findOrCreateThread canonical lookup caught err', e && e.message);
      }
    }

    // Try provider + provider_id (if available)
    if (provider && providerId) {
      try {
        const { data: found2, error: e2 } = await supabase.from('threads').select('*').eq('provider', provider).eq('provider_id', providerId).limit(1).maybeSingle();
        if (!e2 && found2) return found2;
      } catch (e) {
        console.error('findOrCreateThread provider lookup err', e && e.message);
      }
    }

    // Try social_link matches (case-insensitive)
    for (const cand of candidates) {
      try {
        const { data: found3, error: e3 } = await supabase.from('threads').select('*').ilike('social_link', cand).limit(1).maybeSingle();
        if (e3) {
          console.error('findOrCreateThread social_link candidate err', e3 && e3.message);
          continue;
        }
        if (found3) return found3;
      } catch (e) {
        console.error('findOrCreateThread social_link caught err', e && e.message);
      }
    }

    // If we reach here, try to insert a new thread row
    const insertRow = {
      social_link: link,
      canonical_link: (normalized && normalized.canonicalLink) ? normalized.canonicalLink : null,
      provider: provider || null,
      provider_id: providerId || null,
      creator_telegram_id: creatorTelegramId || null,
      normalized_link: (normalized && normalized.canonicalLink) ? normalized.canonicalLink : null,
      created_at: new Date().toISOString()
    };

    try {
      const { data, error } = await supabase.from('threads').insert([insertRow]).select().maybeSingle();
      if (error) {
        console.error('findOrCreateThread insert error, will try to fetch existing:', error && (error.message || error));
        for (const cand of candidates) {
          try {
            const { data: re } = await supabase.from('threads').select('*').ilike('canonical_link', cand).limit(1).maybeSingle();
            if (re) return re;
            const { data: re2 } = await supabase.from('threads').select('*').ilike('social_link', cand).limit(1).maybeSingle();
            if (re2) return re2;
          } catch (innerErr) { }
        }
        throw error;
      }
      return data;
    } catch (e) {
      console.error('findOrCreateThread final insert err', e && e.message);
      return { id: Date.now(), social_link: link, creator_telegram_id: creatorTelegramId, created_at: new Date().toISOString(), canonical_link: (normalized && normalized.canonicalLink) ? normalized.canonicalLink : null };
    }
  } catch (e) {
    console.error('findOrCreateThread err', e && e.message);
    return { id: Date.now(), social_link: link, creator_telegram_id: creatorTelegramId, created_at: new Date().toISOString() };
  }
}

async function createThread(link, creatorTelegramId = null) {
  return findOrCreateThread(link, creatorTelegramId);
}

async function getThreadByLink(link) {
  if (!link) return null;
  try {
    let normalized;
    try { normalized = await utils.normalizeVideoUrl(link); } catch (e) { normalized = { canonicalLink: link }; }
    const candidates = _buildLookupCandidates(link, normalized);

    for (const cand of candidates) {
      try {
        const { data } = await supabase.from('threads').select('*').ilike('canonical_link', cand).limit(1).maybeSingle();
        if (data) return data;
      } catch (e) {
        console.error('getThreadByLink canonical candidate err', e && e.message);
      }
    }

    if (normalized && normalized.provider && normalized.id) {
      try {
        const { data: byProv } = await supabase.from('threads').select('*').eq('provider', normalized.provider).eq('provider_id', String(normalized.id)).limit(1).maybeSingle();
        if (byProv) return byProv;
      } catch (e) { console.error('getThreadByLink provider lookup err', e && e.message); }
    }

    for (const cand of candidates) {
      try {
        const { data: data2 } = await supabase.from('threads').select('*').ilike('social_link', cand).limit(1).maybeSingle();
        if (data2) return data2;
      } catch (e) { console.error('getThreadByLink social candidate err', e && e.message); }
    }

    return null;
  } catch (e) {
    console.error('getThreadByLink err', e && e.message);
    return null;
  }
}

async function getThreadById(id) {
  if (!id) return null;
  try {
    const { data } = await supabase.from('threads').select('*').eq('id', id).limit(1).maybeSingle();
    return data || null;
  } catch (e) { console.error('getThreadById err', e && e.message); return null; }
}

/* Payments, comments, replies, favorites, reactions — wrappers */
async function createPaymentRequest(payload) {
  try {
    const row = Object.assign({ status: 'pending', created_at: new Date().toISOString() }, payload);
    const { data, error } = await supabase.from('payment_requests').insert([row]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) { console.error('createPaymentRequest err', e && e.message); throw e; }
}
async function getPaymentById(id) {
  if (!id) return null;
  try {
    const { data } = await supabase.from('payment_requests').select('*').eq('id', id).limit(1).maybeSingle();
    return data || null;
  } catch (e) { console.error('getPaymentById err', e && e.message); return null; }
}
async function updatePaymentStatus(id, status, updates = {}) {
  if (!id) throw new Error('Missing payment id');
  try {
    const payload = Object.assign({ status }, updates);
    const { data, error } = await supabase.from('payment_requests').update(payload).eq('id', id).select().maybeSingle();
    if (error) return { error };
    return { data };
  } catch (e) { console.error('updatePaymentStatus err', e && e.message); throw e; }
}

async function insertVoiceComment(payload) {
  try {
    const insertRow = Object.assign({}, payload, { created_at: new Date().toISOString() });
    const { data, error } = await supabase.from('voice_comments').insert([insertRow]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) { console.error('insertVoiceComment err', e && e.message); throw e; }
}

async function listCommentsByThread(threadId, offset = 0, limit = 15) {
  if (!threadId) return { data: [] };
  try {
    const { data, error } = await supabase.from('voice_comments').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (error) return { error };
    return { data: data || [] };
  } catch (e) { console.error('listCommentsByThread err', e && e.message); return { error: e }; }
}

async function getCommentById(id) {
  if (!id) return null;
  try {
    const { data } = await supabase.from('voice_comments').select('*').eq('id', id).limit(1).maybeSingle();
    return data || null;
  } catch (e) { console.error('getCommentById err', e && e.message); return null; }
}

async function insertReplyRow(payload) {
  try {
    const row = Object.assign({}, payload, { created_at: new Date().toISOString() });
    const { data, error } = await supabase.from('replies').insert([row]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) { console.error('insertReplyRow err', e && e.message); throw e; }
}

async function listReplies(commentId) {
  if (!commentId) return [];
  try {
    const { data } = await supabase.from('replies').select('*').eq('comment_id', commentId).order('created_at', { ascending: true });
    return data || [];
  } catch (e) { console.error('listReplies err', e && e.message); return []; }
}

async function toggleFavoriteRow(telegramId, commentId) {
  if (!telegramId || !commentId) return { removed: false };
  try {
    const { data: exists } = await supabase.from('favorites').select('*').eq('telegram_id', telegramId).eq('comment_id', commentId).limit(1).maybeSingle();
    if (exists) {
      await supabase.from('favorites').delete().eq('id', exists.id);
      return { removed: true };
    } else {
      const { data } = await supabase.from('favorites').insert([{ telegram_id: telegramId, comment_id: commentId }]).select().maybeSingle();
      return { removed: false, data };
    }
  } catch (e) { console.error('toggleFavoriteRow err', e && e.message); throw e; }
}

async function isFavorite(telegramId, commentId) {
  if (!telegramId || !commentId) return false;
  try {
    const { data } = await supabase.from('favorites').select('*').eq('telegram_id', telegramId).eq('comment_id', commentId).limit(1).maybeSingle();
    return !!data;
  } catch (e) { console.error('isFavorite err', e && e.message); return false; }
}

async function insertReactionRow(payload) {
  try {
    const row = Object.assign({}, payload, { created_at: new Date().toISOString() });
    const { data, error } = await supabase.from('reactions').insert([row]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) { console.error('insertReactionRow err', e && e.message); throw e; }
}

async function addNotificationRow(payload) {
  try {
    const row = Object.assign({}, payload, { created_at: new Date().toISOString() });
    const { data, error } = await supabase.from('notifications').insert([row]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) { console.error('addNotificationRow err', e && e.message); throw e; }
}

async function listNotifications(telegramId) {
  if (!telegramId) return [];
  try {
    const { data } = await supabase.from('notifications').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(50);
    return data || [];
  } catch (e) { console.error('listNotifications err', e && e.message); return []; }
}

module.exports = {
  supabase,
  ensureUserRow,
  findOrCreateThread,
  createThread,
  getThreadByLink,
  getThreadById,
  createPaymentRequest,
  getPaymentById,
  updatePaymentStatus,
  insertVoiceComment,
  listCommentsByThread,
  getCommentById,
  insertReplyRow,
  listReplies,
  toggleFavoriteRow,
  isFavorite,
  insertReactionRow,
  addNotificationRow,
  listNotifications
};
