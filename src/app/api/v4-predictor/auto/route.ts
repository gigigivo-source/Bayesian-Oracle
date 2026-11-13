import * as espn from "@/lib/espn";
import type { EngineResult } from "@/lib/engine";
import {
  buildCorrectScoreGrid,
  DIXON_COLES_RHO,
  pickMaxExpectedPoints,
  type ExpectedPointsPick,
  type ScoreCell,
} from "@/lib/engine/markets";
import { buildHistoricalTeamForm } from "@/lib/engine/sofascore";
import { translateTeamName } from "@/lib/v4-predictor";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// The Engine runs on every fixture in the slate, so allow the same budget as daily-picks.
export const maxDuration = 60;

const DEFAULT_WEEK = 11;

/**
 * V4 Predictor — Pure Points Maximiser (no safety nets).
 *
 * The blind V2 static rules are gone, and so are the FLOOR / CEILING tranches
 * that used to force a favourite's safest line or a draw snipe. Every fixture
 * in the matchweek is priced by the Engine (Dixon–Coles corrected 1X2 +
 * Correct Score grid 0-0 … 8-8) and the route simply returns the scoreline
 * with the highest Expected Points:
 *
 *   EP(score) = 10 × P(outcome of score) + 10 × P(exactly that score)
 *
 * If the math says 3-2 or 4-4, the app publishes 3-2 or 4-4.
 */

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

// ─── Engine result → probabilities ───────────────────────────────────────────

export type Outcome = "H" | "D" | "A";

export interface OneX2 {
  h: number;
  d: number;
  a: number;
}

/**
 * Read the 1X2 split the Engine priced. The Engine's markets are already
 * Dixon–Coles corrected and normalised, so this is a straight lookup; when a
 * family is missing, fall back to the canonical Poisson pair the route derives
 * from the Engine lambdas so every fixture always has a usable split.
 */
export function get1X2(
  engineResult: EngineResult | null,
  fallback: { homeGoals: number; awayGoals: number },
): OneX2 {
  const markets: MarketLike[] = engineResult?.markets ?? [];
  const resultMarkets = markets.filter((m) => /Match Result/i.test(m.name));
  const homeTeam = engineResult?.match?.homeTeam ?? "";
  const awayTeam = engineResult?.match?.awayTeam ?? "";

  const pick = (test: (sel: string) => boolean) => {
    const market = resultMarkets.find((m) => test(`${m.selection ?? ""} ${m.name}`));
    return market && market.hitRate > 0 ? market.hitRate : null;
  };

  const home =
    pick((sel) => homeTeam !== "" && sel.includes(homeTeam) && /win/i.test(sel)) ??
    pick((sel) => /home win/i.test(sel));
  const away =
    pick((sel) => awayTeam !== "" && sel.includes(awayTeam) && /win/i.test(sel)) ??
    pick((sel) => /away win/i.test(sel));
  const draw = pick((sel) => /draw/i.test(sel) && !/or/i.test(sel));

  // No usable 1X2 family: price the split off the Engine's own lambdas (the
  // same Poisson pair the Correct Score grid is built from), and only then off
  // the caller's fallback pair.
  if (home === null || draw === null || away === null) {
    const pair = engineLambdas(engineResult) ?? fallback;
    return outcomeFromLambdas(pair.homeGoals, pair.awayGoals);
  }

  const total = home + draw + away;
  if (!Number.isFinite(total) || total <= 0) {
    const pair = engineLambdas(engineResult) ?? fallback;
    return outcomeFromLambdas(pair.homeGoals, pair.awayGoals);
  }
  return { h: home / total, d: draw / total, a: away / total };
}

function outcomeFromLambdas(homeGoals: number, awayGoals: number): OneX2 {
  const { outcome } = buildCorrectScoreGrid(homeGoals, awayGoals, DIXON_COLES_RHO);
  return { h: outcome.home, d: outcome.draw, a: outcome.away };
}

/** Engine lambdas → the Poisson pair the score grid is built on. */
export function engineLambdas(engineResult: EngineResult | null): { homeGoals: number; awayGoals: number } | null {
  const home = engineResult?.lambdas?.["λ Home Goals"];
  const away = engineResult?.lambdas?.["λ Away Goals"];
  if (
    typeof home !== "number" || typeof away !== "number" ||
    !Number.isFinite(home) || !Number.isFinite(away) || home < 0 || away < 0
  ) {
    return null;
  }
  return { homeGoals: home, awayGoals: away };
}

