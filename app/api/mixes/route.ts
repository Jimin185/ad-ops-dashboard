import { deleteMix, listMixes, storageAvailable, upsertMix } from "@/lib/db";
import { sanitizeMix } from "@/lib/mix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unavailable = () => Response.json({ error: "Supabase가 연결되지 않았습니다.", storage: "unavailable" }, { status: 503 });

export async function GET(request: Request) {
  if (!storageAvailable()) return unavailable();
  try { return Response.json({ mixes: await listMixes(new URL(request.url).searchParams.get("advertiserId") || undefined) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "믹스를 불러오지 못했습니다." }, { status: 500 }); }
}

export async function PUT(request: Request) {
  if (!storageAvailable()) return unavailable();
  try {
    const mix = sanitizeMix(await request.json());
    if (!mix) return Response.json({ error: "광고주와 월(YYYY-MM)이 필요합니다." }, { status: 400 });
    return Response.json({ mix: await upsertMix(mix) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "믹스를 저장하지 못했습니다." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!storageAvailable()) return unavailable();
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id가 필요합니다." }, { status: 400 });
  await deleteMix(id);
  return Response.json({ ok: true });
}
