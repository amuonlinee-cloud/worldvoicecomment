// path: src/utils.js
// Common helpers. Safe to require even if envs missing.

const SUPPORTED_HOSTS = [
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'm.tiktok.com',
  'vm.tiktok.com'
];

// Normalize input text
function normalizeInput(text = '') {
  if (!text) return '';
  return String(text).trim();
}

// Extract first URL in a text
function extractFirstUrl(text = '') {
  if (!text) return null;
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  return urlMatch ? urlMatch[0] : null;
}

// Check supported link by hostname substring
function isSupportedLink(url = '') {
  try {
    if (!url) return false;
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return SUPPORTED_HOSTS.some(s => host.includes(s));
  } catch (e) {
    // try matching patterns for tiktok short links like vm.tiktok.com
    const lowered = String(url).toLowerCase();
    return SUPPORTED_HOSTS.some(s => lowered.includes(s));
  }
}

// Try to normalize to a canonical social link (simple heuristics)
function normalizeVideoUrl(url = '') {
  if (!url) return null;
  try {
    const u = new URL(url);
    // YouTube short -> convert to youtube watch link
    if (u.hostname.includes('youtu.be')) {
      const id = u.pathname.slice(1);
      return `https://www.youtube.com/watch?v=${id}`;
    }
    // tiktok short vm.* -> resolve not possible offline; keep original
    if (u.hostname.includes('tiktok.com') || u.hostname.includes('vm.tiktok.com')) {
      return url.split('?')[0];
    }
    return url.split('?')[0];
  } catch (e) {
    return url;
  }
}

// Shortcode encoding/decoding (comment id -> base36 with prefix)
function encodeShortcodeForComment(commentId) {
  if (!commentId) return null;
  return `vc${Number(commentId).toString(36)}`;
}

function decodeShortcodeToCommentId(code) {
  if (!code) return null;
  const c = String(code).trim();
  if (!c.startsWith('vc')) return null;
  try {
    return parseInt(c.slice(2), 36);
  } catch (e) {
    return null;
  }
}

module.exports = {
  normalizeInput,
  extractFirstUrl,
  isSupportedLink,
  normalizeVideoUrl,
  encodeShortcodeForComment,
  decodeShortcodeToCommentId
};
