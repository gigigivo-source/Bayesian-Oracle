import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { matchEngineMarketToBookmaker } from "./marketMap";
import { buildTickets, type VaLeg } from "./ticket";
import type { VaBookmakerOdds } from "./oddsFetcher";
import {
  settleBacktestTickets,
  type BacktestMatchResult,
  marketKeyOf,
  applyMarketCorrection,
  capModelProbability,
  MAX_LEG_MODEL_PROBABILITY,
} from "./scanner";
import type { FixtureLite } from "@/lib/espn";
import type { StatDistribution, TeamStatProfile } from "@/lib/engine/sofascore";

// scanner.ts pulls in the db layer at module scope; stub it for unit tests without DATABASE_URL.
// The chain is shaped so both scanner.ts (`insert().values()`, `select().from()`,
// `delete()`) and performScan.ts (`select().from().orderBy().limit()`,
// `insert().values().returning()`, `delete().where()`) resolve to empty arrays.
const { dbInsertValues, dbDelete, dbSelectFrom, keepDbAlive, fetchScoreboard } = vi.hoisted(() => {
  const dbInsertValues = vi.fn(() => {
    const p = Promise.resolve([]) as Promise<never[]> & { returning: () => Promise<never[]> };
    p.returning = () => Promise.resolve([]);
    return p;
  });
  const dbDelete = vi.fn(() => {
    const p = Promise.resolve([]) as Promise<never[]> & { where: () => Promise<never[]> };
    p.where = () => Promise.resolve([]);
    return p;
  });
  const dbSelectFrom = vi.fn(() => {
    const p = Promise.resolve([]) as Promise<never[]> & {
      orderBy: () => { limit: () => Promise<never[]> };
    };
    p.orderBy = () => ({ limit: () => Promise.resolve([]) });
    return p;
  });
  const keepDbAlive = vi.fn(async () => undefined);
  const fetchScoreboard = vi.fn(async (): Promise<FixtureLite[]> => []);
  return { dbInsertValues, dbDelete, dbSelectFrom, keepDbAlive, fetchScoreboard };
});
vi.mock("@/db", () => ({
  db: {
    insert: () => ({ values: dbInsertValues }),
    delete: dbDelete,
    select: () => ({ from: dbSelectFrom }),
  },
  keepDbAlive: () => keepDbAlive(),
}));
vi.mock("@/db/schema", () => ({ vaLegs: {}, marketStats: {}, vaScanLock: {}, vaTickets: {} }));

// External boundaries of the scanner: ESPN (fixtures) and Bzzoiro (odds). Mocked
// the same way scannerCoverage.test.ts does so performScan runs end-to-end offline.
vi.mock("@/lib/espn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/espn")>();
  return {
    ...actual,
    fetchScoreboard: () => fetchScoreboard(),
    fetchSummary: vi.fn(async () => null),
  };
});
vi.mock("./oddsFetcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./oddsFetcher")>();
  return {
    ...actual,
    resolveBzzoiroEvent: vi.fn(async () => ({
      eventId: null,
      status: "no-events",
      eventsInRange: 0,
      relatedInRange: 0,
      toleranceDays: 5,
    })),
    fetchOddsForEvent: vi.fn(async () => [] as VaBookmakerOdds[]),
  };
});

// Mock oddsFetcher module for scanner tests? We'll test marketMap directly for case 1 & 2.

describe("Value Accumulator — Market mapping", () => {
  it("1. matches engine market to bookmaker market when labels differ", () => {
    const bookmakerMarkets: VaBookmakerOdds[] = [
      { bookmaker: "1xBet", marketLabel: "Goals Over/Under", line: 2.5, selection: "Over 2.5", odds: 1.85 },
      { bookmaker: "Bet365", marketLabel: "Both Teams Score", line: null, selection: "Yes", odds: 1.9 },
      { bookmaker: "1xBet", marketLabel: "Total Corners", line: 9.5, selection: "Over 9.5", odds: 1.8 },
    ];

    // Engine says "Total Goals O/U" vs bookmaker "Goals Over/Under"
    const matched = matchEngineMarketToBookmaker("Total Goals O/U 2.5", "Over 2.5", bookmakerMarkets);
    expect(matched).not.toBeNull();
    expect(matched?.marketLabel).toBe("Goals Over/Under");
    expect(matched?.selection).toBe("Over 2.5");

    // BTTS mapping
    const matchedBTTS = matchEngineMarketToBookmaker("Both Teams To Score", "Yes", bookmakerMarkets);
    expect(matchedBTTS).not.toBeNull();
    expect(matchedBTTS?.marketLabel).toBe("Both Teams Score");
  });

  it("2. rejects a leg with no bookmaker price", () => {
    const bookmakerMarkets: VaBookmakerOdds[] = [
      { bookmaker: "1xBet", marketLabel: "Goals Over/Under", line: 2.5, selection: "Over 2.5", odds: 1.85 },
    ];
    const matched = matchEngineMarketToBookmaker("Total Corners O/U 9.5", "Over 9.5", bookmakerMarkets);
    expect(matched).toBeNull();
  });
});

