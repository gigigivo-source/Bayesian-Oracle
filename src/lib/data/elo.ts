// ĞIGI GIVØ — ELO rating system.
//
// A single global pool per team, replayed chronologically over the completed
// matches returned by the historical aggregator. The rating is a *team-strength
// prior*: it does not replace the attack/defence goal model, it modulates it
// (see `eloLambdaMultipliers`), which is how it enters the correct-score
// prediction.
//
// Rules implemented exactly as specified:
//   · every team starts at 1500;
//   · K = 20 friendly / 30 league / 40 cup-or-knockout;
//   · E_home = 1 / (1 + 10^((elo_away − elo_home) / 400));
//   · elo_home_new = elo_home + K × (actual − E_home), actual ∈ {1, 0.5, 0};
//   · matches are processed oldest → newest.
//
// Home advantage is applied to the *expected score* (a standard 60–80 point
// home bonus) rather than to the rating itself, so a team's stored rating stays
// venue-independent and comparable across fixtures.

import {
  loadHistoricalMatches,
  normaliseTeamName,
  teamsMatch,
  type HistoricalLoadOptions,
  type HistoricalMatch,
} from "./historical";

// ─── Constants ────────────────────────────────────────────────────────────────

export const INITIAL_ELO = 1500;

export type MatchImportance = "friendly" | "league" | "cup";

/** K-factor by match importance, exactly as specified. */
export const K_FACTORS: Record<MatchImportance, number> = {
  friendly: 20,
  league: 30,
  cup: 40,
};

/**
 * Points added to the home side when computing the expected score. 65 is the
 * conventional Premier-League/European top-flight home edge on the ELO scale.
 */
export const HOME_ADVANTAGE_ELO = 65;

/**
 * How strongly an ELO gap moves expected goals. 0.25 means a 400-point gap
 * multiplies the home λ by e^0.25 ≈ 1.28 and the away λ by ≈ 0.78 — enough to
 * matter, small enough that a rating error cannot invent a blowout.
 */
export const ELO_GOAL_ELASTICITY = 0.25;

/** Hard bounds on the ELO λ multipliers so no rating can zero out a team. */
const LAMBDA_MULTIPLIER_MIN = 0.55;
const LAMBDA_MULTIPLIER_MAX = 1.85;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EloEntry {
  team: string;
  key: string;
  leagueSlug: string;
  rating: number;
  matchesPlayed: number;
  peak: number;
  trough: number;
  lastPlayed: string | null;
}

export interface EloUpdate {
  homeTeam: string;
  awayTeam: string;
  leagueSlug: string;
  matchDate: string;
  importance: MatchImportance;
  kFactor: number;
  homeBefore: number;
  awayBefore: number;
  expectedHome: number;
  actualHome: number;
  homeAfter: number;
  awayAfter: number;
  delta: number;
}

export interface EloTable {
  /** Keyed `leagueSlug|teamKey`. */
  ratings: Map<string, EloEntry>;
  /** Same entries keyed by team only, for cross-competition lookups. */
  global: Map<string, EloEntry>;
  matchesProcessed: number;
  /** ISO date of the most recent match folded into the ratings. */
  asOf: string | null;
  /** Most recent updates, newest last. Useful for diagnostics. */
  history: EloUpdate[];
}

export interface EloBuildOptions {
  /** Keep the full per-match update trail (default: last 200 updates). */
  keepHistory?: number;
  /** Register the result as the table `getElo` falls back to. Default true. */
  activate?: boolean;
}

// ─── Match classification ─────────────────────────────────────────────────────

const FRIENDLY_PATTERN = /friendly|all[- ]?star|exhibition/i;
const CUP_SLUG_PATTERN =
  /(^|\.)(fa|league_cup|copa_del_rey|dfb_pokal|coppa_italia|coupe_de_france|cup|super|troph|shield|community)/i;
const CUP_NAME_PATTERN =
  /\b(cup|copa|coupe|pokal|coppa|trophy|shield|super\s?cup|community\s?shield|knockout|final|play-?off)\b/i;
const TOURNAMENT_SLUG_PATTERN = /^(uefa|fifa|conmebol|concacaf|afc|caf|ofa)\./i;

/**
 * Classify a fixture for the K-factor. Friendlies are matched first (a
 * "friendly" in a tournament slug must not be promoted to a cup tie), then
 * knockout/international tournaments, then everything else as league football.
 */
