import { keywordStats, searchContent, searchTrend, shoppingInsight, type ContentType } from "@/lib/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 시장 인사이트 API. { action: "keywords" | "trend" | "content" | "shopping", ...params }
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as any;
    if (body.action === "keywords") return Response.json(await keywordStats(body.keywords || []));
    if (body.action === "trend") return Response.json(await searchTrend(body.groups || [], body.startDate, body.endDate, body.timeUnit || "month", body.options || {}));
    if (body.action === "content") return Response.json(await searchContent(body.type as ContentType, String(body.query || ""), body.display || 5, body.sort || "sim"));
    if (body.action === "shopping") return Response.json(await shoppingInsight(body.categories || [], body.startDate, body.endDate, body.timeUnit || "month"));
    return Response.json({ error: "알 수 없는 요청입니다." }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "시장 데이터를 불러오지 못했습니다." }, { status: 500 });
  }
}
