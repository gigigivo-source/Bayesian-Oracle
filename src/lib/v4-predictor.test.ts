import { describe, expect, it, vi } from "vitest";
import {
  buildPredictions,
  calculateScore,
  getScorelineOutcome,
  isScoreline,
  targetPointsForCategory,
} from "@/lib/v4-predictor";
import {
  buildCorrectScoreGrid,
  DIXON_COLES_RHO,
  pickBestScoreForOutcome,
  type ScoreCell,
} from "@/lib/engine/markets";
import {
  CEILING_SIZE,
  FLOOR_SIZE,
  TOSS_UP_DRAW_FLOOR,
  TOSS_UP_GAP_CEILING,
  get1X2,
  getCorrectScores,
  trancheSlate,
  type TranchePrediction,
} from "@/app/api/v4-predictor/auto/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Deterministic prediction bundle straight from the engine's own grid. */
function priced(
  homeLambda: number,
  awayLambda: number,
  overrides: Partial<{ h: number; d: number; a: number }> = {},
): TranchePrediction {
  const grid = buildCorrectScoreGrid(homeLambda, awayLambda, DIXON_COLES_RHO);
  return {
    probs: { h: overrides.h ?? grid.outcome.home, d: overrides.d ?? grid.outcome.draw, a: overrides.a ?? grid.outcome.away },
    scores: grid.cells,
  };
}

function modalScore(scores: ScoreCell[], outcome: "H" | "D" | "A"): string {
  const cell = pickBestScoreForOutcome(scores, outcome)!;
  return `${cell.homeGoals}-${cell.awayGoals}`;
}

/** Ten fixture slate: 8 strong favourites, one toss-up, one lopsided draw. */
function tenFixtureSlate(): TranchePrediction[] {
  return [
    priced(2.4, 0.5),  // 0 — huge home favourite
    priced(2.0, 0.7),  // 1 — strong home favourite
    priced(0.5, 2.3),  // 2 — strong away favourite
    priced(1.8, 0.8),  // 3 — home favourite
    priced(0.7, 1.9),  // 4 — away favourite
    priced(1.7, 0.9),  // 5 — home favourite
    priced(1.6, 0.9),  // 6 — home favourite
    priced(0.9, 1.6),  // 7 — away favourite
    priced(1.0, 1.0),  // 8 — coin-flip toss-up (P(Draw) ≈ 0.34)
    priced(1.0, 1.0),  // 9 — second coin-flip toss-up
  ];
}

// ─── Client model ────────────────────────────────────────────────────────────

