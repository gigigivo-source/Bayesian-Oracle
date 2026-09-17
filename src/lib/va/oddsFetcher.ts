// Value Accumulator — Odds fetcher (independent, no accumulator reuse)
//
// Provider: Bzzoiro Sports Data (BSD) — football API v2.
//   Base:    https://sports.bzzoiro.com/api/v2/          (override: BZOOIRO_BASE)
//   Auth:    Authorization: Token ${BZOOIRO_KEY}
//   Events:  GET /events/?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD  (paginated {count,next,results})
//   Odds:    GET /odds/?event_id={id}                    (one row per event × market × outcome)
//
// Event resolution never queries a single exact date: Bzzoiro publishes kickoffs
// in its own timezone and sometimes a day early/late, so an exact-date query
// returns 0 rows for leagues that are in fact covered. We always query a date
// RANGE around the UTC kickoff date (±2 days, widened once to ±5 days) and then
// pick the event by fuzzy team-name comparison plus a kickoff-proximity check.
//
// Verified against the live v2 docs (sports.bzzoiro.com/docs/football/):
//   market  : 1x2 · over_under_15 · over_under_25 · over_under_35 · btts ·
//             double_chance · draw_no_bet · asian_handicap · total_corners
//   outcome : HOME/DRAW/AWAY (1x2, uppercase) · over/under (totals, lowercase) ·
//             yes/no (btts) · 1X/12/X2 (double chance) — case-sensitive
//   A free key is served the consensus aggregate only: bookmaker_slug ===
//   "consensus", bookmaker_name === "Consensus", one row per selection.
//
// Hard rules implemented here: 8s timeout per request, fail soft ([] / null on
// any error), event-id resolution cached in memory, no price ever fabricated.

export interface VaBookmakerOdds {
  bookmaker: string;
  /** Bzzoiro market slug, e.g. "1x2", "over_under_25", "btts", "total_corners" */
  marketLabel: string;
  /** O/U line when the market carries one, null for line-less markets */
  line: number | null;
  /** Bzzoiro outcome_name when present (e.g. "Home", team name), else the outcome enum */
  selection: string;
  /** decimal odds */
  odds: number;
  /** raw Bzzoiro outcome enum: HOME/DRAW/AWAY/over/under/yes/no/1X/12/X2 */
  outcome?: string;
  /** implied_probability as served by Bzzoiro */
  impliedProbability?: number;
}

interface BzOddsRow {
  id?: number;
  event_id?: number;
  market?: string | null;
  outcome?: string | null;
  line?: number | null;
  outcome_name?: string | null;
  bookmaker_slug?: string | null;
  bookmaker_name?: string | null;
  decimal_odds?: number | null;
  implied_probability?: number | null;
  movement?: string | null;
}

interface BzEventRow {
  id?: number;
  event_id?: number;
  home_team?: unknown;
  away_team?: unknown;
  home?: unknown;
  away?: unknown;
  event_date?: string | null;
  date?: string | null;
  start_time?: string | null;
  status?: string | null;
}

/**
 * Why a fixture did (not) resolve to a Bzzoiro event.
 *
 *   resolved   — an event id was found.
 *   no-match   — Bzzoiro clearly carries this competition (it returned events
 *                featuring these teams / this league) but nothing paired up.
 *   no-events  — Bzzoiro returned nothing recognisable for this fixture across
 *                the whole window: a coverage gap, which lets the caller skip
 *                the rest of the league instead of re-probing every fixture.
 */
export type BzzoiroResolutionStatus =
  | "resolved"
  | "no-match"
  | "no-events"
  | "network-error";

