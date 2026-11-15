import { describe, expect, it, vi } from "vitest";
import { BOTTOM_5, CHAOS_TEAMS, CHAOS_XG_EDGE, MID_TABLE, STANDARD_BLOWOUT_GAP, STANDARD_DRAW_XG, TOP4_DERBY_MIN_XG_EDGE, TOP_4, blowoutGoals, buildPredictions, calculateScore, generateV2Predictions, getScorelineOutcome, isScoreline, translateTeamName, type XgPair } from "@/lib/v4-predictor";
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
      { home: "Chelsea", away: "Spurs" },   // Chaos vs Chaos -> 1-1 (NEVER 2-2)
      { home: "Spurs", away: "Coventry" },  // Chaos vs Bottom 5 -> 1-1 (banned from Snipe)
      { home: "Everton", away: "Man Utd" }, // Mid vs Chaos -> 1-1
    ]);

    for (const p of predictions) {
      expect(p.Category).toBe("LOCK: Chaos Rule");
      expect(p.Prediction).not.toBe("2-2");
      expect(p.Target_Pts).toBe(10);
    }
    expect(predictions.map((p) => p.Prediction)).toEqual(["2-1", "1-2", "1-1", "1-1", "1-1"]);
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

  it("Chaos Rule — a Chaos side takes the win line only when its xG edge clears the gate", () => {
    const slate: Array<[string, string]> = [
      ["Man Utd", "Ipswich"],    // Chaos home vs Bottom 5, big xG edge -> 2-1
      ["Fulham", "Man Utd"],     // Chaos away, no edge -> 1-1
      ["Spurs", "Newcastle"],    // Chaos home vs Mid, small edge -> 1-1
      ["Chelsea", "Man Utd"],    // both Chaos -> always 1-1
      ["Sheffield Utd", "Spurs"], // Chaos away vs Standard, big edge -> 1-2
      ["Chelsea", "Brighton"],   // Chaos vs Top 4 keeps the flat 1-2
    ];
    const xg: Record<string, XgPair> = {
      "Man Utd|Ipswich": [2.2, 1.0],
      "Fulham|Man Utd": [1.5, 1.4],
      "Spurs|Newcastle": [1.6, 1.5],
      "Chelsea|Man Utd": [2.0, 1.0],
      "Sheffield Utd|Spurs": [1.1, 2.1],
      "Chelsea|Brighton": [2.4, 1.3],
    };

    const predictions = generateV2Predictions(slate, (_i, home, away) => xg[`${home}|${away}`] ?? null);

    expect(predictions.map((p) => p.Category)).toEqual(Array(6).fill("LOCK: Chaos Rule"));
    expect(predictions.map((p) => p.Prediction)).toEqual(["2-1", "1-1", "1-1", "1-1", "1-2", "1-2"]);
    expect(predictions.some((p) => p.Prediction === "2-2")).toBe(false);
  });

  it("Chaos Rule — keeps the flat 1-1 default when no xG model is supplied", () => {
    const predictions = generateV2Predictions([
      ["Man Utd", "Ipswich"],
      ["Sheffield Utd", "Spurs"],
      ["Chelsea", "Man Utd"],
    ]);
    expect(predictions.map((p) => p.Prediction)).toEqual(["1-1", "1-1", "1-1"]);
  });

  it("Chaos Rule — the gate is exactly CHAOS_XG_EDGE", () => {
    // 1.4 / 2.0 keeps both sides under the threshold where the attack/defence
    // model's rounding would drift the edge away from the constant.
    const at = (edge: number) => {
      const homeXg = 1.5 + edge / 2;
      const awayXg = 1.5 - edge / 2;
      return generateV2Predictions(
        [["Chelsea", "Coventry"]], // Chaos home vs Bottom 5
        () => [homeXg, awayXg],
      )[0].Prediction;
    };
    expect(at(CHAOS_XG_EDGE - 0.02)).toBe("1-1");
    expect(at(CHAOS_XG_EDGE)).toBe("1-1"); // 0.55 - 0.55 is 5.5e-17 in floats
    expect(at(CHAOS_XG_EDGE + 0.02)).toBe("2-1");
  });

  it("Top 4 Derby — Home winner lock is kept (no xG derby flip); exact score from the Correct Score grid", () => {
    const slate: Array<[string, string]> = [
      ["Brighton", "Arsenal"],   // MW5: model prefers Arsenal, actual 3-0 Brighton
      ["Liverpool", "Arsenal"],  // MW9: away side marginally ahead
      ["Man City", "Brighton"],  // MW9: model prefers City, actual 0-1
      ["Liverpool", "Man City"], // dead heat
      ["Arsenal", "Coventry"],   // not a derby
    ];
    const xg: Record<string, XgPair> = {
      "Brighton|Arsenal": [0.91, 1.65],
      "Liverpool|Arsenal": [1.13, 1.31],
      "Man City|Brighton": [2.65, 1.15],
      "Liverpool|Man City": [1.33, 1.34],
      "Arsenal|Coventry": [2.3, 0.9],
    };

    const predictions = generateV2Predictions(slate, (_i, home, away) => xg[`${home}|${away}`] ?? null);

    // The Top 4 Home winner lock is kept: the xG derby flip stays reverted.
    // Under the conservative hybrid the flat V2 2-0 is a top-3 grid cell for
    // every Top 4 Home lock here, so the flat line is kept throughout (the xG
    // derby flip stays reverted).
    expect(predictions.map((p) => p.Category)).toEqual([
      "LOCK: Smart Top 4 Home",
      "LOCK: Smart Top 4 Home",
      "LOCK: Smart Top 4 Home",
      "LOCK: Smart Top 4 Home",
      "SNIPE: Home Fortress",
    ]);
    expect(predictions.map((p) => p.Prediction)).toEqual(["2-0", "2-0", "2-0", "2-0", "2-0"]);
    expect(predictions.slice(0, 4).every((p) => p.Target_Pts === 10)).toBe(true);
    expect(predictions[4].Target_Pts).toBe(20);
    expect(TOP4_DERBY_MIN_XG_EDGE).toBeGreaterThan(0);
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
    expect(throwing.map((p) => p.Prediction)).toEqual(["2-0", "1-1"]);

    const broken = generateV2Predictions(slate, () => [Number.NaN, 1] as XgPair);
    expect(broken.map((p) => p.Prediction)).toEqual(["2-0", "1-1"]);
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
          prediction: "1-1",
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
      vi.resetModules();
    }
  });
});

