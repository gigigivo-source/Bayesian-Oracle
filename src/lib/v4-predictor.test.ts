import { describe, expect, it, vi } from "vitest";
import { BOTTOM_5, CHAOS_DRAW_MAX_XG_GAP, CHAOS_TEAMS, CHAOS_VISITOR_XG_EDGE, MID_DEADLOCK_MAX_XG_GAP, MID_FAVOURITE_BIG_WIN_XG, MID_TABLE, STANDARD_AWAY_DRAW_MAX_XG_GAP, STANDARD_BLOWOUT_GAP, STANDARD_DRAW_XG, TOP4_DERBY_AWAY_TOLERANCE, TOP4_DERBY_MAX_AWAY_EDGE, TOP4_DERBY_MIN_XG_EDGE, TOP_4, blowoutGoals, buildPredictions, calculateScore, generateV2Predictions, getScorelineOutcome, isScoreline, translateTeamName, type XgPair } from "@/lib/v4-predictor";
import { createMatchXgResolver } from "@/lib/v4-predictor-server";;

describe("V2 team classifications", () => {
  it("exports the exact hardcoded V2 team arrays", () => {
    expect(TOP_4).toEqual(["Arsenal", "Liverpool", "Man City", "Brighton"]);
    expect(MID_TABLE).toEqual([
      "Fulham",
      "Brentford",
      "Everton",
      "Leeds",
      "Crystal Palace",
      "Newcastle",
      "Aston Villa",
    ]);
    expect(BOTTOM_5).toEqual(["Coventry", "Ipswich", "Hull", "Sunderland", "Burnley"]);
    expect(CHAOS_TEAMS).toEqual(["Chelsea", "Man Utd", "Spurs"]);
  });

  it("normalizes ESPN, OpenFootball, and short club names", () => {
    expect(translateTeamName("Manchester City FC")).toBe("Man City");
    expect(translateTeamName("Manchester United FC")).toBe("Man Utd");
    expect(translateTeamName("Man United")).toBe("Man Utd");
    expect(translateTeamName("Tottenham Hotspur FC")).toBe("Spurs");
    expect(translateTeamName("Tottenham")).toBe("Spurs");
    expect(translateTeamName("Brighton & Hove Albion FC")).toBe("Brighton");
    expect(translateTeamName("Hull City AFC")).toBe("Hull");
    expect(translateTeamName("Sunderland AFC")).toBe("Sunderland");
    expect(translateTeamName("AFC Bournemouth")).toBe("Bournemouth");
    expect(translateTeamName("Nottingham Forest FC")).toBe("Nott'm Forest");
  });
});

