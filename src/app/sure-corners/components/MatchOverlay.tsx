"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MatchOverlay — full-screen corner-market detail panel for /sure-corners.
//
// Design contract (mirrors the app-wide design system in ../_components/design):
//   · Backdrop: fixed inset-0, bg-black/70 + backdrop-blur-sm, fades in/out
//     (transition-opacity duration-300).
//   · Panel: glass-morphism (bg-slate-900/90, backdrop-blur-xl, border-white/10,
//     rounded-2xl), w-full mobile / sm:w-[90%], h-[80vh], scales+fades in
//     (transition-all duration-300 ease-out).
//   · Close affordances: premium gold "← Back to Fixture Cards" pill pinned at
//     the bottom, a top-right ✕, backdrop click, and the Escape key. Closing
//     plays the reverse animation before unmounting.
//
// Performance contract: this component is PURELY presentational. It receives
// the already-loaded `SureCornerMatch` via props — opening it never triggers
// an API request, so it renders instantly.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TeamBadge } from "../../_components/ui";
import { NAV_PILL_PREMIUM } from "../../_components/design";
import type { SureCornerConfidence, SureCornerMarket, SureCornerMarketType, SureCornerMatch, SureCornerOutcome } from "../page";

/** Length of the open/close animation — keeps the unmount delay in sync with the CSS. */
const ANIMATION_MS = 300;

/**
 * A football fixture is treated as in-play for ~115 minutes after kickoff
 * (90 min + stoppage + half-time overhead). The feed only guarantees a date,
 * so LIVE/UPCOMING/FINISHED is derived client-side from it.
 */
const LIVE_WINDOW_MS = 115 * 60 * 1000;

export type MatchStatus = "LIVE" | "UPCOMING" | "FINISHED";

export function deriveMatchStatus(date: string, now: Date = new Date()): MatchStatus {
  const kickoff = new Date(date).getTime();
  if (Number.isNaN(kickoff)) return "UPCOMING";
  const elapsed = now.getTime() - kickoff;
  if (elapsed < 0) return "UPCOMING";
  if (elapsed <= LIVE_WINDOW_MS) return "LIVE";
  return "FINISHED";
}

const STATUS_STYLES: Record<MatchStatus, string> = {
  LIVE: "border-rose-400/40 bg-rose-500/15 text-rose-300",
  UPCOMING: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  FINISHED: "border-slate-500/40 bg-slate-500/15 text-slate-300",
};

