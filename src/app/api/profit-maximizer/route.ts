// ĞIGI GIVØ — Profit Maximizer.
//
// The app's betting cheat sheet: it scans EVERY prediction the app generates —
// the four ranking modes (A Classic, B 12-Factor, C Hybrid, D Consensus), the
// Sure Bet Corners feed and the First 5 Minutes feed — prices each market
// against the real bookmaker odds carried on the market/fixture, keeps only
// the bets with a positive expected value above a configurable edge floor, and
// sizes each one with the Kelly Criterion.
//
// Integrity contract (identical to the rest of the app):
//   1. REAL ODDS DECIDE — a market only qualifies while it clears the
//      bookmaker's price. When no bookmaker price exists for a market the
//      route falls back to its fair odds (1 / hitRate), which by construction
//      gives EV = 0, so those markets are reported (`oddsSource: "fair"`) but
//      never shown as a bet.
//   2. REUSE, NEVER REIMPLEMENT — the ranking pass comes from
//      `runOracleAllModesWithStandings` (one external-data walk, four rankings,
//      zero side effects), the corner board comes from GET /api/sure-corners and
//      the opening-phase board from GET /api/first-5-minutes, both called
//      in-process. Bookmaker matching reuses the existing value engine
//      (`findValueBets`). Nothing here modifies the engine, the settlement
//      logic or any feature.
//   3. FAIL-SOFT — a dead fixture feed, a missing DB or one failing source
//      degrades the report (that source is flagged) instead of breaking it.
//
// Formulas (as specified):
//   EV       = hitRate × bookmakerOdds − 1
//   fraction = EV / (bookmakerOdds − 1)   clamped to [0, 1]
//   fairOdds = 1 / hitRate
//
// Note on exports: Next.js generates a `.next/types/app/api/**/route.ts` check
// that a route module must satisfy with handler + config exports ONLY, so the
// maths helpers below are deliberately module-private and only the response
// types are exported (type-only exports are erased and never trip that check).
//
// Query parameters:
//   ?minEv=0.10     edge floor (decimal). Default 0.05, clamped to [0, 0.5].
//   ?refresh=true   bypass the one-hour cache and rebuild the scan.

import { GET as first5GET, type First5MinutesResponse } from "@/app/api/first-5-minutes/route";
import { GET as sureCornersGET, type SureCornersResponse } from "@/app/api/sure-corners/route";
import { statsAggregator } from "@/lib/data/aggregator";
import {
  assessMarketConfidence,
  toConfidenceBreakdown,
  type MarketConfidenceAssessment,
  type MarketConfidenceBreakdown,
  type MarketDataQuality,
} from "@/lib/data/confidence";
import { STAT_FIELDS, nonNullStatCount, type CanonicalMatchStats } from "@/lib/data/types";
import { fetchScoreboard, type FixtureLite, type OddsInfo } from "@/lib/espn";
import type { Market } from "@/lib/engine";
import { runOracleAllModesWithStandings, type OracleResult } from "@/lib/engine/oracle";
import { ALL_RANKING_MODES, type RankingMode } from "@/lib/engine/selector";
import { findValueBets, type BookmakerOdds } from "@/lib/engine/value";
import { LEAGUE_TIER, leagueTier } from "@/lib/leaguePriority";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ─── Configuration ───────────────────────────────────────────────────────────

/** Edge floor: only bets above this EV are returned (0.05 = 5%). */
const DEFAULT_MIN_EV = 0.05;
/** Sensible ceiling for the query param, so ?minEv=9999 can't nuke the feed. */
const MAX_MIN_EV = 0.5;
/** The scan is cached for an hour — same TTL as Sure Bet Corners / First 5. */
const CACHE_TTL_MS = 60 * 60 * 1000;
/** Fixture window for the ranking-mode walk (the two feature feeds keep their own 7 days). */
const LOOKAHEAD_DAYS = Number(process.env.PROFIT_MAXIZER_LOOKAHEAD_DAYS ?? 3);
/** Hard cap on fixtures pushed through the engine in one scan (bounded wall time). */
const MAX_RANKING_FIXTURES = Number(process.env.PROFIT_MAXIZER_MAX_FIXTURES ?? 24);
/** Fixtures walked in parallel — the oracle fan-out is much heavier than a feature feed. */
const RANKING_CONCURRENCY = 4;
/** Soft deadline: new fixtures are not started after this, the scan is flagged partial. */
const SCAN_TIME_BUDGET_MS = Number(process.env.PROFIT_MAXIZER_TIME_BUDGET_MS ?? 150_000);
/** Competition tiers walked by the ranking pass (the feature feeds filter their own tiers). */
const MAX_LEAGUE_TIER = 3;
/**
 * Sanity guard: below this hit rate a longshot price produces a nonsense
 * Kelly stake (a 10% shot at 20.0 asks for the whole bankroll), and neither
 * feed ever publishes a pick that thin. Documented in `methodology.notes`.
 */
const MIN_HIT_RATE = 0.2;

/** The provider string the value engine uses for its synthetic fair-market line. */
const SYNTHETIC_PRICE_PROVIDER = "Fair Market Model";

export type ProfitSource =
  | "Rank A"
  | "Rank B"
  | "Rank C"
  | "Rank D"
  | "Sure Bet Corners"
  | "First 5 Minutes";

