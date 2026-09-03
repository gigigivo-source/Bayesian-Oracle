// Tests for the /api/correct-score fixture selection and feed contract.
//
// The page must only ever show Premier League matches whose team identities
// are real. Two failure modes are covered here:
//   • a degraded feed delivering rows without team names ("Unknown") used to
//     reach the page and collapse onto identical league-anchor 1-1 predictions;
//   • non-PL fixtures used to be counted but not attributed — the selection now
//     reports exactly what it skipped and why (also surfaced as `diagnostics`
//     on the empty-feed response).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, hasResolvableTeams, selectPremierLeagueFixtures, type CorrectScoreMatch } from "./route";
import type { FixtureLite } from "@/lib/espn";
import { loadHistoricalMatches, type HistoricalDataset } from "@/lib/data/historical";

vi.mock("@/lib/espn", async () => {
  const actual = await vi.importActual<typeof import("@/lib/espn")>("@/lib/espn");
  return { ...actual, fetchSummary: vi.fn().mockResolvedValue(null) };
});

vi.mock("@/lib/data/aggregator", () => ({
  statsAggregator: {
    fetch: vi.fn().mockResolvedValue(null),
    peek: vi.fn().mockReturnValue(null),
    sourceReadiness: vi.fn().mockReturnValue([]),
    prioritySnapshot: vi.fn().mockReturnValue([]),
    cooldownSnapshot: vi.fn().mockReturnValue({}),
  },
}));

vi.mock("@/lib/data/historical", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/historical")>(
    "@/lib/data/historical",
  );
  return { ...actual, loadHistoricalMatches: vi.fn() };
});

function team(name: string, homeAway: "home" | "away") {
  return {
    id: name,
    name,
    shortName: name,
    abbrev: name.slice(0, 3).toUpperCase(),
    logo: null,
    color: null,
    score: null,
    homeAway,
  };
}

function fixture(overrides: Partial<FixtureLite> & { id: string }): FixtureLite {
  return {
    leagueSlug: "eng.1",
    leagueName: "English Premier League",
    date: new Date(Date.now() + 86_400_000).toISOString(),
    state: "pre",
    statusDetail: "Scheduled",
    venue: null,
    neutralSite: false,
    home: team("Home FC", "home"),
    away: team("Away FC", "away"),
    ...overrides,
  } as FixtureLite;
}

const EMPTY_DATASET: HistoricalDataset = {
  matches: [],
  sources: [],
  primarySource: null,
  seasonsCovered: [],
  matchCount: 0,
  teamCount: 0,
  earliest: null,
  latest: null,
  generatedAt: new Date().toISOString(),
};

describe("hasResolvableTeams", () => {
  it("accepts fixtures with real club names on both sides", () => {
    expect(hasResolvableTeams(fixture({ id: "1" }))).toBe(true);
  });

  it("rejects fixtures whose names are placeholders or missing", () => {
    expect(
      hasResolvableTeams(fixture({ id: "1", home: team("Unknown", "home") })),
    ).toBe(false);
    expect(
      hasResolvableTeams(fixture({ id: "1", away: team("unknown", "away") })),
    ).toBe(false);
    expect(
      hasResolvableTeams(fixture({ id: "1", home: team("  ", "home") })),
    ).toBe(false);
    expect(
      hasResolvableTeams(fixture({ id: "1", away: team("TBD", "away") })),
    ).toBe(false);
    const broken = fixture({ id: "1" }) as { home?: unknown };
    delete broken.home;
    expect(hasResolvableTeams(broken as unknown as FixtureLite)).toBe(false);
  });
});

