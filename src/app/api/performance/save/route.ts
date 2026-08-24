import { db } from "@/db";
import { performanceLog } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import type { FixtureLite } from "@/lib/espn";
import type { EngineResult } from "@/lib/engine/types";
import { ALL_RANKING_MODES, type RankingMode } from "@/lib/engine/selector";

export const dynamic = "force-dynamic";

/** Coerce a client-supplied ranking mode to A/B/C/D (defaults to B). */
function toMode(value: unknown): RankingMode {
  const v = typeof value === "string" ? value.toUpperCase() : "";
  return (ALL_RANKING_MODES as string[]).includes(v) ? (v as RankingMode) : "B";
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { fixture: FixtureLite; result: EngineResult; rankingMode?: string };
    const { fixture, result } = body;
    const rankingMode = toMode(body.rankingMode);

    // Idempotency is per (eventId, rankingMode) — one row per mode.
    const existing = await db
      .select({ id: performanceLog.id })
      .from(performanceLog)
      .where(and(
        eq(performanceLog.eventId, fixture.id),
        eq(performanceLog.rankingMode, rankingMode),
      ))
      .limit(1);

    if (existing.length > 0) {
      return Response.json({ success: true, id: existing[0].id, alreadyExists: true });
    }

    const top10picks = result.top10.slice(0, 10).map((p: import("@/lib/engine/types").Market) => {
      const odds = p.marketOdds ?? p.fairOdds ?? null;
      return {
        name:      p.name,
        selection: p.selection,
        hitRate:   p.hitRate,
        outcome:   p.outcome ?? "PENDING",
        family:    p.family,
        reason:    p.reason,
        odds,
        // Edge vs market (hitRate × odds − 1); null when no market price.
        ev:        odds !== null ? Math.round((p.hitRate * odds - 1) * 1000) / 1000 : null,
        // Per-pick ranking-factor breakdown (factor label → 0..1 contribution).
        factors:   p.factors ?? null,
      };
    });

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
        competitionName: fixture.leagueName,
        matchDate:  fixture.date.slice(0, 10),
        homeScore:  Number(fixture.home.score) || 0,
        awayScore:  Number(fixture.away.score) || 0,
        totalPicks: top10picks.length,
        hits,
        misses,
        pending,
        accuracy:    verified > 0 ? hits / verified : 0,
        top10Detail: top10picks,
        rankingMode,
      })
      .returning();

    return Response.json({ success: true, id: row.id, rankingMode });
  } catch (err) {
    console.error("Performance save error:", err);
    return Response.json({ error: "Failed to save" }, { status: 500 });
  }
}
