// api/db-check.js
module.exports = async (req, res) => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  if (!SUPABASE_URL) return res.status(400).send({ ok: false, reason: 'SUPABASE_URL not set' });

  try {
    // Ping the Supabase host root
    const r = await fetch(SUPABASE_URL, { method: 'GET' });
    return res.status(200).json({ ok: true, status: r.status, statusText: r.statusText, host: new URL(SUPABASE_URL).hostname });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e && (e.stack || e.message || e)) });
  }
};
