// src/database.js
// Supabase wrapper with an in-memory fallback when env is missing.

const utils = require('./utils');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (SUPABASE_URL && SUPABASE_KEY) {
  // Real Supabase client path
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

  // Export supabase-backed functions that match the API used in bot.js
  module.exports = {
    supabase,

    ensureUserRow: async (user) => {
      if (!user || !user.id) return null;
      const row = { telegram_id: user.id, username: user.username || null, first_name: user.first_name || null, created_at: new Date().toISOString() };
      const { data, error } = await supabase.from('users').upsert(row, { onConflict: ['telegram_id'] }).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    findOrCreateThread: async (link, creatorTelegramId = null) => {
      // robust implementation using utils.normalizeVideoUrl; similar to your previous code
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

        // try canonical
        for (const cand of uniq) {
          try {
            const { data } = await supabase.from('threads').select('*').ilike('canonical_link', cand).limit(1).maybeSingle();
            if (data) return data;
          } catch (e) {}
        }

        // provider lookup
        if (provider && providerId) {
          try {
            const { data } = await supabase.from('threads').select('*').eq('provider', provider).eq('provider_id', providerId).limit(1).maybeSingle();
            if (data) return data;
          } catch (e) {}
        }

        // social_link lookup
        for (const cand of uniq) {
          try {
            const { data } = await supabase.from('threads').select('*').ilike('social_link', cand).limit(1).maybeSingle();
            if (data) return data;
          } catch (e) {}
        }

        // insert
        const insertRow = {
          social_link: link,
          canonical_link: (normalized && normalized.canonicalLink) ? normalized.canonicalLink : null,
          provider: provider || null,
          provider_id: providerId || null,
          creator_telegram_id: creatorTelegramId || null,
          normalized_link: (normalized && normalized.canonicalLink) ? normalized.canonicalLink : null,
          created_at: new Date().toISOString()
        };
        const { data, error } = await supabase.from('threads').insert([insertRow]).select().maybeSingle();
        if (error) {
          // race case: attempt to fetch again
          for (const cand of uniq) {
            try {
              const { data: re } = await supabase.from('threads').select('*').ilike('canonical_link', cand).limit(1).maybeSingle();
              if (re) return re;
            } catch (_) {}
          }
          throw error;
        }
        return data;
      } catch (e) {
        console.error('findOrCreateThread supabase err', e && e.message);
        // final fallback object
        return { id: Date.now(), social_link: link, creator_telegram_id: creatorTelegramId, created_at: new Date().toISOString() };
      }
    },

    getThreadByLink: async (link) => {
      if (!link) return null;
      try {
        let normalized;
        try { normalized = await utils.normalizeVideoUrl(link); } catch (e) { normalized = { canonicalLink: link }; }
        const candidates = [];
        if (normalized && normalized.canonicalLink) candidates.push(normalized.canonicalLink);
        try { candidates.push(String(link).trim().replace(/[)\]\.]+$/g, '').toLowerCase().replace(/\/$/,'')); } catch (e) {}
        if (normalized && normalized.canonicalLink) candidates.push(String(normalized.canonicalLink).replace(/\/$/,''));
        for (const cand of Array.from(new Set(candidates))) {
          try {
            const { data } = await supabase.from('threads').select('*').ilike('canonical_link', cand).limit(1).maybeSingle();
            if (data) return data;
          } catch (e) {}
        }
        if (normalized && normalized.provider && normalized.id) {
          try {
            const { data } = await supabase.from('threads').select('*').eq('provider', normalized.provider).eq('provider_id', String(normalized.id)).limit(1).maybeSingle();
            if (data) return data;
          } catch (e) {}
        }
        for (const cand of Array.from(new Set(candidates))) {
          try {
            const { data } = await supabase.from('threads').select('*').ilike('social_link', cand).limit(1).maybeSingle();
            if (data) return data;
          } catch (e) {}
        }
        return null;
      } catch (e) {
        console.error('getThreadByLink supabase err', e && e.message);
        return null;
      }
    },

    getThreadById: async (id) => {
      if (!id) return null;
      try {
        const { data } = await supabase.from('threads').select('*').eq('id', id).limit(1).maybeSingle();
        return data || null;
      } catch (e) { console.error('getThreadById err', e && e.message); return null; }
    },

    // Payments / comments / replies... (Supabase-backed)
    createPaymentRequest: async (payload) => {
      const row = Object.assign({ status: 'pending', created_at: new Date().toISOString() }, payload);
      const { data, error } = await supabase.from('payment_requests').insert([row]).select().maybeSingle();
      if (error) throw error;
      return data;
    },
    getPaymentById: async (id) => {
      if (!id) return null;
      const { data } = await supabase.from('payment_requests').select('*').eq('id', id).limit(1).maybeSingle();
      return data || null;
    },
    updatePaymentStatus: async (id, status, updates = {}) => {
      if (!id) throw new Error('Missing payment id');
      const payload = Object.assign({ status }, updates);
      const { data, error } = await supabase.from('payment_requests').update(payload).eq('id', id).select().maybeSingle();
      if (error) return { error };
      return { data };
    },

    insertVoiceComment: async (payload) => {
      const insertRow = Object.assign({}, payload, { created_at: new Date().toISOString() });
      const { data, error } = await supabase.from('voice_comments').insert([insertRow]).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    listCommentsByThread: async (threadId, offset = 0, limit = 15) => {
      if (!threadId) return { data: [] };
      const { data, error } = await supabase.from('voice_comments').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
      if (error) return { error };
      return { data: data || [] };
    },

    getCommentById: async (id) => {
      if (!id) return null;
      const { data } = await supabase.from('voice_comments').select('*').eq('id', id).limit(1).maybeSingle();
      return data || null;
    },

    insertReplyRow: async (payload) => {
      const row = Object.assign({}, payload, { created_at: new Date().toISOString() });
      const { data, error } = await supabase.from('replies').insert([row]).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    listReplies: async (commentId) => {
      if (!commentId) return [];
      const { data } = await supabase.from('replies').select('*').eq('comment_id', commentId).order('created_at', { ascending: true });
      return data || [];
    },

    toggleFavoriteRow: async (telegramId, commentId) => {
      if (!telegramId || !commentId) return { removed: false };
      const { data: exists } = await supabase.from('favorites').select('*').eq('telegram_id', telegramId).eq('comment_id', commentId).limit(1).maybeSingle();
      if (exists) {
        await supabase.from('favorites').delete().eq('id', exists.id);
        return { removed: true };
      } else {
        const { data } = await supabase.from('favorites').insert([{ telegram_id: telegramId, comment_id: commentId }]).select().maybeSingle();
        return { removed: false, data };
      }
    },

    isFavorite: async (telegramId, commentId) => {
      if (!telegramId || !commentId) return false;
      const { data } = await supabase.from('favorites').select('*').eq('telegram_id', telegramId).eq('comment_id', commentId).limit(1).maybeSingle();
      return !!data;
    },

    insertReactionRow: async (payload) => {
      const row = Object.assign({}, payload, { created_at: new Date().toISOString() });
      const { data, error } = await supabase.from('reactions').insert([row]).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    listFavoritesForUser: async (telegramId) => {
      if (!telegramId) return [];
      const { data, error } = await supabase.from('favorites').select('id, comment_id, created_at, voice_comments( id, thread_id, telegram_file_id, first_name, username, created_at )').eq('telegram_id', telegramId).order('created_at', { ascending: false });
      if (error) return [];
      return (data || []).map(r => r.voice_comments).filter(Boolean);
    },

    addNotificationRow: async (payload) => {
      const { data, error } = await supabase.from('notifications').insert([payload]).select().maybeSingle();
      if (error) return { error };
      return { data };
    },

    listNotifications: async (telegramId) => {
      const { data, error } = await supabase.from('notifications').select('*').eq('telegram_id', telegramId).order('created_at', { ascending: false }).limit(50);
      if (error) return { error };
      return { data };
    },

    setAdminNotifier: async (text, meta) => {
      // optional: store admin notifications in DB for debug
      try { await supabase.from('admin_notifications').insert([{ message: text, meta: meta || {}, created_at: new Date().toISOString() }]); } catch (e) {}
    }
  };

} else {
  // --- In-memory fallback (for local testing or when Supabase is not configured) ---
  console.warn('SUPABASE env missing — using in-memory DB fallback. This is suitable for testing only.');

  const state = {
    users: new Map(), // telegram_id -> user obj
    threads: new Map(), // id -> thread
    threadsByLink: new Map(), // link -> id
    voice_comments: new Map(), // id -> comment
    replies: new Map(),
    payment_requests: new Map(),
    favorites: new Map(),
    reactions: new Map(),
    notifications: new Map(),
    counters: { thread: 1000, comment: 10000, reply: 50000, payment: 90000 }
  };

  function nextId(kind) {
    const k = kind || 'generic';
    const c = state.counters;
    if (k === 'thread') return ++c.thread;
    if (k === 'comment') return ++c.comment;
    if (k === 'reply') return ++c.reply;
    if (k === 'payment') return ++c.payment;
    return Date.now();
  }

  function _normalizeLinkForKey(l) {
    if (!l) return l;
    try { return String(l).trim().replace(/[)\]\.]+$/g, '').toLowerCase().replace(/\/$/,''); } catch (e) { return String(l); }
  }

  module.exports = {
    // no supabase client
    supabase: null,

    ensureUserRow: async (user) => {
      if (!user || !user.id) return null;
      const key = String(user.id);
      const obj = { telegram_id: user.id, username: user.username || null, first_name: user.first_name || null, created_at: new Date().toISOString() };
      state.users.set(key, obj);
      return obj;
    },

    findOrCreateThread: async (link, creatorTelegramId = null) => {
      const normalized = await (async () => { try { return await utils.normalizeVideoUrl(link); } catch (e) { return { canonicalLink: link }; } })();
      const cand = (normalized && normalized.canonicalLink) ? normalized.canonicalLink : _normalizeLinkForKey(link);
      const key = _normalizeLinkForKey(cand || link);
      if (state.threadsByLink.has(key)) {
        const id = state.threadsByLink.get(key);
        return state.threads.get(id);
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
      // store for debug
      const id = Date.now();
      state.notifications.set(id, { id, telegram_id: null, message: text, meta: meta || {}, created_at: new Date().toISOString() });
    }
  };
}
