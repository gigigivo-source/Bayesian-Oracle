import { describe, expect, it } from "vitest";
import {
  applyFilters,
  betFromSlipRow,
  betFromValueBetRow,
  betsFromPerformanceRow,
  betsToCsv,
  betsToJson,
  breakdownBy,
  buildCalibrationCurve,
  buildComparison,
  buildDailySeries,
  buildDrawdownEpisodes,
  buildModeReport,
  buildMultiModeSeries,
  buildRollingSeries,
  buildTierSummary,
  buildWindows,
  calculateConsistencyScore,
  calculateCorrelation,
  calculateFactorReliability,
  calculateOverallPerformanceScore,
  calculateProfitFactor,
  calculateRecoveryFactor,
  calculateSharpeRatio,
  confidenceBands,
  dayOffset,
  dedupeMatchRows,
  dedupeValueBetRows,
  deriveConfidenceLevel,
  deriveFactorBucket,
  deriveMarketFamily,
  deriveOrientation,
  factorAccuracy,
  factorsForPick,
  generateInsights,
  oddsBands,
  percent,
  perfectMatch,
  standardDeviation,
  summarise,
  toMode,
  toResult,
  type ModeBet,
  type PerformanceLogLike,
  type SavedSlipLike,
  type ValueBetLogLike,
} from "./modeAnalytics";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function bet(partial: Partial<ModeBet> & { id: string; date: string }): ModeBet {
  return {
    match: "Arsenal vs Chelsea",
    league: "Premier League",
    leagueSlug: "eng.1",
    market: "Total Offsides Under 7.5",
    marketFamily: "Offsides",
    selection: "Under 7.5",
    odds: 1.8,
    result: "WIN",
    stake: 10,
    pnl: 8,
    returnAmount: 18,
    ev: 0.05,
    modelProb: 0.9,
    mode: "A",
    source: "valueBet",
    rank: null,
    lowConfidence: false,
    confidenceLevel: "HIGH",
    factors: [{ factor: "Calibration", contribution: null }],
    factorsDerived: true,
    eventId: "e1",
    timeOfDay: "Evening",
    orientation: "Neutral",
    isLive: false,
    ...partial,
  };
}

const perfRow: PerformanceLogLike = {
  id: 1,
  eventId: "evt-1",
  matchLabel: "Arsenal vs Chelsea",
  league: "eng.1",
  leagueSlug: "eng.1",
  competitionName: "Premier League",
  matchDate: "2026-08-01",
  rankingMode: "C",
  lowConfidence: false,
  top10Detail: Array.from({ length: 10 }, (_, i) => ({
    name: i === 0 ? "Total Corners Over 6.5" : "Total Goals Under 4.5",
    selection: i === 0 ? "Over 6.5" : "Under 4.5",
    outcome: i < 8 ? "HIT" : "MISS",
    family: "totals",
    hitRate: 0.9,
  })),
};

// ─── Primitives & Math Helpers ────────────────────────────────────────────────

