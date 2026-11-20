import { executeMediaStep, type MediaMethod } from "@/lib/adapters/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// 보조: 지정한 env 토큰으로 직접 Graph API 호출 (시스템유저 앱이 개발모드일 때 대체 토큰 사용)
async function rawWithToken(tokenEnv: string, method: MediaMethod, path: string, body?: unknown) {
  const token = process.env[tokenEnv];
  if (!token) throw new Error(`${tokenEnv} 값이 없습니다.`);
  const clean = path.replace(/^\/+/, "");
  if (method === "GET") {
    const [p, q] = clean.split("?");
    const params = new URLSearchParams(q || "");
    params.set("access_token", token);
    const res = await fetch(`https://graph.facebook.com/v21.0/${p}?${params}`);
    const parsed = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(parsed.error || parsed).slice(0, 600));
    return parsed;
  }
  const fields = new URLSearchParams({ access_token: token });
  if (body && typeof body === "object") for (const [k, v] of Object.entries(body as any)) fields.set(k, typeof v === "string" ? v : JSON.stringify(v));
  const res = await fetch(`https://graph.facebook.com/v21.0/${clean}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: fields });
  const parsed = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(parsed.error || parsed).slice(0, 600));
  return parsed;
}

// Meta Graph API 프록시 (인증: proxy.ts 공통 x-dashboard-key)
// GET  ?path=act_123/campaigns?fields=... : 읽기
// POST { method?, path, body? }           : 쓰기 (adimages/adcreatives/ads/상태변경 등)
export async function GET(request: Request) {
  const path = new URL(request.url).searchParams.get("path") || "";
  if (!path) return Response.json({ error: "path가 필요합니다." }, { status: 400 });
  try {
    return Response.json({ data: await executeMediaStep({ channel: "meta", accountId: "", method: "GET", path }) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "조회 실패" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { method = "POST", path, body, tokenEnv } = (await request.json()) as { method?: MediaMethod; path: string; body?: unknown; tokenEnv?: string };
    if (!path) return Response.json({ error: "path가 필요합니다." }, { status: 400 });
    if (tokenEnv) {
      if (!["META_ACCESS_TOKEN", "META_SYSTEM_USER_ACCESS_TOKEN"].includes(tokenEnv)) return Response.json({ error: "허용되지 않은 tokenEnv" }, { status: 400 });
      return Response.json({ data: await rawWithToken(tokenEnv, method, path, body) });
    }
    return Response.json({ data: await executeMediaStep({ channel: "meta", accountId: "", method, path, body }) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "실행 실패" }, { status: 500 });
  }
}
