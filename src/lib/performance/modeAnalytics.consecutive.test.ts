// Tests for the Consecutive Goals market family in the performance analytics
// layer (Part 5): tracked legs for the chip-only markets are aggregated under
// the "Consecutive Goals" family so the Performance Dashboard can filter them.

import { describe, expect, it } from "vitest";
import { deriveFactorBucket, deriveMarketFamily } from "./modeAnalytics";

describe("deriveMarketFamily — Consecutive Goals", () => {
  it("maps the three chip-only market names to the Consecutive Goals family", () => {
    expect(deriveMarketFamily("Arsenal Consecutive Goals (3 in a row)")).toBe("Consecutive Goals");
    expect(deriveMarketFamily("Chelsea Consecutive Goals (3 in a row)")).toBe("Consecutive Goals");
    expect(deriveMarketFamily("Either Team Consecutive Goals (3 in a row)")).toBe("Consecutive Goals");
  });

  it("also honours an explicit registry family (chip-only family wins)", () => {
    expect(deriveMarketFamily("Arsenal Consecutive Goals (3 in a row)", "Consecutive Goals"))
      .toBe("Consecutive Goals");
    // Legacy Goal Sequence lines keep their own semantics via the same check.
    expect(deriveMarketFamily("3+ Consecutive Goals (Same Team)", "Goal Sequence"))
      .toBe("Consecutive Goals");
  });

  it("does not change the classification of regular goal markets", () => {
    expect(deriveMarketFamily("Total Goals O/U 2.5")).toBe("Goals");
    expect(deriveMarketFamily("Both Teams To Score")).toBe("Goals");
    expect(deriveMarketFamily("Arsenal Goals O/U 1.5", "Goals")).toBe("Goals");
  });

  it("buckets the derived factor as Poisson λ (Consecutive Goals)", () => {
    expect(deriveFactorBucket("Arsenal Consecutive Goals (3 in a row)", "Consecutive Goals"))
      .toBe("Poisson λ (Consecutive Goals)");
  });
});
