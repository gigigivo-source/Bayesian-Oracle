// Value Accumulator — parallel fixture processing through the shared scan
// function (PHASE 3 of the xG-cache/parallel/background-jobs change).
//
// performScan → scanValueLegs → scanner.runScan processes fixtures with
// runFixtureBatches (re-exported from ./performScan, implemented in ./parallel):
//   RULE 1 at most FIXTURE_BATCH_SIZE (8) fixtures in flight
//   RULE 2 results are pre-sized and index-addressed → output order == input
//          order, no matter which fixture finishes first
//   RULE 3 a fixture that throws is logged and nulled; the batch carries on
//
// Everything external is mocked: ESPN (fixtures/summaries), Bzzoiro (event
// resolution + odds), the engine, the xG cache layer and Postgres. No network,
// no database.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FixtureLite } from "@/lib/espn";
import type { BzzoiroResolution, VaBookmakerOdds } from "./oddsFetcher";

// ── Fake database ────────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  /** Every insert, in order, with the drizzle table object it targeted. */
  inserts: [] as Array<{ table: unknown; rows: unknown[] }>,
  deletes: 0,
  updates: 0,
  nextId: 0,
}));

/** Chainable thenable: supports select().from().where().orderBy().limit(). */
function fakeQuery(rows: unknown[]): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  self.where = () => self;
  self.orderBy = () => self;
  self.limit = () => self;
  self.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return self;
}

vi.mock("@/db", () => ({
  db: {
    insert: (table: unknown) => ({
      values: (rows: unknown) => {
        h.inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
        const pending = Promise.resolve([]) as unknown as Promise<Array<{ id: number }>> & {
          returning: (cols?: unknown) => Promise<Array<{ id: number }>>;
          onConflictDoUpdate: (cfg?: unknown) => Promise<Array<{ id: number }>>;
        };
        pending.returning = () => Promise.resolve([{ id: (h.nextId += 1) }]);
        pending.onConflictDoUpdate = () => Promise.resolve([]);
        return pending;
      },
    }),
    select: () => ({ from: () => fakeQuery([]) }),
    delete: () => {
      h.deletes += 1;
      const self: Record<string, unknown> = {};
      self.where = () => Promise.resolve([]);
      self.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject);
      return self;
    },
    update: () => ({
      set: () => ({
        where: () => {
          h.updates += 1;
          return Promise.resolve([]);
        },
      }),
    }),
  },
  keepDbAlive: async () => undefined,
}));

// @/db/schema is deliberately NOT mocked: the real table objects let the
// assertions tell va_legs rows from va_tickets rows, and importing it has no
// side effects (no connection, no env requirement).

// ── External boundaries ──────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const resolveBzzoiroEvent = vi.fn<(fx: FixtureLite) => Promise<BzzoiroResolution>>();
const fetchOddsForEvent = vi.fn(async (_eventId: string): Promise<VaBookmakerOdds[]> => []);
const fetchScoreboard = vi.fn(async (_slug: string, _range: string): Promise<FixtureLite[]> => []);

vi.mock("@/lib/espn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/espn")>();
  return {
    ...actual,
    fetchScoreboard: (slug: string, range: string) => fetchScoreboard(slug, range),
    fetchSummary: vi.fn(async () => null),
  };
});

vi.mock("./oddsFetcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./oddsFetcher")>();
  return {
    ...actual,
    resolveBzzoiroEvent: (fx: FixtureLite) => resolveBzzoiroEvent(fx),
    fetchOddsForEvent: (eventId: string) => fetchOddsForEvent(eventId),
  };
});

// One qualifying stack market per fixture (odds 1.2, hitRate 0.63, family goals)
// — the same shape scannerCoverage.test.ts uses, so each fixture yields one leg.
vi.mock("@/lib/engine", () => ({
  runEngineFromReal: () => ({
    match: { dataCompletenessScore: 80 },
    markets: [
      { name: "Total Goals O/U 2.5", selection: "Over 2.5", family: "goals", hitRate: 0.63, ev: -0.02 },
    ],
  }),
}));

