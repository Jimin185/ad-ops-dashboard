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
const GFA_CREATIVES: Record<string, [string, string]> = {
  "40424419": ["A", "레이아웃A_9_책상교체_1200x628"],
  "40424421": ["B", "레이아웃B_5_나만의공간_1200x628"],
  "40424429": ["C", "레이아웃C_1_새로운시작_1200x628"],
  "40424431": ["C", "레이아웃C_2_자녀연결_1200x628"],
  "40424433": ["C", "레이아웃C_4_업무취미_1200x628"],
  "40424435": ["C", "레이아웃C_5_나만의공간_1200x628"],
  "40424439": ["C", "레이아웃C_8_높낮이_1200x628"],
  "40424445": ["C", "레이아웃C_1_새로운시작_1200x1200"],
  "40424451": ["C", "레이아웃C_9_책상교체_1200x628"],
  "40424453": ["B", "레이아웃B_9_책상교체_1200x628"],
  "40424455": ["C", "레이아웃C_9_책상교체_1200x1200"],
  "40424457": ["B", "레이아웃B_9_책상교체_1250x560"],
  "40424459": ["B", "레이아웃B_8_높낮이_1200x628"],
  "40424461": ["A", "레이아웃A_8_높낮이_1200x628"],
  "40424463": ["C", "레이아웃C_8_높낮이_1200x1200"],
  "40424465": ["B", "레이아웃B_8_높낮이_1250x560"],
  "40424467": ["A", "레이아웃A_8_높낮이_1250x560"],
  "40424469": ["C", "레이아웃C_7_기기전선_1200x628"],
  "40424471": ["B", "레이아웃B_7_기기전선_1200x628"],
  "40424473": ["A", "레이아웃A_7_기기전선_1200x628"],
  "40424475": ["C", "레이아웃C_7_기기전선_1200x1200"],
  "40424477": ["B", "레이아웃B_7_기기전선_1250x560"],
  "40424479": ["A", "레이아웃A_7_기기전선_1250x560"],
  "40424481": ["C", "레이아웃C_6_허리목_1200x628"],
  "40424483": ["B", "레이아웃B_6_허리목_1200x628"],
  "40424485": ["A", "레이아웃A_6_허리목_1200x628"],
  "40424487": ["C", "레이아웃C_6_허리목_1200x1200"],
  "40424499": ["A", "레이아웃A_5_나만의공간_1200x628"],
  "40424501": ["C", "레이아웃C_5_나만의공간_1200x1200"],
  "40424503": ["B", "레이아웃B_5_나만의공간_1250x560"],
  "40424505": ["A", "레이아웃A_5_나만의공간_1250x560"],
  "40424509": ["B", "레이아웃B_4_업무취미_1200x628"],
  "40424511": ["A", "레이아웃A_4_업무취미_1200x628"],
  "40424513": ["C", "레이아웃C_4_업무취미_1200x1200"],
  "40424515": ["B", "레이아웃B_4_업무취미_1250x560"],
  "40424519": ["A", "레이아웃A_4_업무취미_1250x560"],
  "40424523": ["C", "레이아웃C_3_젊은감각_1200x628"],
  "40424525": ["B", "레이아웃B_3_젊은감각_1200x628"],
  "40424527": ["A", "레이아웃A_3_젊은감각_1200x628"],
  "40424539": ["C", "레이아웃C_3_젊은감각_1200x1200"],
  "40424543": ["B", "레이아웃B_3_젊은감각_1250x560"],
  "40424545": ["A", "레이아웃A_3_젊은감각_1250x560"],
  "40424547": ["B", "레이아웃B_2_자녀연결_1200x628"],
  "40424549": ["A", "레이아웃A_2_자녀연결_1200x628"],
  "40424553": ["C", "레이아웃C_2_자녀연결_1200x1200"],
  "40424555": ["B", "레이아웃B_2_자녀연결_1250x560"],
  "40424557": ["A", "레이아웃A_2_자녀연결_1250x560"],
  "40424559": ["B", "레이아웃B_1_새로운시작_1200x628"],
  "40424561": ["A", "레이아웃A_1_새로운시작_1200x628"],
  "40424563": ["B", "레이아웃B_1_새로운시작_1250x560"],
  "40424565": ["A", "레이아웃A_1_새로운시작_1250x560"],
  "40424609": ["B", "레이아웃B_6_허리목_1250x560"],
  "40424611": ["A", "레이아웃A_9_책상교체_1250x560"],
  "40424613": ["A", "레이아웃A_6_허리목_1250x560"],
  "40424671": ["C", "레이아웃C_1_새로운시작_1250x560"],
  "40424673": ["C", "레이아웃C_2_자녀연결_1250x560"],
  "40424677": ["C", "레이아웃C_3_젊은감각_1250x560"],
  "40424679": ["C", "레이아웃C_4_업무취미_1250x560"],
  "40424681": ["C", "레이아웃C_5_나만의공간_1250x560"],
  "40424683": ["C", "레이아웃C_6_허리목_1250x560"],
  "40424691": ["C", "레이아웃C_7_기기전선_1250x560"],
  "40424693": ["C", "레이아웃C_8_높낮이_1250x560"],
  "40424695": ["C", "레이아웃C_9_책상교체_1250x560"],
  "40424709": ["A", "레이아웃A_6_허리목_1200x1200"],
  "40424711": ["A", "레이아웃A_9_책상교체_1200x1200"],
  "40424761": ["A", "레이아웃A_1_새로운시작_1200x1200"],
  "40424763": ["A", "레이아웃A_2_자녀연결_1200x1200"],
  "40424765": ["A", "레이아웃A_3_젊은감각_1200x1200"],
  "40424767": ["A", "레이아웃A_4_업무취미_1200x1200"],
  "40424769": ["A", "레이아웃A_5_나만의공간_1200x1200"],
  "40424771": ["A", "레이아웃A_7_기기전선_1200x1200"],
  "40424773": ["A", "레이아웃A_8_높낮이_1200x1200"],
  "40424775": ["B", "레이아웃B_1_새로운시작_1200x1200"],
  "40424777": ["B", "레이아웃B_2_자녀연결_1200x1200"],
  "40424779": ["B", "레이아웃B_3_젊은감각_1200x1200"],
  "40424781": ["B", "레이아웃B_4_업무취미_1200x1200"],
  "40424783": ["B", "레이아웃B_5_나만의공간_1200x1200"],
  "40424785": ["B", "레이아웃B_6_허리목_1200x1200"],
  "40424787": ["B", "레이아웃B_7_기기전선_1200x1200"],
  "40424789": ["B", "레이아웃B_8_높낮이_1200x1200"],
  "40424791": ["B", "레이아웃B_9_책상교체_1200x1200"],
};
const GOOGLE_CUSTOMER = "3275349017";
const GOOGLE_CAMPAIGN = "24472123581"; // [VVC/5060] 인플루언서_인스트림_1118-1217
const TARGET_AGES = new Set(["AGE_RANGE_45_54", "AGE_RANGE_55_64"]);

