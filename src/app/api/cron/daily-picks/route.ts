// ĞIGI GIVØ — Daily all-league picks cron.
//
// Walks the live fixture-feed catalogue (ESPN / SportScore / OpenLigaDB /
// TheSportsDB / API-Football — never a hardcoded league list) so a single
// cron tick produces picks for every competition that has a fixture in the
// window. Every fixture is processed through the prediction engine
// (multi-source aggregator + confidence gate), and predictions / settled
// results are persisted to the performance tables with leagueSlug +
// competitionName populated.
//
// Behaviour:
//   • fail-soft per league — one broken league never stops the sweep
//   • idempotent — skips matches already recorded
//   • low-confidence matches ARE recorded and flagged lowConfidence: true
//   • progress logs: [Cron] Processing Champions League: 15 matches
//
// Scheduling: configured in vercel.json (default 4 AM UTC). Override the
// cadence per-environment with CRON_DAILY_PICKS_SCHEDULE (e.g. "0 4 * * *");
// limit scope with CRON_DAILY_PICKS_LEAGUES (comma-separated slugs) and bound
// wall-time with CRON_DAILY_PICKS_TIME_BUDGET_MS.

import { db } from "@/db";
import {
  dailyPicks,
  performanceLog,
  savedSlips,
  valueBetLog,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { fetchScoreboard, type FixtureLite } from "@/lib/espn";
import { evaluateFinishedMatch } from "@/lib/engine";
import { runOracleAllModesWithStandings, type OracleResult } from "@/lib/engine/oracle";
import { ALL_RANKING_MODES, type RankingMode } from "@/lib/engine/selector";
import { findValueBets, type BookmakerOdds } from "@/lib/engine/value";
import { evaluateLeg, type MatchResult } from "@/lib/settlement/evaluate";
import { LEAGUES, LEAGUE_MAP } from "@/lib/leagues";
import { canonicalLeagueSlug } from "@/lib/leaguePriority";
import { resilientJson } from "@/lib/httpClient";
import { statsAggregator } from "@/lib/data/aggregator";
import type { CanonicalMatchStats, TeamStats } from "@/lib/data/types";
import { GET as fixturesGET } from "@/app/api/fixtures/route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ─── Config (env-overridable) ────────────────────────────────────────────────

const env = (name: string): string => (process.env[name] ?? "").trim();

/** Cron expression this route expects to be called on (documentation + health payload). */
export const CRON_DAILY_PICKS_SCHEDULE = () => env("CRON_DAILY_PICKS_SCHEDULE") || "0 4 * * *";

const TIME_BUDGET_MS = () => {
  const raw = Number(env("CRON_DAILY_PICKS_TIME_BUDGET_MS"));
  return Number.isFinite(raw) && raw > 0 ? raw : 240_000; // stop starting new work after 4 minutes
};

/** Optional allow-list of league slugs (comma-separated) — defaults to ALL. */
const LEAGUE_ALLOWLIST = () =>
  env("CRON_DAILY_PICKS_LEAGUES")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** When true (default), finished matches are verified + written to performance_log. */
const VERIFY_FINISHED = () => env("CRON_DAILY_PICKS_VERIFY_FINISHED").toLowerCase() !== "false";

// ─── Shared types & lookups (reused by /api/cron/settle and /api/backfill/performance) ──

export type FixtureSource = "ESPN" | "SportScore" | "OpenLigaDB" | "TheSportsDB" | "ApiFootball";

export interface AggregatedFixture {
  fixture: FixtureLite;
  source:  FixtureSource;
}

export interface CompetitionFixtures {
  leagueSlug:      string;
  competitionName: string;
  fixtures:        AggregatedFixture[];
}

/** Normalise a name for fuzzy matching (lowercase, punctuation-stripped). */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** kebab-case slug for leagues without a catalog entry. */
export function kebabSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve a foreign competition name to a catalog slug. Falls back to a
 * namespaced kebab slug (e.g. "tsdb:english-premier-league") so every
 * competition still gets a stable identity even when the catalog has no entry.
 */
export function resolveLeagueSlug(name: string, namespace: FixtureSource): string {
  const target = norm(name);
  if (!target) return `${namespace.toLowerCase()}:unknown`;
  for (const l of LEAGUES) {
    const candidate = norm(l.name);
    if (candidate === target || candidate.includes(target) || target.includes(candidate)) {
      return canonicalLeagueSlug(l.slug);
    }
  }
  return `${namespace.toLowerCase()}:${kebabSlug(name)}`;
}

/** Human-readable competition name + slug for any slug (catalog or namespaced). */
export function competitionInfo(slug: string | null | undefined, fallbackName?: string | null) {
  const def = slug ? LEAGUE_MAP[slug] : undefined;
  const name = def?.name ?? fallbackName ?? slug ?? "Unknown Competition";
  return { leagueSlug: slug ?? "unknown", competitionName: name };
}

/** Build a FixtureLite from raw parts (used by every non-ESPN normaliser). */
function buildFixture(params: {
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
    id:           params.id,
    leagueSlug:   params.leagueSlug,
    leagueName:   params.leagueName,
    date:         params.date,
    state:        params.state,
    statusDetail: params.statusDetail,
    venue:        null,
    neutralSite:  false,
    home: {
      id:        "",
      name:      params.homeName,
      shortName: params.homeName,
      abbrev:    params.homeName.slice(0, 3),
      logo:      null,
      color:     null,
      score:     params.homeScore,
      homeAway:  "home",
    },
    away: {
      id:        "",
      name:      params.awayName,
      shortName: params.awayName,
      abbrev:    params.awayName.slice(0, 3),
      logo:      null,
      color:     null,
      score:     params.awayScore,
      homeAway:  "away",
    },
    odds: null,
  };
}

// ─── Provider 1: ESPN (primary) — every competition in the catalog ────────────

export async function fetchEspnFixtures(
  slug: string,
  dates?: string,
): Promise<AggregatedFixture[]> {
  try {
    const fixtures = await fetchScoreboard(slug, dates);
    return fixtures.map((fixture) => ({ fixture, source: "ESPN" as const }));
  } catch {
    return [];
  }
}

// ─── Provider 2: TheSportsDB (all competitions, free tier) ────────────────────

const TSDB_BASE = () => env("THESPORTSDB_BASE") || "https://www.thesportsdb.com";
const TSDB_KEY  = () => env("THESPORTSDB_KEY") || "3"; // free public test key (repo convention)

interface TsdbEvent {
  idEvent?:      string;
  strEvent?:     string;
  strHomeTeam?:  string;
  strAwayTeam?:  string;
  dateEvent?:    string;
  strTime?:      string;
  strStatus?:    string;
  strLeague?:    string;
  idLeague?:     string;
  intHomeScore?: string | null;
  intAwayScore?: string | null;
}

export async function fetchTheSportsDbFixtures(dates: string[]): Promise<AggregatedFixture[]> {
  const out: AggregatedFixture[] = [];
  for (const d of dates) {
    const url = `${TSDB_BASE()}/api/v1/json/${TSDB_KEY()}/eventsday.php?d=${d}&s=Soccer`;
    const data = await resilientJson<{ event?: TsdbEvent[] }>(url, { revalidate: 300, cacheTtlMs: 5 * 60_000 });
    for (const ev of data?.event ?? []) {
      const homeName = ev.strHomeTeam?.trim();
      const awayName = ev.strAwayTeam?.trim();
      if (!homeName || !awayName || !ev.dateEvent) continue;
      const leagueName = ev.strLeague?.trim() || "Unknown Competition";
      const slug = resolveLeagueSlug(leagueName, "TheSportsDB");
      const status = (ev.strStatus ?? "").toLowerCase();
      const state: FixtureLite["state"] =
        status.includes("not started") ? "pre" : status.includes("finished") ? "post" : "in";
      out.push({
        fixture: buildFixture({
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

// ─── Provider 3: OpenLigaDB (German leagues — bl1/bl2/bl3) ────────────────────

const OPENLIGADB_BASE = () => env("OPENLIGADB_BASE") || "https://api.openligadb.de";

const OPENLIGADB_LEAGUES: Array<{ shortcut: string; slug: string; name: string }> = [
  { shortcut: "bl1", slug: "ger.1", name: "Bundesliga" },
  { shortcut: "bl2", slug: "ger.2", name: "2. Bundesliga" },
  { shortcut: "bl3", slug: "ger.3", name: "3. Liga" },
];

interface OlDbMatch {
  matchID?:       number;
  matchDateTime?: string;
  team1?:         { teamName?: string };
  team2?:         { teamName?: string };
  matchResults?:  Array<{ resultTypeID?: number; pointsTeam1?: number; pointsTeam2?: number }>;
  matchIsFinished?: boolean;
}

export async function fetchOpenLigaDbFixtures(from: Date, to: Date): Promise<AggregatedFixture[]> {
  const season = String(from.getUTCFullYear());
  const out: AggregatedFixture[] = [];
  const fromMs = from.getTime() - 12 * 3600_000;
  const toMs   = to.getTime() + 36 * 3600_000;

  for (const lg of OPENLIGADB_LEAGUES) {
    const data = await resilientJson<OlDbMatch[]>(
      `${OPENLIGADB_BASE()}/getmatchdata/${lg.shortcut}/${season}`,
      { revalidate: 600, cacheTtlMs: 10 * 60_000 },
    );
    for (const m of data ?? []) {
      const homeName = m.team1?.teamName?.trim();
      const awayName = m.team2?.teamName?.trim();
      if (!homeName || !awayName || !m.matchDateTime) continue;
      const when = new Date(m.matchDateTime).getTime();
      if (!Number.isFinite(when) || when < fromMs || when > toMs) continue;
      const finalResult = (m.matchResults ?? []).find((r) => r.resultTypeID === 2);
      const finished = m.matchIsFinished === true || finalResult != null;
      out.push({
        fixture: buildFixture({
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

// ─── Provider 4: SportScore (no API key — smaller-league fallback) ────────────

const SPORTSCORE_BASE = () => env("SPORTSCORE_BASE") || "https://sportscore.com";

export async function fetchSportScoreFixtures(): Promise<AggregatedFixture[]> {
  const url = `${SPORTSCORE_BASE()}/api/widget/matches/?sport=football&limit=50`;
  const root = await resilientJson<unknown>(url, { revalidate: 300, cacheTtlMs: 5 * 60_000 });
  const out: AggregatedFixture[] = [];

  const asRecord = (v: unknown): Record<string, unknown> | null =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

  // The widget payload varies; defensively walk for match-like records.
  const visited = new Set<unknown>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const rec = asRecord(item);
        if (!rec) continue;
        const home = str(rec.home ?? rec.home_name ?? rec.homeName ?? rec.team_home);
        const away = str(rec.away ?? rec.away_name ?? rec.awayName ?? rec.team_away);
        if (home && away) {
          const time = str(rec.time ?? rec.date ?? rec.kickoff ?? rec.match_time);
          const status = (str(rec.status) ?? "").toLowerCase();
          const hs = rec.home_score ?? rec.homeScore;
          const as = rec.away_score ?? rec.awayScore;
          const finished = status.includes("finish") || (hs !== null && hs !== undefined && hs !== "");
          const competition = str(rec.competition ?? rec.league ?? rec.tournament) ?? "Unknown Competition";
          out.push({
            fixture: buildFixture({
              id: `sportscore:${str(rec.slug) ?? `${home}-${away}-${time ?? ""}`}`,
              leagueSlug: resolveLeagueSlug(competition, "SportScore"),
              leagueName: competition,
              date: time && /^\d{4}-\d{2}-\d{2}T/.test(time) ? time : new Date().toISOString(),
              state: finished ? "post" : status.includes("live") || status.includes("in progress") ? "in" : "pre",
              statusDetail: str(rec.status) ?? "",
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

// ─── Provider 5: API-Football (free tier — requires key) ──────────────────────

const APIF_BASE = () => env("API_FOOTBALL_BASE") || "https://v3.football.api-sports.io";
const APIF_KEY  = () => env("API_FOOTBALL_KEY") || env("FOOTBALL_API_KEY");

/** API-Football league id → catalog slug (free tier coverage map). */
const APIF_LEAGUE_IDS: Record<number, string> = {
  2: "uefa.champions", 3: "uefa.europa", 4: "uefa.euro", 9: "uefa.nations",
  39: "eng.1", 40: "eng.2", 41: "eng.3", 45: "eng.fa",
  140: "esp.1", 141: "esp.2",
  78: "ger.1", 79: "ger.2", 81: "ger.dfb_pokal",
  135: "ita.1", 136: "ita.2", 137: "ita.coppa_italia",
  61: "fra.1", 62: "fra.2", 65: "fra.coupe_de_france",
  88: "ned.1", 94: "por.1", 144: "bel.1", 203: "tur.1",
  71: "bra.1", 72: "bra.2", 128: "arg.1", 262: "mex.1", 253: "usa.1",
  98: "jpn.1", 292: "kor.1", 169: "chn.1", 323: "ind.1", 307: "ksa.1",
  33: "aus.1", 1: "fifa.world", 5: "fifa.friendly",
};

interface ApiFFixture {
  fixture: { id: number; date: string; status?: { short?: string; long?: string } };
  teams:   { home: { name: string } | null; away: { name: string } | null };
  league:  { id: number; name: string };
  goals?:  { home: number | null; away: number | null };
}

export async function fetchApiFootballFixtures(dates: string[]): Promise<AggregatedFixture[]> {
  if (!APIF_KEY()) return [];
  const out: AggregatedFixture[] = [];
  for (const d of dates) {
    const data = await resilientJson<{ response?: ApiFFixture[] }>(
      `${APIF_BASE()}/fixtures?date=${d}`,
      { headers: { "x-apisports-key": APIF_KEY() }, revalidate: 300, cacheTtlMs: 5 * 60_000 },
    );
    for (const f of data?.response ?? []) {
      const homeName = f.teams?.home?.name?.trim();
      const awayName = f.teams?.away?.name?.trim();
      if (!homeName || !awayName) continue;
      const leagueName = f.league?.name?.trim() || "Unknown Competition";
      const slug = APIF_LEAGUE_IDS[f.league?.id] ?? resolveLeagueSlug(leagueName, "ApiFootball");
      const short = f.fixture?.status?.short ?? "";
      const state: FixtureLite["state"] =
        short === "FT" || short === "AET" || short === "PEN" ? "post"
        : short === "NS" || short === "TBD" || short === "" ? "pre"
        : "in";
      out.push({
        fixture: buildFixture({
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

// ─── Aggregation: live fixture-feed catalogue → per-competition lists ─────────

/**
 * Fetch fixtures for every competition from the shared fixture feed
 * (live data-source catalogue + fallbacks). Deduplicated across providers
 * and grouped by league slug. Does not walk a hardcoded league list.
 */
export async function aggregateAllCompetitions(opts?: {
  leagueSlugs?: string[];
  dates?: string[];
  now?: Date;
  days?: number;
}): Promise<CompetitionFixtures[]> {
  const days = opts?.days ?? (opts?.dates?.length ? opts.dates.length : 14);
  const allow = opts?.leagueSlugs?.length
    ? opts.leagueSlugs.map(canonicalLeagueSlug)
    : undefined;

  const url = new URL("http://gigi.local/api/fixtures");
  url.searchParams.set("days", String(days));
  url.searchParams.set("stats", "0");
  const res = await fixturesGET(new Request(url));
  const payload = (await res.json()) as {
    fixtures?: Array<FixtureLite & { leagueSlug: string; leagueName: string }>;
  };

  const allowSet = allow ? new Set(allow) : null;
  const groups = new Map<string, CompetitionFixtures>();
  const sourceOf = (id: string): FixtureSource =>
    id.startsWith("tsdb:")
      ? "TheSportsDB"
      : id.startsWith("oligadb:")
        ? "OpenLigaDB"
        : id.startsWith("sportscore:")
          ? "SportScore"
          : id.startsWith("apif:")
            ? "ApiFootball"
            : "ESPN";

  for (const fx of payload.fixtures ?? []) {
    const slug = canonicalLeagueSlug(fx.leagueSlug);
    if (allowSet && !allowSet.has(slug)) continue;
    let group = groups.get(slug);
    if (!group) {
      group = {
        leagueSlug: slug,
        competitionName: fx.leagueName || LEAGUE_MAP[slug]?.name || slug,
        fixtures: [],
      };
      groups.set(slug, group);
    }
    group.fixtures.push({ fixture: fx, source: sourceOf(fx.id) });
  }

  return [...groups.values()]
    .filter((g) => g.fixtures.length > 0)
    .sort((a, b) => {
      const ta = LEAGUE_MAP[a.leagueSlug]?.tier ?? 9;
      const tb = LEAGUE_MAP[b.leagueSlug]?.tier ?? 9;
      if (ta !== tb) return ta - tb;
      return a.competitionName.localeCompare(b.competitionName);
    });
}

// ─── Boxscore (ESPN events only — stat markets need it) ───────────────────────

interface EspnStatEntry { name: string; displayValue: string }
interface EspnBoxscoreResponse {
  header?: { competitions?: Array<{
    status?: { type?: { state?: string } };
    competitors?: Array<{ homeAway?: string; score?: string | number }>;
  }> };
  boxscore?: { teams?: Array<{ statistics?: EspnStatEntry[] }> };
}

export async function fetchEspnBoxscore(slug: string, eventId: string): Promise<Record<string, number> | null> {
  if (!slug || slug.includes(":")) return null; // non-ESPN events have no boxscore endpoint
  const data = await resilientJson<EspnBoxscoreResponse>(
    `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${eventId}`,
    { revalidate: 600 },
  );
  const teams = data?.boxscore?.teams;
  if (!teams || teams.length < 2) return null;
  const parse = (stats: EspnStatEntry[]) => {
    const m: Record<string, number> = {};
    for (const s of stats) m[s.name] = parseFloat(s.displayValue) || 0;
    return m;
  };
  const h = parse(teams[0]?.statistics ?? []);
  const a = parse(teams[1]?.statistics ?? []);
  return {
    homeShots:         h.totalShots ?? 0,      awayShots:         a.totalShots ?? 0,
    homeSot:           h.shotsOnTarget ?? 0,   awaySot:           a.shotsOnTarget ?? 0,
    homeCorners:       h.wonCorners ?? 0,      awayCorners:       a.wonCorners ?? 0,
    homeCards:         h.yellowCards ?? 0,     awayCards:         a.yellowCards ?? 0,
    homeOffsides:      h.offsides ?? 0,        awayOffsides:      a.offsides ?? 0,
    homeSaves:         h.saves ?? 0,           awaySaves:         a.saves ?? 0,
    homeInterceptions: h.interceptions ?? 0,   awayInterceptions: a.interceptions ?? 0,
    homeFouls:         h.foulsCommitted ?? 0,  awayFouls:         a.foulsCommitted ?? 0,
    homeRedCards:      h.redCards ?? 0,        awayRedCards:      a.redCards ?? 0,
  };
}

// ─── Result resolution helpers (shared with settle + backfill) ────────────────

/** MatchResult from a finished FixtureLite (any source). */
export function resultFromFixture(fx: FixtureLite): MatchResult | null {
  if (fx.state !== "post" || fx.home.score === null || fx.away.score === null) return null;
  const hs = Number(fx.home.score);
  const as = Number(fx.away.score);
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
  return {
    eventId:    fx.id,
    leagueSlug: fx.leagueSlug,
    date:       fx.date.slice(0, 10),
    homeName:   fx.home.name,
    awayName:   fx.away.name,
    homeScore:  hs,
    awayScore:  as,
  };
}

/**
 * Multi-source result lookup for a tracked row (used by the settle route).
 * Tries ESPN summary first, then TheSportsDB / OpenLigaDB / API-Football by
 * team names + date. Returns null while a match has no final result anywhere.
 */
export async function lookupMultiSourceResult(params: {
  eventId?: string | null;
  leagueSlug?: string | null;
  matchLabel?: string | null;
  matchDate?: string | null;
}): Promise<MatchResult | null> {
  const home = params.matchLabel?.split(" vs ")[0]?.trim() ?? "";
  const away = params.matchLabel?.split(" vs ")[1]?.trim() ?? "";
  const day = params.matchDate?.slice(0, 10) ?? "";

  // 1) ESPN summary — the authoritative path for ESPN events.
  if (params.eventId && params.leagueSlug && !params.eventId.includes(":")) {
    const data = await resilientJson<EspnBoxscoreResponse>(
      `https://site.api.espn.com/apis/site/v2/sports/soccer/${params.leagueSlug}/summary?event=${params.eventId}`,
      { revalidate: 600 },
    );
    const comp = data?.header?.competitions?.[0];
    if (comp?.status?.type?.state === "post") {
      const competitors = comp.competitors ?? [];
      const h = competitors.find((c) => c.homeAway === "home");
      const a = competitors.find((c) => c.homeAway === "away");
      return {
        eventId:    params.eventId,
        leagueSlug: params.leagueSlug,
        date:       day,
        homeName:   home,
        awayName:   away,
        homeScore:  Number(h?.score) || 0,
        awayScore:  Number(a?.score) || 0,
      };
    }
  }

  // 2) Provider fallbacks (fixture lists filtered to the tracked date + teams).
  if (day && home && away) {
    const [tsdb, oligadb, apif] = await Promise.all([
      fetchTheSportsDbFixtures([day]),
      fetchOpenLigaDbFixtures(new Date(day), new Date(day)),
      fetchApiFootballFixtures([day]),
    ]);
    const targets = [...tsdb, ...oligadb, ...apif].map((x) => x.fixture);
    const match = targets.find((f) => {
      const hn = norm(f.home.name);
      const an = norm(f.away.name);
      const th = norm(home);
      const ta = norm(away);
      return (
        (hn.includes(th) || th.includes(hn) || hn === th) &&
        (an.includes(ta) || ta.includes(an) || an === ta)
      );
    });
    if (match) return resultFromFixture(match);
  }
  return null;
}

// ─── Persistence helpers (shared with settle + backfill) ──────────────────────

export function buildTop10Detail(pred: OracleResult) {
  return pred.top10.slice(0, 10).map((m) => {
    const odds = m.marketOdds ?? m.fairOdds ?? null;
    return {
      name:      m.name,
      selection: m.selection,
      hitRate:   m.hitRate,
      outcome:   m.outcome ?? "PENDING",
      family:    m.family,
      reason:    m.reason,
      odds,
      ev:        odds !== null ? Math.round((m.hitRate * odds - 1) * 1000) / 1000 : null,
      // Per-pick ranking-factor breakdown (factor label → 0..1 contribution)
      // so the performance dashboard's factor analysis uses REAL weights
      // instead of derived market-family buckets. Absent when the engine
      // never ranked the pick (e.g. registry markets).
      factors:   m.factors ?? null,
    };
  });
}

/**
 * Idempotently persist a finished match's verification into performance_log.
 * One row per (eventId, rankingMode) — the idempotency check is scoped to the
 * mode, so the four ranking modes each get their own verified row.
 */
export async function savePerformanceLog(
  fx: FixtureLite,
  competitionName: string,
  pred: OracleResult,
  boxscore: Record<string, number> | null,
  rankingMode: RankingMode = "B",
): Promise<boolean> {
  const existing = await db
    .select({ id: performanceLog.id })
    .from(performanceLog)
    .where(and(
      eq(performanceLog.eventId, fx.id),
      eq(performanceLog.rankingMode, rankingMode),
    ))
    .limit(1);
  if (existing[0]) return false;

  evaluateFinishedMatch(fx, pred, boxscore);
  const detail = buildTop10Detail(pred);
  const hits    = detail.filter((p) => p.outcome === "HIT").length;
  const misses  = detail.filter((p) => p.outcome === "MISS").length;
  const pending = detail.filter((p) => p.outcome === "PENDING" || !p.outcome).length;
  const decided = hits + misses;

  await db.insert(performanceLog).values({
    eventId:         fx.id,
    matchLabel:      `${fx.home.name} vs ${fx.away.name}`,
    homeTeam:        fx.home.name,
    awayTeam:        fx.away.name,
    league:          competitionName,
    leagueSlug:      fx.leagueSlug,
    competitionName,
    matchDate:       fx.date.slice(0, 10),
    homeScore:       Number(fx.home.score) || 0,
    awayScore:       Number(fx.away.score) || 0,
    totalPicks:      detail.length,
    hits,
    misses,
    pending,
    accuracy:        decided > 0 ? hits / decided : 0,
    top10Detail:     detail,
    lowConfidence:   pred.lowConfidence ?? false,
    rankingMode,
  });
  return true;
}

/**
 * Log value bets for a match (settled immediately when the fixture is
 * finished). One row per (eventId, market, selection, rankingMode) — the
 * existence check is scoped to the mode so each ranking mode keeps its own
 * tracked value bets.
 */
export async function saveValueBets(
  fx: FixtureLite,
  competitionName: string,
  pred: OracleResult,
  odds: BookmakerOdds | null,
  rankingMode: RankingMode = "B",
): Promise<number> {
  if (!odds) return 0;
  const valueBets = findValueBets(pred.markets, odds, fx.home.name, fx.away.name)
    .filter((v) => v.valueEdge > 0.02 && v.bookDecimalOdds > 1.01);
  const result = resultFromFixture(fx);
  let saved = 0;

  for (const vb of valueBets.slice(0, 5)) {
    const exists = await db
      .select({ id: valueBetLog.id })
      .from(valueBetLog)
      .where(and(
        eq(valueBetLog.eventId, fx.id),
        eq(valueBetLog.marketName, vb.market.name),
        eq(valueBetLog.selection, vb.market.selection),
        eq(valueBetLog.rankingMode, rankingMode),
      ))
      .limit(1);
    if (exists[0]) continue;

    const stake = 10;
    const outcome = result
      ? evaluateLeg({ marketName: vb.market.name, selection: vb.market.selection }, result)
      : "pending";
    const actualReturn =
      outcome === "won" ? stake * vb.bookDecimalOdds : outcome === "void" ? stake : null;

    await db.insert(valueBetLog).values({
      eventId:         fx.id,
      leagueSlug:      fx.leagueSlug,
      competitionName,
      match:           `${fx.home.name} vs ${fx.away.name}`,
      matchDate:       fx.date.slice(0, 10),
      marketName:      vb.market.name,
      selection:       vb.market.selection,
      oracleProb:      vb.oracleProbability,
      bookOdds:        vb.bookDecimalOdds,
      valueEdge:       vb.valueEdge,
      kellyStake:      vb.kellyStake,
      stake,
      potentialReturn: stake * vb.bookDecimalOdds,
      outcome,
      actualReturn,
      pnl:             actualReturn !== null ? actualReturn - stake : null,
      lowConfidence:   pred.lowConfidence ?? false,
      rankingMode,
    });
    saved++;
  }
  return saved;
}

/** Track an upcoming match's picks in daily_picks (idempotent per event). */
export async function saveDailyPickRow(
  fx: FixtureLite,
  competitionName: string,
  pred: OracleResult,
): Promise<boolean> {
  const existing = await db
    .select({ id: dailyPicks.id })
    .from(dailyPicks)
    .where(eq(dailyPicks.eventId, fx.id))
    .limit(1);
  if (existing[0]) return false;

  const picks = pred.top10.slice(0, 10).map((m) => ({
    name:      m.name,
    selection: m.selection,
    hitRate:   m.hitRate,
    outcome:   "PENDING",
    family:    m.family,
  }));

  await db.insert(dailyPicks).values({
    pickDate:   new Date().toISOString().slice(0, 10),
    match:      `${fx.home.name} vs ${fx.away.name}`,
    league:     competitionName,
    leagueSlug: fx.leagueSlug,
    eventId:    fx.id,
    picks,
    hits:    0,
    misses:  0,
    pending: picks.length,
    status:  picks.length === 0 ? "settled" : "pending",
  });
  return true;
}

/** Build BookmakerOdds from a fixture's own odds payload (scoreboard odds). */
export function oddsFromFixture(fx: FixtureLite): BookmakerOdds | null {
  const o = fx.odds;
  if (!o || (!o.homeML && !o.drawML && !o.awayML)) return null;
  return {
    provider:   o.provider ?? "ESPN",
    homeML:     o.homeML ?? undefined,
    drawML:     o.drawML ?? undefined,
    awayML:     o.awayML ?? undefined,
    overUnder:  o.overUnder ?? undefined,
  };
}

/**
 * Auto-save a daily value slip for a competition (idempotent per day+competition).
 * `rankingMode` is stamped on the row AND embedded in each leg's JSON so the
 * ranking-mode dashboard can attribute the slip even on deployments where the
 * saved_slips.ranking_mode column is still absent.
 */
export async function saveAutoSlip(
  competitionName: string,
  leagueSlug: string,
  legs: Array<{
    fixtureId: string;
    matchLabel: string;
    marketName: string;
    selection: string;
    odds: number;
    prob: number;
  }>,
  rankingMode: RankingMode = "B",
): Promise<boolean> {
  if (legs.length < 3) return false;
  const name = `Auto ${new Date().toISOString().slice(0, 10)} · ${competitionName}`;
  const existing = await db
    .select({ id: savedSlips.id })
    .from(savedSlips)
    .where(eq(savedSlips.name, name))
    .limit(1);
  if (existing[0]) return false;

  await db.insert(savedSlips).values({
    name,
    slipType:        "value",
    leagueSlug,
    competitionName,
    picks:           legs.map((l) => ({
      fixtureId: l.fixtureId,
      leagueSlug,
      matchLabel: l.matchLabel,
      marketName: l.marketName,
      selection:  l.selection,
      odds:       l.odds,
      rankingMode,
    })),
    combinedOdds:    legs.reduce((acc, l) => acc * l.odds, 1),
    combinedProb:    legs.reduce((acc, l) => acc * l.prob, 1),
    stake:           10,
    status:          "pending",
    rankingMode,
  });
  return true;
}

// ─── Canonical stats pre-fetch (Part 5) ───────────────────────────────────────
//
// Before a match's picks are persisted, its canonical stats are pulled into the
// aggregator's shared cache so the settlement engine finds them instantly when
// the match finishes. Fail-soft: a null result (no source has stats yet, e.g.
// pre-kickoff) simply means settlement will re-fetch later.

/** Build a MatchStatsQuery for a fixture (any source / namespace). */
function statsQueryForFixture(fx: FixtureLite) {
  return {
    leagueSlug: fx.leagueSlug,
    eventId: fx.id,
    homeTeam: fx.home.name,
    awayTeam: fx.away.name,
    date: fx.date,
  };
}

async function prefetchStats(fx: FixtureLite): Promise<CanonicalMatchStats | null> {
  return statsAggregator.fetch(statsQueryForFixture(fx)).catch(() => null);
}

/**
 * Map canonical stats onto the ESPN-boxscore key space consumed by
 * evaluateFinishedMatch. Only PRESENT fields are emitted — a null stat is
 * omitted (never coerced to 0), so the evaluator keeps the market PENDING
 * rather than fabricating a value.
 */
export function statsToBoxscore(stats: CanonicalMatchStats | null): Record<string, number> | null {
  if (!stats) return null;
  const out: Record<string, number> = {};
  const add = (key: string, value: number | null) => {
    if (value !== null) out[key] = value;
  };
  const team = (s: TeamStats, prefix: "home" | "away") => {
    add(`${prefix}Shots`, s.shots);
    add(`${prefix}Sot`, s.shotsOnTarget);
    add(`${prefix}Corners`, s.corners);
    add(`${prefix}Cards`, s.yellowCards);
    add(`${prefix}Fouls`, s.fouls);
    add(`${prefix}Offsides`, s.offsides);
    add(`${prefix}Saves`, s.saves);
    add(`${prefix}Interceptions`, s.interceptions);
    add(`${prefix}RedCards`, s.redCards);
  };
  team(stats.home, "home");
  team(stats.away, "away");
  return Object.keys(out).length > 0 ? out : null;
}

// ─── Per-competition processing ───────────────────────────────────────────────

interface ProcessOutcome {
  matches: number;
  verified: number;
  tracked: number;
  valueBets: number;
  skipped: number;
  lowConfidence: number;
  errors: string[];
}

/** Run the engine across one competition's fixtures and persist everything. */
export async function processCompetition(
  comp: CompetitionFixtures,
  deadline: number,
  opts?: { verifyFinished?: boolean },
): Promise<ProcessOutcome> {
  const out: ProcessOutcome = {
    matches: 0, verified: 0, tracked: 0, valueBets: 0, skipped: 0, lowConfidence: 0, errors: [],
  };
  const verifyFinished = opts?.verifyFinished ?? VERIFY_FINISHED();

  // Auto-slip leg accumulator (high-confidence value legs only).
  const slipLegs: Array<{
    fixtureId: string; matchLabel: string; marketName: string;
    selection: string; odds: number; prob: number;
  }> = [];

  for (const { fixture: fx } of comp.fixtures) {
    if (Date.now() > deadline) break;
    out.matches++;
    try {
      // One external-data fetch, one ranking pass per mode — every write path
      // persists one row per ranking mode so A/B/C/D all get populated.
      const preds = await runOracleAllModesWithStandings(fx);
      if (preds.size === 0) { out.skipped++; continue; } // unplayable — integrity over volume

      // Mode B is the canonical run for slip legs + daily picks (single
      // mode-agnostic products keep their historical single-mode semantics).
      const canonical = preds.get("B") ?? preds.values().next().value!;
      const lowConfidence = canonical.lowConfidence ?? false;
      if (lowConfidence) out.lowConfidence++;

      const finished = fx.state === "post" && fx.home.score !== null && fx.away.score !== null;

      // Part 5 — warm the shared stats cache before persisting anything, so the
      // settlement engine can resolve stat markets instantly once the match ends.
      const canonicalStats = await prefetchStats(fx);

      if (finished) {
        // Verify + write the settled result into performance_log (one row per mode).
        if (verifyFinished) {
          // ESPN boxscore first; fall back to the canonical aggregator's stats
          // so non-ESPN matches can still settle corners/cards/shots honestly.
          const boxscore = (await fetchEspnBoxscore(fx.leagueSlug, fx.id))
            ?? statsToBoxscore(canonicalStats);
          for (const [mode, pred] of preds) {
            if (await savePerformanceLog(fx, comp.competitionName, pred, boxscore, mode)) out.verified++;
          }
        }
      } else {
        // Upcoming/live match — record the prediction for later settlement.
        if (await saveDailyPickRow(fx, comp.competitionName, canonical)) out.tracked++;
      }

      // Value bets — recorded per mode (and, when finished, settled) either way.
      const odds = oddsFromFixture(fx);
      for (const [mode, pred] of preds) {
        out.valueBets += await saveValueBets(fx, comp.competitionName, pred, odds, mode);
      }

      // High-confidence value legs feed the competition's auto slip.
      if (!lowConfidence && odds) {
        const vbs = findValueBets(canonical.markets, odds, fx.home.name, fx.away.name)
          .filter((v) => v.valueEdge > 0.02 && v.bookDecimalOdds > 1.01);
        for (const vb of vbs.slice(0, 2)) {
          slipLegs.push({
            fixtureId:   fx.id,
            matchLabel:  `${fx.home.name} vs ${fx.away.name}`,
            marketName:  vb.market.name,
            selection:   vb.market.selection,
            odds:        vb.bookDecimalOdds,
            prob:        vb.oracleProbability,
          });
        }
      }
    } catch (err) {
      out.errors.push(`${fx.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (slipLegs.length >= 3) {
    try {
      // Legs come from the canonical (mode B) run — stamp B explicitly.
      await saveAutoSlip(comp.competitionName, comp.leagueSlug, slipLegs.slice(0, 8), "B");
    } catch {
      // slip saving is best-effort
    }
  }

  return out;
}

// ─── Main sweep ───────────────────────────────────────────────────────────────

export interface DailyPicksSweepSummary {
  ok: boolean;
  schedule: string;
  leaguesProcessed: number;
  leaguesFailed: number;
  matchesProcessed: number;
  verifiedLogged: number;
  matchesTracked: number;
  valueBetsLogged: number;
  lowConfidence: number;
  skippedUnplayable: number;
  failures: Array<{ leagueSlug: string; competitionName: string; error: string }>;
  ranAt: string;
}

export async function runDailyPicksSweep(): Promise<DailyPicksSweepSummary> {
  const startedAt = Date.now();
  const deadline = startedAt + TIME_BUDGET_MS();
  const allowlist = LEAGUE_ALLOWLIST();

  console.log(`[Cron] Daily all-league sweep started (${allowlist.length ? `${allowlist.length} league(s) allow-listed` : "ALL competitions"}, budget ${Math.round(TIME_BUDGET_MS() / 1000)}s, schedule ${CRON_DAILY_PICKS_SCHEDULE()})`);

  const competitions = await aggregateAllCompetitions(
    allowlist.length ? { leagueSlugs: allowlist } : undefined,
  );

  console.log(`[Cron] Aggregated ${competitions.length} competitions from the live fixture-feed catalogue`);

  const summary: DailyPicksSweepSummary = {
    ok: true,
    schedule: CRON_DAILY_PICKS_SCHEDULE(),
    leaguesProcessed: 0,
    leaguesFailed: 0,
    matchesProcessed: 0,
    verifiedLogged: 0,
    matchesTracked: 0,
    valueBetsLogged: 0,
    lowConfidence: 0,
    skippedUnplayable: 0,
    failures: [],
    ranAt: new Date().toISOString(),
  };

  for (const comp of competitions) {
    if (Date.now() > deadline) {
      console.log(`[Cron] Time budget reached — processed ${summary.leaguesProcessed}/${competitions.length} competitions this run; the rest continue on the next run.`);
      break;
    }
    console.log(`[Cron] Processing ${comp.competitionName}: ${comp.fixtures.length} matches`);
    try {
      const outcome = await processCompetition(comp, deadline);
      summary.leaguesProcessed++;
      summary.matchesProcessed += outcome.matches;
      summary.verifiedLogged += outcome.verified;
      summary.matchesTracked += outcome.tracked;
      summary.valueBetsLogged += outcome.valueBets;
      summary.lowConfidence += outcome.lowConfidence;
      summary.skippedUnplayable += outcome.skipped;
      for (const e of outcome.errors) console.error(`[Cron] ${comp.competitionName} — ${e}`);
      if (outcome.matches > 0 && outcome.errors.length === outcome.matches) {
        summary.leaguesFailed++;
        summary.failures.push({
          leagueSlug: comp.leagueSlug,
          competitionName: comp.competitionName,
          error: `all ${outcome.matches} matches failed`,
        });
      }
    } catch (err) {
      // One league failing must never stop the sweep.
      summary.leaguesFailed++;
      const message = err instanceof Error ? err.message : String(err);
      summary.failures.push({ leagueSlug: comp.leagueSlug, competitionName: comp.competitionName, error: message });
      console.error(`[Cron] SKIPPED ${comp.competitionName}: ${message}`);
    }
  }

  console.log(
    `[Cron] Sweep finished: ${summary.leaguesProcessed} competitions, ${summary.matchesProcessed} matches, ` +
    `${summary.verifiedLogged} verified, ${summary.matchesTracked} tracked, ${summary.valueBetsLogged} value bets, ` +
    `${summary.lowConfidence} low-confidence flagged, ${summary.leaguesFailed} failed`,
  );

  return summary;
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured → open (dev/local)
  const url = new URL(req.url);
  const provided =
    req.headers.get("authorization")?.replace("Bearer ", "") ??
    url.searchParams.get("key");
  return provided === secret;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return Response.json({ ...(await runDailyPicksSweep()) });
  } catch (err) {
    console.error("[Cron] daily-picks failed:", err);
    return Response.json({ ok: false, error: "Daily picks sweep failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return GET(req);
}
