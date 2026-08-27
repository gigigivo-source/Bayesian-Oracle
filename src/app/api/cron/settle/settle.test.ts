// Unit + integration tests for the settlement cron's dedicated feature pass —
// the First 5 Minutes outcome resolver, its pure building blocks, and the full
// settleFeaturePicks sweep (result lookup → resolution → guarded DB update).
//
// The route module imports @/db statically (it is a cron endpoint that
// requires the database), so the db layer is mocked here to keep the tests
// runnable without a DATABASE_URL. Data providers are stubbed at their module
// boundaries: the multi-source result lookup, the stats aggregator and the
// ESPN event timeline.

import { describe, expect, it, vi } from "vitest";
import type { MatchResult } from "@/lib/settlement/evaluate";
import { emptyTeamStats, type CanonicalMatchStats } from "@/lib/data/types";

// ─── Shared mock handles ──────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  // Queued terminal results for the mocked drizzle chains, in await order.
  terminals: [] as Array<unknown>,
  // Every .set() payload handed to db.update(...).
  updates: [] as Array<Record<string, unknown>>,
  peek: vi.fn(),
  fetch: vi.fn(),
  lookupResult: vi.fn(),
  espnJson: vi.fn(),
}));

vi.mock("@/db", () => {
  // A chainable stand-in for drizzle query builders: every builder method call
  // returns the chain, awaiting the chain consumes the next queued terminal
  // result, and .set() records its payload for assertions.
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

vi.mock("@/lib/httpClient", () => ({
  resilientJson: mocks.espnJson,
}));

const {
  eventMatchesFamily,
  eventMinute,
  first5FamilyOf,
  first5TotalFromStats,
  resolveFirst5Outcome,
  settleFeaturePicks,
} = await import("./route");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    eventId: "401",
    leagueSlug: "eng.1",
    date: "2026-01-01",
    homeName: "Arsenal",
    awayName: "Chelsea",
    homeScore: 0,
    awayScore: 0,
    ...overrides,
  };
}

function makeStats(
  home: Partial<CanonicalMatchStats["home"]>,
  away: Partial<CanonicalMatchStats["away"]> = {},
): CanonicalMatchStats {
  return {
    home: { ...emptyTeamStats(), ...home },
    away: { ...emptyTeamStats(), ...away },
    metadata: { source: "test", fetchedAt: "2026-01-01T00:00:00Z", matchDate: "2026-01-01", leagueSlug: "eng.1" },
  };
}

function event(typeText: string, displayValue: string) {
  return { type: { text: typeText }, clock: { displayValue } };
}

const GOAL_MARKET = "Goal in First 5 Minutes";
const CORNER_MARKET = "Corner in First 5 Minutes";
const CARD_MARKET = "Card in First 5 Minutes";
const PENALTY_MARKET = "Penalty in First 5 Minutes";

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe("first5FamilyOf", () => {
  it("maps the four First 5 Minutes market labels", () => {
    expect(first5FamilyOf(GOAL_MARKET)).toBe("goal");
    expect(first5FamilyOf(CORNER_MARKET)).toBe("corner");
    expect(first5FamilyOf(CARD_MARKET)).toBe("card");
    expect(first5FamilyOf(PENALTY_MARKET)).toBe("penalty");
  });

  it("returns null for an unknown market", () => {
    expect(first5FamilyOf("Match Result")).toBeNull();
  });
});

describe("eventMinute", () => {
  it("parses plain minutes, stoppage time and the seconds fallback", () => {
    expect(eventMinute({ displayValue: "5'" })).toBe(5);
    expect(eventMinute({ displayValue: "45+2'" })).toBe(47);
    expect(eventMinute({ displayValue: "90+4'" })).toBe(94);
    expect(eventMinute({ value: 300 })).toBe(5);
    expect(eventMinute({})).toBeNull();
    expect(eventMinute(null)).toBeNull();
  });
});

