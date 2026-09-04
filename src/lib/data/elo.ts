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

import { fetchWithTimeout } from "./http";
import {
  DEFAULT_SEASONS,
  loadHistoricalMatches,
  makeMatchId,
  normaliseTeamName,
  parseGoals,
  parseHistoricalDate,
  seasonCodes,
  teamsMatch,
  type HistoricalLoadOptions,
  type HistoricalMatch,
  type SourceReport,
} from "./historical";
import { parseCsv } from "./sources/githubDatasets";

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

// ─── engsoccerdata source ─────────────────────────────────────────────────────

/** jalapic/engsoccerdata — comprehensive English football results since 1888. */
const ENGSOCCERDATA_REPO = "jalapic/engsoccerdata";
const ENGSOCCERDATA_PATH = "data-raw/england.csv";
const ENGSOCCERDATA_TIMEOUT_MS = 90_000;
const ENGSOCCERDATA_META_TIMEOUT_MS = 30_000;
/** Below this the dataset is too thin to carry meaningful team-strength priors. */
const MIN_ELO_MATCHES = 100;

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
 * Current ELO rating for a team, or `null` when the team has no replayed
 * history in the loaded dataset. Callers must treat `null` as "rating
 * unknown" — there is no synthetic fallback.
 *
 * Resolution order: exact `league|team` entry → the team's entry in any
 * competition (a promoted side or a cup tie still resolves) → `null`.
 */
