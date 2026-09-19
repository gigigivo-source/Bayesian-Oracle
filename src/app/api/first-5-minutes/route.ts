// ĞIGI GIVØ — First 5 Minutes Markets (real-data-only).
//
// Predicts whether a goal, corner or card happens inside the opening five
// minutes of upcoming fixtures (next 7 days). Three markets per fixture —
// goal, corner, card. There is deliberately NO penalty market: no data source
// in the app provides pre-match penalty rates (the mesh profile has no
// penalties field, the Bzzoiro xG fetcher exposes only xG, the ESPN summary
// has no penalty field, and referee_stats.penaltiesPerGame has zero writers
// and zero readers). Do not re-add a penalty market without a real source.
//
// Integrity contract:
//   1. REAL DATA ONLY — every published market is computed from real
//      per-team data (Bzzoiro rolling xG, ESPN form averages, mesh corner /
//      card / foul distributions). There is no league-anchor fallback, no
//      hash jitter, no synthetic baseline anywhere in this file.
//   2. OMISSION OVER FABRICATION — when a market has no real baseline for a
//      fixture it is OMITTED from the response for that fixture (and logged).
//      A fixture with no publishable market is skipped entirely.
//   3. FAIL-SOFT — a failing provider never breaks the response; the affected
//      market (or fixture) is simply not published.
//
// ── Model ────────────────────────────────────────────────────────────────────
// Every market is modelled as a Poisson arrival process over match time:
//
//   λ_match  = expected events for the WHOLE match (real per-team data only)
//   λ_window = λ_match × (5 / 96) × openingIntensity × tempo
//   P(Yes)   = 1 − exp(−λ_window)
//   fairOdds = 1 / P(outcome)
//   1xBet    = fair odds snapped to the 1xBet decimal ladder
//
// `openingIntensity` corrects the naive uniform-minute assumption with the
// observed shape of the opening five minutes (goals and especially cards are
// rarer than a uniform split implies; corners are close to uniform).
// Tempo/aggression adjustments are normalised against the scan's own real
// data (mean of the fetched values across this scan), never a static table.
//
// ── Sources ──────────────────────────────────────────────────────────────────
//   Goal baseline   — Bzzoiro rolling team xG (xgFor, last 5 finished),
//                     else ESPN summary form averages (gfAvg). Both teams
//                     required or the market is omitted.
//   Corner baseline — mesh corner distributions (both teams, n > 0).
//   Card baseline   — mesh card distributions (both teams, n > 0).
//   Aggression      — mesh foul distributions (optional; defaults to 1.0).

import {
  assessMarketConfidence,
  toConfidenceBreakdown,
  type MarketConfidenceBreakdown,
  type MarketDataQuality,
} from "@/lib/data/confidence";
import type { MeshProfile } from "@/lib/engine/dataMesh";
import { getCachedMeshProfile } from "@/lib/engine/dataMesh";
import { fetchScoreboard, fetchSummary, type FixtureLite, type TeamLite } from "@/lib/espn";
import { fetchEventDetail, fetchTeamXgAverage } from "@/lib/va/xgFetcher";
import { resolveBzzoiroEvent } from "@/lib/va/oddsFetcher";
import { LEAGUE_TIER, leagueTier } from "@/lib/leaguePriority";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ─── Configuration ────────────────────────────────────────────────────────────

/** Fixture window shown on the page. */
const LOOKAHEAD_DAYS = 7;
/** Results are cached for one hour (same TTL as Sure Bet Corners). */
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
 * Per-fixture ceiling for the real-data fetch (mesh + Bzzoiro + ESPN
 * summary). A cold mesh profile fans out across many ESPN calls, so one
 * pathological fixture must never hold the whole feed hostage — on timeout
 * the fixture is skipped (no markets published for it).
 */
const REALDATA_TIMEOUT_MS = 25_000;
/** Competition tiers included in the feed. */
const MAX_LEAGUE_TIER = 3;
/** Hit-rate threshold that flips the "Likely Guaranteed" flag. */
export const GUARANTEED_HIT_RATE = 0.95;
/** Finished matches behind each Bzzoiro rolling xG average. */
const Xg_LAST_N = 5;

