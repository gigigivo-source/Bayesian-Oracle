// ĞIGI GIVØ — Understat normaliser (scraped xG for the Big 5 leagues).
//
// Endpoints:
//   · https://understat.com/league/{League}/{season}  — season schedule
//   · https://understat.com/match/{understatMatchId}  — match page
//
// Understat embeds the shot-by-shot xG timeline as `var shotsData = JSON.parse('…')`
// and the team ids as `var teamsData = JSON.parse('…')`. This normaliser only
// ever produces xG, shots and goals (Understat exposes no other stat) —
// everything else stays null.
//
// ─── Match id resolution ────────────────────────────────────────────────────
// Understat uses its OWN numeric match ids; ESPN event ids do not exist there.
// The match id is resolved via the match-page URL pattern:
//   1. fetch the league schedule page for the season (date → season year)
//   2. find the row whose team pair fuzzy-matches homeTeam/awayTeam AND whose
//      DD.MM.YY date matches the query date
//   3. extract the /match/{id} link
// Only Big-5 league matches are queried (Understat only covers them). A
// `understat:{id}` namespaced event id bypasses the lookup.

import type { SourceHandler } from "./context";
import {
  asArray, asNumber, asRecord, asString, namesMatch, normalizeName, roundTo,
} from "./shared";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatKey } from "../types";

const BASE = "https://understat.com";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export const UNDERSTAT_CAPABILITIES: StatKey[] = ["goals", "xg", "xgPerShot"];

/** ESPN slug → Understat league slug (Big 5 only). */
const LEAGUE_SLUGS: Record<string, string> = {
  "eng.1": "EPL",
  "esp.1": "LaLiga",
  "ger.1": "Bundesliga",
  "ita.1": "SerieA",
  "fra.1": "Ligue1",
};

/**
 * Understat short names → normalised full names. Understat labels teams
 * "Man City", "Wolves", "Spurs", "Villa", which the generic namesMatch does
 * not bridge to "Manchester City" / "Wolverhampton" / … .
 */
const TEAM_ALIASES: Record<string, string> = {
  mancity: "manchestercity",
  manutd: "manchesterunited",
  wolves: "wolverhampton",
  spurs: "tottenham",
  villa: "astonvilla",
  newcastle: "newcastleunited",
  inter: "internazionale",
  juve: "juventus",
  psg: "paris",
  barca: "barcelona",
};

function alias(s: string): string {
  const n = normalizeName(s);
  return TEAM_ALIASES[n] ?? n;
}

/** Team-name match with Understat short-name aliases applied to both sides. */
function understatNamesMatch(pageName: string, queryName: string): boolean {
  if (namesMatch(pageName, queryName)) return true;
  const p = alias(pageName);
  const q = alias(queryName);
  if (p.length >= 4 && q.length >= 4 && (p === q || p.startsWith(q) || q.startsWith(p))) return true;
  return false;
}

/** Football season start year for a date (Aug 2026 → 2026, Mar 2026 → 2025). */
function seasonFor(date: string): number {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const year = Number.isFinite(d.getTime()) ? d.getUTCFullYear() : new Date().getUTCFullYear();
  return d.getUTCMonth() + 1 >= 7 ? year : year - 1;
}

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

/**
 * Find the Understat match id in a league schedule page for the team pair +
 * date. Rows look like:
 *   <td>21.08.16</td> <td><a href="/match/17638">Arsenal</a> - <a href="/match/17638">Chelsea</a></td>
 */
