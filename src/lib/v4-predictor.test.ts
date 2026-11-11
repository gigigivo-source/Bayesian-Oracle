import { describe, expect, it } from "vitest";
import { generatePredictions, isScoreline } from "@/lib/v4-predictor";

describe("generatePredictions: engine-driven Locks", () => {
  it("keeps the fixed Snipe scores even when the engine has a different pick", () => {
    const [fortress, deadlock, eliteAway] = generatePredictions([
      { home: "Arsenal", away: "Coventry", enginePrediction: "3-1" }, // Home Fortress
      { home: "Fulham", away: "Leeds", enginePrediction: "0-0" }, // Mid-table Deadlock
      { home: "Everton", away: "Liverpool", enginePrediction: "2-2" }, // Elite Away
    ]);
    expect(fortress).toMatchObject({ Category: "SNIPE: Home Fortress", Prediction: "2-0", Target_Pts: 20 });
    expect(deadlock).toMatchObject({ Category: "SNIPE: Mid-Table Deadlock", Prediction: "1-1", Target_Pts: 20 });
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

  it("replaces the hardcoded Lock scores (1-0, 0-1, 2-1) with the engine score, including 0-0 and 2-2", () => {
    const predictions = generatePredictions([
      { home: "Man City", away: "Brentford", enginePrediction: "0-0" }, // Top 4 home
      { home: "Hull", away: "Aston Villa", enginePrediction: "2-2" }, // Bottom 5 vs Mid
      { home: "Chelsea", away: "Hull", enginePrediction: "3-1" }, // Chaos
    ]);
    expect(predictions.map((p) => [p.Category, p.Prediction])).toEqual([
      ["LOCK: Engine Top Pick", "0-0"],
      ["LOCK: Engine Top Pick", "2-2"],
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
