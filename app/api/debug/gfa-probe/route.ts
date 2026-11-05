import { gfaProbe } from "@/lib/adapters/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 임시: GFA 수정 API 경로 찾기용(읽기 전용 GET·OPTIONS만). 확인 후 삭제한다.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const method = url.searchParams.get("m") === "GET" ? "GET" : "OPTIONS";
  const paths = (url.searchParams.get("p") || "").split("|").filter(Boolean).slice(0, 40);
  const out = [];
  for (const p of paths) out.push(await gfaProbe(method, p).then((r) => ({ ...r, body: r.body.slice(0, url.searchParams.get("full") ? 60_000 : 300) })).catch((e) => ({ path: p, error: String(e) })));
  return Response.json(out);
}
