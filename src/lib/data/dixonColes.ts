// ĞIGI GIVØ — Dixon–Coles low-score correction.
//
// Independent Poisson assumes the two teams' goal counts are independent, which
// they are not at the bottom of the score grid: real football produces more
// 0-0 and 1-1 draws and fewer 1-0 / 0-1 results than Poisson implies. Dixon &
// Coles (1997) fix this with a multiplicative factor τ on the four low-score
// cells:
//
//   τ(0,0) = 1 − λ·μ·ρ      (ρ < 0 ⇒ > 1, so 0-0 is *more* likely)
//   τ(1,0) = 1 + λ·ρ        (ρ < 0 ⇒ < 1, so 1-0 is *less* likely)
//   τ(0,1) = 1 + μ·ρ        (ρ < 0 ⇒ < 1, so 0-1 is *less* likely)
//   τ(1,1) = 1 − ρ          (ρ < 0 ⇒ > 1, so 1-1 is *more* likely)
//   τ(x,y) = 1 everywhere else
//
// ρ is estimated from the same historical matches as everything else, by
// maximising the profile log-likelihood of those four cells given the λ's the
// attack/defence model produces (see `estimateRho`).
//
// ── Note on the specified formula ─────────────────────────────────────────────
// The brief described all four cells as `P × (1 + ρ)`. Applied uniformly with a
// negative ρ that shrinks every low-score cell, including the two draws that
// the correction exists to *raise*, and it breaks the 0-0/1-1 vs 1-0/0-1
// asymmetry that makes the correction useful. `applyDixonColes` therefore uses
// the published τ above; `applyDixonColesUniform` keeps the literal
// `P × (1 + ρ)` form available for comparison.

import { poissonPmf } from "@/lib/engine/stats";
import type { HistoricalMatch } from "./historical";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Used when a league has too little history to estimate its own ρ. */
export const DEFAULT_RHO = -0.1;
/** Estimator clamp. Top leagues typically land in [-0.15, -0.05]. */
export const RHO_MIN = -0.2;
export const RHO_MAX = 0.05;
/** Below this many matches the estimate is not trustworthy. */
export const MIN_RHO_MATCHES = 60;
const RHO_STEP = 0.005;
/** Keeps every τ non-negative for the λ's in play. */
const TAU_FLOOR = 0;

// ─── Cell helpers ─────────────────────────────────────────────────────────────

/** The four cells the correction touches. */
export function isLowScoreCell(homeGoals: number, awayGoals: number): boolean {
  return homeGoals <= 1 && awayGoals <= 1 && homeGoals >= 0 && awayGoals >= 0;
}

/**
 * Pull ρ in toward zero when λ is large enough that `1 + λρ` would go negative.
 * A λ of 5 with ρ = −0.2 would otherwise produce a negative probability.
 */
export function effectiveRho(homeLambda: number, awayLambda: number, rho: number): number {
  const largest = Math.max(homeLambda, awayLambda, Number.EPSILON);
  return Math.max(rho, -0.99 / largest);
}

/** The Dixon–Coles τ multiplier for one cell. 1 outside the low-score block. */
export function dixonColesTau(
  homeGoals: number,
  awayGoals: number,
  homeLambda: number,
  awayLambda: number,
  rho: number,
): number {
  if (rho === 0 || !isLowScoreCell(homeGoals, awayGoals)) return 1;
  const clamped = effectiveRho(homeLambda, awayLambda, rho);
  let tau: number;
  if (homeGoals === 0 && awayGoals === 0) tau = 1 - homeLambda * awayLambda * clamped;
  else if (homeGoals === 1 && awayGoals === 0) tau = 1 + homeLambda * clamped;
  else if (homeGoals === 0 && awayGoals === 1) tau = 1 + awayLambda * clamped;
  else tau = 1 - clamped; // 1-1
  return Math.max(TAU_FLOOR, tau);
}

