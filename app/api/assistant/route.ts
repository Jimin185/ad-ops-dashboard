import { withNaverSaAccounts } from "@/lib/naver-sa-registry";
import Anthropic from "@anthropic-ai/sdk";
import { freeLlmConfig, runFreeAssistant } from "@/lib/free-llm";
import { assistantTools, executeAssistantTool, type AssistantContext, type MixLineSummary } from "@/lib/assistant-tools";
import type { MediaMix } from "@/lib/mix";
import type { PendingAction } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

type ClientMessage = { role: "user" | "assistant"; content: string };
type Continuation = { messages: Anthropic.Beta.BetaMessageParam[]; pendingActions: PendingAction[]; mixDrafts: MediaMix[]; usage: { input: number; output: number; cached: number }; step: number };

function seoulDate() {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "full" }).format(new Date());
}

const SYSTEM_PROMPT = `당신은 광고대행사의 광고 운영 어시스턴트입니다. 사용 가능한 채널은 네이버 SA(naver_sa), 네이버 GFA(naver_gfa), Meta(meta), Google Ads(google_ads)입니다.
대화 마지막의 [현재 화면] 줄에 선택된 광고주가 적혀 있고, 모든 도구는 그 광고주에 매핑된 계정만 다룹니다.
- 조회 요청은 적절한 도구로 바로 수행하세요. 성과 질문은 get_report, 캠페인 단위는 list_campaigns를 씁니다.
- 변경 요청은 먼저 목록을 조회해 정확한 ID와 현재값을 확인한 뒤 변경 도구를 호출하세요. 변경 도구 결과가 pending_user_confirmation이면 아직 적용되지 않았으니 확인 카드에서 적용하라고 안내하세요.
- 이름이 겹치거나 의도가 모호하면 임의로 고르지 말고 물어보세요.
- 금액은 별도 언급이 없으면 KRW입니다. 일예산과 월예산을 구분하세요. ROAS는 매출÷광고비×100(%)입니다.
- 사용자가 믹스 파일(엑셀·CSV·PDF)을 첨부하면 내용을 읽고 propose_mix로 해당 월 믹스 초안을 올리세요. 라인별 매칭 키워드도 함께 제안하면 좋습니다.
- 월별 미디어 믹스: get_mixes로 기존 믹스와 회고를, get_report로 실적을 확인한 뒤 propose_mix로 초안을 올리세요. 초안은 사용자가 카드에서 확인해야 저장됩니다.
- 믹스 대비 성과·예산 조정은 get_mixes의 currentMonthLines(라인별 집행액·ROAS·연결 캠페인 ID)를 먼저 쓰세요. 이미 계산된 값이라 캠페인 전체 조회가 필요 없습니다.
- 믹스대로 예산을 맞추는 요청은 (라인 월예산 - 집행액) ÷ 남은 일수를 라인의 운영 중 캠페인에 나눠 일예산 변경안(update_budget)으로 만드세요. Google Ads 예산 변경은 아직 지원되지 않으니 안내만 하세요.
- 매체 세팅(캠페인·광고그룹·소재 생성/복제/수정, 타겟·입찰·키워드 변경)은 모든 매체에서 가능합니다. 전용 도구(update_budget, set_status)로 되는 건 그걸 쓰고, 나머지는 media_api_get으로 구조를 확인한 뒤 propose_media_plan으로 단계 묶음을 올리세요. "할 수 없다"고 답하기 전에 반드시 이 방법을 검토하세요.
- 새로 만드는 항목은 사용자가 켜라고 하지 않는 한 꺼진 상태로 만드세요. 삭제는 사용자가 명시적으로 요청한 경우만 하세요.
- 승인 후 실행 결과(생성된 ID 등)는 대화에 표시됩니다. 실패하면 오류 메시지를 보고 수정한 변경안을 다시 올리세요.
- 키워드·시장 상황 질문(검색량, 트렌드, 시즌성, 소비자 반응, 경쟁사 동향)은 market_keywords, market_trend, market_content, market_shopping으로 실제 데이터를 찾아 답하세요. 광고주가 선택되지 않아도 쓸 수 있습니다. 출처 링크를 함께 보여주세요.
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
  let freeFallback: ((note: string) => Promise<Response | null>) | null = null;
  try {
    const started = Date.now();
    const body = (await request.json()) as { mode?: "auto" | "claude"; continuation?: Continuation; attachments?: Array<{ name: string; kind: "text" | "pdf" | "image"; data: string; mediaType?: string }>; messages?: ClientMessage[]; context?: { advertiserId?: string; advertiserName?: string; accountKeys?: string[]; mixes?: MediaMix[]; mixLineSummary?: MixLineSummary } };
    const cont = body.continuation;
    const history = (body.messages || []).slice(-20);
    if (!history.length && !cont?.messages?.length) return Response.json({ error: "메시지를 입력해 주세요." }, { status: 400 });
    const ctx: AssistantContext = { advertiserId: body.context?.advertiserId, advertiserName: body.context?.advertiserName, accountKeys: (body.context?.accountKeys || []).slice(0, 50), mixes: (body.context?.mixes || []).slice(0, 12), mixLineSummary: body.context?.mixLineSummary };

    // 1) 조회 질문은 무료 모델이 먼저 답한다. 변경 요청·첨부·오류면 Claude로 넘긴다.
    const screenLine = `[현재 화면] 광고주: ${ctx.advertiserName || "미선택"} · 매핑 계정 ${ctx.accountKeys.length}개 · 오늘(KST): ${seoulDate()}`;
    let escalated = "";
    // 표·텍스트 첨부(CSV·엑셀 변환본)는 무료 모델에도 넣어 준다. PDF·이미지는 Claude만 읽는다.
    const textFiles = (body.attachments || []).filter((f) => f.kind === "text");
    const freeHistory = textFiles.length && history.length ? [...history.slice(0, -1), { ...history[history.length - 1], content: `${textFiles.map((f) => `[첨부 파일: ${f.name}]\n${String(f.data).slice(0, 40_000)}`).join("\n\n")}\n\n${history[history.length - 1].content}` }] : history;
    if (!cont && freeLlmConfig() && !(body.attachments || []).some((f) => f.kind !== "text") && body.mode !== "claude") {
      const free = await runFreeAssistant(freeHistory, screenLine, ctx, request.signal, started + (textFiles.length ? 52_000 : 40_000)).catch((e) => ({ kind: "escalate" as const, reason: String(e).slice(0, 120) }));
      if (request.signal.aborted) return new Response(null, { status: 499 });
      if (free.kind === "answer") return Response.json({ message: free.text, pendingActions: [], mixDrafts: free.mixDrafts, usage: free.usage, model: free.label });
      escalated = free.reason;
    }
    // Claude를 쓸 수 없으면(키 없음·한도 초과) 무료 모델이 계산·안내까지만 하고 답한다.
    const freeOnly = async (note: string) => {
      const r = await runFreeAssistant(freeHistory, screenLine, ctx, request.signal, Math.min(Date.now() + 40_000, started + 55_000), false).catch(() => null);
      if (r?.kind === "answer") return Response.json({ message: `${r.text}\n\n_${note}_`, pendingActions: [], mixDrafts: r.mixDrafts, usage: r.usage, model: r.label });
      return null;
    };
    if (!cont && freeLlmConfig()) freeFallback = freeOnly;
    if (!process.env.ANTHROPIC_API_KEY) {
      if (!cont && freeLlmConfig()) { const r = await freeOnly("변경 실행은 Claude 키가 없어 안내만 드렸어요."); if (r) return r; }
      return Response.json({ error: "API 키 등록 필요", code: "ANTHROPIC_API_KEY_REQUIRED" }, { status: 503 });
    }
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const messages: Anthropic.Beta.BetaMessageParam[] = cont?.messages?.length ? cont.messages : history.map((message) => ({ role: message.role, content: message.content }));
    // 이번 메시지에 붙은 첨부 파일: 표·텍스트는 텍스트로, PDF·이미지는 Claude가 직접 읽게 넣는다
    const files = (body.attachments || []).slice(0, 5);
    if (!cont && files.length && messages.length && messages[messages.length - 1].role === "user") {
      const last = messages[messages.length - 1];
      const blocks: any[] = [];
      for (const f of files) {
        if (f.kind === "text") blocks.push({ type: "text", text: `[첨부 파일: ${f.name}]\n${String(f.data).slice(0, 60_000)}` });
        else if (f.kind === "pdf") blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data }, title: f.name });
        else if (f.kind === "image" && /^image\/(png|jpeg|webp|gif)$/.test(f.mediaType || "")) blocks.push({ type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data } });
      }
      blocks.push({ type: "text", text: String(last.content) });
      messages[messages.length - 1] = { role: "user", content: blocks };
    }
    // 현재 화면의 광고주 정보는 매 요청 바뀌므로 캐시되는 system 프롬프트가 아니라 대화 끝에 붙인다.
    if (!cont) messages.push({ role: "user", content: screenLine });
    const pendingActions: PendingAction[] = cont?.pendingActions || [];
    const mixDrafts: MediaMix[] = cont?.mixDrafts || [];
    let finalText = "";
    const usage = cont?.usage || { input: 0, output: 0, cached: 0 };
    const firstStep = cont?.step || 0;
    // Vercel 함수는 60초에 끊긴다. 시간이 모자라면 지금까지의 대화를 돌려주고 브라우저가 이어서 다시 부른다.
    const pause = (step: number) => Response.json({ continue: { messages, pendingActions, mixDrafts, usage, step } satisfies Continuation, usage });

    // 사용자가 중지를 누르면(연결 끊김) 다음 단계로 넘어가지 않고, 진행 중인 Claude 호출도 취소한다.
    for (let iteration = firstStep; iteration < 16; iteration += 1) {
      if (request.signal.aborted) return new Response(null, { status: 499 });
      const elapsed = Date.now() - started;
      if (iteration > firstStep && elapsed > 30_000) return pause(iteration);
      const callTimeout = AbortSignal.timeout(Math.max(5_000, 55_000 - elapsed));
      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await anthropic.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: assistantTools as any,
        messages,
      }, { signal: AbortSignal.any([request.signal, callTimeout]) });
      } catch (error) {
        // 이 단계의 Claude 호출만 시간이 모자랐다: 사용자가 중지한 게 아니면 새 요청에서 이 단계부터 다시 한다.
        if (!request.signal.aborted && callTimeout.aborted) return pause(iteration);
        throw error;
      }

      usage.input += response.usage.input_tokens; usage.output += response.usage.output_tokens; usage.cached += response.usage.cache_read_input_tokens || 0;
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

    return Response.json({ message: finalText || "처리가 완료되었습니다.", pendingActions, mixDrafts, usage, model: "Claude" });
  } catch (error) {
    if (request.signal.aborted || error instanceof Anthropic.APIUserAbortError) return new Response(null, { status: 499 });
    if (error instanceof Anthropic.AuthenticationError) return Response.json({ error: "Claude API 키가 유효하지 않습니다. Vercel의 ANTHROPIC_API_KEY를 새 키로 교체해 주세요." }, { status: 503 });
    if (/credit|billing|quota|rate.?limit/i.test(error instanceof Error ? error.message : "") && freeLlmConfig() && freeFallback) {
      const r = await freeFallback("Claude 사용 한도에 도달해 무료 모델이 계산·안내만 드렸어요. 변경은 캠페인 표 버튼으로 적용해 주세요.").catch(() => null);
      if (r) return r;
    }
    return Response.json({ error: friendlyError(error) }, { status: 500 });
  }
}
