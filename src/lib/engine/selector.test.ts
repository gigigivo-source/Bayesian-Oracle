// Selector stats-integration tests (Part 3).
//
// Verifies the stat-confidence mapping (which TeamStats field backs each market
// family) and the λ override from real canonical stats — including the
// historical-average fallback when the per-match stat is null.

import { describe, expect, it } from "vitest";
import {
  statFieldFor,
  statConfidenceFor,
  effectiveLambdas,
  selectTopPicks,
  scoreMarket,
  RANKING_WEIGHTS,
  FACTOR_LABELS,
  type FactorKey,
} from "./selector";
import type { Market } from "./types";
import type { LambdaSet } from "./lambdas";
import {
  emptyCanonicalMatchStats,
  STAT_FIELDS,
  type CanonicalMatchStats,
  type MatchStatsQuery,
} from "../data/types";

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

// ─── 12-factor balanced composite ─────────────────────────────────────────────

const HOME = "Manchester United";
const AWAY = "Arsenal";

/** Distinct verifiable markets across several families. */
function marketSet(): Market[] {
  const defs: Array<[string, string, string, number]> = [
    ["Total Goals O/U 2.5",        "goals",       "Over 2.5",     0.62],
    ["Total Goals O/U 3.5",        "goals",       "Under 3.5",    0.66],
    ["Total Corners O/U 9.5",      "corners",     "Over 9.5",     0.58],
    ["Total Corners O/U 10.5",     "corners",     "Under 10.5",   0.60],
    ["Total Cards O/U 3.5",        "cards",       "Over 3.5",     0.57],
    ["Total SOT O/U 8.5",          "shots",       "Over 8.5",     0.59],
    ["Total Shots O/U 24.5",       "shots",       "Over 24.5",    0.61],
    ["Total Offsides O/U 2.5",     "offsides",    "Over 2.5",     0.56],
    [`${AWAY} GK Saves O/U 2.5`,   "saves",       "Over 2.5",     0.55],
    ["Both Teams To Score",        "btts",        "Yes",          0.63],
    ["Match Result (1X2)",         "match_result", `${HOME} Win`, 0.55],
    ["Double Chance 1X",           "double_chance", `${HOME} or Draw (1X)`, 0.70],
  ];
  return defs.map(([name, family, selection, hr], i) => ({
    id: `mkt_${i}`, name, family, selection,
    hitRate: hr, ciLower: hr - 0.08, ciUpper: Math.min(0.99, hr + 0.08), ciWidth: 0.16,
    fairOddsBest: 1 / Math.min(0.99, hr + 0.08), fairOddsWorst: 1 / Math.max(0.01, hr - 0.08),
    mqs: 6, grade: "B", confidence: "MEDIUM", disagreementIndex: 0.05,
    rejected: false, niche: false,
  }));
}

/** Canonical stats with every numeric field filled for both teams. */
function fullStats(): CanonicalMatchStats {
  const s = emptyCanonicalMatchStats(QUERY);
  for (const key of STAT_FIELDS) {
    (s.home[key] as number | null) = 5;
    (s.away[key] as number | null) = 4;
  }
  s.home.cleanSheet = false;
  s.away.cleanSheet = false;
  s.home.xg = 2.0; s.away.xg = 1.2;
  s.home.corners = 6; s.away.corners = 4;
  s.home.shotsOnTarget = 6; s.away.shotsOnTarget = 4;
  s.home.shots = 14; s.away.shots = 11;
  s.metadata.source = "API-Football";
  return s;
}

describe("12-factor balanced weights", () => {
  it("has exactly 12 factors whose weights sum to 100%", () => {
    const keys = Object.keys(RANKING_WEIGHTS);
    expect(keys).toHaveLength(12);
    const total = keys.reduce((sum, k) => sum + RANKING_WEIGHTS[k as FactorKey], 0);
    expect(total).toBeCloseTo(1.0, 10);
  });

  it("exposes the 12 human-readable factor labels used by the API", () => {
    const labels = Object.values(FACTOR_LABELS);
    expect(labels).toHaveLength(12);
    for (const expected of [
      "Deep statistical analysis", "All data mesh", "Stats", "Tactical analysis",
      "Match importance", "Player vs player forms", "Deep statistical vector",
      "Zero bias", "Form", "Conditional λ values", "Poisson", "Statistics all states filled",
    ]) {
      expect(labels).toContain(expected);
    }
  });
});

