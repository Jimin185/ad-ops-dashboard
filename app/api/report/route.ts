import { getDailyReport } from "@/lib/adapters/live";
import { withNaverSaAccounts } from "@/lib/naver-sa-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

// 선택한 광고주의 매핑 계정만 일자별로 조회한다.
export async function POST(request: Request) {
  return withNaverSaAccounts(request, async () => {
    try {
      const body = (await request.json()) as { accounts?: string[]; since?: string; until?: string; refresh?: boolean };
      if (!Array.isArray(body.accounts) || !isDate(body.since) || !isDate(body.until)) {
        return Response.json({ error: "accounts, since, until(YYYY-MM-DD)가 필요합니다." }, { status: 400 });
      }
      if (process.env.ADAPTER_MODE !== "live") return Response.json({ since: body.since, until: body.until, rows: [], errors: [] });
      return Response.json(await getDailyReport(body.accounts.slice(0, 50), body.since, body.until, Boolean(body.refresh)));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "리포트를 불러오지 못했습니다." }, { status: 500 });
    }
  });
}
