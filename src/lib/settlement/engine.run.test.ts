// End-to-end tests for the settlement engine (src/lib/settlement/engine.ts)
// with mocked result feed + stats aggregator:
//
//   · every market on a FINISHED match resolves — score-backed immediately,
//     stat-backed from the multi-source boxscore;
//   · a stat no source has on a match past the 24h grace → VOID (stake
//     returned) instead of PENDING forever;
//   · a match inside the grace keeps stat markets PENDING (retry later);
//   · boxscores are memoised across settlement runs (no re-fetching);
//   · logging is per market + a run summary line.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPendingSettlementItems: vi.fn(),
  settleAccumulator: vi.fn(async () => true),
  settleDailyPick: vi.fn(async () => true),
  settleValueBet: vi.fn(async () => true),
  fetchScoreboard: vi.fn(async () => [] as unknown[]),
  peek: vi.fn(() => null),
  fetch: vi.fn(async (_query?: unknown): Promise<unknown> => null),
}));

vi.mock("@/db/queries/settlement", () => ({
  getPendingSettlementItems: mocks.getPendingSettlementItems,
  settleAccumulator: mocks.settleAccumulator,
  settleDailyPick: mocks.settleDailyPick,
  settleValueBet: mocks.settleValueBet,
}));

vi.mock("@/lib/espn", () => ({
  fetchScoreboard: mocks.fetchScoreboard as never,
}));

vi.mock("@/lib/data/aggregator", () => ({
  statsAggregator: { peek: mocks.peek, fetch: mocks.fetch },
}));

// ESPN boxscore supplement — no real network in unit tests.
vi.mock("@/lib/httpClient", () => ({ resilientJson: vi.fn(async () => null) }));

const { runSettlementEngine } = await import("@/lib/settlement/engine");
const { clearSettlementBoxscoreCache } = await import("@/lib/settlement/results");
const { emptyCanonicalMatchStats } = await import("@/lib/data/types");
type MatchStats = ReturnType<typeof emptyCanonicalMatchStats>;

const HOUR = 3_600_000;
const NOW = Date.now();
const STALE_KICKOFF = NOW - 48 * HOUR;   // finished ~2 days ago → grace elapsed
const FRESH_KICKOFF = NOW - 40 * 60_000; // finished minutes ago → inside grace

const STALE_ID = "90001";
const FRESH_ID = "90002";

function iso(ms: number): string { return new Date(ms).toISOString(); }
function day(ms: number): string { return iso(ms).slice(0, 10); }

function fixture(id: string, kickoffMs: number, homeScore: string, awayScore: string): unknown {
  return {
    id,
    leagueSlug: "eng.1",
    leagueName: "English Premier League",
    date: iso(kickoffMs),
    state: "post",
    statusDetail: "Match Finished",
    venue: null,
    neutralSite: false,
    home: { id: "h", name: "Arsenal", shortName: "Arsenal", abbrev: "ARS", logo: null, color: null, score: homeScore, homeAway: "home" },
    away: { id: "a", name: "Chelsea", shortName: "Chelsea", abbrev: "CHE", logo: null, color: null, score: awayScore, homeAway: "away" },
    odds: null,
  };
}

/** Stats the aggregator provides for the stale match: corners/SOT/shots/cards
 *  present, throw-ins and goal kicks null (no source has them). */
function staleStats(): MatchStats {
  const s = emptyCanonicalMatchStats({
    leagueSlug: "eng.1", eventId: STALE_ID, homeTeam: "Arsenal", awayTeam: "Chelsea", date: day(STALE_KICKOFF),
  });
  s.home.corners = 6; s.away.corners = 5;
  s.home.shotsOnTarget = 4; s.away.shotsOnTarget = 3;
  s.home.shots = 9; s.away.shots = 6;
  s.home.yellowCards = 1; s.away.yellowCards = 2; s.home.redCards = 0; s.away.redCards = 0;
  s.metadata.source = "API-Football";
  return s;
}

