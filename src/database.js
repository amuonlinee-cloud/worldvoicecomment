// src/database.js
// Supabase wrapper with an in-memory fallback when env is missing.
// Adds user balance helpers, listing helpers and setThreadCreator so bot.js doesn't touch supabase directly.

const utils = require('./utils');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const DISABLE_SUPABASE = (process.env.DISABLE_SUPABASE || '').toLowerCase() === 'true';

let useSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY && !DISABLE_SUPABASE);
let _supabase = null;

function markFallback(reason) {
  if (useSupabase) {
    console.error('[database] Supabase failing: switching to in-memory fallback. Reason:', reason && (reason.message || reason));
  }
  useSupabase = false;
  _supabase = null;
}

// In-memory fallback state
const state = {
  users: new Map(),
  threads: new Map(),
  threadsByLink: new Map(),
  voice_comments: new Map(),
  replies: new Map(),
  payment_requests: new Map(),
  favorites: new Map(),
  reactions: new Map(),
  notifications: new Map(),
  counters: { thread: 1000, comment: 10000, reply: 50000, payment: 90000 }
};

function nextId(kind) {
  const c = state.counters;
  if (kind === 'thread') return ++c.thread;
  if (kind === 'comment') return ++c.comment;
  if (kind === 'reply') return ++c.reply;
  if (kind === 'payment') return ++c.payment;
  return Date.now();
}
function _normalizeLinkForKey(l) {
  if (!l) return l;
  try { return String(l).trim().replace(/[)\]\.]+$/g, '').toLowerCase().replace(/\/$/,''); } catch (e) { return String(l); }
}

// Mem-only helpers for users (free_comments)
function _ensureMemUser(telegramId, userObj = {}) {
  const key = String(telegramId);
  let u = state.users.get(key);
  if (!u) {
    u = Object.assign({ telegram_id: telegramId, username: null, first_name: null, free_comments: 0, created_at: new Date().toISOString() }, userObj);
    state.users.set(key, u);
  } else {
    // merge
    Object.assign(u, userObj);
    state.users.set(key, u);
  }
  return u;
}