describe("Value Accumulator — Partitioner", () => {
  function makeLeg(overrides: Partial<VaLeg> & { eventId: string; statFamily: string; homeTeam: string; awayTeam: string; ev: number }): VaLeg {
    const baseKickoff = new Date();
    const base: VaLeg = {
      scanId: "test_scan",
      eventId: overrides.eventId,
      matchLabel: `${overrides.homeTeam} vs ${overrides.awayTeam}`,
      homeTeam: overrides.homeTeam,
      awayTeam: overrides.awayTeam,
      leagueSlug: "eng.1",
      kickoff: new Date(baseKickoff.getTime() + Math.random() * 1000 * 60 * 60 * 24),
      market: "Total Goals O/U 2.5",
      selection: "Over 2.5",
      statFamily: overrides.statFamily,
      modelProbability: 0.65,
      bookmakerOdds: 1.5,
      bookmakerName: "1xBet",
      impliedProbability: 1 / 1.5,
      ev: overrides.ev,
      oddsAtBuild: new Date(),
      scannedAt: new Date(),
    };
    // Apply overrides with nullish coalescing where needed
    return {
      ...base,
      ...overrides,
      matchLabel: overrides.matchLabel ?? base.matchLabel,
      leagueSlug: overrides.leagueSlug ?? base.leagueSlug,
      kickoff: overrides.kickoff ?? base.kickoff,
      market: overrides.market ?? base.market,
      selection: overrides.selection ?? base.selection,
      modelProbability: overrides.modelProbability ?? base.modelProbability,
      bookmakerOdds: overrides.bookmakerOdds ?? base.bookmakerOdds,
      bookmakerName: overrides.bookmakerName ?? base.bookmakerName,
      impliedProbability: overrides.impliedProbability ?? 1 / (overrides.bookmakerOdds ?? base.bookmakerOdds),
      oddsAtBuild: (overrides.oddsAtBuild as any) ?? base.oddsAtBuild,
      scannedAt: (overrides.scannedAt as any) ?? base.scannedAt,
    };
  }

  it("3. builds multiple tickets with controlled leg reuse (≤2 tickets per leg)", () => {
    const legs: VaLeg[] = [
      makeLeg({ eventId: "1", statFamily: "goals", homeTeam: "Arsenal", awayTeam: "Chelsea", ev: 0.2, kickoff: new Date("2026-09-13T12:00:00Z") }),
      makeLeg({ eventId: "2", statFamily: "corners", homeTeam: "Man City", awayTeam: "Liverpool", ev: 0.19, kickoff: new Date("2026-09-13T15:30:00Z") }),
      makeLeg({ eventId: "3", statFamily: "cards", homeTeam: "Barcelona", awayTeam: "Real Madrid", ev: 0.18, kickoff: new Date("2026-09-13T19:00:00Z") }),
      makeLeg({ eventId: "4", statFamily: "shots", homeTeam: "Bayern", awayTeam: "Dortmund", ev: 0.17, kickoff: new Date("2026-09-14T12:00:00Z") }),
      makeLeg({ eventId: "5", statFamily: "other", homeTeam: "PSG", awayTeam: "Lyon", ev: 0.16, kickoff: new Date("2026-09-14T15:00:00Z") }),
      makeLeg({ eventId: "6", statFamily: "goals", homeTeam: "Juventus", awayTeam: "Inter", ev: 0.15, kickoff: new Date("2026-09-14T18:00:00Z") }),
      makeLeg({ eventId: "7", statFamily: "corners", homeTeam: "Atletico", awayTeam: "Sevilla", ev: 0.14, kickoff: new Date("2026-09-15T12:00:00Z") }),
      makeLeg({ eventId: "8", statFamily: "cards", homeTeam: "Ajax", awayTeam: "PSV", ev: 0.13, kickoff: new Date("2026-09-15T15:00:00Z") }),
      makeLeg({ eventId: "9", statFamily: "shots", homeTeam: "Benfica", awayTeam: "Porto", ev: 0.12, kickoff: new Date("2026-09-15T19:00:00Z") }),
    ];

    const tickets = buildTickets(legs);
    expect(tickets.length).toBeGreaterThanOrEqual(3);

    const appearances = new Map<string, number>();
    for (const ticket of tickets) {
      const ids = ticket.legs.map((l) => l.eventId);
      // Distinct eventIds within a single ticket (unchanged rule).
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) appearances.set(id, (appearances.get(id) ?? 0) + 1);
    }
    // Controlled cross-ticket reuse: a leg may appear in at most 2 tickets.
    for (const count of appearances.values()) {
      expect(count).toBeLessThanOrEqual(2);
    }
  });

  it("4. enforces stat-family diversity", () => {
    const legs: VaLeg[] = [
      makeLeg({ eventId: "1", statFamily: "goals", homeTeam: "A", awayTeam: "B", ev: 0.3, kickoff: new Date("2026-09-13T12:00:00Z") }),
      makeLeg({ eventId: "2", statFamily: "goals", homeTeam: "C", awayTeam: "D", ev: 0.29, kickoff: new Date("2026-09-13T15:30:00Z") }),
      makeLeg({ eventId: "3", statFamily: "goals", homeTeam: "E", awayTeam: "F", ev: 0.28, kickoff: new Date("2026-09-13T19:00:00Z") }),
      makeLeg({ eventId: "4", statFamily: "corners", homeTeam: "G", awayTeam: "H", ev: 0.27, kickoff: new Date("2026-09-14T12:00:00Z") }),
      makeLeg({ eventId: "5", statFamily: "cards", homeTeam: "I", awayTeam: "J", ev: 0.26, kickoff: new Date("2026-09-14T15:00:00Z") }),
      makeLeg({ eventId: "6", statFamily: "shots", homeTeam: "K", awayTeam: "L", ev: 0.25, kickoff: new Date("2026-09-14T18:00:00Z") }),
    ];

    const tickets = buildTickets(legs);
    for (const ticket of tickets) {
      const familyCounts = new Map<string, number>();
      for (const leg of ticket.legs) {
        familyCounts.set(leg.statFamily, (familyCounts.get(leg.statFamily) ?? 0) + 1);
      }
      for (const count of familyCounts.values()) {
        expect(count).toBeLessThanOrEqual(2);
      }
    }
  });

  it("5. enforces team uniqueness", () => {
    const legs: VaLeg[] = [
      makeLeg({ eventId: "1", statFamily: "goals", homeTeam: "Arsenal", awayTeam: "Chelsea", ev: 0.3, kickoff: new Date("2026-09-13T12:00:00Z") }),
      makeLeg({ eventId: "2", statFamily: "corners", homeTeam: "Arsenal", awayTeam: "Man City", ev: 0.29, kickoff: new Date("2026-09-13T15:30:00Z") }),
      makeLeg({ eventId: "3", statFamily: "cards", homeTeam: "Liverpool", awayTeam: "Chelsea", ev: 0.28, kickoff: new Date("2026-09-13T19:00:00Z") }),
      makeLeg({ eventId: "4", statFamily: "shots", homeTeam: "Barcelona", awayTeam: "Real", ev: 0.27, kickoff: new Date("2026-09-14T12:00:00Z") }),
      makeLeg({ eventId: "5", statFamily: "other", homeTeam: "Bayern", awayTeam: "Dortmund", ev: 0.26, kickoff: new Date("2026-09-14T15:00:00Z") }),
      makeLeg({ eventId: "6", statFamily: "goals", homeTeam: "Juventus", awayTeam: "Inter", ev: 0.25, kickoff: new Date("2026-09-14T18:00:00Z") }),
    ];

    const tickets = buildTickets(legs);
    for (const ticket of tickets) {
      const teamCounts = new Map<string, number>();
      for (const leg of ticket.legs) {
        for (const team of [leg.homeTeam, leg.awayTeam]) {
          const key = team.toLowerCase();
          teamCounts.set(key, (teamCounts.get(key) ?? 0) + 1);
        }
      }
      for (const count of teamCounts.values()) {
        expect(count).toBeLessThanOrEqual(2);
      }
    }
  });

  it("6. exposure cap trims tickets beyond 6%", () => {
    // Create many legs with high kelly to exceed 6%
    const legs: VaLeg[] = [];
    for (let i = 0; i < 30; i++) {
      legs.push(
        makeLeg({
          eventId: `ev${i}`,
          statFamily: ["goals", "corners", "cards", "shots", "other"][i % 5],
          homeTeam: `Team${i * 2}`,
          awayTeam: `Team${i * 2 + 1}`,
          ev: 0.5 - i * 0.01,
          modelProbability: 0.7,
          bookmakerOdds: 1.5,
          kickoff: new Date(`2026-09-${13 + Math.floor(i / 5)}T${12 + (i % 5) * 3}:00:00Z`),
        })
      );
    }
    const tickets = buildTickets(legs);
    const active = tickets.filter((t) => !t.isReferenceOnly);
    const totalExposure = active.reduce((s, t) => s + t.stakePercent, 0);
    expect(totalExposure).toBeLessThanOrEqual(6.01);
    if (tickets.length > 1) {
      // At least one should be marked reference only if exposure would exceed
      const wouldExceed = tickets.reduce((s, t) => s + t.stakePercent, 0) > 6;
      if (wouldExceed) {
        expect(tickets.some((t) => t.isReferenceOnly)).toBe(true);
      }
    }
  });

  it("7. recommended flag lands on highest-kelly ticket", () => {
    const legs: VaLeg[] = [
      makeLeg({ eventId: "1", statFamily: "goals", homeTeam: "A", awayTeam: "B", ev: 0.5, modelProbability: 0.8, bookmakerOdds: 1.5, kickoff: new Date("2026-09-13T12:00:00Z") }),
      makeLeg({ eventId: "2", statFamily: "corners", homeTeam: "C", awayTeam: "D", ev: 0.4, modelProbability: 0.75, bookmakerOdds: 1.5, kickoff: new Date("2026-09-13T15:30:00Z") }),
      makeLeg({ eventId: "3", statFamily: "cards", homeTeam: "E", awayTeam: "F", ev: 0.3, modelProbability: 0.7, bookmakerOdds: 1.5, kickoff: new Date("2026-09-13T19:00:00Z") }),
      makeLeg({ eventId: "4", statFamily: "shots", homeTeam: "G", awayTeam: "H", ev: 0.2, modelProbability: 0.65, bookmakerOdds: 1.5, kickoff: new Date("2026-09-14T12:00:00Z") }),
      makeLeg({ eventId: "5", statFamily: "other", homeTeam: "I", awayTeam: "J", ev: 0.15, modelProbability: 0.6, bookmakerOdds: 1.5, kickoff: new Date("2026-09-14T15:00:00Z") }),
      makeLeg({ eventId: "6", statFamily: "goals", homeTeam: "K", awayTeam: "L", ev: 0.1, modelProbability: 0.55, bookmakerOdds: 1.5, kickoff: new Date("2026-09-14T18:00:00Z") }),
    ];
    const tickets = buildTickets(legs);
    expect(tickets.length).toBeGreaterThan(0);
    const recommended = tickets.filter((t) => t.isRecommended);
    expect(recommended.length).toBe(1);
    const highestKelly = Math.max(...tickets.map((t) => t.kellyScore));
    expect(recommended[0].kellyScore).toBeCloseTo(highestKelly, 5);
  });

  it("returns 1 ticket with combinedOdds ≈ 3.55 from 3 distinct events", () => {
    const legs: VaLeg[] = [
      makeLeg({ eventId: "1", statFamily: "goals", homeTeam: "A", awayTeam: "B", ev: 0.2, bookmakerOdds: 1.5, kickoff: new Date("2026-09-13T12:00:00Z") }),
      makeLeg({ eventId: "2", statFamily: "corners", homeTeam: "C", awayTeam: "D", ev: 0.19, bookmakerOdds: 1.5, kickoff: new Date("2026-09-13T15:30:00Z") }),
      makeLeg({ eventId: "3", statFamily: "cards", homeTeam: "E", awayTeam: "F", ev: 0.18, bookmakerOdds: 1.5777777778, kickoff: new Date("2026-09-13T19:00:00Z") }),
      makeLeg({ eventId: "1", statFamily: "shots", homeTeam: "A", awayTeam: "B", ev: 0.1, bookmakerOdds: 1.4, kickoff: new Date("2026-09-13T12:00:00Z") }),
    ];
    const tickets = buildTickets(legs);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].combinedOdds).toBeCloseTo(3.55, 2);
    expect(tickets[0].isRecommended).toBe(true);
    expect(tickets[0].isReferenceOnly).toBe(false);
    expect(new Set(tickets[0].legs.map((l) => l.eventId)).size).toBe(3);
  });

  it("returns no ticket when legs span only 2 distinct events", () => {
    const legs: VaLeg[] = [
      makeLeg({ eventId: "1", statFamily: "goals", homeTeam: "A", awayTeam: "B", ev: 0.2, bookmakerOdds: 1.5, kickoff: new Date("2026-09-13T12:00:00Z") }),
      makeLeg({ eventId: "1", statFamily: "corners", homeTeam: "A", awayTeam: "B", ev: 0.19, bookmakerOdds: 1.5, kickoff: new Date("2026-09-13T12:00:00Z") }),
      makeLeg({ eventId: "2", statFamily: "cards", homeTeam: "C", awayTeam: "D", ev: 0.18, bookmakerOdds: 1.58, kickoff: new Date("2026-09-13T15:30:00Z") }),
      makeLeg({ eventId: "2", statFamily: "shots", homeTeam: "C", awayTeam: "D", ev: 0.17, bookmakerOdds: 1.5, kickoff: new Date("2026-09-13T15:30:00Z") }),
    ];
    const tickets = buildTickets(legs);
    expect(tickets).toHaveLength(0);
  });

  it("FAMILY CAP: pool of 5 goals legs (distinct events) + 2 corners legs → every ticket has ≤2 goals legs", () => {
    const legs: VaLeg[] = [
      makeLeg({ eventId: "g1", statFamily: "goals", homeTeam: "GA", awayTeam: "GB", ev: 0.25, bookmakerOdds: 1.5, kickoff: new Date("2026-09-13T12:00:00Z") }),
      makeLeg({ eventId: "g2", statFamily: "goals", homeTeam: "GC", awayTeam: "GD", ev: 0.24, bookmakerOdds: 1.5, kickoff: new Date("2026-09-13T15:30:00Z") }),
      makeLeg({ eventId: "g3", statFamily: "goals", homeTeam: "GE", awayTeam: "GF", ev: 0.23, bookmakerOdds: 1.5, kickoff: new Date("2026-09-14T12:00:00Z") }),
      makeLeg({ eventId: "g4", statFamily: "goals", homeTeam: "GG", awayTeam: "GH", ev: 0.22, bookmakerOdds: 1.5, kickoff: new Date("2026-09-14T15:30:00Z") }),
      makeLeg({ eventId: "g5", statFamily: "goals", homeTeam: "GI", awayTeam: "GJ", ev: 0.21, bookmakerOdds: 1.5, kickoff: new Date("2026-09-14T19:00:00Z") }),
      makeLeg({ eventId: "c1", statFamily: "corners", homeTeam: "CA", awayTeam: "CB", ev: 0.20, bookmakerOdds: 1.5, kickoff: new Date("2026-09-15T12:00:00Z") }),
      makeLeg({ eventId: "c2", statFamily: "corners", homeTeam: "CC", awayTeam: "CD", ev: 0.19, bookmakerOdds: 1.5, kickoff: new Date("2026-09-15T15:30:00Z") }),
    ];
    const tickets = buildTickets(legs);
    expect(tickets.length).toBeGreaterThan(0);
    for (const ticket of tickets) {
      const goalsLegs = ticket.legs.filter((l) => l.statFamily === "goals").length;
      expect(goalsLegs).toBeLessThanOrEqual(2);
    }
  });

  // ─── Multi-ticket assembly (Fix 3: controlled leg reuse) ─────────────────────
  function diverseLegs(n: number): VaLeg[] {
    const families = ["goals", "corners", "cards", "shots", "other"];
    const legs: VaLeg[] = [];
    for (let i = 0; i < n; i++) {
      legs.push(
        makeLeg({
          eventId: `ev${i}`,
          statFamily: families[i % families.length],
          homeTeam: `Home${i}`,
          awayTeam: `Away${i}`,
          ev: 0.2 - i * 0.005,
          modelProbability: 0.65,
          bookmakerOdds: 1.5,
          kickoff: new Date(`2026-09-${13 + Math.floor(i / 5)}T${12 + (i % 5) * 3}:00:00Z`),
        }),
      );
    }
    return legs;
  }

  it("a. pool of 20 diverse legs → buildTickets returns 3-5 tickets", () => {
    const tickets = buildTickets(diverseLegs(20));
    expect(tickets.length).toBeGreaterThanOrEqual(3);
    expect(tickets.length).toBeLessThanOrEqual(5);
  });

  it("b. no leg appears in more than 2 tickets", () => {
    const tickets = buildTickets(diverseLegs(20));
    expect(tickets.length).toBeGreaterThan(0);
    const appearances = new Map<string, number>();
    for (const ticket of tickets) {
      for (const leg of ticket.legs) {
        appearances.set(leg.eventId, (appearances.get(leg.eventId) ?? 0) + 1);
      }
    }
    for (const count of appearances.values()) {
      expect(count).toBeLessThanOrEqual(2);
    }
  });

  it("c. same input twice → identical output (deterministic)", () => {
    const input = diverseLegs(20);
    const first = JSON.stringify(buildTickets(input));
    const second = JSON.stringify(buildTickets(input));
    expect(second).toBe(first);
  });

  it("d. two identical tickets (same eventIds) are deduped to one", () => {
    // A pool with exactly three diverse legs: the multi-ticket builder has
    // several seeds but every seed greedily fills to the same 3-eventId set,
    // so the dedupe must collapse them into a single ticket.
    const legs: VaLeg[] = [
      makeLeg({ eventId: "A", statFamily: "goals", homeTeam: "HomeA", awayTeam: "AwayA", ev: 0.2, bookmakerOdds: 1.5, kickoff: new Date("2026-09-13T12:00:00Z") }),
      makeLeg({ eventId: "B", statFamily: "corners", homeTeam: "HomeB", awayTeam: "AwayB", ev: 0.19, bookmakerOdds: 1.5, kickoff: new Date("2026-09-13T15:30:00Z") }),
      makeLeg({ eventId: "C", statFamily: "cards", homeTeam: "HomeC", awayTeam: "AwayC", ev: 0.18, bookmakerOdds: 1.5, kickoff: new Date("2026-09-13T19:00:00Z") }),
    ];
    const tickets = buildTickets(legs);
    expect(tickets).toHaveLength(1);
  });
});

