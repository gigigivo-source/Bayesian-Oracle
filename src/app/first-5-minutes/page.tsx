"use client";

// ĞIGI GIVØ — First 5 Minutes Markets.
//
// Shows every upcoming fixture (next 7 days) with four opening-phase markets —
// Goal, Corner, Card and Penalty inside minutes 0–5 — each with its predicted
// outcome, hit rate, decimal odds and confidence. Data comes from
// /api/first-5-minutes (1-hour cache, force-refresh via the Refresh button).

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TeamBadge } from "../_components/ui";
import {
  CARD_ACCENT_ORDER,
  CARD_GLASS,
  CARD_GLASS_SKIN,
  CARD_SURFACE,
  CHIP,
  CHIP_OFF,
  CHIP_ON_AMBER,
  GLASS_PANEL,
  GLASS_TEXT_SHADOW,
  NAV_PILL,
  NAV_PILL_OFF,
  OUTLINE_NEUTRAL,
} from "../_components/design";

// ─── Types (mirror the API contract) ──────────────────────────────────────────

type First5MarketKey = "goal" | "corner" | "card" | "penalty";
type Confidence = "HIGH" | "MEDIUM" | "LOW";
type BaselineOrigin = "real" | "partial" | "league";

interface First5Market {
  id: string;
  key: First5MarketKey;
  label: string;
  shortLabel: string;
  icon: string;
  outcome: "Yes" | "No";
  probability: number;
  hitRate: number;
  fairOdds: number;
  odds: { yes: number; no: number; selected: number };
  confidence: Confidence;
  expectedInWindow: number;
  expectedPerMatch: number;
  origin: BaselineOrigin;
  source: string;
  reason: string;
}

interface First5Match {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  homeLogo: string | null;
  awayLogo: string | null;
  league: string;
  leagueSlug: string;
  leagueTier: number;
  date: string;
  venue: string | null;
  statsSource: string;
  dataOrigin: BaselineOrigin;
  realMarketCount: number;
  markets: First5Market[];
}

interface First5MinutesData {
  generatedAt: string;
  windowMinutes: number;
  lookaheadDays: number;
  totalFixturesChecked: number;
  totalMatches: number;
  marketTypes: Array<{ key: First5MarketKey; label: string; icon: string }>;
  model: {
    description: string;
    matchMinutes: number;
    openingIntensity: Record<First5MarketKey, number>;
    bookmakerMargin: number;
  };
  cache: { ttlMinutes: number; hit: boolean };
  matches: First5Match[];
  error?: string;
}

// ─── Presentation helpers ─────────────────────────────────────────────────────

const MARKET_ORDER: First5MarketKey[] = ["goal", "corner", "card", "penalty"];

const MARKET_LABEL: Record<First5MarketKey, string> = {
  goal: "⚽ Goal",
  corner: "🚩 Corner",
  card: "🟨 Card",
  penalty: "🎯 Penalty",
};

const MARKET_TONE: Record<First5MarketKey, string> = {
  goal: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  corner: "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
  card: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  penalty: "border-rose-400/30 bg-rose-400/10 text-rose-200",
};

const CONFIDENCE_TONE: Record<Confidence, string> = {
  HIGH: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  MEDIUM: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  LOW: "border-slate-400/25 bg-slate-400/10 text-slate-300",
};

const ORIGIN_LABEL: Record<BaselineOrigin, string> = {
  real: "Real stats",
  partial: "Partial stats",
  league: "League baseline",
};

