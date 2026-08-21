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

const DEFAULT_PRIORITY: StatSourceName[] = [
  "SportScore", "API-Football", "StatsBomb", "datafc",
  "worldcup2026", "FBref", "TheSportsDB",
  "OpenLigaDB", "Highlightly", "Understat", "GitHubDatasets",
];

const DEFAULT_SOURCE_TIMEOUT_MS = 12_000;
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

/** One source attempt, for the per-match monitoring trace. */
export interface SourceAttempt {
  source: string;
  status: "ok" | "unavailable" | "cooldown" | "empty" | "error";
  fields: number;
  detail?: string;
}

export interface StatsFetchResult {
  stats: CanonicalMatchStats | null;
  cacheKey: string;
  attempts: SourceAttempt[];
  /** Which source filled each home/away field (observability). */
  fieldSources: Partial<Record<StatKey, string>>;
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

// ─── Aggregator ───────────────────────────────────────────────────────────────

export class StatsAggregator {
  private sourcePriority: string[] = [...DEFAULT_PRIORITY];
  private cooldowns: Map<string, number> = new Map();
  private cache: Map<string, { data: CanonicalMatchStats; expires: number }> = new Map();

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

  private buildContext(source: string, tracker: { rateLimited: boolean }): SourceContext {
    return {
      http: async (url, opts) => {
        const res: HttpResult = await fetchWithTimeout(url, {
          ...opts,
          timeoutMs: opts?.timeoutMs ?? this.sourceTimeoutMs,
        });
        if (res.status === "rate-limited") tracker.rateLimited = true;
        return res;
      },
      env: (name) => (process.env[name] ?? "").trim(),
      timeoutMs: this.sourceTimeoutMs,
      now: () => Date.now(),
      log: (message) => this.logSink(`[stats:${source}] ${message}`),
    };
  }

  /** Attempt one source; return its partial payload (or null). Never throws. */
  private async trySource(
    source: string,
    match: MatchStatsQuery,
  ): Promise<{ payload: SourcePayload | null; error?: string }> {
    const handler = this.handlers[source as StatSourceName];
    if (!handler) return { payload: null };
    if (this.isCoolingDown(source)) return { payload: null };

    const tracker = { rateLimited: false };
    const ctx = this.buildContext(source, tracker);

    try {
      if (!handler.available(match, ctx)) return { payload: null };
      const payload = await handler.fetch(match, ctx);
      if (tracker.rateLimited) this.setCooldown(source);
      return { payload };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logSink(`[stats:${source}] source threw (treated as unavailable): ${message}`);
      return { payload: null, error: message };
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

    for (const source of priority) {
      // API-Football "break early" applies to the default order; when a caller
      // supplied an explicit priority, still break when the payload is complete.
      const attemptStart = Date.now();
      if (this.isCoolingDown(source)) {
        attempts.push({ source, status: "cooldown", fields: 0, detail: "rate-limited earlier — cooldown active" });
        continue;
      }
      const handler = this.handlers[source];
      if (!handler) {
        attempts.push({ source, status: "unavailable", fields: 0, detail: "no handler registered" });
        continue;
      }
      if (!handler.available(match, this.buildContext(source, { rateLimited: false }))) {
        attempts.push({ source, status: "unavailable", fields: 0, detail: "source not applicable to this match" });
        continue;
      }

      const { payload, error } = await this.trySource(source, match);
      if (!payload) {
        attempts.push({
          source,
          status: error ? "error" : "empty",
          fields: 0,
          detail: error ?? "source returned no usable fields",
        });
        continue;
      }

      const filled = mergePayload(stats, payload, source, contributions, fieldSources);
      attempts.push({ source, status: filled > 0 ? "ok" : "empty", fields: filled, detail: `merged in ${Date.now() - attemptStart}ms` });

      if (source === "API-Football" && isComplete(stats)) {
        this.logSink(`[stats] ${key} — API-Football covered every per-match stat; breaking early (remaining sources skipped)`);
        break;
      }
    }

    if (nonNullFieldCount(stats) === 0) {
      this.logSink(
        `[stats] ${key} — no source contributed any field (${attempts.map((a) => `${a.source}=${a.status}`).join(", ") || "no sources"})`,
      );
      return { stats: null, cacheKey: key, attempts, fieldSources };
    }

    stats.metadata.source = this.primarySource(contributions, priority);
    stats.metadata.fetchedAt = new Date().toISOString();
    stats.metadata.matchDate = match.date.slice(0, 10);
    stats.metadata.leagueSlug = match.leagueSlug;

    this.cache.set(key, { data: stats, expires: Date.now() + this.cacheTtlMs });
    this.pruneCache();

    this.logSink(
      `[stats] ${key} → source ${stats.metadata.source} | fields ${nonNullFieldCount(stats)} | ` +
      `attempts ${attempts.map((a) => `${a.source}=${a.status}${a.fields ? `(${a.fields})` : ""}`).join(", ")}`,
    );

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
