// ĞIGI GIVØ — Fixture feed.
//
// Two modes, same response shape:
//   • ?league=<slug>  — existing single-competition path (unchanged window,
//                       plus a `stats` field on every fixture).
//   • ?days=N         — dynamic ALL-competitions path. The competition list
//                       is the data source's live catalogue (ESPN primary,
//                       SportScore / TheSportsDB / OpenLigaDB / API-Football
//                       as fallbacks), with the three UEFA club competitions
//                       always retained as required primary-source targets.
//
// On top of those, openfootball/football.json is fetched through the GitHub
// Contents API (`api.github.com`) for any mapped league the other sources
// left empty. That host is the one data endpoint reachable from deployments
// whose egress allowlist blocks ESPN/SportScore entirely (the failure mode
// documented in docs/NETWORK_ALLOWLIST.md), so it is what keeps the Premier
// League — and therefore /api/correct-score — populated there. The historical
// model layer (src/lib/data/historical.ts) already uses the same repository.
//
// Per-competition fixture lists are cached for 1 hour. Empty catalogue
// entries are logged and retried against fallback sources.

import { fetchAllScoreboard, fetchScoreboard, type FixtureLite } from "@/lib/espn";
import { LEAGUE_MAP, type LeagueDef } from "@/lib/leagues";
import {
  canonicalLeagueSlug,
  compareLeaguePriority,
  espnSlugCandidates,
} from "@/lib/leaguePriority";
import { statsAggregator, type StatsAggregator } from "@/lib/data/aggregator";
import {
  fullTimeScore,
  OPENFOOTBALL_CODES,
  seasonCodes,
} from "@/lib/data/historical";
import type { CanonicalMatchStats, TeamStats } from "@/lib/data/types";
import { resilientJson } from "@/lib/httpClient";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ─── Public types ────────────────────────────────────────────────────────────

type FixtureSource =
  | "ESPN"
  | "SportScore"
  | "OpenLigaDB"
  | "TheSportsDB"
  | "ApiFootball"
  | "Openfootball";

interface CatalogueCompetition {
  slug: string;
  name: string;
}

interface PreMatchTeamStats {
  avgCornersPerGame: number | null;
  avgCornersConcededPerGame: number | null;
  avgCornersLast5: number | null;
  avgCornersConcededLast5: number | null;
  xg: number | null;
  xgPerShot: number | null;
  shots: number | null;
  shotsOnTarget: number | null;
  possession: number | null;
  passes: number | null;
  passAccuracy: number | null;
  form: string | null;
  goalsScoredLast5: number | null;
  goalsConcededLast5: number | null;
  h2hCorners: number | null;
  h2hGoals: number | null;
  leagueAvgCorners: number | null;
  leagueAvgGoals: number | null;
  homeAdvantage: number | null;
  matchImportance: string | null;
  injuryImpact: string | null;
}

interface FixtureStats {
  source: string | null;
  home: PreMatchTeamStats;
  away: PreMatchTeamStats;
  canonical: CanonicalMatchStats | null;
}

type FixtureWithStats = FixtureLite & { stats: FixtureStats | null };

interface SourcedFixture {
  fixture: FixtureLite;
  source: FixtureSource;
}

interface CollectedCompetition {
  leagueSlug: string;
  competitionName: string;
  fixtures: SourcedFixture[];
}

interface CollectedFeed {
  fixtures: FixtureWithStats[];
  competitions: CollectedCompetition[];
  catalogue: CatalogueCompetition[];
  days: number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const ESPN_CORE = "https://sports.core.api.espn.com/v2/sports/soccer/leagues";
const TSDB_BASE = () => (process.env.THESPORTSDB_BASE ?? "https://www.thesportsdb.com").replace(/\/$/, "");
const TSDB_KEY = () => (process.env.THESPORTSDB_KEY ?? "3").trim() || "3";
const SPORTSCORE_BASE = () => (process.env.SPORTSCORE_BASE ?? "https://sportscore.com").replace(/\/$/, "");
const OPENLIGADB_BASE = () => (process.env.OPENLIGADB_BASE ?? "https://api.openligadb.de").replace(/\/$/, "");
const APIF_BASE = () => (process.env.API_FOOTBALL_BASE ?? "https://v3.football.api-sports.io").replace(/\/$/, "");
const APIF_KEY = () => (process.env.API_FOOTBALL_KEY ?? process.env.FOOTBALL_API_KEY ?? "").trim();

const COMP_CACHE_TTL_MS = 60 * 60_000; // 1 hour per competition
const CATALOGUE_TTL_MS = 6 * 60 * 60_000;
const FEED_TTL_MS = 60 * 60_000;
const SWEEP_BUDGET_MS = Number(process.env.FIXTURES_SWEEP_BUDGET_MS ?? 90_000);
const STATS_BUDGET_MS = Number(process.env.FIXTURES_STATS_BUDGET_MS ?? 12_000);
const STATS_MAX_FETCHES = Number(process.env.FIXTURES_STATS_MAX_FETCHES ?? 24);

// openfootball via the GitHub Contents API — the fixture fallback for
// restricted-egress deployments (only `api.github.com` allowed). One small
// JSON file per league per season; the same repository and mapping already
// feed the historical model layer in src/lib/data/historical.ts.
const OPENFOOTBALL_REPO = () =>
  (process.env.HISTORICAL_OPENFOOTBALL_REPO ?? "openfootball/football.json").replace(/^\/+|\/+$/g, "");
const OPENFOOTBALL_TTL_MS = 30 * 60_000; // half-hour cache per season file
/**
 * Leagues the GitHub fallback always considers, most important first: the
 * Premier League drives /api/correct-score, then the rest of the big five.
 * Catalogue leagues with an openfootball code are appended after these.
 */
const OPENFOOTBALL_FIXTURE_PRIORITY: readonly string[] = [
  "eng.1", "esp.1", "ger.1", "ita.1", "fra.1",
];
/** Hard cap on GitHub requests per feed build — keeps the unauthenticated rate limit safe. */
const OPENFOOTBALL_MAX_FETCHES = Number(process.env.FIXTURES_OPENFOOTBALL_MAX_FETCHES ?? 6);

// ESPN's canonical soccer competition slugs. Keep these in the dynamic feed
// even when an incomplete upstream catalogue omits them. In particular, this
// prevents a long catalogue sweep from reaching its budget before UEFA's
// midweek fixtures are requested.
const REQUIRED_UEFA_COMPETITIONS: readonly CatalogueCompetition[] = [
  { slug: "uefa.champions", name: "UEFA Champions League" },
  { slug: "uefa.europa", name: "UEFA Europa League" },
  { slug: "uefa.europa.conf", name: "UEFA Conference League" },
];

// ─── Process-local caches (survive HMR / route re-imports) ───────────────────

interface CompCacheEntry {
  at: number;
  fixtures: FixtureLite[];
  source: FixtureSource;
}

const g = globalThis as typeof globalThis & {
  __gigiCompCache?: Map<string, CompCacheEntry>;
  __gigiCatalogueCache?: { at: number; competitions: CatalogueCompetition[] };
  __gigiFeedCache?: Map<string, { at: number; feed: CollectedFeed }>;
};

function compCache(): Map<string, CompCacheEntry> {
  return (g.__gigiCompCache ??= new Map());
}
function feedCache(): Map<string, { at: number; feed: CollectedFeed }> {
  return (g.__gigiFeedCache ??= new Map());
}

// ─── Date / name helpers ─────────────────────────────────────────────────────

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + n);
  return next;
}

