import { describe, expect, it, vi } from "vitest";
import * as client from "@/lib/v4-predictor";
import {
  buildPredictions,
  calculateScore,
  getScorelineOutcome,
  isScoreline,
  targetPointsForPick,
} from "@/lib/v4-predictor";
import {
  buildCorrectScoreGrid,
  DIXON_COLES_RHO,
  pickBestScoreForOutcome,
  type ScoreCell,
} from "@/lib/engine/markets";
import {
  systemAKellyPick,
  systemBBucketPick,
  systemCBayesianBlendPick,
  systemDDrawFirstPick,
  systemEWeightedEpPick,
} from "@/lib/v4-tournament";
import {
  formatScore,
  get1X2,
  getCorrectScores,
  weightedExpectedPointsPick,
  type OneX2,
} from "@/app/api/v4-predictor/auto/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Deterministic prediction bundle straight from the engine's own grid. */
function priced(
  homeLambda: number,
  awayLambda: number,
  overrides: Partial<OneX2> = {},
): { probs: OneX2; scores: ScoreCell[] } {
  const grid = buildCorrectScoreGrid(homeLambda, awayLambda, DIXON_COLES_RHO);
  return {
    probs: {
      h: overrides.h ?? grid.outcome.home,
      d: overrides.d ?? grid.outcome.draw,
      a: overrides.a ?? grid.outcome.away,
    },
    scores: grid.cells,
  };
}

/** Recompute Weighted EP by hand: (10 * P(Outcome)) + (15 * P(Exact)). */
function weightedEpOf(scores: ScoreCell[], probs: OneX2, score: string): number {
  const [h, a] = score.split("-").map(Number);
  const cell = scores.find((c) => c.homeGoals === h && c.awayGoals === a)!;
  const outcomeProb = h > a ? probs.h : h === a ? probs.d : probs.a;
  return 10 * outcomeProb + 15 * cell.probability;
}

function modalScore(scores: ScoreCell[], outcome: "H" | "D" | "A"): string {
  const cell = pickBestScoreForOutcome(scores, outcome)!;
  return `${cell.homeGoals}-${cell.awayGoals}`;
}

// ─── Client model ────────────────────────────────────────────────────────────

describe("v4-predictor presentation model", () => {
  it("projects route rows into table predictions without inventing scorelines", () => {
    const predictions = buildPredictions([
      { home: "Arsenal", away: "Coventry", prediction: "2-0", category: "WEIGHTED EP: 2-0", ep: 9.4 },
      { home: "Everton", away: "Fulham", prediction: "3-2", category: "WEIGHTED EP: 3-2", ep: 5.31 },
      { home: "Hull", away: "Leeds", enginePrediction: "0-2", category: "WEIGHTED EP: 0-2" },
      // No scoreline from the route — render as unresolved, never a static rule.
      { home: "Chelsea", away: "Spurs" },
      // Malformed scoreline is ignored.
      { home: "Brentford", away: "Everton", prediction: "two-one", category: "WEIGHTED EP: 2-1" },
    ]);
    expect(predictions).toEqual([
      { Match: "Arsenal vs Coventry", Category: "WEIGHTED EP: 2-0", Prediction: "2-0", Target_Pts: 9 },
      { Match: "Everton vs Fulham", Category: "WEIGHTED EP: 3-2", Prediction: "3-2", Target_Pts: 5 },
      { Match: "Hull vs Leeds", Category: "WEIGHTED EP: 0-2", Prediction: "0-2", Target_Pts: 20 },
      { Match: "Chelsea vs Spurs", Category: "", Prediction: "", Target_Pts: 0 },
      { Match: "Brentford vs Everton", Category: "WEIGHTED EP: 2-1", Prediction: "", Target_Pts: 0 },
    ]);
  });

  it("targets the 20-point full hit, scaled by the pick's Expected Points when known", () => {
    expect(targetPointsForPick(undefined)).toBe(20);
    expect(targetPointsForPick(null)).toBe(20);
    expect(targetPointsForPick(Number.NaN)).toBe(20);
    expect(targetPointsForPick(9.383)).toBe(9);
    expect(targetPointsForPick(4.855)).toBe(5);
    expect(targetPointsForPick(0)).toBe(0);
    expect(targetPointsForPick(25)).toBe(20);
    expect("targetPointsForCategory" in client).toBe(false);
  });

  it("validates scorelines and outcomes strictly", () => {
    expect(isScoreline("2-1")).toBe(true);
    expect(isScoreline("10-0")).toBe(true);
    expect(isScoreline("2-")).toBe(false);
    expect(isScoreline("2-1-0")).toBe(false);
    expect(isScoreline(undefined)).toBe(false);
    expect(isScoreline(21)).toBe(false);
    expect(["3-1", "0-0", "1-2", "10-9"].map(getScorelineOutcome)).toEqual(["H", "D", "A", "H"]);
  });

  it("scores exact, outcome and missed predictions", () => {
    const predictions = buildPredictions([
      { home: "A", away: "B", prediction: "2-0", category: "WEIGHTED EP: 2-0" },
      { home: "C", away: "D", prediction: "1-1", category: "WEIGHTED EP: 1-1" },
      { home: "E", away: "F", prediction: "0-2", category: "WEIGHTED EP: 0-2" },
    ]);
    const [scored, total] = calculateScore(predictions, [[2, 0], [2, 2], [3, 1]]);
    expect(scored.map((row) => row.Points)).toEqual([20, 10, 0]);
    expect(total).toBe(30);
  });
});

