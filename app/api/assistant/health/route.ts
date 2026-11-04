import Anthropic from "@anthropic-ai/sdk";
import { assistantTools } from "@/lib/assistant-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMP diagnostic: checks the API key, model, and tool schemas with a tiny request.
export async function GET(request: Request) {
  const model = new URL(request.url).searchParams.get("model") || "claude-opus-5";
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
