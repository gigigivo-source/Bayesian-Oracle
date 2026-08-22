"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PerformanceShell } from "@/app/_components/perf/PerformanceShell";
import { PnLTrendChart, Sparkline, type TrendPoint } from "@/app/_components/perf/charts";
import { AccuracyBreakdown, type FactorStat } from "@/app/_components/perf/AccuracyBreakdown";
import { LEAGUE_MAP } from "@/lib/leagues";
import {
  classifyOutcome,
  cn,
  EmptyState,
  ErrorState,
  LoadingState,
  pct,
  Pill,
  ResultBadge,
  Section,
  signed,
  signedCurrency,
  SortHeader,
  StatCard,
  StreakBadge,
  type SortDir,
} from "@/app/_components/perf/ui";

interface ValueBet {
  id: number;
  match: string;
  league?: string;
  matchDate: string;
  marketName: string;
  selection: string;
  oracleProb: number;
  bookOdds: number;
  valueEdge: number;
  kellyStake: number;
  stake: number;
  potentialReturn: number;
  outcome: string; // pending | won | lost | void
  actualReturn: number | null;
  pnl: number | null;
  createdAt: string;
}

interface VbStats {
  total: number;
  won: number;
  lost: number;
  pending: number;
  settled: number;
  winRate: number;
  roi: number;
  totalStaked: number;
  totalReturns: number;
  totalPnl: number;
  avgEdge: number; // already *100 in the API
}

interface ValueBetsResponse {
  bets: ValueBet[];
  stats: VbStats;
}

// ─── Derivations (transparent, client-side) ───────────────────────────────────

/** Expected value of a $1 stake: oracleProb × odds − 1. */
function evPerUnit(b: ValueBet): number {
  return b.oracleProb * b.bookOdds - 1;
}

function familyOf(market: string): string {
  const m = market.toLowerCase();
  if (m.includes("goals") || m.includes("btts") || m.includes("both teams") || m.includes("clean sheet")) return "Goals";
  if (m.includes("match result") || m.includes("double chance") || m.includes("draw no bet")) return "Match Result";
  if (m.includes("corners")) return "Corners";
  if (m.includes("cards")) return "Yellow Cards";
  if (m.includes("sot") || m.includes("shots on target")) return "Shots on Target";
  if (m.includes("shots")) return "Shots Towards Goal";
  if (m.includes("saves") || m.includes("gk")) return "Saves";
  if (m.includes("offsides")) return "Offsides";
  if (m.includes("fouls")) return "Fouls";
  return "Other";
}

function dateKey(b: ValueBet): string {
  return (b.matchDate || b.createdAt || "").slice(0, 10);
}

/** Human-readable competition name for a stored league slug. */
function competitionNameFor(slug: string | undefined | null): string {
  if (!slug) return "Unknown";
  return LEAGUE_MAP[slug]?.name ?? slug;
}

export default function ValueBetsPerformancePage() {
  const [data, setData] = useState<ValueBetsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    // Fetch-only: all state updates happen asynchronously in the promise chain
    // (initial `loading` already defaults to true via useState).
    fetch("/api/value-bets")
      .then((r) => {
        if (!r.ok) throw new Error(`Value bets API returned ${r.status}`);
        return r.json() as Promise<ValueBetsResponse>;
      })
      .then((d) => setData(d))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load value bets"))
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
      title="Value Bet Performance"
      subtitle="Every tracked value bet with full transparency — ROI, hit rate, profit/loss per bet, EV, average odds and streaks. Colour-coded by result."
    >
      {loading ? (
        <LoadingState label="Loading value bet tracker…" />
      ) : error ? (
        <ErrorState message={error} onRetry={retry} />
      ) : !data || data.bets.length === 0 ? (
        <EmptyState
          icon="💰"
          title="No value bets tracked yet"
          message="Value bets are logged automatically when you view a match with a positive oracle edge. They verify after each match finishes."
        />
      ) : (
        <ValueBetsContent bets={data.bets} stats={data.stats} />
      )}
    </PerformanceShell>
  );
}