describe("eventMatchesFamily", () => {
  it("treats scored penalties as goals and any penalty as a penalty event", () => {
    expect(eventMatchesFamily("Goal", "goal")).toBe(true);
    expect(eventMatchesFamily("Own Goal", "goal")).toBe(true);
    expect(eventMatchesFamily("Penalty - Scored", "goal")).toBe(true);
    expect(eventMatchesFamily("Penalty - Saved", "goal")).toBe(false);
    expect(eventMatchesFamily("Penalty - Missed", "penalty")).toBe(true);
    expect(eventMatchesFamily("Penalty - Saved", "penalty")).toBe(true);
    expect(eventMatchesFamily("Yellow Card", "card")).toBe(true);
    expect(eventMatchesFamily("Red Card", "card")).toBe(true);
    expect(eventMatchesFamily("Corner Kick", "corner")).toBe(true);
    expect(eventMatchesFamily("Substitution", "card")).toBe(false);
    expect(eventMatchesFamily("VAR", "goal")).toBe(false);
  });
});

describe("first5TotalFromStats", () => {
  it("sums per-team totals and refuses partial data", () => {
    expect(first5TotalFromStats("goal", makeStats({ goals: 2 }, { goals: 1 }))).toBe(3);
    expect(first5TotalFromStats("corner", makeStats({ corners: 4 }, { corners: 5 }))).toBe(9);
    expect(first5TotalFromStats("card", makeStats({ yellowCards: 2, redCards: 1 }, { yellowCards: 3, redCards: 0 }))).toBe(6);
    expect(first5TotalFromStats("penalty", makeStats({ penalties: 1 }, { penalties: 0 }))).toBe(1);
    expect(first5TotalFromStats("goal", makeStats({ goals: 1 }, { goals: null }))).toBeNull();
    expect(first5TotalFromStats("card", makeStats({}, {}))).toBeNull();
    expect(first5TotalFromStats("goal", null)).toBeNull();
  });
});

// ─── Outcome resolution ───────────────────────────────────────────────────────

describe("resolveFirst5Outcome", () => {
  it("settles a Yes pick as WIN when a goal happens inside the window", () => {
    const timeline = [event("Yellow Card", "20'"), event("Goal", "4'")];
    expect(resolveFirst5Outcome(GOAL_MARKET, "Yes", makeResult({ homeScore: 1 }), null, timeline)).toBe("WIN");
    expect(resolveFirst5Outcome(GOAL_MARKET, "No", makeResult({ homeScore: 1 }), null, timeline)).toBe("LOSS");
  });

  it("settles a No pick as WIN when a complete timeline has no early event", () => {
    const timeline = [event("Goal", "23'"), event("Yellow Card", "60'")];
    const stats = makeStats({ goals: 1 }, { goals: 0 });
    expect(resolveFirst5Outcome(GOAL_MARKET, "No", makeResult({ homeScore: 1 }), stats, timeline)).toBe("WIN");
    expect(resolveFirst5Outcome(GOAL_MARKET, "Yes", makeResult({ homeScore: 1 }), stats, timeline)).toBe("LOSS");
  });

  it("never trusts a negative from an incomplete timeline", () => {
    // Timeline saw 1 goal but the final score says 2 — the feed is partial,
    // so "No early goal" cannot be proven and the pick stays pending.
    const timeline = [event("Goal", "30'")];
    expect(
      resolveFirst5Outcome(GOAL_MARKET, "No", makeResult({ homeScore: 1, awayScore: 1 }), null, timeline),
    ).toBeNull();
  });

  it("still trusts a positive detection from an incomplete timeline", () => {
    const timeline = [event("Goal", "2'")];
    expect(
      resolveFirst5Outcome(GOAL_MARKET, "Yes", makeResult({ homeScore: 1, awayScore: 1 }), null, timeline),
    ).toBe("WIN");
  });

  it("settles a scored penalty as both a goal and a penalty", () => {
    const timeline = [event("Penalty - Scored", "3'")];
    const result = makeResult({ homeScore: 1 });
    expect(resolveFirst5Outcome(PENALTY_MARKET, "Yes", result, null, timeline)).toBe("WIN");
    expect(resolveFirst5Outcome(GOAL_MARKET, "Yes", result, null, timeline)).toBe("WIN");
  });

  it("treats a saved penalty as a penalty but not a goal", () => {
    const timeline = [event("Penalty - Saved", "3'"), event("Goal", "40'")];
    const stats = makeStats({ goals: 1 }, { goals: 0 });
    expect(resolveFirst5Outcome(PENALTY_MARKET, "Yes", makeResult({ homeScore: 1 }), stats, timeline)).toBe("WIN");
    expect(resolveFirst5Outcome(GOAL_MARKET, "Yes", makeResult({ homeScore: 1 }), stats, timeline)).toBe("LOSS");
  });

  it("counts an event at exactly minute 5 but not minute 6", () => {
    const atFive = [event("Goal", "5'"), event("Yellow Card", "50'")];
    const atSix = [event("Goal", "6'"), event("Yellow Card", "50'")];
    const stats = makeStats({ goals: 1 }, { goals: 0 });
    const result = makeResult({ homeScore: 1 });
    expect(resolveFirst5Outcome(GOAL_MARKET, "Yes", result, stats, atFive)).toBe("WIN");
    expect(resolveFirst5Outcome(GOAL_MARKET, "Yes", result, stats, atSix)).toBe("LOSS");
  });

  it("settles from the final score alone when a goalless match proves No", () => {
    expect(resolveFirst5Outcome(GOAL_MARKET, "No", makeResult(), null, null)).toBe("WIN");
    expect(resolveFirst5Outcome(GOAL_MARKET, "Yes", makeResult(), null, null)).toBe("LOSS");
  });

  it("keeps a goal pick pending without a timeline when goals were scored", () => {
    expect(resolveFirst5Outcome(GOAL_MARKET, "No", makeResult({ homeScore: 0, awayScore: 2 }), null, null)).toBeNull();
  });

  it("settles corner and card picks from a zero aggregate total", () => {
    const noCorners = makeStats({ corners: 0 }, { corners: 0 });
    expect(resolveFirst5Outcome(CORNER_MARKET, "No", makeResult(), noCorners, null)).toBe("WIN");
    const noCards = makeStats({ yellowCards: 0, redCards: 0 }, { yellowCards: 0, redCards: 0 });
    expect(resolveFirst5Outcome(CARD_MARKET, "No", makeResult(), noCards, null)).toBe("WIN");
    expect(resolveFirst5Outcome(CARD_MARKET, "Yes", makeResult(), noCards, null)).toBe("LOSS");
  });

  it("keeps a pick pending when the aggregate total is positive and no timeline exists", () => {
    const corners = makeStats({ corners: 3 }, { corners: 4 });
    expect(resolveFirst5Outcome(CORNER_MARKET, "No", makeResult(), corners, null)).toBeNull();
  });

  it("keeps a pick pending when the needed stats are missing", () => {
    expect(resolveFirst5Outcome(CORNER_MARKET, "No", makeResult(), makeStats({}, {}), null)).toBeNull();
  });

  it("rejects unknown markets and non Yes/No selections", () => {
    expect(resolveFirst5Outcome("Match Result", "Yes", makeResult(), null, null)).toBeNull();
    expect(resolveFirst5Outcome(GOAL_MARKET, "Over 9.5", makeResult(), null, null)).toBeNull();
  });
});

