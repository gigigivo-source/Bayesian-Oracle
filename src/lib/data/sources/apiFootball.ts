// ĞIGI GIVØ — API-Football (api-sports.io) stats normaliser.
//
// Endpoint: https://v3.football.api-sports.io/fixtures/statistics?fixture={id}
// Key:      API_FOOTBALL_KEY (or FOOTBALL_API_KEY) via env.
//
// The most comprehensive live source: when it works it provides nearly every
// per-match stat (xG, shots, SOT, corners, cards, fouls, passes, possession,
// saves, throw-ins, offsides, …). It does NOT provide historical season
// averages, which is why the aggregator only "breaks early" on API-Football
// when every NON-historical field is already covered.
//
// ─── Fixture id resolution ──────────────────────────────────────────────────
// API-Football uses its OWN numeric fixture ids; ESPN event ids (e.g.
// 401879288) do not exist in API-Football and a direct /fixtures/statistics?
// fixture={espnId} call always 404s. So before fetching statistics the fixture
// is resolved:
//   1. GET /fixtures?date={YYYY-MM-DD}&league={leagueId}&season={YYYY}
//   2. fuzzy-match homeTeam / awayTeam against the returned fixtures
//   3. extract the correct fixture.id
//   4. GET /fixtures/statistics?fixture={fixtureId}
// Resolved ids (and misses) are cached per league+date+teams, so repeated
// queries never re-lookup.
//
// ─── 403 handling ───────────────────────────────────────────────────────────
// API-Football answers 403 for ALL of: invalid/expired key, plan restriction
// and daily/hourly quota exhaustion. On 403 this handler fetches the exact
// response body once and logs it, classifying it as key / plan / rate limit.
// Rate-limited keys arm the aggregator cooldown (back off) while previously
// merged results are served from cache (aggressive caching).
//
// ─── Key health check ───────────────────────────────────────────────────────
// checkApiFootballKey() calls GET /status with the configured key and logs the
// account state (see its docs — plan/quota/expiry details are dashboard-only).

import type { SourceContext, SourceHandler } from "./context";
import {
  asArray, asNumber, asRecord, asString, fetchErrorBody, getPath,
  namesMatch, normalizeName, pct, roundTo,
} from "./shared";
import { fetchWithTimeout } from "../http";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatField, StatKey } from "../types";

const BASE = "https://v3.football.api-sports.io";

/** Stat fields API-Football's `/fixtures/statistics` response can fill. */
export const API_FOOTBALL_CAPABILITIES: StatField[] = [
  "goals", "xg", "xgPerShot", "shots", "shotsOnTarget", "shotsOffTarget",
  "blockedShots", "corners", "goalKicks", "throwIns", "freeKicks", "penalties",
  "yellowCards", "redCards", "fouls", "offsides", "possession", "passes",
  "passAccuracy", "saves", "goalsConceded", "cleanSheet", "dribbling",
  "aerialBattlesWon", "interceptions", "tackles", "clearances",
];

/** ESPN slug → API-Football league id. */
export const LEAGUE_IDS: Record<string, number> = {
  "eng.1": 39,
  "esp.1": 140,
  "ger.1": 78,
  "ita.1": 135,
  "fra.1": 61,
  "uefa.champions": 2,
  "uefa.europa": 3,
};

/** API-Football statistic "type" string → TeamStats field. */
const TYPE_MAP: Record<string, StatKey> = {
  expectedgoals: "xg",
  // The live API's exact label is "Expected Goals (xG)" → "expectedgoalsxg".
  expectedgoalsxg: "xg",
  xg: "xg",
  shotsongoal: "shotsOnTarget",
  shotsoffgoal: "shotsOffTarget",
  totalshots: "shots",
  blockedshots: "blockedShots",
  fouls: "fouls",
  cornerkicks: "corners",
  offsides: "offsides",
  ballpossession: "possession",
  yellowcards: "yellowCards",
  redcards: "redCards",
  goalkeepersaves: "saves",
  totalpasses: "passes",
  throwins: "throwIns",
  goalkicks: "goalKicks",
  freekicks: "freeKicks",
  penalty: "penalties",
  penalties: "penalties",
  tackles: "tackles",
  interceptions: "interceptions",
  dribbles: "dribbling",
  successfuldribbles: "dribbling",
  dribbleattempts: "dribbling",
  aerials: "aerialBattlesWon",
  aerialswon: "aerialBattlesWon",
  aerialduelswon: "aerialBattlesWon",
  clearances: "clearances",
  goals: "goals",
};

