"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PerformanceShell } from "@/app/_components/perf/PerformanceShell";
import { AccuracyBars } from "@/app/_components/perf/charts";
import { AccuracyBreakdown, type FactorStat } from "@/app/_components/perf/AccuracyBreakdown";
import {
  cn,
  EmptyState,
  ErrorState,
  LoadingState,
  pct,
  Pill,
  ProgressBar,
  ResultBadge,
  Section,
  signedCurrency,
  SortHeader,
  StatCard,
  StreakBadge,
  type SortDir,
} from "@/app/_components/perf/ui";

// ─── API response shapes ──────────────────────────────────────────────────────

interface TopN {
  hits: number;
  total: number;
  accuracy: number;
}

interface AccaStats {
  total: number;
  won: number;
  lost: number;
  pending: number;
  settled: number;
  winRate: number;
  roi: number;
  totalStaked: number;
  totalReturns: number;
}

interface RecentPick {
  name: string;
  selection: string;
  hitRate?: number;
  outcome: string;
  family?: string;
  reason?: string;
}

interface RecentMatch {
  id: number;
  matchLabel: string;
  league: string;
  matchDate: string;
  homeScore: number;
  awayScore: number;
  hits: number;
  misses: number;
  pending: number;
  accuracy: number;
  totalPicks: number;
  top10Detail: RecentPick[];
  createdAt: string;
}

interface PerfData {
  totalMatches: number;
  totalPicks: number;
  totalHits: number;
  totalMisses: number;
  totalPending: number;
  totalVerified: number;
  overallAccuracy: number;
  perfectMatches: number;
  currentStreak: number;
  streakType: "W" | "L" | null;
  top1: TopN;
  top3: TopN;
  top10: TopN;
  recentMatches: RecentMatch[];
  // shape varies between success {all,highHit,value} and error fallback
  accumulatorPerformance?:
    | { all: AccaStats; highHit: AccaStats; value: AccaStats }
    | Partial<AccaStats>;
}

interface AccuracyData {
  cumulative?: {
    matches: number;
    hits: number;
    misses: number;
    total: number;
    accuracy: number;
    accuracyPct: string;
    perfectMatches: number;
    trend: string;
  };
  rolling7d?: { accuracyPct: string };
  daily?: Array<{ date: string; accuracy: number; matches: number }>;
}

interface CalibFamily {
  family: string;
  hits: number;
  misses: number;
  total: number;
  observed: number;
  currentCoeff: number;
  observedPct: string;
}

interface CalibData {
  overall?: { hits: number; misses: number; total: number; accuracy: number; accuracyPct: string };
  families?: CalibFamily[];
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OraclePerformancePage() {
  const [perf, setPerf] = useState<PerfData | null>(null);
  const [accuracy, setAccuracy] = useState<AccuracyData | null>(null);
  const [calib, setCalib] = useState<CalibData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    // Fetch-only: all state updates happen asynchronously in the promise chain
    // (initial `loading` already defaults to true via useState).
    const p = fetch("/api/performance").then((r) => {
      if (!r.ok) throw new Error(`Performance API returned ${r.status}`);
      return r.json() as Promise<PerfData>;
    });
    const a = fetch("/api/accuracy?days=30")
      .then((r) => r.json() as Promise<AccuracyData>)
      .catch(() => null);
    const c = fetch("/api/calibrate")
      .then((r) => r.json() as Promise<CalibData>)
      .catch(() => null);

    Promise.all([p, a, c])
      .then(([pData, aData, cData]) => {
        setPerf(pData);
        setAccuracy(aData);
        setCalib(cData);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Failed to load performance data");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    load();
  }, [load]);

  return (
    <PerformanceShell
      title="Oracle Performance"
      subtitle="Full transparency on every post-match verification — accuracy, streaks, per-factor reliability and daily trends. No hidden calculations."
    >
      {loading ? (
        <LoadingState label="Loading verified performance records…" />
      ) : error ? (
        <ErrorState message={error} onRetry={retry} />
      ) : !perf || perf.totalMatches === 0 ? (
        <EmptyState
          icon="📊"
          title="No verified matches yet"
          message="Run the oracle on a finished match — post-match verification results will appear here automatically."
        />
      ) : (
        <OracleContent perf={perf} accuracy={accuracy} calib={calib} />
      )}
    </PerformanceShell>
  );
}

function OracleContent({
  perf,
  accuracy,
  calib,
}: {
  perf: PerfData;
  accuracy: AccuracyData | null;
  calib: CalibData | null;
}) {
  // ── Flatten matches into a pick-level list for the sortable table ──────────
  const picks = useMemo(() => {
    return perf.recentMatches.flatMap((m) =>
      m.top10Detail.map((p, idx) => ({
        key: `${m.id}-${idx}`,
        date: m.matchDate,
        match: m.matchLabel,
        league: m.league,
        score: `${m.homeScore}-${m.awayScore}`,
        market: p.name,
        selection: p.selection,
        hitRate: p.hitRate ?? null,
        family: p.family ?? null,
        outcome: p.outcome,
        reason: p.reason ?? null,
      })),
    );
  }, [perf]);

  const [sortKey, setSortKey] = useState<"date" | "hitRate">("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sortedPicks = useMemo(() => {
    const arr = [...picks];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "date") cmp = (a.date ?? "").localeCompare(b.date ?? "");
      else cmp = (a.hitRate ?? -1) - (b.hitRate ?? -1);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [picks, sortKey, sortDir]);

