// @vitest-environment happy-dom

// First 5 Minutes board — upcoming-fixtures grouping (page) plus the settled
// history behind the Recent Results section (API).
//
// The page is a client component: it reads /api/first-5-minutes for the
// upcoming board and /api/first-5-minutes/results for the settled matches below
// it. Both fetches are stubbed here; nothing in this file touches the network.
//
// The results endpoint reads performance_log through drizzle; the database
// module is mocked with a small chainable query builder (the same "rows + read
// error" shape the other route tests use) so the grouping, window, ordering and
// fail-soft behaviour can be asserted without a database.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getSettledResults } from "@/app/api/first-5-minutes/results/route";
import First5MinutesPage from "./page";
import { formatDateTime } from "./components/format";
import type { First5Match, First5MinutesData } from "./components/types";

// ─── Database mock ────────────────────────────────────────────────────────────
// db.select(...).from(...).where(...).orderBy(...).limit(...) — every link is
// chainable and only limit() answers, mirroring how the route consumes the
// builder. `lastLimit` records the row budget the route asked for (matches × 4).

const dbState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  readError: null as Error | null,
  lastLimit: null as number | null,
}));

vi.mock("@/db", () => {
  const query = {
    where: () => query,
    orderBy: () => query,
    limit: (count: number) => {
      dbState.lastLimit = count;
      if (dbState.readError) return Promise.reject(dbState.readError);
      return Promise.resolve(dbState.rows);
    },
  };
  return { db: { select: () => ({ from: () => query }) } };
});

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

beforeEach(() => {
  dbState.rows = [];
  dbState.readError = null;
  dbState.lastLimit = null;
});

/** ISO day string N days before today — the same convention the route uses. */
function dayOffset(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

// ─── Upcoming-fixtures fixtures (page) ────────────────────────────────────────

function fixture(fixtureId: string, leagueSlug: string, date: string): First5Match {
  return {
    fixtureId,
    homeTeam: `Home ${fixtureId}`,
    awayTeam: `Away ${fixtureId}`,
    homeLogo: null,
    awayLogo: null,
    // Deliberately identical: grouping must use the slug, not the feed's label.
    league: "Feed competition label",
    leagueSlug,
    leagueTier: 1,
    date,
    venue: null,
    statsSource: "ESPN",
    dataOrigin: "real",
    realMarketCount: 0,
    markets: [],
  };
}

function first5Payload(matches: First5Match[]): First5MinutesData {
  return {
    generatedAt: "2026-09-19T10:00:00Z",
    windowMinutes: 5,
    lookaheadDays: 7,
    totalFixturesChecked: matches.length,
    totalMatches: matches.length,
    marketTypes: [],
    model: {
      description: "Test model",
      matchMinutes: 96,
      openingIntensity: { goal: 1, corner: 1, card: 1, penalty: 1 },
    },
    cache: { ttlMinutes: 60, hit: false },
    matches,
  };
}

/**
 * Fetch stub that answers both board endpoints: the upcoming feed returns
 * `upcoming`, the settled-results endpoint returns `settled`.
 */
function pageFetchMock(upcoming: First5MinutesData, settled: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.startsWith("/api/first-5-minutes/results")
      ? settled
      : upcoming;
    return { ok: true, status: 200, json: async () => body };
  });
}

async function renderBoard(fetchMock: ReturnType<typeof pageFetchMock>): Promise<HTMLDivElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(First5MinutesPage));
  });
  return container;
}

// ─── Settled results fixtures (API) ───────────────────────────────────────────

type SettledOutcome = "WIN" | "LOSS" | "PUSH" | "VOID";

/** One settled performance_log row as the pg driver would deliver it. */
function settledRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "evt-1",
    matchLabel: "Arsenal vs Chelsea",
    league: "English Premier League",
    leagueSlug: "eng.1",
    matchDate: dayOffset(1),
    homeScore: 2,
    awayScore: 1,
    market: "Goal in First 5 Minutes",
    selection: "Yes",
    hitRate: 0.87,
    confidence: "HIGH",
    outcome: "WIN",
    ...overrides,
  };
}

async function getResults(query = "") {
  const response = await getSettledResults(
    new Request(`http://localhost/api/first-5-minutes/results${query}`),
  );
  const body = (await response.json()) as {
    ok: boolean;
    matches: Array<{
      eventId: string;
      matchLabel: string;
      league: string;
      leagueSlug: string;
      matchDate: string;
      homeScore: number | null;
      awayScore: number | null;
      markets: Array<{
        market: string;
        selection: string;
        hitRate: number;
        confidence: string;
        outcome: string;
      }>;
    }>;
  };
  return { response, body };
}

/** One settled match for the page payload (shape mirrors the endpoint). */
function settledMatch(index: number, outcome: SettledOutcome) {
  return {
    eventId: `settled-${index}`,
    matchLabel: `Home ${index} vs Away ${index}`,
    league: "Feed competition label",
    leagueSlug: "eng.1",
    matchDate: dayOffset(((index - 1) % 10) + 1),
    homeScore: 2,
    awayScore: index % 2,
    markets: [
      {
        market: "Goal in First 5 Minutes",
        selection: index % 2 === 0 ? "Yes" : "No",
        hitRate: 0.8,
        confidence: "HIGH",
        outcome,
      },
    ],
  };
}

