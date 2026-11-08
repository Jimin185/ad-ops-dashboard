import crypto from "node:crypto";
import { cacheGet, cacheGetStale, cacheSet, isFinalDate, nextDailyRefresh } from "@/lib/cache";
import { kvGet, storageAvailable } from "@/lib/db";
import { META_KPI_ACTIONS } from "@/lib/kpi";
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
    let message = detail?.message || detail?.errorCode && JSON.stringify(detail.errorCode) || body?.error?.message || body?.message || body?.title || body?.detail || `${response.status} ${response.statusText}`;
    // Meta는 사람이 읽을 사유를 별도 필드에 담아 준다 (예: 최소 예산 미달, 권한 부족). 있으면 붙인다.
    const userMsg = [body?.error?.error_user_title, body?.error?.error_user_msg].filter(Boolean).join(" — ");
    if (userMsg && !String(message).includes(userMsg)) message = `${message} · ${userMsg}`;
    const code = body?.code ?? body?.error?.code;
    const sub = body?.error?.error_subcode ? `, subcode ${body.error.error_subcode}` : "";
    if (code !== undefined && !String(message).includes(String(code))) throw new Error(`${message} (code ${code}${sub}, HTTP ${response.status})`);
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
    const contracts = await brandContracts();
    // 브랜드검색/신제품검색 정액 계약을 API에서 받아 일할 계산한다 (수기 입력이 있으면 그게 우선).
    // 계약은 광고그룹 단위라, 브랜드검색 캠페인의 광고그룹 ID로 합산한다.
    const autoSpend = new Map<string, number>();
    const brandRows = rows.filter((row) => (productOf(row.campaignTp) || "").includes("브랜드") && !contracts[packed("naver_sa", account.id, row.nccCampaignId)]);
    if (brandRows.length) {
      try {
        // 신형(신제품검색)은 /brand-new/contracts, 구형 브랜드검색 정액은 /time-contracts — 필드명은 동일하다.
        const fetchContracts = (path: string) => naverRequest("GET", path, undefined, account.id).then((r) => (r as any[]) || []).catch(() => [] as any[]);
        const all = (await Promise.all([fetchContracts("/ncc/brand-new/contracts"), fetchContracts("/ncc/time-contracts")])).flat();
        const live = all.filter((c) => !c.cancelTm && !/CANCELED|DEFEATED|FAILED/.test(String(c.biddingStatus || c.contractStatus || "")));
        const byAdgroup = new Map<string, any[]>();
        for (const c of live) { const k = String(c.nccAdgroupId || ""); if (!byAdgroup.has(k)) byAdgroup.set(k, []); byAdgroup.get(k)!.push(c); }
        if (byAdgroup.size) {
          await Promise.all(brandRows.map(async (row) => {
            const ags = (await naverRequest("GET", `/ncc/adgroups?nccCampaignId=${encodeURIComponent(row.nccCampaignId)}`, undefined, account.id).catch(() => [])) as any[];
            const sum = ags.flatMap((g) => byAdgroup.get(String(g.nccAdgroupId)) || []).reduce((s, c) => {
              const amount = num(c.paymentAmt) || num(c.contractAmt);
              const from = String(c.exposureStartDt || c.contractStartDt || "").slice(0, 10), to = String(c.exposureEndDt || c.contractEndDt || "").slice(0, 10);
              return from && to ? s + brandProratedSpend({ amount, since: from, until: to }, since, until) : s;
            }, 0);
            if (sum > 0) autoSpend.set(row.nccCampaignId, sum);
          }));
        }
      } catch { /* 계약 API가 없는 계정은 수기 입력으로 */ }
    }
    return rows.map((row) => {
      const s = stats.get(row.nccCampaignId) || {};
      const id = packed("naver_sa", account.id, row.nccCampaignId);
      // 브랜드검색 정액 계약: 수기 입력 > API 계약 일할 > 리포트 소진 (정액제는 리포트 소진이 0으로 잡힘)
      const contract = contracts[id];
      const spend = contract ? brandProratedSpend(contract, since, until) : autoSpend.get(row.nccCampaignId) ?? num(s.salesAmt);
      return { id, channel: "naver_sa" as const, name: row.name,
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
// Meta 예산 필드(daily_budget)는 통화의 최소 단위다. USD 같은 통화는 센트(÷100)지만
// KRW·JPY 같은 소수점 없는 통화는 원 단위 그대로다(÷1). 계정 통화를 확인해 맞춘다.
const META_ZERO_DECIMAL = new Set(["KRW", "JPY", "CLP", "COP", "CRC", "HUF", "ISK", "IDR", "PYG", "TWD", "VND"]);
const metaOffsetMemo = new Map<string, number>();
async function metaBudgetOffset(accountId: string): Promise<number> {
  const id = String(accountId).replace(/^act_/, "");
  if (metaOffsetMemo.has(id)) return metaOffsetMemo.get(id)!;
  const cached = await cacheGet<string>(`meta-currency:${id}`);
  let currency = cached?.value;
  if (!currency) {
    currency = String((await metaGet(`act_${id}`, { fields: "currency" }).catch(() => ({})) as any).currency || "KRW");
    await cacheSet(`meta-currency:${id}`, currency, Date.now() + 30 * 86400_000);
  }
  const offset = META_ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100;
  metaOffsetMemo.set(id, offset);
  return offset;
}
async function metaCampaigns(includeOff: boolean): Promise<Campaign[]> {
  const accounts = await metaAccounts();
  const { since, until } = monthRange();
  return settleAccounts(accounts, async (account) => {
    const offset = await metaBudgetOffset(account.id);
    const kpiTypes = await metaKpiTypes(account.id);
    const body = await metaGet(`act_${account.id}/campaigns`, {
      fields: `id,name,status,effective_status,stop_time,objective,daily_budget,lifetime_budget,budget_remaining,insights.time_range({"since":"${since}","until":"${until}"}){spend,actions,action_values,catalog_segment_actions,catalog_segment_value}`,
      limit: "500",
    });
    return (body.data || []).filter((row: any) => includeOff || row.status === "ACTIVE").map((row: any) => {
      const insight = row.insights?.data?.[0] || {};
      const purchase = { value: metaConv(insight, kpiTypes) };
      const revenue = { value: metaRev(insight, kpiTypes) };
      const spend = num(insight.spend);
      return { id: packed("meta", account.id, row.id), channel: "meta" as const, name: row.name, dailyBudget: num(row.daily_budget) / offset,
        ...(num(row.lifetime_budget) ? { lifetimeBudget: num(row.lifetime_budget) / offset, budgetRemaining: num(row.budget_remaining) / offset } : {}),
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

const EU_NO = "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING";
/**
 * 구글은 EU 정치광고 선언이 비어 있는 캠페인이 하나라도 있으면 계정의 수정 API를 전부 막는다.
 * 선언 필드만 바꾸는 mutate는 예외로 허용되므로, 계정 선언이 '없음'일 때 그 값을 미선언 캠페인에 전파한다.
 * (계정 선언이 확인되지 않으면 임의로 채우지 않고 안내만 한다.)
 */
async function googleFillEuDeclarations(account: string) {
  const [cust] = await googleSearch(account, "SELECT customer.contains_eu_political_advertising FROM customer");
  if (cust?.customer?.containsEuPoliticalAdvertising !== EU_NO) {
    throw new Error("구글애즈 계정의 EU 정치광고 선언이 확인되지 않아요. 구글애즈 관리자 → EU 정치 광고에서 '게재 안 함'으로 선언(제출)한 뒤 다시 시도해 주세요.");
  }
  const rows = await googleSearch(account, "SELECT campaign.id, campaign.contains_eu_political_advertising FROM campaign WHERE campaign.status != 'REMOVED'");
  const missing = rows.filter((r: any) => (r.campaign?.containsEuPoliticalAdvertising || "UNSPECIFIED") === "UNSPECIFIED").map((r: any) => String(r.campaign.id));
  for (let i = 0; i < missing.length; i += 500) {
    await googleRequest(`customers/${account}/campaigns:mutate`, { operations: missing.slice(i, i + 500).map((cid: string) => (
      { update: { resourceName: `customers/${account}/campaigns/${cid}`, containsEuPoliticalAdvertising: EU_NO }, updateMask: "containsEuPoliticalAdvertising" })) });
  }
  return missing.length;
}
/** EU 선언 미비로 거절된 mutate를, 계정 선언을 캠페인에 전파한 뒤 한 번 더 시도한다 */
async function googleMutateWithEuRetry<T>(account: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/EU political advertising/i.test(message)) throw error;
    const filled = await googleFillEuDeclarations(account);
    console.error(`구글 EU 정치광고 선언을 캠페인 ${filled}개에 전파하고 재시도합니다 (계정 ${account})`);
    return run();
  }
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
// 동시에 여러 요청이 토큰을 갱신하면 네이버가 일부를 실패시킨다(internal server error) → 갱신은 한 번만 하고 나머지는 기다린다.
let gfaTokenPending: Promise<string> | null = null;
async function gfaToken(force = false): Promise<string> {
  if (!force && gfaTokenCache && gfaTokenCache.expiresAt > Date.now() + 60_000) return gfaTokenCache.token;
  if (gfaTokenPending) return gfaTokenPending;
  gfaTokenPending = gfaTokenRefresh().finally(() => { gfaTokenPending = null; });
  return gfaTokenPending;
}
async function gfaTokenRefresh() {
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
  // 계정이 많아 요청이 몰리면 429·5xx 가 난다 → 잠깐 쉬고 두 번까지 다시 시도
  for (let retry = 0; retry < 2 && (response.status === 429 || response.status >= 500); retry++) {
    await new Promise((r) => setTimeout(r, 800 * (retry + 1) + Math.random() * 400));
    response = await call(await gfaToken());
  }
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
// 동시에 몇 개씩만 돌린다(모든 계정을 한꺼번에 부르면 네이버가 일부를 실패시켜 계정이 통째로 빠졌다).
async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { status: "fulfilled", value: await run(items[i]) }; } catch (reason) { out[i] = { status: "rejected", reason }; }
    }
  }));
  return out;
}
async function gfaCampaigns(includeOff: boolean): Promise<Campaign[]> {
  const accounts = await gfaAccounts();
  const month = new Date().toISOString().slice(0, 7);
  const results = await mapLimit(accounts, 4, async (account) => {
    const key = `gfa-campaigns:v1:${month}:${account.id}`;
    try {
      const rows = await gfaAccountCampaigns(account, includeOff);
      await cacheSet(key, rows, Date.now() + 40 * 24 * 3600_000).catch(() => undefined);
      return rows;
    } catch (error) {
      // 이번에 실패한 계정은 마지막으로 성공한 값으로 채운다(계정이 화면에서 사라지지 않게)
      const last = await cacheGetStale<Campaign[]>(key, 40 * 24 * 3600_000).catch(() => null);
      console.error(`GFA ${account.id} 조회 실패${last ? " (이전 값 사용)" : ""}:`, error instanceof Error ? error.message : error);
      if (last) return last.value;
      return gfaAccountCampaigns(account, includeOff, false); // 성과 없이라도 캠페인 목록은 보여준다
    }
  });
  const ok = results.filter((r): r is PromiseFulfilledResult<Campaign[]> => r.status === "fulfilled");
  if (accounts.length && !ok.length) { const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult; throw first.reason; }
  return ok.flatMap((r) => r.value);
}
async function gfaAccountCampaigns(account: AdAccount, includeOff: boolean, strict = true): Promise<Campaign[]> {
  const range = gfaPastRange();
  {
    const base = `/adAccounts/${account.id}`;
    const campaigns: any[] = [];
    for (let page = 0; page < 50; page++) {
      const items = gfaList(await gfaGet(`${base}/campaigns`, { page: String(page), size: "100" }));
      campaigns.push(...items);
      if (items.length < 100) break;
    }
    // 일반 캠페인은 애드셋 단위, 애드부스트는 캠페인 단위로 성과가 나오므로 시트 스크립트와 같은 방식으로 합산한다.
    const fetchRows = (path: string) => range ? gfaPaged(`${base}${path}`, range).catch((e) => { if (strict) throw e; return [] as any[]; }) : Promise.resolve([] as any[]);
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
    const wantedConv = await gfaKpiType(account.id);
    const addConv = (row: any) => { if (gfaConvHit(row, wantedConv)) { const b = bucket(row.campaignNo); b.conversions += num(row.convCount); b.revenue += num(row.convSales); } };
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
  }
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
// ---- 계정별 전환 기준(KPI): adops_cache 의 kpi_prefs ("채널:계정" → metric). 60초 메모리 캐시 ----
let kpiMemo: { at: number; map: Record<string, string> } | null = null;
async function kpiPrefs(): Promise<Record<string, string>> {
  if (kpiMemo && Date.now() - kpiMemo.at < 60_000) return kpiMemo.map;
  let map: Record<string, string> = {};
  try { if (storageAvailable()) map = (await kvGet<Record<string, string>>("kpi_prefs")) || {}; } catch { /* 저장소 없으면 기본값 */ }
  kpiMemo = { at: Date.now(), map };
  return map;
}
export async function kpiMetricOf(channel: Channel, accountId: string) { return (await kpiPrefs())[`${channel}:${accountId}`]; }

// ---- 브랜드검색 정액 계약 일할 계산: adops_cache 의 brandsearch_contracts (캠페인 packed id → {amount, since, until}) ----
export type BrandContract = { amount: number; since: string; until: string };
let brandMemo: { at: number; map: Record<string, BrandContract> } | null = null;
async function brandContracts(): Promise<Record<string, BrandContract>> {
  if (brandMemo && Date.now() - brandMemo.at < 60_000) return brandMemo.map;
  let map: Record<string, BrandContract> = {};
  try { if (storageAvailable()) map = (await kvGet<Record<string, BrandContract>>("brandsearch_contracts")) || {}; } catch { /* 기본값 */ }
  brandMemo = { at: Date.now(), map };
  return map;
}
/** 계약금액을 계약일수로 나눠, 이번 달 안에서 오늘까지 경과한 계약일만큼 소진으로 친다 */
function brandProratedSpend(contract: BrandContract, monthSince: string, today: string) {
  const day = (s: string) => Math.floor(new Date(`${s}T00:00:00+09:00`).getTime() / 86400_000);
  const contractDays = day(contract.until) - day(contract.since) + 1;
  if (!(contract.amount > 0) || contractDays <= 0) return 0;
  const from = Math.max(day(contract.since), day(monthSince));
  const to = Math.min(day(contract.until), day(today));
  const elapsed = Math.max(0, to - from + 1);
  return Math.round(contract.amount / contractDays * elapsed);
}
const metaKpiTypes = async (accountId: string) => META_KPI_ACTIONS[(await kpiPrefs())[`meta:${accountId}`] || "purchase"] || META_KPI_ACTIONS.purchase;
const gfaKpiType = async (accountId: string) => (await kpiPrefs())[`naver_gfa:${accountId}`] || "PURCHASE";
const gfaConvHit = (row: any, wanted: string) => wanted === "ALL" || row.convType === wanted;

const metaConv = (row: any, types: string[] = META_KPI_ACTIONS.purchase) => metaPick(row?.actions, types) + metaPick(row?.catalog_segment_actions, types);
const metaRev = (row: any, types: string[] = META_KPI_ACTIONS.purchase) => metaPick(row?.action_values, types) + metaPick(row?.catalog_segment_value, types);
/** catalog_segment 필드를 못 받는 계정이면 빼고 다시 요청한다. */
async function metaInsightsSafe(path: string, params: Record<string, string>) {
  try { return await metaPaged(path, params); }
  catch (error) {
    if (!/catalog_segment/i.test(String(error)) && !/Invalid parameter|nonexisting field/i.test(String(error))) throw error;
    return metaPaged(path, { ...params, fields: params.fields.replace(/,?catalog_segment_(actions|value)/g, "") });
  }
}
const metaPick = (list: any[] | undefined, types: string[] = META_PURCHASE) => {
  const items = list || [];
  for (const type of types) { const hit = items.find((x: any) => x.action_type === type); if (hit) return num(hit.value); }
  return 0;
};
async function metaDaily(accountId: string, since: string, until: string): Promise<DailyRow[]> {
  const kpiTypes = await metaKpiTypes(accountId);
  const rows = await metaInsightsSafe(`act_${accountId}/insights`, { level: "account", time_increment: "1", time_range: JSON.stringify({ since, until }), fields: `spend,impressions,clicks,actions,action_values,${META_CATALOG_FIELDS}` });
  return rows.map((row: any) => ({ date: row.date_start, channel: "meta" as const, accountId, spend: num(row.spend), revenue: metaRev(row, kpiTypes),
    conversions: metaConv(row, kpiTypes), impressions: num(row.impressions), clicks: num(row.clicks) }));
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
  const wantedConv = await gfaKpiType(accountId);
  const addConv = (row: any) => { if (gfaConvHit(row, wantedConv)) { const d = day(row.targetDate); d.conversions += num(row.convCount); d.revenue += num(row.convSales); } };
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
  const kpiTypes = await metaKpiTypes(accountId);
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
    Object.assign(details, await metaGet("", { ids, fields: "effective_status,creative.thumbnail_width(400).thumbnail_height(400){thumbnail_url,image_url,title,body,object_story_spec,product_set_id}" }));
  }
  const mapped = top.map((row: any) => {
    const creative = details[row.ad_id]?.creative || {};
    const link = creative.object_story_spec?.link_data || creative.object_story_spec?.video_data || {};
    return { id: row.ad_id, channel: "meta" as const, accountId, campaignId: packed("meta", accountId, String(row.campaign_id)), name: row.ad_name, campaignName: row.campaign_name, groupName: row.adset_name,
      imageUrl: creative.image_url || link.picture || link.image_url || creative.thumbnail_url, landingUrl: link.link || link.call_to_action?.value?.link,
      headline: creative.title || link.name || link.title, body: creative.body || link.message,
      status: details[row.ad_id]?.effective_status, spend: num(row.spend), impressions: num(row.impressions), clicks: num(row.clicks),
      conversions: metaConv(row, kpiTypes), revenue: metaRev(row, kpiTypes) };
  });
  // 인스턴트 경험 소재는 링크가 캔버스 문서라, 캔버스 안 버튼(없으면 CPAS 카탈로그 상품)의 실제 랜딩으로 바꿔 준다
  return resolveCanvasLandings(mapped, (r) => {
    const creative = details[r.id]?.creative;
    return { productSetId: creative?.product_set_id, retailerIds: creative?.object_story_spec?.link_data?.retailer_item_ids };
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
  const stats = new Map<string, { spend: number; impressions: number; clicks: number; conversions: number; revenue: number; campaignNo: string; adSetNo: string }>();
  const stat = (row: any) => { const key = String(row.creativeNo ?? row.adNo ?? ""); if (!stats.has(key)) stats.set(key, { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, campaignNo: String(row.campaignNo ?? ""), adSetNo: String(row.adSetNo ?? "") }); return stats.get(key)!; };
  for (const row of perf) { const st = stat(row); st.spend += num(row.sales); st.impressions += num(row.impCount); st.clicks += num(row.clickCount); }
  const wantedConv = await gfaKpiType(accountId);
  for (const row of conv) if (gfaConvHit(row, wantedConv)) { const st = stat(row); st.conversions += num(row.convCount); st.revenue += num(row.convSales); }
  const top = [...stats.entries()].filter(([, v]) => v.spend > 0).sort((a, b) => b[1].spend - a[1].spend).slice(0, 60);
  // 이미지는 소재 상세 API에는 없고 소재 목록 API에만 있다. 전체 목록(수천 개)은 느리므로 상위 소재가 속한 광고세트별로만 목록을 받는다.
  const detailKey = `gfa-creative-detail:v2:${accountId}`;
  const details = (await cacheGet<Record<string, any>>(detailKey))?.value || {};
  const missing = top.filter(([id]) => !details[id]?.image);
  const sets = [...new Set(missing.map(([, v]) => v.adSetNo).filter(Boolean))];
  const started = Date.now();
  for (let i = 0; i < sets.length && Date.now() - started < 25_000; i += 5) {
    await Promise.all(sets.slice(i, i + 5).map(async (adSetNo) => {
      try {
        for (const c of await gfaPagedList(accountId, "creatives", { adSetNo })) {
          const media = c.medias?.[0] || c.media || c.images?.[0] || c.image || {};
          details[String(c.no ?? c.creativeNo ?? c.id)] = { name: c.name, image: media.url || media.imageUrl || c.imageUrl || c.thumbnailUrl || c.previewUrl, title: c.title || c.headline, body: c.description || c.body, activated: c.activated, status: c.status, landing: c.landingUrl || c.landing?.url || c.landing?.pcUrl || media.landingUrl };
        }
      } catch { /* 이 광고세트는 건너뜀 */ }
    }));
  }
  if (missing.length) await cacheSet(detailKey, details, Date.now() + 14 * 86400_000);
  return top.map(([id, st]) => {
    const c = details[id] || {};
    return { id, channel: "naver_gfa" as const, accountId, campaignId: st.campaignNo ? packed("naver_gfa", accountId, st.campaignNo) : undefined, name: c.name || `소재 ${id}`,
      imageUrl: c.image, landingUrl: c.landing, headline: c.title, body: c.body, status: c.activated === undefined ? c.status : (c.activated ? "ON" : "OFF"),
      spend: st.spend, impressions: st.impressions, clicks: st.clicks, conversions: st.conversions, revenue: st.revenue };
  });
}

/** 구글 디스플레이·디맨드젠 소재 성과 (이미지 에셋 URL 포함) */
async function googleCreatives(accountId: string, since: string, until: string): Promise<CreativeRow[]> {
  const SEL = "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value";
  const date = `segments.date BETWEEN '${since}' AND '${until}'`;
  const BASE = "campaign.id, campaign.name, ad_group.name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.final_urls";
  const [display, demandGen] = await Promise.all([
    googleSearch(accountId, `SELECT ${BASE}, ad_group_ad.ad.responsive_display_ad.marketing_images, ad_group_ad.ad.responsive_display_ad.square_marketing_images, ad_group_ad.ad.responsive_display_ad.long_headline, ad_group_ad.ad.responsive_display_ad.headlines, ad_group_ad.ad.responsive_display_ad.descriptions, ${SEL} FROM ad_group_ad WHERE ${date} AND campaign.advertising_channel_type = 'DISPLAY' AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT 60`).catch(() => []),
    googleSearch(accountId, `SELECT ${BASE}, ad_group_ad.ad.demand_gen_multi_asset_ad.marketing_images, ad_group_ad.ad.demand_gen_multi_asset_ad.square_marketing_images, ad_group_ad.ad.demand_gen_multi_asset_ad.headlines, ad_group_ad.ad.demand_gen_multi_asset_ad.descriptions, ${SEL} FROM ad_group_ad WHERE ${date} AND campaign.advertising_channel_type = 'DEMAND_GEN' AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT 60`).catch(() => []),
  ]);
  const rows = [...display, ...demandGen];
  // 이미지 에셋 → URL. marketing_images 는 asset 리소스 이름만 주므로 asset 조회로 URL을 푼다.
  const assetIds = [...new Set(rows.flatMap((r: any) => {
    const ad = r.adGroupAd?.ad || {};
    const imgs = [...(ad.responsiveDisplayAd?.squareMarketingImages || []), ...(ad.responsiveDisplayAd?.marketingImages || []),
      ...(ad.demandGenMultiAssetAd?.squareMarketingImages || []), ...(ad.demandGenMultiAssetAd?.marketingImages || [])];
    return imgs.map((img: any) => String(img.asset || "").split("/").pop()).filter(Boolean);
  }))].slice(0, 200) as string[];
  const urlByAsset = new Map<string, string>();
  for (let i = 0; i < assetIds.length; i += 100) {
    const assets = await googleSearch(accountId, `SELECT asset.id, asset.image_asset.full_size.url FROM asset WHERE asset.id IN (${assetIds.slice(i, i + 100).join(",")})`).catch(() => []);
    for (const a of assets) if (a.asset?.imageAsset?.fullSize?.url) urlByAsset.set(String(a.asset.id), a.asset.imageAsset.fullSize.url);
  }
  return rows.map((r: any) => {
    const ad = r.adGroupAd?.ad || {};
    const rda = ad.responsiveDisplayAd || ad.demandGenMultiAssetAd || {};
    const firstImg = [...(rda.squareMarketingImages || []), ...(rda.marketingImages || [])].map((img: any) => urlByAsset.get(String(img.asset || "").split("/").pop() || ""))
      .find(Boolean);
    const headline = rda.longHeadline?.text || rda.headlines?.[0]?.text || "";
    return { id: String(ad.id), channel: "google_ads" as const, accountId, campaignId: packed("google_ads", accountId, String(r.campaign.id)),
      name: ad.name || headline || `광고 ${ad.id}`, campaignName: r.campaign.name, groupName: r.adGroup?.name,
      imageUrl: firstImg, landingUrl: ad.finalUrls?.[0], headline, body: rda.descriptions?.[0]?.text || "", status: r.adGroupAd?.status,
      spend: num(r.metrics?.costMicros) / 1e6, impressions: num(r.metrics?.impressions), clicks: num(r.metrics?.clicks),
      conversions: num(r.metrics?.conversions), revenue: num(r.metrics?.conversionsValue) };
  });
}

/**
 * 인스턴트 경험(캔버스) 광고의 실제 랜딩. 소재 링크가 fb.com/canvas_doc/{id}면
 * 캔버스 본문(body_elements)을 열어 버튼이 가리키는 외부 URL을 찾아낸다 (14일 캐시).
 */
async function metaCanvasLanding(link?: string): Promise<string | undefined> {
  const m = String(link || "").match(/fb\.com\/canvas_doc\/(\d+)/);
  if (!m) return undefined;
  const key = `canvas-url:v2:${m[1]}`;
  const cached = await cacheGet<string>(key);
  if (cached) return cached.value || undefined;
  let url = "";
  try {
    // body_elements만 요청하면 요소 이름·타입만 와서 URL이 없다. 버튼(open_url)은 중첩 필드로 따로 받아야 한다.
    const body = await metaGet(m[1], { fields: "body_elements{name,element_type,open_url,child_elements{name,element_type,open_url}}" })
      .catch(() => metaGet(m[1], { fields: "body_elements" }));
    const text = JSON.stringify(body).replace(/\\\//g, "/");
    url = (text.match(/https?:\/\/[^"\\\s]+/g) || []).find((u) => !/facebook\.com|fb\.com|fbcdn|instagram\.com/.test(u)) || "";
    if (!url) console.error(`캔버스 ${m[1]} 에서 외부 랜딩을 못 찾음 (body_elements ${text.length}자)`);
  } catch (error) {
    console.error(`캔버스 ${m[1]} 조회 실패 — ${error instanceof Error ? error.message : String(error)}`);
    url = "";
  }
  // 성공은 14일, 실패는 1시간만 캐시해 권한 문제를 고치면 금방 다시 시도되게 한다
  await cacheSet(key, url, Date.now() + (url ? 14 * 86400_000 : 3600_000));
  return url || undefined;
}
/**
 * 협력광고(CPAS) 카탈로그 소재의 실제 랜딩: 캔버스 안에 외부 URL이 없어서,
 * 소재에 걸린 제품(retailer_item_ids)의 카탈로그 상품 URL을 찾아 쓴다 (제품세트 단위 14일 캐시).
 */
async function cpasProductLanding(productSetId?: string, retailerIds?: string[]): Promise<string | undefined> {
  const rids = (retailerIds || []).map(String).filter((r) => r && r !== "0");
  if (!productSetId || !rids.length) return undefined;
  const key = `pset-urls:v1:${productSetId}`;
  let map = (await cacheGet<Record<string, string>>(key))?.value;
  if (!map) {
    map = {};
    try {
      let params: Record<string, string> = { fields: "retailer_id,url", limit: "100" };
      for (let page = 0; page < 3; page++) {
        const body = await metaGet(`${productSetId}/products`, params);
        for (const p of body?.data || []) if (p.retailer_id && p.url) map[String(p.retailer_id)] = String(p.url);
        const after = body?.paging?.cursors?.after;
        if (!after || (body?.data || []).length < 100) break;
        params = { ...params, after };
      }
    } catch (error) {
      console.error(`제품세트 ${productSetId} 상품 조회 실패 — ${error instanceof Error ? error.message : String(error)}`);
    }
    await cacheSet(key, map, Date.now() + (Object.keys(map).length ? 14 * 86400_000 : 3600_000));
  }
  for (const rid of rids) if (map[rid]) return map[rid];
  return undefined;
}
/** CreativeRow/Ad 목록의 캔버스 링크를 실제 랜딩으로 바꿔 준다 (캔버스 버튼 → 없으면 CPAS 카탈로그 상품 URL) */
async function resolveCanvasLandings<T extends { landingUrl?: string }>(rows: T[], cpasOf?: (row: T) => { productSetId?: string; retailerIds?: string[] } | undefined): Promise<T[]> {
  const targets = [...new Set(rows.map((r) => r.landingUrl).filter((u) => u && /fb\.com\/canvas_doc\//.test(u)))] as string[];
  if (!targets.length) return rows;
  const resolved = new Map<string, string | undefined>();
  await Promise.all(targets.slice(0, 30).map(async (u) => resolved.set(u, await metaCanvasLanding(u))));
  return Promise.all(rows.map(async (r) => {
    if (!r.landingUrl || !/fb\.com\/canvas_doc\//.test(r.landingUrl)) return r;
    let url = resolved.get(r.landingUrl);
    if (!url && cpasOf) { const c = cpasOf(r); url = await cpasProductLanding(c?.productSetId, c?.retailerIds); }
    return url ? { ...r, landingUrl: url } : r;
  }));
}

// ---- 네이버 파워링크 소재 관리 (조회·교체·추가, 확장소재 조회) ----
export async function naverPowerlinkAds(customerId: string, adgroupId: string) {
  const rows = (await naverRequest("GET", `/ncc/ads?nccAdgroupId=${encodeURIComponent(adgroupId)}`, undefined, customerId)) as any[];
  return rows.filter((row) => row.type === "TEXT_45" || row.ad?.headline).map((row) => ({
    id: String(row.nccAdId), type: String(row.type || ""), headline: row.ad?.headline || "", description: row.ad?.description || "",
    pcUrl: row.ad?.pc?.final || "", mobileUrl: row.ad?.mobile?.final || "",
    inspect: String(row.inspectStatus || ""), on: !row.userLock, status: String(row.status || ""),
  }));
}
export async function naverAdExtensions(customerId: string, ownerId: string) {
  const rows = (await naverRequest("GET", `/ncc/ad-extensions?ownerId=${encodeURIComponent(ownerId)}`, undefined, customerId).catch(() => [])) as any[];
  return rows.map((row) => ({
    id: String(row.nccAdExtensionId), type: String(row.type || ""), on: !row.userLock,
    inspect: String(row.inspectStatus || ""), content: JSON.stringify(row.adExtension || {}).slice(0, 300),
  }));
}
/** B 방식 교체: (지정 시) 기존 소재를 먼저 지우고 새 TEXT_45 소재를 등록한다. 그룹당 5개 제한 때문. */
export async function naverReplaceAd(customerId: string, adgroupId: string, input: { deleteAdId?: string; headline: string; description: string; pcUrl: string; mobileUrl?: string }) {
  if (input.deleteAdId) await naverRequest("DELETE", `/ncc/ads/${encodeURIComponent(input.deleteAdId)}`, undefined, customerId);
  try {
    const created = await naverRequest("POST", "/ncc/ads", {
      nccAdgroupId: adgroupId, type: "TEXT_45",
      ad: { headline: input.headline, description: input.description, pc: { final: input.pcUrl }, mobile: { final: input.mobileUrl || input.pcUrl } },
    }, customerId);
    return { id: String(created?.nccAdId || ""), inspect: String(created?.inspectStatus || "") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${input.deleteAdId ? "기존 소재는 지워졌는데 " : ""}새 소재 등록이 거절됐어요: ${message}`);
  }
}

/**
 * Meta 소재 교체 (이미지·랜딩). 크리에이티브는 수정 불가 객체라, 기존 스펙을 복사해
 * 이미지 해시/링크만 바꾼 새 크리에이티브를 만들어 광고에 연결한다 (성과 지표는 광고 기준이라 유지됨).
 */
/** 소재 구조 진단용: 랜딩이 안 잡히는 광고(협력광고 등)의 크리에이티브 원본 필드를 읽는다. */
export async function metaCreativeProbe(adId: string) {
  return metaGet(adId, { fields: "name,effective_status,creative{id,name,object_type,object_story_spec,asset_feed_spec,template_url,template_url_spec,url_tags,product_set_id,effective_object_story_id,instagram_permalink_url}" });
}
/** 캔버스(인스턴트 경험) 문서 조회가 왜 실패하는지 원본 에러를 그대로 본다. */
export async function metaCanvasProbe(canvasId: string, fields?: string) {
  return metaGet(canvasId, { fields: fields && /^[\w{},.]+$/.test(fields) ? fields : "body_elements" });
}

export async function metaReplaceCreative(accountId: string, adId: string, change: { imageBase64?: string; link?: string }) {
  const ad = await metaGet(adId, { fields: "name,creative{id,name,object_story_spec,url_tags}" });
  const spec = ad?.creative?.object_story_spec;
  if (!spec) throw new Error("이 광고의 크리에이티브 구조를 읽지 못했어요 (카탈로그/다이내믹 소재는 아직 지원 전이에요).");
  const next = JSON.parse(JSON.stringify(spec));
  const link = next.link_data;
  const video = next.video_data;
  if (change.imageBase64) {
    if (!link) throw new Error("이미지 교체는 이미지(링크형) 소재만 지원해요. 영상 소재는 영상 교체라 별도예요.");
    const up = await metaPost(`act_${accountId}/adimages`, { bytes: change.imageBase64 });
    const hash = up?.images ? (Object.values(up.images)[0] as any)?.hash : undefined;
    if (!hash) throw new Error("이미지 업로드에 실패했어요.");
    delete link.picture;
    link.image_hash = hash;
    if (Array.isArray(link.child_attachments)) link.child_attachments = link.child_attachments.map((c: any) => ({ ...c, picture: undefined, image_hash: hash }));
  }
  if (change.link) {
    if (/fb\.com\/canvas_doc\//.test(String(link?.link || ""))) throw new Error("이 소재는 인스턴트 경험(캔버스)이라 실제 랜딩이 캔버스 안 버튼에 있어요. Meta 광고 관리자에서 캔버스를 수정해 주세요.");
    if (link) link.link = change.link;
    const cta = (link || video)?.call_to_action;
    if (cta?.value?.link) cta.value.link = change.link;
    if (!link && !cta) throw new Error("이 소재에서 랜딩 링크 자리를 찾지 못했어요.");
  }
  const created = await metaPost(`act_${accountId}/adcreatives`, {
    name: `${ad?.creative?.name || ad?.name || "creative"} · 수정 ${new Date().toISOString().slice(5, 10)}`,
    object_story_spec: JSON.stringify(next), ...(ad?.creative?.url_tags ? { url_tags: ad.creative.url_tags } : {}),
  });
  if (!created?.id) throw new Error("새 크리에이티브 생성에 실패했어요.");
  await metaPost(adId, { creative: JSON.stringify({ creative_id: created.id }) });
  return { creativeId: String(created.id) };
}

export async function getCreativeReport(accountKeys: string[], since: string, until: string, force = false) {
  const targets = [...new Set(accountKeys)].map((key) => { const [channel, ...rest] = key.split(":"); return { channel: channel as Channel, accountId: rest.join(":") }; })
    .filter((t) => t.channel === "meta" || t.channel === "naver_gfa" || t.channel === "google_ads");
  const errors: Array<{ channel: Channel; accountId: string; message: string }> = [];
  let oldest = Date.now();
  const pendingAccounts: string[] = [];
  const timeLimit = <T,>(promise: Promise<T>, ms: number) => Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
  const rows = (await Promise.all(targets.map(async (t) => {
    // 지난 주 이전 기간은 영구 적재, 그 외는 하루 한 번 갱신. 전환 기준(KPI)이 바뀌면 키가 달라져 다시 집계한다.
    const kpi = (await kpiPrefs())[`${t.channel}:${t.accountId}`] || "";
    const key = `creative:v3:${t.channel}:${t.accountId}:${since}:${until}${kpi ? `:k=${kpi}` : ""}`;
    const cached = force ? null : await cacheGet<CreativeRow[]>(key);
    if (cached) { oldest = Math.min(oldest, cached.updatedAt); return cached.value; }
    try {
      const work = (t.channel === "meta" ? metaCreatives(t.accountId, since, until) : t.channel === "google_ads" ? googleCreatives(t.accountId, since, until) : gfaCreatives(t.accountId, since, until))
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
// GFA 오픈API는 항목 경로(/adSets/{no})에 PUT·PATCH가 없다. 실제 수정 경로(OPTIONS로 확인):
//   광고세트 수정  POST /adAccounts/{계정}/adSets/edit  (조회한 광고세트 객체를 고쳐서 보냄, 예산 필드는 budgetAmount)
//   ON/OFF         POST /adAccounts/{계정}/{campaigns|adSets|creatives}/activate
// 본문 형식은 문서가 없어 후보를 차례로 시도하고, 모두 실패하면 GFA가 준 오류를 함께 보여준다.
async function gfaTry(label: string, path: string, bodies: unknown[]) {
  const errors: string[] = [];
  for (const body of bodies) {
    try { return await gfaRequest("POST", path, body); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  throw new Error(`GFA ${label} 실패 — ${[...new Set(errors)].join(" / ").slice(0, 900)}`);
}
async function gfaSetBudget(account: string, entityType: EntityType, id: string, amount: number) {
  if (entityType !== "adgroup") throw new Error("GFA는 광고세트(광고그룹) 단위로 예산을 바꿀 수 있어요. 캠페인 아래 광고세트의 예산을 바꿔 주세요.");
  // 공식 스키마(OpenAPI): POST /adSets/edit 는 editType 구분자를 가진 AdSetEditBudgetParam을 받는다
  //   { editType, adSetNos: [...], budgetType: DAILY|TOTAL, budgetAmount }
  // editType의 실제 type id 값은 문서에 없어 후보를 차례로 시도한다. 실패 시 서버가 허용 목록을 에러로 알려준다.
  const base = { adSetNos: [Number(id)], budgetType: "DAILY", budgetAmount: Math.round(amount) };
  return gfaTry("예산 변경", `adAccounts/${account}/adSets/edit`, [
    { editType: "BUDGET", ...base },
    { editType: "AdSetEditBudgetParam", ...base },
    { editType: "DAILY_BUDGET", ...base },
    { editType: "EDIT_BUDGET", ...base },
  ]);
}
async function gfaSetActive(account: string, entityType: EntityType, id: string, on: boolean) {
  const resource = GFA_RESOURCE[entityType];
  const no = Number(id);
  const key = { campaigns: "campaignNos", adSets: "adSetNos", creatives: "creativeNos" }[resource];
  return gfaTry("ON/OFF 변경", `adAccounts/${account}/${resource}/activate`, [
    { nos: [no], activated: on }, { [key]: [no], activated: on }, [{ no, activated: on }], { no, activated: on }, { nos: [no], activate: on },
  ]);
}

async function gfaRequest(method: MediaMethod, path: string, body?: unknown) {
  const config = gfaConfig();
  if (!config) throw new Error("네이버 GFA 인증정보가 없습니다.");
  const url = `${GFA_BASE}/${path.replace(/^\/+/, "")}`;
  const call = async (token: string) => fetch(url, { method, headers: { Authorization: `Bearer ${token}`, AccessManagerAccountNo: config.manager, "Content-Type": "application/json" }, body: body === undefined || method === "GET" ? undefined : JSON.stringify(body), cache: "no-store" });
  let response = await call(await gfaToken());
  if (response.status === 401) response = await call(await gfaToken(true));
  // 계정이 많아 요청이 몰리면 429·5xx 가 난다 → 잠깐 쉬고 두 번까지 다시 시도
  for (let retry = 0; retry < 2 && (response.status === 429 || response.status >= 500); retry++) {
    await new Promise((r) => setTimeout(r, 800 * (retry + 1) + Math.random() * 400));
    response = await call(await gfaToken());
  }
  const text = await response.text();
  let parsed: any; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { message: text }; }
  if (!response.ok) {
    // GFA는 400에 "Bad Request"만 주고 상세는 다른 필드(errors, fieldErrors 등)에 담는 경우가 있어 본문을 함께 보여준다.
    const head = [parsed?.message, parsed?.error?.message, parsed?.title].find((v) => typeof v === "string") || "";
    const raw = JSON.stringify(parsed);
    throw new Error(`${head}${raw && raw !== "{}" && raw.length > head.length + 20 ? ` ${raw.slice(0, 500)}` : ""} (HTTP ${response.status})`);
  }
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
    const kpiTypes = await metaKpiTypes(accountId);
    const rows = await metaInsightsSafe(`act_${accountId}/insights`, { level: "campaign", time_increment: "monthly", time_range: JSON.stringify({ since, until }), fields: `campaign_id,campaign_name,objective,spend,impressions,clicks,actions,action_values,${META_CATALOG_FIELDS}` });
    return rows.map((r: any) => ({ ...base, month: String(r.date_start).slice(0, 7), campaignId: String(r.campaign_id), campaignName: r.campaign_name, product: productOf(r.objective) || "", imp: num(r.impressions), clk: num(r.clicks), cost: num(r.spend), conv: metaConv(r, kpiTypes), revenue: metaRev(r, kpiTypes) }));
  }
  const out: MonthlyRow[] = [];
  if (channel === "naver_gfa") {
    const campaigns: any[] = [];
    for (let page = 0; page < 50; page++) { const items = gfaList(await gfaGet(`/adAccounts/${accountId}/campaigns`, { page: String(page), size: "100" })); campaigns.push(...items); if (items.length < 100) break; }
    const info = new Map(campaigns.map((c) => [String(c.no), c]));
    const wantedConv = await gfaKpiType(accountId);
    for (const month of months) {
      const range = { startDate: monthBounds(month).since, endDate: monthBounds(month).until, timeUnit: "monthly" };
      const fetchRows = (path: string) => gfaPaged(`/adAccounts/${accountId}${path}`, range).catch(() => gfaPaged(`/adAccounts/${accountId}${path}`, { ...range, timeUnit: "daily" }));
      const [sets, setConv, camps, campConv] = await Promise.all(["/performance/past/adSets", "/performance/conversion/past/adSets", "/performance/past/campaigns", "/performance/conversion/past/campaigns"].map((p) => fetchRows(p).catch(() => [] as any[])));
      const inSets = new Set([...sets, ...setConv].map((r) => String(r.campaignNo ?? "")));
      const agg = new Map<string, MonthlyRow>();
      const row = (no: string) => { if (!agg.has(no)) { const c = info.get(no); agg.set(no, { ...base, month, campaignId: no, campaignName: c?.name || `캠페인 ${no}`, product: productOf(c?.objective) || "", imp: 0, clk: 0, cost: 0, conv: 0, revenue: 0 }); } return agg.get(no)!; };
      const perf = (r: any) => { const x = row(String(r.campaignNo ?? "")); x.imp += num(r.impCount); x.clk += num(r.clickCount); x.cost += num(r.sales); };
      const conv = (r: any) => { if (gfaConvHit(r, wantedConv)) { const x = row(String(r.campaignNo ?? "")); x.conv += num(r.convCount); x.revenue += num(r.convSales); } };
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

/** 세부 성과분석 · 구글 검색: 유형별 합계 + 검색 캠페인의 광고그룹/키워드/검색어/광고문안 성과 (GAQL 직조회, 캐시 없음) */
export async function googleSearchInsights(accountId: string, since: string, until: string) {
  const SEL = "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value";
  const date = `segments.date BETWEEN '${since}' AND '${until}'`;
  const m = (r: any) => ({ imp: num(r.metrics?.impressions), clk: num(r.metrics?.clicks), cost: num(r.metrics?.costMicros) / 1e6, conv: num(r.metrics?.conversions), revenue: num(r.metrics?.conversionsValue) });
  const [typeRows, adgroupRows, keywordRows, termRows, adRows] = await Promise.all([
    googleSearch(accountId, `SELECT campaign.advertising_channel_type, ${SEL} FROM campaign WHERE ${date}`),
    googleSearch(accountId, `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group.status, ${SEL} FROM ad_group WHERE ${date} AND campaign.advertising_channel_type = 'SEARCH' AND metrics.impressions > 0 ORDER BY metrics.cost_micros DESC LIMIT 500`),
    googleSearch(accountId, `SELECT ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ${SEL} FROM keyword_view WHERE ${date} AND campaign.advertising_channel_type = 'SEARCH' AND metrics.impressions > 0 ORDER BY metrics.cost_micros DESC LIMIT 1000`),
    googleSearch(accountId, `SELECT ad_group.id, ad_group.name, search_term_view.search_term, ${SEL} FROM search_term_view WHERE ${date} AND metrics.impressions > 0 ORDER BY metrics.cost_micros DESC LIMIT 500`),
    googleSearch(accountId, `SELECT ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ${SEL} FROM ad_group_ad WHERE ${date} AND campaign.advertising_channel_type = 'SEARCH' AND metrics.impressions > 0 ORDER BY metrics.cost_micros DESC LIMIT 500`),
  ]);
  const typeTotals = new Map<string, any>();
  for (const r of typeRows) {
    const type = r.campaign?.advertisingChannelType || "?";
    const acc = typeTotals.get(type) || { type, label: productOf(type) || type, imp: 0, clk: 0, cost: 0, conv: 0, revenue: 0 };
    const v = m(r); acc.imp += v.imp; acc.clk += v.clk; acc.cost += v.cost; acc.conv += v.conv; acc.revenue += v.revenue;
    typeTotals.set(type, acc);
  }
  return {
    status: "ready", since, until,
    typeTotals: [...typeTotals.values()].sort((a, b) => b.cost - a.cost),
    adgroups: adgroupRows.map((r: any) => ({ adgroupId: String(r.adGroup.id), adgroup: r.adGroup.name, campaignId: String(r.campaign.id), campaign: r.campaign.name, active: r.adGroup.status === "ENABLED", ...m(r) })),
    keywords: keywordRows.map((r: any) => ({ adgroupId: String(r.adGroup.id), adgroup: r.adGroup.name, id: String(r.adGroupCriterion?.criterionId || ""), keyword: r.adGroupCriterion?.keyword?.text || "", matchType: r.adGroupCriterion?.keyword?.matchType || "", active: r.adGroupCriterion?.status === "ENABLED", ...m(r) })),
    searchTerms: termRows.map((r: any) => ({ adgroupId: String(r.adGroup.id), adgroup: r.adGroup.name, term: r.searchTermView?.searchTerm || "", ...m(r) })),
    ads: adRows.map((r: any) => ({ adgroupId: String(r.adGroup.id), adgroup: r.adGroup.name, id: String(r.adGroupAd.ad.id), active: r.adGroupAd.status === "ENABLED",
      headline: (r.adGroupAd.ad.responsiveSearchAd?.headlines || []).slice(0, 3).map((h: any) => h.text).filter(Boolean).join(" · "),
      description: (r.adGroupAd.ad.responsiveSearchAd?.descriptions || []).slice(0, 1).map((d: any) => d.text).filter(Boolean).join(" "),
      landingUrl: r.adGroupAd.ad.finalUrls?.[0], ...m(r) })),
  };
}

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
      const body = await metaGet(`${key.id}/adsets`, { fields: "id,name,status,effective_status,end_time,daily_budget,lifetime_budget,budget_remaining", limit: "500" });
      const offset = await metaBudgetOffset(key.account);
      return body.data.map((row: any) => ({ id: packed(channel, key.account, row.id), campaignId, channel, name: row.name, dailyBudget: num(row.daily_budget) / offset, ...(num(row.lifetime_budget) ? { lifetimeBudget: num(row.lifetime_budget) / offset, budgetRemaining: num(row.budget_remaining) / offset } : {}), status: asStatus(row.status),
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
        description: row.ad?.description || undefined,
        imageUrl: row.referenceData?.imageUrl, landingUrl: row.ad?.pc?.final || row.ad?.mobile?.final || row.referenceData?.landingUrl,
        active: !row.userLock && row.status !== "PAUSED" }));
    }
    if (channel === "meta") {
      const body = await metaGet(`${key.id}/ads`, { fields: "id,name,status,effective_status,creative.thumbnail_width(120).thumbnail_height(120){thumbnail_url,image_url,object_story_spec,product_set_id}", limit: "500" });
      const cpasInfo = new Map<string, { productSetId?: string; retailerIds?: string[] }>();
      const mapped = body.data.map((row: any) => { const osp = row.creative?.object_story_spec || {}; const link = osp.link_data || osp.video_data || {};
        const id = packed(channel, key.account, row.id);
        cpasInfo.set(id, { productSetId: row.creative?.product_set_id, retailerIds: link.retailer_item_ids });
        return { id, adgroupId, channel, name: row.name, status: asStatus(row.status),
          description: link.message || link.description || undefined,
          imageUrl: row.creative?.thumbnail_url || row.creative?.image_url, landingUrl: link.link || link.call_to_action?.value?.link,
          active: row.effective_status === "ACTIVE" }; });
      return resolveCanvasLandings(mapped, (r: Ad) => cpasInfo.get(r.id));
    }
    if (channel === "google_ads") {
      const rows = await googleSearch(key.account, `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.status FROM ad_group_ad WHERE ad_group.id = ${key.id} AND ad_group_ad.status != 'REMOVED'`);
      return rows.map((row: any) => { const rsa = row.adGroupAd.ad.responsiveSearchAd;
        const headline = rsa?.headlines?.map((h: any) => h.text).filter(Boolean).slice(0, 3).join(" | ");
        const desc = rsa?.descriptions?.map((d: any) => d.text).filter(Boolean).slice(0, 2).join(" / ");
        return { id: packed(channel, key.account, String(row.adGroupAd.ad.id)), adgroupId, channel,
        name: row.adGroupAd.ad.name || headline || `${row.adGroupAd.ad.type || ""} ${row.adGroupAd.ad.id}`.trim(), status: asStatus(row.adGroupAd.status),
        description: desc || undefined,
        landingUrl: row.adGroupAd.ad.finalUrls?.[0] }; });
    }
    if (channel === "naver_gfa") {
      const rows = (await gfaPagedList(key.account, "creatives", { adSetNo: key.id })).filter((row) => String(row.adSetNo) === key.id);
      return rows.map((row: any) => { const media = row.image || row.medias?.[0] || {}; return { id: packed(channel, key.account, String(row.no)), adgroupId, channel, name: row.name || `소재 ${row.no}`,
        status: (row.activated === false ? "off" : "on") as EntityStatus, imageUrl: media.imageUrl || media.url,
        landingUrl: row.landingUrl || row.landing?.url || row.landing?.pcUrl || media.landingUrl, active: row.activated !== false }; });
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
    if (operation.kind === "update_landing") {
      // 광고의 랜딩(최종 URL) 변경. 구글은 final_urls가 수정 가능한 필드라 바로 바꾼다 (SA·DA·VA 공통).
      // 네이버·메타·GFA는 소재 내용이 불변이라 새 소재 등록 방식이 필요해 아직 막아 둔다.
      if (operation.channel !== "google_ads") throw new Error("랜딩 변경은 지금 구글애즈만 지원해요. 네이버·메타·GFA는 소재를 새로 만들어 교체하는 방식이라 준비 중입니다.");
      const key = unpack(operation.id);
      await googleMutateWithEuRetry(key.account, () => googleRequest(`customers/${key.account}/ads:mutate`, { operations: [{ update: { resourceName: `customers/${key.account}/ads/${key.id}`, finalUrls: [operation.url] }, updateMask: "finalUrls" }] }));
      return { success: true, changed: 1 };
    }
    if (operation.channel === "naver_gfa") {
      const key = unpack(operation.id);
      if (operation.kind === "set_status") await gfaSetActive(key.account, operation.entityType, key.id, operation.status === "on");
      else await gfaSetBudget(key.account, operation.entityType, key.id, operation.dailyBudget);
      return { success: true, changed: 1 };
    }
    if (operation.kind === "create_text_ad") throw new Error("네이버 SA 소재 생성은 트래킹 템플릿 검증 후 지원됩니다.");
    if (operation.kind === "replace_text_ad") {
      // B 방식 교체: deleteAdId(선택)를 먼저 지우고 새 TEXT_45 소재 등록 → 네이버 검수 후 노출
      const group = unpack(operation.adgroupId);
      const created = await naverReplaceAd(group.account, group.id, {
        deleteAdId: operation.deleteAdId ? unpack(operation.deleteAdId).id : undefined,
        headline: operation.headline, description: operation.description, pcUrl: operation.pcUrl, mobileUrl: operation.mobileUrl,
      });
      return { success: true, changed: 1, data: created };
    }
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
      else await metaPost(key.id, { daily_budget: Math.round(operation.dailyBudget * await metaBudgetOffset(key.account)) });
      return { success: true, changed: 1 };
    }
    if (operation.channel === "google_ads") {
      if (operation.kind === "update_budget") {
        if (operation.entityType !== "campaign") throw new Error("Google Ads는 캠페인 예산만 변경할 수 있어요.");
        // 구글 예산은 campaign_budget 리소스라 여러 캠페인이 공유할 수 있다.
        // 전용 예산일 때만 바꾸고, 공유 예산은 다른 캠페인까지 같이 바뀌므로 거절한다.
        const rows = await googleSearch(key.account, `SELECT campaign.id, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign_budget.resource_name, campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign WHERE campaign.id = ${key.id}`);
        const chType = [rows?.[0]?.campaign?.advertisingChannelType, rows?.[0]?.campaign?.advertisingChannelSubType].filter(Boolean).join("/");
        if (/VIDEO|SMART/.test(chType)) throw new Error(`구글 ${chType.startsWith("VIDEO") ? "영상(유튜브)" : "스마트"} 캠페인은 구글이 API 수정을 막아 두었어요. 구글애즈 화면에서 직접 바꿔 주세요.`);
        const budget = rows?.[0]?.campaignBudget;
        if (!budget?.resourceName) throw new Error("캠페인 예산을 찾지 못했어요.");
        if (budget.explicitlyShared) throw new Error(`공유 예산이라 바꿀 수 없어요 (캠페인 ${Number(budget.referenceCount) || "여러 "}개가 함께 사용). 구글애즈에서 전용 예산으로 바꾸거나 공유 예산을 직접 수정해 주세요.`);
        try {
          await googleMutateWithEuRetry(key.account, () => googleRequest(`customers/${key.account}/campaignBudgets:mutate`, { operations: [{ update: { resourceName: budget.resourceName, amountMicros: String(Math.round(operation.dailyBudget) * 1_000_000) }, updateMask: "amountMicros" }] }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/Mutates are not allowed/i.test(message)) throw new Error(`구글이 이 캠페인의 API 수정을 막았어요 (유형: ${chType || "알 수 없음"}). 구글애즈 화면에서 직접 바꿔 주세요.`);
          throw error;
        }
        return { success: true, changed: 1 };
      }
      const resource = operation.entityType === "campaign" ? "campaigns" : operation.entityType === "adgroup" ? "adGroups" : "adGroupAds";
      const field = operation.entityType === "ad" ? "adGroupAd" : operation.entityType;
      const resourceName = operation.entityType === "ad" ? `customers/${key.account}/adGroupAds/${key.id}` : `customers/${key.account}/${resource}/${key.id}`;
      await googleMutateWithEuRetry(key.account, () => googleRequest(`customers/${key.account}/${resource}:mutate`, { operations: [{ update: { resourceName, status: operation.status === "on" ? "ENABLED" : "PAUSED" }, updateMask: "status" }] }));
      return { success: true, changed: 1, field };
    }
    throw new Error("지원하지 않는 변경입니다.");
  },
};

