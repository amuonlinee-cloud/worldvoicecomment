// src/utils.js
// Link normalizer + helpers (YouTube + TikTok with oEmbed thumbnail)

const fetch = global.fetch || (typeof require === 'function' ? (() => { try { return require('node-fetch'); } catch(e){ return null; } })() : null);
const { URL } = require('url');

async function normalizeVideoUrl(link) {
  if (!link || typeof link !== 'string') return { canonicalLink: link, provider: null, id: null, thumbnail: null };
  let urlStr = link.trim().replace(/[<>]/g,'').trim();
  if (!/^https?:\/\//i.test(urlStr)) urlStr = 'https://' + urlStr;
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();

    // YouTube (youtube.com / youtu.be / shorts)
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      let vid = null;
      if (host.includes('youtu.be')) vid = u.pathname.slice(1);
      else {
        vid = u.searchParams.get('v') || null;
        if (!vid && u.pathname && u.pathname.includes('/shorts/')) {
          vid = u.pathname.split('/shorts/')[1].split('/')[0];
        }
      }
      const canonical = vid ? `https://youtube.com/watch?v=${vid}` : urlStr;
      const thumbnail = vid ? `https://img.youtube.com/vi/${vid}/hqdefault.jpg` : null;
      return { canonicalLink: canonical, provider: 'youtube', id: vid, thumbnail };
    }

    // TikTok: try oEmbed for thumbnail
    if (host.includes('tiktok.com') || host.includes('vm.tiktok.com')) {
      let path = u.pathname || '';
      let possibleId = path.split('/').filter(Boolean).slice(-1)[0] || null;
      if (path.includes('/video/')) {
        const parts = path.split('/video/');
        possibleId = (parts[1] || '').split('/')[0] || possibleId;
      }
      const canonical = urlStr;
      // try oEmbed to get thumbnail
      try {
        const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(urlStr)}`;
        if (fetch) {
          const resp = await fetch(oembedUrl, { method: 'GET' });
          if (resp && resp.ok) {
            const j = await resp.json();
            if (j && j.thumbnail_url) {
              return { canonicalLink: canonical, provider: 'tiktok', id: possibleId, thumbnail: j.thumbnail_url };
            }
          }
        }
      } catch (e) {
        // ignore and fallback to no thumbnail
      }
      return { canonicalLink: canonical, provider: 'tiktok', id: possibleId, thumbnail: null };
    }

    // fallback
    return { canonicalLink: urlStr, provider: null, id: null, thumbnail: null };
  } catch (e) {
    return { canonicalLink: link, provider: null, id: null, thumbnail: null };
  }
}

function extractFirstUrl(text) {
  if (!text) return null;
  const m = String(text).match(/\bhttps?:\/\/[^\s)]+/i);
  if (m && m[0]) return m[0].replace(/[),.]+$/,'');
  const m2 = String(text).match(/\b(?:www\.)?(tiktok\.com|youtu\.be|youtube\.com)\/[^\s)]+/i);
  return m2 ? (m2[0].startsWith('http') ? m2[0] : 'https://' + m2[0]) : null;
}

function normalizeInput(s) {
  if (!s) return '';
  return String(s).replace(/\s+/g,' ').trim();
}

function encodeShortCode(id) {
  if (id === undefined || id === null) return '';
  const n = Number(id) || 0;
  return n.toString(36).toUpperCase().padStart(6,'0');
}
function decodeShortCode(code) {
  if (!code) return null;
  try {
    const cleaned = String(code).replace(/[^0-9A-Za-z]/g,'').toLowerCase();
    return parseInt(cleaned, 36);
  } catch (e) { return null; }
}

function normalizeDisplayLink(link) {
  if (!link) return link;
  try {
    let url = new URL(link);
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','igshid'].forEach(p => url.searchParams.delete(p));
    let out = url.toString();
    out = out.replace(/\/$/, '');
    return out;
  } catch (e) { return link; }
}

module.exports = {
  normalizeVideoUrl,
  extractFirstUrl,
  normalizeInput,
  encodeShortCode,
  decodeShortCode,
  normalizeDisplayLink,
  isSupportedLink: (s) => { if (!s) return false; return /\b(tiktok\.com|vm\.tiktok\.com|youtube\.com|youtu\.be)\b/i.test(s); }
};
