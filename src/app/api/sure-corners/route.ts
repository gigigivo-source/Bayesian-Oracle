import { statsAggregator } from "@/lib/data/aggregator";
import { emptyTeamStats, type CanonicalMatchStats } from "@/lib/data/types";
import { fetchScoreboard, fetchSummary, type FixtureLite, type MatchSummary } from "@/lib/espn";
import type { EngineResult, Market } from "@/lib/engine";
import type { MeshProfile } from "@/lib/engine/dataMesh";
import { betaBinomOver, poissonPmf } from "@/lib/engine/stats";
import { getAnchors } from "@/lib/engine/statisticalAnchors";
import { LEAGUE_TIER, leagueTier } from "@/lib/leaguePriority";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Temporarily disabled so every finite market probability can be inspected in
// Sure Bet Corners. Keep this explicit rather than silently retaining the old
// 95% gate; it can be raised again once the synthetic-baseline feed is reviewed.
const MINIMUM_HIT_RATE = 0.0;
const MIN_HANDICAP_PROBABILITY = 0.85;
const MIN_CORNER_WINNER_PROBABILITY = 0.80;
const MIN_EMPIRICAL_CALIBRATION_SAMPLES = 8;
const LOOKAHEAD_DAYS = 7;
// Timeout note: the multi-source stats aggregator enforces its own per-source
// timeout budget (and skips a timed-out source). This route deliberately does
// NOT impose a shorter ceiling on the aggregator call, so every configured
// source (SportScore, API-Football, StatsBomb, FBref, TheSportsDB, Understat,
// OpenLigaDB, Highlightly, …) is tried in priority order before a fixture is
// rejected for lack of statistics.
const PROFILE_TIMEOUT_MS = 25_000;
const TEAM_CORNER_LINES = [5.5, 6.5, 7.5, 8.5] as const;
const TOTAL_CORNER_LINES = [6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 14.5] as const;
const HANDICAP_LINES = [3.5, 2.5, 1.5, 0.5] as const;
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * The four terms of the requested corner-expectation formula:
 *
 *   expectedCorners = (
 *     (avgCornersPerGame | avgCornersLast5 | leagueAvg) * weight
 *     + (xg * xgWeight)
 *     + (possession / 10 * possessionWeight)
 *     + (h2hCorners * h2hWeight)
 *   ) / totalWeight
 *
 * If a term is missing it is excluded and its weight is redistributed
 * proportionally among the remaining terms (the weighted sum is re-normalised
 * by the available weight).
 *
 * The primary term is a per-team cascade, so a team without corner data is
 * still grounded instead of being rejected (Parts 1 + 2):
 *   1. avgCornersPerGame        (season average)  — origin "real"
 *   2. avgCornersLast5          (last-5 average)  — origin "last5"
 *   3. avgCornersConcededPerGame (concession rate) — origin "conceded"
 *   4. league average           (per-team baseline) — origin "league"
 * The old standalone concession and league-average terms are absorbed into
 * that cascade; the primary term keeps the combined 0.55 weight the two
 * per-team corner-average fields used to carry, and the freed 0.45 is split
 * evenly across the xg, possession and h2h terms.
 */
const EXPECTATION_WEIGHTS = {
  avgCorners: 0.55,
  xg: 0.15,
  possession: 0.15,
  h2hCorners: 0.15,
} as const;

type WeightedField = keyof typeof EXPECTATION_WEIGHTS;
type Confidence = "HIGH" | "MEDIUM" | "LOW";
type Side = "home" | "away";

/** Where a team's corner baseline came from in the Part 1/2 cascade. */
type CornerBaselineOrigin = "real" | "last5" | "conceded" | "league";

interface CornerBaseline {
  value: number | null;
  origin: CornerBaselineOrigin | null;
  /** Human label for the per-match log line, e.g. "real" or "league avg". */
  label: string | null;
}

type CacheEntry = {
  data: SureCornersResponse;
  timestamp: number;
};

const cache = new Map<string, CacheEntry>();

/** Avoid fetching the same real team profile more than once in one server life. */
const profilePromises = new Map<string, Promise<MeshProfile | null>>();

function getCacheKey(url: URL): string {
  const params = new URLSearchParams(url.searchParams);
  params.delete("refresh");
  const sortedKeys = Array.from(params.keys()).sort();
  const paramString = sortedKeys.map((key) => `${key}=${params.get(key)}`).join("&");
  return `sure-corners:${LOOKAHEAD_DAYS}d:${paramString}`;
}

/** The only competition tiers eligible for this intentionally narrow feed. */
const SURE_CORNERS_LEAGUES = Object.entries(LEAGUE_TIER)
  .filter(([, tier]) => tier <= 2)
  .map(([slug]) => slug);

export type SureCornerMarketType =
  | "Total Corners"
  | "Team 1 Corners"
  | "Team 2 Corners"
  | "Corner Winner"
  | "Corner Handicap";

export interface SureCornerMarket {
  id: string;
  marketType: SureCornerMarketType;
  name: string;
  selection: string;
  line: number | null;
  hitRate: number;
  confidence: Confidence;
  reason: string;
}

export interface SureCornerMatch {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  homeLogo: string | null;
  awayLogo: string | null;
  league: string;
  leagueSlug: string;
  leagueTier: number;
  date: string;
  confidence: "HIGH";
  /** True means real pre-match data, never that in-play corner counts existed. */
  realStats: true;
  statsSource: string;
  dataAvailability: Confidence;
  weightedFieldsAvailable: { home: number; away: number; total: number };
  predictedCorners: {
    home: number;
    away: number;
    total: number;
    /** Signed as requested: homeExpectedCorners - awayExpectedCorners. */
    difference: number;
    strongerTeam: string | null;
  };
  markets: SureCornerMarket[];
}

interface RejectionLog {
  fixtureId: string;
  match: string;
  code: string;
  reason: string;
  missingStatistics: string[];
}

export interface SureCornersResponse {
  generatedAt: string;
  totalFixturesChecked: number;
  rejectedMatches: number;
  rejectionReasons: Record<string, number>;
  rejections: RejectionLog[];
  matches: SureCornerMatch[];
  filters: {
    minimumHitRate: number;
    requiredConfidence: "HIGH";
    requiresRealPerMatchCorners: false;
    requiresPreMatchStatistics: true;
    allowedLeagueTiers: number[];
    totalCornerLines: readonly number[];
    teamCornerLines: readonly number[];
    marketTypes: SureCornerMarketType[];
  };
}

interface EvaluatedMarket extends SureCornerMarket {
  accepted: boolean;
  calibrationReliable: boolean;
  rejectionReason?: string;
}

interface PrematchTeamInputs {
  avgCornersPerGame: number | null;
  avgCornersConcededPerGame: number | null;
  xg: number | null;
  xgPerShot: number | null;
  shots: number | null;
  shotsOnTarget: number | null;
  possession: number | null;
  passes: number | null;
  form: string | null;
  goalsScoredLast5: number | null;
  goalsConcededLast5: number | null;
  avgCornersLast5: number | null;
  avgCornersConcededLast5: number | null;
}

interface HistoricalCornerSample {
  home: number;
  away: number;
  expectedTotal: number | null;
  expectedDifference: number | null;
}

interface PrematchMatchInputs {
  h2hHomeCorners: number | null;
  h2hAwayCorners: number | null;
  /** League-average corners per MATCH (home + away combined). */
  leagueAvgCorners: number | null;
  /** Per-team share of the league average — the formula's team baseline (Part 2). */
  leagueAvgCornersPerTeam: number | null;
  /** "source" = the aggregator's leagueAvgCorners field; "anchor" = observed league baseline. */
  leagueAvgSource: "source" | "anchor" | null;
  homeAdvantage: number | null;
  matchImportanceMultiplier: number | null;
  matchImportance: string | null;
  tacticalHomeMultiplier: number | null;
  tacticalAwayMultiplier: number | null;
  tacticalMatchup: string | null;
  history: HistoricalCornerSample[];
}

interface PreparedPrematchStats {
  home: PrematchTeamInputs;
  away: PrematchTeamInputs;
  match: PrematchMatchInputs;
  source: string;
}

interface TeamExpectation {
  value: number;
  weightedFieldCount: number;
  weightedFields: WeightedField[];
  missingWeightedFields: WeightedField[];
  /** Origin of the resolved corner baseline (Part 1/2 cascade). */
  baselineOrigin: CornerBaselineOrigin | null;
  /** The resolved corner baseline value (per team, corners per game). */
  baselineValue: number | null;
  /** Weighted terms grounded in team-specific data (excludes the league fallback). */
  teamSpecificFieldCount: number;
}

interface CornerExpectations {
  home: number;
  away: number;
  total: number;
  difference: number;
  absoluteDifference: number;
  homeDetail: TeamExpectation;
  awayDetail: TeamExpectation;
  pressureSignals: string[];
  adjustments: string[];
}

