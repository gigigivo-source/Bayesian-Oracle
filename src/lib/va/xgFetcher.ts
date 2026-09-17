// Value Accumulator — xG fetcher (per-shot expected goals, Bzzoiro Sports Data).
//
// Provider: Bzzoiro Sports Data (BSD) — football API v2, free tier.
//   Base:    https://sports.bzzoiro.com/api/v2/          (override: BZOOIRO_BASE)
//   Auth:    Authorization: Token ${BZOOIRO_KEY}
//   Stats:   GET /events/{EVENT_ID}/stats/               (team stats + shotmap)
//   Team:    GET /events/?team_id={ID}&status=finished   (recent finished matches)
//
// Mirrors oddsFetcher.ts exactly: same Authorization header format, same 8s
// timeout, same fail-soft return-null pattern, same BZOOIRO_KEY / BZOOIRO_BASE
// env reads, same in-memory cache pattern with CACHE_TTL_MS.
//
// Documented response shape (sports.bzzoiro.com/docs/football/events/):
//   {
//     "event_id": 223510, "xg_estimated": false,
//     "stats": {
//       "home": { "xg": { "actual": 1.62, "estimated": false }, ... },
//       "away": { ... }
//     },
//     "shotmap": [
//       { "home": true, "min": 23, "type": "goal", "sit": "assisted",
//         "pos": { "x": 88.2, "y": 44.1 }, "xg": 0.34, "xg_estimated": false }
//     ],
//     "xg_per_minute": [
//       { "m": 23, "xg_home": 0.34, "xg_away": 0.0, ... }
//     ]
//   }
//
// Parsing rules (from the same docs):
//   · `shotmap` is the per-shot record — the per-shot xg values sum to the
//     team total, and "if you need one number and cannot show two, take the
//     shotmap". Side flag is the `home` boolean; `pos` is 0–100 × 0–100.
//   · Penalty-shootout rows (sit === "shootout") carry xg: null and are
//     skipped — they never count toward xG.
//   · Thinly covered matches serve empty arrays (not missing keys); uncovered
//     stat values are null, never 0 — code defensively either way.
//   · When the shotmap is empty but the team aggregates exist
//     (stats.home.xg.actual / stats.away.xg.actual, or the `expected_goals`
//     key), those are used instead. Null when neither exists (fail soft).

export interface XgShot {
  x: number;
  y: number;
  xg: number;
  team: "home" | "away";
}

export interface XgResult {
  homeXg: number | null;
  awayXg: number | null;
  perShot: XgShot[];
  source: "bzzoiro" | null;
}

interface BzShotRow {
  home?: unknown;
  team?: unknown;
  side?: unknown;
  h_a?: unknown;
  is_home?: unknown;
  pos?: unknown;
  x?: unknown;
  y?: unknown;
  xg?: unknown;
  sit?: unknown;
}

interface BzStatsSide {
  xg?: unknown;
  expected_goals?: unknown;
}

interface BzStatsResponse {
  event_id?: unknown;
  stats?: {
    home?: BzStatsSide;
    away?: BzStatsSide;
  };
  shotmap?: unknown;
  shots?: unknown;
}

interface BzTeamEventRow {
  id?: unknown;
  event_id?: unknown;
  home_team?: unknown;
  away_team?: unknown;
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
const CACHE_TTL_MS = 30 * 60 * 1000; // xG for a match is immutable once played; safe to reuse within a scan window

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

/** Test helper — drop cached xG responses. */
export function __clearXgCacheForTests(): void {
  xgByEvent.clear();
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

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Side of a shotmap row: the documented `home` boolean first, then common aliases. */
function shotSide(row: BzShotRow): "home" | "away" | null {
  if (row.home === true || row.is_home === true) return "home";
  if (row.home === false || row.is_home === false) return "away";
  for (const v of [row.team, row.side, row.h_a]) {
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "home" || s === "h" || s === "1") return "home";
      if (s === "away" || s === "a" || s === "2") return "away";
    }
    if (typeof v === "number") {
      if (v === 1) return "home";
      if (v === 2) return "away";
    }
  }
  return null;
}

