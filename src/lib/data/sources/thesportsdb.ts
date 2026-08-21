// ĞIGI GIVØ — TheSportsDB normaliser (free tier key).
//
// Endpoint: https://www.thesportsdb.com/api/v1/json/{key}/events.php?id={eventId}
// Key:      THESPORTSDB_KEY via env (default public test key "3").
//
// Maps goals and any per-event stat fields the payload carries (shots, corners,
// cards, fouls, saves). TheSportsDB's event objects are sparse, so most of
// those stay null — never fabricated.

import type { SourceHandler } from "./context";
import { asArray, asNumber, asNumberLoose, asRecord, asString, namesMatch } from "./shared";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatField, StatKey } from "../types";

const BASE = "https://www.thesportsdb.com/api/v1/json";

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

export const thesportsdbSource: SourceHandler = {
  name: "TheSportsDB",
  capabilities: THESPORTSDB_CAPABILITIES,

  available: (_match, ctx) => {
    const key = ctx.env("THESPORTSDB_KEY");
    return key.length > 0;
  },

  async fetch(match, ctx): Promise<SourcePayload | null> {
    const key = ctx.env("THESPORTSDB_KEY");
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
        for (const ev of asArray(asRecord(search.data)?.event)) {
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
    if (!eventId) return null;

    const res = await ctx.http(`${base}/events.php?id=${encodeURIComponent(eventId)}`, {
      timeoutMs: ctx.timeoutMs,
    });
    if (res.status !== "ok") return null;
    const ev = asRecord(asArray(asRecord(res.data)?.event)[0]);
    if (!ev) return null;

    const homeName = asString(ev.strHomeTeam);
    const awayName = asString(ev.strAwayTeam);
    if (homeName && awayName && !(namesMatch(homeName, match.homeTeam) && namesMatch(awayName, match.awayTeam))) {
      return null;
    }

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

    for (const [key, field] of Object.entries(PREFIX_MAP)) {
      const value = asNumberLoose(ev[key]);
      if (value === null) continue;
      if (key.startsWith("intHome")) home[field] = value;
      else away[field] = value;
    }

    const hasAny =
      Object.values(home).some((v) => v !== null) ||
      Object.values(away).some((v) => v !== null);
    return hasAny ? { home, away } : null;
  },
};
