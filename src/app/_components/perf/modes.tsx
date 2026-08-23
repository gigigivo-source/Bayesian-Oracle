"use client";

// ĞIGI GIVØ — Ranking-mode performance dashboard components.
//
// Presentational layer for /performance/modes. Everything here is driven by the
// `/api/performance/modes` payload — no client-side derivation of headline
// numbers, so what you read is exactly what the API computed from the logs.

import { useMemo, useState, type ReactNode } from "react";
import { AccuracyBars, PnLTrendChart, Sparkline } from "./charts";
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
import type {
  BreakdownRow,
  ComparisonMetricKey,
  ComparisonRow,
  FactorAccuracyRow,
  ModeBet,
  ModeReport,
  ModeSummary,
  RankingModeKey,
  WindowSummary,
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

// ─── Formatting ───────────────────────────────────────────────────────────────

export const pctNum = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : `${n.toFixed(digits)}%`;

export const num = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : n.toFixed(digits);

export const money = (n: number | null | undefined) => signedCurrency(n);

export const uiResult = (r: ModeBet["result"]): UiResult =>
  r === "WIN" ? "win" : r === "LOSS" ? "loss" : r === "PUSH" ? "push" : r === "VOID" ? "void" : "pending";

// ─── Mode colour tokens ───────────────────────────────────────────────────────
// A amber/gold · B teal/blue · C purple · D gold-white gradient.

export const MODE_STYLES: Record<
  RankingModeKey,
  { on: string; off: string; text: string; border: string; bar: string; glow: string; dot: string }
> = {
  A: {
    on: "bg-gradient-to-r from-[#F59E0B] to-[#FF8C00] text-white border-amber-300/40 shadow-[0_0_22px_-6px_rgba(245,158,11,0.65)]",
    off: "text-amber-200/80 hover:text-amber-100",
    text: "text-amber-300",
    border: "border-amber-400/40",
    bar: "bg-amber-400",
    glow: "shadow-[0_0_28px_-12px_rgba(245,158,11,0.8)]",
    dot: "bg-amber-400",
  },
  B: {
    on: "bg-gradient-to-r from-teal-500 to-sky-500 text-white border-teal-200/40 shadow-[0_0_22px_-6px_rgba(20,184,166,0.65)]",
    off: "text-teal-200/80 hover:text-teal-100",
    text: "text-teal-300",
    border: "border-teal-400/40",
    bar: "bg-teal-400",
    glow: "shadow-[0_0_28px_-12px_rgba(20,184,166,0.8)]",
    dot: "bg-teal-400",
  },
  C: {
    on: "bg-gradient-to-r from-violet-600 to-fuchsia-500 text-white border-violet-200/40 shadow-[0_0_22px_-6px_rgba(139,92,246,0.65)]",
    off: "text-violet-200/80 hover:text-violet-100",
    text: "text-violet-300",
    border: "border-violet-400/40",
    bar: "bg-violet-400",
    glow: "shadow-[0_0_28px_-12px_rgba(139,92,246,0.8)]",
    dot: "bg-violet-400",
  },
  D: {
    on: "bg-gradient-to-r from-[#FDE68A] via-white to-[#F59E0B] text-slate-900 border-white/60 shadow-[0_0_22px_-6px_rgba(253,230,138,0.75)]",
    off: "text-yellow-100/80 hover:text-white",
    text: "text-yellow-200",
    border: "border-yellow-200/40",
    bar: "bg-gradient-to-r from-yellow-200 to-amber-400",
    glow: "shadow-[0_0_28px_-12px_rgba(253,230,138,0.9)]",
    dot: "bg-gradient-to-r from-yellow-200 to-amber-400",
  },
};

// ─── Mode chips ───────────────────────────────────────────────────────────────

export function ModeChips({
  comparison,
  selected,
  onSelect,
}: {
  comparison: ComparisonRow[];
  selected: RankingModeKey;
  onSelect: (mode: RankingModeKey) => void;
}) {
  return (
    <div
      className="flex flex-wrap gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.04] p-2 backdrop-blur-xl"
      role="tablist"
      aria-label="Ranking mode"
    >
      {comparison.map((row) => {
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
            <span
              className={cn(
                "hidden rounded px-1.5 py-0.5 font-mono text-[10px] sm:inline",
                active ? "bg-black/20" : "bg-slate-900/60 text-slate-400",
              )}
            >
              {row.totalBets} · {pctNum(row.hitRate, 0)}
            </span>
            {row.bestIn.length > 0 ? <span title="Best-in-class metrics">⭐</span> : null}
          </button>
        );
      })}
    </div>
  );
}

