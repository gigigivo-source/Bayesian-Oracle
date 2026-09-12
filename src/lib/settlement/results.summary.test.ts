// ESPN-summary-first result resolution for the settlement results provider —
// the fix for "the engine resolves 0 matches even though ESPN has the result":
//
//   · the ESPN summary endpoint
//     `/soccer/{leagueSlug}/summary?event={eventId}` is always tried FIRST,
//     per match, under a league slug DERIVED FROM THE MATCH (a Champions
//     League fixture is asked for as `uefa.champions`, a Premier League one as
//     `eng.1`) and keyed by the event id;
//   · the score is read from header.competitions[0].competitors[].score, with
//     boxscore.teams[].score as the fallback;
//   · a summary that is empty (or still in play) settles nothing — the
//     scoreboard feed remains the fallback and the log says which source won;
//   · rows saved without a usable ESPN slug (global "all" scoreboard, foreign
//     provider namespaces) have their competition slug recovered from ESPN's
//     global scoreboard by team names + date, so the boxscore fetch (corners,
//     cards …) works for them too.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchScoreboard: vi.fn(async (_slug?: string, _dates?: string): Promise<unknown[]> => []),
  peek: vi.fn((_query?: unknown): unknown => null),
  fetchStats: vi.fn(async (_query?: unknown): Promise<unknown> => null),
  json: vi.fn(async (_url?: string): Promise<unknown> => null),
}));

vi.mock("@/lib/espn", () => ({ fetchScoreboard: mocks.fetchScoreboard }));
vi.mock("@/lib/data/aggregator", () => ({
  statsAggregator: { peek: mocks.peek, fetch: mocks.fetchStats },
}));
vi.mock("@/lib/httpClient", () => ({ resilientJson: mocks.json }));

const {
  clearSettlementBoxscoreCache,
  fetchSettlementResults,
  getSettlementBoxscore,
  espnSlugCandidates,
} = await import("@/lib/settlement/results");
import type { SettlementQueues } from "@/lib/settlement/results";
import type { MatchResult } from "./evaluate";

const EVENT_ID = "401915443";

/** Minimal SettlementQueues — rows are cast, only the read fields matter here. */
function queues(rows: {
  dailyPicks?: unknown[];
  valueBets?: unknown[];
  accumulators?: unknown[];
}): SettlementQueues {
  return {
    accumulators: (rows.accumulators ?? []) as SettlementQueues["accumulators"],
    dailyPicks: (rows.dailyPicks ?? []) as SettlementQueues["dailyPicks"],
    valueBets: (rows.valueBets ?? []) as SettlementQueues["valueBets"],
  };
}

/** The Champions League row the reported bug was about. */
function dailyPickRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    pickDate: "2026-09-09",
    match: "Bayern Munich vs Bodo/Glimt",
    league: "UEFA Champions League",
    leagueSlug: "uefa.champions",
    eventId: EVENT_ID,
    picks: [{ name: "Match Winner", selection: "Home Win" }],
    status: "pending",
    ...overrides,
  };
}

/** An ESPN summary payload shaped like the real endpoint's response. */
function summary(options: {
  homeScore?: string | null;
  awayScore?: string | null;
  state?: string;
  boxScores?: { home?: string; away?: string };
} = {}): unknown {
  const { state = "post", boxScores } = options;
  return {
    header: {
      id: EVENT_ID,
      competitions: [{
        date: "2026-09-09T19:00:00Z",
        status: { type: { state, completed: state === "post", shortDetail: state === "post" ? "FT" : "45'" } },
        competitors: [
          {
            homeAway: "home",
            ...(options.homeScore === undefined ? {} : { score: options.homeScore }),
            team: { displayName: "Bayern Munich" },
          },
          {
            homeAway: "away",
            ...(options.awayScore === undefined ? {} : { score: options.awayScore }),
            team: { displayName: "Bodo/Glimt" },
          },
        ],
      }],
    },
    ...(boxScores
      ? {
          boxscore: {
            teams: [
              { homeAway: "home", score: boxScores.home },
              { homeAway: "away", score: boxScores.away },
            ],
          },
        }
      : {}),
  };
}

/** A finished scoreboard fixture for the same match. */
function scoreboardFixture(homeScore = "3", awayScore = "1"): unknown {
  return {
    id: EVENT_ID,
    leagueSlug: "uefa.champions",
    leagueName: "UEFA Champions League",
    date: "2026-09-09T19:00:00Z",
    state: "post",
    statusDetail: "FT",
    venue: null,
    neutralSite: false,
    home: { id: "1", name: "Bayern Munich", shortName: "Bayern", abbrev: "BAY", logo: null, color: null, score: homeScore, homeAway: "home" },
    away: { id: "2", name: "Bodo/Glimt", shortName: "Glimt", abbrev: "BOD", logo: null, color: null, score: awayScore, homeAway: "away" },
    odds: null,
  };
}

