// ĞIGI GIVØ — First 5 Minutes settled results.
//
// The "what actually happened" feed behind the Recent Results section of the
// main First 5 Minutes board: the settled picks of the last N days, read
// straight from performance_log (feature = 'first5') and grouped back into one
// entry per match.
//
// The rows are written by /api/first-5-minutes (feature = 'first5',
// outcome = 'pending') and settled by the feature pass of /api/cron/settle,
// which stamps home_score / away_score, outcome (WIN | LOSS | PUSH | VOID) and
// settled_at on every market row of a finished match. This route only READS:
// nothing here writes, mutates or re-settles, and no auth is required — like
// the other read-only First 5 endpoints it exposes published pick history only.
//
// GET /api/first-5-minutes/results?limit=30&days=14
//   limit  maximum number of MATCHES returned (default 30, max 100)
//   days   look-back window on match_date (default 14)
//
// Response: { ok: true, matches: [ First5ResultMatch, ... ] } — newest first.
//
// Fail-soft by contract: a database error is logged once and answered with an
// empty list, never a 5xx, so the page's settled section falls back to its
// placeholder while the upcoming-fixtures board keeps working.

import { performanceLog } from "@/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** performance_log discriminator for First 5 Minutes picks. */
const FEATURE = "first5";
/** Outcomes the settlement cron stamps on settled feature rows. */
const SETTLED_OUTCOMES = ["WIN", "LOSS", "PUSH", "VOID"] as const;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const DEFAULT_DAYS = 14;
const MAX_DAYS = 365;
/**
 * Row fetch factor: one match contributes one row per published market
 * (goal / corner / card — the penalty market does not exist; see the main
 * route). Four covers a legacy row set with a fourth market; a match with
 * fewer rows simply yields fewer, and nothing is padded.
 */
const ROWS_PER_MATCH = 4;
const CONFIDENCE_TIERS = ["HIGH", "MEDIUM", "LOW"] as const;

export type First5Confidence = (typeof CONFIDENCE_TIERS)[number];
export type First5SettledOutcome = (typeof SETTLED_OUTCOMES)[number];

/** One settled market inside a finished match. */
export interface First5ResultMarket {
  /** Stored market label, e.g. "Goal in First 5 Minutes". */
  market: string;
  /** The side the pick was on — "Yes" or "No". */
  selection: string;
  /** The model's claimed probability at pick time (0–1). */
  hitRate: number;
  confidence: First5Confidence;
  outcome: First5SettledOutcome;
}

/** One finished match with every settled market it carried. */
export interface First5ResultMatch {
  eventId: string;
  matchLabel: string;
  league: string;
  leagueSlug: string;
  /** YYYY-MM-DD. */
  matchDate: string;
  homeScore: number | null;
  awayScore: number | null;
  markets: First5ResultMarket[];
}

export interface First5ResultsResponse {
  ok: true;
  matches: First5ResultMatch[];
}

// ─── Input parsing ────────────────────────────────────────────────────────────

/**
 * Clamp a query param to an integer inside [min, max], falling back when
 * unusable. An absent or blank param is the fallback — `Number(null)` is 0,
 * which would silently pin every default to the minimum.
 */
function boundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** ISO day string N days before `reference` (inclusive window boundary). */
function dayOffset(reference: Date, days: number): string {
  const date = new Date(reference.getTime());
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

// ─── Row normalisation ────────────────────────────────────────────────────────
// The pg driver hands back numeric columns as strings and nullable text as
// null, so every value is coerced once, here, instead of in the UI.

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A settled first5 row always carries the tier stored at pick time; an
 *  unrecognisable value is presented at the lowest tier rather than dropped —
 *  the pick itself is real and its outcome is already settled. */
function asConfidence(value: unknown): First5Confidence {
  const tier = asText(value).toUpperCase();
  return (CONFIDENCE_TIERS as readonly string[]).includes(tier)
    ? (tier as First5Confidence)
    : "LOW";
}

/** Claimed probability as a number; a row without one reports 0 rather than NaN. */
function asHitRate(value: unknown): number {
  const rate = typeof value === "number" ? value : Number(value);
  return Number.isFinite(rate) ? rate : 0;
}

/** Integer final score, or null while no source has published one. */
function asScore(value: unknown): number | null {
  const score = typeof value === "number" ? value : Number(value);
  return Number.isInteger(score) ? score : null;
}

/** YYYY-MM-DD slice of the stored match date. */
function asMatchDate(value: unknown): string {
  return asText(value).slice(0, 10);
}

/** ISO day strings sort chronologically, so a lexicographic compare is the window test. */
function isWithinWindow(matchDate: string, windowStart: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(matchDate) && matchDate >= windowStart;
}

function isSettled(outcome: string): outcome is First5SettledOutcome {
  return (SETTLED_OUTCOMES as readonly string[]).includes(outcome);
}

/** One performance_log row as this route consumes it. */
interface SettledRow {
  eventId: string;
  matchLabel: string;
  league: string;
  leagueSlug: string;
  matchDate: string;
  homeScore: number | null;
  awayScore: number | null;
  market: string;
  selection: string;
  hitRate: number;
  confidence: string;
  outcome: string;
}

/**
 * Group settled rows into one entry per eventId, newest match first.
 *
 * `limit` caps the number of MATCHES returned (the SQL row limit is the
 * matching × ROWS_PER_MATCH budget) and `windowStart` re-checks the date
 * window in JS: the WHERE clause is the authoritative window, but a row that
 * arrives outside it (clock skew between the app server and the database, or
 * a match_date that is not an ISO day) must never surface as a result.
 */
function groupRows(rows: SettledRow[], limit: number, windowStart: string): First5ResultMatch[] {
  const groups = new Map<string, First5ResultMatch>();

  for (const row of rows) {
    const outcome = asText(row.outcome).toUpperCase();
    const matchDate = asMatchDate(row.matchDate);
    if (!isSettled(outcome) || !isWithinWindow(matchDate, windowStart)) continue;

    const eventId = asText(row.eventId);
    if (!eventId) continue;

    const market: First5ResultMarket = {
      market: asText(row.market),
      selection: asText(row.selection),
      hitRate: asHitRate(row.hitRate),
      confidence: asConfidence(row.confidence),
      outcome,
    };

    const existing = groups.get(eventId);
    if (existing) {
      existing.markets.push(market);
      continue;
    }

    groups.set(eventId, {
      eventId,
      matchLabel: asText(row.matchLabel),
      league: asText(row.league),
      leagueSlug: asText(row.leagueSlug),
      matchDate,
      homeScore: asScore(row.homeScore),
      awayScore: asScore(row.awayScore),
      markets: [market],
    });
  }

  return Array.from(groups.values())
    // Newest first. Array.prototype.sort is stable, so matches sharing a day
    // keep the SQL order (match_date DESC, id DESC).
    .sort((left, right) => right.matchDate.localeCompare(left.matchDate))
    .slice(0, limit);
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = boundedInt(url.searchParams.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const days = boundedInt(url.searchParams.get("days"), DEFAULT_DAYS, 1, MAX_DAYS);
  const windowStart = dayOffset(new Date(), days);

  try {
    // Imported inside the try so a deployment without a reachable database
    // (or without DATABASE_URL at all) still answers with the empty feed
    // instead of failing the module load.
    const { db } = await import("@/db");
    const rows = (await db
      .select({
        eventId: performanceLog.eventId,
        matchLabel: performanceLog.matchLabel,
        league: performanceLog.league,
        leagueSlug: performanceLog.leagueSlug,
        matchDate: performanceLog.matchDate,
        homeScore: performanceLog.homeScore,
        awayScore: performanceLog.awayScore,
        market: performanceLog.market,
        selection: performanceLog.selection,
        hitRate: performanceLog.hitRate,
        confidence: performanceLog.confidence,
        outcome: performanceLog.outcome,
      })
      .from(performanceLog)
      .where(and(
        eq(performanceLog.feature, FEATURE),
        inArray(performanceLog.outcome, [...SETTLED_OUTCOMES]),
        // match_date is a TEXT column holding an ISO day, so the window is
        // compared as text against the same shape: ISO day strings order
        // chronologically, and the comparison can never throw on a malformed
        // value the way `match_date::date` would (a single bad row would
        // otherwise blank the whole section). Evaluated in UTC so the database
        // window and the app-server guard below agree to the day.
        sql`left(${performanceLog.matchDate}, 10) >= to_char((now() at time zone 'UTC') - interval '${sql.raw(String(days))} days', 'YYYY-MM-DD')`,
      ))
      .orderBy(desc(performanceLog.matchDate), desc(performanceLog.id))
      .limit(limit * ROWS_PER_MATCH)) as unknown as SettledRow[];

    const matches = groupRows(Array.isArray(rows) ? rows : [], limit, windowStart);
    console.info(
      `[First5][results] ${matches.length} finished match(es) from the last ${days} day(s) ` +
      `(${matches.reduce((sum, match) => sum + match.markets.length, 0)} settled market rows).`,
    );

    return Response.json(
      { ok: true, matches } satisfies First5ResultsResponse,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.warn(
      `[First5][results] settled-results read failed (returning an empty list): ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    return Response.json(
      { ok: true, matches: [] } satisfies First5ResultsResponse,
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
