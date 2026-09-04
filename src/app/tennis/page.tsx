"use client";

// ĞIGI GIVØ — Tennis Predictions (ATP / WTA).
//
// The second sport of the supercomputer: upcoming singles matches priced by the
// surface-specific ELO model (elo_clay / elo_grass / elo_hard) pushed through
// the exact point-by-point service-game → set → match dynamic program.
//
// The page is deliberately dumb about data: it renders exactly what
// /api/tennis/predictions returns, shows the 🟢/🔴 data-status badge, and when
// the API refuses (503 / `error`) it shows the error state and nothing else —
// no placeholder cards, no TBD players, no default scorelines.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CARD_ACCENT_ORDER,
  CARD_GLASS,
  CARD_GLASS_SKIN,
  CHIP,
  CHIP_ON_AMBER,
  GLASS_TEXT_SHADOW,
  NAV_PILL,
  NAV_PILL_OFF,
  NAV_PILL_PREMIUM,
  NAV_PILL_PREMIUM_OFF,
  NAV_PILL_PREMIUM_ON,
  OUTLINE_NEUTRAL,
} from "../_components/design";

// ─── Types (page-local mirror of /api/tennis/predictions) ────────────────────

type Surface = "clay" | "grass" | "hard";
type Tour = "atp" | "wta";
type DataQuality = "real" | "mixed" | "synthetic";

interface PredictedPlayer {
  name: string;
  country: string | null;
  elo: number;
  eloBySurface: Record<Surface, number | null>;
  surfaceMatches: number;
  matchesPlayed: number | null;
  rank: number | null;
  serveWinRate: number | null;
  returnWinRate: number | null;
  acesPerMatch: number | null;
  doubleFaultsPerMatch: number | null;
  bpFacedPerMatch: number | null;
  baselineSource: "surface" | "overall" | "none";
}

interface TennisLine {
  line: number;
  overProb: number;
  underProb: number;
}

interface LineGroup {
  expected: number;
  probabilities: Record<string, number>;
  lines: TennisLine[];
  basis: string;
}

interface CountSide extends LineGroup {
  scope: "home" | "away";
}

interface PredictedMatch {
  id: string;
  tour: Tour;
  tournament: string;
  round: string | null;
  surface: Surface;
  bestOf: 3 | 5;
  date: string;
  venue: string | null;
  status: "scheduled" | "live" | "complete";
  dataQuality: DataQuality;
  home: PredictedPlayer;
  away: PredictedPlayer;
  matchWinner: {
    home: number;
    away: number;
    fairOddsHome: number;
    fairOddsAway: number;
    favourite: string;
    eloHome: number;
    eloAway: number;
    surfaceEloHome: number;
    surfaceEloAway: number;
  };
  totalGames: LineGroup;
  setWinner: {
    sets: Array<{ set: number; home: number; away: number }>;
    setBetting: Array<{ score: string; prob: number }>;
  };
  scoreDistribution: Record<string, number>;
  projectedScoreline: string;
  projectedScorelineHomeFirst: string;
  projectedWinner: string;
  topScorelines: Array<{ score: string; prob: number; winner: string }>;
  aces: { home: CountSide; away: CountSide } | null;
  doubleFaults: { home: CountSide; away: CountSide } | null;
  model: {
    mode: "serve-elo" | "elo-only";
    pointProbHomeServe: number | null;
    pointProbAwayServe: number | null;
    holdHome: number | null;
    holdAway: number | null;
    setProbHome: number;
    shift: number | null;
  };
  notes: string[];
}

interface TourStatus {
  ok: boolean;
  matches: number;
  playersRated: number;
  matchesRated: number;
  asOf: string | null;
  fixtures: number | null;
  error: string | null;
  sources: Array<{ source: string; url: string; ok: boolean; parsed: number; added: number; note: string }>;
}

