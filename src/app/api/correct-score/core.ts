// ĞIGI GIVØ — Correct Score Predictions.
//
// Prediction stack, in the order the numbers are produced:
//
//   1. HISTORICAL AGGREGATE  (src/lib/data/historical.ts) — completed matches
//      from the database, then the GitHub datasets / openfootball / ESPN
//      fallbacks, over the last three seasons.
//   2. ELO                   (src/lib/data/elo.ts) — chronological replay of
//      those matches, K = 20/30/40 by match importance, 1500 start.
//   3. ATTACK / DEFENCE      (src/lib/data/attackDefence.ts) — venue-split
//      strengths shrunk toward the league baseline, multiplied out to λ.
//   4. DIXON–COLES           (src/lib/data/dixonColes.ts) — ρ estimated from
//      the same history, correcting the four low-score cells.
//   5. MONTE CARLO           (src/lib/data/monteCarlo.ts) — 10,000 simulations
//      per fixture over the corrected distribution; the top ten scorelines are
//      read off the simulation, not the analytic grid.
//
// The legacy xG-weighted composite is retained and blended with the structural
// λ when both are available (see `STRUCTURAL_MODEL_WEIGHT`), so the upgrade
// adds information rather than discarding the xG signal.
//
// The route reuses the app's next-seven-day fixture feed and the canonical
// multi-source stats aggregator. Missing match-level data is never presented as
// real: the model redistributes the documented weights over fields that are
// available, and uses the observed league anchor only when no team signal is
// available at all.

import { statsAggregator } from "@/lib/data/aggregator";
import type { CanonicalMatchStats } from "@/lib/data/types";
import { fetchSummary, type FixtureLite, type MatchSummary, type TeamForm } from "@/lib/espn";
import { canonicalLeagueSlug } from "@/lib/leaguePriority";
import { getAnchors } from "@/lib/engine/statisticalAnchors";
import { poissonPmf } from "@/lib/engine/stats";
import {
  ATTACK_DEFENCE_HALF_LIFE_DAYS,
  buildAttackDefenceTable,
  blendExpectedGoals,
  computeMatchExpectedGoals,
  STRUCTURAL_MODEL_WEIGHT,
  STRUCTURAL_WEIGHT_WITHOUT_XG,
  type AttackDefenceTable,
  type ExpectedGoalsComponents,
} from "@/lib/data/attackDefence";
import { estimateLeagueRho, getRhoForLeague, type RhoEstimate } from "@/lib/data/dixonColes";
import { buildEloRatings, getElo, loadMatchesFromEngSoccerData, type EloTable } from "@/lib/data/elo";
import {
  DEFAULT_SEASONS,
  loadHistoricalMatches,
  seasonCodes,
  type HistoricalDataset,
} from "@/lib/data/historical";
import {
  DEFAULT_SIMULATIONS,
  simulateMatch,
  type MonteCarloMarkets,
  type SimulationMethod,
} from "@/lib/data/monteCarlo";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LOOKAHEAD_DAYS = 7;
const DEFAULT_MAX_GOALS = 5;
const TOP_SCORELINES = 10;
const CACHE_TTL_MS = 30 * 60_000;
const FEED_TIMEOUT_MS = 100_000;
const STATS_TIMEOUT_MS = 15_000;
const SUMMARY_TIMEOUT_MS = 10_000;
/** Budget for the whole supercomputer load (historical data + ELO + ρ). */
const MODEL_TIMEOUT_MS = 45_000;
const CONCURRENCY = 8;
const MIN_SIMULATIONS = 1_000;
const MAX_SIMULATIONS = 50_000;
/** Identifier reported to the UI and stored with the prediction. */
export const MODEL_VERSION = "supercomputer-v2";
/** This feature is restricted to the Premier League; every other league is ignored. */
const PREMIER_LEAGUE_SLUG = "eng.1";
/** Canonical label shown on the page and used in diagnostics. */
export const PREMIER_LEAGUE_NAME = "England Premier League";
const NO_PREMIER_LEAGUE_MESSAGE =
  "No England Premier League matches available in the current fixture window.";

export type DataQuality = "Real" | "Mixed" | "Synthetic";
export type ScoreConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface CorrectScoreTeamInputs {
  xg: number | null;
  shots: number | null;
  shotsOnTarget: number | null;
  avgGoalsScored: number | null;
  avgGoalsConceded: number | null;
  /** Average goals scored over matches available before kickoff (up to five). */
  form: number | null;
}

export interface CorrectScoreModelInputs {
  home: CorrectScoreTeamInputs;
  away: CorrectScoreTeamInputs;
  h2hGoalAverage: number | null;
  sources: string[];
  dataQuality: DataQuality;
}

export interface CorrectScoreline {
  score: string;
  homeGoals: number;
  awayGoals: number;
  probability: number;
  impliedOdds: number;
  confidence: ScoreConfidence;
  dataQuality: DataQuality;
  /** Exact Dixon–Coles grid probability, alongside the simulated estimate. */
  analyticProbability?: number;
  /** Monte Carlo occurrences behind `probability`. */
  simulatedCount?: number;
}

export interface CorrectScoreFormGame {
  date: string;
  opponent: string;
  /** As delivered by the summary feed: usually `W`, `D` or `L`. */
  result: string;
  /** Goals for–against for the team in question, e.g. `2-1`. */
  score: string;
  venue: string | null;
  competition: string | null;
}

export interface CorrectScoreTeamForm {
  team: string;
  /** Last five completed matches, most recent first. */
  games: CorrectScoreFormGame[];
  wins: number;
  draws: number;
  losses: number;
  points: number;
  goalsForAverage: number | null;
  goalsAgainstAverage: number | null;
}

export interface CorrectScoreH2hMeeting {
  date: string;
  home: string;
  away: string;
  score: string;
}

/** Pre-match context the detail overlay renders, from the already-fetched summary. */
export interface CorrectScoreContext {
  homeForm: CorrectScoreTeamForm | null;
  awayForm: CorrectScoreTeamForm | null;
  h2h: CorrectScoreH2hMeeting[];
  /** Head-to-head results attributed to this fixture's home side. */
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
  topScorelines: CorrectScoreline[];
  // ── Monte Carlo market probabilities (win–draw–win) ────────────────────────
  /** Simulated probability the home side wins, 0–1. */
  homeWinProbability: number;
  /** Simulated probability the match ends drawn, 0–1. */
  drawProbability: number;
  /** Simulated probability the away side wins, 0–1. */
  awayWinProbability: number;
  /** Top-1 projected scoreline from the same simulation, e.g. `"2-1"`. */
  projectedScoreline: string;
  // ── Supercomputer diagnostics ──────────────────────────────────────────────
  /** Engine identifier, e.g. `supercomputer-v2`. */
  model: string;
  /** Card badge text: `Supercomputer` or `Monte Carlo (10k sims)`. */
  modelBadge: string;
  /** Match week / round the fixture belongs to (from the feed's matchday). */
  matchweek: number | null;
  /** Simulations behind this fixture's scorelines. */
  simulations: number;
  simulationMethod: SimulationMethod;
  /** Dixon–Coles correction applied to the low-score cells. */
  rho: number;
  homeElo: number | null;
  awayElo: number | null;
  /** Home minus away, signed. */
  eloDelta: number | null;
  /** Weight the structural model carried in the final λ (0 = legacy only). */
  structuralWeight: number;
  structuralComponents: ExpectedGoalsComponents | null;
  markets: MonteCarloMarkets | null;
  /** Historical layers that fed the model, for the transparency line. */
  modelSources: string[];
  /** Recent form + head-to-head for the detail overlay; null when unavailable. */
  context: CorrectScoreContext | null;
}

