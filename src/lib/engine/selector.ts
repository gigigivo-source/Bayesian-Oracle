// ĞIGI GIVØ — Multi-Factor Market Selector
//
// Balanced 12-factor composite ranking. Every generated market is scored
// across twelve independent signals — all computed from REAL data supplied by
// the multi-source stats aggregator and the enrichment pipeline (never
// simulated values) — and ranked by the weighted composite. The composite is
// monotonic: a market with a higher composite is expected to have a higher
// true outcome probability, so Top-1 is — by construction — the single most
// reliable pick.
//
// FACTOR WEIGHTS (balanced profile, Σ = 100%):
//
//   1. Deep statistical analysis ............. 9%   ← stats aggregator xG / shot quality
//      Advanced-metric evidence (xG, xG-per-shot, SOT, shots) supporting the
//      selected side of the market.
//
//   2. All data mesh ......................... 9%   ← multi-source mesh coverage
//      How many independent real sources contributed (provider count), how
//      much of the enrichment contract they filled, and league-anchor depth.
//
//   3. Stats ................................. 9%   ← stats aggregator + calibration
//      The market's backing stat evidence. The historical hit rate /
//      calibration is only ONE PART of this factor — it never dominates the
//      composite on its own.
//
//   4. Tactical analysis ..................... 8%   ← H2H, formations, venue
//      Head-to-head scoring/result history and formation-mismatch multipliers.
//
//   5. Match importance ...................... 8%   ← derby, title race, relegation
//      Stakes-driven predictability (knockouts/derbies > dead rubbers).
//
//   6. Player vs player forms ................ 8%   ← injuries + formation duels
//      Key-player availability (injury feed) and individual matchup edges
//      (attacking vs defensive formation duels).
//
//   7. Deep statistical vector ............... 8%   ← per-team expected profiles
//      Directional support of the per-team deep profile (λ vector) for the
//      selected side/line.
//
//   8. Zero bias ............................. 8%   ← neutralise home/away favouritism
//      Penalises team-specific markets leaning on venue asymmetry; totals and
//      neutral-venue fixtures score fully.
//
//   9. Form .................................. 8%   ← team form (aggregator/ESPN)
//      Recent results momentum mapped directionally onto the market.
//
//  10. Conditional λ values .................. 8%   ← λ conditioned on real stats
//      Margin of the real-stat-conditioned λ against the line; excluded when
//      the market's backing stat is missing from the aggregator.
//
//  11. Poisson ............................... 8%   ← Poisson tail probability
//      P(selection wins) under the Poisson model for the expected event rate.
//
//  12. Statistics all states filled .......... 9%   ← canonical stats completeness
//      Share of all canonical stat fields actually filled by the aggregator
//      for both teams.
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
//
// CONFIDENCE GATE (match-level, applied AFTER ranking — see Step 8)
//   Ranking picks the best markets FOR a match; the gate decides whether the
//   match itself is worth betting. A 0..1 confidence score blends:
//     · 50% mean calibration / historical hit rate of the returned picks
//     · 30% factor coverage (share of ranking weight backed by real data)
//     · 20% source priority (ESPN/SportScore = high, official league APIs =
//           medium, free aggregators = low) discounted by backfill-tier usage
//   plus a depth discount when fewer than 10 qualified verifiable picks exist.
//   Below the threshold (default 75%) the match is marked low confidence and,
//   depending on the caller's policy, either flagged (full Top-10 + a
//   `confidence` block for the UI warning), trimmed to the Top-3, or skipped.
//   Every match logs one `[selector][confidence]` line for monitoring.
//
// CONTEXTUAL TOP-1 BAN FOR HIGH-LINE UNDERS (Part 1, applied AFTER the gate —
// see Step 9)
//   Total Goals / Team Goals "Under X.5" (X ≥ 4) markets are demoted out of
//   the Top-1 slot when the match carries an explosion risk: effective
//   combined xG × leagueFactor > 3.5 OR effective recent-avg goals ×
//   leagueFactor > 3.0. The league factor is 1.0 for top-5 leagues, 1.1 for
//   Bundesliga / MLS / Eredivisie and 0.9 for defensive leagues. The inputs
//   come from the caller (`SelectOptions.explosionRisk` — real stats-aggregator
//   xG + real last-5 scoring averages); without them the ban is inert. Blocked
//   markets stay in the Top-N and the next best ranked market takes Top-1.
//
// UNDER 4.5 PROBABILITY CALIBRATION (Part 2, inside scoreMarket)
//   Under 4.5 (Total or Team) markets with a raw hit rate above 0.93 are
//   ranked with adjusted = raw − (raw − 0.93) × 0.4 (e.g. 0.99 → 0.966) in the
//   calibration factor and the loss-probability tiebreak, so the engine stops
//   overvaluing their extreme probabilities.

import { poissonPmf, clamp } from "./stats";
import { marketReliability, type MatchVolatility } from "./calibration";
import type { Market } from "./types";
import type { LambdaSet } from "./lambdas";
import { LEAGUE_ANCHORS, getAnchors } from "./statisticalAnchors";
import { analyseFormationMismatch } from "./players";
import type { OddsInfo } from "../espn";
import {
  STAT_FIELDS,
  nonNullFieldCount,
  type CanonicalMatchStats,
  type StatKey,
} from "../data/types";


// ─── Ranking mode (A = Classic 11-factor, B = 12-factor, C = Hybrid) ─────────
export type RankingMode = 'A' | 'B' | 'C';

export function resolveRankingMode(opts?: SelectOptions): RankingMode {
  const fromOpts = opts?.rankingMode ? String(opts.rankingMode).toUpperCase() : null;
  if (fromOpts === 'A' || fromOpts === 'B' || fromOpts === 'C') return fromOpts as RankingMode;
  const envRaw = (typeof process !== 'undefined' && process.env && process.env.RANKING_MODE) ? String(process.env.RANKING_MODE).toUpperCase() : '';
  if (envRaw === 'A' || envRaw === 'B' || envRaw === 'C') return envRaw as RankingMode;
  return 'B';
}

export function rankingModeLogLine(mode: RankingMode): string {
  if (mode === 'A') return 'Selector Ranking mode: A Classic';
  if (mode === 'B') return 'Selector Ranking mode: B 12-Factor';
  return '[Selector] Ranking mode: C Hybrid';
}

// ─── Classic 11-factor weights (Rank A) ─────────────────────────────────────
export const RANKING_WEIGHTS_CLASSIC = {
  calibration:      0.30, // Calibration / hit rate
  poisson:          0.20, // Poisson lambda
  form:             0.10, // Player / team form
  injury:           0.10, // Injury impact
  volatility:       0.10, // Market volatility
  tactical:         0.05, // Tactical matchup
  importance:       0.05, // Match importance
  leagueDepth:      0.05, // League depth
  marketConfidence: 0.05, // Market confidence / liquidity
  zeroBias:         0.05, // Zero bias
  weather:          0.05, // Weather / pitch
} as const;

export type ClassicFactorKey = keyof typeof RANKING_WEIGHTS_CLASSIC;

export const FACTOR_LABELS_CLASSIC: Record<ClassicFactorKey, string> = {
  calibration:      "Calibration",
  poisson:          "Poisson lambda",
  form:             "Player / team form",
  injury:           "Injury impact",
  volatility:       "Market volatility",
  tactical:         "Tactical matchup",
  importance:       "Match importance",
  leagueDepth:      "League depth",
  marketConfidence: "Market confidence",
  zeroBias:         "Zero bias",
  weather:          "Weather / pitch",
};

const ALL_CLASSIC_KEYS: ClassicFactorKey[] = Object.keys(RANKING_WEIGHTS_CLASSIC) as ClassicFactorKey[];

const TOTAL_CLASSIC_WEIGHT = ALL_CLASSIC_KEYS.reduce((s, k) => s + RANKING_WEIGHTS_CLASSIC[k], 0);


// ─── Factor weights (balanced 12-factor profile, Σ = 100%) ──────────────────

export const RANKING_WEIGHTS = {
  deepStatisticalAnalysis:   0.09,  // advanced metrics (xG / shot quality) — stats aggregator
  allDataMesh:               0.09,  // multi-source mesh coverage + league-anchor depth
  stats:                     0.09,  // backing-stat evidence; hitRate/calibration is only one part
  tacticalAnalysis:          0.08,  // H2H, formations, venue
  matchImportance:           0.08,  // derby / title race / relegation / knockout
  playerVsPlayerForms:       0.08,  // injuries + formation duels
  deepStatisticalVector:     0.08,  // per-team deep profile (λ vector) support
  zeroBias:                  0.08,  // neutralise home/away favouritism
  form:                      0.08,  // team form momentum
  conditionalLambda:         0.08,  // λ conditioned on real canonical stats
  poisson:                   0.08,  // Poisson tail win probability
  statisticsAllStatesFilled: 0.09,  // canonical stats completeness (all fields)
} as const;

/** Factor keys — mirror the fields of RANKING_WEIGHTS. */
export type FactorKey = keyof typeof RANKING_WEIGHTS;

/** Human-readable factor names — the exact keys used by the API `factors` map. */
export const FACTOR_LABELS: Record<FactorKey, string> = {
  deepStatisticalAnalysis:   "Deep statistical analysis",
  allDataMesh:               "All data mesh",
  stats:                     "Stats",
  tacticalAnalysis:          "Tactical analysis",
  matchImportance:           "Match importance",
  playerVsPlayerForms:       "Player vs player forms",
  deepStatisticalVector:     "Deep statistical vector",
  zeroBias:                  "Zero bias",
  form:                      "Form",
  conditionalLambda:         "Conditional λ values",
  poisson:                   "Poisson",
  statisticsAllStatesFilled: "Statistics all states filled",
};

const MIN_CALIBRATION_HIT_RATE = 0.85;
/** Backfill tier floor — used ONLY to complete the Top-10 when the trusted
 *  (≥85%) pool is exhausted. Picks from this tier are still qualified,
 *  injury-severity-checked, safety-net-checked and verifiable. */
const MIN_BACKFILL_CALIBRATION_HIT_RATE = 0.55;

// ─── Contextual Top-1 ban for high-line Unders (Part 1) ─────────────────────
// Total Goals / Team Goals "Under X.5" lines at or above this value
// (Under 4.5, Under 5.5, …) are demoted out of the Top-1 slot when the match
// carries an explosion risk. The filter is DATA-DRIVEN and contextual — the
// caller (oracle.ts) supplies the real risk inputs via `SelectOptions`, and
// when they are absent the ban is inert. There is no permanent hard ban.
const EXPLOSION_MIN_UNDER_LINE = 4.5;
/** Effective combined xG (× league factor) above which a high-line Under is
 *  blocked from the Top-1 slot. */
const EXPLOSION_XG_THRESHOLD = 3.5;
/** Effective recent-average goals (× league factor) above which a high-line
 *  Under is blocked from the Top-1 slot. */
const EXPLOSION_RECENT_GOALS_THRESHOLD = 3.0;

// ─── Under 4.5 probability calibration (Part 2) ──────────────────────────────
// Raw hit rates above this floor are penalised for Under 4.5 (Total or Team)
// markets so the ranking stops overvaluing their extreme probabilities.
const UNDER45_CALIBRATION_FLOOR = 0.93;
/** Share of the excess above the floor that is removed from the hit rate
 *  (adjusted = raw − (raw − floor) × penalty). */
const UNDER45_CALIBRATION_PENALTY = 0.4;

const ALL_FACTOR_KEYS: FactorKey[] = Object.keys(RANKING_WEIGHTS) as FactorKey[];

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

// ─── Contextual ban + calibration helpers (Part 1 & 2) ───────────────────────

function isHalfLine(line: number): boolean {
  return Number.isInteger(line * 2) && (line * 2) % 2 === 1;
}

/** Total Goals or Team Goals "Under X.5" with X >= 4 (Under 4.5, 5.5, …). */
function isHighLineUnderGoals(m: Market): boolean {
  if (!isUnderSelection(m)) return false;
  const lineMatch = m.name.match(/Goals O\/U\s+([\d.]+)/);
  if (!lineMatch) return false;
  const line = Number(lineMatch[1]);
  return Number.isFinite(line) && isHalfLine(line) && line >= EXPLOSION_MIN_UNDER_LINE;
}

/** Total Goals or Team Goals "Under 4.5" (calibration-penalty target, Part 2). */
function isUnder45Goals(m: Market): boolean {
  if (!isUnderSelection(m)) return false;
  const lineMatch = m.name.match(/Goals O\/U\s+([\d.]+)/);
  if (!lineMatch) return false;
  const line = Number(lineMatch[1]);
  return Number.isFinite(line) && Math.abs(line - 4.5) < 1e-9;
}

interface HitRateCalibration {
  /** Hit rate used for ranking (calibration factor + loss-probability tiebreak). */
  effective: number;
  /** True when the Under 4.5 overconfidence penalty was applied. */
  adjusted: boolean;
}

/**
 * Part 2 — Under 4.5 (Total or Team) probability calibration.
 *
 * Extremely high raw hit rates (> 0.93) are pulled down toward the empirical
 * floor before ranking:
 *
 *     adjusted = raw − (raw − 0.93) × 0.4
 *
 * e.g. 0.99 → 0.966 and 0.98 → 0.96, so the engine stops overvaluing these
 * markets in the calibration factor and the loss-probability tiebreak.
 */
function calibratedUnder45HitRate(m: Market): HitRateCalibration {
  if (!isUnder45Goals(m) || m.hitRate <= UNDER45_CALIBRATION_FLOOR) {
    return { effective: m.hitRate, adjusted: false };
  }
  const effective = m.hitRate - (m.hitRate - UNDER45_CALIBRATION_FLOOR) * UNDER45_CALIBRATION_PENALTY;
  return { effective, adjusted: true };
}

/** True when a high-line Under is blocked from Top-1 by the contextual
 *  explosion-risk ban (Part 1). Inert without real risk inputs. */
function explosionRiskBlocked(
  m: Market,
  opts?: SelectOptions,
): boolean {
  const risk = opts?.explosionRisk;
  if (!risk) return false;
  // Scope: Total Goals / Team Goals "Under X.5" with X >= 4 (isHighLineUnderGoals
  // already guarantees the name is a goals O/U line at or above 4.5).
  if (!isHighLineUnderGoals(m)) return false;

  const factor = risk.leagueFactor;
  const effXG = risk.combinedXG != null ? risk.combinedXG * factor : null;
  const effRecent = risk.recentAvgGoals != null ? risk.recentAvgGoals * factor : null;
  if (effXG != null && effXG > EXPLOSION_XG_THRESHOLD) return true;
  if (effRecent != null && effRecent > EXPLOSION_RECENT_GOALS_THRESHOLD) return true;
  return false;
}

/**
 * Part 1 — contextual Top-1 ban (applied AFTER ranking, before the Top-1 slot
 * is finalised). When the highest-ranked pick is a high-line Under on an
 * explosive match, the next best ranked market takes the Top-1 slot instead;
 * the blocked market stays in the Top-N (it is still a valuable pick) and when
 * no alternative exists the first pick is kept — never a permanent hard ban.
 */
