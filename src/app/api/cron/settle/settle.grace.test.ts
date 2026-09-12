// Grace-window settlement tests for the cron route (Parts 1–3 at the DB layer):
//
//   · a feature pick on a FINISHED match whose stats never arrived stays
//     PENDING inside the 24h grace window and is VOIDED (stake returned) once
//     the window has elapsed — never stuck pending forever;
//   · the performance-log refresh resolves stale Top-10 markets from the
//     multi-source boxscore (stat families the ESPN boxscore key space cannot
//     see, e.g. throw-ins) and writes VOID for the ones no source has, so the
//     dashboard's per-market statuses become WIN/LOSS/PUSH/VOID — with VOID
//     excluded from wins/losses in the accuracy maths.
//
// The route imports @/db statically, so the db layer is mocked with the same
// chainable proxy the main settle test uses. Providers are stubbed at their
// module boundaries.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyTeamStats, type CanonicalMatchStats } from "@/lib/data/types";

const mocks = vi.hoisted(() => ({
  terminals: [] as Array<unknown>,
  updates: [] as Array<Record<string, unknown>>,
  peek: vi.fn(),
  fetch: vi.fn(async (_query?: unknown): Promise<unknown> => null),
  lookupResult: vi.fn(),
  runOracle: vi.fn(),
  evaluateFinished: vi.fn(),
  espnJson: vi.fn(async () => null),
}));

vi.mock("@/db", () => {
  const makeChain = (): unknown => {
    const consume = () => Promise.resolve(mocks.terminals.shift());
    const chain: unknown = new Proxy(function () {} as unknown as () => unknown, {
      get(_target, prop) {
        if (prop === "then") {
          return (onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) =>
            consume().then(onFulfilled, onRejected);
        }
        if (prop === "set") {
          return (value: Record<string, unknown>) => {
            mocks.updates.push(value);
            return chain;
          };
        }
        if (prop === "returning") return () => consume();
        return chain;
      },
      apply() {
        return chain;
      },
    });
    return chain;
  };
  return { db: new Proxy({}, { get: () => makeChain() }) };
});

vi.mock("@/lib/data/aggregator", () => ({
  statsAggregator: { peek: mocks.peek, fetch: mocks.fetch },
}));

vi.mock("../daily-picks/route", () => ({
  fetchEspnBoxscore: vi.fn(async () => null),
  lookupMultiSourceResult: mocks.lookupResult,
  resultFromFixture: vi.fn(() => null),
  statsToBoxscore: vi.fn(() => null),
}));

vi.mock("@/app/api/fixtures/route", () => ({
  GET: vi.fn(async () => Response.json({ fixtures: [] })),
}));

vi.mock("@/lib/httpClient", () => ({ resilientJson: mocks.espnJson }));

vi.mock("@/lib/engine/oracle", () => ({
  runOracleWithStandings: mocks.runOracle,
}));

vi.mock("@/lib/engine", () => ({
  evaluateFinishedMatch: mocks.evaluateFinished,
}));

const { settleFeaturePicks, refreshPendingPerformanceRows } = await import("./route");
const { clearSettlementBoxscoreCache } = await import("@/lib/settlement/results");

const HOUR = 3_600_000;

function dayOffset(hours: number): string {
  return new Date(Date.now() - hours * HOUR).toISOString().slice(0, 10);
}

function cornerStats(eventId: string): CanonicalMatchStats {
  return {
    home: { ...emptyTeamStats(), corners: 6 },
    away: { ...emptyTeamStats(), corners: 5 },
    metadata: { source: "API-Football", fetchedAt: "", matchDate: "", leagueSlug: "eng.1", eventId } as CanonicalMatchStats["metadata"],
  };
}

// ─── Feature picks: stale pending → VOID, fresh pending → wait ────────────────

