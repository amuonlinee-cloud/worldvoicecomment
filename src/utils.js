// src/utils.js
// Utilities for link parsing, short code encoding/decoding, normalization.
// Enhanced: attempts to follow redirects for short links (vm.tiktok) to extract canonical video id.

const URL_RE = /(https?:\/\/[^\s]+)/i;

// small helper to run fetch with timeout
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
    // no fetch available (older node) - throw so caller falls back
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

// lowercases host + pathname and strips common trailing punctuation and trailing slashes
function _normalizeUrlForDb(raw) {
  if (!raw) return raw;
  let str = String(raw).trim();
  // strip trailing punctuation that people paste: . , ) ] etc
  str = str.replace(/[)\]\.,]+$/g, '').trim();
  try {
    const u = new URL(str);
    u.hostname = u.hostname.toLowerCase();
    // normalize pathname: remove trailing slashes
    u.pathname = u.pathname.replace(/\/+$/g, '');
    // lowercase pathname (helps short link matching)
    u.pathname = u.pathname.toLowerCase();
    // keep query for youtube watch (we handle 'v' explicitly), otherwise drop search
    let search = '';
    if (/youtube\.com$/i.test(u.hostname) && u.search) {
      search = u.search;
    }
    const clean = `${u.protocol}//${u.hostname}${u.pathname}${search}`;
    return clean.replace(/\/$/,'');
  } catch (e) {
    // fallback: lowercase and drop trailing slash
    return str.toLowerCase().replace(/\/$/,'');
  }
}

/**
 * normalizeVideoUrl(link)
 * returns { canonicalLink, provider, id }
 *
 * Attempt order:
 *  - If link is a short vm.tiktok link or other short link: try an HTTP fetch to follow redirect and read response.url
 *  - Extract youtube id (v/) or youtu.be
 *  - Extract tiktok numeric id from /video/<id> or /v/<id>
 *  - If all else fails, return normalized db-friendly version of the provided link
 */
async function normalizeVideoUrl(link) {
  if (!link) return { canonicalLink: link };

  let raw = String(link).trim();
  raw = raw.replace(/[)\]\.]+$/g, '').trim();

  // Try to fetch redirect target for short hosts (vm.tiktok.com)
  try {
    const tmpUrl = new URL(raw);
    const host = tmpUrl.hostname.toLowerCase();
    if (host.includes('vm.tiktok.com') || host.includes('vt.tiktok.com')) {
      try {
        const res = await _fetchWithTimeout(raw, { method: 'GET' }, 6000);
        // response.url is the final url after redirects
        if (res && res.url) raw = String(res.url).trim();
      } catch (e) {
        // fetch failed (timeout or blocked) -> we'll continue with best-effort on original raw
      }
    }
  } catch (e) {
    // not a full url parseable - ignore
  }

  // YOUTUBE detection
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

  // TIKTOK detection - long form /@user/video/<id>
  const ttLong = raw.match(/tiktok\.com\/.*\/video\/([0-9]+)/i);
  if (ttLong) {
    const id = ttLong[1];
    const canonical = `https://www.tiktok.com/@video/${id}`;
    return { provider: 'tiktok', id: String(id), canonicalLink: _normalizeUrlForDb(canonical) };
  }
  // /v/<id> form
  const ttV = raw.match(/tiktok\.com\/v\/([0-9]+)/i) || raw.match(/\/v\/([0-9]+)\.html/i);
  if (ttV) {
    const id = ttV[1];
    const canonical = `https://www.tiktok.com/@video/${id}`;
    return { provider: 'tiktok', id: String(id), canonicalLink: _normalizeUrlForDb(canonical) };
  }
  // short vm.tiktok or unresolved short forms - don't fail, return normalized short
  const ttShort = raw.match(/vm\.tiktok\.com\/([A-Za-z0-9\/\-_]+)/i);
  if (ttShort) {
    return { provider: 'tiktok', canonicalLink: _normalizeUrlForDb(raw) };
  }

  // Instagram reels/p/
  const ig = raw.match(/instagram\.com\/(?:reel|p)\/([A-Za-z0-9_\-]+)/i);
  if (ig) {
    const id = ig[1];
    const canonical = `https://www.instagram.com/p/${id}`;
    return { provider: 'instagram', id, canonicalLink: _normalizeUrlForDb(canonical) };
  }

  // Fallback: normalized db-friendly string
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