describe("Value Accumulator — Stack mode", () => {
  function makeLeg(overrides: Partial<VaLeg> & { eventId: string }): VaLeg {
    const base: VaLeg = {
      scanId: "stack_scan",
      eventId: overrides.eventId,
      matchLabel: overrides.matchLabel ?? `${overrides.homeTeam ?? "H"} vs ${overrides.awayTeam ?? "A"}`,
      homeTeam: overrides.homeTeam ?? "H",
      awayTeam: overrides.awayTeam ?? "A",
      leagueSlug: "eng.1",
      kickoff: overrides.kickoff ?? new Date("2026-09-13T12:00:00Z"),
      market: "Total Goals O/U 2.5",
      selection: "Over 2.5",
      statFamily: overrides.statFamily ?? "goals",
      modelProbability: overrides.modelProbability ?? 0.85,
      bookmakerOdds: overrides.bookmakerOdds ?? 1.28,
      bookmakerName: "1xBet",
      impliedProbability: 1 / (overrides.bookmakerOdds ?? 1.28),
      ev: overrides.ev ?? 0.088,
      oddsAtBuild: new Date(),
      scannedAt: new Date(),
    };
    return { ...base, ...overrides };
  }

  it("builds 1 ticket with 6–8 legs and combinedOdds in [4.5, 7.5]", () => {
    const legs: VaLeg[] = [];
    for (let i = 0; i < 8; i++) {
      legs.push(
        makeLeg({
          eventId: `ev${i}`,
          homeTeam: `Home${i}`,
          awayTeam: `Away${i}`,
          // Mixed stat families (2 per family) — the FAMILY CAP allows at most
          // 2 legs per family, so a single-family pool can no longer fill a stack ticket.
          statFamily: ["goals", "corners", "cards", "shots"][i % 4],
          modelProbability: 0.85,
          bookmakerOdds: 1.28,
          ev: 0.088,
          kickoff: new Date(`2026-09-1${3 + (i % 4)}T12:00:00Z`),
        })
      );
    }
    const tickets = buildTickets(legs, "stack");
    expect(tickets).toHaveLength(1);
    expect(tickets[0].legs.length).toBeGreaterThanOrEqual(6);
    expect(tickets[0].legs.length).toBeLessThanOrEqual(8);
    expect(tickets[0].combinedOdds).toBeGreaterThanOrEqual(4.5);
    expect(tickets[0].combinedOdds).toBeLessThanOrEqual(7.5);
    expect(tickets[0].stakePercent).toBeLessThanOrEqual(1.0);
  });

  it("returns a ticket when only 4 legs are available (no 6-leg minimum)", () => {
    const legs: VaLeg[] = [];
    for (let i = 0; i < 4; i++) {
      legs.push(
        makeLeg({
          eventId: `ev${i}`,
          homeTeam: `Home${i}`,
          awayTeam: `Away${i}`,
          // One leg per stat family — the FAMILY CAP allows at most 2 per family,
          // so a distinct family per leg keeps the 4-leg ticket buildable.
          statFamily: ["goals", "corners", "cards", "shots"][i % 4],
          modelProbability: 0.85,
          bookmakerOdds: 1.28,
          ev: 0.088,
        })
      );
    }
    const tickets = buildTickets(legs, "stack");
    expect(tickets.length).toBeGreaterThanOrEqual(1);
    expect(tickets[0].legs.length).toBe(4);
  });

  it("FAMILY CAP: pool of 6 goals legs → every ticket has ≤2 goals legs", () => {
    const legs: VaLeg[] = [];
    for (let i = 0; i < 6; i++) {
      legs.push(
        makeLeg({
          eventId: `g${i}`,
          homeTeam: `Home${i}`,
          awayTeam: `Away${i}`,
          kickoff: new Date(`2026-09-1${3 + (i % 4)}T12:00:00Z`),
        })
      );
    }
    const tickets = buildTickets(legs, "stack");
    expect(tickets.length).toBeGreaterThan(0);
    for (const ticket of tickets) {
      const goalsLegs = ticket.legs.filter((l) => l.statFamily === "goals").length;
      expect(goalsLegs).toBeLessThanOrEqual(2);
    }
  });
});

