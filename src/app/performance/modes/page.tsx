"use client";

// ĞIGI GIVØ — Ranking Mode Performance Dashboard.
//
// One page, four modes. The chips at the top (Classic A, 12-Factor B, Hybrid C,
// Consensus D) filter the ENTIRE page — summary cards, factor accuracy, trends,
// breakdowns and the bet-by-bet log all show only the selected mode. The
// side-by-side comparison stays visible so the four modes can be judged
// against each other at a glance.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PerformanceShell } from "@/app/_components/perf/PerformanceShell";
import { Card, ErrorState, Section, cn } from "@/app/_components/perf/ui";
import {
  BetsTable,
  BreakdownTable,
  DashboardSkeleton,
  FactorAccuracyPanel,
  MODE_STYLES,
  ModeChips,
  ModeComparison,
  SummaryCards,
  TrendPanels,
  betsToCsv,
  money,
  num,
  pctNum,
  type ModesApiResponse,
} from "@/app/_components/perf/modes";
import type { RankingModeKey } from "@/lib/performance/modeAnalytics";

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

export default function RankingModePerformancePage() {
  return (
    <Suspense
      fallback={
        <PerformanceShell title="Ranking Mode Performance" subtitle="Loading…">
          <DashboardSkeleton />
        </PerformanceShell>
      }
    >
      <ModesDashboard />
    </Suspense>
  );
}

