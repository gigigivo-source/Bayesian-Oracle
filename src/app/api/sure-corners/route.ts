import { statsAggregator } from "@/lib/data/aggregator";
import type { CanonicalMatchStats } from "@/lib/data/types";
import { fetchScoreboard, fetchSummary, type FixtureLite, type MatchSummary } from "@/lib/espn";
import { runEngineFromRealWithProfiles, type EngineResult, type Market } from "@/lib/engine";
import { betaBinomOver, poissonPmf } from "@/lib/engine/stats";
import { LEAGUE_TIER, leagueTier } from "@/lib/leaguePriority";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MIN_HIT_RATE = 0.98;
const MIN_CORNER_WINNER_PROBABILITY = 0.80;
const MIN_HANDICAP_PROBABILITY = 0.85;
const LOOKAHEAD_DAYS = 7; // Changed from 14 to 7 per requirement: fetch next 7 days
const REAL_STATS_TIMEOUT_MS = 20_000;
const TEAM_CORNER_LINES = [5.5, 6.5, 7.5, 8.5] as const;
const TOTAL_CORNER_LINES = [6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 14.5] as const;
const HANDICAP_LINES = [3.5, 2.5, 1.5, 0.5] as const;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour TTL

type CacheEntry = {
  data: SureCornersResponse;
  timestamp: number;
};

// In-memory cache at module level for 1-hour TTL
const cache = new Map<string, CacheEntry>();

function getCacheKey(url: URL): string {
  // Key includes date range (7 days) and any other filters
  // For sure-corners, we include all search params except refresh
  const params = new URLSearchParams(url.searchParams);
  params.delete("refresh");
  const sortedKeys = Array.from(params.keys()).sort();
  const paramString = sortedKeys.map((k) => `${k}=${params.get(k)}`).join("&");
  // Include the 7-day range identifier so cache is tied to that window
  return `sure-corners:${LOOKAHEAD_DAYS}d:${paramString}`;
}

/** The only competition tiers that are eligible for this intentionally narrow feed. */
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
  confidence: "HIGH";
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
  realStats: true;
  statsSource: string;
  predictedCorners: {
    home: number;
    away: number;
    difference: number;
    strongerTeam: string | null;
  };
  markets: SureCornerMarket[];
}

export interface SureCornersResponse {
  generatedAt: string;
  totalFixturesChecked: number;
  rejectedMatches: number;
  rejectionReasons: Record<string, number>;
  matches: SureCornerMatch[];
  filters: {
    minimumHitRate: number;
    requiredConfidence: "HIGH";
    requiresRealPerMatchCorners: true;
    allowedLeagueTiers: number[];
    totalCornerLines: readonly number[];
    teamCornerLines: readonly number[];
    marketTypes: SureCornerMarketType[];
  };
}

interface EvaluatedMarket extends SureCornerMarket {
  accepted: boolean;
  rejectionReason?: string;
}

interface StrengthProfile {
  home: number;
  away: number;
  gap: number;
  stronger: "home" | "away" | null;
}

