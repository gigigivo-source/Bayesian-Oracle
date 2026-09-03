// ĞIGI GIVØ — Monte Carlo correct-score simulation.
//
// Samples the Dixon–Coles corrected scoreline distribution for one fixture and
// aggregates the results into scoreline probabilities and match markets.
//
// Two sampling methods, both returning the same shape:
//
//   · `stratified` (default) — randomised systematic sampling. Each of the N
//     draws uses u_k = (k + U_k) / N with U_k ~ Uniform(0,1), inverted through
//     the corrected cumulative distribution. This is a standard Monte Carlo
//     variance-reduction technique: the marginals are exact and the estimator
//     error drops as O(1/N) instead of O(1/√N), so a 10k run is stable enough
//     to publish. Plain inverse-CDF sampling would put ±0.3 percentage points
//     of noise on a ~11% scoreline — enough to reshuffle the top ten and make
//     the published ranking jitter between refreshes.
//
//   · `iid-poisson` — the literal "draw homeGoals ~ Poisson(λh), awayGoals ~
//     Poisson(λa)" path, with each draw reweighted by the Dixon–Coles τ of the
//     cell it landed in. Unbiased, but noisier: only the four low-score cells
//     carry a weight other than 1. Kept because it is the independent check on
//     the stratified path.
//
// Draws are seeded from the model inputs, so the same λ's always produce the
// same published scorelines and the backtest is reproducible run to run.

import { hashString, seededRng } from "@/lib/engine/stats";
import { dixonColesGrid, dixonColesTau } from "./dixonColes";

// ─── Configuration ────────────────────────────────────────────────────────────

export const DEFAULT_SIMULATIONS = 10_000;
export const DEFAULT_MAX_GOALS = 10;
export const TOP_SCORELINES = 10;

export type SimulationMethod = "stratified" | "iid-poisson";

export interface MonteCarloOptions {
  simulations?: number;
  /** Bound of the *reported* grid; the sampler always covers a wider one. */
  maxGoals?: number;
  /** Explicit PRNG seed. Defaults to a hash of the model inputs. */
  seed?: number;
  method?: SimulationMethod;
  /** Injectable PRNG (overrides `seed`). */
  rng?: () => number;
  /** How many scorelines to put in `topScorelines`. Default 10. */
  topScorelines?: number;
}

export interface SimulatedScoreline {
  score: string;
  homeGoals: number;
  awayGoals: number;
  /** Simulated occurrences (weighted count for the iid path). */
  count: number;
  /** `count / simulations` — the requested Monte Carlo estimate. */
  probability: number;
  /** Exact Dixon–Coles grid probability, for comparison with the simulation. */
  analyticProbability: number;
  impliedOdds: number;
}

export interface MonteCarloMarkets {
  homeWin: number;
  draw: number;
  awayWin: number;
  over05: number;
  over15: number;
  over25: number;
  over35: number;
  over45: number;
  under25: number;
  bttsYes: number;
  bttsNo: number;
  homeCleanSheet: number;
  awayCleanSheet: number;
}

export interface MonteCarloResult {
  simulations: number;
  method: SimulationMethod;
  seed: number;
  homeLambda: number;
  awayLambda: number;
  rho: number;
  /** Grid bound actually sampled (≥ `maxGoals`). */
  sampledMaxGoals: number;
  /** Top N scorelines, most probable first. */
  topScorelines: SimulatedScoreline[];
  /** Every sampled scoreline, most probable first. */
  scorelines: SimulatedScoreline[];
  markets: MonteCarloMarkets;
  meanHomeGoals: number;
  meanAwayGoals: number;
  /** Σ probability across the sampled grid (≈ 1 by construction). */
  gridProbability: number;
  elapsedMs: number;
}

export interface MatchSimulationInput {
  homeLambda: number;
  awayLambda: number;
  rho: number;
  options?: MonteCarloOptions;
}

// ─── Sampling primitives ──────────────────────────────────────────────────────

/**
 * Poisson variate. Knuth's product method for the λ range football produces
 * (expected λ + 1 iterations); a rounded normal approximation above λ = 30,
 * where Knuth degenerates.
 */
export function poissonSample(lambda: number, rng: () => number): number {
  if (!Number.isFinite(lambda) || lambda <= 0) return 0;
  if (lambda < 30) {
    const threshold = Math.exp(-lambda);
    let product = 1;
    let count = 0;
    // Bounded so a pathological PRNG cannot spin forever.
    while (count < 200) {
      product *= rng();
      if (product <= threshold) return count;
      count++;
    }
    return count;
  }
  // Box–Muller normal, rounded and floored at zero.
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal));
}