function ValueBetsContent({ bets, stats }: { bets: ValueBet[]; stats: VbStats }) {
  const [sortKey, setSortKey] = useState<"date" | "odds" | "pnl" | "ev">("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [leagueFilter, setLeagueFilter] = useState<string>("all");

  // Competitions present in the data (slug → name), sorted alphabetically.
  const leagueOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of bets) {
      const slug = b.league ?? "unknown";
      if (!map.has(slug)) map.set(slug, competitionNameFor(slug));
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [bets]);

  const visibleBets = useMemo(
    () => (leagueFilter === "all" ? bets : bets.filter((b) => (b.league ?? "unknown") === leagueFilter)),
    [bets, leagueFilter],
  );

  const settled = useMemo(() => visibleBets.filter((b) => b.outcome === "won" || b.outcome === "lost"), [visibleBets]);
  const won = visibleBets.filter((b) => b.outcome === "won");
  const lost = visibleBets.filter((b) => b.outcome === "lost");
  const voids = visibleBets.filter((b) => b.outcome === "void");
  const pending = visibleBets.filter((b) => b.outcome === "pending");
  const voidCount = voids.length;

  const hitRate = settled.length > 0 ? (won.length / settled.length) : 0;

  // Weighted average odds (by stake, across settled bets)
  const avgOdds = useMemo(() => {
    const weighted = settled.reduce((s, b) => s + (b.stake ?? 10) * b.bookOdds, 0);
    const totalStake = settled.reduce((s, b) => s + (b.stake ?? 10), 0);
    return totalStake > 0 ? weighted / totalStake : 0;
  }, [settled]);

  // Average EV (per $1) across all visible bets
  const avgEv = useMemo(() => {
    if (visibleBets.length === 0) return 0;
    return visibleBets.reduce((s, b) => s + evPerUnit(b), 0) / visibleBets.length;
  }, [visibleBets]);

  // Current streak over settled bets ordered by date (newest first)
  const streak = useMemo(() => {
    const ordered = [...settled].sort((a, b) => dateKey(b).localeCompare(dateKey(a)));
    if (ordered.length === 0) return { count: 0, type: null as "W" | "L" | null };
    let count = 0;
    let type: "W" | "L" | null = null;
    for (const b of ordered) {
      const isWin = b.outcome === "won";
      if (type === null) {
        type = isWin ? "W" : "L";
        count = 1;
      } else if ((type === "W") === isWin) {
        count++;
      } else break;
    }
    return { count, type };
  }, [settled]);

  // Cumulative P&L trend over settled bets (chronological)
  const trendPoints: TrendPoint[] = useMemo(() => {
    const ordered = [...settled].sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
    const byDate: Record<string, number> = {};
    ordered.forEach((b) => {
      const k = dateKey(b);
      byDate[k] = (byDate[k] ?? 0) + (b.pnl ?? 0);
    });
    return Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .reduce((acc, [k, delta]) => {
        const prev = acc.length > 0 ? acc[acc.length - 1].value : 0;
        acc.push({ label: k.slice(5), value: prev + delta, delta });
        return acc;
      }, [] as TrendPoint[]);
  }, [settled]);

  // Accuracy breakdown by market family
  const factors: FactorStat[] = useMemo(() => {
    const map: Record<string, { hits: number; total: number }> = {};
    for (const b of settled) {
      const fam = familyOf(b.marketName);
      if (!map[fam]) map[fam] = { hits: 0, total: 0 };
      map[fam].total++;
      if (b.outcome === "won") map[fam].hits++;
    }
    return Object.entries(map).map(([label, v]) => ({ label, hits: v.hits, total: v.total }));
  }, [settled]);

  const sortedBets = useMemo(() => {
    const arr = [...visibleBets];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "date") cmp = dateKey(a).localeCompare(dateKey(b));
      else if (sortKey === "odds") cmp = a.bookOdds - b.bookOdds;
      else if (sortKey === "pnl") cmp = (a.pnl ?? -Infinity) - (b.pnl ?? -Infinity);
      else cmp = evPerUnit(a) - evPerUnit(b);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [visibleBets, sortKey, sortDir]);

  const toggleSort = (key: "date" | "odds" | "pnl" | "ev") => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  return (
    <>
      {/* ── Summary Cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-3 lg:gap-6 xl:grid-cols-4">
        <StatCard
          label="Total Bets"
          value={stats.total}
          sub={`${stats.settled} settled · ${pending.length} pending`}
          tone="neutral"
        />
        <StatCard
          label="Hit Rate"
          value={settled.length > 0 ? pct(hitRate, 0) : "—"}
          sub={`${won.length}W / ${lost.length}L`}
          tone={hitRate >= 0.55 ? "positive" : hitRate > 0 ? "warning" : "neutral"}
        />
        <StatCard
          label="Total P&L"
          value={signedCurrency(stats.totalPnl)}
          sub={`of ${signedCurrency(stats.totalStaked)} staked`}
          tone={stats.totalPnl >= 0 ? "positive" : "negative"}
        />
        <StatCard
          label="ROI"
          value={`${stats.roi >= 0 ? "+" : ""}${stats.roi.toFixed(1)}%`}
          sub={`${signedCurrency(stats.totalReturns)} returned`}
          tone={stats.roi >= 0 ? "positive" : "negative"}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-3 lg:gap-6 xl:grid-cols-4">
        <StatCard
          label="Avg Odds (weighted)"
          value={settled.length > 0 ? avgOdds.toFixed(2) : "—"}
          sub={`stake-weighted, settled`}
          tone="info"
        />
        <StatCard
          label="Avg EV"
          value={signed(avgEv * 100, 1) + "%"}
          sub={`avg edge ${signed(stats.avgEdge, 1)}%`}
          tone={avgEv >= 0 ? "positive" : "negative"}
        />
        <div className="responsive-card flex flex-col justify-between rounded-lg border border-slate-700 bg-slate-800 transition-all duration-200 hover:-translate-y-2 hover:shadow-2xl">
          <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Current Streak</span>
          <div className="mt-2">
            <StreakBadge count={streak.count} type={streak.type} />
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            {streak.type === "W" ? "winning run" : streak.type === "L" ? "losing run" : "no settled bets"}
          </div>
        </div>
        <div className="responsive-card flex flex-col justify-between rounded-lg border border-slate-700 bg-slate-800 transition-all duration-200 hover:-translate-y-2 hover:shadow-2xl">
          <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Result Mix</span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Pill tone="win">{won.length} W</Pill>
            <Pill tone="loss">{lost.length} L</Pill>
            {voidCount > 0 ? <Pill tone="void">{voidCount} V</Pill> : null}
            <Pill tone="pending">{pending.length} ⏳</Pill>
          </div>
        </div>
      </div>

      {/* ── Trends ───────────────────────────────────────────────────────── */}
      <Section title="Profit / Loss Trend" subtitle="cumulative P&L across settled value bets">
        <div className="responsive-card rounded-lg border border-slate-700 bg-slate-800 transition-all duration-200 hover:-translate-y-2 hover:shadow-2xl">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-slate-400">Final P&amp;L</span>
              <span className={cn("font-mono text-lg font-extrabold", stats.totalPnl >= 0 ? "text-emerald-300" : "text-rose-300")}>
                {signedCurrency(stats.totalPnl)}
              </span>
            </div>
            <div className="h-9 w-40 opacity-90">
              <Sparkline values={trendPoints.map((p) => p.value)} />
            </div>
          </div>
          <PnLTrendChart points={trendPoints} />
        </div>
      </Section>

      {/* ── Accuracy Breakdown ───────────────────────────────────────────── */}
      <Section
        title="Accuracy Breakdown by Market"
        subtitle="hit rate per market family — see where your edge converts"
      >
        <AccuracyBreakdown factors={factors} />
      </Section>

      {/* ── Detailed sortable table ──────────────────────────────────────── */}
      <Section
        title="Detailed Performance Table"
        subtitle={`${sortedBets.length} bets · sorted by ${sortKey} (${sortDir})`}
        right={
          <select
            value={leagueFilter}
            onChange={(e) => setLeagueFilter(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 focus:border-amber-400/50 focus:outline-none"
          >
            <option value="all">All competitions ({bets.length})</option>
            {leagueOptions.map(([slug, name]) => (
              <option key={slug} value={slug}>
                {name} ({bets.filter((b) => (b.league ?? "unknown") === slug).length})
              </option>
            ))}
          </select>
        }
      >
        <div className="table-scroll rounded-xl border border-slate-700 bg-slate-900">
          <table className="responsive-table w-full min-w-[500px] text-left text-xs sm:min-w-full sm:text-sm">
            <thead className="sticky top-0 z-10 border-b border-slate-700 bg-slate-800">
              <tr>
                <SortHeader label="Date" active={sortKey === "date"} dir={sortDir} onClick={() => toggleSort("date")} />
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Competition</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Match / Market</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Selection</th>
                <SortHeader label="Odds" active={sortKey === "odds"} dir={sortDir} onClick={() => toggleSort("odds")} align="right" />
                <SortHeader label="EV" active={sortKey === "ev"} dir={sortDir} onClick={() => toggleSort("ev")} align="right" />
                <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">Result</th>
                <SortHeader label="P&L" active={sortKey === "pnl"} dir={sortDir} onClick={() => toggleSort("pnl")} align="right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {sortedBets.map((b) => {
                const { result, label } = classifyOutcome(b.outcome);
                const rowTint =
                  result === "win"
                    ? "border-l-emerald-500"
                    : result === "loss"
                      ? "border-l-rose-500"
                      : result === "pending"
                        ? "border-l-amber-500"
                        : "border-l-slate-600";
                const ev = evPerUnit(b);
                return (
                  <tr key={b.id} className={cn("border-l-2 transition hover:bg-slate-800", rowTint)}>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-slate-400">{dateKey(b)}</td>
                    <td className="max-w-[140px] truncate px-3 py-2">
                      <div className="truncate text-[11px] font-semibold text-slate-200">{competitionNameFor(b.league)}</div>
                      <div className="truncate font-mono text-[10px] text-slate-500">{b.league}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="max-w-[180px] truncate font-medium text-slate-100">{b.match}</div>
                      <div className="max-w-[180px] truncate text-[11px] text-slate-400">
                        {b.marketName} <span className="text-amber-300/60">· {familyOf(b.marketName)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[11px] font-bold text-emerald-300">
                        {b.selection}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-100">{b.bookOdds.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={cn("font-mono text-xs font-bold", ev >= 0 ? "text-emerald-300" : "text-rose-300")}>
                        {signed(ev * 100, 1)}%
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <ResultBadge result={result} label={label} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-bold">
                      {b.pnl !== null && b.pnl !== undefined ? (
                        <span className={b.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{signedCurrency(b.pnl)}</span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
