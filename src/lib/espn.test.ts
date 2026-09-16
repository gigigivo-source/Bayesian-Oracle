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

import type { fetchScoreboard as FetchScoreboard } from "./espn";

let fetchScoreboard: typeof FetchScoreboard;
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
  ({ fetchScoreboard } = await import("./espn"));
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
