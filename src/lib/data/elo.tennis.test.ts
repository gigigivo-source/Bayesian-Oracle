// Tests for the tennis ELO section of the rating system: the surface modifier
// (clay 1.1×, grass 1.3×, hard 1.0×), the per-tour replay and the rank prior.

import { describe, expect, it } from "vitest";
import {
  TENNIS_INITIAL_ELO,
  TENNIS_SURFACE_ELO_MODIFIERS,
  applyTennisMatchToElo,
  buildTennisEloTable,
  createTennisEloTable,
  expectedScoreTennis,
  findTennisEloEntry,
  surfaceAdjustedElo,
  surfaceEloModifier,
  tennisEloPriorFromRank,
  tennisKFactor,
} from "./elo";
import type { TennisMatch } from "./sources/tennis";

function match(overrides: Partial<TennisMatch> = {}): TennisMatch {
  return {
    id: "t|atp|2026-01-01|a|b",
    tour: "atp",
    tournament: "Test Open",
    surface: "hard",
    matchDate: "2026-01-01T00:00:00Z",
    round: "F",
    bestOf: 3,
    winner: "Player A",
    loser: "Player B",
    score: "6-4 6-4",
    finish: "completed",
    winnerStats: { aces: null, doubleFaults: null, servePoints: null, serviceGames: null, bpSaved: null, bpFaced: null },
    loserStats: { aces: null, doubleFaults: null, servePoints: null, serviceGames: null, bpSaved: null, bpFaced: null },
    odds: null,
    winnerRank: null,
    loserRank: null,
    source: "sackmann",
    ...overrides,
  };
}

describe("surface modifiers", () => {
  it("implements the specified multipliers", () => {
    expect(TENNIS_SURFACE_ELO_MODIFIERS).toEqual({ clay: 1.1, grass: 1.3, hard: 1.0, carpet: 1.0 });
    expect(surfaceEloModifier("clay")).toBe(1.1);
    expect(surfaceEloModifier("grass")).toBe(1.3);
    expect(surfaceEloModifier("hard")).toBe(1.0);
    expect(surfaceEloModifier(null)).toBe(1.0);
    expect(surfaceEloModifier(undefined)).toBe(1.0);
  });

  it("scales the rating gap around the 1500 baseline", () => {
    expect(surfaceAdjustedElo(1500, "grass")).toBe(1500);
    expect(surfaceAdjustedElo(1700, "grass")).toBeCloseTo(1760, 6); // +200 × 1.3
    expect(surfaceAdjustedElo(1700, "clay")).toBeCloseTo(1720, 6); // +200 × 1.1
    expect(surfaceAdjustedElo(1700, "hard")).toBe(1700);
    expect(surfaceAdjustedElo(1400, "grass")).toBeCloseTo(1370, 6); // −100 × 1.3
  });

  it("widens the favourite's edge on grass, narrows it on hard", () => {
    const hard = expectedScoreTennis(1600, 1500, "hard");
    const clay = expectedScoreTennis(1600, 1500, "clay");
    const grass = expectedScoreTennis(1600, 1500, "grass");
    expect(grass).toBeGreaterThan(clay);
    expect(clay).toBeGreaterThan(hard);
    expect(hard).toBeCloseTo(0.64, 2); // 100-point gap on the ELO scale
  });

  it("keeps the expectation symmetric", () => {
    for (const surface of ["clay", "grass", "hard", null] as const) {
      const a = expectedScoreTennis(1720, 1580, surface);
      const b = expectedScoreTennis(1580, 1720, surface);
      expect(a + b).toBeCloseTo(1, 10);
    }
  });
});

describe("tennisKFactor", () => {
  it("weights best-of-5 higher and boosts new players", () => {
    expect(tennisKFactor(3, 50)).toBe(32);
    expect(tennisKFactor(5, 50)).toBe(45);
    expect(tennisKFactor(3, 5)).toBe(48); // 32 × 1.5
    expect(tennisKFactor(5, 0)).toBeCloseTo(67.5, 6); // 45 × 1.5
  });
});