describe("primitives & math helpers", () => {
  it("normalises every outcome dialect used across the codebase", () => {
    expect(toResult("HIT")).toBe("WIN");
    expect(toResult("won")).toBe("WIN");
    expect(toResult("miss")).toBe("LOSS");
    expect(toResult("lost")).toBe("LOSS");
    expect(toResult("push")).toBe("PUSH");
    expect(toResult("void")).toBe("VOID");
    expect(toResult(null)).toBe("PENDING");
    expect(toResult("something else")).toBe("PENDING");
  });

  it("only accepts the four ranking modes", () => {
    expect(toMode("a")).toBe("A");
    expect(toMode("D")).toBe("D");
    expect(toMode("Z")).toBeNull();
    expect(toMode(undefined)).toBeNull();
  });

  it("guards percent against division by zero", () => {
    expect(percent(3, 4)).toBe(75);
    expect(percent(0, 0)).toBe(0);
  });

  it("computes day offsets in UTC", () => {
    expect(dayOffset(new Date("2026-08-23T10:00:00Z"), 7)).toBe("2026-08-16");
    expect(dayOffset(new Date("2026-01-03T10:00:00Z"), 7)).toBe("2025-12-27");
  });

  it("computes standard deviation accurately", () => {
    expect(standardDeviation([])).toBe(0);
    expect(standardDeviation([5])).toBe(0);
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
  });

  it("computes Sharpe Ratio, Profit Factor, and Recovery Factor", () => {
    const dailyPnl = [10, -5, 15, -2, 8];
    const sharpe = calculateSharpeRatio(dailyPnl);
    expect(sharpe).toBeGreaterThan(0);
    expect(calculateSharpeRatio([])).toBeNull();
    expect(calculateSharpeRatio([5])).toBeNull();

    const sampleBets = [
      bet({ id: "1", date: "2026-08-01", result: "WIN", pnl: 20 }),
      bet({ id: "2", date: "2026-08-02", result: "LOSS", pnl: -10 }),
    ];
    expect(calculateProfitFactor(sampleBets)).toBe(2);

    expect(calculateRecoveryFactor(50, 25)).toBe(2);
    expect(calculateRecoveryFactor(50, 0)).toBe(99.9);
  });

  it("calculates consistency score and overall performance score", () => {
    const daily = buildDailySeries([
      bet({ id: "1", date: "2026-08-01", pnl: 10, result: "WIN" }),
      bet({ id: "2", date: "2026-08-02", pnl: 10, result: "WIN" }),
    ]);
    const score = calculateConsistencyScore(daily, [bet({ id: "1", date: "2026-08-01" })], 0, 100);
    expect(score).toBeGreaterThan(60);

    const overall = calculateOverallPerformanceScore(80, 15, 50, 200, score, 20);
    expect(overall).toBeGreaterThan(50);
    expect(calculateOverallPerformanceScore(80, 15, 50, 200, 80, 0)).toBe(0);
  });

  it("derives market family, confidence level, and orientation", () => {
    expect(deriveMarketFamily("Total Corners Over 8.5")).toBe("Corners");
    expect(deriveMarketFamily("Total Cards Under 4.5")).toBe("Cards / Discipline");
    expect(deriveMarketFamily("Both Teams To Score")).toBe("Goals");
    expect(deriveMarketFamily("Over 2.5 Goals")).toBe("Goals");

    expect(deriveConfidenceLevel(0.92, false)).toBe("HIGH");
    expect(deriveConfidenceLevel(0.75, false)).toBe("MEDIUM");
    expect(deriveConfidenceLevel(0.55, false)).toBe("LOW");
    expect(deriveConfidenceLevel(0.95, true)).toBe("LOW");

    expect(deriveOrientation("Arsenal vs Chelsea", "Arsenal to Win")).toBe("Home");
    expect(deriveOrientation("Arsenal vs Chelsea", "Chelsea to Win")).toBe("Away");
    expect(deriveOrientation("Arsenal vs Chelsea", "Draw")).toBe("Draw");
    expect(deriveOrientation("Arsenal vs Chelsea", "Over 2.5 Goals")).toBe("Neutral");
  });
});

// ─── Factors ──────────────────────────────────────────────────────────────────

describe("factor bucketing & analysis", () => {
  it("maps market families to documented buckets", () => {
    expect(deriveFactorBucket("Total Corners Over 8.5")).toBe("Poisson λ (Corners)");
    expect(deriveFactorBucket("Total Cards Under 4.5")).toBe("Poisson λ (Cards / Discipline)");
    expect(deriveFactorBucket("Total Offsides Under 7.5")).toBe("Poisson λ (Offsides)");
    expect(deriveFactorBucket("Match Result", "result")).toBe("Match result / Double chance");
    expect(deriveFactorBucket("Something exotic")).toBe("Calibration");
  });

  it("prefers persisted engine weights over derived buckets", () => {
    const { factors, derived } = factorsForPick({
      name: "Total Goals Under 4.5",
      factors: { Poisson: 0.9, "Zero bias": 0.4 },
    });
    expect(derived).toBe(false);
    expect(factors[0]).toEqual({ factor: "Poisson", contribution: 0.9 });
    expect(factors[1].factor).toBe("Zero bias");
  });

  it("credits every active factor with the bet result and computes correlation/reliability", () => {
    const rows = factorAccuracy([
      bet({
        id: "1",
        date: "2026-08-01",
        result: "WIN",
        factors: [
          { factor: "Poisson", contribution: 0.8 },
          { factor: "Form", contribution: 0.6 },
        ],
        factorsDerived: false,
      }),
      bet({
        id: "2",
        date: "2026-08-02",
        result: "LOSS",
        pnl: -10,
        factors: [{ factor: "Poisson", contribution: 0.4 }],
        factorsDerived: false,
      }),
      bet({
        id: "3",
        date: "2026-08-03",
        result: "PENDING",
        pnl: null,
        factors: [{ factor: "Form", contribution: 0.5 }],
        factorsDerived: false,
      }),
    ]);
    const poisson = rows.find((r) => r.factor === "Poisson")!;
    expect(poisson.totalBets).toBe(2);
    expect(poisson.hitRate).toBe(50);
    expect(poisson.averageContribution).toBeCloseTo(0.6, 5);
    expect(poisson.correlation).toBeDefined();
    expect(poisson.reliabilityScore).toBeGreaterThanOrEqual(0);

    const form = rows.find((r) => r.factor === "Form")!;
    expect(form.totalBets).toBe(1);
    expect(form.hitRate).toBe(100);
  });

  it("calculates factor correlation and factor reliability correctly", () => {
    const pairs = [
      { x: 0.8, y: 1 },
      { x: 0.7, y: 1 },
      { x: 0.3, y: 0 },
      { x: 0.2, y: 0 },
    ];
    const corr = calculateCorrelation(pairs);
    expect(corr).toBeGreaterThan(0.8);

    const reliability = calculateFactorReliability(80, 25, corr);
    expect(reliability).toBeGreaterThan(70);
  });
});

