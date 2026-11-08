import { metaCreativeProbe, metaReplaceCreative } from "@/lib/adapters/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 진단: 랜딩이 안 잡히는 Meta 소재의 크리에이티브 원본 구조를 본다 (읽기 전용).
export async function GET(request: Request) {
  if (process.env.ADAPTER_MODE !== "live") return Response.json({ error: "데모 모드" }, { status: 400 });
  const adId = new URL(request.url).searchParams.get("adId");
  if (!adId || !/^\d+$/.test(adId)) return Response.json({ error: "adId(숫자)가 필요합니다." }, { status: 400 });
  try {
    return Response.json(await metaCreativeProbe(adId));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "조회 실패" }, { status: 500 });
  }
}

// 소재 이미지·랜딩 교체. 지금은 Meta만 — 새 크리에이티브를 만들어 광고에 연결한다.
export async function POST(request: Request) {
  if (process.env.ADAPTER_MODE !== "live") return Response.json({ error: "데모 모드에서는 소재를 바꿀 수 없습니다." }, { status: 400 });
  try {
    const body = (await request.json()) as { channel?: string; accountId?: string; adId?: string; imageBase64?: string; link?: string };
    if (body.channel !== "meta") return Response.json({ error: "지금은 Meta 소재만 교체할 수 있어요. (GFA·네이버는 준비 중)" }, { status: 400 });
    if (!body.accountId || !body.adId || (!body.imageBase64 && !body.link)) return Response.json({ error: "accountId, adId와 imageBase64 또는 link가 필요합니다." }, { status: 400 });
    if (body.link && !/^https?:\/\/\S+$/.test(body.link)) return Response.json({ error: "랜딩 URL은 http(s)://로 시작해야 해요." }, { status: 400 });
    if (body.imageBase64 && body.imageBase64.length > 8_000_000) return Response.json({ error: "이미지가 너무 커요 (6MB 이하로 올려주세요)." }, { status: 400 });
    return Response.json(await metaReplaceCreative(body.accountId, body.adId, { imageBase64: body.imageBase64, link: body.link }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "소재를 바꾸지 못했습니다.";
    console.error(`creative/edit 실패 — ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}
