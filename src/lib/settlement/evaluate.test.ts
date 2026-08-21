// Settlement tests for stat-backed legs (Part 4).
//
// evaluateLeg now accepts the canonical stats object: stat markets are read
// from real stats (never guessed from the score), null stats on a finished
// match resolve to VOID, and a missing stats object keeps the leg pending.

import { describe, expect, it } from "vitest";
import { evaluateLeg, type MatchResult } from "./evaluate";
import { emptyCanonicalMatchStats, type CanonicalMatchStats, type MatchStatsQuery } from "../data/types";

const RESULT: MatchResult = {
  eventId: "espn:1",
  leagueSlug: "eng.1",
  date: "2026-08-21",
  homeName: "Manchester United",
  awayName: "Arsenal",
  homeScore: 2,
  awayScore: 1,
};

const QUERY: MatchStatsQuery = {
  leagueSlug: "eng.1",
  eventId: "espn:1",
  homeTeam: "Manchester United",
  awayTeam: "Arsenal",
  date: "2026-08-21",
};

function statsWith(mutate: (s: CanonicalMatchStats) => void): CanonicalMatchStats {
  const s = emptyCanonicalMatchStats(QUERY);
  mutate(s);
  return s;
}

describe("evaluateLeg with canonical stats", () => {
  it("settles Total Corners O/U from home.corners + away.corners", () => {
    const stats = statsWith((s) => {
      s.home.corners = 6;
      s.away.corners = 5;
    });
    const over = evaluateLeg({ marketName: "Total Corners O/U 10.5", selection: "Over 10.5" }, RESULT, stats);
    const under = evaluateLeg({ marketName: "Total Corners O/U 10.5", selection: "Under 10.5" }, RESULT, stats);
    expect(over).toBe("won");   // 11 > 10.5
    expect(under).toBe("lost"); // 11 < 10.5 is false
  });

  it("settles Total Cards O/U from yellow + red cards", () => {
    const stats = statsWith((s) => {
      s.home.yellowCards = 2; s.home.redCards = 1;
      s.away.yellowCards = 2; s.away.redCards = 0;
    });
    const outcome = evaluateLeg({ marketName: "Total Cards O/U 3.5", selection: "Over 3.5" }, RESULT, stats);
    expect(outcome).toBe("won"); // 2+1 + 2 = 5 > 3.5
  });

  it("settles Total SOT O/U from shotsOnTarget", () => {
    const stats = statsWith((s) => {
      s.home.shotsOnTarget = 6;
      s.away.shotsOnTarget = 3;
    });
    const outcome = evaluateLeg({ marketName: "Total SOT O/U 9.5", selection: "Under 9.5" }, RESULT, stats);
    expect(outcome).toBe("won"); // 9 < 9.5
  });

  it("settles a team-specific stat leg from the matching side", () => {
    const stats = statsWith((s) => {
      s.home.corners = 6;
      s.away.corners = 2;
    });
    const outcome = evaluateLeg(
      { marketName: "Manchester United Corners O/U 5.5", selection: "Over 5.5" },
      RESULT,
      stats,
    );
    expect(outcome).toBe("won"); // 6 > 5.5
  });

  it("settles GK Saves O/U from the saves stat (was previously guessed from goals)", () => {
    const stats = statsWith((s) => {
      s.home.saves = 4;
      s.away.saves = 3;
    });
    const outcome = evaluateLeg({ marketName: "Manchester United GK Saves O/U 3.5", selection: "Over 3.5" }, RESULT, stats);
    expect(outcome).toBe("won"); // 4 > 3.5
  });

  it("returns VOID when the stat is null but the match is finished", () => {
    const stats = statsWith(() => {
      // corners left null on purpose
    });
    const outcome = evaluateLeg({ marketName: "Total Corners O/U 10.5", selection: "Over 10.5" }, RESULT, stats);
    expect(outcome).toBe("void");
  });

  it("stays pending when no stats object is supplied (legacy behaviour)", () => {
    const outcome = evaluateLeg({ marketName: "Total Corners O/U 10.5", selection: "Over 10.5" }, RESULT);
    expect(outcome).toBe("pending");
  });

  it("still settles score-only markets without stats", () => {
    const outcome = evaluateLeg({ marketName: "Total Goals O/U 2.5", selection: "Over 2.5" }, RESULT);
    expect(outcome).toBe("won"); // 3 > 2.5
  });
});
