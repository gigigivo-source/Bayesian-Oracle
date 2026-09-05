// ĞIGI GIVØ — Correct Score model backtest.
//
// Historical fixtures are replayed chronologically. Every input is computed
// only from matches whose kickoff predates the fixture being tested; the final
// score of the target match is used solely as the outcome. This prevents the
// common (and misleading) mistake of feeding post-match boxscore/xG back into
// the prediction being validated.
//
// Each fixture is scored by BOTH engines over the identical 6×6 score grid:
//
//   · `baseline`      — the pre-upgrade model: xG-weighted λ, independent
//                       Poisson grid, no ELO, no Dixon–Coles, no simulation.
//   · `supercomputer` — ELO + attack/defence λ, Dixon–Coles ρ re-estimated from
//                       strictly pre-kickoff history, 10,000 Monte Carlo
//                       simulations per fixture.
//
// `overall` reports the supercomputer (so the existing dashboard shows the
// upgraded numbers) and `baseline` / `comparison` carry the old model and the
// per-metric deltas.
//
// PARAMETER SWEEP (`?sweep=1`). The same leakage-free replay, run over the
// last three Premier League seasons for every combination of
//   structuralWeight ∈ {0.6, 0.7, 0.8, 0.9}
//   temperature      ∈ {0.80, 0.85, 0.90, 0.95}
//   eloElasticity    ∈ {20, 30, 40}   (ELO league K-factor)
// reporting Top-1, Top-3 and Brier for each and the best combination first.
// `DEFAULT_TUNING` in ../route.ts is set from that winner.

import { fetchScoreboard, type FixtureLite, type TeamLite } from "@/lib/espn";
import { getAnchors } from "@/lib/engine/statisticalAnchors";
import {
  ATTACK_DEFENCE_HALF_LIFE_DAYS,
  buildAttackDefenceTable,
  computeMatchExpectedGoals,
  type AttackDefenceTable,
} from "@/lib/data/attackDefence";
import { estimateRhoDetailed, type RhoEstimate } from "@/lib/data/dixonColes";
import { applyMatchToElo, createEloTable, getElo } from "@/lib/data/elo";
import {
  DEFAULT_SEASONS,
  loadHistoricalMatches,
  matchesBefore,
  type HistoricalMatch,
} from "@/lib/data/historical";
import { DEFAULT_SIMULATIONS, simulateMatch } from "@/lib/data/monteCarlo";
import {
  calculateExpectedGoals,
  confidenceForProbability,
  DEFAULT_TUNING,
  LEGACY_TUNING,
  MODEL_VERSION,
  resolveExpectedGoals,
  scorelineProbabilities,
  type CorrectScoreline,
  type CorrectScoreModelInputs,
  type CorrectScoreTeamInputs,
  type CorrectScoreTuning,
  type DataQuality,
  type SupercomputerModel,
} from "../route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_DAYS = 30;
const MAX_GOALS = 5;
const HISTORY_WARMUP_DAYS = 120;
const MAX_MATCHES = 300;
/** Minimum prior matches before a fixture is worth replaying. */
const MIN_PRIOR_MATCHES = 40;
const CACHE_TTL_MS = 30 * 60_000;
const CALIBRATION_BUCKETS = [0, 0.05, 0.1, 0.15, 0.2, 1.01] as const;
const BASELINE_MODEL = "correct-score-poisson-v1";
/** This feature is restricted to the Premier League; every other league is ignored. */
const PREMIER_LEAGUE_SLUG = "eng.1";
const NO_PREMIER_LEAGUE_MESSAGE = "No Premier League matches available for backtesting.";
/**
 * Sweep archive: the last three *complete* Premier League seasons plus the
 * current partial one. `seasonCodes` counts the season in progress, so four
 * rolling codes are needed to reach back three full seasons.
 */
const SWEEP_SEASONS = 4;
/** Replay window wide enough to admit every fixture the sweep archive holds. */
const SWEEP_DAYS = SWEEP_SEASONS * 365 + 60;
/** No headline cap for the sweep — every fixture with enough prior history is replayed. */
const SWEEP_MAX_MATCHES = 5_000;
/** `?sims=` bounds for the sweep. Default is the live model's `DEFAULT_SIMULATIONS`. */
const SWEEP_MIN_SIMULATIONS = 500;
const SWEEP_MAX_SIMULATIONS = 50_000;

export interface CalibrationBucket {
  label: string;
  lowerBound: number;
  upperBound: number;
  predictedProbability: number;
  actualFrequency: number;
  observations: number;
}

export interface BacktestMetrics {
  matchesTested: number;
  top1Accuracy: number;
  top3Accuracy: number;
  top5Accuracy: number;
  meanAbsoluteError: number;
  meanAbsoluteErrorTop3: number;
  calibrationScore: number;
  brierScore: number;
  calibrationBuckets: CalibrationBucket[];
}

