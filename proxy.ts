import { NextResponse, type NextRequest } from "next/server";

// 간단한 전체 잠금: Vercel 환경변수 DASHBOARD_PASSWORD 가 설정된 경우에만 동작한다.
// - 브라우저: /login 에서 비밀번호 입력 → 30일 쿠키
// - API 직접 호출(스크립트/Claude): x-dashboard-key 헤더에 비밀번호
// - Vercel 크론(/api/cron/*)은 쿠키를 보낼 수 없어 제외
async function sha256(value: string) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function proxy(request: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next(); // 변수 미설정이면 기존처럼 공개 (잠금 해제 상태)
  const { pathname } = request.nextUrl;
  if (pathname === "/login" || pathname.startsWith("/api/login") || pathname.startsWith("/api/cron/")) return NextResponse.next();

  const expected = await sha256(`${password}|desker-dash-v1`);
  if (request.cookies.get("dash_auth")?.value === expected) return NextResponse.next();
  if (request.headers.get("x-dashboard-key") === password) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "인증이 필요합니다. x-dashboard-key 헤더 또는 로그인 쿠키를 사용하세요." }, { status: 401 });
  const login = new URL("/login", request.url);
  return NextResponse.redirect(login);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.png$).*)"] };