function shotPos(row: BzShotRow): { x: number; y: number } | null {
  const pos = asRecord(row.pos);
  const x = asNum(pos?.x ?? row.x);
  const y = asNum(pos?.y ?? row.y);
  if (x === null || y === null) return null;
  return { x, y };
}

/** Aggregate xG for one side: stats.{home,away}.xg.actual, else `expected_goals`. */
function aggregateSideXg(side: BzStatsSide | undefined): number | null {
  if (!side) return null;
  const xgBlock = asRecord(side.xg);
  const actual = asNum(xgBlock?.actual);
  if (actual !== null) return actual;
  // Fallback: some responses serve the aggregate as a bare number.
  const bare = asNum(side.xg);
  if (bare !== null) return bare;
  return asNum(side.expected_goals);
}

function parseStatsResponse(data: BzStatsResponse | null): XgResult | null {
  if (!data) return null;
  const rec = asRecord(data);
  if (!rec) return null;

  // 1) Shotmap — the per-shot record (preferred: sums to the team total).
  const rows = asArray(rec.shotmap ?? (rec as { shots?: unknown }).shots);
  const perShot: XgShot[] = [];
  let homeSum = 0;
  let awaySum = 0;
  let homeShots = 0;
  let awayShots = 0;
  for (const raw of rows) {
    const row = asRecord(raw) as BzShotRow | null;
    if (!row) continue;
    // Penalty-shootout attempts carry xg: null and never count toward xG.
    if (typeof row.sit === "string" && row.sit.trim().toLowerCase() === "shootout") continue;
    const xg = asNum(row.xg);
    if (xg === null) continue;
    const side = shotSide(row);
    if (!side) continue;
    const pos = shotPos(row) ?? { x: 0, y: 0 };
    perShot.push({ x: pos.x, y: pos.y, xg, team: side });
    if (side === "home") {
      homeSum += xg;
      homeShots++;
    } else {
      awaySum += xg;
      awayShots++;
    }
  }
  if (perShot.length > 0) {
    return {
      homeXg: homeShots > 0 ? Math.round(homeSum * 100) / 100 : null,
      awayXg: awayShots > 0 ? Math.round(awaySum * 100) / 100 : null,
      perShot,
      source: "bzzoiro",
    };
  }

  // 2) Team aggregates (thinly covered matches have no shotmap).
  const stats = asRecord(rec.stats);
  const homeAgg = aggregateSideXg(stats?.home as BzStatsSide | undefined);
  const awayAgg = aggregateSideXg(stats?.away as BzStatsSide | undefined);
  // 3) Last resort: root-level home_xg / away_xg keys.
  const homeXg = homeAgg ?? asNum(rec.home_xg);
  const awayXg = awayAgg ?? asNum(rec.away_xg);
  if (homeXg === null && awayXg === null) return null;
  return { homeXg, awayXg, perShot: [], source: "bzzoiro" };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch per-shot xG for a Bzzoiro event.
 * Fails soft: null when the key is unset, the event id is unusable, the
 * request fails, or the response carries no xG fields. Successful responses
 * are cached in memory for CACHE_TTL_MS.
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
  const parsed = parseStatsResponse(data);
  console.log(
    `[VA][Bzzoiro] GET /events/${idTrim}/stats/ → ` +
      (parsed
        ? `xG ${parsed.homeXg ?? "n/a"}–${parsed.awayXg ?? "n/a"} (${parsed.perShot.length} shots)`
        : "no xG data"),
  );
  if (!parsed) return null;
  store(xgByEvent, idTrim, parsed);
  return parsed;
}

// ─── Team-average helper ──────────────────────────────────────────────────────