/**
 * Adjusted joint probability of a scoreline: Poisson × Dixon–Coles τ.
 *
 * This is the signature the feature specifies. Note it returns an *unnormalised*
 * probability — the τ factors do not quite sum to one across the grid, so
 * callers that need a distribution (the Monte Carlo layer) renormalise.
 */
export function applyDixonColes(
  homeGoals: number,
  awayGoals: number,
  homeLambda: number,
  awayLambda: number,
  rho: number,
): number {
  const base = poissonPmf(homeGoals, homeLambda) * poissonPmf(awayGoals, awayLambda);
  return base * dixonColesTau(homeGoals, awayGoals, homeLambda, awayLambda, rho);
}

/**
 * The literal `P_poisson × (1 + ρ)` form from the brief, kept for A/B
 * comparison. Not used by the prediction path: see the module note.
 */
export function applyDixonColesUniform(
  homeGoals: number,
  awayGoals: number,
  homeLambda: number,
  awayLambda: number,
  rho: number,
): number {
  if (!isLowScoreCell(homeGoals, awayGoals)) {
    return poissonPmf(homeGoals, homeLambda) * poissonPmf(awayGoals, awayLambda);
  }
  const base = poissonPmf(homeGoals, homeLambda) * poissonPmf(awayGoals, awayLambda);
  return base * Math.max(TAU_FLOOR, 1 + rho);
}

// ─── Grid ─────────────────────────────────────────────────────────────────────

export interface DixonColesCell {
  homeGoals: number;
  awayGoals: number;
  /** Independent-Poisson probability, before the correction. */
  poisson: number;
  tau: number;
  /** Poisson × τ, unnormalised. */
  probability: number;
}

export interface DixonColesGrid {
  maxGoals: number;
  homeLambda: number;
  awayLambda: number;
  rho: number;
  cells: DixonColesCell[];
  /** Σ of `probability` across the grid. */
  gridProbability: number;
  /** Probability mass outside the grid, before renormalisation. */
  tailProbability: number;
}

/**
 * Full (maxGoals + 1)² score grid with the correction applied and the marginal
 * Poisson factors precomputed once per side.
 */
export function dixonColesGrid(
  homeLambda: number,
  awayLambda: number,
  rho: number,
  maxGoals: number,
): DixonColesGrid {
  const size = Math.max(0, Math.floor(maxGoals));
  const homePmf: number[] = [];
  const awayPmf: number[] = [];
  for (let goals = 0; goals <= size; goals++) {
    homePmf.push(poissonPmf(goals, homeLambda));
    awayPmf.push(poissonPmf(goals, awayLambda));
  }

  const cells: DixonColesCell[] = [];
  let gridProbability = 0;
  for (let homeGoals = 0; homeGoals <= size; homeGoals++) {
    for (let awayGoals = 0; awayGoals <= size; awayGoals++) {
      const tau = dixonColesTau(homeGoals, awayGoals, homeLambda, awayLambda, rho);
      const probability = homePmf[homeGoals] * awayPmf[awayGoals] * tau;
      gridProbability += probability;
      cells.push({ homeGoals, awayGoals, poisson: homePmf[homeGoals] * awayPmf[awayGoals], tau, probability });
    }
  }

  return {
    maxGoals: size,
    homeLambda,
    awayLambda,
    rho,
    cells,
    gridProbability,
    tailProbability: Math.max(0, 1 - gridProbability),
  };
}

// ─── ρ estimation ─────────────────────────────────────────────────────────────

/** Supplies the λ's a match was modelled with — usually the attack/defence model. */
export type LambdaProvider = (match: HistoricalMatch) => { homeLambda: number; awayLambda: number } | null;

export interface RhoEstimate {
  rho: number;
  matchesUsed: number;
  lowScoreMatches: number;
  logLikelihood: number;
  /** True when there was not enough history and `DEFAULT_RHO` was returned. */
  fallback: boolean;
  observed: { score: string; count: number; expected: number }[];
}

