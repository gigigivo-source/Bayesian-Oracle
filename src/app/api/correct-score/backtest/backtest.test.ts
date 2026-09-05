// Tests for the correct-score parameter sweep.
//
// The sweep is a deterministic function of a synthetic Premier League archive
// here, so these assert the contract rather than the winning numbers:
//   • the grid is exactly structuralWeight × temperature × eloElasticity;
//   • every combination is scored on the same fixtures with Top-1 / Top-3 /
//     Brier populated and finite;
//   • ranking is Top-1 first, then Top-3, then Brier (lower wins);
//   • the live `DEFAULT_TUNING` is a member of the grid (so the route publishes
//     a combination the sweep can actually reproduce);
//   • temperature and K-factor really change the model, not just the labels.
import { describe, expect, it } from "vitest";
import {
  compareSweepResults,
  evaluateHistoricalMatches,
  runParameterSweep,
  SWEEP_GRID,
  sweepCombinations,
  type SweepResult,
} from "./route";
import { DEFAULT_TUNING, LEGACY_TUNING } from "../route";
import type { HistoricalMatch } from "@/lib/data/historical";
import { buildEloRatings, getElo, K_FACTORS, kFactorFor } from "@/lib/data/elo";
import { seededRng } from "@/lib/engine/stats";
import { analyticScorelines, simulateMatch, temperProbabilities } from "@/lib/data/monteCarlo";

const CLUBS = [
  "Arsenal FC", "Aston Villa FC", "AFC Bournemouth", "Brentford FC", "Brighton & Hove Albion FC",
  "Chelsea FC", "Crystal Palace FC", "Everton FC", "Fulham FC", "Liverpool FC",
  "Manchester City FC", "Manchester United FC", "Newcastle United FC", "Nottingham Forest FC",
  "Tottenham Hotspur FC", "West Ham United FC", "Wolverhampton Wanderers FC", "Leicester City FC",
  "Ipswich Town FC", "Southampton FC",
];

/** Poisson draw with a seeded PRNG — the archive must be identical run to run. */
function poisson(lambda: number, rng: () => number): number {
  const threshold = Math.exp(-lambda);
  let product = rng();
  let count = 0;
  while (product > threshold && count < 12) {
    product *= rng();
    count++;
  }
  return count;
}

/**
 * A synthetic two-season archive: 20 clubs of graded strength, double round
 * robin, one matchday every four days. Strength ordering is deliberate so ELO
 * and attack/defence have a signal to find.
 */
function syntheticArchive(now: Date): HistoricalMatch[] {
  const rng = seededRng(20260905);
  const strength = CLUBS.map((_, index) => 1.45 - index * 0.045);
  const matches: HistoricalMatch[] = [];
  let day = 0;
  for (let season = 0; season < 2; season++) {
    for (let round = 0; round < 2; round++) {
      for (let offset = 1; offset < CLUBS.length; offset++) {
        for (let home = 0; home < CLUBS.length; home++) {
          const away = (home + offset) % CLUBS.length;
          if (round === 1 && home > away) continue;
          if (round === 0 && home < away) continue;
          const homeLambda = strength[home] / strength[away] * 1.5;
          const awayLambda = strength[away] / strength[home] * 1.15;
          const date = new Date(now.getTime() - (760 - day) * 86_400_000);
          matches.push({
            id: `eng.1|${CLUBS[home]}|${CLUBS[away]}|${date.toISOString().slice(0, 10)}`,
            homeTeam: CLUBS[home],
            awayTeam: CLUBS[away],
            leagueSlug: "eng.1",
            matchDate: date.toISOString(),
            homeGoals: poisson(homeLambda, rng),
            awayGoals: poisson(awayLambda, rng),
            competitionName: `eng.1 synthetic ${season}`,
            source: "openfootball",
          });
        }
        day += 2;
      }
    }
  }
  return matches.sort((a, b) => new Date(a.matchDate).getTime() - new Date(b.matchDate).getTime());
}

const NOW = new Date("2026-09-05T00:00:00Z");
const ARCHIVE = syntheticArchive(NOW);
const REPLAY = { days: 800, maxMatches: 120, simulations: 500, now: NOW };

