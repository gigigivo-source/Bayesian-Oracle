// Integration tests for the StatsAggregator (Part 7.2).
//
// 1. Fallback chain: a SportScore source that times out must not crash the
//    walk — the aggregator falls through to API-Football.
// 2. Merge semantics: higher-priority sources win per field; a complete
//    API-Football payload breaks early.
// 3. Fail-soft: when every source returns nothing, fetch() returns null.

import { describe, expect, it } from "vitest";
import { StatsAggregator } from "./aggregator";
import type { SourceHandler } from "./sources/context";
import type { MatchStatsQuery } from "./types";

const MATCH: MatchStatsQuery = {
  leagueSlug: "eng.1",
  eventId: "espn:12345",
  homeTeam: "Manchester United",
  awayTeam: "Arsenal",
  date: "2026-08-21",
};

/** A SportScore handler that simulates a network timeout (throws). */
const timeoutSportScore: SourceHandler = {
  name: "SportScore",
  capabilities: ["goals", "shots", "corners"],
  available: () => true,
  fetch: async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError"; // what fetch throws on AbortController timeout
    throw err;
  },
};

const healthyApiFootball: SourceHandler = {
  name: "API-Football",
  capabilities: ["goals", "xg", "shots", "shotsOnTarget", "corners", "fouls", "possession", "saves"],
  available: () => true,
  fetch: async () => ({
    home: { goals: 2, xg: 1.8, shots: 14, shotsOnTarget: 6, corners: 7, fouls: 10, possession: 55, saves: 3 },
    away: { goals: 1, xg: 0.9, shots: 9, shotsOnTarget: 3, corners: 4, fouls: 12, possession: 45, saves: 5 },
  }),
};

const neverReturns: SourceHandler = {
  name: "StatsBomb",
  capabilities: [],
  available: () => true,
  fetch: async () => null,
};

describe("StatsAggregator fallback chain", () => {
  it("falls back to API-Football when SportScore times out", async () => {
    const agg = new StatsAggregator({
      handlers: {
        "SportScore": timeoutSportScore,
        "API-Football": healthyApiFootball,
        "StatsBomb": neverReturns,
      },
    });

    const stats = await agg.fetch(MATCH);
    expect(stats).not.toBeNull();
    expect(stats!.home.goals).toBe(2);
    expect(stats!.away.corners).toBe(4);
    expect(stats!.home.xg).toBe(1.8);
    // API-Football contributed the only fields → it is the primary source.
    expect(stats!.metadata.source).toBe("API-Football");
    expect(stats!.metadata.leagueSlug).toBe("eng.1");
    expect(stats!.metadata.matchDate).toBe("2026-08-21");
  });

  it("returns null when no source contributes anything", async () => {
    const agg = new StatsAggregator({ handlers: { "SportScore": neverReturns, "StatsBomb": neverReturns } });
    const stats = await agg.fetch(MATCH);
    expect(stats).toBeNull();
  });

  it("caches the result and returns it on the next call", async () => {
    let calls = 0;
    const countingSource: SourceHandler = {
      name: "API-Football",
      capabilities: ["goals"],
      available: () => true,
      fetch: async () => {
        calls++;
        return { home: { goals: 3 }, away: { goals: 0 } };
      },
    };
    const agg = new StatsAggregator({ handlers: { "API-Football": countingSource } });
    await agg.fetch(MATCH);
    await agg.fetch(MATCH);
    expect(calls).toBe(1);
  });

  it("breaks early when API-Football covers every per-match stat", async () => {
    // Fill every MATCH_STAT_FIELDS value for both teams + cleanSheet.
    const complete: Record<string, number> = {
      goals: 1, xg: 1, xgPerShot: 0.1, shots: 10, shotsOnTarget: 4, shotsOffTarget: 5,
      blockedShots: 1, corners: 6, goalKicks: 8, throwIns: 20, freeKicks: 12, penalties: 0,
      yellowCards: 2, redCards: 0, fouls: 10, offsides: 2, possession: 50, passes: 400,
      passAccuracy: 80, saves: 3, goalsConceded: 1, dribbling: 8, aerialBattlesWon: 12,
      interceptions: 9, tackles: 14, clearances: 20,
    };
    let statsBombCalled = false;
    const completeApiFootball: SourceHandler = {
      name: "API-Football",
      capabilities: Object.keys(complete) as SourceHandler["capabilities"],
      available: () => true,
      fetch: async () => ({
        home: { ...complete, cleanSheet: false },
        away: { ...complete, cleanSheet: false },
      }),
    };
    const statsBomb: SourceHandler = {
      name: "StatsBomb",
      capabilities: [],
      available: () => true,
      fetch: async () => { statsBombCalled = true; return { home: { goals: 9 }, away: { goals: 9 } }; },
    };
    const agg = new StatsAggregator({ handlers: { "API-Football": completeApiFootball, "StatsBomb": statsBomb } });
    await agg.fetch(MATCH);
    // StatsBomb sits below API-Football and must never be consulted.
    expect(statsBombCalled).toBe(false);
  });

  it("first-wins by priority: a higher-priority source cannot be overwritten", async () => {
    const high: SourceHandler = {
      name: "SportScore",
      capabilities: ["corners"],
      available: () => true,
      fetch: async () => ({ home: { corners: 12 }, away: { corners: 11 } }),
    };
    const low: SourceHandler = {
      name: "TheSportsDB",
      capabilities: ["corners", "goals"],
      available: () => true,
      fetch: async () => ({ home: { corners: 1, goals: 2 }, away: { corners: 1, goals: 1 } }),
    };
    const agg = new StatsAggregator({ handlers: { "SportScore": high, "TheSportsDB": low } });
    const stats = await agg.fetch(MATCH);
    // Corners come from the higher-priority SportScore; goals filled by TheSportsDB.
    expect(stats!.home.corners).toBe(12);
    expect(stats!.away.corners).toBe(11);
    expect(stats!.home.goals).toBe(2);
    expect(stats!.metadata.source).toBe("SportScore"); // 2 fields vs 4? SportScore=2 corners, TSDB=2 goals+... tie → priority wins
  });
});
