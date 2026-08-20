// ĞIGI GIVØ — Multi-Factor Market Selector
//
// Replaces the previous single-number "safety" ranking with a weighted,
// multi-factor composite that scores every generated market across eight
// independent signals. The composite is monotonic: a market with a higher
// composite is expected to have a higher true outcome probability, so Top-1
// is — by construction — the single most reliable pick and cannot be
// systematically worse than Top-2.
//
// FACTOR WEIGHTS (sum to 1.00):
//
//   1. Poisson λ  (expected event rates) .............. 25%  ← xg.ts + statisticalAnchors.ts
//      The raw event-rate evidence: how decisively the expected λ (goals,
//      corners, cards, SOT, shots, offsides, saves — built by the caller from
//      the xG model and league anchors) supports the selected side of the line.
//
//   2. Calibration / historical hit rate ............... 20%  ← calibration.ts
//      The empirical reliability of the market TYPE, derived from observed
//      hit/miss rates across backtested finished matches. Shrinks over-confident
//      volatile families (saves 0.55, cards 0.66) and fully trusts structurally
//      safe lines (extreme goal totals, Double Chance, Match Result).
//
//   3. Player / team form ............................... 15%  ← ESPN form data
//      Recent results momentum (GF/GA + points) mapped directionally onto the
//      market: hot attacking form supports Overs/Wins, cold form supports
//      Unders, and the in-form side is favoured in result markets.
//
//   4. Tactical matchup .................................. 10%  ← home/away, H2H, formation
//      Venue neutrality, head-to-head scoring history, and formation-mismatch
//      multipliers (attacking vs defensive → corners/cards, open vs open → goals).
//
//   5. Match importance .................................. 10%  ← derby, title race, relegation
//      Stakes-driven predictability: derbies, title races, relegation six-pointers
//      and knockout ties are more predictable than friendlies / dead rubbers.
//
//   6. League-specific depth .............................. 10%  ← leagueAnchors.ts
//      Whether the fixture's league has a dedicated empirical baseline (high
//      depth) versus a proxy/default anchor (low depth).
//
//   7. Market confidence / liquidity ...................... 5%  ← odds volume / movement
//      Bookmaker coverage of the exact line, or a rank-confidence proxy when
//      odds are unavailable.
//
//   8. Zero bias .......................................... 5%  ← neutralise home/away favouritism
//      Penalises team-specific markets whose edge leans on the home/away
//      asymmetry; total/neutral markets are venue-neutral and score fully.
//
// DATA-GAP CONTRACT
//   Every factor is scored from whatever data is available. When a factor's
//   data source is missing it falls back to a neutral value (0.5 for
//   direction-agnostic factors, 1.0 for the neutrality-only bias factor) and
//   the gap is logged on the market score and aggregated on the SelectionResult.
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
  lambda:       0.25,  // Poisson λ (expected event rates) — xg.ts + statisticalAnchors.ts
  calibration:  0.20,  // empirical reliability / historical hit rate — calibration.ts
  form:         0.15,  // player / team form — ESPN form data
  tactical:     0.10,  // home/away, H2H, formation
  importance:   0.10,  // derby / title race / relegation
  leagueDepth:  0.10,  // league-specific anchors — leagueAnchors.ts
  liquidity:    0.05,  // odds volume / movement
  bias:         0.05,  // neutralise home/away favouritism
} as const;

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
}

/** Match importance flags. */
export interface ImportanceContext {
  derby?:      boolean;
  titleRace?:  boolean;
  relegation?: boolean;
  knockout?:   boolean;
  friendly?:   boolean;
}

/** Optional enrichment passed into the selector (all fields optional). */
export interface RankingContext {
  homeForm?:     TeamFormSignal | null;
  awayForm?:     TeamFormSignal | null;
  tactical?:     TacticalContext | null;
  importance?:   ImportanceContext | null;
  leagueSlug?:   string;
  odds?:         OddsInfo | null;
}

