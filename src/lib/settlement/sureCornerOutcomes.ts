// ĞIGI GIVØ — Sure Bet Corners outcome resolution (pure, unit tested).
//
// Maps a stored sure-bet corner pick (market + selection) against a real
// match result and canonical corner stats to a final outcome:
//   WIN | LOSS | PUSH | VOID
//
// O/U corner lines are settled with the settlement engine's evaluateLeg
// (the exact evaluator the settlement cron uses) — never re-implemented.
// evaluateLeg intentionally leaves the Corner Winner / Corner Handicap
// families pending (corner-specific lines with no generic rule), so this
// module adds two deterministic resolvers for exactly those families.
//
// A null return means "still pending": either no final result exists yet or
// the match has no stats object at all — the caller retries on the next run.

import { evaluateLeg, type MatchResult } from "./evaluate";
import type { CanonicalMatchStats } from "../data/types";

export type SureCornerOutcome = "WIN" | "LOSS" | "PUSH" | "VOID";

/** Parse the O/U line from a selection ("Over 9.5") or market name ("… O/U 9.5"). */
export function cornerLineFrom(market: string, selection: string): number | null {
  const directional = selection.match(/\b(?:over|under)\s*([0-9]+(?:\.[0-9]+)?)/i);
  const marketLine = market.match(/o\s*\/\s*u\s*([0-9]+(?:\.[0-9]+)?)/i);
  const raw = directional?.[1] ?? marketLine?.[1];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** The real corner count an O/U line settles on (mirrors evaluateLeg's scope rules). */
export function cornerActualFor(
  market: string,
  result: MatchResult,
  stats: CanonicalMatchStats | null,
): number | null {
  if (!stats) return null;
  const home = stats.home.corners;
  const away = stats.away.corners;
  if (home === null || away === null) return null;
  const m = market.toLowerCase();
  if (/total/.test(m)) return home + away;
  const homeName = result.homeName.toLowerCase();
  const awayName = result.awayName.toLowerCase();
  if (m.includes(homeName) && !m.includes(awayName)) return home;
  if (m.includes(awayName) && !m.includes(homeName)) return away;
  return home + away;
}

/** Which side the selection refers to (exact name first, then containment). */
function selectedSide(
  selection: string,
  result: MatchResult,
): "home" | "away" | null {
  const sel = selection.toLowerCase();
  const homeName = result.homeName.toLowerCase();
  const awayName = result.awayName.toLowerCase();
  if (sel === homeName || (sel.includes(homeName) && !sel.includes(awayName))) return "home";
  if (sel === awayName || (sel.includes(awayName) && !sel.includes(homeName))) return "away";
  return null;
}

/**
 * Corner Winner — the team with more real corners wins. A corner-count draw
 * means no winner: the stake is returned (VOID), never guessed.
 */
export function cornerWinnerOutcome(
  selection: string,
  result: MatchResult,
  stats: CanonicalMatchStats | null,
): SureCornerOutcome | null {
  if (!stats) return null;
  const home = stats.home.corners;
  const away = stats.away.corners;
  if (home === null || away === null) return null;
  const side = selectedSide(selection, result);
  if (!side) return null;
  if (home === away) return "VOID";
  const selectedCorners = side === "home" ? home : away;
  const otherCorners = side === "home" ? away : home;
  return selectedCorners > otherCorners ? "WIN" : "LOSS";
}

/**
 * Corner Handicap — selection looks like "Arsenal -3.5 corners". The favoured
 * team must win the corner count by more than the line; half-integer lines
 * never push, an exact integer line does.
 */
export function cornerHandicapOutcome(
  selection: string,
  result: MatchResult,
  stats: CanonicalMatchStats | null,
): SureCornerOutcome | null {
  const lineMatch = selection.match(/(-?\s*[0-9]+(?:\.[0-9]+)?)\s*corners?/i);
  if (!lineMatch) return null;
  const line = Math.abs(Number(lineMatch[1]));
  if (!Number.isFinite(line)) return null;
  if (!stats) return null;
  const home = stats.home.corners;
  const away = stats.away.corners;
  if (home === null || away === null) return null;
  const side = selectedSide(selection, result);
  if (!side) return null;
  const favouredCorners = side === "home" ? home : away;
  const otherCorners = side === "home" ? away : home;
  const margin = favouredCorners - otherCorners;
  return margin > line ? "WIN" : margin < line ? "LOSS" : "PUSH";
}

/**
 * Resolve one stored sure-bet corner pick. Returns null while the pick is
 * still pending (no final result, or corner stats not published yet).
 */
export function resolveSureCornerOutcome(
  market: string,
  selection: string,
  result: MatchResult,
  stats: CanonicalMatchStats | null,
): SureCornerOutcome | null {
  if (!market || !selection) return null;

  if (/corner\s*winner/i.test(market)) return cornerWinnerOutcome(selection, result, stats);
  if (/corner\s*handicap/i.test(market)) return cornerHandicapOutcome(selection, result, stats);

  const leg = evaluateLeg({ marketName: market, selection }, result, stats);
  if (leg === "won") return "WIN";
  if (leg === "lost") return "LOSS";
  if (leg === "pending") return null;

  // leg === "void": either the real total sat exactly on the line (a PUSH)
  // or corner stats are missing for a finished match (stake returned).
  const actual = cornerActualFor(market, result, stats);
  const line = cornerLineFrom(market, selection);
  if (actual !== null && line !== null && actual === line) return "PUSH";
  return "VOID";
}
