import * as espn from "@/lib/espn";
import type { EngineResult } from "@/lib/engine";
import {
  buildCorrectScoreGrid,
  DIXON_COLES_RHO,
  pickBestScoreForOutcome,
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
 * V4 Predictor — Portfolio Tranching System.
 *
 * The blind V2 static rules are gone. Every fixture in the matchweek is priced
 * by the Engine (Dixon–Coles corrected 1X2 + Correct Score grid), then the
 * slate is split into two tranches:
 *
 *   · FLOOR   — the 8 (or 9) most confident favourites. Safe winners: take the
 *               favourite's outcome, then the most likely scoreline inside it.
 *   · CEILING — the 1–2 least confident fixtures. Only a genuine toss-up
 *               (P(Draw) ≥ 0.29 and |P(Home) − P(Away)| < 8%) is sniped as a
 *               draw; anything else falls back into the Floor tranche.
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

// `pickBestScoreForOutcome` (modal scoreline inside one outcome) lives in the
// market registry, next to the grid it reads, so the route and the Engine agree
// on what the "best" scoreline for an outcome means.

// ─── Portfolio tranching ─────────────────────────────────────────────────────

export const FLOOR_SIZE = 8;
export const CEILING_SIZE = 2;
export const TOSS_UP_DRAW_FLOOR = 0.29;
export const TOSS_UP_GAP_CEILING = 0.08;

export interface TranchePrediction {
  probs: OneX2;
  scores: ScoreCell[];
}

export interface TrancheOutcome {
  index: number;
  category: string;
  prediction: string;
  outcome: Outcome;
  tranche: "FLOOR" | "CEILING";
  probability: number;
}

export function formatScore(homeGoals: number, awayGoals: number): string {
  return `${homeGoals}-${awayGoals}`;
}

/**
 * Sort by the favourite's confidence, then tranche the slate.
 *
 * The bottom 1–2 fixtures of the sorted slate form the CEILING tranche; the
 * rest (8 or 9 of a full 10-match week) are FLOOR picks. A 10-fixture slate
 * probes both bottoms — the single least confident match and the two least
 * confident matches — and spends the ceiling on the first one that is a true
 * toss-up (P(Draw) ≥ 0.29 and |P(Home) − P(Away)| < 8%):
 *
 *   · both bottoms are toss-ups → 8 floor + 2 ceiling
 *   · only the last match is    → 9 floor + 1 ceiling
 *   · neither is                → 10 floor, no ceiling
 *
 * Short slates (early-season weeks, abandoned fixtures) cannot fill the floor
 * tranche at all, so they never spend picks on a ceiling snipe: every fixture
 * is floored until the slate is at least FLOOR_SIZE deep.
 */
export function trancheSlate(predictions: TranchePrediction[]): TrancheOutcome[] {
  const order = predictions
    .map((pred, index) => ({
      index,
      confidence: Math.max(pred.probs.h, pred.probs.a),
    }))
    .sort((a, b) => b.confidence - a.confidence);

  const isTossUp = (pred: TranchePrediction) =>
    pred.probs.d >= TOSS_UP_DRAW_FLOOR &&
    Math.abs(pred.probs.h - pred.probs.a) < TOSS_UP_GAP_CEILING;

  // How many of the least-confident fixtures get a ceiling probe at all.
  const probeSize = order.length >= FLOOR_SIZE ? CEILING_SIZE : 0;
  let ceilingIndexes: number[] = [];
  if (probeSize === CEILING_SIZE) {
    const lastTwo = order.slice(-CEILING_SIZE);
    const last = order[order.length - 1];
    if (lastTwo.every((entry) => isTossUp(predictions[entry.index]))) {
      ceilingIndexes = lastTwo.map((entry) => entry.index);
    } else if (isTossUp(predictions[last.index])) {
      ceilingIndexes = [last.index];
    }
  }
  const ceilingRankStart = order.length - ceilingIndexes.length;
  const inCeiling = new Set(ceilingIndexes);

  const results: TrancheOutcome[] = [];
  order.forEach((entry, rank) => {
    const pred = predictions[entry.index];
    const isCeilingTossUp = rank >= ceilingRankStart && inCeiling.has(entry.index);

    if (isCeilingTossUp) {
      const best = pickBestScoreForOutcome(pred.scores, "D");
      if (best) {
        results.push({
          index: entry.index,
          tranche: "CEILING",
          category: "CEILING: Draw Snipe",
          prediction: formatScore(best.homeGoals, best.awayGoals),
          outcome: "D",
          probability: best.probability,
        });
        return;
      }
    }

    // Floor: the favourite's outcome, then its most likely scoreline.
    const outcome: Outcome = pred.probs.h > pred.probs.a ? "H" : "A";
    const best = pickBestScoreForOutcome(pred.scores, outcome);
    if (best) {
      results.push({
        index: entry.index,
        tranche: "FLOOR",
        category: `FLOOR: ${outcome === "H" ? "Home" : "Away"} Win`,
        prediction: formatScore(best.homeGoals, best.awayGoals),
        outcome,
        probability: best.probability,
      });
      return;
    }

    // Degenerate grid (no cell in the favourite's outcome) — take the modal
    // favourite side as the scoreline rather than emitting nothing.
    results.push({
      index: entry.index,
      tranche: "FLOOR",
      category: `FLOOR: ${outcome === "H" ? "Home" : "Away"} Win`,
      prediction: outcome === "H" ? "1-0" : "0-1",
      outcome,
      probability: 0,
    });
  });

  return results;
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

    // STEP 3 — tranche the slate and materialise the final predictions.
    const tranches = trancheSlate(priced.map((p) => ({ probs: p.probs, scores: p.scores })));
    const byIndex = new Map(tranches.map((t) => [t.index, t]));

    const result = priced.map(({ fx, index, homeName, awayName }) => {
      const tranche = byIndex.get(index);
      const prediction = tranche?.prediction ?? "1-0";
      const category = tranche?.category ?? "FLOOR: Home Win";

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
        tranche: tranche?.tranche ?? "FLOOR",
      };
    });

    return NextResponse.json({ week, fixtures: result });
  } catch (error) {
    console.error("V4 auto predictor failed", error);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}
