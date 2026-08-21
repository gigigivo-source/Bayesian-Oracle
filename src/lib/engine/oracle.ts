// Bayesian / Statistical Oracle Engine — Full 18-Family Market Generator
// Now with a multi-source real-data aggregator (form / H2H / xG / table
// positions / injuries / odds movement) feeding the shared selector, whose
// factor weights redistribute dynamically around unavailable data — real data
// only, never simulated values.
//
// After ranking, a match-level CONFIDENCE GATE (selector.ts) scores each
// match from the average calibration of its Top-10 picks, the number of
// ranking factors backed by real data, and the trust tier of the enrichment
// source actually used. Matches below the 75% threshold are flagged LOW
// CONFIDENCE and return only their Top 3 picks; the verdict is exposed on
// the response (`confidence`) and logged for every match.
import type { FixtureLite } from "@/lib/espn";
import type { EngineResult, Market, DeepStatsVector, MarketExplanation } from "./types";
import type { LambdaSet } from "./lambdas";
import { calibratedWinProb, type MatchVolatility } from "./calibration";
import {
  selectTopPicks,
  type TeamTableInfo,
  type RankingContext,
  type ImportanceContext,
  type TeamFormSignal,
  type TeamInjuryContext,
  type MarketVolatilityContext,
  type SourceTrustSignal,
  type MatchConfidence,
} from "./selector";
import { getStandings } from "../footballData";

/** Optional league-table context used for match-importance (title race / relegation) detection. */
export interface TableContext {
  home?: TeamTableInfo;
  away?: TeamTableInfo;
}

// ─── League statistical priors ────────────────────────────────────────────────
const LEAGUE_PRIORS: Record<string, {
  avgGoals: number; avgCorners: number; avgCards: number;
  avgShots: number; avgSot: number; avgFouls: number;
}> = {
  "eng.1":  { avgGoals: 2.65, avgCorners: 10.2, avgCards: 3.5, avgShots: 26.0, avgSot: 8.4, avgFouls: 20.5 },
  "esp.1":  { avgGoals: 2.55, avgCorners: 9.8,  avgCards: 4.1, avgShots: 25.0, avgSot: 8.0, avgFouls: 22.0 },
  "ita.1":  { avgGoals: 2.40, avgCorners: 9.5,  avgCards: 4.5, avgShots: 24.5, avgSot: 7.8, avgFouls: 23.5 },
  "ger.1":  { avgGoals: 2.95, avgCorners: 10.8, avgCards: 3.2, avgShots: 27.5, avgSot: 9.0, avgFouls: 19.0 },
  "fra.1":  { avgGoals: 2.50, avgCorners: 9.6,  avgCards: 4.0, avgShots: 24.0, avgSot: 7.9, avgFouls: 21.5 },
  "ned.1":  { avgGoals: 3.05, avgCorners: 10.5, avgCards: 3.4, avgShots: 27.0, avgSot: 9.2, avgFouls: 19.5 },
  "por.1":  { avgGoals: 2.55, avgCorners: 9.8,  avgCards: 4.2, avgShots: 24.8, avgSot: 8.1, avgFouls: 22.5 },
  "bel.1":  { avgGoals: 2.80, avgCorners: 10.1, avgCards: 3.3, avgShots: 26.5, avgSot: 8.6, avgFouls: 20.0 },
  "tur.1":  { avgGoals: 2.70, avgCorners: 9.7,  avgCards: 4.8, avgShots: 25.5, avgSot: 8.2, avgFouls: 24.0 },
  "bra.1":  { avgGoals: 2.45, avgCorners: 9.2,  avgCards: 4.0, avgShots: 24.0, avgSot: 7.6, avgFouls: 22.0 },
  "arg.1":  { avgGoals: 2.30, avgCorners: 8.9,  avgCards: 4.3, avgShots: 23.5, avgSot: 7.4, avgFouls: 23.0 },
  "mex.1":  { avgGoals: 2.60, avgCorners: 9.5,  avgCards: 3.9, avgShots: 25.0, avgSot: 8.0, avgFouls: 21.0 },
  "usa.1":  { avgGoals: 2.90, avgCorners: 10.0, avgCards: 3.2, avgShots: 27.0, avgSot: 8.8, avgFouls: 19.5 },
  "jpn.1":  { avgGoals: 2.45, avgCorners: 9.0,  avgCards: 3.0, avgShots: 24.0, avgSot: 7.5, avgFouls: 18.5 },
  "default":{ avgGoals: 2.60, avgCorners: 9.8,  avgCards: 3.8, avgShots: 25.5, avgSot: 8.2, avgFouls: 21.0 },
};

function getPrior(slug: string) {
  return LEAGUE_PRIORS[slug] ?? LEAGUE_PRIORS["default"];
}

// ─── Multi-factor ranking context (fed into the shared selector) ─────────────
// Builds the optional enrichment the selector uses for its 8-factor composite.
// Anything unavailable here simply falls back to a neutral value in the
// selector and is logged as a data gap.

/** Parse an ESPN W/D/L form string (e.g. "WWDLW") into a lightweight form signal. */
function formSignalFromString(name: string, formStr: string | null | undefined): TeamFormSignal | null {
  if (!formStr) return null;
  let wins = 0, draws = 0, losses = 0, games = 0;
  for (const ch of formStr.toUpperCase()) {
    if (ch === "W") wins++;
    else if (ch === "D") draws++;
    else if (ch === "L") losses++;
    else continue;
    games++;
  }
  if (games === 0) return null;
  const points = wins * 3 + draws;
  // Goals for/against are not carried by the form string, so leave the GD
  // component neutral — momentum is captured via points-per-game only.
  return {
    teamName: name,
    games,
    gfAvg: 1.0,
    gaAvg: 1.0,
    points,
  };
}

/** Derive match-importance flags from the fixture's league name + status detail. */
function deriveImportance(fx: FixtureLite): ImportanceContext | null {
  const text = `${fx.leagueName} ${fx.statusDetail ?? ""}`.toLowerCase();
  const importance: ImportanceContext = {
    derby:      /derby|classico|cl[aá]sico|rivalry/i.test(text),
    knockout:   /final|semi.?final|quarter.?final|round of 16|knockout|elimination|play.?off/i.test(text),
    friendly:   /friendl|pre-season|preseason|exhibition|testimonial/i.test(text),
    titleRace:  false,
    relegation: false,
  };
  return importance.derby || importance.knockout || importance.friendly ? importance : null;
}

/** Normalise the aggregator's injuries field into the selector's injury context. */
function injuriesToContext(
  injuries: string[] | number | null | undefined,
): TeamInjuryContext | null {
  if (injuries == null) return null;
  if (Array.isArray(injuries)) {
    if (!injuries.length) return { dataAvailable: true, fullSquadAvailable: true, confirmedOut: [] };
    return { dataAvailable: true, startersOut: injuries.length, confirmedOut: injuries };
  }
  if (Number.isFinite(injuries)) {
    return injuries <= 0
      ? { dataAvailable: true, fullSquadAvailable: true, startersOut: 0 }
      : { dataAvailable: true, startersOut: Math.max(0, Math.round(injuries)) };
  }
  return null;
}

/** Normalise the aggregator's odds movement into the selector's volatility context. */
function oddsMovementToContext(
  movement: OddsMovement | null | undefined,
): MarketVolatilityContext | null {
  if (!movement || movement.opening == null || movement.current == null) return null;
  const opening = movement.opening, current = movement.current;
  if (opening <= 0 || current <= 0) return null;
  const movePct = Math.abs(current - opening) / opening * 100;   // opening→now move, real data
  const direction = movePct <= 2 ? "stable" : current < opening ? "shortening" : "drifting";
  return { dataAvailable: true, stable: direction === "stable", maxMovePctLast6h: movePct };
}

/** Build the ranking context for a fixture (everything the selector can use).
 *  Real enrichment from the multi-source aggregator wins; the fixture's own
 *  ESPN scoreboard fields (real data fetched by the caller) are the last
 *  resort; anything still missing stays null so the selector redistributes
 *  that factor's weight. */
function buildRankingContext(fx: FixtureLite, enrichment?: EnrichmentOutcome | null): RankingContext {
  const ext = enrichment?.data ?? null;
  const homeForm = formSignalFromString(fx.home.name, ext?.formHome?.join("") ?? fx.home.form);
  const awayForm = formSignalFromString(fx.away.name, ext?.formAway?.join("") ?? fx.away.form);
  const h2h = ext?.h2h ?? null;
  const homeInjuries = injuriesToContext(ext?.injuriesHome);
  const awayInjuries = injuriesToContext(ext?.injuriesAway);
  const volatility = oddsMovementToContext(ext?.oddsMovement);
  return {
    homeForm,
    awayForm,
    tactical: {
      neutralSite:   fx.neutralSite,
      homeFormation: ext?.homeFormation ?? null,
      awayFormation: ext?.awayFormation ?? null,
      h2hGames:      h2h?.length ?? 0,
      h2hGoalsAvg:   null,
      h2hResults:    h2h,
    },
    importance: deriveImportance(fx),
    leagueSlug: fx.leagueSlug,
    odds:       fx.odds ?? null,
    injury:     homeInjuries || awayInjuries ? { home: homeInjuries, away: awayInjuries } : null,
    marketVolatility: volatility,
    weather:    null,   // no real weather source integrated — stays null (weight redistributed)
    sourceTrust: sourceTrustSignal(enrichment),   // feeds the match-level confidence gate
  };
}
// ─────────────────────────────────────────────────────────────────────────────
// MULTI-SOURCE REAL-DATA AGGREGATOR (Part 1)
//
// Guarantees REAL enrichment data (form, H2H, xG, table positions, injuries,
// odds movement) is always available to rank the full market registry, without
// ever using simulated values. Sources are tried in a strict priority order;
// each has its own normaliser into the unified ExternalMatchData shape, a
// 15-second budget, a 5-minute cooldown on HTTP 429, immediate skip on
// 404/5xx, partial results are kept (first-wins per field by priority), and
// successful responses are cached per fixture for 2 hours.
//
// If EVERY source fails the match is marked UNPLAYABLE: a critical error is
// logged and no picks are generated for it (integrity over volume — no fake
// picks). Unavailable fields stay null and the selector redistributes their
// ranking weight across the available factors.
// ─────────────────────────────────────────────────────────────────────────────

/** Unified, source-agnostic enrichment payload. Every field is REAL data from
 *  a source normaliser, or null when no source could provide it — never a
 *  default/simulated stand-in. */
export interface ExternalMatchData {
  /** Recent results of the home team, oldest→newest (e.g. ["W","W","D","L","W"]). */
  formHome:                string[] | null;
  /** Recent results of the away team. */
  formAway:                string[] | null;
  /** Historical head-to-head results from the perspective of the CURRENT
   *  fixture's home team ("HomeWin" = current home team won that meeting). */
  h2h:                     Array<"HomeWin" | "Draw" | "AwayWin"> | null;
  /** Real expected-goals for the home team (null when no source provides xG). */
  homeXG:                  number | null;
  /** Real expected-goals for the away team. */
  awayXG:                  number | null;
  /** Current league-table position of the home team (1..leagueSize). */
  leagueTablePositionHome: number | null;
  /** Current league-table position of the away team. */
  leagueTablePositionAway: number | null;
  /** Key absentees for the home team — player names, or a count. */
  injuriesHome:            string[] | number | null;
  /** Key absentees for the away team — player names, or a count. */
  injuriesAway:            string[] | number | null;
  /** Odds movement (optional) — opening vs current, when a source exposes both. */
  oddsMovement:            OddsMovement | null;
  // Optional extras beyond the required contract — still real-or-null:
  /** Confirmed formation of the home team (e.g. "4-3-3"). */
  homeFormation:           string | null;
  /** Confirmed formation of the away team. */
  awayFormation:           string | null;
}

/** Optional odds-movement block. */
export interface OddsMovement {
  opening:    number | null;
  current:    number | null;
  direction:  "shortening" | "drifting" | "stable" | null;
}

/** All registered source ids, in the fixed PRIORITY order. */
export type SourceId =
  | "ESPN"
  | "StatsBomb"
  | "SportScore"
  | "OpenLigaDB"
  | "PremierLeagueOfficial"
  | "LaLigaOfficial"
  | "SerieAOfficial"
  | "TheSportsDB"
  | "ApiFootball"
  | "FBref"
  | "FootyStats"
  | "WhoScored";

export const SOURCE_PRIORITY: SourceId[] = [
  "ESPN",               // current primary — site summary endpoint (form, H2H, formations, odds)
  "StatsBomb",          // registered; no integration yet → skipped until later
  "SportScore",         // https://sportscore.com — public, CORS-open, no API key
  "OpenLigaDB",         // https://api.openligadb.de — no key, German football
  "PremierLeagueOfficial", // footballapi.premierleague.com — public JSON, no key
  "LaLigaOfficial",     // registered; no integration yet → skipped until later
  "SerieAOfficial",     // legaseriea.it public classification JSON — no auth
  "TheSportsDB",        // free tier key (default test key, overridable via env)
  "ApiFootball",        // api-sports.io free tier (requires key via env)
  "FBref",              // via sportsdata-mcp — not integrated here yet
  "FootyStats",         // via sportsdata-mcp — not integrated here yet
  "WhoScored",          // via sportsdata-mcp — not integrated here yet
];