export type OddsSourceKind = "bookmaker" | "fair";

const RANKING_SOURCES: ProfitSource[] = ["Rank A", "Rank B", "Rank C", "Rank D"];
const ALL_SOURCES: ProfitSource[] = [...RANKING_SOURCES, "Sure Bet Corners", "First 5 Minutes"];

const SOURCE_LABEL: Record<RankingMode, ProfitSource> = {
  A: "Rank A",
  B: "Rank B",
  C: "Rank C",
  D: "Rank D",
};

// ─── Public response types ────────────────────────────────────────────────────

/** One evaluated market — every field the cheat sheet needs to place a bet. */
export interface ProfitMaximizerMarket {
  /** Dedupe identity: `${eventId}|${marketName}|${selection}`. */
  dedupeKey: string;
  eventId: string;
  leagueSlug: string;
  league: string;
  leagueTier: number;
  homeTeam: string;
  awayTeam: string;
  matchLabel: string;
  matchDate: string;
  /** e.g. "Total Corners Over 9.5". */
  marketName: string;
  /** e.g. "Over 9.5". */
  selection: string;
  /** Market family (Goals / Corners / Cards / Shots / …) for grouping. */
  family: string;
  /** Model probability for this selection, as a decimal. */
  hitRate: number;
  /** Real bookmaker price, when one exists for this market. */
  bookmakerOdds: number | null;
  /** "bookmaker" = priced by a real quote · "fair" = 1 / hitRate fallback (zero EV). */
  oddsSource: OddsSourceKind;
  /** Who supplied the price (ESPN pickcenter book, 1xBet ladder, "Fair Odds"). */
  oddsProvider: string | null;
  /** 1 / hitRate. */
  fairOdds: number;
  /** hitRate × odds − 1 (decimal, e.g. 0.082). */
  ev: number;
  /** Human-readable EV, e.g. "8.2%". */
  evPercent: string;
  /** Kelly fraction of the bankroll to stake, clamped to [0, 1] (e.g. 0.042). */
  kellyStake: number;
  /** EV% and the Data Quality confidence score averaged onto a 0–100 scale. */
  profitScore: number;
  /** 0–100 model-confidence score from the Data Quality system. */
  confidenceScore: number;
  dataQuality: MarketDataQuality;
  dataSourceDetail: string;
  confidenceBreakdown: MarketConfidenceBreakdown;
  /** Which mode / feature produced the highest hit-rate version of this market. */
  source: ProfitSource;
  /** Every source that carried the same market (dedupe keeps the best one). */
  alsoSeenIn: ProfitSource[];
}

export interface ProfitMaximizerSourceReport {
  source: ProfitSource | "Ranking Modes (A–D)";
  ok: boolean;
  fixtures: number;
  /** Candidate markets this feed produced, before cross-source dedupe. */
  marketsEvaluated: number;
  /** Unique markets this source won after dedupe (highest hit rate keeps the row). */
  retained: number;
  /** Retained markets from this source that cleared the MIN_EV floor for THIS request. */
  qualifying: number;
  error?: string;
}

/** The cached half of a source row — `qualifying` is recomputed per request. */
type ScanSourceReport = Omit<ProfitMaximizerSourceReport, "qualifying">;

export interface ProfitMaximizerResponse {
  generatedAt: string;
  /** Unique markets priced by the scan (after cross-source dedupe). */
  totalMarketsScanned: number;
  /** Markets that passed EV > MIN_EV, best edge first. */
  qualifyingMarkets: ProfitMaximizerMarket[];
  filters: {
    minEv: number;
    minEvPercent: string;
    defaultMinEv: number;
    lookaheadDays: number;
    maxRankingFixtures: number;
    sources: ProfitSource[];
  };
  summary: {
    totalMarketsScanned: number;
    qualifyingBets: number;
    matchesWithBets: number;
    averageEvPercent: number;
    averageKellyStake: number;
    bestEvPercent: number;
    /** Positive-EV markets the MIN_EV floor rejected (the "lower your filter" hint). */
    belowThreshold: number;
    positiveEvMarkets: number;
    withRealBookmakerOdds: number;
    fairOddsOnly: number;
    duplicatesRemoved: number;
    /** Markets dropped for an unusable/uncandid hit rate or no price at all. */
    skippedMarkets: number;
  };
  sources: ProfitMaximizerSourceReport[];
  methodology: {
    evFormula: string;
    kellyFormula: string;
    fairOddsFormula: string;
    oddsPriority: string[];
    notes: string[];
  };
  cache: { ttlMinutes: number; hit: boolean; forcedRefresh: boolean };
  /** True when the time/fixture budget cut the ranking walk short. */
  partial: boolean;
  fixturesChecked: number;
  error?: string;
}

/** The cached hour-old scan: every unique market priced, before any MIN_EV floor. */
interface ProfitMaximizerScan {
  generatedAt: string;
  markets: ProfitMaximizerMarket[];
  totalMarketsScanned: number;
  duplicatesRemoved: number;
  /** Markets dropped for an unusable hit rate or because no price was available. */
  skippedMarkets: number;
  fixturesChecked: number;
  fixturesWalked: number;
  partial: boolean;
  sources: ScanSourceReport[];
}