function applyTop1ExplosionBan(
  picks: Market[],
  homeName: string,
  awayName: string,
  opts?: SelectOptions,
): Market[] {
  const risk = opts?.explosionRisk;
  if (!risk || picks.length < 2) return picks;

  const ordered = [...picks];
  const firstBlockedIdx = ordered.findIndex((m) => explosionRiskBlocked(m, opts));
  const firstCleanIdx = ordered.findIndex((m) => !explosionRiskBlocked(m, opts));
  if (firstBlockedIdx !== 0 || firstCleanIdx <= 0) return ordered;

  const blocked = ordered[0];
  const [lead] = ordered.splice(firstCleanIdx, 1);
  ordered.unshift(lead);

  const lineMatch = blocked.name.match(/O\/U\s+([\d.]+)/);
  const line = lineMatch ? lineMatch[1] : "?";
  const factor = risk.leagueFactor;
  const effXG = risk.combinedXG != null ? risk.combinedXG * factor : null;
  const effRecent = risk.recentAvgGoals != null ? risk.recentAvgGoals * factor : null;
  console.log(
    `[Selector] Blocked Under ${line} for ${homeName} vs ${awayName} ` +
    `(combinedXG=${effXG != null ? effXG.toFixed(2) : "n/a"}, ` +
    `threshold=${EXPLOSION_XG_THRESHOLD.toFixed(1)}` +
    `${effRecent != null ? ` | recentAvgGoals=${effRecent.toFixed(2)} (threshold=${EXPLOSION_RECENT_GOALS_THRESHOLD.toFixed(1)})` : ""}` +
    ` | leagueFactor=${factor.toFixed(2)})`,
  );
  return ordered;
}

// ─── Canonical stats integration (Part 3) ────────────────────────────────────
//
// The selector is the consumption point for CanonicalMatchStats. When the
// caller supplies `opts.stats`, every λ value is grounded in REAL match stats
// (xG / goals for the goal λ, corners / cards / shots / SOT / fouls / offsides
// / saves / throw-ins from their respective fields) — the xG- and form-model
// estimates are only kept where no source provided a value. Each stat-backed
// market then gets a `statConfidence` multiplier on the λ factor's weight:
//   1.0  → the market's stat is present for both teams (full weight), or
//   0.5  → the stat is missing, so the market falls back to the historical
//          league average (avgCornersPerGame / avgCardsPerGame, or the caller's
//          league-prior model) and the λ factor's weight is halved.

/** Which TeamStats field settles a given market (for stat-confidence). */
export function statFieldFor(m: Market): StatKey | null {
  const fam = m.family.toLowerCase().replace(/_/g, " ");
  const name = m.name.toLowerCase();
  if (fam.includes("corner") || name.includes("corner")) return "corners";
  if (fam.includes("card") || name.includes("cards")) return "yellowCards";
  if (name.includes("gk saves") || name.includes("total saves") || fam.includes("save")) return "saves";
  if (name.includes("shots on target") || name.includes("total sot") || name.includes(" sot ")) return "shotsOnTarget";
  if (name.includes("shots") || fam.includes("shot")) return "shots";
  if (name.includes("foul")) return "fouls";
  if (name.includes("offside")) return "offsides";
  if (name.includes("throw-in")) return "throwIns";
  if (name.includes("goal kick")) return "goalKicks";
  if (name.includes("possession")) return "possession";
  if (name.includes("passes") || fam.includes("pass")) return "passes";
  if (name.includes("goal") && fam.includes("goal")) return "goals";
  return null;
}

/** 1.0 when the market's stat is real for both teams; 0.5 when it fell back. */
export function statConfidenceFor(
  m: Market,
  stats: CanonicalMatchStats | null | undefined,
): number {
  if (!stats) return 1; // no canonical stats supplied → legacy full-weight behaviour
  const field = statFieldFor(m);
  if (!field) return 1; // market not settled by a specific stat → no modulation
  const hv = stats.home[field];
  const av = stats.away[field];
  return hv !== null && av !== null ? 1 : 0.5;
}

/** True when the market's backing stat is missing and the fallback is in play. */
export function statFellBack(m: Market, stats: CanonicalMatchStats | null | undefined): boolean {
  return statConfidenceFor(m, stats) === 0.5;
}

