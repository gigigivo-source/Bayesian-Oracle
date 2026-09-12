// Settlement tests for the 24-hour stats grace window (Part 2) and the
// PUSH vs VOID distinction (Part 3).
//
// Rules under test:
//   · A stat market on a match that finished LESS than 24h ago stays PENDING
//     — late-arriving boxscores may still resolve it.
//   · A stat market on a match that finished MORE than 24h ago, for which no
//     source has the data, resolves VOID (stake returned) — never pending
//     forever.
//   · A line hit exactly is a PUSH (reported separately from a data void even
//     though both return the stake).
//   · evaluateLeg keeps its legacy contract (no stats supplied → pending);
//     the settlement orchestrators apply finalizeSettlementEvaluation.

import { describe, expect, it } from "vitest";
import {
  evaluateLeg,
  evaluateLegDetailed,
  finalizeSettlementEvaluation,
  matchFinishedAtMs,
  statsGraceElapsed,
  type MatchResult,
} from "./evaluate";
import { emptyCanonicalMatchStats, type CanonicalMatchStats, type MatchStatsQuery } from "../data/types";

const HOUR = 3_600_000;

function resultAt(kickoffMs: number, overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    eventId: "espn:900",
    leagueSlug: "eng.1",
    date: new Date(kickoffMs).toISOString().slice(0, 10),
    kickoffAt: new Date(kickoffMs).toISOString(),
    homeName: "Arsenal",
    awayName: "Chelsea",
    homeScore: 2,
    awayScore: 1,
    ...overrides,
  };
}

const QUERY: MatchStatsQuery = {
  leagueSlug: "eng.1",
  eventId: "espn:900",
  homeTeam: "Arsenal",
  awayTeam: "Chelsea",
  date: "2026-08-21",
};

function statsWith(mutate: (s: CanonicalMatchStats) => void): CanonicalMatchStats {
  const s = emptyCanonicalMatchStats(QUERY);
  mutate(s);
  return s;
}

describe("statsGraceElapsed", () => {
  it("is false while the match is younger than the 24h grace window", () => {
    const now = Date.parse("2026-08-21T23:00:00Z");
    // Kickoff 4h before `now` → finished ≈2h before → well inside the grace.
    expect(statsGraceElapsed(resultAt(now - 4 * HOUR), now)).toBe(false);
  });

  it("is true once the match is older than kickoff + duration + 24h", () => {
    const now = Date.parse("2026-08-25T00:00:00Z");
    expect(statsGraceElapsed(resultAt(now - 26 * HOUR), now)).toBe(false); // not yet (kickoff+2h10m later)
    expect(statsGraceElapsed(resultAt(now - 30 * HOUR), now)).toBe(true);
  });

  it("falls back to the end of the UTC match day for date-only results", () => {
    const bare: Pick<MatchResult, "date"> = { date: "2026-08-21" };
    expect(matchFinishedAtMs(bare)).toBe(Date.parse("2026-08-21T23:59:59Z"));
    expect(statsGraceElapsed(bare, Date.parse("2026-08-22T20:00:00Z"))).toBe(false);
    expect(statsGraceElapsed(bare, Date.parse("2026-08-23T00:00:01Z"))).toBe(true);
  });

  it("never elapses for unknown matches (no result, unparseable date)", () => {
    expect(statsGraceElapsed(null)).toBe(false);
    expect(statsGraceElapsed(undefined)).toBe(false);
    expect(statsGraceElapsed({ date: "", kickoffAt: undefined })).toBe(false);
  });
});

