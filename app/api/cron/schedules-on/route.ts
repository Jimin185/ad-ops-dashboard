// 0시대(KST) 크론용 주소. 23시대 크론과 같은 일을 한다(Vercel 크론은 주소별로 하나씩 두려고 나눔).
import { GET as run } from "../schedules/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) { return run(request); }
