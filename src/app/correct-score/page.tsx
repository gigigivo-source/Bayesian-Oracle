"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CARD_ACCENT_ORDER,
  CARD_GLASS,
  CARD_GLASS_SKIN,
  GLASS_PANEL,
  GLASS_TEXT_SHADOW,
} from "../_components/design";
import ScoreDetailOverlay, {
  qualityDot,
  qualityStyle,
  type CorrectScoreMatch,
} from "./components/ScoreDetailOverlay";

export const dynamic = "force-dynamic";

/** localStorage key for the Predictor Mode preference. */
const PREDICTOR_MODE_STORAGE_KEY = "correct-score:predictor-mode";

/**
 * A correct-score match enriched with the Monte Carlo market probabilities the
 * table view renders. The API serves these alongside the existing fields (see
 * `src/app/api/correct-score/route.ts`), so the table can read win–draw–win
 * probabilities and the Top-1 projected scoreline straight off the match.
 */
interface CorrectScoreMatchTableRow extends CorrectScoreMatch {
  homeWinProbability: number;
  drawProbability: number;
  awayWinProbability: number;
  projectedScoreline: string;
}

// ─── Icons (SVG only — the UI carries no emoji) ──────────────────────────────

function TargetIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RefreshIcon({ size = 14, spinning = false }: { size?: number; spinning?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={spinning ? "animate-spin" : ""}
      aria-hidden="true"
    >
      <path d="M21 2v6h-6" />
      <path d="M21 8a9 9 0 1 0-2.6 6.3" />
    </svg>
  );
}

function ChevronRight({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function FootballIcon({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7l3 2.2-1.2 3.6h-3.6L9 9.2z" />
      <path d="M12 7V4M9 13.5L6.2 16M15 13l3.5 1.6" />
    </svg>
  );
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatSimulations(count?: number): string {
  if (!count) return "Monte Carlo";
  return count >= 1000 ? `${Math.round(count / 1000)}k sims` : `${count} sims`;
}

/** Model badge text: Supercomputer when the historical model drove λ, else MC. */
function modelBadge(match: CorrectScoreMatch): string {
  if (match.modelBadge) return match.modelBadge;
  return `Monte Carlo (${formatSimulations(match.simulations)})`;
}

function ModelBadge({ match }: { match: CorrectScoreMatch }) {
  const badge = modelBadge(match).replace(/\p{Extended_Pictographic}/gu, "").trim();
  const supercomputer = badge.includes("Supercomputer");
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] font-bold ${
        supercomputer
          ? "border-violet-400/35 bg-violet-400/10 text-violet-200"
          : "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
      }`}
      title={`${match.model ?? "correct-score model"} · ${formatSimulations(match.simulations)}${
        typeof match.rho === "number" ? ` · Dixon-Coles ρ ${match.rho.toFixed(3)}` : ""
      }`}
    >
      {badge}
    </span>
  );
}

function MatchSkeleton() {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3 backdrop-blur-xl sm:p-4">
      <div className="h-3 w-16 animate-pulse rounded bg-slate-800" />
      <div className="mt-3 h-4 w-4/5 animate-pulse rounded bg-slate-800" />
      <div className="mt-1.5 h-4 w-3/5 animate-pulse rounded bg-slate-800" />
      <div className="mt-3 h-6 w-2/3 animate-pulse rounded bg-slate-800" />
      <div className="mt-3 h-4 w-1/2 animate-pulse rounded bg-slate-800" />
    </div>
  );
}

// ─── Compact fixture card ────────────────────────────────────────────────────

interface MatchCardProps {
  match: CorrectScoreMatch;
  /** Position in the list — drives the glass card accent cycle. */
  accentIndex: number;
  onOpen: () => void;
}

/**
 * Compact teaser. Shows only what fits at a glance: kickoff time, teams, the
 * projected scoreline (Top-1), its probability, a data-quality pill, a model
 * pill and a "details" affordance. Everything else lives in the overlay.
 */
function MatchCard({ match, accentIndex, onOpen }: MatchCardProps) {
  const accent = CARD_ACCENT_ORDER[accentIndex % CARD_ACCENT_ORDER.length];
  const top = match.topScorelines[0];
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Open the detailed analysis for ${match.homeTeam} vs ${match.awayTeam}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
          event.preventDefault();
          onOpen();
        }
      }}
      className={`group ${CARD_GLASS} ${CARD_GLASS_SKIN[accent]} ${GLASS_TEXT_SHADOW} cursor-pointer p-3 text-left sm:p-4`}
    >
      <div className="flex items-center justify-between gap-2">
        <time dateTime={match.date} className="font-mono text-xs font-bold text-slate-300">
          {formatTime(match.date)}
        </time>
        <ModelBadge match={match} />
      </div>

      <div className="mt-2 min-w-0 space-y-0.5">
        <div className="truncate text-sm font-bold text-white">{match.homeTeam}</div>
        <div className="truncate text-sm font-bold text-white">{match.awayTeam}</div>
      </div>

      <div className="mt-3 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-amber-200/90">
            <TargetIcon size={11} />
            Projected Scoreline
          </span>
          <div className="mt-0.5 font-mono text-xl font-black tracking-tight text-white sm:text-2xl">
            {top ? top.score : "—"}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-base font-extrabold text-amber-200">
            {top ? (top.probability * 100).toFixed(1) : "0.0"}%
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-slate-500">Probability</div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/[0.07] pt-2.5">
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold ${qualityStyle[match.dataQuality]}`}
          title={`${match.dataQuality} data`}
        >
          <span aria-hidden="true" className="text-[9px]">
            {qualityDot[match.dataQuality]}
          </span>
          {match.dataQuality}
        </span>
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400 transition group-hover:text-white">
          Details
          <ChevronRight size={12} className="text-slate-500 transition group-hover:text-amber-200" />
        </span>
      </div>
    </article>
  );
}

