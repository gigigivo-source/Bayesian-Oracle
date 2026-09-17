// ĞIGI GIVØ — OpenFootAPI xG fallback (optional, additive).
//
// Endpoint: GET https://openfootapi.com/v1/matches/{eventId}/xg
// Auth:     Authorization: Bearer ${OPENFOOT_API_KEY}
// Key:      OPENFOOT_API_KEY via env (free tier 5000 req/month at
//           openfootapi.com). When unset, the handler returns null without
//           throwing — this layer only fires when the user opts in.
//
// This layer is ADDITIVE: it fills xg (and xgPerShot when shots are present)
// when Bzzoiro has no shot data for a match. 8s timeout, fail-soft, same
// SourceHandler contract as the other normalisers.

import type { SourceHandler } from "./context";
import { asNumber, asRecord, asString, namesMatch } from "./shared";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatField } from "../types";

const BASE = "https://openfootapi.com/v1";

export const OPENFOOT_CAPABILITIES: StatField[] = ["xg", "xgPerShot"];

function expectedGoalsOf(node: unknown): number | null {
  const rec = asRecord(node);
  if (!rec) return asNumber(node);
  for (const key of ["xg", "expectedGoals", "expected_goals", "xG", "expGoals"]) {
    const v = asNumber(rec[key]);
    if (v !== null) return v;
  }
  return null;
}

export const openfootSource: SourceHandler = {
  name: "OpenFootAPI",
  capabilities: OPENFOOT_CAPABILITIES,

  available: (match: MatchStatsQuery, ctx) => ctx.env("OPENFOOT_API_KEY").length > 0 && match.eventId.trim().length > 0,

  async fetch(match, ctx): Promise<SourcePayload | null> {
    const apiKey = ctx.env("OPENFOOT_API_KEY");
    if (!apiKey) return null;

    const res = await ctx.http(
      `${BASE}/matches/${encodeURIComponent(match.eventId)}/xg`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutMs: Math.min(ctx.timeoutMs, 8_000),
      },
    );
    if (res.status !== "ok") return null;

    const root = asRecord(res.data);
    if (!root) return null;

    // Accept both {home:{…}, away:{…}} and {homeXg, awayXg} shapes, plus a
    // nested {match:{…}} / {data:{…}} wrapper.
    const body = asRecord(root.data) ?? asRecord(root.match) ?? root;

    let homeNode: unknown = body.home ?? body.homeTeam;
    let awayNode: unknown = body.away ?? body.awayTeam;
    let homeXg = expectedGoalsOf(homeNode);
    let awayXg = expectedGoalsOf(awayNode);
    if (homeXg === null) homeXg = asNumber(body.homeXg ?? body.home_xg);
    if (awayXg === null) awayXg = asNumber(body.awayXg ?? body.away_xg);

    // When the payload names its sides, verify they are our fixture — an xG
    // value for the wrong match is worse than none.
    const homeName = asString(asRecord(homeNode)?.name ?? asRecord(homeNode)?.team);
    const awayName = asString(asRecord(awayNode)?.name ?? asRecord(awayNode)?.team);
    if (homeName && awayName) {
      const aligned =
        (namesMatch(homeName, match.homeTeam) && namesMatch(awayName, match.awayTeam)) ||
        (namesMatch(homeName, match.awayTeam) && namesMatch(awayName, match.homeTeam));
      if (!aligned) return null;
      if (namesMatch(homeName, match.awayTeam)) {
        const tmp = homeXg;
        homeXg = awayXg;
        awayXg = tmp;
      }
    }

    if (homeXg === null && awayXg === null) return null;

    const home: PartialTeamStats = {};
    const away: PartialTeamStats = {};
    if (homeXg !== null) home.xg = homeXg;
    if (awayXg !== null) away.xg = awayXg;

    // Shot quality when the payload also carries shot counts.
    const homeShots = asNumber(asRecord(homeNode)?.shots);
    const awayShots = asNumber(asRecord(awayNode)?.shots);
    if (homeXg !== null && homeShots !== null && homeShots > 0) {
      home.xgPerShot = Math.round((homeXg / homeShots) * 1000) / 1000;
    }
    if (awayXg !== null && awayShots !== null && awayShots > 0) {
      away.xgPerShot = Math.round((awayXg / awayShots) * 1000) / 1000;
    }

    return { home, away };
  },
};
