import { kvGet, kvSet, storageAvailable } from "@/lib/db";
import { sanitizeSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

// 광고주별 설정(예산 제외 캠페인). Supabase 가 없으면 브라우저가 localStorage 로 대신한다.
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("advertiserId");
  if (!id) return Response.json({ error: "advertiserId 가 필요합니다." }, { status: 400 });
  if (!storageAvailable()) return Response.json({ storage: "unavailable" }, { status: 503 });
  return Response.json({ settings: sanitizeSettings(await kvGet(`settings:${id}`)) });
}
export async function PUT(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!body?.advertiserId) return Response.json({ error: "advertiserId 가 필요합니다." }, { status: 400 });
  if (!storageAvailable()) return Response.json({ storage: "unavailable" }, { status: 503 });
  const settings = sanitizeSettings(body.settings);
  await kvSet(`settings:${body.advertiserId}`, settings);
  return Response.json({ settings });
}
