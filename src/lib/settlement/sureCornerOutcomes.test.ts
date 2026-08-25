// Unit tests for the Sure Bet Corners outcome resolvers (pure module).

import { describe, expect, it } from "vitest";

import {
  cornerActualFor,
  cornerHandicapOutcome,
  cornerLineFrom,
  cornerWinnerOutcome,
  resolveSureCornerOutcome,
} from "./sureCornerOutcomes";
import {
  emptyCanonicalMatchStats,
  type CanonicalMatchStats,
  type MatchStatsQuery,
} from "@/lib/data/types";
import type { MatchResult } from "@/lib/settlement/evaluate";

const QUERY: MatchStatsQuery = {
  leagueSlug: "eng.1",
  eventId: "401723456",
  homeTeam: "Arsenal",
  awayTeam: "Coventry City",
  date: "2026-08-22",
};

const RESULT: MatchResult = {
  eventId: "401723456",
  leagueSlug: "eng.1",
  date: "2026-08-22",
  homeName: "Arsenal",
  awayName: "Coventry City",
  homeScore: 2,
  awayScore: 1,
};

function statsWith(mutate: (s: CanonicalMatchStats) => void): CanonicalMatchStats {
  const s = emptyCanonicalMatchStats(QUERY);
  mutate(s);
  return s;
}

function corners(home: number | null, away: number | null): CanonicalMatchStats {
  return statsWith((s) => {
    s.home.corners = home;
    s.away.corners = away;
  });
}

describe("cornerLineFrom", () => {
  it("reads the line from the selection", () => {
    expect(cornerLineFrom("Total Corners O/U 9.5", "Over 9.5")).toBe(9.5);
    expect(cornerLineFrom("Arsenal Corners O/U 6.5", "Under 6.5")).toBe(6.5);
  });

  it("falls back to the market name", () => {
    expect(cornerLineFrom("Total Corners O/U 9.5", "Over")).toBe(9.5);
  });

  it("returns null for non O/U markets", () => {
    expect(cornerLineFrom("Corner Winner", "Arsenal")).toBeNull();
  });
});

describe("cornerActualFor", () => {
  it("sums home + away for Total markets", () => {
    expect(cornerActualFor("Total Corners O/U 9.5", RESULT, corners(6, 5))).toBe(11);
  });

  it("uses the home side for a market named after the home team", () => {
    expect(cornerActualFor("Arsenal Corners O/U 5.5", RESULT, corners(6, 5))).toBe(6);
  });

  it("uses the away side for a market named after the away team", () => {
    expect(cornerActualFor("Coventry City Corners O/U 4.5", RESULT, corners(6, 5))).toBe(5);
  });

  it("returns null without corner stats", () => {
    expect(cornerActualFor("Total Corners O/U 9.5", RESULT, null)).toBeNull();
    expect(cornerActualFor("Total Corners O/U 9.5", RESULT, corners(6, null))).toBeNull();
  });
});

describe("resolveSureCornerOutcome — O/U corner lines", () => {
  it("settles Total Corners over from real corner counts", () => {
    expect(resolveSureCornerOutcome("Total Corners O/U 9.5", "Over 9.5", RESULT, corners(6, 5))).toBe("WIN");
  });

  it("settles Total Corners under", () => {
    expect(resolveSureCornerOutcome("Total Corners O/U 11.5", "Under 11.5", RESULT, corners(6, 5))).toBe("WIN");
    expect(resolveSureCornerOutcome("Total Corners O/U 11.5", "Over 11.5", RESULT, corners(6, 5))).toBe("LOSS");
  });

  it("settles team corner lines", () => {
    expect(resolveSureCornerOutcome("Arsenal Corners O/U 5.5", "Over 5.5", RESULT, corners(6, 5))).toBe("WIN");
    expect(resolveSureCornerOutcome("Coventry City Corners O/U 4.5", "Under 4.5", RESULT, corners(6, 3))).toBe("WIN");
  });

  it("stays pending (null) while no stats object is available at all", () => {
    // A null stats object means "no source has published match stats yet" —
    // the pick is retried on the next verify run.
    expect(resolveSureCornerOutcome("Total Corners O/U 9.5", "Over 9.5", RESULT, null)).toBeNull();
  });

  it("voids a finished match whose corner stats never arrived", () => {
    const stats = statsWith(() => {}); // all corner stats null
    expect(resolveSureCornerOutcome("Total Corners O/U 9.5", "Over 9.5", RESULT, stats)).toBe("VOID");
  });

  it("pushes when the real total sits exactly on an integer line", () => {
    expect(resolveSureCornerOutcome("Total Corners O/U 11", "Over 11", RESULT, corners(6, 5))).toBe("PUSH");
    expect(resolveSureCornerOutcome("Total Corners O/U 11", "Under 11", RESULT, corners(6, 5))).toBe("PUSH");
  });
});

describe("cornerWinnerOutcome", () => {
  it("wins for the team with more real corners", () => {
    expect(cornerWinnerOutcome("Arsenal", RESULT, corners(7, 4))).toBe("WIN");
    expect(cornerWinnerOutcome("Coventry City", RESULT, corners(4, 7))).toBe("WIN");
    expect(cornerWinnerOutcome("Arsenal", RESULT, corners(4, 7))).toBe("LOSS");
  });

  it("voids a corner-count draw (no winner — stake returned)", () => {
    expect(cornerWinnerOutcome("Arsenal", RESULT, corners(5, 5))).toBe("VOID");
  });

  it("stays pending without stats or an unrecognised selection", () => {
    expect(cornerWinnerOutcome("Arsenal", RESULT, null)).toBeNull();
    expect(cornerWinnerOutcome("Somebody", RESULT, corners(7, 4))).toBeNull();
  });
});

describe("cornerHandicapOutcome", () => {
  it("wins when the favoured team covers the corner handicap", () => {
    expect(cornerHandicapOutcome("Arsenal -3.5 corners", RESULT, corners(7, 3))).toBe("WIN");
    expect(cornerHandicapOutcome("Coventry City -1.5 corners", RESULT, corners(3, 5))).toBe("WIN");
  });

  it("loses when the handicap is not covered", () => {
    expect(cornerHandicapOutcome("Arsenal -3.5 corners", RESULT, corners(6, 3))).toBe("LOSS");
  });

  it("pushes on an exact integer line", () => {
    expect(cornerHandicapOutcome("Arsenal -4 corners", RESULT, corners(7, 3))).toBe("PUSH");
  });

  it("stays pending without stats or a parseable line", () => {
    expect(cornerHandicapOutcome("Arsenal -3.5 corners", RESULT, null)).toBeNull();
    expect(cornerHandicapOutcome("Arsenal covers", RESULT, corners(7, 3))).toBeNull();
  });
});

describe("resolveSureCornerOutcome — corner-only families", () => {
  it("routes Corner Winner picks to the corner winner resolver", () => {
    expect(resolveSureCornerOutcome("Corner Winner", "Arsenal", RESULT, corners(7, 4))).toBe("WIN");
    expect(resolveSureCornerOutcome("Corner Winner", "Arsenal", RESULT, null)).toBeNull();
  });

  it("routes Corner Handicap picks to the corner handicap resolver", () => {
    expect(resolveSureCornerOutcome("Corner Handicap", "Arsenal -3.5 corners", RESULT, corners(7, 3))).toBe("WIN");
    expect(resolveSureCornerOutcome("Corner Handicap", "Arsenal -3.5 corners", RESULT, corners(6, 3))).toBe("LOSS");
  });
});
