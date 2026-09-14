import { getAdapter } from "@/lib/adapters";
import { verifyPendingAction } from "@/lib/pending";

export async function POST(request: Request) {
  try {
    const { token } = (await request.json()) as { token?: string };
    if (!token) return Response.json({ error: "승인 토큰이 없습니다." }, { status: 400 });
    const pending = verifyPendingAction(token);
    const operation = pending.operation;

    // Re-resolve the target at approval time. Never trust model-provided labels/current values.
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
