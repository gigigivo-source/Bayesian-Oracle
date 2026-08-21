// ĞIGI GIVØ — datafc (Sofascore scraper) normaliser.
//
// datafc is a local Python package (`datafc.get_match_stats(eventId)`). It is
// not importable from the Node runtime, so this handler bridges to it through
// an optional HTTP sidecar: set DATAFCC_ENDPOINT to a local proxy that returns
// the datafc payload for an eventId. When no sidecar is configured the source
// simply skips (returns null) — data is never fabricated.
//
// Normalisation maps the documented datafc output fields (home_xg, away_xg,
// shots, shots_on_target, corners, cards, fouls, passes, possession, saves,
// throw-ins, offsides, dribbling, aerial battles, interceptions) into the
// canonical shape.

import type { SourceHandler } from "./context";
import { asNumber, asNumberLoose, asRecord, asString, getPath, namesMatch, roundTo } from "./shared";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatKey } from "../types";

export const DATAFCC_CAPABILITIES: StatKey[] = [
  "goals", "xg", "shots", "shotsOnTarget", "corners", "yellowCards", "redCards",
  "fouls", "possession", "passes", "saves", "throwIns", "offsides", "dribbling",
  "aerialBattlesWon", "interceptions",
];

/** Column aliases → canonical field (normalised keys). */
const FIELD_ALIASES: Record<string, StatKey> = {
  goals: "goals",
  xg: "xg",
  homexg: "xg",
  awayxg: "xg",
  expectedgoals: "xg",
  shots: "shots",
  totalshots: "shots",
  shotsontarget: "shotsOnTarget",
  corners: "corners",
  cornerkicks: "corners",
  yellowcards: "yellowCards",
  redcards: "redCards",
  cards: "yellowCards",
  fouls: "fouls",
  foulscommitted: "fouls",
  possession: "possession",
  ballpossession: "possession",
  passes: "passes",
  totalpasses: "passes",
  saves: "saves",
  goalkeepersaves: "saves",
  throwins: "throwIns",
  offsides: "offsides",
  dribbles: "dribbling",
  successfuldribbles: "dribbling",
  aerials: "aerialBattlesWon",
  aerialbattleswon: "aerialBattlesWon",
  interceptions: "interceptions",
};

const normKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function extractStats(node: unknown, out: PartialTeamStats, depth = 0): void {
  if (depth > 6 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) extractStats(item, out, depth + 1);
    return;
  }
  const rec = asRecord(node);
  if (!rec) return;
  for (const [key, value] of Object.entries(rec)) {
    const field = FIELD_ALIASES[normKey(key)];
    if (field) {
      const n = asNumberLoose(value);
      if (n !== null && out[field] === undefined) out[field] = n;
      continue;
    }
    if (typeof value === "object" && value !== null) extractStats(value, out, depth + 1);
  }
}

/**
 * Pure normaliser for a datafc payload. Accepts the common shapes:
 *   { home: {...}, away: {...} }  or  { home_stats, away_stats }
 *   or  { home_team: { stats: {...} }, away_team: { stats: {...} } }
 */
export function normaliseDatafc(payload: unknown, homeName: string, awayName: string): SourcePayload {
  const root = asRecord(payload) ?? {};
  const homeRaw =
    root.home ?? root.home_stats ?? root.home_team ?? getPath(payload, "home.stats") ?? {};
  const awayRaw =
    root.away ?? root.away_stats ?? root.away_team ?? getPath(payload, "away.stats") ?? {};

  const home: PartialTeamStats = {};
  const away: PartialTeamStats = {};
  extractStats(homeRaw, home);
  extractStats(awayRaw, away);

  // xG per shot, when both are present.
  if (home.xg != null && home.shots != null && home.shots > 0) {
    home.xgPerShot = roundTo(home.xg / home.shots, 3);
  }
  if (away.xg != null && away.shots != null && away.shots > 0) {
    away.xgPerShot = roundTo(away.xg / away.shots, 3);
  }

  // datafc returns home_xg / away_xg as top-level keys in some versions.
  const hxg = asNumber(root.home_xg);
  const axg = asNumber(root.away_xg);
  if (hxg !== null && home.xg == null) home.xg = hxg;
  if (axg !== null && away.xg == null) away.xg = axg;

  // Verify the payload is actually for this fixture (best-effort).
  const homeTitle = asString(getPath(homeRaw, "name") ?? root.home_name);
  const awayTitle = asString(getPath(awayRaw, "name") ?? root.away_name);
  if (homeTitle && awayTitle && !(namesMatch(homeTitle, homeName) && namesMatch(awayTitle, awayName))) {
    return { home: {}, away: {} };
  }

  const hasAny =
    Object.values(home).some((v) => v !== null) ||
    Object.values(away).some((v) => v !== null);
  return hasAny ? { home, away } : { home: {}, away: {} };
}

export const datafcSource: SourceHandler = {
  name: "datafc",
  capabilities: DATAFCC_CAPABILITIES,

  available: (_match, ctx) => ctx.env("DATAFCC_ENDPOINT").length > 0,

  async fetch(match, ctx): Promise<SourcePayload | null> {
    const endpoint = ctx.env("DATAFCC_ENDPOINT");
    if (!endpoint) return null;
    const url = endpoint.includes("{eventId}")
      ? endpoint.replace("{eventId}", encodeURIComponent(match.eventId))
      : `${endpoint}${endpoint.includes("?") ? "&" : "?"}eventId=${encodeURIComponent(match.eventId)}`;
    const res = await ctx.http(url, { timeoutMs: ctx.timeoutMs });
    if (res.status !== "ok") return null;
    const payload = normaliseDatafc(res.data, match.homeTeam, match.awayTeam);
    const hasAny =
      Object.values(payload.home).some((v) => v !== null) ||
      Object.values(payload.away).some((v) => v !== null);
    return hasAny ? payload : null;
  },
};
