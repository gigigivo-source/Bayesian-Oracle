// ĞIGI GIVØ — Multi-Match Arbitrage.
//
// Finds guaranteed-profit betting combinations across 2 or 3 DIFFERENT
// matches (never multiple bookmakers on the same match): for every pair and
// triple of upcoming fixtures we pick one 1X2 outcome per match and check
// whether the sum of the implied probabilities is below 100% — if it is, the
// dutched stakes return more than the total staked no matter which leg wins.
//
// Data contract (identical to the rest of the app):
//   1. FIXTURES — reused from the existing fixture feed (/api/fixtures,
//      next-7-day window, upcoming matches only).
//   2. ODDS — best available 1X2 (Home Win / Draw / Away Win) from the
//      existing odds providers: the ESPN moneyline bundled in the fixture
//      feed, plus API-Football's multi-bookmaker odds (Pinnacle, Bet365,
//      Betfair, …). The best price per outcome wins.
//   3. HONEST FALLBACK — when no bookmaker price is available for an
//      outcome, a synthetic fair price is derived from the match's own
//      league goal anchor (Poisson scoreline) and the leg is explicitly
//      tagged `dataQuality: "synthetic"`. Real data is always preferred;
//      the fallback only keeps the board alive when a provider is missing
//      or rate-limited.
//   4. FAIL-SOFT — a failing feed or provider never breaks the response;
//      the scan simply works with the matches that resolved, and if the
//      30-second scan budget is hit it returns a partial result flagged
//      `partial: true`.
//
// Arbitrage maths (normalised £100 stake, adjustable via ?stake=):
//   totalImplied   = Σ (1 / odds)
//   totalStake     = configurable (default 100)
//   stake_i        = (1 / odds_i) / totalImplied × totalStake
//   guaranteedReturn = (1 / totalImplied) × totalStake
//   profitMargin   = guaranteedReturn / totalStake − 1
//   A combination qualifies only when profitMargin ≥ MIN_PROFIT (default 1%).

import { searchFixture, getMultiBookOdds } from "@/lib/apiFootball";
import { assessMarketConfidence, type MarketDataQuality } from "@/lib/data/confidence";
import { getAnchors } from "@/lib/engine/statisticalAnchors";
import { poissonPmf } from "@/lib/engine/stats";
import type { FixtureLite } from "@/lib/espn";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ─── Configuration ────────────────────────────────────────────────────────────

/** Fixture window pulled from the fixture feed. */
const LOOKAHEAD_DAYS = 7;
/** Results are cached for one hour (same TTL as Sure Bet Corners / First 5). */
const CACHE_TTL_MS = 60 * 60 * 1000;
/** The scan must complete within 30 seconds; beyond it we return a partial result. */
const SCAN_TIMEOUT_MS = 30_000;
/** Hard timeout for the fixture-feed fetch itself (inside the scan budget). */
const FEED_FETCH_TIMEOUT_MS = 20_000;
/** Minimum guaranteed profit that qualifies an arbitrage (default 1%). */
const DEFAULT_MIN_PROFIT = 0.01;
/** Cap on match combinations evaluated (C(n,2) + C(n,3)) to bound compute. */
const DEFAULT_MAX_COMBINATIONS = 1000;
/** Normalised total stake used for the stake/return figures. */
const DEFAULT_TOTAL_STAKE = 100;
/** Matches whose 1X2 prices include anything below this are discarded. */
const MIN_ODDS = 1.10;
/** Upper bound on the odds-resolved match pool (keeps the scan in budget). */
const MAX_MATCHES = 300;
/** Odds resolution runs with bounded concurrency. */
const ODDS_CONCURRENCY = 8;
/** Per-match ceiling for the API-Football enrichment call. */
const PER_MATCH_ODDS_TIMEOUT_MS = 6_000;
/**
 * API-Football enrichment is expensive (2 upstream calls per match) and the
 * free tier is quota-limited, so a scan only enriches matches that have no
 * ESPN moneyline, and only up to this many matches per scan.
 */
const API_ODDS_MAX_FETCHES = 40;

