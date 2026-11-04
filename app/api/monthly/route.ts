import { ensureMonthly, queryMonthly } from "@/lib/monthly";
import { withNaverSaAccounts } from "@/lib/naver-sa-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST { accounts: ["channel:id"], ensure?: true } → 빠진 달을 채우고(시간 내에서) 저장된 월별 데이터를 돌려준다.
// 아직 남았으면 status: "loading"과 남은 계정 수. 브라우저가 이어서 다시 부른다.
export async function POST(request: Request) {
  return withNaverSaAccounts(request, async () => {
    try {
      const body = (await request.json()) as { accounts?: string[]; ensure?: boolean };
      const accounts = (body.accounts || []).map(String).slice(0, 300);
      if (body.ensure !== false && accounts.length) {
        const result = await ensureMonthly(accounts, 40_000);
        if (result.pending) return Response.json({ status: "loading", ...result });
        if (result.errors?.length) return Response.json({ status: "ready", errors: result.errors, rows: await queryMonthly(accounts) });
      }
      return Response.json({ status: "ready", rows: await queryMonthly(accounts.length ? accounts : undefined) });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "월별 데이터를 불러오지 못했습니다." }, { status: 500 });
    }
  });
}