describe("generateV2Predictions — V2 Strict 3-Snipe System", () => {
  it("enforces max 1 Fortress, max 2 Deadlocks, max 3 Snipes total, and skips Elite Away when 2 Deadlocks exist", () => {
    const predictions = generateV2Predictions([
      { home: "Crystal Palace", away: "Liverpool" }, // Elite Away candidate (blocked by 2 Deadlocks)
      { home: "Arsenal", away: "Coventry" },         // Fortress #1 -> SNIPE: Home Fortress (2-0)
      { home: "Man City", away: "Ipswich" },         // Fortress #2 -> LOCK: Smart Top 4 Home (2-0)
      { home: "Fulham", away: "Brentford" },         // Deadlock #1 -> SNIPE: Mid-Table Deadlock (1-1)
      { home: "Everton", away: "Leeds" },            // Deadlock #2 -> SNIPE: Mid-Table Deadlock (1-1)
      { home: "Newcastle", away: "Aston Villa" },    // Deadlock #3 -> LOCK: Standard Home (1-0)
    ]);

    expect(predictions).toEqual([
      { Match: "Crystal Palace vs Liverpool", Category: "LOCK: Standard Away", Prediction: "0-1", Target_Pts: 10 },
      { Match: "Arsenal vs Coventry", Category: "SNIPE: Home Fortress", Prediction: "2-0", Target_Pts: 20 },
      { Match: "Man City vs Ipswich", Category: "LOCK: Smart Top 4 Home", Prediction: "2-0", Target_Pts: 10 },
      { Match: "Fulham vs Brentford", Category: "SNIPE: Mid-Table Deadlock", Prediction: "1-1", Target_Pts: 20 },
      { Match: "Everton vs Leeds", Category: "SNIPE: Mid-Table Deadlock", Prediction: "1-1", Target_Pts: 20 },
      { Match: "Newcastle vs Aston Villa", Category: "LOCK: Standard Home", Prediction: "1-0", Target_Pts: 10 },
    ]);
    expect(predictions.filter((p) => p.Category.startsWith("SNIPE:"))).toHaveLength(3);
  });

  it("uses Snipe 3 Alternative (Elite Away 0-1) when fewer than 2 Mid-Table Deadlocks exist", () => {
    const predictions = generateV2Predictions([
      ["Arsenal", "Coventry"],       // Snipe 1: Home Fortress -> 2-0
      ["Fulham", "Brentford"],       // Snipe 2: Mid-Table Deadlock -> 1-1
      ["Nott'm Forest", "Man City"], // Snipe 3 Alternative: Elite Away -> 0-1
      ["Crystal Palace", "Brighton"],// 4th snipe candidate -> LOCK: Standard Away -> 0-1
    ]);

    expect(predictions).toEqual([
      { Match: "Arsenal vs Coventry", Category: "SNIPE: Home Fortress", Prediction: "2-0", Target_Pts: 20 },
      { Match: "Fulham vs Brentford", Category: "SNIPE: Mid-Table Deadlock", Prediction: "1-1", Target_Pts: 20 },
      { Match: "Nott'm Forest vs Man City", Category: "SNIPE: Elite Away", Prediction: "0-1", Target_Pts: 20 },
      { Match: "Crystal Palace vs Brighton", Category: "LOCK: Standard Away", Prediction: "0-1", Target_Pts: 10 },
    ]);
  });

  it("permanently bans Chaos teams from Snipes and never predicts 2-2", () => {
    const predictions = generateV2Predictions([
      { home: "Arsenal", away: "Chelsea" }, // Top 4 Home vs Chaos -> 2-1
      { home: "Man Utd", away: "Man City" },// Chaos Home vs Top 4 Away -> 1-2
      { home: "Chelsea", away: "Spurs" },   // Chaos vs Chaos, no xG -> 1-1 (NEVER 2-2)
      { home: "Spurs", away: "Coventry" },  // Chaos at Home -> 2-1 (banned from Snipe)
      { home: "Everton", away: "Man Utd" }, // Chaos Away, no xG edge -> 1-1
    ]);

    for (const p of predictions) {
      expect(p.Category).toBe("LOCK: Chaos Rule");
      expect(p.Prediction).not.toBe("2-2");
      expect(p.Target_Pts).toBe(10);
    }
    expect(predictions.map((p) => p.Prediction)).toEqual(["2-1", "1-2", "1-1", "2-1", "1-1"]);
  });

  it("applies Smart Top 4 Home, Mid vs Bottom, and Standard Default Lock rules", () => {
    const predictions = generateV2Predictions([
      { home: "Liverpool", away: "Everton" },       // Smart Top 4 Home -> 2-0
      { home: "Liverpool", away: "Brighton" },      // Top 4 Home vs Top 4 -> 2-0
      { home: "Aston Villa", away: "Sunderland" },  // Mid Home vs Bottom 5 -> 2-1
      { home: "Coventry", away: "Fulham" },         // Bottom 5 vs Mid -> 0-1
      { home: "Bournemouth", away: "Sunderland" },  // Standard vs Bottom 5 -> 1-0
      { home: "Bournemouth", away: "Nott'm Forest" }, // Standard vs Standard -> 1-0
    ]);

    expect(predictions).toEqual([
      { Match: "Liverpool vs Everton", Category: "LOCK: Smart Top 4 Home", Prediction: "2-0", Target_Pts: 10 },
      { Match: "Liverpool vs Brighton", Category: "LOCK: Smart Top 4 Home", Prediction: "2-0", Target_Pts: 10 },
      { Match: "Aston Villa vs Sunderland", Category: "LOCK: Mid vs Bottom", Prediction: "2-1", Target_Pts: 10 },
      { Match: "Coventry vs Fulham", Category: "LOCK: Standard Away", Prediction: "0-1", Target_Pts: 10 },
      { Match: "Bournemouth vs Sunderland", Category: "LOCK: Standard Home", Prediction: "1-0", Target_Pts: 10 },
      { Match: "Bournemouth vs Nott'm Forest", Category: "LOCK: Standard Home", Prediction: "1-0", Target_Pts: 10 },
    ]);
  });

  it("Chaos Rule — the higher-xG side wins past the draw band, at home or away", () => {
    const slate: Array<[string, string]> = [
      ["Man Utd", "Ipswich"],      // Chaos home, clearly better -> 2-1
      ["Chelsea", "Hull"],         // Chaos home the Engine rates worse -> 1-1 (MW4 guard)
      ["Spurs", "Crystal Palace"], // Chaos home, small edge -> 2-1 (MW9 fix)
      ["Fulham", "Man Utd"],       // Chaos away, 0.10 gap -> 1-1 (MW5 exact)
      ["Coventry", "Chelsea"],     // Chaos away, big edge -> 1-2
      ["Hull", "Man Utd"],         // Chaos away, home side 0.20 better -> 2-1 (MW1 fix)
      ["Everton", "Chelsea"],      // Chaos away, 0.21 better -> 1-2 (MW7 fix)
      ["Chelsea", "Man Utd"],      // both Chaos, 0.40 gap -> 2-1 (MW9 fix)
      ["Man Utd", "Spurs"],        // both Chaos, dead heat -> 1-1
      ["Chelsea", "Brighton"],     // Chaos home vs Top 4 away -> 1-2 (Top 4 precedence)
    ];
    const xg: Record<string, XgPair> = {
      "Man Utd|Ipswich": [2.09, 1.02],
      "Chelsea|Hull": [0.81, 1.12],
      "Spurs|Crystal Palace": [1.59, 1.33],
      "Fulham|Man Utd": [1.47, 1.37],
      "Coventry|Chelsea": [0.9, 1.9],
      "Hull|Man Utd": [1.51, 1.31],
      "Everton|Chelsea": [1.15, 1.36],
      "Chelsea|Man Utd": [1.58, 1.18],
      "Man Utd|Spurs": [1.5, 1.45],
      "Chelsea|Brighton": [1.67, 1.36],
    };

    const predictions = generateV2Predictions(slate, (_i, home, away) => xg[`${home}|${away}`] ?? null);

    expect(predictions.map((p) => p.Category)).toEqual(Array(10).fill("LOCK: Chaos Rule"));
    expect(predictions.map((p) => p.Prediction)).toEqual([
      "2-1", "1-1", "2-1", "1-1", "1-2", "2-1", "1-2", "2-1", "1-1", "1-2",
    ]);
    // Every pick keeps the outcome the rule locked, and 2-2 stays banned.
    expect(predictions.map((p) => getScorelineOutcome(p.Prediction))).toEqual([
      "H", "D", "H", "D", "A", "H", "A", "H", "D", "A",
    ]);
    expect(predictions.some((p) => p.Prediction === "2-2")).toBe(false);
  });

  it("Chaos Rule — flat defaults when no xG model is supplied: 2-1 at home, 1-1 away or both Chaos", () => {
    const predictions = generateV2Predictions([
      ["Man Utd", "Ipswich"],     // Chaos home -> 2-1
      ["Sheffield Utd", "Spurs"], // Chaos away, no edge available -> 1-1
      ["Chelsea", "Man Utd"],     // both Chaos, no gap to test -> 1-1
    ]);
    expect(predictions.map((p) => p.Prediction)).toEqual(["2-1", "1-1", "1-1"]);
  });

  it("Chaos Rule — the draw band is exactly CHAOS_DRAW_MAX_XG_GAP for a Chaos side away and for two Chaos sides", () => {
    // 1.5 +/- gap/2 keeps both sides near the middle of the grid where the
    // attack/defence rounding cannot drift a fixture across a threshold.
    // Positive gap = the home side is rated better.
    const at = (home: string, away: string) => (gap: number) =>
      generateV2Predictions([[home, away]], () => [1.5 + gap / 2, 1.5 - gap / 2])[0].Prediction;

    for (const fixture of [at("Coventry", "Chelsea"), at("Chelsea", "Man Utd")]) {
      expect(fixture(0)).toBe("1-1");
      expect(fixture(CHAOS_DRAW_MAX_XG_GAP - 0.02)).toBe("1-1");
      expect(fixture(-(CHAOS_DRAW_MAX_XG_GAP - 0.02))).toBe("1-1");
      expect(fixture(CHAOS_DRAW_MAX_XG_GAP + 0.02)).toBe("2-1");
      expect(fixture(-(CHAOS_DRAW_MAX_XG_GAP + 0.02))).toBe("1-2");
    }

    // The window the band is fitted to: MW5 Brentford 3-0 Chelsea must leave the
    // draw, MW3 Nott'm Forest 0-0 Spurs and MW5 Fulham 1-1 Man Utd must stay.
    expect(generateV2Predictions([["Brentford", "Chelsea"]], () => [1.715, 1.562])[0].Prediction).toBe("2-1");
    expect(generateV2Predictions([["Nott'm Forest", "Spurs"]], () => [1.358, 1.493])[0].Prediction).toBe("1-1");
    expect(generateV2Predictions([["Fulham", "Man Utd"]], () => [1.473, 1.367])[0].Prediction).toBe("1-1");
  });

  it("Chaos Rule — a Chaos host wins past the draw band, but its visitor needs CHAOS_VISITOR_XG_EDGE for 1-2", () => {
    // Positive gap = the Chaos host is rated better.
    const homeAt = (gap: number) =>
      generateV2Predictions([["Spurs", "Everton"]], () => [1.5 + gap / 2, 1.5 - gap / 2])[0];

    // The host is past the band: the 2-1 win line.
    expect(homeAt(CHAOS_DRAW_MAX_XG_GAP + 0.02).Prediction).toBe("2-1");
    expect(homeAt(1.0).Prediction).toBe("2-1");
    // The visitor is inside the band, level, or ahead by less than its own gate: a 1-1.
    expect(homeAt(CHAOS_DRAW_MAX_XG_GAP - 0.02).Prediction).toBe("1-1");
    expect(homeAt(0).Prediction).toBe("1-1");
    expect(homeAt(-(CHAOS_DRAW_MAX_XG_GAP + 0.02)).Prediction).toBe("1-1");
    expect(homeAt(-0.31).Prediction).toBe("1-1"); // MW4 Chelsea 2-2 Hull stays a draw
    expect(homeAt(-(CHAOS_VISITOR_XG_EDGE - 0.02)).Prediction).toBe("1-1");
    // The visitor is far better: the away win.
    expect(homeAt(-(CHAOS_VISITOR_XG_EDGE + 0.02)).Prediction).toBe("1-2");
    expect(homeAt(-(CHAOS_VISITOR_XG_EDGE + 0.02)).Category).toBe("LOCK: Chaos Rule");

    // The floor guard: the visitor's gate must stay above Hull's 0.31 edge at Chelsea.
    expect(CHAOS_VISITOR_XG_EDGE).toBeGreaterThan(0.31);
    // The MW9 guardrail: Spurs 2-0 Crystal Palace is a 0.25 edge and must stay 2-1.
    expect(CHAOS_DRAW_MAX_XG_GAP).toBeLessThan(0.25);
    expect(
      generateV2Predictions([["Spurs", "Crystal Palace"]], () => [1.59, 1.33])[0].Prediction,
    ).toBe("2-1");
    // MW4 Spurs 0-0 Everton is a 0.35 Spurs edge: still a 2-1.
    expect(generateV2Predictions([["Spurs", "Everton"]], () => [1.48, 1.13])[0].Prediction).toBe("2-1");
  });

  it("Mid-Table Deadlock — the 1-1 Snipe is dropped for the favourite when xG separates the sides", () => {
    const deadlock = (homeXg: number, awayXg: number) =>
      generateV2Predictions([["Leeds", "Newcastle"]], () => [homeXg, awayXg] as XgPair)[0];

    // Tight game: the Snipe stands, at the threshold too.
    const tight = { Match: "Leeds vs Newcastle", Category: "SNIPE: Mid-Table Deadlock", Prediction: "1-1", Target_Pts: 20 };
    expect(deadlock(1.26, 1.73)).toEqual(tight); // MW4: a 0.47 away edge, actual 4-1 Leeds
    expect(deadlock(1.0 + MID_DEADLOCK_MAX_XG_GAP - 0.02, 1.0)).toEqual(tight);
    expect(generateV2Predictions([["Leeds", "Newcastle"]])[0]).toEqual(tight);

    // Clear favourite: a 10-point Lock on the favourite, home or away.
    expect(deadlock(1.2 + MID_DEADLOCK_MAX_XG_GAP + 0.02, 1.2)).toEqual({
      Match: "Leeds vs Newcastle",
      Category: "LOCK: Mid-Table Favourite",
      Prediction: "2-1",
      Target_Pts: 10,
    });
    expect(deadlock(1.2, 1.2 + MID_DEADLOCK_MAX_XG_GAP + 0.02).Prediction).toBe("1-2");
    // A heavy favourite takes the bigger win.
    expect(deadlock(MID_FAVOURITE_BIG_WIN_XG + 0.2, 1.2).Prediction).toBe("3-1");
    expect(deadlock(1.2, MID_FAVOURITE_BIG_WIN_XG + 0.2).Prediction).toBe("1-3");
  });

  it("Mid-Table Deadlock — a dropped deadlock uses no Snipe, so the slot passes down the slate", () => {
    const slate: Array<[string, string]> = [
      ["Leeds", "Newcastle"],      // 1.3 gap -> Mid-Table Favourite Lock, no Snipe used
      ["Fulham", "Brentford"],     // Deadlock 1
      ["Everton", "Aston Villa"],  // Deadlock 2
      ["Crystal Palace", "Leeds"], // third tight Mid vs Mid -> Standard Home, as before
    ];
    const xg: Record<string, XgPair> = {
      "Leeds|Newcastle": [2.4, 1.1],
      "Fulham|Brentford": [1.3, 1.2],
      "Everton|Aston Villa": [1.2, 1.3],
      "Crystal Palace|Leeds": [1.3, 1.2],
    };
    const predictions = generateV2Predictions(slate, (_i, home, away) => xg[`${home}|${away}`] ?? null);
    expect(predictions.map((p) => [p.Category, p.Prediction, p.Target_Pts])).toEqual([
      ["LOCK: Mid-Table Favourite", "2-1", 10],
      ["SNIPE: Mid-Table Deadlock", "1-1", 20],
      ["SNIPE: Mid-Table Deadlock", "1-1", 20],
      ["LOCK: Standard Home", "1-0", 10],
    ]);
  });

  it("Standard Away — a draw when the Engine cannot separate the sides, the away win otherwise", () => {
    const at = (homeXg: number, awayXg: number) =>
      generateV2Predictions([["Bournemouth", "Brentford"]], () => [homeXg, awayXg] as XgPair)[0];

    // Tight game: 1-1 (MW4 Bournemouth 2-2 Brentford, MW2 Bournemouth 1-1 Everton).
    expect(at(1.18, 1.19)).toEqual({
      Match: "Bournemouth vs Brentford",
      Category: "LOCK: Standard Away",
      Prediction: "1-1",
      Target_Pts: 10,
    });
    expect(at(1.13, 0.89).Prediction).toBe("1-1");
    expect(at(1.5 + (STANDARD_AWAY_DRAW_MAX_XG_GAP - 0.02) / 2, 1.5 - (STANDARD_AWAY_DRAW_MAX_XG_GAP - 0.02) / 2).Prediction).toBe("1-1");
    expect(at(1.5 - (STANDARD_AWAY_DRAW_MAX_XG_GAP - 0.02) / 2, 1.5 + (STANDARD_AWAY_DRAW_MAX_XG_GAP - 0.02) / 2).Prediction).toBe("1-1");
    // Tight and high-scoring on both sides: 2-2.
    expect(at(STANDARD_DRAW_XG, STANDARD_DRAW_XG + 0.1).Prediction).toBe("2-2");
    expect(at(STANDARD_DRAW_XG - 0.05, STANDARD_DRAW_XG + 0.1).Prediction).toBe("1-1");

    // Clear away edge: the away win, scored by the Correct Score hybrid.
    expect(at(1.5 - (STANDARD_AWAY_DRAW_MAX_XG_GAP + 0.02) / 2, 1.5 + (STANDARD_AWAY_DRAW_MAX_XG_GAP + 0.02) / 2).Prediction).toBe("0-1");
    expect(at(0.67, 1.68).Prediction).toBe("0-1"); // MW7 Nott'm Forest 0-1 Arsenal
    expect(at(1.03, 2.29).Prediction).toBe("1-2"); // MW10 Ipswich 1-2 Bournemouth
    // Clear home edge: the tier's away win is kept (MW1 Nott'm Forest 0-1 Leeds).
    expect(at(1.6, 1.04).Prediction).toBe("0-1");
    expect(at(1.5 + (STANDARD_AWAY_DRAW_MAX_XG_GAP + 0.02) / 2, 1.5 - (STANDARD_AWAY_DRAW_MAX_XG_GAP + 0.02) / 2).Prediction).toBe("0-1");

    // No model: the flat 0-1.
    expect(generateV2Predictions([["Bournemouth", "Brentford"]])[0].Prediction).toBe("0-1");
    // Standard Home is untouched by the draw band.
    expect(
      generateV2Predictions([["Bournemouth", "Nott'm Forest"]], () => [1.18, 1.19] as XgPair)[0],
    ).toMatchObject({ Category: "LOCK: Standard Home", Prediction: "1-0" });
  });

  it("Top 4 Derby — the flat 2-0 is dropped only when the Engine cannot separate the sides", () => {
    const slate: Array<[string, string]> = [
      ["Brighton", "Arsenal"],   // MW5: 0.86 away edge — too big to flip, actual 3-0 Brighton
      ["Liverpool", "Arsenal"],  // MW9: 0.18 away edge — coin flip, actual 0-1
      ["Man City", "Brighton"],  // MW9: home rated far better, actual 0-1
      ["Liverpool", "Man City"], // MW6: dead heat, actual 0-3
      ["Liverpool", "Brighton"], // MW8: home rated far better, actual 2-0
      ["Arsenal", "Coventry"],   // not a derby
    ];
    // The Engine's real xG for these fixtures, as the local backtest resolves it.
    const xg: Record<string, XgPair> = {
      "Brighton|Arsenal": [0.86, 1.72],
      "Liverpool|Arsenal": [1.13, 1.31],
      "Man City|Brighton": [2.65, 1.15],
      "Liverpool|Man City": [1.35, 1.32],
      "Liverpool|Brighton": [2.2, 1.17],
      "Arsenal|Coventry": [2.3, 0.9],
    };

    const predictions = generateV2Predictions(slate, (_i, home, away) => xg[`${home}|${away}`] ?? null);

    expect(predictions.map((p) => p.Category)).toEqual([
      "LOCK: Smart Top 4 Home",
      "LOCK: Smart Top 4 Home",
      "LOCK: Smart Top 4 Home",
      "LOCK: Smart Top 4 Home",
      "LOCK: Smart Top 4 Home",
      "SNIPE: Home Fortress",
    ]);
    expect(predictions.map((p) => p.Prediction)).toEqual([
      "2-0", "0-1", "2-0", "0-1", "2-0", "2-0",
    ]);
    expect(predictions.slice(0, 5).every((p) => p.Target_Pts === 10)).toBe(true);
    expect(predictions[5].Target_Pts).toBe(20);
    // The superseded unconditional-flip threshold stays documented, not applied.
    expect(TOP4_DERBY_MIN_XG_EDGE).toBeGreaterThan(TOP4_DERBY_MAX_AWAY_EDGE);
  });

  it("Top 4 Derby — the flip band is bounded by TOP4_DERBY_AWAY_TOLERANCE and TOP4_DERBY_MAX_AWAY_EDGE", () => {
    const at = (gap: number) =>
      generateV2Predictions([["Liverpool", "Arsenal"]], () => [1.5 + gap / 2, 1.5 - gap / 2])[0]
        .Prediction;

    // Home side better: the lock survives past the tolerance.
    expect(at(TOP4_DERBY_AWAY_TOLERANCE + 0.02)).toBe("2-0");
    expect(at(TOP4_DERBY_AWAY_TOLERANCE - 0.02)).toBe("0-1");
    // Away side better: the flip stops once the Engine is decisive.
    expect(at(-(TOP4_DERBY_MAX_AWAY_EDGE - 0.02))).toBe("0-1");
    expect(at(-(TOP4_DERBY_MAX_AWAY_EDGE + 0.02))).toBe("2-0");
  });

  it("Standard Lock — blowouts and the 2-2 draw only fire when xG clears the thresholds", () => {
    const slate: Array<[string, string]> = [
      ["Bournemouth", "Nott'm Forest"], // big home gap -> grid #1 3-0 (flat 1-0 not top-3)
      ["Coventry", "Bournemouth"],      // away win -> flat 0-1 kept (top-3 grid cell)
      ["Bournemouth", "Nott'm Forest"], // tight home xG -> flat 1-0 kept (top-3 grid cell)
      ["Bournemouth", "Nott'm Forest"], // moderate gap -> flat 2-1 kept (top-3 grid cell)
      ["Bournemouth", "Nott'm Forest"], // very tight -> flat 1-0 kept (top-3 grid cell)
    ];
    const pairs: XgPair[] = [
      [3.6, 1.0],
      [0.4, 2.4],
      [0.6, 2.2],
      [2.0, 1.9],
      [1.1, 1.0],
    ];

    const predictions = generateV2Predictions(slate, (i) => pairs[i]);

    expect(predictions.map((p) => p.Category)).toEqual([
      "LOCK: Standard Home",
      "LOCK: Standard Away",
      "LOCK: Standard Home",
      "LOCK: Standard Home",
      "LOCK: Standard Home",
    ]);
    expect(predictions.map((p) => p.Prediction)).toEqual(["3-0", "0-1", "1-0", "2-1", "1-0"]);
  });

  it("Standard Lock — thresholds are exclusive, and no xG restores the flat 1-0 / 0-1", () => {
    const standard = (homeXg: number, awayXg: number) =>
      generateV2Predictions([["Bournemouth", "Nott'm Forest"]], () => [homeXg, awayXg] as XgPair)[0];
    expect(standard(1.2 + STANDARD_BLOWOUT_GAP, 1.2).Prediction).toBe("2-1");
    expect(standard(1.1 + STANDARD_BLOWOUT_GAP, 1.1).Prediction).toBe("2-1");
    expect(standard(STANDARD_DRAW_XG, STANDARD_DRAW_XG).Prediction).toBe("2-1");
    expect(standard(STANDARD_DRAW_XG - 0.01, 2.0).Prediction).toBe("2-1");
    expect(generateV2Predictions([["Bournemouth", "Nott'm Forest"]])[0].Prediction).toBe("1-0");
    expect([2.9, 3.5, 4.9, 9].map(blowoutGoals)).toEqual([3, 4, 4, 4]);
  });

  it("treats a throwing or non-finite xG resolver as unavailable", () => {
    const slate: Array<[string, string]> = [["Liverpool", "Arsenal"], ["Chelsea", "Bournemouth"]];
    const throwing = generateV2Predictions(slate, () => {
      throw new Error("model down");
    });
    expect(throwing.map((p) => p.Prediction)).toEqual(["2-0", "2-1"]);

    const broken = generateV2Predictions(slate, () => [Number.NaN, 1] as XgPair);
    expect(broken.map((p) => p.Prediction)).toEqual(["2-0", "2-1"]);
  });

  it("builds an Engine attack/defence resolver that scores stronger sides higher", () => {
    const resolver = createMatchXgResolver({
      history: [
        // Arsenal batter everyone at home; Coventry lose everything.
        ...Array.from({ length: 6 }, (_, i) => ({
          homeTeam: "Arsenal FC",
          awayTeam: `Filler ${i} FC`,
          matchDate: `2026-08-${String(i + 1).padStart(2, "0")}T15:00:00Z`,
          homeGoals: 4,
          awayGoals: 0,
        })),
        ...Array.from({ length: 6 }, (_, i) => ({
          homeTeam: "Coventry City FC",
          awayTeam: `Filler ${i} FC`,
          matchDate: `2026-08-${String(i + 1).padStart(2, "0")}T15:00:00Z`,
          homeGoals: 0,
          awayGoals: 3,
        })),
      ],
      leagueSlug: "eng.1",
      onlyRelevant: false,
    });
    expect(resolver).not.toBeNull();
    const pair = resolver!(0, "Arsenal", "Coventry");
    expect(pair).not.toBeNull();
    expect(pair![0]).toBeGreaterThan(pair![1]);

    expect(createMatchXgResolver({ history: [] })).toBeNull();
  });

  it("validates scorelines and scores exact (20), outcome (10), and miss (0)", () => {
    expect(isScoreline("2-1")).toBe(true);
    expect(isScoreline("10-0")).toBe(true);
    expect(isScoreline("2-")).toBe(false);
    expect(isScoreline(undefined)).toBe(false);
    expect(["3-1", "0-0", "1-2"].map(getScorelineOutcome)).toEqual(["H", "D", "A"]);

    const preds = buildPredictions([
      { home: "Arsenal", away: "Coventry" },
      { home: "Fulham", away: "Brentford" },
      { home: "Chelsea", away: "Spurs" },
    ]);
    const [scored, total] = calculateScore(preds, [[2, 0], [2, 2], [2, 0]]);
    expect(scored.map((r) => r.Points)).toEqual([20, 10, 0]);
    expect(total).toBe(30);
    expect(scored.map((r) => r.MissReason)).toEqual([
      "—",
      "❌ MISS: Wrong Score",
      "❌ MISS: Wrong Outcome",
    ]);
  });
});

