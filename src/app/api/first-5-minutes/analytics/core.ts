// ĞIGI GIVØ — First 5 Minutes analytics.
//
// Aggregates behind the "📊 Analytics" bottom sheet of the First 5 Minutes
// board: realised vs claimed performance for every settled first5 pick,
// sliced per market, selection, confidence tier, league and claimed-probability
// bucket, plus a week-over-week trend and a best/worst trust ranking.
//
// Rows come straight from performance_log (feature = 'first5'; settled rows
// are outcome IN WIN | LOSS | PUSH | VOID — 'pending' rows are never counted).
// Every slice is its own SQL GROUP BY query over the same filtered source: the
// table keeps growing, so nothing is ever loaded row-by-row and grouped in
// Node. This route only derives per-group ratios (realised, edge), rounding
// and the action verdict from the counts SQL already computed.
//
// GET /api/first-5-minutes/analytics?days=30
//   days  look-back window on match_date for every aggregate (default 30,
//         max 365). The trend slice keeps its own fixed windows — last 7 days
//         vs the 8-14-days-ago week — always relative to now.
//
// Responses are cached in an in-memory Map keyed by windowDays for 5 minutes
// (settled data changes at most hourly), and the route fails soft by
// contract: a database error is logged once and answered with a zeroed
// payload, never a 5xx, so the sheet can always render something.

import { performanceLog } from "@/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** performance_log discriminator for First 5 Minutes picks. */
const FEATURE = "first5";
/** Outcomes the settlement cron stamps on settled feature rows. */
const SETTLED_OUTCOMES = ["WIN", "LOSS", "PUSH", "VOID"] as const;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/** Sample-size gate for the per-market action verdicts. */
export const MIN_SAMPLE = 20;
/** |edge| inside this band (±5 pts) means the model is on target. */
const TRUSTED_MAX_EDGE = 0.05;
/** An edge below this (−15 pts) means the market systematically under-delivers. */
const AVOID_MIN_EDGE = -0.15;

/** In-memory response cache: settled data changes hourly, 5 minutes is plenty. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const responseCache = new Map<
  number,
  { expiresAt: number; body: First5AnalyticsResponse }
>();

// ─── Response types ───────────────────────────────────────────────────────────

export type First5AnalyticsAction = "trusted" | "watch" | "avoid" | "insufficient";

export interface First5AnalyticsTotals {
  settled: number;
  won: number;
  lost: number;
  push: number;
  void: number;
  /** won / (won + lost), 0 when nothing is decided. */
  realisedRate: number;
  /** Mean claimed hitRate over settled rows. */
  claimedAverage: number;
  /** realisedRate − claimedAverage (positive = the model beats its claim). */
  edge: number;
}

export interface First5AnalyticsSplit {
  n: number;
  won: number;
  lost: number;
  realised: number;
  claimed: number;
  edge: number;
}

export interface First5MarketAnalytics extends First5AnalyticsSplit {
  market: string;
  action: First5AnalyticsAction;
}

export interface First5SelectionAnalytics extends First5AnalyticsSplit {
  selection: string;
}

export interface First5ConfidenceAnalytics extends First5AnalyticsSplit {
  band: "HIGH" | "MEDIUM" | "LOW";
}

export interface First5LeagueAnalytics extends First5AnalyticsSplit {
  leagueSlug: string;
  leagueName: string;
}

export interface First5BucketAnalytics {
  bucket: string;
  n: number;
  realised: number;
  claimed: number;
  /** realised − claimed for the bucket (calibration drift). */
  diff: number;
}

export interface First5TrustRow {
  marketKey: string;
  n: number;
  edge: number;
  action: First5AnalyticsAction;
}

export interface First5AnalyticsResponse {
  ok: true;
  generatedAt: string;
  windowDays: number;
  totals: First5AnalyticsTotals;
  byMarket: First5MarketAnalytics[];
  bySelection: First5SelectionAnalytics[];
  byConfidence: First5ConfidenceAnalytics[];
  byLeague: First5LeagueAnalytics[];
  byBucket: First5BucketAnalytics[];
  trend: { last7d: First5AnalyticsSplit; previous: First5AnalyticsSplit };
  trust: { best: First5TrustRow[]; worst: First5TrustRow[] };
}

