// @vitest-environment happy-dom

// First 5 Minutes board — upcoming-fixtures grouping (page) plus the settled
// history behind the Recent Results section (API).
//
// The page is a client component: it reads /api/first-5-minutes for the
// upcoming board and /api/first-5-minutes/results for the settled matches below
// it. Both fetches are stubbed here; nothing in this file touches the network.
//
// The results endpoint reads performance_log through drizzle; the database
// module is mocked with a small chainable query builder (the same "rows + read
// error" shape the other route tests use) so the grouping, window, ordering and
// fail-soft behaviour can be asserted without a database.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET as getAnalyticsHandler,
  actionFor,
  bucketFor,
  clearAnalyticsCache,
  trendWindowFor,
} from "@/app/api/first-5-minutes/analytics/route";
import { GET as getSettledResults } from "@/app/api/first-5-minutes/results/route";
import First5MinutesPage from "./page";
import { AnalyticsSheet } from "./components/AnalyticsSheet";
import { formatDateTime } from "./components/format";
import type { First5Match, First5MinutesData } from "./components/types";

// ─── Database mock ────────────────────────────────────────────────────────────
// The settled-results route consumes db.select(...).from(...).where(...)
// .orderBy(...).limit(...) — every link is chainable and only limit() answers,
// resolving `dbState.rows` (`lastLimit` records the row budget the route asked
// for: matches × 4).
//
// The analytics route instead runs one aggregate query per dimension and
// awaits the builder directly (no limit). Those queries are dispatched by the
// LEAD FIELD of the select (each dimension selects a distinctive first key:
// "settled" for totals, "market", "selection", "band", "leagueSlug", "bucket",
// "window"), answering from `dbState.analytics`; `dbState.analyticsError`
// simulates a database failure.

const dbState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  readError: null as Error | null,
  lastLimit: null as number | null,
  analytics: {
    totals: { settled: 0, won: 0, lost: 0, push: 0, void: 0, claimed: 0 },
    market: [],
    selection: [],
    band: [],
    leagueSlug: [],
    bucket: [],
    window: [],
  } as Record<string, unknown>,
  analyticsError: null as Error | null,
}));

vi.mock("@/db", () => {
  function makeQuery(fields?: Record<string, unknown>) {
    const dimension =
      fields && typeof fields === "object" ? (Object.keys(fields)[0] ?? "") : "";
    const query = {
      where: () => query,
      orderBy: () => query,
      groupBy: () => query,
      having: () => query,
      limit: (count: number) => {
        dbState.lastLimit = count;
        if (dbState.readError) return Promise.reject(dbState.readError);
        return Promise.resolve(dbState.rows);
      },
      then: (
        resolve: (rows: unknown) => void,
        reject: (reason: unknown) => void,
      ) => {
        if (dbState.analyticsError) {
          reject(dbState.analyticsError);
          return;
        }
        // Totals is a single-row aggregate; every other dimension is a list.
        if (dimension === "settled") resolve([dbState.analytics.totals]);
        else resolve(dbState.analytics[dimension] ?? []);
      },
    };
    return query;
  }
  return { db: { select: (fields?: Record<string, unknown>) => ({ from: () => makeQuery(fields) }) } };
});

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  dbState.rows = [];
  dbState.readError = null;
  dbState.lastLimit = null;
  dbState.analytics = {
    totals: { settled: 0, won: 0, lost: 0, push: 0, void: 0, claimed: 0 },
    market: [],
    selection: [],
    band: [],
    leagueSlug: [],
    bucket: [],
    window: [],
  };
  dbState.analyticsError = null;
  clearAnalyticsCache();
});

