import { getAdapter } from "@/lib/adapters";
import { getDailyReport } from "@/lib/adapters/live";
import { sanitizeMix, type MediaMix } from "@/lib/mix";
import { createPendingAction } from "@/lib/pending";
import type { Channel, ChangeOperation, EntityType, PendingAction } from "@/lib/types";

export const assistantTools = [
  {
    name: "list_campaigns",
    description: "현재 선택한 광고주에 매핑된 계정의 캠페인 목록(이름, ID, 일예산, 상태, 이번 달 광고비·전환·ROAS)을 광고비 순으로 조회합니다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta", "google_ads"] },
        includeOff: { type: "boolean" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "list_adgroups",
    description: "캠페인의 광고그룹 또는 광고세트 목록을 조회합니다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta", "google_ads"] },
        campaignId: { type: "string" },
      },
      required: ["channel", "campaignId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_ads",
    description: "광고그룹의 소재 목록을 조회합니다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta", "google_ads"] },
        adgroupId: { type: "string" },
      },
      required: ["channel", "adgroupId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_stats",
    description: "캠페인, 광고그룹 또는 소재 성과를 조회합니다. 기간을 생략하면 이번 달입니다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta", "google_ads"] },
        level: { type: "string", enum: ["campaign", "adgroup", "ad"] },
        ids: { type: "array", items: { type: "string" } },
        since: { type: "string", description: "YYYY-MM-DD" },
        until: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["level"],
      additionalProperties: false,
    },
  },
  {
    name: "get_report",
    description: "선택한 광고주의 기간 성과를 채널별 합계와 일자별 추이로 조회합니다. 광고비, 매출(전환가치), 전환, ROAS(%)를 돌려줍니다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        since: { type: "string", description: "YYYY-MM-DD" },
        until: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["since", "until"],
      additionalProperties: false,
    },
  },
  {
    name: "get_mixes",
    description: "선택한 광고주의 저장된 월별 미디어 믹스(채널별 월예산·목표 ROAS·메모·회고)를 조회합니다.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "propose_mix",
    description: "월별 미디어 믹스 초안을 제안합니다. 사용자가 화면의 카드에서 확인해야 저장됩니다. 채널별 월예산(KRW)과 목표 ROAS(%)를 채우고 근거를 notes에 적으세요.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        month: { type: "string", description: "YYYY-MM" },
        targetRoas: { type: "integer", description: "전체 목표 ROAS(%)" },
        notes: { type: "string", description: "믹스 근거와 전략 요약" },
        channels: {
          type: "array",
          items: {
            type: "object",
            properties: {
              channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta", "google_ads"] },
              budget: { type: "integer", description: "월 예산 KRW" },
              targetRoas: { type: "integer", description: "목표 ROAS(%)" },
              note: { type: "string" },
            },
            required: ["channel", "budget", "targetRoas", "note"],
            additionalProperties: false,
          },
        },
      },
      required: ["month", "targetRoas", "notes", "channels"],
      additionalProperties: false,
    },
  },
  {
    name: "update_budget",
    description: "캠페인 또는 광고그룹의 일예산 변경안을 생성합니다. 실제 변경은 사용자의 별도 승인이 필요합니다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta", "google_ads"] },
        entityType: { type: "string", enum: ["campaign", "adgroup"] },
        id: { type: "string" },
        dailyBudget: { type: "integer", description: "KRW, 1 이상" },
      },
      required: ["channel", "entityType", "id", "dailyBudget"],
      additionalProperties: false,
    },
  },
  {
    name: "set_status",
    description: "캠페인, 광고그룹 또는 소재의 ON/OFF 변경안을 생성합니다. 실제 변경은 사용자의 별도 승인이 필요합니다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta", "google_ads"] },
        entityType: { type: "string", enum: ["campaign", "adgroup", "ad"] },
        id: { type: "string" },
        status: { type: "string", enum: ["on", "off"] },
      },
      required: ["channel", "entityType", "id", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "create_text_ad",
    description: "네이버 SA 텍스트 광고 생성안을 만듭니다. 기존 트래킹 템플릿 적용 후 사용자 승인이 필요합니다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        adgroupIds: { type: "array", items: { type: "string" } },
        headline: { type: "string" },
        description: { type: "string" },
        landingUrl: { type: "string" },
      },
      required: ["adgroupIds", "headline", "description", "landingUrl"],
      additionalProperties: false,
    },
  },
] as const;

type ToolInput = Record<string, unknown>;

export type AssistantContext = { advertiserId?: string; advertiserName?: string; accountKeys: string[]; mixes?: MediaMix[] };

const inScope = (ctx: AssistantContext, campaign: { channel: Channel; accountId?: string }) =>
  !ctx.accountKeys.length || ctx.accountKeys.includes(`${campaign.channel}:${campaign.accountId}`);

