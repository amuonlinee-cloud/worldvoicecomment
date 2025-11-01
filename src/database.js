// src/database.js
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Supabase env vars missing: SUPABASE_URL, SUPABASE_KEY. Add them to your .env or env on host.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ensure user row exists (upsert)
async function ensureUserRow(telegramUser) {
  if (!telegramUser || !telegramUser.id) throw new Error('telegramUser missing');
  const payload = {
    telegram_id: telegramUser.id,
    username: telegramUser.username ?? null,
    first_name: telegramUser.first_name ?? null
  };
  const { error } = await supabase.from('users').upsert([payload], { onConflict: 'telegram_id' });
  if (error) throw error;
  return true;
}

async function createThread(social_link, creator_telegram_id = null) {
  const { data: existing } = await supabase.from('threads').select('*').eq('social_link', social_link).limit(1).maybeSingle();
  if (existing) return existing;
  const payload = { social_link };
  if (creator_telegram_id) payload.creator_telegram_id = creator_telegram_id;
  const { data, error } = await supabase.from('threads').insert([payload]).select().maybeSingle();
  if (error) throw error;
  return data;
}

async function getThreadByLink(link) {
  const { data } = await supabase.from('threads').select('*').eq('social_link', link).limit(1).maybeSingle();
  return data || null;
}

async function insertVoiceComment(payload) {
  // payload: { thread_id, telegram_id, username, first_name, telegram_file_id, duration }
  const { data, error } = await supabase.from('voice_comments').insert([payload]).select().maybeSingle();
  return { data, error };
}

async function listCommentsByThread(threadId, offset = 0, limit = 15) {
  const from = offset;
  const to = offset + limit - 1;
  const { data, error } = await supabase.from('voice_comments')
    .select('*')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
    .range(from, to);
  return { data, error };
}

async function getCommentById(id) {
  const { data } = await supabase.from('voice_comments').select('*').eq('id', id).limit(1).maybeSingle();
  return data || null;
}

async function insertReplyRow(payload) {
  // payload: { comment_id, replier_telegram_id, replier_username, replier_first_name, telegram_file_id?, telegram_photo_id?, reply_text? }
  const { data, error } = await supabase.from('voice_replies').insert([payload]).select().maybeSingle();
  return { data, error };
}

async function insertReactionRow(payload) {
  // payload: { comment_id, user_id, type }
  // simple insert (could add dedupe logic if needed)
  const { data, error } = await supabase.from('voice_reactions').insert([payload]).select().maybeSingle();
  return { data, error };
}

async function addNotificationRow(payload) {
  const { data, error } = await supabase.from('notifications').insert([payload]).select().maybeSingle();
  return { data, error };
}

async function listNotifications(telegram_id, type = null, limit = 20) {
  let q = supabase.from('notifications').select('*').eq('telegram_id', telegram_id).order('created_at', { ascending: false }).limit(limit);
  if (type) q = q.eq('type', type);
  const { data, error } = await q;
  return { data, error };
}

async function markAllNotificationsRead(telegram_id) {
  const { error } = await supabase.from('notifications').update({ read: true }).eq('telegram_id', telegram_id);
  return { error };
}

async function toggleFavoriteRow(telegram_id, comment_id) {
  // if exists remove, else add
  const { data: existing } = await supabase.from('favorites').select('*').eq('telegram_id', telegram_id).eq('comment_id', comment_id).limit(1).maybeSingle();
  if (existing) {
    const { error } = await supabase.from('favorites').delete().eq('id', existing.id);
    return { removed: true, error };
  } else {
    const { data, error } = await supabase.from('favorites').insert([{ telegram_id, comment_id }]).select().maybeSingle();
    return { removed: false, data, error };
  }
}

async function listFavoritesForUser(telegram_id) {
  const { data: favs, error } = await supabase.from('favorites').select('comment_id').eq('telegram_id', telegram_id).order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  if (!favs || favs.length === 0) return [];
  const ids = favs.map(f => f.comment_id);
  const { data: comments } = await supabase.from('voice_comments').select('*').in('id', ids).order('created_at', { ascending: false });
  return comments || [];
}

async function searchCommentById(id) {
  const { data } = await supabase.from('voice_comments').select('*').eq('id', id).limit(1).maybeSingle();
  return data || null;
}

// NEW: isFavorite helper used by bot to show star state
async function isFavorite(telegram_id, comment_id) {
  if (!telegram_id || !comment_id) return false;
  try {
    const { data } = await supabase.from('favorites').select('*').eq('telegram_id', telegram_id).eq('comment_id', comment_id).limit(1).maybeSingle();
    return !!data;
  } catch (e) {
    console.error('isFavorite error', e);
    return false;
  }
}

module.exports = {
  supabase,
  ensureUserRow,
  createThread,
  getThreadByLink,
  insertVoiceComment,
  listCommentsByThread,
  getCommentById,
  insertReplyRow,
  insertReactionRow,
  addNotificationRow,
  listNotifications,
  markAllNotificationsRead,
  toggleFavoriteRow,
  listFavoritesForUser,
  searchCommentById,
  isFavorite
};