// ─── Engine reads ────────────────────────────────────────────────────────────

describe("get1X2 / getCorrectScores", () => {
  it("reads the Engine's Dixon–Coles corrected 1X2 markets", () => {
    const engineResult = {
      match: { homeTeam: "Arsenal", awayTeam: "Chelsea", dataCompletenessScore: 80 },
      lambdas: { "λ Home Goals": 1.7, "λ Away Goals": 1.1 },
      markets: [
        { name: "Match Result: Arsenal Win", selection: "Arsenal Win", hitRate: 0.5 },
        { name: "Match Result: Draw", selection: "Draw", hitRate: 0.28 },
        { name: "Match Result: Chelsea Win", selection: "Chelsea Win", hitRate: 0.22 },
      ],
    } as unknown as Parameters<typeof get1X2>[0];

    const probs = get1X2(engineResult, { homeGoals: 1.35, awayGoals: 1.15 });
    expect(probs.h).toBeCloseTo(0.5, 6);
    expect(probs.d).toBeCloseTo(0.28, 6);
    expect(probs.a).toBeCloseTo(0.22, 6);

    const scores = getCorrectScores(engineResult, { homeGoals: 1.35, awayGoals: 1.15 });
    const expected = buildCorrectScoreGrid(1.7, 1.1, DIXON_COLES_RHO);
    expect(scores).toHaveLength(expected.cells.length);
    expect(modalScore(scores, "H")).toBe(modalScore(expected.cells, "H"));
  });

  it("falls back to the Engine lambdas when the 1X2 family is absent", () => {
    const engineResult = {
      match: { homeTeam: "Arsenal", awayTeam: "Chelsea", dataCompletenessScore: 70 },
      lambdas: { "λ Home Goals": 2.0, "λ Away Goals": 0.8 },
      markets: [],
    } as unknown as Parameters<typeof get1X2>[0];
    const probs = get1X2(engineResult, { homeGoals: 1.35, awayGoals: 1.15 });
    const grid = buildCorrectScoreGrid(2.0, 0.8, DIXON_COLES_RHO);
    expect(probs.h).toBeCloseTo(grid.outcome.home, 10);
    expect(probs.h + probs.d + probs.a).toBeCloseTo(1, 10);
  });

  it("uses the published Correct Score markets when the Engine prices them", () => {
    const engineResult = {
      match: { homeTeam: "Arsenal", awayTeam: "Chelsea", dataCompletenessScore: 70 },
      lambdas: { "λ Home Goals": 1.4, "λ Away Goals": 1.2 },
      markets: [
        { name: "Correct Score 1-1", selection: "Score 1-1", hitRate: 0.19 },
        { name: "Correct Score 2-1", selection: "Score 2-1", hitRate: 0.12 },
      ],
    } as unknown as Parameters<typeof getCorrectScores>[0];
    const scores = getCorrectScores(engineResult, { homeGoals: 1.35, awayGoals: 1.15 });
    const oneOne = scores.find((c) => c.homeGoals === 1 && c.awayGoals === 1)!;
    const twoOne = scores.find((c) => c.homeGoals === 2 && c.awayGoals === 1)!;
    expect(oneOne.probability).toBe(0.19);
    expect(twoOne.probability).toBe(0.12);
  });
});

// ─── Five V4 Tournament Systems ──────────────────────────────────────────────

