// ĞIGI GIVØ — Canonical match statistics.
//
// This module is the SINGLE SOURCE OF TRUTH for all stat consumption across
// the ranking and settlement pipelines. Every data source (SportScore,
// API-Football, StatsBomb, datafc, FBref, Understat, OpenLigaDB, Highlightly,
// worldcup2026, TheSportsDB, GitHub Datasets) is normalised into the shapes
// below before it ever reaches the engine.
//
// Integrity contract (no mock data — ever):
//   · Every field is REAL data from a source normaliser, or `null`.
//   · A `null` field means "no source could provide this stat" — it is never
//     replaced with a simulated, default or "league-average" stand-in at the
//     normalisation layer. Fallbacks (e.g. historical league averages) are an
//     explicit, separately-weighted decision made by the CONSUMER (the
//     selector), never a silent substitution here.

// ─── Team stats ───────────────────────────────────────────────────────────────

export interface TeamStats {
  goals: number | null;

  // --- Expected / Advanced Metrics ---
  xg: number | null;                  // Expected Goals
  xgPerShot: number | null;           // Shot quality (xg / shots)

  // --- Core Match Events ---
  shots: number | null;
  shotsOnTarget: number | null;
  shotsOffTarget: number | null;
  blockedShots: number | null;

  // --- Set Pieces ---
  corners: number | null;
  goalKicks: number | null;
  throwIns: number | null;
  freeKicks: number | null;
  penalties: number | null;

  // --- Discipline ---
  yellowCards: number | null;
  redCards: number | null;
  fouls: number | null;
  offsides: number | null;

  // --- Possession & Passing ---
  possession: number | null;          // Percentage (e.g., 55.2)
  passes: number | null;
  passAccuracy: number | null;        // Percentage

  // --- Goalkeeping ---
  saves: number | null;
  goalsConceded: number | null;
  cleanSheet: boolean | null;

  // --- Physical & Defensive ---
  dribbling: number | null;           // Successful dribbles
  aerialBattlesWon: number | null;
  interceptions: number | null;
  tackles: number | null;
  clearances: number | null;

  // --- Historical Context (for scoring) ---
  avgCornersPerGame: number | null;   // Season average
  avgCardsPerGame: number | null;     // Season average
}

// ─── Match-level wrapper ──────────────────────────────────────────────────────

export interface CanonicalMatchStats {
  home: TeamStats;
  away: TeamStats;
  metadata: {
    source: string;     // 'SportScore' | 'API-Football' | 'StatsBomb' | etc.
    fetchedAt: string;  // ISO timestamp
    matchDate: string;  // ISO date of the match
    leagueSlug: string;
    /**
     * EVERY source that contributed at least one field to the merged stats,
     * in priority order (metadata.source is only the dominant one). Feeds the
     * data-source-agreement factor of the per-market confidence score; empty
     * or absent means a synthetic/league-average baseline with no source data.
     */
    sources?: string[];
  };
}

// ─── Source registry ──────────────────────────────────────────────────────────

/**
 * Every registered stats source, in the canonical display order used by the
 * aggregator's source-priority list. The aggregator's own priority order is the
 * runtime authority; this union only declares the set of known names.
 */
export type StatSourceName =
  | "SportScore"
  | "API-Football"
  | "StatsBomb"
  | "datafc"
  | "FBref"
  | "Understat"
  | "OpenLigaDB"
  | "Highlightly"
  | "worldcup2026"
  | "TheSportsDB"
  | "GitHubDatasets";

// ─── Query shape (what the aggregator needs to find a match) ──────────────────

export interface MatchStatsQuery {
  leagueSlug: string;
  eventId: string;    // provider event id (may be namespaced, e.g. "apif:1234")
  homeTeam: string;
  awayTeam: string;
  date: string;       // ISO date string (YYYY-MM-DD or full ISO timestamp)
}

// ─── Field enumeration (drives merging, capability matrix, coverage) ──────────

/**
 * All numeric stat fields of `TeamStats`, in declaration order. Used to merge
 * partial source results (first-wins by priority) and to report which source
 * provides which stat.
 */
export const STAT_FIELDS = [
  "goals",
  "xg",
  "xgPerShot",
  "shots",
  "shotsOnTarget",
  "shotsOffTarget",
  "blockedShots",
  "corners",
  "goalKicks",
  "throwIns",
  "freeKicks",
  "penalties",
  "yellowCards",
  "redCards",
  "fouls",
  "offsides",
  "possession",
  "passes",
  "passAccuracy",
  "saves",
  "goalsConceded",
  "dribbling",
  "aerialBattlesWon",
  "interceptions",
  "tackles",
  "clearances",
  "avgCornersPerGame",
  "avgCardsPerGame",
] as const;

