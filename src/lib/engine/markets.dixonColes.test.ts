// Tests for the Dixon–Coles low-score correction wired into the market
// registry: `result1x2` and the Correct Score grid must be priced off one
// common corrected grid, renormalised so the 1X2 split sums to 1.
//
// Pure-Poisson draws under-count 0-0 / 1-1, so the correction must always
// *raise* the draw probability for a negative ρ, and must leave a
// low-scoring match (0-0 is the modal draw at λ ≈ 0.9) with a 0-0 modal draw.

import { describe, expect, it } from "vitest";
import { buildCorrectScoreGrid, DIXON_COLES_RHO, MarketEngine, pickBestScoreForOutcome } from "./markets";
import type { LockedMatchObject } from "./types";
import type { LambdaSet } from "./lambdas";

function lockedMatch(): LockedMatchObject {
  return {
    homeTeam: "Arsenal",
    awayTeam: "Chelsea",
    venue: "Emirates Stadium",
    venueType: "HOME",
    date: "2026-08-24",
    timeUtc: "15:00 UTC",
    tournamentStage: "League Match",
    refereeName: "Test Referee",
    weatherForecast: "Clear",
    keyInjuryFlags: [],
    dataCompletenessScore: 82,
    fallbackMode: false,
  };
}

function lambdas(homeGoals: number, awayGoals: number): LambdaSet {
  return {
    homeGoals, awayGoals,
    homeCorners: 5.2, awayCorners: 4.4,
    homeCards: 1.9, awayCards: 1.7,
    homeSot: 5.1, awaySot: 4.2,
    homeShots: 13, awayShots: 11,
    homeOffsides: 1.5, awayOffsides: 1.3,
    homeGoalKicks: 8, awayGoalKicks: 7,
    homeSaves: 3, awaySaves: 2.5,
    homeThrowIns: 18, awayThrowIns: 16,
    homeFouls: 11, awayFouls: 10,
    aerialTotal: 22, passesTotal: 460,
    interceptionsHome: 8, interceptionsAway: 8,
    dribblingHome: 8, dribblingAway: 8,
    redCardProb: 0.1, penaltyProb: 0.22,
    calibrationNotes: [],
  };
}

describe("Dixon–Coles corrected score grid", () => {
  it("uses ρ = −0.13 and leaves non-low-score cells unturned (τ = 1)", () => {
    expect(DIXON_COLES_RHO).toBe(-0.13);
    const grid = buildCorrectScoreGrid(1.6, 1.1, DIXON_COLES_RHO);
    const twoOne = grid.cells.find((c) => c.homeGoals === 2 && c.awayGoals === 1)!;
    const twoTwo = grid.cells.find((c) => c.homeGoals === 2 && c.awayGoals === 2)!;
    expect(twoOne.tau).toBe(1);
    expect(twoTwo.tau).toBe(1);
    // ... and their normalised probability is Poisson × the grid normaliser.
    expect(twoTwo.probability / twoTwo.poissonProbability).toBeCloseTo(
      twoOne.probability / twoOne.poissonProbability,
      12,
    );
  });

  it("raises 0-0 and 1-1 and lowers 1-0 / 0-1 relative to pure Poisson", () => {
    const h = 1.4, a = 1.1;
    const grid = buildCorrectScoreGrid(h, a, DIXON_COLES_RHO);
    const cell = (hg: number, ag: number) => grid.cells.find((c) => c.homeGoals === hg && c.awayGoals === ag)!;
    // The unnormalised ratio is exactly τ; renormalising scales all cells alike.
    const ratio = (hg: number, ag: number) => cell(hg, ag).probability / cell(hg, ag).poissonProbability;
    expect(ratio(0, 0)).toBeGreaterThan(ratio(2, 2));
    expect(ratio(1, 1)).toBeGreaterThan(ratio(2, 2));
    expect(ratio(1, 0)).toBeLessThan(ratio(2, 2));
    expect(ratio(0, 1)).toBeLessThan(ratio(2, 2));
    // And the published draw share beats the independent-Poisson draw share.
    const poissonDraw = grid.cells
      .filter((c) => c.homeGoals === c.awayGoals)
      .reduce((sum, c) => sum + c.poissonProbability, 0);
    expect(grid.outcome.draw).toBeGreaterThan(poissonDraw);
  });

  it("normalises the 1X2 split to 1.0", () => {
    for (const [h, a] of [[1.6, 1.1], [0.7, 2.1], [1.0, 1.0], [2.6, 0.5], [0.9, 0.9]]) {
      const { outcome } = buildCorrectScoreGrid(h, a, DIXON_COLES_RHO);
      expect(outcome.home + outcome.draw + outcome.away).toBeCloseTo(1, 12);
      expect(outcome.home).toBeGreaterThan(0);
      expect(outcome.draw).toBeGreaterThan(0);
      expect(outcome.away).toBeGreaterThan(0);
    }
  });

  it("makes 1-1 the modal draw at normal λ and 0-0 at a low-scoring λ", () => {
    const normal = buildCorrectScoreGrid(1.6, 1.2, DIXON_COLES_RHO);
    expect(pickBestScoreForOutcome(normal.cells, "D")).toMatchObject({ homeGoals: 1, awayGoals: 1 });
    const low = buildCorrectScoreGrid(0.9, 0.9, DIXON_COLES_RHO);
    expect(pickBestScoreForOutcome(low.cells, "D")).toMatchObject({ homeGoals: 0, awayGoals: 0 });
  });

  it("picks the modal scoreline inside the requested outcome only", () => {
    const grid = buildCorrectScoreGrid(2.2, 0.6, DIXON_COLES_RHO);
    expect(pickBestScoreForOutcome(grid.cells, "H")).toMatchObject({ homeGoals: 2, awayGoals: 0 });
    expect(pickBestScoreForOutcome(grid.cells, "A")).toMatchObject({ homeGoals: 0, awayGoals: 1 });
    expect(pickBestScoreForOutcome(grid.cells, "D")).toMatchObject({ homeGoals: 1, awayGoals: 1 });
  });
});

