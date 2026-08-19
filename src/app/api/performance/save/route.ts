import { db } from "@/db";
import { performanceLog } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { FixtureLite } from "@/lib/espn";
import type { EngineResult } from "@/lib/engine/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json() as { fixture: FixtureLite; result: EngineResult };
    const { fixture, result } = body;

    // Idempotency: skip if this match is already logged
    const existing = await db
      .select()
      .from(performanceLog)
      .where(eq(performanceLog.eventId, fixture.id))
      .limit(1);

    if (existing.length > 0) {
      return Response.json({ success: true, id: existing[0].id, alreadyExists: true });
    }

    const top10picks = result.top10.slice(0, 10).map((p: import("@/lib/engine/types").Market) => ({
      name:      p.name,
      selection: p.selection,
      hitRate:   p.hitRate,
      outcome:   p.outcome ?? "PENDING",
      family:    p.family,
      reason:    p.reason,
    }));

    const hits    = top10picks.filter((p) => p.outcome === "HIT").length;
    const misses  = top10picks.filter((p) => p.outcome === "MISS").length;
    const pending = top10picks.filter((p) => p.outcome === "PENDING").length;
    const verified = hits + misses;

    const [row] = await db
      .insert(performanceLog)
      .values({
        eventId:    fixture.id,
        matchLabel: `${fixture.home.name} vs ${fixture.away.name}`,
        homeTeam:   fixture.home.name,
        awayTeam:   fixture.away.name,
        league:     fixture.leagueName,
        leagueSlug: fixture.leagueSlug,
        matchDate:  fixture.date.slice(0, 10),
        homeScore:  Number(fixture.home.score) || 0,
        awayScore:  Number(fixture.away.score) || 0,
        totalPicks: top10picks.length,
        hits,
        misses,
        pending,
        accuracy:    verified > 0 ? hits / verified : 0,
        top10Detail: top10picks,
      })
      .returning();

    return Response.json({ success: true, id: row.id });
  } catch (err) {
    console.error("Performance save error:", err);
    return Response.json({ error: "Failed to save" }, { status: 500 });
  }
}