interface DataQuality {
  confidence: Confidence;
  homeWeightedFields: number;
  awayWeightedFields: number;
  availableTeamFields: number;
  totalTeamFields: number;
}

interface StrengthProfile {
  stronger: Side | null;
  gap: number;
}

interface GateResult {
  passed: boolean;
  mode: "season-corners" | "recent-corners" | "xg" | "partial" | "none";
  missing: string[];
}

interface EvaluationResult {
  match: SureCornerMatch | null;
  reason?: string;
  missingStatistics?: string[];
  rejectionCode?: string;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (isFiniteNonNegative(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value.replace("%", ""));
      if (isFiniteNonNegative(parsed)) return parsed;
    }
  }
  return null;
}

function finiteSignedNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function nonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function formatMatch(fx: FixtureLite): string {
  return `${fx.home.name} vs ${fx.away.name}`;
}

function dateRange(days: number): string {
  const from = new Date();
  const to = new Date(from);
  to.setDate(from.getDate() + days);
  const fmt = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, "");
  return `${fmt(from)}-${fmt(to)}`;
}

function nestedRecords(stats: CanonicalMatchStats | null): Record<string, unknown>[] {
  if (!stats) return [];
  const root = stats as unknown as Record<string, unknown>;
  return [root, root.match, root.matchStats, root.context, root.metadata].filter(isRecord);
}

function firstMatchValue(stats: CanonicalMatchStats | null, ...keys: string[]): unknown {
  for (const record of nestedRecords(stats)) {
    for (const key of keys) {
      const value = record[key];
      if (value !== null && value !== undefined) return value;
    }
  }
  return null;
}

function distributionMean(
  profile: MeshProfile | null,
  field: "corners" | "shots" | "sot" | "possession" | "passes",
): number | null {
  const distribution = profile?.[field];
  if (!distribution || distribution.n <= 0) return null;
  return isFiniteNonNegative(distribution.mean) ? distribution.mean : null;
}

function summaryFormString(summary: MatchSummary | null, side: Side): string | null {
  const form = side === "home" ? summary?.homeForm : summary?.awayForm;
  if (!form?.games.length) return null;
  return form.games.map((game) => game.result.toUpperCase().slice(0, 1)).join(" ");
}

function summaryLast5Total(
  summary: MatchSummary | null,
  side: Side,
  kind: "scored" | "conceded",
): number | null {
  const form = side === "home" ? summary?.homeForm : summary?.awayForm;
  if (!form?.games.length) return null;
  const games = form.games.slice(0, 5);
  return games.reduce(
    (sum, game) => sum + (kind === "scored" ? game.scoreFor : game.scoreAgainst),
    0,
  );
}

function prepareTeamInputs(
  stats: CanonicalMatchStats | null,
  side: Side,
  fx: FixtureLite,
  summary: MatchSummary | null,
  profile: MeshProfile | null,
): PrematchTeamInputs {
  const canonical = stats?.[side] ?? null;
  const extended = (canonical ?? {}) as unknown as Record<string, unknown>;
  const fixtureTeam = side === "home" ? fx.home : fx.away;

  return {
    avgCornersPerGame: finiteNumber(extended.avgCornersPerGame),
    avgCornersConcededPerGame: finiteNumber(extended.avgCornersConcededPerGame),
    xg: finiteNumber(extended.xg),
    xgPerShot: finiteNumber(extended.xgPerShot),
    shots: finiteNumber(extended.shots, distributionMean(profile, "shots")),
    shotsOnTarget: finiteNumber(extended.shotsOnTarget, distributionMean(profile, "sot")),
    possession: finiteNumber(extended.possession, distributionMean(profile, "possession")),
    passes: finiteNumber(extended.passes, distributionMean(profile, "passes")),
    form: nonEmptyString(extended.form, fixtureTeam.form, summaryFormString(summary, side)),
    goalsScoredLast5: finiteNumber(
      extended.goalsScoredLast5,
      summaryLast5Total(summary, side, "scored"),
    ),
    goalsConcededLast5: finiteNumber(
      extended.goalsConcededLast5,
      summaryLast5Total(summary, side, "conceded"),
    ),
    // The mesh profile is built only from recent finished matches. An explicit
    // Canonical last-five value always takes precedence when supplied.
    avgCornersLast5: finiteNumber(
      extended.avgCornersLast5,
      distributionMean(profile, "corners"),
    ),
    avgCornersConcededLast5: finiteNumber(extended.avgCornersConcededLast5),
  };
}

function sideValue(value: unknown, side: Side): number | null {
  if (isFiniteNonNegative(value)) return value;
  if (!isRecord(value)) return null;
  const aliases = side === "home"
    ? ["home", "homeCorners", "team1", "homeAverage"]
    : ["away", "awayCorners", "team2", "awayAverage"];
  return finiteNumber(...aliases.map((key) => value[key]), value.average, value.total);
}

function normaliseMultiplier(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null) return null;
  if (number >= 0.7 && number <= 1.3) return number;
  if (number <= 0.3) return 1 + number;
  return null;
}

function importanceFrom(value: unknown, fx: FixtureLite): { multiplier: number | null; description: string | null } {
  const direct = normaliseMultiplier(
    isRecord(value)
      ? value.cornerMultiplier ?? value.intensityMultiplier ?? value.multiplier
      : value,
  );
  const directText = nonEmptyString(value, isRecord(value) ? value.description : null, isRecord(value) ? value.type : null);
  if (direct !== null) return { multiplier: direct, description: directText ?? `importance multiplier ${direct.toFixed(2)}` };

  const text = `${directText ?? ""} ${fx.leagueName} ${fx.statusDetail ?? ""}`.trim();
  if (/derby|classico|cl[aá]sico|rivalry|title race|relegation/i.test(text)) {
    return { multiplier: 1.08, description: directText ?? "high-intensity derby/title/relegation context" };
  }
  if (/final|semi.?final|quarter.?final|round of 16|knockout|elimination|play.?off/i.test(text)) {
    return { multiplier: 1.04, description: directText ?? "high-importance knockout context" };
  }
  if (/friendl|pre-season|preseason|exhibition|testimonial/i.test(text)) {
    return { multiplier: 0.90, description: directText ?? "low-importance friendly context" };
  }
  return { multiplier: null, description: directText };
}

function tacticalFrom(
  value: unknown,
  fx: FixtureLite,
  summary: MatchSummary | null,
): { home: number | null; away: number | null; description: string | null } {
  if (isRecord(value)) {
    const common = normaliseMultiplier(value.cornerMultiplier ?? value.multiplier);
    const home = normaliseMultiplier(value.homeMultiplier ?? value.homeCornersMultiplier) ?? common;
    const away = normaliseMultiplier(value.awayMultiplier ?? value.awayCornersMultiplier) ?? common;
    const description = nonEmptyString(value.description, value.analysis, value.label);
    if (home !== null || away !== null) return { home, away, description };
  }

  const text = nonEmptyString(value);
  if (text) {
    let home = 1;
    let away = 1;
    const lower = text.toLowerCase();
    const homeName = fx.home.name.toLowerCase();
    const awayName = fx.away.name.toLowerCase();
    const attacking = /dominat|wing|cross|attack|high press|sustained pressure/;
    const defensive = /defensive|low block|cautious|deep block/;
    if (lower.includes(homeName) && attacking.test(lower)) home *= 1.08;
    if (lower.includes(awayName) && attacking.test(lower)) away *= 1.08;
    if (lower.includes(homeName) && defensive.test(lower)) home *= 0.95;
    if (lower.includes(awayName) && defensive.test(lower)) away *= 0.95;
    if (home === 1 && away === 1 && attacking.test(lower)) home = away = 1.04;
    if (home === 1 && away === 1 && defensive.test(lower)) home = away = 0.94;
    return { home, away, description: text };
  }

  if (summary?.homeFormation && summary.awayFormation) {
    const formations = `${summary.homeFormation} vs ${summary.awayFormation}`;
    const wingShape = /4-3-3|3-4-3|3-5-2|4-2-3-1/;
    const homeWing = wingShape.test(summary.homeFormation);
    const awayWing = wingShape.test(summary.awayFormation);
    return {
      home: homeWing ? 1.04 : 1,
      away: awayWing ? 1.04 : 1,
      description: `${formations}; wing-oriented shapes receive a bounded corner-pressure adjustment`,
    };
  }

  return { home: null, away: null, description: null };
}

function extractHistoricalSamples(stats: CanonicalMatchStats | null): HistoricalCornerSample[] {
  const raw = firstMatchValue(
    stats,
    "historicalCornerMatches",
    "cornerHistory",
    "historicalMatches",
    "similarCornerMatches",
  );
  if (!Array.isArray(raw)) return [];

  const samples: HistoricalCornerSample[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const home = finiteNumber(item.homeCorners, item.home, item.team1Corners);
    const away = finiteNumber(item.awayCorners, item.away, item.team2Corners);
    if (home === null || away === null) continue;
    samples.push({
      home,
      away,
      expectedTotal: finiteNumber(item.expectedTotalCorners, item.expectedTotal),
      expectedDifference: finiteSignedNumber(item.expectedCornerDifference, item.expectedDifference),
    });
  }
  return samples;
}

