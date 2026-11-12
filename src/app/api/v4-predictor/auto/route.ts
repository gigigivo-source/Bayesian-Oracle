import * as espn from "@/lib/espn";
import { generatePredictions, getV2Outcome, translateTeamName } from "@/lib/v4-predictor";
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

/** Pick the most likely engine scoreline with the outcome selected by V2. */
function topCorrectScore(
  markets: Array<{ name: string; hitRate: number }>,
  outcome: "H" | "D" | "A",
): string | null {
  let best: { score: string; prob: number } | null = null;
  for (const m of markets) {
    const match = /^Correct Score (\d{1,2})-(\d{1,2})$/.exec(m.name);
    if (!match || !Number.isFinite(m.hitRate)) continue;
    const score = `${match[1]}-${match[2]}`;
    if (getV2Outcome(score) !== outcome) continue;
    if (!best || m.hitRate > best.prob) {
      best = { score, prob: m.hitRate };
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

  // Evaluate the V2 rules across the sorted week, not per fixture: Snipe
  // quotas affect the outcome of later fixtures.
  const v2Predictions = generatePredictions(sorted.map((fx) => ({
    home: toV4TeamName(fx.home.name),
    away: toV4TeamName(fx.away.name),
  })));

  // The engine is loaded at REQUEST time via a dynamic import so the module
  // graph (@/lib/engine/engine → @/lib/engine/dataMesh → @/db) is evaluated
  // with the runtime environment already in place. Importing the engine
  // statically at the top of this file would evaluate @/db at module load
  // time and crash the route with "DATABASE_URL is required".
  //
  // There is deliberately NO catch around the engine call (or the summary
  // fetch): if the database, keys, or data feeds fail, the error propagates
  // and Next.js returns a 500 with the full cause in the server logs.
  const { runEngineFromRealWithProfiles } = await import("@/lib/engine/engine");

  const result = await Promise.all(
    sorted.map(async (fx, index) => {
      const summary = await espn.fetchSummary(fx.leagueSlug, fx.id);
      const engineResult = await runEngineFromRealWithProfiles(fx, summary);
      const enginePrediction = topCorrectScore(
        engineResult.markets, getV2Outcome(v2Predictions[index].Prediction),
      );

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
