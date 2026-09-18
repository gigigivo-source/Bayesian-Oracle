import { db } from "@/db";
import { vaBacktestRuns, vaBacktestTickets } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId")?.trim() || null;
  const status = url.searchParams.get("status")?.trim() || null;

  try {
    const runs = await db
      .select()
      .from(vaBacktestRuns)
      .orderBy(desc(vaBacktestRuns.startedAt))
      .limit(20);

    const filters = [];
    if (runId) filters.push(eq(vaBacktestTickets.runId, runId));
    if (status === "won" || status === "lost" || status === "pending") {
      filters.push(eq(vaBacktestTickets.status, status));
    }

    const ticketsQuery = db.select().from(vaBacktestTickets);
    const tickets =
      filters.length > 0
        ? await ticketsQuery
            .where(filters.length === 1 ? filters[0] : and(...filters))
            .orderBy(desc(vaBacktestTickets.createdAt))
            .limit(300)
        : await ticketsQuery.orderBy(desc(vaBacktestTickets.createdAt)).limit(300);

    return Response.json({ ok: true, runs: runs ?? [], tickets: tickets ?? [] });
  } catch (err) {
    console.error("[VA] backtest-tickets fetch failed", err);
    return Response.json({ ok: true, runs: [], tickets: [] });
  }
}