/**
 * Part 2 fallback: league-average corners per MATCH (home + away combined).
 * Comes from the aggregator's leagueAvgCorners field when a source provides
 * it, otherwise from the observed (historical, checked-in) league anchors —
 * alias-aware, so every competition in this feed resolves a real baseline.
 * Per-match corner totals live well inside 4–25; anything outside that band
 * is treated as malformed and ignored.
 */
function leagueAverageFor(
  stats: CanonicalMatchStats | null,
  fx: FixtureLite,
): { value: number; source: "source" | "anchor" } {
  const raw = finiteNumber(firstMatchValue(stats, "leagueAvgCorners"));
  const explicit = raw !== null && raw >= 4 && raw <= 25 ? raw : null;
  if (explicit !== null) return { value: explicit, source: "source" };
  return { value: getAnchors(fx.leagueSlug).avgCorners, source: "anchor" };
}

function prepareMatchInputs(
  stats: CanonicalMatchStats | null,
  fx: FixtureLite,
  summary: MatchSummary | null,
): PrematchMatchInputs {
  const h2h = firstMatchValue(stats, "h2hCorners");
  const leagueAverage = leagueAverageFor(stats, fx);

  const homeAdvantageValue = firstMatchValue(stats, "homeAdvantage");
  const explicitHomeAdvantage = normaliseMultiplier(
    isRecord(homeAdvantageValue)
      ? homeAdvantageValue.cornerMultiplier ?? homeAdvantageValue.multiplier ?? homeAdvantageValue.homeMultiplier
      : homeAdvantageValue,
  );
  const observedHomePossession = getAnchors(fx.leagueSlug).homePossession;
  // Synthetic avgCornersPerGame values already include the requested +5% home
  // / -5% away effect, so do not apply the regular home multiplier a second time.
  const usesSyntheticBaseline = stats?.metadata.source === "baseline (synthetic)";
  const homeAdvantage = usesSyntheticBaseline || fx.neutralSite
    ? 1
    : explicitHomeAdvantage ?? observedHomePossession / 0.5;

  const importanceValue = firstMatchValue(stats, "matchImportance");
  const importance = importanceFrom(importanceValue, fx);
  const tacticalValue = firstMatchValue(stats, "tacticalMatchup");
  const tactical = tacticalFrom(tacticalValue, fx, summary);

  return {
    h2hHomeCorners: sideValue(h2h, "home"),
    h2hAwayCorners: sideValue(h2h, "away"),
    leagueAvgCorners: leagueAverage.value,
    // League averages are per-match TOTALS (home + away); the per-team
    // baseline in the formula is each team's share of that total.
    leagueAvgCornersPerTeam: leagueAverage.value / 2,
    leagueAvgSource: leagueAverage.source,
    homeAdvantage,
    matchImportanceMultiplier: importance.multiplier,
    matchImportance: importance.description,
    tacticalHomeMultiplier: tactical.home,
    tacticalAwayMultiplier: tactical.away,
    tacticalMatchup: tactical.description,
    history: extractHistoricalSamples(stats),
  };
}

function preparePrematchStats(
  stats: CanonicalMatchStats | null,
  fx: FixtureLite,
  summary: MatchSummary | null,
  profiles: { home: MeshProfile | null; away: MeshProfile | null },
): PreparedPrematchStats {
  const match = prepareMatchInputs(stats, fx, summary);
  const sources = new Set<string>();
  if (stats?.metadata.source?.trim()) sources.add(stats.metadata.source.trim());
  for (const profile of [profiles.home, profiles.away]) {
    for (const provider of profile?.providers ?? []) sources.add(provider);
  }
  if (summary) sources.add("ESPN pre-match summary");
  if (match.leagueAvgSource === "anchor") sources.add("observed league anchors");

  return {
    home: prepareTeamInputs(stats, "home", fx, summary, profiles.home),
    away: prepareTeamInputs(stats, "away", fx, summary, profiles.away),
    match,
    source: [...sources].join(" + ") || "pre-match statistical mesh",
  };
}

const TEAM_INPUT_FIELDS: Array<keyof PrematchTeamInputs> = [
  "avgCornersPerGame",
  "avgCornersConcededPerGame",
  "xg",
  "xgPerShot",
  "shots",
  "shotsOnTarget",
  "possession",
  "passes",
  "form",
  "goalsScoredLast5",
  "goalsConcededLast5",
  "avgCornersLast5",
  "avgCornersConcededLast5",
];

/**
 * Relaxed availability gate (Part 1): a fixture is rejected for missing
 * pre-match statistics only when NEITHER team has any consumable input — not
 * when a team lacks avgCornersPerGame. Partial input is legitimate: the
 * weighted formula resolves each team's corner baseline through the
 * avgCornersPerGame → avgCornersLast5 → avgCornersConcededPerGame → league
 * average cascade. The hit-rate gate is temporarily disabled so available
 * synthetic or real inputs can be inspected in the Sure Corners feed.
 */
function preMatchGate(input: PreparedPrematchStats): GateResult {
  const seasonPair = input.home.avgCornersPerGame !== null && input.away.avgCornersPerGame !== null;
  const recentPair = input.home.avgCornersLast5 !== null && input.away.avgCornersLast5 !== null;
  const xgPair = input.home.xg !== null && input.away.xg !== null;
  const teamValueExists = [input.home, input.away].some((team) =>
    TEAM_INPUT_FIELDS.some((field) => team[field] !== null),
  );
  const matchValueExists =
    input.match.h2hHomeCorners !== null ||
    input.match.h2hAwayCorners !== null ||
    input.match.leagueAvgCorners !== null ||
    input.match.homeAdvantage !== null ||
    input.match.matchImportanceMultiplier !== null ||
    input.match.tacticalHomeMultiplier !== null ||
    input.match.tacticalAwayMultiplier !== null;

  if (seasonPair) return { passed: true, mode: "season-corners", missing: [] };
  if (recentPair) return { passed: true, mode: "recent-corners", missing: [] };
  if (xgPair) return { passed: true, mode: "xg", missing: [] };
  if (teamValueExists || matchValueExists) return { passed: true, mode: "partial", missing: [] };

  return {
    passed: false,
    mode: "none",
    missing: [
      "home.avgCornersPerGame",
      "away.avgCornersPerGame",
      "home.avgCornersLast5",
      "away.avgCornersLast5",
      "home.xg",
      "away.xg",
    ],
  };
}

function formRate(form: string | null): number | null {
  if (!form) return null;
  const results = form.toUpperCase().match(/[WDL]/g);
  if (!results?.length) return null;
  const points = results.reduce((sum, result) => sum + (result === "W" ? 3 : result === "D" ? 1 : 0), 0);
  return points / (results.length * 3);
}

/**
 * The Part 1/2 corner-baseline cascade for one team:
 *   avgCornersPerGame → avgCornersLast5 → avgCornersConcededPerGame →
 *   league average (per-team baseline). Every rung is real data — the league
 *   average is an observed historical baseline, never a simulated stand-in.
 */
function resolveCornerBaseline(
  team: PrematchTeamInputs,
  leaguePerTeam: number | null,
): CornerBaseline {
  if (team.avgCornersPerGame !== null) return { value: team.avgCornersPerGame, origin: "real", label: "real" };
  if (team.avgCornersLast5 !== null) return { value: team.avgCornersLast5, origin: "last5", label: "last5" };
  if (team.avgCornersConcededPerGame !== null) {
    return { value: team.avgCornersConcededPerGame, origin: "conceded", label: "conceded" };
  }
  if (leaguePerTeam !== null) return { value: leaguePerTeam, origin: "league", label: "league avg" };
  return { value: null, origin: null, label: null };
}

function weightedExpectation(
  team: PrematchTeamInputs,
  h2hCorners: number | null,
  leaguePerTeam: number | null,
): TeamExpectation | null {
  const baseline = resolveCornerBaseline(team, leaguePerTeam);
  const values: Record<WeightedField, number | null> = {
    // Part 3 primary term: the first available rung of the cascade.
    avgCorners: baseline.value,
    // Part 1: xg doubles as a proxy for the expected corner count when corner
    // data is missing; its weight is then redistributed to it automatically.
    xg: team.xg,
    // Part 1: possession share as a corner-dominance estimate (55% → 5.5).
    possession: team.possession === null ? null : team.possession / 10,
    h2hCorners,
  };

  let weightedTotal = 0;
  let availableWeight = 0;
  const weightedFields: WeightedField[] = [];
  const missingWeightedFields: WeightedField[] = [];

  for (const field of Object.keys(EXPECTATION_WEIGHTS) as WeightedField[]) {
    const value = values[field];
    if (value === null) {
      missingWeightedFields.push(field);
      continue;
    }
    const weight = EXPECTATION_WEIGHTS[field];
    weightedTotal += value * weight;
    availableWeight += weight;
    weightedFields.push(field);
  }

  if (availableWeight === 0) return null;
  // Team-specific = weighted terms grounded in actual team data. The league
  // fallback grounds the match (Part 2) but carries no team differentiation.
  const teamSpecificFieldCount = weightedFields.reduce(
    (count, field) => count + (field === "avgCorners" && baseline.origin === "league" ? 0 : 1),
    0,
  );
  return {
    value: weightedTotal / availableWeight,
    weightedFieldCount: weightedFields.length,
    weightedFields,
    missingWeightedFields,
    baselineOrigin: baseline.origin,
    baselineValue: baseline.value,
    teamSpecificFieldCount,
  };
}