export function findUnderstatMatchId(
  scheduleHtml: string,
  match: MatchStatsQuery,
): string | null {
  const date = match.date.slice(0, 10);
  const day = date.slice(8, 10);
  const month = date.slice(5, 7);
  const year2 = date.slice(2, 4);

  const rows = scheduleHtml.split("<tr>").slice(1);
  for (const row of rows) {
    const end = row.indexOf("</tr>");
    const body = end === -1 ? row : row.slice(0, end);
    const idMatch = body.match(/href="\/match\/(\d+)"/);
    if (!idMatch) continue;

    const teamLinks = [...body.matchAll(/<a[^>]*href="\/match\/\d+"[^>]*>([^<]+)<\/a>/g)]
      .map((m) => m[1].trim())
      .filter(Boolean);
    if (teamLinks.length < 2) continue;
    const [h, a] = teamLinks;
    if (!understatNamesMatch(h, match.homeTeam) || !understatNamesMatch(a, match.awayTeam)) continue;

    // Understat dates are DD.MM.YY — verify the day + month + year.
    const dateMatch = body.match(/(\d{2})\.(\d{2})\.(\d{2})/);
    if (dateMatch) {
      if (!(dateMatch[1] === day && dateMatch[2] === month && dateMatch[3] === year2)) continue;
    }
    return idMatch[1];
  }
  return null;
}

export const understatSource: SourceHandler = {
  name: "Understat",
  capabilities: UNDERSTAT_CAPABILITIES,

  // Big-5 top flights only — Understat has no data for any other league.
  available: (match) => /^(eng|esp|ger|ita|fra)\.1$/.test(match.leagueSlug),

  async fetch(match, ctx): Promise<SourcePayload | null> {
    // Resolve the Understat match id. ESPN numeric ids are NOT Understat ids,
    // so only a `understat:{id}` namespaced event id bypasses the schedule
    // lookup (search by date + teams).
    const namespaced = match.eventId.match(/^understat:(\d+)$/i);
    let matchId: string | null = namespaced ? namespaced[1] : null;

    if (!matchId) {
      const leagueSlug = LEAGUE_SLUGS[match.leagueSlug];
      if (!leagueSlug) {
        ctx.log(`[Understat] League ${match.leagueSlug} not in the Big-5 map — skipping.`);
        return null;
      }
      const season = seasonFor(match.date);
      const scheduleUrl = `${BASE}/league/${leagueSlug}/${season}`;
      const sched = await ctx.http(scheduleUrl, {
        timeoutMs: ctx.timeoutMs,
        text: true,
        userAgent: BROWSER_UA,
        headers: { Referer: "https://understat.com/" },
      });
      if (sched.status === "not-found") {
        ctx.log(`[Understat] No ${leagueSlug} ${season} schedule page (404) — skipping.`);
        return null;
      }
      if (sched.status !== "ok" || typeof sched.data !== "string") {
        ctx.log(`[Understat] Schedule lookup failed (${sched.status}) — skipping.`);
        return null;
      }
      matchId = findUnderstatMatchId(sched.data, match);
      if (!matchId) {
        ctx.log(`[Understat] Match not found on schedule for ${match.date.slice(0, 10)} ${match.homeTeam} vs ${match.awayTeam} — skipping.`);
        return null;
      }
      ctx.log(`[Understat] Resolved match id ${matchId} for ${match.homeTeam} vs ${match.awayTeam} (${match.date.slice(0, 10)})`);
    }

    const res = await ctx.http(`${BASE}/match/${matchId}`, {
      timeoutMs: ctx.timeoutMs,
      text: true,
      userAgent: BROWSER_UA,
      headers: { Referer: "https://understat.com/" },
    });
    if (res.status === "not-found") {
      ctx.log(`[Understat] Match page ${matchId} not found (404) — skipping.`);
      return null;
    }
    if (res.status !== "ok" || typeof res.data !== "string") return null;

    const teams = extractJsonVar(res.data, "teamsData") as
      | { h?: { title?: string }; a?: { title?: string } }
      | null;
    const shotsRaw = extractJsonVar(res.data, "shotsData");

    // Verify the fixture (when team names are available).
    const hTitle = asString(teams?.h?.title);
    const aTitle = asString(teams?.a?.title);
    if (hTitle && aTitle && !(understatNamesMatch(hTitle, match.homeTeam) && understatNamesMatch(aTitle, match.awayTeam))) {
      ctx.log(`[Understat] Match page ${matchId} is a different fixture (${hTitle} vs ${aTitle}) — skipping.`);
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
    if (!hasAny) {
      ctx.log(`[Understat] Match ${matchId} page carried no shotsData — skipping.`);
      return null;
    }
    return { home: homeOut, away: awayOut };
  },
};
