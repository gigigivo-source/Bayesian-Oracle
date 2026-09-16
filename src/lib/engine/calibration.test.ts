// Tests for the empirical backtest calibration layer (calibrateAgainstBacktest).

import { describe, expect, it } from "vitest";
import { calibrateAgainstBacktest, calibrateScannerPath } from "./calibration";

describe("calibrateAgainstBacktest", () => {
  it("pulls a claimed 0.95 down to ~0.83 (±0.02)", () => {
    expect(Math.abs(calibrateAgainstBacktest(0.95) - 0.83)).toBeLessThanOrEqual(0.02);
  });

  it("pulls a claimed 0.75 down to ~0.61 (±0.02)", () => {
    expect(Math.abs(calibrateAgainstBacktest(0.75) - 0.61)).toBeLessThanOrEqual(0.02);
  });

  it("is identity at 0.50", () => {
    expect(calibrateAgainstBacktest(0.5)).toBe(0.5);
  });

  it("passes through values below 0.50 unchanged", () => {
    expect(calibrateAgainstBacktest(0.3)).toBe(0.3);
  });

  it("caps high inputs near the 0.85 plateau", () => {
    expect(calibrateAgainstBacktest(0.99)).toBeLessThanOrEqual(0.86);
  });

  it("is monotone non-decreasing across [0.5, 1.0]", () => {
    const xs = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    for (let i = 1; i < xs.length; i++) {
      const prev = calibrateAgainstBacktest(xs[i - 1]);
      const curr = calibrateAgainstBacktest(xs[i]);
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });
});

describe("calibrateScannerPath", () => {
  it("calibrates 0.70 to approximately 0.66", () => {
    expect(Math.abs(calibrateScannerPath(0.70) - 0.66)).toBeLessThanOrEqual(0.02);
  });

  it("is identity at 0.50", () => {
    expect(calibrateScannerPath(0.50)).toBe(0.50);
  });

  it("is monotone non-decreasing from 0.50 to 1.00 in 0.05 steps", () => {
    const probabilities = Array.from({ length: 11 }, (_, index) => 0.50 + index * 0.05);
    for (let i = 1; i < probabilities.length; i++) {
      const previous = calibrateScannerPath(probabilities[i - 1]);
      const current = calibrateScannerPath(probabilities[i]);
      expect(current).toBeGreaterThanOrEqual(previous);
    }
  });
});