export interface BacktestMatchLog {
  fixtureId: string;
  match: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  leagueSlug: string;
  date: string;
  predictedTop1: string;
  predictedTop1Probability: number;
  predictedTop3: string[];
  predictedTop5: string[];
  actualScore: string;
  actualRank: number | null;
  correctTop1: boolean;
  correctTop3: boolean;
  correctTop5: boolean;
  dataQuality: DataQuality;
  // ── Supercomputer detail ───────────────────────────────────────────────────
  homeElo: number | null;
  awayElo: number | null;
  rho: number;
  homeExpectedGoals: number;
  awayExpectedGoals: number;
  priorMatches: number;
  // ── Baseline detail (same fixture, pre-upgrade model) ─────────────────────
  baselineTop1: string;
  baselineTop1Probability: number;
  baselineTop3: string[];
  baselineTop5: string[];
  baselineActualRank: number | null;
  baselineCorrectTop1: boolean;
  baselineCorrectTop3: boolean;
  baselineCorrectTop5: boolean;
  baselineHomeExpectedGoals: number;
  baselineAwayExpectedGoals: number;
}

export interface BacktestLeagueResult extends BacktestMetrics {
  league: string;
  leagueSlug: string;
}

export interface MetricComparison {
  metric: string;
  baseline: number;
  supercomputer: number;
  delta: number;
  /** Higher is better for every metric except MAE and Brier, handled below. */
  improved: boolean;
  betterWhen: "higher" | "lower";
}

export interface CorrectScoreBacktestResponse {
  generatedAt: string;
  days: number;
  model: string;
  baselineModel: string;
  dataSource: string;
  /** Parameters the supercomputer was replayed with (the live defaults). */
  tuning: CorrectScoreTuning;
  /** Supercomputer metrics — what the dashboard's headline cards show. */
  overall: BacktestMetrics;
  /** The pre-upgrade model, scored on exactly the same fixtures. */
  baseline: BacktestMetrics;
  comparison: MetricComparison[];
  byLeague: BacktestLeagueResult[];
  matches: BacktestMatchLog[];
  /** Historical layers that fed the replay, with per-layer match counts. */
  historySources: Array<{ source: string; attempted: boolean; added: number; note: string }>;
  /** Present when no Premier League historical matches were available to replay. */
  message?: string;
}

/** One parameter combination's score card from the sweep. */
export interface SweepResult {
  params: CorrectScoreTuning;
  matchesTested: number;
  top1Accuracy: number;
  top3Accuracy: number;
  brierScore: number;
}

export interface CorrectScoreSweepResponse {
  generatedAt: string;
  model: string;
  /** Replay window in days. */
  days: number;
  /** Rolling season codes loaded (three complete seasons + the current one). */
  seasons: number;
  /** Monte Carlo draws per fixture per combination. */
  simulations: number;
  /** Fixtures every combination was scored on. */
  matchesTested: number;
  /** Kickoff range of the archive that was replayed. */
  window: { from: string | null; to: string | null };
  grid: { structuralWeight: number[]; temperature: number[]; eloElasticity: number[] };
  /** Winner by Top-1 accuracy (ties: Top-3, then Brier); null when nothing was replayed. */
  best: SweepResult | null;
  /** `DEFAULT_TUNING` scored on the same fixtures — what the live model publishes. */
  current: SweepResult | null;
  /** The pre-sweep defaults scored on the same fixtures, for the before/after. */
  legacy: SweepResult | null;
  /** Every combination, best first. */
  results: SweepResult[];
  historySources: Array<{ source: string; attempted: boolean; added: number; note: string }>;
  elapsedMs: number;
  message?: string;
}

interface Evaluation {
  log: BacktestMatchLog;
  actualHomeGoals: number;
  actualAwayGoals: number;
  scorelines: CorrectScoreline[];
  baselineScorelines: CorrectScoreline[];
}

interface CacheEntry {
  at: number;
  data: CorrectScoreBacktestResponse;
}

const cache = new Map<number, CacheEntry>();
const sweepCache = new Map<number, { at: number; data: CorrectScoreSweepResponse }>();

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function fmt(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function teamLite(name: string): TeamLite {
  return {
    id: "",
    name,
    shortName: name,
    abbrev: "",
    logo: null,
    color: null,
    score: null,
    homeAway: "home",
  };
}

/** Adapt a `HistoricalMatch` to the fixture shape the prediction code expects. */
function fixtureShim(match: HistoricalMatch): Pick<
  FixtureLite,
  "id" | "home" | "away" | "leagueName" | "leagueSlug" | "date" | "venue"
> {
  return {
    id: match.id,
    home: teamLite(match.homeTeam),
    away: teamLite(match.awayTeam),
    leagueName: match.competitionName ?? match.leagueSlug,
    leagueSlug: match.leagueSlug,
    date: match.matchDate,
    venue: null,
  };
}

function syntheticInputs(leagueSlug: string): CorrectScoreModelInputs {
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
    h2hGoalAverage: null,
    sources: [`${leagueSlug} observed league average`],
    dataQuality: "Synthetic",
  };
}

function goalsFor(match: HistoricalMatch, teamName: string): { scored: number; conceded: number } | null {
  const home = match.homeTeam.toLowerCase();
  const away = match.awayTeam.toLowerCase();
  const target = teamName.toLowerCase();
  if (home === target || (home.length > 4 && (home.includes(target) || target.includes(home)))) {
    return { scored: match.homeGoals, conceded: match.awayGoals };
  }
  if (away === target || (away.length > 4 && (away.includes(target) || target.includes(away)))) {
    return { scored: match.awayGoals, conceded: match.homeGoals };
  }
  return null;
}

/**
 * Construct a leakage-free legacy snapshot for `target`: every score used here
 * comes from `prior` strictly before target.matchDate. Historical post-match
 * xG/shots are deliberately not read — those values would describe the target
 * result, not information known beforehand.
 */
