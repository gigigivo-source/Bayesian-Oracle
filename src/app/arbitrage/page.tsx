"use client";

// ĞIGI GIVØ — Multi-Match Arbitrage.
//
// Guaranteed profit across 2–3 different matches: one 1X2 selection per
// match, dutched so every outcome returns more than the total staked.
// Data comes from /api/arbitrage (1-hour cache, force-refresh via the
// Refresh pill, MIN PROFIT floor via the pill dropdown).
//
// Emerald = profit, slate = structure, amber = caution. The only accent
// language on the board, so a green number always means the same thing.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { GLASS_DROPDOWN, GLASS_PANEL } from "../_components/design";

export const dynamic = "force-dynamic";

// ─── Payload types (mirror src/app/api/arbitrage/route.ts) ───────────────────

type DataQuality = "Real" | "Mixed" | "Synthetic";

interface ArbitrageLeg {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  leagueSlug: string;
  leagueName: string;
  matchDate: string;
  selectedOutcome: string;
  odds: number;
  stake: number;
  stakePercent: number;
  oddsSource: "bookmaker" | "model";
  providers: string[];
  confidenceScore: number;
  legQuality: "real" | "mixed" | "synthetic";
}

interface ArbitrageOpportunity {
  id: string;
  legs: number;
  matches: ArbitrageLeg[];
  totalStake: number;
  guaranteedReturn: number;
  profitMargin: number;
  profitMarginPct: number;
  confidenceScore: number;
  dataQuality: DataQuality;
}

interface ArbitrageResponse {
  generatedAt: string;
  totalCombinationsScanned: number;
  qualifyingArbitrages: ArbitrageOpportunity[];
  filters: {
    minProfit: number;
    maxCombinations: number;
    totalStake: number;
    minOdds: number;
    lookaheadDays: number;
  };
  matchesScanned: number;
  matchesFetched: number;
  partial: boolean;
  cache: { ttlMinutes: number; hit: boolean };
  error?: string;
}

const MIN_PROFIT_OPTIONS = [
  { label: "1%", value: 0.01 },
  { label: "2%", value: 0.02 },
  { label: "3%", value: 0.03 },
  { label: "5%", value: 0.05 },
] as const;

