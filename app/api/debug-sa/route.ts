import { debugSaReports } from "@/lib/adapters/live";
import { withNaverSaAccounts } from "@/lib/naver-sa-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// TEMP diagnostic route — removed after the report column layout is confirmed.
export async function GET(request: Request) {
  return withNaverSaAccounts(request, async () => {
    const params = new URL(request.url).searchParams;
    return Response.json(await debugSaReports(params.get("sa") || "1922718", params.get("date") || "2026-11-03"));
  });
}
