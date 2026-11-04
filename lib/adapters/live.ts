import crypto from "node:crypto";
import { registeredNaverSa } from "@/lib/naver-sa-registry";
import type { Ad, AdAccount, AdGroup, Campaign, Channel, ChangeOperation, ConnectionStatus, CreativeRow, DailyRow, EntityStatus, EntityType, ReportResult, StatsRow } from "@/lib/types";

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
    const detail = body?.error?.details?.flatMap((item: any) => item?.errors || [])?.[0];
    const message = detail?.message || detail?.errorCode && JSON.stringify(detail.errorCode) || body?.error?.message || body?.message || body?.title || body?.detail || `${response.status} ${response.statusText}`;
    const code = body?.code ?? body?.error?.code;
    if (code !== undefined && !String(message).includes(String(code))) throw new Error(`${message} (code ${code}, HTTP ${response.status})`);
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

type NaverKey = { apiKey: string; secret: string; customerId: string };

// 대시보드에서 등록한 계정이면 그 계정의 키를, 아니면 환경변수(대행사) 키를 쓴다.
function naverKeyFor(customerId?: string): NaverKey {
  const id = customerId ? cleanId(customerId) : undefined;
  const registered = registeredNaverSa().find((item) => cleanId(item.customerId) === id);
  if (registered) return { apiKey: registered.apiKey, secret: registered.secret, customerId: cleanId(registered.customerId) };
  const credentials = naverCredentials();
  if (!credentials) throw new Error(id ? `네이버 SA 계정 ${id}의 인증정보가 없습니다. 계정 매핑 > 네이버 SA에서 등록해 주세요.` : "네이버 SA 인증정보가 없습니다.");
  return { ...credentials, customerId: id || credentials.customerId };
}