/** A market as produced by one of the three feeds, before EV pricing. */
export interface CandidateMarket {
  eventId: string;
  leagueSlug: string;
  league: string;
  leagueTier: number;
  homeTeam: string;
  awayTeam: string;
  matchDate: string;
  marketName: string;
  selection: string;
  family: string;
  hitRate: number;
  bookmakerOdds: number | null;
  oddsProvider: string | null;
  confidenceScore: number;
  dataQuality: MarketDataQuality;
  dataSourceDetail: string;
  confidenceBreakdown: MarketConfidenceBreakdown;
  source: ProfitSource;
}

// ─── Pure maths (exported so the unit tests pin the formulas) ─────────────────

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** EV = (hitRate × bookmakerOdds) − 1. */
function expectedValue(hitRate: number, bookmakerOdds: number): number {
  return hitRate * bookmakerOdds - 1;
}

/** Kelly fraction = EV / (odds − 1), clamped to [0, 1] — never stake > 100%. */
function kellyFraction(ev: number, bookmakerOdds: number): number {
  const payout = bookmakerOdds - 1;
  if (!Number.isFinite(ev) || !Number.isFinite(payout) || payout <= 0) return 0;
  return clamp(ev / payout, 0, 1);
}

/** fairOdds = 1 / hitRate (null when the hit rate is unusable). */
function fairOddsFromHitRate(hitRate: number): number | null {
  if (!Number.isFinite(hitRate) || hitRate <= 0) return null;
  const fair = 1 / hitRate;
  return Number.isFinite(fair) && fair > 1 ? round(fair) : null;
}

/** Profit Score = EV% and the confidence score averaged onto 0–100. */
function profitScoreOf(ev: number, confidenceScore: number): number {
  const evPoints = clamp(ev * 100, 0, 100);
  const confidencePoints = clamp(confidenceScore, 0, 100);
  return Math.round((evPoints + confidencePoints) / 2);
}

/** Cross-source dedupe identity. */
function marketKey(eventId: string, marketName: string, selection: string): string {
  return `${eventId}|${marketName}|${selection}`;
}

/** MIN_EV from the query string — decimal, default 0.05, clamped to [0, 0.5]. */
function parseMinEv(raw: string | null): number {
  if (!raw) return DEFAULT_MIN_EV;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MIN_EV;
  return round(clamp(value, 0, MAX_MIN_EV), 4);
}

/**
 * Price a candidate market and derive EV / Kelly / Profit Score.
 *
 * Odds priority (as specified): the market's own real bookmaker price wins;
 * otherwise the fair-odds fallback is used and the market is tagged
 * `oddsSource: "fair"` (zero EV by construction, so it can never qualify); a
 * market with neither a usable price nor a usable hit rate is skipped.
 */
function evaluateMarket(candidate: CandidateMarket): ProfitMaximizerMarket | null {
  const hitRate = candidate.hitRate;
  if (!Number.isFinite(hitRate) || hitRate <= 0 || hitRate > 1) return null;

  const fairOdds = fairOddsFromHitRate(hitRate);
  const quoted = candidate.bookmakerOdds;
  const hasBookmakerPrice = typeof quoted === "number" && Number.isFinite(quoted) && quoted > 1;

  const odds = hasBookmakerPrice ? (quoted as number) : fairOdds;
  if (odds === null) return null; // neither a bookmaker price nor fair odds → skip
  const oddsSource: OddsSourceKind = hasBookmakerPrice ? "bookmaker" : "fair";

  const ev = round(expectedValue(hitRate, odds));
  const kellyStake = round(kellyFraction(ev, odds));

  return {
    dedupeKey: marketKey(candidate.eventId, candidate.marketName, candidate.selection),
    eventId: candidate.eventId,
    leagueSlug: candidate.leagueSlug,
    league: candidate.league,
    leagueTier: candidate.leagueTier,
    homeTeam: candidate.homeTeam,
    awayTeam: candidate.awayTeam,
    matchLabel: `${candidate.homeTeam} vs ${candidate.awayTeam}`,
    matchDate: candidate.matchDate,
    marketName: candidate.marketName,
    selection: candidate.selection,
    family: candidate.family,
    hitRate: round(hitRate),
    bookmakerOdds: hasBookmakerPrice ? round(odds) : null,
    oddsSource,
    oddsProvider: hasBookmakerPrice ? (candidate.oddsProvider ?? "Bookmaker") : "Fair Odds",
    fairOdds: fairOdds ?? round(odds),
    ev,
    evPercent: `${round(ev * 100, 1)}%`,
    kellyStake,
    profitScore: profitScoreOf(ev, candidate.confidenceScore),
    confidenceScore: candidate.confidenceScore,
    dataQuality: candidate.dataQuality,
    dataSourceDetail: candidate.dataSourceDetail,
    confidenceBreakdown: candidate.confidenceBreakdown,
    source: candidate.source,
    alsoSeenIn: [candidate.source],
  };
}

// ─── Confidence (Data Quality system) for ranking-mode markets ────────────────
//
// The two feature feeds already annotate every market with a confidence score.
// The engine's `Market` type carries no such field, so the ranked picks reuse
// the same shared scorer on the fixture's canonical stats — the exact
// (dataQuality / sourceCount / completeness) triple the aggregator produced for
// that match. `statsAggregator.peek` is a cache read: the oracle run above just
// fetched (and cached) those stats, so this costs no extra network traffic.

