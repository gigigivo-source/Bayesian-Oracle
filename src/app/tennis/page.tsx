"use client";

// ĞIGI GIVØ — Tennis Predictions (ATP / WTA).
//
// The second sport of the supercomputer: upcoming singles matches priced by
// raw ELO for Match Winner with calibrated Lock tiers (PLATINUM 280+, GOLD
// 220+, SILVER 180+, BRONZE 140+) plus sequential real-world trap filters
// (Grass -1 tier, Rusty 30+d -1 tier, Big-Server Underdog >=8.5 aces → AVOID),
// exact set-score distribution, and Poisson serve-stat markets.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  TennisBestValueMarket,
  TennisLockTier,
  TennisPrediction,
} from "@/lib/engine/markets";
import {
  CARD_ACCENT_ORDER,
  CARD_GLASS,
  CARD_GLASS_SKIN,
  CHIP,
  CHIP_ON_AMBER,
  GLASS_PANEL,
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
  lastPlayed?: string | null;
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
  eloGap?: number;
  lockTier?: TennisLockTier;
  lockReasons?: string[];
  bestValueMarket?: TennisBestValueMarket;
  players: [PredictedPlayer, PredictedPlayer];
  prediction: TennisPrediction;
}

interface ValueAccumulatorLeg {
  matchId: string;
  tour: Tour;
  tournament: string;
  date: string;
  lockTier: TennisLockTier;
  matchup: string;
  favorite: string;
  matchWinnerOdds: number;
  market: string;
  selection: string;
  probability: number;
  fairOdds: number;
}

interface ValueAccumulator {
  targetOdds: number;
  meetsTarget: boolean;
  legCount: number;
  combinedOdds: number;
  combinedProbability: number;
  matchWinnerCombinedOdds: number;
  legs: ValueAccumulatorLeg[];
}