// Note: "%" is stripped on purpose — the live API's "Ball Possession %" label
// must normalise to "ballpossession" to hit the TYPE_MAP entry.
const normKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Football season start year for a date (Aug 2026 → 2026, Mar 2026 → 2025). */
export function footballSeason(date: string): number {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const year = Number.isFinite(d.getTime()) ? d.getUTCFullYear() : new Date().getUTCFullYear();
  return d.getUTCMonth() + 1 >= 7 ? year : year - 1;
}

// ─── Resolved-fixture cache ───────────────────────────────────────────────────

interface ResolvedFixture {
  fixtureId: number;
  homeName: string;
  awayName: string;
  goals: { home: number | null; away: number | null } | null;
}

/** Fixture lists are immutable once published — cache hits for 12h. */
const RESOLUTION_CACHE_TTL_MS = 12 * 60 * 60_000;
/** Misses are retried every 10 min (a fixture may appear late / after kickoff). */
const RESOLUTION_NEGATIVE_TTL_MS = 10 * 60_000;

interface FixtureCacheEntry {
  at: number;
  hit: ResolvedFixture | null;
}

const fixtureIdCache = new Map<string, FixtureCacheEntry>();

function resolutionCacheKey(match: MatchStatsQuery): string {
  return [
    match.leagueSlug,
    match.date.slice(0, 10),
    normalizeName(match.homeTeam),
    normalizeName(match.awayTeam),
  ].join("|");
}

/** Clear the resolved-fixture cache (tests / manual refresh). */
export function clearFixtureIdCache(): void {
  fixtureIdCache.clear();
}

// ─── 403 diagnostics ──────────────────────────────────────────────────────────

const RATE_LIMIT_BODY_RE = /limit|rate ?limit|daily|requests? (?:per|limit)|too many/i;

/**
 * Print the EXACT API-Football 403 response body so the operator can see
 * whether it is an expired key, a plan restriction or a rate limit — and arm
 * the rate-limit cooldown when that is what it is.
 */
async function handle403(
  ctx: SourceContext,
  headers: Record<string, string>,
  url: string,
): Promise<void> {
  const body = await fetchErrorBody(url, headers, 8_000);
  ctx.log(`[API-Football] 403 from ${url} — response body: ${body ?? "<empty body; host answered but no payload>"}`);
  if (!body) return;
  if (/invalid api key|api key not (?:found|valid)|no (?:such|valid) key/i.test(body)) {
    ctx.log("[API-Football] 403 classification: INVALID OR EXPIRED KEY — set a valid API_FOOTBALL_KEY in .env.local (get one at https://dashboard.api-sports.io)");
  } else if (/plan|subscription|upgrade|premium|not (?:available|included)/i.test(body)) {
    ctx.log("[API-Football] 403 classification: PLAN RESTRICTION — this endpoint is not available on the current plan (check quota at https://dashboard.api-sports.io)");
  } else if (RATE_LIMIT_BODY_RE.test(body)) {
    ctx.log("[API-Football] 403 classification: RATE LIMIT — backing off (cooldown armed); previously merged results stay cached and are served meanwhile");
    ctx.reportRateLimit?.("API-Football 403 quota (daily/hourly requests)");
  } else {
    ctx.log("[API-Football] 403 classification: UNKNOWN — see body above; run GET /api/diagnostics/data-sources for the full key check");
  }
}

// ─── Fixture id resolution (ESPN id → API-Football fixture id) ───────────────

