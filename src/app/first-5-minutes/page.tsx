"use client";

// ĞIGI GIVØ — First 5 Minutes Markets.
//
// Cyan/teal opening-phase board. Dual-outcome tiles show Yes and No side by
// side with hit rate, fair odds, 1xBet odds and confidence. Data comes from
// /api/first-5-minutes (1-hour cache, force-refresh via the Refresh button).

import Link from "next/link";
import { LEAGUE_MAP } from "@/lib/leagues";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "./components/EmptyState";
import { MARKET_LABEL, MARKET_ORDER, formatDateTime } from "./components/format";
import { MatchCard } from "./components/MatchCard";
import type { First5MarketKey, First5MinutesData } from "./components/types";

const LEAGUE_ORDER = [
  "eng.1", "esp.1", "ita.1", "ger.1", "fra.1",
  "uefa.champions", "uefa.europa", "uefa.europa.conf",
  "eng.fa", "eng.league_cup", "esp.copa_del_rey",
  "ita.coppa_italia", "ger.dfb_pokal", "fra.coupe_de_france",
];

const LEAGUE_PRIORITY = new Map(LEAGUE_ORDER.map((slug, index) => [slug, index]));

type RecentResultOutcome = "WIN" | "LOSS" | "PUSH" | "VOID";

type RecentResultMarket = {
  market: string;
  selection: string;
  hitRate: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  outcome: RecentResultOutcome;
};

type RecentResultMatch = {
  eventId: string;
  matchLabel: string;
  league: string;
  leagueSlug: string;
  matchDate: string;
  homeScore: number | null;
  awayScore: number | null;
  markets: RecentResultMarket[];
};

