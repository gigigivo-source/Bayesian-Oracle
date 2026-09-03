// ĞIGI GIVØ — Correct Score model backtest.
//
// Historical fixtures are replayed chronologically. Every input is computed
// only from matches whose kickoff predates the fixture being tested; the final
// score of the target match is used solely as the outcome. This prevents the
// common (and misleading) mistake of feeding post-match boxscore/xG back into
// the prediction being validated.

import { fetchScoreboard, type FixtureLite } from "@/lib/espn";
import { getAnchors } from "@/lib/engine/statisticalAnchors";
import { TOP_FEED_SLUGS } from "@/lib/leagues";
import {
  buildCorrectScorePrediction,
  scorelineProbabilities,
  type CorrectScoreModelInputs,
  type CorrectScoreTeamInputs,
  type CorrectScoreline,
  type DataQuality,
} from "../route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_DAYS = 30;
const MAX_GOALS = 5;
const HISTORY_WARMUP_DAYS = 120;
const MAX_MATCHES = 300;
const CACHE_TTL_MS = 30 * 60_000;
const CALIBRATION_BUCKETS = [0, 0.05, 0.1, 0.15, 0.2, 1.01] as const;

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
}

export interface BacktestLeagueResult extends BacktestMetrics {
  league: string;
  leagueSlug: string;
}

export interface CorrectScoreBacktestResponse {
  generatedAt: string;
  days: number;
  model: string;
  dataSource: string;
  overall: BacktestMetrics;
  byLeague: BacktestLeagueResult[];
  matches: BacktestMatchLog[];
}

interface Evaluation {
  log: BacktestMatchLog;
  actualHomeGoals: number;
  actualAwayGoals: number;
  scorelines: CorrectScoreline[];
}

interface CacheEntry {
  at: number;
  data: CorrectScoreBacktestResponse;
}

const cache = new Map<number, CacheEntry>();

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

function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sameTeam(left: string, right: string): boolean {
  const a = normaliseName(left);
  const b = normaliseName(right);
  return a === b || (a.length > 4 && b.length > 4 && (a.includes(b) || b.includes(a)));
}

function scoreOf(fixture: FixtureLite): { home: number; away: number } | null {
  if (fixture.home.score === null || fixture.away.score === null) return null;
  const home = Number(fixture.home.score);
  const away = Number(fixture.away.score);
  return Number.isFinite(home) && Number.isFinite(away) && home >= 0 && away >= 0
    ? { home, away }
    : null;
}

