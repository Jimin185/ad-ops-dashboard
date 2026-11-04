import { getBizmoney } from "@/lib/adapters/live";
import { withNaverSaAccounts } from "@/lib/naver-sa-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ?ids=1922718,123 (네이버 SA 고객 ID)
export async function GET(request: Request) {
  return withNaverSaAccounts(request, async () => {
    const ids = (new URL(request.url).searchParams.get("ids") || "").split(",").map((v) => v.replace(/[^0-9]/g, "")).filter(Boolean).slice(0, 20);
    if (process.env.ADAPTER_MODE !== "live") return Response.json({ balances: [] });
    return Response.json({ balances: await getBizmoney(ids) });
  });
}
