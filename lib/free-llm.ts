// 무료 LLM(기본: Google Gemini, OpenAI 호환 엔드포인트)으로 "조회만" 하는 어시스턴트.
// 변경(예산·ON/OFF·세팅·믹스 초안)이 필요하면 escalate_to_claude 를 호출해 Claude 쪽으로 넘긴다.
// 환경변수: FREE_LLM_API_KEY(또는 GEMINI_API_KEY) · 선택: FREE_LLM_BASE_URL, FREE_LLM_MODEL, FREE_LLM_LABEL
import { assistantTools, executeAssistantTool, type AssistantContext } from "@/lib/assistant-tools";
import type { MediaMix } from "@/lib/mix";

const READ_TOOLS = new Set(["list_campaigns", "list_adgroups", "list_ads", "get_stats", "get_report", "get_mixes", "media_api_get", "market_keywords", "market_trend", "market_content", "market_shopping", "propose_mix"]);
// propose_mix 는 광고를 바꾸지 않고 "믹스 초안 카드"만 만든다(사용자가 확인해야 저장) → 무료 모델도 사용 가능

export function freeLlmConfig() {
  const key = process.env.FREE_LLM_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) return null;
  const base = (process.env.FREE_LLM_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, "");
  const model = process.env.FREE_LLM_MODEL || "gemini-3.8-flash";
  const label = process.env.FREE_LLM_LABEL || (base.includes("groq") ? "Groq" : base.includes("googleapis") ? "Gemini" : "무료 모델");
  const fallbacks = (process.env.FREE_LLM_FALLBACK_MODELS || (base.includes("googleapis") ? "gemini-3.7-flash,gemini-3.5-flash,gemini-flash-lite-latest" : "")).split(",").map((m) => m.trim()).filter((m) => m && m !== model);
  return { key, base, model, label, fallbacks };
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
  { type: "function", function: { name: "escalate_to_claude", description: "사용자가 광고를 '실제로 바꿔 달라'고 할 때만 호출하세요(예: '일예산 30만원으로 바꿔줘', '꺼줘', '캠페인 만들어줘'). 믹스 초안은 propose_mix 로 직접 만드세요(이 도구로 넘기지 않음). '얼마로 바꿔야 해?', '얼마 써야 해?', '계산해줘'처럼 숫자·방법을 묻는 질문은 직접 조회·계산해서 답하고 이 도구는 쓰지 마세요.", parameters: { type: "object", properties: { reason: { type: "string", description: "넘기는 이유 한 줄" } }, required: ["reason"] } } },
];

const SYSTEM = `당신은 광고대행사 대시보드의 어시스턴트입니다. 채널: 네이버 SA(naver_sa), 네이버 GFA(naver_gfa), Meta(meta), Google Ads(google_ads).
- 성과·캠페인·믹스·시장 질문은 도구로 실제 데이터를 조회해 답하세요. 숫자를 지어내지 마세요.
- 예산 계산·일예산 추천·소진 페이스 같은 질문은 직접 조회하고 계산해서 답하세요. 계산 과정(이번 달 누적 광고비, 남은 금액, 남은 일수)을 짧게 보여주세요.
- 믹스·목표 금액은 보통 '마크업 포함'입니다. 마크업 m%면 매체 집행액 = 금액 ÷ (1 + m/100). 일예산은 매체 집행액 기준으로 계산합니다(예: 600만 원, 마크업 14% → 매체 집행 약 526만 원).
- 남은 일수는 [현재 화면] 줄의 오늘 날짜를 포함해 이번 달 말일까지로 계산하세요.\n- '지금 페이스' = 어제까지 끝난 날의 일평균입니다. 이번 달 누적에는 진행 중인 오늘 사용분이 섞여 있으니 오늘을 하루로 세서 나누지 마세요. 가능하면 get_report 로 일자별 광고비를 받아 어제까지만 합산하고, 안 되면 (누적 ÷ (경과한 날 수 - 1)) 로 근사하고 그렇게 했다고 밝히세요.
- 당신은 광고를 직접 바꿀 수 없습니다. 사용자가 광고 예산·상태·세팅을 '바꿔줘·꺼줘·만들어줘'처럼 실행 요청할 때만 escalate_to_claude 를 호출하세요(믹스 초안은 propose_mix 로 직접).
- 금액은 KRW, ROAS = 매출÷광고비×100(%). 답은 간결한 한국어, 비교는 마크다운 표로.
- 사용자가 믹스·월예산 표(첨부 CSV/엑셀 등)를 주며 반영해 달라고 하면 propose_mix 로 해당 월 믹스 초안을 만드세요. 표의 각 행을 lines 로 넣고(name=믹스구분·캠페인, channel, budget=월예산 원 단위, keywords=[캠페인명 키워드]), 메모는 note 에 넣으세요. channels 는 매체별 합계입니다. 초안은 사용자가 카드에서 저장해야 반영됩니다.
- 캠페인 일예산 질문에는 get_mixes 의 라인 월예산(마크업 포함)과 이번 달 집행액을 써서 계산하세요.
- 마지막 [현재 화면] 줄의 광고주 기준으로 답하세요.`;
const NO_ESCALATE = `\n- 지금은 변경을 실행할 수 있는 모델이 없습니다. 변경 요청이면 바꿀 값과 이유를 계산해 알려주고, 대시보드 캠페인 표의 일예산·ON/OFF 버튼으로 직접 적용하라고 안내하세요.`;

