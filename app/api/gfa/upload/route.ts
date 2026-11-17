import { gfaUploadImage } from "@/lib/adapters/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GFA 소재 이미지 업로드 (비밀번호 잠금 뒤에서만 접근 가능).
// multipart/form-data: accountId, creativeTemplateCode, file(binary)
// 응답의 imageNo 로 /api/gfa/ops 에서 소재를 만든다 (POST adAccounts/{계정}/creatives/SINGLE_IMAGE 등).
const MAX_BYTES = 4_000_000; // Vercel 함수 요청 본문 한도(약 4.5MB) 안쪽

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const accountId = String(form.get("accountId") || "").replace(/[^0-9]/g, "");
    const template = String(form.get("creativeTemplateCode") || "").trim();
    const file = form.get("file");
    if (!accountId) return Response.json({ ok: false, error: "accountId(GFA 광고계정 번호)가 필요합니다." }, { status: 400 });
    if (!/^[A-Z0-9_]+$/.test(template)) return Response.json({ ok: false, error: "creativeTemplateCode가 필요합니다." }, { status: 400 });
    if (!(file instanceof Blob) || !file.size) return Response.json({ ok: false, error: "file(이미지)이 필요합니다." }, { status: 400 });
    if (file.size > MAX_BYTES) return Response.json({ ok: false, error: "이미지가 너무 큽니다 (4MB 이하)." }, { status: 400 });
    const name = file instanceof File && file.name ? file.name : "image.jpg";
    const data = await gfaUploadImage(accountId, file, name, template);
    return Response.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "GFA 이미지 업로드 실패";
    console.error(`gfa/upload 실패 — ${message}`);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
