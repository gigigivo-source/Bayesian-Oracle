"use client";

import { useId, useState } from "react";
import { cn, pct, signedCurrency, currency } from "./ui";
import {
  MODE_META,
  RANKING_MODES,
  type CalibrationBucket,
  type DailyPoint,
  type DrawdownEpisode,
  type FactorAccuracyRow,
  type MultiModePoint,
  type RankingModeKey,
  type RollingPoint,
} from "@/lib/performance/modeAnalytics";

// ─── Sparkline ────────────────────────────────────────────────────────────────

export function Sparkline({
  values,
  className,
  positiveColor = "#34d399", // emerald-400
  negativeColor = "#fb7185", // rose-400
  height = 36,
}: {
  values: number[];
  className?: string;
  positiveColor?: string;
  negativeColor?: string;
  height?: number;
}) {
  const gradId = useId();
  const w = 100;
  const h = height;
  if (values.length === 0) {
    return <div className={cn("h-9", className)} />;
  }
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const step = values.length > 1 ? w / (values.length - 1) : w;

  const points = values.map((v, i) => {
    const x = i * step;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return [x, y] as const;
  });

  const path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const areaPath = `${path} L${w},${h} L0,${h} Z`;
  const last = values[values.length - 1];
  const up = last >= (values[0] ?? 0);
  const color = up ? positiveColor : negativeColor;
  const zeroY = h - ((0 - min) / range) * (h - 4) - 2;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn("w-full overflow-visible", className)}
      style={{ height }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* zero baseline */}
      {min < 0 && max > 0 ? (
        <line
          x1="0"
          y1={zeroY}
          x2={w}
          y2={zeroY}
          stroke="#ffffff"
          strokeOpacity="0.15"
          strokeWidth="0.5"
          strokeDasharray="2 2"
        />
      ) : null}
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ─── Score Gauge ──────────────────────────────────────────────────────────────

