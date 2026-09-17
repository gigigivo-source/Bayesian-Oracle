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
 */
function sideXg(side: BzStatsSide | undefined): number | null {
  const xg = asRecord(side?.xg);
  if (!xg) return null;
  const actual = asNum(xg.actual);
  if (actual !== null) return actual;
  return asNum(xg.estimated);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Real per-match xG for a FINISHED match (GET /events/{id}/stats/).
 *
 * All stats values are null until full-time, so this returns null for any
 * match that has not finished (or is thinly covered). Fails soft: null when
 * the key is unset, the event id is unusable, the request fails, or both xG
 * sides are null. A one-sided result returns that side as null and the other
 * as-is. Successful responses are cached in memory for CACHE_TTL_MS.
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

  const hit = cached(xgByEvent, idTrim);
  if (hit) return hit;

  const path = `/events/${encodeURIComponent(idTrim)}/stats/`;
  const data = await bzGet<BzStatsResponse>(path);
  const home = sideXg(data?.stats?.home);
  const away = sideXg(data?.stats?.away);
  if (home === null && away === null) {
    console.log(`[VA][Bzzoiro] GET /events/${idTrim}/stats/ → no xG data`);
    return null;
  }
  const parsed: XgResult = { homeXg: home, awayXg: away, source: "bzzoiro-match" };
  console.log(`[VA][Bzzoiro] GET /events/${idTrim}/stats/ → xG ${home ?? "n/a"}–${away ?? "n/a"}`);
  store(xgByEvent, idTrim, parsed);
  return parsed;
}

/**
 * Rolling team xG from recent finished matches.
 *
 * Walks the team's last N finished matches via
 * GET /events/?team_id={id}&status=finished&limit={lastN}, reads each match's
 * real xG (fetchMatchXg), and averages from the team's perspective: home rows
 * add (homeXg, awayXg) to (xgFor, xgAgainst), away rows the reverse. Matches
 * without xG data are skipped; if none survive, returns null. Cached per
 * (teamId, lastN) for CACHE_TTL_MS.
 */
export async function fetchTeamXgAverage(
  teamId: number,
  lastN: number = 5,
): Promise<TeamXgAverage | null> {
  if (!getApiKey()) return null;
  if (!Number.isFinite(teamId) || teamId <= 0) return null;
  const limit = Math.min(Math.max(Math.floor(lastN) || 5, 1), 20);

  const cacheKey = `${teamId}|${limit}`;
  const hit = cached(teamAvgByTeam, cacheKey);
  if (hit) return hit;

  const path = `/events/?team_id=${encodeURIComponent(String(teamId))}&status=finished&limit=${limit}`;
  const data = await bzGet<BzPage<BzTeamEventRow> | BzTeamEventRow[]>(path);
  const rows: BzTeamEventRow[] = Array.isArray(data) ? data : (data?.results ?? []);

  let forSum = 0;
  let againstSum = 0;
  let samples = 0;
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
  }

  if (samples === 0) {
    console.log(`[VA][Bzzoiro] team ${teamId}: no finished matches with xG in last ${limit}`);
    return null;
  }
  const avg: TeamXgAverage = {
    teamId,
    xgFor: Math.round((forSum / samples) * 100) / 100,
    xgAgainst: Math.round((againstSum / samples) * 100) / 100,
    samples,
  };
  console.log(
    `[VA][Bzzoiro] team ${teamId}: xG avg over ${samples} matches — ` +
      `for ${avg.xgFor?.toFixed(2)}, against ${avg.xgAgainst?.toFixed(2)}`,
  );
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
