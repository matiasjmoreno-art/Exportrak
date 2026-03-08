// api/zim-track.js — Proxy Vercel para ZIM Tracing API
// Produccion usa solo Subscription Key (sin JWT) en endpoint v1
const ZIM_SUB_KEY = process.env.ZIM_SUB_KEY || "caea18b0a6c6420e9c3bf1893011a641";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { booking, bl, container, debug } = req.query;
  const reference = (booking || bl || container || "").trim();
  if (!reference) return res.status(400).json({ error: "Parametro requerido: booking, bl o container" });

  const attempts = [];

  // Intento 1: v2 con subscription key
  try {
    const r = await fetch("https://apigw.zim.com/tracing/v2/" + encodeURIComponent(reference), {
      headers: { "Ocp-Apim-Subscription-Key": ZIM_SUB_KEY, "Accept": "application/json" },
    });
    const txt = await r.text();
    attempts.push({ endpoint: "v2", s: r.status, b: txt.slice(0, 300) });
    if (r.ok) {
      const data = JSON.parse(txt);
      if (debug === "1") return res.json({ ok: true, endpoint: "v2", data });
      return res.json(data);
    }
  } catch (e) { attempts.push({ endpoint: "v2", err: e.message }); }

  // Intento 2: v1 con subscription key
  try {
    const r = await fetch("https://apigw.zim.com/tracing/v1/" + encodeURIComponent(reference), {
      headers: { "Ocp-Apim-Subscription-Key": ZIM_SUB_KEY, "Accept": "application/json" },
    });
    const txt = await r.text();
    attempts.push({ endpoint: "v1", s: r.status, b: txt.slice(0, 300) });
    if (r.ok) {
      const data = JSON.parse(txt);
      if (debug === "1") return res.json({ ok: true, endpoint: "v1", data });
      return res.json(data);
    }
  } catch (e) { attempts.push({ endpoint: "v1", err: e.message }); }

  return res.status(401).json({ error: "ZIM auth fallida", attempts });
}