function prematchInputs(target: HistoricalMatch, prior: HistoricalMatch[]): CorrectScoreModelInputs {
  const historyFor = (teamName: string): Array<{ scored: number; conceded: number }> =>
    prior
      .map((match) => goalsFor(match, teamName))
      .filter((row): row is { scored: number; conceded: number } => row !== null)
      // `prior` is chronological, so the tail is the most recent form.
      .reverse();

  const homeHistory = historyFor(target.homeTeam);
  const awayHistory = historyFor(target.awayTeam);
  if (!homeHistory.length && !awayHistory.length) return syntheticInputs(target.leagueSlug);

  const side = (history: Array<{ scored: number; conceded: number }>): CorrectScoreTeamInputs => {
    const season = history.slice(0, 30);
    const lastFive = season.slice(0, 5);
    return {
      xg: null,
      shots: null,
      shotsOnTarget: null,
      avgGoalsScored: average(season.map((row) => row.scored)),
      avgGoalsConceded: average(season.map((row) => row.conceded)),
      form: average(lastFive.map((row) => row.scored)),
    };
  };

  const h2h = prior
    .filter(
      (match) =>
        (match.homeTeam === target.homeTeam && match.awayTeam === target.awayTeam) ||
        (match.homeTeam === target.awayTeam && match.awayTeam === target.homeTeam),
    )
    .slice(-8)
    .map((match) => match.homeGoals + match.awayGoals);

  return {
    home: side(homeHistory),
    away: side(awayHistory),
    h2hGoalAverage: average(h2h),
    sources: ["Historical fixture cache (pre-match rolling form)"],
    // Some model fields (notably true pre-match xG) are unavailable in the
    // fixture cache, so the honest label is Mixed rather than Real.
    dataQuality: "Mixed",
  };
}

/** Restrict a simulation's scorelines to the 6×6 grid both models are scored on. */
function gridFromSimulation(
  homeLambda: number,
  awayLambda: number,
  rho: number,
  simulations: number,
  dataQuality: DataQuality,
  temperature?: number,
): CorrectScoreline[] {
  const simulation = simulateMatch({
    homeLambda,
    awayLambda,
    rho,
    options: { simulations, maxGoals: MAX_GOALS, temperature },
  });
  return simulation.scorelines
    .filter((scoreline) => scoreline.homeGoals <= MAX_GOALS && scoreline.awayGoals <= MAX_GOALS)
    .map((scoreline) => ({
      score: scoreline.score,
      homeGoals: scoreline.homeGoals,
      awayGoals: scoreline.awayGoals,
      probability: scoreline.probability,
      impliedOdds: scoreline.impliedOdds,
      confidence: confidenceForProbability(scoreline.probability),
      dataQuality,
      analyticProbability: scoreline.analyticProbability,
      simulatedCount: scoreline.count,
    }));
}

function calibrationLabel(lower: number, upper: number): string {
  if (upper > 1) return `${Math.round(lower * 100)}%+`;
  return `${Math.round(lower * 100)}–${Math.round(upper * 100)}%`;
}

function emptyMetrics(): BacktestMetrics {
  return {
    matchesTested: 0,
    top1Accuracy: 0,
    top3Accuracy: 0,
    top5Accuracy: 0,
    meanAbsoluteError: 0,
    meanAbsoluteErrorTop3: 0,
    calibrationScore: 0,
    brierScore: 0,
    calibrationBuckets: CALIBRATION_BUCKETS.slice(0, -1).map((lower, index) => ({
      label: calibrationLabel(lower, CALIBRATION_BUCKETS[index + 1]),
      lowerBound: lower,
      upperBound: Math.min(1, CALIBRATION_BUCKETS[index + 1]),
      predictedProbability: 0,
      actualFrequency: 0,
      observations: 0,
    })),
  };
}