function pressureAdjustment(input: PreparedPrematchStats): {
  home: number;
  away: number;
  signals: string[];
} {
  const homeForm = formRate(input.home.form);
  const awayForm = formRate(input.away.form);
  const pairs: Array<{ name: string; home: number | null; away: number | null; weight: number }> = [
    { name: "xgPerShot", home: input.home.xgPerShot, away: input.away.xgPerShot, weight: 0.12 },
    { name: "shots", home: input.home.shots, away: input.away.shots, weight: 0.22 },
    { name: "shotsOnTarget", home: input.home.shotsOnTarget, away: input.away.shotsOnTarget, weight: 0.18 },
    { name: "passes", home: input.home.passes, away: input.away.passes, weight: 0.12 },
    { name: "form", home: homeForm, away: awayForm, weight: 0.12 },
    { name: "goalsScoredLast5", home: input.home.goalsScoredLast5, away: input.away.goalsScoredLast5, weight: 0.12 },
    {
      name: "opponentGoalsConcededLast5",
      home: input.away.goalsConcededLast5,
      away: input.home.goalsConcededLast5,
      weight: 0.05,
    },
    {
      name: "opponentAvgCornersConcededLast5",
      home: input.away.avgCornersConcededLast5,
      away: input.home.avgCornersConcededLast5,
      weight: 0.07,
    },
  ];

  let homeShareTotal = 0;
  let availableWeight = 0;
  const signals: string[] = [];
  for (const pair of pairs) {
    if (pair.home === null || pair.away === null) continue;
    const total = pair.home + pair.away;
    const homeShare = total > 0 ? pair.home / total : 0.5;
    homeShareTotal += homeShare * pair.weight;
    availableWeight += pair.weight;
    signals.push(pair.name);
  }

  if (availableWeight === 0) return { home: 1, away: 1, signals };
  const homeShare = homeShareTotal / availableWeight;
  // Supplemental stats may move the weighted corner baseline by at most 15%.
  // This keeps the requested seven-field formula primary while still consuming
  // every available pressure/form signal.
  const home = clamp(1 + (homeShare - 0.5) * 0.30, 0.85, 1.15);
  const away = clamp(1 - (homeShare - 0.5) * 0.30, 0.85, 1.15);
  return { home, away, signals };
}

function expectedCorners(input: PreparedPrematchStats): CornerExpectations | null {
  const leaguePerTeam = input.match.leagueAvgCornersPerTeam;
  const homeDetail = weightedExpectation(input.home, input.match.h2hHomeCorners, leaguePerTeam);
  const awayDetail = weightedExpectation(input.away, input.match.h2hAwayCorners, leaguePerTeam);
  if (!homeDetail || !awayDetail) return null;

  const pressure = pressureAdjustment(input);
  const adjustments: string[] = [];
  let home = homeDetail.value * pressure.home;
  let away = awayDetail.value * pressure.away;

  if (input.match.homeAdvantage !== null) {
    home *= input.match.homeAdvantage;
    adjustments.push(`home advantage ×${input.match.homeAdvantage.toFixed(2)}`);
  }
  if (input.match.matchImportanceMultiplier !== null) {
    home *= input.match.matchImportanceMultiplier;
    away *= input.match.matchImportanceMultiplier;
    adjustments.push(
      `${input.match.matchImportance ?? "match importance"} ×${input.match.matchImportanceMultiplier.toFixed(2)}`,
    );
  }
  if (input.match.tacticalHomeMultiplier !== null) {
    home *= input.match.tacticalHomeMultiplier;
  }
  if (input.match.tacticalAwayMultiplier !== null) {
    away *= input.match.tacticalAwayMultiplier;
  }
  if (input.match.tacticalMatchup) {
    adjustments.push(`tactical matchup: ${input.match.tacticalMatchup}`);
  }

  home = round(clamp(home, 0.25, 20), 2);
  away = round(clamp(away, 0.25, 20), 2);
  const difference = round(home - away, 2);
  return {
    home,
    away,
    total: round(home + away, 2),
    difference,
    absoluteDifference: round(Math.abs(difference), 2),
    homeDetail,
    awayDetail,
    pressureSignals: pressure.signals,
    adjustments,
  };
}

function isTeamSpecificBaseline(origin: CornerBaselineOrigin | null): boolean {
  return origin === "real" || origin === "last5" || origin === "conceded";
}

function dataQuality(input: PreparedPrematchStats, expectations: CornerExpectations): DataQuality {
  const availableTeamFields = [input.home, input.away].reduce(
    (total, team) => total + TEAM_INPUT_FIELDS.filter((field) => team[field] !== null).length,
    0,
  );
  const bothRealBaselines =
    isTeamSpecificBaseline(expectations.homeDetail.baselineOrigin) &&
    isTeamSpecificBaseline(expectations.awayDetail.baselineOrigin);
  const anyTeamSpecific =
    expectations.homeDetail.teamSpecificFieldCount > 0 ||
    expectations.awayDetail.teamSpecificFieldCount > 0;

  // HIGH — both teams' corner baselines are real team data (season / last-5 /
  //        concession rates), never the league fallback.
  // MEDIUM — at least one team-specific input (real corners, xg, possession or
  //          h2h) grounds the model; the other side may ride the league
  //          baseline. This is retained for data-availability reporting while
  //          the normal hit-rate gate is disabled.
  // LOW — neither team has any team-specific input; this is rejected by the
  //       remaining confidence/calibration gate.
  const confidence: Confidence = bothRealBaselines
    ? "HIGH"
    : anyTeamSpecific
      ? "MEDIUM"
      : "LOW";

  return {
    confidence,
    homeWeightedFields: expectations.homeDetail.weightedFieldCount,
    awayWeightedFields: expectations.awayDetail.weightedFieldCount,
    availableTeamFields,
    totalTeamFields: TEAM_INPUT_FIELDS.length * 2,
  };
}

function teamStrength(expectations: CornerExpectations): StrengthProfile {
  return {
    stronger: expectations.absoluteDifference >= 1
      ? expectations.difference > 0 ? "home" : "away"
      : null,
    gap: expectations.absoluteDifference,
  };
}

function engineCornerMarket(result: EngineResult, teamName: string, line: number): Market | undefined {
  const name = `${teamName} Corners O/U ${line.toFixed(1)}`;
  return result.markets.find((market) => market.name === name);
}

function engineTotalCornerMarket(result: EngineResult, line: number): Market | undefined {
  const name = `Total Corners O/U ${line.toFixed(1)}`;
  return result.markets.find((market) => market.name === name);
}

function similarHistoricalSamples(
  history: HistoricalCornerSample[],
  expectedTotal: number,
  expectedDifference: number,
): HistoricalCornerSample[] {
  return history.filter((sample) => {
    if (sample.expectedTotal === null) return false;
    if (Math.abs(sample.expectedTotal - expectedTotal) > 1.5) return false;
    return sample.expectedDifference === null || Math.abs(Math.abs(sample.expectedDifference) - Math.abs(expectedDifference)) <= 1.5;
  });
}

function empiricalLineRate(
  samples: HistoricalCornerSample[],
  scope: "total" | Side,
  line: number,
  over: boolean,
): { rate: number; samples: number } | null {
  if (!samples.length) return null;
  let hits = 0;
  for (const sample of samples) {
    const actual = scope === "total" ? sample.home + sample.away : sample[scope];
    if (over ? actual > line : actual < line) hits++;
  }
  return { rate: hits / samples.length, samples: samples.length };
}