export function classifyMatch(match: Pick<HistoricalMatch, "leagueSlug" | "competitionName">): MatchImportance {
  const name = match.competitionName ?? "";
  if (FRIENDLY_PATTERN.test(name)) return "friendly";
  if (CUP_SLUG_PATTERN.test(match.leagueSlug) || CUP_NAME_PATTERN.test(name)) return "cup";
  if (TOURNAMENT_SLUG_PATTERN.test(match.leagueSlug)) return "cup";
  return "league";
}

/** Result of a match from the home side's point of view. */
export function actualResult(homeGoals: number, awayGoals: number): number {
  if (homeGoals > awayGoals) return 1;
  if (homeGoals < awayGoals) return 0;
  return 0.5;
}

/** E_home = 1 / (1 + 10^((elo_away − elo_home) / 400)). */
export function expectedScore(homeElo: number, awayElo: number): number {
  return 1 / (1 + 10 ** ((awayElo - homeElo) / 400));
}

/** Expected score including the home-advantage bonus. */
export function expectedHomeScore(homeElo: number, awayElo: number): number {
  return expectedScore(homeElo + HOME_ADVANTAGE_ELO, awayElo);
}

/** elo_new = elo_old + K × (actual − expected). */
export function applyEloUpdate(elo: number, expected: number, actual: number, kFactor: number): number {
  return elo + kFactor * (actual - expected);
}

// ─── Replay ───────────────────────────────────────────────────────────────────

function entryKey(leagueSlug: string, team: string): string {
  return `${leagueSlug || "unknown"}|${normaliseTeamName(team)}`;
}

export function createEloTable(): EloTable {
  return {
    ratings: new Map(),
    global: new Map(),
    matchesProcessed: 0,
    asOf: null,
    history: [],
  };
}

function entryFor(table: EloTable, leagueSlug: string, team: string): EloEntry {
  const key = entryKey(leagueSlug, team);
  const existing = table.ratings.get(key);
  if (existing) return existing;
  const created: EloEntry = {
    team,
    key: normaliseTeamName(team),
    leagueSlug,
    rating: INITIAL_ELO,
    matchesPlayed: 0,
    peak: INITIAL_ELO,
    trough: INITIAL_ELO,
    lastPlayed: null,
  };
  table.ratings.set(key, created);
  return created;
}

/**
 * Fold one completed match into the table. Call in chronological order — the
 * replay is path-dependent by construction, so `buildEloRatings` sorts first.
 */
export function applyMatchToElo(table: EloTable, match: HistoricalMatch, keepHistory = 200): EloUpdate | null {
  if (!match.homeTeam || !match.awayTeam) return null;
  if (teamsMatch(match.homeTeam, match.awayTeam)) return null;

  const importance = classifyMatch(match);
  const kFactor = K_FACTORS[importance];
  const home = entryFor(table, match.leagueSlug, match.homeTeam);
  const away = entryFor(table, match.leagueSlug, match.awayTeam);

  const expectedHome = expectedHomeScore(home.rating, away.rating);
  const actual = actualResult(match.homeGoals, match.awayGoals);
  const delta = kFactor * (actual - expectedHome);

  home.rating = applyEloUpdate(home.rating, expectedHome, actual, kFactor);
  away.rating = applyEloUpdate(away.rating, 1 - expectedHome, 1 - actual, kFactor);

  for (const entry of [home, away]) {
    entry.matchesPlayed++;
    entry.peak = Math.max(entry.peak, entry.rating);
    entry.trough = Math.min(entry.trough, entry.rating);
    entry.lastPlayed = match.matchDate;
    table.global.set(entry.key, entry);
  }

  table.matchesProcessed++;
  table.asOf = match.matchDate;

  const update: EloUpdate = {
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    leagueSlug: match.leagueSlug,
    matchDate: match.matchDate,
    importance,
    kFactor,
    homeBefore: home.rating - delta,
    awayBefore: away.rating + delta,
    expectedHome,
    actualHome: actual,
    homeAfter: home.rating,
    awayAfter: away.rating,
    delta,
  };
  table.history.push(update);
  if (keepHistory > 0 && table.history.length > keepHistory) {
    table.history.splice(0, table.history.length - keepHistory);
  }
  return update;
}

