// src/utils.js
// robust normalizeVideoUrl, extractFirstUrl, encode/decode codes
const URL_RE = /(https?:\/\/[^\s)]+)/i;

// follow redirects for vm.tiktok if possible
async function _fetchFollow(url, timeout=5000) {
  if (typeof fetch === 'undefined') throw new Error('fetch not available');
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ac.signal });
    clearTimeout(id);
    return res;
  } catch (e) { clearTimeout(id); throw e; }
}

function extractFirstUrl(text) {
  if (!text) return null;
  const m = String(text).match(URL_RE);
  return m ? m[1].replace(/[),.]+$/,'') : null;
}

function _cleanUrl(raw) {
  if (!raw) return raw;
  let s = String(raw).trim();
  s = s.replace(/[)\]\.]+$/g, '');
  try {
    const u = new URL(s);
    u.hostname = u.hostname.toLowerCase();
    u.pathname = u.pathname.replace(/\/+$/,'');
    // keep v param for youtube
    const search = (u.searchParams && (u.searchParams.get('v') ? `?v=${u.searchParams.get('v')}` : '')) || '';
    return `${u.protocol}//${u.hostname}${u.pathname}${search}`.replace(/\/$/,'');
  } catch (e) {
    return s.toLowerCase().replace(/\/$/,'');
  }
}

async function normalizeVideoUrl(link) {
  if (!link) return { canonicalLink: null };
  let raw = String(link).trim().replace(/[)\]\.]+$/g,'');
  // follow short tiktok redirects
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (host.includes('vm.tiktok.com') || host.includes('vt.tiktok.com')) {
      try {
        const r = await _fetchFollow(raw, 5000);
        if (r && r.url) raw = r.url;
      } catch (e) {
        // ignore
      }
    }
  } catch (e) {}

  // YouTube cases
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (host.includes('youtu.be')) {
      const vid = u.pathname.split('/').filter(Boolean)[0];
      if (vid) return { provider: 'youtube', id: vid, canonicalLink: _cleanUrl(`https://www.youtube.com/watch?v=${vid}`), thumbnail: `https://img.youtube.com/vi/${vid}/hqdefault.jpg` };
    }
    if (host.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return { provider: 'youtube', id: v, canonicalLink: _cleanUrl(`https://www.youtube.com/watch?v=${v}`), thumbnail: `https://img.youtube.com/vi/${v}/hqdefault.jpg` };
      const embed = u.pathname.match(/\/embed\/([A-Za-z0-9_\-]+)/);
      if (embed) return { provider: 'youtube', id: embed[1], canonicalLink: _cleanUrl(`https://www.youtube.com/watch?v=${embed[1]}`), thumbnail: `https://img.youtube.com/vi/${embed[1]}/hqdefault.jpg` };
    }
  } catch (e) {}

  // TikTok long link
  try {
    const m = raw.match(/tiktok\.com\/.*\/video\/([0-9]+)/i);
    if (m) {
      const id = m[1];
      // best we can do
      return { provider: 'tiktok', id: String(id), canonicalLink: _cleanUrl(raw), thumbnail: null };
    }
  } catch (e) {}

  return { canonicalLink: _cleanUrl(raw) };
}

function encodeShortCode(id) {
  if (id === undefined || id === null) return '';
  const n = Number(id) || 0;
  return n.toString(36).toUpperCase().padStart(6, '0');
}
function decodeShortCode(code) {
  if (!code) return null;
  try { return parseInt(String(code).toLowerCase(), 36); } catch (e) { return null; }
}

module.exports = { extractFirstUrl, normalizeVideoUrl, _cleanUrl: _cleanUrl, encodeShortCode, decodeShortCode };
