// src/utils.js
// link normalizer, URL extractor, short-code encoder/decoder, basic thumbnails

const URL_REGEX = /(https?:\/\/[^\s]+)/i;

// Extract first URL from text (if any)
function extractFirstUrl(text) {
  if (!text) return null;
  const m = text.match(URL_REGEX);
  return m ? m[0] : null;
}

// Normalize video URL to canonical and provide thumbnail when possible
// Supports TikTok (vm.tiktok.com, www.tiktok.com) and YouTube (youtu.be / youtube.com)
async function normalizeVideoUrl(url) {
  if (!url) return null;
  const u = url.trim();

  // TikTok handling
  const tiktokVmMatch = u.match(/vm\.tiktok\.com\/([A-Za-z0-9]+)/i);
  const tiktokFullMatch = u.match(/tiktok\.com\/@([^\/]+)\/video\/([0-9]+)/i);
  if (tiktokFullMatch) {
    const id = tiktokFullMatch[2];
    // canonical link is https://www.tiktok.com/@user/video/<id>
    const canonical = `https://www.tiktok.com/@${tiktokFullMatch[1]}/video/${id}`;
    // thumbnail is not reliably available without API; fallback to tiktok thumbnail heuristic (may not always work)
    const thumbnail = null;
    return { canonical_link: canonical, normalized_link: `tiktok:${id}`, provider: 'tiktok', provider_id: id, thumbnail };
  }
  if (tiktokVmMatch) {
    // vm short link - cannot get id without following redirect; we will use the vm link as normalized key
    const canonical = u;
    return { canonical_link: canonical, normalized_link: `tiktok_vm:${tiktokVmMatch[1]}`, provider: 'tiktok', provider_id: tiktokVmMatch[1], thumbnail: null };
  }

  // YouTube handling
  const ytShort = u.match(/youtu\.be\/([A-Za-z0-9_-]+)/i);
  const ytFull = u.match(/v=([A-Za-z0-9_-]+)/i);
  if (ytShort || ytFull) {
    const id = (ytShort && ytShort[1]) || (ytFull && ytFull[1]);
    const canonical = `https://www.youtube.com/watch?v=${id}`;
    const thumbnail = `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
    return { canonical_link: canonical, normalized_link: `youtube:${id}`, provider: 'youtube', provider_id: id, thumbnail };
  }

  // Generic fallback: use URL as normalized
  const canonical = u;
  return { canonical_link: canonical, normalized_link: `url:${canonical}`, provider: 'generic', provider_id: null, thumbnail: null };
}

// Short code encoding & decoding (base36 with small prefix)
function encodeShortCode(id) {
  if (!id) return null;
  // pad to 5 chars with base36 (enough for millions)
  const val = Number(id);
  if (Number.isNaN(val)) return null;
  const code = val.toString(36).toUpperCase();
  return code;
}
function decodeShortCode(code) {
  if (!code) return null;
  try {
    return parseInt(code.toLowerCase(), 36);
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
