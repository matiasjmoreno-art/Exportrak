// api/zim-track.js — Proxy Vercel para ZIM Tracing API v2
// ZIM requiere OAuth2 Bearer token (client_credentials) + Ocp-Apim-Subscription-Key

const ZIM_CLIENT_ID     = process.env.ZIM_CLIENT_ID     || "060221d3-49e9-43da-b507-348a67c1c9b6";
const ZIM_CLIENT_SECRET = process.env.ZIM_CLIENT_SECRET || "WPC8Q~wA0LHiFLaVAtmTcifyIYzcWJ0Fg6hMeda~";
const ZIM_SUB_KEY       = process.env.ZIM_SUB_KEY       || "caea18b0a6c6420e9c3bf1893011a641";
const ZIM_BASE          = "https://apigw.zim.com/tracing/v2";

let tokenCache = { token: null, expiry: 0 };

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiry - 30000) return tokenCache.token;
  const TOKEN_URLS = [
    "https://login.microsoftonline.com/zimidapimprod.onmicrosoft.com/oauth2/v2.0/token",
    "https://zimidapimprod.b2clogin.com/zimidapimprod.onmicrosoft.com/oauth2/v2.0/token",
  ];
  for (const url of TOKEN_URLS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type:    "client_credentials",
          client_id:     ZIM_CLIENT_ID,
          client_secret: ZIM_CLIENT_SECRET,
          scope:         ZIM_CLIENT_ID + "/.default",
        }).toString(),
      });
      if (r.ok) {
        const d = await r.json();
        tokenCache = { token: d.access_token, expiry: now + (d.expires_in || 3600) * 1000 };
        return tokenCache.token;
      }
    } catch (e) {}
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { booking, bl, container, debug } = req.query;
  const reference = (booking || bl || container || "").trim();
  if (!reference) return res.status(400).json({ error: "Parametro requerido: booking, bl o container" });

  const url = ZIM_BASE + "/" + encodeURIComponent(reference);
  const attempts = [];

  // Intento 1: Bearer + Sub Key
  try {
    const token = await getToken();
    if (token) {
      const r = await fetch(url, {
        headers: {
          "Authorization":             "Bearer " + token,
          "Ocp-Apim-Subscription-Key": ZIM_SUB_KEY,
          "Accept":                    "application/json",
        },
      });
      const txt = await r.text();
      attempts.push({ m: "bearer+sub", s: r.status, b: txt.slice(0, 200) });
      if (r.ok) {
        const data = JSON.parse(txt);
        if (debug === "1") return res.json({ ok: true, method: "bearer+sub", data });
        return res.json(data);
      }
    }
  } catch (e) { attempts.push({ m: "bearer+sub", err: e.message }); }

  // Intento 2: Solo Sub Key
  try {
    const r = await fetch(url, {
      headers: {
        "Ocp-Apim-Subscription-Key": ZIM_SUB_KEY,
        "Accept": "application/json",
        "Cache-Control": "no-cache",
      },
    });
    const txt = await r.text();
    attempts.push({ m: "sub_only", s: r.status, b: txt.slice(0, 200) });
    if (r.ok) {
      const data = JSON.parse(txt);
      if (debug === "1") return res.json({ ok: true, method: "sub_only", data });
      return res.json(data);
    }
    if (debug === "1") return res.json({ error: "ZIM auth fallida", attempts });
    return res.status(r.status).json({ error: "ZIM API error", detail: txt.slice(0, 300) });
  } catch (e) { attempts.push({ m: "sub_only", err: e.message }); }

  return res.status(401).json({ error: "ZIM auth fallida", attempts });
                                               }