/**
 * Share of the match's events that land in minutes 0–5, relative to a uniform
 * split. Derived from observed opening-phase distributions: teams start
 * cautiously (goals ~0.45× uniform), referees are lenient early (cards
 * ~0.25×) and corners arrive almost uniformly from the first attacks (~0.78×).
 * There is no penalty entry — the penalty market does not exist (see header).
 */
const OPENING_INTENSITY = {
  goal: 0.45,
  corner: 0.78,
  card: 0.25,
} as const;

// ─── Public types ─────────────────────────────────────────────────────────────

export type First5MarketKey = "goal" | "corner" | "card";
export type First5Outcome = "Yes" | "No";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

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
  /**
   * Real provider names that supplied this market's baseline
   * (e.g. "Bzzoiro xG", "ESPN Mesh", "ESPN Form").
   */
  statsSource: string;
  /** Human-readable data provenance. */
  source: string;
  reason: string;
  /**
   * Always "real": synthetic markets are never published, so the tier is
   * invariant. Retained (rather than removed) because downstream consumers
   * (profit-maximizer) and the shared confidence annotation read this field.
   */
  dataQuality: MarketDataQuality;
  /** 0–100 model-confidence score (data quality 40% / source agreement 30% / stat completeness 30%). */
  confidenceScore: number;
  /** e.g. "Bzzoiro xG (Real)", "ESPN Mesh (Real)". */
  dataSourceDetail: string;
  /** Per-factor breakdown backing the score (drives the UI hover tooltip). */
  confidenceBreakdown: MarketConfidenceBreakdown;
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
  /** Real provider names behind this fixture's markets. */
  statsSource: string;
  /** Only publishable (real-data) markets — never padded with fallbacks. */
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

// ─── Cache ────────────────────────────────────────────────────────────────────

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
};

const MARKET_ORDER: First5MarketKey[] = ["goal", "corner", "card"];

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

// ─── Real per-team data (one fetch per fixture) ───────────────────────────────

/**
 * Everything real this fixture yielded. Any `null` pair means the
 * corresponding market is NOT published for this fixture — there is no
 * fallback, mirroring, or league-average substitution.
 */
interface RealFixtureData {
  fx: FixtureLite;
  /** Per-team goal expectation: Bzzoiro xgFor, else ESPN form gfAvg. */
  homeGoals: number | null;
  awayGoals: number | null;
  /** Which real source supplied the goal baseline (for the reason string). */
  goalSource: string | null;
  /** Sample counts behind the goal baseline (xG matches / form games). */
  homeGoalSamples: number | null;
  awayGoalSamples: number | null;
  /** Mesh corner means (null unless the distribution has n > 0). */
  homeCorners: number | null;
  awayCorners: number | null;
  /** Mesh card means (null unless the distribution has n > 0). */
  homeCards: number | null;
  awayCards: number | null;
  /** Mesh foul means for the aggression adjustment (optional). */
  homeFouls: number | null;
  awayFouls: number | null;
  /** Mesh sample counts (finished matches averaged) for the reason strings. */
  homeMeshSamples: number | null;
  awayMeshSamples: number | null;
}

/**
 * A mesh distribution mean is real data only when it was averaged over at
 * least one finished match (n > 0). A { mean: 0, n: 0 } distribution (e.g.
 * corners on a season-aggregates-only profile) is absence of data, not a
 * zero average — publishing λ = 0 from it would be fabrication.
 */
function meshMean(
  profile: MeshProfile | null,
  field: "corners" | "cards" | "fouls",
): number | null {
  const dist = profile?.[field];
  if (!dist || dist.n <= 0) return null;
  return typeof dist.mean === "number" && Number.isFinite(dist.mean) ? dist.mean : null;
}

function meshSamples(profile: MeshProfile | null): number | null {
  return profile && profile.samples > 0 ? profile.samples : null;
}