const TOTAL_TEAM_FIELDS = STAT_FIELDS.length * 2;

function rankingMatchConfidence(stats: CanonicalMatchStats | null) {
  // No aggregator data for this fixture → the honest synthetic-baseline verdict
  // from the same shared scorer (never a fabricated "real" label).
  if (!stats) {
    return withAssessment(
      assessMarketConfidence({
        dataQuality: "synthetic",
        sourceCount: 0,
        completenessPct: 0,
        sourceNames: [],
      }),
    );
  }

  const homeFields = nonNullStatCount(stats.home);
  const awayFields = nonNullStatCount(stats.away);
  const dataQuality: MarketDataQuality =
    homeFields > 0 && awayFields > 0 ? "real" : homeFields > 0 || awayFields > 0 ? "mixed" : "synthetic";
  const contributing = stats.metadata.sources?.length
    ? [...new Set(stats.metadata.sources)]
    : stats.metadata.source
      ? [stats.metadata.source]
      : [];

  return withAssessment(
    assessMarketConfidence({
      dataQuality,
      // A synthetic-tier match has no team-specific input to agree on, so it
      // earns no source-agreement credit (same rule both feature feeds apply).
      sourceCount: dataQuality === "synthetic" ? 0 : contributing.length,
      completenessPct: ((homeFields + awayFields) / TOTAL_TEAM_FIELDS) * 100,
      sourceNames: dataQuality === "synthetic" ? [] : contributing,
    }),
  );
}

function withAssessment(assessment: MarketConfidenceAssessment) {
  return {
    confidenceScore: assessment.confidenceScore,
    dataQuality: assessment.dataQuality,
    dataSourceDetail: assessment.dataSourceDetail,
    confidenceBreakdown: toConfidenceBreakdown(assessment),
  };
}

/** The feature feeds' breakdown arrives as a plain object — normalise defensively. */
function passthroughBreakdown(
  breakdown: Partial<MarketConfidenceBreakdown> | null | undefined,
  dataQuality: MarketDataQuality,
): MarketConfidenceBreakdown {
  const completenessPct = Number(breakdown?.completenessPct ?? 0) || 0;
  return {
    dataQuality: breakdown?.dataQuality ?? dataQuality,
    dataQualityPoints: Number(breakdown?.dataQualityPoints ?? 0) || 0,
    sourceCount: Number(breakdown?.sourceCount ?? 0) || 0,
    sourceAgreementPoints: Number(breakdown?.sourceAgreementPoints ?? 0) || 0,
    completenessPct,
    completenessPoints: Number(breakdown?.completenessPoints ?? 0) || 0,
  };
}

// ─── Odds plumbing (real bookmaker prices, reusing the value engine) ──────────

/**
 * Build the value engine's odds payload from the fixture's own scoreboard odds.
 * `fetchScoreboard` already normalises ESPN's odds block, so this costs zero
 * extra requests — the per-event pickcenter fan-out stays in /api/match.
 */
function bookmakerOddsFor(fixture: FixtureLite): BookmakerOdds | null {
  const o = (fixture.odds ?? null) as OddsInfo | null;
  if (!o || (o.homeML == null && o.drawML == null && o.awayML == null && o.overUnder == null)) {
    return null;
  }
  return {
    provider: o.provider ?? "ESPN",
    homeML: o.homeML ?? undefined,
    drawML: o.drawML ?? undefined,
    awayML: o.awayML ?? undefined,
    overUnder: o.overUnder ?? undefined,
  };
}

/**
 * Real bookmaker decimal price per ranked market, keyed by `marketKey`.
 *
 * The existing value engine (`findValueBets`) already matches a ranked market
 * name/selection onto the book's line; it is reused here purely as a price
 * lookup. Its synthetic "Fair Market Model" fallback is dropped — that is the
 * engine's own estimate, never a bookmaker quote, and advertising it as one
 * would fabricate an edge.
 */
function realPriceLookup(
  fixture: FixtureLite,
  result: OracleResult,
  odds: BookmakerOdds | null,
): Map<string, { odds: number; provider: string }> {
  const out = new Map<string, { odds: number; provider: string }>();
  if (!odds || fixture.state !== "pre") return out;
  try {
    for (const bet of findValueBets(result.markets, odds, fixture.home.name, fixture.away.name)) {
      if (bet.provider === SYNTHETIC_PRICE_PROVIDER) continue;
      if (!Number.isFinite(bet.bookDecimalOdds) || bet.bookDecimalOdds <= 1) continue;
      out.set(marketKey(fixture.id, bet.market.name, bet.market.selection), {
        odds: bet.bookDecimalOdds,
        provider: bet.provider || "Bookmaker",
      });
    }
  } catch {
    // Price enrichment is optional — an unmatched market simply rides fair odds.
  }
  return out;
}

// ─── Source 1: the four ranking modes ─────────────────────────────────────────

/** top1 ∪ top3 ∪ top10 of one ranked result — the markets the app actually publishes. */
function rankedMarkets(result: OracleResult): Market[] {
  const seen = new Set<string>();
  const picks: OracleResult["markets"] = [];
  for (const market of [...result.top1, ...result.top3, ...result.top10]) {
    if (!market || market.rejected) continue;
    const id = `${market.id}|${market.name}|${market.selection}`;
    if (seen.has(id)) continue;
    seen.add(id);
    picks.push(market);
  }
  return picks;
}