/** ISO day string N days before today — the same convention the route uses. */
function dayOffset(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

// ─── Upcoming-fixtures fixtures (page) ────────────────────────────────────────

function fixture(fixtureId: string, leagueSlug: string, date: string): First5Match {
  return {
    fixtureId,
    homeTeam: `Home ${fixtureId}`,
    awayTeam: `Away ${fixtureId}`,
    homeLogo: null,
    awayLogo: null,
    // Deliberately identical: grouping must use the slug, not the feed's label.
    league: "Feed competition label",
    leagueSlug,
    leagueTier: 1,
    date,
    venue: null,
    statsSource: "ESPN",
    dataOrigin: "real",
    realMarketCount: 0,
    markets: [],
  };
}

function first5Payload(matches: First5Match[]): First5MinutesData {
  return {
    generatedAt: "2026-09-19T10:00:00Z",
    windowMinutes: 5,
    lookaheadDays: 7,
    totalFixturesChecked: matches.length,
    totalMatches: matches.length,
    marketTypes: [],
    model: {
      description: "Test model",
      matchMinutes: 96,
      openingIntensity: { goal: 1, corner: 1, card: 1, penalty: 1 },
    },
    cache: { ttlMinutes: 60, hit: false },
    matches,
  };
}

/**
 * Fetch stub that answers both board endpoints: the upcoming feed returns
 * `upcoming`, the settled-results endpoint returns `settled`.
 */
function pageFetchMock(upcoming: First5MinutesData, settled: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.startsWith("/api/first-5-minutes/results")
      ? settled
      : upcoming;
    return { ok: true, status: 200, json: async () => body };
  });
}

async function renderBoard(fetchMock: ReturnType<typeof pageFetchMock>): Promise<HTMLDivElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(First5MinutesPage));
  });
  return container;
}

// ─── Settled results fixtures (API) ───────────────────────────────────────────

type SettledOutcome = "WIN" | "LOSS" | "PUSH" | "VOID";

/** One settled performance_log row as the pg driver would deliver it. */
function settledRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "evt-1",
    matchLabel: "Arsenal vs Chelsea",
    league: "English Premier League",
    leagueSlug: "eng.1",
    matchDate: dayOffset(1),
    homeScore: 2,
    awayScore: 1,
    market: "Goal in First 5 Minutes",
    selection: "Yes",
    hitRate: 0.87,
    confidence: "HIGH",
    outcome: "WIN",
    ...overrides,
  };
}

async function getResults(query = "") {
  const response = await getSettledResults(
    new Request(`http://localhost/api/first-5-minutes/results${query}`),
  );
  const body = (await response.json()) as {
    ok: boolean;
    matches: Array<{
      eventId: string;
      matchLabel: string;
      league: string;
      leagueSlug: string;
      matchDate: string;
      homeScore: number | null;
      awayScore: number | null;
      markets: Array<{
        market: string;
        selection: string;
        hitRate: number;
        confidence: string;
        outcome: string;
      }>;
    }>;
  };
  return { response, body };
}

/** One settled match for the page payload (shape mirrors the endpoint). */
function settledMatch(index: number, outcome: SettledOutcome) {
  return {
    eventId: `settled-${index}`,
    matchLabel: `Home ${index} vs Away ${index}`,
    league: "Feed competition label",
    leagueSlug: "eng.1",
    matchDate: dayOffset(((index - 1) % 10) + 1),
    homeScore: 2,
    awayScore: index % 2,
    markets: [
      {
        market: "Goal in First 5 Minutes",
        selection: index % 2 === 0 ? "Yes" : "No",
        hitRate: 0.8,
        confidence: "HIGH",
        outcome,
      },
    ],
  };
}

// ─── Upcoming-fixtures board ──────────────────────────────────────────────────

it("renders Premier League, La Liga, then UEFA Champions League with kickoff-sorted cards", async () => {
  const champions = fixture("ucl", "uefa.champions", "2026-09-19T12:00:00Z");
  const premierLate = fixture("pl-late", "eng.1", "2026-09-21T18:00:00Z");
  const premierEarly = fixture("pl-early", "eng.1", "2026-09-20T18:00:00Z");
  const spanishLate = fixture("liga-late", "esp.1", "2026-09-20T18:00:00Z");
  // A later wall-clock time but an earlier instant, to check timezone-aware sorting.
  const spanishEarly = fixture("liga-early", "esp.1", "2026-09-20T19:00:00+02:00");
  const matches = [champions, spanishLate, premierLate, spanishEarly, premierEarly];
  const fetchMock = pageFetchMock(first5Payload(matches), { ok: true, matches: [] });
  const container = await renderBoard(fetchMock);

  // The Recent Results heading is the other h2 on the page; the league group
  // headings are the ones under test here.
  const headers = [...container.querySelectorAll("h2")].filter(
    (header) => !header.closest("#recent-results"),
  );
  expect(headers.map((header) => header.textContent)).toEqual([
    "Premier League",
    "La Liga",
    "UEFA Champions League",
  ]);

  const expectedGroups = [[premierEarly, premierLate], [spanishEarly, spanishLate], [champions]];
  headers.forEach((header, index) => {
    const cards = [...header.parentElement!.parentElement!.querySelectorAll("article")];
    expect(cards).toHaveLength(expectedGroups[index].length);
    cards.forEach((card, cardIndex) => {
      const match = expectedGroups[index][cardIndex];
      expect(card.textContent).toContain(match.homeTeam);
      expect(card.textContent).toContain(formatDateTime(match.date));
    });
  });
  expect(matches.map((match) => match.fixtureId)).toEqual([
    "ucl", "liga-late", "pl-late", "liga-early", "pl-early",
  ]);
  expect(fetchMock).toHaveBeenCalledWith("/api/first-5-minutes", { cache: "no-store" });
  expect(fetchMock).toHaveBeenCalledWith("/api/first-5-minutes/results?days=14", {
    cache: "no-store",
  });
});