describe("evaluateLegDetailed — grace-window voiding", () => {
  const now = Date.parse("2026-09-10T12:00:00Z");
  const stale = resultAt(now - 48 * HOUR); // finished ~2 days ago
  const fresh = resultAt(now - 3 * HOUR);  // finished ~1 hour ago

  const partialStats = statsWith((s) => {
    s.home.corners = 6;
    s.away.corners = 5;
    // throwIns deliberately left null — no source provided them.
  });

  it("keeps a stat-less market PENDING inside the grace window", () => {
    const ev = evaluateLegDetailed(
      { marketName: "Total Throw-ins O/U 30.5", selection: "Over 30.5" },
      fresh,
      partialStats,
      { nowMs: now },
    );
    expect(ev.outcome).toBe("pending");
    expect(ev.reason).toBeUndefined();
  });

  it("VOIDs a stat-less market past the grace window (stake returned, flagged no-data)", () => {
    const ev = evaluateLegDetailed(
      { marketName: "Total Throw-ins O/U 30.5", selection: "Over 30.5" },
      stale,
      partialStats,
      { nowMs: now },
    );
    expect(ev.outcome).toBe("void");
    expect(ev.push).toBe(false);
    expect(ev.reason).toBe("no-data");
  });

  it("still settles stat markets from real data immediately, grace or not", () => {
    const ev = evaluateLegDetailed(
      { marketName: "Total Corners O/U 9.5", selection: "Over 9.5" },
      fresh,
      partialStats,
      { nowMs: now },
    );
    expect(ev.outcome).toBe("won"); // 11 > 9.5
  });

  it("escalates a no-stats-at-all leg to VOID past the grace window", () => {
    // Legacy contract: evaluateLeg without a stats object stays pending…
    expect(evaluateLeg({ marketName: "Total Corners O/U 9.5", selection: "Over 9.5" }, stale, null)).toBe("pending");
    // …while the detailed (orchestrator) path voids it once data is final.
    const ev = evaluateLegDetailed(
      { marketName: "Total Corners O/U 9.5", selection: "Over 9.5" },
      stale,
      null,
      { nowMs: now },
    );
    expect(ev.outcome).toBe("void");
    expect(ev.reason).toBe("no-data");
  });

  it("voids unresolvable (non-stat) markets past the grace window too", () => {
    const unknown = { marketName: "Correct Score", selection: "Arsenal 3-1 Chelsea" };
    expect(evaluateLegDetailed(unknown, fresh, null, { nowMs: now }).outcome).toBe("pending");
    const ev = evaluateLegDetailed(unknown, stale, null, { nowMs: now });
    expect(ev.outcome).toBe("void");
    expect(ev.reason).toBe("no-data");
  });
});

describe("evaluateLegDetailed — PUSH vs VOID", () => {
  const now = Date.parse("2026-09-10T12:00:00Z");
  const stale = resultAt(now - 48 * HOUR);
  const stats = statsWith((s) => {
    s.home.corners = 6;
    s.away.corners = 4; // total 10 — sits exactly on a 10 line
  });

  it("reports a line hit exactly as a PUSH (void + push flag)", () => {
    const ev = evaluateLegDetailed(
      { marketName: "Total Corners O/U 10", selection: "Over 10" },
      stale,
      stats,
      { nowMs: now },
    );
    expect(ev.outcome).toBe("void");
    expect(ev.push).toBe(true);
    expect(ev.reason).toBeUndefined();
  });

  it("keeps score-based line pushes as PUSH (draw no bet on a draw)", () => {
    const draw = resultAt(now - 48 * HOUR, { homeScore: 1, awayScore: 1 });
    const ev = evaluateLegDetailed({ marketName: "Draw No Bet", selection: "Arsenal" }, draw, null, { nowMs: now });
    expect(ev.outcome).toBe("void");
    expect(ev.push).toBe(true);
  });

  it("distinguishes a no-data VOID from a PUSH", () => {
    const ev = evaluateLegDetailed(
      { marketName: "Total Shots O/U 24.5", selection: "Over 24.5" },
      stale,
      stats, // shots are null
      { nowMs: now },
    );
    expect(ev.outcome).toBe("void");
    expect(ev.push).toBe(false);
  });
});

describe("finalizeSettlementEvaluation", () => {
  const now = Date.parse("2026-09-10T12:00:00Z");

  it("voids a pending evaluation on a match past the grace window", () => {
    const finalized = finalizeSettlementEvaluation(
      { outcome: "pending", push: false },
      { date: "2026-09-01" },
      now,
    );
    expect(finalized).toEqual({ outcome: "void", push: false, reason: "no-data" });
  });

  it("leaves fresh matches and finished-but-not-resolved states alone", () => {
    expect(
      finalizeSettlementEvaluation({ outcome: "pending", push: false }, { date: "2026-09-10" }, now).outcome,
    ).toBe("pending");
    expect(
      finalizeSettlementEvaluation({ outcome: "won", push: false }, { date: "2026-09-01" }, now).outcome,
    ).toBe("won");
    expect(finalizeSettlementEvaluation({ outcome: "pending", push: false }, null, now).outcome).toBe("pending");
  });
});
