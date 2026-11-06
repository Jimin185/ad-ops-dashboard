import { kvGet, kvSet, storageAvailable } from "@/lib/db";
import { KPI_OPTIONS, type KpiPrefs } from "@/lib/kpi";

export const dynamic = "force-dynamic";

// 계정별 전환 기준(KPI). 저장하면 1분 안에 조회 경로(캠페인·리포트·소재 등)에 반영된다.
export async function GET() {
  if (!storageAvailable()) return Response.json({ prefs: {}, storage: "unavailable" });
  return Response.json({ prefs: (await kvGet<KpiPrefs>("kpi_prefs")) || {} });
}

export async function PUT(request: Request) {
  if (!storageAvailable()) return Response.json({ error: "Supabase가 연결되지 않았습니다." }, { status: 503 });
  const body = await request.json().catch(() => ({}));
  const accountKey = String(body?.accountKey || "");
  const metric = String(body?.metric || "");
  const channel = accountKey.split(":")[0];
  const options = KPI_OPTIONS[channel];
  if (!options) return Response.json({ error: "이 채널은 전환 기준 선택을 지원하지 않습니다." }, { status: 400 });
  if (metric && !options.some((o) => o.id === metric)) return Response.json({ error: "지원하지 않는 전환 기준입니다." }, { status: 400 });
  const prefs = (await kvGet<KpiPrefs>("kpi_prefs")) || {};
  if (metric) prefs[accountKey] = metric; else delete prefs[accountKey];
  await kvSet("kpi_prefs", prefs);
  return Response.json({ prefs });
}