describe("composite score", () => {
  it("equals the weight-normalised sum of the AVAILABLE factors only", () => {
    const s = scoreMarket(marketSet()[0], baseLam(), HOME, AWAY, undefined, { stats: fullStats() });
    const active = (Object.keys(RANKING_WEIGHTS) as FactorKey[])
      .filter((k) => !s.excludedFactors.includes(k));
    const weightSum = active.reduce((sum, k) => sum + RANKING_WEIGHTS[k], 0);
    const expected = active.reduce((sum, k) => sum + RANKING_WEIGHTS[k] * s.breakdown[k], 0) / weightSum;
    expect(s.composite).toBeCloseTo(expected, 10);
    // appliedWeights renormalise to exactly 1 across the active factors.
    const applied = active.reduce((sum, k) => sum + (s.appliedWeights[k] ?? 0), 0);
    expect(applied).toBeCloseTo(1.0, 10);
  });

  it("excludes stats-backed factors (redistributing weight) when no stats exist", () => {
    const s = scoreMarket(marketSet()[0], baseLam(), HOME, AWAY, undefined, { stats: null });
    expect(s.excludedFactors).toContain("statisticsAllStatesFilled");
    expect(s.excludedFactors).toContain("deepStatisticalVector");
    // Stats factor still votes via its calibration component.
    expect(s.excludedFactors).not.toContain("stats");
  });
});

describe("selectTopPicks factor attachment (non-breaking)", () => {
  it("returns top10 and attaches factors + compositeScore to every pick", () => {
    const res = selectTopPicks(marketSet(), baseLam(), HOME, AWAY, undefined, { stats: fullStats() });
    expect(res.top10).toBeInstanceOf(Array);
    expect(res.top10.length).toBeGreaterThan(0);
    for (const pick of res.top10) {
      expect(pick.factors).toBeDefined();
      expect(typeof pick.compositeScore).toBe("number");
      // Existing fields are untouched — no structural breaking change.
      expect(typeof pick.id).toBe("string");
      expect(typeof pick.name).toBe("string");
      expect(typeof pick.hitRate).toBe("number");
      // Every factor key is one of the 12 known labels.
      for (const key of Object.keys(pick.factors!)) {
        expect(Object.values(FACTOR_LABELS)).toContain(key);
      }
      // No excluded factor is reported.
      const s = scoreMarket(pick, baseLam(), HOME, AWAY, undefined, { stats: fullStats() });
      for (const k of s.excludedFactors) {
        expect(pick.factors!).not.toHaveProperty(FACTOR_LABELS[k]);
      }
    }
  });

  it("scores Statistics-all-states-filled from real canonical completeness", () => {
    const res = selectTopPicks(marketSet(), baseLam(), HOME, AWAY, undefined, { stats: fullStats() });
    const pick = res.top10[0];
    expect(pick.factors!["Statistics all states filled"]).toBeCloseTo(1.0, 5);
    expect(pick.factors!["Deep statistical vector"]).toBeCloseTo(1.0, 5);
  });

  it("omits stats-backed factors when the aggregator has no stats", () => {
    const res = selectTopPicks(marketSet(), baseLam(), HOME, AWAY, undefined, { stats: null });
    const pick = res.top10[0];
    expect(pick.factors).toBeDefined();
    expect(pick.factors!).not.toHaveProperty("Statistics all states filled");
    expect(pick.factors!).not.toHaveProperty("Deep statistical vector");
    // Model-grounded factors still vote.
    expect(pick.factors!).toHaveProperty("Zero bias");
    expect(pick.factors!).toHaveProperty("Stats");
  });
});
