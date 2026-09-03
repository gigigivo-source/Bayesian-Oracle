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
} from "../_components/design";
import MatchOverlay from "./components/MatchOverlay";
import type { SureCornerMatch } from "./components/MatchOverlay";

export const dynamic = "force-dynamic";

// ─── Local types (page-only) ──────────────────────────────────────────────────

type SureCornerMarketType =
  | "Total Corners"
  | "Team 1 Corners"
  | "Team 2 Corners"
  | "Corner Winner"
  | "Corner Handicap";

interface SureCornerMarket {
  id: string;
  marketType: SureCornerMarketType;
  name: string;
  selection: string;
  line: number | null;
  hitRate: number;
  confidence: "HIGH";
  reason: string;
}

interface SureCornersData {
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MARKET_TONES: Record<SureCornerMarketType, string> = {
  "Total Corners": "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
  "Team 1 Corners": "border-amber-400/30 bg-amber-400/10 text-amber-200",
  "Team 2 Corners": "border-violet-400/30 bg-violet-400/10 text-violet-200",
  "Corner Winner": "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  "Corner Handicap": "border-rose-400/30 bg-rose-400/10 text-rose-200",
};

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

function countOutcome(
  details: VerifyDetail[],
  outcome: VerifyDetail["outcome"],
): number {
  return details.filter((detail) => detail.outcome === outcome).length;
}

/** Derives a fixture status from its date. */
function fixtureStatus(dateStr: string): "LIVE" | "UPCOMING" | "FINISHED" {
  const now = Date.now();
  const start = new Date(dateStr).getTime();
  if (start <= now && now - start < 120 * 60 * 1000) return "LIVE";
  if (start < now) return "FINISHED";
  return "UPCOMING";
}

const STATUS_BADGE_CLASS: Record<"LIVE" | "UPCOMING" | "FINISHED", string> = {
  LIVE: "animate-pulse bg-rose-500/20 text-rose-300 ring-1 ring-rose-400/40",
  UPCOMING: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30",
  FINISHED: "bg-slate-500/20 text-slate-300 ring-1 ring-slate-500/30",
};

// ─── Verify types ─────────────────────────────────────────────────────────────

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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SureCornersPage() {
  const [data, setData] = useState<SureCornersData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Tracks the latest loaded payload without making `load` depend on state.
   * A data-dependent `load` callback used to re-arm the mount effect on every
   * fetch, causing the page to auto-refresh continuously.
   */
  const dataRef = useRef<SureCornersData | null>(null);
  const initialFetchDone = useRef(false);

  // ── Overlay state: null = closed, SureCornerMatch = open ──────────────────
  const [selectedMatch, setSelectedMatch] = useState<SureCornerMatch | null>(null);

  const load = useCallback(async (forceRefresh = false) => {
    if (forceRefresh || dataRef.current) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const url = forceRefresh
        ? "/api/sure-corners?refresh=true"
        : "/api/sure-corners";
      const response = await fetch(url, { cache: "no-store" });
      const payload = (await response.json()) as SureCornersData & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      dataRef.current = payload;
      setData(payload);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to load Sure Bet Corners.",
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

  // ── Post-match verification ───────────────────────────────────────────────
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
      const payload = (await response.json()) as VerifySummary & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      setVerifyStatus({ kind: "success", summary: payload });
      void load(false);
    } catch (reason) {
      setVerifyStatus({
        kind: "error",
        message:
          reason instanceof Error ? reason.message : "Verification failed.",
      });
    } finally {
      setVerifying(false);
    }
  }, [verifying, load]);

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