// ─── Summary & Tier Breakdowns ────────────────────────────────────────────────

describe("summarise & tier breakdowns", () => {
  const bets: ModeBet[] = [
    bet({ id: "1", date: "2026-08-01", result: "WIN", odds: 2, stake: 10, pnl: 10, returnAmount: 20, modelProb: 0.8, rank: 1, confidenceLevel: "HIGH" }),
    bet({ id: "2", date: "2026-08-02", result: "LOSS", odds: 1.5, stake: 20, pnl: -20, returnAmount: null, modelProb: 0.7, rank: 2, confidenceLevel: "MEDIUM" }),
    bet({ id: "3", date: "2026-08-03", result: "WIN", odds: 1.6, stake: 10, pnl: 6, returnAmount: 16, modelProb: 0.75, rank: 3, confidenceLevel: "MEDIUM" }),
    bet({ id: "4", date: "2026-08-03", result: "PUSH", odds: 1.9, stake: 10, pnl: 0, returnAmount: 10, modelProb: 0.6, rank: 4, confidenceLevel: "LOW" }),
    bet({ id: "5", date: "2026-08-04", result: "VOID", odds: null, stake: null, pnl: null, returnAmount: null, modelProb: null, rank: 5 }),
    bet({ id: "6", date: "2026-08-05", result: "PENDING", odds: 2.2, stake: 10, pnl: null, returnAmount: null, modelProb: 0.55, rank: 6 }),
  ];
  const s = summarise(bets, { tenOfTenHits: 2, matchesTracked: 8 });

  it("counts every result class, percentages, and profit per winning bet", () => {
    expect(s.totalBets).toBe(6);
    expect([s.wins, s.losses, s.pushes, s.voids, s.pending]).toEqual([2, 1, 1, 1, 1]);
    expect(s.winPct).toBeCloseTo(33.33, 1);
    expect(s.settledBets).toBe(3);
    expect(s.profitPerWinningBet).toBe(8); // (10 + 6) / 2
  });

  it("computes hit rate from settled bets only", () => {
    expect(s.hitRate).toBeCloseTo(66.67, 1);
  });

  it("computes money metrics and volatility rating", () => {
    expect(s.totalPnl).toBe(-4);
    expect(s.totalStake).toBe(60);
    expect(s.totalReturn).toBe(46);
    expect(s.roi).toBeCloseTo(-6.67, 1);
    expect(s.volatilityRating).toBeDefined();
    expect(s.consistencyScore).toBeDefined();
    expect(s.overallScore).toBeDefined();
  });

  it("weights average odds by stake", () => {
    expect(s.averageOdds).toBeCloseTo(1.783, 3);
    expect(s.averageOddsUnweighted).toBeCloseTo(1.84, 2);
  });

  it("tracks streaks, longest non-win run, and drawdown", () => {
    expect(s.currentStreak.label).toBe("1 Win");
    expect(s.longestWinStreak).toBe(1);
    expect(s.longestLossStreak).toBe(1);
    expect(s.longestNonWinStreak).toBe(2); // LOSS + PUSH
    expect(s.maxDrawdown).toBe(20);
    expect(s.bestDay).toEqual({ date: "2026-08-01", pnl: 10 });
    expect(s.worstDay).toEqual({ date: "2026-08-02", pnl: -20 });
  });

  it("reports perfect matches and calibration", () => {
    expect(s.tenOfTenHits).toBe(2);
    expect(s.perfectMatchRate).toBe(25);
    expect(s.brierScore).not.toBeNull();
    expect(s.calibrationDelta).not.toBeNull();
  });

  it("builds Top 1, Top 3, Top 10 tier summaries", () => {
    const tier1 = buildTierSummary(bets, (r) => r === 1, "Top 1");
    expect(tier1.tier).toBe("Top 1");
    expect(tier1.totalBets).toBe(1);
    expect(tier1.wins).toBe(1);
    expect(tier1.hitRate).toBe(100);

    const tier3 = buildTierSummary(bets, (r) => r <= 3, "Top 3");
    expect(tier3.totalBets).toBe(3);
    expect(tier3.wins).toBe(2);
    expect(tier3.losses).toBe(1);
    expect(tier3.hitRate).toBeCloseTo(66.67, 1);
  });
});

