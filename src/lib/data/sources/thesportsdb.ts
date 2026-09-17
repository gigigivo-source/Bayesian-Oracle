// ĞIGI GIVØ — TheSportsDB normaliser (free tier key).
//
// Endpoints (https://www.thesportsdb.com/api/v1/json/{key}):
//   · lookupevent.php?id={eventId}  — single event → {events:[{strHomeTeam,
//     strAwayTeam, intHomeScore, intAwayScore, …}]} (PLURAL "events").
//   · eventsday.php?d={YYYY-MM-DD}&s=Soccer — match-day search →
//     {event:[{…}]} (SINGULAR "event" — same shape the fixtures route parses).
//   · searchteams.php?t={name} — team resolution → {teams:[{idTeam, idESPN,
//     strTeam, …}]} (SAME endpoint + params as dataMesh.ts tsdbResolve).
//   · eventslast.php?id={teamId} — last results per team →
//     {results:[{strHomeTeam, strAwayTeam, intHomeScore, intAwayScore, …}]}
//     (SAME endpoint + field paths as oracle.ts fetchTheSportsDb).
//
// BUG FIXED 2026-09-17: the old normaliser called `events.php?id=`, which
// does not exist (HTTP 404 — verified live), and parsed the single-event
// response as `.event` (singular) where the real `lookupevent.php` returns
// `.events` (plural). Every lookup therefore failed or normalised nothing,
// while dataMesh.ts queried the SAME api for the SAME team names via
// `searchteams.php` and got real data. The normaliser now mirrors the
// working reference: lookupevent for finished matches, searchteams +
// eventslast (last-5 goal averages) as the pre-match fallback.
//
// Key: THESPORTSDB_KEY via env. When unset, the handler falls back to the
// public free test key "3" (rate-limited) and logs it once so the
// free-tier behaviour is visible in the trace. Sign up for a free
// key at https://www.thesportsdb.com/api.php and set
// THESPORTSDB_KEY in .env.local to lift the rate limit.
//
// Maps goals and any per-event stat fields the payload carries (shots, corners,
// cards, fouls, saves). TheSportsDB's event objects are sparse, so most of
// those stay null — never fabricated. For pre-match fixtures (no scores yet)
// the eventslast fallback contributes last-5 per-match goal averages,
// consistent with the other sources' pre-match historical paths.

import type { SourceContext, SourceHandler } from "./context";
import { asArray, asNumber, asNumberLoose, asRecord, asString, namesMatch, roundTo } from "./shared";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatField, StatKey } from "../types";

const BASE = "https://www.thesportsdb.com/api/v1/json";

/** Public free test key — used when THESPORTSDB_KEY is not set. Rate-limited. */
export const FREE_TEST_KEY = "3";

let freeKeyNoticeLogged = false;

function resolveKey(ctx: { env: (name: string) => string; log: (m: string) => void }): string {
  const key = ctx.env("THESPORTSDB_KEY");
  if (key) return key;
  if (!freeKeyNoticeLogged) {
    freeKeyNoticeLogged = true;
    ctx.log("[TheSportsDB] Using free test key (rate-limited). Set THESPORTSDB_KEY in .env.local (free signup: https://www.thesportsdb.com/api.php) to lift the limit.");
  }
  return FREE_TEST_KEY;
}

/** Reset the free-key notice (tests). */
export function resetTheSportsDbNotice(): void {
  freeKeyNoticeLogged = false;
}

export const THESPORTSDB_CAPABILITIES: StatField[] = [
  "goals", "goalsConceded", "cleanSheet", "shots", "corners", "yellowCards",
  "redCards", "fouls", "saves",
];

/** TheSportsDB event stat field prefixes → canonical field. */
const PREFIX_MAP: Record<string, StatKey> = {
  intHomeShots: "shots",
  intAwayShots: "shots",
  intHomeCorners: "corners",
  intAwayCorners: "corners",
  intHomeYellowCards: "yellowCards",
  intAwayYellowCards: "yellowCards",
  intHomeRedCards: "redCards",
  intAwayRedCards: "redCards",
  intHomeFouls: "fouls",
  intAwayFouls: "fouls",
  intHomeSaves: "saves",
  intAwaySaves: "saves",
};

