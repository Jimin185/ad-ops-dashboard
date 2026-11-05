import { listAdvertisers, saveAdvertisers, storageAvailable } from "@/lib/db";
import type { Advertiser } from "@/lib/mix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unavailable = () => Response.json({ error: "Supabase가 연결되지 않았습니다.", storage: "unavailable" }, { status: 503 });

export async function GET() {
  if (!storageAvailable()) return unavailable();
  try { return Response.json({ advertisers: await listAdvertisers() }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "광고주를 불러오지 못했습니다." }, { status: 500 }); }
}

// 광고주 목록 전체를 저장한다 (이름·매핑 계정).
export async function PUT(request: Request) {
  if (!storageAvailable()) return unavailable();
  try {
    const body = (await request.json()) as { advertisers?: Advertiser[] };
    const list = (body.advertisers || []).filter((a) => a && a.id && a.name).map((a) => ({ id: String(a.id), name: String(a.name).slice(0, 100), accountKeys: (a.accountKeys || []).map(String).slice(0, 200) }));
    // 한 계정은 한 광고주에만 매핑될 수 있다
    const seen = new Map<string, string>();
    for (const a of list) for (const key of a.accountKeys) {
      if (seen.has(key) && seen.get(key) !== a.id) return Response.json({ error: `${key} 계정이 여러 광고주에 매핑되어 있습니다.` }, { status: 409 });
      seen.set(key, a.id);
    }
    // 화면이 목록을 못 불러온 상태에서 빈 목록으로 덮어쓰는 사고를 막는다.
    if (!list.length && !(body as { allowEmpty?: boolean }).allowEmpty && (await listAdvertisers()).length > 1) return Response.json({ error: "빈 목록으로는 저장하지 않습니다." }, { status: 409 });
    await saveAdvertisers(list);
    return Response.json({ advertisers: list });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "광고주를 저장하지 못했습니다." }, { status: 500 });
  }
}
