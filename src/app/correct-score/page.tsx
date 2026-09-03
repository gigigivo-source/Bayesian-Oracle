"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { GLASS_PANEL } from "../_components/design";

type DataQuality = "Real" | "Mixed" | "Synthetic";
type Confidence = "HIGH" | "MEDIUM" | "LOW";

interface Scoreline {
  score: string;
  homeGoals: number;
  awayGoals: number;
  probability: number;
  impliedOdds: number;
  confidence: Confidence;
  dataQuality: DataQuality;
}

interface CorrectScoreMatch {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  homeLogo: string | null;
  awayLogo: string | null;
  league: string;
  leagueSlug: string;
  date: string;
  venue: string | null;
  homeExpectedGoals: number;
  awayExpectedGoals: number;
  h2hGoalAverage: number | null;
  dataQuality: DataQuality;
  statsSources: string[];
  topScorelines: Scoreline[];
  // ── Supercomputer diagnostics (optional: absent from cached older payloads) ──
  model?: string;
  modelBadge?: string;
  simulations?: number;
  simulationMethod?: string;
  rho?: number;
  homeElo?: number | null;
  awayElo?: number | null;
  eloDelta?: number | null;
  structuralWeight?: number;
  modelSources?: string[];
}

const qualityStyle: Record<DataQuality, string> = {
  Real: "border-sky-400/30 bg-sky-400/10 text-sky-200",
  Mixed: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  Synthetic: "border-slate-500/30 bg-slate-500/10 text-slate-300",
};

const qualityDot: Record<DataQuality, string> = {
  Real: "🔵",
  Mixed: "🟡",
  Synthetic: "⚪",
};

const confidenceStyle: Record<Confidence, string> = {
  HIGH: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  MEDIUM: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  LOW: "border-slate-500/30 bg-slate-500/10 text-slate-400",
};

/** localStorage key for the Predictor Mode preference. */
const PREDICTOR_MODE_STORAGE_KEY = "correct-score:predictor-mode";