/**
 * Event rows from either list shape: eventsday answers {event:[…]}
 * (singular) while lookupevent answers {events:[…]} (plural). Accept both so
 * a shape drift on either endpoint degrades to zero rows, never a crash.
 */
function eventRows(data: unknown): unknown[] {
  const rec = asRecord(data);
  if (!rec) return [];
  const singular = asArray(rec.event);
  if (singular.length) return singular;
  return asArray(rec.events);
}

/**
 * Resolve a team name to its TheSportsDB id.
 * Same endpoint + params as dataMesh.ts tsdbResolve
 * (searchteams.php?t={name} → teams[].{idTeam,strTeam}); the fuzzy match on
 * strTeam guards against taking the wrong club when the search returns
 * several candidates.
 */
async function resolveTeamId(
  teamName: string,
  base: string,
  ctx: SourceContext,
): Promise<string | null> {
  const res = await ctx.http(`${base}/searchteams.php?t=${encodeURIComponent(teamName)}`, {
    timeoutMs: ctx.timeoutMs,
  });
  if (res.status !== "ok") return null;
  const teams = asArray(asRecord(res.data)?.teams);
  for (const t of teams) {
    const rec = asRecord(t);
    const name = asString(rec?.strTeam);
    const id = asString(rec?.idTeam);
    if (name && id && namesMatch(name, teamName)) return id;
  }
  // No fuzzy hit — fall back to the first result exactly like dataMesh.ts.
  return asString(asRecord(teams[0])?.idTeam);
}

interface PastEvent {
  home: string;
  away: string;
  hs: number;
  as: number;
}

/**
 * Last finished results for a team id.
 * Same endpoint + field paths as oracle.ts fetchTheSportsDb
 * (eventslast.php?id= → results[].{strHomeTeam,strAwayTeam,
 * intHomeScore,intAwayScore}); unplayed fixtures (null scores) are skipped.
 */
async function lastEvents(
  teamId: string,
  base: string,
  ctx: SourceContext,
): Promise<PastEvent[]> {
  const res = await ctx.http(`${base}/eventslast.php?id=${encodeURIComponent(teamId)}`, {
    timeoutMs: ctx.timeoutMs,
  });
  if (res.status !== "ok") return [];
  const out: PastEvent[] = [];
  for (const e of asArray(asRecord(res.data)?.results)) {
    const rec = asRecord(e);
    const hs = asNumber(rec?.intHomeScore);
    const as = asNumber(rec?.intAwayScore);
    const home = asString(rec?.strHomeTeam) ?? "";
    const away = asString(rec?.strAwayTeam) ?? "";
    if (hs === null || as === null || !home || !away) continue;
    out.push({ home, away, hs, as });
  }
  return out;
}

/** Last-5 per-match averages (scored / conceded) for one team. Null when the team has no usable results. */
function avgGoals(team: string, events: PastEvent[]): { scored: number; conceded: number } | null {
  const own = events
    .filter((m) => namesMatch(m.home, team) || namesMatch(m.away, team))
    .slice(-5);
  if (!own.length) return null;
  let gf = 0;
  let ga = 0;
  for (const m of own) {
    const isHome = namesMatch(m.home, team);
    gf += isHome ? m.hs : m.as;
    ga += isHome ? m.as : m.hs;
  }
  return { scored: roundTo(gf / own.length, 2), conceded: roundTo(ga / own.length, 2) };
}

function hasAnyStats(home: PartialTeamStats, away: PartialTeamStats): boolean {
  return (
    Object.values(home).some((v) => v !== null && v !== undefined) ||
    Object.values(away).some((v) => v !== null && v !== undefined)
  );
}

