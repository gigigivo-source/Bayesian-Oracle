// ĞIGI GIVØ — Historical match aggregator.
//
// This module is the data foundation of the "supercomputer" correct-score
// engine: the ELO replay, the attack/defence parameters and the Dixon–Coles ρ
// estimate are all derived from the completed matches returned here.
//
// Layered sourcing, in priority order. Layer 1 always runs; each later layer is
// attempted only while the accumulated match count is still below `minMatches`:
//
//   1. `database`        — `performance_log` (settled picks carry real final
//                          scores), plus a generic `fixtures`/`matches` table
//                          when the deployment happens to have one.
//   2. `github-datasets` — CSV dumps parsed with the app's existing
//                          GitHubDatasets reader. Defaults to football-data.co.uk
//                          season files (small, league-scoped); set
//                          `HISTORICAL_CSV_URLS` to point at a consolidated dump.
//   3. `openfootball`    — openfootball/football.json via the GitHub Contents
//                          API: one small JSON file per league per season, and
//                          reachable from deployments whose egress allowlist
//                          only permits `api.github.com`.
//   4. `espn`            — the app's ESPN scoreboard cache (recent results).
//
// Integrity contract, identical to the stats aggregator: every match here is a
// real completed fixture with a real final score. A layer that returns nothing
// is reported in `sources` with the reason, never replaced by fabricated
// results. If no layer produces data the dataset is empty and the consumer
// falls back to the documented league baseline.
//
// `saved_slips` is deliberately NOT read: it stores pick selections and combined
// odds but no final score, so it cannot contribute a result. It is named here so
// the omission reads as a decision rather than an oversight.

import { fetchWithTimeout } from "./http";
import { parseCsv } from "./sources/githubDatasets";

// ─── Types ────────────────────────────────────────────────────────────────────

export type HistoricalSource =
  | "database"
  | "fixtures-table"
  | "github-datasets"
  | "openfootball"
  | "espn";

export interface HistoricalMatch {
  /** De-duplication key: `${leagueSlug}|${homeKey}|${awayKey}|${YYYY-MM-DD}`. */
  id: string;
  homeTeam: string;
  awayTeam: string;
  leagueSlug: string;
  /** ISO-8601 kickoff. Date-only sources normalise to `YYYY-MM-DDT00:00:00Z`. */
  matchDate: string;
  homeGoals: number;
  awayGoals: number;
  /** Human-readable competition name when the source supplies one. */
  competitionName: string | null;
  /** Layer that produced this row (mirrored into `HistoricalDataset.sources`). */
  source: HistoricalSource;
}

export interface TeamAggregate {
  /** Canonical (display) team name, taken from the first match seen. */
  team: string;
  /** Normalised lookup key — see `normaliseTeamName`. */
  key: string;
  leagueSlug: string;
  matchesPlayed: number;
  homeMatches: number;
  awayMatches: number;
  homeGoalsScored: number;
  homeGoalsConceded: number;
  awayGoalsScored: number;
  awayGoalsConceded: number;
  goalsScored: number;
  goalsConceded: number;
  /** `homeGoalsScored / homeMatches`; null when the team never played at home. */
  avgGoalsScoredHome: number | null;
  avgGoalsConcededHome: number | null;
  avgGoalsScoredAway: number | null;
  avgGoalsConcededAway: number | null;
  avgGoalsScored: number | null;
  avgGoalsConceded: number | null;
  /** ISO date of the team's most recent match inside the window. */
  lastPlayed: string | null;
  /**
   * Exponentially time-decayed totals (Dixon & Coles' ξ weighting). Identical
   * to the integer counts above when no decay is configured.
   */
  weighted: TeamWeightedTotals;
}

export interface TeamWeightedTotals {
  matches: number;
  homeMatches: number;
  awayMatches: number;
  homeGoalsScored: number;
  homeGoalsConceded: number;
  awayGoalsScored: number;
  awayGoalsConceded: number;
  goalsScored: number;
  goalsConceded: number;
}

export interface DecayOptions {
  /**
   * Half-life in days for the exponential match weighting. `null` (the default)
   * weights every match equally.
   */
  halfLifeDays?: number | null;
  /** Reference date the decay is measured back from. Default: now. */
  now?: Date;
}

/** Dixon & Coles' own half-life: about a year, so last season dominates. */
export const DEFAULT_HALF_LIFE_DAYS = 365;

/** Exponential match weight: 1 at `now`, 0.5 one half-life ago. */
export function matchWeight(matchDate: string, halfLifeDays: number | null, nowMs: number): number {
  if (!halfLifeDays || halfLifeDays <= 0) return 1;
  const ageDays = Math.max(0, (nowMs - new Date(matchDate).getTime()) / 86_400_000);
  return 0.5 ** (ageDays / halfLifeDays);
}

export interface TeamStatsTable {
  teams: Map<string, TeamAggregate>;
  matches: number;
  leagueSlug: string | null;
}