function ModesDashboard() {
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

  const load = useCallback(
    (q: string) => {
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
    },
    [],
  );

  // Debounced reload whenever a filter changes (typing in the league/search box
  // must not fire a request per keystroke).
  useEffect(() => {
    const timer = window.setTimeout(() => load(query), 250);
    return () => window.clearTimeout(timer);
  }, [query, load]);

  const active = data?.modes.find((m) => m.mode === mode) ?? data?.modes[0] ?? null;

  const exportCsv = useCallback(() => {
    if (!active) return;
    const csv = betsToCsv(active.bets);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gigi-givo-performance-mode-${active.mode}-${data?.window.days ?? "30"}d.csv`;
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
  }, []);

  return (
    <PerformanceShell
      title="Ranking Mode Performance"
      subtitle="Full-detail, auditable track record for every ranking mode — Classic A, 12-Factor B, Hybrid C and Consensus D. Every number is a plain sum over the settled bets behind it."
    >
      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Link className="cursor-pointer text-amber-300 hover:underline" href="/performance">
          ← League performance
        </Link>
        <span className="text-slate-600">/</span>
        <span className="text-slate-400">Ranking-mode analysis</span>
        {data ? (
          <span className="ml-auto font-mono text-[10px] text-slate-500">
            {data.totals.performanceRows} match rows · {data.totals.valueBetRows} value bets ·{" "}
            {data.totals.slipRows} slips · updated {new Date(data.generatedAt).toLocaleTimeString()}
          </span>
        ) : null}
      </div>

      {/* Filters */}
      <div className="rounded-2xl border border-slate-700 bg-slate-900 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={cn(
                  "cursor-pointer rounded-full px-3 py-1.5 font-mono text-[11px] transition",
                  range === r.key
                    ? "bg-amber-400 font-bold text-slate-950"
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
            className="min-w-[160px] flex-1 rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-white placeholder:text-slate-500"
            aria-label="Filter by league"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search match / market"
            className="min-w-[160px] flex-1 rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-white placeholder:text-slate-500"
            aria-label="Search matches and markets"
          />
          <select
            value={result}
            onChange={(e) => setResult(e.target.value)}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white"
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
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white"
            aria-label="Filter by product"
          >
            <option value="">All products</option>
            {SOURCES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            onClick={resetFilters}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:text-white"
          >
            Reset
          </button>
          <button
            onClick={exportCsv}
            disabled={!active || active.bets.length === 0}
            className="cursor-pointer rounded bg-emerald-500/15 px-3 py-1.5 text-xs font-bold text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-40"
          >
            ⇩ Export CSV
          </button>
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
          {loading ? (
            <div className="font-mono text-[11px] text-amber-300">Refreshing performance data…</div>
          ) : null}

          {/* Mode chips — filter the whole page */}
          <ModeChips comparison={data.comparison} selected={active.mode} onSelect={setMode} />

          {/* Selected mode header */}
          <div
            className={cn(
              "rounded-2xl border bg-slate-900 p-4",
              MODE_STYLES[active.mode].border,
              MODE_STYLES[active.mode].glow,
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className={cn("text-lg font-extrabold", MODE_STYLES[active.mode].text)}>
                  {active.label}
                </h3>
                <p className="mt-0.5 max-w-2xl text-xs text-slate-400">{active.description}</p>
              </div>
              <div className="flex flex-wrap gap-4 font-mono text-[11px] text-slate-400">
                <span>
                  Window <span className="text-slate-200">{data.window.from}</span> →{" "}
                  <span className="text-slate-200">{data.window.to ?? "today"}</span>
                </span>
                <span>
                  Tracked <span className="text-slate-200">{active.summary.totalBets}</span> bets
                </span>
                <span>
                  First seen <span className="text-slate-200">{active.summary.firstBetDate ?? "—"}</span>
                </span>
              </div>
            </div>
          </div>

          <Section
            title="Summary"
            subtitle={`Headline metrics for ${active.label} in the selected window`}
          >
            <SummaryCards summary={active.summary} mode={active.mode} />
          </Section>

          <Section
            title="Mode Comparison"
            subtitle="All four ranking modes side by side — ★ marks the best value in each metric"
          >
            <ModeComparison rows={data.comparison} selected={active.mode} onSelect={setMode} />
          </Section>

          <Section title="Trends" subtitle="Cumulative P&L, daily hit rate and daily P&L">
            <TrendPanels windows={active.windows} />
          </Section>

          <div className="grid gap-6 xl:grid-cols-2">
            <Section
              title="Factor Accuracy"
              subtitle="How each ranking factor performed when it was active in this mode"
            >
              <FactorAccuracyPanel factors={active.factorAccuracy} />
            </Section>

            <div className="space-y-6">
              <Section title="Rank Tier" subtitle="Does the Top 1 really beat the Top 10?">
                <BreakdownTable
                  rows={active.rankBuckets}
                  keyLabel="Tier"
                  emptyLabel="No ranked picks in this window."
                  limit={6}
                />
              </Section>
              <Section title="Product" subtitle="Ranked picks vs value bets vs accumulators">
                <BreakdownTable
                  rows={active.sources}
                  keyLabel="Product"
                  emptyLabel="No tracked products in this window."
                  limit={5}
                />
              </Section>
            </div>
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Section title="Markets" subtitle="Most-tracked markets for this mode">
              <BreakdownTable rows={active.markets} keyLabel="Market" emptyLabel="No markets yet." />
            </Section>
            <Section title="Leagues" subtitle="Where this mode makes (or loses) its money">
              <BreakdownTable rows={active.leagues} keyLabel="Competition" emptyLabel="No leagues yet." />
            </Section>
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Section title="Odds Bands" subtitle="Hit rate and ROI by price bracket">
              <BreakdownTable rows={active.oddsBands} keyLabel="Odds" emptyLabel="No priced bets yet." limit={8} />
            </Section>
            <Section
              title="Model Confidence Bands"
              subtitle="Predicted probability vs what actually happened"
            >
              <BreakdownTable
                rows={active.confidenceBands}
                keyLabel="Model probability"
                emptyLabel="No probability data yet."
                limit={8}
              />
            </Section>
          </div>

          <Section
            title="Detailed Performance"
            subtitle={`${active.betsTotal} bet${active.betsTotal === 1 ? "" : "s"} · click a row arrow for the factor breakdown · sortable, paginated, exportable`}
            right={
              <div className="flex flex-wrap gap-3 font-mono text-[11px] text-slate-400">
                <span>Hit {pctNum(active.summary.hitRate)}</span>
                <span className={active.summary.totalPnl >= 0 ? "text-emerald-300" : "text-rose-300"}>
                  P&L {money(active.summary.totalPnl)}
                </span>
                <span>Avg odds {num(active.summary.averageOdds)}</span>
              </div>
            }
          >
            <BetsTable bets={active.bets} truncated={active.betsTruncated} />
          </Section>

          <Card>
            <p className="font-mono text-[10px] leading-relaxed text-slate-500">
              Methodology · Hit rate = wins ÷ (wins + losses); pushes and voids are excluded from the
              hit rate but shown in the counts. ROI = P&L ÷ total stake, so it is only defined for
              staked products (value bets and accumulators). Average odds are stake-weighted where
              stakes exist. 10/10 hits count matches where all ten ranked picks won. Calibration
              compares realised hit rate against the model probability the engine published before
              kick-off. No metric is smoothed, simulated or back-filled.
            </p>
          </Card>
        </>
      ) : (
        <ErrorState message="No ranking mode data available." onRetry={() => load(query)} />
      )}
    </PerformanceShell>
  );
}
