// ĞIGI GIVØ — Ranking-mode performance API.
//
// Returns a complete, per-mode performance report (Rank A Classic, Rank B
// 12-Factor, Rank C Hybrid, Rank D Consensus) built from the three tracking
// tables: performance_log (ranked Top-10 picks), value_bet_log (staked value
// bets) and saved_slips (accumulators). Every table carries a ranking_mode so
// the four modes can be compared like-for-like.
//
// Query parameters
//   days    7 | 30 | 90 | all | <n>     window on the bet date (default 30)
//   from    YYYY-MM-DD                  custom range start (overrides days)
//   to      YYYY-MM-DD                  custom range end
//   mode    A | B | C | D | all         restrict the returned reports
//   league  free text                   matches competition name or slug
//   result  WIN|LOSS|PUSH|VOID|PENDING  result filter
//   source  pick | valueBet | slip      product filter
//   search  free text                   match / market / selection search
//   limit   max bet rows per mode (default 1500, max 5000)
//   refresh true                        bypass cache and force fresh calculation
//
// All aggregation lives in `@/lib/performance/modeAnalytics` (pure + unit
// tested); this route only loads rows, normalises them and applies filters.

import { db } from "@/db";
import { performanceLog, savedSlips, valueBetLog } from "@/db/schema";
import { gte, sql } from "drizzle-orm";
import {
  RANKING_MODES,
  applyFilters,
  betFromSlipRow,
  betFromValueBetRow,
  betsFromPerformanceRow,
  buildComparison,
  buildModeReport,
  dayOffset,
  perfectMatch,
  type ModeBet,
  type RankingModeKey,
} from "@/lib/performance/modeAnalytics";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 1500;
const MAX_LIMIT = 5000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

type CacheEntry = {
  data: unknown;
  timestamp: number;
};

// In-memory cache at module level for 1-hour TTL
const cache = new Map<string, CacheEntry>();

function getCacheKey(url: URL): string {
  const days = url.searchParams.get("days") ?? "30";
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const mode = (url.searchParams.get("mode") ?? "all").toUpperCase();
  const league = url.searchParams.get("league") ?? "";
  const result = url.searchParams.get("result") ?? "";
  const source = url.searchParams.get("source") ?? "";
  const search = url.searchParams.get("search") ?? "";
  const limit = url.searchParams.get("limit") ?? "";
  // Key includes date range and all relevant filters
  return `modes:${days}:${from}:${to}:${mode}:${league}:${result}:${source}:${search}:${limit}`;
}

function parseWindow(url: URL): { from: string; to: string | null; days: string } {
  const now = new Date();
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const daysRaw = (url.searchParams.get("days") ?? "30").toLowerCase();

  if (from) return { from, to: to ?? null, days: "custom" };
  if (daysRaw === "all") return { from: dayOffset(now, 3650), to: to ?? null, days: "all" };
  const days = Math.min(Math.max(Number(daysRaw) || 30, 1), 3650);
  return { from: dayOffset(now, days), to: to ?? null, days: String(days) };
}

/**
 * saved_slips gained `ranking_mode` after the Drizzle model was written; read it
 * with a guarded raw query so deployments without the column still work (the
 * mode then falls back to the value persisted inside the picks JSON).
 */
