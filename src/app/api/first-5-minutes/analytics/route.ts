// ĞIGI GIVØ — First 5 Minutes analytics.
//
// Aggregate quality report behind the "📊 Analytics" chip on the First 5
// Minutes board: realised vs claimed hit rate per market, selection side,
// confidence band, league and claimed-probability bucket, a last-7-days vs
// prior-week trend, and the best/worst markets by edge.
//
// GET /api/first-5-minutes/analytics?days=30
//   days  look-back window (match_date) applied to every aggregate
//         (default 30, clamped to [1, 365]). The trend split is fixed at
//         7/14 days regardless of the window.
//
// QUERY SHAPE — one GROUP BY query per aggregate dimension, plus one
// single-row totals aggregate. Raw performance_log rows are never pulled
// into Node to be grouped there (the table grows without bound); only the
// tiny, already-aggregated result sets reach this file, where per-group
// ratios (won / (won + lost), claimed average, edge) and action labels are
// derived and rounded.
//
// Fail-soft by contract: any database error is logged once and answered
// with an all-zero, empty payload — never a 5xx — so the sheet always
// opens. Successful payloads are cached in memory for 5 minutes keyed by
// the window: settled data changes at most hourly.

import { performanceLog } from "@/db/schema";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** performance_log discriminator for First 5 Minutes picks. */
const FEATURE = "first5";
/** Outcomes the settlement cron stamps on settled feature rows. */
const SETTLED_OUTCOMES = ["WIN", "LOSS", "PUSH", "VOID"] as const;

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/** The trend compares the last week against the week before it. */
const TREND_SPLIT_DAYS = 7;

/** Sample size below which a group earns no action label. */
export const TRUST_MIN_SAMPLE = 20;
/** |edge| below this (5 points) counts as calibrated → "trusted". */
const TRUSTED_EDGE = 0.05;
/** At or beyond −15 points of edge a market is flagged "avoid". */
const AVOID_EDGE = 0.15;
const TRUST_LIST_SIZE = 5;

const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type AnalyticsAction = "trusted" | "watch" | "avoid" | "insufficient";

/** Shared per-group statistics: counts straight from SQL plus derived ratios. */
export interface AnalyticsGroupStats {
  /** Settled rows in the group. */
  n: number;
  won: number;
  lost: number;
  /** won / (won + lost), 0 without decided rows. */
  realised: number;
  /** Mean claimed hit rate over the group's settled rows. */
  claimed: number;
  /** realised − claimed. */
  edge: number;
}

export interface AnalyticsTotals {
  settled: number;
  won: number;
  lost: number;
  push: number;
  void: number;
  /** won / (won + lost). */
  realisedRate: number;
  /** Mean claimed hit rate over all settled rows. */
  claimedAverage: number;
  /** realisedRate − claimedAverage. */
  edge: number;
}

export interface AnalyticsMarketRow extends AnalyticsGroupStats {
  market: string;
  action: AnalyticsAction;
}

export interface AnalyticsSelectionRow extends AnalyticsGroupStats {
  selection: string;
}

export interface AnalyticsConfidenceRow extends AnalyticsGroupStats {
  band: string;
}

export interface AnalyticsLeagueRow extends AnalyticsGroupStats {
  leagueSlug: string;
  leagueName: string;
}

export interface AnalyticsBucketRow {
  bucket: string;
  n: number;
  realised: number;
  claimed: number;
  /** realised − claimed. */
  diff: number;
}

export type AnalyticsTrendPoint = AnalyticsGroupStats;

export interface AnalyticsTrustRow {
  marketKey: string;
  n: number;
  edge: number;
  action: AnalyticsAction;
}

export interface First5AnalyticsResponse {
  ok: true;
  generatedAt: string;
  windowDays: number;
  totals: AnalyticsTotals;
  byMarket: AnalyticsMarketRow[];
  bySelection: AnalyticsSelectionRow[];
  byConfidence: AnalyticsConfidenceRow[];
  byLeague: AnalyticsLeagueRow[];
  byBucket: AnalyticsBucketRow[];
  trend: { last7d: AnalyticsTrendPoint; previous: AnalyticsTrendPoint };
  trust: { best: AnalyticsTrustRow[]; worst: AnalyticsTrustRow[] };
}