export type StatKey = (typeof STAT_FIELDS)[number];

/** Fields a source CANNOT provide per-match (season averages / backfill only). */
export const HISTORICAL_FIELDS: readonly StatKey[] = [
  "avgCornersPerGame",
  "avgCardsPerGame",
];

/** Per-match numeric stat fields (everything except the historical averages). */
export const MATCH_STAT_FIELDS: readonly StatKey[] = STAT_FIELDS.filter(
  (f): f is Exclude<StatKey, (typeof HISTORICAL_FIELDS)[number]> =>
    !(HISTORICAL_FIELDS as readonly StatKey[]).includes(f),
);

/** The two boolean fields, handled separately from the numeric list. */
export const BOOLEAN_FIELDS = ["cleanSheet"] as const;
export type BooleanKey = (typeof BOOLEAN_FIELDS)[number];

/** Any per-team stat field (numeric or boolean) — used by the capability matrix. */
export type StatField = StatKey | BooleanKey;

// ─── Factories ────────────────────────────────────────────────────────────────

/** A fully-null TeamStats — the honest baseline before any source contributes. */
export function emptyTeamStats(): TeamStats {
  return {
    goals: null,
    xg: null,
    xgPerShot: null,
    shots: null,
    shotsOnTarget: null,
    shotsOffTarget: null,
    blockedShots: null,
    corners: null,
    goalKicks: null,
    throwIns: null,
    freeKicks: null,
    penalties: null,
    yellowCards: null,
    redCards: null,
    fouls: null,
    offsides: null,
    possession: null,
    passes: null,
    passAccuracy: null,
    saves: null,
    goalsConceded: null,
    cleanSheet: null,
    dribbling: null,
    aerialBattlesWon: null,
    interceptions: null,
    tackles: null,
    clearances: null,
    avgCornersPerGame: null,
    avgCardsPerGame: null,
  };
}

/** An empty CanonicalMatchStats carrying the query metadata only. */
export function emptyCanonicalMatchStats(match: MatchStatsQuery): CanonicalMatchStats {
  return {
    home: emptyTeamStats(),
    away: emptyTeamStats(),
    metadata: {
      source: "",
      fetchedAt: new Date().toISOString(),
      matchDate: match.date.slice(0, 10),
      leagueSlug: match.leagueSlug,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Number of non-null numeric stat fields on a team. */
export function nonNullStatCount(team: TeamStats): number {
  return STAT_FIELDS.reduce((sum, key) => sum + (team[key] !== null ? 1 : 0), 0);
}

/** Number of non-null fields across the whole match (home + away + cleanSheet). */
export function nonNullFieldCount(stats: CanonicalMatchStats): number {
  return (
    nonNullStatCount(stats.home) +
    nonNullStatCount(stats.away) +
    (stats.home.cleanSheet !== null ? 1 : 0) +
    (stats.away.cleanSheet !== null ? 1 : 0)
  );
}

/** True when the team has at least one non-null field. */
export function hasAnyStat(team: TeamStats): boolean {
  return nonNullStatCount(team) > 0 || team.cleanSheet !== null;
}

/** A typed, null-safe partial payload produced by a single source normaliser. */
export interface PartialTeamStats {
  goals?: number | null;
  xg?: number | null;
  xgPerShot?: number | null;
  shots?: number | null;
  shotsOnTarget?: number | null;
  shotsOffTarget?: number | null;
  blockedShots?: number | null;
  corners?: number | null;
  goalKicks?: number | null;
  throwIns?: number | null;
  freeKicks?: number | null;
  penalties?: number | null;
  yellowCards?: number | null;
  redCards?: number | null;
  fouls?: number | null;
  offsides?: number | null;
  possession?: number | null;
  passes?: number | null;
  passAccuracy?: number | null;
  saves?: number | null;
  goalsConceded?: number | null;
  cleanSheet?: boolean | null;
  dribbling?: number | null;
  aerialBattlesWon?: number | null;
  interceptions?: number | null;
  tackles?: number | null;
  clearances?: number | null;
  avgCornersPerGame?: number | null;
  avgCardsPerGame?: number | null;
}

/** What a source normaliser returns: partial home + away stats (or null). */
export interface SourcePayload {
  home: PartialTeamStats;
  away: PartialTeamStats;
}
