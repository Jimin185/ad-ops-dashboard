import { getLiveAccounts } from "@/lib/adapters/live";

export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.ADAPTER_MODE !== "live") return Response.json({ accounts: [], errors: {}, mode: "mock" });
  try {
    return Response.json({ ...(await getLiveAccounts()), mode: "live" });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "광고계정을 불러오지 못했습니다." }, { status: 500 });
  }
}
