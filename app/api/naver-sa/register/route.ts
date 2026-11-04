import { verifyNaverSaCredential } from "@/lib/adapters/live";
import { deleteNaverSa, saveNaverSaSealed, storageAvailable } from "@/lib/db";
import { sealCredential } from "@/lib/naver-sa-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 네이버 SA 계정을 대시보드에서 직접 등록한다. 키를 실제 API로 검증한 뒤 암호화 토큰만 돌려준다.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { name?: string; customerId?: string; apiKey?: string; secretKey?: string };
    const customerId = String(body.customerId || "").replace(/[^0-9]/g, "");
    const apiKey = String(body.apiKey || "").trim();
    const secret = String(body.secretKey || "").trim();
    const name = String(body.name || "").trim() || `네이버 SA ${customerId}`;
    if (!customerId || !apiKey || !secret) return Response.json({ error: "CUSTOMER_ID, 액세스 라이선스, 비밀키를 모두 입력해 주세요." }, { status: 400 });
    let campaignCount = 0;
    try {
      campaignCount = await verifyNaverSaCredential({ customerId, apiKey, secret });
    } catch (error) {
      return Response.json({ error: `네이버 SA 인증 실패: ${error instanceof Error ? error.message : String(error)}` }, { status: 400 });
    }
    const token = sealCredential({ customerId, name, apiKey, secret });
    // Supabase가 연결돼 있으면 서버에 저장해 팀 전체가 쓰게 한다.
    let stored = false;
    if (storageAvailable()) { await saveNaverSaSealed(customerId, name, token); stored = true; }
    return Response.json({ account: { id: customerId, channel: "naver_sa", name }, token, campaignCount, stored });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "등록에 실패했습니다." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const customerId = (new URL(request.url).searchParams.get("customerId") || "").replace(/[^0-9]/g, "");
  if (!customerId) return Response.json({ error: "customerId가 필요합니다." }, { status: 400 });
  if (storageAvailable()) await deleteNaverSa(customerId);
  return Response.json({ ok: true });
}
