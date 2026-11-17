// Tests for the tennis market engine (T1–T6) in the market registry: the
// set/game probability model, the exact match distribution (total games, set
// betting, scorelines) and the full per-match market build.

import { describe, expect, it } from "vitest";
import {
  TENNIS_SET_CORRELATION,
  TENNIS_TOTAL_GAMES_SHIFT_ATP_BO3,
  TENNIS_TOTAL_GAMES_SHIFT_WTA_BO3,
  TENNIS_VALUE_MARKET_MIN_FAIR_ODDS,
  extractBestValueMarket,
  formatScoreline,
  gameWinProbFromSetProb,
  isTennisPlayableLock,
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

  it("computes eloGap and classifies PLATINUM, GOLD, SILVER, BRONZE, AVOID, and NONE tiers with sequential trap filters", () => {
    const base = matchup({ surface: "hard", date: "2026-07-12T12:00:00Z" });
    const mkPlayers = (
      gap: number,
      opts: {
        lastPlayedA?: string;
        acesB?: number;
        baselineB?: "surface" | "overall" | "tour-baseline";
      } = {},
    ) => ({
      playerA: {
        ...base.playerA,
        elo: 1600 + gap,
        matchesPlayed: 60,
        lastPlayed: opts.lastPlayedA ?? "2026-07-05T00:00:00Z",
        acesPerMatch: 7.5,
      },
      playerB: {
        ...base.playerB,
        elo: 1600,
        matchesPlayed: 40,
        lastPlayed: "2026-07-08T00:00:00Z",
        acesPerMatch: opts.acesB ?? 5.0,
        baselineSource: opts.baselineB ?? ("surface" as const),
      },
    });

    // Clean thresholds: <140 NONE, 140+ BRONZE, 180+ SILVER, 220+ GOLD, 280+ PLATINUM
    const none = predictTennisMatch(matchup({ surface: "hard", date: "2026-07-12T12:00:00Z", ...mkPlayers(139) }));
    expect(none.eloGap).toBe(139);
    expect(none.lockTier).toBe("NONE");
    expect(none.lockReasons).toEqual([]);

    const bronze = predictTennisMatch(matchup({ surface: "hard", date: "2026-07-12T12:00:00Z", ...mkPlayers(140) }));
    expect(bronze.lockTier).toBe("BRONZE_LOCK");

    const silver = predictTennisMatch(matchup({ surface: "hard", date: "2026-07-12T12:00:00Z", ...mkPlayers(180) }));
    expect(silver.lockTier).toBe("SILVER_LOCK");

    const gold = predictTennisMatch(matchup({ surface: "hard", date: "2026-07-12T12:00:00Z", ...mkPlayers(220) }));
    expect(gold.lockTier).toBe("GOLD_LOCK");

    const platinum = predictTennisMatch(matchup({ surface: "hard", date: "2026-07-12T12:00:00Z", ...mkPlayers(280) }));
    expect(platinum.lockTier).toBe("PLATINUM_LOCK");

    // Trap 1 (Grass): downgrades by 1 level; BRONZE stays BRONZE with warning
    const grassPlat = predictTennisMatch(matchup({ surface: "grass", date: "2026-07-12T12:00:00Z", ...mkPlayers(290) }));
    expect(grassPlat.lockTier).toBe("GOLD_LOCK");
    expect(grassPlat.lockReasons[0]).toMatch(/grass/i);

    const grassGold = predictTennisMatch(matchup({ surface: "grass", date: "2026-07-12T12:00:00Z", ...mkPlayers(230) }));
    expect(grassGold.lockTier).toBe("SILVER_LOCK");

    const grassBronze = predictTennisMatch(matchup({ surface: "grass", date: "2026-07-12T12:00:00Z", ...mkPlayers(150) }));
    expect(grassBronze.lockTier).toBe("BRONZE_LOCK");
    expect(grassBronze.lockReasons[0]).toMatch(/grass/i);

    // Trap 2 (Rusty 30+d): downgrades by 1 level (stacks sequentially with Grass)
    const rustyGold = predictTennisMatch(
      matchup({ surface: "hard", date: "2026-07-12T12:00:00Z", ...mkPlayers(240, { lastPlayedA: "2026-06-01T00:00:00Z" }) }),
    );
    expect(rustyGold.lockTier).toBe("SILVER_LOCK");
    expect(rustyGold.lockReasons[0]).toMatch(/layoff/i);

    const grassAndRustyPlat = predictTennisMatch(
      matchup({ surface: "grass", date: "2026-07-12T12:00:00Z", ...mkPlayers(300, { lastPlayedA: "2026-06-01T00:00:00Z" }) }),
    );
    expect(grassAndRustyPlat.lockTier).toBe("SILVER_LOCK");
    expect(grassAndRustyPlat.lockReasons).toHaveLength(2);

    // Trap 3 (Big Server underdog >= 8.5 aces/match): downgrades ANY tier to AVOID
    const bigServerAvoid = predictTennisMatch(
      matchup({ surface: "hard", date: "2026-07-12T12:00:00Z", ...mkPlayers(300, { acesB: 8.5, baselineB: "surface" }) }),
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

  it("extracts bestValueMarket for every playable Lock tier and omits it for NONE and AVOID", () => {
    const base = matchup({ surface: "hard", date: "2026-07-12T12:00:00Z" });
    const buildWithGap = (gap: number, opts: { acesB?: number; bestOf?: 3 | 5; swapFav?: boolean } = {}) => {
      const fav = {
        ...base.playerA,
        name: "Carlos Alcaraz",
        elo: 1500 + gap,
        lastPlayed: "2026-07-08T00:00:00Z",
        acesPerMatch: 7.0,
        baselineSource: "surface" as const,
      };
      const dog = {
        ...base.playerB,
        name: "Qualifier",
        elo: 1500,
        lastPlayed: "2026-07-08T00:00:00Z",
        acesPerMatch: opts.acesB ?? 4.5,
        baselineSource: "surface" as const,
      };
      return predictTennisMatch(
        matchup({
          surface: "hard",
          date: "2026-07-12T12:00:00Z",
          bestOf: opts.bestOf ?? 3,
          playerA: opts.swapFav ? dog : fav,
          playerB: opts.swapFav ? fav : dog,
        }),
      );
    };

    // NONE (gap < 140) and AVOID (big-server underdog) never receive bestValueMarket.
    const nonLock = buildWithGap(120);
    expect(nonLock.lockTier).toBe("NONE");
    expect(nonLock.bestValueMarket).toBeUndefined();

    const avoid = buildWithGap(300, { acesB: 9.2 });
    expect(avoid.lockTier).toBe("AVOID");
    expect(avoid.bestValueMarket).toBeUndefined();

    // Every playable Lock tier (BRONZE → PLATINUM) gets a Value Market with fairOdds >= 1.25
    // and strictly higher odds than the favorite's Match Winner price.
    for (const gap of [140, 180, 220, 280, 360, 480]) {
      const pred = buildWithGap(gap);
      expect(isTennisPlayableLock(pred.lockTier)).toBe(true);
      expect(pred.bestValueMarket).toBeDefined();
      const bvm = pred.bestValueMarket!;
      expect(["Set Betting", "Total Games"]).toContain(bvm.market);
      expect(bvm.probability).toBeGreaterThan(0.5);
      expect(bvm.fairOdds).toBeGreaterThanOrEqual(TENNIS_VALUE_MARKET_MIN_FAIR_ODDS);
      expect(bvm.fairOdds).toBeGreaterThan(pred.matchWinner.fairOddsA);
      expect(bvm.fairOdds).toBeCloseTo(1 / bvm.probability, 1);
      expect(pred.notes.some((n) => n.includes("Value market:"))).toBe(true);
    }

    // Moderate Platinum Lock (gap 280 Bo3): Total Games Under has higher probability than 2-0.
    const plat280 = buildWithGap(280);
    expect(plat280.bestValueMarket?.market).toBe("Total Games");
    expect(plat280.bestValueMarket?.selection).toMatch(/^Under \d+\.5$/);

    // Heavy Platinum Lock (gap 400 Bo3): calibrated Set Betting 2-0 wins (~78.8%, @1.27).
    const plat400 = buildWithGap(400);
    expect(plat400.bestValueMarket?.market).toBe("Set Betting");
    expect(plat400.bestValueMarket?.selection).toBe("Carlos Alcaraz 2-0");
    expect(plat400.bestValueMarket?.probability).toBeCloseTo(0.788, 2);
    expect(plat400.bestValueMarket?.fairOdds).toBeCloseTo(1.27, 2);

    // When Player B is the favorite, Set Betting selection still names the favorite winner-first ("2-0").
    const plat400B = buildWithGap(400, { swapFav: true });
    expect(plat400B.bestValueMarket?.market).toBe("Set Betting");
    expect(plat400B.bestValueMarket?.selection).toBe("Carlos Alcaraz 2-0");
    expect(plat400B.bestValueMarket?.probability).toBeCloseTo(plat400.bestValueMarket!.probability, 4);

    // Extreme mismatch (gap 700 Bo3): 2-0 dips below 1.25 fair odds, so Total Games Under >= 1.25 is chosen.
    const extreme = buildWithGap(700);
    expect(extreme.bestValueMarket?.market).toBe("Total Games");
    expect(extreme.bestValueMarket?.selection).toMatch(/^Under \d+\.5$/);
    expect(extreme.bestValueMarket?.fairOdds).toBeGreaterThanOrEqual(TENNIS_VALUE_MARKET_MIN_FAIR_ODDS);

    // Best-of-5 Gold Lock picks Total Games Under (never Over) clearing the 1.25 floor.
    const bo5Gold = buildWithGap(260, { bestOf: 5 });
    expect(bo5Gold.bestValueMarket?.market).toBe("Total Games");
    expect(bo5Gold.bestValueMarket?.selection).toMatch(/^Under \d+\.5$/);
    expect(bo5Gold.bestValueMarket?.fairOdds).toBeGreaterThanOrEqual(TENNIS_VALUE_MARKET_MIN_FAIR_ODDS);
  });

  it("extractBestValueMarket falls back to highest probability if no candidate clears minFairOdds", () => {
    const picked = extractBestValueMarket({
      lockTier: "PLATINUM_LOCK",
      favorite: "Novak Djokovic",
      favoriteIsA: true,
      setBetting: [{ setsA: 2, setsB: 0, prob: 0.88 }],
      totalLines: [{ line: 17.5, overProb: 0.15, underProb: 0.85 }],
      minFairOdds: 1.25,
    });
    expect(picked).toEqual({
      market: "Set Betting",
      selection: "Novak Djokovic 2-0",
      probability: 0.88,
      fairOdds: 1.14,
    });
  });

  it("Fix 1: extractBestValueMarket disables Total Games Over even when Over probability dominates", () => {
    const picked = extractBestValueMarket({
      lockTier: "SILVER_LOCK",
      favorite: "Player A",
      favoriteIsA: true,
      setBetting: [{ setsA: 2, setsB: 0, prob: 0.62 }],
      totalLines: [
        { line: 35.5, overProb: 0.72, underProb: 0.28 },
        { line: 38.5, overProb: 0.42, underProb: 0.58 },
      ],
    });
    expect(picked).toEqual({
      market: "Total Games",
      selection: "Under 38.5",
      probability: 0.58,
      fairOdds: 1.72,
    });
  });

  it("Fix 2: correlated set model preserves match probability and raises straight-set probabilities to empirical levels", () => {
    for (const bestOf of [3, 5] as const) {
      const targetMatchProb = 0.78;
      const iidSet = setWinProbFromMatchProb(targetMatchProb, bestOf, 0);
      const corrSet = setWinProbFromMatchProb(targetMatchProb, bestOf, TENNIS_SET_CORRELATION);

      const iidDist = matchSetDistribution(iidSet, bestOf, { setCorrelation: 0 });
      const corrDist = matchSetDistribution(corrSet, bestOf, { setCorrelation: TENNIS_SET_CORRELATION });

      // Match Winner probability and probability conservation remain exact.
      expect(corrDist.matchProbA).toBeCloseTo(targetMatchProb, 4);
      expect(corrDist.setBetting.reduce((s, e) => s + e.prob, 0)).toBeCloseTo(1, 6);
      expect(corrDist.totalGames.reduce((s, e) => s + e.prob, 0)).toBeCloseTo(1, 6);

      const setsToWin = bestOf === 5 ? 3 : 2;
      const iidStraight = iidDist.setBetting.find((e) => e.setsA === setsToWin && e.setsB === 0)?.prob ?? 0;
      const corrStraight = corrDist.setBetting.find((e) => e.setsA === setsToWin && e.setsB === 0)?.prob ?? 0;

      // Correlated straight-set probability matches empirical Lock rates (~59% Bo3, ~48% at 78% Bo5 vs ~29% i.i.d.).
      expect(corrStraight).toBeGreaterThan(iidStraight + 0.08);
      if (bestOf === 3) expect(corrStraight).toBeCloseTo(0.594, 2);
      else expect(corrStraight).toBeCloseTo(0.478, 2);
    }

    // Exact 50/50 symmetry preserved under positive set correlation.
    const sym = matchSetDistribution(0.5, 3, { setCorrelation: TENNIS_SET_CORRELATION });
    expect(sym.matchProbA).toBeCloseTo(0.5, 6);
    const p20 = sym.setBetting.find((e) => e.setsA === 2 && e.setsB === 0)?.prob ?? 0;
    const p02 = sym.setBetting.find((e) => e.setsA === 0 && e.setsB === 2)?.prob ?? 0;
    expect(p20).toBeCloseTo(p02, 6);
  });

  it("Fix 3: WTA Bo3 total games baseline sits ~2.0 games below ATP and centers WTA Locks around 20.5–21.5", () => {
    expect(TENNIS_TOTAL_GAMES_SHIFT_ATP_BO3 - TENNIS_TOTAL_GAMES_SHIFT_WTA_BO3).toBeCloseTo(2.0, 6);

    const commonPlayers = {
      surface: "hard" as const,
      date: "2026-07-12T12:00:00Z",
      bestOf: 3 as const,
      playerA: {
        ...matchup().playerA,
        elo: 1700,
        lastPlayed: "2026-07-08T00:00:00Z",
        acesPerMatch: 6.0,
      },
      playerB: {
        ...matchup().playerB,
        elo: 1500,
        lastPlayed: "2026-07-08T00:00:00Z",
        acesPerMatch: 4.0,
      },
    };
    const atp = predictTennisMatch(matchup({ tour: "atp", ...commonPlayers }));
    const wta = predictTennisMatch(matchup({ tour: "wta", ...commonPlayers }));

    expect(atp.totalGames.expected - wta.totalGames.expected).toBeCloseTo(2.0, 1);
    const wtaCenterLine = wta.totalGames.lines[1]?.line;
    expect(wtaCenterLine).toBeGreaterThanOrEqual(20.5);
    expect(wtaCenterLine).toBeLessThanOrEqual(21.5);
  });

  it("Fix 4: extractBestValueMarket restricts Set Betting strictly to PLATINUM_LOCK and GOLD_LOCK", () => {
    const shared = {
      favorite: "Player A",
      favoriteIsA: true,
      setBetting: [{ setsA: 2, setsB: 0, prob: 0.76 }],
      totalLines: [{ line: 22.5, overProb: 0.36, underProb: 0.64 }],
    };

    expect(extractBestValueMarket({ lockTier: "PLATINUM_LOCK", ...shared })?.market).toBe("Set Betting");
    expect(extractBestValueMarket({ lockTier: "GOLD_LOCK", ...shared })?.market).toBe("Set Betting");
    expect(extractBestValueMarket({ lockTier: "SILVER_LOCK", ...shared })).toEqual({
      market: "Total Games",
      selection: "Under 22.5",
      probability: 0.64,
      fairOdds: 1.56,
    });
    expect(extractBestValueMarket({ lockTier: "BRONZE_LOCK", ...shared })).toEqual({
      market: "Total Games",
      selection: "Under 22.5",
      probability: 0.64,
      fairOdds: 1.56,
    });
  });
});
