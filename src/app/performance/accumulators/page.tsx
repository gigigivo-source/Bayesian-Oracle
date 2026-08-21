"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { PerformanceShell } from "@/app/_components/perf/PerformanceShell";
import { PnLTrendChart, Sparkline, type TrendPoint } from "@/app/_components/perf/charts";
import { AccuracyBreakdown, type FactorStat } from "@/app/_components/perf/AccuracyBreakdown";
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
  type BetResult,
  type SortDir,
} from "@/app/_components/perf/ui";
import { LEAGUE_MAP } from "@/lib/leagues";

function competitionNameFor(slug: string | undefined | null): string | null {
  if (!slug) return null;
  return LEAGUE_MAP[slug]?.name ?? slug;
}

interface AccaLeg {
  matchLabel?: string;
  league?: string;
  marketName?: string;
  selection?: string;
  hitRate?: number;
  family?: string;
  date?: string;
  outcome?: string; // HIT | MISS | PENDING
}

interface Slip {
  id: number;
  name: string;
  slipType: string; // highhit | value
  picks: AccaLeg[];
  combinedOdds: number;
  combinedProb: number;
  stake: number | null;
  status: string; // pending | won | lost | void
  createdAt: string;
}

interface SlipsResponse {
  slips: Slip[];
}

// ─── Derivations ──────────────────────────────────────────────────────────────

function dateKey(s: Slip): string {
  return (s.createdAt || "").slice(0, 10);
}

function stakeOf(s: Slip): number {
  return s.stake ?? 10;
}

/** Net P&L for a settled slip. */
function slipPnl(s: Slip): number | null {
  if (s.status === "won") return stakeOf(s) * (s.combinedOdds ?? 1) - stakeOf(s);
  if (s.status === "lost") return -stakeOf(s);
  return null;
}

function slipResult(status: string): { result: BetResult; label: string } {
  return classifyOutcome(status);
}

function familyOf(market: string): string {
  const m = (market ?? "").toLowerCase();
  if (m.includes("goals") || m.includes("btts") || m.includes("both teams") || m.includes("clean sheet")) return "Goals";
  if (m.includes("match result") || m.includes("double chance") || m.includes("draw no bet")) return "Match Result";
  if (m.includes("corners")) return "Corners";
  if (m.includes("cards")) return "Yellow Cards";
  if (m.includes("sot") || m.includes("shots on target")) return "Shots on Target";
  if (m.includes("shots")) return "Shots Towards Goal";
  if (m.includes("saves")) return "Saves";
  if (m.includes("offsides")) return "Offsides";
  return "Other";
}

function typeLabel(slipType: string): string {
  return slipType === "value" ? "💎 Value" : "🔒 High-Hit";
}

