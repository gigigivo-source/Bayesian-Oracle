/**
 * V4 Predictor — The 70-Floor / 100+ Ceiling Tournament Systems.
 *
 * Five distinct scoreline-selection algorithms built on the Engine's 0–8
 * Dixon–Coles corrected score grid (`DIXON_COLES_RHO = -0.13`):
 *
 *   · System A — The Kelly Criterion Maximizer ("KELLY")
 *       Value = (P(Exact) * 20) - ((1 - P(Exact)) * 10)
 *   · System B — The Goal-Bucket Specialist ("BUCKET")
 *       Predicts total-goals bucket (0-1, 2-3, 4+) first, then picks the modal
 *       exact scoreline from that bucket's candidate set.
 *   · System C — The Bayesian Prior Blend ("BAYES")
 *       Conjugate shrinkage of prior-season EPL attack/defence rates (K = 6
 *       pseudo-matches, with promoted-club adjustment) blended with last-5
 *       league form, evaluated on a 0–8 Dixon–Coles grid.
 *   · System D — The Draw-First Value Hunter ("DRAW HUNTER")
 *       Locks onto the modal low draw (1-1 or 0-0) whenever P(Draw) >= 0.28;
 *       otherwise picks the highest-probability decisive scoreline.
 *   · System E — The Expected Points Champion (Weighted) ("WEIGHTED EP")
 *       EP = (10 * P(Outcome)) + (15 * P(Exact))
 *       Tournament winner across MW1–10 (highest Floor: 40, highest Avg: 62.0).
 */

import {
  buildCorrectScoreGrid,
  CORRECT_SCORE_MAX_GOALS,
  DIXON_COLES_RHO,
  scoreOutcome,
  type ScoreCell,
} from "@/lib/engine/markets";
import type { TeamForm } from "@/lib/espn";

export type OutcomeCode = "H" | "D" | "A";

export interface Probabilities1X2 {
  h: number;
  d: number;
  a: number;
}

export interface PricedGridInput {
  probs: Probabilities1X2;
  scores: ScoreCell[];
}

export interface V4SystemPick {
  /** Published scoreline, e.g. "2-1". */
  prediction: string;
  /** System-labelled display tag, e.g. "WEIGHTED EP: 2-1". */
  category: string;
  /** 1X2 side of the picked scoreline. */
  outcome: OutcomeCode;
  /** Primary objective value for the system (e.g. weighted EP for System E). */
  metric: number;
  /** True V4 expected points = 10 * P(Outcome) + 10 * P(Exact). */
  trueEp: number;
  /** Weighted EP = 10 * P(Outcome) + 15 * P(Exact). */
  ep: number;
  /** Grid probability of the picked 1X2 outcome in [0, 1]. */
  outcomeProbability: number;
  /** Grid probability of the exact scoreline in [0, 1]. */
  exactProbability: number;
}

export const SYSTEM_PREFIX = {
  A: "KELLY",
  B: "BUCKET",
  C: "BAYES",
  D: "DRAW HUNTER",
  E: "WEIGHTED EP",
} as const;

export const WEIGHTED_EP_OUTCOME_WEIGHT = 10;
export const WEIGHTED_EP_EXACT_WEIGHT = 15;

function outcomeProbabilityFor(outcome: OutcomeCode, probs: Probabilities1X2): number {
  if (outcome === "H") return probs.h;
  if (outcome === "D") return probs.d;
  return probs.a;
}

function emptyFallbackPick(prefix: string): V4SystemPick {
  return {
    prediction: "1-1",
    category: `${prefix}: 1-1`,
    outcome: "D",
    metric: 0,
    trueEp: 0,
    ep: 0,
    outcomeProbability: 0,
    exactProbability: 0,
  };
}

function formatPick(
  prefix: string,
  cell: ScoreCell,
  probs: Probabilities1X2,
  metric: number,
): V4SystemPick {
  const scoreline = `${cell.homeGoals}-${cell.awayGoals}`;
  const outcome = scoreOutcome(cell.homeGoals, cell.awayGoals);
  const outcomeProb = outcomeProbabilityFor(outcome, probs);
  const exactProb = cell.probability;
  return {
    prediction: scoreline,
    category: `${prefix}: ${scoreline}`,
    outcome,
    metric,
    trueEp: 10 * outcomeProb + 10 * exactProb,
    ep: WEIGHTED_EP_OUTCOME_WEIGHT * outcomeProb + WEIGHTED_EP_EXACT_WEIGHT * exactProb,
    outcomeProbability: outcomeProb,
    exactProbability: exactProb,
  };
}

function grid0to8(scores: ScoreCell[]): ScoreCell[] {
  return scores.filter(
    (c) =>
      c.homeGoals >= 0 &&
      c.awayGoals >= 0 &&
      c.homeGoals <= CORRECT_SCORE_MAX_GOALS &&
      c.awayGoals <= CORRECT_SCORE_MAX_GOALS,
  );
}

