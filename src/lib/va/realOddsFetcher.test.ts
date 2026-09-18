import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RealBookOdds } from "./realOddsFetcher";

// ─── Database mock ───────────────────────────────────────────────────────────
// realOddsFetcher talks to `league_odds_cache` through drizzle. The mock is
// deliberately small: one cache row per league (set by the test) and a record
// of every row written, so the cache HIT / MISS / no-write-on-failure rules can
// be asserted directly.
const dbState = vi.hoisted(() => {
  const writes: Array<Record<string, unknown>> = [];
  return {
    cacheRows: new Map<string, Record<string, unknown>>(),
    writes,
  };
});

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => Array.from(dbState.cacheRows.values()),
        }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        dbState.writes.push(row);
        const result = Promise.resolve([]) as unknown as Promise<unknown[]> & {
          onConflictDoUpdate: () => Promise<unknown[]>;
        };
        result.onConflictDoUpdate = () => Promise.resolve([]);
        return result;
      },
    }),
  },
  keepDbAlive: async () => undefined,
}));

vi.mock("@/db/schema", () => ({ leagueOddsCache: { leagueSlug: "league_slug" } }));

// ─── HTTP fixture helpers ────────────────────────────────────────────────────

interface MockResponseOptions {
  status?: number;
  quota?: string | null;
}

function jsonResponse(body: unknown, options: MockResponseOptions = {}): Response {
  const status = options.status ?? 200;
  const quota = options.quota ?? null;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "x-requests-remaining" ? quota : null) },
    json: async () => body,
  } as unknown as Response;
}

/** One fixture as The Odds API returns it: markets hold every outcome. */
function apiEvent(
  home: string,
  away: string,
  markets: Array<{ key: string; outcomes: Array<{ name: string; price: number; point?: number }> }>,
  bookmaker = "Bet365",
) {
  return {
    id: `${home}-${away}`.toLowerCase().replace(/\s+/g, "-"),
    sport_key: "soccer_epl",
    commence_time: "2026-09-20T14:00:00Z",
    home_team: home,
    away_team: away,
    bookmakers: [{ key: bookmaker.toLowerCase(), title: bookmaker, markets }],
  };
}

const h2hMarket = (home: string, away: string, prices: [number, number, number]) => ({
  key: "h2h",
  outcomes: [
    { name: home, price: prices[0] },
    { name: away, price: prices[1] },
    { name: "Draw", price: prices[2] },
  ],
});

const totalsMarket = (point: number, over: number, under: number) => ({
  key: "totals",
  outcomes: [
    { name: "Over", price: over, point },
    { name: "Under", price: under, point },
  ],
});

const bttsMarket = (yes: number, no: number) => ({
  key: "btts",
  outcomes: [
    { name: "Yes", price: yes },
    { name: "No", price: no },
  ],
});

let logs: string[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dbState.cacheRows.clear();
  dbState.writes.length = 0;
  delete process.env.ODDS_API_KEY;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  fetchMock = vi.fn(async () => jsonResponse([]));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ODDS_API_KEY;
});

