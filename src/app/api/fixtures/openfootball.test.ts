// Tests for the openfootball / api.github.com fixture fallback.
//
// This fallback exists for deployments whose egress allowlist blocks ESPN and
// every stats provider (docs/NETWORK_ALLOWLIST.md) but permits api.github.com.
// Without it the fixture feed — and therefore /api/correct-score — is empty in
// exactly the environment the allowlist doc describes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchOpenfootballFixtures,
  fuzzyTeamNameEq,
  hasLooseFixtureDuplicate,
  openfootballFixture,
  type OpenfootballRow,
} from "./route";
import { resilientJson } from "@/lib/httpClient";
import type { FixtureLite } from "@/lib/espn";

vi.mock("@/lib/httpClient", () => ({
  resilientJson: vi.fn(),
}));

// The route instantiates the aggregator at import time; none of these tests
// exercise stats attachment, so a stub keeps the module graph light.
vi.mock("@/lib/data/aggregator", () => ({
  statsAggregator: {
    fetch: vi.fn().mockResolvedValue(null),
    peek: vi.fn().mockReturnValue(null),
    sourceReadiness: vi.fn().mockReturnValue([]),
    prioritySnapshot: vi.fn().mockReturnValue([]),
    cooldownSnapshot: vi.fn().mockReturnValue({}),
  },
}));

const CONTEXT = {
  leagueSlug: "eng.1",
  leagueName: "English Premier League",
  season: "2026-27",
  code: "en.1",
};

describe("openfootballFixture", () => {
  it("maps a scheduled row to a pre-match fixture with real team names", () => {
    const row: OpenfootballRow = {
      round: "Matchday 3",
      date: "2026-09-04",
      time: "20:00",
      team1: "Ipswich Town FC",
      team2: "Liverpool FC",
    };
    const fixture = openfootballFixture(row, CONTEXT);
    expect(fixture).not.toBeNull();
    expect(fixture!.leagueSlug).toBe("eng.1");
    expect(fixture!.leagueName).toBe("English Premier League");
    expect(fixture!.state).toBe("pre");
    expect(fixture!.date).toBe("2026-09-04T20:00:00Z");
    expect(fixture!.home.name).toBe("Ipswich Town FC");
    expect(fixture!.away.name).toBe("Liverpool FC");
    expect(fixture!.home.homeAway).toBe("home");
    expect(fixture!.away.homeAway).toBe("away");
    expect(fixture!.home.score).toBeNull();
    expect(fixture!.statusDetail).toBe("Matchday 3");
    expect(fixture!.id).toContain("openfootball:2026-27:en.1:2026-09-04");
  });

  it("maps a completed row ({ht,ft} encoding) to a post-match fixture with the score", () => {
    const row: OpenfootballRow = {
      round: "Matchday 1",
      date: "2026-08-21",
      time: "20:00",
      team1: "Arsenal FC",
      team2: "Coventry City FC",
      score: { ht: [2, 0], ft: [3, 0] },
    };
    const fixture = openfootballFixture(row, CONTEXT);
    expect(fixture!.state).toBe("post");
    expect(fixture!.home.score).toBe("3");
    expect(fixture!.away.score).toBe("0");
    expect(fixture!.statusDetail).toBe("Full Time");
  });

  it("keeps 0-0 results given openfootball's bare-array shorthand", () => {
    const row: OpenfootballRow = {
      date: "2026-08-22",
      team1: "Chelsea FC",
      team2: "Everton FC",
      score: [0, 0],
    };
    const fixture = openfootballFixture(row, CONTEXT);
    expect(fixture!.state).toBe("post");
    expect(fixture!.home.score).toBe("0");
    expect(fixture!.away.score).toBe("0");
  });

  it("defaults a missing kickoff time to 15:00Z so same-day fixtures stay upcoming", () => {
    const row: OpenfootballRow = { date: "2026-09-05", team1: "Leeds United FC", team2: "Brentford FC" };
    const fixture = openfootballFixture(row, CONTEXT);
    expect(fixture!.date).toBe("2026-09-05T15:00:00Z");
  });

  it("rejects rows without both team names or a valid ISO date", () => {
    expect(openfootballFixture({ date: "2026-09-05", team1: "Leeds United FC" }, CONTEXT)).toBeNull();
    expect(openfootballFixture({ date: "05/09/2026", team1: "A", team2: "B" }, CONTEXT)).toBeNull();
    expect(openfootballFixture({ team1: "A", team2: "B" }, CONTEXT)).toBeNull();
  });
});