export default function First5MinutesPage() {
  const [data, setData] = useState<First5MinutesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marketFilter, setMarketFilter] = useState<First5MarketKey | "all">("all");
  const [recentResults, setRecentResults] = useState<RecentResultMatch[]>([]);
  const [recentResultsLoading, setRecentResultsLoading] = useState(true);
  const [recentResultsError, setRecentResultsError] = useState<string | null>(null);
  const [showAllRecentResults, setShowAllRecentResults] = useState(false);

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

  const loadRecentResults = useCallback(async () => {
    setRecentResultsLoading(true);
    setRecentResultsError(null);
    try {
      const response = await fetch("/api/first-5-minutes/results", { cache: "no-store" });
      const payload = (await response.json()) as {
        ok?: boolean;
        matches?: RecentResultMatch[];
      };
      if (!response.ok || payload.ok === false) {
        throw new Error(`HTTP ${response.status}`);
      }
      const matches = Array.isArray(payload.matches) ? payload.matches : [];
      setRecentResults(
        [...matches].sort((a, b) => b.matchDate.localeCompare(a.matchDate)),
      );
    } catch (reason) {
      setRecentResults([]);
      setRecentResultsError(
        reason instanceof Error
          ? reason.message
          : "Unable to load settled First 5 Minutes results.",
      );
    } finally {
      setRecentResultsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialFetchDone.current) return;
    initialFetchDone.current = true;
    void load(false);
    void loadRecentResults();
  }, [load, loadRecentResults]);

  const groupedMatches = useMemo(() => {
    if (!data?.matches?.length) return [];
    const groups = new Map<string, First5MinutesData["matches"]>();
    for (const match of data.matches) {
      const bucket = groups.get(match.leagueSlug) ?? [];
      bucket.push(match);
      groups.set(match.leagueSlug, bucket);
    }
    return Array.from(groups.entries())
      .map(([leagueSlug, matches]) => ({
        leagueSlug,
        // Keep the requested spacing for La Liga; all other names use the catalogue.
        leagueName: leagueSlug === "esp.1"
          ? "La Liga"
          : LEAGUE_MAP[leagueSlug]?.name ?? matches[0].league,
        matches: matches.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()),
      }))
      .sort((a, b) =>
        (LEAGUE_PRIORITY.get(a.leagueSlug) ?? LEAGUE_ORDER.length) -
          (LEAGUE_PRIORITY.get(b.leagueSlug) ?? LEAGUE_ORDER.length) ||
        a.leagueName.localeCompare(b.leagueName) ||
        a.leagueSlug.localeCompare(b.leagueSlug),
      );
  }, [data]);

  const highConfidenceCount = useMemo(() => {
    if (!data?.matches?.length) return 0;
    return data.matches.reduce(
      (sum, match) =>
        sum + match.markets.filter((market) => market.confidence === "HIGH").length,
      0,
    );
  }, [data]);

  const guaranteedCount = useMemo(() => {
    if (!data?.matches?.length) return 0;
    return data.matches.reduce(
      (sum, match) => sum + match.markets.filter((market) => market.isGuaranteed).length,
      0,
    );
  }, [data]);

  const publishedMarkets = useMemo(
    () => data?.matches.reduce((sum, match) => sum + match.markets.length, 0) ?? 0,
    [data],
  );

  const skippedFixtures = useMemo(
    () => (data ? Math.max(0, data.totalFixturesChecked - data.totalMatches) : 0),
    [data],
  );

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0F1117] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(6,182,212,0.16)_0%,_rgba(15,17,23,0.2)_42%,_#0F1117_72%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 right-0 h-80 w-80 rounded-full bg-violet-600/10 blur-3xl"
      />

      <style>{`
        @keyframes first5-title-glow {
          0%, 100% { text-shadow: 0 0 12px rgba(6,182,212,0.35), 0 0 2px rgba(139,92,246,0.2); }
          50% { text-shadow: 0 0 28px rgba(6,182,212,0.95), 0 0 12px rgba(139,92,246,0.55); }
        }
        @keyframes first5-stagger-in {
          from { opacity: 0; transform: translateY(14px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .first5-title-glow { animation: first5-title-glow 1.8s ease-in-out infinite; }
        .first5-stagger { animation: first5-stagger-in 0.55s ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .first5-title-glow, .first5-stagger { animation: none; }
        }
      `}</style>

      <div className="relative mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-cyan-200">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75 motion-safe:animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
              </span>
              Opening 5 minutes · 7-day window
            </div>
            <h1 className="first5-title-glow text-3xl font-extrabold tracking-tight text-cyan-50 sm:text-4xl">
              ⏱️ First 5 Minutes
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400 sm:text-base">
              Fast-start markets — what will happen in the opening 5 minutes?
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="inline-flex items-center rounded-full border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-slate-700 hover:text-white"
            >
              ← Oracle
            </Link>
            <Link
              href="/performance/first5"
              title="First 5 Minutes track record — historical picks, hit rate, P&L and ROI"
              aria-label="Open the First 5 Minutes performance tracker"
              className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-cyan-400 to-teal-400 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-cyan-500/30 transition-all duration-300 hover:scale-105 hover:shadow-cyan-400/50 active:scale-95"
            >
              📊 Track Records
            </Link>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading || refreshing}
              className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-cyan-400 to-teal-400 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-cyan-500/30 transition-all duration-300 hover:scale-105 hover:shadow-cyan-400/50 active:scale-95 disabled:opacity-60"
              aria-label="Refresh first 5 minutes markets"
            >
              {refreshing ? (
                <>
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  Refreshing…
                </>
              ) : (
                <>🔄 Refresh</>
              )}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 rounded-2xl border border-cyan-500/15 bg-cyan-500/5 p-4 text-xs sm:grid-cols-3">
          <div>
            <div className="font-mono uppercase tracking-wider text-cyan-300">
              Poisson opening-phase model
            </div>
            <p className="mt-1 text-slate-400">
              λ(0–5&apos;) = λ(match) × 5/{data?.model.matchMinutes ?? 96} × opening
              intensity × tempo. P(Yes) = 1 − e<sup>−λ</sup>.
            </p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-violet-300">
              Real data only
            </div>
            <p className="mt-1 text-slate-400">
              Goals come from Bzzoiro rolling xG or ESPN form averages; corners
              and cards come from mesh team distributions. A market with no real
              baseline is omitted — never synthesised.
            </p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-teal-300">
              Cached for {(data?.cache.ttlMinutes ?? 60) / 60} hour
            </div>
            <p className="mt-1 text-slate-400">
              Results are cached for one hour. Refresh forces a fresh
              calculation across every upcoming fixture.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
            Markets
          </span>
          <FilterChip
            active={marketFilter === "all"}
            onClick={() => setMarketFilter("all")}
            label="All 3 markets"
          />
          {/* No penalty market exists — the API publishes goal/corner/card only. */}
          {MARKET_ORDER.filter((key) => key !== "penalty").map((key) => (
            <FilterChip
              key={key}
              active={marketFilter === key}
              onClick={() => setMarketFilter(key)}
              label={MARKET_LABEL[key]}
            />
          ))}
        </div>

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

        {loading && !data ? (
          <LoadingSkeleton />
        ) : data && data.matches.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>
                {data.matches.length} upcoming match
                {data.matches.length === 1 ? "" : "es"} ·{" "}
                {publishedMarkets} markets published · {skippedFixtures} fixtures
                skipped (no data) · {highConfidenceCount} HIGH confidence ·{" "}
                {guaranteedCount} likely guaranteed
              </span>
              <span className="font-mono">
                Updated {formatDateTime(data.generatedAt)}
                {data.cache.hit ? " · cached" : ""}
              </span>
            </div>

            {refreshing && (
              <div className="flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs text-cyan-200">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-300" />
                Recalculating every market from fresh pre-match statistics…
              </div>
            )}

            <div className="space-y-8">
              {groupedMatches.map((group) => (
                <div key={group.leagueSlug} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="h-px flex-1 bg-cyan-400/15" />
                    <h2 className="rounded-full border border-violet-400/20 bg-violet-500/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-violet-200">
                      {group.leagueName}
                    </h2>
                    <div className="h-px flex-1 bg-cyan-400/15" />
                  </div>

                  <div className="grid gap-4 xl:grid-cols-2">
                    {group.matches.map((match, index) => (
                      <MatchCard
                        key={match.fixtureId}
                        match={match}
                        index={index}
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

        <RecentResultsSection
          matches={recentResults}
          loading={recentResultsLoading}
          error={recentResultsError}
          showAll={showAllRecentResults}
          onToggle={() => setShowAllRecentResults((visible) => !visible)}
        />

        <p className="border-t border-cyan-400/10 pt-4 text-center text-[11px] leading-relaxed text-slate-500">
          Opening-phase markets are inherently volatile. Odds shown are model
          prices (fair odds plus a 1xBet-style tick round), not a bookmaker quote,
          and no model can guarantee a sports result.
        </p>
      </div>
    </main>
  );
}

function RecentResultsSection({
  matches,
  loading,
  error,
  showAll,
  onToggle,
}: {
  matches: RecentResultMatch[];
  loading: boolean;
  error: string | null;
  showAll: boolean;
  onToggle: () => void;
}) {
  const markets = matches.flatMap((match) => match.markets);
  const won = markets.filter((market) => market.outcome === "WIN").length;
  const lost = markets.filter((market) => market.outcome === "LOSS").length;
  const decided = won + lost;
  const realisedRate = decided > 0 ? (won / decided) * 100 : 0;
  const sortedMatches = [...matches].sort((a, b) => b.matchDate.localeCompare(a.matchDate));
  const visibleMatches = showAll ? sortedMatches : sortedMatches.slice(0, 10);

  return (
    <section
      id="recent-results"
      aria-labelledby="recent-results-heading"
      className="space-y-4 rounded-2xl border border-cyan-500/15 bg-cyan-500/5 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="recent-results-heading"
            className="font-mono text-xs font-bold uppercase tracking-[0.18em] text-cyan-200"
          >
            📊 RECENT RESULTS — LAST 14 DAYS
          </h2>
          {!loading && matches.length > 0 && (
            <p className="mt-2 text-xs text-slate-400">
              {matches.length} finished match{matches.length === 1 ? "" : "es"} · {won} won · {lost} lost · {formatRecentPercent(realisedRate)} hit rate
            </p>
          )}
        </div>
        {!loading && matches.length > 10 && (
          <button
            type="button"
            onClick={onToggle}
            className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3 py-1.5 text-[11px] font-semibold text-cyan-200 transition hover:bg-cyan-400/20"
          >
            {showAll ? "Show fewer" : `Show all ${matches.length}`}
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-500" aria-busy="true">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-400" />
          Loading settled predictions…
        </div>
      ) : matches.length === 0 ? (
        <p className="rounded-xl border border-slate-700/50 bg-slate-900/30 px-3 py-4 text-sm text-slate-500">
          {error
            ? "Settled results are temporarily unavailable."
            : "No settled predictions in the last 14 days yet."}
        </p>
      ) : (
        <div className="divide-y divide-cyan-400/10 rounded-xl border border-cyan-400/10 bg-black/10">
          {visibleMatches.map((match) => {
            const score = match.homeScore === null || match.awayScore === null
              ? "—"
              : `${match.homeScore}-${match.awayScore}`;
            const leagueName = LEAGUE_MAP[match.leagueSlug]?.name ?? match.league;
            return (
              <article key={match.eventId} className="p-4 first:rounded-t-xl last:rounded-b-xl">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-100">
                      {match.matchLabel}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {leagueName} · {match.matchDate}
                    </div>
                  </div>
                  <div className="shrink-0 font-mono text-sm font-bold text-cyan-100">
                    {score}
                  </div>
                </div>

                <div className="mt-3 space-y-2 border-l border-cyan-400/20 pl-3">
                  {match.markets.map((market, marketIndex) => (
                    <div key={`${market.market}-${market.selection}-${marketIndex}`} className="text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-slate-300">
                          {market.market} · {market.selection}
                        </span>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide ${recentOutcomeClasses(market.outcome)}`}>
                          {market.outcome}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-slate-500">
                        <span>Model: {formatRecentPercent(market.hitRate)} ({market.confidence})</span>
                        <span>
                          Result: <span className={recentOutcomeTextClass(market.outcome)}>{market.outcome}</span>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function formatRecentPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  const percentage = value <= 1 ? value * 100 : value;
  const rounded = Math.round(percentage * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function recentOutcomeClasses(outcome: RecentResultOutcome): string {
  if (outcome === "WIN") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-300";
  if (outcome === "LOSS") return "border-rose-400/30 bg-rose-400/10 text-rose-300";
  if (outcome === "PUSH") return "border-amber-300/30 bg-amber-300/10 text-amber-200";
  return "border-slate-600 bg-slate-700/40 text-slate-400";
}

function recentOutcomeTextClass(outcome: RecentResultOutcome): string {
  if (outcome === "WIN") return "font-semibold text-emerald-300";
  if (outcome === "LOSS") return "font-semibold text-rose-300";
  if (outcome === "PUSH") return "font-semibold text-amber-200";
  return "font-semibold text-slate-400";
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all duration-200 ${
        active
          ? "bg-gradient-to-r from-cyan-400 to-teal-400 text-white shadow-lg shadow-cyan-500/30"
          : "bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white"
      }`}
    >
      {label}
    </button>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-400" />
        <span className="font-mono text-cyan-200">
          Pricing opening-phase markets from real pre-match statistics…
        </span>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {[1, 2, 3, 4].map((card) => (
          <div
            key={card}
            className="rounded-2xl border border-cyan-500/15 bg-cyan-500/5 p-4"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="h-4 w-28 animate-pulse rounded-full bg-cyan-400/10" />
              <div className="h-4 w-20 animate-pulse rounded-full bg-cyan-400/10" />
            </div>
            <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <div className="flex items-center justify-end gap-1.5">
                <div className="h-4 w-20 animate-pulse rounded bg-white/[0.06]" />
                <div className="h-6 w-6 animate-pulse rounded-full bg-cyan-400/15" />
              </div>
              <div className="h-3 w-5 animate-pulse rounded bg-white/[0.04]" />
              <div className="flex items-center gap-1.5">
                <div className="h-6 w-6 animate-pulse rounded-full bg-cyan-400/15" />
                <div className="h-4 w-20 animate-pulse rounded bg-white/[0.06]" />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {[1, 2, 3, 4].map((tile) => (
                <div
                  key={tile}
                  className="space-y-2 rounded-xl border border-cyan-500/15 bg-black/20 p-3"
                >
                  <div className="h-3 w-16 animate-pulse rounded-full bg-cyan-400/10" />
                  <div className="grid grid-cols-2 gap-2">
                    <div className="h-16 animate-pulse rounded-lg bg-emerald-500/10" />
                    <div className="h-16 animate-pulse rounded-lg bg-rose-500/10" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
