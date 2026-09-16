// Engine assembly tests — the scanner path emits RAW model probabilities.
//
// assemble() must NOT apply calibrateAgainstBacktest to any market. The
// backtest calibration curve was fitted against the /api/match pipeline,
// which fetches the ESPN summary and therefore produces different raw
// probabilities; applying it to the scanner path (runEngineFromReal(fx, null),
// anchor-only lambdas) over-shrinks by 6–13 points. The scanner path stays
// raw until the curve is refitted against this baseline.
//
// These tests are the guard against silently re-introducing the pass: they
// pin every Goals-family market — the family the reverted loop targeted — to
// byte-for-byte equality with the raw Poisson pipeline, and additionally
// assert the value is NOT the calibrated one wherever the curve would move
// it (raw > 0.5). calibration.ts and calibration.test.ts are untouched; the
// function stays exported for the refit.
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

/** The raw (uncalibrated) market pipeline for a fixture, paired by id. */
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

/**
 * The calibration curve is the identity for raw ≤ 0.50 and strictly below it
 * above, so raw > 0.5 is the region where "equals raw" and "equals
 * calibrated" are mutually exclusive — i.e. where the negative assertions
 * below actually discriminate.
 */
const CURVE_MOVES = (raw: number) => raw > 0.5;

describe("assemble() — scanner path emits raw probabilities (no backtest calibration)", () => {
  const fx     = espn1Fixture();
  const result = runEngineFromReal(fx, null);
  const raw    = rawPipeline(fx);

  const goals   = result.markets.filter((m) => m.family === "Goals");
  const corners = result.markets.filter((m) => m.family === "Corners");

  it("A. leaves every Goals-family market exactly as the raw pipeline produced it", () => {
    expect(goals.length).toBeGreaterThan(0);

    for (const m of goals) {
      const r = raw.get(m.id);
      expect(r, `raw counterpart for ${m.id} (${m.name})`).toBeDefined();
      // Untouched: byte-for-byte the raw pipeline's hitRate…
      expect(m.hitRate).toBe(r!.hitRate);
      // …and NOT the calibrated value wherever the curve would move it. If
      // the calibration pass came back, this is the assertion that catches
      // it: above 0.5 the curve is strictly below the identity, so equality
      // with the calibrated value could not be a coincidence.
      if (CURVE_MOVES(r!.hitRate)) {
        expect(m.hitRate).not.toBe(calibrateAgainstBacktest(r!.hitRate));
      }
    }

    // Non-vacuous: at least one goals line sits in the region where the
    // "not calibrated" check above is discriminating.
    const aboveHalf = goals.filter((m) => CURVE_MOVES(raw.get(m.id)?.hitRate ?? 0));
    expect(aboveHalf.length).toBeGreaterThan(0);
  });

  it("B. leaves Corners-family markets exactly as the raw pipeline produced them", () => {
    expect(corners.length).toBeGreaterThan(0);

    for (const m of corners) {
      const r = raw.get(m.id);
      expect(r, `raw counterpart for ${m.id} (${m.name})`).toBeDefined();
      expect(m.hitRate).toBe(r!.hitRate);
      if (CURVE_MOVES(r!.hitRate)) {
        expect(m.hitRate).not.toBe(calibrateAgainstBacktest(r!.hitRate));
      }
    }

    // Non-vacuous: at least one corners line sits in the discriminating region.
    expect(corners.some((m) => CURVE_MOVES(raw.get(m.id)?.hitRate ?? 0))).toBe(true);
  });

  it("C. applies no calibration to ANY market family", () => {
    expect(result.markets.length).toBeGreaterThan(0);

    const drifted: string[] = [];
    for (const m of result.markets) {
      const r = raw.get(m.id);
      expect(r, `raw counterpart for ${m.id} (${m.name})`).toBeDefined();
      if (m.hitRate !== r!.hitRate) drifted.push(`${m.id} (${m.family}): ${r!.hitRate} → ${m.hitRate}`);
    }
    expect(drifted, "markets whose hitRate differs from the raw pipeline").toEqual([]);
  });

  it("D. is deterministic — two runs produce byte-identical corners markets", () => {
    const again = runEngineFromReal(fx, null);
    const cornersJson = (r: typeof result) =>
      JSON.stringify(r.markets.filter((m) => m.family === "Corners"));

    expect(cornersJson(again)).toBe(cornersJson(result));
    expect(again.markets.filter((m) => m.family === "Corners").length)
      .toBe(corners.length);
  });
});