describe("fuzzyTeamNameEq", () => {
  it("matches the same club across provider spellings", () => {
    expect(fuzzyTeamNameEq("Liverpool FC", "Liverpool")).toBe(true);
    expect(fuzzyTeamNameEq("AFC Bournemouth", "Bournemouth")).toBe(true);
    expect(fuzzyTeamNameEq("Brighton & Hove Albion FC", "Brighton and Hove Albion")).toBe(false);
    expect(fuzzyTeamNameEq("Manchester United FC", "Manchester United")).toBe(true);
  });

  it("does not match different clubs or empty names", () => {
    expect(fuzzyTeamNameEq("Arsenal FC", "Chelsea FC")).toBe(false);
    expect(fuzzyTeamNameEq("", "Liverpool")).toBe(false);
    expect(fuzzyTeamNameEq("FC", "FC United")).toBe(false); // too short to trust containment
  });
});

describe("hasLooseFixtureDuplicate", () => {
  const espnFixture = {
    id: "401879288",
    leagueSlug: "eng.1",
    leagueName: "English Premier League",
    date: "2026-09-04T19:00:00Z",
    state: "pre",
    statusDetail: "Scheduled",
    venue: null,
    neutralSite: false,
    home: { id: "1", name: "Ipswich Town", shortName: "Ipswich", abbrev: "IPS", logo: null, color: null, score: null, homeAway: "home" },
    away: { id: "2", name: "Liverpool", shortName: "Liverpool", abbrev: "LIV", logo: null, color: null, score: null, homeAway: "away" },
  } satisfies FixtureLite;

  it("flags the same league-day pairing under another provider's spelling", () => {
    const candidate = openfootballFixture(
      { date: "2026-09-04", time: "20:00", team1: "Ipswich Town FC", team2: "Liverpool FC" },
      CONTEXT,
    )!;
    expect(hasLooseFixtureDuplicate([espnFixture], candidate)).toBe(true);
  });

  it("does not flag a different day or a different pairing", () => {
    const otherDay = openfootballFixture(
      { date: "2026-09-05", time: "20:00", team1: "Ipswich Town FC", team2: "Liverpool FC" },
      CONTEXT,
    )!;
    const otherTeams = openfootballFixture(
      { date: "2026-09-04", time: "20:00", team1: "Arsenal FC", team2: "Chelsea FC" },
      CONTEXT,
    )!;
    expect(hasLooseFixtureDuplicate([espnFixture], otherDay)).toBe(false);
    expect(hasLooseFixtureDuplicate([espnFixture], otherTeams)).toBe(false);
  });
});

describe("fetchOpenfootballFixtures", () => {
  beforeEach(() => {
    vi.mocked(resilientJson).mockReset();
  });

  it("fetches the season file through the GitHub Contents API and filters to the window", async () => {
    vi.mocked(resilientJson).mockResolvedValue({
      name: "English Premier League 2026/27",
      matches: [
        // Before the window (played): dropped.
        { round: "Matchday 1", date: "2026-08-21", time: "20:00", team1: "Arsenal FC", team2: "Coventry City FC", score: { ft: [3, 0] } },
        // In the window (scheduled): kept.
        { round: "Matchday 3", date: "2026-09-04", time: "20:00", team1: "Ipswich Town FC", team2: "Liverpool FC" },
        // After the window: dropped.
        { round: "Matchday 4", date: "2026-09-12", time: "15:00", team1: "Liverpool FC", team2: "Fulham FC" },
      ],
    });

    const from = new Date("2026-09-02T00:00:00Z");
    const to = new Date("2026-09-06T00:00:00Z");
    const result = await fetchOpenfootballFixtures("eng.1", "2026-27", from, to);

    expect(resilientJson).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(resilientJson).mock.calls[0];
    expect(url).toBe(
      "https://api.github.com/repos/openfootball/football.json/contents/2026-27/en.1.json",
    );
    expect((opts as { headers?: Record<string, string> })?.headers?.Accept).toBe(
      "application/vnd.github.raw+json",
    );

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("Openfootball");
    expect(result[0].fixture.home.name).toBe("Ipswich Town FC");
    expect(result[0].fixture.away.name).toBe("Liverpool FC");
    // Header name carries the season suffix — it must be stripped for display.
    expect(result[0].fixture.leagueName).toBe("English Premier League");
  });

  it("returns nothing (and makes no request) for leagues without an openfootball mapping", async () => {
    const result = await fetchOpenfootballFixtures(
      "fifa.world",
      "2026-27",
      new Date("2026-09-02"),
      new Date("2026-09-06"),
    );
    expect(result).toEqual([]);
    expect(resilientJson).not.toHaveBeenCalled();
  });

  it("fails soft when GitHub is unreachable", async () => {
    vi.mocked(resilientJson).mockResolvedValue(null);
    const result = await fetchOpenfootballFixtures(
      "eng.1",
      "2026-27",
      new Date("2026-09-02"),
      new Date("2026-09-06"),
    );
    expect(result).toEqual([]);
  });
});
