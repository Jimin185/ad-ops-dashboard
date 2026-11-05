import crypto from "node:crypto";
import { cacheGet, cacheSet, isFinalDate, nextDailyRefresh } from "@/lib/cache";
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

export async function naverRequest(method: string, path: string, body?: unknown, customerId?: string) {
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
        roas: spend ? Math.round(num(s.convAmt) / spend * 100) : 0, accountId: account.id, accountName: account.name,
        active: !row.userLock && row.status === "ELIGIBLE", rawStatus: row.status, product: productOf(row.campaignTp) };
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
      fields: `id,name,status,effective_status,stop_time,objective,daily_budget,insights.time_range({"since":"${since}","until":"${until}"}){spend,actions,action_values,catalog_segment_actions,catalog_segment_value}`,
      limit: "500",
    });
    return (body.data || []).filter((row: any) => includeOff || row.status === "ACTIVE").map((row: any) => {
      const insight = row.insights?.data?.[0] || {};
      const purchase = { value: metaConv(insight) };
      const revenue = { value: metaRev(insight) };
      const spend = num(insight.spend);
      return { id: packed("meta", account.id, row.id), channel: "meta" as const, name: row.name, dailyBudget: num(row.daily_budget) / 100,
        status: asStatus(row.status), spend, conversions: num(purchase?.value), roas: spend ? Math.round(num(revenue?.value) / spend * 100) : 0,
        accountId: account.id, accountName: account.name,
        active: row.effective_status === "ACTIVE" && (!row.stop_time || new Date(row.stop_time).getTime() > Date.now()), rawStatus: row.effective_status || row.status, product: productOf(row.objective) };
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
    const rows = await googleSearch(account.id, `SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.advertising_channel_type, campaign_budget.amount_micros, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${status} AND segments.date DURING THIS_MONTH`);
    return rows.map((row: any) => {
      const spend = num(row.metrics?.costMicros) / 1_000_000;
      return { id: packed("google_ads", account.id, String(row.campaign.id)), channel: "google_ads" as const, name: row.campaign.name,
        dailyBudget: num(row.campaignBudget?.amountMicros) / 1_000_000, status: asStatus(row.campaign.status), spend,
        conversions: Math.round(num(row.metrics?.conversions)), roas: spend ? Math.round(num(row.metrics?.conversionsValue) / spend * 100) : 0,
        accountId: account.id, accountName: account.name,
        active: row.campaign.status === "ENABLED" && !["ENDED", "SUSPENDED", "NONE"].includes(row.campaign.servingStatus), rawStatus: row.campaign.servingStatus || row.campaign.status, product: productOf(row.campaign.advertisingChannelType) };
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
        conversions: Math.round(s.conversions), roas: s.spend ? Math.round(s.revenue / s.spend * 100) : 0, accountId: account.id, accountName: account.name,
        active: gfaStatus(row) === "on" && !row.deleted && !["COMPLETED", "FINISHED", "ENDED", "DELETED", "STOPPED", "EXPIRED"].includes(String(row.status || "").toUpperCase()), rawStatus: row.status, product: productOf(row.objective) };
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
// 협력광고(카탈로그 공유) 계정은 구매가 catalog_segment_* 에 잡힌다. 어떤 계정이 협력광고인지 모르므로 항상 둘을 더한다.
const META_CATALOG_FIELDS = "catalog_segment_actions,catalog_segment_value";
const metaConv = (row: any) => metaPick(row?.actions) + metaPick(row?.catalog_segment_actions);
const metaRev = (row: any) => metaPick(row?.action_values) + metaPick(row?.catalog_segment_value);
/** catalog_segment 필드를 못 받는 계정이면 빼고 다시 요청한다. */
async function metaInsightsSafe(path: string, params: Record<string, string>) {
  try { return await metaPaged(path, params); }
  catch (error) {
    if (!/catalog_segment/i.test(String(error)) && !/Invalid parameter|nonexisting field/i.test(String(error))) throw error;
    return metaPaged(path, { ...params, fields: params.fields.replace(/,?catalog_segment_(actions|value)/g, "") });
  }
}
const metaPick = (list: any[] | undefined) => {
  const items = list || [];
  for (const type of META_PURCHASE) { const hit = items.find((x: any) => x.action_type === type); if (hit) return num(hit.value); }
  return 0;
};
async function metaDaily(accountId: string, since: string, until: string): Promise<DailyRow[]> {
  const rows = await metaInsightsSafe(`act_${accountId}/insights`, { level: "account", time_increment: "1", time_range: JSON.stringify({ since, until }), fields: `spend,impressions,clicks,actions,action_values,${META_CATALOG_FIELDS}` });
  return rows.map((row: any) => ({ date: row.date_start, channel: "meta" as const, accountId, spend: num(row.spend), revenue: metaRev(row),
    conversions: metaConv(row), impressions: num(row.impressions), clicks: num(row.clicks) }));
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

// 네이버 SA 통계: 여러 ID 합계는 ids로 한 번에, 일자별(timeIncrement)은 단일 id만 지원된다.
async function naverStats(customerId: string, ids: string[], since: string, until: string, daily: boolean) {
  const fields = JSON.stringify(["impCnt", "clkCnt", "salesAmt", "ccnt", "convAmt"]);
  const timeRange = JSON.stringify({ since, until });
  if (!daily) {
    const out: any[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const body = await naverRequest("GET", `/stats?${new URLSearchParams({ ids: ids.slice(i, i + 50).join(","), fields, timeRange })}`, undefined, customerId);
      out.push(...(body?.data || []));
    }
    return out;
  }
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 5) {
    const batch = await Promise.all(ids.slice(i, i + 5).map((id) =>
      naverRequest("GET", `/stats?${new URLSearchParams({ id, fields, timeRange, timeIncrement: "1" })}`, undefined, customerId).then((body) => body?.data || [])));
    out.push(...batch.flat());
  }
  return out;
}
async function naverDaily(accountId: string, since: string, until: string): Promise<DailyRow[]> {
  const campaigns = await naverRequest("GET", "/ncc/campaigns", undefined, accountId);
  const ids = (campaigns as any[]).map((row) => row.nccCampaignId).filter(Boolean);
  if (!ids.length) return [];
  // 기간 내 광고비가 있었던 캠페인만 일자별로 조회 (요청 수 절약)
  const totals = await naverStats(accountId, ids, since, until, false);
  const active = totals.filter((row) => num(row.salesAmt) > 0 || num(row.impCnt) > 0).map((row) => row.id).slice(0, 60);
  const rows = await naverStats(accountId, active, since, until, true);
  const days = new Map<string, DailyRow>();
  for (const row of rows) {
    const date = String(row.dateStart || since).slice(0, 10);
    if (!days.has(date)) days.set(date, blankDay(date, "naver_sa", accountId));
    const d = days.get(date)!;
    d.spend += num(row.salesAmt); d.revenue += num(row.convAmt); d.conversions += num(row.ccnt); d.impressions += num(row.impCnt); d.clicks += num(row.clkCnt);
  }
  return [...days.values()];
}

const dailyFetchers: Record<Channel, (accountId: string, since: string, until: string) => Promise<DailyRow[]>> = {
  google_ads: googleDaily, meta: metaDaily, naver_gfa: gfaDaily, naver_sa: naverDaily,
};

type DailyBucket = { rows: Record<string, DailyRow>; covered: Record<string, string> }; // covered: 날짜 → 가져온 시각(ISO)

/**
 * 계정 하나의 일자별 성과. 월 단위 버킷으로 저장한다.
 * - 확정 날짜(이번 주 월요일 이전)는 한 번 가져오면 다시 부르지 않는다 (적재).
 * - 그 외 날짜는 오늘 오전 6시(KST) 이후에 가져온 적 있으면 재사용한다 (하루 한 번).
 */
async function cachedDaily(channel: Channel, accountId: string, since: string, until: string, force: boolean) {
  const months = [...new Set(eachDate(since, until).map((d) => d.slice(0, 7)))];
  const buckets: Record<string, DailyBucket> = {};
  for (const month of months) buckets[month] = (await cacheGet<DailyBucket>(`daily:v2:${channel}:${accountId}:${month}`))?.value || { rows: {}, covered: {} };
  const refreshFloor = nextDailyRefresh() - 24 * 3600_000;
  const usable = (date: string) => {
    const at = buckets[date.slice(0, 7)].covered[date];
    if (!at) return false;
    if (isFinalDate(date) && new Date(at).getTime() >= new Date(`${date}T00:00:00Z`).getTime() + 3 * 86400_000) return true; // 확정 + 3일 이상 지나서 수집
    return !force && new Date(at).getTime() >= refreshFloor;
  };
  const missing = eachDate(since, until).filter((d) => !usable(d));
  let fetched = 0;
  if (missing.length) {
    const from = missing[0], to = missing[missing.length - 1];
    const rows = await dailyFetchers[channel](accountId, from, to);
    const stamp = new Date().toISOString();
    for (const date of eachDate(from, to)) { const b = buckets[date.slice(0, 7)]; if (!b) continue; b.covered[date] = stamp; delete b.rows[date]; }
    for (const row of rows) { const b = buckets[row.date?.slice(0, 7)]; if (b && row.date >= from && row.date <= to) b.rows[row.date] = row; }
    for (const month of months) await cacheSet(`daily:v2:${channel}:${accountId}:${month}`, buckets[month], null);
    fetched = missing.length;
  }
  const rows = eachDate(since, until).map((d) => buckets[d.slice(0, 7)].rows[d]).filter(Boolean) as DailyRow[];
  const oldest = Math.min(...eachDate(since, until).map((d) => new Date(buckets[d.slice(0, 7)].covered[d] || Date.now()).getTime()));
  return { rows, fetched, oldest };
}

/** accountKeys: "channel:accountId" 목록. 일자별·채널별·계정별 성과를 돌려준다. */
export async function getDailyReport(accountKeys: string[], since: string, until: string, force = false): Promise<ReportResult & { fetchedAt: string; apiCalls: number }> {
  const targets = [...new Set(accountKeys)].map((key) => { const [channel, ...rest] = key.split(":"); return { channel: channel as Channel, accountId: rest.join(":") }; })
    .filter((t) => t.accountId && t.channel in dailyFetchers);
  const errors: ReportResult["errors"] = [];
  let apiCalls = 0, oldest = Date.now();
  const results = await Promise.all(targets.map(async (t) => {
    try { const r = await cachedDaily(t.channel, t.accountId, since, until, force); if (r.fetched) apiCalls++; oldest = Math.min(oldest, r.oldest); return r.rows; }
    catch (error) { errors.push({ ...t, message: error instanceof Error ? error.message : String(error) }); return []; }
  }));
  const rows = results.flat().filter((row) => row.date >= since && row.date <= until).sort((a, b) => a.date.localeCompare(b.date));
  return { since, until, rows, errors, fetchedAt: new Date(oldest).toISOString(), apiCalls };
}
export { eachDate };

// ---- 소재 성과 ----
async function metaCreatives(accountId: string, since: string, until: string): Promise<CreativeRow[]> {
  const insights = await metaInsightsSafe(`act_${accountId}/insights`, {
    level: "ad", time_range: JSON.stringify({ since, until }),
    fields: `ad_id,ad_name,adset_name,campaign_id,campaign_name,spend,impressions,clicks,actions,action_values,${META_CATALOG_FIELDS}`,
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
    return { id: row.ad_id, channel: "meta" as const, accountId, campaignId: packed("meta", accountId, String(row.campaign_id)), name: row.ad_name, campaignName: row.campaign_name, groupName: row.adset_name,
      imageUrl: creative.image_url || link.picture || link.image_url || creative.thumbnail_url, headline: creative.title || link.name || link.title, body: creative.body || link.message,
      status: details[row.ad_id]?.effective_status, spend: num(row.spend), impressions: num(row.impressions), clicks: num(row.clicks),
      conversions: metaConv(row), revenue: metaRev(row) };
  });
}

// GFA 소재: 소재 목록 + 소재 단위 과거 성과
async function gfaCreatives(accountId: string, since: string, until: string): Promise<CreativeRow[]> {
  const range = gfaClampRange(since, until);
  const base = `/adAccounts/${accountId}`;
  if (!range) return [];
  // 성과가 있는 소재만 골라 상세(이름·이미지)를 받는다. 전체 소재 목록(수천 개)을 받으면 60초를 넘긴다.
  const [perf, conv] = await Promise.all([
    gfaPaged(`${base}/performance/past/creatives`, range).catch(() => []),
    gfaPaged(`${base}/performance/conversion/past/creatives`, range).catch(() => []),
  ]);
  const stats = new Map<string, { spend: number; impressions: number; clicks: number; conversions: number; revenue: number; campaignNo: string }>();
  const stat = (row: any) => { const key = String(row.creativeNo ?? row.adNo ?? ""); if (!stats.has(key)) stats.set(key, { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, campaignNo: String(row.campaignNo ?? "") }); return stats.get(key)!; };
  for (const row of perf) { const st = stat(row); st.spend += num(row.sales); st.impressions += num(row.impCount); st.clicks += num(row.clickCount); }
  for (const row of conv) if (row.convType === "PURCHASE") { const st = stat(row); st.conversions += num(row.convCount); st.revenue += num(row.convSales); }
  const top = [...stats.entries()].filter(([, v]) => v.spend > 0).sort((a, b) => b[1].spend - a[1].spend).slice(0, 60);
  // 소재 상세는 ID별로 오래 캐시 (이름·이미지는 거의 안 바뀜)
  const detailKey = `gfa-creative-detail:${accountId}`;
  const details = (await cacheGet<Record<string, any>>(detailKey))?.value || {};
  const missing = top.map(([id]) => id).filter((id) => !(id in details));
  for (let i = 0; i < missing.length; i += 10) {
    await Promise.all(missing.slice(i, i + 10).map(async (id) => {
      try { const c = await gfaGet(`${base}/creatives/${id}`); const media = c.image || c.medias?.[0] || c.media || {}; details[id] = { name: c.name, image: media.imageUrl || media.url || c.imageUrl, title: c.title || c.headline, body: c.description, activated: c.activated, status: c.status }; }
      catch { details[id] = null; }
    }));
  }
  if (missing.length) await cacheSet(detailKey, details, Date.now() + 14 * 86400_000);
  return top.map(([id, st]) => {
    const c = details[id] || {};
    return { id, channel: "naver_gfa" as const, accountId, campaignId: st.campaignNo ? packed("naver_gfa", accountId, st.campaignNo) : undefined, name: c.name || `소재 ${id}`,
      imageUrl: c.image, headline: c.title, body: c.body, status: c.activated === undefined ? c.status : (c.activated ? "ON" : "OFF"),
      spend: st.spend, impressions: st.impressions, clicks: st.clicks, conversions: st.conversions, revenue: st.revenue };
  });
}

export async function getCreativeReport(accountKeys: string[], since: string, until: string, force = false) {
  const targets = [...new Set(accountKeys)].map((key) => { const [channel, ...rest] = key.split(":"); return { channel: channel as Channel, accountId: rest.join(":") }; })
    .filter((t) => t.channel === "meta" || t.channel === "naver_gfa");
  const errors: Array<{ channel: Channel; accountId: string; message: string }> = [];
  let oldest = Date.now();
  const pendingAccounts: string[] = [];
  const timeLimit = <T,>(promise: Promise<T>, ms: number) => Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
  const rows = (await Promise.all(targets.map(async (t) => {
    // 지난 주 이전 기간은 영구 적재, 그 외는 하루 한 번 갱신
    const key = `creative:v2:${t.channel}:${t.accountId}:${since}:${until}`;
    const cached = force ? null : await cacheGet<CreativeRow[]>(key);
    if (cached) { oldest = Math.min(oldest, cached.updatedAt); return cached.value; }
    try {
      const work = (t.channel === "meta" ? metaCreatives(t.accountId, since, until) : gfaCreatives(t.accountId, since, until))
        .then(async (rows) => { await cacheSet(key, rows, isFinalDate(until) ? null : nextDailyRefresh()); return rows; });
      // 45초 안에 안 끝나는 계정은 다음 호출에서 이어서 (끝난 계정은 이미 저장됨)
      const result = await timeLimit(work, 45_000);
      if (result === "timeout") { pendingAccounts.push(`${t.channel}:${t.accountId}`); return []; }
      return result;
    }
    catch (error) { errors.push({ ...t, message: error instanceof Error ? error.message : String(error) }); return []; }
  }))).flat();
  return { since, until, rows, errors, pending: pendingAccounts, fetchedAt: new Date(oldest).toISOString() };
}

// ---- 네이버 SA 대용량 리포트 (stat-reports: 비동기 생성 → 다운로드) ----
export async function naverStatReport(customerId: string, reportTp: string, statDt: string, waitMs = 25_000): Promise<string[][] | "pending"> {
  const key = naverKeyFor(customerId);
  // 이미 요청해 둔 리포트가 있으면 그 작업을 이어서 기다린다 (매번 새로 요청하면 영원히 끝나지 않음)
  const jobKey = `sa-job:${customerId}:${reportTp}:${statDt}`;
  let jobId = (await cacheGet<number>(jobKey))?.value;
  if (!jobId) {
    const job = await naverSigned(key, "POST", "/stat-reports", { reportTp, statDt: statDt.replace(/-/g, "") });
    jobId = job?.reportJobId;
    if (!jobId) throw new Error(`리포트 요청 실패: ${JSON.stringify(job).slice(0, 200)}`);
    await cacheSet(jobKey, jobId, Date.now() + 3 * 3600_000);
  }
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    const status = await naverSigned(key, "GET", `/stat-reports/${jobId}`);
    if (status?.status === "BUILT" && status.downloadUrl) {
      const timestamp = Date.now().toString();
      const signature = crypto.createHmac("sha256", key.secret).update(`${timestamp}.GET./report-download`).digest("base64");
      const res = await fetch(status.downloadUrl, { headers: { "X-Timestamp": timestamp, "X-API-KEY": key.apiKey, "X-Customer": key.customerId, "X-Signature": signature }, cache: "no-store" });
      const text = await res.text();
      if (!text.trim() || text.trim().startsWith("{")) return [];
      return text.trim().split("\n").map((line) => line.split("\t"));
    }
    if (status?.status === "NONE" || status?.status === "ERROR" || status?.status === "REGIST_FAIL") { await cacheSet(jobKey, 0, Date.now() + 1000); return []; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "pending";
}

// ---- 네이버 SA 상세 분석 (키워드·소재·쇼핑 검색어·제품) ----
// 하루치 리포트 4종을 받아 (캠페인|그룹|키워드/검색어|소재) 단위로 합쳐서 날짜별로 캐시한다.
// 값 배열: [노출, 클릭, 비용, 구매수, 구매매출, 장바구니수]
type SaVals = [number, number, number, number, number, number];
type SaDay = { ad: Record<string, SaVals>; term: Record<string, SaVals> };
const addVals = (map: Record<string, SaVals>, key: string, i: number, v: number) => { (map[key] ||= [0, 0, 0, 0, 0, 0])[i] += v; };

async function saDay(customerId: string, date: string, force: boolean): Promise<SaDay | "pending"> {
  const key = `sa-day:${customerId}:${date}`;
  const cached = await cacheGet<SaDay & { at: string }>(key);
  if (cached) {
    const finalOk = isFinalDate(date) && new Date(cached.value.at).getTime() >= new Date(`${date}T00:00:00Z`).getTime() + 3 * 86400_000;
    if (finalOk || (!force && new Date(cached.value.at).getTime() >= nextDailyRefresh() - 24 * 3600_000)) return cached.value;
  }
  const [ad, adConv, term, termConv] = await Promise.all(["AD", "AD_CONVERSION", "SHOPPINGKEYWORD_DETAIL", "SHOPPINGKEYWORD_CONVERSION_DETAIL"].map((tp) => naverStatReport(customerId, tp, date, 12_000)));
  if ([ad, adConv, term, termConv].some((r) => r === "pending")) return "pending";
  const day: SaDay = { ad: {}, term: {} };
  for (const r of ad as string[][]) { const k = `${r[2]}|${r[3]}|${r[4] || "-"}|${r[5] || "-"}`; addVals(day.ad, k, 0, num(r[9])); addVals(day.ad, k, 1, num(r[10])); addVals(day.ad, k, 2, num(r[11])); }
  for (const r of adConv as string[][]) { const k = `${r[2]}|${r[3]}|${r[4] || "-"}|${r[5] || "-"}`; if (r[10] === "purchase") { addVals(day.ad, k, 3, num(r[11])); addVals(day.ad, k, 4, num(r[12])); } else if (r[10] === "add_to_cart") addVals(day.ad, k, 5, num(r[11])); }
  for (const r of term as string[][]) { const k = `${r[2]}|${r[3]}|${r[4] || "-"}|${r[5] || "-"}`; addVals(day.term, k, 0, num(r[11])); addVals(day.term, k, 1, num(r[12])); addVals(day.term, k, 2, num(r[13])); }
  for (const r of termConv as string[][]) { const k = `${r[2]}|${r[3]}|${r[4] || "-"}|${r[5] || "-"}`; if (r[12] === "purchase") { addVals(day.term, k, 3, num(r[13])); addVals(day.term, k, 4, num(r[14])); } else if (r[12] === "add_to_cart") addVals(day.term, k, 5, num(r[13])); }
  await cacheSet(key, { ...day, at: new Date().toISOString() }, isFinalDate(date) ? null : nextDailyRefresh() + 7 * 86400_000);
  return day;
}

async function saNames(customerId: string, path: "adgroups" | "keywords" | "ads", ids: string[]) {
  const key = `sa-names:${customerId}:${path}`;
  const known = (await cacheGet<Record<string, any>>(key))?.value || {};
  const missing = ids.filter((id) => id && id !== "-" && !(id in known));
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    try {
      const rows = await naverRequest("GET", `/ncc/${path}?ids=${chunk.join(",")}`, undefined, customerId) as any[];
      for (const row of rows || []) {
        if (path === "adgroups") known[row.nccAdgroupId] = { name: row.name, active: !row.userLock && row.status !== "PAUSED" };
        else if (path === "keywords") known[row.nccKeywordId] = { name: row.keyword, active: !row.userLock };
        else {
          const ref = row.referenceData || {};
          known[row.nccAdId] = { type: row.type, headline: row.ad?.headline, description: row.ad?.description, product: ref.productName || ref.productTitle, image: ref.imageUrl, price: num(ref.lowPrice || ref.mobilePrice), category: ref.fullMallCatNm, active: !row.userLock && row.status !== "PAUSED" };
        }
      }
      for (const id of chunk) if (!(id in known)) known[id] = null;
    } catch { break; }
  }
  if (missing.length) await cacheSet(key, known, nextDailyRefresh() + 6 * 86400_000);
  return known;
}

export type SaRow = { imp: number; clk: number; cost: number; conv: number; revenue: number; cart: number };
const toRow = (v: SaVals): SaRow => ({ imp: v[0], clk: v[1], cost: v[2], conv: v[3], revenue: v[4], cart: v[5] });

/** 기간의 SA 상세 분석. 시간이 걸리는 날짜가 남으면 status: "loading"으로 진행률만 돌려주고, 다시 부르면 이어서 받는다. */
export async function getSaInsights(customerId: string, since: string, until: string, force = false) {
  const dates = eachDate(since, until);
  const started = Date.now();
  const days: SaDay[] = [];
  let pending = 0;
  for (let i = 0; i < dates.length; i += 4) {
    if (Date.now() - started > 25_000) { pending += dates.length - i; break; }
    const batch = await Promise.all(dates.slice(i, i + 4).map((d) => saDay(customerId, d, force).catch(() => "pending" as const)));
    for (const d of batch) if (d === "pending") pending++; else days.push(d);
  }
  if (pending) return { status: "loading" as const, ready: dates.length - pending, total: dates.length };

  const ad: Record<string, SaVals> = {}, term: Record<string, SaVals> = {};
  for (const d of days) {
    for (const [k, v] of Object.entries(d.ad)) v.forEach((x, i) => addVals(ad, k, i, x));
    for (const [k, v] of Object.entries(d.term)) v.forEach((x, i) => addVals(term, k, i, x));
  }
  const campaigns = (await naverRequest("GET", "/ncc/campaigns", undefined, customerId)) as any[];
  const campaignInfo = Object.fromEntries(campaigns.map((c) => [c.nccCampaignId, { name: c.name, type: c.campaignTp }]));
  const sum = (entries: Array<[string, SaVals]>, keyOf: (parts: string[]) => string) => {
    const out: Record<string, SaVals> = {};
    for (const [k, v] of entries) { const g = keyOf(k.split("|")); v.forEach((x, i) => addVals(out, g, i, x)); }
    return out;
  };
  const adEntries = Object.entries(ad);
  const byGroup = sum(adEntries, (p) => `${p[0]}|${p[1]}`);
  const byKeyword = sum(adEntries.filter(([k]) => k.split("|")[2] !== "-"), (p) => `${p[0]}|${p[1]}|${p[2]}`);
  const byAd = sum(adEntries, (p) => `${p[0]}|${p[1]}|${p[3]}`);
  const byTerm = sum(Object.entries(term), (p) => `${p[0]}|${p[1]}|${p[2]}`);
  const top = (m: Record<string, SaVals>, n: number) => Object.entries(m).sort((a, b) => b[1][2] - a[1][2] || b[1][0] - a[1][0]).slice(0, n);

  const groupsTop = top(byGroup, 400), keywordsTop = top(byKeyword, 600), adsTop = top(byAd, 600);
  const [groupNames, keywordNames, adInfo] = await Promise.all([
    saNames(customerId, "adgroups", groupsTop.map(([k]) => k.split("|")[1])),
    saNames(customerId, "keywords", keywordsTop.slice(0, 300).map(([k]) => k.split("|")[2])),
    saNames(customerId, "ads", adsTop.filter(([k]) => /SHOPPING|WEB_SITE/.test(campaignInfo[k.split("|")[0]]?.type || "")).slice(0, 300).map(([k]) => k.split("|")[2])),
  ]);
  const base = (cmp: string, grp: string) => ({ campaignId: cmp, campaign: campaignInfo[cmp]?.name || cmp, type: campaignInfo[cmp]?.type || "", adgroupId: grp, adgroup: groupNames[grp]?.name || grp });

  const adRows = adsTop.map(([k, v]) => { const [cmp, grp, id] = k.split("|"); return { ...base(cmp, grp), id, info: adInfo[id] || null, ...toRow(v) }; });
  // 제품 = 쇼핑검색 캠페인의 소재(상품). 같은 상품이 여러 그룹에 있으면 합친다.
  const products: Record<string, any> = {};
  for (const r of adRows.filter((r) => r.type === "SHOPPING" && r.info?.product)) {
    const p = (products[r.info.product] ||= { name: r.info.product, image: r.info.image, price: r.info.price, category: r.info.category, groups: new Set<string>(), imp: 0, clk: 0, cost: 0, conv: 0, revenue: 0, cart: 0 });
    p.groups.add(r.adgroup); for (const f of ["imp", "clk", "cost", "conv", "revenue", "cart"] as const) p[f] += r[f];
  }
  const typeTotals: Record<string, SaVals> = {};
  for (const [k, v] of adEntries) { const t = campaignInfo[k.split("|")[0]]?.type || "기타"; v.forEach((x, i) => addVals(typeTotals, t, i, x)); }

  return {
    status: "ready" as const, since, until,
    typeTotals: Object.entries(typeTotals).map(([type, v]) => ({ type, ...toRow(v) })),
    adgroups: groupsTop.map(([k, v]) => { const [cmp, grp] = k.split("|"); return { ...base(cmp, grp), active: groupNames[grp]?.active ?? true, ...toRow(v) }; }),
    keywords: keywordsTop.map(([k, v]) => { const [cmp, grp, kw] = k.split("|"); return { ...base(cmp, grp), id: kw, keyword: keywordNames[kw]?.name || "(이름 미조회)", active: keywordNames[kw]?.active ?? true, ...toRow(v) }; }),
    powerlinkAds: adRows.filter((r) => r.type === "WEB_SITE" && r.id !== "-").map((r) => ({ ...r, headline: r.info?.headline, description: r.info?.description, active: r.info?.active ?? true, info: undefined })),
    searchTerms: top(byTerm, 800).map(([k, v]) => { const [cmp, grp, t] = k.split("|"); return { ...base(cmp, grp), term: t, ...toRow(v) }; }),
    products: Object.values(products).map((p) => ({ ...p, groups: [...p.groups] })).sort((a, b) => b.cost - a.cost),
  };
}

// ---- 범용 매체 API (AI 세팅용) ----
// 조회는 바로, 변경은 사용자 승인 후 실행된다. 모든 요청은 선택한 광고주에 매핑된 계정 안에서만 허용한다.
export type MediaMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type MediaStep = { channel: Channel; accountId: string; method: MediaMethod; path: string; body?: unknown; note?: string };

const metaObjectId = (path: string) => path.replace(/^\/+/, "").split(/[/?]/)[0];

/** 요청이 해당 계정 범위 안인지 확인. 범위 밖이면 이유를 담아 예외. */
export async function assertMediaScope(step: MediaStep, allowedKeys: string[]) {
  const account = cleanId(step.accountId);
  if (!allowedKeys.includes(`${step.channel}:${account}`)) throw new Error(`${step.channel}:${account} 계정은 이 광고주에 매핑돼 있지 않습니다.`);
  const path = step.path.replace(/^\/+/, "");
  if (step.channel === "google_ads" && !path.startsWith(`customers/${account}`)) throw new Error(`Google Ads 경로는 customers/${account}/... 로 시작해야 합니다.`);
  if (step.channel === "naver_gfa" && !path.startsWith(`adAccounts/${account}`)) throw new Error(`GFA 경로는 /adAccounts/${account}/... 로 시작해야 합니다.`);
  if (step.channel === "meta") {
    const id = metaObjectId(path);
    if (id.startsWith("act_")) { if (id !== `act_${account}`) throw new Error(`다른 Meta 광고계정(${id})입니다.`); }
    else if (step.method !== "GET" && /^\d+$/.test(id)) {
      // 캠페인·광고세트·광고·크리에이티브 ID면 소속 광고계정을 확인
      const owner = await metaGet(id, { fields: "account_id" }).catch(() => null);
      if (owner?.account_id && String(owner.account_id).replace(/^act_/, "") !== account) throw new Error(`대상 ${id}는 다른 Meta 광고계정 소속입니다.`);
    }
  }
}

const GFA_RESOURCE: Record<EntityType, "campaigns" | "adSets" | "creatives"> = { campaign: "campaigns", adgroup: "adSets", ad: "creatives" };
// GFA 수정: 현재 객체를 받아 필드만 바꿔 다시 보낸다(PUT 우선, 안 되면 PATCH). 두 방식 모두 실패하면 매체 오류를 그대로 보여준다.
async function gfaUpdate(account: string, resource: "campaigns" | "adSets" | "creatives", id: string, mutate: (row: any) => any) {
  const path = `adAccounts/${account}/${resource}/${id}`;
  const current = await gfaRequest("GET", path);
  const row = current?.data && typeof current.data === "object" && !Array.isArray(current.data) ? current.data : current;
  const next = mutate(JSON.parse(JSON.stringify(row)));
  const errors: string[] = [];
  for (const method of ["PUT", "PATCH"] as MediaMethod[]) {
    try { return await gfaRequest(method, path, next); } catch (error) { errors.push(`${method}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  throw new Error(`GFA 변경 실패 — ${errors.join(" / ")}`);
}

async function gfaRequest(method: MediaMethod, path: string, body?: unknown) {
  const config = gfaConfig();
  if (!config) throw new Error("네이버 GFA 인증정보가 없습니다.");
  const url = `${GFA_BASE}/${path.replace(/^\/+/, "")}`;
  const call = async (token: string) => fetch(url, { method, headers: { Authorization: `Bearer ${token}`, AccessManagerAccountNo: config.manager, "Content-Type": "application/json" }, body: body === undefined || method === "GET" ? undefined : JSON.stringify(body), cache: "no-store" });
  let response = await call(await gfaToken());
  if (response.status === 401) response = await call(await gfaToken(true));
  const text = await response.text();
  let parsed: any; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { message: text }; }
  if (!response.ok) throw new Error(`${[parsed?.message, parsed?.error?.message, parsed?.title].find((v) => typeof v === "string") || JSON.stringify(parsed).slice(0, 400)} (HTTP ${response.status})`);
  return parsed;
}

async function googleRaw(method: MediaMethod, path: string, body?: unknown) {
  const developerToken = env("GOOGLE_ADS_DEVELOPER_TOKEN"), loginId = env("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
  if (!developerToken || !loginId) throw new Error("Google Ads MCC 인증정보가 없습니다.");
  return jsonFetch(`https://googleads.googleapis.com/${GOOGLE_VERSION}/${path.replace(/^\/+/, "")}`, {
    method, headers: { Authorization: `Bearer ${await googleToken()}`, "developer-token": developerToken, "login-customer-id": cleanId(loginId), "Content-Type": "application/json" },
    body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
  });
}

async function metaRaw(method: MediaMethod, path: string, body?: unknown) {
  const token = metaToken();
  if (!token) throw new Error("Meta 액세스 토큰이 없습니다.");
  const clean = path.replace(/^\/+/, "");
  if (method === "GET") {
    const [p, q] = clean.split("?");
    const params = new URLSearchParams(q || "");
    if (body && typeof body === "object") for (const [k, v] of Object.entries(body as any)) params.set(k, typeof v === "string" ? v : JSON.stringify(v));
    params.set("access_token", token);
    return jsonFetch(`https://graph.facebook.com/${META_VERSION}/${p}?${params}`);
  }
  // Graph API 쓰기는 form 필드. 객체/배열 값은 JSON 문자열로 보낸다 (targeting, creative 등).
  const fields = new URLSearchParams({ access_token: token });
  if (body && typeof body === "object") for (const [k, v] of Object.entries(body as any)) fields.set(k, typeof v === "string" ? v : JSON.stringify(v));
  return jsonFetch(`https://graph.facebook.com/${META_VERSION}/${clean}${method === "DELETE" ? `?access_token=${token}` : ""}`, method === "DELETE" ? { method: "DELETE" } : { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: fields });
}

export async function executeMediaStep(step: MediaStep) {
  const path = step.path.startsWith("/") ? step.path : `/${step.path}`;
  if (step.channel === "naver_sa") return naverRequest(step.method, path, step.method === "GET" ? undefined : step.body, cleanId(step.accountId));
  if (step.channel === "naver_gfa") return gfaRequest(step.method, path, step.body);
  if (step.channel === "google_ads") return googleRaw(step.method, path, step.body);
  return metaRaw(step.method, path, step.body);
}

/** "{{0.id}}" 처럼 앞 단계 결과를 참조하는 값을 채운다. */
function fillRefs(value: unknown, results: unknown[]): unknown {
  if (typeof value === "string") return value.replace(/\{\{(\d+)\.([\w.\[\]]+)\}\}/g, (_, i, field) => {
    let cur: any = results[Number(i)];
    for (const part of field.replace(/\[(\d+)\]/g, ".$1").split(".")) cur = cur?.[part];
    if (cur === undefined || cur === null) throw new Error(`앞 단계 결과에서 {{${i}.${field}}} 값을 찾지 못했습니다.`);
    return String(cur);
  });
  if (Array.isArray(value)) return value.map((v) => fillRefs(v, results));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillRefs(v, results)]));
  return value;
}

/** 승인된 단계들을 순서대로 실행. 실패하면 거기서 멈추고 지금까지 결과를 돌려준다. */
export async function executeMediaPlan(steps: MediaStep[], allowedKeys: string[]) {
  const results: unknown[] = [];
  for (let i = 0; i < steps.length; i++) {
    try {
      const step = fillRefs(steps[i], results) as MediaStep;
      await assertMediaScope(step, allowedKeys);
      results.push(await executeMediaStep(step));
    } catch (error) {
      return { success: false, completed: i, failedStep: i, error: error instanceof Error ? error.message : String(error), results };
    }
  }
  return { success: true, completed: steps.length, results };
}

// ---- 월별 적재 (연초~전월, 캠페인 단위) ----
export type MonthlyRow = { channel: Channel; accountId: string; month: string; campaignId: string; campaignName: string; product: string; imp: number; clk: number; cost: number; conv: number; revenue: number };
const monthBounds = (month: string) => { const [y, m] = month.split("-").map(Number); return { since: `${month}-01`, until: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }; };

/** 한 계정의 여러 달 캠페인 성과. Google·Meta는 한 번에, GFA·SA는 달마다 조회한다. */
export async function fetchMonthly(channel: Channel, accountId: string, months: string[]): Promise<MonthlyRow[]> {
  if (!months.length) return [];
  const since = monthBounds(months[0]).since, until = monthBounds(months[months.length - 1]).until;
  const base = { channel, accountId };
  if (channel === "google_ads") {
    const rows = await googleSearch(accountId, `SELECT segments.month, campaign.id, campaign.name, campaign.advertising_channel_type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}' AND metrics.impressions > 0`);
    return rows.map((r: any) => ({ ...base, month: String(r.segments.month).slice(0, 7), campaignId: String(r.campaign.id), campaignName: r.campaign.name, product: productOf(r.campaign.advertisingChannelType) || "", imp: num(r.metrics.impressions), clk: num(r.metrics.clicks), cost: num(r.metrics.costMicros) / 1e6, conv: num(r.metrics.conversions), revenue: num(r.metrics.conversionsValue) }));
  }
  if (channel === "meta") {
    const rows = await metaInsightsSafe(`act_${accountId}/insights`, { level: "campaign", time_increment: "monthly", time_range: JSON.stringify({ since, until }), fields: `campaign_id,campaign_name,objective,spend,impressions,clicks,actions,action_values,${META_CATALOG_FIELDS}` });
    return rows.map((r: any) => ({ ...base, month: String(r.date_start).slice(0, 7), campaignId: String(r.campaign_id), campaignName: r.campaign_name, product: productOf(r.objective) || "", imp: num(r.impressions), clk: num(r.clicks), cost: num(r.spend), conv: metaConv(r), revenue: metaRev(r) }));
  }
  const out: MonthlyRow[] = [];
  if (channel === "naver_gfa") {
    const campaigns: any[] = [];
    for (let page = 0; page < 50; page++) { const items = gfaList(await gfaGet(`/adAccounts/${accountId}/campaigns`, { page: String(page), size: "100" })); campaigns.push(...items); if (items.length < 100) break; }
    const info = new Map(campaigns.map((c) => [String(c.no), c]));
    for (const month of months) {
      const range = { startDate: monthBounds(month).since, endDate: monthBounds(month).until, timeUnit: "monthly" };
      const fetchRows = (path: string) => gfaPaged(`/adAccounts/${accountId}${path}`, range).catch(() => gfaPaged(`/adAccounts/${accountId}${path}`, { ...range, timeUnit: "daily" }));
      const [sets, setConv, camps, campConv] = await Promise.all(["/performance/past/adSets", "/performance/conversion/past/adSets", "/performance/past/campaigns", "/performance/conversion/past/campaigns"].map((p) => fetchRows(p).catch(() => [] as any[])));
      const inSets = new Set([...sets, ...setConv].map((r) => String(r.campaignNo ?? "")));
      const agg = new Map<string, MonthlyRow>();
      const row = (no: string) => { if (!agg.has(no)) { const c = info.get(no); agg.set(no, { ...base, month, campaignId: no, campaignName: c?.name || `캠페인 ${no}`, product: productOf(c?.objective) || "", imp: 0, clk: 0, cost: 0, conv: 0, revenue: 0 }); } return agg.get(no)!; };
      const perf = (r: any) => { const x = row(String(r.campaignNo ?? "")); x.imp += num(r.impCount); x.clk += num(r.clickCount); x.cost += num(r.sales); };
      const conv = (r: any) => { if (r.convType === "PURCHASE") { const x = row(String(r.campaignNo ?? "")); x.conv += num(r.convCount); x.revenue += num(r.convSales); } };
      sets.forEach(perf); camps.filter((r) => !inSets.has(String(r.campaignNo ?? ""))).forEach(perf);
      setConv.forEach(conv); campConv.filter((r) => !inSets.has(String(r.campaignNo ?? ""))).forEach(conv);
      out.push(...[...agg.values()].filter((r) => r.imp || r.cost));
    }
    return out;
  }
  // naver_sa: 캠페인 합계를 달마다 (전환매출은 SA 통계 기준 전체 전환)
  const campaigns = await naverRequest("GET", "/ncc/campaigns", undefined, accountId) as any[];
  const info = new Map(campaigns.map((c) => [c.nccCampaignId, c]));
  for (const month of months) {
    const stats = await naverStats(accountId, campaigns.map((c) => c.nccCampaignId), monthBounds(month).since, monthBounds(month).until, false);
    for (const s of stats) {
      if (!num(s.impCnt) && !num(s.salesAmt)) continue;
      const c = info.get(s.id);
      out.push({ ...base, month, campaignId: s.id, campaignName: c?.name || s.id, product: productOf(c?.campaignTp) || "", imp: num(s.impCnt), clk: num(s.clkCnt), cost: num(s.salesAmt), conv: num(s.ccnt), revenue: num(s.convAmt) });
    }
  }
  return out;
}

// 광고상품 이름 (채널별 캠페인 유형/목표)
export const PRODUCT_LABEL: Record<string, string> = {
  WEB_SITE: "파워링크", SHOPPING: "쇼핑검색", BRAND_SEARCH: "브랜드검색", POWER_CONTENTS: "파워콘텐츠", PLACE: "플레이스",
  SEARCH: "검색", PERFORMANCE_MAX: "PMax", DISPLAY: "디스플레이", VIDEO: "동영상(유튜브)", DEMAND_GEN: "디맨드젠", MULTI_CHANNEL: "앱", SMART: "스마트",
  OUTCOME_SALES: "판매", OUTCOME_LEADS: "잠재고객", OUTCOME_TRAFFIC: "트래픽", OUTCOME_AWARENESS: "인지도", OUTCOME_ENGAGEMENT: "참여", OUTCOME_APP_PROMOTION: "앱 홍보",
  CONVERSIONS: "전환", LINK_CLICKS: "트래픽", REACH: "도달", BRAND_AWARENESS: "인지도", VIDEO_VIEWS: "동영상 조회", PRODUCT_CATALOG_SALES: "카탈로그 판매",
  CONVERSION: "전환", CATALOG: "카탈로그", WEB_SITE_TRAFFIC: "웹사이트 트래픽", INSTALL_APP: "앱 설치", VIDEO_VIEW: "동영상 조회", AWARENESS: "인지도", SHOPPING_PROMOTION: "쇼핑 프로모션", ADVOOST_SHOPPING: "애드부스트 쇼핑", LEAD: "참여·잠재고객",
};
function productOf(value?: string) { return value ? (PRODUCT_LABEL[value] || value) : undefined; }

/** 네이버 SA 비즈머니 잔액 (10분 캐시). GFA는 잔액 조회 API가 없다. */
export async function getBizmoney(customerIds: string[]) {
  return Promise.all(customerIds.map(async (id) => {
    const key = `bizmoney:${id}`;
    const cached = await cacheGet<{ bizmoney: number; budgetLock: boolean }>(key);
    if (cached) return { customerId: id, ...cached.value, at: new Date(cached.updatedAt).toISOString() };
    try {
      const body = await naverRequest("GET", "/billing/bizmoney", undefined, id);
      const value = { bizmoney: Math.round(num(body.bizmoney)), budgetLock: Boolean(body.budgetLock) };
      await cacheSet(key, value, Date.now() + 10 * 60_000);
      return { customerId: id, ...value, at: new Date().toISOString() };
    } catch (error) {
      return { customerId: id, error: error instanceof Error ? error.message : String(error) };
    }
  }));
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

// GFA 광고세트·소재 목록 (계정 단위로 받아 30분 캐시 후 캠페인/광고세트로 거른다)
async function gfaPagedList(accountId: string, resource: "adSets" | "creatives", params: Record<string, string> = {}) {
  const key = `gfa-list:${accountId}:${resource}:${JSON.stringify(params)}`;
  const cached = await cacheGet<any[]>(key);
  if (cached) return cached.value;
  const rows: any[] = [];
  for (let page = 0; page < 30; page++) {
    const items = gfaList(await gfaGet(`/adAccounts/${accountId}/${resource}`, { ...params, page: String(page), size: "100" }));
    rows.push(...items);
    if (items.length < 100) break;
  }
  await cacheSet(key, rows, Date.now() + 30 * 60_000);
  return rows;
}

export const liveAdapter = {
  async listCampaigns(channel?: Channel, includeOff = false) {
    const rows = await allCampaigns(includeOff);
    return channel ? rows.filter((row) => row.channel === channel) : rows;
  },
  async listAdgroups(channel: Channel, campaignId: string): Promise<AdGroup[]> {
    const key = unpack(campaignId);
    if (channel === "naver_sa") {
      const rows = await naverRequest("GET", `/ncc/adgroups?nccCampaignId=${encodeURIComponent(key.id)}`, undefined, key.account);
      return rows.map((row: any) => ({ id: packed(channel, key.account, row.nccAdgroupId), campaignId, channel, name: row.name, dailyBudget: num(row.dailyBudget), status: row.userLock ? "off" : "on", active: !row.userLock && (!row.status || row.status === "ELIGIBLE") }));
    }
    if (channel === "meta") {
      const body = await metaGet(`${key.id}/adsets`, { fields: "id,name,status,effective_status,end_time,daily_budget", limit: "500" });
      return body.data.map((row: any) => ({ id: packed(channel, key.account, row.id), campaignId, channel, name: row.name, dailyBudget: num(row.daily_budget) / 100, status: asStatus(row.status),
        active: row.effective_status === "ACTIVE" && (!row.end_time || new Date(row.end_time).getTime() > Date.now()) }));
    }
    if (channel === "google_ads") {
      const rows = await googleSearch(key.account, `SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE campaign.id = ${key.id} AND ad_group.status != 'REMOVED'`);
      return rows.map((row: any) => ({ id: packed(channel, key.account, String(row.adGroup.id)), campaignId, channel, name: row.adGroup.name, dailyBudget: 0, status: asStatus(row.adGroup.status) }));
    }
    if (channel === "naver_gfa") {
      const rows = (await gfaPagedList(key.account, "adSets", { campaignNo: key.id })).filter((row) => String(row.campaignNo ?? row.campaign?.no ?? key.id) === key.id);
      return rows.map((row: any) => ({ id: packed(channel, key.account, String(row.no)), campaignId, channel, name: row.name, dailyBudget: num(row.budget?.dailyBudget ?? row.dailyBudget ?? row.budgetAmount),
        status: (row.activated === false ? "off" : "on") as EntityStatus, active: row.activated !== false && !row.deleted && !/COMPLETED|FINISHED|ENDED/.test(String(row.status || "")) }));
    }
    throw new Error("지원하지 않는 채널입니다.");
  },
  async listAds(channel: Channel, adgroupId: string): Promise<Ad[]> {
    const key = unpack(adgroupId);
    if (channel === "naver_sa") {
      const rows = await naverRequest("GET", `/ncc/ads?nccAdgroupId=${encodeURIComponent(key.id)}`, undefined, key.account);
      return rows.map((row: any) => ({ id: packed(channel, key.account, row.nccAdId), adgroupId, channel,
        name: row.referenceData?.productName || row.ad?.headline || row.subject || row.description || row.nccAdId, status: row.userLock ? "off" : "on",
        imageUrl: row.referenceData?.imageUrl, active: !row.userLock && row.status !== "PAUSED" }));
    }
    if (channel === "meta") {
      const body = await metaGet(`${key.id}/ads`, { fields: "id,name,status,effective_status,creative.thumbnail_width(120).thumbnail_height(120){thumbnail_url,image_url}", limit: "500" });
      return body.data.map((row: any) => ({ id: packed(channel, key.account, row.id), adgroupId, channel, name: row.name, status: asStatus(row.status),
        imageUrl: row.creative?.thumbnail_url || row.creative?.image_url, active: row.effective_status === "ACTIVE" }));
    }
    if (channel === "google_ads") {
      const rows = await googleSearch(key.account, `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status FROM ad_group_ad WHERE ad_group.id = ${key.id} AND ad_group_ad.status != 'REMOVED'`);
      return rows.map((row: any) => ({ id: packed(channel, key.account, String(row.adGroupAd.ad.id)), adgroupId, channel, name: row.adGroupAd.ad.name || String(row.adGroupAd.ad.id), status: asStatus(row.adGroupAd.status) }));
    }
    if (channel === "naver_gfa") {
      const rows = (await gfaPagedList(key.account, "creatives", { adSetNo: key.id })).filter((row) => String(row.adSetNo) === key.id);
      return rows.map((row: any) => { const media = row.image || row.medias?.[0] || {}; return { id: packed(channel, key.account, String(row.no)), adgroupId, channel, name: row.name || `소재 ${row.no}`,
        status: (row.activated === false ? "off" : "on") as EntityStatus, imageUrl: media.imageUrl || media.url, active: row.activated !== false }; });
    }
    throw new Error("지원하지 않는 채널입니다.");
  },
  async getStats(channel?: Channel, _level = "campaign", ids?: string[]): Promise<StatsRow[]> {
    const rows = (await allCampaigns(true)).filter((row) => (!channel || row.channel === channel) && (!ids?.length || ids.includes(row.id)));
    return rows.map((row) => ({ id: row.id, name: row.name, channel: row.channel, spend: row.spend, impressions: 0, clicks: 0, conversions: row.conversions, revenue: row.spend * row.roas / 100, ctr: 0, cpc: 0, roas: row.roas }));
  },
  async resolveEntity(channel: Channel, entityType: EntityType, id: string) {
    if (entityType === "campaign") return entityFromCampaign(id);
    const key = unpack(id);
    if (entityType === "adgroup" && channel === "naver_gfa") {
      // GFA 광고세트는 ID로 바로 조회한다(캠페인 전체를 돌면 느리다)
      const row = await gfaGet(`/adAccounts/${key.account}/adSets/${key.id}`).then((b) => b?.data && !Array.isArray(b.data) ? b.data : b).catch(() => null);
      if (row && (row.no || row.name)) return { id, campaignId: packed(channel, key.account, String(row.campaignNo ?? row.campaign?.no ?? "")), channel, name: row.name || `광고세트 ${key.id}`,
        dailyBudget: num(row.budget?.dailyBudget ?? row.dailyBudget ?? row.budgetAmount), status: (row.activated === false ? "off" : "on") as EntityStatus };
    }
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
    if (operation.kind === "media_plan") return executeMediaPlan(operation.steps as MediaStep[], operation.accountKeys);
    if (operation.channel === "naver_gfa") {
      const key = unpack(operation.id);
      if (operation.kind === "update_budget" && operation.entityType === "ad") throw new Error("GFA 소재에는 예산이 없습니다.");
      await gfaUpdate(key.account, GFA_RESOURCE[operation.entityType], key.id, (row) => {
        if (operation.kind === "set_status") { row.activated = operation.status === "on"; return row; }
        const value = Math.round(operation.dailyBudget);
        if (row.budget && typeof row.budget === "object") { row.budget.dailyBudget = value; if ("budgetAmount" in row.budget) row.budget.budgetAmount = value; }
        else if ("budgetAmount" in row && !("dailyBudget" in row)) row.budgetAmount = value;
        else row.dailyBudget = value;
        return row;
      });
      return { success: true, changed: 1 };
    }
    if (operation.kind === "create_text_ad") throw new Error("네이버 SA 소재 생성은 트래킹 템플릿 검증 후 지원됩니다.");
    const key = unpack(operation.id);
    if (operation.channel === "naver_sa") {
      // 네이버 SA 수정은 ?fields=로 바꿀 항목을 지정하고, 본문에 대상 ID를 함께 넣어야 한다
      const idField = operation.entityType === "campaign" ? "nccCampaignId" : operation.entityType === "adgroup" ? "nccAdgroupId" : "nccAdId";
      const endpoint = operation.entityType === "campaign" ? `/ncc/campaigns/${key.id}` : operation.entityType === "adgroup" ? `/ncc/adgroups/${key.id}` : `/ncc/ads/${key.id}`;
      if (operation.kind === "set_status") await naverRequest("PUT", `${endpoint}?fields=userLock`, { [idField]: key.id, userLock: operation.status === "off" }, key.account);
      else {
        if (operation.entityType === "ad") throw new Error("네이버 SA 소재에는 예산이 없습니다.");
        await naverRequest("PUT", `${endpoint}?fields=budget`, { [idField]: key.id, dailyBudget: operation.dailyBudget, useDailyBudget: true }, key.account);
      }
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