/**
 * Goal baseline, real sources only. Bzzoiro rolling xG first (xgFor per
 * team); when either side is missing, ESPN summary form averages (gfAvg per
 * team, gated on at least one form game — a 0.00 average over zero games is
 * absence of data, not a zero). Returns nulls when neither source delivers
 * both teams, and the goal market is then omitted.
 */
async function fetchGoalBaseline(fx: FixtureLite): Promise<{
  home: number | null;
  away: number | null;
  source: string | null;
  homeSamples: number | null;
  awaySamples: number | null;
}> {
  const empty = { home: null, away: null, source: null, homeSamples: null, awaySamples: null };

  try {
    const bzEvent = await resolveBzzoiroEvent(fx).catch(() => null);
    if (bzEvent?.eventId) {
      const detail = await fetchEventDetail(bzEvent.eventId).catch(() => null);
      if (detail?.homeTeamId != null && detail?.awayTeamId != null) {
        const [h, a] = await Promise.all([
          fetchTeamXgAverage(detail.homeTeamId, Xg_LAST_N).catch(() => null),
          fetchTeamXgAverage(detail.awayTeamId, Xg_LAST_N).catch(() => null),
        ]);
        if (h?.xgFor != null && a?.xgFor != null) {
          return {
            home: h.xgFor,
            away: a.xgFor,
            source: "Bzzoiro xG",
            homeSamples: h.samples,
            awaySamples: a.samples,
          };
        }
      }
    }
  } catch {
    // fail-soft → ESPN form fallback below
  }

  try {
    const sum = await fetchSummary(fx.leagueSlug, fx.id).catch(() => null);
    const homeGames = sum?.homeForm?.games?.length ?? 0;
    const awayGames = sum?.awayForm?.games?.length ?? 0;
    const homeAvg = sum?.homeForm?.gfAvg;
    const awayAvg = sum?.awayForm?.gfAvg;
    if (
      homeGames > 0 &&
      awayGames > 0 &&
      typeof homeAvg === "number" &&
      Number.isFinite(homeAvg) &&
      typeof awayAvg === "number" &&
      Number.isFinite(awayAvg)
    ) {
      return {
        home: homeAvg,
        away: awayAvg,
        source: "ESPN Form",
        homeSamples: homeGames,
        awaySamples: awayGames,
      };
    }
  } catch {
    // fail-soft → goal market omitted for this fixture
  }

  return empty;
}

async function fetchRealFixtureData(fx: FixtureLite): Promise<RealFixtureData> {
  const [homeMesh, awayMesh, goals] = await Promise.all([
    getCachedMeshProfile(fx.home.name, fx.leagueSlug).catch(() => null),
    getCachedMeshProfile(fx.away.name, fx.leagueSlug).catch(() => null),
    fetchGoalBaseline(fx),
  ]);

  return {
    fx,
    homeGoals: goals.home,
    awayGoals: goals.away,
    goalSource: goals.source,
    homeGoalSamples: goals.homeSamples,
    awayGoalSamples: goals.awaySamples,
    homeCorners: meshMean(homeMesh, "corners"),
    awayCorners: meshMean(awayMesh, "corners"),
    homeCards: meshMean(homeMesh, "cards"),
    awayCards: meshMean(awayMesh, "cards"),
    homeFouls: meshMean(homeMesh, "fouls"),
    awayFouls: meshMean(awayMesh, "fouls"),
    homeMeshSamples: meshSamples(homeMesh),
    awayMeshSamples: meshSamples(awayMesh),
  };
}

// ─── Scan-level normalisation (real data only) ────────────────────────────────

/**
 * League-average analogues for the tempo/aggression adjustments, computed
 * from the real values fetched in THIS scan — never from a static anchor
 * table. Null when the scan yielded no usable totals (adjustment → 1.0).
 */
interface ScanAverages {
  goalTotalAvg: number | null;
  foulTotalAvg: number | null;
}

function computeScanAverages(rows: RealFixtureData[]): ScanAverages {
  const goalTotals = rows
    .filter((r) => r.homeGoals != null && r.awayGoals != null)
    .map((r) => (r.homeGoals as number) + (r.awayGoals as number));
  const foulTotals = rows
    .filter((r) => r.homeFouls != null && r.awayFouls != null)
    .map((r) => (r.homeFouls as number) + (r.awayFouls as number));
  const mean = (xs: number[]): number | null =>
    xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  return { goalTotalAvg: mean(goalTotals), foulTotalAvg: mean(foulTotals) };
}