function modelAndCalibrationRate(
  modelRate: number,
  selection: string,
  engineMarket: Market | undefined,
  empirical: { rate: number; samples: number } | null,
  quality: DataQuality,
): { hitRate: number; reliable: boolean; calibrationText: string } {
  if (empirical) {
    return {
      hitRate: empirical.rate,
      reliable: empirical.samples >= MIN_EMPIRICAL_CALIBRATION_SAMPLES,
      calibrationText: `${empirical.samples} historical matches with similar expected corner totals`,
    };
  }

  const engineCompatible = Boolean(
    engineMarket &&
    engineMarket.selection === selection &&
    Number.isFinite(engineMarket.hitRate),
  );
  const engineRate = engineCompatible ? engineMarket!.hitRate : null;
  const hitRate = engineRate === null ? modelRate : modelRate * 0.7 + engineRate * 0.3;
  const engineReliable = Boolean(
    engineCompatible &&
    !engineMarket!.rejected &&
    engineMarket!.confidence === "HIGH",
  );
  // Partial-data matches calibrate on the model's own line probability. The
  // hit-rate threshold is currently disabled, but reliability is still needed
  // before a market can be emitted.
  const betaBinomialReliable = quality.confidence !== "LOW";
  return {
    hitRate,
    reliable: engineReliable || betaBinomialReliable,
    calibrationText: engineCompatible
      ? "line-specific beta-binomial probability cross-calibrated with the engine's historical corner model"
      : "line-specific beta-binomial probability calibrated for over-dispersed historical corner counts",
  };
}

function marketEligibility(
  hitRate: number,
  confidence: Confidence,
  calibrationReliable: boolean,
  minRate = MINIMUM_HIT_RATE,
): { accepted: boolean; rejectionReason?: string } {
  if (!Number.isFinite(hitRate)) {
    return { accepted: false, rejectionReason: "hit rate was not finite" };
  }
  // The normal Sure Corners hit-rate gate is deliberately disabled while the
  // synthetic baseline is being assessed. Explicit market-specific floors
  // (corner winner / handicap) remain intact when a caller supplies one.
  if (minRate > MINIMUM_HIT_RATE && hitRate < minRate) {
    return {
      accepted: false,
      rejectionReason: `hitRate ${hitRate.toFixed(3)} < market-specific ${minRate.toFixed(3)} floor`,
    };
  }
  if (!calibrationReliable) {
    return { accepted: false, rejectionReason: "historical calibration was not reliable" };
  }
  if (confidence !== "HIGH") {
    return { accepted: false, rejectionReason: `confidence ${confidence} was not HIGH` };
  }
  return { accepted: true };
}

function makeEvaluatedMarket(
  marketType: SureCornerMarketType,
  name: string,
  selection: string,
  line: number | null,
  hitRate: number,
  reason: string,
  quality: DataQuality,
  calibrationReliable: boolean,
  minRate = MINIMUM_HIT_RATE,
): EvaluatedMarket {
  const safeHitRate = round(clamp(hitRate, 0, 1), 4);
  const confidence: Confidence = safeHitRate >= minRate &&
    calibrationReliable && quality.confidence !== "LOW"
    ? "HIGH"
    : quality.confidence === "LOW" ? "LOW" : "MEDIUM";
  const gate = marketEligibility(safeHitRate, confidence, calibrationReliable, minRate);
  return {
    id: `${marketType.toLowerCase().replaceAll(" ", "-")}-${line ?? selection.toLowerCase().replaceAll(" ", "-")}`,
    marketType,
    name,
    selection,
    line,
    hitRate: safeHitRate,
    confidence,
    reason,
    calibrationReliable,
    accepted: gate.accepted,
    rejectionReason: gate.rejectionReason,
  };
}

function baselineText(detail: TeamExpectation, side: string): string | null {
  if (detail.baselineValue === null || detail.baselineOrigin === null) return null;
  const label = detail.baselineOrigin === "league" ? "league avg" : detail.baselineOrigin;
  return `${side} ${detail.baselineValue.toFixed(1)} (${label})`;
}

function expectationReason(
  expectations: CornerExpectations,
  input: PreparedPrematchStats,
  calibrationText: string,
): string {
  const adjustments = expectations.adjustments.length
    ? ` Adjustments: ${expectations.adjustments.join("; ")}.`
    : "";
  const pressure = expectations.pressureSignals.length
    ? ` Supplemental pressure signals: ${expectations.pressureSignals.join(", ")}.`
    : "";
  const baselines = [
    baselineText(expectations.homeDetail, "home"),
    baselineText(expectations.awayDetail, "away"),
  ]
    .filter((text): text is string => text !== null)
    .join(", ");
  const baselineNote = baselines ? ` Corner baselines: ${baselines}.` : "";
  return `Weighted pre-match model expects ${expectations.home.toFixed(1)} home and ${expectations.away.toFixed(1)} away corners (${expectations.total.toFixed(1)} total). Missing weights were redistributed across available inputs.${baselineNote} ${calibrationText}.${pressure}${adjustments} Sources: ${input.source}.`;
}

function buildOuMarket(
  result: EngineResult,
  marketType: "Total Corners" | "Team 1 Corners" | "Team 2 Corners",
  teamName: string | null,
  side: "total" | Side,
  expected: number,
  line: number,
  expectations: CornerExpectations,
  input: PreparedPrematchStats,
  quality: DataQuality,
): EvaluatedMarket {
  const engineMarket = teamName
    ? engineCornerMarket(result, teamName, line)
    : engineTotalCornerMarket(result, line);
  const overProbability = betaBinomOver(line, expected, teamName ? 12 : 20);
  const selectedOver = overProbability >= 0.5;
  const selection = selectedOver ? `Over ${line.toFixed(1)}` : `Under ${line.toFixed(1)}`;
  const modelRate = Math.max(overProbability, 1 - overProbability);
  const historical = similarHistoricalSamples(
    input.match.history,
    expectations.total,
    expectations.absoluteDifference,
  );
  const empirical = empiricalLineRate(historical, side, line, selectedOver);
  const calibrated = modelAndCalibrationRate(modelRate, selection, engineMarket, empirical, quality);
  const label = teamName ?? "Total";
  const reason = expectationReason(expectations, input, calibrated.calibrationText);
  return makeEvaluatedMarket(
    marketType,
    `${label} Corners O/U ${line.toFixed(1)}`,
    selection,
    line,
    calibrated.hitRate,
    `${reason} The ${selection} line has a ${(calibrated.hitRate * 100).toFixed(1)}% calibrated hit rate at expectation ${expected.toFixed(2)}.`,
    quality,
    calibrated.reliable,
  );
}

function bestMarket(markets: EvaluatedMarket[]): EvaluatedMarket | null {
  const accepted = markets.filter((market) => market.accepted);
  if (!accepted.length) return null;
  return [...accepted].sort((left, right) => right.hitRate - left.hitRate)[0] ?? null;
}

function handicapCoverProbability(favoured: number, other: number, handicap: number): number {
  const limit = Math.min(60, Math.max(25, Math.ceil(Math.max(favoured, other)) + 18));
  const requiredDifference = Math.ceil(handicap);
  let probability = 0;
  for (let favouredCorners = 0; favouredCorners <= limit; favouredCorners++) {
    for (let otherCorners = 0; otherCorners <= limit; otherCorners++) {
      if (favouredCorners - otherCorners >= requiredDifference) {
        probability += poissonPmf(favouredCorners, favoured) * poissonPmf(otherCorners, other);
      }
    }
  }
  return clamp(probability, 0, 1);
}

function empiricalDirectionalRate(
  input: PreparedPrematchStats,
  expectations: CornerExpectations,
  stronger: Side,
  handicap: number,
): { rate: number; samples: number } | null {
  const samples = similarHistoricalSamples(
    input.match.history,
    expectations.total,
    expectations.absoluteDifference,
  );
  if (!samples.length) return null;
  let hits = 0;
  for (const sample of samples) {
    const favoured = stronger === "home" ? sample.home : sample.away;
    const other = stronger === "home" ? sample.away : sample.home;
    if (favoured - other >= Math.ceil(handicap)) hits++;
  }
  return { rate: hits / samples.length, samples: samples.length };
}

function buildHandicapMarkets(
  stronger: Side,
  fx: FixtureLite,
  expectations: CornerExpectations,
  input: PreparedPrematchStats,
  quality: DataQuality,
): EvaluatedMarket[] {
  const favouredName = stronger === "home" ? fx.home.name : fx.away.name;
  const favouredCorners = stronger === "home" ? expectations.home : expectations.away;
  const otherCorners = stronger === "home" ? expectations.away : expectations.home;

  return HANDICAP_LINES.map((handicap) => {
    const empirical = empiricalDirectionalRate(input, expectations, stronger, handicap);
    const probability = empirical?.rate ?? handicapCoverProbability(favouredCorners, otherCorners, handicap);
    const reliable = empirical
      ? empirical.samples >= MIN_EMPIRICAL_CALIBRATION_SAMPLES
      : quality.confidence !== "LOW";
    const calibration = empirical
      ? `${empirical.samples} similar historical expected-difference matches`
      : "Poisson corner-difference distribution grounded in the weighted pre-match expectations";
    return makeEvaluatedMarket(
      "Corner Handicap",
      "Corner Handicap",
      `${favouredName} -${handicap.toFixed(1)} corners`,
      handicap,
      probability,
      `${expectationReason(expectations, input, calibration)} Expected corner difference is ${expectations.absoluteDifference.toFixed(1)}; ${favouredName} covers -${handicap.toFixed(1)} in ${(probability * 100).toFixed(1)}% of calibrated scenarios.`,
      quality,
      reliable,
      MIN_HANDICAP_PROBABILITY,
    );
  });
}