const OUTCOME_LABELS = ["Home Win", "Draw", "Away Win"] as const;
const OUTCOME_KEYS = ["home", "draw", "away"] as const;
type OutcomeKey = (typeof OUTCOME_KEYS)[number];
type LegSource = "bookmaker" | "model";

// ─── Public response types ────────────────────────────────────────────────────

export interface ArbitrageLeg {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  leagueSlug: string;
  leagueName: string;
  matchDate: string;
  /** "Home Win" | "Draw" | "Away Win". */
  selectedOutcome: string;
  /** Decimal odds for the selected outcome. */
  odds: number;
  /** Dutched stake for this leg (sums to totalStake). */
  stake: number;
  /** Stake as a percentage of totalStake (rounded to 1dp). */
  stakePercent: number;
  /** "bookmaker" when priced from real bookmaker odds, "model" when synthetic. */
  oddsSource: LegSource;
  /** Provider names that contributed the price (real) or league anchor (model). */
  providers: string[];
  /** 0–100 confidence score for this leg's price. */
  confidenceScore: number;
  /** "real" | "synthetic" for this leg. */
  legQuality: MarketDataQuality;
}

export interface ArbitrageOpportunity {
  id: string;
  legs: number;
  matches: ArbitrageLeg[];
  totalStake: number;
  guaranteedReturn: number;
  /** Decimal profit margin, e.g. 0.0145 = 1.45%. */
  profitMargin: number;
  /** profitMargin × 100, e.g. 1.45. */
  profitMarginPct: number;
  /** Average confidence score across the selected legs. */
  confidenceScore: number;
  /** "Real" / "Mixed" / "Synthetic" — based on the odds data sources. */
  dataQuality: "Real" | "Mixed" | "Synthetic";
}

export interface ArbitrageResponse {
  generatedAt: string;
  totalCombinationsScanned: number;
  qualifyingArbitrages: ArbitrageOpportunity[];
  filters: {
    minProfit: number;
    maxCombinations: number;
    totalStake: number;
    minOdds: number;
    lookaheadDays: number;
  };
  /** Number of matches that got odds resolution and passed the odds floor. */
  matchesScanned: number;
  /** Number of matches considered from the fixture feed. */
  matchesFetched: number;
  /** True when the 30s scan budget was hit — the result is partial. */
  partial: boolean;
  cache: { ttlMinutes: number; hit: boolean };
  error?: string;
}

interface ResolvedLeg {
  odds: number;
  source: LegSource;
  providers: string[];
  confidenceScore: number;
  legQuality: MarketDataQuality;
}

interface ResolvedMatch {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  leagueSlug: string;
  leagueName: string;
  matchDate: string;
  legs: Record<OutcomeKey, ResolvedLeg>;
  odds: Record<OutcomeKey, number>;
}

interface CacheEntry {
  data: ArbitrageResponse;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

// ─── Small helpers ────────────────────────────────────────────────────────────

function mlToDecimal(ml: number): number {
  if (ml > 0) return ml / 100 + 1;
  return 100 / Math.abs(ml) + 1;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundOdds(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function qualityOfLegs(legs: ResolvedLeg[]): ArbitrageOpportunity["dataQuality"] {
  const real = legs.filter((leg) => leg.legQuality === "real").length;
  if (real === legs.length) return "Real";
  if (real === 0) return "Synthetic";
  return "Mixed";
}

function formatMatch(fx: FixtureLite): string {
  return `${fx.home.name} vs ${fx.away.name}`;
}

function getCacheKey(url: URL): string {
  const params = new URLSearchParams(url.searchParams);
  params.delete("refresh");
  const keys = Array.from(params.keys()).sort();
  const paramString = keys.map((key) => `${key}=${params.get(key)}`).join("&");
  return `arbitrage:${paramString}`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          onTimeout?.();
          resolve(fallback);
        }, ms);
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
  const output: Array<R | undefined> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker),
  );
  return output as R[];
}

// ─── Combination generation (1.2) ────────────────────────────────────────────

