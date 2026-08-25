"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TeamBadge } from "../../_components/ui";
import {
  NAV_PILL_PREMIUM,
  GLASS_PANEL,
} from "../../_components/design";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SureCornerMarketType =
  | "Total Corners"
  | "Team 1 Corners"
  | "Team 2 Corners"
  | "Corner Winner"
  | "Corner Handicap";

export interface SureCornerMarket {
  id: string;
  marketType: SureCornerMarketType;
  name: string;
  selection: string;
  line: number | null;
  hitRate: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
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
  /** Optional – added by the API but omitted in the page's local type. */
  dataAvailability?: "HIGH" | "MEDIUM" | "LOW";
  /** Optional score info present for live / finished fixtures. */
  homeScore?: number | null;
  awayScore?: number | null;
  predictedCorners: {
    home: number;
    away: number;
    difference: number;
    strongerTeam: string | null;
  };
  markets: SureCornerMarket[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateTime(value: string): string {
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

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function matchStatus(match: SureCornerMatch): "LIVE" | "FINISHED" | "UPCOMING" {
  const now = Date.now();
  const start = new Date(match.date).getTime();
  // Treat the match as live within a ±120-minute window around kick-off
  if (start <= now && now - start < 120 * 60 * 1000) return "LIVE";
  if (start < now) return "FINISHED";
  return "UPCOMING";
}

const STATUS_BADGE: Record<"LIVE" | "FINISHED" | "UPCOMING", string> = {
  LIVE: "animate-pulse bg-rose-500/20 text-rose-300 ring-1 ring-rose-400/40",
  FINISHED: "bg-slate-500/20 text-slate-300 ring-1 ring-slate-500/30",
  UPCOMING: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30",
};

const CONFIDENCE_PILL: Record<"HIGH" | "MEDIUM" | "LOW", string> = {
  HIGH: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30",
  MEDIUM: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30",
  LOW: "bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30",
};

const OUTCOME_PILL: Record<string, string> = {
  WIN: "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30",
  LOSS: "bg-rose-500/20 text-rose-300 ring-1 ring-rose-500/30",
  PUSH: "bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30",
  VOID: "bg-slate-500/20 text-slate-400 ring-1 ring-slate-500/30",
  PENDING: "bg-slate-700/40 text-slate-400 ring-1 ring-slate-600/40",
};

const MARKET_TONES: Record<SureCornerMarketType, string> = {
  "Total Corners": "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
  "Team 1 Corners": "border-amber-400/30 bg-amber-400/10 text-amber-200",
  "Team 2 Corners": "border-violet-400/30 bg-violet-400/10 text-violet-200",
  "Corner Winner": "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  "Corner Handicap": "border-rose-400/30 bg-rose-400/10 text-rose-200",
};

const ALL_MARKET_TYPES: SureCornerMarketType[] = [
  "Total Corners",
  "Team 1 Corners",
  "Team 2 Corners",
  "Corner Winner",
  "Corner Handicap",
];

// ─── MatchOverlay ─────────────────────────────────────────────────────────────

interface MatchOverlayProps {
  match: SureCornerMatch;
  onClose: () => void;
}

export default function MatchOverlay({ match, onClose }: MatchOverlayProps) {
  // Animation state: mount → animate-in → visible → animate-out → unmount
  const [visible, setVisible] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Animate in on mount
  useEffect(() => {
    // rAF ensures the element is painted before the class change
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Animate out, then call onClose when the transition ends
  const handleClose = useCallback(() => {
    setVisible(false);
  }, []);

  const handleTransitionEnd = useCallback(() => {
    if (!visible) onClose();
  }, [visible, onClose]);

  // Escape key closes the overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  // Prevent background scroll while overlay is open
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = original; };
  }, []);

  // Focus trap: move focus into the panel on mount
  useEffect(() => {
    if (panelRef.current) panelRef.current.focus();
  }, []);

  const status = matchStatus(match);

  // All markets sorted by hitRate descending
  const sortedMarkets = [...match.markets].sort((a, b) => b.hitRate - a.hitRate);
  const presentTypes = new Set(sortedMarkets.map(m => m.marketType));
  
  const missingMarketTypes = ALL_MARKET_TYPES.filter(t => !presentTypes.has(t));

  const sortedRows = [
    ...sortedMarkets.map(m => ({ type: "market" as const, data: m })),
    ...missingMarketTypes.map(t => ({ type: "missing" as const, marketType: t }))
  ];

  const hasScore =
    typeof match.homeScore === "number" && typeof match.awayScore === "number";

  return (
    // Full-screen backdrop
    <div
      aria-modal="true"
      role="dialog"
      aria-label={`${match.homeTeam} vs ${match.awayTeam} corner markets`}
      className={[
        "fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-6",
        "bg-black/70 backdrop-blur-sm",
        "transition-opacity duration-300",
        visible ? "opacity-100" : "opacity-0",
      ].join(" ")}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
      onTransitionEnd={handleTransitionEnd}
    >
      {/* Glass panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={[
          "relative flex flex-col",
          "w-full h-full sm:w-[90vw] sm:max-w-5xl sm:h-[80vh] sm:rounded-2xl",
          "bg-slate-900/90 backdrop-blur-xl border border-white/10",
          "focus:outline-none",
          "transition-all duration-300 ease-out",
          visible ? "scale-100 opacity-100" : "scale-95 opacity-0",
        ].join(" ")}
      >
        {/* ── Scrollable content area ── */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">

          {/* ── Match Header ── */}
          <div className={`${GLASS_PANEL} rounded-2xl p-4 sm:p-5 space-y-4`}>
            {/* League + date row */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-amber-200">
                  Tier {match.leagueTier}
                </span>
                <span>{match.league}</span>
              </div>
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider ${STATUS_BADGE[status]}`}
              >
                {status === "LIVE" && (
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
                )}
                {status}
              </span>
            </div>

            {/* Teams */}
            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 sm:gap-6">
              {/* Home */}
              <div className="flex min-w-0 items-center justify-end gap-2 sm:gap-3">
                <span className="truncate text-right text-lg font-extrabold text-white sm:text-2xl">
                  {match.homeTeam}
                </span>
                <TeamBadge logo={match.homeLogo} name={match.homeTeam} size={36} />
              </div>

              {/* Score or VS */}
              <div className="flex flex-col items-center gap-1">
                {hasScore ? (
                  <span className="font-mono text-xl font-extrabold text-white sm:text-3xl">
                    {match.homeScore} – {match.awayScore}
                  </span>
                ) : (
                  <span className="font-mono text-sm text-slate-500">VS</span>
                )}
                <span className="font-mono text-[10px] text-slate-500">
                  {formatDateTime(match.date)}
                </span>
              </div>

              {/* Away */}
              <div className="flex min-w-0 items-center justify-start gap-2 sm:gap-3">
                <TeamBadge logo={match.awayLogo} name={match.awayTeam} size={36} />
                <span className="truncate text-lg font-extrabold text-white sm:text-2xl">
                  {match.awayTeam}
                </span>
              </div>
            </div>

            {/* Engine expectations bar */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2 font-mono text-xs text-slate-400">
              <span>
                Expected corners:{" "}
                <strong className="text-slate-200">
                  {match.predictedCorners.home.toFixed(1)} — {match.predictedCorners.away.toFixed(1)}
                </strong>
              </span>
              <span>
                Δ{" "}
                <strong className="text-amber-200">
                  {match.predictedCorners.difference.toFixed(1)}
                </strong>
              </span>
              {match.predictedCorners.strongerTeam && (
                <span>
                  Edge:{" "}
                  <strong className="text-cyan-200">
                    {match.predictedCorners.strongerTeam}
                  </strong>
                </span>
              )}
            </div>
          </div>

          {/* ── Corner Markets Table ── */}
          <div>
            <div className="mb-3 flex items-center gap-2">
              <span className="text-base font-bold text-white sm:text-lg">Corner Markets</span>
              <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 font-mono text-[11px] text-slate-400">
                {sortedRows.length} market{sortedRows.length !== 1 ? "s" : ""} · ranked by hit rate
              </span>
            </div>

            {/* Horizontally scrollable on mobile */}
            <div className="overflow-x-auto rounded-xl border border-white/[0.07]">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.07] bg-white/[0.03]">
                    <th className="whitespace-nowrap px-3 py-2.5 text-left font-mono text-[11px] uppercase tracking-wider text-slate-500">
                      Market
                    </th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-left font-mono text-[11px] uppercase tracking-wider text-slate-500">
                      Selection
                    </th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-[11px] uppercase tracking-wider text-slate-500">
                      Hit Rate
                    </th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-center font-mono text-[11px] uppercase tracking-wider text-slate-500">
                      Confidence
                    </th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-center font-mono text-[11px] uppercase tracking-wider text-slate-500">
                      Outcome
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05]">
                  {sortedRows.map((row, idx) => {
                    const isTop = idx === 0;

                    if (row.type === "missing") {
                      return (
                        <tr key={`missing-${row.marketType}`} className="hover:bg-white/[0.03] opacity-50">
                          <td className="px-3 py-3" colSpan={5}>
                            <div className="flex flex-col gap-1">
                              <span
                                className={`inline-flex w-fit rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${MARKET_TONES[row.marketType]}`}
                              >
                                {row.marketType}
                              </span>
                              <span className="text-slate-400 italic">
                                {row.marketType} — Not available for this match.
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    }

                    const market = row.data;
                    const isLowConfidence = market.confidence === "LOW";

                    const outcome =
                      status === "FINISHED"
                        ? // The API may embed an outcome string in reasons; default PENDING
                          "PENDING"
                        : "PENDING";

                    return (
                      <tr
                        key={market.id}
                        className={[
                          "transition-colors",
                          isTop && !isLowConfidence
                            ? "bg-amber-400/[0.06] hover:bg-amber-400/[0.10]"
                            : "hover:bg-white/[0.03]",
                          isLowConfidence ? "opacity-60" : ""
                        ].join(" ")}
                      >
                        {/* Market name + type badge */}
                        <td className="px-3 py-3">
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              <span
                                className={`inline-flex w-fit rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${MARKET_TONES[market.marketType]}`}
                              >
                                {market.marketType}
                              </span>
                              {isLowConfidence && (
                                <span className="inline-flex items-center rounded-full border border-slate-500/30 bg-slate-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-slate-400">
                                  Not Qualified
                                </span>
                              )}
                            </div>
                            <span className={`font-semibold ${isLowConfidence ? "text-slate-400" : "text-slate-100"}`}>
                              {market.name}
                            </span>
                          </div>
                        </td>

                        {/* Selection */}
                        <td className="whitespace-nowrap px-3 py-3">
                          <span className={`rounded-md border px-2 py-1 font-bold ${isLowConfidence ? "border-slate-500/20 bg-slate-500/10 text-slate-300" : "border-amber-400/20 bg-amber-400/10 text-amber-100"}`}>
                            {market.selection}
                          </span>
                        </td>

                        {/* Hit rate */}
                        <td className="whitespace-nowrap px-3 py-3 text-right">
                          <span
                            className={`rounded-md px-2.5 py-1 font-mono font-extrabold ${
                              isLowConfidence
                                ? "bg-slate-500/15 text-slate-400"
                                : market.hitRate >= 0.9
                                ? "bg-emerald-500/15 text-emerald-300"
                                : market.hitRate >= 0.75
                                ? "bg-amber-500/15 text-amber-300"
                                : "bg-slate-500/15 text-slate-300"
                            }`}
                          >
                            {pct(market.hitRate)}
                          </span>
                        </td>

                        {/* Confidence */}
                        <td className="px-3 py-3 text-center">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider ${
                              isLowConfidence 
                                ? "bg-slate-500/15 text-slate-400 ring-1 ring-slate-500/30"
                                : CONFIDENCE_PILL[market.confidence]
                            }`}
                          >
                            {isLowConfidence ? "Low Confidence" : market.confidence}
                          </span>
                        </td>

                        {/* Outcome */}
                        <td className="px-3 py-3 text-center">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider ${OUTCOME_PILL[outcome] ?? OUTCOME_PILL.PENDING}`}
                          >
                            {outcome}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ── Sticky footer: Back button ── */}
        <div className="shrink-0 border-t border-white/[0.07] bg-slate-900/80 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center justify-between gap-4">
            <p className="hidden text-[11px] text-slate-500 sm:block">
              Press <kbd className="rounded border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px]">Esc</kbd> to close
            </p>
            <button
              type="button"
              onClick={handleClose}
              className={`${NAV_PILL_PREMIUM} bg-gradient-to-br from-[#F59E0B] to-[#FF8C00] px-5 py-2.5 text-sm font-bold text-white shadow-[0_0_25px_-8px_rgba(245,158,11,0.55)] hover:brightness-110`}
            >
              ← Back to Fixture Cards
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
