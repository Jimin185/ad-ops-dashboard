// 매체 API 결과 캐시.
// - Supabase(Postgres)가 연결돼 있으면 adops_cache 테이블에 저장해 팀 전체가 공유한다.
// - 없으면 서버 메모리에만 둔다 (인스턴스가 살아 있는 동안만 유지).
import { storageAvailable } from "@/lib/db";

type Entry = { value: unknown; expiresAt: number | null; updatedAt: number };
const memory: Map<string, Entry> = ((globalThis as any).__adopsCache ||= new Map());

async function db() {
  if (!storageAvailable()) return null;
  const { sqlForCache } = await import("@/lib/db");
  return sqlForCache();
}

export async function cacheGet<T>(key: string): Promise<{ value: T; updatedAt: number } | null> {
  const now = Date.now();
  const hit = memory.get(key);
  if (hit && (hit.expiresAt === null || hit.expiresAt > now)) return { value: hit.value as T, updatedAt: hit.updatedAt };
  try {
    const sql = await db();
    if (!sql) return null;
    const [row] = await sql`select value, expires_at, updated_at from adops_cache where key = ${key} and (expires_at is null or expires_at > now())`;
    if (!row) return null;
    const entry = { value: row.value, expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null, updatedAt: new Date(row.updated_at).getTime() };
    memory.set(key, entry);
    return { value: row.value as T, updatedAt: entry.updatedAt };
  } catch { return null; }
}

export async function cacheSet(key: string, value: unknown, expiresAt: number | null) {
  const entry = { value, expiresAt, updatedAt: Date.now() };
  memory.set(key, entry);
  if (memory.size > 500) memory.delete(memory.keys().next().value as string);
  try {
    const sql = await db();
    if (!sql) return;
    await sql`insert into adops_cache (key, value, expires_at, updated_at) values (${key}, ${sql.json(value as any)}, ${expiresAt ? new Date(expiresAt) : null}, now())
      on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at, updated_at = now()`;
  } catch { /* 캐시 저장 실패는 무시 */ }
}

// ---- 날짜 기준 (KST) ----
export function kstToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
/** 다음 갱신 시각: 내일(또는 오늘) 오전 6시 KST. 매체 데이터가 새벽에 확정되므로 6시를 기준으로 하루 한 번 갱신한다. */
export function nextDailyRefresh(): number {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const target = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), 6 - 9));
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime();
}
/** 이번 주 월요일(KST). 그 이전 날짜는 '확정'으로 보고 영구 적재한다. */
export function currentWeekStart() {
  const today = kstToday();
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export const isFinalDate = (date: string) => date < currentWeekStart();