// ─── Recent Results section ───────────────────────────────────────────────────

describe("Recent Results section", () => {
  it("summarises the settled markets and shows the 10 newest before the Show all toggle", async () => {
    const dates = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    // Four pushes/voids must not count towards "won" or "lost".
    const outcomes: SettledOutcome[] = [
      "WIN", "WIN", "WIN", "WIN", "WIN", "WIN", "WIN", "WIN", "LOSS", "LOSS", "PUSH", "VOID",
    ];
    // Deliberately shuffled: the section must render newest first regardless.
    const payload = {
      ok: true,
      matches: dates.map((day, index) => ({
        ...settledMatch(index + 1, outcomes[index]),
        matchDate: dayOffset(13 - day),
      })),
    };
    const fetchMock = pageFetchMock(first5Payload([]), payload);
    const container = await renderBoard(fetchMock);

    const section = container.querySelector("#recent-results");
    expect(section).not.toBeNull();
    // 12 finished matches · 8 won · 2 lost, 80% of the 10 decided markets —
    // the PUSH and VOID rows count as neither won nor lost.
    expect(section!.textContent).toContain("12 finished matches · 8 won · 2 lost");
    expect(section!.textContent).toContain("80.0% hit rate");

    // Collapsed to the 10 newest matches.
    const rows = [...section!.querySelectorAll("article")];
    expect(rows).toHaveLength(10);
    expect(rows[0].textContent).toContain("Home 12 vs Away 12");
    expect(rows[9].textContent).toContain("Home 3 vs Away 3");
    // Market detail: label · selection, the model's claim, and the outcome badge.
    expect(rows[0].textContent).toContain("Goal in First 5 Minutes");
    expect(rows[0].textContent).toContain("Model: 80% (HIGH)");
    expect(rows[0].textContent).toContain("Result:");

    const toggle = [...section!.querySelectorAll("button")].find(
      (button) => button.textContent === "Show all 12",
    );
    expect(toggle).toBeDefined();
    await act(async () => {
      toggle!.click();
    });
    expect([...section!.querySelectorAll("article")]).toHaveLength(12);
  });

  it("shows the placeholder when nothing settled inside the window", async () => {
    const fetchMock = pageFetchMock(first5Payload([]), { ok: true, matches: [] });
    const container = await renderBoard(fetchMock);

    const section = container.querySelector("#recent-results");
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("RECENT RESULTS — LAST 14 DAYS");
    expect(section!.textContent).toContain("No settled predictions in the last 14 days yet.");
  });
});

// ─── GET /api/first-5-minutes/results ─────────────────────────────────────────

