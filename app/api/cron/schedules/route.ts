import { storageAvailable } from "@/lib/db";
import { withNaverSaAccounts } from "@/lib/naver-sa-registry";
import { runDueSchedules } from "@/lib/schedule-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Vercel Cron: 23시대(KST, OFF 예약을 하루 전에 미리 끔)와 0시대(KST, ON 예약)에 부른다.
// Hobby 요금제 크론은 정해진 '시' 안의 아무 때나 실행된다(분 단위 보장 없음).
export async function GET(request: Request) {
  return withNaverSaAccounts(request, async () => {
    if (!storageAvailable()) return Response.json({ error: "Supabase 연결이 필요합니다." }, { status: 503 });
    const log = await runDueSchedules();
    console.log(`[cron/schedules] ${log.length}건`, JSON.stringify(log).slice(0, 2000));
    return Response.json({ ran: log.length, log });
  });
}
