// src/utils.js
// Utility helpers: normalize video URL, extract url, encode/decode short codes.

const YOUTUBE_REGEX = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/i;
const TIKTOK_REGEX = /(?:tiktok\.com\/@[^\/]+\/video\/|vm\.tiktok\.com\/|vt\.tiktok\.com\/)(\d+)/i;
const URL_REGEX = /(https?:\/\/[^\s]+)/i;

function extractFirstUrl(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(URL_REGEX);
  return m ? m[0] : null;
}

function normalizeVideoUrl(link) {
  // Returns an object:
  // { normalized_link, provider, provider_id, thumbnail, canonical_link }
  if (!link || typeof link !== 'string') return { normalized_link: link };
  const l = link.trim();

  // YouTube
  const y = l.match(YOUTUBE_REGEX);
  if (y && y[1]) {
    const id = y[1];
    const normalized = `youtube:${id}`;
    const thumbnail = `https://img.youtube.com/vi/${id}/mqdefault.jpg`;
    const canonical = `https://youtu.be/${id}`;
    return { normalized_link: normalized, provider: 'youtube', provider_id: id, thumbnail, canonical_link: canonical };
  }

  // TikTok
  const t = l.match(TIKTOK_REGEX);
  if (t && t[1]) {
    const id = t[1];
    const normalized = `tiktok:${id}`;
    const canonical = `https://www.tiktok.com/share/video/${id}`;
    // TikTok thumbnails aren't reliably accessible via static link; leave thumbnail null
    return { normalized_link: normalized, provider: 'tiktok', provider_id: id, thumbnail: null, canonical_link: canonical };
  }

  // generic host-normalized path
  try {
    const url = new URL(l);
    const normalized = `${url.hostname}${url.pathname}`.replace(/\/+$/, '');
    return { normalized_link: normalized, provider: url.hostname, provider_id: null, thumbnail: null, canonical_link: l };
  } catch (e) {
    return { normalized_link: l };
  }
}

// Shortcode encode/decode base36 uppercase
function encodeShortCode(id) {
  if (id === null || id === undefined) return null;
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  return n.toString(36).toUpperCase();
}

function decodeShortCode(code) {
  if (!code || typeof code !== 'string') return null;
  try {
    const cleaned = code.trim().replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const val = parseInt(cleaned, 36);
    if (Number.isNaN(val)) return null;
    return val;
  } catch (e) {
    return null;
  }
}

module.exports = {
  extractFirstUrl,
  normalizeVideoUrl,
  encodeShortCode,
  decodeShortCode
};