describe("v4-predictor presentation model", () => {
  it("projects route rows into table predictions without inventing scorelines", () => {
    const predictions = buildPredictions([
      { home: "Arsenal", away: "Coventry", prediction: "2-0", category: "FLOOR: Home Win" },
      { home: "Everton", away: "Fulham", prediction: "1-1", category: "CEILING: Draw Snipe" },
      { home: "Hull", away: "Leeds", enginePrediction: "0-2", category: "FLOOR: Away Win" },
      // No scoreline from the route — render as unresolved, never a static rule.
      { home: "Chelsea", away: "Spurs" },
      // Malformed scoreline is ignored.
      { home: "Brentford", away: "Everton", prediction: "two-one", category: "FLOOR: Home Win" },
    ]);
    expect(predictions).toEqual([
      { Match: "Arsenal vs Coventry", Category: "FLOOR: Home Win", Prediction: "2-0", Target_Pts: 10 },
      { Match: "Everton vs Fulham", Category: "CEILING: Draw Snipe", Prediction: "1-1", Target_Pts: 20 },
      { Match: "Hull vs Leeds", Category: "FLOOR: Away Win", Prediction: "0-2", Target_Pts: 10 },
      { Match: "Chelsea vs Spurs", Category: "", Prediction: "", Target_Pts: 0 },
      { Match: "Brentford vs Everton", Category: "FLOOR: Home Win", Prediction: "", Target_Pts: 0 },
    ]);
  });

  it("targets 20 points for a ceiling snipe and 10 for a floor pick", () => {
    expect(targetPointsForCategory("CEILING: Draw Snipe")).toBe(20);
    expect(targetPointsForCategory("ceiling: draw snipe")).toBe(20);
    expect(targetPointsForCategory("FLOOR: Home Win")).toBe(10);
    expect(targetPointsForCategory("FLOOR: Away Win")).toBe(10);
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
      { home: "A", away: "B", prediction: "2-0", category: "FLOOR: Home Win" },
      { home: "C", away: "D", prediction: "1-1", category: "CEILING: Draw Snipe" },
      { home: "E", away: "F", prediction: "0-2", category: "FLOOR: Away Win" },
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

// ─── Portfolio tranching ─────────────────────────────────────────────────────

describe("trancheSlate — Portfolio Tranching", () => {
  it("splits a 10 fixture slate into 8 floor + 2 ceiling picks", () => {
    const results = trancheSlate(tenFixtureSlate());
    expect(results).toHaveLength(10);
    expect(FLOOR_SIZE).toBe(8);
    expect(CEILING_SIZE).toBe(2);
    expect(results.filter((r) => r.tranche === "FLOOR")).toHaveLength(8);
    expect(results.filter((r) => r.tranche === "CEILING")).toHaveLength(2);
    expect(results.filter((r) => r.category === "CEILING: Draw Snipe")).toHaveLength(2);
    expect(results.filter((r) => r.category.startsWith("FLOOR: "))).toHaveLength(8);
  });

  it("orders by the favourite's confidence and floors the eight safest", () => {
    const slate = tenFixtureSlate();
    const results = trancheSlate(slate);
    const confidence = (i: number) => Math.max(slate[i].probs.h, slate[i].probs.a);
    const floorIndexes = results.filter((r) => r.tranche === "FLOOR").map((r) => r.index);
    const ceilingIndexes = results.filter((r) => r.tranche === "CEILING").map((r) => r.index);
    const minFloor = Math.min(...floorIndexes.map(confidence));
    const maxCeiling = Math.max(...ceilingIndexes.map(confidence));
    expect(minFloor).toBeGreaterThanOrEqual(maxCeiling);
  });

  it("pick the modal scoreline inside the favourite's outcome for floor picks", () => {
    const slate = tenFixtureSlate();
    const results = trancheSlate(slate);
    for (const row of results.filter((r) => r.tranche === "FLOOR")) {
      const pred = slate[row.index];
      const outcome = pred.probs.h > pred.probs.a ? "H" : "A";
      expect(row.outcome).toBe(outcome);
      expect(row.category).toBe(`FLOOR: ${outcome === "H" ? "Home" : "Away"} Win`);
      expect(row.prediction).toBe(modalScore(pred.scores, outcome));
      expect(getScorelineOutcome(row.prediction)).toBe(outcome);
    }
  });

  it("snipes the draw only for a true toss-up (P(Draw) ≥ 0.29 and |H − A| < 8%)", () => {
    const results = trancheSlate(tenFixtureSlate());
    const ceiling = results.filter((r) => r.tranche === "CEILING");
    expect(ceiling).toHaveLength(2);
    for (const row of ceiling) {
      const pred = tenFixtureSlate()[row.index];
      expect(pred.probs.d).toBeGreaterThanOrEqual(TOSS_UP_DRAW_FLOOR);
      expect(Math.abs(pred.probs.h - pred.probs.a)).toBeLessThan(TOSS_UP_GAP_CEILING);
      expect(row.category).toBe("CEILING: Draw Snipe");
      expect(getScorelineOutcome(row.prediction)).toBe("D");
      expect(row.prediction).toBe(modalScore(pred.scores, "D"));
      expect(row.probability).toBeGreaterThan(0);
    }
    // A coin flip at λ = 1.0 / 1.0 prices 0-0 as the modal draw.
    expect(ceiling.map((r) => r.prediction).sort()).toEqual(["0-0", "0-0"]);
  });

  it("falls back to the favourite when the bottom of the slate is not a toss-up", () => {
    const slate = tenFixtureSlate();
    // Replace the two toss-ups with lopsided matches: high draw chance is gone.
    slate[8] = priced(2.2, 0.6, { h: 0.7, d: 0.2, a: 0.1 });
    slate[9] = priced(0.6, 2.2, { h: 0.1, d: 0.2, a: 0.7 });
    const results = trancheSlate(slate);
    expect(results.every((r) => r.tranche === "FLOOR")).toBe(true);
    expect(results.every((r) => r.category.startsWith("FLOOR: "))).toBe(true);
    expect(results.filter((r) => r.category === "CEILING: Draw Snipe")).toHaveLength(0);
  });

  it("treats a draw-heavy but one-sided match as a floor pick", () => {
    const slate = tenFixtureSlate();
    // P(Draw) clears the 0.29 bar but |H − A| = 12% > 8% → not a toss-up.
    slate[8] = { probs: { h: 0.44, d: 0.30, a: 0.26 }, scores: priced(1.6, 1.0).scores };
    slate[9] = { probs: { h: 0.44, d: 0.30, a: 0.26 }, scores: priced(1.6, 1.0).scores };
    const results = trancheSlate(slate);
    expect(results.filter((r) => r.category === "CEILING: Draw Snipe")).toHaveLength(0);
    expect(results.filter((r) => r.tranche === "CEILING")).toHaveLength(0);
  });

  it("handles short slates: everything floors when there is no ceiling to spend", () => {
    for (const size of [0, 1, 3, 7]) {
      const slate = tenFixtureSlate().slice(0, size);
      const results = trancheSlate(slate);
      expect(results).toHaveLength(size);
      expect(results.every((r) => r.tranche === "FLOOR")).toBe(true);
    }
  });

  it("spends a single ceiling pick when only the least confident match is a toss-up", () => {
    const slate = tenFixtureSlate();
    slate[8] = { probs: { h: 0.55, d: 0.20, a: 0.25 }, scores: priced(2.0, 0.9).scores };
    const results = trancheSlate(slate);
    expect(results.filter((r) => r.tranche === "CEILING")).toHaveLength(1);
    expect(results.filter((r) => r.tranche === "FLOOR")).toHaveLength(9);
    const ceiling = results.find((r) => r.tranche === "CEILING")!;
    expect(ceiling.index).toBe(9);
    expect(ceiling.category).toBe("CEILING: Draw Snipe");
    expect(ceiling.prediction).toBe("0-0");
  });

  it("uses both ceiling picks for an 8 fixture slate whose bottom two are toss-ups", () => {
    const slate = tenFixtureSlate().slice(0, 8);
    slate[6] = priced(1.0, 1.0);
    slate[7] = priced(1.0, 1.0);
    const results = trancheSlate(slate);
    expect(results.filter((r) => r.tranche === "CEILING")).toHaveLength(2);
    expect(results.filter((r) => r.tranche === "FLOOR")).toHaveLength(6);
  });

  it("widens the floor to 9 when a 10-slate toss-up is not a true draw", () => {
    const slate = tenFixtureSlate();
    slate[8] = { probs: { h: 0.55, d: 0.20, a: 0.25 }, scores: priced(2.0, 0.9).scores };
    const results = trancheSlate(slate);
    // The 9th most confident match is still floored; the 10th is the ceiling.
    expect(results.filter((r) => r.tranche === "FLOOR")).toHaveLength(9);
    expect(results.filter((r) => r.tranche === "CEILING")).toHaveLength(1);
  });

  it("returns one prediction per fixture, indexed back to the original order", () => {
    const results = trancheSlate(tenFixtureSlate());
    expect(results.map((r) => r.index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(results.every((r) => /^\d{1,2}-\d{1,2}$/.test(r.prediction))).toBe(true);
  });
});

// ─── Route integration ───────────────────────────────────────────────────────

describe("GET /api/v4-predictor/auto — Portfolio Tranching route", () => {
  it("runs the Engine on every fixture, keeps odds for pre-match and strips them for finished games", async () => {
    // Two upcoming fixtures (with bookmaker odds) and one finished fixture
    // whose summary carries a closing line — which must NOT reach the Engine.
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

      // The Engine ran on all three fixtures — no Snipe bypass any more.
      expect(runEngineMock).toHaveBeenCalledTimes(3);
      expect(fetchSummaryMock).toHaveBeenCalledTimes(3);

      type EngineCall = [
        { id: string; odds?: unknown },
        { odds?: unknown } | null,
      ];
      const calls = runEngineMock.mock.calls as unknown as EngineCall[];
      const byId = new Map(calls.map(([fx, summary]) => [fx.id, { fx, summary }]));

      // Pre-match: odds survive on both the fixture and the summary.
      const preOne = byId.get("pre-1")!;
      expect(preOne.fx.odds).toMatchObject({ homeML: -180 });
      expect(preOne.summary?.odds).toMatchObject({ homeML: -180 });

      const preTwo = byId.get("pre-2")!;
      // No odds on the fixture itself, but the summary still carries the line.
      expect(preTwo.fx.odds).toMatchObject({ homeML: -180 });
      expect(preTwo.summary?.odds).toMatchObject({ homeML: -180 });

      // Finished: the closing line is stripped everywhere.
      const post = byId.get("post-1")!;
      expect(post.fx.odds).toBeNull();
      expect(post.summary?.odds).toBeNull();

      // Portfolio tranching: every row carries a tranche label + scoreline.
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.prediction).toMatch(/^\d{1,2}-\d{1,2}$/);
        expect(["FLOOR", "CEILING"]).toContain(row.tranche);
        expect(row.category).toMatch(/^(FLOOR|CEILING): /);
        expect(row.probabilities.home + row.probabilities.draw + row.probabilities.away).toBeCloseTo(1, 2);
      }
      // 3 fixtures < the 8-strong floor: everything is a safe floor pick.
      expect(rows.every((r: { tranche: string }) => r.tranche === "FLOOR")).toBe(true);
      // Rows stay in kick-off order: the finished game sorts first.
      expect(rows[0]).toMatchObject({ state: "post", actual: [2, 1] });
      // Arsenal (2.2 vs 0.6) is the biggest favourite: modal Home win is 2-0.
      expect(rows[1]).toMatchObject({ category: "FLOOR: Home Win", prediction: "2-0", actual: null });
    } finally {
      vi.doUnmock("@/lib/espn");
      vi.doUnmock("@/lib/engine/sofascore");
      vi.doUnmock("@/lib/engine");
      vi.resetModules();
    }
  });

  it("still scores finished fixtures and drops predictions when the Engine cannot load", async () => {
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
      // Model-only pricing (1.35 / 1.15): the modal Home win is 1-0.
      expect(rows.map((r: { prediction: string; category: string }) => [r.category, r.prediction])).toEqual([
        ["FLOOR: Home Win", "1-0"],
        ["FLOOR: Home Win", "1-0"],
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