export function getElo(team: string, league?: string | null, table: EloTable | null = activeTable): number | null {
  return findEloEntry(team, league, table)?.rating ?? null;
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

// ─── engsoccerdata loader ─────────────────────────────────────────────────────

/**
 * Load completed matches from `jalapic/engsoccerdata` via the GitHub Contents
 * API. The `england.csv` file covers every English league tier from 1888 to
 * the present — we filter to tiers 1–2 and the requested rolling-season
 * window so the ELO replay has enough history to rate promoted sides
 * (Coventry City, Hull City, Ipswich Town in 2026/27) without pulling in
 * the entire 15 MB file at once.
 *
 * The Contents API returns raw content for files ≤ 1 MB; for larger files it
 * returns JSON metadata with a `download_url`. We try the raw endpoint first
 * and fall back to the download URL.
 */
export async function loadMatchesFromEngSoccerData(
  options: { seasons?: string[]; maxTier?: number } = {},
): Promise<{ matches: HistoricalMatch[]; notes: string[] }> {
  const maxTier = options.maxTier ?? 2;
  const seasonYears = new Set(
    (options.seasons ?? []).map((s) => parseInt(s.slice(0, 4), 10)),
  );

  const contentsUrl =
    `https://api.github.com/repos/${ENGSOCCERDATA_REPO}/contents/${ENGSOCCERDATA_PATH}`;

  // Attempt 1: raw content (works for files ≤ 1 MB).
  let csvText: string | null = null;
  const rawRes = await fetchWithTimeout(contentsUrl, {
    text: true,
    timeoutMs: ENGSOCCERDATA_TIMEOUT_MS,
    headers: { Accept: "application/vnd.github.raw+json" },
  });

  if (rawRes.status === "ok" && typeof rawRes.data === "string" && rawRes.data.length > 100) {
    csvText = rawRes.data;
  } else {
    // Attempt 2: fetch metadata JSON → download_url (for files > 1 MB).
    console.info(
      `[Elo] engsoccerdata raw fetch: ${rawRes.status}${rawRes.status === "http-error" ? ` (HTTP ${rawRes.httpStatus})` : ""} — trying download_url`,
    );
    const metaRes = await fetchWithTimeout(contentsUrl, {
      text: false,
      timeoutMs: ENGSOCCERDATA_META_TIMEOUT_MS,
    });
    if (metaRes.status === "ok" && metaRes.data && typeof metaRes.data === "object") {
      const downloadUrl = (metaRes.data as Record<string, unknown>).download_url;
      if (typeof downloadUrl === "string") {
        const dlRes = await fetchWithTimeout(downloadUrl, {
          text: true,
          timeoutMs: ENGSOCCERDATA_TIMEOUT_MS,
        });
        if (dlRes.status === "ok" && typeof dlRes.data === "string" && dlRes.data.length > 100) {
          csvText = dlRes.data;
        } else {
          return {
            matches: [],
            notes: [`engsoccerdata download_url: ${dlRes.status}`],
          };
        }
      } else {
        return { matches: [], notes: ["engsoccerdata: no download_url in metadata"] };
      }
    } else {
      return {
        matches: [],
        notes: [`engsoccerdata metadata: ${metaRes.status}`],
      };
    }
  }

  // Parse CSV — the file uses standard comma-separated quoting.
  const rows = parseCsv(csvText, 60_000);
  if (rows.length < 2) {
    return { matches: [], notes: ["engsoccerdata: empty or unparseable CSV"] };
  }

  // Build column index from the header row.
  const header = rows[0];
  const norm = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const colMap = new Map<string, number>();
  header.forEach((cell, i) => {
    const key = norm(cell);
    if (!colMap.has(key)) colMap.set(key, i);
  });

  const dateCol = colMap.get("date");
  const seasonCol = colMap.get("season");
  const homeCol = colMap.get("home");
  const visitorCol = colMap.get("visitor") ?? colMap.get("away");
  const hgoalCol = colMap.get("hgoal") ?? colMap.get("homegoals");
  const vgoalCol = colMap.get("vgoal") ?? colMap.get("awaygoals");
  const tierCol = colMap.get("tier");

  if (
    homeCol === undefined ||
    visitorCol === undefined ||
    hgoalCol === undefined ||
    vgoalCol === undefined
  ) {
    return {
      matches: [],
      notes: ["engsoccerdata: missing required columns (home/visitor/hgoal/vgoal)"],
    };
  }

  const matches: HistoricalMatch[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    // Tier filter: 1 = top flight, 2 = second tier (for promoted-team history).
    if (tierCol !== undefined) {
      const tier = parseInt(row[tierCol], 10);
      if (!Number.isFinite(tier) || tier > maxTier) continue;
    }

    // Season filter: keep only the rolling window.
    if (seasonCol !== undefined && seasonYears.size > 0) {
      const seasonVal = parseInt(row[seasonCol], 10);
      if (!Number.isFinite(seasonVal) || !seasonYears.has(seasonVal)) continue;
    }

    const home = row[homeCol]?.trim();
    const away = row[visitorCol]?.trim();
    const homeGoals = parseGoals(row[hgoalCol]);
    const awayGoals = parseGoals(row[vgoalCol]);
    const matchDate = dateCol !== undefined ? parseHistoricalDate(row[dateCol]) : null;

    if (!home || !away || homeGoals === null || awayGoals === null || !matchDate) continue;

    const tier = tierCol !== undefined ? parseInt(row[tierCol], 10) : 1;
    const leagueSlug = tier <= 1 ? "eng.1" : `eng.${tier}`;

    matches.push({
      id: makeMatchId(leagueSlug, home, away, matchDate),
      homeTeam: home,
      awayTeam: away,
      leagueSlug,
      matchDate,
      homeGoals,
      awayGoals,
      competitionName: tier <= 1 ? "Premier League" : `English Tier ${tier}`,
      source: "github-datasets",
    });
  }

  return { matches, notes: [] };
}

// ─── Loading ──────────────────────────────────────────────────────────────────

export interface EloTableBundle {
  table: EloTable;
  matches: number;
  seasonsCovered: string[];
  primarySource: string | null;
  sources: Array<{ source: string; attempted: boolean; added: number; note: string }>;
  generatedAt: string;
  /** Present when the model has no data and should not be used for predictions. */
  error?: string;
}

/**
 * Load the historical dataset and replay it into an ELO table. This is what
 * makes the two-argument `getElo(team, league)` form work: the resulting table
 * becomes the active one.
 *
 * When the primary historical sources return too few matches the
 * `jalapic/engsoccerdata` CSV is fetched as a supplementary layer so that
 * promoted sides and lower-tier clubs carry real ratings into the model.
 *
 * If *no* source produces data the bundle carries an `error` string and the
 * caller must not use the table for predictions.
 */
export async function loadEloTable(
  options: HistoricalLoadOptions & EloBuildOptions = {},
): Promise<EloTableBundle> {
  const dataset = await loadHistoricalMatches(options);

  let allMatches = [...dataset.matches];
  const sources: SourceReport[] = [...dataset.sources];

  // Supplement with engsoccerdata when the primary sources are too thin.
  if (allMatches.length < MIN_ELO_MATCHES) {
    const now = options.now ?? new Date();
    const seasons = Math.max(1, options.seasons ?? DEFAULT_SEASONS);
    const seasonList = seasonCodes(now, seasons + 1); // +1 for promoted-team history

    console.info(
      `[Elo] Primary sources returned ${allMatches.length} matches (min ${MIN_ELO_MATCHES}), loading engsoccerdata...`,
    );

    try {
      const engData = await loadMatchesFromEngSoccerData({
        seasons: seasonList,
        maxTier: 2,
      });

      if (engData.matches.length > 0) {
        const seen = new Set(allMatches.map((m) => m.id));
        let added = 0;
        for (const match of engData.matches) {
          if (!seen.has(match.id)) {
            seen.add(match.id);
            allMatches.push(match);
            added++;
          }
        }
        sources.push({
          source: "github-datasets",
          attempted: true,
          added,
          note: added > 0
            ? `engsoccerdata: ${added} new matches (${engData.matches.length} parsed)`
            : "engsoccerdata: all matches already present",
        });
        console.info(
          `[Elo] engsoccerdata: added ${added} new matches from ${engData.matches.length} parsed`,
        );
      } else {
        sources.push({
          source: "github-datasets",
          attempted: true,
          added: 0,
          note: engData.notes.join("; ") || "engsoccerdata: no usable matches",
        });
        console.warn(`[Elo] engsoccerdata: ${engData.notes.join("; ") || "no usable matches"}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sources.push({
        source: "github-datasets",
        attempted: true,
        added: 0,
        note: `engsoccerdata error: ${message}`,
      });
      console.warn(`[Elo] engsoccerdata error: ${message}`);
    }
  }

  // Sort all matches chronologically before replaying.
  allMatches.sort(
    (a, b) => new Date(a.matchDate).getTime() - new Date(b.matchDate).getTime(),
  );

  // Hard failure: no data at all → the model must not run.
  if (allMatches.length === 0) {
    const reasons = sources
      .map((s) => `${s.source}: ${s.note || "no matches"}`)
      .join("; ");
    const error = `[Elo] Failed to load data: ${reasons}`;
    console.error(error);
    return {
      table: createEloTable(),
      matches: 0,
      seasonsCovered: [],
      primarySource: null,
      sources: sources.map((s) => ({
        source: s.source,
        attempted: s.attempted,
        added: s.added,
        note: s.note,
      })),
      generatedAt: new Date().toISOString(),
      error,
    };
  }

  const table = buildEloRatings(allMatches, options);
  const seasons = new Set<string>();
  for (const m of allMatches) {
    const y = new Date(m.matchDate).getUTCFullYear();
    const start = new Date(m.matchDate).getUTCMonth() >= 6 ? y : y - 1;
    seasons.add(`${start}-${String((start + 1) % 100).padStart(2, "0")}`);
  }

  console.info(
    `[Elo] Loaded ${allMatches.length} historical matches for Premier League ` +
      `(${[...seasons].sort().join(", ")}) — ${table.global.size} teams rated`,
  );

  return {
    table,
    matches: allMatches.length,
    seasonsCovered: [...seasons].sort(),
    primarySource: dataset.primarySource,
    sources: sources.map((s) => ({
      source: s.source,
      attempted: s.attempted,
      added: s.added,
      note: s.note,
    })),
    generatedAt: dataset.generatedAt,
  };
}

// ─── Tennis ELO (ATP / WTA) ───────────────────────────────────────────────────
//
// The second sport of the supercomputer. Football ratings live in one global
// pool per league; tennis keeps one pool per tour (ATP and WTA players never
// meet) *and* one rating per surface:
//
//   · elo_clay, elo_grass, elo_hard — each updated only from matches played on
//     that surface;
//   · K = 32 (ATP) / 45 (WTA), ×1.5 for a player's first 10 rated matches on
//     the surface (the standard new-player convergence boost);
//   · no home advantage (tennis has no team venues), so the plain expectation
//     formula is used: E = 1 / (1 + 10^((eloB − eloA) / 400));
//   · the surface multiplier (clay 1.1× / grass 1.3× / hard 1.0×) is applied
//     ONLY at prediction time (`surfaceAdjustedElo`), never inside the replay,
//     so a stored rating is a pure measurement of what happened on court.
//       · Clay  → 1.1×  slow courts keep rallies alive: the stronger player's
//                       edge is slightly amplified;
//       · Grass → 1.3×  the most serve-dominated surface — breaks are scarce
//                       and a rating gap counts for the most;
//       · Hard  → 1.0×  the neutral baseline.
//
// There is no default rating. A player with no replayed match on a surface has
// `null` there — `getTennisElo` returns null and the API refuses to price the
// fixture rather than falling back to 1500.

import type { TennisMatch, TennisSurface, TennisTour } from "./sources/tennis";
import { TENNIS_SURFACES, tennisPlayerKey, playerNamesMatch } from "./sources/tennis";

/** Rating a player *starts* from. Never used as a fallback for a missing one. */
export const TENNIS_INITIAL_ELO = 1500;

/** Base K-factor per tour: ATP 32, WTA 45 (the women's tour is more volatile). */
export const TENNIS_K_FACTORS: Record<TennisTour, number> = { atp: 32, wta: 45 };

/** New players converge faster: K is multiplied by this for the first matches. */
export const TENNIS_NEW_PLAYER_BOOST = 1.5;
export const TENNIS_NEW_PLAYER_MATCHES = 10;

/**
 * Surface multipliers applied to the rating *gap* at prediction time
 * (see the table in the header comment).
 */
export const TENNIS_SURFACE_ELO_MODIFIERS: Record<TennisSurface, number> = {
  clay: 1.1,
  grass: 1.3,
  hard: 1.0,
};

/** Modifier for a surface; 1.0 when the surface is unknown. */
export function surfaceEloModifier(surface: TennisSurface | null | undefined): number {
  if (!surface) return 1.0;
  return TENNIS_SURFACE_ELO_MODIFIERS[surface] ?? 1.0;
}

/**
 * Effective rating on a surface: the player's distance from the 1500 baseline
 * scaled by the surface modifier (1700 → 1760 on grass, 1720 on clay).
 * Prediction-time only — it never touches the stored rating.
 */
export function surfaceAdjustedElo(
  rating: number,
  surface: TennisSurface | null | undefined,
): number {
  const modifier = surfaceEloModifier(surface);
  return TENNIS_INITIAL_ELO + (rating - TENNIS_INITIAL_ELO) * modifier;
}

/**
 * Expected score for player A against player B on a surface — the surface
 * modifier widens or narrows the effective rating gap.
 */
export function expectedScoreTennis(
  eloA: number,
  eloB: number,
  surface: TennisSurface | null | undefined = null,
): number {
  return expectedScore(surfaceAdjustedElo(eloA, surface), surfaceAdjustedElo(eloB, surface));
}

/**
 * K-factor for one tennis match: 32 on the ATP tour, 45 on the WTA tour, both
 * ×1.5 while the player is still inside their first 10 rated matches on the
 * surface being updated.
 */
export function tennisKFactor(tour: TennisTour, matchesPlayed: number): number {
  const base = TENNIS_K_FACTORS[tour] ?? TENNIS_K_FACTORS.atp;
  const played = Number.isFinite(matchesPlayed) ? Math.max(0, matchesPlayed) : 0;
  return played < TENNIS_NEW_PLAYER_MATCHES ? base * TENNIS_NEW_PLAYER_BOOST : base;
}

export interface TennisEloEntry {
  player: string;
  /** Normalised lookup key (see `tennisPlayerKey`). */
  key: string;
  tour: TennisTour;
  /** Surface-specific ratings. `null` = no replayed match on that surface. */
  ratings: Record<TennisSurface, number | null>;
  /** Rated matches on each surface — backs `getTennisElo`'s null contract. */
  surfaceMatches: Record<TennisSurface, number>;
  matchesPlayed: number;
  wins: number;
  lastPlayed: string | null;
  peak: number;
  trough: number;
}

export interface TennisEloUpdate {
  winner: string;
  loser: string;
  tournament: string;
  surface: TennisSurface | null;
  matchDate: string;
  bestOf: 3 | 5 | null;
  kFactor: number;
  winnerBefore: number;
  loserBefore: number;
  expectedWinner: number;
  winnerAfter: number;
  loserAfter: number;
  /** True when one side's rating on this surface was seeded in this match. */
  seeded: boolean;
}

export interface TennisEloTable {
  /** Keyed `${tour}|${playerKey}` — the ATP and WTA pools never mix. */
  players: Map<string, TennisEloEntry>;
  matchesProcessed: number;
  /** ISO date of the most recent match folded into the ratings. */
  asOf: string | null;
  /** Matches skipped because the source did not record a surface. */
  skippedNoSurface: number;
}

export function createTennisEloTable(): TennisEloTable {
  return { players: new Map(), matchesProcessed: 0, asOf: null, skippedNoSurface: 0 };
}

function tennisEntryFor(
  table: TennisEloTable,
  tour: TennisTour,
  player: string,
): TennisEloEntry {
  const key = `${tour}|${tennisPlayerKey(player)}`;
  const existing = table.players.get(key);
  if (existing) return existing;
  const created: TennisEloEntry = {
    player,
    key: tennisPlayerKey(player),
    tour,
    ratings: { clay: null, grass: null, hard: null },
    surfaceMatches: { clay: 0, grass: 0, hard: 0 },
    matchesPlayed: 0,
    wins: 0,
    lastPlayed: null,
    peak: TENNIS_INITIAL_ELO,
    trough: TENNIS_INITIAL_ELO,
  };
  table.players.set(key, created);
  return created;
}

/**
 * Seed a first rating on a surface from the player's own measured ratings on
 * the other surfaces (match-weighted). This is a transfer of that player's
 * real results, not a synthetic default — a debutant with no rating anywhere
 * starts from the ELO baseline like every ELO system.
 */
export function seedSurfaceRating(
  entry: TennisEloEntry,
  surface: TennisSurface,
): { rating: number; seeded: boolean } {
  const existing = entry.ratings[surface];
  if (existing !== null) return { rating: existing, seeded: false };
  let weighted = 0;
  let weight = 0;
  for (const other of TENNIS_SURFACES) {
    if (other === surface) continue;
    const rating = entry.ratings[other];
    const matches = entry.surfaceMatches[other];
    if (rating === null || matches <= 0) continue;
    weighted += rating * matches;
    weight += matches;
  }
  if (weight > 0) return { rating: weighted / weight, seeded: true };
  return { rating: TENNIS_INITIAL_ELO, seeded: entry.matchesPlayed === 0 };
}

/**
 * Fold one completed match into the table, updating only the rating for the
 * surface it was played on.
 *
 * Walkovers and defaults are skipped (no on-court result to learn from);
 * retirements still count — they are official wins. Matches with no recorded
 * surface are skipped as well: a surface-specific rating cannot be updated
 * from them. Call in chronological order (`buildTennisEloTable` sorts).
 */
export function applyTennisMatchToElo(
  table: TennisEloTable,
  match: TennisMatch,
): TennisEloUpdate | null {
  if (match.finish === "walkover") return null;
  if (!match.winner || !match.loser) return null;
  if (tennisPlayerKey(match.winner) === tennisPlayerKey(match.loser)) return null;
  const surface = match.surface;
  if (!surface) {
    table.skippedNoSurface++;
    return null;
  }

  const winner = tennisEntryFor(table, match.tour, match.winner);
  const loser = tennisEntryFor(table, match.tour, match.loser);
  const seededWinner = seedSurfaceRating(winner, surface);
  const seededLoser = seedSurfaceRating(loser, surface);
  const kFactor = tennisKFactor(match.tour, winner.surfaceMatches[surface]);

  const winnerBefore = seededWinner.rating;
  const loserBefore = seededLoser.rating;
  // Plain ELO expectation — the surface multiplier is prediction-time only.
  const expectedWinner = expectedScore(winnerBefore, loserBefore);
  const delta = kFactor * (1 - expectedWinner);
  const winnerAfter = winnerBefore + delta;
  const loserAfter = loserBefore - delta;

  winner.ratings[surface] = winnerAfter;
  loser.ratings[surface] = loserAfter;

  for (const [entry, rating, won] of [
    [winner, winnerAfter, true],
    [loser, loserAfter, false],
  ] as const) {
    entry.matchesPlayed++;
    if (won) entry.wins++;
    entry.surfaceMatches[surface]++;
    entry.lastPlayed = match.matchDate;
    entry.peak = Math.max(entry.peak, rating);
    entry.trough = Math.min(entry.trough, rating);
  }

  table.matchesProcessed++;
  table.asOf = match.matchDate;

  return {
    winner: match.winner,
    loser: match.loser,
    tournament: match.tournament,
    surface,
    matchDate: match.matchDate,
    bestOf: match.bestOf,
    kFactor,
    winnerBefore,
    loserBefore,
    expectedWinner,
    winnerAfter,
    loserAfter,
    seeded: seededWinner.seeded || seededLoser.seeded,
  };
}

/** Replay every match oldest → newest and return the resulting ratings. */
export function buildTennisEloTable(matches: TennisMatch[]): TennisEloTable {
  const table = createTennisEloTable();
  const ordered = [...matches].sort((a, b) => a.matchDate.localeCompare(b.matchDate));
  for (const match of ordered) applyTennisMatchToElo(table, match);
  return table;
}

/**
 * Rating entry for a player: exact key first, then a fuzzy name match so the
 * ESPN feed's "F. Tiafoe" resolves against the dataset's "Frances Tiafoe"
 * (without letting M. Zverev and A. Zverev collide — see `playerNamesMatch`).
 */
export function findTennisEloEntry(
  table: TennisEloTable,
  player: string,
  tour: TennisTour,
): TennisEloEntry | null {
  const exact = table.players.get(`${tour}|${tennisPlayerKey(player)}`);
  if (exact) return exact;
  for (const entry of table.players.values()) {
    if (entry.tour === tour && playerNamesMatch(entry.player, player)) return entry;
  }
  return null;
}

/**
 * The tennis `getElo(playerName, surface) → number | null` of the prediction
 * spec (named `getTennisElo` here because the football `getElo(team, league)`
 * owns the short name in this module).
 *
 * Returns the player's rating on that surface, or `null` when they have no
 * replayed match on it — there is no default, and callers must treat `null` as
 * "this player cannot be rated here", not as 1500.
 */
export function getTennisElo(
  table: TennisEloTable,
  player: string,
  surface: TennisSurface,
  tour: TennisTour,
): number | null {
  const entry = findTennisEloEntry(table, player, tour);
  if (!entry) return null;
  if ((entry.surfaceMatches[surface] ?? 0) <= 0) return null;
  const rating = entry.ratings[surface];
  return rating === null || !Number.isFinite(rating) ? null : rating;
}

/**
 * Per-match ELO diagnostic required by the prediction spec:
 * `[elo] Surface: {surface}, players: {home} ({eloHome}) vs {away} ({eloAway})`
 */
export function logTennisEloMatchup(
  surface: TennisSurface | null,
  home: string,
  eloHome: number | null,
  away: string,
  eloAway: number | null,
  logger: (message: string) => void = (message) => console.info(message),
): void {
  const fmt = (elo: number | null): string => (elo === null ? "null" : String(Math.round(elo)));
  logger(
    `[elo] Surface: ${surface ?? "unknown"}, players: ${home} (${fmt(eloHome)}) vs ${away} (${fmt(eloAway)})`,
  );
}