describe("GET /api/first-5-minutes/results", () => {
  it("returns no matches when performance_log has no first5 rows", async () => {
    const { response, body } = await getResults();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.matches).toEqual([]);
  });

  it("groups settled rows into matches with their markets and outcomes", async () => {
    dbState.rows = [
      settledRow({
        eventId: "evt-recent",
        matchLabel: "Arsenal vs Chelsea",
        matchDate: dayOffset(1),
        market: "Goal in First 5 Minutes",
        selection: "Yes",
        hitRate: 0.87,
        confidence: "HIGH",
        outcome: "WIN",
      }),
      settledRow({
        eventId: "evt-recent",
        matchDate: dayOffset(1),
        market: "Corner in First 5 Minutes",
        selection: "No",
        hitRate: 0.63,
        confidence: "MEDIUM",
        outcome: "LOSS",
      }),
      settledRow({
        eventId: "evt-older",
        matchLabel: "Bayern Munich vs Dortmund",
        league: "German Bundesliga",
        leagueSlug: "ger.1",
        matchDate: dayOffset(3),
        homeScore: 1,
        awayScore: 1,
        market: "Card in First 5 Minutes",
        selection: "No",
        hitRate: 0.91,
        confidence: "HIGH",
        outcome: "WIN",
      }),
      settledRow({
        eventId: "evt-older",
        matchLabel: "Bayern Munich vs Dortmund",
        league: "German Bundesliga",
        leagueSlug: "ger.1",
        matchDate: dayOffset(3),
        homeScore: 1,
        awayScore: 1,
        market: "Goal in First 5 Minutes",
        selection: "No",
        hitRate: 0.55,
        confidence: "LOW",
        outcome: "PUSH",
      }),
    ];

    const { body } = await getResults();
    expect(body.matches).toHaveLength(2);

    const [recent, older] = body.matches;
    expect(recent).toMatchObject({
      eventId: "evt-recent",
      matchLabel: "Arsenal vs Chelsea",
      league: "English Premier League",
      leagueSlug: "eng.1",
      matchDate: dayOffset(1),
      homeScore: 2,
      awayScore: 1,
    });
    expect(recent.markets).toEqual([
      {
        market: "Goal in First 5 Minutes",
        selection: "Yes",
        hitRate: 0.87,
        confidence: "HIGH",
        outcome: "WIN",
      },
      {
        market: "Corner in First 5 Minutes",
        selection: "No",
        hitRate: 0.63,
        confidence: "MEDIUM",
        outcome: "LOSS",
      },
    ]);

    // 2 WIN, 1 LOSS, 1 PUSH across the two matches — each market keeps its own outcome.
    expect(older).toMatchObject({ eventId: "evt-older", homeScore: 1, awayScore: 1 });
    expect(older.markets.map((market) => market.outcome)).toEqual(["WIN", "PUSH"]);
  });

  it("excludes rows older than the days window", async () => {
    dbState.rows = [
      settledRow({ eventId: "inside", matchDate: dayOffset(2) }),
      settledRow({ eventId: "outside", matchDate: dayOffset(20) }),
    ];

    // Default window: 14 days.
    const { body } = await getResults();
    expect(body.matches.map((match) => match.eventId)).toEqual(["inside"]);

    // An explicit wider window brings the older row back (still newest first).
    const wider = await getResults("?days=30");
    expect(wider.body.matches.map((match) => match.eventId)).toEqual(["inside", "outside"]);
  });

  it("sorts matches by match date, newest first", async () => {
    dbState.rows = [
      settledRow({ eventId: "oldest", matchDate: dayOffset(9) }),
      settledRow({ eventId: "newest", matchDate: dayOffset(1) }),
      settledRow({ eventId: "middle", matchDate: dayOffset(4) }),
    ];

    const { body } = await getResults();
    expect(body.matches.map((match) => match.eventId)).toEqual(["newest", "middle", "oldest"]);
  });

  it("ignores rows that are not settled yet", async () => {
    dbState.rows = [
      settledRow({ eventId: "still-pending", outcome: "pending" }),
      settledRow({ eventId: "settled", outcome: "WIN" }),
    ];

    const { body } = await getResults();
    expect(body.matches.map((match) => match.eventId)).toEqual(["settled"]);
  });

  it("caps the matches at limit and reads limit × 4 rows", async () => {
    dbState.rows = [1, 2, 3, 4, 5].map((index) =>
      settledRow({ eventId: `evt-${index}`, matchDate: dayOffset(index) }),
    );

    const { body } = await getResults("?limit=2");
    expect(body.matches).toHaveLength(2);
    expect(dbState.lastLimit).toBe(8);

    await getResults("?limit=1000");
    expect(dbState.lastLimit).toBe(400);
  });

  it("never 500s: a database error answers with an empty list", async () => {
    dbState.readError = new Error("connection refused");

    const { response, body } = await getResults();
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, matches: [] });
  });
});

// ─── GET /api/first-5-minutes/analytics (fixtures) ────────────────────────────