export interface BzzoiroResolution {
  /** Bzzoiro event id as a string, or null when nothing matched. */
  eventId: string | null;
  status: BzzoiroResolutionStatus;
  /** How many events Bzzoiro returned across the widest range we queried. */
  eventsInRange: number;
  /** Events in that range that look like this fixture's teams or league. */
  relatedInRange: number;
  /** Tolerance (in days) of the last window we tried: 2, or 5 after widening. */
  toleranceDays: number;
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
const BZ_CONNECT_TIMEOUT_MS = 20000;
const ODDS_REQUEST_TIMEOUT_MS = 8000;
const PAGE_LIMIT = 200; // API max
const CACHE_TTL_MS = 30 * 60 * 1000; // event/fixture lists are safe to reuse within a scan window
/** First attempt: kickoff date ±2 days. */
export const BZ_RANGE_DAYS = 2;
/** Second (and last) attempt when ±2 days found nothing. */
export const BZ_WIDE_RANGE_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

let warnedNoKey = false;

function getApiKey(): string {
  return (process.env.BZOOIRO_KEY ?? "").trim();
}

/** Shared GET with 8s timeout. Returns parsed JSON or null on any failure (fail soft). */
async function bzGet<T>(path: string, timeoutMs = BZ_CONNECT_TIMEOUT_MS): Promise<T | null> {
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
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

function pageRows<T>(data: BzPage<T> | T[] | null): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return Array.isArray(data.results) ? data.results : [];
}

// ─── Event ID resolution ──────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  at: number;
}

/** Fixtures for one `date_from|date_to` window, cached in memory (scan duration / TTL). */
const eventsByRange = new Map<string, CacheEntry<BzEventRow[]>>();
/** Resolved Bzzoiro event per match (date|home|away), cached in memory. */
const resolutionByMatch = new Map<string, CacheEntry<BzzoiroResolution>>();

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

const NOISE_TOKENS = new Set([
  "fc", "cf", "afc", "cfc", "sc", "ac", "as", "sk", "fk", "bk", "if", "cd", "ud",
  "club", "the", "de", "del", "la", "el", "calcio", "fussball", "football",
]);

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !NOISE_TOKENS.has(t) && !/^\d+$/.test(t));
}

/**
 * Fuzzy team-name similarity in [0, 1]: fraction of tokens that match exactly
 * or by prefix (min 3 chars) across both names.
 */
