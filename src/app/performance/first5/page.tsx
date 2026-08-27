// ĞIGI GIVØ — First 5 Minutes performance tracker (/performance/first5).
//
// Dedicated historical record for the First 5 Minutes feature: every pick the
// /api/first-5-minutes route generates is persisted to performance_log with
// feature = 'first5', settled by the /api/cron/settle feature pass from real
// first-5-minute event data, and reported here — fully separate from the A–D
// ranking-mode dashboards.
//
// Server component: rows are loaded straight from the database (fail-soft when
// DATABASE_URL is unreachable), filtered via URL search params (window pills,
// market-type chips + a plain GET form — no client JS required), and rendered
// with the shared performance UI kit. A flat $10 stake is settled at the
// pick-time 1xBet-ladder price stored with the pick, so P&L and ROI are
// derived from stored data only.
//
// Query parameters:
//   days    7 | 30 | all   look-back window on the match date (default 30)
//   from    YYYY-MM-DD      custom range start (overrides days)
//   to      YYYY-MM-DD      custom range end
//   league  league slug     single competition
//   market  goal|corner|card|penalty   market-type filter
//   result  WIN|LOSS|PUSH|VOID|PENDING result filter

import Link from "next/link";
import { PerformanceShell } from "@/app/_components/perf/PerformanceShell";
import { PnLTrendChart, type TrendPoint } from "@/app/_components/perf/charts";
import { ResultBadge, Section, StatCard, StreakBadge } from "@/app/_components/perf/ui";
import { LEAGUE_MAP } from "@/lib/leagues";
import type { PerformanceRow } from "@/db/schema";

export const dynamic = "force-dynamic";

// ─── Local helpers (server-safe — the perf/ui versions live in a client module
// and cannot be *called* from a server component) ──────────────────────────────

type BetResult = "win" | "loss" | "push" | "void" | "pending";

