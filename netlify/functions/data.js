// netlify/functions/data.js
// Busca dados diários (90 dias) de GA4, Google Ads e Meta no Windsor.ai,
// consolida por data e devolve o mesmo formato que o dashboard consome.
//
// É chamada de duas formas:
//  - pelo navegador (o index.html faz fetch('/api/data'))
//  - pelo agendador do Netlify, de hora em hora (ver netlify.toml), que mantém
//    o cache quente para o usuário nunca esperar a chamada à API.
//
// A chave do Windsor fica na variável de ambiente WINDSOR_API_KEY (Netlify →
// Site settings → Environment variables). Ela NUNCA aparece no HTML público.

const BASE = "https://connectors.windsor.ai";

// IDs das contas (os mesmos que já usamos no chat)
const GA4_ACCT   = "339344434";
const GADS_ACCT  = "431-775-8593";
const META_ACCT  = "1984275108541772";

const DATE_PRESET = "last_90d";

async function fetchConnector(connector, fields, accounts) {
  const key = process.env.WINDSOR_API_KEY;
  if (!key) throw new Error("WINDSOR_API_KEY não configurada");
  const params = new URLSearchParams({
    api_key: key,
    date_preset: DATE_PRESET,
    fields: fields.join(","),
  });
  if (accounts) params.set("accounts", accounts);
  const url = `${BASE}/${connector}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${connector}: HTTP ${res.status}`);
  const json = await res.json();
  // a API devolve { data: [...] } ou [...] dependendo do plano; normaliza
  return Array.isArray(json) ? json : (json.data || []);
}

function num(v) { return typeof v === "number" ? v : parseFloat(v) || 0; }

exports.handler = async () => {
  try {
    // três chamadas em paralelo
    const [ga, gads, meta] = await Promise.all([
      fetchConnector("googleanalytics4",
        ["date", "sessions", "active_users", "newusers"], GA4_ACCT),
      fetchConnector("google_ads",
        ["date", "spend", "impressions", "clicks", "conversions"], GADS_ACCT),
      fetchConnector("facebook",
        ["date", "spend", "impressions", "clicks"], META_ACCT),
    ]);

    // indexa Google Ads e Meta por data
    const gByDate = {}, mByDate = {};
    gads.forEach(r => { gByDate[r.date] = r; });
    meta.forEach(r => { mByDate[r.date] = r; });

    // consolida usando as datas do GA4 como espinha dorsal
    const out = ga
      .map(r => {
        const g = gByDate[r.date] || {};
        const m = mByDate[r.date] || {};
        return {
          d: r.date,
          ses: Math.round(num(r.sessions)),
          usr: Math.round(num(r.active_users)),
          new: Math.round(num(r.newusers)),
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

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // cache na CDN do Netlify por 1h; o agendador renova antes de expirar
        "Cache-Control": "public, max-age=300, s-maxage=3600",
      },
      body: JSON.stringify({ updated: new Date().toISOString(), rows: out }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String(err.message || err) }),
    };
  }
};