/**
 * Profile maximum-likelihood estimate of ρ.
 *
 * Only τ depends on ρ, so for each match the contribution is
 * `log τ(observed cell) − log Z`, where `Z = 1 + Σ (τ − 1)·P` over the four
 * corrected cells is that match's normalising constant. Including Z is what
 * makes this a proper likelihood rather than a curve fit to the observed cell
 * counts; dropping it would bias ρ negative whenever λ is large.
 *
 * The Poisson terms for 0 and 1 goals are precomputed once per match, so the
 * grid search is pure arithmetic and cheap enough to re-run per backtest step.
 */
export function estimateRhoDetailed(
  matches: HistoricalMatch[],
  lambdaFor: LambdaProvider,
  options: { minMatches?: number; step?: number } = {},
): RhoEstimate {
  const minMatches = options.minMatches ?? MIN_RHO_MATCHES;
  const step = options.step ?? RHO_STEP;

  interface Prepared {
    p00: number;
    p10: number;
    p01: number;
    p11: number;
    lambdaHome: number;
    lambdaAway: number;
    observed: 0 | 1 | 2 | 3 | null;
    homeGoals: number;
    awayGoals: number;
  }

  const prepared: Prepared[] = [];
  const observedCounts = [0, 0, 0, 0];
  for (const match of matches) {
    const lambdas = lambdaFor(match);
    if (!lambdas) continue;
    const { homeLambda, awayLambda } = lambdas;
    if (!Number.isFinite(homeLambda) || !Number.isFinite(awayLambda)) continue;
    if (homeLambda <= 0 || awayLambda <= 0) continue;

    const p0h = poissonPmf(0, homeLambda);
    const p1h = poissonPmf(1, homeLambda);
    const p0a = poissonPmf(0, awayLambda);
    const p1a = poissonPmf(1, awayLambda);

    let observed: Prepared["observed"] = null;
    if (match.homeGoals === 0 && match.awayGoals === 0) observed = 0;
    else if (match.homeGoals === 1 && match.awayGoals === 0) observed = 1;
    else if (match.homeGoals === 0 && match.awayGoals === 1) observed = 2;
    else if (match.homeGoals === 1 && match.awayGoals === 1) observed = 3;
    if (observed !== null) observedCounts[observed]++;

    prepared.push({
      p00: p0h * p0a,
      p10: p1h * p0a,
      p01: p0h * p1a,
      p11: p1h * p1a,
      lambdaHome: homeLambda,
      lambdaAway: awayLambda,
      observed,
      homeGoals: match.homeGoals,
      awayGoals: match.awayGoals,
    });
  }

  const observed = [
    { score: "0-0", count: observedCounts[0], expected: 0 },
    { score: "1-0", count: observedCounts[1], expected: 0 },
    { score: "0-1", count: observedCounts[2], expected: 0 },
    { score: "1-1", count: observedCounts[3], expected: 0 },
  ];
  for (const entry of prepared) {
    observed[0].expected += entry.p00;
    observed[1].expected += entry.p10;
    observed[2].expected += entry.p01;
    observed[3].expected += entry.p11;
  }
  for (const entry of observed) entry.expected = Math.round(entry.expected * 1000) / 1000;

  const fallbackResult = (rho: number): RhoEstimate => ({
    rho,
    matchesUsed: prepared.length,
    lowScoreMatches: observedCounts.reduce((sum, value) => sum + value, 0),
    logLikelihood: 0,
    fallback: true,
    observed,
  });

  if (prepared.length < minMatches) return fallbackResult(DEFAULT_RHO);

  const logLikelihoodAt = (rho: number): number => {
    let total = 0;
    for (const entry of prepared) {
      const { p00, p10, p01, p11, lambdaHome, lambdaAway } = entry;
      const safeRho = Math.max(rho, -0.99 / Math.max(lambdaHome, lambdaAway, Number.EPSILON));

      const cell00 = Math.max(TAU_FLOOR, 1 - lambdaHome * lambdaAway * safeRho);
      const cell10 = Math.max(TAU_FLOOR, 1 + lambdaHome * safeRho);
      const cell01 = Math.max(TAU_FLOOR, 1 + lambdaAway * safeRho);
      const cell11 = Math.max(TAU_FLOOR, 1 - safeRho);

      const normaliser =
        1 + (cell00 - 1) * p00 + (cell10 - 1) * p10 + (cell01 - 1) * p01 + (cell11 - 1) * p11;
      if (normaliser <= 0) return Number.NEGATIVE_INFINITY;

      if (entry.observed === null) {
        total -= Math.log(normaliser);
        continue;
      }
      const tau =
        entry.observed === 0 ? cell00 : entry.observed === 1 ? cell10 : entry.observed === 2 ? cell01 : cell11;
      if (tau <= 0) return Number.NEGATIVE_INFINITY;
      total += Math.log(tau) - Math.log(normaliser);
    }
    return total;
  };

  let bestRho = DEFAULT_RHO;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let rho = RHO_MIN; rho <= RHO_MAX + Number.EPSILON; rho += step) {
    const candidate = Math.round(rho * 1000) / 1000;
    const score = logLikelihoodAt(candidate);
    if (score > bestScore) {
      bestScore = score;
      bestRho = candidate;
    }
  }

  return {
    rho: Math.max(RHO_MIN, Math.min(RHO_MAX, bestRho)),
    matchesUsed: prepared.length,
    lowScoreMatches: observedCounts.reduce((sum, value) => sum + value, 0),
    logLikelihood: bestScore,
    fallback: false,
    observed,
  };
}

