// src/database.js
// Supabase wrapper with in-memory fallback for reliability.
// Exports many helper functions used by bot.js

const utils = require('./utils');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const DISABLE_SUPABASE = (process.env.DISABLE_SUPABASE || '').toLowerCase() === 'true';

let usingSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY && !DISABLE_SUPABASE);
let supabase = null;

function markFallback(reason) {
  if (usingSupabase) console.error('[database] Supabase failing: switching to in-memory fallback. Reason:', reason && (reason.message || reason));
  usingSupabase = false;
  supabase = null;
}
function isNetworkError(err) {
  if (!err) return false;
  const m = String(err && (err.message || err)).toLowerCase();
  return m.includes('fetch failed') || m.includes('network') || m.includes('undici') || m.includes('timeout');
}

// In-memory fallback
const mem = {
  users: new Map(),
  threads: new Map(),
  threadsByCanonical: new Map(),
  voice_comments: new Map(),
  replies: new Map(),
  payment_requests: new Map(),
  favorites: new Map(),
  reactions: new Map(),
  notifications: new Map(),
  reports: new Map(),
  counters: { thread: 1000, comment: 10000, reply: 50000, payment: 90000, reaction: 400000, report: 800000 }
};
function memNext(kind) {
  const c = mem.counters;
  if (kind === 'thread') return ++c.thread;
  if (kind === 'comment') return ++c.comment;
  if (kind === 'reply') return ++c.reply;
  if (kind === 'payment') return ++c.payment;
  if (kind === 'reaction') return ++c.reaction;
  if (kind === 'report') return ++c.report;
  return Date.now();
}

function memNormalizeKey(l) {
  if (!l) return l;
  return String(l).trim().replace(/[)\]\.]+$/g, '').toLowerCase().replace(/\/$/,'');
}

