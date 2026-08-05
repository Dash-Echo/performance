// functions/api/assinatura.js
//
// Cloudflare Pages Function — exposes daily KPIs (spend, clicks, impressions,
// conversions, CTR, CPC) for the "Assinatura de Energia Solar" campaigns on
// Meta Ads and Google Ads as a single JSON payload, so a dashboard can
// consume it directly.
//
// WHERE TO PUT THIS FILE
//   Drop it at:  functions/api/assinatura.js
//   in the same Cloudflare Pages project that already serves echoenergia.pages.dev.
//   Cloudflare Pages auto-detects anything under /functions as a serverless
//   route — no build step needed for this plain .js file.
//
// ENVIRONMENT VARIABLES / SECRETS TO SET
//   Cloudflare dashboard -> your Pages project -> Settings -> Environment variables
//   Add these as "Secret" (encrypted) for both Production and Preview:
//
//     META_ACCESS_TOKEN            Meta Graph API token with ads_read on the account.
//                                  Use a long-lived System User token, NOT a short-lived
//                                  user token — those expire in ~1-2h and this endpoint
//                                  would start failing silently otherwise.
//     META_AD_ACCOUNT_ID           Numeric id, no "act_" prefix. e.g. 1984275108541772
//     GOOGLE_ADS_DEVELOPER_TOKEN
//     GOOGLE_ADS_CLIENT_ID
//     GOOGLE_ADS_CLIENT_SECRET
//     GOOGLE_ADS_REFRESH_TOKEN     A refresh token is long-lived (doesn't expire from
//                                  use) — this function exchanges it for a fresh
//                                  access token on every request, so no token
//                                  ever goes stale.
//     GOOGLE_ADS_CUSTOMER_ID       e.g. 4317758593 (no dashes)
//     GOOGLE_ADS_LOGIN_CUSTOMER_ID Optional — only set if this account sits under
//                                  an MCC (manager account). Same format, no dashes.
//     ASSINATURA_API_KEY           A secret string YOU pick. Callers must pass it as
//                                  ?key=... — this keeps the endpoint from being
//                                  scraped by anyone who finds the URL.
//
// USAGE
//   GET /api/assinatura?since=2026-05-01&until=2026-08-05&key=YOUR_SECRET
//   since/until default to the last 90 days if omitted.
//
// RESPONSE SHAPE
//   {
//     "range": { "since": "...", "until": "..." },
//     "meta": {
//       "campaign": "v4 | Assinatura | PI AL |2",
//       "daily": [ { "date": "2026-05-01", "spend": 123.45, "clicks": 10,
//                    "impressions": 500, "ctr": 2.0, "cpc": 12.3 }, ... ]
//     },
//     "google": {
//       "campaign": "v4 | Pmax | Assinatura Enova",
//       "daily": [ { "date": "2026-05-01", "cost": 98.76, "clicks": 8,
//                    "impressions": 400, "conversions": 1.0, "ctr": 2.0, "cpc": 12.3 }, ... ]
//     }
//   }
//
// NOTES / THINGS TO CHECK IF SOMETHING BREAKS
//   - API versions (Meta v19.0, Google Ads v17) drift over time. If either call
//     starts returning a deprecation error, bump GRAPH_API_VERSION / GOOGLE_ADS_API_VERSION
//     below to whatever is current.
//   - Meta campaign filtering matches on exact campaign name. If the campaign gets
//     renamed, update META_CAMPAIGN_NAME below (or pass ?meta_campaign=... to override).
//   - Google Ads cost comes back in micros (millionths of the currency unit) —
//     this function already divides by 1,000,000 before returning.

const GRAPH_API_VERSION = "v19.0";
const GOOGLE_ADS_API_VERSION = "v17";

const DEFAULT_META_CAMPAIGN = "v4 | Assinatura | PI AL |2";
const DEFAULT_GOOGLE_CAMPAIGN = "v4 | Pmax | Assinatura Enova";