// ─── Upcoming-fixtures board ──────────────────────────────────────────────────

it("renders Premier League, La Liga, then UEFA Champions League with kickoff-sorted cards", async () => {
  const champions = fixture("ucl", "uefa.champions", "2026-09-19T12:00:00Z");
  const premierLate = fixture("pl-late", "eng.1", "2026-09-21T18:00:00Z");
  const premierEarly = fixture("pl-early", "eng.1", "2026-09-20T18:00:00Z");
  const spanishLate = fixture("liga-late", "esp.1", "2026-09-20T18:00:00Z");
  // A later wall-clock time but an earlier instant, to check timezone-aware sorting.
  const spanishEarly = fixture("liga-early", "esp.1", "2026-09-20T19:00:00+02:00");
  const matches = [champions, spanishLate, premierLate, spanishEarly, premierEarly];
  const fetchMock = pageFetchMock(first5Payload(matches), { ok: true, matches: [] });
  const container = await renderBoard(fetchMock);

  // The Recent Results heading is the other h2 on the page; the league group
  // headings are the ones under test here.
  const headers = [...container.querySelectorAll("h2")].filter(
    (header) => !header.closest("#recent-results"),
  );
  expect(headers.map((header) => header.textContent)).toEqual([
    "Premier League",
    "La Liga",
    "UEFA Champions League",
  ]);

  const expectedGroups = [[premierEarly, premierLate], [spanishEarly, spanishLate], [champions]];
  headers.forEach((header, index) => {
    const cards = [...header.parentElement!.parentElement!.querySelectorAll("article")];
    expect(cards).toHaveLength(expectedGroups[index].length);
    cards.forEach((card, cardIndex) => {
      const match = expectedGroups[index][cardIndex];
      expect(card.textContent).toContain(match.homeTeam);
      expect(card.textContent).toContain(formatDateTime(match.date));
    });
  });
  expect(matches.map((match) => match.fixtureId)).toEqual([
    "ucl", "liga-late", "pl-late", "liga-early", "pl-early",
  ]);
  expect(fetchMock).toHaveBeenCalledWith("/api/first-5-minutes", { cache: "no-store" });
  expect(fetchMock).toHaveBeenCalledWith("/api/first-5-minutes/results?days=14", {
    cache: "no-store",
  });
});

// ─── Recent Results section ───────────────────────────────────────────────────

describe("Recent Results section", () => {
  it("summarises the settled markets and shows the 10 newest before the Show all toggle", async () => {
    const dates = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    // Four pushes/voids must not count towards "won" or "lost".
    const outcomes: SettledOutcome[] = [
      "WIN", "WIN", "WIN", "WIN", "WIN", "WIN", "WIN", "WIN", "LOSS", "LOSS", "PUSH", "VOID",
    ];
    // Deliberately shuffled: the section must render newest first regardless.
    const payload = {
      ok: true,
      matches: dates.map((day, index) => ({
        ...settledMatch(index + 1, outcomes[index]),
        matchDate: dayOffset(13 - day),
      })),
    };
    const fetchMock = pageFetchMock(first5Payload([]), payload);
    const container = await renderBoard(fetchMock);

    const section = container.querySelector("#recent-results");
    expect(section).not.toBeNull();
    // 12 finished matches · 8 won · 2 lost, 80% of the 10 decided markets —
    // the PUSH and VOID rows count as neither won nor lost.
    expect(section!.textContent).toContain("12 finished matches · 8 won · 2 lost");
    expect(section!.textContent).toContain("80.0% hit rate");

    // Collapsed to the 10 newest matches.
    const rows = [...section!.querySelectorAll("article")];
    expect(rows).toHaveLength(10);
    expect(rows[0].textContent).toContain("Home 12 vs Away 12");
    expect(rows[9].textContent).toContain("Home 3 vs Away 3");
    // Market detail: label · selection, the model's claim, and the outcome badge.
    expect(rows[0].textContent).toContain("Goal in First 5 Minutes");
    expect(rows[0].textContent).toContain("Model: 80% (HIGH)");
    expect(rows[0].textContent).toContain("Result:");

    const toggle = [...section!.querySelectorAll("button")].find(
      (button) => button.textContent === "Show all 12",
    );
    expect(toggle).toBeDefined();
    await act(async () => {
      toggle!.click();
    });
    expect([...section!.querySelectorAll("article")]).toHaveLength(12);
  });

  it("shows the placeholder when nothing settled inside the window", async () => {
    const fetchMock = pageFetchMock(first5Payload([]), { ok: true, matches: [] });
    const container = await renderBoard(fetchMock);

    const section = container.querySelector("#recent-results");
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("RECENT RESULTS — LAST 14 DAYS");
    expect(section!.textContent).toContain("No settled predictions in the last 14 days yet.");
  });
});

