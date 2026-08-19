import { db } from "@/db";
import { errorLog } from "@/db/schema";
import { sql, desc, gte } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Monitoring + health-alerts endpoint. Reports:
 *  - DB health (live ping)
 *  - error counts (last 1h / 24h) by level & source
 *  - recent errors
 *  - active ALERTS (DB down, error spike) with severity
 */
export async function GET() {
  const nowIso = new Date().toISOString();
  const alerts: Array<{ severity: "critical" | "warning"; message: string }> = [];

  // ── DB health ────────────────────────────────────────────────────────────────
  let dbHealthy = true;
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbHealthy = false;
    alerts.push({ severity: "critical", message: "Database is unreachable." });
  }

  let last1h  = 0;
  let last24h = 0;
  let byLevel:  Array<{ level: string; count: number }>  = [];
  let bySource: Array<{ source: string; count: number }> = [];
  let recent:   Array<{ id: number; level: string; source: string; message: string; createdAt: string }> = [];

  if (dbHealthy) {
    try {
      const h1  = new Date(Date.now() -      60 * 60 * 1000);
      const h24 = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const [c1]  = await db.select({ n: sql<number>`count(*)::int` }).from(errorLog).where(gte(errorLog.createdAt, h1));
      const [c24] = await db.select({ n: sql<number>`count(*)::int` }).from(errorLog).where(gte(errorLog.createdAt, h24));
      last1h  = c1?.n  ?? 0;
      last24h = c24?.n ?? 0;

      byLevel = await db
        .select({ level: errorLog.level, count: sql<number>`count(*)::int` })
        .from(errorLog)
        .where(gte(errorLog.createdAt, h24))
        .groupBy(errorLog.level);

      bySource = await db
        .select({ source: errorLog.source, count: sql<number>`count(*)::int` })
        .from(errorLog)
        .where(gte(errorLog.createdAt, h24))
        .groupBy(errorLog.source)
        .orderBy(desc(sql`count(*)`))
        .limit(10);

      const rows = await db
        .select()
        .from(errorLog)
        .orderBy(desc(errorLog.createdAt))
        .limit(25);

      recent = rows.map((r) => ({
        id:        r.id,
        level:     r.level,
        source:    r.source,
        message:   r.message,
        createdAt: r.createdAt.toISOString(),
      }));

      // ── Alert rules ─────────────────────────────────────────────────────────
      if (last1h >= 20)      alerts.push({ severity: "critical", message: `Error spike: ${last1h} errors in the last hour.` });
      else if (last1h >= 8)  alerts.push({ severity: "warning",  message: `Elevated errors: ${last1h} in the last hour.` });
    } catch {
      alerts.push({ severity: "warning", message: "Could not read error log." });
    }
  }

  const status =
    !dbHealthy                                          ? "down"     :
    alerts.some((a) => a.severity === "critical")       ? "degraded" :
    alerts.length > 0                                   ? "warning"  :
                                                          "healthy";

  return Response.json({
    status,
    checkedAt: nowIso,
    db:     { healthy: dbHealthy },
    errors: { last1h, last24h, byLevel, bySource },
    alerts,
    recent,
  });
}

/**
 * Manual capture endpoint — accepts client-side or server-side error reports.
 * Body: { source, message, stack?, context?, level? }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      source?:  string;
      message?: string;
      stack?:   string;
      context?: unknown;
      level?:   string;
    };
    const { source, message, stack, context, level } = body;
    if (!source || !message) {
      return Response.json({ error: "source and message required" }, { status: 400 });
    }
    await db.insert(errorLog).values({
      level:   level ? String(level).slice(0, 20) : "error",
      source:  String(source).slice(0, 200),
      message: String(message).slice(0, 2000),
      stack:   stack   ? String(stack).slice(0, 6000) : null,
      context: context ?? null,
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "capture failed" }, { status: 500 });
  }
}
