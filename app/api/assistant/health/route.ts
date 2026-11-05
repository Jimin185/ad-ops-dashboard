import Anthropic from "@anthropic-ai/sdk";
import { assistantTools } from "@/lib/assistant-tools";
import { freeLlmConfig } from "@/lib/free-llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 진단용: API 키·모델·도구 스키마를 아주 작은 요청으로 확인한다. (/api/assistant/health)
export async function GET(request: Request) {
  const model = new URL(request.url).searchParams.get("model") || "claude-opus-5-5";
  const withTools = new URL(request.url).searchParams.get("tools") !== "0";
  const started = Date.now();
  // ?free=1 : 무료 LLM 키·모델 확인 (도구 없이 아주 짧은 요청)
  if (new URL(request.url).searchParams.get("free")) {
    const cfg = freeLlmConfig();
    if (!cfg) return Response.json({ ok: false, free: true, error: "FREE_LLM_API_KEY 없음" });
    if (new URL(request.url).searchParams.get("models")) {
      const r = await fetch(`${cfg.base}/models`, { headers: { Authorization: `Bearer ${cfg.key}` } });
      const j = await r.json().catch(() => ({}));
      return Response.json({ status: r.status, models: (j.data || []).map((m: any) => m.id) });
    }
    const tries: any[] = [];
    for (const model of [cfg.model, ...cfg.fallbacks]) {
      const res = await fetch(`${cfg.base}/chat/completions`, { method: "POST", signal: AbortSignal.timeout(12_000), headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "한 단어로 인사해" }] }) }).catch((e) => null);
      const text = res ? await res.text() : "timeout";
      tries.push({ model, status: res?.status ?? 0, body: text.slice(0, 200) });
      if (res?.ok) break;
    }
    return Response.json({ ok: tries.some((t) => t.status === 200), free: true, label: cfg.label, ms: Date.now() - started, tries });
  }
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
