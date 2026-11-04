import { withNaverSaAccounts } from "@/lib/naver-sa-registry";
import Anthropic from "@anthropic-ai/sdk";
import { assistantTools, executeAssistantTool, type AssistantContext } from "@/lib/assistant-tools";
import type { MediaMix } from "@/lib/mix";
import type { PendingAction } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

type ClientMessage = { role: "user" | "assistant"; content: string };

function seoulDate() {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "full" }).format(new Date());
}

const SYSTEM_PROMPT = `당신은 광고대행사의 광고 운영 어시스턴트입니다. 사용 가능한 채널은 네이버 SA(naver_sa), 네이버 GFA(naver_gfa), Meta(meta), Google Ads(google_ads)입니다.
대화 마지막의 [현재 화면] 줄에 선택된 광고주가 적혀 있고, 모든 도구는 그 광고주에 매핑된 계정만 다룹니다.
- 조회 요청은 적절한 도구로 바로 수행하세요. 성과 질문은 get_report, 캠페인 단위는 list_campaigns를 씁니다.
- 변경 요청은 먼저 목록을 조회해 정확한 ID와 현재값을 확인한 뒤 변경 도구를 호출하세요. 변경 도구 결과가 pending_user_confirmation이면 아직 적용되지 않았으니 확인 카드에서 적용하라고 안내하세요.
- 이름이 겹치거나 의도가 모호하면 임의로 고르지 말고 물어보세요.
- 금액은 별도 언급이 없으면 KRW입니다. 일예산과 월예산을 구분하세요. ROAS는 매출÷광고비×100(%)입니다.
- 월별 미디어 믹스: get_mixes로 기존 믹스와 회고를, get_report로 실적을 확인한 뒤 propose_mix로 초안을 올리세요. 초안은 사용자가 카드에서 확인해야 저장됩니다.
- 믹스대로 예산을 맞추는 요청은 믹스의 채널 월예산을 남은 일수로 나눠 캠페인 일예산 변경안(update_budget)으로 만드세요. Google Ads 예산 변경은 아직 지원되지 않으니 안내만 하세요.
- 소재 제작 요청에는 채널 규격에 맞는 카피 시안(헤드라인·설명·CTA)을 여러 안으로 제시하세요.
- 답은 간결한 한국어로, 비교 데이터는 마크다운 표로 보여주세요.`;

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
  if (/credit|billing|quota|rate.?limit/i.test(message)) return "Claude API 사용 한도에 도달했습니다. 관리자에게 결제 또는 한도를 확인해 달라고 요청해 주세요.";
  return `요청을 처리하지 못했습니다: ${message}`;
}

export async function POST(request: Request) {
  return withNaverSaAccounts(request, () => handle(request));
}

async function handle(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "API 키 등록 필요", code: "ANTHROPIC_API_KEY_REQUIRED" }, { status: 503 });
  }

  try {
    const body = (await request.json()) as { messages?: ClientMessage[]; context?: { advertiserId?: string; advertiserName?: string; accountKeys?: string[]; mixes?: MediaMix[] } };
    const history = (body.messages || []).slice(-20);
    if (!history.length) return Response.json({ error: "메시지를 입력해 주세요." }, { status: 400 });
    const ctx: AssistantContext = { advertiserId: body.context?.advertiserId, advertiserName: body.context?.advertiserName, accountKeys: (body.context?.accountKeys || []).slice(0, 50), mixes: (body.context?.mixes || []).slice(0, 24) };

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const messages: Anthropic.Beta.BetaMessageParam[] = history.map((message) => ({ role: message.role, content: message.content }));
    // 현재 화면의 광고주 정보는 매 요청 바뀌므로 캐시되는 system 프롬프트가 아니라 대화 끝에 붙인다.
    messages.push({ role: "user", content: `[현재 화면] 광고주: ${ctx.advertiserName || "미선택"} · 매핑 계정 ${ctx.accountKeys.length}개 · 오늘(KST): ${seoulDate()}` });
    const pendingActions: PendingAction[] = [];
    const mixDrafts: MediaMix[] = [];
    let finalText = "";

    for (let iteration = 0; iteration < 8; iteration += 1) {
      const response = await anthropic.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: assistantTools as any,
        messages,
      });

      messages.push({ role: "assistant", content: response.content as any });
      finalText = response.content.filter((block) => block.type === "text").map((block: any) => block.text).join("\n");
      if (response.stop_reason === "refusal") { finalText = finalText || "이 요청은 처리할 수 없습니다. 표현을 바꿔 다시 요청해 주세요."; break; }
      if (response.stop_reason !== "tool_use") break;

      const toolUses = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use");
      const toolResults = await Promise.all(toolUses.map(async (block) => {
        try {
          const executed = await executeAssistantTool(block.name, block.input as Record<string, unknown>, ctx);
          if (executed.pending) pendingActions.push(executed.pending);
          if (executed.mixDraft) mixDrafts.push(executed.mixDraft);
          return { type: "tool_result" as const, tool_use_id: block.id, content: JSON.stringify(executed.result) };
        } catch (error) {
          return { type: "tool_result" as const, tool_use_id: block.id, is_error: true, content: friendlyError(error) };
        }
      }));
      messages.push({ role: "user", content: toolResults });
    }

    return Response.json({ message: finalText || "처리가 완료되었습니다.", pendingActions, mixDrafts });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return Response.json({ error: "Claude API 키가 유효하지 않습니다. Vercel의 ANTHROPIC_API_KEY를 새 키로 교체해 주세요." }, { status: 503 });
    return Response.json({ error: friendlyError(error) }, { status: 500 });
  }
}
