// 무료 LLM(기본: Google Gemini, OpenAI 호환 엔드포인트)으로 "조회만" 하는 어시스턴트.
// 변경(예산·ON/OFF·세팅·믹스 초안)이 필요하면 escalate_to_claude 를 호출해 Claude 쪽으로 넘긴다.
// 환경변수: FREE_LLM_API_KEY(또는 GEMINI_API_KEY) · 선택: FREE_LLM_BASE_URL, FREE_LLM_MODEL, FREE_LLM_LABEL
import { assistantTools, executeAssistantTool, type AssistantContext } from "@/lib/assistant-tools";

const READ_TOOLS = new Set(["list_campaigns", "list_adgroups", "list_ads", "get_stats", "get_report", "get_mixes", "media_api_get", "market_keywords", "market_trend", "market_content", "market_shopping"]);

export function freeLlmConfig() {
  const key = process.env.FREE_LLM_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) return null;
  const base = (process.env.FREE_LLM_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, "");
  const model = process.env.FREE_LLM_MODEL || "gemini-2.5-flash";
  const label = process.env.FREE_LLM_LABEL || (base.includes("groq") ? "Groq" : base.includes("googleapis") ? "Gemini" : "무료 모델");
  return { key, base, model, label };
}

// Gemini 의 OpenAI 호환 스키마는 일부 키워드를 받지 않는다 → 단순화
function cleanSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (["additionalProperties", "$schema", "strict", "examples", "default"].includes(k)) continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

const TOOLS = [
  ...(assistantTools as unknown as any[]).filter((t) => READ_TOOLS.has(t.name)).map((t) => ({ type: "function", function: { name: t.name, description: String(t.description || "").slice(0, 1000), parameters: cleanSchema(t.input_schema) } })),
  { type: "function", function: { name: "escalate_to_claude", description: "사용자가 광고를 바꾸는 작업(예산 변경, ON/OFF, 캠페인·광고·소재 생성/복제/수정, 믹스 초안 저장, 예산 조정안)을 요청했거나, 조회 도구로는 답할 수 없는 복잡한 분석이면 호출하세요. 직접 바꾸려 하지 말고 이 도구만 호출합니다.", parameters: { type: "object", properties: { reason: { type: "string", description: "넘기는 이유 한 줄" } }, required: ["reason"] } } },
];

const SYSTEM = `당신은 광고대행사 대시보드의 "조회 전용" 어시스턴트입니다. 채널: 네이버 SA(naver_sa), 네이버 GFA(naver_gfa), Meta(meta), Google Ads(google_ads).
- 성과·캠페인·믹스·시장 질문은 도구로 실제 데이터를 조회해 답하세요. 숫자를 지어내지 마세요.
- 당신은 광고를 바꿀 수 없습니다. 예산 변경, ON/OFF, 생성·복제·수정, 믹스 초안 저장, 예산 조정안 요청이면 escalate_to_claude 를 호출하세요.
- 금액은 KRW, ROAS = 매출÷광고비×100(%). 답은 간결한 한국어, 비교는 마크다운 표로.
- 마지막 [현재 화면] 줄의 광고주 기준으로 답하세요.`;

type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: any[]; tool_call_id?: string };

export async function runFreeAssistant(history: Array<{ role: "user" | "assistant"; content: string }>, screenLine: string, ctx: AssistantContext, signal: AbortSignal, deadlineMs: number):
  Promise<{ kind: "answer"; text: string; usage: { input: number; output: number; cached: number }; label: string } | { kind: "escalate"; reason: string }> {
  const cfg = freeLlmConfig();
  if (!cfg) return { kind: "escalate", reason: "무료 모델 키 없음" };
  const messages: Msg[] = [{ role: "system", content: SYSTEM }, ...history.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: screenLine }];
  const usage = { input: 0, output: 0, cached: 0 };
  for (let step = 0; step < 8; step++) {
    if (Date.now() > deadlineMs) return { kind: "escalate", reason: "무료 모델 시간 초과" };
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(5_000, deadlineMs - Date.now()))]),
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, messages, tools: TOOLS, tool_choice: "auto", temperature: 0.2 }),
    });
    const text = await res.text();
    let body: any; try { body = JSON.parse(text); } catch { body = {}; }
    if (!res.ok) return { kind: "escalate", reason: `무료 모델 오류(${res.status}): ${String(body?.error?.message || body?.[0]?.error?.message || text).slice(0, 160)}` };
    usage.input += Number(body.usage?.prompt_tokens) || 0; usage.output += Number(body.usage?.completion_tokens) || 0;
    const msg = body.choices?.[0]?.message || {};
    const calls: any[] = msg.tool_calls || [];
    if (!calls.length) return { kind: "answer", text: String(msg.content || "").trim() || "답변을 만들지 못했어요.", usage, label: cfg.label };
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const call of calls) {
      const name = call.function?.name;
      let args: any = {}; try { args = JSON.parse(call.function?.arguments || "{}"); } catch { args = {}; }
      if (name === "escalate_to_claude") return { kind: "escalate", reason: String(args.reason || "변경 요청") };
      let content: string;
      if (!READ_TOOLS.has(name)) content = JSON.stringify({ error: "조회 전용 모드입니다. 변경은 escalate_to_claude 를 호출하세요." });
      else {
        try { content = JSON.stringify((await executeAssistantTool(name, args, ctx)).result); }
        catch (e) { content = JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: content.slice(0, 20_000) });
    }
  }
  return { kind: "escalate", reason: "단계가 많아 Claude로 넘김" };
}
