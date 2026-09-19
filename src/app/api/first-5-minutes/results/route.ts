import { db } from "@/db";
import { performanceLog } from "@/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

const SETTLED_OUTCOMES = ["WIN", "LOSS", "PUSH", "VOID"] as const;
type SettledOutcome = (typeof SETTLED_OUTCOMES)[number];
type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface First5ResultMarket {
  market: string;
  selection: string;
  hitRate: number;
  confidence: Confidence;
  outcome: SettledOutcome;
}

export interface First5ResultMatch {
  eventId: string;
  matchLabel: string;
  league: string;
  leagueSlug: string;
  matchDate: string;
  homeScore: number | null;
  awayScore: number | null;
  markets: First5ResultMarket[];
}

function positiveInteger(value: string | null, fallback: number, maximum?: number): number {
  const parsed = value === null ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

function daysParameter(value: string | null): number {
  if (value === null) return 14;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 14;
}

function dateOnly(value: string | null | undefined): string {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

function confidenceValue(value: string | null | undefined): Confidence {
  const normalized = value?.toUpperCase();
  return normalized === "HIGH" || normalized === "MEDIUM" || normalized === "LOW"
    ? normalized
    : "LOW";
}

/**
 * Return the settled First 5 Minutes picks in compact match groups.
 *
 * This is deliberately read-only and fail-soft: the public prediction board
 * must remain useful even when the performance database is unavailable.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = positiveInteger(url.searchParams.get("limit"), 30, 100);
    const days = daysParameter(url.searchParams.get("days"));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    // match_date is stored as YYYY-MM-DD text. Cast it for the date window so
    // PostgreSQL applies the same boundary as the in-memory guard below.
    const rows = await db
      .select()
      .from(performanceLog)
      .where(and(
        eq(performanceLog.feature, "first5"),
        sql`${performanceLog.matchDate}::date >= now() - (${days} * interval '1 day')`,
        inArray(performanceLog.outcome, SETTLED_OUTCOMES),
      ))
      .orderBy(desc(performanceLog.matchDate))
      .limit(limit * 4);

    // The extra guards make the handler deterministic with lightweight DB
    // adapters too; a real PostgreSQL query has already applied all three.
    const settledRows = rows.filter((row) => {
      const matchDate = dateOnly(row.matchDate);
      return row.feature === "first5" &&
        SETTLED_OUTCOMES.includes(row.outcome as SettledOutcome) &&
        matchDate >= cutoff;
    });

    const groups = new Map<string, First5ResultMatch>();
    for (const row of settledRows) {
      const eventId = String(row.eventId);
      let match = groups.get(eventId);
      if (!match) {
        match = {
          eventId,
          matchLabel: row.matchLabel,
          league: row.league,
          leagueSlug: row.leagueSlug ?? "",
          matchDate: dateOnly(row.matchDate),
          homeScore: row.homeScore ?? null,
          awayScore: row.awayScore ?? null,
          markets: [],
        };
        groups.set(eventId, match);
      }

      match.markets.push({
        market: row.market ?? "Unknown market",
        selection: row.selection ?? "Unknown",
        hitRate: typeof row.hitRate === "number" && Number.isFinite(row.hitRate)
          ? row.hitRate
          : 0,
        confidence: confidenceValue(row.confidence),
        outcome: row.outcome as SettledOutcome,
      });
    }

    const matches = Array.from(groups.values())
      .sort((a, b) => b.matchDate.localeCompare(a.matchDate))
      .slice(0, limit);

    return Response.json({ ok: true, matches });
  } catch (error) {
    console.error(
      `[First5 Results] Could not load settled predictions: ${error instanceof Error ? error.message : String(error)}`,
    );
    return Response.json({ ok: true, matches: [] });
  }
}
