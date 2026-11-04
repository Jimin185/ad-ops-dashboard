import { allAdvertiserAccountKeys, ensureMonthly } from "@/lib/monthly";
import { withNaverSaAccounts } from "@/lib/naver-sa-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 매일 한 번(vercel.json cron) 모든 광고주의 매핑 계정에 대해 마감된 달을 적재한다.
// 이미 적재된 달은 건너뛰므로 여러 번 불려도 결과는 같다.
export async function GET(request: Request) {
  return withNaverSaAccounts(request, async () => {
    try {
      return Response.json(await ensureMonthly(await allAdvertiserAccountKeys(), 50_000));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  });
}
