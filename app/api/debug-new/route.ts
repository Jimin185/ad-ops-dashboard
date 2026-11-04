import { debugNewApis } from "@/lib/adapters/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// TEMP diagnostic route — removed after the API shapes are confirmed.
export async function GET() {
  return Response.json(await debugNewApis());
}
