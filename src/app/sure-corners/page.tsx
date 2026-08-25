"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TeamBadge } from "../_components/ui";
import {
  CARD_ACCENT_ORDER,
  CARD_GLASS,
  CARD_GLASS_SKIN,
  CARD_SURFACE,
  CHIP,
  CHIP_ON_AMBER,
  GLASS_PANEL,
  GLASS_TEXT_SHADOW,
  NAV_PILL,
  NAV_PILL_OFF,
  NAV_PILL_PREMIUM,
  OUTLINE_NEUTRAL,
  type CardAccent,
} from "../_components/design";
import { MatchOverlay, StatusBadge, bestMarket, deriveMatchStatus } from "./components/MatchOverlay";

export type SureCornerMarketType =
  | "Total Corners"
  | "Team 1 Corners"
  | "Team 2 Corners"
  | "Corner Winner"
  | "Corner Handicap";

export type SureCornerConfidence = "HIGH" | "MEDIUM" | "LOW";

export type SureCornerOutcome = "WIN" | "LOSS" | "PUSH" | "VOID" | "PENDING";

export interface SureCornerMarket {
  id: string;
  marketType: SureCornerMarketType;
  name: string;
  selection: string;
  line: number | null;
  hitRate: number;
  /** The route gate only emits HIGH today; the union keeps the UI future-proof. */
  confidence: SureCornerConfidence;
  reason: string;
  /** Settled post-match by the verify route. Absent → rendered as PENDING. */
  outcome?: SureCornerOutcome;
}

export interface SureCornerMatch {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  homeLogo: string | null;
  awayLogo: string | null;
  league: string;
  leagueSlug: string;
  leagueTier: number;
  date: string;
  confidence: "HIGH";
  realStats: true;
  statsSource: string;
  /** Optional: the current feed does not ship scores, so the UI degrades gracefully. */
  homeScore?: number;
  awayScore?: number;
  predictedCorners: {
    home: number;
    away: number;
    total?: number;
    difference: number;
    strongerTeam: string | null;
  };
  markets: SureCornerMarket[];
}

export interface SureCornersData {
  generatedAt: string;
  totalFixturesChecked: number;
  rejectedMatches: number;
  matches: SureCornerMatch[];
  filters: {
    minimumHitRate: number;
    requiredConfidence: "HIGH";
    requiresRealPerMatchCorners: true;
    allowedLeagueTiers: number[];
  };
}