interface TennisResponse {
  generatedAt: string;
  filters: { surface: string | null; tour: string; limit: number; days: number };
  dataStatus: Record<string, TourStatus | undefined>;
  count: number;
  total: number;
  matches: PredictedMatch[];
  unavailable: Array<{
    tournament: string;
    home: string;
    away: string;
    eloHome: number | null;
    eloAway: number | null;
    reason: string;
  }>;
  unavailableCount: number;
  error?: string;
  details?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SURFACE_STYLES: Record<Surface, { label: string; badge: string; dot: string }> = {
  clay: { label: "Clay", badge: "bg-orange-500/15 text-orange-300 ring-1 ring-orange-400/40", dot: "bg-orange-400" },
  grass: { label: "Grass", badge: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/40", dot: "bg-emerald-400" },
  hard: { label: "Hard", badge: "bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-400/40", dot: "bg-cyan-400" },
};

const QUALITY_STYLES: Record<DataQuality, { label: string; badge: string }> = {
  real: { label: "Real", badge: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/40" },
  mixed: { label: "Mixed", badge: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/40" },
  synthetic: { label: "Synthetic", badge: "bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/40" },
};

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pctLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function num(value: number, dp = 1): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(dp);
}

function rate(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 1000) / 10}%`;
}

function shortName(name: string): string {
  return name.split(" ").slice(-1)[0] ?? name;
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

function PlayerRail({
  player,
  side,
  favourite,
  winProb,
}: {
  player: PredictedPlayer;
  side: "home" | "away";
  favourite: boolean;
  winProb: number;
}) {
  const align = side === "home" ? "text-right" : "text-left";
  return (
    <div className={`min-w-0 ${align}`}>
      <div className="truncate text-sm font-bold text-white">
        {side === "home" ? (
          <>
            {player.name}
            {favourite && <span className="ml-1.5 text-amber-400" aria-label="favourite">★</span>}
          </>
        ) : (
          <>
            {favourite && <span className="mr-1.5 text-amber-400" aria-label="favourite">★</span>}
            {player.name}
          </>
        )}
      </div>
      <div
        className={`mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500 ${
          side === "home" ? "justify-end" : ""
        }`}
      >
        {player.country && <span className="font-mono">{player.country}</span>}
        {player.rank !== null && <span className="font-mono">#{player.rank}</span>}
        <span
          className="font-mono text-slate-300"
          title={`ELO ${player.elo} on this surface — ${player.surfaceMatches} rated matches`}
        >
          ELO {player.elo}
        </span>
        <span className="font-mono" title="Match win probability">
          {pctLabel(winProb)}
        </span>
      </div>
      <div
        className={`mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500 ${
          side === "home" ? "justify-end" : ""
        }`}
      >
        <span title="Points won on serve / points played on serve">
          serve {rate(player.serveWinRate)}
        </span>
        <span title="Return points won / return points played">
          return {rate(player.returnWinRate)}
        </span>
      </div>
    </div>
  );
}

function CountMarket({
  title,
  accent,
  home,
  away,
  homeName,
  awayName,
}: {
  title: string;
  accent: string;
  home: CountSide | null;
  away: CountSide | null;
  homeName: string;
  awayName: string;
}) {
  if (!home || !away) {
    return (
      <MarketSection title={title} accent={accent}>
        <div className="text-[11px] text-slate-500">
          Not priced — no real {title.toLowerCase()} baseline for one of these players in the
          loaded dataset.
        </div>
      </MarketSection>
    );
  }
  return (
    <MarketSection title={title} accent={accent}>
      {[home, away].map((group) => (
        <div key={group.scope}>
          <div className="text-[10px] font-mono text-slate-500">
            {group.scope === "home" ? homeName : awayName} · λ {num(group.expected)} ({group.basis})
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
      ))}
    </MarketSection>
  );
}

/** One upcoming match with every market family of the tennis engine. */
function TennisMatchCard({ match, accentIndex }: { match: PredictedMatch; accentIndex: number }) {
  const [playerHome, playerAway] = [match.home, match.away];
  const surface = SURFACE_STYLES[match.surface];
  const accent = CARD_ACCENT_ORDER[accentIndex % CARD_ACCENT_ORDER.length];
  const isLive = match.status === "live";
  const quality = QUALITY_STYLES[match.dataQuality];

  const winner = match.matchWinner;
  const favouriteIsHome = winner.home >= winner.away;
  const totalLines = match.totalGames.lines;

  return (
    <article className={`${CARD_GLASS} ${CARD_GLASS_SKIN[accent]} ${GLASS_TEXT_SHADOW} p-4 sm:p-5`}>
      {/* ── Header: tournament / round / date / badges ── */}
      <header className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-slate-300">
              {match.tour.toUpperCase()}
            </span>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${surface.badge}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${surface.dot}`} aria-hidden="true" />
              {surface.label}
            </span>
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Bo{match.bestOf}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${quality.badge}`}>
              {quality.label}
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
            {match.projectedScoreline || "—"}
          </div>
          <div className="text-[10px] text-slate-400">
            {match.projectedWinner}
          </div>
        </div>
      </header>

      {/* ── Players + Match Winner probability ── */}
      <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4">
        <PlayerRail player={playerHome} side="home" favourite={favouriteIsHome} winProb={winner.home} />
        <div className="text-center">
          <div className="font-mono text-2xl font-extrabold text-white">
            {pctLabel(winner.home)}
            <span className="mx-1 text-sm text-slate-500">/</span>
            {pctLabel(winner.away)}
          </div>
          <div className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
            match winner
          </div>
        </div>
        <PlayerRail player={playerAway} side="away" favourite={!favouriteIsHome} winProb={winner.away} />
      </div>
      <div className="mb-4">
        <SplitBar
          leftLabel={shortName(playerHome.name)}
          leftProb={winner.home}
          rightLabel={shortName(playerAway.name)}
          rightProb={winner.away}
        />
        <div className="mt-1.5 flex items-center justify-between text-[10px] font-mono text-slate-500">
          <span>fair odds {shortName(playerHome.name)}: {winner.fairOddsHome.toFixed(2)}</span>
          <span>{shortName(playerAway.name)}: {winner.fairOddsAway.toFixed(2)}</span>
        </div>
      </div>

      {/* ── Market families ── */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <MarketSection title="Total Games O/U" accent="text-cyan-300">
          <div className="text-[11px] font-mono text-slate-400">
            Expected total: <span className="font-bold text-white">{num(match.totalGames.expected)}</span> games
          </div>
          {totalLines.map((line) => (
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
          {/* Sets are i.i.d. under the model: set 1 is the headline price and
              every later set carries the same probability if it is played. */}
          {match.setWinner.sets.slice(0, 1).map((set) => (
            <SplitBar
              key={set.set}
              leftLabel={`Set 1 ${shortName(playerHome.name)}`}
              leftProb={set.home}
              rightLabel={shortName(playerAway.name)}
              rightProb={set.away}
            />
          ))}
          {match.setWinner.sets.length > 1 && (
            <div className="text-[10px] font-mono text-slate-500">
              {match.setWinner.sets.length - 1} further set{match.setWinner.sets.length > 2 ? "s" : ""} (if
              played): {pctLabel(match.setWinner.sets[1].home)} / {pctLabel(match.setWinner.sets[1].away)}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {match.setWinner.setBetting.map((betting) => (
              <span
                key={betting.score}
                className="rounded-md bg-slate-800/80 px-2 py-1 font-mono text-[10px] text-slate-300"
                title={`${playerHome.name} wins ${betting.score} in sets`}
              >
                <span className="font-bold text-white">{betting.score}</span> {pct(betting.prob)}
              </span>
            ))}
          </div>
        </MarketSection>

        <CountMarket
          title="Aces O/U"
          accent="text-emerald-300"
          home={match.aces?.home ?? null}
          away={match.aces?.away ?? null}
          homeName={shortName(playerHome.name)}
          awayName={shortName(playerAway.name)}
        />

        <CountMarket
          title="Double Faults O/U"
          accent="text-rose-300"
          home={match.doubleFaults?.home ?? null}
          away={match.doubleFaults?.away ?? null}
          homeName={shortName(playerHome.name)}
          awayName={shortName(playerAway.name)}
        />
      </div>

      {/* ── Score distribution + top scorelines ── */}
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <MarketSection title="Score Distribution" accent="text-sky-300">
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(match.scoreDistribution).map(([score, prob]) => (
              <span
                key={score}
                className="rounded-md border border-white/[0.06] bg-slate-900/60 px-2 py-1 font-mono text-[10px] text-slate-300"
                title={`${playerHome.name} ${score} in sets`}
              >
                <span className="font-bold text-white">{score}</span> {pct(prob)}
              </span>
            ))}
          </div>
        </MarketSection>

        <MarketSection title="Top Scorelines" accent="text-amber-300">
          <div className="space-y-1">
            {match.topScorelines.map((entry) => (
              <div
                key={`${entry.score}-${entry.winner}`}
                className="flex items-center justify-between gap-2 font-mono text-[11px]"
              >
                <span className="truncate text-slate-300">
                  <span className="font-bold text-white">{entry.score}</span>{" "}
                  <span className="text-slate-500">{entry.winner}</span>
                </span>
                <span className="text-slate-400">{pct(entry.prob)}</span>
              </div>
            ))}
          </div>
        </MarketSection>
      </div>

      {/* ── Model diagnostics ── */}
      <details className="mt-3">
        <summary className="cursor-pointer text-[10px] font-mono uppercase tracking-widest text-slate-500">
          Model trace
        </summary>
        <ul className="mt-2 space-y-1 text-[10px] font-mono leading-relaxed text-slate-500">
          {match.notes.map((note) => (
            <li key={note}>· {note}</li>
          ))}
          <li>
            · Per service point: {rate(match.model.pointProbHomeServe)} /{" "}
            {rate(match.model.pointProbAwayServe)} → hold {rate(match.model.holdHome)} /{" "}
            {rate(match.model.holdAway)}
          </li>
          <li>· Mode: {match.model.mode}</li>
        </ul>
      </details>
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

/** 🔴 badge: shown whenever the page has nothing honest to display. */
function DataUnavailableBadge() {
  return (
    <div
      className="inline-flex flex-wrap items-center gap-2 rounded-full bg-rose-500/10 px-3 py-1.5 text-[11px] font-semibold text-rose-300 ring-1 ring-rose-400/30"
      role="status"
    >
      <span aria-hidden="true">🔴</span>
      Data unavailable: Tennis predictions are currently unavailable.
    </div>
  );
}

function DataStatusBadge({ data }: { data: TennisResponse }) {
  const tours = Object.entries(data.dataStatus ?? {}).filter(([, status]) => Boolean(status));
  const loaded = tours.filter(([, status]) => status?.ok && (status.matches ?? 0) > 0);
  const label = loaded
    .map(([tour, status]) => `${tour.toUpperCase()} (${status?.matches.toLocaleString()} matches)`)
    .join(", ");

  if (label) {
    return (
      <div className="inline-flex flex-wrap items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-300 ring-1 ring-emerald-400/30">
        <span aria-hidden="true">🟢</span>
        Data loaded: {label}
      </div>
    );
  }
  return <DataUnavailableBadge />;
}

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
      const payload = (await response.json()) as TennisResponse;
      if (!response.ok || payload.error) {
        throw new Error(
          payload.error ?? `Tennis predictions are currently unavailable (HTTP ${response.status}).`,
        );
      }
      if (seq !== fetchSeq.current) return; // a newer filter change superseded this fetch
      setData(payload);
    } catch (reason) {
      if (seq !== fetchSeq.current) return;
      setError(
        reason instanceof Error ? reason.message : "Tennis predictions are currently unavailable.",
      );
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

  const errorState = error ?? data?.error ?? null;

  return (
    <main className="min-h-screen bg-[#05070d] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* ── Header ── */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className={`${CHIP} ${CHIP_ON_AMBER} mb-3 inline-flex px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider`}>
              🎾 ATP / WTA · surface-specific ELO
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              Tennis Predictions
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400 sm:text-base">
              Upcoming singles matches priced from real ATP/WTA history: a separate ELO per
              surface (clay 1.1×, grass 1.3×, hard 1.0×), a point-by-point service-game model
              built on each player&apos;s real serve/return rates, and an exact dynamic program
              for Total Games, Set Winner, correct score and the serve-stat markets.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/" className={`${NAV_PILL} ${NAV_PILL_OFF} px-3 py-2 text-xs font-semibold`}>
              ← Oracle
            </Link>
            <button
              type="button"
              onClick={() => {
                loadedFiltersRef.current = "";
                void load(tour, surface);
              }}
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

        {/* ── Data status badge ── */}
        {data && !data.error && <DataStatusBadge data={data} />}

        {/* ── Error / unavailable state ── */}
        {errorState && (
          <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-6 text-center" role="alert">
            <div className="mb-3 flex justify-center">
              <DataUnavailableBadge />
            </div>
            <div className="text-3xl" aria-hidden="true">🎾</div>
            <h2 className="mt-3 text-lg font-bold text-rose-100">
              Tennis predictions are currently unavailable. Please check back later.
            </h2>
            {data?.details && (
              <p className="mx-auto mt-2 max-w-2xl font-mono text-[11px] text-rose-200/70">
                {data.details}
              </p>
            )}
          </div>
        )}

        {/* ── Loading skeleton ── */}
        {loading && !data && !errorState && (
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

        {/* ── Empty state (data loaded, nothing scheduled) ── */}
        {!loading && !errorState && data && grouped.length === 0 && (
          <div className="rounded-2xl border border-white/[0.08] bg-slate-900/40 p-8 text-center">
            <div className="text-3xl" aria-hidden="true">🎾</div>
            <h2 className="mt-3 text-lg font-bold text-white">
              No upcoming {surface ? SURFACE_STYLES[surface].label.toLowerCase() : ""} matches
              {tour === "both" ? "" : ` on the ${tour.toUpperCase()} tour`}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
              The ESPN singles scoreboard has no scheduled matches in the next few days for this
              filter. Try another surface or tour — or check back after the next draw release.
            </p>
            {data.unavailableCount > 0 && (
              <details className="mx-auto mt-4 max-w-lg text-left">
                <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-widest text-slate-500">
                  {data.unavailableCount} fixture(s) not priced
                </summary>
                <ul className="mt-2 space-y-1 text-[11px] font-mono text-slate-500">
                  {data.unavailable.slice(0, 10).map((entry) => (
                    <li key={`${entry.tournament}-${entry.home}-${entry.away}`}>
                      {entry.home} vs {entry.away} — {entry.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {/* ── Matches by day ── */}
        {!errorState &&
          grouped.map(([day, matches]) => (
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
            Model: one ELO per surface (replayed only from matches on that surface, K = 32 ATP /
            45 WTA with a new-player boost) → real serve/return point rates → exact
            service-game, set and best-of-N dynamic programs for Total Games, Set Winner, correct
            score and the projected scoreline. Aces and double-fault lines are Poisson markets on
            each player&apos;s own baseline — a market is skipped, never guessed, when that
            baseline is missing.
          </p>
          <p className="mt-2">
            Data: Jeff Sackmann tennis_atp / tennis_wta match logs (Kadantte mirror when the
            canonical repos are down), tennis-data.co.uk odds files, and the ESPN tennis
            scoreboard for fixtures. No prediction is produced without a real rating for both
            players on the match surface. Predictions are probabilistic estimates, not
            guarantees.
          </p>
        </footer>
      </div>
    </main>
  );
}
