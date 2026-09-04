// Tests for the tennis ELO section of the rating system: one rating per surface
// (elo_clay / elo_grass / elo_hard), updated only from matches on that surface,
// K = 32 ATP / 45 WTA with a new-player boost, and the null contract — a player
// with no replayed match on a surface has no rating there, not 1500.

import { describe, expect, it, vi } from "vitest";
import {
  TENNIS_INITIAL_ELO,
  TENNIS_K_FACTORS,
  TENNIS_SURFACE_ELO_MODIFIERS,
  applyTennisMatchToElo,
  buildTennisEloTable,
  createTennisEloTable,
  expectedScoreTennis,
  findTennisEloEntry,
  getTennisElo,
  logTennisEloMatchup,
  surfaceAdjustedElo,
  surfaceEloModifier,
  tennisKFactor,
} from "./elo";
import type { TennisMatch, TennisSurface } from "./sources/tennis";

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
    winnerStats: {
      aces: null,
      doubleFaults: null,
      servePoints: null,
      servePointsWon: null,
      serviceGames: null,
      bpSaved: null,
      bpFaced: null,
    },
    loserStats: {
      aces: null,
      doubleFaults: null,
      servePoints: null,
      servePointsWon: null,
      serviceGames: null,
      bpSaved: null,
      bpFaced: null,
    },
    odds: null,
    winnerRank: null,
    loserRank: null,
    source: "sackmann",
    ...overrides,
  };
}

