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
  });
});