// ─── Match predictions table view ───────────────────────────────────────────

interface MatchPredictionsTableProps {
  matches: CorrectScoreMatchTableRow[];
  onOpen: (match: CorrectScoreMatchTableRow) => void;
}

/**
 * Squawka-style match predictions table. One row per fixture with the Monte
 * Carlo win–draw–win probabilities and the Top-1 projected scoreline. Every
 * row is clickable and reuses the same detail overlay as the compact cards.
 */
function MatchPredictionsTable({ matches, onOpen }: MatchPredictionsTableProps) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-700 bg-slate-900">
      <table className="w-full border-collapse text-sm text-white">
        <thead>
          <tr className="bg-slate-800/60 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">
            <th scope="col" className="px-4 py-3 text-left font-bold text-slate-300">
              Home Team
            </th>
            <th scope="col" className="px-4 py-3 text-center font-bold text-slate-300">
              Home Win %
            </th>
            <th scope="col" className="px-4 py-3 text-center font-bold text-slate-300">
              Draw %
            </th>
            <th scope="col" className="px-4 py-3 text-center font-bold text-slate-300">
              Away Win %
            </th>
            <th scope="col" className="px-4 py-3 text-right font-bold text-slate-300">
              Away Team
            </th>
            <th scope="col" className="px-4 py-3 text-center font-bold text-slate-300">
              Projected Scoreline
            </th>
          </tr>
        </thead>
        <tbody>
          {matches.map((match) => (
            <tr
              key={`${match.leagueSlug}:${match.fixtureId}`}
              aria-label={`Open the detailed analysis for ${match.homeTeam} vs ${match.awayTeam}`}
              tabIndex={0}
              onClick={() => onOpen(match)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
                  event.preventDefault();
                  onOpen(match);
                }
              }}
              className="cursor-pointer border-t border-slate-700/70 transition hover:bg-slate-800/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70"
            >
              <td className="px-4 py-3 text-left text-sm font-medium">{match.homeTeam}</td>
              <td className="px-4 py-3 text-center text-sm text-slate-200">
                {(match.homeWinProbability * 100).toFixed(1)}%
              </td>
              <td className="px-4 py-3 text-center text-sm text-slate-200">
                {(match.drawProbability * 100).toFixed(1)}%
              </td>
              <td className="px-4 py-3 text-center text-sm text-slate-200">
                {(match.awayWinProbability * 100).toFixed(1)}%
              </td>
              <td className="px-4 py-3 text-right text-sm font-medium">{match.awayTeam}</td>
              <td className="px-4 py-3 text-center text-sm font-bold text-amber-400">
                {match.projectedScoreline}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

function readWeekFromUrl(): number | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("matchweek");
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
}