describe("sweep grid", () => {
  it("enumerates every structuralWeight × temperature × eloElasticity combination", () => {
    const combos = sweepCombinations();
    expect(combos).toHaveLength(
      SWEEP_GRID.structuralWeight.length * SWEEP_GRID.temperature.length * SWEEP_GRID.eloElasticity.length,
    );
    expect(combos).toHaveLength(48);
    const keys = new Set(combos.map((c) => `${c.structuralWeight}|${c.temperature}|${c.eloElasticity}`));
    expect(keys.size).toBe(48);
    expect(SWEEP_GRID.structuralWeight).toEqual([0.6, 0.7, 0.8, 0.9]);
    expect(SWEEP_GRID.temperature).toEqual([0.8, 0.85, 0.9, 0.95]);
    expect(SWEEP_GRID.eloElasticity).toEqual([20, 30, 40]);
  });

  it("includes the live DEFAULT_TUNING so the published model is reproducible from the sweep", () => {
    const match = sweepCombinations().find(
      (c) =>
        c.structuralWeight === DEFAULT_TUNING.structuralWeight &&
        c.temperature === DEFAULT_TUNING.temperature &&
        c.eloElasticity === DEFAULT_TUNING.eloElasticity,
    );
    expect(match).toBeDefined();
  });
});

describe("compareSweepResults", () => {
  const result = (top1: number, top3: number, brier: number): SweepResult => ({
    params: { structuralWeight: 0.6, temperature: 0.8, eloElasticity: 20 },
    matchesTested: 10,
    top1Accuracy: top1,
    top3Accuracy: top3,
    brierScore: brier,
  });

  it("ranks by Top-1, then Top-3, then lower Brier", () => {
    const a = result(0.12, 0.30, 0.94);
    const b = result(0.11, 0.35, 0.90);
    const c = result(0.12, 0.31, 0.95);
    const d = result(0.12, 0.31, 0.93);
    expect([a, b, c, d].sort(compareSweepResults)).toEqual([d, c, a, b]);
  });
});

describe("runParameterSweep", () => {
  it("scores every combination on the same fixtures with finite metrics, best first", () => {
    const combos = [
      { structuralWeight: 0.6, temperature: 0.8, eloElasticity: 20 },
      { structuralWeight: 0.9, temperature: 0.95, eloElasticity: 40 },
      LEGACY_TUNING,
    ];
    const { results, matchesTested } = runParameterSweep(ARCHIVE, REPLAY, combos);
    expect(matchesTested).toBeGreaterThan(50);
    expect(results).toHaveLength(3);
    for (const entry of results) {
      expect(entry.matchesTested).toBe(matchesTested);
      expect(entry.top1Accuracy).toBeGreaterThanOrEqual(0);
      expect(entry.top1Accuracy).toBeLessThanOrEqual(1);
      expect(entry.top3Accuracy).toBeGreaterThanOrEqual(entry.top1Accuracy);
      expect(Number.isFinite(entry.brierScore)).toBe(true);
      expect(entry.brierScore).toBeGreaterThan(0);
      expect(entry.brierScore).toBeLessThan(2);
    }
    const sorted = [...results].sort(compareSweepResults);
    expect(results).toEqual(sorted);
  });

  it("is deterministic — the same archive always ranks the grid the same way", () => {
    const combos = sweepCombinations().slice(0, 4);
    const first = runParameterSweep(ARCHIVE, REPLAY, combos).results;
    const second = runParameterSweep(ARCHIVE, REPLAY, combos).results;
    expect(second).toEqual(first);
  });

  it("agrees with evaluateHistoricalMatches for the same parameters", () => {
    const params = { structuralWeight: 0.7, temperature: 0.85, eloElasticity: 30 };
    const [sweep] = runParameterSweep(ARCHIVE, REPLAY, [params]).results;
    const { evaluations } = evaluateHistoricalMatches(ARCHIVE, { ...REPLAY, ...params });
    const top1 = evaluations.filter((e) => e.log.correctTop1).length / evaluations.length;
    expect(sweep.matchesTested).toBe(evaluations.length);
    expect(sweep.top1Accuracy).toBeCloseTo(top1, 6);
  });

  it("actually changes the predictions when the parameters change", () => {
    const cold = evaluateHistoricalMatches(ARCHIVE, {
      ...REPLAY,
      structuralWeight: 0.6,
      temperature: 0.8,
      eloElasticity: 20,
    }).evaluations;
    const hot = evaluateHistoricalMatches(ARCHIVE, {
      ...REPLAY,
      structuralWeight: 0.9,
      temperature: 0.95,
      eloElasticity: 40,
    }).evaluations;
    expect(cold.length).toBe(hot.length);
    const differingLambdas = cold.filter(
      (entry, index) =>
        entry.log.homeExpectedGoals !== hot[index].log.homeExpectedGoals ||
        entry.log.homeElo !== hot[index].log.homeElo,
    );
    expect(differingLambdas.length).toBeGreaterThan(0);
    const differingTop1Probability = cold.filter(
      (entry, index) => entry.log.predictedTop1Probability !== hot[index].log.predictedTop1Probability,
    );
    expect(differingTop1Probability.length).toBeGreaterThan(0);
  });
});

