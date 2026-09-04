// Tests for the tennis market engine: the point-by-point model (service game,
// tiebreak, set and match dynamic programs), the ELO calibration, the market
// families and the refusal rules (no ELO → no prediction; no personal serve
// baseline → no aces/double-fault market).

import { describe, expect, it } from "vitest";
import {
  combineServeReturn,
  formatScoreline,
  gameWinProbFromSetProb,
  logistic,
  logit,
  matchDistribution,
  matchDistributionFromSetProb,
  matchProbFromSetProb,
  predictTennisMatch,
  serviceGameWinProb,
  setOutcomeDistribution,
  setProbFromGameProb,
  setScoreDistribution,
  setWinProbFromMatchProb,
  setWinProbFromOutcomes,
  solveServeShift,
  tiebreakWinProb,
  TennisModelError,
  type TennisMatchupInput,
  type TennisMarketFamily,
  type TennisScorelinePath,
} from "./markets";
import type { TennisTourBaselines } from "../data/sources/tennis";

// ─── Set / match model ────────────────────────────────────────────────────────

describe("matchProbFromSetProb / setWinProbFromMatchProb", () => {
  it("best-of-3 and best-of-5 formulas are exact and symmetric", () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      expect(matchProbFromSetProb(p, 3)).toBeCloseTo(p * p * (3 - 2 * p), 10);
      expect(matchProbFromSetProb(p, 5)).toBeCloseTo(p ** 3 * (1 + 3 * (1 - p) + 6 * (1 - p) ** 2), 10);
    }
    expect(matchProbFromSetProb(0.5, 3)).toBe(0.5);
    expect(matchProbFromSetProb(0.5, 5)).toBe(0.5);
  });

  it("inverts the match probability exactly (round trip)", () => {
    for (const p of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      for (const bestOf of [3, 5] as const) {
        const matchProb = matchProbFromSetProb(p, bestOf);
        expect(setWinProbFromMatchProb(matchProb, bestOf)).toBeCloseTo(p, 5);
      }
    }
  });

  it("is monotone: a better set player wins the match more often", () => {
    expect(matchProbFromSetProb(0.6, 3)).toBeGreaterThan(matchProbFromSetProb(0.55, 3));
    expect(matchProbFromSetProb(0.6, 5)).toBeGreaterThan(matchProbFromSetProb(0.55, 5));
  });
});

describe("setProbFromGameProb / gameWinProbFromSetProb (ELO-only path)", () => {
  it("round trips the set probability", () => {
    for (const setProb of [0.2, 0.4, 0.5, 0.6, 0.8]) {
      const g = gameWinProbFromSetProb(setProb);
      expect(setProbFromGameProb(g)).toBeCloseTo(setProb, 5);
    }
  });

  it("is 50/50 at p=0.5 and monotone in the game probability", () => {
    expect(setProbFromGameProb(0.5)).toBeCloseTo(0.5, 10);
    expect(setProbFromGameProb(0.55)).toBeGreaterThan(0.5);
    expect(setProbFromGameProb(0.45)).toBeLessThan(0.5);
  });
});

describe("serviceGameWinProb", () => {
  it("matches the closed-form hold probability at known values", () => {
    // p = 0.5 → 0.5 by symmetry; p = 0.64 → ~0.808 (standard ATP hold rate).
    expect(serviceGameWinProb(0.5)).toBeCloseTo(0.5, 10);
    // Closed form: p⁴(1+4q+10q²) + 20p³q³ · p²/(1−2pq).
    expect(serviceGameWinProb(0.64)).toBeCloseTo(0.8126, 4);
    expect(serviceGameWinProb(0.6)).toBeCloseTo(0.7357, 3);
  });

  it("is monotone and bounded", () => {
    let previous = 0;
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const hold = serviceGameWinProb(p);
      expect(hold).toBeGreaterThan(previous);
      expect(hold).toBeGreaterThan(0);
      expect(hold).toBeLessThan(1);
      previous = hold;
    }
  });

  it("amplifies the point advantage (a 60/40 point edge is a 74/26 game edge)", () => {
    expect(serviceGameWinProb(0.6)).toBeGreaterThan(0.7);
    expect(serviceGameWinProb(0.4)).toBeLessThan(0.3);
  });
});

