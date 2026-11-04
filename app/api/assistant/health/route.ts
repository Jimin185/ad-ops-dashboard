import Anthropic from "@anthropic-ai/sdk";
import { assistantTools } from "@/lib/assistant-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 진단용: API 키·모델·도구 스키마를 아주 작은 요청으로 확인한다. (/api/assistant/health)
export async function GET(request: Request) {
  const model = new URL(request.url).searchParams.get("model") || "claude-opus-5-5";
  const withTools = new URL(request.url).searchParams.get("tools") !== "0";
  const started = Date.now();
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model, max_tokens: 64,
      ...(withTools ? { tools: assistantTools as any } : {}),
      messages: [{ role: "user", content: "ping" }],
    });
    return Response.json({ ok: true, model, withTools, ms: Date.now() - started, stop: response.stop_reason, keyPresent: Boolean(process.env.ANTHROPIC_API_KEY) });
  } catch (error: any) {
    return Response.json({ ok: false, model, withTools, ms: Date.now() - started, status: error?.status, error: error?.message, keyPresent: Boolean(process.env.ANTHROPIC_API_KEY) });
  }
}
