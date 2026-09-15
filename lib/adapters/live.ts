import crypto from "node:crypto";
import type { Ad, AdGroup, Campaign, Channel, ChangeOperation, EntityStatus, EntityType, StatsRow } from "@/lib/types";

const META_VERSION = process.env.META_API_VERSION || "v25.0";
const GOOGLE_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v25";

const env = (name: string, fallback?: string) => process.env[name] || (fallback ? process.env[fallback] : undefined);
const cleanId = (value: string) => value.replace(/[^0-9]/g, "");
const packed = (channel: Channel, account: string, id: string) => `${channel}|${account}|${id}`;
const unpack = (value: string) => {
  const [channel, account, ...rest] = value.split("|");
  return { channel: channel as Channel, account, id: rest.join("|") };
};
const asStatus = (value?: string): EntityStatus => ["ENABLED", "ACTIVE"].includes(value || "") ? "on" : "off";
const num = (value: unknown) => Number(value || 0);

function monthRange() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { since: `${values.year}-${values.month}-01`, until: `${values.year}-${values.month}-${values.day}` };
}

async function jsonFetch(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
  if (!response.ok) {
    const message = body?.error?.message || body?.error?.details?.[0]?.errors?.[0]?.message || body?.message || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body;
}

function naverCredentials() {
  const apiKey = env("NAVER_SA_API_KEY");
  const secret = env("NAVER_SA_SECRET_KEY");
  const customerId = env("NAVER_SA_CUSTOMER_ID", "NAVER_SA_MANAGER_CUSTOMER_ID");
  return apiKey && secret && customerId ? { apiKey, secret, customerId: cleanId(customerId) } : null;
}

async function naverRequest(method: string, path: string, body?: unknown) {
  const credentials = naverCredentials();
  if (!credentials) throw new Error("네이버 SA 인증정보가 없습니다.");
  const timestamp = Date.now().toString();
  const signature = crypto.createHmac("sha256", credentials.secret).update(`${timestamp}.${method}.${path}`).digest("base64");
  return jsonFetch(`https://api.searchad.naver.com${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Timestamp": timestamp,
      "X-API-KEY": credentials.apiKey,
      "X-Customer": credentials.customerId,
      "X-Signature": signature,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function naverCampaigns(includeOff: boolean): Promise<Campaign[]> {
  const credentials = naverCredentials();
  if (!credentials) return [];
  const rows = await naverRequest("GET", "/ncc/campaigns");
  return (rows as any[]).filter((row) => includeOff || row.status === "ELIGIBLE").map((row) => ({
    id: packed("naver_sa", credentials.customerId, row.nccCampaignId), channel: "naver_sa", name: row.name,
    dailyBudget: num(row.dailyBudget), status: row.userLock ? "off" : "on", spend: 0, conversions: 0, roas: 0,
  }));
}

function metaToken() { return env("META_SYSTEM_USER_ACCESS_TOKEN", "META_ACCESS_TOKEN"); }
async function metaGet(path: string, params: Record<string, string> = {}) {
  const token = metaToken();
  if (!token) throw new Error("Meta 액세스 토큰이 없습니다.");
  const query = new URLSearchParams({ ...params, access_token: token });
  return jsonFetch(`https://graph.facebook.com/${META_VERSION}/${path}?${query}`);
}
async function metaPost(path: string, fields: Record<string, string | number>) {
  const token = metaToken();
  if (!token) throw new Error("Meta 액세스 토큰이 없습니다.");
  return jsonFetch(`https://graph.facebook.com/${META_VERSION}/${path}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])), access_token: token }),
  });
}
async function metaAccounts() {
  const single = env("META_AD_ACCOUNT_ID");
  const business = env("META_BUSINESS_ID");
  if (!metaToken()) return [];
  if (!business) return single ? [single.replace(/^act_/, "")] : [];
  const [owned, client] = await Promise.all([
    metaGet(`${business}/owned_ad_accounts`, { fields: "id,name", limit: "500" }),
    metaGet(`${business}/client_ad_accounts`, { fields: "id,name", limit: "500" }),
  ]);
  return [...(owned.data || []), ...(client.data || [])].map((row: any) => String(row.id).replace(/^act_/, "")).filter((id, i, all) => all.indexOf(id) === i);
}
async function metaCampaigns(includeOff: boolean): Promise<Campaign[]> {
  const accounts = await metaAccounts();
  const { since, until } = monthRange();
  const batches = await Promise.all(accounts.map(async (account: string) => {
    const body = await metaGet(`act_${account}/campaigns`, {
      fields: `id,name,status,daily_budget,insights.time_range({"since":"${since}","until":"${until}"}){spend,actions,action_values}`,
      limit: "500",
    });
    return (body.data || []).filter((row: any) => includeOff || row.status === "ACTIVE").map((row: any) => {
      const insight = row.insights?.data?.[0] || {};
      const purchase = (insight.actions || []).find((x: any) => ["purchase", "omni_purchase"].includes(x.action_type));
      const revenue = (insight.action_values || []).find((x: any) => ["purchase", "omni_purchase"].includes(x.action_type));
      const spend = num(insight.spend);
      return { id: packed("meta", account, row.id), channel: "meta" as const, name: row.name, dailyBudget: num(row.daily_budget) / 100,
        status: asStatus(row.status), spend, conversions: num(purchase?.value), roas: spend ? Math.round(num(revenue?.value) / spend * 100) : 0 };
    });
  }));
  return batches.flat();
}

let googleTokenCache: { token: string; expiresAt: number } | null = null;
async function googleToken() {
  if (googleTokenCache && googleTokenCache.expiresAt > Date.now() + 60_000) return googleTokenCache.token;
  const clientId = env("GOOGLE_ADS_CLIENT_ID"), clientSecret = env("GOOGLE_ADS_CLIENT_SECRET"), refreshToken = env("GOOGLE_ADS_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Google Ads OAuth 인증정보가 없습니다.");
  const body = await jsonFetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }) });
  googleTokenCache = { token: body.access_token, expiresAt: Date.now() + num(body.expires_in) * 1000 };
  return body.access_token;
}
async function googleRequest(path: string, body?: unknown) {
  const developerToken = env("GOOGLE_ADS_DEVELOPER_TOKEN");
  const loginId = env("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
  if (!developerToken || !loginId) throw new Error("Google Ads MCC 인증정보가 없습니다.");
  return jsonFetch(`https://googleads.googleapis.com/${GOOGLE_VERSION}/${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${await googleToken()}`, "developer-token": developerToken, "login-customer-id": cleanId(loginId), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function googleSearch(customer: string, query: string) {
  const body = await googleRequest(`customers/${cleanId(customer)}/googleAds:search`, { query, pageSize: 10000 });
  return body.results || [];
}
async function googleAccounts() {
  const manager = cleanId(env("GOOGLE_ADS_LOGIN_CUSTOMER_ID") || "");
  if (!manager || !env("GOOGLE_ADS_DEVELOPER_TOKEN")) return [];
  const rows = await googleSearch(manager, "SELECT customer_client.id, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.status = 'ENABLED'");
  return rows.map((row: any) => String(row.customerClient?.id || "")).filter((id: string) => id && id !== manager);
}
async function googleCampaigns(includeOff: boolean): Promise<Campaign[]> {
  const accounts = await googleAccounts();
  const batches = await Promise.all(accounts.map(async (account: string) => {
    const status = includeOff ? "campaign.status != 'REMOVED'" : "campaign.status = 'ENABLED'";
    const rows = await googleSearch(account, `SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${status} AND segments.date DURING THIS_MONTH`);
    return rows.map((row: any) => {
      const spend = num(row.metrics?.costMicros) / 1_000_000;
      return { id: packed("google_ads", account, String(row.campaign.id)), channel: "google_ads" as const, name: row.campaign.name,
        dailyBudget: num(row.campaignBudget?.amountMicros) / 1_000_000, status: asStatus(row.campaign.status), spend,
        conversions: Math.round(num(row.metrics?.conversions)), roas: spend ? Math.round(num(row.metrics?.conversionsValue) / spend * 100) : 0 };
    });
  }));
  return batches.flat();
}

async function allCampaigns(includeOff = false) {
  const tasks = [naverCampaigns(includeOff), metaCampaigns(includeOff), googleCampaigns(includeOff)];
  const results = await Promise.allSettled(tasks);
  const campaigns = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (!campaigns.length) {
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason?.message || String(result.reason)] : []);
    throw new Error(errors.length ? `실계정 조회 실패: ${errors.join(" / ")}` : "연결된 실계정이 없습니다. 환경변수를 확인해 주세요.");
  }
  return campaigns;
}

async function entityFromCampaign(id: string) { return (await allCampaigns(true)).find((row) => row.id === id) || null; }

export const liveAdapter = {
  async listCampaigns(channel?: Channel, includeOff = false) {
    const rows = await allCampaigns(includeOff);
    return channel ? rows.filter((row) => row.channel === channel) : rows;
  },
  async listAdgroups(channel: Channel, campaignId: string): Promise<AdGroup[]> {
    const key = unpack(campaignId);
    if (channel === "naver_sa") {
      const rows = await naverRequest("GET", `/ncc/adgroups?nccCampaignId=${encodeURIComponent(key.id)}`);
      return rows.map((row: any) => ({ id: packed(channel, key.account, row.nccAdgroupId), campaignId, channel, name: row.name, dailyBudget: num(row.dailyBudget), status: row.userLock ? "off" : "on" }));
    }
    if (channel === "meta") {
      const body = await metaGet(`${key.id}/adsets`, { fields: "id,name,status,daily_budget", limit: "500" });
      return body.data.map((row: any) => ({ id: packed(channel, key.account, row.id), campaignId, channel, name: row.name, dailyBudget: num(row.daily_budget) / 100, status: asStatus(row.status) }));
    }
    if (channel === "google_ads") {
      const rows = await googleSearch(key.account, `SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE campaign.id = ${key.id} AND ad_group.status != 'REMOVED'`);
      return rows.map((row: any) => ({ id: packed(channel, key.account, String(row.adGroup.id)), campaignId, channel, name: row.adGroup.name, dailyBudget: 0, status: asStatus(row.adGroup.status) }));
    }
    throw new Error("네이버 GFA 실연동 규격 확인이 필요합니다.");
  },
  async listAds(channel: Channel, adgroupId: string): Promise<Ad[]> {
    const key = unpack(adgroupId);
    if (channel === "naver_sa") {
      const rows = await naverRequest("GET", `/ncc/ads?nccAdgroupId=${encodeURIComponent(key.id)}`);
      return rows.map((row: any) => ({ id: packed(channel, key.account, row.nccAdId), adgroupId, channel, name: row.subject || row.description || row.nccAdId, status: row.userLock ? "off" : "on" }));
    }
    if (channel === "meta") {
      const body = await metaGet(`${key.id}/ads`, { fields: "id,name,status", limit: "500" });
      return body.data.map((row: any) => ({ id: packed(channel, key.account, row.id), adgroupId, channel, name: row.name, status: asStatus(row.status) }));
    }
    if (channel === "google_ads") {
      const rows = await googleSearch(key.account, `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status FROM ad_group_ad WHERE ad_group.id = ${key.id} AND ad_group_ad.status != 'REMOVED'`);
      return rows.map((row: any) => ({ id: packed(channel, key.account, String(row.adGroupAd.ad.id)), adgroupId, channel, name: row.adGroupAd.ad.name || String(row.adGroupAd.ad.id), status: asStatus(row.adGroupAd.status) }));
    }
    throw new Error("네이버 GFA 실연동 규격 확인이 필요합니다.");
  },
  async getStats(channel?: Channel, _level = "campaign", ids?: string[]): Promise<StatsRow[]> {
    const rows = (await allCampaigns(true)).filter((row) => (!channel || row.channel === channel) && (!ids?.length || ids.includes(row.id)));
    return rows.map((row) => ({ id: row.id, name: row.name, channel: row.channel, spend: row.spend, impressions: 0, clicks: 0, conversions: row.conversions, revenue: row.spend * row.roas / 100, ctr: 0, cpc: 0, roas: row.roas }));
  },
  async resolveEntity(channel: Channel, entityType: EntityType, id: string) {
    if (entityType === "campaign") return entityFromCampaign(id);
    const key = unpack(id);
    if (entityType === "adgroup") {
      const campaigns = await allCampaigns(true);
      for (const campaign of campaigns.filter((row) => row.channel === channel && unpack(row.id).account === key.account)) {
        const found = (await this.listAdgroups(channel, campaign.id)).find((row) => row.id === id);
        if (found) return found;
      }
    }
    return null;
  },
  async apply(operation: ChangeOperation) {
    if (operation.channel === "naver_gfa") throw new Error("네이버 GFA 변경 API 규격 확인 전에는 변경할 수 없습니다.");
    if (operation.kind === "create_text_ad") throw new Error("네이버 SA 소재 생성은 트래킹 템플릿 검증 후 지원됩니다.");
    const key = unpack(operation.id);
    if (operation.channel === "naver_sa") {
      const endpoint = operation.entityType === "campaign" ? `/ncc/campaigns/${key.id}` : operation.entityType === "adgroup" ? `/ncc/adgroups/${key.id}` : `/ncc/ads/${key.id}`;
      if (operation.kind === "set_status") await naverRequest("PUT", endpoint, { userLock: operation.status === "off" },);
      else await naverRequest("PUT", endpoint, { dailyBudget: operation.dailyBudget });
      return { success: true, changed: 1 };
    }
    if (operation.channel === "meta") {
      if (operation.kind === "set_status") await metaPost(key.id, { status: operation.status === "on" ? "ACTIVE" : "PAUSED" });
      else await metaPost(key.id, { daily_budget: Math.round(operation.dailyBudget * 100) });
      return { success: true, changed: 1 };
    }
    if (operation.channel === "google_ads") {
      if (operation.kind === "update_budget") throw new Error("Google Ads 예산 변경은 공유 예산 확인 후 지원됩니다.");
      const resource = operation.entityType === "campaign" ? "campaigns" : operation.entityType === "adgroup" ? "adGroups" : "adGroupAds";
      const field = operation.entityType === "ad" ? "adGroupAd" : operation.entityType;
      const resourceName = operation.entityType === "ad" ? `customers/${key.account}/adGroupAds/${key.id}` : `customers/${key.account}/${resource}/${key.id}`;
      await googleRequest(`customers/${key.account}/${resource}:mutate`, { operations: [{ update: { resourceName, status: operation.status === "on" ? "ENABLED" : "PAUSED" }, updateMask: "status" }] });
      return { success: true, changed: 1, field };
    }
    throw new Error("지원하지 않는 변경입니다.");
  },
};
