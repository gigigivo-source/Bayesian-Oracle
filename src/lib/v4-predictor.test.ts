import { describe, expect, it, vi } from "vitest";
import { BOTTOM_5, CHAOS_DRAW_MAX_XG_GAP, CHAOS_TEAMS, CHAOS_XG_EDGE, MID_TABLE, STANDARD_BLOWOUT_GAP, STANDARD_DRAW_XG, TOP4_DERBY_AWAY_TOLERANCE, TOP4_DERBY_MAX_AWAY_EDGE, TOP4_DERBY_MIN_XG_EDGE, TOP_4, blowoutGoals, buildPredictions, calculateScore, generateV2Predictions, getScorelineOutcome, isScoreline, translateTeamName, type XgPair } from "@/lib/v4-predictor";
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

  it("Chaos Rule — home takes 2-1, away still needs the xG edge, two Chaos sides need a gap", () => {
    const slate: Array<[string, string]> = [
      ["Man Utd", "Ipswich"],      // Chaos home, clearly better -> 2-1
      ["Chelsea", "Hull"],         // Chaos home the Engine rates worse -> 1-1 (MW4 guard)
      ["Spurs", "Crystal Palace"], // Chaos home, small edge -> 2-1 (MW9 fix)
      ["Fulham", "Man Utd"],       // Chaos away, home rated better -> 1-1
      ["Coventry", "Chelsea"],     // Chaos away, big edge -> 1-2
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
      "Chelsea|Man Utd": [1.58, 1.18],
      "Man Utd|Spurs": [1.5, 1.45],
      "Chelsea|Brighton": [1.67, 1.36],
    };

    const predictions = generateV2Predictions(slate, (_i, home, away) => xg[`${home}|${away}`] ?? null);

    expect(predictions.map((p) => p.Category)).toEqual(Array(8).fill("LOCK: Chaos Rule"));
    expect(predictions.map((p) => p.Prediction)).toEqual([
      "2-1", "1-1", "2-1", "1-1", "1-2", "2-1", "1-1", "1-2",
    ]);
    // Every pick keeps the outcome the rule locked, and 2-2 stays banned.
    expect(predictions.map((p) => getScorelineOutcome(p.Prediction))).toEqual([
      "H", "D", "H", "D", "A", "H", "D", "A",
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

  it("Chaos Rule — the away gate is exactly CHAOS_XG_EDGE and the Chaos-derby gap exactly CHAOS_DRAW_MAX_XG_GAP", () => {
    // 1.5 +/- edge/2 keeps both sides near the middle of the grid where the
    // attack/defence rounding cannot drift a fixture across a threshold.
    const awayAt = (edge: number) =>
      generateV2Predictions([["Coventry", "Chelsea"]], () => [1.5 - edge / 2, 1.5 + edge / 2])[0]
        .Prediction;
    expect(awayAt(CHAOS_XG_EDGE - 0.02)).toBe("1-1");
    expect(awayAt(CHAOS_XG_EDGE)).toBe("1-1"); // 0.55 - 0.55 is 5.5e-17 in floats
    expect(awayAt(CHAOS_XG_EDGE + 0.02)).toBe("1-2");

    const derbyAt = (gap: number) =>
      generateV2Predictions([["Chelsea", "Man Utd"]], () => [1.5 + gap / 2, 1.5 - gap / 2])[0]
        .Prediction;
    expect(derbyAt(CHAOS_DRAW_MAX_XG_GAP - 0.02)).toBe("1-1");
    expect(derbyAt(CHAOS_DRAW_MAX_XG_GAP + 0.02)).toBe("2-1");
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
 * (MW5 = 100, MW7 = 100, MW10 >= 90) are pinned by `npm test` too.
 *
 * `xg: null` marks a Snipe: Snipes are pure rules and never read the model.
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

  // MW5 — 100 points.
  const MW5: Case[] = [
    { home: "Brentford", away: "Chelsea", xg: [1.71, 1.56], actual: [3, 0], points: 0, prediction: "1-1" }, // LOCK: Chaos Rule
    { home: "Spurs", away: "Aston Villa", xg: [1.6, 1.41], actual: [2, 3], points: 0, prediction: "2-1" }, // LOCK: Chaos Rule
    { home: "Everton", away: "Ipswich", xg: [1.59, 1.17], actual: [1, 0], points: 10, prediction: "2-1" }, // LOCK: Mid vs Bottom
    { home: "Brighton", away: "Arsenal", xg: [0.86, 1.72], actual: [3, 0], points: 10, prediction: "2-0" }, // LOCK: Smart Top 4 Home
    { home: "Newcastle", away: "Hull", xg: [1.37, 1.24], actual: [2, 1], points: 20, prediction: "2-1" }, // LOCK: Mid vs Bottom
    { home: "Nott'm Forest", away: "Coventry", xg: [1.53, 0.54], actual: [0, 1], points: 0, prediction: "1-0" }, // LOCK: Standard Home
    { home: "Bournemouth", away: "Liverpool", xg: null, actual: [0, 1], points: 20, prediction: "0-1" }, // SNIPE: Elite Away
    { home: "Leeds", away: "Crystal Palace", xg: null, actual: [0, 0], points: 10, prediction: "1-1" }, // SNIPE: Mid-Table Deadlock
    { home: "Man City", away: "Sunderland", xg: null, actual: [5, 3], points: 10, prediction: "2-0" }, // SNIPE: Home Fortress
    { home: "Fulham", away: "Man Utd", xg: [1.47, 1.37], actual: [1, 1], points: 20, prediction: "1-1" }, // LOCK: Chaos Rule
  ];

  // MW7 — 100 points.
  const MW7: Case[] = [
    { home: "Everton", away: "Chelsea", xg: [1.15, 1.36], actual: [0, 2], points: 0, prediction: "1-1" }, // LOCK: Chaos Rule
    { home: "Fulham", away: "Hull", xg: [1.23, 1.44], actual: [1, 0], points: 10, prediction: "2-1" }, // LOCK: Mid vs Bottom
    { home: "Man City", away: "Ipswich", xg: null, actual: [3, 2], points: 10, prediction: "2-0" }, // SNIPE: Home Fortress
    { home: "Brentford", away: "Liverpool", xg: null, actual: [1, 2], points: 10, prediction: "0-1" }, // SNIPE: Elite Away
    { home: "Newcastle", away: "Aston Villa", xg: null, actual: [0, 1], points: 0, prediction: "1-1" }, // SNIPE: Mid-Table Deadlock
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
    { home: "Aston Villa", away: "Fulham", xg: null, actual: [1, 1], points: 20, prediction: "1-1" }, // SNIPE: Mid-Table Deadlock
    { home: "Liverpool", away: "Arsenal", xg: [1.13, 1.31], actual: [0, 1], points: 20, prediction: "0-1" }, // LOCK: Smart Top 4 Home
    { home: "Newcastle", away: "Everton", xg: null, actual: [0, 1], points: 0, prediction: "1-1" }, // SNIPE: Mid-Table Deadlock
  ];

  // MW10 — 90 points.
  const MW10: Case[] = [
    { home: "Everton", away: "Coventry", xg: [1.25, 0.79], actual: [3, 1], points: 10, prediction: "2-1" }, // LOCK: Mid vs Bottom
    { home: "Leeds", away: "Spurs", xg: [1.47, 1.76], actual: [1, 0], points: 0, prediction: "1-1" }, // LOCK: Chaos Rule
    { home: "Arsenal", away: "Hull", xg: null, actual: [1, 0], points: 10, prediction: "2-0" }, // SNIPE: Home Fortress
    { home: "Fulham", away: "Newcastle", xg: null, actual: [1, 1], points: 20, prediction: "1-1" }, // SNIPE: Mid-Table Deadlock
    { home: "Nott'm Forest", away: "Man City", xg: null, actual: [3, 1], points: 0, prediction: "0-1" }, // SNIPE: Elite Away
    { home: "Crystal Palace", away: "Liverpool", xg: [1.18, 1.87], actual: [1, 3], points: 10, prediction: "0-1" }, // LOCK: Standard Away
    { home: "Sunderland", away: "Chelsea", xg: [1.08, 1.22], actual: [1, 0], points: 0, prediction: "1-1" }, // LOCK: Chaos Rule
    { home: "Ipswich", away: "Bournemouth", xg: [1.03, 2.29], actual: [1, 2], points: 20, prediction: "1-2" }, // LOCK: Standard Away
    { home: "Brighton", away: "Brentford", xg: [1.6, 1.18], actual: [2, 0], points: 20, prediction: "2-0" }, // LOCK: Smart Top 4 Home
    { home: "Man Utd", away: "Aston Villa", xg: [1.58, 1.14], actual: [4, 4], points: 0, prediction: "2-1" }, // LOCK: Chaos Rule
  ];

  it.each([
    ["MW5", MW5],
    ["MW7", MW7],
    ["MW9", MW9],
    ["MW10", MW10],
  ] as Array<[string, Case[]]>)("%s — every fixture picks and scores as the backtest records", (_week, cases) => {
    const results = replay(cases);
    expect(results.map((r) => r.prediction)).toEqual(cases.map((c) => c.prediction));
    expect(results.map((r) => r.points)).toEqual(cases.map((c) => c.points));
  });

  it("holds the guardrail weeks: MW5 = 100, MW7 = 100, MW10 >= 90", () => {
    const total = (cases: Case[]) => replay(cases).reduce((sum, r) => sum + r.points, 0);
    expect(total(MW5)).toBe(100);
    expect(total(MW7)).toBe(100);
    expect(total(MW10)).toBeGreaterThanOrEqual(90);
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