export default function AccumulatorsPerformancePage() {
  const [slips, setSlips] = useState<Slip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    // Fetch-only: all state updates happen asynchronously in the promise chain
    // (initial `loading` already defaults to true via useState).
    fetch("/api/slips")
      .then((r) => {
        if (!r.ok) throw new Error(`Slips API returned ${r.status}`);
        return r.json() as Promise<SlipsResponse>;
      })
      .then((d) => setSlips(d.slips ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load accumulator slips"))
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
      title="Accumulator Performance"
      subtitle="Every tracked slip with full transparency — ROI, win rate, profit/loss, average combined odds and streaks, broken down by slip type. Colour-coded by result."
    >
      {loading ? (
        <LoadingState label="Loading accumulator slips…" />
      ) : error ? (
        <ErrorState message={error} onRetry={retry} />
      ) : slips.length === 0 ? (
        <EmptyState
          icon="📋"
          title="No accumulator slips tracked yet"
          message="Slips are tracked automatically from the Accumulators tab and verified after each leg settles. Performance appears here once slips resolve."
        />
      ) : (
        <AccaContent slips={slips} onRefresh={load} />
      )}
    </PerformanceShell>
  );
}

function AccaContent({ slips, onRefresh }: { slips: Slip[]; onRefresh: () => void }) {
  const [sortKey, setSortKey] = useState<"date" | "odds" | "pnl">("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expanded, setExpanded] = useState<number | null>(null);

  const settled = useMemo(() => slips.filter((s) => s.status === "won" || s.status === "lost"), [slips]);
  const won = slips.filter((s) => s.status === "won");
  const lost = slips.filter((s) => s.status === "lost");
  const voids = slips.filter((s) => s.status === "void");
  const pending = slips.filter((s) => s.status === "pending");

  const winRate = settled.length > 0 ? won.length / settled.length : 0;
  const totalStaked = settled.reduce((s, r) => s + stakeOf(r), 0);
  const totalReturns = won.reduce((s, r) => s + stakeOf(r) * (r.combinedOdds ?? 1), 0);
  const totalPnl = totalReturns - totalStaked;
  const roi = totalStaked > 0 ? (totalPnl / totalStaked) * 100 : 0;

  // Average combined odds (stake-weighted, settled)
  const avgOdds = useMemo(() => {
    const w = settled.reduce((s, r) => s + stakeOf(r) * (r.combinedOdds ?? 1), 0);
    const t = settled.reduce((s, r) => s + stakeOf(r), 0);
    return t > 0 ? w / t : 0;
  }, [settled]);

  const avgLegs = slips.length > 0 ? slips.reduce((s, r) => s + r.picks.length, 0) / slips.length : 0;

  // Current streak over settled slips (newest first)
  const streak = useMemo(() => {
    const ordered = [...settled].sort((a, b) => dateKey(b).localeCompare(dateKey(a)));
    if (ordered.length === 0) return { count: 0, type: null as "W" | "L" | null };
    let count = 0;
    let type: "W" | "L" | null = null;
    for (const s of ordered) {
      const isWin = s.status === "won";
      if (type === null) {
        type = isWin ? "W" : "L";
        count = 1;
      } else if ((type === "W") === isWin) count++;
      else break;
    }
    return { count, type };
  }, [settled]);

  // Cumulative P&L trend over settled slips (chronological)
  const trendPoints: TrendPoint[] = useMemo(() => {
    const ordered = [...settled].sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
    const byDate: Record<string, number> = {};
    ordered.forEach((s) => {
      const k = dateKey(s);
      byDate[k] = (byDate[k] ?? 0) + (slipPnl(s) ?? 0);
    });
    return Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .reduce((acc, [k, delta]) => {
        const prev = acc.length > 0 ? acc[acc.length - 1].value : 0;
        acc.push({ label: k.slice(5), value: prev + delta, delta });
        return acc;
      }, [] as TrendPoint[]);
  }, [settled]);

  // Accuracy breakdown by slip type
  const typeFactors: FactorStat[] = useMemo(() => {
    const types = Array.from(new Set(slips.map((s) => s.slipType || "highhit")));
    return types.map((t) => {
      const group = slips.filter((s) => (s.slipType || "highhit") === t && (s.status === "won" || s.status === "lost"));
      const hits = group.filter((s) => s.status === "won").length;
      return { label: typeLabel(t), hits, total: group.length, description: `${group.length} settled slips` };
    });
  }, [slips]);

  // Leg-level hit rate by market family
  const legFactors: FactorStat[] = useMemo(() => {
    const map: Record<string, { hits: number; total: number }> = {};
    for (const s of slips) {
      for (const leg of s.picks) {
        if (leg.outcome !== "HIT" && leg.outcome !== "MISS") continue;
        const fam = familyOf(leg.marketName ?? leg.family ?? "");
        if (!map[fam]) map[fam] = { hits: 0, total: 0 };
        map[fam].total++;
        if (leg.outcome === "HIT") map[fam].hits++;
      }
    }
    return Object.entries(map).map(([label, v]) => ({ label, hits: v.hits, total: v.total }));
  }, [slips]);

  const sortedSlips = useMemo(() => {
    const arr = [...slips];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "date") cmp = dateKey(a).localeCompare(dateKey(b));
      else if (sortKey === "odds") cmp = (a.combinedOdds ?? 0) - (b.combinedOdds ?? 0);
      else cmp = (slipPnl(a) ?? -Infinity) - (slipPnl(b) ?? -Infinity);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [slips, sortKey, sortDir]);

  const toggleSort = (key: "date" | "odds" | "pnl") => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  return (
    <>
      {/* ── Summary Cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-4">
        <StatCard label="Total Slips" value={slips.length} sub={`${settled.length} settled · ${pending.length} pending`} tone="neutral" />
        <StatCard
          label="Win Rate"
          value={settled.length > 0 ? pct(winRate, 0) : "—"}
          sub={`${won.length}W / ${lost.length}L`}
          tone={winRate >= 0.5 ? "positive" : winRate > 0 ? "warning" : "neutral"}
        />
        <StatCard
          label="Total P&L"
          value={signedCurrency(totalPnl)}
          sub={`of ${signedCurrency(totalStaked)} staked`}
          tone={totalPnl >= 0 ? "positive" : "negative"}
        />
        <StatCard
          label="ROI"
          value={`${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%`}
          sub={`${signedCurrency(totalReturns)} returned`}
          tone={roi >= 0 ? "positive" : "negative"}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-4">
        <StatCard
          label="Avg Combined Odds"
          value={settled.length > 0 ? avgOdds.toFixed(2) : "—"}
          sub={`stake-weighted, settled`}
          tone="info"
        />
        <StatCard label="Avg Legs" value={avgLegs.toFixed(1)} sub={`across ${slips.length} slips`} tone="accent" />
        <div className="flex flex-col justify-between rounded-xl border border-white/10 bg-black/50 p-4">
          <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Current Streak</span>
          <div className="mt-2">
            <StreakBadge count={streak.count} type={streak.type} />
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            {streak.type === "W" ? "winning slips" : streak.type === "L" ? "losing slips" : "no settled slips"}
          </div>
        </div>
        <div className="flex flex-col justify-between rounded-xl border border-white/10 bg-black/50 p-4">
          <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Result Mix</span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Pill tone="win">{won.length} W</Pill>
            <Pill tone="loss">{lost.length} L</Pill>
            {voids.length > 0 ? <Pill tone="void">{voids.length} V</Pill> : null}
            <Pill tone="pending">{pending.length} ⏳</Pill>
          </div>
        </div>
      </div>

      {/* ── Trends ───────────────────────────────────────────────────────── */}
      <Section
        title="Profit / Loss Trend"
        subtitle="cumulative P&L across settled accumulators"
        right={
          <button
            onClick={onRefresh}
            className="rounded-lg border border-white/15 bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-white/10"
          >
            ↻ Refresh
          </button>
        }
      >
        <div className="rounded-xl border border-white/10 bg-black/50 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-slate-400">Final P&amp;L</span>
              <span className={cn("font-mono text-lg font-extrabold", totalPnl >= 0 ? "text-emerald-300" : "text-rose-300")}>
                {signedCurrency(totalPnl)}
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
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Section title="Win Rate by Slip Type" subtitle="which slip strategy converts best">
          <AccuracyBreakdown factors={typeFactors} />
        </Section>
        <Section title="Leg Hit Rate by Market" subtitle="per-leg reliability by market family">
          <AccuracyBreakdown
            factors={legFactors}
            emptyLabel="No settled legs yet — leg outcomes resolve as matches finish."
          />
        </Section>
      </div>

      {/* ── Detailed table ───────────────────────────────────────────────── */}
      <Section
        title="Detailed Performance Table"
        subtitle={`${sortedSlips.length} slips · click a row to expand its legs · sorted by ${sortKey}`}
      >
        <div className="overflow-hidden rounded-xl border border-white/10 bg-black/50">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/10 bg-black/40">
                <tr>
                  <SortHeader label="Date" active={sortKey === "date"} dir={sortDir} onClick={() => toggleSort("date")} />
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Slip</th>
                  <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">Type</th>
                  <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">Legs</th>
                  <SortHeader label="Odds" active={sortKey === "odds"} dir={sortDir} onClick={() => toggleSort("odds")} align="right" />
                  <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">Result</th>
                  <SortHeader label="P&L" active={sortKey === "pnl"} dir={sortDir} onClick={() => toggleSort("pnl")} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {sortedSlips.map((s) => {
                  const { result, label } = slipResult(s.status);
                  const rowTint =
                    result === "win"
                      ? "border-l-emerald-500"
                      : result === "loss"
                        ? "border-l-rose-500"
                        : result === "pending"
                          ? "border-l-amber-500"
                          : "border-l-slate-600";
                  const pnl = slipPnl(s);
                  const isOpen = expanded === s.id;
                  return (
                    <Fragment key={s.id}>
                      <tr
                        className={cn("cursor-pointer border-l-2 transition hover:bg-white/[0.02]", rowTint)}
                        onClick={() => setExpanded(isOpen ? null : s.id)}
                      >
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-slate-400">{dateKey(s)}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-500">{isOpen ? "▾" : "▸"}</span>
                            <div className="min-w-0">
                              <div className="max-w-[220px] truncate font-medium text-slate-100">{s.name}</div>
                              <div className="font-mono text-[10px] text-slate-500">
                                stake {signedCurrency(stakeOf(s))} · {pct(s.combinedProb, 0)} prob
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className={cn("rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold", s.slipType === "value" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300")}>
                            {typeLabel(s.slipType)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center font-mono text-slate-200">{s.picks.length}</td>
                        <td className="px-3 py-2 text-right font-mono text-slate-100">{(s.combinedOdds ?? 1).toFixed(2)}</td>
                        <td className="px-3 py-2 text-center">
                          <ResultBadge result={result} label={label} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-bold">
                          {pnl !== null ? (
                            <span className={pnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{signedCurrency(pnl)}</span>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr key={`${s.id}-legs`} className="bg-black/30">
                          <td colSpan={7} className="px-3 py-2">
                            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                              {s.picks.map((leg, i) => {
                                const lr = classifyOutcome(leg.outcome);
                                const dotCls =
                                  lr.result === "win"
                                    ? "bg-emerald-500"
                                    : lr.result === "loss"
                                      ? "bg-rose-500"
                                      : lr.result === "pending"
                                        ? "bg-amber-500"
                                        : "bg-slate-600";
                                return (
                                  <div key={i} className="flex items-center gap-2 rounded-md border border-white/5 bg-black/40 px-2.5 py-1.5 text-xs">
                                    <span className={cn("h-2 w-2 shrink-0 rounded-full", dotCls)} />
                                    <span className="text-[10px] font-mono text-slate-500">{i + 1}.</span>
                                    <span className="min-w-0 flex-1 truncate text-slate-200">{leg.matchLabel ?? "—"}</span>
                                    {competitionNameFor(leg.league) ? (
                                      <span className="hidden shrink-0 max-w-[120px] truncate rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300/80 md:block">
                                        {competitionNameFor(leg.league)}
                                      </span>
                                    ) : null}
                                    <span className="hidden shrink-0 truncate text-slate-400 sm:block max-w-[120px]">{leg.marketName}</span>
                                    <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
                                      {leg.selection}
                                    </span>
                                    {leg.hitRate !== undefined ? (
                                      <span className="shrink-0 font-mono text-[10px] text-slate-400">{pct(leg.hitRate, 0)}</span>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </Section>
    </>
  );
}
