import { debugGfa } from "@/lib/adapters/live";

export const dynamic = "force-dynamic";

// TEMP diagnostic route — remove after GFA field mapping is confirmed.
export async function GET(request: Request) {
  const account = new URL(request.url).searchParams.get("account") || "44324";
  return Response.json(await debugGfa(account.replace(/[^0-9]/g, "")));
}
