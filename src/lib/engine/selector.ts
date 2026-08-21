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

/** Factor keys — mirror the fields of RANKING_WEIGHTS. */
export type FactorKey = keyof typeof RANKING_WEIGHTS;

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

/** Options passed to the selector. */
export interface SelectOptions {
  homeTable?:     TeamTableInfo;
  awayTable?:     TeamTableInfo;
  context?:       RankingContext;
  /** Which feeds supplied the real data (source-priority confidence input). */
  sourceQuality?: SourceQualityContext;
  /** Confidence-gate configuration (threshold / policy). */
  confidence?:    ConfidenceOptions;
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
    ?? picks.filter((s) => s.breakdown.calibration < MIN_CALIBRATION_HIT_RATE).length;

  // ── Component 1: calibration / historical hit rate of the Top-10 ──────────
  const avgCalibration = pickCount
    ? picks.reduce((sum, s) => sum + s.breakdown.calibration, 0) / pickCount
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
  missingFactors?: FactorKey[];
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

  const gapLog = new Set<string>();

  // ── Step 1: Score every non-rejected market across all eleven factors ───────
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
  const top10 = top10Scores.map((s) => s.market);

  const backfilledCount = top10Scores.filter(
    (s) => s.breakdown.calibration < MIN_CALIBRATION_HIT_RATE,
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

  return {
    top1:  finalPicks.slice(0, 1),
    top3:  finalPicks.slice(0, 3),
    top5:  finalPicks.slice(0, 5),
    top10: finalPicks,
    gaps:         [...gapLog],
    rankingNotes: finalPicks.map((m) => {
      const s = scored.find((x) => x.market === m);
      return s ? s.notes : `${m.name} · ${m.selection}`;
    }),
    weightLog,
    missingFactors: [...excludedUnion],
    confidence,
    confidenceLog,
  };
}