// ─── Pure helpers (shared by the SQL builders and the test suite) ─────────────

/** Claimed-probability calibration buckets, [0.50, 1.00] in 0.10 steps. */
export const ANALYTICS_BUCKETS = [
  "0.50-0.60",
  "0.60-0.70",
  "0.70-0.80",
  "0.80-0.90",
  "0.90-1.00",
] as const;

/**
 * Bucket label for a claimed hitRate, or null when the row falls outside the
 * calibration range. Bounds are compared as integers (hitRate × 100) so the
 * float drift around 0.6 / 0.7 / … cannot push a value into the wrong bucket;
 * the SQL CASE below is generated from the same constant.
 */
export function bucketFor(hitRate: number): string | null {
  if (!Number.isFinite(hitRate) || hitRate < 0.5 || hitRate > 1) return null;
  const pct = Math.floor(hitRate * 100 + 1e-9);
  const index = Math.min(ANALYTICS_BUCKETS.length - 1, Math.floor((pct - 50) / 10));
  return ANALYTICS_BUCKETS[index];
}

/**
 * Action verdict for one aggregate row, from its sample size and edge:
 *   n < 20            → insufficient
 *   |edge| < 0.05     → trusted
 *   edge > −0.15      → watch
 *   otherwise         → avoid
 */
export function actionFor(n: number, edge: number): First5AnalyticsAction {
  if (!Number.isFinite(n) || n < MIN_SAMPLE) return "insufficient";
  if (!Number.isFinite(edge)) return "insufficient";
  if (Math.abs(edge) < TRUSTED_MAX_EDGE) return "trusted";
  if (edge > AVOID_MIN_EDGE) return "watch";
  return "avoid";
}