describe("surface multipliers", () => {
  it("implements the specified multipliers", () => {
    expect(TENNIS_SURFACE_ELO_MODIFIERS).toEqual({ clay: 1.1, grass: 1.3, hard: 1.0 });
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
  it("uses 32 on the ATP tour and 45 on the WTA tour", () => {
    expect(TENNIS_K_FACTORS).toEqual({ atp: 32, wta: 45 });
    expect(tennisKFactor("atp", 50)).toBe(32);
    expect(tennisKFactor("wta", 50)).toBe(45);
  });

  it("boosts a player's first 10 rated matches on the surface", () => {
    expect(tennisKFactor("atp", 0)).toBeCloseTo(48, 6); // 32 × 1.5
    expect(tennisKFactor("atp", 9)).toBeCloseTo(48, 6);
    expect(tennisKFactor("atp", 10)).toBe(32);
    expect(tennisKFactor("wta", 0)).toBeCloseTo(67.5, 6); // 45 × 1.5
    expect(tennisKFactor("wta", 30)).toBe(45);
  });
});

describe("buildTennisEloTable", () => {
  it("moves the winner up and the loser down by the same amount", () => {
    const table = buildTennisEloTable([match()]);
    const a = table.players.get("atp|player a");
    const b = table.players.get("atp|player b");
    expect(a?.ratings.hard ?? 0).toBeGreaterThan(TENNIS_INITIAL_ELO);
    expect(b?.ratings.hard ?? 0).toBeLessThan(TENNIS_INITIAL_ELO);
    expect((a?.ratings.hard ?? 0) + (b?.ratings.hard ?? 0)).toBeCloseTo(2 * TENNIS_INITIAL_ELO, 6);
    expect(table.matchesProcessed).toBe(1);
    expect(table.asOf).toBe("2026-01-01T00:00:00Z");
  });

  it("skips walkovers (no on-court result to learn from)", () => {
    const table = buildTennisEloTable([match({ finish: "walkover", score: "W/O" })]);
    expect(table.matchesProcessed).toBe(0);
    expect(table.players.size).toBe(0);
  });

  it("skips matches with no recorded surface instead of guessing one", () => {
    const table = buildTennisEloTable([match({ surface: null })]);
    expect(table.matchesProcessed).toBe(0);
    expect(table.skippedNoSurface).toBe(1);
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

  it("only touches the rating of the surface the match was played on", () => {
    const table = buildTennisEloTable([
      match({ surface: "clay", matchDate: "2026-04-01T00:00:00Z" }),
      match({ surface: "grass", matchDate: "2026-06-01T00:00:00Z" }),
    ]);
    const a = table.players.get("atp|player a");
    const b = table.players.get("atp|player b");
    // Clay and grass each saw one match; hard saw none → stays null.
    expect(a?.surfaceMatches.clay).toBe(1);
    expect(a?.surfaceMatches.grass).toBe(1);
    expect(a?.surfaceMatches.hard).toBe(0);
    expect(a?.ratings.hard).toBeNull();
    expect(b?.ratings.hard).toBeNull();
    // The grass update is seeded from the player's own clay rating, so its gap
    // compounds on top of the clay one instead of restarting from 1500.
    expect((a?.ratings.grass ?? 0) - (b?.ratings.grass ?? 0)).toBeGreaterThan(
      (a?.ratings.clay ?? 0) - (b?.ratings.clay ?? 0),
    );
  });

  it("rates surfaces independently (a clay win does not lift the grass rating)", () => {
    const table = buildTennisEloTable([
      match({ surface: "clay", matchDate: "2026-04-01T00:00:00Z", winner: "Clay Bull", loser: "Clay Bear" }),
      match({
        surface: "grass",
        matchDate: "2026-06-01T00:00:00Z",
        winner: "Clay Bear",
        loser: "Grass Bull",
      }),
    ]);
    const bull = table.players.get("atp|clay bull");
    const bear = table.players.get("atp|clay bear");
    expect(bull?.ratings.clay ?? 0).toBeGreaterThan(TENNIS_INITIAL_ELO);
    expect(bull?.ratings.grass ?? 0).toBeLessThan(TENNIS_INITIAL_ELO);
    // The bear lost on clay and won on grass — the two ratings move apart.
    expect(bear?.ratings.clay ?? 0).toBeLessThan(bear?.ratings.grass ?? 0);
  });

  it("seeds a debut surface from the player's own ratings on other surfaces", () => {
    const table = buildTennisEloTable([
      match({ surface: "hard", matchDate: "2026-01-01T00:00:00Z", winner: "Strong Player", loser: "Weak Player" }),
      match({
        surface: "hard",
        matchDate: "2026-01-02T00:00:00Z",
        winner: "Strong Player",
        loser: "Weak Player",
      }),
      match({
        surface: "clay",
        matchDate: "2026-04-01T00:00:00Z",
        winner: "Strong Player",
        loser: "Fresh Player",
      }),
    ]);
    const strong = table.players.get("atp|strong player");
    // First clay match: seeded from the (well-earned) hard rating, not from 1500.
    expect(strong?.ratings.clay ?? 0).toBeGreaterThan(TENNIS_INITIAL_ELO + 20);
    expect(table.matchesProcessed).toBe(3);
  });

  it("replays chronologically regardless of input order", () => {
    const table = buildTennisEloTable([
      match({ matchDate: "2026-06-02T00:00:00Z", winner: "Player B", loser: "Player A" }),
      match({ matchDate: "2026-06-01T00:00:00Z" }),
    ]);
    const manual = createTennisEloTable();
    applyTennisMatchToElo(manual, match({ matchDate: "2026-06-01T00:00:00Z" }));
    applyTennisMatchToElo(
      manual,
      match({ matchDate: "2026-06-02T00:00:00Z", winner: "Player B", loser: "Player A" }),
    );
    expect(table.players.get("atp|player a")?.ratings.hard ?? 0).toBe(
      manual.players.get("atp|player a")?.ratings.hard ?? -1,
    );
  });
});

describe("getTennisElo (getElo(playerName, surface))", () => {
  const table = buildTennisEloTable([
    match({ surface: "hard", winner: "Frances Tiafoe", loser: "Alexander Zverev" }),
    match({
      surface: "clay",
      matchDate: "2026-02-01T00:00:00Z",
      winner: "M. Zverev",
      loser: "Frances Tiafoe",
    }),
  ]);

  it("resolves the surface rating of a known player", () => {
    const hard = getTennisElo(table, "Frances Tiafoe", "hard", "atp");
    expect(hard).not.toBeNull();
    expect(hard ?? 0).toBeGreaterThan(TENNIS_INITIAL_ELO);
  });

  it("returns null on a surface the player has never played", () => {
    // Tiafoe has a clay match but no grass match in this table.
    expect(getTennisElo(table, "Frances Tiafoe", "grass", "atp")).toBeNull();
    expect(getTennisElo(table, "Alexander Zverev", "clay", "atp")).toBeNull();
  });

  it("returns null for unknown players and wrong tours", () => {
    expect(getTennisElo(table, "Nobody", "hard", "atp")).toBeNull();
    expect(getTennisElo(table, "Frances Tiafoe", "hard", "wta")).toBeNull();
  });

  it("resolves provider spellings fuzzily (ESPN ↔ dataset)", () => {
    expect(getTennisElo(table, "F. Tiafoe", "hard", "atp")).not.toBeNull();
    expect(getTennisElo(table, "A. Zverev", "hard", "atp")).not.toBeNull();
  });

  it("never returns the 1500 default: null means 'no data'", () => {
    const surfaces: TennisSurface[] = ["clay", "grass", "hard"];
    for (const surface of surfaces) {
      const elo = getTennisElo(table, "Unknown Player", surface, "atp");
      expect(elo).toBeNull();
    }
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

describe("logTennisEloMatchup", () => {
  it("logs the surface and both ratings in the spec's format", () => {
    const lines: string[] = [];
    logTennisEloMatchup("clay", "Iga Swiatek", 1650.4, "Elise Mertens", 1520.2, (m) => lines.push(m));
    expect(lines).toEqual([
      "[elo] Surface: clay, players: Iga Swiatek (1650) vs Elise Mertens (1520)",
    ]);
  });

  it("logs null ratings literally instead of substituting a default", () => {
    const logger = vi.fn();
    logTennisEloMatchup("grass", "A Player", null, "B Player", 1600, logger);
    expect(logger).toHaveBeenCalledWith(
      "[elo] Surface: grass, players: A Player (null) vs B Player (1600)",
    );
  });
});