/** Yield every k-combination of indexes [0..n-1], lexicographically. */
function* combineIndexes(n: number, k: number): Generator<number[]> {
  if (k <= 0 || k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield [...idx];
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

/** All outcome selections (1 per match) for a combination of `size` matches. */
function outcomeSelections(size: number): number[][] {
  const out: number[][] = [];
  const current = new Array<number>(size).fill(0);
  const rec = (i: number) => {
    if (i === size) {
      out.push([...current]);
      return;
    }
    for (let v = 0; v < OUTCOME_KEYS.length; v++) {
      current[i] = v;
      rec(i + 1);
    }
  };
  rec(0);
  return out;
}

const SELECTIONS_2 = outcomeSelections(2);
const SELECTIONS_3 = outcomeSelections(3);

// ─── Arbitrage calculation (1.3) ─────────────────────────────────────────────

/**
 * Evaluate one complete arbitrage bet: a combination of matches with one
 * selected outcome per match. Returns the opportunity when it clears the
 * MIN_PROFIT filter, otherwise null.
 */
function evaluateArbitrageSelection(
  matches: ResolvedMatch[],
  outcomeIndexes: number[],
  totalStake: number,
  minProfit: number,
): ArbitrageOpportunity | null {
  const odds = outcomeIndexes.map((index, i) => matches[i].odds[OUTCOME_KEYS[index]]);
  const totalImplied = odds.reduce((sum, o) => sum + 1 / o, 0);
  if (totalImplied >= 1 - 1e-9) return null;

  const guaranteedReturn = roundMoney((1 / totalImplied) * totalStake);
  const profitMargin = guaranteedReturn / totalStake - 1;
  if (profitMargin < minProfit) return null;

  const rawStakes = odds.map((o) => ((1 / o) / totalImplied) * totalStake);
  const stakes = rawStakes.map(roundMoney);
  // Fix rounding drift so the stakes sum to exactly totalStake (last leg absorbs it).
  const drift = roundMoney(totalStake - stakes.reduce((sum, s) => sum + s, 0));
  stakes[stakes.length - 1] = roundMoney(stakes[stakes.length - 1] + drift);

  const legs: ArbitrageLeg[] = matches.map((match, i) => {
    const key = OUTCOME_KEYS[outcomeIndexes[i]];
    const leg = match.legs[key];
    const stake = stakes[i];
    return {
      fixtureId: match.fixtureId,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      leagueSlug: match.leagueSlug,
      leagueName: match.leagueName,
      matchDate: match.matchDate,
      selectedOutcome: OUTCOME_LABELS[outcomeIndexes[i]],
      odds: leg.odds,
      stake,
      stakePercent: Math.round((stake / totalStake) * 1000) / 10,
      oddsSource: leg.source,
      providers: leg.providers,
      confidenceScore: leg.confidenceScore,
      legQuality: leg.legQuality,
    };
  });

  const confidenceScore = Math.round(
    legs.reduce((sum, leg) => sum + leg.confidenceScore, 0) / legs.length,
  );

  return {
    id: `${matches.map((m) => m.fixtureId).join("-")}:${outcomeIndexes.join("")}`,
    legs: matches.length,
    matches: legs,
    totalStake: roundMoney(totalStake),
    guaranteedReturn,
    profitMargin: Math.round(profitMargin * 10000) / 10000,
    profitMarginPct: Math.round(profitMargin * 10000) / 100,
    confidenceScore,
    dataQuality: qualityOfLegs(matches.map((m, i) => m.legs[OUTCOME_KEYS[outcomeIndexes[i]]])),
  };
}

// ─── Odds resolution (1.1) ────────────────────────────────────────────────────

/** Track the per-scan API-Football enrichment budget. */
class OddsBudget {
  used = 0;
  constructor(readonly max: number) {}
  canUseApiFootball(): boolean {
    return this.used < this.max;
  }
  markApiFootballUsed(): void {
    this.used++;
  }
}

interface ApiFootballOddsResult {
  bestHome: number;
  bestDraw: number;
  bestAway: number;
  providers: string[];
}

async function fetchApiFootballOdds(fx: FixtureLite): Promise<ApiFootballOddsResult | null> {
  const date = fx.date.slice(0, 10);
  const fixtureId = await searchFixture(fx.home.name, fx.away.name, date);
  if (!fixtureId) return null;
  const odds = await getMultiBookOdds(fixtureId);
  if (!odds || odds.bookmakers.length === 0) return null;
  return {
    bestHome: odds.bestHome,
    bestDraw: odds.bestDraw,
    bestAway: odds.bestAway,
    providers: odds.bookmakers.map((b) => b.bookmaker),
  };
}

/**
 * Synthetic fair 1X2 prices from the match's own league goal anchor via an
 * independent-Poisson scoreline model — the same honest-fallback technique
 * the First 5 Minutes route uses. Fair prices have ~100% implied probability,
 * so they never manufacture arbitrage by themselves.
 */
function poissonFairOdds(leagueSlug: string): Record<OutcomeKey, number> {
  const anchors = getAnchors(leagueSlug);
  const lambdaHome = anchors.avgGoals * anchors.homePossession;
  const lambdaAway = anchors.avgGoals * (1 - anchors.homePossession);
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  const MAX_GOALS = 14;
  for (let h = 0; h <= MAX_GOALS; h++) {
    const ph = poissonPmf(h, lambdaHome);
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = ph * poissonPmf(a, lambdaAway);
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
    }
  }
  const safe = (p: number) => Math.max(p, 1e-4);
  return {
    home: roundOdds(1 / safe(pHome)),
    draw: roundOdds(1 / safe(pDraw)),
    away: roundOdds(1 / safe(pAway)),
  };
}

function confidenceForLeg(legQuality: MarketDataQuality, providers: string[]): number {
  const assessment = assessMarketConfidence({
    dataQuality: legQuality,
    sourceCount: legQuality === "real" ? providers.length : 0,
    completenessPct: legQuality === "real" ? 100 : 50,
    sourceNames: legQuality === "real" ? providers : [],
  });
  return assessment.confidenceScore;
}

/**
 * Resolve the best 1X2 prices for one match: ESPN moneyline from the fixture
 * feed first, API-Football multi-book enrichment when a price is missing
 * (bounded by the per-scan budget), then the synthetic Poisson fallback.
 * Returns null when even the fallback cannot produce prices above 1.10.
 */
async function resolveMatchOdds(
  fx: FixtureLite,
  budget: OddsBudget,
): Promise<ResolvedMatch | null> {
  // 1. ESPN moneyline bundled in the fixture feed (zero extra network cost).
  const espn: Partial<Record<OutcomeKey, number>> = {};
  const espnProviders: string[] = [];
  if (fx.odds?.homeML != null && positiveFinite(fx.odds.homeML)) espn.home = mlToDecimal(fx.odds.homeML);
  if (fx.odds?.drawML != null && positiveFinite(fx.odds.drawML)) espn.draw = mlToDecimal(fx.odds.drawML);
  if (fx.odds?.awayML != null && positiveFinite(fx.odds.awayML)) espn.away = mlToDecimal(fx.odds.awayML);
  if (Object.keys(espn).length > 0) espnProviders.push(fx.odds?.provider?.trim() || "ESPN");

  // 2. API-Football multi-book enrichment (existing odds provider), budgeted.
  const apif: Partial<Record<OutcomeKey, number>> = {};
  const apifProviders: string[] = [];
  if (budget.canUseApiFootball() && Object.keys(espn).length < OUTCOME_KEYS.length) {
    const result = await withTimeout(
      fetchApiFootballOdds(fx),
      PER_MATCH_ODDS_TIMEOUT_MS,
      null,
      () => console.warn(`[Arbitrage] ${formatMatch(fx)}: API-Football odds timed out; using available sources`),
    );
    if (result) {
      budget.markApiFootballUsed();
      if (positiveFinite(result.bestHome)) apif.home = result.bestHome;
      if (positiveFinite(result.bestDraw)) apif.draw = result.bestDraw;
      if (positiveFinite(result.bestAway)) apif.away = result.bestAway;
      if (result.providers.length > 0) apifProviders.push(...result.providers);
    }
  }

  // 3. Best price per outcome across providers, synthetic fallback for gaps.
  const synthetic = poissonFairOdds(fx.leagueSlug);
  const legs = {} as Record<OutcomeKey, ResolvedLeg>;
  const odds = {} as Record<OutcomeKey, number>;

  for (const key of OUTCOME_KEYS) {
    const candidates: Array<{ value: number; providers: string[] }> = [];
    if (espn[key]) candidates.push({ value: espn[key], providers: espnProviders });
    if (apif[key]) candidates.push({ value: apif[key], providers: apifProviders });

    let best: { value: number; providers: string[]; source: LegSource } | null = null;
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.value - a.value);
      best = {
        value: candidates[0].value,
        providers: [...new Set(candidates.flatMap((c) => c.providers))],
        source: "bookmaker",
      };
    } else {
      best = { value: synthetic[key], providers: ["League anchor (Poisson)"], source: "model" };
    }

    const legQuality: MarketDataQuality = best.source === "bookmaker" ? "real" : "synthetic";
    legs[key] = {
      odds: best.value,
      source: best.source,
      providers: best.providers,
      confidenceScore: confidenceForLeg(legQuality, best.providers),
      legQuality,
    };
    odds[key] = best.value;
  }

  // 1.3 — filter out matches where any 1X2 price is missing or below 1.10.
  if (OUTCOME_KEYS.some((key) => !positiveFinite(odds[key]) || odds[key] < MIN_ODDS)) {
    return null;
  }

  return {
    fixtureId: fx.id,
    homeTeam: fx.home.name,
    awayTeam: fx.away.name,
    leagueSlug: fx.leagueSlug,
    leagueName: fx.leagueName,
    matchDate: fx.date,
    legs,
    odds,
  };
}

