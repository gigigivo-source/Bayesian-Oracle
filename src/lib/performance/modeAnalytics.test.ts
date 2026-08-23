import { describe, expect, it } from "vitest";
import {
  applyFilters,
  betFromSlipRow,
  betFromValueBetRow,
  betsFromPerformanceRow,
  breakdownBy,
  buildComparison,
  buildDailySeries,
  buildModeReport,
  buildWindows,
  confidenceBands,
  dayOffset,
  deriveFactorBucket,
  factorAccuracy,
  factorsForPick,
  oddsBands,
  percent,
  perfectMatch,
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
    match: "Home vs Away",
    league: "Premier League",
    leagueSlug: "eng.1",
    market: "Total Offsides",
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
    factors: [{ factor: "Calibration", contribution: null }],
    factorsDerived: true,
    eventId: "e1",
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

// ─── Primitives ───────────────────────────────────────────────────────────────

describe("primitives", () => {
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
});

// ─── Factors ──────────────────────────────────────────────────────────────────

describe("factor bucketing", () => {
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

  it("credits every active factor with the bet result", () => {
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
      bet({ id: "3", date: "2026-08-03", result: "PENDING", pnl: null, factors: [{ factor: "Form", contribution: 0.5 }], factorsDerived: false }),
    ]);
    const poisson = rows.find((r) => r.factor === "Poisson")!;
    expect(poisson.totalBets).toBe(2);
    expect(poisson.hitRate).toBe(50);
    expect(poisson.averageContribution).toBeCloseTo(0.6, 5);
    const form = rows.find((r) => r.factor === "Form")!;
    // Pending bets never count towards the settled totals.
    expect(form.totalBets).toBe(1);
    expect(form.hitRate).toBe(100);
  });
});

// ─── Summary ──────────────────────────────────────────────────────────────────