async function resolveFixture(
  match: MatchStatsQuery,
  ctx: SourceContext,
  headers: Record<string, string>,
): Promise<ResolvedFixture | null> {
  const ck = resolutionCacheKey(match);
  const cached = fixtureIdCache.get(ck);
  if (cached) {
    const ttl = cached.hit ? RESOLUTION_CACHE_TTL_MS : RESOLUTION_NEGATIVE_TTL_MS;
    if (Date.now() - cached.at < ttl) {
      if (cached.hit) {
        ctx.log(`[API-Football] Using cached fixture id ${cached.hit.fixtureId} for ${cached.hit.homeName} vs ${cached.hit.awayName}`);
      } else {
        const retryIn = Math.max(0, Math.round((ttl - (Date.now() - cached.at)) / 1000));
        ctx.log(`[API-Football] Cached negative fixture lookup for ${match.homeTeam} vs ${match.awayTeam} — skipping (retry in ${retryIn}s)`);
      }
      return cached.hit;
    }
  }

  const day = match.date.slice(0, 10);
  const leagueId = LEAGUE_IDS[match.leagueSlug];
  const season = footballSeason(match.date);

  // Narrowed first (league + season), then relaxed, then date-only fallback.
  const urls: string[] =
    leagueId != null
      ? [
          `${BASE}/fixtures?date=${day}&league=${leagueId}&season=${season}`,
          `${BASE}/fixtures?date=${day}&league=${leagueId}`,
          `${BASE}/fixtures?date=${day}`,
        ]
      : [`${BASE}/fixtures?date=${day}`];

  let saw403 = false;
  let hit: ResolvedFixture | null = null;

  for (const url of urls) {
    const res = await ctx.http(url, { headers, timeoutMs: ctx.timeoutMs });
    if (res.status === "http-error" && res.httpStatus === 403) {
      if (!saw403) {
        saw403 = true;
        await handle403(ctx, headers, url);
      } // further 403s repeat the same body — no new information
      continue;
    }
    if (res.status === "rate-limited") {
      ctx.log("[API-Football] 429 — backing off (cooldown armed); previously merged results stay cached");
      ctx.reportRateLimit?.("API-Football 429 (requests limit)");
      continue;
    }
    if (res.status === "not-found") {
      ctx.log(`[API-Football] Fixture lookup 404 — no fixtures returned for ${url}`);
      continue;
    }
    if (res.status !== "ok") continue;

    const response = asArray(getPath(res.data, "response"));
    for (const item of response) {
      const rec = asRecord(item);
      const h = asString(getPath(rec, "teams.home.name"));
      const a = asString(getPath(rec, "teams.away.name"));
      if (!h || !a) continue;
      if (!namesMatch(h, match.homeTeam) || !namesMatch(a, match.awayTeam)) continue;
      const fixtureId = asNumber(getPath(rec, "fixture.id"));
      if (fixtureId === null) continue;
      hit = {
        fixtureId,
        homeName: h,
        awayName: a,
        goals: {
          home: asNumber(getPath(rec, "goals.home")),
          away: asNumber(getPath(rec, "goals.away")),
        },
      };
      break;
    }
    if (hit) break;
  }

  if (hit) {
    ctx.log(`[API-Football] Resolved fixture ${hit.fixtureId} for ${hit.homeName} vs ${hit.awayName}`);
  }
  fixtureIdCache.set(ck, { at: Date.now(), hit });
  return hit;
}

// ─── Key health check ─────────────────────────────────────────────────────────

export interface ApiFootballKeyReport {
  /** Whether a key is configured in env at all. */
  configured: boolean;
  /** Whether the API host answered (any HTTP status proves reachability). */
  reachable: boolean;
  /** null = host not reached / no key; true = /status accepted the key. */
  valid: boolean | null;
  httpStatus: number | null;
  /** Size of the /status `response` catalogue when the key is valid. */
  resultsCount: number | null;
  /** `errors[].info` strings from the API body, when present. */
  errors: string[];
  note: string;
  checkedAt: string;
}

function parseApiFootballBody(body: string): { errors: string[]; resultsCount: number | null } {
  try {
    const rec = asRecord(JSON.parse(body));
    if (!rec) return { errors: [], resultsCount: null };
    const errors = asArray(rec.errors)
      .map((e) => {
        const er = asRecord(e);
        return asString(er?.info) ?? asString(e) ?? "";
      })
      .filter(Boolean);
    const resultsCount = typeof rec.results === "number" ? rec.results : null;
    return { errors, resultsCount };
  } catch {
    return { errors: [], resultsCount: null };
  }
}

/**
 * Health check: call GET /status with the configured key and log the account
 * status. /status proves reachability + key acceptance (200 = valid,
 * 403 = rejected) and returns the catalogue size; the plan name, requests
 * used and expiry date are dashboard-only at API-Football, so for every
 * non-200 answer the EXACT response body is logged and its `errors[].info`
 * surfaced — that text is what distinguishes expired key / plan restriction /
 * rate limit.
 */