/** Grid bound wide enough that the unsampled tail is negligible. */
export function sampledGridBound(maxGoals: number, homeLambda: number, awayLambda: number): number {
  const largest = Math.max(homeLambda, awayLambda, 1);
  const sixSigma = Math.ceil(largest + 6 * Math.sqrt(largest));
  return Math.max(maxGoals, DEFAULT_MAX_GOALS, sixSigma);
}

function defaultSeed(homeLambda: number, awayLambda: number, rho: number, method: SimulationMethod): number {
  const rounded = [
    Math.round(homeLambda * 1000),
    Math.round(awayLambda * 1000),
    Math.round(rho * 1000),
    method,
  ].join("|");
  return hashString(rounded);
}

// ─── Simulation ───────────────────────────────────────────────────────────────

/**
 * Simulate one fixture.
 *
 * The scoreline distribution is the Dixon–Coles corrected joint of two
 * Poissons; the simulation reports `count / N` for each cell alongside the
 * exact analytic probability so the sampling error is always visible rather
 * than hidden inside a single number.
 */
export function simulateMatch(input: MatchSimulationInput): MonteCarloResult {
  const startedAt = Date.now();
  const options = input.options ?? {};
  const simulations = Math.max(1, Math.round(options.simulations ?? DEFAULT_SIMULATIONS));
  const reportedMaxGoals = Math.max(0, Math.round(options.maxGoals ?? DEFAULT_MAX_GOALS));
  const method = options.method ?? "stratified";
  const homeLambda = Math.max(Number.EPSILON, input.homeLambda);
  const awayLambda = Math.max(Number.EPSILON, input.awayLambda);
  const rho = Number.isFinite(input.rho) ? input.rho : 0;
  const seed = options.seed ?? defaultSeed(homeLambda, awayLambda, rho, method);
  const rng = options.rng ?? seededRng(seed);

  const sampledMaxGoals = sampledGridBound(reportedMaxGoals, homeLambda, awayLambda);
  const grid = dixonColesGrid(homeLambda, awayLambda, rho, sampledMaxGoals);
  const gridProbability = grid.gridProbability > 0 ? grid.gridProbability : 1;

  const width = sampledMaxGoals + 1;
  const cellCount = width * width;
  const index = (homeGoals: number, awayGoals: number): number => homeGoals * width + awayGoals;

  // Analytic probabilities, normalised over the sampled grid.
  const analytic = new Float64Array(cellCount);
  for (const cell of grid.cells) {
    analytic[index(cell.homeGoals, cell.awayGoals)] = cell.probability / gridProbability;
  }

  const counts = new Float64Array(cellCount);

  if (method === "stratified") {
    // Cumulative distribution over the normalised grid, then one inverted draw
    // per simulation using a jittered systematic sequence.
    const cumulative = new Float64Array(cellCount);
    let running = 0;
    for (let i = 0; i < cellCount; i++) {
      running += analytic[i];
      cumulative[i] = running;
    }
    cumulative[cellCount - 1] = 1; // guard against floating-point drift

    for (let k = 0; k < simulations; k++) {
      const u = (k + rng()) / simulations;
      let low = 0;
      let high = cellCount - 1;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (cumulative[mid] < u) low = mid + 1;
        else high = mid;
      }
      counts[low]++;
    }
  } else {
    // Independent Poisson draws, reweighted by the τ of the cell they land in.
    let totalWeight = 0;
    for (let k = 0; k < simulations; k++) {
      const homeGoals = poissonSample(homeLambda, rng);
      const awayGoals = poissonSample(awayLambda, rng);
      const tau = dixonColesTau(homeGoals, awayGoals, homeLambda, awayLambda, rho);
      totalWeight += tau;
      if (homeGoals <= sampledMaxGoals && awayGoals <= sampledMaxGoals) {
        counts[index(homeGoals, awayGoals)] += tau;
      }
    }
    if (totalWeight > 0) {
      const scale = simulations / totalWeight;
      for (let i = 0; i < cellCount; i++) counts[i] *= scale;
    }
  }

  const scorelines: SimulatedScoreline[] = [];
  const markets: MonteCarloMarkets = {
    homeWin: 0,
    draw: 0,
    awayWin: 0,
    over05: 0,
    over15: 0,
    over25: 0,
    over35: 0,
    over45: 0,
    under25: 0,
    bttsYes: 0,
    bttsNo: 0,
    homeCleanSheet: 0,
    awayCleanSheet: 0,
  };
  let meanHomeGoals = 0;
  let meanAwayGoals = 0;

  for (let homeGoals = 0; homeGoals <= sampledMaxGoals; homeGoals++) {
    for (let awayGoals = 0; awayGoals <= sampledMaxGoals; awayGoals++) {
      const at = index(homeGoals, awayGoals);
      // Zero-count cells are kept: `scorelines` is the complete sampled
      // distribution, so its probabilities sum to 1 and callers scoring a
      // Brier over the grid are not silently missing near-zero cells.
      const count = counts[at];
      const probability = count / simulations;
      const total = homeGoals + awayGoals;

      scorelines.push({
        score: `${homeGoals}-${awayGoals}`,
        homeGoals,
        awayGoals,
        count,
        probability,
        analyticProbability: analytic[at],
        impliedOdds: probability > 0 ? 1 / probability : 0,
      });

      if (homeGoals > awayGoals) markets.homeWin += probability;
      else if (homeGoals === awayGoals) markets.draw += probability;
      else markets.awayWin += probability;

      if (total >= 1) markets.over05 += probability;
      if (total >= 2) markets.over15 += probability;
      if (total >= 3) markets.over25 += probability;
      if (total >= 4) markets.over35 += probability;
      if (total >= 5) markets.over45 += probability;
      if (total <= 2) markets.under25 += probability;
      if (homeGoals >= 1 && awayGoals >= 1) markets.bttsYes += probability;
      else markets.bttsNo += probability;
      if (awayGoals === 0) markets.homeCleanSheet += probability;
      if (homeGoals === 0) markets.awayCleanSheet += probability;

      meanHomeGoals += probability * homeGoals;
      meanAwayGoals += probability * awayGoals;
    }
  }

  scorelines.sort(
    (left, right) =>
      right.probability - left.probability ||
      left.homeGoals + left.awayGoals - (right.homeGoals + right.awayGoals) ||
      left.homeGoals - right.homeGoals,
  );

  const round = (value: number, decimals = 6): number => {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  };
  for (const scoreline of scorelines) {
    scoreline.probability = round(scoreline.probability, 6);
    scoreline.analyticProbability = round(scoreline.analyticProbability, 6);
    scoreline.impliedOdds = round(scoreline.probability > 0 ? 1 / scoreline.probability : 0, 2);
    scoreline.count = Math.round(scoreline.count);
  }
  for (const key of Object.keys(markets) as Array<keyof MonteCarloMarkets>) {
    markets[key] = round(markets[key], 6);
  }

  return {
    simulations,
    method,
    seed,
    homeLambda,
    awayLambda,
    rho,
    sampledMaxGoals,
    topScorelines: scorelines.slice(0, Math.max(1, options.topScorelines ?? TOP_SCORELINES)),
    scorelines,
    markets,
    meanHomeGoals: round(meanHomeGoals, 4),
    meanAwayGoals: round(meanAwayGoals, 4),
    gridProbability: round(grid.gridProbability, 6),
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Exact analytic scorelines on the same grid — no sampling. Exposed so the
 * backtest can measure how much of any accuracy change comes from the model
 * (λ and ρ) rather than from Monte Carlo noise.
 */
export function analyticScorelines(
  homeLambda: number,
  awayLambda: number,
  rho: number,
  maxGoals: number,
): SimulatedScoreline[] {
  const grid = dixonColesGrid(homeLambda, awayLambda, rho, maxGoals);
  const total = grid.gridProbability > 0 ? grid.gridProbability : 1;
  return grid.cells
    .map((cell) => {
      const probability = Math.round((cell.probability / total) * 1e6) / 1e6;
      return {
        score: `${cell.homeGoals}-${cell.awayGoals}`,
        homeGoals: cell.homeGoals,
        awayGoals: cell.awayGoals,
        count: 0,
        probability,
        analyticProbability: probability,
        impliedOdds: probability > 0 ? Math.round((1 / probability) * 100) / 100 : 0,
      };
    })
    .sort(
      (left, right) =>
        right.probability - left.probability ||
        left.homeGoals + left.awayGoals - (right.homeGoals + right.awayGoals) ||
        left.homeGoals - right.homeGoals,
    );
}
