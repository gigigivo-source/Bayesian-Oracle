import type { CanonicalMatchStats } from "../data/types";

export type LegOutcome = "won" | "lost" | "void" | "pending";

/**
 * Result of a settlement evaluation carrying the VOID *reason* alongside the
 * outcome. `push` distinguishes a line-push refund (actual value landed
 * exactly on the line — WIN/LOSS/VOID vocabulary: PUSH) from a data-
 * unavailability void (`reason: "no-data"` — no source ever provided the stat).
 */
export interface LegEvaluation {
  outcome: LegOutcome;
  /** True when a "void" is really a PUSH: the line was hit exactly. */
  push: boolean;
  /** Present on data-unavailability voids — drives the "VOID (no stats)" label. */
  reason?: "no-data";
}

/** One real goal event from the match feed — used to settle the Consecutive
 *  Goals markets from actual goal timestamps. */
export interface GoalEvent {
  /** Which side scored the goal. */
  team: "home" | "away";
  /** Match minute the goal was scored (0–120+, stoppage time allowed). */
  minute: number;
}

export interface MatchResult {
  eventId: string;
  leagueSlug: string;
  date: string;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  /**
   * Exact kickoff timestamp (full ISO, e.g. "2026-08-21T19:00:00Z") when the
   * result provider knows it. The 24h stats-void grace is measured from the
   * estimated final whistle; without a kickoff time the provider falls back
   * to the end of the match DATE (UTC), which only ever delays the void —
   * never accelerates it.
   */
  kickoffAt?: string;
  /**
   * Real goal events with timestamps, ordered by the provider. When present,
   * Consecutive Goals legs are settled exactly from the goal sequence; when
   * absent on a finished match the leg waits for late-arriving feed data for
   * the duration of the settlement grace window, then resolves VOID (stake
   * returned) — never guessed from the final score alone.
   */
  goals?: GoalEvent[];
}

// ─── Late-arriving stats: the 24-hour settlement grace window ────────────────
//
// Boxscore data (corners, cards, shots, throw-ins …) can land minutes to hours
// after the final whistle, and some providers publish it only the next day.
// A market whose stat is not yet obtainable therefore stays PENDING while the
// match is younger than STATS_SETTLEMENT_GRACE_HOURS; once the grace window has
// elapsed, NO future run can be expected to produce the data, and the market
// is resolved VOID (stake returned). This is what prevents stats markets from
// being stuck PENDING indefinitely on finished matches.

/** Hours a finished match stays eligible for late-arriving stats. */
export const STATS_SETTLEMENT_GRACE_HOURS = 24;

const GRACE_MS = STATS_SETTLEMENT_GRACE_HOURS * 3_600_000;

/** Rough full-match duration (kickoff → final whistle incl. stoppage time). */
const MATCH_DURATION_MS = 130 * 60_000;

/**
 * Estimated final-whistle timestamp (unix ms) of a finished match.
 *   · exact kickoff known  → kickoff + match duration
 *   · date-only (YYYY-MM-DD) → end of that UTC day (conservative)
 *   · unparseable          → null (grace can never elapse → stays PENDING)
 */
export function matchFinishedAtMs(result: Pick<MatchResult, "date" | "kickoffAt">): number | null {
  const raw = (result.kickoffAt ?? "").trim();
  if (raw) {
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return t + MATCH_DURATION_MS;
  }
  const day = (result.date ?? "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return Date.parse(`${day}T23:59:59Z`);
  const t = Date.parse(result.date ?? "");
  return Number.isNaN(t) ? null : t + MATCH_DURATION_MS;
}

/**
 * True when the match finished far enough ago that missing data is treated as
 * final and unresolvable legs may be VOIDed. Null/undefined results (match not
 * even finished anywhere) NEVER count as elapsed — those legs stay PENDING,
 * which is the correct status for "match not finished yet".
 */
export function statsGraceElapsed(
  result: Pick<MatchResult, "date" | "kickoffAt"> | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!result) return false;
  const finishedAt = matchFinishedAtMs(result);
  return finishedAt !== null && nowMs - finishedAt > GRACE_MS;
}

