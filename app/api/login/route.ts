import { createHash } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return Response.json({ ok: true, note: "비밀번호가 설정되지 않아 잠금이 꺼져 있습니다." });
  const body = (await request.json().catch(() => ({}))) as { password?: string };
  if (body.password !== password) return Response.json({ error: "비밀번호가 맞지 않습니다." }, { status: 401 });
  const cookie = createHash("sha256").update(`${password}|desker-dash-v1`).digest("hex");
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `dash_auth=${cookie}; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