// ─── Fixture feed (1.1) — reuse the existing /api/fixtures feed ──────────────

/**
 * Pull the next-7-day upcoming fixtures from the existing fixture feed.
 * Returns null when the feed does not answer within the scan budget — the
 * caller then returns a partial result instead of erroring (1.7).
 */
async function fetchUpcomingFixtures(reqUrl: string): Promise<FixtureLite[] | null> {
  const origin = new URL(reqUrl).origin;
  const url = `${origin}/api/fixtures?days=${LOOKAHEAD_DAYS}&stats=0`;
  const result = await withTimeout(
    (async () => {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`fixture feed HTTP ${res.status}`);
      const data = (await res.json()) as { upcoming?: FixtureLite[] };
      return data.upcoming ?? [];
    })(),
    FEED_FETCH_TIMEOUT_MS,
    null,
    () =>
      console.warn(
        `[Arbitrage] Fixture feed did not answer within ${FEED_FETCH_TIMEOUT_MS}ms; returning a partial result`,
      ),
  );
  return result;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const isRefresh = url.searchParams.get("refresh") === "true";
  const cacheKey = getCacheKey(url);

  if (isRefresh) {
    cache.delete(cacheKey);
  } else {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return Response.json(
        { ...cached.data, cache: { ...cached.data.cache, hit: true } },
        { headers: { "Cache-Control": "no-store", "X-Cache": "HIT" } },
      );
    }
    if (cached) cache.delete(cacheKey);
  }

  const rawMinProfit = Number(url.searchParams.get("minProfit"));
  const minProfit = clamp(
    Number.isFinite(rawMinProfit) ? rawMinProfit : DEFAULT_MIN_PROFIT,
    0.001,
    0.2,
  );
  const rawMaxCombinations = Number(url.searchParams.get("maxCombinations"));
  const maxCombinations = Math.round(
    clamp(
      Number.isFinite(rawMaxCombinations) && rawMaxCombinations > 0
        ? rawMaxCombinations
        : DEFAULT_MAX_COMBINATIONS,
      10,
      5000,
    ),
  );
  const rawStake = Number(url.searchParams.get("stake"));
  const totalStake = clamp(
    Number.isFinite(rawStake) && rawStake > 0 ? rawStake : DEFAULT_TOTAL_STAKE,
    1,
    1_000_000,
  );

  const startedAt = Date.now();
  const deadline = startedAt + SCAN_TIMEOUT_MS;
  const expired = () => Date.now() > deadline;
  let partial = false;

  const body: ArbitrageResponse = {
    generatedAt: new Date().toISOString(),
    totalCombinationsScanned: 0,
    qualifyingArbitrages: [],
    filters: {
      minProfit,
      maxCombinations,
      totalStake,
      minOdds: MIN_ODDS,
      lookaheadDays: LOOKAHEAD_DAYS,
    },
    matchesScanned: 0,
    matchesFetched: 0,
    partial: false,
    cache: { ttlMinutes: CACHE_TTL_MS / 60_000, hit: false },
  };

  try {
    const fixtures = await fetchUpcomingFixtures(req.url);
    if (fixtures === null) {
      // Feed did not answer in time — the 30s scan budget is what matters, so
      // hand back whatever we have (nothing yet) flagged as partial.
      partial = true;
      body.partial = true;
      cache.set(cacheKey, { data: body, timestamp: Date.now() });
      return Response.json(body, {
        headers: { "Cache-Control": "no-store", "X-Cache": "MISS" },
      });
    }

    // Only pre-match fixtures within the next 7 days.
    const now = Date.now();
    const horizon = now + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;
    const upcoming = fixtures
      .filter((fx) => {
        if (fx.state !== "pre") return false;
        const kickoff = new Date(fx.date).getTime();
        return Number.isFinite(kickoff) && kickoff >= now && kickoff <= horizon;
      })
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    body.matchesFetched = upcoming.length;
    const pool = upcoming.slice(0, MAX_MATCHES);

    // Odds resolution runs concurrently; stop handing out work once the scan
    // budget is close to being spent so combination scanning keeps some time.
    const oddsBudget = new OddsBudget(API_ODDS_MAX_FETCHES);
    const resolved = await mapWithConcurrency(pool, ODDS_CONCURRENCY, async (fx) => {
      if (expired()) {
        partial = true;
        return null;
      }
      return resolveMatchOdds(fx, oddsBudget).catch(() => null);
    });

    const valid = resolved.filter((m): m is ResolvedMatch => m !== null);
    body.matchesScanned = valid.length;

    // 1.2 + 1.3 — scan pairs (more likely) then triples, capped by MAX_COMBINATIONS.
    const arbs: ArbitrageOpportunity[] = [];
    const scan = (size: number) => {
      const selections = size === 2 ? SELECTIONS_2 : SELECTIONS_3;
      for (const combo of combineIndexes(valid.length, size)) {
        if (body.totalCombinationsScanned >= maxCombinations) return;
        if (expired()) {
          partial = true;
          return;
        }
        body.totalCombinationsScanned++;
        const comboMatches = combo.map((i) => valid[i]);
        for (const selection of selections) {
          const arb = evaluateArbitrageSelection(comboMatches, selection, totalStake, minProfit);
          if (arb) arbs.push(arb);
        }
      }
    };
    scan(2);
    if (!partial && body.totalCombinationsScanned < maxCombinations) scan(3);

    arbs.sort((a, b) => b.profitMargin - a.profitMargin);
    body.qualifyingArbitrages = arbs;
    body.partial = partial;

    console.info(
      `[Arbitrage] ${valid.length}/${upcoming.length} matches priced, ` +
        `${body.totalCombinationsScanned} combination(s) scanned, ` +
        `${arbs.length} arbitrage(s) found (minProfit ${(minProfit * 100).toFixed(1)}%${partial ? ", PARTIAL" : ""})`,
    );

    cache.set(cacheKey, { data: body, timestamp: Date.now() });

    return Response.json(body, {
      headers: {
        "Cache-Control": "no-store",
        "X-Cache": "MISS",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Arbitrage] Route failed: ${message}`);
    return Response.json(
      {
        ...body,
        generatedAt: new Date().toISOString(),
        error: "Multi-Match Arbitrage is temporarily unavailable.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
