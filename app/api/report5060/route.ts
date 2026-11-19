import { getSaInsights, gfaRequest, googleSearch, naverRequest, tiktokRequest } from "@/lib/adapters/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Hobby 플랜 한도. SA 상세는 일자별 캐시라 타임아웃 시 재실행하면 이어서 채워진다.

// 5060 검증 캠페인(11/18~12/17) 광고주 리포트용 raw 집계. 구글 시트 Apps Script가 매일 호출한다.
// 소진은 전부 "매체 기준(VAT 제외·순매체)". 전환은 구매/장바구니를 분리해서 준다.
//  - ?dataset=total : 일자별 매체·캠페인(RAW_자동용). SA 구매/장바구니는 대용량 리포트라 첫 호출 때 비는 날이 있을 수 있음(재실행 시 채워짐).
//  - ?dataset=sa    : 기간 누적 SA 상세(키워드/검색어/파워링크 문안/쇼핑검색 제품) — 5060 캠페인만.
//  - ?dataset=va    : 기간 누적 유튜브 광고(영상 소재)별 + 연령대별.
const SA_CUSTOMER = "1922718";
const SA_CAMPAIGNS: Record<string, string> = {
  "cmp-a001-01-000000011355220": "[파워링크/5060] 모션데스크",
  "cmp-a001-01-000000011355264": "[파워링크/5060] 컴노베",
  "cmp-a001-02-000000011355269": "[쇼핑검색/5060] 모션데스크",
  "cmp-a001-02-000000011355271": "[쇼핑검색/5060] 컴노베",
};
const GFA_ACCOUNT = "44324";
const GFA_CAMPAIGN = "1700982"; // [5060캠페인]_GFA_DA
const GFA_ADSETS: Record<string, string> = {
  "4768737": "01_새로운시작_1250x560", "4768738": "01_새로운시작_1200x1200", "4768739": "01_새로운시작_1200x628",
  "4768745": "02_자녀연결_1250x560", "4768746": "02_자녀연결_1200x1200", "4768747": "02_자녀연결_1200x628",
  "4768748": "03_젊은감각_1250x560", "4768749": "03_젊은감각_1200x1200", "4768750": "03_젊은감각_1200x628",
  "4768751": "04_업무취미_1250x560", "4768752": "04_업무취미_1200x1200", "4768753": "04_업무취미_1200x628",
  "4768754": "05_나만의공간_1250x560", "4768755": "05_나만의공간_1200x1200", "4768756": "05_나만의공간_1200x628",
  "4768757": "06_허리목_1250x560", "4768758": "06_허리목_1200x1200", "4768759": "06_허리목_1200x628",
  "4768760": "07_기기전선_1250x560", "4768761": "07_기기전선_1200x1200", "4768762": "07_기기전선_1200x628",
  "4768764": "08_높낮이_1250x560", "4768765": "08_높낮이_1200x1200", "4768766": "08_높낮이_1200x628",
  "4768767": "09_책상교체_1250x560", "4768768": "09_책상교체_1200x1200", "4768769": "09_책상교체_1200x628",
};
const TIKTOK_ADVERTISER = "7571767490892595201";
const GOOGLE_CUSTOMER = "3275349017";
const GOOGLE_CAMPAIGN = "24472123581"; // [VVC/5060] 인플루언서_인스트림_1118-1217
const TARGET_AGES = new Set(["AGE_RANGE_45_54", "AGE_RANGE_55_64"]);

type Row = {
  date: string; channel: string; name: string;
  impressions: number; clicks: number; views: number; spend: number;
  purchases: number; purchaseValue: number; carts: number;
};
const num = (v: unknown) => Number(v) || 0;
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const blank = (date: string, channel: string, name: string): Row =>
  ({ date, channel, name, impressions: 0, clicks: 0, views: 0, spend: 0, purchases: 0, purchaseValue: 0, carts: 0 });

