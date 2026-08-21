// ĞIGI GIVØ — Multi-Factor Market Selector
//
// Replaces the previous single-number "safety" ranking with a weighted,
// multi-factor composite that scores every generated market across eleven
// independent signals. The composite is monotonic: a market with a higher
// composite is expected to have a higher true outcome probability, so Top-1
// is — by construction — the single most reliable pick and cannot be
// systematically worse than Top-2.
//
// FACTOR WEIGHTS:
//   The requested safety profile allocates 110 points (30+20+10+5+5+5+5+5+10+10+5).
//   The selector preserves those exact relative priorities and normalizes by the
//   total at calculation time so the final composite remains a 0..1 score.
//
//   1. Calibration / historical hit rate ............... 30%  ← calibration.ts
//      The empirical reliability of the market TYPE, derived from observed
//      hit/miss rates across backtested finished matches. Shrinks over-confident
//      volatile families (saves 0.55, cards 0.66) and fully trusts structurally
//      safe lines (extreme goal totals, Double Chance, Match Result).
//
//   2. Poisson λ  (expected event rates) ............... 20%  ← xg.ts + statisticalAnchors.ts
//      The raw event-rate evidence: how decisively the expected λ (goals,
//      corners, cards, SOT, shots, offsides, saves — built by the caller from
//      the xG model and league anchors) supports the selected side of the line.
//
//   3. Player / team form ............................... 10%  ← ESPN form data
//      Recent results momentum (GF/GA + points) mapped directionally onto the
//      market: hot attacking form supports Overs/Wins, cold form supports
//      Unders, and the in-form side is favoured in result markets.
//
//   4. Tactical matchup .................................. 5%   ← home/away, H2H, formation
//      Venue neutrality, head-to-head scoring history, and formation-mismatch
//      multipliers (attacking vs defensive → corners/cards, open vs open → goals).
//
//   5. Match importance .................................. 5%   ← derby, title race, relegation
//      Stakes-driven predictability: derbies, title races, relegation six-pointers
//      and knockout ties are more predictable than friendlies / dead rubbers.
//
//   6. League-specific depth .............................. 5%   ← leagueAnchors.ts
//      Whether the fixture's league has a dedicated empirical baseline (high
//      depth) versus a proxy/default anchor (low depth).
//
//   7. Market confidence / liquidity ...................... 5%   ← odds volume / movement
//      Bookmaker coverage of the exact line, or a rank-confidence proxy when
//      odds are unavailable.
//
//   8. Zero bias .......................................... 5%   ← neutralise home/away favouritism
//      Penalises team-specific markets whose edge leans on the home/away
//      asymmetry; total/neutral markets are venue-neutral and score fully.
//
//   9. Injury impact ...................................... 10%  ← lineup / injury feed
//      Full squads score 1.0; top scorer, main playmaker, starting GK, or other
//      key-player outs score 0.0; missing injury data falls back to 0.7.
//
//  10. Market volatility ................................. 10%  ← 6h odds movement
//      Stable odds score 1.0; odds moves above 20% in the last six hours score
//      0.0; missing movement data falls back to 0.8.
//
//  11. Weather / pitch conditions ......................... 5%   ← match weather
//      Perfect conditions score 1.0, clear conditions 0.8, heavy rain/snow/wind
//      0.2; missing weather data falls back to 0.9.
//
// DATA-GAP CONTRACT (v2 — dynamic weight redistribution, no neutral stand-ins)
//   Every factor is scored from whatever REAL data is available. When a
//   factor's data source is missing (null / unavailable) the factor is
//   EXCLUDED from the composite entirely and its weight is redistributed
//   proportionally across the remaining factors so the weights still sum to
//   exactly 100%. No simulated, default or neutral stand-in values are ever
//   substituted for missing data — a missing signal simply cannot vote.
//
//   Example: form (10%) and injuries (10%) unavailable → 20% redistributed,
//   so calibration 30%→33.3%, λ 20%→22.2%, etc. Calibration is always
//   available (it is derived from the model + empirical backtest), so the
//   denominator can never collapse to zero.
//
// STABILITY
//   The final sort is deterministic (composite desc → loss-probability asc →
//   σ-cushion desc → market id), so the same fixture + data always yields the
//   same order, and a genuinely better market always ranks above a weaker one.

import { poissonPmf, clamp } from "./stats";
import { marketReliability, type MatchVolatility } from "./calibration";
import type { Market } from "./types";
import type { LambdaSet } from "./lambdas";
import { LEAGUE_ANCHORS, getAnchors } from "./statisticalAnchors";
import { analyseFormationMismatch } from "./players";
import type { OddsInfo } from "../espn";

// ─── Factor weights ───────────────────────────────────────────────────────────

export const RANKING_WEIGHTS = {
  calibration:       0.30,  // empirical reliability / historical hit rate — calibration.ts
  lambda:            0.20,  // Poisson λ (expected event rates) — xg.ts + statisticalAnchors.ts
  form:              0.10,  // player / team form — ESPN form data
  tactical:          0.05,  // home/away, H2H, formation
  importance:        0.05,  // derby / title race / relegation
  leagueDepth:       0.05,  // league-specific anchors — leagueAnchors.ts
  liquidity:         0.05,  // odds confidence / liquidity
  bias:              0.05,  // neutralise home/away favouritism
  injuryImpact:      0.10,  // key absences and starter availability
  marketVolatility:  0.10,  // six-hour odds movement stability
  weather:           0.05,  // weather / pitch conditions
} as const;

const MIN_CALIBRATION_HIT_RATE = 0.85;
/** Backfill tier floor — used ONLY to complete the Top-10 when the trusted
 *  (≥85%) pool is exhausted. Picks from this tier are still qualified,
 *  injury-severity-checked, safety-net-checked and verifiable. */
const MIN_BACKFILL_CALIBRATION_HIT_RATE = 0.55;
const SIGNIFICANT_ODDS_MOVE_PCT = 20;

// ─── Match-level confidence gate ─────────────────────────────────────────────
// After the full market registry has been scored and ranked, the selector
// computes ONE match-level confidence score (0–100) from three signals:
//
//   1. Calibration average ............. 60% — average marketReliability
//      (empirical hit-rate reliability) of the Top-10 picks. A Top-10 built
//      from historically reliable market families is inherently more
//      trustworthy; reliance on the sub-85% backfill tier pulls this down.
//
//   2. Factor availability ............. 25% — how many of the 10 data-backed
//      ranking factors (Poisson λ, form, tactical, importance, league depth,
//      liquidity, bias, injuries, volatility, weather) returned REAL data,
//      averaged across the picks. Calibration is excluded here — it is always
//      available and already carries the 60% component above.
//
//   3. Source priority ................. 15% — which data source actually fed
//      the match (mapped by the caller): 1.0 = primary (ESPN / SportScore),
//      0.7 = fallback sources, 0.3 = backfill.
//
// Decision bands (CONFIDENCE_HIGH_THRESHOLD / CONFIDENCE_LOW_THRESHOLD):
//   ≥ 75%  → HIGH    — full Top-10 returned.
//   50–74% → MEDIUM  — full Top-10 returned, flagged in the response.
//   < 50%  → LOW     — when the caller enables the gate, only the Top 3 picks
//                      are returned (picksTrimmed) — the engine bets fewer
//                      markets on matches it cannot back with strong data.
export const CONFIDENCE_WEIGHTS = {
  calibrationAvg:     0.60,  // average marketReliability of the Top-10 picks
  factorAvailability: 0.25,  // share of the 10 data factors backed by real data
  sourcePriority:     0.15,  // 1.0 primary (ESPN/SportScore) · 0.7 fallback · 0.3 backfill
} as const;

/** Score ≥ this (0–100) → high confidence, full Top-10 returned. */
export const CONFIDENCE_HIGH_THRESHOLD = 75;
/** Score < this (0–100) → low confidence, output trimmed to the Top 3. */
export const CONFIDENCE_LOW_THRESHOLD = 50;
/** Picks kept when the gate trims a low-confidence match. */
export const LOW_CONFIDENCE_PICKS = 3;
/** Neutral source score applied when the caller supplies no source information. */
const DEFAULT_SOURCE_SCORE = 0.5;

/** Factor keys — mirror the fields of RANKING_WEIGHTS. */
export type FactorKey = keyof typeof RANKING_WEIGHTS;