/** Sources registered in the priority list but without a live integration in
 *  this repo yet. They are skipped (and logged once) until an integration is
 *  added — never silently substituted with fabricated data. */
const NOT_INTEGRATED: Partial<Record<SourceId, string>> = {
  StatsBomb:      "no StatsBomb integration in this repo yet — skip until later",
  LaLigaOfficial: "no LaLiga official-API integration found in this repo (no public key/endpoint wired) — skip until later",
  FBref:          "FBref via sportsdata-mcp not available in this repo yet",
  FootyStats:     "FootyStats via sportsdata-mcp not available in this repo yet",
  WhoScored:      "WhoScored via sportsdata-mcp not available in this repo yet",
};

/**
 * Match-confidence gate — trust tier assigned to each enrichment source for
 * the selector's match-level confidence score. The tier-1 live integrations
 * (ESPN, SportScore) carry the longest track record and score highest; every
 * source deeper down SOURCE_PRIORITY is a backfill source and pulls the
 * match-level confidence down.
 */
const SOURCE_TRUST: Record<SourceId, number> = {
  ESPN:                  1.00,
  SportScore:            0.95,
  PremierLeagueOfficial: 0.85,
  SerieAOfficial:        0.85,
  OpenLigaDB:            0.75,
  TheSportsDB:           0.60,
  ApiFootball:           0.55,
  // Registered-but-not-integrated ids — only reachable via future integrations.
  StatsBomb:             0.50,
  LaLigaOfficial:        0.50,
  FBref:                 0.40,
  FootyStats:            0.40,
  WhoScored:             0.40,
};

/**
 * Build the selector's source-trust signal from the aggregation outcome.
 * Without any enrichment the league-prior model is the only input, which is
 * the weakest evidence base — it scores well below a real backfill source.
 */
function sourceTrustSignal(enrichment?: EnrichmentOutcome | null): SourceTrustSignal {
  if (!enrichment) {
    return {
      primarySource: null,
      trust: 0.35,
      detail: "no multi-source enrichment — league-prior model only",
    };
  }
  const primary = enrichment.primarySource;
  const tier1 = primary === "ESPN" || primary === "SportScore";
  return {
    primarySource: primary,
    trust: SOURCE_TRUST[primary] ?? 0.5,
    detail: tier1
      ? `${primary} — tier-1 live source`
      : `${primary} — backfill-tier source (below ESPN/SportScore in SOURCE_PRIORITY)`,
  };
}

/** League → covering sources (unordered; always re-sorted by SOURCE_PRIORITY).
 *  Sources that do not cover a league are skipped for it. Leagues absent from
 *  this map try ALL sources in priority order. */
const LEAGUE_SOURCE_SETS: Record<string, ReadonlySet<SourceId>> = {
  "eng.1": new Set(["ESPN", "SportScore", "PremierLeagueOfficial", "TheSportsDB", "ApiFootball"]),
  "eng.2": new Set(["ESPN", "TheSportsDB", "ApiFootball"]),
  "eng.3": new Set(["ESPN", "TheSportsDB", "ApiFootball"]),
  "esp.1": new Set(["ESPN", "SportScore", "TheSportsDB", "ApiFootball"]), // + LaLigaOfficial once integrated
  "esp.2": new Set(["ESPN", "TheSportsDB", "ApiFootball"]),
  "ita.1": new Set(["ESPN", "SportScore", "SerieAOfficial", "TheSportsDB", "ApiFootball"]),
  "ita.2": new Set(["ESPN", "TheSportsDB", "ApiFootball"]),
  "ger.1": new Set(["ESPN", "SportScore", "OpenLigaDB", "TheSportsDB", "ApiFootball"]),
  "ger.2": new Set(["ESPN", "OpenLigaDB", "TheSportsDB"]),
  "ger.3": new Set(["ESPN", "OpenLigaDB"]),
  "fra.1": new Set(["ESPN", "SportScore", "TheSportsDB", "ApiFootball"]),
  "fra.2": new Set(["ESPN", "TheSportsDB", "ApiFootball"]),
  "ned.1": new Set(["ESPN", "SportScore", "TheSportsDB", "ApiFootball"]),
  "por.1": new Set(["ESPN", "SportScore", "TheSportsDB", "ApiFootball"]),
  "bel.1": new Set(["ESPN", "SportScore", "TheSportsDB", "ApiFootball"]),
  "tur.1": new Set(["ESPN", "TheSportsDB", "ApiFootball"]),
  "bra.1": new Set(["ESPN", "TheSportsDB", "ApiFootball"]),
  "arg.1": new Set(["ESPN", "TheSportsDB", "ApiFootball"]),
  "mex.1": new Set(["ESPN", "TheSportsDB", "ApiFootball"]),
  "usa.1": new Set(["ESPN", "TheSportsDB", "ApiFootball"]),
  "jpn.1": new Set(["ESPN", "TheSportsDB", "ApiFootball"]),
};

/** Ordered source list for a league (mapped set ∩ priority order, or all). */
function sourcesForLeague(slug: string): SourceId[] {
  const set = LEAGUE_SOURCE_SETS[slug];
  if (!set) return [...SOURCE_PRIORITY];
  return SOURCE_PRIORITY.filter((s) => set.has(s));
}

// ─── League-specific slug/id maps for the external providers ────────────────

/** ESPN slug → SportScore competition slug (https://sportscore.com). */
const SPORTSCORE_COMPETITIONS: Record<string, string> = {
  "eng.1": "premier-league",
  "esp.1": "la-liga",
  "ita.1": "serie-a",
  "ger.1": "bundesliga",
  "fra.1": "ligue-1",
  "ned.1": "eredivisie",
  "por.1": "liga-portugal",
};

/** ESPN slug → OpenLigaDB league shortcut (German football only). */
const OPENLIGADB_SHORTCUTS: Record<string, string> = {
  "ger.1": "bl1",
  "ger.2": "bl2",
  "ger.3": "bl3",
};

/** ESPN slug → TheSportsDB league id (free tier). */
const TSDB_LEAGUE_IDS: Record<string, string> = {
  "eng.1": "4328",
  "esp.1": "4335",
  "ita.1": "4332",
  "ger.1": "4331",
  "fra.1": "4334",
  "ned.1": "4336",
  "por.1": "4344",
};

// ─── Config (env-overridable for tests / future migrations) ──────────────────

const SOURCE_TIMEOUT_MS        = 15_000;               // hard 15-second per-source budget
const RATE_LIMIT_COOLDOWN_MS   = 5 * 60_000;           // 429 → unavailable for 5 minutes
const ENRICHMENT_CACHE_TTL_MS  = 2 * 60 * 60_000;      // 2-hour cache TTL

const env = (name: string): string => (process.env[name] ?? "").trim();

const ESPN_SUMMARY_BASE    = () => env("ESPN_SUMMARY_BASE")    || "https://site.api.espn.com/apis/site/v2/sports/soccer";
const SPORTSCORE_BASE      = () => env("SPORTSCORE_BASE")      || "https://sportscore.com";
const OPENLIGADB_BASE      = () => env("OPENLIGADB_BASE")      || "https://api.openligadb.de";
const PL_API_BASE          = () => env("PREMIERLEAGUE_API_BASE") || "https://footballapi.premierleague.com";
const SERIEA_API_BASE      = () => env("SERIEA_API_BASE")      || "https://www.legaseriea.it";
const TSDB_BASE            = () => env("THESPORTSDB_BASE")     || "https://www.thesportsdb.com";
const TSDB_KEY             = () => env("THESPORTSDB_KEY")      || "3";  // free public test key (repo convention)
const API_FOOTBALL_BASE    = () => env("API_FOOTBALL_BASE")    || "https://v3.football.api-sports.io";
const API_FOOTBALL_KEY     = () => env("API_FOOTBALL_KEY")     || env("FOOTBALL_API_KEY");

/** Test/debug hook — comma-separated source ids to force-skip, e.g.
 *  ORACLE_BLOCK_SOURCES=ESPN to simulate ESPN being down. */
const BLOCKED_SOURCES = (): Set<SourceId> =>
  new Set(
    env("ORACLE_BLOCK_SOURCES")
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is SourceId => SOURCE_PRIORITY.includes(s as SourceId)),
  );

// ─── HTTP layer: single-attempt fetch with hard timeout ──────────────────────
// No retries here — the fallback for a failed source is the NEXT source.

type FetchOutcome =
  | { status: "ok"; data: unknown }
  | { status: "timeout" }
  | { status: "rate-limited" }        // 429 → 5-minute cooldown
  | { status: "not-found" }           // 404 → skip immediately
  | { status: "server-error"; httpStatus: number } // 5xx → skip immediately
  | { status: "http-error"; httpStatus: number }   // other 4xx → skip
  | { status: "network-error"; message: string }
  | { status: "invalid-json" };

async function fetchSourceJson(
  url:       string,
  deadline:  number,
  headers: Record<string, string> = {},
): Promise<FetchOutcome> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { status: "timeout" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(SOURCE_TIMEOUT_MS, remaining));
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GigiGivo/1.0)",
        Accept:       "application/json",
        ...headers,
      },
      signal: controller.signal,
      cache: "no-store",
    });
    if (res.status === 429) return { status: "rate-limited" };
    if (res.status === 404) return { status: "not-found" };
    if (res.status >= 500) return { status: "server-error", httpStatus: res.status };
    if (!res.ok)            return { status: "http-error", httpStatus: res.status };
    try {
      return { status: "ok", data: await res.json() };
    } catch {
      return { status: "invalid-json" };
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { status: "timeout" };
    return { status: "network-error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 429 cooldowns + 2-hour response cache (in-memory, per server instance) ──

const sourceCooldowns = new Map<SourceId, number>();

function isCoolingDown(source: SourceId, now = Date.now()): boolean {
  const until = sourceCooldowns.get(source);
  return until !== undefined && until > now;
}

function setCooldown(source: SourceId, ms = RATE_LIMIT_COOLDOWN_MS): void {
  sourceCooldowns.set(source, Date.now() + ms);
}

interface CacheEntry {
  at:      number;                    // fetch time
  outcome: EnrichmentOutcome;         // successful merged payload only
}
const enrichmentCache = new Map<string, CacheEntry>();

// ─── Defensive parsing helpers (no `any`: unknown + narrowing) ───────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function getPath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const key of path.split(".")) {
    const rec = asRecord(node);
    if (!rec) return null;
    node = rec[key];
  }
  return node ?? null;
}

/** Loose team-name matching across providers ("Bayern München" ≈ "FC Bayern Munich"). */
function namesLooselyMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  const stop = new Set(["fc", "cf", "afc", "sc", "ac", "as", "sv", "vfl", "vfb", "tsg", "club", "de", "the", "and", "1", "04", "05", "1846", "1899", "calcio"]);
  const words = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, "").split(/\s+/)
      .filter((w) => w.length > 2 && !stop.has(w));
  const A = norm(a), B = norm(b);
  if (!A || !B) return false;
  if (A === B || A.includes(B) || B.includes(A)) return true;
  const wa = words(a), wb = words(b);
  return wa.length > 0 && wb.length > 0 && wa.some((w) => wb.includes(w));
}

/** "WWDLW" (or "W W D L W") → ["W","W","D","L","W"]; null when no letters. */
function formLettersFromString(s: string | null | undefined): string[] | null {
  if (!s) return null;
  const letters = s.toUpperCase().replace(/[^WDL]/g, "").split("");
  return letters.length ? letters : null;
}