export const thesportsdbSource: SourceHandler = {
  name: "TheSportsDB",
  capabilities: THESPORTSDB_CAPABILITIES,

  // Always applicable: the public free test key "3" is the documented default
  // when THESPORTSDB_KEY is unset, so this source is never skipped for a
  // missing key (it may be rate-limited, but that is a backoff, not a skip).
  available: () => true,

  async fetch(match, ctx): Promise<SourcePayload | null> {
    const key = resolveKey(ctx);
    const base = `${BASE}/${key}`;

    let eventId: string | null = null;
    const namespaced = match.eventId.match(/^tsdb:(\d+)$/i);
    if (namespaced) {
      eventId = namespaced[1];
    }

    if (!eventId) {
      // Search by date + team pair.
      const day = match.date.slice(0, 10);
      const search = await ctx.http(`${base}/eventsday.php?d=${day}&s=Soccer`, {
        timeoutMs: ctx.timeoutMs,
      });
      if (search.status === "ok") {
        for (const ev of eventRows(search.data)) {
          const rec = asRecord(ev);
          const home = asString(rec?.strHomeTeam);
          const away = asString(rec?.strAwayTeam);
          if (home && away && namesMatch(home, match.homeTeam) && namesMatch(away, match.awayTeam)) {
            eventId = asString(rec?.idEvent);
            break;
          }
        }
      }
    }

    if (eventId) {
      const res = await ctx.http(`${base}/lookupevent.php?id=${encodeURIComponent(eventId)}`, {
        timeoutMs: ctx.timeoutMs,
      });
      if (res.status === "ok") {
        const ev = asRecord(eventRows(res.data)[0]);
        if (ev) {
          const homeName = asString(ev.strHomeTeam);
          const awayName = asString(ev.strAwayTeam);
          const namesOk =
            !homeName || !awayName || (namesMatch(homeName, match.homeTeam) && namesMatch(awayName, match.awayTeam));
          if (namesOk) {
            const hs = asNumber(ev.intHomeScore);
            const as2 = asNumber(ev.intAwayScore);
            const home: PartialTeamStats = {};
            const away: PartialTeamStats = {};
            if (hs !== null && as2 !== null) {
              home.goals = hs;
              away.goals = as2;
              home.goalsConceded = as2;
              away.goalsConceded = hs;
              home.cleanSheet = as2 === 0;
              away.cleanSheet = hs === 0;
            }

            for (const [k, field] of Object.entries(PREFIX_MAP)) {
              const value = asNumberLoose(ev[k]);
              if (value === null) continue;
              if (k.startsWith("intHome")) home[field] = value;
              else away[field] = value;
            }

            if (hasAnyStats(home, away)) return { home, away };
            ctx.log(`[TheSportsDB] Event ${eventId} has no usable fields yet (pre-match scores are null) — trying the eventslast fallback.`);
          }
        }
      }
    }

    // Pre-match / unresolved fallback: last-5 goal averages per team via
    // searchteams + eventslast — the same endpoints dataMesh.ts and oracle.ts
    // use successfully. Per-match AVERAGES are the correct pre-match model
    // inputs (cf. the other sources' historical paths).
    const [homeId, awayId] = await Promise.all([
      resolveTeamId(match.homeTeam, base, ctx),
      resolveTeamId(match.awayTeam, base, ctx),
    ]);
    if (!homeId && !awayId) return null;

    const [homeEvents, awayEvents] = await Promise.all([
      homeId ? lastEvents(homeId, base, ctx) : Promise.resolve([]),
      awayId ? lastEvents(awayId, base, ctx) : Promise.resolve([]),
    ]);
    const homeAvg = homeId ? avgGoals(match.homeTeam, homeEvents) : null;
    const awayAvg = awayId ? avgGoals(match.awayTeam, awayEvents) : null;
    if (!homeAvg && !awayAvg) return null;

    const home: PartialTeamStats = {};
    const away: PartialTeamStats = {};
    if (homeAvg) {
      home.goals = homeAvg.scored;
      home.goalsConceded = homeAvg.conceded;
    }
    if (awayAvg) {
      away.goals = awayAvg.scored;
      away.goalsConceded = awayAvg.conceded;
    }
    ctx.log(
      `[TheSportsDB] Pre-match fallback (eventslast last-5): ${match.homeTeam} ` +
        `${homeAvg ? `${homeAvg.scored}/${homeAvg.conceded}` : "n/a"} · ${match.awayTeam} ` +
        `${awayAvg ? `${awayAvg.scored}/${awayAvg.conceded}` : "n/a"} (scored/conceded per match).`,
    );
    return { home, away };
  },
};