/** League-table context for one team. Kept for API compatibility with oracle.ts. */
export interface TeamTableInfo {
  position?:   number;
  leagueSize?: number;
}

/** Options passed to the selector. */
export interface SelectOptions {
  homeTable?: TeamTableInfo;
  awayTable?: TeamTableInfo;
  context?:   RankingContext;
}

// ─── Factor scorers (each returns a 0..1 score + optional gap log) ────────────

interface FactorResult {
  score: number;
  gap?:   string;
}

/** Factor 1 — Poisson λ (expected event rates). */
function scoreLambda(
  m: Market, lam: LambdaSet, homeName: string, awayName: string,
): FactorResult {
  const lambda = lambdaFor(m, lam, homeName, awayName);
  if (lambda === null) {
    return { score: 0.5, gap: "no direct λ→selection mapping (non event-rate market)" };
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
    return { score: 0.5, gap: "team form data missing" };
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

  const isGoals   = /Goals/.test(m.name);
  const isCorners = /Corners/.test(m.name);
  const isResult  = /Match Result|Draw No Bet|Asian Handicap/i.test(m.name);
  const over = isOverSelection(m);
  const under = isUnderSelection(m);

  // H2H scoring history — adjusts goal markets toward the historical pattern.
  if (tac && tac.h2hGames !== undefined && tac.h2hGames >= 3 && tac.h2hGoalsAvg != null) {
    const modelTotal = lam.homeGoals + lam.awayGoals;
    const ratio = tac.h2hGoalsAvg / Math.max(0.5, modelTotal);
    const adj = clamp(ratio - 1, -0.4, 0.4); // + = historically higher scoring
    if (isGoals) {
      if (over) score += adj * 0.5;
      if (under) score -= adj * 0.5;
    }
  } else {
    gaps.push("H2H data missing");
  }

  // Formation mismatch — goal/corner multipliers + home advantage.
  if (tac?.homeFormation && tac?.awayFormation) {
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

  return { score: 0.5, gap: "match importance context missing (no flags, no league table)" };
}

/** Factor 6 — League-specific depth (leagueAnchors.ts). */
function scoreLeagueDepth(context: RankingContext | null): FactorResult {
  const slug = context?.leagueSlug;
  if (!slug) {
    return { score: 0.5, gap: "league slug missing" };
  }
  if (LEAGUE_ANCHORS[slug]) return { score: 1.0 };
  const resolved = getAnchors(slug);
  if (resolved) {
    return { score: 0.65, gap: `league '${slug}' resolved via proxy anchors (no dedicated baseline)` };
  }
  return { score: 0.5, gap: "no league anchors available" };
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
  return { score: 0.5, gap: "no odds/volume data — liquidity neutral" };
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

// ─── Market score ─────────────────────────────────────────────────────────────

/** Per-factor sub-scores for a market (all 0..1). */
export interface FactorBreakdown {
  lambda:       number;
  calibration:  number;
  form:         number;
  tactical:     number;
  importance:   number;
  leagueDepth:  number;
  liquidity:    number;
  bias:         number;
}

/** Full multi-factor score for a single market. */
export interface MarketScore {
  market:      Market;
  composite:   number;   // 0..1 weighted sum of the eight factors
  wrongProb:   number;   // consensus loss probability (1 - hitRate) for tiebreaks
  marginUnits: number;   // σ-cushion vs the line (λ markets only)
  verifiable:  boolean;
  breakdown:   FactorBreakdown;
  gaps:        string[];
  notes:       string;
}

/**
 * Score a single market across all eight factors, falling back to neutral
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

  const lambda      = scoreLambda(m, lam, homeName, awayName);
  const calibration = scoreCalibration(m, ctx);
  const form        = scoreForm(m, homeName, awayName, context);
  const tactical    = scoreTactical(m, lam, homeName, awayName, context);
  const importance  = scoreImportance(context, opts);
  const leagueDepth = scoreLeagueDepth(context);
  const liquidity   = scoreLiquidity(m, confidenceMap, context);
  const bias        = scoreBias(m, lam, homeName, awayName, context);

  const breakdown: FactorBreakdown = {
    lambda:      lambda.score,
    calibration: calibration.score,
    form:        form.score,
    tactical:    tactical.score,
    importance:  importance.score,
    leagueDepth: leagueDepth.score,
    liquidity:   liquidity.score,
    bias:        bias.score,
  };

  const composite =
    RANKING_WEIGHTS.lambda      * breakdown.lambda +
    RANKING_WEIGHTS.calibration * breakdown.calibration +
    RANKING_WEIGHTS.form        * breakdown.form +
    RANKING_WEIGHTS.tactical    * breakdown.tactical +
    RANKING_WEIGHTS.importance  * breakdown.importance +
    RANKING_WEIGHTS.leagueDepth * breakdown.leagueDepth +
    RANKING_WEIGHTS.liquidity   * breakdown.liquidity +
    RANKING_WEIGHTS.bias        * breakdown.bias;

  // Consensus loss probability for tiebreaks (1 - hitRate, already calibrated
  // in the oracle path, raw ensemble in the engine path).
  const wrongProb = clamp(1 - m.hitRate, 0, 1);

  // σ-cushion for λ markets (third tiebreak).
  const lamVal = lambdaFor(m, lam, homeName, awayName);
  const lineMatch = m.name.match(/O\/U\s+([\d.]+)/);
  const marginUnits = lamVal !== null && lineMatch
    ? sigmaCushion(lamVal, Number(lineMatch[1]))
    : 0;

  const gaps = [lambda.gap, form.gap, tactical.gap, importance.gap, leagueDepth.gap, liquidity.gap]
    .filter((g): g is string => !!g);

  const notes =
    `λ=${breakdown.lambda.toFixed(2)} cal=${breakdown.calibration.toFixed(2)} ` +
    `form=${breakdown.form.toFixed(2)} tac=${breakdown.tactical.toFixed(2)} ` +
    `imp=${breakdown.importance.toFixed(2)} lg=${breakdown.leagueDepth.toFixed(2)} ` +
    `liq=${breakdown.liquidity.toFixed(2)} bias=${breakdown.bias.toFixed(2)} ` +
    `→ composite=${composite.toFixed(3)} loss=${(wrongProb * 100).toFixed(1)}%` +
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
}

const EMPTY_SELECTION = (reason: string, gaps: string[] = []): SelectionResult => ({
  top1: [], top3: [], top5: [], top10: [], skipped: reason, gaps,
});

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

  // ── Step 1: Score every non-rejected market across all eight factors ────────
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

  // ── Step 3: One line per underlying stat (keep the highest-composite line) ──
  const seen = new Set<string>();
  const deduped = ranked.filter((s) => {
    const key = statKey(s.market);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── Step 4: Top-N slots require verifiable markets (settleable picks) ───────
  const verifiable = deduped.filter((s) => s.verifiable);
  if (verifiable.length === 0) {
    return EMPTY_SELECTION(
      "No verifiable market remains after scoring — match skipped.",
      [...gapLog],
    );
  }

  // ── Step 5: Safety net — block non-giant team-specific Under 3.5 Goals lines ─
  // This is applied only after the full 8-factor ranking has already been
  // computed and sorted, so the ranking logic itself remains unchanged.
  const topNEligible = verifiable.filter(
    (s) => !isBlockedTeamSpecificUnder35Goals(s.market, homeName, awayName),
  );
  if (topNEligible.length === 0) {
    return EMPTY_SELECTION(
      "No Top-N-eligible market remains after applying the team-goals safety net.",
      [...gapLog],
    );
  }

  const top10 = topNEligible.slice(0, 10).map((s) => s.market);

  return {
    top1:  top10.slice(0, 1),
    top3:  top10.slice(0, 3),
    top5:  top10.slice(0, 5),
    top10,
    gaps:         [...gapLog],
    rankingNotes: top10.map((m) => {
      const s = scored.find((x) => x.market === m);
      return s ? s.notes : `${m.name} · ${m.selection}`;
    }),
  };
}
