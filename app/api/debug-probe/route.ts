import { debugGfaCreatives, getDailyReport } from "@/lib/adapters/live";
import { withNaverSaAccounts } from "@/lib/naver-sa-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMP diagnostic route — removed after the GFA creative and Naver SA stats shapes are confirmed.
export async function GET(request: Request) {
  return withNaverSaAccounts(request, async () => {
    const params = new URL(request.url).searchParams;
    const gfa = params.get("gfa") || "44324";
    const sa = params.get("sa") || "1922718";
    const since = params.get("since") || "2026-11-01", until = params.get("until") || "2026-11-03";
    const [gfaCreatives, saDaily] = await Promise.all([
      debugGfaCreatives(gfa),
      getDailyReport([`naver_sa:${sa}`], since, until),
    ]);
    return Response.json({ gfaCreatives, saDaily: { rows: saDaily.rows.slice(0, 5), errors: saDaily.errors } });
  });
}