// Build an in-memory API (same signatures as supabase-backed functions)
const mem = {
  supabase: null,

  ensureUserRow: async (user) => {
    if (!user || !user.id) return null;
    const obj = _ensureMemUser(user.id, { username: user.username || null, first_name: user.first_name || null });
    return obj;
  },

  getUserByTelegramId: async (telegramId) => {
    if (!telegramId) return null;
    const key = String(telegramId);
    return state.users.get(key) || null;
  },

  getUserBalance: async (telegramId) => {
    if (!telegramId) return 0;
    const u = state.users.get(String(telegramId));
    if (!u) return 0;
    return Number(u.free_comments || 0);
  },

  creditUser: async (telegramId, amount) => {
    if (!telegramId) return null;
    const cur = _ensureMemUser(telegramId);
    const next = Number(cur.free_comments || 0) + Number(amount || 0);
    cur.free_comments = next;
    state.users.set(String(telegramId), cur);
    return cur;
  },

  decrementUserBalance: async (telegramId, amount) => {
    if (!telegramId) return { error: 'missing telegram id' };
    const cur = _ensureMemUser(telegramId);
    const current = Number(cur.free_comments || 0);
    const dec = Number(amount || 1);
    if (current < dec) return { error: 'insufficient' };
    cur.free_comments = current - dec;
    state.users.set(String(telegramId), cur);
    return { data: cur };
  },

  findOrCreateThread: async (link, creatorTelegramId = null) => {
    const normalized = await (async () => { try { return await utils.normalizeVideoUrl(link); } catch (e) { return { canonicalLink: link }; } })();
    const cand = (normalized && normalized.canonicalLink) ? normalized.canonicalLink : _normalizeLinkForKey(link);
    const key = _normalizeLinkForKey(cand || link);
    if (state.threadsByLink.has(key)) {
      const id = state.threadsByLink.get(key);
      const t = state.threads.get(id);
      // if owner provided and not set, set it
      if (creatorTelegramId && (!t.creator_telegram_id || t.creator_telegram_id !== creatorTelegramId)) {
        t.creator_telegram_id = creatorTelegramId;
        state.threads.set(id, t);
      }
      return t;
    }
    const id = nextId('thread');
    const item = { id, social_link: link, canonical_link: (normalized && normalized.canonicalLink) ? normalized.canonicalLink : null, provider: normalized && normalized.provider ? normalized.provider : null, provider_id: normalized && normalized.id ? String(normalized.id) : null, creator_telegram_id: creatorTelegramId || null, created_at: new Date().toISOString() };
    state.threads.set(id, item);
    state.threadsByLink.set(key, id);
    return item;
  },

  getThreadByLink: async (link) => {
    if (!link) return null;
    let normalized;
    try { normalized = await utils.normalizeVideoUrl(link); } catch (e) { normalized = { canonicalLink: link }; }
    const cand = (normalized && normalized.canonicalLink) ? normalized.canonicalLink : _normalizeLinkForKey(link);
    const key = _normalizeLinkForKey(cand);
    if (state.threadsByLink.has(key)) {
      return state.threads.get(state.threadsByLink.get(key));
    }
    return null;
  },

  getThreadById: async (id) => {
    return state.threads.get(Number(id)) || null;
  },

  setThreadCreator: async (threadId, telegramId) => {
    const t = state.threads.get(Number(threadId));
    if (!t) return null;
    t.creator_telegram_id = telegramId;
    state.threads.set(Number(threadId), t);
    return t;
  },

  listThreadsByCreator: async (telegramId) => {
    const arr = Array.from(state.threads.values()).filter(t => Number(t.creator_telegram_id) === Number(telegramId));
    return arr.sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
  },

  createPaymentRequest: async (payload) => {
    const id = nextId('payment');
    const row = Object.assign({ id, status: 'pending', created_at: new Date().toISOString() }, payload);
    state.payment_requests.set(Number(id), row);
    return row;
  },

  getPaymentById: async (id) => {
    return state.payment_requests.get(Number(id)) || null;
  },

  updatePaymentStatus: async (id, status, updates = {}) => {
    const pid = Number(id);
    const existing = state.payment_requests.get(pid);
    if (!existing) return { error: 'not found' };
    const updated = Object.assign({}, existing, updates, { status });
    state.payment_requests.set(pid, updated);
    return { data: updated };
  },

  insertVoiceComment: async (payload) => {
    const id = nextId('comment');
    const row = Object.assign({}, payload, { id, created_at: new Date().toISOString() });
    state.voice_comments.set(id, row);
    return row;
  },

  listCommentsByThread: async (threadId, offset = 0, limit = 15) => {
    if (!threadId) return { data: [] };
    const arr = Array.from(state.voice_comments.values()).filter(c => Number(c.thread_id) === Number(threadId)).sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
    const slice = arr.slice(offset, offset + limit);
    return { data: slice };
  },

  listCommentsByUser: async (telegramId, limit = 30) => {
    const arr = Array.from(state.voice_comments.values()).filter(c => Number(c.telegram_id) === Number(telegramId)).sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
    return arr.slice(0, limit);
  },

  getCommentById: async (id) => {
    return state.voice_comments.get(Number(id)) || null;
  },

  insertReplyRow: async (payload) => {
    const id = nextId('reply');
    const row = Object.assign({}, payload, { id, created_at: new Date().toISOString() });
    state.replies.set(id, row);
    return row;
  },

  listReplies: async (commentId) => {
    return Array.from(state.replies.values()).filter(r => Number(r.comment_id) === Number(commentId)).sort((a,b)=> new Date(a.created_at) - new Date(b.created_at));
  },

  toggleFavoriteRow: async (telegramId, commentId) => {
    const key = `${telegramId}:${commentId}`;
    if (state.favorites.has(key)) { state.favorites.delete(key); return { removed: true }; }
    state.favorites.set(key, { telegram_id: telegramId, comment_id: commentId, created_at: new Date().toISOString() });
    return { removed: false, data: { telegram_id: telegramId, comment_id: commentId } };
  },

  isFavorite: async (telegramId, commentId) => {
    return state.favorites.has(`${telegramId}:${commentId}`);
  },

  insertReactionRow: async (payload) => {
    const id = Date.now();
    const row = Object.assign({}, payload, { id, created_at: new Date().toISOString() });
    state.reactions.set(row.id, row);
    return row;
  },

  listFavoritesForUser: async (telegramId) => {
    const items = Array.from(state.favorites.values()).filter(f => Number(f.telegram_id) === Number(telegramId));
    const result = (items || []).map(f => state.voice_comments.get(Number(f.comment_id))).filter(Boolean);
    return result;
  },

  addNotificationRow: async (payload) => {
    const id = Date.now();
    const row = Object.assign({}, payload, { id, created_at: new Date().toISOString() });
    state.notifications.set(id, row);
    return { data: row };
  },

  listNotifications: async (telegramId) => {
    const items = Array.from(state.notifications.values()).filter(n => Number(n.telegram_id) === Number(telegramId)).sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
    return { data: items };
  },

  setAdminNotifier: async (text, meta) => {
    const id = Date.now();
    state.notifications.set(id, { id, telegram_id: null, message: text, meta: meta || {}, created_at: new Date().toISOString() });
  }
};