/** One aggregated group row as the analytics SQL would deliver it. */
interface AnalyticsAggregateRow {
  n: number;
  won: number;
  lost: number;
  claimed: number;
}

interface AnalyticsFixture {
  totals: {
    settled: number;
    won: number;
    lost: number;
    push: number;
    void: number;
    claimed: number;
  };
  market: Array<AnalyticsAggregateRow & { market: string }>;
  selection: Array<AnalyticsAggregateRow & { selection: string }>;
  band: Array<AnalyticsAggregateRow & { band: string }>;
  leagueSlug: Array<AnalyticsAggregateRow & { leagueSlug: string; leagueName: string | null }>;
  bucket: Array<AnalyticsAggregateRow & { bucket: string }>;
  window: Array<AnalyticsAggregateRow & { window: string }>;
}

function analyticsFixture(overrides: Partial<AnalyticsFixture> = {}): AnalyticsFixture {
  return {
    totals: { settled: 0, won: 0, lost: 0, push: 0, void: 0, claimed: 0 },
    market: [],
    selection: [],
    band: [],
    leagueSlug: [],
    bucket: [],
    window: [],
    ...overrides,
  };
}

interface AnalyticsResponseShape {
  ok: boolean;
  generatedAt: string;
  windowDays: number;
  totals: Record<string, number>;
  byMarket: Array<Record<string, unknown>>;
  bySelection: Array<Record<string, unknown>>;
  byConfidence: Array<Record<string, unknown>>;
  byLeague: Array<Record<string, unknown>>;
  byBucket: Array<Record<string, unknown>>;
  trend: Record<string, Record<string, number>>;
  trust: { best: Array<Record<string, unknown>>; worst: Array<Record<string, unknown>> };
}

async function getAnalytics(query = "") {
  const response = await getAnalyticsHandler(
    new Request(`http://localhost/api/first-5-minutes/analytics${query}`),
  );
  const body = (await response.json()) as AnalyticsResponseShape;
  return { response, body };
}

/** Seed the per-dimension aggregates the mocked database will answer with. */
function seedAnalytics(fixture: AnalyticsFixture): void {
  dbState.analytics = fixture as unknown as Record<string, unknown>;
}

const ZERO_TREND = { n: 0, won: 0, lost: 0, realised: 0, claimed: 0, edge: 0 };
const ZERO_TOTALS = {
  settled: 0, won: 0, lost: 0, push: 0, void: 0, realisedRate: 0, claimedAverage: 0, edge: 0,
};

// ─── Classification helpers (the rules the endpoint publishes) ────────────────

describe("first5 analytics classification helpers", () => {
  it("labels a row with n<20 as insufficient regardless of edge", () => {
    expect(actionFor(19, 0.4)).toBe("insufficient");
    expect(actionFor(0, 0)).toBe("insufficient");
    expect(actionFor(Number.NaN, 0.1)).toBe("insufficient");
  });

  it("labels a settled row with |edge| < 0.05 as trusted", () => {
    expect(actionFor(20, 0.049)).toBe("trusted");
    expect(actionFor(50, -0.04)).toBe("trusted");
    expect(actionFor(100, 0)).toBe("trusted");
  });

  it("labels a row with edge < -0.15 as avoid and everything between as watch", () => {
    expect(actionFor(50, -0.2)).toBe("avoid");
    expect(actionFor(50, -0.15)).toBe("avoid");
    expect(actionFor(50, -0.14)).toBe("watch");
    expect(actionFor(50, 0.3)).toBe("watch");
  });

  it("assigns hitRate 0.72 to the 0.70-0.80 bucket", () => {
    expect(bucketFor(0.72)).toBe("0.70-0.80");
    expect(bucketFor(0.5)).toBe("0.50-0.60");
    expect(bucketFor(0.6)).toBe("0.60-0.70");
    expect(bucketFor(0.79)).toBe("0.70-0.80");
    expect(bucketFor(1)).toBe("0.90-1.00");
    // Rows outside [0.50, 1.00] are excluded from the aggregate entirely.
    expect(bucketFor(0.49)).toBeNull();
    expect(bucketFor(1.01)).toBeNull();
    expect(bucketFor(Number.NaN)).toBeNull();
  });

  it("splits the trend: now-3d lands in last7d, now-10d in previous", () => {
    expect(trendWindowFor(dayOffset(3))).toBe("last7d");
    expect(trendWindowFor(dayOffset(7))).toBe("last7d");
    expect(trendWindowFor(dayOffset(8))).toBe("previous");
    expect(trendWindowFor(dayOffset(10))).toBe("previous");
    expect(trendWindowFor(dayOffset(14))).toBe("previous");
    // Older than the fortnight, or not a date at all → no window.
    expect(trendWindowFor(dayOffset(15))).toBeNull();
    expect(trendWindowFor("not-a-date")).toBeNull();
  });
});