export async function checkApiFootballKey(opts?: {
  timeoutMs?: number;
  log?: (message: string) => void;
}): Promise<ApiFootballKeyReport> {
  const log = opts?.log ?? ((m: string) => console.log(m));
  const checkedAt = new Date().toISOString();
  const key = ((process.env.API_FOOTBALL_KEY ?? "") || (process.env.FOOTBALL_API_KEY ?? "")).trim();

  if (!key) {
    log("[API-Football] key check: NO KEY CONFIGURED — set API_FOOTBALL_KEY in .env.local (free signup: https://dashboard.api-sports.io)");
    return {
      configured: false, reachable: false, valid: null, httpStatus: null,
      resultsCount: null, errors: [], note: "API_FOOTBALL_KEY (or FOOTBALL_API_KEY) is not set", checkedAt,
    };
  }

  const url = `${BASE}/status`;
  const res = await fetchWithTimeout(url, {
    headers: { "x-apisports-key": key },
    timeoutMs: opts?.timeoutMs ?? 10_000,
  });

  if (res.status === "ok") {
    const body = asRecord(res.data) ?? {};
    const errors = asArray(body.errors)
      .map((e) => asString(asRecord(e)?.info) ?? asString(e) ?? "")
      .filter(Boolean);
    const resultsCount = typeof body.results === "number" ? body.results : null;
    log(
      `[API-Football] key check: OK — HTTP ${res.httpStatus}, /status accepted the key ` +
      `(${resultsCount ?? "?"} catalogue entries). Plan / requests-used / expiry are dashboard-only: ` +
      `inspect the quota at https://dashboard.api-sports.io`,
    );
    return {
      configured: true, reachable: true, valid: true, httpStatus: res.httpStatus,
      resultsCount, errors, note: "key accepted by /status", checkedAt,
    };
  }

  const httpStatus = res.httpStatus;
  if (res.status === "network-error" || res.status === "timeout") {
    log(`[API-Football] key check: HOST UNREACHABLE (${res.status}) — check the network allowlist for v3.football.api-sports.io`);
    return {
      configured: true, reachable: false, valid: null, httpStatus,
      resultsCount: null, errors: [],
      note: `host unreachable (${res.status}) — check egress/allowlist`, checkedAt,
    };
  }

  // Got an HTTP answer (403 / 401 / other) — log the exact body.
  const body = await fetchErrorBody(url, { "x-apisports-key": key }, 8_000);
  const { errors, resultsCount } = body ? parseApiFootballBody(body) : { errors: [], resultsCount: null };
  log(`[API-Football] key check: REJECTED — HTTP ${httpStatus ?? "?"}, body: ${body ?? "<empty>"}`);
  if (errors.length) log(`[API-Football] key check: API errors: ${errors.join("; ")}`);
  if (httpStatus === 403 && body && RATE_LIMIT_BODY_RE.test(body)) {
    log("[API-Football] key check: looks like a RATE LIMIT — wait for the quota window or upgrade the plan");
  }
  return {
    configured: true, reachable: true, valid: false, httpStatus,
    resultsCount, errors,
    note: `key rejected by /status (HTTP ${httpStatus})`, checkedAt,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/** Extract a stats entry's numeric value (handles "55%" and "1.23"). */
function valueOf(v: unknown): number | null {
  return asNumber(v);
}

export const apiFootballSource: SourceHandler = {
  name: "API-Football",
  capabilities: API_FOOTBALL_CAPABILITIES,

  available: (_match, ctx) => {
    const key = ctx.env("API_FOOTBALL_KEY") || ctx.env("FOOTBALL_API_KEY");
    return key.length > 0;
  },

  async fetch(match, ctx): Promise<SourcePayload | null> {
    const key = ctx.env("API_FOOTBALL_KEY") || ctx.env("FOOTBALL_API_KEY");
    const headers = { "x-apisports-key": key };

    // 1) Resolve the API-Football fixture id (namespaced id, or lookup by
    //    league + date + team names — ESPN event ids do not exist in
    //    API-Football). The lookup is cached per league+date+teams.
    let fixtureId: number | null = null;
    let goals: { home: number | null; away: number | null } | null = null;
    let homeName = match.homeTeam;
    let awayName = match.awayTeam;

    const namespaced = match.eventId.match(/^apif:(\d+)$/i);
    if (namespaced) {
      fixtureId = Number(namespaced[1]);
    } else {
      const resolved = await resolveFixture(match, ctx, headers);
      if (!resolved) {
        ctx.log(`[API-Football] No fixture found for ${match.homeTeam} vs ${match.awayTeam} on ${match.date.slice(0, 10)} — skipping.`);
        return null;
      }
      fixtureId = resolved.fixtureId;
      homeName = resolved.homeName;
      awayName = resolved.awayName;
      goals = resolved.goals;
    }

    // 2) Statistics — two entries (home + away), each with a statistics array.
    const statsUrl = `${BASE}/fixtures/statistics?fixture=${fixtureId}`;
    const statsRes = await ctx.http(statsUrl, { headers, timeoutMs: ctx.timeoutMs });
    if (statsRes.status === "http-error" && statsRes.httpStatus === 403) {
      await handle403(ctx, headers, statsUrl);
      return null;
    }
    if (statsRes.status === "rate-limited") {
      ctx.log("[API-Football] 429 on statistics — backing off (cooldown armed); previously merged results stay cached");
      ctx.reportRateLimit?.("API-Football 429 (statistics)");
      return null;
    }
    if (statsRes.status === "not-found") {
      ctx.log(`[API-Football] Statistics 404 for fixture ${fixtureId} — match may not be covered yet (pre-match data appears on the fixture day)`);
      return null;
    }
    if (statsRes.status !== "ok") return null;

    const entries = asArray(getPath(statsRes.data, "response"));
    if (entries.length < 2) return null;

    const parseTeam = (raw: unknown): PartialTeamStats => {
      const rec = asRecord(raw);
      const out: PartialTeamStats = {};
      let passesAccurate: number | null = null;
      let totalPasses: number | null = null;

      for (const s of asArray(rec?.statistics)) {
        const sr = asRecord(s);
        const type = asString(sr?.type);
        if (!type) continue;
        const field = TYPE_MAP[normKey(type)];
        if (!field) continue;
        const value = valueOf(sr?.value);
        if (value === null) continue;

        if (normKey(type) === "passesaccurate") {
          passesAccurate = value;
          continue;
        }
        if (normKey(type) === "totalpasses") {
          totalPasses = value;
        }
        if (field === "possession" && value > 1 && value <= 100) {
          out.possession = value;
          continue;
        }
        if (out[field] === undefined) out[field] = value;
      }

      // Pass accuracy from the dedicated percentage, else derive it.
      if (out.passAccuracy == null && passesAccurate !== null && totalPasses) {
        out.passAccuracy = pct(passesAccurate, totalPasses);
      }
      if (out.passAccuracy == null && totalPasses !== null && out.passes == null) {
        out.passes = totalPasses;
      }
      return out;
    };

    const homeIdx = entries.findIndex((e) => {
      const rec = asRecord(e);
      const t = asString(getPath(rec, "team.name"));
      return t ? namesMatch(t, homeName) : false;
    });
    const awayIdx = entries.findIndex((e, i) => {
      if (i === homeIdx) return false;
      const rec = asRecord(e);
      const t = asString(getPath(rec, "team.name"));
      return t ? namesMatch(t, awayName) : false;
    });

    const home = parseTeam(entries[homeIdx >= 0 ? homeIdx : 0]);
    const away = parseTeam(entries[awayIdx >= 0 ? awayIdx : 1]);

    // Goals + goals-conceded come from the fixture score (reliable).
    if (goals) {
      home.goals = goals.home;
      away.goals = goals.away;
      home.goalsConceded = goals.away;
      away.goalsConceded = goals.home;
      if (goals.away === 0) home.cleanSheet = true;
      else if (goals.away !== null) home.cleanSheet = false;
      if (goals.home === 0) away.cleanSheet = true;
      else if (goals.home !== null) away.cleanSheet = false;
    }

    // xG per shot (shot quality) when both are present.
    if (home.xg != null && home.shots != null && home.shots > 0) {
      home.xgPerShot = roundTo(home.xg / home.shots, 3);
    }
    if (away.xg != null && away.shots != null && away.shots > 0) {
      away.xgPerShot = roundTo(away.xg / away.shots, 3);
    }

    const hasAny =
      Object.values(home).some((v) => v !== null) ||
      Object.values(away).some((v) => v !== null);
    return hasAny ? { home, away } : null;
  },
};