describe("GET /api/v4-predictor/auto — V2 Strict 3-Snipe route", () => {
  it("fetches fixtures, passes them directly to generateV2Predictions, and never loads the Engine", async () => {
    const fixtures = [
      {
        id: "m1",
        leagueSlug: "eng.1",
        matchweek: 8,
        date: "2026-10-24T15:00:00Z",
        state: "post" as const,
        home: { name: "Arsenal FC", score: "2", logo: "https://example.com/ars.png" },
        away: { name: "Coventry City FC", score: "0", logo: null },
      },
      {
        id: "m2",
        leagueSlug: "eng.1",
        matchweek: 8,
        date: "2026-10-24T17:30:00Z",
        state: "pre" as const,
        home: { name: "Everton FC", score: null, logo: null },
        away: { name: "Fulham FC", score: null, logo: null },
      },
      {
        id: "m3",
        leagueSlug: "eng.1",
        matchweek: 8,
        date: "2026-10-20T15:00:00Z",
        state: "post" as const,
        home: { name: "Chelsea FC", score: "2", logo: null },
        away: { name: "Tottenham Hotspur FC", score: "1", logo: null },
      },
    ];

    vi.resetModules();
    vi.doMock("@/lib/espn", () => ({
      fetchScoreboard: vi.fn().mockResolvedValue(fixtures),
      getCurrentMatchweek: vi.fn().mockResolvedValue(8),
    }));
    vi.doMock("@/lib/engine", () => {
      throw new Error("Engine must not be imported by V4 route");
    });
    vi.doMock("@/lib/v4-predictor-server", () => ({
      // Deterministic xG so the route's Chaos-vs-Chaos pick is testable offline:
      // 1.8 vs 1.4 is a 0.40 gap, over CHAOS_DRAW_MAX_XG_GAP, so Chelsea win.
      createMatchXgResolver: () => () => [1.8, 1.4] as XgPair,
    }));

    try {
      const { GET } = await import("@/app/api/v4-predictor/auto/route");
      const response = await GET(new Request("http://localhost/api/v4-predictor/auto?week=8"));
      expect(response.status).toBe(200);
      const { week, fixtures: rows } = await response.json();

      expect(week).toBe(8);
      expect(rows).toEqual([
        {
          home: { name: "Chelsea", logo: null },
          away: { name: "Spurs", logo: null },
          state: "post",
          actual: [2, 1],
          prediction: "2-1",
          category: "LOCK: Chaos Rule",
          targetPts: 10,
        },
        {
          home: { name: "Arsenal", logo: "https://example.com/ars.png" },
          away: { name: "Coventry", logo: null },
          state: "post",
          actual: [2, 0],
          prediction: "2-0",
          category: "SNIPE: Home Fortress",
          targetPts: 20,
        },
        {
          home: { name: "Everton", logo: null },
          away: { name: "Fulham", logo: null },
          state: "pre",
          actual: null,
          prediction: "1-1",
          category: "SNIPE: Mid-Table Deadlock",
          targetPts: 20,
        },
      ]);
    } finally {
      vi.doUnmock("@/lib/espn");
      vi.doUnmock("@/lib/engine");
      vi.doUnmock("@/lib/v4-predictor-server");
      vi.resetModules();
    }
  });
});

