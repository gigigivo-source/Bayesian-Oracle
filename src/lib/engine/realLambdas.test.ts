import { describe, expect, it } from "vitest";
import {
  buildRealLambdas,
  combineCornerMultipliers,
  MAX_COMBINED_CORNER_MULT,
  MAX_TOTAL_CORNERS,
} from "./realLambdas";
import { deriveFromGoals, getAnchors } from "./statisticalAnchors";
import { analyseFormationMismatch } from "./players";
import { clamp } from "./stats";
import type { FixtureLite, MatchSummary, TeamForm } from "../espn";

// Minimal FixtureLite — same shape the VA scanner passes to runEngineFromReal(fx, null).
function bundesligaFixture(overUnder: number): FixtureLite {
  const team = (side: "home" | "away", name: string) => ({
    id: `${side}-id`,
    name,
    shortName: name,
    abbrev: side === "home" ? "FCB" : "FCU",
    logo: null,
    color: null,
    score: null,
    homeAway: side,
  });

  return {
    id: "401",
    leagueSlug: "ger.1",
    leagueName: "Bundesliga",
    date: "2026-09-15T19:00:00Z",
    state: "pre",
    statusDetail: "Scheduled",
    venue: null,
    home: team("home", "Bayern Munich"),
    away: team("away", "1. FC Union Berlin"),
    neutralSite: false,
    odds: { overUnder },
  };
}

const total = (fx: FixtureLite) => {
  const { lam } = buildRealLambdas(fx, null, undefined);
  return lam.homeGoals + lam.awayGoals;
};

describe("buildRealLambdas — market O/U sanity guard", () => {
  it("A. rejects a 4.5 O/U line for a Bundesliga fixture (league anchor ~3.02) and keeps total goals near the anchor", () => {
    const anchor = getAnchors("ger.1").avgGoals;

    // ESPN reported overUnder 4.5 for Bayern Munich vs 1. FC Union Berlin — 1.63
    // goals above the league anchor. Blending it dragged total goals to ~4.0 and
    // manufactured a fake BTTS edge, so the line must be rejected.
    expect(Math.abs(4.5 + 0.15 - anchor)).toBeGreaterThan(1.0);

    const t = total(bundesligaFixture(4.5));

    expect(t).toBeGreaterThanOrEqual(2.5);
    expect(t).toBeLessThanOrEqual(3.5);
  });

  it("B. still applies a plausible 3.5 O/U line for a Bundesliga fixture", () => {
    const anchor = getAnchors("ger.1").avgGoals;

    expect(Math.abs(3.5 + 0.15 - anchor)).toBeLessThanOrEqual(1.0);

    const t = total(bundesligaFixture(3.5));

    expect(t).toBeGreaterThan(3.0);
  });
});

// ─── Combined corner-multiplier cap (1.15) + total corners λ cap (11.0) ─────

function engFixture(): FixtureLite {
  const team = (side: "home" | "away", name: string, abbrev: string) => ({
    id: `${side}-id`,
    name,
    shortName: name,
    abbrev,
    logo: null,
    color: null,
    score: null,
    homeAway: side,
  });
  return {
    id: "eng-1",
    leagueSlug: "eng.1",
    leagueName: "Premier League",
    date: "2026-09-20T15:00:00Z",
    state: "pre",
    statusDetail: "Scheduled",
    venue: null,
    home: team("home", "Arsenal", "ARS"),
    away: team("away", "Everton", "EVE"),
    neutralSite: false,
    odds: null,
  };
}

function teamForm(
  teamId: string,
  teamName: string,
  gfAvg: number,
  gaAvg: number,
  n = 3,
): TeamForm {
  return {
    teamId,
    teamName,
    games: Array.from({ length: n }, () => ({
      date: "2026-09-01",
      opponent: "Opp",
      opponentLogo: null,
      result: "D",
      scoreFor: 1,
      scoreAgainst: 1,
      atVs: "vs",
      competition: "League",
    })),
    gfAvg,
    gaAvg,
    points: n,
  };
}

function summaryWith(
  homeForm: TeamForm | null,
  awayForm: TeamForm | null,
  homeFormation: string | null,
  awayFormation: string | null,
  extra?: Record<string, unknown>,
): MatchSummary {
  return {
    odds: null,
    homeForm,
    awayForm,
    h2h: [],
    homeLineup: [],
    awayLineup: [],
    lineupAvailable: false,
    homeFormation,
    awayFormation,
    venue: null,
    boxscore: null,
    ...extra,
  } as unknown as MatchSummary;
}

/** Form-derived homeShare — same formula buildRealLambdas uses (no market/H2H). */
function formHomeShare(
  hf: TeamForm,
  af: TeamForm,
  avgGoals: number,
  homeAdv = 1.08,
): number {
  const homeExp = ((hf.gfAvg * af.gaAvg) / avgGoals) * homeAdv;
  const awayExp = (af.gfAvg * hf.gaAvg) / avgGoals;
  const formTotal = clamp(homeExp + awayExp, 0.5, 7.0);
  return clamp(homeExp / formTotal, 0.2, 0.8);
}