describe("V4 Tournament 5-System Suite", () => {
  it("System A (Kelly Criterion Maximizer) computes Value = 20*P - 10*(1-P)", () => {
    const bundle = priced(2.4, 0.5);
    const pick = systemAKellyPick(bundle);
    expect(pick.category).toBe(`KELLY: ${pick.prediction}`);
    expect(pick.metric).toBeCloseTo(
      pick.exactProbability * 20 - (1 - pick.exactProbability) * 10,
      10,
    );
  });

  it("System B (Goal-Bucket Specialist) routes low, medium, and high-scoring grids to their candidate sets", () => {
    const low = systemBBucketPick(priced(0.45, 0.35));
    expect(["0-0", "1-0", "0-1"]).toContain(low.prediction);
    expect(low.category).toBe(`BUCKET: ${low.prediction}`);

    const mid = systemBBucketPick(priced(1.4, 1.1));
    expect(["1-1", "2-1", "1-2", "2-0", "0-2"]).toContain(mid.prediction);

    const high = systemBBucketPick(priced(2.6, 2.1));
    expect(["2-2", "3-1", "1-3", "3-2", "2-3"]).toContain(high.prediction);
  });

  it("System C (Bayesian Prior Blend) blends prior-season team rates with last-5 EPL form", () => {
    const pick = systemCBayesianBlendPick({
      homePrior: {
        avgGoalsScoredHome: 2.2,
        avgGoalsConcededHome: 0.8,
        avgGoalsScoredAway: 1.8,
        avgGoalsConcededAway: 1.0,
      },
      awayPrior: null, // promoted club shrinkage baseline
      leagueAvgHomeGoals: 1.55,
      leagueAvgAwayGoals: 1.30,
      homeLast5: {
        teamId: "arsenal",
        teamName: "Arsenal",
        games: [
          { date: "2026-09-01", opponent: "Chelsea", opponentLogo: null, result: "W", scoreFor: 3, scoreAgainst: 0, atVs: "vs", competition: "Premier League" },
          { date: "2026-09-08", opponent: "Spurs", opponentLogo: null, result: "W", scoreFor: 2, scoreAgainst: 1, atVs: "@", competition: "Premier League" },
        ],
        gfAvg: 2.5,
        gaAvg: 0.5,
        points: 6,
      },
      awayLast5: null,
    });
    expect(pick.category).toBe(`BAYES: ${pick.prediction}`);
    expect(pick.outcome).toBe("H");
  });

  it("System D (Draw-First Value Hunter) picks 1-1/0-0 when P(Draw) >= 0.28 and decisive wins otherwise", () => {
    const drawHeavy = systemDDrawFirstPick(priced(1.1, 1.1));
    expect(drawHeavy.category).toBe(`DRAW HUNTER: ${drawHeavy.prediction}`);
    expect(["1-1", "0-0"]).toContain(drawHeavy.prediction);

    const clearFav = systemDDrawFirstPick(priced(2.4, 0.5));
    expect(clearFav.outcome).toBe("H");
    expect(clearFav.prediction).not.toBe("1-1");
  });

  it("System E (Expected Points Champion — Weighted) maximizes 10*P(Outcome) + 15*P(Exact)", () => {
    const bundle = priced(1.7, 1.1);
    const pick = systemEWeightedEpPick(bundle);
    expect(pick.category).toBe(`WEIGHTED EP: ${pick.prediction}`);
    expect(pick.ep).toBeCloseTo(10 * pick.outcomeProbability + 15 * pick.exactProbability, 10);
  });
});

// ─── Winning System: Expected Points Champion (Weighted) ─────────────────────

