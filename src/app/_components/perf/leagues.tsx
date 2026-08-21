"use client";

// ĞIGI GIVØ — League performance dashboard primitives.
// Shared by /performance (overview + inline detail) and /performance/league/[slug].

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  classifyOutcome,
  cn,
  ResultBadge,
  ProgressBar,
  SortHeader,
  type SortDir,
} from "./ui";

// ─── API shapes (mirror /api/performance/leagues) ─────────────────────────────

export interface SourceCounts {
  total: number;
  wins: number;
  losses: number;
  pushes?: number;
  voids?: number;
  pending: number;
}

export interface LeagueMetrics {
  leagueSlug: string;
  competitionName: string;
  region: string | null;
  totalBets: number;
  totalWins: number;
  totalLosses: number;
  totalPushes: number;
  totalVoids: number;
  totalPending: number;
  settledBets: number;
  hitRate: number;          // percent number (62.5 = 62.5%)
  roi: number | null;       // percent number
  totalStake: number;
  totalPnl: number;
  last7DaysPnl: number;
  last30DaysPnl: number;
  last7DaysHitRate: number;
  last30DaysHitRate: number;
  averageOdds: number | null;
  averageEv: number | null;
  currentStreak: string;
  top1HitRate: number | null;
  top3HitRate: number | null;
  top10HitRate: number | null;
  hitRateTrend: number;
  trendDirection: "up" | "down" | "flat";
  sourceBreakdown: {
    picks: SourceCounts;
    valueBets: SourceCounts;
    slips: SourceCounts;
  };
}

export interface BetRow {
  date: string;
  match: string;
  market: string;
  selection: string;
  odds: number | null;
  result: "HIT" | "MISS" | "PUSH" | "VOID" | "PENDING";
  pnl: number | null;
  source: "pick" | "valueBet" | "slip";
}

export interface FactorStat {
  factor: string;
  hitRate: number;   // percent
  hits: number;
  totalBets: number;
  trend: "up" | "down" | "flat";
}

export interface TrendPoint {
  label: string;
  value: number;
  delta: number;
}

export interface LeagueDetail extends LeagueMetrics {
  bets: BetRow[];
  factorAccuracy: FactorStat[];
  pnlTrend: TrendPoint[];
}