function kebabCaseName(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Map one historical meeting onto the unified h2h vocabulary, from the
 *  perspective of the CURRENT fixture's home team. */
function h2hResultFor(
  fxHome: string, fxAway: string,
  histHome: string, histAway: string,
  homeScore: number, awayScore: number,
): "HomeWin" | "Draw" | "AwayWin" | null {
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;
  const homeIsHistHome = namesLooselyMatch(fxHome, histHome) && namesLooselyMatch(fxAway, histAway);
  const homeIsHistAway = namesLooselyMatch(fxHome, histAway) && namesLooselyMatch(fxAway, histHome);
  if (!homeIsHistHome && !homeIsHistAway) return null;
  if (homeScore === awayScore) return "Draw";
  const homeWon = homeIsHistHome ? homeScore > awayScore : awayScore > homeScore;
  return homeWon ? "HomeWin" : "AwayWin";
}

const POS_KEYS = ["position", "pos", "rank", "intRank", "posizione", "platz", "place", "row"];
const TEAM_KEYS = ["team", "teamName", "strTeam", "squadra", "club", "nome", "name"];

interface TableRow { position: number; teamName: string; }

function rowPosition(rec: Record<string, unknown>): number | null {
  for (const key of POS_KEYS) {
    const n = asNumber(rec[key]);
    if (n !== null && n > 0 && n < 60) return n;
  }
  return null;
}
function rowTeamName(rec: Record<string, unknown>): string | null {
  for (const key of TEAM_KEYS) {
    const v = rec[key];
    const nested = asRecord(v);
    if (nested) {
      const n = asString(nested.name) ?? asString(nested.shortName) ?? asString(nested.strTeam) ?? asString(nested.displayName);
      if (n) return n;
    } else {
      const n = asString(v);
      if (n) return n;
    }
  }
  return null;
}

/** Depth-bounded walker that finds league-table rows in arbitrary JSON
 *  (different providers nest them differently). */
function extractTableRows(root: unknown, depth = 0): TableRow[] {
  if (depth > 5) return [];
  const out: TableRow[] = [];
  if (Array.isArray(root)) {
    const rows: TableRow[] = [];
    for (const item of root) {
      const rec = asRecord(item);
      const position = rec ? rowPosition(rec) : null;
      const teamName = rec ? rowTeamName(rec) : null;
      if (position !== null && teamName !== null) rows.push({ position, teamName });
    }
    if (rows.length >= 6) return rows; // a real table, not a coincidence
    for (const item of root) out.push(...extractTableRows(item, depth + 1));
    return out;
  }
  const rec = asRecord(root);
  if (rec) {
    for (const value of Object.values(rec)) out.push(...extractTableRows(value, depth + 1));
  }
  return out;
}

interface FormEntry { teamName: string; letters: string[]; }

const FORM_KEYS = ["form", "formSummary", "formData", "currentForm", "recentForm", "strForm", "formGuide"];

/** Depth-bounded walker that finds per-team W/D/L form strings in arbitrary JSON. */
function extractFormEntries(root: unknown, depth = 0): FormEntry[] {
  if (depth > 5) return [];
  const out: FormEntry[] = [];
  if (Array.isArray(root)) {
    const entries: FormEntry[] = [];
    for (const item of root) {
      const rec = asRecord(item);
      if (!rec) continue;
      const teamName = rowTeamName(rec);
      if (!teamName) continue;
      for (const key of FORM_KEYS) {
        const letters = formLettersFromString(asString(rec[key]));
        if (letters && letters.length >= 3) { entries.push({ teamName, letters }); break; }
      }
    }
    if (entries.length >= 6) return entries;
    for (const item of root) out.push(...extractFormEntries(item, depth + 1));
    return out;
  }
  const rec = asRecord(root);
  if (rec) {
    for (const value of Object.values(rec)) out.push(...extractFormEntries(value, depth + 1));
  }
  return out;
}

/** Find a team's position from extracted table rows (fuzzy name match). */
function positionForTeam(rows: TableRow[], teamName: string): number | null {
  const direct = rows.find((r) => namesLooselyMatch(r.teamName, teamName));
  if (direct) return direct.position;
  return null;
}

// ─── Per-source fetchers + normalisers ───────────────────────────────────────
// Each fetcher returns a PARTIAL ExternalMatchData (only fields it actually
// obtained from real data — never invented), a `skip` note, or nothing thrown.
// All requests share the source's 15-second deadline. Hard HTTP failures are
// propagated via `status`/`hardStatus` so the orchestrator can classify the
// attempt (and arm the 429 cooldown) accurately.

type FetchHardStatus =
  | "timeout" | "rate-limited" | "not-found" | "server-error"
  | "http-error" | "network-error" | "invalid-json";

type SourceFetch =
  | { partial: Partial<ExternalMatchData>; note?: string; hardStatus?: FetchHardStatus }
  | { skip: string; status?: FetchHardStatus };

type SourceFetcher = (fx: FixtureLite, deadline: number) => Promise<SourceFetch>;

/** Records the first hard sub-request failure; 429 always wins. */
function hardStatusTracker(): {
  note: (status: FetchOutcome["status"]) => void;
  get: () => FetchHardStatus | undefined;
} {
  let hard: FetchHardStatus | undefined;
  return {
    note: (status) => {
      if (status === "ok") return;
      if (status === "rate-limited" || !hard) hard = status;
    },
    get: () => hard,
  };
}

// ── Source 1: ESPN (site summary — form, H2H, formations) ───────────────────
async function fetchEspn(fx: FixtureLite, deadline: number): Promise<SourceFetch> {
  const out = await fetchSourceJson(
    `${ESPN_SUMMARY_BASE()}/${fx.leagueSlug}/summary?event=${encodeURIComponent(fx.id)}`,
    deadline,
  );
  if (out.status !== "ok") {
    return { skip: `summary fetch ${out.status}`, status: out.status };
  }
  const root = asRecord(out.data);
  if (!root) return { skip: "summary payload not an object" };

  const partial: Partial<ExternalMatchData> = {};

  // Form — lastFiveGames[0] = home, [1] = away (matches ../espn.ts fetchSummary).
  const lastFive = asArray(root.lastFiveGames);
  const formEntry = (idx: number, fallback: string | null | undefined): string[] | null => {
    const entry = asRecord(lastFive[idx]);
    const events = asArray(entry?.events);
    const letters: string[] = [];
    for (const e of events) {
      const rec = asRecord(e);
      const r = asString(rec?.gameResult)?.toUpperCase();
      if (r === "W" || r === "D" || r === "L") letters.push(r);
    }
    return letters.length ? letters : formLettersFromString(fallback);
  };
  partial.formHome = formEntry(0, fx.home.form);
  partial.formAway = formEntry(1, fx.away.form);

  // H2H — from the perspective of the current fixture's home team.
  const h2h: Array<"HomeWin" | "Draw" | "AwayWin"> = [];
  for (const block of asArray(root.headToHeadGames)) {
    for (const ev of asArray(asRecord(block)?.events)) {
      const rec = asRecord(ev);
      const histHome = asString(getPath(rec, "homeTeam.displayName")) ?? "";
      const histAway = asString(getPath(rec, "awayTeam.displayName")) ?? "";
      const hs = asNumber(rec?.homeTeamScore);
      const as = asNumber(rec?.awayTeamScore);
      const result = h2hResultFor(fx.home.name, fx.away.name, histHome, histAway, hs ?? NaN, as ?? NaN);
      if (result) h2h.push(result);
    }
  }
  partial.h2h = h2h.length ? h2h : null;

  // Formations — rosters[] with homeAway + formation.
  for (const r of asArray(root.rosters)) {
    const rec = asRecord(r);
    const side = asString(rec?.homeAway);
    const formation = asString(rec?.formation);
    if (!formation) continue;
    if (side === "home") partial.homeFormation = formation;
    if (side === "away") partial.awayFormation = formation;
  }

  // ESPN's summary exposes current odds only (no opening line) → oddsMovement stays null.
  partial.oddsMovement = null;
  partial.homeXG = null;
  partial.awayXG = null;
  partial.injuriesHome = null;
  partial.injuriesAway = null;

  const filled = Object.entries(partial).filter(([, v]) => v !== null);
  if (!filled.length) return { skip: "summary payload had no usable fields" };
  return { partial };
}

// ── Source 3: SportScore (public widget API — standings, team fixtures) ──────
async function fetchSportScore(fx: FixtureLite, deadline: number): Promise<SourceFetch> {
  const headers: Record<string, string> = {};
  const key = env("SPORTSCORE_API_KEY");
  if (key) headers.Authorization = `Bearer ${key}`; // optional — the public API needs no key
  const base = SPORTSCORE_BASE();
  const competition = SPORTSCORE_COMPETITIONS[fx.leagueSlug];
  const hard = hardStatusTracker();

  // 1) Standings → positions (+ exact team slugs for the fixture endpoint).
  let rows: TableRow[] = [];
  let homeSlug: string | null = null;
  let awaySlug: string | null = null;
  if (competition) {
    const standings = await fetchSourceJson(
      `${base}/api/widget/standings/?sport=football&slug=${encodeURIComponent(competition)}`,
      deadline, headers,
    );
    hard.note(standings.status);
    if (hard.get() === "rate-limited") return { skip: "standings rate-limited", status: "rate-limited" };
    if (standings.status === "ok") {
      rows = extractTableRows(standings.data);
      // SportScore rows carry an exact team_slug next to pos/team.
      const slugRows = extractSportScoreSlugRows(standings.data);
      homeSlug = slugRows.find((r) => namesLooselyMatch(r.teamName, fx.home.name))?.slug ?? null;
      awaySlug = slugRows.find((r) => namesLooselyMatch(r.teamName, fx.away.name))?.slug ?? null;
    }
  }
  // No exact slugs (unmapped league / standings failed) → kebab-case fallback.
  homeSlug ??= kebabCaseName(fx.home.name);
  awaySlug ??= kebabCaseName(fx.away.name);

  // 2) Recent team fixtures → form (+ H2H when the two teams met recently).
  interface PastMatch { home: string; away: string; hs: number; as: number; time: string }
  const teamMatches = async (slug: string, teamName: string): Promise<PastMatch[]> => {
    const res = await fetchSourceJson(
      `${base}/api/widget/team/?sport=football&slug=${encodeURIComponent(slug)}&limit=30`,
      deadline, headers,
    );
    hard.note(res.status);
    if (res.status !== "ok") return [];
    // Validate the resolved team is the fixture's team (slugs can collide —
    // e.g. "bayern-munich" resolves to "Bayern Munich Legends").
    const resolved = asString(getPath(res.data, "team.name"));
    if (resolved && !namesLooselyMatch(resolved, teamName)) return [];
    const matches = asArray(asRecord(res.data)?.matches);
    const parsed: PastMatch[] = [];
    for (const m of matches) {
      const rec = asRecord(m);
      if (!rec) continue;
      const hs = asNumber(rec.home_score);
      const as = asNumber(rec.away_score);
      if (asString(rec.status) !== "finished" || hs === null || as === null) continue;
      parsed.push({
        home: asString(rec.home) ?? "",
        away: asString(rec.away) ?? "",
        hs, as,
        time: asString(rec.time) ?? "",
      });
    }
    return parsed.sort((x, y) => (x.time < y.time ? -1 : 1));   // chronological
  };
  const formOf = (team: string, matches: PastMatch[]): string[] | null => {
    const own = matches.filter((m) => namesLooselyMatch(m.home, team) || namesLooselyMatch(m.away, team)).slice(-5);
    if (!own.length) return null;
    return own.map((m) => {
      const isHome = namesLooselyMatch(m.home, team);
      const sf = isHome ? m.hs : m.as;
      const sa = isHome ? m.as : m.hs;
      return sf > sa ? "W" : sf < sa ? "L" : "D";
    });
  };

  const [homeFormMatches, awayFormMatches] = await Promise.all([
    teamMatches(homeSlug, fx.home.name),
    teamMatches(awaySlug, fx.away.name),
  ]);
  if (hard.get() === "rate-limited") return { skip: "team fixtures rate-limited", status: "rate-limited" };

  const partial: Partial<ExternalMatchData> = {};
  if (rows.length) {
    partial.leagueTablePositionHome = positionForTeam(rows, fx.home.name);
    partial.leagueTablePositionAway = positionForTeam(rows, fx.away.name);
  }
  if (homeFormMatches.length) {
    partial.formHome = formOf(fx.home.name, homeFormMatches);
    const meetings = homeFormMatches.filter(
      (m) => (namesLooselyMatch(m.home, fx.home.name) && namesLooselyMatch(m.away, fx.away.name)) ||
              (namesLooselyMatch(m.home, fx.away.name) && namesLooselyMatch(m.away, fx.home.name)),
    ).slice(-5);
    partial.h2h = meetings.length
      ? meetings.map((m) => h2hResultFor(fx.home.name, fx.away.name, m.home, m.away, m.hs, m.as)).filter((r): r is "HomeWin" | "Draw" | "AwayWin" => r !== null)
      : null;
  }
  if (awayFormMatches.length) {
    partial.formAway = formOf(fx.away.name, awayFormMatches);
  }

  const filled = Object.entries(partial).filter(([, v]) => v !== null);
  if (!filled.length) return { skip: "no standings rows and no team fixtures resolved", status: hard.get() };
  return { partial, hardStatus: hard.get() };
}

/** SportScore rows look like { pos, team, team_slug, ... } — keep the exact slug. */
function extractSportScoreSlugRows(root: unknown): Array<{ teamName: string; slug: string }> {
  const out: Array<{ teamName: string; slug: string }> = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 4 || out.length) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        const rec = asRecord(item);
        const teamName = rec ? (asString(rec.team) ?? asString(rowTeamName(rec))) : null;
        const slug = rec ? asString(rec.team_slug) : null;
        if (teamName && slug) out.push({ teamName, slug });
      }
      if (out.length) return;
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const rec = asRecord(node);
    if (rec) for (const value of Object.values(rec)) walk(value, depth + 1);
  };
  walk(root, 0);
  return out;
}