// ─── GET /api/first-5-minutes/analytics ───────────────────────────────────────

describe("GET /api/first-5-minutes/analytics", () => {
  it("returns all-zero totals and empty arrays when performance_log is empty", async () => {
    const { response, body } = await getAnalytics();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.generatedAt).toEqual(expect.any(String));
    expect(body.windowDays).toBe(30);
    expect(body.totals).toEqual(ZERO_TOTALS);
    expect(body.byMarket).toEqual([]);
    expect(body.bySelection).toEqual([]);
    expect(body.byConfidence).toEqual([]);
    expect(body.byLeague).toEqual([]);
    expect(body.byBucket).toEqual([]);
    expect(body.trend).toEqual({ last7d: ZERO_TREND, previous: ZERO_TREND });
    expect(body.trust).toEqual({ best: [], worst: [] });
  });

  it("aggregates 3 settled rows (2 WIN, 1 LOSS) into one byMarket row with realised 0.667", async () => {
    seedAnalytics(analyticsFixture({
      totals: { settled: 3, won: 2, lost: 1, push: 0, void: 0, claimed: 0.55 },
      market: [
        { market: "Goal in First 5 Minutes", n: 3, won: 2, lost: 1, claimed: 0.55 },
      ],
    }));

    const { body } = await getAnalytics();
    expect(body.byMarket).toHaveLength(1);
    expect(body.byMarket[0]).toMatchObject({
      market: "Goal in First 5 Minutes",
      n: 3,
      won: 2,
      lost: 1,
      realised: 0.667,
      claimed: 0.55,
      edge: 0.117,
      // 3 settled rows is below the 20-pick threshold, whatever the edge.
      action: "insufficient",
    });
    expect(body.totals).toEqual({
      settled: 3,
      won: 2,
      lost: 1,
      push: 0,
      void: 0,
      realisedRate: 0.667,
      claimedAverage: 0.55,
      edge: 0.117,
    });
  });

  it("builds every dimension from its own aggregate and ranks the trust lists", async () => {
    seedAnalytics(analyticsFixture({
      totals: { settled: 45, won: 25, lost: 15, push: 3, void: 2, claimed: 0.6 },
      market: [
        { market: "Goal in First 5 Minutes", n: 30, won: 20, lost: 8, claimed: 0.7 },
        { market: "Corner in First 5 Minutes", n: 25, won: 5, lost: 18, claimed: 0.6 },
        { market: "Card in First 5 Minutes", n: 10, won: 4, lost: 4, claimed: 0.55 },
      ],
      selection: [
        { selection: "Yes", n: 40, won: 24, lost: 14, claimed: 0.62 },
        { selection: "No", n: 5, won: 1, lost: 1, claimed: 0.5 },
      ],
      band: [
        { band: "HIGH", n: 20, won: 14, lost: 4, claimed: 0.8 },
        { band: "LOW", n: 12, won: 3, lost: 8, claimed: 0.45 },
      ],
      leagueSlug: [
        { leagueSlug: "eng.1", leagueName: "English Premier League", n: 22, won: 12, lost: 6, claimed: 0.64 },
        { leagueSlug: "ger.1", leagueName: "German Bundesliga", n: 8, won: 3, lost: 4, claimed: 0.5 },
      ],
      bucket: [
        { bucket: "0.70-0.80", n: 15, won: 11, lost: 2, claimed: 0.75 },
        { bucket: "0.50-0.60", n: 8, won: 3, lost: 4, claimed: 0.55 },
      ],
      window: [
        { window: "last7d", n: 12, won: 8, lost: 2, claimed: 0.7 },
        { window: "previous", n: 9, won: 4, lost: 4, claimed: 0.5 },
      ],
    }));

    const { body } = await getAnalytics();

    // Totals: 25/(25+15) = 0.625 realised against a 0.6 average claim.
    expect(body.totals).toEqual({
      settled: 45, won: 25, lost: 15, push: 3, void: 2,
      realisedRate: 0.625, claimedAverage: 0.6, edge: 0.025,
    });

    // Per market: trusted (|edge| < 0.05), avoid (edge < -0.15), and a thin
    // n=10 row that stays insufficient even though its edge reads -0.05.
    expect(body.byMarket.map((row) => row.market)).toEqual([
      "Goal in First 5 Minutes", "Corner in First 5 Minutes", "Card in First 5 Minutes",
    ]);
    expect(body.byMarket[0]).toMatchObject({ n: 30, realised: 0.714, edge: 0.014, action: "trusted" });
    expect(body.byMarket[1]).toMatchObject({ n: 25, realised: 0.217, edge: -0.383, action: "avoid" });
    expect(body.byMarket[2]).toMatchObject({ n: 10, action: "insufficient" });

    // Trust lists only consider n>=20 and rank by edge, best first / worst first.
    expect(body.trust.best).toEqual([
      { marketKey: "Goal in First 5 Minutes", n: 30, edge: 0.014, action: "trusted" },
      { marketKey: "Corner in First 5 Minutes", n: 25, edge: -0.383, action: "avoid" },
    ]);
    expect(body.trust.worst).toEqual([
      { marketKey: "Corner in First 5 Minutes", n: 25, edge: -0.383, action: "avoid" },
      { marketKey: "Goal in First 5 Minutes", n: 30, edge: 0.014, action: "trusted" },
    ]);

    expect(body.bySelection).toEqual([
      expect.objectContaining({ selection: "Yes", n: 40, realised: 0.632, edge: 0.012 }),
      expect.objectContaining({ selection: "No", n: 5, realised: 0.5, edge: 0 }),
    ]);
    expect(body.byConfidence[0]).toMatchObject({ band: "HIGH", n: 20, realised: 0.778, edge: -0.022 });
    expect(body.byLeague[0]).toMatchObject({
      leagueSlug: "eng.1", leagueName: "English Premier League", n: 22, realised: 0.667, edge: 0.027,
    });

    // Buckets keep realised/claimed/diff (and sort by bucket label).
    expect(body.byBucket).toEqual([
      expect.objectContaining({ bucket: "0.50-0.60", n: 8, realised: 0.429, claimed: 0.55, diff: -0.121 }),
      expect.objectContaining({ bucket: "0.70-0.80", n: 15, realised: 0.846, claimed: 0.75, diff: 0.096 }),
    ]);

    // Trend windows land where trendWindowFor() says they should.
    expect(body.trend.last7d).toMatchObject({ n: 12, won: 8, realised: 0.8, claimed: 0.7, edge: 0.1 });
    expect(body.trend.previous).toMatchObject({ n: 9, won: 4, realised: 0.5, claimed: 0.5, edge: 0 });
  });

  it("never 500s: a database error answers with the empty payload and no throw", async () => {
    dbState.analyticsError = new Error("connection refused");

    const { response, body } = await getAnalytics();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.totals).toEqual(ZERO_TOTALS);
    expect(body.byMarket).toEqual([]);
    expect(body.bySelection).toEqual([]);
    expect(body.byConfidence).toEqual([]);
    expect(body.byLeague).toEqual([]);
    expect(body.byBucket).toEqual([]);
    expect(body.trend).toEqual({ last7d: ZERO_TREND, previous: ZERO_TREND });
    expect(body.trust).toEqual({ best: [], worst: [] });
  });

  it("caches the payload for 5 minutes keyed by windowDays", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
    const first = await getAnalytics();
    expect(first.body.generatedAt).toBe("2026-09-19T12:00:00.000Z");

    // Within the TTL the cached payload is served even though the data moved.
    seedAnalytics(analyticsFixture({
      totals: { settled: 9, won: 5, lost: 2, push: 1, void: 1, claimed: 0.6 },
    }));
    vi.setSystemTime(new Date("2026-09-19T12:04:59Z"));
    const second = await getAnalytics();
    expect(second.body.generatedAt).toBe(first.body.generatedAt);
    expect(second.body.totals.settled).toBe(0);

    // After 5 minutes the aggregates are recomputed.
    vi.setSystemTime(new Date("2026-09-19T12:05:00Z"));
    const third = await getAnalytics();
    expect(third.body.totals.settled).toBe(9);
    expect(third.body.generatedAt).toBe("2026-09-19T12:05:00.000Z");

    // A different window is an independent cache entry.
    vi.setSystemTime(new Date("2026-09-19T12:06:00Z"));
    const other = await getAnalytics("?days=7");
    expect(other.body.windowDays).toBe(7);
    expect(other.body.generatedAt).toBe("2026-09-19T12:06:00.000Z");
    const again = await getAnalytics("?days=7");
    expect(again.body.generatedAt).toBe(other.body.generatedAt);
  });
});

