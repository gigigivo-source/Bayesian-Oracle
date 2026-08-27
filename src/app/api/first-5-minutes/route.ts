// ĞIGI GIVØ — First 5 Minutes Markets.
//
// Predicts whether a goal, corner, card or penalty happens inside the opening
// five minutes of every upcoming fixture (next 7 days).
//
// Integrity contract (identical to the rest of the app):
//   1. REAL DATA FIRST — every market baseline is pulled from the multi-source
//      stats aggregator (src/lib/data/aggregator.ts).
//   2. HONEST FALLBACK — when no source can supply a team-level baseline the
//      league anchor (observed long-run league average) is used instead and the
//      market is explicitly tagged `origin: "league"` (Synthetic Baseline).
//   3. FAIL-SOFT — a failing aggregator, source or fixture feed never breaks
//      the response; that fixture simply falls back to the league baseline.
//
// ── Model ────────────────────────────────────────────────────────────────────
// Every market is modelled as a Poisson arrival process over match time:
//
//   λ_match  = expected events for the WHOLE match (real stats → league anchor)
//   λ_window = λ_match × (5 / 96) × openingIntensity × tempo
//   P(Yes)   = 1 − exp(−λ_window)
//   fairOdds = 1 / P(outcome)
//   1xBet    = fair odds snapped to the 1xBet decimal ladder
//
// `openingIntensity` corrects the naive uniform-minute assumption with the
// observed shape of the opening five minutes (goals and especially cards are
// rarer than a uniform split implies; corners are close to uniform).

import { statsAggregator } from "@/lib/data/aggregator";
import type { CanonicalMatchStats, TeamStats } from "@/lib/data/types";
import { fetchScoreboard, type FixtureLite, type TeamLite } from "@/lib/espn";
import { getAnchors, type LeagueAnchors } from "@/lib/engine/statisticalAnchors";
import { LEAGUE_TIER, leagueTier } from "@/lib/leaguePriority";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ─── Configuration ────────────────────────────────────────────────────────────

/** Fixture window shown on the page. */
const LOOKAHEAD_DAYS = 7;
/** Part 5 — results are cached for one hour (same TTL as Sure Bet Corners). */
const CACHE_TTL_MS = 60 * 60 * 1000;
/** The prediction window, in minutes. */
const WINDOW_MINUTES = 5;
/** Effective match length including stoppage time. */
const MATCH_MINUTES = 96;
/** Upper bound on fixtures scored in one request (keeps the route bounded). */
const MAX_FIXTURES = 60;
/** Fixtures scored in parallel. */
const CONCURRENCY = 8;
/**
 * Per-fixture ceiling for the aggregator walk. The aggregator already applies
 * its own per-source timeout; this only stops one pathological fixture from
 * holding the whole feed hostage — it then rides the league baseline.
 */
const STATS_TIMEOUT_MS = 15_000;
/** Competition tiers included in the feed. */
const MAX_LEAGUE_TIER = 3;
/** Label used whenever the aggregator cannot supply a real source. */
export const SYNTHETIC_BASELINE = "Synthetic Baseline";
/** Hit-rate threshold that flips the "Likely Guaranteed" flag. */
export const GUARANTEED_HIT_RATE = 0.95;

/**
 * Share of the match's events that land in minutes 0–5, relative to a uniform
 * split. Derived from observed opening-phase distributions: teams start
 * cautiously (goals ~0.45× uniform), referees are lenient early (cards
 * ~0.25×), penalties track fouls in the box (~0.5×) and corners arrive almost
 * uniformly from the first attacks (~0.78×).
 */
const OPENING_INTENSITY = {
  goal: 0.45,
  corner: 0.78,
  card: 0.25,
  penalty: 0.5,
} as const;

/**
 * League-average penalties per match. The anchors table has no penalty column,
 * so the observed ~0.26 penalties/match baseline is scaled by how foul-heavy
 * the competition is relative to the reference league.
 */
const BASE_PENALTIES_PER_MATCH = 0.26;
const REFERENCE_FOULS_PER_MATCH = 21.0;

// ─── Public types ─────────────────────────────────────────────────────────────

export type First5MarketKey = "goal" | "corner" | "card" | "penalty";
export type First5Outcome = "Yes" | "No";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
/** Where the per-match baseline came from: real stats, mixed, or league avg. */
export type BaselineOrigin = "real" | "partial" | "league";