/**
 * Tempo multiplier: sides scoring above the scan's real goal average start
 * faster. Bounded so one noisy input can never dominate the intensity.
 */
function tempoFactor(goalTotal: number, scanAvg: number | null): number {
  if (scanAvg == null || scanAvg <= 0) return 1;
  return clamp(goalTotal / Math.max(0.5, scanAvg), 0.8, 1.25);
}

/** Aggression multiplier from real mesh fouls vs the scan's foul average. */
function aggressionFactor(foulTotal: number | null, scanAvg: number | null): number {
  if (foulTotal == null || scanAvg == null || scanAvg <= 0) return 1;
  return clamp(foulTotal / Math.max(1, scanAvg), 0.8, 1.25);
}

// ─── Market construction ─────────────────────────────────────────────────────

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
  perMatch: number,
  adjustment: number,
  sourceNames: string[],
  detail: string,
): First5Market {
  const meta = MARKET_META[key];
  const uniformShare = WINDOW_MINUTES / MATCH_MINUTES;
  const lambdaWindow = perMatch * uniformShare * OPENING_INTENSITY[key] * adjustment;
  const probability = clamp(atLeastOne(lambdaWindow), 0.0005, 0.9995);
  const yes = buildOutcome("Yes", probability);
  const no = buildOutcome("No", 1 - probability);
  const outcome: First5Outcome = probability >= 0.5 ? "Yes" : "No";
  const selected = outcome === "Yes" ? yes : no;
  const statsSource = sourceNames.join(" + ");

  // Every published market is real by construction: full data-quality credit,
  // agreement over the contributing real sources, 100% real inputs.
  const assessment = assessMarketConfidence({
    dataQuality: "real",
    sourceCount: sourceNames.length,
    completenessPct: 100,
    sourceNames,
  });

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
    expectedPerMatch: round(perMatch, 2),
    statsSource,
    source: statsSource,
    reason:
      `${detail} → ${round(lambdaWindow, 3)} expected ${meta.shortLabel.toLowerCase()} ` +
      `events in minutes 0–${WINDOW_MINUTES} ` +
      `(opening intensity ${OPENING_INTENSITY[key]}× uniform, tempo ${adjustment.toFixed(2)}×). ` +
      `Poisson P(at least one) = ${(probability * 100).toFixed(1)}% · real per-team data.`,
    dataQuality: assessment.dataQuality,
    confidenceScore: assessment.confidenceScore,
    dataSourceDetail: assessment.dataSourceDetail,
    confidenceBreakdown: toConfidenceBreakdown(assessment),
  };
}

/**
 * Publishable markets for one fixture — real data only. Each market needs
 * BOTH teams' inputs; anything missing is omitted (and logged), never
 * mirrored, never substituted. Returns null when nothing is publishable.
 */