describe("Value Accumulator — Immutability and Lock", () => {
  it("8. ticket immutability — second scan does not mutate first scan's tickets (logic)", () => {
    const legs1: VaLeg[] = [
      { scanId: "scan1", eventId: "1", matchLabel: "A vs B", homeTeam: "A", awayTeam: "B", leagueSlug: "eng.1", kickoff: new Date("2026-09-13T12:00:00Z"), market: "Total Goals O/U 2.5", selection: "Over 2.5", statFamily: "goals", modelProbability: 0.7, bookmakerOdds: 1.5, bookmakerName: "1xBet", impliedProbability: 0.666, ev: 0.26, oddsAtBuild: new Date(), scannedAt: new Date() },
      { scanId: "scan1", eventId: "2", matchLabel: "C vs D", homeTeam: "C", awayTeam: "D", leagueSlug: "eng.1", kickoff: new Date("2026-09-13T15:30:00Z"), market: "Total Corners O/U 9.5", selection: "Over 9.5", statFamily: "corners", modelProbability: 0.68, bookmakerOdds: 1.5, bookmakerName: "1xBet", impliedProbability: 0.666, ev: 0.258, oddsAtBuild: new Date(), scannedAt: new Date() },
      { scanId: "scan1", eventId: "3", matchLabel: "E vs F", homeTeam: "E", awayTeam: "F", leagueSlug: "eng.1", kickoff: new Date("2026-09-13T19:00:00Z"), market: "Total Cards O/U 3.5", selection: "Over 3.5", statFamily: "cards", modelProbability: 0.66, bookmakerOdds: 1.5, bookmakerName: "1xBet", impliedProbability: 0.666, ev: 0.254, oddsAtBuild: new Date(), scannedAt: new Date() },
    ];
    const tickets1 = buildTickets(legs1);
    const snapshot = JSON.stringify(tickets1);

    const legs2: VaLeg[] = [
      { scanId: "scan2", eventId: "4", matchLabel: "G vs H", homeTeam: "G", awayTeam: "H", leagueSlug: "eng.1", kickoff: new Date("2026-09-14T12:00:00Z"), market: "Total Goals O/U 2.5", selection: "Over 2.5", statFamily: "goals", modelProbability: 0.72, bookmakerOdds: 1.5, bookmakerName: "Bet365", impliedProbability: 0.666, ev: 0.404, oddsAtBuild: new Date(), scannedAt: new Date() },
      { scanId: "scan2", eventId: "5", matchLabel: "I vs J", homeTeam: "I", awayTeam: "J", leagueSlug: "eng.1", kickoff: new Date("2026-09-14T15:00:00Z"), market: "Total Corners O/U 9.5", selection: "Over 9.5", statFamily: "corners", modelProbability: 0.7, bookmakerOdds: 1.5, bookmakerName: "Bet365", impliedProbability: 0.666, ev: 0.33, oddsAtBuild: new Date(), scannedAt: new Date() },
      { scanId: "scan2", eventId: "6", matchLabel: "K vs L", homeTeam: "K", awayTeam: "L", leagueSlug: "eng.1", kickoff: new Date("2026-09-14T18:00:00Z"), market: "Total Cards O/U 3.5", selection: "Over 3.5", statFamily: "cards", modelProbability: 0.68, bookmakerOdds: 1.5, bookmakerName: "Bet365", impliedProbability: 0.666, ev: 0.258, oddsAtBuild: new Date(), scannedAt: new Date() },
    ];
    const tickets2 = buildTickets(legs2);

    // tickets1 should remain unchanged
    expect(JSON.stringify(tickets1)).toBe(snapshot);
    expect(tickets2[0].scanId).toBe("scan2");
    expect(tickets1[0].scanId).toBe("scan1");
  });

  it("9. scan lock prevents concurrent runs (logic)", () => {
    const now = Date.now();
    const lockedAt = new Date(now - 2 * 60 * 1000); // 2 minutes ago
    const fiveMinutes = 5 * 60 * 1000;
    const isLocked = Date.now() - lockedAt.getTime() < fiveMinutes;
    expect(isLocked).toBe(true);

    const oldLock = new Date(now - 6 * 60 * 1000); // 6 minutes ago
    const isOldLocked = Date.now() - oldLock.getTime() < fiveMinutes;
    expect(isOldLocked).toBe(false);
  });

  it("10. void leg produces status = partial (logic)", () => {
    // Simulate settlement logic: if any leg void, ticket partial
    function settleTicket(legOutcomes: Array<"won" | "lost" | "void">): "win" | "loss" | "partial" {
      if (legOutcomes.includes("lost")) return "loss";
      if (legOutcomes.includes("void")) return "partial";
      return "win";
    }

    expect(settleTicket(["won", "won", "won"])).toBe("win");
    expect(settleTicket(["won", "lost", "won"])).toBe("loss");
    expect(settleTicket(["won", "void", "won"])).toBe("partial");
    expect(settleTicket(["won", "void", "lost"])).toBe("loss"); // loss takes precedence
  });
});

describe("Value Accumulator — Finished backtest settlement", () => {
  it("settles stack tickets against finished matches (2-1 and 0-0)", async () => {
    const results = new Map<string, BacktestMatchResult>([
      ["fx_21", { leagueSlug: "eng.1", homeScore: 2, awayScore: 1, corners: null }],
      ["fx_00", { leagueSlug: "eng.1", homeScore: 0, awayScore: 0, corners: null }],
    ]);
    const leg = (eventId: string, market: string, selection: string, home: string, away: string): VaLeg => ({
      scanId: "backtest", eventId, matchLabel: `${home} vs ${away}`, homeTeam: home, awayTeam: away,
      leagueSlug: "eng.1", kickoff: new Date("2026-09-10T15:00:00Z"), market, selection, statFamily: "goals",
      modelProbability: 0.85, bookmakerOdds: 1.3, bookmakerName: "Consensus", impliedProbability: 1 / 1.3, ev: 0.1,
    });
    // Ticket 1 wins every leg (Over 0.5 beats 2-1, BTTS "No" beats 0-0); Over 3.5 reaches neither result.
    const wonTickets = buildTickets([
      leg("fx_21", "Total Goals O/U 0.5", "Over 0.5", "Alpha", "Beta"),
      leg("fx_00", "Both Teams To Score", "No", "Gamma", "Delta"),
    ], "stack");
    const lostTickets = buildTickets([
      leg("fx_21", "Total Goals O/U 3.5", "Over 3.5", "Alpha", "Beta"),
      leg("fx_00", "Total Goals O/U 3.5", "Over 3.5", "Gamma", "Delta"),
    ], "stack");
    expect(wonTickets).toHaveLength(1);
    expect(lostTickets).toHaveLength(1);
    const [wonStatus] = await settleBacktestTickets(wonTickets, results);
    const [lostStatus] = await settleBacktestTickets(lostTickets, results);
    expect(wonStatus).toBe("won");
    expect(lostStatus).toBe("lost");
  });
});

