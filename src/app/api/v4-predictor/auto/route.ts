import * as espn from "@/lib/espn";
import type { EngineResult } from "@/lib/engine";
import { buildHistoricalTeamForm } from "@/lib/engine/sofascore";
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

type MarketLike = {
  family?: string;
  name: string;
  selection?: string;
  hitRate: number;
};

/**
 * Layer 2 (Expected Points Maximizer):
 * Maximizes E[Points] = 10 * P(Outcome) + 10 * P(Exact Score) across all
 * Correct Score markets so high-value scorelines like 1-1 can win even when
 * aggregate Draw probability trails a fragmented Home/Away Win probability.
 */
function pickExpectedPointsScore(
  markets: MarketLike[],
  homeNames: string[],
  awayNames: string[],
): string | null {
  const validHomeNames = homeNames.filter(Boolean);
  const validAwayNames = awayNames.filter(Boolean);
  const oneX2 = markets.filter(
    (m) => m.name.includes("1X2") || m.name.includes("Result"),
  );

  const getProb = (selectionMatch: (sel: string) => boolean) => {
    const m = oneX2.find((item) => selectionMatch(item.selection ?? item.name));
    return m?.hitRate || 0;
  };

  const homeWinProb = getProb(
    (sel) => sel.includes("Win") && validHomeNames.some((n) => sel.includes(n)),
  );
  const awayWinProb = getProb(
    (sel) => sel.includes("Win") && validAwayNames.some((n) => sel.includes(n)),
  );
  const drawProb = getProb((sel) => sel.toLowerCase().includes("draw"));

  const csMarkets = markets.filter((m) => m.name.includes("Correct Score"));

  let bestScore: string | null = null;
  let bestEP = -1;

  for (const m of csMarkets) {
    const scoreStr = (
      m.selection
        ? m.selection.replace("Score ", "")
        : m.name.replace(/^Correct Score\s+/i, "")
    ).trim();
    const parts = scoreStr.split("-");
    if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
    const [h, a] = parts.map(Number);
    if (isNaN(h) || isNaN(a)) continue;

    let outcomeProb = 0;
    if (h > a) outcomeProb = homeWinProb;
    else if (h < a) outcomeProb = awayWinProb;
    else outcomeProb = drawProb;

    const exactProb = m.hitRate || 0;
    // 10 points for outcome + 10 for exact score = max 20
    const expectedPoints = 10 * outcomeProb + 10 * exactProb;

    if (expectedPoints > bestEP) {
      bestEP = expectedPoints;
      bestScore = `${h}-${a}`;
    }
  }
  return bestScore;
}

function resolveCompletenessScore(engineResult: EngineResult | null): number {
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
            // ESPN's current summary and scoreboard can contain post-match data.
            // Only retain dated historical form/H2H and recompute their aggregates.
            const cutoff = Date.parse(fx.date);
            const isBefore = (date: string) => {
              const time = Date.parse(date);
              // Date-only values on the match day cannot prove pre-kickoff availability.
              return Number.isFinite(cutoff) && Number.isFinite(time) && time < cutoff &&
                (date.includes("T") || date.slice(0, 10) < fx.date.slice(0, 10));
            };
            const filterForm = (form: espn.TeamForm | null): espn.TeamForm | null => {
              if (!form) return null;
              const games = form.games.filter((game) => isBefore(game.date));
              if (!games.length) return null;
              return {
                ...form, games,
                gfAvg: games.reduce((n, game) => n + game.scoreFor, 0) / games.length,
                gaAvg: games.reduce((n, game) => n + game.scoreAgainst, 0) / games.length,
                points: games.reduce((n, game) => n + (game.result === "W" ? 3 : game.result === "D" ? 1 : 0), 0),
              };
            };
            const engineFx = {
              ...fx, state: "pre" as const, statusDetail: "", clock: undefined, odds: null,
              home: { ...fx.home, score: null, record: null, form: null },
              away: { ...fx.away, score: null, record: null, form: null },
            };
            const isFinished = fx.state === "post";
            const [rawSummary, historicalHomeForm, historicalAwayForm] = await Promise.all([
              espn.fetchSummary(fx.leagueSlug, fx.id).catch(() => null),
              isFinished
                ? buildHistoricalTeamForm(fx.home.name, fx.leagueSlug, fx.date).catch(() => null)
                : Promise.resolve(null),
              isFinished
                ? buildHistoricalTeamForm(fx.away.name, fx.leagueSlug, fx.date).catch(() => null)
                : Promise.resolve(null),
            ]);
            // Finished fixtures must NOT rely on summary.homeForm/awayForm (which is
            // ESPN's rolling lastFiveGames as of today); construct form from schedules
            // strictly before fx.date instead.
            const homeForm = isFinished
              ? historicalHomeForm
              : filterForm(rawSummary?.homeForm ?? null);
            const awayForm = isFinished
              ? historicalAwayForm
              : filterForm(rawSummary?.awayForm ?? null);
            const summary: espn.MatchSummary | null =
              rawSummary || homeForm || awayForm
                ? {
                    // Explicit allowlist: no match xG, boxscore, or unverified odds/lineups.
                    venue: rawSummary?.venue ?? fx.venue ?? null,
                    homeForm,
                    awayForm,
                    h2h: (rawSummary?.h2h ?? []).filter((game) => isBefore(game.date)),
                    odds: null,
                    homeLineup: [],
                    awayLineup: [],
                    lineupAvailable: false,
                    homeFormation: null,
                    awayFormation: null,
                    boxscore: null,
                  }
                : null;
            const engineResult = await runEngine(engineFx, summary, null, undefined, fx.date);
            const dataCompletenessScore = resolveCompletenessScore(engineResult);

            // Layer 2 (Expected Points Maximizer): requires dataCompletenessScore >= 50.
            if (dataCompletenessScore >= MIN_COMPLETENESS_SCORE) {
              const epScore = pickExpectedPointsScore(
                engineResult.markets ?? [],
                [fx.home.name, engineResult.match?.homeTeam ?? "", homeName],
                [fx.away.name, engineResult.match?.awayTeam ?? "", awayName],
              );
              if (epScore) {
                finalPrediction = epScore;
                finalCategory = "ENGINE: Winner-First";
                enginePrediction = epScore;
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