const pound = (value: number) =>
  value.toLocaleString("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ArbitragePage() {
  const [data, setData] = useState<ArbitrageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minProfit, setMinProfit] = useState(0.01);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const dataRef = useRef<ArbitrageResponse | null>(null);
  const thresholdRef = useRef<number>(0.01);
  const initialFetchDone = useRef(false);

  const load = useCallback(async (opts?: { refresh?: boolean; minProfit?: number }) => {
    const threshold = opts?.minProfit ?? thresholdRef.current;
    if (opts?.minProfit !== undefined) thresholdRef.current = opts.minProfit;
    const force = opts?.refresh === true;
    if (force || dataRef.current) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ minProfit: String(threshold) });
      if (force) params.set("refresh", "true");
      const response = await fetch(`/api/arbitrage?${params}`, { cache: "no-store" });
      const payload = (await response.json()) as ArbitrageResponse;
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      dataRef.current = payload;
      setData(payload);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to load arbitrage opportunities.",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (initialFetchDone.current) return;
    initialFetchDone.current = true;
    void load();
  }, [load]);

  const arbs = data?.qualifyingArbitrages ?? [];
  const avgMargin = arbs.length
    ? arbs.reduce((sum, a) => sum + a.profitMarginPct, 0) / arbs.length
    : null;
  const bestMargin = arbs.length ? Math.max(...arbs.map((a) => a.profitMarginPct)) : null;

  const selectMinProfit = (value: number) => {
    setMinProfit(value);
    setDropdownOpen(false);
    void load({ minProfit: value });
  };

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0F1117] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      {/* Emerald ambient glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(16,185,129,0.13)_0%,_rgba(15,17,23,0.25)_42%,_#0F1117_72%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 right-0 h-80 w-80 rounded-full bg-emerald-600/10 blur-3xl"
      />

      <div className="relative mx-auto max-w-6xl space-y-6">
        {/* ── Header ── */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-emerald-200">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              2–3 matches · 7-day window
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-emerald-50 sm:text-4xl">
              Multi-Match Arbitrage
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400 sm:text-base">
              Guaranteed profit across 2–3 matches
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/"
              className="inline-flex items-center rounded-full border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-slate-700 hover:text-white"
            >
              ← Oracle
            </Link>

            {/* MIN PROFIT filter chip — pill dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setDropdownOpen((open) => !open)}
                aria-expanded={dropdownOpen}
                aria-haspopup="listbox"
                aria-label="Minimum profit filter"
                className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-white/[0.08] bg-white/[0.06] px-4 py-2 text-xs font-semibold text-slate-200 transition-all duration-200 hover:scale-[1.03] hover:bg-white/[0.1] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
              >
                <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                  Min profit
                </span>
                <span className="font-bold text-emerald-300">
                  {(minProfit * 100).toFixed(0)}%
                </span>
                <svg
                  className={`h-3.5 w-3.5 text-slate-400 transition-transform duration-200 ${dropdownOpen ? "rotate-180" : ""}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>

              {dropdownOpen && (
                <>
                  <button
                    type="button"
                    aria-label="Close minimum profit menu"
                    className="fixed inset-0 z-10 cursor-default"
                    onClick={() => setDropdownOpen(false)}
                  />
                  <div
                    role="listbox"
                    aria-label="Minimum profit options"
                    className={`absolute right-0 top-full z-20 mt-2 w-44 rounded-2xl p-1.5 ${GLASS_DROPDOWN}`}
                  >
                    <div className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest text-slate-500">
                      Minimum profit
                    </div>
                    {MIN_PROFIT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={minProfit === option.value}
                        onClick={() => selectMinProfit(option.value)}
                        className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm transition-all duration-200 ${
                          minProfit === option.value
                            ? "bg-emerald-500/15 font-bold text-emerald-200"
                            : "text-slate-300 hover:bg-white/[0.06] hover:text-white"
                        }`}
                      >
                        {option.label}
                        {minProfit === option.value && (
                          <svg
                            className="h-4 w-4 text-emerald-300"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Refresh — emerald gradient pill */}
            <button
              type="button"
              onClick={() => void load({ refresh: true })}
              disabled={loading || refreshing}
              className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-emerald-500/30 transition-all duration-300 hover:scale-105 hover:shadow-emerald-400/50 active:scale-95 disabled:pointer-events-none disabled:opacity-60"
              aria-label="Force a fresh arbitrage calculation"
            >
              {refreshing ? (
                <span
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                  aria-hidden="true"
                />
              ) : (
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                  <path d="M8 16H3v5" />
                </svg>
              )}
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {/* ── Info strip ── */}
        <div className="grid grid-cols-1 gap-3 rounded-2xl border border-emerald-500/15 bg-emerald-500/5 p-4 text-xs sm:grid-cols-3">
          <div>
            <div className="font-mono uppercase tracking-wider text-emerald-300">How it works</div>
            <p className="mt-1 text-slate-400">
              One 1X2 selection per match across 2–3 <em>different</em> matches.
              When the implied probabilities sum below 100%, dutching the stakes
              locks in a return above the total stake.
            </p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-teal-300">Real odds first</div>
            <p className="mt-1 text-slate-400">
              Best 1X2 prices from ESPN &amp; API-Football bookmakers. A missing
              price falls back to a league-anchor Poisson fair price, labelled
              Synthetic.
            </p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-violet-300">Cached for 1 hour</div>
            <p className="mt-1 text-slate-400">
              Results are cached for one hour. Refresh forces a fresh scan;
              the MIN PROFIT chip re-runs the scan at the new threshold.
            </p>
          </div>
        </div>

        {/* ── Error ── */}
        {error && (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5 text-sm text-rose-200">
            <div className="font-bold">Multi-Match Arbitrage is temporarily unavailable</div>
            <p className="mt-1 text-rose-200/70">{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-rose-400/30 bg-rose-400/10 px-4 py-2 text-xs font-semibold text-rose-200 transition hover:bg-rose-400/20"
            >
              Retry
            </button>
          </div>
        )}

        {loading && !data ? (
          <LoadingSkeleton />
        ) : data ? (
          <>
            {/* ── Summary cards ── */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryCard
                label="Total Combinations Scanned"
                value={data.totalCombinationsScanned.toLocaleString("en-GB")}
                accent="text-slate-100"
                hint={`${data.matchesScanned.toLocaleString("en-GB")} matches priced`}
              />
              <SummaryCard
                label="Arbitrage Opportunities Found"
                value={String(arbs.length)}
                accent={arbs.length > 0 ? "text-emerald-300" : "text-slate-100"}
                hint={data.partial ? "partial scan" : `min profit ${(data.filters.minProfit * 100).toFixed(0)}%`}
              />
              <SummaryCard
                label="Average Profit Margin (%)"
                value={avgMargin !== null ? `${avgMargin.toFixed(2)}%` : "—"}
                accent={avgMargin !== null ? "text-emerald-300" : "text-slate-500"}
                hint={arbs.length > 0 ? `${arbs.length} opportunit${arbs.length === 1 ? "y" : "ies"}` : "no opportunities"}
              />
              <SummaryCard
                label="Best Profit Margin (%)"
                value={bestMargin !== null ? `${bestMargin.toFixed(2)}%` : "—"}
                accent={bestMargin !== null ? "text-emerald-300" : "text-slate-500"}
                hint={data.cache.hit ? "from 1h cache" : "fresh scan"}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>
                {arbs.length} arbitrage{arbs.length === 1 ? "" : "s"} ·{" "}
                {data.totalCombinationsScanned.toLocaleString("en-GB")} combination
                {data.totalCombinationsScanned === 1 ? "" : "s"} scanned
                {data.partial && (
                  <span className="ml-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-mono text-[10px] text-amber-300">
                    ⚠ 30s scan budget hit — partial result
                  </span>
                )}
              </span>
              <span className="font-mono">
                Updated {formatDateTime(data.generatedAt)}
                {data.cache.hit ? " · cached" : ""}
              </span>
            </div>

            {refreshing && (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-emerald-400/30 border-t-emerald-300" />
                Re-pricing every fixture and re-scanning all combinations…
              </div>
            )}

            {/* ── Listings ── */}
            {arbs.length > 0 ? (
              <div className="space-y-4">
                {arbs.map((arb) => (
                  <ArbitrageCard key={arb.id} arbitrage={arb} />
                ))}
              </div>
            ) : (
              !error && <EmptyState combinationsScanned={data.totalCombinationsScanned} />
            )}
          </>
        ) : null}

        <p className="border-t border-emerald-400/10 pt-4 text-center text-[11px] leading-relaxed text-slate-500">
          Arbitrage pricing is derived from live bookmaker odds and, when those
          are unavailable, from model fair prices. Odds move — always confirm the
          quoted prices before placing the legs, and never assume a result.
        </p>
      </div>
    </main>
  );
}

// ─── Summary card ─────────────────────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  accent,
  hint,
}: {
  label: string;
  value: string;
  accent: string;
  hint?: string;
}) {
  return (
    <div className={`rounded-2xl p-4 ${GLASS_PANEL}`}>
      <div className={`text-2xl font-extrabold font-mono ${accent}`}>{value}</div>
      <div className="mt-1 text-[11px] font-medium text-slate-300">{label}</div>
      {hint && <div className="mt-0.5 text-[10px] font-mono text-slate-500">{hint}</div>}
    </div>
  );
}

