// ĞIGI GIVØ — API-Football (api-sports.io) stats normaliser.
//
// Endpoints (https://v3.football.api-sports.io):
//   · /fixtures/statistics?fixture={id}  — per-match stats (LIVE/FINISHED only)
//   · /teams?search={name}               — team name → numeric team id
//   · /teams/statistics?league=&season=&team= — season totals per team
//   · /fixtures?team={id}&last=10        — last 10 finished fixtures (form)
// Key: API_FOOTBALL_KEY (or FOOTBALL_API_KEY) via env.
//
// The most comprehensive live source: when it works it provides nearly every
// per-match stat (xG, shots, SOT, corners, cards, fouls, passes, possession,
// saves, throw-ins, offsides, …).
//
// ─── Match-state routing (pre-match vs finished) ────────────────────────────
// API-Football only publishes match statistics for LIVE and FINISHED
// fixtures. For UPCOMING fixtures /fixtures/statistics returns an empty
// response — querying it can never produce data. So this handler routes on
// the query's match state:
//
//   · state "in" / "post" (or unknown) → the classic path below, which uses
//     /fixtures/statistics. For an explicitly FINISHED match that path is the
//     ONLY one taken — settlement must use the actual match stats, never
//     season averages.
//   · state "pre" → the HISTORICAL path:
//       1. GET /teams?search={teamName}(&league={id}) → team id (cached for
//          30 days — team ids are immutable; misses retried after 24h)
//       2. GET /teams/statistics?league={id}&season={year}&team={teamId} →
//          season totals per team ("Games" = matches played is the
//          denominator; "Ball Possession %" / "Passes Accurate %" are already
//          averages and are kept as-is)
//       3. GET /fixtures?team={teamId}&last=10 → last 10 finished fixtures
//          (W/D/L form, logged)
//     Season totals are divided by matches played → per-match AVERAGES, which
//     are the correct pre-match model inputs (e.g. "1.8 xG per game" is what
//     the engine expects, not a score for a match that has not happened).
//     If the current season has no games yet (season not started), the
//     previous season is used.
//   · state unknown + empty match stats → same historical path (legacy
//     callers that do not pass a state still get pre-match data instead of a
//     silent synthetic fallback).
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

/**
 * API base, read lazily so env loaded after module init (dotenv in scripts)
 * still applies. Overridable via API_FOOTBALL_BASE (tests / local proxies).
 */
function base(): string {
  return (process.env.API_FOOTBALL_BASE ?? "").trim() || "https://v3.football.api-sports.io";
}

/** Stat fields API-Football can fill. Per-match fields come from
 * `/fixtures/statistics` (live/finished matches); the historical averages
 * (`avgCornersPerGame`, `avgCardsPerGame`) come from the pre-match
 * `/teams/statistics` path. */