// If supabase envs present, create client
if (useSupabase) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    _supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  } catch (e) {
    console.error('[database] could not create supabase client — using in-memory fallback.', e && (e.stack || e.message));
    markFallback(e);
  }
}

// Helper to detect network/fetch errors and switch to fallback
function isNetworkError(err) {
  if (!err) return false;
  const m = String(err && (err.message || err));
  return m.toLowerCase().includes('fetch failed') || m.toLowerCase().includes('network') || m.toLowerCase().includes('undici');
}

// Wrapper that attempts supabase, but on network/fetch failure switches to fallback for subsequent calls
const api = {
  supabase: _supabase,

  ensureUserRow: async (user) => {
    if (!useSupabase || !api.supabase) return mem.ensureUserRow(user);
    try {
      const row = { telegram_id: user.id, username: user.username || null, first_name: user.first_name || null, created_at: new Date().toISOString() };
      const { data, error } = await api.supabase.from('users').upsert(row, { onConflict: ['telegram_id'] }).select().maybeSingle();
      if (error) throw error;
      return data;
    } catch (err) {
      if (isNetworkError(err)) markFallback(err);
      console.error('[database] ensureUserRow supabase err', err && (err.message || err));
      return mem.ensureUserRow(user);
    }
  },

  getUserByTelegramId: async (telegramId) => {
    if (!useSupabase || !api.supabase) return mem.getUserByTelegramId(telegramId);
    try {
      const { data, error } = await api.supabase.from('users').select('*').eq('telegram_id', telegramId).limit(1).maybeSingle();
      if (error) throw error;
      return data || null;
    } catch (err) {
      console.error('[database] getUserByTelegramId supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.getUserByTelegramId(telegramId);
    }
  },

  getUserBalance: async (telegramId) => {
    if (!useSupabase || !api.supabase) return mem.getUserBalance(telegramId);
    try {
      const { data, error } = await api.supabase.from('users').select('free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
      if (error) throw error;
      return Number((data && data.free_comments) || 0);
    } catch (err) {
      console.error('[database] getUserBalance supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.getUserBalance(telegramId);
    }
  },

  creditUser: async (telegramId, amount) => {
    if (!useSupabase || !api.supabase) return mem.creditUser(telegramId, amount);
    try {
      const { data: existing } = await api.supabase.from('users').select('telegram_id,free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
      if (!existing) {
        const { data } = await api.supabase.from('users').insert([{ telegram_id: telegramId, free_comments: amount }]).select().maybeSingle();
        return data;
      } else {
        const current = Number(existing.free_comments || 0);
        const next = current + Number(amount || 0);
        const { data } = await api.supabase.from('users').update({ free_comments: next }).eq('telegram_id', telegramId).select().maybeSingle();
        return data;
      }
    } catch (err) {
      console.error('[database] creditUser supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.creditUser(telegramId, amount);
    }
  },

  decrementUserBalance: async (telegramId, amount) => {
    if (!useSupabase || !api.supabase) return mem.decrementUserBalance(telegramId, amount);
    try {
      const { data } = await api.supabase.from('users').select('free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
      if (!data) {
        return { error: 'not found or zero' };
      }
      const current = Number(data.free_comments || 0);
      const dec = Number(amount || 1);
      if (current < dec) return { error: 'insufficient' };
      const next = current - dec;
      const { data: upd, error: uerr } = await api.supabase.from('users').update({ free_comments: next }).eq('telegram_id', telegramId).select().maybeSingle();
      if (uerr) return { error: uerr };
      return { data: upd };
    } catch (err) {
      console.error('[database] decrementUserBalance supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.decrementUserBalance(telegramId, amount);
    }
  },

  findOrCreateThread: async (link, creatorTelegramId = null) => {
    if (!useSupabase || !api.supabase) return mem.findOrCreateThread(link, creatorTelegramId);
    try {
      let normalized;
      try { normalized = await utils.normalizeVideoUrl(link); } catch (e) { normalized = { canonicalLink: link }; }
      const provider = normalized && normalized.provider ? normalized.provider : null;
      const providerId = normalized && normalized.id ? String(normalized.id) : null;
      const candidates = [];
      if (normalized && normalized.canonicalLink) candidates.push(normalized.canonicalLink);
      try { candidates.push(String(link).trim().replace(/[)\]\.]+$/g, '').toLowerCase().replace(/\/$/,'')); } catch (e) {}
      if (normalized && normalized.canonicalLink) candidates.push(String(normalized.canonicalLink).replace(/\/$/,''));
      const uniq = Array.from(new Set(candidates.filter(Boolean)));

      for (const cand of uniq) {
        try {
          const { data } = await api.supabase.from('threads').select('*').ilike('canonical_link', cand).limit(1).maybeSingle();
          if (data) {
            // ensure creator if provided
            if (creatorTelegramId && (!data.creator_telegram_id || data.creator_telegram_id !== creatorTelegramId)) {
              try { await api.supabase.from('threads').update({ creator_telegram_id: creatorTelegramId }).eq('id', data.id); } catch (e) {}
              data.creator_telegram_id = creatorTelegramId;
            }
            return data;
          }
        } catch (e) { /* ignore per-candidate */ }
      }

      if (provider && providerId) {
        try {
          const { data } = await api.supabase.from('threads').select('*').eq('provider', provider).eq('provider_id', providerId).limit(1).maybeSingle();
          if (data) {
            if (creatorTelegramId && (!data.creator_telegram_id || data.creator_telegram_id !== creatorTelegramId)) {
              try { await api.supabase.from('threads').update({ creator_telegram_id: creatorTelegramId }).eq('id', data.id); } catch (e) {}
              data.creator_telegram_id = creatorTelegramId;
            }
            return data;
          }
        } catch (e) {}
      }

      for (const cand of uniq) {
        try {
          const { data } = await api.supabase.from('threads').select('*').ilike('social_link', cand).limit(1).maybeSingle();
          if (data) {
            if (creatorTelegramId && (!data.creator_telegram_id || data.creator_telegram_id !== creatorTelegramId)) {
              try { await api.supabase.from('threads').update({ creator_telegram_id: creatorTelegramId }).eq('id', data.id); } catch (e) {}
              data.creator_telegram_id = creatorTelegramId;
            }
            return data;
          }
        } catch (e) {}
      }

      const insertRow = {
        social_link: link,
        canonical_link: (normalized && normalized.canonicalLink) ? normalized.canonicalLink : null,
        provider: provider || null,
        provider_id: providerId || null,
        creator_telegram_id: creatorTelegramId || null,
        normalized_link: (normalized && normalized.canonicalLink) ? normalized.canonicalLink : null,
        created_at: new Date().toISOString()
      };
      const { data, error } = await api.supabase.from('threads').insert([insertRow]).select().maybeSingle();
      if (error) throw error;
      return data;
    } catch (err) {
      console.error('[database] findOrCreateThread supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.findOrCreateThread(link, creatorTelegramId);
    }
  },

  getThreadByLink: async (link) => {
    if (!useSupabase || !api.supabase) return mem.getThreadByLink(link);
    try {
      let normalized;
      try { normalized = await utils.normalizeVideoUrl(link); } catch (e) { normalized = { canonicalLink: link }; }
      const candidates = [];
      if (normalized && normalized.canonicalLink) candidates.push(normalized.canonicalLink);
      try { candidates.push(String(link).trim().replace(/[)\]\.]+$/g, '').toLowerCase().replace(/\/$/,'')); } catch (e) {}
      if (normalized && normalized.canonicalLink) candidates.push(String(normalized.canonicalLink).replace(/\/$/,''));
      for (const cand of Array.from(new Set(candidates))) {
        try {
          const { data } = await api.supabase.from('threads').select('*').ilike('canonical_link', cand).limit(1).maybeSingle();
          if (data) return data;
        } catch (e) { /* ignore per-candidate */ }
      }
      if (normalized && normalized.provider && normalized.id) {
        try {
          const { data } = await api.supabase.from('threads').select('*').eq('provider', normalized.provider).eq('provider_id', String(normalized.id)).limit(1).maybeSingle();
          if (data) return data;
        } catch (e) {}
      }
      for (const cand of Array.from(new Set(candidates))) {
        try {
          const { data } = await api.supabase.from('threads').select('*').ilike('social_link', cand).limit(1).maybeSingle();
          if (data) return data;
        } catch (e) {}
      }
      return null;
    } catch (err) {
      console.error('[database] getThreadByLink supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.getThreadByLink(link);
    }
  },

  getThreadById: async (id) => {
    if (!useSupabase || !api.supabase) return mem.getThreadById(id);
    try {
      const { data } = await api.supabase.from('threads').select('*').eq('id', id).limit(1).maybeSingle();
      return data || null;
    } catch (err) {
      console.error('[database] getThreadById supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.getThreadById(id);
    }
  },

  setThreadCreator: async (threadId, telegramId) => {
    if (!useSupabase || !api.supabase) return mem.setThreadCreator(threadId, telegramId);
    try {
      const { data, error } = await api.supabase.from('threads').update({ creator_telegram_id: telegramId }).eq('id', threadId).select().maybeSingle();
      if (error) return { error };
      return data || null;
    } catch (err) {
      console.error('[database] setThreadCreator supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.setThreadCreator(threadId, telegramId);
    }
  },

  listThreadsByCreator: async (telegramId) => {
    if (!useSupabase || !api.supabase) return mem.listThreadsByCreator(telegramId);
    try {
      const { data, error } = await api.supabase.from('threads').select('*').eq('creator_telegram_id', telegramId).order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (err) {
      console.error('[database] listThreadsByCreator supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.listThreadsByCreator(telegramId);
    }
  },

  createPaymentRequest: async (payload) => {
    if (!useSupabase || !api.supabase) return mem.createPaymentRequest(payload);
    try {
      const row = Object.assign({ status: 'pending', created_at: new Date().toISOString() }, payload);
      const { data, error } = await api.supabase.from('payment_requests').insert([row]).select().maybeSingle();
      if (error) throw error;
      return data;
    } catch (err) {
      console.error('[database] createPaymentRequest (supabase) err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.createPaymentRequest(payload);
    }
  },

  getPaymentById: async (id) => {
    if (!useSupabase || !api.supabase) return mem.getPaymentById(id);
    try {
      const { data } = await api.supabase.from('payment_requests').select('*').eq('id', id).limit(1).maybeSingle();
      return data || null;
    } catch (err) {
      console.error('[database] getPaymentById supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.getPaymentById(id);
    }
  },

  updatePaymentStatus: async (id, status, updates = {}) => {
    if (!useSupabase || !api.supabase) return mem.updatePaymentStatus(id, status, updates);
    try {
      const payload = Object.assign({ status }, updates);
      const { data, error } = await api.supabase.from('payment_requests').update(payload).eq('id', id).select().maybeSingle();
      if (error) return { error };
      return { data };
    } catch (err) {
      console.error('[database] updatePaymentStatus supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.updatePaymentStatus(id, status, updates);
    }
  },

  insertVoiceComment: async (payload) => {
    if (!useSupabase || !api.supabase) return mem.insertVoiceComment(payload);
    try {
      const insertRow = Object.assign({}, payload, { created_at: new Date().toISOString() });
      const { data, error } = await api.supabase.from('voice_comments').insert([insertRow]).select().maybeSingle();
      if (error) return { error };
      return data;
    } catch (err) {
      console.error('[database] insertVoiceComment supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.insertVoiceComment(payload);
    }
  },

  listCommentsByThread: async (threadId, offset = 0, limit = 15) => {
    if (!useSupabase || !api.supabase) return mem.listCommentsByThread(threadId, offset, limit);
    try {
      const { data, error } = await api.supabase.from('voice_comments').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
      if (error) return { error };
      return { data: data || [] };
    } catch (err) {
      console.error('[database] listCommentsByThread supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.listCommentsByThread(threadId, offset, limit);
    }
  },

  listCommentsByUser: async (telegramId, limit = 30) => {
    if (!useSupabase || !api.supabase) return mem.listCommentsByUser(telegramId, limit);
    try {
      const { data, error } = await api.supabase.from('voice_comments').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(limit);
      if (error) return [];
      return data || [];
    } catch (err) {
      console.error('[database] listCommentsByUser supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.listCommentsByUser(telegramId, limit);
    }
  },

  getCommentById: async (id) => {
    if (!useSupabase || !api.supabase) return mem.getCommentById(id);
    try {
      const { data, error } = await api.supabase.from('voice_comments').select('*').eq('id', id).limit(1).maybeSingle();
      if (error) throw error;
      return data || null;
    } catch (err) {
      console.error('[database] getCommentById supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.getCommentById(id);
    }
  },

  insertReplyRow: async (payload) => {
    if (!useSupabase || !api.supabase) return mem.insertReplyRow(payload);
    try {
      const row = Object.assign({}, payload, { created_at: new Date().toISOString() });
      const { data, error } = await api.supabase.from('replies').insert([row]).select().maybeSingle();
      if (error) return { error };
      return data;
    } catch (err) {
      console.error('[database] insertReplyRow supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.insertReplyRow(payload);
    }
  },

  listReplies: async (commentId) => {
    if (!useSupabase || !api.supabase) return mem.listReplies(commentId);
    try {
      const { data } = await api.supabase.from('replies').select('*').eq('comment_id', commentId).order('created_at', { ascending: true });
      return data || [];
    } catch (err) {
      console.error('[database] listReplies supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.listReplies(commentId);
    }
  },

  toggleFavoriteRow: async (telegramId, commentId) => {
    if (!useSupabase || !api.supabase) return mem.toggleFavoriteRow(telegramId, commentId);
    try {
      const { data: exists } = await api.supabase.from('favorites').select('*').eq('telegram_id', telegramId).eq('comment_id', commentId).limit(1).maybeSingle();
      if (exists) {
        await api.supabase.from('favorites').delete().eq('id', exists.id);
        return { removed: true };
      } else {
        const { data } = await api.supabase.from('favorites').insert([{ telegram_id: telegramId, comment_id: commentId }]).select().maybeSingle();
        return { removed: false, data };
      }
    } catch (err) {
      console.error('[database] toggleFavoriteRow supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.toggleFavoriteRow(telegramId, commentId);
    }
  },

  isFavorite: async (telegramId, commentId) => {
    if (!useSupabase || !api.supabase) return mem.isFavorite(telegramId, commentId);
    try {
      const { data } = await api.supabase.from('favorites').select('*').eq('telegram_id', telegramId).eq('comment_id', commentId).limit(1).maybeSingle();
      return !!data;
    } catch (err) {
      console.error('[database] isFavorite supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.isFavorite(telegramId, commentId);
    }
  },

  insertReactionRow: async (payload) => {
    if (!useSupabase || !api.supabase) return mem.insertReactionRow(payload);
    try {
      const row = Object.assign({}, payload, { created_at: new Date().toISOString() });
      const { data, error } = await api.supabase.from('reactions').insert([row]).select().maybeSingle();
      if (error) return { error };
      return data;
    } catch (err) {
      console.error('[database] insertReactionRow supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.insertReactionRow(payload);
    }
  },

  listFavoritesForUser: async (telegramId) => {
    if (!useSupabase || !api.supabase) return mem.listFavoritesForUser(telegramId);
    try {
      const { data, error } = await api.supabase.from('favorites').select('id, comment_id, created_at, voice_comments( id, thread_id, telegram_file_id, first_name, username, created_at )').eq('telegram_id', telegramId).order('created_at', { ascending: false });
      if (error) return [];
      return (data || []).map(r => r.voice_comments).filter(Boolean);
    } catch (err) {
      console.error('[database] listFavoritesForUser supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.listFavoritesForUser(telegramId);
    }
  },

  addNotificationRow: async (payload) => {
    if (!useSupabase || !api.supabase) return mem.addNotificationRow(payload);
    try {
      const { data, error } = await api.supabase.from('notifications').insert([payload]).select().maybeSingle();
      if (error) return { error };
      return { data };
    } catch (err) {
      console.error('[database] addNotificationRow supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.addNotificationRow(payload);
    }
  },

  listNotifications: async (telegramId) => {
    if (!useSupabase || !api.supabase) return mem.listNotifications(telegramId);
    try {
      const { data, error } = await api.supabase.from('notifications').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(50);
      if (error) return { error };
      return { data };
    } catch (err) {
      console.error('[database] listNotifications supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.listNotifications(telegramId);
    }
  },

  setAdminNotifier: async (text, meta) => {
    if (!useSupabase || !api.supabase) return mem.setAdminNotifier(text, meta);
    try {
      try { await api.supabase.from('admin_notifications').insert([{ message: text, meta: meta || {}, created_at: new Date().toISOString() }]); } catch (e) { /* ignore */ }
    } catch (err) {
      console.error('[database] setAdminNotifier supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return mem.setAdminNotifier(text, meta);
    }
  }
};

// Export the api
module.exports = api;
