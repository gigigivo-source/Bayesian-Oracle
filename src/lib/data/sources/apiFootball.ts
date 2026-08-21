// ĞIGI GIVØ — API-Football (api-sports.io) stats normaliser.
//
// Endpoint: https://v3.football.api-sports.io/fixtures/statistics?fixture={id}
// Key:      API_FOOTBALL_KEY (or FOOTBALL_API_KEY) via env.
//
// The most comprehensive live source: when it works it provides nearly every
// per-match stat (xG, shots, SOT, corners, cards, fouls, passes, possession,
// saves, throw-ins, offsides, …). It does NOT provide historical season
// averages, which is why the aggregator only "breaks early" on API-Football
// when every NON-historical field is already covered.

import type { SourceHandler } from "./context";
import { asArray, asNumber, asRecord, asString, getPath, namesMatch, pct, roundTo } from "./shared";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatField, StatKey } from "../types";

const BASE = "https://v3.football.api-sports.io";

/** Stat fields API-Football's `/fixtures/statistics` response can fill. */
export const API_FOOTBALL_CAPABILITIES: StatField[] = [
  "goals", "xg", "xgPerShot", "shots", "shotsOnTarget", "shotsOffTarget",
  "blockedShots", "corners", "goalKicks", "throwIns", "freeKicks", "penalties",
  "yellowCards", "redCards", "fouls", "offsides", "possession", "passes",
  "passAccuracy", "saves", "goalsConceded", "cleanSheet", "dribbling",
  "aerialBattlesWon", "interceptions", "tackles", "clearances",
];

/** API-Football statistic "type" string → TeamStats field. */
const TYPE_MAP: Record<string, StatKey> = {
  expectedgoals: "xg",
  shotsongoal: "shotsOnTarget",
  shotsoffgoal: "shotsOffTarget",
  totalshots: "shots",
  blockedshots: "blockedShots",
  fouls: "fouls",
  cornerkicks: "corners",
  offsides: "offsides",
  ballpossession: "possession",
  yellowcards: "yellowCards",
  redcards: "redCards",
  goalkeepersaves: "saves",
  totalpasses: "passes",
  throwins: "throwIns",
  goalkicks: "goalKicks",
  freekicks: "freeKicks",
  penalty: "penalties",
  penalties: "penalties",
  tackles: "tackles",
  interceptions: "interceptions",
  dribbles: "dribbling",
  successfuldribbles: "dribbling",
  dribbleattempts: "dribbling",
  aerials: "aerialBattlesWon",
  aerialswon: "aerialBattlesWon",
  aerialduelswon: "aerialBattlesWon",
  clearances: "clearances",
  goals: "goals",
};

const normKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9%]/g, "");

interface ApiFFixture {
  fixture: { id: number; date?: string };
  teams: { home: { name: string } | null; away: { name: string } | null };
  goals?: { home: number | null; away: number | null };
}

/** Extract a stats entry's numeric value (handles "55%" and "1.23"). */
function valueOf(v: unknown): number | null {
  return asNumber(v);
}

