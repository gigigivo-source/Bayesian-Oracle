// ĞIGI GIVØ — FBref normaliser (scraped, via sportsdata-mcp or direct fetch).
//
// Match stats:  https://fbref.com/en/matches/{match_id}/   ("Team Stats" table)
// Season avgs:  https://fbref.com/en/comps/{league_id}/    (squad tables)
//
// FBref aggressively blocks datacenter scrapers, so every parse is defensive
// and fail-soft: on any unrecognised markup this source returns null and the
// aggregator moves on. No value is ever guessed.

import type { SourceHandler } from "./context";
import { asNumberLoose, namesMatch, roundTo } from "./shared";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatKey } from "../types";

const BASE = "https://fbref.com/en";

/** ESPN slug → FBref competition id (Big 5 + a few majors). */
const LEAGUE_IDS: Record<string, string> = {
  "eng.1": "9", "esp.1": "12", "ger.1": "20", "ita.1": "11", "fra.1": "13",
  "ned.1": "23", "por.1": "32", "usa.1": "22", "bra.1": "24", "mex.1": "31",
};

export const FBREF_CAPABILITIES: StatKey[] = [
  "xg", "shots", "shotsOnTarget", "corners", "fouls", "possession", "passes",
  "passAccuracy", "tackles", "interceptions", "clearances", "yellowCards",
  "redCards", "saves", "offsides", "aerialBattlesWon", "avgCornersPerGame",
  "avgCardsPerGame",
];

/** Match-stats table row label → canonical field. */
const MATCH_LABELS: Record<string, StatKey> = {
  possession: "possession",
  expectedgoalsxg: "xg",
  xg: "xg",
  shotsontarget: "shotsOnTarget",
  shots: "shots",
  blockedshots: "blockedShots",
  passes: "passes",
  passaccuracy: "passAccuracy",
  tackles: "tackles",
  clearances: "clearances",
  corners: "corners",
  offsides: "offsides",
  fouls: "fouls",
  yellowcards: "yellowCards",
  redcards: "redCards",
  saves: "saves",
  interceptions: "interceptions",
  aerialswon: "aerialBattlesWon",
  successfuldribbles: "dribbling",
};

const normLabel = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Parse the "Team Stats" table from a match page: rows of <th>label</th><td>h</td><td>a</td>. */
export function normaliseFbrefMatchHtml(
  html: string,
  homeName: string,
  awayName: string,
): SourcePayload {
  const home: PartialTeamStats = {};
  const away: PartialTeamStats = {};

  const rowRe = /<tr[^>]*>\s*<th[^>]*>([^<]+)<\/th>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const field = MATCH_LABELS[normLabel(m[1])];
    if (!field) continue;
    const hv = asNumberLoose(m[2]);
    const av = asNumberLoose(m[3]);
    if (hv !== null && home[field] === undefined) home[field] = hv;
    if (av !== null && away[field] === undefined) away[field] = av;
  }

  const hasAny =
    Object.values(home).some((v) => v !== null) ||
    Object.values(away).some((v) => v !== null);
  if (!hasAny) return { home: {}, away: {} };
  void homeName;
  void awayName;
  return { home, away };
}

/** Map FBref `data-stat` codes → (field, isCards). */
const SQUAD_STAT_MAP: Record<string, StatKey> = {
  ck: "avgCornersPerGame",
  cards_yellow: "avgCardsPerGame",
  cards_red: "avgCardsPerGame",
};

/** Parse squad tables for per-game season averages (corners / cards). */
export function normaliseFbrefLeagueHtml(html: string, teamName: string): PartialTeamStats {
  const out: PartialTeamStats = {};
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html)) !== null) {
    const rowHtml = row[1];
    const teamMatch = rowHtml.match(/<th[^>]*data-stat="team"[^>]*>[\s\S]*?>([^<]+)</i);
    if (!teamMatch || !namesMatch(teamMatch[1], teamName)) continue;

    // Games played (denominator for per-game averages).
    const mp = rowHtml.match(/<td[^>]*data-stat="games"[^>]*>([^<]*)</i);
    const games = asNumberLoose(mp?.[1]) ?? 0;
    const denom = Math.max(1, games);

    for (const [code, field] of Object.entries(SQUAD_STAT_MAP)) {
      const cell = rowHtml.match(new RegExp(`<td[^>]*data-stat="${code}"[^>]*>([^<]*)<`, "i"));
      const value = asNumberLoose(cell?.[1]);
      if (value !== null) {
        const perGame = roundTo(value / denom, 2);
        if (field === "avgCardsPerGame") {
          // Sum yellow + red where both columns are present.
          out.avgCardsPerGame = roundTo((out.avgCardsPerGame ?? 0) + perGame, 2);
        } else {
          out[field] = perGame;
        }
      }
    }
    break;
  }
  return out;
}

export const fbrefSource: SourceHandler = {
  name: "FBref",
  capabilities: FBREF_CAPABILITIES,

  available: () => true,

  async fetch(match, ctx): Promise<SourcePayload | null> {
    const namespaced = match.eventId.match(/^fbref:([0-9a-f]+)$/i);
    if (!namespaced) return null; // FBref match ids cannot be derived from ESPN ids
    const matchId = namespaced[1];

    const page = await ctx.http(`${BASE}/matches/${matchId}/`, {
      timeoutMs: ctx.timeoutMs,
      text: true,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    });
    if (page.status !== "ok" || typeof page.data !== "string") return null;

    const payload = normaliseFbrefMatchHtml(page.data, match.homeTeam, match.awayTeam);
    const hasAny =
      Object.values(payload.home).some((v) => v !== null) ||
      Object.values(payload.away).some((v) => v !== null);
    if (!hasAny) return null;

    // Season averages (best-effort) from the league stats page.
    const leagueId = LEAGUE_IDS[match.leagueSlug];
    if (leagueId) {
      const stats = await ctx.http(`${BASE}/comps/${leagueId}/`, {
        timeoutMs: ctx.timeoutMs,
        text: true,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      });
      if (stats.status === "ok" && typeof stats.data === "string") {
        const homeAvg = normaliseFbrefLeagueHtml(stats.data, match.homeTeam);
        const awayAvg = normaliseFbrefLeagueHtml(stats.data, match.awayTeam);
        if (homeAvg.avgCornersPerGame != null) payload.home.avgCornersPerGame = homeAvg.avgCornersPerGame;
        if (awayAvg.avgCornersPerGame != null) payload.away.avgCornersPerGame = awayAvg.avgCornersPerGame;
        if (homeAvg.avgCardsPerGame != null) payload.home.avgCardsPerGame = homeAvg.avgCardsPerGame;
        if (awayAvg.avgCardsPerGame != null) payload.away.avgCardsPerGame = awayAvg.avgCardsPerGame;
      }
    }
    return payload;
  },
};
