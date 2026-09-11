// ĞIGI GIVØ — Multi-source Data Stats Aggregator.
//
// Fetches canonical match statistics from a priority-ordered chain of external
// sources, merging every source's partial result into one CanonicalMatchStats.
// The design goals, in order of importance:
//
//   1. NO MOCK DATA — a stat not provided by any source stays `null`.
//   2. FAIL-SOFT — a source timing out / erroring is skipped; the rest keep
//      going. One broken source can never crash match processing.
//   3. AGGRESSIVE CACHING — successful merges are cached (default 2h) and
//      rate-limited sources enter a cooldown (default 5 min), so repeated
//      requests and rate limits are respected.
//
// Merge rule: sources are walked in priority order and every field is filled
// on a FIRST-WINS basis — a higher-priority source's value can never be
// overwritten by a lower-priority one. If API-Football (the most comprehensive
// live source) contributes every per-match stat, the walk breaks early.
//
// OBSERVABILITY: every source attempt is logged AND recorded in the returned
// `attempts` trace, with the *reason* it produced nothing — cooldown, missing
// API key, league not covered, HTTP timeout/404/500, or a blocked network.
// "no data" and "egress blocked" look identical downstream (both yield a
// synthetic-baseline match), so the trace must tell them apart; see
// docs/NETWORK_ALLOWLIST.md and GET /api/diagnostics/connectivity.
//
// At the end of EVERY walk a summary line is logged and stored for
// GET /api/diagnostics/data-sources (diagnostics.perSourceFailures):
//
//   [aggregator] eng.1:401879288 — 11 sources tried.
//     Failed: API-Football (403), FBref (403), TheSportsDB (no key), … → SYNTHETIC
//
// so a silent synthetic fallback can never happen again: every skipped or
// failed source is named with its exact reason.

import { fetchWithTimeout, type HttpResult } from "./http";
import { SOURCE_HANDLERS } from "./sources";
import type { SourceContext, SourceHandler } from "./sources/context";
import {
  BOOLEAN_FIELDS,
  MATCH_STAT_FIELDS,
  STAT_FIELDS,
  emptyCanonicalMatchStats,
  nonNullFieldCount,
  type BooleanKey,
  type CanonicalMatchStats,
  type MatchStatsQuery,
  type SourcePayload,
  type StatKey,
  type StatSourceName,
} from "./types";

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * Source priority, highest first. First-wins merging means an earlier source's
 * value is never overwritten, so this order IS the data-quality policy:
 *
 *   1. SportScore      — no key, broadest live coverage
 *   2. API-Football    — keyed, most complete per-match stat set
 *   3. StatsBomb       — open data, no key
 *   4. datafc          — optional keyed/self-hosted endpoint
 *   5. worldcup2026    — tournament-scoped supplement
 *   6. FBref           — scraped advanced stats (needs `fbref:`-namespaced ids)
 *   7. TheSportsDB     — keyed tier
 *   8. Understat       — xG, Big-5 leagues only
 *   9. OpenLigaDB      — German leagues only
 *  10. Highlightly     — keyed
 *  11. GitHubDatasets  — historical, last resort
 *
 * League-scoped sources (Understat, OpenLigaDB) sit after the general ones:
 * their `available()` gate rejects every other league anyway, and where both
 * apply Understat's xG coverage is the richer signal.
 */
const DEFAULT_PRIORITY: StatSourceName[] = [
  "SportScore", "API-Football", "StatsBomb", "datafc",
  "worldcup2026", "FBref", "TheSportsDB",
  "Understat", "OpenLigaDB", "Highlightly", "GitHubDatasets",
];

/**
 * Env vars that gate a source. Used ONLY to explain why `available()` returned
 * false — "key missing (API_FOOTBALL_KEY)" vs "not applicable to this league"
 * are two completely different failures with two completely different fixes.
 *
 * Note: TheSportsDB is deliberately NOT listed — the handler falls back to
 * the public free test key "3" when THESPORTSDB_KEY is unset, so a missing
 * env var is a rate-limit situation, never a hard skip.
 */
const SOURCE_ENV_REQUIREMENTS: Partial<Record<StatSourceName, string[]>> = {
  "API-Football": ["API_FOOTBALL_KEY", "FOOTBALL_API_KEY"],
  "Highlightly": ["HIGHLIGHTLY_KEY"],
  "datafc": ["DATAFCC_ENDPOINT"],
};