async function loadSlipModes(since: Date): Promise<Map<number, string>> {
  try {
    const res = await db.execute<{ id: number; ranking_mode: string | null }>(
      sql`select id, ranking_mode from saved_slips where created_at >= ${since}`,
    );
    const rows = (res as unknown as { rows?: Array<{ id: number; ranking_mode: string | null }> }).rows ?? [];
    return new Map(rows.filter((r) => r.ranking_mode).map((r) => [Number(r.id), String(r.ranking_mode)]));
  } catch {
    return new Map();
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const isRefresh = url.searchParams.get("refresh") === "true";
    const cacheKey = getCacheKey(url);

    // If refresh is requested, delete the cached entry for this request to force fresh calculation
    if (isRefresh) {
      cache.delete(cacheKey);
      // Also clear any other entries if user wants a full fresh refresh - to ensure no stale data
      // But per spec we only need to ignore this key; we still bypass cache check below
    }

    // Check cache if not a refresh request
    if (!isRefresh) {
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return Response.json(cached.data, {
          headers: { "Cache-Control": "no-store", "X-Cache": "HIT" },
        });
      }
      // Auto-clear expired entry
      if (cached) {
        cache.delete(cacheKey);
      }
    }

    const window = parseWindow(url);
    const since = new Date(`${window.from}T00:00:00.000Z`);
    const modeParam = (url.searchParams.get("mode") ?? "all").toUpperCase();
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit")) || DEFAULT_LIMIT, 50),
      MAX_LIMIT,
    );
    const filters = {
      from: window.from,
      to: window.to,
      league: url.searchParams.get("league"),
      result: url.searchParams.get("result"),
      source: url.searchParams.get("source"),
      search: url.searchParams.get("search"),
    };

    const [perfRows, valueRows, slipRows, slipModes] = await Promise.all([
      db.select().from(performanceLog).where(gte(performanceLog.matchDate, window.from)).limit(30000),
      db.select().from(valueBetLog).where(gte(valueBetLog.matchDate, window.from)).limit(30000),
      db.select().from(savedSlips).where(gte(savedSlips.createdAt, since)).limit(5000),
      loadSlipModes(since),
    ]);

    // ── Normalise every product into a single bet stream ────────────────────
    const bets: ModeBet[] = [];
    const perfect = new Map<RankingModeKey, number>();
    const matches = new Map<RankingModeKey, Set<string>>();

    for (const row of perfRows) {
      const rowBets = betsFromPerformanceRow(row);
      if (rowBets.length === 0) continue;
      const mode = rowBets[0].mode;
      bets.push(...rowBets);
      if (perfectMatch(row)) perfect.set(mode, (perfect.get(mode) ?? 0) + 1);
      const set = matches.get(mode) ?? new Set<string>();
      set.add(`${row.eventId}`);
      matches.set(mode, set);
    }
    for (const row of valueRows) bets.push(betFromValueBetRow(row));
    for (const row of slipRows) {
      const bet = betFromSlipRow({ ...row, rankingMode: slipModes.get(row.id) ?? null });
      if (bet) bets.push(bet);
    }

    const filtered = applyFilters(bets, filters);
    const now = new Date();
    const reports = RANKING_MODES.map((mode) =>
      buildModeReport(
        mode,
        filtered.filter((b) => b.mode === mode),
        {
          tenOfTenHits: perfect.get(mode) ?? 0,
          matchesTracked: matches.get(mode)?.size ?? 0,
          now,
        },
      ),
    );

    const comparison = buildComparison(reports);
    const selected = RANKING_MODES.includes(modeParam as RankingModeKey)
      ? reports.filter((r) => r.mode === modeParam)
      : reports;

    // Trim the raw bet log (charts/aggregates already used the full stream).
    const modes = selected.map((report) => ({
      ...report,
      betsTotal: report.bets.length,
      betsTruncated: report.bets.length > limit,
      bets: report.bets.slice(0, limit),
    }));

    const responseData = {
      ok: true,
      generatedAt: now.toISOString(),
      window: { days: window.days, from: window.from, to: window.to },
      filters: {
        mode: modeParam,
        league: filters.league ?? "",
        result: filters.result ?? "",
        source: filters.source ?? "",
        search: filters.search ?? "",
      },
      totals: {
        performanceRows: perfRows.length,
        valueBetRows: valueRows.length,
        slipRows: slipRows.length,
        bets: filtered.length,
      },
      comparison,
      modes,
    };

    // Store in cache with fresh timestamp
    cache.set(cacheKey, { data: responseData, timestamp: Date.now() });

    return Response.json(responseData, {
      headers: { "Cache-Control": "no-store", "X-Cache": isRefresh ? "REFRESH" : "MISS" },
    });
  } catch (error) {
    console.error("Ranking mode performance API error", error);
    return Response.json(
      { ok: false, error: "Unable to load ranking mode performance." },
      { status: 500 },
    );
  }
}
