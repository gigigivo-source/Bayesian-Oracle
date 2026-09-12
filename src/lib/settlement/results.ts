// ĞIGI GIVØ — Settlement results + boxscore provider.
//
// Three responsibilities:
//   1. Result lookup — the FINAL SCORE for every pending row's match. For each
//      match the ESPN summary endpoint
//
//        https://site.api.espn.com/apis/site/v2/sports/soccer/{leagueSlug}/summary?event={eventId}
//
//      is always tried FIRST (see fetchSettlementResults): it is keyed by the
//      EVENT id, so it resolves a fixture the scoreboard feed misses — a date
//      window that does not cover kick-off, a competition slug from another
//      provider's namespace, or a stale/blank slug on the stored row. The
//      league slug is DERIVED FROM THE MATCH (competition name → ESPN
//      catalogue slug first, the row's own slug second), so a Champions
//      League fixture is asked for as `uefa.champions` and a Premier League
//      one as `eng.1`; when neither yields an ESPN slug the global ESPN
//      scoreboard is searched by team names + date and the real competition
//      slug recovered from it. The score comes from
//      header.competitions[0].competitors[].score, falling back to
//      boxscore.teams[].score. The ESPN scoreboard feed is only used for
//      whatever the summary did not return (including rows that carry no ESPN
//      event id at all — those are matched on their "Home vs Away" label).
//   2. Boxscore supply — when a match finishes, settlement needs the FULL
//      boxscore (corners, cards, shots, throw-ins …), not just the final
//      score. Every fetch goes through the multi-source stats aggregator,
//      which walks the complete registered source chain in priority order
//      (SportScore/ESPN feed → API-Football /fixtures/statistics → StatsBomb
//      open data → datafc → FBref → TheSportsDB → Understat → OpenLigaDB →
//      Highlightly → GitHubDatasets → …), merges the best values first-wins,
//      and caches successful merges (2h TTL) plus per-source rate-limit
//      cooldowns. Whatever the chain leaves null is filled from the same ESPN
//      summary payload (its boxscore is the priority-1 per-match source and is
//      fetched with the same derived league slug). On top of that this module
//      keeps its own memo cache so repeated settlement runs never re-fetch:
//        · positive result  → 30 minutes (the aggregator cache already
//                             suppresses the network within its 2h TTL),
//        · partial/negative → 10 minutes, so late-arriving feeds can still
//                             fill the gaps before the 24h void grace elapses.
//      Every cache miss logs which source provided the boxscore:
//        [Settle] Arsenal vs Chelsea — boxscore from API-Football (corners 12, cards 3, shots 18).

import type { PendingAccumulator, PendingDailyPick, PendingValueBet } from "@/db/queries/settlement";
import { fetchScoreboard, type FixtureLite } from "@/lib/espn";
import { statsAggregator } from "@/lib/data/aggregator";
import { LEAGUES } from "@/lib/leagues";
import { canonicalLeagueSlug } from "@/lib/leaguePriority";
import {
  STAT_FIELDS, emptyCanonicalMatchStats,
  type CanonicalMatchStats, type StatKey, type TeamStats,
} from "@/lib/data/types";
import { resilientJson } from "@/lib/httpClient";
import type { MatchResult } from "./evaluate";

interface ResultRequest { leagueSlug: string; date: string }
interface AccumulatorLeg {
  fixtureId?: string; eventId?: string;
  leagueSlug?: string; league?: string; leagueName?: string; competitionName?: string;
  date?: string; matchDate?: string; matchLabel?: string; match?: string;
}

export interface SettlementQueues {
  accumulators: PendingAccumulator[];
  dailyPicks: PendingDailyPick[];
  valueBets: PendingValueBet[];
}

export function resultKey(label: string): string {
  return label.toLowerCase().replace(/\b(?:vs?\.?|versus)\b/g, " vs ").replace(/[^a-z0-9]+/g, " ").trim();
}

function espnDate(value?: string | null): string | null {
  if (!value) return null;
  const date = value.slice(0, 10).replace(/-/g, "");
  return /^\d{8}$/.test(date) ? date : null;
}

function addRequest(map: Map<string, ResultRequest>, leagueSlug?: string | null, dateValue?: string | null) {
  const date = espnDate(dateValue);
  if (leagueSlug && date) map.set(`${leagueSlug}|${date}`, { leagueSlug, date });
}