/** ISO day (YYYY-MM-DD) `days` before `reference`, evaluated in UTC. */
export function isoDaysAgo(reference: Date, days: number): string {
  const date = new Date(reference.getTime());
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export interface TrendWindows {
  /** Inclusive start day of the rolling last-7-days window. */
  last7Start: string;
  /** Inclusive start day of the preceding 8-14-days-ago window. */
  previousStart: string;
}

/** The two rolling trend windows, both relative to `reference` (now). */
export function trendWindows(reference: Date): TrendWindows {
  return {
    last7Start: isoDaysAgo(reference, 7),
    previousStart: isoDaysAgo(reference, 14),
  };
}

/**
 * Which trend slice a settled row's match_date falls into. Day strings are
 * ISO and sort chronologically, so a lexicographic compare is the window test;
 * both boundaries are inclusive.
 */
export function trendPeriodFor(
  matchDate: string,
  windows: TrendWindows,
): "last7d" | "previous" | null {
  const day = typeof matchDate === "string" ? matchDate.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  if (day >= windows.last7Start) return "last7d";
  if (day >= windows.previousStart) return "previous";
  return null;
}

/** Drops the cached analytics payloads (used by tests and forced refreshes). */
export function clearAnalyticsCache(): void {
  responseCache.clear();
}

// ─── Row normalisation ────────────────────────────────────────────────────────
// The pg driver can hand numeric columns back as strings; every value is
// coerced once here instead of trusting the wire shape.

type RawRow = Record<string, unknown>;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toNum(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Round to three decimals — 2/3 → 0.667 — so payloads stay readable. */
function round3(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

const CONFIDENCE_TIERS = ["HIGH", "MEDIUM", "LOW"] as const;

/** Settled rows always carry a tier; an unrecognisable value presents LOW. */
function asBand(value: unknown): (typeof CONFIDENCE_TIERS)[number] {
  const tier = asText(value).toUpperCase();
  return (CONFIDENCE_TIERS as readonly string[]).includes(tier)
    ? (tier as (typeof CONFIDENCE_TIERS)[number])
    : "LOW";
}

const ZERO_SPLIT: First5AnalyticsSplit = {
  n: 0, won: 0, lost: 0, realised: 0, claimed: 0, edge: 0,
};

/**
 * Derive the realised/claimed/edge block for one SQL group. SQL owns the
 * counts (n, won, lost) and the claimed average; the ratios are per-group
 * arithmetic on those aggregates, never a row-level computation in Node.
 */
function splitStats(row: RawRow): First5AnalyticsSplit {
  const n = toCount(row.n);
  const won = toCount(row.won);
  const lost = toCount(row.lost);
  const claimed = round3(toNum(row.claimed));
  const decided = won + lost;
  const realisedRaw = decided > 0 ? won / decided : 0;
  return {
    n,
    won,
    lost,
    realised: round3(realisedRaw),
    claimed,
    edge: round3(realisedRaw - claimed),
  };
}

// ─── SQL fragments ────────────────────────────────────────────────────────────
// One GROUP BY query per dimension below, all sharing the same base filter.
// The first selected key of each query names its dimension (settled, market,
// selection, band, leagueSlug, bucket, period) — the test stub routes its
// canned rows off that key.

const nCount = sql<number>`count(*)::int`;
const wonCount = sql<number>`(count(*) filter (where ${performanceLog.outcome} = 'WIN'))::int`;
const lostCount = sql<number>`(count(*) filter (where ${performanceLog.outcome} = 'LOSS'))::int`;
const claimedAvg = sql<number>`coalesce(avg(${performanceLog.hitRate}), 0)::float`;

/** CASE labelling each hitRate with its calibration bucket (see bucketFor). */
const bucketExpr = sql`case ${sql.join(
  ANALYTICS_BUCKETS.map((label, index) => {
    const [lower, upper] = label.split("-").map(Number);
    const last = index === ANALYTICS_BUCKETS.length - 1;
    return sql`when ${performanceLog.hitRate} >= ${lower} and ${performanceLog.hitRate} ${last ? sql`<=` : sql`<`} ${upper} then ${label}::text`;
  }),
  sql` `,
)} end`;

// ─── Query + assembly ─────────────────────────────────────────────────────────

async function computeAnalytics(days: number): Promise<First5AnalyticsResponse> {
  // Imported inside the request so a deployment without a reachable database
  // still answers (fail-soft) instead of failing the module load.
  const { db } = await import("@/db");

  const now = new Date();
  const windowStart = isoDaysAgo(now, days);
  const windows = trendWindows(now);

  // Base filter: settled first5 rows inside the requested look-back window.
  // match_date is a TEXT ISO-day column, so the window is a lexicographic
  // compare against the same shape (see the results route for the rationale).
  const settledFilter = and(
    eq(performanceLog.feature, FEATURE),
    inArray(performanceLog.outcome, [...SETTLED_OUTCOMES]),
    sql`left(${performanceLog.matchDate}, 10) >= ${windowStart}`,
  );

  // 1 ── Totals (single aggregate row, no dimension).
  const totalsRows = (await db
    .select({
      settled: nCount,
      won: wonCount,
      lost: lostCount,
      push: sql<number>`(count(*) filter (where ${performanceLog.outcome} = 'PUSH'))::int`,
      void: sql<number>`(count(*) filter (where ${performanceLog.outcome} = 'VOID'))::int`,
      claimed: claimedAvg,
    })
    .from(performanceLog)
    .where(settledFilter)) as unknown as RawRow[];

  const totalsRow = totalsRows[0] ?? {};
  const settled = toCount(totalsRow.settled);
  const won = toCount(totalsRow.won);
  const lost = toCount(totalsRow.lost);
  const push = toCount(totalsRow.push);
  const voided = toCount(totalsRow.void);
  const realisedRate = won + lost > 0 ? won / (won + lost) : 0;
  const claimedAverage = round3(toNum(totalsRow.claimed));
  const totals: First5AnalyticsTotals = {
    settled,
    won,
    lost,
    push,
    void: voided,
    realisedRate: round3(realisedRate),
    claimedAverage,
    edge: round3(realisedRate - claimedAverage),
  };

  // 2 ── Per market.
  const marketRows = (await db
    .select({ market: performanceLog.market, n: nCount, won: wonCount, lost: lostCount, claimed: claimedAvg })
    .from(performanceLog)
    .where(settledFilter)
    .groupBy(performanceLog.market)
    .orderBy(desc(sql`count(*)`))) as unknown as RawRow[];

  const byMarket: First5MarketAnalytics[] = marketRows
    .map((row) => {
      const stats = splitStats(row);
      return {
        market: asText(row.market) || "Unknown market",
        ...stats,
        action: actionFor(stats.n, stats.edge),
      };
    })
    .sort((a, b) => b.n - a.n);

  // 3 ── Per selection (Yes / No).
  const selectionRows = (await db
    .select({ selection: performanceLog.selection, n: nCount, won: wonCount, lost: lostCount, claimed: claimedAvg })
    .from(performanceLog)
    .where(settledFilter)
    .groupBy(performanceLog.selection)
    .orderBy(desc(sql`count(*)`))) as unknown as RawRow[];

  const bySelection: First5SelectionAnalytics[] = selectionRows
    .map((row) => ({ selection: asText(row.selection) || "Unknown", ...splitStats(row) }))
    .sort((a, b) => b.n - a.n);

  // 4 ── Per confidence tier.
  const confidenceRows = (await db
    .select({ band: performanceLog.confidence, n: nCount, won: wonCount, lost: lostCount, claimed: claimedAvg })
    .from(performanceLog)
    .where(settledFilter)
    .groupBy(performanceLog.confidence)) as unknown as RawRow[];

  const tierOrder = new Map<string, number>(CONFIDENCE_TIERS.map((tier, index) => [tier, index]));
  const byConfidence: First5ConfidenceAnalytics[] = confidenceRows
    .map((row) => ({ band: asBand(row.band), ...splitStats(row) }))
    .sort((a, b) => (tierOrder.get(a.band) ?? 3) - (tierOrder.get(b.band) ?? 3) || b.n - a.n);

  // 5 ── Per league.
  const leagueRows = (await db
    .select({
      leagueSlug: performanceLog.leagueSlug,
      leagueName: performanceLog.league,
      n: nCount,
      won: wonCount,
      lost: lostCount,
      claimed: claimedAvg,
    })
    .from(performanceLog)
    .where(settledFilter)
    .groupBy(performanceLog.leagueSlug, performanceLog.league)
    .orderBy(desc(sql`count(*)`))) as unknown as RawRow[];

  const byLeague: First5LeagueAnalytics[] = leagueRows
    .map((row) => {
      const leagueSlug = asText(row.leagueSlug) || "unknown";
      return {
        leagueSlug,
        leagueName: asText(row.leagueName) || leagueSlug,
        ...splitStats(row),
      };
    })
    .sort((a, b) => b.n - a.n || a.leagueName.localeCompare(b.leagueName));

  // 6 ── Calibration buckets. Rows outside [0.50, 1.00] are excluded here.
  const bucketRows = (await db
    .select({ bucket: bucketExpr, n: nCount, won: wonCount, lost: lostCount, claimed: claimedAvg })
    .from(performanceLog)
    .where(and(
      settledFilter,
      sql`${performanceLog.hitRate} >= 0.5 and ${performanceLog.hitRate} <= 1.0`,
    ))
    .groupBy(bucketExpr)) as unknown as RawRow[];

  const bucketIndex = new Map<string, number>(
    ANALYTICS_BUCKETS.map((label, index) => [label, index]),
  );
  const byBucket: First5BucketAnalytics[] = bucketRows
    .map((row) => {
      const stats = splitStats(row);
      return {
        bucket: asText(row.bucket) || "unknown",
        n: stats.n,
        realised: stats.realised,
        claimed: stats.claimed,
        diff: stats.edge,
      };
    })
    .sort(
      (a, b) =>
        (bucketIndex.get(a.bucket) ?? ANALYTICS_BUCKETS.length) -
          (bucketIndex.get(b.bucket) ?? ANALYTICS_BUCKETS.length),
    );

  // 7 ── Trend: last 7 days vs the preceding week, relative to now (independent
  // of the ?days window, which can be narrower than the 14-day trend span).
  const periodExpr = sql`case when left(${performanceLog.matchDate}, 10) >= ${windows.last7Start} then 'last7d' when left(${performanceLog.matchDate}, 10) >= ${windows.previousStart} then 'previous' end`;
  const trendRows = (await db
    .select({ period: periodExpr, n: nCount, won: wonCount, lost: lostCount, claimed: claimedAvg })
    .from(performanceLog)
    .where(and(
      eq(performanceLog.feature, FEATURE),
      inArray(performanceLog.outcome, [...SETTLED_OUTCOMES]),
      sql`left(${performanceLog.matchDate}, 10) >= ${windows.previousStart}`,
    ))
    .groupBy(periodExpr)) as unknown as RawRow[];

  const trend: First5AnalyticsResponse["trend"] = {
    last7d: { ...ZERO_SPLIT },
    previous: { ...ZERO_SPLIT },
  };
  for (const row of trendRows) {
    const period = asText(row.period);
    if (period === "last7d" || period === "previous") trend[period] = splitStats(row);
  }

  // 8 ── Trust ranking: best/worst five markets with a real sample behind them.
  const qualified = byMarket.filter((row) => row.n >= MIN_SAMPLE);
  const toTrustRow = (row: First5MarketAnalytics): First5TrustRow => ({
    marketKey: row.market,
    n: row.n,
    edge: row.edge,
    action: row.action,
  });
  const trust = {
    best: [...qualified]
      .sort((a, b) => b.edge - a.edge || b.n - a.n)
      .slice(0, 5)
      .map(toTrustRow),
    worst: [...qualified]
      .sort((a, b) => a.edge - b.edge || b.n - a.n)
      .slice(0, 5)
      .map(toTrustRow),
  };

  return {
    ok: true,
    generatedAt: now.toISOString(),
    windowDays: days,
    totals,
    byMarket,
    bySelection,
    byConfidence,
    byLeague,
    byBucket,
    trend,
    trust,
  };
}

/** The fail-soft payload: everything zeroed, nothing null. */
function emptyBody(days: number): First5AnalyticsResponse {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    windowDays: days,
    totals: {
      settled: 0, won: 0, lost: 0, push: 0, void: 0,
      realisedRate: 0, claimedAverage: 0, edge: 0,
    },
    byMarket: [],
    bySelection: [],
    byConfidence: [],
    byLeague: [],
    byBucket: [],
    trend: { last7d: { ...ZERO_SPLIT }, previous: { ...ZERO_SPLIT } },
    trust: { best: [], worst: [] },
  };
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const raw = url.searchParams.get("days");
  const days = boundedInt(raw, DEFAULT_DAYS, 1, MAX_DAYS);

  const cached = responseCache.get(days);
  if (cached && cached.expiresAt > Date.now()) {
    return Response.json(cached.body, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const body = await computeAnalytics(days);
    // Only successful reads are cached: a transient failure must not pin an
    // empty payload in front of the data for five minutes.
    responseCache.set(days, { expiresAt: Date.now() + CACHE_TTL_MS, body });
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.warn(
      `[First5][analytics] analytics read failed (returning a zeroed payload): ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    return Response.json(emptyBody(days), { headers: { "Cache-Control": "no-store" } });
  }
}

/**
 * Clamp a query param to an integer inside [min, max], falling back when
 * unusable. An absent or blank param is the fallback — `Number(null)` is 0,
 * which would silently pin every default to the minimum.
 */
function boundedInt(rawParam: string | null, fallback: number, min: number, max: number): number {
  if (rawParam === null || rawParam.trim() === "") return fallback;
  const value = Number(rawParam);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
