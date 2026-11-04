import { getSaInsights } from "@/lib/adapters/live";
import { withNaverSaAccounts } from "@/lib/naver-sa-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

// 네이버 SA 상세 분석. 날짜별 리포트를 만들어 받는 데 시간이 걸려서, 끝나지 않았으면 진행률을 돌려주고
// 브라우저가 다시 부르면 이미 받은 날짜는 저장된 값으로 건너뛴다.
export async function POST(request: Request) {
  return withNaverSaAccounts(request, async () => {
    try {
      const body = (await request.json()) as { customerId?: string; since?: string; until?: string; refresh?: boolean };
      const customerId = String(body.customerId || "").replace(/[^0-9]/g, "");
      if (!customerId || !isDate(body.since) || !isDate(body.until)) return Response.json({ error: "customerId, since, until이 필요합니다." }, { status: 400 });
      return Response.json(await getSaInsights(customerId, body.since, body.until, Boolean(body.refresh)));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "SA 분석을 불러오지 못했습니다." }, { status: 500 });
    }
  });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return withNaverSaAccounts(request, async () => {
    try {
      const customerId = String(params.get("customerId") || "").replace(/[^0-9]/g, "");
      const since = params.get("since"), until = params.get("until");
      if (!customerId || !isDate(since) || !isDate(until)) return Response.json({ error: "customerId, since, until이 필요합니다." }, { status: 400 });
      return Response.json(await getSaInsights(customerId, since, until));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "SA 분석을 불러오지 못했습니다." }, { status: 500 });
    }
  });
}