function addDailyPickRequest(map: Map<string, ResultRequest>, leagueSlug?: string | null, pickDate?: string | null) {
  const from = espnDate(pickDate);
  if (!leagueSlug || !from || !pickDate) return;
  // Daily picks may be published up to fourteen days before kick-off.
  const end = new Date(`${pickDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return;
  end.setUTCDate(end.getUTCDate() + 14);
  const to = end.toISOString().slice(0, 10).replace(/-/g, "");
  const date = `${from}-${to}`;
  map.set(`${leagueSlug}|${date}`, { leagueSlug, date });
}

export function collectResultRequests(queues: SettlementQueues): ResultRequest[] {
  const requests = new Map<string, ResultRequest>();
  for (const row of queues.dailyPicks) addDailyPickRequest(requests, row.leagueSlug, row.pickDate);
  for (const row of queues.valueBets) addRequest(requests, row.leagueSlug, row.matchDate);
  for (const slip of queues.accumulators) {
    if (!Array.isArray(slip.picks)) continue;
    for (const raw of slip.picks) {
      const leg = raw as AccumulatorLeg;
      addRequest(requests, leg.leagueSlug, leg.date ?? leg.matchDate);
    }
  }
  return [...requests.values()];
}

// ─── Per-match result probes (ESPN summary lookup inputs) ────────────────────
//
// One probe per pending EVENT — the ESPN summary endpoint is keyed by the event
// id, so every tracked row's match can be resolved individually instead of
// hoping a league/date scoreboard happens to contain it. A probe carries
// everything the league-slug derivation needs: the stored slug, the
// competition's display name and the stored match label.

export interface ResultProbe {
  eventId: string;
  /** ESPN slug stored on the row (may be stale, namespaced, "all" or blank). */
  leagueSlug?: string | null;
  /** Competition display name stored on the row (e.g. "UEFA Champions League"). */
  leagueName?: string | null;
  /** Stored "Home vs Away" label (used for logging + label aliases). */
  matchLabel?: string | null;
  /** Match date carried by the row (YYYY-MM-DD or full ISO). */
  date?: string | null;
}

/** ESPN event ids are bare numerics — provider-namespaced ids have no summary. */
function isEspnEventId(eventId?: string | null): eventId is string {
  return !!eventId && /^\d+$/.test(eventId);
}

export function collectResultProbes(queues: SettlementQueues): ResultProbe[] {
  const probes = new Map<string, ResultProbe>();
  const add = (
    eventId: string | null | undefined,
    leagueSlug: string | null | undefined,
    leagueName: string | null | undefined,
    matchLabel: string | null | undefined,
    date: string | null | undefined,
  ) => {
    if (!isEspnEventId(eventId) || probes.has(eventId)) return;
    probes.set(eventId, {
      eventId,
      leagueSlug: leagueSlug ?? null,
      leagueName: leagueName ?? null,
      matchLabel: matchLabel ?? null,
      date: date ?? null,
    });
  };

  for (const row of queues.dailyPicks) {
    add(row.eventId, row.leagueSlug, row.league, row.match, row.pickDate);
  }
  for (const row of queues.valueBets) {
    add(row.eventId, row.leagueSlug, row.competitionName, row.match, row.matchDate);
  }
  for (const slip of queues.accumulators) {
    if (!Array.isArray(slip.picks)) continue;
    for (const raw of slip.picks) {
      const leg = raw as AccumulatorLeg;
      add(
        leg.fixtureId ?? leg.eventId,
        leg.leagueSlug,
        leg.leagueName ?? leg.competitionName ?? leg.league ?? slip.competitionName,
        leg.matchLabel ?? leg.match,
        leg.date ?? leg.matchDate,
      );
    }
  }
  return [...probes.values()];
}

/** Which source answered for a match — reported in the settlement log lines. */
export type ResultSource = "espn-summary" | "scoreboard";

export interface ResultSourceCounts { espnSummary: number; scoreboard: number }

export class ResultsProvider {
  private readonly byKey = new Map<string, MatchResult>();
  /** One entry per fixture (the byKey map stores 3 aliases per match). */
  private readonly fixtures: MatchResult[] = [];
  /** Which source supplied each match's result (event id → source). */
  private readonly resultSources = new Map<string, ResultSource>();

  add(fixture: FixtureLite): void {
    if (fixture.state !== "post" || fixture.home.score === null || fixture.away.score === null) return;
    const result: MatchResult = {
      eventId: fixture.id, leagueSlug: fixture.leagueSlug, date: fixture.date.slice(0, 10),
      // Keep the exact kickoff so the 24h stats-void grace measures from the
      // real final whistle instead of an end-of-day estimate.
      kickoffAt: fixture.date,
      homeName: fixture.home.name, awayName: fixture.away.name,
      homeScore: Number(fixture.home.score), awayScore: Number(fixture.away.score),
    };
    if (!Number.isFinite(result.homeScore) || !Number.isFinite(result.awayScore)) return;
    this.addResult(result, "scoreboard");
  }

  /**
   * Register a resolved match. One entry per event id and FIRST source wins,
   * so the ESPN summary pass — which always runs before the scoreboard pass —
   * takes precedence whenever both know the fixture.
   *
   * `labelAliases` are extra "Home vs Away" spellings for the same match (a
   * row's stored label may use a different team spelling than ESPN's display
   * name); they are only accepted when the teams line up with the result, so a
   * reversed label maps to a home/away-flipped view of it.
   */
  addResult(result: MatchResult, source: ResultSource = "scoreboard", labelAliases: string[] = []): void {
    if (!result.eventId) return;
    if (!Number.isFinite(result.homeScore) || !Number.isFinite(result.awayScore)) return;
    // One entry per match (overlapping scoreboard windows and the summary pass
    // return the same fixture repeatedly) — prefetch (and its fetch budget)
    // never double-counts a fixture.
    if (this.byKey.has(result.eventId)) return;
    this.fixtures.push(result);
    this.byKey.set(result.eventId, result);
    this.byKey.set(resultKey(`${result.homeName} vs ${result.awayName}`), result);
    this.byKey.set(resultKey(`${result.awayName} vs ${result.homeName}`), {
      ...result, homeName: result.awayName, awayName: result.homeName,
      homeScore: result.awayScore, awayScore: result.homeScore,
    });
    for (const alias of labelAliases) this.registerLabelAlias(result, alias);
    this.resultSources.set(result.eventId, source);
  }

  private registerLabelAlias(result: MatchResult, label: string): void {
    const [home, away] = label.split(/\s+vs\.?\s+/i).map((part) => part.trim());
    if (!home || !away) return;
    const key = resultKey(label);
    if (!key || this.byKey.has(key)) return;
    const sameOrientation = sameTeamName(home, result.homeName) && sameTeamName(away, result.awayName);
    const flipped = !sameOrientation &&
      sameTeamName(home, result.awayName) && sameTeamName(away, result.homeName);
    if (!sameOrientation && !flipped) return;
    this.byKey.set(key, flipped
      ? {
          ...result, homeName: result.awayName, awayName: result.homeName,
          homeScore: result.awayScore, awayScore: result.homeScore,
        }
      : result);
  }

  find(eventId?: string | null, matchLabel?: string | null): MatchResult | undefined {
    return (eventId ? this.byKey.get(eventId) : undefined) ??
      (matchLabel ? this.byKey.get(resultKey(matchLabel)) : undefined);
  }

  /** The distinct finished matches this provider knows about. */
  all(): MatchResult[] {
    return [...this.fixtures];
  }

  /** Which source resolved each match — the settlement log reports the totals. */
  sourceCounts(): ResultSourceCounts {
    let espnSummary = 0;
    let scoreboard = 0;
    for (const source of this.resultSources.values()) {
      if (source === "espn-summary") espnSummary++; else scoreboard++;
    }
    return { espnSummary, scoreboard };
  }

  get size(): number { return this.byKey.size; }
}

/** Diacritic/punctuation-insensitive team comparison (label aliases only). */
function sameTeamName(a: string, b: string): boolean {
  const normalise = (value: string) => value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
  const na = normalise(a);
  const nb = normalise(b);
  return !!na && !!nb && (na === nb || na.includes(nb) || nb.includes(na));
}

// ─── Boxscore supply (full stats, every registered source, memo-cached) ──────

export interface BoxscoreOutcome {
  stats: CanonicalMatchStats | null;
  /** Name of the dominant source that supplied the stats, if any. */
  source: string | null;
  /** True when served from the settlement memo cache (no re-fetch happened). */
  cached: boolean;
}

interface BoxscoreEntry { outcome: BoxscoreOutcome; expires: number }

const BOXSCORE_HIT_TTL_MS = 30 * 60_000; // stats found — memo for 30 minutes
const BOXSCORE_MISS_TTL_MS = 10 * 60_000; // nothing yet — retry every 10 minutes (late data)

const boxscoreMemo = new Map<string, BoxscoreEntry>();

/**
 * In-flight lookups by match key: concurrent settlement of several bets on the
 * SAME match (slip legs, multi-pick rows) coalesce into ONE boxscore fetch.
 */
const boxscoreInflight = new Map<string, Promise<BoxscoreOutcome>>();

/** Drop the settlement caches (tests / forced re-sweeps). */
export function clearSettlementBoxscoreCache(): void {
  boxscoreMemo.clear();
  boxscoreInflight.clear();
  espnSummaryMemo.clear();
  espnSummaryInflight.clear();
  espnSlugRecoveryMemo.clear();
}

function boxscoreTotals(stats: CanonicalMatchStats): { corners: number; cards: number; shots: number } {
  const sum = (a: number | null, b: number | null): number => (a ?? 0) + (b ?? 0);
  return {
    corners: sum(stats.home.corners, stats.away.corners),
    cards: sum(stats.home.yellowCards, stats.away.yellowCards) + sum(stats.home.redCards, stats.away.redCards),
    shots: sum(stats.home.shots, stats.away.shots),
  };
}

/**
 * Fetch the full boxscore for a FINISHED match — every market family the
 * settlement engine reads stats from is resolved against this one object.
 * Cache-first: the settlement memo → the aggregator's shared cache (warmed
 * ahead of the final whistle by the daily-picks cron) → the multi-source walk
 * across every registered provider in priority order → the ESPN summary
 * boxscore (fetched with the match's own derived league slug). Fail-soft: a
 * throwing provider chain yields null (markets stay PENDING until the 24h
 * grace, then VOID) — settlement never crashes on a broken source.
 */
export function getSettlementBoxscore(result: MatchResult): Promise<BoxscoreOutcome> {
  const key = `${result.leagueSlug}|${result.eventId}`;
  const memo = boxscoreMemo.get(key);
  if (memo && Date.now() < memo.expires) return Promise.resolve({ ...memo.outcome, cached: true });
  const existing = boxscoreInflight.get(key);
  if (existing) return existing;
  const pending = fetchBoxscore(result, key).finally(() => boxscoreInflight.delete(key));
  boxscoreInflight.set(key, pending);
  return pending;
}

// ─── ESPN summary endpoint (priority-1 match-level source for results + stats)
//
// `GET /soccer/{leagueSlug}/summary?event={eventId}` is ESPN's per-match page
// payload: the final score (header.competitions[0].competitors[].score, with
// boxscore.teams[].score as the fallback), the full team boxscore (corners,
// cards, shots, SOT, saves, fouls, offsides, interceptions …) and the event
// timeline. Because it is keyed by the EVENT, it answers for a match the
// scoreboard feed cannot see — and the league slug is derived from the match
// itself (see espnSlugCandidates), so the request is aimed at the competition
// the fixture really belongs to: `uefa.champions` for a Champions League
// match, `eng.1` for a Premier League one.

interface EspnStatEntry { name?: string; displayValue?: string }

interface EspnSummaryCompetitor {
  homeAway?: "home" | "away" | string;
  score?:    string | number;
  winner?:   boolean;
  team?:     { id?: string; displayName?: string; shortDisplayName?: string; abbreviation?: string };
}

interface EspnSummaryCompetition {
  id?:          string;
  date?:        string;
  status?:      { type?: { state?: string; completed?: boolean; detail?: string; shortDetail?: string } };
  competitors?: EspnSummaryCompetitor[];
}

interface EspnSummaryBoxTeam {
  homeAway?:   string;
  score?:      string | number;
  team?:       { displayName?: string; shortDisplayName?: string; abbreviation?: string };
  statistics?: EspnStatEntry[];
}

interface EspnSummaryLite {
  header?:   { id?: string; competitions?: EspnSummaryCompetition[] };
  boxscore?: { teams?: EspnSummaryBoxTeam[] };
}

const ESPN_SUMMARY_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

/** ESPN's global soccer slug — the last-resort summary lookup for an unknown competition. */
const ESPN_ALL_SLUG = "all";

// ─── League slug derivation ──────────────────────────────────────────────────

/** ESPN slugs are dotted identifiers ("eng.1", "uefa.champions", "ger.dfb_pokal"). */
const ESPN_SLUG_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9_]+)+$/;

/** Competition-name variants worth matching against the catalogue. */
function leagueNameVariants(name: string): string[] {
  const variants = new Set<string>();
  const base = name.trim();
  if (base) variants.add(base);
  // "Champions League, League Phase" / "UEFA Champions League (Final)" → head
  for (const part of base.split(/[,;:()[\]]+/)) if (part.trim()) variants.add(part.trim());
  for (const variant of [...variants]) {
    // Stage suffixes that are not part of a competition's identity.
    const stripped = variant
      .replace(/\b(?:league phase|group stage|knockout(?: stage)?|play-?offs?|qualifiers?|qualifying|regular season|final)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (stripped) variants.add(stripped);
  }
  return [...variants].map(normaliseLeagueName).filter(Boolean);
}

function normaliseLeagueName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Competition names that do not resolve against the ESPN catalogue by simple
 * string containment (kept deliberately small; only consulted when the
 * catalogue lookup found nothing, so it can never override an exact match).
 */
const LEAGUE_NAME_ALIASES: Array<{ contains: string; slug: string }> = [
  { contains: "champions league",    slug: "uefa.champions" },
  { contains: "europa conference",   slug: "uefa.europa.conf" },
  { contains: "conference league",   slug: "uefa.europa.conf" },
  { contains: "europa league",       slug: "uefa.europa" },
  { contains: "premier league",      slug: "eng.1" },
  { contains: "la liga",             slug: "esp.1" },
  { contains: "bundesliga",          slug: "ger.1" },
  { contains: "serie a",             slug: "ita.1" },
  { contains: "ligue 1",             slug: "fra.1" },
];

/** Short forms that never appear inside a catalogue name. */
const LEAGUE_ABBREVIATIONS: Record<string, string> = {
  ucl: "uefa.champions",
  uel: "uefa.europa",
  uecl: "uefa.europa.conf",
  epl: "eng.1",
};

/**
 * Derive the ESPN competition slug from a human-readable competition name
 * (catalogue name match first, then the alias table). Null when nothing lines
 * up — the caller then falls back to the row's own slug / the global scoreboard.
 */
export function slugFromLeagueName(name?: string | null): string | null {
  const targets = name ? leagueNameVariants(name) : [];
  if (targets.length === 0) return null;

  let best: { slug: string; score: number } | null = null;
  for (const league of LEAGUES) {
    const candidate = normaliseLeagueName(league.name);
    if (!candidate) continue;
    const squashedCandidate = candidate.replace(/ /g, "");
    for (const target of targets) {
      const squashedTarget = target.replace(/ /g, "");
      let score = 0;
      if (candidate === target || squashedCandidate === squashedTarget) {
        score = 3;
      } else {
        const shorter = Math.min(candidate.length, squashedTarget.length);
        const longer = Math.max(candidate.length, squashedTarget.length);
        const overlaps = candidate.includes(target) || target.includes(candidate) ||
          squashedCandidate.includes(squashedTarget) || squashedTarget.includes(squashedCandidate);
        // A short generic fragment ("league", "cup") must never pick a league.
        if (overlaps && shorter >= 6 && shorter / longer >= 0.5) score = 2;
      }
      // Strictly better only: catalogue order breaks ties, so UEFA's
      // "Champions League" is preferred over AFC's/CAF's on an equal score.
      if (score > (best?.score ?? 0)) best = { slug: canonicalLeagueSlug(league.slug), score };
    }
  }
  if (best) return best.slug;

  const squashedTargets = targets.map((target) => target.replace(/ /g, ""));
  for (const [abbrev, slug] of Object.entries(LEAGUE_ABBREVIATIONS)) {
    if (squashedTargets.includes(abbrev)) return slug;
  }
  for (const { contains, slug } of LEAGUE_NAME_ALIASES) {
    const needle = contains.replace(/ /g, "");
    if (squashedTargets.some((target) => target.includes(needle))) return slug;
  }
  return null;
}

/**
 * ESPN slugs to try for a match, best first, derived FROM THE MATCH:
 *   1. the competition name (when the row carries one),
 *   2. the row's own slug — canonicalised when it is already an ESPN slug,
 *      un-namespaced/expanded when a provider prefixed it
 *      ("tsdb:english-premier-league" → eng.1),
 *   3. nothing else — the caller adds the global `all` lookup and the
 *      scoreboard recovery as its own fallbacks.
 */
export function espnSlugCandidates(match: { leagueSlug?: string | null; leagueName?: string | null }): string[] {
  const candidates: string[] = [];
  const push = (slug?: string | null) => {
    const value = (slug ?? "").trim().toLowerCase();
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  push(slugFromLeagueName(match.leagueName));

  const stored = (match.leagueSlug ?? "").trim().toLowerCase();
  if (stored) {
    if (ESPN_SLUG_PATTERN.test(stored)) {
      // An ESPN slug: use it (canonicalised, with the original as a fallback).
      push(canonicalLeagueSlug(stored));
      push(stored);
    } else if (stored.includes(":")) {
      // Provider-namespaced ("sportscore:uefa-champions-league") → expand the name.
      push(slugFromLeagueName(stored.slice(stored.indexOf(":") + 1).replace(/[-_]+/g, " ")));
    } else {
      // A bare competition name / placeholder ("Champions League", "unknown").
      push(slugFromLeagueName(stored));
    }
  }
  return candidates;
}

/**
 * Match reference used for league-slug derivation + ESPN summary lookups: any
 * pending row (ResultProbe) or resolved MatchResult satisfies it.
 */
interface EspnMatchRef {
  eventId: string;
  leagueSlug?: string | null;
  leagueName?: string | null;
  homeName?: string | null;
  awayName?: string | null;
  date?: string | null;
}

/**
 * Rows saved before the competition slug was tracked (or saved from ESPN's
 * global `all` scoreboard / a foreign provider) carry no usable ESPN slug —
 * find the match on the global scoreboard by team names + date and take its
 * real competition name from there. Memoised per team/date so a sweep never
 * repeats the lookup; failure is soft (null → the `all` summary is tried).
 */
const espnSlugRecoveryMemo = new Map<string, string | null>();

function espnDateWindow(value: string, radiusDays = 1): string | null {
  const day = espnDate(value);
  if (!day) return null;
  const base = new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return day;
  const shifted = (days: number) => {
    const date = new Date(base);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10).replace(/-/g, "");
  };
  return `${shifted(-radiusDays)}-${shifted(radiusDays)}`;
}

async function recoverLeagueSlugFromScoreboard(match: EspnMatchRef): Promise<string | null> {
  const window = match.date ? espnDateWindow(match.date) : null;
  if (!window || !match.homeName || !match.awayName) return null;
  const cacheKey = `${window}|${match.homeName}|${match.awayName}`;
  const memo = espnSlugRecoveryMemo.get(cacheKey);
  if (memo !== undefined) return memo;

  let slug: string | null = null;
  try {
    const fixtures = await fetchScoreboard(ESPN_ALL_SLUG, window);
    const hit = fixtures.find((fixture) =>
      sameTeamName(fixture.home.name, match.homeName ?? "") &&
      sameTeamName(fixture.away.name, match.awayName ?? ""));
    slug = hit ? slugFromLeagueName(hit.leagueName) : null;
  } catch {
    slug = null; // fail-soft — the caller still has the `all` summary + scoreboard pass
  }
  espnSlugRecoveryMemo.set(cacheKey, slug);
  return slug;
}

/**
 * Every ESPN summary URL to try for a match, in order: the locally derived
 * slugs, the scoreboard-recovered slug (only when nothing was derived
 * locally), and finally ESPN's global `all` slug as the last resort.
 */
async function espnSummarySlugsFor(match: EspnMatchRef): Promise<string[]> {
  const slugs = espnSlugCandidates(match);
  if (slugs.length === 0) {
    const recovered = await recoverLeagueSlugFromScoreboard(match);
    if (recovered) slugs.push(recovered);
  }
  if (!slugs.includes(ESPN_ALL_SLUG)) slugs.push(ESPN_ALL_SLUG);
  return slugs;
}

// ─── ESPN summary fetch + parsing ────────────────────────────────────────────

/** ESPN summary-stat name → canonical per-team stat. */
const ESPN_STAT_KEYS: Record<string, StatKey> = {
  totalShots: "shots",
  shotsOnTarget: "shotsOnTarget",
  wonCorners: "corners",
  yellowCards: "yellowCards",
  redCards: "redCards",
  foulsCommitted: "fouls",
  offsides: "offsides",
  saves: "saves",
  interceptions: "interceptions",
};

/** A final score read out of an ESPN summary payload. */
export interface EspnSummaryResult {
  homeScore: number;
  awayScore: number;
  homeName:  string | null;
  awayName:  string | null;
  /** Exact kickoff (ISO) — feeds the 24h stats-void grace window. */
  kickoffAt: string | null;
  statusDetail: string | null;
}

interface EspnSummaryRead {
  /** The payload really describes a match (competitors or a team boxscore). */
  found: boolean;
  /** ESPN reports the match as finished. */
  final: boolean;
  /** Broadcast state ("pre" | "in" | "post") when the payload supplies it. */
  state: string | null;
  /** Set only for a finished match with both scores readable. */
  result: EspnSummaryResult | null;
}

function espnSummaryScore(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const score = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(score) && score >= 0 ? score : null;
}

function pickBySide<T extends { homeAway?: string }>(entries: T[], side: "home" | "away", index: number): T | undefined {
  return entries.find((entry) => entry.homeAway === side) ?? entries[index];
}

/**
 * Read the score out of an ESPN summary payload:
 *   · header.competitions[0].competitors → `score` for home and away (the
 *     match header ESPN renders at the top of the page), then
 *   · boxscore.teams[].score when the header omits the scores.
 * A payload that is not a finished match yields `found`/`final` flags instead
 * of a result, so the caller can tell "wrong league/unknown event" apart from
 * "known event, not finished yet".
 */
export function readEspnSummary(data: EspnSummaryLite | null | undefined): EspnSummaryRead {
  const competition = data?.header?.competitions?.[0];
  const competitors = competition?.competitors ?? [];
  const boxTeams = data?.boxscore?.teams ?? [];
  if (competitors.length < 2 && boxTeams.length < 2) {
    return { found: false, final: false, state: null, result: null };
  }

  const status = competition?.status?.type;
  const state = status?.state ?? null;
  const final = state === "post" || status?.completed === true;

  const homeCompetitor = pickBySide(competitors, "home", 0);
  const awayCompetitor = pickBySide(competitors, "away", 1);
  const homeBox = pickBySide(boxTeams, "home", 0);
  const awayBox = pickBySide(boxTeams, "away", 1);

  // 1) header.competitions[0].competitors → score fields …
  let homeScore = espnSummaryScore(homeCompetitor?.score);
  let awayScore = espnSummaryScore(awayCompetitor?.score);
  // 2) … with boxscore.teams[].score as the fallback for either side.
  if (homeScore === null) homeScore = espnSummaryScore(homeBox?.score);
  if (awayScore === null) awayScore = espnSummaryScore(awayBox?.score);

  const kickoffAt = competition?.date && !Number.isNaN(Date.parse(competition.date))
    ? competition.date
    : null;
  const result = final && homeScore !== null && awayScore !== null
    ? {
        homeScore,
        awayScore,
        homeName: homeCompetitor?.team?.displayName ?? homeBox?.team?.displayName ?? null,
        awayName: awayCompetitor?.team?.displayName ?? awayBox?.team?.displayName ?? null,
        kickoffAt,
        statusDetail: status?.shortDetail ?? status?.detail ?? null,
      }
    : null;

  return { found: true, final, state, result };
}

interface EspnSummaryHit { slug: string; data: EspnSummaryLite }
interface EspnSummaryEntry { hit: EspnSummaryHit | null; expires: number }

// A finished match never changes; an unfinished one (or a miss) is retried
// shortly so a live → final transition is picked up by the next sweep.
const ESPN_SUMMARY_HIT_TTL_MS  = 30 * 60_000;
const ESPN_SUMMARY_MISS_TTL_MS = 5 * 60_000;

const espnSummaryMemo = new Map<string, EspnSummaryEntry>();
const espnSummaryInflight = new Map<string, Promise<EspnSummaryHit | null>>();

/**
 * Fetch the ESPN summary payload for an event, walking the derived league-slug
 * candidates in order and stopping at the first payload that actually
 * describes the match. Memoised per event (and coalesced), so the result pass
 * and the boxscore pass share ONE network round trip per match.
 */
async function espnSummaryFor(eventId: string, slugs: string[]): Promise<EspnSummaryHit | null> {
  const memo = espnSummaryMemo.get(eventId);
  if (memo && Date.now() < memo.expires) return memo.hit;
  const inflight = espnSummaryInflight.get(eventId);
  if (inflight) return inflight;

  const pending = (async (): Promise<EspnSummaryHit | null> => {
    for (const slug of slugs) {
      let data: EspnSummaryLite | null = null;
      try {
        data = await resilientJson<EspnSummaryLite>(
          `${ESPN_SUMMARY_BASE}/${slug}/summary?event=${eventId}`,
          { revalidate: 600 },
        );
      } catch {
        data = null; // fail-soft — the next candidate (or the scoreboard) can still answer
      }
      if (data && readEspnSummary(data).found) return { slug, data };
    }
    return null;
  })()
    .then((hit) => {
      const finished = hit ? readEspnSummary(hit.data).final : false;
      espnSummaryMemo.set(eventId, {
        hit,
        expires: Date.now() + (finished ? ESPN_SUMMARY_HIT_TTL_MS : ESPN_SUMMARY_MISS_TTL_MS),
      });
      return hit;
    })
    .finally(() => espnSummaryInflight.delete(eventId));

  espnSummaryInflight.set(eventId, pending);
  return pending;
}

// ─── ESPN boxscore stats (fills whatever the registered chain left null) ─────

async function fetchEspnBoxscoreStats(
  result: MatchResult,
): Promise<{ home: Partial<Record<StatKey, number>>; away: Partial<Record<StatKey, number>> } | null> {
  // ESPN event ids are bare numerics; provider-namespaced ids have no ESPN summary.
  if (!isEspnEventId(result.eventId)) return null;
  const hit = await espnSummaryFor(result.eventId, await espnSummarySlugsFor(result));
  const teams = hit?.data?.boxscore?.teams;
  if (!Array.isArray(teams) || teams.length < 2) return null;
  const parse = (stats: EspnStatEntry[] | undefined): Partial<Record<StatKey, number>> => {
    const partial: Partial<Record<StatKey, number>> = {};
    for (const entry of stats ?? []) {
      const field = entry?.name ? ESPN_STAT_KEYS[entry.name] : undefined;
      if (!field) continue;
      const value = Number.parseFloat(entry?.displayValue ?? "");
      if (Number.isFinite(value)) partial[field] = value;
    }
    return partial;
  };
  const home = parse(pickBySide(teams, "home", 0)?.statistics);
  const away = parse(pickBySide(teams, "away", 1)?.statistics);
  if (Object.keys(home).length === 0 && Object.keys(away).length === 0) return null;
  return { home, away };
}

/** Fill null stat fields of `stats` (or build fresh stats when null) from the
 *  ESPN boxscore. Returns the merged object + how many fields ESPN supplied. */
function fillGapsFromEspn(
  stats: CanonicalMatchStats | null,
  espn: { home: Partial<Record<StatKey, number>>; away: Partial<Record<StatKey, number>> },
  match: Parameters<typeof emptyCanonicalMatchStats>[0],
): { merged: CanonicalMatchStats; filled: number } {
  const base = stats ?? emptyCanonicalMatchStats(match);
  const home: TeamStats = { ...base.home };
  const away: TeamStats = { ...base.away };
  const homeWrite = home as Record<StatKey, number | null>;
  const awayWrite = away as Record<StatKey, number | null>;
  let filled = 0;
  for (const field of STAT_FIELDS) {
    if (homeWrite[field] === null && espn.home[field] !== undefined) { homeWrite[field] = espn.home[field]!; filled++; }
    if (awayWrite[field] === null && espn.away[field] !== undefined) { awayWrite[field] = espn.away[field]!; filled++; }
  }
  if (filled === 0 && stats) return { merged: stats, filled: 0 };
  return { merged: { ...base, home, away }, filled };
}

async function fetchBoxscore(result: MatchResult, key: string): Promise<BoxscoreOutcome> {
  const label = `${result.homeName} vs ${result.awayName}`;
  const query = {
    leagueSlug: result.leagueSlug,
    eventId: result.eventId,
    homeTeam: result.homeName,
    awayTeam: result.awayName,
    date: result.date,
    // Settlement only ever asks for finished matches: per-match stats, and
    // the state-scoped key so it hits the entry the daily-picks cron warmed.
    state: "post" as const,
  };

  let stats: CanonicalMatchStats | null = null;
  try {
    stats = statsAggregator.peek(query) ?? (await statsAggregator.fetch(query).catch(() => null));
  } catch {
    stats = null; // fail-soft — a broken aggregator never blocks a settlement run
  }

  // Try every remaining source for the stats settlement needs: ESPN's own
  // boxscore endpoint fills whatever the registered-source chain left null.
  let espnFilled = 0;
  try {
    const espn = await fetchEspnBoxscoreStats(result);
    if (espn) {
      const merged = fillGapsFromEspn(stats, espn, query);
      stats = merged.merged;
      espnFilled = merged.filled;
    }
  } catch {
    // fail-soft — the ESPN boxscore is a supplement, never a hard dependency
  }

  const primarySource = stats?.metadata?.source ?? null;
  const sourceLabel = stats
    ? (espnFilled > 0
        ? (primarySource && primarySource !== "unknown" ? `${primarySource} +ESPN boxscore` : "ESPN boxscore")
        : primarySource)
    : null;
  const outcome: BoxscoreOutcome = { stats, source: sourceLabel, cached: false };
  if (stats) {
    const t = boxscoreTotals(stats);
    console.log(
      `[Settle] ${label} — boxscore from ${outcome.source ?? "unknown source"} ` +
      `(corners ${t.corners}, cards ${t.cards}, shots ${t.shots}).`,
    );
  } else {
    console.log(
      `[Settle] ${label} — boxscore unavailable: no registered source has the stats. ` +
      `Markets stay PENDING until the 24h grace elapses, then VOID (stake returned).`,
    );
  }

  boxscoreMemo.set(key, {
    outcome,
    expires: Date.now() + (stats ? BOXSCORE_HIT_TTL_MS : BOXSCORE_MISS_TTL_MS),
  });
  return outcome;
}

/**
 * Warm the boxscore memo for a batch of finished matches (bounded concurrency)
 * so a single settlement run fetches each match's stats once and every leg
 * evaluation afterwards is a cache read. Returns [withStats, withoutStats].
 */
export async function prefetchBoxscores(
  results: MatchResult[],
  concurrency = 6,
): Promise<{ withStats: number; withoutStats: number }> {
  // One warm-up per distinct match — provider lists may repeat a fixture
  // across overlapping scoreboard windows.
  const byKey = new Map<string, MatchResult>();
  for (const r of results) byKey.set(`${r.leagueSlug}|${r.eventId}`, r);
  const queue = [...byKey.values()];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await getSettlementBoxscore(next);
    }
  });
  await Promise.all(workers);

  let withStats = 0;
  for (const key of byKey.keys()) {
    if (boxscoreMemo.get(key)?.outcome.stats) withStats++;
  }
  return { withStats, withoutStats: byKey.size - withStats };
}

// ─── Result lookup: ESPN summary first, scoreboard as the fallback ───────────

/** How many summary lookups run at once (bounded concurrency, fail-soft). */
const RESULT_PROBE_CONCURRENCY = 4;

/** `Bayern Munich vs Bodo/Glimt` → the two team names (empty when unparseable). */
function labelTeams(label?: string | null): { home: string; away: string } {
  const parts = (label ?? "").split(/\s+vs\.?\s+/i).map((part) => part.trim());
  return { home: parts[0] ?? "", away: parts[1] ?? "" };
}

/**
 * Resolve one pending match from the ESPN summary endpoint. Returns true when
 * a finished result was registered. Logs which source answered (and why not,
 * when the summary had nothing) so a settlement run is diagnosable line by
 * line:
 *   [Settle] Fetching result for Bayern Munich vs Bodo/Glimt (event 401915443, league uefa.champions)
 *   [Settle] ESPN summary returned: home 3, away 1
 *   [Settle] ESPN summary empty for event 401915443 — trying next source
 */
async function resolveProbeFromSummary(provider: ResultsProvider, probe: ResultProbe): Promise<boolean> {
  const slugs = await espnSummarySlugsFor(probe);
  const label = (probe.matchLabel ?? "").trim() || `event ${probe.eventId}`;
  console.log(`[Settle] Fetching result for ${label} (event ${probe.eventId}, league ${slugs[0]})`);

  const hit = await espnSummaryFor(probe.eventId, slugs);
  const read = hit ? readEspnSummary(hit.data) : null;
  if (!read?.result) {
    console.log(read?.found && !read.final
      ? `[Settle] ESPN summary for event ${probe.eventId} is not finished yet (state ${read.state ?? "unknown"}) — trying next source`
      : `[Settle] ESPN summary empty for event ${probe.eventId} — trying next source`);
    return false;
  }

  const fallback = labelTeams(probe.matchLabel);
  const homeName = read.result.homeName ?? (fallback.home || `Home (${probe.eventId})`);
  const awayName = read.result.awayName ?? (fallback.away || `Away (${probe.eventId})`);
  provider.addResult({
    eventId: probe.eventId,
    // The slug that actually answered — so the boxscore fetch (and any later
    // log line) uses the competition the fixture really belongs to.
    leagueSlug: hit?.slug ?? probe.leagueSlug ?? canonicalLeagueSlug(slugs[0] ?? ESPN_ALL_SLUG),
    date: (read.result.kickoffAt ?? probe.date ?? "").slice(0, 10),
    kickoffAt: read.result.kickoffAt ?? undefined,
    homeName,
    awayName,
    homeScore: read.result.homeScore,
    awayScore: read.result.awayScore,
  }, "espn-summary", probe.matchLabel ? [probe.matchLabel] : []);
  console.log(`[Settle] ESPN summary returned: home ${read.result.homeScore}, away ${read.result.awayScore}`);
  return true;
}

/**
 * Resolve every pending match from the ESPN summary endpoint first (bounded
 * concurrency). Rows sharing an event id are probed once — collectResultProbes
 * dedupes, and the summary payload itself is memoised per event.
 */
async function resolveProbesFromEspn(provider: ResultsProvider, probes: ResultProbe[]): Promise<number> {
  const queue = [...probes];
  let resolved = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(RESULT_PROBE_CONCURRENCY, queue.length)) },
    async () => {
      for (;;) {
        const probe = queue.shift();
        if (!probe) return;
        if (await resolveProbeFromSummary(provider, probe)) resolved++;
      }
    },
  );
  await Promise.all(workers);
  return resolved;
}

/**
 * Build the settlement result index.
 *
 * 1. ESPN summary FIRST, per pending match — keyed by the event id and asked
 *    under the league slug derived from the match, this is the source that
 *    resolves a fixture the scoreboard feed cannot see.
 * 2. Scoreboard fallback for everything the summary did not return (rows
 *    without an ESPN event id are matched on their "Home vs Away" label).
 *    The summary always wins when both know the same event.
 */
export async function fetchSettlementResults(queues: SettlementQueues): Promise<ResultsProvider> {
  const provider = new ResultsProvider();

  await resolveProbesFromEspn(provider, collectResultProbes(queues));

  const requests = collectResultRequests(queues);
  const responses = await Promise.allSettled(
    requests.map(({ leagueSlug, date }) => fetchScoreboard(leagueSlug, date)),
  );
  for (const response of responses) {
    if (response.status === "fulfilled") response.value.forEach((fixture) => provider.add(fixture));
  }

  const { espnSummary, scoreboard } = provider.sourceCounts();
  console.log(
    `[Settle] Results indexed: ${provider.all().length} finished match(es) — ` +
    `${espnSummary} from the ESPN summary endpoint, ${scoreboard} from the scoreboard feed`,
  );
  return provider;
}

export const buildResultsProvider = fetchSettlementResults;