describe("tiebreakWinProb", () => {
  it("is 0.5 for equal servers and monotone in the server's edge", () => {
    expect(tiebreakWinProb(0.65, 0.65)).toBeCloseTo(0.5, 6);
    expect(tiebreakWinProb(0.7, 0.6)).toBeGreaterThan(0.5);
    expect(tiebreakWinProb(0.6, 0.7)).toBeLessThan(0.5);
  });

  it("mirrors when the players swap", () => {
    const a = tiebreakWinProb(0.68, 0.6);
    const b = tiebreakWinProb(0.6, 0.68);
    expect(a + b).toBeCloseTo(1, 6);
  });
});

describe("combineServeReturn", () => {
  const base = 0.62;

  it("returns the tour baseline for average vs average", () => {
    expect(combineServeReturn(base, 1 - base, base)).toBeCloseTo(base, 10);
  });

  it("lifts the server against a weak returner and drops it against a strong one", () => {
    const vsWeak = combineServeReturn(0.7, 0.32, base);
    const vsAverage = combineServeReturn(0.7, 1 - base, base);
    const vsStrong = combineServeReturn(0.7, 0.45, base);
    expect(vsWeak).toBeGreaterThan(vsAverage);
    expect(vsAverage).toBeGreaterThan(vsStrong);
  });

  it("stays inside (0, 1) for extreme inputs", () => {
    for (const [serve, ret] of [
      [0.95, 0.05],
      [0.05, 0.95],
      [0.5, 0.5],
    ] as const) {
      const p = combineServeReturn(serve, ret, base);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });
});

describe("setOutcomeDistribution", () => {
  it("sums to 1 and covers the 14 legal set scores", () => {
    const outcomes = setOutcomeDistribution(0.64, 0.6);
    const sum = outcomes.reduce((acc, o) => acc + o.prob, 0);
    expect(sum).toBeCloseTo(1, 8);
    expect(outcomes.length).toBeLessThanOrEqual(14);
    for (const o of outcomes) {
      const winner = Math.max(o.aGames, o.bGames);
      const loser = Math.min(o.aGames, o.bGames);
      const legal = (winner === 6 && loser <= 4) || (winner === 7 && (loser === 5 || loser === 6));
      expect(legal).toBe(true);
    }
  });

  it("is symmetric for identical players", () => {
    const outcomes = setOutcomeDistribution(0.62, 0.62);
    const by = (a: number, b: number): number =>
      outcomes.find((o) => o.aGames === a && o.bGames === b)?.prob ?? 0;
    expect(by(6, 0)).toBeCloseTo(by(0, 6), 8);
    expect(by(7, 6)).toBeCloseTo(by(6, 7), 8);
    expect(setWinProbFromOutcomes(outcomes)).toBeCloseTo(0.5, 6);
  });

  it("gives the stronger server a higher set-win probability", () => {
    const strong = setWinProbFromOutcomes(setOutcomeDistribution(0.7, 0.6));
    const weak = setWinProbFromOutcomes(setOutcomeDistribution(0.6, 0.7));
    expect(strong).toBeGreaterThan(0.5);
    expect(weak).toBeLessThan(0.5);
  });

  it("prices a realistic ~6-7% chance of any tiebreak at equal strength", () => {
    const outcomes = setOutcomeDistribution(0.62, 0.62);
    const tb = outcomes
      .filter((o) => o.tiebreak)
      .reduce((acc, o) => acc + o.prob, 0);
    expect(tb).toBeGreaterThan(0.05);
    expect(tb).toBeLessThan(0.2);
  });
});

describe("solveServeShift", () => {
  it("reproduces the target match probability", () => {
    for (const target of [0.3, 0.5, 0.72, 0.9]) {
      const shift = solveServeShift(0.64, 0.62, target, 3);
      const prob = matchProbFromSetProb(
        setWinProbFromOutcomes(
          setOutcomeDistribution(logistic(logit(0.64) + shift), logistic(logit(0.62) - shift)),
        ),
        3,
      );
      expect(prob).toBeCloseTo(target, 4);
    }
  });

  it("is monotone: a bigger ELO edge needs a bigger positive shift", () => {
    const small = solveServeShift(0.63, 0.63, 0.6, 3);
    const big = solveServeShift(0.63, 0.63, 0.85, 3);
    expect(big).toBeGreaterThan(small);
  });
});

describe("matchDistribution", () => {
  it("set betting and total games each sum to 1", () => {
    for (const bestOf of [3, 5] as const) {
      const dist = matchDistributionFromSetProb(0.62, bestOf);
      expect(dist.setBetting.reduce((acc, e) => acc + e.prob, 0)).toBeCloseTo(1, 6);
      expect(dist.totalGames.reduce((acc, e) => acc + e.prob, 0)).toBeCloseTo(1, 6);
      expect(dist.matchProbA + dist.matchProbB).toBeCloseTo(1, 6);
    }
  });

  it("reproduces the input match probability", () => {
    for (const setProb of [0.55, 0.62, 0.7]) {
      for (const bestOf of [3, 5] as const) {
        const dist = matchDistributionFromSetProb(setProb, bestOf);
        expect(dist.matchProbA).toBeCloseTo(matchProbFromSetProb(setProb, bestOf), 5);
      }
    }
  });

  it("expects ~24 total games for equal players in best-of-3, ~40 in best-of-5", () => {
    expect(matchDistributionFromSetProb(0.5, 3).expectedTotalGames).toBeCloseTo(24.16, 1);
    expect(matchDistributionFromSetProb(0.5, 5).expectedTotalGames).toBeCloseTo(39.86, 1);
  });

  it("only offers legal final set counts", () => {
    const bo3 = matchDistributionFromSetProb(0.6, 3);
    for (const e of bo3.setBetting) {
      expect(Math.max(e.setsA, e.setsB)).toBe(2);
      expect(Math.min(e.setsA, e.setsB)).toBeLessThanOrEqual(1);
    }
    const bo5 = matchDistributionFromSetProb(0.6, 5);
    for (const e of bo5.setBetting) {
      expect(Math.max(e.setsA, e.setsB)).toBe(3);
      expect(Math.min(e.setsA, e.setsB)).toBeLessThanOrEqual(2);
    }
  });

  it("produces the same distribution from the serve model when calibrated", () => {
    const target = 0.68;
    const shift = solveServeShift(0.64, 0.61, target, 3);
    const outcomes = setOutcomeDistribution(
      logistic(logit(0.64) + shift),
      logistic(logit(0.61) - shift),
    );
    const dist = matchDistribution(outcomes, 3);
    expect(dist.matchProbA).toBeCloseTo(target, 4);
    expect(dist.expectedTotalGames).toBeGreaterThan(18);
    expect(dist.expectedTotalGames).toBeLessThan(34);
  });
});

describe("formatScoreline", () => {
  it("writes each set from the match winner's perspective", () => {
    const path: TennisScorelinePath = {
      setScores: ["6-4", "3-6", "7-6"], // A's perspective: A won sets 1 and 3
      setsA: 2,
      setsB: 1,
      totalGames: 26,
      prob: 0.05,
    };
    expect(formatScoreline(path)).toBe("6-4 3-6 7-6");
    const bPath: TennisScorelinePath = {
      setScores: ["4-6", "6-3", "6-7"], // A's perspective: B won the match
      setsA: 1,
      setsB: 2,
      totalGames: 26,
      prob: 0.05,
    };
    expect(formatScoreline(bPath)).toBe("6-4 3-6 7-6");
  });
});

// ─── Full prediction ──────────────────────────────────────────────────────────

const TOUR_BASELINES: TennisTourBaselines = {
  acesPerMatch: 8.4,
  doubleFaultsPerMatch: 3.6,
  bpFacedPerMatch: 6.2,
  serveWinRate: 0.62,
  returnWinRate: 0.38,
  matchesSampled: 5_000,
  statMatches: 2_500,
  avgGamesPerMatch: 24.4,
};

function player(overrides: Partial<TennisMatchupInput["home"]> = {}): TennisMatchupInput["home"] {
  return {
    name: "Player A",
    elo: 1850,
    rank: 3,
    matchesPlayed: 60,
    surfaceMatches: 22,
    acesPerMatch: 11,
    doubleFaultsPerMatch: 3,
    bpFacedPerMatch: 5,
    serveWinRate: 0.68,
    returnWinRate: 0.42,
    baselineSource: "surface",
    ...overrides,
  };
}

function matchup(overrides: Partial<TennisMatchupInput> = {}): TennisMatchupInput {
  return {
    tour: "atp",
    tournament: "Wimbledon",
    surface: "grass",
    round: "Final",
    date: "2026-07-12",
    bestOf: 3,
    home: player(),
    away: player({
      name: "Player B",
      elo: 1750,
      rank: 12,
      serveWinRate: 0.63,
      returnWinRate: 0.37,
      acesPerMatch: 7,
      doubleFaultsPerMatch: 4,
      bpFacedPerMatch: 8,
      baselineSource: "overall",
    }),
    tourBaselines: TOUR_BASELINES,
    ...overrides,
  };
}

describe("predictTennisMatch", () => {
  const prediction = predictTennisMatch(matchup());

  it("favours the higher-rated player and exposes fair odds", () => {
    expect(prediction.matchWinner.home).toBeGreaterThan(0.5);
    expect(prediction.matchWinner.favourite).toBe("Player A");
    expect(prediction.matchWinner.home + prediction.matchWinner.away).toBeCloseTo(1, 6);
    expect(prediction.matchWinner.fairOddsHome).toBeCloseTo(1 / prediction.matchWinner.home, 2);
    expect(prediction.matchWinner.surfaceEloHome).toBeGreaterThan(
      prediction.matchWinner.surfaceEloAway,
    );
  });

  it("applies the surface modifier: grass widens the gap, hard is the baseline", () => {
    const grass = predictTennisMatch(matchup({ surface: "grass" }));
    const hard = predictTennisMatch(matchup({ surface: "hard" }));
    const clay = predictTennisMatch(matchup({ surface: "clay" }));
    expect(grass.matchWinner.home).toBeGreaterThan(hard.matchWinner.home);
    expect(clay.matchWinner.home).toBeGreaterThan(hard.matchWinner.home);
    expect(grass.matchWinner.home).toBeGreaterThan(clay.matchWinner.home);
  });

  it("builds every market family with valid probabilities and odds", () => {
    const families = new Set(prediction.markets.map((m) => m.family));
    const expected: TennisMarketFamily[] = [
      "Match Winner",
      "Total Games",
      "Set Winner",
      "Correct Score",
      "Aces",
      "Double Faults",
      "Break Points",
    ];
    for (const family of expected) expect(families.has(family)).toBe(true);

    for (const market of prediction.markets) {
      expect(market.probability).toBeGreaterThan(0.001);
      expect(market.probability).toBeLessThan(0.999);
      expect(Math.abs(market.fairOdds - 1 / market.probability) / (1 / market.probability)).toBeLessThan(
        0.02,
      );
    }
  });

  it("emits O/U lines whose over and under sides complement to 1", () => {
    for (const line of prediction.totalGames.lines) {
      expect(line.overProb + line.underProb).toBeCloseTo(1, 6);
    }
    for (const side of [prediction.aces?.home, prediction.aces?.away]) {
      for (const line of side?.lines ?? []) {
        expect(line.overProb + line.underProb).toBeCloseTo(1, 6);
      }
    }
  });

  it("exposes the total-games probabilities the API contract promises", () => {
    const keys = Object.keys(prediction.totalGames.probabilities);
    expect(keys.some((k) => k.startsWith("over_"))).toBe(true);
    expect(keys.some((k) => k.startsWith("under_"))).toBe(true);
    const line = prediction.totalGames.lines[0];
    expect(prediction.totalGames.probabilities[`over_${line.line.toFixed(1)}`]).toBeCloseTo(
      line.overProb,
      6,
    );
  });

  it("projects a winner-first scoreline with a probability", () => {
    expect(prediction.projectedScoreline).toMatch(/^[0-9]-[0-9]( [0-9]-[0-9]){1,4}$/);
    expect(prediction.projectedWinner).toBe("Player A");
    expect(prediction.projectedScorelineProb).toBeGreaterThan(0.005);
    expect(prediction.topScorelines.length).toBeGreaterThan(2);
    for (const entry of prediction.topScorelines) {
      expect(entry.prob).toBeGreaterThan(0);
      expect(entry.score).toMatch(/^[0-9]-[0-9]( [0-9]-[0-9]){1,4}$/);
    }
  });

  it("distributes the set scores (2-0, 2-1, 0-2, 1-2 in best-of-3)", () => {
    const dist = prediction.scoreDistribution;
    const sum = Object.values(dist).reduce((acc, p) => acc + p, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(Object.keys(dist).sort()).toEqual(["0-2", "1-2", "2-0", "2-1"]);
    expect(prediction.setWinner.sets).toHaveLength(3);
    for (const set of prediction.setWinner.sets) {
      expect(set.home + set.away).toBeCloseTo(1, 5);
    }
  });

  it("derives aces/DF lines from the personal baselines, never the tour average", () => {
    expect(prediction.aces?.home.expected).toBeCloseTo(11 * (prediction.totalGames.expected / 24.4), 1);
    expect(prediction.aces?.home.basis).toBe("surface split");
    expect(prediction.aces?.away.expected).toBeGreaterThan(0);
    expect(prediction.aces?.away.basis).toBe("career average");
    expect(prediction.doubleFaults?.home.expected).toBeGreaterThan(0);
  });

  it("calibrates the point model to the ELO match probability", () => {
    expect(prediction.model.mode).toBe("serve-elo");
    expect(prediction.model.pointProbHomeServe).not.toBeNull();
    expect(prediction.model.holdHome).not.toBeNull();
    expect(prediction.model.holdHome ?? 0).toBeGreaterThan(0.6);
    expect(prediction.model.holdAway ?? 0).toBeGreaterThan(0.6);
    // The serve model's match probability must agree with the ELO anchor.
    expect(
      matchProbFromSetProb(prediction.model.setProbHome, 3),
    ).toBeCloseTo(prediction.matchWinner.home, 3);
  });

  it("shifts the total-games ladder for best-of-5", () => {
    const bo5 = predictTennisMatch(matchup({ bestOf: 5 }));
    const bo5Lines = bo5.totalGames.lines.map((l) => l.line);
    const bo3Lines = prediction.totalGames.lines.map((l) => l.line);
    expect(Math.min(...bo5Lines)).toBeGreaterThan(Math.max(...bo3Lines));
    expect(bo5.totalGames.expected).toBeGreaterThan(30);
    expect(bo5.setWinner.sets).toHaveLength(5);
    expect(bo5.setWinner.setBetting.map((s) => s.score)).toEqual(
      expect.arrayContaining(["3-0", "3-1", "3-2", "0-3", "1-3", "2-3"]),
    );
  });

  it("produces different scorelines for different ELO gaps", () => {
    const tight = predictTennisMatch(matchup({ away: player({ name: "Rival", elo: 1840 }) }));
    const loose = predictTennisMatch(matchup({ away: player({ name: "Underdog", elo: 1550 }) }));
    expect(tight.matchWinner.home).toBeLessThan(loose.matchWinner.home);
    expect(tight.projectedScoreline).not.toBe(loose.projectedScoreline);
    expect(tight.totalGames.expected).not.toBe(loose.totalGames.expected);
  });
});

describe("predictTennisMatch refusals", () => {
  it("throws when a player has no surface ELO (no 1500 default)", () => {
    expect(() =>
      predictTennisMatch(matchup({ home: player({ elo: null }) })),
    ).toThrow(TennisModelError);
    expect(() =>
      predictTennisMatch(matchup({ away: player({ name: "Player B", elo: null }) })),
    ).toThrow(/surface ELO/);
  });

  it("prices aces/double faults only from personal baselines", () => {
    const noServe = predictTennisMatch(
      matchup({
        home: player({ acesPerMatch: null, doubleFaultsPerMatch: null, bpFacedPerMatch: null }),
      }),
    );
    expect(noServe.aces).toBeNull();
    expect(noServe.doubleFaults).toBeNull();
    expect(noServe.markets.some((m) => m.family === "Aces")).toBe(false);
    expect(noServe.notes.some((n) => n.includes("Aces market skipped"))).toBe(true);
    expect(noServe.dataQuality).toBe("mixed");
  });

  it("falls back to the pure-ELO inversion when the dataset has no serve data", () => {
    const eloOnly = predictTennisMatch(matchup({ tourBaselines: null }));
    expect(eloOnly.model.mode).toBe("elo-only");
    expect(eloOnly.model.holdHome).toBeNull();
    expect(eloOnly.model.pointProbHomeServe).toBeNull();
    expect(eloOnly.projectedScoreline).toMatch(/^[0-9]-[0-9]/);
    expect(eloOnly.notes.some((n) => n.includes("pure-ELO inversion"))).toBe(true);
    // The shape is still ELO-driven: total games, scorelines and markets exist.
    expect(eloOnly.totalGames.expected).toBeGreaterThan(18);
    expect(eloOnly.topScorelines.length).toBeGreaterThan(2);
  });

  it("keeps the tour-average shape but labels data quality as mixed", () => {
    const mixed = predictTennisMatch(
      matchup({
        home: player({ serveWinRate: null, returnWinRate: null }),
        tourBaselines: TOUR_BASELINES,
      }),
    );
    expect(mixed.model.mode).toBe("serve-elo");
    expect(mixed.dataQuality).toBe("mixed");
    expect(mixed.notes.some((n) => n.includes("tour average"))).toBe(true);
  });

  it("marks a fully measured match as real data", () => {
    expect(predictTennisMatch(matchup()).dataQuality).toBe("real");
  });
});

describe("setScoreDistribution (ELO-only set model)", () => {
  it("sums to 1 across the game-probability grid", () => {
    for (const g of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
      const sum = setScoreDistribution(g).reduce((acc, o) => acc + o.prob, 0);
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it("covers exactly the 14 legal set scores", () => {
    expect(setScoreDistribution(0.6)).toHaveLength(14);
  });
});
