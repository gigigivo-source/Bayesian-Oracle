"use client";

import { useId } from "react";
import { cn, pct } from "./ui";

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
    const y = h - ((v - min) / range) * h;
    return [x, y] as const;
  });

  const path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const areaPath = `${path} L${w},${h} L0,${h} Z`;
  const last = values[values.length - 1];
  const up = last >= (values[0] ?? 0);
  const color = up ? positiveColor : negativeColor;
  const zeroY = h - ((0 - min) / range) * h;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn("w-full", className)}
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
        <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="#ffffff" strokeOpacity="0.12" strokeWidth="0.5" strokeDasharray="2 2" />
      ) : null}
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ─── P&L cumulative trend (line + area + axis) ────────────────────────────────

export interface TrendPoint {
  /** Human label for the x bucket, e.g. "2026-08-14" or "Match #3". */
  label: string;
  /** Cumulative value at this point. */
  value: number;
  /** Optional secondary value shown in the tooltip, e.g. per-period delta. */
  delta?: number;
}

export function PnLTrendChart({
  points,
  height = 200,
  money = true,
  emptyLabel = "No settled bets to chart yet.",
}: {
  points: TrendPoint[];
  height?: number;
  money?: boolean;
  emptyLabel?: string;
}) {
  const gradId = useId();
  const w = 600;
  const h = height;
  const padL = 48;
  const padR = 12;
  const padT = 12;
  const padB = 24;
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
  // pad a little so the line isn't flush to the top/bottom edge
  const yMin = dataMin - range * 0.08;
  const yMax = dataMax + range * 0.08;
  const yRange = yMax - yMin || 1;

  const xFor = (i: number) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const yFor = (v: number) => padT + innerH - ((v - yMin) / yRange) * innerH;
  const zeroY = yFor(0);

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(p.value).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${xFor(points.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${padL.toFixed(1)},${(padT + innerH).toFixed(1)} Z`;

  const finalValue = values[values.length - 1];
  const up = finalValue >= 0;
  const color = up ? "#34d399" : "#fb7185";

  // y-axis grid lines (4 ticks)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * yRange);
  const fmt = (v: number) => (money ? `${v >= 0 ? "" : "-"}$${Math.abs(v).toFixed(0)}` : v.toFixed(0));

  return (
    <div className="table-scroll"><svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full min-w-[500px]" style={{ height }} preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.30" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* grid + y labels */}
      {ticks.map((t, i) => {
        const y = yFor(t);
        return (
          <g key={i}>
            <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="#ffffff" strokeOpacity="0.06" strokeWidth="1" />
            <text x={padL - 6} y={y + 3} textAnchor="end" className="fill-slate-500" style={{ fontSize: 9, fontFamily: "monospace" }}>
              {fmt(t)}
            </text>
          </g>
        );
      })}

      {/* zero line emphasis */}
      {yMin < 0 && yMax > 0 ? (
        <line x1={padL} y1={zeroY} x2={w - padR} y2={zeroY} stroke="#ffffff" strokeOpacity="0.25" strokeWidth="1" strokeDasharray="3 3" />
      ) : null}

      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

      {/* end point dot */}
      <circle cx={xFor(points.length - 1)} cy={yFor(finalValue)} r="3.5" fill={color} stroke="#0F1117" strokeWidth="1.5" />

      {/* x labels: first + last */}
      <text x={padL} y={h - 6} textAnchor="start" className="fill-slate-500" style={{ fontSize: 9, fontFamily: "monospace" }}>
        {points[0].label}
      </text>
      <text x={w - padR} y={h - 6} textAnchor="end" className="fill-slate-500" style={{ fontSize: 9, fontFamily: "monospace" }}>
        {points[points.length - 1].label}
      </text>
    </svg></div>
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
    <div className="responsive-card rounded-lg border border-slate-700 bg-slate-800">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="font-mono text-xs font-bold text-white">DAILY HIT RATE (last {last.length} days)</span>
        <div className="flex flex-wrap gap-3 font-mono text-xs text-slate-400">
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
              title={`${d.date}: ${pct(p, 0)}${d.matches ? ` (${d.matches} matches)` : ""}`}
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