// ─── AnalyticsSheet ───────────────────────────────────────────────────────────

/** Full response body for the sheet tests, mirroring the endpoint's shape. */
function analyticsPayload() {
  return {
    ok: true,
    generatedAt: "2026-09-19T12:00:00Z",
    windowDays: 30,
    totals: {
      settled: 24, won: 15, lost: 6, push: 2, void: 1,
      realisedRate: 0.714, claimedAverage: 0.68, edge: 0.034,
    },
    byMarket: [
      { market: "Goal in First 5 Minutes", n: 24, won: 15, lost: 6, realised: 0.714, claimed: 0.68, edge: 0.034, action: "trusted" },
      { market: "Corner in First 5 Minutes", n: 6, won: 2, lost: 4, realised: 0.333, claimed: 0.55, edge: -0.217, action: "insufficient" },
    ],
    bySelection: [
      { selection: "Yes", n: 18, won: 12, lost: 4, realised: 0.75, claimed: 0.7, edge: 0.05 },
    ],
    byConfidence: [
      { band: "HIGH", n: 10, won: 7, lost: 2, realised: 0.778, claimed: 0.8, edge: -0.022 },
    ],
    byLeague: [
      { leagueSlug: "eng.1", leagueName: "Premier League", n: 24, won: 15, lost: 6, realised: 0.714, claimed: 0.68, edge: 0.034 },
    ],
    byBucket: [
      { bucket: "0.70-0.80", n: 12, realised: 0.833, claimed: 0.75, diff: 0.083 },
    ],
    trend: {
      last7d: { n: 9, won: 6, lost: 2, realised: 0.75, claimed: 0.7, edge: 0.05 },
      previous: { n: 10, won: 6, lost: 3, realised: 0.667, claimed: 0.68, edge: -0.013 },
    },
    trust: {
      best: [{ marketKey: "Goal in First 5 Minutes", n: 24, edge: 0.034, action: "trusted" }],
      worst: [],
    },
  };
}

