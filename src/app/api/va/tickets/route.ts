import { db } from "@/db";
import { vaTickets } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const scanId = url.searchParams.get("scanId")?.trim() || null;

  try {
    let tickets;
    if (scanId) {
      tickets = await db
        .select()
        .from(vaTickets)
        .where(eq(vaTickets.scanId, scanId))
        .orderBy(desc(vaTickets.kellyScore));
    } else {
      // Get most recent scanId
      const latest = await db.select().from(vaTickets).orderBy(desc(vaTickets.createdAt)).limit(1);
      if (latest.length === 0) {
        return Response.json({ ok: true, tickets: [], scanId: null });
      }
      const latestScanId = latest[0].scanId;
      tickets = await db
        .select()
        .from(vaTickets)
        .where(eq(vaTickets.scanId, latestScanId))
        .orderBy(desc(vaTickets.kellyScore));
      return Response.json({ ok: true, tickets, scanId: latestScanId });
    }

    return Response.json({ ok: true, tickets, scanId });
  } catch (err) {
    console.error("[VA] tickets fetch failed", err);
    return Response.json({ ok: false, reason: "failed to fetch tickets" }, { status: 500 });
  }
}
