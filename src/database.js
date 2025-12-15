// src/database.js
// Supabase wrapper for World Voice Comment
// Hardened: safer client creation, graceful fallback, better logging, and guarded DB calls.

const { createClient } = require('@supabase/supabase-js');
const utils = require('./utils');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function maskKey(k) {
  if (!k) return '(none)';
  const safe = String(k);
  if (safe.length <= 6) return '****' + safe.slice(-2);
  return '****' + safe.slice(-4);
}

function getHostFromUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch (e) {
    return String(url).slice(0, 100);
  }
}

// Simple logger helper to keep logs consistent
function log(...args) {
  console.error('[database]', ...args);
}

// If env missing, export a shim that keeps the bot alive (no hard crash)
if (!SUPABASE_URL || !SUPABASE_KEY) {
  log('DIAG ERROR: Supabase env vars missing: SUPABASE_URL, SUPABASE_KEY. Exporting shim (no DB).');
  const shim = {
    supabase: null,
    ensureUserRow: async () => null,
    findOrCreateThread: async (link, creatorTelegramId = null) => ({ id: Date.now(), social_link: link, creator_telegram_id: creatorTelegramId, created_at: new Date().toISOString() }),
    createThread: async (link, creatorTelegramId = null) => ({ id: Date.now(), social_link: link, creator_telegram_id: creatorTelegramId, created_at: new Date().toISOString() }),
    getThreadByLink: async () => null,
    getThreadById: async () => null,
    createPaymentRequest: async (payload) => ({ id: Math.floor(Math.random()*100000), created_at: new Date().toISOString(), ...payload }),
    getPaymentById: async () => null,
    updatePaymentStatus: async (id, status, updates = {}) => ({ data: { id, status, ...updates } }),
    insertVoiceComment: async (p) => ({ id: Date.now(), created_at: new Date().toISOString(), ...p }),
    listCommentsByThread: async () => ({ data: [] }),
    getCommentById: async () => null,
    insertReplyRow: async (p) => ({ id: Date.now(), created_at: new Date().toISOString(), ...p }),
    listReplies: async () => [],
    toggleFavoriteRow: async () => ({ removed: false }),
    isFavorite: async () => false,
    insertReactionRow: async (p) => ({ id: Date.now(), created_at: new Date().toISOString(), ...p }),
    addNotificationRow: async (p) => ({ id: Date.now(), created_at: new Date().toISOString(), ...p }),
    listNotifications: async () => [],
    listFavoritesForUser: async () => [],
    setAdminNotifier: async () => false
  };
  module.exports = shim;
  return;
}

// Try to create client but guard against runtime errors
let supabase = null;
try {
  log('Creating Supabase client for host:', getHostFromUrl(SUPABASE_URL), 'key', maskKey(SUPABASE_KEY));
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });
} catch (e) {
  log('Supabase client creation failed:', e && (e.message || e));
  supabase = null;
}

// helper: safe runner for supabase queries to catch fetch/network errors and return logical fallbacks
async function safeRun(fn, fallback = null) {
  if (!supabase) return fallback;
  try {
    return await fn();
  } catch (e) {
    // Undici / fetch low-level error will bubble here
    log('Supabase request failed:', e && (e.stack || e.message || e));
    return fallback;
  }
}

function _buildLookupCandidates(originalLink, normalized) {
  const candidates = [];
  if (normalized && normalized.canonicalLink) candidates.push(normalized.canonicalLink);
  // normalized original (db-friendly)
  try {
    candidates.push(String(originalLink).trim().replace(/[)\]\.]+$/g, '').toLowerCase().replace(/\/$/,''));
  } catch (e) {}
  // also push normalized.canonicalLink with / removed (dedupe later)
  try {
    if (normalized && normalized.canonicalLink) candidates.push(String(normalized.canonicalLink).replace(/\/$/,''));
  } catch (e) {}
  return Array.from(new Set(candidates.filter(Boolean)));
}

async function ensureUserRow(user) {
  if (!user || !user.id) return null;
  if (!supabase) return null;
  try {
    const row = {
      telegram_id: user.id,
      username: user.username || null,
      first_name: user.first_name || null,
      created_at: new Date().toISOString()
    };
    const res = await safeRun(() => supabase.from('users').upsert(row, { onConflict: ['telegram_id'] }).select().maybeSingle(), null);
    if (!res) return null;
    // res may be { data } or direct data depending on client/version
    return res.data ? res.data : res;
  } catch (e) {
    log('ensureUserRow err', e && e.message);
    return null;
  }
}