async function scanRankingModes(
  fixtures: FixtureLite[],
  deadline: number,
): Promise<{ candidates: CandidateMarket[]; walked: number; partial: boolean; error?: string }> {
  const candidates: CandidateMarket[] = [];
  let walked = 0;
  let partial = false;
  let firstError: string | null = null;

  const queue = [...fixtures];
  const workers = Array.from({ length: Math.min(RANKING_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      if (Date.now() > deadline) {
        partial = true;
        return;
      }
      const fx = queue.shift();
      if (!fx) return;
      walked++;
      try {
        // One external-data walk per fixture, four rankings — no DB writes,
        // no settlement, no side effects (unlike the daily-picks cron).
        const results = await runOracleAllModesWithStandings(fx);
        if (results.size === 0) continue; // unplayable — the oracle refuses to invent data

        // Read-only cache hit: the oracle run above just fetched (and cached)
        // these canonical stats, so the Data Quality score costs no extra traffic.
        const stats = statsAggregator.peek(rankingStatsQuery(fx));
        const quality = rankingMatchConfidence(stats);
        const odds = bookmakerOddsFor(fx);

        for (const mode of ALL_RANKING_MODES) {
          const result = results.get(mode);
          if (!result) continue;
          const prices = realPriceLookup(fx, result, odds);
          for (const market of rankedMarkets(result)) {
            const priced = prices.get(marketKey(fx.id, market.name, market.selection));
            // The engine's own `marketOdds` field wins when a run carries a real
            // bookmaker price; otherwise fall back to the fixture's odds feed.
            const quoted = market.marketOdds ?? priced?.odds ?? null;
            candidates.push({
              eventId: fx.id,
              leagueSlug: fx.leagueSlug,
              league: fx.leagueName,
              leagueTier: leagueTier(fx),
              homeTeam: fx.home.name,
              awayTeam: fx.away.name,
              matchDate: fx.date,
              marketName: market.name,
              selection: market.selection,
              family: market.family || "Other",
              hitRate: market.hitRate,
              bookmakerOdds: quoted ?? null,
              oddsProvider: quoted != null ? (priced?.provider ?? "Bookmaker") : null,
              confidenceScore: quality.confidenceScore,
              dataQuality: quality.dataQuality,
              dataSourceDetail: quality.dataSourceDetail,
              confidenceBreakdown: quality.confidenceBreakdown,
              source: SOURCE_LABEL[mode],
            });
          }
        }
      } catch (error) {
        firstError ??= error instanceof Error ? error.message : String(error);
      }
    }
  });
  await Promise.all(workers);

  return {
    candidates,
    walked,
    partial,
    ...(firstError ? { error: firstError } : {}),
  };
}

function rankingStatsQuery(fx: FixtureLite) {
  return {
    leagueSlug: fx.leagueSlug,
    eventId: fx.id,
    homeTeam: fx.home.name,
    awayTeam: fx.away.name,
    date: fx.date,
  };
}

// ─── Source 2 + 3: the two feature feeds (called in-process) ─────────────────

/**
 * Invoke an existing route handler in-process — the same reuse pattern
 * `/api/cron/daily-picks` uses for `/api/fixtures`. Their own one-hour caches
 * absorb the work, and `refresh=true` is forwarded so a forced refresh really
 * refreshes end to end.
 */