/** Override a LambdaSet with real canonical stats where available. */
export function effectiveLambdas(
  lam: LambdaSet,
  stats: CanonicalMatchStats | null | undefined,
): LambdaSet {
  if (!stats) return lam;
  const h = stats.home;
  const a = stats.away;

  const resolvePair = (
    realH: number | null,
    realA: number | null,
    modelH: number,
    modelA: number,
    avgH: number | null = null,
    avgA: number | null = null,
  ): [number, number] => {
    const hh = realH ?? avgH ?? null;
    const aa = realA ?? avgA ?? null;
    if (hh !== null && aa !== null) return [hh, aa];
    if (hh !== null) return [hh, modelA];
    if (aa !== null) return [modelH, aa];
    return [modelH, modelA];
  };

  const [homeGoals, awayGoals] = resolvePair(h.xg ?? h.goals, a.xg ?? a.goals, lam.homeGoals, lam.awayGoals);
  const [homeCorners, awayCorners] = resolvePair(
    h.corners, a.corners, lam.homeCorners, lam.awayCorners,
    h.avgCornersPerGame, a.avgCornersPerGame,
  );
  const [homeCards, awayCards] = resolvePair(
    h.yellowCards, a.yellowCards, lam.homeCards, lam.awayCards,
    h.avgCardsPerGame, a.avgCardsPerGame,
  );
  const [homeSot, awaySot] = resolvePair(h.shotsOnTarget, a.shotsOnTarget, lam.homeSot, lam.awaySot);
  const [homeShots, awayShots] = resolvePair(h.shots, a.shots, lam.homeShots, lam.awayShots);
  const [homeOffsides, awayOffsides] = resolvePair(h.offsides, a.offsides, lam.homeOffsides, lam.awayOffsides);
  const [homeSaves, awaySaves] = resolvePair(h.saves, a.saves, lam.homeSaves, lam.awaySaves);
  const [homeThrowIns, awayThrowIns] = resolvePair(h.throwIns, a.throwIns, lam.homeThrowIns, lam.awayThrowIns);
  const [homeFouls, awayFouls] = resolvePair(h.fouls, a.fouls, lam.homeFouls, lam.awayFouls);
  const [homeGoalKicks, awayGoalKicks] = resolvePair(h.goalKicks, a.goalKicks, lam.homeGoalKicks, lam.awayGoalKicks);
  const [interceptionsHome, interceptionsAway] = resolvePair(
    h.interceptions, a.interceptions, lam.interceptionsHome, lam.interceptionsAway,
  );
  const [dribblingHome, dribblingAway] = resolvePair(
    h.dribbling, a.dribbling, lam.dribblingHome, lam.dribblingAway,
  );
  const passesTotal = h.passes !== null && a.passes !== null
    ? h.passes + a.passes
    : lam.passesTotal;

  return {
    ...lam,
    homeGoals, awayGoals,
    homeCorners, awayCorners,
    homeCards, awayCards,
    homeSot, awaySot,
    homeShots, awayShots,
    homeOffsides, awayOffsides,
    homeSaves, awaySaves,
    homeThrowIns, awayThrowIns,
    homeFouls, awayFouls,
    homeGoalKicks, awayGoalKicks,
    interceptionsHome, interceptionsAway,
    dribblingHome, dribblingAway,
    passesTotal,
  };
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

/** Parse the "O/U X(.5)" line out of a market name (null when absent). */
function lineOf(m: Market): number | null {
  const lineMatch = m.name.match(/O\/U\s+([\d.]+)/);
  if (!lineMatch) return null;
  const line = Number(lineMatch[1]);
  return Number.isFinite(line) ? line : null;
}

/**
 * Directional support of an expected total against an O/U line (0..1).
 * The margin is expressed relative to the expectation itself, so a line far
 * below (above) the expectation scores near 1 for Over (Under) and near 0
 * for the opposite side; a line sitting on the expectation scores ~0.5.
 */
function supportScore(expectedTotal: number, line: number, over: boolean): number {
  const margin = (expectedTotal - line) / Math.max(1.0, expectedTotal);
  return over ? clamp(0.5 + margin, 0, 1) : clamp(0.5 - margin, 0, 1);
}

/**
 * Directional support of a home/away strength share (0..1, home perspective)
 * for a result-market selection (Win / Draw / Double Chance).
 */
function resultShareScore(m: Market, homeShare: number, homeName: string, awayName: string): number {
  const sel = m.selection;
  if (sel === "Draw") return clamp(1 - Math.abs(homeShare - 0.5) * 3, 0, 1);
  if (sel.includes("(1X)") || sel === "1X") return clamp(0.6 + (homeShare - 0.5) * 1.5, 0, 1);
  if (sel.includes("(X2)") || sel === "X2") return clamp(0.6 + (0.5 - homeShare) * 1.5, 0, 1);
  if (sel.includes("(12)") || sel === "12") return clamp(0.55 + Math.abs(homeShare - 0.5) * 2, 0, 1);
  if (teamMentions(sel, homeName)) return clamp(0.5 + (homeShare - 0.5) * 2, 0, 1);
  if (teamMentions(sel, awayName)) return clamp(0.5 + (0.5 - homeShare) * 2, 0, 1);
  return 0.5;
}

/** True for result-type markets (1X2 / Double Chance / DNB / AH). */
function isResultMarket(m: Market): boolean {
  return /Match Result|Double Chance|Draw No Bet|Asian Handicap/i.test(m.name);
}

/**
 * Home/away expected-value pair for the market's stat family (null when the
 * market has no direct λ-pair mapping). Always [home, away] — consumers pick
 * the relevant side themselves. Feeds the deep-vector factor.
 */
function lambdaPairFor(m: Market, lam: LambdaSet): [number, number] | null {
  const n = m.name;
  if (n.includes("Goal Kick"))                     return [lam.homeGoalKicks, lam.awayGoalKicks];
  if (n.includes("Goals"))                         return [lam.homeGoals,     lam.awayGoals];
  if (n.includes("Corners"))                       return [lam.homeCorners,   lam.awayCorners];
  if (n.includes("Cards"))                         return [lam.homeCards,     lam.awayCards];
  if (n.includes("SOT"))                           return [lam.homeSot,       lam.awaySot];
  if (n.includes("Shots"))                         return [lam.homeShots,     lam.awayShots];
  if (n.includes("Offsides"))                      return [lam.homeOffsides,  lam.awayOffsides];
  if (n.includes("Saves"))                         return [lam.homeSaves,     lam.awaySaves];
  if (n.includes("Throw-ins"))                     return [lam.homeThrowIns,  lam.awayThrowIns];
  if (n.includes("Fouls"))                         return [lam.homeFouls,     lam.awayFouls];
  return null;
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
}

/** League-table context for one team. Kept for API compatibility with oracle.ts. */
export interface TeamTableInfo {
  position?:   number;
  leagueSize?: number;
}

/**
 * Provenance of the real data used for this match — feeds the source-priority
 * component of the match-level confidence gate.
 *
 * High-priority feeds (ESPN / SportScore / StatsBomb) are treated as high
 * confidence; official league APIs as medium; free/backfill aggregators
 * (TheSportsDB, API-Football free tier, …) as lower confidence.
 */
export interface SourceQualityContext {
  /** Highest-priority source that contributed at least one real field. */
  primarySource?:       string | null;
  /** Every source that contributed at least one real field. */
  contributingSources?: string[] | null;
  /** 0..1 share of the enrichment fields that real sources actually filled. */
  fieldCoverage?:       number | null;
  /** Explicit 0..1 override of the source component (skips tier lookup). */
  score?:               number | null;
}

/** What the gate should do when a match scores below the confidence threshold. */
export type ConfidencePolicy =
  /** Keep the full Top-10 and only attach the confidence block (UI warning). */
  | "flag"
  /** Reduce the response to the Top-N safest picks (default N = 3). */
  | "trim"
  /** Return no picks at all for this match. */
  | "skip";

/** Tuning knobs for the match-level confidence gate. */
export interface ConfidenceOptions {
  /** Below this score the match is "low confidence" (default 0.75). */
  threshold?:              number;
  /** Below this score the match is skipped entirely (default 0.50). */
  skipThreshold?:          number;
  /** Action for low-confidence matches (default "flag" — non-breaking). */
  policy?:                 ConfidencePolicy;
  /** How many picks a trimmed low-confidence match returns (default 3). */
  lowConfidencePickCount?: number;
  /** Set false to disable the gate entirely (still reports the score). */
  enabled?:                boolean;
}

/**
 * Match-explosion risk inputs for the contextual Top-1 ban (Part 1).
 * Computed by the caller (oracle.ts) from the stats aggregator + multi-source
 * enrichment. All fields are REAL data or null — a null leg simply cannot
 * vote. When the whole object is omitted, the ban is inert (data-driven,
 * never a permanent hardcode).
 */
export interface ExplosionRiskInput {
  /** homeXG + awayXG from the stats aggregator. The oracle falls back to the
   *  xG-grounded model λ (stats xG → enrichment xG → league prior) when a
   *  real value is unavailable, so this is effectively always present. */
  combinedXG: number | null;
  /** (homeAvgGoalsLast5 + awayAvgGoalsLast5) / 2 — real last-5 scoring
   *  averages from the enrichment fetchers; null when no source had scores. */
  recentAvgGoals: number | null;
  /** 1.0 for top-5 leagues · 1.1 for Bundesliga / MLS / Eredivisie · 0.9 for
   *  defensive leagues (data-driven via the league priors table). */
  leagueFactor: number;
}

/** Options passed to the selector. */
export interface SelectOptions {
  homeTable?:     TeamTableInfo;
  awayTable?:     TeamTableInfo;
  context?:       RankingContext;
  /**
   * Canonical match stats from the multi-source aggregator (Part 3). When
   * present, the λ for every stat-backed market is grounded in real values and
   * each market's λ-factor weight is multiplied by its stat-confidence.
   */
  stats?:         CanonicalMatchStats | null;
  /**
   * Match-explosion risk inputs for the contextual Top-1 ban (Part 1). When
   * provided, Total/Team Goals "Under X.5" (X ≥ 4) markets are demoted out of
   * the Top-1 slot if combined xG or the recent-goals average (× league
   * factor) exceeds the explosion thresholds.
   */
  explosionRisk?: ExplosionRiskInput | null;
  /** Which feeds supplied the real data (source-priority confidence input). */
  sourceQuality?: SourceQualityContext;
  /** Confidence-gate configuration (threshold / policy). */
  confidence?:    ConfidenceOptions;
  /** Ranking mode: A = Classic 11-factor, B = 12-factor, C = Hybrid (A+B averaged; default B). */
  rankingMode?:  RankingMode;

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

// ─── 12-factor scorers ────────────────────────────────────────────────────────
// Each scorer returns a 0..1 score from REAL data only. `available: false`
// means the factor's underlying data is missing for this match — the factor is
// then EXCLUDED from the composite and its weight redistributed across the
// remaining factors (no simulated stand-ins, ever).

/** Total canonical fields that can be filled (numeric home+away + cleanSheet). */
const TOTAL_CANONICAL_FIELDS = STAT_FIELDS.length * 2 + 2;

/** Advanced-metric fields driving the deep-statistical factors. */
const DEEP_VECTOR_FIELDS: StatKey[] = [
  "xg", "xgPerShot", "shots", "shotsOnTarget", "corners",
  "yellowCards", "possession", "passes", "saves",
];

/** Factor 11 — Poisson: P(selection wins) under the Poisson model. */
function scorePoisson(
  m: Market, lam: LambdaSet, homeName: string, awayName: string,
): FactorResult {
  const lambda = lambdaFor(m, lam, homeName, awayName);
  if (lambda === null) {
    return {
      score: 0.5,
      available: false,
      gap: "no direct λ→selection mapping (non event-rate market) — Poisson factor excluded, weight redistributed",
    };
  }
  // P(selection wins) under Poisson(λ): 1 - tail risk of the selected side.
  const winProb = 1 - tailRisk(m, lambda);
  return { score: clamp(winProb, 0, 1) };
}

/** Factor 10 — Conditional λ values: margin of the real-stat-conditioned λ. */
function scoreConditionalLambda(
  m: Market,
  effLam: LambdaSet,
  stats: CanonicalMatchStats | null,
  homeName: string,
  awayName: string,
): FactorResult {
  const lambda = lambdaFor(m, effLam, homeName, awayName);
  if (lambda === null) {
    return {
      score: 0.5,
      available: false,
      gap: "no λ mapping — conditional-λ factor excluded, weight redistributed",
    };
  }
  const line = lineOf(m);
  if (line === null) {
    return {
      score: 0.5,
      available: false,
      gap: "no O/U line — conditional-λ factor excluded, weight redistributed",
    };
  }
  // Conditioning requires the market's backing stat to be REAL in the canonical
  // stats; without it the λ fell back to model/league priors and cannot vote.
  if (stats !== null && statConfidenceFor(m, stats) !== 1) {
    return {
      score: 0.5,
      available: false,
      gap: "backing stat missing from the aggregator — λ not conditioned on real data, factor excluded, weight redistributed",
    };
  }
  const margin = (lambda - line) / Math.sqrt(Math.max(0.5, lambda));
  const dir = isOverSelection(m) ? 1 : isUnderSelection(m) ? -1 : 0;
  if (dir === 0) {
    return {
      score: 0.5,
      available: false,
      gap: "non O/U selection — conditional-λ factor excluded, weight redistributed",
    };
  }
  return { score: clamp(0.5 + dir * margin * 0.25, 0, 1) };
}

/** Factor 1 — Deep statistical analysis: advanced-metric support (xG / shots). */
function scoreDeepStatisticalAnalysis(
  m: Market,
  stats: CanonicalMatchStats | null,
  homeName: string,
  awayName: string,
): FactorResult {
  if (!stats) {
    return {
      score: 0.5,
      available: false,
      gap: "no canonical stats — deep statistical analysis excluded, weight redistributed",
    };
  }
  const h = stats.home, a = stats.away;

  // Result markets: deep xG share decides the directional support.
  if (isResultMarket(m)) {
    if (h.xg === null || a.xg === null) {
      return {
        score: 0.5,
        available: false,
        gap: "xG missing — deep statistical analysis excluded, weight redistributed",
      };
    }
    const share = h.xg / Math.max(0.1, h.xg + a.xg);
    return { score: resultShareScore(m, share, homeName, awayName) };
  }

  // Advanced metric per market family: xG for goals, shot quality for shots/SOT,
  // the backing stat itself for the remaining event families.
  const name = m.name.toLowerCase();
  let metric: "xg" | "shotsOnTarget" | "shots" | StatKey | null = null;
  if (name.includes("goal") && !name.includes("goal kick")) metric = "xg";
  else if (name.includes("sot") || name.includes("shots on target")) metric = "shotsOnTarget";
  else if (name.includes("shot")) metric = "shots";
  else metric = statFieldFor(m);
  if (!metric) {
    return {
      score: 0.5,
      available: false,
      gap: "no advanced metric for this market — deep statistical analysis excluded, weight redistributed",
    };
  }

  const hv = h[metric], av = a[metric];
  // xG fall-back chain: xg → goals (real scored/conceded grounding).
  const hh = hv ?? (metric === "xg" ? h.goals : null);
  const aa = av ?? (metric === "xg" ? a.goals : null);
  if (hh === null || aa === null) {
    return {
      score: 0.5,
      available: false,
      gap: `advanced metric '${metric}' missing — deep statistical analysis excluded, weight redistributed`,
    };
  }

  const line = lineOf(m);
  const side = marketSide(m, homeName, awayName);
  if (isResultMarket(m) || line === null) {
    const share = hh / Math.max(0.1, hh + aa);
    return { score: resultShareScore(m, share, homeName, awayName) };
  }
  const expected = side === "home" ? hh : side === "away" ? aa : hh + aa;
  return { score: supportScore(expected, line, isOverSelection(m)) };
}

/** Factor 7 — Deep statistical vector: richness of the advanced-metric vector. */
function scoreDeepStatisticalVector(stats: CanonicalMatchStats | null): FactorResult {
  if (!stats) {
    return {
      score: 0.5,
      available: false,
      gap: "no canonical stats — deep statistical vector excluded, weight redistributed",
    };
  }
  let filled = 0;
  for (const f of DEEP_VECTOR_FIELDS) {
    if (stats.home[f] !== null) filled++;
    if (stats.away[f] !== null) filled++;
  }
  const total = DEEP_VECTOR_FIELDS.length * 2;
  if (filled === 0) {
    return {
      score: 0.5,
      available: false,
      gap: "deep statistical vector empty — factor excluded, weight redistributed",
    };
  }
  return { score: clamp(filled / total, 0, 1) };
}

/** Factor 12 — Statistics all states filled: canonical completeness share. */
function scoreStatisticsAllStatesFilled(stats: CanonicalMatchStats | null): FactorResult {
  if (!stats) {
    return {
      score: 0.5,
      available: false,
      gap: "no canonical stats — statistics-all-states-filled excluded, weight redistributed",
    };
  }
  const filled = nonNullFieldCount(stats);
  if (filled === 0) {
    return {
      score: 0.5,
      available: false,
      gap: "aggregator returned no filled stat fields — factor excluded, weight redistributed",
    };
  }
  return { score: clamp(filled / TOTAL_CANONICAL_FIELDS, 0, 1) };
}

/** Factor 2 — All data mesh: breadth of the multi-source real-data mesh. */
function scoreAllDataMesh(
  context: RankingContext | null,
  stats: CanonicalMatchStats | null,
  opts?: SelectOptions,
): FactorResult {
  const components: number[] = [];
  const gaps: string[] = [];

  // (a) Number of independent real sources that contributed to this match.
  const named = new Set<string>();
  const sq = opts?.sourceQuality ?? null;
  if (sq?.primarySource) named.add(sq.primarySource.toLowerCase());
  for (const s of sq?.contributingSources ?? []) named.add(s.toLowerCase());
  if (stats?.metadata.source) named.add(stats.metadata.source.toLowerCase());
  named.delete("");
  if (named.size > 0) {
    components.push(clamp(named.size / 5, 0, 1)); // 5+ independent feeds = full mesh
  } else {
    gaps.push("no contributing sources recorded");
  }

  // (b) Share of the enrichment contract the mesh actually filled.
  if (typeof sq?.fieldCoverage === "number" && Number.isFinite(sq.fieldCoverage)) {
    components.push(clamp(sq.fieldCoverage, 0, 1));
  } else {
    gaps.push("field coverage unknown");
  }

  // (c) League-anchor depth — dedicated empirical baseline vs proxy.
  const slug = context?.leagueSlug;
  if (slug) {
    if (LEAGUE_ANCHORS[slug]) components.push(1.0);
    else if (getAnchors(slug)) components.push(0.65);
    else components.push(0.35);
  } else {
    gaps.push("league slug missing");
  }

  if (components.length === 0) {
    return {
      score: 0.5,
      available: false,
      gap: `${gaps.join("; ")} — all-data-mesh factor excluded, weight redistributed`,
    };
  }
  const score = components.reduce((s, v) => s + v, 0) / components.length;
  return { score: clamp(score, 0, 1), gap: gaps.length ? gaps.join("; ") : undefined };
}

/**
 * Factor 3 — Stats: the market's backing-stat evidence.
 *
 * The historical hit rate / calibration is ONLY ONE PART of this factor
 * (never allowed to dominate the composite on its own): when the stats
 * aggregator provides the market's real backing stat, the factor is a 50/50
 * blend of calibration and the directional stat evidence; without the real
 * stat it falls back to the calibration component alone (flagged as a gap).
 */
function scoreStats(
  m: Market,
  ctx: MatchVolatility,
  effectiveHitRate: number,
  stats: CanonicalMatchStats | null,
  homeName: string,
  awayName: string,
): FactorResult {
  // Calibration component — Under 4.5 markets with an extreme raw hit rate
  // (> 0.93) are scored with the penalised hit rate, every other market with
  // its empirical market-type reliability (0.4..1.0).
  const calibrationComponent =
    effectiveHitRate !== m.hitRate
      ? clamp(effectiveHitRate, 0, 1)
      : clamp(marketReliability(m, ctx), 0, 1);

  const field = statFieldFor(m);
  if (stats && field) {
    const hv = stats.home[field];
    const av = stats.away[field];
    if (hv !== null && av !== null) {
      const line = lineOf(m);
      if (line !== null && (isOverSelection(m) || isUnderSelection(m))) {
        const side = marketSide(m, homeName, awayName);
        const expected = side === "home" ? hv : side === "away" ? av : hv + av;
        const statComponent = supportScore(expected, line, isOverSelection(m));
        return { score: clamp(0.5 * calibrationComponent + 0.5 * statComponent, 0, 1) };
      }
      if (isResultMarket(m)) {
        const share = hv / Math.max(0.1, hv + av);
        const statComponent = resultShareScore(m, share, homeName, awayName);
        return { score: clamp(0.5 * calibrationComponent + 0.5 * statComponent, 0, 1) };
      }
    }
  }

  return {
    score: calibrationComponent,
    gap: "backing stat unavailable — Stats factor scored on calibration component only",
  };
}

/** Factor 9 — Form (player / team form momentum). */
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

/** Factor 4 — Tactical analysis (home/away, H2H, formation). */
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

/** Injury/availability component for the player-vs-player factor. */
function scoreInjuryComponent(
  m: Market, homeName: string, awayName: string, context: RankingContext | null,
): FactorResult {
  const side = marketSpecificSide(m, homeName, awayName);
  const home = scoreTeamInjuryImpact(context?.injury?.home, "home");
  const away = scoreTeamInjuryImpact(context?.injury?.away, "away");

  if (side === "home") {
    // Side-specific market: only that side's availability matters.
    if (home.available === false) {
      return { ...home, gap: `home injury data missing` };
    }
    return { score: home.score };
  }
  if (side === "away") {
    if (away.available === false) {
      return { ...away, gap: `away injury data missing` };
    }
    return { score: away.score };
  }

  // Total/neutral market: real signal only while BOTH sides have real data.
  const gaps = [home.gap, away.gap].filter((g): g is string => !!g);
  if (home.available === false || away.available === false) {
    return {
      score: Math.min(home.score, away.score),
      available: false,
      gap: gaps.join("; ") || "injury data missing",
    };
  }
  return { score: Math.min(home.score, away.score), gap: gaps.length ? gaps.join("; ") : undefined };
}

/** Formation-mismatch duel component for the player-vs-player factor. */
function scoreFormationDuelComponent(
  m: Market, context: RankingContext | null,
): FactorResult {
  const tac = context?.tactical ?? null;
  if (!tac?.homeFormation || !tac?.awayFormation) {
    return { score: 0.5, available: false, gap: "formation data missing" };
  }
  let fmm: ReturnType<typeof analyseFormationMismatch>;
  try {
    fmm = analyseFormationMismatch(tac.homeFormation, tac.awayFormation);
  } catch {
    return { score: 0.5, available: false, gap: "formation analysis failed" };
  }

  const name = m.name;
  const over = isOverSelection(m);
  const under = isUnderSelection(m);
  // Map the duel multiplier onto the market family: >1 favours Overs, <1 Unders.
  let mult = 1.0;
  if (/Goals/.test(name)) mult = fmm.goalMultiplier;
  else if (/Corners/.test(name)) mult = fmm.cornerMultiplier;
  else if (/Cards/.test(name)) mult = fmm.cardMultiplier;
  else {
    // Result-type markets use the home-advantage edge of the duel.
    return { score: clamp(0.5 + fmm.homeAdvantage, 0, 1) };
  }
  if (over) return { score: clamp(0.5 + (mult - 1) * 2, 0, 1) };
  if (under) return { score: clamp(0.5 - (mult - 1) * 2, 0, 1) };
  return { score: 0.5 };
}

/**
 * Factor 6 — Player vs player forms: individual matchup availability and
 * edges. Blends the REAL injury/absence availability of the players involved
 * with the formation duel (attacking vs defensive matchup multipliers).
 */
function scorePlayerVsPlayerForms(
  m: Market, homeName: string, awayName: string, context: RankingContext | null,
): FactorResult {
  const components: number[] = [];
  const gaps: string[] = [];

  const injury = scoreInjuryComponent(m, homeName, awayName, context);
  if (injury.available !== false) components.push(injury.score);
  else if (injury.gap) gaps.push(injury.gap);

  const duel = scoreFormationDuelComponent(m, context);
  if (duel.available !== false) components.push(duel.score);
  else if (duel.gap) gaps.push(duel.gap);

  if (components.length === 0) {
    return {
      score: 0.5,
      available: false,
      gap: `${gaps.join("; ") || "no player-level data"} — player-vs-player factor excluded, weight redistributed`,
    };
  }
  const score = components.reduce((s, v) => s + v, 0) / components.length;
  return { score: clamp(score, 0, 1), gap: gaps.length ? gaps.join("; ") : undefined };
}


// ─── Classic 11-factor scorers (Rank A) ───────────────────────────────────────
// Each scorer returns {score, available, gap}. Unavailable factors are excluded
// and weight redistributed. No neutral 0.5 stand-ins.

function scoreCalibrationClassic(
  m: Market,
  effLam: LambdaSet,
  _homeName: string,
  _awayName: string,
  stats: CanonicalMatchStats | null | undefined,
): FactorResult {
  const totalGoals = effLam.homeGoals + effLam.awayGoals;
  const evenness = 1 - Math.min(1, Math.abs(effLam.homeGoals - effLam.awayGoals) / Math.max(0.5, totalGoals));
  const ctx: MatchVolatility = { totalGoals, evenness };
  let raw = marketReliability(m, ctx);
  // Under-4.5 penalty: Goals market, Under, line >=4.5, raw >0.93
  if (isUnderSelection(m)) {
    const line = lineOf(m);
    const isGoals = /Goals/.test(m.name) || /goals/i.test(m.family);
    if (line !== null && line >= 4.5 && isGoals && raw > 0.93) {
      raw = raw - (raw - 0.93) * 0.4;
    }
  }
  return { score: clamp(raw, 0, 1) };
}

function scorePoissonClassic(
  m: Market,
  effLam: LambdaSet,
  homeName: string,
  awayName: string,
): FactorResult {
  const lambda = lambdaFor(m, effLam, homeName, awayName);
  if (lambda === null) {
    return {
      score: 0.5,
      available: false,
      gap: "no direct λ→selection mapping — Poisson factor excluded, weight redistributed",
    };
  }
  const winProb = 1 - tailRisk(m, lambda);
  return { score: clamp(winProb, 0, 1) };
}

function scoreVolatilityClassic(
  m: Market,
  context: RankingContext | null,
): FactorResult {
  const vol = context?.marketVolatility ?? null;
  if (!vol || vol.dataAvailable === false) {
    return {
      score: 0.5,
      available: false,
      gap: "market volatility data missing — volatility factor excluded, weight redistributed",
    };
  }
  let movePct: number | null | undefined = null;
  const map = vol.marketMovePctLast6h ?? {};
  // Try direct id, then name, then lowercased variants
  if (map[m.id] != null) movePct = map[m.id];
  else if (map[m.name] != null) movePct = map[m.name];
  else {
    // case-insensitive search
    const lowerId = m.id.toLowerCase();
    const lowerName = m.name.toLowerCase();
    for (const [k, v] of Object.entries(map)) {
      if (k.toLowerCase() === lowerId || k.toLowerCase() === lowerName) {
        movePct = v as number;
        break;
      }
    }
  }
  if (movePct == null) movePct = vol.maxMovePctLast6h ?? null;
  if (movePct == null || !Number.isFinite(movePct)) {
    return {
      score: 0.5,
      available: false,
      gap: "six-hour odds move missing — volatility factor excluded, weight redistributed",
    };
  }
  const mv = Math.abs(movePct);
  let score: number;
  if (mv <= 5) score = 1.0;
  else if (mv >= 20) score = 0.0;
  else score = 1 - (mv - 5) / 15;
  return { score: clamp(score, 0, 1) };
}

function scoreLeagueDepthClassic(
  context: RankingContext | null,
): FactorResult {
  const slug = context?.leagueSlug ?? null;
  if (!slug) {
    return {
      score: 0.5,
      available: false,
      gap: "league slug missing — league depth factor excluded, weight redistributed",
    };
  }
  if (LEAGUE_ANCHORS[slug]) {
    return { score: 1.0 };
  }
  // Proxy or default anchors → 0.65 per spec (getAnchors always returns fallback)
  // If no dedicated entry, treat as proxy/default
  return { score: 0.65 };
}

function scoreMarketConfidenceClassic(
  m: Market,
  confidenceMap: Record<string, number> | undefined,
  context: RankingContext | null,
): FactorResult {
  if (confidenceMap && confidenceMap[m.id] !== undefined) {
    const v = confidenceMap[m.id];
    if (Number.isFinite(v)) {
      return { score: clamp(v, 0, 1) };
    }
  }
  const odds = context?.odds ?? null;
  if (!odds) {
    return {
      score: 0.5,
      available: false,
      gap: "bookmaker odds missing — market confidence factor excluded, weight redistributed",
    };
  }
  // Determine if odds matched the market type
  let matched = false;
  const name = m.name;
  if (isResultMarket(m)) {
    if (odds.homeML != null || odds.drawML != null || odds.awayML != null) matched = true;
  }
  if (/Goals O\/U/i.test(name) || /Total Goals/i.test(name)) {
    if ((odds as any).overUnder != null) matched = true;
  }
  // If odds exist at all, we have at least a mismatch signal
  const score = matched ? 0.8 : 0.55;
  return { score };
}

function scoreWeatherClassic(
  context: RankingContext | null,
): FactorResult {
  const w = context?.weather ?? null;
  if (!w || w.dataAvailable === false) {
    return {
      score: 0.5,
      available: false,
      gap: "weather/pitch data missing — weather factor excluded, weight redistributed",
    };
  }
  if (typeof w.score === 'number' && Number.isFinite(w.score)) {
    return { score: clamp(w.score, 0, 1) };
  }
  const rawText = `${w.condition ?? ''} ${w.pitch ?? ''}`.toLowerCase();
  if (!rawText.trim()) {
    return {
      score: 0.5,
      available: false,
      gap: "weather/pitch data missing — weather factor excluded, weight redistributed",
    };
  }
  if (rawText.includes('heavy rain') || rawText.includes('storm') || rawText.includes('snow') || rawText.includes('waterlogged')) {
    return { score: 0.2 };
  }
  if (rawText.includes('perfect')) {
    return { score: 1.0 };
  }
  if (rawText.includes('clear') || rawText.includes('dry')) {
    return { score: 0.8 };
  }
  if (rawText.includes('rain') || rawText.includes('wind')) {
    return { score: 0.5 };
  }
  return {
    score: 0.5,
    available: false,
    gap: `weather condition "${rawText.trim()}" unrecognized — weather factor excluded, weight redistributed`,
  };
}

// ─── Classic market score ────────────────────────────────────────────────────
export type ClassicFactorBreakdown = Record<ClassicFactorKey, number>;

export interface ClassicMarketScore {
  market:      Market;
  composite:   number;
  wrongProb:   number;
  marginUnits: number;
  verifiable:  boolean;
  breakdown:   ClassicFactorBreakdown;
  gaps:        string[];
  notes:       string;
  effectiveHitRate: number;
  excludedFactors: ClassicFactorKey[];
  appliedWeights: Partial<Record<ClassicFactorKey, number>>;
  statConfidence: number;
  statField:      StatKey | null;
  statFallback:   boolean;
  weightMultiplier: Partial<Record<ClassicFactorKey, number>>;
}

export function scoreMarketClassic(
  m:             Market,
  lam:           LambdaSet,
  homeName:      string,
  awayName:      string,
  confidenceMap?: Record<string, number>,
  opts?:         SelectOptions,
): ClassicMarketScore {
  const context = opts?.context ?? null;
  const stats   = opts?.stats ?? null;

  const effLam = effectiveLambdas(lam, stats);
  const statConfidence = statConfidenceFor(m, stats);
  const statField = statFieldFor(m);
  const statFallback = statFellBack(m, stats);

  const totalGoals = effLam.homeGoals + effLam.awayGoals;
  const evenness = 1 - Math.min(1, Math.abs(effLam.homeGoals - effLam.awayGoals) / Math.max(0.5, totalGoals));

  // 11-factor scorecard
  const calibration      = scoreCalibrationClassic(m, effLam, homeName, awayName, stats);
  const poisson          = scorePoissonClassic(m, effLam, homeName, awayName);
  const form             = scoreForm(m, homeName, awayName, context);
  const injury           = scoreInjuryComponent(m, homeName, awayName, context);
  const volatility       = scoreVolatilityClassic(m, context);
  const tactical         = scoreTactical(m, effLam, homeName, awayName, context);
  const importance       = scoreImportance(context, opts);
  const leagueDepth      = scoreLeagueDepthClassic(context);
  const marketConfidence = scoreMarketConfidenceClassic(m, confidenceMap, context);
  const zeroBias         = scoreBias(m, effLam, homeName, awayName, context);
  const weather          = scoreWeatherClassic(context);

  const factorResults: Record<ClassicFactorKey, FactorResult> = {
    calibration,
    poisson,
    form,
    injury,
    volatility,
    tactical,
    importance,
    leagueDepth,
    marketConfidence,
    zeroBias,
    weather,
  };

  const breakdown: ClassicFactorBreakdown = ALL_CLASSIC_KEYS.reduce((acc, k) => {
    acc[k] = factorResults[k].score;
    return acc;
  }, {} as ClassicFactorBreakdown);

  // Weight multiplier for Poisson (stat-confidence)
  const weightMultiplier: Partial<Record<ClassicFactorKey, number>> = {};
  for (const k of ALL_CLASSIC_KEYS) weightMultiplier[k] = 1;
  weightMultiplier['poisson'] = statConfidence; // 1.0 if real, 0.5 if fallback

  const excludedFactors = ALL_CLASSIC_KEYS.filter((k) => factorResults[k].available === false);
  const activeKeys = ALL_CLASSIC_KEYS.filter((k) => factorResults[k].available !== false);

  const activeWeightTotal = activeKeys.reduce((sum, k) => sum + RANKING_WEIGHTS_CLASSIC[k] * (weightMultiplier[k] ?? 1), 0) || RANKING_WEIGHTS_CLASSIC.calibration || 1;

  const weightedTotal = activeKeys.reduce(
    (sum, k) => sum + RANKING_WEIGHTS_CLASSIC[k] * (weightMultiplier[k] ?? 1) * breakdown[k],
    0,
  );
  const composite = weightedTotal / activeWeightTotal;

  const appliedWeights: Partial<Record<ClassicFactorKey, number>> = {};
  for (const k of activeKeys) {
    appliedWeights[k] = (RANKING_WEIGHTS_CLASSIC[k] * (weightMultiplier[k] ?? 1)) / activeWeightTotal;
  }

  // Effective hit rate for tiering & loss-prob tiebreak = calibration score
  const effectiveHitRate = calibration.score;
  const wrongProb = clamp(1 - effectiveHitRate, 0, 1);

  const lamVal = lambdaFor(m, effLam, homeName, awayName);
  const line = lineOf(m);
  const marginUnits = lamVal !== null && line !== null ? sigmaCushion(lamVal, line) : 0;

  const gaps = ALL_CLASSIC_KEYS.map((k) => factorResults[k].gap).filter((g): g is string => !!g);

  const notes =
    ALL_CLASSIC_KEYS.map((k) => `${FACTOR_LABELS_CLASSIC[k].split(' ').map((w) => w[0]).join('')}=${breakdown[k].toFixed(2)}`).join(' ') +
    ` → composite=${composite.toFixed(3)} loss=${(wrongProb * 100).toFixed(1)}% ` +
    `w[${activeKeys.map((k) => `${FACTOR_LABELS_CLASSIC[k]}=${((appliedWeights[k] ?? 0) * 100).toFixed(1)}%`).join(' ')}]` +
    (excludedFactors.length ? ` excluded[${excludedFactors.map((k) => FACTOR_LABELS_CLASSIC[k]).join(',')}]` : '') +
    (statField ? ` stat=${statField}@${(statConfidence * 100).toFixed(0)}%${statFallback ? '(fallback)' : ''}` : '') +
    (gaps.length ? ` [gaps: ${gaps.join('; ')}]` : '');

  return {
    market: m,
    composite: clamp(composite, 0, 1),
    wrongProb,
    marginUnits,
    verifiable: isVerifiable(m),
    breakdown,
    gaps,
    notes,
    effectiveHitRate,
    excludedFactors,
    appliedWeights,
    statConfidence,
    statField,
    statFallback,
    weightMultiplier,
  };
}

export function labelledFactorsClassic(s: ClassicMarketScore): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ALL_CLASSIC_KEYS) {
    if (s.excludedFactors.includes(k)) continue;
    out[FACTOR_LABELS_CLASSIC[k]] = Math.round(s.breakdown[k] * 100) / 100;
  }
  return out;
}

