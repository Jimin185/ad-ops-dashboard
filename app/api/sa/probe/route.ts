import { naverRequest } from "@/lib/adapters/live";
import { withNaverSaAccounts } from "@/lib/naver-sa-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 진단용: 네이버 SA 원본 객체(그룹 설정·타겟·소재 구조) 읽기 전용 조회. GET /ncc/* 만 허용.
export async function GET(request: Request) {
  return withNaverSaAccounts(request, async () => {
    const params = new URL(request.url).searchParams;
    const customerId = params.get("customerId"), path = params.get("path") || "";
    if (!customerId || !path.startsWith("/ncc/")) return Response.json({ error: "customerId와 /ncc/ 로 시작하는 path가 필요합니다." }, { status: 400 });
    try {
      return Response.json({ data: await naverRequest("GET", path, undefined, customerId) });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "조회 실패" }, { status: 500 });
    }
  });
}
