import { getAdapter } from "@/lib/adapters";
import { createPendingAction } from "@/lib/pending";
import type { Channel, ChangeOperation, EntityType, PendingAction } from "@/lib/types";

export const assistantTools = [
  {
    name: "list_campaigns",
    description: "채널별 캠페인 목록과 이름, ID, 일예산, 상태를 조회합니다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta"] },
        includeOff: { type: "boolean" },
      },
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
        channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta"] },
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
        channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta"] },
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
        channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta"] },
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
    name: "update_budget",
    description: "캠페인 또는 광고그룹의 일예산 변경안을 생성합니다. 실제 변경은 사용자의 별도 승인이 필요합니다.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta"] },
        entityType: { type: "string", enum: ["campaign", "adgroup"] },
        id: { type: "string" },
        dailyBudget: { type: "integer", minimum: 1 },
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
        channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta"] },
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
        adgroupIds: { type: "array", minItems: 1, items: { type: "string" } },
        headline: { type: "string" },
        description: { type: "string" },
        landingUrl: { type: "string", format: "uri" },
      },
      required: ["adgroupIds", "headline", "description", "landingUrl"],
      additionalProperties: false,
    },
  },
] as const;

type ToolInput = Record<string, unknown>;

export async function executeAssistantTool(name: string, input: ToolInput): Promise<{ result: unknown; pending?: PendingAction }> {
  const adapter = getAdapter();
  if (name === "list_campaigns") {
    return { result: await adapter.listCampaigns(input.channel as Channel | undefined, Boolean(input.includeOff)) };
  }
  if (name === "list_adgroups") {
    return { result: await adapter.listAdgroups(input.channel as Channel, String(input.campaignId)) };
  }
  if (name === "list_ads") {
    return { result: await adapter.listAds(input.channel as Channel, String(input.adgroupId)) };
  }
  if (name === "get_stats") {
    return { result: await adapter.getStats(input.channel as Channel | undefined, String(input.level), input.ids as string[] | undefined) };
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
