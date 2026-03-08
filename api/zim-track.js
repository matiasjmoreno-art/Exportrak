// api/zim-track.js — Proxy Vercel para ZIM Tracing API v2
const ZIM_SUB_KEY = process.env.ZIM_SUB_KEY || "caea18b0a6c6420e9c3bf1893011a641";
const ZIM_BASE    = "https://apigw.zim.com/tracing/v2";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { booking, bl, container, debug } = req.query;
  const reference = (booking || bl || container || "").trim();
  if (!reference) return res.status(400).json({ error: "Parametro requerido: booking, bl o container" });

  try {
    const zimRes = await fetch(`${ZIM_BASE}/${encodeURIComponent(reference)}`, {
      headers: {
        "Ocp-Apim-Subscription-Key": ZIM_SUB_KEY,
        "Accept": "application/json",
        "Cache-Control": "no-cache",
      },
    });

    const rawText = await zimRes.text();

    if (debug === "1") {
      return res.status(200).json({ status: zimRes.status, raw: rawText.slice(0, 3000) });
    }

    if (!zimRes.ok) {
      return res.status(zimRes.status).json({ error: `ZIM API HTTP ${zimRes.status}`, detail: rawText.slice(0, 300) });
    }

    let data;
    try { data = JSON.parse(rawText); } catch {
      return res.status(502).json({ error: "Respuesta invalida de ZIM" });
    }

    return res.status(200).json(data);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
        }
