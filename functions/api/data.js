// functions/api/data.js  (Cloudflare Pages Function) — FASE 2
// -----------------------------------------------------------------------------
// GA4        -> API NATIVA do Google (Analytics Data API v1beta)
// Google Ads -> API NATIVA do Google (Google Ads API v24, searchStream + GAQL)
// Meta       -> ainda via Windsor.ai (será migrado na fase 3)
//
// Variáveis de ambiente necessárias (Cloudflare → Settings → Variables):
//   GA_CLIENT_EMAIL       -> client_email do JSON da conta de serviço (GA4)
//   GA_PRIVATE_KEY        -> private_key do JSON da conta de serviço (GA4)
//   GADS_DEVELOPER_TOKEN  -> developer token (API Center da MCC)
//   GADS_CLIENT_ID        -> Client ID OAuth (tipo Aplicativo da Web)
//   GADS_CLIENT_SECRET    -> Client Secret OAuth
//   GADS_REFRESH_TOKEN    -> refresh token gerado no OAuth Playground (1//...)
//   WINDSOR_API_KEY       -> ainda usada para o Meta
//
// O front-end continua chamando fetch('/api/data') e recebe o MESMO formato.
// -----------------------------------------------------------------------------

const GA4_PROPERTY  = "339344434";
const WINDSOR_BASE  = "https://connectors.windsor.ai";
const META_ACCT     = "1984275108541772";

// Google Ads: conta que veicula os anúncios e a gerenciadora (MCC)
const GADS_CUSTOMER_ID = "4317758593";   // conta dos dados (sem hífens)
const GADS_LOGIN_CID   = "1830171152";   // MCC / login-customer-id (sem hífens)

// Intervalo fixo: ano de 2026 inteiro (01/01 a 31/12)
const DATE_FROM = "2026-01-01";
const DATE_TO   = "2026-12-31";

// ---------- utilidades ----------
function num(v) { return typeof v === "number" ? v : parseFloat(v) || 0; }

function b64url(input) {
  let bytes;
  if (typeof input === "string") bytes = new TextEncoder().encode(input);
  else bytes = new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Converte private_key PEM (PKCS#8) para ArrayBuffer, robusto a formatos de colagem.
function pemToArrayBuffer(pem) {
  let s = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "");
  s = s.replace(/[^A-Za-z0-9+/_-]/g, "");
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4 !== 0) s += "=";
  const bin = atob(s);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// ---------- GA4: token via conta de serviço (JWT assinado) ----------
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
    "pkcs8", pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)
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
  if (!res.ok) throw new Error(`Google token: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

// ---------- GA4: runReport ----------
async function fetchGA4(token) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY}:runReport`;
  const body = {
    dateRanges: [{ startDate: DATE_FROM, endDate: DATE_TO }],
    dimensions: [{ name: "date" }],
    metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "newUsers" }],
    orderBys: [{ dimension: { dimensionName: "date" } }],
    limit: 100000,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GA4 runReport: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  const rows = json.rows || [];
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

// ---------- Google Ads: access token a partir do refresh token ----------
async function getGoogleAdsToken(clientId, clientSecret, refreshToken) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Ads token: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

// ---------- Google Ads: searchStream com GAQL (gasto/impr/cliques/conv por dia) ----------
async function fetchGoogleAds(accessToken, devToken) {
  // datas em GAQL vão sem hífen? Não: o segment.date usa 'YYYY-MM-DD'
  const query =
    "SELECT segments.date, metrics.cost_micros, metrics.impressions, " +
    "metrics.clicks, metrics.conversions FROM customer " +
    `WHERE segments.date BETWEEN '${DATE_FROM}' AND '${DATE_TO}'`;

  const url = `https://googleads.googleapis.com/v24/customers/${GADS_CUSTOMER_ID}/googleAds:searchStream`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": devToken,
      "login-customer-id": GADS_LOGIN_CID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Google Ads: HTTP ${res.status} ${await res.text()}`);

  // searchStream devolve um ARRAY de blocos, cada um com { results: [...] }
  const payload = await res.json();
  const blocks = Array.isArray(payload) ? payload : [payload];

  // agrega por dia (a conta 'customer' já vem agregada, mas somamos por segurança)
  const byDate = {};
  for (const block of blocks) {
    const results = block.results || [];
    for (const row of results) {
      const d = row.segments?.date;
      if (!d) continue;
      const m = row.metrics || {};
      if (!byDate[d]) byDate[d] = { spend: 0, impressions: 0, clicks: 0, conversions: 0 };
      // cost_micros vem em micros: dividir por 1.000.000 para reais
      byDate[d].spend       += num(m.costMicros) / 1e6;
      byDate[d].impressions += num(m.impressions);
      byDate[d].clicks      += num(m.clicks);
      byDate[d].conversions += num(m.conversions);
    }
  }
  return byDate; // { '2026-06-01': {spend, impressions, clicks, conversions}, ... }
}

// ---------- Windsor (ainda usado p/ Meta) ----------
async function fetchWindsor(connector, fields, accounts, key) {
  if (!key) throw new Error("WINDSOR_API_KEY não configurada");
  const params = new URLSearchParams({
    api_key: key,
    date_from: DATE_FROM,
    date_to: DATE_TO,
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
  const {
    GA_CLIENT_EMAIL, GA_PRIVATE_KEY,
    GADS_DEVELOPER_TOKEN, GADS_CLIENT_ID, GADS_CLIENT_SECRET, GADS_REFRESH_TOKEN,
    WINDSOR_API_KEY,
  } = context.env;

  try {
    // 1) GA4 nativo
    const gaToken = await getGoogleToken(GA_CLIENT_EMAIL, GA_PRIVATE_KEY);
    const gaRows = await fetchGA4(gaToken);

    // 2) Google Ads nativo
    const adsToken = await getGoogleAdsToken(GADS_CLIENT_ID, GADS_CLIENT_SECRET, GADS_REFRESH_TOKEN);
    const gByDate = await fetchGoogleAds(adsToken, GADS_DEVELOPER_TOKEN);

    // 3) Meta ainda via Windsor
    const meta = await fetchWindsor("facebook",
      ["date", "spend", "impressions", "clicks"], META_ACCT, WINDSOR_API_KEY);
    const mByDate = {};
    meta.forEach((r) => { mByDate[r.date] = r; });

    // 4) consolida usando as datas do GA4 como espinha dorsal
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
      JSON.stringify({ updated: new Date().toISOString(), rows: out, source: "ga4+ads-native" }),
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