function queues(): unknown {
  return {
    accumulators: [
      {
        id: 21, name: "Test slip", slipType: "accumulator", combinedOdds: 3, stake: 10,
        status: "pending", leagueSlug: "eng.1",
        picks: [
          { fixtureId: STALE_ID, leagueSlug: "eng.1", matchLabel: "Arsenal vs Chelsea", date: day(STALE_KICKOFF), marketName: "Match Winner", selection: "Home Win" },
          { fixtureId: STALE_ID, leagueSlug: "eng.1", matchLabel: "Arsenal vs Chelsea", date: day(STALE_KICKOFF), marketName: "Total Corners O/U 9.5", selection: "Over 9.5" },
        ],
      },
    ],
    dailyPicks: [
      {
        id: 1, eventId: STALE_ID, leagueSlug: "eng.1", match: "Arsenal vs Chelsea",
        pickDate: day(STALE_KICKOFF), status: "pending",
        picks: [
          { name: "Match Winner", selection: "Home Win" },
          { name: "Total Goals O/U 3.5", selection: "Over 3.5" },
          { name: "Total Corners O/U 9.5", selection: "Over 9.5" },
          { name: "Total Throw-ins O/U 30.5", selection: "Over 30.5" },
        ],
      },
    ],
    valueBets: [
      { id: 11, eventId: STALE_ID, leagueSlug: "eng.1", match: "Arsenal vs Chelsea", matchDate: day(STALE_KICKOFF), marketName: "Total Shots on Target O/U 8.5", selection: "Under 8.5", stake: 10, bookOdds: 1.9 },
      { id: 12, eventId: STALE_ID, leagueSlug: "eng.1", match: "Arsenal vs Chelsea", matchDate: day(STALE_KICKOFF), marketName: "Total Goal Kicks O/U 14.5", selection: "Over 14.5", stake: 10, bookOdds: 1.9 },
      // Same stat market on a match still inside the grace window → pending.
      { id: 13, eventId: FRESH_ID, leagueSlug: "eng.1", match: "Arsenal vs Chelsea", matchDate: day(FRESH_KICKOFF), marketName: "Total Corners O/U 9.5", selection: "Over 9.5", stake: 10, bookOdds: 1.9 },
    ],
  };
}

let logs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearSettlementBoxscoreCache();
  vi.clearAllMocks();
  mocks.getPendingSettlementItems.mockResolvedValue(queues());
  mocks.settleAccumulator.mockResolvedValue(true);
  mocks.settleDailyPick.mockResolvedValue(true);
  mocks.settleValueBet.mockResolvedValue(true);
  mocks.fetchScoreboard.mockImplementation(async () => [
    fixture(STALE_ID, STALE_KICKOFF, "2", "1"),
    fixture(FRESH_ID, FRESH_KICKOFF, "0", "0"),
  ]);
  mocks.peek.mockReturnValue(null);
  mocks.fetch.mockImplementation(async (query?: unknown) =>
    (query as { eventId?: string } | undefined)?.eventId === STALE_ID ? staleStats() : null,
  );
  logs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