export interface LeaguesResponse {
  ok: boolean;
  days: number;
  sortBy: string;
  totalLeagues: number;
  leagues: LeagueMetrics[];
  league: LeagueDetail | null;
  generatedAt: string;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

/** Format a percent number (62.5 → "62.5%", 0 → "0.0%"). */
export function pctNum(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return `${x.toFixed(digits)}%`;
}

/** Signed currency from a raw number. */
export function money(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  const sign = x > 0 ? "+" : x < 0 ? "-" : "";
  return `${sign}$${Math.abs(x).toFixed(digits)}`;
}

export function trendTone(dir: "up" | "down" | "flat", invert = false) {
  const effective = invert ? (dir === "up" ? "down" : dir === "down" ? "up" : "flat") : dir;
  if (effective === "up") return { text: "text-emerald-300", border: "border-emerald-500/40", bg: "bg-emerald-500/10" };
  if (effective === "down") return { text: "text-rose-300", border: "border-rose-500/40", bg: "bg-rose-500/10" };
  return { text: "text-slate-400", border: "border-slate-500/40", bg: "bg-slate-500/10" };
}

export function TrendArrow({ dir, className }: { dir: "up" | "down" | "flat"; className?: string }) {
  return (
    <span className={cn("font-mono text-[11px] font-bold", trendTone(dir).text, className)}>
      {dir === "up" ? "↑" : dir === "down" ? "↓" : "→"}
    </span>
  );
}

// ─── League card (overview grid) ──────────────────────────────────────────────

export function LeagueCard({
  m,
  selected = false,
  onClick,
  href,
}: {
  m: LeagueMetrics;
  selected?: boolean;
  onClick?: () => void;
  href?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-white">{m.competitionName}</div>
          <div className="truncate font-mono text-[10px] text-slate-500">
            {m.region ?? "—"} · {m.leagueSlug}
          </div>
        </div>
        <TrendArrow dir={m.trendDirection} />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Bets</div>
          <div className="mt-0.5 font-mono text-lg font-extrabold tabular-nums text-white">{m.totalBets}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Hit Rate</div>
          <div
            className={cn(
              "mt-0.5 font-mono text-lg font-extrabold tabular-nums",
              m.settledBets === 0 ? "text-slate-500" : m.hitRate >= 60 ? "text-emerald-300" : m.hitRate >= 45 ? "text-amber-300" : "text-rose-300",
            )}
          >
            {pctNum(m.hitRate, 0)}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">ROI</div>
          <div
            className={cn(
              "mt-0.5 font-mono text-lg font-extrabold tabular-nums",
              m.roi === null ? "text-slate-500" : m.roi >= 0 ? "text-emerald-300" : "text-rose-300",
            )}
          >
            {m.roi === null ? "—" : `${m.roi >= 0 ? "+" : ""}${m.roi.toFixed(0)}%`}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-2">
        <div className="font-mono text-[11px] text-slate-400">
          P&amp;L{" "}
          <span className={cn("font-bold", m.totalPnl >= 0 ? "text-emerald-300" : "text-rose-300")}>
            {money(m.totalPnl)}
          </span>
        </div>
        <div className="font-mono text-[10px] text-slate-500">
          {m.currentStreak}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 font-mono text-[10px] text-slate-500">
        <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5">7d {pctNum(m.last7DaysHitRate, 0)}</span>
        <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5">30d {pctNum(m.last30DaysHitRate, 0)}</span>
        <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5">{m.totalWins}W·{m.totalLosses}L</span>
      </div>
    </>
  );

  const cls = cn(
    "group relative block rounded-xl border bg-black/50 p-4 text-left transition",
    selected
      ? "border-amber-400/60 bg-amber-400/[0.06] ring-1 ring-amber-400/40"
      : "border-white/10 hover:border-white/25 hover:bg-black/70",
  );

  if (href) {
    return (
      <Link href={href} onClick={onClick} className={cls}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cn(cls, "w-full cursor-pointer")}>
      {body}
    </button>
  );
}

export function LeagueSkeletonGrid({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-44 animate-pulse rounded-xl border border-white/10 bg-black/50" />
      ))}
    </div>
  );
}

// ─── Factor accuracy table ────────────────────────────────────────────────────

