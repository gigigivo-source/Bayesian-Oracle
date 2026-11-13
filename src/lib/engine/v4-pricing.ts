// Engine result → V4 probability bundle. Kept outside the Next route so the
// route exports only its handler/config and the backtest can reuse pricing.
import type { EngineResult } from "@/lib/engine";
import { buildCorrectScoreGrid, DIXON_COLES_RHO, type ScoreCell } from "./markets";
import { pureExpectedPointsPick, type V4PriceBundle } from "./v4-strategies";

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

// ─── Shared selectors ───────────────────────────────────────────────────────

/** Scoreline formatted the way the dashboard renders it: "3-1". */
export function formatScore(homeGoals: number, awayGoals: number): string {
  return `${homeGoals}-${awayGoals}`;
}

/** Baseline Pure EP helper retained for tests/comparisons; GET uses consensus. */
export type MaxExpectedPointsOutcome = Omit<import("@/lib/engine/v4-strategies").V4Pick, "system" | "v2Category" | "v2Prediction">;
export const MAX_EP_PREFIX = "MAX EP";
export function maxExpectedPointsPick(prediction: V4PriceBundle): MaxExpectedPointsOutcome {
  const { system: _system, ...pick } = pureExpectedPointsPick(prediction);
  void _system;
  return pick;
}