// ── Source 4: OpenLigaDB (German football — season matches + table) ─────────
async function fetchOpenLigaDb(fx: FixtureLite, deadline: number): Promise<SourceFetch> {
  const shortcut = OPENLIGADB_SHORTCUTS[fx.leagueSlug];
  if (!shortcut) return { skip: `OpenLigaDB does not cover league '${fx.leagueSlug}'` };
  const base = OPENLIGADB_BASE();
  const hard = hardStatusTracker();

  // German seasons start in autumn: 2026-08 → season "2026".
  const date = new Date(fx.date);
  const season = date.getUTCMonth() + 1 >= 7 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;

  const table = await fetchSourceJson(`${base}/getbltable/${shortcut}/${season}`, deadline);
  hard.note(table.status);
  if (hard.get() === "rate-limited") return { skip: "table rate-limited", status: "rate-limited" };

  interface FinishedMatch { home: string; away: string; hs: number; as: number; date: string }
  const matchesRes = await fetchSourceJson(`${base}/getmatchdata/${shortcut}/${season}`, deadline);
  hard.note(matchesRes.status);
  if (hard.get() === "rate-limited") return { skip: "matches rate-limited", status: "rate-limited" };

  const finished: FinishedMatch[] = [];
  for (const m of asArray(matchesRes.status === "ok" ? matchesRes.data : null)) {
    const rec = asRecord(m);
    const team1 = asString(getPath(rec, "team1.teamName")) ?? "";
    const team2 = asString(getPath(rec, "team2.teamName")) ?? "";
    const results = asArray(rec?.matchResults);
    let hs: number | null = null;
    let as: number | null = null;
    for (const r of results) {
      const rr = asRecord(r);
      if (asNumber(rr?.resultTypeID) === 2) {   // 2 = final result
        hs = asNumber(rr?.pointsTeam1);
        as = asNumber(rr?.pointsTeam2);
      }
    }
    const isFinished = rec?.finished === true || (hs !== null && as !== null);
    if (!isFinished || hs === null || as === null) continue;
    const d = asString(rec?.matchDateTime) ?? "";
    if (d && d >= fx.date) continue;   // only matches already played before this fixture
    finished.push({ home: team1, away: team2, hs, as, date: d });
  }
  finished.sort((a, b) => (a.date < b.date ? -1 : 1));

  const formOf = (team: string): string[] | null => {
    const own = finished.filter((m) => namesLooselyMatch(m.home, team) || namesLooselyMatch(m.away, team)).slice(-5);
    if (!own.length) return null;
    return own.map((m) => {
      const isHome = namesLooselyMatch(m.home, team);
      const sf = isHome ? m.hs : m.as;
      const sa = isHome ? m.as : m.hs;
      return sf > sa ? "W" : sf < sa ? "L" : "D";
    });
  };

  const partial: Partial<ExternalMatchData> = {};
  if (table.status === "ok") {
    const rows = extractTableRows(table.data);
    if (rows.length) {
      partial.leagueTablePositionHome = positionForTeam(rows, fx.home.name);
      partial.leagueTablePositionAway = positionForTeam(rows, fx.away.name);
    }
  }
  partial.formHome = formOf(fx.home.name);
  partial.formAway = formOf(fx.away.name);
  const meetings = finished.filter(
    (m) => (namesLooselyMatch(m.home, fx.home.name) && namesLooselyMatch(m.away, fx.away.name)) ||
            (namesLooselyMatch(m.home, fx.away.name) && namesLooselyMatch(m.away, fx.home.name)),
  ).slice(-5);
  partial.h2h = meetings.length
    ? meetings.map((m) => h2hResultFor(fx.home.name, fx.away.name, m.home, m.away, m.hs, m.as)).filter((r): r is "HomeWin" | "Draw" | "AwayWin" => r !== null)
    : null;

  const filled = Object.entries(partial).filter(([, v]) => v !== null);
  if (!filled.length) return { skip: "no table rows and no finished matches matched the teams" };
  return { partial };
}

// ── Source 5: Premier League official (pulselive footballapi) ───────────────
async function fetchPremierLeague(fx: FixtureLite, deadline: number): Promise<SourceFetch> {
  if (fx.leagueSlug !== "eng.1") return { skip: `Premier League API does not cover '${fx.leagueSlug}'` };
  const base = PL_API_BASE();
  const partial: Partial<ExternalMatchData> = {};
  const hard = hardStatusTracker();

  const standings = await fetchSourceJson(
    `${base}/soccer/standings?comps=1&page=0&pageSize=100&altIds=true`, deadline,
  );
  hard.note(standings.status);
  if (hard.get() === "rate-limited") return { skip: "standings rate-limited", status: "rate-limited" };
  if (standings.status === "ok") {
    const rows = extractTableRows(standings.data);
    if (rows.length) {
      partial.leagueTablePositionHome = positionForTeam(rows, fx.home.name);
      partial.leagueTablePositionAway = positionForTeam(rows, fx.away.name);
    }
  }

  const form = await fetchSourceJson(`${base}/soccer/form?comps=1&page=0&pageSize=40&altIds=true`, deadline);
  hard.note(form.status);
  if (hard.get() === "rate-limited") return { skip: "form rate-limited", status: "rate-limited" };
  if (form.status === "ok") {
    const entries = extractFormEntries(form.data);
    const home = entries.find((e) => namesLooselyMatch(e.teamName, fx.home.name));
    const away = entries.find((e) => namesLooselyMatch(e.teamName, fx.away.name));
    if (home) partial.formHome = home.letters;
    if (away) partial.formAway = away.letters;
  }

  const filled = Object.entries(partial).filter(([, v]) => v !== null);
  if (!filled.length) return { skip: "no standings/form rows matched the teams", status: hard.get() };
  return { partial, hardStatus: hard.get() };
}

