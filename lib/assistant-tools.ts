import { getAdapter } from "@/lib/adapters";
import { assertMediaScope, executeMediaStep, getDailyReport } from "@/lib/adapters/live";
import { keywordStats, searchContent, searchTrend, shoppingInsight, type ContentType, type TrendGroup } from "@/lib/market";
import { sanitizeMix, type MediaMix } from "@/lib/mix";
import { createPendingAction } from "@/lib/pending";
import type { Channel, ChangeOperation, EntityType, PendingAction } from "@/lib/types";

export const assistantTools = [
  {
    name: "list_campaigns",
    description: "현재 선택한 광고주에 매핑된 계정의 운영 중인 캠페인 목록(이름, ID, 일예산, 상태, 이번 달 광고비·전환·ROAS)을 광고비 순으로 조회합니다. 꺼짐·종료 캠페인까지 필요하면 includeOff=true.",

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
    description: "선택한 광고주의 월별 미디어 믹스(채널·라인별 월예산·목표 ROAS·메모·회고)와 이번 달 라인별 실적(집행액·ROAS·연결 캠페인 ID)을 조회합니다. 믹스 대비 성과나 예산 조정은 이 결과로 판단하세요.",

    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "propose_mix",
    description: "월별 미디어 믹스 초안을 제안합니다. 사용자가 화면의 카드에서 확인해야 저장됩니다. 채널별 월예산(KRW)과 목표 ROAS(%)를 채우고 근거를 notes에 적으세요.",

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
        lines: {
          type: "array",
          description: "선택: 운영 단위 라인(예: 아이책상 기획전). 캠페인 이름에 들어간 키워드로 캠페인과 자동 연결됩니다.",
          items: { type: "object", properties: { name: { type: "string" }, channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta", "google_ads", "all"] }, budget: { type: "integer" }, targetRoas: { type: "integer" }, keywords: { type: "array", items: { type: "string" } } }, required: ["name", "channel", "budget"] },
        },
      },
      required: ["month", "targetRoas", "notes", "channels"],
      additionalProperties: false,
    },
  },
  {
    name: "media_api_get",
    description: "매체 API 조회(GET)를 바로 실행합니다. 세팅 전에 기존 캠페인·광고그룹·소재·타겟·크리에이티브 구조를 확인할 때 씁니다. 결과는 앞부분 12,000자까지만 돌려줍니다 — fields/필터를 좁혀 요청하세요.\n- meta: Graph API 경로 (예: act_{계정}/campaigns, {광고ID}?fields=name,adset_id,creative{id,object_story_spec}). 쿼리는 path에 붙이거나 bodyJson에 객체로.\n- google_ads: customers/{계정}/googleAds:search 는 POST라 조회도 propose 없이 이 도구에서 method 대신 GAQL을 bodyJson {\"query\":...}로 넣으면 POST로 실행됩니다.\n- naver_sa: /ncc/campaigns, /ncc/adgroups?nccCampaignId=, /ncc/keywords?nccAdgroupId=, /ncc/ads?nccAdgroupId= 등.\n- naver_gfa: /adAccounts/{계정}/campaigns, /adAccounts/{계정}/adSets, /adAccounts/{계정}/creatives 등.",

    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta", "google_ads"] },
        accountId: { type: "string", description: "매핑된 광고계정 ID (숫자)" },
        path: { type: "string" },
        bodyJson: { type: "string", description: "쿼리 파라미터 또는 GAQL을 담은 JSON 문자열. 없으면 빈 문자열" },
      },
      required: ["channel", "accountId", "path", "bodyJson"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_media_plan",
    description: "매체 세팅 변경안(생성·복제·수정·삭제)을 단계 묶음으로 만듭니다. 사용자가 확인 카드에서 승인하면 순서대로 실행되고, 실패하면 그 단계에서 멈춥니다. 뒤 단계에서 앞 단계 결과를 \"{{0.id}}\"처럼 참조할 수 있습니다(0부터 시작).\n규칙: 새로 만드는 캠페인·광고그룹·광고는 기본적으로 꺼진 상태(PAUSED/userLock true)로 만드세요(사용자가 켜라고 한 경우 제외). 먼저 media_api_get으로 기존 구조를 확인하고 정확한 필드로 요청하세요.\n- meta: 예산(daily_budget·lifetime_budget)은 통화 최소 단위입니다. KRW 계정은 원 단위 그대로 넣으세요(30만 원 → 300000, ×100 금지). 쓰기는 POST {경로} + form 필드(bodyJson의 객체 값은 JSON으로 전송). 예) 소재 복제 POST {광고ID}/copies {\"adset_id\":\"...\",\"status_option\":\"PAUSED\",\"rename_options\":{\"rename_suffix\":\" - 복사본\"}}, 수정 POST {객체ID} {필드}, 생성 POST act_{계정}/campaigns|adsets|ads|adcreatives.\n- google_ads: POST customers/{계정}/{리소스}:mutate {\"operations\":[...]} (campaignBudgets, campaigns, adGroups, adGroupAds, adGroupCriteria 등).\n- naver_sa: POST /ncc/campaigns|adgroups|keywords?nccAdgroupId=|ads, PUT /ncc/{리소스}/{id}?fields=... (변경 필드만 fields에).\n- naver_gfa: 항목 경로(/adSets/{no})는 수정(PUT/PATCH)이 안 됩니다. 광고세트 수정은 POST /adAccounts/{계정}/adSets/edit (GET으로 받은 광고세트 객체를 고쳐서 전송, 예산은 budgetAmount), ON/OFF는 set_status 도구를 쓰세요. 생성은 POST /adAccounts/{계정}/campaigns|adSets.",

    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "사용자에게 보여줄 한 줄 요약 (무엇을 어디에 만드는지/바꾸는지)" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta", "google_ads"] },
              accountId: { type: "string" },
              method: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"] },
              path: { type: "string" },
              bodyJson: { type: "string", description: "요청 본문 JSON 문자열, 없으면 빈 문자열" },
              note: { type: "string", description: "이 단계가 하는 일 (한국어)" },
            },
            required: ["channel", "accountId", "method", "path", "bodyJson", "note"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "steps"],
      additionalProperties: false,
    },
  },
  {
    name: "market_keywords",
    description: "네이버 키워드도구: 키워드(최대 5개)의 연관 키워드와 월간 검색수(PC/모바일), 월평균 클릭수, CTR, 경쟁도를 조회합니다. 키워드 확장·시장 규모 파악에 씁니다.",

    input_schema: { type: "object", properties: { keywords: { type: "array", items: { type: "string" } } }, required: ["keywords"], additionalProperties: false },
  },
  {
    name: "market_trend",
    description: "네이버 검색어 트렌드: 키워드 그룹(최대 5개)의 기간별 상대 검색량(최대값=100)을 비교합니다. 시즌성·경쟁 브랜드 관심도 비교에 씁니다.",

    input_schema: {
      type: "object",
      properties: {
        groups: { type: "array", items: { type: "object", properties: { name: { type: "string" }, keywords: { type: "array", items: { type: "string" } } }, required: ["name", "keywords"], additionalProperties: false } },
        startDate: { type: "string", description: "YYYY-MM-DD (2016-01-01 이후)" },
        endDate: { type: "string", description: "YYYY-MM-DD" },
        timeUnit: { type: "string", enum: ["date", "week", "month"] },
      },
      required: ["groups", "startDate", "endDate", "timeUnit"],
      additionalProperties: false,
    },
  },
  {
    name: "market_content",
    description: "네이버 뉴스·블로그·카페 검색 결과(제목·요약·링크·날짜)를 가져옵니다. 시장 이슈, 소비자 반응, 경쟁사 동향 파악에 씁니다.",

    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["news", "blog", "cafearticle"] },
        query: { type: "string" },
        sort: { type: "string", enum: ["sim", "date"] },
      },
      required: ["type", "query", "sort"],
      additionalProperties: false,
    },
  },
  {
    name: "market_shopping",
    description: "네이버 쇼핑인사이트: 쇼핑 카테고리(최대 3개)의 기간별 클릭 추이(최대값=100). 카테고리 ID 예: 50000000 패션의류, 50000001 패션잡화, 50000002 화장품/미용, 50000003 디지털/가전, 50000004 가구/인테리어, 50000005 출산/육아, 50000006 식품, 50000007 스포츠/레저, 50000008 생활/건강, 50000009 여가/생활편의.",

    input_schema: {
      type: "object",
      properties: {
        categories: { type: "array", items: { type: "object", properties: { name: { type: "string" }, id: { type: "string" } }, required: ["name", "id"], additionalProperties: false } },
        startDate: { type: "string" }, endDate: { type: "string" }, timeUnit: { type: "string", enum: ["date", "week", "month"] },
      },
      required: ["categories", "startDate", "endDate", "timeUnit"],
      additionalProperties: false,
    },
  },
  {
    name: "update_budget",
    description: "캠페인 또는 광고그룹의 일예산 변경안을 생성합니다. 실제 변경은 사용자의 별도 승인이 필요합니다.",

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

export type MixLineSummary = { month: string; lines: Array<{ line: string; channel: string; budget: number; targetRoas: number; spend: number; roas: number; campaigns: string[] }>; unassigned: { count: number; spend: number } };
export type AssistantContext = { advertiserId?: string; advertiserName?: string; accountKeys: string[]; mixes?: MediaMix[]; mixLineSummary?: MixLineSummary };

const inScope = (ctx: AssistantContext, campaign: { channel: Channel; accountId?: string }) =>
  !ctx.accountKeys.length || ctx.accountKeys.includes(`${campaign.channel}:${campaign.accountId}`);

export async function executeAssistantTool(name: string, input: ToolInput, ctx: AssistantContext = { accountKeys: [] }): Promise<{ result: unknown; pending?: PendingAction; mixDraft?: MediaMix }> {
  const adapter = getAdapter();
  if (name === "get_mixes") return { result: {
    mixes: (ctx.mixes || []).map(({ month, status, targetRoas, channels, notes, review, lines }) => ({ month, status, targetRoas, channels, notes, review, lines: lines?.map((l) => ({ name: l.name, channel: l.channel, budget: l.budget, targetRoas: l.targetRoas, keywords: l.keywords })) })),
    // 이번 달 라인별 실적은 화면에서 이미 계산된 값 (캠페인 ID 목록 포함 → update_budget에 바로 사용 가능)
    currentMonthLines: ctx.mixLineSummary,
  } };
  if (name === "propose_mix") {
    if (!ctx.advertiserId) return { result: { error: "광고주가 선택되지 않았습니다." } };
    const existing = ctx.mixes?.find((mix) => mix.month === input.month);
    const channels = Object.fromEntries(((input.channels as any[]) || []).map((c) => [c.channel, { budget: c.budget, targetRoas: c.targetRoas, note: c.note }]));
    const mixDraft = sanitizeMix({ id: existing?.id, advertiserId: ctx.advertiserId, month: input.month, status: "draft", targetRoas: input.targetRoas, notes: input.notes, channels, lines: input.lines, review: existing?.review, createdAt: existing?.createdAt });
    if (!mixDraft) return { result: { error: "month는 YYYY-MM 형식이어야 합니다." } };
    return { result: { status: "pending_user_confirmation", month: mixDraft.month, totalBudget: Object.values(mixDraft.channels).reduce((s, c) => s + (c?.budget || 0), 0) }, mixDraft };
  }
  if (name === "list_campaigns") {
    const rows = (await adapter.listCampaigns(input.channel as Channel | undefined, Boolean(input.includeOff)))
      .filter((row) => inScope(ctx, row) && (input.includeOff || (row.active ?? row.status === "on")));
    // 모델 컨텍스트를 아끼기 위해 필요한 필드만, 광고비 순 상위 150개
    const slim = rows.sort((a, b) => b.spend - a.spend).slice(0, 150).map((row) => ({ id: row.id, channel: row.channel, account: row.accountName, name: row.name, dailyBudget: row.dailyBudget, status: row.status, spend: Math.round(row.spend), conversions: row.conversions, roas: row.roas }));
    return { result: { total: rows.length, shown: slim.length, campaigns: slim } };
  }
  if (name === "media_api_get") {
    const body = parseJsonArg(input.bodyJson);
    const isGaql = input.channel === "google_ads" && body && typeof body === "object" && "query" in (body as object);
    const step = { channel: input.channel as Channel, accountId: String(input.accountId).replace(/[^0-9]/g, ""), method: (isGaql ? "POST" : "GET") as "GET" | "POST", path: String(input.path), body };
    if (isGaql && !/googleAds:search(Stream)?$/.test(step.path.split("?")[0])) return { result: { error: "Google 조회는 customers/{계정}/googleAds:search 경로만 가능합니다." } };
    await assertMediaScope(step, ctx.accountKeys);
    const raw = JSON.stringify(await executeMediaStep(step));
    return { result: raw.length > 12000 ? `${raw.slice(0, 12000)}… (잘림: 전체 ${raw.length}자, 필드를 좁혀 다시 조회하세요)` : JSON.parse(raw) };
  }
  if (name === "propose_media_plan") {
    const steps = ((input.steps as any[]) || []).slice(0, 30).map((s) => ({ channel: s.channel as Channel, accountId: String(s.accountId).replace(/[^0-9]/g, ""), method: s.method, path: String(s.path), body: parseJsonArg(s.bodyJson), note: String(s.note || "") }));
    if (!steps.length) return { result: { error: "단계가 없습니다." } };
    // 승인 전에 계정 범위를 미리 확인 (앞 단계 결과를 참조하는 경로는 실행 시점에 다시 확인)
    for (const step of steps) if (!step.path.includes("{{")) await assertMediaScope(step, ctx.accountKeys);
    const pending = createPendingAction(String(input.summary || "매체 세팅"), { kind: "media_plan", channel: steps[0].channel, summary: String(input.summary || ""), steps, accountKeys: ctx.accountKeys },
      steps.map((step, i) => ({ targetId: `${i}`, targetName: `${i + 1}. ${step.note}`, field: `${step.method} ${step.channel}`, before: step.path, after: step.body === undefined ? "" : JSON.stringify(step.body).slice(0, 600) })));
    return { result: { status: "pending_user_confirmation", steps: steps.length, pendingId: pending.id }, pending };
  }
  if (name === "market_keywords") return { result: await keywordStats((input.keywords as string[]) || []) };
  if (name === "market_trend") return { result: await searchTrend((input.groups as TrendGroup[]) || [], String(input.startDate), String(input.endDate), input.timeUnit as "month") };
  if (name === "market_content") return { result: await searchContent(input.type as ContentType, String(input.query), 10, input.sort as "sim") };
  if (name === "market_shopping") return { result: await shoppingInsight((input.categories as Array<{ name: string; id: string }>) || [], String(input.startDate), String(input.endDate), input.timeUnit as "month") };
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

function parseJsonArg(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { throw new Error("bodyJson이 올바른 JSON이 아닙니다."); }
}
