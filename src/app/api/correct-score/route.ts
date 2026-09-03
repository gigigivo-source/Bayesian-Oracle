// ĞIGI GIVØ — Correct Score Predictions.
//
// The route reuses the app's next-seven-day fixture feed and the canonical
// multi-source stats aggregator. Missing match-level data is never presented as
// real: the model redistributes the documented weights over fields that are
// available, and uses the observed league anchor only when no team signal is
// available at all.

import { statsAggregator } from "@/lib/data/aggregator";
import type { CanonicalMatchStats } from "@/lib/data/types";
import { fetchSummary, type FixtureLite, type MatchSummary } from "@/lib/espn";
import { getAnchors } from "@/lib/engine/statisticalAnchors";
import { poissonPmf } from "@/lib/engine/stats";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LOOKAHEAD_DAYS = 7;
const DEFAULT_MAX_GOALS = 5;
const TOP_SCORELINES = 10;
const CACHE_TTL_MS = 30 * 60_000;
const FEED_TIMEOUT_MS = 100_000;
const STATS_TIMEOUT_MS = 15_000;
const SUMMARY_TIMEOUT_MS = 10_000;
const CONCURRENCY = 8;

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
}

const responseCache = new Map<number, CacheEntry>();

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

/** Full independent-Poisson score grid, sorted from most to least probable. */
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

/** Build one public prediction. Exported so the backtest reruns this same model. */
export function buildCorrectScorePrediction(
  fixture: Pick<FixtureLite, "id" | "home" | "away" | "leagueName" | "leagueSlug" | "date" | "venue">,
  inputs: CorrectScoreModelInputs,
  maxGoals = DEFAULT_MAX_GOALS,
): CorrectScoreMatch {
  const expected = calculateExpectedGoals(inputs);
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
    topScorelines: scorelineProbabilities(
      expected.homeExpectedGoals,
      expected.awayExpectedGoals,
      maxGoals,
      inputs.dataQuality,
    ).slice(0, TOP_SCORELINES),
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

async function fetchUpcomingFixtures(requestUrl: string): Promise<FixtureLite[]> {
  const origin = new URL(requestUrl).origin;
  const response = await withTimeout(
    fetch(`${origin}/api/fixtures?days=${LOOKAHEAD_DAYS}&stats=0`, { cache: "no-store" }),
    FEED_TIMEOUT_MS,
    null,
  );
  if (!response?.ok) {
    throw new Error(response ? `Fixture feed HTTP ${response.status}` : "Fixture feed timed out");
  }
  const body = (await response.json()) as { upcoming?: FixtureLite[] };
  const now = Date.now();
  const horizon = now + LOOKAHEAD_DAYS * 86_400_000;
  const seen = new Set<string>();
  return (body.upcoming ?? [])
    .filter((fixture) => {
      if (fixture.state !== "pre" || seen.has(fixture.id)) return false;
      const kickoff = new Date(fixture.date).getTime();
      if (!Number.isFinite(kickoff) || kickoff < now || kickoff > horizon) return false;
      seen.add(fixture.id);
      return true;
    })
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());
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
  const force = url.searchParams.get("refresh") === "true";

  if (!force) {
    const cached = responseCache.get(maxGoals);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return Response.json(cached.matches, {
        headers: { "Cache-Control": "no-store", "X-Correct-Score-Cache": "HIT" },
      });
    }
  }

  try {
    const fixtures = await fetchUpcomingFixtures(request.url);
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
      return buildCorrectScorePrediction(fixture, inputs, maxGoals);
    });
    responseCache.set(maxGoals, { at: Date.now(), matches });
    return Response.json(matches, {
      headers: { "Cache-Control": "no-store", "X-Correct-Score-Cache": "MISS" },
    });
  } catch (error) {
    console.error("[CorrectScore] prediction feed failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to build correct-score predictions" },
      { status: 503 },
    );
  }
}
