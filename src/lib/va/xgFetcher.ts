// Value Accumulator — xG fetcher (real team xG, Bzzoiro Sports Data).
//
// Provider: Bzzoiro Sports Data (BSD) — football API v2.
//   Base:    https://sports.bzzoiro.com/api/v2/          (override: BZOOIRO_BASE)
//   Auth:    Authorization: Token ${BZOOIRO_KEY}
//
// Verified against the live API (2026-09-17). The working endpoints:
//   GET /events/{id}/         → the event; carries home_team_id / away_team_id.
//   GET /events/{id}/stats/   → per-match stats incl. stats.home.xg.actual /
//                               .estimated and stats.away.xg.actual/.estimated.
//                               EVERY value is null until the match is finished,
//                               so this endpoint serves the BACKTEST path only —
//                               never the live scanner (upcoming matches).
//   GET /events/?team_id={id}&status=finished&limit=N
//                             → the team's last N finished matches (paged
//                               {count,next,previous,results}); each row has
//                               id, home_team_id, away_team_id, event_date,
//                               status.
//   GET /teams/{id}/          → { id, name, short_name, country, venue_id }.
//
// There is NO /shotmap/ endpoint — the previous revision targeted one and has
// been removed. Because an upcoming match can never have xG stats yet, the LIVE
// scanner grounds its lambdas with rolling team averages: xG for/against
// averaged over the team's last N finished matches (fetchTeamXgAverage), while
// the BACKTEST path reads the real per-match xG (fetchMatchXg) and falls back
// to the same rolling averages when the stats are not populated.
//
// Mirrors oddsFetcher.ts exactly: same Authorization header format, same 8s
// timeout, same fail-soft return-null pattern, same BZOOIRO_KEY / BZOOIRO_BASE
// env reads, same in-memory cache pattern with CACHE_TTL_MS. No price and no
// xG value is ever fabricated.
//
// ─── Caching (three-layer read, event-driven invalidation) ───────────────────
// A 30-day backtest used to refetch the same team averages and the same
// finished-match xG on every scan (~4,600 HTTP requests, most of them for data
// we already had). Every read now walks three layers and stops at the first
// hit:
//   1. in-memory Map          — dedup within one scan (CACHE_TTL_MS window)
//   2. DB cache table         — team_xg_cache / match_xg_cache (drizzle 0007)
//   3. HTTP GET to Bzzoiro    — the only layer that costs a request
//
// Validity is event-driven, not TTL-driven:
//   team_xg_cache  — VALID only while next_match_at IS NOT NULL AND
//                    now() < next_match_at. A team's rolling average cannot
//                    change until the team plays, so a valid row means ZERO HTTP
//                    calls. A NULL next_match_at (no upcoming fixture known) is
//                    treated as stale and refetched.
//   match_xg_cache — VALID forever when is_finished = true (full-time xG never
//                    changes), otherwise valid for MATCH_XG_CACHE_TTL_MS (24h).
//
// Writes are queued, not streamed: every fetch queues its row and
// flushXgCache() — called once at the end of a scan by performScan — persists
// them in one batched UPSERT per table. Nulls are never queued, because
// Bzzoiro intermittently returns empty stats for fixtures that populate later;
// an absent row must mean "retry next scan", not "there is nothing".
//
// The cache is an optimisation: every DB read and write is wrapped so a cache
// failure logs and falls through (read) or logs and returns the fetched value
// anyway (write). It can never break a scan.

import { db } from "@/db";
import { matchXgCache, teamXgCache, type NewMatchXgCache, type NewTeamXgCache } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

export interface XgResult {
  homeXg: number | null; // for a finished match
  awayXg: number | null;
  source: "bzzoiro-match" | "bzzoiro-team-avg" | null;
}

export interface TeamXgAverage {
  teamId: number;
  /** Avg xG scored by this team over the last N finished matches. */
  xgFor: number | null;
  /** Avg xG conceded by this team over the last N finished matches. */
  xgAgainst: number | null;
  /** Number of matches averaged. */
  samples: number;
}

/** The two team ids of a Bzzoiro event (GET /events/{id}/). */
export interface BzEventDetail {
  homeTeamId: number | null;
  awayTeamId: number | null;
}

interface BzStatsSide {
  xg?: unknown;
}

interface BzStatsResponse {
  stats?: {
    home?: BzStatsSide;
    away?: BzStatsSide;
  };
}