/** The loaded supercomputer state, shared by every fixture in a request. */
export interface SupercomputerModel {
  /** False when no historical source produced any completed match. */
  available: boolean;
  elo: EloTable | null;
  attackDefence: AttackDefenceTable;
  rho: number;
  rhoEstimate: RhoEstimate | null;
  matches: number;
  seasonsCovered: string[];
  primarySource: string | null;
  sources: string[];
  dataset: HistoricalDataset | null;
  generatedAt: string;
}

export interface SupercomputerInputs {
  model: SupercomputerModel;
  simulations: number;
  method: SimulationMethod;
}

interface StandingAverages {
  goalsScored: number;
  goalsConceded: number;
}

interface WeightedValue {
  value: number | null;
  weight: number;
}

interface CacheEntry {
  at: number;
  matches: CorrectScoreMatch[];
  diagnostics?: FeedDiagnostics;
}

const responseCache = new Map<string, CacheEntry>();
const modelCache = new Map<string, { at: number; model: SupercomputerModel }>();

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function namesMatch(left: string, right: string): boolean {
  const a = normaliseName(left);
  const b = normaliseName(right);
  return a === b || (a.length > 4 && b.length > 4 && (a.includes(b) || b.includes(a)));
}

// ─── England Premier League squad allowlist (2026/27) ─────────────────────────

/** Season the allowlist below describes; reported with every response. */
export const PREMIER_LEAGUE_SEASON = "2026/27";

export interface PremierLeagueClub {
  /** Canonical club name, used in logs and diagnostics. */
  name: string;
  /** Extra spellings/short forms a fixture feed may deliver. */
  aliases: readonly string[];
}

/**
 * The 20 England Premier League clubs for 2026/27.
 *
 * The `eng.1` slug on its own is not enough: cup ties, reserve sides and
 * stale-feed rows can arrive stamped with a Premier League slug, and a feed
 * that has not rolled over still carries 2025/26 clubs. So every fixture must
 * name two clubs from this list on top of carrying the slug.
 *
 * Coventry City, Ipswich Town and Hull City were promoted from the Championship.
 * West Ham United, Burnley and Wolverhampton Wanderers were relegated at the end
 * of 2025/26 and are deliberately absent — a fixture naming one is discarded.
 */
export const PREMIER_LEAGUE_CLUBS_2026_27: readonly PremierLeagueClub[] = [
  { name: "Arsenal", aliases: [] },
  { name: "Aston Villa", aliases: ["Villa"] },
  { name: "AFC Bournemouth", aliases: ["Bournemouth"] },
  { name: "Brentford", aliases: [] },
  { name: "Brighton & Hove Albion", aliases: ["Brighton and Hove Albion", "Brighton"] },
  { name: "Chelsea", aliases: [] },
  { name: "Coventry City", aliases: ["Coventry"] },
  { name: "Crystal Palace", aliases: [] },
  { name: "Everton", aliases: [] },
  { name: "Fulham", aliases: [] },
  { name: "Hull City", aliases: ["Hull"] },
  { name: "Ipswich Town", aliases: ["Ipswich"] },
  { name: "Leeds United", aliases: ["Leeds"] },
  { name: "Liverpool", aliases: [] },
  { name: "Manchester City", aliases: ["Man City"] },
  { name: "Manchester United", aliases: ["Man United", "Man Utd"] },
  { name: "Newcastle United", aliases: ["Newcastle"] },
  { name: "Nottingham Forest", aliases: ["Nottingham", "Nottm Forest", "Nott'm Forest"] },
  { name: "Sunderland", aliases: [] },
  { name: "Tottenham Hotspur", aliases: ["Tottenham", "Spurs"] },
];

/** Legal-entity tokens feeds append to a club: "Chelsea FC" → "chelsea". */
const CLUB_SUFFIX_TOKENS = new Set(["fc", "afc", "cf", "sc", "club"]);

/** Broadcast abbreviations expanded before matching: "Newcastle Utd" → "newcastle united". */
const CLUB_TOKEN_ALIASES: Record<string, string> = { utd: "united" };

/** Youth / women / reserve markers — never a senior Premier League fixture. */
const NON_SENIOR_TOKENS = new Set([
  "u17", "u18", "u19", "u20", "u21", "u23", "women", "wfc", "ladies",
  "reserves", "academy", "youth", "xi", "ii",
]);

/**
 * Case-, accent- and punctuation-insensitive club key. "Brighton & Hove
 * Albion", "brighton & hove albion" and "BRIGHTON AND HOVE ALBION" all collapse
 * to `brighton and hove albion`; "AFC Bournemouth FC" collapses to `bournemouth`.
 */
export function normaliseClubKey(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token && !CLUB_SUFFIX_TOKENS.has(token))
    .map((token) => CLUB_TOKEN_ALIASES[token] ?? token)
    .join(" ");
}

/** Normalised alias → canonical club name. */
const CLUB_ALIAS_INDEX: ReadonlyMap<string, string> = (() => {
  const index = new Map<string, string>();
  for (const club of PREMIER_LEAGUE_CLUBS_2026_27) {
    for (const alias of [club.name, ...club.aliases]) {
      const key = normaliseClubKey(alias);
      if (key) index.set(key, club.name);
    }
  }
  return index;
})();

function hasNonSeniorToken(key: string): boolean {
  return key.split(" ").some((token) => NON_SENIOR_TOKENS.has(token));
}

/**
 * Resolve a feed team name to a 2026/27 Premier League club, or `null`.
 *
 * Exact key match covers every documented alias. Multi-word aliases also match
 * at a word boundary ("Ipswich Town Reserves" is still rejected by
 * `NON_SENIOR_TOKENS`), which absorbs decorative prefixes a feed may add.
 * Single-word aliases require an exact match so "Hull" can never swallow a
 * similarly-named lower-league club.
 */
export function matchPremierLeagueClub(teamName: unknown): string | null {
  if (typeof teamName !== "string") return null;
  const key = normaliseClubKey(teamName);
  if (!key) return null;
  const exact = CLUB_ALIAS_INDEX.get(key);
  if (exact) return exact;
  if (hasNonSeniorToken(key)) return null;
  for (const [alias, club] of CLUB_ALIAS_INDEX) {
    if (alias.includes(" ") && (key.startsWith(`${alias} `) || key.endsWith(` ${alias}`))) {
      return club;
    }
  }
  return null;
}

/** True only when both sides of a fixture are 2026/27 Premier League clubs. */
export function isPremierLeagueSquadFixture(
  fixture: Pick<FixtureLite, "home" | "away">,
): boolean {
  return (
    matchPremierLeagueClub((fixture.home as { name?: unknown } | undefined)?.name) !== null &&
    matchPremierLeagueClub((fixture.away as { name?: unknown } | undefined)?.name) !== null
  );
}

export interface SquadFilterResult {
  kept: FixtureLite[];
  /** eng.1 fixtures rejected because a club is not in the 2026/27 squad list. */
  rejected: Array<{ fixture: FixtureLite; home: string; away: string }>;
}

/**
 * Second gate after the league-slug filter: both clubs must be on the 2026/27
 * England Premier League list. Exported so the rule is unit-testable.
 */
export function filterPremierLeagueSquad(fixtures: readonly FixtureLite[]): SquadFilterResult {
  const kept: FixtureLite[] = [];
  const rejected: SquadFilterResult["rejected"] = [];
  for (const fixture of fixtures) {
    if (isPremierLeagueSquadFixture(fixture)) kept.push(fixture);
    else {
      rejected.push({
        fixture,
        home: teamNameOr(fixture.home),
        away: teamNameOr(fixture.away),
      });
    }
  }
  return { kept, rejected };
}