function writeWeekToUrl(week: number | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (week === null) url.searchParams.delete("matchweek");
  else url.searchParams.set("matchweek", String(week));
  window.history.replaceState(null, "", url.toString());
}

/** Sorted, distinct match weeks carried by a feed, when the API omits them. */
function deriveMatchweeks(feed: CorrectScoreMatchTableRow[]): number[] {
  return [
    ...new Set(
      feed
        .map((match) => match.matchweek)
        .filter((week): week is number => typeof week === "number"),
    ),
  ].sort((left, right) => left - right);
}

export default function CorrectScorePage() {
  const [matches, setMatches] = useState<CorrectScoreMatchTableRow[]>([]);
  const [availableMatchweeks, setAvailableMatchweeks] = useState<number[]>([]);
  const [currentMatchweek, setCurrentMatchweek] = useState<number | null>(null);
  const [selectedMatchweek, setSelectedMatchweek] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Fixture whose detail overlay is open; `null` keeps the overlay unmounted. */
  const [selectedMatch, setSelectedMatch] = useState<CorrectScoreMatch | null>(null);
  // Predictor Mode: read once from localStorage at mount (same lazy-initialiser
  // pattern the rest of the app uses for persisted preferences), then persist
  // every change back so the choice survives a refresh.
  const [predictorMode, setPredictorMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(PREDICTOR_MODE_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  /** View mode: compact cards (default) or the match-predictions table. */
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const initialLoad = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (predictorMode) window.localStorage.setItem(PREDICTOR_MODE_STORAGE_KEY, "1");
      else window.localStorage.removeItem(PREDICTOR_MODE_STORAGE_KEY);
    } catch {
      // Storage failures are non-fatal; the toggle still works for the session.
    }
  }, [predictorMode]);

  const load = useCallback(async (week: number | null = null, refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (refresh) params.set("refresh", "true");
      if (week !== null) params.set("matchweek", String(week));
      const qs = params.toString();
      const response = await fetch(`/api/correct-score${qs ? `?${qs}` : ""}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as
        | CorrectScoreMatchTableRow[]
        | {
            matches?: CorrectScoreMatchTableRow[];
            availableMatchweeks?: number[];
            currentMatchweek?: number | null;
            selectedMatchweek?: number | null;
            message?: string;
            error?: string;
          };
      // Failure and empty-feed payloads are objects; a live feed is a bare array.
      if (!Array.isArray(body) && !Array.isArray(body.matches)) {
        throw new Error(!response.ok && body.error ? body.error : `HTTP ${response.status}`);
      }
      const feed = Array.isArray(body) ? body : (body.matches ?? []);
      setMatches(feed);
      const weeks = Array.isArray(body)
        ? deriveMatchweeks(feed)
        : (body.availableMatchweeks ?? deriveMatchweeks(feed));
      setAvailableMatchweeks(weeks);
      setCurrentMatchweek(
        !Array.isArray(body)
          ? (body.currentMatchweek ?? feed[0]?.matchweek ?? null)
          : (feed[0]?.matchweek ?? null),
      );
      setSelectedMatchweek(
        !Array.isArray(body) ? (body.selectedMatchweek ?? null) : null,
      );
      setNotice(!Array.isArray(body) && body.message ? body.message : null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load correct-score predictions.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (initialLoad.current) return;
    initialLoad.current = true;
    const urlWeek = readWeekFromUrl();
    setSelectedMatchweek(urlWeek);
    void load(urlWeek);
  }, [load]);

  const handleSelectWeek = useCallback(
    (week: number) => {
      setSelectedMatchweek(week);
      writeWeekToUrl(week);
      void load(week);
    },
    [load],
  );

  const activeWeek = selectedMatchweek ?? currentMatchweek;

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0F1117] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(6,182,212,0.12)_0%,_rgba(245,158,11,0.06)_34%,_#0F1117_70%)]"
      />
      <div aria-hidden="true" className="pointer-events-none absolute -right-24 top-12 h-72 w-72 rounded-full bg-cyan-500/10 blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute -left-24 top-96 h-72 w-72 rounded-full bg-amber-500/[0.08] blur-3xl" />

      <div className="relative mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-200">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.8)]" />
              England Premier League 2026/27 · eng.1 only · Next 7 days
            </div>
            <h1 className="bg-gradient-to-r from-white via-cyan-100 to-amber-200 bg-clip-text text-3xl font-black tracking-tight text-transparent sm:text-4xl">
              {predictorMode
                ? "Predictor Mode — Submit your exact score predictions"
                : "England Premier League Correct Score Predictions"}
            </h1>
            <p className="mt-2 text-sm text-slate-400 sm:text-base">
              {predictorMode
                ? "One projected scoreline per match, sized for quick entry"
                : "Most likely final scorelines, simulated 10,000 times per match from real historical results. Only England Premier League (eng.1) fixtures whose two clubs are in the 2026/27 division are shown — click any card for the full scoreline table and match analytics."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={predictorMode}
              onClick={() => setPredictorMode((current) => !current)}
              className="inline-flex items-center gap-2 rounded-full border border-amber-300/25 bg-white/[0.04] py-1.5 pl-2 pr-4 text-xs font-semibold text-slate-300 transition hover:bg-white/[0.09] hover:text-white"
            >
              <span
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                  predictorMode ? "bg-amber-400" : "bg-slate-600"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    predictorMode ? "translate-x-[1.15rem]" : "translate-x-0.5"
                  }`}
                />
              </span>
              <span className="inline-flex items-center gap-1.5">
                <TargetIcon size={13} />
                {predictorMode ? "Predictor Mode" : "Full Analysis"}
              </span>
            </button>
            <div
              role="group"
              aria-label="Match predictions view"
              className="inline-flex items-center rounded-full border border-white/[0.08] bg-white/[0.04] p-1"
            >
              {(["cards", "table"] as const).map((mode) => {
                const active = viewMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setViewMode(mode)}
                    className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-bold transition ${
                      active
                        ? "bg-gradient-to-r from-[#F59E0B] to-[#FF8C00] text-white shadow-[0_0_16px_-6px_rgba(245,158,11,0.6)]"
                        : "text-slate-300 hover:bg-white/[0.09] hover:text-white"
                    }`}
                  >
                    {mode === "cards" ? "Cards" : "Table"}
                  </button>
                );
              })}
            </div>
            <Link
              href="/"
              className="inline-flex items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/[0.09] hover:text-white"
            >
              ← Oracle
            </Link>
            <Link
              href="/correct-score/backtest"
              className="inline-flex items-center rounded-full border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-400/[0.15]"
            >
              View Backtest
            </Link>
            <button
              type="button"
              onClick={() => void load(selectedMatchweek, true)}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-full border border-amber-300/25 bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-xs font-bold text-white shadow-[0_0_20px_-7px_rgba(245,158,11,0.65)] transition hover:scale-[1.03] disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshIcon size={14} spinning={refreshing} />
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </header>

        {/* ── Match week chips ── */}
        {availableMatchweeks.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
              Matchweek
            </span>
            {availableMatchweeks.map((week) => {
              const active = activeWeek === week;
              return (
                <button
                  key={week}
                  type="button"
                  onClick={() => handleSelectWeek(week)}
                  aria-pressed={active}
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-bold transition ${
                    active
                      ? "border-transparent bg-gradient-to-r from-[#F59E0B] to-[#FF8C00] text-white shadow-[0_0_16px_-6px_rgba(245,158,11,0.6)]"
                      : "border-white/[0.08] bg-white/[0.04] text-slate-300 hover:bg-white/[0.09] hover:text-white"
                  }`}
                >
                  {week}
                </button>
              );
            })}
          </div>
        )}

        <div className={`space-y-2 rounded-2xl p-4 text-xs text-slate-400 ${GLASS_PANEL}`}>
          <p>
            <span className="font-semibold text-slate-200">Supercomputer stack.</span> Expected goals come from
            venue-split attack/defence strengths built on the last three seasons of results, modulated by each
            team&apos;s ELO rating (1500 start; K = 20 friendly / 30 league / 30 cup). The score grid is corrected
            for low-score dependence with a Dixon-Coles ρ estimated from the same history, then sampled by
            Monte Carlo simulation — the top ten scorelines are read off the simulation, not the analytic grid.
          </p>
          <p>
            <span className="font-semibold text-slate-200">Legacy blend.</span> The previous xG-weighted composite
            (xG 40%, season scoring 25%, opponent goals conceded 20%, form 10%, venue advantage 5%) still
            contributes 40% of λ when real pre-match xG is available. Missing inputs are reweighted; a fixture
            with no historical model falls back to that competition&apos;s observed league baseline and is badged
            Monte Carlo instead of Supercomputer.
          </p>
        </div>

        {error && (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5 text-sm text-rose-200">
            <div className="font-bold">Correct Score Predictions are temporarily unavailable</div>
            <p className="mt-1 text-rose-200/70">{error}</p>
            <button
              type="button"
              onClick={() => void load(selectedMatchweek)}
              className="mt-3 rounded-full border border-rose-400/30 px-4 py-2 text-xs font-bold transition hover:bg-rose-400/10"
            >
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => <MatchSkeleton key={index} />)}
          </div>
        ) : matches.length ? (
          <>
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>
                {matches.length} {matches.length === 1 ? "match" : "matches"}
                {selectedMatchweek !== null ? ` · Matchweek ${selectedMatchweek}` : ""}
              </span>
              <span>Probabilities are model estimates, not guarantees.</span>
            </div>
            {viewMode === "table" ? (
              <MatchPredictionsTable matches={matches} onOpen={(match) => setSelectedMatch(match)} />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {matches.map((match, index) => (
                  <MatchCard
                    key={`${match.leagueSlug}:${match.fixtureId}`}
                    match={match}
                    accentIndex={index}
                    onOpen={() => setSelectedMatch(match)}
                  />
                ))}
              </div>
            )}
          </>
        ) : !error ? (
          <div className={`rounded-3xl p-10 text-center ${GLASS_PANEL}`}>
            <div className="mx-auto w-fit rounded-2xl border border-slate-700/70 bg-slate-800/60 p-4 text-slate-400">
              <FootballIcon />
            </div>
            <h2 className="mt-3 text-lg font-bold text-white">
              {notice ??
                (availableMatchweeks.length === 0
                  ? "No match week data available"
                  : selectedMatchweek !== null
                    ? `No fixtures available for Matchweek ${selectedMatchweek}`
                    : "No England Premier League fixtures found")}
            </h2>
            {!notice && (
              <p className="mx-auto mt-1 max-w-xl text-sm text-slate-500">
                {selectedMatchweek !== null && currentMatchweek !== null && selectedMatchweek > currentMatchweek
                  ? `Fixtures for Matchweek ${selectedMatchweek} will be available closer to the match date.`
                  : "Only England Premier League (eng.1) fixtures from the 2026/27 season are published here. The seven-day fixture feed is currently empty for that competition — try refreshing shortly."}
              </p>
            )}
          </div>
        ) : null}
      </div>

      {/* ── Detail overlay: reuses the match already in memory, no new fetch ── */}
      {selectedMatch ? (
        <ScoreDetailOverlay match={selectedMatch} onClose={() => setSelectedMatch(null)} />
      ) : null}
    </main>
  );
}