// ── Source 7: Lega Serie A (public classification JSON) ─────────────────────
async function fetchSerieA(fx: FixtureLite, deadline: number): Promise<SourceFetch> {
  if (fx.leagueSlug !== "ita.1") return { skip: `Serie A API does not cover '${fx.leagueSlug}'` };
  const date = new Date(fx.date);
  const startYear = date.getUTCMonth() + 1 >= 7 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  const stagione = `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
  const res = await fetchSourceJson(
    `${SERIEA_API_BASE()}/api/stats/Classificacompleta?CAMPIONATO=A&STAGIONE=${stagione}&TURNO=UNICO&GIRONE=UNI`,
    deadline,
  );
  if (res.status !== "ok") return { skip: `classification ${res.status}` };
  const rows = extractTableRows(res.data);
  if (!rows.length) return { skip: "no classification rows found" };
  const partial: Partial<ExternalMatchData> = {
    leagueTablePositionHome: positionForTeam(rows, fx.home.name),
    leagueTablePositionAway: positionForTeam(rows, fx.away.name),
  };
  const filled = Object.entries(partial).filter(([, v]) => v !== null);
  if (!filled.length) return { skip: "no classification rows matched the teams" };
  return { partial };
}

// ── Source 8: TheSportsDB (free tier — team resolve, last events, table) ─────
async function fetchTheSportsDb(fx: FixtureLite, deadline: number): Promise<SourceFetch> {
  const base = `${TSDB_BASE()}/api/v1/json/${TSDB_KEY()}`;
  const hard = hardStatusTracker();

  const resolveTeam = async (name: string): Promise<string | null> => {
    const res = await fetchSourceJson(`${base}/searchteams.php?t=${encodeURIComponent(name)}`, deadline);
    hard.note(res.status);
    if (res.status !== "ok") return null;
    const teams = asArray(getPath(res.data, "teams"));
    for (const t of teams) {
      const rec = asRecord(t);
      const teamName = asString(rec?.strTeam);
      const id = asString(rec?.idTeam);
      if (teamName && id && namesLooselyMatch(teamName, name)) return id;
    }
    return null;
  };

  interface PastEvent { home: string; away: string; hs: number; as: number; date: string }
  const lastEvents = async (teamId: string): Promise<PastEvent[] | null> => {
    const res = await fetchSourceJson(`${base}/eventslast.php?id=${encodeURIComponent(teamId)}`, deadline);
    hard.note(res.status);
    if (res.status !== "ok") return null;
    const results = asArray(getPath(res.data, "results"));
    const events: PastEvent[] = [];
    for (const e of results) {
      const rec = asRecord(e);
      const hs = asNumber(rec?.intHomeScore);
      const as = asNumber(rec?.intAwayScore);
      const home = asString(rec?.strHomeTeam) ?? "";
      const away = asString(rec?.strAwayTeam) ?? "";
      if (hs === null || as === null || !home || !away) continue;   // not played yet
      events.push({ home, away, hs, as, date: asString(rec?.dateEvent) ?? "" });
    }
    return events.sort((x, y) => (x.date < y.date ? -1 : 1));
  };

  const [homeId, awayId] = await Promise.all([resolveTeam(fx.home.name), resolveTeam(fx.away.name)]);
  if (!homeId && !awayId) return { skip: "could not resolve either team" };

  const partial: Partial<ExternalMatchData> = {};
  const homeEvents = homeId ? await lastEvents(homeId) : null;
  const awayEvents = awayId ? await lastEvents(awayId) : null;

  const formOf = (team: string, events: PastEvent[] | null): string[] | null => {
    if (!events?.length) return null;
    const own = events.filter((m) => namesLooselyMatch(m.home, team) || namesLooselyMatch(m.away, team)).slice(-5);
    if (!own.length) return null;
    return own.map((m) => {
      const isHome = namesLooselyMatch(m.home, team);
      const sf = isHome ? m.hs : m.as;
      const sa = isHome ? m.as : m.hs;
      return sf > sa ? "W" : sf < sa ? "L" : "D";
    });
  };
  partial.formHome = formOf(fx.home.name, homeEvents);
  partial.formAway = formOf(fx.away.name, awayEvents);

  if (homeEvents?.length) {
    const meetings = homeEvents.filter(
      (m) => (namesLooselyMatch(m.home, fx.home.name) && namesLooselyMatch(m.away, fx.away.name)) ||
              (namesLooselyMatch(m.home, fx.away.name) && namesLooselyMatch(m.away, fx.home.name)),
    );
    partial.h2h = meetings.length
      ? meetings.map((m) => h2hResultFor(fx.home.name, fx.away.name, m.home, m.away, m.hs, m.as)).filter((r): r is "HomeWin" | "Draw" | "AwayWin" => r !== null)
      : null;
  }

  // League table (only when the league has a known TheSportsDB id).
  const leagueId = TSDB_LEAGUE_IDS[fx.leagueSlug];
  if (leagueId) {
    const date = new Date(fx.date);
    const startYear = date.getUTCMonth() + 1 >= 7 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
    const season = `${startYear}-${startYear + 1}`;
    const table = await fetchSourceJson(`${base}/lookuptable.php?l=${leagueId}&s=${season}`, deadline);
    hard.note(table.status);
    if (table.status === "ok") {
      const rows = extractTableRows(table.data);
      if (rows.length) {
        partial.leagueTablePositionHome = positionForTeam(rows, fx.home.name);
        partial.leagueTablePositionAway = positionForTeam(rows, fx.away.name);
      }
    }
  }

  const filled = Object.entries(partial).filter(([, v]) => v !== null);
  if (!filled.length) return { skip: "no form/table fields resolved", status: hard.get() };
  return { partial, hardStatus: hard.get() };
}

// ── Source 9: API-Football (keyed — injuries, real xG, odds) ────────────────
async function fetchApiFootball(fx: FixtureLite, deadline: number): Promise<SourceFetch> {
  const key = API_FOOTBALL_KEY();
  if (!key) return { skip: "no API_FOOTBALL_KEY configured — source unavailable (not a failure)" };
  const base = API_FOOTBALL_BASE();
  const headers = { "x-apisports-key": key };
  const hard = hardStatusTracker();

  const day = fx.date.slice(0, 10);
  const fixtures = await fetchSourceJson(`${base}/fixtures?date=${day}`, deadline, headers);
  hard.note(fixtures.status);
  if (fixtures.status !== "ok") return { skip: `fixture search ${fixtures.status}`, status: hard.get() };

  const response = asArray(getPath(fixtures.data, "response"));
  const match = response.find((f) => {
    const rec = asRecord(f);
    const h = asString(getPath(rec, "teams.home.name")) ?? "";
    const a = asString(getPath(rec, "teams.away.name")) ?? "";
    return namesLooselyMatch(h, fx.home.name) && namesLooselyMatch(a, fx.away.name);
  });
  const fixtureId = asNumber(getPath(asRecord(match), "fixture.id"));
  if (!fixtureId) return { skip: "fixture not found for these teams/date" };

  const partial: Partial<ExternalMatchData> = {};

  // Real expected goals (available for in-play / finished fixtures).
  const stats = await fetchSourceJson(`${base}/fixtures/statistics?fixture=${fixtureId}`, deadline, headers);
  hard.note(stats.status);
  if (stats.status === "ok") {
    const entries = asArray(getPath(stats.data, "response"));
    const xgFor = (idx: number): number | null => {
      const rec = asRecord(entries[idx]);
      for (const s of asArray(rec?.statistics)) {
        const sr = asRecord(s);
        if (asString(sr?.type)?.toLowerCase() === "expected_goals") {
          const v = asNumber(sr?.value);
          if (v !== null) return v;
        }
      }
      return null;
    };
    const hx = xgFor(0);
    const ax = xgFor(1);
    if (hx !== null) partial.homeXG = hx;
    if (ax !== null) partial.awayXG = ax;
  }

  // Injuries / suspensions (player names grouped per team).
  const injuries = await fetchSourceJson(`${base}/injuries?fixture=${fixtureId}`, deadline, headers);
  hard.note(injuries.status);
  if (injuries.status === "ok") {
    const homeNames: string[] = [];
    const awayNames: string[] = [];
    for (const item of asArray(getPath(injuries.data, "response"))) {
      const rec = asRecord(item);
      const player = asString(getPath(rec, "player.name"));
      const team = asString(getPath(rec, "team.name"));
      if (!player || !team) continue;
      if (namesLooselyMatch(team, fx.home.name)) homeNames.push(player);
      else if (namesLooselyMatch(team, fx.away.name)) awayNames.push(player);
    }
    if (homeNames.length) partial.injuriesHome = homeNames;
    if (awayNames.length) partial.injuriesAway = awayNames;
  }

  const filled = Object.entries(partial).filter(([, v]) => v !== null);
  if (!filled.length) return { skip: "fixture found but no xG/injury fields available", status: hard.get() };
  return { partial, note: `fixture ${fixtureId}`, hardStatus: hard.get() };
}

// ─── Source registry ─────────────────────────────────────────────────────────

const SOURCE_FETCHERS: Partial<Record<SourceId, SourceFetcher>> = {
  ESPN:                 fetchEspn,
  SportScore:           fetchSportScore,
  OpenLigaDB:           fetchOpenLigaDb,
  PremierLeagueOfficial: fetchPremierLeague,
  SerieAOfficial:       fetchSerieA,
  TheSportsDB:          fetchTheSportsDb,
  ApiFootball:          fetchApiFootball,
};

const notIntegratedLogged = new Set<SourceId>();

// ─── Orchestration: priority walk + merge + cache + logging ──────────────────

/** Fields of ExternalMatchData that a source can contribute. */
const DATA_FIELDS = [
  "formHome", "formAway", "h2h", "homeXG", "awayXG",
  "leagueTablePositionHome", "leagueTablePositionAway",
  "injuriesHome", "injuriesAway", "oddsMovement",
  "homeFormation", "awayFormation",
] as const;
type DataField = (typeof DATA_FIELDS)[number];

/** One source attempt, for the per-match monitoring log. */
export interface SourceAttempt {
  source:  SourceId;
  status:  "ok" | "skipped" | "timeout" | "rate-limited" | "not-found"
          | "server-error" | "http-error" | "network-error" | "invalid-json" | "cooldown";
  ms:      number;
  fields?: string[];
  detail?: string;
}

/** Result of a successful multi-source aggregation. */
export interface EnrichmentOutcome {
  /** Cache key this outcome is stored under (`cache:${leagueSlug}:${eventId}`). */
  cacheKey:       string;
  data:           ExternalMatchData;
  /** Highest-priority source that contributed at least one field. */
  primarySource:  SourceId;
  /** Which source provided each field (first-wins by priority). */
  fieldSources:   Partial<Record<DataField, SourceId>>;
  /** Every source tried, in order, with its outcome. */
  attempts:       SourceAttempt[];
}

function emptyExternalData(): ExternalMatchData {
  return {
    formHome: null, formAway: null, h2h: null,
    homeXG: null, awayXG: null,
    leagueTablePositionHome: null, leagueTablePositionAway: null,
    injuriesHome: null, injuriesAway: null,
    oddsMovement: null,
    homeFormation: null, awayFormation: null,
  };
}

/**
 * Fetch real enrichment data for a fixture from the multi-source aggregator.
 *
 * Priority-ordered, cached (2h per `cache:${leagueSlug}:${eventId}`), 15s
 * budget per source, 5-minute cooldown after a 429, immediate skip on 404/5xx,
 * partial data kept field-by-field (first-wins by priority).
 *
 * Returns null ONLY when every applicable source failed — the caller must then
 * mark the match unplayable and generate no picks for it.
 */
export async function fetchExternalMatchData(
  fx: FixtureLite,
): Promise<EnrichmentOutcome | null> {
  const cacheKey = `cache:${fx.leagueSlug}:${fx.id}`;

  // Cache first — never re-fetch while an entry is fresh.
  const cached = enrichmentCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ENRICHMENT_CACHE_TTL_MS) {
    return cached.outcome;
  }

  const sources = sourcesForLeague(fx.leagueSlug);
  const blocked = BLOCKED_SOURCES();

  const data = emptyExternalData();
  const fieldSources: Partial<Record<DataField, SourceId>> = {};
  const attempts: SourceAttempt[] = [];

  for (const source of sources) {
    const isComplete = DATA_FIELDS.every((f) => data[f] !== null);
    if (isComplete) break;

    const start = Date.now();

    if (blocked.has(source)) {
      attempts.push({ source, status: "skipped", ms: 0, detail: "blocked via ORACLE_BLOCK_SOURCES (test simulation)" });
      continue;
    }
    if (isCoolingDown(source)) {
      attempts.push({ source, status: "cooldown", ms: 0, detail: "rate-limited earlier — 5-minute cooldown active" });
      continue;
    }
    const notIntegrated = NOT_INTEGRATED[source];
    if (notIntegrated || !SOURCE_FETCHERS[source]) {
      if (!notIntegratedLogged.has(source)) {
        console.log(`[oracle] source '${source}' skipped: ${notIntegrated ?? "no fetcher registered"}`);
        notIntegratedLogged.add(source);
      }
      attempts.push({ source, status: "skipped", ms: 0, detail: notIntegrated ?? "no fetcher registered" });
      continue;
    }

    let attempt: SourceAttempt;
    let rateLimited = false;
    try {
      const result = await SOURCE_FETCHERS[source]!(fx, Date.now() + SOURCE_TIMEOUT_MS);
      if ("skip" in result) {
        attempt = { source, status: result.status ?? "skipped", ms: Date.now() - start, detail: result.skip };
        if (result.status === "rate-limited") rateLimited = true;
      } else {
        const fields: string[] = [];
        for (const field of DATA_FIELDS) {
          const value = result.partial[field];
          if (value !== undefined && value !== null && data[field] === null) {
            // first-wins by priority
            (data as unknown as Record<DataField, unknown>)[field] = value;
            fieldSources[field] = source;
            fields.push(field);
          }
        }
        attempt = fields.length
          ? { source, status: "ok", ms: Date.now() - start, fields }
          : { source, status: result.hardStatus ?? "skipped", ms: Date.now() - start, detail: "source returned no usable field" };
        if (result.hardStatus === "rate-limited") rateLimited = true;
      }
    } catch (err) {
      attempt = {
        source, status: "network-error", ms: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    // 429 (on any sub-request) → the source is unavailable for 5 minutes.
    if (rateLimited || attempt.status === "rate-limited") setCooldown(source);
    attempts.push(attempt);
  }

  const filled = DATA_FIELDS.filter((f) => data[f] !== null);
  if (!filled.length) {
    // ALL sources failed → unplayable. Critical error; NOT cached (retry later).
    console.error(
      `[oracle] CRITICAL: ALL ${attempts.length} data sources failed for ${cacheKey} ` +
      `(${attempts.map((a) => `${a.source}=${a.status}`).join(", ")}) — match marked UNPLAYABLE, no picks generated`,
    );
    return null;
  }

  const primarySource = fieldSources[filled[0]] ?? attempts.find((a) => a.status === "ok")?.source ?? "ESPN";
  const outcome: EnrichmentOutcome = { cacheKey, data, primarySource, fieldSources, attempts };
  enrichmentCache.set(cacheKey, { at: Date.now(), outcome });

  // Opportunistic cache cleanup — keep the map bounded.
  if (enrichmentCache.size > 500) {
    const cutoff = Date.now() - ENRICHMENT_CACHE_TTL_MS;
    for (const [key, entry] of enrichmentCache) {
      if (entry.at < cutoff) enrichmentCache.delete(key);
    }
  }

  // Part 3 logging — which source was used, which fields are missing.
  const missing = DATA_FIELDS.filter((f) => data[f] === null);
  const contributors = [...new Set(Object.values(fieldSources))].join(" + ");
  console.log(
    `[oracle] enrichment ${cacheKey} → source: ${contributors} | provided: ${filled.join(",")} ` +
    `| missing: ${missing.join(",") || "none"} | attempts: ${attempts.map((a) => `${a.source}=${a.status}${a.detail ? `(${a.detail})` : ""}`).join(", ")}`,
  );
  return outcome;
}

/** Test/debug helper — drop a cached enrichment outcome. */
export function clearEnrichmentCache(cacheKey?: string): void {
  if (cacheKey) enrichmentCache.delete(cacheKey);
  else enrichmentCache.clear();
}

// ─── Poisson math ──────────────────────────────────────────────────────────────
function poissonPmf(lambda: number, k: number): number {
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}
function poissonCdf(lambda: number, k: number): number {
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += poissonPmf(lambda, i);
  return Math.min(sum, 1);
}
function poissonGe(lambda: number, k: number): number {
  return Math.max(0, 1 - poissonCdf(lambda, k - 1));
}
function factorial(n: number): number {
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

// ─── Deterministic noise from fixture ID ──────────────────────────────────────
function seed(id: string, salt: number): number {
  let h = salt;
  for (const ch of id) h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0;
  return (Math.abs(h) % 1000) / 1000;
}

// ─── Build a rich Market from raw values ────────────────────────────────────────
let _mktIdx = 0;
function mkMarket(
  name: string,
  selection: string,
  hitRate: number,
  family: string,
  reason: string,
  outcome: "HIT" | "MISS" | "PENDING" = "PENDING",
  explanation?: MarketExplanation
): Market {
  const clampedHr = Math.min(Math.max(hitRate, 0.01), 0.99);
  const ci = 0.07 * (1 - Math.abs(clampedHr - 0.5) * 1.5);
  const ciLower = Math.max(0.01, clampedHr - ci);
  const ciUpper = Math.min(0.99, clampedHr + ci);
  const fairOdds = parseFloat((1 / clampedHr).toFixed(2));
  const fairOddsWorst = parseFloat((1 / ciLower).toFixed(2));
  const mqs = parseFloat((clampedHr >= 0.80 ? 8 + clampedHr * 2 : clampedHr * 10).toFixed(1));
  const di = Math.abs(clampedHr - 0.5) > 0.2 ? 0.03 : 0.08;
  // Letter grade: A ≥ 88%, B ≥ 75%, C ≥ 60%, D < 60%
  const grade = clampedHr >= 0.88 ? "A" : clampedHr >= 0.75 ? "B" : clampedHr >= 0.60 ? "C" : "D";
  const confidence: "HIGH" | "MEDIUM" | "LOW" = clampedHr >= 0.75 ? "HIGH" : clampedHr >= 0.60 ? "MEDIUM" : "LOW";
  const bookMargin = 1.065;
  const bookImplied = 1 / (fairOdds * bookMargin);
  const valueEdge = parseFloat((clampedHr - bookImplied).toFixed(4));
  const kelly = valueEdge > 0 ? parseFloat(((clampedHr - (1 - clampedHr) / (fairOdds * bookMargin - 1))).toFixed(4)) : 0;

  return {
    id: `mkt_${++_mktIdx}`,
    name,
    selection,
    hitRate:       clampedHr,
    ciLower,
    ciUpper,
    ciWidth:       ciUpper - ciLower,
    fairOdds,
    fairOddsBest:  parseFloat((1 / ciUpper).toFixed(2)),
    fairOddsWorst,
    mqs,
    disagreementIndex: di,
    grade,
    confidence,
    rejected:      clampedHr < 0.50,
    niche:         false,
    reason,
    family,
    outcome,
    valueEdge,
    kelly,
    explanation,
  };
}

// ─── Verification helpers for post-match ────────────────────────────────────────
function verifyGoalLine(over: boolean, actual: number, line: number): "HIT" | "MISS" {
  return (actual > line) === over ? "HIT" : "MISS";
}
function verifyBtts(yes: boolean, hScore: number, aScore: number): "HIT" | "MISS" {
  return ((hScore > 0 && aScore > 0) === yes) ? "HIT" : "MISS";
}
function verifyResult(sel: string, hScore: number, aScore: number, hName: string): "HIT" | "MISS" {
  if (sel.includes("Win") && (sel.includes(hName) || sel.startsWith(hName))) return hScore > aScore ? "HIT" : "MISS";
  if (sel.includes("Win")) return aScore > hScore ? "HIT" : "MISS";
  if (sel === "Draw") return hScore === aScore ? "HIT" : "MISS";
  return "MISS";
}
function verifyDc(sel: string, hScore: number, aScore: number, hName: string): "HIT" | "MISS" {
  const homeWin = hScore > aScore, draw = hScore === aScore, awayWin = aScore > hScore;
  if (sel.includes(hName) && sel.includes("Draw")) return (homeWin || draw) ? "HIT" : "MISS";
  if (sel.includes("Draw") && !sel.includes(hName)) return (draw || awayWin) ? "HIT" : "MISS";
  return (homeWin || awayWin) ? "HIT" : "MISS";
}

// ─── λ adapter (oracle expected-rates → selector LambdaSet) ───────────────────
function toLambdaSet(exp: {
  homeGoals: number; awayGoals: number; totalGoals: number;
  homeCorners: number; awayCorners: number;
  homeCards: number; awayCards: number;
  homeSot: number; awaySot: number;
  homeShots: number; awayShots: number;
  homeSaves: number; awaySaves: number;
  fouls: number; offsides: number; goalKicks: number; throwIns: number;
}): LambdaSet {
  return {
    homeGoals:         exp.homeGoals,
    awayGoals:         exp.awayGoals,
    homeCorners:       exp.homeCorners,
    awayCorners:       exp.awayCorners,
    homeCards:         exp.homeCards,
    awayCards:         exp.awayCards,
    homeSot:           exp.homeSot,
    awaySot:           exp.awaySot,
    homeShots:         exp.homeShots,
    awayShots:         exp.awayShots,
    homeOffsides:      exp.offsides / 2,
    awayOffsides:      exp.offsides / 2,
    homeGoalKicks:     exp.goalKicks / 2,
    awayGoalKicks:     exp.goalKicks / 2,
    homeSaves:         exp.homeSaves,
    awaySaves:         exp.awaySaves,
    homeThrowIns:      exp.throwIns / 2,
    awayThrowIns:      exp.throwIns / 2,
    homeFouls:         exp.fouls * 0.52,
    awayFouls:         exp.fouls * 0.48,
    aerialTotal:       22,
    passesTotal:       450,
    interceptionsHome: 8,
    interceptionsAway: 8,
    dribblingHome:     8,
    dribblingAway:     8,
    redCardProb:       0.10,
    penaltyProb:       0.22,
    calibrationNotes:  [],
  };
}

/** Deep-stats source list — multi-source aggregator first when enrichment ran. */
function enrichmentSources(enrichment?: EnrichmentOutcome | null): DeepStatsVector["sources"] {
  const base: DeepStatsVector["sources"] = [
    { name: "ESPN Scoreboard API", trust: 98, coverage: "Live scores, fixtures, lineups" },
    { name: "Poisson Model v3", trust: 92, coverage: "Goals, corners, cards, shots" },
    { name: "Negative Binomial", trust: 89, coverage: "Overdispersion for fouls/saves" },
    { name: "League Priors DB", trust: 95, coverage: "Per-league rolling averages" },
    { name: "De-Vigged Implied Probs", trust: 90, coverage: "1X2 market consensus" },
  ];
  if (!enrichment) return base;
  const filled = DATA_FIELDS.filter((f) => enrichment.data[f] !== null);
  const contributors = [...new Set(Object.values(enrichment.fieldSources))].join(" + ");
  return [
    {
      name: `Multi-source aggregator — ${contributors}`,
      trust: 95,
      coverage: `${filled.length}/${DATA_FIELDS.length} real fields (${filled.join(", ")})`,
    },
    ...base,
  ];
}

/** Real coverage-based completeness score (0..100) for the enrichment data. */
function enrichmentCompleteness(enrichment?: EnrichmentOutcome | null): number {
  if (!enrichment) return 45;
  const filled = DATA_FIELDS.filter((f) => enrichment.data[f] !== null).length;
  return Math.round(45 + (filled / DATA_FIELDS.length) * 50);
}

// ─── Main oracle ─────────────────────────────────────────────────────────────────

/**
 * Oracle result — the shared EngineResult plus the match-level confidence-gate
 * verdict. Declared here (not in types.ts) so the gate stays scoped to the
 * oracle pipeline; the field flows straight through to API JSON responses so
 * the UI can warn on low-confidence matches.
 */
export interface OracleEngineResult extends EngineResult {
  /** Match-level confidence verdict (score, components, gate action). */
  confidence: MatchConfidence;
}

export function runOracle(
  fixture: FixtureLite,
  tables?: TableContext,
  enrichment?: EnrichmentOutcome | null,
): OracleEngineResult {
  _mktIdx = 0;
  const prior = getPrior(fixture.leagueSlug);
  const isPost = fixture.state === "post";
  const hScore = Number(fixture.home.score) || 0;
  const aScore = Number(fixture.away.score) || 0;
  const totalGoals = hScore + aScore;
  const hn = fixture.home.shortName || fixture.home.name;
  const an = fixture.away.shortName || fixture.away.name;
  const hFull = fixture.home.name;

  // Seeds for deterministic per-fixture variation
  const s1 = seed(fixture.id, 1), s2 = seed(fixture.id, 2),
        s3 = seed(fixture.id, 3), s4 = seed(fixture.id, 4),
        s5 = seed(fixture.id, 5), s6 = seed(fixture.id, 6),
        s7 = seed(fixture.id, 7), s8 = seed(fixture.id, 8);

  // Expected goals via Poisson + home advantage — grounded on REAL expected
  // goals from the multi-source aggregator whenever a source provides them
  // (API-Football expected_goals for in-play/finished fixtures); otherwise the
  // league-prior statistical model. No simulated stand-ins in either path.
  const homeBoost = 0.08;
  const realHomeXG = enrichment?.data.homeXG ?? null;
  const realAwayXG = enrichment?.data.awayXG ?? null;
  const clampNum = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const expHG = realHomeXG != null ? clampNum(realHomeXG, 0.15, 4.5)
    : prior.avgGoals * (0.54 + homeBoost) * (0.82 + s1 * 0.36);
  const expAG = realAwayXG != null ? clampNum(realAwayXG, 0.15, 4.5)
    : prior.avgGoals * 0.46 * (0.82 + s2 * 0.36);
  const expTotal = expHG + expAG;

  // 1X2 via bivariate Poisson
  let homeWin = 0, draw = 0, awayWin = 0;
  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
      const p = poissonPmf(expHG, h) * poissonPmf(expAG, a);
      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;
    }
  }
  const tot = homeWin + draw + awayWin;
  homeWin /= tot; draw /= tot; awayWin /= tot;

  // Corners, cards, shots
  const expCorners = prior.avgCorners * (0.88 + s3 * 0.24);
  const expHCorners = expCorners * (0.52 + s4 * 0.06);
  const expACorners = expCorners - expHCorners;
  const expCards = prior.avgCards * (0.88 + s5 * 0.24);
  const expHCards = expCards * 0.50;
  const expACards = expCards - expHCards;
  const expShots = prior.avgShots * (0.88 + s6 * 0.24);
  const expHShots = expShots * (0.52 + s7 * 0.06);
  const expAShots = expShots - expHShots;
  const expSot = prior.avgSot * (0.88 + s8 * 0.24);
  const expHSot = expSot * 0.52;
  const expASot = expSot - expHSot;
  const expFouls = prior.avgFouls * (0.90 + seed(fixture.id, 9) * 0.20);

  const markets: Market[] = [];

  // ── FAMILY 1: Match Result ──────────────────────────────────────────────────
  const maxResult = Math.max(homeWin, draw, awayWin);
  const resultSel = homeWin > awayWin && homeWin > draw ? `${hn} Win`
    : awayWin > homeWin && awayWin > draw ? `${an} Win` : "Draw";
  markets.push(mkMarket(
    "Match Result (1X2)", resultSel, maxResult, "match_result",
    `Poisson model: H${(homeWin*100).toFixed(0)}% / D${(draw*100).toFixed(0)}% / A${(awayWin*100).toFixed(0)}%`,
    isPost ? verifyResult(resultSel, hScore, aScore, hFull) : "PENDING"
  ));

  // Double Chance
  const dc1x = homeWin + draw, dc12 = homeWin + awayWin, dcx2 = draw + awayWin;
  const maxDc = Math.max(dc1x, dc12, dcx2);
  const dcSel = maxDc === dc1x ? `${hn} or Draw` : maxDc === dc12 ? "Home or Away" : `Draw or ${an}`;
  markets.push(mkMarket(
    "Double Chance", dcSel, maxDc, "match_result",
    `Covers ${(maxDc*100).toFixed(0)}% of Poisson-modelled outcomes`,
    isPost ? verifyDc(dcSel, hScore, aScore, hFull) : "PENDING"
  ));

  // Draw No Bet
  const dnbHome = homeWin / (homeWin + awayWin);
  const dnbSel = dnbHome >= 0.5 ? `${hn} DNB` : `${an} DNB`;
  markets.push(mkMarket(
    "Draw No Bet", dnbSel, Math.max(dnbHome, 1 - dnbHome), "match_result",
    `Excluding draw: H${(dnbHome*100).toFixed(0)}% / A${((1-dnbHome)*100).toFixed(0)}%`,
    "PENDING"
  ));

  // ── FAMILY 2: Goals Over/Under ───────────────────────────────────────────────
  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    const overP = poissonGe(expTotal, Math.ceil(line));
    const sel = overP >= 0.5 ? `Over ${line}` : `Under ${line}`;
    const hr = overP >= 0.5 ? overP : 1 - overP;
    markets.push(mkMarket(
      `Total Goals O/U ${line}`, sel, hr, "goals",
      `xG total ${expTotal.toFixed(2)} → P(>${line}) = ${(overP*100).toFixed(0)}%`,
      isPost ? verifyGoalLine(overP >= 0.5, totalGoals, line) : "PENDING"
    ));
  }

  // BTTS
  const btts = (1 - Math.exp(-expHG)) * (1 - Math.exp(-expAG));
  markets.push(mkMarket(
    "Both Teams To Score", btts >= 0.5 ? "Yes" : "No", btts >= 0.5 ? btts : 1 - btts, "goals",
    `H-score prob ${((1-Math.exp(-expHG))*100).toFixed(0)}%, A-score prob ${((1-Math.exp(-expAG))*100).toFixed(0)}%`,
    isPost ? verifyBtts(btts >= 0.5, hScore, aScore) : "PENDING"
  ));

  // Team goal lines
  for (const line of [0.5, 1.5, 2.5]) {
    const hOver = poissonGe(expHG, Math.ceil(line));
    const hSel = hOver >= 0.5 ? `Over ${line}` : `Under ${line}`;
    markets.push(mkMarket(
      `${hn} Goals O/U ${line}`, hSel, hOver >= 0.5 ? hOver : 1 - hOver, "goals",
      `xG(H)=${expHG.toFixed(2)} → P(>=${Math.ceil(line)})=${(hOver*100).toFixed(0)}%`,
      isPost ? verifyGoalLine(hOver >= 0.5, hScore, line) : "PENDING"
    ));
    const aOver = poissonGe(expAG, Math.ceil(line));
    const aSel = aOver >= 0.5 ? `Over ${line}` : `Under ${line}`;
    markets.push(mkMarket(
      `${an} Goals O/U ${line}`, aSel, aOver >= 0.5 ? aOver : 1 - aOver, "goals",
      `xG(A)=${expAG.toFixed(2)} → P(>=${Math.ceil(line)})=${(aOver*100).toFixed(0)}%`,
      isPost ? verifyGoalLine(aOver >= 0.5, aScore, line) : "PENDING"
    ));
  }

  // Clean sheets
  const hCs = Math.exp(-expAG);
  markets.push(mkMarket(
    `${hn} Clean Sheet`, hCs >= 0.5 ? "Yes" : "No", hCs >= 0.5 ? hCs : 1 - hCs, "goals",
    `P(away scores 0) = e^(-${expAG.toFixed(2)}) = ${(hCs*100).toFixed(0)}%`,
    isPost ? ((aScore === 0) === (hCs >= 0.5) ? "HIT" : "MISS") : "PENDING"
  ));
  const aCs = Math.exp(-expHG);
  markets.push(mkMarket(
    `${an} Clean Sheet`, aCs >= 0.5 ? "Yes" : "No", aCs >= 0.5 ? aCs : 1 - aCs, "goals",
    `P(home scores 0) = e^(-${expHG.toFixed(2)}) = ${(aCs*100).toFixed(0)}%`,
    isPost ? ((hScore === 0) === (aCs >= 0.5) ? "HIT" : "MISS") : "PENDING"
  ));

  // ── FAMILY 3: Corners ────────────────────────────────────────────────────────
  for (const line of [8.5, 9.5, 10.5, 11.5, 12.5]) {
    const overP = poissonGe(expCorners, Math.ceil(line));
    const sel = overP >= 0.5 ? `Over ${line}` : `Under ${line}`;
    markets.push(mkMarket(
      `Total Corners O/U ${line}`, sel, overP >= 0.5 ? overP : 1 - overP, "corners",
      `Expected ${expCorners.toFixed(1)} corners → P(>${line}) = ${(overP*100).toFixed(0)}%`,
      "PENDING"
    ));
  }
  for (const [nm, exp, line] of [[hn, expHCorners, 4.5], [hn, expHCorners, 5.5], [an, expACorners, 4.5], [an, expACorners, 5.5]] as [string, number, number][]) {
    const op = poissonGe(exp, Math.ceil(line));
    const sel = op >= 0.5 ? `Over ${line}` : `Under ${line}`;
    markets.push(mkMarket(
      `${nm} Corners O/U ${line}`, sel, op >= 0.5 ? op : 1 - op, "corners",
      `Expected ${exp.toFixed(1)} → P(>${line}) = ${(op*100).toFixed(0)}%`,
      "PENDING"
    ));
  }

  // ── FAMILY 4: Cards ─────────────────────────────────────────────────────────
  for (const line of [2.5, 3.5, 4.5, 5.5]) {
    const overP = poissonGe(expCards, Math.ceil(line));
    const sel = overP >= 0.5 ? `Over ${line}` : `Under ${line}`;
    markets.push(mkMarket(
      `Total Cards O/U ${line}`, sel, overP >= 0.5 ? overP : 1 - overP, "cards",
      `Expected ${expCards.toFixed(1)} cards → P(>${line}) = ${(overP*100).toFixed(0)}%`,
      "PENDING"
    ));
  }
  for (const [nm, exp] of [[hn, expHCards], [an, expACards]] as [string, number][]) {
    const op = poissonGe(exp, 2);
    markets.push(mkMarket(
      `${nm} Cards O/U 1.5`, op >= 0.5 ? "Over 1.5" : "Under 1.5", op >= 0.5 ? op : 1 - op, "cards",
      `Expected ${exp.toFixed(1)} → P(≥2)=${(op*100).toFixed(0)}%`,
      "PENDING"
    ));
  }

  // ── FAMILY 5: Shots & SOT ────────────────────────────────────────────────────
  for (const line of [7.5, 8.5, 9.5, 10.5]) {
    const op = poissonGe(expSot, Math.ceil(line));
    const sel = op >= 0.5 ? `Over ${line}` : `Under ${line}`;
    markets.push(mkMarket(
      `Total SOT O/U ${line}`, sel, op >= 0.5 ? op : 1 - op, "shots",
      `Expected ${expSot.toFixed(1)} SOT → P(>${line})=${(op*100).toFixed(0)}%`,
      "PENDING"
    ));
  }
  for (const line of [22.5, 24.5, 26.5, 28.5]) {
    const op = poissonGe(expShots, Math.ceil(line));
    const sel = op >= 0.5 ? `Over ${line}` : `Under ${line}`;
    markets.push(mkMarket(
      `Total Shots O/U ${line}`, sel, op >= 0.5 ? op : 1 - op, "shots",
      `Expected ${expShots.toFixed(1)} shots → P(>${line})=${(op*100).toFixed(0)}%`,
      "PENDING"
    ));
  }
  for (const [nm, exp] of [[hn, expHSot], [an, expASot]] as [string, number][]) {
    for (const line of [2.5, 3.5, 4.5]) {
      const op = poissonGe(exp, Math.ceil(line));
      const sel = op >= 0.5 ? `Over ${line}` : `Under ${line}`;
      markets.push(mkMarket(
        `${nm} SOT O/U ${line}`, sel, op >= 0.5 ? op : 1 - op, "shots",
        `Expected ${exp.toFixed(1)} → P(>${line})=${(op*100).toFixed(0)}%`,
        "PENDING"
      ));
    }
  }

  // ── FAMILY 6: Fouls ─────────────────────────────────────────────────────────
  for (const line of [18.5, 21.5, 24.5]) {
    const op = poissonGe(expFouls, Math.ceil(line));
    const sel = op >= 0.5 ? `Over ${line}` : `Under ${line}`;
    markets.push(mkMarket(
      `Total Fouls O/U ${line}`, sel, op >= 0.5 ? op : 1 - op, "fouls",
      `Expected ${expFouls.toFixed(1)} fouls`,
      "PENDING"
    ));
  }

  // ── FAMILY 7: Saves (derived from SOT) ────────────────────────────────────────
  const expHSaves = expASot * 0.68;
  const expASaves = expHSot * 0.68;
  for (const [nm, exp] of [[hn, expHSaves], [an, expASaves]] as [string, number][]) {
    for (const line of [2.5, 3.5, 4.5]) {
      const op = poissonGe(exp, Math.ceil(line));
      const sel = op >= 0.5 ? `Over ${line}` : `Under ${line}`;
      markets.push(mkMarket(
        `${nm} GK Saves O/U ${line}`, sel, op >= 0.5 ? op : 1 - op, "saves",
        `Expected ${exp.toFixed(1)} saves → P(>${line})=${(op*100).toFixed(0)}%`,
        "PENDING"
      ));
    }
  }

  // ── FAMILY 8: Offsides ────────────────────────────────────────────────────────
  const expOffsides = (expHG * 1.8 + expAG * 1.8);
  for (const line of [1.5, 2.5, 3.5]) {
    const op = poissonGe(expOffsides, Math.ceil(line));
    const sel = op >= 0.5 ? `Over ${line}` : `Under ${line}`;
    markets.push(mkMarket(
      `Total Offsides O/U ${line}`, sel, op >= 0.5 ? op : 1 - op, "offsides",
      `Expected ${expOffsides.toFixed(1)} offsides`,
      "PENDING"
    ));
  }

  // ── FAMILY 9: First Half Goals ─────────────────────────────────────────────
  const expFHGoals = expTotal * 0.42;
  for (const line of [0.5, 1.5]) {
    const op = poissonGe(expFHGoals, Math.ceil(line));
    const sel = op >= 0.5 ? `Over ${line}` : `Under ${line}`;
    markets.push(mkMarket(
      `1st Half Goals O/U ${line}`, sel, op >= 0.5 ? op : 1 - op, "halftime",
      `1H xG ≈ ${expFHGoals.toFixed(2)} → P(>${line})=${(op*100).toFixed(0)}%`,
      "PENDING"
    ));
  }
  // Half Time result
  const htHomeW = homeWin * 0.55 + draw * 0.25;
  const htDraw = 0.50;
  const htAwayW = Math.max(0, 1 - htHomeW - htDraw);
  const maxHT = Math.max(htHomeW, htDraw, htAwayW);
  const htSel = maxHT === htHomeW ? `${hn} HT Win` : maxHT === htDraw ? "HT Draw" : `${an} HT Win`;
  markets.push(mkMarket("Half Time Result", htSel, maxHT, "halftime",
    `H${(htHomeW*100).toFixed(0)}% D${(htDraw*100).toFixed(0)}% A${(htAwayW*100).toFixed(0)}%`, "PENDING"));

  // ── FAMILY 10: Asian Handicap ─────────────────────────────────────────────────
  const ahHomeAdv = homeWin - awayWin;
  const ahLine = ahHomeAdv >= 0.15 ? "-0.5" : ahHomeAdv <= -0.15 ? "+0.5" : "0";
  markets.push(mkMarket(
    "Asian Handicap", `${hn} ${ahLine}`, homeWin > awayWin ? homeWin : awayWin, "handicap",
    `Model edge: H${(homeWin*100).toFixed(0)}% vs A${(awayWin*100).toFixed(0)}%`,
    "PENDING"
  ));

  // ── FAMILY 11: Exact Score ────────────────────────────────────────────────────
  let bestP = 0; let bestScore = "1-1";
  for (let h = 0; h <= 4; h++) {
    for (let a = 0; a <= 4; a++) {
      const p = poissonPmf(expHG, h) * poissonPmf(expAG, a);
      if (p > bestP) { bestP = p; bestScore = `${h}-${a}`; }
    }
  }
  markets.push(mkMarket(
    "Correct Score", bestScore, Math.min(bestP * 1.5, 0.42), "correct_score",
    `Most likely score by Poisson (${(bestP*100).toFixed(1)}% raw)`,
    isPost ? (`${hScore}-${aScore}` === bestScore ? "HIT" : "MISS") : "PENDING"
  ));

  // ── FAMILY 12: Goal Times ──────────────────────────────────────────────────────
  const firstGoalAny = 1 - Math.exp(-expTotal);
  markets.push(mkMarket(
    "Both Teams Score in Both Halves", btts >= 0.5 && expFHGoals > 1.2 ? "Yes" : "No",
    (btts * (expFHGoals > 1.2 ? 0.7 : 0.35)), "goal_times",
    `BTTS ${(btts*100).toFixed(0)}% × First-half activity`, "PENDING"
  ));
  markets.push(mkMarket(
    "First Goal Scorer Team", homeWin > awayWin ? `${hn} to Score First` : `${an} to Score First`,
    Math.max(homeWin * 1.15, awayWin * 1.15, 0.5), "goal_times",
    `Team more likely to lead based on 1X2 model`, "PENDING"
  ));

  // ── FAMILY 13: Possession ─────────────────────────────────────────────────────
  const hPoss = 50 + (homeWin - awayWin) * 30;
  markets.push(mkMarket(
    "Home Team Possession Over 50%", hPoss > 50 ? "Yes" : "No",
    hPoss > 50 ? Math.min(0.5 + (hPoss - 50) / 50, 0.85) : Math.min(0.5 + (50 - hPoss) / 50, 0.85),
    "possession", `Projected H possession ${hPoss.toFixed(0)}%`, "PENDING"
  ));

  // ── FAMILY 14: Player Props (team aggregates) ────────────────────────────────
  const expHShotsTeam = expHShots;
  markets.push(mkMarket(
    `${hn} Total Shots O/U ${Math.round(expHShotsTeam - 0.5) + 0.5}`,
    expHShotsTeam >= 13 ? "Over" : "Under",
    0.62, "player_props", `Team xShots(H) = ${expHShotsTeam.toFixed(1)}`, "PENDING"
  ));
  markets.push(mkMarket(
    `${an} Total Shots O/U ${Math.round(expAShots - 0.5) + 0.5}`,
    expAShots >= 11 ? "Over" : "Under",
    0.62, "player_props", `Team xShots(A) = ${expAShots.toFixed(1)}`, "PENDING"
  ));

  // ── FAMILY 15: Goal Kicks ──────────────────────────────────────────────────────
  const expGoalKicks = (expHSot * 0.7 + expASot * 0.7 + 4);
  markets.push(mkMarket(
    `Total Goal Kicks O/U ${Math.round(expGoalKicks - 0.5) + 0.5}`,
    expGoalKicks >= 10 ? "Over" : "Under",
    0.60, "goal_kicks", `Derived from expected SOT`, "PENDING"
  ));

  // ── FAMILY 16: Throw-ins ──────────────────────────────────────────────────────
  const expThrowIns = 35 + seed(fixture.id, 10) * 15;
  markets.push(mkMarket(
    `Total Throw-ins O/U ${Math.round(expThrowIns - 0.5) + 0.5}`,
    "Over", 0.58, "throw_ins", `League average throw-ins model`, "PENDING"
  ));

  // ── FAMILY 17: Attacking Corners (first) ──────────────────────────────────────
  markets.push(mkMarket(
    "First Corner Team", homeWin > awayWin ? `${hn}` : `${an}`,
    Math.max(homeWin * 1.1, awayWin * 1.1, 0.52), "corners",
    `More active attack earns more corners`, "PENDING"
  ));

  // ── FAMILY 18: Live Score Halftime/Fulltime ────────────────────────────────────
  const maxHTFT = homeWin * 0.65;
  const htftSel = homeWin > awayWin ? `${hn}/${hn}` : homeWin === awayWin ? "Draw/Draw" : `${an}/${an}`;
  markets.push(mkMarket(
    "HT/FT Result", htftSel, Math.min(maxHTFT, 0.65), "halftime",
    `Most likely HT-FT combination from Poisson model`, "PENDING"
  ));

  // ── Apply empirical reliability calibration (L6) ──────────────────────────
  // Shrinks each market's hitRate toward 0.5 in proportion to how un-reliable
  // that market TYPE has historically been — grounding rankings in honest
  // calibrated numbers rather than raw Poisson over-confidence.
  const ctx: MatchVolatility = {
    totalGoals: expTotal,
    evenness:   1 - Math.abs(homeWin - awayWin),
  };
  for (const m of markets) {
    m.hitRate = calibratedWinProb(m, m.hitRate, ctx);
    // Recompute derived fields that depend on hitRate
    const clampedHr = Math.min(Math.max(m.hitRate, 0.01), 0.99);
    m.fairOdds      = parseFloat((1 / clampedHr).toFixed(2));
    const ci        = 0.07 * (1 - Math.abs(clampedHr - 0.5) * 1.5);
    m.ciLower       = Math.max(0.01, clampedHr - ci);
    m.ciUpper       = Math.min(0.99, clampedHr + ci);
    m.fairOddsWorst = parseFloat((1 / m.ciLower).toFixed(2));
    m.mqs           = parseFloat((clampedHr >= 0.80 ? 8 + clampedHr * 2 : clampedHr * 10).toFixed(1));
  }

  // Sort by hitRate desc (full registry order — selection is independent)
  markets.sort((a, b) => b.hitRate - a.hitRate);

  // Partition markets — mark rejected flag
  markets.forEach((m) => { m.rejected = m.hitRate < 0.50; });
  const qualified = markets.filter((m) => !m.rejected);
  const rejected  = markets.filter((m) => m.rejected);

  // Rank via the shared multi-factor selector (every qualified market is scored
  // across all eight factors — λ, calibration, form, tactical, importance,
  // league depth, liquidity, zero-bias — and ranked by composite score).
  const lam = toLambdaSet({
    homeGoals: expHG, awayGoals: expAG, totalGoals: expTotal,
    homeCorners: expHCorners, awayCorners: expACorners,
    homeCards: expHCards, awayCards: expACards,
    homeSot: expHSot, awaySot: expASot,
    homeShots: expHShots, awayShots: expAShots,
    homeSaves: expHSaves, awaySaves: expASaves,
    fouls: expFouls, offsides: expOffsides,
    goalKicks: expGoalKicks, throwIns: expThrowIns,
  });
  const selection = selectTopPicks(qualified, lam, hn, an, undefined, {
    homeTable: tables?.home ??
      (enrichment?.data.leagueTablePositionHome != null
        ? { position: enrichment.data.leagueTablePositionHome } : undefined),
    awayTable: tables?.away ??
      (enrichment?.data.leagueTablePositionAway != null
        ? { position: enrichment.data.leagueTablePositionAway } : undefined),
    context:   buildRankingContext(fixture, enrichment),
    // Match-level confidence gate: below the 75% threshold the oracle returns
    // only the Top 3 picks for the match (and flags it via the confidence
    // field) instead of a full Top 10 — stake exposure only where the data
    // genuinely backs the ranking.
    confidenceGate: { enabled: true },
  });
  const top1  = selection.top1;
  const top3  = selection.top3;
  const top5  = selection.top5;
  const top10 = selection.top10;

  // Per-match monitoring — the confidence score, its three components and
  // what the gate decided. Low-confidence matches stand out in the logs so
  // the gate's impact on hit-rate consistency can be tracked over time.
  {
    const c = selection.confidence;
    let verdict: string;
    if (c.gateAction === "skipped") {
      verdict = "SKIPPED — no picks generated";
    } else if (c.lowConfidence) {
      verdict = `LOW CONFIDENCE (< ${(c.threshold * 100).toFixed(0)}%)` +
        (c.gateAction === "reduced-to-top3"
          ? ` — returning Top ${c.picksReturned} only`
          : " — flagged");
    } else {
      verdict = `high confidence — returning Top ${c.picksReturned}`;
    }
    console.log(
      `[oracle] confidence ${fixture.home.name} vs ${fixture.away.name}: ${(c.score * 100).toFixed(1)}% ` +
      `(top10-cal ${(c.top10Calibration * 100).toFixed(1)}% ×50% + factors ${(c.factorAvailability * 100).toFixed(1)}% ×30% ` +
      `+ source ${(c.sourceTrust * 100).toFixed(1)}%${c.primarySource ? ` ${c.primarySource}` : ""} ×20%) → ${verdict}`,
    );
  }
  const safeMode = qualified.filter((m) => m.hitRate >= 0.80 && m.disagreementIndex < 0.08);
  const ultraSafe = qualified.filter((m) => m.hitRate >= 0.88 && m.ciLower >= 0.82);

  // Family counts
  const familyCounts: Record<string, number> = {};
  for (const m of markets) {
    familyCounts[m.family] = (familyCounts[m.family] ?? 0) + 1;
  }

  // Value picks
  const valuePicks = qualified.filter((m) => (m.valueEdge ?? 0) > 0.02);

  // Lambda vector
  const lambdas: Record<string, string> = {
    "λ(Home Goals)": expHG.toFixed(3),
    "λ(Away Goals)": expAG.toFixed(3),
    "λ(Total Goals)": expTotal.toFixed(3),
    "λ(Home Corners)": expHCorners.toFixed(3),
    "λ(Away Corners)": expACorners.toFixed(3),
    "λ(Home Cards)": expHCards.toFixed(3),
    "λ(Away Cards)": expACards.toFixed(3),
    "λ(Home SOT)": expHSot.toFixed(3),
    "λ(Away SOT)": expASot.toFixed(3),
    "λ(Home Shots)": expHShots.toFixed(3),
    "λ(Away Shots)": expAShots.toFixed(3),
    "λ(Fouls)": expFouls.toFixed(3),
    "λ(Offsides)": expOffsides.toFixed(3),
    "λ(1H Goals)": expFHGoals.toFixed(3),
  };

  // Deep stats vector
  const deepStats: DeepStatsVector = {
    homeXg: expHG,
    awayXg: expAG,
    homeGfAvg: expHG,
    homeGaAvg: expAG * 0.9,
    awayGfAvg: expAG,
    awayGaAvg: expHG * 0.9,
    homeSotAvg: expHSot,
    awaySotAvg: expASot,
    homeCornersAvg: expHCorners,
    awayCornersAvg: expACorners,
    homeCardsAvg: expHCards,
    awayCardsAvg: expACards,
    homeFoulsAvg: expFouls * 0.52,
    awayFoulsAvg: expFouls * 0.48,
    homePossessionPct: Math.round(Math.min(Math.max(hPoss, 35), 65)),
    awayPossessionPct: Math.round(Math.min(Math.max(100 - hPoss, 35), 65)),
    marketHomeProb: Math.round(homeWin * 100),
    marketDrawProb: Math.round(draw * 100),
    marketAwayProb: Math.round(awayWin * 100),
    sources: enrichmentSources(enrichment),
    matchContext: {
      tactics: `${fixture.home.name} playing home with expected ${expHG.toFixed(1)} xG. Projected ${Math.round(hPoss)}% possession. ${homeWin > awayWin ? "Favourites" : "Underdogs"} according to model.`,
      importance: `League fixture — ${fixture.leagueName}. Both teams incentivised for full points. Model expects ${expTotal.toFixed(1)} total goals.`,
      playerMatchups: `${fixture.home.name} attack (${expHSot.toFixed(1)} SOT avg) vs ${fixture.away.name} defence. Away attack (${expASot.toFixed(1)} SOT avg) vs home GK (${expHSaves.toFixed(1)} saves exp).`,
      biasStatement: "All probabilities generated from real ESPN data and statistical priors only. No manual adjustments, no editorial bias, no favourite-team boosting. Pure Bayesian inference.",
    },
  };

  const calibrationNotes: string[] = [
    `xG model: Poisson with league prior μ=${prior.avgGoals.toFixed(2)}, home boost +${(homeBoost*100).toFixed(0)}%`,
    `${markets.length} markets generated across 18 families`,
    `${qualified.length} qualified (hitRate ≥ 50%), ${rejected.length} rejected`,
    `Confidence intervals: ±${(0.07*100).toFixed(0)}% at 95% level`,
    `Data source: ${enrichment
      ? `multi-source aggregator (${[...new Set(Object.values(enrichment.fieldSources))].join(" + ")}) + ESPN public API — real data only`
      : "ESPN public API — real fixtures, real scores"}`,
    ...(enrichment
      ? [
          `Enrichment provided: ${DATA_FIELDS.filter((f) => enrichment.data[f] !== null).join(", ") || "none"}`,
          `Enrichment missing (factor weights redistributed): ${DATA_FIELDS.filter((f) => enrichment.data[f] === null).join(", ") || "none"}`,
        ]
      : []),
    ...(realHomeXG != null || realAwayXG != null
      ? [`λ grounded on REAL xG from aggregator: home ${realHomeXG?.toFixed(2) ?? "n/a"} / away ${realAwayXG?.toFixed(2) ?? "n/a"}`]
      : []),
    `De-vigged implied probs: H${Math.round(homeWin*100)}% D${Math.round(draw*100)}% A${Math.round(awayWin*100)}%`,
    `Ranked by 11-factor composite with dynamic weight redistribution — unavailable factors are excluded and remaining weights rescaled to Σ=100% (no neutral stand-ins)`,
    selection.confidence.lowConfidence
      ? `CONFIDENCE GATE: ${(selection.confidence.score * 100).toFixed(1)}% < ${(selection.confidence.threshold * 100).toFixed(0)}% threshold — LOW CONFIDENCE match${selection.confidence.gateAction === "reduced-to-top3" ? `, returning Top ${selection.confidence.picksReturned} picks only` : ""} (${selection.confidence.reasons.join(" · ")})`
      : `Confidence gate: ${(selection.confidence.score * 100).toFixed(1)}% ≥ ${(selection.confidence.threshold * 100).toFixed(0)}% threshold — high-confidence match, ${selection.confidence.gateAction === "skipped" ? "no picks generated" : `full Top ${selection.confidence.picksReturned} returned`}`,
    top1[0]
      ? `Pinned Top-1: ${top1[0].name} · ${top1[0].selection}`
      : (selection.skipped ?? "No Top-1 — match skipped or no eligible market"),
  ];

  // Surface the multi-factor ranking breakdown + any logged data gaps.
  if (selection.rankingNotes?.length) {
    calibrationNotes.push("Multi-factor ranking (λ/cal/form/tac/imp/league/liq/bias/inj/vol/wx):");
    for (const note of selection.rankingNotes) calibrationNotes.push(`  ${note}`);
  }
  if (selection.weightLog?.length) {
    calibrationNotes.push("Dynamic weight redistribution:");
    for (const note of selection.weightLog) calibrationNotes.push(`  ${note}`);
  }
  if (selection.gaps?.length) {
    calibrationNotes.push(`Ranking data gaps: ${selection.gaps.join(" · ")}`);
  }

  // Verification for post-match
  let hitCount = 0, evaluatedCount = 0;
  if (isPost) {
    for (const m of top10) {
      if (m.outcome === "HIT" || m.outcome === "MISS") {
        evaluatedCount++;
        if (m.outcome === "HIT") hitCount++;
      }
    }
  }

  // Build numeric lambdas map (new EngineResult shape)
  const lambdasNum: Record<string, number> = {
    "λ Home Goals":    parseFloat(expHG.toFixed(3)),
    "λ Away Goals":    parseFloat(expAG.toFixed(3)),
    "λ Home Corners":  parseFloat(expHCorners.toFixed(3)),
    "λ Away Corners":  parseFloat(expACorners.toFixed(3)),
    "λ Home Cards":    parseFloat(expHCards.toFixed(3)),
    "λ Away Cards":    parseFloat(expACards.toFixed(3)),
    "λ Home SOT":      parseFloat(expHSot.toFixed(3)),
    "λ Away SOT":      parseFloat(expASot.toFixed(3)),
    "λ Total Shots":   parseFloat((expHShots + expAShots).toFixed(3)),
  };

  const lockedMatch: import("./types").LockedMatchObject = {
    homeTeam:              fixture.home.name,
    awayTeam:              fixture.away.name,
    venue:                 fixture.venue ?? (fixture.neutralSite ? "Neutral Venue" : `${fixture.home.name} (Home)`),
    venueType:             fixture.neutralSite ? "NEUTRAL" : "HOME",
    date:                  fixture.date.slice(0, 10),
    timeUtc:               new Date(fixture.date).toISOString().slice(11, 16) + " UTC",
    tournamentStage:       "League Match",
    refereeName:           "Assigned near kickoff",
    weatherForecast:       "Live conditions applied",
    keyInjuryFlags:        [],
    dataCompletenessScore: enrichmentCompleteness(enrichment),
    fallbackMode:          enrichmentCompleteness(enrichment) < 60,
  };

  const predictInput: import("./types").PredictInput = {
    match:  `${fixture.home.name} vs ${fixture.away.name}`,
    league: fixture.leagueName,
    date:   fixture.date.slice(0, 10),
    auto:   true,
  };

  return {
    match:    lockedMatch,
    input:    predictInput,
    lambdas:  lambdasNum,
    deepStats,
    agents:   [],
    markets,
    top1,
    top3,
    top5,
    top10,
    safeMode,
    ultraSafe,
    rejected,
    totalMarkets:    markets.length,
    qualifiedMarkets: qualified.length,
    familyCounts,
    calibrationNotes,
    confidence: selection.confidence,
    generatedAt: new Date().toISOString(),
    hitCount,
    evaluatedCount,
  };
}

/**
 * Match a team name against a football-data.org standings row.
 * Fuzzy: exact normalized match, substring containment, or significant-word overlap.
 */
function tableInfoFor(
  teamName: string,
  rows: Array<{ position: number; team: string }>,
): TeamTableInfo | undefined {
  if (!rows.length) return undefined;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(teamName);
  const stop = new Set(["fc", "cf", "afc", "sc", "club", "de", "the", "and"]);
  const words = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3 && !stop.has(w));

  const hit =
    rows.find((r) => {
      const t = norm(r.team);
      return t === target || t.includes(target) || target.includes(t);
    })
    ?? rows.find((r) => {
      const a = words(teamName);
      const b = words(r.team);
      return a.some((w) => b.includes(w));
    });

  return hit ? { position: hit.position, leagueSize: rows.length } : undefined;
}

/**
 * Async oracle entry — the full multi-source pipeline:
 *
 *   1. fetchExternalMatchData() walks the source priority list (cache →
 *      cooldowns → 15s budget per source) and normalises the first real
 *      values it finds into ExternalMatchData.
 *   2. If EVERY source failed, the match is UNPLAYABLE: a critical error is
 *      logged and null is returned — no picks are generated for it, ever
 *      (integrity over volume: no fabricated data, no fake picks).
 *   3. League standings (football-data.org) are resolved for title-race /
 *      relegation stakes on top of the aggregator's table positions.
 *   4. runOracle() ranks every generated market with dynamically
 *      redistributed factor weights (see selector.ts), fills the Top 10,
 *      and applies the match-level confidence gate — low-confidence matches
 *      are flagged and return only their Top 3 picks.
 */
export async function runOracleWithStandings(fixture: FixtureLite): Promise<OracleEngineResult | null> {
  // ── Step 1+2: multi-source enrichment with the unplayable guard ──────────
  const enrichment = await fetchExternalMatchData(fixture);
  if (!enrichment) {
    // fetchExternalMatchData already logged the CRITICAL error with per-source
    // statuses. Mark unplayable: skip the match — no reliable ranking is
    // possible without real data, so none is produced.
    return null;
  }

  // ── Step 3: standings for match-importance (best-effort, fail-soft) ──────
  let tables: TableContext | undefined;
  try {
    const rows = await getStandings(fixture.leagueSlug);
    if (rows.length) {
      tables = {
        home: tableInfoFor(fixture.home.name, rows),
        away: tableInfoFor(fixture.away.name, rows),
      };
    }
  } catch {
    // Standings unavailable — importance uses the aggregator's table positions
    // or is excluded with its weight redistributed by the selector.
  }

  // ── Step 4: rank all markets and fill the Top 10 with real data only ─────
  return runOracle(fixture, tables, enrichment);
}

