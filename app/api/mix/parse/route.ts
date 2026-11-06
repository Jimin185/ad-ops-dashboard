import Anthropic from "@anthropic-ai/sdk";
import { sanitizeLines } from "@/lib/mix";
import { freeJson } from "@/lib/free-llm";

export const runtime = "nodejs";
export const maxDuration = 60;

// 믹스 붙여넣기 → 라인 + 캠페인 매칭 키워드. 표 형식은 브라우저에서 AI 없이 처리하고,
// 자유 형식이거나 키워드가 없는 라인만 여기로 온다. 토큰을 아끼기 위해 운영 중 캠페인 이름만 보낸다.
const SYSTEM = `광고 미디어 믹스 정리기입니다. 사용자가 붙여넣은 믹스(표·메모·엑셀 복사 등)를 라인 목록으로 정리하고,
각 라인을 실제 캠페인과 엮을 "이름 키워드"를 고릅니다.
- channel: naver_sa(네이버 검색/SA/파워링크/브랜드검색), naver_gfa(GFA/성과형 디스플레이), meta(메타/페이스북/인스타), google_ads(구글/유튜브/PMax), 불명확하면 all
- budget: 월 예산 KRW 정수 (1,500만 → 15000000). targetRoas: % 정수, 없으면 0
- keywords: 아래 캠페인 이름들에 실제로 들어 있는 짧은 문자열 1~3개. 그 라인의 캠페인만 걸리도록 고르세요. 공백 무시, 대소문자 무시로 부분일치합니다.
- excludes: 다른 라인 캠페인이 잘못 걸릴 때만 넣으세요.
- 맞는 캠페인이 없으면 keywords는 빈 배열로 두세요. 지어내지 마세요.
- source: 원본 믹스 표에서 이 라인 행의 칸들(열 이름과 값, 예: 아젠다·상품·기간·목적·타겟·소구점). 금액 열은 빼고 원본 표기 그대로, 최대 10개.
- group: 믹스구분(시트 이름·캠페인 묶음·대분류 예: '27Y 학생방', '온크쇼'). 모르면 빈 문자열.
- 월별 열이 여러 개인 믹스면 '대상 월' 금액만 쓰세요. 소계·합계·총계 행은 넣지 마세요. 대시보드에 없는 매체(버티컬 앱·카카오·NOSP·TV 등)는 빼세요.`;

const SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          group: { type: "string" },
          source: { type: "array", items: { type: "object", properties: { column: { type: "string" }, value: { type: "string" } }, required: ["column", "value"], additionalProperties: false } },
          channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta", "google_ads", "all"] },
          budget: { type: "integer" },
          targetRoas: { type: "integer" },
          note: { type: "string" },
          keywords: { type: "array", items: { type: "string" } },
          excludes: { type: "array", items: { type: "string" } },
        },
        required: ["name", "group", "channel", "budget", "targetRoas", "note", "keywords", "excludes"],
        additionalProperties: false,
      },
    },
  },
  required: ["lines"],
  additionalProperties: false,
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { text?: string; lines?: unknown[]; month?: string; campaigns?: Array<{ channel: string; name: string }> };
    const names = [...new Set((body.campaigns || []).map((c) => `${c.channel}|${String(c.name).slice(0, 60)}`))].slice(0, 400);
    const task = body.lines?.length
      ? `아래 라인들의 keywords/excludes만 채워 (source 는 그대로) 같은 순서·같은 개수로 그대로 돌려주세요 (이름·믹스구분·채널·예산·ROAS·메모는 유지).\n${JSON.stringify(body.lines).slice(0, 20000)}`
      : `대상 월: ${/^\d{4}-\d{2}$/.test(String(body.month)) ? body.month : "표에 있는 달"}\n붙여넣은 믹스:\n${String(body.text || "").slice(0, 30000)}`;
    if (!body.lines?.length && !String(body.text || "").trim()) return Response.json({ error: "붙여넣은 내용이 없습니다." }, { status: 400 });

    const prompt = `운영 중 캠페인(채널|이름):\n${names.join("\n")}\n\n${task}`;
    // 무료 모델(Gemini)을 먼저 쓰고, 안 되면 Claude
    const free = await freeJson(SYSTEM, prompt, SCHEMA).catch(() => null);
    if (free && Array.isArray(free.data?.lines)) return Response.json({ lines: sanitizeLines(free.data.lines), usage: free.usage, model: free.label });
    if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "무료 모델 응답이 없고 Claude API 키도 없습니다. 잠시 후 다시 시도해 주세요." }, { status: 503 });
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 8000,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt }],
    });
    if (response.stop_reason === "refusal") return Response.json({ error: "요청을 처리할 수 없습니다." }, { status: 422 });
    const text = response.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
    const parsed = JSON.parse(text);
    return Response.json({ lines: sanitizeLines(parsed.lines), usage: { input: response.usage.input_tokens, output: response.usage.output_tokens } });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return Response.json({ error: "Claude API 키가 유효하지 않습니다." }, { status: 503 });
    return Response.json({ error: error instanceof Error ? error.message : "믹스를 정리하지 못했습니다." }, { status: 500 });
  }
}