export function StatusBadge({ status }: { status: MatchStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${STATUS_STYLES[status]}`}
    >
      {status === "LIVE" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400" aria-hidden="true" />}
      {status}
    </span>
  );
}

const CONFIDENCE_STYLES: Record<SureCornerConfidence, string> = {
  HIGH: "border-emerald-400/40 bg-emerald-400/15 text-emerald-300",
  MEDIUM: "border-amber-400/40 bg-amber-400/15 text-amber-300",
  LOW: "border-rose-400/40 bg-rose-400/15 text-rose-300",
};

const OUTCOME_STYLES: Record<SureCornerOutcome, string> = {
  WIN: "border-emerald-400/40 bg-emerald-400/15 text-emerald-300",
  LOSS: "border-rose-400/40 bg-rose-400/15 text-rose-300",
  PUSH: "border-amber-400/40 bg-amber-400/15 text-amber-300",
  VOID: "border-slate-400/30 bg-slate-400/10 text-slate-300",
  PENDING: "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
};

const MARKET_TONES: Record<SureCornerMarketType, string> = {
  "Total Corners": "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
  "Team 1 Corners": "border-amber-400/30 bg-amber-400/10 text-amber-200",
  "Team 2 Corners": "border-violet-400/30 bg-violet-400/10 text-violet-200",
  "Corner Winner": "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  "Corner Handicap": "border-rose-400/30 bg-rose-400/10 text-rose-200",
};

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatFullDate(value: string): string {
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

function formatKickoff(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function marketOutcome(market: SureCornerMarket): SureCornerOutcome {
  return market.outcome ?? "PENDING";
}

/** Markets sorted by hit rate, highest first — the overlay's ranking rule. */
export function rankMarkets(markets: readonly SureCornerMarket[]): SureCornerMarket[] {
  return [...markets].sort((left, right) => right.hitRate - left.hitRate);
}

/** The single strongest market of a match — powers the fixture-card summary. */
export function bestMarket(match: SureCornerMatch): SureCornerMarket {
  return rankMarkets(match.markets)[0];
}

export function MatchOverlay({
  match,
  onClose,
}: {
  /** The already-loaded match whose markets are shown. No fetching happens here. */
  match: SureCornerMatch;
  /** Called after the close animation finishes; the parent clears its selection. */
  onClose: () => void;
}) {
  // Enter as opacity-0/scale-95, flip the classes right after the first paint
  // so the CSS transition plays. Closing reverses the classes and delays the
  // parent unmount for the animation length.
  const [visible, setVisible] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const requestClose = useCallback(() => {
    setVisible(false);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(onClose, ANIMATION_MS);
  }, [onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    // Focus the primary action so keyboard users land somewhere sensible.
    backButtonRef.current?.focus();
    // Lock page scroll while the overlay is open; restore on unmount.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [requestClose]);

  const status = useMemo(() => deriveMatchStatus(match.date), [match.date]);
  const ranked = useMemo(() => rankMarkets(match.markets), [match.markets]);
  const hasScore =
    typeof match.homeScore === "number" && typeof match.awayScore === "number";
  const showScore = status !== "UPCOMING";

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-0 backdrop-blur-sm transition-opacity duration-300 sm:p-4 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      onClick={requestClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="match-overlay-title"
        onClick={(event) => event.stopPropagation()}
        className={`flex h-[80vh] w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900/90 shadow-2xl shadow-black/60 backdrop-blur-xl transition-all duration-300 ease-out sm:w-[90%] ${
          visible ? "scale-100 opacity-100" : "scale-95 opacity-0"
        }`}
      >
        {/* ── Match header ─────────────────────────────────────────────────── */}
        <header className="relative shrink-0 border-b border-white/10 p-4 sm:p-6">
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close match details"
            className="absolute right-3 top-3 rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-sm text-slate-300 transition hover:bg-white/[0.12] hover:text-white"
          >
            ✕
          </button>

          <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-slate-400">
            <StatusBadge status={status} />
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-amber-200">
              Tier {match.leagueTier}
            </span>
            <span className="truncate">{match.league}</span>
            <span className="text-slate-600" aria-hidden="true">·</span>
            <span>{formatFullDate(match.date)}</span>
          </div>

          <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 sm:gap-6">
            <OverlayTeam logo={match.homeLogo} name={match.homeTeam} align="right" />
            <div className="min-w-[72px] text-center">
              {showScore ? (
                <>
                  <div className="font-mono text-2xl font-extrabold text-white sm:text-3xl" data-testid="overlay-score">
                    {hasScore ? match.homeScore : "–"}
                    <span className="mx-1.5 text-slate-500">—</span>
                    {hasScore ? match.awayScore : "–"}
                  </div>
                  <div className="mt-1 text-[10px] font-mono uppercase tracking-wider text-slate-500">
                    {status === "LIVE" ? "Current score" : "Final score"}
                  </div>
                </>
              ) : (
                <>
                  <div className="font-mono text-xl font-extrabold text-white sm:text-2xl">
                    {formatKickoff(match.date)}
                  </div>
                  <div className="mt-1 text-[10px] font-mono uppercase tracking-wider text-slate-500">Kick-off</div>
                </>
              )}
            </div>
            <OverlayTeam logo={match.awayLogo} name={match.awayTeam} align="left" />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-white/[0.06] bg-black/25 px-3 py-2 text-xs font-mono text-slate-400">
            <span>
              Engine corner expectation:{" "}
              <strong className="text-slate-200">
                {match.predictedCorners.home.toFixed(1)} — {match.predictedCorners.away.toFixed(1)}
              </strong>
            </span>
            <span>
              Difference: <strong className="text-amber-200">{match.predictedCorners.difference.toFixed(1)}</strong>
            </span>
            {match.predictedCorners.strongerTeam && (
              <span>
                Strength edge: <strong className="text-cyan-200">{match.predictedCorners.strongerTeam}</strong>
              </span>
            )}
            <span>
              Real stats: <strong className="text-emerald-200">{match.statsSource}</strong>
            </span>
          </div>
        </header>

        {/* ── Ranked corner markets (scrollable) ───────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="match-overlay-title" className="text-lg font-extrabold tracking-tight text-white">
              Corner Markets
            </h2>
            <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
              {ranked.length} market{ranked.length === 1 ? "" : "s"} · ranked by hit rate
            </span>
          </div>

          <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur">
                <tr className="text-[10px] font-mono uppercase tracking-wider text-slate-500">
                  <th scope="col" className="px-3 py-2.5 font-semibold">#</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Market</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Selection</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-semibold">Hit rate</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Confidence</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((market, index) => (
                  <tr key={market.id} className="border-t border-white/[0.06] align-top transition-colors hover:bg-white/[0.03]">
                    <td className="px-3 py-3 font-mono text-xs text-slate-500">{index + 1}</td>
                    <td className="max-w-[340px] px-3 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${MARKET_TONES[market.marketType]}`}
                      >
                        {market.marketType}
                      </span>
                      <div className="mt-1.5 text-sm font-semibold text-slate-100">{market.name}</div>
                      <p className="mt-1 text-xs leading-relaxed text-slate-400">{market.reason}</p>
                    </td>
                    <td className="px-3 py-3">
                      <span className="inline-flex rounded-lg border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-sm font-bold text-amber-100">
                        {market.selection}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <span className="inline-flex rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 font-mono text-sm font-extrabold text-emerald-300">
                        {percentage(market.hitRate)}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${CONFIDENCE_STYLES[market.confidence]}`}
                      >
                        {market.confidence}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${OUTCOME_STYLES[marketOutcome(market)]}`}
                      >
                        {marketOutcome(market)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Sticky "Back to Fixture Cards" footer ────────────────────────── */}
        <footer className="shrink-0 border-t border-white/10 bg-slate-950/60 px-4 py-3 backdrop-blur-xl sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="hidden text-[11px] font-mono uppercase tracking-wider text-slate-500 sm:inline">
              Esc also closes
            </span>
            <button
              ref={backButtonRef}
              type="button"
              onClick={requestClose}
              className={`${NAV_PILL_PREMIUM} bg-gradient-to-br from-[#F59E0B] to-[#FF8C00] px-5 py-2.5 text-sm font-bold text-white shadow-[0_0_25px_-8px_rgba(245,158,11,0.55)] hover:brightness-110`}
            >
              ← Back to Fixture Cards
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function OverlayTeam({ logo, name, align }: { logo: string | null; name: string; align: "left" | "right" }) {
  return (
    <div className={`flex min-w-0 items-center gap-3 ${align === "right" ? "justify-end" : "justify-start"}`}>
      {align === "right" && (
        <span className="truncate text-right text-xl font-extrabold text-white sm:text-2xl">{name}</span>
      )}
      <TeamBadge logo={logo} name={name} size={38} />
      {align === "left" && (
        <span className="truncate text-xl font-extrabold text-white sm:text-2xl">{name}</span>
      )}
    </div>
  );
}