interface BzTeamEventRow {
  id?: unknown;
  home_team_id?: unknown;
  away_team_id?: unknown;
  /** Kickoff, e.g. "2026-09-10" or "2026-09-10T19:00:00Z". */
  event_date?: unknown;
  /** Bzzoiro lifecycle: "notstarted" | "finished" | … */
  status?: unknown;
}

interface BzEventDetailResponse {
  id?: unknown;
  home_team_id?: unknown;
  away_team_id?: unknown;
}

interface BzPage<T> {
  count?: number;
  next?: string | null;
  previous?: string | null;
  results?: T[];
}

const BZOOIRO_BASE = (() => {
  const raw = (process.env.BZOOIRO_BASE ?? "https://sports.bzzoiro.com/api/v2").trim();
  return raw.replace(/\/+$/, "");
})();
const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 30 * 60 * 1000; // xG for a played match is immutable; team form is safe to reuse within a scan window
/**
 * match_xg_cache rows whose values came from pre-full-time ESTIMATES (i.e.
 * is_finished = false) expire after 24h. Finished rows never expire.
 */
const MATCH_XG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Rows per batched UPSERT statement at flush time (one statement per table per chunk). */
const UPSERT_CHUNK = 500;

let warnedNoKey = false;

function getApiKey(): string {
  return (process.env.BZOOIRO_KEY ?? "").trim();
}

