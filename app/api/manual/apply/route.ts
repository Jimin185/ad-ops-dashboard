import { getAdapter } from "@/lib/adapters";
import { withNaverSaAccounts } from "@/lib/naver-sa-registry";
import type { ChangeOperation } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 화면에서 직접 하는 ON/OFF·예산 변경. 사용자가 팝업에서 확인한 뒤 호출되므로 AI를 거치지 않고 바로 적용한다.
// 여러 건이면 순서대로 적용하고 건별 결과를 돌려준다.
export async function POST(request: Request) {
  return withNaverSaAccounts(request, async () => {
    const body = (await request.json()) as { operations?: ChangeOperation[] };
    const operations = (body.operations || []).filter((op) => op && (op.kind === "set_status" || op.kind === "update_budget")).slice(0, 100);
    if (!operations.length) return Response.json({ error: "적용할 변경이 없습니다." }, { status: 400 });
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const op of operations) {
      try {
        if (op.kind === "update_budget" && !(Number(op.dailyBudget) > 0)) throw new Error("예산은 0보다 커야 합니다.");
        await getAdapter().apply(op);
        results.push({ id: (op as any).id, ok: true });
      } catch (error) {
        results.push({ id: (op as any).id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return Response.json({ results, applied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  });
}
