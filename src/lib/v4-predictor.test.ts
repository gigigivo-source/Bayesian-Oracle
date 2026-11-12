import { describe, expect, it, vi } from "vitest";
import { generatePredictions, getV2Outcome, isScoreline } from "@/lib/v4-predictor";

describe("generatePredictions: V2 outcome and engine score", () => {
  it("uses matching engine scores for Snipes and preserves the V2 outcome when they disagree", () => {
    const [fortress, deadlock, eliteAway] = generatePredictions([
      { home: "Arsenal", away: "Coventry", enginePrediction: "3-1" }, // Home Fortress
      { home: "Fulham", away: "Leeds", enginePrediction: "0-0" }, // Mid-table Deadlock
      { home: "Everton", away: "Liverpool", enginePrediction: "2-2" }, // Elite Away
    ]);
    expect(fortress).toMatchObject({ Category: "SNIPE: Home Fortress", Prediction: "3-1", Target_Pts: 20 });
    expect(deadlock).toMatchObject({ Category: "SNIPE: Mid-Table Deadlock", Prediction: "0-0", Target_Pts: 20 });
    expect(eliteAway).toMatchObject({ Category: "SNIPE: Elite Away", Prediction: "0-1", Target_Pts: 20 });
  });

  it("uses the engine's top pick for a Lock, labelled LOCK: Engine Top Pick", () => {
    const [standardLock] = generatePredictions([{ home: "Wolves", away: "Hull", enginePrediction: "3-1" }]);
    expect(standardLock).toEqual({
      Match: "Wolves vs Hull",
      Category: "LOCK: Engine Top Pick",
      Prediction: "3-1",
      Target_Pts: 10,
    });
  });

  it("rejects engine scores with the wrong outcome and accepts matching Lock scores", () => {
    const predictions = generatePredictions([
      { home: "Man City", away: "Brentford", enginePrediction: "0-0" }, // Top 4 home
      { home: "Hull", away: "Aston Villa", enginePrediction: "2-2" }, // Bottom 5 vs Mid
      { home: "Chelsea", away: "Hull", enginePrediction: "3-1" }, // Chaos
    ]);
    expect(predictions.map((p) => [p.Category, p.Prediction])).toEqual([
      ["LOCK: Smart Top 4 Home", "2-0"],
      ["LOCK: Bottom vs Mid", "0-1"],
      ["LOCK: Engine Top Pick", "3-1"],
    ]);
  });

  it("falls back to the original Lock hierarchy when the engine score is missing or malformed", () => {
    const predictions = generatePredictions([
      { home: "Wolves", away: "Hull" }, // Standard vs Bottom 5, no engine score
      { home: "Wolves", away: "Hull", enginePrediction: null },
      { home: "Wolves", away: "Hull", enginePrediction: "" },
      { home: "Wolves", away: "Hull", enginePrediction: "two-one" },
    ]);
    expect(predictions.map((p) => [p.Category, p.Prediction])).toEqual([
      ["LOCK: Standard vs Bottom", "1-0"],
      ["LOCK: Standard vs Bottom", "1-0"],
      ["LOCK: Standard vs Bottom", "1-0"],
      ["LOCK: Standard vs Bottom", "1-0"],
    ]);
  });

  it("validates scorelines strictly", () => {
    expect(isScoreline("2-1")).toBe(true);
    expect(isScoreline("10-0")).toBe(true);
    expect(isScoreline("2-")).toBe(false);
    expect(isScoreline("2-1-0")).toBe(false);
    expect(isScoreline(undefined)).toBe(false);
    expect(isScoreline(21)).toBe(false);
  });
});


describe("Consensus Override route", () => {
  it("selects the highest-probability score for each V2 outcome, preserving week-wide Snipe quotas", async () => {
    const teams = [
      ["Arsenal", "Coventry City"],
      ["Fulham", "Leeds United"],
      ["Hull City", "Liverpool"],
      ["Burnley", "Brighton & Hove Albion"],
      ["Manchester City", "Brentford"],
      ["Chelsea", "Tottenham Hotspur"],
      ["Wolves", "Hull City"],
    ];
    const fixtures = teams.map(([home, away], i) => ({
      id: String(i), leagueSlug: "eng.1", matchweek: 11,
      date: `2026-11-${String(i + 1).padStart(2, "0")}T15:00:00Z`, state: "pre",
      home: { name: home, score: null }, away: { name: away, score: null },
    }));
    vi.doMock("@/lib/espn", () => ({
      fetchScoreboard: vi.fn().mockResolvedValue([...fixtures].reverse()),
      fetchSummary: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("@/lib/engine/engine", () => ({
      runEngineFromRealWithProfiles: vi.fn(async (fixture: { id: string }) => ({
        markets: fixture.id === "6" ? [
          { name: "Correct Score 0-0", hitRate: 0.5 },
          { name: "Correct Score 2-0", hitRate: NaN },
          { name: "Correct Score 0-1", hitRate: 0.04 },
        ] : [
          { name: "Correct Score 0-0", hitRate: 0.6 },
          { name: "Correct Score 3-1", hitRate: 0.07 },
          { name: "Correct Score 2-1", hitRate: 0.15 },
          { name: "Correct Score 0-1", hitRate: 0.08 },
          { name: "Correct Score 1-2", hitRate: 0.12 },
          { name: "Correct Score 1-1", hitRate: 0.7 },
          { name: "Correct Score 10-0 extra", hitRate: 0.99 },
        ],
      })),
    }));

    try {
      const { GET } = await import("@/app/api/v4-predictor/auto/route");
      const response = await GET(new Request("http://localhost/api/v4-predictor/auto?week=11"));
      expect(response.status).toBe(200);
      const { fixtures: rows } = await response.json();
      expect(rows.map((row: { enginePrediction: string | null }) => row.enginePrediction))
        .toEqual(["2-1", "1-1", "1-2", "1-2", "2-1", "1-1", null]);
      const predictions = generatePredictions(rows.map((row: {
        home: { name: string }; away: { name: string }; enginePrediction: string | null;
      }) => ({ home: row.home.name, away: row.away.name, enginePrediction: row.enginePrediction })));
      expect(predictions.map((prediction) => prediction.Prediction))
        .toEqual(["2-1", "1-1", "1-2", "1-2", "2-1", "1-1", "1-0"]);
      expect(predictions[3].Category).toBe("LOCK: Engine Top Pick");
    } finally {
      vi.doUnmock("@/lib/espn");
      vi.doUnmock("@/lib/engine/engine");
      vi.resetModules();
    }
  });

  it("classifies home wins, draws and away wins", () => {
    expect(["3-1", "0-0", "1-2", "10-9"].map(getV2Outcome)).toEqual(["H", "D", "A", "H"]);
  });
});
