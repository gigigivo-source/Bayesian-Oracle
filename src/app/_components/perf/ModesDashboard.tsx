"use client";

// ĞIGI GIVØ — Ranking Mode Performance Dashboard.
//
// Complete, comprehensive dashboard for the four ranking modes:
// Classic A, 12-Factor B, Hybrid C, Consensus D.
// Includes Ranking Leaderboard, Comprehensive Summary Cards, Mode Comparison Table,
// Consistency Analysis, Tier Breakdowns (Top 1/3/10), Factor Accuracy & Heatmaps,
// Interactive Trends, Granular Breakdowns, Detailed Bet Log, and Automated Insights.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, ErrorState, Section, cn } from "@/app/_components/perf/ui";
import {
  AutomatedInsightsPanel,
  BetsTable,
  BreakdownTable,
  ComprehensiveModeComparison,
  ConsistencyAnalysisPanel,
  DashboardSkeleton,
  ExpandedFactorAccuracyPanel,
  ExpandedTrendPanels,
  MODE_STYLES,
  ModeChips,
  RankingLeaderboard,
  SummaryCards,
  TierBreakdownPanel,
  betsToCsv,
  betsToJson,
  money,
  num,
  pctNum,
  type ModesApiResponse,
} from "@/app/_components/perf/modes";
import {
  RANKING_MODES,
  applyFilters,
  buildDrawdownEpisodes,
  buildModeReport,
  buildMultiModeSeries,
  generateInsights,
  type BetFilters,
  type FactorAccuracyRow,
  type RankingModeKey,
} from "@/lib/performance/modeAnalytics";

const RANGES = [
  { key: "7", label: "Last 7 days" },
  { key: "30", label: "Last 30 days" },
  { key: "90", label: "Last 90 days" },
  { key: "all", label: "All time" },
  { key: "custom", label: "Custom" },
] as const;

const RESULTS = ["WIN", "LOSS", "PUSH", "VOID", "PENDING"] as const;
const SOURCES = [
  { key: "pick", label: "Ranked picks" },
  { key: "valueBet", label: "Value bets" },
  { key: "slip", label: "Accumulators" },
] as const;

const MARKET_FAMILIES = [
  "Goals",
  "Corners",
  "Cards / Discipline",
  "Shots / Saves",
  "Offsides",
  "Match Result / Handicap",
  "Stats / Tactical",
  "Accumulators",
  "Other Markets",
] as const;

const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;

const ODDS_RANGES = [
  { key: "1.00-1.30", label: "1.00 – 1.30" },
  { key: "1.30-1.60", label: "1.30 – 1.60" },
  { key: "1.60-2.00", label: "1.60 – 2.00" },
  { key: "2.00-3.00", label: "2.00 – 3.00" },
  { key: "3.00+", label: "3.00+" },
] as const;

const RANK_POSITIONS = [
  { key: "1", label: "Top 1 (#1)" },
  { key: "3", label: "Top 3 (#1–3)" },
  { key: "5", label: "Top 5 (#1–5)" },
  { key: "6-10", label: "Top 6–10" },
] as const;