describe("buildRealLambdas — combined corner-multiplier cap at 1.15", () => {
  it("1. tactical 1.12 × formation 1.15 × wing 1.05 (=1.353) is clamped to 1.15", () => {
    expect(MAX_COMBINED_CORNER_MULT).toBe(1.15);
    expect(1.12 * 1.15 * 1.05).toBeCloseTo(1.3524, 4);
    expect(combineCornerMultipliers(1.12, 1.15, 1.05)).toBe(1.15);

    // Fixture that produces the triple-stack: attacking-vs-defensive form
    // (tactical 1.12) + 4-3-3-vs-5-3-2 mismatch (formation 1.15, wing 1.05).
    const fmm = analyseFormationMismatch("4-3-3", "5-3-2");
    expect(fmm.cornerMultiplier).toBeCloseTo(1.15 * 1.05, 10);

    const fx = engFixture();
    const sum = summaryWith(
      teamForm("h", "Arsenal", 2.4, 0.8, 3),
      teamForm("a", "Everton", 1.0, 0.8, 3),
      "4-3-3",
      "5-3-2",
    );
    const { lam, notes } = buildRealLambdas(fx, sum, undefined);

    // The mult-cap note fires with the decomposed product.
    expect(notes.some((n) => n.startsWith("CORNERS MULT CAP"))).toBe(true);

    // Effective multiplier = lam total / pre-multiplier derive total.
    const anchors = getAnchors("eng.1");
    const homeShare = formHomeShare(sum.homeForm!, sum.awayForm!, anchors.avgGoals);
    const lamGoals = lam.homeGoals + lam.awayGoals;
    const pre = deriveFromGoals(lamGoals, homeShare, anchors);
    const preTotal = pre.homeCorners + pre.awayCorners;
    const lamTotal = lam.homeCorners + lam.awayCorners;

    // Total-cap must not interfere with the measurement.
    expect(lamTotal).toBeLessThan(MAX_TOTAL_CORNERS);
    expect(notes.some((n) => n.startsWith("CORNERS CAP:"))).toBe(false);

    const effective = lamTotal / preTotal;
    expect(effective).toBeCloseTo(1.15, 6);
    expect(effective).not.toBeCloseTo(1.12 * 1.15 * 1.05, 2);
  });

  it("2. product 1.05 (below the cap) passes through unchanged", () => {
    expect(combineCornerMultipliers(1.05, 1.0, 1.0)).toBeCloseTo(1.05, 10);
    expect(combineCornerMultipliers(1.0, 1.0, 1.05)).toBeCloseTo(1.05, 10);

    // Both-open form (tactical 1.05) + neutral 4-4-2-vs-4-4-2 (1.0 × 1.0).
    const fmm = analyseFormationMismatch("4-4-2", "4-4-2");
    expect(fmm.cornerMultiplier).toBe(1.0);

    const fx = engFixture();
    const sum = summaryWith(
      teamForm("h", "Arsenal", 1.5, 1.5, 3),
      teamForm("a", "Everton", 1.5, 1.5, 3),
      "4-4-2",
      "4-4-2",
    );
    const { lam, notes } = buildRealLambdas(fx, sum, undefined);

    expect(notes.some((n) => n.startsWith("CORNERS MULT CAP"))).toBe(false);

    const anchors = getAnchors("eng.1");
    const homeShare = formHomeShare(sum.homeForm!, sum.awayForm!, anchors.avgGoals);
    const lamGoals = lam.homeGoals + lam.awayGoals;
    const pre = deriveFromGoals(lamGoals, homeShare, anchors);
    const effective =
      (lam.homeCorners + lam.awayCorners) / (pre.homeCorners + pre.awayCorners);
    expect(effective).toBeCloseTo(1.05, 6);
  });
});

describe("buildRealLambdas — total corners λ cap at 11.0", () => {
  it("3. high-xG fixture that would exceed 11.0 before the cap returns exactly 11.0", () => {
    expect(MAX_TOTAL_CORNERS).toBe(11.0);

    const fx = engFixture();
    const sum = summaryWith(null, null, null, null, {
      __homeXg: 3.5,
      __awayXg: 3.0,
      __homeXgSource: "bzzoiro-match",
    });
    const { lam, notes } = buildRealLambdas(fx, sum, undefined);

    // Pre-cap total is above the ceiling (anchor 10.2 + 0.6/goals + no mult).
    const anchors = getAnchors("eng.1");
    const lamGoals = lam.homeGoals + lam.awayGoals;
    const pre = deriveFromGoals(lamGoals, anchors.homePossession, anchors);
    expect(pre.homeCorners + pre.awayCorners).toBeGreaterThan(11.0);

    expect(lam.homeCorners + lam.awayCorners).toBeCloseTo(11.0, 10);
    expect(notes.some((n) => n.startsWith("CORNERS CAP:"))).toBe(true);
  });

  it("4. low-xG fixture below 11.0 is left unchanged (cap does not fire)", () => {
    const fx = engFixture();
    const sum = summaryWith(null, null, null, null, {
      __homeXg: 0.8,
      __awayXg: 0.7,
      __homeXgSource: "bzzoiro-match",
    });
    const { lam, notes } = buildRealLambdas(fx, sum, undefined);

    const lamTotal = lam.homeCorners + lam.awayCorners;
    expect(lamTotal).toBeLessThan(11.0);
    expect(notes.some((n) => n.startsWith("CORNERS CAP:"))).toBe(false);

    // Unchanged = lam total equals the pre-cap derive total (combined mult 1.0).
    const anchors = getAnchors("eng.1");
    const lamGoals = lam.homeGoals + lam.awayGoals;
    const pre = deriveFromGoals(lamGoals, anchors.homePossession, anchors);
    expect(lamTotal).toBeCloseTo(pre.homeCorners + pre.awayCorners, 10);
  });
});
