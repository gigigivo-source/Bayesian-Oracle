import { describe, expect, it, vi } from "vitest";
import {
  calculateScore,
  generatePredictions,
  getV2Outcome,
  isScoreline,
} from "@/lib/v4-predictor";

describe("generatePredictions: 3-Layer Hybrid System", () => {
  it("Layer 1 (Snipes): keeps exact V2 Snipe scores untouched even when enginePrediction is supplied", () => {
    const [fortress, deadlock, eliteAway] = generatePredictions([
      { home: "Arsenal", away: "Coventry", enginePrediction: "3-1" }, // Home Fortress -> 2-0
      { home: "Fulham", away: "Leeds", enginePrediction: "0-0" }, // Mid-Table Deadlock -> 1-1
      { home: "Everton", away: "Liverpool", enginePrediction: "2-2" }, // Elite Away -> 0-1
    ]);
    expect(fortress).toMatchObject({ Category: "SNIPE: Home Fortress", Prediction: "2-0", Target_Pts: 20 });
    expect(deadlock).toMatchObject({ Category: "SNIPE: Mid-Table Deadlock", Prediction: "1-1", Target_Pts: 20 });
    expect(eliteAway).toMatchObject({ Category: "SNIPE: Elite Away", Prediction: "0-1", Target_Pts: 20 });
  });

  it("Layer 2 (Engine Winner-First): uses enginePrediction for non-Snipes regardless of V2 outcome", () => {
    const predictions = generatePredictions([
      { home: "Chelsea", away: "Spurs", enginePrediction: "2-1" }, // V2 Chaos vs Chaos is 1-1; Engine says 2-1
      { home: "Spurs", away: "Aston Villa", enginePrediction: "0-2" }, // V2 Chaos Home is 2-1; Engine says 0-2
      { home: "Man City", away: "Brentford", enginePrediction: "1-1" }, // V2 Top4 Home is 2-0; Engine says 1-1
      { home: "Wolves", away: "Hull", enginePrediction: "3-1" }, // Standard Lock
    ]);
    expect(predictions.map((p) => [p.Category, p.Prediction, p.Target_Pts])).toEqual([
      ["ENGINE: Winner-First", "2-1", 10],
      ["ENGINE: Winner-First", "0-2", 10],
      ["ENGINE: Winner-First", "1-1", 10],
      ["ENGINE: Winner-First", "3-1", 10],
    ]);
  });

  it("Layer 3 (Safety Net): falls back to V2 Lock hierarchy when engine score is missing or malformed", () => {
    const predictions = generatePredictions([
      { home: "Wolves", away: "Hull" },
      { home: "Wolves", away: "Hull", enginePrediction: null },
      { home: "Wolves", away: "Hull", enginePrediction: "" },
      { home: "Wolves", away: "Hull", enginePrediction: "two-one" },
    ]);
    expect(predictions.map((p) => [p.Category, p.Prediction])).toEqual([
      ["LOCK: Standard vs Bottom", "1-0"],
      ["LOCK: Standard vs Bottom", "1-0"],
      ["LOCK: Standard vs Bottom", "1-0"],
      ["LOCK: Standard vs Bottom", "1-0"],
    ]);
  });

  it("validates scorelines and outcomes strictly", () => {
    expect(isScoreline("2-1")).toBe(true);
    expect(isScoreline("10-0")).toBe(true);
    expect(isScoreline("2-")).toBe(false);
    expect(isScoreline("2-1-0")).toBe(false);
    expect(isScoreline(undefined)).toBe(false);
    expect(isScoreline(21)).toBe(false);
    expect(["3-1", "0-0", "1-2", "10-9"].map(getV2Outcome)).toEqual(["H", "D", "A", "H"]);
  });
});