/** Shared GET with 8s timeout. Returns parsed JSON or null on any failure (fail soft). */
async function bzGet<T>(path: string): Promise<T | null> {
  const key = getApiKey();
  if (!key) {
    if (!warnedNoKey) {
      console.log("[VA][Bzzoiro] BZOOIRO_KEY not set — skipping Bzzoiro calls");
      warnedNoKey = true;
    }
    return null;
  }
  const url = `${BZOOIRO_BASE}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Token ${key}` },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      console.log(`[VA][Bzzoiro] GET ${path} → HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── In-memory cache (same pattern as oddsFetcher) ────────────────────────────

interface CacheEntry<T> {
  value: T;
  at: number;
}

/** Successful per-match xG responses, cached in memory (scan duration / TTL). */
const xgByEvent = new Map<string, CacheEntry<XgResult>>();
/** Successful rolling team averages, cached per (teamId, lastN). */
const teamAvgByTeam = new Map<string, CacheEntry<TeamXgAverage>>();
/** Successful event-detail (team ids) responses, cached per event id. */
const eventDetailByEvent = new Map<string, CacheEntry<BzEventDetail>>();

function cached<T>(store: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

function store<T>(storeMap: Map<string, CacheEntry<T>>, key: string, value: T): void {
  storeMap.set(key, { value, at: Date.now() });
}

/** Test helper — drop cached xG / team-average / event-detail responses. */
export function __clearXgCacheForTests(): void {
  xgByEvent.clear();
  teamAvgByTeam.clear();
  eventDetailByEvent.clear();
}

// ─── Batched DB write queue (layer 2 persistence) ─────────────────────────────
//
// Fetches never write to Postgres themselves: they queue the row here and
// flushXgCache() persists everything in one batched UPSERT per table at the end
// of the scan. Both queues are keyed by primary key, so a team or match touched
// 50 times in one scan is written once.

interface PendingTeamWrite {
  teamId: number;
  xgFor: number;
  xgAgainst: number;
  samples: number;
  /** Kickoff of the most recent finished match included in the average. */
  basedOnThroughAt: Date;
}

interface PendingMatchWrite {
  eventId: string;
  homeXg: number;
  awayXg: number;
  isFinished: boolean;
}

const pendingTeamWrites = new Map<number, PendingTeamWrite>();
const pendingMatchWrites = new Map<string, PendingMatchWrite>();

/**
 * Empties the pending-write queues. Called by performScan at the start of every
 * scan so the flush at the end persists exactly that scan's rows (and a scan
 * that died halfway never leaks half-written rows into the next one).
 */
export function resetXgCacheQueue(): void {
  pendingTeamWrites.clear();
  pendingMatchWrites.clear();
}

/** Test helper — how many rows are waiting to be flushed. */
export function __xgCacheQueueSizeForTests(): { teams: number; matches: number } {
  return { teams: pendingTeamWrites.size, matches: pendingMatchWrites.size };
}

// ─── Defensive parsing ────────────────────────────────────────────────────────

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * xG for one side: stats.{home,away}.xg.actual, falling back to
 * stats.{home,away}.xg.estimated when the actual value is null. Booleans in
 * the `estimated` slot (the docs' "is-estimated" marker) parse as null.
 *
 * `estimated` is reported alongside the value because it decides how the row is
 * cached: an actual (full-time) value is final, an estimated one can still move.
 */
function sideXgDetail(side: BzStatsSide | undefined): { value: number | null; estimated: boolean } {
  const xg = asRecord(side?.xg);
  if (!xg) return { value: null, estimated: false };
  const actual = asNum(xg.actual);
  if (actual !== null) return { value: actual, estimated: false };
  const estimated = asNum(xg.estimated);
  return { value: estimated, estimated: estimated !== null };
}

/** Bzzoiro event_date → Date (accepts "2026-09-10" and full ISO timestamps). */
function asDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// ─── Layer 2: DB cache reads (fail-soft) ──────────────────────────────────────

/**
 * team_xg_cache read. RULE 2: a row is VALID only if next_match_at IS NOT NULL
 * AND now() < next_match_at — the average cannot have moved until the team
 * plays. Anything else returns null so the caller refetches.
 *
 * The table is keyed by team id alone (no window column), so the DB layer
 * serves the scanner's fixed 5-match window; `samples` records what was
 * actually averaged. Any DB error logs and returns null → the caller falls
 * through to HTTP (RULE 5).
 */
async function readTeamXgCache(teamId: number): Promise<TeamXgAverage | null> {
  try {
    const rows = await db
      .select()
      .from(teamXgCache)
      .where(eq(teamXgCache.teamId, teamId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    const nextMatchAt = asDate(row.nextMatchAt);
    if (nextMatchAt === null || nextMatchAt.getTime() <= Date.now()) return null; // stale

    const xgFor = Number(row.xgFor);
    const xgAgainst = Number(row.xgAgainst);
    const samples = Number(row.samples);
    if (!Number.isFinite(xgFor) || !Number.isFinite(xgAgainst) || !Number.isFinite(samples)) return null;
    return { teamId, xgFor, xgAgainst, samples };
  } catch (err) {
    console.log(`[VA][xg-cache] team_xg_cache read failed for team ${teamId} — falling through to Bzzoiro`, err);
    return null;
  }
}

/**
 * match_xg_cache read. RULE 3: finished-match xG is permanent, anything else
 * (pre-full-time estimates) is valid for 24h. Fail-soft per RULE 5.
 */
async function readMatchXgCache(eventId: string): Promise<XgResult | null> {
  try {
    const rows = await db
      .select()
      .from(matchXgCache)
      .where(eq(matchXgCache.eventId, eventId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    if (!row.isFinished) {
      const updatedAt = asDate(row.updatedAt);
      if (updatedAt === null || Date.now() - updatedAt.getTime() > MATCH_XG_CACHE_TTL_MS) return null; // expired
    }

    const homeXg = Number(row.homeXg);
    const awayXg = Number(row.awayXg);
    if (!Number.isFinite(homeXg) || !Number.isFinite(awayXg)) return null;
    return { homeXg, awayXg, source: "bzzoiro-match" };
  } catch (err) {
    console.log(`[VA][xg-cache] match_xg_cache read failed for event ${eventId} — falling through to Bzzoiro`, err);
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Real per-match xG for a FINISHED match (GET /events/{id}/stats/).
 *
 * All stats values are null until full-time, so this returns null for any
 * match that has not finished (or is thinly covered). Fails soft: null when
 * the key is unset, the event id is unusable, the request fails, or both xG
 * sides are null. A one-sided result returns that side as null and the other
 * as-is.
 *
 * Reads walk the three layers (memory → match_xg_cache → HTTP); a cache hit
 * costs zero requests. Successful responses are cached in memory for
 * CACHE_TTL_MS and queued for the batched DB write at the end of the scan —
 * except when either side is null (RULE 4: never cache a partial/empty
 * response, both cache columns are NOT NULL, and Bzzoiro often populates
 * stats later).
 */
export async function fetchMatchXg(eventId: string): Promise<XgResult | null> {
  const idTrim = eventId.trim();
  if (!idTrim || !/^\d+$/.test(idTrim)) return null;
  if (!getApiKey()) {
    if (!warnedNoKey) {
      console.log("[VA][Bzzoiro] BZOOIRO_KEY not set — skipping Bzzoiro calls");
      warnedNoKey = true;
    }
    return null;
  }

  // Layer 1 — in-memory dedup for this scan.
  const hit = cached(xgByEvent, idTrim);
  if (hit) return hit;

  // Layer 2 — match_xg_cache (permanent for finished matches, 24h otherwise).
  const fromDb = await readMatchXgCache(idTrim);
  if (fromDb) {
    store(xgByEvent, idTrim, fromDb);
    return fromDb;
  }

  // Layer 3 — HTTP.
  const path = `/events/${encodeURIComponent(idTrim)}/stats/`;
  const data = await bzGet<BzStatsResponse>(path);
  const home = sideXgDetail(data?.stats?.home);
  const away = sideXgDetail(data?.stats?.away);
  if (home.value === null && away.value === null) {
    console.log(`[VA][Bzzoiro] GET /events/${idTrim}/stats/ → no xG data`);
    return null; // RULE 4 — no cache row, so the next call retries
  }
  const parsed: XgResult = { homeXg: home.value, awayXg: away.value, source: "bzzoiro-match" };
  console.log(`[VA][Bzzoiro] GET /events/${idTrim}/stats/ → xG ${home.value ?? "n/a"}–${away.value ?? "n/a"}`);
  store(xgByEvent, idTrim, parsed);

  if (home.value !== null && away.value !== null) {
    pendingMatchWrites.set(idTrim, {
      eventId: idTrim,
      homeXg: home.value,
      awayXg: away.value,
      // Full-time ("actual") stats are final → permanent cache row. A row built
      // from estimates can still move, so it gets the 24h branch of RULE 3.
      isFinished: !home.estimated && !away.estimated,
    });
  }
  return parsed;
}

/**
 * Rolling team xG from recent finished matches.
 *
 * Reads walk the three layers: the in-memory Map, then team_xg_cache (RULE 2 —
 * valid only while now() < next_match_at, i.e. until the team plays again), and
 * only then Bzzoiro. A cache hit costs ZERO HTTP calls.
 *
 * On a miss it walks the team's last N finished matches via
 * GET /events/?team_id={id}&status=finished&limit={lastN}, reads each match's
 * real xG (fetchMatchXg — itself cached), and averages from the team's
 * perspective: home rows add (homeXg, awayXg) to (xgFor, xgAgainst), away rows
 * the reverse. Matches without xG data are skipped; if none survive, returns
 * null and queues nothing (RULE 4).
 *
 * A successful fetch queues one row for the batched flush, carrying
 * based_on_through_at (max kickoff over the matches actually averaged);
 * next_match_at is resolved once per distinct team at flush time (RULE 7).
 */
export async function fetchTeamXgAverage(
  teamId: number,
  lastN: number = 5,
): Promise<TeamXgAverage | null> {
  if (!getApiKey()) return null;
  if (!Number.isFinite(teamId) || teamId <= 0) return null;
  const limit = Math.min(Math.max(Math.floor(lastN) || 5, 1), 20);

  const cacheKey = `${teamId}|${limit}`;
  // Layer 1 — in-memory dedup for this scan (keyed per window size).
  const hit = cached(teamAvgByTeam, cacheKey);
  if (hit) return hit;

  // Layer 2 — team_xg_cache (event-driven: valid until the team's next match).
  const fromDb = await readTeamXgCache(teamId);
  if (fromDb) {
    store(teamAvgByTeam, cacheKey, fromDb);
    return fromDb;
  }

  // Layer 3 — HTTP.
  const path = `/events/?team_id=${encodeURIComponent(String(teamId))}&status=finished&limit=${limit}`;
  const data = await bzGet<BzPage<BzTeamEventRow> | BzTeamEventRow[]>(path);
  const rows: BzTeamEventRow[] = Array.isArray(data) ? data : (data?.results ?? []);

  let forSum = 0;
  let againstSum = 0;
  let samples = 0;
  /** Kickoff of the most recent finished match that made it into the average. */
  let basedOnThroughAt: Date | null = null;
  for (const e of rows.slice(0, limit)) {
    const id = asNum(e.id);
    if (id === null) continue;
    const homeId = asNum(e.home_team_id);
    const awayId = asNum(e.away_team_id);
    const side = homeId === teamId ? "home" : awayId === teamId ? "away" : null;
    if (side === null) continue; // not this team's match — never guess the side

    const xg = await fetchMatchXg(String(id));
    if (!xg) continue; // no xG data for that match (not finished / uncovered)
    const xgFor = side === "home" ? xg.homeXg : xg.awayXg;
    const xgAgainst = side === "home" ? xg.awayXg : xg.homeXg;
    if (xgFor === null || xgAgainst === null) continue;
    forSum += xgFor;
    againstSum += xgAgainst;
    samples++;

    const kickoff = asDate(e.event_date);
    if (kickoff !== null && (basedOnThroughAt === null || kickoff.getTime() > basedOnThroughAt.getTime())) {
      basedOnThroughAt = kickoff;
    }
  }

  if (samples === 0) {
    console.log(`[VA][Bzzoiro] team ${teamId}: no finished matches with xG in last ${limit}`);
    return null; // RULE 4 — nothing real to cache; the next scan retries
  }
  const avgFor = Math.round((forSum / samples) * 100) / 100;
  const avgAgainst = Math.round((againstSum / samples) * 100) / 100;
  const avg: TeamXgAverage = {
    teamId,
    xgFor: avgFor,
    xgAgainst: avgAgainst,
    samples,
  };
  console.log(
    `[VA][Bzzoiro] team ${teamId}: xG avg over ${samples} matches — ` +
      `for ${avg.xgFor?.toFixed(2)}, against ${avg.xgAgainst?.toFixed(2)}`,
  );

  // based_on_through_at is NOT NULL in the cache table: without a parseable
  // kickoff there is nothing to invalidate against, so don't cache the row.
  if (basedOnThroughAt !== null) {
    pendingTeamWrites.set(teamId, {
      teamId,
      xgFor: avgFor,
      xgAgainst: avgAgainst,
      samples,
      basedOnThroughAt,
    });
  }

  store(teamAvgByTeam, cacheKey, avg);
  return avg;
}

/**
 * Both teams' rolling xG averages, fetched in parallel. Either side may be
 * null when that team has no finished matches with xG (fail soft).
 */
export async function fetchMatchTeamXg(
  homeTeamId: number,
  awayTeamId: number,
  lastN: number = 5,
): Promise<{ home: TeamXgAverage | null; away: TeamXgAverage | null }> {
  const [home, away] = await Promise.all([
    fetchTeamXgAverage(homeTeamId, lastN),
    fetchTeamXgAverage(awayTeamId, lastN),
  ]);
  return { home, away };
}

/**
 * Event detail (GET /events/{id}/): the home/away Bzzoiro team ids the xG
 * endpoints key on. Fails soft: null when the key is unset, the id is
 * unusable, the request fails, or neither team id is present. Cached per
 * event id for CACHE_TTL_MS.
 */
export async function fetchEventDetail(eventId: string): Promise<BzEventDetail | null> {
  const idTrim = eventId.trim();
  if (!idTrim || !/^\d+$/.test(idTrim)) return null;
  if (!getApiKey()) return null;

  const hit = cached(eventDetailByEvent, idTrim);
  if (hit) return hit;

  const data = await bzGet<BzEventDetailResponse>(`/events/${encodeURIComponent(idTrim)}/`);
  const homeTeamId = asNum(data?.home_team_id);
  const awayTeamId = asNum(data?.away_team_id);
  if (homeTeamId === null && awayTeamId === null) return null;
  const detail: BzEventDetail = { homeTeamId, awayTeamId };
  store(eventDetailByEvent, idTrim, detail);
  return detail;
}

// ─── Layer 2 persistence: batched flush (RULE 6) + next_match_at (RULE 7) ─────

/**
 * Kickoff of the team's next scheduled match, per RULE 7:
 * GET /events/?team_id={id}&limit=1, filtered to status = 'notstarted' and
 * sorted by event_date ascending. Returns null when the team has no upcoming
 * fixture — which is written as a NULL next_match_at and makes the row stale by
 * definition (RULE 2), so the next scan refetches instead of trusting it.
 */
async function fetchNextMatchAt(teamId: number): Promise<Date | null> {
  const path = `/events/?team_id=${encodeURIComponent(String(teamId))}&limit=1`;
  const data = await bzGet<BzPage<BzTeamEventRow> | BzTeamEventRow[]>(path);
  const rows: BzTeamEventRow[] = Array.isArray(data) ? data : (data?.results ?? []);

  const upcoming = rows
    .filter((r) => String(r.status ?? "").trim().toLowerCase() === "notstarted")
    .map((r) => asDate(r.event_date))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  return upcoming.length > 0 ? upcoming[0] : null;
}

/** One batched UPSERT per chunk — never one statement per HTTP response. */
async function upsertTeamRows(rows: NewTeamXgCache[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    await db
      .insert(teamXgCache)
      .values(chunk)
      .onConflictDoUpdate({
        target: teamXgCache.teamId,
        set: {
          xgFor: sql`excluded.xg_for`,
          xgAgainst: sql`excluded.xg_against`,
          samples: sql`excluded.samples`,
          basedOnThroughAt: sql`excluded.based_on_through_at`,
          nextMatchAt: sql`excluded.next_match_at`,
          updatedAt: sql`now()`,
        },
      });
  }
}

async function upsertMatchRows(rows: NewMatchXgCache[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    await db
      .insert(matchXgCache)
      .values(chunk)
      .onConflictDoUpdate({
        target: matchXgCache.eventId,
        set: {
          homeXg: sql`excluded.home_xg`,
          awayXg: sql`excluded.away_xg`,
          isFinished: sql`excluded.is_finished`,
          updatedAt: sql`now()`,
        },
      });
  }
}

/**
 * Persists every queued xG row: one batched UPSERT per table.
 *
 * performScan calls this once at the end of a scan (in a finally block, so a
 * failed scan still banks the data it did fetch). RULE 7's next_match_at lookup
 * happens HERE rather than at fetch time: the queue is keyed by primary key, so
 * a team touched by 20 fixtures in one scan costs one extra Bzzoiro call, not
 * twenty — and a cache hit never triggers it at all.
 *
 * Fail-soft (RULE 5): a flush error is logged and swallowed. The values were
 * already returned to the caller, so losing the write only costs the next scan
 * a refetch — it can never fail a scan.
 */
export async function flushXgCache(): Promise<void> {
  const teams = Array.from(pendingTeamWrites.values());
  const matches = Array.from(pendingMatchWrites.values());
  pendingTeamWrites.clear();
  pendingMatchWrites.clear();
  if (teams.length === 0 && matches.length === 0) return;

  if (matches.length > 0) {
    try {
      await upsertMatchRows(
        matches.map((m) => ({
          eventId: m.eventId,
          // numeric columns are strings in drizzle.
          homeXg: String(m.homeXg),
          awayXg: String(m.awayXg),
          isFinished: m.isFinished,
        })),
      );
    } catch (err) {
      console.log(`[VA][xg-cache] match_xg_cache flush failed (${matches.length} rows) — values already returned`, err);
    }
  }

  if (teams.length > 0) {
    try {
      // RULE 7's one lookup per distinct team, in bounded chunks (never a burst
      // of 40 parallel Bzzoiro calls) and allSettled so one team's failure
      // cannot throw away the whole batch. A failed lookup writes NULL, which
      // makes the row stale by definition (RULE 2) — the safe direction: the
      // next scan refetches instead of trusting an average that may have moved.
      const nextMatchAt: Array<Date | null> = [];
      for (let i = 0; i < teams.length; i += UPSERT_CHUNK) {
        const chunk = teams.slice(i, i + UPSERT_CHUNK);
        const settled = await Promise.allSettled(chunk.map((t) => fetchNextMatchAt(t.teamId)));
        nextMatchAt.push(...settled.map((r) => (r.status === "fulfilled" ? r.value : null)));
      }
      await upsertTeamRows(
        teams.map((t, i) => ({
          teamId: t.teamId,
          xgFor: String(t.xgFor),
          xgAgainst: String(t.xgAgainst),
          samples: t.samples,
          basedOnThroughAt: t.basedOnThroughAt,
          nextMatchAt: nextMatchAt[i] ?? null,
        })),
      );
    } catch (err) {
      console.log(`[VA][xg-cache] team_xg_cache flush failed (${teams.length} rows) — values already returned`, err);
    }
  }

  console.log(`[VA][xg-cache] flushed ${teams.length} team + ${matches.length} match xG rows`);
}
