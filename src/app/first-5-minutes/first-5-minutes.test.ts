// @vitest-environment happy-dom

// First 5 Minutes board — upcoming-fixtures grouping (page), the settled
// history behind the Recent Results section (API) and the analytics aggregates
// behind the 📊 Analytics sheet (API + sheet).
//
// The page is a client component: it reads /api/first-5-minutes for the
// upcoming board and /api/first-5-minutes/results for the settled matches below
// it. Both fetches are stubbed here; nothing in this file touches the network.
//
// Both endpoints read performance_log through drizzle; the database module is
// mocked with a small chainable query builder (the same "rows + read error"
// shape the other route tests use) so the grouping, window, ordering and
// fail-soft behaviour can be asserted without a database. The analytics route
// issues one GROUP BY query per dimension; the mock keys each query's canned
// rows off the first selected field (the dimension name), and pure helpers
// exported by the route (action verdicts, bucket assignment, trend windows)
// are pinned directly.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET as getAnalytics,
  actionFor,
  bucketFor,
  clearAnalyticsCache,
  trendPeriodFor,
  trendWindows,
  type First5AnalyticsResponse,
} from "@/app/api/first-5-minutes/analytics/route";
import { GET as getSettledResults } from "@/app/api/first-5-minutes/results/route";
import First5MinutesPage from "./page";
import { AnalyticsSheet } from "./components/AnalyticsSheet";
import { formatDateTime } from "./components/format";
import type { First5Match, First5MinutesData } from "./components/types";

// ─── Database mock ────────────────────────────────────────────────────────────
// db.select(...).from(...).where(...).orderBy(...).groupBy(...).limit(...) —
// every link is chainable and awaiting the builder (or limit()) resolves the
// query. `lastLimit` records the row budget the results route asked for
// (matches × 4).
//
// Resolution keys off the first selected field: the results route selects
// `eventId` first and is served the flat `rows` feed; the analytics route
// selects its dimension name first (settled | market | selection | band |
// leagueSlug | bucket | period) and, while `analytics` is set, is served the
// matching canned GROUP BY result. A read error rejects exactly once.

const dbState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  readError: null as Error | null,
  lastLimit: null as number | null,
  // Analytics mode — null restores the flat rows feed for the results route.
  analytics: null as Record<string, unknown[]> | null,
}));

vi.mock("@/db", () => {
  const query = (dimension: string) => {
    const builder = {
      where: () => builder,
      orderBy: () => builder,
      groupBy: () => builder,
      limit: (count: number) => {
        dbState.lastLimit = count;
        return builder;
      },
      // Drizzle builders are thenables — awaiting resolves the query.
      then: (
        resolve: (rows: unknown[]) => unknown,
        reject: (reason: unknown) => unknown,
      ): Promise<unknown> => {
        const source = dbState.readError
          ? Promise.reject<never>(dbState.readError)
          : Promise.resolve(
              dbState.analytics
                ? (dbState.analytics[dimension] ?? [])
                : dbState.rows,
            );
        return source.then(resolve, reject);
      },
    };
    return builder;
  };
  return {
    db: {
      select: (fields?: Record<string, unknown>) => ({
        from: () => query(Object.keys(fields ?? {})[0] ?? ""),
      }),
    },
  };
});

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