async function findOrCreateThread(link, creatorTelegramId = null) {
  if (!link) throw new Error('Missing link');
  // If supabase unavailable, return lightweight fallback
  if (!supabase) return { id: Date.now(), social_link: link, creator_telegram_id: creatorTelegramId, created_at: new Date().toISOString() };
  try {
    let normalized;
    try { normalized = await utils.normalizeVideoUrl(link); } catch (e) { normalized = { canonicalLink: link }; }
    const provider = normalized && normalized.provider ? normalized.provider : null;
    const providerId = normalized && normalized.id ? String(normalized.id) : null;
    const candidates = _buildLookupCandidates(link, normalized);

    // Try canonical candidates
    for (const cand of candidates) {
      try {
        const res = await safeRun(() => supabase.from('threads').select('*').ilike('canonical_link', cand).limit(1).maybeSingle(), null);
        if (res) {
          const d = res.data ? res.data : res;
          if (d) return d;
        }
      } catch (e) { /* continue */ }
    }

    // Try provider/provider_id
    if (provider && providerId) {
      try {
        const res2 = await safeRun(() => supabase.from('threads').select('*').eq('provider', provider).eq('provider_id', providerId).limit(1).maybeSingle(), null);
        if (res2) {
          const d2 = res2.data ? res2.data : res2;
          if (d2) return d2;
        }
      } catch (e) { /* continue */ }
    }

    // Try social_link matches
    for (const cand of candidates) {
      try {
        const res3 = await safeRun(() => supabase.from('threads').select('*').ilike('social_link', cand).limit(1).maybeSingle(), null);
        if (res3) {
          const d3 = res3.data ? res3.data : res3;
          if (d3) return d3;
        }
      } catch (e) { /* continue */ }
    }

    // Insert new thread
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
      const inserted = await safeRun(() => supabase.from('threads').insert([insertRow]).select().maybeSingle(), null);
      if (inserted) {
        return inserted.data ? inserted.data : inserted;
      } else {
        // race-case: another process may have inserted; try fetch again by candidates
        for (const cand of candidates) {
          try {
            const re = await safeRun(() => supabase.from('threads').select('*').ilike('canonical_link', cand).limit(1).maybeSingle(), null);
            if (re && (re.data || re)) return re.data ? re.data : re;
            const re2 = await safeRun(() => supabase.from('threads').select('*').ilike('social_link', cand).limit(1).maybeSingle(), null);
            if (re2 && (re2.data || re2)) return re2.data ? re2.data : re2;
          } catch (ie) { /* ignore */ }
        }
        throw new Error('Insert failed and no existing thread found (race-case)');
      }
    } catch (e) {
      log('findOrCreateThread final insert err', e && (e.message || e));
      return { id: Date.now(), social_link: link, creator_telegram_id: creatorTelegramId, created_at: new Date().toISOString(), canonical_link: (normalized && normalized.canonicalLink) ? normalized.canonicalLink : null };
    }
  } catch (e) {
    log('findOrCreateThread err', e && (e.message || e));
    return { id: Date.now(), social_link: link, creator_telegram_id: creatorTelegramId, created_at: new Date().toISOString() };
  }
}

async function createThread(link, creatorTelegramId = null) {
  return findOrCreateThread(link, creatorTelegramId);
}

async function getThreadByLink(link) {
  if (!link) return null;
  if (!supabase) return null;
  try {
    let normalized;
    try { normalized = await utils.normalizeVideoUrl(link); } catch (e) { normalized = { canonicalLink: link }; }
    const candidates = _buildLookupCandidates(link, normalized);

    for (const cand of candidates) {
      try {
        const res = await safeRun(() => supabase.from('threads').select('*').ilike('canonical_link', cand).limit(1).maybeSingle(), null);
        if (res) return res.data ? res.data : res;
      } catch (e) { /* ignore */ }
    }

    if (normalized && normalized.provider && normalized.id) {
      try {
        const byProv = await safeRun(() => supabase.from('threads').select('*').eq('provider', normalized.provider).eq('provider_id', String(normalized.id)).limit(1).maybeSingle(), null);
        if (byProv) return byProv.data ? byProv.data : byProv;
      } catch (e) { /* ignore */ }
    }

    for (const cand of candidates) {
      try {
        const data2 = await safeRun(() => supabase.from('threads').select('*').ilike('social_link', cand).limit(1).maybeSingle(), null);
        if (data2) return data2.data ? data2.data : data2;
      } catch (e) { /* ignore */ }
    }
    return null;
  } catch (e) {
    log('getThreadByLink err', e && e.message);
    return null;
  }
}