describe("Value Accumulator — Correlation discount", () => {
  const K = 0.92;

  function makeDiscountLeg(
    eventId: string,
    modelProbability: number,
    bookmakerOdds: number,
    statFamily: string,
    kickoff?: Date
  ): VaLeg {
    return {
      scanId: "discount_scan",
      eventId,
      matchLabel: `${eventId} match`,
      homeTeam: `H${eventId}`,
      awayTeam: `A${eventId}`,
      leagueSlug: "eng.1",
      kickoff: kickoff ?? new Date("2026-09-13T12:00:00Z"),
      market: "Total Goals O/U 2.5",
      selection: "Over 2.5",
      statFamily,
      modelProbability,
      bookmakerOdds,
      bookmakerName: "1xBet",
      impliedProbability: 1 / bookmakerOdds,
      ev: modelProbability * bookmakerOdds - 1,
      oddsAtBuild: new Date(),
      scannedAt: new Date(),
    };
  }

  // Helper: build a 4-leg value ticket with perLegOdds whose product falls
  // inside the assembler's [3.0, 4.5] window, with one leg per stat family.
  function fourLegValueTicket(prob: number, perLegOdds: number) {
    const legs: VaLeg[] = [
      makeDiscountLeg("e1", prob, perLegOdds, "goals", new Date("2026-09-14T12:00:00Z")),
      makeDiscountLeg("e2", prob, perLegOdds, "corners", new Date("2026-09-14T15:00:00Z")),
      makeDiscountLeg("e3", prob, perLegOdds, "cards", new Date("2026-09-15T12:00:00Z")),
      makeDiscountLeg("e4", prob, perLegOdds, "shots", new Date("2026-09-15T15:00:00Z")),
    ];
    return { legs, tickets: buildTickets(legs) };
  }

  it("a. 4 legs each with modelProbability 0.82: combinedProbability = independentProbability * 0.92^4", () => {
    // perLegOdds 1.42 → combinedOdds ≈ 4.07 (inside [3.0, 4.5]); ev = 0.82*1.42-1 ≈ 0.164 positive.
    const { tickets } = fourLegValueTicket(0.82, 1.42);
    expect(tickets.length).toBeGreaterThan(0);
    const t = tickets[0];
    expect(t.legs.length).toBe(4);
    const expectedIndependent = Math.pow(0.82, 4);
    const expectedDiscount = Math.pow(K, 4);
    expect(t.independentProbability).toBeCloseTo(expectedIndependent, 3);
    expect(t.combinedProbability).toBeCloseTo(expectedIndependent * expectedDiscount, 3);
  });

  it("b. 2 legs each with modelProbability 0.70 → combinedProbability = 0.49 * 0.92^2 ≈ 0.4147", () => {
    // Closed-form check (the value builder requires ≥3 legs, but the discount
    // formula is uniform across leg counts).
    expect(Math.pow(0.70, 2)).toBeCloseTo(0.49, 4);
    expect(Math.pow(K, 2)).toBeCloseTo(0.8464, 4);
    expect(0.49 * Math.pow(K, 2)).toBeCloseTo(0.4147, 4);

    // Exercise the code path on a 3-leg ticket at 0.70 across 3 families to
    // confirm the builder applies the same formula end-to-end.
    const legs: VaLeg[] = [
      makeDiscountLeg("e1", 0.70, 1.5, "goals", new Date("2026-09-14T12:00:00Z")),
      makeDiscountLeg("e2", 0.70, 1.5, "corners", new Date("2026-09-14T15:00:00Z")),
      makeDiscountLeg("e3", 0.70, 1.5, "cards", new Date("2026-09-15T12:00:00Z")),
    ];
    const tickets = buildTickets(legs);
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets[0].legs.length).toBe(3);
    expect(tickets[0].combinedProbability).toBeCloseTo(
      Math.pow(0.70, 3) * Math.pow(K, 3),
      3
    );
  });

  it("c. independentProbability is the raw product, unchanged by the discount", () => {
    const { tickets } = fourLegValueTicket(0.82, 1.42);
    expect(tickets.length).toBeGreaterThan(0);
    const t = tickets[0];
    expect(t.independentProbability).toBeCloseTo(Math.pow(0.82, t.legs.length), 3);
    // independentProbability must strictly exceed the discounted combinedProbability.
    expect(t.independentProbability).toBeGreaterThan(t.combinedProbability);
  });

  it("d. combinedEv, kellyScore and stakePercent all use the discounted combinedProbability", () => {
    const { tickets } = fourLegValueTicket(0.82, 1.42);
    expect(tickets.length).toBeGreaterThan(0);
    const t = tickets[0];
    const discount = Math.pow(K, t.legs.length);
    const expectedCombined = t.independentProbability * discount;
    expect(t.combinedProbability).toBeCloseTo(expectedCombined, 4);
    const expectedEv = expectedCombined * t.combinedOdds - 1;
    expect(t.combinedEv).toBeCloseTo(expectedEv, 3);
    const expectedKelly = t.combinedOdds > 1 ? expectedEv / (t.combinedOdds - 1) : 0;
    expect(t.kellyScore).toBeCloseTo(expectedKelly, 3);
    expect(t.stakePercent).toBe(Math.min(0.5 * expectedKelly * 100, 2));
    // EV computed from the naive (undiscounted) product must be strictly higher.
    const naiveEv = t.independentProbability * t.combinedOdds - 1;
    expect(t.combinedEv).toBeLessThan(naiveEv);

    // Spec's worked example: 4 legs @ 0.82 with odds 1.30 each combine to
    // ≈2.856. The discount pushes combined EV materially below the naive EV
    // (for fair-line bets it flips negative). Verify the arithmetic directly
    // since the builder rejects combinedOdds < 3.0.
    const specCombinedOdds = Math.pow(1.3, 4);
    expect(specCombinedOdds).toBeCloseTo(2.856, 3);
    const specIndependent = Math.pow(0.82, 4);
    const specCombined = specIndependent * Math.pow(K, 4);
    const specEv = specCombined * specCombinedOdds - 1;
    const naiveSpecEv = specIndependent * specCombinedOdds - 1;
    expect(specEv).toBeLessThan(naiveSpecEv);
  });
});

describe("Value Accumulator — Self-learning market reliability", () => {
  it("a. marketKeyOf(\"Total Goals O/U 1.5\", \"Over 1.5\", \"Goals\") === \"Goals:TotalO/U:1.5:Over\"", () => {
    expect(marketKeyOf("Total Goals O/U 1.5", "Over 1.5", "Goals")).toBe("Goals:TotalO/U:1.5:Over");
  });

  it("b. marketKeyOf(\"Both Teams To Score\", \"Yes\", \"Goals\") === \"Goals:BTTS:Yes\"", () => {
    expect(marketKeyOf("Both Teams To Score", "Yes", "Goals")).toBe("Goals:BTTS:Yes");
  });

  it("normalises other market keys according to rules", () => {
    expect(marketKeyOf("Total Goals O/U 3.5", "Under 3.5", "Goals")).toBe("Goals:TotalO/U:3.5:Under");
    expect(marketKeyOf("Total Corners O/U 8.5", "Over 8.5", "Corners")).toBe("Corners:TotalO/U:8.5:Over");
    expect(marketKeyOf("Arsenal Corners O/U 4.5", "Over 4.5", "Corners")).toBe("Corners:Team:4.5:Over");
    expect(marketKeyOf("Total Cards O/U 2.5", "Under 2.5", "Cards")).toBe("Cards:TotalO/U:2.5:Under");
    expect(marketKeyOf("Chelsea Cards O/U 1.5", "Over 1.5", "Cards")).toBe("Cards:Team:1.5:Over");
    expect(marketKeyOf("Match Winner", "Home", "Goals")).toBe("Goals:Other:Match Winner");
  });

  it("c. Given a mocked marketStats row for \"Goals:TotalO/U:1.5:Over\" with n=100, claimedSum=70, realisedSum=68 (corr 0.971): a leg with modelProbability=0.70 and that market key gets an adjustedProb ≈ 0.68", () => {
    const mockStats = new Map([
      [
        "Goals:TotalO/U:1.5:Over",
        {
          marketKey: "Goals:TotalO/U:1.5:Over",
          family: "Goals",
          n: 100,
          claimedSum: 70,
          realisedSum: 68,
        },
      ],
    ]);
    const leg = {
      market: "Total Goals O/U 1.5",
      selection: "Over 1.5",
      statFamily: "Goals",
      modelProbability: 0.70,
    };
    const result = applyMarketCorrection(leg, mockStats);
    expect(result.filtered).toBe(false);
    expect(result.level).toBe("line");
    expect(result.correction).toBeCloseTo(68 / 70, 3);
    expect(result.adjustedProb).toBeCloseTo(0.68, 2);
  });

  it("d. Given the same row with n=100, claimedSum=70, realisedSum=50 (corr 0.714, filtered): the leg is skipped by the qualification path", () => {
    const mockStats = new Map([
      [
        "Goals:TotalO/U:1.5:Over",
        {
          marketKey: "Goals:TotalO/U:1.5:Over",
          family: "Goals",
          n: 100,
          claimedSum: 70,
          realisedSum: 50,
        },
      ],
    ]);
    const leg = {
      market: "Total Goals O/U 1.5",
      selection: "Over 1.5",
      statFamily: "Goals",
      modelProbability: 0.70,
    };
    const result = applyMarketCorrection(leg, mockStats);
    expect(result.filtered).toBe(true);
  });
});