export interface SettlementLeg {
  marketName?: string | null;
  selection?: string | null;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

function lineFrom(market: string, selection: string): number | null {
  const directional = selection.match(/\b(?:over|under)\s*([0-9]+(?:\.[0-9]+)?)/i);
  const marketLine = market.match(/(?:o\s*\/\s*u|over\s*\/\s*under|goals?|corners?|cards?)\s*([0-9]+(?:\.[0-9]+)?)/i);
  const raw = directional?.[1] ?? marketLine?.[1];
  return raw === undefined ? null : Number(raw);
}

function compareLine(actual: number, line: number, over: boolean): LegEvaluation {
  if (actual === line) return { outcome: "void", push: true }; // line hit exactly — a PUSH
  return {
    outcome: over ? (actual > line ? "won" : "lost") : actual < line ? "won" : "lost",
    push: false,
  };
}

// ─── Consecutive Goals settlement (goal timestamps) ───────────────────────────
//
// The Consecutive Goals markets ("Team scores 3 goals in a row without the
// opponent scoring in between", selection "No") are resolved from the real
// goal-event sequence of the match: goals are sorted by minute and we look for
// a run of ≥ 3 consecutive goals by the market's target side (home / away /
// either). A "No" leg WINS when no such run occurred, and LOSES when it did.
// When the match is finished but no goal-event data was supplied the leg stays
// PENDING until the settlement grace window elapses, then resolves VOID (stake
// returned) — the outcome is never guessed from the final score.

/** True when the target side has a run of ≥ k consecutive goals. */
function hasRunForTeam(goals: GoalEvent[], team: "home" | "away", k: number): boolean {
  const ordered = [...goals].sort((a, b) => a.minute - b.minute);
  let run = 0;
  for (const g of ordered) {
    run = g.team === team ? run + 1 : 0;
    if (run >= k) return true;
  }
  return false;
}

/** True when EITHER side has a run of ≥ k consecutive goals. */
function hasRunForEither(goals: GoalEvent[], k: number): boolean {
  const ordered = [...goals].sort((a, b) => a.minute - b.minute);
  let run = 0;
  let last: GoalEvent["team"] | null = null;
  for (const g of ordered) {
    run = g.team === last ? run + 1 : 1;
    last = g.team;
    if (run >= k) return true;
  }
  return false;
}

/** Run length of the market: "3+ Consecutive…" / "…(3 in a row)" → 3, etc. */
function runLengthFromMarket(rawMarket: string): number {
  const inRow = rawMarket.match(/(\d+)\s*in a row/i);
  if (inRow) return Math.max(2, Number(inRow[1]));
  const plus = rawMarket.match(/(\d+)\s*\+?\s*consecutive/i);
  if (plus) return Math.max(2, Number(plus[1]));
  return 3;
}

/** Resolve a "… Consecutive Goals …" leg from real goal timestamps. */
function evaluateConsecutiveGoals(
  rawMarket: string,
  rawSelection: string,
  result: MatchResult,
  graceElapsed: boolean,
): LegEvaluation {
  const market = normalise(rawMarket);
  const selection = normalise(rawSelection);
  const home = normalise(result.homeName);
  const away = normalise(result.awayName);
  const k = runLengthFromMarket(rawMarket);

  // No goal-event feed yet: hold for late-arriving data inside the grace
  // window, then return the stake (never guess the sequence from the score).
  if (!result.goals) {
    return graceElapsed
      ? { outcome: "void", push: false, reason: "no-data" }
      : { outcome: "pending", push: false };
  }
  if (result.goals.length === 0) {
    // A goalless match has no run of k in a row — "No" always wins.
    return { outcome: /(^|\b)no(\b|$)/.test(selection) ? "won" : "lost", push: false };
  }

  // Which side the market is about: home name, away name, else "either".
  let target: "home" | "away" | "either";
  if (market.includes(home) && !market.includes(away)) target = "home";
  else if (market.includes(away) && !market.includes(home)) target = "away";
  else target = "either";

  const happened = target === "either"
    ? hasRunForEither(result.goals, k)
    : hasRunForTeam(result.goals, target, k);

  return {
    outcome: /(^|\b)no(\b|$)/.test(selection)
      ? happened ? "lost" : "won"
      : happened ? "won" : "lost",
    push: false,
  };
}

// ─── Stat-backed settlement (Part 4) ─────────────────────────────────────────
//
// When the settlement engine supplies the CanonicalMatchStats for a match,
// market families like Corners O/U, Cards O/U and Shots on Target O/U are read
// from the real stats instead of being left pending. If the stat is present
// the line is evaluated exactly (e.g. totalCorners = home.corners +
// away.corners); if the stat is null the leg waits for late-arriving feeds
// inside the 24h grace window and then resolves VOID (stake returned). When no
// stats object is supplied at all the leg stays PENDING under the legacy
// evaluateLeg contract — settlement orchestrators (engine/cron) additionally
// apply `finalizeSettlementEvaluation`, which voids a still-pending leg on a
// match whose grace window has elapsed. The one constant rule: stat outcomes
// are never guessed from score data.

function sumOrNull(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

function cardsFor(t: { yellowCards: number | null; redCards: number | null }): number | null {
  return sumOrNull(t.yellowCards, t.redCards);
}

/** Read the home/away stat values a market settles on. */
function statValuesForMarket(
  market: string,
  stats: CanonicalMatchStats,
): { home: number | null; away: number | null } {
  const s = stats;
  if (market.includes("corner")) return { home: s.home.corners, away: s.away.corners };
  if (market.includes("card")) return { home: cardsFor(s.home), away: cardsFor(s.away) };
  if (market.includes("sot") || market.includes("shots on target")) {
    return { home: s.home.shotsOnTarget, away: s.away.shotsOnTarget };
  }
  if (market.includes("shots towards goal")) {
    return { home: s.home.shots, away: s.away.shots };
  }
  if (market.includes("shot")) return { home: s.home.shots, away: s.away.shots };
  if (market.includes("foul")) return { home: s.home.fouls, away: s.away.fouls };
  if (market.includes("offside")) return { home: s.home.offsides, away: s.away.offsides };
  if (market.includes("save")) return { home: s.home.saves, away: s.away.saves };
  if (market.includes("throw")) return { home: s.home.throwIns, away: s.away.throwIns };
  if (market.includes("goal kick")) return { home: s.home.goalKicks, away: s.away.goalKicks };
  if (market.includes("possession")) return { home: s.home.possession, away: s.away.possession };
  if (market.includes("penalt")) return { home: s.home.penalties, away: s.away.penalties };
  return { home: null, away: null };
}

/**
 * Evaluate a stat-backed O/U leg from canonical stats. Returns null when the
 * market is not an O/U stat line (caller should fall through to other rules).
 * A missing stat value is PENDING inside the settlement grace window (feeds
 * publish boxscores late) and VOID — stake returned — once it has elapsed.
 */
function evaluateStatLeg(
  rawMarket: string,
  rawSelection: string,
  result: MatchResult,
  stats: CanonicalMatchStats | null | undefined,
  graceElapsed: boolean,
): LegEvaluation | null {
  if (!stats) return { outcome: "pending", push: false }; // no stats yet → keep pending, retry later

  const market = normalise(rawMarket);
  const selection = normalise(rawSelection);
  const home = normalise(result.homeName);
  const away = normalise(result.awayName);

  const line = lineFrom(rawMarket, rawSelection);
  const over = selection.startsWith("over") || /\bover\b/.test(selection);
  const under = selection.startsWith("under") || /\bunder\b/.test(selection);
  if (line === null || (!over && !under)) return null; // not an O/U line we resolve here

  const vals = statValuesForMarket(market, stats);
  if (vals.home === null || vals.away === null) {
    // Stat unavailable: wait for late data inside the grace window, then
    // return the stake once the match is old enough that no source has it.
    return graceElapsed
      ? { outcome: "void", push: false, reason: "no-data" }
      : { outcome: "pending", push: false };
  }

  let actual: number;
  if (/total/.test(market)) actual = vals.home + vals.away;
  else if (market.includes(home) && !market.includes(away)) actual = vals.home;
  else if (market.includes(away) && !market.includes(home)) actual = vals.away;
  else actual = vals.home + vals.away;

  return compareLine(actual, line, over);
}

/** Shared implementation behind evaluateLeg / evaluateLegDetailed. */
function evaluateLegCore(
  leg: SettlementLeg,
  result: MatchResult,
  stats: CanonicalMatchStats | null | undefined,
  graceElapsed: boolean,
): LegEvaluation {
  const rawMarket = leg.marketName?.trim() ?? "";
  const rawSelection = leg.selection?.trim() ?? "";
  if (!rawMarket || !rawSelection) return { outcome: "pending", push: false };

  const market = normalise(rawMarket);
  const selection = normalise(rawSelection);
  const home = normalise(result.homeName);
  const away = normalise(result.awayName);
  const homeScore = result.homeScore;
  const awayScore = result.awayScore;
  const total = homeScore + awayScore;

  // Consecutive Goals markets — resolved from real goal timestamps (never
  // guessed from the final score). Covers both the registry family
  // ("Consecutive Goals") and the legacy "Goal Sequence" lines.
  if (/consecutive goals/.test(market)) {
    return evaluateConsecutiveGoals(rawMarket, rawSelection, result, graceElapsed);
  }

  // Stat-backed markets — resolved from canonical stats when available.
  if (/cards?|corners?|shots?|\bsot\b|offsides?|fouls?|saves?|throw|goal kick|penalt/.test(market)) {
    const statOutcome = evaluateStatLeg(rawMarket, rawSelection, result, stats, graceElapsed);
    if (statOutcome !== null) return statOutcome;
    return { outcome: "pending", push: false };
  }

  if (/both teams.*score|btts/.test(market)) {
    const happened = homeScore > 0 && awayScore > 0;
    if (/^(yes|btts yes)$/.test(selection)) return { outcome: happened ? "won" : "lost", push: false };
    if (/^(no|btts no)$/.test(selection)) return { outcome: happened ? "lost" : "won", push: false };
    return { outcome: "pending", push: false };
  }

  if (/double chance/.test(market) || /^(1x|x2|12)$/.test(selection)) {
    if (selection === "1x" || (selection.includes("home") && selection.includes("draw")) || (selection.includes(home) && selection.includes("draw")))
      return { outcome: homeScore >= awayScore ? "won" : "lost", push: false };
    if (selection === "x2" || (selection.includes("away") && selection.includes("draw")) || (selection.includes(away) && selection.includes("draw")))
      return { outcome: awayScore >= homeScore ? "won" : "lost", push: false };
    if (selection === "12" || (selection.includes("home") && selection.includes("away")))
      return { outcome: homeScore !== awayScore ? "won" : "lost", push: false };
    return { outcome: "pending", push: false };
  }

  if (/draw no bet|dnb/.test(market)) {
    if (homeScore === awayScore) return { outcome: "void", push: true }; // draw → stake back (push)
    if (selection.includes("home") || selection.includes(home)) return { outcome: homeScore > awayScore ? "won" : "lost", push: false };
    if (selection.includes("away") || selection.includes(away)) return { outcome: awayScore > homeScore ? "won" : "lost", push: false };
    return { outcome: "pending", push: false };
  }

  if (/match result|moneyline|1x2|winner/.test(market) || selection === "draw" || /\bwin(?:ner)?\b/.test(selection)) {
    if (selection === "draw" || selection === "x") return { outcome: homeScore === awayScore ? "won" : "lost", push: false };
    if (selection === "1" || selection === "home" || selection === "home win" || selection.includes(home))
      return { outcome: homeScore > awayScore ? "won" : "lost", push: false };
    if (selection === "2" || selection === "away" || selection === "away win" || selection.includes(away))
      return { outcome: awayScore > homeScore ? "won" : "lost", push: false };
    return { outcome: "pending", push: false };
  }

  if (/clean sheet/.test(market)) {
    const yes = selection === "yes";
    const homeMarket = market.includes("home") || market.includes(home);
    const awayMarket = market.includes("away") || market.includes(away);
    if (!homeMarket && !awayMarket) return { outcome: "pending", push: false };
    const clean = homeMarket ? awayScore === 0 : homeScore === 0;
    return { outcome: clean === yes ? "won" : "lost", push: false };
  }

  if (/odd\s*\/\s*even|total.*odd|total.*even/.test(market)) {
    const odd = total % 2 === 1;
    if (selection.includes("odd")) return { outcome: odd ? "won" : "lost", push: false };
    if (selection.includes("even")) return { outcome: odd ? "lost" : "won", push: false };
  }

  const line = lineFrom(rawMarket, rawSelection);
  const over = selection.startsWith("over") || /\bover\b/.test(selection);
  const under = selection.startsWith("under") || /\bunder\b/.test(selection);
  if (line !== null && (over || under)) {
    let actual = total;
    const homeMarket = /home (?:team )?goals?/.test(market) || market.includes(`${home} goals`);
    const awayMarket = /away (?:team )?goals?/.test(market) || market.includes(`${away} goals`);
    if (homeMarket) actual = homeScore;
    else if (awayMarket) actual = awayScore;
    return compareLine(actual, line, over);
  }

  return { outcome: "pending", push: false };
}

/**
 * Escalate a STILL-pending evaluation on a match whose stats grace window has
 * elapsed: the data needed to resolve the market does not exist anywhere, so
 * the market resolves VOID (stake returned) instead of rotting in PENDING.
 * Within the window, or without a finished match result, the leg stays
 * PENDING — late boxscores can still arrive (or the game has not finished).
 */
export function finalizeSettlementEvaluation(
  evaluation: LegEvaluation,
  result: Pick<MatchResult, "date" | "kickoffAt"> | null | undefined,
  nowMs: number = Date.now(),
): LegEvaluation {
  if (evaluation.outcome === "pending" && statsGraceElapsed(result, nowMs)) {
    return { outcome: "void", push: false, reason: "no-data" };
  }
  return evaluation;
}

/** Full settlement evaluation: outcome + PUSH/VOID distinction + grace escalation. */
export function evaluateLegDetailed(
  leg: SettlementLeg,
  result: MatchResult,
  stats?: CanonicalMatchStats | null,
  options: { nowMs?: number } = {},
): LegEvaluation {
  const nowMs = options.nowMs ?? Date.now();
  const graceElapsed = statsGraceElapsed(result, nowMs);
  return finalizeSettlementEvaluation(
    evaluateLegCore(leg, result, stats, graceElapsed),
    result,
    nowMs,
  );
}

/** Evaluate a football betting leg from a final score (and, when supplied, the
 *  match's canonical stats). Stat-based markets that cannot be resolved from
 *  real stats remain pending — they must never be guessed from score data.
 *  Settlement orchestrators should prefer `evaluateLegDetailed`, which also
 *  reports line-pushes and voids pendings once the 24h grace has elapsed. */
export function evaluateLeg(
  leg: SettlementLeg,
  result: MatchResult,
  stats?: CanonicalMatchStats | null,
): LegOutcome {
  return evaluateLegCore(leg, result, stats, statsGraceElapsed(result)).outcome;
}

/** Compatibility alias used by older verification code. */
export const evaluatePick = evaluateLeg;
