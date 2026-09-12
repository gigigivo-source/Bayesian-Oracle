// Boxscore-supply tests for the settlement results provider (Part 1):
//   · the finished-match boxscore is fetched through the multi-source
//     aggregator (every registered source, priority order), not just the
//     final score;
//   · repeated settlement runs never re-fetch (memo cache + coalescing);
//   · the provider logs which source provided the stats:
//     [Settle] Arsenal vs Chelsea — boxscore from API-Football (corners 12, cards 3, shots 18).
//   · the provider exposes exact kickoff timestamps (grace-window input) and
//     distinct finished matches for the prefetch pass.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  peek: vi.fn(() => null as unknown),
  fetch: vi.fn(async (_query?: unknown): Promise<unknown> => null),
}));

vi.mock("@/lib/data/aggregator", () => ({
  statsAggregator: { peek: mocks.peek, fetch: mocks.fetch },
}));
vi.mock("@/lib/espn", () => ({ fetchScoreboard: vi.fn(async () => []) }));

const espnJson = vi.hoisted(() => vi.fn(async (_url?: string, _opts?: unknown): Promise<unknown> => null));
vi.mock("@/lib/httpClient", () => ({ resilientJson: espnJson }));

const {
  ResultsProvider,
  clearSettlementBoxscoreCache,
  getSettlementBoxscore,
  prefetchBoxscores,
} = await import("@/lib/settlement/results");
const { emptyCanonicalMatchStats } = await import("@/lib/data/types");
import type { FixtureLite } from "@/lib/espn";
import type { MatchResult } from "./evaluate";
import type { CanonicalMatchStats } from "../data/types";

function fixture(id: string): FixtureLite {
  return {
    id,
    leagueSlug: "eng.1",
    leagueName: "English Premier League",
    date: "2026-08-21T19:00:00Z",
    state: "post",
    statusDetail: "Match Finished",
    venue: null,
    neutralSite: false,
    home: { id: "h1", name: "Arsenal", shortName: "Arsenal", abbrev: "ARS", logo: null, color: null, score: "2", homeAway: "home" },
    away: { id: "a1", name: "Chelsea", shortName: "Chelsea", abbrev: "CHE", logo: null, color: null, score: "1", homeAway: "away" },
    odds: null,
  };
}

function statsFor(eventId: string): CanonicalMatchStats {
  const s = emptyCanonicalMatchStats({
    leagueSlug: "eng.1", eventId, homeTeam: "Arsenal", awayTeam: "Chelsea", date: "2026-08-21",
  });
  s.home.corners = 7; s.away.corners = 5;           // 12 total
  s.home.yellowCards = 2; s.away.yellowCards = 1;   // 3 cards
  s.home.redCards = 0; s.away.redCards = 0;
  s.home.shots = 10; s.away.shots = 8;              // 18 shots
  s.metadata.source = "API-Football";
  return s;
}

let logs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearSettlementBoxscoreCache();
  vi.clearAllMocks();
  mocks.peek.mockReturnValue(null);
  mocks.fetch.mockResolvedValue(null);
  espnJson.mockResolvedValue(null);
  logs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(() => logSpy.mockRestore());

describe("ResultsProvider", () => {
  it("indexes each match once, keeps the exact kickoff, and dedupes overlaps", () => {
    const provider = new ResultsProvider();
    provider.add(fixture("401"));
    provider.add(fixture("401")); // same fixture from an overlapping date window
    provider.add(fixture("402"));

    const byId = provider.find("401");
    expect(byId?.kickoffAt).toBe("2026-08-21T19:00:00Z");
    expect(byId?.date).toBe("2026-08-21");
    // Reverse-label lookup flips home/away.
    const byLabel = provider.find(null, "Chelsea vs Arsenal");
    expect(byLabel?.homeName).toBe("Chelsea");
    // Distinct finished matches only — no alias duplicates.
    expect(provider.all().map((r) => r.eventId)).toEqual(["401", "402"]);
  });
});

