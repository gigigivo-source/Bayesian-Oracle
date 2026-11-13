// Tests for the chip-only Consecutive Goals markets (F14) in the market
// registry: the run-length probability model and the registry integration
// (exact ids, forced "No" selection, always scored, never rejected).

import { describe, expect, it } from "vitest";
import { MarketEngine, probRunOfAtLeast, probRunOfEither } from "./markets";
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
    dataCompletenessScore: 80,
    fallbackMode: false,
  };
}

function lambdas(overrides: Partial<LambdaSet> = {}): LambdaSet {
  return {
    homeGoals: 1.9, awayGoals: 1.2,
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
    ...overrides,
  };
}

const CONSEC_IDS = ["GOAL_CONSEC_A_NO", "GOAL_CONSEC_B_NO", "GOAL_CONSEC_EITHER_NO"];

describe("probRunOfAtLeast / probRunOfEither (run-length model)", () => {
  it("is ~0 when almost no goals are expected", () => {
    // λ = 0.05 → P(N ≥ 3) ≈ 2e-5, so a 3-in-a-row run is vanishingly rare.
    expect(probRunOfAtLeast(0.5, 0.05, 3)).toBeLessThan(0.001);
    expect(probRunOfEither(0.5, 0.05, 3)).toBeLessThan(0.002);
  });

  it("stays within [0, 1] across the goal-share / λ grid", () => {
    for (let share = 0.05; share <= 0.95; share += 0.1) {
      for (let lam = 0.5; lam <= 6; lam += 0.5) {
        for (const v of [
          probRunOfAtLeast(share, lam, 3),
          probRunOfAtLeast(1 - share, lam, 3),
          probRunOfEither(share, lam, 3),
        ]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("'either' is at least as likely as the best single side and obeys the union bound", () => {
    for (let share = 0.2; share <= 0.8; share += 0.15) {
      for (let lam = 1; lam <= 5; lam += 1) {
        const home = probRunOfAtLeast(share, lam, 3);
        const away = probRunOfAtLeast(1 - share, lam, 3);
        const either = probRunOfEither(share, lam, 3);
        expect(either).toBeGreaterThanOrEqual(Math.max(home, away) - 1e-9);
        expect(either).toBeLessThanOrEqual(Math.min(1, home + away) + 1e-9);
      }
    }
  });

  it("a dominant side has a higher single-side run probability", () => {
    const weak = probRunOfAtLeast(0.25, 3, 3);
    const strong = probRunOfAtLeast(0.75, 3, 3);
    expect(strong).toBeGreaterThan(weak);
  });
});

describe("MarketEngine Consecutive Goals registry integration", () => {
  it("builds exactly 285 markets including the 3 chip-only markets", () => {
    const engine = new MarketEngine(lockedMatch(), lambdas());
    const markets = engine.buildAll();
    // 220 + the expanded Correct Score grid: 4×4 → 9×9 adds 65 lines.
    expect(markets).toHaveLength(285);
    expect(markets.filter((m) => m.name.startsWith("Correct Score"))).toHaveLength(81);

    const consec = markets.filter((m) => m.family === "Consecutive Goals");
    expect(consec).toHaveLength(3);
    expect(consec.map((m) => m.id).sort()).toEqual([...CONSEC_IDS].sort());
  });

  it("uses the required ids, family, description and forced NO selection", () => {
    const engine = new MarketEngine(lockedMatch(), lambdas());
    const byId = new Map(engine.buildAll().map((m) => [m.id, m]));

    const home = byId.get("GOAL_CONSEC_A_NO")!;
    const away = byId.get("GOAL_CONSEC_B_NO")!;
    const either = byId.get("GOAL_CONSEC_EITHER_NO")!;

    expect(home.name).toBe("Arsenal Consecutive Goals (3 in a row)");
    expect(away.name).toBe("Chelsea Consecutive Goals (3 in a row)");
    expect(either.name).toBe("Either Team Consecutive Goals (3 in a row)");

    for (const m of [home, away, either]) {
      expect(m.family).toBe("Consecutive Goals");
      expect(m.selection).toBe("No");
      expect(m.rejected).toBe(false);
      expect(typeof m.hitRate).toBe("number");
      expect(m.hitRate).toBeGreaterThan(0);
      expect(m.hitRate).toBeLessThan(1);
      expect(m.reason).toMatch(/consecutive-goal run model/i);
      expect(m.explanation?.whySelectedForMatch).toContain("Arsenal vs Chelsea");
      expect(m.explanation?.whyOutcomePossible).toContain("goal timestamps");
    }
  });

  it("hit rates reflect the run model: fewer expected goals → higher P(No)", () => {
    const low = new MarketEngine(lockedMatch(), lambdas({ homeGoals: 0.7, awayGoals: 0.6 })).buildAll();
    const high = new MarketEngine(lockedMatch(), lambdas({ homeGoals: 3.2, awayGoals: 2.8 })).buildAll();
    const pLow = low.find((m) => m.id === "GOAL_CONSEC_EITHER_NO")!.hitRate;
    const pHigh = high.find((m) => m.id === "GOAL_CONSEC_EITHER_NO")!.hitRate;
    expect(pLow).toBeGreaterThan(pHigh);
  });

  it("keeps all registry market ids unique (stable chip ids)", () => {
    const engine = new MarketEngine(lockedMatch(), lambdas());
    const ids = engine.buildAll().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
