// ĞIGI GIVØ — Weekly Accumulator
//
// Builds ONE 3–4 leg ticket per week from the best markets across Europe's
// top competitions. Every leg must be a high hit-rate, positive-EV market
// priced between 1.25 and 1.55, and the combined ticket must land between
// 3.0 and 4.5.
//
// IMPORTANT — this route REUSES the already-computed Top-10 output. It does
// NOT re-run the prediction engine. The engine's per-match Top-10 markets are
// already persisted (by /api/match) in the `predictions.result` jsonb column;
// here we read that output back, take each match's top-3 markets, and build
// the weekly ticket from those candidates.
//
// "Odds" for a leg is the bookmaker price the engine exposes when one exists
// (`marketOdds`), otherwise the conservative worst-case fair price
// (`fairOddsWorst` = 1 / ciLower). Using the lower bound of the 95% confidence
// interval means the "EV" reported here (hitRate × odds − 1) is the edge at
// the WORST-case probability — a deliberately conservative, honest number that
// also naturally places hit-rate ~0.80–0.86 legs in the required 1.25–1.55
// band (fair odds for an 80% pick are 1.25, so a real margin is required).

import { fetchScoreboard, type FixtureLite } from "@/lib/espn";
import type { Market } from "@/lib/engine/types";
import { db } from "@/db";
import { predictions } from "@/db/schema";
import { desc, inArray } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─── Config ───────────────────────────────────────────────────────────────────

// Europe's top competitions only — exactly the leagues this feature covers.
const LEAGUE_SLUGS = [
  "eng.1",
  "esp.1",
  "ger.1",
  "ita.1",
  "fra.1",
  "uefa.champions",
  "uefa.europa",
  "uefa.europa.conf",
] as const;

const LOOKAHEAD_DAYS = 7;

// Step 2 — leg filters.
const MIN_HIT_RATE = 0.80;
const MIN_EV = 0.03;
const MIN_ODDS = 1.25;
const MAX_ODDS = 1.55;

// Step 3 — ticket constraints.
const MIN_COMBINED_ODDS = 3.0;
const MAX_COMBINED_ODDS = 4.5;
const MIN_LEGS = 3;
const MAX_LEGS = 4;

// Step 3 — stake sizing.
const HALF_KELLY_FRACTION = 0.5;
const MAX_STAKE_FRACTION = 0.02; // cap at 2% of bankroll

// Cap the rejected panel so a quiet week can't balloon the payload.
const MAX_REJECTED = 60;

// 1-hour server cache (see the in-memory cache below). ?refresh=true bypasses.
const CACHE_TTL_MS = 60 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

type StatFamily = "goals" | "corners" | "cards" | "shots" | "other";
type DataQuality = "Real" | "Mixed" | "Synthetic";

interface CandidateLeg {
  eventId: string;
  match: string;
  league: string;
  kickoff: string;
  market: string;
  selection: string;
  hitRate: number;
  odds: number;
  ev: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  dataQuality: DataQuality;
  statFamily: StatFamily;
}

interface Ticket {
  legs: Array<{
    eventId: string;
    match: string;
    league: string;
    kickoff: string;
    market: string;
    selection: string;
    odds: number;
    hitRate: number;
    ev: number;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    dataQuality: DataQuality;
    statFamily: StatFamily;
  }>;
  combinedOdds: number;
  combinedProbability: number;
  combinedEv: number;
  recommendedStakePercent: number;
}

interface WeeklyAccumulatorResponse {
  week: string;
  candidates: number;
  qualified: number;
  ticket: Ticket | null;
  rejected: Array<{ match: string; reason: string }>;
  generatedAt: string;
  /** Present only when no ticket could be built — explains why, honestly. */
  reason?: string;
}

/** The slice of the persisted EngineResult this route reads back. */
interface StoredResult {
  top10?: Market[];
  markets?: Market[];
  match?: { dataCompletenessScore?: number; fallbackMode?: boolean };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** "YYYY-MM-DD to YYYY-MM-DD" for the Monday–Sunday of the upcoming week. */
function weekLabel(now: Date): string {
  const day = now.getUTCDay(); // 0 = Sun … 6 = Sat
  const daysToMonday = day === 1 ? 0 : day === 0 ? 1 : 8 - day;
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMonday),
  );
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return `${monday.toISOString().slice(0, 10)} to ${sunday.toISOString().slice(0, 10)}`;
}

/**
 * Collapse the engine's market families into the five accumulator buckets.
 * The engine's football families are "Goals", "Corners", "Yellow Cards",
 * "Shots on Target", "Shots Towards Goal", "Saves", "Offsides", "Goal Kicks",
 * "Possession / Metrics", "Interceptions", "Throw-ins",
 * "Penalty / Sending Off", "Advanced Events", "Goal Sequence", "Goalkeeper",
 * "Consecutive Goals" (plus tennis families Aces/Double Faults/Break Points).
 */