/**
 * Guardrail replay (Step 4 of the V2 fix).
 *
 * These are the real 2026-27 fixtures the xG-aware Locks actually touch, with
 * the xG the Engine's attack/defence model produces from pre-kickoff history and
 * the real final scores. The weeks called out in the spec must not regress:
 * MW5 = 100, MW7 = 100, MW10 = 90+. `npx tsx scripts/backtest-local.ts` is the
 * full-slate version of this check; it reproduces these numbers exactly.
 */
describe("V2 fix — backtest guardrails on real fixtures", () => {
  type Case = {
    home: string;
    away: string;
    xg: XgPair;
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

  // MW5 — guardrail: must stay at 100. Chaos picks are unchanged by the fix.
  const MW5: Case[] = [
    { home: "Brentford", away: "Chelsea", xg: [1.98, 1.47], actual: [3, 0], points: 0, prediction: "1-1" },
    { home: "Spurs", away: "Aston Villa", xg: [1.72, 0.66], actual: [2, 3], points: 0, prediction: "2-1" },
    { home: "Fulham", away: "Man Utd", xg: [1.52, 2.06], actual: [1, 1], points: 20, prediction: "1-1" },
  ];

  // MW7 — guardrail: must stay at 100. Leeds 1-1 Man Utd keeps its exact 20.
  const MW7: Case[] = [
    { home: "Everton", away: "Chelsea", xg: [1.91, 1.21], actual: [0, 2], points: 0, prediction: "1-1" },
    { home: "Leeds", away: "Man Utd", xg: [1.52, 0.95], actual: [1, 1], points: 20, prediction: "1-1" },
    { home: "Spurs", away: "Coventry", xg: [1.52, 0.8], actual: [3, 1], points: 10, prediction: "2-1" },
  ];

  // MW10 — guardrail: must stay at 90+. Man Utd 4-4 Aston Villa keeps its 10.
  const MW10: Case[] = [
    { home: "Leeds", away: "Spurs", xg: [1.34, 0.94], actual: [1, 0], points: 0, prediction: "1-1" },
    { home: "Sunderland", away: "Chelsea", xg: [0.68, 1.72], actual: [1, 0], points: 0, prediction: "1-2" },
    { home: "Man Utd", away: "Aston Villa", xg: [1.48, 1.13], actual: [4, 4], points: 10, prediction: "1-1" },
  ];

  // MW2 — the week the Chaos fix targets. Man Utd 5-2 Ipswich now scores.
  const MW2: Case[] = [
    { home: "Spurs", away: "Newcastle", xg: [1.55, 1.55], actual: [0, 2], points: 0, prediction: "1-1" },
    { home: "Chelsea", away: "Brighton", xg: [1.32, 2.14], actual: [4, 3], points: 0, prediction: "1-2" },
    { home: "Man Utd", away: "Ipswich", xg: [2.09, 1.02], actual: [5, 2], points: 10, prediction: "2-1" },
  ];

  it.each([
    ["MW5", MW5],
    ["MW7", MW7],
    ["MW10", MW10],
    ["MW2", MW2],
  ] as Array<[string, Case[]]>)("%s — Chaos picks score the expected points", (_week, cases) => {
    const results = replay(cases);
    expect(results.map((r) => r.prediction)).toEqual(cases.map((c) => c.prediction));
    expect(results.map((r) => r.points)).toEqual(cases.map((c) => c.points));
  });

  it("never regresses the guardrail weeks' Chaos points against the flat 1-1 baseline", () => {
    const flat = (cases: Case[]) =>
      cases.reduce((sum, c) => sum + scoreOf("1-1", c.actual), 0);
    const withXg = (cases: Case[]) =>
      replay(cases).reduce((sum, r) => sum + r.points, 0);

    for (const week of [MW5, MW7, MW10]) {
      expect(withXg(week)).toBeGreaterThanOrEqual(flat(week));
    }
    expect(withXg(MW2)).toBeGreaterThan(flat(MW2));
  });
});