export function FactorAccuracyTable({ factors }: { factors: FactorStat[] }) {
  if (factors.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-black/50 p-8 text-center font-mono text-xs text-slate-400">
        No settled picks for this league yet — factor accuracy appears once bets resolve.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10 bg-black/50">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-white/10 bg-black/40">
          <tr>
            <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Factor Name</th>
            <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-400">Hit Rate %</th>
            <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-400">Hits</th>
            <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-400">Total Bets</th>
            <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">Trend</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {factors.map((f) => {
            const rate = f.hitRate / 100;
            return (
              <tr key={f.factor} className="transition hover:bg-white/[0.02]">
                <td className="px-3 py-2.5">
                  <div className="font-medium text-slate-100">{f.factor}</div>
                  <ProgressBar
                    value={rate}
                    tone={rate >= 0.65 ? "positive" : rate >= 0.5 ? "warning" : "negative"}
                    className="mt-1.5 max-w-[220px]"
                  />
                </td>
                <td
                  className={cn(
                    "px-3 py-2.5 text-right font-mono text-sm font-extrabold tabular-nums",
                    rate >= 0.65 ? "text-emerald-300" : rate >= 0.5 ? "text-amber-300" : "text-rose-300",
                  )}
                >
                  {pctNum(f.hitRate)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-xs text-slate-300">{f.hits}</td>
                <td className="px-3 py-2.5 text-right font-mono text-xs text-slate-300">{f.totalBets}</td>
                <td className="px-3 py-2.5 text-center"><TrendArrow dir={f.trend} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Detailed bets table (sortable, colour-coded) ─────────────────────────────

type BetsSortKey = "date" | "odds" | "pnl";

export function LeagueBetsTable({ bets }: { bets: BetRow[] }) {
  const [sortKey, setSortKey] = useState<BetsSortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sorted = useMemo(() => {
    const arr = [...bets];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "date") cmp = a.date.localeCompare(b.date);
      else if (sortKey === "odds") cmp = (a.odds ?? -1) - (b.odds ?? -1);
      else cmp = (a.pnl ?? 0) - (b.pnl ?? 0);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [bets, sortKey, sortDir]);

  const toggle = (key: BetsSortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  if (bets.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-black/50 p-8 text-center font-mono text-xs text-slate-400">
        No individual bets recorded for this league yet.
      </div>
    );
  }

  return (
    <div className="max-h-[560px] overflow-auto rounded-xl border border-white/10 bg-black/50">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 z-10 border-b border-white/10 bg-[#0b0f1a]">
          <tr>
            <SortHeader label="Date" active={sortKey === "date"} dir={sortDir} onClick={() => toggle("date")} />
            <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Match</th>
            <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Market</th>
            <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Selection</th>
            <SortHeader label="Odds" active={sortKey === "odds"} dir={sortDir} onClick={() => toggle("odds")} align="right" />
            <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">Result</th>
            <SortHeader label="P&L" active={sortKey === "pnl"} dir={sortDir} onClick={() => toggle("pnl")} align="right" />
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {sorted.map((b, i) => {
            const { result, label } = classifyOutcome(b.result);
            const rowTint =
              result === "win" ? "border-l-emerald-500"
              : result === "loss" ? "border-l-rose-500"
              : result === "pending" ? "border-l-amber-500"
              : "border-l-slate-600";
            return (
              <tr key={`${b.date}-${b.match}-${b.market}-${b.selection}-${i}`} className={cn("border-l-2 transition hover:bg-white/[0.02]", rowTint)}>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-slate-400">{b.date}</td>
                <td className="px-3 py-2">
                  <div className="max-w-[200px] truncate font-medium text-slate-100">{b.match}</div>
                  <div className="font-mono text-[10px] uppercase text-slate-600">{b.source}</div>
                </td>
                <td className="max-w-[180px] truncate px-3 py-2 text-slate-200">{b.market}</td>
                <td className="px-3 py-2">
                  <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[11px] font-bold text-emerald-300">
                    {b.selection}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-slate-300">{b.odds !== null ? b.odds.toFixed(2) : "—"}</td>
                <td className="px-3 py-2 text-center"><ResultBadge result={result} label={label} /></td>
                <td
                  className={cn(
                    "px-3 py-2 text-right font-mono text-xs font-bold tabular-nums",
                    b.pnl === null ? "text-slate-500" : b.pnl >= 0 ? "text-emerald-300" : "text-rose-300",
                  )}
                >
                  {b.pnl === null ? "—" : money(b.pnl)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Summary stat grid for the selected league ────────────────────────────────

export function LeagueSummaryCards({ m }: { m: LeagueMetrics }) {
  const cards: Array<{ label: string; value: string; sub: string; tone: "pos" | "neg" | "neu" | "accent" }> = [
    {
      label: "Total Bets",
      value: String(m.totalBets),
      sub: `${m.settledBets} settled · ${m.totalPending} pending`,
      tone: "neu",
    },
    {
      label: "Hit Rate (Wins / Settled)",
      value: m.settledBets > 0 ? pctNum(m.hitRate) : "—",
      sub: `${m.totalWins}W · ${m.totalLosses}L · ${m.totalPushes} push · ${m.totalVoids} void`,
      tone: m.hitRate >= 60 ? "pos" : m.hitRate >= 45 ? "accent" : "neg",
    },
    {
      label: "Total P&L",
      value: money(m.totalPnl),
      sub: `staked ${money(m.totalStake)}`,
      tone: m.totalPnl >= 0 ? "pos" : "neg",
    },
    {
      label: "ROI (P&L / Stake)",
      value: m.roi === null ? "—" : `${m.roi >= 0 ? "+" : ""}${m.roi.toFixed(1)}%`,
      sub: m.roi === null ? "no stake data yet" : "on staked products",
      tone: (m.roi ?? 0) >= 0 ? "pos" : "neg",
    },
    {
      label: "Current Streak",
      value: m.currentStreak,
      sub: m.trendDirection === "up" ? "trending up" : m.trendDirection === "down" ? "trending down" : "flat",
      tone: m.currentStreak.startsWith("No") ? "neu" : m.currentStreak.includes("Win") ? "pos" : "neg",
    },
    {
      label: "Avg Odds · Avg EV",
      value: m.averageOdds !== null ? `${m.averageOdds.toFixed(2)}x` : "—",
      sub: m.averageEv !== null ? `EV ${m.averageEv >= 0 ? "+" : ""}${(m.averageEv * 100).toFixed(1)}%` : "EV —",
      tone: "accent",
    },
    {
      label: "Top-1 Hit Rate",
      value: m.top1HitRate !== null ? pctNum(m.top1HitRate) : "—",
      sub: "best pick per match",
      tone: (m.top1HitRate ?? 0) >= 60 ? "pos" : "neu",
    },
    {
      label: "Top-3 / Top-10 Hit Rate",
      value: m.top3HitRate !== null ? pctNum(m.top3HitRate, 0) : "—",
      sub: m.top10HitRate !== null ? `Top-10 ${pctNum(m.top10HitRate, 0)}` : "Top-10 —",
      tone: "neu",
    },
    {
      label: "Last 7 Days P&L",
      value: money(m.last7DaysPnl),
      sub: `hit rate ${pctNum(m.last7DaysHitRate, 0)}`,
      tone: m.last7DaysPnl >= 0 ? "pos" : "neg",
    },
    {
      label: "Last 30 Days P&L",
      value: money(m.last30DaysPnl),
      sub: `hit rate ${pctNum(m.last30DaysHitRate, 0)}`,
      tone: m.last30DaysPnl >= 0 ? "pos" : "neg",
    },
  ];

  const toneText = {
    pos: "text-emerald-300",
    neg: "text-rose-300",
    neu: "text-white",
    accent: "text-amber-300",
  } as const;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-white/10 bg-black/50 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{c.label}</div>
          <div className={cn("mt-1.5 font-mono text-xl font-extrabold tabular-nums", toneText[c.tone])}>{c.value}</div>
          <div className="mt-1 text-[11px] text-slate-400">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}

// ─── P&L window switcher (7d / 30d / all in-window) ───────────────────────────

export function usePnlWindow(points: TrendPoint[]) {
  const [windowDays, setWindowDays] = useState<7 | 30 | 0>(0); // 0 = all
  const visible = useMemo(() => {
    if (windowDays === 0 || points.length === 0) return points;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);
    const iso = cutoff.toISOString().slice(0, 10);
    return points.filter((p) => p.label >= iso);
  }, [points, windowDays]);

  const WindowSwitcher = (
    <div className="flex gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1">
      {([7, 30, 0] as const).map((d) => (
        <button
          key={d}
          onClick={() => setWindowDays(d)}
          className={cn(
            "rounded-md px-2.5 py-1 font-mono text-[11px] font-medium transition",
            windowDays === d ? "bg-amber-400 font-bold text-slate-950" : "text-slate-300 hover:bg-white/5",
          )}
        >
          {d === 0 ? "All" : `${d}d`}
        </button>
      ))}
    </div>
  );

  return { visible, WindowSwitcher };
}