describe("weightedExpectedPointsPick — Tournament Winner", () => {
  it("publishes the highest weighted-EP scoreline from the 0-0 … 8-8 grid", () => {
    for (const [home, away] of [[2.4, 0.5], [1.7, 1.1], [1.35, 1.15], [1.0, 1.0], [0.6, 2.0], [3.2, 2.8]]) {
      const bundle = priced(home, away);
      const pick = weightedExpectedPointsPick(bundle);
      expect(pick.category).toBe(`WEIGHTED EP: ${pick.prediction}`);
      expect(pick.ep).toBeGreaterThan(0);
      expect(pick.ep).toBeCloseTo(weightedEpOf(bundle.scores, bundle.probs, pick.prediction), 10);
      expect(pick.ep).toBeCloseTo(10 * pick.outcomeProbability + 15 * pick.exactProbability, 10);
      for (const cell of bundle.scores) {
        const cellEp = weightedEpOf(bundle.scores, bundle.probs, `${cell.homeGoals}-${cell.awayGoals}`);
        expect(cellEp).toBeLessThanOrEqual(pick.ep + 1e-12);
      }
    }
  });

  it("beats passive 1-1 defaults whenever a favourite has outcome + exact equity", () => {
    const bundle = priced(1.7, 1.1);
    const pick = weightedExpectedPointsPick(bundle);
    expect(pick.prediction).toBe("2-1");
    expect(pick.outcome).toBe("H");
    expect(pick.exactProbability).toBeLessThan(1);
  });

  it("picks the draw in a genuine coin flip and high-scoring lines in open games", () => {
    expect(weightedExpectedPointsPick(priced(1.0, 1.0)).prediction).toBe("0-0");
    expect(weightedExpectedPointsPick(priced(1.3, 1.3)).prediction).toBe("1-1");
    expect(weightedExpectedPointsPick(priced(3.2, 2.8)).prediction).toBe("3-2");
    expect(weightedExpectedPointsPick(priced(2.8, 2.4)).prediction).toBe("3-2");
  });

  it("honours bookmaker-anchored probabilities over the raw grid", () => {
    const bundle = priced(1.2, 1.2, { h: 0.55, d: 0.25, a: 0.20 });
    const pick = weightedExpectedPointsPick(bundle);
    expect(pick.outcome).toBe("H");
    expect(getScorelineOutcome(pick.prediction)).toBe("H");

    const awayFav = weightedExpectedPointsPick(priced(1.2, 1.2, { h: 0.20, d: 0.25, a: 0.55 }));
    expect(awayFav.outcome).toBe("A");
  });

  it("falls back to 1-1 only for a degenerate (empty) grid", () => {
    const pick = weightedExpectedPointsPick({ probs: { h: 0.4, d: 0.3, a: 0.3 }, scores: [] });
    expect(pick).toMatchObject({ prediction: "1-1", category: "WEIGHTED EP: 1-1", outcome: "D", ep: 0 });
  });

  it("formats scorelines the way the dashboard renders them", () => {
    expect(formatScore(3, 1)).toBe("3-1");
    expect(formatScore(0, 0)).toBe("0-0");
  });
});

// ─── Route integration ───────────────────────────────────────────────────────

