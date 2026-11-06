import { kvGet, kvSet, storageAvailable } from "@/lib/db";

export const dynamic = "force-dynamic";

type Contract = { amount: number; since: string; until: string };
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// 브랜드검색 정액 계약 (캠페인별 금액·기간). 저장하면 1분 안에 소진 일할 계산에 반영된다.
export async function GET() {
  if (!storageAvailable()) return Response.json({ contracts: {}, storage: "unavailable" });
  return Response.json({ contracts: (await kvGet<Record<string, Contract>>("brandsearch_contracts")) || {} });
}

export async function PUT(request: Request) {
  if (!storageAvailable()) return Response.json({ error: "Supabase가 연결되지 않았습니다." }, { status: 503 });
  const body = await request.json().catch(() => ({}));
  const campaignId = String(body?.campaignId || "");
  if (!campaignId) return Response.json({ error: "campaignId가 필요합니다." }, { status: 400 });
  const contracts = (await kvGet<Record<string, Contract>>("brandsearch_contracts")) || {};
  if (body.remove) {
    delete contracts[campaignId];
  } else {
    const amount = Math.round(Number(body?.amount) || 0);
    if (!(amount > 0) || !isDate(body?.since) || !isDate(body?.until) || body.since > body.until) {
      return Response.json({ error: "금액(원)과 계약 시작일·종료일(YYYY-MM-DD)을 확인해 주세요." }, { status: 400 });
    }
    contracts[campaignId] = { amount, since: body.since, until: body.until };
  }
  await kvSet("brandsearch_contracts", contracts);
  return Response.json({ contracts });
}
