// ĞIGI GIVØ — Understat normaliser (scraped xG for the Big 5 leagues).
//
// Endpoint: https://understat.com/match/{eventId}
// Understat embeds the shot-by-shot xG timeline as `var shotsData = JSON.parse('…')`
// and the team ids as `var teamsData = JSON.parse('…')`. This normaliser only
// ever produces xG and goals (Understat exposes no other stat) — everything
// else stays null.

import type { SourceHandler } from "./context";
import { asArray, asNumber, asRecord, asString, namesMatch, roundTo } from "./shared";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatKey } from "../types";

const BASE = "https://understat.com";

export const UNDERSTAT_CAPABILITIES: StatKey[] = ["goals", "xg", "xgPerShot"];

/** Extract the JSON payload of `var NAME = JSON.parse('…')` from an HTML page. */
function extractJsonVar(html: string, name: string): unknown | null {
  const re = new RegExp(`var\\s+${name}\\s*=\\s*JSON\\.parse\\('(.*?)'\\)`, "s");
  const m = html.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\"));
  } catch {
    return null;
  }
}

interface UnderstatShot {
  h_a?: string;         // "h" | "a"
  xG?: number;
  result?: string;
  shotType?: string;
}

export const understatSource: SourceHandler = {
  name: "Understat",
  capabilities: UNDERSTAT_CAPABILITIES,

  available: (match, _ctx) => /^(eng|esp|ger|ita|fra)\.1$/.test(match.leagueSlug),

  async fetch(match, ctx): Promise<SourcePayload | null> {
    // Understat match ids are numeric and league-specific. Only attempt when
    // the event id looks like an Understat id (plain numeric, no namespace).
    if (!/^\d+$/.test(match.eventId)) return null;

    const res = await ctx.http(`${BASE}/match/${match.eventId}`, {
      timeoutMs: ctx.timeoutMs,
      text: true,
    });
    if (res.status !== "ok" || typeof res.data !== "string") return null;

    const teams = extractJsonVar(res.data, "teamsData") as
      | { h?: { title?: string }; a?: { title?: string } }
      | null;
    const shotsRaw = extractJsonVar(res.data, "shotsData");

    // Verify the fixture (when team names are available).
    const hTitle = asString(teams?.h?.title);
    const aTitle = asString(teams?.a?.title);
    if (hTitle && aTitle && !(namesMatch(hTitle, match.homeTeam) && namesMatch(aTitle, match.awayTeam))) {
      return null;
    }

    const shots = asArray(shotsRaw) as UnderstatShot[];
    const home = { goals: 0, xg: 0, shots: 0 };
    const away = { goals: 0, xg: 0, shots: 0 };
    for (const s of shots) {
      const side = s.h_a === "h" ? home : s.h_a === "a" ? away : null;
      if (!side) continue;
      side.shots++;
      side.xg += asNumber(s.xG) ?? 0;
      if (s.result === "Goal") side.goals++;
    }

    const homeOut: PartialTeamStats = {
      goals: home.goals,
      xg: roundTo(home.xg, 2),
      xgPerShot: home.shots > 0 ? roundTo(home.xg / home.shots, 3) : null,
      shots: home.shots,
    };
    const awayOut: PartialTeamStats = {
      goals: away.goals,
      xg: roundTo(away.xg, 2),
      xgPerShot: away.shots > 0 ? roundTo(away.xg / away.shots, 3) : null,
      shots: away.shots,
    };

    const hasAny = home.shots > 0 || away.shots > 0;
    return hasAny ? { home: homeOut, away: awayOut } : null;
  },
};