let logs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearSettlementBoxscoreCache();
  vi.clearAllMocks();
  mocks.fetchScoreboard.mockResolvedValue([]);
  mocks.peek.mockReturnValue(null);
  mocks.fetchStats.mockResolvedValue(null);
  mocks.json.mockResolvedValue(null);
  logs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(() => logSpy.mockRestore());

describe("fetchSettlementResults — ESPN summary first", () => {
  it("resolves a Champions League match from the summary endpoint and logs the source", async () => {
    mocks.json.mockImplementation(async (url?: string) =>
      (url?.includes(`/uefa.champions/summary?event=${EVENT_ID}`) ? summary({ homeScore: "3", awayScore: "1" }) : null));

    const provider = await fetchSettlementResults(queues({ dailyPicks: [dailyPickRow()] }));

    const result = provider.find(EVENT_ID);
    expect(result?.homeScore).toBe(3);
    expect(result?.awayScore).toBe(1);
    expect(result?.leagueSlug).toBe("uefa.champions");
    expect(result?.kickoffAt).toBe("2026-09-09T19:00:00Z");
    // The summary result is indexable by label too (both team orders).
    expect(provider.find(null, "Bodo/Glimt vs Bayern Munich")?.homeScore).toBe(1);
    expect(provider.sourceCounts()).toEqual({ espnSummary: 1, scoreboard: 0 });

    // The exact diagnostic lines requested for the settlement logs.
    expect(logs).toContain(
      `[Settle] Fetching result for Bayern Munich vs Bodo/Glimt (event ${EVENT_ID}, league uefa.champions)`,
    );
    expect(logs).toContain("[Settle] ESPN summary returned: home 3, away 1");
  });

  it("derives the league slug from the competition name when the row's slug is unusable", async () => {
    const requested: string[] = [];
    mocks.json.mockImplementation(async (url?: string) => {
      requested.push(url ?? "");
      return url?.includes(`/uefa.champions/summary?event=${EVENT_ID}`)
        ? summary({ homeScore: "2", awayScore: "0" })
        : null;
    });

    // Rows saved from the global ESPN scoreboard carry the "all" slug.
    const provider = await fetchSettlementResults(queues({
      dailyPicks: [dailyPickRow({ leagueSlug: "all" })],
    }));

    expect(provider.find(EVENT_ID)?.homeScore).toBe(2);
    expect(requested.some((url) => url.includes(`/uefa.champions/summary?event=${EVENT_ID}`))).toBe(true);
    // The derivation hit on the first candidate — no global fallback needed.
    expect(requested.some((url) => url.includes(`/all/summary?event=${EVENT_ID}`))).toBe(false);
  });

  it("reads the score from boxscore.teams[].score when the header omits scores", async () => {
    mocks.json.mockImplementation(async (url?: string) =>
      (url?.includes("/uefa.champions/summary") ? summary({ boxScores: { home: "4", away: "2" } }) : null));

    const provider = await fetchSettlementResults(queues({ dailyPicks: [dailyPickRow()] }));

    expect(provider.find(EVENT_ID)?.homeScore).toBe(4);
    expect(provider.find(EVENT_ID)?.awayScore).toBe(2);
  });

  it("prefers the summary over the scoreboard when both know the event", async () => {
    mocks.json.mockImplementation(async (url?: string) =>
      (url?.includes("/uefa.champions/summary") ? summary({ homeScore: "3", awayScore: "1" }) : null));
    mocks.fetchScoreboard.mockResolvedValue([scoreboardFixture("1", "0")]);

    const provider = await fetchSettlementResults(queues({ dailyPicks: [dailyPickRow()] }));

    expect(provider.find(EVENT_ID)?.homeScore).toBe(3);
    expect(provider.sourceCounts()).toEqual({ espnSummary: 1, scoreboard: 0 });
  });

  it("falls back to the scoreboard feed when the summary is empty, and says so", async () => {
    mocks.json.mockResolvedValue(null);
    mocks.fetchScoreboard.mockResolvedValue([scoreboardFixture()]);

    const provider = await fetchSettlementResults(queues({ dailyPicks: [dailyPickRow()] }));

    expect(provider.find(EVENT_ID)?.homeScore).toBe(3);
    expect(provider.sourceCounts()).toEqual({ espnSummary: 0, scoreboard: 1 });
    expect(logs).toContain(`[Settle] ESPN summary empty for event ${EVENT_ID} — trying next source`);
  });

  it("never settles a match the summary still reports as in play", async () => {
    mocks.json.mockImplementation(async (url?: string) =>
      (url?.includes("/uefa.champions/summary") ? summary({ homeScore: "1", awayScore: "0", state: "in" }) : null));

    const provider = await fetchSettlementResults(queues({ dailyPicks: [dailyPickRow()] }));

    expect(provider.find(EVENT_ID)).toBeUndefined();
    expect(provider.all()).toEqual([]);
    expect(logs.some((line) => line.includes("is not finished yet"))).toBe(true);
  });

  it("probes every event once, even when several rows share a match", async () => {
    mocks.json.mockImplementation(async (url?: string) =>
      (url?.includes("/uefa.champions/summary") ? summary({ homeScore: "3", awayScore: "1" }) : null));

    const provider = await fetchSettlementResults(queues({
      dailyPicks: [dailyPickRow()],
      valueBets: [
        { id: 7, eventId: EVENT_ID, leagueSlug: "uefa.champions", competitionName: "UEFA Champions League", match: "Bayern Munich vs Bodo/Glimt", matchDate: "2026-09-09" },
        { id: 8, eventId: EVENT_ID, leagueSlug: "all", competitionName: "UEFA Champions League", match: "Bayern Munich vs Bodo/Glimt", matchDate: "2026-09-09" },
      ],
      accumulators: [{
        id: 9, name: "Slip", combinedOdds: 2, stake: 10, status: "pending", competitionName: "UEFA Champions League",
        picks: [{ fixtureId: EVENT_ID, leagueSlug: "sportscore:uefa-champions-league", matchLabel: "Bayern Munich vs Bodo/Glimt", date: "2026-09-09" }],
      }],
    }));

    expect(provider.all()).toHaveLength(1);
    expect(provider.find(EVENT_ID)?.homeScore).toBe(3);
  });
});

