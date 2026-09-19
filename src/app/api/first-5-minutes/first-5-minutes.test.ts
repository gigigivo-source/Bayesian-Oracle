import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET,
  atLeastOne,
  bookOddsFor,
  confidenceFor,
  fairOddsFor,
  round1xBetOdds,
  type First5MinutesResponse,
} from "./route";
import * as espn from "@/lib/espn";
import { getCachedMeshProfile } from "@/lib/engine/dataMesh";
import type { MeshProfile } from "@/lib/engine/dataMesh";
import { fetchEventDetail, fetchTeamXgAverage } from "@/lib/va/xgFetcher";
import { resolveBzzoiroEvent } from "@/lib/va/oddsFetcher";

vi.mock("@/lib/espn", async () => {
  const actual = await vi.importActual<typeof import("@/lib/espn")>("@/lib/espn");
  return {
    ...actual,
    fetchScoreboard: vi.fn(),
    fetchSummary: vi.fn(),
  };
});

vi.mock("@/lib/engine/dataMesh", () => ({
  getCachedMeshProfile: vi.fn(),
}));

vi.mock("@/lib/va/xgFetcher", () => ({
  fetchTeamXgAverage: vi.fn(),
  fetchEventDetail: vi.fn(),
}));

vi.mock("@/lib/va/oddsFetcher", () => ({
  resolveBzzoiroEvent: vi.fn(),
}));

// ─── Mock builders (no network) ───────────────────────────────────────────────

function makeMockTeam(id: string, name: string, homeAway: "home" | "away"): espn.TeamLite {
  return {
    id,
    name,
    shortName: name,
    abbrev: name.slice(0, 3).toUpperCase(),
    logo: null,
    color: "000000",
    score: null,
    homeAway,
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
    home: makeMockTeam("1", homeName, "home"),
    away: makeMockTeam("2", awayName, "away"),
  };
}

function dist(mean: number, n: number) {
  return { mean, std: mean * 0.3, n };
}

function makeMeshProfile(opts: {
  corners?: number;
  cards?: number;
  fouls?: number;
  samples?: number;
}): MeshProfile {
  const n = opts.samples ?? 8;
  const zero = dist(0, 0);
  return {
    teamId: "1",
    samples: n,
    shots: dist(13, n),
    sot: dist(4.5, n),
    corners: opts.corners == null ? zero : dist(opts.corners, n),
    cards: opts.cards == null ? zero : dist(opts.cards, n),
    fouls: opts.fouls == null ? zero : dist(opts.fouls, n),
    offsides: dist(2, n),
    saves: dist(3, n),
    possession: dist(52, n),
    passes: dist(480, n),
    passAccuracy: dist(82, n),
    crosses: dist(18, n),
    longBalls: dist(55, n),
    tackles: dist(16, n),
    clearances: dist(20, n),
    interceptions: dist(10, n),
    blockedShots: dist(4, n),
    providers: ["ESPN Boxscore"],
    providerCount: 1,
  };
}

function makeForm(gfAvg: number, games: number): espn.MatchSummary["homeForm"] {
  return {
    teamId: "1",
    teamName: "Team",
    games: Array.from({ length: games }, (_, i) => ({
      date: `2026-09-${String(10 + i).padStart(2, "0")}`,
      opponent: "Opponent",
      opponentLogo: null,
      result: "W",
      scoreFor: 2,
      scoreAgainst: 1,
      atVs: "vs",
      competition: "League",
    })),
    gfAvg,
    gaAvg: 1,
    points: games * 3,
  };
}

function makeSummary(homeGf: number, awayGf: number, games = 5): espn.MatchSummary {
  return {
    odds: null,
    homeForm: makeForm(homeGf, games),
    awayForm: makeForm(awayGf, games),
    h2h: [],
    homeLineup: [],
    awayLineup: [],
    lineupAvailable: false,
    homeFormation: null,
    awayFormation: null,
    venue: null,
    boxscore: null,
  };
}