  const toggleSort = (key: "date" | "hitRate") => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  // ── Bankroll summary from the staked products (accumulator slips) ──────────
  const accaAll =
    perf.accumulatorPerformance && "all" in (perf.accumulatorPerformance as object)
      ? (perf.accumulatorPerformance as { all: AccaStats }).all
      : (perf.accumulatorPerformance as Partial<AccaStats> | undefined);
  const bankStaked = accaAll?.totalStaked ?? 0;
  const bankReturns = accaAll?.totalReturns ?? 0;
  const bankPnl = bankReturns - bankStaked;
  const bankRoi = accaAll?.roi ?? (bankStaked > 0 ? (bankPnl / bankStaked) * 100 : 0);
  const hasBank = bankStaked > 0 || bankReturns > 0;

  // ── Accuracy breakdown factors from calibration data ───────────────────────
  const factors: FactorStat[] = useMemo(() => {
    return (calib?.families ?? []).map((f) => ({
      label: f.family,
      hits: f.hits,
      total: f.total,
      expected: f.currentCoeff,
      description: "Empirical hit rate — settled picks only",
    }));
  }, [calib]);

  const trendUp = (accuracy?.cumulative?.trend ?? "").includes("↑");
  const trendDown = (accuracy?.cumulative?.trend ?? "").includes("↓");

