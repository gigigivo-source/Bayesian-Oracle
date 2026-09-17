// Integration tests for the StatsAggregator (Part 7.2).
//
// 1. Fallback chain: a SportScore source that times out must not crash the
//    walk — the aggregator falls through to API-Football.
// 2. Merge semantics: higher-priority sources win per field; a complete
//    API-Football payload breaks early.
// 3. Fail-soft: when every source returns nothing, fetch() returns null.

import { afterEach, describe, expect, it, vi } from "vitest";
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

// ─── Failure attribution ─────────────────────────────────────────────────────
//
// "no data" and "egress blocked" both surface downstream as a synthetic
// baseline. These tests pin the trace's ability to tell them apart: every
// attempt must carry a machine-readable `reason` and a human `detail` naming
// the actual cause (blocked host, timeout, 404, missing key, wrong league).

/** Build a stub `fetch` that resolves to the given HTTP status + JSON body. */
function stubFetch(impl: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => impl(String(input))));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A handler that reaches the network once, then normalises nothing. */
const fetchingSource = (name: SourceHandler["name"]): SourceHandler => ({
  name,
  capabilities: ["goals", "corners"],
  available: () => true,
  fetch: async (_m, ctx) => {
    await ctx.http("https://example.invalid/api/match/1");
    return null; // reached the wire, got nothing usable
  },
});

describe("StatsAggregator failure attribution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attributes a blocked host to network-error, not a generic empty payload", async () => {
    stubFetch(() => Promise.reject(new Error("fetch failed")));
    const agg = new StatsAggregator({ handlers: { SportScore: fetchingSource("SportScore") } });

    const { attempts } = await agg.fetchWithTrace(MATCH);
    const attempt = attempts.find((a) => a.source === "SportScore")!;

    expect(attempt.reason).toBe("network-error");
    expect(attempt.detail).toMatch(/egress blocked/);
    expect(attempt.http).toHaveLength(1);
    expect(attempt.http![0].status).toBe("network-error");
    expect(attempt.http![0].url).toBe("https://example.invalid/api/match/1");
  });

  it("attributes a hung host to timeout", async () => {
    stubFetch(() => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    const agg = new StatsAggregator({ handlers: { SportScore: fetchingSource("SportScore") } });

    const attempt = (await agg.fetchWithTrace(MATCH)).attempts.find((a) => a.source === "SportScore")!;
    expect(attempt.reason).toBe("timeout");
    expect(attempt.detail).toMatch(/^timeout/);
  });

  it("attributes a 404 to an HTTP error, distinct from an unreachable host", async () => {
    stubFetch(() => json(404, { error: "not found" }));
    const agg = new StatsAggregator({ handlers: { SportScore: fetchingSource("SportScore") } });

    const attempt = (await agg.fetchWithTrace(MATCH)).attempts.find((a) => a.source === "SportScore")!;
    expect(attempt.reason).toBe("http-error");
    expect(attempt.detail).toMatch(/404/);
    expect(attempt.http![0].httpStatus).toBe(404);
  });

  it("marks a source that responded fine but normalised nothing as empty-payload", async () => {
    stubFetch(() => json(200, { statistics: [] }));
    const agg = new StatsAggregator({ handlers: { SportScore: fetchingSource("SportScore") } });

    const attempt = (await agg.fetchWithTrace(MATCH)).attempts.find((a) => a.source === "SportScore")!;
    expect(attempt.reason).toBe("empty-payload");
    expect(attempt.detail).toMatch(/normaliser found no usable fields/);
  });

  it("marks a handler that bails before the network as no-requests", async () => {
    const agg = new StatsAggregator({ handlers: { FBref: neverReturns } });

    const attempt = (await agg.fetchWithTrace(MATCH)).attempts.find((a) => a.source === "FBref")!;
    expect(attempt.reason).toBe("no-requests");
    expect(attempt.http).toEqual([]);
  });

  it("names the unset env var when a keyed source is gated off", async () => {
    delete process.env.API_FOOTBALL_KEY;
    delete process.env.FOOTBALL_API_KEY;

    const keyed: SourceHandler = {
      name: "API-Football",
      capabilities: ["goals"],
      available: (_m, ctx) =>
        ctx.env("API_FOOTBALL_KEY").length > 0 || ctx.env("FOOTBALL_API_KEY").length > 0,
      fetch: async () => ({ home: { goals: 1 }, away: { goals: 1 } }),
    };
    const agg = new StatsAggregator({ handlers: { "API-Football": keyed } });

    const attempt = (await agg.fetchWithTrace(MATCH)).attempts.find((a) => a.source === "API-Football")!;
    expect(attempt.status).toBe("unavailable");
    expect(attempt.reason).toBe("key-missing");
    expect(attempt.detail).toMatch(/API_FOOTBALL_KEY/);
  });

  it("reports a league-scoped source as not-applicable rather than key-missing", async () => {
    const germanOnly: SourceHandler = {
      name: "OpenLigaDB",
      capabilities: ["corners"],
      available: (m) => /^ger\./.test(m.leagueSlug),
      fetch: async () => ({ home: { corners: 5 }, away: { corners: 4 } }),
    };
    const agg = new StatsAggregator({ handlers: { OpenLigaDB: germanOnly } });

    const attempt = (await agg.fetchWithTrace(MATCH)).attempts.find((a) => a.source === "OpenLigaDB")!;
    expect(attempt.reason).toBe("not-applicable");
    expect(attempt.detail).toMatch(/not applicable to eng\.1/);
  });

  it("logs one line per source attempt plus the walk header", async () => {
    stubFetch(() => json(200, { statistics: [] }));
    delete process.env.API_FOOTBALL_KEY;
    delete process.env.FOOTBALL_API_KEY;

    const keyed: SourceHandler = {
      name: "API-Football",
      capabilities: ["goals"],
      available: (_m, ctx) => ctx.env("API_FOOTBALL_KEY").length > 0,
      fetch: async () => ({ home: { goals: 1 }, away: { goals: 1 } }),
    };
    const lines: string[] = [];
    const agg = new StatsAggregator({
      handlers: {
        SportScore: fetchingSource("SportScore"),
        "API-Football": keyed,
        StatsBomb: fetchingSource("StatsBomb"),
      },
      log: (m) => lines.push(m),
    });

    await agg.fetchWithTrace(MATCH);

    expect(lines.some((l) => l.includes("— walk ") && l.includes("SportScore → API-Football"))).toBe(true);
    expect(lines.some((l) => l.includes(" SportScore → FAIL"))).toBe(true);
    expect(lines.some((l) => l.includes(" API-Football → SKIP key missing"))).toBe(true);
    expect(lines.some((l) => l.includes("SYNTHETIC BASELINE"))).toBe(true);
  });

  it("reports the dominant cause as blocked egress when nothing can reach its host", async () => {
    stubFetch(() => Promise.reject(new Error("fetch failed")));
    const lines: string[] = [];
    const agg = new StatsAggregator({
      handlers: { SportScore: fetchingSource("SportScore") },
      log: (m) => lines.push(m),
    });

    await agg.fetchWithTrace(MATCH);

    expect(lines.some((l) => l.includes("could not reach their host"))).toBe(true);
  });
});

