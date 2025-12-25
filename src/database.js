// src/database.js
// In-memory database wrapper implementing the functions expected by src/bot.js
// NOTE: This is memory-only (data lost on restart). If you want Supabase persistence
// I can provide a wrapper later. For now this is stable and contains all required APIs.

const mem = {
  users: new Map(),            // key: telegram_id -> {telegram_id, username, first_name, free_comments, created_at}
  threads: new Map(),          // key: id -> {id, social_link, canonical_link, provider, provider_id, thumbnail, creator_telegram_id, created_at}
  threadsByCanonical: new Map(), // key: canonical -> threadId
  comments: new Map(),         // key: id -> {id, thread_id, telegram_id, username, first_name, telegram_file_id, duration, created_at}
  replies: new Map(),          // key: id -> {id, comment_id, replier_telegram_id, replier_username, replier_first_name, telegram_file_id, reply_text, created_at}
  payments: new Map(),         // key: id -> payment objects
  favorites: new Set(),        // set of "telegramId:commentId"
  reactions: new Map(),        // key: id -> {id, comment_id, telegram_id, type, created_at}
  notifications: new Map(),    // key: id -> notification row
  reports: new Map(),          // key: id -> report row
  counters: { thread: 1000, comment: 10000, reply: 20000, payment: 30000, reaction: 40000, report: 50000 }
};

function next(kind) {
  if (!mem.counters[kind]) mem.counters[kind] = 1;
  mem.counters[kind] += 1;
  return mem.counters[kind];
}

function normalizeKey(link) {
  if (!link) return link;
  return String(link).trim().replace(/[)\]\.]+$/g,'').toLowerCase().replace(/\/$/,'');
}

// Simple extractors for canonical info (YouTube & TikTok heuristics)
function parseVideoLink(link) {
  if (!link) return { canonicalLink: null, provider: null, id: null, thumbnail: null };
  try {
    const url = new URL(link);
    const host = url.hostname.toLowerCase();
    // YouTube
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      let vid = null;
      if (host.includes('youtu.be')) {
        vid = url.pathname.split('/').filter(Boolean)[0];
      } else {
        vid = url.searchParams.get('v') || (url.pathname.match(/\/video\/([0-9A-Za-z_-]+)/) && RegExp.$1);
      }
      const canonical = vid ? `https://youtube.com/watch?v=${vid}` : link;
      const thumb = vid ? `https://img.youtube.com/vi/${vid}/hqdefault.jpg` : null;
      return { canonicalLink: canonical, provider: 'youtube', id: vid, thumbnail: thumb };
    }
    // TikTok (basic)
    if (host.includes('tiktok.com') || host.includes('vm.tiktok.com')) {
      // Try to extract video id from path like /@user/video/1234567890123456789
      const parts = url.pathname.split('/').filter(Boolean);
      const vid = (parts.indexOf('video') >= 0) ? parts[parts.indexOf('video') + 1] : null;
      const canonical = vid ? `https://www.tiktok.com/@${parts[0]}/video/${vid}` : link;
      // TikTok thumbnails require API; we set null here (bot will still work)
      return { canonicalLink: canonical, provider: 'tiktok', id: vid, thumbnail: null };
    }
    // Fallback: return normalized link as canonical
    return { canonicalLink: normalizeKey(link), provider: null, id: null, thumbnail: null };
  } catch (e) {
    return { canonicalLink: normalizeKey(link), provider: null, id: null, thumbnail: null };
  }
}