function teamGoals(
  fixture: FixtureLite,
  teamName: string,
): { scored: number; conceded: number } | null {
  const score = scoreOf(fixture);
  if (!score) return null;
  if (sameTeam(fixture.home.name, teamName)) {
    return { scored: score.home, conceded: score.away };
  }
  if (sameTeam(fixture.away.name, teamName)) {
    return { scored: score.away, conceded: score.home };
  }
  return null;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
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

/**
 * Construct a leakage-free snapshot for `target`: every score used here comes
 * from `leagueHistory` strictly before target.date.
 */
function prematchInputs(
  target: FixtureLite,
  leagueHistory: FixtureLite[],
): CorrectScoreModelInputs {
  const kickoff = new Date(target.date).getTime();
  const prior = leagueHistory.filter(
    (fixture) =>
      fixture.state === "post" &&
      new Date(fixture.date).getTime() < kickoff &&
      scoreOf(fixture) !== null,
  );
  const historyFor = (teamName: string) =>
    prior
      .filter((fixture) => teamGoals(fixture, teamName) !== null)
      .sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime());
  const homeHistory = historyFor(target.home.name);
  const awayHistory = historyFor(target.away.name);

  if (!homeHistory.length && !awayHistory.length) return syntheticInputs(target.leagueSlug);

  const side = (teamName: string, history: FixtureLite[]): CorrectScoreTeamInputs => {
    const season = history
      .slice(0, 30)
      .map((fixture) => teamGoals(fixture, teamName))
      .filter((row): row is { scored: number; conceded: number } => row !== null);
    const lastFive = season.slice(0, 5);
    return {
      // Historical post-match xG/shots are deliberately not read: those values
      // would describe the target result, not information known beforehand.
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
      (fixture) =>
        (sameTeam(fixture.home.name, target.home.name) && sameTeam(fixture.away.name, target.away.name)) ||
        (sameTeam(fixture.home.name, target.away.name) && sameTeam(fixture.away.name, target.home.name)),
    )
    .slice(-8)
    .map((fixture) => scoreOf(fixture))
    .filter((score): score is { home: number; away: number } => score !== null)
    .map((score) => score.home + score.away);

  return {
    home: side(target.home.name, homeHistory),
    away: side(target.away.name, awayHistory),
    h2hGoalAverage: average(h2h),
    sources: ["Historical fixture cache (pre-match rolling form)"],
    // Some model fields (notably true pre-match xG) are unavailable in the
    // fixture cache, so the honest label is Mixed rather than Real.
    dataQuality: "Mixed",
  };
}

async function fetchHistoricalFixtures(days: number): Promise<FixtureLite[]> {
  const now = new Date();
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - days - HISTORY_WARMUP_DAYS);
  const range = `${fmt(from)}-${fmt(now)}`;
  const boards = await Promise.all(
    TOP_FEED_SLUGS.map((slug) =>
      fetchScoreboard(slug, range).catch((error) => {
        console.warn(
          `[CorrectScoreBacktest] fixture cache failed for ${slug}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return [] as FixtureLite[];
      }),
    ),
  );
  const seen = new Set<string>();
  return boards.flat().filter((fixture) => {
    const key = `${fixture.leagueSlug}:${fixture.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function calibrationLabel(lower: number, upper: number): string {
  if (upper > 1) return `${Math.round(lower * 100)}%+`;
  return `${Math.round(lower * 100)}–${Math.round(upper * 100)}%`;
}

function computeMetrics(evaluations: Evaluation[]): BacktestMetrics {
  if (!evaluations.length) {
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
    const { log, actualHomeGoals, actualAwayGoals, scorelines } = evaluation;
    if (log.correctTop1) top1Hits++;
    if (log.correctTop3) top3Hits++;
    if (log.correctTop5) top5Hits++;

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

async function runBacktest(days: number): Promise<CorrectScoreBacktestResponse> {
  const allFixtures = await fetchHistoricalFixtures(days);
  const cutoff = Date.now() - days * 86_400_000;
  const byLeagueHistory = new Map<string, FixtureLite[]>();
  for (const fixture of allFixtures) {
    const list = byLeagueHistory.get(fixture.leagueSlug) ?? [];
    list.push(fixture);
    byLeagueHistory.set(fixture.leagueSlug, list);
  }
  for (const list of byLeagueHistory.values()) {
    list.sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());
  }

  const targets = allFixtures
    .filter((fixture) => {
      const kickoff = new Date(fixture.date).getTime();
      return fixture.state === "post" && kickoff >= cutoff && kickoff <= Date.now() && scoreOf(fixture) !== null;
    })
    .sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime())
    .slice(0, MAX_MATCHES);

  const evaluations: Evaluation[] = targets.map((fixture) => {
    const actual = scoreOf(fixture)!;
    const inputs = prematchInputs(fixture, byLeagueHistory.get(fixture.leagueSlug) ?? []);
    const prediction = buildCorrectScorePrediction(fixture, inputs, MAX_GOALS);
    const scorelines = scorelineProbabilities(
      prediction.homeExpectedGoals,
      prediction.awayExpectedGoals,
      MAX_GOALS,
      prediction.dataQuality,
    );
    const actualScore = `${actual.home}-${actual.away}`;
    const actualIndex = scorelines.findIndex((scoreline) => scoreline.score === actualScore);
    const top3 = scorelines.slice(0, 3).map((scoreline) => scoreline.score);
    const top5 = scorelines.slice(0, 5).map((scoreline) => scoreline.score);
    return {
      actualHomeGoals: actual.home,
      actualAwayGoals: actual.away,
      scorelines,
      log: {
        fixtureId: fixture.id,
        match: `${fixture.home.name} vs ${fixture.away.name}`,
        homeTeam: fixture.home.name,
        awayTeam: fixture.away.name,
        league: fixture.leagueName,
        leagueSlug: fixture.leagueSlug,
        date: fixture.date,
        predictedTop1: scorelines[0].score,
        predictedTop1Probability: scorelines[0].probability,
        predictedTop3: top3,
        predictedTop5: top5,
        actualScore,
        actualRank: actualIndex >= 0 ? actualIndex + 1 : null,
        correctTop1: scorelines[0].score === actualScore,
        correctTop3: top3.includes(actualScore),
        correctTop5: top5.includes(actualScore),
        dataQuality: prediction.dataQuality,
      },
    };
  });

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
      ...computeMetrics(rows),
    }))
    .sort((left, right) => right.matchesTested - left.matchesTested || left.league.localeCompare(right.league));

  return {
    generatedAt: new Date().toISOString(),
    days,
    model: "correct-score-poisson-v1",
    dataSource: "Historical fixture cache; chronological pre-match rolling team statistics",
    overall: computeMetrics(evaluations),
    byLeague,
    matches: evaluations.map((evaluation) => evaluation.log),
  };
}

function requestedDays(request: Request): number {
  const value = Number(new URL(request.url).searchParams.get("days"));
  return Math.round(clamp(Number.isFinite(value) && value > 0 ? value : DEFAULT_DAYS, 7, 90));
}

async function respond(request: Request, force: boolean): Promise<Response> {
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
    const data = await runBacktest(days);
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

export async function GET(request: Request): Promise<Response> {
  return respond(request, false);
}

/** POST always runs a fresh replay; this is what the UI's Run Backtest uses. */
export async function POST(request: Request): Promise<Response> {
  return respond(request, true);
}
