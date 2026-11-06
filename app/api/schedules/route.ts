import { kvGet, kvSet, storageAvailable } from "@/lib/db";
import { sanitizeSchedules, type Schedule } from "@/lib/settings";

export const dynamic = "force-dynamic";

// ON/OFF 예약 목록(광고주별). 실행은 /api/cron/schedules 가 한다.
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("advertiserId");
  if (!id) return Response.json({ error: "advertiserId 가 필요합니다." }, { status: 400 });
  if (!storageAvailable()) return Response.json({ error: "예약은 Supabase 연결이 필요해요.", storage: "unavailable" }, { status: 503 });
  return Response.json({ schedules: sanitizeSchedules(await kvGet(`schedules:${id}`)) });
}
/** body: { advertiserId, add?: Schedule[], remove?: string[] } — 동시 수정이 겹쳐도 덜 잃도록 전체 덮어쓰기 대신 추가/삭제로 받는다 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!body?.advertiserId) return Response.json({ error: "advertiserId 가 필요합니다." }, { status: 400 });
  if (!storageAvailable()) return Response.json({ error: "예약은 Supabase 연결이 필요해요." }, { status: 503 });
  const key = `schedules:${body.advertiserId}`;
  const current = sanitizeSchedules(await kvGet(key));
  const remove = new Set<string>((body.remove || []).map(String));
  const add: Schedule[] = sanitizeSchedules((body.add || []).map((s: any) => ({ ...s, result: undefined, createdAt: new Date().toISOString() })));
  // 같은 대상·같은 날짜 예약은 새 것으로 바꾼다
  const next = [...current.filter((s) => !remove.has(s.id) && !add.some((a) => a.entityId === s.entityId && a.date === s.date)), ...add];
  await kvSet(key, next);
  return Response.json({ schedules: next });
}