// ─── Series, Windows, Calibration & Multi-Mode ────────────────────────────────

describe("series, windows, calibration & multi-mode", () => {
  const bets = [
    bet({ id: "1", date: "2026-08-01", pnl: 10, result: "WIN", modelProb: 0.85 }),
    bet({ id: "2", date: "2026-08-01", pnl: -10, result: "LOSS", modelProb: 0.65 }),
    bet({ id: "3", date: "2026-08-02", pnl: 5, result: "WIN", league: "La Liga", leagueSlug: "esp.1", modelProb: 0.75 }),
  ];

  it("accumulates daily series and rolling series", () => {
    const series = buildDailySeries(bets);
    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({ date: "2026-08-01", bets: 2, pnl: 0, cumulativePnl: 0, hitRate: 50 });
    expect(series[1]).toMatchObject({ date: "2026-08-02", cumulativePnl: 5, hitRate: 100 });

    const rolling = buildRollingSeries(series, 7);
    expect(rolling).toHaveLength(2);
    expect(rolling[1].hitRate).toBeGreaterThan(0);
  });

  it("computes calibration curve buckets", () => {
    const curve = buildCalibrationCurve(bets);
    expect(curve).toHaveLength(5);
    const bucket80 = curve.find((c) => c.bucket === "80–90%")!;
    expect(bucket80.count).toBe(1);
    expect(bucket80.actualHitRate).toBe(100);
  });

  it("computes drawdown episodes", () => {
    const daily = buildDailySeries([
      bet({ id: "1", date: "2026-08-01", pnl: 20 }),
      bet({ id: "2", date: "2026-08-02", pnl: -30 }),
      bet({ id: "3", date: "2026-08-03", pnl: 40 }),
    ]);
    const episodes = buildDrawdownEpisodes(daily);
    expect(episodes.length).toBeGreaterThan(0);
    expect(episodes[0].maxDrop).toBe(30);
  });

  it("synchronises multi-mode cumulative P&L series", () => {
    const now = new Date("2026-08-23T00:00:00Z");
    const rA = buildModeReport("A", [bet({ id: "1", date: "2026-08-01", pnl: 10 })], { tenOfTenHits: 0, matchesTracked: 1, now });
    const rB = buildModeReport("B", [bet({ id: "2", date: "2026-08-02", pnl: 20, mode: "B" })], { tenOfTenHits: 0, matchesTracked: 1, now });
    const rC = buildModeReport("C", [], { tenOfTenHits: 0, matchesTracked: 0, now });
    const rD = buildModeReport("D", [], { tenOfTenHits: 0, matchesTracked: 0, now });

    const multi = buildMultiModeSeries([rA, rB, rC, rD]);
    expect(multi.length).toBe(2);
    expect(multi[0].date).toBe("2026-08-01");
    expect(multi[0].A).toBe(10);
    expect(multi[1].date).toBe("2026-08-02");
    expect(multi[1].B).toBe(20);
  });
});

// ─── Normalisers ──────────────────────────────────────────────────────────────