/**
 * Backtest replay (Step 3/4 of the V2 fix) — the guardrails, offline.
 *
 * Every row is a real 2026-27 fixture with the xG the Engine's attack/defence
 * model resolves from pre-kickoff history and the real final score, captured
 * from `npx tsx scripts/backtest-local.ts --detail`. Replaying a whole matchweek
 * here reproduces that script's week score without a network, so the guardrails
 * (MW5 >= 100, MW7 >= 100, MW9 >= 80, MW10 >= 90) are pinned by `npm test` too.
 *
 * `xg: null` marks a Home Fortress or Elite Away Snipe: those are pure rules and
 * never read the model. Mid-Table Deadlock rows carry their xG, because that
 * Snipe now checks the gap before it locks the 1-1.
 */
describe("V2 fix — full-matchweek backtest replay on real fixtures", () => {
  type Case = {
    home: string;
    away: string;
    xg: XgPair | null;
    actual: [number, number];
    points: number;
    prediction: string;
  };

  const scoreOf = (prediction: string, actual: [number, number]): number => {
    const [h, a] = prediction.split("-").map(Number);
    if (h === actual[0] && a === actual[1]) return 20;
    const outcome = (x: number, y: number) => (x > y ? "H" : x < y ? "A" : "D");
    return outcome(h, a) === outcome(actual[0], actual[1]) ? 10 : 0;
  };

  const replay = (cases: Case[]) => {
    const byKey = new Map(cases.map((c) => [`${c.home}|${c.away}`, c]));
    const predictions = generateV2Predictions(
      cases.map((c) => [c.home, c.away] as [string, string]),
      (_i, home, away) => byKey.get(`${home}|${away}`)?.xg ?? null,
    );
    return cases.map((c, i) => ({
      case: c,
      prediction: predictions[i].Prediction,
      points: scoreOf(predictions[i].Prediction, c.actual),
    }));
  };

  // MW1 — 70 points (was 60 before the draw-rule fix).
  const MW1: Case[] = [
    { home: "Arsenal", away: "Coventry", xg: null, actual: [3, 0], points: 10, prediction: "2-0" }, // SNIPE: Home Fortress
    { home: "Hull", away: "Man Utd", xg: [1.51, 1.31], actual: [2, 0], points: 10, prediction: "2-1" }, // LOCK: Chaos Rule
    { home: "Ipswich", away: "Sunderland", xg: [0.7, 1.6], actual: [2, 1], points: 10, prediction: "1-0" }, // LOCK: Standard Home
    { home: "Nott'm Forest", away: "Leeds", xg: [1.6, 1.04], actual: [0, 1], points: 20, prediction: "0-1" }, // LOCK: Standard Away
    { home: "Everton", away: "Crystal Palace", xg: [1.06, 1.09], actual: [2, 0], points: 0, prediction: "1-1" }, // SNIPE: Mid-Table Deadlock
    { home: "Brentford", away: "Spurs", xg: [1.86, 1.74], actual: [3, 0], points: 0, prediction: "1-1" }, // LOCK: Chaos Rule
    { home: "Man City", away: "Bournemouth", xg: [3.05, 0.98], actual: [2, 1], points: 10, prediction: "2-0" }, // LOCK: Smart Top 4 Home
    { home: "Brighton", away: "Aston Villa", xg: [1.56, 1.17], actual: [4, 0], points: 10, prediction: "2-0" }, // LOCK: Smart Top 4 Home
    { home: "Newcastle", away: "Liverpool", xg: null, actual: [2, 2], points: 0, prediction: "0-1" }, // SNIPE: Elite Away
    { home: "Fulham", away: "Chelsea", xg: [1.47, 1.5], actual: [2, 3], points: 0, prediction: "1-1" }, // LOCK: Chaos Rule
  ];

  // MW4 — 50 points (was 40 before the MW4 fix).
  const MW4: Case[] = [
    { home: "Crystal Palace", away: "Ipswich", xg: [1.75, 1.17], actual: [2, 3], points: 0, prediction: "2-1" }, // LOCK: Mid vs Bottom
    { home: "Liverpool", away: "Fulham", xg: [2.1, 0.86], actual: [0, 0], points: 0, prediction: "2-0" }, // LOCK: Smart Top 4 Home
    { home: "Aston Villa", away: "Nott'm Forest", xg: [2.12, 1.11], actual: [1, 2], points: 0, prediction: "2-1" }, // LOCK: Standard Home
    { home: "Bournemouth", away: "Brentford", xg: [1.18, 1.19], actual: [2, 2], points: 10, prediction: "1-1" }, // LOCK: Standard Away
    { home: "Chelsea", away: "Hull", xg: [0.81, 1.12], actual: [2, 2], points: 10, prediction: "1-1" }, // LOCK: Chaos Rule
    { home: "Spurs", away: "Everton", xg: [1.48, 1.13], actual: [0, 0], points: 0, prediction: "2-1" }, // LOCK: Chaos Rule
    { home: "Sunderland", away: "Arsenal", xg: null, actual: [0, 2], points: 10, prediction: "0-1" }, // SNIPE: Elite Away
    { home: "Coventry", away: "Brighton", xg: null, actual: [0, 5], points: 10, prediction: "0-1" }, // SNIPE: Elite Away
    { home: "Man Utd", away: "Man City", xg: [1.07, 1.7], actual: [0, 1], points: 10, prediction: "1-2" }, // LOCK: Chaos Rule
    { home: "Leeds", away: "Newcastle", xg: [1.26, 1.73], actual: [4, 1], points: 0, prediction: "1-1" }, // SNIPE: Mid-Table Deadlock
  ];

  // MW5 — 110 points (was 100 before the draw-rule fix).
  const MW5: Case[] = [
    { home: "Brentford", away: "Chelsea", xg: [1.715, 1.562], actual: [3, 0], points: 10, prediction: "2-1" }, // LOCK: Chaos Rule
    { home: "Spurs", away: "Aston Villa", xg: [1.6, 1.41], actual: [2, 3], points: 0, prediction: "2-1" }, // LOCK: Chaos Rule
    { home: "Everton", away: "Ipswich", xg: [1.59, 1.17], actual: [1, 0], points: 10, prediction: "2-1" }, // LOCK: Mid vs Bottom
    { home: "Brighton", away: "Arsenal", xg: [0.86, 1.72], actual: [3, 0], points: 10, prediction: "2-0" }, // LOCK: Smart Top 4 Home
    { home: "Newcastle", away: "Hull", xg: [1.37, 1.24], actual: [2, 1], points: 20, prediction: "2-1" }, // LOCK: Mid vs Bottom
    { home: "Nott'm Forest", away: "Coventry", xg: [1.53, 0.54], actual: [0, 1], points: 0, prediction: "1-0" }, // LOCK: Standard Home
    { home: "Bournemouth", away: "Liverpool", xg: null, actual: [0, 1], points: 20, prediction: "0-1" }, // SNIPE: Elite Away
    { home: "Leeds", away: "Crystal Palace", xg: [1.35, 1.33], actual: [0, 0], points: 10, prediction: "1-1" }, // SNIPE: Mid-Table Deadlock
    { home: "Man City", away: "Sunderland", xg: null, actual: [5, 3], points: 10, prediction: "2-0" }, // SNIPE: Home Fortress
    { home: "Fulham", away: "Man Utd", xg: [1.47, 1.37], actual: [1, 1], points: 20, prediction: "1-1" }, // LOCK: Chaos Rule
  ];

  // MW7 — 110 points (was 100 before the draw-rule fix).
  const MW7: Case[] = [
    { home: "Everton", away: "Chelsea", xg: [1.15, 1.36], actual: [0, 2], points: 10, prediction: "1-2" }, // LOCK: Chaos Rule
    { home: "Fulham", away: "Hull", xg: [1.23, 1.44], actual: [1, 0], points: 10, prediction: "2-1" }, // LOCK: Mid vs Bottom
    { home: "Man City", away: "Ipswich", xg: null, actual: [3, 2], points: 10, prediction: "2-0" }, // SNIPE: Home Fortress
    { home: "Brentford", away: "Liverpool", xg: null, actual: [1, 2], points: 10, prediction: "0-1" }, // SNIPE: Elite Away
    { home: "Newcastle", away: "Aston Villa", xg: [1.99, 1.08], actual: [0, 1], points: 0, prediction: "1-1" }, // SNIPE: Mid-Table Deadlock
    { home: "Bournemouth", away: "Sunderland", xg: [1.28, 0.94], actual: [2, 0], points: 10, prediction: "1-0" }, // LOCK: Standard Home
    { home: "Leeds", away: "Man Utd", xg: [1.35, 1.44], actual: [1, 1], points: 20, prediction: "1-1" }, // LOCK: Chaos Rule
    { home: "Brighton", away: "Crystal Palace", xg: [1.53, 1.05], actual: [5, 0], points: 10, prediction: "2-0" }, // LOCK: Smart Top 4 Home
    { home: "Nott'm Forest", away: "Arsenal", xg: [0.67, 1.68], actual: [0, 1], points: 20, prediction: "0-1" }, // LOCK: Standard Away
    { home: "Spurs", away: "Coventry", xg: [1.59, 0.94], actual: [3, 1], points: 10, prediction: "2-1" }, // LOCK: Chaos Rule
  ];

  // MW9 — 80 points.
  const MW9: Case[] = [
    { home: "Chelsea", away: "Man Utd", xg: [1.58, 1.18], actual: [2, 0], points: 10, prediction: "2-1" }, // LOCK: Chaos Rule
    { home: "Man City", away: "Brighton", xg: [2.65, 1.15], actual: [0, 1], points: 0, prediction: "2-0" }, // LOCK: Smart Top 4 Home
    { home: "Bournemouth", away: "Leeds", xg: [1.5, 1.0], actual: [2, 0], points: 0, prediction: "0-1" }, // LOCK: Standard Away
    { home: "Coventry", away: "Sunderland", xg: [1.03, 1.36], actual: [3, 1], points: 10, prediction: "1-0" }, // LOCK: Standard Home
    { home: "Hull", away: "Ipswich", xg: [1.66, 0.91], actual: [2, 2], points: 0, prediction: "1-0" }, // LOCK: Standard Home
    { home: "Brentford", away: "Nott'm Forest", xg: [2.02, 1.29], actual: [2, 0], points: 10, prediction: "2-1" }, // LOCK: Standard Home
    { home: "Spurs", away: "Crystal Palace", xg: [1.59, 1.33], actual: [2, 0], points: 10, prediction: "2-1" }, // LOCK: Chaos Rule
    { home: "Aston Villa", away: "Fulham", xg: [1.73, 1.09], actual: [1, 1], points: 20, prediction: "1-1" }, // SNIPE: Mid-Table Deadlock
    { home: "Liverpool", away: "Arsenal", xg: [1.13, 1.31], actual: [0, 1], points: 20, prediction: "0-1" }, // LOCK: Smart Top 4 Home
    { home: "Newcastle", away: "Everton", xg: [1.79, 0.83], actual: [0, 1], points: 0, prediction: "1-1" }, // SNIPE: Mid-Table Deadlock
  ];

  // MW10 — 90 points.
  const MW10: Case[] = [
    { home: "Everton", away: "Coventry", xg: [1.25, 0.79], actual: [3, 1], points: 10, prediction: "2-1" }, // LOCK: Mid vs Bottom
    { home: "Leeds", away: "Spurs", xg: [1.47, 1.76], actual: [1, 0], points: 0, prediction: "1-2" }, // LOCK: Chaos Rule
    { home: "Arsenal", away: "Hull", xg: null, actual: [1, 0], points: 10, prediction: "2-0" }, // SNIPE: Home Fortress
    { home: "Fulham", away: "Newcastle", xg: [1.43, 1.56], actual: [1, 1], points: 20, prediction: "1-1" }, // SNIPE: Mid-Table Deadlock
    { home: "Nott'm Forest", away: "Man City", xg: null, actual: [3, 1], points: 0, prediction: "0-1" }, // SNIPE: Elite Away
    { home: "Crystal Palace", away: "Liverpool", xg: [1.18, 1.87], actual: [1, 3], points: 10, prediction: "0-1" }, // LOCK: Standard Away
    { home: "Sunderland", away: "Chelsea", xg: [1.076, 1.221], actual: [1, 0], points: 0, prediction: "1-1" }, // LOCK: Chaos Rule
    { home: "Ipswich", away: "Bournemouth", xg: [1.03, 2.29], actual: [1, 2], points: 20, prediction: "1-2" }, // LOCK: Standard Away
    { home: "Brighton", away: "Brentford", xg: [1.6, 1.18], actual: [2, 0], points: 20, prediction: "2-0" }, // LOCK: Smart Top 4 Home
    { home: "Man Utd", away: "Aston Villa", xg: [1.58, 1.14], actual: [4, 4], points: 0, prediction: "2-1" }, // LOCK: Chaos Rule
  ];

  it.each([
    ["MW1", MW1],
    ["MW4", MW4],
    ["MW5", MW5],
    ["MW7", MW7],
    ["MW9", MW9],
    ["MW10", MW10],
  ] as Array<[string, Case[]]>)("%s — every fixture picks and scores as the backtest records", (_week, cases) => {
    const results = replay(cases);
    expect(results.map((r) => r.prediction)).toEqual(cases.map((c) => c.prediction));
    expect(results.map((r) => r.points)).toEqual(cases.map((c) => c.points));
  });

  it("holds the guardrail weeks: MW5 >= 100, MW7 >= 100, MW9 >= 80, MW10 >= 90", () => {
    const total = (cases: Case[]) => replay(cases).reduce((sum, r) => sum + r.points, 0);
    expect(total(MW5)).toBeGreaterThanOrEqual(100);
    expect(total(MW7)).toBeGreaterThanOrEqual(100);
    expect(total(MW9)).toBeGreaterThanOrEqual(80);
    expect(total(MW10)).toBeGreaterThanOrEqual(90);
  });

  it("draw-rule fix — a Chaos side away no longer forces a 1-1: MW1 60 -> 70, MW5 and MW7 100 -> 110", () => {
    const total = (cases: Case[]) => replay(cases).reduce((sum, r) => sum + r.points, 0);
    expect(total(MW1)).toBe(70);
    expect(total(MW5)).toBe(110);
    expect(total(MW7)).toBe(110);

    const pick = (cases: Case[], match: string) =>
      replay(cases).find((r) => `${r.case.home} vs ${r.case.away}` === match)!;
    // The three fixtures the fix scores on: the higher-xG side, home or away.
    expect(pick(MW1, "Hull vs Man Utd")).toMatchObject({ prediction: "2-1", points: 10 });
    expect(pick(MW5, "Brentford vs Chelsea")).toMatchObject({ prediction: "2-1", points: 10 });
    expect(pick(MW7, "Everton vs Chelsea")).toMatchObject({ prediction: "1-2", points: 10 });
    // The exact 1-1s inside the band survive.
    expect(pick(MW5, "Fulham vs Man Utd")).toMatchObject({ prediction: "1-1", points: 20 });
    expect(pick(MW7, "Leeds vs Man Utd")).toMatchObject({ prediction: "1-1", points: 20 });
    // Not every flip lands: Spurs were rated 0.29 better at Leeds and lost.
    expect(pick(MW10, "Leeds vs Spurs")).toMatchObject({ prediction: "1-2", points: 0 });
    // The Deadlock Snipe keeps its own, wider gate: a 0.65 gap is still a 1-1.
    expect(pick(MW9, "Aston Villa vs Fulham")).toMatchObject({ prediction: "1-1", points: 20 });
    // The tier pick survives a home xG edge: MW1's exact 0-1 at a 0.56 gap.
    expect(pick(MW1, "Nott'm Forest vs Leeds")).toMatchObject({ prediction: "0-1", points: 20 });
  });

  it("lifts MW4 from 40 to 50 — only the Standard Away draw is fixable by xG", () => {
    const results = replay(MW4);
    expect(results.reduce((sum, r) => sum + r.points, 0)).toBe(50);

    const byMatch = new Map(results.map((r) => [`${r.case.home} vs ${r.case.away}`, r]));
    // The Bournemouth trap: a 0.01 xG gap is a draw, not a 0-1.
    expect(byMatch.get("Bournemouth vs Brentford")!.prediction).toBe("1-1");
    expect(byMatch.get("Bournemouth vs Brentford")!.points).toBe(10);
    // The Spurs trap is not fixable by xG: the Engine rates Spurs 0.35 better,
    // and MW9 Spurs 2-0 Crystal Palace (0.25) pins the gate below that.
    expect(byMatch.get("Spurs vs Everton")!.prediction).toBe("2-1");
    expect(byMatch.get("Spurs vs Everton")!.points).toBe(0);
    // The Leeds trap is not fixable by xG either: the Engine's favourite was
    // Newcastle (1.73 vs 1.26), and the 0.47 gap is far inside the deadlock band.
    expect(byMatch.get("Leeds vs Newcastle")!.prediction).toBe("1-1");
    expect(byMatch.get("Leeds vs Newcastle")!.points).toBe(0);
    // The existing Chaos-home guard still holds its 10.
    expect(byMatch.get("Chelsea vs Hull")!.prediction).toBe("1-1");
    expect(byMatch.get("Chelsea vs Hull")!.points).toBe(10);
  });

  it("lifts MW9 from 40 to 80 on the three fixtures the fix targets", () => {
    const results = replay(MW9);
    expect(results.reduce((sum, r) => sum + r.points, 0)).toBe(80);

    const byMatch = new Map(results.map((r) => [`${r.case.home} vs ${r.case.away}`, r]));
    // Chaos at home, and the better of two Chaos sides, now take the win line.
    expect(byMatch.get("Chelsea vs Man Utd")!.prediction).toBe("2-1");
    expect(byMatch.get("Chelsea vs Man Utd")!.points).toBe(10);
    expect(byMatch.get("Spurs vs Crystal Palace")!.prediction).toBe("2-1");
    expect(byMatch.get("Spurs vs Crystal Palace")!.points).toBe(10);
    // The Top 4 Derby coin flip lands the exact scoreline.
    expect(byMatch.get("Liverpool vs Arsenal")!.prediction).toBe("0-1");
    expect(byMatch.get("Liverpool vs Arsenal")!.points).toBe(20);
    // Not fixable by xG: the Engine rates City 2.65 vs Brighton 1.15, so the
    // home branch keeps 2-0 and the 0-1 away win still misses.
    expect(byMatch.get("Man City vs Brighton")!.prediction).toBe("2-0");
    expect(byMatch.get("Man City vs Brighton")!.points).toBe(0);
  });
});
