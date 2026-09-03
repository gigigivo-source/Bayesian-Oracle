"use client";

// ĞIGI GIVØ — Profit Maximizer.
//
// The ultimate betting cheat sheet: every market the app predicts (ranking
// modes A–D, Sure Bet Corners, First 5 Minutes) is priced against real
// bookmaker odds, only the positive-EV ones survive, and each is sized with
// the Kelly Criterion. Data comes from /api/profit-maximizer (1-hour cache,
// force-refresh via the Refresh pill, MIN EV floor via ?minEv=).
//
// Emerald = profit, amber = caution, rose = below the floor — the only accent
// language on the board, so a green tile always means the same thing.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHIP,
  CHIP_PREMIUM,
  CHIP_PREMIUM_ON_EMERALD,
  GLASS_DROPDOWN,
  GLASS_PANEL,
  GLASS_PILL_CONTAINER,
  NAV_PILL,
  NAV_PILL_OFF,
} from "../_components/design";

export const dynamic = "force-dynamic";

// ─── Payload types (mirrors src/app/api/profit-maximizer/route.ts) ────────────

type ProfitSource =
  | "Rank A"
  | "Rank B"
  | "Rank C"
  | "Rank D"
  | "Sure Bet Corners"
  | "First 5 Minutes";

type DataQuality = "real" | "mixed" | "synthetic";

interface ConfidenceBreakdown {
  dataQuality: DataQuality;
  dataQualityPoints: number;
  sourceCount: number;
  sourceAgreementPoints: number;
  completenessPct: number;
  completenessPoints: number;
}

interface ProfitMarket {
  dedupeKey: string;
  eventId: string;
  leagueSlug: string;
  league: string;
  leagueTier: number;
  homeTeam: string;
  awayTeam: string;
  matchLabel: string;
  matchDate: string;
  marketName: string;
  selection: string;
  family: string;
  hitRate: number;
  bookmakerOdds: number | null;
  oddsSource: "bookmaker" | "fair";
  oddsProvider: string | null;
  fairOdds: number;
  ev: number;
  evPercent: string;
  kellyStake: number;
  profitScore: number;
  confidenceScore: number;
  dataQuality: DataQuality;
  dataSourceDetail: string;
  confidenceBreakdown: ConfidenceBreakdown;
  source: ProfitSource;
  alsoSeenIn: ProfitSource[];
}

interface SourceReport {
  source: ProfitSource | "Ranking Modes (A–D)";
  ok: boolean;
  fixtures: number;
  marketsEvaluated: number;
  /** Unique markets this source won after cross-source dedupe. */
  retained: number;
  /** Retained markets that cleared this request's MIN EV floor. */
  qualifying: number;
  error?: string;
}