interface TennisResponse {
  generatedAt: string;
  filters: { surface: string | null; tour: string; limit: number; days: number; locksOnly?: boolean };
  locksSummary?: {
    platinum: number;
    gold: number;
    silver: number;
    bronze: number;
    avoid: number;
    total: number;
    valueMarketsCount?: number;
  };
  valueAccumulator?: ValueAccumulator | null;
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

interface RelativeDayKeys {
  todayKey: string;
  tomorrowKey: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SURFACE_STYLES: Record<Surface, { label: string; badge: string; dot: string }> = {
  clay: { label: "Clay", badge: "bg-orange-500/15 text-orange-300 ring-1 ring-orange-400/40", dot: "bg-orange-400" },
  grass: { label: "Grass", badge: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/40", dot: "bg-emerald-400" },
  hard: { label: "Hard", badge: "bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-400/40", dot: "bg-cyan-400" },
  carpet: { label: "Carpet", badge: "bg-slate-500/15 text-slate-300 ring-1 ring-slate-400/40", dot: "bg-slate-400" },
};

const LOCK_TIER_STYLES: Record<
  Exclude<TennisLockTier, "NONE">,
  { label: string; badge: string; cardRing: string; callout: string; title: string }
> = {
  PLATINUM_LOCK: {
    label: "💎 PLATINUM (280+)",
    badge: "bg-cyan-400/20 text-cyan-100 ring-1 ring-cyan-300/70",
    cardRing: "ring-1 ring-cyan-300/60",
    callout: "border-cyan-400/30 bg-cyan-500/10 text-cyan-200",
    title: "Calibrated Platinum Lock — raw ELO gap ≥ 280 with all trap filters cleared",
  },
  GOLD_LOCK: {
    label: "🥇 GOLD (220+)",
    badge: "bg-amber-400/20 text-amber-200 ring-1 ring-amber-400/70",
    cardRing: "ring-1 ring-amber-400/55",
    callout: "border-amber-400/30 bg-amber-500/10 text-amber-200",
    title: "Calibrated Gold Lock — raw ELO gap ≥ 220 (or Platinum downgraded 1 tier by grass/layoff)",
  },
  SILVER_LOCK: {
    label: "🥈 SILVER (180+)",
    badge: "bg-slate-300/20 text-slate-100 ring-1 ring-slate-300/60",
    cardRing: "ring-1 ring-slate-300/45",
    callout: "border-slate-300/30 bg-slate-400/10 text-slate-200",
    title: "Calibrated Silver Lock — raw ELO gap ≥ 180 (or higher tier downgraded by grass/layoff)",
  },
  BRONZE_LOCK: {
    label: "🥉 BRONZE (140+)",
    badge: "bg-orange-400/20 text-orange-200 ring-1 ring-orange-400/60",
    cardRing: "ring-1 ring-orange-400/40",
    callout: "border-orange-400/30 bg-orange-500/10 text-orange-200",
    title: "Calibrated Bronze Lock — raw ELO gap ≥ 140 (or higher tier downgraded to Bronze floor)",
  },
  AVOID: {
    label: "⚠️ AVOID (Trap triggered)",
    badge: "bg-rose-500/20 text-rose-200 ring-1 ring-rose-400/60",
    cardRing: "ring-1 ring-rose-400/45",
    callout: "border-rose-400/30 bg-rose-500/10 text-rose-200",
    title: "Trap triggered — underdog averages ≥ 8.5 aces/match (high upset risk)",
  },
};

function resolveEloGap(match: PredictedMatch): number {
  if (isFiniteNumber(match.prediction?.eloGap)) return match.prediction.eloGap;
  if (isFiniteNumber(match.eloGap)) return match.eloGap;
  const ratingA = match.players?.[0]?.rating;
  const ratingB = match.players?.[1]?.rating;
  if (isFiniteNumber(ratingA) && isFiniteNumber(ratingB)) {
    return Math.abs(ratingA - ratingB);
  }
  return 0;
}

function resolveLockTier(match: PredictedMatch): TennisLockTier {
  const tier = match.prediction?.lockTier ?? match.lockTier;
  if (
    tier === "PLATINUM_LOCK" ||
    tier === "GOLD_LOCK" ||
    tier === "SILVER_LOCK" ||
    tier === "BRONZE_LOCK" ||
    tier === "AVOID" ||
    tier === "NONE"
  ) {
    return tier;
  }
  const gap = resolveEloGap(match);
  let fallback: TennisLockTier = "NONE";
  if (gap >= 280) fallback = "PLATINUM_LOCK";
  else if (gap >= 220) fallback = "GOLD_LOCK";
  else if (gap >= 180) fallback = "SILVER_LOCK";
  else if (gap >= 140) fallback = "BRONZE_LOCK";
  if (fallback !== "NONE" && match.surface === "grass") {
    if (fallback === "PLATINUM_LOCK") fallback = "GOLD_LOCK";
    else if (fallback === "GOLD_LOCK") fallback = "SILVER_LOCK";
    else if (fallback === "SILVER_LOCK") fallback = "BRONZE_LOCK";
  }
  return fallback;
}

function resolveLockReasons(match: PredictedMatch): string[] {
  if (Array.isArray(match.prediction?.lockReasons)) return match.prediction.lockReasons;
  if (Array.isArray(match.lockReasons)) return match.lockReasons;
  return [];
}

function isPlayableLockTier(tier: TennisLockTier): boolean {
  return (
    tier === "PLATINUM_LOCK" ||
    tier === "GOLD_LOCK" ||
    tier === "SILVER_LOCK" ||
    tier === "BRONZE_LOCK"
  );
}

function lockTierOrder(tier: TennisLockTier): number {
  if (tier === "PLATINUM_LOCK") return 0;
  if (tier === "GOLD_LOCK") return 1;
  if (tier === "SILVER_LOCK") return 2;
  if (tier === "BRONZE_LOCK") return 3;
  if (tier === "NONE") return 4;
  return 5; // AVOID surfaced below standard matches unless inspected
}

function resolveBestValueMarket(match: PredictedMatch): TennisBestValueMarket | null {
  if (!isPlayableLockTier(resolveLockTier(match))) return null;
  const candidate = match.prediction?.bestValueMarket ?? match.bestValueMarket;
  if (!candidate) return null;
  if (
    typeof candidate.market !== "string" ||
    candidate.market.trim() === "" ||
    typeof candidate.selection !== "string" ||
    candidate.selection.trim() === "" ||
    !isFiniteNumber(candidate.probability) ||
    !isFiniteNumber(candidate.fairOdds)
  ) {
    return null;
  }
  return candidate;
}

function getFavoriteMatchWinnerOdds(match: PredictedMatch): number | null {
  const winner = match.prediction?.matchWinner;
  if (!winner) return null;
  const probA = isFiniteNumber(winner.probA) ? winner.probA : 0.5;
  const probB = isFiniteNumber(winner.probB) ? winner.probB : 0.5;
  const odds = probA >= probB ? winner.fairOddsA : winner.fairOddsB;
  return isFiniteNumber(odds) ? odds : null;
}

function matchesBestValueTotalGamesLine(
  bestValue: TennisBestValueMarket | null,
  line: number | null | undefined,
): "over" | "under" | null {
  if (!bestValue || bestValue.market !== "Total Games" || !isFiniteNumber(line)) return null;
  const formatted = line.toFixed(1);
  if (bestValue.selection === `Over ${formatted}`) return "over";
  if (bestValue.selection === `Under ${formatted}`) return "under";
  return null;
}

function matchesBestValueSetBettingScore(
  bestValue: TennisBestValueMarket | null,
  score: string | null | undefined,
  favoriteIsA: boolean,
): boolean {
  if (!bestValue || bestValue.market !== "Set Betting" || typeof score !== "string") return false;
  const match = /(\d+)-(\d+)$/.exec(bestValue.selection.trim());
  if (!match) return false;
  const favSets = match[1];
  const oppSets = match[2];
  const expectedScore = favoriteIsA ? `${favSets}-${oppSets}` : `${oppSets}-${favSets}`;
  return score === expectedScore;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function fmtFixed(value: number | null | undefined, digits: number, fallback = "—"): string {
  return isFiniteNumber(value) ? value.toFixed(digits) : fallback;
}

function pct(value: number | null | undefined): string {
  return isFiniteNumber(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function pctLabel(value: number | null | undefined): string {
  return isFiniteNumber(value) ? `${Math.round(value * 100)}%` : "—";
}

function surnameOf(name: string | null | undefined, fallback: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return fallback;
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1] ?? fallback;
}

function isTbdPlayer(name: string | null | undefined): boolean {
  if (typeof name !== "string") return true;
  const normalized = name.trim().toLowerCase();
  return normalized === "" || normalized === "tbd" || normalized === "to be determined";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "";
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

function formatUpdatedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toUTCString().slice(5, 22);
}

function computeUtcDayKeys(): RelativeDayKeys {
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const tomorrowKey = tomorrow.toISOString().slice(0, 10);
  return { todayKey, tomorrowKey };
}

const emptySubscribe = () => () => {};
const getServerDayKeys = (): RelativeDayKeys | null => null;
let cachedDayKeys: RelativeDayKeys | null = null;
function getClientDayKeys(): RelativeDayKeys {
  const next = computeUtcDayKeys();
  if (
    cachedDayKeys &&
    cachedDayKeys.todayKey === next.todayKey &&
    cachedDayKeys.tomorrowKey === next.tomorrowKey
  ) {
    return cachedDayKeys;
  }
  cachedDayKeys = next;
  return cachedDayKeys;
}

function formatDayLabel(value: string, relativeDayKeys: RelativeDayKeys | null): string {
  if (!value) return "Upcoming";
  const iso = value.length === 10 ? `${value}T00:00:00Z` : value;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return value;
  const key = date.toISOString().slice(0, 10);
  const base = new Intl.DateTimeFormat("en", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(date);
  if (relativeDayKeys) {
    if (key === relativeDayKeys.todayKey) return `Today · ${base}`;
    if (key === relativeDayKeys.tomorrowKey) return `Tomorrow · ${base}`;
  }
  return base;
}

function ratingBadge(source: PredictedPlayer["ratingSource"] | undefined): string | null {
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
  leftProb: number | null | undefined;
  rightLabel: string;
  rightProb: number | null | undefined;
}) {
  const safeLeft = isFiniteNumber(leftProb) ? leftProb : 0.5;
  const safeRight = isFiniteNumber(rightProb) ? rightProb : 0.5;
  const leftPct = Number(Math.max(2, Math.min(98, safeLeft * 100)).toFixed(2));
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px] font-mono">
        <span className={safeLeft >= 0.5 ? "font-bold text-amber-300" : "text-slate-400"}>
          {leftLabel} {pctLabel(leftProb)}
        </span>
        <span className={safeRight >= 0.5 ? "font-bold text-amber-300" : "text-slate-400"}>
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
function TennisMatchCard({
  match,
  accentIndex,
  inAcca,
  onToggleAcca,
}: {
  match: PredictedMatch;
  accentIndex: number;
  inAcca: boolean;
  onToggleAcca: (matchId: string) => void;
}) {
  if (!match || !Array.isArray(match.players) || match.players.length < 2 || !match.prediction) {
    return null;
  }
  const [playerA, playerB] = match.players;
  if (!playerA || !playerB) return null;

  const prediction = match.prediction;
  const matchKey = match.id || `${match.date ?? "match"}-${accentIndex}`;
  const surface = match.surface && match.surface in SURFACE_STYLES ? SURFACE_STYLES[match.surface] : null;
  const accent = CARD_ACCENT_ORDER[accentIndex % CARD_ACCENT_ORDER.length];
  const isLive = match.status === "live";
  const eloGap = resolveEloGap(match);
  const lockTier = resolveLockTier(match);
  const lockReasons = resolveLockReasons(match);
  const lockStyle = lockTier !== "NONE" ? LOCK_TIER_STYLES[lockTier] : null;
  const bestValueMarket = resolveBestValueMarket(match);
  const favMwOdds = getFavoriteMatchWinnerOdds(match);

  const winner = prediction.matchWinner;
  const probA = isFiniteNumber(winner?.probA) ? winner.probA : 0.5;
  const probB = isFiniteNumber(winner?.probB) ? winner.probB : 0.5;
  const favoriteIsA = probA >= probB;

  const nameA = playerA.name || "Player A";
  const nameB = playerB.name || "Player B";
  const surnameA = surnameOf(nameA, "A");
  const surnameB = surnameOf(nameB, "B");

  const totalGamesLines = Array.isArray(prediction.totalGames?.lines) ? prediction.totalGames.lines : [];
  const setBetting = Array.isArray(prediction.setWinner?.setBetting) ? prediction.setWinner.setBetting : [];
  const acesGroups = Array.isArray(prediction.aces) ? prediction.aces : [];
  const doubleFaultsGroups = Array.isArray(prediction.doubleFaults) ? prediction.doubleFaults : [];
  const breakPointsGroups = Array.isArray(prediction.breakPoints) ? prediction.breakPoints : [];
  const topScorelines = Array.isArray(prediction.scorelineTop) ? prediction.scorelineTop.slice(0, 4) : [];

  return (
    <article className={`${CARD_GLASS} ${CARD_GLASS_SKIN[accent]} ${GLASS_TEXT_SHADOW} ${lockStyle ? lockStyle.cardRing : ""} p-4 sm:p-5`}>
      {/* ── Header: tournament / round / date / badges ── */}
      <header className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {lockStyle && (
              <span
                className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] font-extrabold uppercase tracking-wider ${lockStyle.badge}`}
                title={lockStyle.title}
              >
                {lockStyle.label}
              </span>
            )}
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-slate-300">
              {match.tour ? match.tour.toUpperCase() : "TENNIS"}
            </span>
            {surface && (
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${surface.badge}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${surface.dot}`} aria-hidden="true" />
                {surface.label}
              </span>
            )}
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Bo{match.bestOf ?? 3}
            </span>
            <span
              className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-300"
              title="Raw pre-match ELO difference between the two players"
            >
              Δ{Math.round(eloGap)} ELO
            </span>
            {isLive && (
              <span className="animate-pulse rounded-full bg-rose-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-300 ring-1 ring-rose-400/40">
                ● Live
              </span>
            )}
          </div>
          <h3 className="mt-1.5 truncate text-base font-bold text-white">
            {match.tournament || "Singles Match"}
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
            {prediction.projectedScoreline || "—"}
          </div>
          <div className="text-[10px] text-slate-400">
            {prediction.projectedWinner || "—"} · {pct(prediction.projectedScorelineProb)}
          </div>
        </div>
      </header>

      {lockStyle && lockReasons.length > 0 && (
        <div className={`mb-4 rounded-xl border px-3 py-2 text-[11px] font-mono ${lockStyle.callout}`}>
          {lockReasons.join(" · ")}
        </div>
      )}

      {/* ── Best Value Market callout for playable Locks ── */}
      {bestValueMarket && (
        <div
          data-testid="best-value-market"
          className="mb-4 rounded-xl border border-emerald-400/35 bg-gradient-to-r from-emerald-500/[0.14] via-amber-500/[0.08] to-slate-950/60 p-3 shadow-inner"
        >
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-mono font-extrabold uppercase tracking-widest text-emerald-300">
                  ⚡ Best Value Market
                </span>
                <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-emerald-200 ring-1 ring-emerald-400/40">
                  {bestValueMarket.market}
                </span>
                {bestValueMarket.fairOdds > 1.5 && (
                  <span className="rounded-full bg-amber-400/15 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-200 ring-1 ring-amber-400/40">
                    &gt; 1.50 Solo
                  </span>
                )}
              </div>
              <div className="mt-1 truncate text-base font-extrabold text-white">
                {bestValueMarket.selection}
              </div>
              <div className="mt-0.5 text-[11px] font-mono text-slate-300">
                {pct(bestValueMarket.probability)} win prob
                {favMwOdds !== null && bestValueMarket.fairOdds > favMwOdds && (
                  <span className="text-emerald-300/90">
                    {" "}· vs Match Winner @{fmtFixed(favMwOdds, 2)} (+{fmtFixed(bestValueMarket.fairOdds - favMwOdds, 2)})
                  </span>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <div className="rounded-lg border border-emerald-400/30 bg-slate-950/70 px-3 py-1.5 text-center">
                <div className="text-[9px] font-mono font-bold uppercase tracking-widest text-emerald-300/80">
                  Fair Odds
                </div>
                <div className="font-mono text-lg font-extrabold leading-tight text-emerald-200">
                  {fmtFixed(bestValueMarket.fairOdds, 2)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onToggleAcca(match.id)}
                aria-pressed={inAcca}
                className={
                  inAcca
                    ? "cursor-pointer select-none rounded-lg border border-emerald-300/60 bg-emerald-500/25 px-3 py-2 font-mono text-[11px] font-bold text-emerald-100 transition-all hover:bg-emerald-500/35 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70"
                    : "cursor-pointer select-none rounded-lg border border-amber-400/50 bg-gradient-to-r from-[#F59E0B] to-[#FF8C00] px-3 py-2 font-mono text-[11px] font-bold text-white shadow-md shadow-amber-500/20 transition-all hover:brightness-110 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70"
                }
              >
                {inAcca ? "✓ In Acca" : "+ Add to Acca"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Players + Match Winner probability ── */}
      <div className="mb-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4">
        <div className="min-w-0 text-right">
          <div className="truncate text-sm font-bold text-white">
            {nameA}
            {favoriteIsA && <span className="ml-1.5 text-amber-400" aria-label="favourite">★</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center justify-end gap-1.5 text-[10px] text-slate-500">
            {playerA.country && <span className="font-mono">{playerA.country}</span>}
            {playerA.rank != null && <span className="font-mono">#{playerA.rank}</span>}
            <span className="font-mono" title={`ELO ${isFiniteNumber(playerA.rating) ? playerA.rating : "—"} (${playerA.ratingSource ?? "default"})`}>
              ELO {isFiniteNumber(playerA.rating) ? playerA.rating : "—"}
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
            {pctLabel(winner?.probA)}
            <span className="mx-1 text-sm text-slate-500">/</span>
            {pctLabel(winner?.probB)}
          </div>
          <div className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
            match winner
          </div>
        </div>
        <div className="min-w-0 text-left">
          <div className="truncate text-sm font-bold text-white">
            {favoriteIsA ? "" : <span className="mr-1.5 text-amber-400" aria-label="favourite">★</span>}
            {nameB}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
            {playerB.country && <span className="font-mono">{playerB.country}</span>}
            {playerB.rank != null && <span className="font-mono">#{playerB.rank}</span>}
            <span className="font-mono" title={`ELO ${isFiniteNumber(playerB.rating) ? playerB.rating : "—"} (${playerB.ratingSource ?? "default"})`}>
              ELO {isFiniteNumber(playerB.rating) ? playerB.rating : "—"}
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
          leftLabel={nameA}
          leftProb={winner?.probA}
          rightLabel={nameB}
          rightProb={winner?.probB}
        />
        <div className="mt-1.5 flex items-center justify-between text-[10px] font-mono text-slate-500">
          <span>
            fair odds {surnameA}: {fmtFixed(winner?.fairOddsA, 2)}
          </span>
          <span>
            {surnameB}: {fmtFixed(winner?.fairOddsB, 2)}
          </span>
        </div>
      </div>

      {/* ── Market families ── */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <MarketSection title="Total Games O/U" accent="text-cyan-300">
          <div className="text-[11px] font-mono text-slate-400">
            Expected total: <span className="font-bold text-white">{fmtFixed(prediction.totalGames?.expected, 1)}</span> games
          </div>
          {totalGamesLines.map((line, lineIdx) => {
            const matchedSide = matchesBestValueTotalGamesLine(bestValueMarket, line?.line);
            const bar = (
              <SplitBar
                leftLabel={`${matchedSide === "over" ? "⚡ " : ""}Over ${fmtFixed(line?.line, 1)}`}
                leftProb={line?.overProb}
                rightLabel={`Under ${fmtFixed(line?.line, 1)}${matchedSide === "under" ? " ⚡" : ""}`}
                rightProb={line?.underProb}
              />
            );
            return matchedSide ? (
              <div
                key={`${matchKey}-tg-${line?.line ?? "x"}-${lineIdx}`}
                className="rounded-lg border border-emerald-400/35 bg-emerald-500/[0.08] p-2"
              >
                {bar}
              </div>
            ) : (
              <div key={`${matchKey}-tg-${line?.line ?? "x"}-${lineIdx}`}>{bar}</div>
            );
          })}
        </MarketSection>

        <MarketSection title="Set Winner" accent="text-violet-300">
          <div className="text-[11px] font-mono text-slate-400">Set 1 winner</div>
          <SplitBar
            leftLabel={surnameA}
            leftProb={prediction.setWinner?.set1ProbA}
            rightLabel={surnameB}
            rightProb={prediction.setWinner?.set1ProbB}
          />
          <div className="flex flex-wrap gap-1.5 pt-1">
            {setBetting.map((betting, betIdx) => {
              const isValuePick = matchesBestValueSetBettingScore(
                bestValueMarket,
                betting?.score,
                favoriteIsA,
              );
              return (
                <span
                  key={`${matchKey}-sb-${betting?.score ?? "x"}-${betIdx}`}
                  className={
                    isValuePick
                      ? "rounded-md bg-emerald-500/20 px-2 py-1 font-mono text-[10px] text-emerald-100 ring-1 ring-emerald-400/70"
                      : "rounded-md bg-slate-800/80 px-2 py-1 font-mono text-[10px] text-slate-300"
                  }
                  title={`${prediction.players?.a ?? nameA}–${prediction.players?.b ?? nameB} set betting${isValuePick ? " (Best Value Market)" : ""}`}
                >
                  {isValuePick && <span className="mr-1 text-emerald-300">⚡</span>}
                  <span className="font-bold text-white">{betting?.score ?? "—"}</span>{" "}
                  {pct(betting?.prob)}
                </span>
              );
            })}
          </div>
        </MarketSection>

        <MarketSection title="Aces O/U" accent="text-emerald-300">
          {acesGroups.length === 0 ? (
            <div className="text-[11px] text-slate-500">No serve baselines available.</div>
          ) : (
            acesGroups.map((group, groupIdx) => (
              <div key={`${matchKey}-ace-${group?.scope ?? "x"}-${groupIdx}`}>
                <div className="text-[10px] font-mono text-slate-500">
                  {group?.scope ?? "Total"} · λ {fmtFixed(group?.expected, 1)} ({group?.basis ?? "baseline"})
                </div>
                {(Array.isArray(group?.lines) ? group.lines : []).map((line, lineIdx) => (
                  <SplitBar
                    key={`${matchKey}-ace-${groupIdx}-${group?.scope ?? "x"}-${line?.line ?? "x"}-${lineIdx}`}
                    leftLabel={`O ${fmtFixed(line?.line, 1)}`}
                    leftProb={line?.overProb}
                    rightLabel={`U ${fmtFixed(line?.line, 1)}`}
                    rightProb={line?.underProb}
                  />
                ))}
              </div>
            ))
          )}
        </MarketSection>

        <MarketSection title="Double Faults & Break Points" accent="text-rose-300">
          {doubleFaultsGroups.length === 0 && breakPointsGroups.length === 0 ? (
            <div className="text-[11px] text-slate-500">No serve baselines available.</div>
          ) : (
            <>
              {doubleFaultsGroups.map((group, groupIdx) => (
                <div key={`${matchKey}-df-${group?.scope ?? "x"}-${groupIdx}`}>
                  <div className="text-[10px] font-mono text-slate-500">
                    DF · {group?.scope ?? "Total"} · λ {fmtFixed(group?.expected, 1)}
                  </div>
                  {(Array.isArray(group?.lines) ? group.lines : []).map((line, lineIdx) => (
                    <SplitBar
                      key={`${matchKey}-df-${groupIdx}-${group?.scope ?? "x"}-${line?.line ?? "x"}-${lineIdx}`}
                      leftLabel={`O ${fmtFixed(line?.line, 1)}`}
                      leftProb={line?.overProb}
                      rightLabel={`U ${fmtFixed(line?.line, 1)}`}
                      rightProb={line?.underProb}
                    />
                  ))}
                </div>
              ))}
              {breakPointsGroups.map((group, groupIdx) => (
                <div key={`${matchKey}-bp-${group?.scope ?? "x"}-${groupIdx}`}>
                  <div className="text-[10px] font-mono text-slate-500">
                    Break points · {group?.scope ?? "Total"} · λ {fmtFixed(group?.expected, 1)}
                  </div>
                  {(Array.isArray(group?.lines) ? group.lines : []).map((line, lineIdx) => (
                    <SplitBar
                      key={`${matchKey}-bp-${groupIdx}-${group?.scope ?? "x"}-${line?.line ?? "x"}-${lineIdx}`}
                      leftLabel={`O ${fmtFixed(line?.line, 1)}`}
                      leftProb={line?.overProb}
                      rightLabel={`U ${fmtFixed(line?.line, 1)}`}
                      rightProb={line?.underProb}
                    />
                  ))}
                </div>
              ))}
            </>
          )}
        </MarketSection>
      </div>

      {/* ── Most likely scorelines ── */}
      {topScorelines.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
            Top scorelines
          </span>
          {topScorelines.map((entry, scoreIdx) => (
            <span
              key={`${matchKey}-sl-${entry?.scoreline ?? "x"}-${entry?.winner ?? "x"}-${scoreIdx}`}
              className="rounded-md border border-white/[0.06] bg-slate-900/60 px-2 py-0.5 font-mono text-[10px] text-slate-300"
              title={`${entry?.winner ?? "Player"} to win`}
            >
              {entry?.scoreline ?? "—"} <span className="text-slate-500">{pct(entry?.prob)}</span>
            </span>
          ))}
        </div>
      )}
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
  const [locksOnly, setLocksOnly] = useState(false);
  const [selectedAccaIds, setSelectedAccaIds] = useState<string[]>([]);
  const [data, setData] = useState<TennisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchSeq = useRef(0);
  const isMountedRef = useRef(false);

  // Defer clock-dependent labels ("Today" / "Tomorrow" / updated timestamp)
  // until after hydration so server HTML and the initial client pass match.
  const relativeDayKeys = useSyncExternalStore(
    emptySubscribe,
    getClientDayKeys,
    getServerDayKeys,
  );
  const mounted = relativeDayKeys !== null;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (tourFilter: "both" | Tour, surfaceFilter: "" | Surface) => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        tour: tourFilter,
        limit: "100",
        days: "7",
        includeLive: "1",
      });
      if (surfaceFilter) params.set("surface", surfaceFilter);
      const response = await fetch(`/api/tennis/predictions?${params.toString()}`, {
        cache: "no-store",
      });
      let payload: (TennisResponse & { error?: string }) | null = null;
      try {
        payload = (await response.json()) as TennisResponse & { error?: string };
      } catch {
        payload = null;
      }
      if (!response.ok || !payload) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      if (!isMountedRef.current || seq !== fetchSeq.current) return; // superseded or unmounted
      setData(payload);
    } catch (reason) {
      if (!isMountedRef.current || seq !== fetchSeq.current) return;
      setError(reason instanceof Error ? reason.message : "Unable to load tennis predictions.");
    } finally {
      if (isMountedRef.current && seq === fetchSeq.current) setLoading(false);
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

  // Filter out placeholder TBD bracket slots and malformed entries.
  const validMatches = useMemo(() => {
    if (!Array.isArray(data?.matches)) return [];
    return data.matches.filter((match) => {
      if (!match || !Array.isArray(match.players) || match.players.length < 2 || !match.prediction) {
        return false;
      }
      const [playerA, playerB] = match.players;
      if (!playerA || !playerB) return false;
      if (isTbdPlayer(playerA.name) || isTbdPlayer(playerB.name)) return false;
      return true;
    });
  }, [data]);

  const tierCounts = useMemo(() => {
    let platinum = 0;
    let gold = 0;
    let silver = 0;
    let bronze = 0;
    let avoid = 0;
    for (const match of validMatches) {
      const tier = resolveLockTier(match);
      if (tier === "PLATINUM_LOCK") platinum++;
      else if (tier === "GOLD_LOCK") gold++;
      else if (tier === "SILVER_LOCK") silver++;
      else if (tier === "BRONZE_LOCK") bronze++;
      else if (tier === "AVOID") avoid++;
    }
    return {
      platinum,
      gold,
      silver,
      bronze,
      avoid,
      playable: platinum + gold + silver + bronze,
    };
  }, [validMatches]);

  const visibleMatches = useMemo(
    () =>
      locksOnly
        ? validMatches.filter((match) => isPlayableLockTier(resolveLockTier(match)))
        : validMatches,
    [validMatches, locksOnly],
  );

  // Group matches by UTC day, surfacing Lock tiers first within each day.
  const grouped = useMemo(() => {
    const groups = new Map<string, PredictedMatch[]>();
    for (const match of visibleMatches) {
      const key = typeof match.date === "string" && match.date.length >= 10
        ? match.date.slice(0, 10)
        : "unknown";
      const list = groups.get(key) ?? [];
      list.push(match);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, list]): [string, PredictedMatch[]] => [
        day,
        [...list].sort(
          (a, b) =>
            lockTierOrder(resolveLockTier(a)) - lockTierOrder(resolveLockTier(b)) ||
            resolveEloGap(b) - resolveEloGap(a) ||
            (a.date ?? "").localeCompare(b.date ?? ""),
        ),
      ]);
  }, [visibleMatches]);

  // Playable Locks that carry a Best Value Market, ranked best-first for the Accumulator Builder.
  const valueLockEntries = useMemo(() => {
    const entries: Array<{
      match: PredictedMatch;
      lockTier: TennisLockTier;
      valueMarket: TennisBestValueMarket;
      mwOdds: number | null;
    }> = [];
    for (const match of validMatches) {
      const valueMarket = resolveBestValueMarket(match);
      if (!valueMarket) continue;
      entries.push({
        match,
        lockTier: resolveLockTier(match),
        valueMarket,
        mwOdds: getFavoriteMatchWinnerOdds(match),
      });
    }
    entries.sort(
      (a, b) =>
        lockTierOrder(a.lockTier) - lockTierOrder(b.lockTier) ||
        b.valueMarket.probability - a.valueMarket.probability ||
        resolveEloGap(b.match) - resolveEloGap(a.match) ||
        (a.match.date ?? "").localeCompare(b.match.date ?? ""),
    );
    return entries;
  }, [validMatches]);

  const selectedAccaSet = useMemo(() => new Set(selectedAccaIds), [selectedAccaIds]);

  const selectedAccaEntries = useMemo(() => {
    const byId = new Map(valueLockEntries.map((entry) => [entry.match.id, entry]));
    const resolved: typeof valueLockEntries = [];
    for (const id of selectedAccaIds) {
      const entry = byId.get(id);
      if (entry) resolved.push(entry);
    }
    return resolved;
  }, [valueLockEntries, selectedAccaIds]);

  const accaMetrics = useMemo(() => {
    if (selectedAccaEntries.length === 0) {
      return {
        combinedOdds: 0,
        combinedProb: 0,
        mwCombinedOdds: 0,
        meetsTarget: false,
      };
    }
    let combinedOdds = 1;
    let combinedProb = 1;
    let mwCombinedOdds = 1;
    let hasAllMw = true;
    for (const entry of selectedAccaEntries) {
      combinedOdds *= entry.valueMarket.fairOdds;
      combinedProb *= entry.valueMarket.probability;
      if (entry.mwOdds !== null) {
        mwCombinedOdds *= entry.mwOdds;
      } else {
        hasAllMw = false;
      }
    }
    const roundedOdds = Math.round(combinedOdds * 100) / 100;
    return {
      combinedOdds: roundedOdds,
      combinedProb,
      mwCombinedOdds: hasAllMw ? Math.round(mwCombinedOdds * 100) / 100 : 0,
      meetsTarget: roundedOdds > 1.5,
    };
  }, [selectedAccaEntries]);

  const toggleAccaLeg = useCallback((matchId: string) => {
    setSelectedAccaIds((prev) =>
      prev.includes(matchId) ? prev.filter((id) => id !== matchId) : [...prev, matchId],
    );
  }, []);

  const autoPickAcca = useCallback(() => {
    if (valueLockEntries.length === 0) return;
    const minLegs = Math.min(2, valueLockEntries.length);
    const maxLegs = Math.min(4, valueLockEntries.length);
    const picked: string[] = [];
    let odds = 1;
    for (const entry of valueLockEntries) {
      if (picked.length >= maxLegs) break;
      if (picked.length >= minLegs && odds > 1.5) break;
      picked.push(entry.match.id);
      odds *= entry.valueMarket.fairOdds;
    }
    setSelectedAccaIds(picked);
  }, [valueLockEntries]);

  const clearAcca = useCallback(() => {
    setSelectedAccaIds([]);
  }, []);

  const ratedTours = data?.ratings ? Object.keys(data.ratings) : [];
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  const updatedLabel = mounted ? formatUpdatedAt(data?.generatedAt) : null;
  const surfaceLabel = surface && surface in SURFACE_STYLES
    ? SURFACE_STYLES[surface].label.toLowerCase()
    : "";

  return (
    <main className="min-h-screen bg-[#05070d] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* ── Header ── */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className={`${CHIP} ${CHIP_ON_AMBER} mb-3 inline-flex px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider`}>
              🎾 ATP / WTA · Raw ELO + Lock Value Markets
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              Tennis Predictions
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400 sm:text-base">
              Upcoming singles matches priced by raw ELO across a 7-day window
              with calibrated Lock tiers — 💎 PLATINUM (280+), 🥇 GOLD (220+),
              🥈 SILVER (180+), 🥉 BRONZE (140+) — trap filters, and each
              Lock&apos;s highest-probability{" "}
              <span className="font-semibold text-emerald-300">Value Market</span>{" "}
              (Set Betting or Total Games) to build &gt; 1.50 accumulators.
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
          {TOUR_FILTERS.map((filter, i) => (
            <button
              key={`tour-${filter.id}-${i}`}
              type="button"
              onClick={() => setTour(filter.id)}
              aria-pressed={tour === filter.id}
              className={`${NAV_PILL_PREMIUM} px-3.5 py-2 text-xs ${tour === filter.id ? NAV_PILL_PREMIUM_ON : NAV_PILL_PREMIUM_OFF}`}
            >
              {filter.label}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-white/10" aria-hidden="true" />
          {SURFACE_FILTERS.map((filter, i) => (
            <button
              key={`surface-${filter.id || "all"}-${i}`}
              type="button"
              onClick={() => setSurface(filter.id)}
              aria-pressed={surface === filter.id}
              className={`${NAV_PILL_PREMIUM} px-3.5 py-2 text-xs ${surface === filter.id ? NAV_PILL_PREMIUM_ON : NAV_PILL_PREMIUM_OFF}`}
            >
              {filter.label}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-white/10" aria-hidden="true" />
          <button
            type="button"
            onClick={() => setLocksOnly((prev) => !prev)}
            aria-pressed={locksOnly}
            className={`${NAV_PILL_PREMIUM} px-3.5 py-2 text-xs ${locksOnly ? NAV_PILL_PREMIUM_ON : NAV_PILL_PREMIUM_OFF}`}
          >
            🔒 Locks only{data ? ` (${tierCounts.playable})` : ""}
          </button>
        </div>

        {/* ── Data status ── */}
        <div className={`rounded-xl border px-4 py-3 text-sm ${error ? "border-rose-500/30 bg-rose-500/10 text-rose-200" : data ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-white/10 bg-white/[0.03] text-slate-400"}`} role="status">
          {error ? "🔴 Data unavailable: Tennis predictions are currently unavailable." : data ? "🟢 Data loaded: real ATP/WTA historical data" : "Loading real tennis data…"}
        </div>

        {/* ── Status line ── */}
        {data && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono text-slate-500">
            <span>
              {visibleMatches.length} match{visibleMatches.length === 1 ? "" : "es"}
              {data.filters?.surface ? ` on ${data.filters.surface}` : ""}
            </span>
            {tierCounts.platinum > 0 && (
              <span className="font-bold text-cyan-300">
                💎 {tierCounts.platinum} Platinum
              </span>
            )}
            {tierCounts.gold > 0 && (
              <span className="font-bold text-amber-300">
                🥇 {tierCounts.gold} Gold
              </span>
            )}
            {tierCounts.silver > 0 && (
              <span className="font-bold text-slate-200">
                🥈 {tierCounts.silver} Silver
              </span>
            )}
            {tierCounts.bronze > 0 && (
              <span className="font-bold text-orange-300">
                🥉 {tierCounts.bronze} Bronze
              </span>
            )}
            {tierCounts.avoid > 0 && (
              <span className="font-bold text-rose-300">
                ⚠️ {tierCounts.avoid} Avoid
              </span>
            )}
            {ratedTours.map((tourKey, i) => (
              <span key={`rated-${tourKey}-${i}`}>
                {tourKey.toUpperCase()}: {data.ratings?.[tourKey]?.playersRated ?? 0} players rated
                {" · "}
                {data.ratings?.[tourKey]?.matchesProcessed ?? 0} matches
              </span>
            ))}
            {updatedLabel && <span>updated {updatedLabel} UTC</span>}
          </div>
        )}

        {/* ── Lock Value Accumulator Builder ── */}
        {!loading && !error && valueLockEntries.length > 0 && (
          <section
            aria-label="Lock Value Accumulator Builder"
            data-testid="lock-value-acca-builder"
            className={`${GLASS_PANEL} rounded-2xl p-4 sm:p-5`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-mono font-extrabold uppercase tracking-widest text-emerald-300">
                    🎯 Lock Value Accumulator
                  </span>
                  <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] font-semibold text-slate-300">
                    Target &gt; 1.50 combined odds
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  {selectedAccaEntries.length === 0
                    ? `${valueLockEntries.length} Lock Value Market${valueLockEntries.length === 1 ? "" : "s"} ready — click "+ Add to Acca" on any Lock card or use Auto-Pick to build a > 1.50 slip.`
                    : `${selectedAccaEntries.length} Lock Value leg${selectedAccaEntries.length === 1 ? "" : "s"} selected (Set Betting / Total Games instead of low Match Winner odds).`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={autoPickAcca}
                  className="cursor-pointer select-none rounded-full border border-emerald-400/50 bg-emerald-500/20 px-3.5 py-1.5 font-mono text-xs font-bold text-emerald-100 transition-all hover:bg-emerald-500/30 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70"
                >
                  ⚡ Auto-Pick &gt; 1.50 Acca
                </button>
                {selectedAccaEntries.length > 0 && (
                  <button
                    type="button"
                    onClick={clearAcca}
                    className="cursor-pointer select-none rounded-full border border-white/15 bg-white/[0.04] px-3 py-1.5 font-mono text-xs font-semibold text-slate-300 transition-all hover:bg-white/10 hover:text-white active:scale-95"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {selectedAccaEntries.length > 0 && (
              <div className="mt-4 space-y-3 border-t border-white/[0.08] pt-3">
                <div className="flex flex-wrap items-center gap-3 font-mono">
                  <div className="rounded-xl border border-emerald-400/35 bg-emerald-500/10 px-3 py-2">
                    <div className="text-[9px] font-bold uppercase tracking-widest text-emerald-300/80">
                      Combined Fair Odds
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        data-testid="acca-combined-odds"
                        className="text-xl font-extrabold text-white"
                      >
                        {fmtFixed(accaMetrics.combinedOdds, 2)}
                      </span>
                      <span
                        className={
                          accaMetrics.meetsTarget
                            ? "rounded-full bg-emerald-400/20 px-2 py-0.5 text-[10px] font-bold text-emerald-200 ring-1 ring-emerald-400/50"
                            : "rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-bold text-amber-200 ring-1 ring-amber-400/50"
                        }
                      >
                        {accaMetrics.meetsTarget ? "✓ > 1.50 Target Met" : "Add 1 more Lock"}
                      </span>
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/[0.08] bg-slate-950/50 px-3 py-2">
                    <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
                      Combined Win Prob
                    </div>
                    <div className="text-base font-bold text-white">
                      {pct(accaMetrics.combinedProb)}
                    </div>
                  </div>
                  {accaMetrics.mwCombinedOdds > 0 && (
                    <div className="rounded-xl border border-white/[0.08] bg-slate-950/50 px-3 py-2">
                      <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
                        vs Match Winner Acca
                      </div>
                      <div className="text-base font-bold text-slate-300">
                        @{fmtFixed(accaMetrics.mwCombinedOdds, 2)}
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {selectedAccaEntries.map((entry) => (
                    <button
                      key={`acca-chip-${entry.match.id}`}
                      type="button"
                      onClick={() => toggleAccaLeg(entry.match.id)}
                      title="Click to remove leg from accumulator"
                      className="cursor-pointer inline-flex items-center gap-1.5 rounded-full border border-emerald-400/35 bg-slate-900/80 px-3 py-1 font-mono text-[11px] text-slate-100 transition-all hover:border-rose-400/50 hover:bg-rose-500/15"
                    >
                      <span className="text-emerald-300">{entry.valueMarket.market}:</span>
                      <span className="font-bold text-white">{entry.valueMarket.selection}</span>
                      <span className="text-emerald-200">@{fmtFixed(entry.valueMarket.fairOdds, 2)}</span>
                      <span className="ml-0.5 text-slate-400" aria-hidden="true">×</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
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
              <div key={`skeleton-${i}`} className="animate-pulse rounded-2xl border border-white/[0.06] bg-slate-900/50 p-5">
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
            <div className="text-3xl" aria-hidden="true">{locksOnly ? "🔒" : "🎾"}</div>
            <h2 className="mt-3 text-lg font-bold text-white">
              {locksOnly
                ? `No lock-tier${surfaceLabel ? ` ${surfaceLabel}` : ""} matches right now`
                : `No upcoming${surfaceLabel ? ` ${surfaceLabel}` : ""} matches${tour === "both" ? "" : ` on the ${tour.toUpperCase()} tour`}`}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
              {locksOnly
                ? "None of the scheduled matches for this filter currently qualify as PLATINUM (280+), GOLD (220+), SILVER (180+), or BRONZE (140+) after trap filters."
                : "The ESPN singles scoreboard has no scheduled matches in the next 7 days for this filter. Try another surface or tour — or check back after the next draw release."}
            </p>
            {locksOnly && validMatches.length > 0 && (
              <button
                type="button"
                onClick={() => setLocksOnly(false)}
                className={`${NAV_PILL_PREMIUM} ${NAV_PILL_PREMIUM_ON} mt-4 px-4 py-2 text-xs`}
              >
                Show all {validMatches.length} matches
              </button>
            )}
            {sources.length > 0 && (
              <details className="mx-auto mt-4 max-w-lg text-left">
                <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-widest text-slate-500">
                  Data source status
                </summary>
                <ul className="mt-2 space-y-1 text-[11px] font-mono text-slate-500">
                  {sources.slice(0, 10).map((source, i) => (
                    <li key={`${source?.tour ?? "all"}-${source?.source ?? "src"}-${i}`}>
                      {source?.tour ? `${source.tour}: ` : ""}
                      {source?.source ?? "unknown"} — {source?.note ?? ""}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {grouped.map(([day, matches], dayIdx) => {
          const dayLabel = formatDayLabel(day, relativeDayKeys);
          return (
            <section key={`day-${day}-${dayIdx}`} aria-label={dayLabel}>
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-sm font-bold text-white">{dayLabel}</h2>
                <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] text-slate-400">
                  {matches.length}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {matches.map((match, matchIdx) => (
                  <TennisMatchCard
                    key={`${match.id || "match"}-${matchIdx}`}
                    match={match}
                    accentIndex={matchIdx}
                    inAcca={selectedAccaSet.has(match.id)}
                    onToggleAcca={toggleAccaLeg}
                  />
                ))}
              </div>
            </section>
          );
        })}

        {/* ── Footer ── */}
        <footer className="border-t border-white/[0.06] pt-4 text-[11px] leading-relaxed text-slate-500">
          <p>
            Model: raw ELO Match Winner probability + calibrated Lock tiers
            (💎 PLATINUM 280+, 🥇 GOLD 220+, 🥈 SILVER 180+, 🥉 BRONZE 140+)
            with sequential real-world trap filters (Grass court −1 tier, 30+d
            favorite layoff −1 tier, Big-Server underdog ≥8.5 aces/match → ⚠️
            AVOID) → Value Market Extractor (highest-probability Set Betting or
            Total Games option ≥ 1.25 fair odds for &gt; 1.50 accumulators),
            exact set-score distribution, and Poisson serve-stat markets on real
            per-match baselines. Ratings without replayed history use a labelled
            rank prior — never an invented number.
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