type Row = {
  date: string; channel: string; name: string;
  impressions: number; clicks: number; views: number; spend: number;
  purchases: number; purchaseValue: number; carts: number; cartValue: number;
};
const num = (v: unknown) => Number(v) || 0;
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const blank = (date: string, channel: string, name: string): Row =>
  ({ date, channel, name, impressions: 0, clicks: 0, views: 0, spend: 0, purchases: 0, purchaseValue: 0, carts: 0, cartValue: 0 });

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
      const per = new Map<string, { conv: number; revenue: number; cart: number; cartValue: number }>();
      for (const g of ins.adgroups) {
        const p = per.get(g.campaign) || { conv: 0, revenue: 0, cart: 0, cartValue: 0 };
        p.conv += g.conv; p.revenue += g.revenue; p.cart += g.cart; p.cartValue += (g as any).cartValue || 0;
        per.set(g.campaign, p);
      }
      for (const [campaign, p] of per) {
        const row = byKey.get(`${date}|${campaign}`) || blank(date, "네이버 SA", campaign);
        row.purchases = p.conv; row.purchaseValue = p.revenue; row.carts = p.cart; row.cartValue = p.cartValue;
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
      if (String(r.convType).toUpperCase().includes("CART")) { row.carts += num(r.convCount); row.cartValue += num(r.convSales); }
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

// DA: GFA 소재(크리에이티브) 단위 기간 누적 — 레이아웃/메시지/사이즈 비교용
async function daDataset(since: string, until: string) {
  const today = kstToday();
  const end = until >= today ? new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10) : until;
  if (end < since) return { rows: [] };
  const [perf, conv] = await Promise.all([
    gfaRequest("GET", `adAccounts/${GFA_ACCOUNT}/performance/past/campaigns/${GFA_CAMPAIGN}/creatives?startDate=${since}&endDate=${end}&timeUnit=daily`),
    gfaRequest("GET", `adAccounts/${GFA_ACCOUNT}/performance/conversion/past/campaigns/${GFA_CAMPAIGN}/creatives?startDate=${since}&endDate=${end}&timeUnit=daily`).catch(() => null),
  ]);
  // 소재명 예: "레이아웃B_9_책상교체_1200x628" → 레이아웃 B, 메시지 09, 사이즈 1200x628
  const names = new Map<string, string>();
  for (const [no, group] of Object.entries(GFA_ADSETS)) names.set(no, group);
  const agg = new Map<string, any>();
  const keyOf = (creativeNo: unknown, adSetNo: unknown) => `${creativeNo}`;
  const meta = (adSetNo: unknown) => {
    const group = names.get(String(adSetNo)) || "";
    const m = group.match(/^(\d{2})_[^_]+_(.+)$/);
    return { message: m ? m[1] : "", size: m ? m[2] : "", group };
  };
  const rowFor = (r: any) => {
    const k = keyOf(r.creativeNo, r.adSetNo);
    if (!agg.has(k)) {
      const { message, size, group } = meta(r.adSetNo);
      agg.set(k, { age: "전체", creativeNo: String(r.creativeNo), name: "", layout: "", message, size, group, impressions: 0, clicks: 0, spend: 0, purchases: 0, purchaseValue: 0, carts: 0, cartValue: 0 });
    }
    return agg.get(k);
  };
  for (const r of (perf?.rows || []) as any[]) {
    const row = rowFor(r);
    row.impressions += num(r.impCount); row.clicks += num(r.clickCount); row.spend += Math.round(num(r.sales));
  }
  for (const r of (conv?.rows || []) as any[]) {
    const row = rowFor(r);
    if (String(r.convType).toUpperCase().includes("CART")) { row.carts += num(r.convCount); row.cartValue += num(r.convSales); } else { row.purchases += num(r.convCount); row.purchaseValue += num(r.convSales); }
  }
  for (const row of agg.values()) {
    const info = GFA_CREATIVES[row.creativeNo];
    if (info) { row.layout = info[0]; row.name = info[1]; }
  }
  return { rows: [...agg.values()].filter((r) => r.impressions || r.spend) };
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
    // 리포트는 전일까지만 집계한다 (당일 부분 데이터 제외).
    const yesterday = new Date(Date.parse(kstToday()) - 86_400_000).toISOString().slice(0, 10);
    const reqUntil = url.searchParams.get("until") || yesterday;
    const until = reqUntil > yesterday ? yesterday : reqUntil;
    const since = url.searchParams.get("since") || "2026-11-18";
    if (dataset === "sa") {
      const ins: any = await saDataset(since, until);
      if (ins.status !== "ready") return Response.json({ status: "loading", note: "SA 리포트 생성 중 — 잠시 후 다시 실행", ready: ins.ready, total: ins.total });
      const pick = (rows: any[], map: (r: any) => any[]) => rows.map(map);
      return Response.json({
        status: "ready", since, until,
        keywords: pick(ins.keywords, (r) => [r.campaign, r.adgroup, r.keyword, r.imp, r.clk, Math.round(r.cost / 1.1), r.conv, r.revenue, r.cart, r.cartValue || 0]),
        searchTerms: pick(ins.searchTerms, (r) => [r.campaign, r.adgroup, r.term, r.imp, r.clk, Math.round(r.cost / 1.1), r.conv, r.revenue, r.cart, r.cartValue || 0]),
        powerlinkAds: pick(ins.powerlinkAds, (r) => [r.campaign, r.adgroup, r.headline || "", r.description || "", r.imp, r.clk, Math.round(r.cost / 1.1), r.conv, r.revenue, r.cart, r.cartValue || 0]),
        products: pick(ins.products, (r) => [r.name, r.image || "", r.category || "", r.price || 0, r.imp, r.clk, Math.round(r.cost / 1.1), r.conv, r.revenue, r.cart, r.cartValue || 0]),
      });
    }
    if (dataset === "da") {
      const da = await daDataset(since, until);
      return Response.json({ status: "ready", since, until, ...da });
    }
    if (dataset === "va") {
      const va = await vaDataset(since, until);
      return Response.json({ status: "ready", since, until, ...va });
    }
    if (dataset === "vameta") {
      const ads: any[] = await googleSearch(GOOGLE_CUSTOMER, `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.video_ad.video.asset FROM ad_group_ad WHERE campaign.id = ${GOOGLE_CAMPAIGN}`);
      const assets: any[] = await googleSearch(GOOGLE_CUSTOMER, `SELECT asset.resource_name, asset.youtube_video_asset.youtube_video_id FROM asset WHERE asset.type = 'YOUTUBE_VIDEO'`).catch(() => []);
      const vid = new Map(assets.map((r: any) => [r.asset?.resourceName, r.asset?.youtubeVideoAsset?.youtubeVideoId]));
      return Response.json({
        rows: ads.map((r: any) => ({ name: r.adGroupAd?.ad?.name || "", videoId: vid.get(r.adGroupAd?.ad?.videoAd?.video?.asset) || null })),
      });
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
