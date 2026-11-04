import { addPost, deletePost, listPosts } from "@/lib/monthly";
import { storageAvailable } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unavailable = () => Response.json({ error: "Supabase가 연결되지 않았습니다." }, { status: 503 });

export async function GET() {
  if (!storageAvailable()) return unavailable();
  return Response.json({ posts: await listPosts() });
}
export async function POST(request: Request) {
  if (!storageAvailable()) return unavailable();
  const body = (await request.json()) as any;
  if (!body.author?.trim() || !body.title?.trim()) return Response.json({ error: "작성자와 제목을 입력해 주세요." }, { status: 400 });
  const id = await addPost({ author: String(body.author), advertiser: String(body.advertiser || ""), channel: String(body.channel || ""), product: String(body.product || ""), title: String(body.title), body: String(body.body || ""), metrics: body.metrics });
  return Response.json({ id });
}
export async function DELETE(request: Request) {
  if (!storageAvailable()) return unavailable();
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id가 필요합니다." }, { status: 400 });
  await deletePost(id);
  return Response.json({ ok: true });
}
