// Selector tests for the chip-only Consecutive Goals markets (Part 3):
// they are scored exactly like every other market (composite + factors are
// attached) but NEVER appear in top1 / top3 / top5 / top10 in any ranking mode.

import { describe, expect, it } from "vitest";
import { selectTopPicks, isRankingExcluded } from "./selector";
import type { Market } from "./types";
import type { LambdaSet } from "./lambdas";

function market(name: string, family: string, selection = "Over 1.5", id = `mkt_${name}`): Market {
  return {
    id, name, family, selection,
    hitRate: 0.6, ciLower: 0.5, ciUpper: 0.7, ciWidth: 0.2,
    fairOddsBest: 1.4, fairOddsWorst: 2, mqs: 6, grade: "B",
    confidence: "MEDIUM", disagreementIndex: 0.05, rejected: false, niche: false,
  };
}

function consecMarket(id: string, name: string): Market {
  const m = market(name, "Consecutive Goals", "No", id);
  m.hitRate = 0.94;
  m.ciLower = 0.9; m.ciUpper = 0.97; m.ciWidth = 0.07;
  m.grade = "B";
  m.reason = `Run-length model for ${name}`;
  return m;
}

const HOME = "Arsenal";
const AWAY = "Chelsea";

function lam(): LambdaSet {
  return {
    homeGoals: 1.8, awayGoals: 1.1,
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

const CONSEC_IDS = ["GOAL_CONSEC_A_NO", "GOAL_CONSEC_B_NO", "GOAL_CONSEC_EITHER_NO"];

function marketSet(): Market[] {
  const regular = [
    market("Total Goals O/U 2.5", "Goals"),
    market("Total Goals O/U 1.5", "Goals"),
    market("Both Teams To Score", "Goals", "Yes"),
    market("Total Corners O/U 9.5", "Corners"),
    market("Total Cards O/U 3.5", "Cards"),
    market("Total SOT O/U 8.5", "Shots"),
    market("Match Result: Arsenal Win", "Match Result", "Arsenal Win"),
    market("Double Chance 1X", "Match Result", "Arsenal or Draw (1X)"),
    market("Total Saves O/U 5.5", "Saves"),
    market("Total Offsides O/U 2.5", "Offsides"),
    market("Total Shots O/U 24.5", "Shots"),
    market("Total Fouls O/U 21.5", "Fouls"),
  ];
  const consec = [
    consecMarket("GOAL_CONSEC_A_NO", `${HOME} Consecutive Goals (3 in a row)`),
    consecMarket("GOAL_CONSEC_B_NO", `${AWAY} Consecutive Goals (3 in a row)`),
    consecMarket("GOAL_CONSEC_EITHER_NO", "Either Team Consecutive Goals (3 in a row)"),
  ];
  return [...regular, ...consec];
}

describe("isRankingExcluded", () => {
  it("flags the Consecutive Goals family and nothing else", () => {
    expect(isRankingExcluded(consecMarket("x", "Either Team Consecutive Goals (3 in a row)"))).toBe(true);
    expect(isRankingExcluded(market("Total Goals O/U 2.5", "Goals"))).toBe(false);
    expect(isRankingExcluded(market("3+ Consecutive Goals (Same Team)", "Goal Sequence"))).toBe(false);
  });
});

describe("selectTopPicks — Consecutive Goals never rank", () => {
  for (const mode of ["A", "B", "C", "D"] as const) {
    it(`keeps them out of top1/top3/top5/top10 in mode ${mode}`, () => {
      const res = selectTopPicks(marketSet(), lam(), HOME, AWAY, undefined, { rankingMode: mode });
      const rankedIds = new Set(
        [...res.top1, ...res.top3, ...res.top5, ...res.top10].map((m) => m.id),
      );
      for (const id of CONSEC_IDS) {
        expect(rankedIds.has(id)).toBe(false);
      }
      // The regular Top-10 still fills normally.
      expect(res.top10.length).toBeGreaterThan(0);
      expect(res.top10.length).toBeLessThanOrEqual(10);
    });
  }

  it("still attaches compositeScore + factors to the chip-only markets (scored like all others)", () => {
    const markets = marketSet();
    const res = selectTopPicks(markets, lam(), HOME, AWAY, undefined, { rankingMode: "B" });
    expect(res.top10.length).toBeGreaterThan(0);

    for (const id of CONSEC_IDS) {
      const m = markets.find((x) => x.id === id)!;
      expect(m.factors).toBeDefined();
      expect(Object.keys(m.factors!).length).toBeGreaterThan(0);
      expect(typeof m.compositeScore).toBe("number");
      expect(m.compositeScore!).toBeGreaterThan(0);
      expect(m.compositeScore!).toBeLessThanOrEqual(1);
      // Existing fields remain untouched.
      expect(m.hitRate).toBe(0.94);
      expect(m.selection).toBe("No");
    }
  });

  it("regular markets still rank as before (no behavioural change)", () => {
    const res = selectTopPicks(marketSet(), lam(), HOME, AWAY, undefined, { rankingMode: "B" });
    const inTop10 = res.top10.map((m) => m.name);
    expect(inTop10).not.toContain(`${HOME} Consecutive Goals (3 in a row)`);
    expect(inTop10).toContain("Total Goals O/U 2.5");
    for (const pick of res.top10) {
      expect(pick.factors).toBeDefined();
      expect(typeof pick.compositeScore).toBe("number");
    }
  });
});
