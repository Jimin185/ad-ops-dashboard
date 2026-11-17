import { googleMutateWithEuRetry, googleRequest, googleSearch } from "@/lib/adapters/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// 구글애즈 운영용 passthrough (대시보드 비밀번호 잠금 뒤에서만 접근 가능).
// 캠페인/그룹 생성 등 어댑터에 없는 작업용. customers/ 하위만 허용.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { action?: "search" | "mutate"; customerId?: string; query?: string; path?: string; payload?: unknown };
    const customerId = String(body.customerId || "");
    if (!/^\d+$/.test(customerId)) return Response.json({ error: "customerId(숫자)가 필요합니다." }, { status: 400 });
    if (body.action === "search") {
      if (!body.query) return Response.json({ error: "query가 필요합니다." }, { status: 400 });
      return Response.json({ ok: true, data: await googleSearch(customerId, body.query) });
    }
    const path = String(body.path || "");
    if (!path.startsWith(`customers/${customerId}/`)) return Response.json({ error: "path는 customers/{customerId}/ 로 시작해야 합니다." }, { status: 400 });
    const data = await googleMutateWithEuRetry(customerId, () => googleRequest(path, body.payload));
    return Response.json({ ok: true, data });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "구글애즈 요청 실패" }, { status: 500 });
  }
}
