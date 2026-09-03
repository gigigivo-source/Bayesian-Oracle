// Tests for the /api/correct-score fixture selection and feed contract.
//
// The page must only ever show England Premier League (eng.1) matches whose
// team identities are real and whose two clubs are in the 2026/27 division.
// Three failure modes are covered here:
//   • a degraded feed delivering rows without team names ("Unknown") used to
//     reach the page and collapse onto identical league-anchor 1-1 predictions;
//   • non-PL fixtures used to be counted but not attributed — the selection now
//     reports exactly what it skipped and why (also surfaced as `diagnostics`
//     on the empty-feed response);
//   • rows stamped `eng.1` that name a club outside the 2026/27 squad list
//     (relegated sides from a stale feed, cup or reserve rows) are discarded by
//     the allowlist, never predicted.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET,
  PREMIER_LEAGUE_CLUBS_2026_27,
  filterPremierLeagueSquad,
  hasResolvableTeams,
  matchPremierLeagueClub,
  selectPremierLeagueFixtures,
  type CorrectScoreMatch,
  type FeedDiagnostics,
} from "./route";
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

describe("matchPremierLeagueClub — 2026/27 squad allowlist", () => {
  it("covers exactly the 20 clubs in the division", () => {
    expect(PREMIER_LEAGUE_CLUBS_2026_27).toHaveLength(20);
    for (const club of PREMIER_LEAGUE_CLUBS_2026_27) {
      expect(matchPremierLeagueClub(club.name), club.name).toBe(club.name);
    }
  });

  it("matches the documented short forms, ignoring case, accents and punctuation", () => {
    const cases: Array<[string, string]> = [
      ["Bournemouth", "AFC Bournemouth"],
      ["AFC Bournemouth", "AFC Bournemouth"],
      ["brighton", "Brighton & Hove Albion"],
      ["BRIGHTON & HOVE ALBION", "Brighton & Hove Albion"],
      ["Coventry", "Coventry City"],
      ["Hull", "Hull City"],
      ["Ipswich", "Ipswich Town"],
      ["Leeds", "Leeds United"],
      ["Man City", "Manchester City"],
      ["Manchester City FC", "Manchester City"],
      ["Man United", "Manchester United"],
      ["Manchester United", "Manchester United"],
      ["Newcastle", "Newcastle United"],
      ["Nottingham", "Nottingham Forest"],
      ["Sunderland", "Sunderland"],
      ["Tottenham", "Tottenham Hotspur"],
      ["Spurs", "Tottenham Hotspur"],
      ["  arsenal  ", "Arsenal"],
      ["aston villa", "Aston Villa"],
      ["Crystal Palace FC", "Crystal Palace"],
      // Broadcast-style abbreviations a feed may deliver.
      ["Nott'm Forest", "Nottingham Forest"],
      ["Man. City", "Manchester City"],
      ["Man. Utd", "Manchester United"],
      ["Newcastle Utd", "Newcastle United"],
    ];
    for (const [input, expected] of cases) {
      expect(matchPremierLeagueClub(input), input).toBe(expected);
    }
  });

  it("never confuses the two Manchester clubs", () => {
    expect(matchPremierLeagueClub("Manchester City")).toBe("Manchester City");
    expect(matchPremierLeagueClub("Manchester United")).toBe("Manchester United");
    expect(matchPremierLeagueClub("Manchester")).toBe(null);
  });

  it("rejects clubs that are not in the 2026/27 division", () => {
    for (const name of [
      "West Ham United", // relegated at the end of 2025/26
      "Burnley", // relegated at the end of 2025/26
      "Wolverhampton Wanderers", // relegated at the end of 2025/26
      "Wolves",
      "Leicester City",
      "Real Madrid",
      "Celtic",
      "Home FC",
      "Unknown",
      "",
    ]) {
      expect(matchPremierLeagueClub(name), name).toBe(null);
    }
  });

  it("rejects youth, women and reserve rows that carry a Premier League name", () => {
    expect(matchPremierLeagueClub("Arsenal U21")).toBe(null);
    expect(matchPremierLeagueClub("Manchester United Women")).toBe(null);
    expect(matchPremierLeagueClub("Liverpool Reserves")).toBe(null);
    expect(matchPremierLeagueClub(undefined)).toBe(null);
  });
});

