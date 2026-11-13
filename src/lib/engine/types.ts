import type { CorrectScoreGrid } from "./markets";

// ĞIGI GIVØ — Shared types

// ─── Primitive aliases ────────────────────────────────────────────────────────

export type Grade = "A" | "B" | "C" | "D";

/** Letter-grade alias used by UI badge components */
export type MarketGrade = Grade;

/** Pick outcome for post-match verification */
export type PickOutcome = "HIT" | "MISS" | "PENDING";

// ─── Prediction input ─────────────────────────────────────────────────────────

export interface PredictInput {
  auto:   boolean;
  match:  string;  // "TEAM vs TEAM"
  league: string;
  date:   string;  // YYYY-MM-DD
}

// ─── Locked match object ──────────────────────────────────────────────────────

export interface LockedMatchObject {
  homeTeam:              string;
  awayTeam:              string;
  venue:                 string;
  venueType:             "HOME" | "NEUTRAL";
  date:                  string;
  timeUtc:               string;
  tournamentStage:       string;
  refereeName:           string;
  weatherForecast:       string;
  keyInjuryFlags:        string[];
  dataCompletenessScore: number;  // 0..100
  fallbackMode:          boolean;
}

// ─── Market explanation (3-part rationale) ────────────────────────────────────

export interface PickExplanation {
  /** E.g. "Passed Poisson validation, DI 2.1% < 5%, MQS 9.4/10, Wilson CI [96.2%–99.1%]" */
  whyQualified:        string;
  /** E.g. "Arsenal xG 2.45 vs Coventry GA 1.67/90 yields λ=2.45 home goals expectation." */
  whySelectedForMatch: string;
  /** E.g. "In 98.4% of Poisson scenarios for λ=2.45, Arsenal scores at least 1 goal." */
  whyOutcomePossible:  string;
}

/** @alias for PickExplanation — kept for backward compatibility */
export type MarketExplanation = PickExplanation;

// ─── Market ───────────────────────────────────────────────────────────────────

export interface Market {
  id:                string;
  name:              string;
  family:            string;
  selection:         string;
  hitRate:           number;
  ciLower:           number;
  ciUpper:           number;
  ciWidth:           number;
  // Odds — both old and new fields kept so all callers work
  fairOddsBest:      number;   // 1 / ciUpper (best-case odds)
  fairOddsWorst:     number;   // 1 / ciLower (worst-case odds)
  fairOdds?:         number;   // 1 / hitRate (legacy point estimate)
  marketOdds?:       number;   // bookmaker odds if available
  valueEdge?:        number;   // oracle prob − book implied prob
  kelly?:            number;   // fractional Kelly stake
  mqs:               number;   // market quality score 0..10
  grade:             Grade;
  confidence:        "HIGH" | "MEDIUM" | "LOW";
  disagreementIndex: number;
  rejected:          boolean;
  rejectReason?:     string;
  niche:             boolean;
  reason?:           string;          // summary rationale
  explanation?:      PickExplanation; // 3-part deep rationale
  outcome?:          PickOutcome;
  /**
   * NEW (additive) — 12-factor ranking breakdown for Top-10 picks: factor
   * display label → 0..1 score, containing only the factors whose real data
   * was available. Absent on picks that were never ranked (e.g. registry).
   */
  factors?:          Record<string, number>;
  /** NEW (additive) — weighted 0..1 composite of the available factors. */
  compositeScore?:   number;
}

/** @alias kept for backward compatibility */
export type MarketPick = Market;

/** Single top pick as surfaced to the UI / accumulator engine */
export interface EnginePick {
  name:        string;
  selection:   string;
  hitRate:     number;
  fairOdds:    number;
  valueEdge:   number;
  reason:      string;
  family:      string;
  confidence:  "HIGH" | "MEDIUM" | "LOW";
  outcome?:    PickOutcome;
}

// ─── Agent signal ─────────────────────────────────────────────────────────────

export interface AgentSignal {
  name:        string;
  weight:      number;
  description: string;
}

// ─── Match context ────────────────────────────────────────────────────────────

export interface MatchContextInsight {
  tactics:        string;
  importance:     string;
  playerMatchups: string;
  biasStatement:  string;
}

