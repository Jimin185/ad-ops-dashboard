import { executeMediaPlan, type MediaStep } from "@/lib/adapters/live";
import { withNaverSaAccounts } from "@/lib/naver-sa-registry";
import { getAdapter } from "@/lib/adapters";
import { verifyPendingAction } from "@/lib/pending";

export async function POST(request: Request) {
  return withNaverSaAccounts(request, () => handle(request));
}

async function handle(request: Request) {
  try {
    const { token } = (await request.json()) as { token?: string };
    if (!token) return Response.json({ error: "승인 토큰이 없습니다." }, { status: 400 });
    const pending = verifyPendingAction(token);
    const operation = pending.operation;

    // Re-resolve the target at approval time. Never trust model-provided labels/current values.
    if (operation.kind === "media_plan") {
      // 승인 토큰에 서명된 계정 범위 안에서만, 단계별로 범위를 다시 확인하며 실행한다.
      if (process.env.ADAPTER_MODE !== "live") return Response.json({ error: "데모 모드에서는 매체 세팅을 실행할 수 없습니다." }, { status: 400 });
      const result = await executeMediaPlan(operation.steps as MediaStep[], operation.accountKeys);
      return Response.json({ message: result.success ? `${result.completed}단계를 모두 실행했습니다.` : `${result.completed}단계까지 실행하고 ${(result.failedStep ?? 0) + 1}번째 단계에서 멈췄습니다: ${result.error}`, result }, { status: result.success ? 200 : 207 });
    }
    if (operation.kind !== "create_text_ad") {
      const current = await getAdapter().resolveEntity(operation.channel, operation.entityType, operation.id);
      if (!current) return Response.json({ error: "변경 대상이 더 이상 존재하지 않습니다." }, { status: 409 });
    }

    const result = await getAdapter().apply(operation);
    return Response.json({ message: "변경을 적용했습니다.", result });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "변경 적용에 실패했습니다." }, { status: 500 });
  }
}