/**
 * The Correct Score grid the Engine priced — Dixon–Coles corrected and
 * renormalised. Prefers the grid the Engine published with its result; falls
 * back to rebuilding it from the Engine lambdas, then to the caller's pair.
 */
export function getCorrectScores(
  engineResult: EngineResult | null,
  fallback: { homeGoals: number; awayGoals: number },
): ScoreCell[] {
  if (engineResult?.scoreGrid?.cells?.length) return engineResult.scoreGrid.cells;

  const lambdas = engineLambdas(engineResult) ?? fallback;
  const grid = buildCorrectScoreGrid(lambdas.homeGoals, lambdas.awayGoals, DIXON_COLES_RHO);

  const markets: MarketLike[] = engineResult?.markets ?? [];
  const csMarkets = markets.filter((m) => /Correct Score/i.test(m.name));
  if (csMarkets.length === 0) return grid.cells;

  // The Engine published its own values; use them where present so the route
  // picks from exactly what the Engine ranked.
  return grid.cells.map((cell) => {
    const label = `${cell.homeGoals}-${cell.awayGoals}`;
    const market = csMarkets.find((m) => {
      const text = `${m.selection ?? ""} ${m.name}`;
      return new RegExp(`(?:^|\\D)${label}(?:\\D|$)`).test(text);
    });
    return market && market.hitRate > 0 ? { ...cell, probability: market.hitRate } : cell;
  });
}

// The EP maximiser (`pickMaxExpectedPoints`) lives in the market registry, next
// to the grid it ranks, so the route and the Engine agree on what "best
// scoreline" means.

// ─── Pure Expected Points maximiser ─────────────────────────────────────────

/** Scoreline formatted the way the dashboard renders it: "3-1". */
export function formatScore(homeGoals: number, awayGoals: number): string {
  return `${homeGoals}-${awayGoals}`;
}

/** Everything the route needs to publish one fixture's MAX EP pick. */
export interface MaxExpectedPointsOutcome {
  /** "3-1" — the highest-EP scoreline on the grid. */
  prediction: string;
  /** "MAX EP: 3-1" — the label the table shows. */
  category: string;
  outcome: Outcome;
  /** 10 × P(outcome) + 10 × P(exact score). */
  ep: number;
  /** P(Home) / P(Draw) / P(Away) for the picked scoreline's outcome. */
  outcomeProbability: number;
  /** Probability of the picked scoreline itself. */
  exactProbability: number;
}

/** The label prefix every row carries — the pick is chosen purely on EP. */
export const MAX_EP_PREFIX = "MAX EP";

/** One fixture's probabilities + corrected score grid → its MAX EP pick. */
export function maxExpectedPointsPick(
  prediction: { probs: OneX2; scores: ScoreCell[] },
): MaxExpectedPointsOutcome {
  const pick: ExpectedPointsPick | null = pickMaxExpectedPoints(
    prediction.scores,
    { home: prediction.probs.h, draw: prediction.probs.d, away: prediction.probs.a },
  );

  // Degenerate grid (no cells at all — never produced by the Engine, but the
  // model-only fallback must still emit a row): price the canonical 1-1.
  if (!pick) {
    return {
      prediction: "1-1",
      category: `${MAX_EP_PREFIX}: 1-1`,
      outcome: "D",
      ep: 0,
      outcomeProbability: prediction.probs.d,
      exactProbability: 0,
    };
  }

  const scoreline = formatScore(pick.homeGoals, pick.awayGoals);
  return {
    prediction: scoreline,
    category: `${MAX_EP_PREFIX}: ${scoreline}`,
    outcome: pick.outcome,
    ep: pick.ep,
    outcomeProbability: pick.outcomeProb,
    exactProbability: pick.exactProb,
  };
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

    // STEP 3 — value every scoreline on every fixture's grid by its Expected
    // Points and publish the highest one. No tranching, no floor, no ceiling.
    const picks = priced.map((p) => maxExpectedPointsPick({ probs: p.probs, scores: p.scores }));

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
      };
    });

    return NextResponse.json({ week, fixtures: result });
  } catch (error) {
    console.error("V4 auto predictor failed", error);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}
