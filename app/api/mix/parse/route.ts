import Anthropic from "@anthropic-ai/sdk";
import { sanitizeLines } from "@/lib/mix";

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
- 맞는 캠페인이 없으면 keywords는 빈 배열로 두세요. 지어내지 마세요.`;

const SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          channel: { type: "string", enum: ["naver_sa", "naver_gfa", "meta", "google_ads", "all"] },
          budget: { type: "integer" },
          targetRoas: { type: "integer" },
          note: { type: "string" },
          keywords: { type: "array", items: { type: "string" } },
          excludes: { type: "array", items: { type: "string" } },
        },
        required: ["name", "channel", "budget", "targetRoas", "note", "keywords", "excludes"],
        additionalProperties: false,
      },
    },
  },
  required: ["lines"],
  additionalProperties: false,
};

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "Claude API 키가 설정되지 않았습니다." }, { status: 503 });
  try {
    const body = (await request.json()) as { text?: string; lines?: unknown[]; campaigns?: Array<{ channel: string; name: string }> };
    const names = [...new Set((body.campaigns || []).map((c) => `${c.channel}|${String(c.name).slice(0, 60)}`))].slice(0, 400);
    const task = body.lines?.length
      ? `아래 라인들의 keywords/excludes만 채워 그대로 돌려주세요 (이름·채널·예산·ROAS·메모는 유지).\n${JSON.stringify(body.lines).slice(0, 6000)}`
      : `붙여넣은 믹스:\n${String(body.text || "").slice(0, 6000)}`;
    if (!body.lines?.length && !String(body.text || "").trim()) return Response.json({ error: "붙여넣은 내용이 없습니다." }, { status: 400 });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 8000,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `운영 중 캠페인(채널|이름):\n${names.join("\n")}\n\n${task}` }],
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
