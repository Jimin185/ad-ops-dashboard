import { withNaverSaAccounts } from "@/lib/naver-sa-registry";
import { naverAdExtensions, naverPowerlinkAds, naverReplaceAd } from "@/lib/adapters/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 파워링크 소재 관리: 그룹의 소재·확장소재 조회(GET), B 방식 교체/추가(POST: 선삭제 → 신규 등록 → 검수)
export async function GET(request: Request) {
  return withNaverSaAccounts(request, async () => {
    const params = new URL(request.url).searchParams;
    const customerId = params.get("customerId"), adgroupId = params.get("adgroupId");
    if (!customerId || !adgroupId) return Response.json({ error: "customerId와 adgroupId가 필요합니다." }, { status: 400 });
    try {
      const [ads, extensions] = await Promise.all([naverPowerlinkAds(customerId, adgroupId), naverAdExtensions(customerId, adgroupId)]);
      return Response.json({ ads, extensions });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "소재를 불러오지 못했습니다." }, { status: 500 });
    }
  });
}

export async function POST(request: Request) {
  return withNaverSaAccounts(request, async () => {
    try {
      const body = (await request.json()) as { customerId?: string; adgroupId?: string; deleteAdId?: string; headline?: string; description?: string; pcUrl?: string; mobileUrl?: string };
      const headline = String(body.headline || "").trim(), description = String(body.description || "").trim();
      if (!body.customerId || !body.adgroupId) return Response.json({ error: "customerId와 adgroupId가 필요합니다." }, { status: 400 });
      if (!headline || !description) return Response.json({ error: "제목과 설명이 필요합니다." }, { status: 400 });
      // 파워링크 제한: 제목 15자, 설명 45자 (키워드 치환 {…:기본값}은 기본값 길이로 센다)
      const visible = (s: string) => s.replace(/\{[^:}]*:([^}]*)\}/g, "$1").length;
      if (visible(headline) > 15) return Response.json({ error: `제목이 15자를 넘어요 (${visible(headline)}자).` }, { status: 400 });
      if (visible(description) > 45) return Response.json({ error: `설명이 45자를 넘어요 (${visible(description)}자).` }, { status: 400 });
      if (!/^https?:\/\/\S+$/.test(String(body.pcUrl || ""))) return Response.json({ error: "PC 랜딩 URL을 확인해 주세요." }, { status: 400 });
      const created = await naverReplaceAd(body.customerId, body.adgroupId, { deleteAdId: body.deleteAdId || undefined, headline, description, pcUrl: body.pcUrl!, mobileUrl: body.mobileUrl || undefined });
      return Response.json({ created });
    } catch (error) {
      const message = error instanceof Error ? error.message : "소재를 바꾸지 못했습니다.";
      console.error(`sa/ads 실패 — ${message}`);
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
