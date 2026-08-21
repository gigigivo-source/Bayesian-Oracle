// Unit tests for the source normalisers (Part 7.1).
//
// Each test feeds a known JSON/CSV fixture into a pure normaliser and asserts
// it maps to the canonical TeamStats correctly. No network access here.

import { describe, expect, it } from "vitest";
import { normaliseStatsBombEvents } from "./statsbomb";
import { normaliseFootballCsv } from "./githubDatasets";
import { normaliseDatafc } from "./datafc";

describe("StatsBomb normaliser", () => {
  const home = "Manchester United";
  const away = "Arsenal";

  const events = [
    // Home shot on target (saved)
    { type: { name: "Shot" }, team: { name: home }, shot: { statsbomb_xg: 0.25, outcome: { name: "Saved" }, type: { name: "Open Play" } } },
    // Home goal
    { type: { name: "Shot" }, team: { name: home }, shot: { statsbomb_xg: 0.9, outcome: { name: "Goal" }, type: { name: "Open Play" } } },
    // Away shot off target
    { type: { name: "Shot" }, team: { name: away }, shot: { statsbomb_xg: 0.1, outcome: { name: "Off T" }, type: { name: "Open Play" } } },
    // Home corner (completed pass)
    { type: { name: "Pass" }, team: { name: home }, pass: { type: { name: "Corner" }, outcome: null } },
    // Home pass flagged offside
    { type: { name: "Pass" }, team: { name: home }, pass: { type: { name: "Open Play" }, outcome: { name: "Offside" } } },
    // Away completed pass
    { type: { name: "Pass" }, team: { name: away }, pass: { type: { name: "Open Play" }, outcome: null } },
    // Home foul + yellow
    { type: { name: "Foul Committed" }, team: { name: home }, foul_committed: { card: { name: "Yellow Card" } } },
    // Away aerial duel won
    { type: { name: "Duel" }, team: { name: away }, duel: { type: { name: "Aerial Won" } } },
    // Home interception
    { type: { name: "Interception" }, team: { name: home } },
    // Away goalkeeper save
    { type: { name: "Goal Keeper" }, team: { name: away }, goalkeeper: { type: { name: "Shot Saved" } } },
    // Away successful dribble
    { type: { name: "Dribble" }, team: { name: away }, dribble: { outcome: { name: "Complete" } } },
  ];

  it("aggregates shots, goals, xG, corners, cards, fouls, offsides, duels and saves", () => {
    const { home: h, away: a } = normaliseStatsBombEvents(events, home, away);

    expect(h.goals).toBe(1);
    expect(h.xg).toBeCloseTo(1.15, 2);          // 0.25 + 0.90
    expect(h.shots).toBe(2);
    expect(h.shotsOnTarget).toBe(2);            // Saved + Goal
    expect(h.corners).toBe(1);
    expect(h.yellowCards).toBe(1);
    expect(h.fouls).toBe(1);
    expect(h.offsides).toBe(1);
    expect(h.interceptions).toBe(1);
    expect(h.goalsConceded).toBe(0);
    expect(h.cleanSheet).toBe(true);

    expect(a.shots).toBe(1);
    expect(a.shotsOffTarget).toBe(1);
    expect(a.saves).toBe(1);
    expect(a.aerialBattlesWon).toBe(1);
    expect(a.dribbling).toBe(1);
    expect(a.goalsConceded).toBe(1);
    expect(a.cleanSheet).toBe(false);
  });

  it("computes pass accuracy and possession from the pass counts", () => {
    const { home: h, away: a } = normaliseStatsBombEvents(events, home, away);
    // home: 2 passes, 1 completed → 50%; away: 1 pass completed → 100%.
    expect(h.passAccuracy).toBe(50);
    expect(a.passAccuracy).toBe(100);
    // possession ∝ passes: home 2/3, away 1/3.
    expect(h.possession).toBeCloseTo(66.67, 1);
    expect(a.possession).toBeCloseTo(33.33, 1);
  });

  it("returns empty partials when no events are recognised", () => {
    const result = normaliseStatsBombEvents([{ type: { name: "Starting XI" }, team: { name: home } }], home, away);
    expect(Object.values(result.home).every((v) => v === null)).toBe(true);
  });
});

describe("GitHubDatasets CSV normaliser", () => {
  const csv = [
    "league,season,date,home,away,HG,AG,HC,AC,HY,AY",
    "Premier League,2025/2026,2026-08-01,Manchester United,Liverpool,2,1,7,4,2,3",
    "Premier League,2025/2026,2026-08-08,Arsenal,Manchester United,1,1,5,6,1,2",
    "Premier League,2025/2026,2026-08-15,Manchester United,Arsenal,3,0,8,2,0,1",
  ].join("\n");

  it("finds the match by team + date and maps goals / corners / cards", () => {
    const { home, away } = normaliseFootballCsv(csv, {
      leagueSlug: "eng.1",
      eventId: "x",
      homeTeam: "Manchester United",
      awayTeam: "Arsenal",
      date: "2026-08-15",
    });

    expect(home.goals).toBe(3);
    expect(away.goals).toBe(0);
    expect(home.corners).toBe(8);
    expect(away.corners).toBe(2);
    expect(home.yellowCards).toBe(0);
    expect(away.yellowCards).toBe(1);
    expect(home.cleanSheet).toBe(true);
    expect(away.cleanSheet).toBe(false);
  });

  it("computes season averages for corners / cards per team", () => {
    const { home, away } = normaliseFootballCsv(csv, {
      leagueSlug: "eng.1",
      eventId: "x",
      homeTeam: "Manchester United",
      awayTeam: "Arsenal",
      date: "2026-08-15",
    });

    // Manchester United corners across its 3 matches: 7, 6, 8 → avg 7.
    expect(home.avgCornersPerGame).toBeCloseTo(7, 2);
    // Manchester United yellows: 2, 2, 0 → avg 1.33.
    expect(home.avgCardsPerGame).toBeCloseTo(1.33, 2);
    // Arsenal corners: 5, 2 → avg 3.5.
    expect(away.avgCornersPerGame).toBeCloseTo(3.5, 2);
  });
});

describe("datafc normaliser", () => {
  it("maps the documented home_xg / away_xg fields", () => {
    const { home, away } = normaliseDatafc(
      {
        home_name: "Manchester United",
        away_name: "Arsenal",
        home_xg: 1.85,
        away_xg: 0.72,
        home: { shots: 14, shots_on_target: 6, corners: 7 },
        away: { shots: 9, shots_on_target: 3, corners: 4 },
      },
      "Manchester United",
      "Arsenal",
    );
    expect(home.xg).toBe(1.85);
    expect(away.xg).toBe(0.72);
    expect(home.shots).toBe(14);
    expect(home.shotsOnTarget).toBe(6);
    expect(home.corners).toBe(7);
    expect(away.shotsOnTarget).toBe(3);
  });
});
