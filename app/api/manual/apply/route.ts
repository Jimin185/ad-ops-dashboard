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
    const operations = (body.operations || []).filter((op) => op && (op.kind === "set_status" || op.kind === "update_budget" || op.kind === "update_landing")).slice(0, 100);
    if (!operations.length) return Response.json({ error: "적용할 변경이 없습니다." }, { status: 400 });
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const op of operations) {
      try {
        if (op.kind === "update_budget" && !(Number(op.dailyBudget) > 0)) throw new Error("예산은 0보다 커야 합니다.");
        if (op.kind === "update_landing" && !/^https?:\/\/\S+$/.test(op.url || "")) throw new Error("랜딩 URL은 http(s)://로 시작해야 해요.");
        await getAdapter().apply(op);
        results.push({ id: (op as any).id, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`manual/apply 실패 ${op.kind} ${(op as any).channel}:${(op as any).entityType}:${(op as any).id} — ${message}`);
        results.push({ id: (op as any).id, ok: false, error: message });
      }
    }
    return Response.json({ results, applied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  });
}
