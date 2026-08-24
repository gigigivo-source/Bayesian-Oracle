"use client";

// ĞIGI GIVØ — Comprehensive Ranking-Mode Performance Dashboard Components.
//
// Presentational layer for /performance (ranking-mode dashboard). Driven by
// pure aggregates from `@/lib/performance/modeAnalytics`.

import { useMemo, useState, type ReactNode } from "react";
import {
  AccuracyBars,
  CalibrationCurveChart,
  DailyPnlBars,
  FactorHeatmapChart,
  MultiModePnLChart,
  OutcomeDistributionDonut,
  PnLTrendChart,
  RecoveryTimelineChart,
  RollingTrendChart,
  ScoreGauge,
  Sparkline,
} from "./charts";
import {
  Card,
  EmptyState,
  Pill,
  ProgressBar,
  ResultBadge,
  Section,
  SortHeader,
  StatCard,
  cn,
  currency,
  signedCurrency,
  type BetResult as UiResult,
  type SortDir,
  type Tone,
} from "./ui";
import { CHIP_PREMIUM } from "../design";
import {
  MODE_META,
  RANKING_MODES,
  betsToCsv,
  betsToJson,
  type AutomatedInsights,
  type BreakdownRow,
  type CalibrationBucket,
  type ComparisonMetricKey,
  type ComparisonRow,
  type DailyPoint,
  type DrawdownEpisode,
  type FactorAccuracyRow,
  type ModeBet,
  type ModeReport,
  type ModeSummary,
  type MultiModePoint,
  type RankingModeKey,
  type TierSummary,
  type WindowSummary,
} from "@/lib/performance/modeAnalytics";

// ─── API payload ──────────────────────────────────────────────────────────────

export interface ModeReportPayload extends ModeReport {
  betsTotal: number;
  betsTruncated: boolean;
}