/**
 * Per-source fetch budget. 12s matches the HTTP layer default; raise it via
 * STATS_SOURCE_TIMEOUT_MS only if sources are legitimately slow — a longer
 * budget means a hung source stalls the whole fixture feed for longer.
 */
const DEFAULT_SOURCE_TIMEOUT_MS = Number(process.env.STATS_SOURCE_TIMEOUT_MS) || 12_000;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_CACHE_TTL_MS = 2 * 60 * 60_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StatsAggregatorOptions {
  /** Replace/override specific source handlers (used by tests). */
  handlers?: Partial<Record<StatSourceName, SourceHandler>>;
  /** Per-source fetch timeout budget. */
  sourceTimeoutMs?: number;
  /** Cooldown armed after a source returns 429. */
  rateLimitCooldownMs?: number;
  /** How long a successful merged result is cached. */
  cacheTtlMs?: number;
  /** Log sink (defaults to console.log). */
  log?: (message: string) => void;
}

export interface StatsFetchOptions {
  /** Override the source priority for a single call (e.g. GitHub-first backfill). */
  priority?: string[];
  /** Bypass the cache and force a fresh multi-source walk. */
  force?: boolean;
}

/** One outbound HTTP call a source made, as the aggregator saw it. */
export interface SourceHttpCall {
  /** Host + path (query string kept — it carries the fixture/league lookup). */
  url: string;
  /** Typed outcome from the fail-soft HTTP layer. */
  status: HttpResult["status"];
  /** Real HTTP status when a response was received, else null. */
  httpStatus: number | null;
  /** Wall-clock ms for the call. */
  ms: number;
}

/** One source attempt, for the per-match monitoring trace. */
export interface SourceAttempt {
  source: string;
  status: "ok" | "unavailable" | "cooldown" | "empty" | "error";
  fields: number;
  detail?: string;
  /**
   * Machine-readable cause: `no-handler`, `cooldown`, `key-missing`,
   * `not-applicable`, `network-error`, `timeout`, `http-error`,
   * `rate-limited`, `no-requests`, `empty-payload`, `handler-threw`.
   */
  reason?: string;
  /** Every HTTP call the handler made (empty when it bailed before fetching). */
  http?: SourceHttpCall[];
}

export interface StatsFetchResult {
  stats: CanonicalMatchStats | null;
  cacheKey: string;
  attempts: SourceAttempt[];
  /** Which source filled each home/away field (observability). */
  fieldSources: Partial<Record<StatKey, string>>;
}

// ─── Diagnostics (per-source health + last-walk failure trace) ───────────────

/**
 * One source's failure from the LAST walk, compact enough to embed in the API
 * response (diagnostics.perSourceFailures) and in the end-of-walk log line.
 */
export interface SourceFailureRecord {
  source: string;
  /** Machine-readable cause (see SourceAttempt.reason). */
  reason: string;
  /** Compact label for logs/UI: "403", "no key", "not covered", … */
  short: string;
  /** Human-readable detail (the exact reason this source produced nothing). */
  detail: string;
  /** Real HTTP status when the failure involved a response, else null. */
  httpStatus: number | null;
  /** ISO timestamp of the attempt. */
  at: string;
}

/** Per-source health as observed by the aggregator in THIS process. */
export interface SourceHealthRecord {
  source: string;
  priority: number;
  registered: boolean;
  requiresEnv: string[];
  /** null = unkeyed source; false = required env var(s) unset. */
  keyPresent: boolean | null;
  coolingDown: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastSuccessFields: number | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  lastFailureShort: string | null;
  lastFailureHttpStatus: number | null;
  /**
   * Last time ANY HTTP response (any status — even 403/404) was received from
   * the host: proof the host answered, as opposed to a blocked egress path.
   */
  lastReachableAt: string | null;
}

/** Snapshot of the aggregator's observability state (the debug endpoint). */
export interface AggregatorDiagnostics {
  lastWalkAt: string | null;
  lastCacheKey: string | null;
  lastOutcome: "real-data" | "synthetic" | null;
  lastPrimarySource: string | null;
  lastFieldCount: number | null;
  /** Failures recorded during the last walk — exposed as diagnostics.perSourceFailures. */
  perSourceFailures: SourceFailureRecord[];
  sources: SourceHealthRecord[];
}