function statFamilyOf(family: string | undefined): StatFamily {
  const f = (family ?? "").toLowerCase();
  if (f.includes("corner")) return "corners";
  if (f.includes("card")) return "cards";
  if (f.includes("shot") || f === "saves" || f.includes("sot")) return "shots";
  if (f === "goalkeeper" || f.includes("goal kick")) return "other";
  if (f === "goals" || f === "goal sequence" || f === "consecutive goals") return "goals";
  return "other";
}

/**
 * Match-level data quality derived from the persisted engine result. Mirrors
 * the two conventions already in /api/match: `fallbackMode` (or a completeness
 * score < 45) means the aggregator fell back to synthetic data, and the 80%
 * field-completeness bar is the "Real" threshold — the band in between is
 * Mixed. Synthetic legs are excluded from the ticket.
 */
function dataQualityOf(match: StoredResult["match"]): DataQuality {
  const completeness = match?.dataCompletenessScore;
  if (match?.fallbackMode) return "Synthetic";
  if (completeness == null) return "Mixed";
  if (completeness < 45) return "Synthetic";
  if (completeness >= 80) return "Real";
  return "Mixed";
}

function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Conservative bookmaker-style price for a market, in priority order. */
function legOdds(m: Market): number | null {
  const odds = m.marketOdds ?? m.fairOddsWorst ?? m.fairOdds ?? null;
  if (odds == null || !Number.isFinite(odds) || odds <= 1) return null;
  return round(odds, 2);
}

/** First failing filter, or null when the leg qualifies (Step 2). */
function rejectionReason(leg: CandidateLeg): string | null {
  if (leg.dataQuality === "Synthetic") {
    return "synthetic data (dataQuality Synthetic)";
  }
  if (leg.confidence === "LOW") {
    return "confidence LOW below MEDIUM";
  }
  if (leg.hitRate < MIN_HIT_RATE) {
    return `hit rate ${leg.hitRate.toFixed(2)} below ${MIN_HIT_RATE.toFixed(2)}`;
  }
  if (leg.odds < MIN_ODDS) {
    return `odds ${leg.odds.toFixed(2)} below ${MIN_ODDS.toFixed(2)}`;
  }
  if (leg.odds > MAX_ODDS) {
    return `odds ${leg.odds.toFixed(2)} above ${MAX_ODDS.toFixed(2)}`;
  }
  if (leg.ev <= MIN_EV) {
    return `EV ${leg.ev.toFixed(3)} not above ${MIN_EV.toFixed(2)}`;
  }
  return null;
}

// ─── Ticket builder (Step 3) ──────────────────────────────────────────────────

function buildTicket(qualified: CandidateLeg[]): Ticket | null {
  // Sort by EV descending, then greedily walk the list.
  const sorted = [...qualified].sort((a, b) => b.ev - a.ev);

  const usedMatches = new Set<string>();
  const usedFamilies = new Set<StatFamily>();
  const legs: CandidateLeg[] = [];
  let combinedOdds = 1;

  for (const leg of sorted) {
    if (legs.length >= MAX_LEGS) break;
    // One leg per match — no two bets from the same event.
    if (usedMatches.has(leg.eventId)) continue;
    // No two legs from the same stat family — prevents correlated
    // goals/corners/cards legs on the same slip.
    if (usedFamilies.has(leg.statFamily)) continue;
    const nextOdds = combinedOdds * leg.odds;
    if (nextOdds > MAX_COMBINED_ODDS) continue; // would exceed the 4.5 cap
    legs.push(leg);
    usedMatches.add(leg.eventId);
    usedFamilies.add(leg.statFamily);
    combinedOdds = nextOdds;
  }

  if (legs.length < MIN_LEGS) return null;
  if (combinedOdds < MIN_COMBINED_ODDS) return null;

  const combinedProbability = legs.reduce((p, l) => p * l.hitRate, 1);
  const combinedEv = combinedProbability * combinedOdds - 1;
  const halfKelly = HALF_KELLY_FRACTION * (combinedEv / (combinedOdds - 1));
  const stakeFraction = Math.max(0, Math.min(halfKelly, MAX_STAKE_FRACTION));
  const recommendedStakePercent = Math.round(stakeFraction * 1000) / 10;

  return {
    legs: legs.map((l) => ({ ...l, odds: round(l.odds, 2), ev: round(l.ev, 3) })),
    combinedOdds: round(combinedOdds, 2),
    combinedProbability: round(combinedProbability, 3),
    combinedEv: round(combinedEv, 3),
    recommendedStakePercent,
  };
}

// ─── Core scan ────────────────────────────────────────────────────────────────

