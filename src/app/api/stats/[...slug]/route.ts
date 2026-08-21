// ĞIGI GIVØ — Stats debug endpoint (Part 6).
//
//   GET /api/stats/{leagueSlug}/{eventId}
//
// Returns the aggregator's current cache state for the match, or triggers a
// fresh multi-source fetch. Essential for validating that REAL data is flowing
// into the prediction and settlement pipelines.
//
// Query params:
//   home / away / date   team names + ISO date — required to run a fresh fetch
//   refresh=1            bypass the cache and force a fresh multi-source walk
//   source=API-Football  restrict the walk to a single source (validation)
//   debug=1              include the per-source attempt trace + capability matrix
//
// A cache hit is returned instantly (fromCache: true). A cache miss without
// home/away/date returns the capability matrix + a hint (no network).

import { statsAggregator } from "@/lib/data/aggregator";
import { REGISTERED_SOURCES, SOURCE_CAPABILITIES, STAT_SOURCES } from "@/lib/data/aggregator";
import type { CanonicalMatchStats } from "@/lib/data/types";

export const dynamic = "force-dynamic";

interface StatsRouteParams {
  slug: string[];
}

function json<T>(body: T, status = 200): Response {
  return Response.json(body, { status });
}

async function handle(params: StatsRouteParams, req: Request): Promise<Response> {
  const [leagueSlug, eventId] = params.slug ?? [];
  if (!leagueSlug || !eventId) {
    return json({
      error: "Expected /api/stats/{leagueSlug}/{eventId}",
      capabilities: SOURCE_CAPABILITIES,
      statSources: STAT_SOURCES,
    }, 400);
  }

  const url = new URL(req.url);
  const home = url.searchParams.get("home")?.trim() ?? "";
  const away = url.searchParams.get("away")?.trim() ?? "";
  const date = url.searchParams.get("date")?.trim() ?? "";
  const refresh = url.searchParams.get("refresh") === "1";
  const debug = url.searchParams.get("debug") === "1";
  const source = url.searchParams.get("source")?.trim() ?? "";

  const cacheKey = statsAggregator.cacheKey({ leagueSlug, eventId, homeTeam: home, awayTeam: away, date: date || new Date().toISOString().slice(0, 10) });

  const cached = statsAggregator.peek({ leagueSlug, eventId, homeTeam: home, awayTeam: away, date: date || "" });
  if (cached && !refresh) {
    return json({
      cacheKey,
      fromCache: true,
      stats: cached,
      source: cached.metadata.source,
      fetchedAt: cached.metadata.fetchedAt,
      ...(debug ? { capabilities: SOURCE_CAPABILITIES, cooldowns: statsAggregator.cooldownSnapshot() } : {}),
    });
  }

  // Fresh fetch requires team names + date.
  if (!home || !away || !date) {
    return json({
      cacheKey,
      fromCache: false,
      stats: null,
      hint: "Cache miss. Provide ?home=&away=&date= (ISO date) to trigger a fresh fetch.",
      capabilities: SOURCE_CAPABILITIES,
      cooldowns: statsAggregator.cooldownSnapshot(),
    });
  }

  const priority = source
    ? [source, ...REGISTERED_SOURCES.filter((s) => s !== source)]
    : undefined;

  const { stats, attempts, fieldSources } = await statsAggregator.fetchWithTrace(
    { leagueSlug, eventId, homeTeam: home, awayTeam: away, date },
    { force: refresh, priority },
  );

  return json({
    cacheKey,
    fromCache: false,
    stats: stats as CanonicalMatchStats | null,
    source: stats?.metadata.source ?? null,
    fetchedAt: stats?.metadata.fetchedAt ?? new Date().toISOString(),
    attempts,
    fieldSources,
    capabilities: SOURCE_CAPABILITIES,
    cooldowns: statsAggregator.cooldownSnapshot(),
  });
}

export async function GET(req: Request, ctx: { params: Promise<StatsRouteParams> }) {
  const params = await ctx.params;
  return handle(params, req);
}

export async function POST(req: Request, ctx: { params: Promise<StatsRouteParams> }) {
  const params = await ctx.params;
  return handle(params, req);
}
