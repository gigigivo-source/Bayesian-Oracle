import { describe, expect, it, vi } from "vitest";
import {
  BOTTOM_5,
  CHAOS_TEAMS,
  MID_TABLE,
  TOP_4,
  buildPredictions,
  calculateScore,
  generateV2Predictions,
  getScorelineOutcome,
  isScoreline,
  translateTeamName,
} from "@/lib/v4-predictor";

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

  it("uses Engine xG thresholds for Standard locks without changing ineligible tiers", () => {
    const predictions = generateV2Predictions([
      ["Bournemouth", "Nott'm Forest"],
      ["West Ham", "Leicester"],
      ["Brentford", "Nott'm Forest"],
      ["Liverpool", "Brighton"],
      ["West Ham", "Nott'm Forest"],
    ], new Map([
      [0, { homeXG: 2.4, awayXG: 1.1 }],
      [1, { homeXG: 0.9, awayXG: 2.2 }],
      [2, { homeXG: 1.9, awayXG: 2.0 }],
      [3, { homeXG: 2.7, awayXG: 1.0 }],
      [4, { homeXG: 3.6, awayXG: 1.0 }],
    ]));
    expect(predictions.map((p) => p.Prediction)).toEqual(["3-0", "0-3", "2-2", "2-0", "4-0"]);
    expect(predictions.map((p) => p.Category)).toEqual([
      "LOCK: Standard Home Blowout",
      "LOCK: Standard Away Blowout",
      "LOCK: Standard High Draw",
      "LOCK: Smart Top 4 Home",
      "LOCK: Standard Home Blowout",
    ]);
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
  it("fetches fixtures and skips Engine xG for Chaos and Snipe fixtures", async () => {
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

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
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
