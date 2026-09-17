// Value Accumulator — xG cache read/write rules (src/lib/va/xgFetcher.ts).
//
// Everything is mocked: `fetch` is stubbed per test with URL-routed JSON, and
// `@/db` is replaced by a fake that implements only the two chains the cache
// layer uses (select().from().where().limit() and
// insert().values().onConflictDoUpdate()). No real request and no real
// Postgres is ever touched.
//
// The rules under test, as specified:
//   RULE 1  three-layer read: memory → DB cache → HTTP
//   RULE 2  team_xg_cache is valid ONLY while next_match_at is non-null and in
//           the future; a valid row costs zero HTTP calls
//   RULE 3  match_xg_cache is valid forever when is_finished, else for 24h
//   RULE 4  never cache a null/partial xG response
//   RULE 5  fail soft: a DB read error falls through to HTTP, a DB write error
//           still returns the fetched value
//   RULE 6  writes are queued and flushed as ONE batched UPSERT per table
//   RULE 7  next_match_at comes from GET /events/?team_id={id}&limit=1 filtered
//           to status='notstarted'; based_on_through_at is the max kickoff over
//           the finished matches actually averaged

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Fake database ────────────────────────────────────────────────────────────
// Hoisted so the vi.mock("@/db") factory and the tests share one mutable store.
const h = vi.hoisted(() => ({
  /** Rows the fake returns from select().from(<table>), keyed by table name. */
  rows: new Map<string, unknown[]>(),
  /** Every batched write, in order: one entry per UPSERT statement. */
  writes: [] as Array<{ table: string; rows: unknown[] }>,
  failReads: false,
  failWrites: false,
  readCalls: 0,
}));

vi.mock("@/db", async () => {
  // Table identity does not survive vi.resetModules(), the table NAME does — and
  // the tests re-import the fetcher fresh (it reads BZOOIRO_BASE at module
  // scope) exactly like va.test.ts does.
  const { getTableName } = await import("drizzle-orm");
  const nameOf = (table: unknown): string => {
    try {
      return String(getTableName(table as never));
    } catch {
      return "unknown";
    }
  };

  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              h.readCalls += 1;
              if (h.failReads) throw new Error("simulated cache read failure");
              return h.rows.get(nameOf(table)) ?? [];
            },
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (rows: unknown) => ({
          onConflictDoUpdate: async () => {
            if (h.failWrites) throw new Error("simulated cache write failure");
            h.writes.push({ table: nameOf(table), rows: Array.isArray(rows) ? rows : [rows] });
            return [];
          },
        }),
      }),
    },
    keepDbAlive: async () => undefined,
  };
});

const TEAM_TABLE = "team_xg_cache";
const MATCH_TABLE = "match_xg_cache";

// ── Fetch stub ───────────────────────────────────────────────────────────────

interface FetchRoute {
  match: (url: string) => boolean;
  body: unknown;
  status?: number;
}

/** Stub global fetch with URL-routed JSON responses; returns the mock. */
function stubFetch(routes: FetchRoute[]) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const route = routes.find((r) => r.match(url));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.body,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const statsBody = (home: unknown, away: unknown) => ({
  stats: { home: { xg: home }, away: { xg: away } },
});

/** The team's last-5 finished matches: 101 is home in 3001/3003, away in 3002. */
const finishedListBody = (rows: Array<Record<string, unknown>>) => ({
  count: rows.length,
  next: null,
  previous: null,
  results: rows,
});

const THREE_FINISHED = [
  { id: 3001, home_team_id: 101, away_team_id: 202, event_date: "2026-09-10", status: "finished" },
  { id: 3002, home_team_id: 202, away_team_id: 101, event_date: "2026-09-03", status: "finished" },
  { id: 3003, home_team_id: 101, away_team_id: 303, event_date: "2026-08-27", status: "finished" },
];