/** Deterministic glass-deck accent per fixture so the card rhythm is stable across refreshes. */
function accentForFixture(id: string): CardAccent {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return CARD_ACCENT_ORDER[hash % CARD_ACCENT_ORDER.length];
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatDateGroup(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const isToday = date.toDateString() === today.toDateString();
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const base = new Intl.DateTimeFormat("en", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
  if (isToday) return `Today · ${base}`;
  if (isTomorrow) return `Tomorrow · ${base}`;
  return base;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function countOutcome(details: VerifyDetail[], outcome: VerifyDetail["outcome"]): number {
  return details.filter((detail) => detail.outcome === outcome).length;
}

interface VerifyDetail {
  eventId: string;
  match: string;
  market: string;
  outcome: "WIN" | "LOSS" | "PUSH" | "VOID" | "PENDING";
}

interface VerifySummary {
  total: number;
  updated: number;
  failed: number;
  details: VerifyDetail[];
}

type VerifyStatus =
  | { kind: "success"; summary: VerifySummary }
  | { kind: "error"; message: string };

export default function SureCornersPage() {
  const [data, setData] = useState<SureCornersData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The match whose corner-market overlay is open. The overlay renders purely
   * from this already-loaded object — opening it never touches the network,
   * so it appears instantly. `null` = closed (normal fixture-card grid view).
   */
  const [selectedMatch, setSelectedMatch] = useState<SureCornerMatch | null>(null);
  /**
   * Tracks the latest loaded payload without making `load` depend on state.
   * A data-dependent `load` callback used to re-arm the mount effect on every
   * fetch, causing the page to auto-refresh continuously.
   */
  const dataRef = useRef<SureCornersData | null>(null);
  const initialFetchDone = useRef(false);

  const load = useCallback(async (forceRefresh = false) => {
    if (forceRefresh || dataRef.current) {
      setRefreshing(true);
    } else {
      // Only show full loading skeleton if we have no data yet
      setLoading(true);
    }
    setError(null);
    try {
      const url = forceRefresh ? "/api/sure-corners?refresh=true" : "/api/sure-corners";
      const response = await fetch(url, { cache: "no-store" });
      const payload = (await response.json()) as SureCornersData & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      dataRef.current = payload;
      setData(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load Sure Bet Corners.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Fetch exactly once on mount. `load` is stable (empty dependency array),
    // so this effect never re-fires when data arrives; the API is only called
    // again when the user explicitly clicks Refresh or Retry.
    if (initialFetchDone.current) return;
    initialFetchDone.current = true;
    void load(false);
  }, [load]);

  // ── Post-match verification chip ─────────────────────────────────────────
  // Verifies every pending Sure Bet pick (rankingMode = 'S') against real
  // results + corner stats and settles the outcomes. The route is guarded by
  // the same CRON_SECRET as the settlement cron, so the secret must be
  // exposed to the browser as NEXT_PUBLIC_CRON_SECRET for this chip to work
  // on deployments that set CRON_SECRET.
  const [verifying, setVerifying] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<VerifyStatus | null>(null);

  const verifyOutcomes = useCallback(async () => {
    if (verifying) return;
    setVerifying(true);
    setVerifyStatus(null);
    try {
      const response = await fetch("/api/sure-corners/verify", {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${process.env.NEXT_PUBLIC_CRON_SECRET ?? ""}`,
        },
      });
      const payload = (await response.json()) as VerifySummary & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setVerifyStatus({ kind: "success", summary: payload });
      // Re-fetch the feed so the page reflects the newly settled outcomes.
      void load(false);
    } catch (reason) {
      setVerifyStatus({
        kind: "error",
        message: reason instanceof Error ? reason.message : "Verification failed.",
      });
    } finally {
      setVerifying(false);
    }
  }, [verifying, load]);

  // Mirrors the API gate (filters.minimumHitRate) so this copy never drifts
  // from the route's calibration threshold.
  const minHitRate = data?.filters.minimumHitRate ?? 0.95;
  const minHitRateLabel = (minHitRate * 100).toFixed(0);

  // Group matches by date for 7-day display
  const groupedMatches = useMemo(() => {
    if (!data?.matches) return [];
    const groups = new Map<string, SureCornerMatch[]>();
    for (const match of data.matches) {
      const dateKey = new Date(match.date).toISOString().slice(0, 10);
      const existing = groups.get(dateKey) ?? [];
      existing.push(match);
      groups.set(dateKey, existing);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dateKey, matches]) => ({ dateKey, matches }));
  }, [data]);

  return (
    <main className="min-h-screen bg-[#05070d] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className={`${CHIP} ${CHIP_ON_AMBER} mb-3 inline-flex px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider`}>
              🎯 Strict corner filter · 7-day window
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">Sure Bet Corners</h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400 sm:text-base">
              matches with the highest-confidence corner bets with strict filters applied. Now showing the next 7 days.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/" className={`${NAV_PILL} ${NAV_PILL_OFF} px-3 py-2 text-xs font-semibold`}>
              ← Oracle
            </Link>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading || refreshing}
              className={`${OUTLINE_NEUTRAL} inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-xs font-semibold transition hover:bg-white/10 disabled:opacity-60`}
              aria-label="Refresh sure corners"
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
            <button
              type="button"
              onClick={() => void verifyOutcomes()}
              disabled={verifying}
              title="Verify finished matches and update Sure Bet outcomes."
              aria-label="Verify finished matches and update Sure Bet outcomes"
              className={`${NAV_PILL_PREMIUM} bg-gradient-to-br from-[#F59E0B] to-[#FF8C00] px-4 py-2 text-xs font-bold text-white shadow-[0_0_25px_-8px_rgba(245,158,11,0.55)] hover:brightness-110 disabled:pointer-events-none disabled:opacity-60`}
            >
              {verifying ? (
                <>
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  Verifying…
                </>
              ) : (
                <>📊 post match corners</>
              )}
            </button>
          </div>
        </div>

        {verifyStatus && (
          <div
            role="status"
            aria-live="polite"
            className={`flex items-start justify-between gap-3 rounded-2xl border p-4 text-sm backdrop-blur-xl ${
              verifyStatus.kind === "success"
                ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
                : "border-rose-400/30 bg-rose-400/10 text-rose-200"
            }`}
          >
            <div className="flex items-start gap-2.5">
              <span className="text-base leading-none" aria-hidden="true">
                {verifyStatus.kind === "success" ? "✅" : "⚠️"}
              </span>
              <div>
                <div className="font-bold">
                  {verifyStatus.kind === "success" ? "Post-match verification complete" : "Verification failed"}
                </div>
                {verifyStatus.kind === "success" ? (
                  <p className="mt-0.5 text-xs text-emerald-200/80">
                    Verified {verifyStatus.summary.total} match{verifyStatus.summary.total === 1 ? "" : "es"} ·{" "}
                    {verifyStatus.summary.updated} outcome{verifyStatus.summary.updated === 1 ? "" : "s"} updated ·{" "}
                    {countOutcome(verifyStatus.summary.details, "WIN")} WIN ·{" "}
                    {countOutcome(verifyStatus.summary.details, "LOSS")} LOSS ·{" "}
                    {countOutcome(verifyStatus.summary.details, "PUSH")} PUSH ·{" "}
                    {countOutcome(verifyStatus.summary.details, "VOID")} VOID
                    {verifyStatus.summary.failed > 0 ? ` · ${verifyStatus.summary.failed} failed` : ""}
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-rose-200/80">{verifyStatus.message}</p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setVerifyStatus(null)}
              className="rounded px-1 text-xs opacity-60 transition hover:opacity-100"
              aria-label="Dismiss verification summary"
            >
              ✕
            </button>
          </div>
        )}

        <div className={`${GLASS_PANEL} grid grid-cols-1 gap-3 p-4 text-xs sm:grid-cols-3`}>
          <div>
            <div className="font-mono uppercase tracking-wider text-amber-300">{minHitRateLabel}%+ hit-rate gate</div>
            <p className="mt-1 text-slate-400">A market is shown only when the engine predicts at least {(minHitRate * 100).toFixed(1)}%.</p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-cyan-300">Real stats only</div>
            <p className="mt-1 text-slate-400">Both teams must have per-match corner data from the stats aggregator.</p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-emerald-300">Top tiers only · 7 days</div>
            <p className="mt-1 text-slate-400">Only Tier 1 and Tier 2 leagues, fixtures from today to 7 days ahead.</p>
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5 text-sm text-rose-200">
            <div className="font-bold">Sure Bet Corners is temporarily unavailable</div>
            <p className="mt-1 text-rose-200/70">{error}</p>
            <p className="mt-2 font-mono text-xs text-rose-200/60">No match is shown without passing every gate.</p>
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
                {data.matches.length} qualifying match{data.matches.length === 1 ? "" : "es"} · {data.totalFixturesChecked} fixtures checked · 7-day window
              </span>
              <span className="font-mono">Updated {formatDate(data.generatedAt)}</span>
            </div>
            {refreshing && (
              <div className="flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-amber-400/30 border-t-amber-300" />
                Refreshing with fresh calculation…
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
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {group.matches.map((match) => (
                      <MatchCard
                        key={match.fixtureId}
                        match={match}
                        onOpen={() => setSelectedMatch(match)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : !error ? (
          <EmptyState onRetry={() => void load(false)} hitRatePercent={minHitRateLabel} />
        ) : null}

        <p className="border-t border-white/[0.06] pt-4 text-center text-[11px] leading-relaxed text-slate-500">
          No model can guarantee a sports result. This view deliberately returns no match rather than relax a gate when the evidence is not strong enough.
        </p>
      </div>

      {selectedMatch && (
        <MatchOverlay match={selectedMatch} onClose={() => setSelectedMatch(null)} />
      )}
    </main>
  );
}

/**
 * Premium clickable fixture card (glass deck). The whole card is one button:
 * match details, a LIVE/UPCOMING/FINISHED badge and the best corner-market
 * summary at a glance — the full ranked market list opens in the MatchOverlay.
 */
function MatchCard({ match, onOpen }: { match: SureCornerMatch; onOpen: (match: SureCornerMatch) => void }) {
  const status = deriveMatchStatus(match.date);
  const best = bestMarket(match);

  return (
    <button
      type="button"
      onClick={() => onOpen(match)}
      aria-label={`Open corner markets for ${match.homeTeam} vs ${match.awayTeam}`}
      className={`group p-4 text-left ${CARD_GLASS} ${CARD_GLASS_SKIN[accentForFixture(match.fixtureId)]} ${GLASS_TEXT_SHADOW}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2 text-[11px]">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-slate-400">
          <span
            className="shrink-0 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-amber-200"
            title={`League priority tier ${match.leagueTier}`}
          >
            Tier {match.leagueTier}
          </span>
          <span className="truncate font-mono uppercase tracking-wider">{match.league}</span>
        </span>
        <StatusBadge status={status} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-3">
        <div className="flex min-w-0 items-center justify-end gap-2">
          <span className="truncate text-right text-sm font-bold text-white sm:text-base">{match.homeTeam}</span>
          <TeamBadge logo={match.homeLogo} name={match.homeTeam} size={26} />
        </div>
        <span className="font-mono text-xs text-slate-500">VS</span>
        <div className="flex min-w-0 items-center justify-start gap-2">
          <TeamBadge logo={match.awayLogo} name={match.awayTeam} size={26} />
          <span className="truncate text-sm font-bold text-white sm:text-base">{match.awayTeam}</span>
        </div>
      </div>

      <div className="mt-1 text-center font-mono text-[11px] text-slate-500">{formatDate(match.date)}</div>

      {best && (
        <div className="mt-3 rounded-xl border border-white/[0.08] bg-black/25 px-3 py-2.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-amber-200">Best corner bet</div>
          <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
            <span className="truncate text-sm font-bold text-white">
              {best.name} · {percentage(best.hitRate)} hit rate
            </span>
            <span className="shrink-0 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 font-mono text-xs font-extrabold text-emerald-300">
              {best.selection}
            </span>
          </div>
        </div>
      )}

      <div className="mt-2.5 flex items-center justify-between font-mono text-[11px] text-slate-500">
        <span>
          {match.markets.length} corner market{match.markets.length === 1 ? "" : "s"} · engine{" "}
          {match.predictedCorners.home.toFixed(1)}—{match.predictedCorners.away.toFixed(1)}
        </span>
        <span className="font-bold text-slate-300 transition-transform duration-200 group-hover:translate-x-0.5">
          View markets →
        </span>
      </div>
    </button>
  );
}

function EmptyState({ onRetry, hitRatePercent }: { onRetry: () => void; hitRatePercent: string }) {
  return (
    <div className={`${GLASS_PANEL} p-10 text-center sm:p-14`}>
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-400/20 bg-amber-400/10 text-2xl">🎯</div>
      <h2 className="text-xl font-bold text-slate-200">no sure bet corners available right now</h2>
      <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-400">
        Only corner bets with a predicted hit rate above {hitRatePercent} percent, real stats, and top-tier leagues are shown. If every market does not pass every strict filter, nothing is listed. Checked next 7 days.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.10]"
      >
        🔄 Retry
      </button>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-700 border-t-amber-400" />
        <span className="font-mono text-amber-200">Checking real corner stats and strict engine gates across next 7 days…</span>
      </div>
      {/* Skeleton cards matching MatchCard layout */}
      {[1, 2, 3].map((i) => (
        <div key={i} className={`${CARD_SURFACE} overflow-hidden p-4 sm:p-5`}>
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.07] pb-4">
            <div className="space-y-3">
              <div className="flex gap-2">
                <div className="h-5 w-14 animate-pulse rounded-full bg-white/[0.06]" />
                <div className="h-5 w-32 animate-pulse rounded-full bg-white/[0.06]" />
                <div className="h-5 w-40 animate-pulse rounded-full bg-white/[0.06]" />
              </div>
              <div className="flex items-center gap-3">
                <div className="h-6 w-24 animate-pulse rounded bg-white/[0.06]" />
                <div className="h-7 w-7 animate-pulse rounded-full bg-white/[0.08]" />
                <div className="h-4 w-6 animate-pulse rounded bg-white/[0.04]" />
                <div className="h-7 w-7 animate-pulse rounded-full bg-white/[0.08]" />
                <div className="h-6 w-24 animate-pulse rounded bg-white/[0.06]" />
              </div>
            </div>
            <div className="flex gap-2">
              <div className="h-12 w-24 animate-pulse rounded-xl bg-white/[0.06]" />
              <div className="h-12 w-24 animate-pulse rounded-xl bg-white/[0.06]" />
            </div>
          </div>
          <div className="mt-4 h-10 animate-pulse rounded-xl bg-black/20" />
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {[1, 2].map((j) => (
              <div key={j} className="rounded-xl border border-white/[0.07] bg-slate-950/40 p-3.5">
                <div className="flex justify-between">
                  <div className="h-5 w-24 animate-pulse rounded-full bg-white/[0.06]" />
                  <div className="h-6 w-16 animate-pulse rounded bg-white/[0.06]" />
                </div>
                <div className="mt-3 h-5 w-3/4 animate-pulse rounded bg-white/[0.06]" />
                <div className="mt-3 h-10 animate-pulse rounded-lg bg-amber-400/5" />
                <div className="mt-3 space-y-2">
                  <div className="h-3 w-full animate-pulse rounded bg-white/[0.04]" />
                  <div className="h-3 w-5/6 animate-pulse rounded bg-white/[0.04]" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {/* Shimmer footer */}
      <div className={`${GLASS_PANEL} p-6`}>
        <div className="mx-auto h-3 w-2/3 animate-pulse rounded bg-white/[0.04]" />
      </div>
    </div>
  );
}
