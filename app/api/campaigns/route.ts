import { createHash } from "node:crypto";
import { cacheGet, cacheSet } from "@/lib/cache";
import { NAVER_SA_HEADER, withNaverSaAccounts } from "@/lib/naver-sa-registry";
import { getAdapter } from "@/lib/adapters";
import { getLiveSnapshot } from "@/lib/adapters/live";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withNaverSaAccounts(request, () => handle(request));
}

async function handle(request: Request) {
  try {
    if (process.env.ADAPTER_MODE === "live") {
      // 캠페인 목록은 30분 캐시. 새로고침 버튼(?refresh=1)이나 변경 적용 후엔 바로 다시 가져온다.
      const refresh = new URL(request.url).searchParams.get("refresh") === "1";
      const registered = request.headers.get(NAVER_SA_HEADER) || "";
      const key = `campaigns:${new Date().toISOString().slice(0, 7)}:${createHash("sha1").update(registered).digest("hex").slice(0, 12)}`;
      const cached = refresh ? null : await cacheGet<any>(key);
      if (cached) return Response.json({ ...cached.value, mode: "live", fetchedAt: new Date(cached.updatedAt).toISOString(), cached: true });
      const snapshot = await getLiveSnapshot(true);
      await cacheSet(key, snapshot, Date.now() + 30 * 60_000);
      return Response.json({ ...snapshot, mode: "live", fetchedAt: new Date().toISOString(), cached: false });
    }
    const campaigns = await getAdapter().listCampaigns(undefined, true);
    return Response.json({ campaigns, connections: [], mode: process.env.ADAPTER_MODE || "mock" });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "캠페인을 불러오지 못했습니다.",
      mode: process.env.ADAPTER_MODE || "mock",
    }, { status: 500 });
  }
}
