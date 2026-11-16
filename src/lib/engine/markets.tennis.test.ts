// Tests for the tennis market engine (T1–T6) in the market registry: the
// set/game probability model, the exact match distribution (total games, set
// betting, scorelines) and the full per-match market build.

import { describe, expect, it } from "vitest";
import {
  formatScoreline,
  gameWinProbFromSetProb,
  matchProbFromSetProb,
  matchSetDistribution,
  predictTennisMatch,
  setProbFromGameProb,
  setScoreDistribution,
  setWinProbFromMatchProb,
  type TennisMatchupInput,
  type TennisMarketFamily,
  type TennisScorelinePath,
} from "./markets";

// ─── Set / game model ─────────────────────────────────────────────────────────

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

describe("setProbFromGameProb / gameWinProbFromSetProb", () => {
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

describe("setScoreDistribution", () => {
  it("sums to 1 across the game-probability grid", () => {
    for (const g of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
      const sum = setScoreDistribution(g).reduce((acc, o) => acc + o.prob, 0);
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it("is symmetric at p=0.5 (6-0 as likely as 0-6, 7-6 as 6-7)", () => {
    const outcomes = setScoreDistribution(0.5);
    const by = (a: number, b: number) =>
      outcomes.find((o) => o.aGames === a && o.bGames === b)?.prob ?? 0;
    expect(by(6, 0)).toBeCloseTo(by(0, 6), 10);
    expect(by(7, 5)).toBeCloseTo(by(5, 7), 10);
    expect(by(7, 6)).toBeCloseTo(by(6, 7), 10);
    expect(by(7, 6)).toBeCloseTo(0.0615, 3); // C(10,5)/2^10 · 0.5 · 0.5 ≈ 6.15%
  });

  it("covers exactly the 14 legal set scores", () => {
    const outcomes = setScoreDistribution(0.6);
    expect(outcomes).toHaveLength(14);
    for (const o of outcomes) {
      const winner = Math.max(o.aGames, o.bGames);
      const loser = Math.min(o.aGames, o.bGames);
      const legal =
        (winner === 6 && loser <= 4) || (winner === 7 && (loser === 5 || loser === 6));
      expect(legal).toBe(true);
    }
  });
});

describe("matchSetDistribution", () => {
  it("set betting and total games each sum to 1", () => {
    for (const bestOf of [3, 5] as const) {
      const dist = matchSetDistribution(0.62, bestOf);
      expect(dist.setBetting.reduce((acc, e) => acc + e.prob, 0)).toBeCloseTo(1, 6);
      expect(dist.totalGames.reduce((acc, e) => acc + e.prob, 0)).toBeCloseTo(1, 6);
      expect(dist.matchProbA + dist.matchProbB).toBeCloseTo(1, 6);
    }
  });

  it("reproduces the input match probability", () => {
    for (const setProb of [0.55, 0.62, 0.7]) {
      for (const bestOf of [3, 5] as const) {
        const dist = matchSetDistribution(setProb, bestOf);
        expect(dist.matchProbA).toBeCloseTo(matchProbFromSetProb(setProb, bestOf), 5);
      }
    }
  });

  it("expects ~24.2 total games for equal players in best-of-3, ~39.9 in best-of-5", () => {
    // Hand-checked: 9.66 expected games per set × 2.5 expected sets (bo3).
    expect(matchSetDistribution(0.5, 3).expectedTotalGames).toBeCloseTo(24.16, 1);
    expect(matchSetDistribution(0.5, 5).expectedTotalGames).toBeCloseTo(39.86, 1);
  });

  it("only offers legal final set counts", () => {
    const bo3 = matchSetDistribution(0.6, 3);
    for (const e of bo3.setBetting) {
      expect(Math.max(e.setsA, e.setsB)).toBe(2);
      expect(Math.min(e.setsA, e.setsB)).toBeLessThanOrEqual(1);
    }
    const bo5 = matchSetDistribution(0.6, 5);
    for (const e of bo5.setBetting) {
      expect(Math.max(e.setsA, e.setsB)).toBe(3);
      expect(Math.min(e.setsA, e.setsB)).toBeLessThanOrEqual(2);
    }
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

function matchup(overrides: Partial<TennisMatchupInput> = {}): TennisMatchupInput {
  return {
    tour: "atp",
    tournament: "Wimbledon",
    surface: "grass",
    round: "Final",
    date: "2026-07-12",
    bestOf: 3,
    playerA: {
      name: "Player A",
      elo: 1850,
      ratingSource: "elo",
      matchesPlayed: 60,
      rank: 3,
      acesPerMatch: 11,
      doubleFaultsPerMatch: 3,
      bpFacedPerMatch: 5,
      baselineSource: "surface",
    },
    playerB: {
      name: "Player B",
      elo: 1750,
      ratingSource: "elo",
      matchesPlayed: 60,
      rank: 12,
      acesPerMatch: 7,
      doubleFaultsPerMatch: 4,
      bpFacedPerMatch: 8,
      baselineSource: "overall",
    },
    tourBaselines: { acesPerMatch: 8.4, doubleFaultsPerMatch: 3.6, bpFacedPerMatch: 6.2 },
    ...overrides,
  };
}

describe("predictTennisMatch", () => {
  const prediction = predictTennisMatch(matchup());

  it("favours the higher-rated player and exposes fair odds", () => {
    expect(prediction.matchWinner.probA).toBeGreaterThan(0.5);
    expect(prediction.matchWinner.favorite).toBe("Player A");
    expect(prediction.matchWinner.probA + prediction.matchWinner.probB).toBeCloseTo(1, 6);
    expect(prediction.matchWinner.fairOddsA).toBeCloseTo(1 / prediction.matchWinner.probA, 2);
    expect(prediction.matchWinner.effectiveEloA).toBeGreaterThan(prediction.matchWinner.effectiveEloB);
  });

  it("uses raw Elo (not surface-modified) for Match Winner probability across surfaces", () => {
    const grass = predictTennisMatch(matchup({ surface: "grass" }));
    const hard = predictTennisMatch(matchup({ surface: "hard" }));
    const clay = predictTennisMatch(matchup({ surface: "clay" }));
    const expectedRawProb = 1 / (1 + 10 ** ((1750 - 1850) / 400));
    expect(grass.matchWinner.probA).toBeCloseTo(expectedRawProb, 3);
    expect(hard.matchWinner.probA).toBeCloseTo(expectedRawProb, 3);
    expect(clay.matchWinner.probA).toBeCloseTo(expectedRawProb, 3);
    expect(grass.matchWinner.probA).toBe(hard.matchWinner.probA);
    expect(clay.matchWinner.probA).toBe(hard.matchWinner.probA);
  });

  it("computes eloGap and classifies PLATINUM_LOCK, GOLD_LOCK, LOCK, AVOID, and NONE tiers", () => {
    const base = matchup({ surface: "hard", date: "2026-07-12T12:00:00Z" });
    const strongA = { ...base.playerA, elo: 1950, matchesPlayed: 60, lastPlayed: "2026-07-05T00:00:00Z", acesPerMatch: 7.5 };
    const weakB = { ...base.playerB, elo: 1600, matchesPlayed: 40, lastPlayed: "2026-07-08T00:00:00Z", acesPerMatch: 5.0 };

    // Gap < 350 → NONE
    const noneBo3 = predictTennisMatch(base);
    expect(noneBo3.eloGap).toBe(100);
    expect(noneBo3.lockTier).toBe("NONE");
    expect(noneBo3.lockReasons).toEqual([]);

    const belowLockBo5 = predictTennisMatch(
      matchup({
        surface: "hard",
        bestOf: 5,
        playerA: { ...strongA, elo: 1850 },
        playerB: { ...weakB, elo: 1600 },
      }),
    );
    expect(belowLockBo5.eloGap).toBe(250);
    expect(belowLockBo5.lockTier).toBe("NONE");

    // Gap >= 350 in Bo5 → PLATINUM_LOCK (Grand Slams bulletproof, even on grass)
    const platinum = predictTennisMatch(
      matchup({
        surface: "grass",
        bestOf: 5,
        playerA: strongA,
        playerB: weakB,
      }),
    );
    expect(platinum.eloGap).toBe(350);
    expect(platinum.lockTier).toBe("PLATINUM_LOCK");
    expect(platinum.lockReasons.length).toBeGreaterThan(0);

    // Gap >= 350 in Bo3 with all traps cleared → GOLD_LOCK
    const gold = predictTennisMatch(
      matchup({
        surface: "hard",
        bestOf: 3,
        date: "2026-07-12T12:00:00Z",
        playerA: strongA,
        playerB: weakB,
      }),
    );
    expect(gold.eloGap).toBe(350);
    expect(gold.lockTier).toBe("GOLD_LOCK");

    // Gap >= 350 in Bo3 on Grass → downgraded to LOCK caution
    const grassLock = predictTennisMatch(
      matchup({
        surface: "grass",
        bestOf: 3,
        date: "2026-07-12T12:00:00Z",
        playerA: strongA,
        playerB: weakB,
      }),
    );
    expect(grassLock.lockTier).toBe("LOCK");
    expect(grassLock.lockReasons[0]).toMatch(/grass/i);

    // Gap >= 350 in Bo3 with rusty/low-sample player (< 2 matches) → downgraded to LOCK caution
    const lowSampleLock = predictTennisMatch(
      matchup({
        surface: "hard",
        bestOf: 3,
        date: "2026-07-12T12:00:00Z",
        playerA: strongA,
        playerB: { ...weakB, matchesPlayed: 1 },
      }),
    );
    expect(lowSampleLock.lockTier).toBe("LOCK");
    expect(lowSampleLock.lockReasons[0]).toMatch(/sample|<2/i);

    // Gap >= 350 in Bo3 with favorite returning from > 30-day layoff → downgraded to LOCK caution
    const layoffLock = predictTennisMatch(
      matchup({
        surface: "hard",
        bestOf: 3,
        date: "2026-07-12T12:00:00Z",
        playerA: { ...strongA, lastPlayed: "2026-05-20T00:00:00Z" },
        playerB: weakB,
      }),
    );
    expect(layoffLock.lockTier).toBe("LOCK");
    expect(layoffLock.lockReasons[0]).toMatch(/layoff/i);

    // Gap >= 350 in Bo3 vs big-server underdog → AVOID trap
    const bigServerAvoid = predictTennisMatch(
      matchup({
        surface: "hard",
        bestOf: 3,
        date: "2026-07-12T12:00:00Z",
        playerA: strongA,
        playerB: { ...weakB, acesPerMatch: 12.5, baselineSource: "surface" },
      }),
    );
    expect(bigServerAvoid.lockTier).toBe("AVOID");
    expect(bigServerAvoid.lockReasons[0]).toMatch(/big-server/i);
  });

  it("builds every market family T1–T6 with valid probabilities and odds", () => {
    const families = new Set(prediction.markets.map((m) => m.family));
    const expected: TennisMarketFamily[] = [
      "Match Winner",
      "Total Games",
      "Set Winner",
      "Aces",
      "Double Faults",
      "Break Points",
    ];
    for (const family of expected) expect(families.has(family)).toBe(true);

    for (const market of prediction.markets) {
      expect(market.probability).toBeGreaterThan(0.001);
      expect(market.probability).toBeLessThan(0.999);
      expect(market.fairOdds).toBeCloseTo(1 / market.probability, 1);
    }
  });

  it("emits O/U lines whose over and under sides complement to 1", () => {
    for (const group of [...prediction.aces ?? [], ...prediction.doubleFaults ?? [], ...prediction.breakPoints ?? []]) {
      for (const line of group.lines) {
        expect(line.overProb + line.underProb).toBeCloseTo(1, 6);
        expect(line.overProb).toBeGreaterThanOrEqual(0);
        expect(line.overProb).toBeLessThanOrEqual(1);
      }
    }
    for (const line of prediction.totalGames.lines) {
      expect(line.overProb + line.underProb).toBeCloseTo(1, 6);
    }
  });

  it("projects a winner-first scoreline with a probability", () => {
    expect(prediction.projectedScoreline).toMatch(/^[0-9]-[0-9]( [0-9]-[0-9]){1,4}$/);
    expect(prediction.projectedWinner).toBe("Player A");
    expect(prediction.projectedScorelineProb).toBeGreaterThan(0.01);
    expect(prediction.scorelineTop.length).toBeGreaterThan(2);
    for (const entry of prediction.scorelineTop) {
      expect(entry.prob).toBeGreaterThan(0);
    }
  });

  it("derives aces/DF lines from the personal baselines, not the tour fallback", () => {
    const acesA = prediction.aces?.find((g) => g.scope === "Player A");
    expect(acesA?.expected).toBe(11);
    expect(acesA?.basis).toBe("surface split");
    const acesB = prediction.aces?.find((g) => g.scope === "Player B");
    expect(acesB?.expected).toBe(7);
    const dfA = prediction.doubleFaults?.find((g) => g.scope === "Player A");
    expect(dfA?.expected).toBe(3);
    const bp = prediction.breakPoints?.find((g) => g.scope === "Match Total");
    expect(bp?.expected).toBe(13); // 5 + 8
  });

  it("falls back to the tour baseline for players without history", () => {
    const noHistory = predictTennisMatch(
      matchup({
        playerA: {
          name: "Rookie",
          elo: null,
          ratingSource: "default",
          matchesPlayed: null,
          rank: null,
          acesPerMatch: null,
          doubleFaultsPerMatch: null,
          bpFacedPerMatch: null,
          baselineSource: "none",
        },
      }),
    );
    const aces = noHistory.aces?.find((g) => g.scope === "Rookie");
    expect(aces?.expected).toBeCloseTo(8.4, 5);
    expect(aces?.basis).toBe("tour baseline");
    expect(noHistory.matchWinner.ratingSourceA).toBe("default");
    expect(noHistory.notes.some((n) => n.includes("priors"))).toBe(true);
  });

  it("skips the count markets entirely when there is no dataset", () => {
    const bare = predictTennisMatch(matchup({ tourBaselines: null }));
    expect(bare.aces).toBeNull();
    expect(bare.doubleFaults).toBeNull();
    expect(bare.breakPoints).toBeNull();
    expect(bare.markets.some((m) => m.family === "Aces")).toBe(false);
    expect(bare.notes.some((n) => n.includes("Serve baselines unavailable"))).toBe(true);
  });

  it("shifts the total-games ladder for best-of-5", () => {
    const bo5 = predictTennisMatch(matchup({ bestOf: 5 }));
    const bo5Lines = bo5.totalGames.lines.map((l) => l.line);
    const bo3Lines = prediction.totalGames.lines.map((l) => l.line);
    expect(Math.min(...bo5Lines)).toBeGreaterThan(Math.max(...bo3Lines));
    expect(bo5.totalGames.expected).toBeGreaterThan(bo5.bestOf === 5 ? 30 : 0);
    // Set betting in a best-of-5 match offers 3-x prices.
    expect(bo5.setWinner.setBetting.map((s) => s.score)).toEqual(
      expect.arrayContaining(["3-0", "3-1", "3-2", "0-3", "1-3", "2-3"]),
    );
  });

  it("uses the rank prior when the player has no replayed rating", () => {
    const prior = predictTennisMatch(
      matchup({
        playerB: {
          name: "Ranked Rookie",
          elo: null,
          ratingSource: "rank-prior",
          matchesPlayed: null,
          rank: 20,
          acesPerMatch: null,
          doubleFaultsPerMatch: null,
          bpFacedPerMatch: null,
          baselineSource: "none",
        },
      }),
    );
    // #20 maps to ~1870 raw; the surface-adjusted effective rating is exposed.
    expect(prior.matchWinner.ratingSourceB).toBe("rank-prior");
    expect(prior.matchWinner.effectiveEloB).toBeGreaterThan(1700);
  });
});
