import * as espn from "@/lib/espn";
import type { EngineResult } from "@/lib/engine";
import { generatePredictions, translateTeamName } from "@/lib/v4-predictor";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// The engine runs once per non-Snipe fixture, so allow the same budget as daily-picks.
export const maxDuration = 60;

const DEFAULT_WEEK = 11;
const MIN_COMPLETENESS_SCORE = 50;

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

type Outcome1X2 = "Home" | "Draw" | "Away";

type MarketLike = {
  family?: string;
  name: string;
  selection?: string;
  hitRate: number;
};

function classify1X2Outcome(
  market: MarketLike,
  homeNames: string[],
  awayNames: string[],
): Outcome1X2 | null {
  const name = market.name.trim();
  const sel = (market.selection ?? "").trim();

  for (const h of homeNames) {
    if (!h) continue;
    if (
      name === `Match Result: ${h} Win` ||
      name === `1X2: ${h} Win` ||
      name === `1X2: ${h}` ||
      name === `Result: ${h} Win` ||
      sel === `${h} Win` ||
      sel === h
    ) {
      return "Home";
    }
  }

  for (const a of awayNames) {
    if (!a) continue;
    if (
      name === `Match Result: ${a} Win` ||
      name === `1X2: ${a} Win` ||
      name === `1X2: ${a}` ||
      name === `Result: ${a} Win` ||
      sel === `${a} Win` ||
      sel === a
    ) {
      return "Away";
    }
  }

  if (
    name === "Match Result: Draw" ||
    /:\s*Draw$/i.test(name) ||
    /^(?:Draw|X)$/i.test(sel)
  ) {
    return "Draw";
  }

  if (
    /:\s*(?:Home(?:\s+Win)?|1)$/i.test(name) ||
    /^(?:Home(?:\s+Win)?|1)$/i.test(sel)
  ) {
    return "Home";
  }

  if (
    /:\s*(?:Away(?:\s+Win)?|2)$/i.test(name) ||
    /^(?:Away(?:\s+Win)?|2)$/i.test(sel)
  ) {
    return "Away";
  }

  return null;
}

function parseCorrectScore(
  market: MarketLike,
): { homeScore: number; awayScore: number; score: string } | null {
  const fromName = /^Correct Score (\d{1,2})-(\d{1,2})$/.exec(market.name.trim());
  if (fromName) {
    const homeScore = Number(fromName[1]);
    const awayScore = Number(fromName[2]);
    return { homeScore, awayScore, score: `${homeScore}-${awayScore}` };
  }
  if (market.name.trim() === "Correct Score" && market.selection) {
    const fromSel = /^(?:Score\s+)?(\d{1,2})-(\d{1,2})$/i.exec(
      market.selection.trim(),
    );
    if (fromSel) {
      const homeScore = Number(fromSel[1]);
      const awayScore = Number(fromSel[2]);
      return { homeScore, awayScore, score: `${homeScore}-${awayScore}` };
    }
  }
  return null;
}

function matchesOutcome(
  homeScore: number,
  awayScore: number,
  outcome: Outcome1X2,
): boolean {
  if (outcome === "Home") return homeScore > awayScore;
  if (outcome === "Draw") return homeScore === awayScore;
  return homeScore < awayScore;
}

/**
 * Layer 2 (Engine Winner-First):
 * 1. Find the Engine's highest-probability 1X2 outcome (Home, Draw, Away).
 * 2. Filter Correct Score markets to only scores matching that outcome.
 * 3. Sort by hitRate descending and return the top scoreline.
 */
