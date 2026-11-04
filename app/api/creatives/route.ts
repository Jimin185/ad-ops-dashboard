import { getCreativeReport } from "@/lib/adapters/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

// Meta·GFA 소재별 성과 (이미지 포함). 매핑된 계정만 조회한다.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { accounts?: string[]; since?: string; until?: string; refresh?: boolean };
    if (!Array.isArray(body.accounts) || !isDate(body.since) || !isDate(body.until)) return Response.json({ error: "accounts, since, until이 필요합니다." }, { status: 400 });
    if (process.env.ADAPTER_MODE !== "live") return Response.json({ since: body.since, until: body.until, rows: [], errors: [] });
    return Response.json(await getCreativeReport(body.accounts.slice(0, 30), body.since, body.until, Boolean(body.refresh)));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "소재 성과를 불러오지 못했습니다." }, { status: 500 });
  }
}