// ─── Summary cards ────────────────────────────────────────────────────────────

function tone(value: number | null | undefined): Tone {
  if (value === null || value === undefined || value === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}

export function SummaryCards({ summary, mode }: { summary: ModeSummary; mode: RankingModeKey }) {
  const style = MODE_STYLES[mode];
  const streakTone: Tone =
    summary.currentStreak.type === "WIN"
      ? "positive"
      : summary.currentStreak.type === "LOSS"
        ? "negative"
        : "neutral";

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      <StatCard
        label="Total Bets"
        value={<span className="tabular-nums">{summary.totalBets}</span>}
        sub={`${summary.settledBets} settled · ${summary.pending} pending`}
        hint="Ranked picks + value bets + accumulator slips tracked for this mode."
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
        sub={`${pctNum(summary.pushPct)} / ${pctNum(summary.voidPct)} of all bets`}
      />
      <StatCard
        label="Hit Rate"
        value={<span className={style.text}>{pctNum(summary.hitRate)}</span>}
        sub="wins ÷ (wins + losses)"
        tone="accent"
      />
      <StatCard
        label="Total P&L"
        value={money(summary.totalPnl)}
        tone={tone(summary.totalPnl)}
        sub={`stake ${currency(summary.totalStake)} · return ${currency(summary.totalReturn)}`}
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
        label="Average EV"
        value={summary.averageEv === null ? "—" : pctNum(summary.averageEv * 100)}
        tone={tone(summary.averageEv)}
        sub="expected value per unit staked"
      />
      <StatCard
        label="Current Streak"
        value={summary.currentStreak.label}
        tone={streakTone}
        sub={`best ${summary.longestWinStreak}W · worst ${summary.longestLossStreak}L`}
      />
      <StatCard
        label="10/10 Hits"
        value={<span className="tabular-nums">{summary.tenOfTenHits}</span>}
        sub={`${summary.matchesTracked} matches · ${pctNum(summary.perfectMatchRate)} perfect`}
        tone={summary.tenOfTenHits > 0 ? "accent" : "neutral"}
      />
      <StatCard
        label="Total Stake"
        value={currency(summary.totalStake)}
        sub={`avg stake ${currency(summary.averageStake)}`}
      />
      <StatCard
        label="Total Return"
        value={currency(summary.totalReturn)}
        sub={`profit / settled bet ${summary.profitPerBet === null ? "—" : signedCurrency(summary.profitPerBet)}`}
      />
      <StatCard
        label="Top 1 / 3 / 10"
        value={
          <span className="tabular-nums text-base">
            {pctNum(summary.top1HitRate, 0)} / {pctNum(summary.top3HitRate, 0)} /{" "}
            {pctNum(summary.top10HitRate, 0)}
          </span>
        }
        sub="hit rate by rank tier"
      />
      <StatCard
        label="Model Calibration"
        value={
          summary.calibrationDelta === null ? "—" : `${summary.calibrationDelta > 0 ? "+" : ""}${summary.calibrationDelta.toFixed(1)}pp`
        }
        tone={tone(summary.calibrationDelta)}
        sub={`actual vs model ${summary.averageModelProb === null ? "—" : pctNum(summary.averageModelProb * 100)} · Brier ${num(summary.brierScore, 3)}`}
        hint="Positive = the mode beat its own predicted probabilities."
      />
      <StatCard
        label="Max Drawdown"
        value={currency(summary.maxDrawdown)}
        tone={summary.maxDrawdown > 0 ? "negative" : "neutral"}
        sub={`${summary.profitableDays} winning days · ${summary.losingDays} losing days`}
      />
    </div>
  );
}

// ─── Mode comparison ──────────────────────────────────────────────────────────

const COMPARISON_COLUMNS: Array<{
  key: ComparisonMetricKey;
  label: string;
  render: (row: ComparisonRow) => ReactNode;
}> = [
  { key: "hitRate", label: "Hit Rate", render: (r) => pctNum(r.hitRate) },
  { key: "roi", label: "ROI", render: (r) => pctNum(r.roi) },
  { key: "totalPnl", label: "Total P&L", render: (r) => money(r.totalPnl) },
  { key: "tenOfTenHits", label: "10/10 Hits", render: (r) => String(r.tenOfTenHits) },
  { key: "averageOdds", label: "Avg Odds", render: (r) => num(r.averageOdds) },
  { key: "totalBets", label: "Total Bets", render: (r) => String(r.totalBets) },
];