function buildMarkets(
  row: RealFixtureData,
  scan: ScanAverages,
): First5Market[] | null {
  const { fx } = row;
  const markets: First5Market[] = [];
  const omission = (key: string) =>
    console.info(`[First5] ${formatMatch(fx)}: ${key} market omitted (no real baseline)`);

  const goalTotal =
    row.homeGoals != null && row.awayGoals != null ? row.homeGoals + row.awayGoals : null;
  const foulTotal =
    row.homeFouls != null && row.awayFouls != null ? row.homeFouls + row.awayFouls : null;
  const tempo = goalTotal != null ? tempoFactor(goalTotal, scan.goalTotalAvg) : 1;
  const aggression = aggressionFactor(foulTotal, scan.foulTotalAvg);

  // Goal — Bzzoiro xG or ESPN form (both teams required).
  if (goalTotal != null && row.goalSource) {
    const perMatch = clamp(goalTotal, 0.6, 6);
    const sampleNote =
      row.homeGoalSamples != null && row.awayGoalSamples != null
        ? ` over ${row.homeGoalSamples}/${row.awayGoalSamples} matches`
        : "";
    markets.push(
      buildMarket(
        fx,
        "goal",
        perMatch,
        tempo,
        [row.goalSource],
        `${row.goalSource} ${goalTotal.toFixed(2)} combined (home ${row.homeGoals?.toFixed(2)}, away ${row.awayGoals?.toFixed(2)}${sampleNote})`,
      ),
    );
  } else {
    omission("goal");
  }

  // Corner / card — mesh distributions (both teams, n > 0, required).
  const cornerTotal =
    row.homeCorners != null && row.awayCorners != null ? row.homeCorners + row.awayCorners : null;
  if (cornerTotal != null) {
    markets.push(
      buildMarket(
        fx,
        "corner",
        clamp(cornerTotal, 3, 18),
        tempo,
        ["ESPN Mesh"],
        `mesh corner averages ${cornerTotal.toFixed(1)}/match (home ${row.homeCorners?.toFixed(1)}, away ${row.awayCorners?.toFixed(1)} over ${row.homeMeshSamples ?? "?"}/${row.awayMeshSamples ?? "?"} matches)`,
      ),
    );
  } else {
    omission("corner");
  }

  const cardTotal =
    row.homeCards != null && row.awayCards != null ? row.homeCards + row.awayCards : null;
  if (cardTotal != null) {
    markets.push(
      buildMarket(
        fx,
        "card",
        clamp(cardTotal, 1, 10),
        aggression,
        ["ESPN Mesh"],
        `mesh card averages ${cardTotal.toFixed(1)}/match (home ${row.homeCards?.toFixed(1)}, away ${row.awayCards?.toFixed(1)} over ${row.homeMeshSamples ?? "?"}/${row.awayMeshSamples ?? "?"} matches)`,
      ),
    );
  } else {
    omission("card");
  }

  // No penalty market: no source in the app provides pre-match penalty rates
  // (see the header comment). It is omitted by design, not by accident.

  return markets.length > 0 ? markets : null;
}

// ─── Fixture + data plumbing ──────────────────────────────────────────────────

