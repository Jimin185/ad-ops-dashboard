import Anthropic from "@anthropic-ai/sdk";
import { assistantTools, executeAssistantTool } from "@/lib/assistant-tools";
import type { PendingAction } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

type ClientMessage = { role: "user" | "assistant"; content: string };

function seoulDate() {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "full" }).format(new Date());
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
  if (/credit|billing|quota|rate.?limit/i.test(message)) return "Claude API 사용 한도에 도달했습니다. 관리자에게 결제 또는 한도를 확인해 달라고 요청해 주세요.";
  return `요청을 처리하지 못했습니다: ${message}`;
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "API 키 등록 필요", code: "ANTHROPIC_API_KEY_REQUIRED" }, { status: 503 });
  }

  try {
    const body = (await request.json()) as { messages?: ClientMessage[] };
    const history = (body.messages || []).slice(-20);
    if (!history.length) return Response.json({ error: "메시지를 입력해 주세요." }, { status: 400 });

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const messages: any[] = history.map((message) => ({ role: message.role, content: message.content }));
    const pendingActions: PendingAction[] = [];
    let finalText = "";

    for (let iteration = 0; iteration < 10; iteration += 1) {
      const response: any = await anthropic.messages.create({
        model: "claude-opus-5",
        max_tokens: 4096,
        system: [
          {
            type: "text",
            text: `당신은 한국 광고 운영 어시스턴트입니다. 오늘은 ${seoulDate()}입니다. 사용 가능한 채널은 네이버 SA(naver_sa), 네이버 GFA(naver_gfa), Meta(meta), Google Ads(google_ads)입니다. 조회 요청은 적절한 도구로 즉시 수행하세요. 변경 요청은 반드시 먼저 목록을 조회해 정확한 ID와 현재값을 확인한 뒤 변경 도구를 호출하세요. 변경 도구의 결과가 pending_user_confirmation이면 실제 적용이 아니므로 사용자에게 확인 카드에서 적용하도록 안내하세요. 이름이 중복되거나 의도가 모호하면 임의로 선택하지 말고 질문하세요. 금액은 별도 언급이 없으면 KRW로 해석하되 일예산과 총예산을 구분하세요. 결과는 간결한 한국어로 답하고 비교 데이터는 마크다운 표를 사용하세요.`,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: assistantTools as any,
        messages,
      });

      messages.push({ role: "assistant", content: response.content });
      finalText = response.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
      if (response.stop_reason !== "tool_use") break;

      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        try {
          const executed = await executeAssistantTool(block.name, block.input);
          if (executed.pending) pendingActions.push(executed.pending);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(executed.result) });
        } catch (error) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: friendlyError(error) });
        }
      }
      messages.push({ role: "user", content: toolResults });
    }

    return Response.json({ message: finalText || "처리가 완료되었습니다.", pendingActions });
  } catch (error) {
    return Response.json({ error: friendlyError(error) }, { status: 500 });
  }
}
