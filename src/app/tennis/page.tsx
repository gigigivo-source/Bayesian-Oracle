"use client";

// ĞIGI GIVØ — Tennis Predictions (ATP / WTA).
//
// The second sport of the supercomputer: upcoming singles matches priced by
// the surface-modified ELO model (clay 1.1× / grass 1.3× / hard 1.0×) through
// the exact set-score distribution. Every card carries the Match Winner
// probability, Total Games O/U, Set Winner markets, the projected scoreline
// and the serve-stat markets (Aces, Double Faults, Break Points) built from
// the players' real per-match baselines.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TennisPrediction } from "@/lib/engine/markets";
import {
  CARD_ACCENT_ORDER,
  CARD_GLASS,
  CARD_GLASS_SKIN,
  CHIP,
  CHIP_ON_AMBER,
  CHIP_ON_CYAN,
  GLASS_TEXT_SHADOW,
  NAV_PILL,
  NAV_PILL_OFF,
  NAV_PILL_PREMIUM,
  NAV_PILL_PREMIUM_OFF,
  NAV_PILL_PREMIUM_ON,
  OUTLINE_NEUTRAL,
} from "../_components/design";

// ─── Types (page-local mirror of /api/tennis/predictions) ────────────────────

type Surface = "clay" | "grass" | "hard" | "carpet";
type Tour = "atp" | "wta";

interface PredictedPlayer {
  name: string;
  country: string | null;
  rating: number;
  ratingSource: "elo" | "rank-prior" | "default";
  matchesPlayed: number | null;
  rank: number | null;
  acesPerMatch: number | null;
  doubleFaultsPerMatch: number | null;
  bpFacedPerMatch: number | null;
  baselineSource: "surface" | "overall" | "tour-baseline" | "none";
}

interface PredictedMatch {
  id: string;
  tour: Tour;
  tournament: string;
  surface: Surface | null;
  round: string | null;
  date: string;
  venue: string | null;
  status: "scheduled" | "live" | "complete";
  bestOf: 3 | 5;
  players: [PredictedPlayer, PredictedPlayer];
  prediction: TennisPrediction;
}