describe("MarketEngine 1X2 + Correct Score markets", () => {
  it("publishes a corrected, renormalised 1X2 split that sums to 1", () => {
    const engine = new MarketEngine(lockedMatch(), lambdas(1.7, 1.1));
    const markets = engine.buildAll();
    const result = markets.filter((m) => m.name.startsWith("Match Result"));
    expect(result).toHaveLength(3);
    const home = result.find((m) => m.name.includes("Arsenal Win"))!;
    const draw = result.find((m) => m.name.includes("Draw"))!;
    const away = result.find((m) => m.name.includes("Chelsea Win"))!;
    // The 8-agent ensemble jitter moves each cell by a few thousandths, so the
    // published split sums to 1 within that band (and no longer drifts to the
    // 1.02+ that a uniform τ would leave behind).
    const total = home.hitRate + draw.hitRate + away.hitRate;
    expect(total).toBeGreaterThan(0.98);
    expect(total).toBeLessThan(1.02);

    // The published draw must sit above the independent-Poisson draw, which is
    // what motivates the correction in the first place.
    const poissonDraw = buildCorrectScoreGrid(1.7, 1.1, 0).outcome.draw;
    expect(draw.hitRate).toBeGreaterThan(poissonDraw);
  });

  it("prices all 16 Correct Score markets off the corrected grid", () => {
    const engine = new MarketEngine(lockedMatch(), lambdas(1.7, 1.1));
    const markets = engine.buildAll();
    const cs = markets.filter((m) => m.name.startsWith("Correct Score"));
    expect(cs).toHaveLength(16);
    const grid = buildCorrectScoreGrid(1.7, 1.1, DIXON_COLES_RHO);
    for (const market of cs) {
      const label = market.name.replace("Correct Score ", "");
      const [h, a] = label.split("-").map(Number);
      const cell = grid.cells.find((c) => c.homeGoals === h && c.awayGoals === a)!;
      // Ensemble jitter is ±0.025 per market; the published value tracks the
      // corrected grid cell, never the raw Poisson product.
      expect(Math.abs(market.hitRate - cell.probability)).toBeLessThan(0.05);
      expect(Math.abs(market.hitRate - cell.poissonProbability)).toBeLessThan(0.05);
    }
    // The corrected 1-1 cell must out-price the pure-Poisson 1-1 cell.
    const oneOne = grid.cells.find((c) => c.homeGoals === 1 && c.awayGoals === 1)!;
    expect(oneOne.probability).toBeGreaterThan(oneOne.poissonProbability);
  });
});