export function ModesDashboard() {
  const [data, setData] = useState<ModesApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<RankingModeKey>("A");
  const [range, setRange] = useState<string>("30");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [league, setLeague] = useState("");
  const [result, setResult] = useState("");
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");

  // Granular filters
  const [marketFamily, setMarketFamily] = useState("");
  const [confidenceLevel, setConfidenceLevel] = useState("");
  const [oddsRange, setOddsRange] = useState("");
  const [rankPosition, setRankPosition] = useState("");
  const [timeOfDay, setTimeOfDay] = useState("");
  const [orientation, setOrientation] = useState("");
  const [isLive, setIsLive] = useState("");

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (range === "custom") {
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (!from) params.set("days", "90");
    } else {
      params.set("days", range);
    }
    if (league.trim()) params.set("league", league.trim());
    if (result) params.set("result", result);
    if (source) params.set("source", source);
    if (search.trim()) params.set("search", search.trim());
    return params.toString();
  }, [range, from, to, league, result, source, search]);

  const load = useCallback((q: string) => {
    setLoading(true);
    setError(null);
    fetch(`/api/performance/modes?${q}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Ranking mode API returned ${res.status}`);
        const json = (await res.json()) as ModesApiResponse & { error?: string };
        if (!json.ok) throw new Error(json.error ?? "The performance service returned an error.");
        return json;
      })
      .then(setData)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load ranking mode performance"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => load(query), 250);
    return () => window.clearTimeout(timer);
  }, [query, load]);

  // Selected mode payload from server
  const activeReport = data?.modes.find((m) => m.mode === mode) ?? data?.modes[0] ?? null;

  // Granular client-side filtered report
  const clientFilters: BetFilters = useMemo(
    () => ({
      marketFamily: marketFamily || undefined,
      confidenceLevel: confidenceLevel || undefined,
      oddsRange: oddsRange || undefined,
      rankPosition: rankPosition || undefined,
      timeOfDay: timeOfDay || undefined,
      orientation: orientation || undefined,
      isLive: isLive || undefined,
    }),
    [marketFamily, confidenceLevel, oddsRange, rankPosition, timeOfDay, orientation, isLive],
  );

  const hasGranularFilters = Boolean(
    marketFamily || confidenceLevel || oddsRange || rankPosition || timeOfDay || orientation || isLive,
  );

  const active = useMemo(() => {
    if (!activeReport) return null;
    if (!hasGranularFilters) return activeReport;

    const filteredBets = applyFilters(activeReport.bets, clientFilters);
    const rebuilt = buildModeReport(activeReport.mode, filteredBets, {
      tenOfTenHits: activeReport.summary.tenOfTenHits,
      matchesTracked: activeReport.summary.matchesTracked,
    });
    return {
      ...rebuilt,
      betsTotal: filteredBets.length,
      betsTruncated: false,
    };
  }, [activeReport, clientFilters, hasGranularFilters]);

  // Multi-mode series for synchronized trend visualization
  const allModesSeries = useMemo(() => {
    if (!data?.modes || data.modes.length === 0) return [];
    return buildMultiModeSeries(data.modes);
  }, [data]);

  // Cross-mode factor map for the heatmap
  const factorsByMode = useMemo(() => {
    const map: Record<RankingModeKey, FactorAccuracyRow[]> = { A: [], B: [], C: [], D: [] };
    if (data?.modes) {
      for (const m of data.modes) {
        map[m.mode] = m.factorAccuracy;
      }
    }
    return map;
  }, [data]);

  // Automated Insights
  const insights = useMemo(() => {
    if (!data?.modes || data.modes.length === 0) return null;
    return generateInsights(data.modes);
  }, [data]);

  // Export handlers
  const exportCsv = useCallback(() => {
    if (!active) return;
    const csv = betsToCsv(active.bets);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bayesian-oracle-mode-${active.mode}-${data?.window.days ?? "30"}d.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [active, data]);

  const exportJson = useCallback(() => {
    if (!active) return;
    const json = betsToJson(active);
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bayesian-oracle-mode-${active.mode}-${data?.window.days ?? "30"}d.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [active, data]);

  const resetFilters = useCallback(() => {
    setRange("30");
    setFrom("");
    setTo("");
    setLeague("");
    setResult("");
    setSource("");
    setSearch("");
    setMarketFamily("");
    setConfidenceLevel("");
    setOddsRange("");
    setRankPosition("");
    setTimeOfDay("");
    setOrientation("");
    setIsLive("");
  }, []);

  return (
    <div className="space-y-8">
      {/* 1. Ranking Leaderboard at the very top */}
      {data?.comparison ? (
        <section>
          <div className="mb-3 inline-block rounded-lg bg-slate-900 px-4 py-2">
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">🏆 Ranking Leaderboard</h2>
            <p className="text-[11px] text-slate-300/80">
              Modes ranked by Overall Performance Score (Hit Rate, ROI, Net P&L, and Consistency)
            </p>
          </div>
          <RankingLeaderboard comparison={data.comparison} selected={mode} onSelect={setMode} />
        </section>
      ) : null}

      {/* Mode Switcher Chips */}
      <ModeChips comparison={data?.comparison} selected={mode} onSelect={setMode} />

      {data ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-mono text-[10px] text-slate-500">
            {data.totals.performanceRows} match rows · {data.totals.valueBetRows} value bets ·{" "}
            {data.totals.slipRows} slips · updated {new Date(data.generatedAt).toLocaleTimeString()}
          </span>
          <Link className="ml-auto cursor-pointer font-semibold text-amber-300 hover:underline" href="/performance/leagues">
            League breakdown →
          </Link>
        </div>
      ) : null}

      {/* 11-Dimensional Filter Bar */}
      <div className="space-y-3 rounded-2xl border border-slate-700 bg-slate-900 p-3.5 shadow-xl">
        <div className="flex flex-wrap items-center gap-2">
          {/* Date range switcher */}
          <div className="flex flex-wrap gap-1">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={cn(
                  "cursor-pointer rounded-full px-3 py-1.5 font-mono text-[11px] transition",
                  range === r.key
                    ? "bg-amber-400 font-bold text-slate-950 shadow-md"
                    : "bg-slate-800 text-slate-400 hover:text-white",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>

          {range === "custom" ? (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-1.5 font-mono text-xs text-white"
                aria-label="From date"
              />
              <span className="text-slate-500">→</span>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-1.5 font-mono text-xs text-white"
                aria-label="To date"
              />
            </div>
          ) : null}

          <input
            value={league}
            onChange={(e) => setLeague(e.target.value)}
            placeholder="League / competition"
            className="min-w-[140px] flex-1 rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-white placeholder:text-slate-500"
            aria-label="Filter by league"
          />

          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search match / market"
            className="min-w-[140px] flex-1 rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-white placeholder:text-slate-500"
            aria-label="Search matches and markets"
          />

          <select
            value={result}
            onChange={(e) => setResult(e.target.value)}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-white"
            aria-label="Filter by result"
          >
            <option value="">All results</option>
            {RESULTS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>

          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-white"
            aria-label="Filter by product"
          >
            <option value="">All products</option>
            {SOURCES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        {/* Secondary row of granular filters */}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-2.5">
          <select
            value={marketFamily}
            onChange={(e) => setMarketFamily(e.target.value)}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-white"
            aria-label="Filter by market family"
          >
            <option value="">Market: All Families</option>
            {MARKET_FAMILIES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>

          <select
            value={confidenceLevel}
            onChange={(e) => setConfidenceLevel(e.target.value)}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-white"
            aria-label="Filter by confidence level"
          >
            <option value="">Confidence: All</option>
            {CONFIDENCE_LEVELS.map((c) => (
              <option key={c} value={c}>
                {c === "HIGH" ? "High (≥85%)" : c === "MEDIUM" ? "Medium (70-85%)" : "Low (<70%)"}
              </option>
            ))}
          </select>

          <select
            value={oddsRange}
            onChange={(e) => setOddsRange(e.target.value)}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-white"
            aria-label="Filter by odds range"
          >
            <option value="">Odds: All Ranges</option>
            {ODDS_RANGES.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>

          <select
            value={rankPosition}
            onChange={(e) => setRankPosition(e.target.value)}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-white"
            aria-label="Filter by rank position"
          >
            <option value="">Rank: All Positions</option>
            {RANK_POSITIONS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>

          <select
            value={timeOfDay}
            onChange={(e) => setTimeOfDay(e.target.value)}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-white"
            aria-label="Filter by kickoff time"
          >
            <option value="">Kickoff: Any Time</option>
            <option value="Afternoon">Afternoon</option>
            <option value="Evening">Evening</option>
          </select>

          <select
            value={orientation}
            onChange={(e) => setOrientation(e.target.value)}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-white"
            aria-label="Filter by home / away"
          >
            <option value="">Side: Any Selection</option>
            <option value="Home">Home Picks</option>
            <option value="Away">Away Picks</option>
            <option value="Draw">Draw</option>
            <option value="Neutral">Neutral / Totals</option>
          </select>

          <select
            value={isLive}
            onChange={(e) => setIsLive(e.target.value)}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-white"
            aria-label="Filter by live vs pre-match"
          >
            <option value="">Timing: Pre & Live</option>
            <option value="prematch">Pre-Match</option>
            <option value="live">Live / In-Play</option>
          </select>

          <button
            onClick={resetFilters}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-3 py-1 text-xs text-slate-300 transition hover:text-white"
          >
            Reset Filters
          </button>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={exportCsv}
              disabled={!active || active.bets.length === 0}
              className="cursor-pointer rounded bg-emerald-500/15 px-3 py-1 text-xs font-bold text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-40"
            >
              ⇩ CSV
            </button>
            <button
              onClick={exportJson}
              disabled={!active || active.bets.length === 0}
              className="cursor-pointer rounded bg-cyan-500/15 px-3 py-1 text-xs font-bold text-cyan-300 transition hover:bg-cyan-500/25 disabled:opacity-40"
            >
              ⇩ JSON
            </button>
          </div>
        </div>
      </div>

      {loading && !data ? (
        <DashboardSkeleton />
      ) : error && !data ? (
        <ErrorState message={error} onRetry={() => load(query)} />
      ) : data && active ? (
        <>
          {error ? (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-2 text-xs text-rose-200">
              <span>Last refresh failed: {error}</span>
              <button
                onClick={() => load(query)}
                className="cursor-pointer rounded bg-rose-500/20 px-2 py-1 font-bold text-rose-100"
              >
                Retry
              </button>
            </div>
          ) : null}

          {/* Active Mode Header */}
          <div
            className={cn(
              "rounded-2xl border bg-slate-900 p-4.5 shadow-2xl transition",
              MODE_STYLES[active.mode].border,
              MODE_STYLES[active.mode].glow,
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2.5">
                  <span className={cn("h-3 w-3 rounded-full", MODE_STYLES[active.mode].dot)} />
                  <h3 className={cn("text-xl font-black tracking-tight", MODE_STYLES[active.mode].text)}>
                    {active.label}
                  </h3>
                  <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[11px] font-bold text-amber-300">
                    Overall Score: {active.summary.overallScore.toFixed(1)}/100
                  </span>
                </div>
                <p className="mt-1 max-w-2xl text-xs text-slate-300">{active.description}</p>
              </div>
              <div className="flex flex-wrap gap-4 font-mono text-[11px] text-slate-400">
                <span>
                  Window: <strong className="text-slate-200">{data.window.from}</strong> →{" "}
                  <strong className="text-slate-200">{data.window.to ?? "today"}</strong>
                </span>
                <span>
                  Bets: <strong className="text-slate-200">{active.summary.totalBets}</strong>
                </span>
                <span>
                  First: <strong className="text-slate-200">{active.summary.firstBetDate ?? "—"}</strong>
                </span>
              </div>
            </div>
          </div>

          {/* 2. Comprehensive Summary Cards */}
          <Section
            title="Summary Metrics"
            subtitle={`Headline performance and risk metrics for ${active.label}`}
          >
            <SummaryCards summary={active.summary} mode={active.mode} dailySeries={active.daily} />
          </Section>

          {/* 3. Mode Comparison Table */}
          <Section
            title="Comprehensive Mode Comparison"
            subtitle="All four ranking modes side by side — ★ marks the best-in-class value for each metric"
          >
            <ComprehensiveModeComparison rows={data.comparison} selected={active.mode} onSelect={setMode} />
          </Section>

          {/* 4. Consistency Analysis */}
          <Section
            title="Consistency & Risk Analysis"
            subtitle="Stability, volatility, daily P&L standard deviation, and maximum drawdown metrics"
          >
            <ConsistencyAnalysisPanel summary={active.summary} dailySeries={active.daily} />
          </Section>

          {/* 5. Tier Breakdown: Top 1 vs Top 3 vs Top 10 */}
          <Section
            title="Rank Tier Performance (Top 1 vs Top 3 vs Top 10)"
            subtitle="Comparing hit rate, EV, and confidence distributions across pick ranks — ranked picks are un-staked, so these cards are hit-rate only"
          >
            <TierBreakdownPanel
              top1={active.summary.top1Summary}
              top3={active.summary.top3Summary}
              top10={active.summary.top10Summary}
            />
          </Section>

          {/* 6. Factor Accuracy & Cross-Mode Heatmap */}
          <Section
            title="Factor Accuracy & Cross-Mode Heatmap"
            subtitle="How each ranking factor performed in this mode, plus a cross-mode comparison matrix"
          >
            <ExpandedFactorAccuracyPanel
              factors={active.factorAccuracy}
              factorsByMode={factorsByMode}
            />
          </Section>

          {/* 7. Expanded Trends with Interactive Charts */}
          <Section
            title="Trends & Visualizations"
            subtitle="Cumulative P&L, multi-mode trajectories, rolling 7-day momentum, outcome distribution, and calibration curve"
          >
            <ExpandedTrendPanels
              windows={active.windows}
              daily={active.daily}
              rolling={active.rolling}
              calibration={active.calibrationCurve}
              drawdowns={active.drawdowns}
              allModesSeries={allModesSeries}
              summary={active.summary}
            />
          </Section>

          {/* 8. Granular Breakdowns */}
          <div className="grid gap-6 xl:grid-cols-2">
            <Section title="Market Families" subtitle="Performance across market types">
              <BreakdownTable
                rows={active.marketFamilies}
                keyLabel="Market Family"
                emptyLabel="No market family data yet."
              />
            </Section>
            <Section title="Competitions & Leagues" subtitle="Where this mode generates its edge">
              <BreakdownTable
                rows={active.leagues}
                keyLabel="Competition"
                emptyLabel="No leagues yet."
              />
            </Section>
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Section title="Odds Bands" subtitle="Hit rate and ROI by price bracket">
              <BreakdownTable
                rows={active.oddsBands}
                keyLabel="Odds Band"
                emptyLabel="No priced bets yet."
                limit={8}
              />
            </Section>
            <Section title="Model Confidence Bands" subtitle="Predicted probability vs realised hit rate">
              <BreakdownTable
                rows={active.confidenceBands}
                keyLabel="Model Probability"
                emptyLabel="No probability data yet."
                limit={8}
              />
            </Section>
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Section title="Rank Position Breakdown" subtitle="How hit rate and ROI change by rank within the Top-10">
              <BreakdownTable
                rows={active.rankBuckets}
                keyLabel="Rank Position"
                emptyLabel="No ranked picks yet."
                limit={8}
              />
            </Section>
            <Section title="Kickoff Time of Day" subtitle="Afternoon vs Evening matches">
              <BreakdownTable
                rows={active.timeOfDayBands}
                keyLabel="Kickoff Window"
                emptyLabel="No time data yet."
                limit={4}
              />
            </Section>
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Section title="Home vs Away Selections" subtitle="Home / Away / Draw / Totals">
              <BreakdownTable
                rows={active.orientationBands}
                keyLabel="Selection Side"
                emptyLabel="No orientation data yet."
                limit={4}
              />
            </Section>
            <Section title="Live vs Pre-Match" subtitle="Pre-match vs in-play bets">
              <BreakdownTable
                rows={active.liveBands}
                keyLabel="Timing"
                emptyLabel="No live data yet."
                limit={4}
              />
            </Section>
          </div>

          {/* 9. Detailed Bet Log */}
          <Section
            title="Detailed Bet Log"
            subtitle={`${active.betsTotal} bet${active.betsTotal === 1 ? "" : "s"} · sortable, paginated, with expandable factor breakdowns`}
            right={
              <div className="flex flex-wrap gap-3 font-mono text-[11px] text-slate-400">
                <span>Hit {pctNum(active.summary.hitRate)}</span>
                <span className={active.summary.totalPnl >= 0 ? "text-emerald-300" : "text-rose-300"}>
                  P&L {money(active.summary.totalPnl)}
                </span>
                <span>Avg Odds {num(active.summary.averageOdds)}</span>
              </div>
            }
          >
            <BetsTable bets={active.bets} truncated={active.betsTruncated} />
          </Section>

          {/* 10. Automated Insights & Recommendations at the bottom */}
          {insights ? (
            <Section
              title="Automated Insights & Recommendations"
              subtitle="Data-driven league champions, market specialists, trend alerts, and risk warnings"
            >
              <AutomatedInsightsPanel insights={insights} />
            </Section>
          ) : null}

          {/* Methodology Card */}
          <Card>
            <p className="font-mono text-[10px] leading-relaxed text-slate-500">
              Methodology & Rigor · Hit rate = wins ÷ (wins + losses); pushes and voids are recorded in the counts but excluded from hit rate. ROI = P&L ÷ total stake (computed over staked products). Average odds are stake-weighted where stake data exists. 10/10 hits count matches where all ten ranked picks won. Model Calibration delta compares realized hit rate against published pre-match probabilities. Overall Score and Consistency Score are deterministic formulas combining hit rate, ROI, drawdown resistance, and daily volatility. Every aggregate is computed from actual underlying records.
            </p>
          </Card>
        </>
      ) : (
        <ErrorState message="No ranking mode data available." onRetry={() => load(query)} />
      )}
    </div>
  );
}
