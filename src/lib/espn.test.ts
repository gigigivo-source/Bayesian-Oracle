// ESPN scoreboard fetcher — day-by-day expansion of `dates` ranges.
//
// ESPN answers HTTP 400 to a multi-day `dates` range ("YYYYMMDD-YYYYMMDD"),
// which used to make every league scan come back empty. These tests pin the
// replacement behaviour: a range is expanded into one single-day request per
// day, the per-day boards are merged and deduplicated by event id, and one
// failing day never sinks the rest of the range.
//
// `fetch` is mocked. The module registry is reset before every test so the
// shared HTTP client's in-memory cache (and its own retry/backoff) cannot leak
// responses from one case into the next.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  fetchScoreboard as FetchScoreboard,
  getCurrentMatchweek as GetCurrentMatchweek,
} from "./espn";

let fetchScoreboard: typeof FetchScoreboard;
let getCurrentMatchweek: typeof GetCurrentMatchweek;
let fetchMock: ReturnType<typeof vi.fn>;

// ─── ESPN payload helpers ─────────────────────────────────────────────────────

function espnEvent(id: string, date: string) {
  const team = (name: string, homeAway: "home" | "away") => ({
    homeAway,
    score:   "0",
    team:    { id: `${name}-id`, displayName: name, abbreviation: name.slice(0, 3).toUpperCase() },
  });
  return {
    id,
    date,
    name: `${team("Arsenal", "home").team.displayName} vs ${team("Chelsea", "away").team.displayName}`,
    status: { type: { state: "pre", shortDetail: "Scheduled" } },
    competitions: [
      {
        competitors: [team("Arsenal", "home"), team("Chelsea", "away")],
        status:      { type: { state: "pre", shortDetail: "Scheduled" } },
      },
    ],
  };
}

function scoreboard(events: unknown[]): Response {
  return {
    ok:      true,
    status:  200,
    headers: new Headers(),
    json:    async () => ({ leagues: [{ name: "English Premier League" }], events }),
  } as unknown as Response;
}

function serverError(): Response {
  return {
    ok:      false,
    status:  500,
    headers: new Headers(),
    json:    async () => ({}),
  } as unknown as Response;
}

/** The single-day `dates` value carried by a captured fetch URL. */
function dayOf(url: unknown): string {
  return new URL(String(url)).searchParams.get("dates") ?? "";
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  ({ fetchScoreboard, getCurrentMatchweek } = await import("./espn"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("fetchScoreboard — dates handling", () => {
  it("makes one single-day request for a plain YYYYMMDD value", async () => {
    fetchMock.mockImplementation(async () => scoreboard([espnEvent("100", "2026-09-16T18:30:00Z")]));

    const fixtures = await fetchScoreboard("eng.1", "20260916");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/eng.1/scoreboard");
    expect(url).toContain("dates=20260916");
    expect(dayOf(url)).toBe("20260916");
    expect(fixtures.map((f) => f.id)).toEqual(["100"]);
  });

  it("fetches a 3-day range day-by-day and deduplicates the merged union", async () => {
    const byDay: Record<string, unknown[]> = {
      "20260916": [espnEvent("100", "2026-09-16T18:30:00Z")],
      // "100" shows up again on the 17th — it must survive only once.
      "20260917": [espnEvent("100", "2026-09-17T18:30:00Z"), espnEvent("200", "2026-09-17T20:00:00Z")],
      "20260918": [espnEvent("300", "2026-09-18T14:00:00Z")],
    };
    fetchMock.mockImplementation(async (url: string) => scoreboard(byDay[dayOf(url)] ?? []));

    const fixtures = await fetchScoreboard("eng.1", "20260916-20260918");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const days = fetchMock.mock.calls.map(([url]) => dayOf(url));
    expect(days).toEqual(["20260916", "20260917", "20260918"]);
    // Never hand ESPN a range back — that is the HTTP 400 we are avoiding.
    for (const day of days) expect(day).not.toContain("-");

    expect(fixtures.map((f) => f.id)).toEqual(["100", "200", "300"]);
    expect(fixtures.filter((f) => f.id === "100")).toHaveLength(1);
  });

  it("keeps the other days when one day fails upstream", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const day = dayOf(url);
      if (day === "20260917") return serverError();
      return scoreboard([espnEvent(day === "20260916" ? "100" : "300", `${day}T18:30:00Z`)]);
    });

    const fixtures = await fetchScoreboard("eng.1", "20260916-20260918");

    // Every day was requested; the failing one is retried by the shared HTTP
    // client's 5xx backoff, the healthy ones are asked exactly once.
    const requestedDays = new Set(fetchMock.mock.calls.map(([url]) => dayOf(url)));
    expect([...requestedDays].sort()).toEqual(["20260916", "20260917", "20260918"]);
    expect(fetchMock.mock.calls.filter(([url]) => dayOf(url) === "20260916")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => dayOf(url) === "20260918")).toHaveLength(1);

    expect(fixtures.map((f) => f.id)).toEqual(["100", "300"]);
  });

  it("collapses a reversed range to the start day", async () => {
    fetchMock.mockImplementation(async () => scoreboard([espnEvent("100", "2026-09-18T18:30:00Z")]));

    const fixtures = await fetchScoreboard("eng.1", "20260918-20260916");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dayOf(fetchMock.mock.calls[0][0])).toBe("20260918");
    expect(fixtures.map((f) => f.id)).toEqual(["100"]);
  });

  it("collapses a same-day range to a single request", async () => {
    fetchMock.mockImplementation(async () => scoreboard([espnEvent("100", "2026-09-16T18:30:00Z")]));

    await fetchScoreboard("eng.1", "20260916-20260916");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dayOf(fetchMock.mock.calls[0][0])).toBe("20260916");
  });

  it("feeds the default window in as single days too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
    fetchMock.mockImplementation(async () => scoreboard([]));

    await fetchScoreboard("eng.1");

    expect(fetchMock.mock.calls.map(([url]) => dayOf(url))).toEqual([
      "20260915",
      "20260916",
      "20260917",
    ]);
  });
});