describe("row normalisers", () => {
  it("expands a performance row into ranked picks with enriched fields", () => {
    const bets = betsFromPerformanceRow(perfRow);
    expect(bets).toHaveLength(10);
    expect(bets[0]).toMatchObject({
      mode: "C",
      source: "pick",
      rank: 1,
      result: "WIN",
      league: "Premier League",
      date: "2026-08-01",
      marketFamily: "Corners",
      confidenceLevel: "HIGH",
    });
    expect(bets[9].result).toBe("LOSS");
  });

  it("derives P&L for value bets", () => {
    const base: ValueBetLogLike = {
      id: 7,
      eventId: "evt-7",
      match: "Milan vs Inter",
      matchDate: "2026-08-10",
      leagueSlug: "ita.1",
      competitionName: "Serie A",
      marketName: "Total Cards Over 4.5",
      selection: "Over 4.5",
      oracleProb: 0.62,
      bookOdds: 2,
      valueEdge: 0.24,
      stake: 25,
      potentialReturn: 50,
      actualReturn: null,
      pnl: null,
      outcome: "won",
      lowConfidence: false,
      rankingMode: "D",
    };
    const won = betFromValueBetRow(base);
    expect(won).toMatchObject({
      mode: "D",
      source: "valueBet",
      result: "WIN",
      pnl: 25,
      returnAmount: 50,
      marketFamily: "Cards / Discipline",
    });
  });

  it("normalises slip rows correctly", () => {
    const slip: SavedSlipLike = {
      id: 3,
      name: "Saturday banker",
      leagueSlug: "eng.1",
      competitionName: "Premier League",
      picks: [{ rankingMode: "A" }],
      combinedOdds: 4,
      combinedProb: 0.3,
      stake: 10,
      status: "won",
      createdAt: new Date("2026-08-12T18:30:00Z"),
      rankingMode: "C",
    };
    expect(betFromSlipRow(slip)).toMatchObject({
      mode: "C",
      pnl: 30,
      marketFamily: "Accumulators",
    });
  });
});

// ─── Filters, Comparison, Insights & Exports ──────────────────────────────────

describe("filters, comparison, insights & exports", () => {
  const bets = [
    bet({ id: "1", date: "2026-08-01", league: "Premier League", result: "WIN", source: "pick", marketFamily: "Goals", confidenceLevel: "HIGH", odds: 1.5, rank: 1, orientation: "Home", isLive: false }),
    bet({ id: "2", date: "2026-08-15", league: "La Liga", result: "LOSS", source: "valueBet", marketFamily: "Corners", confidenceLevel: "LOW", odds: 2.5, rank: 4, orientation: "Away", isLive: true }),
    bet({ id: "3", date: "2026-08-20", league: "Serie A", result: "PENDING", source: "slip", match: "Milan vs Inter", marketFamily: "Cards / Discipline", confidenceLevel: "MEDIUM", odds: 3.5 }),
  ];

  it("filters across all dimensions including granular fields", () => {
    expect(applyFilters(bets, { marketFamily: "Goals" })).toHaveLength(1);
    expect(applyFilters(bets, { confidenceLevel: "HIGH" })).toHaveLength(1);
    expect(applyFilters(bets, { oddsRange: "1.30-1.60" })).toHaveLength(1);
    expect(applyFilters(bets, { rankPosition: "1" })).toHaveLength(1);
    expect(applyFilters(bets, { orientation: "Home" })).toHaveLength(1);
    expect(applyFilters(bets, { isLive: "live" })).toHaveLength(1);
    expect(applyFilters(bets, { isLive: "prematch" })).toHaveLength(2);
  });

  it("generates automated insights", () => {
    const now = new Date("2026-08-23T00:00:00Z");
    const reports = [
      buildModeReport("A", [bet({ id: "a1", date: "2026-08-20", pnl: 50, stake: 10, odds: 3, result: "WIN", league: "Premier League", marketFamily: "Goals", confidenceLevel: "HIGH" }), bet({ id: "a2", date: "2026-08-21", pnl: 40, stake: 10, odds: 2, result: "WIN", league: "Premier League", marketFamily: "Goals", confidenceLevel: "HIGH" })], { tenOfTenHits: 1, matchesTracked: 2, now }),
      buildModeReport("B", [bet({ id: "b1", date: "2026-08-20", pnl: -10, stake: 10, odds: 1.4, result: "LOSS", league: "Premier League", marketFamily: "Goals", mode: "B" }), bet({ id: "b2", date: "2026-08-21", pnl: -10, stake: 10, odds: 1.4, result: "LOSS", league: "Premier League", marketFamily: "Goals", mode: "B" })], { tenOfTenHits: 0, matchesTracked: 2, now }),
      buildModeReport("C", [], { tenOfTenHits: 0, matchesTracked: 0, now }),
      buildModeReport("D", [], { tenOfTenHits: 0, matchesTracked: 0, now }),
    ];

    const comparison = buildComparison(reports);
    expect(comparison[0].mode).toBe("A");
    expect(comparison[0].rank).toBe(1);
    expect(comparison[0].overallScore).toBeGreaterThan(0);

    const insights = generateInsights(reports);
    expect(insights.recommendedMode).toBe("A");
    expect(insights.leagueLeaders.length).toBeGreaterThan(0);
    expect(insights.marketLeaders.length).toBeGreaterThan(0);
  });

  it("exports to CSV and JSON formats", () => {
    const csv = betsToCsv(bets);
    expect(csv).toContain('"Date","Match","League"');
    expect(csv).toContain("Arsenal vs Chelsea");

    const now = new Date("2026-08-23T00:00:00Z");
    const report = buildModeReport("A", bets, { tenOfTenHits: 1, matchesTracked: 3, now });
    const json = betsToJson(report);
    const parsed = JSON.parse(json);
    expect(parsed.mode).toBe("A");
    expect(parsed.betsCount).toBe(3);
  });
});