function computeMetrics(evaluations: Evaluation[], model: "supercomputer" | "baseline"): BacktestMetrics {
  if (!evaluations.length) return emptyMetrics();

  let top1Hits = 0;
  let top3Hits = 0;
  let top5Hits = 0;
  let maeTop1 = 0;
  let maeTop3 = 0;
  let brier = 0;
  const buckets = CALIBRATION_BUCKETS.slice(0, -1).map(() => ({
    predicted: 0,
    actual: 0,
    observations: 0,
  }));

  for (const evaluation of evaluations) {
    const { log, actualHomeGoals, actualAwayGoals } = evaluation;
    const scorelines = model === "baseline" ? evaluation.baselineScorelines : evaluation.scorelines;
    const correctTop1 = model === "baseline" ? log.baselineCorrectTop1 : log.correctTop1;
    const correctTop3 = model === "baseline" ? log.baselineCorrectTop3 : log.correctTop3;
    const correctTop5 = model === "baseline" ? log.baselineCorrectTop5 : log.correctTop5;
    if (correctTop1) top1Hits++;
    if (correctTop3) top3Hits++;
    if (correctTop5) top5Hits++;

    const distance = (scoreline: CorrectScoreline) =>
      Math.abs(scoreline.homeGoals - actualHomeGoals) +
      Math.abs(scoreline.awayGoals - actualAwayGoals);
    maeTop1 += distance(scorelines[0]);
    maeTop3 += scorelines.slice(0, 3).reduce((sum, scoreline) => sum + distance(scoreline), 0) / 3;

    const actualInsideGrid = actualHomeGoals <= MAX_GOALS && actualAwayGoals <= MAX_GOALS;
    let gridMass = 0;
    let matchBrier = 0;
    for (const scoreline of scorelines) {
      const occurred = scoreline.homeGoals === actualHomeGoals && scoreline.awayGoals === actualAwayGoals ? 1 : 0;
      gridMass += scoreline.probability;
      matchBrier += (scoreline.probability - occurred) ** 2;
      const bucketIndex = CALIBRATION_BUCKETS.slice(0, -1).findIndex(
        (lower, index) =>
          scoreline.probability >= lower && scoreline.probability < CALIBRATION_BUCKETS[index + 1],
      );
      const bucket = buckets[Math.max(0, bucketIndex)];
      bucket.predicted += scoreline.probability;
      bucket.actual += occurred;
      bucket.observations++;
    }
    const tailProbability = Math.max(0, 1 - gridMass);
    matchBrier += (tailProbability - (actualInsideGrid ? 0 : 1)) ** 2;
    brier += matchBrier;
  }

  const calibrationBuckets: CalibrationBucket[] = buckets.map((bucket, index) => {
    const lower = CALIBRATION_BUCKETS[index];
    const upper = CALIBRATION_BUCKETS[index + 1];
    return {
      label: calibrationLabel(lower, upper),
      lowerBound: lower,
      upperBound: Math.min(1, upper),
      predictedProbability: bucket.observations ? round(bucket.predicted / bucket.observations, 6) : 0,
      actualFrequency: bucket.observations ? round(bucket.actual / bucket.observations, 6) : 0,
      observations: bucket.observations,
    };
  });
  const totalObservations = calibrationBuckets.reduce((sum, bucket) => sum + bucket.observations, 0);
  const expectedCalibrationError = calibrationBuckets.reduce(
    (sum, bucket) =>
      sum +
      Math.abs(bucket.predictedProbability - bucket.actualFrequency) *
        (bucket.observations / Math.max(1, totalObservations)),
    0,
  );
  const count = evaluations.length;

  return {
    matchesTested: count,
    top1Accuracy: round(top1Hits / count, 6),
    top3Accuracy: round(top3Hits / count, 6),
    top5Accuracy: round(top5Hits / count, 6),
    meanAbsoluteError: round(maeTop1 / count, 4),
    meanAbsoluteErrorTop3: round(maeTop3 / count, 4),
    calibrationScore: round(Math.max(0, 1 - expectedCalibrationError), 6),
    brierScore: round(brier / count, 6),
    calibrationBuckets,
  };
}

const COMPARISON_METRICS: Array<{ metric: string; betterWhen: "higher" | "lower"; decimals: number }> = [
  { metric: "top1Accuracy", betterWhen: "higher", decimals: 4 },
  { metric: "top3Accuracy", betterWhen: "higher", decimals: 4 },
  { metric: "top5Accuracy", betterWhen: "higher", decimals: 4 },
  { metric: "meanAbsoluteError", betterWhen: "lower", decimals: 4 },
  { metric: "meanAbsoluteErrorTop3", betterWhen: "lower", decimals: 4 },
  { metric: "brierScore", betterWhen: "lower", decimals: 6 },
  { metric: "calibrationScore", betterWhen: "higher", decimals: 6 },
];

function compareMetrics(baseline: BacktestMetrics, supercomputer: BacktestMetrics): MetricComparison[] {
  return COMPARISON_METRICS.map(({ metric, betterWhen, decimals }) => {
    const before = baseline[metric as keyof BacktestMetrics] as number;
    const after = supercomputer[metric as keyof BacktestMetrics] as number;
    const delta = round(after - before, decimals);
    return {
      metric,
      baseline: before,
      supercomputer: after,
      delta,
      improved: betterWhen === "higher" ? delta > 0 : delta < 0,
      betterWhen,
    };
  });
}

/**
 * Historical fixture archive for the replay.
 *
 * The historical aggregator is tried first (database, then the GitHub datasets
 * / openfootball / ESPN fallbacks). The dedicated ESPN scoreboard window is
 * merged in afterwards because it reaches further back than the aggregator's
 * default lookback and is what this route has always replayed.
 */