describe("Value Accumulator — family correction requires 3+ keys", () => {
  // The family-level aggregate must not fire off a single market key: when a
  // family holds only one overclaiming line (e.g. Under 3.5 goals at corr
  // 0.647), that correction used to be applied to every leg in the family —
  // including unrelated markets like Over 2.5 goals. Below 3 distinct keys the
  // family fallback is skipped entirely (same as no data).

  it("1. does NOT fire the family fallback when only 1 key exists in the family (n>=40): correction stays 1.0", () => {
    // Single Goals row: n=46, claimedSum=46, realisedSum=29.762 → corr 0.647.
    const mockStats = new Map([
      [
        "Goals:TotalO/U:3.5:Under",
        {
          marketKey: "Goals:TotalO/U:3.5:Under",
          family: "Goals",
          n: 46,
          claimedSum: 46,
          realisedSum: 29.762,
        },
      ],
    ]);
    // A DIFFERENT goals leg (its own key has no stats, so the line level
    // misses and the old code fell through to the poisoned family aggregate).
    const leg = {
      market: "Total Goals O/U 2.5",
      selection: "Over 2.5",
      statFamily: "Goals",
      modelProbability: 0.80,
    };
    const result = applyMarketCorrection(leg, mockStats);
    expect(result.level).toBe("none");
    expect(result.correction).toBe(1.0);
    expect(result.adjustedProb).toBe(0.80);
    expect(result.filtered).toBe(false);
  });

  it("2. DOES fire the family fallback when 3 keys exist in the family (total n>=40): correction is the aggregate ratio", () => {
    const mockStats = new Map([
      [
        "Goals:TotalO/U:1.5:Over",
        { marketKey: "Goals:TotalO/U:1.5:Over", family: "Goals", n: 20, claimedSum: 16, realisedSum: 13 },
      ],
      [
        "Goals:TotalO/U:2.5:Over",
        { marketKey: "Goals:TotalO/U:2.5:Over", family: "Goals", n: 14, claimedSum: 10, realisedSum: 8 },
      ],
      [
        "Goals:BTTS:Yes",
        { marketKey: "Goals:BTTS:Yes", family: "Goals", n: 12, claimedSum: 7, realisedSum: 4 },
      ],
    ]);
    // Aggregate: n=46, claimedSum=33, realisedSum=25 → ratio 25/33 ≈ 0.7576.
    const leg = {
      market: "Total Goals O/U 3.5",
      selection: "Under 3.5",
      statFamily: "Goals",
      modelProbability: 0.80,
    };
    const result = applyMarketCorrection(leg, mockStats);
    expect(result.level).toBe("family");
    expect(result.correction).toBeCloseTo(25 / 33, 3);
    expect(result.adjustedProb).toBeCloseTo(0.8 * (25 / 33), 3);
    expect(result.filtered).toBe(false);
  });

  it("3. line-level correction still works with 1 key in the family (unchanged)", () => {
    // Single Goals row for the leg's OWN market key: the line level does not
    // care about the family key count at all.
    const mockStats = new Map([
      [
        "Goals:TotalO/U:2.5:Over",
        {
          marketKey: "Goals:TotalO/U:2.5:Over",
          family: "Goals",
          n: 46,
          claimedSum: 46,
          realisedSum: 29.762,
        },
      ],
    ]);
    const leg = {
      market: "Total Goals O/U 2.5",
      selection: "Over 2.5",
      statFamily: "Goals",
      modelProbability: 0.80,
    };
    const result = applyMarketCorrection(leg, mockStats);
    expect(result.level).toBe("line");
    expect(result.correction).toBeCloseTo(0.647, 3);
    expect(result.adjustedProb).toBeCloseTo(0.8 * 0.647, 3);
    // Unchanged hard-filter behaviour (existing test d): the line itself is
    // proven bad (n>=30, corr 0.647 < 0.75), so the leg is filtered too.
    expect(result.filtered).toBe(true);
  });
});

// ─── Bzzoiro xG fetcher + engine xG chain ─────────────────────────────────────
//
// The real per-match xG lives at GET /events/{id}/stats/ but every value is
// null until the match is finished, so the live scanner grounds on rolling
// team averages (GET /events/?team_id=&status=finished) instead. These tests
// mock the fetch layer — no real network calls.