export const API_FOOTBALL_CAPABILITIES: StatField[] = [
  "goals", "xg", "xgPerShot", "shots", "shotsOnTarget", "shotsOffTarget",
  "blockedShots", "corners", "goalKicks", "throwIns", "freeKicks", "penalties",
  "yellowCards", "redCards", "fouls", "offsides", "possession", "passes",
  "passAccuracy", "saves", "goalsConceded", "cleanSheet", "dribbling",
  "aerialBattlesWon", "interceptions", "tackles", "clearances",
  "avgCornersPerGame", "avgCardsPerGame",
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
  /**
   * The lookup hit a 429 or a rate-limit-classified 403. Callers must back off
   * (the cooldown is armed) instead of falling through to the pre-match
   * endpoints.
   */
  rateLimited?: boolean;
  /**
   * The lookup hit a hard 403 (invalid key / plan restriction). Every
   * endpoint would 403 the same way, so callers skip the remaining calls for
   * this pass (no rate-limit cooldown — fixing the key, not backing off, is
   * the remedy).
   */
  rejected?: boolean;
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
 *
 * Returns true when the 403 was classified as a RATE LIMIT (the caller then
 * treats the source as rate-limited: cooldown armed, no further endpoints).
 * Any other 403 (invalid key / plan / unknown) is a hard REJECTION — every
 * endpoint would 403 the same way, so callers skip the rest of their calls
 * for this pass without arming a rate-limit cooldown.
 */
async function handle403(
  ctx: SourceContext,
  headers: Record<string, string>,
  url: string,
): Promise<boolean> {
  const body = await fetchErrorBody(url, headers, 8_000);
  ctx.log(`[API-Football] 403 from ${url} — response body: ${body ?? "<empty body; host answered but no payload>"}`);
  if (!body) return false;
  if (/invalid api key|api key not (?:found|valid)|no (?:such|valid) key/i.test(body)) {
    ctx.log("[API-Football] 403 classification: INVALID OR EXPIRED KEY — set a valid API_FOOTBALL_KEY in .env.local (get one at https://dashboard.api-sports.io)");
    return false;
  }
  if (/plan|subscription|upgrade|premium|not (?:available|included)/i.test(body)) {
    ctx.log("[API-Football] 403 classification: PLAN RESTRICTION — this endpoint is not available on the current plan (check quota at https://dashboard.api-sports.io)");
    return false;
  }
  if (RATE_LIMIT_BODY_RE.test(body)) {
    ctx.log("[API-Football] 403 classification: RATE LIMIT — backing off (cooldown armed); previously merged results stay cached and are served meanwhile");
    ctx.reportRateLimit?.("API-Football 403 quota (daily/hourly requests)");
    return true;
  }
  ctx.log("[API-Football] 403 classification: UNKNOWN — see body above; run GET /api/diagnostics/data-sources for the full key check");
  return false;
}

// ─── Fixture id resolution (ESPN id → API-Football fixture id) ───────────────

async function resolveFixture(
  match: MatchStatsQuery,
  ctx: SourceContext,
  headers: Record<string, string>,
): Promise<{ fixture: ResolvedFixture | null; rateLimited: boolean; rejected: boolean }> {
  const ck = resolutionCacheKey(match);
  const cached = fixtureIdCache.get(ck);
  if (cached) {
    const ttl = cached.hit ? RESOLUTION_CACHE_TTL_MS : RESOLUTION_NEGATIVE_TTL_MS;
    if (Date.now() - cached.at < ttl) {
      if (cached.hit) {
        ctx.log(`[API-Football] Using cached fixture id ${cached.hit.fixtureId} for ${cached.hit.homeName} vs ${cached.hit.awayName}`);
        return { fixture: cached.hit, rateLimited: false, rejected: false };
      }
      const retryIn = Math.max(0, Math.round((ttl - (Date.now() - cached.at)) / 1000));
      ctx.log(`[API-Football] Cached negative fixture lookup for ${match.homeTeam} vs ${match.awayTeam} — skipping (retry in ${retryIn}s)`);
      // A cached 429/rate-limit miss is still "backed off" — re-report so the
      // aggregator's cooldown stays armed and no fallback endpoints are hit.
      if (cached.rateLimited) ctx.reportRateLimit?.("API-Football 403/429 (cached fixture lookup)");
      return { fixture: null, rateLimited: Boolean(cached.rateLimited), rejected: Boolean(cached.rejected) };
    }
  }

  const day = match.date.slice(0, 10);
  const leagueId = LEAGUE_IDS[match.leagueSlug];
  const season = footballSeason(match.date);

  // Narrowed first (league + season), then relaxed, then date-only fallback.
  const urls: string[] =
    leagueId != null
      ? [
          `${base()}/fixtures?date=${day}&league=${leagueId}&season=${season}`,
          `${base()}/fixtures?date=${day}&league=${leagueId}`,
          `${base()}/fixtures?date=${day}`,
        ]
      : [`${base()}/fixtures?date=${day}`];

  let saw403 = false;
  let rateLimited = false;
  let rejected = false;
  let hit: ResolvedFixture | null = null;

  for (const url of urls) {
    const res = await ctx.http(url, { headers, timeoutMs: ctx.timeoutMs });
    if (res.status === "http-error" && res.httpStatus === 403) {
      if (!saw403) {
        saw403 = true;
        // true = rate-limit quota, false = invalid key / plan / unknown
        if (await handle403(ctx, headers, url)) rateLimited = true;
        else rejected = true;
      } // further 403s repeat the same body — no new information
      continue;
    }
    if (res.status === "rate-limited") {
      rateLimited = true;
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
    fixtureIdCache.set(ck, { at: Date.now(), hit });
    return { fixture: hit, rateLimited: false, rejected: false };
  }
  fixtureIdCache.set(ck, { at: Date.now(), hit: null, rateLimited, rejected });
  return { fixture: null, rateLimited, rejected };
}

// ─── Team id resolution (team name → API-Football team id) ───────────────────

interface TeamIdCacheEntry {
  at: number;
  teamId: number | null;
}

/** Team ids are immutable — cache hits for 30 days. */
const TEAM_ID_TTL_MS = 30 * 24 * 60 * 60_000;
/** Misses are retried every 24h (the API's team catalogue can grow). */
const TEAM_ID_NEGATIVE_TTL_MS = 24 * 60 * 60_000;

const teamIdCache = new Map<string, TeamIdCacheEntry>();

/** Clear the team-id cache (tests / manual refresh). */
export function clearTeamIdCache(): void {
  teamIdCache.clear();
}

/**
 * Resolve a team name to its API-Football team id via
 * GET /teams?search={name}(&league={id}). When a league id is known the
 * search is narrowed to that league, which makes the first result safe even
 * for oddly-spelled names. Hits and misses are cached per league +
 * normalised name.
 */
async function resolveTeamId(
  teamName: string,
  leagueId: number | undefined,
  ctx: SourceContext,
  headers: Record<string, string>,
): Promise<number | null> {
  const ck = `${leagueId ?? "any"}|${normalizeName(teamName)}`;
  const cached = teamIdCache.get(ck);
  if (cached) {
    const ttl = cached.teamId != null ? TEAM_ID_TTL_MS : TEAM_ID_NEGATIVE_TTL_MS;
    if (Date.now() - cached.at < ttl) {
      if (cached.teamId != null) {
        ctx.log(`[API-Football] Using cached team id ${cached.teamId} for ${teamName}`);
      }
      return cached.teamId;
    }
  }

  const params = [`search=${encodeURIComponent(teamName)}`];
  if (leagueId != null) params.push(`league=${leagueId}`);
  const url = `${base()}/teams?${params.join("&")}`;
  const res = await ctx.http(url, { headers, timeoutMs: ctx.timeoutMs });

  if (res.status === "http-error" && res.httpStatus === 403) {
    await handle403(ctx, headers, url);
    return null;
  }
  if (res.status === "rate-limited") {
    ctx.log("[API-Football] 429 on team search — backing off (cooldown armed); previously merged results stay cached");
    ctx.reportRateLimit?.("API-Football 429 (team search)");
    return null;
  }
  if (res.status !== "ok") return null;

  const candidates = asArray(getPath(res.data, "response"))
    .map(asRecord)
    .filter((r): r is Record<string, unknown> => r !== null);
  const exact = candidates.find((c) => namesMatch(getPath(c, "team.name"), teamName));
  // League-narrowed searches only return teams of that league, so the first
  // result is an acceptable fallback. Cross-league searches must still
  // match the requested name.
  const hit = exact ?? (leagueId != null ? candidates[0] : null);
  const teamId = asNumber(getPath(hit, "team.id"));

  if (teamId !== null) {
    const resolvedName = asString(getPath(hit, "team.name")) ?? teamName;
    ctx.log(`[API-Football] Resolved team ${resolvedName} → id ${teamId}`);
  } else {
    ctx.log(`[API-Football] Team search returned no usable id for ${teamName}`);
  }
  teamIdCache.set(ck, { at: Date.now(), teamId });
  return teamId;
}

// ─── Pre-match historical stats (upcoming fixtures) ──────────────────────────

/**
 * One team's season totals from /teams/statistics. `totals` holds SEASON
 * TOTALS (divided by `games` for per-match averages); `possession` and
 * `passAccuracy` are already percentages and are kept as-is.
 */
interface TeamSeasonTotals {
  season: number;
  games: number;
  goalsFor: number | null;
  goalsAgainst: number | null;
  cleanSheets: number | null;
  form: string | null;
  possession: number | null;
  passAccuracy: number | null;
  passesAccurate: number | null;
  totals: Partial<Record<StatKey, number>>;
}

/** Season-level statistic label → TeamStats field (normKey of `type`). */
const SEASON_TYPE_MAP: Record<string, StatKey> = {
  expectedgoalsxg: "xg",
  expectedgoals: "xg",
  xg: "xg",
  totalshots: "shots",
  shotsongoal: "shotsOnTarget",
  shotsoffgoal: "shotsOffTarget",
  blockedshots: "blockedShots",
  cornerkicks: "corners",
  goalkicks: "goalKicks",
  throwins: "throwIns",
  freekicks: "freeKicks",
  // The team season view reports penalty conversions, not "penalties won";
  // penalty goals per match is the closest real per-match figure available.
  penaltygoals: "penalties",
  yellowcards: "yellowCards",
  redcards: "redCards",
  fouls: "fouls",
  offsides: "offsides",
  totalpasses: "passes",
  goalkeepersaves: "saves",
  keepersaves: "saves",
  dribblessuccessful: "dribbling",
  dribbles: "dribbling",
  aerialswon: "aerialBattlesWon",
  aerials: "aerialBattlesWon",
  aerialduelswon: "aerialBattlesWon",
  interceptions: "interceptions",
  tackles: "tackles",
  clearances: "clearances",
};

/** Parse /teams/statistics `response[0]`. Null when it carries no usable data. */
function parseTeamSeasonTotals(data: unknown): TeamSeasonTotals | null {
  const rec = asRecord(asArray(getPath(data, "response"))[0]);
  if (!rec) return null;

  const totals: Partial<Record<StatKey, number>> = {};
  let games = 0;
  let goalsFor: number | null = null;
  let goalsAgainst: number | null = null;
  let cleanSheets: number | null = null;
  let form: string | null = null;
  let possession: number | null = null;
  let passAccuracy: number | null = null;
  let passesAccurate: number | null = null;

  for (const s of asArray(rec.statistics)) {
    const sr = asRecord(s);
    const type = asString(sr?.type);
    if (!type) continue;
    const key = normKey(type);
    const value = asNumber(sr?.value);
    if (value === null) continue;
    // "Passes Accurate %" and "Passes Accurate" normalise to the SAME key
    // (normKey strips the "%"); the raw label's % suffix is the only way to
    // tell the percentage apart from the count. Same for "Ball Possession %".
    const isPercent = /\s%$/.test(type.trim());

    if (key === "games") { games = value; continue; }
    if (key === "goals") { goalsFor = value; continue; }
    if (key === "goalsconceded") { goalsAgainst = value; continue; }
    if (key === "gamescleansheet") { cleanSheets = value; continue; }
    if (key === "form") { form = asString(sr?.value); continue; }
    if (key === "ballpossession") { possession = value; continue; }
    if (key === "passesaccurate") {
      if (isPercent) passAccuracy = value;
      else passesAccurate = value;
      continue;
    }

    const field = SEASON_TYPE_MAP[key];
    if (field && totals[field] === undefined) totals[field] = value;
  }

  if (games <= 0) return null;
  return {
    season: asNumber(getPath(rec, "season")) ?? 0,
    games,
    goalsFor,
    goalsAgainst,
    cleanSheets,
    form,
    possession,
    passAccuracy,
    passesAccurate,
    totals,
  };
}

/** Season totals → per-match AVERAGES (the correct pre-match model inputs). */
function seasonTotalsToPerMatch(totals: TeamSeasonTotals): PartialTeamStats {
  const g = totals.games;
  const per = (v: number | null | undefined): number | null =>
    v == null ? null : roundTo(v / g, 2);

  const out: PartialTeamStats = {
    goals: per(totals.goalsFor),
    goalsConceded: per(totals.goalsAgainst),
    xg: per(totals.totals.xg),
    shots: per(totals.totals.shots),
    shotsOnTarget: per(totals.totals.shotsOnTarget),
    shotsOffTarget: per(totals.totals.shotsOffTarget),
    blockedShots: per(totals.totals.blockedShots),
    corners: per(totals.totals.corners),
    goalKicks: per(totals.totals.goalKicks),
    throwIns: per(totals.totals.throwIns),
    freeKicks: per(totals.totals.freeKicks),
    penalties: per(totals.totals.penalties),
    yellowCards: per(totals.totals.yellowCards),
    redCards: per(totals.totals.redCards),
    fouls: per(totals.totals.fouls),
    offsides: per(totals.totals.offsides),
    possession: totals.possession != null ? roundTo(totals.possession, 1) : null,
    passes: per(totals.totals.passes),
    passAccuracy:
      totals.passAccuracy != null
        ? roundTo(totals.passAccuracy, 1)
        : totals.passesAccurate != null && totals.totals.passes
          ? pct(totals.passesAccurate, totals.totals.passes, 1)
          : null,
    saves: per(totals.totals.saves),
    dribbling: per(totals.totals.dribbling),
    aerialBattlesWon: per(totals.totals.aerialBattlesWon),
    interceptions: per(totals.totals.interceptions),
    tackles: per(totals.totals.tackles),
    clearances: per(totals.totals.clearances),
    // Historical context (season averages) — same denominator as the rest.
    avgCornersPerGame: per(totals.totals.corners),
    avgCardsPerGame:
      totals.totals.yellowCards == null && totals.totals.redCards == null
        ? null
        : per((totals.totals.yellowCards ?? 0) + (totals.totals.redCards ?? 0)),
  };

  if (out.xg != null && out.shots != null && out.shots > 0) {
    out.xgPerShot = roundTo(out.xg / out.shots, 3);
  }
  return out;
}

/**
 * Last 10 FINISHED fixtures for a team (GET /fixtures?team=&last=10),
 * reduced to a W/D/L record and logged. Fail-soft: null on any problem.
 */
async function fetchLast10Form(
  teamId: number,
  teamName: string,
  ctx: SourceContext,
  headers: Record<string, string>,
): Promise<{ wins: number; draws: number; losses: number } | null> {
  const url = `${base()}/fixtures?team=${teamId}&last=10`;
  const res = await ctx.http(url, { headers, timeoutMs: ctx.timeoutMs });

  if (res.status === "http-error" && res.httpStatus === 403) {
    await handle403(ctx, headers, url);
    return null;
  }
  if (res.status === "rate-limited") {
    ctx.log("[API-Football] 429 on last-10 form — backing off (cooldown armed); previously merged results stay cached");
    ctx.reportRateLimit?.("API-Football 429 (last-10 form)");
    return null;
  }
  if (res.status !== "ok") return null;

  let wins = 0;
  let draws = 0;
  let losses = 0;
  for (const item of asArray(getPath(res.data, "response"))) {
    const rec = asRecord(item);
    if (!rec) continue;
    const homeGoals = asNumber(getPath(rec, "goals.home"));
    const awayGoals = asNumber(getPath(rec, "goals.away"));
    if (homeGoals === null || awayGoals === null) continue; // not finished

    const homeId = asNumber(getPath(rec, "teams.home.id"));
    const awayId = asNumber(getPath(rec, "teams.away.id"));
    let isHome: boolean | null = null;
    if (homeId === teamId) isHome = true;
    else if (awayId === teamId) isHome = false;
    else if (namesMatch(getPath(rec, "teams.home.name"), teamName)) isHome = true;
    else if (namesMatch(getPath(rec, "teams.away.name"), teamName)) isHome = false;
    if (isHome === null) continue;

    const teamGoals = isHome ? homeGoals : awayGoals;
    const oppGoals = isHome ? awayGoals : homeGoals;
    if (teamGoals > oppGoals) wins++;
    else if (teamGoals === oppGoals) draws++;
    else losses++;
  }

  const played = wins + draws + losses;
  if (played === 0) return null;
  ctx.log(`[API-Football] Last 10: ${wins}W ${draws}D ${losses}L`);
  return { wins, draws, losses };
}

/**
 * Pre-match historical stats for ONE team:
 *   1. team id          — GET /teams?search={name} (cached 30 days)
 *   2. season totals    — GET /teams/statistics?league=&season=&team=
 *                         (previous season when the current one has no games)
 *   3. last-10 form     — GET /fixtures?team=&last=10 (logged)
 * Returns per-match AVERAGES (PartialTeamStats) — never match results, since
 * the fixture has not been played. Null when no season data is available.
 */
async function fetchPreMatchTeamStats(
  teamName: string,
  leagueId: number | undefined,
  season: number,
  ctx: SourceContext,
  headers: Record<string, string>,
): Promise<PartialTeamStats | null> {
  const teamId = await resolveTeamId(teamName, leagueId, ctx, headers);
  if (teamId === null) {
    ctx.log(`[API-Football] No team stats found for ${teamName} (team id could not be resolved)`);
    return null;
  }

  let totals: TeamSeasonTotals | null = null;
  for (const s of [season, season - 1]) {
    const params = [`team=${teamId}`, `season=${s}`];
    if (leagueId != null) params.push(`league=${leagueId}`);
    const url = `${base()}/teams/statistics?${params.join("&")}`;
    const res = await ctx.http(url, { headers, timeoutMs: ctx.timeoutMs });
    if (res.status === "http-error" && res.httpStatus === 403) {
      await handle403(ctx, headers, url);
      return null;
    }
    if (res.status === "rate-limited") {
      ctx.log("[API-Football] 429 on season stats — backing off (cooldown armed); previously merged results stay cached");
      ctx.reportRateLimit?.("API-Football 429 (season stats)");
      return null;
    }
    if (res.status !== "ok") continue; // 404/5xx for that season → previous one
    totals = parseTeamSeasonTotals(res.data);
    if (totals !== null) break;
    ctx.log(`[API-Football] No season statistics with games played for ${teamName} (season ${s}) — trying previous season`);
  }
  if (totals === null) {
    ctx.log(`[API-Football] No team stats found for ${teamName}`);
    return null;
  }

  // Last 10 finished fixtures (form) — logged, fail-soft, never fatal.
  await fetchLast10Form(teamId, teamName, ctx, headers);

  const perMatch = seasonTotalsToPerMatch(totals);
  const fmt = (v: number | null | undefined): string => (v == null ? "n/a" : v.toFixed(1));
  ctx.log(
    `[API-Football] Season stats for ${teamName}: ${fmt(perMatch.corners)} corners, ` +
    `${fmt(perMatch.fouls)} fouls, ${fmt(perMatch.xg)} xG ` +
    `(${totals.games} games, season ${totals.season || season}${totals.form ? `, form ${totals.form}` : ""})`,
  );
  return perMatch;
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

  const url = `${base()}/status`;
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

    // Pre-match: /fixtures/statistics carries no data for fixtures that have
    // not been played yet, so build the model from historical team stats
    // (/teams?search → /teams/statistics → /fixtures?team=&last=10).
    if (match.state === "pre") {
      return fetchPreMatchPayload(match, ctx, headers);
    }

    const { payload, rateLimited, rejected } = await fetchMatchStats(match, ctx, headers);
    if (payload) return payload;

    // The key is unusable for this pass (quota 403/429, invalid key, plan
    // restriction) — the historical endpoints would fail the same way, so
    // back off instead of burning more requests.
    if (rateLimited) {
      ctx.log("[API-Football] Rate-limited on match statistics — skipping the historical fallback for this pass (cooldown armed)");
      return null;
    }
    if (rejected) {
      ctx.log("[API-Football] Key rejected on match statistics — skipping the historical fallback (every endpoint would 403 the same way)");
      return null;
    }

    // No match statistics (typical for a fixture that has not been played).
    // Callers that omit the state get the historical fallback. An explicitly
    // FINISHED match never substitutes season averages for its real match
    // stats — settlement wants the actual result.
    if (match.state !== "post") {
      ctx.log("[API-Football] No match statistics for this fixture — falling back to pre-match historical team stats");
      return fetchPreMatchPayload(match, ctx, headers);
    }
    return null;
  },
};

// ─── Per-match stats (live / finished fixtures) ──────────────────────────────

/**
 * Per-match stats for a live/finished fixture:
 *   1) Resolve the API-Football fixture id (namespaced id, or lookup by
 *      league + date + team names — ESPN event ids do not exist in
 *      API-Football). The lookup is cached per league+date+teams.
 *   2) GET /fixtures/statistics?fixture={fixtureId}
 *
 * Returns the payload plus the failure classification when it is null:
 * `rateLimited` (429 / quota 403 → back off, cooldown armed) and `rejected`
 * (invalid key / plan 403 → every endpoint would 403 the same way). Both
 * suppress the pre-match historical fallback, which could not do better.
 */
async function fetchMatchStats(
  match: MatchStatsQuery,
  ctx: SourceContext,
  headers: Record<string, string>,
): Promise<{
  payload: SourcePayload | null;
  rateLimited: boolean;
  rejected: boolean;
}> {
    const none = { payload: null as SourcePayload | null, rateLimited: false, rejected: false };
    let fixtureId: number | null = null;
    let goals: { home: number | null; away: number | null } | null = null;
    let homeName = match.homeTeam;
    let awayName = match.awayTeam;

    const namespaced = match.eventId.match(/^apif:(\d+)$/i);
    if (namespaced) {
      fixtureId = Number(namespaced[1]);
    } else {
      const { fixture, rateLimited, rejected } = await resolveFixture(match, ctx, headers);
      if (!fixture) {
        ctx.log(`[API-Football] No fixture found for ${match.homeTeam} vs ${match.awayTeam} on ${match.date.slice(0, 10)} — skipping.`);
        return { payload: null, rateLimited, rejected };
      }
      fixtureId = fixture.fixtureId;
      homeName = fixture.homeName;
      awayName = fixture.awayName;
      goals = fixture.goals;
    }

    // 2) Statistics — two entries (home + away), each with a statistics array.
    const statsUrl = `${base()}/fixtures/statistics?fixture=${fixtureId}`;
    const statsRes = await ctx.http(statsUrl, { headers, timeoutMs: ctx.timeoutMs });
    if (statsRes.status === "http-error" && statsRes.httpStatus === 403) {
      if (await handle403(ctx, headers, statsUrl)) {
        return { payload: null, rateLimited: true, rejected: false };
      }
      return { payload: null, rateLimited: false, rejected: true };
    }
    if (statsRes.status === "rate-limited") {
      ctx.log("[API-Football] 429 on statistics — backing off (cooldown armed); previously merged results stay cached");
      ctx.reportRateLimit?.("API-Football 429 (statistics)");
      return { payload: null, rateLimited: true, rejected: false };
    }
    if (statsRes.status === "not-found") {
      ctx.log(`[API-Football] Statistics 404 for fixture ${fixtureId} — match may not be covered yet (pre-match data appears on the fixture day)`);
      return none;
    }
    if (statsRes.status !== "ok") return none;

    const entries = asArray(getPath(statsRes.data, "response"));
    if (entries.length < 2) return none;

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
    return hasAny
      ? { payload: { home, away }, rateLimited: false, rejected: false }
      : none;
}

// ─── Pre-match payload (upcoming fixtures) ───────────────────────────────────

/**
 * Pre-match payload for both teams, built from historical data:
 *   1. GET /teams?search={name}(&league={id})        → team id (cached 30d)
 *   2. GET /teams/statistics?league=&season=&team=   → season totals
 *   3. GET /fixtures?team={id}&last=10               → last-10 form (logged)
 * Season totals are converted to per-match averages. Returns a payload when
 * at least one team produced data; null only when both teams failed.
 */
async function fetchPreMatchPayload(
  match: MatchStatsQuery,
  ctx: SourceContext,
  headers: Record<string, string>,
): Promise<SourcePayload | null> {
  const leagueId = LEAGUE_IDS[match.leagueSlug];
  const season = footballSeason(match.date);

  const [home, away] = await Promise.all([
    fetchPreMatchTeamStats(match.homeTeam, leagueId, season, ctx, headers),
    fetchPreMatchTeamStats(match.awayTeam, leagueId, season, ctx, headers),
  ]);

  const hasAny =
    (home && Object.values(home).some((v) => v !== null && v !== undefined)) ||
    (away && Object.values(away).some((v) => v !== null && v !== undefined));
  if (!hasAny) {
    ctx.log(`[API-Football] No pre-match team stats for ${match.homeTeam} vs ${match.awayTeam} — skipping.`);
    return null;
  }
  return { home: home ?? {}, away: away ?? {} };
}
