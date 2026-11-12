import * as espn from "@/lib/espn";
import { translateTeamName } from "@/lib/v4-predictor";
import { NextResponse } from "next/server";

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

/**
 * The engine's top predicted scoreline: the Correct Score market with the
 * highest probability (e.g. "2-1"). Returns null if none is present.
 *
 * NOTE: the engine's Correct Score markets belong to the "Goals" family, so
 * they are matched by their market NAME (`Correct Score h-a`) rather than by
 * family. `result.markets` contains every market the registry built, including
 * Correct Score lines, so this always sees the full CS grid.
 */
function topCorrectScore(
  markets: Array<{ name: string; hitRate: number }>,
): string | null {
  let best: { score: string; prob: number } | null = null;
  for (const m of markets) {
    const match = /^Correct Score (\d{1,2})-(\d{1,2})$/.exec(m.name);
    if (!match) continue;
    if (!best || m.hitRate > best.prob) {
      best = { score: `${match[1]}-${match[2]}`, prob: m.hitRate };
    }
  }
  return best ? best.score : null;
}

export async function GET(request: Request) {
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
      week =
        typeof espn.getCurrentMatchweek === "function"
          ? await espn.getCurrentMatchweek("eng.1")
          : DEFAULT_WEEK;
    } catch {
      week = DEFAULT_WEEK;
    }
  }

  const fixtures = await espn.fetchScoreboard("eng.1", undefined, week);

  const hasMatchweeks = fixtures.some((f) => typeof f.matchweek === "number");
  const forWeek = hasMatchweeks
    ? fixtures.filter((f) => f.matchweek === week)
    : fixtures;

  const sorted = [...forWeek].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  // The engine is loaded at REQUEST time via a dynamic import so the module
  // graph (@/lib/engine/engine → @/lib/engine/dataMesh → @/db) is evaluated
  // with the runtime environment already in place. Importing the engine
  // statically at the top of this file would evaluate @/db at module load
  // time and crash the route with "DATABASE_URL is required".
  //
  // There is deliberately NO catch around the engine call (or the summary
  // fetch): if the database, keys, or data feeds fail, the error propagates
  // and Next.js returns a 500 with the full cause in the server logs. The V4
  // Predictor must never silently fall back to V2 rules for Locks.
  const { runEngineFromRealWithProfiles } = await import("@/lib/engine/engine");

  const result = await Promise.all(
    sorted.map(async (fx) => {
      const summary = await espn.fetchSummary(fx.leagueSlug, fx.id);
      const engineResult = await runEngineFromRealWithProfiles(fx, summary);
      const enginePrediction = topCorrectScore(engineResult.markets);

      const homeScore = fx.home.score;
      const awayScore = fx.away.score;
      const hasScore =
        homeScore !== null &&
        homeScore !== "" &&
        awayScore !== null &&
        awayScore !== "";
      const actual =
        fx.state === "post" &&
        hasScore &&
        Number.isFinite(Number(homeScore)) &&
        Number.isFinite(Number(awayScore))
          ? [Number(homeScore), Number(awayScore)]
          : null;

      return {
        home: { name: toV4TeamName(fx.home.name), logo: fx.home.logo ?? null },
        away: { name: toV4TeamName(fx.away.name), logo: fx.away.logo ?? null },
        state: fx.state,
        actual,
        enginePrediction,
      };
    }),
  );

  return NextResponse.json({ week, fixtures: result });
}
