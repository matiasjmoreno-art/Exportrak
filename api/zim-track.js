// api/zim-track.js
const ZIM_CLIENT_ID     = process.env.ZIM_CLIENT_ID     || "adb4bc75-2269-4595-bc23-b643ad278719";
const ZIM_CLIENT_SECRET = process.env.ZIM_CLIENT_SECRET || "9AP8Q~ondXFV4Lu71JOXZI5hNMHkzbF748daqbGM";
const ZIM_SUB_KEY       = process.env.ZIM_SUB_KEY       || "caea18b0a6c6420e9c3bf1893011a641";
const ZIM_BASE          = "https://apigw.zim.com/tracing/v2";

let tokenCache = { token: null, expiry: 0 };
let tokenDebug = [];

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiry - 30000) return tokenCache.token;
  tokenDebug = [];
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
      const txt = await r.text();
      tokenDebug.push({ url: url.slice(-50), status: r.status, body: txt.slice(0, 300) });
      if (r.ok) {
        const d = JSON.parse(txt);
        tokenCache = { token: d.access_token, expiry: now + (d.expires_in || 3600) * 1000 };
        return tokenCache.token;
      }
    } catch (e) {
      tokenDebug.push({ url: url.slice(-50), error: e.message });
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { booking, bl, container, debug } = req.query;
  const reference = (booking || bl || container || "").trim();
  if (!reference) return res.status(400).json({ error: "Parametro requerido" });

  const url = ZIM_BASE + "/" + encodeURIComponent(reference);
  const attempts = [];

  // Intento 1: Bearer + Sub Key
  const token = await getToken();
  if (token) {
    try {
      const r = await fetch(url, {
        headers: {
          "Authorization":             "Bearer " + token,
          "Ocp-Apim-Subscription-Key": ZIM_SUB_KEY,
          "Accept":                    "application/json",
        },
      });
      const txt = await r.text();
      attempts.push({ m: "bearer+sub", s: r.status, b: txt.slice(0, 300) });
      if (r.ok) {
        const data = JSON.parse(txt);
        if (debug === "1") return res.json({ ok: true, method: "bearer+sub", data });
        return res.json(data);
      }
    } catch (e) { attempts.push({ m: "bearer+sub", err: e.message }); }
  }

  // Intento 2: Solo Sub Key
  try {
    const r = await fetch(url, {
      headers: { "Ocp-Apim-Subscription-Key": ZIM_SUB_KEY, "Accept": "application/json" },
    });
    const txt = await r.text();
    attempts.push({ m: "sub_only", s: r.status, b: txt.slice(0, 300) });
    if (r.ok) {
      const data = JSON.parse(txt);
      if (debug === "1") return res.json({ ok: true, method: "sub_only", data });
      return res.json(data);
    }
  } catch (e) { attempts.push({ m: "sub_only", err: e.message }); }

  return res.status(401).json({ error: "ZIM auth fallida", tokenDebug, attempts });
}
