import * as espn from "@/lib/espn";
import type { EngineResult } from "@/lib/engine";
import { buildHistoricalTeamForm } from "@/lib/engine/sofascore";
import { toV4TeamName } from "@/lib/v4-predictor";
import { selectV4Slate, V4_SYSTEMS } from "@/lib/engine/v4-strategies";
import { engineLambdas, get1X2, getCorrectScores } from "@/lib/engine/v4-pricing";
import backtestResults from "@/lib/engine/v4-backtest-results.json";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// The Engine runs on every fixture in the slate, so allow the same budget as daily-picks.
export const maxDuration = 60;

const DEFAULT_WEEK = 11;

/**
 * V4 Predictor — Consensus Override.
 *
 * The MW1–10 archived-data backtest selected this system: V2 chooses H/D/A
 * (including its original matchweek snipe quotas), then the Engine publishes
 * the highest-probability exact score inside that outcome. The selector is
 * shared with scripts/backtest-v4.ts; the UI never re-picks a scoreline.
 */
const ACTIVE_SYSTEM =
  V4_SYSTEMS.find((system) => system.id === backtestResults.winner) ??
  V4_SYSTEMS.find((system) => system.id === "consensus")!;
const WINNER_SUMMARY = backtestResults.systems.find((system) => system.id === ACTIVE_SYSTEM.id)!;

function parseWeekParam(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 38) return NaN;
  return parsed;
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

    const v4Fixtures = sorted.map((fx) => ({
      home: toV4TeamName(fx.home.name),
      away: toV4TeamName(fx.away.name),
    }));

    // Dynamically load the Engine; if it cannot load (e.g. missing
    // DATABASE_URL) every fixture falls through to the model-only pricing.
    let runEngine: typeof import("@/lib/engine").runEngineFromRealWithProfiles | null = null;
    try {
      const engineMod = await import("@/lib/engine");
      runEngine = engineMod.runEngineFromRealWithProfiles;
    } catch (err) {
      console.error("V4 engine module load failed, using model-only pricing", err);
      runEngine = null;
    }

    // STEP 1 — run the Engine on every fixture in the slate.
    const priced = await Promise.all(
      sorted.map(async (fx, index) => {
        const homeName = v4Fixtures[index].home;
        const awayName = v4Fixtures[index].away;

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

        const isFinished = fx.state === "post";
        let engineResult: EngineResult | null = null;

        if (runEngine) {
          try {
            // ESPN's current summary and scoreboard can contain post-match data.
            // Only retain dated historical form/H2H and recompute their aggregates.
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

            // STEP 2 — odds stripping. Historical fixtures must never see a
            // closing line (it would leak the result into the model), while
            // upcoming fixtures keep the bookmaker prices so the Engine can
            // anchor its lambdas to the market.
            const odds = fx.state === "post" ? null : (rawSummary?.odds ?? fx.odds ?? null);
            const engineFx = {
              ...fx, state: "pre" as const, statusDetail: "", clock: undefined, odds,
              home: { ...fx.home, score: null, record: null, form: null },
              away: { ...fx.away, score: null, record: null, form: null },
            };
            const summary: espn.MatchSummary | null =
              rawSummary || homeForm || awayForm
                ? {
                    // Explicit allowlist: no match xG, boxscore, or unverified lineups.
                    venue: rawSummary?.venue ?? fx.venue ?? null,
                    homeForm,
                    awayForm,
                    h2h: (rawSummary?.h2h ?? []).filter((game) => isBefore(game.date)),
                    odds,
                    homeLineup: [],
                    awayLineup: [],
                    lineupAvailable: false,
                    homeFormation: null,
                    awayFormation: null,
                    boxscore: null,
                  }
                : null;
            engineResult = await runEngine(engineFx, summary, null, undefined, fx.date);
          } catch (err) {
            console.error("V4 engine prediction failed", fx.id, err);
            engineResult = null;
          }
        }

        // Model-only fallback: 1.35 / 1.15 goals with no Engine at all.
        const fallback = engineLambdas(engineResult) ?? { homeGoals: 1.35, awayGoals: 1.15 };
        const probs = get1X2(engineResult, fallback);
        const scores = getCorrectScores(engineResult, fallback);

        return { fx, index, homeName, awayName, probs, scores };
      }),
    );

    // STEP 3 — the backtest winner: V2 outcome first, Engine modal score
    // inside that outcome second. One slate-wide pass preserves V2 quotas.
    const picks = selectV4Slate(
      ACTIVE_SYSTEM.id,
      v4Fixtures,
      priced.map((p) => ({ probs: p.probs, scores: p.scores })),
    );

    const result = priced.map(({ fx, index, homeName, awayName }) => {
      const pick = picks[index];
      const prediction = pick.prediction;
      const category = pick.category;

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
        prediction,
        category,
        enginePrediction: prediction,
        probabilities: {
          home: Math.round(priced[index].probs.h * 1000) / 1000,
          draw: Math.round(priced[index].probs.d * 1000) / 1000,
          away: Math.round(priced[index].probs.a * 1000) / 1000,
        },
        // Expected Points of the published pick: 10 for the outcome plus 10
        // for the exact scoreline, weighted by the grid probabilities.
        ep: Math.round(pick.ep * 1000) / 1000,
        outcomeProbability: Math.round(pick.outcomeProbability * 1000) / 1000,
        exactProbability: Math.round(pick.exactProbability * 1000) / 1000,
        outcome: pick.outcome,
        v2Category: pick.v2Category ?? null,
        v2Prediction: pick.v2Prediction ?? null,
      };
    });

    return NextResponse.json({
      week,
      strategy: {
        ...ACTIVE_SYSTEM,
        backtest: {
          season: backtestResults.season,
          weeks: backtestResults.weeks,
          fixtureCount: backtestResults.fixtureCount,
          average: WINNER_SUMMARY.average,
          floor: WINNER_SUMMARY.floor,
          hundredPlus: WINNER_SUMMARY.hundredPlus,
          weekly: WINNER_SUMMARY.weekly,
          mode: backtestResults.mode,
        },
      },
      fixtures: result,
    });
  } catch (error) {
    console.error("V4 auto predictor failed", error);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}
