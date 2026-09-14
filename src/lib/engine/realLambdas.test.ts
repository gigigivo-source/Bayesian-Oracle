import { describe, expect, it } from "vitest";
import { buildRealLambdas } from "./realLambdas";
import { getAnchors } from "./statisticalAnchors";
import type { FixtureLite } from "../espn";

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