export function computeMatchConfidenceClassic(
  picks: ClassicMarketScore[],
  opts?: SelectOptions,
  meta?: { backfillPicks?: number },
): MatchConfidence {
  const cfg = resolveConfidenceOptions(opts?.confidence);
  const pickCount = picks.length;
  const backfillPicks = meta?.backfillPicks ?? picks.filter((s) => s.effectiveHitRate < MIN_CALIBRATION_HIT_RATE).length;

  const avgCalibration = pickCount ? picks.reduce((sum, s) => sum + s.effectiveHitRate, 0) / pickCount : 0;

  const coveragePerPick = picks.map((s) => {
    const excludedMass = s.excludedFactors.reduce((sum, k) => sum + RANKING_WEIGHTS_CLASSIC[k] * (s.weightMultiplier[k] ?? 1), 0);
    // active mass / total mass (total is 1, but with multipliers)
    const activeMass = ALL_CLASSIC_KEYS.reduce((sum, k) => sum + RANKING_WEIGHTS_CLASSIC[k] * (s.weightMultiplier[k] ?? 1), 0) - excludedMass;
    const totalMass = ALL_CLASSIC_KEYS.reduce((sum, k) => sum + RANKING_WEIGHTS_CLASSIC[k] * (s.weightMultiplier[k] ?? 1), 0) || 1;
    return activeMass / totalMass;
  });
  const factorCoverage = coveragePerPick.length ? coveragePerPick.reduce((a, b) => a + b, 0) / coveragePerPick.length : 0;
  const avgFactorsAvailable = pickCount ? picks.reduce((sum, s) => sum + (ALL_CLASSIC_KEYS.length - s.excludedFactors.length), 0) / pickCount : 0;
  const missingUnion = new Set<ClassicFactorKey>();
  for (const s of picks) s.excludedFactors.forEach((k) => missingUnion.add(k));
  const missingFactorsClassic = ALL_CLASSIC_KEYS.filter((k) => missingUnion.has(k));

  const src = scoreSourceQuality(opts?.sourceQuality, backfillPicks, pickCount);

  const raw: Record<ConfidenceComponentKey, FactorResult> = {
    calibration:    { score: clamp(avgCalibration, 0, 1) },
    factorCoverage: { score: clamp(factorCoverage, 0, 1) },
    sourceQuality:  src.result,
  };

  const componentKeys = Object.keys(CONFIDENCE_WEIGHTS) as ConfidenceComponentKey[];
  const activeKeys = componentKeys.filter((k) => raw[k].available !== false);
  const activeWeight = activeKeys.reduce((sum, k) => sum + CONFIDENCE_WEIGHTS[k], 0) || CONFIDENCE_WEIGHTS.calibration;

  const blended = activeKeys.reduce((sum, k) => sum + (CONFIDENCE_WEIGHTS[k] / activeWeight) * raw[k].score, 0);

  const depthFactor = pickCount >= TARGET_PICK_COUNT ? 1 : 0.85 + 0.15 * (pickCount / TARGET_PICK_COUNT);
  const score = clamp(blended * depthFactor, 0, 1);

  const components = componentKeys.reduce((acc, k) => {
    acc[k] = {
      score:     clamp(raw[k].score, 0, 1),
      weight:    CONFIDENCE_WEIGHTS[k],
      applied:   raw[k].available === false ? 0 : CONFIDENCE_WEIGHTS[k] / activeWeight,
      available: raw[k].available !== false,
      detail:    "",
    };
    return acc;
  }, {} as Record<ConfidenceComponentKey, ConfidenceComponent>);

  components.calibration.detail = `mean calibration of ${pickCount} pick(s) = ${(avgCalibration * 100).toFixed(1)}%`;
  components.factorCoverage.detail =
    `${(factorCoverage * 100).toFixed(1)}% of ranking weight backed by real data ` +
    `(${avgFactorsAvailable.toFixed(1)}/${ALL_CLASSIC_KEYS.length} factors` +
    `${missingFactorsClassic.length ? `, missing: ${missingFactorsClassic.join(', ')}` : ''})`;
  components.sourceQuality.detail = src.result.available === false
    ? (src.result.gap ?? "source provenance unavailable — component excluded")
    : `${src.tier} tier (${src.sources.join(" + ") || "unknown"})` +
      (backfillPicks ? ` · ${backfillPicks}/${pickCount} picks from the calibration backfill tier` : "");

  const lowConfidence = cfg.enabled && score < cfg.threshold;
  const level: MatchConfidence["level"] =
    score < cfg.skipThreshold ? "VERY_LOW" : score < cfg.threshold ? "LOW" : "HIGH";

  const reasons: string[] = componentKeys.map(
    (k) => `${k}: ${(components[k].score * 100).toFixed(1)}% × ${(components[k].applied * 100).toFixed(0)}% — ${components[k].detail}`,
  );
  if (depthFactor < 1) {
    reasons.push(`pick depth: only ${pickCount}/${TARGET_PICK_COUNT} qualified verifiable picks — score × ${depthFactor.toFixed(3)}`);
  }
  if (!cfg.enabled) reasons.push("confidence gate disabled — score reported only, no action taken");

  return {
    score,
    scorePct: Math.round(score * 1000) / 10,
    level,
    lowConfidence,
    action: "full",
    picksReturned: pickCount,
    threshold:     cfg.threshold,
    skipThreshold: cfg.skipThreshold,
    policy:        cfg.policy,
    components,
    avgCalibration,
    avgFactorsAvailable,
    totalFactors: ALL_CLASSIC_KEYS.length,
    // Cast to FactorKey[] for compatibility — classic keys are reported as strings
    missingFactors: missingFactorsClassic as unknown as FactorKey[],
    sourceTier: src.tier,
    sources:    src.sources,
    backfillPicks,
    reasons,
    summary: "",
  };
}

