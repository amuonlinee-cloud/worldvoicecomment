// src/utils.js
// Helpers: URL extraction, normalization for YouTube/TikTok links, short code encoding/decoding, etc.

function normalizeInput(s) {
  if (!s && s !== 0) return '';
  return String(s).trim();
}

function extractFirstUrl(s) {
  if (!s) return null;
  const m = String(s).match(/\bhttps?:\/\/[^\s)]+/i);
  if (!m) return null;
  // trim trailing punctuation
  return m[0].replace(/[),.]+$/,'');
}

async function normalizeVideoUrl(link) {
  // Return { canonicalLink, provider, id, thumbnail } for youtube/tiktok heuristics
  if (!link) return { canonicalLink: null, provider: null, id: null, thumbnail: null };
  try {
    const url = new URL(link);
    const host = url.hostname.toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      let vid = null;
      if (host.includes('youtu.be')) vid = url.pathname.split('/').filter(Boolean)[0];
      else vid = url.searchParams.get('v') || (url.pathname.match(/\/video\/([0-9A-Za-z_-]+)/) && RegExp.$1);
      if (!vid) return { canonicalLink: String(link).trim(), provider: 'youtube', id: null, thumbnail: null };
      return { canonicalLink: `https://youtube.com/watch?v=${vid}`, provider: 'youtube', id: vid, thumbnail: `https://img.youtube.com/vi/${vid}/hqdefault.jpg` };
    }
    if (host.includes('tiktok.com') || host.includes('vm.tiktok.com')) {
      const parts = url.pathname.split('/').filter(Boolean);
      const idx = parts.indexOf('video');
      const vid = idx >= 0 ? parts[idx+1] : null;
      // If vm.tiktok.com shortened link, canonicalization is limited without fetch
      const canonical = vid ? `https://www.tiktok.com/@${parts[0]}/video/${vid}` : String(link).trim();
      return { canonicalLink: canonical, provider: 'tiktok', id: vid, thumbnail: null };
    }
    // default: return normalized trimmed link
    return { canonicalLink: String(link).trim(), provider: null, id: null, thumbnail: null };
  } catch (e) {
    return { canonicalLink: String(link).trim(), provider: null, id: null, thumbnail: null };
  }
}

function encodeShortCode(id) {
  try {
    const n = Number(id) || 0;
    // base36 uppercase, pad to 6 for aesthetics
    return n.toString(36).toUpperCase().padStart(6,'0');
  } catch (e) {
    return String(id);
  }
}

function decodeShortCode(code) {
  try {
    if (!code) return null;
    const cleaned = String(code).replace(/[^0-9A-Za-z]/g,'');
    const n = parseInt(cleaned.toLowerCase(), 36);
    return Number.isNaN(n) ? null : n;
  } catch (e) {
    return null;
  }
}

function isSupportedLink(s) {
  if (!s) return false;
  return /\b(tiktok\.com|vm\.tiktok\.com|youtube\.com|youtu\.be)\b/i.test(String(s));
}

module.exports = {
  normalizeInput,
  extractFirstUrl,
  normalizeVideoUrl,
  encodeShortCode,
  decodeShortCode,
  isSupportedLink
};
