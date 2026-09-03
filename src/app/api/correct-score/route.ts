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
import { fetchSummary, type FixtureLite, type MatchSummary } from "@/lib/espn";
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
import { buildEloRatings, getElo, type EloTable } from "@/lib/data/elo";
import {
  DEFAULT_SEASONS,
  loadHistoricalMatches,
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
const NO_PREMIER_LEAGUE_MESSAGE = "No Premier League matches available.";

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
  // ── Supercomputer diagnostics ──────────────────────────────────────────────
  /** Engine identifier, e.g. `supercomputer-v2`. */
  model: string;
  /** Card badge text: `🧠 Supercomputer` or `🧠 Monte Carlo (10k sims)`. */
  modelBadge: string;
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

  const elo = buildEloRatings(dataset.matches);
  // Exponential time decay (Dixon & Coles' ξ): last season's results carry
  // more weight than a match from two seasons ago, so promoted sides and
  // rebuilt squads are not averaged away over three years.
  const attackDefence = buildAttackDefenceTable(dataset.matches, leagueSlug, {
    halfLifeDays: ATTACK_DEFENCE_HALF_LIFE_DAYS,
    now: new Date(),
  });
  const rhoEstimate = estimateLeagueRho(leagueSlug, dataset.matches, (match) => {
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
    matches: dataset.matchCount,
    seasonsCovered: dataset.seasonsCovered,
    primarySource: dataset.primarySource,
    sources: [
      ...new Set(
        dataset.sources
          .filter((source) => source.added > 0)
          .map((source) => `${source.source} (${source.added})`),
      ),
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
  if (model?.available) return "🧠 Supercomputer";
  return `🧠 Monte Carlo (${Math.round(simulations / 1000)}k sims)`;
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
  };
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
}

export interface FixtureSelection {
  premierLeague: FixtureLite[];
  /** In-window fixtures dropped because a team name was missing/placeholder. */
  anonymous: FixtureLite[];
  /** Non-PL fixtures dropped, counted per canonical league slug. */
  skippedNonPl: Map<string, number>;
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
  for (const fixture of inWindow) {
    if (!hasResolvableTeams(fixture)) {
      anonymous.push(fixture);
      continue;
    }
    const slug = canonicalLeagueSlug(typeof fixture.leagueSlug === "string" ? fixture.leagueSlug : "");
    if (slug !== PREMIER_LEAGUE_SLUG) {
      skippedNonPl.set(slug || "unknown", (skippedNonPl.get(slug || "unknown") ?? 0) + 1);
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
    inWindowCount: inWindow.length,
    diagnostics: {
      feedFixtures: Array.isArray(upcoming) ? upcoming.length : 0,
      inWindow: inWindow.length,
      unresolvedTeams: anonymous.length,
      nonPremierLeague: Object.fromEntries(skippedNonPl),
    },
  };
}

async function fetchUpcomingFixtures(requestUrl: string): Promise<FixtureSelection> {
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

  // Diagnostics: the troubleshooting playbook greps for exactly these lines
  // ("Processing eng.1:", "Skipping non-PL fixture:") to tell the four feed
  // failure modes apart — no eng.1 in the feed, eng.1 filtered out, feed rows
  // without team names, or a completely empty feed.
  for (const fixture of selection.anonymous) {
    console.warn(
      `[CorrectScore] Skipping fixture with unresolved team names: ${fixture.id} ` +
        `(${fixture.leagueSlug}, ${fixture.date}) — home=${teamNameOr(fixture.home)}, away=${teamNameOr(fixture.away)}`,
    );
  }
  for (const [slug, count] of selection.skippedNonPl) {
    console.info(`[CorrectScore] Skipping non-PL fixture: ${count} × ${slug}`);
  }
  const skipped = selection.inWindowCount - selection.premierLeague.length;
  if (skipped > 0) {
    console.info(
      `[CorrectScore] Premier League only: kept ${selection.premierLeague.length} of ${selection.inWindowCount} in-window fixture(s) for ${PREMIER_LEAGUE_SLUG}`,
    );
  }
  console.info(
    `[CorrectScore] Processing eng.1: ${selection.premierLeague.length} fixture(s)` +
      (selection.premierLeague.length
        ? ` — ${selection.premierLeague
            .map((fixture) => `${fixture.home.name} vs ${fixture.away.name} (${fixture.date})`)
            .join(", ")}`
        : " — the fixture feed delivered no Premier League match with resolvable team names"),
  );
  return selection;
}

function feedResponse(
  matches: CorrectScoreMatch[],
  cacheStatus: "HIT" | "MISS",
  diagnostics?: FeedDiagnostics,
): Response {
  const headers = { "Cache-Control": "no-store", "X-Correct-Score-Cache": cacheStatus };
  if (!matches.length) {
    return Response.json(
      { matches: [], message: NO_PREMIER_LEAGUE_MESSAGE, diagnostics },
      { headers },
    );
  }
  return Response.json(matches, { headers });
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

async function collectInputs(
  fixture: FixtureLite,
  standings: Map<string, StandingAverages>,
  force: boolean,
): Promise<CorrectScoreModelInputs> {
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

  if (quality === "Synthetic") {
    const baseline = syntheticInputs(fixture.leagueSlug);
    return {
      ...baseline,
      h2hGoalAverage: null,
      sources: [`${fixture.leagueSlug} observed league average`],
      dataQuality: "Synthetic",
    };
  }

  return {
    home,
    away,
    h2hGoalAverage: h2hAverage(summary),
    sources: [...new Set(sources)],
    dataQuality: quality,
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

  if (!force) {
    const cached = responseCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return feedResponse(cached.matches, "HIT", cached.diagnostics);
    }
  }

  try {
    const [selection, model] = await Promise.all([
      fetchUpcomingFixtures(request.url),
      loadSupercomputerModel(PREMIER_LEAGUE_SLUG, { force }),
    ]);
    const fixtures = selection.premierLeague;
    const leagueSlugs = [...new Set(fixtures.map((fixture) => fixture.leagueSlug))];
    const standingEntries = await Promise.all(
      leagueSlugs.map(async (slug) => [slug, await fetchStandingAverages(slug)] as const),
    );
    const standings = new Map(standingEntries);
    const matches = await mapWithConcurrency(fixtures, CONCURRENCY, async (fixture) => {
      const inputs = await collectInputs(
        fixture,
        standings.get(fixture.leagueSlug) ?? new Map(),
        force,
      );
      return buildCorrectScorePrediction(fixture, inputs, maxGoals, { model, simulations, method });
    });
    responseCache.set(cacheKey, { at: Date.now(), matches, diagnostics: selection.diagnostics });
    return feedResponse(matches, "MISS", selection.diagnostics);
  } catch (error) {
    console.error("[CorrectScore] prediction feed failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to build correct-score predictions" },
      { status: 503 },
    );
  }
}
