"use client";

// ĞIGI GIVØ — Correct Score match detail overlay.
//
// Opens from a fixture card on /correct-score and renders everything the model
// produced for that one match: the full top-10 scoreline table, the λ / ELO /
// Dixon–Coles metadata behind it, and — when the feed supplied them — recent
// form and the head-to-head record.
//
// Client-side only: the overlay reads the match object already in memory, so
// opening it never triggers a second API call or a navigation.

import { useCallback, useEffect, useRef, useState } from "react";
import { TeamBadge } from "../../_components/ui";
import { GLASS_PANEL, NAV_PILL_PREMIUM } from "../../_components/design";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DataQuality = "Real" | "Mixed" | "Synthetic";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface Scoreline {
  score: string;
  homeGoals: number;
  awayGoals: number;
  probability: number;
  impliedOdds: number;
  confidence: Confidence;
  dataQuality: DataQuality;
}

export interface FormGame {
  date: string;
  opponent: string;
  /** Usually "W", "D" or "L" as delivered by the summary feed. */
  result: string;
  score: string;
  venue: string | null;
  competition: string | null;
}

export interface TeamForm {
  team: string;
  games: FormGame[];
  wins: number;
  draws: number;
  losses: number;
  points: number;
  goalsForAverage: number | null;
  goalsAgainstAverage: number | null;
}

export interface H2hMeeting {
  date: string;
  home: string;
  away: string;
  score: string;
}

export interface MatchContext {
  homeForm: TeamForm | null;
  awayForm: TeamForm | null;
  h2h: H2hMeeting[];
  h2hHomeWins: number;
  h2hDraws: number;
  h2hAwayWins: number;
  h2hAverageGoals: number | null;
}

export interface CorrectScoreMatch {
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
  context?: MatchContext | null;
}

// ─── Shared badge tokens (also used by the fixture cards) ─────────────────────

export const qualityStyle: Record<DataQuality, string> = {
  Real: "border-sky-400/30 bg-sky-400/10 text-sky-200",
  Mixed: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  Synthetic: "border-slate-500/30 bg-slate-500/10 text-slate-300",
};

export const qualityDot: Record<DataQuality, string> = {
  Real: "●",
  Mixed: "●",
  Synthetic: "●",
};

export const qualityTooltip: Record<DataQuality, string> = {
  Real: "Every model input came from real team-specific stats",
  Mixed: "Some inputs are real, the rest were reweighted from season averages",
  Synthetic: "League-average baseline — no team-specific stats were available",
};

export const confidenceStyle: Record<Confidence, string> = {
  HIGH: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  MEDIUM: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  LOW: "border-slate-500/30 bg-slate-500/10 text-slate-400",
};

// ─── Icons ────────────────────────────────────────────────────────────────────

function CloseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Chip icon for the supercomputer badge. */
function SupercomputerIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
    </svg>
  );
}

/** Dice icon for the plain Monte Carlo badge. */
function MonteCarloIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatSimulations(count?: number): string {
  if (!count) return "Monte Carlo";
  return count >= 1000 ? `${Math.round(count / 1000)}k sims` : `${count} sims`;
}

function formatElo(elo?: number | null): string {
  return typeof elo === "number" ? String(Math.round(elo)) : "—";
}

function formatEloDelta(delta?: number | null): string {
  if (typeof delta !== "number") return "—";
  const rounded = Math.round(delta);
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function modelBadgeText(match: CorrectScoreMatch): string {
  if (match.modelBadge) return match.modelBadge.replace(/^🧠\s*/, "");
  return `Monte Carlo (${formatSimulations(match.simulations)})`;
}

function isSupercomputer(match: CorrectScoreMatch): boolean {
  return modelBadgeText(match).includes("Supercomputer");
}

// ─── Pieces ───────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">
      {children}
    </h3>
  );
}

function EloBadge({ elo }: { elo?: number | null }) {
  return (
    <span
      className="inline-flex items-center rounded-md border border-violet-400/25 bg-violet-400/[0.08] px-1.5 py-0.5 font-mono text-[10px] font-bold text-violet-200"
      title="ELO rating — 1500 start, K = 20 friendly / 30 league / 40 cup, replayed over the last three seasons"
    >
      ELO {formatElo(elo)}
    </span>
  );
}

function StatCell({
  label,
  value,
  title,
  tone = "text-white",
}: {
  label: string;
  value: string;
  title?: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-slate-700/70 bg-slate-800/60 px-3 py-2" title={title}>
      <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className={`mt-1 truncate font-mono text-base font-black ${tone}`}>{value}</div>
    </div>
  );
}

