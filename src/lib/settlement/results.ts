// ĞIGI GIVØ — Settlement results + boxscore provider.
//
// Two responsibilities:
//   1. Result lookup — pull final scores for every pending row's league/date
//      from the ESPN scoreboard feed and index them by event id and by
//      "Home vs Away" label (in both team orders).
//   2. Boxscore supply — when a match finishes, settlement needs the FULL
//      boxscore (corners, cards, shots, throw-ins …), not just the final
//      score. Every fetch goes through the multi-source stats aggregator,
//      which walks the complete registered source chain in priority order
//      (SportScore/ESPN feed → API-Football /fixtures/statistics → StatsBomb
//      open data → datafc → FBref → TheSportsDB → Understat → OpenLigaDB →
//      Highlightly → GitHubDatasets → …), merges the best values first-wins,
//      and caches successful merges (2h TTL) plus per-source rate-limit
//      cooldowns. On top of that this module keeps its own memo cache so
//      repeated settlement runs never re-fetch:
//        · positive result  → 30 minutes (the aggregator cache already
//                             suppresses the network within its 2h TTL),
//        · partial/negative → 10 minutes, so late-arriving feeds can still
//                             fill the gaps before the 24h void grace elapses.
//      Every cache miss logs which source provided the boxscore:
//        [Settle] Arsenal vs Chelsea — boxscore from API-Football (corners 12, cards 3, shots 18).

import type { PendingAccumulator, PendingDailyPick, PendingValueBet } from "@/db/queries/settlement";
import { fetchScoreboard, type FixtureLite } from "@/lib/espn";
import { statsAggregator } from "@/lib/data/aggregator";
import {
  STAT_FIELDS, emptyCanonicalMatchStats,
  type CanonicalMatchStats, type StatKey, type TeamStats,
} from "@/lib/data/types";
import { resilientJson } from "@/lib/httpClient";
import type { MatchResult } from "./evaluate";

interface ResultRequest { leagueSlug: string; date: string }
interface AccumulatorLeg { fixtureId?: string; eventId?: string; leagueSlug?: string; date?: string; matchDate?: string; matchLabel?: string }

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

export class ResultsProvider {
  private readonly byKey = new Map<string, MatchResult>();
  /** One entry per fixture (the byKey map stores 3 aliases per match). */
  private readonly fixtures: MatchResult[] = [];

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
    // Overlapping scoreboard windows (daily-pick ranges + exact bet dates)
    // return the same fixture repeatedly — keep exactly one entry per match
    // so prefetch (and its fetch budget) never double-counts a fixture.
    if (this.byKey.has(result.eventId)) return;
    this.fixtures.push(result);
    this.byKey.set(result.eventId, result);
    this.byKey.set(resultKey(`${result.homeName} vs ${result.awayName}`), result);
    this.byKey.set(resultKey(`${result.awayName} vs ${result.homeName}`), {
      ...result, homeName: result.awayName, awayName: result.homeName,
      homeScore: result.awayScore, awayScore: result.homeScore,
    });
  }

  find(eventId?: string | null, matchLabel?: string | null): MatchResult | undefined {
    return (eventId ? this.byKey.get(eventId) : undefined) ??
      (matchLabel ? this.byKey.get(resultKey(matchLabel)) : undefined);
  }

  /** The distinct finished matches this provider knows about. */
  all(): MatchResult[] {
    return [...this.fixtures];
  }

  get size(): number { return this.byKey.size; }
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

/** Drop the settlement boxscore memo (tests / forced re-sweeps). */
export function clearSettlementBoxscoreCache(): void {
  boxscoreMemo.clear();
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
 * across every registered provider in priority order. Fail-soft: a throwing
 * provider chain yields null (markets stay PENDING until the 24h grace, then
 * VOID) — settlement never crashes on a broken source.
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

// ─── ESPN boxscore endpoint (priority-1 source for settlement stats) ─────────
//
// The aggregator chain already carries ESPN-family feeds via SportScore, but
// ESPN's own per-match summary/boxscore is a separate, key-free, extremely
// reliable source for exactly the fields settlement needs (corners, cards,
// shots, SOT, saves, fouls, offsides, interceptions). Settlement asks it for
// any field the registered-source walk left null — ESPN only ever FILLS
// gaps, never overwrites a higher-priority source's value.

interface EspnStatEntry { name?: string; displayValue?: string }
interface EspnSummaryLite { boxscore?: { teams?: Array<{ statistics?: EspnStatEntry[] }> } }

const ESPN_SUMMARY_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

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

async function fetchEspnBoxscoreStats(
  result: MatchResult,
): Promise<{ home: Partial<Record<StatKey, number>>; away: Partial<Record<StatKey, number>> } | null> {
  // ESPN event ids are bare numerics; provider-namespaced ids have no ESPN summary.
  if (!result.leagueSlug || result.leagueSlug.includes(":") || result.eventId.includes(":")) return null;
  const data = await resilientJson<EspnSummaryLite>(
    `${ESPN_SUMMARY_BASE}/${result.leagueSlug}/summary?event=${result.eventId}`,
    { revalidate: 600 },
  ).catch(() => null);
  const teams = data?.boxscore?.teams;
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
  const home = parse(teams[0]?.statistics);
  const away = parse(teams[1]?.statistics);
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

export async function fetchSettlementResults(queues: SettlementQueues): Promise<ResultsProvider> {
  const requests = collectResultRequests(queues);
  const responses = await Promise.allSettled(
    requests.map(({ leagueSlug, date }) => fetchScoreboard(leagueSlug, date)),
  );
  const provider = new ResultsProvider();
  for (const response of responses) {
    if (response.status === "fulfilled") response.value.forEach((fixture) => provider.add(fixture));
  }
  return provider;
}

export const buildResultsProvider = fetchSettlementResults;
