// ĞIGI GIVØ — Per-source execution context + handler contract.
//
// Every registered stats source implements `SourceHandler` and receives a
// `SourceContext` with the shared HTTP client, env access, timeout budget and
// logger. The aggregator resolves handlers from `SOURCE_HANDLERS` (or an
// override map injected for tests), so sources are individually unit-testable
// without any network access.

import type { HttpRequestOptions, HttpResult } from "../http";
import type { MatchStatsQuery, SourcePayload, StatField, StatSourceName } from "../types";

/** Execution environment handed to each source normaliser. */
export interface SourceContext {
  /** Shared fail-soft HTTP client (timeout-bounded, never throws). */
  http: (url: string, opts?: HttpRequestOptions) => Promise<HttpResult>;
  /** Read an environment variable (trimmed). */
  env: (name: string) => string;
  /** Per-source timeout budget in ms. */
  timeoutMs: number;
  /** Current time in ms (injectable for tests). */
  now: () => number;
  /** Log a line through the aggregator's log sink. */
  log: (message: string) => void;
}

/**
 * A single stats source: its name, which stat fields it can produce, whether
 * it is usable for a given match, and the fetch + normalise routine.
 */
export interface SourceHandler {
  /** Canonical source name (drives the priority list + metadata.source). */
  name: StatSourceName;
  /** The stat fields this source's normaliser can fill (capability matrix). */
  capabilities: StatField[];
  /**
   * Cheap pre-flight gate (no network): is this source even applicable?
   * e.g. API-Football requires a key; OpenLigaDB only covers German leagues.
   */
  available: (match: MatchStatsQuery, ctx: SourceContext) => boolean;
  /**
   * Fetch raw JSON/HTML for the match and normalise it into partial team
   * stats. Must NEVER throw — return null when the source cannot contribute.
   */
  fetch: (match: MatchStatsQuery, ctx: SourceContext) => Promise<SourcePayload | null>;
}
