import { executeMediaStep, type MediaMethod } from "@/lib/adapters/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Meta Graph API 프록시 (인증: proxy.ts 공통 x-dashboard-key)
// GET  ?path=act_123/campaigns?fields=... : 읽기
// POST { method?, path, body? }           : 쓰기 (adimages/adcreatives/ads/상태변경 등)
export async function GET(request: Request) {
  const path = new URL(request.url).searchParams.get("path") || "";
  if (!path) return Response.json({ error: "path가 필요합니다." }, { status: 400 });
  try {
    return Response.json({ data: await executeMediaStep({ channel: "meta", accountId: "", method: "GET", path }) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "조회 실패" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { method = "POST", path, body } = (await request.json()) as { method?: MediaMethod; path: string; body?: unknown };
    if (!path) return Response.json({ error: "path가 필요합니다." }, { status: 400 });
    return Response.json({ data: await executeMediaStep({ channel: "meta", accountId: "", method, path, body }) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "실행 실패" }, { status: 500 });
  }
}