export function ScoreGauge({
  score,
  size = 72,
  strokeWidth = 6,
  className,
}: {
  score: number;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score));
  const strokeDashoffset = circumference - (clamped / 100) * circumference;

  const color =
    clamped >= 80
      ? "#fbbf24" // gold/amber
      : clamped >= 65
        ? "#34d399" // emerald
        : clamped >= 50
          ? "#38bdf8" // sky
          : "#fb7185"; // rose

  return (
    <div className={cn("relative flex items-center justify-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="transparent"
          stroke="#1e293b"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="transparent"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          className="transition-all duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-xs font-black text-white">{clamped.toFixed(0)}</span>
        <span className="text-[8px] font-bold uppercase tracking-wider text-slate-400">/100</span>
      </div>
    </div>
  );
}

// ─── P&L cumulative trend (line + area + axis) ────────────────────────────────

export interface TrendPoint {
  label: string;
  value: number;
  delta?: number;
}

export function PnLTrendChart({
  points,
  height = 220,
  money = true,
  emptyLabel = "No settled bets to chart yet.",
}: {
  points: TrendPoint[];
  height?: number;
  money?: boolean;
  emptyLabel?: string;
}) {
  const gradId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const w = 640;
  const h = height;
  const padL = 52;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-slate-700 bg-slate-900" style={{ height }}>
        <span className="font-mono text-xs text-slate-500">{emptyLabel}</span>
      </div>
    );
  }

  const values = points.map((p) => p.value);
  const dataMin = Math.min(...values, 0);
  const dataMax = Math.max(...values, 0);
  const range = dataMax - dataMin || 1;
  const yMin = dataMin - range * 0.1;
  const yMax = dataMax + range * 0.1;
  const yRange = yMax - yMin || 1;

  const xFor = (i: number) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const yFor = (v: number) => padT + innerH - ((v - yMin) / yRange) * innerH;
  const zeroY = yFor(0);

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(p.value).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${xFor(points.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${padL.toFixed(1)},${(padT + innerH).toFixed(1)} Z`;

  const finalValue = values[values.length - 1];
  const up = finalValue >= 0;
  const color = up ? "#34d399" : "#fb7185";

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * yRange);
  const fmt = (v: number) => (money ? `${v >= 0 ? "" : "-"}$${Math.abs(v).toFixed(0)}` : v.toFixed(0));

  const activePoint = hoverIndex !== null ? points[hoverIndex] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.32" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* grid + y labels */}
        {ticks.map((t, i) => {
          const y = yFor(t);
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="#ffffff" strokeOpacity="0.06" strokeWidth="1" />
              <text x={padL - 8} y={y + 3} textAnchor="end" className="fill-slate-500" style={{ fontSize: 9, fontFamily: "monospace" }}>
                {fmt(t)}
              </text>
            </g>
          );
        })}

        {/* zero line emphasis */}
        {yMin < 0 && yMax > 0 ? (
          <line
            x1={padL}
            y1={zeroY}
            x2={w - padR}
            y2={zeroY}
            stroke="#ffffff"
            strokeOpacity="0.25"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        ) : null}

        <path d={areaPath} fill={`url(#${gradId})`} />
        <path d={linePath} fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />

        {/* End point dot */}
        <circle cx={xFor(points.length - 1)} cy={yFor(finalValue)} r="4" fill={color} stroke="#0F1117" strokeWidth="2" />

        {/* Hover elements */}
        {hoverIndex !== null ? (
          <g>
            <line
              x1={xFor(hoverIndex)}
              y1={padT}
              x2={xFor(hoverIndex)}
              y2={padT + innerH}
              stroke="#fbbf24"
              strokeWidth="1"
              strokeDasharray="2 2"
            />
            <circle
              cx={xFor(hoverIndex)}
              cy={yFor(points[hoverIndex].value)}
              r="5"
              fill="#fbbf24"
              stroke="#0F1117"
              strokeWidth="2"
            />
          </g>
        ) : null}

        {/* Interactive hit areas */}
        {points.map((p, i) => (
          <rect
            key={i}
            x={xFor(i) - (innerW / points.length) / 2}
            y={padT}
            width={Math.max(innerW / points.length, 12)}
            height={innerH}
            fill="transparent"
            className="cursor-crosshair"
            onMouseEnter={() => setHoverIndex(i)}
          />
        ))}

        {/* x labels */}
        <text x={padL} y={h - 8} textAnchor="start" className="fill-slate-500" style={{ fontSize: 9, fontFamily: "monospace" }}>
          {points[0].label}
        </text>
        {points.length > 2 ? (
          <text
            x={padL + innerW / 2}
            y={h - 8}
            textAnchor="middle"
            className="fill-slate-500"
            style={{ fontSize: 9, fontFamily: "monospace" }}
          >
            {points[Math.floor(points.length / 2)].label}
          </text>
        ) : null}
        <text x={w - padR} y={h - 8} textAnchor="end" className="fill-slate-500" style={{ fontSize: 9, fontFamily: "monospace" }}>
          {points[points.length - 1].label}
        </text>
      </svg>

      {/* Floating tooltip */}
      {activePoint ? (
        <div className="pointer-events-none absolute right-4 top-2 rounded-lg border border-amber-400/40 bg-slate-950/90 px-2.5 py-1.5 font-mono text-[11px] text-white shadow-xl backdrop-blur">
          <div className="text-slate-400">{activePoint.label}</div>
          <div className="font-bold text-amber-300">
            Cumul. P&L: {signedCurrency(activePoint.value)}
          </div>
          {activePoint.delta !== undefined ? (
            <div className="text-[10px] text-slate-300">Daily: {signedCurrency(activePoint.delta)}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ─── Multi-Mode Cumulative P&L Chart (All 4 modes on 1 chart) ──────────────────

export const MULTI_MODE_COLORS: Record<RankingModeKey, string> = {
  A: "#F59E0B", // Amber
  B: "#14B8A6", // Teal
  C: "#8B5CF6", // Purple/Violet
  D: "#FDE047", // Yellow
};

export function MultiModePnLChart({
  series,
  height = 240,
}: {
  series: MultiModePoint[];
  height?: number;
}) {
  const [hoverDate, setHoverDate] = useState<string | null>(null);

  const w = 640;
  const h = height;
  const padL = 52;
  const padR = 16;
  const padT = 24;
  const padB = 28;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  if (series.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-slate-700 bg-slate-900" style={{ height }}>
        <span className="font-mono text-xs text-slate-500">No multi-mode performance data yet.</span>
      </div>
    );
  }

  const allVals = series.flatMap((s) => [s.A, s.B, s.C, s.D]);
  const dataMin = Math.min(...allVals, 0);
  const dataMax = Math.max(...allVals, 0);
  const range = dataMax - dataMin || 1;
  const yMin = dataMin - range * 0.1;
  const yMax = dataMax + range * 0.1;
  const yRange = yMax - yMin || 1;

  const xFor = (i: number) => padL + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const yFor = (v: number) => padT + innerH - ((v - yMin) / yRange) * innerH;
  const zeroY = yFor(0);

  const pathForMode = (mode: RankingModeKey) =>
    series.map((s, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(s[mode]).toFixed(1)}`).join(" ");

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * yRange);
  const hoverPoint = hoverDate ? series.find((s) => s.date === hoverDate) : null;

  return (
    <div className="relative">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex flex-wrap gap-4 font-mono text-[11px]">
          {RANKING_MODES.map((m) => (
            <span key={m} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: MULTI_MODE_COLORS[m] }} />
              <span className="text-slate-300 font-semibold">{MODE_META[m].short}</span>
              <span className="text-slate-400 font-bold">
                ({signedCurrency(series[series.length - 1]?.[m] ?? 0)})
              </span>
            </span>
          ))}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHoverDate(null)}
      >
        {/* grid */}
        {ticks.map((t, i) => {
          const y = yFor(t);
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="#ffffff" strokeOpacity="0.06" strokeWidth="1" />
              <text x={padL - 8} y={y + 3} textAnchor="end" className="fill-slate-500" style={{ fontSize: 9, fontFamily: "monospace" }}>
                ${t.toFixed(0)}
              </text>
            </g>
          );
        })}

        {/* zero line */}
        {yMin < 0 && yMax > 0 ? (
          <line
            x1={padL}
            y1={zeroY}
            x2={w - padR}
            y2={zeroY}
            stroke="#ffffff"
            strokeOpacity="0.25"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        ) : null}

        {/* mode lines */}
        {RANKING_MODES.map((m) => (
          <path
            key={m}
            d={pathForMode(m)}
            fill="none"
            stroke={MULTI_MODE_COLORS[m]}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.9}
          />
        ))}

        {/* End dots */}
        {RANKING_MODES.map((m) => {
          const last = series[series.length - 1];
          if (!last) return null;
          return (
            <circle
              key={m}
              cx={xFor(series.length - 1)}
              cy={yFor(last[m])}
              r="3.5"
              fill={MULTI_MODE_COLORS[m]}
              stroke="#0F1117"
              strokeWidth="1.5"
            />
          );
        })}

        {/* Interactive hover rects */}
        {series.map((s, i) => (
          <rect
            key={s.date}
            x={xFor(i) - (innerW / series.length) / 2}
            y={padT}
            width={Math.max(innerW / series.length, 12)}
            height={innerH}
            fill="transparent"
            className="cursor-crosshair"
            onMouseEnter={() => setHoverDate(s.date)}
          />
        ))}

        {/* Date labels */}
        <text x={padL} y={h - 8} textAnchor="start" className="fill-slate-500" style={{ fontSize: 9, fontFamily: "monospace" }}>
          {series[0].date}
        </text>
        <text x={w - padR} y={h - 8} textAnchor="end" className="fill-slate-500" style={{ fontSize: 9, fontFamily: "monospace" }}>
          {series[series.length - 1].date}
        </text>
      </svg>

      {/* Hover tooltip */}
      {hoverPoint ? (
        <div className="pointer-events-none absolute right-4 top-8 rounded-lg border border-slate-700 bg-slate-950/95 p-2 font-mono text-[10px] shadow-xl backdrop-blur">
          <div className="mb-1 text-slate-400 font-bold">{hoverPoint.date}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {RANKING_MODES.map((m) => (
              <div key={m} className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: MULTI_MODE_COLORS[m] }} />
                <span className="text-slate-300">{MODE_META[m].short}:</span>
                <span className="font-bold text-white">{signedCurrency(hoverPoint[m])}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Daily accuracy bar chart ─────────────────────────────────────────────────

export function AccuracyBars({
  daily,
  height = 120,
  emptyLabel = "No accuracy data yet.",
}: {
  daily: Array<{ date: string; accuracy: number; matches?: number }>;
  height?: number;
  emptyLabel?: string;
}) {
  if (daily.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-slate-700 bg-slate-900" style={{ height }}>
        <span className="font-mono text-xs text-slate-500">{emptyLabel}</span>
      </div>
    );
  }
  const last = daily.slice(-30);
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-xs font-bold text-white">DAILY HIT RATE (last {last.length} days)</span>
        <div className="flex gap-3 font-mono text-[10px] text-slate-400">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" /> ≥90%</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-amber-500" /> ≥75%</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-rose-500" /> &lt;60%</span>
        </div>
      </div>
      <div className="flex items-end gap-0.5" style={{ height }}>
        {last.map((d, i) => {
          const p = d.accuracy;
          const barH = Math.max(3, Math.round(p * height));
          const col = p >= 0.9 ? "bg-emerald-500" : p >= 0.75 ? "bg-amber-500" : p >= 0.6 ? "bg-orange-500" : "bg-rose-500";
          return (
            <div
              key={i}
              className="group relative flex flex-1 items-end"
              title={`${d.date}: ${pct(p, 0)}${d.matches ? ` (${d.matches} bets)` : ""}`}
            >
              <div className={cn("w-full rounded-t opacity-80 transition group-hover:opacity-100", col)} style={{ height: barH }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-slate-500">
        <span>{last[0].date}</span>
        <span>{last[last.length - 1].date}</span>
      </div>
    </div>
  );
}

// ─── Daily PnL Bars ───────────────────────────────────────────────────────────

export function DailyPnlBars({ series }: { series: DailyPoint[] }) {
  const points = series.slice(-30);
  if (points.length === 0) {
    return <p className="py-6 text-center font-mono text-xs text-slate-500">No daily P&L yet.</p>;
  }
  const peak = Math.max(...points.map((p) => Math.abs(p.pnl)), 1);
  return (
    <div>
      <div className="flex h-28 items-center gap-0.5">
        {points.map((p) => {
          const h = Math.max(3, (Math.abs(p.pnl) / peak) * 50);
          const up = p.pnl >= 0;
          return (
            <div
              key={p.date}
              className="flex flex-1 flex-col items-center justify-center group relative cursor-pointer"
              title={`${p.date}: ${signedCurrency(p.pnl)} (${p.bets} bets, ${p.wins}W-${p.losses}L)`}
            >
              <div className="flex h-1/2 w-full items-end justify-center">
                {up ? <div className="w-full rounded-t bg-emerald-500/80 transition group-hover:bg-emerald-400" style={{ height: `${h}%` }} /> : null}
              </div>
              <div className="h-px w-full bg-slate-700" />
              <div className="flex h-1/2 w-full items-start justify-center">
                {!up ? <div className="w-full rounded-b bg-rose-500/80 transition group-hover:bg-rose-400" style={{ height: `${h}%` }} /> : null}
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

// ─── Rolling 7-Day Trend Chart ────────────────────────────────────────────────

export function RollingTrendChart({
  rolling,
  height = 180,
}: {
  rolling: RollingPoint[];
  height?: number;
}) {
  const w = 600;
  const h = height;
  const padL = 48;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  if (rolling.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-slate-700 bg-slate-900" style={{ height }}>
        <span className="font-mono text-xs text-slate-500">No rolling momentum data yet.</span>
      </div>
    );
  }

  const xFor = (i: number) => padL + (rolling.length === 1 ? innerW / 2 : (i / (rolling.length - 1)) * innerW);
  const yForHitRate = (hr: number) => padT + innerH - (hr / 100) * innerH;

  const linePath = rolling.map((p, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yForHitRate(p.hitRate).toFixed(1)}`).join(" ");

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between font-mono text-[11px] text-slate-400">
        <span className="text-white font-bold">ROLLING 7-DAY HIT RATE</span>
        <span className="text-amber-300">
          Latest: {rolling[rolling.length - 1]?.hitRate.toFixed(1)}% · Rolling P&L: {signedCurrency(rolling[rolling.length - 1]?.pnl ?? 0)}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }} preserveAspectRatio="xMidYMid meet">
        {/* Reference lines: 50%, 75%, 100% */}
        {[50, 75, 100].map((level) => (
          <g key={level}>
            <line x1={padL} y1={yForHitRate(level)} x2={w - padR} y2={yForHitRate(level)} stroke="#ffffff" strokeOpacity="0.08" strokeWidth="1" />
            <text x={padL - 6} y={yForHitRate(level) + 3} textAnchor="end" className="fill-slate-500" style={{ fontSize: 9, fontFamily: "monospace" }}>
              {level}%
            </text>
          </g>
        ))}

        <path d={linePath} fill="none" stroke="#38bdf8" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={xFor(rolling.length - 1)} cy={yForHitRate(rolling[rolling.length - 1].hitRate)} r="4" fill="#38bdf8" stroke="#0F1117" strokeWidth="1.5" />

        <text x={padL} y={h - 6} textAnchor="start" className="fill-slate-500" style={{ fontSize: 9, fontFamily: "monospace" }}>
          {rolling[0].date}
        </text>
        <text x={w - padR} y={h - 6} textAnchor="end" className="fill-slate-500" style={{ fontSize: 9, fontFamily: "monospace" }}>
          {rolling[rolling.length - 1].date}
        </text>
      </svg>
    </div>
  );
}

// ─── Outcome Distribution Donut / Bars ────────────────────────────────────────

export function OutcomeDistributionDonut({
  wins,
  losses,
  pushes = 0,
  voids = 0,
  pending = 0,
}: {
  wins: number;
  losses: number;
  pushes?: number;
  voids?: number;
  pending?: number;
}) {
  const total = wins + losses + pushes + voids + pending;
  if (total === 0) return null;

  const items = [
    { label: "Wins", count: wins, pct: (wins / total) * 100, color: "bg-emerald-400 text-emerald-300" },
    { label: "Losses", count: losses, pct: (losses / total) * 100, color: "bg-rose-500 text-rose-300" },
    ...(pushes > 0 ? [{ label: "Pushes", count: pushes, pct: (pushes / total) * 100, color: "bg-slate-400 text-slate-300" }] : []),
    ...(voids > 0 ? [{ label: "Voids", count: voids, pct: (voids / total) * 100, color: "bg-slate-600 text-slate-400" }] : []),
    ...(pending > 0 ? [{ label: "Pending", count: pending, pct: (pending / total) * 100, color: "bg-amber-400 text-amber-300" }] : []),
  ];

  return (
    <div className="space-y-3">
      {/* Stacked bar */}
      <div className="flex h-4 w-full overflow-hidden rounded-full bg-slate-800">
        {items.map((it) => (
          <div
            key={it.label}
            className={cn("h-full transition-all", it.color.split(" ")[0])}
            style={{ width: `${it.pct}%` }}
            title={`${it.label}: ${it.count} (${it.pct.toFixed(1)}%)`}
          />
        ))}
      </div>

      {/* Legend & counts */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {items.map((it) => (
          <div key={it.label} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2 text-center">
            <div className="flex items-center justify-center gap-1.5">
              <span className={cn("h-2 w-2 rounded-full", it.color.split(" ")[0])} />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{it.label}</span>
            </div>
            <div className="mt-1 font-mono text-base font-black text-white">{it.count}</div>
            <div className="font-mono text-[10px] text-slate-400">{it.pct.toFixed(1)}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Calibration Curve Chart ──────────────────────────────────────────────────

export function CalibrationCurveChart({ buckets }: { buckets: CalibrationBucket[] }) {
  const size = 260;
  const pad = 36;
  const innerSize = size - pad * 2;

  const scale = (val: number) => pad + innerSize - (val / 100) * innerSize;
  const scaleX = (val: number) => pad + (val / 100) * innerSize;

  return (
    <div className="grid gap-4 md:grid-cols-2 items-center">
      <div className="flex justify-center">
        <svg width={size} height={size} className="overflow-visible">
          {/* Grid lines */}
          {[0, 25, 50, 75, 100].map((t) => (
            <g key={t}>
              <line x1={pad} y1={scale(t)} x2={pad + innerSize} y2={scale(t)} stroke="#ffffff" strokeOpacity="0.08" />
              <line x1={scaleX(t)} y1={pad} x2={scaleX(t)} y2={pad + innerSize} stroke="#ffffff" strokeOpacity="0.08" />
              <text x={pad - 6} y={scale(t) + 3} textAnchor="end" className="fill-slate-500" style={{ fontSize: 9, fontFamily: "monospace" }}>
                {t}%
              </text>
              <text x={scaleX(t)} y={pad + innerSize + 14} textAnchor="middle" className="fill-slate-500" style={{ fontSize: 9, fontFamily: "monospace" }}>
                {t}%
              </text>
            </g>
          ))}

          {/* 45 degree ideal diagonal */}
          <line
            x1={scaleX(0)}
            y1={scale(0)}
            x2={scaleX(100)}
            y2={scale(100)}
            stroke="#94a3b8"
            strokeOpacity="0.3"
            strokeWidth="1.5"
            strokeDasharray="4 4"
          />

          {/* Model points */}
          {buckets.filter((b) => b.count > 0).map((b) => {
            const cx = scaleX(b.predictedProb);
            const cy = scale(b.actualHitRate);
            const sizeR = Math.max(3.5, Math.min(8, Math.sqrt(b.count) * 2));
            const beat = b.actualHitRate >= b.predictedProb;
            return (
              <g key={b.bucket}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={sizeR}
                  fill={beat ? "#34d399" : "#fb7185"}
                  stroke="#0F1117"
                  strokeWidth="1.5"
                  className="transition hover:scale-125"
                />
              </g>
            );
          })}

          <text x={pad + innerSize / 2} y={size - 4} textAnchor="middle" className="fill-slate-400 font-bold" style={{ fontSize: 9 }}>
            Predicted Probability →
          </text>
          <text x={10} y={pad + innerSize / 2} textAnchor="middle" className="fill-slate-400 font-bold" style={{ fontSize: 9 }} transform={`rotate(-90 10 ${pad + innerSize / 2})`}>
            Realized Win Rate →
          </text>
        </svg>
      </div>

      <div className="space-y-2">
        <div className="font-mono text-xs font-bold text-white">CALIBRATION BUCKETS</div>
        <div className="space-y-1.5">
          {buckets.map((b) => (
            <div key={b.bucket} className="flex items-center justify-between rounded border border-slate-800 bg-slate-950/60 px-3 py-1.5 font-mono text-xs">
              <span className="text-slate-300 font-semibold">{b.bucket}</span>
              <span className="text-slate-400 text-[10px]">{b.count} bets</span>
              <span className="text-slate-200">pred {b.predictedProb.toFixed(0)}%</span>
              <span className={cn("font-bold", b.actualHitRate >= b.predictedProb ? "text-emerald-300" : "text-rose-300")}>
                actual {b.actualHitRate.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Recovery Timeline Chart ──────────────────────────────────────────────────

export function RecoveryTimelineChart({ episodes }: { episodes: DrawdownEpisode[] }) {
  if (episodes.length === 0) {
    return (
      <div className="py-8 text-center font-mono text-xs text-slate-500">
        No significant drawdown episodes recorded in this window.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {episodes.map((ep, i) => (
        <div key={i} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-mono text-xs font-bold text-rose-300">
                Drawdown of {currency(ep.maxDrop)}
              </span>
              <span className="ml-2 font-mono text-[10px] text-slate-400">
                {ep.peakDate} → {ep.troughDate}
              </span>
            </div>
            <div className="font-mono text-xs">
              {ep.recovered ? (
                <span className="rounded bg-emerald-500/15 px-2 py-0.5 font-bold text-emerald-300">
                  Recovered in {ep.durationDays}d ({ep.recoveryDate})
                </span>
              ) : (
                <span className="rounded bg-amber-500/15 px-2 py-0.5 font-bold text-amber-300">
                  In progress ({ep.durationDays}d)
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Cross-Mode Factor Heatmap ────────────────────────────────────────────────

export function FactorHeatmapChart({
  factorsByMode,
}: {
  factorsByMode: Record<RankingModeKey, FactorAccuracyRow[]>;
}) {
  const allFactorNames = Array.from(
    new Set(
      RANKING_MODES.flatMap((m) => factorsByMode[m]?.map((f) => f.factor) ?? []),
    ),
  );

  if (allFactorNames.length === 0) {
    return (
      <div className="py-8 text-center font-mono text-xs text-slate-500">
        No factor accuracy data available yet across modes.
      </div>
    );
  }

  const heatColor = (rate: number | null) => {
    if (rate === null) return "bg-slate-800 text-slate-500";
    if (rate >= 85) return "bg-emerald-500 text-slate-950 font-bold";
    if (rate >= 70) return "bg-emerald-600/80 text-white font-semibold";
    if (rate >= 60) return "bg-amber-500/80 text-slate-950 font-semibold";
    if (rate >= 50) return "bg-orange-500/80 text-slate-950";
    return "bg-rose-500/80 text-white";
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-900">
      <table className="w-full min-w-[560px] text-xs">
        <thead>
          <tr className="border-b border-slate-700 text-left font-mono text-[11px] text-slate-400">
            <th className="px-3 py-2.5">Factor</th>
            {RANKING_MODES.map((m) => (
              <th key={m} className="px-3 py-2.5 text-center">
                {MODE_META[m].short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {allFactorNames.map((factor) => (
            <tr key={factor} className="border-t border-slate-800">
              <td className="px-3 py-2 text-slate-200 font-medium">{factor}</td>
              {RANKING_MODES.map((m) => {
                const entry = factorsByMode[m]?.find((f) => f.factor === factor);
                const rate = entry && entry.totalBets > 0 ? entry.hitRate : null;
                return (
                  <td key={m} className="px-2 py-1.5 text-center">
                    <span
                      className={cn(
                        "inline-block w-16 rounded py-1 font-mono text-[11px] transition",
                        heatColor(rate),
                      )}
                      title={entry ? `${entry.hits}/${entry.totalBets} bets (${entry.hitRate}%)` : "No bets"}
                    >
                      {rate !== null ? `${rate.toFixed(0)}%` : "—"}
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