async function getThreadById(id) {
  if (!id) return null;
  if (!supabase) return null;
  try {
    const res = await safeRun(() => supabase.from('threads').select('*').eq('id', id).limit(1).maybeSingle(), null);
    return res ? (res.data ? res.data : res) : null;
  } catch (e) { log('getThreadById err', e && e.message); return null; }
}

async function createPaymentRequest(payload) {
  if (!supabase) {
    return Object.assign({ id: Math.floor(Math.random()*100000), created_at: new Date().toISOString() }, payload);
  }
  try {
    const row = Object.assign({
      status: 'pending',
      created_at: new Date().toISOString()
    }, payload);
    const res = await safeRun(() => supabase.from('payment_requests').insert([row]).select().maybeSingle(), null);
    return res ? (res.data ? res.data : res) : Object.assign({ id: Math.floor(Math.random()*100000), created_at: new Date().toISOString() }, payload);
  } catch (e) { log('createPaymentRequest err', e && e.message); throw e; }
}

async function getPaymentById(id) {
  if (!id) return null;
  if (!supabase) return null;
  try {
    const res = await safeRun(() => supabase.from('payment_requests').select('*').eq('id', id).limit(1).maybeSingle(), null);
    return res ? (res.data ? res.data : res) : null;
  } catch (e) { log('getPaymentById err', e && e.message); return null; }
}

async function updatePaymentStatus(id, status, updates = {}) {
  if (!id) throw new Error('Missing payment id');
  if (!supabase) return { data: { id, status } };
  try {
    const payload = Object.assign({ status }, updates);
    const res = await safeRun(() => supabase.from('payment_requests').update(payload).eq('id', id).select().maybeSingle(), null);
    if (!res) return { error: new Error('update failed') };
    return { data: res.data ? res.data : res };
  } catch (e) { log('updatePaymentStatus err', e && e.message); throw e; }
}

async function insertVoiceComment(payload) {
  if (!supabase) {
    return Object.assign({ id: Date.now(), created_at: new Date().toISOString() }, payload);
  }
  try {
    const insertRow = Object.assign({}, payload, { created_at: new Date().toISOString() });
    const res = await safeRun(() => supabase.from('voice_comments').insert([insertRow]).select().maybeSingle(), null);
    return res ? (res.data ? res.data : res) : Object.assign({ id: Date.now(), created_at: new Date().toISOString() }, payload);
  } catch (e) { log('insertVoiceComment err', e && e.message); throw e; }
}

async function listCommentsByThread(threadId, offset = 0, limit = 15) {
  if (!threadId) return { data: [] };
  if (!supabase) return { data: [] };
  try {
    const res = await safeRun(() => supabase.from('voice_comments').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).range(offset, offset + limit - 1), null);
    if (!res) return { data: [] };
    const d = res.data ? res.data : res;
    return { data: d || [] };
  } catch (e) { log('listCommentsByThread err', e && e.message); return { error: e }; }
}

async function getCommentById(id) {
  if (!id) return null;
  if (!supabase) return null;
  try {
    const res = await safeRun(() => supabase.from('voice_comments').select('*').eq('id', id).limit(1).maybeSingle(), null);
    return res ? (res.data ? res.data : res) : null;
  } catch (e) { log('getCommentById err', e && e.message); return null; }
}

async function insertReplyRow(payload) {
  if (!supabase) return Object.assign({ id: Date.now(), created_at: new Date().toISOString() }, payload);
  try {
    const row = Object.assign({}, payload, { created_at: new Date().toISOString() });
    const res = await safeRun(() => supabase.from('replies').insert([row]).select().maybeSingle(), null);
    return res ? (res.data ? res.data : res) : Object.assign({ id: Date.now(), created_at: new Date().toISOString() }, payload);
  } catch (e) { log('insertReplyRow err', e && e.message); throw e; }
}