// ─── Classic selection (Rank A) ──────────────────────────────────────────────
function hardSafetyRejectReasonClassic(
  s: ClassicMarketScore,
  context: RankingContext | null,
  homeName: string,
  awayName: string,
): string | null {
  if (injurySeverityBlocksMarket(s.market, context, homeName, awayName)) {
    return "team-specific market blocked by injury severity filter";
  }
  return null;
}

export function selectTopPicksClassic(
  markets:        Market[],
  lam:            LambdaSet,
  homeName:       string,
  awayName:       string,
  confidenceMap?: Record<string, number>,
  opts?:          SelectOptions,
): SelectionResult {

  const gapLog = new Set<string>();

  const scored = markets
    .filter((m) => !m.rejected)
    .map((m) => {
      const s = scoreMarketClassic(m, lam, homeName, awayName, confidenceMap, opts);
      s.gaps.forEach((g) => gapLog.add(g));
      return s;
    });

  if (scored.length === 0) {
    return EMPTY_SELECTION("No qualified markets to rank.", [...gapLog]);
  }

  const ranked = [...scored].sort((a, b) => {
    const dc = b.composite - a.composite;
    if (Math.abs(dc) > 1e-6) return dc;
    const dw = a.wrongProb - b.wrongProb;
    if (Math.abs(dw) > 1e-6) return dw;
    const dm = b.marginUnits - a.marginUnits;
    if (Math.abs(dm) > 1e-6) return dm;
    return a.market.id.localeCompare(b.market.id);
  });

  const context = opts?.context ?? null;
  const hardQualified = ranked.filter((s) => {
    const reason = hardSafetyRejectReasonClassic(s, context, homeName, awayName);
    if (reason) {
      gapLog.add(`hard filter skipped ${s.market.id}: ${reason}`);
      return false;
    }
    return true;
  });
  if (hardQualified.length === 0) {
    return EMPTY_SELECTION("No market remains after hard safety filters (injury severity).", [...gapLog]);
  }

  const topNQualified = hardQualified.filter((s) => {
    const blocked = isBlockedTeamSpecificUnder35Goals(s.market, homeName, awayName);
    if (blocked) gapLog.add(`safety net skipped ${s.market.id}: non-giant team-specific Under 3.5 Goals`);
    return !blocked;
  });
  if (topNQualified.length === 0) {
    return EMPTY_SELECTION("No Top-N-eligible market remains after applying the team-goals safety net.", [...gapLog]);
  }

  const verifiableRanked = topNQualified.filter((s) => s.verifiable);
  if (verifiableRanked.length === 0) {
    return EMPTY_SELECTION("No verifiable market remains after scoring and hard safety filters — match skipped.", [...gapLog]);
  }

  const comparator = (a: ClassicMarketScore, b: ClassicMarketScore) => {
    const dc = b.composite - a.composite;
    if (Math.abs(dc) > 1e-6) return dc;
    const dw = a.wrongProb - b.wrongProb;
    if (Math.abs(dw) > 1e-6) return dw;
    const dm = b.marginUnits - a.marginUnits;
    if (Math.abs(dm) > 1e-6) return dm;
    return a.market.id.localeCompare(b.market.id);
  };
  const trustedTier = verifiableRanked.filter((s) => s.effectiveHitRate >= MIN_CALIBRATION_HIT_RATE).sort(comparator);
  const backfillTier = verifiableRanked.filter((s) => s.effectiveHitRate < MIN_CALIBRATION_HIT_RATE && s.effectiveHitRate >= MIN_BACKFILL_CALIBRATION_HIT_RATE).sort(comparator);

  const seen = new Set<string>();
  const deduped: ClassicMarketScore[] = [];
  const extrasPool: ClassicMarketScore[] = [];
  for (const s of [...trustedTier, ...backfillTier]) {
    const key = statKey(s.market);
    if (seen.has(key)) { extrasPool.push(s); continue; }
    seen.add(key);
    deduped.push(s);
  }
  const extras = extrasPool.sort(comparator);
  const top10Scores = [...deduped, ...extras].slice(0, 10);
  const top10 = top10Scores.map((s) => s.market);

  const backfilledCount = top10Scores.filter((s) => s.effectiveHitRate < MIN_CALIBRATION_HIT_RATE).length;
  if (backfilledCount > 0) {
    gapLog.add(`Top-10 backfill tier used for ${backfilledCount}/10 slots (trusted ≥85% calibration pool exhausted; backfill picks still qualified, safety-net-checked and verifiable)`);
  }

  const excludedUnion = new Set<ClassicFactorKey>();
  for (const s of top10Scores) s.excludedFactors.forEach((f) => excludedUnion.add(f));
  const lead = top10Scores[0];
  const weightLog: string[] = [];
  if (lead) {
    weightLog.push(
      `final weights: ${ALL_CLASSIC_KEYS.filter((k) => lead.appliedWeights[k] !== undefined).map((k) => `${k} ${((lead.appliedWeights[k] ?? 0) * 100).toFixed(1)}%`).join(', ')} (Σ = ${(ALL_CLASSIC_KEYS.reduce((sum, k) => sum + (lead.appliedWeights[k] ?? 0), 0) * 100).toFixed(0)}%)`,
    );
  }
  if (excludedUnion.size) {
    weightLog.push(`missing factors (weight redistributed): ${[...excludedUnion].join(', ')}`);
  }
  if (backfilledCount > 0) {
    weightLog.push(`top-10 fill: ${10 - backfilledCount}/10 from the trusted tier (calibration ≥ 85%), ${backfilledCount}/10 backfilled from the 0.55–0.85 tier — all fully filtered`);
  }
  console.log(
    `[selector] ${homeName} vs ${awayName} — top10: ${top10.length}/10` +
    (backfilledCount ? ` (backfill: ${backfilledCount})` : "") +
    (excludedUnion.size ? ` | missing: ${[...excludedUnion].join(',')}` : " | all factors available") +
    (lead ? ` | ${weightLog[0]}` : ""),
  );

  const cfg = resolveConfidenceOptions(opts?.confidence);
  const confidence = computeMatchConfidenceClassic(top10Scores, opts, { backfillPicks: backfilledCount });

  const shouldSkip = cfg.enabled && cfg.policy === "skip" && confidence.score < cfg.threshold;
  const belowSkipFloor = cfg.enabled && cfg.policy !== "flag" && confidence.score < cfg.skipThreshold;
  const shouldTrim = cfg.enabled && cfg.policy === "trim" && confidence.lowConfidence;

  let finalPicks = top10;
  if (shouldSkip || belowSkipFloor) {
    confidence.action = "skipped";
    confidence.picksReturned = 0;
    finalPicks = [];
  } else if (shouldTrim) {
    confidence.action = "reduced";
    finalPicks = top10.slice(0, cfg.lowConfidencePickCount);
    confidence.picksReturned = finalPicks.length;
  } else {
    confidence.action = "full";
    confidence.picksReturned = finalPicks.length;
  }

  confidence.summary =
    `confidence ${confidence.scorePct.toFixed(1)}% (${confidence.level}) ` +
    `vs threshold ${(confidence.threshold * 100).toFixed(0)}% → ` +
    (confidence.action === "skipped"
      ? "match SKIPPED (no picks returned)"
      : confidence.action === "reduced"
        ? `reduced to Top-${confidence.picksReturned}`
        : `full Top-${confidence.picksReturned}`);

  const confidenceLog = [
    confidence.summary,
    ...confidence.reasons.map((r) => `· ${r}`),
  ];

  console.log(
    `[selector][confidence] ${homeName} vs ${awayName} — score ${confidence.scorePct.toFixed(1)}% ` +
    `(${confidence.level}) | cal ${(confidence.components.calibration.score * 100).toFixed(1)}% ` +
    `| factors ${(confidence.components.factorCoverage.score * 100).toFixed(1)}% ` +
    `(${confidence.avgFactorsAvailable.toFixed(1)}/${confidence.totalFactors}) ` +
    `| source ${confidence.components.sourceQuality.available ? `${(confidence.components.sourceQuality.score * 100).toFixed(1)}% [${confidence.sourceTier}: ${confidence.sources.join("+") || "n/a"}]` : "unavailable (weight redistributed)"} ` +
    `| backfill ${confidence.backfillPicks}/${top10.length} ` +
    `| threshold ${(confidence.threshold * 100).toFixed(0)}% | policy ${confidence.policy} ` +
    `→ ${confidence.action.toUpperCase()} (${confidence.picksReturned} picks)`,
  );

  if (confidence.action === "skipped") {
    return {
      ...EMPTY_SELECTION(
        `Low confidence (${confidence.scorePct.toFixed(1)}% < ${(confidence.threshold * 100).toFixed(0)}%) — match skipped by the confidence gate.`,
        [...gapLog],
      ),
      rankingNotes: top10.map((m) => {
        const s = scored.find((x) => x.market === m);
        return s ? s.notes : `${m.name} · ${m.selection}`;
      }),
      weightLog,
      missingFactors: [...excludedUnion] as unknown as FactorKey[],
      confidence,
      confidenceLog,
    };
  }

  const orderedPicks = applyTop1ExplosionBan(finalPicks, homeName, awayName, opts);

  for (const m of orderedPicks) {
    const s = scored.find((x) => x.market === m);
    if (!s) continue;
    m.factors = labelledFactorsClassic(s);
    m.compositeScore = Math.round(s.composite * 100) / 100;
  }

  return {
    top1:  orderedPicks.slice(0, 1),
    top3:  orderedPicks.slice(0, 3),
    top5:  orderedPicks.slice(0, 5),
    top10: orderedPicks,
    gaps:         [...gapLog],
    rankingNotes: orderedPicks.map((m) => {
      const s = scored.find((x) => x.market === m);
      return s ? s.notes : `${m.name} · ${m.selection}`;
    }),
    weightLog,
    missingFactors: [...excludedUnion] as unknown as FactorKey[],
    confidence,
    confidenceLog,
  };
}

// Alias required by task: rankClassic
export const rankClassic = selectTopPicksClassic;
// Alias for the 12-Factor engine (Rank B) — one of the two inputs the
// hybrid (Rank C) averages.
export const rankNew = selectTopPicks;


// ─── Market score ─────────────────────────────────────────────────────────────

/** Per-factor sub-scores for a market (all 0..1), keyed by FactorKey. */
export type FactorBreakdown = Record<FactorKey, number>;


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
  /** Effective (calibrated) hit rate used for tiering and loss-probability. */
  effectiveHitRate: number;
  /** Factors whose data was unavailable — excluded from this market's composite. */
  excludedFactors: FactorKey[];
  /**
   * Final (redistributed) factor weights applied to this market, as fractions
   * of the active weight mass (Σ = 1). E.g. after excluding form + pvp-forms,
   * poisson = 0.08/0.92 = 0.087.
   */
  appliedWeights: Partial<Record<FactorKey, number>>;
  /**
   * Stat-confidence of the market's backing stat (Part 3): 1.0 when the stat
   * is real for both teams, 0.5 when it fell back to the historical league
   * average. Gates the conditional-λ factor.
   */
  statConfidence: number;
  /** The TeamStats field that backs this market (null for non-stat markets). */
  statField:      StatKey | null;
  /** True when the λ used the historical-average fallback (stat was null). */
  statFallback:   boolean;
}

/**
 * Score a single market across all twelve factors. Every factor is computed
 * from REAL data; unavailable factors are excluded and their weight is
 * redistributed proportionally across the remaining factors.
 *
 * `confidenceMap` is accepted for API compatibility with older callers and is
 * no longer part of the composite (market liquidity is outside the balanced
 * 12-factor profile).
 */