/** Convenience wrapper returning just the ρ value. */
export function estimateRho(matches: HistoricalMatch[], lambdaFor: LambdaProvider, minMatches?: number): number {
  return estimateRhoDetailed(matches, lambdaFor, { minMatches }).rho;
}

// ─── Per-league cache ─────────────────────────────────────────────────────────

const rhoByLeague = new Map<string, { rho: number; estimate: RhoEstimate; at: number }>();
const RHO_TTL_MS = 60 * 60_000;

/** Cache an estimate so repeated requests do not re-run the grid search. */
export function setRhoForLeague(leagueSlug: string, estimate: RhoEstimate, now: number = Date.now()): void {
  rhoByLeague.set(leagueSlug, { rho: estimate.rho, estimate, at: now });
}

/** Cached ρ for a league, or `DEFAULT_RHO` when nothing has been estimated. */
export function getRhoForLeague(leagueSlug: string, now: number = Date.now()): number {
  const entry = rhoByLeague.get(leagueSlug);
  if (!entry) return DEFAULT_RHO;
  if (now - entry.at > RHO_TTL_MS) {
    rhoByLeague.delete(leagueSlug);
    return DEFAULT_RHO;
  }
  return entry.rho;
}

export function getRhoEstimateForLeague(leagueSlug: string): RhoEstimate | null {
  return rhoByLeague.get(leagueSlug)?.estimate ?? null;
}

/**
 * Estimate ρ for a league from its historical matches and cache it. The λ's
 * come from whatever model the caller supplies — the correct-score route and
 * the backtest both pass their own attack/defence model so ρ is estimated
 * against the same λ's it will later correct.
 */
export function estimateLeagueRho(
  leagueSlug: string,
  matches: HistoricalMatch[],
  lambdaFor: LambdaProvider,
  options: { minMatches?: number; now?: number } = {},
): RhoEstimate {
  const estimate = estimateRhoDetailed(matches, lambdaFor, { minMatches: options.minMatches });
  setRhoForLeague(leagueSlug, estimate, options.now ?? Date.now());
  return estimate;
}

export function clearRhoCache(): void {
  rhoByLeague.clear();
}
