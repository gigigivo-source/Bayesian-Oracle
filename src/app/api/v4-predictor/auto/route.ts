import * as espn from "@/lib/espn";
import { generatePredictions, getV2Outcome, translateTeamName } from "@/lib/v4-predictor";
import { NextResponse } from "next/server";
import type { Market } from "@/lib/engine/types";

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

/** Pick the most probable score for the engine's most probable 1X2 outcome. */
function winnerFirstScore(markets: Market[], home: string, away: string): string | null {
  const outcomeForSelection = (selection: string): "H" | "D" | "A" | null => {
    const value = selection.trim().toLowerCase();
    if (["home", "home win", "1", `${home.toLowerCase()} win`].includes(value)) return "H";
    if (["draw", "x"].includes(value)) return "D";
    if (["away", "away win", "2", `${away.toLowerCase()} win`].includes(value)) return "A";
    return null;
  };

  let bestOutcome: { outcome: "H" | "D" | "A"; hitRate: number } | null = null;
  for (const market of markets) {
    // The engine emits e.g. "Match Result: Arsenal Win", one row per outcome.
    if (market.family !== "Goals" || !/^(?:1X2|(?:Match )?Result)(?::.*)?$/i.test(market.name)) continue;
    const outcome = outcomeForSelection(market.selection);
    if (!outcome || !Number.isFinite(market.hitRate)) continue;
    if (!bestOutcome || market.hitRate > bestOutcome.hitRate) {
      bestOutcome = { outcome, hitRate: market.hitRate };
    }
  }
  if (!bestOutcome) return null;

  let bestScore: { score: string; hitRate: number } | null = null;
  for (const market of markets) {
    if (market.family !== "Goals" || !Number.isFinite(market.hitRate)) continue;
    const match = /^Correct Score (\d{1,2}-\d{1,2})$/i.exec(market.name)
      ?? (market.name === "Correct Score" ? /^(?:Score )?(\d{1,2}-\d{1,2})$/i.exec(market.selection) : null);
    if (!match || getV2Outcome(match[1]) !== bestOutcome.outcome) continue;
    if (!bestScore || market.hitRate > bestScore.hitRate) {
      bestScore = { score: match[1], hitRate: market.hitRate };
    }
  }
  return bestScore?.score ?? null;
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

  // Import at most once per request, and only if a non-Snipe needs the engine.
  // Import failures (including missing database configuration) are also fallback cases.
  const engineModule = v2Predictions.some((prediction) => !prediction.Category.includes("SNIPE"))
    ? import("@/lib/engine/engine").catch((error) => {
        console.error("[v4-predictor] Engine unavailable; using V2", error);
        return null;
      })
    : null;

  const result = await Promise.all(
    sorted.map(async (fx, index) => {
      const v2Pred = v2Predictions[index];
      let finalPrediction = v2Pred.Prediction;
      let finalCategory = v2Pred.Category;
      let enginePrediction: string | null = null;

      if (!v2Pred.Category.includes("SNIPE")) {
        try {
          const loadedEngine = await engineModule;
          if (!loadedEngine) throw new Error("Engine unavailable");
          const summary = await espn.fetchSummary(fx.leagueSlug, fx.id);
          const engineResult = await loadedEngine.runEngineFromRealWithProfiles(fx, summary);
          if (Number.isFinite(engineResult.match.dataCompletenessScore) && engineResult.match.dataCompletenessScore >= 50) {
            enginePrediction = winnerFirstScore(engineResult.markets, fx.home.name, fx.away.name);
            if (enginePrediction) {
              finalPrediction = enginePrediction;
              finalCategory = "ENGINE: Winner-First";
            }
          }
        } catch (error) {
          console.error(`[v4-predictor] Engine failed for fixture ${fx.id}; using V2`, error);
        }
      }

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
        finalPrediction,
        finalCategory,
      };
    }),
  );

  return NextResponse.json({ week, fixtures: result });
}