// ─── Feature settlement sweep (integration) ───────────────────────────────────

/** A full performance_log row as the feature pass reads it. */
function makeFeatureRow(overrides: Record<string, unknown>) {
  return {
    id: 101,
    eventId: "700100",
    matchLabel: "Arsenal vs Chelsea",
    homeTeam: "Arsenal",
    awayTeam: "Chelsea",
    league: "English Premier League",
    leagueSlug: "eng.1",
    competitionName: "English Premier League",
    matchDate: "2026-08-20",
    homeScore: 0,
    awayScore: 0,
    totalPicks: 1,
    hits: 0,
    misses: 0,
    pending: 0,
    accuracy: 0,
    top10Detail: [],
    lowConfidence: false,
    rankingMode: "S",
    feature: "corners",
    market: "Total Corners O/U 9.5",
    selection: "Over 9.5",
    outcome: "pending",
    hitRate: 0.72,
    confidence: "HIGH",
    settledAt: null,
    createdAt: new Date("2026-08-19T12:00:00Z"),
    ...overrides,
  };
}

describe("settleFeaturePicks", () => {
  it("settles corners and first5 picks from real match data with guarded updates", async () => {
    const cornersRow = makeFeatureRow({});
    const first5Row = makeFeatureRow({
      id: 102,
      eventId: "700200",
      matchLabel: "Real Madrid vs Valencia",
      homeTeam: "Real Madrid",
      awayTeam: "Valencia",
      matchDate: "2026-08-21",
      rankingMode: "F",
      feature: "first5",
      market: "Goal in First 5 Minutes",
      selection: "Yes",
      hitRate: 0.26,
      confidence: "LOW",
      top10Detail: [{ name: "Goal in First 5 Minutes", selection: "Yes", hitRate: 0.26, outcome: "PENDING", family: "Goal", odds: 3.8 }],
    });

    // Terminal results consumed by the mocked drizzle chains, in await order:
    // 1) legacy 'S' backfill update → rowCount
    // 2) pending feature rows select → the two rows above
    // 3) + 4) guarded update .returning() per settled pick
    mocks.terminals = [{ rowCount: 1 }, [cornersRow, first5Row], [{ id: 101 }], [{ id: 102 }]];
    mocks.updates = [];

    // Finished results from the multi-source lookup.
    const cornersResult: MatchResult = {
      eventId: "700100", leagueSlug: "eng.1", date: "2026-08-20",
      homeName: "Arsenal", awayName: "Chelsea", homeScore: 2, awayScore: 1,
    };
    const first5Result: MatchResult = {
      eventId: "700200", leagueSlug: "esp.1", date: "2026-08-21",
      homeName: "Real Madrid", awayName: "Valencia", homeScore: 1, awayScore: 0,
    };
    mocks.lookupResult.mockReset();
    mocks.lookupResult.mockImplementation(async (params: { eventId?: string | null }) =>
      params.eventId === "700100" ? cornersResult : params.eventId === "700200" ? first5Result : null,
    );

    // Canonical corner stats for the corners pick (6 + 5 = 11 corners → Over 9.5 wins).
    const cornerStats = makeStats({ corners: 6, goals: 2 }, { corners: 5, goals: 1 });
    mocks.peek.mockReset();
    mocks.peek.mockImplementation((query: { eventId?: string }) =>
      query?.eventId === "700100" ? cornerStats : null,
    );
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(null);

    // ESPN event timeline for the first5 match: a 3rd-minute goal → "Yes" wins.
    mocks.espnJson.mockReset();
    mocks.espnJson.mockResolvedValue({
      details: [
        { type: { text: "Goal" }, clock: { displayValue: "3'" } },
        { type: { text: "Yellow Card" }, clock: { displayValue: "77'" } },
      ],
    });

    const pass = await settleFeaturePicks(false);

    // One corners pick + one first5 pick settled, both wins.
    expect(pass.backfilledCorners).toBe(1);
    expect(pass.corners).toBe(1);
    expect(pass.first5).toBe(1);
    expect(pass.won).toBe(2);
    expect(pass.lost).toBe(0);
    expect(pass.stillPending).toBe(0);
    expect(pass.failed).toBe(0);

    // The legacy backfill tagged the old 'S' rows.
    expect(mocks.updates[0]).toEqual({ feature: "corners" });

    // The corners update is guarded and fully stamped.
    const cornersUpdate = mocks.updates[1] as Record<string, unknown>;
    expect(cornersUpdate.outcome).toBe("WIN");
    expect(cornersUpdate.homeScore).toBe(2);
    expect(cornersUpdate.awayScore).toBe(1);
    expect(cornersUpdate.hits).toBe(1);
    expect(cornersUpdate.misses).toBe(0);
    expect(cornersUpdate.pending).toBe(0);
    expect(cornersUpdate.accuracy).toBe(1);
    expect(cornersUpdate.settledAt).toBeInstanceOf(Date);
    expect(cornersUpdate.top10Detail).toEqual([]);

    // The first5 update stamped the WIN and rewrote its detail entry to HIT.
    const first5Update = mocks.updates[2] as Record<string, unknown>;
    expect(first5Update.outcome).toBe("WIN");
    expect(first5Update.homeScore).toBe(1);
    const first5Detail = (first5Update.top10Detail as Array<{ outcome: string; odds: number }>)[0];
    expect(first5Detail.outcome).toBe("HIT");
    expect(first5Detail.odds).toBe(3.8);
  });

  it("keeps picks pending when no result exists for the match yet", async () => {
    const pendingRow = makeFeatureRow({});
    mocks.terminals = [{ rowCount: 0 }, [pendingRow]];
    mocks.updates = [];
    mocks.lookupResult.mockReset();
    mocks.lookupResult.mockResolvedValue(null);

    const pass = await settleFeaturePicks(false);

    expect(pass.corners).toBe(0);
    expect(pass.first5).toBe(0);
    expect(pass.stillPending).toBe(1);
    // Only the backfill .set() ran — no pick was touched.
    expect(mocks.updates).toEqual([{ feature: "corners" }]);
  });
});