beforeEach(() => {
  dbState.rows = [];
  dbState.readError = null;
  dbState.lastLimit = null;
  dbState.analytics = null;
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

// ─── GET /api/first-5-minutes/analytics ───────────────────────────────────────

async function getAnalyticsBody(query = "") {
  const response = await getAnalytics(
    new Request(`http://localhost/api/first-5-minutes/analytics${query}`),
  );
  const body = (await response.json()) as First5AnalyticsResponse;
  return { response, body };
}

describe("GET /api/first-5-minutes/analytics", () => {
  beforeEach(() => {
    dbState.analytics = {};
    clearAnalyticsCache();
  });

  it("returns all-zero totals and empty aggregates when performance_log has no first5 rows", async () => {
    const { response, body } = await getAnalyticsBody();
    const zeros = { n: 0, won: 0, lost: 0, realised: 0, claimed: 0, edge: 0 };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.totals).toEqual({
      settled: 0, won: 0, lost: 0, push: 0, void: 0,
      realisedRate: 0, claimedAverage: 0, edge: 0,
    });
    expect(body.byMarket).toEqual([]);
    expect(body.bySelection).toEqual([]);
    expect(body.byConfidence).toEqual([]);
    expect(body.byLeague).toEqual([]);
    expect(body.byBucket).toEqual([]);
    expect(body.trend).toEqual({ last7d: zeros, previous: zeros });
    expect(body.trust).toEqual({ best: [], worst: [] });
  });

  it("aggregates three settled rows (2 WIN, 1 LOSS) in the same market", async () => {
    dbState.analytics = {
      settled: [{ settled: 3, won: 2, lost: 1, push: 0, void: 0, claimed: 0.75 }],
      market: [{ market: "Goal in first 5", n: 3, won: 2, lost: 1, claimed: 0.75 }],
    };

    const { body } = await getAnalyticsBody();
    expect(body.totals.settled).toBe(3);
    expect(body.totals.won).toBe(2);
    expect(body.totals.lost).toBe(1);
    expect(body.totals.realisedRate).toBe(0.667);
    expect(body.byMarket).toHaveLength(1);
    expect(body.byMarket[0]).toMatchObject({
      market: "Goal in first 5",
      n: 3,
      won: 2,
      lost: 1,
      realised: 0.667,
      claimed: 0.75,
      edge: -0.083,
      action: "insufficient",
    });
  });

  it("marks a market with n < 20 as insufficient", async () => {
    dbState.analytics = {
      market: [{ market: "Card in first 5", n: 19, won: 10, lost: 9, claimed: 0.5 }],
    };

    const { body } = await getAnalyticsBody();
    expect(body.byMarket[0].action).toBe("insufficient");
    // The pure rule agrees at the boundary: 20 is the gate.
    expect(actionFor(19, 0.9)).toBe("insufficient");
    expect(actionFor(0, -0.9)).toBe("insufficient");
  });

  it("marks a well-sampled market with a sub-5-point edge as trusted", async () => {
    // 12/25 realised = 0.48, claimed 0.46 → edge +0.02 (2 points).
    dbState.analytics = {
      market: [{ market: "Goal in first 5", n: 25, won: 12, lost: 13, claimed: 0.46 }],
    };

    const { body } = await getAnalyticsBody();
    expect(body.byMarket[0].action).toBe("trusted");
    expect(actionFor(20, 0.04)).toBe("trusted");
    // |edge| == 0.05 is NOT trusted — the band is strict.
    expect(actionFor(25, 0.05)).toBe("watch");
  });

  it("marks a well-sampled market beyond a −15-point edge as avoid", async () => {
    // 10/25 realised = 0.4, claimed 0.6 → edge −0.2 (−20 points).
    dbState.analytics = {
      market: [{ market: "Corner in first 5", n: 25, won: 10, lost: 15, claimed: 0.6 }],
    };

    const { body } = await getAnalyticsBody();
    expect(body.byMarket[0].action).toBe("avoid");
    expect(actionFor(25, -0.2)).toBe("avoid");
    // The boundary is strict: −0.15 itself is not beyond it.
    expect(actionFor(25, -0.15)).toBe("avoid");
    expect(actionFor(25, -0.149)).toBe("watch");
  });

  it("assigns hitRate 0.72 to the 0.70-0.80 calibration bucket", async () => {
    expect(bucketFor(0.72)).toBe("0.70-0.80");
    expect(bucketFor(0.5)).toBe("0.50-0.60");
    expect(bucketFor(0.6)).toBe("0.60-0.70");
    expect(bucketFor(0.9)).toBe("0.90-1.00");
    expect(bucketFor(1)).toBe("0.90-1.00");
    expect(bucketFor(0.49)).toBeNull();
    expect(bucketFor(1.01)).toBeNull();

    // Route level: the bucket row surfaces with its calibration diff.
    dbState.analytics = {
      bucket: [{ bucket: "0.70-0.80", n: 30, won: 22, lost: 8, claimed: 0.74 }],
    };
    const { body } = await getAnalyticsBody();
    expect(body.byBucket).toEqual([
      { bucket: "0.70-0.80", n: 30, realised: 0.733, claimed: 0.74, diff: -0.007 },
    ]);
  });

  it("splits the trend correctly: a row at now-3d is last7d, now-10d is previous", async () => {
    const windows = trendWindows(new Date());
    expect(windows.last7Start).toBe(dayOffset(7));
    expect(windows.previousStart).toBe(dayOffset(14));

    expect(trendPeriodFor(dayOffset(3), windows)).toBe("last7d");
    expect(trendPeriodFor(dayOffset(7), windows)).toBe("last7d");
    expect(trendPeriodFor(dayOffset(10), windows)).toBe("previous");
    expect(trendPeriodFor(dayOffset(14), windows)).toBe("previous");
    expect(trendPeriodFor(dayOffset(20), windows)).toBeNull();

    // Route level: the two SQL period rows land in their own slices.
    dbState.analytics = {
      period: [
        { period: "last7d", n: 4, won: 3, lost: 1, claimed: 0.5 },
        { period: "previous", n: 2, won: 0, lost: 2, claimed: 0.6 },
      ],
    };
    const { body } = await getAnalyticsBody();
    expect(body.trend.last7d).toEqual({
      n: 4, won: 3, lost: 1, realised: 0.75, claimed: 0.5, edge: 0.25,
    });
    expect(body.trend.previous).toEqual({
      n: 2, won: 0, lost: 2, realised: 0, claimed: 0.6, edge: -0.6,
    });
  });

  it("never 500s: a database error answers ok:true with a zeroed payload", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      dbState.readError = new Error("connection refused");
      const { response, body } = await getAnalyticsBody();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.totals).toEqual({
        settled: 0, won: 0, lost: 0, push: 0, void: 0,
        realisedRate: 0, claimedAverage: 0, edge: 0,
      });
      expect(body.byMarket).toEqual([]);
      expect(body.bySelection).toEqual([]);
      expect(body.byConfidence).toEqual([]);
      expect(body.byLeague).toEqual([]);
      expect(body.byBucket).toEqual([]);
      expect(body.trust.best).toEqual([]);
      expect(body.trust.worst).toEqual([]);
      // The contract's log line.
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("caches the payload per windowDays for five minutes", async () => {
    dbState.analytics = {
      market: [{ market: "Goal in first 5", n: 40, won: 20, lost: 20, claimed: 0.5 }],
    };
    const first = await getAnalyticsBody("?days=30");
    expect(first.body.byMarket).toHaveLength(1);

    // The table "empties", but the cached 30-day payload is still served.
    dbState.analytics = {};
    const second = await getAnalyticsBody();
    expect(second.body.byMarket).toHaveLength(1);

    // A different window key misses the cache and reads fresh.
    const third = await getAnalyticsBody("?days=7");
    expect(third.body.windowDays).toBe(7);
    expect(third.body.byMarket).toEqual([]);
  });
});

// ─── AnalyticsSheet ───────────────────────────────────────────────────────────

const ZERO_SPLIT = { n: 0, won: 0, lost: 0, realised: 0, claimed: 0, edge: 0 };

/** A full, well-formed analytics payload with everything testable zeroed out. */
function analyticsPayload(
  overrides: Partial<First5AnalyticsResponse> = {},
): First5AnalyticsResponse {
  return {
    ok: true,
    generatedAt: "2026-09-19T10:00:00Z",
    windowDays: 30,
    totals: {
      settled: 0, won: 0, lost: 0, push: 0, void: 0,
      realisedRate: 0, claimedAverage: 0, edge: 0,
    },
    byMarket: [],
    bySelection: [],
    byConfidence: [],
    byLeague: [],
    byBucket: [],
    trend: { last7d: { ...ZERO_SPLIT }, previous: { ...ZERO_SPLIT } },
    trust: { best: [], worst: [] },
    ...overrides,
  };
}

describe("AnalyticsSheet", () => {
  function sheetFetchMock(payload: unknown) {
    return vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }));
  }

  async function renderSheet(
    fetchMock: ReturnType<typeof sheetFetchMock>,
  ): Promise<HTMLDivElement> {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(AnalyticsSheet, { open: true, onClose: () => {} }));
    });
    // Flush the fetch effect and the state update it triggers.
    await act(async () => {});
    return container;
  }

  it("fetches on open and shows the returned realised and claimed in the summary line", async () => {
    const fetchMock = sheetFetchMock(analyticsPayload({
      totals: {
        settled: 20, won: 12, lost: 6, push: 1, void: 1,
        realisedRate: 0.6, claimedAverage: 0.58, edge: 0.02,
      },
    }));
    const container = await renderSheet(fetchMock);

    expect(fetchMock).toHaveBeenCalledWith("/api/first-5-minutes/analytics", {
      cache: "no-store",
    });
    expect(container.textContent).toContain("20 settled");
    expect(container.textContent).toContain("12W / 6L / 1P / 1V");
    expect(container.textContent).toContain("Realised 60.0%");
    expect(container.textContent).toContain("Claimed 58.0%");
    expect(container.textContent).toContain("Edge +2.0 pts");
  });

  it("appends (low sample) to rows with n < 20 and leaves well-sampled rows alone", async () => {
    const fetchMock = sheetFetchMock(analyticsPayload({
      totals: {
        settled: 28, won: 17, lost: 11, push: 0, void: 0,
        realisedRate: 0.607, claimedAverage: 0.6, edge: 0.007,
      },
      byMarket: [
        {
          market: "Corner in first 5", n: 3, won: 2, lost: 1,
          realised: 0.667, claimed: 0.7, edge: -0.033, action: "insufficient",
        },
        {
          market: "Goal in first 5", n: 25, won: 15, lost: 10,
          realised: 0.6, claimed: 0.58, edge: 0.02, action: "trusted",
        },
      ],
    }));
    const container = await renderSheet(fetchMock);

    const rows = [...container.querySelectorAll("tbody tr")];
    const cornerRow = rows.find((row) => row.textContent?.includes("Corner in first 5"));
    const goalRow = rows.find((row) => row.textContent?.includes("Goal in first 5"));
    expect(cornerRow).toBeDefined();
    expect(cornerRow!.textContent).toContain("(low sample)");
    expect(goalRow).toBeDefined();
    expect(goalRow!.textContent).not.toContain("(low sample)");
  });
});
