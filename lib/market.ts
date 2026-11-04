// 시장 인사이트: NAVER API HUB(뉴스·블로그·카페 검색, 검색어 트렌드, 쇼핑인사이트) + 네이버 SA 키워드도구.
// NAVER API HUB는 호출당 과금될 수 있어 모든 결과를 24시간 캐시한다.
import { cacheGet, cacheSet } from "@/lib/cache";
import { naverRequest } from "@/lib/adapters/live";

const HUB = "https://naverapihub.apigw.ntruss.com";
const DAY = 24 * 3600_000;

function headers() {
  const id = process.env.NAVER_OPENAPI_KEY_ID, key = process.env.NAVER_OPENAPI_KEY;
  if (!id || !key) throw new Error("NAVER API HUB 키(NAVER_OPENAPI_KEY_ID/NAVER_OPENAPI_KEY)가 설정되지 않았습니다.");
  return { "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": key, "Content-Type": "application/json" };
}

async function hub(path: string, init: RequestInit = {}) {
  const response = await fetch(`${HUB}${path}`, { ...init, headers: headers(), cache: "no-store" });
  const text = await response.text();
  let body: any; try { body = JSON.parse(text); } catch { body = { message: text }; }
  if (!response.ok) throw Object.assign(new Error(body?.error?.message || body?.errorMessage || `HTTP ${response.status}`), { status: response.status });
  return body;
}

async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T & { cachedAt?: string }> {
  const hit = await cacheGet<T>(key);
  if (hit) return { ...(hit.value as any), cachedAt: new Date(hit.updatedAt).toISOString() };
  const value = await load();
  await cacheSet(key, value, Date.now() + ttl);
  return value as any;
}

const strip = (html: string) => String(html || "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");

export type ContentType = "news" | "blog" | "cafearticle";
export async function searchContent(type: ContentType, query: string, display = 10, sort: "sim" | "date" = "sim") {
  const q = query.trim().slice(0, 100);
  return cached(`market:content:${type}:${sort}:${display}:${q}`, DAY / 2, async () => {
    const body = await hub(`/search/v1/${type}?${new URLSearchParams({ query: q, display: String(Math.min(30, display)), sort })}`);
    return {
      total: Number(body.total || 0),
      items: (body.items || []).map((item: any) => ({ title: strip(item.title), description: strip(item.description).slice(0, 200), link: item.originallink || item.link, date: item.pubDate || item.postdate || "", source: item.bloggername || item.cafename || "" })),
    };
  });
}

export type TrendGroup = { name: string; keywords: string[] };
export async function searchTrend(groups: TrendGroup[], startDate: string, endDate: string, timeUnit: "date" | "week" | "month" = "month", options: { device?: "pc" | "mo"; gender?: "m" | "f"; ages?: string[] } = {}) {
  const keywordGroups = groups.slice(0, 5).map((g) => ({ groupName: g.name.slice(0, 50), keywords: g.keywords.slice(0, 20) }));
  const payload = { startDate, endDate, timeUnit, keywordGroups, ...(options.device ? { device: options.device } : {}), ...(options.gender ? { gender: options.gender } : {}), ...(options.ages?.length ? { ages: options.ages } : {}) };
  return cached(`market:trend:${JSON.stringify(payload)}`, DAY, async () => {
    const body = await hub("/search-trend/v1/search", { method: "POST", body: JSON.stringify(payload) });
    return { results: (body.results || []).map((r: any) => ({ name: r.title, data: (r.data || []).map((d: any) => ({ period: d.period, ratio: Math.round(Number(d.ratio) * 10) / 10 })) })) };
  });
}

// 쇼핑인사이트 경로는 상품 구성에 따라 달라서, 되는 경로를 찾아 기억한다.
const SHOPPING_PATHS = ["/shopping-insight/v1/categories", "/shopping-insight/v1/category", "/shoppinginsight/v1/categories", "/datalab-shopping/v1/categories", "/shopping/v1/categories", "/search-trend/v1/shopping/categories"];
export async function shoppingInsight(categories: Array<{ name: string; id: string }>, startDate: string, endDate: string, timeUnit: "date" | "week" | "month" = "month") {
  const payload = { startDate, endDate, timeUnit, category: categories.slice(0, 3).map((c) => ({ name: c.name, param: [c.id] })) };
  return cached(`market:shopping:${JSON.stringify(payload)}`, DAY, async () => {
    const known = (await cacheGet<string>("market:shopping-path"))?.value;
    for (const path of known ? [known] : SHOPPING_PATHS) {
      try {
        const body = await hub(path, { method: "POST", body: JSON.stringify(payload) });
        if (!known) await cacheSet("market:shopping-path", path, Date.now() + 30 * DAY);
        return { results: (body.results || []).map((r: any) => ({ name: r.title, data: (r.data || []).map((d: any) => ({ period: d.period, ratio: Math.round(Number(d.ratio) * 10) / 10 })) })) };
      } catch (error: any) { if (error?.status !== 404) throw error; }
    }
    throw new Error("쇼핑인사이트 API 경로를 찾지 못했습니다. NAVER API HUB 콘솔의 쇼핑인사이트 요청 주소를 알려주세요.");
  });
}

/** 네이버 SA 키워드도구: 연관 키워드와 월간 검색수·클릭수·경쟁도. 대시보드의 SA 계정 키를 쓴다. */
export async function keywordStats(hints: string[], customerId?: string) {
  const list = hints.map((h) => h.replace(/\s+/g, "").slice(0, 40)).filter(Boolean).slice(0, 5);
  const customer = (customerId || process.env.NAVER_SA_CUSTOMER_ID || "").replace(/[^0-9]/g, "");
  if (!list.length) return { keywords: [] };
  return cached(`market:kw:${customer}:${list.join(",")}`, DAY * 3, async () => {
    const body = await naverRequest("GET", `/keywordstool?${new URLSearchParams({ hintKeywords: list.join(","), showDetail: "1" })}`, undefined, customer || undefined);
    const n = (v: unknown) => typeof v === "number" ? v : Number(String(v).replace(/[^0-9.]/g, "")) || 0; // "< 10" 같은 값 처리
    return {
      keywords: (body.keywordList || []).slice(0, 60).map((k: any) => ({
        keyword: k.relKeyword, pc: n(k.monthlyPcQcCnt), mobile: n(k.monthlyMobileQcCnt), total: n(k.monthlyPcQcCnt) + n(k.monthlyMobileQcCnt),
        clicks: Math.round(n(k.monthlyAvePcClkCnt) + n(k.monthlyAveMobileClkCnt)), ctr: Math.round((n(k.monthlyAvePcCtr) + n(k.monthlyAveMobileCtr)) / 2 * 100) / 100,
        competition: k.compIdx, adDepth: n(k.plAvgDepth),
      })),
    };
  });
}