// The xG cache layer has its own suite (xgFetcher.test.ts); stub it out so this
// file measures scheduling, not HTTP.
const resetXgCacheQueue = vi.fn(() => undefined);
const flushXgCache = vi.fn(async () => undefined);
vi.mock("./xgFetcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./xgFetcher")>();
  return {
    ...actual,
    fetchEventDetail: vi.fn(async () => null),
    fetchMatchTeamXg: vi.fn(async () => ({ home: null, away: null })),
    fetchMatchXg: vi.fn(async () => null),
    resetXgCacheQueue: () => resetXgCacheQueue(),
    flushXgCache: () => flushXgCache(),
  };
});

// ── Fixtures ─────────────────────────────────────────────────────────────────
function fixture(index: number): FixtureLite {
  const id = `fx-${index}`;
  const team = (side: "home" | "away") => ({
    id: `${id}-${side}`,
    name: `${side === "home" ? "Home" : "Away"} ${index}`,
    shortName: `${side} ${index}`,
    abbrev: side.toUpperCase(),
    logo: null,
    color: null,
    score: null,
    homeAway: side,
  });
  return {
    id,
    leagueSlug: "eng.1",
    leagueName: "Premier League",
    // Ascending kickoffs: the scanner sorts by league tier then date, so the
    // fixture order below is the order the scan must preserve.
    date: new Date(Date.UTC(2026, 8, 20, 12 + index, 0, 0)).toISOString(),
    state: "pre",
    statusDetail: "Scheduled",
    venue: null,
    home: team("home"),
    away: team("away"),
    neutralSite: false,
  } as unknown as FixtureLite;
}

function fixtures(count: number): FixtureLite[] {
  return Array.from({ length: count }, (_, i) => fixture(i));
}

function resolved(eventId: string): BzzoiroResolution {
  return { eventId, status: "resolved", eventsInRange: 30, relatedInRange: 3, toleranceDays: 2 };
}

const STACK_ODDS: VaBookmakerOdds[] = [
  { bookmaker: "1xBet", marketLabel: "Goals Over/Under", line: 2.5, selection: "Over 2.5", odds: 1.2 },
];

/** Concurrency probe: how many resolveBzzoiroEvent calls overlap, and in what order they finish. */
function instrumentResolution(delayFor: (fx: FixtureLite, index: number) => number) {
  const probe = { inFlight: 0, maxInFlight: 0, completionOrder: [] as string[] };
  resolveBzzoiroEvent.mockImplementation(async (fx) => {
    const index = Number(fx.id.replace("fx-", ""));
    probe.inFlight += 1;
    probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
    await sleep(delayFor(fx, index));
    probe.inFlight -= 1;
    probe.completionOrder.push(fx.id);
    return resolved(fx.id);
  });
  return probe;
}

async function legRows(): Promise<Array<Record<string, unknown>>> {
  const { vaLegs } = await import("@/db/schema");
  return h.inserts
    .filter((insert) => insert.table === vaLegs)
    .flatMap((insert) => insert.rows as Array<Record<string, unknown>>);
}