describe("buildTennisEloTable", () => {
  it("moves the winner up and the loser down by the same amount", () => {
    const table = buildTennisEloTable([match()]);
    const a = table.players.get("atp|player a");
    const b = table.players.get("atp|player b");
    expect(a && b).toBeDefined();
    expect(a?.rating ?? 0).toBeGreaterThan(TENNIS_INITIAL_ELO);
    expect(b?.rating ?? 0).toBeLessThan(TENNIS_INITIAL_ELO);
    expect((a?.rating ?? 0) + (b?.rating ?? 0)).toBeCloseTo(2 * TENNIS_INITIAL_ELO, 6);
    expect(table.matchesProcessed).toBe(1);
    expect(table.asOf).toBe("2026-01-01T00:00:00Z");
  });

  it("skips walkovers (no on-court result to learn from)", () => {
    const table = buildTennisEloTable([match({ finish: "walkover", score: "W/O" })]);
    expect(table.matchesProcessed).toBe(0);
    expect(table.players.size).toBe(0);
  });

  it("keeps ATP and WTA pools separate", () => {
    const table = buildTennisEloTable([
      match({ tour: "atp" }),
      match({ tour: "wta", winner: "Player W", loser: "Player X" }),
    ]);
    expect(table.players.size).toBe(4);
    expect(table.players.get("wta|player w")).toBeDefined();
    expect(table.players.get("atp|player a")).toBeDefined();
  });

  it("counts surface matches per player", () => {
    const table = buildTennisEloTable([
      match({ surface: "clay", matchDate: "2026-04-01T00:00:00Z" }),
      match({ surface: "clay", matchDate: "2026-04-02T00:00:00Z" }),
      match({ surface: "grass", matchDate: "2026-06-01T00:00:00Z", winner: "Player B", loser: "Player A" }),
    ]);
    const a = table.players.get("atp|player a");
    expect(a?.surfaceMatches.clay).toBe(2);
    expect(a?.surfaceMatches.grass).toBe(1);
    expect(a?.wins).toBe(2);
    expect(a?.matchesPlayed).toBe(3);
  });

  it("replays chronologically regardless of input order", () => {
    const table = buildTennisEloTable([
      match({ matchDate: "2026-06-02T00:00:00Z", winner: "Player B", loser: "Player A" }),
      match({ matchDate: "2026-06-01T00:00:00Z" }),
    ]);
    // Same net effect as a two-match sequence starting from 1500.
    const manual = createTennisEloTable();
    applyTennisMatchToElo(manual, match({ matchDate: "2026-06-01T00:00:00Z" }));
    applyTennisMatchToElo(
      manual,
      match({ matchDate: "2026-06-02T00:00:00Z", winner: "Player B", loser: "Player A" }),
    );
    expect(table.players.get("atp|player a")?.rating ?? 0).toBe(
      manual.players.get("atp|player a")?.rating ?? -1,
    );
  });
});

describe("findTennisEloEntry", () => {
  const table = buildTennisEloTable([
    match({ winner: "Frances Tiafoe", loser: "Alexander Zverev" }),
    match({ matchDate: "2026-02-01T00:00:00Z", winner: "M. Zverev", loser: "Frances Tiafoe" }),
  ]);

  it("resolves exact keys", () => {
    expect(findTennisEloEntry(table, "Frances Tiafoe", "atp")?.player).toBe("Frances Tiafoe");
  });

  it("resolves provider spellings fuzzily without colliding surnames", () => {
    expect(findTennisEloEntry(table, "F. Tiafoe", "atp")?.player).toBe("Frances Tiafoe");
    // "A. Zverev" must NOT resolve into Mischa Zverev's entry.
    expect(findTennisEloEntry(table, "A. Zverev", "atp")?.player).toBe("Alexander Zverev");
  });

  it("returns null for unknown players and wrong tours", () => {
    expect(findTennisEloEntry(table, "Nobody", "atp")).toBeNull();
    expect(findTennisEloEntry(table, "Frances Tiafoe", "wta")).toBeNull();
  });
});

describe("tennisEloPriorFromRank", () => {
  it("maps ranks onto the rating scale monotonically", () => {
    const rank1 = tennisEloPriorFromRank(1);
    const rank10 = tennisEloPriorFromRank(10);
    const rank100 = tennisEloPriorFromRank(100);
    const rank500 = tennisEloPriorFromRank(500);
    expect(rank1).toBe(2100);
    expect(rank10 ?? 0).toBeGreaterThan(rank100 ?? 0);
    expect(rank100 ?? 0).toBeGreaterThan(rank500 ?? 0);
    expect(tennisEloPriorFromRank(1_000_000)).toBeGreaterThanOrEqual(1400);
    expect(rank1 ?? 0).toBeGreaterThan(1900);
  });

  it("returns null without a usable rank", () => {
    expect(tennisEloPriorFromRank(null)).toBeNull();
    expect(tennisEloPriorFromRank(0)).toBeNull();
    expect(tennisEloPriorFromRank(Number.NaN)).toBeNull();
  });
});