interface ProfitMaximizerData {
  generatedAt: string;
  totalMarketsScanned: number;
  qualifyingMarkets: ProfitMarket[];
  filters: {
    minEv: number;
    minEvPercent: string;
    defaultMinEv: number;
    lookaheadDays: number;
    maxRankingFixtures: number;
    sources: ProfitSource[];
    /** Scan window for the header pill — label ("Next 7 days") + concrete dates. */
    dateRange: { label: string; from: string; to: string };
  };
  summary: {
    totalMarketsScanned: number;
    qualifyingBets: number;
    matchesWithBets: number;
    averageEvPercent: number;
    averageKellyStake: number;
    bestEvPercent: number;
    belowThreshold: number;
    positiveEvMarkets: number;
    withRealBookmakerOdds: number;
    fairOddsOnly: number;
    duplicatesRemoved: number;
    skippedMarkets: number;
  };
  sources: SourceReport[];
  methodology: {
    evFormula: string;
    kellyFormula: string;
    fairOddsFormula: string;
    oddsPriority: string[];
    notes: string[];
  };
  cache: { ttlMinutes: number; hit: boolean; forcedRefresh: boolean };
  partial: boolean;
  fixturesChecked: number;
  error?: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

/** MIN EV chips (5% / 10% / 15% / 20%) — 5% is the API default. */
const MIN_EV_OPTIONS = [
  { value: 0.05, label: "5%" },
  { value: 0.10, label: "10%" },
  { value: 0.15, label: "15%" },
  { value: 0.20, label: "20%" },
] as const;

const DEFAULT_MIN_EV = MIN_EV_OPTIONS[0].value;

const DATA_QUALITY_BADGE: Record<DataQuality, { label: string; name: string; tone: string; tooltip: string }> = {
  real: {
    label: "🔵 Real",
    name: "Real",
    tone: "border-cyan-400/40 bg-cyan-500/15 text-cyan-200",
    tooltip: "Based on real team-specific stats",
  },
  mixed: {
    label: "🟡 Mixed",
    name: "Mixed",
    tone: "border-amber-400/40 bg-amber-500/15 text-amber-200",
    tooltip: "One side had real stats, the other rode the league-average baseline",
  },
  synthetic: {
    label: "⚪ Synthetic",
    name: "Synthetic",
    tone: "border-slate-400/30 bg-slate-500/15 text-slate-300",
    tooltip: "Based on the synthetic baseline (league averages), not team-specific stats",
  },
};

const SOURCE_TONE: Record<string, string> = {
  "Rank A": "border-amber-400/40 bg-amber-500/15 text-amber-200",
  "Rank B": "border-teal-400/40 bg-teal-500/15 text-teal-200",
  "Rank C": "border-violet-400/40 bg-violet-500/15 text-violet-200",
  "Rank D": "border-yellow-300/40 bg-yellow-500/15 text-yellow-200",
  "Sure Bet Corners": "border-cyan-400/40 bg-cyan-500/15 text-cyan-200",
  "First 5 Minutes": "border-sky-400/40 bg-sky-500/15 text-sky-200",
};

// ─── Formatting helpers ───────────────────────────────────────────────────────

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPercentage(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function formatOdds(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatDateTime(value: string): string {
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

function formatDateGroup(value: string): string {
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

/** EV colour language: emerald ≥ 15%, amber 5–14%, rose below 5%. */
function evTone(ev: number): string {
  if (ev >= 0.15) return "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/40";
  if (ev >= 0.05) return "bg-amber-500/20 text-amber-300 ring-1 ring-amber-400/40";
  return "bg-rose-500/20 text-rose-300 ring-1 ring-rose-400/40";
}

function profitScoreTone(score: number): string {
  if (score >= 70) return "text-emerald-300";
  if (score >= 45) return "text-amber-300";
  return "text-slate-300";
}

function confidenceTooltip(market: ProfitMarket): string {
  const b = market.confidenceBreakdown;
  const lines = [`Confidence: ${market.confidenceScore}`];
  if (b) {
    lines.push(
      `• Data Quality: ${DATA_QUALITY_BADGE[b.dataQuality]?.name ?? b.dataQuality} (${b.dataQualityPoints}/40)`,
      `• Source Agreement: ${
        b.sourceCount >= 2
          ? `${b.sourceCount} sources agree`
          : b.sourceCount === 1
            ? "1 source (no cross-check)"
            : "No real sources"
      } (${b.sourceAgreementPoints}/30)`,
      `• Stat Completeness: ${
        b.completenessPct >= 100
          ? "All stats present"
          : b.completenessPct <= 0
            ? "No team-specific stats"
            : `${Math.round(b.completenessPct)}% of stats present`
      } (${b.completenessPoints}/30)`,
    );
  }
  if (market.dataSourceDetail) lines.push(`Source: ${market.dataSourceDetail}`);
  return lines.join("\n");
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProfitMaximizerPage() {
  const [data, setData] = useState<ProfitMaximizerData | null>(null);
  const [minEv, setMinEv] = useState<number>(DEFAULT_MIN_EV);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Payload mirror for event handlers: the threshold it was filtered for
   *  decides whether a chip switch is a client-side subset (no request) or a
   *  wider scan that has to go back to the API. */
  const dataRef = useRef<ProfitMaximizerData | null>(null);
  const initialFetchDone = useRef(false);
  const requestSeq = useRef(0);

  const load = useCallback(async (threshold: number, forceRefresh = false) => {
    const seq = ++requestSeq.current;
    if (forceRefresh || dataRef.current) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ minEv: String(threshold) });
      if (forceRefresh) params.set("refresh", "true");
      const response = await fetch(`/api/profit-maximizer?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as ProfitMaximizerData;
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      // Drop out-of-order responses (a slow refresh must not overwrite a newer scan).
      if (seq !== requestSeq.current) return;
      dataRef.current = payload;
      setData(payload);
    } catch (reason) {
      if (seq !== requestSeq.current) return;
      setError(
        reason instanceof Error ? reason.message : "Unable to load the Profit Maximizer board.",
      );
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (initialFetchDone.current) return;
    initialFetchDone.current = true;
    void load(DEFAULT_MIN_EV);
  }, [load]);

  /**
   * MIN EV chip. Raising the floor is a strict subset of what is already
   * loaded, so it re-renders instantly; lowering it asks the API for the wider
   * scan (the endpoint keeps the result in its one-hour cache, so each
   * threshold is only ever computed once per server).
   */
  const applyMinEv = useCallback(
    (threshold: number) => {
      setMinEv(threshold);
      const loaded = dataRef.current;
      if (loaded && threshold < loaded.filters.minEv) void load(threshold);
    },
    [load],
  );

  const markets = useMemo(() => {
    if (!data) return [];
    const all = data.qualifyingMarkets ?? [];
    return minEv >= data.filters.minEv ? all.filter((market) => market.ev > minEv) : [];
  }, [data, minEv]);

  const summary = useMemo(() => {
    const total = markets.length;
    const averageEv = total ? markets.reduce((sum, m) => sum + m.ev, 0) / total : 0;
    const averageKelly = total ? markets.reduce((sum, m) => sum + m.kellyStake, 0) / total : 0;
    return {
      totalMarketsScanned: data?.totalMarketsScanned ?? 0,
      qualifyingBets: total,
      averageEvPercent: averageEv * 100,
      averageKellyStake: averageKelly,
      bestEv: markets[0]?.ev ?? 0,
      matches: new Set(markets.map((market) => market.eventId)).size,
      realOdds: markets.filter((market) => market.oddsSource === "bookmaker").length,
    };
  }, [data, markets]);

  // Group the qualifying bets by kickoff day, then by match.
  const groups = useMemo(() => {
    if (markets.length === 0) return [];
    const byDay = new Map<string, Map<string, ProfitMarket[]>>();
    for (const market of markets) {
      const day = new Date(market.matchDate).toISOString().slice(0, 10);
      const matches = byDay.get(day) ?? new Map<string, ProfitMarket[]>();
      const picks = matches.get(market.eventId) ?? [];
      picks.push(market);
      matches.set(market.eventId, picks);
      byDay.set(day, matches);
    }
    return [...byDay.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, matches]) => ({
        day,
        matches: [...matches.entries()]
          .map(([eventId, picks]) => ({ eventId, match: picks[0], markets: picks }))
          .sort(
            (left, right) =>
              new Date(left.match.matchDate).getTime() - new Date(right.match.matchDate).getTime() ||
              Math.max(...right.markets.map((m) => m.ev)) - Math.max(...left.markets.map((m) => m.ev)),
          ),
      }));
  }, [markets]);

  const chipBusy = loading || refreshing;

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#05070d] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(16,185,129,0.16)_0%,_rgba(5,7,13,0.2)_45%,_#05070d_75%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 right-0 h-80 w-80 rounded-full bg-emerald-500/10 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-0 h-72 w-72 rounded-full bg-amber-500/[0.07] blur-3xl"
      />

      <style>{`
        @keyframes profit-title-glow {
          0%, 100% { text-shadow: 0 0 14px rgba(16,185,129,0.35), 0 0 3px rgba(52,211,153,0.25); }
          50% { text-shadow: 0 0 30px rgba(16,185,129,0.9), 0 0 14px rgba(52,211,153,0.5); }
        }
        @keyframes profit-stagger-in {
          from { opacity: 0; transform: translateY(14px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .profit-title-glow { animation: profit-title-glow 2.4s ease-in-out infinite; }
        .profit-stagger { animation: profit-stagger-in 0.5s ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .profit-title-glow, .profit-stagger { animation: none; }
        }
      `}</style>

      <div className="relative mx-auto max-w-7xl space-y-6">
        {/* ── Header ── */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-emerald-200">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              Rank A–D · Sure Bet Corners · First 5 Minutes
              {data && ` · ${data.filters.dateRange.label}`}
            </div>
            <h1 className="profit-title-glow text-3xl font-extrabold tracking-tight text-emerald-50 sm:text-4xl">
              💰 Profit Maximizer
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400 sm:text-base">
              Only positive EV bets. Optimal Kelly stakes.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/"
              className={`${NAV_PILL} ${NAV_PILL_OFF} px-3 py-2 text-xs font-semibold`}
            >
              ← Oracle
            </Link>
            <button
              type="button"
              onClick={() => void load(minEv, true)}
              disabled={chipBusy}
              aria-label="Force a fresh Profit Maximizer calculation"
              className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 px-4 py-2 text-xs font-bold text-white shadow-[0_0_22px_-6px_rgba(16,185,129,0.75)] ring-1 ring-emerald-300/40 transition-all duration-300 hover:scale-105 hover:brightness-110 active:scale-95 disabled:pointer-events-none disabled:opacity-60"
            >
              {refreshing ? (
                <>
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  Recalculating…
                </>
              ) : (
                <>🔄 Refresh</>
              )}
            </button>
          </div>
        </div>

        {/* ── MIN EV filter + cache state ── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
              Min EV filter
            </span>
            <div className={`${GLASS_PILL_CONTAINER} flex-wrap`} role="group" aria-label="Minimum EV filter">
              {MIN_EV_OPTIONS.map((option) => {
                const active = minEv === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => applyMinEv(option.value)}
                    aria-pressed={active}
                    aria-label={`Minimum EV threshold ${option.label}`}
                    className={`${CHIP_PREMIUM} px-3 py-1.5 text-xs font-bold ${
                      active ? CHIP_PREMIUM_ON_EMERALD : "text-slate-300"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            {data?.cache.hit && (
              <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-slate-400">
                ⏱ cached · {new Date(data.generatedAt).toLocaleTimeString()}
              </span>
            )}
            {data?.partial && (
              <span className="rounded-full border border-amber-400/40 bg-amber-500/15 px-2 py-1 text-amber-200">
                ⚠ partial scan
              </span>
            )}
          </div>
        </div>

        {/* ── Methodology strip ── */}
        <div className={`grid grid-cols-1 gap-3 rounded-2xl p-4 text-xs sm:grid-cols-2 lg:grid-cols-4 ${GLASS_PANEL}`}>
          <div>
            <div className="font-mono uppercase tracking-wider text-emerald-300">Expected value</div>
            <p className="mt-1 text-slate-400">
              {data?.methodology.evFormula ?? "EV = (hitRate × bookmakerOdds) − 1"} — every market the
              app predicts is re-priced against the book, then only bets with a real edge survive.
            </p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-emerald-300">Kelly staking</div>
            <p className="mt-1 text-slate-400">
              {data?.methodology.kellyFormula ?? "stake = EV / (odds − 1)"} — the growth-optimal
              fraction of the bankroll for each edge.
            </p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-amber-300">Odds priority</div>
            <ul className="mt-1 space-y-0.5 text-slate-400">
              {(data?.methodology.oddsPriority ?? []).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-amber-300">Scan coverage</div>
            <p className="mt-1 text-slate-400">
              {data
                ? `${data.fixturesChecked} fixture(s) checked · ${data.filters.lookaheadDays}-day engine window · results cached ${Math.round(
                    data.cache.ttlMinutes / 60,
                  )}h.`
                : "Every ranked market, corner market and opening-phase market on the board."}
            </p>
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5 text-sm text-rose-200">
            <div className="font-bold">Profit Maximizer is temporarily unavailable</div>
            <p className="mt-1 text-rose-200/70">{error}</p>
            <button
              type="button"
              onClick={() => void load(minEv)}
              className={`${CHIP} mt-3 rounded-full border border-rose-400/30 bg-rose-400/10 px-4 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-400/20`}
            >
              🔄 Retry
            </button>
          </div>
        )}

        {/* ── Summary cards ── */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryCard
            label="Total Markets Scanned"
            value={loading && !data ? "—" : String(summary.totalMarketsScanned)}
            sub={data ? `${data.fixturesChecked} fixtures · all sources` : "All sources"}
            tone="slate"
          />
          <SummaryCard
            label={`Qualifying Bets (EV > ${(minEv * 100).toFixed(0)}%)`}
            value={loading && !data ? "—" : String(summary.qualifyingBets)}
            sub={
              data
                ? `${summary.matches} match(es) · ${summary.realOdds} real-priced`
                : "Positive EV only"
            }
            tone="emerald"
          />
          <SummaryCard
            label="Average EV%"
            value={loading && !data ? "—" : `${summary.averageEvPercent.toFixed(1)}%`}
            sub={
              data && summary.bestEv > 0
                ? `best +${(summary.bestEv * 100).toFixed(1)}%`
                : "qualifying bets only"
            }
            tone={summary.averageEvPercent >= 15 ? "emerald" : summary.averageEvPercent > 0 ? "amber" : "rose"}
          />
          <SummaryCard
            label="Average Kelly Stake"
            value={loading && !data ? "—" : `${(summary.averageKellyStake * 100).toFixed(1)}%`}
            sub="of bankroll per bet"
            tone="amber"
          />
        </div>

        {/* ── Source ledger ── */}
        {data && data.sources.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {data.sources.map((report) => (
              <div
                key={report.source}
                title={report.error ? `Failed: ${report.error}` : `${report.fixtures} fixture(s) scanned`}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider ${
                  report.error
                    ? "border-rose-400/40 bg-rose-500/10 text-rose-300"
                    : report.qualifying > 0
                      ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-200"
                      : "border-white/[0.08] bg-white/[0.04] text-slate-400"
                }`}
              >
                <span className="font-bold normal-case tracking-normal">{report.source}</span>
                <span>{report.marketsEvaluated} scanned</span>
                <span className="text-slate-500">{report.retained} kept</span>
                <span className={report.qualifying > 0 ? "text-emerald-300" : "text-slate-500"}>
                  {report.qualifying} ✓
                </span>
                {!report.ok && <span>⚠</span>}
              </div>
            ))}
          </div>
        )}

        {/* ── Board ── */}
        {loading && !data ? (
          <LoadingBoard />
        ) : chipBusy && markets.length === 0 ? (
          <LoadingBoard />
        ) : markets.length === 0 ? (
          <EmptyState
            minEv={minEv}
            scanned={summary.totalMarketsScanned}
            positiveEv={data?.summary.positiveEvMarkets ?? 0}
            belowThreshold={data?.summary.belowThreshold ?? 0}
            realOdds={data?.summary.withRealBookmakerOdds ?? 0}
            fairOnly={data?.summary.fairOddsOnly ?? 0}
            duplicates={data?.summary.duplicatesRemoved ?? 0}
            loading={chipBusy}
            onLower={() => applyMinEv(MIN_EV_OPTIONS[0].value)}
          />
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <section key={group.day} className="space-y-3">
                <div className="flex items-center gap-3">
                  <h2 className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-300/80">
                    {formatDateGroup(group.matches[0]!.match.matchDate)}
                  </h2>
                  <span className="h-px flex-1 bg-gradient-to-r from-emerald-400/30 via-white/10 to-transparent" />
                  <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
                    {group.matches.length} match(es) · {group.matches.reduce((sum, m) => sum + m.markets.length, 0)} bet(s)
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  {group.matches.map((entry, index) => (
                    <MatchCard
                      key={entry.eventId}
                      match={entry.match}
                      markets={entry.markets}
                      index={index}
                      minEv={minEv}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {/* ── Fine print ── */}
        {data && data.methodology.notes.length > 0 && (
          <details className={`rounded-2xl p-4 text-xs ${GLASS_DROPDOWN} group`}>
            <summary className="cursor-pointer select-none font-mono text-[10px] uppercase tracking-widest text-slate-400 hover:text-white">
              ⚖️ How this board is built (methodology & caveats)
            </summary>
            <ul className="mt-3 space-y-1.5 text-slate-400">
              {data.methodology.notes.map((note) => (
                <li key={note} className="flex gap-2">
                  <span className="text-emerald-400">·</span>
                  <span>{note}</span>
                </li>
              ))}
              <li className="pt-2 text-slate-500">
                {data.summary.duplicatesRemoved} duplicate market(s) were merged across sources
                (best hit rate kept) and {data.summary.skippedMarkets} skipped for an unusable input;
                {` `}{data.summary.fairOddsOnly} of {data.summary.totalMarketsScanned} scanned markets
                had no bookmaker quote and ride fair odds ({data.methodology.fairOddsFormula}).
              </li>
            </ul>
          </details>
        )}
      </div>
    </main>
  );
}

// ─── Summary card ─────────────────────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "emerald" | "amber" | "rose" | "slate";
}) {
  const skin: Record<"emerald" | "amber" | "rose" | "slate", string> = {
    emerald: "border-emerald-400/30 bg-emerald-500/[0.07] text-emerald-300",
    amber: "border-amber-400/30 bg-amber-500/[0.07] text-amber-300",
    rose: "border-rose-400/30 bg-rose-500/[0.07] text-rose-300",
    slate: "border-white/[0.08] bg-white/[0.03] text-slate-200",
  };
  return (
    <div className={`rounded-2xl border p-4 backdrop-blur-xl transition-all duration-200 hover:scale-[1.02] ${skin[tone]}`}>
      <div className="font-mono text-[9px] uppercase tracking-widest text-slate-400 sm:text-[10px]">
        {label}
      </div>
      <div className="mt-1.5 font-mono text-2xl font-extrabold leading-none tracking-tight sm:text-3xl">
        {value}
      </div>
      <div className="mt-1.5 text-[10px] text-slate-500 sm:text-[11px]">{sub}</div>
    </div>
  );
}

// ─── Match card ───────────────────────────────────────────────────────────────

function MatchCard({
  match,
  markets,
  index,
  minEv,
}: {
  match: ProfitMarket;
  markets: ProfitMarket[];
  index: number;
  minEv: number;
}) {
  const best = Math.max(...markets.map((market) => market.ev));
  const totalKelly = markets.reduce((sum, market) => sum + market.kellyStake, 0);

  return (
    <article
      style={{ animationDelay: `${index * 60}ms` }}
      className="profit-stagger rounded-2xl border border-white/[0.08] bg-gradient-to-br from-emerald-500/[0.08] via-slate-950/50 to-slate-950/70 p-4 shadow-[0_20px_45px_-25px_rgba(16,185,129,0.5)] backdrop-blur-xl transition-all duration-300 hover:border-emerald-400/30 hover:shadow-[0_24px_55px_-22px_rgba(16,185,129,0.6)]"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-400">
          <span className="rounded-full border border-emerald-400/40 bg-emerald-500/15 px-1.5 py-0.5 text-emerald-200">
            T{match.leagueTier}
          </span>
          <span className="max-w-[200px] truncate">{match.league}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-slate-400">{formatDateTime(match.matchDate)}</span>
          <span
            className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ${evTone(best)}`}
            title={`Best EV on this match vs the ${(minEv * 100).toFixed(0)}% floor`}
          >
            {signedPercentage(best)}
          </span>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        <div className="flex min-w-0 items-center justify-end gap-2">
          <span className="truncate text-right text-sm font-bold text-white">{match.homeTeam}</span>
          <Monogram name={match.homeTeam} />
        </div>
        <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 font-mono text-[10px] text-emerald-200">
          VS
        </span>
        <div className="flex min-w-0 items-center justify-start gap-2">
          <Monogram name={match.awayTeam} />
          <span className="truncate text-sm font-bold text-white">{match.awayTeam}</span>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-emerald-200">
          {markets.length} qualifying market{markets.length === 1 ? "" : "s"}
        </span>
        <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-amber-200">
          Σ kelly {percentage(totalKelly)}
        </span>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        {markets.map((market) => (
          <MarketTile key={market.dedupeKey} market={market} minEv={minEv} />
        ))}
      </div>
    </article>
  );
}

function Monogram({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-950/60 text-[10px] font-bold text-slate-100 ring-1 ring-white/10">
      {initials}
    </span>
  );
}

// ─── Market tile ──────────────────────────────────────────────────────────────

function MarketTile({ market, minEv }: { market: ProfitMarket; minEv: number }) {
  const quality = DATA_QUALITY_BADGE[market.dataQuality] ?? DATA_QUALITY_BADGE.synthetic;
  const KellyPct = market.kellyStake * 100;

  return (
    <div
      className="group/tile relative rounded-xl border border-white/[0.08] bg-slate-950/40 p-3 transition-all duration-200 hover:border-emerald-400/40 hover:bg-slate-900/60"
      title={confidenceTooltip(market)}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold tracking-tight text-white" title={market.marketName}>
            {market.marketName}
          </div>
          <div className="mt-0.5 inline-flex items-center gap-1.5">
            <span className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-emerald-200">
              {market.selection}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
              {market.family}
            </span>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-lg px-2 py-1 font-mono text-xs font-extrabold ${evTone(market.ev)}`}
          title={`EV ${(market.ev * 100).toFixed(2)}% vs the ${(minEv * 100).toFixed(0)}% floor`}
        >
          {signedPercentage(market.ev)}
        </span>
      </div>

      {/* Bookmaker vs fair odds, side by side. */}
      <div className="mb-2 grid grid-cols-3 gap-1.5 text-center">
        <OddsCell
          label="Bookmaker"
          value={formatOdds(market.bookmakerOdds)}
          tone={market.oddsSource === "bookmaker" ? "emerald" : "muted"}
          note={market.oddsSource === "bookmaker" ? market.oddsProvider ?? "Book" : "no quote"}
        />
        <OddsCell
          label="Fair"
          value={formatOdds(market.fairOdds)}
          tone="slate"
          note={`${percentage(market.hitRate)} hit`}
        />
        <OddsCell
          label="Edge"
          value={`${(market.ev * 100).toFixed(1)}%`}
          tone={market.ev >= 0.15 ? "emerald" : market.ev >= 0.05 ? "amber" : "rose"}
          note="hit × odds − 1"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-bold text-emerald-200">
          Bet {KellyPct.toFixed(1)}% of bankroll
          <span className="ml-1 font-mono text-[9px] font-normal uppercase tracking-wider text-emerald-300/70">
            kelly {market.kellyStake.toFixed(4)}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${quality.tone}`}
            title={quality.tooltip}
          >
            {quality.label}
          </span>
          <span
            className={`inline-flex items-center rounded-full border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${profitScoreTone(market.profitScore)}`}
            title="Profit Score = mean of EV% and the 0–100 Data Quality confidence score"
          >
            📈 profit {market.profitScore}
          </span>
          <span
            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
              SOURCE_TONE[market.source] ?? "border-white/10 bg-white/5 text-slate-300"
            }`}
            title={
              market.alsoSeenIn.length > 1
                ? `Also seen in: ${market.alsoSeenIn.filter((s) => s !== market.source).join(", ")} (best hit rate kept)`
                : "Only source carrying this market"
            }
          >
            {market.source}
          </span>
        </div>
      </div>
    </div>
  );
}

function OddsCell({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone: "emerald" | "amber" | "rose" | "slate" | "muted";
  note: string;
}) {
  const skin =
    tone === "emerald"
      ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
      : tone === "amber"
        ? "border-amber-400/30 bg-amber-500/10 text-amber-100"
        : tone === "rose"
          ? "border-rose-400/30 bg-rose-500/10 text-rose-200"
          : tone === "slate"
            ? "border-white/[0.08] bg-white/[0.03] text-slate-200"
            : "border-white/[0.06] bg-white/[0.02] text-slate-500";
  return (
    <div className={`rounded-lg border px-1.5 py-1 ${skin}`}>
      <div className="font-mono text-[8px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="font-mono text-sm font-extrabold leading-tight">{value}</div>
      <div className="truncate font-mono text-[8px] uppercase tracking-wider text-slate-500" title={note}>
        {note}
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({
  minEv,
  scanned,
  positiveEv,
  belowThreshold,
  realOdds,
  fairOnly,
  duplicates,
  loading,
  onLower,
}: {
  minEv: number;
  scanned: number;
  positiveEv: number;
  belowThreshold: number;
  realOdds: number;
  fairOnly: number;
  duplicates: number;
  loading: boolean;
  onLower: () => void;
}) {
  const floor = (minEv * 100).toFixed(0);
  const aboveLowestChip = minEv > MIN_EV_OPTIONS[0].value;
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-5 py-12 text-center backdrop-blur-xl sm:px-8">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="text-5xl sm:text-6xl">📉</div>
        <h2 className="text-xl font-extrabold tracking-tight text-white sm:text-2xl">
          No positive EV bets found with the current MIN EV filter.
        </h2>
        <p className="text-sm text-amber-200/90">
          Try lowering the MIN EV threshold to 5% or 3%.
        </p>
        {aboveLowestChip ? (
          <button
            type="button"
            onClick={onLower}
            disabled={loading}
            className={`${CHIP} ${CHIP_PREMIUM_ON_EMERALD} mx-auto inline-flex px-4 py-2 text-xs font-bold disabled:opacity-60`}
          >
            Drop the floor to 5%
          </button>
        ) : (
          <div className="text-[11px] text-slate-500">
            The floor is already on the lowest chip —{" "}
            <Link
              href="/api/profit-maximizer?minEv=0.03"
              target="_blank"
              className="font-mono text-emerald-300 underline decoration-emerald-400/40 underline-offset-2 hover:text-emerald-200"
            >
              /api/profit-maximizer?minEv=0.03
            </Link>{" "}
            widens it further (3%), or Refresh to re-scan the board.
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 pt-2 text-left sm:grid-cols-4">
          <Stat label="Markets scanned" value={String(scanned)} />
          <Stat label="Positive EV" value={String(positiveEv)} />
          <Stat label={`Below ${floor}% floor`} value={String(belowThreshold)} />
          <Stat label="Real bookmaker prices" value={String(realOdds)} />
        </div>
        <p className="pt-1 text-[11px] leading-relaxed text-slate-500">
          {scanned === 0
            ? "Nothing was scanned — the fixture feed and both feature boards are unreachable right now. Retry in a minute."
            : realOdds === 0
              ? `All ${scanned} market(s) were priced on fair odds (${fairOnly} of them; ${duplicates} duplicate(s) merged across sources), and a fair price can never carry a positive edge. The board only lights up when a real bookmaker line exists for the market.`
              : `${realOdds} market(s) carry a real bookmaker price — none beat the ${floor}% edge floor yet. ${belowThreshold} sit positive but below it.`}
        </p>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2">
      <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="font-mono text-lg font-extrabold text-slate-100">{value}</div>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingBoard() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.06] px-4 py-3">
        <span className="relative flex h-3 w-3">
          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
        </span>
        <span className="animate-pulse font-mono text-sm text-emerald-300">
          Scanning every market across Rank A–D, Sure Bet Corners and First 5 Minutes…
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
            <div className="mb-3 h-3 w-1/3 animate-pulse rounded bg-white/[0.06]" />
            <div className="mb-3 h-6 w-2/3 animate-pulse rounded bg-white/[0.06]" />
            <div className="grid gap-2 md:grid-cols-2">
              <div className="h-28 animate-pulse rounded-xl bg-white/[0.04]" />
              <div className="h-28 animate-pulse rounded-xl bg-white/[0.04]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