export function scoreMarket(
  m:             Market,
  lam:           LambdaSet,
  homeName:      string,
  awayName:      string,
  confidenceMap?: Record<string, number>,
  opts?:         SelectOptions,
): MarketScore {
  void confidenceMap; // kept for backward compatibility — see doc comment
  const context = opts?.context ?? null;
  const stats   = opts?.stats ?? null;

  // Ground λ in real canonical stats (Part 3), and compute the market's
  // stat-confidence (1.0 = real stat for both teams, 0.5 = fallback).
  const effLam = effectiveLambdas(lam, stats);
  const statConfidence = statConfidenceFor(m, stats);
  const statField = statFieldFor(m);
  const statFallback = statFellBack(m, stats);

  const totalGoals = effLam.homeGoals + effLam.awayGoals;
  const evenness = 1 - Math.min(1, Math.abs(effLam.homeGoals - effLam.awayGoals) / Math.max(0.5, totalGoals));
  const ctx: MatchVolatility = { totalGoals, evenness };

  // Under 4.5 probability calibration: markets with a raw hit rate above 0.93
  // are ranked with the penalised hit rate (adjusted = raw − (raw − 0.93) × 0.4)
  // in the Stats factor and the loss-probability tiebreak.
  const hitRateCal = calibratedUnder45HitRate(m);
  if (hitRateCal.adjusted) {
    console.log(
      `[Selector] Calibrated Under 4.5 from ${m.hitRate.toFixed(2)} to ${hitRateCal.effective.toFixed(2)} for ${homeName} vs ${awayName}.`,
    );
  }

  // ── The balanced 12-factor scorecard (all real data, no stand-ins) ────────
  const deepStatisticalAnalysis   = scoreDeepStatisticalAnalysis(m, stats, homeName, awayName);
  const allDataMesh               = scoreAllDataMesh(context, stats, opts);
  const statsFactor               = scoreStats(m, ctx, hitRateCal.effective, stats, homeName, awayName);
  const tacticalAnalysis          = scoreTactical(m, effLam, homeName, awayName, context);
  const matchImportance           = scoreImportance(context, opts);
  const playerVsPlayerForms       = scorePlayerVsPlayerForms(m, homeName, awayName, context);
  const deepStatisticalVector     = scoreDeepStatisticalVector(stats);
  const zeroBias                  = scoreBias(m, effLam, homeName, awayName, context);
  const form                      = scoreForm(m, homeName, awayName, context);
  const conditionalLambda         = scoreConditionalLambda(m, effLam, stats, homeName, awayName);
  const poisson                   = scorePoisson(m, effLam, homeName, awayName);
  const statisticsAllStatesFilled = scoreStatisticsAllStatesFilled(stats);

  const factorResults: Record<FactorKey, FactorResult> = {
    deepStatisticalAnalysis,
    allDataMesh,
    stats: statsFactor,
    tacticalAnalysis,
    matchImportance,
    playerVsPlayerForms,
    deepStatisticalVector,
    zeroBias,
    form,
    conditionalLambda,
    poisson,
    statisticsAllStatesFilled,
  };

  const breakdown: FactorBreakdown = ALL_FACTOR_KEYS.reduce((acc, k) => {
    acc[k] = factorResults[k].score;
    return acc;
  }, {} as FactorBreakdown);

  // ── Dynamic weight redistribution (data-gap contract) ─────────────────────
  // Factors whose data is unavailable are EXCLUDED entirely — never replaced
  // with a neutral stand-in — and the remaining factors' weights are scaled
  // proportionally so they sum to exactly 100%.
  const excludedFactors = ALL_FACTOR_KEYS.filter((k) => factorResults[k].available === false);
  const activeKeys = ALL_FACTOR_KEYS.filter((k) => factorResults[k].available !== false);

  // The Stats factor is always data-backed (calibration component), so the
  // active weight mass can never collapse to zero.
  const activeWeightTotal = activeKeys.reduce((sum, k) => sum + RANKING_WEIGHTS[k], 0)
    || RANKING_WEIGHTS.stats
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

  // Consensus loss probability for tiebreaks (1 − effective hit rate). For
  // Under 4.5 markets the CALIBRATED hit rate is used, so the re-rank is
  // driven by the adjusted probability rather than the raw one.
  const wrongProb = clamp(1 - hitRateCal.effective, 0, 1);

  // σ-cushion for λ markets (third tiebreak).
  const lamVal = lambdaFor(m, effLam, homeName, awayName);
  const line = lineOf(m);
  const marginUnits = lamVal !== null && line !== null
    ? sigmaCushion(lamVal, line)
    : 0;

  const gaps = ALL_FACTOR_KEYS
    .map((k) => factorResults[k].gap)
    .filter((g): g is string => !!g);

  const notes =
    ALL_FACTOR_KEYS
      .map((k) => `${FACTOR_LABELS[k].split(" ").map((w) => w[0]).join("")}=${breakdown[k].toFixed(2)}`)
      .join(" ") +
    ` → composite=${composite.toFixed(3)} loss=${(wrongProb * 100).toFixed(1)}% ` +
    `w[${activeKeys.map((k) => `${FACTOR_LABELS[k]}=${((appliedWeights[k] ?? 0) * 100).toFixed(1)}%`).join(" ")}]` +
    (excludedFactors.length ? ` excluded[${excludedFactors.map((k) => FACTOR_LABELS[k]).join(",")}]` : "") +
    (statField ? ` stat=${statField}@${(statConfidence * 100).toFixed(0)}%${statFallback ? "(fallback)" : ""}` : "") +
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
    effectiveHitRate: hitRateCal.effective,
    excludedFactors,
    appliedWeights,
    statConfidence,
    statField,
    statFallback,
  };
}

/**
 * The API-facing factor breakdown for a market: AVAILABLE factors only, keyed
 * by their human-readable label (the exact key format of the `factors` field
 * in the API response). Excluded factors are omitted — they have no real
 * score, and no simulated stand-in is ever emitted.
 */
export function labelledFactors(s: MarketScore): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ALL_FACTOR_KEYS) {
    if (s.excludedFactors.includes(k)) continue;
    out[FACTOR_LABELS[k]] = Math.round(s.breakdown[k] * 100) / 100;
  }
  return out;
}

// ─── Key deduplication ────────────────────────────────────────────────────────

// "Total Offsides O/U 7.5" → "Total Offsides"  (one line per underlying stat)
function statKey(m: Market): string {
  return m.name.replace(/\s*O\/U\s*[\d.]+\s*/, "").trim();
}

// ─── Match-level confidence gate ──────────────────────────────────────────────
//
// Ranking answers "which markets are best for THIS match?". The confidence gate
// answers the separate question "should we bet this match at all?" — the driver
// of hit-rate consistency, since a Top-10 built from thin data on a weak feed is
// structurally less reliable than the same Top-10 built from a complete ESPN
// payload, even when both look similar after ranking.
//
// The score is a weighted blend of three REAL, already-computed signals:
//
//   1. Calibration / hit rate of the Top-10 ......... 50%
//      Mean empirical reliability (calibration factor) of the picks that are
//      actually being returned. Higher = the pick set leans on market types
//      that historically settle as predicted.
//
//   2. Factor coverage ............................... 30%
//      Share of the ranking weight mass that had REAL data behind it. Every
//      excluded factor (missing form, injuries, odds movement, weather …)
//      means the composite was decided by fewer independent signals, so the
//      ranking itself is less trustworthy.
//
//   3. Source priority / provenance .................. 20%
//      Which feeds supplied the data: ESPN / SportScore / StatsBomb = high,
//      official league APIs = medium, free aggregators = low. Additionally
//      discounted by the share of Top-10 slots that had to be filled from the
//      calibration BACKFILL tier (0.55–0.85) instead of the trusted ≥85% tier.
//
// Same data-gap contract as the ranking: if no source provenance is supplied at
// all, the source component is EXCLUDED and its 20% is redistributed across the
// remaining two — never replaced with a neutral stand-in.
//
// A final depth factor discounts matches that could not even produce a full
// Top-10 of qualified, verifiable picks.

/** Component weights of the match confidence score (Σ = 1). */
export const CONFIDENCE_WEIGHTS = {
  calibration:    0.50,
  factorCoverage: 0.30,
  sourceQuality:  0.20,
} as const;

export type ConfidenceComponentKey = keyof typeof CONFIDENCE_WEIGHTS;

/** Below this score a match is flagged "low confidence". */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;
/** Below this score a match is not worth betting at all. */
export const DEFAULT_CONFIDENCE_SKIP_THRESHOLD = 0.50;
/** Picks returned by a trimmed low-confidence match. */
export const DEFAULT_LOW_CONFIDENCE_PICK_COUNT = 3;
/** Full-strength pick count (a short Top-N is itself a confidence signal). */
const TARGET_PICK_COUNT = 10;
/** Max discount applied to the source component by backfill-tier usage. */
const BACKFILL_SOURCE_PENALTY = 0.35;

/** Source provenance tiers → confidence contribution. */
export type SourceTier = "high" | "medium" | "low" | "unknown";

const SOURCE_TIER_SCORE: Record<SourceTier, number> = {
  high:    1.00,
  medium:  0.80,
  low:     0.55,
  unknown: 0.50,
};

/** Priority feeds — real, first-party or high-trust providers. */
const HIGH_TIER_SOURCES = new Set([
  "espn", "sportscore", "statsbomb", "opta",
]);
/** Official league APIs and reference data providers. */
const MEDIUM_TIER_SOURCES = new Set([
  "openligadb", "premierleagueofficial", "laligaofficial", "serieaofficial",
  "footballdata", "fbref", "whoscored",
]);
/** Free-tier / community aggregators used to backfill missing fields. */
const LOW_TIER_SOURCES = new Set([
  "thesportsdb", "apifootball", "footystats", "backfill", "fallback", "cache",
]);

const normalizeSourceName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Tier of a single named source (unknown when the name is not registered). */
export function sourceTierOf(source: string | null | undefined): SourceTier {
  if (!source) return "unknown";
  const key = normalizeSourceName(source);
  if (!key) return "unknown";
  if (HIGH_TIER_SOURCES.has(key)) return "high";
  if (MEDIUM_TIER_SOURCES.has(key)) return "medium";
  if (LOW_TIER_SOURCES.has(key)) return "low";
  return "unknown";
}

/** One scored component of the confidence blend. */
export interface ConfidenceComponent {
  /** 0..1 raw component score. */
  score:     number;
  /** Nominal weight from CONFIDENCE_WEIGHTS. */
  weight:    number;
  /** Weight actually applied after redistribution (0 when unavailable). */
  applied:   number;
  /** false → data unavailable, component excluded and weight redistributed. */
  available: boolean;
  /** Human-readable explanation for the monitoring log / UI. */
  detail:    string;
}

/** Match-level confidence verdict attached to every selection. */
export interface MatchConfidence {
  /** 0..1 blended confidence score. */
  score:          number;
  /** Same score as a rounded 0..100 percentage (UI-friendly). */
  scorePct:       number;
  /** HIGH ≥ threshold · LOW ≥ skip floor · VERY_LOW below the skip floor. */
  level:          "HIGH" | "LOW" | "VERY_LOW";
  /** True when the score is below the configured threshold. */
  lowConfidence:  boolean;
  /** What the gate did: full Top-10, reduced pick set, or skipped match. */
  action:         "full" | "reduced" | "skipped";
  /** Number of picks actually returned after the gate. */
  picksReturned:  number;
  threshold:      number;
  skipThreshold:  number;
  policy:         ConfidencePolicy;
  components:     Record<ConfidenceComponentKey, ConfidenceComponent>;
  /** Mean calibration / historical hit rate of the returned picks (0..1). */
  avgCalibration: number;
  /** Mean number of ranking factors that had real data (of 11). */
  avgFactorsAvailable: number;
  totalFactors:   number;
  /** Factors missing across the pick set (weight was redistributed). */
  missingFactors: FactorKey[];
  /** Provenance summary. */
  sourceTier:     SourceTier;
  sources:        string[];
  /** Top-N slots filled from the 0.55–0.85 calibration backfill tier. */
  backfillPicks:  number;
  /** Bullet reasons behind the score (logged + surfaced to the UI). */
  reasons:        string[];
  /** One-line summary for logs and UI badges. */
  summary:        string;
}

const TOTAL_RANKING_WEIGHT = ALL_FACTOR_KEYS.reduce((sum, k) => sum + RANKING_WEIGHTS[k], 0);

/** Resolve the gate configuration, applying defaults. */
function resolveConfidenceOptions(opts?: ConfidenceOptions): Required<ConfidenceOptions> {
  const threshold = clamp(opts?.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD, 0, 1);
  const skipThreshold = clamp(opts?.skipThreshold ?? DEFAULT_CONFIDENCE_SKIP_THRESHOLD, 0, threshold);
  return {
    threshold,
    skipThreshold,
    // Default "flag" keeps every existing caller's pick count unchanged; the
    // oracle pipeline opts into "trim"/"skip" explicitly.
    policy:                 opts?.policy ?? "flag",
    lowConfidencePickCount: Math.max(1, Math.round(opts?.lowConfidencePickCount ?? DEFAULT_LOW_CONFIDENCE_PICK_COUNT)),
    enabled:                opts?.enabled ?? true,
  };
}

/** Source-priority component (20%) — provenance tier + field + backfill share. */
function scoreSourceQuality(
  source: SourceQualityContext | null | undefined,
  backfillPicks: number,
  pickCount: number,
): { result: FactorResult; tier: SourceTier; sources: string[] } {
  const named = [
    ...(source?.primarySource ? [source.primarySource] : []),
    ...(source?.contributingSources ?? []),
  ].filter((s): s is string => !!s && !!s.trim());
  const unique = [...new Set(named)];

  const backfillShare = pickCount > 0 ? clamp(backfillPicks / pickCount, 0, 1) : 0;
  const backfillFactor = 1 - BACKFILL_SOURCE_PENALTY * backfillShare;

  // Explicit override wins (callers that compute provenance themselves).
  if (typeof source?.score === "number" && Number.isFinite(source.score)) {
    const base = clamp(source.score, 0, 1);
    return {
      result: {
        score: clamp(base * backfillFactor, 0, 1),
        gap: backfillShare > 0 ? `source score ${base.toFixed(2)} discounted by backfill share ${(backfillShare * 100).toFixed(0)}%` : undefined,
      },
      tier: base >= 0.95 ? "high" : base >= 0.75 ? "medium" : "low",
      sources: unique,
    };
  }

  if (!unique.length) {
    return {
      result: {
        score: SOURCE_TIER_SCORE.unknown,
        available: false,
        gap: "no source provenance supplied — source component excluded, weight redistributed",
      },
      tier: "unknown",
      sources: [],
    };
  }

  const tiers = unique.map(sourceTierOf);
  const tierMean = tiers.reduce((sum, t) => sum + SOURCE_TIER_SCORE[t], 0) / tiers.length;
  const primaryTier = sourceTierOf(source?.primarySource) !== "unknown"
    ? sourceTierOf(source?.primarySource)
    : tiers[0];

  // Field coverage (how much of the enrichment contract the feeds actually
  // filled) refines the tier score when the caller provides it.
  const coverage = typeof source?.fieldCoverage === "number" && Number.isFinite(source.fieldCoverage)
    ? clamp(source.fieldCoverage, 0, 1)
    : null;
  const base = coverage === null ? tierMean : tierMean * 0.75 + coverage * 0.25;

  return {
    result: { score: clamp(base * backfillFactor, 0, 1) },
    tier: primaryTier,
    sources: unique,
  };
}

/**
 * Compute the match-level confidence verdict for a ranked pick set.
 *
 * Exported so the oracle (and tests / monitoring jobs) can score a selection
 * without re-running the selector.
 */
