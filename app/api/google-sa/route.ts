import { googleSearchInsights } from "@/lib/adapters/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 세부 성과분석 · 구글 검색 탭. GAQL 직조회라 네이버처럼 리포트 생성을 기다릴 필요가 없다.
export async function POST(request: Request) {
  if (process.env.ADAPTER_MODE !== "live") return Response.json({ error: "데모 모드에서는 구글 검색 분석을 쓸 수 없습니다." }, { status: 400 });
  try {
    const { accountId, since, until } = (await request.json()) as { accountId?: string; since?: string; until?: string };
    if (!accountId || !/^\d{4}-\d{2}-\d{2}$/.test(since || "") || !/^\d{4}-\d{2}-\d{2}$/.test(until || "")) {
      return Response.json({ error: "accountId와 since/until(YYYY-MM-DD)이 필요합니다." }, { status: 400 });
    }
    return Response.json(await googleSearchInsights(accountId, since!, until!));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "구글 검색 성과를 불러오지 못했습니다." }, { status: 500 });
  }
}