interface CornerExpectations {
  home: number;
  away: number;
  difference: number;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * A stats response is eligible only when both teams have per-match corners.
 * In particular, avgCornersPerGame is deliberately not consulted here: it is
 * historical context, not the real fixture statistic required by this feed.
 */
function hasRealPerMatchCorners(stats: CanonicalMatchStats | null): stats is CanonicalMatchStats {
  return Boolean(
    stats &&
      stats.metadata.source.trim().length > 0 &&
      isFiniteNonNegative(stats.home.corners) &&
      isFiniteNonNegative(stats.away.corners),
  );
}

function formatMatch(fx: FixtureLite): string {
  return `${fx.home.name} versus ${fx.away.name}`;
}

function dateRange(days: number): string {
  const from = new Date();
  const to = new Date(from);
  to.setDate(from.getDate() + days);
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  return `${fmt(from)}-${fmt(to)}`;
}

function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function modelLambda(result: EngineResult, key: string): number | null {
  const value = result.lambdas[key];
  return isFiniteNonNegative(value) ? value : null;
}

/**
 * Keep the engine's real-data model in the expectation, but anchor it to the
 * two real corner observations that passed the gate. No league average or
 * missing-stat fallback can enter a qualifying result.
 */
function expectedCorners(result: EngineResult, stats: CanonicalMatchStats): CornerExpectations {
  const modelHome = modelLambda(result, "λ Home Corners") ?? stats.home.corners!;
  const modelAway = modelLambda(result, "λ Away Corners") ?? stats.away.corners!;
  const home = round(stats.home.corners! * 0.65 + modelHome * 0.35, 2);
  const away = round(stats.away.corners! * 0.65 + modelAway * 0.35, 2);
  return { home, away, difference: round(Math.abs(home - away), 2) };
}

function pairRatio(home: number | null, away: number | null): [number, number] | null {
  if (!isFiniteNonNegative(home) || !isFiniteNonNegative(away) || home + away <= 0) return null;
  return [home / (home + away), away / (home + away)];
}

/**
 * Estimate relative team strength only from paired real signals. Corners are
 * mandatory and receive the largest weight; other available real match stats
 * and recent-form points provide context without inventing missing values.
 */
function teamStrength(stats: CanonicalMatchStats, summary: MatchSummary): StrengthProfile {
  const components: Array<{ pair: [number, number]; weight: number }> = [];
  const add = (home: number | null, away: number | null, weight: number) => {
    const pair = pairRatio(home, away);
    if (pair) components.push({ pair, weight });
  };

  add(stats.home.corners, stats.away.corners, 0.55);
  add(stats.home.possession, stats.away.possession, 0.15);
  add(stats.home.shots, stats.away.shots, 0.10);
  add(stats.home.xg, stats.away.xg, 0.10);

  if (summary.homeForm && summary.awayForm) {
    const homePointsPerGame = summary.homeForm.points / Math.max(1, summary.homeForm.games.length);
    const awayPointsPerGame = summary.awayForm.points / Math.max(1, summary.awayForm.games.length);
    add(homePointsPerGame, awayPointsPerGame, 0.10);
  }

  const totalWeight = components.reduce((sum, component) => sum + component.weight, 0);
  if (totalWeight === 0) return { home: 0.5, away: 0.5, gap: 0, stronger: null };
  const home = components.reduce((sum, component) => sum + component.pair[0] * component.weight, 0) / totalWeight;
  const away = components.reduce((sum, component) => sum + component.pair[1] * component.weight, 0) / totalWeight;
  const gap = Math.abs(home - away);

  // A 14 percentage-point composite gap is a deliberately conservative
  // definition of a clearly stronger side for line-differentiation rules.
  const stronger = gap >= 0.14 ? (home > away ? "home" : "away") : null;
  return { home, away, gap, stronger };
}

function engineCornerMarket(
  result: EngineResult,
  teamName: string,
  line: number,
): Market | undefined {
  const name = `${teamName} Corners O/U ${line.toFixed(1)}`;
  return result.markets.find((market) => market.name === name);
}

function engineTotalCornerMarket(result: EngineResult, line: number): Market | undefined {
  const name = `Total Corners O/U ${line.toFixed(1)}`;
  return result.markets.find((market) => market.name === name);
}

function engineReason(
  result: EngineResult,
  market: Market | undefined,
  expectations: CornerExpectations,
  statsSource: string,
): string {
  if (market?.reason) return market.reason;
  const fallbackEngineReason = result.markets.find((candidate) => candidate.family === "Corners" && candidate.reason)?.reason;
  if (fallbackEngineReason) return fallbackEngineReason;
  return `Engine corner model expects ${expectations.home.toFixed(1)} home and ${expectations.away.toFixed(1)} away corners, anchored by real per-match corner stats from ${statsSource}.`;
}

function marketEligibility(
  hitRate: number,
  confidence: "HIGH",
  engineRejected = false,
  engineRejectReason?: string,
): { accepted: boolean; rejectionReason?: string } {
  if (engineRejected) return { accepted: false, rejectionReason: engineRejectReason ?? "engine rejected the market" };
  if (confidence !== "HIGH") return { accepted: false, rejectionReason: "confidence was not HIGH" };
  if (!Number.isFinite(hitRate) || hitRate < MIN_HIT_RATE) {
    return { accepted: false, rejectionReason: `hit rate ${hitRate.toFixed(2)} was less than ${MIN_HIT_RATE.toFixed(2)}` };
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
  engineMarket?: Market,
): EvaluatedMarket {
  const safeHitRate = round(Math.max(0, Math.min(1, hitRate)), 4);
  const gate = marketEligibility(
    safeHitRate,
    "HIGH",
    engineMarket?.rejected,
    engineMarket?.rejectReason,
  );
  return {
    id: `${marketType.toLowerCase().replaceAll(" ", "-")}-${line ?? selection.toLowerCase().replaceAll(" ", "-")}`,
    marketType,
    name,
    selection,
    line,
    hitRate: safeHitRate,
    confidence: "HIGH",
    reason,
    accepted: gate.accepted,
    rejectionReason: gate.rejectionReason,
  };
}

function bestMarket(markets: EvaluatedMarket[]): EvaluatedMarket | null {
  const accepted = markets.filter((market) => market.accepted);
  if (!accepted.length) return null;
  return [...accepted].sort((a, b) => b.hitRate - a.hitRate)[0] ?? null;
}

function buildOuMarket(
  result: EngineResult,
  marketType: "Total Corners" | "Team 1 Corners" | "Team 2 Corners",
  teamName: string | null,
  expected: number,
  line: number,
  expectations: CornerExpectations,
  statsSource: string,
): EvaluatedMarket {
  const engineMarket = teamName
    ? engineCornerMarket(result, teamName, line)
    : engineTotalCornerMarket(result, line);
  const overProbability = betaBinomOver(line, expected, teamName ? 12 : 20);
  const selectedOver = engineMarket?.selection.startsWith("Over") ?? overProbability >= 0.5;
  const selection = selectedOver ? `Over ${line.toFixed(1)}` : `Under ${line.toFixed(1)}`;
  const hitRate = engineMarket?.hitRate ?? Math.max(overProbability, 1 - overProbability);
  const label = teamName ?? "total";
  const reason = engineReason(result, engineMarket, expectations, statsSource);
  return makeEvaluatedMarket(
    marketType,
    `${label} Corners O/U ${line.toFixed(1)}`,
    selection,
    line,
    hitRate,
    reason,
    engineMarket,
  );
}

function cornerWinnerProbability(favoured: number, other: number): number {
  const limit = Math.min(60, Math.max(25, Math.ceil(Math.max(favoured, other)) + 18));
  let probability = 0;
  for (let favouredCorners = 0; favouredCorners <= limit; favouredCorners++) {
    for (let otherCorners = 0; otherCorners <= limit; otherCorners++) {
      if (favouredCorners > otherCorners) {
        probability += poissonPmf(favouredCorners, favoured) * poissonPmf(otherCorners, other);
      }
    }
  }
  return Math.max(0, Math.min(1, probability));
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
  return Math.max(0, Math.min(1, probability));
}

function buildWinnerMarket(
  result: EngineResult,
  stronger: "home" | "away",
  fx: FixtureLite,
  expectations: CornerExpectations,
  statsSource: string,
): EvaluatedMarket {
  const favouredName = stronger === "home" ? fx.home.name : fx.away.name;
  const otherName = stronger === "home" ? fx.away.name : fx.home.name;
  const favouredCorners = stronger === "home" ? expectations.home : expectations.away;
  const otherCorners = stronger === "home" ? expectations.away : expectations.home;
  const probability = cornerWinnerProbability(favouredCorners, otherCorners);
  const engineMarket = result.markets.find(
    (market) => market.name === "Most Corners" && market.selection === favouredName,
  );
  const reason = engineReason(result, engineMarket, expectations, statsSource);
  return makeEvaluatedMarket(
    "Corner Winner",
    "Corner Winner",
    `${favouredName} to win corners`,
    null,
    probability,
    `${reason} Predicted corner difference is ${expectations.difference.toFixed(1)} and the engine gives ${favouredName} a ${(probability * 100).toFixed(1)}% corner-count win probability over ${otherName}.`,
    undefined,
  );
}

function buildHandicapMarket(
  result: EngineResult,
  stronger: "home" | "away",
  fx: FixtureLite,
  expectations: CornerExpectations,
  statsSource: string,
): EvaluatedMarket | null {
  const favouredName = stronger === "home" ? fx.home.name : fx.away.name;
  const favouredCorners = stronger === "home" ? expectations.home : expectations.away;
  const otherCorners = stronger === "home" ? expectations.away : expectations.home;
  const engineReasonText = engineReason(result, undefined, expectations, statsSource);

  for (const handicap of HANDICAP_LINES) {
    const probability = handicapCoverProbability(favouredCorners, otherCorners, handicap);
    const candidate = makeEvaluatedMarket(
      "Corner Handicap",
      "Corner Handicap",
      `${favouredName} -${handicap.toFixed(1)} corners`,
      handicap,
      probability,
      `${engineReasonText} Predicted corner difference is ${expectations.difference.toFixed(1)}; ${favouredName} covers -${handicap.toFixed(1)} in ${(probability * 100).toFixed(1)}% of the engine's corner-count scenarios.`,
    );
    if (probability >= MIN_HANDICAP_PROBABILITY && candidate.accepted) return candidate;
  }
  return null;
}

function evaluateFixture(
  fx: FixtureLite,
  stats: CanonicalMatchStats,
  summary: MatchSummary,
  result: EngineResult,
): SureCornerMatch | null {
  const expectations = expectedCorners(result, stats);
  const strength = teamStrength(stats, summary);
  const markets: EvaluatedMarket[] = [];

  const totalOptions = TOTAL_CORNER_LINES.map((line) =>
    buildOuMarket(result, "Total Corners", null, expectations.home + expectations.away, line, expectations, stats.metadata.source),
  );
  const total = bestMarket(totalOptions);
  if (total) markets.push(total);

  const homeOptions = TEAM_CORNER_LINES.map((line) =>
    buildOuMarket(result, "Team 1 Corners", fx.home.name, expectations.home, line, expectations, stats.metadata.source),
  );
  const awayOptions = TEAM_CORNER_LINES.map((line) =>
    buildOuMarket(result, "Team 2 Corners", fx.away.name, expectations.away, line, expectations, stats.metadata.source),
  );

  // A clear strength gap must be visible in the selected lines, not merely in
  // the explanation. If a differentiated pair cannot pass every gate, neither
  // team line is shown for this match.
  if (strength.stronger) {
    const pairs = homeOptions.flatMap((home) => awayOptions.map((away) => ({ home, away })));
    const differentiated = pairs.filter(({ home, away }) =>
      home.line !== null && away.line !== null &&
      (strength.stronger === "home"
        ? home.accepted && away.accepted && home.line >= away.line + 1
        : home.accepted && away.accepted && away.line >= home.line + 1),
    );
    const pair = [...differentiated].sort((a, b) =>
      (b.home.hitRate + b.away.hitRate) - (a.home.hitRate + a.away.hitRate),
    )[0];
    if (pair) {
      markets.push(pair.home, pair.away);
    } else if (homeOptions.some((market) => market.accepted) && awayOptions.some((market) => market.accepted)) {
      console.info(`SureCorners rejected ${formatMatch(fx)} because corner lines were identical for both teams or less than 1.0 corner apart.`);
    }
  } else {
    const home = bestMarket(homeOptions);
    const away = bestMarket(awayOptions);
    if (home) markets.push(home);
    if (away) markets.push(away);
  }

  // These directional markets are deliberately evaluated after the real-data
  // strength profile. The 80%/85% rules are necessary but not sufficient: the
  // global 98% gate below still applies to both markets.
  if (strength.stronger && expectations.difference > 2.0) {
    const winner = buildWinnerMarket(result, strength.stronger, fx, expectations, stats.metadata.source);
    if (winner.hitRate >= MIN_CORNER_WINNER_PROBABILITY && winner.accepted) markets.push(winner);
  }

  if (strength.stronger && expectations.difference > 2.5) {
    const handicap = buildHandicapMarket(result, strength.stronger, fx, expectations, stats.metadata.source);
    if (handicap) markets.push(handicap);
  }

  if (!markets.length) return null;
  return {
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
    statsSource: stats.metadata.source,
    predictedCorners: {
      home: expectations.home,
      away: expectations.away,
      difference: expectations.difference,
      strongerTeam: strength.stronger === "home" ? fx.home.name : strength.stronger === "away" ? fx.away.name : null,
    },
    markets: markets.map(({ accepted: _accepted, rejectionReason: _rejectionReason, ...market }) => market),
  };
}

async function fetchRealStats(fx: FixtureLite): Promise<CanonicalMatchStats | null> {
  try {
    return await Promise.race([
      statsAggregator.fetch({
        leagueSlug: fx.leagueSlug,
        eventId: fx.id,
        homeTeam: fx.home.name,
        awayTeam: fx.away.name,
        date: fx.date,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), REAL_STATS_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

  // Handle cache for non-refresh requests
  if (!isRefresh) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return Response.json(cached.data, {
        headers: { "Cache-Control": "no-store", "X-Cache": "HIT" },
      });
    }
    if (cached) {
      cache.delete(cacheKey);
    }
  } else {
    // Refresh requested: delete existing cache entry to force fresh calculation
    cache.delete(cacheKey);
  }

  const rejectionReasons: Record<string, number> = {};
  let rejectedMatches = 0;
  const reject = (fx: FixtureLite, key: string, detail: string) => {
    rejectedMatches++;
    rejectionReasons[key] = (rejectionReasons[key] ?? 0) + 1;
    console.info(`SureCorners rejected ${formatMatch(fx)} because ${detail}.`);
  };

  try {
    // Fetch fixtures for the next 7 days (inclusive) per requirement
    const range = dateRange(LOOKAHEAD_DAYS);
    const boards = await Promise.all(
      SURE_CORNERS_LEAGUES.map(async (slug) => {
        try {
          return await fetchScoreboard(slug, range);
        } catch (error) {
          console.warn(`SureCorners fixture feed failed for ${slug}: ${error instanceof Error ? error.message : String(error)}`);
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
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const evaluated = await mapWithConcurrency(fixtures, 8, async (fx) => {
      const stats = await fetchRealStats(fx);
      if (!hasRealPerMatchCorners(stats)) {
        reject(fx, "realStats", "real per-match corner statistics were unavailable (fallback and average data are not eligible)");
        return null;
      }

      const summary = await fetchSummary(fx.leagueSlug, fx.id).catch(() => null);
      if (!summary) {
        reject(fx, "summary", "the real match summary was unavailable");
        return null;
      }

      try {
        const prediction = await runEngineFromRealWithProfiles(fx, summary);
        const match = evaluateFixture(fx, stats, summary, prediction);
        if (!match) {
          reject(fx, "marketGate", `no corner market passed hit rate ${MIN_HIT_RATE.toFixed(2)}, HIGH confidence, and the team-strength-aware rules`);
        }
        return match;
      } catch (error) {
        reject(fx, "engine", `the prediction engine failed (${error instanceof Error ? error.message : String(error)})`);
        return null;
      }
    });

    const matches = evaluated
      .filter((match): match is SureCornerMatch => match !== null)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const body: SureCornersResponse = {
      generatedAt: new Date().toISOString(),
      totalFixturesChecked: fixtures.length,
      rejectedMatches,
      rejectionReasons,
      matches,
      filters: {
        minimumHitRate: MIN_HIT_RATE,
        requiredConfidence: "HIGH",
        requiresRealPerMatchCorners: true,
        allowedLeagueTiers: [1, 2],
        totalCornerLines: TOTAL_CORNER_LINES,
        teamCornerLines: TEAM_CORNER_LINES,
        marketTypes: ["Total Corners", "Team 1 Corners", "Team 2 Corners", "Corner Winner", "Corner Handicap"],
      },
    };

    console.info(`SureCorners checked ${fixtures.length} fixtures (7-day window), accepted ${matches.length}, rejected ${rejectedMatches}.`);

    // Store in cache with fresh timestamp
    cache.set(cacheKey, { data: body, timestamp: Date.now() });

    return Response.json(body, {
      headers: {
        "Cache-Control": "no-store",
        "X-Cache": isRefresh ? "REFRESH" : "MISS",
      },
    });
  } catch (error) {
    console.error(`SureCorners route failed: ${error instanceof Error ? error.message : String(error)}`);
    return Response.json(
      {
        generatedAt: new Date().toISOString(),
        totalFixturesChecked: 0,
        rejectedMatches,
        rejectionReasons: { route: 1 },
        matches: [],
        error: "Sure Bet Corners is temporarily unavailable. No match was shown without passing every gate.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