/**
 * Apply the requested missing-field rule: only available values contribute and
 * their original weights are scaled proportionally to sum to one.
 */
export function weightedComposite(values: WeightedValue[]): number | null {
  const available = values.filter(
    (item): item is { value: number; weight: number } =>
      item.value !== null && Number.isFinite(item.value) && item.value >= 0 && item.weight > 0,
  );
  const weight = available.reduce((sum, item) => sum + item.weight, 0);
  if (weight <= 0) return null;
  return available.reduce((sum, item) => sum + item.value * item.weight, 0) / weight;
}

/** The exact weighted expected-goals formula from the feature specification. */
export function calculateExpectedGoals(inputs: CorrectScoreModelInputs): {
  homeExpectedGoals: number;
  awayExpectedGoals: number;
} {
  const home = weightedComposite([
    { value: inputs.home.xg, weight: 0.4 },
    { value: inputs.home.avgGoalsScored, weight: 0.25 },
    { value: inputs.away.avgGoalsConceded, weight: 0.2 },
    { value: inputs.home.form, weight: 0.1 },
    { value: 1.1, weight: 0.05 },
  ]);
  const away = weightedComposite([
    { value: inputs.away.xg, weight: 0.4 },
    { value: inputs.away.avgGoalsScored, weight: 0.25 },
    { value: inputs.home.avgGoalsConceded, weight: 0.2 },
    { value: inputs.away.form, weight: 0.1 },
    { value: 0.9, weight: 0.05 },
  ]);

  // Advantage is always present, so these guards are defensive rather than a
  // silent data fallback. A small floor keeps λ valid for Poisson arithmetic.
  return {
    homeExpectedGoals: Math.max(0.05, home ?? 1.1),
    awayExpectedGoals: Math.max(0.05, away ?? 0.9),
  };
}

export function confidenceForProbability(probability: number): ScoreConfidence {
  if (probability > 0.15) return "HIGH";
  if (probability > 0.08) return "MEDIUM";
  return "LOW";
}

/**
 * Legacy independent-Poisson score grid, sorted from most to least probable.
 * Kept exported: it is the baseline the backtest measures the upgrade against.
 */
export function scorelineProbabilities(
  homeExpectedGoals: number,
  awayExpectedGoals: number,
  maxGoals = DEFAULT_MAX_GOALS,
  dataQuality: DataQuality = "Synthetic",
): CorrectScoreline[] {
  const scores: CorrectScoreline[] = [];
  for (let homeGoals = 0; homeGoals <= maxGoals; homeGoals++) {
    const homeProbability = poissonPmf(homeGoals, homeExpectedGoals);
    for (let awayGoals = 0; awayGoals <= maxGoals; awayGoals++) {
      const probability = homeProbability * poissonPmf(awayGoals, awayExpectedGoals);
      scores.push({
        score: `${homeGoals}-${awayGoals}`,
        homeGoals,
        awayGoals,
        probability: round(probability, 6),
        impliedOdds: round(1 / Math.max(probability, Number.EPSILON), 2),
        confidence: confidenceForProbability(probability),
        dataQuality,
      });
    }
  }
  return scores.sort((left, right) =>
    right.probability - left.probability ||
    left.homeGoals + left.awayGoals - (right.homeGoals + right.awayGoals) ||
    left.homeGoals - right.homeGoals,
  );
}

// ─── Supercomputer model ──────────────────────────────────────────────────────

/**
 * Neutral model used when no historical source produced data. The attack/defence
 * table built from zero matches falls back to the documented league baseline and
 * every team resolves to strength 1.0, so the route degrades to the legacy λ
 * instead of failing.
 */
