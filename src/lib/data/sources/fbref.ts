// ĞIGI GIVØ — FBref normaliser (scraped, via direct fetch).
//
// Match stats:  https://fbref.com/en/matches/{match_id}/   ("Team Stats" table)
// Season avgs:  https://fbref.com/en/comps/{league_id}/    (squad tables)
//
// FBref aggressively blocks datacenter scrapers, so every parse is defensive
// and fail-soft: on any unrecognised markup this source returns null and the
// aggregator moves on. No value is ever guessed.
//
// ─── Match id resolution ────────────────────────────────────────────────────
// FBref match ids are short hex strings and CANNOT be derived from ESPN event
// ids. They are resolved via the fixture URL pattern:
//   https://fbref.com/en/comps/{league_id}/schedule/{season}/{League}-Schedule-and-Results
// The season schedule page lists every match with its /en/matches/{hex}/ link;
// we fuzzy-match the team pair and extract the hex id. A `fbref:{hex}` namespaced
// event id bypasses the lookup.
//
// ─── Anti-bot headers + rate limit ──────────────────────────────────────────
// FBref 403s requests that look like scrapers. We send a real browser
// User-Agent plus a Referer pointing at https://fbref.com/, and throttle to
// at most ONE request per second (module-level limiter shared by all fetches
// from this source). If FBref still answers 403 we log it clearly and move on
// — a 403 from their WAF is an environment problem, not a data problem.

import type { SourceContext, SourceHandler } from "./context";
import { asNumberLoose, namesMatch, roundTo } from "./shared";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatKey } from "../types";

const BASE = "https://fbref.com/en";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const REFERER = "https://fbref.com/";

/** ESPN slug → FBref competition id (Big 5 + a few majors). */
const LEAGUE_IDS: Record<string, string> = {
  "eng.1": "9", "esp.1": "12", "ger.1": "20", "ita.1": "11", "fra.1": "13",
  "ned.1": "23", "por.1": "32", "usa.1": "22", "bra.1": "24", "mex.1": "31",
};