function daysAgoISO(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function getGoogleAccessToken(env) {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_ADS_CLIENT_ID,
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Google token refresh failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function fetchGoogleAdsDaily(env, campaignName, since, until) {
  const accessToken = await getGoogleAccessToken(env);
  const customerId = env.GOOGLE_ADS_CUSTOMER_ID;

  const query = `
    SELECT
      segments.date,
      campaign.name,
      metrics.cost_micros,
      metrics.clicks,
      metrics.impressions,
      metrics.conversions,
      metrics.ctr,
      metrics.average_cpc
    FROM campaign
    WHERE campaign.name = '${campaignName.replace(/'/g, "\\'")}'
      AND segments.date BETWEEN '${since}' AND '${until}'
    ORDER BY segments.date ASC
  `;

  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "developer-token": env.GOOGLE_ADS_DEVELOPER_TOKEN,
    "Content-Type": "application/json",
  };
  if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers["login-customer-id"] = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  }

  const rows = [];
  let pageToken = null;
  do {
    const body = { query, pageSize: 1000 };
    if (pageToken) body.pageToken = pageToken;

    const resp = await fetch(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:search`,
      { method: "POST", headers, body: JSON.stringify(body) }
    );
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(`Google Ads query failed: ${JSON.stringify(data)}`);
    }
    for (const r of data.results || []) {
      rows.push({
        date: r.segments.date,
        cost: Number(r.metrics.costMicros || 0) / 1_000_000,
        clicks: Number(r.metrics.clicks || 0),
        impressions: Number(r.metrics.impressions || 0),
        conversions: Number(r.metrics.conversions || 0),
        ctr: Number(r.metrics.ctr || 0) * 100,
        cpc: Number(r.metrics.averageCpc || 0),
      });
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return rows;
}

async function fetchMetaDaily(env, campaignName, since, until) {
  const params = new URLSearchParams({
    level: "campaign",
    fields: "campaign_name,spend,clicks,impressions,cpc,ctr",
    time_range: JSON.stringify({ since, until }),
    time_increment: "1",
    filtering: JSON.stringify([
      { field: "campaign.name", operator: "EQUAL", value: campaignName },
    ]),
    limit: "500",
    access_token: env.META_ACCESS_TOKEN,
  });

  let url = `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${env.META_AD_ACCOUNT_ID}/insights?${params}`;
  const rows = [];
  let guard = 0;
  while (url && guard < 20) {
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok || data.error) {
      throw new Error(`Meta Ads query failed: ${JSON.stringify(data.error || data)}`);
    }
    for (const r of data.data || []) {
      rows.push({
        date: r.date_start,
        spend: Number(r.spend || 0),
        clicks: Number(r.clicks || 0),
        impressions: Number(r.impressions || 0),
        ctr: Number(r.ctr || 0),
        cpc: Number(r.cpc || 0),
      });
    }
    url = data.paging && data.paging.next ? data.paging.next : null;
    guard++;
  }
  return rows;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const providedKey = url.searchParams.get("key");
  if (!env.ASSINATURA_API_KEY || providedKey !== env.ASSINATURA_API_KEY) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const since = url.searchParams.get("since") || daysAgoISO(90);
  const until = url.searchParams.get("until") || daysAgoISO(0);
  const metaCampaign = url.searchParams.get("meta_campaign") || DEFAULT_META_CAMPAIGN;
  const googleCampaign = url.searchParams.get("google_campaign") || DEFAULT_GOOGLE_CAMPAIGN;

  try {
    const [metaDaily, googleDaily] = await Promise.all([
      fetchMetaDaily(env, metaCampaign, since, until),
      fetchGoogleAdsDaily(env, googleCampaign, since, until),
    ]);

    return new Response(
      JSON.stringify({
        range: { since, until },
        meta: { campaign: metaCampaign, daily: metaDaily },
        google: { campaign: googleCampaign, daily: googleDaily },
      }),
      { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}