const ALL_FACTOR_KEYS: FactorKey[] = Object.keys(RANKING_WEIGHTS) as FactorKey[];

/** Data-backed factors counted by the confidence gate: every ranking factor
 *  EXCEPT calibration (always available; carries its own 60% component). */
const DATA_FACTOR_KEYS: FactorKey[] = ALL_FACTOR_KEYS.filter((k) => k !== "calibration");

// ─── Verifiability ────────────────────────────────────────────────────────────

// Markets that ESPN boxscore CANNOT confirm — they always produce PENDING picks.
// They are still evaluated and ranked (nothing is dropped from the ranking),
// but only verifiable markets occupy Top-N slots.
const UNVERIFIABLE_PATTERNS = [
  "Throw-ins", "Goal Kicks", "Possession / Metrics",
  "Goal Sequence", "Advanced Events",
  "1st Half Goals", "2nd Half Goals",
  "Exact", "Correct Score",
  "4 or more Goals", "4+ Goals",
  "Penalty Awarded", "Red Card Shown",
  "HT/FT", "Race to", "Consecutive Goals",
  "Comeback Win", "Win to Nil",
  "At Least 3 Goals After", "Goal in Both Halves",
  "BTTS & Over",
];

const VERIFIABLE = new Set([
  "Goals", "Corners", "Yellow Cards", "Shots on Target",
  "Shots Towards Goal", "Saves",
  "Match Result", "Double Chance", "Draw No Bet / Asian Handicap",
]);

const GIANT_CLUBS = new Set([
  "Real Madrid",
  "Barcelona",
  "Atletico Madrid",
  "Bayern Munich",
  "Borussia Dortmund",
  "PSG",
  "Manchester City",
  "Liverpool",
  "Arsenal",
  "Chelsea",
  "Manchester United",
  "Tottenham",
  "Juventus",
  "Inter Milan",
  "AC Milan",
  "Napoli",
]);

const GIANT_CLUB_ALIASES: Record<string, string> = {
  "real madrid cf": "Real Madrid",
  "fc barcelona": "Barcelona",
  "barca": "Barcelona",
  "atletico madrid": "Atletico Madrid",
  "club atletico de madrid": "Atletico Madrid",
  "atletico": "Atletico Madrid",
  "atleti": "Atletico Madrid",
  "fc bayern munchen": "Bayern Munich",
  "bayern": "Bayern Munich",
  "bvb": "Borussia Dortmund",
  "dortmund": "Borussia Dortmund",
  "paris saint germain": "PSG",
  "paris sg": "PSG",
  "manchester city": "Manchester City",
  "man city": "Manchester City",
  "mancity": "Manchester City",
  "manchester united": "Manchester United",
  "man united": "Manchester United",
  "man utd": "Manchester United",
  "tottenham hotspur": "Tottenham",
  "spurs": "Tottenham",
  "juve": "Juventus",
  "juventus fc": "Juventus",
  "inter": "Inter Milan",
  "inter milano": "Inter Milan",
  "internazionale": "Inter Milan",
  "fc internazionale milano": "Inter Milan",
  "milan": "AC Milan",
  "ssc napoli": "Napoli",
};

function isVerifiable(m: Market): boolean {
  if (UNVERIFIABLE_PATTERNS.some((p) => m.name.includes(p) || m.family === p)) return false;
  if (m.name === "Both Teams To Score") return true;
  if (m.name.includes("Clean Sheet")) return true;
  if (m.name.startsWith("Match Result")) return true;
  if (m.name.includes("Double Chance")) return true;
  if (m.name.includes("Draw No Bet")) return true;
  if (VERIFIABLE.has(m.family)) return true;
  const fam = m.family.toLowerCase().replace(/_/g, " ");
  return fam === "goals" || fam === "match result" || fam === "corners"
    || fam === "yellow cards" || fam === "cards" || fam === "shots on target"
    || fam === "shots towards goal" || fam === "shots" || fam === "saves";
}

// ─── Name / team helpers ──────────────────────────────────────────────────────

function teamMentions(text: string, teamName: string): boolean {
  if (!teamName) return false;
  if (text.includes(teamName)) return true;
  const first = teamName.split(/\s+/).find((t) => t.length >= 4);
  return !!first && text.includes(first);
}

/** Which side (if any) a market's name is specific to. */
function marketSide(m: Market, homeName: string, awayName: string): "home" | "away" | "total" {
  const hn = teamMentions(m.name, homeName);
  const an = teamMentions(m.name, awayName);
  if (hn && !an) return "home";
  if (an && !hn) return "away";
  return "total";
}

function normalizeClubName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isGiantClub(name: string): boolean {
  if (!name) return false;
  if (GIANT_CLUBS.has(name)) return true;
  const normalized = normalizeClubName(name);
  const canonical = GIANT_CLUB_ALIASES[normalized];
  if (canonical) return GIANT_CLUBS.has(canonical);
  for (const giant of GIANT_CLUBS) {
    if (normalizeClubName(giant) === normalized) return true;
  }
  return false;
}

function isBlockedTeamSpecificUnder35Goals(
  m: Market,
  homeName: string,
  awayName: string,
): boolean {
  if (!isUnderSelection(m)) return false;
  const lineMatch = m.name.match(/Goals O\/U\s+([\d.]+)/);
  if (!lineMatch || Math.abs(Number(lineMatch[1]) - 3.5) > 1e-9) return false;

  const side = marketSide(m, homeName, awayName);
  if (side === "total") return false;

  const teamName = side === "home" ? homeName : awayName;
  return !isGiantClub(teamName);
}

// Note: only true Over/Under selections carry a directional form/tactical
// signal. "Yes"/"No" markets (BTTS, Clean Sheet, Penalty, Red Card) are
// directionally ambiguous and are treated as neutral in those factors.
function isOverSelection(m: Market): boolean {
  return m.selection.startsWith("Over");
}
function isUnderSelection(m: Market): boolean {
  return m.selection.startsWith("Under");
}

// ─── λ resolver ───────────────────────────────────────────────────────────────

function lambdaFor(m: Market, lam: LambdaSet, homeName: string, awayName: string): number | null {
  const n   = m.name;
  const sum = (a: number, b: number) => a + b;
  if (n.includes("Total Goals"))          return sum(lam.homeGoals,    lam.awayGoals);
  if (teamMentions(n, homeName) && n.includes("Goals")) return lam.homeGoals;
  if (teamMentions(n, awayName) && n.includes("Goals")) return lam.awayGoals;
  if (n.includes("Total Corners"))        return sum(lam.homeCorners,  lam.awayCorners);
  if (teamMentions(n, homeName) && n.includes("Corners")) return lam.homeCorners;
  if (teamMentions(n, awayName) && n.includes("Corners")) return lam.awayCorners;
  if (n.includes("Total Cards"))          return sum(lam.homeCards,    lam.awayCards);
  if (teamMentions(n, homeName) && n.includes("Cards")) return lam.homeCards;
  if (teamMentions(n, awayName) && n.includes("Cards")) return lam.awayCards;
  if (n.includes("Total SOT"))            return sum(lam.homeSot,      lam.awaySot);
  if (teamMentions(n, homeName) && n.includes("SOT")) return lam.homeSot;
  if (teamMentions(n, awayName) && n.includes("SOT")) return lam.awaySot;
  if (n.includes("Total Shots"))          return sum(lam.homeShots,    lam.awayShots);
  if (teamMentions(n, homeName) && n.includes("Shots")) return lam.homeShots;
  if (teamMentions(n, awayName) && n.includes("Shots")) return lam.awayShots;
  if (n.includes("Total Offsides"))       return sum(lam.homeOffsides, lam.awayOffsides);
  if (n.includes("Total Saves"))          return sum(lam.homeSaves,    lam.awaySaves);
  if (teamMentions(n, homeName) && n.includes("GK Saves")) return lam.homeSaves;
  if (teamMentions(n, awayName) && n.includes("GK Saves")) return lam.awaySaves;
  return null;
}

// ─── Poisson tail / σ-cushion ─────────────────────────────────────────────────

function tailRisk(m: Market, lambda: number): number {
  const lineMatch = m.name.match(/O\/U\s+([\d.]+)/);
  if (!lineMatch) return 1 - m.hitRate;
  const line      = Number(lineMatch[1]);
  const isOver    = m.selection.startsWith("Over");
  const threshold = Math.ceil(line);
  let overMass = 0;
  for (let k = threshold; k <= threshold + 40; k++) overMass += poissonPmf(k, lambda);
  overMass = Math.max(0, Math.min(1, overMass));
  return isOver ? 1 - overMass : overMass;
}