/** Replay every match oldest → newest and return the resulting ratings. */
export function buildEloRatings(
  matches: HistoricalMatch[],
  options: EloBuildOptions = {},
): EloTable {
  const table = createEloTable();
  const ordered = [...matches].sort(
    (left, right) => new Date(left.matchDate).getTime() - new Date(right.matchDate).getTime(),
  );
  for (const match of ordered) applyMatchToElo(table, match, options.keepHistory ?? 200);
  if (options.activate !== false) setActiveEloTable(table);
  return table;
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

let activeTable: EloTable | null = null;

/** Register the table `getElo` reads when no table is passed explicitly. */
export function setActiveEloTable(table: EloTable | null): void {
  activeTable = table;
}

export function getActiveEloTable(): EloTable | null {
  return activeTable;
}

/**
 * Current ELO rating for a team.
 *
 * Resolution order: exact `league|team` entry → the team's entry in any
 * competition (a promoted side or a cup tie still resolves) → `INITIAL_ELO`
 * for a team with no history. Unknown teams are rated, never invented: 1500 is
 * the documented starting rating, and callers can tell a cold start from a
 * rated team via `hasElo`.
 */
export function getElo(team: string, league?: string | null, table: EloTable | null = activeTable): number {
  return findEloEntry(team, league, table)?.rating ?? INITIAL_ELO;
}

/** Same lookup as `getElo`, but null when the team has no replayed history. */
export function findEloEntry(
  team: string,
  league?: string | null,
  table: EloTable | null = activeTable,
): EloEntry | null {
  if (!table) return null;
  const key = normaliseTeamName(team);
  if (!key) return null;

  if (league) {
    const exact = table.ratings.get(entryKey(league, team));
    if (exact) return exact;
  }
  const global = table.global.get(key);
  if (global) return global;

  for (const entry of table.ratings.values()) {
    if (teamsMatch(entry.team, team)) return entry;
  }
  return null;
}

/** True when the team actually has replayed history (false for a cold 1500). */
export function hasElo(team: string, league?: string | null, table: EloTable | null = activeTable): boolean {
  return findEloEntry(team, league, table) !== null;
}

/** Ratings sorted high → low. Handy for diagnostics endpoints. */
export function eloLeaderboard(table: EloTable, limit = 40): EloEntry[] {
  return [...table.global.values()]
    .sort((left, right) => right.rating - left.rating || right.matchesPlayed - left.matchesPlayed)
    .slice(0, limit);
}

// ─── ELO → expected goals ─────────────────────────────────────────────────────

export interface EloLambdaMultipliers {
  home: number;
  away: number;
  /** Signed rating gap used, home minus away. */
  eloDelta: number;
}

/**
 * Translate an ELO gap into multiplicative λ adjustments. Symmetric and
 * log-linear, so a 400-point gap is always the same proportional shift
 * whichever direction it runs, and the clamp keeps a mis-rated team in play.
 *
 * `elasticity` is the one free parameter of the adjustment and is deliberately
 * exposed: the attack/defence model already measures strength from the same
 * results, so ELO is only adding a recency-weighted second opinion. Too high
 * an elasticity double-counts the strength gap and over-disperses λ.
 */
export function eloLambdaMultipliers(
  homeElo: number,
  awayElo: number,
  elasticity: number = ELO_GOAL_ELASTICITY,
): EloLambdaMultipliers {
  const eloDelta = homeElo - awayElo;
  const exponent = (elasticity * eloDelta) / 400;
  const clamp = (value: number): number =>
    Math.max(LAMBDA_MULTIPLIER_MIN, Math.min(LAMBDA_MULTIPLIER_MAX, value));
  return {
    home: clamp(Math.exp(exponent)),
    away: clamp(Math.exp(-exponent)),
    eloDelta,
  };
}

// ─── Loading ──────────────────────────────────────────────────────────────────

export interface EloTableBundle {
  table: EloTable;
  matches: number;
  seasonsCovered: string[];
  primarySource: string | null;
  sources: Array<{ source: string; attempted: boolean; added: number; note: string }>;
  generatedAt: string;
}

/**
 * Load the historical dataset and replay it into an ELO table. This is what
 * makes the two-argument `getElo(team, league)` form work: the resulting table
 * becomes the active one.
 */
export async function loadEloTable(
  options: HistoricalLoadOptions & EloBuildOptions = {},
): Promise<EloTableBundle> {
  const dataset = await loadHistoricalMatches(options);
  const table = buildEloRatings(dataset.matches, options);
  return {
    table,
    matches: dataset.matchCount,
    seasonsCovered: dataset.seasonsCovered,
    primarySource: dataset.primarySource,
    sources: dataset.sources.map((source) => ({
      source: source.source,
      attempted: source.attempted,
      added: source.added,
      note: source.note,
    })),
    generatedAt: dataset.generatedAt,
  };
}