/** One side of a dual-outcome market (Yes or No) with every displayed metric. */
export interface First5OutcomeSide {
  label: First5Outcome;
  /** Probability of this side. */
  probability: number;
  /** Same as probability — the displayed hit rate for this side. */
  hitRate: number;
  /** 1 / probability. */
  fairOdds: number;
  /** Fair odds snapped onto the 1xBet decimal ladder. */
  odds1xBet: number;
  confidence: Confidence;
}

export interface First5Market {
  id: string;
  key: First5MarketKey;
  /** e.g. "Goal in First 5 Minutes". */
  label: string;
  /** e.g. "Goal". */
  shortLabel: string;
  icon: string;
  /** The more likely outcome (kept for sorting / filters). */
  outcome: First5Outcome;
  /** P(event happens in minutes 0–5). */
  probability: number;
  /** Probability of the more likely outcome. */
  hitRate: number;
  /** 1 / hitRate. */
  fairOdds: number;
  /** 1xBet-style decimal prices for both sides. */
  odds: { yes: number; no: number; selected: number };
  /** Dual-outcome payload — both sides are always populated. */
  yes: First5OutcomeSide;
  no: First5OutcomeSide;
  /** True when either side has hit rate ≥ 95%. */
  isGuaranteed: boolean;
  confidence: Confidence;
  /** λ for the 5-minute window. */
  expectedInWindow: number;
  /** λ for the full match (the baseline the window is derived from). */
  expectedPerMatch: number;
  origin: BaselineOrigin;
  /**
   * Aggregator metadata.source (e.g. SportScore, API-Football) or
   * "Synthetic Baseline" when the aggregator returned null / the market
   * rode the league average.
   */
  statsSource: string;
  /** Human-readable data provenance. */
  source: string;
  reason: string;
}

export interface First5Match {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  homeLogo: string | null;
  awayLogo: string | null;
  league: string;
  leagueSlug: string;
  leagueTier: number;
  date: string;
  venue: string | null;
  /** Aggregator source that contributed the most fields (or Synthetic Baseline). */
  statsSource: string;
  /** Worst-case origin across the four markets. */
  dataOrigin: BaselineOrigin;
  /** How many of the four markets are grounded in real team data. */
  realMarketCount: number;
  markets: First5Market[];
}

export interface First5MinutesResponse {
  generatedAt: string;
  windowMinutes: number;
  lookaheadDays: number;
  totalFixturesChecked: number;
  totalMatches: number;
  /** Markets produced for every match, in display order. */
  marketTypes: Array<{ key: First5MarketKey; label: string; icon: string }>;
  model: {
    description: string;
    matchMinutes: number;
    openingIntensity: Record<First5MarketKey, number>;
  };
  cache: { ttlMinutes: number; hit: boolean };
  matches: First5Match[];
  error?: string;
}

// ─── Cache (Part 5) ───────────────────────────────────────────────────────────