// Exported API (async functions)
module.exports = {
  // Informational - always false for in-memory
  isUsingSupabase: async () => false,

  // USERS
  ensureUserRow: async (user) => {
    if (!user || !user.id) return null;
    const key = String(user.id);
    const existing = mem.users.get(key) || { telegram_id: user.id, username: user.username || null, first_name: user.first_name || null, free_comments: 0, created_at: new Date().toISOString() };
    existing.username = user.username || existing.username;
    existing.first_name = user.first_name || existing.first_name;
    mem.users.set(key, existing);
    return existing;
  },

  getUserByTelegramId: async (telegramId) => mem.users.get(String(telegramId)) || null,

  getUserBalance: async (telegramId) => {
    const u = mem.users.get(String(telegramId));
    return u ? Number(u.free_comments || 0) : 0;
  },

  creditUser: async (telegramId, amount) => {
    const key = String(telegramId);
    let u = mem.users.get(key);
    if (!u) {
      u = { telegram_id: telegramId, username: null, first_name: null, free_comments: Number(amount || 0), created_at: new Date().toISOString() };
    } else {
      u.free_comments = Number(u.free_comments || 0) + Number(amount || 0);
    }
    mem.users.set(key, u);
    return u;
  },

  decrementUserBalance: async (telegramId, amount) => {
    const key = String(telegramId);
    const u = mem.users.get(key);
    if (!u) return { error: 'not found' };
    const dec = Number(amount || 1);
    const cur = Number(u.free_comments || 0);
    if (cur < dec) return { error: 'insufficient' };
    u.free_comments = cur - dec;
    mem.users.set(key, u);
    return { data: u };
  },

  // THREADS (videos)
  findOrCreateThread: async (link, creatorTelegramId = null) => {
    const parsed = parseVideoLink(link);
    const canonical = parsed.canonicalLink || normalizeKey(link);
    if (mem.threadsByCanonical.has(canonical)) {
      const tid = mem.threadsByCanonical.get(canonical);
      const t = mem.threads.get(tid);
      if (creatorTelegramId && (!t.creator_telegram_id || t.creator_telegram_id !== creatorTelegramId)) {
        t.creator_telegram_id = creatorTelegramId;
        mem.threads.set(tid, t);
      }
      return t;
    }
    const id = next('thread');
    const row = {
      id,
      social_link: link,
      canonical_link: canonical,
      provider: parsed.provider,
      provider_id: parsed.id ? String(parsed.id) : null,
      thumbnail: parsed.thumbnail || null,
      creator_telegram_id: creatorTelegramId || null,
      created_at: new Date().toISOString()
    };
    mem.threads.set(id, row);
    mem.threadsByCanonical.set(canonical, id);
    return row;
  },

  getThreadByLink: async (link) => {
    const parsed = parseVideoLink(link);
    const canonical = parsed.canonicalLink || normalizeKey(link);
    const id = mem.threadsByCanonical.get(canonical);
    return id ? mem.threads.get(id) : null;
  },

  getThreadById: async (id) => mem.threads.get(Number(id)) || null,

  setThreadCreator: async (threadId, telegramId) => {
    const t = mem.threads.get(Number(threadId));
    if (!t) return null;
    t.creator_telegram_id = telegramId;
    mem.threads.set(Number(threadId), t);
    return t;
  },

  listThreadsByCreator: async (telegramId) => {
    return Array.from(mem.threads.values()).filter(t => Number(t.creator_telegram_id) === Number(telegramId)).sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
  },

  // PAYMENTS
  createPaymentRequest: async (payload) => {
    const id = next('payment');
    const row = Object.assign({ id, status: 'pending', created_at: new Date().toISOString() }, payload);
    mem.payments.set(Number(id), row);
    return row;
  },

  getPaymentById: async (id) => mem.payments.get(Number(id)) || null,

  updatePaymentStatus: async (id, status, updates = {}) => {
    const pid = Number(id);
    const exist = mem.payments.get(pid);
    if (!exist) return { error: 'not found' };
    const updated = Object.assign({}, exist, updates, { status });
    mem.payments.set(pid, updated);
    return { data: updated };
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
    return { data: arr.slice(offset, offset + limit) };
  },

  listCommentsByUser: async (telegramId, limit = 100) => {
    const arr = Array.from(mem.comments.values()).filter(c => Number(c.telegram_id) === Number(telegramId)).sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    return arr.slice(0, limit);
  },

  getCommentById: async (id) => mem.comments.get(Number(id)) || null,

  // REPLIES
  insertReplyRow: async (payload) => {
    const id = next('reply');
    const row = Object.assign({}, payload, { id, created_at: new Date().toISOString() });
    mem.replies.set(Number(id), row);
    return row;
  },

  listReplies: async (commentId) => {
    return Array.from(mem.replies.values()).filter(r => Number(r.comment_id) === Number(commentId)).sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
  },

  deleteReplyById: async (id) => {
    return mem.replies.delete(Number(id)) ? { deleted: true } : { error: 'not found' };
  },

  // FAVORITES
  toggleFavoriteRow: async (telegramId, commentId) => {
    const key = `${telegramId}:${commentId}`;
    if (mem.favorites.has(key)) { mem.favorites.delete(key); return { removed: true }; }
    mem.favorites.add(key); return { removed: false, data: { telegram_id: telegramId, comment_id: commentId } };
  },

  isFavorite: async (telegramId, commentId) => mem.favorites.has(`${telegramId}:${commentId}`),

  listFavoritesForUser: async (telegramId) => {
    const keys = Array.from(mem.favorites).filter(k => k.startsWith(`${telegramId}:`));
    const items = keys.map(k => {
      const cid = Number(k.split(':')[1]);
      return mem.comments.get(cid);
    }).filter(Boolean);
    return items;
  },

  // REACTIONS (one per user per comment)
  toggleReaction: async (telegramId, commentId, type) => {
    // find existing
    for (const [id, r] of mem.reactions.entries()) {
      if (Number(r.comment_id) === Number(commentId) && String(r.telegram_id) === String(telegramId)) {
        if (r.type === type) { mem.reactions.delete(id); return { removed: true }; }
        r.type = type; r.created_at = new Date().toISOString(); mem.reactions.set(id, r); return { updated: true };
      }
    }
    const id = next('reaction');
    const row = { id, comment_id: commentId, telegram_id: telegramId, type, created_at: new Date().toISOString() };
    mem.reactions.set(id, row);
    return { added: true, data: row };
  },

  getReactionCounts: async (commentId) => {
    const counts = { heart: 0, laugh: 0, dislike: 0 };
    for (const r of mem.reactions.values()) {
      if (Number(r.comment_id) === Number(commentId)) counts[r.type] = (counts[r.type] || 0) + 1;
    }
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
    const id = Date.now();
    mem.notifications.set(id, { id, telegram_id: null, message: text, meta: meta || {}, created_at: new Date().toISOString() });
  },

  // REPORTS
  insertReport: async (payload) => {
    const id = next('report');
    const row = Object.assign({ id, status: 'open', created_at: new Date().toISOString() }, payload);
    mem.reports.set(id, row);
    return row;
  },

  listReports: async (filter = {}) => {
    let arr = Array.from(mem.reports.values());
    if (filter.status) arr = arr.filter(r => r.status === filter.status);
    if (filter.comment_id) arr = arr.filter(r => Number(r.comment_id) === Number(filter.comment_id));
    if (filter.reply_id) arr = arr.filter(r => Number(r.reply_id) === Number(filter.reply_id));
    return arr.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  },

  getReportById: async (id) => mem.reports.get(Number(id)) || null,

  deleteReport: async (id) => mem.reports.delete(Number(id)),

  // delete helpers
  deleteCommentById: async (id) => {
    const cid = Number(id);
    const removed = mem.comments.delete(cid);
    // delete replies belonging to that comment
    for (const [rid,r] of Array.from(mem.replies.entries())) if (Number(r.comment_id) === cid) mem.replies.delete(rid);
    return removed ? { deleted: true } : { error: 'not found' };
  },

  deleteThreadById: async (id) => {
    const tid = Number(id);
    const t = mem.threads.get(tid);
    if (t) {
      const key = normalizeKey(t.canonical_link || t.social_link || '');
      if (mem.threadsByCanonical.has(key) && mem.threadsByCanonical.get(key) === tid) mem.threadsByCanonical.delete(key);
      mem.threads.delete(tid);
    }
    for (const [cid,c] of Array.from(mem.comments.entries())) {
      if (Number(c.thread_id) === tid) {
        mem.comments.delete(cid);
        for (const [rid,r] of Array.from(mem.replies.entries())) if (Number(r.comment_id) === Number(cid)) mem.replies.delete(rid);
      }
    }
    return { deleted: true };
  },

  // debug helper
  _mem_state: () => mem
};
