import { describe, expect, it } from "vitest";
import {
  assessMarketConfidence,
  completenessLabel,
  sourceAgreementScore,
  toConfidenceBreakdown,
} from "./confidence";

describe("source agreement scoring", () => {
  it("rewards multiple agreeing sources and penalises a lone source", () => {
    expect(sourceAgreementScore(0)).toBe(0);
    expect(sourceAgreementScore(1)).toBe(50);
    expect(sourceAgreementScore(2)).toBe(75);
    expect(sourceAgreementScore(3)).toBe(100);
    expect(sourceAgreementScore(9)).toBe(100);
  });
});

describe("confidence score", () => {
  it("reproduces the documented worked examples", () => {
    // real + 3 sources agree + all stats present → 100
    expect(
      assessMarketConfidence({
        dataQuality: "real",
        sourceCount: 3,
        completenessPct: 100,
        sourceNames: ["SportScore", "API-Football", "FBref"],
      }).confidenceScore,
    ).toBe(100);

    // real + 1 source + all stats present → 85
    expect(
      assessMarketConfidence({
        dataQuality: "real",
        sourceCount: 1,
        completenessPct: 100,
        sourceNames: ["SportScore"],
      }).confidenceScore,
    ).toBe(85);

    // mixed + 2 sources + some stats missing → ~65
    expect(
      assessMarketConfidence({
        dataQuality: "mixed",
        sourceCount: 2,
        completenessPct: 62.5,
        sourceNames: ["SportScore", "API-Football"],
      }).confidenceScore,
    ).toBe(66);

    // synthetic + 0 sources → heavily penalised (weighted floor of 12)
    expect(
      assessMarketConfidence({
        dataQuality: "synthetic",
        sourceCount: 0,
        completenessPct: 0,
        sourceNames: [],
      }).confidenceScore,
    ).toBe(12);
  });

  it("keeps breakdown points summing to the score across every combination", () => {
    for (const dataQuality of ["real", "mixed", "synthetic"] as const) {
      for (const sourceCount of [0, 1, 2, 3, 4]) {
        for (const completenessPct of [0, 37.5, 50, 62.5, 75, 100]) {
          const assessment = assessMarketConfidence({
            dataQuality,
            sourceCount,
            completenessPct,
            sourceNames: ["SportScore"],
          });
          expect(assessment.confidenceScore).toBeGreaterThanOrEqual(0);
          expect(assessment.confidenceScore).toBeLessThanOrEqual(100);
          expect(
            assessment.dataQualityPoints +
              assessment.sourceAgreementPoints +
              assessment.completenessPoints,
          ).toBe(assessment.confidenceScore);
        }
      }
    }
  });

  it("clamps out-of-range completeness and source counts", () => {
    const assessment = assessMarketConfidence({
      dataQuality: "real",
      sourceCount: -4,
      completenessPct: 150,
      sourceNames: ["SportScore"],
    });
    expect(assessment.sourceCount).toBe(0);
    expect(assessment.sourceAgreementPoints).toBe(0);
    expect(assessment.completenessPoints).toBe(30);
    expect(assessment.completenessPct).toBe(100);
  });

  it("formats the data source detail string", () => {
    expect(
      assessMarketConfidence({
        dataQuality: "real",
        sourceCount: 1,
        completenessPct: 100,
        sourceNames: ["SportScore"],
      }).dataSourceDetail,
    ).toBe("SportScore (Real)");

    expect(
      assessMarketConfidence({
        dataQuality: "real",
        sourceCount: 3,
        completenessPct: 100,
        sourceNames: ["SportScore", "API-Football", "FBref"],
      }).dataSourceDetail,
    ).toBe("SportScore + API-Football + FBref (Real)");

    expect(
      assessMarketConfidence({
        dataQuality: "mixed",
        sourceCount: 1,
        completenessPct: 75,
        sourceNames: ["SportScore"],
      }).dataSourceDetail,
    ).toBe("SportScore (Real) + Synthetic");

    expect(
      assessMarketConfidence({
        dataQuality: "synthetic",
        sourceCount: 0,
        completenessPct: 50,
        sourceNames: [],
      }).dataSourceDetail,
    ).toBe("Synthetic Baseline (League Avg)");

    // A "real"/"mixed" label without any source names still degrades honestly.
    expect(
      assessMarketConfidence({
        dataQuality: "mixed",
        sourceCount: 1,
        completenessPct: 75,
        sourceNames: [],
      }).dataSourceDetail,
    ).toBe("Synthetic Baseline (League Avg)");
  });

  it("exposes a display breakdown without the score fields", () => {
    const assessment = assessMarketConfidence({
      dataQuality: "mixed",
      sourceCount: 2,
      completenessPct: 62.5,
      sourceNames: ["A", "B"],
    });
    expect(toConfidenceBreakdown(assessment)).toEqual({
      dataQuality: "mixed",
      dataQualityPoints: 24,
      sourceCount: 2,
      sourceAgreementPoints: 23,
      completenessPct: 62.5,
      completenessPoints: 19,
    });
    expect(toConfidenceBreakdown(assessment)).not.toHaveProperty("confidenceScore");
  });

  it("labels completeness for the tooltip", () => {
    expect(completenessLabel(100)).toBe("All stats present");
    expect(completenessLabel(0)).toBe("No team-specific stats");
    expect(completenessLabel(62)).toBe("62% of stats present");
  });
});