async function callRoute<T>(
  handler: (req: Request) => Promise<Response>,
  path: string,
  forceRefresh: boolean,
): Promise<{ payload: T | null; error: string | null }> {
  const url = new URL(`http://gigi.local${path}`);
  if (forceRefresh) url.searchParams.set("refresh", "true");
  try {
    const response = await handler(new Request(url));
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      return { payload: null, error: payload?.error ?? `HTTP ${response.status}` };
    }
    return { payload, error: payload?.error ?? null };
  } catch (error) {
    return { payload: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function sureCornerCandidates(matches: SureCornersResponse["matches"]): CandidateMarket[] {
  const out: CandidateMarket[] = [];
  for (const match of matches) {
    for (const market of match.markets ?? []) {
      out.push({
        eventId: match.fixtureId,
        leagueSlug: match.leagueSlug,
        league: match.league,
        leagueTier: match.leagueTier,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        matchDate: match.date,
        marketName: market.name,
        selection: market.selection,
        family: "Corners",
        hitRate: market.hitRate,
        // The corner board carries no bookmaker line — it rides fair odds and is
        // reported as such (oddsSource "fair") instead of inventing a price.
        bookmakerOdds: null,
        oddsProvider: null,
        confidenceScore: market.confidenceScore,
        dataQuality: market.dataQuality,
        dataSourceDetail: market.dataSourceDetail ?? "",
        confidenceBreakdown: passthroughBreakdown(market.confidenceBreakdown, market.dataQuality),
        source: "Sure Bet Corners",
      });
    }
  }
  return out;
}

function first5Candidates(matches: First5MinutesResponse["matches"]): CandidateMarket[] {
  const out: CandidateMarket[] = [];
  for (const match of matches) {
    for (const market of match.markets ?? []) {
      // The selected side is the pick, and `odds.selected` is the real 1xBet
      // ladder price stored on the market for exactly that side.
      const selected = market.outcome === "No" ? market.no : market.yes;
      const quoted = market.odds?.selected ?? selected?.odds1xBet ?? null;
      out.push({
        eventId: match.fixtureId,
        leagueSlug: match.leagueSlug,
        league: match.league,
        leagueTier: match.leagueTier,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        matchDate: match.date,
        marketName: market.label,
        selection: market.outcome,
        family: market.shortLabel,
        hitRate: market.hitRate,
        bookmakerOdds: quoted,
        oddsProvider: quoted != null ? "1xBet" : null,
        confidenceScore: market.confidenceScore,
        dataQuality: market.dataQuality,
        dataSourceDetail: market.dataSourceDetail ?? "",
        confidenceBreakdown: passthroughBreakdown(market.confidenceBreakdown, market.dataQuality),
        source: "First 5 Minutes",
      });
    }
  }
  return out;
}

// ─── Aggregation: dedupe + price + positive-EV ledger ─────────────────────────

/**
 * Dedupe by eventId + marketName + selection (keeping the highest hit-rate
 * version, and preferring a real bookmaker price on a tie), price every unique
 * market once, and hand back the whole ledger best-edge-first. The MIN_EV floor
 * is applied on the way out of the cache, so switching thresholds never
 * re-runs the scan.
 */
function buildScan(candidates: CandidateMarket[]): {
  markets: ProfitMaximizerMarket[];
  duplicatesRemoved: number;
  /** Markets dropped for an unusable hit rate (below MIN_HIT_RATE) or no price at all. */
  skippedMarkets: number;
} {
  const unique = new Map<string, ProfitMaximizerMarket>();
  let duplicatesRemoved = 0;
  let skippedMarkets = 0;

  for (const candidate of candidates) {
    if (!(candidate.hitRate > MIN_HIT_RATE)) {
      skippedMarkets++;
      continue;
    }
    const priced = evaluateMarket(candidate);
    if (!priced) {
      skippedMarkets++;
      continue;
    }
    const existing = unique.get(priced.dedupeKey);
    if (!existing) {
      unique.set(priced.dedupeKey, priced);
      continue;
    }
    duplicatesRemoved++;
    // Highest hit rate wins; on a tie the version backed by a real price wins.
    const better =
      priced.hitRate > existing.hitRate ||
      (priced.hitRate === existing.hitRate &&
        priced.oddsSource === "bookmaker" &&
        existing.oddsSource !== "bookmaker");
    if (!better) {
      existing.alsoSeenIn = [...new Set([...existing.alsoSeenIn, priced.source])];
      continue;
    }
    priced.alsoSeenIn = [...new Set([...priced.alsoSeenIn, ...existing.alsoSeenIn])];
    unique.set(priced.dedupeKey, priced);
  }

  const markets = [...unique.values()].sort(
    (left, right) =>
      right.ev - left.ev ||
      right.profitScore - left.profitScore ||
      right.hitRate - left.hitRate,
  );

  return { markets, duplicatesRemoved, skippedMarkets };
}

/**
 * Attribute each unique market to the ONE source whose version won the dedupe —
 * the row that says which mode or feature generated the pick. The merge history
 * stays visible on the market itself via `alsoSeenIn`.
 */
function countPerSource(markets: ProfitMaximizerMarket[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const market of markets) {
    out.set(market.source, (out.get(market.source) ?? 0) + 1);
  }
  return out;
}

// ─── Fixture feed for the ranking walk ────────────────────────────────────────

const RANKING_LEAGUES = Object.entries(LEAGUE_TIER)
  .filter(([, tier]) => tier <= MAX_LEAGUE_TIER)
  .map(([slug]) => slug);

function dateRange(days: number): string {
  const from = new Date();
  const to = new Date(from);
  to.setDate(from.getDate() + days);
  const fmt = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, "");
  return `${fmt(from)}-${fmt(to)}`;
}

/**
 * Upcoming, unstarted fixtures across the priority leagues. Only `pre` matches
 * are walked: a kick-off that already happened cannot be backed as a pre-match
 * bet, and stale prices would fabricate edge.
 */
async function fetchScanFixtures(): Promise<FixtureLite[]> {
  const boards = await Promise.all(
    RANKING_LEAGUES.map(async (slug) => {
      try {
        return await fetchScoreboard(slug, dateRange(LOOKAHEAD_DAYS));
      } catch (error) {
        console.warn(
          `[ProfitMax] Fixture feed failed for ${slug}: ` +
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

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  scan: ProfitMaximizerScan;
  timestamp: number;
}

/**
 * One module-level scan per server instance, kept for an hour. The MIN_EV
 * threshold is deliberately NOT part of the key: the cache holds every priced
 * market (positive edge or not) and the floor is applied per request, so
 * switching 5% → 10% → 15% never re-runs the engine walk.
 */
const globalForProfit = globalThis as typeof globalThis & {
  __gigiProfitMaximizerScan?: CacheEntry | null;
  __gigiProfitMaximizerInFlight?: Promise<ProfitMaximizerScan> | null;
};

async function buildScanPayload(forceRefresh: boolean): Promise<ProfitMaximizerScan> {
  const started = Date.now();
  const sources: ScanSourceReport[] = [];

  // The two feature feeds and the engine walk run concurrently — the feeds are
  // already cached upstream, so the ranking pass is what sets the wall time.
  const [sureCorners, first5, fixtures] = await Promise.all([
    callRoute<SureCornersResponse>(sureCornersGET, "/api/sure-corners", forceRefresh),
    callRoute<First5MinutesResponse>(first5GET, "/api/first-5-minutes", forceRefresh),
    fetchScanFixtures().catch((error) => {
      console.warn(
        `[ProfitMax] Fixture feed failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [] as FixtureLite[];
    }),
  ]);

  const candidates: CandidateMarket[] = [];
  let fixturesChecked = 0;
  let fixturesWalked = 0;
  let partial = false;

  const sureMatches = sureCorners.payload?.matches ?? [];
  const first5Matches = first5.payload?.matches ?? [];
  const sureCandidates = sureCornerCandidates(sureMatches);
  const first5CandidatesList = first5Candidates(first5Matches);
  candidates.push(...sureCandidates, ...first5CandidatesList);
  fixturesChecked += sureCorners.payload?.totalFixturesChecked ?? 0;

  const ranking = await scanRankingModes(
    fixtures.slice(0, MAX_RANKING_FIXTURES),
    started + SCAN_TIME_BUDGET_MS,
  );
  candidates.push(...ranking.candidates);
  fixturesChecked += fixtures.length;
  fixturesWalked += ranking.walked;
  partial = ranking.partial || fixtures.length > MAX_RANKING_FIXTURES;

  const { markets, duplicatesRemoved, skippedMarkets } = buildScan(candidates);
  const retainedBySource = countPerSource(markets);
  const evaluatedBySource = new Map<string, number>();
  for (const candidate of candidates) {
    evaluatedBySource.set(
      candidate.source,
      (evaluatedBySource.get(candidate.source) ?? 0) + 1,
    );
  }

  sources.push({
    source: "Ranking Modes (A–D)",
    ok: !ranking.error,
    fixtures: ranking.walked,
    marketsEvaluated: RANKING_SOURCES.reduce((sum, s) => sum + (evaluatedBySource.get(s) ?? 0), 0),
    retained: RANKING_SOURCES.reduce((sum, s) => sum + (retainedBySource.get(s) ?? 0), 0),
    ...(ranking.error ? { error: ranking.error } : {}),
  });
  sources.push({
    source: "Sure Bet Corners",
    ok: !!sureCorners.payload,
    fixtures: sureMatches.length,
    marketsEvaluated: evaluatedBySource.get("Sure Bet Corners") ?? 0,
    retained: retainedBySource.get("Sure Bet Corners") ?? 0,
    ...(sureCorners.error ? { error: sureCorners.error } : {}),
  });
  sources.push({
    source: "First 5 Minutes",
    ok: !!first5.payload,
    fixtures: first5Matches.length,
    marketsEvaluated: evaluatedBySource.get("First 5 Minutes") ?? 0,
    retained: retainedBySource.get("First 5 Minutes") ?? 0,
    ...(first5.error ? { error: first5.error } : {}),
  });

  console.info(
    `[ProfitMax] Scanned ${markets.length} unique market(s) from ${candidates.length} candidate(s) ` +
      `across ${fixturesWalked} engine fixture(s), ${sureCandidates.length} corner market(s) and ` +
      `${first5CandidatesList.length} opening-phase market(s) in ${Math.round((Date.now() - started) / 1000)}s ` +
      `(${duplicatesRemoved} duplicate(s) merged, ${skippedMarkets} skipped, ${partial ? "partial" : "complete"}).`,
  );

  return {
    generatedAt: new Date().toISOString(),
    markets,
    totalMarketsScanned: markets.length,
    duplicatesRemoved,
    skippedMarkets,
    fixturesChecked,
    fixturesWalked,
    partial,
    sources,
  };
}

function getScan(forceRefresh: boolean): Promise<ProfitMaximizerScan> {
  const cached = globalForProfit.__gigiProfitMaximizerScan ?? null;
  const age = cached ? Date.now() - cached.timestamp : Infinity;
  const fresh = cached !== null && age < CACHE_TTL_MS;

  if (forceRefresh) globalForProfit.__gigiProfitMaximizerScan = null;
  else if (fresh && cached) return Promise.resolve(cached.scan);

  // Single-flight: concurrent requests share one rebuild, and a failed rebuild
  // falls back to the last good scan (stale-while-revalidate semantics).
  if (!globalForProfit.__gigiProfitMaximizerInFlight) {
    const previous = cached?.scan ?? null;
    globalForProfit.__gigiProfitMaximizerInFlight = buildScanPayload(forceRefresh)
      .then((scan) => {
        globalForProfit.__gigiProfitMaximizerScan = { scan, timestamp: Date.now() };
        return scan;
      })
      .catch((error) => {
        if (previous) {
          console.warn(
            `[ProfitMax] Scan failed — serving the previous scan: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          return previous;
        }
        throw error;
      })
      .finally(() => {
        globalForProfit.__gigiProfitMaximizerInFlight = null;
      });
  }

  return globalForProfit.__gigiProfitMaximizerInFlight;
}

// ─── Response assembly ────────────────────────────────────────────────────────

function buildResponse(
  scan: ProfitMaximizerScan,
  minEv: number,
  meta: { hit: boolean; forcedRefresh: boolean },
): ProfitMaximizerResponse {
  // Spec: only positive EV qualifies, and only above the MIN_EV floor.
  const qualifying = scan.markets.filter((market) => market.ev > 0 && market.ev > minEv);
  const positiveEv = scan.markets.filter((market) => market.ev > 0);
  const withOdds = scan.markets.filter((market) => market.oddsSource === "bookmaker");
  const qualifyingEv = qualifying.length
    ? round((qualifying.reduce((sum, market) => sum + market.ev, 0) / qualifying.length) * 100, 2)
    : 0;
  const qualifyingKelly = qualifying.length
    ? round(qualifying.reduce((sum, market) => sum + market.kellyStake, 0) / qualifying.length, 4)
    : 0;

  return {
    generatedAt: scan.generatedAt,
    totalMarketsScanned: scan.totalMarketsScanned,
    qualifyingMarkets: qualifying,
    filters: {
      minEv,
      minEvPercent: `${round(minEv * 100, 2)}%`,
      defaultMinEv: DEFAULT_MIN_EV,
      lookaheadDays: LOOKAHEAD_DAYS,
      maxRankingFixtures: MAX_RANKING_FIXTURES,
      sources: ALL_SOURCES,
    },
    summary: {
      totalMarketsScanned: scan.totalMarketsScanned,
      qualifyingBets: qualifying.length,
      matchesWithBets: new Set(qualifying.map((market) => market.eventId)).size,
      averageEvPercent: qualifyingEv,
      averageKellyStake: qualifyingKelly,
      bestEvPercent: qualifying.length ? round(qualifying[0].ev * 100, 2) : 0,
      belowThreshold: positiveEv.length - qualifying.length,
      positiveEvMarkets: positiveEv.length,
      withRealBookmakerOdds: withOdds.length,
      fairOddsOnly: scan.markets.length - withOdds.length,
      duplicatesRemoved: scan.duplicatesRemoved,
      skippedMarkets: scan.skippedMarkets,
    },
    sources: scan.sources.map((report) => ({
      ...report,
      qualifying: qualifying.filter((market) =>
        report.source === "Ranking Modes (A–D)"
          ? market.source.startsWith("Rank")
          : market.source === report.source,
      ).length,
    })),
    methodology: {
      evFormula: "EV = (hitRate × bookmakerOdds) − 1",
      kellyFormula: "stake fraction = EV / (bookmakerOdds − 1), clamped to [0, 1]",
      fairOddsFormula: "fairOdds = 1 / hitRate",
      oddsPriority: [
        "1. Real bookmaker odds stored on the market (1xBet ladder price, or the fixture's odds feed matched through the value engine)",
        "2. Missing price → fairOdds = 1 / hitRate, tagged oddsSource: \"fair\" (zero EV by construction, so it never qualifies)",
        "3. Neither available → market skipped",
      ],
      notes: [
        "A market qualifies only when a REAL bookmaker price exists and the model edge over that price clears the MIN EV floor — the floor exists to overcome the book's margin.",
        "Sure Bet Corners publishes no bookmaker line, so its markets ride fair odds (zero EV) and are skipped until a book quotes them.",
        "First 5 Minutes prices come from the 1xBet decimal ladder stored on each market; ranking-mode prices come from the fixture's bookmaker feed matched by the value engine.",
        "Stakes are FULL Kelly clamped to [0, 1] as specified. Real bettors scale that down (half or quarter Kelly) — full Kelly is the growth-optimal, not the risk-minimal, sizing.",
        `Markets below a ${round(MIN_HIT_RATE * 100, 0)}% hit rate are skipped outright: a longshot price would demand a nonsensical all-in Kelly stake.`,
      ],
    },
    cache: { ttlMinutes: CACHE_TTL_MS / 60_000, hit: meta.hit, forcedRefresh: meta.forcedRefresh },
    partial: scan.partial,
    fixturesChecked: scan.fixturesChecked,
  };
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const forceRefresh = url.searchParams.get("refresh") === "true";
  const minEv = parseMinEv(url.searchParams.get("minEv"));

  const cachedScan = globalForProfit.__gigiProfitMaximizerScan;
  const servesCache =
    !forceRefresh && !!cachedScan && Date.now() - cachedScan.timestamp < CACHE_TTL_MS;

  try {
    const scan = await getScan(forceRefresh);
    return Response.json(buildResponse(scan, minEv, { hit: servesCache, forcedRefresh: forceRefresh }), {
      headers: {
        "Cache-Control": "no-store",
        // HIT when the hour-old scan was reused, MISS when it was rebuilt
        // (a ?refresh=true request always rebuilds, so it always reports MISS).
        "X-Cache": servesCache ? "HIT" : "MISS",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ProfitMax] Route failed: ${message}`);
    const empty: ProfitMaximizerScan = {
      generatedAt: new Date().toISOString(),
      markets: [],
      totalMarketsScanned: 0,
      duplicatesRemoved: 0,
      skippedMarkets: 0,
      fixturesChecked: 0,
      fixturesWalked: 0,
      partial: false,
      sources: [],
    };
    return Response.json(
      {
        ...buildResponse(empty, minEv, { hit: false, forcedRefresh: forceRefresh }),
        error: "Profit Maximizer is temporarily unavailable. No bet was shown without a positive edge.",
      },
      { status: 503, headers: { "Cache-Control": "no-store", "X-Cache": "MISS" } },
    );
  }
}