function mockScoreboard(fixtures: espn.FixtureLite[]) {
  vi.mocked(espn.fetchScoreboard).mockImplementation(async (slug) => {
    if (slug === "eng.1") return fixtures;
    return [];
  });
}

function mockBzzoiroChain(homeXg: number | null, awayXg: number | null) {
  vi.mocked(resolveBzzoiroEvent).mockResolvedValue({
    eventId: "555",
    status: "resolved",
    eventsInRange: 1,
    relatedInRange: 1,
    toleranceDays: 2,
  });
  vi.mocked(fetchEventDetail).mockResolvedValue({ homeTeamId: 101, awayTeamId: 202 });
  vi.mocked(fetchTeamXgAverage).mockImplementation(async (teamId: number) => {
    if (teamId === 101) {
      return homeXg == null
        ? null
        : { teamId, xgFor: homeXg, xgAgainst: 1.1, samples: 5 };
    }
    if (teamId === 202) {
      return awayXg == null
        ? null
        : { teamId, xgFor: awayXg, xgAgainst: 1.2, samples: 5 };
    }
    return null;
  });
}

function mockMesh(home: MeshProfile | null, away: MeshProfile | null) {
  vi.mocked(getCachedMeshProfile).mockImplementation(async (teamName: string) => {
    if (teamName === "Arsenal" || teamName === "Everton" || teamName === "Leeds") return home;
    return away;
  });
}

async function getFirst5(url = "http://localhost/api/first-5-minutes?refresh=true") {
  const res = await GET(new Request(url));
  expect(res.status).toBe(200);
  return (await res.json()) as First5MinutesResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no Bzzoiro, no ESPN form — each test opts into its data.
  vi.mocked(resolveBzzoiroEvent).mockResolvedValue({
    eventId: null,
    status: "no-match",
    eventsInRange: 0,
    relatedInRange: 0,
    toleranceDays: 5,
  });
  vi.mocked(fetchEventDetail).mockResolvedValue(null);
  vi.mocked(fetchTeamXgAverage).mockResolvedValue(null);
  vi.mocked(getCachedMeshProfile).mockResolvedValue(null);
  vi.mocked(espn.fetchSummary).mockResolvedValue(null);
});

// ─── Model helpers (unchanged math) ───────────────────────────────────────────

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
});

// ─── Real-data publishing ────────────────────────────────────────────────────

