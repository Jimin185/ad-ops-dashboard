import type { Channel } from "@/lib/types";

// 월별 미디어 믹스: 광고주 × 월 단위 계획. 채널별 예산·목표 ROAS와 메모.
export type MixChannelPlan = { budget: number; targetRoas: number; note?: string };
export type MediaMix = {
  id: string;
  advertiserId: string;
  month: string; // YYYY-MM
  status: "draft" | "active" | "closed";
  targetRoas: number; // 전체 목표 ROAS(%)
  channels: Partial<Record<Channel, MixChannelPlan>>;
  notes: string;
  review?: string; // 월 마감 후 회고 (다음 달 믹스 근거)
  createdAt: string;
  updatedAt: string;
};

export type Advertiser = { id: string; name: string; accountKeys: string[] };

export const mixTotalBudget = (mix: Pick<MediaMix, "channels">) => Object.values(mix.channels).reduce((sum, plan) => sum + (plan?.budget || 0), 0);

export function sanitizeMix(input: any): MediaMix | null {
  if (!input || typeof input !== "object") return null;
  const month = String(input.month || "");
  if (!/^\d{4}-\d{2}$/.test(month) || !input.advertiserId) return null;
  const channels: MediaMix["channels"] = {};
  for (const key of ["naver_sa", "naver_gfa", "meta", "google_ads"] as Channel[]) {
    const plan = input.channels?.[key];
    if (!plan) continue;
    const budget = Math.max(0, Math.round(Number(plan.budget) || 0));
    const targetRoas = Math.max(0, Math.round(Number(plan.targetRoas) || 0));
    if (budget || targetRoas || plan.note) channels[key] = { budget, targetRoas, note: plan.note ? String(plan.note).slice(0, 500) : undefined };
  }
  const now = new Date().toISOString();
  return {
    id: String(input.id || crypto.randomUUID()),
    advertiserId: String(input.advertiserId),
    month,
    status: ["draft", "active", "closed"].includes(input.status) ? input.status : "draft",
    targetRoas: Math.max(0, Math.round(Number(input.targetRoas) || 0)),
    channels,
    notes: String(input.notes || "").slice(0, 4000),
    review: input.review ? String(input.review).slice(0, 4000) : undefined,
    createdAt: String(input.createdAt || now),
    updatedAt: now,
  };
}