describe("filterPremierLeagueSquad", () => {
  it("keeps only fixtures whose two clubs are both in the squad list", () => {
    const kept = fixture({
      id: "kept",
      home: team("Coventry City", "home"),
      away: team("Arsenal", "away"),
    });
    const stale = fixture({
      id: "stale",
      home: team("West Ham United", "home"),
      away: team("Arsenal", "away"),
    });
    const partial = fixture({
      id: "partial",
      home: team("Arsenal", "home"),
      away: team("Rangers", "away"),
    });
    const result = filterPremierLeagueSquad([kept, stale, partial]);
    expect(result.kept.map((f) => f.id)).toEqual(["kept"]);
    expect(result.rejected.map((r) => `${r.home} vs ${r.away}`)).toEqual([
      "West Ham United vs Arsenal",
      "Arsenal vs Rangers",
    ]);
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
    expect(body.message).toBe(
      "No England Premier League matches available in the current fixture window.",
    );
    expect(body.diagnostics?.unresolvedTeams).toBe(1);
    expect(body.diagnostics?.inWindow).toBe(1);
  });

  it("discards eng.1 fixtures naming a club outside the 2026/27 squad list", async () => {
    stubFeed([
      fixture({
        id: "pl-kept",
        home: team("Coventry City", "home"),
        away: team("Arsenal", "away"),
      }),
      // Relegated at the end of 2025/26 — must never be predicted.
      fixture({
        id: "pl-stale",
        home: team("West Ham United", "home"),
        away: team("Burnley", "away"),
      }),
      // Right league filter, wrong division.
      fixture({
        id: "pl-reserve",
        home: team("Manchester United Reserves", "home"),
        away: team("Arsenal U21", "away"),
      }),
      // Right competition shape, wrong league.
      fixture({ id: "es-1", leagueSlug: "esp.1", leagueName: "Spanish La Liga" }),
    ]);

    const response = await GET(
      new Request("http://localhost:3000/api/correct-score?refresh=true&sims=1000"),
    );
    expect(response.status).toBe(200);
    const matches = (await response.json()) as CorrectScoreMatch[];
    expect(matches.map((m) => m.fixtureId)).toEqual(["pl-kept"]);
    expect(matches[0].homeTeam).toBe("Coventry City");
    expect(matches[0].awayTeam).toBe("Arsenal");
    expect(matches[0].leagueSlug).toBe("eng.1");
  });

  it("reports the filter counters when no England Premier League fixture survives", async () => {
    stubFeed([
      fixture({
        id: "stale",
        home: team("West Ham United", "home"),
        away: team("Wolverhampton Wanderers", "away"),
      }),
      fixture({ id: "es-1", leagueSlug: "esp.1", leagueName: "Spanish La Liga" }),
    ]);

    const response = await GET(
      new Request("http://localhost:3000/api/correct-score?refresh=true&sims=1000"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      matches: CorrectScoreMatch[];
      message: string;
      diagnostics: FeedDiagnostics;
    };
    expect(body.matches).toEqual([]);
    expect(body.message).toBe(
      "No England Premier League matches available in the current fixture window.",
    );
    expect(body.diagnostics.totalFixturesScanned).toBe(2);
    expect(body.diagnostics.filteredByLeague).toBe(1);
    expect(body.diagnostics.filteredByTeamList).toBe(1);
    expect(body.diagnostics.rejectedTeams).toEqual([
      "West Ham United vs Wolverhampton Wanderers",
    ]);
    expect(body.diagnostics.season).toBe("2026/27");
  });
});
