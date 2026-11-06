// 광고주별 설정(예산 제외 캠페인)과 ON/OFF 예약
import type { Channel, EntityType } from "@/lib/types";

/** 예산·리포트에서 뺄 캠페인. months 가 없으면 모든 기간, 있으면 그 달들만 */
export type Exclusion = { campaignId: string; name: string; channel: Channel; months?: string[]; reason?: string; createdAt: string };
export type AdvertiserSettings = { exclusions: Exclusion[] };

/** 예약: date(KST) 하루가 시작될 때 status 로 바꾼다. OFF 는 전날 23시대, ON 은 당일 0시대에 실행 */
export type Schedule = {
  id: string; channel: Channel; entityType: EntityType; entityId: string; name: string;
  status: "on" | "off"; date: string; createdBy?: string; createdAt: string;
  result?: { ok: boolean; at: string; error?: string };
};

export const isExcluded = (settings: AdvertiserSettings | null | undefined, campaignId: string, month: string) =>
  Boolean(settings?.exclusions?.some((e) => e.campaignId === campaignId && (!e.months?.length || e.months.includes(month))));

export function sanitizeSettings(input: any): AdvertiserSettings {
  const list = Array.isArray(input?.exclusions) ? input.exclusions : [];
  return { exclusions: list.slice(0, 500).filter((e: any) => e?.campaignId).map((e: any) => ({
    campaignId: String(e.campaignId).slice(0, 200), name: String(e.name || "").slice(0, 200), channel: e.channel,
    months: Array.isArray(e.months) ? e.months.filter((m: any) => /^\d{4}-\d{2}$/.test(String(m))).slice(0, 60) : undefined,
    reason: e.reason ? String(e.reason).slice(0, 200) : undefined, createdAt: String(e.createdAt || new Date().toISOString()),
  })) };
}
export function sanitizeSchedules(input: unknown): Schedule[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 500).filter((s: any) => s?.entityId && /^\d{4}-\d{2}-\d{2}$/.test(String(s.date)) && (s.status === "on" || s.status === "off")
    && ["campaign", "adgroup", "ad"].includes(s.entityType)).map((s: any) => ({
    id: String(s.id || crypto.randomUUID()), channel: s.channel, entityType: s.entityType, entityId: String(s.entityId), name: String(s.name || "").slice(0, 200),
    status: s.status, date: String(s.date), createdBy: s.createdBy ? String(s.createdBy).slice(0, 80) : undefined, createdAt: String(s.createdAt || new Date().toISOString()),
    result: s.result && typeof s.result === "object" ? { ok: Boolean(s.result.ok), at: String(s.result.at), error: s.result.error ? String(s.result.error).slice(0, 300) : undefined } : undefined,
  }));
}
