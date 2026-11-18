import { gfaRequest, googleSearch, naverRequest } from "@/lib/adapters/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// 5060 검증 캠페인(11/18~12/17) 광고주 리포트용 raw 집계.
// 구글 시트 Apps Script가 매일 호출한다. 소진은 전부 "매체 기준(VAT 제외)"으로 통일:
//  - SA salesAmt는 VAT 포함이므로 ÷1.1, GFA sales는 VAT 제외 그대로, 구글은 cost_micros/1e6(순매체).
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
const GOOGLE_CUSTOMER = "3275349017";
const GOOGLE_CAMPAIGN = "24472123581"; // [VVC/5060] 인플루언서_인스트림_1118-1217

type Row = {
  date: string; channel: string; name: string;
  impressions: number; clicks: number; views: number; spend: number; conversions: number; revenue: number;
};
const num = (v: unknown) => Number(v) || 0;

async function saRows(since: string, until: string): Promise<Row[]> {
  const fields = JSON.stringify(["impCnt", "clkCnt", "salesAmt", "ccnt", "convAmt"]);
  const timeRange = JSON.stringify({ since, until });
  const out: Row[] = [];
  for (const [id, name] of Object.entries(SA_CAMPAIGNS)) {
    const body = await naverRequest("GET", `/stats?${new URLSearchParams({ id, fields, timeRange, timeIncrement: "1" })}`, undefined, SA_CUSTOMER);
    for (const row of (body?.data || []) as any[]) {
      out.push({
        date: String(row.dateStart || since).slice(0, 10), channel: "네이버 SA", name,
        impressions: num(row.impCnt), clicks: num(row.clkCnt), views: 0,
        spend: Math.round(num(row.salesAmt) / 1.1), conversions: num(row.ccnt), revenue: num(row.convAmt),
      });
    }
  }
  return out;
}

async function gfaRows(since: string, until: string): Promise<Row[]> {
  // GFA 성과 API는 endDate가 오늘 이전이어야 한다.
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const end = until >= today ? new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10) : until;
  if (end < since) return [];
  const body = await gfaRequest("GET", `adAccounts/${GFA_ACCOUNT}/performance/past/campaigns/${GFA_CAMPAIGN}/adSets?startDate=${since}&endDate=${end}&timeUnit=daily`);
  return ((body?.rows || []) as any[]).map((row) => ({
    date: String(row.targetDate || "").slice(0, 10), channel: "네이버 GFA",
    name: GFA_ADSETS[String(row.adSetNo)] || `그룹 ${row.adSetNo}`,
    impressions: num(row.impCount), clicks: num(row.clickCount), views: num(row.vplayCount),
    spend: Math.round(num(row.sales)), conversions: num(row.convCount), revenue: num(row.convSales),
  }));
}

async function googleRows(since: string, until: string): Promise<Row[]> {
  const rows = await googleSearch(GOOGLE_CUSTOMER,
    `SELECT campaign.name, segments.date, metrics.impressions, metrics.clicks, metrics.video_trueview_views, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE campaign.id = ${GOOGLE_CAMPAIGN} AND segments.date BETWEEN '${since}' AND '${until}'`);
  return (rows as any[]).map((row) => ({
    date: String(row.segments?.date || "").slice(0, 10), channel: "유튜브",
    name: row.campaign?.name || "[VVC/5060] 인플루언서_인스트림",
    impressions: num(row.metrics?.impressions), clicks: num(row.metrics?.clicks), views: num(row.metrics?.videoTrueviewViews),
    spend: Math.round(num(row.metrics?.costMicros) / 1e6), conversions: num(row.metrics?.conversions), revenue: num(row.metrics?.conversionsValue),
  }));
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const until = url.searchParams.get("until") || new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const since = url.searchParams.get("since") || "2026-11-18";
    const settled = await Promise.allSettled([saRows(since, until), gfaRows(since, until), googleRows(since, until)]);
    const rows = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const errors = settled.flatMap((r, i) => r.status === "rejected"
      ? [`${["sa", "gfa", "google"][i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`] : []);
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel) || a.name.localeCompare(b.name));
    return Response.json({ since, until, basis: "spend=매체 기준(VAT 제외·순매체)", rows, errors });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "report5060 실패" }, { status: 500 });
  }
}