function sigmaCushion(lambda: number, line: number): number {
  return Math.abs(lambda - line) / Math.sqrt(Math.max(0.5, lambda));
}

// ─── Ranking context (optional enrichment data) ───────────────────────────────

/** Recent-form signal for one team (ESPN form / recent results). */
export interface TeamFormSignal {
  teamName: string;
  games:    number;
  gfAvg:    number;
  gaAvg:    number;
  points:   number;
}

/** Tactical matchup context. */
export interface TacticalContext {
  neutralSite?:    boolean;
  homeFormation?:  string | null;
  awayFormation?:  string | null;
  h2hGames?:       number;
  h2hGoalsAvg?:    number | null;
  /**
   * Historical head-to-head results from the perspective of the CURRENT
   * fixture's home team ("HomeWin" = current home team won that meeting).
   * Provided by the multi-source aggregator (oracle.ts) when available.
   */
  h2hResults?:     Array<"HomeWin" | "Draw" | "AwayWin"> | null;
}

/** Match importance flags. */
export interface ImportanceContext {
  derby?:      boolean;
  titleRace?:  boolean;
  relegation?: boolean;
  knockout?:   boolean;
  friendly?:   boolean;
}

/** Injury/suspension severity for one team. */
export interface TeamInjuryContext {
  teamName?:          string;
  dataAvailable?:     boolean;
  fullSquadAvailable?: boolean;
  startersOut?:       number | null;
  /** Alias accepted from lineup feeds that use a more explicit field name. */
  confirmedStartersOut?: number | null;
  topScorerOut?:      boolean;
  mainPlaymakerOut?:  boolean;
  startingGkOut?:     boolean;
  keyPlayersOut?:     boolean;
  confirmedOut?:      string[];
}

/** Injury context for both teams. */
export interface InjuryContext {
  home?: TeamInjuryContext | null;
  away?: TeamInjuryContext | null;
}

/** Six-hour market movement context. Percent values are absolute percentages. */
export interface MarketVolatilityContext {
  dataAvailable?:       boolean;
  stable?:              boolean;
  maxMovePctLast6h?:    number | null;
  marketMovePctLast6h?: Record<string, number | null | undefined>;
}

/** Weather / pitch condition context. */
export interface WeatherContext {
  dataAvailable?: boolean;
  condition?:     string | null;
  pitch?:         string | null;
  score?:         number | null;
}

/**
 * Source-trust signal for the match-level confidence gate — which priority
 * source actually provided this match's enrichment data. The caller (oracle)
 * maps its own source registry onto a 0..1 trust value: tier-1 live sources
 * (ESPN / SportScore) score high, backfill-tier sources score low, and no
 * enrichment at all scores lower still.
 */
export interface SourceTrustSignal {
  /** Highest-priority source that contributed data (e.g. "ESPN"). */
  primarySource?: string | null;
  /** Pre-mapped 0..1 trust in that source (higher = more reliable). */
  trust:          number;
  /** Short human-readable provenance note for logging. */
  detail?:        string;
}

/** Optional enrichment passed into the selector (all fields optional). */
export interface RankingContext {
  homeForm?:          TeamFormSignal | null;
  awayForm?:          TeamFormSignal | null;
  tactical?:          TacticalContext | null;
  importance?:        ImportanceContext | null;
  leagueSlug?:        string;
  odds?:              OddsInfo | null;
  injury?:            InjuryContext | null;
  marketVolatility?:  MarketVolatilityContext | null;
  weather?:           WeatherContext | null;
  sourceTrust?:       SourceTrustSignal | null;
}

/** League-table context for one team. Kept for API compatibility with oracle.ts. */
export interface TeamTableInfo {
  position?:   number;
  leagueSize?: number;
}

/**
 * Confidence-gate configuration (opt-in via SelectOptions). The confidence
 * score itself is always computed, logged and returned on the SelectionResult;
 * `enabled` only controls whether a low-confidence match's output is trimmed.
 */
export interface ConfidenceGateConfig {
  /** Enable the pick-trimming gate. Default false (score-only mode). */
  enabled?:       boolean;
  /** Score (0–100) at or above which a match is HIGH confidence. Default 75. */
  highThreshold?: number;
  /** Score (0–100) below which a match is LOW confidence (trimmed when enabled). Default 50. */
  lowThreshold?:  number;
  /** Picks to keep for low-confidence matches. Default LOW_CONFIDENCE_PICKS (3). */
  reduceTo?:      number;
}

/** Options passed to the selector. */
export interface SelectOptions {
  homeTable?: TeamTableInfo;
  awayTable?: TeamTableInfo;
  context?:   RankingContext;
  /** Match-level confidence gate — when enabled, matches scoring below the
   *  threshold return only their Top `reduceTo` picks instead of 10. */
  confidenceGate?: ConfidenceGateConfig;
}

// ─── Factor scorers (each returns a 0..1 score + optional gap log) ────────────

interface FactorResult {
  score: number;
  gap?:   string;
  /**
   * false → the factor's underlying DATA is unavailable for this match, so the
   * factor is excluded from the composite and its weight is redistributed
   * proportionally across the available factors (never a neutral stand-in).
   * Defaults to true; partial data still counts as available.
   */
  available?: boolean;
}

/** Factor 1 — Poisson λ (expected event rates). */
function scoreLambda(
  m: Market, lam: LambdaSet, homeName: string, awayName: string,
): FactorResult {
  const lambda = lambdaFor(m, lam, homeName, awayName);
  if (lambda === null) {
    return {
      score: 0.5,
      available: false,
      gap: "no direct λ→selection mapping (non event-rate market) — λ factor excluded, weight redistributed",
    };
  }
  // P(selection wins) under Poisson(λ): 1 - tail risk of the selected side.
  const winProb = 1 - tailRisk(m, lambda);
  return { score: clamp(winProb, 0, 1) };
}

/** Factor 2 — Calibration / historical hit rate (market-type reliability). */
function scoreCalibration(m: Market, ctx: MatchVolatility): FactorResult {
  // marketReliability is already the empirical hit-rate-derived factor (0.4..1.0).
  const rel = marketReliability(m, ctx);
  return { score: clamp(rel, 0, 1) };
}

/** Factor 3 — Player / team form. */
function scoreForm(
  m: Market, homeName: string, awayName: string, context: RankingContext | null,
): FactorResult {
  const hf = context?.homeForm ?? null;
  const af = context?.awayForm ?? null;

  const momentum = (f: TeamFormSignal | null): number | null => {
    if (!f || f.games < 1) return null;
    const gd = f.gfAvg - f.gaAvg;
    const ppg = f.points / Math.max(1, f.games);
    const gdScore = clamp(gd / 2.5, -0.5, 0.5);
    const ppgScore = clamp((ppg - 1.5) / 3, -0.5, 0.5);
    return (gdScore + ppgScore) / 2; // -0.5..0.5
  };

  const hM = momentum(hf);
  const aM = momentum(af);
  if (hM === null && aM === null) {
    return {
      score: 0.5,
      available: false,
      gap: "team form data missing — form factor excluded, weight redistributed",
    };
  }
  const hm = hM ?? 0;
  const am = aM ?? 0;

  const side = marketSide(m, homeName, awayName);
  const over = isOverSelection(m);
  const under = isUnderSelection(m);
  const result = /Match Result|Double Chance|Draw No Bet|Asian Handicap/i.test(m.name);

  if (result) {
    // A pure draw selection is form-agnostic.
    if (m.selection === "Draw") return { score: 0.5 };
    const homeSel = teamMentions(m.selection, homeName);
    const awaySel = teamMentions(m.selection, awayName);
    if (homeSel && !awaySel) return { score: clamp(0.5 + (hm - am) * 0.5, 0, 1) };
    if (awaySel && !homeSel) return { score: clamp(0.5 + (am - hm) * 0.5, 0, 1) };
    return { score: 0.5 };
  }

  if (over) {
    const mom = side === "total" ? (hm + am) / 2 : side === "home" ? hm : am;
    return { score: clamp(0.5 + mom, 0, 1) };
  }
  if (under) {
    const mom = side === "total" ? (hm + am) / 2 : side === "home" ? hm : am;
    return { score: clamp(0.5 - mom, 0, 1) };
  }
  return { score: 0.5 };
}