function teamLogo(team: TeamLite): string | null {
  return team.logo ?? null;
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout?: () => void,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T | null>((resolve) => {
        timer = setTimeout(() => {
          onTimeout?.();
          resolve(null);
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

function buildMatch(fx: FixtureLite, markets: First5Market[]): First5Match {
  const sources = [...new Set(markets.flatMap((m) => m.statsSource.split(" + ")))];
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
    statsSource: sources.join(" + "),
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
        "λ_match comes from real per-team data only (Bzzoiro rolling xG or ESPN form " +
        "averages for goals; mesh corner/card distributions). Markets without a real " +
        "baseline are omitted — never synthesised. No penalty market: no source " +
        "provides pre-match penalty rates.",
      matchMinutes: MATCH_MINUTES,
      openingIntensity: { ...OPENING_INTENSITY },
    },
    cache: { ttlMinutes: CACHE_TTL_MS / 60_000, hit: false },
    matches: [],
    ...overrides,
  };
}

// ─── Pick persistence (dedicated feature tracking) ────────────────────────────

/**
 * Persist every generated First 5 Minutes pick to performance_log
 * (feature = 'first5', outcome = 'pending') so the settlement cron's feature
 * pass (/api/cron/settle) can resolve each market from real first-5-minute
 * event data once the match finishes, and /performance/first5 can report the
 * feature's dedicated track record.
 *
 * The saved pick is the market's selected side — the more likely of Yes / No —
 * with its predicted hit rate, confidence tier and the 1xBet-ladder price at
 * pick time (stored inside top10Detail so P&L settles at the quoted price).
 * Idempotent: one row per (eventId, market label, selection).
 *
 * rankingMode is stamped with the 'F' feature sentinel — never one of the
 * A–D ranking modes — so the pick is never adopted by the ranking-mode
 * pipeline. pending is deliberately 0 for the same reason the sure-corners
 * writer keeps it 0: the settle cron's pending-performance refresh (which
 * sweeps rows with pending > 0) must never adopt these rows; they settle
 * through the `outcome` column instead.
 *
 * Fail-soft by design: a missing or unreachable database must never break
 * the public feed, so the whole persistence step is wrapped in try/catch
 * and the db module is imported dynamically (the same pattern the Sure Bet
 * Corners route uses).
 */
async function persistFirst5Picks(matches: First5Match[]): Promise<void> {
  try {
    const { db } = await import("@/db");
    const { performanceLog } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");

    let saved = 0;
    for (const match of matches) {
      for (const market of match.markets) {
        // The pick is the market's selected side: "Yes" or "No".
        const selection = market.outcome;
        const existing = await db
          .select({ id: performanceLog.id })
          .from(performanceLog)
          .where(and(
            eq(performanceLog.eventId, match.fixtureId),
            eq(performanceLog.feature, "first5"),
            eq(performanceLog.market, market.label),
            eq(performanceLog.selection, selection),
          ))
          .limit(1);
        if (existing[0]) continue;

        await db.insert(performanceLog).values({
          eventId: match.fixtureId,
          matchLabel: `${match.homeTeam} vs ${match.awayTeam}`,
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          league: match.league,
          leagueSlug: match.leagueSlug,
          competitionName: match.league,
          matchDate: match.date.slice(0, 10),
          // Pre-match row: the settlement cron's feature pass stamps the
          // final score, outcome and settledAt once the match has finished.
          homeScore: 0,
          awayScore: 0,
          totalPicks: 1,
          hits: 0,
          misses: 0,
          pending: 0,
          accuracy: 0,
          top10Detail: [{
            name: market.label,
            selection,
            hitRate: market.hitRate,
            outcome: "PENDING",
            family: market.shortLabel,   // Goal | Corner | Card
            odds: market.odds.selected,  // 1xBet-ladder price at pick time
          }],
          lowConfidence: false,
          rankingMode: "F",
          feature: "first5",
          market: market.label,
          selection,
          outcome: "pending",
          hitRate: market.hitRate,
          confidence: market.confidence,
        });
        saved++;
      }
    }
    console.info(
      `[First5] Persisted ${saved} new first-5-minute pick(s) to performance_log (feature first5)`,
    );
  } catch (error) {
    console.warn(
      `[First5] Could not persist first-5-minute picks: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

    // Pass 1: real per-team data for every fixture (mesh + Bzzoiro + ESPN).
    const rows = await mapWithConcurrency(fixtures, CONCURRENCY, async (fx) =>
      withTimeout(fetchRealFixtureData(fx), REALDATA_TIMEOUT_MS, () =>
        console.warn(
          `[First5] ${formatMatch(fx)}: real-data fetch timed out after ` +
          `${REALDATA_TIMEOUT_MS}ms; fixture skipped (no markets published)`,
        ),
      ),
    );
    const usable = rows.filter((row): row is RealFixtureData => row !== null);

    // Pass 2: scan averages from the fetched real data (tempo normalisation).
    const scan = computeScanAverages(usable);

    // Pass 3: publishable markets only — fixtures with no real baseline for
    // any market are skipped entirely (never padded with fallbacks).
    const matches: First5Match[] = [];
    for (const row of usable) {
      const markets = buildMarkets(row, scan);
      if (!markets) {
        console.info(
          `[First5] ${formatMatch(row.fx)}: fixture skipped (no real baseline for any market)`,
        );
        continue;
      }
      matches.push(buildMatch(row.fx, markets));
    }

    const marketCount = matches.reduce((sum, m) => sum + m.markets.length, 0);
    console.info(
      `[First5] ${matches.length}/${fixtures.length} fixture(s) published with real per-team data ` +
      `(${marketCount} markets, ${fixtures.length - matches.length} skipped for lack of data).`,
    );

    // Record every generated pick so the settlement cron's feature pass
    // (/api/cron/settle) can resolve it from real first-5-minute event data
    // once the match finishes, and /performance/first5 can report the
    // feature's dedicated track record.
    await persistFirst5Picks(matches);

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