export function ModeComparison({
  rows,
  selected,
  onSelect,
}: {
  rows: ComparisonRow[];
  selected: RankingModeKey;
  onSelect: (mode: RankingModeKey) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-900">
      <table className="w-full min-w-[720px] text-left text-xs">
        <thead>
          <tr className="border-b border-slate-700 text-[11px] uppercase tracking-wider text-slate-400">
            <th className="px-3 py-2.5">Mode</th>
            {COMPARISON_COLUMNS.map((c) => (
              <th key={c.key} className="px-3 py-2.5 text-right">
                {c.label}
              </th>
            ))}
            <th className="px-3 py-2.5 text-right">Streak</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const style = MODE_STYLES[row.mode];
            const active = row.mode === selected;
            return (
              <tr
                key={row.mode}
                onClick={() => onSelect(row.mode)}
                className={cn(
                  "cursor-pointer border-t border-slate-800 transition hover:bg-slate-800/60",
                  active && "bg-slate-800/70",
                )}
              >
                <td className="px-3 py-2.5">
                  <span className="flex items-center gap-2">
                    <span className={cn("h-2.5 w-2.5 rounded-full", style.dot)} />
                    <span className={cn("font-semibold", active ? "text-white" : "text-slate-200")}>
                      {row.label}
                    </span>
                  </span>
                </td>
                {COMPARISON_COLUMNS.map((c) => {
                  const best = row.bestIn.includes(c.key);
                  return (
                    <td
                      key={c.key}
                      className={cn(
                        "px-3 py-2.5 text-right font-mono tabular-nums",
                        best ? "text-amber-300" : "text-slate-300",
                      )}
                    >
                      <span
                        className={cn(
                          best && "rounded-md border border-amber-400/60 bg-amber-400/10 px-1.5 py-0.5",
                        )}
                      >
                        {best ? "★ " : ""}
                        {c.render(row)}
                      </span>
                    </td>
                  );
                })}
                <td className="px-3 py-2.5 text-right font-mono text-slate-300">{row.currentStreak}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Factor accuracy ──────────────────────────────────────────────────────────

function heatClass(rate: number): string {
  if (rate >= 90) return "bg-emerald-400";
  if (rate >= 80) return "bg-emerald-500";
  if (rate >= 70) return "bg-lime-500";
  if (rate >= 60) return "bg-amber-500";
  if (rate >= 50) return "bg-orange-500";
  return "bg-rose-500";
}

export function FactorAccuracyPanel({ factors }: { factors: FactorAccuracyRow[] }) {
  const settled = factors.filter((f) => f.totalBets > 0);
  if (settled.length === 0) {
    return (
      <EmptyState
        title="No factor data yet"
        message="Factor accuracy appears as soon as picks in this mode settle."
      />
    );
  }
  const derived = settled.some((f) => f.derived);
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {settled.map((f) => (
          <div key={f.factor} className="rounded-lg border border-slate-700 bg-slate-800 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="truncate text-sm font-semibold text-slate-100">{f.factor}</span>
                {f.averageContribution !== null ? (
                  <span className="ml-2 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                    avg weight {(f.averageContribution * 100).toFixed(0)}%
                  </span>
                ) : null}
              </div>
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[11px] text-slate-500">
                  {f.hits}/{f.totalBets} settled
                </span>
                <span className={cn("font-mono text-xl font-extrabold tabular-nums", f.hitRate >= 60 ? "text-emerald-300" : "text-rose-300")}>
                  {pctNum(f.hitRate)}
                </span>
              </div>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-900">
              <div
                className={cn("h-full rounded-full transition-all", heatClass(f.hitRate))}
                style={{ width: `${Math.max(0, Math.min(100, f.hitRate))}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
              <span>{f.misses} misses</span>
              <span className={f.pnl >= 0 ? "text-emerald-400/80" : "text-rose-400/80"}>
                {money(f.pnl)}
              </span>
            </div>
          </div>
        ))}
      </div>
      {derived ? (
        <p className="font-mono text-[10px] text-slate-500">
          Buckets marked from the stored market family — engine runs that persist per-pick factor
          weights are shown with their average weight.
        </p>
      ) : null}
    </div>
  );
}

// ─── Generic breakdown table ──────────────────────────────────────────────────

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
              <td className="max-w-[240px] truncate px-3 py-2 text-slate-200" title={row.label}>
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
                  "px-3 py-2 text-right font-mono",
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

// ─── Trends ───────────────────────────────────────────────────────────────────

export function TrendPanels({ windows }: { windows: WindowSummary[] }) {
  const [active, setActive] = useState<WindowSummary["key"]>("30d");
  const win = windows.find((w) => w.key === active) ?? windows[windows.length - 1];
  if (!win) return null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-full border border-slate-700 bg-slate-800 p-1">
          {windows.map((w) => (
            <button
              key={w.key}
              onClick={() => setActive(w.key)}
              className={cn(
                "cursor-pointer rounded-full px-3 py-1 font-mono text-[11px] transition",
                w.key === active ? "bg-amber-400 font-bold text-slate-950" : "text-slate-400 hover:text-white",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-3 font-mono text-[11px] text-slate-400">
          <span>{win.bets} bets</span>
          <span>
            W/L <span className="text-emerald-300">{win.wins}</span>/
            <span className="text-rose-300">{win.losses}</span>
          </span>
          <span>Hit {pctNum(win.hitRate)}</span>
          <span className={win.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}>P&L {money(win.pnl)}</span>
          <span>ROI {pctNum(win.roi)}</span>
        </div>
      </div>

      <Card>
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-xs font-bold text-white">CUMULATIVE P&L — {win.label.toUpperCase()}</span>
          <span className="w-24">
            <Sparkline values={win.series.map((p) => p.cumulativePnl)} height={24} />
          </span>
        </div>
        <PnLTrendChart
          points={win.series.map((p) => ({ label: p.date, value: p.cumulativePnl, delta: p.pnl }))}
          emptyLabel="No settled staked bets in this window."
        />
      </Card>

      <AccuracyBars
        daily={win.series
          .filter((p) => p.wins + p.losses > 0)
          .map((p) => ({ date: p.date, accuracy: p.hitRate / 100, matches: p.bets }))}
        emptyLabel="No settled bets in this window."
      />

      <Card>
        <div className="mb-2 font-mono text-xs font-bold text-white">DAILY P&L</div>
        <DailyPnlBars series={win.series} />
      </Card>
    </div>
  );
}

function DailyPnlBars({ series }: { series: WindowSummary["series"] }) {
  const points = series.slice(-30);
  if (points.length === 0) {
    return <p className="py-6 text-center font-mono text-xs text-slate-500">No daily P&L yet.</p>;
  }
  const peak = Math.max(...points.map((p) => Math.abs(p.pnl)), 1);
  return (
    <div>
      <div className="flex h-28 items-center gap-0.5">
        {points.map((p) => {
          const h = Math.max(2, (Math.abs(p.pnl) / peak) * 50);
          const up = p.pnl >= 0;
          return (
            <div key={p.date} className="flex flex-1 flex-col items-center justify-center" title={`${p.date}: ${money(p.pnl)} (${p.bets} bets)`}>
              <div className="flex h-1/2 w-full items-end justify-center">
                {up ? <div className="w-full rounded-t bg-emerald-500/80" style={{ height: `${h}%` }} /> : null}
              </div>
              <div className="h-px w-full bg-slate-700" />
              <div className="flex h-1/2 w-full items-start justify-center">
                {!up ? <div className="w-full rounded-b bg-rose-500/80" style={{ height: `${h}%` }} /> : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-slate-500">
        <span>{points[0].date}</span>
        <span>{points[points.length - 1].date}</span>
      </div>
    </div>
  );
}

// ─── Detailed bet table ───────────────────────────────────────────────────────

type BetSortKey = "date" | "match" | "league" | "market" | "odds" | "result" | "pnl" | "ev";

const RESULT_ROW_BG: Record<ModeBet["result"], string> = {
  WIN: "bg-emerald-500/[0.07] hover:bg-emerald-500/[0.12]",
  LOSS: "bg-rose-500/[0.07] hover:bg-rose-500/[0.12]",
  PUSH: "bg-slate-500/[0.07] hover:bg-slate-500/[0.12]",
  VOID: "bg-slate-500/[0.07] hover:bg-slate-500/[0.12]",
  PENDING: "bg-amber-500/[0.07] hover:bg-amber-500/[0.12]",
};

const PAGE_SIZES = [25, 50, 100];

export function BetsTable({ bets, truncated }: { bets: ModeBet[]; truncated: boolean }) {
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
        message="Widen the date range, clear the league / result filters, or pick another ranking mode."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-900">
        <table className="w-full min-w-[980px] text-left text-xs">
          <thead className="bg-slate-900">
            <tr className="border-b border-slate-700">
              <th className="w-8 px-2 py-2.5" />
              <SortHeader label="Date" active={sort === "date"} dir={dir} onClick={() => toggleSort("date")} />
              <SortHeader label="Match" active={sort === "match"} dir={dir} onClick={() => toggleSort("match")} />
              <SortHeader label="League" active={sort === "league"} dir={dir} onClick={() => toggleSort("league")} />
              <SortHeader label="Market" active={sort === "market"} dir={dir} onClick={() => toggleSort("market")} />
              <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Selection
              </th>
              <SortHeader label="Odds" active={sort === "odds"} dir={dir} onClick={() => toggleSort("odds")} align="right" />
              <SortHeader label="EV" active={sort === "ev"} dir={dir} onClick={() => toggleSort("ev")} align="right" />
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
                    <td className="max-w-[220px] truncate px-3 py-2 text-white" title={bet.match}>
                      {bet.match}
                    </td>
                    <td className="max-w-[150px] truncate px-3 py-2 text-slate-400" title={bet.league}>
                      {bet.league}
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2 text-slate-300" title={bet.market}>
                      {bet.market}
                    </td>
                    <td className="max-w-[160px] truncate px-3 py-2 text-slate-300" title={bet.selection}>
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
                    <tr className="border-t border-slate-800 bg-slate-950/60">
                      <td colSpan={11} className="px-6 py-3">
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

      <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-[11px] text-slate-400">
        <span>
          {sorted.length} rows{truncated ? " (capped for transfer size)" : ""} · page {current + 1} /{" "}
          {pageCount}
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

/** Tables can't take a keyed fragment inline without a wrapper component. */
function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function BetDetail({ bet }: { bet: ModeBet }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <div className="mb-2 font-mono text-[11px] font-bold uppercase tracking-wider text-slate-400">
          Factor contribution
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
          {bet.factorsDerived ? (
            <p className="pt-1 font-mono text-[10px] text-slate-500">
              Derived from the stored market family — this run did not persist per-factor weights.
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap content-start gap-2">
        <Pill tone="info">source: {bet.source}</Pill>
        {bet.rank !== null ? <Pill tone="accent">rank #{bet.rank}</Pill> : null}
        {bet.modelProb !== null ? <Pill>model {(bet.modelProb * 100).toFixed(1)}%</Pill> : null}
        {bet.stake !== null ? <Pill>stake {currency(bet.stake)}</Pill> : null}
        {bet.returnAmount !== null ? <Pill tone="positive">return {currency(bet.returnAmount)}</Pill> : null}
        {bet.lowConfidence ? <Pill tone="warning">low confidence</Pill> : null}
        {bet.eventId ? <Pill>event {bet.eventId}</Pill> : null}
      </div>
    </div>
  );
}

// ─── CSV export ───────────────────────────────────────────────────────────────

export function betsToCsv(bets: ModeBet[]): string {
  const head = [
    "Date",
    "Match",
    "League",
    "Market",
    "Selection",
    "Odds",
    "Result",
    "Stake",
    "Profit/Loss",
    "Return",
    "EV",
    "Model probability",
    "Ranking mode",
    "Source",
    "Rank",
    "Factors",
  ];
  const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const lines = bets.map((b) =>
    [
      b.date,
      b.match,
      b.league,
      b.market,
      b.selection,
      b.odds ?? "",
      b.result,
      b.stake ?? "",
      b.pnl ?? "",
      b.returnAmount ?? "",
      b.ev ?? "",
      b.modelProb ?? "",
      b.mode,
      b.source,
      b.rank ?? "",
      b.factors.map((f) => f.factor).join(" | "),
    ]
      .map(esc)
      .join(","),
  );
  return [head.map(esc).join(","), ...lines].join("\n");
}

// ─── Skeletons ────────────────────────────────────────────────────────────────

export function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="h-12 animate-pulse rounded-2xl border border-slate-700 bg-slate-900" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 15 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl border border-slate-700 bg-slate-900" />
        ))}
      </div>
      <div className="h-40 animate-pulse rounded-xl border border-slate-700 bg-slate-900" />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="h-72 animate-pulse rounded-xl border border-slate-700 bg-slate-900" />
        <div className="h-72 animate-pulse rounded-xl border border-slate-700 bg-slate-900" />
      </div>
      <div className="h-96 animate-pulse rounded-xl border border-slate-700 bg-slate-900" />
    </div>
  );
}

export { Section };
