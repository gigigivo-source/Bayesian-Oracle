import { describe, expect, it } from "vitest";
import {
  deriveFromGoals,
  getAnchors,
  type LeagueAnchors,
} from "./statisticalAnchors";

/** Total corners = home + away: the number the corner markets are diffed against. */
function totalCorners(
  totalGoals: number,
  homeShare: number,
  anchors: LeagueAnchors,
): number {
  const d = deriveFromGoals(totalGoals, homeShare, anchors);
  return d.homeCorners + d.awayCorners;
}

describe("deriveFromGoals — corners decoupled from the goals ratio", () => {
  it("esp.1 @ 3.5 goals / 0.65 home share → 10.152 corners, not 13.02 from gRatio", () => {
    const esp1 = getAnchors("esp.1");
    const corners = totalCorners(3.5, 0.65, esp1);

    expect(corners).toBeCloseTo(10.152, 3);

    // Regression guard: the old multiplicative scaling was avgCorners * gRatio.
    const oldGRatioValue = esp1.avgCorners * (3.5 / esp1.avgGoals);
    expect(oldGRatioValue).toBeCloseTo(13.02, 2);
    expect(corners).not.toBeCloseTo(oldGRatioValue, 1);
  });

  it("moves 0.6 corners per goal above the league mean and pivots on that mean", () => {
    const esp1 = getAnchors("esp.1");

    // Anchored at the league baseline: no goal deviation → no corner deviation.
    const atMean = totalCorners(esp1.avgGoals, 0.55, esp1);
    expect(atMean).toBeCloseTo(esp1.avgCorners, 6);

    // Shallow linear slope, not a multiplicative ratio.
    expect(totalCorners(esp1.avgGoals + 1, 0.55, esp1) - atMean).toBeCloseTo(0.6, 6);
    expect(totalCorners(esp1.avgGoals + 2, 0.55, esp1)).toBeCloseTo(
      esp1.avgCorners + 1.2,
      6,
    );

    // Doubling the goals must not double the corners.
    const doubled = totalCorners(esp1.avgGoals * 2, 0.55, esp1);
    expect(doubled).toBeCloseTo(esp1.avgCorners + 0.6 * esp1.avgGoals, 6);
    expect(doubled).toBeLessThan(esp1.avgCorners * 2);
  });

  it("leaves the other secondary stats on the gRatio scaling", () => {
    const esp1 = getAnchors("esp.1");
    const d = deriveFromGoals(3.5, 0.65, esp1);
    const gRatio = 3.5 / esp1.avgGoals;

    expect(d.homeSot + d.awaySot).toBeCloseTo(esp1.avgSot * gRatio, 6);
    expect(d.homeShots + d.awayShots).toBeCloseTo(esp1.avgShots * gRatio, 6);
    expect(d.aerialTotal).toBeCloseTo(22 * gRatio, 6);
  });
});