interface CacheEntry {
  data: First5MinutesResponse;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function getCacheKey(url: URL): string {
  const params = new URLSearchParams(url.searchParams);
  params.delete("refresh");
  const paramString = Array.from(params.keys())
    .sort()
    .map((key) => `${key}=${params.get(key)}`)
    .join("&");
  return `first-5-minutes:${LOOKAHEAD_DAYS}d:${paramString}`;
}

// ─── Small helpers ────────────────────────────────────────────────────────────

const MARKET_META: Record<First5MarketKey, { label: string; shortLabel: string; icon: string }> = {
  goal: { label: "Goal in First 5 Minutes", shortLabel: "Goal", icon: "⚽" },
  corner: { label: "Corner in First 5 Minutes", shortLabel: "Corner", icon: "🏁" },
  card: { label: "Card in First 5 Minutes", shortLabel: "Card", icon: "🟨" },
  penalty: { label: "Penalty in First 5 Minutes", shortLabel: "Penalty", icon: "⚠️" },
};

const MARKET_ORDER: First5MarketKey[] = ["goal", "corner", "card", "penalty"];

/** Competitions included in the feed (tier 1–3 of the shared priority table). */
const FIRST_5_LEAGUES = Object.entries(LEAGUE_TIER)
  .filter(([, tier]) => tier <= MAX_LEAGUE_TIER)
  .map(([slug]) => slug);

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
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

/** Poisson: probability of at least one arrival given the window intensity. */
export function atLeastOne(lambda: number): number {
  return 1 - Math.exp(-Math.max(0, lambda));
}

/**
 * Confidence from the outcome's own probability:
 *   HIGH   ≥ 80%
 *   MEDIUM 60% – 79%
 *   LOW    < 60%
 */
export function confidenceFor(probability: number): Confidence {
  if (probability >= 0.8) return "HIGH";
  if (probability >= 0.6) return "MEDIUM";
  return "LOW";
}

/** Decimal odds, never quoted below the 1.01 floor books use. */
export function fairOddsFor(probability: number): number {
  const safe = clamp(probability, 1e-4, 0.999);
  return round(1 / safe, 2);
}

/**
 * Snap decimal odds onto the 1xBet-style ladder:
 *   < 1.20  → 0.005 ticks  (1.03, 1.125)
 *   < 2.00  → 0.01 ticks   (1.5)
 *   < 3.00  → 0.02 ticks
 *   < 10.0  → 0.10 ticks   (5.8)
 *   ≥ 10.0  → integers     (15)
 */
export function round1xBetOdds(odds: number): number {
  const value = Math.max(1.01, odds);
  if (value < 1.2) return round(Math.round(value * 200) / 200, 3);
  if (value < 2) return round(Math.round(value * 100) / 100, 2);
  if (value < 3) return round(Math.round(value * 50) / 50, 2);
  if (value < 10) return round(Math.round(value * 10) / 10, 1);
  return Math.round(value);
}

export function bookOddsFor(probability: number): number {
  return round1xBetOdds(fairOddsFor(probability));
}

export function resolveStatsSource(source: string | null | undefined): string {
  const trimmed = source?.trim();
  return trimmed ? trimmed : SYNTHETIC_BASELINE;
}

// ─── Baselines from the aggregator (Part 2) ───────────────────────────────────

interface Baseline {
  /** Expected events for the whole match (both teams combined). */
  perMatch: number;
  origin: BaselineOrigin;
  /** Which inputs produced the value, for the market's reason string. */
  detail: string;
}

/** Sum a per-team field when at least one side has it; null when neither does. */
function pairSum(
  home: TeamStats | null,
  away: TeamStats | null,
  read: (team: TeamStats) => number | null,
): { value: number | null; sides: number } {
  const homeValue = home ? read(home) : null;
  const awayValue = away ? read(away) : null;
  if (homeValue === null && awayValue === null) return { value: null, sides: 0 };
  if (homeValue !== null && awayValue !== null) {
    return { value: homeValue + awayValue, sides: 2 };
  }
  // Only one side reported: mirror it so the match total stays on the same
  // scale instead of silently halving the expectation.
  const single = (homeValue ?? awayValue) as number;
  return { value: single * 2, sides: 1 };
}

function originForSides(sides: number): BaselineOrigin {
  if (sides === 2) return "real";
  if (sides === 1) return "partial";
  return "league";
}

/** Expected match goals: real xG when available, else the league goal anchor. */
function goalsBaseline(stats: CanonicalMatchStats | null, anchors: LeagueAnchors): Baseline {
  const xg = pairSum(stats?.home ?? null, stats?.away ?? null, (team) => positiveNumber(team.xg));
  if (xg.value !== null) {
    return {
      perMatch: clamp(xg.value, 0.6, 6),
      origin: originForSides(xg.sides),
      detail: `combined xG ${xg.value.toFixed(2)}`,
    };
  }
  return {
    perMatch: anchors.avgGoals,
    origin: "league",
    detail: `league average ${anchors.avgGoals.toFixed(2)} goals/match`,
  };
}

/** Expected match corners: season corner averages, else the league anchor. */
function cornersBaseline(stats: CanonicalMatchStats | null, anchors: LeagueAnchors): Baseline {
  const seasonAvg = pairSum(
    stats?.home ?? null,
    stats?.away ?? null,
    (team) => positiveNumber(team.avgCornersPerGame),
  );
  if (seasonAvg.value !== null) {
    return {
      perMatch: clamp(seasonAvg.value, 3, 18),
      origin: originForSides(seasonAvg.sides),
      detail: `season corner averages ${seasonAvg.value.toFixed(1)}/match`,
    };
  }
  const perMatchCorners = pairSum(
    stats?.home ?? null,
    stats?.away ?? null,
    (team) => positiveNumber(team.corners),
  );
  if (perMatchCorners.value !== null) {
    return {
      perMatch: clamp(perMatchCorners.value, 3, 18),
      origin: originForSides(perMatchCorners.sides),
      detail: `aggregated corner counts ${perMatchCorners.value.toFixed(1)}/match`,
    };
  }
  return {
    perMatch: anchors.avgCorners,
    origin: "league",
    detail: `league average ${anchors.avgCorners.toFixed(1)} corners/match`,
  };
}

/** Expected match cards: season card averages, else yellow+red, else anchor. */
function cardsBaseline(stats: CanonicalMatchStats | null, anchors: LeagueAnchors): Baseline {
  const seasonAvg = pairSum(
    stats?.home ?? null,
    stats?.away ?? null,
    (team) => positiveNumber(team.avgCardsPerGame),
  );
  if (seasonAvg.value !== null) {
    return {
      perMatch: clamp(seasonAvg.value, 1, 10),
      origin: originForSides(seasonAvg.sides),
      detail: `season card averages ${seasonAvg.value.toFixed(1)}/match`,
    };
  }
  const booked = pairSum(stats?.home ?? null, stats?.away ?? null, (team) => {
    const yellow = nonNegativeNumber(team.yellowCards);
    const red = nonNegativeNumber(team.redCards);
    if (yellow === null && red === null) return null;
    const total = (yellow ?? 0) + (red ?? 0);
    return total > 0 ? total : null;
  });
  if (booked.value !== null) {
    return {
      perMatch: clamp(booked.value, 1, 10),
      origin: originForSides(booked.sides),
      detail: `aggregated bookings ${booked.value.toFixed(1)}/match`,
    };
  }
  return {
    perMatch: anchors.avgCards,
    origin: "league",
    detail: `league average ${anchors.avgCards.toFixed(1)} cards/match`,
  };
}

/**
 * Expected match penalties. Sources rarely expose a penalty rate for an
 * upcoming fixture, so the observed league penalty baseline is scaled by how
 * foul-heavy the competition is (fouls are the mechanism penalties come from).
 */
function penaltiesBaseline(stats: CanonicalMatchStats | null, anchors: LeagueAnchors): Baseline {
  const awarded = pairSum(
    stats?.home ?? null,
    stats?.away ?? null,
    (team) => positiveNumber(team.penalties),
  );
  if (awarded.value !== null && awarded.value <= 2) {
    return {
      perMatch: clamp(awarded.value, 0.05, 1),
      origin: originForSides(awarded.sides),
      detail: `aggregated penalty rate ${awarded.value.toFixed(2)}/match`,
    };
  }
  const foulFactor = clamp(anchors.avgFouls / REFERENCE_FOULS_PER_MATCH, 0.75, 1.35);
  const perMatch = BASE_PENALTIES_PER_MATCH * foulFactor;
  return {
    perMatch,
    origin: "league",
    detail: `league baseline ${perMatch.toFixed(2)} penalties/match (fouls ${anchors.avgFouls.toFixed(1)})`,
  };
}

/**
 * Tempo multiplier for the opening phase. Sides that generate more xG than the
 * league norm start faster; foul-heavy fixtures raise the card/penalty rate.
 * Bounded so a single noisy stat can never dominate the Poisson intensity.
 */
function tempoFactor(stats: CanonicalMatchStats | null, anchors: LeagueAnchors): number {
  const xg = pairSum(stats?.home ?? null, stats?.away ?? null, (team) => positiveNumber(team.xg));
  if (xg.value === null) return 1;
  return clamp(xg.value / Math.max(0.5, anchors.avgGoals), 0.8, 1.25);
}

function aggressionFactor(stats: CanonicalMatchStats | null, anchors: LeagueAnchors): number {
  const fouls = pairSum(stats?.home ?? null, stats?.away ?? null, (team) => positiveNumber(team.fouls));
  if (fouls.value === null) return 1;
  return clamp(fouls.value / Math.max(1, anchors.avgFouls), 0.8, 1.25);
}

// ─── Market construction (Part 1 + Part 2) ────────────────────────────────────

function buildOutcome(label: First5Outcome, probability: number): First5OutcomeSide {
  const hitRate = round(probability);
  return {
    label,
    probability: hitRate,
    hitRate,
    fairOdds: fairOddsFor(probability),
    odds1xBet: bookOddsFor(probability),
    confidence: confidenceFor(probability),
  };
}

function buildMarket(
  fx: FixtureLite,
  key: First5MarketKey,
  baseline: Baseline,
  adjustment: number,
  aggregatorSource: string,
): First5Market {
  const meta = MARKET_META[key];
  const uniformShare = WINDOW_MINUTES / MATCH_MINUTES;
  const lambdaWindow =
    baseline.perMatch * uniformShare * OPENING_INTENSITY[key] * adjustment;
  const probability = clamp(atLeastOne(lambdaWindow), 0.0005, 0.9995);
  const yes = buildOutcome("Yes", probability);
  const no = buildOutcome("No", 1 - probability);
  const outcome: First5Outcome = probability >= 0.5 ? "Yes" : "No";
  const selected = outcome === "Yes" ? yes : no;
  const origin = baseline.origin;
  const statsSource = origin === "league" ? SYNTHETIC_BASELINE : aggregatorSource;

  const originLabel =
    origin === "real"
      ? "real pre-match stats"
      : origin === "partial"
        ? "partial real stats"
        : "league average (Synthetic Baseline)";

  return {
    id: `${fx.id}-${key}`,
    key,
    label: meta.label,
    shortLabel: meta.shortLabel,
    icon: meta.icon,
    outcome,
    probability: round(probability),
    hitRate: selected.hitRate,
    fairOdds: selected.fairOdds,
    odds: {
      yes: yes.odds1xBet,
      no: no.odds1xBet,
      selected: selected.odds1xBet,
    },
    yes,
    no,
    isGuaranteed: yes.hitRate >= GUARANTEED_HIT_RATE || no.hitRate >= GUARANTEED_HIT_RATE,
    confidence: selected.confidence,
    expectedInWindow: round(lambdaWindow),
    expectedPerMatch: round(baseline.perMatch, 2),
    origin,
    statsSource,
    source: statsSource,
    reason:
      `${baseline.detail} → ${round(lambdaWindow, 3)} expected ${meta.shortLabel.toLowerCase()} ` +
      `events in minutes 0–${WINDOW_MINUTES} ` +
      `(opening intensity ${OPENING_INTENSITY[key]}× uniform, tempo ${adjustment.toFixed(2)}×). ` +
      `Poisson P(at least one) = ${(probability * 100).toFixed(1)}% · ${originLabel}.`,
  };
}

function buildMarkets(
  fx: FixtureLite,
  stats: CanonicalMatchStats | null,
  aggregatorSource: string,
): First5Market[] {
  const anchors = getAnchors(fx.leagueSlug);
  const attacking = tempoFactor(stats, anchors);
  const aggressive = aggressionFactor(stats, anchors);

  return [
    buildMarket(fx, "goal", goalsBaseline(stats, anchors), attacking, aggregatorSource),
    buildMarket(fx, "corner", cornersBaseline(stats, anchors), attacking, aggregatorSource),
    buildMarket(fx, "card", cardsBaseline(stats, anchors), aggressive, aggregatorSource),
    buildMarket(fx, "penalty", penaltiesBaseline(stats, anchors), aggressive, aggregatorSource),
  ];
}

// ─── Fixture + stats plumbing ─────────────────────────────────────────────────

function teamLogo(team: TeamLite): string | null {
  return team.logo ?? null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pull merged canonical stats for a fixture. Returns null when no source
 * contributed a single field — the caller then rides the league anchors, which
 * is the documented synthetic baseline for this feature.
 */
async function fetchPrematchStats(
  fx: FixtureLite,
  force: boolean,
): Promise<CanonicalMatchStats | null> {
  try {
    return await withTimeout(
      statsAggregator.fetch(
        {
          leagueSlug: fx.leagueSlug,
          eventId: fx.id,
          homeTeam: fx.home.name,
          awayTeam: fx.away.name,
          date: fx.date,
        },
        { force },
      ),
      STATS_TIMEOUT_MS,
      null,
    );
  } catch (error) {
    console.warn(
      `[First5] ${formatMatch(fx)}: stats aggregator failed ` +
      `(${error instanceof Error ? error.message : String(error)}); using league baseline`,
    );
    return null;
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

/** Fetch every upcoming fixture in the next 7 days from the dynamic feed. */
async function fetchUpcomingFixtures(): Promise<FixtureLite[]> {
  const range = dateRange(LOOKAHEAD_DAYS);
  const boards = await Promise.all(
    FIRST_5_LEAGUES.map(async (slug) => {
      try {
        return await fetchScoreboard(slug, range);
      } catch (error) {
        console.warn(
          `[First5] Fixture feed failed for ${slug}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
        return [] as FixtureLite[];
      }
    }),
  );

  const now = Date.now();
  const horizon = now + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();

  return boards
    .flat()
    .filter((fx) => {
      if (fx.state !== "pre" || seen.has(fx.id)) return false;
      const kickoff = new Date(fx.date).getTime();
      if (!Number.isFinite(kickoff) || kickoff < now || kickoff > horizon) return false;
      seen.add(fx.id);
      return true;
    })
    .sort((left, right) => {
      const byDate = new Date(left.date).getTime() - new Date(right.date).getTime();
      if (byDate !== 0) return byDate;
      return leagueTier(left) - leagueTier(right);
    });
}

function buildMatch(fx: FixtureLite, stats: CanonicalMatchStats | null): First5Match {
  const aggregatorSource = resolveStatsSource(stats?.metadata.source);
  const markets = buildMarkets(fx, stats, aggregatorSource);
  const realMarketCount = markets.filter((market) => market.origin !== "league").length;
  const dataOrigin: BaselineOrigin =
    realMarketCount === markets.length
      ? "real"
      : realMarketCount > 0
        ? "partial"
        : "league";

  return {
    fixtureId: fx.id,
    homeTeam: fx.home.name,
    awayTeam: fx.away.name,
    homeLogo: teamLogo(fx.home),
    awayLogo: teamLogo(fx.away),
    league: fx.leagueName,
    leagueSlug: fx.leagueSlug,
    leagueTier: leagueTier(fx),
    date: fx.date,
    venue: fx.venue,
    statsSource: dataOrigin === "league" ? SYNTHETIC_BASELINE : aggregatorSource,
    dataOrigin,
    realMarketCount,
    markets,
  };
}

function emptyResponse(overrides: Partial<First5MinutesResponse> = {}): First5MinutesResponse {
  return {
    generatedAt: new Date().toISOString(),
    windowMinutes: WINDOW_MINUTES,
    lookaheadDays: LOOKAHEAD_DAYS,
    totalFixturesChecked: 0,
    totalMatches: 0,
    marketTypes: MARKET_ORDER.map((key) => ({
      key,
      label: MARKET_META[key].label,
      icon: MARKET_META[key].icon,
    })),
    model: {
      description:
        "Poisson arrival model: λ_window = λ_match × (5 / 96) × opening intensity × tempo. " +
        "λ_match comes from the multi-source stats aggregator, falling back to observed league averages.",
      matchMinutes: MATCH_MINUTES,
      openingIntensity: { ...OPENING_INTENSITY },
    },
    cache: { ttlMinutes: CACHE_TTL_MS / 60_000, hit: false },
    matches: [],
    ...overrides,
  };
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

  try {
    const fixtures = (await fetchUpcomingFixtures()).slice(0, MAX_FIXTURES);

    const matches = await mapWithConcurrency(fixtures, CONCURRENCY, async (fx) => {
      const stats = await fetchPrematchStats(fx, isRefresh);
      return buildMatch(fx, stats);
    });

    const realCount = matches.filter((match) => match.dataOrigin !== "league").length;
    console.info(
      `[First5] ${matches.length} upcoming fixture(s) scored over a ${LOOKAHEAD_DAYS}-day window ` +
      `(${realCount} with real aggregator data, ${matches.length - realCount} on league baselines).`,
    );

    const body = emptyResponse({
      totalFixturesChecked: fixtures.length,
      totalMatches: matches.length,
      matches,
    });

    cache.set(cacheKey, { data: body, timestamp: Date.now() });

    return Response.json(body, {
      headers: {
        "Cache-Control": "no-store",
        "X-Cache": isRefresh ? "REFRESH" : "MISS",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[First5] Route failed: ${message}`);
    return Response.json(
      emptyResponse({ error: "First 5 Minutes Markets are temporarily unavailable." }),
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
