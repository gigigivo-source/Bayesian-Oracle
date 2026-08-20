import { runSettlementEngine } from "@/lib/settlement/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    new URL(req.url).searchParams.get("key");
  return provided === secret;
}

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return Response.json({ ok: true, ...(await runSettlementEngine()) });
  } catch (error) {
    console.error("Settlement engine failed:", error);
    return Response.json({ error: "Settlement failed" }, { status: 500 });
  }
}

export const POST = GET;
