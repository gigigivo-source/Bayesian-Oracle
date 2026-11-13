import { describe, expect, it } from "vitest";
import { buildCorrectScoreGrid, DIXON_COLES_RHO, type ScoreCell } from "./markets";
import {
  DRAW_GUARD_THRESHOLD, V4_SYSTEMS, consensusPick, expectedPointsDrawGuardPick,
  generateV2Predictions, pureEnginePick, pureExpectedPointsPick, scoreV4Prediction,
  selectV4Slate, v4ScoreOutcome, type V4PriceBundle,
} from "./v4-strategies";
import { chooseWinner, footballTeamKey, markdownTable, matchKey, parseFootballCsv, summarise } from "../../../scripts/backtest-v4";

function bundle(home = 1.35, away = 1.15, probs?: V4PriceBundle["probs"]): V4PriceBundle {
  const grid = buildCorrectScoreGrid(home, away, DIXON_COLES_RHO);
  return { probs: probs ?? { h: grid.outcome.home, d: grid.outcome.draw, a: grid.outcome.away }, scores: grid.cells };
}
function cell(scores: ScoreCell[], prediction: string): ScoreCell {
  const [h, a] = prediction.split("-").map(Number);
  return scores.find((c) => c.homeGoals === h && c.awayGoals === a)!;
}

describe("V4 shared system selectors", () => {
  it("Pure EP maximises outcome bonus plus exact probability", () => {
    const priced = bundle(1.7, 1.1);
    const pick = pureExpectedPointsPick(priced);
    for (const c of priced.scores) {
      const ep = 10 * (c.homeGoals > c.awayGoals ? priced.probs.h : c.homeGoals === c.awayGoals ? priced.probs.d : priced.probs.a) + 10 * c.probability;
      expect(pick.ep + 1e-12).toBeGreaterThanOrEqual(ep);
    }
    expect(pick.ep).toBeCloseTo(10 * pick.outcomeProbability + 10 * pick.exactProbability, 12);
  });

  it("Pure Engine takes the modal exact score, not the highest-EP score", () => {
    const priced = bundle(1.7, 1.1);
    const pick = pureEnginePick(priced);
    expect(pick.exactProbability).toBe(Math.max(...priced.scores.map((c) => c.probability)));
    expect(pick.prediction).not.toBe(pureExpectedPointsPick(priced).prediction);
  });

  it("Consensus keeps the V2 outcome and takes the modal score inside it", () => {
    const priced = bundle(0.6, 2.0);
    const [v2] = generateV2Predictions([{ home: "Newcastle", away: "Burnley" }]);
    expect(v2.prediction).toBe("2-1"); // Mid vs Bottom: home outcome.
    const pick = consensusPick(priced, v2);
    expect(pick.outcome).toBe("H");
    expect(pick.v2Category).toBe("LOCK: Mid vs Bottom");
    const homeCells = priced.scores.filter((c) => c.homeGoals > c.awayGoals);
    expect(pick.exactProbability).toBe(Math.max(...homeCells.map((c) => c.probability)));
  });

  it("Draw Guard is strict at 45% and re-prices the forced 1-1", () => {
    const priced = bundle(1.3, 1.3, { h: 0.45, d: 0.3, a: 0.25 });
    expect(expectedPointsDrawGuardPick(priced).prediction).toBe(pureExpectedPointsPick(priced).prediction);
    const guarded = expectedPointsDrawGuardPick({ ...priced, probs: { h: 0.449, d: 0.3, a: 0.251 } });
    expect(guarded.prediction).toBe("1-1");
    expect(guarded.category).toBe("DRAW GUARD: 1-1");
    expect(guarded.ep).toBeCloseTo(10 * 0.3 + 10 * cell(priced.scores, "1-1").probability, 12);
    expect(DRAW_GUARD_THRESHOLD).toBe(0.45);
  });

  it("preserves V2 chaos bans and slate-wide snipe quotas", () => {
    const fixtures = [
      { home: "Arsenal", away: "Hull" },
      { home: "Liverpool", away: "Coventry" },
      { home: "Fulham", away: "Brentford" },
      { home: "Everton", away: "Leeds" },
      { home: "Crystal Palace", away: "Newcastle" },
      { home: "Chelsea", away: "Ipswich" },
      { home: "Aston Villa", away: "Brighton" },
      { home: "Sunderland", away: "Man City" },
    ];
    const v2 = generateV2Predictions(fixtures);
    expect(v2.map((p) => p.category)).toEqual([
      "SNIPE: Home Fortress",
      "LOCK: Smart Top 4 Home",
      "SNIPE: Mid-Table Deadlock",
      "SNIPE: Mid-Table Deadlock",
      "LOCK: Standard Home",
      "LOCK: Chaos Rule",
      "LOCK: Elite Away (Exhausted)",
      "LOCK: Elite Away (Exhausted)",
    ]);
    expect(v2.filter((p) => p.targetPts === 20)).toHaveLength(3);
    expect(v2[5].prediction).toBe("2-1"); // Chaos home is never a snipe.
  });

  it("V2 Hybrid preserves only the requested 2-0/1-1 snipes; consensus preserves all V2 outcomes", () => {
    const fixtures = [{ home: "Arsenal", away: "Hull" }, { home: "Fulham", away: "Brentford" }, { home: "Sunderland", away: "Brighton" }];
    const bundles = [bundle(2.2, 0.6), bundle(1.0, 1.0), bundle(0.6, 2.0)];
    const hybrid = selectV4Slate("v2-hybrid", fixtures, bundles);
    expect(hybrid[0]).toMatchObject({ prediction: "2-0", category: "SNIPE: Home Fortress" });
    expect(hybrid[1]).toMatchObject({ prediction: "1-1", category: "SNIPE: Mid-Table Deadlock" });
    expect(hybrid[2].category).toMatch(/^HYBRID:/); // Elite Away 0-1 is Engine-priced.
    const consensus = selectV4Slate("consensus", fixtures, bundles);
    expect(consensus[2].outcome).toBe("A");
    expect(consensus[2].v2Prediction).toBe("0-1");
    expect(() => selectV4Slate("pure-ep", fixtures, bundles.slice(1))).toThrow(/align/);
  });

  it("scores only 20 / 10 / 0 and exposes all five systems", () => {
    expect(scoreV4Prediction("2-0", [2, 0])).toBe(20);
    expect(scoreV4Prediction("2-0", [3, 1])).toBe(10);
    expect(scoreV4Prediction("2-0", [1, 1])).toBe(0);
    expect(() => scoreV4Prediction("bad", [0, 0])).toThrow();
    expect(v4ScoreOutcome(0, 1)).toBe("A");
    expect(V4_SYSTEMS.map((s) => s.id)).toEqual(["pure-ep", "v2-hybrid", "consensus", "pure-engine", "ep-draw-guard"]);
  });
});

