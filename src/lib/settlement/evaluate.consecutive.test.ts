// Settlement tests for the Consecutive Goals markets (Part 5): legs resolve
// from REAL goal timestamps (won/lost), finished matches without goal-event
// data resolve VOID (never guessed), and goalless matches settle "No" as won.

import { describe, expect, it } from "vitest";
import { evaluateLeg, type GoalEvent, type MatchResult } from "./evaluate";

const RESULT: MatchResult = {
  eventId: "espn:1",
  leagueSlug: "eng.1",
  date: "2026-08-21",
  homeName: "Manchester United",
  awayName: "Arsenal",
  homeScore: 2,
  awayScore: 1,
};

const HOME_GOAL: GoalEvent = { team: "home", minute: 10 };
const AWAY_GOAL: GoalEvent = { team: "away", minute: 20 };

describe("evaluateLeg — Consecutive Goals (goal timestamps)", () => {
  it("stays VOID when the match finished but no goal-event data was supplied", () => {
    expect(evaluateLeg(
      { marketName: "Manchester United Consecutive Goals (3 in a row)", selection: "No" },
      RESULT,
    )).toBe("void");
  });

  it("settles a goalless match: No wins, Yes loses", () => {
    const goalless = { ...RESULT, homeScore: 0, awayScore: 0, goals: [] };
    expect(evaluateLeg(
      { marketName: "Either Team Consecutive Goals (3 in a row)", selection: "No" },
      goalless,
    )).toBe("won");
    expect(evaluateLeg(
      { marketName: "Either Team Consecutive Goals (3 in a row)", selection: "Yes" },
      goalless,
    )).toBe("lost");
  });

  it("wins the home NO leg when an opponent goal breaks the run", () => {
    const result: MatchResult = {
      ...RESULT,
      homeScore: 3, awayScore: 1,
      goals: [
        HOME_GOAL,
        { team: "home", minute: 30 },
        { team: "away", minute: 40 },
        { team: "home", minute: 55 },
        { team: "home", minute: 80 },
      ],
    };
    // Sequence: H H A H H — the A at 40' breaks the home run, so no triple.
    expect(evaluateLeg(
      { marketName: "Manchester United Consecutive Goals (3 in a row)", selection: "No" },
      result,
    )).toBe("won");
  });

  it("settles a real triple: home NO loses, away NO wins, either NO loses", () => {
    const result: MatchResult = {
      ...RESULT,
      homeScore: 4, awayScore: 2,
      goals: [
        { team: "away", minute: 5 },
        { team: "home", minute: 12 },
        { team: "home", minute: 25 },
        { team: "home", minute: 40 },
        { team: "away", minute: 60 },
        { team: "home", minute: 85 },
      ],
    };
    // Sequence: A H H H A H → home triple at 12/25/40.
    expect(evaluateLeg(
      { marketName: "Manchester United Consecutive Goals (3 in a row)", selection: "No" },
      result,
    )).toBe("lost");
    expect(evaluateLeg(
      { marketName: "Arsenal Consecutive Goals (3 in a row)", selection: "No" },
      result,
    )).toBe("won");
    expect(evaluateLeg(
      { marketName: "Either Team Consecutive Goals (3 in a row)", selection: "No" },
      result,
    )).toBe("lost");
  });

  it("settles an away triple against the away NO leg", () => {
    const result: MatchResult = {
      ...RESULT,
      homeScore: 1, awayScore: 3,
      goals: [
        { team: "home", minute: 8 },
        { team: "away", minute: 22 },
        { team: "away", minute: 35 },
        { team: "away", minute: 50 },
      ],
    };
    expect(evaluateLeg(
      { marketName: "Arsenal Consecutive Goals (3 in a row)", selection: "No" },
      result,
    )).toBe("lost");
    expect(evaluateLeg(
      { marketName: "Manchester United Consecutive Goals (3 in a row)", selection: "No" },
      result,
    )).toBe("won");
  });

  it("wins every NO leg when goals strictly alternate", () => {
    const result: MatchResult = {
      ...RESULT,
      homeScore: 2, awayScore: 2,
      goals: [HOME_GOAL, AWAY_GOAL, { team: "home", minute: 50 }, { team: "away", minute: 70 }],
    };
    expect(evaluateLeg(
      { marketName: "Manchester United Consecutive Goals (3 in a row)", selection: "No" },
      result,
    )).toBe("won");
    expect(evaluateLeg(
      { marketName: "Arsenal Consecutive Goals (3 in a row)", selection: "No" },
      result,
    )).toBe("won");
    expect(evaluateLeg(
      { marketName: "Either Team Consecutive Goals (3 in a row)", selection: "No" },
      result,
    )).toBe("won");
  });

  it("supports the Yes side (flips the verdict)", () => {
    const result: MatchResult = {
      ...RESULT,
      homeScore: 3, awayScore: 0,
      goals: [HOME_GOAL, { team: "home", minute: 30 }, { team: "home", minute: 44 }],
    };
    expect(evaluateLeg(
      { marketName: "Manchester United Consecutive Goals (3 in a row)", selection: "Yes" },
      result,
    )).toBe("won");
    expect(evaluateLeg(
      { marketName: "Manchester United Consecutive Goals (3 in a row)", selection: "No" },
      result,
    )).toBe("lost");
  });

  it("also resolves the legacy Goal Sequence family (either-side semantics)", () => {
    const result: MatchResult = {
      ...RESULT,
      homeScore: 3, awayScore: 0,
      goals: [HOME_GOAL, { team: "home", minute: 30 }, { team: "home", minute: 44 }],
    };
    expect(evaluateLeg(
      { marketName: "3+ Consecutive Goals (Same Team)", selection: "No" },
      result,
    )).toBe("lost");
    expect(evaluateLeg(
      { marketName: "3+ Consecutive Goals (Same Team)", selection: "Yes" },
      result,
    )).toBe("won");
  });

  it("parses the run length of legacy lines (2+ vs 3+)", () => {
    const result: MatchResult = {
      ...RESULT,
      homeScore: 3, awayScore: 1,
      goals: [HOME_GOAL, { team: "home", minute: 30 }, { team: "away", minute: 40 }, { team: "home", minute: 55 }],
    };
    // Sequence H H A H — a 2-in-a-row exists, a 3-in-a-row does not.
    expect(evaluateLeg(
      { marketName: "2+ Consecutive Goals (Same Team)", selection: "No" },
      result,
    )).toBe("lost");
    expect(evaluateLeg(
      { marketName: "3+ Consecutive Goals (Same Team)", selection: "No" },
      result,
    )).toBe("won");
  });

  it("sorts goals by minute (out-of-order events still settle correctly)", () => {
    const result: MatchResult = {
      ...RESULT,
      homeScore: 3, awayScore: 0,
      goals: [
        { team: "home", minute: 44 },
        { team: "home", minute: 10 },
        { team: "home", minute: 30 },
      ],
    };
    expect(evaluateLeg(
      { marketName: "Manchester United Consecutive Goals (3 in a row)", selection: "No" },
      result,
    )).toBe("lost");
  });
});