/** Compact label for a failed attempt — drives the "Source (reason)" log list. */
function shortReason(a: SourceAttempt): string {
  const httpStatus = a.http?.find((c) => c.httpStatus !== null)?.httpStatus ?? null;
  switch (a.reason) {
    case "key-missing": return "no key";
    case "cooldown": return "cooldown";
    case "not-applicable": return "not covered";
    case "no-handler": return "no handler";
    case "no-requests": return "id unresolved";
    case "timeout": return "timeout";
    case "network-error": return "network error";
    case "rate-limited": return httpStatus === 403 ? "403 rate limit" : "rate-limited";
    case "handler-threw": return "threw";
    case "http-error": return httpStatus !== null ? String(httpStatus) : "http error";
    case "empty-payload": return "no data";
    default: return a.status;
  }
}

// ─── Merge helpers ────────────────────────────────────────────────────────────

function mergePayload(
  target: CanonicalMatchStats,
  payload: SourcePayload,
  source: string,
  contributions: Map<string, number>,
  fieldSources: Partial<Record<StatKey, string>>,
): number {
  let filled = 0;

  for (const key of STAT_FIELDS) {
    const hv = payload.home[key];
    if (hv !== null && hv !== undefined && target.home[key] === null) {
      (target.home[key] as number | null) = hv;
      contributions.set(source, (contributions.get(source) ?? 0) + 1);
      fieldSources[key] = source;
      filled++;
    }
    const av = payload.away[key];
    if (av !== null && av !== undefined && target.away[key] === null) {
      (target.away[key] as number | null) = av;
      contributions.set(source, (contributions.get(source) ?? 0) + 1);
      fieldSources[key] = source;
      filled++;
    }
  }

  for (const key of BOOLEAN_FIELDS) {
    const hv = payload.home[key];
    if (hv !== null && hv !== undefined && target.home[key] === null) {
      (target.home[key] as boolean | null) = hv;
      contributions.set(source, (contributions.get(source) ?? 0) + 1);
      filled++;
    }
    const av = payload.away[key];
    if (av !== null && av !== undefined && target.away[key] === null) {
      (target.away[key] as boolean | null) = av;
      contributions.set(source, (contributions.get(source) ?? 0) + 1);
      filled++;
    }
  }

  return filled;
}

/** Every per-match stat (both teams) filled — i.e. historical averages aside. */
function isComplete(stats: CanonicalMatchStats): boolean {
  for (const key of MATCH_STAT_FIELDS) {
    if (stats.home[key] === null || stats.away[key] === null) return false;
  }
  return stats.home.cleanSheet !== null && stats.away.cleanSheet !== null;
}

/** Total fillable slots, both teams — the denominator for the log's `n/total`. */
const TOTAL_STAT_SLOTS = (STAT_FIELDS.length + BOOLEAN_FIELDS.length) * 2;

// ─── Failure attribution ──────────────────────────────────────────────────────

/** Env vars a source needs that are currently unset ("" counts as unset). */
function missingEnvVars(source: string): string[] {
  const required = SOURCE_ENV_REQUIREMENTS[source as StatSourceName] ?? [];
  return required.filter((name) => (process.env[name] ?? "").trim().length === 0);
}

