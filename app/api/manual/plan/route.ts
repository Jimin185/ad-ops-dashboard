import { getAdapter } from "@/lib/adapters";
import { createPendingAction } from "@/lib/pending";
import type { ChangeOperation } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const operation = (await request.json()) as ChangeOperation;
    if (operation.kind !== "update_budget" && operation.kind !== "set_status") {
      return Response.json({ error: "지원하지 않는 수동 변경입니다." }, { status: 400 });
    }
    const entity = await getAdapter().resolveEntity(operation.channel, operation.entityType, operation.id);
    if (!entity) return Response.json({ error: "대상을 찾을 수 없습니다." }, { status: 404 });
    const field = operation.kind === "update_budget" ? "일예산" : "상태";
    const before = operation.kind === "update_budget" && "dailyBudget" in entity ? entity.dailyBudget : entity.status;
    const after = operation.kind === "update_budget" ? operation.dailyBudget : operation.status;
    const pendingAction = createPendingAction(`${entity.name} ${field} 변경`, operation, [
      { targetId: entity.id, targetName: entity.name, field, before, after },
    ]);
    return Response.json({ pendingAction });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "변경안을 만들지 못했습니다." }, { status: 500 });
  }
}
