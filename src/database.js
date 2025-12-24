// src/database.js
// Minimal in-memory database wrapper for your bot.
// Purpose: avoid all Supabase/network issues so bot runs reliably.

const mem = {
  users: new Map(),
  threads: new Map(),
  threadsByCanonical: new Map(),
  comments: new Map(),
  replies: new Map(),
  payments: new Map(),
  favorites: new Set(), // "telegramId:commentId"
  reactions: new Map(), // id -> {id, comment_id, telegram_id, type}
  notifications: new Map(),
  reports: new Map(),
  counters: { thread: 1000, comment: 10000, reply: 20000, payment: 30000, reaction: 40000, report: 50000 }
};

function next(kind) {
  const c = mem.counters;
  if (!c[kind]) c[kind] = 1;
  return ++c[kind];
}

function normalizeKey(link) {
  if (!link) return link;
  return String(link).trim().replace(/[)\]\.]+$/g,'').toLowerCase().replace(/\/$/,'');
}

module.exports = {
  // indicate there's no supabase active
  isUsingSupabase: () => false,

  // USERS
  ensureUserRow: async (user) => {
    if (!user || !user.id) return null;
    const k = String(user.id);
    const existing = mem.users.get(k) || { telegram_id: user.id, username: user.username || null, first_name: user.first_name || null, free_comments: 0, created_at: new Date().toISOString() };
    existing.username = user.username || existing.username;
    existing.first_name = user.first_name || existing.first_name;
    mem.users.set(k, existing);
    return existing;
  },
  getUserByTelegramId: async (telegramId) => mem.users.get(String(telegramId)) || null,
  getUserBalance: async (telegramId) => {
    const u = mem.users.get(String(telegramId)); return u ? Number(u.free_comments || 0) : 0;
  },
  creditUser: async (telegramId, amount) => {
    const k = String(telegramId);
    const u = mem.users.get(k) || { telegram_id: telegramId, username: null, first_name: null, free_comments: 0, created_at: new Date().toISOString() };
    u.free_comments = Number(u.free_comments || 0) + Number(amount || 0);
    mem.users.set(k, u);
    return u;
  },
  decrementUserBalance: async (telegramId, amount) => {
    const k = String(telegramId);
    const u = mem.users.get(k);
    if (!u) return { error: 'not found' };
    const dec = Number(amount || 1);
    if ((Number(u.free_comments || 0)) < dec) return { error: 'insufficient' };
    u.free_comments = Number(u.free_comments || 0) - dec;
    mem.users.set(k, u);
    return { data: u };
  },

  // THREADS (videos)
  findOrCreateThread: async (link, creatorTelegramId = null) => {
    const canonical = normalizeKey(link) || String(link || '');
    if (mem.threadsByCanonical.has(canonical)) {
      const id = mem.threadsByCanonical.get(canonical);
      const t = mem.threads.get(id);
      if (creatorTelegramId && (!t.creator_telegram_id || t.creator_telegram_id !== creatorTelegramId)) {
        t.creator_telegram_id = creatorTelegramId;
        mem.threads.set(id, t);
      }
      return t;
    }
    const id = next('thread');
    const t = { id, social_link: link, canonical_link: canonical, thumbnail: null, creator_telegram_id: creatorTelegramId || null, created_at: new Date().toISOString() };
    mem.threads.set(id, t);
    mem.threadsByCanonical.set(canonical, id);
    return t;
  },
  getThreadByLink: async (link) => {
    const canonical = normalizeKey(link);
    const id = mem.threadsByCanonical.get(canonical);
    return id ? mem.threads.get(id) : null;
  },
  getThreadById: async (id) => mem.threads.get(Number(id)) || null,
  setThreadCreator: async (threadId, telegramId) => {
    const t = mem.threads.get(Number(threadId)); if (!t) return null; t.creator_telegram_id = telegramId; mem.threads.set(Number(threadId), t); return t;
  },
  listThreadsByCreator: async (telegramId) => Array.from(mem.threads.values()).filter(t => Number(t.creator_telegram_id) === Number(telegramId)),

  // PAYMENTS
  createPaymentRequest: async (payload) => {
    const id = next('payment');
    const row = Object.assign({ id, status: 'pending', created_at: new Date().toISOString() }, payload);
    mem.payments.set(Number(id), row);
    return row;
  },
  getPaymentById: async (id) => mem.payments.get(Number(id)) || null,
  updatePaymentStatus: async (id, status, updates = {}) => {
    const pid = Number(id); const existing = mem.payments.get(pid); if (!existing) return { error: 'not found' };
    const updated = Object.assign({}, existing, updates, { status }); mem.payments.set(pid, updated); return { data: updated };
  },

  // COMMENTS
  insertVoiceComment: async (payload) => {
    const id = next('comment');
    const row = Object.assign({}, payload, { id, created_at: new Date().toISOString() });
    mem.comments.set(Number(id), row);
    return row;
  },
  listCommentsByThread: async (threadId, offset = 0, limit = 15) => {
    const arr = Array.from(mem.comments.values()).filter(c => Number(c.thread_id) === Number(threadId)).sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    return { data: arr.slice(offset, offset+limit) };
  },
  listCommentsByUser: async (telegramId) => Array.from(mem.comments.values()).filter(c => Number(c.telegram_id) === Number(telegramId)).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)),
  getCommentById: async (id) => mem.comments.get(Number(id)) || null,

  // REPLIES
  insertReplyRow: async (payload) => {
    const id = next('reply');
    const row = Object.assign({}, payload, { id, created_at: new Date().toISOString() });
    mem.replies.set(Number(id), row);
    return row;
  },
  listReplies: async (commentId) => Array.from(mem.replies.values()).filter(r => Number(r.comment_id) === Number(commentId)).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at)),

  // FAVORITES
  toggleFavoriteRow: async (telegramId, commentId) => {
    const key = `${telegramId}:${commentId}`;
    if (mem.favorites.has(key)) { mem.favorites.delete(key); return { removed: true }; }
    mem.favorites.add(key); return { removed: false };
  },
  isFavorite: async (telegramId, commentId) => mem.favorites.has(`${telegramId}:${commentId}`),
  listFavoritesForUser: async (telegramId) => {
    const keys = Array.from(mem.favorites).filter(k => k.startsWith(`${telegramId}:`));
    return keys.map(k => {
      const cid = Number(k.split(':')[1]);
      return mem.comments.get(cid);
    }).filter(Boolean);
  },

  // REACTIONS (one per user per comment)
  toggleReaction: async (telegramId, commentId, type) => {
    // find existing by telegramId+commentId
    for (const [id, r] of mem.reactions.entries()) {
      if (Number(r.comment_id) === Number(commentId) && String(r.telegram_id) === String(telegramId)) {
        if (r.type === type) { mem.reactions.delete(id); return { removed: true }; }
        r.type = type; r.created_at = new Date().toISOString(); mem.reactions.set(id, r); return { updated: true };
      }
    }
    const id = next('reaction'); const row = { id, comment_id: commentId, telegram_id: telegramId, type, created_at: new Date().toISOString() };
    mem.reactions.set(id, row);
    return { added: true };
  },
  getReactionCounts: async (commentId) => {
    const counts = { heart:0, laugh:0, dislike:0 };
    for (const r of mem.reactions.values()) if (Number(r.comment_id) === Number(commentId)) counts[r.type] = (counts[r.type]||0) + 1;
    return counts;
  },

  // NOTIFICATIONS
  addNotificationRow: async (payload) => {
    const id = Date.now();
    const row = Object.assign({}, payload, { id, created_at: new Date().toISOString() });
    mem.notifications.set(id, row);
    return { data: row };
  },
  listNotifications: async (telegramId) => {
    const arr = Array.from(mem.notifications.values()).filter(n => Number(n.telegram_id) === Number(telegramId)).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
    return { data: arr };
  },
  setAdminNotifier: async (text, meta) => {
    const id = Date.now(); mem.notifications.set(id, { id, telegram_id: null, message: text, meta: meta||{}, created_at: new Date().toISOString() });
  },

  // REPORTS
  insertReport: async (payload) => { const id = next('report'); const row = Object.assign({ id, status: 'open', created_at: new Date().toISOString() }, payload); mem.reports.set(id, row); return row; },
  listReports: async (filter={}) => Array.from(mem.reports.values()).filter(r => {
    if (filter.status && r.status !== filter.status) return false;
    if (filter.comment_id && Number(r.comment_id) !== Number(filter.comment_id)) return false;
    return true;
  }),
  getReportById: async (id) => mem.reports.get(Number(id)) || null,
  deleteReport: async (id) => mem.reports.delete(Number(id)),

  // delete helpers
  deleteCommentById: async (id) => { const cid = Number(id); const ok = mem.comments.delete(cid); for (const [rid,r] of mem.replies.entries()) if (Number(r.comment_id) === cid) mem.replies.delete(rid); return ok ? { deleted:true } : { error:'not found' }; },
  deleteReplyById: async (id) => mem.replies.delete(Number(id)) ? { deleted:true } : { error:'not found' },
  deleteThreadById: async (id) => {
    const tid = Number(id);
    const t = mem.threads.get(tid);
    if (t) { const key = normalizeKey(t.canonical_link || t.social_link || ''); if (mem.threadsByCanonical.has(key) && mem.threadsByCanonical.get(key) === tid) mem.threadsByCanonical.delete(key); mem.threads.delete(tid); }
    for (const [cid,c] of mem.comments.entries()) if (Number(c.thread_id) === tid) { mem.comments.delete(cid); for (const [rid,r] of mem.replies.entries()) if (Number(r.comment_id) === Number(cid)) mem.replies.delete(rid); }
    return { deleted: true };
  },

  // expose mem state for debug
  _mem_state: () => mem
};
