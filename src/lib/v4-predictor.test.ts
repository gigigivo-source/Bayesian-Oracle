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
} from "@/lib/engine/markets";
import {
  get1X2,
  getCorrectScores,
} from "@/app/api/v4-predictor/auto/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function modalScore(scores: import("@/lib/engine/markets").ScoreCell[], outcome: "H" | "D" | "A"): string {
  const cell = pickBestScoreForOutcome(scores, outcome)!;
  return `${cell.homeGoals}-${cell.awayGoals}`;
}

// ─── Client model ────────────────────────────────────────────────────────────

describe("v4-predictor presentation model", () => {
  it("projects route rows into table predictions without inventing scorelines", () => {
    const predictions = buildPredictions([
      { home: "Arsenal", away: "Coventry", prediction: "2-0", category: "MAX EP: 2-0", ep: 9.4 },
      { home: "Everton", away: "Fulham", prediction: "3-2", category: "MAX EP: 3-2", ep: 5.31 },
      { home: "Hull", away: "Leeds", enginePrediction: "0-2", category: "MAX EP: 0-2" },
      // No scoreline from the route — render as unresolved, never a static rule.
      { home: "Chelsea", away: "Spurs" },
      // Malformed scoreline is ignored.
      { home: "Brentford", away: "Everton", prediction: "two-one", category: "MAX EP: 2-1" },
    ]);
    expect(predictions).toEqual([
      { Match: "Arsenal vs Coventry", Category: "MAX EP: 2-0", Prediction: "2-0", Target_Pts: 9 },
      { Match: "Everton vs Fulham", Category: "MAX EP: 3-2", Prediction: "3-2", Target_Pts: 5 },
      { Match: "Hull vs Leeds", Category: "MAX EP: 0-2", Prediction: "0-2", Target_Pts: 20 },
      { Match: "Chelsea vs Spurs", Category: "", Prediction: "", Target_Pts: 0 },
      { Match: "Brentford vs Everton", Category: "MAX EP: 2-1", Prediction: "", Target_Pts: 0 },
    ]);
  });

  it("targets the 20-point full hit, scaled by the pick's Expected Points when known", () => {
    // No EP on the payload: the maximiser is aiming at the full exact-score 20.
    expect(targetPointsForPick(undefined)).toBe(20);
    expect(targetPointsForPick(null)).toBe(20);
    expect(targetPointsForPick(Number.NaN)).toBe(20);
    // The pick's own EP, rounded and capped at the 20-point maximum.
    expect(targetPointsForPick(9.383)).toBe(9);
    expect(targetPointsForPick(4.855)).toBe(5);
    expect(targetPointsForPick(0)).toBe(0);
    expect(targetPointsForPick(25)).toBe(20);
    // There is no FLOOR/CEILING input any more — the old category-based rule is gone.
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
      { home: "A", away: "B", prediction: "2-0", category: "MAX EP: 2-0" },
      { home: "C", away: "D", prediction: "1-1", category: "MAX EP: 1-1" },
      { home: "E", away: "F", prediction: "0-2", category: "MAX EP: 0-2" },
    ]);
    const [scored, total] = calculateScore(predictions, [[2, 0], [2, 2], [3, 1]]);
    expect(scored.map((row) => row.Points)).toEqual([20, 10, 0]);
    expect(total).toBe(30);
    expect(scored.map((row) => row.MissReason)).toEqual(["—", "❌ MISS: Wrong Score", "❌ MISS: Wrong Outcome"]);
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

// ─── Route integration ───────────────────────────────────────────────────────

describe("GET /api/v4-predictor/auto — Pure Points Maximiser route", () => {
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

      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.prediction).toMatch(/^\d{1,2}-\d{1,2}$/);
        expect(row.category).toBe(`SNIPE: ${row.prediction}`);
        expect(row.probabilities.home + row.probabilities.draw + row.probabilities.away).toBeCloseTo(1, 2);
      }
      expect(rows[0]).toMatchObject({ state: "post", actual: [2, 1] });
      expect(rows[1].blendedProbabilities.h).toBeCloseTo((rows[1].probabilities.home + 180 / 280) / 2, 3);
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
      expect(rows.every((r: { category: string }) => r.category.startsWith("SNIPE: "))).toBe(true);
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

describe("six-pillar slate", () => {
  it("selects three snipes, enables blowouts only on a strong slate, and protects low-data picks", async () => {
    const fixtures = Array.from({ length: 10 }, (_, i) => ({
      id: String(i), leagueSlug: "eng.1", matchweek: 11, date: `2026-11-${String(i + 1).padStart(2, "0")}T15:00:00Z`, state: "pre",
      odds: { homeML: i < 3 ? -250 : 150, drawML: 300, awayML: i < 3 ? 650 : 190 },
      home: { name: `Home ${i}`, score: null, logo: null }, away: { name: `Away ${i}`, score: null, logo: null },
    }));
    vi.resetModules();
    vi.doMock("@/lib/espn", () => ({ fetchScoreboard: vi.fn().mockResolvedValue(fixtures), fetchSummary: vi.fn().mockResolvedValue(null) }));
    vi.doMock("@/lib/engine/sofascore", () => ({ buildHistoricalTeamForm: vi.fn() }));
    vi.doMock("@/lib/engine", () => ({ runEngineFromRealWithProfiles: vi.fn(async (fx: typeof fixtures[number]) => {
      const index = Number(fx.id);
      const grid = buildCorrectScoreGrid(index < 3 ? 3 : 1.3, index < 3 ? 0.3 : 1.1, DIXON_COLES_RHO);
      return { match: { homeTeam: fx.home.name, awayTeam: fx.away.name, dataCompletenessScore: index === 0 ? 20 : 80 },
        lambdas: { "λ Home Goals": index < 3 ? 3 : 1.3, "λ Away Goals": index < 3 ? 0.3 : 1.1 }, scoreGrid: grid, markets: [] };
    }) }));
    try {
      const { GET } = await import("@/app/api/v4-predictor/auto/route");
      const data = await (await GET(new Request("http://localhost/api/v4-predictor/auto?week=11"))).json();
      expect(data.slateStrength).toBe("Strong");
      expect(data.favoriteCount).toBe(3);
      expect(data.fixtures.filter((r: { category: string }) => r.category.startsWith("SNIPE:"))).toHaveLength(3);
      expect(data.fixtures.filter((r: { category: string }) => r.category.startsWith("WINNER:"))).toHaveLength(7);
      expect(["1-0", "2-0"]).toContain(data.fixtures[0].prediction);
      for (const row of data.fixtures.slice(1, 3)) {
        expect(row.category).toMatch(/^SNIPE:/);
        expect(Number(row.prediction.split("-")[0])).toBeGreaterThanOrEqual(3);
        expect(row.lockedOutcome).toBe("H");
      }
      for (const row of data.fixtures.slice(3)) expect(getScorelineOutcome(row.prediction)).toBe(row.lockedOutcome);
    } finally {
      vi.doUnmock("@/lib/espn"); vi.doUnmock("@/lib/engine/sofascore"); vi.doUnmock("@/lib/engine"); vi.resetModules();
    }
  });
});