// ─── Priority + readiness ────────────────────────────────────────────────────

describe("StatsAggregator priority and readiness", () => {
  it("walks sources in the documented priority order", () => {
    const priority = new StatsAggregator().prioritySnapshot();

    expect(priority[0]).toBe("SportScore");
    expect(priority[1]).toBe("API-Football");
    expect(priority[2]).toBe("OpenFootAPI");
    expect(priority[3]).toBe("StatsBomb");
    // Understat (Big-5 xG) is consulted before the German-only OpenLigaDB.
    expect(priority.indexOf("Understat")).toBeLessThan(priority.indexOf("OpenLigaDB"));
    // Historical CSV is always the last resort.
    expect(priority[priority.length - 1]).toBe("GitHubDatasets");
    // Every registered source appears exactly once.
    expect(new Set(priority).size).toBe(priority.length);
  });

  it("exposes per-source env readiness without touching the network", () => {
    delete process.env.API_FOOTBALL_KEY;
    delete process.env.FOOTBALL_API_KEY;
    process.env.HIGHLIGHTLY_KEY = "test-key";

    const readiness = new StatsAggregator().sourceReadiness(MATCH);
    const byName = Object.fromEntries(readiness.map((r) => [r.source, r]));

    expect(byName["SportScore"].keyPresent).toBeNull(); // unkeyed source
    expect(byName["API-Football"].keyPresent).toBe(false);
    expect(byName["API-Football"].requiresEnv).toEqual(["API_FOOTBALL_KEY", "FOOTBALL_API_KEY"]);
    expect(byName["Highlightly"].keyPresent).toBe(true);
    expect(readiness.map((r) => r.priority)).toEqual(readiness.map((_, i) => i + 1));

    delete process.env.HIGHLIGHTLY_KEY;
  });

  it("evaluates the league gate for a probe match in readiness output", () => {
    const german = Object.fromEntries(
      new StatsAggregator().sourceReadiness({ ...MATCH, leagueSlug: "ger.1" }).map((r) => [r.source, r]),
    );
    const english = Object.fromEntries(
      new StatsAggregator().sourceReadiness({ ...MATCH, leagueSlug: "eng.1" }).map((r) => [r.source, r]),
    );

    // Deregistered 2026-09-17 (dead sources): no handler, so the gate cannot
    // be evaluated — applicable is null and registered is false.
    expect(german["OpenLigaDB"].registered).toBe(false);
    expect(german["OpenLigaDB"].applicable).toBeNull();
    expect(english["OpenLigaDB"].applicable).toBeNull();
    expect(german["Understat"].registered).toBe(false);
    expect(german["Understat"].applicable).toBeNull();
    expect(english["Understat"].applicable).toBeNull();
    // Registered sources still evaluate their gate normally.
    expect(english["SportScore"].registered).toBe(true);
    expect(english["SportScore"].applicable).toBe(true);
    expect(english["TheSportsDB"].registered).toBe(true);
    expect(english["TheSportsDB"].applicable).toBe(true);
    expect(english["OpenFootAPI"].registered).toBe(true);
  });
});
