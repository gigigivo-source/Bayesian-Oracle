import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET,
  atLeastOne,
  bookOddsFor,
  confidenceFor,
  fairOddsFor,
  getTeamXgCached,
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

// ─── Database mock ────────────────────────────────────────────────────────────
// The route's cache helpers read/write first5_cache AND team_xg_cache through
// drizzle. Read order for the scan response is: DB row (24h) → in-memory (1h)
// → full scan. The mock is the same "rows + a write log" shape used by the
// Value Accumulator tests: the single 'default' cache row is set per test and
// every UPSERT lands in `writes`, so cache HIT / WRITE / fail-soft behaviour
// can be asserted directly. team_xg_cache gets its own row map and write log
// (keyed / filtered by team id, like the table's primary key) so the two
// caches can never be confused for one another.
const dbState = vi.hoisted(() => {
  /**
   * Pull the team id out of a drizzle `eq(team_id, <id>)` expression so the
   * team_xg_cache mock filters like a real WHERE clause instead of returning
   * every row. With a real column drizzle binds the value as a `Param` chunk
   * (the only chunk carrying both `brand` and `value`); with this file's
   * stubbed column it inlines the literal instead, so a raw number chunk is
   * accepted too.
   */
  function teamIdFromWhere(expr: unknown): number {
    const chunks = (expr as { queryChunks?: unknown[] } | null)?.queryChunks;
    if (!Array.isArray(chunks)) return NaN;
    for (const chunk of chunks) {
      if (typeof chunk === "number") return chunk;
      const candidate = chunk as { brand?: unknown; value?: unknown } | null;
      if (typeof candidate === "object" && candidate !== null && "brand" in candidate && "value" in candidate) {
        return Number(candidate.value);
      }
    }
    return NaN;
  }

  return {
    cacheRows: new Map<string, Record<string, unknown>>(),
    writes: [] as Array<Record<string, unknown>>,
    readError: null as Error | null,
    writeError: null as Error | null,
    /** team_xg_cache rows, keyed by team id. */
    teamXgRows: new Map<number, Record<string, unknown>>(),
    xgWrites: [] as Array<Record<string, unknown>>,
    xgReadError: null as Error | null,
    xgWriteError: null as Error | null,
    teamIdFromWhere,
  };
});

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: (table?: { __table?: string }) => ({
        where: (expr?: unknown) => ({
          limit: async () => {
            if (table?.__table === "team_xg_cache") {
              if (dbState.xgReadError) throw dbState.xgReadError;
              const row = dbState.teamXgRows.get(dbState.teamIdFromWhere(expr));
              return row ? [row] : [];
            }
            if (dbState.readError) throw dbState.readError;
            return Array.from(dbState.cacheRows.values());
          },
        }),
      }),
    }),
    insert: (table?: { __table?: string }) => ({
      values: (row: Record<string, unknown>) => {
        const result = Promise.resolve([]) as unknown as Promise<unknown[]> & {
          onConflictDoUpdate: () => Promise<unknown[]>;
        };
        if (table?.__table === "team_xg_cache") {
          dbState.xgWrites.push(row);
          result.onConflictDoUpdate = () => {
            if (dbState.xgWriteError) return Promise.reject(dbState.xgWriteError);
            // Emulate the UPSERT so a later read in the same test sees the row.
            dbState.teamXgRows.set(Number(row.teamId), row);
            return Promise.resolve([]);
          };
          return result;
        }
        dbState.writes.push(row);
        result.onConflictDoUpdate = () => {
          if (dbState.writeError) return Promise.reject(dbState.writeError);
          return Promise.resolve([]);
        };
        return result;
      },
    }),
  },
  keepDbAlive: async () => undefined,
}));