const ORIGIN_TONE: Record<BaselineOrigin, string> = {
  real: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
  partial: "border-cyan-400/25 bg-cyan-400/10 text-cyan-200",
  league: "border-slate-400/20 bg-slate-400/10 text-slate-300",
};

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function odds(value: number): string {
  return value.toFixed(2);
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function First5MinutesPage() {
  const [data, setData] = useState<First5MinutesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marketFilter, setMarketFilter] = useState<First5MarketKey | "all">("all");

  // Mirrors the latest payload without making `load` depend on state, so the
  // mount effect cannot re-arm itself into an endless refresh loop.
  const dataRef = useRef<First5MinutesData | null>(null);
  const initialFetchDone = useRef(false);

  const load = useCallback(async (forceRefresh = false) => {
    if (forceRefresh || dataRef.current) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const url = forceRefresh
        ? "/api/first-5-minutes?refresh=true"
        : "/api/first-5-minutes";
      const response = await fetch(url, { cache: "no-store" });
      const payload = (await response.json()) as First5MinutesData;
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      dataRef.current = payload;
      setData(payload);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to load First 5 Minutes Markets.",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (initialFetchDone.current) return;
    initialFetchDone.current = true;
    void load(false);
  }, [load]);

  const groupedMatches = useMemo(() => {
    if (!data?.matches?.length) return [];
    const groups = new Map<string, First5Match[]>();
    for (const match of data.matches) {
      const dateKey = new Date(match.date).toISOString().slice(0, 10);
      const bucket = groups.get(dateKey) ?? [];
      bucket.push(match);
      groups.set(dateKey, bucket);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dateKey, matches]) => ({ dateKey, matches }));
  }, [data]);

  const highConfidenceCount = useMemo(() => {
    if (!data?.matches?.length) return 0;
    return data.matches.reduce(
      (sum, match) =>
        sum + match.markets.filter((market) => market.confidence === "HIGH").length,
      0,
    );
  }, [data]);

  const realDataCount = useMemo(
    () => data?.matches.filter((match) => match.dataOrigin !== "league").length ?? 0,
    [data],
  );

  return (
    <main className="min-h-screen bg-[#05070d] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* ── Header ── */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div
              className={`${CHIP} ${CHIP_ON_AMBER} mb-3 inline-flex px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider`}
            >
              ⏱️ Opening 5 minutes · 7-day window
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              First 5 Minutes Markets
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400 sm:text-base">
              Will a goal, corner, card or penalty arrive inside the opening five
              minutes? Every market is priced from real pre-match statistics
              supplied by the multi-source stats aggregator, with observed league
              averages as the explicit fallback.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className={`${NAV_PILL} ${NAV_PILL_OFF} px-3 py-2 text-xs font-semibold`}
            >
              ← Oracle
            </Link>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading || refreshing}
              className={`${OUTLINE_NEUTRAL} inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-xs font-semibold transition hover:bg-white/10 disabled:opacity-60`}
              aria-label="Refresh first 5 minutes markets"
            >
              {refreshing ? (
                <>
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-400 border-t-white" />
                  Refreshing…
                </>
              ) : (
                <>🔄 Refresh</>
              )}
            </button>
          </div>
        </div>

        {/* ── Model summary ── */}
        <div className={`${GLASS_PANEL} grid grid-cols-1 gap-3 rounded-2xl p-4 text-xs sm:grid-cols-3`}>
          <div>
            <div className="font-mono uppercase tracking-wider text-amber-300">
              Poisson opening-phase model
            </div>
            <p className="mt-1 text-slate-400">
              λ(0–5&apos;) = λ(match) × 5/{data?.model.matchMinutes ?? 96} × opening
              intensity × tempo. Hit rate = 1 − e<sup>−λ</sup>.
            </p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-cyan-300">
              Real stats first
            </div>
            <p className="mt-1 text-slate-400">
              xG, season corner and card averages come from the stats aggregator;
              a missing baseline falls back to the league average and is labelled
              as such.
            </p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-emerald-300">
              Cached for {(data?.cache.ttlMinutes ?? 60) / 60} hour
            </div>
            <p className="mt-1 text-slate-400">
              Results are cached for one hour. Refresh forces a fresh
              calculation across every upcoming fixture.
            </p>
          </div>
        </div>

        {/* ── Market filter ── */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
            Markets
          </span>
          <button
            type="button"
            onClick={() => setMarketFilter("all")}
            aria-pressed={marketFilter === "all"}
            className={`${CHIP} ${marketFilter === "all" ? CHIP_ON_AMBER : CHIP_OFF} px-3 py-1.5 text-[11px] font-semibold`}
          >
            All 4 markets
          </button>
          {MARKET_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setMarketFilter(key)}
              aria-pressed={marketFilter === key}
              className={`${CHIP} ${marketFilter === key ? CHIP_ON_AMBER : CHIP_OFF} px-3 py-1.5 text-[11px] font-semibold`}
            >
              {MARKET_LABEL[key]}
            </button>
          ))}
        </div>

        {/* ── Error state ── */}
        {error && (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5 text-sm text-rose-200">
            <div className="font-bold">
              First 5 Minutes Markets are temporarily unavailable
            </div>
            <p className="mt-1 text-rose-200/70">{error}</p>
            <button
              type="button"
              onClick={() => void load(false)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-rose-400/30 bg-rose-400/10 px-4 py-2 text-xs font-semibold text-rose-200 transition hover:bg-rose-400/20"
            >
              🔄 Retry
            </button>
          </div>
        )}

        {/* ── Main content ── */}
        {loading && !data ? (
          <LoadingSkeleton />
        ) : data && data.matches.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>
                {data.matches.length} upcoming match
                {data.matches.length === 1 ? "" : "es"} ·{" "}
                {data.matches.length * 4} markets · {highConfidenceCount} HIGH
                confidence · {realDataCount} on real aggregator data
              </span>
              <span className="font-mono">
                Updated {formatDateTime(data.generatedAt)}
                {data.cache.hit ? " · cached" : ""}
              </span>
            </div>

            {refreshing && (
              <div className="flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-amber-400/30 border-t-amber-300" />
                Recalculating every market from fresh pre-match statistics…
              </div>
            )}

            <div className="space-y-8">
              {groupedMatches.map((group) => (
                <div key={group.dateKey} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="h-px flex-1 bg-white/[0.06]" />
                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-slate-300">
                      {formatDateGroup(group.matches[0].date)}
                    </span>
                    <div className="h-px flex-1 bg-white/[0.06]" />
                  </div>

                  <div className="grid gap-4 xl:grid-cols-2">
                    {group.matches.map((match, index) => (
                      <MatchCard
                        key={match.fixtureId}
                        match={match}
                        accentIndex={index}
                        marketFilter={marketFilter}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : !error ? (
          <EmptyState onRetry={() => void load(true)} />
        ) : null}

        <p className="border-t border-white/[0.06] pt-4 text-center text-[11px] leading-relaxed text-slate-500">
          Opening-phase markets are inherently volatile. Odds shown are model
          prices (fair odds plus a standard book margin), not a bookmaker quote,
          and no model can guarantee a sports result.
        </p>
      </div>
    </main>
  );
}

// ─── Match card ───────────────────────────────────────────────────────────────

function MatchCard({
  match,
  accentIndex,
  marketFilter,
}: {
  match: First5Match;
  accentIndex: number;
  marketFilter: First5MarketKey | "all";
}) {
  const accent = CARD_ACCENT_ORDER[accentIndex % CARD_ACCENT_ORDER.length];
  const markets =
    marketFilter === "all"
      ? match.markets
      : match.markets.filter((market) => market.key === marketFilter);

  return (
    <article
      className={[
        CARD_GLASS,
        CARD_GLASS_SKIN[accent],
        GLASS_TEXT_SHADOW,
        "cursor-default p-4 hover:translate-y-0",
      ].join(" ")}
    >
      {/* League + kickoff */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-400">
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-amber-200">
            T{match.leagueTier}
          </span>
          <span className="max-w-[180px] truncate">{match.league}</span>
        </div>
        <span className="font-mono text-[10px] text-slate-400">
          {formatDateTime(match.date)}
        </span>
      </div>

      {/* Teams */}
      <div className="mb-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        <div className="flex min-w-0 items-center justify-end gap-1.5">
          <span className="truncate text-right text-sm font-bold text-white">
            {match.homeTeam}
          </span>
          <TeamBadge logo={match.homeLogo} name={match.homeTeam} size={24} />
        </div>
        <span className="font-mono text-[10px] text-slate-500">VS</span>
        <div className="flex min-w-0 items-center justify-start gap-1.5">
          <TeamBadge logo={match.awayLogo} name={match.awayTeam} size={24} />
          <span className="truncate text-sm font-bold text-white">
            {match.awayTeam}
          </span>
        </div>
      </div>

      {/* Data provenance */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span
          className={`rounded-full border px-2 py-0.5 font-mono uppercase tracking-wider ${ORIGIN_TONE[match.dataOrigin]}`}
        >
          {ORIGIN_LABEL[match.dataOrigin]}
        </span>
        <span className="truncate font-mono text-slate-500">
          {match.statsSource}
        </span>
      </div>

      {/* Markets */}
      <div className="grid gap-2 sm:grid-cols-2">
        {markets.map((market) => (
          <MarketTile key={market.id} market={market} />
        ))}
      </div>
    </article>
  );
}

// ─── Market tile ──────────────────────────────────────────────────────────────

function MarketTile({ market }: { market: First5Market }) {
  const yes = market.outcome === "Yes";
  return (
    <div
      className="rounded-xl border border-white/[0.08] bg-black/25 p-3"
      title={market.reason}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={`inline-flex rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${MARKET_TONE[market.key]}`}
        >
          {market.icon} {market.shortLabel}
        </span>
        <span
          className={`inline-flex rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${CONFIDENCE_TONE[market.confidence]}`}
        >
          {market.confidence}
        </span>
      </div>

      <div className="mt-2 flex items-end justify-between gap-2">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-slate-500">
            Outcome
          </div>
          <div
            className={`text-xl font-extrabold leading-none ${yes ? "text-emerald-300" : "text-rose-300"}`}
          >
            {market.outcome}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[9px] uppercase tracking-wider text-slate-500">
            Hit rate
          </div>
          <div className="font-mono text-lg font-extrabold leading-none text-amber-200">
            {percentage(market.hitRate)}
          </div>
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-1.5 text-center">
        <div className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-2 py-1.5">
          <div className="font-mono text-[9px] uppercase tracking-wider text-slate-500">
            Odds
          </div>
          <div className="font-mono text-sm font-bold text-white">
            {odds(market.odds.selected)}
          </div>
        </div>
        <div className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-2 py-1.5">
          <div className="font-mono text-[9px] uppercase tracking-wider text-slate-500">
            Fair odds
          </div>
          <div className="font-mono text-sm font-bold text-slate-200">
            {odds(market.fairOdds)}
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between font-mono text-[9px] text-slate-500">
        <span>
          Yes {odds(market.odds.yes)} · No {odds(market.odds.no)}
        </span>
        <span className={market.origin === "league" ? "text-slate-500" : "text-emerald-400/70"}>
          {ORIGIN_LABEL[market.origin]}
        </span>
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={`${GLASS_PANEL} rounded-2xl p-10 text-center sm:p-14`}>
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-400/20 bg-amber-400/10 text-2xl">
        ⏱️
      </div>
      <h2 className="text-xl font-bold text-slate-200">
        No upcoming fixtures in the next 7 days
      </h2>
      <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-400">
        The fixture feed returned no scheduled matches for the tracked
        competitions. Try a fresh calculation — the feed is re-queried on every
        refresh.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.10]"
      >
        🔄 Refresh
      </button>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-700 border-t-amber-400" />
        <span className="font-mono text-amber-200">
          Pricing opening-phase markets from real pre-match statistics…
        </span>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {[1, 2, 3, 4].map((card) => (
          <div key={card} className={`${CARD_SURFACE} p-4`}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="h-4 w-28 animate-pulse rounded-full bg-white/[0.06]" />
              <div className="h-4 w-20 animate-pulse rounded-full bg-white/[0.06]" />
            </div>
            <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <div className="flex items-center justify-end gap-1.5">
                <div className="h-4 w-20 animate-pulse rounded bg-white/[0.06]" />
                <div className="h-6 w-6 animate-pulse rounded-full bg-white/[0.08]" />
              </div>
              <div className="h-3 w-5 animate-pulse rounded bg-white/[0.04]" />
              <div className="flex items-center gap-1.5">
                <div className="h-6 w-6 animate-pulse rounded-full bg-white/[0.08]" />
                <div className="h-4 w-20 animate-pulse rounded bg-white/[0.06]" />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {[1, 2, 3, 4].map((tile) => (
                <div
                  key={tile}
                  className="space-y-2 rounded-xl border border-white/[0.07] bg-black/20 p-3"
                >
                  <div className="h-3 w-16 animate-pulse rounded-full bg-white/[0.06]" />
                  <div className="h-5 w-14 animate-pulse rounded bg-white/[0.06]" />
                  <div className="h-6 w-full animate-pulse rounded bg-white/[0.04]" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
