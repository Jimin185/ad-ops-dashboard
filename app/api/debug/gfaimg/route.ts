// 임시(조사용, main에 합치지 않음): GFA 광고세트별 소재 목록에서 이미지 받아 base64로 돌려준다. 조회만.
import { researchApi } from "@/lib/adapters/live";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const acct = q.get("acct") || "44324";
  const sets = (q.get("sets") || "").split(",").filter(Boolean);
  const sharp = (await import("sharp")).default;
  const want = new Set((q.get("nos") || "").split(",").filter(Boolean));
  const out: any[] = [];
  const started = Date.now();
  await Promise.all(sets.map(async (s) => {
    try {
      for (let page = 0; page < 10; page++) {
        const b = await researchApi.gfaGet(`/adAccounts/${acct}/creatives`, { adSetNo: s, page: String(page), size: "100" });
        const items = Array.isArray(b) ? b : b.content || b.rows || b.data || [];
        for (const c of items) {
          const media = c.medias?.[0] || c.media || c.images?.[0] || c.image || {};
          const url = media.url || media.imageUrl || c.imageUrl || c.thumbnailUrl || c.previewUrl;
          const no = String(c.no ?? c.creativeNo ?? "");
          if (want.size && !want.has(no)) continue;
          let b64 = "";
          if (url && Date.now() - started < 45_000) { try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); b64 = (await sharp(Buffer.from(await r.arrayBuffer())).resize({ width: 300, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer()).toString("base64"); } catch {} }
          out.push({ set: s, no: String(c.no ?? c.creativeNo ?? ""), name: c.name, url: url || "", b64 });
        }
        if (items.length < 100) break;
      }
    } catch (e) { out.push({ set: s, error: String(e).slice(0, 200) }); }
  }));
  return Response.json(out);
}
