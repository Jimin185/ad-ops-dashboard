import { exportGfaRaw, exportNaverSaRaw } from "@/lib/adapters/live";
import { withNaverSaAccounts } from "@/lib/naver-sa-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// 보고서 작성용 원본 내보내기(읽기 전용). ?channel=naver_sa|naver_gfa&account=&since=&until=
export async function GET(request: Request) {
  return withNaverSaAccounts(request, async () => {
    const p = new URL(request.url).searchParams;
    const channel = p.get("channel"), account = String(p.get("account") || "").replace(/[^0-9]/g, ""), since = p.get("since"), until = p.get("until");
    if (!account || !isDate(since) || !isDate(until) || since > until) return Response.json({ error: "channel, account, since, until(YYYY-MM-DD)가 필요합니다." }, { status: 400 });
    if (process.env.ADAPTER_MODE !== "live") return Response.json({ error: "실계정 모드에서만 됩니다." }, { status: 400 });
    try {
      if (channel === "naver_sa") return Response.json(await exportNaverSaRaw(account, since, until));
      if (channel === "naver_gfa") return Response.json(await exportGfaRaw(account, since, until));
      return Response.json({ error: "channel 은 naver_sa 또는 naver_gfa" }, { status: 400 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  });
}