vi.mock("@/db/schema", () => ({
  first5Cache: { __table: "first5_cache", cacheKey: "cache_key" },
  teamXgCache: { __table: "team_xg_cache", teamId: "team_id" },
  // performanceLog is only used by the fail-soft pick-persistence step; the
  // cache tests never persist a published market so a stub shape is enough.
  performanceLog: {
    __table: "performance_log",
    id: "id",
    eventId: "event_id",
    feature: "feature",
    market: "market",
    selection: "selection",
  },
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

function makeMockFixture(
  id: string,
  homeName: string,
  awayName: string,
  league?: { slug: string; name: string },
): espn.FixtureLite {
  return {
    id,
    date: new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString(),
    state: "pre",
    statusDetail: "Scheduled",
    venue: "Stadium",
    neutralSite: false,
    leagueSlug: league?.slug ?? "eng.1",
    leagueName: league?.name ?? "English Premier League",
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
  dbState.cacheRows.clear();
  dbState.writes.length = 0;
  dbState.readError = null;
  dbState.writeError = null;
  dbState.teamXgRows.clear();
  dbState.xgWrites.length = 0;
  dbState.xgReadError = null;
  dbState.xgWriteError = null;
  // No test in this file may reach the network. Every provider is mocked, but
  // the route's Bzzoiro date lookups (team xG cache) go through global fetch,
  // so it is stubbed to an empty page: a stray call is inert and provably
  // never a real request.
  process.env.BZOOIRO_KEY = "test-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ count: 0, next: null, results: [] }), { status: 200 }),
    ),
  );
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

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BZOOIRO_KEY;
});

/**
 * Seed the DB cache row that readDbCache() will observe. `expiresAt` is an
 * ISO timestamp; use a future date for a valid row, a past date for an
 * expired one.
 */
function seedDbCacheRow(expiresAt: Date, responseJson: unknown = { seeded: true }) {
  dbState.cacheRows.set("default", {
    id: 1,
    cacheKey: "default",
    responseJson,
    generatedAt: new Date(Date.now() - 60 * 60 * 1000),
    expiresAt,
  });
}

/** Build the response body a full scan would have produced (one fixture, one goal market). */
function buildScannedBody(): First5MinutesResponse {
  return {
    generatedAt: new Date().toISOString(),
    windowMinutes: 5,
    lookaheadDays: 7,
    totalFixturesChecked: 1,
    totalMatches: 1,
    marketTypes: [{ key: "goal", label: "Goal in First 5 Minutes", icon: "⚽" }],
    model: {
      description: "test",
      matchMinutes: 96,
      openingIntensity: { goal: 0.45, corner: 0.78, card: 0.25 },
    },
    cache: { ttlMinutes: 60, hit: false },
    matches: [
      {
        fixtureId: "fx-scan",
        homeTeam: "Arsenal",
        awayTeam: "Chelsea",
        homeLogo: null,
        awayLogo: null,
        league: "English Premier League",
        leagueSlug: "eng.1",
        leagueTier: 1,
        date: new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString(),
        venue: "Stadium",
        statsSource: "Bzzoiro xG",
        markets: [],
      },
    ],
  };
}

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

// ─── DB-backed cache (24h TTL, survives restarts) ─────────────────────────────
describe("First 5 Minutes DB-backed cache", () => {
  // Each test uses a distinct extra query param so the route's module-level
  // in-memory cache (1h TTL, keyed on the URL) from one test can never leak
  // into the next. The DB cache key is always 'default', independent of URL.
  const suite = Date.now().toString(36);
  const urlFor = (name: string) =>
    `http://localhost/api/first-5-minutes?cache-suite=${suite}-${name}`;

  it("serves a valid DB cache row with ZERO fetcher calls", async () => {
    seedDbCacheRow(
      new Date(Date.now() + 60 * 60 * 1000),
      buildScannedBody() satisfies First5MinutesResponse,
    );

    const data = await getFirst5(urlFor("hit"));

    expect(data.cache.hit).toBe(true);
    expect(data.totalFixturesChecked).toBe(1);
    expect(data.matches[0].fixtureId).toBe("fx-scan");

    // The scan never ran: no scoreboard, mesh, Bzzoiro or summary fetches.
    expect(espn.fetchScoreboard).not.toHaveBeenCalled();
    expect(getCachedMeshProfile).not.toHaveBeenCalled();
    expect(resolveBzzoiroEvent).not.toHaveBeenCalled();
    expect(fetchEventDetail).not.toHaveBeenCalled();
    expect(fetchTeamXgAverage).not.toHaveBeenCalled();
    expect(espn.fetchSummary).not.toHaveBeenCalled();

    // A HIT served from the DB row never rewrites the cache.
    expect(dbState.writes).toHaveLength(0);
  });

  it("runs a fresh scan when the DB row is expired and writes a 24h expiry", async () => {
    seedDbCacheRow(new Date(Date.now() - 60 * 60 * 1000));
    mockScoreboard([makeMockFixture("fx-stale", "Arsenal", "Chelsea")]);
    vi.mocked(getCachedMeshProfile)
      .mockResolvedValueOnce(null) // Arsenal
      .mockResolvedValueOnce(null); // Chelsea

    const before = Date.now();
    const data = await getFirst5(urlFor("expired"));

    expect(data.cache.hit).toBe(false);
    // The scan ran over the single fixture: one mesh profile per team.
    expect(getCachedMeshProfile).toHaveBeenCalledTimes(2);
    expect(dbState.writes).toHaveLength(1);

    const written = dbState.writes[0];
    expect(written.cacheKey).toBe("default");
    const writtenBody = written.responseJson as First5MinutesResponse;
    expect(writtenBody.totalFixturesChecked).toBe(1);
    const writtenExpiry = new Date(written.expiresAt as string).getTime();
    expect(writtenExpiry).toBeGreaterThan(before + 23 * 60 * 60 * 1000);
  });

  it("?refresh=true bypasses a valid DB cache row and runs a fresh scan", async () => {
    seedDbCacheRow(
      new Date(Date.now() + 60 * 60 * 1000),
      buildScannedBody() satisfies First5MinutesResponse,
    );
    mockScoreboard([makeMockFixture("fx-fresh", "Arsenal", "Chelsea")]);
    vi.mocked(getCachedMeshProfile)
      .mockResolvedValueOnce(null) // Arsenal
      .mockResolvedValueOnce(null); // Chelsea

    const data = await getFirst5(`${urlFor("refresh")}&refresh=true`);

    expect(data.cache.hit).toBe(false);
    expect(getCachedMeshProfile).toHaveBeenCalledTimes(2);
    // The forced scan still refreshes both cache layers.
    expect(dbState.writes).toHaveLength(1);
    expect(dbState.writes[0].cacheKey).toBe("default");
  });

  it("falls through to a fresh scan when the DB read throws", async () => {
    dbState.readError = new Error("connection refused");
    mockScoreboard([makeMockFixture("fx-readfail", "Arsenal", "Chelsea")]);
    vi.mocked(getCachedMeshProfile)
      .mockResolvedValueOnce(null) // Arsenal
      .mockResolvedValueOnce(null); // Chelsea

    const data = await getFirst5(urlFor("readfail"));

    expect(data.cache.hit).toBe(false);
    expect(getCachedMeshProfile).toHaveBeenCalledTimes(2);
  });

  it("still returns the response when the DB write throws", async () => {
    dbState.writeError = new Error("disk full");
    mockScoreboard([makeMockFixture("fx-writefail", "Arsenal", "Chelsea")]);
    vi.mocked(getCachedMeshProfile)
      .mockResolvedValueOnce(null) // Arsenal
      .mockResolvedValueOnce(null); // Chelsea

    const data = await getFirst5(urlFor("writefail"));

    expect(data.cache.hit).toBe(false);
    // The scan still completed and the response was returned.
    expect(data.totalFixturesChecked).toBe(1);
    expect(espn.fetchScoreboard).toHaveBeenCalled();
  });
});

// ─── League whitelist (top-5 + domestic cups + UEFA) ─────────────────────────
// getFirst5() defaults to ?refresh=true, so every scan below bypasses both
// cache layers and hits the (mocked) scoreboards directly — no network.

describe("First 5 Minutes league whitelist", () => {
  it("excludes a fixture from a non-whitelisted league (eng.2 is never fetched)", async () => {
    const championshipFixture = makeMockFixture("fx-eng2", "Leeds", "Sunderland", {
      slug: "eng.2",
      name: "English Championship",
    });
    // The mocked ESPN response contains a Championship fixture — but only
    // behind the eng.2 scoreboard, which the whitelist must never request.
    vi.mocked(espn.fetchScoreboard).mockImplementation(async (slug) => {
      if (slug === "eng.2") return [championshipFixture];
      return [];
    });

    const data = await getFirst5();

    expect(data.matches.map((m) => m.fixtureId)).not.toContain("fx-eng2");
    // Whitelist proof: the unwanted league's scoreboard is never requested.
    expect(espn.fetchScoreboard).not.toHaveBeenCalledWith("eng.2", expect.anything());
    // ...while the whitelisted leagues still are.
    expect(espn.fetchScoreboard).toHaveBeenCalledWith("eng.1", expect.anything());
    expect(espn.fetchScoreboard).toHaveBeenCalledWith("uefa.champions", expect.anything());
  });

  it("includes a fixture from a whitelisted top-5 league (eng.1)", async () => {
    mockScoreboard([makeMockFixture("fx-eng1", "Arsenal", "Chelsea")]);
    mockBzzoiroChain(1.8, 1.4);
    mockMesh(
      makeMeshProfile({ corners: 6.2, cards: 1.9, fouls: 11 }),
      makeMeshProfile({ corners: 4.8, cards: 2.1, fouls: 12 }),
    );

    const data = await getFirst5();

    expect(data.matches.map((m) => m.fixtureId)).toContain("fx-eng1");
    const match = data.matches.find((m) => m.fixtureId === "fx-eng1");
    expect(match?.leagueSlug).toBe("eng.1");
    expect(match?.markets.length).toBeGreaterThan(0);
  });

  it("includes a UEFA Champions League fixture (uefa.champions)", async () => {
    const uclFixture = makeMockFixture("fx-ucl", "Real Madrid", "Bayern Munich", {
      slug: "uefa.champions",
      name: "UEFA Champions League",
    });
    vi.mocked(espn.fetchScoreboard).mockImplementation(async (slug) => {
      if (slug === "uefa.champions") return [uclFixture];
      return [];
    });
    mockBzzoiroChain(2.0, 1.7);
    mockMesh(
      makeMeshProfile({ corners: 5.5, cards: 1.6, fouls: 10 }),
      makeMeshProfile({ corners: 5.1, cards: 1.8, fouls: 11 }),
    );

    const data = await getFirst5();

    expect(data.matches.map((m) => m.fixtureId)).toContain("fx-ucl");
    const match = data.matches.find((m) => m.fixtureId === "fx-ucl");
    expect(match?.leagueSlug).toBe("uefa.champions");
    expect(match?.markets.length).toBeGreaterThan(0);
  });
});

// ─── Persistent team xG cache (invalidated when the team plays again) ─────────
// The rolling Bzzoiro average is the expensive part of a scan (~6 HTTP calls
// per team), so it is persisted in team_xg_cache and reused until the team's
// next scheduled match kicks off — never invalidated on a timer. Every
// provider is mocked here: the xG fetcher itself is a mock (and is asserted
// on) and the cache's two Bzzoiro date lookups go through the stubbed global
// fetch. Nothing in this block touches the network.
describe("First 5 Minutes team xG cache", () => {
  const HOME_TEAM = 101;
  const AWAY_TEAM = 202;
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  /**
   * Seed a team_xg_cache row exactly as the pg driver would deliver it:
   * numeric columns as strings, timestamps as Dates.
   */
  function seedTeamXgRow(
    teamId: number,
    opts: {
      xgFor?: number;
      xgAgainst?: number;
      samples?: number;
      nextMatchAt?: Date | null;
      basedOnThroughAt?: Date;
    } = {},
  ) {
    dbState.teamXgRows.set(teamId, {
      teamId,
      xgFor: String(opts.xgFor ?? 1.8),
      xgAgainst: String(opts.xgAgainst ?? 1.1),
      samples: opts.samples ?? 5,
      basedOnThroughAt: opts.basedOnThroughAt ?? new Date(Date.now() - 7 * DAY_MS),
      nextMatchAt: opts.nextMatchAt ?? null,
      updatedAt: new Date(Date.now() - DAY_MS),
    });
  }

  /** Stub the two Bzzoiro team-event lookups the cache performs on a miss. */
  function stubTeamEventDates(dates: { next?: string; lastFinished?: string }) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const rows = url.includes("status=notstarted")
        ? dates.next
          ? [{ id: 9001, event_date: dates.next }]
          : []
        : dates.lastFinished
          ? [{ id: 9002, event_date: dates.lastFinished }]
          : [];
      return new Response(JSON.stringify({ count: rows.length, next: null, results: rows }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  // ── 1. HIT ──────────────────────────────────────────────────────────────────
  it("treats a row whose next match is in the future as a HIT and never calls the xG fetcher", async () => {
    seedTeamXgRow(HOME_TEAM, {
      xgFor: 1.75,
      xgAgainst: 0.9,
      samples: 5,
      nextMatchAt: new Date(Date.now() + 6 * HOUR_MS),
    });
    const fetchMock = stubTeamEventDates({});

    const value = await getTeamXgCached(HOME_TEAM);

    expect(value).toEqual({ xgFor: 1.75, xgAgainst: 0.9, samples: 5 });
    expect(fetchTeamXgAverage).not.toHaveBeenCalled();
    // Zero Bzzoiro traffic: not even the date lookups run on a hit.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbState.xgWrites).toHaveLength(0);
  });

  // ── 2. MISS (no row / expired row) ──────────────────────────────────────────
  it("treats a missing row as a MISS and calls the xG fetcher", async () => {
    const fetchMock = stubTeamEventDates({});
    vi.mocked(fetchTeamXgAverage).mockResolvedValue({
      teamId: HOME_TEAM,
      xgFor: 1.6,
      xgAgainst: 1.2,
      samples: 5,
    });

    const value = await getTeamXgCached(HOME_TEAM);

    expect(fetchTeamXgAverage).toHaveBeenCalledWith(HOME_TEAM, 5);
    expect(value).toEqual({ xgFor: 1.6, xgAgainst: 1.2, samples: 5 });
    // Both Bzzoiro date lookups ran (next match + newest finished match).
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`team_id=${HOME_TEAM}&status=notstarted&limit=1`),
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`team_id=${HOME_TEAM}&status=finished&limit=5`),
      expect.anything(),
    );
  });

  it("treats a row whose next match is already in the past as a MISS", async () => {
    seedTeamXgRow(HOME_TEAM, { nextMatchAt: new Date(Date.now() - 2 * HOUR_MS) });
    stubTeamEventDates({});
    vi.mocked(fetchTeamXgAverage).mockResolvedValue({
      teamId: HOME_TEAM,
      xgFor: 2.2,
      xgAgainst: 0.8,
      samples: 5,
    });

    const value = await getTeamXgCached(HOME_TEAM);

    expect(fetchTeamXgAverage).toHaveBeenCalledWith(HOME_TEAM, 5);
    expect(value).toEqual({ xgFor: 2.2, xgAgainst: 0.8, samples: 5 });
  });

  it("treats a row with no next match date as a MISS (never a timed cache)", async () => {
    seedTeamXgRow(HOME_TEAM, { nextMatchAt: null });
    stubTeamEventDates({});
    vi.mocked(fetchTeamXgAverage).mockResolvedValue({
      teamId: HOME_TEAM,
      xgFor: 1.3,
      xgAgainst: 1.4,
      samples: 4,
    });

    await getTeamXgCached(HOME_TEAM);

    expect(fetchTeamXgAverage).toHaveBeenCalledTimes(1);
  });

  // ── 3. UPSERT after a miss ──────────────────────────────────────────────────
  it("UPSERTs the average with the resolved next_match_at after a miss", async () => {
    const nextKickoff = new Date(Date.now() + 3 * DAY_MS);
    const lastFinished = new Date(Date.now() - 5 * DAY_MS);
    stubTeamEventDates({
      next: nextKickoff.toISOString(),
      lastFinished: lastFinished.toISOString(),
    });
    vi.mocked(fetchTeamXgAverage).mockResolvedValue({
      teamId: HOME_TEAM,
      xgFor: 1.9,
      xgAgainst: 1.05,
      samples: 5,
    });

    const value = await getTeamXgCached(HOME_TEAM);

    expect(value).toEqual({ xgFor: 1.9, xgAgainst: 1.05, samples: 5 });
    expect(dbState.xgWrites).toHaveLength(1);
    const written = dbState.xgWrites[0];
    expect(written.teamId).toBe(HOME_TEAM);
    expect(Number(written.xgFor)).toBeCloseTo(1.9, 5);
    expect(Number(written.xgAgainst)).toBeCloseTo(1.05, 5);
    expect(written.samples).toBe(5);
    expect(written.nextMatchAt).toEqual(nextKickoff);
    expect(written.basedOnThroughAt).toEqual(lastFinished);

    // The very next lookup of that team is a HIT: no further fetches.
    vi.mocked(fetchTeamXgAverage).mockClear();
    const second = await getTeamXgCached(HOME_TEAM);
    expect(second).toEqual({ xgFor: 1.9, xgAgainst: 1.05, samples: 5 });
    expect(fetchTeamXgAverage).not.toHaveBeenCalled();
  });

  it("writes next_match_at as null when the provider has nothing scheduled", async () => {
    stubTeamEventDates({ lastFinished: new Date(Date.now() - 4 * DAY_MS).toISOString() });
    vi.mocked(fetchTeamXgAverage).mockResolvedValue({
      teamId: AWAY_TEAM,
      xgFor: 1.1,
      xgAgainst: 1.5,
      samples: 5,
    });

    await getTeamXgCached(AWAY_TEAM);

    expect(dbState.xgWrites).toHaveLength(1);
    expect(dbState.xgWrites[0].nextMatchAt).toBeNull();
  });

  // ── 4. No average → no row ──────────────────────────────────────────────────
  it("writes no row when the xG fetcher returns null", async () => {
    stubTeamEventDates({ next: new Date(Date.now() + 2 * DAY_MS).toISOString() });
    vi.mocked(fetchTeamXgAverage).mockResolvedValue(null);

    const value = await getTeamXgCached(HOME_TEAM);

    expect(value).toBeNull();
    expect(dbState.xgWrites).toHaveLength(0);
    expect(dbState.teamXgRows.size).toBe(0);
  });

  // ── 5. Fail-soft read ───────────────────────────────────────────────────────
  it("falls through to the live fetch — without throwing — when the DB read fails", async () => {
    dbState.xgReadError = new Error("connection refused");
    stubTeamEventDates({ next: new Date(Date.now() + 2 * DAY_MS).toISOString() });
    vi.mocked(fetchTeamXgAverage).mockResolvedValue({
      teamId: HOME_TEAM,
      xgFor: 1.4,
      xgAgainst: 1.3,
      samples: 4,
    });

    const value = await getTeamXgCached(HOME_TEAM);

    expect(fetchTeamXgAverage).toHaveBeenCalledWith(HOME_TEAM, 5);
    expect(value).toEqual({ xgFor: 1.4, xgAgainst: 1.3, samples: 4 });
  });

  // ── 6. Fail-soft write ──────────────────────────────────────────────────────
  it("still returns the fetched average when the DB write fails", async () => {
    dbState.xgWriteError = new Error("disk full");
    stubTeamEventDates({ next: new Date(Date.now() + 2 * DAY_MS).toISOString() });
    vi.mocked(fetchTeamXgAverage).mockResolvedValue({
      teamId: HOME_TEAM,
      xgFor: 2.1,
      xgAgainst: 1.0,
      samples: 5,
    });

    const value = await getTeamXgCached(HOME_TEAM);

    expect(value).toEqual({ xgFor: 2.1, xgAgainst: 1.0, samples: 5 });
    // The write was attempted — it just did not stick.
    expect(dbState.xgWrites).toHaveLength(1);
    expect(dbState.teamXgRows.size).toBe(0);
  });

  // ── Wiring: the per-fixture fetch reads the cache, not the fetcher ──────────
  it("serves a whole scan from cached xG — the fetcher is never called", async () => {
    seedTeamXgRow(HOME_TEAM, { xgFor: 1.75, nextMatchAt: new Date(Date.now() + 36 * HOUR_MS) });
    seedTeamXgRow(AWAY_TEAM, {
      xgFor: 1.4,
      xgAgainst: 1.2,
      nextMatchAt: new Date(Date.now() + 36 * HOUR_MS),
    });
    mockScoreboard([makeMockFixture("fx-xgc", "Arsenal", "Chelsea")]);
    vi.mocked(resolveBzzoiroEvent).mockResolvedValue({
      eventId: "555",
      status: "resolved",
      eventsInRange: 1,
      relatedInRange: 1,
      toleranceDays: 2,
    });
    vi.mocked(fetchEventDetail).mockResolvedValue({
      homeTeamId: HOME_TEAM,
      awayTeamId: AWAY_TEAM,
    });

    const data = await getFirst5();

    const goal = data.matches[0].markets.find((m) => m.key === "goal");
    expect(goal?.statsSource).toBe("Bzzoiro xG");
    // 1.75 + 1.40 from the cache rows — no Bzzoiro xG walk at all.
    expect(goal?.expectedPerMatch).toBeCloseTo(3.15, 2);
    expect(fetchTeamXgAverage).not.toHaveBeenCalled();
  });

  // ── Logging: one aggregate line per scan, one line per cache write ──────────
  it("logs one aggregate hit/miss line per scan, not one per fixture", async () => {
    // One fixture, one cached team (hit) and one uncached team (miss).
    seedTeamXgRow(HOME_TEAM, { nextMatchAt: new Date(Date.now() + 36 * HOUR_MS) });
    mockScoreboard([makeMockFixture("fx-log", "Arsenal", "Chelsea")]);
    vi.mocked(resolveBzzoiroEvent).mockResolvedValue({
      eventId: "555",
      status: "resolved",
      eventsInRange: 1,
      relatedInRange: 1,
      toleranceDays: 2,
    });
    vi.mocked(fetchEventDetail).mockResolvedValue({
      homeTeamId: HOME_TEAM,
      awayTeamId: AWAY_TEAM,
    });
    const nextKickoff = new Date(Date.now() + 36 * HOUR_MS).toISOString();
    stubTeamEventDates({ next: nextKickoff });
    vi.mocked(fetchTeamXgAverage).mockResolvedValue({
      teamId: AWAY_TEAM,
      xgFor: 1.2,
      xgAgainst: 1.3,
      samples: 5,
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      await getFirst5();

      const cacheLines = info.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.startsWith("[First5] xG cache:"));
      // Exactly one aggregate line for the whole scan (2 teams), never one per team.
      expect(cacheLines).toEqual(["[First5] xG cache: 1 hits, 1 misses"]);

      const writeLines = info.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.startsWith("[First5] xG cache write:"));
      expect(writeLines).toEqual([
        `[First5] xG cache write: team ${AWAY_TEAM} — next match at ${nextKickoff}`,
      ]);
    } finally {
      info.mockRestore();
    }
  });
});