export async function executeAssistantTool(name: string, input: ToolInput, ctx: AssistantContext = { accountKeys: [] }): Promise<{ result: unknown; pending?: PendingAction; mixDraft?: MediaMix }> {
  const adapter = getAdapter();
  if (name === "get_mixes") return { result: { mixes: (ctx.mixes || []).map(({ month, status, targetRoas, channels, notes, review }) => ({ month, status, targetRoas, channels, notes, review })) } };
  if (name === "propose_mix") {
    if (!ctx.advertiserId) return { result: { error: "광고주가 선택되지 않았습니다." } };
    const existing = ctx.mixes?.find((mix) => mix.month === input.month);
    const channels = Object.fromEntries(((input.channels as any[]) || []).map((c) => [c.channel, { budget: c.budget, targetRoas: c.targetRoas, note: c.note }]));
    const mixDraft = sanitizeMix({ id: existing?.id, advertiserId: ctx.advertiserId, month: input.month, status: "draft", targetRoas: input.targetRoas, notes: input.notes, channels, review: existing?.review, createdAt: existing?.createdAt });
    if (!mixDraft) return { result: { error: "month는 YYYY-MM 형식이어야 합니다." } };
    return { result: { status: "pending_user_confirmation", month: mixDraft.month, totalBudget: Object.values(mixDraft.channels).reduce((s, c) => s + (c?.budget || 0), 0) }, mixDraft };
  }
  if (name === "list_campaigns") {
    const rows = (await adapter.listCampaigns(input.channel as Channel | undefined, Boolean(input.includeOff))).filter((row) => inScope(ctx, row));
    // 모델 컨텍스트를 아끼기 위해 필요한 필드만, 광고비 순 상위 150개
    const slim = rows.sort((a, b) => b.spend - a.spend).slice(0, 150).map((row) => ({ id: row.id, channel: row.channel, account: row.accountName, name: row.name, dailyBudget: row.dailyBudget, status: row.status, spend: Math.round(row.spend), conversions: row.conversions, roas: row.roas }));
    return { result: { total: rows.length, shown: slim.length, campaigns: slim } };
  }
  if (name === "get_report") {
    if (!ctx.accountKeys.length) return { result: { error: "선택한 광고주에 매핑된 계정이 없습니다." } };
    const report = await getDailyReport(ctx.accountKeys, String(input.since), String(input.until));
    const byChannel: Record<string, { spend: number; revenue: number; conversions: number }> = {};
    const byDate: Record<string, { spend: number; revenue: number }> = {};
    for (const row of report.rows) {
      const c = (byChannel[row.channel] ||= { spend: 0, revenue: 0, conversions: 0 }); c.spend += row.spend; c.revenue += row.revenue; c.conversions += row.conversions;
      const d = (byDate[row.date] ||= { spend: 0, revenue: 0 }); d.spend += row.spend; d.revenue += row.revenue;
    }
    const round = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, Math.round(Number(vv))])), roas: v.spend ? Math.round(v.revenue / v.spend * 100) : 0 }]));
    return { result: { since: report.since, until: report.until, byChannel: round(byChannel), byDate: round(byDate), errors: report.errors } };
  }
  if (name === "list_adgroups") {
    return { result: await adapter.listAdgroups(input.channel as Channel, String(input.campaignId)) };
  }
  if (name === "list_ads") {
    return { result: await adapter.listAds(input.channel as Channel, String(input.adgroupId)) };
  }
  if (name === "get_stats") {
    const rows = await adapter.getStats(input.channel as Channel | undefined, String(input.level), input.ids as string[] | undefined);
    return { result: rows.filter((row) => !ctx.accountKeys.length || ctx.accountKeys.some((key) => row.id.startsWith(key.replace(":", "|") + "|"))).slice(0, 150) };
  }

  let operation: ChangeOperation;
  if (name === "create_text_ad") {
    const textOperation: Extract<ChangeOperation, { kind: "create_text_ad" }> = {
      kind: "create_text_ad",
      channel: "naver_sa",
      adgroupIds: input.adgroupIds as string[],
      headline: String(input.headline),
      description: String(input.description),
      landingUrl: String(input.landingUrl),
    };
    const pending = createPendingAction("네이버 SA 텍스트 광고 생성", textOperation, textOperation.adgroupIds.map((id) => ({
      targetId: id,
      targetName: id,
      field: "텍스트 광고",
      before: null,
      after: textOperation.headline,
    })));
    return { result: { status: "pending_user_confirmation", pendingId: pending.id }, pending };
  }

  if (name === "update_budget") {
    operation = { kind: "update_budget", channel: input.channel as Channel, entityType: input.entityType as EntityType, id: String(input.id), dailyBudget: Number(input.dailyBudget) };
  } else if (name === "set_status") {
    operation = { kind: "set_status", channel: input.channel as Channel, entityType: input.entityType as EntityType, id: String(input.id), status: input.status as "on" | "off" };
  } else {
    throw new Error(`알 수 없는 도구입니다: ${name}`);
  }

  const entity = await adapter.resolveEntity(operation.channel, operation.entityType, operation.id);
  if (!entity) throw new Error("변경 대상을 찾을 수 없습니다.");
  const field = operation.kind === "update_budget" ? "일예산" : "상태";
  const before = operation.kind === "update_budget" && "dailyBudget" in entity ? entity.dailyBudget : entity.status;
  const after = operation.kind === "update_budget" ? operation.dailyBudget : operation.status;
  const pending = createPendingAction(`${entity.name} ${field} 변경`, operation, [
    { targetId: entity.id, targetName: entity.name, field, before, after },
  ]);
  return { result: { status: "pending_user_confirmation", pendingId: pending.id }, pending };
}
