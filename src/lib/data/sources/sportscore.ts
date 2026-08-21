// ĞIGI GIVØ — SportScore normaliser (no key, CORS-open public API).
//
// Primary endpoint (existing integration):  /api/widget/match/?sport=football&slug=…
// Spec alternative:                          https://sportscore.io/api/v1/matches/{eventId}
// Fallback when the event id cannot be used: search by homeTeam + awayTeam + date.
//
// SportScore's widget payload nests per-team stat blocks under home/away keys.
// The shape varies across sports and releases, so the normaliser walks the
// payload defensively and only keeps fields it can positively identify.

import type { SourceContext, SourceHandler } from "./context";
import {
  asArray, asNumberLoose, asRecord, asString, namesMatch,
} from "./shared";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatKey } from "../types";

const BASE = "https://sportscore.com";

export const SPORTSCORE_CAPABILITIES: StatKey[] = [
  "goals", "xg", "shots", "shotsOnTarget", "corners", "yellowCards", "redCards",
  "fouls", "possession", "passes", "saves", "throwIns", "offsides", "dribbling",
  "aerialBattlesWon", "interceptions",
];

/** key aliases (normalised, punctuation stripped) → TeamStats field. */
const KEY_ALIASES: Record<string, StatKey> = {
  goals: "goals",
  goalscored: "goals",
  homegoals: "goals",
  awaygoals: "goals",
  xg: "xg",
  expectedgoals: "xg",
  shots: "shots",
  totalshots: "shots",
  shotsontarget: "shotsOnTarget",
  ontarget: "shotsOnTarget",
  corner: "corners",
  corners: "corners",
  woncorners: "corners",
  cornerkicks: "corners",
  yellowcards: "yellowCards",
  yellowcard: "yellowCards",
  redcards: "redCards",
  redcard: "redCards",
  cards: "yellowCards",
  fouls: "fouls",
  foulscommitted: "fouls",
  possession: "possession",
  possessionpct: "possession",
  ballpossession: "possession",
  passes: "passes",
  totalpasses: "passes",
  saves: "saves",
  goalkeepersaves: "saves",
  throwins: "throwIns",
  offsides: "offsides",
  offside: "offsides",
  dribbles: "dribbling",
  successfuldribbles: "dribbling",
  aerials: "aerialBattlesWon",
  aerialbattleswon: "aerialBattlesWon",
  aerialsWon: "aerialBattlesWon",
  interceptions: "interceptions",
};

const normKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function kebab(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Defensively walk a subtree and collect any recognisable stat fields. */
function collectStats(node: unknown, out: PartialTeamStats, depth = 0): void {
  if (depth > 6 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) collectStats(item, out, depth + 1);
    return;
  }
  const rec = asRecord(node);
  if (!rec) return;

  for (const [key, value] of Object.entries(rec)) {
    const field = KEY_ALIASES[normKey(key)];
    if (field) {
      const n = asNumberLoose(value);
      if (n !== null && out[field] === undefined) out[field] = n;
      continue;
    }
    // Descend only into object-like values (avoid re-interpreting scalars).
    if (typeof value === "object" && value !== null) {
      collectStats(value, out, depth + 1);
    }
  }
}

async function findSlug(match: MatchStatsQuery, ctx: SourceContext): Promise<string | null> {
  const namespaced = match.eventId.match(/^sportscore:(.+)$/i);
  if (namespaced) return namespaced[1];

  const res = await ctx.http(`${BASE}/api/widget/matches/?sport=football&limit=50`, {
    timeoutMs: ctx.timeoutMs,
  });
  if (res.status !== "ok") return null;

  const walk = (node: unknown, depth = 0): string | null => {
    if (depth > 5) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const rec = asRecord(item);
        const home = asString(rec?.home ?? rec?.home_name ?? rec?.homeName);
        const away = asString(rec?.away ?? rec?.away_name ?? rec?.awayName);
        const slug = asString(rec?.slug);
        if (home && away && slug && namesMatch(home, match.homeTeam) && namesMatch(away, match.awayTeam)) {
          return slug;
        }
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const rec = asRecord(node);
    if (rec) {
      for (const v of Object.values(rec)) {
        const found = walk(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(res.data);
}

export const sportscoreSource: SourceHandler = {
  name: "SportScore",
  capabilities: SPORTSCORE_CAPABILITIES,

  available: () => true,

  async fetch(match, ctx): Promise<SourcePayload | null> {
    const slug = await findSlug(match, ctx);
    if (!slug) return null;

    const res = await ctx.http(`${BASE}/api/widget/match/?sport=football&slug=${encodeURIComponent(slug)}`, {
      timeoutMs: ctx.timeoutMs,
    });
    if (res.status !== "ok") return null;

    // Split the payload into home/away subtrees when the shape allows it.
    const root = asRecord(res.data);
    const matchBlock = root
      ? (asRecord(root.match) ?? asRecord(root.data) ?? root)
      : null;
    if (!matchBlock) return null;

    const homeRaw = matchBlock.home ?? matchBlock.home_team ?? matchBlock.team_home ?? matchBlock.team1;
    const awayRaw = matchBlock.away ?? matchBlock.away_team ?? matchBlock.team_away ?? matchBlock.team2;

    const home: PartialTeamStats = {};
    const away: PartialTeamStats = {};

    if (homeRaw != null && awayRaw != null) {
      collectStats(homeRaw, home);
      collectStats(awayRaw, away);
    } else {
      // No clear home/away split — walk the whole payload and accept the
      // fields only if we can attribute them (home/away unknown → skip).
      return null;
    }

    const hasAny =
      Object.values(home).some((v) => v !== null) ||
      Object.values(away).some((v) => v !== null);
    return hasAny ? { home, away } : null;
  },
};
