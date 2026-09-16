// Engine assembly tests — empirical backtest calibration pass.
//
// Verifies that assemble() applies calibrateAgainstBacktest to every
// Goals-family market (Total Goals O/U, team goals, BTTS, …) and leaves
// every other family (Corners, Cards, SOT, Shots, …) exactly as the raw
// Poisson pipeline produced it.
//
// The raw pipeline is reconstructed by re-running the same deterministic
// building blocks runEngineFromReal() uses internally (buildRealLambdas is
// pure, and MarketEngine seeds its RNG from homeTeam|awayTeam|date), then
// pairing markets by id. This mirrors the LockedMatchObject that
// runEngineFromReal() builds for a null summary — only homeTeam/awayTeam/
// date (RNG seed), dataCompletenessScore (Wilson effN + rejection gate)
// and fallbackMode (agent jitter) affect the market values.
//
// engine.ts statically imports @/db (via ./dataMesh); mock it so the test
// runs without a DATABASE_URL — same convention as scannerCoverage.test.ts.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {}, pool: {} }));

import { runEngineFromReal } from "./engine";
import { buildRealLambdas } from "./realLambdas";
import { MarketEngine } from "./markets";
import { calibrateAgainstBacktest } from "./calibration";
import type { FixtureLite } from "../espn";
import type { LockedMatchObject, Market } from "./types";

// Minimal synthetic fixture — esp.1 (La Liga), pre-match, no summary,
// no profiles: exactly the shape the VA scanner passes to runEngineFromReal.
function espn1Fixture(): FixtureLite {
  const team = (side: "home" | "away", name: string) => ({
    id:       `${side}-id`,
    name,
    shortName: name,
    abbrev:   side === "home" ? "BAR" : "RMA",
    logo:     null,
    color:    null,
    score:    null,
    homeAway: side,
  });

  return {
    id:           "901",
    leagueSlug:   "esp.1",
    leagueName:   "La Liga",
    date:         "2026-09-19T19:00:00Z",
    state:        "pre",
    statusDetail: "Scheduled",
    venue:        null,
    home:         team("home", "FC Barcelona"),
    away:         team("away", "Real Madrid"),
    neutralSite:  false,
  };
}

/** The raw (pre-calibration) market pipeline for a fixture, paired by id. */
function rawPipeline(fx: FixtureLite): Map<string, Market> {
  const { lam, completeness } = buildRealLambdas(fx, null, undefined);
  const match: LockedMatchObject = {
    homeTeam:              fx.home.name,
    awayTeam:              fx.away.name,
    venue:                 `${fx.home.name} (Home)`,
    venueType:             "HOME",
    date:                  fx.date.slice(0, 10),
    timeUtc:               new Date(fx.date).toISOString().slice(11, 16) + " UTC",
    tournamentStage:       "League Match",
    refereeName:           "Assigned near kickoff",
    weatherForecast:       "Live venue conditions applied at kickoff",
    keyInjuryFlags:        ["Lineups not yet released — predicted XI (pre-match window)"],
    dataCompletenessScore: Math.round(completeness),
    fallbackMode:          completeness < 45,
  };
  return new Map(new MarketEngine(match, lam).buildAll().map((m) => [m.id, m]));
}

describe("assemble() — empirical backtest calibration (goals family only)", () => {
  const fx     = espn1Fixture();
  const result = runEngineFromReal(fx, null);
  const raw    = rawPipeline(fx);

  const goals   = result.markets.filter((m) => m.family === "Goals");
  const corners = result.markets.filter((m) => m.family === "Corners");

  it("A. applies calibrateAgainstBacktest to every Goals-family market and never raises it", () => {
    expect(goals.length).toBeGreaterThan(0);

    for (const m of goals) {
      const r = raw.get(m.id);
      expect(r, `raw counterpart for ${m.id} (${m.name})`).toBeDefined();
      // The pass must apply the empirical curve exactly.
      expect(m.hitRate).toBe(calibrateAgainstBacktest(r!.hitRate));
      // Where the curve is defined as identity-or-shrinkage (raw ≥ 0.02),
      // calibration never raises the probability.
      if (r!.hitRate >= 0.02) {
        expect(m.hitRate).toBeLessThanOrEqual(r!.hitRate);
      }
    }

    // Raw values above 0.5 are the over-confident region the backtest
    // measured — the curve is strictly below the identity there, so every
    // such goals market must be strictly lowered.
    const aboveHalf = goals.filter((m) => (raw.get(m.id)?.hitRate ?? 0) > 0.5);
    expect(aboveHalf.length).toBeGreaterThan(0); // non-vacuous
    for (const m of aboveHalf) {
      expect(m.hitRate).toBeLessThan(raw.get(m.id)!.hitRate);
    }
  });

  it("B. leaves Corners-family markets exactly as the raw pipeline produced them", () => {
    expect(corners.length).toBeGreaterThan(0);

    for (const m of corners) {
      const r = raw.get(m.id);
      expect(r, `raw counterpart for ${m.id} (${m.name})`).toBeDefined();
      // Untouched: byte-for-byte the raw pipeline's hitRate…
      expect(m.hitRate).toBe(r!.hitRate);
      // …and NOT the calibrated value for the same raw input. For raw > 0.5
      // the curve is strictly below the identity, so equality with the
      // calibrated value would prove the pass wrongly touched corners.
      if (r!.hitRate > 0.5) {
        expect(m.hitRate).not.toBe(calibrateAgainstBacktest(r!.hitRate));
      }
    }

    // Non-vacuous: at least one corners line sits in the region where the
    // "not calibrated" check above is discriminating.
    expect(corners.some((m) => (raw.get(m.id)?.hitRate ?? 0) > 0.5)).toBe(true);
  });

  it("C. is deterministic — two runs produce byte-identical corners markets", () => {
    const again = runEngineFromReal(fx, null);
    const cornersJson = (r: typeof result) =>
      JSON.stringify(r.markets.filter((m) => m.family === "Corners"));

    expect(cornersJson(again)).toBe(cornersJson(result));
    expect(again.markets.filter((m) => m.family === "Corners").length)
      .toBe(corners.length);
  });
});