function eachDate(since: string, until: string) {
  const out: string[] = [];
  for (let t = Date.parse(since); t <= Date.parse(until); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// SA: 노출/클릭/소진은 /stats 일자별, 구매/장바구니는 상세 분석(대용량 리포트)을 날짜별로 합친다.
async function saRows(since: string, until: string, errors: string[]): Promise<Row[]> {
  const fields = JSON.stringify(["impCnt", "clkCnt", "salesAmt"]);
  const timeRange = JSON.stringify({ since, until });
  const byKey = new Map<string, Row>();
  for (const [id, name] of Object.entries(SA_CAMPAIGNS)) {
    const body = await naverRequest("GET", `/stats?${new URLSearchParams({ id, fields, timeRange, timeIncrement: "1" })}`, undefined, SA_CUSTOMER);
    for (const r of (body?.data || []) as any[]) {
      const date = String(r.dateStart || since).slice(0, 10);
      const row = blank(date, "네이버 SA", name);
      row.impressions = num(r.impCnt); row.clicks = num(r.clkCnt); row.spend = Math.round(num(r.salesAmt) / 1.1);
      byKey.set(`${date}|${name}`, row);
    }
  }
  for (const date of eachDate(since, until)) {
    if (date >= kstToday()) continue; // 상세 리포트는 전일까지만 생성됨
    try {
      const ins = await getSaInsights(SA_CUSTOMER, date, date, false, "5060");
      if (ins.status !== "ready") { errors.push(`sa_detail ${date}: 리포트 생성 중(다시 실행하면 채워집니다)`); continue; }
      const per = new Map<string, { conv: number; revenue: number; cart: number }>();
      for (const g of ins.adgroups) {
        const p = per.get(g.campaign) || { conv: 0, revenue: 0, cart: 0 };
        p.conv += g.conv; p.revenue += g.revenue; p.cart += g.cart;
        per.set(g.campaign, p);
      }
      for (const [campaign, p] of per) {
        const row = byKey.get(`${date}|${campaign}`) || blank(date, "네이버 SA", campaign);
        row.purchases = p.conv; row.purchaseValue = p.revenue; row.carts = p.cart;
        byKey.set(`${date}|${campaign}`, row);
      }
    } catch (e) { errors.push(`sa_detail ${date}: ${e instanceof Error ? e.message : e}`); }
  }
  return [...byKey.values()];
}

// GFA: 성과(노출/클릭/소진) + 전환(convType별 CART/구매)을 광고그룹 단위로 합친다.
async function gfaRows(since: string, until: string, errors: string[]): Promise<Row[]> {
  const today = kstToday();
  const end = until >= today ? new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10) : until;
  if (end < since) return [];
  const perf = await gfaRequest("GET", `adAccounts/${GFA_ACCOUNT}/performance/past/campaigns/${GFA_CAMPAIGN}/adSets?startDate=${since}&endDate=${end}&timeUnit=daily`);
  const byKey = new Map<string, Row>();
  for (const r of (perf?.rows || []) as any[]) {
    const name = GFA_ADSETS[String(r.adSetNo)] || `그룹 ${r.adSetNo}`;
    const date = String(r.targetDate || "").slice(0, 10);
    const row = blank(date, "네이버 GFA", name);
    row.impressions = num(r.impCount); row.clicks = num(r.clickCount); row.views = num(r.vplayCount); row.spend = Math.round(num(r.sales));
    byKey.set(`${date}|${name}`, row);
  }
  try {
    const conv = await gfaRequest("GET", `adAccounts/${GFA_ACCOUNT}/performance/conversion/past/campaigns/${GFA_CAMPAIGN}/adSets?startDate=${since}&endDate=${end}&timeUnit=daily`);
    for (const r of (conv?.rows || []) as any[]) {
      const name = GFA_ADSETS[String(r.adSetNo)] || `그룹 ${r.adSetNo}`;
      const date = String(r.targetDate || "").slice(0, 10);
      const row = byKey.get(`${date}|${name}`) || blank(date, "네이버 GFA", name);
      if (String(r.convType).toUpperCase().includes("CART")) row.carts += num(r.convCount);
      else { row.purchases += num(r.convCount); row.purchaseValue += num(r.convSales); }
      byKey.set(`${date}|${name}`, row);
    }
  } catch (e) { errors.push(`gfa_conv: ${e instanceof Error ? e.message : e}`); }
  return [...byKey.values()];
}

async function googleRows(since: string, until: string): Promise<Row[]> {
  const rows = await googleSearch(GOOGLE_CUSTOMER,
    `SELECT campaign.name, segments.date, metrics.impressions, metrics.clicks, metrics.video_trueview_views, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE campaign.id = ${GOOGLE_CAMPAIGN} AND segments.date BETWEEN '${since}' AND '${until}'`);
  return (rows as any[]).map((r) => {
    const row = blank(String(r.segments?.date || "").slice(0, 10), "유튜브", r.campaign?.name || "[VVC/5060] 인플루언서_인스트림");
    row.impressions = num(r.metrics?.impressions); row.clicks = num(r.metrics?.clicks); row.views = num(r.metrics?.videoTrueviewViews);
    row.spend = Math.round(num(r.metrics?.costMicros) / 1e6);
    row.purchases = num(r.metrics?.conversions); row.purchaseValue = num(r.metrics?.conversionsValue);
    return row;
  });
}

// 틱톡: 광고(영상 소재) 단위 일자별 — 합산하면 캠페인 전체가 된다.
async function tiktokRows(since: string, until: string): Promise<Row[]> {
  const data = await tiktokRequest("report/integrated/get/", {
    advertiser_id: TIKTOK_ADVERTISER, report_type: "BASIC", data_level: "AUCTION_AD",
    dimensions: JSON.stringify(["ad_id", "stat_time_day"]),
    metrics: JSON.stringify(["ad_name", "spend", "impressions", "clicks", "video_play_actions"]),
    start_date: since, end_date: until, page_size: "500",
  });
  return ((data?.list || []) as any[]).map((item) => {
    const m = item.metrics || {};
    const row = blank(String(item.dimensions?.stat_time_day || "").slice(0, 10), "틱톡", m.ad_name || `광고 ${item.dimensions?.ad_id}`);
    row.impressions = num(m.impressions); row.clicks = num(m.clicks); row.views = num(m.video_play_actions);
    row.spend = Math.round(num(m.spend));
    return row;
  }).filter((r) => r.impressions || r.spend);
}

// VA: 유튜브 광고(영상 소재)별 + 연령대별 기간 누적
async function vaDataset(since: string, until: string) {
  const range = `segments.date BETWEEN '${since}' AND '${until}'`;
  const [ads, ages] = await Promise.all([
    googleSearch(GOOGLE_CUSTOMER, `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, metrics.impressions, metrics.clicks, metrics.video_trueview_views, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM ad_group_ad WHERE campaign.id = ${GOOGLE_CAMPAIGN} AND ${range}`),
    googleSearch(GOOGLE_CUSTOMER, `SELECT ad_group_criterion.age_range.type, metrics.impressions, metrics.clicks, metrics.video_trueview_views, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM age_range_view WHERE campaign.id = ${GOOGLE_CAMPAIGN} AND ${range}`),
  ]);
  const adAgg = new Map<string, any>();
  for (const r of ads as any[]) {
    const name = r.adGroupAd?.ad?.name || `광고 ${r.adGroupAd?.ad?.id}`;
    const key = (name.match(/_(\d{2})_/) || [, ""])[1]; // YT_5060_01_... 에서 소재번호(01~08)만

    const a = adAgg.get(name) || { kind: "ad", name, key, impressions: 0, clicks: 0, views: 0, spend: 0, purchases: 0, purchaseValue: 0 };
    a.impressions += num(r.metrics?.impressions); a.clicks += num(r.metrics?.clicks); a.views += num(r.metrics?.videoTrueviewViews);
    a.spend += Math.round(num(r.metrics?.costMicros) / 1e6); a.purchases += num(r.metrics?.conversions); a.purchaseValue += num(r.metrics?.conversionsValue);
    adAgg.set(name, a);
  }
  const ageAgg = new Map<string, any>();
  for (const r of ages as any[]) {
    const type = r.adGroupCriterion?.ageRange?.type || "UNKNOWN";
    const seg = type === "AGE_RANGE_UNDETERMINED" ? "연령미상" : TARGET_AGES.has(type) ? "타겟내" : "타겟외";
    const name = type.replace("AGE_RANGE_", "").replace("_", "-");
    const a = ageAgg.get(type) || { kind: "age", name, key: seg, impressions: 0, clicks: 0, views: 0, spend: 0, purchases: 0, purchaseValue: 0 };
    a.impressions += num(r.metrics?.impressions); a.clicks += num(r.metrics?.clicks); a.views += num(r.metrics?.videoTrueviewViews);
    a.spend += Math.round(num(r.metrics?.costMicros) / 1e6); a.purchases += num(r.metrics?.conversions); a.purchaseValue += num(r.metrics?.conversionsValue);
    ageAgg.set(type, a);
  }
  return { rows: [...adAgg.values(), ...ageAgg.values()] };
}

// SA 상세: 5060 캠페인만 — 키워드/검색어/파워링크 문안/쇼핑검색 제품 (기간 누적, 구매/장바구니 분리)
async function saDataset(since: string, until: string) {
  const today = kstToday();
  const end = until >= today ? new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10) : until;
  if (end < since) return { status: "ready", keywords: [], searchTerms: [], powerlinkAds: [], products: [] };
  return getSaInsights(SA_CUSTOMER, since, end, false, "5060");
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const dataset = url.searchParams.get("dataset") || "total";
    const until = url.searchParams.get("until") || kstToday();
    const since = url.searchParams.get("since") || "2026-11-18";
    if (dataset === "sa") {
      const ins: any = await saDataset(since, until);
      if (ins.status !== "ready") return Response.json({ status: "loading", note: "SA 리포트 생성 중 — 잠시 후 다시 실행", ready: ins.ready, total: ins.total });
      const pick = (rows: any[], map: (r: any) => any[]) => rows.map(map);
      return Response.json({
        status: "ready", since, until,
        keywords: pick(ins.keywords, (r) => [r.campaign, r.adgroup, r.keyword, r.imp, r.clk, Math.round(r.cost / 1.1), r.conv, r.revenue, r.cart]),
        searchTerms: pick(ins.searchTerms, (r) => [r.campaign, r.adgroup, r.term, r.imp, r.clk, Math.round(r.cost / 1.1), r.conv, r.revenue, r.cart]),
        powerlinkAds: pick(ins.powerlinkAds, (r) => [r.campaign, r.adgroup, r.headline || "", r.description || "", r.imp, r.clk, Math.round(r.cost / 1.1), r.conv, r.revenue, r.cart]),
        products: pick(ins.products, (r) => [r.name, r.image || "", r.category || "", r.price || 0, r.imp, r.clk, Math.round(r.cost / 1.1), r.conv, r.revenue, r.cart]),
      });
    }
    if (dataset === "va") {
      const va = await vaDataset(since, until);
      return Response.json({ status: "ready", since, until, ...va });
    }
    const errors: string[] = [];
    const settled = await Promise.allSettled([saRows(since, until, errors), gfaRows(since, until, errors), googleRows(since, until), tiktokRows(since, until)]);
    const rows = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    settled.forEach((r, i) => { if (r.status === "rejected") errors.push(`${["sa", "gfa", "google", "tiktok"][i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`); });
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel) || a.name.localeCompare(b.name));
    return Response.json({ since, until, basis: "spend=매체 기준(VAT 제외·순매체), 전환=구매/장바구니 분리", rows, errors });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "report5060 실패" }, { status: 500 });
  }
}
