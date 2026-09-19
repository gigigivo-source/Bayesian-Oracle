// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import First5MinutesPage from "./page";
import type { First5Match, First5MinutesData } from "./components/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("./components/MatchCard", () => ({
  MatchCard: ({ match }: { match: First5Match }) => (
    <div data-fixture-id={match.fixtureId}>{match.homeTeam}</div>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function fixture(
  fixtureId: string,
  leagueSlug: string,
  league: string,
  date: string,
): First5Match {
  return {
    fixtureId,
    homeTeam: `${fixtureId} home`,
    awayTeam: `${fixtureId} away`,
    homeLogo: null,
    awayLogo: null,
    league,
    leagueSlug,
    leagueTier: 1,
    date,
    venue: null,
    statsSource: "test",
    dataOrigin: "real",
    realMarketCount: 0,
    markets: [],
  };
}

it("renders league section headers in the configured competition order", async () => {
  const payload: First5MinutesData = {
    generatedAt: "2026-09-19T10:00:00Z",
    windowMinutes: 5,
    lookaheadDays: 7,
    totalFixturesChecked: 3,
    totalMatches: 3,
    marketTypes: [],
    model: {
      description: "test",
      matchMinutes: 96,
      openingIntensity: { goal: 1, corner: 1, card: 1, penalty: 1 },
    },
    cache: { ttlMinutes: 60, hit: false },
    matches: [
      fixture("ucl", "uefa.champions", "Champions League", "2026-09-20T18:00:00Z"),
      fixture("laliga", "esp.1", "Spanish La Liga", "2026-09-20T16:00:00Z"),
      fixture("premier-league", "eng.1", "English Premier League", "2026-09-20T14:00:00Z"),
    ],
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => payload }) as unknown as Response,
    ),
  );

  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<First5MinutesPage />);
  });
  await act(async () => {
    await Promise.resolve();
  });

  const sectionHeaders = [...container.querySelectorAll("section > div > h2")].map(
    (heading) => heading.textContent,
  );
  expect(sectionHeaders).toEqual([
    "Premier League",
    "LaLiga",
    "UEFA Champions League",
  ]);
});