/** Compact render of a source's HTTP calls, e.g. `2 calls: network-error ×2`. */
function httpSummary(calls: SourceHttpCall[]): string {
  if (calls.length === 0) return "0 requests";
  const counts = new Map<string, number>();
  for (const call of calls) {
    const label = call.httpStatus !== null ? `${call.status} ${call.httpStatus}` : call.status;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const rendered = [...counts.entries()]
    .map(([label, n]) => (n > 1 ? `${label} ×${n}` : label))
    .join(", ");
  return `${calls.length} request${calls.length > 1 ? "s" : ""}: ${rendered}`;
}

/**
 * Work out WHY a source produced nothing, from the HTTP calls it actually made.
 * This is the difference between "the league has no data" and "egress to the
 * data source is blocked" — the two are otherwise indistinguishable.
 */
function describeFailure(
  calls: SourceHttpCall[],
  error?: string,
): { reason: string; detail: string } {
  if (error) return { reason: "handler-threw", detail: `handler threw: ${error}` };

  if (calls.length === 0) {
    return {
      reason: "no-requests",
      detail:
        "handler made no HTTP request — bailed before the network " +
        "(match id could not be resolved for this source)",
    };
  }

  const statuses = new Set(calls.map((c) => c.status));
  const summary = httpSummary(calls);

  if (statuses.has("timeout")) {
    return { reason: "timeout", detail: `timeout after ${summary}` };
  }
  if (statuses.has("network-error")) {
    return {
      reason: "network-error",
      detail: `${summary} — host unreachable (egress blocked or DNS/TLS failure)`,
    };
  }
  if (statuses.has("rate-limited")) {
    return { reason: "rate-limited", detail: `rate-limited (cooldown armed) — ${summary}` };
  }
  if (statuses.has("not-found")) {
    return { reason: "http-error", detail: `404 — source has no record of this match (${summary})` };
  }
  if (statuses.has("server-error")) {
    return { reason: "http-error", detail: `upstream 5xx — ${summary}` };
  }
  if (statuses.has("http-error")) {
    return { reason: "http-error", detail: `HTTP error — ${summary}` };
  }
  if (statuses.has("invalid-json")) {
    return { reason: "http-error", detail: `unparseable response — ${summary}` };
  }
  if (calls.every((c) => c.status === "ok")) {
    return {
      reason: "empty-payload",
      detail: `request succeeded (${summary}) but the normaliser found no usable fields`,
    };
  }
  return { reason: "empty-payload", detail: `no usable fields — ${summary}` };
}

// ─── Aggregator ───────────────────────────────────────────────────────────────

export class StatsAggregator {
  private sourcePriority: string[] = [...DEFAULT_PRIORITY];
  private cooldowns: Map<string, number> = new Map();
  private cache: Map<string, { data: CanonicalMatchStats; expires: number }> = new Map();

  /** Per-source health observed in this process (unix ms timestamps). */
  private health: Map<string, {
    lastAttemptAt: number;
    lastSuccessAt: number;
    lastSuccessFields: number;
    lastFailureAt: number;
    lastFailureReason: string;
    lastFailureShort: string;
    lastFailureHttpStatus: number | null;
    lastReachableAt: number;
  }> = new Map();

  /** The most recent full walk (drives diagnostics.perSourceFailures). */
  private lastWalk: {
    at: string;
    cacheKey: string;
    outcome: "real-data" | "synthetic";
    primarySource: string | null;
    fieldCount: number;
    perSourceFailures: SourceFailureRecord[];
  } | null = null;

  private readonly handlers: Partial<Record<StatSourceName, SourceHandler>>;
  private readonly sourceTimeoutMs: number;
  private readonly cooldownMs: number;
  private readonly cacheTtlMs: number;
  private readonly logSink: (message: string) => void;

  constructor(opts: StatsAggregatorOptions = {}) {
    // When handlers are injected (tests) they REPLACE the registry entirely, so
    // a unit test never touches the network through an unlisted real source.
    this.handlers = opts.handlers ? opts.handlers : SOURCE_HANDLERS;
    this.sourceTimeoutMs = opts.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
    this.cooldownMs = opts.rateLimitCooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.logSink = opts.log ?? ((m) => console.log(m));
  }

  /** Deterministic cache key for a match. */
  cacheKey(match: MatchStatsQuery): string {
    return `stats:${match.leagueSlug}:${match.eventId}`;
  }

  /** Read a fresh cached result without fetching (used by the settlement engine). */
  peek(match: MatchStatsQuery): CanonicalMatchStats | null {
    const entry = this.cache.get(this.cacheKey(match));
    return entry && Date.now() < entry.expires ? entry.data : null;
  }

  /** Full cache snapshot (for the debug endpoint). */
  snapshot(): Array<{ key: string; data: CanonicalMatchStats; expires: number }> {
    return [...this.cache.entries()].map(([key, entry]) => ({ key, ...entry }));
  }

  /** Current cooldown map (source → unix ms until available again). */
  cooldownSnapshot(): Record<string, number> {
    return Object.fromEntries(this.cooldowns);
  }

  /** Effective source priority (the order the walk will use). */
  prioritySnapshot(): string[] {
    return [...this.sourcePriority];
  }

  /**
   * Per-source readiness for the CURRENT process env — no network involved.
   * Answers "why is every match on the synthetic baseline?" without a fetch:
   * a source is `key-missing` when its env vars are unset, `registered` when
   * it will be attempted, `not-registered` when no handler exists.
   */
  sourceReadiness(match?: MatchStatsQuery): Array<{
    source: string;
    priority: number;
    registered: boolean;
    requiresEnv: string[];
    keyPresent: boolean | null;
    coolingDown: boolean;
    applicable: boolean | null;
  }> {
    const probe: MatchStatsQuery | null = match ?? null;
    return this.sourcePriority.map((source, i) => {
      const name = source as StatSourceName;
      const handler = this.handlers[name];
      const requires = SOURCE_ENV_REQUIREMENTS[name] ?? [];
      const keyPresent = requires.length
        ? requires.some((v) => (process.env[v] ?? "").trim().length > 0)
        : null;
      return {
        source,
        priority: i + 1,
        registered: Boolean(handler),
        requiresEnv: requires,
        keyPresent,
        coolingDown: this.isCoolingDown(source),
        // Only meaningful for league-scoped sources (Understat, OpenLigaDB),
        // which gate on the league slug rather than on an env var.
        applicable:
          probe && handler ? this.gateAllows(handler, probe, source) : null,
      };
    });
  }

  /** Run a handler's no-network `available()` gate, never letting it throw. */
  private gateAllows(handler: SourceHandler, match: MatchStatsQuery, source: string): boolean {
    try {
      return handler.available(match, this.buildContext(source, { rateLimited: false, calls: [] }));
    } catch (err) {
      this.logSink(
        `[stats:${source}] available() gate threw (treated as unavailable): ` +
        (err instanceof Error ? err.message : String(err)),
      );
      return false;
    }
  }

  /**
   * Full observability snapshot for the diagnostics endpoint: per-source
   * health (last success / last failure / last reachability) plus the
   * perSourceFailures trace of the most recent walk. No network involved.
   */
  diagnostics(): AggregatorDiagnostics {
    const iso = (ms: number): string | null => (ms > 0 ? new Date(ms).toISOString() : null);
    const now = Date.now();
    return {
      lastWalkAt: this.lastWalk?.at ?? null,
      lastCacheKey: this.lastWalk?.cacheKey ?? null,
      lastOutcome: this.lastWalk?.outcome ?? null,
      lastPrimarySource: this.lastWalk?.primarySource ?? null,
      lastFieldCount: this.lastWalk?.fieldCount ?? null,
      perSourceFailures: this.lastWalk?.perSourceFailures ?? [],
      sources: this.sourcePriority.map((source, i) => {
        const name = source as StatSourceName;
        const h = this.health.get(source);
        const requires = SOURCE_ENV_REQUIREMENTS[name] ?? [];
        return {
          source,
          priority: i + 1,
          registered: Boolean(this.handlers[name]),
          requiresEnv: requires,
          keyPresent: requires.length
            ? requires.some((v) => (process.env[v] ?? "").trim().length > 0)
            : null,
          coolingDown: this.isCoolingDown(source, now),
          lastAttemptAt: iso(h?.lastAttemptAt ?? 0),
          lastSuccessAt: iso(h?.lastSuccessAt ?? 0),
          lastSuccessFields: h && h.lastSuccessAt > 0 ? h.lastSuccessFields : null,
          lastFailureAt: iso(h?.lastFailureAt ?? 0),
          lastFailureReason: h && h.lastFailureAt > 0 ? h.lastFailureReason : null,
          lastFailureShort: h && h.lastFailureAt > 0 ? h.lastFailureShort : null,
          lastFailureHttpStatus: h && h.lastFailureAt > 0 ? h.lastFailureHttpStatus : null,
          lastReachableAt: iso(h?.lastReachableAt ?? 0),
        };
      }),
    };
  }

  /** Record one attempt into the per-source health map. */
  private recordAttempt(a: SourceAttempt): void {
    const nowMs = Date.now();
    const h = this.health.get(a.source) ?? {
      lastAttemptAt: 0,
      lastSuccessAt: 0,
      lastSuccessFields: 0,
      lastFailureAt: 0,
      lastFailureReason: "",
      lastFailureShort: "",
      lastFailureHttpStatus: null as number | null,
      lastReachableAt: 0,
    };
    h.lastAttemptAt = nowMs;
    const httpStatus = a.http?.find((c) => c.httpStatus !== null)?.httpStatus ?? null;
    if (a.fields > 0) {
      h.lastSuccessAt = nowMs;
      h.lastSuccessFields = a.fields;
    } else {
      h.lastFailureAt = nowMs;
      h.lastFailureReason = a.reason ?? a.status;
      h.lastFailureShort = shortReason(a);
      h.lastFailureHttpStatus = httpStatus;
    }
    // ANY response (even 403/404) proves the host answered.
    if (httpStatus !== null) h.lastReachableAt = nowMs;
    this.health.set(a.source, h);
  }

  clearCache(key?: string): void {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }

  private isCoolingDown(source: string, now = Date.now()): boolean {
    const until = this.cooldowns.get(source);
    return until !== undefined && until > now;
  }

  private setCooldown(source: string): void {
    this.cooldowns.set(source, Date.now() + this.cooldownMs);
  }

  /** Mutable per-attempt state the context writes into as the handler runs. */
  private buildContext(source: string, tracker: { rateLimited: boolean; calls: SourceHttpCall[] }): SourceContext {
    return {
      http: async (url, opts) => {
        const startedAt = Date.now();
        const res: HttpResult = await fetchWithTimeout(url, {
          ...opts,
          timeoutMs: opts?.timeoutMs ?? this.sourceTimeoutMs,
        });
        if (res.status === "rate-limited") tracker.rateLimited = true;
        // Record every call so the attempt trace can name the real cause.
        // Without this, a blocked host and an empty response are
        // indistinguishable — both surface as "no usable fields".
        tracker.calls.push({
          url,
          status: res.status,
          httpStatus: "httpStatus" in res ? res.httpStatus : null,
          ms: Date.now() - startedAt,
        });
        return res;
      },
      env: (name) => (process.env[name] ?? "").trim(),
      timeoutMs: this.sourceTimeoutMs,
      now: () => Date.now(),
      log: (message) => this.logSink(`[stats:${source}] ${message}`),
      reportRateLimit: (reason) => {
        tracker.rateLimited = true;
        this.logSink(
          `[stats:${source}] rate limit detected${reason ? ` (${reason})` : ""} — ` +
          `cooldown armed for ${Math.round(this.cooldownMs / 60_000)}min; ` +
          `previously merged results will be served from cache meanwhile`,
        );
      },
    };
  }

  /**
   * Attempt one source; return its partial payload (or null) plus every HTTP
   * call it made. Never throws — a source that blows up is reported, not fatal.
   */
  private async trySource(
    source: string,
    match: MatchStatsQuery,
  ): Promise<{ payload: SourcePayload | null; error?: string; http: SourceHttpCall[] }> {
    const handler = this.handlers[source as StatSourceName];
    if (!handler) return { payload: null, http: [] };
    if (this.isCoolingDown(source)) return { payload: null, http: [] };

    const tracker = { rateLimited: false, calls: [] as SourceHttpCall[] };
    const ctx = this.buildContext(source, tracker);

    try {
      if (!this.gateAllows(handler, match, source)) return { payload: null, http: tracker.calls };
      const payload = await handler.fetch(match, ctx);
      if (tracker.rateLimited) this.setCooldown(source);
      return { payload, http: tracker.calls };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logSink(`[stats:${source}] source threw (treated as unavailable): ${message}`);
      return { payload: null, error: message, http: tracker.calls };
    }
  }

  /**
   * Fetch canonical stats for a match from the priority-ordered source chain.
   * Returns null ONLY when no source contributed a single field.
   */
  async fetch(match: MatchStatsQuery, opts: StatsFetchOptions = {}): Promise<CanonicalMatchStats | null> {
    return (await this.fetchWithTrace(match, opts)).stats;
  }

  /** Like fetch(), but also returns the per-source attempt trace + field sources. */
  async fetchWithTrace(match: MatchStatsQuery, opts: StatsFetchOptions = {}): Promise<StatsFetchResult> {
    const key = this.cacheKey(match);

    // Cache first — never re-walk while a fresh entry exists (unless forced).
    if (!opts.force) {
      const hit = this.cache.get(key);
      if (hit && Date.now() < hit.expires) {
        const ttlLeftS = Math.max(0, Math.round((hit.expires - Date.now()) / 1000));
        this.logSink(
          `[aggregator] ${match.leagueSlug}:${match.eventId} — cache hit ` +
          `(source ${hit.data.metadata.source}, ${nonNullFieldCount(hit.data)} fields, ${ttlLeftS}s left) — no sources tried`,
        );
        return { stats: hit.data, cacheKey: key, attempts: [], fieldSources: {} };
      }
    }

    const priority = opts.priority?.length
      ? opts.priority.filter((p): p is StatSourceName => p in this.handlers)
      : (this.sourcePriority as StatSourceName[]);

    const stats = emptyCanonicalMatchStats(match);
    const contributions = new Map<string, number>();
    const fieldSources: Partial<Record<StatKey, string>> = {};
    const attempts: SourceAttempt[] = [];

    // Log the chain up front so a truncated/hanging walk is visible in the log.
    this.logSink(`[stats] ${key} — walk ${priority.join(" → ")} (timeout ${this.sourceTimeoutMs}ms/source)`);

    for (const [index, source] of priority.entries()) {
      const step = `${index + 1}/${priority.length}`;
      const attemptStart = Date.now();

      // ── Gate 1: rate-limit cooldown ────────────────────────────────────────
      if (this.isCoolingDown(source)) {
        const until = this.cooldowns.get(source) ?? 0;
        const detail = `rate-limited earlier — cooldown active (${Math.max(0, Math.round((until - Date.now()) / 1000))}s left)`;
        attempts.push({ source, status: "cooldown", fields: 0, detail, reason: "cooldown", http: [] });
        this.logSink(`[stats] ${key} ${step} ${source} → SKIP ${detail}`);
        continue;
      }

      // ── Gate 2: handler registered? ────────────────────────────────────────
      const handler = this.handlers[source];
      if (!handler) {
        attempts.push({ source, status: "unavailable", fields: 0, detail: "no handler registered", reason: "no-handler", http: [] });
        this.logSink(`[stats] ${key} ${step} ${source} → SKIP no handler registered`);
        continue;
      }

      // ── Gate 3: no-network applicability (key present? league covered?) ────
      if (!this.gateAllows(handler, match, source)) {
        const missing = missingEnvVars(source);
        const detail = missing.length
          ? `key missing (${missing.join(" or ")} unset in env)`
          : `not applicable to ${match.leagueSlug} / event ${match.eventId}`;
        attempts.push({
          source,
          status: "unavailable",
          fields: 0,
          detail,
          reason: missing.length ? "key-missing" : "not-applicable",
          http: [],
        });
        this.logSink(`[stats] ${key} ${step} ${source} → SKIP ${detail}`);
        continue;
      }

      // ── Fetch + merge ──────────────────────────────────────────────────────
      const { payload, error, http } = await this.trySource(source, match);

      if (!payload) {
        const failure = describeFailure(http, error);
        attempts.push({
          source,
          status: error ? "error" : "empty",
          fields: 0,
          detail: error ? `${error} | ${failure.detail}` : failure.detail,
          reason: failure.reason,
          http,
        });
        this.logSink(
          `[stats] ${key} ${step} ${source} → FAIL ${failure.detail} (${Date.now() - attemptStart}ms)`,
        );
        continue;
      }

      const filled = mergePayload(stats, payload, source, contributions, fieldSources);
      attempts.push({
        source,
        status: filled > 0 ? "ok" : "empty",
        fields: filled,
        detail:
          filled > 0
            ? `merged ${filled} field(s) in ${Date.now() - attemptStart}ms`
            : `payload returned but no field was still empty (${httpSummary(http)})`,
        reason: filled > 0 ? "merged" : "empty-payload",
        http,
      });
      this.logSink(
        `[stats] ${key} ${step} ${source} → ${filled > 0 ? "OK" : "EMPTY"} ` +
        `${filled} field(s) | ${httpSummary(http)} | total ${nonNullFieldCount(stats)}/${TOTAL_STAT_SLOTS} (${Date.now() - attemptStart}ms)`,
      );

      if (source === "API-Football" && isComplete(stats)) {
        this.logSink(`[stats] ${key} — API-Football covered every per-match stat; breaking early (remaining sources skipped)`);
        break;
      }
    }

    if (nonNullFieldCount(stats) === 0) {
      // Name the dominant cause: "every source hit network-error" means egress
      // is blocked, which is an infra problem — NOT missing league coverage.
      const blocked = attempts.filter((a) => a.reason === "network-error" || a.reason === "timeout").length;
      const gated = attempts.filter((a) => a.reason === "key-missing").length;
      const verdict =
        blocked > 0
          ? `${blocked} source(s) could not reach their host (network-error/timeout) — check egress with GET /api/diagnostics/connectivity`
          : gated > 0
            ? `${gated} source(s) skipped for a missing API key — check .env.local`
            : "sources responded but normalised no usable fields";
      this.logSink(
        `[stats] ${key} — no source contributed any field → SYNTHETIC BASELINE | ${verdict} | ` +
        `attempts ${attempts.map((a) => `${a.source}=${a.status}${a.reason ? `:${a.reason}` : ""}`).join(", ") || "no sources"}`,
      );
      return this.finishWalk(match, key, attempts, null, null, 0, fieldSources);
    }

    stats.metadata.source = this.primarySource(contributions, priority);
    // Every source that actually filled at least one field, in priority order.
    // Additive metadata only — never consumed by the prediction paths; it
    // powers the data-source-agreement factor of the market confidence score.
    stats.metadata.sources = priority.filter((source) => (contributions.get(source) ?? 0) > 0);
    stats.metadata.fetchedAt = new Date().toISOString();
    stats.metadata.matchDate = match.date.slice(0, 10);
    stats.metadata.leagueSlug = match.leagueSlug;

    this.cache.set(key, { data: stats, expires: Date.now() + this.cacheTtlMs });
    this.pruneCache();

    const fieldCount = nonNullFieldCount(stats);
    this.logSink(
      `[stats] ${key} → source ${stats.metadata.source} | fields ${fieldCount}/${TOTAL_STAT_SLOTS} | ` +
      `sources ${(stats.metadata.sources ?? []).join("+") || stats.metadata.source} | ` +
      `attempts ${attempts.map((a) => `${a.source}=${a.status}${a.fields ? `(${a.fields})` : ""}`).join(", ")}`,
    );

    return this.finishWalk(match, key, attempts, stats, stats.metadata.source, fieldCount, fieldSources);
  }

  /**
   * End-of-walk bookkeeping + the summary log that MUST appear at the end of
   * every aggregator call:
   *
   *   [aggregator] eng.1:401879288 — 11 sources tried. Failed: API-Football (403),
   *     FBref (403), TheSportsDB (no key), … → SYNTHETIC
   *   [aggregator] eng.1:401879288 — 11 sources tried. Failed: StatsBomb (no data)
   *     → source API-Football (52 fields)
   *
   * Every failed source carries its exact reason; the same trace is stored in
   * `diagnostics.perSourceFailures` for the API response.
   */
  private finishWalk(
    match: MatchStatsQuery,
    key: string,
    attempts: SourceAttempt[],
    stats: CanonicalMatchStats | null,
    primarySource: string | null,
    fieldCount: number,
    fieldSources: Partial<Record<StatKey, string>>,
  ): StatsFetchResult {
    for (const attempt of attempts) this.recordAttempt(attempt);

    const at = new Date().toISOString();
    const perSourceFailures: SourceFailureRecord[] = attempts
      .filter((a) => a.fields === 0)
      .map((a) => ({
        source: a.source,
        reason: a.reason ?? a.status,
        short: shortReason(a),
        detail: a.detail ?? "",
        httpStatus: a.http?.find((c) => c.httpStatus !== null)?.httpStatus ?? null,
        at,
      }));

    const failedPart = perSourceFailures.length
      ? `Failed: ${perSourceFailures.map((f) => `${f.source} (${f.short})`).join(", ")}`
      : "no failures";
    const outcome = stats
      ? `source ${primarySource ?? "unknown"} (${fieldCount} fields)`
      : "SYNTHETIC";
    this.logSink(
      `[aggregator] ${match.leagueSlug}:${match.eventId} — ${attempts.length} sources tried. ` +
      `${failedPart} → ${outcome}`,
    );

    this.lastWalk = {
      at,
      cacheKey: key,
      outcome: stats ? "real-data" : "synthetic",
      primarySource: stats ? (primarySource ?? null) : null,
      fieldCount: stats ? fieldCount : 0,
      perSourceFailures,
    };

    return { stats, cacheKey: key, attempts, fieldSources };
  }

  /** Highest-priority source that contributed the most non-null fields. */
  private primarySource(contributions: Map<string, number>, priority: string[]): string {
    let best: string | null = null;
    let bestCount = -1;
    for (const source of priority) {
      const count = contributions.get(source) ?? 0;
      if (count > bestCount) {
        bestCount = count;
        best = source;
      }
    }
    return best ?? priority[0] ?? "unknown";
  }

  private pruneCache(): void {
    if (this.cache.size <= 500) return;
    const cutoff = Date.now() - this.cacheTtlMs;
    for (const [k, entry] of this.cache) {
      if (entry.expires < cutoff) this.cache.delete(k);
    }
  }
}

// ─── Shared singleton (cross-route cache — cron fills it, settlement reads it) ─

export const statsAggregator = new StatsAggregator();

// Re-export the capability matrix for the debug endpoint + PR docs.
export { SOURCE_CAPABILITIES, STAT_SOURCES, REGISTERED_SOURCES } from "./sources";