export const apiFootballSource: SourceHandler = {
  name: "API-Football",
  capabilities: API_FOOTBALL_CAPABILITIES,

  available: (_match, ctx) => {
    const key = ctx.env("API_FOOTBALL_KEY") || ctx.env("FOOTBALL_API_KEY");
    return key.length > 0;
  },

  async fetch(match, ctx): Promise<SourcePayload | null> {
    const key = ctx.env("API_FOOTBALL_KEY") || ctx.env("FOOTBALL_API_KEY");
    const headers = { "x-apisports-key": key };

    // 1) Resolve the API-Football fixture id (namespaced id, or search by
    //    team + date — ESPN event ids do not exist in API-Football).
    let fixtureId: number | null = null;
    let goals: { home: number | null; away: number | null } | null = null;
    let homeName = match.homeTeam;
    let awayName = match.awayTeam;

    const namespaced = match.eventId.match(/^apif:(\d+)$/i);
    if (namespaced) {
      fixtureId = Number(namespaced[1]);
    }

    if (fixtureId === null) {
      const day = match.date.slice(0, 10);
      const res = await ctx.http(`${BASE}/fixtures?date=${day}`, {
        headers,
        timeoutMs: ctx.timeoutMs,
      });
      if (res.status !== "ok") return null;
      const response = asArray(getPath(res.data, "response"));
      for (const item of response) {
        const rec = asRecord(item);
        const h = asString(getPath(rec, "teams.home.name"));
        const a = asString(getPath(rec, "teams.away.name"));
        if (h && a && namesMatch(h, match.homeTeam) && namesMatch(a, match.awayTeam)) {
          fixtureId = asNumber(getPath(rec, "fixture.id"));
          homeName = h;
          awayName = a;
          goals = {
            home: asNumber(getPath(rec, "goals.home")),
            away: asNumber(getPath(rec, "goals.away")),
          };
          break;
        }
      }
    }
    if (fixtureId === null) return null;

    // 2) Statistics — two entries (home + away), each with a statistics array.
    const statsRes = await ctx.http(`${BASE}/fixtures/statistics?fixture=${fixtureId}`, {
      headers,
      timeoutMs: ctx.timeoutMs,
    });
    if (statsRes.status !== "ok") return null;

    const entries = asArray(getPath(statsRes.data, "response"));
    if (entries.length < 2) return null;

    const parseTeam = (raw: unknown): PartialTeamStats => {
      const rec = asRecord(raw);
      const out: PartialTeamStats = {};
      let passesAccurate: number | null = null;
      let totalPasses: number | null = null;

      for (const s of asArray(rec?.statistics)) {
        const sr = asRecord(s);
        const type = asString(sr?.type);
        if (!type) continue;
        const field = TYPE_MAP[normKey(type)];
        if (!field) continue;
        const value = valueOf(sr?.value);
        if (value === null) continue;

        if (normKey(type) === "passesaccurate") {
          passesAccurate = value;
          continue;
        }
        if (normKey(type) === "totalpasses") {
          totalPasses = value;
        }
        if (field === "possession" && value > 1 && value <= 100) {
          out.possession = value;
          continue;
        }
        if (out[field] === undefined) out[field] = value;
      }

      // Pass accuracy from the dedicated percentage, else derive it.
      if (out.passAccuracy == null && passesAccurate !== null && totalPasses) {
        out.passAccuracy = pct(passesAccurate, totalPasses);
      }
      if (out.passAccuracy == null && totalPasses !== null && out.passes == null) {
        out.passes = totalPasses;
      }
      return out;
    };

    const homeIdx = entries.findIndex((e) => {
      const rec = asRecord(e);
      const t = asString(getPath(rec, "team.name"));
      return t ? namesMatch(t, homeName) : false;
    });
    const awayIdx = entries.findIndex((e, i) => {
      if (i === homeIdx) return false;
      const rec = asRecord(e);
      const t = asString(getPath(rec, "team.name"));
      return t ? namesMatch(t, awayName) : false;
    });

    const home = parseTeam(entries[homeIdx >= 0 ? homeIdx : 0]);
    const away = parseTeam(entries[awayIdx >= 0 ? awayIdx : 1]);

    // Goals + goals-conceded come from the fixture score (reliable).
    if (goals) {
      home.goals = goals.home;
      away.goals = goals.away;
      home.goalsConceded = goals.away;
      away.goalsConceded = goals.home;
      if (goals.away === 0) home.cleanSheet = true;
      else if (goals.away !== null) home.cleanSheet = false;
      if (goals.home === 0) away.cleanSheet = true;
      else if (goals.home !== null) away.cleanSheet = false;
    }

    // xG per shot (shot quality) when both are present.
    if (home.xg != null && home.shots != null && home.shots > 0) {
      home.xgPerShot = roundTo(home.xg / home.shots, 3);
    }
    if (away.xg != null && away.shots != null && away.shots > 0) {
      away.xgPerShot = roundTo(away.xg / away.shots, 3);
    }

    const hasAny =
      Object.values(home).some((v) => v !== null) ||
      Object.values(away).some((v) => v !== null);
    return hasAny ? { home, away } : null;
  },
};
