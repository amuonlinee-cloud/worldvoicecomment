// src/utils.js
// Simple helpers: URL extraction, normalize video links (YouTube/TikTok basic), shortcode encoding/decoding

const URL_REGEX = /(https?:\/\/[^\s]+)/i;

function extractFirstUrl(text) {
  if (!text) return null;
  const m = text.match(URL_REGEX);
  return m ? m[0] : null;
}

function normalizeVideoUrl(raw) {
  // returns { canonical_link, normalized_link, provider, provider_id, thumbnail }
  if (!raw) return null;
  const u = raw.trim();

  // YouTube: youtu.be/<id> or watch?v=<id>
  const yShort = u.match(/youtu\.be\/([A-Za-z0-9_\-]+)/i);
  const yFull = u.match(/[?&]v=([A-Za-z0-9_\-]+)/i);
  if (yShort || yFull) {
    const id = (yShort && yShort[1]) || (yFull && yFull[1]);
    if (id) {
      return {
        canonical_link: `https://www.youtube.com/watch?v=${id}`,
        normalized_link: `youtube:${id}`,
        provider: 'youtube',
        provider_id: id,
        thumbnail: `https://img.youtube.com/vi/${id}/hqdefault.jpg`
      };
    }
  }

  // TikTok: try to detect /video/<id> or vm.tiktok short
  const tFull = u.match(/tiktok\.com\/@([^\/]+)\/video\/([0-9]+)/i);
  if (tFull) {
    const id = tFull[2];
    const user = tFull[1];
    return {
      canonical_link: `https://www.tiktok.com/@${user}/video/${id}`,
      normalized_link: `tiktok:${id}`,
      provider: 'tiktok',
      provider_id: id,
      thumbnail: null
    };
  }
  const vmMatch = u.match(/vm\.tiktok\.com\/([A-Za-z0-9]+)/i);
  if (vmMatch) {
    const token = vmMatch[1];
    // short link: use token as normalized key
    return {
      canonical_link: u,
      normalized_link: `tiktok_vm:${token}`,
      provider: 'tiktok',
      provider_id: token,
      thumbnail: null
    };
  }

  // Otherwise fallback to normalized as URL string
  return {
    canonical_link: u,
    normalized_link: `url:${u}`,
    provider: 'generic',
    provider_id: null,
    thumbnail: null
  };
}

// short code encoding/decoding: use base36 uppercase
function encodeShortCode(id) {
  if (!id && id !== 0) return null;
  const num = Number(id);
  if (Number.isNaN(num)) return null;
  // produce uppercase base36 string
  return num.toString(36).toUpperCase();
}
function decodeShortCode(code) {
  if (!code) return null;
  try {
    return parseInt(String(code).toLowerCase(), 36);
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