// mem helpers (keeps state in-memory)
const memHelpers = {
  ensureUserRow: async (user) => {
    if (!user || !user.id) return null;
    const key = String(user.id);
    const u = mem.users.get(key) || { telegram_id: user.id, username: user.username || null, first_name: user.first_name || null, free_comments: 0, created_at: new Date().toISOString() };
    mem.users.set(key, Object.assign(u, { username: user.username || u.username, first_name: user.first_name || u.first_name }));
    return mem.users.get(key);
  },

  getUserByTelegramId: async (telegramId) => mem.users.get(String(telegramId)) || null,

  getUserBalance: async (telegramId) => {
    const u = mem.users.get(String(telegramId)); return u ? Number(u.free_comments || 0) : 0;
  },

  creditUser: async (telegramId, amount) => {
    const key = String(telegramId);
    let u = mem.users.get(key);
    if (!u) u = { telegram_id: telegramId, username: null, first_name: null, free_comments: Number(amount || 0), created_at: new Date().toISOString() };
    else u.free_comments = Number(u.free_comments || 0) + Number(amount || 0);
    mem.users.set(key, u);
    return u;
  },

  decrementUserBalance: async (telegramId, amount) => {
    const key = String(telegramId);
    const u = mem.users.get(key);
    if (!u) return { error: 'not found' };
    const current = Number(u.free_comments || 0);
    const dec = Number(amount || 1);
    if (current < dec) return { error: 'insufficient' };
    u.free_comments = current - dec;
    mem.users.set(key, u);
    return { data: u };
  },

  findOrCreateThread: async (link, creatorTelegramId = null) => {
    let normalized;
    try { normalized = await utils.normalizeVideoUrl(link); } catch (e) { normalized = { canonicalLink: link }; }
    const canonical = (normalized && normalized.canonicalLink) ? normalized.canonicalLink : memNormalizeKey(link);
    if (mem.threadsByCanonical.has(canonical)) {
      const id = mem.threadsByCanonical.get(canonical);
      const t = mem.threads.get(id);
      if (creatorTelegramId && (!t.creator_telegram_id || t.creator_telegram_id !== creatorTelegramId)) { t.creator_telegram_id = creatorTelegramId; mem.threads.set(id,t); }
      return t;
    }
    const id = memNext('thread');
    const t = {
      id,
      social_link: link,
      canonical_link: canonical,
      provider: (normalized && normalized.provider) ? normalized.provider : null,
      provider_id: (normalized && normalized.id) ? String(normalized.id) : null,
      thumbnail: (normalized && normalized.thumbnail) ? normalized.thumbnail : null,
      creator_telegram_id: creatorTelegramId || null,
      created_at: new Date().toISOString()
    };
    mem.threads.set(id, t);
    mem.threadsByCanonical.set(canonical, id);
    return t;
  },

  getThreadByLink: async (link) => {
    let normalized;
    try { normalized = await utils.normalizeVideoUrl(link); } catch (e) { normalized = { canonicalLink: link }; }
    const canonical = (normalized && normalized.canonicalLink) ? normalized.canonicalLink : memNormalizeKey(link);
    const id = mem.threadsByCanonical.get(canonical);
    return id ? mem.threads.get(id) : null;
  },

  getThreadById: async (id) => mem.threads.get(Number(id)) || null,

  setThreadCreator: async (threadId, telegramId) => {
    const t = mem.threads.get(Number(threadId));
    if (!t) return null;
    t.creator_telegram_id = telegramId; mem.threads.set(Number(threadId), t); return t;
  },

  listThreadsByCreator: async (telegramId) => Array.from(mem.threads.values()).filter(t => Number(t.creator_telegram_id) === Number(telegramId)),

  createPaymentRequest: async (payload) => {
    const id = memNext('payment');
    const row = Object.assign({ id, status: 'pending', created_at: new Date().toISOString() }, payload);
    mem.payment_requests.set(Number(id), row); return row;
  },

  getPaymentById: async (id) => mem.payment_requests.get(Number(id)) || null,

  updatePaymentStatus: async (id, status, updates = {}) => {
    const pid = Number(id); const existing = mem.payment_requests.get(pid); if (!existing) return { error: 'not found' };
    const updated = Object.assign({}, existing, updates, { status }); mem.payment_requests.set(pid, updated); return { data: updated };
  },

  insertVoiceComment: async (payload) => {
    const id = memNext('comment');
    const row = Object.assign({}, payload, { id, created_at: new Date().toISOString() });
    mem.voice_comments.set(id, row);
    return row;
  },

  listCommentsByThread: async (threadId, offset = 0, limit = 15) => {
    const arr = Array.from(mem.voice_comments.values()).filter(c => Number(c.thread_id) === Number(threadId)).sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    const slice = arr.slice(offset, offset + limit); return { data: slice };
  },

  listCommentsByUser: async (telegramId, limit = 30) => Array.from(mem.voice_comments.values()).filter(c => Number(c.telegram_id) === Number(telegramId)).sort((a,b)=> new Date(b.created_at) - new Date(a.created_at)).slice(0, limit),

  getCommentById: async (id) => mem.voice_comments.get(Number(id)) || null,

  insertReplyRow: async (payload) => {
    const id = memNext('reply'); const row = Object.assign({}, payload, { id, created_at: new Date().toISOString() }); mem.replies.set(id, row); return row;
  },

  listReplies: async (commentId) => Array.from(mem.replies.values()).filter(r => Number(r.comment_id) === Number(commentId)).sort((a,b)=> new Date(a.created_at) - new Date(b.created_at)),

  toggleFavoriteRow: async (telegramId, commentId) => {
    const key = `${telegramId}:${commentId}`; if (mem.favorites.has(key)) { mem.favorites.delete(key); return { removed: true }; } mem.favorites.set(key, { telegram_id: telegramId, comment_id: commentId, created_at: new Date().toISOString() }); return { removed: false, data: { telegram_id, comment_id } };
  },

  isFavorite: async (telegramId, commentId) => !!mem.favorites.has(`${telegramId}:${commentId}`),

  toggleReaction: async (telegramId, commentId, type) => {
    const list = Array.from(mem.reactions.values()).filter(r => Number(r.comment_id) === Number(commentId) && String(r.telegram_id) === String(telegramId));
    if (list.length > 0) {
      const existing = list[0];
      if (existing.type === type) { mem.reactions.delete(existing.id); return { removed: true, type }; } else { existing.type = type; existing.created_at = new Date().toISOString(); mem.reactions.set(existing.id, existing); return { updated: true, type }; }
    } else {
      const id = memNext('reaction'); const r = { id, comment_id: commentId, telegram_id: telegramId, type, created_at: new Date().toISOString() }; mem.reactions.set(id, r); return { added: true, type };
    }
  },

  getReactionCounts: async (commentId) => {
    const arr = Array.from(mem.reactions.values()).filter(r => Number(r.comment_id) === Number(commentId));
    const counts = { heart:0, laugh:0, dislike:0 }; for (const r of arr) counts[r.type] = (counts[r.type] || 0) + 1; return counts;
  },

  listFavoritesForUser: async (telegramId) => {
    const items = Array.from(mem.favorites.values()).filter(f => Number(f.telegram_id) === Number(telegramId));
    const result = (items || []).map(f => mem.voice_comments.get(Number(f.comment_id))).filter(Boolean);
    return result;
  },

  addNotificationRow: async (payload) => {
    const id = Date.now(); const row = Object.assign({}, payload, { id, created_at: new Date().toISOString() }); mem.notifications.set(id, row); return { data: row };
  },

  listNotifications: async (telegramId) => {
    const items = Array.from(mem.notifications.values()).filter(n => Number(n.telegram_id) === Number(telegramId)).sort((a,b)=> new Date(b.created_at) - new Date(a.created_at)); return { data: items };
  },

  setAdminNotifier: async (text, meta) => { const id = Date.now(); mem.notifications.set(id, { id, telegram_id: null, message: text, meta: meta || {}, created_at: new Date().toISOString() }); },

  insertReport: async (payload) => { const id = memNext('report'); const r = Object.assign({ id, status: 'open', created_at: new Date().toISOString() }, payload); mem.reports.set(id, r); return r; },

  listReports: async (filter = {}) => {
    const arr = Array.from(mem.reports.values()); let out = arr; if (filter.status) out = out.filter(r => r.status === filter.status); if (filter.comment_id) out = out.filter(r => Number(r.comment_id) === Number(filter.comment_id)); if (filter.reply_id) out = out.filter(r => Number(r.reply_id) === Number(filter.reply_id)); return out.sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
  },

  getReportById: async (id) => mem.reports.get(Number(id)) || null,

  deleteReport: async (id) => mem.reports.delete(Number(id)),

  deleteCommentById: async (id) => {
    const mid = Number(id);
    const removed = mem.voice_comments.delete(mid);
    for (const [rid,r] of Array.from(mem.replies.entries())) if (Number(r.comment_id) === mid) mem.replies.delete(rid);
    return removed ? { deleted: true } : { error: 'not found' };
  },

  deleteReplyById: async (id) => { const mid = Number(id); return mem.replies.delete(mid) ? { deleted: true } : { error: 'not found' }; },

  deleteThreadById: async (id) => {
    const tid = Number(id);
    const t = mem.threads.get(tid);
    if (t) { const key = memNormalizeKey(t.canonical_link || t.social_link || ''); if (mem.threadsByCanonical.has(key) && mem.threadsByCanonical.get(key) === tid) mem.threadsByCanonical.delete(key); mem.threads.delete(tid); }
    for (const [cid,c] of Array.from(mem.voice_comments.entries())) {
      if (Number(c.thread_id) === tid) {
        mem.voice_comments.delete(cid);
        for (const [rid,r] of Array.from(mem.replies.entries())) { if (Number(r.comment_id) === Number(cid)) mem.replies.delete(rid); }
      }
    }
    return true;
  }
};