export interface ModesApiResponse {
  ok: boolean;
  generatedAt: string;
  window: { days: string; from: string; to: string | null };
  totals: { performanceRows: number; valueBetRows: number; slipRows: number; bets: number };
  comparison: ComparisonRow[];
  modes: ModeReportPayload[];
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

export const pctNum = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : `${n.toFixed(digits)}%`;

export const num = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : n.toFixed(digits);

export const money = (n: number | null | undefined) => signedCurrency(n);

export const uiResult = (r: ModeBet["result"]): UiResult =>
  r === "WIN" ? "win" : r === "LOSS" ? "loss" : r === "PUSH" ? "push" : r === "VOID" ? "void" : "pending";

function tone(value: number | null | undefined): Tone {
  if (value === null || value === undefined || value === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}

// ─── Mode styling tokens ──────────────────────────────────────────────────────

export const MODE_STYLES: Record<
  RankingModeKey,
  {
    on: string;
    off: string;
    text: string;
    border: string;
    bar: string;
    glow: string;
    dot: string;
    badge: string;
    borderLight: string;
  }
> = {
  A: {
    on: "bg-gradient-to-r from-[#F59E0B] to-[#FF8C00] text-white border-amber-300/40 shadow-[0_0_22px_-6px_rgba(245,158,11,0.65)]",
    off: "text-amber-200/80 hover:text-amber-100",
    text: "text-amber-300",
    border: "border-amber-400/40",
    bar: "bg-amber-400",
    glow: "shadow-[0_0_28px_-12px_rgba(245,158,11,0.8)]",
    dot: "bg-amber-400",
    badge: "bg-amber-400/15 text-amber-300 border-amber-400/40",
    borderLight: "border-amber-400/30",
  },
  B: {
    on: "bg-gradient-to-r from-teal-500 to-sky-500 text-white border-teal-200/40 shadow-[0_0_22px_-6px_rgba(20,184,166,0.65)]",
    off: "text-teal-200/80 hover:text-teal-100",
    text: "text-teal-300",
    border: "border-teal-400/40",
    bar: "bg-teal-400",
    glow: "shadow-[0_0_28px_-12px_rgba(20,184,166,0.8)]",
    dot: "bg-teal-400",
    badge: "bg-teal-400/15 text-teal-300 border-teal-400/40",
    borderLight: "border-teal-400/30",
  },
  C: {
    on: "bg-gradient-to-r from-violet-600 to-fuchsia-500 text-white border-violet-200/40 shadow-[0_0_22px_-6px_rgba(139,92,246,0.65)]",
    off: "text-violet-200/80 hover:text-violet-100",
    text: "text-violet-300",
    border: "border-violet-400/40",
    bar: "bg-violet-400",
    glow: "shadow-[0_0_28px_-12px_rgba(139,92,246,0.8)]",
    dot: "bg-violet-400",
    badge: "bg-violet-400/15 text-violet-300 border-violet-400/40",
    borderLight: "border-violet-400/30",
  },
  D: {
    on: "bg-gradient-to-r from-[#FDE68A] via-white to-[#F59E0B] text-slate-900 border-white/60 shadow-[0_0_22px_-6px_rgba(253,230,138,0.75)]",
    off: "text-yellow-100/80 hover:text-white",
    text: "text-yellow-200",
    border: "border-yellow-200/40",
    bar: "bg-gradient-to-r from-yellow-200 to-amber-400",
    glow: "shadow-[0_0_28px_-12px_rgba(253,230,138,0.9)]",
    dot: "bg-gradient-to-r from-yellow-200 to-amber-400",
    badge: "bg-yellow-400/15 text-yellow-200 border-yellow-300/40",
    borderLight: "border-yellow-300/30",
  },
};

// ─── 1. Ranking Leaderboard (Top of Page) ─────────────────────────────────────

export function RankingLeaderboard({
  comparison,
  selected,
  onSelect,
}: {
  comparison: ComparisonRow[];
  selected: RankingModeKey;
  onSelect: (mode: RankingModeKey) => void;
}) {
  const ranked = useMemo(() => {
    return [...comparison].sort((a, b) => b.overallScore - a.overallScore || b.hitRate - a.hitRate);
  }, [comparison]);

  const MEDAL_STYLES = [
    {
      rankLabel: "1st Place",
      badgeText: "🥇 GOLD",
      border: "border-amber-400/80 ring-1 ring-amber-400/40 bg-gradient-to-b from-amber-500/15 to-slate-900",
      accent: "text-amber-300",
      pill: "bg-amber-400/20 text-amber-300 border-amber-400/50",
    },
    {
      rankLabel: "2nd Place",
      badgeText: "🥈 SILVER",
      border: "border-slate-300/70 bg-gradient-to-b from-slate-400/10 to-slate-900",
      accent: "text-slate-200",
      pill: "bg-slate-300/20 text-slate-200 border-slate-300/40",
    },
    {
      rankLabel: "3rd Place",
      badgeText: "🥉 BRONZE",
      border: "border-amber-700/60 bg-gradient-to-b from-amber-800/10 to-slate-900",
      accent: "text-amber-500",
      pill: "bg-amber-700/20 text-amber-500 border-amber-700/40",
    },
    {
      rankLabel: "4th Place",
      badgeText: "4TH",
      border: "border-slate-800 bg-slate-900/90",
      accent: "text-slate-400",
      pill: "bg-slate-800 text-slate-400 border-slate-700",
    },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {ranked.map((row, idx) => {
          const medal = MEDAL_STYLES[idx] ?? MEDAL_STYLES[3];
          const isSelected = row.mode === selected;
          const isRecommended = idx === 0 && row.totalBets > 0;

          return (
            <div
              key={row.mode}
              onClick={() => onSelect(row.mode)}
              className={cn(
                "group relative cursor-pointer rounded-2xl border p-4 transition-all duration-300 hover:scale-[1.02]",
                medal.border,
                isSelected && "ring-2 ring-white/80 shadow-2xl",
              )}
            >
              {isRecommended ? (
                <div className="absolute -top-3 right-4 rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 px-3 py-0.5 text-[10px] font-black uppercase tracking-wider text-slate-950 shadow-lg">
                  ✓ Recommended
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-2">
                <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[10px] font-extrabold", medal.pill)}>
                  {medal.badgeText}
                </span>
                <span className="font-mono text-[11px] text-slate-400">{row.totalBets} bets tracked</span>
              </div>

              <div className="mt-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className={cn("text-base font-extrabold", medal.accent)}>
                    {row.label}
                  </h3>
                  <p className="line-clamp-1 text-[11px] text-slate-400">{MODE_META[row.mode].description}</p>
                </div>
                <ScoreGauge score={row.overallScore} size={64} />
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl border border-white/5 bg-black/20 p-2.5 font-mono text-xs">
                <div>
                  <div className="text-[10px] uppercase text-slate-500">Hit Rate</div>
                  <div className="text-sm font-black text-white">{pctNum(row.hitRate)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-slate-500">ROI</div>
                  <div className={cn("text-sm font-black", row.roi !== null && row.roi > 0 ? "text-emerald-300" : row.roi !== null && row.roi < 0 ? "text-rose-300" : "text-slate-300")}>
                    {pctNum(row.roi)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-slate-500">Total P&L</div>
                  <div className={cn("text-sm font-black", row.totalPnl > 0 ? "text-emerald-300" : row.totalPnl < 0 ? "text-rose-300" : "text-slate-300")}>
                    {money(row.totalPnl)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-slate-500">Consistency</div>
                  <div className="text-sm font-black text-amber-300">{row.consistencyScore.toFixed(1)}/100</div>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between text-[11px]">
                <span className="font-mono text-slate-400">Streak: <strong className="text-white">{row.currentStreak}</strong></span>
                <span className="text-xs font-bold text-amber-300 group-hover:underline">
                  {isSelected ? "● Active Mode" : "Select Mode →"}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 font-mono text-[11px] text-slate-400">
        <strong className="text-slate-200">Methodology · Overall Performance Score (0–100)</strong> is computed from:{" "}
        <span className="text-amber-300">30% Hit Rate</span> (scaled to benchmark) +{" "}
        <span className="text-emerald-300">30% Realized ROI</span> +{" "}
        <span className="text-sky-300">20% Net P&L Stability</span> +{" "}
        <span className="text-purple-300">20% Consistency Score</span> (win days %, drawdown factor, and low volatility).
      </div>
    </div>
  );
}

// ─── Mode Chips ───────────────────────────────────────────────────────────────

export function ModeChips({
  comparison,
  selected,
  onSelect,
}: {
  comparison?: ComparisonRow[];
  selected: RankingModeKey;
  onSelect: (mode: RankingModeKey) => void;
}) {
  const rows =
    comparison && comparison.length > 0
      ? comparison
      : RANKING_MODES.map((mode) => ({
          mode,
          short: MODE_META[mode].short,
          totalBets: 0,
          hitRate: 0,
          bestIn: [] as ComparisonMetricKey[],
        }));
  const hasStats = Boolean(comparison && comparison.length > 0);

  return (
    <div
      className="flex flex-wrap gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.04] p-2 backdrop-blur-xl"
      role="tablist"
      aria-label="Ranking mode"
    >
      {rows.map((row) => {
        const style = MODE_STYLES[row.mode];
        const active = row.mode === selected;
        return (
          <button
            key={row.mode}
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(row.mode)}
            className={cn(
              CHIP_PREMIUM,
              "flex-1 justify-center px-3 py-2 text-xs sm:text-sm",
              active ? style.on : cn(style.off, "font-semibold"),
            )}
          >
            <span className={cn("h-2 w-2 rounded-full", active ? "bg-white/80" : style.dot)} />
            <span className="whitespace-nowrap">{row.short}</span>
            {hasStats ? (
              <span
                className={cn(
                  "hidden rounded px-1.5 py-0.5 font-mono text-[10px] sm:inline",
                  active ? "bg-black/20" : "bg-slate-900/60 text-slate-400",
                )}
              >
                {row.totalBets} · {pctNum(row.hitRate, 0)}
              </span>
            ) : null}
            {row.bestIn.length > 0 ? <span title="Best-in-class metrics">⭐</span> : null}
          </button>
        );
      })}
    </div>
  );
}

// ─── 2. Comprehensive Summary Cards ───────────────────────────────────────────

export function SummaryCards({
  summary,
  mode,
  dailySeries = [],
}: {
  summary: ModeSummary;
  mode: RankingModeKey;
  dailySeries?: DailyPoint[];
}) {
  const style = MODE_STYLES[mode];
  const streakTone: Tone =
    summary.currentStreak.type === "WIN"
      ? "positive"
      : summary.currentStreak.type === "LOSS"
        ? "negative"
        : "neutral";

  const pnlSparklineValues = dailySeries.map((d) => d.cumulativePnl);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <StatCard
          label="Total Bets Placed"
          value={<span className="tabular-nums">{summary.totalBets}</span>}
          sub={`${summary.settledBets} settled · ${summary.pending} pending`}
          hint="Total bets tracked for this mode across all products."
        />
        <StatCard
          label="Wins / Losses"
          value={
            <span className="tabular-nums">
              <span className="text-emerald-300">{summary.wins}</span>
              <span className="text-slate-500"> / </span>
              <span className="text-rose-300">{summary.losses}</span>
            </span>
          }
          sub={`${pctNum(summary.winPct)} / ${pctNum(summary.lossPct)} of all bets`}
        />
        <StatCard
          label="Pushes / Voids"
          value={<span className="tabular-nums">{`${summary.pushes} / ${summary.voids}`}</span>}
          sub={`Push ${pctNum(summary.pushRate)} · Void ${pctNum(summary.voidRate)}`}
        />
        <StatCard
          label="Overall Hit Rate"
          value={<span className={style.text}>{pctNum(summary.hitRate)}</span>}
          sub="wins ÷ (wins + losses)"
          tone="accent"
        />
        <StatCard
          label="Total Profit or Loss"
          value={money(summary.totalPnl)}
          tone={tone(summary.totalPnl)}
          sub={`stake ${currency(summary.totalStake)} · return ${currency(summary.totalReturn)}`}
          icon={
            pnlSparklineValues.length > 1 ? (
              <div className="w-16">
                <Sparkline values={pnlSparklineValues} height={20} />
              </div>
            ) : null
          }
        />
        <StatCard
          label="ROI"
          value={pctNum(summary.roi)}
          tone={tone(summary.roi)}
          sub={summary.roi === null ? "no stake data in range" : "P&L ÷ total stake"}
        />
        <StatCard
          label="Average Odds"
          value={num(summary.averageOdds)}
          sub={`stake-weighted · unweighted ${num(summary.averageOddsUnweighted)}`}
        />
        <StatCard
          label="Average Expected Value"
          value={summary.averageEv === null ? "—" : pctNum(summary.averageEv * 100)}
          tone={tone(summary.averageEv)}
          sub="model EV per unit staked"
        />
        <StatCard
          label="Current Streak"
          value={summary.currentStreak.label}
          tone={streakTone}
          sub={`best ${summary.longestWinStreak}W · worst ${summary.longestLossStreak}L`}
        />
        <StatCard
          label="Longest Non-Win Run"
          value={<span className="tabular-nums">{summary.longestNonWinStreak} bets</span>}
          sub={`longest loss run: ${summary.longestLossStreak}`}
          tone={summary.longestNonWinStreak > 3 ? "negative" : "neutral"}
        />
        <StatCard
          label="Best Day"
          value={summary.bestDay ? money(summary.bestDay.pnl) : "—"}
          tone="positive"
          sub={summary.bestDay ? summary.bestDay.date : "no profit day yet"}
        />
        <StatCard
          label="Worst Day"
          value={summary.worstDay ? money(summary.worstDay.pnl) : "—"}
          tone="negative"
          sub={summary.worstDay ? summary.worstDay.date : "no losing day yet"}
        />
        <StatCard
          label="Winning vs Losing Days"
          value={
            <span className="tabular-nums text-base">
              <span className="text-emerald-300">{summary.profitableDays}W</span>
              <span className="text-slate-500"> / </span>
              <span className="text-rose-300">{summary.losingDays}L</span>
            </span>
          }
          sub={`${pctNum(summary.winningDaysPct)} winning days (${summary.activeDays} active)`}
        />
        <StatCard
          label="High-Confidence Bets"
          value={
            <span className="tabular-nums text-base">
              {summary.highConfidenceHitRate !== null ? pctNum(summary.highConfidenceHitRate) : "—"}
            </span>
          }
          sub={`${summary.highConfidenceBets} bets · P&L ${money(summary.highConfidencePnl)}`}
          tone={summary.highConfidenceHitRate && summary.highConfidenceHitRate >= 75 ? "positive" : "neutral"}
        />
        <StatCard
          label="Low-Confidence Bets"
          value={
            <span className="tabular-nums text-base">
              {summary.lowConfidenceHitRate !== null ? pctNum(summary.lowConfidenceHitRate) : "—"}
            </span>
          }
          sub={`${summary.lowConfidenceBets} bets · P&L ${money(summary.lowConfidencePnl)}`}
          tone={summary.lowConfidenceHitRate && summary.lowConfidenceHitRate >= 60 ? "positive" : "neutral"}
        />
        <StatCard
          label="Profit / Bet & / Win"
          value={
            <span className="tabular-nums text-base">
              {summary.profitPerBet !== null ? signedCurrency(summary.profitPerBet) : "—"}
            </span>
          }
          sub={`per winning bet ${summary.profitPerWinningBet !== null ? signedCurrency(summary.profitPerWinningBet) : "—"}`}
        />
        <StatCard
          label="Total Return vs Stake"
          value={
            <span className="tabular-nums text-sm">
              {currency(summary.totalReturn)} / {currency(summary.totalStake)}
            </span>
          }
          sub={`avg stake ${currency(summary.averageStake)}`}
        />
        <StatCard
          label="10/10 Hits"
          value={<span className="tabular-nums">{summary.tenOfTenHits}</span>}
          sub={`${summary.matchesTracked} matches · ${pctNum(summary.perfectMatchRate)} perfect`}
          tone={summary.tenOfTenHits > 0 ? "accent" : "neutral"}
        />
        <StatCard
          label="Top 1 / 3 / 10 Hit Rates"
          value={
            <span className="tabular-nums text-sm">
              {pctNum(summary.top1HitRate, 0)} / {pctNum(summary.top3HitRate, 0)} / {pctNum(summary.top10HitRate, 0)}
            </span>
          }
          sub="hit rate across rank tiers"
        />
        <StatCard
          label="Sharpe Ratio"
          value={summary.sharpeRatio !== null ? num(summary.sharpeRatio) : "—"}
          tone={summary.sharpeRatio !== null && summary.sharpeRatio > 1.5 ? "positive" : "neutral"}
          sub="annualized risk-adjusted return"
          hint="Sharpe ratio of daily P&L. >1.5 is strong, >2.0 is exceptional."
        />
        <StatCard
          label="Profit Factor"
          value={summary.profitFactor !== null ? num(summary.profitFactor) : "—"}
          tone={summary.profitFactor !== null && summary.profitFactor > 1.5 ? "positive" : "neutral"}
          sub="gross profit ÷ gross loss"
          hint="Values above 1.5 indicate robust edge."
        />
        <StatCard
          label="Recovery Factor"
          value={summary.recoveryFactor !== null ? num(summary.recoveryFactor) : "—"}
          tone={summary.recoveryFactor !== null && summary.recoveryFactor > 2 ? "positive" : "neutral"}
          sub="net P&L ÷ max drawdown"
        />
        <StatCard
          label="Model Calibration"
          value={
            summary.calibrationDelta === null
              ? "—"
              : `${summary.calibrationDelta > 0 ? "+" : ""}${summary.calibrationDelta.toFixed(1)}pp`
          }
          tone={tone(summary.calibrationDelta)}
          sub={`Brier ${num(summary.brierScore, 3)} · pred ${pctNum((summary.averageModelProb ?? 0) * 100)}`}
          hint="Calibration delta: positive means actual win rate exceeded predicted probability."
        />
        <StatCard
          label="Consistency Score"
          value={<span className="text-amber-300">{summary.consistencyScore.toFixed(1)}/100</span>}
          sub={`volatility: ${summary.volatilityRating} (±$${summary.dailyPnlStdDev.toFixed(1)})`}
        />
        <StatCard
          label="Max Drawdown"
          value={currency(summary.maxDrawdown)}
          tone={summary.maxDrawdown > 0 ? "negative" : "neutral"}
          sub={`${pctNum(summary.cumulativeStabilityPct)} of days in cumulative profit`}
        />
      </div>
    </div>
  );
}

// ─── 3. Comprehensive Mode Comparison Table ───────────────────────────────────

export function ComprehensiveModeComparison({
  rows,
  selected,
  onSelect,
}: {
  rows: ComparisonRow[];
  selected: RankingModeKey;
  onSelect: (mode: RankingModeKey) => void;
}) {
  const MEDAL_BADGES: Record<number, { text: string; bg: string }> = {
    1: { text: "🥇 1st", bg: "bg-amber-400/20 text-amber-300 border-amber-400/60" },
    2: { text: "🥈 2nd", bg: "bg-slate-300/20 text-slate-200 border-slate-300/40" },
    3: { text: "🥉 3rd", bg: "bg-amber-700/20 text-amber-500 border-amber-700/40" },
    4: { text: "4th", bg: "bg-slate-800 text-slate-400 border-slate-700" },
  };

  const METRIC_ROWS: Array<{
    key: ComparisonMetricKey;
    label: string;
    render: (r: ComparisonRow) => ReactNode;
  }> = [
    { key: "overallScore", label: "Overall Score", render: (r) => `${r.overallScore.toFixed(1)}/100` },
    { key: "consistencyScore", label: "Consistency Score", render: (r) => `${r.consistencyScore.toFixed(1)}/100` },
    { key: "hitRate", label: "Hit Rate", render: (r) => pctNum(r.hitRate) },
    { key: "roi", label: "ROI", render: (r) => pctNum(r.roi) },
    { key: "totalPnl", label: "Total P&L", render: (r) => money(r.totalPnl) },
    { key: "totalBets", label: "Total Bets", render: (r) => `${r.totalBets} (${r.settledBets} settled)` },
    { key: "averageOdds", label: "Avg Odds", render: (r) => num(r.averageOdds) },
    { key: "averageEv", label: "Avg Expected Value", render: (r) => r.averageEv !== null ? pctNum(r.averageEv * 100) : "—" },
    { key: "sharpeRatio", label: "Sharpe Ratio", render: (r) => num(r.sharpeRatio) },
    { key: "profitFactor", label: "Profit Factor", render: (r) => num(r.profitFactor) },
    { key: "recoveryFactor", label: "Recovery Factor", render: (r) => num(r.recoveryFactor) },
    { key: "maxDrawdown", label: "Max Drawdown", render: (r) => currency(r.maxDrawdown) },
    { key: "winningDaysPct", label: "Winning Days %", render: (r) => pctNum(r.winningDaysPct) },
    { key: "tenOfTenHits", label: "10/10 Matches", render: (r) => String(r.tenOfTenHits) },
    { key: "top1HitRate", label: "Top 1 Hit Rate", render: (r) => pctNum(r.top1HitRate) },
    { key: "top3HitRate", label: "Top 3 Hit Rate", render: (r) => pctNum(r.top3HitRate) },
    { key: "top10HitRate", label: "Top 10 Hit Rate", render: (r) => pctNum(r.top10HitRate) },
    { key: "calibrationDelta", label: "Calibration Delta", render: (r) => r.calibrationDelta !== null ? `${r.calibrationDelta > 0 ? "+" : ""}${r.calibrationDelta.toFixed(1)}pp` : "—" },
    { key: "brierScore", label: "Brier Score", render: (r) => num(r.brierScore, 3) },
  ];

  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-700 bg-slate-900">
      <table className="w-full min-w-[760px] text-xs">
        <thead>
          <tr className="border-b border-slate-700 bg-slate-950/60 font-mono text-[11px] text-slate-400">
            <th className="px-4 py-3 text-left">Metric</th>
            {rows.map((row) => {
              const active = row.mode === selected;
              const medal = MEDAL_BADGES[row.rank] ?? MEDAL_BADGES[4];
              return (
                <th
                  key={row.mode}
                  onClick={() => onSelect(row.mode)}
                  className={cn(
                    "cursor-pointer px-4 py-3 text-center transition hover:bg-slate-800/80",
                    active && "bg-slate-800/90",
                  )}
                >
                  <div className="flex flex-col items-center gap-1">
                    <span className={cn("rounded border px-2 py-0.5 text-[10px] font-black", medal.bg)}>
                      {medal.text}
                    </span>
                    <span className={cn("text-sm font-extrabold", MODE_STYLES[row.mode].text)}>
                      {row.label}
                    </span>
                    <span className="text-[10px] text-slate-400">{row.currentStreak}</span>
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {METRIC_ROWS.map((m, idx) => (
            <tr
              key={m.key}
              className={cn("border-t border-slate-800 transition hover:bg-slate-800/40", idx % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50")}
            >
              <td className="px-4 py-2.5 font-medium text-slate-300">{m.label}</td>
              {rows.map((row) => {
                const isBest = row.bestIn.includes(m.key);
                const active = row.mode === selected;
                return (
                  <td
                    key={row.mode}
                    onClick={() => onSelect(row.mode)}
                    className={cn(
                      "cursor-pointer px-4 py-2.5 text-center font-mono tabular-nums",
                      active && "bg-slate-800/60",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 px-2 py-0.5 rounded transition",
                        isBest
                          ? "border border-amber-400/80 bg-amber-400/15 font-bold text-amber-300 shadow-[0_0_12px_rgba(251,191,36,0.2)]"
                          : "text-slate-200",
                      )}
                    >
                      {isBest ? <span className="text-[10px] text-amber-400">★</span> : null}
                      {m.render(row)}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── 4. Consistency Analysis Panel ────────────────────────────────────────────

export function ConsistencyAnalysisPanel({
  summary,
  dailySeries = [],
}: {
  summary: ModeSummary;
  dailySeries: DailyPoint[];
}) {
  const pnlSparkline = dailySeries.map((d) => d.pnl);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Consistency Score</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-mono text-3xl font-black text-amber-300">
              {summary.consistencyScore.toFixed(1)}
            </span>
            <span className="text-xs text-slate-400">/ 100</span>
          </div>
          <ProgressBar value={summary.consistencyScore / 100} tone="accent" className="mt-2" />
        </Card>

        <Card>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Volatility Rating</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className={cn("font-mono text-2xl font-black", summary.volatilityRating === "Low" ? "text-emerald-300" : summary.volatilityRating === "Medium" ? "text-amber-300" : "text-rose-300")}>
              {summary.volatilityRating}
            </span>
            <span className="text-xs text-slate-400">(±${summary.dailyPnlStdDev.toFixed(1)})</span>
          </div>
          <p className="mt-1 text-[10px] text-slate-500">Daily P&L standard deviation</p>
        </Card>

        <Card>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Winning Days vs Losing</div>
          <div className="mt-2 font-mono text-2xl font-black text-white">
            {pctNum(summary.winningDaysPct)}
          </div>
          <p className="mt-1 text-[10px] text-slate-400">
            {summary.profitableDays} winning · {summary.losingDays} losing · {summary.breakEvenDays} even
          </p>
        </Card>

        <Card>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Cumulative Stability</div>
          <div className="mt-2 font-mono text-2xl font-black text-emerald-300">
            {pctNum(summary.cumulativeStabilityPct)}
          </div>
          <p className="mt-1 text-[10px] text-slate-400">Share of days remaining in net profit</p>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-xs font-bold text-white">DAILY P&L SPARKLINE & RUNS</span>
            <span className="text-[10px] font-mono text-slate-400">
              Best run: <strong className="text-emerald-300">{summary.bestWinDaysRun}W</strong> · Worst: <strong className="text-rose-300">{summary.worstLossDaysRun}L</strong>
            </span>
          </div>
          <div className="h-16 w-full pt-2">
            <Sparkline values={pnlSparkline} height={48} />
          </div>
        </Card>

        <Card>
          <div className="text-xs font-bold text-white font-mono mb-2">DRAWDOWN METRICS</div>
          <div className="grid grid-cols-2 gap-2 text-xs font-mono">
            <div className="rounded bg-slate-950/60 p-2">
              <span className="text-slate-400 text-[10px] block">Max Drawdown</span>
              <span className="text-rose-300 font-bold text-base">{currency(summary.maxDrawdown)}</span>
            </div>
            <div className="rounded bg-slate-950/60 p-2">
              <span className="text-slate-400 text-[10px] block">Recovery Factor</span>
              <span className="text-emerald-300 font-bold text-base">{num(summary.recoveryFactor)}</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ─── 5. Tier Breakdown Panel (Top 1 vs Top 3 vs Top 10) ───────────────────────

export function TierBreakdownPanel({
  top1,
  top3,
  top10,
}: {
  top1?: TierSummary;
  top3?: TierSummary;
  top10?: TierSummary;
}) {
  const tiers = [top1, top3, top10].filter((t): t is TierSummary => Boolean(t));
  if (tiers.length === 0) {
    return <EmptyState title="No tier data yet" message="Tier summaries appear as ranked picks settle." />;
  }

  return (
    <div className="space-y-4">
      {/* Side by side comparison cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {tiers.map((t) => (
          <div key={t.tier} className="rounded-2xl border border-slate-700 bg-slate-900 p-4">
            <div className="flex items-center justify-between">
              <span className="rounded-lg bg-amber-400/15 px-2.5 py-1 font-mono text-xs font-black text-amber-300 border border-amber-400/40">
                {t.tier} Picks
              </span>
              <span className="font-mono text-xs text-slate-400">{t.totalBets} bets ({t.settledBets} settled)</span>
            </div>

            <div className="mt-4 flex items-baseline justify-between">
              <span className="text-xs text-slate-400">Hit Rate</span>
              <span className="font-mono text-3xl font-black text-emerald-300">{pctNum(t.hitRate)}</span>
            </div>
            <ProgressBar value={t.hitRate / 100} tone="positive" className="mt-1" />

            <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-2.5 font-mono text-xs">
              <div>
                <span className="text-[10px] text-slate-500 block">W / L / P / V</span>
                <span className="text-white font-bold">{t.wins} / {t.losses} / {t.pushes} / {t.voids}</span>
              </div>
              <div>
                <span className="text-[10px] text-slate-500 block">P&L (ROI)</span>
                <span className={t.pnl >= 0 ? "text-emerald-300 font-bold" : "text-rose-300 font-bold"}>
                  {money(t.pnl)} ({pctNum(t.roi)})
                </span>
              </div>
              <div>
                <span className="text-[10px] text-slate-500 block">Avg Odds (EV)</span>
                <span className="text-slate-200">{num(t.averageOdds)} ({t.averageEv !== null ? pctNum(t.averageEv * 100) : "—"})</span>
              </div>
              <div>
                <span className="text-[10px] text-slate-500 block">Sharpe / Consistency</span>
                <span className="text-amber-300">{num(t.sharpeRatio)} / {t.consistencyScore.toFixed(0)}</span>
              </div>
            </div>

            <div className="mt-3 space-y-1 font-mono text-[10px]">
              <div className="text-slate-400 font-bold uppercase">Confidence Split:</div>
              <div className="flex justify-between text-slate-300">
                <span>High: {t.confidenceSplit.high.count} bets ({pctNum(t.confidenceSplit.high.hitRate)})</span>
                <span>Med: {t.confidenceSplit.medium.count} bets ({pctNum(t.confidenceSplit.medium.hitRate)})</span>
                <span>Low: {t.confidenceSplit.low.count} bets ({pctNum(t.confidenceSplit.low.hitRate)})</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── 6. Detailed Bet Log (Sortable, Paginated, Exportable) ─────────────────────

type BetSortKey =
  | "date"
  | "match"
  | "league"
  | "market"
  | "selection"
  | "odds"
  | "ev"
  | "result"
  | "pnl"
  | "rank"
  | "confidenceLevel"
  | "modelProb";

const PAGE_SIZES = [25, 50, 100];

const RESULT_ROW_BG: Record<ModeBet["result"], string> = {
  WIN: "bg-emerald-500/[0.07] hover:bg-emerald-500/[0.13]",
  LOSS: "bg-rose-500/[0.07] hover:bg-rose-500/[0.13]",
  PUSH: "bg-slate-500/[0.07] hover:bg-slate-500/[0.13]",
  VOID: "bg-slate-500/[0.07] hover:bg-slate-500/[0.13]",
  PENDING: "bg-amber-500/[0.07] hover:bg-amber-500/[0.13]",
};

export function BetsTable({
  bets,
  truncated,
}: {
  bets: ModeBet[];
  truncated: boolean;
}) {
  const [sort, setSort] = useState<BetSortKey>("date");
  const [dir, setDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [expanded, setExpanded] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const copy = [...bets];
    copy.sort((a, b) => {
      const av = a[sort];
      const bv = b[sort];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const c = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return dir === "asc" ? c : -c;
    });
    return copy;
  }, [bets, sort, dir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  const rows = sorted.slice(current * pageSize, current * pageSize + pageSize);

  const toggleSort = (key: BetSortKey) => {
    if (key === sort) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(key === "date" ? "desc" : "asc");
    }
    setPage(0);
  };

  if (bets.length === 0) {
    return (
      <EmptyState
        title="No bets match these filters"
        message="Widen the date range, clear filters, or pick another ranking mode."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-900">
        <table className="w-full min-w-[1100px] text-left text-xs">
          <thead className="bg-slate-950/80">
            <tr className="border-b border-slate-700">
              <th className="w-8 px-2 py-2.5" />
              <SortHeader label="Date" active={sort === "date"} dir={dir} onClick={() => toggleSort("date")} />
              <SortHeader label="Match" active={sort === "match"} dir={dir} onClick={() => toggleSort("match")} />
              <SortHeader label="League" active={sort === "league"} dir={dir} onClick={() => toggleSort("league")} />
              <SortHeader label="Rank" active={sort === "rank"} dir={dir} onClick={() => toggleSort("rank")} align="center" />
              <SortHeader label="Market" active={sort === "market"} dir={dir} onClick={() => toggleSort("market")} />
              <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Selection
              </th>
              <SortHeader label="Odds" active={sort === "odds"} dir={dir} onClick={() => toggleSort("odds")} align="right" />
              <SortHeader label="EV" active={sort === "ev"} dir={dir} onClick={() => toggleSort("ev")} align="right" />
              <SortHeader label="Confidence" active={sort === "confidenceLevel"} dir={dir} onClick={() => toggleSort("confidenceLevel")} align="center" />
              <SortHeader label="Result" active={sort === "result"} dir={dir} onClick={() => toggleSort("result")} align="center" />
              <SortHeader label="Profit / Loss" active={sort === "pnl"} dir={dir} onClick={() => toggleSort("pnl")} align="right" />
              <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Mode
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((bet) => {
              const open = expanded === bet.id;
              const style = MODE_STYLES[bet.mode];
              return (
                <FragmentRow key={bet.id}>
                  <tr className={cn("border-t border-slate-800 transition", RESULT_ROW_BG[bet.result])}>
                    <td className="px-2 py-2">
                      <button
                        onClick={() => setExpanded(open ? null : bet.id)}
                        aria-label={open ? "Hide factor breakdown" : "Show factor breakdown"}
                        className="cursor-pointer rounded px-1 text-slate-500 transition hover:text-amber-300"
                      >
                        {open ? "▾" : "▸"}
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-slate-300">{bet.date}</td>
                    <td className="max-w-[200px] truncate px-3 py-2 text-white font-medium" title={bet.match}>
                      {bet.match}
                    </td>
                    <td className="max-w-[140px] truncate px-3 py-2 text-slate-400" title={bet.league}>
                      {bet.league}
                    </td>
                    <td className="px-3 py-2 text-center font-mono">
                      {bet.rank !== null ? (
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] font-bold text-amber-300">
                          #{bet.rank}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="max-w-[180px] truncate px-3 py-2 text-slate-300" title={bet.market}>
                      {bet.market}
                    </td>
                    <td className="max-w-[150px] truncate px-3 py-2 text-slate-300" title={bet.selection}>
                      {bet.selection}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-200">{num(bet.odds)}</td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right font-mono",
                        bet.ev === null ? "text-slate-500" : bet.ev >= 0 ? "text-emerald-300" : "text-rose-300",
                      )}
                    >
                      {bet.ev === null ? "—" : `${(bet.ev * 100).toFixed(1)}%`}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span
                        className={cn(
                          "inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-bold",
                          bet.confidenceLevel === "HIGH"
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                            : bet.confidenceLevel === "MEDIUM"
                              ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
                              : "bg-orange-500/20 text-orange-300 border border-orange-500/40",
                        )}
                      >
                        {bet.confidenceLevel}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <ResultBadge result={uiResult(bet.result)} label={bet.result} />
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right font-mono font-bold",
                        bet.pnl === null
                          ? "text-slate-500"
                          : bet.pnl > 0
                            ? "text-emerald-300"
                            : bet.pnl < 0
                              ? "text-rose-300"
                              : "text-slate-400",
                      )}
                    >
                      {bet.pnl === null ? "—" : money(bet.pnl)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={cn("font-mono text-[11px] font-bold", style.text)}>{bet.mode}</span>
                    </td>
                  </tr>
                  {open ? (
                    <tr className="border-t border-slate-800 bg-slate-950/70">
                      <td colSpan={13} className="px-6 py-3">
                        <BetDetail bet={bet} />
                      </td>
                    </tr>
                  ) : null}
                </FragmentRow>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-[11px] text-slate-400">
        <span>
          {sorted.length} rows{truncated ? " (capped for transfer size)" : ""} · page {current + 1} / {pageCount}
        </span>
        <div className="flex items-center gap-2">
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(0);
            }}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200"
            aria-label="Rows per page"
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s} / page
              </option>
            ))}
          </select>
          <button
            onClick={() => setPage(Math.max(0, current - 1))}
            disabled={current === 0}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-3 py-1 text-slate-200 disabled:opacity-40"
          >
            ← Prev
          </button>
          <button
            onClick={() => setPage(Math.min(pageCount - 1, current + 1))}
            disabled={current >= pageCount - 1}
            className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-3 py-1 text-slate-200 disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}

function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function BetDetail({ bet }: { bet: ModeBet }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <div className="mb-2 font-mono text-[11px] font-bold uppercase tracking-wider text-slate-400">
          Contributing Factors & Weights
        </div>
        <div className="space-y-1.5">
          {bet.factors.map((f) => (
            <div key={f.factor} className="flex items-center gap-2">
              <span className="w-48 shrink-0 truncate text-[11px] text-slate-300">{f.factor}</span>
              <ProgressBar value={f.contribution ?? 0.5} tone={f.contribution === null ? "neutral" : "accent"} />
              <span className="w-12 shrink-0 text-right font-mono text-[11px] text-slate-400">
                {f.contribution === null ? "n/a" : `${(f.contribution * 100).toFixed(0)}%`}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap content-start gap-2">
        <Pill tone="info">Source: {bet.source}</Pill>
        <Pill tone="accent">Family: {bet.marketFamily}</Pill>
        {bet.modelProb !== null ? <Pill>Model Prob: {(bet.modelProb * 100).toFixed(1)}%</Pill> : null}
        {bet.stake !== null ? <Pill>Stake: {currency(bet.stake)}</Pill> : null}
        {bet.returnAmount !== null ? <Pill tone="positive">Return: {currency(bet.returnAmount)}</Pill> : null}
        <Pill>Time: {bet.timeOfDay}</Pill>
        <Pill>Orientation: {bet.orientation}</Pill>
        {bet.isLive ? <Pill tone="warning">Live / In-Play</Pill> : <Pill>Pre-Match</Pill>}
      </div>
    </div>
  );
}

// ─── 7. Expanded Factor Breakdown Panel ────────────────────────────────────────

function heatClass(rate: number): string {
  if (rate >= 90) return "bg-emerald-400";
  if (rate >= 80) return "bg-emerald-500";
  if (rate >= 70) return "bg-lime-500";
  if (rate >= 60) return "bg-amber-500";
  if (rate >= 50) return "bg-orange-500";
  return "bg-rose-500";
}

export function ExpandedFactorAccuracyPanel({
  factors,
  factorsByMode,
}: {
  factors: FactorAccuracyRow[];
  factorsByMode?: Record<RankingModeKey, FactorAccuracyRow[]>;
}) {
  const settled = factors.filter((f) => f.totalBets > 0);
  const [view, setView] = useState<"cards" | "heatmap">("cards");

  if (settled.length === 0) {
    return (
      <EmptyState
        title="No factor data yet"
        message="Factor performance appears as picks settle in this mode."
      />
    );
  }

  return (
    <div className="space-y-4">
      {factorsByMode ? (
        <div className="flex justify-end">
          <div className="inline-flex rounded-lg border border-slate-700 bg-slate-800 p-0.5 text-xs font-mono">
            <button
              onClick={() => setView("cards")}
              className={cn("rounded-md px-3 py-1 font-bold transition", view === "cards" ? "bg-amber-400 text-slate-950" : "text-slate-400 hover:text-white")}
            >
              Mode Factors
            </button>
            <button
              onClick={() => setView("heatmap")}
              className={cn("rounded-md px-3 py-1 font-bold transition", view === "heatmap" ? "bg-amber-400 text-slate-950" : "text-slate-400 hover:text-white")}
            >
              Cross-Mode Heatmap
            </button>
          </div>
        </div>
      ) : null}

      {view === "heatmap" && factorsByMode ? (
        <FactorHeatmapChart factorsByMode={factorsByMode} />
      ) : (
        <div className="space-y-3">
          {settled.map((f) => (
            <div key={f.factor} className="rounded-xl border border-slate-700 bg-slate-800 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-sm font-extrabold text-white">{f.factor}</span>
                  {f.averageContribution !== null ? (
                    <span className="ml-2 rounded border border-slate-700 bg-slate-900 px-2 py-0.5 font-mono text-[10px] text-amber-300">
                      avg weight {(f.averageContribution * 100).toFixed(0)}% · ranking weight {f.weightInRanking}%
                    </span>
                  ) : null}
                </div>
                <div className="flex items-baseline gap-3 font-mono">
                  <span className="text-xs text-slate-400">
                    {f.hits}W - {f.misses}L ({f.totalBets} bets)
                  </span>
                  <span className={cn("text-xl font-black tabular-nums", f.hitRate >= 65 ? "text-emerald-300" : "text-rose-300")}>
                    {pctNum(f.hitRate)}
                  </span>
                </div>
              </div>

              <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-900">
                <div
                  className={cn("h-full rounded-full transition-all", heatClass(f.hitRate))}
                  style={{ width: `${Math.max(0, Math.min(100, f.hitRate))}%` }}
                />
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[10px] text-slate-400 sm:grid-cols-4">
                <div>
                  P&L Driver: <strong className={f.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{money(f.pnl)}</strong>
                </div>
                <div>
                  Win Contribution: <strong className="text-white">{f.contributionPct}%</strong>
                </div>
                <div>
                  Correlation r: <strong className={f.correlation > 0 ? "text-emerald-300" : "text-slate-300"}>{f.correlation > 0 ? "+" : ""}{f.correlation.toFixed(2)}</strong>
                </div>
                <div>
                  Reliability: <strong className="text-amber-300">{f.reliabilityScore.toFixed(0)}/100</strong>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 8. Expanded Trends Panels ────────────────────────────────────────────────

export function ExpandedTrendPanels({
  windows,
  daily,
  rolling = [],
  calibration = [],
  drawdowns = [],
  allModesSeries = [],
  summary,
}: {
  windows: WindowSummary[];
  daily: DailyPoint[];
  rolling?: Array<{ date: string; hitRate: number; pnl: number; sharpe: number | null }>;
  calibration?: CalibrationBucket[];
  drawdowns?: DrawdownEpisode[];
  allModesSeries?: MultiModePoint[];
  summary: ModeSummary;
}) {
  const [activeWindow, setActiveWindow] = useState<WindowSummary["key"]>("30d");
  const [tab, setTab] = useState<"cumulative" | "multi" | "daily" | "rolling" | "distribution" | "calibration" | "recovery">("cumulative");

  const currentWin = windows.find((w) => w.key === activeWindow) ?? windows[windows.length - 1];

  return (
    <div className="space-y-4">
      {/* Trend Navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
        <div className="flex flex-wrap gap-1 font-mono text-xs">
          {[
            { key: "cumulative", label: "Cumulative P&L" },
            { key: "multi", label: "All 4 Modes Comparison" },
            { key: "daily", label: "Daily Hit Rate & P&L" },
            { key: "rolling", label: "Rolling 7-Day Momentum" },
            { key: "distribution", label: "W/L Distribution" },
            { key: "calibration", label: "Model Calibration" },
            { key: "recovery", label: "Drawdown Timeline" },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key as typeof tab)}
              className={cn(
                "cursor-pointer rounded-lg px-3 py-1.5 font-bold transition",
                tab === t.key
                  ? "bg-amber-400 text-slate-950"
                  : "bg-slate-800 text-slate-400 hover:text-white",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "cumulative" ? (
          <div className="flex gap-1 rounded-full border border-slate-700 bg-slate-800 p-1 font-mono text-[11px]">
            {windows.map((w) => (
              <button
                key={w.key}
                onClick={() => setActiveWindow(w.key)}
                className={cn(
                  "cursor-pointer rounded-full px-2.5 py-0.5 transition",
                  w.key === activeWindow ? "bg-amber-400 font-bold text-slate-950" : "text-slate-400 hover:text-white",
                )}
              >
                {w.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Tab Panels */}
      {tab === "cumulative" && currentWin ? (
        <Card>
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-xs font-bold text-white">
              CUMULATIVE P&L — {currentWin.label.toUpperCase()}
            </span>
            <span className="font-mono text-xs text-amber-300">
              Total: {signedCurrency(currentWin.pnl)} ({pctNum(currentWin.roi)} ROI)
            </span>
          </div>
          <PnLTrendChart
            points={currentWin.series.map((p) => ({ label: p.date, value: p.cumulativePnl, delta: p.pnl }))}
            emptyLabel="No settled bets in this window."
          />
        </Card>
      ) : null}

      {tab === "multi" ? (
        <Card>
          <div className="mb-1 font-mono text-xs font-bold text-white">
            MULTI-MODE CUMULATIVE P&L COMPARISON (ALL 4 MODES)
          </div>
          <p className="mb-3 text-xs text-slate-400">
            Compare performance trajectory of Classic A, 12-Factor B, Hybrid C, and Consensus D over time on one chart.
          </p>
          <MultiModePnLChart series={allModesSeries} height={260} />
        </Card>
      ) : null}

      {tab === "daily" && currentWin ? (
        <div className="space-y-4">
          <AccuracyBars
            daily={currentWin.series
              .filter((p) => p.wins + p.losses > 0)
              .map((p) => ({ date: p.date, accuracy: p.hitRate / 100, matches: p.bets }))}
            emptyLabel="No accuracy data yet."
          />
          <Card>
            <div className="mb-2 font-mono text-xs font-bold text-white">DAILY PROFIT & LOSS</div>
            <DailyPnlBars series={currentWin.series} />
          </Card>
        </div>
      ) : null}

      {tab === "rolling" ? (
        <Card>
          <RollingTrendChart rolling={rolling} height={200} />
        </Card>
      ) : null}

      {tab === "distribution" ? (
        <Card>
          <div className="mb-3 font-mono text-xs font-bold text-white">BET OUTCOME DISTRIBUTION</div>
          <OutcomeDistributionDonut
            wins={summary.wins}
            losses={summary.losses}
            pushes={summary.pushes}
            voids={summary.voids}
            pending={summary.pending}
          />
        </Card>
      ) : null}

      {tab === "calibration" ? (
        <Card>
          <div className="mb-1 font-mono text-xs font-bold text-white">
            PROBABILITY CALIBRATION CURVE
          </div>
          <p className="mb-3 text-xs text-slate-400">
            Plots the Oracle model&apos;s predicted probability brackets against actual realized win rates. The dashed 45° diagonal represents perfect calibration.
          </p>
          <CalibrationCurveChart buckets={calibration} />
        </Card>
      ) : null}

      {tab === "recovery" ? (
        <Card>
          <div className="mb-1 font-mono text-xs font-bold text-white">DRAWDOWN & RECOVERY TIMELINE</div>
          <p className="mb-3 text-xs text-slate-400">
            Historical peak-to-trough drawdowns and duration required to return to high-water mark.
          </p>
          <RecoveryTimelineChart episodes={drawdowns} />
        </Card>
      ) : null}
    </div>
  );
}

// ─── 9. Granular Breakdowns Section ───────────────────────────────────────────

export function BreakdownTable({
  rows,
  keyLabel,
  emptyLabel,
  limit = 12,
}: {
  rows: BreakdownRow[];
  keyLabel: string;
  emptyLabel: string;
  limit?: number;
}) {
  if (rows.length === 0) {
    return <EmptyState title="Nothing here yet" message={emptyLabel} />;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-900">
      <table className="w-full min-w-[560px] text-left text-xs">
        <thead>
          <tr className="border-b border-slate-700 text-[11px] uppercase tracking-wider text-slate-400">
            <th className="px-3 py-2">{keyLabel}</th>
            <th className="px-3 py-2 text-right">Bets</th>
            <th className="px-3 py-2 text-right">W / L</th>
            <th className="px-3 py-2 text-right">Hit rate</th>
            <th className="px-3 py-2 text-right">Avg odds</th>
            <th className="px-3 py-2 text-right">P&L</th>
            <th className="px-3 py-2 text-right">ROI</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((row) => (
            <tr key={row.key} className="border-t border-slate-800">
              <td className="max-w-[240px] truncate px-3 py-2 text-slate-200 font-medium" title={row.label}>
                {row.label}
              </td>
              <td className="px-3 py-2 text-right font-mono text-slate-300">{row.bets}</td>
              <td className="px-3 py-2 text-right font-mono">
                <span className="text-emerald-300">{row.wins}</span>
                <span className="text-slate-600"> / </span>
                <span className="text-rose-300">{row.losses}</span>
              </td>
              <td className="px-3 py-2 text-right">
                <div className="flex items-center justify-end gap-2">
                  <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-slate-800 sm:block">
                    <div className={cn("h-full", heatClass(row.hitRate))} style={{ width: `${row.hitRate}%` }} />
                  </div>
                  <span className="font-mono text-slate-200">{pctNum(row.hitRate)}</span>
                </div>
              </td>
              <td className="px-3 py-2 text-right font-mono text-slate-300">{num(row.averageOdds)}</td>
              <td
                className={cn(
                  "px-3 py-2 text-right font-mono font-bold",
                  row.pnl > 0 ? "text-emerald-300" : row.pnl < 0 ? "text-rose-300" : "text-slate-400",
                )}
              >
                {row.pnl === 0 ? "—" : money(row.pnl)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-slate-300">{pctNum(row.roi)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit ? (
        <div className="border-t border-slate-800 px-3 py-2 font-mono text-[10px] text-slate-500">
          Showing top {limit} of {rows.length} rows.
        </div>
      ) : null}
    </div>
  );
}

// ─── 10. Automated Insights & Recommendations Panel ───────────────────────────

export function AutomatedInsightsPanel({ insights }: { insights: AutomatedInsights }) {
  const recMeta = MODE_META[insights.recommendedMode];

  return (
    <div className="space-y-4">
      {/* Executive Recommendation Header */}
      <div className="rounded-2xl border border-emerald-500/40 bg-gradient-to-r from-emerald-950/40 via-slate-900 to-slate-900 p-5 shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-emerald-500/20 px-2 py-0.5 font-mono text-xs font-black text-emerald-300 border border-emerald-500/40">
                ✓ PRIMARY RECOMMENDATION
              </span>
              <h3 className="text-lg font-black text-white">{recMeta.label}</h3>
            </div>
            <p className="mt-1 max-w-2xl text-xs text-slate-300 leading-relaxed">
              {insights.recommendationReason}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* League Champions */}
        <Card>
          <div className="mb-2 font-mono text-xs font-bold text-white flex items-center gap-2">
            <span>🏆</span> BEST MODE BY LEAGUE
          </div>
          {insights.leagueLeaders.length > 0 ? (
            <div className="space-y-1.5">
              {insights.leagueLeaders.slice(0, 6).map((l) => (
                <div key={l.league} className="flex items-center justify-between rounded border border-slate-800 bg-slate-950/60 px-3 py-2 font-mono text-xs">
                  <span className="text-slate-200 font-semibold truncate max-w-[180px]">{l.league}</span>
                  <div className="flex items-center gap-2">
                    <span className={cn("font-bold", MODE_STYLES[l.bestMode].text)}>
                      {MODE_META[l.bestMode].short}
                    </span>
                    <span className="text-emerald-300">{pctNum(l.hitRate)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">Collect more settled league matches to unlock champions.</p>
          )}
        </Card>

        {/* Market Specialists */}
        <Card>
          <div className="mb-2 font-mono text-xs font-bold text-white flex items-center gap-2">
            <span>🎯</span> BEST MODE BY MARKET TYPE
          </div>
          {insights.marketLeaders.length > 0 ? (
            <div className="space-y-1.5">
              {insights.marketLeaders.slice(0, 6).map((m) => (
                <div key={m.marketFamily} className="flex items-center justify-between rounded border border-slate-800 bg-slate-950/60 px-3 py-2 font-mono text-xs">
                  <span className="text-slate-200 font-semibold">{m.marketFamily}</span>
                  <div className="flex items-center gap-2">
                    <span className={cn("font-bold", MODE_STYLES[m.bestMode].text)}>
                      {MODE_META[m.bestMode].short}
                    </span>
                    <span className="text-emerald-300">{pctNum(m.hitRate)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">Collect more settled markets to unlock specialists.</p>
          )}
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Trend Alerts */}
        <Card>
          <div className="mb-2 font-mono text-xs font-bold text-white flex items-center gap-2">
            <span>📈</span> TREND ALERTS (↑ / ↓)
          </div>
          {insights.trendAlerts.length > 0 ? (
            <div className="space-y-2">
              {insights.trendAlerts.map((a, i) => (
                <div
                  key={i}
                  className={cn(
                    "rounded-lg border p-2.5 font-mono text-xs",
                    a.type === "improving"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                      : "border-rose-500/30 bg-rose-500/10 text-rose-200",
                  )}
                >
                  <div className="font-bold flex items-center gap-1.5">
                    {a.type === "improving" ? "↑ IMPROVING MOMENTUM" : "↓ COOLING OFF"}
                  </div>
                  <p className="text-[11px] mt-0.5 opacity-90">{a.message}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">All modes are currently performing within their normal baseline.</p>
          )}
        </Card>

        {/* Warnings & Risk Controls */}
        <Card>
          <div className="mb-2 font-mono text-xs font-bold text-white flex items-center gap-2">
            <span>⚠️</span> PERFORMANCE WARNINGS & RISK ALERTS
          </div>
          {insights.warnings.length > 0 ? (
            <div className="space-y-2">
              {insights.warnings.map((w, i) => (
                <div
                  key={i}
                  className={cn(
                    "rounded-lg border p-2.5 font-mono text-xs",
                    w.severity === "high"
                      ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-200",
                  )}
                >
                  <div className="font-bold">⚠️ ATTENTION REQUIRED</div>
                  <p className="text-[11px] mt-0.5 opacity-90">{w.message}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">No active risk warnings. All modes operating safely.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

// ─── Skeletons ────────────────────────────────────────────────────────────────

export function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="h-44 animate-pulse rounded-2xl border border-slate-700 bg-slate-900" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 15 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl border border-slate-700 bg-slate-900" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-xl border border-slate-700 bg-slate-900" />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="h-72 animate-pulse rounded-xl border border-slate-700 bg-slate-900" />
        <div className="h-72 animate-pulse rounded-xl border border-slate-700 bg-slate-900" />
      </div>
    </div>
  );
}

export { Section, betsToCsv, betsToJson };