  return (
    <>
      {/* ── Summary Cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Overall Hit Rate"
          value={pct(perf.overallAccuracy)}
          sub={`${perf.totalHits} hits / ${perf.totalVerified} verified`}
          tone={perf.overallAccuracy >= 0.8 ? "positive" : perf.overallAccuracy >= 0.65 ? "info" : "negative"}
        />
        <StatCard
          label="Verified Picks"
          value={perf.totalVerified}
          sub={`of ${perf.totalPicks} logged`}
          tone="neutral"
        />
        <StatCard
          label="Top-1 Hit Rate"
          value={perf.top1.total > 0 ? pct(perf.top1.accuracy) : "—"}
          sub={perf.top1.total > 0 ? `${perf.top1.hits}/${perf.top1.total} matches` : "no data"}
          tone={perf.top1.accuracy >= 0.8 ? "positive" : perf.top1.accuracy >= 0.6 ? "info" : "negative"}
        />
        <StatCard
          label="Perfect Matches"
          value={perf.perfectMatches}
          sub={`of ${perf.totalMatches} matches`}
          tone="accent"
        />
        <StatCard
          label="Matches Tracked"
          value={perf.totalMatches}
          sub={`${perf.totalPending} picks pending`}
          tone="neutral"
        />
        <div className="flex flex-col justify-between rounded-xl border border-white/10 bg-black/50 p-4">
          <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Current Streak</span>
          <div className="mt-2">
            <StreakBadge count={perf.currentStreak} type={perf.streakType} />
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            {perf.streakType === "W" ? "perfect matches" : perf.streakType === "L" ? "matches with misses" : "no streak data"}
          </div>
        </div>
      </div>

      {/* W/L/P/V strip */}
      <div className="rounded-xl border border-white/10 bg-black/40 p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-slate-400">
            Win / Loss / Pending Breakdown
          </span>
          <span className="font-mono text-[11px] text-slate-500">settled picks</span>
        </div>
        <div className="flex flex-wrap items-stretch gap-2">
          <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 min-w-[80px]">
            <span className="font-mono text-lg font-extrabold tabular-nums text-emerald-300">{perf.totalHits}</span>
            <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-300">Wins</span>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-2 min-w-[80px]">
            <span className="font-mono text-lg font-extrabold tabular-nums text-rose-300">{perf.totalMisses}</span>
            <span className="text-[10px] font-bold uppercase tracking-wide text-rose-300">Losses</span>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 min-w-[80px]">
            <span className="font-mono text-lg font-extrabold tabular-nums text-amber-300">{perf.totalPending}</span>
            <span className="text-[10px] font-bold uppercase tracking-wide text-amber-300">Pending</span>
          </div>
        </div>
      </div>

      {/* Tier accuracy + bankroll */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Section title="Tier Hit Rate" subtitle="per-position accuracy" className="lg:col-span-2">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <TierCard label="Top 1" data={perf.top1} />
            <TierCard label="Top 3" data={perf.top3} />
            <TierCard label="Top 10" data={perf.top10} />
          </div>
        </Section>

        <Section title="Bankroll Summary" subtitle="from staked accumulators">
          {hasBank ? (
            <div className="space-y-2 rounded-xl border border-white/10 bg-black/40 p-4">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Staked</span>
                <span className="font-mono text-slate-200">{signedCurrency(bankStaked)}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Returns</span>
                <span className="font-mono text-emerald-300">{signedCurrency(bankReturns)}</span>
              </div>
              <div className="flex items-center justify-between border-t border-white/10 pt-2 text-sm">
                <span className="font-semibold text-white">Net P&amp;L</span>
                <span className={cn("font-mono font-extrabold", bankPnl >= 0 ? "text-emerald-300" : "text-rose-300")}>
                  {signedCurrency(bankPnl)}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-white">ROI</span>
                <span className={cn("font-mono font-extrabold", bankRoi >= 0 ? "text-emerald-300" : "text-rose-300")}>
                  {bankRoi >= 0 ? "+" : ""}
                  {bankRoi.toFixed(1)}%
                </span>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-white/10 bg-black/40 p-6 text-center font-mono text-xs text-slate-500">
              No staked slips settled yet — P&amp;L appears once accumulators resolve.
            </div>
          )}
        </Section>
      </div>

      {/* ── Accuracy Breakdown by factor ─────────────────────────────────── */}
      <Section
        title="Accuracy Breakdown by Factor"
        subtitle="Empirical hit rate per market family — see which signals are most reliable"
      >
        <AccuracyBreakdown factors={factors} />
      </Section>

      {/* ── Detailed sortable table ──────────────────────────────────────── */}
      <Section
        title="Detailed Performance Table"
        subtitle={`${sortedPicks.length} verified picks · sorted by ${sortKey === "date" ? "date" : "hit rate"}`}
      >
        {sortedPicks.length === 0 ? (
          <EmptyState icon="📋" title="No verified picks yet" message="Picks appear here once matches are verified." />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-white/10 bg-black/50">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/10 bg-black/40">
                <tr>
                  <SortHeader label="Date" active={sortKey === "date"} dir={sortDir} onClick={() => toggleSort("date")} />
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Match</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Market</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Selection</th>
                  <SortHeader label="Hit Rate" active={sortKey === "hitRate"} dir={sortDir} onClick={() => toggleSort("hitRate")} align="right" />
                  <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">Result</th>
                  <th className="hidden px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400 sm:table-cell">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {sortedPicks.map((p) => {
                  const { result, label } = classify(p.outcome);
                  const rowTint =
                    result === "win"
                      ? "border-l-emerald-500"
                      : result === "loss"
                        ? "border-l-rose-500"
                        : result === "pending"
                          ? "border-l-amber-500"
                          : "border-l-slate-600";
                  return (
                    <tr key={p.key} className={cn("border-l-2 transition hover:bg-white/[0.02]", rowTint)}>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-slate-400">{p.date}</td>
                      <td className="px-3 py-2">
                        <div className="max-w-[180px] truncate font-medium text-slate-100">{p.match}</div>
                        <div className="font-mono text-[10px] text-slate-500">
                          {p.league} · {p.score}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="max-w-[160px] truncate text-slate-200">{p.market}</div>
                        {p.family ? (
                          <span className="font-mono text-[10px] text-amber-300/70">{p.family}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[11px] font-bold text-emerald-300">
                          {p.selection}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {p.hitRate !== null ? (
                          <span className="font-mono text-xs font-bold text-emerald-300">{pct(p.hitRate, 0)}</span>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <ResultBadge result={result} label={label} />
                      </td>
                      <td className="hidden max-w-[200px] px-3 py-2 sm:table-cell">
                        <span className="line-clamp-2 text-[11px] text-slate-400">{p.reason ?? "—"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Trends ───────────────────────────────────────────────────────── */}
      <Section
        title="Accuracy Trends"
        subtitle="daily hit rate over the last 30 days"
        right={
          accuracy?.cumulative ? (
            <div className="flex flex-wrap gap-2">
              <span className="rounded-md border border-white/10 bg-black/50 px-2.5 py-1 font-mono text-[11px] text-slate-300">
                30d: <span className="font-bold text-white">{accuracy.cumulative.accuracyPct}</span>
              </span>
              {accuracy.rolling7d ? (
                <span className="rounded-md border border-white/10 bg-black/50 px-2.5 py-1 font-mono text-[11px] text-slate-300">
                  7d: <span className="font-bold text-cyan-300">{accuracy.rolling7d.accuracyPct}</span>
                </span>
              ) : null}
              <span
                className={cn(
                  "rounded-md border px-2.5 py-1 font-mono text-[11px] font-bold",
                  trendUp
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : trendDown
                      ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-300",
                )}
              >
                {accuracy.cumulative.trend}
              </span>
            </div>
          ) : null
        }
      >
        <AccuracyBars daily={accuracy?.daily ?? []} />
      </Section>
    </>
  );
}

function TierCard({ label, data }: { label: string; data: TopN }) {
  const rate = data.total > 0 ? data.accuracy : 0;
  const tone = rate >= 0.8 ? "positive" : rate >= 0.65 ? "info" : rate >= 0.5 ? "warning" : "negative";
  const text =
    tone === "positive" ? "text-emerald-300" : tone === "info" ? "text-cyan-300" : tone === "warning" ? "text-amber-300" : "text-rose-300";
  return (
    <div className="rounded-xl border border-white/10 bg-black/50 p-4">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-xs font-bold text-white">{label}</span>
        <span className={cn("font-mono text-2xl font-extrabold tabular-nums", data.total > 0 ? text : "text-slate-600")}>
          {data.total > 0 ? pct(rate, 0) : "—"}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-slate-400">
        {data.total > 0 ? `${data.hits} hit · ${data.total - data.hits} miss · ${data.total} picks` : "no settled picks"}
      </div>
      <ProgressBar value={rate} tone={tone} className="mt-2" />
    </div>
  );
}

/** local outcome classifier (keeps this page self-contained) */
function classify(raw: string) {
  const v = (raw ?? "").toString().toUpperCase();
  if (v === "HIT") return { result: "win" as const, label: "WIN" };
  if (v === "MISS") return { result: "loss" as const, label: "LOSS" };
  if (v === "PUSH") return { result: "push" as const, label: "PUSH" };
  if (v === "VOID") return { result: "void" as const, label: "VOID" };
  return { result: "pending" as const, label: "PENDING" };
}