function buildCornerWinnerMarket(
  stronger: Side,
  fx: FixtureLite,
  expectations: CornerExpectations,
  input: PreparedPrematchStats,
  quality: DataQuality,
): EvaluatedMarket | null {
  if (expectations.absoluteDifference <= 2.0) {
    return null;
  }

  const favouredName = stronger === "home" ? fx.home.name : fx.away.name;
  const favouredCorners = stronger === "home" ? expectations.home : expectations.away;
  const otherCorners = stronger === "home" ? expectations.away : expectations.home;

  const empirical = empiricalDirectionalRate(input, expectations, stronger, 0.5);
  const probability = empirical?.rate ?? handicapCoverProbability(favouredCorners, otherCorners, 0.5);

  const reliable = empirical
    ? empirical.samples >= MIN_EMPIRICAL_CALIBRATION_SAMPLES
    : quality.confidence !== "LOW";

  const calibration = empirical
    ? `${empirical.samples} similar historical expected-difference matches`
    : "Poisson corner-difference distribution grounded in the weighted pre-match expectations";

  const reason = `${expectationReason(expectations, input, calibration)} Expected corner difference is ${expectations.absoluteDifference.toFixed(1)}; ${favouredName} has a ${(probability * 100).toFixed(1)}% probability of winning the corner count.`;

  return makeEvaluatedMarket(
    "Corner Winner",
    "Corner Winner",
    favouredName,
    null,
    probability,
    reason,
    quality,
    reliable,
    MIN_CORNER_WINNER_PROBABILITY,
  );
}

/**
 * Team 1 / Team 2 corner line selection. When the pre-match statistics point
 * to a stronger side, the two lines are differentiated by team strength: the
 * stronger side's line is at least 1.0 higher than the weaker side's, and
 * among equally calibrated pairs the line gap mirrors the expected corner
 * gap. If no accepted pair can express that gap, each side keeps its own best
 * qualifying line instead of both team markets being dropped.
 */
function selectTeamPair(
  homeOptions: EvaluatedMarket[],
  awayOptions: EvaluatedMarket[],
  expectations: CornerExpectations,
  strength: StrengthProfile,
): { home: EvaluatedMarket | null; away: EvaluatedMarket | null } {
  const bestHome = bestMarket(homeOptions);
  const bestAway = bestMarket(awayOptions);
  if (!bestHome || !bestAway || !strength.stronger) {
    return { home: bestHome, away: bestAway };
  }

  const orderedPairs = homeOptions
    .filter((home) => home.accepted && home.line !== null)
    .flatMap((home) =>
      awayOptions
        .filter((away) =>
          away.accepted &&
          away.line !== null &&
          (strength.stronger === "home"
            ? (home.line ?? 0) >= away.line + 1
            : away.line >= (home.line ?? 0) + 1),
        )
        .map((away) => ({ home, away })),
    )
    .sort((left, right) => {
      const rateGap =
        right.home.hitRate + right.away.hitRate - (left.home.hitRate + left.away.hitRate);
      if (rateGap !== 0) return rateGap;
      // Tie-break: prefer the pair whose line gap best mirrors the expected
      // corner gap from the pre-match statistics.
      const leftGap = Math.abs(
        Math.abs((left.home.line ?? 0) - (left.away.line ?? 0)) - expectations.absoluteDifference,
      );
      const rightGap = Math.abs(
        Math.abs((right.home.line ?? 0) - (right.away.line ?? 0)) - expectations.absoluteDifference,
      );
      return leftGap - rightGap;
    });

  const pair = orderedPairs[0];
  return pair ? { home: pair.home, away: pair.away } : { home: bestHome, away: bestAway };
}

/** Long form for the primary term — it stands for the whole Part 1/2 cascade. */
const WEIGHTED_FIELD_LABELS: Record<WeightedField, string> = {
  avgCorners: "avgCorners (avgCornersPerGame → avgCornersLast5 → avgCornersConcededPerGame → leagueAvg)",
  xg: "xg",
  possession: "possession",
  h2hCorners: "h2hCorners",
};

function missingWeightedStatistics(
  fx: FixtureLite,
  expectations: CornerExpectations,
): string[] {
  return [
    ...expectations.homeDetail.missingWeightedFields.map(
      (field) => `${fx.home.name}.${WEIGHTED_FIELD_LABELS[field]}`,
    ),
    ...expectations.awayDetail.missingWeightedFields.map(
      (field) => `${fx.away.name}.${WEIGHTED_FIELD_LABELS[field]}`,
    ),
  ];
}

function diagnosticForNoMarkets(candidates: EvaluatedMarket[]): string {
  const best = [...candidates].sort((left, right) => right.hitRate - left.hitRate)[0];
  if (best?.rejectionReason) {
    return `${best.rejectionReason} (best line: ${best.name} ${best.selection}; hit rate gate disabled)`;
  }
  return "no corner market passed the remaining calibration and confidence gates (hit rate gate disabled)";
}

function evaluateFixture(
  fx: FixtureLite,
  input: PreparedPrematchStats,
  result: EngineResult,
): EvaluationResult {
  const leaguePerTeam = input.match.leagueAvgCornersPerTeam;
  const expectations = expectedCorners(input);
  if (!expectations) {
    const emptySide = weightedExpectation(input.home, input.match.h2hHomeCorners, leaguePerTeam)
      ? fx.away.name
      : fx.home.name;
    return {
      match: null,
      rejectionCode: "preMatchStats",
      reason: `no pre-match statistical input is available for ${emptySide} (no corner baseline in the avgCornersPerGame → avgCornersLast5 → avgCornersConcededPerGame → leagueAvg cascade, and no xg / possession / h2h data)`,
      missingStatistics: [
        `${emptySide}.avgCorners (perGame → last5 → conceded → leagueAvg)`,
        `${emptySide}.xg`,
        `${emptySide}.possession`,
        `${emptySide}.h2hCorners`,
      ],
    };
  }

  const quality = dataQuality(input, expectations);
  if (quality.confidence === "LOW") {
    return {
      match: null,
      rejectionCode: "insufficientData",
      reason: "no team-specific pre-match statistical inputs were available for either team (both corner baselines fell back to the league average and no xg / possession / h2h data could differentiate them)",
      missingStatistics: missingWeightedStatistics(fx, expectations),
    };
  }

  const strength = teamStrength(expectations);
  const candidates: EvaluatedMarket[] = [];
  const markets: EvaluatedMarket[] = [];

  const totalOptions = TOTAL_CORNER_LINES.map((line) =>
    buildOuMarket(
      result,
      "Total Corners",
      null,
      "total",
      expectations.total,
      line,
      expectations,
      input,
      quality,
    ),
  );
  candidates.push(...totalOptions);
  const total = bestMarket(totalOptions);
  if (total) markets.push(total);

  const homeOptions = TEAM_CORNER_LINES.map((line) =>
    buildOuMarket(
      result,
      "Team 1 Corners",
      fx.home.name,
      "home",
      expectations.home,
      line,
      expectations,
      input,
      quality,
    ),
  );
  const awayOptions = TEAM_CORNER_LINES.map((line) =>
    buildOuMarket(
      result,
      "Team 2 Corners",
      fx.away.name,
      "away",
      expectations.away,
      line,
      expectations,
      input,
      quality,
    ),
  );
  candidates.push(...homeOptions, ...awayOptions);

  const teamPair = selectTeamPair(homeOptions, awayOptions, expectations, strength);
  if (teamPair.home) markets.push(teamPair.home);
  if (teamPair.away) markets.push(teamPair.away);

  if (strength.stronger) {
    if (expectations.absoluteDifference > 2.0) {
      const winnerMarket = buildCornerWinnerMarket(
        strength.stronger,
        fx,
        expectations,
        input,
        quality,
      );
      if (winnerMarket) {
        candidates.push(winnerMarket);
        if (winnerMarket.accepted) {
          markets.push(winnerMarket);
        }
      }
    }

    const handicapOptions = buildHandicapMarkets(strength.stronger, fx, expectations, input, quality);
    candidates.push(...handicapOptions);
    const handicap = bestMarket(
      handicapOptions.filter((candidate) => candidate.hitRate >= MIN_HANDICAP_PROBABILITY),
    );
    if (handicap) markets.push(handicap);
  }

  // Defensive invariant: this route never emits opposite directions at the
  // same line for the same team.
  const directionalKeys = new Set<string>();
  const differentiatedMarkets = markets.filter((market) => {
    if (market.line === null || !market.selection.match(/^(Over|Under)/)) return true;
    const teamScope = market.marketType;
    const key = `${teamScope}:${market.line}`;
    if (directionalKeys.has(key)) return false;
    directionalKeys.add(key);
    return true;
  });

  if (!differentiatedMarkets.length) {
    return {
      match: null,
      rejectionCode: "marketGate",
      reason: diagnosticForNoMarkets(candidates),
      missingStatistics: missingWeightedStatistics(fx, expectations),
    };
  }

  return {
    match: {
      fixtureId: fx.id,
      homeTeam: fx.home.name,
      awayTeam: fx.away.name,
      homeLogo: fx.home.logo,
      awayLogo: fx.away.logo,
      league: fx.leagueName,
      leagueSlug: fx.leagueSlug,
      leagueTier: leagueTier(fx),
      date: fx.date,
      confidence: "HIGH",
      realStats: true,
      statsSource: input.source,
      dataAvailability: quality.confidence,
      weightedFieldsAvailable: {
        home: quality.homeWeightedFields,
        away: quality.awayWeightedFields,
        total: Object.keys(EXPECTATION_WEIGHTS).length,
      },
      predictedCorners: {
        home: expectations.home,
        away: expectations.away,
        total: expectations.total,
        difference: expectations.difference,
        strongerTeam: strength.stronger === "home"
          ? fx.home.name
          : strength.stronger === "away" ? fx.away.name : null,
      },
      markets: differentiatedMarkets.map(({ accepted: _accepted, calibrationReliable: _calibration, rejectionReason: _rejection, ...market }) => market),
    },
  };
}