function pickWinnerFirstScore(
  markets: MarketLike[],
  homeNames: string[],
  awayNames: string[],
): string | null {
  const outcomeMarkets = markets
    .filter(
      (m) =>
        (m.family === "Goals" || m.family === undefined) &&
        (m.name.includes("1X2") || m.name.includes("Result")) &&
        Number.isFinite(m.hitRate),
    )
    .map((m) => ({
      outcome: classify1X2Outcome(m, homeNames, awayNames),
      hitRate: m.hitRate,
    }))
    .filter((entry): entry is { outcome: Outcome1X2; hitRate: number } => entry.outcome !== null)
    .sort((a, b) => b.hitRate - a.hitRate);

  if (outcomeMarkets.length === 0) return null;
  const topOutcome = outcomeMarkets[0].outcome;

  const matchingScores = markets
    .filter(
      (m) =>
        (m.family === "Goals" || m.family === undefined) &&
        m.name.includes("Correct Score") &&
        Number.isFinite(m.hitRate),
    )
    .map((m) => {
      const parsed = parseCorrectScore(m);
      return parsed ? { ...parsed, hitRate: m.hitRate } : null;
    })
    .filter(
      (entry): entry is { homeScore: number; awayScore: number; score: string; hitRate: number } =>
        entry !== null && matchesOutcome(entry.homeScore, entry.awayScore, topOutcome),
    )
    .sort((a, b) => b.hitRate - a.hitRate);

  return matchingScores.length > 0 ? matchingScores[0].score : null;
}

function resolveCompletenessScore(engineResult: EngineResult | null, week: number): number {
  if (!engineResult?.match?.dataCompletenessScore) return 0;
  return engineResult.match.dataCompletenessScore;
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

  try {
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

    // STEP 1: Evaluate V2 rules across the sorted matchweek first so matchweek-wide
    // Snipe quotas are preserved before running the Engine on non-Snipes.
    const v4Fixtures = sorted.map((fx) => ({
      home: toV4TeamName(fx.home.name),
      away: toV4TeamName(fx.away.name),
    }));
    const v2Predictions = generatePredictions(v4Fixtures);

    // Dynamically load the Engine only when at least one non-Snipe fixture needs it.
    // If loading fails (e.g. missing DATABASE_URL), Layer 3 Safety Net handles it.
    const hasNonSnipe = v2Predictions.some((p) => !p.Category.includes("SNIPE"));
    let runEngine: typeof import("@/lib/engine").runEngineFromRealWithProfiles | null = null;
    if (hasNonSnipe) {
      try {
        const engineMod = await import("@/lib/engine");
        runEngine = engineMod.runEngineFromRealWithProfiles;
      } catch (err) {
        console.error("V4 engine module load failed, falling back to V2 safety net", err);
        runEngine = null;
      }
    }

    const result = await Promise.all(
      sorted.map(async (fx, index) => {
        const v2Pred = v2Predictions[index];
        const homeName = v4Fixtures[index].home;
        const awayName = v4Fixtures[index].away;

        let finalPrediction = v2Pred.Prediction;
        let finalCategory = v2Pred.Category;
        let enginePrediction: string | null = null;

        // Layer 1 (Snipes): Keep V2 prediction untouched and skip the Engine entirely.
        if (!v2Pred.Category.includes("SNIPE") && runEngine) {
          try {
            const summary = await espn.fetchSummary(fx.leagueSlug, fx.id).catch(() => null);
            const engineResult = await runEngine(fx, summary);
            const dataCompletenessScore = resolveCompletenessScore(engineResult, week);

            // Layer 2 (Engine Winner-First): requires dataCompletenessScore >= 50.
            if (dataCompletenessScore >= MIN_COMPLETENESS_SCORE) {
              const winnerFirstScore = pickWinnerFirstScore(
                engineResult.markets ?? [],
                [fx.home.name, engineResult.match?.homeTeam ?? "", homeName],
                [fx.away.name, engineResult.match?.awayTeam ?? "", awayName],
              );
              if (winnerFirstScore) {
                finalPrediction = winnerFirstScore;
                finalCategory = "ENGINE: Winner-First";
                enginePrediction = winnerFirstScore;
              }
            }
            // Layer 3 (Safety Net): dataCompletenessScore < 50 or missing markets
            // leaves finalPrediction = v2Pred.Prediction and finalCategory = v2Pred.Category.
          } catch (err) {
            // Layer 3 (Safety Net): Engine failure falls back to V2 Lock prediction.
            console.error("V4 engine prediction failed", fx.id, err);
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
          home: { name: homeName, logo: fx.home.logo ?? null },
          away: { name: awayName, logo: fx.away.logo ?? null },
          state: fx.state,
          actual,
          prediction: finalPrediction,
          category: finalCategory,
          enginePrediction,
        };
      }),
    );

    return NextResponse.json({ week, fixtures: result });
  } catch (error) {
    console.error("V4 auto predictor failed", error);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}
