import type { First5MarketKey } from "./types";

export const MARKET_ORDER: First5MarketKey[] = ["goal", "corner", "card", "penalty"];

export const MARKET_LABEL: Record<First5MarketKey, string> = {
  goal: "⚽ Goal",
  corner: "🏁 Corner",
  card: "🟨 Card",
  penalty: "⚠️ Penalty",
};

export function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Display 1xBet / fair odds without trailing zeros (1.125, 1.03, 5.8, 15). */
export function formatOdds(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return value
    .toFixed(3)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatDateGroup(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const base = new Intl.DateTimeFormat("en", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
  if (date.toDateString() === today.toDateString()) return `Today · ${base}`;
  if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow · ${base}`;
  return base;
}

export function sourceBadgeTone(source: string): string {
  const key = source.toLowerCase();
  if (key.includes("sportscore")) {
    return "border-cyan-400/40 bg-cyan-500/15 text-cyan-200";
  }
  if (key.includes("api-football") || key.includes("api football")) {
    return "border-violet-400/40 bg-violet-500/15 text-violet-200";
  }
  if (key.includes("synthetic") || key.includes("league")) {
    return "border-slate-400/25 bg-slate-500/15 text-slate-300";
  }
  return "border-purple-400/30 bg-purple-500/10 text-purple-200";
}