describe("First 5 Minutes API (real-data-only)", () => {
  it("publishes goal, corner and card from real mesh + Bzzoiro xG — and no penalty", async () => {
    mockScoreboard([makeMockFixture("fx-1", "Arsenal", "Chelsea")]);
    mockBzzoiroChain(1.8, 1.4);
    mockMesh(
      makeMeshProfile({ corners: 6.2, cards: 1.9, fouls: 11 }),
      makeMeshProfile({ corners: 4.8, cards: 2.1, fouls: 12 }),
    );

    const data = await getFirst5();
    expect(data.matches).toHaveLength(1);
    const match = data.matches[0];
    expect(match.markets.map((m) => m.key).sort()).toEqual(["card", "corner", "goal"]);
    expect(match.markets.some((m) => m.key === ("penalty" as string))).toBe(false);

    const goal = match.markets.find((m) => m.key === "goal");
    // Bzzoiro xG 1.8 + 1.4 = 3.2 combined expected goals.
    expect(goal?.expectedPerMatch).toBeCloseTo(3.2, 2);
    expect(goal?.statsSource).toBe("Bzzoiro xG");
    expect(goal?.dataQuality).toBe("real");

    const corner = match.markets.find((m) => m.key === "corner");
    expect(corner?.expectedPerMatch).toBeCloseTo(11.0, 2);
    expect(corner?.statsSource).toBe("ESPN Mesh");

    const card = match.markets.find((m) => m.key === "card");
    expect(card?.expectedPerMatch).toBeCloseTo(4.0, 2);
    expect(card?.statsSource).toBe("ESPN Mesh");

    // Dual-outcome shape intact on every published market.
    for (const market of match.markets) {
      expect(market.yes.label).toBe("Yes");
      expect(market.no.label).toBe("No");
      expect(market.yes.hitRate).toBeGreaterThan(0);
      expect(market.no.hitRate).toBeGreaterThan(0);
      expect(market.yes.odds1xBet).toBeGreaterThan(1);
      expect(market.no.odds1xBet).toBeGreaterThan(1);
      expect(typeof market.isGuaranteed).toBe("boolean");
    }
  });

  it("omits corner/card when home mesh is null but still publishes goal from xG", async () => {
    mockScoreboard([makeMockFixture("fx-2", "Arsenal", "Chelsea")]);
    mockBzzoiroChain(1.8, 1.4);
    mockMesh(null, makeMeshProfile({ corners: 4.8, cards: 2.1, fouls: 12 }));

    const data = await getFirst5();
    expect(data.matches).toHaveLength(1);
    const keys = data.matches[0].markets.map((m) => m.key);
    // Only one side has mesh data → corner and card omitted; xG covers goal.
    expect(keys).toEqual(["goal"]);
  });

  it("publishes goal from ESPN form gfAvg when Bzzoiro xG is null", async () => {
    mockScoreboard([makeMockFixture("fx-3", "Arsenal", "Chelsea")]);
    // Bzzoiro chain resolves nothing (defaults from beforeEach).
    mockMesh(
      makeMeshProfile({ corners: 6.2, cards: 1.9, fouls: 11 }),
      makeMeshProfile({ corners: 4.8, cards: 2.1, fouls: 12 }),
    );
    vi.mocked(espn.fetchSummary).mockResolvedValue(makeSummary(2.0, 1.2));

    const data = await getFirst5();
    const goal = data.matches[0].markets.find((m) => m.key === "goal");
    expect(goal).toBeDefined();
    // ESPN form 2.0 + 1.2 = 3.2 combined.
    expect(goal?.expectedPerMatch).toBeCloseTo(3.2, 2);
    expect(goal?.statsSource).toBe("ESPN Form");
    expect(goal?.dataQuality).toBe("real");
  });

  it("omits the goal market when both xG and ESPN form are null", async () => {
    mockScoreboard([makeMockFixture("fx-4", "Arsenal", "Chelsea")]);
    mockMesh(
      makeMeshProfile({ corners: 6.2, cards: 1.9, fouls: 11 }),
      makeMeshProfile({ corners: 4.8, cards: 2.1, fouls: 12 }),
    );
    // fetchSummary stays null (beforeEach default).

    const data = await getFirst5();
    expect(data.matches).toHaveLength(1);
    const keys = data.matches[0].markets.map((m) => m.key).sort();
    expect(keys).toEqual(["card", "corner"]);
  });

  it("publishes zero markets for a fixture with no real data at all", async () => {
    mockScoreboard([makeMockFixture("fx-5", "Everton", "Brentford")]);
    // All providers null (beforeEach defaults).

    const data = await getFirst5();
    expect(data.totalFixturesChecked).toBe(1);
    expect(data.totalMatches).toBe(0);
    expect(data.matches).toHaveLength(0);
  });

  it("publishes nothing — not hash-jittered numbers — for two dataless fixtures", async () => {
    mockScoreboard([
      makeMockFixture("fx-6", "Everton", "Brentford"),
      makeMockFixture("fx-7", "Leeds", "Sunderland"),
    ]);

    const data = await getFirst5();
    expect(data.totalFixturesChecked).toBe(2);
    expect(data.totalMatches).toBe(0);
    expect(data.matches).toHaveLength(0);
    // No markets anywhere means no values at all — synthetic or otherwise.
    const allMarkets = data.matches.flatMap((m) => m.markets);
    expect(allMarkets).toHaveLength(0);
  });
});
