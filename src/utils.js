// src/utils.js
// utilities: normalizeVideoUrl with redirect resolve for short TikTok links, encode/decode short codes, extract url.

const URL_RE = /(https?:\/\/[^\s]+)/i;

// helper fetch with timeout - node fetch in Vercel available in Node 18+; fallback will error and be caught
async function _fetchWithTimeout(url, opts = {}, timeout = 5000) {
  if (typeof fetch !== 'undefined') {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, Object.assign({}, opts, { signal: controller.signal, redirect: 'follow' }));
      clearTimeout(id);
      return res;
    } catch (e) {
      clearTimeout(id);
      throw e;
    }
  } else {
    throw new Error('fetch not available');
  }
}

function normalizeInput(s) {
  if (s === undefined || s === null) return '';
  return String(s).trim();
}

function extractFirstUrl(text) {
  if (!text) return null;
  const m = String(text).match(URL_RE);
  return m ? m[1] : null;
}

function isSupportedLink(s) {
  if (!s) return false;
  s = String(s);
  return /tiktok\.com|youtube\.com|youtu\.be|vm\.tiktok\.com/i.test(s);
}

function _normalizeUrlForDb(raw) {
  if (!raw) return raw;
  let str = String(raw).trim();
  str = str.replace(/[)\]\.,]+$/g, '').trim();
  try {
    const u = new URL(str);
    u.hostname = u.hostname.toLowerCase();
    u.pathname = u.pathname.replace(/\/+$/g, '');
    u.pathname = u.pathname.toLowerCase();
    let search = '';
    if (/youtube\.com$/i.test(u.hostname) && u.search) search = u.search;
    const clean = `${u.protocol}//${u.hostname}${u.pathname}${search}`;
    return clean.replace(/\/$/,'');
  } catch (e) { return str.toLowerCase().replace(/\/$/,''); }
}

/**
 * normalizeVideoUrl(link)
 * returns { canonicalLink, provider, id }
 */
async function normalizeVideoUrl(link) {
  if (!link) return { canonicalLink: link };
  let raw = String(link).trim();
  raw = raw.replace(/[)\]\.]+$/g, '').trim();

  // If short TikTok (vm.tiktok.com), try to follow redirect to full link
  try {
    const tmp = new URL(raw);
    const host = tmp.hostname.toLowerCase();
    if (host.includes('vm.tiktok.com') || host.includes('vt.tiktok.com')) {
      try {
        const res = await _fetchWithTimeout(raw, { method: 'GET' }, 6000);
        if (res && res.url) raw = String(res.url).trim();
      } catch (e) {
        // ignore fetch failures
      }
    }
  } catch (e) {}

  // YouTube checks
  const ytShort = raw.match(/youtu\.be\/([A-Za-z0-9_\-]+)/i);
  if (ytShort) {
    const id = ytShort[1];
    const canonical = `https://www.youtube.com/watch?v=${id}`;
    return { provider: 'youtube', id, canonicalLink: _normalizeUrlForDb(canonical) };
  }
  const ytFull = raw.match(/[?&]v=([A-Za-z0-9_\-]+)/i);
  if (ytFull) {
    const id = ytFull[1];
    const canonical = `https://www.youtube.com/watch?v=${id}`;
    return { provider: 'youtube', id, canonicalLink: _normalizeUrlForDb(canonical) };
  }
  const ytEmbed = raw.match(/\/embed\/([A-Za-z0-9_\-]+)/i);
  if (ytEmbed) {
    const id = ytEmbed[1];
    const canonical = `https://www.youtube.com/watch?v=${id}`;
    return { provider: 'youtube', id, canonicalLink: _normalizeUrlForDb(canonical) };
  }

  // TikTok detection
  const ttLong = raw.match(/tiktok\.com\/.*\/video\/([0-9]+)/i);
  if (ttLong) {
    const id = ttLong[1];
    const canonical = `https://www.tiktok.com/@video/${id}`;
    return { provider: 'tiktok', id: String(id), canonicalLink: _normalizeUrlForDb(canonical) };
  }
  const ttV = raw.match(/tiktok\.com\/v\/([0-9]+)/i) || raw.match(/\/v\/([0-9]+)\.html/i);
  if (ttV) {
    const id = ttV[1];
    const canonical = `https://www.tiktok.com/@video/${id}`;
    return { provider: 'tiktok', id: String(id), canonicalLink: _normalizeUrlForDb(canonical) };
  }
  const ttShort = raw.match(/vm\.tiktok\.com\/([A-Za-z0-9\/\-_]+)/i);
  if (ttShort) {
    return { provider: 'tiktok', canonicalLink: _normalizeUrlForDb(raw) };
  }

  // instagram reels
  const ig = raw.match(/instagram\.com\/(?:reel|p)\/([A-Za-z0-9_\-]+)/i);
  if (ig) {
    const id = ig[1];
    const canonical = `https://www.instagram.com/p/${id}`;
    return { provider: 'instagram', id, canonicalLink: _normalizeUrlForDb(canonical) };
  }

  return { canonicalLink: _normalizeUrlForDb(raw) };
}

function encodeShortCode(id) {
  if (id === undefined || id === null) return '';
  const v = Number(id) || 0;
  return v.toString(36).toUpperCase().padStart(6, '0');
}
function decodeShortCode(code) {
  if (!code) return null;
  try { return parseInt(String(code).toLowerCase(), 36); } catch(e) { return null; }
}

module.exports = {
  normalizeInput,
  extractFirstUrl,
  isSupportedLink,
  normalizeVideoUrl,
  encodeShortCode,
  decodeShortCode
};