beforeEach(() => {
  h.inserts.length = 0;
  h.deletes = 0;
  h.updates = 0;
  h.nextId = 0;
  vi.clearAllMocks();
  fetchScoreboard.mockResolvedValue([]);
  fetchOddsForEvent.mockResolvedValue(STACK_ODDS);
  resetXgCacheQueue.mockClear();
  flushXgCache.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Value Accumulator — performScan processes fixtures in parallel", () => {
  it("10. eight 60ms fixtures finish in well under 3× a single fixture", async () => {
    const eight = fixtures(8);
    fetchScoreboard.mockImplementation(async (slug) => (slug === "eng.1" ? eight : []));
    const PER_FIXTURE_MS = 60;
    const probe = instrumentResolution(() => PER_FIXTURE_MS);

    const { performScan } = await import("./performScan");
    const startedAt = Date.now();
    const result = await performScan("stack", false);
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.matchesScanned).toBe(8);

    // Sequential would be 8 × 60ms = 480ms; one batch of 8 is ~60ms.
    expect(elapsed).toBeLessThan(3 * PER_FIXTURE_MS);
    // All eight really were in flight together, and never more than the batch size.
    expect(probe.maxInFlight).toBeGreaterThan(1);
    expect(probe.maxInFlight).toBeLessThanOrEqual(8);
  });

  it("10b. never more than FIXTURE_BATCH_SIZE fixtures in flight, and the batch count follows", async () => {
    const twenty = fixtures(20);
    fetchScoreboard.mockImplementation(async (slug) => (slug === "eng.1" ? twenty : []));
    const { FIXTURE_BATCH_SIZE } = await import("./performScan");
    expect(FIXTURE_BATCH_SIZE).toBe(8);
    const probe = instrumentResolution(() => 20);

    const { performScan } = await import("./performScan");
    const startedAt = Date.now();
    await performScan("stack", false);
    const elapsed = Date.now() - startedAt;

    expect(probe.maxInFlight).toBeLessThanOrEqual(FIXTURE_BATCH_SIZE);
    expect(probe.completionOrder).toHaveLength(20);
    // 20 fixtures = 3 batches (8 + 8 + 4) × 20ms, not 20 × 20ms.
    expect(elapsed).toBeLessThan(3 * 20 + 250);
    expect(elapsed).toBeLessThan(20 * 20);
  });

  it("10c. one fixture throwing does not abort the batch (RULE 3)", async () => {
    const { runFixtureBatches } = await import("./performScan");
    const seen: number[] = [];

    const results = await runFixtureBatches<number, number>(
      [0, 1, 2, 3],
      async (item, index) => {
        seen.push(index);
        if (item === 2) throw new Error("boom");
        return item * 10;
      },
      8,
      (item) => `item-${item}`,
    );

    expect(seen).toEqual([0, 1, 2, 3]); // every fixture was attempted
    expect(results).toEqual([0, 10, null, 30]); // the failure is nulled, in place
    expect(console.error).toHaveBeenCalled();
  });

  it("11. legs stay in fixture order even when fixtures finish in reverse", async () => {
    const eight = fixtures(8);
    fetchScoreboard.mockImplementation(async (slug) => (slug === "eng.1" ? eight : []));
    // fx-0 is the SLOWEST and fx-7 the fastest: completion order is the reverse
    // of fixture order, so any push()-based collection would reorder the legs.
    const probe = instrumentResolution((_fx, index) => (8 - index) * 15);

    const { performScan } = await import("./performScan");
    const result = await performScan("stack", false);

    expect(result.body.ok).toBe(true);
    expect(probe.completionOrder[0]).toBe("fx-7"); // genuinely out of order
    expect(probe.completionOrder).not.toEqual(eight.map((fx) => fx.id));
    expect(probe.maxInFlight).toBeGreaterThan(1);

    const legs = await legRows();
    expect(legs.map((leg) => leg.eventId)).toEqual(eight.map((fx) => fx.id));
    expect(legs).toHaveLength(8);
  });

  it("11b. the scan banks its xG cache writes once, at the end (RULE 6 wiring)", async () => {
    fetchScoreboard.mockImplementation(async (slug) => (slug === "eng.1" ? fixtures(3) : []));
    resolveBzzoiroEvent.mockImplementation(async (fx) => resolved(fx.id));

    const { performScan } = await import("./performScan");
    await performScan("stack", false);

    expect(resetXgCacheQueue).toHaveBeenCalledTimes(1);
    expect(flushXgCache).toHaveBeenCalledTimes(1);
    // Reset before the scan, flush after it — never in the other order.
    expect(resetXgCacheQueue.mock.invocationCallOrder[0]).toBeLessThan(
      flushXgCache.mock.invocationCallOrder[0],
    );
  });

  it("11c. a scan that fails still flushes its cache queue and releases the lock", async () => {
    fetchScoreboard.mockImplementation(async () => {
      throw new Error("ESPN down");
    });
    resolveBzzoiroEvent.mockImplementation(async (fx) => resolved(fx.id));

    const { performScan } = await import("./performScan");
    const result = await performScan("stack", false);

    // fetchMatchesForLeague swallows per-league errors, so the scan completes
    // with zero matches rather than failing — either way the flush must run.
    expect(flushXgCache).toHaveBeenCalledTimes(1);
    expect(result.body.ok).toBe(true);
    expect(result.body.matchesScanned).toBe(0);
    expect(h.deletes).toBeGreaterThan(0); // foreground scan released its lock row
  });
});
