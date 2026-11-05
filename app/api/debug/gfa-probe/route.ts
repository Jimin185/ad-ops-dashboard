import { gfaProbe } from "@/lib/adapters/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 임시: GFA 수정 API 경로 찾기용(읽기 전용). 확인 후 삭제한다.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const a = url.searchParams.get("account") || "";
  const id = url.searchParams.get("id") || "";
  const docs = url.searchParams.get("docs");
  if (docs) return Response.json(await gfaProbe("GET", docs).catch((e) => ({ error: String(e) })));
  const base = `adAccounts/${a}`;
  const subs = ["budget", "budgets", "status", "onOff", "on-off", "activation", "activate", "activated", "dailyBudget", "bid", "bidAmount", "schedule", "name", "update"];
  const gets = ["v3/api-docs", "v2/api-docs", "api-docs", "swagger.json", "openapi.json",
    `${base}/adSets/${id}`, `${base}/adSets`, `${base}/adSets/bulk`, `${base}/adSets/onOff`, `${base}/adSets/status`, `${base}/adSets/budget`, `${base}/adSets/budgets`,
    ...subs.map((s) => `${base}/adSets/${id}/${s}`)];
  const results = await Promise.all([
    ...gets.map((p) => gfaProbe("GET", p).catch((e) => ({ path: p, error: String(e) }))),
    ...[`${base}/adSets/${id}`, `${base}/adSets`].map((p) => gfaProbe("OPTIONS", p).catch((e) => ({ path: p, error: String(e) }))),
  ]);
  return Response.json(results.map((r: any) => ({ ...r, body: r.body?.slice?.(0, 400) })));
}