export function computeMatchConfidence(
  picks: MarketScore[],
  opts?: SelectOptions,
  meta?: { backfillPicks?: number },
): MatchConfidence {
  const cfg = resolveConfidenceOptions(opts?.confidence);
  const pickCount = picks.length;
  const backfillPicks = meta?.backfillPicks
    ?? picks.filter((s) => s.effectiveHitRate < MIN_CALIBRATION_HIT_RATE).length;

  // ── Component 1: calibration / historical hit rate of the Top-10 ──────────
  const avgCalibration = pickCount
    ? picks.reduce((sum, s) => sum + s.effectiveHitRate, 0) / pickCount
    : 0;

  // ── Component 2: factor coverage (share of real ranking weight mass) ──────
  const coveragePerPick = picks.map((s) => {
    const excludedMass = s.excludedFactors.reduce((sum, k) => sum + RANKING_WEIGHTS[k], 0);
    return (TOTAL_RANKING_WEIGHT - excludedMass) / TOTAL_RANKING_WEIGHT;
  });
  const factorCoverage = coveragePerPick.length
    ? coveragePerPick.reduce((a, b) => a + b, 0) / coveragePerPick.length
    : 0;
  const avgFactorsAvailable = pickCount
    ? picks.reduce((sum, s) => sum + (ALL_FACTOR_KEYS.length - s.excludedFactors.length), 0) / pickCount
    : 0;
  const missingUnion = new Set<FactorKey>();
  for (const s of picks) s.excludedFactors.forEach((k) => missingUnion.add(k));
  const missingFactors = ALL_FACTOR_KEYS.filter((k) => missingUnion.has(k));

  // ── Component 3: source priority / provenance ─────────────────────────────
  const src = scoreSourceQuality(opts?.sourceQuality, backfillPicks, pickCount);

  const raw: Record<ConfidenceComponentKey, FactorResult> = {
    calibration:    { score: clamp(avgCalibration, 0, 1) },
    factorCoverage: { score: clamp(factorCoverage, 0, 1) },
    sourceQuality:  src.result,
  };

  // Dynamic weight redistribution — identical contract to the ranking factors.
  const componentKeys = Object.keys(CONFIDENCE_WEIGHTS) as ConfidenceComponentKey[];
  const activeKeys = componentKeys.filter((k) => raw[k].available !== false);
  const activeWeight = activeKeys.reduce((sum, k) => sum + CONFIDENCE_WEIGHTS[k], 0)
    || CONFIDENCE_WEIGHTS.calibration;

  const blended = activeKeys.reduce(
    (sum, k) => sum + (CONFIDENCE_WEIGHTS[k] / activeWeight) * raw[k].score,
    0,
  );

  // Depth discount — a match that cannot fill a full Top-10 of qualified,
  // verifiable picks is inherently thinner evidence.
  const depthFactor = pickCount >= TARGET_PICK_COUNT
    ? 1
    : 0.85 + 0.15 * (pickCount / TARGET_PICK_COUNT);
  const score = clamp(blended * depthFactor, 0, 1);

  const components = componentKeys.reduce((acc, k) => {
    acc[k] = {
      score:     clamp(raw[k].score, 0, 1),
      weight:    CONFIDENCE_WEIGHTS[k],
      applied:   raw[k].available === false ? 0 : CONFIDENCE_WEIGHTS[k] / activeWeight,
      available: raw[k].available !== false,
      detail:    "",
    };
    return acc;
  }, {} as Record<ConfidenceComponentKey, ConfidenceComponent>);

  components.calibration.detail =
    `mean calibration of ${pickCount} pick(s) = ${(avgCalibration * 100).toFixed(1)}%`;
  components.factorCoverage.detail =
    `${(factorCoverage * 100).toFixed(1)}% of ranking weight backed by real data ` +
    `(${avgFactorsAvailable.toFixed(1)}/${ALL_FACTOR_KEYS.length} factors` +
    `${missingFactors.length ? `, missing: ${missingFactors.join(", ")}` : ""})`;
  components.sourceQuality.detail = src.result.available === false
    ? (src.result.gap ?? "source provenance unavailable — component excluded")
    : `${src.tier} tier (${src.sources.join(" + ") || "unknown"})` +
      (backfillPicks ? ` · ${backfillPicks}/${pickCount} picks from the calibration backfill tier` : "");

  const lowConfidence = cfg.enabled && score < cfg.threshold;
  const level: MatchConfidence["level"] =
    score < cfg.skipThreshold ? "VERY_LOW" : score < cfg.threshold ? "LOW" : "HIGH";

  const reasons: string[] = componentKeys.map(
    (k) => `${k}: ${(components[k].score * 100).toFixed(1)}% × ${(components[k].applied * 100).toFixed(0)}% — ${components[k].detail}`,
  );
  if (depthFactor < 1) {
    reasons.push(`pick depth: only ${pickCount}/${TARGET_PICK_COUNT} qualified verifiable picks — score × ${depthFactor.toFixed(3)}`);
  }
  if (!cfg.enabled) reasons.push("confidence gate disabled — score reported only, no action taken");

  return {
    score,
    scorePct: Math.round(score * 1000) / 10,
    level,
    lowConfidence,
    action: "full",           // finalised by the gate in selectTopPicks()
    picksReturned: pickCount, // finalised by the gate in selectTopPicks()
    threshold:     cfg.threshold,
    skipThreshold: cfg.skipThreshold,
    policy:        cfg.policy,
    components,
    avgCalibration,
    avgFactorsAvailable,
    totalFactors: ALL_FACTOR_KEYS.length,
    missingFactors,
    sourceTier: src.tier,
    sources:    src.sources,
    backfillPicks,
    reasons,
    summary: "",              // finalised by the gate in selectTopPicks()
  };
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
  missingFactors?: (FactorKey | ClassicFactorKey)[];
  /**
   * Match-level confidence verdict (see computeMatchConfidence). Always set
   * once markets were ranked, so the UI can show a warning — or the caller can
   * skip the match — when `confidence.lowConfidence` is true.
   */
  confidence?:     MatchConfidence;
  /** Human-readable confidence lines for the per-match monitoring log. */
  confidenceLog?:  string[];
}