const FORM_RESULT_STYLE: Record<string, string> = {
  W: "border-emerald-400/40 bg-emerald-400/15 text-emerald-200",
  D: "border-slate-500/40 bg-slate-500/15 text-slate-300",
  L: "border-rose-400/40 bg-rose-400/15 text-rose-200",
};

function FormRow({ form, align }: { form: TeamForm; align: "left" | "right" }) {
  const summary = `${form.wins}W ${form.draws}D ${form.losses}L · ${form.points} pts`;
  const right = align === "right";
  return (
    <div className={`flex min-w-0 flex-col gap-2 ${right ? "items-end text-right" : "items-start"}`}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-xs font-bold text-white">{form.team}</span>
        <span className="shrink-0 font-mono text-[10px] text-slate-400">{summary}</span>
      </div>
      {/* Shape at a glance — most recent result first. */}
      <div className={`flex flex-wrap gap-1.5 ${right ? "justify-end" : ""}`}>
        {form.games.map((game, index) => (
          <span
            key={`pill-${game.date}-${index}`}
            title={`${game.opponent} ${game.score}${game.competition ? ` · ${game.competition}` : ""}`}
            className={`inline-flex h-6 min-w-6 items-center justify-center rounded-md border px-1.5 font-mono text-[10px] font-bold ${
              FORM_RESULT_STYLE[game.result] ?? FORM_RESULT_STYLE.D
            }`}
          >
            {game.result || "–"}
          </span>
        ))}
      </div>
      {/* The same five matches spelled out, so the shape is checkable. */}
      <ul className={`w-full space-y-1 ${right ? "text-right" : ""}`}>
        {form.games.map((game, index) => (
          <li
            key={`${game.date}-${game.opponent}-${index}`}
            className={`flex items-center gap-2 text-[11px] ${right ? "flex-row-reverse" : ""}`}
          >
            <span
              className={`inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded border px-1 font-mono text-[9px] font-bold ${
                FORM_RESULT_STYLE[game.result] ?? FORM_RESULT_STYLE.D
              }`}
            >
              {game.result || "–"}
            </span>
            <span className="min-w-0 flex-1 truncate text-slate-400">
              {game.venue ? `${game.venue === "@" ? "at" : "vs"} ` : ""}
              {game.opponent}
            </span>
            <span className="shrink-0 font-mono font-bold text-slate-200">{game.score}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Overlay ──────────────────────────────────────────────────────────────────

interface ScoreDetailOverlayProps {
  match: CorrectScoreMatch;
  onClose: () => void;
}

/** Reverse-animation budget, matching the `duration-300` transitions below. */
const EXIT_ANIMATION_MS = 320;

export default function ScoreDetailOverlay({ match, onClose }: ScoreDetailOverlayProps) {
  // Mount → animate in → animate out → unmount.
  const [visible, setVisible] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // rAF guarantees the element is painted at its resting state first, so the
    // enter transition actually runs.
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const finish = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    onClose();
  }, [onClose]);

  const handleClose = useCallback(() => {
    setVisible(false);
    // Fallback for environments that never fire transitionend (reduced motion,
    // background tabs): the unmount must not depend on a CSS transition.
    timerRef.current = setTimeout(finish, EXIT_ANIMATION_MS);
  }, [finish]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  // Hold the background still while the overlay owns the screen.
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const top = match.topScorelines[0] ?? null;
  const context = match.context ?? null;
  const supercomputer = isSupercomputer(match);
  const modelTitle = `${match.model ?? "correct-score model"} · ${formatSimulations(match.simulations)}` +
    `${typeof match.rho === "number" ? ` · Dixon-Coles ρ ${match.rho.toFixed(3)}` : ""}`;

  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) handleClose();
      }}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !visible) finish();
      }}
      className={[
        "fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-0 backdrop-blur-sm sm:p-6",
        "transition-opacity duration-300",
        visible ? "opacity-100" : "opacity-0",
      ].join(" ")}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${match.homeTeam} vs ${match.awayTeam} correct score analysis`}
        tabIndex={-1}
        className={[
          "relative max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-white/10",
          "bg-slate-900/95 p-6 backdrop-blur-xl focus:outline-none sm:p-8",
          "transition-all duration-300 ease-out",
          visible ? "scale-100 opacity-100" : "scale-95 opacity-0",
        ].join(" ")}
      >
        {/* ── Close ── */}
        <button
          type="button"
          onClick={handleClose}
          className="absolute right-4 top-4 inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-bold text-slate-300 transition hover:border-cyan-400/40 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70"
        >
          <CloseIcon />
          Close
        </button>

        {/* ── Match header ── */}
        <header className="pr-20">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 sm:gap-6">
            <div className="flex min-w-0 flex-col items-end gap-2 text-right">
              <div className="flex min-w-0 items-center justify-end gap-2">
                <span className="truncate text-xl font-black tracking-tight text-white sm:text-3xl">
                  {match.homeTeam}
                </span>
                <TeamBadge logo={match.homeLogo} name={match.homeTeam} size={36} />
              </div>
              <EloBadge elo={match.homeElo} />
            </div>

            <div className="flex flex-col items-center gap-1">
              <span className="font-mono text-xs uppercase tracking-[0.2em] text-slate-500">vs</span>
              <span
                className="rounded-xl border border-amber-400/35 bg-amber-400/[0.08] px-3 py-1.5 font-mono text-xl font-black text-amber-200"
                title="Top predicted scoreline"
              >
                {top ? top.score : "–"}
              </span>
            </div>

            <div className="flex min-w-0 flex-col items-start gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <TeamBadge logo={match.awayLogo} name={match.awayTeam} size={36} />
                <span className="truncate text-xl font-black tracking-tight text-white sm:text-3xl">
                  {match.awayTeam}
                </span>
              </div>
              <EloBadge elo={match.awayElo} />
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400">
            <span className="rounded-full border border-cyan-400/25 bg-cyan-400/[0.08] px-2.5 py-1 text-cyan-200">
              England Premier League
            </span>
            <span>{formatDate(match.date)}</span>
            <span className="text-slate-600">•</span>
            <span>{formatTime(match.date)}</span>
            <span
              className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${qualityStyle[match.dataQuality]}`}
              title={qualityTooltip[match.dataQuality]}
            >
              {qualityDot[match.dataQuality]} {match.dataQuality}
            </span>
          </div>
          {match.venue && (
            <p className="mt-2 text-center text-xs text-slate-500">{match.venue}</p>
          )}
        </header>

        {/* ── Expected goals + model metadata ── */}
        <section className={`mt-6 rounded-2xl p-4 ${GLASS_PANEL}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionLabel>Expected goals &amp; model</SectionLabel>
            <span
              title={modelTitle}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold ${
                supercomputer
                  ? "border-violet-400/35 bg-violet-400/10 text-violet-200"
                  : "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
              }`}
            >
              {supercomputer ? <SupercomputerIcon /> : <MonteCarloIcon />}
              {modelBadgeText(match)}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <StatCell
              label="Home xG"
              value={match.homeExpectedGoals.toFixed(2)}
              tone="text-cyan-200"
              title={`${match.homeTeam} expected goals`}
            />
            <StatCell
              label="Away xG"
              value={match.awayExpectedGoals.toFixed(2)}
              tone="text-cyan-200"
              title={`${match.awayTeam} expected goals`}
            />
            <StatCell
              label="ELO diff"
              value={formatEloDelta(match.eloDelta)}
              tone="text-violet-200"
              title="Home ELO minus away ELO"
            />
            <StatCell
              label="Dixon-Coles ρ"
              value={typeof match.rho === "number" ? match.rho.toFixed(3) : "—"}
              tone="text-slate-100"
              title="Low-score dependence correction estimated from the same history"
            />
          </div>
          <p className="mt-3 truncate font-mono text-[10px] text-slate-500" title={modelTitle}>
            {modelTitle}
            {match.h2hGoalAverage !== null && ` · H2H avg ${match.h2hGoalAverage.toFixed(2)} goals`}
          </p>
        </section>

        {/* ── Full top-10 scoreline table ── */}
        <section className="mt-6">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <SectionLabel>Top 10 scorelines</SectionLabel>
            <span className="font-mono text-[10px] text-slate-600">
              Monte Carlo {formatSimulations(match.simulations)}
              {typeof match.structuralWeight === "number"
                ? ` · structural λ ${Math.round(match.structuralWeight * 100)}%`
                : ""}
            </span>
          </div>
          <div className="overflow-hidden rounded-2xl border border-slate-700/70">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-slate-800/80 font-mono text-[9px] uppercase tracking-[0.16em] text-slate-500">
                  <th scope="col" className="px-3 py-2.5 font-bold">Rank</th>
                  <th scope="col" className="px-3 py-2.5 font-bold">Scoreline</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-bold">Probability</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-bold">Implied odds</th>
                  <th scope="col" className="px-3 py-2.5 text-center font-bold">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {match.topScorelines.map((scoreline, index) => {
                  const rank = index + 1;
                  const isTop = rank === 1;
                  return (
                    <tr
                      key={scoreline.score}
                      className={`border-t border-slate-700/60 text-sm ${
                        isTop
                          ? "bg-amber-400/[0.08] ring-1 ring-inset ring-amber-400/40"
                          : index % 2
                            ? "bg-slate-800/30"
                            : "bg-transparent"
                      }`}
                    >
                      <td className="px-3 py-2.5 font-mono text-[11px] text-slate-500">
                        {isTop ? (
                          <span className="font-bold text-amber-300">#{rank} ★</span>
                        ) : (
                          `#${rank}`
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`inline-flex min-w-14 items-center justify-center rounded-lg border px-2 py-1 font-mono text-sm font-black ${
                            isTop
                              ? "border-amber-400/45 bg-amber-400/10 text-amber-100"
                              : "border-slate-700 bg-slate-800/70 text-white"
                          }`}
                        >
                          {scoreline.score}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono font-bold text-amber-200">
                        {(scoreline.probability * 100).toFixed(1)}%
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-300">
                        {scoreline.impliedOdds.toFixed(2)}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold tracking-wide ${confidenceStyle[scoreline.confidence]}`}
                        >
                          {scoreline.confidence}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 font-mono text-[10px] text-slate-600">
            Probabilities are model estimates from {formatSimulations(match.simulations)}, not guarantees.
          </p>
        </section>

        {/* ── Form & head-to-head (only when the feed supplied them) ── */}
        {context && (context.homeForm || context.awayForm || context.h2h.length) ? (
          <section className={`mt-6 rounded-2xl p-4 ${GLASS_PANEL}`}>
            <SectionLabel>Match context</SectionLabel>

            {context.homeForm || context.awayForm ? (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                {context.homeForm ? (
                  <FormRow form={context.homeForm} align="left" />
                ) : (
                  <p className="text-xs text-slate-500">No recent form for {match.homeTeam}.</p>
                )}
                {context.awayForm ? (
                  <FormRow form={context.awayForm} align="right" />
                ) : (
                  <p className="text-right text-xs text-slate-500">
                    No recent form for {match.awayTeam}.
                  </p>
                )}
              </div>
            ) : null}

            {context.h2h.length ? (
              <div className="mt-5 border-t border-white/[0.07] pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <SectionLabel>Head-to-head</SectionLabel>
                  <span className="font-mono text-[10px] text-slate-400">
                    {match.homeTeam} {context.h2hHomeWins} · Draws {context.h2hDraws} ·{" "}
                    {match.awayTeam} {context.h2hAwayWins}
                    {context.h2hAverageGoals !== null
                      ? ` · avg ${context.h2hAverageGoals.toFixed(2)} goals`
                      : ""}
                  </span>
                </div>
                <ul className="mt-2 space-y-1">
                  {context.h2h.slice(0, 6).map((meeting, index) => (
                    <li
                      key={`${meeting.date}-${index}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700/60 bg-slate-800/50 px-3 py-1.5 text-xs"
                    >
                      <span className="truncate text-slate-300">
                        {meeting.home} <span className="text-slate-600">vs</span> {meeting.away}
                      </span>
                      <span className="font-mono font-bold text-white">{meeting.score}</span>
                      <span className="font-mono text-[10px] text-slate-500">
                        {meeting.date ? formatDate(meeting.date) : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : (
          <section className={`mt-6 rounded-2xl p-4 ${GLASS_PANEL}`}>
            <SectionLabel>Match context</SectionLabel>
            <p className="mt-2 text-xs text-slate-500">
              No pre-match form or head-to-head data was available for this fixture from the
              stats feed — the scorelines above come from the model alone.
            </p>
          </section>
        )}

        {/* ── Sources ── */}
        {match.statsSources.length || match.modelSources?.length ? (
          <p className="mt-4 font-mono text-[10px] leading-relaxed text-slate-600">
            {[...(match.modelSources ?? []), ...match.statsSources].join(" · ")}
          </p>
        ) : null}

        {/* ── Footer ── */}
        <footer className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-5">
          <p className="text-[11px] text-slate-500">
            Press{" "}
            <kbd className="rounded border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px]">
              Esc
            </kbd>{" "}
            or click outside to close
          </p>
          <button
            type="button"
            onClick={handleClose}
            className={`${NAV_PILL_PREMIUM} bg-gradient-to-br from-[#F59E0B] to-[#FF8C00] px-5 py-2.5 text-sm font-bold text-white shadow-[0_0_25px_-8px_rgba(245,158,11,0.55)] hover:brightness-110`}
          >
            ← Back to Predictions
          </button>
        </footer>
      </div>
    </div>
  );
}