function eventIdOf(e: BzTeamEventRow): string | null {
  if (typeof e.event_id === "number") return String(e.event_id);
  if (typeof e.id === "number") return String(e.id);
  if (typeof e.event_id === "string" && /^\d+$/.test(e.event_id.trim())) return e.event_id.trim();
  if (typeof e.id === "string" && /^\d+$/.test(e.id.trim())) return e.id.trim();
  return null;
}

function eventSideName(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  const rec = asRecord(v);
  if (rec) {
    const name = rec.name ?? rec.title ?? rec.short_name;
    if (typeof name === "string") return name;
  }
  return "";
}

function eventSideId(v: unknown): number | null {
  const rec = asRecord(v);
  const id = rec?.id ?? rec?.team_id;
  if (typeof id === "number" && Number.isFinite(id)) return id;
  if (typeof id === "string" && /^\d+$/.test(id.trim())) return Number(id.trim());
  return null;
}

function normName(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

/**
 * Which side of the event the team played on: stable numeric team ids win,
 * fuzzy name comparison is the fallback (same containment rule oddsFetcher
 * uses for one-sided similarity).
 */
function sideOfEvent(e: BzTeamEventRow, teamName: string, bzzoiroTeamId: number): "home" | "away" | null {
  const homeId = eventSideId(e.home_team);
  const awayId = eventSideId(e.away_team);
  if (homeId !== null && homeId === bzzoiroTeamId) return "home";
  if (awayId !== null && awayId === bzzoiroTeamId) return "away";
  const want = normName(teamName);
  if (!want) return null;
  const hn = normName(eventSideName(e.home_team));
  const an = normName(eventSideName(e.away_team));
  const match = (side: string) => side && (side === want || side.includes(want) || want.includes(side));
  if (hn && match(hn) && !(an && match(an))) return "home";
  if (an && match(an) && !(hn && match(hn))) return "away";
  return null;
}

/**
 * Average xG for/against across a team's recent finished matches.
 *
 * Walks the team's recent finished matches via the documented list filters
 * (GET /events/?team_id={id}&status=finished&limit={lastN}), calls
 * fetchMatchXg for each, and averages from the team's perspective. Fail soft:
 * null when the key is unset, the team has no finished events with xG, or any
 * step fails. Per-match xG responses reuse the fetchMatchXg cache.
 */
export async function fetchTeamXgAverage(
  teamName: string,
  bzzoiroTeamId: number,
  lastN: number = 5,
): Promise<{ xgFor: number; xgAgainst: number; samples: number } | null> {
  if (!getApiKey()) return null;
  if (!Number.isFinite(bzzoiroTeamId) || bzzoiroTeamId <= 0) return null;
  const limit = Math.min(Math.max(Math.floor(lastN) || 5, 1), 20);

  const path = `/events/?team_id=${encodeURIComponent(String(bzzoiroTeamId))}&status=finished&limit=${limit}`;
  const data = await bzGet<BzPage<BzTeamEventRow> | BzTeamEventRow[]>(path);
  const rows: BzTeamEventRow[] = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
  if (rows.length === 0) return null;

  let forSum = 0;
  let againstSum = 0;
  let samples = 0;
  for (const e of rows.slice(0, limit)) {
    const id = eventIdOf(e);
    if (!id) continue;
    const side = sideOfEvent(e, teamName, bzzoiroTeamId);
    if (!side) continue;
    const xg = await fetchMatchXg(id);
    if (!xg) continue;
    const xf = side === "home" ? xg.homeXg : xg.awayXg;
    const xa = side === "home" ? xg.awayXg : xg.homeXg;
    if (xf === null || xa === null) continue;
    forSum += xf;
    againstSum += xa;
    samples++;
  }
  if (samples === 0) return null;
  return {
    xgFor: Math.round((forSum / samples) * 100) / 100,
    xgAgainst: Math.round((againstSum / samples) * 100) / 100,
    samples,
  };
}