async function naverSigned(key: NaverKey, method: string, path: string, body?: unknown) {
  const timestamp = Date.now().toString();
  // 네이버 SA 서명은 쿼리스트링을 제외한 URI로 생성해야 한다.
  const signature = crypto.createHmac("sha256", key.secret).update(`${timestamp}.${method}.${path.split("?")[0]}`).digest("base64");
  return jsonFetch(`https://api.searchad.naver.com${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Timestamp": timestamp, "X-API-KEY": key.apiKey, "X-Customer": key.customerId, "X-Signature": signature },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function naverRequest(method: string, path: string, body?: unknown, customerId?: string) {
  return naverSigned(naverKeyFor(customerId), method, path, body);
}

/** 등록 전에 키가 맞는지 확인한다. 캠페인 수를 돌려준다. */
export async function verifyNaverSaCredential(credential: { customerId: string; apiKey: string; secret: string }) {
  const rows = await naverSigned({ apiKey: credential.apiKey.trim(), secret: credential.secret.trim(), customerId: cleanId(credential.customerId) }, "GET", "/ncc/campaigns");
  return Array.isArray(rows) ? rows.length : 0;
}

async function naverAccounts(): Promise<AdAccount[]> {
  const accounts: AdAccount[] = [];
  const credentials = naverCredentials();
  if (credentials) {
    // 대행사(MCC) 계정이면 연결된 광고주 목록을 조회하고, 아니면 자기 계정만 사용한다.
    let clients: any[] = [];
    try { clients = await naverRequest("GET", "/customer-links?type=MYCLIENTS"); } catch { clients = []; }
    const linked = (Array.isArray(clients) ? clients : []).map((row: any) => ({ id: String(row.clientCustomerId || ""), channel: "naver_sa" as const, name: row.clientLoginId ? `네이버 SA ${row.clientLoginId}` : `네이버 SA ${row.clientCustomerId}` })).filter((row) => row.id);
    accounts.push(...(linked.length ? linked : [{ id: credentials.customerId, channel: "naver_sa" as const, name: `네이버 SA ${credentials.customerId}` }]));
  }
  for (const item of registeredNaverSa()) {
    const id = cleanId(item.customerId);
    const existing = accounts.find((row) => row.id === id);
    if (existing) existing.name = item.name || existing.name;
    else accounts.push({ id, channel: "naver_sa", name: item.name || `네이버 SA ${id}` });
  }
  return accounts;
}

async function naverCampaigns(includeOff: boolean): Promise<Campaign[]> {
  const accounts = await naverAccounts();
  return settleAccounts(accounts, async (account) => {
    const rows = (await naverRequest("GET", "/ncc/campaigns", undefined, account.id) as any[]).filter((row) => includeOff || row.status === "ELIGIBLE");
    // 이번 달 누적 성과 (조회 실패해도 캠페인 목록은 보여준다)
    const { since, until } = monthRange();
    const stats = new Map<string, any>();
    try { for (const row of await naverStats(account.id, rows.map((r) => r.nccCampaignId), since, until, false)) stats.set(row.id, row); } catch { /* 통계 없음 */ }
    return rows.map((row) => {
      const s = stats.get(row.nccCampaignId) || {};
      const spend = num(s.salesAmt);
      return { id: packed("naver_sa", account.id, row.nccCampaignId), channel: "naver_sa" as const, name: row.name,
        dailyBudget: num(row.dailyBudget), status: (row.userLock ? "off" : "on") as EntityStatus, spend, conversions: Math.round(num(s.ccnt)),
        roas: spend ? Math.round(num(s.convAmt) / spend * 100) : 0, accountId: account.id, accountName: account.name };
    });
  });
}

// 계정 하나가 실패해도 나머지 계정 결과는 살린다. 전부 실패했을 때만 에러를 던진다.
async function settleAccounts(accounts: AdAccount[], run: (account: AdAccount) => Promise<Campaign[]>): Promise<Campaign[]> {
  const results = await Promise.allSettled(accounts.map(run));
  const ok = results.filter((r): r is PromiseFulfilledResult<Campaign[]> => r.status === "fulfilled");
  if (accounts.length && !ok.length) {
    const first = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    throw first?.reason instanceof Error ? first.reason : new Error(String(first?.reason));
  }
  return ok.flatMap((r) => r.value);
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
async function metaPaged(path: string, params: Record<string, string>) {
  const rows: any[] = [];
  let body = await metaGet(path, { ...params, limit: "200" });
  rows.push(...(body.data || []));
  for (let page = 0; body.paging?.next && page < 20; page++) {
    body = await jsonFetch(body.paging.next);
    rows.push(...(body.data || []));
  }
  return rows;
}
// 비활성(2)·종료(101) 계정은 목록에서 제외한다.
const META_HIDDEN_STATUS = new Set([2, 101]);
async function metaAccounts(): Promise<AdAccount[]> {
  if (!metaToken()) return [];
  const business = env("META_BUSINESS_ID");
  const fields = { fields: "account_id,name,account_status" };
  // 비즈니스 포트폴리오(소유 + 클라이언트 광고계정)와 토큰이 접근 가능한 광고계정을 모두 모은다. (Google MCC 하위 계정 목록과 같은 역할)
  const sources = await Promise.allSettled([
    business ? metaPaged(`${business}/owned_ad_accounts`, fields) : Promise.resolve([]),
    business ? metaPaged(`${business}/client_ad_accounts`, fields) : Promise.resolve([]),
    metaPaged("me/adaccounts", fields),
  ]);
  const rows = sources.flatMap((r) => r.status === "fulfilled" ? r.value : []);
  if (!rows.length) {
    const failed = sources.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
  }
  const seen = new Set<string>();
  return rows.filter((row) => !META_HIDDEN_STATUS.has(Number(row.account_status))).map((row) => {
    const id = String(row.account_id || row.id).replace(/^act_/, "");
    return { id, channel: "meta" as const, name: row.name || `Meta ${id}` };
  }).filter((row) => !seen.has(row.id) && seen.add(row.id));
}
async function metaCampaigns(includeOff: boolean): Promise<Campaign[]> {
  const accounts = await metaAccounts();
  const { since, until } = monthRange();
  return settleAccounts(accounts, async (account) => {
    const body = await metaGet(`act_${account.id}/campaigns`, {
      fields: `id,name,status,daily_budget,insights.time_range({"since":"${since}","until":"${until}"}){spend,actions,action_values}`,
      limit: "500",
    });
    return (body.data || []).filter((row: any) => includeOff || row.status === "ACTIVE").map((row: any) => {
      const insight = row.insights?.data?.[0] || {};
      const purchase = (insight.actions || []).find((x: any) => ["purchase", "omni_purchase"].includes(x.action_type));
      const revenue = (insight.action_values || []).find((x: any) => ["purchase", "omni_purchase"].includes(x.action_type));
      const spend = num(insight.spend);
      return { id: packed("meta", account.id, row.id), channel: "meta" as const, name: row.name, dailyBudget: num(row.daily_budget) / 100,
        status: asStatus(row.status), spend, conversions: num(purchase?.value), roas: spend ? Math.round(num(revenue?.value) / spend * 100) : 0,
        accountId: account.id, accountName: account.name };
    });
  });
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
  const body = await googleRequest(`customers/${cleanId(customer)}/googleAds:search`, { query });
  return body.results || [];
}
async function googleAccounts(): Promise<AdAccount[]> {
  const manager = cleanId(env("GOOGLE_ADS_LOGIN_CUSTOMER_ID") || "");
  if (!manager || !env("GOOGLE_ADS_DEVELOPER_TOKEN")) return [];
  const rows = await googleSearch(manager, "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.status = 'ENABLED' AND customer_client.manager = FALSE");
  // 관리자(MCC/하위 MCC) 계정은 측정항목 조회가 불가하므로 제외한다. 로그인 ID가 일반 광고계정이면 자기 자신이 포함된다.
  return rows.map((row: any) => ({ id: String(row.customerClient?.id || ""), channel: "google_ads" as const, name: row.customerClient?.descriptiveName || `Google Ads ${row.customerClient?.id}` })).filter((row: AdAccount) => row.id);
}
async function googleCampaigns(includeOff: boolean): Promise<Campaign[]> {
  const accounts = await googleAccounts();
  return settleAccounts(accounts, async (account) => {
    const status = includeOff ? "campaign.status != 'REMOVED'" : "campaign.status = 'ENABLED'";
    const rows = await googleSearch(account.id, `SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${status} AND segments.date DURING THIS_MONTH`);
    return rows.map((row: any) => {
      const spend = num(row.metrics?.costMicros) / 1_000_000;
      return { id: packed("google_ads", account.id, String(row.campaign.id)), channel: "google_ads" as const, name: row.campaign.name,
        dailyBudget: num(row.campaignBudget?.amountMicros) / 1_000_000, status: asStatus(row.campaign.status), spend,
        conversions: Math.round(num(row.metrics?.conversions)), roas: spend ? Math.round(num(row.metrics?.conversionsValue) / spend * 100) : 0,
        accountId: account.id, accountName: account.name };
    });
  });
}

// ---- 네이버 GFA (openapi.naver.com 광고 API, 네이버 로그인 OAuth) ----
const GFA_BASE = "https://openapi.naver.com/v1/ad-api/1.0";
function gfaConfig() {
  const clientId = env("NAVER_GFA_CLIENT_ID"), clientSecret = env("NAVER_GFA_CLIENT_SECRET"), refreshToken = env("NAVER_GFA_REFRESH_TOKEN");
  const manager = env("NAVER_GFA_MANAGER_ACCOUNT_NO", "NAVER_GFA_MANAGER_ACCOUNT_ID");
  return clientId && refreshToken && manager ? { clientId, clientSecret, refreshToken, manager: cleanId(manager) } : null;
}
let gfaTokenCache: { token: string; expiresAt: number } | null = null;
async function gfaToken(force = false) {
  if (!force && gfaTokenCache && gfaTokenCache.expiresAt > Date.now() + 60_000) return gfaTokenCache.token;
  const config = gfaConfig();
  if (!config) throw new Error("네이버 GFA 인증정보가 없습니다.");
  const params: Record<string, string> = { grant_type: "refresh_token", client_id: config.clientId, refresh_token: config.refreshToken };
  if (config.clientSecret) params.client_secret = config.clientSecret;
  const body = await jsonFetch("https://nid.naver.com/oauth2.0/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  if (!body.access_token) throw new Error(`네이버 GFA 토큰 갱신 실패: ${body.error_description || body.error || "알 수 없음"}`);
  gfaTokenCache = { token: body.access_token, expiresAt: Date.now() + num(body.expires_in || 3600) * 1000 };
  return body.access_token as string;
}
async function gfaGet(path: string, params: Record<string, string> = {}) {
  const config = gfaConfig();
  if (!config) throw new Error("네이버 GFA 인증정보가 없습니다.");
  const url = `${GFA_BASE}${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ""}`;
  const call = async (token: string) => fetch(url, { headers: { Authorization: `Bearer ${token}`, AccessManagerAccountNo: config.manager }, cache: "no-store" });
  let response = await call(await gfaToken());
  if (response.status === 401) response = await call(await gfaToken(true));
  const text = await response.text();
  let body: any; try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
  if (!response.ok) {
    const detail = [body?.message, body?.title, body?.detail, body?.error].find((v) => typeof v === "string") || JSON.stringify(body).slice(0, 300);
    throw new Error(`${detail} (HTTP ${response.status})`);
  }
  return body;
}
// 과거 성과(past) API는 어제까지만 조회되고, 어제 데이터는 KST 새벽 2시 이후에 열린다.
// 그래서 이번 달 1일 ~ 어제(새벽 3시 전이면 그제) 범위를 쓴다. 범위가 비면 조회하지 않는다.
function gfaPastRange() {
  const { since, until } = monthRange();
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  const y = new Date(`${until}T00:00:00Z`); y.setUTCDate(y.getUTCDate() - (hour < 3 ? 2 : 1));
  const yesterday = y.toISOString().slice(0, 10);
  return yesterday < since ? null : { startDate: since, endDate: yesterday, timeUnit: "daily" };
}
const gfaList = (body: any): any[] => Array.isArray(body) ? body : body?.content || body?.rows || body?.data || body?.items || [];
async function gfaAccounts(): Promise<AdAccount[]> {
  const config = gfaConfig();
  if (!config) return [];
  const configured = (env("NAVER_GFA_AD_ACCOUNT_NO", "NAVER_GFA_ACCOUNT_ID") || "").split(",").map((v) => cleanId(v)).filter(Boolean);
  // 매니저 계정에 연결된 광고계정 목록을 조회한다. 실패하면 환경변수에 지정한 계정으로 대체.
  let found: AdAccount[] = [];
  try {
    for (let page = 0; page < 20; page++) {
      const items = gfaList(await gfaGet("/adAccounts", { page: String(page), size: "100" }));
      found.push(...items.map((row: any) => {
        const id = String(row.no ?? row.adAccountNo ?? row.id ?? "");
        return { id, channel: "naver_gfa" as const, name: row.name || row.adAccountName || `네이버 GFA ${id}` };
      }).filter((row: AdAccount) => row.id));
      if (items.length < 100) break;
    }
  } catch (error) {
    if (!configured.length) throw error;
    found = [];
  }
  for (const id of configured) if (!found.some((row) => row.id === id)) found.push({ id, channel: "naver_gfa", name: `네이버 GFA ${id}` });
  return found;
}
async function gfaPaged(path: string, params: Record<string, string>) {
  const rows: any[] = [];
  let next: string | null = null;
  for (let page = 0; page < 50; page++) {
    const body = await gfaGet(path, { ...params, limit: "1000", ...(next ? { next } : {}) });
    rows.push(...(body.rows || []));
    next = body.next || null;
    if (!next) break;
  }
  return rows;
}
const gfaStatus = (row: any): EntityStatus => {
  if (typeof row.activated === "boolean") return row.activated ? "on" : "off";
  if (typeof row.enabled === "boolean") return row.enabled ? "on" : "off";
  return ["ON", "ACTIVE", "ENABLED", "RUNNING"].includes(String(row.status || row.campaignStatus || "").toUpperCase()) ? "on" : "off";
};
async function gfaCampaigns(includeOff: boolean): Promise<Campaign[]> {
  const accounts = await gfaAccounts();
  const range = gfaPastRange();
  return settleAccounts(accounts, async (account) => {
    const base = `/adAccounts/${account.id}`;
    const campaigns: any[] = [];
    for (let page = 0; page < 50; page++) {
      const items = gfaList(await gfaGet(`${base}/campaigns`, { page: String(page), size: "100" }));
      campaigns.push(...items);
      if (items.length < 100) break;
    }
    // 일반 캠페인은 애드셋 단위, 애드부스트는 캠페인 단위로 성과가 나오므로 시트 스크립트와 같은 방식으로 합산한다.
    const fetchRows = (path: string) => range ? gfaPaged(`${base}${path}`, range).catch(() => [] as any[]) : Promise.resolve([] as any[]);
    const [perfSets, convSets, perfCamps, convCamps] = await Promise.all([
      fetchRows("/performance/past/adSets"),
      fetchRows("/performance/conversion/past/adSets"),
      fetchRows("/performance/past/campaigns"),
      fetchRows("/performance/conversion/past/campaigns"),
    ]);
    const stats = new Map<string, { spend: number; conversions: number; revenue: number }>();
    const bucket = (no: unknown) => { const key = String(no ?? ""); if (!stats.has(key)) stats.set(key, { spend: 0, conversions: 0, revenue: 0 }); return stats.get(key)!; };
    const adSetCampaigns = new Set([...perfSets, ...convSets].map((row) => String(row.campaignNo ?? "")));
    for (const row of perfSets) bucket(row.campaignNo).spend += num(row.sales);
    for (const row of perfCamps) if (!adSetCampaigns.has(String(row.campaignNo ?? ""))) bucket(row.campaignNo).spend += num(row.sales);
    const addConv = (row: any) => { if (row.convType === "PURCHASE") { const b = bucket(row.campaignNo); b.conversions += num(row.convCount); b.revenue += num(row.convSales); } };
    convSets.forEach(addConv);
    convCamps.filter((row) => !adSetCampaigns.has(String(row.campaignNo ?? ""))).forEach(addConv);
    return campaigns.map((row) => {
      const id = String(row.no ?? row.campaignNo ?? row.id);
      const s = stats.get(id) || { spend: 0, conversions: 0, revenue: 0 };
      return { id: packed("naver_gfa", account.id, id), channel: "naver_gfa" as const, name: row.name || `캠페인 ${id}`,
        dailyBudget: num(row.dailyBudget ?? row.budget?.dailyBudget ?? row.budgetAmount), status: gfaStatus(row), spend: s.spend,
        conversions: Math.round(s.conversions), roas: s.spend ? Math.round(s.revenue / s.spend * 100) : 0, accountId: account.id, accountName: account.name };
    }).filter((row) => includeOff || row.status === "on" || row.spend > 0);
  });
}

// ---- 리포트: 매핑된 계정만 일자별로 조회 ----
const ymd = (d: Date) => d.toISOString().slice(0, 10);
function eachDate(since: string, until: string) {
  const out: string[] = [];
  for (let d = new Date(`${since}T00:00:00Z`); ymd(d) <= until; d.setUTCDate(d.getUTCDate() + 1)) out.push(ymd(d));
  return out;
}
const blankDay = (date: string, channel: Channel, accountId: string): DailyRow => ({ date, channel, accountId, spend: 0, revenue: 0, conversions: 0, impressions: 0, clicks: 0 });

async function googleDaily(accountId: string, since: string, until: string): Promise<DailyRow[]> {
  const rows = await googleSearch(accountId, `SELECT segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.impressions, metrics.clicks FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`);
  return rows.map((row: any) => ({ date: row.segments?.date, channel: "google_ads" as const, accountId,
    spend: num(row.metrics?.costMicros) / 1_000_000, revenue: num(row.metrics?.conversionsValue), conversions: num(row.metrics?.conversions),
    impressions: num(row.metrics?.impressions), clicks: num(row.metrics?.clicks) }));
}

const META_PURCHASE = ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"];
const metaPick = (list: any[] | undefined) => {
  const items = list || [];
  for (const type of META_PURCHASE) { const hit = items.find((x: any) => x.action_type === type); if (hit) return num(hit.value); }
  return 0;
};
async function metaDaily(accountId: string, since: string, until: string): Promise<DailyRow[]> {
  const rows = await metaPaged(`act_${accountId}/insights`, { level: "account", time_increment: "1", time_range: JSON.stringify({ since, until }), fields: "spend,impressions,clicks,actions,action_values" });
  return rows.map((row: any) => ({ date: row.date_start, channel: "meta" as const, accountId, spend: num(row.spend), revenue: metaPick(row.action_values),
    conversions: metaPick(row.actions), impressions: num(row.impressions), clicks: num(row.clicks) }));
}

function gfaClampRange(since: string, until: string) {
  const past = gfaPastRange();
  if (!past) return null;
  const end = until < past.endDate ? until : past.endDate;
  return end < since ? null : { startDate: since, endDate: end, timeUnit: "daily" };
}
async function gfaDaily(accountId: string, since: string, until: string): Promise<DailyRow[]> {
  const range = gfaClampRange(since, until);
  if (!range) return [];
  const base = `/adAccounts/${accountId}`;
  const [perfSets, convSets, perfCamps, convCamps] = await Promise.all([
    gfaPaged(`${base}/performance/past/adSets`, range), gfaPaged(`${base}/performance/conversion/past/adSets`, range),
    gfaPaged(`${base}/performance/past/campaigns`, range).catch(() => []), gfaPaged(`${base}/performance/conversion/past/campaigns`, range).catch(() => []),
  ]);
  const adSetCampaigns = new Set([...perfSets, ...convSets].map((row) => String(row.campaignNo ?? "")));
  const days = new Map<string, DailyRow>();
  const day = (date: string) => { if (!days.has(date)) days.set(date, blankDay(date, "naver_gfa", accountId)); return days.get(date)!; };
  const addPerf = (row: any) => { const d = day(row.targetDate); d.spend += num(row.sales); d.impressions += num(row.impCount); d.clicks += num(row.clickCount); };
  const addConv = (row: any) => { if (row.convType === "PURCHASE") { const d = day(row.targetDate); d.conversions += num(row.convCount); d.revenue += num(row.convSales); } };
  perfSets.forEach(addPerf); perfCamps.filter((row) => !adSetCampaigns.has(String(row.campaignNo ?? ""))).forEach(addPerf);
  convSets.forEach(addConv); convCamps.filter((row) => !adSetCampaigns.has(String(row.campaignNo ?? ""))).forEach(addConv);
  return [...days.values()];
}

// 네이버 SA 통계: 캠페인 ID 묶음으로 일자별(timeIncrement=1) 조회
async function naverStats(customerId: string, ids: string[], since: string, until: string, daily: boolean) {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const params = new URLSearchParams({
      ids: ids.slice(i, i + 50).join(","),
      fields: JSON.stringify(["impCnt", "clkCnt", "salesAmt", "ccnt", "convAmt"]),
      timeRange: JSON.stringify({ since, until }),
      ...(daily ? { timeIncrement: "1" } : {}),
    });
    const body = await naverRequest("GET", `/stats?${params}`, undefined, customerId);
    out.push(...(body?.data || []));
  }
  return out;
}
async function naverDaily(accountId: string, since: string, until: string): Promise<DailyRow[]> {
  const campaigns = await naverRequest("GET", "/ncc/campaigns", undefined, accountId);
  const ids = (campaigns as any[]).map((row) => row.nccCampaignId).filter(Boolean);
  if (!ids.length) return [];
  const rows = await naverStats(accountId, ids, since, until, true);
  const days = new Map<string, DailyRow>();
  for (const row of rows) {
    const date = String(row.dateStart || row.statDt || row.date || since).slice(0, 10);
    if (!days.has(date)) days.set(date, blankDay(date, "naver_sa", accountId));
    const d = days.get(date)!;
    d.spend += num(row.salesAmt); d.revenue += num(row.convAmt); d.conversions += num(row.ccnt); d.impressions += num(row.impCnt); d.clicks += num(row.clkCnt);
  }
  return [...days.values()];
}

const dailyFetchers: Record<Channel, (accountId: string, since: string, until: string) => Promise<DailyRow[]>> = {
  google_ads: googleDaily, meta: metaDaily, naver_gfa: gfaDaily, naver_sa: naverDaily,
};

/** accountKeys: "channel:accountId" 목록. 일자별·채널별·계정별 성과를 돌려준다. */
export async function getDailyReport(accountKeys: string[], since: string, until: string): Promise<ReportResult> {
  const targets = [...new Set(accountKeys)].map((key) => { const [channel, ...rest] = key.split(":"); return { channel: channel as Channel, accountId: rest.join(":") }; })
    .filter((t) => t.accountId && t.channel in dailyFetchers);
  const errors: ReportResult["errors"] = [];
  const results = await Promise.all(targets.map(async (t) => {
    try { return await dailyFetchers[t.channel](t.accountId, since, until); }
    catch (error) { errors.push({ ...t, message: error instanceof Error ? error.message : String(error) }); return []; }
  }));
  const rows = results.flat().filter((row) => row.date >= since && row.date <= until).sort((a, b) => a.date.localeCompare(b.date));
  return { since, until, rows, errors };
}
export { eachDate };

// ---- 소재 성과 ----
async function metaCreatives(accountId: string, since: string, until: string): Promise<CreativeRow[]> {
  const insights = await metaPaged(`act_${accountId}/insights`, {
    level: "ad", time_range: JSON.stringify({ since, until }),
    fields: "ad_id,ad_name,adset_name,campaign_name,spend,impressions,clicks,actions,action_values",
  });
  const top = insights.filter((row: any) => num(row.spend) > 0).sort((a: any, b: any) => num(b.spend) - num(a.spend)).slice(0, 60);
  const details: Record<string, any> = {};
  for (let i = 0; i < top.length; i += 25) {
    const ids = top.slice(i, i + 25).map((row: any) => row.ad_id).join(",");
    if (!ids) continue;
    // 썸네일은 400px로 요청한다 (기본 64px는 너무 작음)
    Object.assign(details, await metaGet("", { ids, fields: "effective_status,creative.thumbnail_width(400).thumbnail_height(400){thumbnail_url,image_url,title,body,object_story_spec}" }));
  }
  return top.map((row: any) => {
    const creative = details[row.ad_id]?.creative || {};
    const link = creative.object_story_spec?.link_data || creative.object_story_spec?.video_data || {};
    return { id: row.ad_id, channel: "meta" as const, accountId, name: row.ad_name, campaignName: row.campaign_name, groupName: row.adset_name,
      imageUrl: creative.image_url || link.picture || link.image_url || creative.thumbnail_url, headline: creative.title || link.name || link.title, body: creative.body || link.message,
      status: details[row.ad_id]?.effective_status, spend: num(row.spend), impressions: num(row.impressions), clicks: num(row.clicks),
      conversions: metaPick(row.actions), revenue: metaPick(row.action_values) };
  });
}

// GFA 소재: 소재 목록 + 소재 단위 과거 성과
async function gfaCreatives(accountId: string, since: string, until: string): Promise<CreativeRow[]> {
  const range = gfaClampRange(since, until);
  const base = `/adAccounts/${accountId}`;
  const creatives: any[] = [];
  for (let page = 0; page < 20; page++) {
    const items = gfaList(await gfaGet(`${base}/creatives`, { page: String(page), size: "100" }));
    creatives.push(...items);
    if (items.length < 100) break;
  }
  const [perf, conv] = range ? await Promise.all([
    gfaPaged(`${base}/performance/past/creatives`, range).catch(() => []),
    gfaPaged(`${base}/performance/conversion/past/creatives`, range).catch(() => []),
  ]) : [[], []];
  const stats = new Map<string, { spend: number; impressions: number; clicks: number; conversions: number; revenue: number }>();
  const stat = (no: unknown) => { const key = String(no ?? ""); if (!stats.has(key)) stats.set(key, { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 }); return stats.get(key)!; };
  for (const row of perf) { const st = stat(row.creativeNo ?? row.adNo); st.spend += num(row.sales); st.impressions += num(row.impCount); st.clicks += num(row.clickCount); }
  for (const row of conv) if (row.convType === "PURCHASE") { const st = stat(row.creativeNo ?? row.adNo); st.conversions += num(row.convCount); st.revenue += num(row.convSales); }
  return creatives.map((c: any) => {
    const id = String(c.no ?? c.creativeNo ?? c.id);
    const st = stats.get(id) || { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 };
    const media = c.medias?.[0] || c.media || c.images?.[0] || c.image || {};
    return { id, channel: "naver_gfa" as const, accountId, name: c.name || `소재 ${id}`, campaignName: c.campaignName, groupName: c.adSetName,
      imageUrl: media.url || media.imageUrl || c.imageUrl || c.thumbnailUrl || c.previewUrl, headline: c.title || c.headline, body: c.description || c.body,
      status: c.activated === undefined ? c.status : (c.activated ? "ON" : "OFF"), ...st };
  }).filter((row) => row.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 60);
}

export async function getCreativeReport(accountKeys: string[], since: string, until: string) {
  const targets = [...new Set(accountKeys)].map((key) => { const [channel, ...rest] = key.split(":"); return { channel: channel as Channel, accountId: rest.join(":") }; })
    .filter((t) => t.channel === "meta" || t.channel === "naver_gfa");
  const errors: Array<{ channel: Channel; accountId: string; message: string }> = [];
  const rows = (await Promise.all(targets.map(async (t) => {
    try { return t.channel === "meta" ? await metaCreatives(t.accountId, since, until) : await gfaCreatives(t.accountId, since, until); }
    catch (error) { errors.push({ ...t, message: error instanceof Error ? error.message : String(error) }); return []; }
  }))).flat();
  return { since, until, rows, errors };
}

// TEMP: GFA 소재 API 응답 구조 확인용
export async function debugGfaCreatives(accountId: string) {
  const range = gfaPastRange();
  const probe = async (path: string, params: Record<string, string>) => {
    try { const body = await gfaGet(path, params); return { keys: Object.keys(body || {}), sample: gfaList(body).slice(0, 2) }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  };
  return {
    creatives: await probe(`/adAccounts/${accountId}/creatives`, { page: "0", size: "2" }),
    perfCreatives: range ? await probe(`/adAccounts/${accountId}/performance/past/creatives`, { ...range, limit: "3" }) : "no range",
    convCreatives: range ? await probe(`/adAccounts/${accountId}/performance/conversion/past/creatives`, { ...range, limit: "3" }) : "no range",
  };
}

const channelNames: Record<Channel, string> = { naver_sa: "네이버 SA", naver_gfa: "네이버 GFA", meta: "Meta", google_ads: "Google Ads" };

export async function getLiveAccounts(): Promise<{ accounts: AdAccount[]; errors: Partial<Record<Channel, string>> }> {
  const accounts: AdAccount[] = [];
  const errors: Partial<Record<Channel, string>> = {};
  accounts.push(...await naverAccounts().catch(() => []));
  const results = await Promise.allSettled([metaAccounts(), googleAccounts(), gfaAccounts()]);
  if (results[2].status === "fulfilled") accounts.push(...results[2].value);
  else errors.naver_gfa = results[2].reason instanceof Error ? results[2].reason.message : String(results[2].reason);
  if (results[0].status === "fulfilled") accounts.push(...results[0].value);
  else errors.meta = results[0].reason instanceof Error ? results[0].reason.message : String(results[0].reason);
  if (results[1].status === "fulfilled") accounts.push(...results[1].value);
  else errors.google_ads = results[1].reason instanceof Error ? results[1].reason.message : String(results[1].reason);
  return { accounts, errors };
}

export async function getLiveSnapshot(includeOff = true): Promise<{ campaigns: Campaign[]; connections: ConnectionStatus[] }> {
  const missing = (...names: Array<string | [string, string]>) => names.filter((name) => Array.isArray(name) ? !env(name[0], name[1]) : !env(name)).map((name) => Array.isArray(name) ? `${name[0]} 또는 ${name[1]}` : name);
  const definitions: Array<{ channel: Channel; configured: boolean; missing: string[]; run?: () => Promise<Campaign[]>; unsupported?: string }> = [
    { channel: "naver_sa", missing: missing("NAVER_SA_API_KEY", "NAVER_SA_SECRET_KEY", ["NAVER_SA_CUSTOMER_ID", "NAVER_SA_MANAGER_CUSTOMER_ID"]), configured: Boolean(naverCredentials() || registeredNaverSa().length), run: () => naverCampaigns(includeOff) },
    { channel: "naver_gfa", missing: missing("NAVER_GFA_CLIENT_ID", "NAVER_GFA_REFRESH_TOKEN", ["NAVER_GFA_MANAGER_ACCOUNT_NO", "NAVER_GFA_MANAGER_ACCOUNT_ID"]), configured: Boolean(gfaConfig()), run: () => gfaCampaigns(includeOff) },
    { channel: "meta", missing: missing(["META_SYSTEM_USER_ACCESS_TOKEN", "META_ACCESS_TOKEN"]), configured: Boolean(metaToken()), run: () => metaCampaigns(includeOff) },
    { channel: "google_ads", missing: missing("GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_LOGIN_CUSTOMER_ID"), configured: Boolean(env("GOOGLE_ADS_DEVELOPER_TOKEN") && env("GOOGLE_ADS_CLIENT_ID") && env("GOOGLE_ADS_CLIENT_SECRET") && env("GOOGLE_ADS_REFRESH_TOKEN") && env("GOOGLE_ADS_LOGIN_CUSTOMER_ID")), run: () => googleCampaigns(includeOff) },
  ];
  const results = await Promise.all(definitions.map(async (definition) => {
    if (!definition.configured) return { definition, campaigns: [] as Campaign[], error: null };
    if (definition.unsupported) return { definition, campaigns: [] as Campaign[], error: null };
    try { return { definition, campaigns: await definition.run!(), error: null }; }
    catch (error) { return { definition, campaigns: [] as Campaign[], error: error instanceof Error ? error.message : String(error) }; }
  }));
  const campaigns = results.flatMap((result) => result.campaigns);
  const connections: ConnectionStatus[] = results.map(({ definition, campaigns: rows, error }) => {
    if (!definition.configured) return { channel: definition.channel, status: "not_configured", campaignCount: 0, message: `누락: ${definition.missing.join(", ")}` };
    if (definition.unsupported) return { channel: definition.channel, status: "unsupported", campaignCount: 0, message: definition.unsupported };
    if (error) return { channel: definition.channel, status: "error", campaignCount: 0, message: error };
    return { channel: definition.channel, status: "connected", campaignCount: rows.length, message: rows.length ? `${rows.length}개 캠페인 조회` : "연결 성공 · 조회된 캠페인 없음" };
  });
  return { campaigns, connections };
}

async function allCampaigns(includeOff = false) {
  const snapshot = await getLiveSnapshot(includeOff);
  if (!snapshot.campaigns.length && snapshot.connections.some((item) => item.status === "error")) {
    const errors = snapshot.connections.filter((item) => item.status === "error").map((item) => `${channelNames[item.channel]}: ${item.message}`);
    throw new Error(`실계정 조회 실패: ${errors.join(" / ")}`);
  }
  return snapshot.campaigns;
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
      const rows = await naverRequest("GET", `/ncc/adgroups?nccCampaignId=${encodeURIComponent(key.id)}`, undefined, key.account);
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
      const rows = await naverRequest("GET", `/ncc/ads?nccAdgroupId=${encodeURIComponent(key.id)}`, undefined, key.account);
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
      if (operation.kind === "set_status") await naverRequest("PUT", endpoint, { userLock: operation.status === "off" }, key.account);
      else await naverRequest("PUT", endpoint, { dailyBudget: operation.dailyBudget }, key.account);
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