function tieBreakCells(a: ScoreCell, b: ScoreCell, valA: number, valB: number): number {
  if (Math.abs(valB - valA) > 1e-12) return valB - valA;
  if (Math.abs(b.probability - a.probability) > 1e-12) return b.probability - a.probability;
  const goalsDiff = a.homeGoals + a.awayGoals - (b.homeGoals + b.awayGoals);
  if (goalsDiff !== 0) return goalsDiff;
  return b.homeGoals - a.homeGoals;
}

// ─── System A: The Kelly Criterion Maximizer ─────────────────────────────────

/**
 * Value = (Probability * 20) - ((1 - Probability) * 10).
 * Picks the highest positive-Value scoreline on the 0–8 grid (falling back to
 * the highest-Value cell when every single scoreline has Probability <= 1/3).
 */
export function systemAKellyPick(input: PricedGridInput): V4SystemPick {
  const cells = grid0to8(input.scores);
  if (cells.length === 0) return emptyFallbackPick(SYSTEM_PREFIX.A);

  const positive = cells.filter((c) => c.probability * 20 - (1 - c.probability) * 10 > 0);
  const pool = positive.length > 0 ? positive : cells;

  let best = pool[0];
  let bestVal = best.probability * 20 - (1 - best.probability) * 10;
  for (let i = 1; i < pool.length; i++) {
    const c = pool[i];
    const val = c.probability * 20 - (1 - c.probability) * 10;
    if (tieBreakCells(best, c, bestVal, val) > 0) {
      best = c;
      bestVal = val;
    }
  }
  return formatPick(SYSTEM_PREFIX.A, best, input.probs, bestVal);
}

// ─── System B: The Goal-Bucket Specialist ────────────────────────────────────

const BUCKET_SCORELINES: Record<"0-1" | "2-3" | "4+", ReadonlySet<string>> = {
  "0-1": new Set(["0-0", "1-0", "0-1"]),
  "2-3": new Set(["1-1", "2-1", "1-2", "2-0", "0-2"]),
  "4+": new Set(["2-2", "3-1", "1-3", "3-2", "2-3"]),
};

/**
 * Predicts total goals bucket first (`0-1`, `2-3`, `4+`), then selects the
 * highest-probability candidate scoreline inside the winning bucket.
 */
export function systemBBucketPick(input: PricedGridInput): V4SystemPick {
  const cells = grid0to8(input.scores);
  if (cells.length === 0) return emptyFallbackPick(SYSTEM_PREFIX.B);

  let p01 = 0;
  let p23 = 0;
  let p4p = 0;
  for (const cell of cells) {
    const total = cell.homeGoals + cell.awayGoals;
    if (total <= 1) p01 += cell.probability;
    else if (total <= 3) p23 += cell.probability;
    else p4p += cell.probability;
  }

  const winningBucket: "0-1" | "2-3" | "4+" =
    p01 >= p23 && p01 >= p4p ? "0-1" : p23 >= p4p ? "2-3" : "4+";
  const bucketProb = winningBucket === "0-1" ? p01 : winningBucket === "2-3" ? p23 : p4p;
  const allowed = BUCKET_SCORELINES[winningBucket];
  const candidates = cells.filter((c) => allowed.has(`${c.homeGoals}-${c.awayGoals}`));
  const pool = candidates.length > 0 ? candidates : cells;

  const best = [...pool].sort((a, b) => tieBreakCells(a, b, a.probability, b.probability))[0];
  return formatPick(SYSTEM_PREFIX.B, best, input.probs, bucketProb);
}

// ─── System C: The Bayesian Prior Blend ──────────────────────────────────────

export interface BayesianTeamPrior {
  avgGoalsScoredHome: number;
  avgGoalsConcededHome: number;
  avgGoalsScoredAway: number;
  avgGoalsConcededAway: number;
}

export interface BayesianBlendInput {
  homePrior: BayesianTeamPrior | null;
  awayPrior: BayesianTeamPrior | null;
  leagueAvgHomeGoals: number;
  leagueAvgAwayGoals: number;
  homeLast5: TeamForm | null;
  awayLast5: TeamForm | null;
  /** Prior pseudo-match weight (default K = 6). */
  priorStrength?: number;
}

/**
 * Conjugate Maher shrinkage combining prior-season EPL team strength (with a
 * promoted-club baseline of 0.82× attack / 1.22× defence when a team has no
 * prior top-flight season) and the team's last 5 EPL matches. Evaluates the
 * resulting (λ_home, λ_away) on the 0–8 Dixon–Coles grid and picks the modal
 * exact scoreline.
 */
