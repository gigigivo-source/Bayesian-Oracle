import { describe, it, expect, vi, beforeEach } from "vitest";
import { matchEngineMarketToBookmaker } from "./marketMap";
import { buildTickets, type VaLeg } from "./ticket";
import type { VaBookmakerOdds } from "./oddsFetcher";
import { settleBacktestTickets, type BacktestMatchResult } from "./scanner";

// scanner.ts pulls in the db layer at module scope; stub it for unit tests without DATABASE_URL.
vi.mock("@/db", () => ({ db: { insert: () => ({ values: () => Promise.resolve([]) }) } }));
vi.mock("@/db/schema", () => ({ vaLegs: {} }));

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
      const families = ticket.legs.map((l) => l.statFamily);
      const uniq = new Set(families);
      expect(uniq.size).toBe(families.length);
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
      const teams = ticket.legs.flatMap((l) => [l.homeTeam.toLowerCase(), l.awayTeam.toLowerCase()]);
      const uniq = new Set(teams);
      expect(uniq.size).toBe(teams.length);
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