interface TennisResponse {
  generatedAt: string;
  filters: { surface: string | null; tour: string; limit: number; days: number };
  ratings: Record<
    string,
    {
      asOf: string | null;
      matchesProcessed: number;
      playersRated: number;
    } | undefined
  >;
  sources: Array<{ tour?: string; source: string; ok?: boolean; attempted?: boolean; added?: number; note: string }>;
  count: number;
  matches: PredictedMatch[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SURFACE_STYLES: Record<Surface, { label: string; badge: string; dot: string }> = {
  clay: { label: "Clay", badge: "bg-orange-500/15 text-orange-300 ring-1 ring-orange-400/40", dot: "bg-orange-400" },
  grass: { label: "Grass", badge: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/40", dot: "bg-emerald-400" },
  hard: { label: "Hard", badge: "bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-400/40", dot: "bg-cyan-400" },
  carpet: { label: "Carpet", badge: "bg-slate-500/15 text-slate-300 ring-1 ring-slate-400/40", dot: "bg-slate-400" },
};

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pctLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

function formatDayLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const key = date.toISOString().slice(0, 10);
  const base = new Intl.DateTimeFormat("en", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(date);
  if (key === today.toISOString().slice(0, 10)) return `Today · ${base}`;
  if (key === tomorrow.toISOString().slice(0, 10)) return `Tomorrow · ${base}`;
  return base;
}

function ratingBadge(source: PredictedPlayer["ratingSource"]): string | null {
  if (source === "elo") return null;
  if (source === "rank-prior") return "rank prior";
  return "unrated";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Horizontal over/under split bar with the two labelled sides. */
function SplitBar({
  leftLabel,
  leftProb,
  rightLabel,
  rightProb,
}: {
  leftLabel: string;
  leftProb: number;
  rightLabel: string;
  rightProb: number;
}) {
  const leftPct = Math.max(2, Math.min(98, leftProb * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px] font-mono">
        <span className={leftProb >= 0.5 ? "font-bold text-amber-300" : "text-slate-400"}>
          {leftLabel} {pctLabel(leftProb)}
        </span>
        <span className={rightProb >= 0.5 ? "font-bold text-amber-300" : "text-slate-400"}>
          {pctLabel(rightProb)} {rightLabel}
        </span>
      </div>
      <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full bg-gradient-to-r from-[#F59E0B] to-[#FF8C00] transition-all"
          style={{ width: `${leftPct}%` }}
        />
        <div className="h-full flex-1 bg-slate-700/70" />
      </div>
    </div>
  );
}

function MarketSection({
  title,
  accent,
  children,
}: {
  title: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-slate-950/40 p-3">
      <div className={`mb-2 text-[10px] font-mono font-bold uppercase tracking-widest ${accent}`}>
        {title}
      </div>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

/** One upcoming match with every market family of the tennis engine. */
function TennisMatchCard({ match, accentIndex }: { match: PredictedMatch; accentIndex: number }) {
  const [playerA, playerB] = match.players;
  const prediction = match.prediction;
  const surface = match.surface ? SURFACE_STYLES[match.surface] : null;
  const accent = CARD_ACCENT_ORDER[accentIndex % CARD_ACCENT_ORDER.length];
  const isLive = match.status === "live";

  const winner = prediction.matchWinner;
  const favoriteIsA = winner.probA >= winner.probB;

  return (
    <article className={`${CARD_GLASS} ${CARD_GLASS_SKIN[accent]} ${GLASS_TEXT_SHADOW} p-4 sm:p-5`}>
      {/* ── Header: tournament / round / date / badges ── */}
      <header className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-slate-300">
              {match.tour.toUpperCase()}
            </span>
            {surface && (
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${surface.badge}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${surface.dot}`} aria-hidden="true" />
                {surface.label}
              </span>
            )}
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Bo{match.bestOf}
            </span>
            {isLive && (
              <span className="animate-pulse rounded-full bg-rose-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-300 ring-1 ring-rose-400/40">
                ● Live
              </span>
            )}
          </div>
          <h3 className="mt-1.5 truncate text-base font-bold text-white">
            {match.tournament}
            {match.round ? <span className="font-normal text-slate-400"> · {match.round}</span> : null}
          </h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {formatDate(match.date)}
            {match.venue ? ` · ${match.venue}` : ""}
          </p>
        </div>

        {/* Projected scoreline */}
        <div className="shrink-0 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2 text-center">
          <div className="text-[9px] font-mono font-bold uppercase tracking-widest text-amber-300/80">
            Projected score
          </div>
          <div className="font-mono text-xl font-extrabold leading-tight text-white">
            {prediction.projectedScoreline}
          </div>
          <div className="text-[10px] text-slate-400">
            {prediction.projectedWinner} · {pct(prediction.projectedScorelineProb)}
          </div>
        </div>
      </header>

      {/* ── Players + Match Winner probability ── */}
      <div className="mb-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4">
        <div className="min-w-0 text-right">
          <div className="truncate text-sm font-bold text-white">
            {playerA.name}
            {favoriteIsA && <span className="ml-1.5 text-amber-400" aria-label="favourite">★</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center justify-end gap-1.5 text-[10px] text-slate-500">
            {playerA.country && <span className="font-mono">{playerA.country}</span>}
            {playerA.rank !== null && <span className="font-mono">#{playerA.rank}</span>}
            <span className="font-mono" title={`ELO ${playerA.rating} (${playerA.ratingSource})`}>
              ELO {playerA.rating}
            </span>
            {ratingBadge(playerA.ratingSource) && (
              <span className="rounded bg-slate-800 px-1 py-px text-[9px] uppercase tracking-wide text-slate-400">
                {ratingBadge(playerA.ratingSource)}
              </span>
            )}
          </div>
        </div>
        <div className="text-center">
          <div className="font-mono text-2xl font-extrabold text-white">
            {pctLabel(winner.probA)}
            <span className="mx-1 text-sm text-slate-500">/</span>
            {pctLabel(winner.probB)}
          </div>
          <div className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
            match winner
          </div>
        </div>
        <div className="min-w-0 text-left">
          <div className="truncate text-sm font-bold text-white">
            {favoriteIsA ? "" : <span className="mr-1.5 text-amber-400" aria-label="favourite">★</span>}
            {playerB.name}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
            {playerB.country && <span className="font-mono">{playerB.country}</span>}
            {playerB.rank !== null && <span className="font-mono">#{playerB.rank}</span>}
            <span className="font-mono" title={`ELO ${playerB.rating} (${playerB.ratingSource})`}>
              ELO {playerB.rating}
            </span>
            {ratingBadge(playerB.ratingSource) && (
              <span className="rounded bg-slate-800 px-1 py-px text-[9px] uppercase tracking-wide text-slate-400">
                {ratingBadge(playerB.ratingSource)}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="mb-4">
        <SplitBar
          leftLabel={playerA.name}
          leftProb={winner.probA}
          rightLabel={playerB.name}
          rightProb={winner.probB}
        />
        <div className="mt-1.5 flex items-center justify-between text-[10px] font-mono text-slate-500">
          <span>
            fair odds {playerA.name.split(" ").pop()}: {winner.fairOddsA.toFixed(2)}
          </span>
          <span>
            {playerB.name.split(" ").pop()}: {winner.fairOddsB.toFixed(2)}
          </span>
        </div>
      </div>

      {/* ── Market families ── */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <MarketSection title="Total Games O/U" accent="text-cyan-300">
          <div className="text-[11px] font-mono text-slate-400">
            Expected total: <span className="font-bold text-white">{prediction.totalGames.expected.toFixed(1)}</span> games
          </div>
          {prediction.totalGames.lines.map((line) => (
            <SplitBar
              key={line.line}
              leftLabel={`Over ${line.line.toFixed(1)}`}
              leftProb={line.overProb}
              rightLabel={`Under ${line.line.toFixed(1)}`}
              rightProb={line.underProb}
            />
          ))}
        </MarketSection>

        <MarketSection title="Set Winner" accent="text-violet-300">
          <div className="text-[11px] font-mono text-slate-400">Set 1 winner</div>
          <SplitBar
            leftLabel={playerA.name.split(" ").pop() ?? "A"}
            leftProb={prediction.setWinner.set1ProbA}
            rightLabel={playerB.name.split(" ").pop() ?? "B"}
            rightProb={prediction.setWinner.set1ProbB}
          />
          <div className="flex flex-wrap gap-1.5 pt-1">
            {prediction.setWinner.setBetting.map((betting) => (
              <span
                key={betting.score}
                className="rounded-md bg-slate-800/80 px-2 py-1 font-mono text-[10px] text-slate-300"
                title={`${prediction.players.a}–${prediction.players.b} set betting`}
              >
                <span className="font-bold text-white">{betting.score}</span>{" "}
                {pct(betting.prob)}
              </span>
            ))}
          </div>
        </MarketSection>

        <MarketSection title="Aces O/U" accent="text-emerald-300">
          {prediction.aces === null ? (
            <div className="text-[11px] text-slate-500">No serve baselines available.</div>
          ) : (
            prediction.aces.map((group) => (
              <div key={group.scope}>
                <div className="text-[10px] font-mono text-slate-500">
                  {group.scope} · λ {group.expected?.toFixed(1)} ({group.basis})
                </div>
                {group.lines.map((line) => (
                  <SplitBar
                    key={`${group.scope}-${line.line}`}
                    leftLabel={`O ${line.line.toFixed(1)}`}
                    leftProb={line.overProb}
                    rightLabel={`U ${line.line.toFixed(1)}`}
                    rightProb={line.underProb}
                  />
                ))}
              </div>
            ))
          )}
        </MarketSection>

        <MarketSection title="Double Faults & Break Points" accent="text-rose-300">
          {prediction.doubleFaults === null && prediction.breakPoints === null ? (
            <div className="text-[11px] text-slate-500">No serve baselines available.</div>
          ) : (
            <>
              {prediction.doubleFaults?.map((group) => (
                <div key={`df-${group.scope}`}>
                  <div className="text-[10px] font-mono text-slate-500">
                    DF · {group.scope} · λ {group.expected?.toFixed(1)}
                  </div>
                  {group.lines.map((line) => (
                    <SplitBar
                      key={`df-${group.scope}-${line.line}`}
                      leftLabel={`O ${line.line.toFixed(1)}`}
                      leftProb={line.overProb}
                      rightLabel={`U ${line.line.toFixed(1)}`}
                      rightProb={line.underProb}
                    />
                  ))}
                </div>
              ))}
              {prediction.breakPoints?.map((group) => (
                <div key={`bp-${group.scope}`}>
                  <div className="text-[10px] font-mono text-slate-500">
                    Break points · {group.scope} · λ {group.expected?.toFixed(1)}
                  </div>
                  {group.lines.map((line) => (
                    <SplitBar
                      key={`bp-${group.scope}-${line.line}`}
                      leftLabel={`O ${line.line.toFixed(1)}`}
                      leftProb={line.overProb}
                      rightLabel={`U ${line.line.toFixed(1)}`}
                      rightProb={line.underProb}
                    />
                  ))}
                </div>
              ))}
            </>
          )}
        </MarketSection>
      </div>

      {/* ── Most likely scorelines ── */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
          Top scorelines
        </span>
        {prediction.scorelineTop.slice(0, 4).map((entry) => (
          <span
            key={`${entry.scoreline}-${entry.winner}`}
            className="rounded-md border border-white/[0.06] bg-slate-900/60 px-2 py-0.5 font-mono text-[10px] text-slate-300"
            title={`${entry.winner} to win`}
          >
            {entry.scoreline} <span className="text-slate-500">{pct(entry.prob)}</span>
          </span>
        ))}
      </div>
    </article>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TOUR_FILTERS: Array<{ id: "both" | Tour; label: string }> = [
  { id: "both", label: "ATP + WTA" },
  { id: "atp", label: "ATP" },
  { id: "wta", label: "WTA" },
];

const SURFACE_FILTERS: Array<{ id: "" | Surface; label: string }> = [
  { id: "", label: "All surfaces" },
  { id: "hard", label: "Hard" },
  { id: "clay", label: "Clay" },
  { id: "grass", label: "Grass" },
];

export default function TennisPage() {
  const [tour, setTour] = useState<"both" | Tour>("both");
  const [surface, setSurface] = useState<"" | Surface>("");
  const [data, setData] = useState<TennisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchSeq = useRef(0);

  const load = useCallback(async (tourFilter: "both" | Tour, surfaceFilter: "" | Surface) => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        tour: tourFilter,
        limit: "60",
        days: "4",
        includeLive: "1",
      });
      if (surfaceFilter) params.set("surface", surfaceFilter);
      const response = await fetch(`/api/tennis/predictions?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as TennisResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      if (seq !== fetchSeq.current) return; // a newer filter change superseded this fetch
      setData(payload);
    } catch (reason) {
      if (seq !== fetchSeq.current) return;
      setError(reason instanceof Error ? reason.message : "Unable to load tennis predictions.");
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, []);

  // Fetch once per filter combination. The ref guard keeps the effect from
  // re-firing on re-renders (the established pattern on the other pages) and
  // only a genuine filter change triggers a new load.
  const loadedFiltersRef = useRef("");
  useEffect(() => {
    const filterKey = `${tour}|${surface}`;
    if (loadedFiltersRef.current === filterKey) return;
    loadedFiltersRef.current = filterKey;
    void load(tour, surface);
  }, [load, tour, surface]);

  // Group matches by UTC day.
  const grouped = useMemo(() => {
    if (!data?.matches) return [];
    const groups = new Map<string, PredictedMatch[]>();
    for (const match of data.matches) {
      const key = match.date.slice(0, 10);
      const list = groups.get(key) ?? [];
      list.push(match);
      groups.set(key, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  const ratedTours = data ? Object.keys(data.ratings ?? {}) : [];

  return (
    <main className="min-h-screen bg-[#05070d] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* ── Header ── */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className={`${CHIP} ${CHIP_ON_AMBER} mb-3 inline-flex px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider`}>
              🎾 ATP / WTA · surface-modified ELO
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              Tennis Predictions
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400 sm:text-base">
              Upcoming singles matches priced by the tennis supercomputer: ELO
              with surface modifiers (clay 1.1×, grass 1.3×, hard 1.0×), an
              exact set-score model for Total Games and Set Winner markets, and
              Poisson serve-stat markets (Aces, Double Faults, Break Points)
              from each player&apos;s real baseline.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/" className={`${NAV_PILL} ${NAV_PILL_OFF} px-3 py-2 text-xs font-semibold`}>
              ← Oracle
            </Link>
            <button
              type="button"
              onClick={() => void load(tour, surface)}
              disabled={loading}
              className={`${OUTLINE_NEUTRAL} inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-xs font-semibold hover:bg-white/10 disabled:opacity-60`}
              aria-label="Refresh tennis predictions"
            >
              {loading ? (
                <>
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-400 border-t-white" />
                  Loading…
                </>
              ) : (
                <>🔄 Refresh</>
              )}
            </button>
          </div>
        </div>

        {/* ── Filters ── */}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
          {TOUR_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => setTour(filter.id)}
              aria-pressed={tour === filter.id}
              className={`${NAV_PILL_PREMIUM} px-3.5 py-2 text-xs ${tour === filter.id ? NAV_PILL_PREMIUM_ON : NAV_PILL_PREMIUM_OFF}`}
            >
              {filter.label}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-white/10" aria-hidden="true" />
          {SURFACE_FILTERS.map((filter) => (
            <button
              key={filter.id || "all"}
              type="button"
              onClick={() => setSurface(filter.id)}
              aria-pressed={surface === filter.id}
              className={`${NAV_PILL_PREMIUM} px-3.5 py-2 text-xs ${surface === filter.id ? NAV_PILL_PREMIUM_ON : NAV_PILL_PREMIUM_OFF}`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {/* ── Data status ── */}
        <div className={`rounded-xl border px-4 py-3 text-sm ${error ? "border-rose-500/30 bg-rose-500/10 text-rose-200" : data ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-white/10 bg-white/[0.03] text-slate-400"}`} role="status">
          {error ? "🔴 Data unavailable: Tennis predictions are currently unavailable." : data ? "🟢 Data loaded: real ATP/WTA historical data" : "Loading real tennis data…"}
        </div>

        {/* ── Status line ── */}
        {data && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono text-slate-500">
            <span>
              {data.count} match{data.count === 1 ? "" : "es"}
              {data.filters.surface ? ` on ${data.filters.surface}` : ""}
            </span>
            {ratedTours.map((tourKey) => (
              <span key={tourKey}>
                {tourKey.toUpperCase()}: {data.ratings[tourKey]?.playersRated ?? 0} players rated
                {" · "}
                {data.ratings[tourKey]?.matchesProcessed ?? 0} matches
              </span>
            ))}
            <span>updated {new Date(data.generatedAt).toUTCString().slice(5, 22)} UTC</span>
          </div>
        )}

        {/* ── Error ── */}
        {error && (
          <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200" role="alert">
            Tennis predictions are currently unavailable. Please check back later.
          </div>
        )}

        {/* ── Loading skeleton ── */}
        {loading && !data && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="animate-pulse rounded-2xl border border-white/[0.06] bg-slate-900/50 p-5">
                <div className="mb-4 flex justify-between">
                  <div className="h-4 w-40 rounded bg-slate-800" />
                  <div className="h-10 w-24 rounded bg-slate-800" />
                </div>
                <div className="mb-4 flex items-center justify-between">
                  <div className="h-3.5 w-28 rounded bg-slate-800" />
                  <div className="h-7 w-16 rounded bg-slate-800" />
                  <div className="h-3.5 w-28 rounded bg-slate-800" />
                </div>
                <div className="space-y-2">
                  <div className="h-1.5 w-full rounded bg-slate-800" />
                  <div className="h-1.5 w-full rounded bg-slate-800" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Matches by day ── */}
        {!loading && !error && grouped.length === 0 && (
          <div className="rounded-2xl border border-white/[0.08] bg-slate-900/40 p-8 text-center">
            <div className="text-3xl" aria-hidden="true">🎾</div>
            <h2 className="mt-3 text-lg font-bold text-white">
              No upcoming {surface ? SURFACE_STYLES[surface].label.toLowerCase() : ""} matches
              {tour === "both" ? "" : ` on the ${tour.toUpperCase()} tour`}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
              The ESPN singles scoreboard has no scheduled matches in the next
              few days for this filter. Try another surface or tour — or check
              back after the next draw release.
            </p>
            {data && data.sources.length > 0 && (
              <details className="mx-auto mt-4 max-w-lg text-left">
                <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-widest text-slate-500">
                  Data source status
                </summary>
                <ul className="mt-2 space-y-1 text-[11px] font-mono text-slate-500">
                  {data.sources.slice(0, 10).map((source, i) => (
                    <li key={`${source.source}-${i}`}>
                      {source.tour ? `${source.tour}: ` : ""}
                      {source.source} — {source.note}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {grouped.map(([day, matches]) => (
          <section key={day} aria-label={formatDayLabel(day)}>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-sm font-bold text-white">{formatDayLabel(`${day}T00:00:00Z`)}</h2>
              <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] text-slate-400">
                {matches.length}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {matches.map((match, i) => (
                <TennisMatchCard key={match.id} match={match} accentIndex={i} />
              ))}
            </div>
          </section>
        ))}

        {/* ── Footer ── */}
        <footer className="border-t border-white/[0.06] pt-4 text-[11px] leading-relaxed text-slate-500">
          <p>
            Model: surface-modified ELO (clay 1.1×, grass 1.3×, hard 1.0×) →
            per-set and per-game win probabilities → exact set-score
            distribution for Total Games, Set Winner and projected scorelines.
            Aces, double faults and break-point lines are Poisson markets on
            real per-match baselines (surface split where the sample backs it).
            Ratings without replayed history use a labelled rank prior — never
            an invented number.
          </p>
          <p className="mt-2">
            Data: Jeff Sackmann tennis_atp / tennis_wta match logs (GitHub
            mirrors), tennis-data.co.uk results &amp; odds files, and the ESPN
            tennis scoreboard for fixtures. Predictions are probabilistic
            estimates, not guarantees.
          </p>
        </footer>
      </div>
    </main>
  );
}