// ─── Pure helpers (also the reference implementation for the SQL below) ───────

/**
 * Claimed-probability bucket of a settled row, or null outside [0.50, 1.00].
 * The bucket GROUP BY below is generated from the same table, so the two can
 * never drift apart.
 */
export const HIT_RATE_BUCKETS = [
  { label: "0.50-0.60", min: 0.5, max: 0.6 },
  { label: "0.60-0.70", min: 0.6, max: 0.7 },
  { label: "0.70-0.80", min: 0.7, max: 0.8 },
  { label: "0.80-0.90", min: 0.8, max: 0.9 },
  { label: "0.90-1.00", min: 0.9, max: 1.0 },
] as const;

export function bucketFor(hitRate: number): string | null {
  const rate = typeof hitRate === "number" ? hitRate : Number(hitRate);
  if (!Number.isFinite(rate)) return null;
  const first = HIT_RATE_BUCKETS[0];
  const last = HIT_RATE_BUCKETS[HIT_RATE_BUCKETS.length - 1];
  if (rate < first.min || rate > last.max) return null;
  for (const bucket of HIT_RATE_BUCKETS) {
    if (rate >= bucket.min && rate < bucket.max) return bucket.label;
  }
  // rate === 1.0 lands in the final, double-inclusive bucket.
  return last.label;
}

/**
 * Action label for an aggregated row, from its sample size and edge:
 *   n < 20              → "insufficient"
 *   |edge| < 0.05       → "trusted"
 *   edge > −0.15        → "watch"
 *   otherwise           → "avoid"
 */
export function actionFor(n: number, edge: number): AnalyticsAction {
  if (!Number.isFinite(n) || n < TRUST_MIN_SAMPLE) return "insufficient";
  const value = Number.isFinite(edge) ? edge : 0;
  if (Math.abs(value) < TRUSTED_EDGE) return "trusted";
  if (value > -AVOID_EDGE) return "watch";
  return "avoid";
}