describe("summarise", () => {
  const bets: ModeBet[] = [
    bet({ id: "1", date: "2026-08-01", result: "WIN", odds: 2, stake: 10, pnl: 10, returnAmount: 20, modelProb: 0.8 }),
    bet({ id: "2", date: "2026-08-02", result: "LOSS", odds: 1.5, stake: 20, pnl: -20, returnAmount: null, modelProb: 0.7 }),
    bet({ id: "3", date: "2026-08-03", result: "WIN", odds: 1.6, stake: 10, pnl: 6, returnAmount: 16, modelProb: 0.75 }),
    bet({ id: "4", date: "2026-08-03", result: "PUSH", odds: 1.9, stake: 10, pnl: 0, returnAmount: 10, modelProb: 0.6 }),
    bet({ id: "5", date: "2026-08-04", result: "VOID", odds: null, stake: null, pnl: null, returnAmount: null, modelProb: null }),
    bet({ id: "6", date: "2026-08-05", result: "PENDING", odds: 2.2, stake: 10, pnl: null, returnAmount: null, modelProb: 0.55 }),
  ];
  const s = summarise(bets, { tenOfTenHits: 2, matchesTracked: 8 });

  it("counts every result class and its share", () => {
    expect(s.totalBets).toBe(6);
    expect([s.wins, s.losses, s.pushes, s.voids, s.pending]).toEqual([2, 1, 1, 1, 1]);
    expect(s.winPct).toBeCloseTo(33.33, 1);
    expect(s.settledBets).toBe(3);
  });

  it("computes hit rate from settled bets only", () => {
    expect(s.hitRate).toBeCloseTo(66.67, 1);
  });

  it("computes money metrics from real stakes", () => {
    expect(s.totalPnl).toBe(-4);
    expect(s.totalStake).toBe(60);
    expect(s.totalReturn).toBe(46);
    expect(s.roi).toBeCloseTo(-6.67, 1);
    expect(s.averageStake).toBe(12);
  });

  it("weights average odds by stake", () => {
    // (2*10 + 1.5*20 + 1.6*10 + 1.9*10 + 2.2*10) / 60 = 107 / 60
    expect(s.averageOdds).toBeCloseTo(1.783, 3);
    expect(s.averageOddsUnweighted).toBeCloseTo(1.84, 2);
  });

  it("tracks streaks, drawdown and best/worst days", () => {
    expect(s.currentStreak.label).toBe("1 Win");
    expect(s.longestWinStreak).toBe(1);
    expect(s.longestLossStreak).toBe(1);
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

  it("handles an empty bet list without dividing by zero", () => {
    const empty = summarise([], { tenOfTenHits: 0, matchesTracked: 0 });
    expect(empty.totalBets).toBe(0);
    expect(empty.hitRate).toBe(0);
    expect(empty.roi).toBeNull();
    expect(empty.averageOdds).toBeNull();
    expect(empty.currentStreak).toEqual({ type: null, count: 0, label: "—" });
  });

  it("pluralises multi-bet streaks", () => {
    const streaky = summarise(
      [
        bet({ id: "a", date: "2026-08-01", result: "LOSS", pnl: -10 }),
        bet({ id: "b", date: "2026-08-02", result: "LOSS", pnl: -10 }),
        bet({ id: "c", date: "2026-08-03", result: "LOSS", pnl: -10 }),
      ],
      { tenOfTenHits: 0, matchesTracked: 1 },
    );
    expect(streaky.currentStreak.label).toBe("3 Losses");
    expect(streaky.longestLossStreak).toBe(3);
  });

  it("derives rank-tier hit rates", () => {
    const ranked = summarise(
      [
        bet({ id: "r1", date: "2026-08-01", rank: 1, result: "WIN", source: "pick" }),
        bet({ id: "r2", date: "2026-08-01", rank: 3, result: "LOSS", source: "pick" }),
        bet({ id: "r3", date: "2026-08-01", rank: 9, result: "WIN", source: "pick" }),
      ],
      { tenOfTenHits: 0, matchesTracked: 1 },
    );
    expect(ranked.top1HitRate).toBe(100);
    expect(ranked.top3HitRate).toBe(50);
    expect(ranked.top10HitRate).toBeCloseTo(66.67, 1);
  });
});

// ─── Series, windows, breakdowns ──────────────────────────────────────────────

describe("series and breakdowns", () => {
  const bets = [
    bet({ id: "1", date: "2026-08-01", pnl: 10, result: "WIN" }),
    bet({ id: "2", date: "2026-08-01", pnl: -10, result: "LOSS" }),
    bet({ id: "3", date: "2026-08-02", pnl: 5, result: "WIN", league: "La Liga", leagueSlug: "esp.1" }),
  ];

  it("accumulates a daily P&L curve", () => {
    const series = buildDailySeries(bets);
    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({ date: "2026-08-01", bets: 2, pnl: 0, cumulativePnl: 0, hitRate: 50 });
    expect(series[1]).toMatchObject({ date: "2026-08-02", cumulativePnl: 5, hitRate: 100 });
  });

  it("slices 7d / 30d / all-time windows", () => {
    const now = new Date("2026-08-23T00:00:00Z");
    const windows = buildWindows(
      [bet({ id: "old", date: "2026-01-01", pnl: 100 }), bet({ id: "new", date: "2026-08-20", pnl: 5 })],
      now,
    );
    expect(windows.map((w) => w.key)).toEqual(["7d", "30d", "all"]);
    expect(windows[0].bets).toBe(1);
    expect(windows[2].bets).toBe(2);
    expect(windows[2].pnl).toBe(105);
  });

  it("groups by an arbitrary key", () => {
    const rows = breakdownBy(bets, (b) => ({ key: b.leagueSlug ?? "", label: b.league }));
    expect(rows[0]).toMatchObject({ key: "eng.1", bets: 2, wins: 1, losses: 1, hitRate: 50 });
    expect(rows[1]).toMatchObject({ key: "esp.1", bets: 1, hitRate: 100 });
  });

  it("buckets odds and model confidence", () => {
    const rows = oddsBands([
      bet({ id: "1", date: "2026-08-01", odds: 1.2 }),
      bet({ id: "2", date: "2026-08-01", odds: 4 }),
      bet({ id: "3", date: "2026-08-01", odds: null }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["1.00-1.30", "3.00+"]);

    const conf = confidenceBands([
      bet({ id: "1", date: "2026-08-01", modelProb: 0.97 }),
      bet({ id: "2", date: "2026-08-01", modelProb: 0.5 }),
    ]);
    expect(conf.map((r) => r.key)).toEqual(["95", "00"]);
  });
});

// ─── Normalisers ──────────────────────────────────────────────────────────────

describe("row normalisers", () => {
  it("expands a performance row into ranked picks", () => {
    const bets = betsFromPerformanceRow(perfRow);
    expect(bets).toHaveLength(10);
    expect(bets[0]).toMatchObject({
      mode: "C",
      source: "pick",
      rank: 1,
      result: "WIN",
      league: "Premier League",
      date: "2026-08-01",
    });
    expect(bets[9].result).toBe("LOSS");
    // Ranked picks carry no stake, so they never distort the money metrics.
    expect(bets.every((b) => b.stake === null && b.pnl === null)).toBe(true);
  });

  it("flags a 10/10 match only when all ten picks won", () => {
    expect(perfectMatch(perfRow)).toBe(false);
    expect(
      perfectMatch({
        ...perfRow,
        top10Detail: Array.from({ length: 10 }, () => ({ outcome: "HIT" })),
      }),
    ).toBe(true);
    expect(perfectMatch({ ...perfRow, top10Detail: [{ outcome: "HIT" }] })).toBe(false);
  });

  it("defaults an unknown ranking mode to B", () => {
    expect(betsFromPerformanceRow({ ...perfRow, rankingMode: "" })[0].mode).toBe("B");
  });

  it("derives P&L for value bets that have not been settled with a P&L yet", () => {
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
    expect(won).toMatchObject({ mode: "D", source: "valueBet", result: "WIN", pnl: 25, returnAmount: 50 });
    expect(won.ev).toBeCloseTo(0.24, 5);

    expect(betFromValueBetRow({ ...base, outcome: "lost" }).pnl).toBe(-25);
    expect(betFromValueBetRow({ ...base, outcome: "void" }).pnl).toBe(0);
    expect(betFromValueBetRow({ ...base, outcome: "pending" }).pnl).toBeNull();
    // A persisted P&L always wins over the derived one.
    expect(betFromValueBetRow({ ...base, pnl: 12.5 }).pnl).toBe(12.5);
  });

  it("attributes slips from the column first, then the picks JSON", () => {
    const slip: SavedSlipLike = {
      id: 3,
      name: "Saturday banker",
      leagueSlug: "eng.1",
      competitionName: "Premier League",
      picks: [{ rankingMode: "A" }, {}],
      combinedOdds: 4,
      combinedProb: 0.3,
      stake: 10,
      status: "won",
      createdAt: new Date("2026-08-12T18:30:00Z"),
      rankingMode: "C",
    };
    expect(betFromSlipRow(slip)).toMatchObject({ mode: "C", pnl: 30, returnAmount: 40, date: "2026-08-12" });
    expect(betFromSlipRow({ ...slip, rankingMode: null })?.mode).toBe("A");
    // Never guess: unattributed slips are dropped entirely.
    expect(betFromSlipRow({ ...slip, rankingMode: null, picks: [{}] })).toBeNull();
  });
});

// ─── Filters, report, comparison ──────────────────────────────────────────────

describe("filters", () => {
  const bets = [
    bet({ id: "1", date: "2026-08-01", league: "Premier League", result: "WIN", source: "pick" }),
    bet({ id: "2", date: "2026-08-15", league: "La Liga", result: "LOSS", source: "valueBet" }),
    bet({ id: "3", date: "2026-08-20", league: "Serie A", result: "PENDING", source: "slip", match: "Milan vs Inter" }),
  ];

  it("filters by date, league, result, source and search", () => {
    expect(applyFilters(bets, { from: "2026-08-10" }).map((b) => b.id)).toEqual(["2", "3"]);
    expect(applyFilters(bets, { to: "2026-08-10" }).map((b) => b.id)).toEqual(["1"]);
    expect(applyFilters(bets, { league: "liga" }).map((b) => b.id)).toEqual(["2"]);
    expect(applyFilters(bets, { result: "win" }).map((b) => b.id)).toEqual(["1"]);
    expect(applyFilters(bets, { source: "slip" }).map((b) => b.id)).toEqual(["3"]);
    expect(applyFilters(bets, { search: "milan" }).map((b) => b.id)).toEqual(["3"]);
    expect(applyFilters(bets, { result: "ALL", source: "all" })).toHaveLength(3);
    expect(applyFilters(bets, {})).toHaveLength(3);
  });
});

describe("report and comparison", () => {
  const now = new Date("2026-08-23T00:00:00Z");

  it("builds a complete report for one mode", () => {
    const report = buildModeReport("A", [bet({ id: "1", date: "2026-08-20" })], {
      tenOfTenHits: 1,
      matchesTracked: 4,
      now,
    });
    expect(report.mode).toBe("A");
    expect(report.label).toBe("Rank A · Classic");
    expect(report.summary.totalBets).toBe(1);
    expect(report.windows).toHaveLength(3);
    expect(report.markets[0].label).toBe("Total Offsides");
    expect(report.leagues[0].label).toBe("Premier League");
    expect(report.bets).toHaveLength(1);
  });

  it("stays stable for a mode with no data", () => {
    const report = buildModeReport("D", [], { tenOfTenHits: 0, matchesTracked: 0, now });
    expect(report.summary.totalBets).toBe(0);
    expect(report.daily).toEqual([]);
    expect(report.factorAccuracy).toEqual([]);
  });

  it("stars the best mode per metric and ignores empty modes", () => {
    const reports = [
      buildModeReport("A", [bet({ id: "a", date: "2026-08-20", pnl: 50, stake: 10, odds: 3 })], {
        tenOfTenHits: 3,
        matchesTracked: 5,
        now,
      }),
      buildModeReport("B", [bet({ id: "b", date: "2026-08-20", pnl: 5, stake: 10, odds: 1.4, result: "LOSS" })], {
        tenOfTenHits: 0,
        matchesTracked: 5,
        now,
      }),
      buildModeReport("C", [], { tenOfTenHits: 0, matchesTracked: 0, now }),
      buildModeReport("D", [], { tenOfTenHits: 0, matchesTracked: 0, now }),
    ];
    const comparison = buildComparison(reports);
    const a = comparison.find((r) => r.mode === "A")!;
    const c = comparison.find((r) => r.mode === "C")!;
    expect(a.bestIn).toContain("totalPnl");
    expect(a.bestIn).toContain("hitRate");
    expect(a.bestIn).toContain("tenOfTenHits");
    expect(c.bestIn).toEqual([]);
    expect(comparison).toHaveLength(4);
  });
});