describe("Value Accumulator — real bookmaker odds (The Odds API)", () => {
  it("1. returns [] when ODDS_API_KEY is unset (no request, no throw)", async () => {
    const { fetchLeagueRealOdds } = await import("./realOddsFetcher");

    await expect(fetchLeagueRealOdds("eng.1")).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("2. returns [] for an unsupported league slug and makes ZERO HTTP calls", async () => {
    process.env.ODDS_API_KEY = "test-key";
    const { fetchLeagueRealOdds } = await import("./realOddsFetcher");

    await expect(fetchLeagueRealOdds("arg.1")).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(logs.some((l) => l.includes("arg.1") && l.includes("no sport key"))).toBe(true);
  });

  it("3. ONE call returns every fixture of the league, flattened to rows", async () => {
    process.env.ODDS_API_KEY = "test-key";
    fetchMock.mockResolvedValue(
      jsonResponse([
        apiEvent("Arsenal", "Chelsea", [h2hMarket("Arsenal", "Chelsea", [2.1, 3.4, 3.2])]),
        apiEvent("Liverpool", "Everton", [totalsMarket(2.5, 1.85, 1.95)], "Pinnacle"),
        apiEvent("Manchester City", "Tottenham", [bttsMarket(1.7, 2.05)], "1xBet"),
      ]),
    );
    const { fetchLeagueRealOdds } = await import("./realOddsFetcher");

    const rows = await fetchLeagueRealOdds("eng.1");

    // 3 h2h + 2 totals + 2 btts = 7 rows, from ONE request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(7);
    const fixtures = new Set(rows.map((r) => `${r.fixtureHome}|${r.fixtureAway}`));
    expect(fixtures.size).toBe(3);
    expect(fixtures).toEqual(
      new Set(["Arsenal|Chelsea", "Liverpool|Everton", "Manchester City|Tottenham"]),
    );
    expect(rows.find((r) => r.fixtureHome === "Liverpool")).toMatchObject({
      bookmaker: "Pinnacle",
      marketLabel: "totals",
      selection: "Over",
      line: 2.5,
      odds: 1.85,
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/sports/soccer_epl/odds");
  });

  it("4. bestPriceFor picks the highest-odds bookmaker for the market", async () => {
    const { bestPriceFor } = await import("./realOddsFetcher");
    const options = [
      { fixtureHome: "Arsenal", fixtureAway: "Chelsea", bookmaker: "Bet365", marketLabel: "totals", line: 2.5, selection: "Over", odds: 1.8 },
      { fixtureHome: "Arsenal", fixtureAway: "Chelsea", bookmaker: "Pinnacle", marketLabel: "totals", line: 2.5, selection: "Over", odds: 1.95 },
      { fixtureHome: "Arsenal", fixtureAway: "Chelsea", bookmaker: "1xBet", marketLabel: "totals", line: 2.5, selection: "Over", odds: 1.88 },
      // Different line and different market must not win.
      { fixtureHome: "Arsenal", fixtureAway: "Chelsea", bookmaker: "Unibet", marketLabel: "totals", line: 3.5, selection: "Over", odds: 2.6 },
      { fixtureHome: "Arsenal", fixtureAway: "Chelsea", bookmaker: "Unibet", marketLabel: "totals", line: 2.5, selection: "Under", odds: 3.1 },
    ];

    const best = bestPriceFor(options, "Arsenal", "Chelsea", "Total Goals O/U 2.5", "Over 2.5");
    expect(best).toEqual({ odds: 1.95, bookmaker: "Pinnacle" });
  });

  it("5. bestPriceFor returns null for a corners market (not served by The Odds API)", async () => {
    const { bestPriceFor } = await import("./realOddsFetcher");
    const options = [
      { fixtureHome: "Arsenal", fixtureAway: "Chelsea", bookmaker: "Bet365", marketLabel: "totals", line: 9.5, selection: "Over", odds: 1.9 },
    ];

    expect(bestPriceFor(options, "Arsenal", "Chelsea", "Total Corners O/U 9.5", "Over 9.5")).toBeNull();
    expect(bestPriceFor(options, "Arsenal", "Chelsea", "Total Cards O/U 3.5", "Over 3.5")).toBeNull();
  });

  it("6. team names normalise: 'Manchester United FC' matches 'Manchester United'", async () => {
    const { bestPriceFor } = await import("./realOddsFetcher");
    const options = [
      {
        fixtureHome: "Manchester United FC",
        fixtureAway: "Leeds United AFC",
        bookmaker: "Bet365",
        marketLabel: "h2h",
        line: null,
        selection: "Home",
        odds: 2.05,
      },
    ];

    // The app's fixture names drop the club suffix; the row must still match.
    expect(bestPriceFor(options, "Manchester United", "Leeds United", "Match Result", "Manchester United Win")).toEqual({
      odds: 2.05,
      bookmaker: "Bet365",
    });
  });

  it("7. a 500 and a timeout both return [] without throwing and without a cache write", async () => {
    process.env.ODDS_API_KEY = "test-key";
    const { fetchLeagueRealOdds } = await import("./realOddsFetcher");

    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "boom" }, { status: 500 }));
    await expect(fetchLeagueRealOdds("eng.1")).resolves.toEqual([]);

    fetchMock.mockRejectedValueOnce(new Error("aborted"));
    await expect(fetchLeagueRealOdds("eng.1")).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dbState.writes).toHaveLength(0);
  });

  it("8. CACHE HIT: a valid row is served with ZERO HTTP calls", async () => {
    process.env.ODDS_API_KEY = "test-key";
    const cached: RealBookOdds[] = [
      { fixtureHome: "Arsenal", fixtureAway: "Chelsea", bookmaker: "Bet365", marketLabel: "totals", line: 2.5, selection: "Over", odds: 1.9 },
    ];
    dbState.cacheRows.set("eng.1", {
      leagueSlug: "eng.1",
      sportKey: "soccer_epl",
      responseJson: cached,
      fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    });
    const { fetchLeagueRealOdds } = await import("./realOddsFetcher");

    const rows = await fetchLeagueRealOdds("eng.1");

    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(rows).toEqual(cached);
    expect(logs.some((l) => l.includes("CACHE HIT") && l.includes("eng.1"))).toBe(true);
    expect(dbState.writes).toHaveLength(0);
  });

  it("9. CACHE MISS (expired row): the HTTP call fires and a fresh row is written", async () => {
    process.env.ODDS_API_KEY = "test-key";
    dbState.cacheRows.set("eng.1", {
      leagueSlug: "eng.1",
      sportKey: "soccer_epl",
      responseJson: [],
      fetchedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    fetchMock.mockResolvedValue(jsonResponse([apiEvent("Arsenal", "Chelsea", [totalsMarket(2.5, 1.85, 1.95)])]));
    const { fetchLeagueRealOdds } = await import("./realOddsFetcher");

    const rows = await fetchLeagueRealOdds("eng.1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    expect(logs.some((l) => l.includes("CACHE MISS") && l.includes("expired"))).toBe(true);
    expect(dbState.writes).toHaveLength(1);
    const written = dbState.writes[0];
    expect(written.leagueSlug).toBe("eng.1");
    expect(written.sportKey).toBe("soccer_epl");
    // 12h expiry, not the expired value we read.
    expect(new Date(written.expiresAt as string).getTime()).toBeGreaterThan(
      Date.now() + 11 * 60 * 60 * 1000,
    );
  });

  it("10. CACHE MISS (no row): the HTTP call fires and a row is written", async () => {
    process.env.ODDS_API_KEY = "test-key";
    fetchMock.mockResolvedValue(jsonResponse([apiEvent("Arsenal", "Chelsea", [bttsMarket(1.7, 2.05)])]));
    const { fetchLeagueRealOdds } = await import("./realOddsFetcher");

    const rows = await fetchLeagueRealOdds("esp.1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("soccer_spain_la_liga");
    expect(rows).toHaveLength(2);
    expect(dbState.writes).toHaveLength(1);
    expect(dbState.writes[0].leagueSlug).toBe("esp.1");
    expect(logs.some((l) => l.includes("CACHE MISS") && l.includes("esp.1") && l.includes("no row"))).toBe(true);
  });

  it("11. a FAILED fetch writes NO cache row", async () => {
    process.env.ODDS_API_KEY = "test-key";
    fetchMock.mockResolvedValue(jsonResponse({ message: "quota exceeded" }, { status: 429, quota: "0" }));
    const { fetchLeagueRealOdds } = await import("./realOddsFetcher");

    const rows = await fetchLeagueRealOdds("ita.1");

    expect(rows).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dbState.writes).toHaveLength(0);
    expect(logs.some((l) => l.includes("ita.1") && l.includes("fetch failed"))).toBe(true);
  });

  it("12. logs the remaining quota from the x-requests-remaining header", async () => {
    process.env.ODDS_API_KEY = "test-key";
    fetchMock.mockResolvedValue(
      jsonResponse([apiEvent("Arsenal", "Chelsea", [totalsMarket(2.5, 1.85, 1.95)])], { quota: "487" }),
    );
    const { fetchLeagueRealOdds } = await import("./realOddsFetcher");

    await fetchLeagueRealOdds("eng.1");

    expect(logs.some((l) => l.includes("487"))).toBe(true);
    expect(logs.some((l) => l.includes("quota remaining: 487"))).toBe(true);
  });

  it("13. requests only free-tier markets: markets=h2h,totals and NO btts", async () => {
    process.env.ODDS_API_KEY = "test-key";
    fetchMock.mockResolvedValue(
      jsonResponse([apiEvent("Arsenal", "Chelsea", [totalsMarket(2.5, 1.85, 1.95)])]),
    );
    const { fetchLeagueRealOdds } = await import("./realOddsFetcher");

    await fetchLeagueRealOdds("eng.1");

    // The Odds API free tier does not serve `btts`: asking for it fails the WHOLE
    // request with 422 INVALID_MARKET ("Markets not supported by this endpoint:
    // btts"), so every fixture of the league falls back to Bzzoiro Consensus.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("markets=h2h,totals");
    expect(url).not.toContain("btts");
    // …and `h2h,totals` is the complete value, not a prefix of a longer list.
    expect(url).toMatch(/markets=h2h,totals&/);
  });
});
