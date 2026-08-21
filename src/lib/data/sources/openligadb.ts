// ĞIGI GIVØ — OpenLigaDB normaliser (German football, no key).
//
// Endpoint: https://www.openligadb.de/api/getmatchdata/{shortcut}/{season}
// Returns the full season's matches; the normaliser finds the target match by
// team name + date and maps the final score (goals), plus cards / corners when
// the payload happens to carry them (OpenLigaDB's coverage of those is sparse).

import type { SourceHandler } from "./context";
import { asArray, asNumber, asRecord, asString, getPath, namesMatch } from "./shared";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatField } from "../types";

const BASE = "https://www.openligadb.de/api";

const SHORTCUTS: Record<string, string> = {
  "ger.1": "bl1",
  "ger.2": "bl2",
  "ger.3": "bl3",
};

export const OPENLIGADB_CAPABILITIES: StatField[] = [
  "goals", "goalsConceded", "cleanSheet", "yellowCards", "redCards", "corners",
];

function seasonFor(date: string): number {
  const d = new Date(date.length >= 10 ? `${date.slice(0, 10)}T00:00:00Z` : date);
  const year = Number.isFinite(d.getTime()) ? d.getUTCFullYear() : new Date().getUTCFullYear();
  return d.getUTCMonth() + 1 >= 7 ? year : year - 1;
}

export const openligadbSource: SourceHandler = {
  name: "OpenLigaDB",
  capabilities: OPENLIGADB_CAPABILITIES,

  available: (match) => SHORTCUTS[match.leagueSlug] !== undefined,

  async fetch(match, ctx): Promise<SourcePayload | null> {
    const shortcut = SHORTCUTS[match.leagueSlug];
    if (!shortcut) return null;
    const season = seasonFor(match.date);

    const res = await ctx.http(`${BASE}/getmatchdata/${shortcut}/${season}`, {
      timeoutMs: ctx.timeoutMs,
    });
    if (res.status !== "ok") return null;

    for (const m of asArray(res.data)) {
      const rec = asRecord(m);
      const home = asString(getPath(rec, "team1.teamName"));
      const away = asString(getPath(rec, "team2.teamName"));
      if (!home || !away) continue;
      if (!namesMatch(home, match.homeTeam) || !namesMatch(away, match.awayTeam)) continue;
      const date = asString(rec?.matchDateTime);
      if (date && date.slice(0, 10) !== match.date.slice(0, 10)) continue;

      let hs: number | null = null;
      let as: number | null = null;
      for (const r of asArray(rec?.matchResults)) {
        const rr = asRecord(r);
        if (asNumber(rr?.resultTypeID) === 2) {
          hs = asNumber(rr?.pointsTeam1);
          as = asNumber(rr?.pointsTeam2);
        }
      }

      const homeOut: PartialTeamStats = {};
      const awayOut: PartialTeamStats = {};
      if (hs !== null && as !== null) {
        homeOut.goals = hs;
        awayOut.goals = as;
        homeOut.goalsConceded = as;
        awayOut.goalsConceded = hs;
        homeOut.cleanSheet = as === 0;
        awayOut.cleanSheet = hs === 0;
      }

      return { home: homeOut, away: awayOut };
    }
    return null;
  },
};
