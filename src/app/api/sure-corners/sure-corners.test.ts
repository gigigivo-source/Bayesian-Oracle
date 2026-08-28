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

describe("Sure Corners data quality & confidence annotations", () => {
  it("annotates every market: real badge, contributing source names and a 0-100 score", async () => {
    const mockFixture = makeMockFixture("fixture-quality-real", "Real Home", "Real Away");

    vi.mocked(espn.fetchScoreboard).mockImplementation(async (slug) => {
      if (slug === "eng.1") return [mockFixture];
      return [];
    });

    // Both teams grounded in team-specific corner data, every weighted field
    // present, and three aggregator sources contributed → top-of-scale score.
    vi.mocked(statsAggregator.fetch).mockResolvedValue({
      home: {
        avgCornersPerGame: 6.4,
        avgCornersConcededPerGame: 3.4,
        xg: 1.7,
        possession: 55,
      },
      away: {
        avgCornersPerGame: 5.8,
        avgCornersConcededPerGame: 3.1,
        xg: 1.3,
        possession: 45,
      },
      match: { h2hCorners: { home: 6.1, away: 4.9 } },
      context: {},
      metadata: {
        source: "SportScore",
        sources: ["SportScore", "API-Football", "FBref"],
      },
    } as any);

    const res = await GET(new Request("http://localhost/api/sure-corners?refresh=true"));
    expect(res.status).toBe(200);

    const data = (await res.json()) as SureCornersResponse;
    expect(data.matches.length).toBe(1);
    expect(data.matches[0].markets.length).toBeGreaterThan(0);

    for (const market of data.matches[0].markets) {
      expect(market.dataQuality).toBe("real");
      expect(market.dataSourceDetail).toBe("SportScore + API-Football + FBref (Real)");
      expect(market.confidenceScore).toBe(100);
      expect(market.confidenceBreakdown.dataQualityPoints).toBe(40);
      expect(market.confidenceBreakdown.sourceAgreementPoints).toBe(30);
      expect(market.confidenceBreakdown.completenessPoints).toBe(30);
      expect(market.confidenceBreakdown.sourceCount).toBe(3);
    }
  });

  it("rates a single-source prediction lower than the same multi-source one", async () => {
    const mockFixture = makeMockFixture("fixture-quality-one-source", "Real Home", "Real Away");

    vi.mocked(espn.fetchScoreboard).mockImplementation(async (slug) => {
      if (slug === "eng.1") return [mockFixture];
      return [];
    });

    vi.mocked(statsAggregator.fetch).mockResolvedValue({
      home: {
        avgCornersPerGame: 6.4,
        avgCornersConcededPerGame: 3.4,
        xg: 1.7,
        possession: 55,
      },
      away: {
        avgCornersPerGame: 5.8,
        avgCornersConcededPerGame: 3.1,
        xg: 1.3,
        possession: 45,
      },
      match: { h2hCorners: { home: 6.1, away: 4.9 } },
      context: {},
      // Only one source provided data — no cross-source agreement.
      metadata: { source: "API-Football" },
    } as any);

    const res = await GET(new Request("http://localhost/api/sure-corners?refresh=true"));
    const data = (await res.json()) as SureCornersResponse;
    expect(data.matches.length).toBe(1);

    for (const market of data.matches[0].markets) {
      expect(market.dataQuality).toBe("real");
      expect(market.dataSourceDetail).toBe("API-Football (Real)");
      // real (40) + 1 source (15) + all stats present (30) = 85
      expect(market.confidenceScore).toBe(85);
    }
  });

  it("marks synthetic-baseline matches visibly lower than real-data matches", async () => {
    const realFixture = makeMockFixture("fixture-quality-both-real", "Real Home", "Real Away");
    const syntheticFixture = makeMockFixture(
      "fixture-quality-both-synthetic",
      "Synthetic Home",
      "Synthetic Away",
    );

    vi.mocked(espn.fetchScoreboard).mockImplementation(async (slug) => {
      if (slug === "eng.1") return [realFixture, syntheticFixture];
      return [];
    });

    vi.mocked(statsAggregator.fetch).mockImplementation(async (query: any) => {
      if (query.homeTeam === "Real Home") {
        return {
          home: { avgCornersPerGame: 6.4, xg: 1.7, possession: 55 },
          away: { avgCornersPerGame: 5.8, xg: 1.3, possession: 45 },
          metadata: { source: "SportScore", sources: ["SportScore", "API-Football", "FBref"] },
        } as any;
      }
      // No source could supply data → the route falls back to the synthetic
      // league-average baseline.
      return null;
    });

    const res = await GET(new Request("http://localhost/api/sure-corners?refresh=true"));
    expect(res.status).toBe(200);

    const data = (await res.json()) as SureCornersResponse;
    const byTeam = new Map(data.matches.map((match) => [match.homeTeam, match]));
    const realMatch = byTeam.get("Real Home");
    const syntheticMatch = byTeam.get("Synthetic Home");
    expect(realMatch).toBeDefined();
    expect(syntheticMatch).toBeDefined();

    for (const market of realMatch!.markets) {
      expect(market.dataQuality).toBe("real");
    }
    for (const market of syntheticMatch!.markets) {
      expect(market.dataQuality).toBe("synthetic");
      expect(market.dataSourceDetail).toBe("Synthetic Baseline (League Avg)");
      // Quality floor (12) + no sources (0) + league-default inputs only,
      // so it must stay clearly below any real-data score.
      expect(market.confidenceScore).toBeLessThanOrEqual(30);
    }

    const bestReal = Math.max(...realMatch!.markets.map((market) => market.confidenceScore));
    const bestSynthetic = Math.max(
      ...syntheticMatch!.markets.map((market) => market.confidenceScore),
    );
    expect(bestReal).toBeGreaterThan(bestSynthetic);

    // Even at a 90%+ hit rate the synthetic pick shows the low confidence —
    // that gap is the whole point of the annotation.
    const highHitSynthetic = syntheticMatch!.markets.find((market) => market.hitRate >= 0.9);
    if (highHitSynthetic) {
      expect(highHitSynthetic.confidenceScore).toBeLessThan(50);
    }
  });
});