describe("3-Layer Hybrid route (/api/v4-predictor/auto)", () => {
  it("skips Engine for Snipes, applies Winner-First 1X2+CS filter when completeness >= 50, and falls back when completeness < 50 or Engine fails", async () => {
    const teams: Array<[string, string]> = [
      ["Arsenal FC", "Coventry City FC"], // 0: SNIPE: Home Fortress (2-0) -> skip engine
      ["Fulham FC", "Leeds United FC"], // 1: SNIPE: Mid-Table Deadlock (1-1) -> skip engine
      ["Hull City AFC", "Liverpool FC"], // 2: SNIPE: Elite Away (0-1) -> skip engine
      ["Chelsea FC", "Tottenham Hotspur FC"], // 3: Non-Snipe -> Engine Home Win -> 2-1 (even though CS 1-1 has higher raw hitRate!)
      ["Tottenham Hotspur FC", "Aston Villa FC"], // 4: Non-Snipe -> Engine Away Win -> 0-2
      ["Manchester City FC", "Brentford FC"], // 5: Non-Snipe -> completeness 42 (< 50) -> fallback V2 2-0
      ["Wolverhampton Wanderers FC", "Hull City AFC"], // 6: Non-Snipe -> Engine throws -> fallback V2 1-0
    ];
    const fixtures = teams.map(([home, away], i) => ({
      id: `fx-${i}`,
      leagueSlug: "eng.1",
      matchweek: 8,
      date: `2026-10-${String(20 + i).padStart(2, "0")}T15:00:00Z`,
      state: "post" as const,
      home: { name: home, score: "2", logo: null },
      away: { name: away, score: "1", logo: null },
    }));

    const fetchSummaryMock = vi.fn().mockResolvedValue(null);
    const runEngineMock = vi.fn(async (fx: { id: string; home: { name: string }; away: { name: string } }) => {
      if (fx.id === "fx-3") {
        // Chelsea vs Spurs: 1-1 has highest raw CS hitRate (0.14), but Chelsea Win is top 1X2 (0.51),
        // so Winner-First MUST pick 2-1 (0.11) over 1-1 (0.14) and 1-0 (0.09).
        return {
          match: { homeTeam: fx.home.name, awayTeam: fx.away.name, dataCompletenessScore: 85 },
          markets: [
            { family: "Goals", name: `Match Result: ${fx.home.name} Win`, selection: `${fx.home.name} Win`, hitRate: 0.51 },
            { family: "Goals", name: "Match Result: Draw", selection: "Draw", hitRate: 0.24 },
            { family: "Goals", name: `Match Result: ${fx.away.name} Win`, selection: `${fx.away.name} Win`, hitRate: 0.25 },
            { family: "Goals", name: "Correct Score 1-1", hitRate: 0.14 },
            { family: "Goals", name: "Correct Score 2-1", hitRate: 0.11 },
            { family: "Goals", name: "Correct Score 1-0", hitRate: 0.09 },
            { family: "Goals", name: "Correct Score 0-2", hitRate: 0.06 },
          ],
        };
      }
      if (fx.id === "fx-4") {
        // Spurs vs Aston Villa: Away Win is top 1X2 (0.48) -> picks 0-2 (0.12) over 0-1 (0.10) and 1-1 (0.15)
        return {
          match: { homeTeam: fx.home.name, awayTeam: fx.away.name, dataCompletenessScore: 78 },
          markets: [
            { family: "Goals", name: `Match Result: ${fx.home.name} Win`, selection: `${fx.home.name} Win`, hitRate: 0.26 },
            { family: "Goals", name: "Match Result: Draw", selection: "Draw", hitRate: 0.26 },
            { family: "Goals", name: `Match Result: ${fx.away.name} Win`, selection: `${fx.away.name} Win`, hitRate: 0.48 },
            { family: "Goals", name: "Correct Score 1-1", hitRate: 0.15 },
            { family: "Goals", name: "Correct Score 0-2", hitRate: 0.12 },
            { family: "Goals", name: "Correct Score 0-1", hitRate: 0.10 },
          ],
        };
      }
      if (fx.id === "fx-5") {
        // Completeness < 50 -> must fall back to V2 Lock
        return {
          match: { homeTeam: fx.home.name, awayTeam: fx.away.name, dataCompletenessScore: 42 },
          markets: [
            { family: "Goals", name: "Match Result: Draw", selection: "Draw", hitRate: 0.6 },
            { family: "Goals", name: "Correct Score 0-0", hitRate: 0.3 },
          ],
        };
      }
      throw new Error("Engine unavailable");
    });

    vi.doMock("@/lib/espn", () => ({
      fetchScoreboard: vi.fn().mockResolvedValue([...fixtures].reverse()),
      fetchSummary: fetchSummaryMock,
    }));
    vi.doMock("@/lib/engine", () => ({
      runEngineFromRealWithProfiles: runEngineMock,
    }));

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { GET } = await import("@/app/api/v4-predictor/auto/route");
      const response = await GET(new Request("http://localhost/api/v4-predictor/auto?week=8"));
      expect(response.status).toBe(200);
      const { fixtures: rows } = await response.json();

      // Engine must NOT have been called for the 3 Snipe matches (fx-0, fx-1, fx-2)
      const calledIds = runEngineMock.mock.calls.map(([fx]) => fx.id).sort();
      expect(calledIds).toEqual(["fx-3", "fx-4", "fx-5", "fx-6"]);

      expect(rows.map((r: { category: string; prediction: string; enginePrediction: string | null }) => [
        r.category,
        r.prediction,
        r.enginePrediction,
      ])).toEqual([
        ["SNIPE: Home Fortress", "2-0", null],
        ["SNIPE: Mid-Table Deadlock", "1-1", null],
        ["SNIPE: Elite Away", "0-1", null],
        ["ENGINE: Winner-First", "2-1", "2-1"],
        ["ENGINE: Winner-First", "0-2", "0-2"],
        ["LOCK: Smart Top 4 Home", "2-0", null],
        ["LOCK: Standard vs Bottom", "1-0", null],
      ]);
    } finally {
      errSpy.mockRestore();
      vi.doUnmock("@/lib/espn");
      vi.doUnmock("@/lib/engine");
      vi.resetModules();
    }
  });

  it("falls back to V2 rules on Matchweek 1 due to low early-season data and scores 70+", async () => {
    const mw1: Array<[string, string, [number, number]]> = [
      ["Arsenal FC", "Coventry City FC", [3, 0]],
      ["Hull City AFC", "Manchester United FC", [2, 0]],
      ["Ipswich Town FC", "Sunderland AFC", [2, 1]],
      ["Nottingham Forest FC", "Leeds United FC", [0, 1]],
      ["Everton FC", "Crystal Palace FC", [2, 0]],
      ["Brentford FC", "Tottenham Hotspur FC", [3, 0]],
      ["Manchester City FC", "AFC Bournemouth", [2, 1]],
      ["Brighton & Hove Albion FC", "Aston Villa FC", [4, 0]],
      ["Newcastle United FC", "Liverpool FC", [2, 2]],
      ["Fulham FC", "Chelsea FC", [2, 3]],
    ];
    const fixtures = mw1.map(([home, away, [hs, as]], i) => ({
      id: `mw1-${i}`,
      leagueSlug: "eng.1",
      matchweek: 1,
      date: `2026-08-${String(21 + Math.floor(i / 4)).padStart(2, "0")}T${String(12 + i).padStart(2, "0")}:00:00Z`,
      state: "post" as const,
      home: { name: home, score: String(hs), logo: null },
      away: { name: away, score: String(as), logo: null },
    }));

    vi.doMock("@/lib/espn", () => ({
      fetchScoreboard: vi.fn().mockResolvedValue(fixtures),
      fetchSummary: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("@/lib/engine", () => ({
      runEngineFromRealWithProfiles: vi.fn(async (fx: { home: { name: string }; away: { name: string } }) => ({
        match: { homeTeam: fx.home.name, awayTeam: fx.away.name, dataCompletenessScore: 85 },
        markets: [
          { family: "Goals", name: `Match Result: ${fx.home.name} Win`, hitRate: 0.6 },
          { family: "Goals", name: "Correct Score 3-0", hitRate: 0.2 },
        ],
      })),
    }));

    try {
      const { GET } = await import("@/app/api/v4-predictor/auto/route");
      const response = await GET(new Request("http://localhost/api/v4-predictor/auto?week=1"));
      expect(response.status).toBe(200);
      const { fixtures: rows } = await response.json();

      expect(rows.every((r: { category: string }) => !r.category.startsWith("ENGINE:"))).toBe(true);
      const preds = generatePredictions(
        rows.map((r: { home: { name: string }; away: { name: string }; enginePrediction: string | null; prediction: string; category: string }) => ({
          home: r.home.name,
          away: r.away.name,
          enginePrediction: r.enginePrediction,
          prediction: r.prediction,
          category: r.category,
        })),
      );
      const [, total] = calculateScore(preds, rows.map((r: { actual: [number, number] }) => r.actual));
      expect(total).toBeGreaterThanOrEqual(70);
    } finally {
      vi.doUnmock("@/lib/espn");
      vi.doUnmock("@/lib/engine");
      vi.resetModules();
    }
  });

  it("integrates end-to-end with real MarketEngine + buildRealLambdas outputs on Matchweek 8", async () => {
    vi.doMock("@/db", () => ({ db: {}, pool: {}, keepDbAlive: async () => {} }));
    const { runEngineFromReal } = await import("@/lib/engine/engine");

    const makeForm = (teamId: string, teamName: string, gf: number, ga: number, count = 5) => ({
      teamId,
      teamName,
      games: Array.from({ length: count }, (_, idx) => ({
        date: `2026-10-0${idx + 1}T15:00:00Z`,
        opponent: "Opponent",
        opponentLogo: null,
        result: gf > ga ? "W" : gf === ga ? "D" : "L",
        scoreFor: gf,
        scoreAgainst: ga,
        atVs: "vs",
        competition: "Premier League",
      })),
      gfAvg: gf,
      gaAvg: ga,
      points: count * (gf > ga ? 3 : 1),
    });

    const mw8Fixtures = [
      {
        id: "ars-cov",
        leagueSlug: "eng.1",
        leagueName: "Premier League",
        date: "2026-10-24T12:30:00Z",
        state: "post" as const,
        statusDetail: "FT",
        venue: "Emirates Stadium",
        neutralSite: false,
        matchweek: 8,
        home: { id: "ars", name: "Arsenal FC", shortName: "Arsenal", abbrev: "ARS", logo: null, color: null, score: "2", homeAway: "home" as const },
        away: { id: "cov", name: "Coventry City FC", shortName: "Coventry", abbrev: "COV", logo: null, color: null, score: "0", homeAway: "away" as const },
      },
      {
        id: "che-tot",
        leagueSlug: "eng.1",
        leagueName: "Premier League",
        date: "2026-10-24T15:00:00Z",
        state: "post" as const,
        statusDetail: "FT",
        venue: "Stamford Bridge",
        neutralSite: false,
        matchweek: 8,
        home: { id: "che", name: "Chelsea FC", shortName: "Chelsea", abbrev: "CHE", logo: null, color: null, score: "2", homeAway: "home" as const },
        away: { id: "tot", name: "Tottenham Hotspur FC", shortName: "Spurs", abbrev: "TOT", logo: null, color: null, score: "1", homeAway: "away" as const },
      },
      {
        id: "hul-che",
        leagueSlug: "eng.1",
        leagueName: "Premier League",
        date: "2026-10-24T17:30:00Z",
        state: "post" as const,
        statusDetail: "FT",
        venue: "MKM Stadium",
        neutralSite: false,
        matchweek: 8,
        home: { id: "hul", name: "Hull City AFC", shortName: "Hull", abbrev: "HUL", logo: null, color: null, score: "0", homeAway: "home" as const },
        away: { id: "spu", name: "Tottenham Hotspur FC", shortName: "Spurs", abbrev: "TOT", logo: null, color: null, score: "2", homeAway: "away" as const },
      },
    ];

    vi.doMock("@/lib/espn", () => ({
      fetchScoreboard: vi.fn().mockResolvedValue(mw8Fixtures),
      fetchSummary: vi.fn(async (_slug: string, id: string) => {
        if (id === "che-tot") {
          return {
            odds: null,
            homeForm: makeForm("che", "Chelsea FC", 2.2, 1.0, 5),
            awayForm: makeForm("tot", "Tottenham Hotspur FC", 1.2, 1.6, 5),
            h2h: [],
            homeLineup: [],
            awayLineup: [],
            lineupAvailable: false,
            homeFormation: null,
            awayFormation: null,
            venue: "Stamford Bridge",
            boxscore: null,
          };
        }
        return {
          odds: null,
          homeForm: makeForm("hul", "Hull City AFC", 0.6, 2.2, 5),
          awayForm: makeForm("spu", "Tottenham Hotspur FC", 2.4, 0.8, 5),
          h2h: [],
          homeLineup: [],
          awayLineup: [],
          lineupAvailable: false,
          homeFormation: null,
          awayFormation: null,
          venue: "MKM Stadium",
          boxscore: null,
        };
      }),
    }));
    vi.doMock("@/lib/engine", () => ({
      runEngineFromRealWithProfiles: vi.fn(async (fx, sum) => runEngineFromReal(fx, sum)),
    }));

    try {
      const { GET } = await import("@/app/api/v4-predictor/auto/route");
      const response = await GET(new Request("http://localhost/api/v4-predictor/auto?week=8"));
      expect(response.status).toBe(200);
      const { fixtures: rows } = await response.json();

      // 0: Arsenal vs Coventry -> SNIPE: Home Fortress (2-0)
      expect(rows[0]).toMatchObject({
        category: "SNIPE: Home Fortress",
        prediction: "2-0",
        enginePrediction: null,
      });
      // 1: Chelsea vs Spurs -> ENGINE: Winner-First with Home win score (h > a)
      expect(rows[1].category).toBe("ENGINE: Winner-First");
      expect(getV2Outcome(rows[1].prediction)).toBe("H");
      // 2: Hull vs Spurs -> ENGINE: Winner-First with Away win score (h < a)
      expect(rows[2].category).toBe("ENGINE: Winner-First");
      expect(getV2Outcome(rows[2].prediction)).toBe("A");
    } finally {
      vi.doUnmock("@/db");
      vi.doUnmock("@/lib/espn");
      vi.doUnmock("@/lib/engine");
      vi.resetModules();
    }
  });
});
