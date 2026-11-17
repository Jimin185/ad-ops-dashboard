import { gfaRequest } from "@/lib/adapters/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// GFA 운영용 passthrough (대시보드 비밀번호 잠금 뒤에서만 접근 가능).
// 캠페인/광고세트 생성 등 어댑터에 없는 작업을 할 때 쓴다. adAccounts/ 하위만 허용.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { method?: "GET" | "POST" | "PUT" | "DELETE"; path?: string; payload?: unknown };
    const method = body.method || "GET";
    const path = String(body.path || "");
    if (!path.startsWith("adAccounts/")) return Response.json({ error: "path는 adAccounts/ 로 시작해야 합니다." }, { status: 400 });
    const data = await gfaRequest(method, path, body.payload);
    return Response.json({ ok: true, data });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "GFA 요청 실패" }, { status: 500 });
  }
}