function makeFeatureRow(overrides: Record<string, unknown>) {
  return {
    id: 301,
    eventId: "5501",
    matchLabel: "Arsenal vs Chelsea",
    homeTeam: "Arsenal",
    awayTeam: "Chelsea",
    league: "English Premier League",
    leagueSlug: "eng.1",
    competitionName: "English Premier League",
    matchDate: dayOffset(72),
    homeScore: 2,
    awayScore: 1,
    totalPicks: 1,
    hits: 0,
    misses: 0,
    pending: 0,
    accuracy: 0,
    top10Detail: [{ name: "Total Corners O/U 9.5", selection: "Over 9.5", outcome: "PENDING" }],
    lowConfidence: false,
    rankingMode: "S",
    feature: "corners",
    market: "Total Corners O/U 9.5",
    selection: "Over 9.5",
    outcome: "pending",
    hitRate: 0.72,
    confidence: "HIGH",
    settledAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("settleFeaturePicks — 24h stats-void grace", () => {
  let logs: string[] = [];

  beforeEach(() => {
    clearSettlementBoxscoreCache();
    vi.clearAllMocks();
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
  });

  it("VOIDs a stale pick whose boxscore never arrived (stake returned, guarded write)", async () => {
    const row = makeFeatureRow({});
    mocks.terminals = [{ rowCount: 0 }, [row], [{ id: row.id }]];
    mocks.updates = [];
    // Final result exists — but NO source provides the corner stats.
    mocks.lookupResult.mockResolvedValue({
      eventId: "5501", leagueSlug: "eng.1", date: row.matchDate,
      homeName: "Arsenal", awayName: "Chelsea", homeScore: 2, awayScore: 1,
    });
    mocks.peek.mockReturnValue(null);
    mocks.fetch.mockResolvedValue(null);

    const pass = await settleFeaturePicks(false);

    expect(pass.voided).toBe(1);
    expect(pass.corners).toBe(1);
    expect(pass.stillPending).toBe(0);
    expect(pass.won).toBe(0);
    expect(pass.lost).toBe(0);

    // The VOID update returns the stake: zero hits, zero losses, pending 0.
    const update = mocks.updates[1] as Record<string, unknown>;
    expect(update.outcome).toBe("VOID");
    expect(update.hits).toBe(0);
    expect(update.misses).toBe(0);
    expect(update.pending).toBe(0);
    const detail = update.top10Detail as Array<{ outcome: string }>;
    expect(detail[0].outcome).toBe("VOID");

    expect(logs.some((l) =>
      l.includes("Arsenal vs Chelsea — Total Corners O/U 9.5: VOID (no stats after 24h grace)"),
    )).toBe(true);
  });

  it("keeps a pick on a match inside the grace window pending (data may still arrive)", async () => {
    const row = makeFeatureRow({});
    mocks.terminals = [{ rowCount: 0 }, [row]];
    mocks.updates = [];
    mocks.lookupResult.mockResolvedValue({
      eventId: "5501", leagueSlug: "eng.1", date: dayOffset(0),
      // Kicked off 40 minutes ago — the boxscore may simply not be published yet.
      kickoffAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      homeName: "Arsenal", awayName: "Chelsea", homeScore: 2, awayScore: 1,
    });
    mocks.peek.mockReturnValue(null);
    mocks.fetch.mockResolvedValue(null);

    const pass = await settleFeaturePicks(false);

    expect(pass.voided).toBe(0);
    expect(pass.stillPending).toBe(1);
    // Only the legacy backfill .set() ran — no pick was touched.
    expect(mocks.updates).toEqual([{ feature: "corners" }]);
  });

  it("settles WIN from the boxscore the moment any source has the stat", async () => {
    const row = makeFeatureRow({});
    mocks.terminals = [{ rowCount: 0 }, [row], [{ id: row.id }]];
    mocks.updates = [];
    mocks.lookupResult.mockResolvedValue({
      eventId: "5501", leagueSlug: "eng.1", date: dayOffset(0),
      kickoffAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      homeName: "Arsenal", awayName: "Chelsea", homeScore: 2, awayScore: 1,
    });
    mocks.peek.mockReturnValue(cornerStats("5501"));
    mocks.fetch.mockResolvedValue(null);

    const pass = await settleFeaturePicks(false);

    expect(pass.won).toBe(1);
    expect((mocks.updates[1] as Record<string, unknown>).outcome).toBe("WIN");
  });
});

// ─── Performance refresh: stale PENDING Top-10 markets → HIT/MISS/VOID ────────

describe("refreshPendingPerformanceRows — finishes what the boxscore can, voids the rest", () => {
  let logs: string[] = [];

  beforeEach(() => {
    clearSettlementBoxscoreCache();
    vi.clearAllMocks();
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    mocks.runOracle.mockResolvedValue({ top10: [] });
    mocks.evaluateFinished.mockImplementation(() => undefined);
  });

  function makePerfRow(overrides: Record<string, unknown>) {
    return {
      id: 401,
      eventId: "5601",
      matchLabel: "Arsenal vs Chelsea",
      homeTeam: "Arsenal",
      awayTeam: "Chelsea",
      league: "English Premier League",
      leagueSlug: "eng.1",
      competitionName: "English Premier League",
      matchDate: dayOffset(72),
      homeScore: 2,
      awayScore: 1,
      hits: 1,
      misses: 0,
      pending: 2,
      accuracy: 1,
      rankingMode: "B",
      feature: null,
      top10Detail: [
        { name: "Total Corners O/U 9.5", selection: "Over 9.5", outcome: "PENDING" },
        { name: "Total Throw-ins O/U 30.5", selection: "Over 30.5", outcome: "PENDING" },
        { name: "Match Winner", selection: "Home Win", outcome: "HIT" },
      ],
      ...overrides,
    };
  }

  it("resolves stat families from canonical stats and VOIDs what no source has", async () => {
    const stale = makePerfRow({});
    const fresh = makePerfRow({
      id: 402,
      eventId: "5602",
      matchDate: dayOffset(0), // today — inside the grace window
      pending: 1,
      top10Detail: [{ name: "Total Corners O/U 9.5", selection: "Over 9.5", outcome: "PENDING" }],
    });
    // One select (rows) + one update terminal per refreshed row.
    mocks.terminals = [[stale, fresh], { rowCount: 1 }, { rowCount: 1 }];
    mocks.updates = [];
    mocks.peek.mockImplementation((query: { eventId?: string } | undefined) =>
      query?.eventId === "5601" ? cornerStats("5601") : null,
    );
    mocks.fetch.mockResolvedValue(null);

    const refresh = await refreshPendingPerformanceRows(false);

    // Corners settle from the real boxscore (11 > 9.5 → HIT); throw-ins have
    // no source → VOID; the fresh match keeps its pending market PENDING.
    const staleUpdate = mocks.updates[0] as Record<string, unknown>;
    const detail = staleUpdate.top10Detail as Array<{ outcome: string }>;
    expect(detail.map((d) => d.outcome)).toEqual(["HIT", "VOID", "HIT"]);
    expect(staleUpdate.hits).toBe(2);
    expect(staleUpdate.misses).toBe(0);
    expect(staleUpdate.pending).toBe(0);
    // VOID is stake return — NOT a loss — accuracy is over decided markets only.
    expect(staleUpdate.accuracy).toBe(1);

    const freshUpdate = mocks.updates[1] as Record<string, unknown>;
    expect((freshUpdate.top10Detail as Array<{ outcome: string }>)[0].outcome).toBe("PENDING");
    expect(freshUpdate.pending).toBe(1);

    expect(refresh).toMatchObject({ resolved: 2, voided: 1, win: 1, loss: 0, push: 0, matches: 1 });

    expect(logs.some((l) =>
      l.includes("[Settle] Arsenal vs Chelsea — Total Corners O/U 9.5: WIN, Total Throw-ins O/U 30.5: VOID (no stats)"),
    )).toBe(true);
  });
});