export function systemCBayesianBlendPick(input: BayesianBlendInput): V4SystemPick {
  const K = input.priorStrength ?? 6;
  const lgH = input.leagueAvgHomeGoals > 0 ? input.leagueAvgHomeGoals : 1.52;
  const lgA = input.leagueAvgAwayGoals > 0 ? input.leagueAvgAwayGoals : 1.33;

  const priorHomeScored = input.homePrior ? input.homePrior.avgGoalsScoredHome : lgH * 0.82;
  const priorHomeConceded = input.homePrior ? input.homePrior.avgGoalsConcededHome : lgA * 1.22;
  const priorAwayScored = input.awayPrior ? input.awayPrior.avgGoalsScoredAway : lgA * 0.82;
  const priorAwayConceded = input.awayPrior ? input.awayPrior.avgGoalsConcededAway : lgH * 1.22;

  const nHome = input.homeLast5?.games.length ?? 0;
  const nAway = input.awayLast5?.games.length ?? 0;

  const postHomeScored = (K * priorHomeScored + nHome * (input.homeLast5?.gfAvg ?? 0)) / (K + nHome);
  const postHomeConceded =
    (K * priorHomeConceded + nHome * (input.homeLast5?.gaAvg ?? 0)) / (K + nHome);
  const postAwayScored = (K * priorAwayScored + nAway * (input.awayLast5?.gfAvg ?? 0)) / (K + nAway);
  const postAwayConceded =
    (K * priorAwayConceded + nAway * (input.awayLast5?.gaAvg ?? 0)) / (K + nAway);

  const homeLambda = Math.max(0.2, Math.min(4.5, (postHomeScored * postAwayConceded) / lgH));
  const awayLambda = Math.max(0.2, Math.min(4.5, (postAwayScored * postHomeConceded) / lgA));

  const grid = buildCorrectScoreGrid(
    homeLambda,
    awayLambda,
    DIXON_COLES_RHO,
    CORRECT_SCORE_MAX_GOALS,
  );
  const probs: Probabilities1X2 = {
    h: grid.outcome.home,
    d: grid.outcome.draw,
    a: grid.outcome.away,
  };
  const best = [...grid.cells].sort((a, b) => tieBreakCells(a, b, a.probability, b.probability))[0];
  return formatPick(SYSTEM_PREFIX.C, best, probs, best.probability);
}

// ─── System D: The Draw-First Value Hunter ───────────────────────────────────

export const DRAW_HUNTER_THRESHOLD = 0.28;

/**
 * When P(Draw) >= 0.28, picks the highest-probability draw between 1-1 and 0-0.
 * Otherwise picks the highest-probability winning (non-draw) scoreline.
 */
export function systemDDrawFirstPick(input: PricedGridInput): V4SystemPick {
  const cells = grid0to8(input.scores);
  if (cells.length === 0) return emptyFallbackPick(SYSTEM_PREFIX.D);

  const pool =
    input.probs.d >= DRAW_HUNTER_THRESHOLD
      ? cells.filter(
          (c) =>
            (c.homeGoals === 1 && c.awayGoals === 1) ||
            (c.homeGoals === 0 && c.awayGoals === 0),
        )
      : cells.filter((c) => c.homeGoals !== c.awayGoals);

  const effectivePool = pool.length > 0 ? pool : cells;
  const best = [...effectivePool].sort((a, b) =>
    tieBreakCells(a, b, a.probability, b.probability),
  )[0];
  return formatPick(SYSTEM_PREFIX.D, best, input.probs, best.probability);
}

// ─── System E: The Expected Points Champion (Weighted) ───────────────────────

/**
 * Tournament Winner:
 *   EP = (10 * P(Outcome)) + (15 * P(Exact))
 *
 * Weights exact-score upside 1.5× relative to outcome safety so decisive
 * scorelines (1-0, 2-0, 2-1, 0-2, 3-1) beat passive 1-1 defaults whenever a
 * genuine favourite exists, while preserving high-floor outcome equity on
 * balanced fixtures.
 */
export function systemEWeightedEpPick(input: PricedGridInput): V4SystemPick {
  const cells = grid0to8(input.scores);
  if (cells.length === 0) return emptyFallbackPick(SYSTEM_PREFIX.E);

  let best = cells[0];
  let bestEp =
    WEIGHTED_EP_OUTCOME_WEIGHT *
      outcomeProbabilityFor(scoreOutcome(best.homeGoals, best.awayGoals), input.probs) +
    WEIGHTED_EP_EXACT_WEIGHT * best.probability;

  for (let i = 1; i < cells.length; i++) {
    const cell = cells[i];
    const outProb = outcomeProbabilityFor(
      scoreOutcome(cell.homeGoals, cell.awayGoals),
      input.probs,
    );
    const weightedEp =
      WEIGHTED_EP_OUTCOME_WEIGHT * outProb + WEIGHTED_EP_EXACT_WEIGHT * cell.probability;
    if (tieBreakCells(best, cell, bestEp, weightedEp) > 0) {
      best = cell;
      bestEp = weightedEp;
    }
  }
  return formatPick(SYSTEM_PREFIX.E, best, input.probs, bestEp);
}