describe("V4 backtest data and reporting", () => {
  const csv = "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,AvgH,AvgD,AvgA\nE0,21/08/2026,20:00,Arsenal,Coventry,3,0,1.2,7,13\n";

  it("normalises cross-source club names and parses real CSV rows", () => {
    expect(footballTeamKey("Manchester United FC")).toBe(footballTeamKey("Man United"));
    expect(footballTeamKey("Tottenham Hotspur FC")).toBe(footballTeamKey("Tottenham"));
    expect(matchKey("Arsenal FC", "Coventry City FC")).toBe(matchKey("Arsenal", "Coventry"));
    const [row] = parseFootballCsv(csv);
    expect(row).toMatchObject({ day: "2026-08-21", homeGoals: 3, awayGoals: 0 });
    expect(() => parseFootballCsv(csv.replace(",3,0,", ",,0,"))).toThrow(/final score/);
    expect(() => parseFootballCsv(csv + csv.split("\n")[1])).toThrow(/Duplicate/);
  });

  it("summarises ten complete weeks and chooses floor before average", () => {
    const results = V4_SYSTEMS.flatMap((system) => Array.from({ length: 100 }, (_, i) => ({
      system: system.id, week: Math.floor(i / 10) + 1,
      points: system.id === "consensus" ? 10 : system.id === "ep-draw-guard" ? (i < 10 ? 0 : 20) : 0,
    })));
    const summaries = summarise(results);
    const winner = chooseWinner(summaries);
    expect(winner.id).toBe("consensus"); // floor 100 beats draw-guard floor 0 despite lower average.
    expect(winner).toMatchObject({ average: 100, floor: 100, hundredPlus: 10 });
    expect(markdownTable(summaries)).toContain("| System | MW1 |");
    expect(markdownTable(summaries)).toContain("| Consensus Override |");
    expect(() => summarise(results.slice(1))).toThrow(/expected 100/);
  });
});