async function buildWeeklyAccumulator(now: Date): Promise<WeeklyAccumulatorResponse> {
  const to = new Date(now);
  to.setDate(now.getDate() + LOOKAHEAD_DAYS);
  const range = `${fmt(now)}-${fmt(to)}`;

  // 1. Fixture feed — every match in the next 7 days for the 8 target leagues.
  const boards = await Promise.all(
    LEAGUE_SLUGS.map((slug) => fetchScoreboard(slug, range).catch(() => [] as FixtureLite[])),
  );

  const seen = new Set<string>();
  const fixtures = boards
    .flat()
    .filter((fx) => {
      if (fx.state !== "pre") return false; // upcoming matches only
      if (seen.has(fx.id)) return false;
      seen.add(fx.id);
      return true;
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // 2. Reuse the persisted Top-10 output (written by /api/match) — no engine run.
  const ids = fixtures.map((fx) => fx.id);
  const storedByEvent = new Map<string, StoredResult>();
  if (ids.length > 0) {
    try {
      const rows = await db
        .select({
          eventId: predictions.eventId,
          result: predictions.result,
          createdAt: predictions.createdAt,
        })
        .from(predictions)
        .where(inArray(predictions.eventId, ids))
        .orderBy(desc(predictions.createdAt));
      for (const row of rows) {
        if (!row.eventId || storedByEvent.has(row.eventId)) continue;
        storedByEvent.set(row.eventId, (row.result ?? {}) as StoredResult);
      }
    } catch {
      // Database unavailable → no stored output; the honest "no ticket" result
      // is returned rather than a 500.
    }
  }

  // 3. Scan candidate legs (top-3 markets per match) and apply Step-2 filters.
  const rejected: Array<{ match: string; reason: string }> = [];
  const qualified: CandidateLeg[] = [];
  let candidates = 0;

  for (const fx of fixtures) {
    const stored = storedByEvent.get(fx.id);
    const top3 = (stored?.top10 ?? []).slice(0, 3);
    if (top3.length === 0) continue; // no persisted Top-10 output for this match

    const dataQuality = dataQualityOf(stored?.match);
    const matchLabel = `${fx.home.name} vs ${fx.away.name}`;

    for (const m of top3) {
      const odds = legOdds(m);
      candidates++;
      if (odds == null) {
        rejected.push({ match: matchLabel, reason: "no price available for this market" });
        continue;
      }

      const leg: CandidateLeg = {
        eventId: fx.id,
        match: matchLabel,
        league: fx.leagueName,
        kickoff: fx.date,
        market: m.name,
        selection: m.selection,
        hitRate: m.hitRate,
        odds,
        ev: round(m.hitRate * odds - 1, 3),
        confidence: m.confidence,
        dataQuality,
        statFamily: statFamilyOf(m.family),
      };

      const reason = rejectionReason(leg);
      if (reason) {
        if (rejected.length < MAX_REJECTED) rejected.push({ match: matchLabel, reason });
      } else {
        qualified.push(leg);
      }
    }
  }

  // 4. Build the ticket (or explain why there isn't one).
  const ticket = buildTicket(qualified);
  let reason: string | undefined;
  if (!ticket) {
    const families = new Set(qualified.map((l) => l.statFamily));
    if (qualified.length < MIN_LEGS) {
      reason = `Only ${qualified.length} qualified leg${qualified.length === 1 ? "" : "s"} across ${families.size} stat family ${families.size === 1 ? "" : "families"} — need at least ${MIN_LEGS} legs across different stat families.`;
    } else {
      reason = `${qualified.length} legs qualified but no ${MIN_LEGS}–${MAX_LEGS} leg combination lands in the ${MIN_COMBINED_ODDS}–${MAX_COMBINED_ODDS} combined-odds band.`;
    }
  }

  return {
    week: weekLabel(now),
    candidates,
    qualified: qualified.length,
    ticket,
    rejected,
    generatedAt: now.toISOString(),
    reason,
  };
}

// ─── 1-hour in-memory cache + ?refresh=true ───────────────────────────────────

interface CacheEntry {
  data: WeeklyAccumulatorResponse;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(url: URL): string {
  const key = new URL(url.toString());
  key.searchParams.delete("refresh");
  return key.pathname + key.search;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const isRefresh = url.searchParams.get("refresh") === "true";
  const key = cacheKey(url);

  if (!isRefresh) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return Response.json(cached.data, {
        headers: { "Cache-Control": "no-store", "X-Cache": "HIT" },
      });
    }
    if (cached) cache.delete(key);
  } else {
    cache.delete(key);
  }

  const body = await buildWeeklyAccumulator(new Date());
  cache.set(key, { data: body, timestamp: Date.now() });

  return Response.json(body, {
    headers: {
      "Cache-Control": "no-store",
      "X-Cache": isRefresh ? "REFRESH" : "MISS",
    },
  });
}
