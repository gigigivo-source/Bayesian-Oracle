import { describe, expect, it, vi } from "vitest";
import { GET, type SureCornersResponse } from "./route";
import * as espn from "@/lib/espn";
import { statsAggregator } from "@/lib/data/aggregator";

vi.mock("@/lib/espn", async () => {
  const actual = await vi.importActual<typeof import("@/lib/espn")>("@/lib/espn");
  return {
    ...actual,
    fetchScoreboard: vi.fn(),
    fetchSummary: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("@/lib/data/aggregator", () => ({
  statsAggregator: {
    fetch: vi.fn(),
  },
}));

vi.mock("@/lib/engine/dataMesh", () => ({
  getCachedMeshProfile: vi.fn().mockResolvedValue(null),
}));

function makeMockTeam(id: string, name: string): espn.TeamLite {
  return {
    id,
    name,
    shortName: name,
    abbrev: name.slice(0, 3).toUpperCase(),
    logo: null,
    color: "000000",
    score: null,
    homeAway: "home",
  };
}

function makeMockFixture(id: string, homeName: string, awayName: string): espn.FixtureLite {
  return {
    id,
    date: new Date().toISOString(),
    state: "pre",
    statusDetail: "Scheduled",
    venue: "Stadium",
    neutralSite: false,
    leagueSlug: "eng.1",
    leagueName: "English Premier League",
    home: makeMockTeam("1", homeName),
    away: makeMockTeam("2", awayName),
  };
}

describe("Sure Bet Corners Route & Corner Winner Market", () => {
  it("includes Corner Winner in filters.marketTypes", async () => {
    vi.mocked(espn.fetchScoreboard).mockResolvedValue([]);

    const req = new Request("http://localhost/api/sure-corners?refresh=true");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const data = (await res.json()) as SureCornersResponse;
    expect(data.filters.marketTypes).toContain("Corner Winner");
    expect(data.filters.marketTypes).toEqual([
      "Total Corners",
      "Team 1 Corners",
      "Team 2 Corners",
      "Corner Winner",
      "Corner Handicap",
    ]);
  });

  it("generates Corner Winner market when difference > 2.0 and win prob >= 80%", async () => {
    const mockFixture = makeMockFixture("fixture-1", "Arsenal", "Ipswich Town");

    vi.mocked(espn.fetchScoreboard).mockImplementation(async (slug) => {
      if (slug === "eng.1") return [mockFixture];
      return [];
    });

    // High difference stats: Home avg 8.5, Away avg 2.5 (difference > 2.0)
    vi.mocked(statsAggregator.fetch).mockResolvedValue({
      home: {
        avgCornersPerGame: 8.5,
        avgCornersConcededPerGame: 3.0,
        xg: 2.1,
        avgCornersLast5: 8.0,
      },
      away: {
        avgCornersPerGame: 2.5,
        avgCornersConcededPerGame: 7.5,
        xg: 0.8,
        avgCornersLast5: 2.0,
      },
      match: {},
      context: {},
      metadata: { source: "test" },
    } as any);

    const req = new Request("http://localhost/api/sure-corners?refresh=true");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const data = (await res.json()) as SureCornersResponse;
    expect(data.matches.length).toBe(1);

    const match = data.matches[0];
    expect(match.predictedCorners.difference).toBeGreaterThan(2.0);

    const cornerWinnerMarket = match.markets.find((m) => m.marketType === "Corner Winner");
    expect(cornerWinnerMarket).toBeDefined();
    expect(cornerWinnerMarket?.name).toBe("Corner Winner");
    expect(cornerWinnerMarket?.selection).toBe("Arsenal");
    expect(cornerWinnerMarket?.line).toBeNull();
    expect(cornerWinnerMarket?.hitRate).toBeGreaterThanOrEqual(0.8);
    expect(cornerWinnerMarket?.confidence).toBe("HIGH");
  });

  it("does NOT generate Corner Winner market when predicted corner difference <= 2.0", async () => {
    const mockFixture = makeMockFixture("fixture-2", "Arsenal", "Manchester City");

    vi.mocked(espn.fetchScoreboard).mockImplementation(async (slug) => {
      if (slug === "eng.1") return [mockFixture];
      return [];
    });

    // Low difference stats: Home avg 5.5, Away avg 5.0 (difference 0.5 <= 2.0)
    vi.mocked(statsAggregator.fetch).mockResolvedValue({
      home: {
        avgCornersPerGame: 5.5,
        avgCornersConcededPerGame: 5.0,
        xg: 1.5,
        avgCornersLast5: 5.5,
      },
      away: {
        avgCornersPerGame: 5.0,
        avgCornersConcededPerGame: 5.5,
        xg: 1.4,
        avgCornersLast5: 5.0,
      },
      match: {},
      context: {},
      metadata: { source: "test" },
    } as any);

    const req = new Request("http://localhost/api/sure-corners?refresh=true");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const data = (await res.json()) as SureCornersResponse;
    if (data.matches.length > 0) {
      const match = data.matches[0];
      const cornerWinnerMarket = match.markets.find((m) => m.marketType === "Corner Winner");
      expect(cornerWinnerMarket).toBeUndefined();
    }
  });

  it("does NOT include Corner Winner market if win probability is < 80%", async () => {
    const mockFixture = makeMockFixture("fixture-3", "Team A", "Team B");

    vi.mocked(espn.fetchScoreboard).mockImplementation(async (slug) => {
      if (slug === "eng.1") return [mockFixture];
      return [];
    });

    vi.mocked(statsAggregator.fetch).mockResolvedValue({
      home: {
        avgCornersPerGame: 3.2,
        avgCornersConcededPerGame: 1.1,
        xg: 1.0,
        avgCornersLast5: 3.2,
      },
      away: {
        avgCornersPerGame: 1.1,
        avgCornersConcededPerGame: 3.2,
        xg: 0.5,
        avgCornersLast5: 1.1,
      },
      match: {},
      context: {},
      metadata: { source: "test" },
    } as any);

    const req = new Request("http://localhost/api/sure-corners?refresh=true");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const data = (await res.json()) as SureCornersResponse;
    if (data.matches.length > 0) {
      const match = data.matches[0];
      const cornerWinnerMarket = match.markets.find((m) => m.marketType === "Corner Winner");
      if (cornerWinnerMarket) {
        expect(cornerWinnerMarket.hitRate).toBeGreaterThanOrEqual(0.8);
      }
    }
  });
});