async function fetchHistoricalFixtures(
  days: number,
  force: boolean,
  seasons: number = DEFAULT_SEASONS,
): Promise<{ matches: HistoricalMatch[]; sources: CorrectScoreBacktestResponse["historySources"] }> {
  const now = new Date();
  const dataset = await loadHistoricalMatches({
    leagueSlug: PREMIER_LEAGUE_SLUG,
    seasons,
    lookbackDays: days + HISTORY_WARMUP_DAYS,
    force,
    now,
  }).catch((error) => {
    console.warn(
      `[CorrectScoreBacktest] historical aggregator failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  });

  const collected: HistoricalMatch[] = dataset ? [...dataset.matches] : [];
  const sources: CorrectScoreBacktestResponse["historySources"] = (dataset?.sources ?? []).map((source) => ({
    source: source.source,
    attempted: source.attempted,
    added: source.added,
    note: source.note,
  }));

  // ESPN scoreboard archive, merged with the aggregator's output.
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - days - HISTORY_WARMUP_DAYS);
  const range = `${fmt(from)}-${fmt(now)}`;
  let espnAdded = 0;
  let espnNote = "";
  try {
    const board = await fetchScoreboard(PREMIER_LEAGUE_SLUG, range);
    const known = new Set(collected.map((match) => match.id));
    for (const fixture of board) {
      if (fixture.leagueSlug !== PREMIER_LEAGUE_SLUG || fixture.state !== "post") continue;
      const homeGoals = Number(fixture.home.score);
      const awayGoals = Number(fixture.away.score);
      if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals) || homeGoals < 0 || awayGoals < 0) continue;
      const matchDate = new Date(fixture.date);
      if (Number.isNaN(matchDate.getTime())) continue;
      const iso = matchDate.toISOString();
      const id = [
        fixture.leagueSlug,
        fixture.home.name.toLowerCase(),
        fixture.away.name.toLowerCase(),
        iso.slice(0, 10),
      ].join("|");
      if (known.has(id)) continue;
      known.add(id);
      collected.push({
        id,
        homeTeam: fixture.home.name,
        awayTeam: fixture.away.name,
        leagueSlug: fixture.leagueSlug,
        matchDate: iso,
        homeGoals,
        awayGoals,
        competitionName: fixture.leagueName,
        source: "espn",
      });
      espnAdded++;
    }
    if (!espnAdded) espnNote = "ESPN archive contributed no new matches";
  } catch (error) {
    espnNote = `ESPN unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
  sources.push({ source: "espn", attempted: true, added: espnAdded, note: espnNote });

  collected.sort((left, right) => new Date(left.matchDate).getTime() - new Date(right.matchDate).getTime());
  return { matches: collected, sources };
}

// ─── Replay ───────────────────────────────────────────────────────────────────

/**
 * Everything about one target fixture that does not depend on the tuning
 * parameters: the strictly-prior slice, the attack/defence table and ρ built
 * from it, the legacy inputs and the baseline grid. Computed once per fixture
 * and shared across every parameter combination, so the sweep costs 48 × (ELO
 * replay + Monte Carlo) rather than 48 × (table + ρ + Monte Carlo).
 */
interface PreparedFixture {
  target: HistoricalMatch;
  fixture: ReturnType<typeof fixtureShim>;
  inputs: CorrectScoreModelInputs;
  attackDefence: AttackDefenceTable;
  rhoEstimate: RhoEstimate;
  priorMatches: number;
  baselineExpected: { homeExpectedGoals: number; awayExpectedGoals: number };
  baselineScorelines: CorrectScoreline[];
}

export interface ReplayOptions {
  days: number;
  maxMatches?: number;
  simulations?: number;
  now?: Date;
  /** Override the structural/legacy λ blend, for sensitivity analysis. */
  structuralWeight?: number;
  /** Ablation switch: drop the ELO modulation from λ. Default true. */
  useElo?: boolean;
  /** ELO league K-factor for the chronological replay (`CorrectScoreTuning.eloElasticity`). */
  eloElasticity?: number;
  /** Override the ELO → λ goal elasticity (`ELO_GOAL_ELASTICITY`). */
  eloGoalElasticity?: number;
  /** Model temperature applied to λ and the grid; see monteCarlo.ts. */
  temperature?: number;
  /** Half-life (days) of the exponential match weighting; null disables decay. */
  halfLifeDays?: number | null;
}

/** Pick the fixtures to replay: newest `maxMatches` inside the window, in kickoff order. */
function selectTargets(history: HistoricalMatch[], options: ReplayOptions): HistoricalMatch[] {
  const now = options.now ?? new Date();
  const maxMatches = options.maxMatches ?? MAX_MATCHES;
  const cutoff = now.getTime() - options.days * 86_400_000;
  return history
    .filter((match) => {
      const kickoff = new Date(match.matchDate).getTime();
      return kickoff >= cutoff && kickoff <= now.getTime();
    })
    .sort((left, right) => new Date(right.matchDate).getTime() - new Date(left.matchDate).getTime())
    .slice(0, maxMatches)
    // Chronological order for the incremental ELO replay.
    .sort((left, right) => new Date(left.matchDate).getTime() - new Date(right.matchDate).getTime());
}

/** Build the parameter-independent state for every target (see `PreparedFixture`). */
function prepareFixtures(
  history: HistoricalMatch[],
  targets: HistoricalMatch[],
  options: ReplayOptions,
): PreparedFixture[] {
  const prepared: PreparedFixture[] = [];
  for (const target of targets) {
    const prior = matchesBefore(history, target.matchDate).filter((match) => match.id !== target.id);
    if (prior.length < MIN_PRIOR_MATCHES) continue;

    // Decay is measured from the target's own kickoff, so a fixture replayed
    // from two seasons ago weights its history the way a live model would
    // have weighted it on the day — never from today's date.
    const attackDefence = buildAttackDefenceTable(prior, target.leagueSlug, {
      halfLifeDays: options.halfLifeDays === undefined ? ATTACK_DEFENCE_HALF_LIFE_DAYS : options.halfLifeDays,
      now: new Date(target.matchDate),
    });
    const lambdaFor = (match: HistoricalMatch) => {
      const expected = computeMatchExpectedGoals({
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        table: attackDefence,
        applyElo: false,
      });
      return { homeLambda: expected.homeExpectedGoals, awayLambda: expected.awayExpectedGoals };
    };
    const rhoEstimate = estimateRhoDetailed(prior, lambdaFor);

    const fixture = fixtureShim(target);
    const inputs = prematchInputs(target, prior);
    const baselineExpected = calculateExpectedGoals(inputs);
    const baselineScorelines = scorelineProbabilities(
      baselineExpected.homeExpectedGoals,
      baselineExpected.awayExpectedGoals,
      MAX_GOALS,
      inputs.dataQuality,
    );

    prepared.push({
      target,
      fixture,
      inputs,
      attackDefence,
      rhoEstimate,
      priorMatches: prior.length,
      baselineExpected,
      baselineScorelines,
    });
  }
  return prepared;
}

/**
 * Score every prepared fixture under one parameter set.
 *
 * ELO is replayed incrementally in chronological order with the requested
 * league K-factor; the attack/defence table and ρ come from the strictly-prior
 * slice prepared for each fixture, so no fixture is ever predicted with
 * information from after its own kickoff.
 */
function evaluatePrepared(
  history: HistoricalMatch[],
  prepared: PreparedFixture[],
  options: ReplayOptions,
): Evaluation[] {
  const now = options.now ?? new Date();
  const simulations = options.simulations ?? DEFAULT_SIMULATIONS;
  const kFactors =
    options.eloElasticity === undefined ? undefined : { league: options.eloElasticity };
  const evaluations: Evaluation[] = [];
  const elo = createEloTable();
  let applied = 0;

  for (const entry of prepared) {
    const { target, fixture, inputs, attackDefence, rhoEstimate } = entry;
    // Fold in every match that finished before this kickoff. `history` is
    // chronological, so a single forward cursor keeps this O(n) overall.
    const kickoff = new Date(target.matchDate).getTime();
    while (applied < history.length && new Date(history[applied].matchDate).getTime() < kickoff) {
      applyMatchToElo(elo, history[applied], 0, kFactors);
      applied++;
    }

    const model: SupercomputerModel = {
      available: true,
      // Ablation: a null table makes resolveExpectedGoals skip the ELO
      // multipliers, isolating the attack/defence contribution.
      elo: options.useElo === false ? null : elo,
      attackDefence,
      rho: rhoEstimate.rho,
      rhoEstimate,
      matches: entry.priorMatches,
      seasonsCovered: [],
      primarySource: "backtest replay",
      sources: ["backtest replay"],
      dataset: null,
      generatedAt: now.toISOString(),
    };

    const expected = resolveExpectedGoals(fixture, inputs, model, {
      structuralWeight: options.structuralWeight,
      eloGoalElasticity: options.eloGoalElasticity,
    });

    const scorelines = gridFromSimulation(
      expected.homeExpectedGoals,
      expected.awayExpectedGoals,
      model.rho,
      simulations,
      inputs.dataQuality,
      options.temperature,
    );
    const { baselineScorelines, baselineExpected } = entry;

    const actualScore = `${target.homeGoals}-${target.awayGoals}`;
    const rankIn = (grid: CorrectScoreline[]): number | null => {
      const index = grid.findIndex((scoreline) => scoreline.score === actualScore);
      return index >= 0 ? index + 1 : null;
    };
    const top3 = scorelines.slice(0, 3).map((scoreline) => scoreline.score);
    const top5 = scorelines.slice(0, 5).map((scoreline) => scoreline.score);
    const baselineTop3 = baselineScorelines.slice(0, 3).map((scoreline) => scoreline.score);
    const baselineTop5 = baselineScorelines.slice(0, 5).map((scoreline) => scoreline.score);
    const homeElo = getElo(target.homeTeam, target.leagueSlug, elo);
    const awayElo = getElo(target.awayTeam, target.leagueSlug, elo);

    evaluations.push({
      actualHomeGoals: target.homeGoals,
      actualAwayGoals: target.awayGoals,
      scorelines,
      baselineScorelines,
      log: {
        fixtureId: target.id,
        match: `${target.homeTeam} vs ${target.awayTeam}`,
        homeTeam: target.homeTeam,
        awayTeam: target.awayTeam,
        league: fixture.leagueName,
        leagueSlug: target.leagueSlug,
        date: target.matchDate,
        predictedTop1: scorelines[0].score,
        predictedTop1Probability: scorelines[0].probability,
        predictedTop3: top3,
        predictedTop5: top5,
        actualScore,
        actualRank: rankIn(scorelines),
        correctTop1: scorelines[0].score === actualScore,
        correctTop3: top3.includes(actualScore),
        correctTop5: top5.includes(actualScore),
        dataQuality: inputs.dataQuality,
        homeElo: homeElo !== null ? Math.round(homeElo) : null,
        awayElo: awayElo !== null ? Math.round(awayElo) : null,
        rho: rhoEstimate.rho,
        homeExpectedGoals: round(expected.homeExpectedGoals, 3),
        awayExpectedGoals: round(expected.awayExpectedGoals, 3),
        priorMatches: entry.priorMatches,
        baselineTop1: baselineScorelines[0].score,
        baselineTop1Probability: baselineScorelines[0].probability,
        baselineTop3,
        baselineTop5,
        baselineActualRank: rankIn(baselineScorelines),
        baselineCorrectTop1: baselineScorelines[0].score === actualScore,
        baselineCorrectTop3: baselineTop3.includes(actualScore),
        baselineCorrectTop5: baselineTop5.includes(actualScore),
        baselineHomeExpectedGoals: round(baselineExpected.homeExpectedGoals, 3),
        baselineAwayExpectedGoals: round(baselineExpected.awayExpectedGoals, 3),
      },
    });
  }

  // The UI lists the newest fixtures first.
  evaluations.sort((left, right) => new Date(right.log.date).getTime() - new Date(left.log.date).getTime());
  return evaluations;
}

/**
 * Replay every target fixture with both engines under one parameter set.
 *
 * Tuning parameters default to `DEFAULT_TUNING` — the same values the live
 * route publishes with — so the headline backtest always measures the model
 * users actually see. Pass explicit overrides for ablation or the sweep.
 */
export function evaluateHistoricalMatches(
  history: HistoricalMatch[],
  options: ReplayOptions = { days: DEFAULT_DAYS },
): { evaluations: Evaluation[]; targets: HistoricalMatch[] } {
  const targets = selectTargets(history, options);
  const prepared = prepareFixtures(history, targets, options);
  const evaluations = evaluatePrepared(history, prepared, {
    ...options,
    structuralWeight: options.structuralWeight ?? DEFAULT_TUNING.structuralWeight,
    temperature: options.temperature ?? DEFAULT_TUNING.temperature,
    eloElasticity: options.eloElasticity ?? DEFAULT_TUNING.eloElasticity,
  });
  return { evaluations, targets };
}

// ─── Parameter sweep ──────────────────────────────────────────────────────────

/** The grid the sweep walks: 4 × 4 × 3 = 48 combinations. */
export const SWEEP_GRID = {
  structuralWeight: [0.6, 0.7, 0.8, 0.9],
  temperature: [0.8, 0.85, 0.9, 0.95],
  eloElasticity: [20, 30, 40],
} as const;

/** Every combination of the sweep grid, in grid order. */
export function sweepCombinations(): CorrectScoreTuning[] {
  const output: CorrectScoreTuning[] = [];
  for (const structuralWeight of SWEEP_GRID.structuralWeight) {
    for (const temperature of SWEEP_GRID.temperature) {
      for (const eloElasticity of SWEEP_GRID.eloElasticity) {
        output.push({ structuralWeight, temperature, eloElasticity });
      }
    }
  }
  return output;
}

/**
 * Sweep ranking: Top-1 accuracy first — the metric the tuning exists to
 * improve — then Top-3, then Brier (lower is better). Deterministic on ties so
 * the same replay always names the same winner.
 */
export function compareSweepResults(left: SweepResult, right: SweepResult): number {
  return (
    right.top1Accuracy - left.top1Accuracy ||
    right.top3Accuracy - left.top3Accuracy ||
    left.brierScore - right.brierScore ||
    left.params.structuralWeight - right.params.structuralWeight ||
    left.params.temperature - right.params.temperature ||
    left.params.eloElasticity - right.params.eloElasticity
  );
}

/**
 * Score every combination in `SWEEP_GRID` on the same prepared fixtures and
 * return the results sorted best-first. `simulations` is deliberately low by
 * default: the stratified sampler's marginals are exact, so 2,000 draws rank
 * the grid the same way 10,000 do at a fifth of the cost.
 */
export function runParameterSweep(
  history: HistoricalMatch[],
  options: ReplayOptions,
  combinations: CorrectScoreTuning[] = sweepCombinations(),
): { results: SweepResult[]; matchesTested: number } {
  const targets = selectTargets(history, options);
  const prepared = prepareFixtures(history, targets, options);
  const results: SweepResult[] = combinations.map((params) => {
    const evaluations = evaluatePrepared(history, prepared, { ...options, ...params });
    const metrics = computeMetrics(evaluations, "supercomputer");
    return {
      params,
      matchesTested: metrics.matchesTested,
      top1Accuracy: metrics.top1Accuracy,
      top3Accuracy: metrics.top3Accuracy,
      brierScore: metrics.brierScore,
    };
  });
  results.sort(compareSweepResults);
  return { results, matchesTested: prepared.length };
}

// ─── Route ────────────────────────────────────────────────────────────────────

async function runBacktest(days: number, force: boolean): Promise<CorrectScoreBacktestResponse> {
  const { matches, sources } = await fetchHistoricalFixtures(days, force);
  console.info(
    `[CorrectScoreBacktest] Premier League only: ${matches.length} ${PREMIER_LEAGUE_SLUG} fixture(s) loaded`,
  );

  const { evaluations, targets } = evaluateHistoricalMatches(matches, { days });
  if (!targets.length) {
    console.info(`[CorrectScoreBacktest] ${NO_PREMIER_LEAGUE_MESSAGE}`);
  }

  const grouped = new Map<string, Evaluation[]>();
  for (const evaluation of evaluations) {
    const list = grouped.get(evaluation.log.leagueSlug) ?? [];
    list.push(evaluation);
    grouped.set(evaluation.log.leagueSlug, list);
  }
  const byLeague: BacktestLeagueResult[] = [...grouped.entries()]
    .map(([leagueSlug, rows]) => ({
      league: rows[0].log.league,
      leagueSlug,
      ...computeMetrics(rows, "supercomputer"),
    }))
    .sort((left, right) => right.matchesTested - left.matchesTested || left.league.localeCompare(right.league));

  const overall = computeMetrics(evaluations, "supercomputer");
  const baseline = computeMetrics(evaluations, "baseline");

  return {
    generatedAt: new Date().toISOString(),
    days,
    model: `${MODEL_VERSION} (ELO + Attack/Defence + Dixon-Coles + Monte Carlo)`,
    baselineModel: BASELINE_MODEL,
    dataSource:
      "Historical fixture archive (database → GitHub datasets → openfootball → ESPN); chronological pre-match rolling team statistics",
    tuning: DEFAULT_TUNING,
    overall,
    baseline,
    comparison: compareMetrics(baseline, overall),
    byLeague,
    matches: evaluations.map((evaluation) => evaluation.log),
    historySources: sources,
    ...(evaluations.length ? {} : { message: NO_PREMIER_LEAGUE_MESSAGE }),
  };
}

/**
 * The parameter sweep. Replays the last three complete Premier League seasons
 * plus the current one (every completed fixture the archive holds, not the
 * 300-match headline cap) under all 48 combinations and reports them
 * best-first, plus the current and pre-sweep defaults scored the same way so
 * the improvement is visible at a glance.
 */
async function runSweep(simulations: number, force: boolean): Promise<CorrectScoreSweepResponse> {
  const startedAt = Date.now();
  const { matches, sources } = await fetchHistoricalFixtures(SWEEP_DAYS, force, SWEEP_SEASONS);
  console.info(
    `[CorrectScoreBacktest] sweep: ${matches.length} ${PREMIER_LEAGUE_SLUG} fixture(s) loaded, ` +
      `${sweepCombinations().length} combinations × ${simulations} sims`,
  );

  const options: ReplayOptions = {
    days: SWEEP_DAYS,
    maxMatches: SWEEP_MAX_MATCHES,
    simulations,
  };
  const { results, matchesTested } = runParameterSweep(matches, options);
  const [current] = runParameterSweep(matches, options, [DEFAULT_TUNING]).results;
  const [legacy] = runParameterSweep(matches, options, [LEGACY_TUNING]).results;
  const best = results[0] ?? null;

  const dates = matches.map((match) => match.matchDate).sort();
  return {
    generatedAt: new Date().toISOString(),
    model: `${MODEL_VERSION} (ELO + Attack/Defence + Dixon-Coles + Monte Carlo)`,
    days: SWEEP_DAYS,
    seasons: SWEEP_SEASONS,
    simulations,
    matchesTested,
    window: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
    grid: {
      structuralWeight: [...SWEEP_GRID.structuralWeight],
      temperature: [...SWEEP_GRID.temperature],
      eloElasticity: [...SWEEP_GRID.eloElasticity],
    },
    best,
    current,
    legacy,
    results,
    historySources: sources,
    elapsedMs: Date.now() - startedAt,
    ...(matchesTested ? {} : { message: NO_PREMIER_LEAGUE_MESSAGE }),
  };
}

function requestedDays(request: Request): number {
  const value = Number(new URL(request.url).searchParams.get("days"));
  return Math.round(clamp(Number.isFinite(value) && value > 0 ? value : DEFAULT_DAYS, 7, 90));
}

function sweepRequested(request: Request): boolean {
  const value = new URL(request.url).searchParams.get("sweep");
  return value === "1" || value === "true";
}

/** `?sims=N` — per-fixture draws for the sweep; lower it to trade fidelity for speed. */
function requestedSweepSimulations(request: Request): number {
  const value = Number(new URL(request.url).searchParams.get("sims"));
  return Math.round(
    clamp(
      Number.isFinite(value) && value > 0 ? value : DEFAULT_SIMULATIONS,
      SWEEP_MIN_SIMULATIONS,
      SWEEP_MAX_SIMULATIONS,
    ),
  );
}

async function respondSweep(request: Request, force: boolean): Promise<Response> {
  const simulations = requestedSweepSimulations(request);
  const cached = sweepCache.get(simulations);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return Response.json(cached.data, {
      headers: { "Cache-Control": "no-store", "X-Correct-Score-Backtest-Cache": "HIT" },
    });
  }
  try {
    const data = await runSweep(simulations, force);
    sweepCache.set(simulations, { at: Date.now(), data });
    return Response.json(data, {
      headers: { "Cache-Control": "no-store", "X-Correct-Score-Backtest-Cache": "MISS" },
    });
  } catch (error) {
    console.error("[CorrectScoreBacktest] sweep failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to run correct-score parameter sweep" },
      { status: 503 },
    );
  }
}

async function respond(request: Request, force: boolean): Promise<Response> {
  if (sweepRequested(request)) return respondSweep(request, force);

  const days = requestedDays(request);
  if (!force) {
    const cached = cache.get(days);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return Response.json(cached.data, {
        headers: { "Cache-Control": "no-store", "X-Correct-Score-Backtest-Cache": "HIT" },
      });
    }
  }

  try {
    const data = await runBacktest(days, force);
    cache.set(days, { at: Date.now(), data });
    return Response.json(data, {
      headers: { "Cache-Control": "no-store", "X-Correct-Score-Backtest-Cache": "MISS" },
    });
  } catch (error) {
    console.error("[CorrectScoreBacktest] failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to run correct-score backtest" },
      { status: 503 },
    );
  }
}

/** `?sweep=1` runs the parameter sweep instead of the headline backtest (`?sims=` optional). */
export async function GET(request: Request): Promise<Response> {
  return respond(request, false);
}

/** POST always runs a fresh replay; this is what the UI's Run Backtest uses. */
export async function POST(request: Request): Promise<Response> {
  return respond(request, true);
}
