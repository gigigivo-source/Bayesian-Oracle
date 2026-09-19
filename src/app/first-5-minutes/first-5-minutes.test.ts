// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import First5MinutesPage from "./page";
import { formatDateTime } from "./components/format";
import type { First5Match, First5MinutesData } from "./components/types";

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
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
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => payload }));
  vi.stubGlobal("fetch", fetchMock);

  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(First5MinutesPage));
  });

  const headers = [...container.querySelectorAll("h2")];
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
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/first-5-minutes", { cache: "no-store" });
});
