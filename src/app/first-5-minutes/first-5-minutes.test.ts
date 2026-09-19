// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import First5MinutesPage from "./page";
import { formatDateTime } from "./components/format";
import type { First5Match, First5MinutesData } from "./components/types";

const resultsDbState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  error: null as Error | null,
  limits: [] as number[],
}));

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async (value: number) => {
              resultsDbState.limits.push(value);
              if (resultsDbState.error) throw resultsDbState.error;
              return resultsDbState.rows;
            },
          }),
        }),
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  performanceLog: {
    feature: "feature",
    matchDate: "match_date",
    outcome: "outcome",
  },
}));

import { GET as getRecentResults } from "../api/first-5-minutes/results/route";

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  resultsDbState.rows.length = 0;
  resultsDbState.error = null;
  resultsDbState.limits.length = 0;
  vi.unstubAllGlobals();
});

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

function dateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function resultRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    eventId: "event-1",
    matchLabel: "Home One vs Away One",
    homeTeam: "Home One",
    awayTeam: "Away One",
    league: "Premier League",
    leagueSlug: "eng.1",
    competitionName: "Premier League",
    matchDate: dateDaysAgo(1),
    homeScore: 2,
    awayScore: 1,
    feature: "first5",
    market: "Goal in First 5 Minutes",
    selection: "Yes",
    hitRate: 0.72,
    confidence: "HIGH",
    outcome: "WIN",
    ...overrides,
  };
}

async function recentResults(query = ""): Promise<{ ok: boolean; matches: Array<Record<string, unknown>> }> {
  const response = await getRecentResults(
    new Request(`http://localhost/api/first-5-minutes/results${query}`),
  );
  return (await response.json()) as { ok: boolean; matches: Array<Record<string, unknown>> };
}

it("returns no recent results when performance_log has no first5 rows", async () => {
  const body = await recentResults();

  expect(body).toEqual({ ok: true, matches: [] });
  expect(resultsDbState.limits).toEqual([120]);
});

it("groups settled first5 rows by event with their markets and outcomes", async () => {
  resultsDbState.rows = [
    resultRow({ id: 1, eventId: "event-new", market: "Goal in First 5", outcome: "WIN" }),
    resultRow({ id: 2, eventId: "event-new", market: "Corner in First 5", outcome: "LOSS" }),
    resultRow({ id: 3, eventId: "event-old", matchDate: dateDaysAgo(3), market: "Goal in First 5", outcome: "PUSH" }),
    resultRow({ id: 4, eventId: "event-old", matchDate: dateDaysAgo(3), market: "Card in First 5", outcome: "WIN" }),
  ];

  const body = await recentResults();

  expect(body.matches).toHaveLength(2);
  expect(body.matches[0]).toMatchObject({ eventId: "event-new", homeScore: 2, awayScore: 1 });
  expect((body.matches[0].markets as Array<Record<string, unknown>>).map((market) => market.outcome)).toEqual([
    "WIN", "LOSS",
  ]);
  expect((body.matches[1].markets as Array<Record<string, unknown>>).map((market) => market.outcome)).toEqual([
    "PUSH", "WIN",
  ]);
});

it("excludes rows older than the requested days window", async () => {
  resultsDbState.rows = [
    resultRow({ id: 1, eventId: "recent", matchDate: dateDaysAgo(2) }),
    resultRow({ id: 2, eventId: "old", matchDate: dateDaysAgo(30) }),
  ];

  const body = await recentResults("?days=14");

  expect(body.matches.map((match) => match.eventId)).toEqual(["recent"]);
});

it("sorts result groups newest first by matchDate", async () => {
  resultsDbState.rows = [
    resultRow({ id: 1, eventId: "older", matchDate: dateDaysAgo(5) }),
    resultRow({ id: 2, eventId: "newer", matchDate: dateDaysAgo(1) }),
  ];

  const body = await recentResults();

  expect(body.matches.map((match) => match.eventId)).toEqual(["newer", "older"]);
});

it("renders Premier League, La Liga, then UEFA Champions League with kickoff-sorted cards", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const champions = fixture("ucl", "uefa.champions", "2026-09-19T12:00:00Z");
  const premierLate = fixture("pl-late", "eng.1", "2026-09-21T18:00:00Z");
  const premierEarly = fixture("pl-early", "eng.1", "2026-09-20T18:00:00Z");
  const spanishLate = fixture("liga-late", "esp.1", "2026-09-20T18:00:00Z");
  // A later wall-clock time but an earlier instant, to check timezone-aware sorting.
  const spanishEarly = fixture("liga-early", "esp.1", "2026-09-20T19:00:00+02:00");
  const matches = [champions, spanishLate, premierLate, spanishEarly, premierEarly];
  const payload: First5MinutesData = {
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
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/first-5-minutes/results")) {
      return { ok: true, json: async () => ({ ok: true, matches: [] }) };
    }
    return { ok: true, json: async () => payload };
  });
  vi.stubGlobal("fetch", fetchMock);

  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(First5MinutesPage));
  });

  const headers = [...container.querySelectorAll("h2")]
    .filter((header) => header.textContent !== "📊 RECENT RESULTS — LAST 14 DAYS");
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
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenCalledWith("/api/first-5-minutes", { cache: "no-store" });
  expect(fetchMock).toHaveBeenCalledWith("/api/first-5-minutes/results", { cache: "no-store" });
});
