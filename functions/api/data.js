// functions/api/data.js  (Cloudflare Pages Function) — FASE 3 (FINAL)
// -----------------------------------------------------------------------------
// GA4        -> API NATIVA do Google (Analytics Data API v1beta)
// Google Ads -> API NATIVA do Google (Google Ads API v24, searchStream + GAQL)
// Meta       -> API NATIVA do Meta (Graph API / Marketing Insights)
//
// SEM WINDSOR. Todas as fontes vêm direto das APIs oficiais.
//
// Variáveis de ambiente necessárias (Cloudflare → Settings → Variables):
//   GA_CLIENT_EMAIL       -> client_email do JSON da conta de serviço (GA4)
//   GA_PRIVATE_KEY        -> private_key do JSON da conta de serviço (GA4)
//   GADS_DEVELOPER_TOKEN  -> developer token (API Center da MCC)
//   GADS_CLIENT_ID        -> Client ID OAuth (Aplicativo da Web)
//   GADS_CLIENT_SECRET    -> Client Secret OAuth
//   GADS_REFRESH_TOKEN    -> refresh token do Google Ads (1//...)
//   META_ACCESS_TOKEN     -> token de 60 dias do Meta (EAA...)
//
// O front-end continua chamando fetch('/api/data') e recebe o MESMO formato.
// -----------------------------------------------------------------------------

const GA4_PROPERTY  = "339344434";

// Google Ads
const GADS_CUSTOMER_ID = "4317758593";
const GADS_LOGIN_CID   = "1830171152";

// Meta
const META_ACCT       = "1984275108541772";
const META_API_VER    = "v21.0";

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

// ---------- GA4 ----------
async function getGoogleToken(clientEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
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
  return (json.rows || []).map((r) => {
    const raw = r.dimensionValues[0].value;
    const d = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    return {
      d,
      ses: Math.round(num(r.metricValues[0].value)),
      usr: Math.round(num(r.metricValues[1].value)),
      new: Math.round(num(r.metricValues[2].value)),
    };
  });
}

// ---------- Google Ads ----------
async function getGoogleAdsToken(clientId, clientSecret, refreshToken) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Ads token: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function fetchGoogleAds(accessToken, devToken) {
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
  const payload = await res.json();
  const blocks = Array.isArray(payload) ? payload : [payload];
  const byDate = {};
  for (const block of blocks) {
    for (const row of (block.results || [])) {
      const d = row.segments?.date;
      if (!d) continue;
      const m = row.metrics || {};
      if (!byDate[d]) byDate[d] = { spend: 0, impressions: 0, clicks: 0, conversions: 0 };
      byDate[d].spend       += num(m.costMicros) / 1e6;
      byDate[d].impressions += num(m.impressions);
      byDate[d].clicks      += num(m.clicks);
      byDate[d].conversions += num(m.conversions);
    }
  }
  return byDate;
}

// ---------- Meta (Graph API / Insights) ----------
async function fetchMeta(token) {
  // time_increment=1 => quebra diária; time_range com since/until
  const timeRange = JSON.stringify({ since: DATE_FROM, until: DATE_TO });
  const params = new URLSearchParams({
    fields: "spend,impressions,clicks,reach",
    time_increment: "1",
    time_range: timeRange,
    limit: "500",
    access_token: token,
  });
  const base = `https://graph.facebook.com/${META_API_VER}/act_${META_ACCT}/insights`;
  const byDate = {};
  let url = `${base}?${params.toString()}`;

  // a Graph API pagina; seguimos os cursores até acabar
  for (let guard = 0; guard < 20 && url; guard++) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Meta: HTTP ${res.status} ${await res.text()}`);
    const json = await res.json();
    for (const row of (json.data || [])) {
      const d = row.date_start; // formato YYYY-MM-DD (com time_increment=1)
      if (!d) continue;
      byDate[d] = {
        spend: num(row.spend),
        impressions: num(row.impressions),
        clicks: num(row.clicks),
        reach: num(row.reach), // reach diário (não somável entre dias)
      };
    }
    url = json.paging?.next || null;
  }
  return byDate;
}

// Alcance REAL do período inteiro (pessoas únicas) — sem time_increment.
// É o número correto que não pode ser obtido somando os dias.
async function fetchMetaReachTotal(token) {
  const timeRange = JSON.stringify({ since: DATE_FROM, until: DATE_TO });
  const params = new URLSearchParams({
    fields: "reach",
    time_range: timeRange,
    access_token: token,
  });
  const base = `https://graph.facebook.com/${META_API_VER}/act_${META_ACCT}/insights`;
  const res = await fetch(`${base}?${params.toString()}`);
  if (!res.ok) throw new Error(`Meta reach total: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  const row = (json.data || [])[0] || {};
  return num(row.reach);
}

// ---------- handler ----------
export async function onRequest(context) {
  const {
    GA_CLIENT_EMAIL, GA_PRIVATE_KEY,
    GADS_DEVELOPER_TOKEN, GADS_CLIENT_ID, GADS_CLIENT_SECRET, GADS_REFRESH_TOKEN,
    META_ACCESS_TOKEN,
  } = context.env;

  try {
    // 1) GA4 nativo
    const gaToken = await getGoogleToken(GA_CLIENT_EMAIL, GA_PRIVATE_KEY);
    const gaRows = await fetchGA4(gaToken);

    // 2) Google Ads nativo
    const adsToken = await getGoogleAdsToken(GADS_CLIENT_ID, GADS_CLIENT_SECRET, GADS_REFRESH_TOKEN);
    const gByDate = await fetchGoogleAds(adsToken, GADS_DEVELOPER_TOKEN);

    // 3) Meta nativo (dados diários + alcance real do período)
    const [mByDate, metaReachTotal] = await Promise.all([
      fetchMeta(META_ACCESS_TOKEN),
      fetchMetaReachTotal(META_ACCESS_TOKEN),
    ]);

    // 4) consolida usando as datas do GA4 como espinha dorsal
    const out = gaRows
      .map((r) => {
        const g = gByDate[r.d] || {};
        const m = mByDate[r.d] || {};
        return {
          d: r.d,
          ses: r.ses, usr: r.usr, new: r.new,
          g_sp: +num(g.spend).toFixed(2),
          g_im: Math.round(num(g.impressions)),
          g_ck: Math.round(num(g.clicks)),
          g_cv: +num(g.conversions).toFixed(1),
          m_sp: +num(m.spend).toFixed(2),
          m_im: Math.round(num(m.impressions)),
          m_ck: Math.round(num(m.clicks)),
          m_rc: Math.round(num(m.reach)),
        };
      })
      .sort((a, b) => a.d.localeCompare(b.d));

    return new Response(
      JSON.stringify({ updated: new Date().toISOString(), rows: out, meta_reach_total: Math.round(metaReachTotal), source: "all-native" }),
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