export interface SourceReport {
  source: HistoricalSource;
  attempted: boolean;
  /** Matches this layer contributed after de-duplication against earlier layers. */
  added: number;
  /** Why the layer was skipped or produced nothing (empty string on success). */
  note: string;
}

export interface HistoricalDataset {
  matches: HistoricalMatch[];
  sources: SourceReport[];
  /** Layer that supplied the most matches (null when the dataset is empty). */
  primarySource: HistoricalSource | null;
  seasonsCovered: string[];
  matchCount: number;
  teamCount: number;
  earliest: string | null;
  latest: string | null;
  generatedAt: string;
}

export interface HistoricalLoadOptions {
  /** Restrict to one ESPN-style league slug; null keeps every league. */
  leagueSlug?: string | null;
  /** Rolling seasons to keep. Default `DEFAULT_SEASONS`. */
  seasons?: number;
  /** Below this many matches the next sourcing layer is attempted. */
  minMatches?: number;
  /** Hard cap on the returned match count. */
  maxMatches?: number;
  /** ESPN scoreboard window in days (only used by the `espn` layer). */
  lookbackDays?: number;
  /** Restrict the attempt list; the default is every layer. */
  layers?: HistoricalSource[];
  /** Bypass the in-memory cache. */
  force?: boolean;
  /** Injectable clock — the backtest uses this for reproducible windows. */
  now?: Date;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export const DEFAULT_SEASONS = 3;
/** Below this the dataset is too thin to carry team-strength parameters. */
export const MIN_USEFUL_MATCHES = 100;
const DEFAULT_MAX_MATCHES = 6_000;
const DEFAULT_ESPN_LOOKBACK_DAYS = 400;
const CSV_TIMEOUT_MS = 25_000;
const GITHUB_TIMEOUT_MS = 20_000;
const CSV_MAX_ROWS = 20_000;
const CACHE_TTL_MS = 30 * 60_000;

/** openfootball/football.json — one small JSON file per league per season. */
const OPENFOOTBALL_REPO = "openfootball/football.json";

/** ESPN slug → football-data.co.uk division code. */
export const FOOTBALL_DATA_CODES: Record<string, string> = {
  "eng.1": "E0", "eng.2": "E1", "eng.3": "E2", "eng.4": "E3", "eng.5": "EC",
  "sco.1": "SC0", "sco.2": "SC1",
  "ger.1": "D1", "ger.2": "D2",
  "ita.1": "I1", "ita.2": "I2",
  "esp.1": "SP1", "esp.2": "SP2",
  "fra.1": "F1", "fra.2": "F2",
  "ned.1": "N1", "bel.1": "B1", "por.1": "P1", "tur.1": "T1", "gr.1": "G1",
};

/** ESPN slug → openfootball competition code. */
export const OPENFOOTBALL_CODES: Record<string, string> = {
  "eng.1": "en.1", "eng.2": "en.2", "eng.3": "en.3",
  "sco.1": "sco.1", "sco.2": "sco.2",
  "ger.1": "de.1", "ger.2": "de.2",
  "ita.1": "it.1", "ita.2": "it.2",
  "esp.1": "es.1", "esp.2": "es.2",
  "fra.1": "fr.1", "fra.2": "fr.2",
  "ned.1": "nl.1", "bel.1": "be.1", "por.1": "pt.1", "tur.1": "tr.1",
  "gr.1": "gr.1", "at.1": "at.1", "sui.1": "ch.1", "den.1": "dk.1",
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Team identity is name-based across every layer of this app (the ESPN feed,
 * the CSV dumps and openfootball all use different identifiers), so all lookups
 * go through this normalisation: case-folded, de-accented, non-alphanumeric
 * collapsed. It is the same normalisation the correct-score route and backtest
 * already use, so a team resolves to the same key everywhere.
 */
export function normaliseTeamName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Loose team equality: exact normalised match, or one name containing the other
 * once both are long enough to be distinctive. This is what lets "Arsenal FC"
 * (openfootball) resolve to "Arsenal" (ESPN).
 */
export function teamsMatch(left: string, right: string): boolean {
  const a = normaliseTeamName(left);
  const b = normaliseTeamName(right);
  if (!a || !b) return false;
  return a === b || (a.length > 4 && b.length > 4 && (a.includes(b) || b.includes(a)));
}

/**
 * Accept `YYYY-MM-DD`, ISO timestamps, `YYYYMMDD` (ESPN) and `DD/MM/YYYY` or
 * `DD/MM/YY` (football-data.co.uk). Returns an ISO string or null.
 */
export function parseHistoricalDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  const dashed = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(raw);
  if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}T00:00:00Z`;

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}T00:00:00Z`;

  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw);
  if (slashed) {
    const year = slashed[3].length === 2 ? `20${slashed[3]}` : slashed[3];
    return `${year}-${slashed[2].padStart(2, "0")}-${slashed[1].padStart(2, "0")}T00:00:00Z`;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Non-negative integer goals, or null. Rejects blank cells and negatives. */
export function parseGoals(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

/** Season label ("2024-25") for a kickoff date on the August–May calendar. */
export function seasonOf(isoDate: string): string | null {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = parsed.getUTCFullYear();
  const start = parsed.getUTCMonth() >= 6 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Season directory names, oldest first, ending with the season containing `now`. */
export function seasonCodes(now: Date, seasons: number): string[] {
  const year = now.getUTCFullYear();
  const start = year - (now.getUTCMonth() >= 6 ? 0 : 1);
  const out: string[] = [];
  for (let offset = Math.max(1, seasons) - 1; offset >= 0; offset--) {
    const from = start - offset;
    out.push(`${from}-${String((from + 1) % 100).padStart(2, "0")}`);
  }
  return out;
}

/** football-data.co.uk season code, e.g. `2024-25` → `2425`. */
export function footballDataSeasonCode(season: string): string {
  const [from, to] = season.split("-");
  return `${from.slice(2)}${to}`;
}

export function makeMatchId(
  leagueSlug: string,
  homeTeam: string,
  awayTeam: string,
  matchDate: string,
): string {
  return [
    leagueSlug || "unknown",
    normaliseTeamName(homeTeam),
    normaliseTeamName(awayTeam),
    matchDate.slice(0, 10),
  ].join("|");
}

export function dedupeAndSortMatches(matches: HistoricalMatch[]): HistoricalMatch[] {
  const seen = new Map<string, HistoricalMatch>();
  for (const match of matches) {
    // First layer wins: an earlier (higher-priority) source is never
    // overwritten by a later one, mirroring the stats aggregator's merge rule.
    if (!seen.has(match.id)) seen.set(match.id, match);
  }
  return [...seen.values()].sort(
    (left, right) => new Date(left.matchDate).getTime() - new Date(right.matchDate).getTime(),
  );
}

/**
 * Per-team home/away goal aggregates — the raw counts both the attack/defence
 * parameters and the ELO replay are built from.
 */
export function aggregateTeamStats(
  matches: HistoricalMatch[],
  leagueSlug: string | null = null,
  decay: DecayOptions = {},
): TeamStatsTable {
  const teams = new Map<string, TeamAggregate>();
  const halfLifeDays = decay.halfLifeDays ?? null;
  const nowMs = (decay.now ?? new Date()).getTime();

  const entryFor = (team: string, slug: string): TeamAggregate => {
    const key = normaliseTeamName(team);
    const existing = teams.get(key);
    if (existing) return existing;
    const created: TeamAggregate = {
      team,
      key,
      leagueSlug: slug,
      matchesPlayed: 0,
      homeMatches: 0,
      awayMatches: 0,
      homeGoalsScored: 0,
      homeGoalsConceded: 0,
      awayGoalsScored: 0,
      awayGoalsConceded: 0,
      goalsScored: 0,
      goalsConceded: 0,
      avgGoalsScoredHome: null,
      avgGoalsConcededHome: null,
      avgGoalsScoredAway: null,
      avgGoalsConcededAway: null,
      avgGoalsScored: null,
      avgGoalsConceded: null,
      lastPlayed: null,
      weighted: {
        matches: 0,
        homeMatches: 0,
        awayMatches: 0,
        homeGoalsScored: 0,
        homeGoalsConceded: 0,
        awayGoalsScored: 0,
        awayGoalsConceded: 0,
        goalsScored: 0,
        goalsConceded: 0,
      },
    };
    teams.set(key, created);
    return created;
  };

  for (const match of matches) {
    if (!match.homeTeam || !match.awayTeam) continue;
    if (teamsMatch(match.homeTeam, match.awayTeam)) continue; // never a real fixture

    const home = entryFor(match.homeTeam, match.leagueSlug);
    const away = entryFor(match.awayTeam, match.leagueSlug);
    const weight = matchWeight(match.matchDate, halfLifeDays, nowMs);

    home.weighted.matches += weight;
    home.weighted.homeMatches += weight;
    home.weighted.homeGoalsScored += weight * match.homeGoals;
    home.weighted.homeGoalsConceded += weight * match.awayGoals;
    home.weighted.goalsScored += weight * match.homeGoals;
    home.weighted.goalsConceded += weight * match.awayGoals;

    away.weighted.matches += weight;
    away.weighted.awayMatches += weight;
    away.weighted.awayGoalsScored += weight * match.awayGoals;
    away.weighted.awayGoalsConceded += weight * match.homeGoals;
    away.weighted.goalsScored += weight * match.awayGoals;
    away.weighted.goalsConceded += weight * match.homeGoals;

    home.matchesPlayed++;
    home.homeMatches++;
    home.homeGoalsScored += match.homeGoals;
    home.homeGoalsConceded += match.awayGoals;
    home.goalsScored += match.homeGoals;
    home.goalsConceded += match.awayGoals;

    away.matchesPlayed++;
    away.awayMatches++;
    away.awayGoalsScored += match.awayGoals;
    away.awayGoalsConceded += match.homeGoals;
    away.goalsScored += match.awayGoals;
    away.goalsConceded += match.homeGoals;

    for (const entry of [home, away]) {
      if (entry.lastPlayed === null || match.matchDate > entry.lastPlayed) {
        entry.lastPlayed = match.matchDate;
      }
    }
  }

  const ratio = (total: number, count: number): number | null => (count > 0 ? total / count : null);
  for (const entry of teams.values()) {
    entry.avgGoalsScoredHome = ratio(entry.homeGoalsScored, entry.homeMatches);
    entry.avgGoalsConcededHome = ratio(entry.homeGoalsConceded, entry.homeMatches);
    entry.avgGoalsScoredAway = ratio(entry.awayGoalsScored, entry.awayMatches);
    entry.avgGoalsConcededAway = ratio(entry.awayGoalsConceded, entry.awayMatches);
    entry.avgGoalsScored = ratio(entry.goalsScored, entry.matchesPlayed);
    entry.avgGoalsConceded = ratio(entry.goalsConceded, entry.matchesPlayed);
  }

  return { teams, matches: matches.length, leagueSlug };
}

/** Resolve a team by exact key first, then by fuzzy name containment. */
export function findTeamAggregate(table: TeamStatsTable, team: string): TeamAggregate | null {
  const direct = table.teams.get(normaliseTeamName(team));
  if (direct) return direct;
  for (const entry of table.teams.values()) {
    if (teamsMatch(entry.team, team)) return entry;
  }
  return null;
}

/** Matches strictly before `cutoffIso`, preserving chronological order. */
export function matchesBefore(matches: HistoricalMatch[], cutoffIso: string): HistoricalMatch[] {
  const cutoff = new Date(cutoffIso).getTime();
  return matches.filter((match) => new Date(match.matchDate).getTime() < cutoff);
}

/** Matches on/after `cutoffIso`, preserving chronological order. */
export function matchesFrom(matches: HistoricalMatch[], cutoffIso: string): HistoricalMatch[] {
  const cutoff = new Date(cutoffIso).getTime();
  return matches.filter((match) => new Date(match.matchDate).getTime() >= cutoff);
}

/** Wrap a match array in the dataset envelope the model layers consume. */
export function datasetFromMatches(
  matches: HistoricalMatch[],
  sources: SourceReport[],
  now: Date = new Date(),
): HistoricalDataset {
  const ordered = dedupeAndSortMatches(matches);
  const tally = new Map<HistoricalSource, number>();
  for (const match of ordered) tally.set(match.source, (tally.get(match.source) ?? 0) + 1);

  let primarySource: HistoricalSource | null = null;
  let best = 0;
  for (const [source, count] of tally) {
    if (count > best) {
      best = count;
      primarySource = source;
    }
  }

  const seasons = new Set<string>();
  for (const match of ordered) {
    const season = seasonOf(match.matchDate);
    if (season) seasons.add(season);
  }

  return {
    matches: ordered,
    sources,
    primarySource,
    seasonsCovered: [...seasons].sort(),
    matchCount: ordered.length,
    teamCount: aggregateTeamStats(ordered).teams.size,
    earliest: ordered.length ? ordered[0].matchDate : null,
    latest: ordered.length ? ordered[ordered.length - 1].matchDate : null,
    generatedAt: now.toISOString(),
  };
}

// ─── CSV plumbing (football-data.co.uk layer) ─────────────────────────────────

const CSV_ALIASES: Record<string, string> = {
  hometeam: "home", home: "home", home_team: "home", team1: "home",
  awayteam: "away", away: "away", away_team: "away", team2: "away",
  date: "date", matchdate: "date",
  div: "league", league: "league", division: "league", season: "season",
  fthg: "homeGoals", hg: "homeGoals", homegoals: "homeGoals", home_goals: "homeGoals",
  ftag: "awayGoals", ag: "awayGoals", awaygoals: "awayGoals", away_goals: "awayGoals",
};

const normaliseColumn = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Map a CSV header row to field positions. Mirrors the alias table of the
 * GitHubDatasets handler, whose own index builder is not exported.
 */
export function indexCsvHeader(header: string[]): Record<string, number> {
  const index: Record<string, number> = {};
  header.forEach((cell, position) => {
    const field = CSV_ALIASES[normaliseColumn(cell)];
    if (field && index[field] === undefined) index[field] = position;
  });
  return index;
}

/**
 * Turn a CSV document into completed matches. Exported so the parser can be
 * exercised against a fixture file without touching the network. Row splitting
 * is delegated to the GitHubDatasets reader so quoting and embedded-newline
 * behaviour stay identical across the app.
 */
export function matchesFromCsv(
  csvText: string,
  options: {
    leagueSlug: string | null;
    source: HistoricalSource;
    competitionName?: string | null;
    maxRows?: number;
  },
): HistoricalMatch[] {
  const rows = parseCsv(csvText, options.maxRows ?? CSV_MAX_ROWS);
  if (rows.length < 2) return [];
  const index = indexCsvHeader(rows[0]);
  if (index.home === undefined || index.away === undefined) return [];

  const at = (row: string[], position: number | undefined): string | null =>
    position !== undefined && position < row.length ? row[position] : null;

  const matches: HistoricalMatch[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const home = at(row, index.home);
    const away = at(row, index.away);
    const homeGoals = parseGoals(at(row, index.homeGoals));
    const awayGoals = parseGoals(at(row, index.awayGoals));
    const matchDate = parseHistoricalDate(at(row, index.date));
    if (!home || !away || homeGoals === null || awayGoals === null || !matchDate) continue;
    const leagueSlug = options.leagueSlug ?? at(row, index.league) ?? "unknown";
    matches.push({
      id: makeMatchId(leagueSlug, home, away, matchDate),
      homeTeam: home,
      awayTeam: away,
      leagueSlug,
      matchDate,
      homeGoals,
      awayGoals,
      competitionName: options.competitionName ?? at(row, index.league) ?? null,
      source: options.source,
    });
  }
  return matches;
}

// ─── Layer 1: database ────────────────────────────────────────────────────────

interface DbRow {
  homeTeam?: unknown;
  awayTeam?: unknown;
  leagueSlug?: unknown;
  league?: unknown;
  competitionName?: unknown;
  matchDate?: unknown;
  homeGoals?: unknown;
  awayGoals?: unknown;
}

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function rowsToMatches(rows: DbRow[], fallbackLeague: string | null, source: HistoricalSource): HistoricalMatch[] {
  const matches: HistoricalMatch[] = [];
  for (const row of rows) {
    const home = nonEmpty(row.homeTeam);
    const away = nonEmpty(row.awayTeam);
    const homeGoals = parseGoals(row.homeGoals);
    const awayGoals = parseGoals(row.awayGoals);
    const matchDate = parseHistoricalDate(nonEmpty(row.matchDate));
    if (!home || !away || homeGoals === null || awayGoals === null || !matchDate) continue;
    const leagueSlug = nonEmpty(row.leagueSlug) ?? fallbackLeague ?? "unknown";
    matches.push({
      id: makeMatchId(leagueSlug, home, away, matchDate),
      homeTeam: home,
      awayTeam: away,
      leagueSlug,
      matchDate,
      homeGoals,
      awayGoals,
      competitionName: nonEmpty(row.competitionName) ?? nonEmpty(row.league),
      source,
    });
  }
  return matches;
}

const PERFORMANCE_LOG_SQL = `
  SELECT home_team         AS "homeTeam",
         away_team         AS "awayTeam",
         league_slug       AS "leagueSlug",
         league            AS "league",
         competition_name  AS "competitionName",
         match_date        AS "matchDate",
         home_score        AS "homeGoals",
         away_score        AS "awayGoals"
    FROM performance_log
   WHERE home_score IS NOT NULL
     AND away_score IS NOT NULL
     AND home_score >= 0
     AND away_score >= 0
     AND NULLIF(BTRIM(home_team), '') IS NOT NULL
     AND NULLIF(BTRIM(away_team), '') IS NOT NULL
     AND ($1::text IS NULL OR league_slug = $1)
     AND ($2::text IS NULL OR match_date >= $2)
   ORDER BY match_date ASC
   LIMIT $3`;

/** Candidate tables and columns for a generic fixture archive. */
const FIXTURE_TABLE_CANDIDATES = ["fixtures", "matches", "historical_matches", "football_matches"];
const FIXTURE_COLUMNS: Record<string, string[]> = {
  homeTeam: ["home_team", "hometeam", "home_team_name", "home"],
  awayTeam: ["away_team", "awayteam", "away_team_name", "away"],
  homeGoals: ["home_goals", "home_score", "fthg", "homegoals"],
  awayGoals: ["away_goals", "away_score", "ftag", "awaygoals"],
  matchDate: ["match_date", "date", "kickoff", "played_at", "matchday"],
  leagueSlug: ["league_slug", "league_code", "competition_slug", "league", "league_name"],
};
const FIXTURE_REQUIRED = ["homeTeam", "awayTeam", "homeGoals", "awayGoals", "matchDate"];

/**
 * Read completed matches from Postgres. `src/db` throws at import time when
 * `DATABASE_URL` is unset, so the module is imported dynamically and every
 * failure is reported rather than thrown — a missing database must degrade the
 * model to the next source, never break the route.
 */
export async function loadMatchesFromDatabase(
  leagueSlug: string | null,
  sinceIso: string | null,
  limit: number,
): Promise<{ matches: HistoricalMatch[]; notes: string[] }> {
  let pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  try {
    ({ pool } = await import("@/db"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      matches: [],
      notes: [message.includes("DATABASE_URL") ? "DATABASE_URL is not configured" : `database unavailable (${message})`],
    };
  }

  const since = sinceIso ? sinceIso.slice(0, 10) : null;
  const collected: HistoricalMatch[] = [];
  const notes: string[] = [];

  try {
    const result = await pool.query(PERFORMANCE_LOG_SQL, [leagueSlug, since, limit]);
    collected.push(...rowsToMatches(result.rows as DbRow[], leagueSlug, "database"));
    if (!collected.length) notes.push("performance_log holds no completed matches in range");
  } catch (error) {
    notes.push(`performance_log: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Optional archive table: only queried when the deployment actually has one,
  // with every identifier resolved from information_schema (never from input).
  for (const table of FIXTURE_TABLE_CANDIDATES) {
    if (collected.length >= limit) break;
    try {
      const columns = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const available = new Set((columns.rows as Array<{ column_name: string }>).map((row) => row.column_name));
      if (!available.size) continue;

      const resolved: Record<string, string> = {};
      for (const [field, candidates] of Object.entries(FIXTURE_COLUMNS)) {
        const found = candidates.find((candidate) => available.has(candidate));
        if (found) resolved[field] = found;
      }
      if (FIXTURE_REQUIRED.some((field) => !resolved[field])) continue;

      const select = Object.entries(resolved)
        .map(([field, column]) => `"${column}" AS "${field}"`)
        .join(", ");
      const where = resolved.leagueSlug
        ? `WHERE ($1::text IS NULL OR "${resolved.leagueSlug}" = $1)`
        : "";
      const params = resolved.leagueSlug ? [leagueSlug, limit] : [limit];
      const result = await pool.query(
        `SELECT ${select} FROM "${table}" ${where}
          ORDER BY "${resolved.matchDate}" ASC LIMIT $${params.length}`,
        params,
      );
      collected.push(...rowsToMatches(result.rows as DbRow[], leagueSlug, "fixtures-table"));
    } catch {
      // A malformed optional archive table is not worth surfacing: the
      // documented source is `performance_log` and its failure is reported.
    }
  }

  return { matches: collected, notes: collected.length ? [] : notes };
}

// ─── Layer 2: CSV dumps (football-data.co.uk by default) ──────────────────────

function csvUrlsFor(leagueSlug: string | null, seasons: string[]): string[] {
  const configured = (process.env.HISTORICAL_CSV_URLS ?? process.env.GITHUB_DATASET_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (configured.length) return configured;

  const code = leagueSlug ? FOOTBALL_DATA_CODES[leagueSlug] : undefined;
  if (!code) return [];
  return seasons.map(
    (season) => `https://www.football-data.co.uk/mmz4281/${footballDataSeasonCode(season)}/${code}.csv`,
  );
}

/** CSV dumps — football-data.co.uk season files, or `HISTORICAL_CSV_URLS`. */
export async function loadMatchesFromCsvSources(
  leagueSlug: string | null,
  seasons: string[],
): Promise<{ matches: HistoricalMatch[]; notes: string[] }> {
  const urls = csvUrlsFor(leagueSlug, seasons);
  if (!urls.length) {
    return {
      matches: [],
      notes: [
        leagueSlug
          ? `no CSV mapping for ${leagueSlug} (set HISTORICAL_CSV_URLS to override)`
          : "no league selected and HISTORICAL_CSV_URLS is unset",
      ],
    };
  }

  const matches: HistoricalMatch[] = [];
  const notes: string[] = [];
  for (const url of urls) {
    const response = await fetchWithTimeout(url, { text: true, timeoutMs: CSV_TIMEOUT_MS });
    if (response.status !== "ok" || typeof response.data !== "string") {
      notes.push(`${new URL(url).hostname}: ${response.status}`);
      continue;
    }
    matches.push(...matchesFromCsv(response.data, { leagueSlug, source: "github-datasets" }));
  }
  if (!matches.length && !notes.length) notes.push("CSV sources returned no usable rows");
  return { matches, notes };
}

// ─── Layer 3: openfootball via the GitHub Contents API ────────────────────────

interface OpenfootballMatch {
  date?: string;
  time?: string;
  team1?: string;
  team2?: string;
  /**
   * Either `{ ht, ft }` or — openfootball's shorthand, used throughout the
   * 2025-26 files — a bare `[home, away]` array. Unplayed fixtures omit the
   * key entirely, so an array is always a completed result.
   */
  score?: { ft?: number[] } | number[] | null;
  status?: string;
}

/**
 * Extract the full-time score from an openfootball `score` value.
 *
 * Both encodings occur in the wild and only the object form is documented:
 * `{"ht":[1,0],"ft":[2,0]}` for ordinary results and a bare `[0, 0]` for
 * goalless draws. Reading only `score.ft` silently discards every 0-0 in a
 * file that uses the shorthand — which skews exactly the low-score cells the
 * Dixon–Coles ρ is estimated from.
 */
export function fullTimeScore(score: unknown): [number, number] | null {
  const fromArray = (value: unknown): [number, number] | null => {
    if (!Array.isArray(value) || value.length < 2) return null;
    const home = parseGoals(value[0]);
    const away = parseGoals(value[1]);
    return home !== null && away !== null ? [home, away] : null;
  };
  if (Array.isArray(score)) return fromArray(score);
  if (score && typeof score === "object") return fromArray((score as { ft?: unknown }).ft);
  return null;
}

/** openfootball/football.json — small per-league/per-season JSON via api.github.com. */
export async function loadMatchesFromOpenfootball(
  leagueSlug: string | null,
  seasons: string[],
): Promise<{ matches: HistoricalMatch[]; notes: string[] }> {
  const repo = process.env.HISTORICAL_OPENFOOTBALL_REPO ?? OPENFOOTBALL_REPO;
  const code = leagueSlug ? OPENFOOTBALL_CODES[leagueSlug] : undefined;
  if (!leagueSlug || !code) {
    return { matches: [], notes: [`no openfootball mapping for ${leagueSlug ?? "all leagues"}`] };
  }

  const matches: HistoricalMatch[] = [];
  const notes: string[] = [];
  for (const season of seasons) {
    const url = `https://api.github.com/repos/${repo}/contents/${season}/${code}.json`;
    const response = await fetchWithTimeout(url, {
      text: true,
      timeoutMs: GITHUB_TIMEOUT_MS,
      headers: { Accept: "application/vnd.github.raw+json" },
    });
    if (response.status !== "ok" || typeof response.data !== "string") {
      notes.push(`${season}: ${response.status}`);
      continue;
    }

    let parsed: { matches?: OpenfootballMatch[] } | OpenfootballMatch[];
    try {
      parsed = JSON.parse(response.data) as { matches?: OpenfootballMatch[] } | OpenfootballMatch[];
    } catch {
      notes.push(`${season}: invalid JSON`);
      continue;
    }

    const rows = Array.isArray(parsed) ? parsed : (parsed.matches ?? []);
    for (const row of rows) {
      const home = nonEmpty(row.team1);
      const away = nonEmpty(row.team2);
      const matchDate = parseHistoricalDate(nonEmpty(row.date));
      if (!home || !away || !matchDate) continue;
      // Scheduled fixtures carry no score at all and are dropped rather than
      // silently read as 0-0; see `fullTimeScore` for the two result encodings.
      const ft = fullTimeScore(row.score);
      if (!ft) continue;
      const [homeGoals, awayGoals] = ft;
      matches.push({
        id: makeMatchId(leagueSlug, home, away, matchDate),
        homeTeam: home,
        awayTeam: away,
        leagueSlug,
        matchDate,
        homeGoals,
        awayGoals,
        competitionName: `${leagueSlug} ${season}`,
        source: "openfootball",
      });
    }
  }
  if (!matches.length && !notes.length) notes.push("openfootball returned no completed matches");
  return { matches, notes };
}

// ─── Layer 4: ESPN scoreboard cache ───────────────────────────────────────────

function espnRange(lookbackDays: number, now: Date): string {
  const fmt = (date: Date): string => date.toISOString().slice(0, 10).replace(/-/g, "");
  const from = new Date(now.getTime() - lookbackDays * 86_400_000);
  return `${fmt(from)}-${fmt(now)}`;
}

/** Recent completed matches from the app's existing ESPN scoreboard reader. */
export async function loadMatchesFromEspn(
  leagueSlug: string | null,
  lookbackDays: number,
  now: Date,
): Promise<{ matches: HistoricalMatch[]; notes: string[] }> {
  if (!leagueSlug) return { matches: [], notes: ["the ESPN layer needs a single league slug"] };
  try {
    const { fetchScoreboard } = await import("@/lib/espn");
    const fixtures = await fetchScoreboard(leagueSlug, espnRange(lookbackDays, now));
    const matches: HistoricalMatch[] = [];
    for (const fixture of fixtures) {
      if (fixture.state !== "post") continue;
      const homeGoals = parseGoals(fixture.home.score);
      const awayGoals = parseGoals(fixture.away.score);
      const matchDate = parseHistoricalDate(fixture.date);
      if (!fixture.home.name || !fixture.away.name || homeGoals === null || awayGoals === null || !matchDate) {
        continue;
      }
      matches.push({
        id: makeMatchId(fixture.leagueSlug, fixture.home.name, fixture.away.name, matchDate),
        homeTeam: fixture.home.name,
        awayTeam: fixture.away.name,
        leagueSlug: fixture.leagueSlug,
        matchDate,
        homeGoals,
        awayGoals,
        competitionName: fixture.leagueName,
        source: "espn",
      });
    }
    return { matches, notes: matches.length ? [] : ["ESPN scoreboard returned no completed matches"] };
  } catch (error) {
    return { matches: [], notes: [`ESPN unavailable (${error instanceof Error ? error.message : String(error)})`] };
  }
}

// ─── Orchestration ────────────────────────────────────────────────────────────

const DEFAULT_LAYERS: HistoricalSource[] = ["database", "github-datasets", "openfootball", "espn"];

function cacheKey(options: HistoricalLoadOptions): string {
  return [
    options.leagueSlug ?? "all",
    options.seasons ?? DEFAULT_SEASONS,
    options.minMatches ?? MIN_USEFUL_MATCHES,
    options.maxMatches ?? DEFAULT_MAX_MATCHES,
    options.lookbackDays ?? DEFAULT_ESPN_LOOKBACK_DAYS,
    (options.layers ?? DEFAULT_LAYERS).join("+"),
  ].join("|");
}

const cache = new Map<string, { at: number; dataset: HistoricalDataset }>();

/**
 * Load completed matches, walking the sourcing layers until `minMatches` have
 * been accumulated. Never throws: an unreachable source is recorded in
 * `sources` and the walk continues to the next layer.
 */
export async function loadHistoricalMatches(
  options: HistoricalLoadOptions = {},
): Promise<HistoricalDataset> {
  const now = options.now ?? new Date();
  const seasons = Math.max(1, options.seasons ?? DEFAULT_SEASONS);
  const minMatches = Math.max(1, options.minMatches ?? MIN_USEFUL_MATCHES);
  const maxMatches = Math.max(minMatches, options.maxMatches ?? DEFAULT_MAX_MATCHES);
  const leagueSlug = options.leagueSlug ?? null;
  const layers = options.layers ?? DEFAULT_LAYERS;

  if (!options.force) {
    const cached = cache.get(cacheKey(options));
    if (cached && now.getTime() - cached.at < CACHE_TTL_MS) return cached.dataset;
  }

  const seasonList = seasonCodes(now, seasons);
  // Rolling window: the requested number of full seasons plus the partial one.
  const sinceIso = `${seasonList[0].slice(0, 4)}-07-01T00:00:00Z`;

  const seen = new Set<string>();
  const collected: HistoricalMatch[] = [];
  const reports: SourceReport[] = [];

  const addMatches = (matches: HistoricalMatch[]): number => {
    let added = 0;
    for (const match of matches) {
      if (seen.has(match.id)) continue;
      seen.add(match.id);
      collected.push(match);
      added++;
    }
    return added;
  };

  const attempt = async (
    source: HistoricalSource,
    run: () => Promise<{ matches: HistoricalMatch[]; notes: string[] }>,
  ): Promise<void> => {
    if (!layers.includes(source)) {
      reports.push({ source, attempted: false, added: 0, note: "layer disabled by caller" });
      return;
    }
    // Layer 1 is the documented primary and always runs; later layers are the
    // "insufficient historical data" fallback and are skipped once the dataset
    // is big enough to model on.
    if (source !== "database" && collected.length >= minMatches) {
      reports.push({
        source,
        attempted: false,
        added: 0,
        note: `skipped: ${collected.length} matches already collected (min ${minMatches})`,
      });
      return;
    }
    try {
      const { matches, notes } = await run();
      const added = addMatches(matches);
      const duplicates = matches.length - added;
      reports.push({
        source,
        attempted: true,
        added,
        note: duplicates > 0 ? `${duplicates} duplicate(s) dropped` : notes.join("; "),
      });
    } catch (error) {
      reports.push({
        source,
        attempted: true,
        added: 0,
        note: `error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  await attempt("database", () => loadMatchesFromDatabase(leagueSlug, sinceIso, maxMatches));
  await attempt("github-datasets", () => loadMatchesFromCsvSources(leagueSlug, seasonList));
  await attempt("openfootball", () => loadMatchesFromOpenfootball(leagueSlug, seasonList));
  await attempt("espn", () =>
    loadMatchesFromEspn(leagueSlug, options.lookbackDays ?? DEFAULT_ESPN_LOOKBACK_DAYS, now),
  );

  // Rolling-season filter. If it would leave too little to model on, the full
  // history is kept instead — more real data beats an arbitrary window.
  let ordered = dedupeAndSortMatches(collected);
  const windowed = matchesFrom(ordered, sinceIso);
  if (windowed.length >= MIN_USEFUL_MATCHES || windowed.length === ordered.length) ordered = windowed;
  if (ordered.length > maxMatches) ordered = ordered.slice(ordered.length - maxMatches);

  const dataset = datasetFromMatches(ordered, reports, now);
  cache.set(cacheKey(options), { at: now.getTime(), dataset });
  return dataset;
}

/** Drop the in-memory cache (used by `?refresh=true` and by tests). */
export function clearHistoricalCache(): void {
  cache.clear();
}