describe("espnSlugCandidates — league slug derived from the match", () => {
  it("maps catalogue competition names onto ESPN slugs", () => {
    expect(espnSlugCandidates({ leagueSlug: "uefa.champions", leagueName: "UEFA Champions League" })[0])
      .toBe("uefa.champions");
    expect(espnSlugCandidates({ leagueSlug: "all", leagueName: "Premier League" })[0]).toBe("eng.1");
    expect(espnSlugCandidates({ leagueName: "Champions League" })[0]).toBe("uefa.champions");
    expect(espnSlugCandidates({ leagueName: "UEFA Champions League, League Phase" })[0]).toBe("uefa.champions");
    expect(espnSlugCandidates({ leagueName: "La Liga" })[0]).toBe("esp.1");
  });

  it("recovers an ESPN slug from namespaced or plain-name slugs", () => {
    expect(espnSlugCandidates({ leagueSlug: "tsdb:english-premier-league" })[0]).toBe("eng.1");
    expect(espnSlugCandidates({ leagueSlug: "sportscore:uefa-champions-league" })[0]).toBe("uefa.champions");
    expect(espnSlugCandidates({ leagueSlug: "uefa.champions_qual" })[0]).toBe("uefa.champions");
    // Nothing usable to derive from.
    expect(espnSlugCandidates({ leagueSlug: "all" })).toEqual([]);
    expect(espnSlugCandidates({ leagueSlug: null, leagueName: null })).toEqual([]);
  });
});

describe("getSettlementBoxscore — slug recovery for rows saved without an ESPN slug", () => {
  it("recovers the competition from the global scoreboard, then fetches the ESPN boxscore", async () => {
    const match: MatchResult = {
      eventId: EVENT_ID, leagueSlug: "all", date: "2026-09-09",
      homeName: "Bayern Munich", awayName: "Bodo/Glimt", homeScore: 3, awayScore: 1,
    };
    mocks.fetchScoreboard.mockImplementation(async (slug?: string) =>
      (slug === "all" ? [scoreboardFixture()] : []));
    mocks.json.mockImplementation(async (url?: string) =>
      (url?.includes(`/uefa.champions/summary?event=${EVENT_ID}`)
        ? {
            boxscore: {
              teams: [
                { homeAway: "home", statistics: [{ name: "wonCorners", displayValue: "6" }, { name: "yellowCards", displayValue: "2" }] },
                { homeAway: "away", statistics: [{ name: "wonCorners", displayValue: "4" }, { name: "yellowCards", displayValue: "3" }] },
              ],
            },
          }
        : null));

    const outcome = await getSettlementBoxscore(match);

    expect(outcome.stats?.home.corners).toBe(6);
    expect(outcome.stats?.away.corners).toBe(4);
    expect(outcome.source).toContain("ESPN boxscore");
  });
});