describe("getSettlementBoxscore", () => {
  const result: MatchResult = {
    eventId: "401", leagueSlug: "eng.1", date: "2026-08-21", kickoffAt: "2026-08-21T19:00:00Z",
    homeName: "Arsenal", awayName: "Chelsea", homeScore: 2, awayScore: 1,
  };

  it("walks the multi-source chain with the post-match state key and logs the source", async () => {
    mocks.fetch.mockImplementation(async () => statsFor("401"));

    const outcome = await getSettlementBoxscore(result);

    expect(outcome.stats).not.toBeNull();
    expect(outcome.source).toBe("API-Football");
    expect(outcome.cached).toBe(false);
    // Cache key carries the "post" state — the same key the daily-picks cron
    // warms before the final whistle, so settlement reads the warmed entry.
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const query = mocks.fetch.mock.calls[0][0] as { state?: string; eventId?: string };
    expect(query.state).toBe("post");
    expect(query.eventId).toBe("401");
    expect(logs.some((l) =>
      l.includes("[Settle] Arsenal vs Chelsea — boxscore from API-Football (corners 12, cards 3, shots 18)"),
    )).toBe(true);
  });

  it("memoises positive AND negative results so repeated runs never re-fetch", async () => {
    mocks.fetch.mockImplementation(async () => statsFor("401"));
    await getSettlementBoxscore(result);
    const first = await getSettlementBoxscore(result);
    expect(first.cached).toBe(true);

    // Missing data: memoised too (shorter TTL), so a busy sweep stays cheap.
    mocks.fetch.mockResolvedValue(null);
    const other: MatchResult = { ...result, eventId: "402", leagueSlug: "eng.2" };
    await getSettlementBoxscore(other);
    await getSettlementBoxscore(other);

    expect(mocks.fetch).toHaveBeenCalledTimes(2); // 401 + 402, once each
    expect(logs.some((l) => l.includes("boxscore unavailable"))).toBe(true);
  });

  it("fills gaps from the ESPN boxscore endpoint (spec source #1)", async () => {
    // No aggregator source has anything; ESPN's summary boxscore does.
    mocks.fetch.mockResolvedValue(null);
    espnJson.mockResolvedValue({
      boxscore: {
        teams: [
          { statistics: [{ name: "wonCorners", displayValue: "7" }, { name: "totalShots", displayValue: "10" }] },
          { statistics: [{ name: "wonCorners", displayValue: "5" }, { name: "totalShots", displayValue: "8" }] },
        ],
      },
    });

    const outcome = await getSettlementBoxscore(result);
    expect(outcome.stats).not.toBeNull();
    expect(outcome.stats?.home.corners).toBe(7);
    expect(outcome.stats?.away.corners).toBe(5);
    expect(outcome.source).toContain("ESPN boxscore");
    expect(logs.some((l) => l.includes("boxscore from ESPN boxscore (corners 12, cards 0, shots 18)"))).toBe(true);

    // ESPN must never overwrite a field a registered source already filled:
    clearSettlementBoxscoreCache();
    mocks.fetch.mockResolvedValue(statsFor("401")); // API-Football: corners 7+5
    espnJson.mockResolvedValue({
      boxscore: {
        teams: [
          { statistics: [{ name: "wonCorners", displayValue: "99" }, { name: "foulsCommitted", displayValue: "11" }] },
          { statistics: [{ name: "wonCorners", displayValue: "99" }, { name: "foulsCommitted", displayValue: "9" }] },
        ],
      },
    });
    const merged = await getSettlementBoxscore(result);
    expect(merged.stats?.home.corners).toBe(7);   // API-Football wins
    expect(merged.stats?.home.fouls).toBe(11);     // ESPN fills the gap
    expect(merged.source).toBe("API-Football +ESPN boxscore");
  });

  it("coalesces concurrent lookups for the same match into one fetch", async () => {
    mocks.fetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return statsFor("401");
    });
    const [a, b] = await Promise.all([getSettlementBoxscore(result), getSettlementBoxscore(result)]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(a.stats).toBe(b.stats);
  });

  it("is fail-soft when the aggregator throws", async () => {
    mocks.fetch.mockRejectedValue(new Error("network down"));
    const outcome = await getSettlementBoxscore(result);
    expect(outcome.stats).toBeNull();
  });
});

describe("prefetchBoxscores", () => {
  it("warms the memo for every distinct finished match exactly once", async () => {
    mocks.fetch.mockImplementation(async (query?: unknown) =>
      (query as { eventId?: string } | undefined)?.eventId === "401" ? statsFor("401") : null,
    );
    const results: MatchResult[] = [
      { eventId: "401", leagueSlug: "eng.1", date: "2026-08-21", homeName: "Arsenal", awayName: "Chelsea", homeScore: 2, awayScore: 1 },
      { eventId: "401", leagueSlug: "eng.1", date: "2026-08-21", homeName: "Arsenal", awayName: "Chelsea", homeScore: 2, awayScore: 1 },
      { eventId: "402", leagueSlug: "eng.1", date: "2026-08-21", homeName: "Leeds", awayName: "Ipswich", homeScore: 0, awayScore: 0 },
    ];
    const counts = await prefetchBoxscores(results, 2);
    // Counts are over DISTINCT matches — the duplicate 401 warms nothing.
    expect(counts).toEqual({ withStats: 1, withoutStats: 1 });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});