type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: any[]; tool_call_id?: string };

export async function runFreeAssistant(history: Array<{ role: "user" | "assistant"; content: string }>, screenLine: string, ctx: AssistantContext, signal: AbortSignal, deadlineMs: number, allowEscalate = true):
  Promise<{ kind: "answer"; text: string; usage: { input: number; output: number; cached: number }; label: string; mixDrafts: MediaMix[] } | { kind: "escalate"; reason: string }> {
  const mixDrafts: MediaMix[] = [];
  const cfg = freeLlmConfig();
  if (!cfg) return { kind: "escalate", reason: "무료 모델 키 없음" };
  const messages: Msg[] = [{ role: "system", content: SYSTEM + (allowEscalate ? "" : NO_ESCALATE) }, ...history.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: screenLine }];
  const usage = { input: 0, output: 0, cached: 0 };
  for (let step = 0; step < 8; step++) {
    if (Date.now() > deadlineMs) return { kind: "escalate", reason: "무료 모델 시간 초과" };
    // 무료 등급은 혼잡(503)·한도(429)가 잦다 → 예비 모델로 한 번씩 더 시도
    let res: Response | null = null, text = "";
    for (const model of [cfg.model, ...cfg.fallbacks]) {
      res = await fetch(`${cfg.base}/chat/completions`, {
        method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(5_000, Math.min(20_000, deadlineMs - Date.now())))]),
        headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, tools: allowEscalate ? TOOLS : TOOLS.filter((t) => t.function.name !== "escalate_to_claude"), tool_choice: "auto", temperature: 0.2 }),
      }).catch(() => null);
      text = res ? await res.text() : "";
      if (res && ![429, 500, 503].includes(res.status)) break;
      if (Date.now() > deadlineMs) break;
    }
    if (!res) return { kind: "escalate", reason: "무료 모델 응답 없음" };
    let body: any; try { body = JSON.parse(text); } catch { body = {}; }
    if (!res.ok) return { kind: "escalate", reason: `무료 모델 오류(${res.status}): ${String(body?.error?.message || body?.[0]?.error?.message || text).slice(0, 160)}` };
    usage.input += Number(body.usage?.prompt_tokens) || 0; usage.output += Number(body.usage?.completion_tokens) || 0;
    const msg = body.choices?.[0]?.message || {};
    const calls: any[] = msg.tool_calls || [];
    if (!calls.length) return { kind: "answer", text: String(msg.content || "").trim() || "답변을 만들지 못했어요.", usage, label: cfg.label, mixDrafts };
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const call of calls) {
      const name = call.function?.name;
      let args: any = {}; try { args = JSON.parse(call.function?.arguments || "{}"); } catch { args = {}; }
      if (name === "escalate_to_claude") return { kind: "escalate", reason: String(args.reason || "변경 요청") };
      let content: string;
      if (!READ_TOOLS.has(name)) content = JSON.stringify({ error: "조회 전용 모드입니다. 변경은 escalate_to_claude 를 호출하세요." });
      else {
        try { const ex = await executeAssistantTool(name, args, ctx); if (ex.mixDraft) mixDrafts.push(ex.mixDraft); content = JSON.stringify(ex.result); }
        catch (e) { content = JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: content.slice(0, 20_000) });
    }
  }
  return { kind: "escalate", reason: "단계가 많아 Claude로 넘김" };
}