// ─── GET /api/first-5-minutes/results ─────────────────────────────────────────

describe("GET /api/first-5-minutes/results", () => {
  it("returns no matches when performance_log has no first5 rows", async () => {
    const { response, body } = await getResults();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.matches).toEqual([]);
  });

  it("groups settled rows into matches with their markets and outcomes", async () => {
    dbState.rows = [
      settledRow({
        eventId: "evt-recent",
        matchLabel: "Arsenal vs Chelsea",
        matchDate: dayOffset(1),
        market: "Goal in First 5 Minutes",
        selection: "Yes",
        hitRate: 0.87,
        confidence: "HIGH",
        outcome: "WIN",
      }),
      settledRow({
        eventId: "evt-recent",
        matchDate: dayOffset(1),
        market: "Corner in First 5 Minutes",
        selection: "No",
        hitRate: 0.63,
        confidence: "MEDIUM",
        outcome: "LOSS",
      }),
      settledRow({
        eventId: "evt-older",
        matchLabel: "Bayern Munich vs Dortmund",
        league: "German Bundesliga",
        leagueSlug: "ger.1",
        matchDate: dayOffset(3),
        homeScore: 1,
        awayScore: 1,
        market: "Card in First 5 Minutes",
        selection: "No",
        hitRate: 0.91,
        confidence: "HIGH",
        outcome: "WIN",
      }),
      settledRow({
        eventId: "evt-older",
        matchLabel: "Bayern Munich vs Dortmund",
        league: "German Bundesliga",
        leagueSlug: "ger.1",
        matchDate: dayOffset(3),
        homeScore: 1,
        awayScore: 1,
        market: "Goal in First 5 Minutes",
        selection: "No",
        hitRate: 0.55,
        confidence: "LOW",
        outcome: "PUSH",
      }),
    ];

    const { body } = await getResults();
    expect(body.matches).toHaveLength(2);

    const [recent, older] = body.matches;
    expect(recent).toMatchObject({
      eventId: "evt-recent",
      matchLabel: "Arsenal vs Chelsea",
      league: "English Premier League",
      leagueSlug: "eng.1",
      matchDate: dayOffset(1),
      homeScore: 2,
      awayScore: 1,
    });
    expect(recent.markets).toEqual([
      {
        market: "Goal in First 5 Minutes",
        selection: "Yes",
        hitRate: 0.87,
        confidence: "HIGH",
        outcome: "WIN",
      },
      {
        market: "Corner in First 5 Minutes",
        selection: "No",
        hitRate: 0.63,
        confidence: "MEDIUM",
        outcome: "LOSS",
      },
    ]);

    // 2 WIN, 1 LOSS, 1 PUSH across the two matches — each market keeps its own outcome.
    expect(older).toMatchObject({ eventId: "evt-older", homeScore: 1, awayScore: 1 });
    expect(older.markets.map((market) => market.outcome)).toEqual(["WIN", "PUSH"]);
  });

  it("excludes rows older than the days window", async () => {
    dbState.rows = [
      settledRow({ eventId: "inside", matchDate: dayOffset(2) }),
      settledRow({ eventId: "outside", matchDate: dayOffset(20) }),
    ];

    // Default window: 14 days.
    const { body } = await getResults();
    expect(body.matches.map((match) => match.eventId)).toEqual(["inside"]);

    // An explicit wider window brings the older row back (still newest first).
    const wider = await getResults("?days=30");
    expect(wider.body.matches.map((match) => match.eventId)).toEqual(["inside", "outside"]);
  });

  it("sorts matches by match date, newest first", async () => {
    dbState.rows = [
      settledRow({ eventId: "oldest", matchDate: dayOffset(9) }),
      settledRow({ eventId: "newest", matchDate: dayOffset(1) }),
      settledRow({ eventId: "middle", matchDate: dayOffset(4) }),
    ];

    const { body } = await getResults();
    expect(body.matches.map((match) => match.eventId)).toEqual(["newest", "middle", "oldest"]);
  });

  it("ignores rows that are not settled yet", async () => {
    dbState.rows = [
      settledRow({ eventId: "still-pending", outcome: "pending" }),
      settledRow({ eventId: "settled", outcome: "WIN" }),
    ];

    const { body } = await getResults();
    expect(body.matches.map((match) => match.eventId)).toEqual(["settled"]);
  });

  it("caps the matches at limit and reads limit × 4 rows", async () => {
    dbState.rows = [1, 2, 3, 4, 5].map((index) =>
      settledRow({ eventId: `evt-${index}`, matchDate: dayOffset(index) }),
    );

    const { body } = await getResults("?limit=2");
    expect(body.matches).toHaveLength(2);
    expect(dbState.lastLimit).toBe(8);

    await getResults("?limit=1000");
    expect(dbState.lastLimit).toBe(400);
  });

  it("never 500s: a database error answers with an empty list", async () => {
    dbState.readError = new Error("connection refused");

    const { response, body } = await getResults();
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, matches: [] });
  });
});
