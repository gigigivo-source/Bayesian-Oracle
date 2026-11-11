// V4 Predictor — auto fixture feed.
//
// The Prediction Engine is the ONLY source of scorelines for Locks. Every
// fixture must come back with an engine-derived Correct Score pick; there is
// deliberately no V2 fallback here. If the engine cannot run (missing
// DATABASE_URL, provider outage, no Correct Score market) the request fails
// loudly with a 500 that names the exact reason, instead of quietly returning
// null and letting the V4 rules invent a scoreline.

import type { FixtureLite } from "@/lib/espn";
import { fetchScoreboard, fetchSummary, getCurrentMatchweek } from "@/lib/espn";
import { translateTeamName } from "@/lib/v4-predictor";
import { NextResponse } from "next/server";

// The engine reads process.env (DATABASE_URL, provider keys) at request time.
// Force per-request rendering so those values come from the live runtime
// rather than a build-time snapshot.
export const dynamic = "force-dynamic";
// The engine runs once per fixture, so allow the same budget as daily-picks.
export const maxDuration = 60;

const DEFAULT_WEEK = 11;

const EXTRA_TEAM_MAP: Record<string, string> = {
  "AFC Bournemouth": "Bournemouth",
  "Wolverhampton Wanderers": "Wolves",
  "West Ham United": "West Ham",
  "Leicester City": "Leicester",
};

function toV4TeamName(name: string): string {
  const trimmed = name.trim();
  const stripped = trimmed.replace(/\s+(?:AFC|FC)$/i, "").trim();
  const mapped = EXTRA_TEAM_MAP[trimmed] ?? EXTRA_TEAM_MAP[stripped] ?? stripped;
  return translateTeamName(mapped);
}

function parseWeekParam(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 38) return NaN;
  return parsed;
}

/** Minimal shape of the engine markets this route reads. */
type ScoreMarket = {
  name: string;
  selection: string;
  hitRate: number;
};

type EngineModule = typeof import("@/lib/engine");

// Resolved lazily on the first request, never at module scope: a top-level
// import drags in src/db, which throws "DATABASE_URL is required" while the
// module graph is evaluated (build / cold start) instead of at request time.
// ESM caches the module, so this is one evaluation per process — not per
// fixture. A failed load is NOT memoized: the next request retries, so adding
// DATABASE_URL at runtime recovers without a redeploy.
let engineModule: Promise<EngineModule> | null = null;

function loadEngine(): Promise<EngineModule> {
  engineModule ??= import("@/lib/engine").catch((error: unknown) => {
    engineModule = null;
    throw error;
  });
  return engineModule;
}

const SCORELINE_RE = /(\d{1,2})-(\d{1,2})/;

/**
 * The engine's most likely scoreline, e.g. "2-1".
 *
 * The engine names these markets `Correct Score 2-1` with selection
 * `Score 2-1` and family `Goals` — the family is NOT "Correct Score", so the
 * market NAME is what identifies them. Every Correct Score market is scored
 * (rejected ones included), so this reads the full market list and takes the
 * highest hit rate. Returns null only when the engine produced no scoreline
 * at all, which the caller treats as a hard failure.
 */
function topCorrectScore(markets: readonly ScoreMarket[]): string | null {
  let best: { score: string; prob: number } | null = null;
  for (const m of markets) {
    if (!m.name.startsWith("Correct Score")) continue;
    const match = SCORELINE_RE.exec(m.name) ?? SCORELINE_RE.exec(m.selection);
    if (!match) continue;
    if (!best || m.hitRate > best.prob) {
      best = { score: `${match[1]}-${match[2]}`, prob: m.hitRate };
    }
  }
  return best ? best.score : null;
}

/**
 * Runs the Prediction Engine for one fixture and returns its top Correct
 * Score. Any engine failure propagates to GET's handler, which turns it into
 * a 500 carrying the original message — never a null that silently triggers
 * the V2 fallback rules.
 */
async function engineScoreline(
  runEngine: EngineModule["runEngineFromRealWithProfiles"],
  fixture: FixtureLite,
): Promise<string> {
  const label = `${fixture.home.name} vs ${fixture.away.name}`;

  // The summary is enrichment only: the engine is built to run with `null`
  // (fewer signals, same scoreline markets), so a provider hiccup here must
  // not block the pick. Failures are logged rather than swallowed silently.
  const summary = await fetchSummary(fixture.leagueSlug, fixture.id).catch(
    (error: unknown) => {
      console.warn("V4: summary unavailable", fixture.id, error);
      return null;
    },
  );

  // NO try/catch: a missing DB or key must abort the request with the real
  // error so the failure is diagnosable.
  const result = await runEngine(fixture, summary);
  const markets: readonly ScoreMarket[] = result?.markets ?? [];

  if (markets.length === 0) {
    throw new Error(`Engine returned no markets for ${label}`);
  }

  const score = topCorrectScore(markets);
  if (!score) {
    throw new Error(`Engine returned no Correct Score market for ${label}`);
  }
  return score;
}

export async function GET(request: Request) {
  // Tracks which half of the request failed so the 500 says where to look.
  let phase: "fixtures" | "engine" = "fixtures";

  try {
    const rawWeek = new URL(request.url).searchParams.get("week");
    const requestedWeek = parseWeekParam(rawWeek);
    if (Number.isNaN(requestedWeek)) {
      return NextResponse.json(
        { error: "Invalid week parameter. Expected an integer between 1 and 38." },
        { status: 400 },
      );
    }

    let week = requestedWeek;
    if (week === null) {
      try {
        week = await getCurrentMatchweek("eng.1");
      } catch {
        week = DEFAULT_WEEK;
      }
    }

    const fixtures = await fetchScoreboard("eng.1", undefined, week);

    const hasMatchweeks = fixtures.some((f) => typeof f.matchweek === "number");
    const forWeek = hasMatchweeks
      ? fixtures.filter((f) => f.matchweek === week)
      : fixtures;

    const sorted = [...forWeek].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    phase = "engine";

    // Resolve the engine before fanning out: one import per request, and a
    // missing DATABASE_URL fails here (500) rather than mid-way through N
    // fixtures.
    const { runEngineFromRealWithProfiles } = await loadEngine();

    const result = await Promise.all(sorted.map(async (f) => {
      // Guaranteed non-null: engineScoreline throws instead of returning null,
      // so generatePredictions() can never fall back to the V2 lock rules.
      const enginePrediction = await engineScoreline(runEngineFromRealWithProfiles, f);
      const homeScore = f.home.score;
      const awayScore = f.away.score;
      const hasScore =
        homeScore !== null && homeScore !== "" && awayScore !== null && awayScore !== "";
      const actual =
        f.state === "post" &&
        hasScore &&
        Number.isFinite(Number(homeScore)) &&
        Number.isFinite(Number(awayScore))
          ? [Number(homeScore), Number(awayScore)]
          : null;
      return {
        home: { name: toV4TeamName(f.home.name), logo: f.home.logo ?? null },
        away: { name: toV4TeamName(f.away.name), logo: f.away.logo ?? null },
        state: f.state,
        actual,
        enginePrediction,
      };
    }));

    return NextResponse.json({ week, fixtures: result });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`V4 auto-fetch failed (${phase} phase)`, error);
    return NextResponse.json(
      {
        error: phase === "engine" ? "Prediction Engine failed" : "Failed to fetch",
        phase,
        detail,
      },
      { status: 500 },
    );
  }
}