// ─── Arbitrage listing card ───────────────────────────────────────────────────

function ArbitrageCard({ arbitrage }: { arbitrage: ArbitrageOpportunity }) {
  return (
    <article className="overflow-hidden rounded-2xl border border-white/[0.08] border-t-2 border-t-emerald-400/60 bg-white/[0.04] backdrop-blur-xl shadow-lg shadow-black/40 transition-all duration-200 hover:-translate-y-1 hover:shadow-emerald-500/10">
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <QualityBadge quality={arbitrage.dataQuality} />
          <span className="rounded-full border border-white/[0.08] bg-white/[0.05] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-300">
            {arbitrage.legs}-match arbitrage
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500">
              Confidence
            </div>
            <div className="font-mono text-sm font-bold text-slate-100">
              {arbitrage.confidenceScore}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500">
              Profit
            </div>
            <div className="font-mono text-xl font-extrabold text-emerald-300">
              +{arbitrage.profitMarginPct.toFixed(2)}%
            </div>
          </div>
        </div>
      </div>

      {/* Matches + selections */}
      <div
        className={`grid gap-3 px-4 py-4 sm:px-5 ${
          arbitrage.matches.length === 2
            ? "sm:grid-cols-2"
            : "sm:grid-cols-2 lg:grid-cols-3"
        }`}
      >
        {arbitrage.matches.map((match) => (
          <div
            key={`${arbitrage.id}-${match.fixtureId}`}
            className="space-y-2 rounded-xl border border-white/[0.07] bg-black/20 p-3"
          >
            {/* Match header badge */}
            <div>
              <div className="truncate text-sm font-bold text-white">
                {match.homeTeam} <span className="text-slate-500">vs</span>{" "}
                {match.awayTeam}
              </div>
              <div className="mt-0.5 truncate text-[10px] text-slate-400">{match.leagueName}</div>
              <div className="text-[10px] font-mono text-slate-500">{formatDate(match.matchDate)}</div>
            </div>

            {/* Selection details */}
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <span className="rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-200">
                {match.selectedOutcome}
              </span>
              <span className="font-mono text-xs font-bold text-white">@{match.odds.toFixed(2)}</span>
              <span className="ml-auto font-mono text-[11px] text-slate-300">
                {pound(match.stake)}
                <span className="text-slate-500"> ({match.stakePercent.toFixed(1)}%)</span>
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Summary row */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/[0.06] bg-black/20 px-4 py-3 sm:px-5">
        <div className="text-xs">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
            Total Stake
          </span>
          <div className="font-mono text-sm font-bold text-white">
            {pound(arbitrage.totalStake)}
          </div>
        </div>
        <div className="text-xs">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
            Guaranteed Return
          </span>
          <div className="font-mono text-sm font-bold text-emerald-300">
            {pound(arbitrage.guaranteedReturn)}
          </div>
        </div>
        <div className="text-xs">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
            Profit Margin
          </span>
          <div className="font-mono text-sm font-extrabold text-emerald-300">
            +{arbitrage.profitMarginPct.toFixed(2)}%
          </div>
        </div>
        <div className="text-xs">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
            Confidence Score
          </span>
          <div className="font-mono text-sm font-bold text-slate-100">
            {arbitrage.confidenceScore}
          </div>
        </div>
      </div>
    </article>
  );
}

// ─── Data quality badge ───────────────────────────────────────────────────────

function QualityBadge({ quality }: { quality: DataQuality }) {
  if (quality === "Real") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-200"
        title="All legs priced from real bookmaker odds"
      >
        🔵 Real
      </span>
    );
  }
  if (quality === "Mixed") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-amber-400/25 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-200"
        title="Some legs from real bookmaker odds, some from model fair prices"
      >
        🟠 Mixed
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-white/[0.1] bg-white/[0.05] px-2 py-0.5 text-[10px] font-bold text-slate-300"
      title="All legs priced from model fair prices (league-anchor Poisson)"
    >
      ⚪ Synthetic
    </span>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ combinationsScanned }: { combinationsScanned: number }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-white/[0.07] bg-white/[0.03] px-6 py-14 text-center backdrop-blur-xl">
      <svg
        className="mb-4 h-14 w-14 text-slate-600"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.35-4.35" />
        <path d="M8 11h6" className="stroke-emerald-500" />
        <path d="M11 8v6" className="stroke-emerald-500" />
      </svg>
      <div className="max-w-md text-sm font-semibold text-slate-200">
        No arbitrage opportunities found with the current MIN PROFIT filter. Try
        lowering the threshold or checking more matches.
      </div>
      <p className="mt-3 font-mono text-[11px] text-slate-500">
        {combinationsScanned.toLocaleString("en-GB")} match combination
        {combinationsScanned === 1 ? "" : "s"} scanned · results cached for 1 hour
      </p>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-700 border-t-emerald-400" />
        <span className="font-mono text-emerald-200">
          Pricing 1X2 markets and scanning match combinations…
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((card) => (
          <div key={card} className="rounded-2xl border border-emerald-500/15 bg-emerald-500/5 p-4">
            <div className="h-6 w-16 animate-pulse rounded bg-emerald-400/10" />
            <div className="mt-2 h-3 w-28 animate-pulse rounded bg-white/[0.06]" />
          </div>
        ))}
      </div>
      {[1, 2].map((card) => (
        <div key={card} className="rounded-2xl border border-emerald-500/15 bg-emerald-500/5 p-4">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="h-5 w-24 animate-pulse rounded-full bg-emerald-400/10" />
            <div className="h-5 w-16 animate-pulse rounded bg-emerald-400/10" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {[1, 2].map((block) => (
              <div key={block} className="space-y-2 rounded-xl border border-white/[0.06] bg-black/20 p-3">
                <div className="h-3 w-32 animate-pulse rounded bg-white/[0.06]" />
                <div className="h-3 w-20 animate-pulse rounded bg-white/[0.04]" />
                <div className="h-5 w-24 animate-pulse rounded-full bg-emerald-400/10" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