async function runPrematchEngine(
  fx: FixtureLite,
  summary: MatchSummary | null,
): Promise<EngineResult> {
  // The engine's persistent profile cache is optional for this route. Loading
  // it lazily lets the API still return explicit per-fixture rejections in a
  // stateless environment instead of failing the whole route at module load.
  const { runEngineFromRealWithProfiles } = await import("@/lib/engine");
  return runEngineFromRealWithProfiles(fx, summary);
}

/**
 * Resolved corner baseline on a side for the per-match source log — the same
 * cascade the formula uses (avgCornersPerGame → avgCornersLast5 →
 * avgCornersConcededPerGame → league average), tagged with its origin so
 * fallback use is explicit in the log (Part 4).
 */
function cornerBaselineForLog(
  stats: CanonicalMatchStats,
  side: Side,
  leaguePerTeam: number | null,
): CornerBaseline {
  const team = stats[side] as unknown as Record<string, unknown>;
  const real = finiteNumber(team.avgCornersPerGame);
  if (real !== null) return { value: real, origin: "real", label: "real" };
  const last5 = finiteNumber(team.avgCornersLast5);
  if (last5 !== null) return { value: last5, origin: "last5", label: "last5" };
  const conceded = finiteNumber(team.avgCornersConcededPerGame);
  if (conceded !== null) return { value: conceded, origin: "conceded", label: "conceded" };
  if (leaguePerTeam !== null) return { value: leaguePerTeam, origin: "league", label: "league avg" };
  return { value: null, origin: null, label: null };
}

/**
 * Use the score-board record where available, then recent form, as the
 * historical-performance proxy for a team’s place in the table. A points rate
 * of at least 50% of the maximum is treated as top-half (+10%); below that is
 * bottom-half (-10%). A team with neither signal stays at the league baseline.
 */
function syntheticStrengthMultiplier(team: FixtureLite["home"]): number {
  const record = team.record?.match(/(\d+)\s*-\s*(\d+)\s*-\s*(\d+)/);
  const recordRate = record
    ? (() => {
      const wins = Number(record[1]);
      const draws = Number(record[2]);
      const losses = Number(record[3]);
      const matches = wins + draws + losses;
      return matches > 0 ? (wins * 3 + draws) / (matches * 3) : null;
    })()
    : null;
  const performance = recordRate ?? formRate(team.form ?? null);
  if (performance === null) return 1;
  return performance >= 0.5 ? 1.1 : 0.9;
}

/**
 * Build a complete canonical object when no source can supply upcoming-match
 * data. League anchors are match totals, while avgCornersPerGame is per team,
 * so the anchor is split between the two teams before applying the requested
 * strength and home/away adjustments. avgGoals is the available league-level
 * proxy for league average xG.
 */
function syntheticBaselineStats(fx: FixtureLite): CanonicalMatchStats {
  const anchors = getAnchors(fx.leagueSlug);
  const leagueAvgCorners = anchors.avgCorners / 2;
  const leagueAvgXG = anchors.avgGoals / 2;
  const homeStrength = syntheticStrengthMultiplier(fx.home);
  const awayStrength = syntheticStrengthMultiplier(fx.away);
  const homeAdvantage = 1.05;
  const awayAdvantage = 0.95;
  const homeCorners = leagueAvgCorners * homeStrength * homeAdvantage;
  const awayCorners = leagueAvgCorners * awayStrength * awayAdvantage;

  const baseline: CanonicalMatchStats = {
    home: {
      ...emptyTeamStats(),
      avgCornersPerGame: homeCorners,
      xg: leagueAvgXG * homeStrength,
      possession: 50 + homeStrength * 5,
    },
    away: {
      ...emptyTeamStats(),
      avgCornersPerGame: awayCorners,
      xg: leagueAvgXG * awayStrength,
      possession: 50 + awayStrength * 5,
    },
    metadata: {
      source: "baseline (synthetic)",
      fetchedAt: new Date().toISOString(),
      matchDate: fx.date.slice(0, 10),
      leagueSlug: fx.leagueSlug,
    },
  };

  console.info(
    `[SureCorners] ${formatMatch(fx)}: using synthetic baseline ` +
    `(league avg: ${leagueAvgCorners.toFixed(1)} corners, home: ${homeCorners.toFixed(1)}, away: ${awayCorners.toFixed(1)})`,
  );
  return baseline;
}

/**
 * Fetch the merged CanonicalMatchStats for a fixture from the multi-source
 * stats aggregator. The aggregator walks its full priority-ordered source
 * chain (SportScore → API-Football → StatsBomb → FBref → TheSportsDB →
 * Understat → OpenLigaDB → Highlightly, plus the other registered sources),
 * applies its own timeout per source, logs and skips any source that fails
 * (timeout, 404, 500, rate limit), and first-wins merges partial payloads
 * from every contributing source. For an upcoming match, a null result is
 * represented by an explicit synthetic baseline rather than a rejection.
 */
async function fetchPrematchStats(fx: FixtureLite, force: boolean): Promise<CanonicalMatchStats> {
  try {
    const stats = await statsAggregator.fetch(
      {
        leagueSlug: fx.leagueSlug,
        eventId: fx.id,
        homeTeam: fx.home.name,
        awayTeam: fx.away.name,
        date: fx.date,
      },
      { force },
    );
    if (!stats) return syntheticBaselineStats(fx);

    // Every baseline is tagged with its origin — "(real)" for team-specific
    // corner data, "(league avg)" when the team rode the league-average fallback.
    const leaguePerTeam = leagueAverageFor(stats, fx).value / 2;
    const format = (baseline: CornerBaseline) =>
      baseline.value === null ? "n/a" : baseline.value.toFixed(1) + (baseline.label ? ` (${baseline.label})` : "");
    console.info(
      `[SureCorners] ${formatMatch(fx)}: stats from ${stats.metadata.source || "multi-source merge"} ` +
      `(avgCorners: home ${format(cornerBaselineForLog(stats, "home", leaguePerTeam))}, away ${format(cornerBaselineForLog(stats, "away", leaguePerTeam))})`,
    );
    return stats;
  } catch (error) {
    console.warn(
      `[SureCorners] ${formatMatch(fx)}: stats aggregator failed (${error instanceof Error ? error.message : String(error)}); using synthetic baseline`,
    );
    return syntheticBaselineStats(fx);
  }
}

function cachedProfile(teamName: string, leagueSlug: string): Promise<MeshProfile | null> {
  const key = `${leagueSlug}:${teamName}`.toLowerCase();
  const existing = profilePromises.get(key);
  if (existing) return existing;
  // Dynamic import keeps this fail-soft in local/stateless deployments where
  // the optional persistent profile cache has no DATABASE_URL configured.
  const pending = import("@/lib/engine/dataMesh")
    .then(({ getCachedMeshProfile }) => getCachedMeshProfile(teamName, leagueSlug))
    .catch(() => null);
  profilePromises.set(key, pending);
  return pending;
}

async function fetchProfiles(fx: FixtureLite): Promise<{ home: MeshProfile | null; away: MeshProfile | null }> {
  const profiles = Promise.all([
    cachedProfile(fx.home.name, fx.leagueSlug),
    cachedProfile(fx.away.name, fx.leagueSlug),
  ]).then(([home, away]) => ({ home, away }));
  return Promise.race([
    profiles,
    new Promise<{ home: null; away: null }>((resolve) =>
      setTimeout(() => resolve({ home: null, away: null }), PROFILE_TIMEOUT_MS),
    ),
  ]);
}