function formatKickoff(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSimulations(count?: number): string {
  if (!count) return "Monte Carlo";
  return count >= 1000 ? `${Math.round(count / 1000)}k sims` : `${count} sims`;
}

/** 🧠 Supercomputer when the historical model drove λ, else the plain MC badge. */
function modelBadge(match: CorrectScoreMatch): string {
  if (match.modelBadge) return match.modelBadge;
  return `🧠 Monte Carlo (${formatSimulations(match.simulations)})`;
}

function ModelBadge({ match }: { match: CorrectScoreMatch }) {
  const supercomputer = modelBadge(match).includes("Supercomputer");
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${
        supercomputer
          ? "border-violet-400/35 bg-violet-400/10 text-violet-200"
          : "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
      }`}
      title={`${match.model ?? "correct-score model"} · ${formatSimulations(match.simulations)}${
        typeof match.rho === "number" ? ` · Dixon-Coles ρ ${match.rho.toFixed(3)}` : ""
      }`}
    >
      {modelBadge(match)}
    </span>
  );
}

function EloRow({ team, elo }: { team: string; elo?: number | null }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="max-w-32 truncate">{team}</span>
      <span
        className="rounded-md border border-violet-400/25 bg-violet-400/[0.08] px-1.5 py-0.5 font-mono text-[10px] font-bold text-violet-200"
        title="ELO rating — 1500 start, K = 20 friendly / 30 league / 40 cup, replayed over the last three seasons"
      >
        {typeof elo === "number" ? Math.round(elo) : "—"}
      </span>
    </span>
  );
}

function MatchSkeleton() {
  return (
    <div className="rounded-3xl border border-white/[0.08] bg-white/[0.03] p-5 backdrop-blur-2xl">
      <div className="h-3 w-28 animate-pulse rounded bg-slate-800" />
      <div className="mt-4 h-7 w-2/3 animate-pulse rounded bg-slate-800" />
      <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 10 }).map((_, index) => (
          <div key={index} className="h-32 animate-pulse rounded-2xl bg-slate-800/80" />
        ))}
      </div>
    </div>
  );
}

function ScorelineTile({ scoreline, rank }: { scoreline: Scoreline; rank: number }) {
  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border p-3 transition duration-200 hover:-translate-y-1 hover:bg-white/[0.07] ${
        rank === 1
          ? "border-amber-400/35 bg-amber-400/[0.08] shadow-[0_0_24px_-12px_rgba(245,158,11,0.65)]"
          : "border-white/[0.07] bg-white/[0.025]"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
          #{rank}
        </span>
        <span
          className={`rounded-full border px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-wide ${confidenceStyle[scoreline.confidence]}`}
        >
          {scoreline.confidence}
        </span>
      </div>
      <div className="mt-2 inline-flex min-w-16 items-center justify-center rounded-xl border border-white/10 bg-black/25 px-3 py-1.5 font-mono text-2xl font-black text-white">
        {scoreline.score}
      </div>
      <div className="mt-3 flex items-end justify-between gap-2">
        <div>
          <div className="text-lg font-extrabold text-amber-200">
            {(scoreline.probability * 100).toFixed(1)}%
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-slate-500">Probability</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm font-bold text-slate-200">{scoreline.impliedOdds.toFixed(2)}</div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-slate-500">Odds</div>
        </div>
      </div>
      <div
        className={`mt-3 truncate rounded-full border px-2 py-1 text-center text-[9px] font-semibold ${qualityStyle[scoreline.dataQuality]}`}
        title={`${scoreline.dataQuality} data`}
      >
        {qualityDot[scoreline.dataQuality]} {scoreline.dataQuality}
      </div>
    </div>
  );
}

/** 🎯 Predictor Mode: a single, oversized Top-1 scoreline per match. */
function PredictorPick({ match }: { match: CorrectScoreMatch }) {
  const top = match.topScorelines[0];
  if (!top) return null;
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-amber-400/35 bg-amber-400/[0.08] px-6 py-10 shadow-[0_0_40px_-16px_rgba(245,158,11,0.6)]">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/40 bg-amber-400/10 px-3 py-1 text-xs font-bold text-amber-200">
        🎯 Best Guess
      </span>
      <div className="font-mono text-6xl font-black leading-none tracking-tight text-white sm:text-7xl">
        {top.score}
      </div>
      <div className="text-2xl font-extrabold text-amber-200">
        {(top.probability * 100).toFixed(1)}%
      </div>
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">Probability</div>
    </div>
  );
}

function MatchCard({ match, predictorMode }: { match: CorrectScoreMatch; predictorMode: boolean }) {
  return (
    <article className={`rounded-3xl p-5 sm:p-6 ${GLASS_PANEL}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.07] pb-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.15em] text-cyan-300">
            <span>{match.league}</span>
            <span className="text-slate-600">•</span>
            <time dateTime={match.date} className="text-slate-400">
              {formatKickoff(match.date)}
            </time>
          </div>
          <h2 className="mt-2 text-xl font-extrabold tracking-tight text-white sm:text-2xl">
            {match.homeTeam}
            <span className="mx-2 font-mono text-sm font-medium text-slate-500">vs</span>
            {match.awayTeam}
          </h2>
          {match.venue && <p className="mt-1 truncate text-xs text-slate-500">{match.venue}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ModelBadge match={match} />
          <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${qualityStyle[match.dataQuality]}`}>
            {qualityDot[match.dataQuality]} {match.dataQuality} data
          </span>
        </div>
      </div>

      <div className="my-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.05] px-4 py-3">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-cyan-300/70">Expected Goals</div>
          <div className="mt-1 text-sm font-semibold text-slate-200">
            {match.homeTeam} <span className="font-mono text-lg font-black text-cyan-200">{match.homeExpectedGoals.toFixed(2)}</span>
            <span className="mx-2 text-slate-600">vs</span>
            {match.awayTeam} <span className="font-mono text-lg font-black text-cyan-200">{match.awayExpectedGoals.toFixed(2)}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.12em] text-violet-300/80">
            <span className="text-slate-500">ELO</span>
            <EloRow team={match.homeTeam} elo={match.homeElo} />
            <span className="text-slate-600">vs</span>
            <EloRow team={match.awayTeam} elo={match.awayElo} />
            {typeof match.eloDelta === "number" && (
              <span className="rounded-md border border-white/[0.07] bg-black/20 px-1.5 py-0.5 text-[10px] text-slate-400">
                Δ {match.eloDelta > 0 ? "+" : ""}
                {Math.round(match.eloDelta)}
              </span>
            )}
          </div>
        </div>
        <div className="text-right text-[10px] text-slate-500">
          {typeof match.rho === "number" && <div>Dixon-Coles ρ {match.rho.toFixed(3)}</div>}
          {match.h2hGoalAverage !== null && <div>H2H avg {match.h2hGoalAverage.toFixed(2)} goals</div>}
          <div
            className="mt-0.5 max-w-xs truncate"
            title={[...(match.modelSources ?? []), ...match.statsSources].join(", ")}
          >
            {[...(match.modelSources ?? []), ...match.statsSources].join(" · ") || match.statsSources.join(" · ")}
          </div>
        </div>
      </div>

      {predictorMode ? (
        <PredictorPick match={match} />
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">
              Top 10 scorelines
            </h3>
            <span className="text-[10px] text-slate-600">
              {match.model ? `${match.model} · ` : ""}
              Monte Carlo {formatSimulations(match.simulations)}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {match.topScorelines.map((scoreline, index) => (
              <ScorelineTile key={scoreline.score} scoreline={scoreline} rank={index + 1} />
            ))}
          </div>
        </>
      )}
    </article>
  );
}

export default function CorrectScorePage() {
  const [matches, setMatches] = useState<CorrectScoreMatch[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/correct-score${refresh ? "?refresh=true" : ""}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as
        | CorrectScoreMatch[]
        | { matches?: CorrectScoreMatch[]; message?: string; error?: string };
      // Failure and empty-feed payloads are objects; a live feed is a bare array.
      if (!Array.isArray(body) && !Array.isArray(body.matches)) {
        throw new Error(!response.ok && body.error ? body.error : `HTTP ${response.status}`);
      }
      const feed = Array.isArray(body) ? body : (body.matches ?? []);
      setMatches(feed);
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
    void load();
  }, [load]);

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
              Supercomputer · ELO + Dixon-Coles + Monte Carlo · Next 7 days
            </div>
            <h1 className="bg-gradient-to-r from-white via-cyan-100 to-amber-200 bg-clip-text text-3xl font-black tracking-tight text-transparent sm:text-4xl">
              {predictorMode
                ? "Predictor Mode — Submit your exact score predictions"
                : "Premier League Correct Score Predictions"}
            </h1>
            <p className="mt-2 text-sm text-slate-400 sm:text-base">
              {predictorMode
                ? "One best-guess scoreline per match, sized for quick entry"
                : "Most likely final scorelines, simulated 10,000 times per match from real historical results"}
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
              {predictorMode ? "🎯 Predictor Mode" : "Full Analysis"}
            </button>
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
              onClick={() => void load(true)}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-full border border-amber-300/25 bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-xs font-bold text-white shadow-[0_0_20px_-7px_rgba(245,158,11,0.65)] transition hover:scale-[1.03] disabled:cursor-wait disabled:opacity-60"
            >
              <span className={refreshing ? "animate-spin" : ""}>↻</span>
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </header>

        <div className={`space-y-2 rounded-2xl p-4 text-xs text-slate-400 ${GLASS_PANEL}`}>
          <p>
            <span className="font-semibold text-slate-200">Supercomputer stack.</span> Expected goals come from
            venue-split attack/defence strengths built on the last three seasons of results, modulated by each
            team&apos;s ELO rating (1500 start; K = 20 friendly / 30 league / 40 cup). The score grid is corrected
            for low-score dependence with a Dixon-Coles ρ estimated from the same history, then sampled by
            Monte Carlo simulation — the top ten scorelines are read off the simulation, not the analytic grid.
          </p>
          <p>
            <span className="font-semibold text-slate-200">Legacy blend.</span> The previous xG-weighted composite
            (xG 40%, season scoring 25%, opponent goals conceded 20%, form 10%, venue advantage 5%) still
            contributes 40% of λ when real pre-match xG is available. Missing inputs are reweighted; a fixture
            with no historical model falls back to that competition&apos;s observed league baseline and is badged
            🧠 Monte Carlo instead of 🧠 Supercomputer.
          </p>
        </div>

        {error && (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5 text-sm text-rose-200">
            <div className="font-bold">Correct Score Predictions are temporarily unavailable</div>
            <p className="mt-1 text-rose-200/70">{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 rounded-full border border-rose-400/30 px-4 py-2 text-xs font-bold transition hover:bg-rose-400/10"
            >
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="space-y-5">
            {Array.from({ length: 3 }).map((_, index) => <MatchSkeleton key={index} />)}
          </div>
        ) : matches.length ? (
          <div className="space-y-5">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>{matches.length} upcoming {matches.length === 1 ? "match" : "matches"}</span>
              <span>Probabilities are model estimates, not guarantees.</span>
            </div>
            {matches.map((match) => (
              <MatchCard key={`${match.leagueSlug}:${match.fixtureId}`} match={match} predictorMode={predictorMode} />
            ))}
          </div>
        ) : !error ? (
          <div className={`rounded-3xl p-10 text-center ${GLASS_PANEL}`}>
            <div className="text-3xl">⚽</div>
            <h2 className="mt-3 text-lg font-bold text-white">{notice ?? "No upcoming fixtures found"}</h2>
            <p className="mt-1 text-sm text-slate-500">The seven-day fixture feed is currently empty. Try refreshing shortly.</p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