/** Map a stored outcome (WIN | LOSS | PUSH | VOID | pending | HIT | MISS …) onto the canonical result keys. */
function classifyOutcome(raw: string | null | undefined): { result: BetResult; label: string } {
  const v = (raw ?? "").toString().trim().toUpperCase();
  if (v === "HIT" || v === "WON" || v === "WIN") return { result: "win", label: "WIN" };
  if (v === "MISS" || v === "LOST" || v === "LOSS") return { result: "loss", label: "LOSS" };
  if (v === "PUSH") return { result: "push", label: "PUSH" };
  if (v === "VOID" || v === "CANCELLED" || v === "CANCELED") return { result: "void", label: "VOID" };
  return { result: "pending", label: "PENDING" };
}

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function pct(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

function signedCurrency(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  const sign = x > 0 ? "+" : x < 0 ? "-" : "";
  return `${sign}$${Math.abs(x).toFixed(digits)}`;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const PAGE_PATH = "/performance/first5";
const FEATURE_HOME = "/first-5-minutes";
const FEATURE_VALUE = "first5";
/** Flat stake every pick is settled at (kept identical to the value-bet tracker default). */
const FLAT_STAKE = 10;
/** Upper bound on rows read per request. */
const MAX_ROWS = 5000;

const WINDOW_OPTIONS = [
  { key: "7", label: "7d" },
  { key: "30", label: "30d" },
  { key: "all", label: "All" },
] as const;

const RESULT_OPTIONS = ["WIN", "LOSS", "PUSH", "VOID", "PENDING"] as const;

type MarketFamily = "goal" | "corner" | "card" | "penalty";

const MARKET_OPTIONS: Array<{ key: MarketFamily; label: string; icon: string }> = [
  { key: "goal", label: "Goal", icon: "⚽" },
  { key: "corner", label: "Corner", icon: "🏁" },
  { key: "card", label: "Card", icon: "🟨" },
  { key: "penalty", label: "Penalty", icon: "⚠️" },
];

// ─── Types ────────────────────────────────────────────────────────────────────

type SearchParams = Record<string, string | string[] | undefined>;

interface PickView {
  id: number;
  date: string;
  match: string;
  leagueName: string;
  leagueSlug: string;
  market: string;
  marketFamily: MarketFamily | null;
  selection: string;
  odds: number | null;
  hitRate: number | null;
  confidence: string | null;
  result: BetResult;
  resultLabel: string;
  pnl: number | null;
}

interface Metrics {
  total: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  pending: number;
  decided: number;
  hitRate: number | null;
  totalPnl: number;
  totalStaked: number;
  roi: number | null;
  avgOdds: number | null;
  streak: { count: number; type: "W" | "L" | null };
}

interface DayPoint {
  date: string;
  decided: number;
  wins: number;
  hitRate: number;
}

// ─── Loading (fail-soft) ──────────────────────────────────────────────────────

/** Every First 5 Minutes row, newest first. Never throws. */
async function loadFirst5Picks(): Promise<{ rows: PerformanceRow[]; error: string | null }> {
  try {
    const { db } = await import("@/db");
    const { performanceLog } = await import("@/db/schema");
    const { desc, eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(performanceLog)
      .where(eq(performanceLog.feature, FEATURE_VALUE))
      .orderBy(desc(performanceLog.matchDate), desc(performanceLog.id))
      .limit(MAX_ROWS);
    return { rows, error: null };
  } catch (error) {
    return {
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── Derivations (transparent, from stored columns only) ──────────────────────

/** Which of the four First 5 Minutes families a stored market label belongs to. */
function marketFamilyOf(market: string): MarketFamily | null {
  const m = market.toLowerCase();
  if (m.includes("goal")) return "goal";
  if (m.includes("corner")) return "corner";
  if (m.includes("card")) return "card";
  if (m.includes("penalty")) return "penalty";
  return null;
}

function leagueNameFor(row: PerformanceRow): string {
  if (row.leagueSlug && LEAGUE_MAP[row.leagueSlug]?.name) return LEAGUE_MAP[row.leagueSlug].name;
  return row.competitionName ?? row.league ?? "Unknown Competition";
}

/**
 * Decimal price at pick time — the 1xBet-ladder price stored with the pick
 * (top10Detail[0].odds), falling back to the fair price 1 / predicted hit rate
 * for rows persisted without one.
 */
function oddsFor(row: PerformanceRow): number | null {
  const detail = Array.isArray(row.top10Detail)
    ? (row.top10Detail as Array<{ odds?: unknown }>)[0]
    : null;
  const stored = detail?.odds;
  if (typeof stored === "number" && Number.isFinite(stored) && stored > 1) {
    return Math.round(stored * 100) / 100;
  }
  const hitRate = row.hitRate;
  if (typeof hitRate === "number" && hitRate > 0 && hitRate < 1) {
    return Math.round((1 / hitRate) * 100) / 100;
  }
  return null;
}

/** Flat-stake P&L: WIN pays stake × (odds − 1), LOSS loses the stake, pushes/voids refund. */
function pnlFor(result: BetResult, odds: number | null): number | null {
  if (result === "win") return Math.round(FLAT_STAKE * ((odds ?? 1) - 1) * 100) / 100;
  if (result === "loss") return -FLAT_STAKE;
  if (result === "push" || result === "void") return 0;
  return null;
}

function toPickView(row: PerformanceRow): PickView {
  const { result, label } = classifyOutcome(row.outcome);
  const market = row.market ?? "—";
  const odds = oddsFor(row);
  return {
    id: row.id,
    date: (row.matchDate ?? "").slice(0, 10),
    match: row.matchLabel,
    leagueName: leagueNameFor(row),
    leagueSlug: row.leagueSlug ?? "",
    market,
    marketFamily: marketFamilyOf(market),
    selection: row.selection ?? "—",
    odds,
    hitRate: typeof row.hitRate === "number" ? row.hitRate : null,
    confidence: row.confidence ?? null,
    result,
    resultLabel: label,
    pnl: pnlFor(result, odds),
  };
}

function computeMetrics(picks: PickView[]): Metrics {
  const wins = picks.filter((p) => p.result === "win");
  const losses = picks.filter((p) => p.result === "loss");
  const pushes = picks.filter((p) => p.result === "push");
  const voids = picks.filter((p) => p.result === "void");
  const pending = picks.filter((p) => p.result === "pending");
  const decided = [...wins, ...losses];
  const hitRate = decided.length > 0 ? wins.length / decided.length : null;

  const totalPnl = picks.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  const totalStaked = decided.length * FLAT_STAKE;
  const roi = totalStaked > 0 ? (totalPnl / totalStaked) * 100 : null;

  const withOdds = decided.filter((p) => p.odds !== null);
  const avgOdds =
    withOdds.length > 0
      ? Math.round((withOdds.reduce((sum, p) => sum + (p.odds ?? 0), 0) / withOdds.length) * 100) / 100
      : null;

  // Current streak over decided picks, newest first.
  const ordered = [...decided].sort(
    (a, b) => b.date.localeCompare(a.date) || b.id - a.id,
  );
  let streakType: "W" | "L" | null = null;
  let streakCount = 0;
  for (const pick of ordered) {
    const isWin = pick.result === "win";
    if (streakType === null) {
      streakType = isWin ? "W" : "L";
      streakCount = 1;
    } else if ((streakType === "W") === isWin) {
      streakCount++;
    } else break;
  }

  return {
    total: picks.length,
    wins: wins.length,
    losses: losses.length,
    pushes: pushes.length,
    voids: voids.length,
    pending: pending.length,
    decided: decided.length,
    hitRate,
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalStaked,
    roi,
    avgOdds,
    streak: { count: streakCount, type: streakType },
  };
}

/** Cumulative P&L over decided picks, one point per day (chronological). */
function cumulativePnlPoints(picks: PickView[]): TrendPoint[] {
  const decided = picks.filter((p) => p.pnl !== null);
  const byDay = new Map<string, number>();
  for (const pick of decided) {
    byDay.set(pick.date, (byDay.get(pick.date) ?? 0) + (pick.pnl ?? 0));
  }
  const points: TrendPoint[] = [];
  let running = 0;
  for (const [date, delta] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    running += delta;
    points.push({ label: date.slice(5), value: Math.round(running * 100) / 100, delta: Math.round(delta * 100) / 100 });
  }
  return points;
}

/** Daily hit rate over decided picks, oldest → newest (for the bar chart). */
function dailyHitRate(picks: PickView[]): DayPoint[] {
  const byDay = new Map<string, { decided: number; wins: number }>();
  for (const pick of picks) {
    if (pick.result !== "win" && pick.result !== "loss") continue;
    const bucket = byDay.get(pick.date) ?? { decided: 0, wins: 0 };
    bucket.decided++;
    if (pick.result === "win") bucket.wins++;
    byDay.set(pick.date, bucket);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      decided: v.decided,
      wins: v.wins,
      hitRate: v.decided > 0 ? v.wins / v.decided : 0,
    }));
}

// ─── Filters ──────────────────────────────────────────────────────────────────

function singleParam(params: SearchParams, key: string): string {
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function parseWindow(params: SearchParams): { days: string; from: string | null; to: string | null } {
  const from = singleParam(params, "from") || null;
  const to = singleParam(params, "to") || null;
  if (from) return { days: "custom", from, to };
  const days = singleParam(params, "days") || "30";
  return { days: days === "7" || days === "all" ? days : "30", from: null, to };
}

function dateOffset(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - (days - 1));
  return date.toISOString().slice(0, 10);
}

function buildHref(
  params: SearchParams,
  overrides: Record<string, string | null>,
): string {
  const query = new URLSearchParams();
  const keep: Record<string, string> = {
    days: singleParam(params, "days") || "30",
    league: singleParam(params, "league"),
    market: singleParam(params, "market"),
    result: singleParam(params, "result"),
  };
  for (const [key, value] of Object.entries({ ...keep, ...overrides })) {
    if (value) query.set(key, value);
  }
  const suffix = query.toString();
  return suffix ? `${PAGE_PATH}?${suffix}` : PAGE_PATH;
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function buildCsv(picks: PickView[]): string {
  const header = ["Date", "Match", "League", "Market", "Selection", "Odds", "Result", "Profit/Loss", "Confidence"];
  const lines = picks.map((p) =>
    [
      p.date,
      p.match,
      p.leagueName,
      p.market,
      p.selection,
      p.odds !== null ? p.odds.toFixed(2) : "",
      p.resultLabel,
      p.pnl !== null ? p.pnl.toFixed(2) : "",
      p.confidence ?? "",
    ]
      .map((cell) => csvEscape(String(cell)))
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

// ─── Daily hit-rate chart (pure server-rendered bars) ─────────────────────────

function DailyHitRateChart({ days }: { days: DayPoint[] }) {
  const points = days.slice(-60);
  if (points.length === 0) {
    return (
      <div className="flex h-28 items-center justify-center rounded-xl border border-slate-700 bg-slate-900">
        <span className="font-mono text-xs text-slate-500">No settled picks to chart yet.</span>
      </div>
    );
  }
  return (
    <div>
      <div className="relative flex h-28 items-end gap-0.5 rounded-xl border border-slate-700 bg-slate-900 p-2">
        {/* 50% reference line */}
        <div className="pointer-events-none absolute inset-x-2 top-1/2 border-t border-dashed border-slate-600/60" />
        {points.map((day) => {
          const height = Math.max(3, day.hitRate * 100);
          const tone =
            day.hitRate >= 0.6
              ? "bg-emerald-500/80"
              : day.hitRate >= 0.45
                ? "bg-cyan-500/80"
                : day.hitRate >= 0.3
                  ? "bg-amber-500/80"
                  : "bg-rose-500/80";
          return (
            <div
              key={day.date}
              className="relative flex h-full flex-1 items-end"
              title={`${day.date}: ${pct(day.hitRate, 0)} hit rate (${day.wins}W / ${day.decided} decided)`}
            >
              <div
                className={cn("w-full rounded-t transition-colors hover:brightness-125", tone)}
                style={{ height: `${height}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-slate-500">
        <span>{points[0].date}</span>
        <span>daily hit rate · dashed line = 50%</span>
        <span>{points[points.length - 1].date}</span>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function First5MinutesPerformancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const windowCfg = parseWindow(params);
  const leagueFilter = singleParam(params, "league");
  const marketFilter = singleParam(params, "market").toLowerCase();
  const resultFilter = singleParam(params, "result").toUpperCase();

  const { rows, error } = await loadFirst5Picks();

  return (
    <PerformanceShell
      title="First 5 Minutes Performance"
      subtitle="Every First 5 Minutes pick (Goal / Corner / Card / Penalty — Yes or No) — settled from real first-5-minute event data, with hit rate, P&L and ROI tracked separately from the ranking modes. Flat $10 stake per pick at the pick-time price."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={FEATURE_HOME}
          className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-500/20"
        >
          ⏱️ Back to First 5 Minutes
        </Link>
      </div>

      {error ? (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-8 text-center">
          <div className="mb-3 text-3xl">⚠️</div>
          <div className="mb-1 text-base font-bold text-rose-200">Couldn&apos;t load the track record</div>
          <p className="mx-auto mb-4 max-w-md break-words font-mono text-xs text-rose-300/70">{error}</p>
          <Link
            href={PAGE_PATH}
            className="inline-flex items-center rounded-full border border-rose-400/40 bg-rose-400/10 px-4 py-2 text-xs font-semibold text-rose-200 transition hover:bg-rose-400/20"
          >
            ↻ Retry
          </Link>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-10 text-center">
          <div className="mb-3 text-3xl">⏱️</div>
          <div className="mb-2 text-base font-bold text-slate-300">No First 5 Minutes picks tracked yet</div>
          <p className="mx-auto max-w-sm font-mono text-xs text-slate-400">
            Picks are recorded automatically whenever the First 5 Minutes feed generates a market. They settle
            here after each match finishes.
          </p>
          <Link
            href={FEATURE_HOME}
            className="mt-4 inline-flex items-center rounded-full border border-cyan-400/30 bg-cyan-500/10 px-4 py-2 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-500/20"
          >
            ⏱️ Open First 5 Minutes
          </Link>
        </div>
      ) : (
        <First5Content
          params={params}
          rows={rows}
          windowCfg={windowCfg}
          leagueFilter={leagueFilter}
          marketFilter={marketFilter}
          resultFilter={resultFilter}
        />
      )}
    </PerformanceShell>
  );
}

function First5Content({
  params,
  rows,
  windowCfg,
  leagueFilter,
  marketFilter,
  resultFilter,
}: {
  params: SearchParams;
  rows: PerformanceRow[];
  windowCfg: { days: string; from: string | null; to: string | null };
  leagueFilter: string;
  marketFilter: string;
  resultFilter: string;
}) {
  // ── Filter pipeline: window → league → market type → result ──────────────
  const allPicks = rows.map(toPickView);

  const leagueOptions = [...new Map(allPicks.map((p) => [p.leagueSlug || "unknown", p.leagueName])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));

  const from = windowCfg.from ?? (windowCfg.days === "all" ? null : dateOffset(Number(windowCfg.days)));
  const to = windowCfg.to;

  let picks = from ? allPicks.filter((p) => p.date >= from) : allPicks;
  if (to) picks = picks.filter((p) => p.date <= to);
  if (leagueFilter) picks = picks.filter((p) => (p.leagueSlug || "unknown") === leagueFilter);
  const wantedFamily = MARKET_OPTIONS.some((option) => option.key === marketFilter)
    ? (marketFilter as MarketFamily)
    : null;
  if (wantedFamily) picks = picks.filter((p) => p.marketFamily === wantedFamily);
  if (RESULT_OPTIONS.includes(resultFilter as (typeof RESULT_OPTIONS)[number])) {
    const wanted = resultFilter.toLowerCase();
    picks = picks.filter((p) => p.result === wanted);
  }

  const metrics = computeMetrics(picks);
  const trendPoints = cumulativePnlPoints(picks);
  const hitRateDays = dailyHitRate(picks);
  const csv = buildCsv(picks);

  const activeLeagueName = leagueOptions.find(([slug]) => slug === leagueFilter)?.[1] ?? leagueFilter;

  return (
    <>
      {/* ── Filters ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-700 bg-slate-900 p-3">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Window</span>
          {WINDOW_OPTIONS.map((option) => (
            <Link
              key={option.key}
              href={buildHref(params, { days: option.key, from: null, to: null })}
              aria-label={`Show the last ${option.key === "all" ? "all time" : `${option.key} days`}`}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-semibold transition",
                windowCfg.days === option.key
                  ? "bg-gradient-to-r from-cyan-400 to-teal-400 text-white shadow-lg shadow-cyan-500/30"
                  : "border border-slate-700 bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white",
              )}
            >
              {option.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">Market</span>
          <Link
            href={buildHref(params, { market: null })}
            aria-label="Show all four market types"
            className={cn(
              "rounded-full px-3 py-1.5 text-xs font-semibold transition",
              !wantedFamily
                ? "bg-gradient-to-r from-cyan-400 to-teal-400 text-white shadow-lg shadow-cyan-500/30"
                : "border border-slate-700 bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white",
            )}
          >
            All 4
          </Link>
          {MARKET_OPTIONS.map((option) => (
            <Link
              key={option.key}
              href={buildHref(params, { market: option.key })}
              aria-label={`Show only ${option.label} markets`}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-semibold transition",
                wantedFamily === option.key
                  ? "bg-gradient-to-r from-cyan-400 to-teal-400 text-white shadow-lg shadow-cyan-500/30"
                  : "border border-slate-700 bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white",
              )}
            >
              {option.icon} {option.label}
            </Link>
          ))}
        </div>

        {/* Plain GET form — filters without client JS. */}
        <form method="get" action={PAGE_PATH} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="days" value={windowCfg.days === "custom" ? "30" : windowCfg.days} />
          <select
            name="league"
            defaultValue={leagueFilter}
            aria-label="Filter by competition"
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 focus:border-cyan-400/50 focus:outline-none"
          >
            <option value="">All competitions ({allPicks.length})</option>
            {leagueOptions.map(([slug, name]) => (
              <option key={slug} value={slug}>
                {name}
              </option>
            ))}
          </select>
          <select
            name="result"
            defaultValue={resultFilter}
            aria-label="Filter by result"
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 focus:border-cyan-400/50 focus:outline-none"
          >
            <option value="">All results</option>
            {RESULT_OPTIONS.map((result) => (
              <option key={result} value={result}>
                {result}
              </option>
            ))}
          </select>
          <input
            type="date"
            name="from"
            defaultValue={windowCfg.from ?? ""}
            aria-label="Custom range start"
            className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-300 focus:border-cyan-400/50 focus:outline-none"
          />
          <input
            type="date"
            name="to"
            defaultValue={windowCfg.to ?? ""}
            aria-label="Custom range end"
            className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-300 focus:border-cyan-400/50 focus:outline-none"
          />
          <button
            type="submit"
            className="cursor-pointer rounded-full bg-gradient-to-r from-cyan-400 to-teal-400 px-4 py-1.5 text-xs font-bold text-white shadow-lg shadow-cyan-500/30 transition hover:brightness-110"
          >
            Apply filters
          </button>
          <Link
            href={PAGE_PATH}
            className="rounded-full border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-400 transition hover:bg-slate-700 hover:text-white"
          >
            Reset
          </Link>
        </form>
      </div>

      {/* ── Summary cards ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          label="Total Bets"
          value={metrics.total}
          sub={`${metrics.decided} settled · ${metrics.pending} pending`}
          tone="neutral"
        />
        <StatCard label="Wins" value={metrics.wins} sub="settled WIN" tone="positive" />
        <StatCard label="Losses" value={metrics.losses} sub="settled LOSS" tone="negative" />
        <StatCard label="Pushes" value={metrics.pushes} sub="stake returned" tone="neutral" />
        <StatCard label="Voids" value={metrics.voids} sub="stake returned" tone="neutral" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          label="Hit Rate"
          value={metrics.hitRate !== null ? pct(metrics.hitRate, 1) : "—"}
          sub={`${metrics.wins}W / ${metrics.losses}L`}
          tone={
            metrics.hitRate === null
              ? "neutral"
              : metrics.hitRate >= 0.6
                ? "positive"
                : metrics.hitRate >= 0.45
                  ? "info"
                  : "warning"
          }
        />
        <StatCard
          label="P&L"
          value={signedCurrency(metrics.totalPnl)}
          sub={`flat $${FLAT_STAKE} stakes`}
          tone={metrics.totalPnl >= 0 ? "positive" : "negative"}
        />
        <StatCard
          label="ROI"
          value={metrics.roi !== null ? `${metrics.roi >= 0 ? "+" : ""}${metrics.roi.toFixed(1)}%` : "—"}
          sub={`${signedCurrency(metrics.totalStaked)} staked`}
          tone={metrics.roi !== null && metrics.roi >= 0 ? "positive" : "negative"}
        />
        <StatCard
          label="Average Odds"
          value={metrics.avgOdds !== null ? metrics.avgOdds.toFixed(2) : "—"}
          sub="pick-time 1xBet price"
          tone="info"
        />
        <div className="flex flex-col justify-between rounded-xl border border-slate-700 bg-slate-900 p-4">
          <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Current Streak</span>
          <div className="mt-2">
            <StreakBadge count={metrics.streak.count} type={metrics.streak.type} />
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            {metrics.streak.type === "W" ? "winning run" : metrics.streak.type === "L" ? "losing run" : "no settled bets"}
          </div>
        </div>
      </div>

      {/* ── Trends ──────────────────────────────────────────────────────────── */}
      <Section
        title="Trends"
        subtitle={`cumulative P&L and daily hit rate · ${windowLabel(windowCfg)}${activeLeagueName ? ` · ${activeLeagueName}` : ""}${wantedFamily ? ` · ${wantedFamily} markets` : ""}`}
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
            <div className="mb-3 flex items-center gap-3">
              <span className="font-mono text-xs text-slate-400">Cumulative P&amp;L</span>
              <span
                className={cn(
                  "font-mono text-lg font-extrabold",
                  metrics.totalPnl >= 0 ? "text-emerald-300" : "text-rose-300",
                )}
              >
                {signedCurrency(metrics.totalPnl)}
              </span>
            </div>
            <PnLTrendChart points={trendPoints} />
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
            <div className="mb-3 flex items-center gap-3">
              <span className="font-mono text-xs text-slate-400">Daily Hit Rate</span>
              <span className="font-mono text-lg font-extrabold text-white">
                {metrics.hitRate !== null ? pct(metrics.hitRate, 1) : "—"}
              </span>
            </div>
            <DailyHitRateChart days={hitRateDays} />
          </div>
        </div>
      </Section>

      {/* ── Detailed table ──────────────────────────────────────────────────── */}
      <Section
        title="Detailed Performance Table"
        subtitle={`${picks.length} pick${picks.length === 1 ? "" : "s"} · newest first`}
        right={
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`}
            download="first-5-minutes-performance.csv"
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-700 hover:text-white"
          >
            ⇩ CSV export
          </a>
        }
      >
        <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-900">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-700 bg-slate-800">
              <tr>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Date</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">League</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Match / Market</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">Selection</th>
                <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-400">Odds</th>
                <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">Result</th>
                <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-400">Profit/Loss</th>
                <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">Confidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {picks.map((pick) => {
                const rowTint =
                  pick.result === "win"
                    ? "border-l-emerald-500"
                    : pick.result === "loss"
                      ? "border-l-rose-500"
                      : pick.result === "pending"
                        ? "border-l-amber-500"
                        : "border-l-slate-600";
                const familyMeta = MARKET_OPTIONS.find((option) => option.key === pick.marketFamily);
                return (
                  <tr key={pick.id} className={cn("border-l-2 transition hover:bg-slate-800", rowTint)}>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-slate-400">{pick.date}</td>
                    <td className="max-w-[140px] truncate px-3 py-2">
                      <div className="truncate text-[11px] font-semibold text-slate-200">{pick.leagueName}</div>
                      <div className="truncate font-mono text-[10px] text-slate-500">{pick.leagueSlug || "—"}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="max-w-[200px] truncate font-medium text-slate-100">{pick.match}</div>
                      <div className="max-w-[200px] truncate text-[11px] text-slate-400">
                        {familyMeta ? `${familyMeta.icon} ` : ""}
                        {pick.market}
                        {pick.hitRate !== null ? (
                          <span className="text-cyan-300/60"> · {pct(pick.hitRate, 1)} predicted</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "rounded border px-1.5 py-0.5 font-mono text-[11px] font-bold",
                          pick.selection.toLowerCase() === "yes"
                            ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                            : "border-rose-500/20 bg-rose-500/10 text-rose-300",
                        )}
                      >
                        {pick.selection}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-100">
                      {pick.odds !== null ? pick.odds.toFixed(2) : "—"}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <ResultBadge result={pick.result} label={pick.resultLabel} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-bold">
                      {pick.pnl !== null ? (
                        <span className={pick.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}>
                          {signedCurrency(pick.pnl)}
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <ConfidencePill confidence={pick.confidence} />
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

/** Confidence pill for the pick table. */
function ConfidencePill({ confidence }: { confidence: string | null }) {
  const value = (confidence ?? "").toUpperCase();
  if (!value) return <span className="text-slate-500">—</span>;
  const tone =
    value === "HIGH"
      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
      : value === "MEDIUM"
        ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
        : "border-slate-600/40 bg-slate-600/15 text-slate-400";
  return (
    <span className={cn("inline-flex rounded-md border px-2 py-0.5 font-mono text-[10px] font-bold tracking-wide", tone)}>
      {value}
    </span>
  );
}

function windowLabel(windowCfg: { days: string; from: string | null; to: string | null }): string {
  if (windowCfg.from) {
    return windowCfg.to ? `${windowCfg.from} → ${windowCfg.to}` : `since ${windowCfg.from}`;
  }
  return windowCfg.days === "all" ? "all time" : `last ${windowCfg.days} days`;
}
