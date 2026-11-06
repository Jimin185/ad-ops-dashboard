import { getAdapter } from "@/lib/adapters";
import { kvGet, kvSet, listAdvertisers } from "@/lib/db";
import { sanitizeSchedules } from "@/lib/settings";

const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * 실행할 때가 된 예약을 적용한다.
 * - OFF: 날짜 전날 22시(KST) 이후면 미리 끈다(다음 날 0시부터 안 돌게). 크론은 23시대에 돈다.
 * - ON: 날짜 당일 0시(KST) 이후에 켠다. 크론은 0시대에 돈다.
 * - 지난 날짜인데 아직 안 된 예약은 다음 실행 때 바로 처리한다(아침 7시 크론에서도 다시 확인).
 */
export async function runDueSchedules(budgetMs = 45_000) {
  const started = Date.now();
  const now = kst();
  const today = ymd(now);
  const tomorrow = ymd(new Date(now.getTime() + 24 * 3600_000));
  const lateEvening = now.getUTCHours() >= 22;
  const log: Array<{ advertiserId: string; id: string; name: string; status: string; ok: boolean; error?: string }> = [];
  for (const adv of await listAdvertisers()) {
    if (Date.now() - started > budgetMs) break;
    const key = `schedules:${adv.id}`;
    const list = sanitizeSchedules(await kvGet(key));
    let changed = false;
    for (const s of list) {
      if (s.result || Date.now() - started > budgetMs) continue;
      const due = s.status === "off" ? s.date <= today || (lateEvening && s.date === tomorrow) : s.date <= today;
      if (!due) continue;
      try {
        await getAdapter().apply({ kind: "set_status", channel: s.channel, entityType: s.entityType, id: s.entityId, status: s.status });
        s.result = { ok: true, at: new Date().toISOString() };
      } catch (error) {
        s.result = { ok: false, at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
      }
      changed = true;
      log.push({ advertiserId: adv.id, id: s.id, name: s.name, status: s.status, ok: s.result.ok, error: s.result.error });
    }
    // 실행한 지 14일 지난 기록은 정리
    const keep = list.filter((s) => !s.result || Date.now() - new Date(s.result.at).getTime() < 14 * 86_400_000);
    if (changed || keep.length !== list.length) {
      // 실행 중 화면에서 추가된 예약을 잃지 않도록 최신 목록에 결과만 합친다
      const latest = sanitizeSchedules(await kvGet(key));
      const byId = new Map(keep.map((s) => [s.id, s]));
      await kvSet(key, latest.filter((s) => byId.has(s.id) || !list.some((o) => o.id === s.id)).map((s) => byId.get(s.id)?.result ? byId.get(s.id)! : s));
    }
  }
  return log;
}