describe("selectPremierLeagueFixtures", () => {
  const now = Date.now();
  const iso = (msFromNow: number) => new Date(now + msFromNow).toISOString();

  it("keeps in-window pre fixtures for eng.1, sorted by kickoff", () => {
    const late = fixture({ id: "late", date: iso(3 * 86_400_000) });
    const early = fixture({ id: "early", date: iso(86_400_000) });
    const selection = selectPremierLeagueFixtures([late, early], now);
    expect(selection.premierLeague.map((f) => f.id)).toEqual(["early", "late"]);
    expect(selection.anonymous).toHaveLength(0);
    expect(selection.skippedNonPl.size).toBe(0);
  });

  it("drops non-pre fixtures, duplicates, and kickoffs outside the 7-day horizon", () => {
    const live = fixture({ id: "live", state: "in" });
    const finished = fixture({ id: "finished", state: "post" });
    const past = fixture({ id: "past", date: iso(-3_600_000) });
    const beyond = fixture({ id: "beyond", date: iso(8 * 86_400_000) });
    const duplicate = fixture({ id: "early", date: iso(86_400_000) });
    const selection = selectPremierLeagueFixtures(
      [live, finished, past, beyond, duplicate, duplicate],
      now,
    );
    expect(selection.premierLeague.map((f) => f.id)).toEqual(["early"]);
    expect(selection.inWindowCount).toBe(1);
    expect(selection.diagnostics.feedFixtures).toBe(6);
  });

  it("quarantines fixtures without resolvable team names instead of predicting them", () => {
    const anonymous = fixture({
      id: "anon",
      home: team("Unknown", "home"),
      away: team("Unknown", "away"),
    });
    const real = fixture({ id: "real" });
    const selection = selectPremierLeagueFixtures([anonymous, real], now);
    expect(selection.premierLeague.map((f) => f.id)).toEqual(["real"]);
    expect(selection.anonymous.map((f) => f.id)).toEqual(["anon"]);
    expect(selection.diagnostics.unresolvedTeams).toBe(1);
  });

  it("counts non-Premier-League fixtures per canonical slug", () => {
    const laLiga = fixture({ id: "es1", leagueSlug: "esp.1" });
    const laLiga2 = fixture({ id: "es2", leagueSlug: "esp.1" });
    const serieA = fixture({ id: "it1", leagueSlug: "ita.1" });
    const selection = selectPremierLeagueFixtures([laLiga, laLiga2, serieA], now);
    expect(selection.premierLeague).toHaveLength(0);
    expect(selection.diagnostics.nonPremierLeague).toEqual({ "esp.1": 2, "ita.1": 1 });
  });

  it("canonicalises sloppy slug spellings onto eng.1", () => {
    const sloppy = fixture({ id: "sloppy", leagueSlug: " eng.1 " });
    const selection = selectPremierLeagueFixtures([sloppy], now);
    expect(selection.premierLeague).toHaveLength(1);
    expect(selection.premierLeague[0].leagueSlug).toBe("eng.1");
  });
});

describe("GET /api/correct-score", () => {
  beforeEach(() => {
    vi.mocked(loadHistoricalMatches).mockResolvedValue(EMPTY_DATASET);
    vi.unstubAllGlobals();
  });

  function stubFeed(upcoming: FixtureLite[]) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/fixtures")) {
        return Response.json({ upcoming, fixtures: upcoming });
      }
      // Standings probe (and any other outbound call) fails soft.
      return new Response(null, { status: 502 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("publishes Premier League matches with visible team identities and scorelines", async () => {
    stubFeed([
      fixture({
        id: "pl-1",
        date: new Date(Date.now() + 86_400_000).toISOString(),
        home: team("Ipswich Town FC", "home"),
        away: team("Liverpool FC", "away"),
      }),
      fixture({
        id: "pl-2",
        date: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        home: team("Arsenal FC", "home"),
        away: team("Chelsea FC", "away"),
      }),
      // Must never surface: no team identity.
      fixture({
        id: "pl-anon",
        home: team("Unknown", "home"),
        away: team("Unknown", "away"),
      }),
      // Must never surface: not the Premier League.
      fixture({ id: "es-1", leagueSlug: "esp.1", leagueName: "Spanish La Liga" }),
    ]);

    const response = await GET(
      new Request("http://localhost:3000/api/correct-score?refresh=true&sims=1000"),
    );
    expect(response.status).toBe(200);
    const matches = (await response.json()) as CorrectScoreMatch[];
    expect(Array.isArray(matches)).toBe(true);
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.fixtureId)).toEqual(["pl-1", "pl-2"]);
    for (const match of matches) {
      expect(match.homeTeam).toBeTruthy();
      expect(match.awayTeam).toBeTruthy();
      expect(match.homeTeam).not.toBe("Unknown");
      expect(match.leagueSlug).toBe("eng.1");
      expect(match.topScorelines.length).toBeGreaterThan(0);
      expect(match.topScorelines[0].score).toMatch(/^\d+-\d+$/);
      expect(match.topScorelines[0].probability).toBeGreaterThan(0);
    }
  });

  it("reports why the feed is empty when only anonymous fixtures arrive", async () => {
    stubFeed([
      fixture({
        id: "pl-anon",
        home: team("Unknown", "home"),
        away: team("Unknown", "away"),
      }),
    ]);

    const response = await GET(
      new Request("http://localhost:3000/api/correct-score?refresh=true&sims=1000"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      matches: CorrectScoreMatch[];
      message?: string;
      diagnostics?: { unresolvedTeams: number; inWindow: number; nonPremierLeague: Record<string, number> };
    };
    expect(body.matches).toEqual([]);
    expect(body.message).toBe("No Premier League matches available.");
    expect(body.diagnostics?.unresolvedTeams).toBe(1);
    expect(body.diagnostics?.inWindow).toBe(1);
  });
});