/** ISO day string (YYYY-MM-DD) `days` before `reference`, in UTC. */
function isoDayOffset(reference: Date, days: number): string {
  const date = new Date(reference.getTime());
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export type TrendWindow = "last7d" | "previous";

/**
 * Which trend window a settled row's match date falls into, relative to
 * `reference` (defaults to now): the last 7 days, the 7 before that, or
 * null when the row predates both. The trend GROUP BY below encodes the
 * identical split in SQL.
 */
export function trendWindowFor(matchDate: string, reference: Date = new Date()): TrendWindow | null {
  const day = typeof matchDate === "string" ? matchDate.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  if (day >= isoDayOffset(reference, TREND_SPLIT_DAYS)) return "last7d";
  if (day >= isoDayOffset(reference, TREND_SPLIT_DAYS * 2)) return "previous";
  return null;
}

/**
 * Clamp a query param to an integer inside [min, max], falling back when
 * unusable. An absent or blank param is the fallback — `Number(null)` is 0,
 * which would silently pin every default to the minimum.
 */
function boundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

// ─── Row normalisation ────────────────────────────────────────────────────────
// The pg driver hands some columns back as strings (counts before the ::int
// cast, numerics) and nullable text as null, so every value is coerced once,
// here, instead of at the point of use.

function asNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asInt(value: unknown): number {
  return Math.trunc(asNumber(value));
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Round a rate to 3 decimals — the precision every aggregate is published at. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** won / (won + lost); pushes and voids decide nothing, so they don't count. */
function realisedRate(won: number, lost: number): number {
  return won + lost > 0 ? round3(won / (won + lost)) : 0;
}

/** Derive the published group statistics from one aggregated SQL row. */
function groupStats(row: { n: unknown; won: unknown; lost: unknown; claimed: unknown }): AnalyticsGroupStats {
  const n = asInt(row.n);
  const won = asInt(row.won);
  const lost = asInt(row.lost);
  const realised = realisedRate(won, lost);
  const claimed = round3(asNumber(row.claimed));
  return { n, won, lost, realised, claimed, edge: round3(realised - claimed) };
}

function zeroTrendPoint(): AnalyticsTrendPoint {
  return { n: 0, won: 0, lost: 0, realised: 0, claimed: 0, edge: 0 };
}

function zeroTotals(): AnalyticsTotals {
  return { settled: 0, won: 0, lost: 0, push: 0, void: 0, realisedRate: 0, claimedAverage: 0, edge: 0 };
}

function emptyResponse(windowDays: number): First5AnalyticsResponse {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    windowDays,
    totals: zeroTotals(),
    byMarket: [],
    bySelection: [],
    byConfidence: [],
    byLeague: [],
    byBucket: [],
    trend: { last7d: zeroTrendPoint(), previous: zeroTrendPoint() },
    trust: { best: [], worst: [] },
  };
}

// ─── Response cache ───────────────────────────────────────────────────────────
// Settled data changes at most hourly (the settle cron runs hourly), so a
// 5-minute in-memory cache per window is plenty and keeps repeat sheet opens
// free. Fail-soft payloads are NOT cached — a recovered database must serve
// on the next request.

const responseCache = new Map<number, { at: number; body: First5AnalyticsResponse }>();

/** Drop every cached analytics payload (used by tests and after re-settlement). */
export function clearAnalyticsCache(): void {
  responseCache.clear();
}

// ─── SQL fragments ────────────────────────────────────────────────────────────
// One GROUP BY per dimension. Counts are cast to int in SQL (the pg driver
// returns bigint as a string otherwise); avg(hit_rate) comes back as a float.

const nExpr = sql<number>`count(*)::int`;
const wonExpr = sql<number>`(count(*) filter (where ${performanceLog.outcome} = 'WIN'))::int`;
const lostExpr = sql<number>`(count(*) filter (where ${performanceLog.outcome} = 'LOSS'))::int`;
const pushExpr = sql<number>`(count(*) filter (where ${performanceLog.outcome} = 'PUSH'))::int`;
const voidExpr = sql<number>`(count(*) filter (where ${performanceLog.outcome} = 'VOID'))::int`;
/** Mean claimed probability — the model's average claim over the group. */
const claimedExpr = sql<number>`avg(${performanceLog.hitRate})`;

/** match_date is a TEXT column holding an ISO day, so windows compare the
 *  day prefix against an app-computed ISO day string (UTC). ISO day strings
 *  order chronologically, and the text comparison can never throw on a
 *  malformed value the way `match_date::date` would. */
function dayWindowExpr(days: number): SQL {
  return sql`left(${performanceLog.matchDate}, 10) >= ${isoDayOffset(new Date(), days)}`;
}

/**
 * Bucket GROUP BY expression, generated from HIT_RATE_BUCKETS so the SQL and
 * the reference `bucketFor()` helper share one source of truth. Rows outside
 * [0.50, 1.00] are excluded by the WHERE clause of the bucket query.
 */
function bucketExpr(): SQL<string> {
  return sql`CASE ${sql.join(
    HIT_RATE_BUCKETS.map((bucket, index) =>
      index === HIT_RATE_BUCKETS.length - 1
        ? sql`WHEN ${performanceLog.hitRate} >= ${bucket.min} THEN ${bucket.label}`
        : sql`WHEN ${performanceLog.hitRate} >= ${bucket.min} AND ${performanceLog.hitRate} < ${bucket.max} THEN ${bucket.label}`,
    ),
    sql` `,
  )} END`;
}

/**
 * Trend GROUP BY expression — the SQL twin of `trendWindowFor()`. The two
 * windows partition the last 14 days: [now−7d, now] and [now−14d, now−7d).
 */
function trendExpr(last7dStart: string, previousStart: string): SQL<string> {
  return sql`CASE
    WHEN left(${performanceLog.matchDate}, 10) >= ${last7dStart} THEN 'last7d'
    WHEN left(${performanceLog.matchDate}, 10) >= ${previousStart} THEN 'previous'
  END`;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const days = boundedInt(url.searchParams.get("days"), DEFAULT_DAYS, 1, MAX_DAYS);

  const cached = responseCache.get(days);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return Response.json(cached.body, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    // Imported inside the try so a deployment without a reachable database
    // (or without DATABASE_URL at all) still answers with the empty payload
    // instead of failing the module load.
    const { db } = await import("@/db");

    const settled = and(
      eq(performanceLog.feature, FEATURE),
      inArray(performanceLog.outcome, [...SETTLED_OUTCOMES]),
      dayWindowExpr(days),
    );

    // ── Totals: one single-row aggregate over the same source. ──
    const [totalsRow] = await db
      .select({
        settled: nExpr,
        won: wonExpr,
        lost: lostExpr,
        push: pushExpr,
        void: voidExpr,
        claimed: claimedExpr,
      })
      .from(performanceLog)
      .where(settled);

    const settledCount = asInt(totalsRow?.settled);
    const won = asInt(totalsRow?.won);
    const lost = asInt(totalsRow?.lost);
    const push = asInt(totalsRow?.push);
    const voided = asInt(totalsRow?.void);
    const realisedRateValue = realisedRate(won, lost);
    const claimedAverage = round3(asNumber(totalsRow?.claimed));
    const totals: AnalyticsTotals = {
      settled: settledCount,
      won,
      lost,
      push,
      void: voided,
      realisedRate: realisedRateValue,
      claimedAverage,
      edge: round3(realisedRateValue - claimedAverage),
    };

    // ── Per-market, per-selection, per-band, per-league: one GROUP BY each. ──
    const marketRows = (await db
      .select({
        market: performanceLog.market,
        n: nExpr,
        won: wonExpr,
        lost: lostExpr,
        claimed: claimedExpr,
      })
      .from(performanceLog)
      .where(settled)
      .groupBy(performanceLog.market)) as Array<{ market: string | null; n: number; won: number; lost: number; claimed: number }>;

    const byMarket: AnalyticsMarketRow[] = marketRows.map((row) => ({
      market: asText(row.market) || "Unknown market",
      ...groupStats(row),
      action: actionFor(asInt(row.n), round3(realisedRate(asInt(row.won), asInt(row.lost)) - round3(asNumber(row.claimed)))),
    }));

    const selectionRows = (await db
      .select({
        selection: performanceLog.selection,
        n: nExpr,
        won: wonExpr,
        lost: lostExpr,
        claimed: claimedExpr,
      })
      .from(performanceLog)
      .where(settled)
      .groupBy(performanceLog.selection)) as Array<{ selection: string | null; n: number; won: number; lost: number; claimed: number }>;

    const bySelection: AnalyticsSelectionRow[] = selectionRows.map((row) => ({
      selection: asText(row.selection) || "—",
      ...groupStats(row),
    }));

    const confidenceRows = (await db
      .select({
        band: performanceLog.confidence,
        n: nExpr,
        won: wonExpr,
        lost: lostExpr,
        claimed: claimedExpr,
      })
      .from(performanceLog)
      .where(settled)
      .groupBy(performanceLog.confidence)) as Array<{ band: string | null; n: number; won: number; lost: number; claimed: number }>;

    const byConfidence: AnalyticsConfidenceRow[] = confidenceRows.map((row) => ({
      band: (asText(row.band) || "LOW").toUpperCase(),
      ...groupStats(row),
    }));

    const leagueRows = (await db
      .select({
        leagueSlug: performanceLog.leagueSlug,
        leagueName: sql<string | null>`max(${performanceLog.league})`,
        n: nExpr,
        won: wonExpr,
        lost: lostExpr,
        claimed: claimedExpr,
      })
      .from(performanceLog)
      .where(settled)
      .groupBy(performanceLog.leagueSlug)) as Array<{ leagueSlug: string | null; leagueName: string | null; n: number; won: number; lost: number; claimed: number }>;

    const byLeague: AnalyticsLeagueRow[] = leagueRows.map((row) => {
      const leagueSlug = asText(row.leagueSlug) || "unknown";
      return {
        leagueSlug,
        leagueName: asText(row.leagueName) || leagueSlug,
        ...groupStats(row),
      };
    });

    // ── Calibration buckets: GROUP BY the generated CASE, claims only. ──
    const bucketCase = bucketExpr();
    const bucketRows = (await db
      .select({
        bucket: bucketCase,
        n: nExpr,
        won: wonExpr,
        lost: lostExpr,
        claimed: claimedExpr,
      })
      .from(performanceLog)
      .where(and(
        settled,
        // Rows outside [0.50, 1.00] never land in a bucket.
        sql`${performanceLog.hitRate} >= ${HIT_RATE_BUCKETS[0].min} AND ${performanceLog.hitRate} <= ${HIT_RATE_BUCKETS[HIT_RATE_BUCKETS.length - 1].max}`,
      ))
      .groupBy(bucketCase)) as Array<{ bucket: string | null; n: number; won: number; lost: number; claimed: number }>;

    const byBucket: AnalyticsBucketRow[] = bucketRows
      .filter((row) => row.bucket !== null)
      .map((row) => {
        const stats = groupStats(row);
        return {
          bucket: String(row.bucket),
          n: stats.n,
          realised: stats.realised,
          claimed: stats.claimed,
          diff: round3(stats.realised - stats.claimed),
        };
      })
      .sort((left, right) => left.bucket.localeCompare(right.bucket));

    // ── Trend: one GROUP BY splitting the last 14 days into two windows. ──
    const now = new Date();
    const last7dStart = isoDayOffset(now, TREND_SPLIT_DAYS);
    const previousStart = isoDayOffset(now, TREND_SPLIT_DAYS * 2);
    const trendCase = trendExpr(last7dStart, previousStart);
    const trendRows = (await db
      .select({
        window: trendCase,
        n: nExpr,
        won: wonExpr,
        lost: lostExpr,
        claimed: claimedExpr,
      })
      .from(performanceLog)
      .where(and(
        eq(performanceLog.feature, FEATURE),
        inArray(performanceLog.outcome, [...SETTLED_OUTCOMES]),
        // The trend is fixed at 7/14 days regardless of the ?days window.
        sql`left(${performanceLog.matchDate}, 10) >= ${previousStart}`,
      ))
      .groupBy(trendCase)) as Array<{ window: string | null; n: number; won: number; lost: number; claimed: number }>;

    const trend: First5AnalyticsResponse["trend"] = { last7d: zeroTrendPoint(), previous: zeroTrendPoint() };
    for (const row of trendRows) {
      if (row.window === "last7d") trend.last7d = groupStats(row);
      else if (row.window === "previous") trend.previous = groupStats(row);
    }

    // ── Trust lists: the byMarket aggregates (a handful of tiny rows, already
    // grouped by SQL) re-ranked per side. ──
    const eligible = byMarket.filter((row) => row.n >= TRUST_MIN_SAMPLE);
    const toTrustRow = (row: AnalyticsMarketRow): AnalyticsTrustRow => ({
      marketKey: row.market,
      n: row.n,
      edge: row.edge,
      action: row.action,
    });
    const trust: First5AnalyticsResponse["trust"] = {
      best: [...eligible].sort((left, right) => right.edge - left.edge).slice(0, TRUST_LIST_SIZE).map(toTrustRow),
      worst: [...eligible].sort((left, right) => left.edge - right.edge).slice(0, TRUST_LIST_SIZE).map(toTrustRow),
    };

    const body: First5AnalyticsResponse = {
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

    responseCache.set(days, { at: Date.now(), body });
    console.info(
      `[First5][analytics] ${totals.settled} settled row(s) over ${days} day(s), ` +
      `${byMarket.length} market(s), ${byLeague.length} league(s).`,
    );

    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.warn(
      `[First5][analytics] aggregate read failed (returning an empty payload): ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    return Response.json(emptyResponse(days), { headers: { "Cache-Control": "no-store" } });
  }
}