async function listReplies(commentId) {
  if (!commentId) return [];
  if (!supabase) return [];
  try {
    const res = await safeRun(() => supabase.from('replies').select('*').eq('comment_id', commentId).order('created_at', { ascending: true }), null);
    return res ? (res.data ? res.data : res) : [];
  } catch (e) { log('listReplies err', e && e.message); return []; }
}

async function toggleFavoriteRow(telegramId, commentId) {
  if (!telegramId || !commentId) return { removed: false };
  if (!supabase) return { removed: false };
  try {
    const exists = await safeRun(() => supabase.from('favorites').select('*').eq('telegram_id', telegramId).eq('comment_id', commentId).limit(1).maybeSingle(), null);
    const ex = exists ? (exists.data ? exists.data : exists) : null;
    if (ex) {
      await safeRun(() => supabase.from('favorites').delete().eq('id', ex.id), null);
      return { removed: true };
    } else {
      const res = await safeRun(() => supabase.from('favorites').insert([{ telegram_id: telegramId, comment_id: commentId }]).select().maybeSingle(), null);
      return { removed: false, data: res ? (res.data ? res.data : res) : null };
    }
  } catch (e) { log('toggleFavoriteRow err', e && e.message); throw e; }
}

async function isFavorite(telegramId, commentId) {
  if (!telegramId || !commentId) return false;
  if (!supabase) return false;
  try {
    const res = await safeRun(() => supabase.from('favorites').select('*').eq('telegram_id', telegramId).eq('comment_id', commentId).limit(1).maybeSingle(), null);
    const d = res ? (res.data ? res.data : res) : null;
    return !!d;
  } catch (e) { log('isFavorite err', e && e.message); return false; }
}

async function insertReactionRow(payload) {
  if (!supabase) return Object.assign({ id: Date.now(), created_at: new Date().toISOString() }, payload);
  try {
    const row = Object.assign({}, payload, { created_at: new Date().toISOString() });
    const res = await safeRun(() => supabase.from('reactions').insert([row]).select().maybeSingle(), null);
    return res ? (res.data ? res.data : res) : Object.assign({ id: Date.now(), created_at: new Date().toISOString() }, payload);
  } catch (e) { log('insertReactionRow err', e && e.message); throw e; }
}

async function addNotificationRow(payload) {
  if (!supabase) return Object.assign({ id: Date.now(), created_at: new Date().toISOString() }, payload);
  try {
    const row = Object.assign({}, payload, { created_at: new Date().toISOString() });
    const res = await safeRun(() => supabase.from('notifications').insert([row]).select().maybeSingle(), null);
    return res ? (res.data ? res.data : res) : row;
  } catch (e) { log('addNotificationRow err', e && e.message); throw e; }
}

async function listNotifications(telegramId) {
  if (!telegramId) return [];
  if (!supabase) return [];
  try {
    const res = await safeRun(() => supabase.from('notifications').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(50), null);
    return res ? (res.data ? res.data : res) : [];
  } catch (e) { log('listNotifications err', e && e.message); return []; }
}

async function listFavoritesForUser(telegramId) {
  if (!telegramId) return [];
  if (!supabase) return [];
  try {
    const res = await safeRun(() => supabase.from('favorites').select('id, comment_id, created_at, voice_comments( id, thread_id, telegram_file_id, first_name, username, created_at )').eq('telegram_id', telegramId).order('created_at', { ascending: false }), null);
    const data = res ? (res.data ? res.data : res) : [];
    const rows = (data || []).map(r => r.voice_comments || null).filter(Boolean);
    return rows;
  } catch (e) { log('listFavoritesForUser err', e && e.message); return []; }
}

async function setAdminNotifier(text, extra={}) {
  if (!supabase) return false;
  try {
    await safeRun(() => supabase.from('admin_logs').insert([{ message: text, meta: extra, created_at: new Date().toISOString() }]), null);
    return true;
  } catch (e) { log('setAdminNotifier err', e && e.message); return false; }
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
  listNotifications,
  listFavoritesForUser,
  setAdminNotifier
};