describe("temperature", () => {
  it("T = 1 is the identity for probability calibration", () => {
    const probabilities = [0.5, 0.3, 0.2];
    temperProbabilities(probabilities, 1);
    expect(probabilities).toEqual([0.5, 0.3, 0.2]);
  });

  it("T < 1 sharpens the distribution and keeps it normalised", () => {
    const probabilities = [0.5, 0.3, 0.2];
    temperProbabilities(probabilities, 0.8);
    expect(probabilities[0]).toBeGreaterThan(0.5);
    expect(probabilities[2]).toBeLessThan(0.2);
    expect(probabilities.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
  });

  it("shrinks λ and moves simulated mass toward low scorelines", () => {
    const plain = simulateMatch({ homeLambda: 1.6, awayLambda: 1.2, rho: -0.05, options: { simulations: 5_000 } });
    const cool = simulateMatch({
      homeLambda: 1.6,
      awayLambda: 1.2,
      rho: -0.05,
      options: { simulations: 5_000, temperature: 0.8 },
    });
    expect(plain.temperature).toBe(1);
    expect(cool.temperature).toBe(0.8);
    expect(cool.homeLambda).toBeCloseTo(1.6 * 0.8, 9);
    expect(cool.meanHomeGoals).toBeLessThan(plain.meanHomeGoals);
    const nilNil = (result: typeof plain) => result.scorelines.find((s) => s.score === "0-0")!.probability;
    expect(nilNil(cool)).toBeGreaterThan(nilNil(plain));
    expect(cool.gridProbability).toBeGreaterThan(0.99);
    const total = cool.scorelines.reduce((sum, s) => sum + s.probability, 0);
    expect(total).toBeCloseTo(1, 3);
  });

  it("applies the same effects to the analytic grid", () => {
    const plain = analyticScorelines(1.6, 1.2, -0.05, 5);
    const cool = analyticScorelines(1.6, 1.2, -0.05, 5, 0.8);
    expect(cool[0].probability).toBeGreaterThan(plain[0].probability);
    expect(cool.reduce((sum, s) => sum + s.probability, 0)).toBeCloseTo(1, 3);
  });
});

describe("ELO K-factor override", () => {
  it("kFactorFor honours a league override and falls back otherwise", () => {
    expect(kFactorFor("league")).toBe(K_FACTORS.league);
    expect(kFactorFor("league", { league: 40 })).toBe(40);
    expect(kFactorFor("cup", { league: 40 })).toBe(K_FACTORS.cup);
    expect(kFactorFor("league", { league: Number.NaN })).toBe(K_FACTORS.league);
  });

  it("a higher K spreads the ratings further apart over the same replay", () => {
    const slow = buildEloRatings(ARCHIVE, { kFactors: { league: 20 }, activate: false });
    const fast = buildEloRatings(ARCHIVE, { kFactors: { league: 40 }, activate: false });
    const spread = (table: typeof slow) => {
      const ratings = [...table.global.values()].map((entry) => entry.rating);
      return Math.max(...ratings) - Math.min(...ratings);
    };
    expect(spread(fast)).toBeGreaterThan(spread(slow));
    // Both replays must still recover the synthetic strength ordering at the
    // extremes, and the faster K must push the strongest club further up.
    const strongest = CLUBS[0];
    const weakest = CLUBS[CLUBS.length - 1];
    expect(getElo(strongest, "eng.1", slow)!).toBeGreaterThan(getElo(weakest, "eng.1", slow)! + 100);
    expect(getElo(strongest, "eng.1", fast)!).toBeGreaterThan(getElo(weakest, "eng.1", fast)! + 100);
    expect(getElo(strongest, "eng.1", fast)!).toBeGreaterThan(getElo(strongest, "eng.1", slow)!);
  });
});
