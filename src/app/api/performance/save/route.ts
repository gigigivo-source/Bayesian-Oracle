import { apiError } from "@/lib/apiErrors";
import { db } from "@/db";
import { performanceLog } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { ALL_RANKING_MODES, type RankingMode } from "@/lib/engine/selector";
import { asNumber, asRecord, roundTo } from "@/lib/data/sources/shared";

export const dynamic = "force-dynamic";

type TopPick = {
  name: string;
  selection: string;
  hitRate: number;
  outcome: "HIT" | "MISS" | "PENDING";
  family: string;
  reason: string | null;
  odds: number | null;
  factors: Record<string, number> | null;
};

type ValidPayload = {
  fixture: {
    id: string;
    leagueName: string;
    leagueSlug: string | null;
    date: string;
    homeName: string;
    awayName: string;
    homeScore: number;
    awayScore: number;
  };
  picks: TopPick[];
  rankingMode: RankingMode;
};

type ParseResult =
  | { ok: true; value: ValidPayload }
  | { ok: false; error: string };

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

/** Coerce a client-supplied ranking mode to A/B/C/D (defaults to B). */
function toMode(value: unknown): RankingMode {
  const v = typeof value === "string" ? value.toUpperCase() : "";
  return (ALL_RANKING_MODES as string[]).includes(v) ? (v as RankingMode) : "B";
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function score(value: unknown): number {
  const parsed = asNumber(value);
  return parsed === null ? 0 : Math.max(0, Math.trunc(parsed));
}

function sanitizeFactors(value: unknown): Record<string, number> | null {
  const record = asRecord(value);
  if (!record) return null;
  const factors: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record)) {
    const parsed = asNumber(raw);
    if (parsed !== null) factors[key] = parsed;
  }
  return Object.keys(factors).length > 0 ? factors : null;
}

function parsePayload(body: unknown): ParseResult {
  const root = asRecord(body);
  if (!root) return { ok: false, error: "Invalid request body" };

  const fixtureRaw = asRecord(root.fixture);
  const resultRaw = asRecord(root.result);
  if (!fixtureRaw || !resultRaw) {
    return { ok: false, error: "Missing fixture or result" };
  }

  const homeRaw = asRecord(fixtureRaw.home);
  const awayRaw = asRecord(fixtureRaw.away);
  if (!homeRaw || !awayRaw) {
    return { ok: false, error: "Invalid fixture teams" };
  }

  const id = requiredString(fixtureRaw.id);
  const leagueName = requiredString(fixtureRaw.leagueName);
  const date = requiredString(fixtureRaw.date);
  const homeName = requiredString(homeRaw.name);
  const awayName = requiredString(awayRaw.name);
  if (!id || !leagueName || !date || !homeName || !awayName) {
    return { ok: false, error: "Invalid fixture" };
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) {
    return { ok: false, error: "Invalid fixture date" };
  }

  const top10Raw = resultRaw.top10;
  if (!Array.isArray(top10Raw)) {
    return { ok: false, error: "Invalid top10" };
  }

  const picks: TopPick[] = [];
  for (const raw of top10Raw.slice(0, 10)) {
    const pick = asRecord(raw);
    if (!pick) return { ok: false, error: "Invalid top10 pick" };

    const name = requiredString(pick.name);
    const selection = requiredString(pick.selection);
    const family = requiredString(pick.family);
    const hitRate = asNumber(pick.hitRate);
    if (!name || !selection || !family || hitRate === null || hitRate < 0 || hitRate > 1) {
      return { ok: false, error: "Invalid top10 pick" };
    }

    const oddsRaw = pick.marketOdds ?? pick.fairOdds ?? null;
    const odds = oddsRaw === null ? null : asNumber(oddsRaw);
    if (odds !== null && odds <= 0) {
      return { ok: false, error: "Invalid pick odds" };
    }

    const outcomeRaw = optionalString(pick.outcome);
    const outcome: TopPick["outcome"] =
      outcomeRaw === "HIT" || outcomeRaw === "MISS" ? outcomeRaw : "PENDING";

    picks.push({
      name,
      selection,
      hitRate,
      outcome,
      family,
      reason: optionalString(pick.reason),
      odds,
      factors: sanitizeFactors(pick.factors),
    });
  }

  return {
    ok: true,
    value: {
      fixture: {
        id,
        leagueName,
        leagueSlug: optionalString(fixtureRaw.leagueSlug),
        date,
        homeName,
        awayName,
        homeScore: score(homeRaw.score),
        awayScore: score(awayRaw.score),
      },
      picks,
      rankingMode: toMode(root.rankingMode),
    },
  };
}

export async function POST(req: Request) {
  try {
  let body: unknown;
  try {
    body = await req.json();
  } catch (__caughtError) {
    console.error("[API] Swallowed upstream error at src/app/api/performance/save/route.ts:165", __caughtError);
    return badRequest("Invalid JSON body");
  }

  const parsed = parsePayload(body);
  if (!parsed.ok) return badRequest(parsed.error);

  const { fixture, picks, rankingMode } = parsed.value;

  try {
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

    const top10picks = picks.map((p) => ({
      name:      p.name,
      selection: p.selection,
      hitRate:   p.hitRate,
      outcome:   p.outcome,
      family:    p.family,
      reason:    p.reason,
      odds:      p.odds,
      // Edge vs market (hitRate × odds − 1); null when no market price.
      ev:        p.odds !== null ? roundTo(p.hitRate * p.odds - 1, 3) : null,
      factors:   p.factors,
    }));

    const hits    = top10picks.filter((p) => p.outcome === "HIT").length;
    const misses  = top10picks.filter((p) => p.outcome === "MISS").length;
    const pending = top10picks.filter((p) => p.outcome === "PENDING").length;
    const verified = hits + misses;

    const [row] = await db
      .insert(performanceLog)
      .values({
        eventId:    fixture.id,
        matchLabel: `${fixture.homeName} vs ${fixture.awayName}`,
        homeTeam:   fixture.homeName,
        awayTeam:   fixture.awayName,
        league:     fixture.leagueName,
        leagueSlug: fixture.leagueSlug,
        competitionName: fixture.leagueName,
        matchDate:  fixture.date.slice(0, 10),
        homeScore:  fixture.homeScore,
        awayScore:  fixture.awayScore,
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
    return apiError("Database query failed", err);
  }

  } catch (__routeError) {
    return apiError("POST /api/performance/save failed", __routeError);
  }
}
