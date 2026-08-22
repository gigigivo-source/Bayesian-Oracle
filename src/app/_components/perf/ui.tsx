"use client";

import type { ReactNode } from "react";
import { ACTION_BLUE } from "../design";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Tiny className combiner (avoids pulling in clsx for one file). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Format a 0..1 fraction as a percentage string, e.g. 0.823 -> "82.3%". */
export function pct(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

/** Signed number, e.g. 12.4 -> "+12.4", -3 -> "-3". */
export function signed(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  const r = x.toFixed(digits);
  return x > 0 ? `+${r}` : r;
}

/** Currency without sign, e.g. 12.4 -> "$12.40". */
export function currency(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return `$${Math.abs(x).toFixed(digits)}`;
}

/** Signed currency, e.g. 12.4 -> "+$12.40", -3 -> "-$3.00". */
export function signedCurrency(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  const sign = x > 0 ? "+" : x < 0 ? "-" : "";
  return `${sign}$${Math.abs(x).toFixed(digits)}`;
}

// ─── Result colour logic ──────────────────────────────────────────────────────

export type BetResult = "win" | "loss" | "push" | "void" | "pending";

/** Map any of the engine/API outcome strings to a canonical result + colour set. */
export function classifyOutcome(
  raw: string | null | undefined,
): { result: BetResult; label: string } {
  const v = (raw ?? "").toString().toUpperCase();
  if (v === "HIT" || v === "WON" || v === "WIN") return { result: "win", label: "WIN" };
  if (v === "MISS" || v === "LOST" || v === "LOSS") return { result: "loss", label: "LOSS" };
  if (v === "PUSH" || v === "DRAW") return { result: "push", label: "PUSH" };
  if (v === "VOID") return { result: "void", label: "VOID" };
  return { result: "pending", label: "PENDING" };
}

/** Tailwind class sets for each result — green win, red loss, grey push/void. */
export const RESULT_STYLES: Record<BetResult, { dot: string; text: string; chip: string; bar: string }> = {
  win: {
    dot: "bg-emerald-500",
    text: "text-emerald-300",
    chip: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    bar: "bg-emerald-500",
  },
  loss: {
    dot: "bg-rose-500",
    text: "text-rose-300",
    chip: "bg-rose-500/15 text-rose-300 border-rose-500/40",
    bar: "bg-rose-500",
  },
  push: {
    dot: "bg-slate-500",
    text: "text-slate-300",
    chip: "bg-slate-500/15 text-slate-300 border-slate-500/40",
    bar: "bg-slate-500",
  },
  void: {
    dot: "bg-slate-600",
    text: "text-slate-400",
    chip: "bg-slate-600/15 text-slate-400 border-slate-600/40",
    bar: "bg-slate-600",
  },
  pending: {
    dot: "bg-amber-500",
    text: "text-amber-300",
    chip: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    bar: "bg-amber-500",
  },
};

/** Colour for a numeric tone (used by StatCard value colour). */
export type Tone = "positive" | "negative" | "neutral" | "accent" | "info" | "warning";

const TONE_TEXT: Record<Tone, string> = {
  positive: "text-emerald-300",
  negative: "text-rose-300",
  neutral: "text-white",
  accent: "text-amber-300",
  info: "text-cyan-300",
  warning: "text-orange-300",
};

/** Pick a tone from a signed number (positive -> positive, etc). */
export function toneFor(x: number | null | undefined): Tone {
  if (x === null || x === undefined || Number.isNaN(x) || x === 0) return "neutral";
  return x > 0 ? "positive" : "negative";
}

// ─── Colour-coded result badge ────────────────────────────────────────────────

export function ResultBadge({ result, label }: { result: BetResult; label?: string }) {
  const s = RESULT_STYLES[result];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-bold font-mono tracking-wide",
        s.chip,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
      {label ?? result.toUpperCase()}
    </span>
  );
}

// ─── Layout primitives ────────────────────────────────────────────────────────

