// ĞIGI GIVØ — worldcup2026 API normaliser (community fixture feed).
//
// Endpoint: https://worldcup2026-api.vercel.app/api/matches/{eventId}
// Provides goals / fixtures / basic match data only. Everything else stays null.

import type { SourceHandler } from "./context";
import { asArray, asNumberLoose, asRecord, asString, getPath, namesMatch } from "./shared";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatField } from "../types";

const BASE = "https://worldcup2026-api.vercel.app/api";

export const WORLDCUP2026_CAPABILITIES: StatField[] = [
  "goals", "goalsConceded", "cleanSheet",
];

function extractGoals(node: unknown): { home: number; away: number } | null {
  const rec = asRecord(node);
  if (!rec) return null;

  const home = asNumberLoose(
    rec.home_score ?? rec.homeScore ?? getPath(node, "score.home") ?? getPath(node, "result.home"),
  );
  const away = asNumberLoose(
    rec.away_score ?? rec.awayScore ?? getPath(node, "score.away") ?? getPath(node, "result.away"),
  );
  if (home === null || away === null) {
    // "2-1" style score string.
    const s = asString(rec.score ?? rec.result);
    if (s) {
      const m = s.match(/(\d+)\s*[-–:]\s*(\d+)/);
      if (m) return { home: Number(m[1]), away: Number(m[2]) };
    }
    return null;
  }
  return { home, away };
}

export const worldcup2026Source: SourceHandler = {
  name: "worldcup2026",
  capabilities: WORLDCUP2026_CAPABILITIES,

  available: () => true,

  async fetch(match, ctx): Promise<SourcePayload | null> {
    const res = await ctx.http(`${BASE}/matches/${encodeURIComponent(match.eventId)}`, {
      timeoutMs: ctx.timeoutMs,
    });
    if (res.status !== "ok") return null;

    const root = asRecord(res.data);
    const data = root ? (asRecord(root.data) ?? root) : null;
    const matches = asArray(root?.matches ?? root?.data ?? data?.matches);

    const candidates = matches.length ? matches : [data];
    for (const item of candidates) {
      const rec = asRecord(item);
      const home = asString(rec?.home_team ?? rec?.homeTeam ?? rec?.home ?? getPath(rec, "teams.home"));
      const away = asString(rec?.away_team ?? rec?.awayTeam ?? rec?.away ?? getPath(rec, "teams.away"));
      if (home && away && !(namesMatch(home, match.homeTeam) && namesMatch(away, match.awayTeam))) {
        continue;
      }
      const goals = extractGoals(item);
      if (!goals) continue;

      const homeOut: PartialTeamStats = {
        goals: goals.home,
        goalsConceded: goals.away,
        cleanSheet: goals.away === 0,
      };
      const awayOut: PartialTeamStats = {
        goals: goals.away,
        goalsConceded: goals.home,
        cleanSheet: goals.home === 0,
      };
      return { home: homeOut, away: awayOut };
    }
    return null;
  },
};