describe("canonical-row dedup (mode-agnostic pages)", () => {
  it("keeps one row per eventId, preferring the B-mode row", () => {
    const rows = [
      { eventId: "e1", rankingMode: "A", createdAt: new Date("2026-08-02T00:00:00Z") },
      { eventId: "e1", rankingMode: "B", createdAt: new Date("2026-08-02T00:00:00Z") },
      { eventId: "e1", rankingMode: "C", createdAt: new Date("2026-08-03T00:00:00Z") },
      { eventId: "e2", rankingMode: "D", createdAt: new Date("2026-08-01T00:00:00Z") },
      { eventId: "e2", rankingMode: "A", createdAt: new Date("2026-08-05T00:00:00Z") },
    ];
    const out = dedupeMatchRows(rows);
    expect(out).toHaveLength(2);
    const e1 = out.find((r) => r.eventId === "e1")!;
    const e2 = out.find((r) => r.eventId === "e2")!;
    expect(e1.rankingMode).toBe("B"); // B wins even though C is newer
    expect(e2.rankingMode).toBe("A"); // no B row → most recent
  });

  it("treats missing rankingMode as B (pre-migration rows)", () => {
    const rows = [
      { eventId: "e1", rankingMode: null, createdAt: new Date("2026-08-01T00:00:00Z") },
      { eventId: "e1", rankingMode: "A", createdAt: new Date("2026-08-02T00:00:00Z") },
    ];
    const out = dedupeMatchRows(rows);
    expect(out).toHaveLength(1);
    expect(out[0].rankingMode).toBeNull();
  });

  it("keeps one row per (eventId, market, selection) for value bets", () => {
    const rows = [
      { eventId: "e1", marketName: "Over/Under 2.5", selection: "Over 2.5", rankingMode: "A" },
      { eventId: "e1", marketName: "Over/Under 2.5", selection: "Over 2.5", rankingMode: "B" },
      { eventId: "e1", marketName: "Over/Under 2.5", selection: "Over 2.5", rankingMode: "C" },
      { eventId: "e1", marketName: "BTTS", selection: "Yes", rankingMode: "A" },
      { eventId: "e1", marketName: "BTTS", selection: "Yes", rankingMode: "D" },
    ];
    const out = dedupeValueBetRows(rows);
    expect(out).toHaveLength(2);
    const ou = out.find((r) => r.selection === "Over 2.5")!;
    const bt = out.find((r) => r.selection === "Yes")!;
    expect(ou.rankingMode).toBe("B"); // B wins
    expect(bt.rankingMode).toBe("A"); // no B row → first seen
  });

  it("leaves single-mode data untouched", () => {
    const rows = [
      { eventId: "e1", rankingMode: "B" },
      { eventId: "e2", rankingMode: "B" },
    ];
    expect(dedupeMatchRows(rows)).toHaveLength(2);
    const vb = [
      { eventId: "e1", marketName: "M", selection: "S", rankingMode: "B" },
    ];
    expect(dedupeValueBetRows(vb)).toHaveLength(1);
  });
});
