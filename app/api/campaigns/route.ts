import { getAdapter } from "@/lib/adapters";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const campaigns = await getAdapter().listCampaigns(undefined, true);
    return Response.json({ campaigns, mode: process.env.ADAPTER_MODE || "mock" });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "캠페인을 불러오지 못했습니다.",
      mode: process.env.ADAPTER_MODE || "mock",
    }, { status: 500 });
  }
}
