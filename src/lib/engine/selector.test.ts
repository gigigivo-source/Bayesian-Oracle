// Selector stats-integration tests (Part 3).
//
// Verifies the stat-confidence mapping (which TeamStats field backs each market
// family) and the λ override from real canonical stats — including the
// historical-average fallback when the per-match stat is null.

import { describe, expect, it } from "vitest";
import { statFieldFor, statConfidenceFor, effectiveLambdas } from "./selector";
import type { Market } from "./types";
import type { LambdaSet } from "./lambdas";
import { emptyCanonicalMatchStats, type CanonicalMatchStats, type MatchStatsQuery } from "../data/types";

function market(name: string, family: string, selection = "Over 1.5"): Market {
  return {
    id: `mkt_${name}`, name, family, selection,
    hitRate: 0.6, ciLower: 0.5, ciUpper: 0.7, ciWidth: 0.2,
    fairOddsBest: 1.4, fairOddsWorst: 2, mqs: 6, grade: "B",
    confidence: "MEDIUM", disagreementIndex: 0.05, rejected: false, niche: false,
  };
}

const QUERY: MatchStatsQuery = {
  leagueSlug: "eng.1", eventId: "x", homeTeam: "Manchester United", awayTeam: "Arsenal", date: "2026-08-21",
};

function statsWith(mutate: (s: CanonicalMatchStats) => void): CanonicalMatchStats {
  const s = emptyCanonicalMatchStats(QUERY);
  mutate(s);
  return s;
}

function baseLam(): LambdaSet {
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

describe("statFieldFor", () => {
  it("maps each market family to its backing TeamStats field", () => {
    expect(statFieldFor(market("Total Corners O/U 9.5", "corners"))).toBe("corners");
    expect(statFieldFor(market("Total Cards O/U 3.5", "cards"))).toBe("yellowCards");
    expect(statFieldFor(market("Total SOT O/U 8.5", "shots"))).toBe("shotsOnTarget");
    expect(statFieldFor(market("Total Shots O/U 24.5", "shots"))).toBe("shots");
    expect(statFieldFor(market("Total Fouls O/U 21.5", "fouls"))).toBe("fouls");
    expect(statFieldFor(market("Total Offsides O/U 2.5", "offsides"))).toBe("offsides");
    expect(statFieldFor(market("Arsenal GK Saves O/U 2.5", "saves"))).toBe("saves");
    expect(statFieldFor(market("Total Goals O/U 2.5", "goals"))).toBe("goals");
    expect(statFieldFor(market("Match Result (1X2)", "match_result", "Arsenal Win"))).toBeNull();
  });
});

describe("statConfidenceFor", () => {
  it("returns full confidence when the stat is real for both teams", () => {
    const stats = statsWith((s) => { s.home.corners = 6; s.away.corners = 4; });
    expect(statConfidenceFor(market("Total Corners O/U 9.5", "corners"), stats)).toBe(1);
  });

  it("halves the confidence (0.5) when the stat is missing", () => {
    const stats = statsWith(() => { /* corners null */ });
    expect(statConfidenceFor(market("Total Corners O/U 9.5", "corners"), stats)).toBe(0.5);
  });

  it("defaults to full confidence when no stats are supplied (legacy)", () => {
    expect(statConfidenceFor(market("Total Corners O/U 9.5", "corners"), null)).toBe(1);
  });
});

describe("effectiveLambdas", () => {
  it("overrides the λ with real canonical stats where available", () => {
    const lam = baseLam();
    const stats = statsWith((s) => {
      s.home.xg = 2.1; s.away.xg = 0.9;
      s.home.corners = 8; s.away.corners = 3;
      s.home.shotsOnTarget = 7; s.away.shotsOnTarget = 4;
    });
    const out = effectiveLambdas(lam, stats);
    expect(out.homeGoals).toBe(2.1);
    expect(out.awayGoals).toBe(0.9);
    expect(out.homeCorners).toBe(8);
    expect(out.awayCorners).toBe(3);
    expect(out.homeSot).toBe(7);
    // Untouched where no stat was provided.
    expect(out.homeFouls).toBe(11);
  });

  it("falls back to the season average when the per-match stat is null", () => {
    const lam = baseLam();
    const stats = statsWith((s) => {
      s.home.avgCornersPerGame = 6.2;
      s.away.avgCornersPerGame = 5.1;
    });
    const out = effectiveLambdas(lam, stats);
    expect(out.homeCorners).toBe(6.2);
    expect(out.awayCorners).toBe(5.1);
  });

  it("leaves the model λ untouched when no stats object is provided", () => {
    const lam = baseLam();
    const out = effectiveLambdas(lam, null);
    expect(out).toBe(lam);
  });
});