function dateWindow(from: Date, to: Date): string {
  return `${fmt(from)}-${fmt(to)}`;
}

function eachIsoDay(from: Date, to: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor.getTime() <= end.getTime()) {
    days.push(isoDay(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function kebab(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function nameScore(target: string, candidate: string): number {
  if (!target || !candidate) return 0;
  if (candidate === target) return 10_000 + candidate.length;
  if (candidate.includes(target) || target.includes(candidate)) {
    return 1_000 + Math.min(candidate.length, target.length);
  }
  const ta = target.split(" ").filter((w) => w.length > 2);
  const cb = new Set(candidate.split(" ").filter((w) => w.length > 2));
  if (ta.length === 0) return 0;
  const overlap = ta.filter((t) => cb.has(t)).length;
  if (overlap >= 2 && overlap / ta.length >= 0.6) return 100 + overlap * 10;
  return 0;
}

/** Resolve a competition display name onto a catalogue / ESPN slug. */
function resolveSlugFromName(
  name: string,
  catalogue: CatalogueCompetition[] = [],
): string {
  const target = norm(name);
  if (!target) return "ext:unknown";

  let bestSlug = "";
  let bestScore = 0;
  const consider = (slug: string, label: string) => {
    const score = nameScore(target, norm(label));
    if (score > bestScore) {
      bestScore = score;
      bestSlug = slug;
    }
  };

  for (const c of catalogue) consider(c.slug, c.name);
  for (const def of Object.values(LEAGUE_MAP)) consider(def.slug, def.name);

  return bestSlug || `ext:${kebab(name)}`;
}

function leagueDefFor(slug: string, fallbackName?: string): LeagueDef {
  const canonical = canonicalLeagueSlug(slug);
  return (
    LEAGUE_MAP[canonical] ??
    LEAGUE_MAP[slug] ?? {
      slug: canonical,
      name: fallbackName ?? slug,
      region: "Worldwide",
      tier: 3,
    }
  );
}

// ─── Catalogue (dynamic — never a hardcoded walk list) ───────────────────────

function slugFromEspnRef(ref: string): string | null {
  try {
    const path = new URL(ref).pathname;
    const parts = path.split("/").filter(Boolean);
    const idx = parts.lastIndexOf("leagues");
    const raw = idx >= 0 ? parts[idx + 1] : parts[parts.length - 1];
    return raw?.split("?")[0] || null;
  } catch {
    return null;
  }
}

async function fetchEspnCoreCatalogue(): Promise<CatalogueCompetition[]> {
  const out = new Map<string, string>();
  const first = await resilientJson<{
    pageCount?: number;
    items?: Array<{ $ref?: string; slug?: string; name?: string; abbreviation?: string }>;
  }>(`${ESPN_CORE}?limit=1000&page=1`, { revalidate: 3600, cacheTtlMs: CATALOGUE_TTL_MS });

  const ingest = (
    items: Array<{ $ref?: string; slug?: string; name?: string; abbreviation?: string }> | undefined,
  ) => {
    for (const item of items ?? []) {
      const slug = item.slug?.trim() || (item.$ref ? slugFromEspnRef(item.$ref) : null);
      if (!slug) continue;
      out.set(slug, item.name?.trim() || item.abbreviation?.trim() || slug);
    }
  };

  ingest(first?.items);
  const pages = Math.min(first?.pageCount ?? 1, 12);
  if (pages > 1) {
    const rest = await Promise.all(
      Array.from({ length: pages - 1 }, (_, i) =>
        resilientJson<{
          items?: Array<{ $ref?: string; slug?: string; name?: string; abbreviation?: string }>;
        }>(`${ESPN_CORE}?limit=1000&page=${i + 2}`, {
          revalidate: 3600,
          cacheTtlMs: CATALOGUE_TTL_MS,
        }),
      ),
    );
    for (const page of rest) ingest(page?.items);
  }
  return [...out.entries()].map(([slug, name]) => ({ slug, name }));
}

async function fetchEspnSiteCatalogue(): Promise<CatalogueCompetition[]> {
  const data = await resilientJson<unknown>(ESPN_SITE, {
    revalidate: 3600,
    cacheTtlMs: CATALOGUE_TTL_MS,
  });
  const out = new Map<string, string>();
  const walk = (node: unknown, depth = 0) => {
    if (depth > 6 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const rec = asRecord(node);
    if (!rec) return;
    const slug = asString(rec.slug);
    const name = asString(rec.name) ?? asString(rec.displayName) ?? asString(rec.abbreviation);
    if (slug && name && slug.includes(".")) out.set(slug, name);
    for (const v of Object.values(rec)) {
      if (typeof v === "object" && v !== null) walk(v, depth + 1);
    }
  };
  walk(data);
  return [...out.entries()].map(([slug, name]) => ({ slug, name }));
}

async function fetchTheSportsDbCatalogue(): Promise<CatalogueCompetition[]> {
  const data = await resilientJson<{
    leagues?: Array<{ strLeague?: string; strSport?: string; strLeagueAlternate?: string }>;
  }>(`${TSDB_BASE()}/api/v1/json/${TSDB_KEY()}/all_leagues.php`, {
    revalidate: 3600,
    cacheTtlMs: CATALOGUE_TTL_MS,
  });
  const out: CatalogueCompetition[] = [];
  for (const lg of data?.leagues ?? []) {
    const sport = (lg.strSport ?? "").toLowerCase();
    if (sport && sport !== "soccer") continue;
    const name = lg.strLeague?.trim();
    if (!name) continue;
    out.push({ slug: resolveSlugFromName(name), name });
  }
  return out;
}

async function fetchOpenLigaDbCatalogue(): Promise<CatalogueCompetition[]> {
  const data = await resilientJson<Array<{ leagueShortcut?: string; leagueName?: string }>>(
    `${OPENLIGADB_BASE()}/getavailableleagues`,
    { revalidate: 3600, cacheTtlMs: CATALOGUE_TTL_MS },
  );
  const shortcutSlug: Record<string, { slug: string; name: string }> = {
    bl1: { slug: "ger.1", name: "Bundesliga" },
    bl2: { slug: "ger.2", name: "2. Bundesliga" },
    bl3: { slug: "ger.3", name: "3. Liga" },
  };
  const seen = new Set<string>();
  const out: CatalogueCompetition[] = [];
  for (const lg of data ?? []) {
    const shortcut = (lg.leagueShortcut ?? "").toLowerCase();
    const mapped = shortcutSlug[shortcut];
    if (!mapped || seen.has(mapped.slug)) continue;
    seen.add(mapped.slug);
    out.push({ slug: mapped.slug, name: lg.leagueName?.trim() || mapped.name });
  }
  return out;
}

async function espnReachable(): Promise<boolean> {
  const data = await resilientJson<unknown>(`${ESPN_SITE}/eng.1/scoreboard?limit=1`, {
    retries: 0,
    timeoutMs: 4000,
    totalTimeoutMs: 5000,
    cacheTtlMs: 60_000,
  });
  return data !== null;
}

/** Add required UEFA competitions without replacing names supplied by ESPN. */
function withRequiredUefaCompetitions(
  catalogue: CatalogueCompetition[],
): CatalogueCompetition[] {
  const merged = new Map<string, string>();
  for (const competition of catalogue) {
    const slug = canonicalLeagueSlug(competition.slug);
    if (slug && !merged.has(slug)) merged.set(slug, competition.name);
  }
  for (const competition of REQUIRED_UEFA_COMPETITIONS) {
    const slug = canonicalLeagueSlug(competition.slug);
    if (!merged.has(slug)) merged.set(slug, competition.name);
  }
  return [...merged.entries()].map(([slug, name]) => ({ slug, name }));
}

/**
 * Live competition catalogue from the primary data source (ESPN), with
 * TheSportsDB / OpenLigaDB as catalogue fallbacks. The normal catalogue stays
 * dynamic; the three canonical UEFA club competitions are retained if ESPN's
 * catalogue is temporarily incomplete.
 */
async function fetchCompetitionCatalogue(): Promise<CatalogueCompetition[]> {
  const cached = g.__gigiCatalogueCache;
  if (cached && Date.now() - cached.at < CATALOGUE_TTL_MS) {
    return withRequiredUefaCompetitions(cached.competitions);
  }

  const merged = new Map<string, string>();
  const add = (list: CatalogueCompetition[]) => {
    for (const c of list) {
      const slug = canonicalLeagueSlug(c.slug);
      if (!slug) continue;
      if (!merged.has(slug)) merged.set(slug, c.name);
    }
  };

  if (await espnReachable()) {
    add(await fetchEspnCoreCatalogue());
    if (merged.size === 0) add(await fetchEspnSiteCatalogue());
  }

  if (merged.size === 0) {
    add(await fetchTheSportsDbCatalogue());
    add(await fetchOpenLigaDbCatalogue());
  } else {
    add(await fetchOpenLigaDbCatalogue());
  }

  const competitions = withRequiredUefaCompetitions(
    [...merged.entries()].map(([slug, name]) => ({ slug, name })),
  );
  console.log(
    `[Fixtures] Catalogue: ${competitions.length} competitions from live data sources (UEFA required targets included)`,
  );
  if (competitions.length > 0) {
    g.__gigiCatalogueCache = { at: Date.now(), competitions };
  }
  return competitions;
}

// ─── Per-competition ESPN fetch (1-hour cache + alias retry) ─────────────────

async function fetchEspnCompetition(
  slug: string,
  window: string,
): Promise<FixtureLite[]> {
  const key = `espn:${canonicalLeagueSlug(slug)}|${window}`;
  const hit = compCache().get(key);
  if (hit && Date.now() - hit.at < COMP_CACHE_TTL_MS) return hit.fixtures;

  let fixtures: FixtureLite[] = [];
  for (const candidate of espnSlugCandidates(slug)) {
    fixtures = await fetchScoreboard(candidate, window).catch(() => [] as FixtureLite[]);
    if (fixtures.length > 0) {
      const canonical = canonicalLeagueSlug(slug);
      if (canonical !== candidate) {
        fixtures = fixtures.map((fx) => ({ ...fx, leagueSlug: canonical }));
      }
      break;
    }
  }

  compCache().set(key, { at: Date.now(), fixtures, source: "ESPN" });
  return fixtures;
}

/**
 * Fetch the three UEFA club competitions before the broader catalogue sweep.
 * They are deliberately not left behind a potentially large dynamic catalogue:
 * ESPN's global board is useful for discovery, but it is not a reliable
 * substitute for each competition's 14-day scoreboard window.
 */
async function fetchRequiredUefaFixtures(
  targets: CatalogueCompetition[],
  window: string,
): Promise<Array<{ competition: CatalogueCompetition; fixtures: FixtureLite[] }>> {
  const targetSlugs = new Set(targets.map((competition) => canonicalLeagueSlug(competition.slug)));
  const requested = REQUIRED_UEFA_COMPETITIONS.filter((competition) =>
    targetSlugs.has(competition.slug),
  );

  return Promise.all(
    requested.map(async (competition) => {
      const fixtures = await fetchEspnCompetition(competition.slug, window).catch(
        () => [] as FixtureLite[],
      );
      console.log(`[Fixtures] Fetched ${fixtures.length} matches for ${competition.name}.`);
      return { competition, fixtures };
    }),
  );
}

// ─── Fallback providers (bulk — discover every competition they cover) ───────

function buildLite(params: {
  id: string;
  leagueSlug: string;
  leagueName: string;
  date: string;
  state: FixtureLite["state"];
  statusDetail: string;
  homeName: string;
  awayName: string;
  homeScore: string | null;
  awayScore: string | null;
}): FixtureLite {
  return {
    id: params.id,
    leagueSlug: params.leagueSlug,
    leagueName: params.leagueName,
    date: params.date,
    state: params.state,
    statusDetail: params.statusDetail,
    venue: null,
    neutralSite: false,
    home: {
      id: "",
      name: params.homeName,
      shortName: params.homeName,
      abbrev: params.homeName.slice(0, 3),
      logo: null,
      color: null,
      score: params.homeScore,
      homeAway: "home",
    },
    away: {
      id: "",
      name: params.awayName,
      shortName: params.awayName,
      abbrev: params.awayName.slice(0, 3),
      logo: null,
      color: null,
      score: params.awayScore,
      homeAway: "away",
    },
    odds: null,
  };
}

async function fetchTheSportsDbFixtures(
  days: string[],
  catalogue: CatalogueCompetition[],
): Promise<SourcedFixture[]> {
  const out: SourcedFixture[] = [];
  for (const d of days) {
    const data = await resilientJson<{
      event?: Array<{
        idEvent?: string;
        strHomeTeam?: string;
        strAwayTeam?: string;
        dateEvent?: string;
        strTime?: string;
        strStatus?: string;
        strLeague?: string;
        intHomeScore?: string | null;
        intAwayScore?: string | null;
      }>;
    }>(`${TSDB_BASE()}/api/v1/json/${TSDB_KEY()}/eventsday.php?d=${d}&s=Soccer`, {
      revalidate: 300,
      cacheTtlMs: 5 * 60_000,
    });
    for (const ev of data?.event ?? []) {
      const homeName = ev.strHomeTeam?.trim();
      const awayName = ev.strAwayTeam?.trim();
      if (!homeName || !awayName || !ev.dateEvent) continue;
      const leagueName = ev.strLeague?.trim() || "Unknown Competition";
      const slug = resolveSlugFromName(leagueName, catalogue);
      const status = (ev.strStatus ?? "").toLowerCase();
      const state: FixtureLite["state"] = status.includes("not started")
        ? "pre"
        : status.includes("finished")
          ? "post"
          : "in";
      out.push({
        fixture: buildLite({
          id: `tsdb:${ev.idEvent ?? `${d}-${homeName}-${awayName}`}`,
          leagueSlug: slug,
          leagueName,
          date: `${ev.dateEvent}T${ev.strTime?.trim() || "00:00:00"}Z`,
          state,
          statusDetail: ev.strStatus ?? "",
          homeName,
          awayName,
          homeScore: state === "post" ? (ev.intHomeScore ?? "0") : null,
          awayScore: state === "post" ? (ev.intAwayScore ?? "0") : null,
        }),
        source: "TheSportsDB",
      });
    }
  }
  return out;
}

async function fetchOpenLigaDbFixtures(from: Date, to: Date): Promise<SourcedFixture[]> {
  const leagues = [
    { shortcut: "bl1", slug: "ger.1", name: "Bundesliga" },
    { shortcut: "bl2", slug: "ger.2", name: "2. Bundesliga" },
    { shortcut: "bl3", slug: "ger.3", name: "3. Liga" },
  ];
  const season = String(from.getUTCFullYear());
  const out: SourcedFixture[] = [];
  const fromMs = from.getTime() - 12 * 3600_000;
  const toMs = to.getTime() + 36 * 3600_000;

  for (const lg of leagues) {
    const data = await resilientJson<Array<{
      matchID?: number;
      matchDateTime?: string;
      team1?: { teamName?: string };
      team2?: { teamName?: string };
      matchResults?: Array<{ resultTypeID?: number; pointsTeam1?: number; pointsTeam2?: number }>;
      matchIsFinished?: boolean;
    }>>(`${OPENLIGADB_BASE()}/getmatchdata/${lg.shortcut}/${season}`, {
      revalidate: 600,
      cacheTtlMs: 10 * 60_000,
    });
    for (const m of data ?? []) {
      const homeName = m.team1?.teamName?.trim();
      const awayName = m.team2?.teamName?.trim();
      if (!homeName || !awayName || !m.matchDateTime) continue;
      const when = new Date(m.matchDateTime).getTime();
      if (!Number.isFinite(when) || when < fromMs || when > toMs) continue;
      const finalResult = (m.matchResults ?? []).find((r) => r.resultTypeID === 2);
      const finished = m.matchIsFinished === true || finalResult != null;
      out.push({
        fixture: buildLite({
          id: `oligadb:${m.matchID ?? `${when}-${homeName}`}`,
          leagueSlug: lg.slug,
          leagueName: lg.name,
          date: m.matchDateTime,
          state: finished ? "post" : "pre",
          statusDetail: finished ? "Match Finished" : "Not Started",
          homeName,
          awayName,
          homeScore: finished ? String(finalResult?.pointsTeam1 ?? 0) : null,
          awayScore: finished ? String(finalResult?.pointsTeam2 ?? 0) : null,
        }),
        source: "OpenLigaDB",
      });
    }
  }
  return out;
}

async function fetchSportScoreFixtures(catalogue: CatalogueCompetition[]): Promise<SourcedFixture[]> {
  const root = await resilientJson<unknown>(
    `${SPORTSCORE_BASE()}/api/widget/matches/?sport=football&limit=200`,
    { revalidate: 300, cacheTtlMs: 5 * 60_000 },
  );
  const out: SourcedFixture[] = [];
  const visited = new Set<unknown>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const rec = asRecord(item);
        if (!rec) continue;
        const home = asString(rec.home ?? rec.home_name ?? rec.homeName ?? rec.team_home);
        const away = asString(rec.away ?? rec.away_name ?? rec.awayName ?? rec.team_away);
        if (home && away) {
          const time = asString(rec.time ?? rec.date ?? rec.kickoff ?? rec.match_time);
          const status = (asString(rec.status) ?? "").toLowerCase();
          const hs = rec.home_score ?? rec.homeScore;
          const as = rec.away_score ?? rec.awayScore;
          const finished = status.includes("finish") || (hs !== null && hs !== undefined && hs !== "");
          const competition =
            asString(rec.competition ?? rec.league ?? rec.tournament) ?? "Unknown Competition";
          out.push({
            fixture: buildLite({
              id: `sportscore:${asString(rec.slug) ?? `${home}-${away}-${time ?? ""}`}`,
              leagueSlug: resolveSlugFromName(competition, catalogue),
              leagueName: competition,
              date: time && /^\d{4}-\d{2}-\d{2}T/.test(time) ? time : new Date().toISOString(),
              state: finished
                ? "post"
                : status.includes("live") || status.includes("in progress")
                  ? "in"
                  : "pre",
              statusDetail: asString(rec.status) ?? "",
              homeName: home,
              awayName: away,
              homeScore: finished ? String(hs ?? 0) : null,
              awayScore: finished ? String(as ?? 0) : null,
            }),
            source: "SportScore",
          });
        }
        if (!visited.has(rec)) {
          visited.add(rec);
          for (const v of Object.values(rec)) if (typeof v === "object" && v !== null) walk(v);
        }
      }
      return;
    }
    const rec = asRecord(node);
    if (rec && !visited.has(rec)) {
      visited.add(rec);
      for (const v of Object.values(rec)) if (typeof v === "object" && v !== null) walk(v);
    }
  };
  walk(root);
  return out;
}

async function fetchApiFootballFixtures(
  days: string[],
  catalogue: CatalogueCompetition[],
): Promise<SourcedFixture[]> {
  const key = APIF_KEY();
  if (!key) return [];
  const out: SourcedFixture[] = [];
  for (const d of days) {
    const data = await resilientJson<{
      response?: Array<{
        fixture: { id: number; date: string; status?: { short?: string; long?: string } };
        teams: { home: { name: string } | null; away: { name: string } | null };
        league: { id: number; name: string };
        goals?: { home: number | null; away: number | null };
      }>;
    }>(`${APIF_BASE()}/fixtures?date=${d}`, {
      headers: { "x-apisports-key": key },
      revalidate: 300,
      cacheTtlMs: 5 * 60_000,
    });
    for (const f of data?.response ?? []) {
      const homeName = f.teams?.home?.name?.trim();
      const awayName = f.teams?.away?.name?.trim();
      if (!homeName || !awayName) continue;
      const leagueName = f.league?.name?.trim() || "Unknown Competition";
      const slug = resolveSlugFromName(leagueName, catalogue);
      const short = f.fixture?.status?.short ?? "";
      const state: FixtureLite["state"] =
        short === "FT" || short === "AET" || short === "PEN"
          ? "post"
          : short === "NS" || short === "TBD" || short === ""
            ? "pre"
            : "in";
      out.push({
        fixture: buildLite({
          id: `apif:${f.fixture?.id}`,
          leagueSlug: slug,
          leagueName,
          date: f.fixture?.date ?? `${d}T00:00:00Z`,
          state,
          statusDetail: f.fixture?.status?.long ?? short,
          homeName,
          awayName,
          homeScore: state === "post" ? String(f.goals?.home ?? 0) : null,
          awayScore: state === "post" ? String(f.goals?.away ?? 0) : null,
        }),
        source: "ApiFootball",
      });
    }
  }
  return out;
}

// ─── openfootball via api.github.com (restricted-egress fixture fallback) ────

export interface OpenfootballRow {
  round?: string;
  date?: string;
  time?: string;
  team1?: string;
  team2?: string;
  /** `{ ht, ft }` object or openfootball's bare `[home, away]` shorthand. */
  score?: { ht?: number[]; ft?: number[] } | number[] | null;
  status?: string;
}

/**
 * Map one openfootball/football.json row onto the app's fixture shape.
 *
 * Rows without a `score` are scheduled fixtures (`pre`); rows with one are
 * results (`post`) — both encodings openfootball uses for results are handled
 * by the historical layer's `fullTimeScore`. Team names are kept verbatim
 * ("Liverpool FC"): every downstream lookup (standings, ELO, attack/defence)
 * matches loosely on normalised names, so provider suffixes resolve fine.
 */
export function openfootballFixture(
  row: OpenfootballRow,
  context: { leagueSlug: string; leagueName: string; season: string; code: string },
): FixtureLite | null {
  const home = row.team1?.trim();
  const away = row.team2?.trim();
  const date = row.date?.trim();
  if (!home || !away || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  // openfootball times are local kickoffs and the files carry no timezone
  // metadata, so the value is interpreted as UTC: up to an hour or two off
  // for some leagues, but the correct calendar day — which is what the feed
  // window and cross-source dedupe work on. Missing times default to 15:00
  // rather than midnight so same-day fixtures are not treated as already
  // kicked off and dropped from the upcoming feed.
  const rawTime = row.time?.trim() ?? "";
  const time = /^\d{1,2}:\d{2}/.test(rawTime) ? rawTime : "15:00";
  const [hours, minutes] = time.split(":");
  const iso = `${date}T${hours.padStart(2, "0")}:${minutes}:00Z`;

  const ft = fullTimeScore(row.score);
  const statusText = row.status?.trim();

  return buildLite({
    id: `openfootball:${context.season}:${context.code}:${date}:${kebab(home)}-${kebab(away)}`,
    leagueSlug: context.leagueSlug,
    leagueName: context.leagueName,
    date: iso,
    state: ft ? "post" : "pre",
    statusDetail: ft
      ? statusText || "Full Time"
      : statusText || row.round?.trim() || "Scheduled",
    homeName: home,
    awayName: away,
    homeScore: ft ? String(ft[0]) : null,
    awayScore: ft ? String(ft[1]) : null,
  });
}

/** Loose cross-provider team-name equality: "Liverpool FC" ≈ "Liverpool". */
export function fuzzyTeamNameEq(left: string, right: string): boolean {
  const a = norm(left);
  const b = norm(right);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) > 3 && (a.includes(b) || b.includes(a)));
}

/**
 * True when the same league-day pairing already exists under another
 * provider's spelling, so the GitHub fallback never duplicates a fixture
 * ESPN (or SportScore) already delivered.
 */
export function hasLooseFixtureDuplicate(
  existing: FixtureLite[],
  candidate: FixtureLite,
): boolean {
  const day = candidate.date.slice(0, 10);
  return existing.some(
    (fixture) =>
      fixture.date.slice(0, 10) === day &&
      fuzzyTeamNameEq(fixture.home.name, candidate.home.name) &&
      fuzzyTeamNameEq(fixture.away.name, candidate.away.name),
  );
}

/**
 * One league's fixtures from openfootball/football.json, fetched through the
 * GitHub Contents API — the data host that stays reachable on deployments
 * whose egress allowlist blocks ESPN/SportScore/TheSportsDB entirely
 * (docs/NETWORK_ALLOWLIST.md). Without this source such deployments have an
 * empty fixture feed and /api/correct-score can never show Premier League
 * matches, no matter how its filter is written.
 */
export async function fetchOpenfootballFixtures(
  leagueSlug: string,
  season: string,
  from: Date,
  to: Date,
): Promise<SourcedFixture[]> {
  const slug = canonicalLeagueSlug(leagueSlug);
  const code = OPENFOOTBALL_CODES[slug];
  if (!code) return [];

  const url = `https://api.github.com/repos/${OPENFOOTBALL_REPO()}/contents/${season}/${code}.json`;
  const payload = await resilientJson<
    { name?: string; matches?: OpenfootballRow[] } | OpenfootballRow[]
  >(url, {
    headers: { Accept: "application/vnd.github.raw+json" },
    revalidate: 1800,
    cacheTtlMs: OPENFOOTBALL_TTL_MS,
  });
  if (!payload) return [];

  const rows = Array.isArray(payload) ? payload : (payload.matches ?? []);
  // File headers read e.g. "English Premier League 2026/27" — strip the season.
  const headerName = !Array.isArray(payload) ? payload.name : undefined;
  const leagueName =
    headerName?.replace(/\s*\d{4}\/\d{2,4}\s*$/, "").trim() || leagueDefFor(slug).name;

  const fromMs = from.getTime() - 12 * 3600_000;
  const toMs = to.getTime() + 36 * 3600_000;
  const out: SourcedFixture[] = [];
  for (const row of rows) {
    const fixture = openfootballFixture(row, { leagueSlug: slug, leagueName, season, code });
    if (!fixture) continue;
    const when = new Date(fixture.date).getTime();
    if (!Number.isFinite(when) || when < fromMs || when > toMs) continue;
    out.push({ fixture, source: "Openfootball" });
  }
  console.log(
    `[Fixtures] Openfootball ${season}/${code}.json (${leagueName}): ${out.length} fixture(s) in window`,
  );
  return out;
}

// ─── Discover extra slugs from ESPN's global scoreboard ──────────────────────

async function discoverSlugsFromGlobalBoard(
  days: string[],
  catalogue: CatalogueCompetition[],
): Promise<CatalogueCompetition[]> {
  const found = new Map<string, string>();
  for (const d of days) {
    const data = await resilientJson<{
      events?: Array<{
        season?: { slug?: string };
        competitions?: Array<{
          altGameNote?: string;
          notes?: Array<{ headline?: string }>;
          league?: { slug?: string; name?: string };
        }>;
        league?: { slug?: string; name?: string };
      }>;
    }>(`${ESPN_SITE}/all/scoreboard?dates=${d.replace(/-/g, "")}&limit=1000`, {
      revalidate: 120,
      cacheTtlMs: 2 * 60_000,
    });
    for (const ev of data?.events ?? []) {
      const comp = ev.competitions?.[0];
      const name =
        ev.league?.name?.trim() ||
        comp?.league?.name?.trim() ||
        comp?.altGameNote?.trim() ||
        comp?.notes?.[0]?.headline?.trim() ||
        "";
      const slug =
        ev.league?.slug?.trim() ||
        comp?.league?.slug?.trim() ||
        (name ? resolveSlugFromName(name, catalogue) : "");
      if (slug && slug !== "all" && slug !== "soccer") {
        found.set(canonicalLeagueSlug(slug), name || slug);
      }
    }
  }
  return [...found.entries()].map(([slug, name]) => ({ slug, name }));
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function fixtureDedupeKey(f: FixtureLite): string {
  const day = f.date.slice(0, 10);
  return [canonicalLeagueSlug(f.leagueSlug), day, norm(f.home.name), norm(f.away.name)]
    .sort()
    .join("|");
}

async function collectAllCompetitionFixtures(opts?: {
  days?: number;
  now?: Date;
  leagueSlugs?: string[];
  attachStats?: boolean;
}): Promise<CollectedFeed> {
  const days = Math.min(Math.max(opts?.days ?? 14, 1), 60);
  const now = opts?.now ?? new Date();
  const attach = opts?.attachStats !== false;
  const allow = opts?.leagueSlugs?.length
    ? new Set(opts.leagueSlugs.map(canonicalLeagueSlug))
    : null;

  const cacheKey = `all:${days}:${allow ? [...allow].sort().join(",") : "*"}`;
  const cached = feedCache().get(cacheKey);
  if (cached && Date.now() - cached.at < FEED_TTL_MS) {
    return attach
      ? { ...cached.feed, fixtures: await attachStatsToFixtures(cached.feed.fixtures) }
      : cached.feed;
  }

  const from = addDays(now, -1);
  const to = addDays(now, days);
  const window = dateWindow(from, to);
  const isoDays = eachIsoDay(from, to);
  const deadline = Date.now() + SWEEP_BUDGET_MS;

  const catalogue = await fetchCompetitionCatalogue();
  const discovered = await discoverSlugsFromGlobalBoard(isoDays, catalogue).catch(
    () => [] as CatalogueCompetition[],
  );

  const catalogueBySlug = new Map<string, string>();
  for (const c of [...catalogue, ...discovered]) {
    const slug = canonicalLeagueSlug(c.slug);
    if (!catalogueBySlug.has(slug)) catalogueBySlug.set(slug, c.name);
  }

  const targets = [...catalogueBySlug.entries()]
    .map(([slug, name]) => ({ slug, name }))
    .filter((c) => !allow || allow.has(c.slug));

  const groups = new Map<string, CollectedCompetition>();
  const seen = new Set<string>();

  const add = (fx: FixtureLite, source: FixtureSource, competitionName: string) => {
    const stamped: FixtureLite = {
      ...fx,
      leagueSlug: canonicalLeagueSlug(fx.leagueSlug),
    };
    if (allow && !allow.has(stamped.leagueSlug)) return;
    const k = fixtureDedupeKey(stamped);
    if (seen.has(k)) return;
    seen.add(k);
    const slug = stamped.leagueSlug;
    let group = groups.get(slug);
    if (!group) {
      group = {
        leagueSlug: slug,
        competitionName: competitionName || leagueDefFor(slug, stamped.leagueName).name,
        fixtures: [],
      };
      groups.set(slug, group);
    }
    group.fixtures.push({ fixture: stamped, source });
  };

  const espnUp = await espnReachable();

  // Fetch required UEFA competition boards regardless of the generic ESPN
  // health probe. A temporary failure of that probe must not suppress the
  // dedicated qualifying-round fallback for Champions/Europa/Conference.
  const uefaWindow = dateWindow(now, addDays(now, days));
  const uefaPages = await fetchRequiredUefaFixtures(targets, uefaWindow);
  for (const { competition, fixtures } of uefaPages) {
    for (const fixture of fixtures) add(fixture, "ESPN", competition.name);
  }

  if (espnUp) {
    // Fast path: ESPN's global soccer board already lists every competition
    // it is covering on a given day. Remap the `all` slug onto the catalogue
    // so Conference / cups / Libertadores land on their real identities.
    for (const day of isoDays) {
      if (Date.now() >= deadline) break;
      const board = await fetchAllScoreboard(day.replace(/-/g, "")).catch(() => null);
      for (const fx of board ?? []) {
        const slug = resolveSlugFromName(fx.leagueName, targets);
        add({ ...fx, leagueSlug: slug, leagueName: fx.leagueName }, "ESPN", fx.leagueName);
      }
    }

    // Fill catalogue competitions the global board missed (1h cache).
    const missing = targets.filter((c) => !groups.has(c.slug));
    const wave = 16;
    for (let i = 0; i < missing.length && Date.now() < deadline; i += wave) {
      const slice = missing.slice(i, i + wave);
      const pages = await Promise.all(
        slice.map(async (c) => {
          const fixtures = await fetchEspnCompetition(c.slug, window);
          if (fixtures.length === 0) {
            console.log(`[Fixtures] No fixtures found for ${c.slug}`);
          }
          return { ...c, fixtures };
        }),
      );
      for (const { name, fixtures } of pages) {
        for (const fx of fixtures) add(fx, "ESPN", name);
      }
    }
    if (Date.now() >= deadline) {
      console.log(
        `[Fixtures] Sweep budget reached after ESPN catalogue walk — continuing with fallback sources`,
      );
    }
  } else {
    console.log(
      `[Fixtures] ESPN unreachable — direct UEFA attempts completed; skipping global and broad catalogue sweep`,
    );
  }

  // Fallbacks: SportScore → API-Football → TheSportsDB → OpenLigaDB.
  const [tsdb, oligadb, sportscore, apif] = await Promise.all([
    fetchTheSportsDbFixtures(isoDays, targets).catch(() => [] as SourcedFixture[]),
    fetchOpenLigaDbFixtures(from, to).catch(() => [] as SourcedFixture[]),
    fetchSportScoreFixtures(targets).catch(() => [] as SourcedFixture[]),
    fetchApiFootballFixtures(isoDays, targets).catch(() => [] as SourcedFixture[]),
  ]);

  for (const { fixture, source } of [...sportscore, ...apif, ...tsdb, ...oligadb]) {
    add(fixture, source, fixture.leagueName);
  }

  // → Openfootball (api.github.com): fills mapped leagues every source above
  // left without a single fixture — the only path that works when the egress
  // allowlist blocks ESPN/SportScore/TheSportsDB (docs/NETWORK_ALLOWLIST.md),
  // which is otherwise an empty feed and a permanently bare /correct-score
  // page. Costs nothing when the primary sources are healthy: leagues that
  // already carry fixtures are never re-fetched.
  const ghSlugs: string[] = [];
  const ghCandidates = [
    ...OPENFOOTBALL_FIXTURE_PRIORITY,
    ...targets
      .map((competition) => competition.slug)
      .filter((slug) => OPENFOOTBALL_CODES[canonicalLeagueSlug(slug)]),
  ];
  for (const slug of new Set(ghCandidates.map(canonicalLeagueSlug))) {
    if (ghSlugs.length >= OPENFOOTBALL_MAX_FETCHES) break;
    if (allow && !allow.has(slug)) continue;
    if (groups.has(slug)) continue;
    ghSlugs.push(slug);
  }
  if (ghSlugs.length > 0) {
    const season = seasonCodes(now, 1)[0];
    const ghPages = await Promise.all(
      ghSlugs.map((slug) =>
        fetchOpenfootballFixtures(slug, season, from, to).catch(() => [] as SourcedFixture[]),
      ),
    );
    let ghAdded = 0;
    ghPages.forEach((page, index) => {
      const slug = ghSlugs[index];
      const existing = (groups.get(slug)?.fixtures ?? []).map((entry) => entry.fixture);
      for (const { fixture } of page) {
        // Cross-provider dedupe: "Liverpool FC" (openfootball) is the same
        // fixture as "Liverpool" (ESPN) on the same league day.
        if (hasLooseFixtureDuplicate(existing, fixture)) continue;
        existing.push(fixture);
        add(fixture, "Openfootball", fixture.leagueName);
        ghAdded++;
      }
    });
    console.log(
      `[Fixtures] Openfootball fallback (api.github.com): ${ghAdded} fixture(s) across ${ghSlugs.join(", ")}`,
    );
  }

  for (const c of targets) {
    if (!groups.has(c.slug)) {
      console.log(`[Fixtures] No fixtures found for ${c.slug}`);
    }
  }

  const competitions = [...groups.values()]
    .filter((group) => group.fixtures.length > 0)
    .sort((a, b) => {
      const ta = leagueDefFor(a.leagueSlug).tier;
      const tb = leagueDefFor(b.leagueSlug).tier;
      if (ta !== tb) return ta - tb;
      return a.competitionName.localeCompare(b.competitionName);
    });

  const flat = competitions.flatMap((c) => c.fixtures.map((x) => x.fixture));
  const withStats = attach ? await attachStatsToFixtures(flat) : flat.map((fx) => ({ ...fx, stats: null }));

  const feed: CollectedFeed = {
    fixtures: withStats,
    competitions,
    catalogue: targets,
    days,
  };
  if (flat.length > 0 || espnUp) {
    feedCache().set(cacheKey, { at: Date.now(), feed });
  }
  console.log(
    `[Fixtures] Assembled ${flat.length} fixtures across ${competitions.length} competitions (catalogue ${targets.length}, window ${window})`,
  );
  return feed;
}

// ─── Stats extraction ────────────────────────────────────────────────────────

function formatForm(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const letters = raw.toUpperCase().replace(/[^WDL]/g, "").split("");
  return letters.length ? letters.join(" ") : raw.trim() || null;
}

function emptyTeam(form: string | null): PreMatchTeamStats {
  return {
    avgCornersPerGame: null,
    avgCornersConcededPerGame: null,
    avgCornersLast5: null,
    avgCornersConcededLast5: null,
    xg: null,
    xgPerShot: null,
    shots: null,
    shotsOnTarget: null,
    possession: null,
    passes: null,
    passAccuracy: null,
    form,
    goalsScoredLast5: null,
    goalsConcededLast5: null,
    h2hCorners: null,
    h2hGoals: null,
    leagueAvgCorners: null,
    leagueAvgGoals: null,
    homeAdvantage: null,
    matchImportance: null,
    injuryImpact: null,
  };
}

function deriveImportance(fx: FixtureLite): string | null {
  const text = `${fx.leagueName} ${fx.statusDetail ?? ""}`.toLowerCase();
  if (/relegat/.test(text)) return "relegation";
  if (/title|championship decider|top of the table/.test(text)) return "title race";
  if (/derby|classico|cl[aá]sico|rivalry/.test(text)) return "derby";
  if (/final|semi.?final|quarter.?final|knockout|play.?off/.test(text)) return "knockout";
  return null;
}

function teamFromCanonical(
  team: TeamStats | undefined,
  form: string | null,
  extras: Partial<PreMatchTeamStats>,
): PreMatchTeamStats {
  return {
    ...emptyTeam(form),
    avgCornersPerGame: team?.avgCornersPerGame ?? null,
    xg: team?.xg ?? null,
    xgPerShot: team?.xgPerShot ?? null,
    shots: team?.shots ?? null,
    shotsOnTarget: team?.shotsOnTarget ?? null,
    possession: team?.possession ?? null,
    passes: team?.passes ?? null,
    passAccuracy: team?.passAccuracy ?? null,
    ...extras,
  };
}

function statsHasField(s: PreMatchTeamStats): boolean {
  return Object.values(s).some((v) => v !== null && v !== undefined);
}

function extractFixtureStats(
  fx: FixtureLite,
  canonical: CanonicalMatchStats | null,
): FixtureStats | null {
  const importance = deriveImportance(fx);
  const homeForm = formatForm(fx.home.form);
  const awayForm = formatForm(fx.away.form);
  const homeCorners = canonical?.home.avgCornersPerGame ?? null;
  const awayCorners = canonical?.away.avgCornersPerGame ?? null;
  const homeAdvantage =
    homeCorners != null && awayCorners != null && awayCorners > 0
      ? Math.round((homeCorners / awayCorners) * 100) / 100
      : null;

  const extras: Partial<PreMatchTeamStats> = {
    homeAdvantage,
    matchImportance: importance,
  };

  const home = teamFromCanonical(canonical?.home, homeForm, extras);
  const away = teamFromCanonical(canonical?.away, awayForm, extras);
  if (!statsHasField(home) && !statsHasField(away) && !canonical) return null;

  return {
    source: canonical?.metadata.source || null,
    home,
    away,
    canonical,
  };
}

function logStatsLine(fx: FixtureLite, stats: FixtureStats | null): void {
  const label = `${fx.home.name} vs ${fx.away.name}`;
  if (!stats || !stats.source) {
    console.log(`[Fixtures] ${label}: no stats available`);
    return;
  }
  const n = (v: number | null) => (v == null ? "n/a" : String(v));
  const p = (v: number | null) => (v == null ? "n/a" : `${v}%`);
  console.log(
    `[Fixtures] ${label}: stats from ${stats.source} ` +
      `(avgCorners: home ${n(stats.home.avgCornersPerGame)}, away ${n(stats.away.avgCornersPerGame)}` +
      ` | xg: home ${n(stats.home.xg)}, away ${n(stats.away.xg)}` +
      ` | possession: home ${p(stats.home.possession)}, away ${p(stats.away.possession)})`,
  );
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function attachStatsToFixtures(
  fixtures: FixtureLite[],
  opts?: { budgetMs?: number; maxFetches?: number },
): Promise<FixtureWithStats[]> {
  const deadline = Date.now() + (opts?.budgetMs ?? STATS_BUDGET_MS);
  const maxFetches = opts?.maxFetches ?? STATS_MAX_FETCHES;
  let fetches = 0;

  return mapPool(fixtures, 4, async (fx) => {
    const query = {
      leagueSlug: fx.leagueSlug,
      eventId: fx.id,
      homeTeam: fx.home.name,
      awayTeam: fx.away.name,
      date: fx.date,
    };
    const peeked = statsAggregator.peek(query);
    let canonical = peeked;
    if (!canonical && fetches < maxFetches && Date.now() < deadline) {
      fetches++;
      canonical = await statsAggregator.fetch(query).catch(() => null);
    }
    const stats = extractFixtureStats(fx, canonical);
    logStatsLine(fx, stats);
    return { ...fx, stats };
  });
}

// ─── Stats diagnostics ───────────────────────────────────────────────────────

/**
 * Why does every fixture carry `stats: null`?
 *
 * A null `stats` object has two very different causes — no fixtures reached the
 * aggregator at all, or they did and every source failed. The response payload
 * cannot tell them apart, and the server log scrolls past. This block is
 * attached to both feed shapes so `curl /api/fixtures?days=7 | jq .statsDiagnostics`
 * answers the question without reading logs.
 *
 * No network: it reports the aggregator's source priority, each source's
 * readiness in the current process env, and active rate-limit cooldowns.
 */
function buildStatsDiagnostics(
  fixtures: FixtureWithStats[],
  opts?: { attached?: boolean },
): {
  fixtureCount: number;
  fixturesWithStats: number;
  statsAttached: boolean;
  statsBudgetMs: number;
  statsMaxFetches: number;
  sourcePriority: string[];
  sourceReadiness: ReturnType<StatsAggregator["sourceReadiness"]>;
  cooldowns: Record<string, number>;
  verdict: string;
  hint: string;
} {
  const attached = opts?.attached !== false;
  const withStats = fixtures.filter((fx) => fx.stats?.source).length;
  const probe = fixtures[0]
    ? {
        leagueSlug: fixtures[0].leagueSlug,
        eventId: fixtures[0].id,
        homeTeam: fixtures[0].home.name,
        awayTeam: fixtures[0].away.name,
        date: fixtures[0].date,
      }
    : undefined;

  const readiness = statsAggregator.sourceReadiness(probe);
  const gatedOnKey = readiness.filter((s) => s.keyPresent === false).map((s) => s.source);
  const attemptable = readiness.filter((s) => s.registered && s.keyPresent !== false);

  const verdict =
    !attached
      ? "stats not requested — this response was built with ?stats=0, so the aggregator was skipped by design"
      : fixtures.length === 0
        ? "no fixtures in feed — the fixture feed itself returned nothing, so the aggregator was never called"
        : withStats === 0
          ? `all ${fixtures.length} fixture(s) returned null stats — every source failed (see sourceReadiness + server log)`
          : `${withStats}/${fixtures.length} fixture(s) carry real stats`;

  const hint =
    !attached
      ? "Re-request without ?stats=0 to have the aggregator attach stats to every fixture."
      : fixtures.length === 0
        ? "The fixture feed is sourced from site.api.espn.com (src/lib/espn.ts). " +
          "If that host is firewalled the feed is empty and no stats source is ever tried. " +
          "Verify with GET /api/diagnostics/connectivity."
        : withStats === 0
          ? gatedOnKey.length > 0
            ? `Keyed sources skipped for a missing env var: ${gatedOnKey.join(", ")}. ` +
              `Only ${attemptable.length} source(s) are actually attemptable. ` +
              `Set the keys in .env.local, or check egress with GET /api/diagnostics/connectivity.`
            : "No source is gated off by env, so the failures are network/upstream. " +
              "Check GET /api/diagnostics/connectivity and the per-source [stats] log lines."
          : "Stats are flowing.";

  return {
    fixtureCount: fixtures.length,
    fixturesWithStats: withStats,
    statsAttached: attached,
    statsBudgetMs: STATS_BUDGET_MS,
    statsMaxFetches: STATS_MAX_FETCHES,
    sourcePriority: statsAggregator.prioritySnapshot(),
    sourceReadiness: readiness,
    cooldowns: statsAggregator.cooldownSnapshot(),
    verdict,
    hint,
  };
}

// ─── Shared sort / split ─────────────────────────────────────────────────────

function partitionAndSort(all: FixtureWithStats[]) {
  const byPriorityThenDateAsc = (a: FixtureLite, b: FixtureLite) =>
    compareLeaguePriority(a, b) || new Date(a.date).getTime() - new Date(b.date).getTime();
  const byPriorityThenDateDesc = (a: FixtureLite, b: FixtureLite) =>
    compareLeaguePriority(a, b) || new Date(b.date).getTime() - new Date(a.date).getTime();

  const live = all.filter((f) => f.state === "in").sort(byPriorityThenDateAsc);
  const upcoming = all.filter((f) => f.state === "pre").sort(byPriorityThenDateAsc);
  const finished = all
    .filter((f) => f.state === "post")
    .sort(byPriorityThenDateDesc)
    .slice(0, all.length > 80 ? 80 : all.length);

  const allUpcoming = [...live, ...upcoming].sort(byPriorityThenDateAsc);
  return {
    fixtures: [...allUpcoming, ...finished],
    upcoming: allUpcoming,
    results: finished,
    upcomingCount: allUpcoming.length,
    resultsCount: finished.length,
  };
}

function jsonResponse(body: unknown, sMaxAge = 60) {
  return Response.json(body, {
    headers: {
      "Cache-Control": `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=300`,
    },
  });
}

// ─── Route ───────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const leagueParam = searchParams.get("league");
  const dates = searchParams.get("dates") ?? undefined;
  const daysRaw = Number(searchParams.get("days"));
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(Math.round(daysRaw), 60) : 14;
  const attachStats = searchParams.get("stats") !== "0";

  if (!leagueParam || leagueParam === "all") {
    const feed = await collectAllCompetitionFixtures({ days, attachStats });
    const split = partitionAndSort(feed.fixtures);
    return jsonResponse(
      {
        league: { slug: "all", name: "All Competitions", region: "Worldwide", tier: 1 },
        days: feed.days,
        catalogueCount: feed.catalogue.length,
        competitionCount: feed.competitions.length,
        ...split,
        statsDiagnostics: buildStatsDiagnostics(split.fixtures, { attached: attachStats }),
      },
      300,
    );
  }

  const league = canonicalLeagueSlug(leagueParam);
  const now = new Date();
  const from7 = new Date(now);
  from7.setDate(now.getDate() - 7);
  const to60 = new Date(now);
  to60.setDate(now.getDate() + 60);

  const windows = [`${fmt(from7)}-${fmt(to60)}`];
  if (dates) windows.push(dates);

  const pages = await Promise.all(
    windows.map((w) => fetchEspnCompetition(league, w).catch(() => [] as FixtureLite[])),
  );

  const seen = new Set<string>();
  const all: FixtureLite[] = [];
  for (const fx of pages.flat()) {
    if (!seen.has(fx.id)) {
      seen.add(fx.id);
      all.push(fx);
    }
  }

  if (all.length === 0) {
    console.log(`[Fixtures] No fixtures found for ${league}`);
    const from = addDays(now, -1);
    const to = addDays(now, days);
    const catalogue = [{ slug: league, name: leagueDefFor(league).name }];
    const [tsdb, oligadb, sportscore, apif] = await Promise.all([
      fetchTheSportsDbFixtures(eachIsoDay(from, to), catalogue).catch(() => [] as SourcedFixture[]),
      fetchOpenLigaDbFixtures(from, to).catch(() => [] as SourcedFixture[]),
      fetchSportScoreFixtures(catalogue).catch(() => [] as SourcedFixture[]),
      fetchApiFootballFixtures(eachIsoDay(from, to), catalogue).catch(() => [] as SourcedFixture[]),
    ]);
    const want = new Set(espnSlugCandidates(league));
    const name = norm(leagueDefFor(league).name);
    for (const { fixture } of [...sportscore, ...apif, ...tsdb, ...oligadb]) {
      const slugHit = want.has(canonicalLeagueSlug(fixture.leagueSlug));
      const nameHit = name && norm(fixture.leagueName).includes(name);
      if (!slugHit && !nameHit) continue;
      if (seen.has(fixture.id)) continue;
      seen.add(fixture.id);
      all.push({ ...fixture, leagueSlug: league });
    }
    // Last resort: openfootball/football.json through api.github.com — the
    // data host that survives egress allowlists which block every provider
    // above (docs/NETWORK_ALLOWLIST.md).
    if (all.length === 0 && OPENFOOTBALL_CODES[league]) {
      const season = seasonCodes(now, 1)[0];
      const ghFixtures = await fetchOpenfootballFixtures(league, season, from, to).catch(
        () => [] as SourcedFixture[],
      );
      for (const { fixture } of ghFixtures) {
        if (seen.has(fixture.id) || hasLooseFixtureDuplicate(all, fixture)) continue;
        seen.add(fixture.id);
        all.push({ ...fixture, leagueSlug: league });
      }
    }
    if (all.length === 0) {
      console.log(`[Fixtures] No fixtures found for ${league} after fallbacks`);
    }
  }

  const withStats = await attachStatsToFixtures(all, { budgetMs: 20_000, maxFetches: 40 });
  const split = partitionAndSort(withStats);

  return jsonResponse({
    league: leagueDefFor(league),
    ...split,
    statsDiagnostics: buildStatsDiagnostics(withStats, { attached: true }),
  });
}
