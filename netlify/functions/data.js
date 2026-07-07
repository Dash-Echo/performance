// functions/api/data.js  (Cloudflare Pages Function) — FASE 1
// -----------------------------------------------------------------------------
// GA4  -> API NATIVA do Google (Analytics Data API v1beta), sem Windsor.
// Google Ads + Meta -> ainda via Windsor.ai (serão migrados nas fases 2 e 3).
//
// Variáveis de ambiente necessárias (Cloudflare → Settings → Variables):
//   GA_CLIENT_EMAIL   -> campo client_email do JSON da conta de serviço
//   GA_PRIVATE_KEY    -> campo private_key do JSON (com as linhas BEGIN/END)
//   WINDSOR_API_KEY   -> a mesma de sempre (ainda usada p/ Ads e Meta)
//
// O front-end continua chamando fetch('/api/data') e recebe o MESMO formato.
// -----------------------------------------------------------------------------

const GA4_PROPERTY = "339344434";
const WINDSOR_BASE = "https://connectors.windsor.ai";
const GADS_ACCT = "431-775-8593";
const META_ACCT = "1984275108541772";
const DATE_PRESET = "last_90d";

// ---------- utilidades ----------
function num(v) { return typeof v === "number" ? v : parseFloat(v) || 0; }

// base64url a partir de uma string ou ArrayBuffer
function b64url(input) {
  let bytes;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = new Uint8Array(input);
  }
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Converte a private_key PEM (PKCS#8) para o formato que a Web Crypto aceita
function pemToArrayBuffer(pem) {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(clean);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// ---------- OAuth: gera access_token do Google a partir da conta de serviço ----------
async function getGoogleToken(clientEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );

  const jwt = `${unsigned}.${b64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Google token: HTTP ${res.status} ${t}`);
  }
  const json = await res.json();
  return json.access_token;
}

// ---------- GA4: runReport (sessões, usuários ativos, novos usuários por dia) ----------
async function fetchGA4(token) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY}:runReport`;
  const body = {
    dateRanges: [{ startDate: "90daysAgo", endDate: "today" }],
    dimensions: [{ name: "date" }],
    metrics: [
      { name: "sessions" },
      { name: "activeUsers" },
      { name: "newUsers" },
    ],
    orderBys: [{ dimension: { dimensionName: "date" } }],
    limit: 100000,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GA4 runReport: HTTP ${res.status} ${t}`);
  }

  const json = await res.json();
  const rows = json.rows || [];
  // GA4 devolve a data como "20260601"; convertemos p/ "2026-06-01"
  return rows.map((r) => {
    const raw = r.dimensionValues[0].value; // YYYYMMDD
    const d = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    return {
      d,
      ses: Math.round(num(r.metricValues[0].value)),
      usr: Math.round(num(r.metricValues[1].value)),
      new: Math.round(num(r.metricValues[2].value)),
    };
  });
}

// ---------- Windsor (ainda usado p/ Google Ads e Meta) ----------
async function fetchWindsor(connector, fields, accounts, key) {
  if (!key) throw new Error("WINDSOR_API_KEY não configurada");
  const params = new URLSearchParams({
    api_key: key,
    date_preset: DATE_PRESET,
    fields: fields.join(","),
  });
  if (accounts) params.set("accounts", accounts);
  const res = await fetch(`${WINDSOR_BASE}/${connector}?${params.toString()}`);
  if (!res.ok) throw new Error(`${connector}: HTTP ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : (json.data || []);
}

// ---------- handler ----------
export async function onRequest(context) {
  const { GA_CLIENT_EMAIL, GA_PRIVATE_KEY, WINDSOR_API_KEY } = context.env;

  try {
    // 1) token do Google + GA4 nativo
    const token = await getGoogleToken(GA_CLIENT_EMAIL, GA_PRIVATE_KEY);
    const gaRows = await fetchGA4(token);

    // 2) Google Ads e Meta ainda via Windsor
    const [gads, meta] = await Promise.all([
      fetchWindsor("google_ads",
        ["date", "spend", "impressions", "clicks", "conversions"], GADS_ACCT, WINDSOR_API_KEY),
      fetchWindsor("facebook",
        ["date", "spend", "impressions", "clicks"], META_ACCT, WINDSOR_API_KEY),
    ]);

    const gByDate = {}, mByDate = {};
    gads.forEach((r) => { gByDate[r.date] = r; });
    meta.forEach((r) => { mByDate[r.date] = r; });

    // 3) consolida usando as datas do GA4 como espinha dorsal
    const out = gaRows
      .map((r) => {
        const g = gByDate[r.d] || {};
        const m = mByDate[r.d] || {};
        return {
          d: r.d,
          ses: r.ses,
          usr: r.usr,
          new: r.new,
          g_sp: +num(g.spend).toFixed(2),
          g_im: Math.round(num(g.impressions)),
          g_ck: Math.round(num(g.clicks)),
          g_cv: +num(g.conversions).toFixed(1),
          m_sp: +num(m.spend).toFixed(2),
          m_im: Math.round(num(m.impressions)),
          m_ck: Math.round(num(m.clicks)),
        };
      })
      .sort((a, b) => a.d.localeCompare(b.d));

    return new Response(
      JSON.stringify({ updated: new Date().toISOString(), rows: out, source: "ga4-native" }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300, s-maxage=3600",
        },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err.message || err) }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
}