describe("GET /api/v4-predictor/auto — Expected Points Champion (Weighted) route", () => {
  it("runs the Engine on every fixture, keeps odds for pre-match and strips them for finished games", async () => {
    const fixtures = [
      {
        id: "pre-1",
        leagueSlug: "eng.1",
        matchweek: 8,
        date: "2026-10-24T15:00:00Z",
        state: "pre" as const,
        odds: { homeML: -180, drawML: 320, awayML: 520, provider: "ESPN BET" },
        home: { name: "Arsenal FC", score: null, logo: null },
        away: { name: "Coventry City FC", score: null, logo: null },
      },
      {
        id: "pre-2",
        leagueSlug: "eng.1",
        matchweek: 8,
        date: "2026-10-24T17:30:00Z",
        state: "pre" as const,
        odds: null,
        home: { name: "Everton FC", score: null, logo: null },
        away: { name: "Fulham FC", score: null, logo: null },
      },
      {
        id: "post-1",
        leagueSlug: "eng.1",
        matchweek: 8,
        date: "2026-10-20T15:00:00Z",
        state: "post" as const,
        odds: { homeML: -140, drawML: 280, awayML: 400, provider: "ESPN BET" },
        home: { name: "Chelsea FC", score: "2", logo: null },
        away: { name: "Tottenham Hotspur FC", score: "1", logo: null },
      },
    ];

    const fetchSummaryMock = vi.fn(async (_slug: string, id: string) =>
      id === "post-1"
        ? { venue: "Stamford Bridge", odds: { homeML: -140, drawML: 280, awayML: 400 } }
        : { venue: "Emirates", odds: { homeML: -180, drawML: 320, awayML: 520 } },
    );
    const runEngineMock = vi.fn(async (fx: { home: { name: string }; away: { name: string } }) => {
      const homeGoals = fx.home.name === "Arsenal FC" ? 2.2 : fx.home.name === "Everton FC" ? 1.0 : 1.6;
      const awayGoals = fx.home.name === "Arsenal FC" ? 0.6 : fx.home.name === "Everton FC" ? 1.0 : 1.1;
      const grid = buildCorrectScoreGrid(homeGoals, awayGoals, DIXON_COLES_RHO);
      return {
        match: { homeTeam: fx.home.name, awayTeam: fx.away.name, dataCompletenessScore: 80 },
        lambdas: { "λ Home Goals": homeGoals, "λ Away Goals": awayGoals },
        markets: [
          { family: "Goals", name: `Match Result: ${fx.home.name} Win`, selection: `${fx.home.name} Win`, hitRate: grid.outcome.home },
          { family: "Goals", name: "Match Result: Draw", selection: "Draw", hitRate: grid.outcome.draw },
          { family: "Goals", name: `Match Result: ${fx.away.name} Win`, selection: `${fx.away.name} Win`, hitRate: grid.outcome.away },
        ],
      };
    });

    vi.resetModules();
    vi.doMock("@/lib/espn", () => ({
      fetchScoreboard: vi.fn().mockResolvedValue(fixtures),
      getCurrentMatchweek: vi.fn().mockResolvedValue(8),
      fetchSummary: fetchSummaryMock,
    }));
    vi.doMock("@/lib/engine/sofascore", () => ({
      buildHistoricalTeamForm: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("@/lib/engine", () => ({ runEngineFromRealWithProfiles: runEngineMock }));

    try {
      const { GET } = await import("@/app/api/v4-predictor/auto/route");
      const response = await GET(new Request("http://localhost/api/v4-predictor/auto?week=8"));
      expect(response.status).toBe(200);
      const { fixtures: rows } = await response.json();

      expect(runEngineMock).toHaveBeenCalledTimes(3);
      expect(fetchSummaryMock).toHaveBeenCalledTimes(3);

      type EngineCall = [
        { id: string; odds?: unknown },
        { odds?: unknown } | null,
      ];
      const calls = runEngineMock.mock.calls as unknown as EngineCall[];
      const byId = new Map(calls.map(([fx, summary]) => [fx.id, { fx, summary }]));

      const preOne = byId.get("pre-1")!;
      expect(preOne.fx.odds).toMatchObject({ homeML: -180 });
      expect(preOne.summary?.odds).toMatchObject({ homeML: -180 });

      const preTwo = byId.get("pre-2")!;
      expect(preTwo.fx.odds).toMatchObject({ homeML: -180 });
      expect(preTwo.summary?.odds).toMatchObject({ homeML: -180 });

      const post = byId.get("post-1")!;
      expect(post.fx.odds).toBeNull();
      expect(post.summary?.odds).toBeNull();

      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.prediction).toMatch(/^\d{1,2}-\d{1,2}$/);
        expect(row.category).toBe(`WEIGHTED EP: ${row.prediction}`);
        expect(row).not.toHaveProperty("tranche");
        expect(row.ep).toBeGreaterThan(0);
        expect(row.probabilities.home + row.probabilities.draw + row.probabilities.away).toBeCloseTo(1, 2);
      }
      expect(rows[0]).toMatchObject({ state: "post", actual: [2, 1] });
      expect(rows[1]).toMatchObject({ category: "WEIGHTED EP: 2-0", prediction: "2-0", actual: null });
    } finally {
      vi.doUnmock("@/lib/espn");
      vi.doUnmock("@/lib/engine/sofascore");
      vi.doUnmock("@/lib/engine");
      vi.resetModules();
    }
  });

  it("still scores finished fixtures and prices predictions when the Engine cannot load", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fixtures = [
      {
        id: "a",
        leagueSlug: "eng.1",
        matchweek: 9,
        date: "2026-10-31T15:00:00Z",
        state: "post" as const,
        home: { name: "Chelsea FC", score: "1", logo: null },
        away: { name: "Tottenham Hotspur FC", score: "1", logo: null },
      },
      {
        id: "b",
        leagueSlug: "eng.1",
        matchweek: 9,
        date: "2026-11-01T15:00:00Z",
        state: "pre" as const,
        home: { name: "Everton FC", score: null, logo: null },
        away: { name: "Fulham FC", score: null, logo: null },
      },
    ];

    vi.resetModules();
    vi.doMock("@/lib/espn", () => ({
      fetchScoreboard: vi.fn().mockResolvedValue(fixtures),
      fetchSummary: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("@/lib/engine/sofascore", () => ({
      buildHistoricalTeamForm: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("@/lib/engine", () => {
      throw new Error("no DATABASE_URL");
    });

    try {
      const { GET } = await import("@/app/api/v4-predictor/auto/route");
      const response = await GET(new Request("http://localhost/api/v4-predictor/auto?week=9"));
      expect(response.status).toBe(200);
      const { fixtures: rows } = await response.json();
      expect(rows.map((r: { prediction: string; category: string }) => [r.category, r.prediction])).toEqual([
        ["WEIGHTED EP: 1-0", "1-0"],
        ["WEIGHTED EP: 1-0", "1-0"],
      ]);
      expect(rows[0].actual).toEqual([1, 1]);
      expect(rows[1].actual).toBeNull();
    } finally {
      errSpy.mockRestore();
      vi.doUnmock("@/lib/espn");
      vi.doUnmock("@/lib/engine/sofascore");
      vi.doUnmock("@/lib/engine");
      vi.resetModules();
    }
  });
});