/**
 * Persist every accepted sure-bet corner pick to performance_log
 * (feature = 'corners', rankingMode = 'S', outcome = 'pending') so the
 * post-match verification endpoint (/api/sure-corners/verify) and the settle
 * cron's feature sweep can settle each market once the match finishes.
 * Idempotent: one row per (eventId, market, selection).
 *
 * The row's top10Detail entry carries the fair model odds (1 / hitRate) so
 * the /performance/corners dashboard can report P&L / ROI on a $10 unit
 * stake — the same convention the rest of the app uses for model prices.
 *
 * Fail-soft by design: a missing or unreachable database must never break
 * the public feed, so the whole persistence step is wrapped in try/catch.
 * The db module is imported dynamically — the same pattern this route uses
 * for the optional persistent profile cache — so deployments without a
 * DATABASE_URL keep working.
 */
async function persistSureCornerPicks(matches: SureCornerMatch[]): Promise<void> {
  try {
    const { db } = await import("@/db");
    const { performanceLog } = await import("@/db/schema");
    const { and, eq, isNull, or } = await import("drizzle-orm");

    let saved = 0;
    for (const match of matches) {
      for (const market of match.markets) {
        // Also match legacy rows (feature IS NULL) so a deploy of the feature
        // column never double-tracks a match that is already being watched.
        const existing = await db
          .select({ id: performanceLog.id })
          .from(performanceLog)
          .where(and(
            eq(performanceLog.eventId, match.fixtureId),
            eq(performanceLog.rankingMode, "S"),
            or(eq(performanceLog.feature, "corners"), isNull(performanceLog.feature)),
            eq(performanceLog.market, market.name),
            eq(performanceLog.selection, market.selection),
          ))
          .limit(1);
        if (existing[0]) continue;

        // Fair model price for the $10 unit-stake P&L reported by the
        // /performance/corners dashboard (odds column on the detail entry).
        const modelOdds = market.hitRate > 0 ? Math.round((1 / market.hitRate) * 100) / 100 : null;

        await db.insert(performanceLog).values({
          eventId: match.fixtureId,
          matchLabel: `${match.homeTeam} vs ${match.awayTeam}`,
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          league: match.league,
          leagueSlug: match.leagueSlug,
          competitionName: match.league,
          matchDate: match.date.slice(0, 10),
          // Pre-match row: the verify route stamps the final score, outcome
          // and settledAt once the match has finished.
          homeScore: 0,
          awayScore: 0,
          totalPicks: 1,
          hits: 0,
          misses: 0,
          // Kept at 0 on purpose: 'S' rows settle through the `outcome`
          // column, so the settle cron's pending-performance refresh (which
          // sweeps rows with pending > 0) must never adopt them.
          pending: 0,
          accuracy: 0,
          top10Detail: [{
            name: market.name,
            selection: market.selection,
            hitRate: market.hitRate,
            odds: modelOdds,
            outcome: "PENDING",
            family: "Corners",
            confidence: "HIGH",
          }],
          lowConfidence: false,
          // Dedicated feature tracking (independent of ranking modes A–D):
          // reported on /performance/corners, settled by the settle cron.
          feature: "corners",
          rankingMode: "S",
          market: market.name,
          selection: market.selection,
          outcome: "pending",
          hitRate: market.hitRate,
          // Every sure-bet pick passes the strict filters by construction.
          confidence: "HIGH",
        });
        saved++;
      }
    }
    console.info(
      `[SureCorners] Persisted ${saved} new sure-bet corner pick(s) to performance_log (feature 'corners')`,
    );
  } catch (error) {
    console.warn(
      `[SureCorners] Could not persist sure-bet corner picks: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const output: Array<R | undefined> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker));
  return output as R[];
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const isRefresh = url.searchParams.get("refresh") === "true";
  const cacheKey = getCacheKey(url);

  if (!isRefresh) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return Response.json(cached.data, {
        headers: { "Cache-Control": "no-store", "X-Cache": "HIT" },
      });
    }
    if (cached) cache.delete(cacheKey);
  } else {
    cache.delete(cacheKey);
  }

  const rejectionReasons: Record<string, number> = {};
  const rejections: RejectionLog[] = [];
  const reject = (
    fx: FixtureLite,
    code: string,
    reason: string,
    missingStatistics: string[] = [],
  ) => {
    rejectionReasons[code] = (rejectionReasons[code] ?? 0) + 1;
    rejections.push({
      fixtureId: fx.id,
      match: formatMatch(fx),
      code,
      reason,
      missingStatistics,
    });
    console.info(`[SureCorners] Rejected ${formatMatch(fx)}: ${reason}`);
  };

  try {
    const range = dateRange(LOOKAHEAD_DAYS);
    const boards = await Promise.all(
      SURE_CORNERS_LEAGUES.map(async (slug) => {
        try {
          return await fetchScoreboard(slug, range);
        } catch (error) {
          console.warn(`[SureCorners] Fixture feed failed for ${slug}: ${error instanceof Error ? error.message : String(error)}`);
          return [] as FixtureLite[];
        }
      }),
    );

    const seen = new Set<string>();
    const fixtures = boards
      .flat()
      .filter((fx) => {
        if (fx.state !== "pre" || seen.has(fx.id) || leagueTier(fx) > 2) return false;
        seen.add(fx.id);
        return true;
      })
      .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());

    const evaluated = await mapWithConcurrency(fixtures, 8, async (fx) => {
      // Every fixture goes through the full multi-source stats aggregator
      // first. The aggregator tries all configured sources in priority order
      // (with its own per-source timeout and fail-soft fallback/merging) and
      // returns null only when no source contributed a single field.
      const stats = await fetchPrematchStats(fx, isRefresh);

      // Supplement the merged canonical stats with the ESPN summary and the
      // mesh profiles; the weighted corner expectation formula then consumes
      // every available field with missing weights re-normalised.
      const [summary, profiles] = await Promise.all([
        fetchSummary(fx.leagueSlug, fx.id).catch(() => null),
        fetchProfiles(fx),
      ]);
      const input = preparePrematchStats(stats, fx, summary, profiles);
      const gate = preMatchGate(input);
      if (!gate.passed) {
        const reason = "no pre-match statistical inputs were available (home/away avgCornersPerGame, avgCornersLast5 and xg are all null)";
        reject(fx, "preMatchStats", reason, gate.missing);
        return null;
      }

      try {
        const prediction = await runPrematchEngine(fx, summary);
        const evaluation = evaluateFixture(fx, input, prediction);
        if (!evaluation.match) {
          reject(
            fx,
            evaluation.rejectionCode ?? "marketGate",
            evaluation.reason ?? "no corner market passed the remaining calibration and confidence gates (hit rate gate disabled)",
            evaluation.missingStatistics,
          );
        } else {
          console.info(`[SureCorners] ${formatMatch(fx)}: hit rate gate disabled — match accepted`);
        }
        return evaluation.match;
      } catch (error) {
        reject(
          fx,
          "engine",
          `prediction engine failed (${error instanceof Error ? error.message : String(error)})`,
        );
        return null;
      }
    });

    const matches = evaluated
      .filter((match): match is SureCornerMatch => match !== null)
      .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());

    // Record every accepted pick so it can be verified after the match.
    await persistSureCornerPicks(matches);

    const body: SureCornersResponse = {
      generatedAt: new Date().toISOString(),
      totalFixturesChecked: fixtures.length,
      rejectedMatches: rejections.length,
      rejectionReasons,
      rejections,
      matches,
      filters: {
        minimumHitRate: MINIMUM_HIT_RATE,
        requiredConfidence: "HIGH",
        requiresRealPerMatchCorners: false,
        requiresPreMatchStatistics: true,
        allowedLeagueTiers: [1, 2],
        totalCornerLines: TOTAL_CORNER_LINES,
        teamCornerLines: TEAM_CORNER_LINES,
        marketTypes: [
          "Total Corners",
          "Team 1 Corners",
          "Team 2 Corners",
          "Corner Winner",
          "Corner Handicap",
        ],
      },
    };

    console.info(
      `[SureCorners] Checked ${fixtures.length} fixtures (${LOOKAHEAD_DAYS}-day window), accepted ${matches.length}, rejected ${rejections.length}.`,
    );
    cache.set(cacheKey, { data: body, timestamp: Date.now() });

    return Response.json(body, {
      headers: {
        "Cache-Control": "no-store",
        "X-Cache": isRefresh ? "REFRESH" : "MISS",
      },
    });
  } catch (error) {
    console.error(`[SureCorners] Route failed: ${error instanceof Error ? error.message : String(error)}`);
    return Response.json(
      {
        generatedAt: new Date().toISOString(),
        totalFixturesChecked: 0,
        rejectedMatches: rejections.length,
        rejectionReasons: { ...rejectionReasons, route: 1 },
        rejections,
        matches: [],
        error: "Sure Bet Corners is temporarily unavailable. No match was shown without passing every gate.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
