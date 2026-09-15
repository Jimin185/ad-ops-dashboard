import { getAdapter } from "@/lib/adapters";
import type { Channel } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const channel = params.get("channel") as Channel | null;
    const campaignId = params.get("campaignId");
    const adgroupId = params.get("adgroupId");
    if (!channel) return Response.json({ error: "채널이 필요합니다." }, { status: 400 });
    if (adgroupId) return Response.json({ ads: await getAdapter().listAds(channel, adgroupId) });
    if (campaignId) return Response.json({ adgroups: await getAdapter().listAdgroups(channel, campaignId) });
    return Response.json({ error: "campaignId 또는 adgroupId가 필요합니다." }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "상세정보를 불러오지 못했습니다." }, { status: 500 });
  }
}