describe("fetchScoreboard — matchweek handling", () => {
  it("uses ESPN ?week=X directly when ESPN confirms the requested week", async () => {
    const ev = {
      ...espnEvent("mw11-1", "2026-11-21T15:00:00Z"),
      week: { number: 11 },
    };
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        leagues: [{ name: "English Premier League" }],
        week: { number: 11 },
        events: [ev],
      }),
    }) as unknown as Response);

    const fixtures = await fetchScoreboard("eng.1", undefined, 11);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/eng.1/scoreboard?week=11");
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].id).toBe("mw11-1");
    expect(fixtures[0].matchweek).toBe(11);
  });

  it("falls back to openfootball schedule + ESPN date enrichment when ESPN ignores ?week=", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));

    const openfootballPayload = {
      name: "English Premier League 2026/27",
      matches: [
        { round: "Matchday 10", date: "2026-11-07", time: "15:00", team1: "Arsenal FC", team2: "Hull City AFC" },
        { round: "Matchday 11", date: "2026-11-21", time: "15:00", team1: "Chelsea FC", team2: "Leeds United FC" },
      ],
    };

    const espnFinishedEvent = {
      id: "espn-ars-hull",
      date: "2026-11-07T15:00:00Z",
      name: "Arsenal vs Hull City",
      status: { type: { state: "post", shortDetail: "FT" } },
      competitions: [{
        competitors: [
          { homeAway: "home", score: "3", team: { id: "ars", displayName: "Arsenal", abbreviation: "ARS" } },
          { homeAway: "away", score: "1", team: { id: "hul", displayName: "Hull City", abbreviation: "HUL" } },
        ],
        status: { type: { state: "post", shortDetail: "FT" } },
      }],
    };

    fetchMock.mockImplementation(async (rawUrl: string) => {
      const url = String(rawUrl);
      if (url.includes("api.github.com/repos/openfootball/football.json/contents/2026-27/en.1.json")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => openfootballPayload,
        } as unknown as Response;
      }
      if (url.includes("dates=20261107")) {
        return scoreboard([espnFinishedEvent]);
      }
      // Probe (?week=10) and adjacent days return empty scoreboard without week metadata
      return scoreboard([]);
    });

    const fixtures = await fetchScoreboard("eng.1", undefined, 10);

    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].id).toBe("espn-ars-hull");
    expect(fixtures[0].state).toBe("post");
    expect(fixtures[0].home.score).toBe("3");
    expect(fixtures[0].away.score).toBe("1");
    expect(fixtures[0].matchweek).toBe(10);
  });

  it("returns openfootball schedule immediately when ESPN probe fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));

    const openfootballPayload = {
      name: "English Premier League 2026/27",
      matches: [
        { round: "Matchday 1", date: "2026-08-21", time: "20:00", team1: "Arsenal FC", team2: "Coventry City FC", score: { ft: [3, 0] } },
        { round: "Matchday 11", date: "2026-11-21", time: "15:00", team1: "Manchester City FC", team2: "Fulham FC" },
      ],
    };

    fetchMock.mockImplementation(async (rawUrl: string) => {
      const url = String(rawUrl);
      if (url.includes("api.github.com/repos/openfootball/football.json/contents/2026-27/en.1.json")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => openfootballPayload,
        } as unknown as Response;
      }
      return serverError();
    });

    const mw1 = await fetchScoreboard("eng.1", undefined, 1);
    expect(mw1).toHaveLength(1);
    expect(mw1[0].state).toBe("post");
    expect(mw1[0].home.score).toBe("3");
    expect(mw1[0].away.score).toBe("0");
    expect(mw1[0].matchweek).toBe(1);

    // Ensure no per-day ESPN requests were made after ESPN probe failed
    const espnDayCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("dates="));
    expect(espnDayCalls).toHaveLength(0);
  });

  it("filters by matchweek when dates and week are both passed", async () => {
    const ev1 = { ...espnEvent("101", "2026-09-16T18:30:00Z"), week: { number: 4 } };
    const ev2 = { ...espnEvent("102", "2026-09-16T20:00:00Z"), week: { number: 5 } };
    fetchMock.mockImplementation(async () => scoreboard([ev1, ev2]));

    const fixtures = await fetchScoreboard("eng.1", "20260916", 5);
    expect(fixtures.map((f) => f.id)).toEqual(["102"]);
    expect(fixtures[0].matchweek).toBe(5);
  });

  it("getCurrentMatchweek picks active/upcoming round and falls back to 11", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        matches: [
          { round: "Matchday 10", date: "2026-11-07", team1: "A", team2: "B" },
          { round: "Matchday 11", date: "2026-11-21", team1: "C", team2: "D" },
        ],
      }),
    }) as unknown as Response);

    expect(await getCurrentMatchweek("eng.1", new Date("2026-11-11T12:00:00Z"))).toBe(11);
    expect(await getCurrentMatchweek("eng.1", new Date("2026-11-08T12:00:00Z"))).toBe(10);

    vi.resetModules();
    fetchMock = vi.fn().mockResolvedValue(serverError());
    vi.stubGlobal("fetch", fetchMock);
    ({ getCurrentMatchweek } = await import("./espn"));
    expect(await getCurrentMatchweek("eng.1", new Date("2026-11-11T12:00:00Z"))).toBe(11);
  });
});