const EMPTY_SELECTION = (reason: string, gaps: string[] = []): SelectionResult => ({
  top1: [], top3: [], top5: [], top10: [], skipped: reason, gaps,
});

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

  const rankingMode = resolveRankingMode(opts);
  console.log(rankingModeLogLine(rankingMode));
  if (rankingMode === 'A') {
    return selectTopPicksClassic(markets, lam, homeName, awayName, confidenceMap, opts);
  }
  if (rankingMode === 'C') {
    return rankHybrid(markets, lam, homeName, awayName, confidenceMap, opts);
  }

  const gapLog = new Set<string>();

  // ── Step 1: Score every non-rejected market across all twelve factors ───────
  const scored = markets
    .filter((m) => !m.rejected)
    .map((m) => {
      const s = scoreMarket(m, lam, homeName, awayName, confidenceMap, opts);
      s.gaps.forEach((g) => gapLog.add(g));
      return s;
    });

  if (scored.length === 0) {
    return EMPTY_SELECTION("No qualified markets to rank.", [...gapLog]);
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
  const context = opts?.context ?? null;
  const hardQualified = ranked.filter((s) => {
    const reason = hardSafetyRejectReason(s, context, homeName, awayName);
    if (reason) {
      gapLog.add(`hard filter skipped ${s.market.id}: ${reason}`);
      return false;
    }
    return true;
  });
  if (hardQualified.length === 0) {
    return EMPTY_SELECTION(
      "No market remains after hard safety filters (injury severity).",
      [...gapLog],
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
    return EMPTY_SELECTION(
      "No Top-N-eligible market remains after applying the team-goals safety net.",
      [...gapLog],
    );
  }

  // ── Step 5: Top-N slots require verifiable markets (settleable picks) ──────
  const verifiableRanked = topNQualified.filter((s) => s.verifiable);
  if (verifiableRanked.length === 0) {
    return EMPTY_SELECTION(
      "No verifiable market remains after scoring and hard safety filters — match skipped.",
      [...gapLog],
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
    .filter((s) => s.effectiveHitRate >= MIN_CALIBRATION_HIT_RATE)
    .sort(comparator);
  const backfillTier = verifiableRanked
    .filter((s) =>
      s.effectiveHitRate < MIN_CALIBRATION_HIT_RATE &&
      s.effectiveHitRate >= MIN_BACKFILL_CALIBRATION_HIT_RATE)
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
  const top10 = top10Scores.map((s) => s.market);

  const backfilledCount = top10Scores.filter(
    (s) => s.effectiveHitRate < MIN_CALIBRATION_HIT_RATE,
  ).length;
  if (backfilledCount > 0) {
    gapLog.add(
      `Top-10 backfill tier used for ${backfilledCount}/10 slots (trusted ≥85% calibration pool exhausted; backfill picks still qualified, safety-net-checked and verifiable)`,
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
  console.log(
    `[selector] ${homeName} vs ${awayName} — top10: ${top10.length}/10` +
    (backfilledCount ? ` (backfill: ${backfilledCount})` : "") +
    (excludedUnion.size ? ` | missing: ${[...excludedUnion].join(",")}` : " | all factors available") +
    (lead ? ` | ${weightLog[0]}` : ""),
  );

  // ── Step 8: Match-level confidence gate ───────────────────────────────────
  // The ranking is done; now decide whether this match is worth betting at all.
  // Low-confidence matches are either flagged (UI warning), trimmed to the
  // safest few picks, or skipped outright — configurable per caller.
  const cfg = resolveConfidenceOptions(opts?.confidence);
  const confidence = computeMatchConfidence(top10Scores, opts, { backfillPicks: backfilledCount });

  const shouldSkip = cfg.enabled && cfg.policy === "skip" && confidence.score < cfg.threshold;
  const belowSkipFloor = cfg.enabled && cfg.policy !== "flag" && confidence.score < cfg.skipThreshold;
  const shouldTrim = cfg.enabled && cfg.policy === "trim" && confidence.lowConfidence;

  let finalPicks = top10;
  if (shouldSkip || belowSkipFloor) {
    confidence.action = "skipped";
    confidence.picksReturned = 0;
    finalPicks = [];
  } else if (shouldTrim) {
    confidence.action = "reduced";
    finalPicks = top10.slice(0, cfg.lowConfidencePickCount);
    confidence.picksReturned = finalPicks.length;
  } else {
    confidence.action = "full";
    confidence.picksReturned = finalPicks.length;
  }

  confidence.summary =
    `confidence ${confidence.scorePct.toFixed(1)}% (${confidence.level}) ` +
    `vs threshold ${(confidence.threshold * 100).toFixed(0)}% → ` +
    (confidence.action === "skipped"
      ? "match SKIPPED (no picks returned)"
      : confidence.action === "reduced"
        ? `reduced to Top-${confidence.picksReturned}`
        : `full Top-${confidence.picksReturned}`);

  const confidenceLog = [
    confidence.summary,
    ...confidence.reasons.map((r) => `· ${r}`),
  ];

  // Monitoring: one confidence line per match.
  console.log(
    `[selector][confidence] ${homeName} vs ${awayName} — score ${confidence.scorePct.toFixed(1)}% ` +
    `(${confidence.level}) | cal ${(confidence.components.calibration.score * 100).toFixed(1)}% ` +
    `| factors ${(confidence.components.factorCoverage.score * 100).toFixed(1)}% ` +
    `(${confidence.avgFactorsAvailable.toFixed(1)}/${confidence.totalFactors}) ` +
    `| source ${confidence.components.sourceQuality.available
      ? `${(confidence.components.sourceQuality.score * 100).toFixed(1)}% [${confidence.sourceTier}: ${confidence.sources.join("+") || "n/a"}]`
      : "unavailable (weight redistributed)"} ` +
    `| backfill ${confidence.backfillPicks}/${top10.length} ` +
    `| threshold ${(confidence.threshold * 100).toFixed(0)}% | policy ${confidence.policy} ` +
    `→ ${confidence.action.toUpperCase()} (${confidence.picksReturned} picks)`,
  );

  if (confidence.action === "skipped") {
    return {
      ...EMPTY_SELECTION(
        `Low confidence (${confidence.scorePct.toFixed(1)}% < ${(confidence.threshold * 100).toFixed(0)}%) — match skipped by the confidence gate.`,
        [...gapLog],
      ),
      rankingNotes: top10.map((m) => {
        const s = scored.find((x) => x.market === m);
        return s ? s.notes : `${m.name} · ${m.selection}`;
      }),
      weightLog,
      missingFactors: [...excludedUnion],
      confidence,
      confidenceLog,
    };
  }

  // ── Step 9: Contextual Top-1 ban (Part 1) ─────────────────────────────────
  // Before the Top-1 slot is finalised, high-line Unders (Under 4.5 / 5.5+)
  // on explosive matches are demoted and the next best ranked market leads.
  // The blocked market stays in the Top-N; with no alternative the first pick
  // is kept (data-driven filter, never a permanent hard ban).
  const orderedPicks = applyTop1ExplosionBan(finalPicks, homeName, awayName, opts);

  // ── Step 10: Factor transparency ──────────────────────────────────────────
  // Attach the 12-factor breakdown + composite score to every returned pick as
  // NEW additive fields (`factors` + `compositeScore`). No existing field is
  // renamed, removed or restructured — the Top-10 array shape is unchanged.
  for (const m of orderedPicks) {
    const s = scored.find((x) => x.market === m);
    if (!s) continue;
    m.factors = labelledFactors(s);
    m.compositeScore = Math.round(s.composite * 100) / 100;
  }

  return {
    top1:  orderedPicks.slice(0, 1),
    top3:  orderedPicks.slice(0, 3),
    top5:  orderedPicks.slice(0, 5),
    top10: orderedPicks,
    gaps:         [...gapLog],
    rankingNotes: orderedPicks.map((m) => {
      const s = scored.find((x) => x.market === m);
      return s ? s.notes : `${m.name} · ${m.selection}`;
    }),
    weightLog,
    missingFactors: [...excludedUnion],
    confidence,
    confidenceLog,
  };
}

// ─── Hybrid selection (Rank C) ───────────────────────────────────────────────
// Rank C combines Rank A (Classic 11-factor) and Rank B (12-Factor) into one
// unified Top 10. Both engines score every market in the pool EXACTLY as they
// do in their own modes (their internals are untouched); Rank C only reads
// their outputs and combines them:
//
//     compositeScore = (scoreA + scoreB) / 2
//
// All markets are ranked by that averaged score descending — the market with
// the highest average score becomes Top 1 — and the Top 10 is the top 10
// markets by the averaged score. After the average is computed, the exact
// same downstream pipeline as the other modes applies, in the same order:
// injury-severity hard filter → non-giant Under-3.5 safety net → verifiability
// gate → Top-10 fill (trusted ≥85% tier, then 55–85% backfill) → confidence
// gate → contextual Top-1 explosion ban for high-line Unders.
//
// The match-level confidence verdict is likewise the average of the two
// engines' own (unchanged) verdicts on the resulting Top-10 set.

interface HybridScore {
  market: Market;
  /** Averaged composite: (Classic + 12-Factor) / 2 — the hybrid final score. */
  composite:        number;
  /** Classic 11-factor composite (Rank A output). */
  compositeA:       number;
  /** 12-Factor composite (Rank B output). */
  compositeB:       number;
  /** Averaged effective hit rate — drives the trusted/backfill tier fill. */
  effectiveHitRate: number;
  /** Consensus loss probability (1 − effectiveHitRate) for tiebreaks. */
  wrongProb:        number;
  /** Averaged σ-cushion vs the line (third tiebreak). */
  marginUnits:      number;
  verifiable:       boolean;
  /** Full Classic (Rank A) score — kept for the confidence gate + transparency. */
  classic:          ClassicMarketScore;
  /** Full 12-Factor (Rank B) score — kept for the confidence gate + transparency. */
  balanced:         MarketScore;
}

function hybridNote(s: HybridScore): string {
  return `hybrid composite=${s.composite.toFixed(3)} (A Classic=${s.compositeA.toFixed(3)} + B 12-Factor=${s.compositeB.toFixed(3)}) loss=${(s.wrongProb * 100).toFixed(1)}%`;
}

/**
 * Blend the two engines' confidence verdicts for a hybrid (Rank C) selection.
 * Each engine scores the SAME Top-10 set with its own gate (unchanged
 * internals); the hybrid verdict averages the two, mirroring the hybrid
 * composite rule. `cfg` is the shared resolved gate configuration.
 */
function averageMatchConfidence(
  a:   MatchConfidence,
  b:   MatchConfidence,
  cfg: Required<ConfidenceOptions>,
): MatchConfidence {
  const score = clamp((a.score + b.score) / 2, 0, 1);

  const componentKeys = Object.keys(CONFIDENCE_WEIGHTS) as ConfidenceComponentKey[];
  const components = componentKeys.reduce((acc, k) => {
    const ca = a.components[k];
    const cb = b.components[k];
    acc[k] = {
      score:     clamp((ca.score + cb.score) / 2, 0, 1),
      weight:    ca.weight,
      applied:   (ca.applied + cb.applied) / 2,
      available: ca.available && cb.available,
      detail:    `A ${ca.detail} || B ${cb.detail}`,
    };
    return acc;
  }, {} as Record<ConfidenceComponentKey, ConfidenceComponent>);

  return {
    score,
    scorePct: Math.round(score * 1000) / 10,
    level:         score < cfg.skipThreshold ? "VERY_LOW" : score < cfg.threshold ? "LOW" : "HIGH",
    lowConfidence: cfg.enabled && score < cfg.threshold,
    action:        "full",            // finalised by the gate in rankHybrid()
    picksReturned: a.picksReturned,   // finalised by the gate in rankHybrid()
    threshold:     cfg.threshold,
    skipThreshold: cfg.skipThreshold,
    policy:        cfg.policy,
    components,
    avgCalibration:      (a.avgCalibration + b.avgCalibration) / 2,
    avgFactorsAvailable: (a.avgFactorsAvailable + b.avgFactorsAvailable) / 2,
    totalFactors:        b.totalFactors,
    missingFactors:      [...new Set([...a.missingFactors, ...b.missingFactors])],
    sourceTier:          a.sourceTier,
    sources:             a.sources,
    backfillPicks:       a.backfillPicks,
    reasons: [
      ...a.reasons.map((r) => `[A Classic] ${r}`),
      ...b.reasons.map((r) => `[B 12-Factor] ${r}`),
    ],
    summary: "",                      // finalised by the gate in rankHybrid()
  };
}

export function rankHybrid(
  markets:        Market[],
  lam:            LambdaSet,
  homeName:       string,
  awayName:       string,
  confidenceMap?: Record<string, number>,
  opts?:          SelectOptions,
): SelectionResult {
  const gapLog  = new Set<string>();
  const context = opts?.context ?? null;

  // ── Step 1: Score every non-rejected market with BOTH engines ──────────────
  // rankClassic (Classic 11-factor) and rankNew (12-Factor) each score the
  // pool internally exactly as they would on their own; Rank C reads their
  // per-market outputs and averages them: (scoreA + scoreB) / 2.
  const scored: HybridScore[] = markets
    .filter((m) => !m.rejected)
    .map((m) => {
      const classic  = scoreMarketClassic(m, lam, homeName, awayName, confidenceMap, opts);
      const balanced = scoreMarket(m, lam, homeName, awayName, confidenceMap, opts);
      classic.gaps.forEach((g) => gapLog.add(g));
      balanced.gaps.forEach((g) => gapLog.add(g));
      const composite = (classic.composite + balanced.composite) / 2;
      const effectiveHitRate = (classic.effectiveHitRate + balanced.effectiveHitRate) / 2;
      return {
        market: m,
        composite:        clamp(composite, 0, 1),
        compositeA:       classic.composite,
        compositeB:       balanced.composite,
        effectiveHitRate: clamp(effectiveHitRate, 0, 1),
        wrongProb:        clamp(1 - effectiveHitRate, 0, 1),
        marginUnits:      (classic.marginUnits + balanced.marginUnits) / 2,
        verifiable:       balanced.verifiable,
        classic,
        balanced,
      };
    });

  if (scored.length === 0) {
    return EMPTY_SELECTION("No qualified markets to rank.", [...gapLog]);
  }

  // ── Step 2: Deterministic ranking by the AVERAGED composite ────────────────
  // Composite desc → loss prob asc → σ-cushion desc → id. The market with the
  // highest average score leads before the contextual filters below.
  const comparator = (a: HybridScore, b: HybridScore) => {
    const dc = b.composite - a.composite;
    if (Math.abs(dc) > 1e-6) return dc;
    const dw = a.wrongProb - b.wrongProb;
    if (Math.abs(dw) > 1e-6) return dw;
    const dm = b.marginUnits - a.marginUnits;
    if (Math.abs(dm) > 1e-6) return dm;
    return a.market.id.localeCompare(b.market.id);
  };
  const ranked = [...scored].sort(comparator);

  // ── Step 3: Hard safety filters BEFORE Top-10 assembly (injury severity) ──
  const hardQualified = ranked.filter((s) => {
    const blocked = injurySeverityBlocksMarket(s.market, context, homeName, awayName);
    if (blocked) gapLog.add(`hard filter skipped ${s.market.id}: team-specific market blocked by injury severity filter`);
    return !blocked;
  });
  if (hardQualified.length === 0) {
    return EMPTY_SELECTION(
      "No market remains after hard safety filters (injury severity).",
      [...gapLog],
    );
  }

  // ── Step 4: Safety net — block non-giant team-specific Under 3.5 Goals ─────
  const topNQualified = hardQualified.filter((s) => {
    const blocked = isBlockedTeamSpecificUnder35Goals(s.market, homeName, awayName);
    if (blocked) gapLog.add(`safety net skipped ${s.market.id}: non-giant team-specific Under 3.5 Goals`);
    return !blocked;
  });
  if (topNQualified.length === 0) {
    return EMPTY_SELECTION(
      "No Top-N-eligible market remains after applying the team-goals safety net.",
      [...gapLog],
    );
  }

  // ── Step 5: Top-N slots require verifiable markets (settleable picks) ──────
  const verifiableRanked = topNQualified.filter((s) => s.verifiable);
  if (verifiableRanked.length === 0) {
    return EMPTY_SELECTION(
      "No verifiable market remains after scoring and hard safety filters — match skipped.",
      [...gapLog],
    );
  }

  // ── Step 6: Top-10 fill guarantee (trusted tier → backfill tier → extras) ──
  // Diversity first: one line per underlying stat. Trusted (≥85% effective
  // calibration) lines fill the slots first; if fewer than 10 distinct trusted
  // stats survive the safety filters, the backfill tier (0.55–0.85, still
  // fully filtered and verifiable) and then additional lines of already-
  // represented stats complete the Top-10. No safety filter is relaxed.
  const trustedTier = verifiableRanked
    .filter((s) => s.effectiveHitRate >= MIN_CALIBRATION_HIT_RATE)
    .sort(comparator);
  const backfillTier = verifiableRanked
    .filter((s) =>
      s.effectiveHitRate < MIN_CALIBRATION_HIT_RATE &&
      s.effectiveHitRate >= MIN_BACKFILL_CALIBRATION_HIT_RATE)
    .sort(comparator);

  const seen = new Set<string>();
  const deduped: HybridScore[] = [];
  const extrasPool: HybridScore[] = [];
  for (const s of [...trustedTier, ...backfillTier]) {
    const key = statKey(s.market);
    if (seen.has(key)) { extrasPool.push(s); continue; }
    seen.add(key);
    deduped.push(s);
  }
  const extras = extrasPool.sort(comparator);
  const top10Scores = [...deduped, ...extras].slice(0, 10);
  const top10 = top10Scores.map((s) => s.market);

  const backfilledCount = top10Scores.filter(
    (s) => s.effectiveHitRate < MIN_CALIBRATION_HIT_RATE,
  ).length;
  if (backfilledCount > 0) {
    gapLog.add(
      `Top-10 backfill tier used for ${backfilledCount}/10 slots (trusted ≥85% calibration pool exhausted; backfill picks still qualified, safety-net-checked and verifiable)`,
    );
  }

  // ── Step 7: Logging — hybrid composite + missing factors per engine ────────
  const excludedUnionA = new Set<ClassicFactorKey>();
  for (const s of top10Scores) s.classic.excludedFactors.forEach((f) => excludedUnionA.add(f));
  const excludedUnionB = new Set<FactorKey>();
  for (const s of top10Scores) s.balanced.excludedFactors.forEach((f) => excludedUnionB.add(f));
  const lead = top10Scores[0];
  const weightLog: string[] = [];
  if (lead) {
    weightLog.push(
      `hybrid composite = average of Classic (A=${lead.compositeA.toFixed(3)}) and 12-Factor (B=${lead.compositeB.toFixed(3)}) composites`,
    );
  }
  const missingA = ALL_CLASSIC_KEYS.filter((k) => excludedUnionA.has(k));
  const missingB = ALL_FACTOR_KEYS.filter((k) => excludedUnionB.has(k));
  if (missingA.length) weightLog.push(`missing factors — Classic A (weight redistributed): ${missingA.join(", ")}`);
  if (missingB.length) weightLog.push(`missing factors — 12-Factor B (weight redistributed): ${missingB.join(", ")}`);
  if (backfilledCount > 0) {
    weightLog.push(`top-10 fill: ${10 - backfilledCount}/10 from the trusted tier (calibration ≥ 85%), ${backfilledCount}/10 backfilled from the 0.55–0.85 tier — all fully filtered`);
  }
  console.log(
    `[selector] ${homeName} vs ${awayName} — top10: ${top10.length}/10 (hybrid C: Classic A + 12-Factor B, averaged)` +
    (backfilledCount ? ` (backfill: ${backfilledCount})` : "") +
    (lead ? ` | top1 composite=${lead.composite.toFixed(3)} (A=${lead.compositeA.toFixed(3)} B=${lead.compositeB.toFixed(3)})` : ""),
  );

  // ── Step 8: Match-level confidence gate ────────────────────────────────────
  // Both engines run their own (unchanged) gate on the SAME Top-10 set; the
  // hybrid verdict is the average of the two, and the same flag/trim/skip
  // policy as every other mode is applied to it.
  const cfg = resolveConfidenceOptions(opts?.confidence);
  const confA = computeMatchConfidenceClassic(top10Scores.map((s) => s.classic), opts, { backfillPicks: backfilledCount });
  const confB = computeMatchConfidence(top10Scores.map((s) => s.balanced), opts, { backfillPicks: backfilledCount });
  const confidence = averageMatchConfidence(confA, confB, cfg);

  const shouldSkip = cfg.enabled && cfg.policy === "skip" && confidence.score < cfg.threshold;
  const belowSkipFloor = cfg.enabled && cfg.policy !== "flag" && confidence.score < cfg.skipThreshold;
  const shouldTrim = cfg.enabled && cfg.policy === "trim" && confidence.lowConfidence;

  let finalPicks = top10;
  if (shouldSkip || belowSkipFloor) {
    confidence.action = "skipped";
    confidence.picksReturned = 0;
    finalPicks = [];
  } else if (shouldTrim) {
    confidence.action = "reduced";
    finalPicks = top10.slice(0, cfg.lowConfidencePickCount);
    confidence.picksReturned = finalPicks.length;
  } else {
    confidence.action = "full";
    confidence.picksReturned = finalPicks.length;
  }

  confidence.summary =
    `confidence ${confidence.scorePct.toFixed(1)}% (${confidence.level}) ` +
    `vs threshold ${(confidence.threshold * 100).toFixed(0)}% → ` +
    (confidence.action === "skipped"
      ? "match SKIPPED (no picks returned)"
      : confidence.action === "reduced"
        ? `reduced to Top-${confidence.picksReturned}`
        : `full Top-${confidence.picksReturned}`);

  const confidenceLog = [
    confidence.summary,
    ...confidence.reasons.map((r) => `· ${r}`),
  ];

  // Monitoring: one confidence line per match.
  console.log(
    `[selector][confidence] ${homeName} vs ${awayName} — score ${confidence.scorePct.toFixed(1)}% ` +
    `(${confidence.level}) | cal ${(confidence.components.calibration.score * 100).toFixed(1)}% ` +
    `| factors ${(confidence.components.factorCoverage.score * 100).toFixed(1)}% ` +
    `(${confidence.avgFactorsAvailable.toFixed(1)}/${confidence.totalFactors}) ` +
    `| source ${confidence.components.sourceQuality.available
      ? `${(confidence.components.sourceQuality.score * 100).toFixed(1)}% [${confidence.sourceTier}: ${confidence.sources.join("+") || "n/a"}]`
      : "unavailable (weight redistributed)"} ` +
    `| backfill ${confidence.backfillPicks}/${top10.length} ` +
    `| threshold ${(confidence.threshold * 100).toFixed(0)}% | policy ${confidence.policy} ` +
    `→ ${confidence.action.toUpperCase()} (${confidence.picksReturned} picks)`,
  );

  if (confidence.action === "skipped") {
    return {
      ...EMPTY_SELECTION(
        `Low confidence (${confidence.scorePct.toFixed(1)}% < ${(confidence.threshold * 100).toFixed(0)}%) — match skipped by the confidence gate.`,
        [...gapLog],
      ),
      rankingNotes: top10.map((m) => {
        const s = scored.find((x) => x.market === m);
        return s ? hybridNote(s) : `${m.name} · ${m.selection}`;
      }),
      weightLog,
      missingFactors: [...excludedUnionA, ...excludedUnionB],
      confidence,
      confidenceLog,
    };
  }

  // ── Step 9: Contextual Top-1 ban (Part 1) ──────────────────────────────────
  // Before the Top-1 slot is finalised, high-line Unders (Under 4.5 / 5.5+)
  // on explosive matches are demoted and the next best ranked market leads.
  // The blocked market stays in the Top-N; with no alternative the first pick
  // is kept (data-driven filter, never a permanent hard ban).
  const orderedPicks = applyTop1ExplosionBan(finalPicks, homeName, awayName, opts);

  // ── Step 10: Factor transparency ───────────────────────────────────────────
  // Attach the hybrid composite (averaged score) to every returned pick; the
  // per-factor breakdown shown is the 12-Factor (Rank B) scorecard.
  for (const m of orderedPicks) {
    const s = scored.find((x) => x.market === m);
    if (!s) continue;
    m.factors = labelledFactors(s.balanced);
    m.compositeScore = Math.round(s.composite * 100) / 100;
  }

  return {
    top1:  orderedPicks.slice(0, 1),
    top3:  orderedPicks.slice(0, 3),
    top5:  orderedPicks.slice(0, 5),
    top10: orderedPicks,
    gaps:         [...gapLog],
    rankingNotes: orderedPicks.map((m) => {
      const s = scored.find((x) => x.market === m);
      return s ? hybridNote(s) : `${m.name} · ${m.selection}`;
    }),
    weightLog,
    missingFactors: [...excludedUnionA, ...excludedUnionB],
    confidence,
    confidenceLog,
  };
}
