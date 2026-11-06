import { createHash } from "node:crypto";
import { getCreativeReport, getDailyReport, getLiveSnapshot } from "@/lib/adapters/live";
import { cacheSet, kstToday } from "@/lib/cache";
import { listAdvertisers, storageAvailable } from "@/lib/db";
import { allAdvertiserAccountKeys, ensureMonthly } from "@/lib/monthly";
import { withNaverSaAccounts } from "@/lib/naver-sa-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 매일 오전 7시대(KST) Vercel Cron이 부른다. 대시보드를 열지 않아도 데이터가 준비되도록
// 1) 마감된 달 적재 → 2) 캠페인 목록 → 3) 광고주별 이번 달 리포트·소재 성과를 캐시에 미리 받아둔다.
// 60초 제한 때문에 단계(step)를 나눠, 끝나지 않으면 다음 단계를 스스로 다시 부른다. 몇 번 불려도 결과는 같다.
export async function GET(request: Request) {
  return withNaverSaAccounts(request, async () => {
    const url = new URL(request.url);
    const step = Number(url.searchParams.get("step") || 0);
    const started = Date.now();
    const log: string[] = [];
    try {
      if (!storageAvailable()) return Response.json({ error: "Supabase 연결이 필요합니다." }, { status: 503 });
      const advertisers = await listAdvertisers();
      if (step === 0) {
        const monthly = await ensureMonthly(await allAdvertiserAccountKeys(), 25_000);
        log.push(`monthly pending=${monthly.pending}`);
        if (monthly.pending) return next(url, 0, log);
        const snapshot = await getLiveSnapshot(true);
        await cacheSet(`campaigns:v3:${new Date().toISOString().slice(0, 7)}:${createHash("sha1").update("").digest("hex").slice(0, 12)}`, snapshot, Date.now() + 30 * 60_000);
        log.push("campaigns cached");
        console.log(`[cron/daily] step 0: ${log.join(", ")}`);
        return next(url, 1, log);
      }
      // step 1.. = 광고주 순서
      const today = kstToday(), since = `${today.slice(0, 7)}-01`;
      let i = step - 1;
      for (; i < advertisers.length && Date.now() - started < 35_000; i++) {
        const keys = advertisers[i].accountKeys;
        if (!keys.length) continue;
        await getDailyReport(keys, since, today).catch(() => null);
        const creativeKeys = keys.filter((k) => k.startsWith("meta:") || k.startsWith("naver_gfa:"));
        if (creativeKeys.length) await getCreativeReport(creativeKeys, since, today).catch(() => null);
        log.push(`warmed ${advertisers[i].name}`);
      }
      console.log(`[cron/daily] step ${step}: ${log.join(", ")}`);
      if (i < advertisers.length) return next(url, i + 1, log);
      return Response.json({ done: true, log });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error), log }, { status: 500 });
    }
  });
}

async function next(url: URL, step: number, log: string[]) {
  // 보호된 배포 주소가 아니라 프로덕션 도메인으로 이어서 호출한다
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const target = new URL(prod ? `https://${prod}${url.pathname}` : url.toString());
  target.searchParams.set("step", String(step));
  // 다음 단계를 띄우고 응답은 기다리지 않는다 (요청이 나가면 서버 쪽에서 계속 실행됨)
  await fetch(target, { signal: AbortSignal.timeout(2500), cache: "no-store" }).catch(() => null);
  return Response.json({ continued: step, log });
}