const THREE_FINISHED_STATS: FetchRoute[] = [
  { match: (u) => u.endsWith("/events/3001/stats/"), body: statsBody({ actual: 2.0 }, { actual: 1.0 }) },
  { match: (u) => u.endsWith("/events/3002/stats/"), body: statsBody({ actual: 0.5 }, { actual: 1.5 }) },
  { match: (u) => u.endsWith("/events/3003/stats/"), body: statsBody({ actual: 1.1 }, { actual: 0.9 }) },
];

/** xgFor = (2.0 + 1.5 + 1.1)/3 = 1.53, xgAgainst = (1.0 + 0.5 + 0.9)/3 = 0.80. */
const TEAM_101_AVERAGE = { teamId: 101, xgFor: 1.53, xgAgainst: 0.8, samples: 3 };

/** Routes: the finished list for team 101 plus its three match stats. */
function teamRoutes(extra: FetchRoute[] = []): FetchRoute[] {
  return [
    ...extra,
    {
      match: (u) => u.includes("/events/?team_id=101") && u.includes("status=finished"),
      body: finishedListBody(THREE_FINISHED),
    },
    ...THREE_FINISHED_STATS,
  ];
}

/** GET /events/?team_id=101&limit=1 → RULE 7's next_match_at lookup. */
function nextMatchRoute(body: unknown): FetchRoute {
  return { match: (u) => u.includes("/events/?team_id=101") && u.endsWith("&limit=1"), body };
}

function teamCacheRow(overrides: Record<string, unknown> = {}) {
  return {
    teamId: 101,
    xgFor: "1.53",
    xgAgainst: "0.80",
    samples: 3,
    basedOnThroughAt: new Date("2026-09-10T00:00:00Z"),
    nextMatchAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(),
    ...overrides,
  };
}

function matchCacheRow(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "223510",
    homeXg: "1.82",
    awayXg: "0.75",
    isFinished: true,
    updatedAt: new Date(),
    ...overrides,
  };
}

/** xgFetcher reads BZOOIRO_BASE at module scope → every test gets a fresh copy. */
async function freshXgModule() {
  vi.resetModules();
  return import("./xgFetcher");
}

function writesFor(table: string): Array<{ table: string; rows: unknown[] }> {
  return h.writes.filter((w) => w.table === table);
}