describe("runSettlementEngine — every market on a finished match resolves", () => {
  it("settles the full Top-10 (score + stat + no-data-VOID) in one run", async () => {
    const summary = await runSettlementEngine();

    // Daily pick row: all four picks resolved → row settled.
    expect(mocks.settleDailyPick).toHaveBeenCalledTimes(1);
    const dailyCall = (mocks.settleDailyPick.mock.calls as unknown as Array<
      [unknown, { hits: number; misses: number; voids: number; pickResults: Array<{ name?: string; outcome?: string }> }]
    >)[0];
    const pickSettlement = dailyCall[1];
    expect(pickSettlement.hits).toBe(2);   // Match Winner + Total Corners (real stats)
    expect(pickSettlement.misses).toBe(1); // Total Goals 3 over < 3.5 line
    expect(pickSettlement.voids).toBe(1);  // Throw-ins: no source has the stat → VOID
    expect(pickSettlement.pickResults.map((p) => p.outcome)).toEqual(["HIT", "MISS", "HIT", "VOID"]);

    // Value bets: resolved from stats / voided past grace.
    const vbCalls = mocks.settleValueBet.mock.calls as unknown as Array<[{ id: number }, { outcome: string; actualReturn: number }]>;
    const settledVb = vbCalls.map((c) => c[1]);
    expect(settledVb).toHaveLength(2);
    expect(settledVb[0].outcome).toBe("won");   // SOT 7 < 8.5
    expect(settledVb[0].actualReturn).toBeCloseTo(19);
    expect(settledVb[1].outcome).toBe("void");  // goal kicks: no source → stake back
    expect(settledVb[1].actualReturn).toBe(10);

    // Accumulator: both legs resolved from the shared boxscore → won slip.
    expect(mocks.settleAccumulator).toHaveBeenCalledTimes(1);
    const slipCall = (mocks.settleAccumulator.mock.calls as unknown as Array<[unknown, { status: string; wonLegs: number }]>)
      [0];
    const slipSettlement = slipCall[1];
    expect(slipSettlement.status).toBe("won");
    expect(slipSettlement.wonLegs).toBe(2);

    // Run summary: one settled row remains pending BY DESIGN — the fresh
    // match inside the grace window (id 13). No market is stuck past grace.
    expect(summary.stuckPending).toBe(0);
    expect(summary.markets.resolved).toBe(8);
    expect(summary.markets.win).toBe(5);
    expect(summary.markets.loss).toBe(1);
    expect(summary.markets.void).toBe(2);
    expect(summary.markets.pending).toBe(1);
    expect(summary.matches).toBe(1);
    expect(summary.settled.total).toBe(4);
  });

  it("logs the per-market line, the boxscore source and the run summary", async () => {
    await runSettlementEngine();

    expect(logs.some((l) =>
      l.includes("[Settle] Arsenal vs Chelsea — Match Winner: WIN, Total Goals O/U 3.5: LOSS, Total Corners O/U 9.5: WIN, Total Throw-ins O/U 30.5: VOID (no stats)"),
    )).toBe(true);
    expect(logs.some((l) =>
      l.includes("[Settle] Arsenal vs Chelsea — boxscore from API-Football (corners 11, cards 3, shots 15)"),
    )).toBe(true);
    expect(logs.some((l) =>
      /\[Settle\] Engine pass: 1 matches, 8 markets resolved \(WIN 5, LOSS 1, PUSH 0, VOID 2\), 0 stuck pending/.test(l),
    )).toBe(true);
  });

  it("keeps stat markets PENDING (and the row unsettled) inside the 24h grace window", async () => {
    await runSettlementEngine();
    // Value bet 13 is on the fresh match → must NOT be settled.
    const settledIds = (mocks.settleValueBet.mock.calls as unknown as Array<[{ id: number }]>)
      .map((c) => c[0].id);
    expect(settledIds).not.toContain(13);
    const summary = await runSettlementEngine();
    expect(summary.markets.pending).toBe(1); // still awaiting, not stuck
    expect(summary.stuckPending).toBe(0);
  });

  it("memoises the boxscore across settlement runs (no repeated fetch)", async () => {
    await runSettlementEngine();
    const fetchesAfterRun1 = mocks.fetch.mock.calls.length;
    const peekCallsAfterRun1 = mocks.peek.mock.calls.length;
    expect(fetchesAfterRun1).toBe(2); // one per distinct finished match

    await runSettlementEngine();
    expect(mocks.fetch.mock.calls.length).toBe(fetchesAfterRun1);
    expect(mocks.peek.mock.calls.length).toBe(peekCallsAfterRun1);
  });
});