// Try creating supabase client if env present
if (usingSupabase) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  } catch (e) {
    console.error('[database] could not create supabase client — using in-memory fallback.', e && (e.stack || e.message));
    markFallback(e);
  }
}

// API that prefers Supabase and falls back to mem
const api = {
  supabase,
  mode: usingSupabase ? 'supabase' : 'memory',
  isUsingSupabase: () => usingSupabase,

  ensureUserRow: async (user) {
    if (!usingSupabase || !api.supabase) return memHelpers.ensureUserRow(user);
    try {
      const row = { telegram_id: user.id, username: user.username || null, first_name: user.first_name || null, created_at: new Date().toISOString() };
      const { data, error } = await api.supabase.from('users').upsert(row, { onConflict: ['telegram_id'] }).select().maybeSingle();
      if (error) throw error;
      return data || null;
    } catch (err) {
      console.error('[database] ensureUserRow supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.ensureUserRow(user);
    }
  },

  getUserByTelegramId: async (telegramId) {
    if (!usingSupabase || !api.supabase) return memHelpers.getUserByTelegramId(telegramId);
    try {
      const { data, error } = await api.supabase.from('users').select('*').eq('telegram_id', telegramId).limit(1).maybeSingle();
      if (error) throw error;
      return data || null;
    } catch (err) {
      console.error('[database] getUserByTelegramId supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.getUserByTelegramId(telegramId);
    }
  },

  getUserBalance: async (telegramId) {
    if (!usingSupabase || !api.supabase) return memHelpers.getUserBalance(telegramId);
    try {
      const { data, error } = await api.supabase.from('users').select('free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
      if (error) throw error;
      return Number((data && data.free_comments) || 0);
    } catch (err) {
      console.error('[database] getUserBalance supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.getUserBalance(telegramId);
    }
  },

  creditUser: async (telegramId, amount) {
    if (!usingSupabase || !api.supabase) return memHelpers.creditUser(telegramId, amount);
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
      return memHelpers.creditUser(telegramId, amount);
    }
  },

  decrementUserBalance: async (telegramId, amount) {
    if (!usingSupabase || !api.supabase) return memHelpers.decrementUserBalance(telegramId, amount);
    try {
      const { data } = await api.supabase.from('users').select('free_comments').eq('telegram_id', telegramId).limit(1).maybeSingle();
      if (!data) return { error: 'not found or zero' };
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
      return memHelpers.decrementUserBalance(telegramId, amount);
    }
  },

  findOrCreateThread: async (link, creatorTelegramId = null) {
    if (!usingSupabase || !api.supabase) return memHelpers.findOrCreateThread(link, creatorTelegramId);
    try {
      let normalized;
      try { normalized = await utils.normalizeVideoUrl(link); } catch (e) { normalized = { canonicalLink: link }; }
      const provider = normalized && normalized.provider ? normalized.provider : null;
      const providerId = normalized && normalized.id ? String(normalized.id) : null;
      const candidates = [];
      if (normalized && normalized.canonicalLink) candidates.push(normalized.canonicalLink);
      try { candidates.push(String(link).trim().replace(/[)\]\.]+$/g, '').toLowerCase().replace(/\/$/,'')); } catch (e) {}
      const uniq = Array.from(new Set(candidates.filter(Boolean)));

      for (const cand of uniq) {
        try {
          const { data } = await api.supabase.from('threads').select('*').ilike('canonical_link', cand).limit(1).maybeSingle();
          if (data) {
            if (creatorTelegramId && (!data.creator_telegram_id || data.creator_telegram_id !== creatorTelegramId)) {
              try { await api.supabase.from('threads').update({ creator_telegram_id: creatorTelegramId }).eq('id', data.id); } catch (e) {}
              data.creator_telegram_id = creatorTelegramId;
            }
            return data;
          }
        } catch (e) {}
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
        thumbnail: (normalized && normalized.thumbnail) ? normalized.thumbnail : null,
        creator_telegram_id: creatorTelegramId || null,
        created_at: new Date().toISOString()
      };
      const { data, error } = await api.supabase.from('threads').insert([insertRow]).select().maybeSingle();
      if (error) throw error;
      return data;
    } catch (err) {
      console.error('[database] findOrCreateThread supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.findOrCreateThread(link, creatorTelegramId);
    }
  },

  getThreadByLink: async (link) {
    if (!usingSupabase || !api.supabase) return memHelpers.getThreadByLink(link);
    try {
      let normalized;
      try { normalized = await utils.normalizeVideoUrl(link); } catch (e) { normalized = { canonicalLink: link }; }
      const candidates = [];
      if (normalized && normalized.canonicalLink) candidates.push(normalized.canonicalLink);
      try { candidates.push(String(link).trim().replace(/[)\]\.]+$/g, '').toLowerCase().replace(/\/$/,'')); } catch (e) {}
      for (const cand of Array.from(new Set(candidates))) {
        try {
          const { data } = await api.supabase.from('threads').select('*').ilike('canonical_link', cand).limit(1).maybeSingle();
          if (data) return data;
        } catch (e) {}
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
      return memHelpers.getThreadByLink(link);
    }
  },

  getThreadById: async (id) {
    if (!usingSupabase || !api.supabase) return memHelpers.getThreadById(id);
    try {
      const { data } = await api.supabase.from('threads').select('*').eq('id', id).limit(1).maybeSingle();
      return data || null;
    } catch (err) {
      console.error('[database] getThreadById supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.getThreadById(id);
    }
  },

  setThreadCreator: async (threadId, telegramId) {
    if (!usingSupabase || !api.supabase) return memHelpers.setThreadCreator(threadId, telegramId);
    try {
      const { data, error } = await api.supabase.from('threads').update({ creator_telegram_id: telegramId }).eq('id', threadId).select().maybeSingle();
      if (error) return { error };
      return data || null;
    } catch (err) {
      console.error('[database] setThreadCreator supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.setThreadCreator(threadId, telegramId);
    }
  },

  listThreadsByCreator: async (telegramId) {
    if (!usingSupabase || !api.supabase) return memHelpers.listThreadsByCreator(telegramId);
    try {
      const { data, error } = await api.supabase.from('threads').select('*').eq('creator_telegram_id', telegramId).order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (err) {
      console.error('[database] listThreadsByCreator supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.listThreadsByCreator(telegramId);
    }
  },

  createPaymentRequest: async (payload) {
    if (!usingSupabase || !api.supabase) return memHelpers.createPaymentRequest(payload);
    try {
      const row = Object.assign({ status: 'pending', created_at: new Date().toISOString() }, payload);
      const { data, error } = await api.supabase.from('payment_requests').insert([row]).select().maybeSingle();
      if (error) throw error;
      return data;
    } catch (err) {
      console.error('[database] createPaymentRequest (supabase) err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.createPaymentRequest(payload);
    }
  },

  getPaymentById: async (id) {
    if (!usingSupabase || !api.supabase) return memHelpers.getPaymentById(id);
    try {
      const { data } = await api.supabase.from('payment_requests').select('*').eq('id', id).limit(1).maybeSingle();
      return data || null;
    } catch (err) {
      console.error('[database] getPaymentById supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.getPaymentById(id);
    }
  },

  updatePaymentStatus: async (id, status, updates = {}) {
    if (!usingSupabase || !api.supabase) return memHelpers.updatePaymentStatus(id, status, updates);
    try {
      const payload = Object.assign({ status }, updates);
      const { data, error } = await api.supabase.from('payment_requests').update(payload).eq('id', id).select().maybeSingle();
      if (error) return { error };
      return { data };
    } catch (err) {
      console.error('[database] updatePaymentStatus supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.updatePaymentStatus(id, status, updates);
    }
  },

  insertVoiceComment: async (payload) {
    if (!usingSupabase || !api.supabase) return memHelpers.insertVoiceComment(payload);
    try {
      const insertRow = Object.assign({}, payload, { created_at: new Date().toISOString() });
      const { data, error } = await api.supabase.from('voice_comments').insert([insertRow]).select().maybeSingle();
      if (error) return { error };
      return data;
    } catch (err) {
      console.error('[database] insertVoiceComment supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.insertVoiceComment(payload);
    }
  },

  listCommentsByThread: async (threadId, offset = 0, limit = 15) {
    if (!usingSupabase || !api.supabase) return memHelpers.listCommentsByThread(threadId, offset, limit);
    try {
      const from = offset;
      const to = offset + limit - 1;
      const { data, error } = await api.supabase.from('voice_comments').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).range(from, to);
      if (error) return { error };
      return { data: data || [] };
    } catch (err) {
      console.error('[database] listCommentsByThread supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.listCommentsByThread(threadId, offset, limit);
    }
  },

  listCommentsByUser: async (telegramId, limit = 30) {
    if (!usingSupabase || !api.supabase) return memHelpers.listCommentsByUser(telegramId, limit);
    try {
      const { data, error } = await api.supabase.from('voice_comments').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(limit);
      if (error) return [];
      return data || [];
    } catch (err) {
      console.error('[database] listCommentsByUser supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.listCommentsByUser(telegramId, limit);
    }
  },

  getCommentById: async (id) {
    if (!usingSupabase || !api.supabase) return memHelpers.getCommentById(id);
    try {
      const { data, error } = await api.supabase.from('voice_comments').select('*').eq('id', id).limit(1).maybeSingle();
      if (error) throw error;
      return data || null;
    } catch (err) {
      console.error('[database] getCommentById supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.getCommentById(id);
    }
  },

  insertReplyRow: async (payload) {
    if (!usingSupabase || !api.supabase) return memHelpers.insertReplyRow(payload);
    try {
      const row = Object.assign({}, payload, { created_at: new Date().toISOString() });
      const { data, error } = await api.supabase.from('replies').insert([row]).select().maybeSingle();
      if (error) return { error };
      return data;
    } catch (err) {
      console.error('[database] insertReplyRow supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.insertReplyRow(payload);
    }
  },

  listReplies: async (commentId) {
    if (!usingSupabase || !api.supabase) return memHelpers.listReplies(commentId);
    try {
      const { data } = await api.supabase.from('replies').select('*').eq('comment_id', commentId).order('created_at', { ascending: true });
      return data || [];
    } catch (err) {
      console.error('[database] listReplies supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.listReplies(commentId);
    }
  },

  toggleFavoriteRow: async (telegramId, commentId) {
    if (!usingSupabase || !api.supabase) return memHelpers.toggleFavoriteRow(telegramId, commentId);
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
      return memHelpers.toggleFavoriteRow(telegramId, commentId);
    }
  },

  isFavorite: async (telegramId, commentId) {
    if (!usingSupabase || !api.supabase) return memHelpers.isFavorite(telegramId, commentId);
    try {
      const { data } = await api.supabase.from('favorites').select('*').eq('telegram_id', telegramId).eq('comment_id', commentId).limit(1).maybeSingle();
      return !!data;
    } catch (err) {
      console.error('[database] isFavorite supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.isFavorite(telegramId, commentId);
    }
  },

  toggleReaction: async (telegramId, commentId, type) {
    if (!usingSupabase || !api.supabase) return memHelpers.toggleReaction(telegramId, commentId, type);
    try {
      const { data: existing } = await api.supabase.from('reactions').select('*').eq('comment_id', commentId).eq('telegram_id', telegramId).limit(1).maybeSingle();
      if (existing) {
        if (existing.type === type) {
          await api.supabase.from('reactions').delete().eq('id', existing.id);
          return { removed: true, type };
        } else {
          const { data } = await api.supabase.from('reactions').update({ type }).eq('id', existing.id).select().maybeSingle();
          return { updated: true, type };
        }
      } else {
        const { data } = await api.supabase.from('reactions').insert([{ comment_id: commentId, telegram_id: telegramId, type }]).select().maybeSingle();
        return { added: true, type };
      }
    } catch (err) {
      console.error('[database] toggleReaction supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.toggleReaction(telegramId, commentId, type);
    }
  },

  getReactionCounts: async (commentId) {
    if (!usingSupabase || !api.supabase) return memHelpers.getReactionCounts(commentId);
    try {
      const { data: all } = await api.supabase.from('reactions').select('type').eq('comment_id', commentId);
      const counts = { heart: 0, laugh: 0, dislike: 0 };
      (all || []).forEach(r => { counts[r.type] = (counts[r.type] || 0) + 1; });
      return counts;
    } catch (err) {
      console.error('[database] getReactionCounts supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.getReactionCounts(commentId);
    }
  },

  listFavoritesForUser: async (telegramId) {
    if (!usingSupabase || !api.supabase) return memHelpers.listFavoritesForUser(telegramId);
    try {
      const { data, error } = await api.supabase.from('favorites').select('id, comment_id, created_at, voice_comments( id, thread_id, telegram_file_id, first_name, username, created_at )').eq('telegram_id', telegramId).order('created_at', { ascending: false });
      if (error) return [];
      return (data || []).map(r => r.voice_comments).filter(Boolean);
    } catch (err) {
      console.error('[database] listFavoritesForUser supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.listFavoritesForUser(telegramId);
    }
  },

  addNotificationRow: async (payload) {
    if (!usingSupabase || !api.supabase) return memHelpers.addNotificationRow(payload);
    try {
      const { data, error } = await api.supabase.from('notifications').insert([payload]).select().maybeSingle();
      if (error) return { error };
      return { data };
    } catch (err) {
      console.error('[database] addNotificationRow supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.addNotificationRow(payload);
    }
  },

  listNotifications: async (telegramId) {
    if (!usingSupabase || !api.supabase) return memHelpers.listNotifications(telegramId);
    try {
      const { data, error } = await api.supabase.from('notifications').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(50);
      if (error) return { error };
      return { data };
    } catch (err) {
      console.error('[database] listNotifications supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.listNotifications(telegramId);
    }
  },

  setAdminNotifier: async (text, meta) {
    if (!usingSupabase || !api.supabase) return memHelpers.setAdminNotifier(text, meta);
    try {
      await api.supabase.from('admin_notifications').insert([{ message: text, meta: meta || {}, created_at: new Date().toISOString() }]);
      return;
    } catch (err) {
      console.error('[database] setAdminNotifier supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.setAdminNotifier(text, meta);
    }
  },

  insertReport: async (payload) {
    if (!usingSupabase || !api.supabase) return memHelpers.insertReport(payload);
    try {
      const row = Object.assign({ status: 'open', created_at: new Date().toISOString() }, payload);
      const { data, error } = await api.supabase.from('reports').insert([row]).select().maybeSingle();
      if (error) return { error };
      return data;
    } catch (err) {
      console.error('[database] insertReport supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.insertReport(payload);
    }
  },

  listReports: async (filter = {}) {
    if (!usingSupabase || !api.supabase) return memHelpers.listReports(filter);
    try {
      let q = api.supabase.from('reports').select('*').order('created_at', { ascending: false }).limit(50);
      if (filter.status) q = q.eq('status', filter.status);
      if (filter.comment_id) q = q.eq('comment_id', filter.comment_id);
      if (filter.reply_id) q = q.eq('reply_id', filter.reply_id);
      const { data, error } = await q;
      if (error) return [];
      return data || [];
    } catch (err) {
      console.error('[database] listReports supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.listReports(filter);
    }
  },

  getReportById: async (id) {
    if (!usingSupabase || !api.supabase) return memHelpers.getReportById(id);
    try {
      const { data } = await api.supabase.from('reports').select('*').eq('id', id).limit(1).maybeSingle();
      return data || null;
    } catch (err) {
      console.error('[database] getReportById supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.getReportById(id);
    }
  },

  deleteReport: async (id) {
    if (!usingSupabase || !api.supabase) return memHelpers.deleteReport(id);
    try {
      const { error } = await api.supabase.from('reports').delete().eq('id', id);
      if (error) return { error };
      return { deleted: true };
    } catch (err) {
      console.error('[database] deleteReport supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.deleteReport(id);
    }
  },

  deleteCommentById: async (id) {
    if (!usingSupabase || !api.supabase) return memHelpers.deleteCommentById(id);
    try {
      const { error } = await api.supabase.from('voice_comments').delete().eq('id', id);
      if (error) return { error };
      await api.supabase.from('replies').delete().eq('comment_id', id);
      return { deleted: true };
    } catch (err) {
      console.error('[database] deleteCommentById supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.deleteCommentById(id);
    }
  },

  deleteReplyById: async (id) {
    if (!usingSupabase || !api.supabase) return memHelpers.deleteReplyById(id);
    try {
      const { error } = await api.supabase.from('replies').delete().eq('id', id);
      if (error) return { error };
      return { deleted: true };
    } catch (err) {
      console.error('[database] deleteReplyById supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.deleteReplyById(id);
    }
  },

  deleteThreadById: async (id) {
    if (!usingSupabase || !api.supabase) return memHelpers.deleteThreadById(id);
    try {
      await api.supabase.from('replies').delete().in('comment_id', api.supabase.from('voice_comments').select('id').eq('thread_id', id));
      const { error: e2 } = await api.supabase.from('voice_comments').delete().eq('thread_id', id);
      if (e2) return { error: e2 };
      const { error } = await api.supabase.from('threads').delete().eq('id', id);
      if (error) return { error };
      return { deleted: true };
    } catch (err) {
      console.error('[database] deleteThreadById supabase err', err && (err.message || err));
      if (isNetworkError(err)) markFallback(err);
      return memHelpers.deleteThreadById(id);
    }
  },

  _mem_state: () => mem
};

module.exports = api;