describe("Value Accumulator — Bzzoiro xG fetcher", () => {
  // xgFetcher reads BZOOIRO_BASE at module scope, so every test gets a fresh
  // copy with the test base URL (same convention as eventResolution.test.ts).
  async function freshXgModule() {
    vi.resetModules();
    return import("./xgFetcher");
  }

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

  beforeEach(() => {
    vi.stubEnv("BZOOIRO_KEY", "test-key");
    vi.stubEnv("BZOOIRO_BASE", "https://sports.bzzoiro.test/api/v2");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("1. fetchMatchXg returns null when BZOOIRO_KEY is unset", async () => {
    vi.stubEnv("BZOOIRO_KEY", "");
    const { fetchMatchXg } = await freshXgModule();
    const fetchMock = vi.fn(async () => {
      throw new Error("must not hit the network without a key");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMatchXg("223510")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("2. fetchMatchXg parses a mocked /events/{id}/stats/ response (actual xG)", async () => {
    const { fetchMatchXg } = await freshXgModule();
    const fetchMock = stubFetch([
      {
        match: (url) => url.endsWith("/events/223510/stats/"),
        body: statsBody({ actual: 1.82, estimated: false }, { actual: 0.75, estimated: false }),
      },
    ]);

    await expect(fetchMatchXg("223510")).resolves.toEqual({
      homeXg: 1.82,
      awayXg: 0.75,
      source: "bzzoiro-match",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/events/223510/stats/");
  });

  it("2b. fetchMatchXg falls back to xg.estimated when xg.actual is null", async () => {
    const { fetchMatchXg } = await freshXgModule();
    stubFetch([
      {
        match: (url) => url.endsWith("/events/223511/stats/"),
        body: statsBody({ actual: null, estimated: 1.4 }, { actual: null, estimated: null }),
      },
    ]);

    // One-sided: the estimated home value is kept, the away side stays null.
    await expect(fetchMatchXg("223511")).resolves.toEqual({
      homeXg: 1.4,
      awayXg: null,
      source: "bzzoiro-match",
    });
  });

  it("3. fetchMatchXg returns null when both xg fields are null", async () => {
    const { fetchMatchXg } = await freshXgModule();
    stubFetch([
      {
        match: (url) => url.endsWith("/events/999/stats/"),
        // Upcoming match: every stats value is null until full-time.
        body: statsBody({ actual: null, estimated: null }, { actual: null, estimated: null }),
      },
    ]);

    await expect(fetchMatchXg("999")).resolves.toBeNull();
  });

  it("4. fetchTeamXgAverage averages xG for across 3 finished matches", async () => {
    const { fetchTeamXgAverage } = await freshXgModule();
    const teamId = 101;
    const fetchMock = stubFetch([
      {
        match: (url) =>
          url.includes(`/events/?team_id=${teamId}`) &&
          url.includes("status=finished") &&
          url.includes("limit=5"),
        body: {
          count: 3,
          next: null,
          previous: null,
          results: [
            { id: 3001, home_team_id: 101, away_team_id: 202, event_date: "2026-09-10", status: "finished" },
            { id: 3002, home_team_id: 202, away_team_id: 101, event_date: "2026-09-03", status: "finished" },
            { id: 3003, home_team_id: 101, away_team_id: 303, event_date: "2026-08-27", status: "finished" },
          ],
        },
      },
      { match: (url) => url.endsWith("/events/3001/stats/"), body: statsBody({ actual: 2.0 }, { actual: 1.0 }) },
      { match: (url) => url.endsWith("/events/3002/stats/"), body: statsBody({ actual: 0.5 }, { actual: 1.5 }) },
      { match: (url) => url.endsWith("/events/3003/stats/"), body: statsBody({ actual: 1.1 }, { actual: 0.9 }) },
    ]);

    // Team 101: home in matches 1 & 3, away in match 2.
    // xgFor     = (2.0 + 1.5 + 1.1) / 3 = 1.53
    // xgAgainst = (1.0 + 0.5 + 0.9) / 3 = 0.80
    await expect(fetchTeamXgAverage(teamId, 5)).resolves.toEqual({
      teamId: 101,
      xgFor: 1.53,
      xgAgainst: 0.8,
      samples: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 team list + 3 match stats
  });

  it("5. fetchTeamXgAverage returns null when all 3 match stats return null", async () => {
    const { fetchTeamXgAverage } = await freshXgModule();
    stubFetch([
      {
        match: (url) => url.includes("/events/?team_id=101") && url.includes("status=finished"),
        body: {
          count: 3,
          next: null,
          previous: null,
          results: [
            { id: 3001, home_team_id: 101, away_team_id: 202, event_date: "2026-09-10", status: "finished" },
            { id: 3002, home_team_id: 202, away_team_id: 101, event_date: "2026-09-03", status: "finished" },
            { id: 3003, home_team_id: 101, away_team_id: 303, event_date: "2026-08-27", status: "finished" },
          ],
        },
      },
      {
        match: (url) => /\/events\/300\d\/stats\/$/.test(url),
        body: statsBody({ actual: null, estimated: null }, { actual: null, estimated: null }),
      },
    ]);

    await expect(fetchTeamXgAverage(101, 5)).resolves.toBeNull();
  });
});

describe("Engine — xG preference chain (realLambdas)", () => {
  it("6. sum.__homeXg = 1.85 → realHomeXG = 1.85", async () => {
    const { resolveRealXg } = await import("@/lib/engine/realLambdas");
    const sum = { __homeXg: 1.85, __awayXg: 0.9 } as never;

    const { realHomeXG, realAwayXG } = resolveRealXg(sum, null, undefined);
    expect(realHomeXG).toBe(1.85);
    expect(realAwayXG).toBe(0.9);
  });

  it("6b. __homeXgSource names the grounding layer for logging; without it the layer is 'bzzoiro'", async () => {
    const { resolveRealXg } = await import("@/lib/engine/realLambdas");

    // Live scanner attaches the rolling-average source label.
    const live = resolveRealXg(
      { __homeXg: 1.4, __homeXgSource: "bzzoiro-team-avg" } as never,
      null,
      undefined,
    );
    expect(live.xgSource).toBe("bzzoiro-team-avg");

    // Backtest attaches the per-match source label.
    const backtest = resolveRealXg(
      { __homeXg: 1.82, __homeXgSource: "bzzoiro-match" } as never,
      null,
      undefined,
    );
    expect(backtest.xgSource).toBe("bzzoiro-match");

    // Legacy attach (no source key) still reports the plain bzzoiro layer.
    const legacy = resolveRealXg({ __homeXg: 1.85 } as never, null, undefined);
    expect(legacy.xgSource).toBe("bzzoiro");
  });
});

// ─── Corners mesh shrinkage, one leg per match, leg probability cap ───────────
//
// FIX 1 — realLambdas.shrinkCorners(): sample-size-aware shrinkage of the model
// corner λ toward the mesh mean, with per-team (9.0) and per-match (13.0)
// ceilings. Corners swing 3-4 per match on a mean of ~5, so a 5-match mesh mean
// must not be trusted at the fixed 0.65 weight the other stats use.
//
// FIX 2 — ticket.ts: at most one leg per eventId, full stop (both modes).
//
// FIX 3 — scanner.ts: a leg's model probability is capped at 0.90 before the EV
// maths and before it is stored / ticketed.

describe("Engine — corners mesh shrinkage (realLambdas)", () => {
  it("1. blends with weight samples/(samples+10): 5 matches → 5/15, giving 5.83 not 6.625", async () => {
    const { shrinkCorners } = await import("@/lib/engine/realLambdas");

    const modelCorners = 5.0;
    const meshMean     = 7.5;
    const samples      = 5;

    // meshWeight = min(0.65, 5 / 15) = 1/3
    const blended = shrinkCorners(modelCorners, meshMean, samples);

    expect(blended).toBeCloseTo(5.0 * (1 - 5 / 15) + 7.5 * (5 / 15), 6); // 5.8333
    expect(blended).toBeCloseTo(5.83, 2);

    // The old fixed-0.65 weight gave 6.625 — the shrinkage must NOT.
    const oldFixedWeight = modelCorners * 0.35 + meshMean * 0.65;
    expect(oldFixedWeight).toBeCloseTo(6.625, 3);
    expect(blended).not.toBeCloseTo(oldFixedWeight, 2);
    expect(blended).toBeLessThan(oldFixedWeight);
  });

  it("1b. the weight grows with the sample size and saturates at 0.65", async () => {
    const { shrinkCorners } = await import("@/lib/engine/realLambdas");

    // n = 20 → 20/30 = 0.65, i.e. the old fixed weight is the large-sample limit.
    expect(shrinkCorners(5.0, 7.5, 20)).toBeCloseTo(5.0 * 0.35 + 7.5 * 0.65, 6);
    expect(shrinkCorners(5.0, 7.5, 40)).toBeCloseTo(shrinkCorners(5.0, 7.5, 20), 6);

    // Small samples trust the mesh less than large ones.
    expect(shrinkCorners(5.0, 7.5, 5)).toBeLessThan(shrinkCorners(5.0, 7.5, 10));
    expect(shrinkCorners(5.0, 7.5, 10)).toBeLessThan(shrinkCorners(5.0, 7.5, 20));
  });

  it("2. never exceeds 9.0 per team, even when the mesh mean is a wild 15", async () => {
    const { shrinkCorners, MAX_TEAM_CORNERS } = await import("@/lib/engine/realLambdas");

    expect(MAX_TEAM_CORNERS).toBe(9.0);

    // Large sample → weight 0.65 → 5.0*0.35 + 15*0.65 = 11.5 → capped at 9.0.
    const large = shrinkCorners(5.0, 15, 40);
    expect(large).toBe(MAX_TEAM_CORNERS);
    expect(large).toBeLessThan(5.0 * 0.35 + 15 * 0.65);

    // Small sample, same wild mean → 5.0*(2/3) + 15*(1/3) = 8.33, under the cap.
    const small = shrinkCorners(5.0, 15, 5);
    expect(small).toBeCloseTo(5.0 * (1 - 5 / 15) + 15 * (5 / 15), 6);
    expect(small).toBeLessThanOrEqual(MAX_TEAM_CORNERS);
    expect(small).toBeLessThan(large);
  });

  // End-to-end through the shipped builder: a Serie A fixture whose mesh claims
  // 15 corners per match for both sides (a small-sample hot streak).
  function serieAFixture(): FixtureLite {
    const team = (side: "home" | "away", name: string, abbrev: string) => ({
      id: `${side}-id`, name, shortName: name, abbrev,
      logo: null, color: null, score: null, homeAway: side,
    });
    return {
      id: "serie-a-1",
      leagueSlug: "ita.1",
      leagueName: "Serie A",
      date: "2026-09-20T18:45:00Z",
      state: "pre",
      statusDetail: "Scheduled",
      venue: null,
      home: team("home", "Roma", "ROM"),
      away: team("away", "Inter Milan", "INT"),
      neutralSite: false,
    } as unknown as FixtureLite;
  }

  function profile(samples: number, cornersMean: number): TeamStatProfile {
    const d = (mean: number): StatDistribution => ({ mean, std: mean * 0.35, n: samples });
    return {
      teamId: "team-1", samples,
      shots: d(12.5), sot: d(4.4), corners: d(cornersMean), cards: d(2.1),
      fouls: d(11.5), offsides: d(2.0), saves: d(3.1), possession: d(50),
      passes: d(420), passAccuracy: d(82), crosses: d(16), longBalls: d(24),
      tackles: d(16), clearances: d(18), interceptions: d(11), blockedShots: d(4),
    };
  }

  it("2b. end-to-end: buildRealLambdas caps team corners at 9.0 and the match total at 13.0", async () => {
    const { buildRealLambdas, MAX_TEAM_CORNERS, MAX_TOTAL_CORNERS } =
      await import("@/lib/engine/realLambdas");

    const { lam, notes } = buildRealLambdas(serieAFixture(), null, {
      home: profile(40, 15),
      away: profile(40, 15),
    });

    // Uncapped this would be 5.3*0.35 + 15*0.65 ≈ 11.6 per side (23.2 in total).
    expect(lam.homeCorners).toBeLessThanOrEqual(MAX_TEAM_CORNERS);
    expect(lam.awayCorners).toBeLessThanOrEqual(MAX_TEAM_CORNERS);
    expect(lam.homeCorners + lam.awayCorners).toBeCloseTo(MAX_TOTAL_CORNERS, 6);
    expect(notes.some((n) => n.startsWith("CORNERS CAP"))).toBe(true);
  });

  it("2c. end-to-end: a 5-match mesh pulls the corners λ toward its mean far less than a 40-match mesh", async () => {
    const { buildRealLambdas } = await import("@/lib/engine/realLambdas");

    // Mesh mean well below the model λ, and low enough that neither the 9.0
    // team cap nor the 13.0 total cap binds — so what is measured here is the
    // sample-size shrinkage itself.
    const base  = buildRealLambdas(serieAFixture(), null, undefined);
    const thin  = buildRealLambdas(serieAFixture(), null, { home: profile(5, 3),  away: profile(5, 3)  });
    const thick = buildRealLambdas(serieAFixture(), null, { home: profile(40, 3), away: profile(40, 3) });

    const modelHome = base.lam.homeCorners;
    expect(modelHome).toBeGreaterThan(thin.lam.homeCorners);   // the mesh does pull it down
    expect(thin.lam.homeCorners).toBeGreaterThan(thick.lam.homeCorners);

    // Distance from the model λ shrinks as the sample grows.
    expect(Math.abs(thin.lam.homeCorners - modelHome))
      .toBeLessThan(Math.abs(thick.lam.homeCorners - modelHome));
  });

  it("2d. end-to-end: the 13.0 total ceiling dominates even when the team cap does not bind first", async () => {
    const { buildRealLambdas, MAX_TOTAL_CORNERS } = await import("@/lib/engine/realLambdas");

    // A 5-match mesh of 15 corners: weight 1/3 gives ~8.6/~8.2 per side, so the
    // 9.0 team cap never fires — but 16.8 in total still breaches the ceiling.
    const thin = buildRealLambdas(serieAFixture(), null, { home: profile(5, 15), away: profile(5, 15) });

    expect(thin.lam.homeCorners).toBeLessThan(9.0);
    expect(thin.lam.homeCorners + thin.lam.awayCorners).toBeCloseTo(MAX_TOTAL_CORNERS, 6);
    expect(thin.notes.some((n) => n.startsWith("CORNERS CAP"))).toBe(true);
  });
});

describe("Value Accumulator — one leg per eventId", () => {
  function leg(overrides: Partial<VaLeg> & { eventId: string }): VaLeg {
    const kickoff = overrides.kickoff ?? new Date("2026-09-20T18:45:00Z");
    const bookmakerOdds = overrides.bookmakerOdds ?? 1.28;
    return {
      scanId: "scan_x",
      eventId: overrides.eventId,
      matchLabel: `${overrides.homeTeam ?? "H"} vs ${overrides.awayTeam ?? "A"}`,
      homeTeam: overrides.homeTeam ?? "H",
      awayTeam: overrides.awayTeam ?? "A",
      leagueSlug: "ita.1",
      kickoff,
      market: overrides.market ?? "Total Corners O/U 9.5",
      selection: overrides.selection ?? "Over 9.5",
      statFamily: overrides.statFamily ?? "corners",
      modelProbability: overrides.modelProbability ?? 0.85,
      bookmakerOdds,
      bookmakerName: "1xBet",
      impliedProbability: 1 / bookmakerOdds,
      ev: overrides.ev ?? 0.088,
      oddsAtBuild: new Date("2026-09-18T09:00:00Z"),
      scannedAt: new Date("2026-09-18T09:00:00Z"),
    };
  }

  it("3. stack mode: 2 legs from the same eventId → only 1 enters the ticket", () => {
    // The two Roma/Inter legs are the top-2 by EV, so the greedy fill is
    // actively tempted to take both. Under the old rule (1 leg per
    // eventId+family pair) the stack came out with 8 legs; the second Roma leg
    // must now be rejected.
    const legs: VaLeg[] = [
      leg({ eventId: "roma-inter", statFamily: "corners", ev: 0.095, homeTeam: "Roma", awayTeam: "Inter Milan" }),
      leg({ eventId: "roma-inter", statFamily: "goals",   ev: 0.090, homeTeam: "Roma", awayTeam: "Inter Milan" }),
      leg({ eventId: "juve-milan", statFamily: "cards",   ev: 0.088, homeTeam: "Juventus", awayTeam: "Milan" }),
      leg({ eventId: "napoli-lazio", statFamily: "shots", ev: 0.087, homeTeam: "Napoli", awayTeam: "Lazio" }),
      leg({ eventId: "atalanta-fiore", statFamily: "goals", ev: 0.086, homeTeam: "Atalanta", awayTeam: "Fiorentina" }),
      leg({ eventId: "bologna-torino", statFamily: "corners", ev: 0.085, homeTeam: "Bologna", awayTeam: "Torino" }),
      leg({ eventId: "udinese-como", statFamily: "cards", ev: 0.084, homeTeam: "Udinese", awayTeam: "Como" }),
      leg({ eventId: "genoa-parma", statFamily: "shots", ev: 0.083, homeTeam: "Genoa", awayTeam: "Parma" }),
    ];

    const tickets = buildTickets(legs, "stack");

    expect(tickets.length).toBeGreaterThan(0);
    for (const ticket of tickets) {
      const ids = ticket.legs.map((l) => l.eventId);
      // One leg per match, full stop.
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((id) => id === "roma-inter")).toHaveLength(1);
    }
    // The rejected twin leg leaves the stack one leg short of the 8 it had before.
    expect(tickets[0].legs).toHaveLength(7);
  });

  it("3b. value mode: 2 legs from the same eventId → only 1 enters the ticket", () => {
    const legs: VaLeg[] = [
      leg({ eventId: "roma-inter", statFamily: "corners", ev: 0.30, bookmakerOdds: 1.5, homeTeam: "Roma", awayTeam: "Inter Milan" }),
      leg({ eventId: "roma-inter", statFamily: "goals",   ev: 0.29, bookmakerOdds: 1.5, homeTeam: "Roma", awayTeam: "Inter Milan" }),
      leg({ eventId: "juve-milan", statFamily: "cards",   ev: 0.28, bookmakerOdds: 1.5, homeTeam: "Juventus", awayTeam: "Milan" }),
      leg({ eventId: "napoli-lazio", statFamily: "shots", ev: 0.27, bookmakerOdds: 1.5, homeTeam: "Napoli", awayTeam: "Lazio" }),
    ];

    const tickets = buildTickets(legs, "value");

    expect(tickets.length).toBeGreaterThan(0);
    for (const ticket of tickets) {
      const ids = ticket.legs.map((l) => l.eventId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((id) => id === "roma-inter")).toHaveLength(1);
    }
  });

  it("3c. the family cap of 2 still applies across different matches", () => {
    const legs: VaLeg[] = [
      leg({ eventId: "m1", statFamily: "corners", ev: 0.095, homeTeam: "T1", awayTeam: "T2" }),
      leg({ eventId: "m2", statFamily: "corners", ev: 0.090, homeTeam: "T3", awayTeam: "T4" }),
      leg({ eventId: "m3", statFamily: "corners", ev: 0.088, homeTeam: "T5", awayTeam: "T6" }),
      leg({ eventId: "m4", statFamily: "goals",   ev: 0.087, homeTeam: "T7", awayTeam: "T8" }),
      leg({ eventId: "m5", statFamily: "cards",   ev: 0.086, homeTeam: "T9", awayTeam: "T10" }),
      leg({ eventId: "m6", statFamily: "shots",   ev: 0.085, homeTeam: "T11", awayTeam: "T12" }),
      leg({ eventId: "m7", statFamily: "goals",   ev: 0.084, homeTeam: "T13", awayTeam: "T14" }),
    ];

    const tickets = buildTickets(legs, "stack");

    expect(tickets.length).toBeGreaterThan(0);
    for (const ticket of tickets) {
      const ids = ticket.legs.map((l) => l.eventId);
      expect(new Set(ids).size).toBe(ids.length);
      const corners = ticket.legs.filter((l) => l.statFamily === "corners").length;
      expect(corners).toBeLessThanOrEqual(2);
    }
  });
});

describe("Value Accumulator — leg probability cap", () => {
  it("4. a leg with hitRate 0.95 is capped at 0.90 before the EV maths", () => {
    expect(MAX_LEG_MODEL_PROBABILITY).toBe(0.90);

    const hitRate = 0.95;
    const odds    = 1.10; // what a 95% corners leg is priced at

    const cappedProb = capModelProbability(hitRate);
    expect(cappedProb).toBe(0.90);

    // Uncapped, the leg looks like +4.5% EV and would clear the 0.03 value gate;
    // capped, the same leg is negative EV and is correctly rejected.
    expect(hitRate * odds - 1).toBeCloseTo(0.045, 3);
    expect(hitRate * odds - 1).toBeGreaterThan(0.03);
    expect(cappedProb * odds - 1).toBeCloseTo(-0.01, 3);
    expect(cappedProb * odds - 1).toBeLessThan(0);
  });

  it("4b. probabilities at or below 0.90 pass through untouched", () => {
    expect(capModelProbability(0.90)).toBe(0.90);
    expect(capModelProbability(0.85)).toBe(0.85);
    expect(capModelProbability(0.62)).toBe(0.62);
    expect(capModelProbability(0.98)).toBe(0.90);
  });
});

describe("Value Accumulator — shared performScan + runLiveScan server action", () => {
  beforeEach(() => {
    fetchScoreboard.mockResolvedValue([]);
    keepDbAlive.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("performScan('stack', false) returns the same shape the /api/va/scan route returns", async () => {
    const { performScan } = await import("./performScan");

    const result = await performScan("stack", false);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      ok: true,
      scanId: expect.stringMatching(/^va_\d+_[0-9a-f]{8}$/),
      matchesScanned: expect.any(Number),
      marketsEvaluated: expect.any(Number),
      legsQualified: expect.any(Number),
      ticketsBuilt: expect.any(Number),
      recommendedTicketId: null,
    });
    // Lock acquired and released.
    expect(dbInsertValues).toHaveBeenCalled();
    expect(dbDelete).toHaveBeenCalled();
  });

  it("runLiveScan() invokes the scan, pings the DB while it runs, and does not throw", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    fetchScoreboard.mockImplementationOnce(
      () => new Promise<FixtureLite[]>((resolve) => { release = () => resolve([]); }),
    );

    const { runLiveScan } = await import("../../app/value-accumulator/actions");
    const pending = runLiveScan();

    // Two keepalive ticks while the scan is "in flight".
    await vi.advanceTimersByTimeAsync(60_000 * 2 + 10);
    expect(keepDbAlive).toHaveBeenCalledTimes(2);

    release();
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.scanId).toMatch(/^va_/);
    expect(result).toEqual(
      expect.objectContaining({
        matchesScanned: expect.any(Number),
        marketsEvaluated: expect.any(Number),
        legsQualified: expect.any(Number),
        ticketsBuilt: expect.any(Number),
      }),
    );

    // Interval cleared: no more pings after completion.
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(keepDbAlive).toHaveBeenCalledTimes(2);
  });
});
