import { createHash } from "node:crypto";
import { after } from "next/server";
import { cacheGet, cacheGetStale, cacheSet } from "@/lib/cache";
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
      const key = `campaigns:v2:${new Date().toISOString().slice(0, 7)}:${createHash("sha1").update(registered).digest("hex").slice(0, 12)}`;
      // 30분이 지나도 하루 안의 값이면 먼저 바로 보여주고, 새 값은 뒤에서 받아 캐시에 넣는다(다음 요청부터 반영).
      const cached = refresh ? null : await cacheGetStale<any>(key, 26 * 3600_000);
      if (cached) {
        if (cached.stale) after(async () => {
          const lock = `${key}:refreshing`;
          if (await cacheGet(lock)) return;
          await cacheSet(lock, 1, Date.now() + 5 * 60_000);
          try { await cacheSet(key, await getLiveSnapshot(true), Date.now() + 30 * 60_000); } catch { /* 다음 요청에서 다시 시도 */ }
        });
        return Response.json({ ...cached.value, mode: "live", fetchedAt: new Date(cached.updatedAt).toISOString(), cached: true, stale: cached.stale });
      }
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