/** ESPN slug → FBref schedule-page league slug (URL pattern segment). */
const SCHEDULE_SLUGS: Record<string, string> = {
  "eng.1": "Premier-League",
  "esp.1": "LaLiga",
  "ger.1": "Bundesliga",
  "ita.1": "Serie-A",
  "fra.1": "Ligue-1",
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

// ─── Rate limiter (1 request / second, shared by all FBref fetches) ──────────

let lastFbrefRequestAt = 0;

/** Await until at least 1s has passed since the previous FBref request. */
async function fbrefThrottle(): Promise<void> {
  const wait = lastFbrefRequestAt + 1000 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastFbrefRequestAt = Date.now();
}

/** Reset the rate limiter (tests). */
export function resetFbrefRateLimiter(): void {
  lastFbrefRequestAt = 0;
}

/** Football season start year for a date (Aug 2026 → 2026, Mar 2026 → 2025). */
function seasonFor(date: string): number {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const year = Number.isFinite(d.getTime()) ? d.getUTCFullYear() : new Date().getUTCFullYear();
  return d.getUTCMonth() + 1 >= 7 ? year : year - 1;
}

// ─── Match id resolution via the schedule (fixture URL pattern) ──────────────

/**
 * Find the FBref hex match id in a schedule page for the team pair. The
 * schedule page rows carry the /en/matches/{hex}/ link plus home/away team
 * links; we fuzzy-match the pair (ordered) and return the hex id.
 */
export function findFbrefMatchId(
  scheduleHtml: string,
  match: MatchStatsQuery,
): string | null {
  const rows = scheduleHtml.split("<tr>").slice(1);
  for (const row of rows) {
    const end = row.indexOf("</tr>");
    const body = end === -1 ? row : row.slice(0, end);
    const idMatch = body.match(/href="\/en\/matches\/([0-9a-f]{6,12})\//i);
    if (!idMatch) continue;
    const homeMatch = body.match(/table_home[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
    const awayMatch = body.match(/table_away[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
    if (!homeMatch || !awayMatch) continue;
    const h = homeMatch[1].trim();
    const a = awayMatch[1].trim();
    if (!h || !a) continue;
    if (!namesMatch(h, match.homeTeam) || !namesMatch(a, match.awayTeam)) continue;
    return idMatch[1];
  }
  return null;
}

async function resolveFbrefMatchId(
  match: MatchStatsQuery,
  ctx: SourceContext,
): Promise<string | null> {
  const leagueId = LEAGUE_IDS[match.leagueSlug];
  const scheduleSlug = SCHEDULE_SLUGS[match.leagueSlug];
  if (!leagueId || !scheduleSlug) {
    ctx.log(`[FBref] League ${match.leagueSlug} has no FBref schedule mapping — cannot resolve match id, skipping.`);
    return null;
  }

  const season = seasonFor(match.date);
  const url = `${BASE}/comps/${leagueId}/schedule/${season}/${scheduleSlug}-Schedule-and-Results`;
  await fbrefThrottle();
  const res = await ctx.http(url, {
    timeoutMs: ctx.timeoutMs,
    text: true,
    userAgent: BROWSER_UA,
    headers: { Referer: REFERER },
  });

  if (res.status === "http-error" && res.httpStatus === 403) {
    ctx.log("[FBref] HTTP 403 from fbref.com — request blocked by their WAF despite browser headers; moving on (datacenter egress is usually the cause).");
    return null;
  }
  if (res.status === "not-found") {
    ctx.log(`[FBref] Schedule page 404 for ${match.leagueSlug} ${season} — URL pattern mismatch, skipping.`);
    return null;
  }
  if (res.status !== "ok" || typeof res.data !== "string") {
    ctx.log(`[FBref] Schedule lookup failed (${res.status}) — cannot resolve match id, skipping.`);
    return null;
  }

  const matchId = findFbrefMatchId(res.data, match);
  if (matchId) {
    ctx.log(`[FBref] Resolved match id ${matchId} for ${match.homeTeam} vs ${match.awayTeam} (${match.date.slice(0, 10)})`);
  } else {
    ctx.log(`[FBref] Match ${match.homeTeam} vs ${match.awayTeam} not found on the ${season} ${scheduleSlug} schedule — skipping.`);
  }
  return matchId;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const fbrefSource: SourceHandler = {
  name: "FBref",
  capabilities: FBREF_CAPABILITIES,

  available: () => true,

  async fetch(match, ctx): Promise<SourcePayload | null> {
    // Resolve the FBref hex match id: namespaced ids bypass the lookup.
    const namespaced = match.eventId.match(/^fbref:([0-9a-f]+)$/i);
    const matchId = namespaced ? namespaced[1] : await resolveFbrefMatchId(match, ctx);
    if (!matchId) return null;

    await fbrefThrottle();
    const pageUrl = `${BASE}/matches/${matchId}/`;
    const page = await ctx.http(pageUrl, {
      timeoutMs: ctx.timeoutMs,
      text: true,
      userAgent: BROWSER_UA,
      headers: { Referer: REFERER },
    });

    if (page.status === "http-error" && page.httpStatus === 403) {
      ctx.log(`[FBref] HTTP 403 fetching ${pageUrl} — fbref.com is blocking this request (datacenter WAF). Nothing fixable from headers here; skipping.`);
      return null;
    }
    if (page.status !== "ok" || typeof page.data !== "string") {
      ctx.log(`[FBref] Match page unavailable (${page.status}) — skipping.`);
      return null;
    }

    const payload = normaliseFbrefMatchHtml(page.data, match.homeTeam, match.awayTeam);
    const hasAny =
      Object.values(payload.home).some((v) => v !== null) ||
      Object.values(payload.away).some((v) => v !== null);
    if (!hasAny) {
      ctx.log(`[FBref] Match page ${matchId} returned no parseable Team Stats — skipping.`);
      return null;
    }

    // Season averages (best-effort) from the league stats page.
    const leagueId = LEAGUE_IDS[match.leagueSlug];
    if (leagueId) {
      await fbrefThrottle();
      const stats = await ctx.http(`${BASE}/comps/${leagueId}/`, {
        timeoutMs: ctx.timeoutMs,
        text: true,
        userAgent: BROWSER_UA,
        headers: { Referer: REFERER },
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