beforeEach(() => {
  vi.stubEnv("BZOOIRO_KEY", "test-key");
  vi.stubEnv("BZOOIRO_BASE", "https://sports.bzzoiro.test/api/v2");
  h.rows.clear();
  h.writes.length = 0;
  h.failReads = false;
  h.failWrites = false;
  h.readCalls = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Value Accumulator — team_xg_cache (RULE 1, 2, 6, 7)", () => {
  it("1. cache HIT: a row whose next_match_at is in the future costs ZERO HTTP calls", async () => {
    const { fetchTeamXgAverage, flushXgCache } = await freshXgModule();
    // No routes at all: any request would throw "unexpected fetch".
    const fetchMock = stubFetch([]);
    h.rows.set(TEAM_TABLE, [teamCacheRow({ nextMatchAt: new Date(Date.now() + 60_000) })]);

    await expect(fetchTeamXgAverage(101, 5)).resolves.toEqual(TEAM_101_AVERAGE);

    expect(fetchMock).toHaveBeenCalledTimes(0);

    // A hit also queues nothing, so the end-of-scan flush adds no request either
    // (RULE 7's next_match_at lookup only runs for rows we actually refetched).
    await flushXgCache();
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(writesFor(TEAM_TABLE)).toHaveLength(0);
  });

  it("1b. a second read in the same scan is served from memory (still zero HTTP)", async () => {
    const { fetchTeamXgAverage } = await freshXgModule();
    const fetchMock = stubFetch([]);
    h.rows.set(TEAM_TABLE, [teamCacheRow()]);

    await fetchTeamXgAverage(101, 5);
    await fetchTeamXgAverage(101, 5);

    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(h.readCalls).toBe(1); // layer 1 answered the second call
  });

  it("2. cache MISS (the team played): next_match_at in the past → refetch from Bzzoiro", async () => {
    const { fetchTeamXgAverage } = await freshXgModule();
    // The stale row claims 9.99; the refetch must win with the real average.
    h.rows.set(TEAM_TABLE, [
      teamCacheRow({ xgFor: "9.99", xgAgainst: "9.99", samples: 1, nextMatchAt: new Date(Date.now() - 60_000) }),
    ]);
    const fetchMock = stubFetch(teamRoutes());

    await expect(fetchTeamXgAverage(101, 5)).resolves.toEqual(TEAM_101_AVERAGE);

    // 1 finished-list call + 3 match-stats calls — the DB row was NOT trusted.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("3. cache MISS (next_match_at NULL) → refetch from Bzzoiro", async () => {
    const { fetchTeamXgAverage } = await freshXgModule();
    h.rows.set(TEAM_TABLE, [teamCacheRow({ xgFor: "9.99", nextMatchAt: null })]);
    const fetchMock = stubFetch(teamRoutes());

    await expect(fetchTeamXgAverage(101, 5)).resolves.toEqual(TEAM_101_AVERAGE);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("4. postponed match: the refetch finds no NEW finished match, writes the rescheduled next_match_at, and the next read is a hit", async () => {
    const { fetchTeamXgAverage, flushXgCache, __clearXgCacheForTests } = await freshXgModule();
    const rescheduled = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);

    // The row went stale because the fixture it pointed at was postponed.
    h.rows.set(TEAM_TABLE, [teamCacheRow({ nextMatchAt: new Date(Date.now() - 60_000) })]);
    const rescheduledEvent = {
      id: 4001,
      event_date: rescheduled.toISOString(),
      status: "notstarted",
    };
    const fetchMock = stubFetch(teamRoutes([nextMatchRoute(finishedListBody([rescheduledEvent]))]));

    // Same three finished matches as before → the same average, refetched.
    await expect(fetchTeamXgAverage(101, 5)).resolves.toEqual(TEAM_101_AVERAGE);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);

    await flushXgCache();
    const writes = writesFor(TEAM_TABLE);
    expect(writes).toHaveLength(1);
    const written = writes[0].rows[0] as Record<string, unknown>;
    // next_match_at now points at the rescheduled kickoff, not the postponed one.
    expect(new Date(written.nextMatchAt as string | Date).getTime()).toBe(rescheduled.getTime());

    // Second read: the refreshed row is in the DB, so it is a cache hit again.
    h.rows.set(TEAM_TABLE, [writes[0].rows[0]]);
    __clearXgCacheForTests(); // drop layer 1 so only the DB row can answer
    fetchMock.mockClear();

    await expect(fetchTeamXgAverage(101, 5)).resolves.toEqual(TEAM_101_AVERAGE);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("5. no upcoming matches → next_match_at is written as NULL (which makes the row stale by rule 2)", async () => {
    const { fetchTeamXgAverage, flushXgCache } = await freshXgModule();
    // The only event returned is already finished, so nothing is 'notstarted'.
    stubFetch(
      teamRoutes([
        nextMatchRoute(
          finishedListBody([{ id: 3001, event_date: "2026-09-10", status: "finished" }]),
        ),
      ]),
    );

    await expect(fetchTeamXgAverage(101, 5)).resolves.toEqual(TEAM_101_AVERAGE);
    await flushXgCache();

    const writes = writesFor(TEAM_TABLE);
    expect(writes).toHaveLength(1);
    expect((writes[0].rows[0] as Record<string, unknown>).nextMatchAt).toBeNull();
  });

  it("6. first write populates both timestamps: based_on_through_at = max kickoff AVERAGED, next_match_at = next fixture", async () => {
    const { fetchTeamXgAverage, flushXgCache } = await freshXgModule();
    const nextKickoff = new Date("2026-09-21T18:45:00Z");

    // A fourth, MORE RECENT finished match carries no xG yet, so it is not part
    // of the average and must not become based_on_through_at.
    stubFetch([
      nextMatchRoute(finishedListBody([{ id: 4002, event_date: nextKickoff.toISOString(), status: "notstarted" }])),
      {
        match: (u) => u.includes("/events/?team_id=101") && u.includes("status=finished"),
        body: finishedListBody([
          { id: 3000, home_team_id: 101, away_team_id: 404, event_date: "2026-09-14", status: "finished" },
          ...THREE_FINISHED,
        ]),
      },
      {
        match: (u) => u.endsWith("/events/3000/stats/"),
        body: statsBody({ actual: null, estimated: null }, { actual: null, estimated: null }),
      },
      ...THREE_FINISHED_STATS,
    ]);

    await expect(fetchTeamXgAverage(101, 5)).resolves.toEqual(TEAM_101_AVERAGE);
    await flushXgCache();

    const writes = writesFor(TEAM_TABLE);
    expect(writes).toHaveLength(1);
    const row = writes[0].rows[0] as Record<string, unknown>;
    expect(row.teamId).toBe(101);
    expect(row.xgFor).toBe("1.53");
    expect(row.xgAgainst).toBe("0.8");
    expect(row.samples).toBe(3);
    // 2026-09-14 (no xG) is excluded; 2026-09-10 is the newest averaged match.
    expect(new Date(row.basedOnThroughAt as string | Date).toISOString().slice(0, 10)).toBe("2026-09-10");
    expect(new Date(row.nextMatchAt as string | Date).getTime()).toBe(nextKickoff.getTime());
  });

  it("6b. no cache row at all → refetch, and nothing is written until the flush", async () => {
    const { fetchTeamXgAverage, flushXgCache } = await freshXgModule();
    const fetchMock = stubFetch(teamRoutes([nextMatchRoute(finishedListBody([]))]));

    await expect(fetchTeamXgAverage(101, 5)).resolves.toEqual(TEAM_101_AVERAGE);
    expect(writesFor(TEAM_TABLE)).toHaveLength(0); // RULE 6: never write per response

    await flushXgCache();
    expect(writesFor(TEAM_TABLE)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(5); // list + 3 stats + next_match_at
  });

  it("6c. a team with no finished matches with xG writes nothing (RULE 4)", async () => {
    const { fetchTeamXgAverage, flushXgCache } = await freshXgModule();
    stubFetch([
      {
        match: (u) => u.includes("/events/?team_id=101") && u.includes("status=finished"),
        body: finishedListBody(THREE_FINISHED),
      },
      {
        match: (u) => u.endsWith("/stats/"),
        body: statsBody({ actual: null, estimated: null }, { actual: null, estimated: null }),
      },
    ]);

    await expect(fetchTeamXgAverage(101, 5)).resolves.toBeNull();
    await flushXgCache();
    expect(writesFor(TEAM_TABLE)).toHaveLength(0);
  });
});

describe("Value Accumulator — match_xg_cache (RULE 3, 4)", () => {
  it("7. is_finished=true is served from the cache regardless of age (zero HTTP)", async () => {
    const { fetchMatchXg } = await freshXgModule();
    const fetchMock = stubFetch([]);
    h.rows.set(MATCH_TABLE, [
      matchCacheRow({ isFinished: true, updatedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) }),
    ]);

    await expect(fetchMatchXg("223510")).resolves.toEqual({
      homeXg: 1.82,
      awayXg: 0.75,
      source: "bzzoiro-match",
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("7b. is_finished=false is served within 24h and refetched after it", async () => {
    // Fresh estimate → hit.
    const fresh = await freshXgModule();
    const freshFetch = stubFetch([]);
    h.rows.set(MATCH_TABLE, [
      matchCacheRow({ isFinished: false, updatedAt: new Date(Date.now() - 60 * 60 * 1000) }),
    ]);
    await expect(fresh.fetchMatchXg("223510")).resolves.toEqual({
      homeXg: 1.82,
      awayXg: 0.75,
      source: "bzzoiro-match",
    });
    expect(freshFetch).toHaveBeenCalledTimes(0);

    // 25h old estimate → expired, so the HTTP layer answers.
    const { fetchMatchXg, __clearXgCacheForTests } = await freshXgModule();
    __clearXgCacheForTests();
    h.rows.set(MATCH_TABLE, [
      matchCacheRow({ isFinished: false, updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }),
    ]);
    const fetchMock = stubFetch([
      {
        match: (u) => u.endsWith("/events/223510/stats/"),
        body: statsBody({ actual: 2.1 }, { actual: 0.4 }),
      },
    ]);

    await expect(fetchMatchXg("223510")).resolves.toEqual({
      homeXg: 2.1,
      awayXg: 0.4,
      source: "bzzoiro-match",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("8. a null xG response writes NO cache row (RULE 4) — the next call retries", async () => {
    const { fetchMatchXg, flushXgCache } = await freshXgModule();
    stubFetch([
      {
        match: (u) => u.endsWith("/events/999/stats/"),
        body: statsBody({ actual: null, estimated: null }, { actual: null, estimated: null }),
      },
    ]);

    await expect(fetchMatchXg("999")).resolves.toBeNull();
    await flushXgCache();

    expect(writesFor(MATCH_TABLE)).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
  });

  it("8b. a one-sided response is returned but not cached (both columns are NOT NULL)", async () => {
    const { fetchMatchXg, flushXgCache } = await freshXgModule();
    stubFetch([
      {
        match: (u) => u.endsWith("/events/998/stats/"),
        body: statsBody({ actual: 1.4 }, { actual: null, estimated: null }),
      },
    ]);

    await expect(fetchMatchXg("998")).resolves.toEqual({
      homeXg: 1.4,
      awayXg: null,
      source: "bzzoiro-match",
    });
    await flushXgCache();
    expect(writesFor(MATCH_TABLE)).toHaveLength(0);
  });

  it("8c. full-time ('actual') stats are queued as is_finished=true, estimates as false", async () => {
    const { fetchMatchXg, flushXgCache } = await freshXgModule();
    stubFetch([
      { match: (u) => u.endsWith("/events/901/stats/"), body: statsBody({ actual: 1.2 }, { actual: 0.8 }) },
      { match: (u) => u.endsWith("/events/902/stats/"), body: statsBody({ estimated: 1.1 }, { estimated: 0.9 }) },
    ]);

    await fetchMatchXg("901");
    await fetchMatchXg("902");
    await flushXgCache();

    const writes = writesFor(MATCH_TABLE);
    expect(writes).toHaveLength(1);
    const rows = writes[0].rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.eventId === "901")?.isFinished).toBe(true);
    expect(rows.find((r) => r.eventId === "902")?.isFinished).toBe(false);
    // numeric columns are written as strings
    expect(rows.find((r) => r.eventId === "901")?.homeXg).toBe("1.2");
  });

  it("9. resetXgCacheQueue + 3 fetches + flushXgCache = exactly ONE batched write", async () => {
    const { fetchMatchXg, flushXgCache, resetXgCacheQueue } = await freshXgModule();
    stubFetch([
      { match: (u) => u.endsWith("/stats/"), body: statsBody({ actual: 1.5 }, { actual: 0.5 }) },
    ]);

    resetXgCacheQueue();
    await fetchMatchXg("901");
    await fetchMatchXg("902");
    await fetchMatchXg("903");
    // …and a repeat, which must be deduped rather than written twice.
    await fetchMatchXg("901");

    // RULE 6: nothing was written while fetching.
    expect(h.writes).toHaveLength(0);

    await flushXgCache();
    const writes = writesFor(MATCH_TABLE);
    expect(writes).toHaveLength(1); // ONE statement
    expect(writes[0].rows).toHaveLength(3); // …carrying all three events

    // The queue is empty afterwards, so a second flush is a no-op.
    await flushXgCache();
    expect(writesFor(MATCH_TABLE)).toHaveLength(1);
  });

  it("9b. resetXgCacheQueue drops writes queued by an earlier, aborted scan", async () => {
    const { fetchMatchXg, flushXgCache, resetXgCacheQueue } = await freshXgModule();
    stubFetch([
      { match: (u) => u.endsWith("/stats/"), body: statsBody({ actual: 1.5 }, { actual: 0.5 }) },
    ]);

    await fetchMatchXg("910");
    resetXgCacheQueue(); // a new scan starts
    await fetchMatchXg("911");
    await flushXgCache();

    const writes = writesFor(MATCH_TABLE);
    expect(writes).toHaveLength(1);
    expect(writes[0].rows).toHaveLength(1);
    expect((writes[0].rows[0] as Record<string, unknown>).eventId).toBe("911");
  });

  it("9c. a next_match_at lookup that blows up still banks the row (with next_match_at NULL)", async () => {
    const { fetchTeamXgAverage, flushXgCache } = await freshXgModule();
    // The RULE 7 lookup answers with a shape the normaliser cannot walk
    // (results is an object, not an array). One team's failure must not throw
    // away the batched write — the average was already paid for.
    stubFetch(teamRoutes([nextMatchRoute({ count: 1, results: { notAnArray: true } })]));

    await expect(fetchTeamXgAverage(101, 5)).resolves.toEqual(TEAM_101_AVERAGE);
    await expect(flushXgCache()).resolves.toBeUndefined();

    const writes = writesFor(TEAM_TABLE);
    expect(writes).toHaveLength(1);
    const row = writes[0].rows[0] as Record<string, unknown>;
    expect(row.teamId).toBe(101);
    expect(row.xgFor).toBe("1.53");
    expect(row.xgAgainst).toBe("0.8");
    expect(row.samples).toBe(3);
    // NULL makes the row stale by RULE 2 — the safe direction: the next scan
    // refetches instead of trusting an average that may have moved.
    expect(row.nextMatchAt).toBeNull();
  });
});

describe("Value Accumulator — cache fail-soft (RULE 5)", () => {
  it("a cache READ error falls through to HTTP and still returns real data", async () => {
    const { fetchTeamXgAverage, fetchMatchXg } = await freshXgModule();
    h.failReads = true;
    h.rows.set(TEAM_TABLE, [teamCacheRow()]);
    h.rows.set(MATCH_TABLE, [matchCacheRow()]);
    const fetchMock = stubFetch([
      ...teamRoutes(),
      { match: (u) => u.endsWith("/events/223510/stats/"), body: statsBody({ actual: 1.9 }, { actual: 0.6 }) },
    ]);

    await expect(fetchTeamXgAverage(101, 5)).resolves.toEqual(TEAM_101_AVERAGE);
    await expect(fetchMatchXg("223510")).resolves.toEqual({
      homeXg: 1.9,
      awayXg: 0.6,
      source: "bzzoiro-match",
    });
    expect(fetchMock.mock.calls.length).toBe(5); // 4 for the team + 1 for the match
  });

  it("a cache WRITE error still returns the fetched value and never breaks the flush", async () => {
    const { fetchMatchXg, fetchTeamXgAverage, flushXgCache } = await freshXgModule();
    h.failWrites = true;
    stubFetch(teamRoutes([nextMatchRoute(finishedListBody([]))]));

    await expect(fetchTeamXgAverage(101, 5)).resolves.toEqual(TEAM_101_AVERAGE);
    await expect(fetchMatchXg("3001")).resolves.toEqual({
      homeXg: 2.0,
      awayXg: 1.0,
      source: "bzzoiro-match",
    });

    // Throwing here would fail the scan that called it — it must not.
    await expect(flushXgCache()).resolves.toBeUndefined();
    expect(h.writes).toHaveLength(0);
  });
});