        {/* ── Header ── */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div
              className={`${CHIP} ${CHIP_ON_AMBER} mb-3 inline-flex px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider`}
            >
              🎯 Strict corner filter · 7-day window
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              Sure Bet Corners
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400 sm:text-base">
              Matches with the highest-confidence corner bets with strict
              filters applied. Now showing the next 7 days. Click any fixture
              card to explore all corner markets.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className={`${NAV_PILL} ${NAV_PILL_OFF} px-3 py-2 text-xs font-semibold`}
            >
              ← Oracle
            </Link>
            <Link
              href="/performance/corners"
              title="Sure Bet Corners track record — historical picks, hit rate, P&L and ROI"
              aria-label="Open the Sure Bet Corners performance tracker"
              className={`${NAV_PILL} bg-gradient-to-r from-[#F59E0B] to-[#FF8C00] px-4 py-2 text-xs font-bold text-white shadow-[0_0_20px_-5px_rgba(245,158,11,0.5)] hover:brightness-110`}
            >
              📊 Track Records
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

        {/* ── Verify status banner ── */}
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
                  {verifyStatus.kind === "success"
                    ? "Post-match verification complete"
                    : "Verification failed"}
                </div>
                {verifyStatus.kind === "success" ? (
                  <p className="mt-0.5 text-xs text-emerald-200/80">
                    Verified {verifyStatus.summary.total} match
                    {verifyStatus.summary.total === 1 ? "" : "es"} ·{" "}
                    {verifyStatus.summary.updated} outcome
                    {verifyStatus.summary.updated === 1 ? "" : "s"} updated ·{" "}
                    {countOutcome(verifyStatus.summary.details, "WIN")} WIN ·{" "}
                    {countOutcome(verifyStatus.summary.details, "LOSS")} LOSS ·{" "}
                    {countOutcome(verifyStatus.summary.details, "PUSH")} PUSH ·{" "}
                    {countOutcome(verifyStatus.summary.details, "VOID")} VOID
                    {verifyStatus.summary.failed > 0
                      ? ` · ${verifyStatus.summary.failed} failed`
                      : ""}
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-rose-200/80">
                    {verifyStatus.message}
                  </p>
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

        {/* ── Stats filter summary ── */}
        <div
          className={`${GLASS_PANEL} grid grid-cols-1 gap-3 p-4 text-xs sm:grid-cols-3`}
        >
          <div>
            <div className="font-mono uppercase tracking-wider text-amber-300">
              {minHitRateLabel}%+ hit-rate gate
            </div>
            <p className="mt-1 text-slate-400">
              A market is shown only when the engine predicts at least{" "}
              {(minHitRate * 100).toFixed(1)}%.
            </p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-cyan-300">
              Real stats only
            </div>
            <p className="mt-1 text-slate-400">
              Both teams must have per-match corner data from the stats
              aggregator.
            </p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-emerald-300">
              Top tiers only · 7 days
            </div>
            <p className="mt-1 text-slate-400">
              Only Tier 1 and Tier 2 leagues, fixtures from today to 7 days
              ahead.
            </p>
          </div>
        </div>

        {/* ── Error state ── */}
        {error && (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5 text-sm text-rose-200">
            <div className="font-bold">
              Sure Bet Corners is temporarily unavailable
            </div>
            <p className="mt-1 text-rose-200/70">{error}</p>
            <p className="mt-2 font-mono text-xs text-rose-200/60">
              No match is shown without passing every gate.
            </p>
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
                {data.matches.length} qualifying match
                {data.matches.length === 1 ? "" : "es"} ·{" "}
                {data.totalFixturesChecked} fixtures checked · 7-day window
              </span>
              <span className="font-mono">
                Updated {formatDate(data.generatedAt)}
              </span>
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
                  {/* Date divider */}
                  <div className="flex items-center gap-2">
                    <div className="h-px flex-1 bg-white/[0.06]" />
                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-slate-300">
                      {formatDateGroup(group.matches[0].date)}
                    </span>
                    <div className="h-px flex-1 bg-white/[0.06]" />
                  </div>

                  {/* Premium fixture cards grid */}
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {group.matches.map((match, idx) => (
                      <PremiumFixtureCard
                        key={match.fixtureId}
                        match={match}
                        accentIndex={idx}
                        onClick={() => setSelectedMatch(match)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : !error ? (
          <EmptyState
            onRetry={() => void load(false)}
            hitRatePercent={minHitRateLabel}
          />
        ) : null}

        <p className="border-t border-white/[0.06] pt-4 text-center text-[11px] leading-relaxed text-slate-500">
          No model can guarantee a sports result. This view deliberately returns
          no match rather than relax a gate when the evidence is not strong
          enough.
        </p>
      </div>

      {/* ── Full-screen overlay (uses data already on page — no new API call) ── */}
      {selectedMatch && (
        <MatchOverlay
          match={selectedMatch}
          onClose={() => setSelectedMatch(null)}
        />
      )}
    </main>
  );
}

// ─── Premium Fixture Card ─────────────────────────────────────────────────────

interface PremiumFixtureCardProps {
  match: SureCornerMatch;
  accentIndex: number;
  onClick: () => void;
}

function PremiumFixtureCard({
  match,
  accentIndex,
  onClick,
}: PremiumFixtureCardProps) {
  const accent = CARD_ACCENT_ORDER[accentIndex % CARD_ACCENT_ORDER.length];
  const status = fixtureStatus(match.date);

  // Best market = highest hit rate
  const bestMarket = match.markets.length
    ? [...match.markets].sort((a, b) => b.hitRate - a.hitRate)[0]
    : null;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open corner markets for ${match.homeTeam} vs ${match.awayTeam}`}
      className={[
        CARD_GLASS,
        CARD_GLASS_SKIN[accent],
        GLASS_TEXT_SHADOW,
        "p-4 text-left w-full",
      ].join(" ")}
    >
      {/* ── Card header: league, date, status ── */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-400">
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-amber-200">
            T{match.leagueTier}
          </span>
          <span className="truncate max-w-[120px]">{match.league}</span>
        </div>
        {/* Status badge */}
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_BADGE_CLASS[status]}`}
        >
          {status === "LIVE" && (
            <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
          )}
          {status}
        </span>
      </div>

      {/* ── Teams ── */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 mb-3">
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

      {/* ── Date/time ── */}
      <div className="mb-3 font-mono text-[10px] text-slate-500 text-center">
        {formatDate(match.date)}
      </div>

      {/* ── Best market summary ── */}
      {bestMarket && (
        <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div
                className={`mb-1 inline-flex rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${MARKET_TONES[bestMarket.marketType as SureCornerMarketType]}`}
              >
                {bestMarket.marketType}
              </div>
              <p className="text-xs font-semibold text-slate-100 truncate">
                {bestMarket.name}
              </p>
              <p className="text-[10px] text-amber-200 font-medium">
                {bestMarket.selection}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <div className="font-mono text-base font-extrabold text-emerald-300">
                {percentage(bestMarket.hitRate)}
              </div>
              <div className="font-mono text-[9px] text-slate-500 uppercase tracking-wider">
                hit rate
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Footer: market count hint ── */}
      <div className="mt-2.5 flex items-center justify-between text-[10px] text-slate-500">
        <span>
          {match.markets.length} market{match.markets.length !== 1 ? "s" : ""}
        </span>
        <span className="text-amber-400/70">Tap to explore →</span>
      </div>
    </button>
  );
}

// ─── Legacy detailed card (kept for reference; not rendered) ──────────────────

function TeamName({
  logo,
  name,
  align,
}: {
  logo: string | null;
  name: string;
  align: "left" | "right";
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-2 ${align === "right" ? "justify-end" : "justify-start"}`}
    >
      {align === "right" && (
        <span className="truncate text-right text-sm font-bold text-white sm:text-base">
          {name}
        </span>
      )}
      <TeamBadge logo={logo} name={name} size={30} />
      {align === "left" && (
        <span className="truncate text-sm font-bold text-white sm:text-base">
          {name}
        </span>
      )}
    </div>
  );
}

function MarketCard({ market }: { market: SureCornerMarket }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-slate-950/40 p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <span
            className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${MARKET_TONES[market.marketType]}`}
          >
            {market.marketType}
          </span>
          <div className="mt-2 text-sm font-semibold text-slate-100">
            {market.name}
          </div>
        </div>
        <div className="flex items-center gap-2 font-mono">
          <span className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-sm font-extrabold text-emerald-300">
            {percentage(market.hitRate)}
          </span>
          <span className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-[10px] font-bold text-emerald-200">
            {market.confidence}
          </span>
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-sm font-bold text-amber-100">
        {market.selection}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-slate-400">
        {market.reason}
      </p>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({
  onRetry,
  hitRatePercent,
}: {
  onRetry: () => void;
  hitRatePercent: string;
}) {
  return (
    <div className={`${GLASS_PANEL} p-10 text-center sm:p-14`}>
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-400/20 bg-amber-400/10 text-2xl">
        🎯
      </div>
      <h2 className="text-xl font-bold text-slate-200">
        no sure bet corners available right now
      </h2>
      <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-400">
        Only corner bets with a predicted hit rate above {hitRatePercent}{" "}
        percent, real stats, and top-tier leagues are shown. If every market
        does not pass every strict filter, nothing is listed. Checked next 7
        days.
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

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-700 border-t-amber-400" />
        <span className="font-mono text-amber-200">
          Checking real corner stats and strict engine gates across next 7
          days…
        </span>
      </div>
      {/* Skeleton cards matching PremiumFixtureCard layout */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className={`${CARD_SURFACE} overflow-hidden p-4`}
          >
            {/* Header row skeleton */}
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex gap-1.5">
                <div className="h-4 w-6 animate-pulse rounded-full bg-white/[0.06]" />
                <div className="h-4 w-20 animate-pulse rounded-full bg-white/[0.06]" />
              </div>
              <div className="h-4 w-16 animate-pulse rounded-full bg-white/[0.06]" />
            </div>
            {/* Teams row skeleton */}
            <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <div className="flex items-center justify-end gap-1.5">
                <div className="h-4 w-16 animate-pulse rounded bg-white/[0.06]" />
                <div className="h-6 w-6 animate-pulse rounded-full bg-white/[0.08]" />
              </div>
              <div className="h-3 w-5 animate-pulse rounded bg-white/[0.04]" />
              <div className="flex items-center gap-1.5">
                <div className="h-6 w-6 animate-pulse rounded-full bg-white/[0.08]" />
                <div className="h-4 w-16 animate-pulse rounded bg-white/[0.06]" />
              </div>
            </div>
            <div className="mb-3 h-3 w-2/3 mx-auto animate-pulse rounded bg-white/[0.04]" />
            {/* Best market skeleton */}
            <div className="rounded-xl border border-white/[0.07] bg-black/20 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="space-y-1.5 flex-1">
                  <div className="h-3 w-20 animate-pulse rounded-full bg-white/[0.06]" />
                  <div className="h-3.5 w-32 animate-pulse rounded bg-white/[0.06]" />
                  <div className="h-3 w-16 animate-pulse rounded bg-amber-400/10" />
                </div>
                <div className="space-y-1 text-right">
                  <div className="h-5 w-12 animate-pulse rounded bg-emerald-400/10" />
                  <div className="h-3 w-10 animate-pulse rounded bg-white/[0.04]" />
                </div>
              </div>
            </div>
            <div className="mt-2.5 flex justify-between">
              <div className="h-3 w-14 animate-pulse rounded bg-white/[0.04]" />
              <div className="h-3 w-20 animate-pulse rounded bg-amber-400/5" />
            </div>
          </div>
        ))}
      </div>
      {/* Shimmer footer */}
      <div className={`${GLASS_PANEL} p-6`}>
        <div className="mx-auto h-3 w-2/3 animate-pulse rounded bg-white/[0.04]" />
      </div>
    </div>
  );
}
