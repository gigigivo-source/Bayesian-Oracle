import { describe, expect, it, vi } from "vitest";
import {
  GET,
  atLeastOne,
  bookOddsFor,
  confidenceFor,
  fairOddsFor,
  resolveStatsSource,
  round1xBetOdds,
  SYNTHETIC_BASELINE,
  type First5MinutesResponse,
} from "./route";
import * as espn from "@/lib/espn";
import { statsAggregator } from "@/lib/data/aggregator";
import { emptyTeamStats } from "@/lib/data/types";

vi.mock("@/lib/espn", async () => {
  const actual = await vi.importActual<typeof import("@/lib/espn")>("@/lib/espn");
  return {
    ...actual,
    fetchScoreboard: vi.fn(),
  };
});

vi.mock("@/lib/data/aggregator", () => ({
  statsAggregator: {
    fetch: vi.fn(),
  },
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
    date: new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString(),
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

describe("First 5 Minutes model helpers", () => {
  it("maps confidence from probability thresholds", () => {
    expect(confidenceFor(0.8)).toBe("HIGH");
    expect(confidenceFor(0.79)).toBe("MEDIUM");
    expect(confidenceFor(0.6)).toBe("MEDIUM");
    expect(confidenceFor(0.59)).toBe("LOW");
  });

  it("snaps odds onto the 1xBet ladder", () => {
    expect(round1xBetOdds(1.126)).toBe(1.125);
    expect(round1xBetOdds(1.032)).toBe(1.03);
    expect(round1xBetOdds(1.5)).toBe(1.5);
    expect(round1xBetOdds(5.84)).toBe(5.8);
    expect(round1xBetOdds(14.6)).toBe(15);
  });

  it("computes fair odds as 1 / p and Poisson P(Yes)", () => {
    expect(fairOddsFor(0.5)).toBe(2);
    expect(atLeastOne(0)).toBe(0);
    expect(atLeastOne(Math.log(2))).toBeCloseTo(0.5, 5);
    expect(bookOddsFor(0.5)).toBe(2);
  });

  it("labels a missing aggregator source as Synthetic Baseline", () => {
    expect(resolveStatsSource(null)).toBe(SYNTHETIC_BASELINE);
    expect(resolveStatsSource("")).toBe(SYNTHETIC_BASELINE);
    expect(resolveStatsSource("SportScore")).toBe("SportScore");
  });
});

describe("First 5 Minutes API", () => {
  it("returns four dual-outcome markets with Yes and No metrics", async () => {
    const fixture = makeMockFixture("fx-1", "Arsenal", "Chelsea");
    vi.mocked(espn.fetchScoreboard).mockImplementation(async (slug) => {
      if (slug === "eng.1") return [fixture];
      return [];
    });

    vi.mocked(statsAggregator.fetch).mockResolvedValue({
      home: {
        ...emptyTeamStats(),
        xg: 1.8,
        avgCornersPerGame: 6.2,
        avgCardsPerGame: 1.9,
        fouls: 11,
      },
      away: {
        ...emptyTeamStats(),
        xg: 1.4,
        avgCornersPerGame: 4.8,
        avgCardsPerGame: 2.1,
        fouls: 12,
      },
      metadata: {
        source: "SportScore",
        fetchedAt: new Date().toISOString(),
        matchDate: fixture.date.slice(0, 10),
        leagueSlug: "eng.1",
      },
    });

    const res = await GET(new Request("http://localhost/api/first-5-minutes?refresh=true"));
    expect(res.status).toBe(200);

    const data = (await res.json()) as First5MinutesResponse;
    expect(data.matches.length).toBe(1);
    expect(data.matches[0].statsSource).toBe("SportScore");
    expect(data.matches[0].markets).toHaveLength(4);

    for (const market of data.matches[0].markets) {
      expect(market.yes.label).toBe("Yes");
      expect(market.no.label).toBe("No");
      expect(market.yes.hitRate).toBeGreaterThan(0);
      expect(market.no.hitRate).toBeGreaterThan(0);
      expect(market.yes.fairOdds).toBeGreaterThan(1);
      expect(market.no.fairOdds).toBeGreaterThan(1);
      expect(market.yes.odds1xBet).toBeGreaterThan(1);
      expect(market.no.odds1xBet).toBeGreaterThan(1);
      expect(["HIGH", "MEDIUM", "LOW"]).toContain(market.yes.confidence);
      expect(["HIGH", "MEDIUM", "LOW"]).toContain(market.no.confidence);
      expect(typeof market.isGuaranteed).toBe("boolean");
      expect(market.statsSource).toBeTruthy();
    }

    const penalty = data.matches[0].markets.find((market) => market.key === "penalty");
    expect(penalty?.isGuaranteed).toBe(true);
    expect(penalty?.no.hitRate).toBeGreaterThanOrEqual(0.95);
  });

  it("annotates every market with data quality, a confidence score and source detail", async () => {
    const fixture = makeMockFixture("fx-quality", "Arsenal", "Chelsea");
    vi.mocked(espn.fetchScoreboard).mockImplementation(async (slug) => {
      if (slug === "eng.1") return [fixture];
      return [];
    });

    // Single-source payload (only metadata.source, no multi-source list).
    vi.mocked(statsAggregator.fetch).mockResolvedValue({
      home: {
        ...emptyTeamStats(),
        xg: 1.8,
        avgCornersPerGame: 6.2,
        avgCardsPerGame: 1.9,
        fouls: 11,
      },
      away: {
        ...emptyTeamStats(),
        xg: 1.4,
        avgCornersPerGame: 4.8,
        avgCardsPerGame: 2.1,
        fouls: 12,
      },
      metadata: {
        source: "SportScore",
        fetchedAt: new Date().toISOString(),
        matchDate: fixture.date.slice(0, 10),
        leagueSlug: "eng.1",
      },
    });

    const res = await GET(new Request("http://localhost/api/first-5-minutes?refresh=true"));
    const data = (await res.json()) as First5MinutesResponse;
    const markets = data.matches[0].markets;

    for (const market of markets) {
      expect(["real", "mixed", "synthetic"]).toContain(market.dataQuality);
      expect(market.confidenceScore).toBeGreaterThanOrEqual(0);
      expect(market.confidenceScore).toBeLessThanOrEqual(100);
      expect(market.confidenceScore).toBe(
        market.confidenceBreakdown.dataQualityPoints +
          market.confidenceBreakdown.sourceAgreementPoints +
          market.confidenceBreakdown.completenessPoints,
      );
    }

    const goal = markets.find((market) => market.key === "goal");
    // real (40) + 1 source (15) + all stats present (30) = 85
    expect(goal?.dataQuality).toBe("real");
    expect(goal?.dataSourceDetail).toBe("SportScore (Real)");
    expect(goal?.confidenceScore).toBe(85);

    // The penalty baseline always falls back to the league anchor here, so the
    // market must be flagged synthetic and score far below the real markets —
    // even though its own hit rate is ≥95%.
    const penalty = markets.find((market) => market.key === "penalty");
    expect(penalty?.dataQuality).toBe("synthetic");
    expect(penalty?.dataSourceDetail).toBe("Synthetic Baseline (League Avg)");
    expect(penalty?.confidenceScore).toBeLessThan(40);
    expect(penalty?.hitRate).toBeGreaterThanOrEqual(0.9);
  });

  it("raises the score when multiple aggregator sources agree", async () => {
    const fixture = makeMockFixture("fx-multi", "Arsenal", "Chelsea");
    vi.mocked(espn.fetchScoreboard).mockImplementation(async (slug) => {
      if (slug === "eng.1") return [fixture];
      return [];
    });

    vi.mocked(statsAggregator.fetch).mockResolvedValue({
      home: {
        ...emptyTeamStats(),
        xg: 1.8,
        avgCornersPerGame: 6.2,
        avgCardsPerGame: 1.9,
        fouls: 11,
      },
      away: {
        ...emptyTeamStats(),
        xg: 1.4,
        avgCornersPerGame: 4.8,
        avgCardsPerGame: 2.1,
        fouls: 12,
      },
      metadata: {
        source: "SportScore",
        sources: ["SportScore", "API-Football", "FBref"],
        fetchedAt: new Date().toISOString(),
        matchDate: fixture.date.slice(0, 10),
        leagueSlug: "eng.1",
      },
    });

    const res = await GET(new Request("http://localhost/api/first-5-minutes?refresh=true"));
    const data = (await res.json()) as First5MinutesResponse;
    const goal = data.matches[0].markets.find((market) => market.key === "goal");

    // real (40) + 3 sources agree (30) + all stats present (30) = 100
    expect(goal?.dataQuality).toBe("real");
    expect(goal?.dataSourceDetail).toBe("SportScore + API-Football + FBref (Real)");
    expect(goal?.confidenceScore).toBe(100);
    expect(goal?.confidenceBreakdown.sourceCount).toBe(3);
  });

  it("labels one-sided stats as mixed with the + Synthetic detail suffix", async () => {
    const fixture = makeMockFixture("fx-partial", "Arsenal", "Chelsea");
    vi.mocked(espn.fetchScoreboard).mockImplementation(async (slug) => {
      if (slug === "eng.1") return [fixture];
      return [];
    });

    // Away xG is missing: the goal baseline mirrors the home side only →
    // "mixed" tier, while the corner/card markets stay "real".
    vi.mocked(statsAggregator.fetch).mockResolvedValue({
      home: {
        ...emptyTeamStats(),
        xg: 1.8,
        avgCornersPerGame: 6.2,
        avgCardsPerGame: 1.9,
      },
      away: {
        ...emptyTeamStats(),
        avgCornersPerGame: 4.8,
        avgCardsPerGame: 2.1,
      },
      metadata: {
        source: "SportScore",
        sources: ["SportScore", "API-Football"],
        fetchedAt: new Date().toISOString(),
        matchDate: fixture.date.slice(0, 10),
        leagueSlug: "eng.1",
      },
    });

    const res = await GET(new Request("http://localhost/api/first-5-minutes?refresh=true"));
    const data = (await res.json()) as First5MinutesResponse;
    const goal = data.matches[0].markets.find((market) => market.key === "goal");
    const corner = data.matches[0].markets.find((market) => market.key === "corner");

    expect(goal?.dataQuality).toBe("mixed");
    expect(goal?.dataSourceDetail).toBe("SportScore + API-Football (Real) + Synthetic");
    expect(goal?.confidenceScore).toBeLessThan(100);
    expect(corner?.dataQuality).toBe("real");
  });

  it("falls back to Synthetic Baseline when the aggregator returns null", async () => {
    const fixture = makeMockFixture("fx-2", "Everton", "Brentford");
    vi.mocked(espn.fetchScoreboard).mockImplementation(async (slug) => {
      if (slug === "eng.1") return [fixture];
      return [];
    });
    vi.mocked(statsAggregator.fetch).mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/api/first-5-minutes?refresh=true"));
    const data = (await res.json()) as First5MinutesResponse;
    expect(data.matches[0].statsSource).toBe(SYNTHETIC_BASELINE);
    expect(data.matches[0].markets.every((market) => market.statsSource === SYNTHETIC_BASELINE)).toBe(true);
    expect(data.matches[0].markets.every((market) => market.origin === "league")).toBe(true);

    // Every synthetic market carries the grey-badge label and a low score.
    for (const market of data.matches[0].markets) {
      expect(market.dataQuality).toBe("synthetic");
      expect(market.dataSourceDetail).toBe("Synthetic Baseline (League Avg)");
      expect(market.confidenceScore).toBeLessThanOrEqual(40);
    }
    // A ≥90% hit rate on synthetic data is exactly the trap the badge flags:
    // high hit rate, low confidence.
    const highHit = data.matches[0].markets.filter((market) => market.hitRate >= 0.9);
    expect(highHit.length).toBeGreaterThan(0);
    for (const market of highHit) {
      expect(market.dataQuality).toBe("synthetic");
      expect(market.confidenceScore).toBeLessThan(50);
    }
  });
});