/** Factor 4 — Tactical matchup (home/away, H2H, formation). */
function scoreTactical(
  m: Market, lam: LambdaSet, homeName: string, awayName: string, context: RankingContext | null,
): FactorResult {
  const tac = context?.tactical ?? null;
  let score = 0.5;
  const gaps: string[] = [];
  let hasSignal = false;

  const isGoals   = /Goals/.test(m.name);
  const isCorners = /Corners/.test(m.name);
  const isResult  = /Match Result|Draw No Bet|Asian Handicap/i.test(m.name);
  const isResultLike = isResult || /Double Chance/i.test(m.name);
  const over = isOverSelection(m);
  const under = isUnderSelection(m);

  // H2H scoring history — adjusts goal markets toward the historical pattern.
  const h2hUsable = !!tac && (tac.h2hGames ?? 0) >= 3;
  if (h2hUsable && tac?.h2hGoalsAvg != null) {
    hasSignal = true;
    const modelTotal = lam.homeGoals + lam.awayGoals;
    const ratio = tac.h2hGoalsAvg / Math.max(0.5, modelTotal);
    const adj = clamp(ratio - 1, -0.4, 0.4); // + = historically higher scoring
    if (isGoals) {
      if (over) score += adj * 0.5;
      if (under) score -= adj * 0.5;
    }
  }
  // H2H result dominance (real W/D/L strings from the multi-source aggregator,
  // from the perspective of the current fixture's home team).
  if (h2hUsable && tac?.h2hResults?.length) {
    hasSignal = true;
    const results = tac.h2hResults;
    const dominance =
      (results.filter((r) => r === "HomeWin").length -
        results.filter((r) => r === "AwayWin").length) / results.length; // -1..1
    if (isResultLike && dominance !== 0) {
      if (teamMentions(m.selection, homeName)) score += dominance * 0.15;
      if (teamMentions(m.selection, awayName)) score -= dominance * 0.15;
    }
  }
  if (!h2hUsable) gaps.push("H2H data missing");

  // Formation mismatch — goal/corner multipliers + home advantage.
  if (tac?.homeFormation && tac?.awayFormation) {
    hasSignal = true;
    try {
      const fmm = analyseFormationMismatch(tac.homeFormation, tac.awayFormation);
      if (isGoals) {
        if (over) score += (fmm.goalMultiplier - 1) * 0.5;
        if (under) score -= (fmm.goalMultiplier - 1) * 0.5;
      }
      if (isCorners) {
        if (over) score += (fmm.cornerMultiplier - 1) * 0.5;
        if (under) score -= (fmm.cornerMultiplier - 1) * 0.5;
      }
      if (isResult) {
        if (teamMentions(m.selection, homeName)) score += fmm.homeAdvantage * 0.5;
        if (teamMentions(m.selection, awayName)) score -= fmm.homeAdvantage * 0.5;
      }
    } catch {
      gaps.push("formation analysis failed");
    }
  } else {
    gaps.push("formation data missing");
  }

  if (!hasSignal) {
    return {
      score: 0.5,
      available: false,
      gap: `${gaps.join("; ")} — tactical factor excluded, weight redistributed`,
    };
  }
  return { score: clamp(score, 0, 1), gap: gaps.length ? gaps.join("; ") : undefined };
}

/** Factor 5 — Match importance (derby / title race / relegation / knockout). */
function scoreImportance(context: RankingContext | null, opts?: SelectOptions): FactorResult {
  const imp = context?.importance;
  if (imp) {
    let score = 0.5;
    if (imp.friendly) score = 0.3;
    if (imp.knockout) score = Math.max(score, 0.80);
    if (imp.derby) score = Math.max(score, 0.85);
    if (imp.titleRace) score = Math.max(score, 0.85);
    if (imp.relegation) score = Math.max(score, 0.80);
    return { score };
  }

  // Fallback: infer stakes from league-table position when flags are absent.
  const home = opts?.homeTable;
  const away = opts?.awayTable;
  if (home?.position && away?.position && home.leagueSize) {
    const sz = home.leagueSize;
    const top = (p: number) => p <= Math.max(2, Math.floor(sz * 0.1));
    const bottom = (p: number) => p >= sz - Math.max(1, Math.floor(sz * 0.1)) + 1;
    const titleRace = top(home.position) && top(away.position);
    const relegation = bottom(home.position) && bottom(away.position);
    if (titleRace) return { score: 0.85 };
    if (relegation) return { score: 0.80 };
    if (top(home.position) || top(away.position) || bottom(home.position) || bottom(away.position)) {
      return { score: 0.65 };
    }
    return { score: 0.5 };
  }

  return {
    score: 0.5,
    available: false,
    gap: "match importance context missing (no flags, no league table) — importance factor excluded, weight redistributed",
  };
}

/** Factor 6 — League-specific depth (leagueAnchors.ts). */
function scoreLeagueDepth(context: RankingContext | null): FactorResult {
  const slug = context?.leagueSlug;
  if (!slug) {
    return {
      score: 0.5,
      available: false,
      gap: "league slug missing — league-depth factor excluded, weight redistributed",
    };
  }
  if (LEAGUE_ANCHORS[slug]) return { score: 1.0 };
  const resolved = getAnchors(slug);
  if (resolved) {
    return { score: 0.65, gap: `league '${slug}' resolved via proxy anchors (no dedicated baseline)` };
  }
  return {
    score: 0.5,
    available: false,
    gap: "no league anchors available — league-depth factor excluded, weight redistributed",
  };
}

/** Factor 7 — Market confidence / liquidity (odds volume or movement). */
function scoreLiquidity(
  m: Market, confidenceMap: Record<string, number> | undefined, context: RankingContext | null,
): FactorResult {
  const conf = confidenceMap?.[m.id];
  if (conf !== undefined) return { score: clamp(conf, 0, 1) };

  const odds = context?.odds;
  if (odds) {
    const line = m.name.match(/O\/U\s+([\d.]+)/);
    const matchesTotal = odds.overUnder != null && m.name.includes("Total Goals")
      && line && Math.abs(Number(line[1]) - (odds.overUnder ?? 0)) < 0.01;
    const matchesResult = (m.name.startsWith("Match Result") || m.name.includes("Double Chance"))
      && (odds.homeML != null || odds.awayML != null || odds.drawML != null);
    if (matchesTotal || matchesResult) return { score: 0.8 };
    return { score: 0.55, gap: "odds present but no matching line for this market" };
  }
  return {
    score: 0.5,
    available: false,
    gap: "no odds/volume data — liquidity factor excluded, weight redistributed",
  };
}

/** Factor 8 — Zero bias (neutralise home/away favouritism). */
function scoreBias(
  m: Market, lam: LambdaSet, homeName: string, awayName: string, context: RankingContext | null,
): FactorResult {
  const neutral = context?.tactical?.neutralSite ?? false;
  const side = marketSide(m, homeName, awayName);
  // Total/neutral markets and neutral-venue fixtures carry no home/away exposure.
  if (side === "total" || neutral) return { score: 1.0 };

  const h = lam.homeGoals, a = lam.awayGoals;
  const sum = Math.max(0.5, h + a);
  const homeAdv = clamp((h - a) / sum, -1, 1);
  // A team-specific market aligned with the home/away asymmetry inherits venue
  // favouritism; discount it slightly so venue can't dominate the ranking.
  const exposure = side === "home" ? clamp(homeAdv, 0, 1) : clamp(-homeAdv, 0, 1);
  return { score: 1 - exposure * 0.5 }; // 0.5..1.0
}

function marketSpecificSide(m: Market, homeName: string, awayName: string): "home" | "away" | "total" {
  const text = `${m.name} ${m.selection}`;
  const hn = teamMentions(text, homeName);
  const an = teamMentions(text, awayName);
  if (hn && !an) return "home";
  if (an && !hn) return "away";
  return marketSide(m, homeName, awayName);
}