/** @alias kept for backward compatibility */
export type MatchContext = MatchContextInsight;

// ─── Team form stats ──────────────────────────────────────────────────────────

export interface FormGame {
  result:      "W" | "D" | "L";
  opponent:    string;
  scoreFor:    number;
  scoreAgainst: number;
  atVs:        string;
  date?:       string;
}

export interface TeamFormStats {
  teamId:   string;
  teamName: string;
  games:    FormGame[];
  gfAvg:    number;
  gaAvg:    number;
  points:   number;
}

// ─── Standings entry ──────────────────────────────────────────────────────────

export interface StandingsEntry {
  rank:           number;
  team:           string;
  teamLogo:       string | null;
  played:         number;
  won:            number;
  drawn:          number;
  lost:           number;
  goalsFor:       number;
  goalsAgainst:   number;
  goalDifference: number;
  points:         number;
  form:           string;
}

// ─── Odds info ────────────────────────────────────────────────────────────────

/** Re-exported from espn.ts for convenience — single source of truth */
export type { OddsInfo } from "../espn";

// ─── Engine context ───────────────────────────────────────────────────────────

/** Runtime context injected into the oracle during a single prediction run */
export interface EngineContext {
  leagueSlug:    string;
  leagueName:    string;
  matchDate:     string;
  venueType:     "HOME" | "NEUTRAL";
  neutralSite:   boolean;
  isFriendly:    boolean;
  isKnockout:    boolean;
  completeness:  number;   // 0..100
}

// ─── Predict result ───────────────────────────────────────────────────────────

/** Lightweight result returned by quick-predict endpoints */
export interface PredictResult {
  match:         string;
  league:        string;
  date:          string;
  homeTeam:      string;
  awayTeam:      string;
  top1:          EnginePick | null;
  top3:          EnginePick[];
  top10:         EnginePick[];
  totalMarkets:  number;
  completeness:  number;
  generatedAt:   string;
}

// ─── Deep stats vector ────────────────────────────────────────────────────────

export interface DeepStatsVector {
  homeXg:             number;
  awayXg:             number;
  matchContext?:      MatchContextInsight;
  homeGfAvg:          number;
  homeGaAvg:          number;
  awayGfAvg:          number;
  awayGaAvg:          number;
  homeSotAvg:         number;
  awaySotAvg:         number;
  homeCornersAvg:     number;
  awayCornersAvg:     number;
  homeCardsAvg:       number;
  awayCardsAvg:       number;
  homeFoulsAvg:       number;
  awayFoulsAvg:       number;
  homePossessionPct:  number;
  awayPossessionPct:  number;
  marketHomeProb:     number | null;
  marketDrawProb:     number | null;
  marketAwayProb:     number | null;
  sources:            Array<{ name: string; trust: number; coverage: string }>;
}

/** @deprecated — DataSource now inlined in DeepStatsVector.sources */
export interface DataSource { name: string; trust: number; coverage: string; }

// ─── Full engine result ───────────────────────────────────────────────────────

export interface EngineResult {
  match:             LockedMatchObject;
  input:             PredictInput;
  lambdas:           Record<string, number>;
  /**
   * Dixon–Coles corrected 1X2 + Correct Score grid the score-dependent
   * markets were priced from (see `buildCorrectScoreGrid`). Optional for
   * back-compat with stored results produced before the correction landed.
   */
  scoreGrid?:        CorrectScoreGrid;
  deepStats?:        DeepStatsVector;
  agents:            AgentSignal[];
  markets:           Market[];
  top1:              Market[];
  top3:              Market[];
  top5:              Market[];
  top10:             Market[];
  safeMode:          Market[];
  ultraSafe:         Market[];
  rejected:          Market[];
  familyCounts:      Record<string, number>;
  totalMarkets:      number;
  qualifiedMarkets:  number;
  calibrationNotes:  string[];
  generatedAt:       string;
  hitCount?:         number;
  evaluatedCount?:   number;
}

/** @deprecated */
export interface VerificationResult {
  pick:    Market;
  outcome: PickOutcome;
  reason?: string;
}