async function renderSheet(payload: unknown, open = true) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }));
  vi.stubGlobal("fetch", fetchMock);
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(AnalyticsSheet, { open, onClose: () => {} }));
  });
  return { container, fetchMock };
}

describe("AnalyticsSheet", () => {
  it("shows the returned realised and claimed values in the summary line", async () => {
    const { container, fetchMock } = await renderSheet(analyticsPayload());

    const summary = container.querySelector('[data-testid="f5a-summary"]');
    expect(summary).not.toBeNull();
    expect(summary!.textContent).toContain("24 settled · 15W / 6L / 2P / 1V");
    expect(summary!.textContent).toContain("Realised 71.4%");
    expect(summary!.textContent).toContain("Claimed 68.0%");
    expect(summary!.textContent).toContain("Edge +3.4 pts");
    expect(fetchMock).toHaveBeenCalledWith("/api/first-5-minutes/analytics", { cache: "no-store" });
  });

  it("appends (low sample) to rows with fewer than 20 settled picks", async () => {
    const { container } = await renderSheet(analyticsPayload());

    const rows = [...container.querySelectorAll("tbody tr")];
    const goal = rows.find((row) => row.textContent?.includes("Goal in First 5 Minutes"));
    const corner = rows.find((row) => row.textContent?.includes("Corner in First 5 Minutes"));
    expect(goal).toBeDefined();
    expect(corner).toBeDefined();
    // n=24 reads clean; n=6 is muted and flagged next to its N value.
    expect(goal!.textContent).not.toContain("(low sample)");
    expect(corner!.textContent).toContain("6 (low sample)");
  });

  it("renders nothing and fetches nothing while closed", async () => {
    const { container, fetchMock } = await renderSheet(analyticsPayload(), false);
    expect(container.textContent).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