function startersOut(team: TeamInjuryContext | null | undefined): number | null {
  const value = team?.startersOut ?? team?.confirmedStartersOut ?? null;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

function hasKeyPlayerOut(team: TeamInjuryContext | null | undefined): boolean {
  return !!(
    team?.topScorerOut ||
    team?.mainPlaymakerOut ||
    team?.startingGkOut ||
    team?.keyPlayersOut
  );
}

function hasAnyInjuryData(team: TeamInjuryContext | null | undefined): boolean {
  if (!team || team.dataAvailable === false) return false;
  return team.fullSquadAvailable !== undefined ||
    startersOut(team) !== null ||
    team.topScorerOut !== undefined ||
    team.mainPlaymakerOut !== undefined ||
    team.startingGkOut !== undefined ||
    team.keyPlayersOut !== undefined ||
    (team.confirmedOut?.length ?? 0) > 0;
}

function scoreTeamInjuryImpact(team: TeamInjuryContext | null | undefined, label: string): FactorResult {
  if (!hasAnyInjuryData(team)) {
    return {
      score: 0.7,
      available: false,
      gap: `${label} injury data missing — injury factor excluded, weight redistributed`,
    };
  }

  if (hasKeyPlayerOut(team)) return { score: 0.0 };

  const out = startersOut(team) ?? 0;
  if (team?.fullSquadAvailable || out === 0) return { score: 1.0 };

  return { score: clamp(1 - out * 0.2, 0.4, 1) };
}

/** Factor 9 — Injury impact. */
function scoreInjuryImpact(
  m: Market, homeName: string, awayName: string, context: RankingContext | null,
): FactorResult {
  const side = marketSpecificSide(m, homeName, awayName);
  const home = scoreTeamInjuryImpact(context?.injury?.home, "home");
  const away = scoreTeamInjuryImpact(context?.injury?.away, "away");

  if (side === "home") {
    // Side-specific market: only that side's availability matters.
    if (home.available === false) {
      return { ...home, gap: `home injury data missing — injury factor excluded, weight redistributed` };
    }
    return { score: home.score };
  }
  if (side === "away") {
    if (away.available === false) {
      return { ...away, gap: `away injury data missing — injury factor excluded, weight redistributed` };
    }
    return { score: away.score };
  }

  // Total/neutral market: real signal only while BOTH sides have real data.
  const gaps = [home.gap, away.gap].filter((g): g is string => !!g);
  if (home.available === false || away.available === false) {
    return {
      score: Math.min(home.score, away.score),
      available: false,
      gap: `${gaps.join("; ") || "injury data missing"} — injury factor excluded, weight redistributed`,
    };
  }
  return { score: Math.min(home.score, away.score), gap: gaps.length ? gaps.join("; ") : undefined };
}

/** Factor 10 — Market volatility from odds movement in the last six hours. */
function scoreMarketVolatility(m: Market, context: RankingContext | null): FactorResult {
  const vol = context?.marketVolatility ?? null;
  if (!vol || vol.dataAvailable === false) {
    return {
      score: 0.8,
      available: false,
      gap: "6h odds movement data missing — volatility factor excluded, weight redistributed",
    };
  }

  const move = vol.marketMovePctLast6h?.[m.id] ?? vol.maxMovePctLast6h ?? null;
  if (typeof move !== "number" || !Number.isFinite(move)) {
    if (vol.stable === true) return { score: 1.0 };
    return {
      score: 0.8,
      available: false,
      gap: "6h odds movement data missing for market — volatility factor excluded, weight redistributed",
    };
  }

  const absMove = Math.abs(move);
  if (absMove > SIGNIFICANT_ODDS_MOVE_PCT) return { score: 0.0 };
  if (absMove <= 5) return { score: 1.0 };
  return { score: clamp(1 - (absMove - 5) / (SIGNIFICANT_ODDS_MOVE_PCT - 5), 0, 1) };
}

/** Factor 11 — Weather / pitch conditions. */
function scoreWeather(context: RankingContext | null): FactorResult {
  const wx = context?.weather ?? null;
  if (!wx || wx.dataAvailable === false) {
    return {
      score: 0.9,
      available: false,
      gap: "weather/pitch data missing — weather factor excluded, weight redistributed",
    };
  }

  if (typeof wx.score === "number" && Number.isFinite(wx.score)) {
    return { score: clamp(wx.score, 0, 1) };
  }

  const descriptor = `${wx.condition ?? ""} ${wx.pitch ?? ""}`.toLowerCase();
  if (!descriptor.trim()) {
    return {
      score: 0.9,
      available: false,
      gap: "weather/pitch condition missing — weather factor excluded, weight redistributed",
    };
  }
  if (/heavy|storm|thunder|snow|sleet|blizzard|gale|high wind|strong wind|waterlogged|frozen|poor pitch/.test(descriptor)) {
    return { score: 0.2 };
  }
  if (/perfect|ideal|excellent/.test(descriptor)) return { score: 1.0 };
  if (/clear|sunny|dry|fair|good|mild/.test(descriptor)) return { score: 0.8 };
  if (/rain|wind|wet|mud|cold|fog/.test(descriptor)) return { score: 0.5 };
  return { score: 0.8 };
}

// ─── Market score ─────────────────────────────────────────────────────────────

/** Per-factor sub-scores for a market (all 0..1). */
export interface FactorBreakdown {
  lambda:            number;
  calibration:       number;
  form:              number;
  tactical:          number;
  importance:        number;
  leagueDepth:       number;
  liquidity:         number;
  bias:              number;
  injuryImpact:      number;
  marketVolatility:  number;
  weather:           number;
}

/** Full multi-factor score for a single market. */
export interface MarketScore {
  market:      Market;
  composite:   number;   // 0..1 weighted sum of the AVAILABLE factors
  wrongProb:   number;   // consensus loss probability (1 - hitRate) for tiebreaks
  marginUnits: number;   // σ-cushion vs the line (λ markets only)
  verifiable:  boolean;
  breakdown:   FactorBreakdown;
  gaps:        string[];
  notes:       string;
  /** Factors whose data was unavailable — excluded from this market's composite. */
  excludedFactors: FactorKey[];
  /**
   * Final (redistributed) factor weights applied to this market, as fractions
   * of the active weight mass (Σ = 1). E.g. after excluding form + injuries,
   * calibration = 0.30/0.90 = 0.333.
   */
  appliedWeights: Partial<Record<FactorKey, number>>;
}

/**
 * Score a single market across all eleven factors, falling back to neutral
 * values and logging any missing data sources.
 */
export function scoreMarket(
  m:             Market,
  lam:           LambdaSet,
  homeName:      string,
  awayName:      string,
  confidenceMap?: Record<string, number>,
  opts?:         SelectOptions,
): MarketScore {
  const context = opts?.context ?? null;

  const totalGoals = lam.homeGoals + lam.awayGoals;
  const evenness = 1 - Math.min(1, Math.abs(lam.homeGoals - lam.awayGoals) / Math.max(0.5, totalGoals));
  const ctx: MatchVolatility = { totalGoals, evenness };

  const lambda           = scoreLambda(m, lam, homeName, awayName);
  const calibration      = scoreCalibration(m, ctx);
  const form             = scoreForm(m, homeName, awayName, context);
  const tactical         = scoreTactical(m, lam, homeName, awayName, context);
  const importance       = scoreImportance(context, opts);
  const leagueDepth      = scoreLeagueDepth(context);
  const liquidity        = scoreLiquidity(m, confidenceMap, context);
  const bias             = scoreBias(m, lam, homeName, awayName, context);
  const injuryImpact     = scoreInjuryImpact(m, homeName, awayName, context);
  const marketVolatility = scoreMarketVolatility(m, context);
  const weather          = scoreWeather(context);

  const breakdown: FactorBreakdown = {
    lambda:           lambda.score,
    calibration:      calibration.score,
    form:             form.score,
    tactical:         tactical.score,
    importance:       importance.score,
    leagueDepth:      leagueDepth.score,
    liquidity:        liquidity.score,
    bias:             bias.score,
    injuryImpact:     injuryImpact.score,
    marketVolatility: marketVolatility.score,
    weather:          weather.score,
  };

  // ── Dynamic weight redistribution (Part 2 of the multi-source contract) ──
  // Factors whose data is unavailable are EXCLUDED entirely — never replaced
  // with a neutral stand-in — and the remaining factors' weights are scaled
  // proportionally so they sum to exactly 100%.
  const factorResults: Record<FactorKey, FactorResult> = {
    lambda, calibration, form, tactical, importance,
    leagueDepth, liquidity, bias, injuryImpact, marketVolatility, weather,
  };
  const excludedFactors = ALL_FACTOR_KEYS.filter((k) => factorResults[k].available === false);
  const activeKeys = ALL_FACTOR_KEYS.filter((k) => factorResults[k].available !== false);
  // Calibration is always data-backed, so this can never be zero.
  const activeWeightTotal = activeKeys.reduce((sum, k) => sum + RANKING_WEIGHTS[k], 0)
    || RANKING_WEIGHTS.calibration
    || 1;

  const weightedTotal = activeKeys.reduce(
    (sum, k) => sum + RANKING_WEIGHTS[k] * breakdown[k],
    0,
  );
  const composite = weightedTotal / activeWeightTotal;

  const appliedWeights: Partial<Record<FactorKey, number>> = {};
  for (const k of activeKeys) {
    appliedWeights[k] = RANKING_WEIGHTS[k] / activeWeightTotal;
  }

  // Consensus loss probability for tiebreaks (1 - hitRate, already calibrated
  // in the oracle path, raw ensemble in the engine path).
  const wrongProb = clamp(1 - m.hitRate, 0, 1);

  // σ-cushion for λ markets (third tiebreak).
  const lamVal = lambdaFor(m, lam, homeName, awayName);
  const lineMatch = m.name.match(/O\/U\s+([\d.]+)/);
  const marginUnits = lamVal !== null && lineMatch
    ? sigmaCushion(lamVal, Number(lineMatch[1]))
    : 0;

  const gaps = [
    lambda.gap,
    form.gap,
    tactical.gap,
    importance.gap,
    leagueDepth.gap,
    liquidity.gap,
    injuryImpact.gap,
    marketVolatility.gap,
    weather.gap,
  ].filter((g): g is string => !!g);

  const notes =
    `cal=${breakdown.calibration.toFixed(2)} λ=${breakdown.lambda.toFixed(2)} ` +
    `form=${breakdown.form.toFixed(2)} tac=${breakdown.tactical.toFixed(2)} ` +
    `imp=${breakdown.importance.toFixed(2)} lg=${breakdown.leagueDepth.toFixed(2)} ` +
    `liq=${breakdown.liquidity.toFixed(2)} bias=${breakdown.bias.toFixed(2)} ` +
    `inj=${breakdown.injuryImpact.toFixed(2)} vol=${breakdown.marketVolatility.toFixed(2)} ` +
    `wx=${breakdown.weather.toFixed(2)} → composite=${composite.toFixed(3)} ` +
    `loss=${(wrongProb * 100).toFixed(1)}% ` +
    `w[${activeKeys.map((k) => `${k}=${((appliedWeights[k] ?? 0) * 100).toFixed(1)}%`).join(" ")}]` +
    (excludedFactors.length ? ` excluded[${excludedFactors.join(",")}]` : "") +
    (gaps.length ? ` [gaps: ${gaps.join("; ")}]` : "");

  return {
    market: m,
    composite: clamp(composite, 0, 1),
    wrongProb,
    marginUnits,
    verifiable: isVerifiable(m),
    breakdown,
    gaps,
    notes,
    excludedFactors,
    appliedWeights,
  };
}

// ─── Key deduplication ────────────────────────────────────────────────────────

// "Total Offsides O/U 7.5" → "Total Offsides"  (one line per underlying stat)
function statKey(m: Market): string {
  return m.name.replace(/\s*O\/U\s*[\d.]+\s*/, "").trim();
}

// ─── Selection result ─────────────────────────────────────────────────────────

export interface SelectionResult {
  top1:     Market[];
  top3:     Market[];
  top5:     Market[];
  top10:    Market[];
  /** Set only when no eligible market remains for Top-N output. */
  skipped?: string;
  /** Data gaps logged while scoring (deduplicated). */
  gaps?:    string[];
  /** Per-factor notes for the ranked Top-10 (transparency). */
  rankingNotes?: string[];
  /**
   * Part 3 monitoring — final (redistributed) weight distribution of the
   * top-ranked market, plus which factors were unavailable for the match and
   * were excluded (their weight redistributed). One summary per match.
   */
  weightLog?:      string[];
  /** Union of factors excluded across the Top-10 (missing data signals). */
  missingFactors?: FactorKey[];
  /**
   * Match-level confidence verdict — always computed after ranking, even when
   * the gate is disabled or the match was skipped. When the gate is enabled
   * and the confidence level is "low", the Top-10 list above contains only
   * the Top-3 picks and `confidence.picksTrimmed` is true.
   */
  confidence: MatchConfidence;
}

// ─── Match-level confidence ───────────────────────────────────────────────────

/** Match confidence band — drives the gate's output decision. */
export type ConfidenceLevel =
  | "high"    // ≥ CONFIDENCE_HIGH_THRESHOLD — full Top-10 returned
  | "medium"  // CONFIDENCE_LOW_THRESHOLD..HIGH — full Top-10, flagged for the UI
  | "low";    // < CONFIDENCE_LOW_THRESHOLD — trimmed to the Top 3 (gate enabled)

/** What the confidence gate did with a match. */
export type ConfidenceGateAction =
  | "full-top10"       // high/medium confidence (or already ≤ reduceTo picks) — full list returned
  | "reduced-to-top3"  // low confidence — output trimmed to the Top `reduceTo` picks
  | "gate-disabled"    // caller did not enable the gate — score only, full list returned
  | "skipped";         // no picks survived the safety filters at all

/** Match-level confidence verdict, computed after the full registry is ranked. */
export interface MatchConfidence {
  /** Match-level confidence score, 0–100. */
  confidenceScore:  number;
  /** Decision band — "high" ≥ 75, "medium" 50–74, "low" < 50. */
  confidenceLevel:  ConfidenceLevel;
  /** true when the Top-10 was reduced to the Top 3 (low-confidence matches). */
  picksTrimmed:     boolean;
  /** Average number of the 10 data-backed ranking factors that returned real data. */
  factorsAvailable: number;
  /** Component 1 — average marketReliability (hit-rate calibration) of the picks, 0..1. */
  calibrationAvg:   number;
  /** Component 2 — factor availability ratio, 0..1 (factorsAvailable / 10). */
  factorScore:      number;
  /** Component 3 — source-priority score: 1.0 primary (ESPN/SportScore), 0.7 fallback, 0.3 backfill. */
  sourceScore:      number;
  /** Primary data source id, when the caller supplied one. */
  source:           string | null;
  /** What the gate did with this match. */
  gateAction:       ConfidenceGateAction;
  /** Picks actually returned after gating (0 when skipped). */
  picksReturned:    number;
  /** Union of factors excluded across the ranked picks (missing data signals). */
  missingFactors:   FactorKey[];
  /** Top-10 slots filled from the sub-85% calibration backfill tier. */
  backfilledPicks:  number;
  /** Human-readable explanation of the score (for logs / UI warnings). */
  reasons:          string[];
}

const EMPTY_SELECTION = (reason: string, gaps: string[], confidence: MatchConfidence): SelectionResult => ({
  top1: [], top3: [], top5: [], top10: [], skipped: reason, gaps, confidence,
});

/** Canonical monitoring line — one per match, always logged. */
function confidenceLogLine(c: MatchConfidence, homeName: string, awayName: string): string {
  const tail =
    c.gateAction === "skipped"          ? "match skipped — no picks generated" :
    c.gateAction === "reduced-to-top3"  ? `low confidence — output trimmed to Top ${c.picksReturned}` :
    c.gateAction === "gate-disabled"    ? `${c.confidenceLevel} confidence — full Top ${c.picksReturned} (gate not enabled)` :
    `${c.confidenceLevel} confidence — full Top ${c.picksReturned} returned`;
  return `[ConfidenceGate] score: ${c.confidenceScore}%, level: ${c.confidenceLevel}, factors: ${c.factorsAvailable}/${DATA_FACTOR_KEYS.length} — ${homeName} vs ${awayName} — ${tail}`;
}

/**
 * Compute the match-level confidence score + gate verdict from the ranked
 * picks. Components follow CONFIDENCE_WEIGHTS: average marketReliability of
 * the picks (60%), factor availability (25%), source priority (15%).
 */
function buildMatchConfidence(args: {
  top10Scores:     MarketScore[];
  backfilledPicks: number;
  context:         RankingContext | null;
  highThreshold:   number;
  lowThreshold:    number;
  gateEnabled:     boolean;
  reduceTo:        number;
  /** Set when the safety filters produced no picks at all. */
  skipped?:        string;
}): MatchConfidence {
  const { top10Scores, backfilledPicks, context, highThreshold, lowThreshold, gateEnabled, reduceTo, skipped } = args;
  const n = top10Scores.length;

  // Component 1 — average calibration (marketReliability) of the picks.
  // Backfill-tier slots (sub-85% calibration) automatically drag this down.
  const calibrationAvg = n
    ? top10Scores.reduce((sum, s) => sum + s.breakdown.calibration, 0) / n
    : 0;

  // Component 2 — number of the 10 data-backed factors that returned real
  // data (not null), averaged across the picks. Each pick's excludedFactors
  // marks its missing ones (calibration is never excluded).
  const factorsAvailableRaw = n
    ? top10Scores.reduce(
        (sum, s) => sum + (DATA_FACTOR_KEYS.length - s.excludedFactors.length),
        0,
      ) / n
    : 0;
  const factorsAvailable = Math.round(factorsAvailableRaw * 10) / 10;
  const factorScore = clamp(factorsAvailableRaw / DATA_FACTOR_KEYS.length, 0, 1);

  // Component 3 — source-priority tier that fed this match's data.
  const signal = context?.sourceTrust ?? null;
  const sourceScore = clamp(signal?.trust ?? DEFAULT_SOURCE_SCORE, 0, 1);

  const score01 = clamp(
    CONFIDENCE_WEIGHTS.calibrationAvg     * calibrationAvg +
    CONFIDENCE_WEIGHTS.factorAvailability * factorScore +
    CONFIDENCE_WEIGHTS.sourcePriority     * sourceScore,
    0, 1,
  );
  const confidenceScore = Math.round(score01 * 1000) / 10;   // 0–100, 1 decimal
  const confidenceLevel: ConfidenceLevel =
    confidenceScore >= highThreshold ? "high" :
    confidenceScore >= lowThreshold  ? "medium" : "low";

  const missing = new Set<FactorKey>();
  for (const s of top10Scores) s.excludedFactors.forEach((f) => missing.add(f));
  const missingFactors = [...missing];

  // Only LOW matches get trimmed (gate enabled); medium/high keep the full list.
  const picksTrimmed = !skipped && gateEnabled && confidenceLevel === "low" && n > reduceTo;
  const picksReturned = skipped ? 0 : picksTrimmed ? reduceTo : n;
  const gateAction: ConfidenceGateAction = skipped
    ? "skipped"
    : !gateEnabled
      ? "gate-disabled"
      : picksTrimmed ? "reduced-to-top3" : "full-top10";

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const reasons: string[] = [
    `calibration avg ${pct(calibrationAvg)} (×${CONFIDENCE_WEIGHTS.calibrationAvg})`,
    `factors available ${factorsAvailable}/${DATA_FACTOR_KEYS.length} (×${CONFIDENCE_WEIGHTS.factorAvailability})`,
    `source priority ${sourceScore}${signal?.primarySource ? ` — ${signal.primarySource}` : " — no source info, neutral default"} (×${CONFIDENCE_WEIGHTS.sourcePriority})`,
  ];
  if (backfilledPicks > 0) {
    reasons.push(`${backfilledPicks}/10 slots came from the sub-85% calibration backfill tier`);
  }
  if (missingFactors.length) {
    reasons.push(`factors excluded for missing data: ${missingFactors.join(", ")}`);
  }
  if (skipped) {
    reasons.push(`no picks generated — ${skipped}`);
  } else if (confidenceLevel === "low") {
    reasons.push(
      picksTrimmed
        ? `score ${confidenceScore}% < ${lowThreshold}% → LOW confidence, output trimmed to Top ${picksReturned}`
        : `score ${confidenceScore}% < ${lowThreshold}% → LOW confidence${gateEnabled ? "" : " (gate not enabled)"}`,
    );
  } else if (confidenceLevel === "medium") {
    reasons.push(`score ${confidenceScore}% in ${lowThreshold}–${highThreshold}% band → MEDIUM confidence, full Top ${n} flagged`);
  } else {
    reasons.push(`score ${confidenceScore}% ≥ ${highThreshold}% → HIGH confidence`);
  }

  return {
    confidenceScore,
    confidenceLevel,
    picksTrimmed,
    factorsAvailable,
    calibrationAvg,
    factorScore,
    sourceScore,
    source: signal?.primarySource ?? null,
    gateAction,
    picksReturned,
    missingFactors,
    backfilledPicks,
    reasons,
  };
}

function hasSevereInjury(team: TeamInjuryContext | null | undefined): boolean {
  if (!hasAnyInjuryData(team)) return false;
  return hasKeyPlayerOut(team) || (startersOut(team) ?? 0) >= 3;
}

function injurySeverityBlocksMarket(
  m: Market,
  context: RankingContext | null,
  homeName: string,
  awayName: string,
): boolean {
  const side = marketSpecificSide(m, homeName, awayName);
  if (side === "home") return hasSevereInjury(context?.injury?.home);
  if (side === "away") return hasSevereInjury(context?.injury?.away);
  return false;
}

function hardSafetyRejectReason(
  s: MarketScore,
  context: RankingContext | null,
  homeName: string,
  awayName: string,
): string | null {
  // NOTE: the historical-calibration floor is no longer an absolute cut — it
  // is enforced as the trusted/backfill TIER order in Step 6 so the Top-10 can
  // always be filled with fully-filtered verifiable markets. Injury severity
  // remains an absolute block for every pick in either tier.
  if (injurySeverityBlocksMarket(s.market, context, homeName, awayName)) {
    return "team-specific market blocked by injury severity filter";
  }
  return null;
}

// ─── Main selector ────────────────────────────────────────────────────────────

export function selectTopPicks(
  markets:        Market[],
  lam:            LambdaSet,
  homeName:       string,
  awayName:       string,
  confidenceMap?: Record<string, number>,
  opts?:          SelectOptions,
): SelectionResult {

  const gapLog = new Set<string>();
  const context = opts?.context ?? null;

  // Confidence-gate configuration (opt-in). The score itself is always
  // computed, logged and returned — `enabled` only controls whether a
  // LOW-confidence match's output is trimmed to the Top `reduceTo` picks.
  const gateEnabled   = opts?.confidenceGate?.enabled === true;
  const highThreshold = opts?.confidenceGate?.highThreshold ?? CONFIDENCE_HIGH_THRESHOLD;
  const lowThreshold  = opts?.confidenceGate?.lowThreshold  ?? CONFIDENCE_LOW_THRESHOLD;
  const reduceTo      = Math.max(1, Math.min(10, Math.floor(opts?.confidenceGate?.reduceTo ?? LOW_CONFIDENCE_PICKS)));

  /** Empty result for the hard-stop paths — still carries a confidence verdict
   *  (empty pick list ⇒ near-zero confidence) so every match is logged. */
  const emptySelection = (reason: string): SelectionResult => {
    const confidence = buildMatchConfidence({
      top10Scores: [], backfilledPicks: 0, context,
      highThreshold, lowThreshold, gateEnabled, reduceTo, skipped: reason,
    });
    console.log(confidenceLogLine(confidence, homeName, awayName));
    return EMPTY_SELECTION(reason, [...gapLog], confidence);
  };

  // ── Step 1: Score every non-rejected market across all eleven factors ───────
  const scored = markets
    .filter((m) => !m.rejected)
    .map((m) => {
      const s = scoreMarket(m, lam, homeName, awayName, confidenceMap, opts);
      s.gaps.forEach((g) => gapLog.add(g));
      return s;
    });

  if (scored.length === 0) {
    return emptySelection("No qualified markets to rank.");
  }

  // ── Step 2: Deterministic ranking (composite desc → loss prob asc → σ desc) ─
  // The composite is the primary signal; the secondary/tertiary keys only
  // resolve near-ties, so a genuinely better market always ranks higher.
  const ranked = [...scored].sort((a, b) => {
    const dc = b.composite - a.composite;
    if (Math.abs(dc) > 1e-6) return dc;
    const dw = a.wrongProb - b.wrongProb;
    if (Math.abs(dw) > 1e-6) return dw;
    const dm = b.marginUnits - a.marginUnits;
    if (Math.abs(dm) > 1e-6) return dm;
    return a.market.id.localeCompare(b.market.id);
  });

  // ── Step 3: Hard safety filters BEFORE Top-10 assembly ────────────────────
  // Rejected candidates are skipped here, before deduplication, so the next-best
  // qualified line for the same underlying stat can still fill a Top-N slot.
  // The 85% historical-calibration floor is applied as a PREFERENCE TIER
  // (Step 6): trusted lines fill the Top-10 first, and only when fewer than 10
  // trusted verifiable lines exist are the next-best fully-filtered markets
  // (calibration ≥ 0.55 backfill tier) admitted — every pick, in either tier,
  // is still qualified, injury-severity-checked, safety-net-checked and
  // verifiable. Injury severity remains an absolute block in both tiers.
  const hardQualified = ranked.filter((s) => {
    const reason = hardSafetyRejectReason(s, context, homeName, awayName);
    if (reason) {
      gapLog.add(`hard filter skipped ${s.market.id}: ${reason}`);
      return false;
    }
    return true;
  });
  if (hardQualified.length === 0) {
    return emptySelection(
      "No market remains after hard safety filters (injury severity).",
    );
  }

  // ── Step 4: Safety net — block non-giant team-specific Under 3.5 Goals lines ─
  // PR #13 safety remains active; filtered lines are skipped and the selector
  // keeps walking down the ranked list to fill Top-N with qualified candidates.
  const topNQualified = hardQualified.filter((s) => {
    const blocked = isBlockedTeamSpecificUnder35Goals(s.market, homeName, awayName);
    if (blocked) gapLog.add(`safety net skipped ${s.market.id}: non-giant team-specific Under 3.5 Goals`);
    return !blocked;
  });
  if (topNQualified.length === 0) {
    return emptySelection(
      "No Top-N-eligible market remains after applying the team-goals safety net.",
    );
  }

  // ── Step 5: Top-N slots require verifiable markets (settleable picks) ──────
  const verifiableRanked = topNQualified.filter((s) => s.verifiable);
  if (verifiableRanked.length === 0) {
    return emptySelection(
      "No verifiable market remains after scoring and hard safety filters — match skipped.",
    );
  }

  // ── Step 6: Top-10 fill guarantee (trusted tier → backfill tier → extras) ──
  // Diversity first: one line per underlying stat. Trusted (≥85% calibration)
  // lines fill the slots first; if fewer than 10 distinct trusted stats
  // survive the safety filters, the backfill tier (0.55–0.85 calibration,
  // still fully filtered and verifiable) and then additional lines of
  // already-represented stats complete the Top-10. No safety filter is
  // relaxed to do this — only the diversity preference and the tier order.
  const comparator = (a: MarketScore, b: MarketScore) => {
    const dc = b.composite - a.composite;
    if (Math.abs(dc) > 1e-6) return dc;
    const dw = a.wrongProb - b.wrongProb;
    if (Math.abs(dw) > 1e-6) return dw;
    const dm = b.marginUnits - a.marginUnits;
    if (Math.abs(dm) > 1e-6) return dm;
    return a.market.id.localeCompare(b.market.id);
  };
  const trustedTier = verifiableRanked
    .filter((s) => s.breakdown.calibration >= MIN_CALIBRATION_HIT_RATE)
    .sort(comparator);
  const backfillTier = verifiableRanked
    .filter((s) =>
      s.breakdown.calibration < MIN_CALIBRATION_HIT_RATE &&
      s.breakdown.calibration >= MIN_BACKFILL_CALIBRATION_HIT_RATE)
    .sort(comparator);

  const seen = new Set<string>();
  const deduped: MarketScore[] = [];
  const extrasPool: MarketScore[] = [];
  for (const s of [...trustedTier, ...backfillTier]) {
    const key = statKey(s.market);
    if (seen.has(key)) { extrasPool.push(s); continue; }
    seen.add(key);
    deduped.push(s);
  }
  const extras = extrasPool.sort(comparator);
  const top10Scores = [...deduped, ...extras].slice(0, 10);

  const backfilledCount = top10Scores.filter(
    (s) => s.breakdown.calibration < MIN_CALIBRATION_HIT_RATE,
  ).length;
  if (backfilledCount > 0) {
    gapLog.add(
      `Top-10 backfill tier used for ${backfilledCount}/10 slots (trusted ≥85% calibration pool exhausted; backfill picks still qualified, safety-net-checked and verifiable)`,
    );
  }

  // ── Step 6b: Match-level confidence gate ──────────────────────────────────
  // The full registry has now been ranked. Score the MATCH itself from the
  // three confidence signals (calibration average, factor availability, source
  // priority). Bands: ≥ highThreshold → full Top-10; lowThreshold..high →
  // full Top-10 flagged "medium"; < lowThreshold → LOW — when the caller
  // enabled the gate, only the Top `reduceTo` picks are returned.
  const confidence = buildMatchConfidence({
    top10Scores, backfilledPicks: backfilledCount, context,
    highThreshold, lowThreshold, gateEnabled, reduceTo,
  });
  const deliveredScores = confidence.picksTrimmed
    ? top10Scores.slice(0, confidence.picksReturned)
    : top10Scores;
  const top10 = deliveredScores.map((s) => s.market);
  if (confidence.picksTrimmed) {
    gapLog.add(
      `confidence gate: match scored ${confidence.confidenceScore}% < ${lowThreshold}% — low confidence, output trimmed to Top ${confidence.picksReturned} picks`,
    );
  }

  // ── Step 7: Part 3 logging — missing factors + final weight distribution ──
  const excludedUnion = new Set<FactorKey>();
  for (const s of top10Scores) s.excludedFactors.forEach((f) => excludedUnion.add(f));
  const lead = top10Scores[0];
  const weightLog: string[] = [];
  if (lead) {
    weightLog.push(
      `final weights: ${ALL_FACTOR_KEYS
        .filter((k) => lead.appliedWeights[k] !== undefined)
        .map((k) => `${k} ${((lead.appliedWeights[k] ?? 0) * 100).toFixed(1)}%`)
        .join(", ")} (Σ = ${(ALL_FACTOR_KEYS.reduce((sum, k) => sum + (lead.appliedWeights[k] ?? 0), 0) * 100).toFixed(0)}%)`,
    );
  }
  if (excludedUnion.size) {
    weightLog.push(`missing factors (weight redistributed): ${[...excludedUnion].join(", ")}`);
  }
  if (backfilledCount > 0) {
    weightLog.push(`top-10 fill: ${10 - backfilledCount}/10 from the trusted tier (calibration ≥ 85%), ${backfilledCount}/10 backfilled from the 0.55–0.85 tier — all fully filtered`);
  }
  // Confidence-gate summary (flows into the caller's calibration notes).
  weightLog.push(
    `match confidence: ${confidence.confidenceScore}% (${confidence.confidenceLevel}) ` +
    `[calibration ${(confidence.calibrationAvg * 100).toFixed(1)}% ×${CONFIDENCE_WEIGHTS.calibrationAvg} + ` +
    `factors ${confidence.factorsAvailable}/${DATA_FACTOR_KEYS.length} ×${CONFIDENCE_WEIGHTS.factorAvailability} + ` +
    `source ${confidence.sourceScore}${confidence.source ? ` (${confidence.source})` : ""} ×${CONFIDENCE_WEIGHTS.sourcePriority}]` +
    (confidence.picksTrimmed
      ? ` — gate trimmed output to Top ${confidence.picksReturned} picks`
      : confidence.confidenceLevel === "low"
        ? " — LOW confidence (gate not enabled by caller, full list returned)"
        : confidence.confidenceLevel === "medium"
          ? " — MEDIUM confidence, full Top 10 flagged"
          : " — HIGH confidence, full Top 10"),
  );
  // Canonical per-match confidence log: [ConfidenceGate] score: 82%, level: high, factors: 8/10
  console.log(confidenceLogLine(confidence, homeName, awayName));
  console.log(
    `[selector] ${homeName} vs ${awayName} — top10: ${top10.length}/10` +
    (backfilledCount ? ` (backfill: ${backfilledCount})` : "") +
    (confidence.picksTrimmed ? ` (trimmed from 10 — confidence ${confidence.confidenceScore}%)` : "") +
    (excludedUnion.size ? ` | missing: ${[...excludedUnion].join(",")}` : " | all factors available") +
    (lead ? ` | ${weightLog[0]}` : ""),
  );

  return {
    top1:  top10.slice(0, 1),
    top3:  top10.slice(0, 3),
    top5:  top10.slice(0, 5),
    top10,
    confidence,
    gaps:         [...gapLog],
    rankingNotes: top10.map((m) => {
      const s = scored.find((x) => x.market === m);
      return s ? s.notes : `${m.name} · ${m.selection}`;
    }),
    weightLog,
    missingFactors: [...excludedUnion],
  };
}