export function Section({
  title,
  subtitle,
  right,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("scroll-mt-28 space-y-4 sm:space-y-6 lg:space-y-8", className)}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="inline-block rounded-lg bg-slate-900 px-4 py-2">
          <h2 className="text-base font-semibold text-white md:text-lg lg:text-xl">{title}</h2>
          {subtitle ? <p className="mt-1 text-xs text-slate-300/80 md:text-sm">{subtitle}</p> : null}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Card({
  children,
  className,
  accent,
}: {
  children: ReactNode;
  className?: string;
  accent?: BetResult | Tone;
}) {
  const border =
    accent === "win" || accent === "positive"
      ? "border-emerald-500/30"
      : accent === "loss" || accent === "negative"
        ? "border-rose-500/30"
        : accent === "pending" || accent === "warning"
          ? "border-amber-500/30"
          : accent === "info"
            ? "border-cyan-500/30"
            : "border-slate-700";
  return (
    <div className={cn("responsive-card rounded-lg border bg-slate-800 transition-all duration-200 hover:-translate-y-2 hover:shadow-2xl", border, className)}>{children}</div>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────────────

export function StatCard({
  label,
  value,
  sub,
  tone = "neutral",
  icon,
  hint,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  hint?: string;
}) {
  return (
    <div
      className="responsive-card group relative overflow-hidden rounded-lg border border-slate-700 bg-slate-800 transition-all duration-200 hover:-translate-y-2 hover:border-slate-600 hover:shadow-2xl"
      title={hint}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
          {label}
        </span>
        {icon ? <span className="text-slate-500">{icon}</span> : null}
      </div>
      <div className={cn("mt-2 font-mono text-2xl font-extrabold tabular-nums", TONE_TEXT[tone])}>
        {value}
      </div>
      {sub ? <div className="mt-1 text-[11px] text-slate-400">{sub}</div> : null}
    </div>
  );
}

// ─── W/L/P/V breakdown strip ──────────────────────────────────────────────────

export function WlpvStrip({
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
  const items: Array<{ label: string; value: number; result: BetResult }> = [
    { label: "Wins", value: wins, result: "win" },
    { label: "Losses", value: losses, result: "loss" },
    ...(pushes > 0 ? [{ label: "Pushes", value: pushes, result: "push" as const }] : []),
    ...(voids > 0 ? [{ label: "Voids", value: voids, result: "void" as const }] : []),
    ...(pending > 0 ? [{ label: "Pending", value: pending, result: "pending" as const }] : []),
  ];
  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {items.map((it) => {
        const s = RESULT_STYLES[it.result];
        return (
          <div
            key={it.label}
            className={cn(
              "flex flex-1 flex-col items-center justify-center rounded-lg border px-3 py-2 min-w-[68px]",
              s.chip,
            )}
          >
            <span className="font-mono text-lg font-extrabold tabular-nums">{it.value}</span>
            <span className="text-[10px] font-bold uppercase tracking-wide">{it.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

export function ProgressBar({
  value,
  tone,
  className,
}: {
  value: number; // 0..1
  tone?: BetResult | Tone;
  className?: string;
}) {
  const pctW = `${Math.max(0, Math.min(1, value)) * 100}%`;
  const bar =
    tone === "positive" || tone === "win"
      ? "bg-emerald-500"
      : tone === "negative" || tone === "loss"
        ? "bg-rose-500"
        : tone === "pending" || tone === "warning"
          ? "bg-amber-500"
          : tone === "info"
            ? "bg-cyan-500"
            : tone === "accent"
              ? "bg-amber-400"
              : "bg-emerald-500";
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-slate-900", className)}>
      <div className={cn("h-full rounded-full transition-all", bar)} style={{ width: pctW }} />
    </div>
  );
}

// ─── Streak badge ─────────────────────────────────────────────────────────────

export function StreakBadge({ count, type }: { count: number; type: "W" | "L" | null }) {
  if (count === 0 || !type) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 font-mono text-xs text-slate-400">
        — No streak
      </span>
    );
  }
  const isWin = type === "W";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-xs font-bold",
        isWin
          ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
          : "border-rose-500/40 bg-rose-500/15 text-rose-300",
      )}
    >
      <span>{isWin ? "🔥" : "❄️"}</span>
      {count} {isWin ? "Win" : "Loss"}
      {count > 1 ? "s" : ""}
    </span>
  );
}

// ─── States ───────────────────────────────────────────────────────────────────

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-3">
        <span className="relative flex h-3 w-3">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-500" />
        </span>
        <span className="animate-pulse font-mono text-sm text-amber-300">{label}</span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-3 lg:gap-6 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="responsive-card h-24 animate-pulse rounded-lg border border-slate-700 bg-slate-800" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-xl border border-slate-700 bg-slate-900" />
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="responsive-card rounded-lg border border-rose-500/30 bg-rose-500/5 text-center">
      <div className="mb-3 text-3xl">⚠️</div>
      <div className="mb-1 text-base font-bold text-rose-200">Couldn&apos;t load performance data</div>
      <p className="mx-auto mb-4 max-w-md break-words font-mono text-xs text-rose-300/70">{message}</p>
      {onRetry ? (
        <button
          onClick={onRetry}
          className={ACTION_BLUE}
        >
          ↻ Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon = "📊",
  title,
  message,
}: {
  icon?: string;
  title: string;
  message: string;
}) {
  return (
    <div className="responsive-card rounded-lg border border-slate-700 bg-slate-800 text-center">
      <div className="mb-3 text-3xl">{icon}</div>
      <div className="mb-2 text-base font-bold text-slate-300">{title}</div>
      <p className="mx-auto max-w-sm font-mono text-xs text-slate-400">{message}</p>
    </div>
  );
}

/** Sort direction for table headers. */
export type SortDir = "asc" | "desc";

/** Sortable column header button used by performance tables. */
export function SortHeader({
  label,
  active,
  dir,
  onClick,
  align = "left",
  className,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: "left" | "center" | "right";
  className?: string;
}) {
  const alignCls = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  const arrow = active ? (dir === "desc" ? " ▼" : " ▲") : "";
  return (
    <th className={cn("select-none px-3 py-2 md:px-4 md:py-2.5 lg:px-6 lg:py-3", alignCls, className)}>
      <button
        onClick={onClick}
        className={cn(
          "inline-flex min-h-11 cursor-pointer select-none items-center gap-0.5 rounded text-xs font-semibold uppercase tracking-wider transition-all duration-200 hover:scale-105 active:scale-95",
          active ? "text-amber-300" : "text-slate-400 hover:text-white",
        )}
      >
        {label}
        <span className="text-[9px]">{arrow.trim()}</span>
      </button>
    </th>
  );
}

/** Small number-in-pill used inside table cells. */
export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: Tone | BetResult;
}) {
  const cls =
    tone === "positive" || tone === "win"
      ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/20"
      : tone === "negative" || tone === "loss"
        ? "bg-rose-500/10 text-rose-300 border-rose-500/20"
        : tone === "info"
          ? "bg-cyan-500/10 text-cyan-300 border-cyan-500/20"
          : tone === "accent" || tone === "pending" || tone === "warning"
            ? "bg-amber-500/10 text-amber-300 border-amber-500/20"
            : "bg-slate-800 text-slate-200 border-slate-700";
  return (
    <span className={cn("inline-block rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold", cls)}>
      {children}
    </span>
  );
}