function teamNameScore(a: string, b: string): number {
  const at = nameTokens(a);
  const bt = nameTokens(b);
  if (at.length === 0 || bt.length === 0) return 0;
  const hits = (from: string[], to: string[]) =>
    from.filter((t) =>
      to.some(
        (u) =>
          u === t ||
          (t.length >= 3 && u.startsWith(t)) ||
          (u.length >= 3 && t.startsWith(u)),
      ),
    ).length;
  return (hits(at, bt) + hits(bt, at)) / (at.length + bt.length);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function eventHome(e: BzEventRow): string {
  if (typeof e.home_team === "string") return e.home_team;
  if (e.home_team && typeof e.home_team === "object") return str((e.home_team as { name?: unknown }).name);
  return str(e.home);
}

function eventAway(e: BzEventRow): string {
  if (typeof e.away_team === "string") return e.away_team;
  if (e.away_team && typeof e.away_team === "object") return str((e.away_team as { name?: unknown }).name);
  return str(e.away);
}

function eventDate(e: BzEventRow): string {
  return str(e.event_date || e.date || e.start_time);
}

function eventId(e: BzEventRow): number | null {
  if (typeof e.event_id === "number") return e.event_id;
  if (typeof e.id === "number") return e.id;
  return null;
}

/** UTC calendar day (YYYY-MM-DD) of an ISO timestamp, or "" when unparseable. */
export function utcDateKey(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

/** Shift a YYYY-MM-DD key by `days` (UTC, so no DST drift). */
function shiftDate(dateKey: string, days: number): string {
  const ms = Date.parse(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(ms)) return dateKey;
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Fetch Bzzoiro fixtures for an inclusive [dateFrom, dateTo] window
 * (follows pagination, cached per window, fail soft to []).
 */
interface EventsInRange {
  rows: BzEventRow[];
  networkError: boolean;
}

async function getEventsInRange(dateFrom: string, dateTo: string): Promise<EventsInRange> {
  const cacheKey = `${dateFrom}|${dateTo}`;
  const hit = cached(eventsByRange, cacheKey);
  if (hit) return { rows: hit, networkError: false };

  const rows: BzEventRow[] = [];
  let offset = 0;
  for (let page = 0; page < 5; page++) {
    const query = `date_from=${dateFrom}&date_to=${dateTo}`;
    const path = `/events/?${query}&limit=${PAGE_LIMIT}&offset=${offset}`;
    const data = await bzGet<BzPage<BzEventRow>>(path);
    if (data === null) return { rows: [], networkError: true };
    const batch = pageRows(data);
    rows.push(...batch);
    console.log(`[VA][Bzzoiro] GET /events/?${query} → ${batch.length} events`);
    if (!data.next || batch.length === 0) break;
    offset += batch.length;
  }

  store(eventsByRange, cacheKey, rows);
  return { rows, networkError: false };
}

export interface BzzoiroMatchRef {
  leagueSlug?: string;
  date: string; // ISO kickoff
  home: { name: string };
  away: { name: string };
}

/** Absolute distance in days between a Bzzoiro event_date and the fixture kickoff. */
function dayDistance(eventIso: string, kickoffMs: number): number | null {
  if (!eventIso) return null;
  const parsed = Date.parse(eventIso.length === 10 ? `${eventIso}T00:00:00Z` : eventIso);
  if (!Number.isFinite(parsed)) return null;
  return Math.abs(parsed - kickoffMs) / DAY_MS;
}

/**
 * How many events in the window feature either of the fixture's teams on
 * either side. Zero means Bzzoiro simply isn't carrying this competition in
 * this window — a coverage gap rather than a naming mismatch.
 */
function countRelated(events: BzEventRow[], homeName: string, awayName: string): number {
  let n = 0;
  for (const e of events) {
    const sides = [eventHome(e), eventAway(e)];
    const related = sides.some(
      (side) => teamNameScore(homeName, side) >= 0.5 || teamNameScore(awayName, side) >= 0.5,
    );
    if (related) n++;
  }
  return n;
}

/**
 * Pick the best event in `events` for the fixture: both team names must clear
 * the fuzzy bar AND the event_date must sit within `toleranceDays` of kickoff.
 */
function pickEvent(
  events: BzEventRow[],
  homeName: string,
  awayName: string,
  kickoffMs: number,
  toleranceDays: number,
): { id: number; score: number } | null {
  let best: { id: number; score: number } | null = null;
  for (const e of events) {
    const id = eventId(e);
    if (id === null) continue;

    const distance = dayDistance(eventDate(e), kickoffMs);
    // A row with no usable date is only usable on names alone; treat as max distance.
    if (distance !== null && distance > toleranceDays) continue;

    const hScore = teamNameScore(homeName, eventHome(e));
    const aScore = teamNameScore(awayName, eventAway(e));
    // Both sides must clear the bar — one-sided similarity is not a match.
    if (hScore < 0.5 || aScore < 0.5) continue;

    // Closer kickoffs break ties between equally-named candidates.
    const proximity = distance === null ? 0 : 1 - distance / (toleranceDays + 1);
    const score = hScore + aScore + proximity;
    if (!best || score > best.score) best = { id, score };
  }
  return best;
}

/**
 * Resolve the Bzzoiro event for a match: query a ±2-day window around the UTC
 * kickoff date, match on fuzzy team names + kickoff proximity, and widen once
 * to ±5 days when nothing is found. Fails soft — `eventId` is null when no
 * confident match exists and the caller must skip the match.
 */
export async function resolveBzzoiroEvent(fx: BzzoiroMatchRef): Promise<BzzoiroResolution> {
  const homeName = fx.home?.name ?? "";
  const awayName = fx.away?.name ?? "";
  const kickoffDate = utcDateKey(fx.date ?? "");
  const kickoffMs = Date.parse(fx.date ?? "");
  if (!kickoffDate || !Number.isFinite(kickoffMs) || !homeName || !awayName) {
    return {
      eventId: null,
      status: "no-match",
      eventsInRange: 0,
      relatedInRange: 0,
      toleranceDays: BZ_RANGE_DAYS,
    };
  }

  const cacheKey = `${kickoffDate}|${homeName.toLowerCase()}|${awayName.toLowerCase()}`;
  const hit = cached(resolutionByMatch, cacheKey);
  if (hit !== undefined) return hit;

  let events: BzEventRow[] = [];
  let toleranceDays = BZ_RANGE_DAYS;
  let networkError = false;

  for (const days of [BZ_RANGE_DAYS, BZ_WIDE_RANGE_DAYS]) {
    toleranceDays = days;
    const fetched = await getEventsInRange(shiftDate(kickoffDate, -days), shiftDate(kickoffDate, days));
    events = fetched.rows;
    networkError ||= fetched.networkError;
    const best = pickEvent(events, homeName, awayName, kickoffMs, days);
    if (best) {
      const resolved: BzzoiroResolution = {
        eventId: String(best.id),
        status: "resolved",
        eventsInRange: events.length,
        relatedInRange: 1,
        toleranceDays: days,
      };
      store(resolutionByMatch, cacheKey, resolved);
      return resolved;
    }
  }

  // Nothing matched even at ±5 days. Distinguish "the feed has no idea these
  // teams exist" (coverage gap) from "the teams are there but nothing paired".
  const relatedInRange = countRelated(events, homeName, awayName);
  if (networkError) {
    console.log(`[VA] Bzzoiro network error for ${fx.leagueSlug ?? "unknown league"} — not counting toward blacklist`);
  }
  const missed: BzzoiroResolution = {
    eventId: null,
    status: networkError ? "network-error" : relatedInRange === 0 ? "no-events" : "no-match",
    eventsInRange: events.length,
    relatedInRange,
    toleranceDays,
  };
  store(resolutionByMatch, cacheKey, missed);
  return missed;
}

/**
 * Back-compat convenience wrapper: the resolved Bzzoiro event id, or null.
 */
export async function resolveBzzoiroEventId(fx: BzzoiroMatchRef): Promise<string | null> {
  return (await resolveBzzoiroEvent(fx)).eventId;
}

// ─── Odds ─────────────────────────────────────────────────────────────────────

/**
 * Line encoded in a market slug: "over_under_25" → 2.5, "over_under_15" → 1.5.
 * Returns null when the slug carries no usable line (e.g. "total_corners").
 */
function lineFromMarketSlug(market: string): number | null {
  const m = market.match(/(\d)(\d)$/);
  if (!m) return null;
  const line = Number(`${m[1]}.${m[2]}`);
  return Number.isFinite(line) ? line : null;
}

/**
 * Fetch all odds rows for a Bzzoiro event, flattened into VaBookmakerOdds.
 * Prefers consensus rows (the aggregate price) when present; otherwise falls
 * back to whatever bookmaker rows are available. Fails soft: [] on any error.
 */
export async function fetchOddsForEvent(bzzoiroEventId: string): Promise<VaBookmakerOdds[]> {
  const idTrim = bzzoiroEventId.trim();
  if (!idTrim || !/^\d+$/.test(idTrim)) return [];

  const path = `/odds/?event_id=${encodeURIComponent(idTrim)}&limit=${PAGE_LIMIT}`;
  const data = await bzGet<BzPage<BzOddsRow> | BzOddsRow[]>(path, ODDS_REQUEST_TIMEOUT_MS);
  const rows = pageRows(data);
  console.log(`[VA][Bzzoiro] GET /odds/?event_id=${idTrim} → ${rows.length} rows`);
  if (rows.length === 0) return [];

  // Prefer the consensus aggregate when the feed mixes it with per-book rows.
  const consensus = rows.filter((r) => (r.bookmaker_slug ?? "").toLowerCase() === "consensus");
  const usable = consensus.length > 0 ? consensus : rows;

  const out: VaBookmakerOdds[] = [];
  for (const r of usable) {
    const odds = typeof r.decimal_odds === "number" && Number.isFinite(r.decimal_odds) ? r.decimal_odds : null;
    if (odds === null || odds <= 1) continue; // never fabricate a price
    const market = (r.market ?? "").trim();
    if (!market) continue;
    const outcome = (r.outcome ?? "").trim();
    const selection = (r.outcome_name ?? "").trim() || outcome;
    if (!selection) continue;
    const line =
      typeof r.line === "number" && Number.isFinite(r.line) ? r.line : lineFromMarketSlug(market);
    out.push({
      bookmaker: (r.bookmaker_name ?? "").trim() || (r.bookmaker_slug ?? "").trim() || "Bzzoiro",
      marketLabel: market,
      line,
      selection,
      odds,
      outcome: outcome || undefined,
      impliedProbability:
        typeof r.implied_probability === "number" && Number.isFinite(r.implied_probability)
          ? r.implied_probability
          : undefined,
    });
  }
  return out;
}