function unavailableModel(reason: string): SupercomputerModel {
  return {
    available: false,
    elo: null,
    attackDefence: buildAttackDefenceTable([], PREMIER_LEAGUE_SLUG),
    // Prefer a still-valid cached estimate over silently reverting to the
    // league default: one failed fetch should not change the published model.
    rho: getRhoForLeague(PREMIER_LEAGUE_SLUG),
    rhoEstimate: null,
    matches: 0,
    seasonsCovered: [],
    primarySource: null,
    sources: [reason],
    dataset: null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Load the historical dataset and derive ELO, attack/defence and ρ from it.
 *
 * ρ is estimated against the attack/defence λ's (ELO excluded — ρ only touches
 * the four low-score cells and is a single global parameter per league). This
 * is in-sample for ρ, which is the standard treatment: it is one scalar fitted
 * on the same history every other parameter comes from, and the backtest
 * re-estimates it per fixture from strictly pre-kickoff data.
 */
export async function loadSupercomputerModel(
  leagueSlug: string,
  options: { force?: boolean; seasons?: number; timeoutMs?: number } = {},
): Promise<SupercomputerModel> {
  const cached = modelCache.get(leagueSlug);
  if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.model;

  const timeoutMs = options.timeoutMs ?? MODEL_TIMEOUT_MS;
  let dataset: HistoricalDataset;
  try {
    dataset = await withTimeout(
      loadHistoricalMatches({
        leagueSlug,
        seasons: options.seasons ?? DEFAULT_SEASONS,
        force: options.force,
      }),
      timeoutMs,
      null,
    ).then((result) => {
      if (result) return result;
      throw new Error(`historical load exceeded ${timeoutMs}ms`);
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[CorrectScore] supercomputer model unavailable for ${leagueSlug}: ${reason}`);
    return unavailableModel(`historical data unavailable (${reason})`);
  }

  if (!dataset.matchCount) {
    const reasons = dataset.sources
      .map((source) => `${source.source}: ${source.note || "no matches"}`)
      .join("; ");
    console.warn(`[CorrectScore] no historical matches for ${leagueSlug} — ${reasons}`);
    return unavailableModel(`no completed matches found (${reasons})`);
  }

  // Supplement with engsoccerdata when the primary sources are too thin for
  // meaningful ELO ratings. This ensures promoted sides (Coventry, Hull,
  // Ipswich) carry real ratings from their Championship seasons.
  let allMatches = dataset.matches;
  const MIN_USEFUL = 100;
  if (dataset.matchCount < MIN_USEFUL) {
    try {
      const now = new Date();
      const seasonList = seasonCodes(now, (options.seasons ?? DEFAULT_SEASONS) + 1);
      console.info(
        `[CorrectScore] Historical dataset thin (${dataset.matchCount}), supplementing from engsoccerdata...`,
      );
      const engData = await loadMatchesFromEngSoccerData({ seasons: seasonList, maxTier: 2 });
      if (engData.matches.length > 0) {
        const seen = new Set(allMatches.map((m) => m.id));
        const extra = engData.matches.filter((m) => !seen.has(m.id));
        if (extra.length > 0) {
          allMatches = [...allMatches, ...extra].sort(
            (a, b) => new Date(a.matchDate).getTime() - new Date(b.matchDate).getTime(),
          );
          console.info(
            `[CorrectScore] engsoccerdata: merged ${extra.length} additional matches (total ${allMatches.length})`,
          );
        }
      }
    } catch (error) {
      console.warn(
        `[CorrectScore] engsoccerdata supplement failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const elo = buildEloRatings(allMatches);
  // Exponential time decay (Dixon & Coles' ξ): last season's results carry
  // more weight than a match from two seasons ago, so promoted sides and
  // rebuilt squads are not averaged away over three years.
  const attackDefence = buildAttackDefenceTable(allMatches, leagueSlug, {
    halfLifeDays: ATTACK_DEFENCE_HALF_LIFE_DAYS,
    now: new Date(),
  });
  const rhoEstimate = estimateLeagueRho(leagueSlug, allMatches, (match) => {
    const expected = computeMatchExpectedGoals({
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      table: attackDefence,
      applyElo: false,
    });
    return {
      homeLambda: expected.homeExpectedGoals,
      awayLambda: expected.awayExpectedGoals,
    };
  });

  const model: SupercomputerModel = {
    available: true,
    elo,
    attackDefence,
    rho: rhoEstimate.rho,
    rhoEstimate,
    matches: allMatches.length,
    seasonsCovered: dataset.seasonsCovered,
    primarySource: dataset.primarySource,
    sources: [
      ...new Set(
        dataset.sources
          .filter((source) => source.added > 0)
          .map((source) => `${source.source} (${source.added})`),
      ),
      ...(allMatches.length > dataset.matchCount
        ? [`engsoccerdata (${allMatches.length - dataset.matchCount})`]
        : []),
    ],
    dataset,
    generatedAt: dataset.generatedAt,
  };

  modelCache.set(leagueSlug, { at: Date.now(), model });
  console.info(
    `[CorrectScore] supercomputer ${leagueSlug}: ${model.matches} matches across ` +
      `${model.seasonsCovered.join(", ") || "n/a"} | ρ=${model.rho} | ` +
      `${elo.global.size} rated teams | sources ${model.sources.join(", ")}`,
  );
  return model;
}

/** Badge text for a fixture: supercomputer when the structural model drove λ. */
export function modelBadgeFor(model: SupercomputerModel | null, simulations: number): string {
  if (model?.available) return "Supercomputer";
  return `Monte Carlo (${Math.round(simulations / 1000)}k sims)`;
}

// ─── Expected goals ───────────────────────────────────────────────────────────

export interface ResolvedExpectedGoals {
  homeExpectedGoals: number;
  awayExpectedGoals: number;
  structuralHome: number;
  structuralAway: number;
  legacyHome: number;
  legacyAway: number;
  structuralWeight: number;
  homeElo: number | null;
  awayElo: number | null;
  eloDelta: number | null;
  components: ExpectedGoalsComponents | null;
}

/**
 * How much of λ comes from the structural model, given what the legacy
 * composite actually has to offer.
 *
 * The only legacy field the structural model cannot reproduce is pre-match xG:
 * season scoring, goals conceded and recent form are all strict subsets of the
 * venue-split attack/defence parameters, which are built from the same results
 * but split by venue. So the legacy composite keeps 40% of the weight when
 * both teams carry real xG, and only 20% when it is running on season averages
 * alone — otherwise the upgrade would spend 40% of λ re-deriving information it
 * already has, in a cruder form.
 */
export function structuralWeightFor(inputs: CorrectScoreModelInputs): number {
  if (inputs.dataQuality === "Synthetic") return 1;
  const xgAvailable = inputs.home.xg !== null && inputs.away.xg !== null;
  return xgAvailable ? STRUCTURAL_MODEL_WEIGHT : STRUCTURAL_WEIGHT_WITHOUT_XG;
}

/**
 * Final λ for one fixture.
 *
 * Weighting policy (see `structuralWeightFor`):
 *   · historical model available → `structuralWeightFor(inputs)` on the
 *     structural λ, the remainder on the legacy composite;
 *   · no historical model at all → 0.0 structural, i.e. the pre-upgrade model.
 */
export interface ExpectedGoalsOverrides {
  /** Override `structuralWeightFor` (used by the backtest for ablation). */
  structuralWeight?: number;
  /** Override `ELO_GOAL_ELASTICITY`. */
  eloElasticity?: number;
}

export function resolveExpectedGoals(
  fixture: Pick<FixtureLite, "home" | "away" | "leagueSlug">,
  inputs: CorrectScoreModelInputs,
  model: SupercomputerModel | null,
  overrides: ExpectedGoalsOverrides = {},
): ResolvedExpectedGoals {
  const legacy = calculateExpectedGoals(inputs);
  if (!model?.available) {
    return {
      homeExpectedGoals: legacy.homeExpectedGoals,
      awayExpectedGoals: legacy.awayExpectedGoals,
      structuralHome: legacy.homeExpectedGoals,
      structuralAway: legacy.awayExpectedGoals,
      legacyHome: legacy.homeExpectedGoals,
      legacyAway: legacy.awayExpectedGoals,
      structuralWeight: 0,
      homeElo: null,
      awayElo: null,
      eloDelta: null,
      components: null,
    };
  }

  const homeElo = model.elo ? getElo(fixture.home.name, fixture.leagueSlug, model.elo) : null;
  const awayElo = model.elo ? getElo(fixture.away.name, fixture.leagueSlug, model.elo) : null;
  const structural = computeMatchExpectedGoals({
    homeTeam: fixture.home.name,
    awayTeam: fixture.away.name,
    table: model.attackDefence,
    eloHome: homeElo,
    eloAway: awayElo,
    eloElasticity: overrides.eloElasticity,
  });
  const structuralWeight = overrides.structuralWeight ?? structuralWeightFor(inputs);

  return {
    homeExpectedGoals: blendExpectedGoals(structural.homeExpectedGoals, legacy.homeExpectedGoals, structuralWeight),
    awayExpectedGoals: blendExpectedGoals(structural.awayExpectedGoals, legacy.awayExpectedGoals, structuralWeight),
    structuralHome: structural.homeExpectedGoals,
    structuralAway: structural.awayExpectedGoals,
    legacyHome: legacy.homeExpectedGoals,
    legacyAway: legacy.awayExpectedGoals,
    structuralWeight,
    homeElo,
    awayElo,
    eloDelta: homeElo !== null && awayElo !== null ? homeElo - awayElo : null,
    components: structural.components,
  };
}

/** Build one public prediction. Exported so the backtest reruns this same model. */
export function buildCorrectScorePrediction(
  fixture: Pick<FixtureLite, "id" | "home" | "away" | "leagueName" | "leagueSlug" | "date" | "venue">,
  inputs: CorrectScoreModelInputs,
  maxGoals = DEFAULT_MAX_GOALS,
  supercomputer: SupercomputerInputs | null = null,
  context: CorrectScoreContext | null = null,
  matchweek: number | null = null,
): CorrectScoreMatch {
  const model = supercomputer?.model ?? null;
  const simulations = supercomputer?.simulations ?? DEFAULT_SIMULATIONS;
  const method: SimulationMethod = supercomputer?.method ?? "stratified";
  const expected = resolveExpectedGoals(fixture, inputs, model);
  // Without a live model, fall back to whatever ρ is cached for the league —
  // `getRhoForLeague` returns `DEFAULT_RHO` when nothing has been estimated.
  const rho = model?.available ? model.rho : getRhoForLeague(fixture.leagueSlug);

  // The Monte Carlo layer runs even without the historical model: it still
  // samples the corrected distribution, so the badge tells the two apart.
  const simulation = simulateMatch({
    homeLambda: expected.homeExpectedGoals,
    awayLambda: expected.awayExpectedGoals,
    rho,
    options: { simulations, maxGoals, method, topScorelines: TOP_SCORELINES },
  });

  const topScorelines: CorrectScoreline[] = simulation.topScorelines.map((scoreline) => ({
    score: scoreline.score,
    homeGoals: scoreline.homeGoals,
    awayGoals: scoreline.awayGoals,
    probability: scoreline.probability,
    impliedOdds: scoreline.impliedOdds,
    confidence: confidenceForProbability(scoreline.probability),
    dataQuality: inputs.dataQuality,
    analyticProbability: scoreline.analyticProbability,
    simulatedCount: scoreline.count,
  }));

  return {
    fixtureId: fixture.id,
    homeTeam: fixture.home.name,
    awayTeam: fixture.away.name,
    homeLogo: fixture.home.logo,
    awayLogo: fixture.away.logo,
    league: fixture.leagueName,
    leagueSlug: fixture.leagueSlug,
    date: fixture.date,
    venue: fixture.venue,
    homeExpectedGoals: round(expected.homeExpectedGoals, 3),
    awayExpectedGoals: round(expected.awayExpectedGoals, 3),
    h2hGoalAverage: inputs.h2hGoalAverage === null ? null : round(inputs.h2hGoalAverage, 2),
    dataQuality: inputs.dataQuality,
    statsSources: inputs.sources,
    topScorelines,
    homeWinProbability: round(simulation.markets.homeWin, 4),
    drawProbability: round(simulation.markets.draw, 4),
    awayWinProbability: round(simulation.markets.awayWin, 4),
    projectedScoreline: simulation.topScorelines[0]?.score ?? "0-0",
    model: MODEL_VERSION,
    modelBadge: modelBadgeFor(model, simulations),
    simulations: simulation.simulations,
    simulationMethod: simulation.method,
    rho,
    homeElo: expected.homeElo === null ? null : round(expected.homeElo, 0),
    awayElo: expected.awayElo === null ? null : round(expected.awayElo, 0),
    eloDelta: expected.eloDelta === null ? null : round(expected.eloDelta, 0),
    structuralWeight: expected.structuralWeight,
    structuralComponents: expected.components,
    markets: simulation.markets,
    modelSources: model?.sources ?? [],
    context,
    matchweek,
  };
}

// ─── Match week / round attribution ───────────────────────────────────────────

/**
 * Parse a round label the fixture feed can ship into a match week number.
 *
 * openfootball delivers "Matchday N" on every row (the value the feature
 * spec calls the matchday), while other providers use "Matchweek N",
 * "Round N", "Matchday N" or a local-language equivalent (Jornada, Journée,
 * Spieltag). Returns `null` when the label carries no number, so the caller
 * can fall back to a date-derived week.
 */
export function parseMatchweekLabel(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(
    /(?:matchday|matchweek|round|md|mday|jornada|journ[ée]e|spieltag|round robin)\s*(\d+)/i,
  );
  if (!match) return null;
  const week = Number(match[1]);
  return Number.isFinite(week) && week > 0 ? week : null;
}

/** Gap (ms) after which two fixtures belong to different match weeks. */
const MATCHWEEK_GAP_MS = 3 * 86_400_000;

/**
 * Attribute a match week to every fixture.
 *
 * Prefers the provider's own round label (openfootball ships "Matchday N" in
 * `statusDetail`). For feeds with no round label — an ESPN-only fixture list —
 * it derives a synthetic week by clustering kickoffs within a few days of
 * each other, so the match-week chips and the `?matchweek=` filter still work.
 */
function assignMatchweeks(fixtures: FixtureLite[]): Map<string, number> {
  const weekById = new Map<string, number>();
  const sorted = [...fixtures].sort(
    (left, right) => new Date(left.date).getTime() - new Date(right.date).getTime(),
  );

  // Pass 1 — explicit round labels.
  let maxParsed = 0;
  for (const fixture of sorted) {
    const week = parseMatchweekLabel(fixture.statusDetail);
    if (week !== null) {
      weekById.set(fixture.id, week);
      if (week > maxParsed) maxParsed = week;
    }
  }

  // Pass 2 — chronological clustering for the unlabelled remainder.
  let nextSynthetic = maxParsed + 1;
  let clusterWeek: number | null = null;
  let clusterHead = 0;

  for (const fixture of sorted) {
    if (weekById.has(fixture.id)) continue;
    const kickoff = new Date(fixture.date).getTime();
    if (!Number.isFinite(kickoff)) {
      weekById.set(fixture.id, nextSynthetic++);
      continue;
    }
    if (clusterHead === 0 || kickoff - clusterHead > MATCHWEEK_GAP_MS) {
      clusterWeek = nextSynthetic++;
      clusterHead = kickoff;
    }
    weekById.set(fixture.id, clusterWeek!);
  }

  return weekById;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const result: Array<R | undefined> = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      result[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, worker));
  return result as R[];
}

/** Placeholder identities a degraded feed can emit instead of a real club. */
const UNRESOLVED_TEAM_NAMES = new Set([
  "", "unknown", "tbd", "n/a", "none", "null", "undefined",
]);

function teamNameOr(team: { name?: unknown } | null | undefined): string {
  const raw: unknown = team?.name;
  return typeof raw === "string" && raw.trim() ? raw.trim() : "null";
}

/**
 * True when both sides of a fixture carry a real, displayable club identity.
 *
 * Degraded feeds occasionally deliver rows without one: ESPN's normaliser
 * falls back to "Unknown" when a competitor has no `team.displayName`, and
 * fallback widgets can emit partial rows. Predicting those is fabrication —
 * every standings / form / aggregator lookup fails for an anonymous club, so
 * each such fixture collapses onto the same league-anchor synthetic inputs
 * and the page fills with "Unknown vs Unknown" cards all showing an identical
 * 1-1. They are dropped (and logged) instead.
 */
export function hasResolvableTeams(
  fixture: Pick<FixtureLite, "home" | "away">,
): boolean {
  for (const team of [fixture.home, fixture.away] as Array<{ name?: unknown } | undefined>) {
    const raw: unknown = team?.name;
    const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (UNRESOLVED_TEAM_NAMES.has(name)) return false;
  }
  return true;
}

/** Why the feed produced the match list it did — reported on empty responses. */
export interface FeedDiagnostics {
  /** Rows the fixture feed delivered for the lookahead window. */
  feedFixtures: number;
  /** Rows that are upcoming, unique and kick off inside the 7-day horizon. */
  inWindow: number;
  /** In-window rows dropped for missing team identity. */
  unresolvedTeams: number;
  /** In-window rows dropped for not being eng.1, keyed by league slug. */
  nonPremierLeague: Record<string, number>;
  /** Fixtures scanned before any filtering (equals `inWindow`). */
  totalFixturesScanned: number;
  /** Fixtures dropped because `leagueSlug` did not canonicalise to `eng.1`. */
  filteredByLeague: number;
  /** eng.1 fixtures dropped because a club is not in the 2026/27 squad list. */
  filteredByTeamList: number;
  /** `"{home} vs {away}"` for every squad-list rejection, for quick triage. */
  rejectedTeams: string[];
  /** Season the squad allowlist describes. */
  season: string;
}

export interface FixtureSelection {
  premierLeague: FixtureLite[];
  /** In-window fixtures dropped because a team name was missing/placeholder. */
  anonymous: FixtureLite[];
  /** Non-PL fixtures dropped, counted per canonical league slug. */
  skippedNonPl: Map<string, number>;
  /** The same dropped rows, so each one can be logged by name. */
  skippedNonPlFixtures: FixtureLite[];
  /** Fixtures that passed the state/window/dedupe filter, before league selection. */
  inWindowCount: number;
  diagnostics: FeedDiagnostics;
}

/**
 * Narrow the fixture feed down to the Premier League matches this feature
 * predicts. Pure and exported so the selection rules are unit-testable:
 *
 *   1. only `pre` fixtures, deduped by id, kicking off within the lookahead;
 *   2. team identity must be resolvable on both sides (`hasResolvableTeams`);
 *   3. league slug must canonicalise to `eng.1` — aliases included, so a feed
 *      row can never slip through (or be dropped) on a slug spelling alone.
 *
 * The 2026/27 squad allowlist is applied on top of this by
 * `filterPremierLeagueSquad`, keeping each rule independently testable.
 */
export function selectPremierLeagueFixtures(
  upcoming: FixtureLite[],
  now: number = Date.now(),
): FixtureSelection {
  const horizon = now + LOOKAHEAD_DAYS * 86_400_000;
  const seen = new Set<string>();
  const inWindow = (Array.isArray(upcoming) ? upcoming : []).filter((fixture) => {
    if (!fixture || fixture.state !== "pre" || typeof fixture.id !== "string") return false;
    if (seen.has(fixture.id)) return false;
    const kickoff = new Date(fixture.date).getTime();
    if (!Number.isFinite(kickoff) || kickoff < now || kickoff > horizon) return false;
    seen.add(fixture.id);
    return true;
  });

  const anonymous: FixtureLite[] = [];
  const premierLeague: FixtureLite[] = [];
  const skippedNonPl = new Map<string, number>();
  const skippedNonPlFixtures: FixtureLite[] = [];
  for (const fixture of inWindow) {
    if (!hasResolvableTeams(fixture)) {
      anonymous.push(fixture);
      continue;
    }
    const slug = canonicalLeagueSlug(typeof fixture.leagueSlug === "string" ? fixture.leagueSlug : "");
    if (slug !== PREMIER_LEAGUE_SLUG) {
      skippedNonPl.set(slug || "unknown", (skippedNonPl.get(slug || "unknown") ?? 0) + 1);
      skippedNonPlFixtures.push(
        fixture.leagueSlug === slug ? fixture : { ...fixture, leagueSlug: slug },
      );
      continue;
    }
    // Stamp the canonical slug so downstream ESPN lookups (standings,
    // summary) run on exactly the competition id the filter matched.
    premierLeague.push(
      fixture.leagueSlug === slug ? fixture : { ...fixture, leagueSlug: slug },
    );
  }
  premierLeague.sort(
    (left, right) => new Date(left.date).getTime() - new Date(right.date).getTime(),
  );

  return {
    premierLeague,
    anonymous,
    skippedNonPl,
    skippedNonPlFixtures,
    inWindowCount: inWindow.length,
    diagnostics: {
      feedFixtures: Array.isArray(upcoming) ? upcoming.length : 0,
      inWindow: inWindow.length,
      unresolvedTeams: anonymous.length,
      nonPremierLeague: Object.fromEntries(skippedNonPl),
      totalFixturesScanned: inWindow.length,
      filteredByLeague: skippedNonPlFixtures.length,
      // Filled in by the squad gate in `fetchUpcomingFixtures`.
      filteredByTeamList: 0,
      rejectedTeams: [],
      season: PREMIER_LEAGUE_SEASON,
    },
  };
}

export interface PremierLeagueFeed {
  /** eng.1 fixtures whose two clubs are both on the 2026/27 squad list. */
  fixtures: FixtureLite[];
  diagnostics: FeedDiagnostics;
}

async function fetchUpcomingFixtures(requestUrl: string): Promise<PremierLeagueFeed> {
  const origin = new URL(requestUrl).origin;
  const response = await withTimeout(
    fetch(`${origin}/api/fixtures?days=${LOOKAHEAD_DAYS}&stats=0`, { cache: "no-store" }),
    FEED_TIMEOUT_MS,
    null,
  );
  if (!response?.ok) {
    throw new Error(response ? `Fixture feed HTTP ${response.status}` : "Fixture feed timed out");
  }
  const body = (await response.json()) as {
    upcoming?: FixtureLite[];
    fixtures?: FixtureLite[];
  };
  // The all-competitions feed splits rows into `upcoming`/`results`, with
  // `fixtures` carrying the concatenation. Accept either so a feed-shape
  // change degrades into filtering rather than a silently empty page.
  const selection = selectPremierLeagueFixtures(body.upcoming ?? body.fixtures ?? []);

  // Gate 2 — the 2026/27 squad allowlist. A row can carry `eng.1` and still
  // name a club that is not in the division this season (a relegated side from
  // a feed that has not rolled over, a cup or reserve row), so both clubs are
  // checked by name on top of the slug.
  const squad = filterPremierLeagueSquad(selection.premierLeague);

  // Diagnostics: the troubleshooting playbook greps for exactly these lines
  // ("Processing eng.1:", "Discarded non-EPL fixture:", "Discarded eng.1
  // fixture with unknown team:") to tell the feed failure modes apart — no
  // eng.1 in the feed, eng.1 filtered out on the slug, eng.1 rows outside the
  // squad list, feed rows without team names, or a completely empty feed.
  for (const fixture of selection.anonymous) {
    console.warn(
      `[CorrectScore] Skipping fixture with unresolved team names: ${fixture.id} ` +
        `(${fixture.leagueSlug}, ${fixture.date}) — home=${teamNameOr(fixture.home)}, away=${teamNameOr(fixture.away)}`,
    );
  }
  for (const fixture of selection.skippedNonPlFixtures) {
    console.info(
      `[CorrectScore] Discarded non-EPL fixture: ${teamNameOr(fixture.home)} vs ` +
        `${teamNameOr(fixture.away)} (league: ${fixture.leagueSlug || "unknown"})`,
    );
  }
  for (const [slug, count] of selection.skippedNonPl) {
    console.info(`[CorrectScore] Skipping non-PL fixture: ${count} × ${slug}`);
  }
  for (const rejection of squad.rejected) {
    console.warn(
      `[CorrectScore] Discarded eng.1 fixture with unknown team: ${rejection.home} vs ${rejection.away}`,
    );
  }
  const dropped = selection.inWindowCount - squad.kept.length;
  if (dropped > 0) {
    console.info(
      `[CorrectScore] England Premier League ${PREMIER_LEAGUE_SEASON} only: kept ${squad.kept.length} ` +
        `of ${selection.inWindowCount} in-window fixture(s) for ${PREMIER_LEAGUE_SLUG} ` +
        `(${selection.skippedNonPlFixtures.length} filtered by league, ` +
        `${squad.rejected.length} filtered by team list)`,
    );
  }
  for (const fixture of squad.kept) {
    console.info(
      `[CorrectScore] Processing eng.1: ${teamNameOr(fixture.home)} vs ${teamNameOr(fixture.away)}`,
    );
  }
  if (!squad.kept.length) {
    console.info(
      `[CorrectScore] Processing eng.1: 0 fixture(s) — no ${PREMIER_LEAGUE_SEASON} ` +
        `${PREMIER_LEAGUE_NAME} match with resolvable team names reached the model`,
    );
  }

  return {
    fixtures: squad.kept,
    diagnostics: {
      ...selection.diagnostics,
      filteredByTeamList: squad.rejected.length,
      rejectedTeams: squad.rejected.map(({ home, away }) => `${home} vs ${away}`),
    },
  };
}

/** Diagnostics for a request that never reached the fixture feed. */
function emptyDiagnostics(): FeedDiagnostics {
  return {
    feedFixtures: 0,
    inWindow: 0,
    unresolvedTeams: 0,
    nonPremierLeague: {},
    totalFixturesScanned: 0,
    filteredByLeague: 0,
    filteredByTeamList: 0,
    rejectedTeams: [],
    season: PREMIER_LEAGUE_SEASON,
  };
}

export interface CorrectScoreFeedResponse {
  matches: CorrectScoreMatch[];
  /** Every match week that carries at least one fixture, sorted ascending. */
  availableMatchweeks: number[];
  /** The match week of the earliest fixture in the feed (the current round). */
  currentMatchweek: number | null;
  /** The match week this response was filtered to (defaults to current). */
  selectedMatchweek: number | null;
  /** Human-readable note for empty responses (no fixtures / future week). */
  message?: string;
  diagnostics?: FeedDiagnostics;
}

/**
 * Build the feed response. When `requestedWeek` is non-null the feed is
 * reduced to that match week (possibly empty for a future or unknown week);
 * otherwise it returns every fixture and defaults `selectedMatchweek` to the
 * current match week so the UI can pre-highlight the active chip.
 */
function feedResponse(
  allMatches: CorrectScoreMatch[],
  requestedWeek: number | null,
  currentMatchweek: number | null,
  cacheStatus: "HIT" | "MISS",
  diagnostics?: FeedDiagnostics,
): Response {
  const headers = { "Cache-Control": "no-store", "X-Correct-Score-Cache": cacheStatus };
  const availableMatchweeks = [
    ...new Set(
      allMatches
        .map((match) => match.matchweek)
        .filter((week): week is number => typeof week === "number"),
    ),
  ].sort((left, right) => left - right);

  const selectedMatchweek = requestedWeek ?? currentMatchweek;
  const matches =
    requestedWeek !== null ? allMatches.filter((match) => match.matchweek === requestedWeek) : allMatches;

  const body: CorrectScoreFeedResponse = {
    matches,
    availableMatchweeks,
    currentMatchweek,
    selectedMatchweek,
  };

  if (!matches.length) {
    if (requestedWeek !== null) {
      body.message =
        currentMatchweek !== null && requestedWeek > currentMatchweek
          ? `Fixtures for Matchweek ${requestedWeek} will be available closer to the match date.`
          : `No fixtures available for Matchweek ${requestedWeek}.`;
    } else {
      body.message = NO_PREMIER_LEAGUE_MESSAGE;
    }
    body.diagnostics = diagnostics ?? emptyDiagnostics();
  }

  return Response.json(body, { headers });
}

async function fetchCanonicalStats(
  fixture: FixtureLite,
  force: boolean,
): Promise<CanonicalMatchStats | null> {
  const query = {
    leagueSlug: fixture.leagueSlug,
    eventId: fixture.id,
    homeTeam: fixture.home.name,
    awayTeam: fixture.away.name,
    date: fixture.date,
    // Upcoming match: per-match stats do not exist yet — keyed sources use
    // historical team stats (season averages) for the prediction.
    state: fixture.state,
  };
  return withTimeout(
    statsAggregator.fetch(query, { force }).catch(() => null),
    STATS_TIMEOUT_MS,
    null,
  );
}

function formAverage(summary: MatchSummary | null, side: "home" | "away"): number | null {
  const form = side === "home" ? summary?.homeForm : summary?.awayForm;
  if (!form?.games.length) return null;
  // Defensive cutoff: even if an upstream summary changes after the match, no
  // game on/after the target fixture is accepted by historical callers.
  return finiteNonNegative(form.gfAvg);
}

function h2hAverage(summary: MatchSummary | null): number | null {
  const totals = (summary?.h2h ?? [])
    .map((meeting) => meeting.score.split(/\s*-\s*/).map(Number))
    .filter((score) => score.length === 2 && score.every(Number.isFinite))
    .map(([home, away]) => home + away);
  return totals.length ? totals.reduce((sum, value) => sum + value, 0) / totals.length : null;
}

/** Parse season GF/GA per match from the existing ESPN standings source. */
async function fetchStandingAverages(leagueSlug: string): Promise<Map<string, StandingAverages>> {
  interface EspnStanding {
    team?: { displayName?: string; name?: string };
    stats?: Array<{ name?: string; abbreviation?: string; value?: number; displayValue?: string }>;
  }
  interface EspnStandings {
    children?: Array<{ standings?: { entries?: EspnStanding[] }; entries?: EspnStanding[] }>;
    standings?: { entries?: EspnStanding[] };
  }

  try {
    const response = await withTimeout(
      fetch(`https://site.api.espn.com/apis/v2/sports/soccer/${leagueSlug}/standings`, {
        next: { revalidate: 600 },
      }),
      SUMMARY_TIMEOUT_MS,
      null,
    );
    if (!response?.ok) return new Map();
    const data = (await response.json()) as EspnStandings;
    const groups = data.children ?? (data.standings ? [{ standings: data.standings }] : []);
    const output = new Map<string, StandingAverages>();
    for (const group of groups) {
      for (const row of group.standings?.entries ?? group.entries ?? []) {
        const name = row.team?.displayName ?? row.team?.name;
        if (!name) continue;
        const stats = new Map<string, number>();
        for (const stat of row.stats ?? []) {
          const value = finiteNonNegative(stat.value ?? Number(stat.displayValue));
          if (value === null) continue;
          if (stat.name) stats.set(stat.name.toLowerCase(), value);
          if (stat.abbreviation) stats.set(stat.abbreviation.toLowerCase(), value);
        }
        const played = stats.get("gamesplayed") ?? stats.get("gp") ?? 0;
        const scored = stats.get("pointsfor") ?? stats.get("gf") ?? stats.get("goals") ?? null;
        const conceded = stats.get("pointsagainst") ?? stats.get("ga") ?? null;
        if (played > 0 && scored !== null && conceded !== null) {
          output.set(normaliseName(name), {
            goalsScored: scored / played,
            goalsConceded: conceded / played,
          });
        }
      }
    }
    return output;
  } catch {
    return new Map();
  }
}

function findStanding(
  rows: Map<string, StandingAverages>,
  teamName: string,
): StandingAverages | null {
  const direct = rows.get(normaliseName(teamName));
  if (direct) return direct;
  for (const [name, value] of rows) {
    if (namesMatch(name, teamName)) return value;
  }
  return null;
}

function qualityForInputs(home: CorrectScoreTeamInputs, away: CorrectScoreTeamInputs): DataQuality {
  const core = [
    home.xg,
    home.avgGoalsScored,
    home.avgGoalsConceded,
    home.form,
    away.xg,
    away.avgGoalsScored,
    away.avgGoalsConceded,
    away.form,
  ];
  const real = core.filter((value) => value !== null).length;
  if (real === core.length) return "Real";
  if (real > 0) return "Mixed";
  return "Synthetic";
}

function syntheticInputs(leagueSlug: string): Pick<CorrectScoreModelInputs, "home" | "away"> {
  const anchors = getAnchors(leagueSlug);
  const homeGoals = anchors.avgGoals * anchors.homePossession;
  const awayGoals = anchors.avgGoals * (1 - anchors.homePossession);
  return {
    home: {
      xg: homeGoals,
      shots: anchors.avgShots * anchors.homePossession,
      shotsOnTarget: anchors.avgSot * anchors.homePossession,
      avgGoalsScored: homeGoals,
      avgGoalsConceded: awayGoals,
      form: homeGoals,
    },
    away: {
      xg: awayGoals,
      shots: anchors.avgShots * (1 - anchors.homePossession),
      shotsOnTarget: anchors.avgSot * (1 - anchors.homePossession),
      avgGoalsScored: awayGoals,
      avgGoalsConceded: homeGoals,
      form: awayGoals,
    },
  };
}

/** Recent form for one side, read off the ESPN summary already fetched for λ. */
function teamFormContext(teamName: string, form: TeamForm | null): CorrectScoreTeamForm | null {
  const games = (form?.games ?? []).slice(0, 5);
  if (!games.length) return null;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  for (const game of games) {
    const result = String(game.result ?? "").trim().toUpperCase();
    if (result === "W") wins += 1;
    else if (result === "L") losses += 1;
    else draws += 1;
  }
  return {
    team: form?.teamName || teamName,
    games: games.map((game) => ({
      date: game.date,
      opponent: game.opponent,
      result: String(game.result ?? "").trim().toUpperCase() || "D",
      score: `${game.scoreFor}-${game.scoreAgainst}`,
      venue: game.atVs || null,
      competition: game.competition || null,
    })),
    wins,
    draws,
    losses,
    points: form?.points ?? wins * 3 + draws,
    goalsForAverage: finiteNonNegative(form?.gfAvg),
    goalsAgainstAverage: finiteNonNegative(form?.gaAvg),
  };
}

/**
 * Form and head-to-head context for the detail overlay.
 *
 * Reuses the summary `collectInputs` already fetches — no extra network call —
 * and returns `null` when the feed has nothing, so the overlay can hide the
 * section instead of inventing it.
 */
function buildMatchContext(
  summary: MatchSummary | null,
  homeTeam: string,
  awayTeam: string,
): CorrectScoreContext | null {
  const homeForm = teamFormContext(homeTeam, summary?.homeForm ?? null);
  const awayForm = teamFormContext(awayTeam, summary?.awayForm ?? null);
  const meetings: CorrectScoreH2hMeeting[] = (summary?.h2h ?? []).map((meeting) => ({
    date: meeting.date,
    home: meeting.home,
    away: meeting.away,
    score: meeting.score,
  }));

  let h2hHomeWins = 0;
  let h2hDraws = 0;
  let h2hAwayWins = 0;
  for (const meeting of meetings) {
    const score = meeting.score.split(/\s*-\s*/).map(Number);
    if (score.length !== 2 || !score.every(Number.isFinite)) continue;
    // Head-to-head history spans both venues, so the club listed as "home" in a
    // past meeting may be either side of this fixture.
    const listedAsHome = namesMatch(meeting.home, homeTeam);
    const listedAsAway = !listedAsHome && namesMatch(meeting.away, homeTeam);
    if (!listedAsHome && !listedAsAway) continue;
    const homeGoals = listedAsHome ? score[0] : score[1];
    const awayGoals = listedAsHome ? score[1] : score[0];
    if (homeGoals > awayGoals) h2hHomeWins += 1;
    else if (awayGoals > homeGoals) h2hAwayWins += 1;
    else h2hDraws += 1;
  }

  if (!homeForm && !awayForm && !meetings.length) return null;
  return {
    homeForm,
    awayForm,
    h2h: meetings,
    h2hHomeWins,
    h2hDraws,
    h2hAwayWins,
    h2hAverageGoals: h2hAverage(summary),
  };
}

interface CollectedFixtureData {
  inputs: CorrectScoreModelInputs;
  context: CorrectScoreContext | null;
}

async function collectInputs(
  fixture: FixtureLite,
  standings: Map<string, StandingAverages>,
  force: boolean,
): Promise<CollectedFixtureData> {
  const [canonical, summary] = await Promise.all([
    fetchCanonicalStats(fixture, force),
    withTimeout(fetchSummary(fixture.leagueSlug, fixture.id).catch(() => null), SUMMARY_TIMEOUT_MS, null),
  ]);
  const homeStanding = findStanding(standings, fixture.home.name);
  const awayStanding = findStanding(standings, fixture.away.name);
  const home: CorrectScoreTeamInputs = {
    xg: finiteNonNegative(canonical?.home.xg),
    shots: finiteNonNegative(canonical?.home.shots),
    shotsOnTarget: finiteNonNegative(canonical?.home.shotsOnTarget),
    avgGoalsScored: finiteNonNegative(homeStanding?.goalsScored),
    avgGoalsConceded: finiteNonNegative(homeStanding?.goalsConceded),
    form: formAverage(summary, "home"),
  };
  const away: CorrectScoreTeamInputs = {
    xg: finiteNonNegative(canonical?.away.xg),
    shots: finiteNonNegative(canonical?.away.shots),
    shotsOnTarget: finiteNonNegative(canonical?.away.shotsOnTarget),
    avgGoalsScored: finiteNonNegative(awayStanding?.goalsScored),
    avgGoalsConceded: finiteNonNegative(awayStanding?.goalsConceded),
    form: formAverage(summary, "away"),
  };
  const quality = qualityForInputs(home, away);
  const sources = [
    ...(canonical?.metadata.sources ?? (canonical?.metadata.source ? [canonical.metadata.source] : [])),
    ...(homeStanding || awayStanding ? ["ESPN Standings (season)"] : []),
    ...(summary?.homeForm || summary?.awayForm ? ["ESPN pre-match form"] : []),
    ...(summary?.h2h.length ? ["ESPN head-to-head"] : []),
  ];

  const context = buildMatchContext(summary, fixture.home.name, fixture.away.name);

  if (quality === "Synthetic") {
    const baseline = syntheticInputs(fixture.leagueSlug);
    return {
      inputs: {
        ...baseline,
        h2hGoalAverage: null,
        sources: [`${fixture.leagueSlug} observed league average`],
        dataQuality: "Synthetic",
      },
      context,
    };
  }

  return {
    inputs: {
      home,
      away,
      h2hGoalAverage: h2hAverage(summary),
      sources: [...new Set(sources)],
      dataQuality: quality,
    },
    context,
  };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const maxGoals = Math.round(clamp(Number(url.searchParams.get("maxGoals")) || DEFAULT_MAX_GOALS, 3, 10));
  const simulations = Math.round(
    clamp(Number(url.searchParams.get("sims")) || DEFAULT_SIMULATIONS, MIN_SIMULATIONS, MAX_SIMULATIONS),
  );
  const method: SimulationMethod =
    url.searchParams.get("method") === "iid-poisson" ? "iid-poisson" : "stratified";
  const force = url.searchParams.get("refresh") === "true";
  const cacheKey = `${maxGoals}|${simulations}|${method}`;

  // Match-week filter: ?matchweek=N narrows the feed to that round (openfootball
  // ships the round as "Matchday N" on every fixture). An absent or non-numeric
  // value returns every fixture and defaults selectedMatchweek to the current one.
  const requestedWeekRaw = url.searchParams.get("matchweek");
  const requestedWeek =
    requestedWeekRaw !== null && /^\d+$/.test(requestedWeekRaw) ? Number(requestedWeekRaw) : null;

  let allMatches: CorrectScoreMatch[] | null = null;
  let diagnostics: FeedDiagnostics | undefined;

  if (!force) {
    const cached = responseCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      allMatches = cached.matches;
      diagnostics = cached.diagnostics;
    }
  }

  if (allMatches === null) {
    try {
      const [feed, model] = await Promise.all([
        fetchUpcomingFixtures(request.url),
        loadSupercomputerModel(PREMIER_LEAGUE_SLUG, { force }),
      ]);
      const fixtures = feed.fixtures;
      const matchweeks = assignMatchweeks(fixtures);
      const leagueSlugs = [...new Set(fixtures.map((fixture) => fixture.leagueSlug))];
      const standingEntries = await Promise.all(
        leagueSlugs.map(async (slug) => [slug, await fetchStandingAverages(slug)] as const),
      );
      const standings = new Map(standingEntries);
      allMatches = await mapWithConcurrency(fixtures, CONCURRENCY, async (fixture) => {
        const { inputs, context } = await collectInputs(
          fixture,
          standings.get(fixture.leagueSlug) ?? new Map(),
          force,
        );
        return buildCorrectScorePrediction(
          fixture,
          inputs,
          maxGoals,
          { model, simulations, method },
          context,
          matchweeks.get(fixture.id) ?? null,
        );
      });
      diagnostics = feed.diagnostics;
      responseCache.set(cacheKey, { at: Date.now(), matches: allMatches, diagnostics });
    } catch (error) {
      console.error("[CorrectScore] prediction feed failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : "Unable to build correct-score predictions" },
        { status: 503 },
      );
    }
  }

  // `allMatches` is sorted by kickoff, so the earliest fixture identifies the
  // current round regardless of the incoming match-week filter.
  const currentMatchweek = allMatches.length ? (allMatches[0].matchweek ?? null) : null;
  return feedResponse(allMatches, requestedWeek, currentMatchweek, force ? "MISS" : "HIT", diagnostics);
}
