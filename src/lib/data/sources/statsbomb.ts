// ĞIGI GIVØ — StatsBomb Open Data normaliser (hudl/open-data on GitHub).
//
// Endpoint:
//   https://raw.githubusercontent.com/statsbomb/open-data/master/data/...
//   · /competitions.json                        → competition/season catalogue
//   · /matches/{competition_id}/{season_id}.json → match list (team+date → match_id)
//   · /events/{match_id}.json                    → per-event timeline
//
// Normalisation aggregates the raw event timeline into CanonicalMatchStats.
// Events are matched by their stable `type.name` (e.g. "Shot", "Pass",
// "Foul Committed", "Duel", "Interception") rather than by numeric ids, because
// the open-data schema's numeric type ids are not stable across releases
// (the spec's shorthand — shots 16 / passes 30 / fouls 18 / corners 10 /
// interceptions 19 / dribbles 41 / aerial duels 42 — mixes several unrelated
// ids in the current schema; "Pass"=30 and "Shot"=16 hold, but e.g. 42 is
// "Ball Receipt*"). Matching by name yields the same stat — from REAL events —
// with none of the id-drift risk.

import type { SourceContext, SourceHandler } from "./context";
import {
  asArray, asNumber, asRecord, asString, getPath, namesMatch, pct, roundTo,
} from "./shared";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatField } from "../types";

const BASE = "https://raw.githubusercontent.com/statsbomb/open-data/master/data";

/**
 * ESPN slug → StatsBomb open-data competition_id (top-5 domestic only).
 * The open-data repo is mostly historical domestic + international data; the
 * league hint narrows the match lookup to the right competition so recent
 * matches in uncovered leagues are skipped fast instead of scanning every
 * season of every competition.
 */
const LEAGUE_COMPETITIONS: Record<string, number> = {
  "eng.1": 2,  // Barclays Premier League
  "esp.1": 1,  // La Liga
  "ger.1": 3,  // Bundesliga
  "ita.1": 4,  // Serie A
  "fra.1": 5,  // Ligue 1
};

export const STATSBOMB_CAPABILITIES: StatField[] = [
  "goals", "xg", "xgPerShot", "shots", "shotsOnTarget", "shotsOffTarget",
  "blockedShots", "corners", "goalKicks", "throwIns", "freeKicks", "penalties",
  "yellowCards", "redCards", "fouls", "offsides", "possession", "passes",
  "passAccuracy", "saves", "goalsConceded", "cleanSheet", "dribbling",
  "aerialBattlesWon", "interceptions", "tackles", "clearances",
];

/** Shot outcomes that count as "on target" in the StatsBomb schema. */
const ON_TARGET_OUTCOMES = new Set(["Goal", "Saved", "Saved to Post", "Saved Off Target"]);
const OFF_TARGET_OUTCOMES = new Set(["Off T", "Wayward", "Post"]);
const SAVE_OUTCOME = (name: string): boolean => name.includes("Saved") || name === "Collected";

/** Event types this normaliser aggregates — used to detect an empty/foreign
 *  timeline so we never emit a fabricated all-zero payload. */
const RECOGNISED_TYPES = new Set([
  "Shot", "Pass", "Foul Committed", "Bad Behaviour", "Interception",
  "Clearance", "Dribble", "Duel", "Goal Keeper",
]);

interface TeamAccumulator {
  goals: number;
  xg: number;
  shots: number;
  shotsOnTarget: number;
  shotsOffTarget: number;
  blockedShots: number;
  corners: number;
  goalKicks: number;
  throwIns: number;
  freeKicks: number;
  penalties: number;
  yellowCards: number;
  redCards: number;
  fouls: number;
  offsides: number;
  passes: number;
  passesCompleted: number;
  saves: number;
  dribbling: number;
  aerialBattlesWon: number;
  interceptions: number;
  tackles: number;
  clearances: number;
}

const newAccumulator = (): TeamAccumulator => ({
  goals: 0, xg: 0, shots: 0, shotsOnTarget: 0, shotsOffTarget: 0, blockedShots: 0,
  corners: 0, goalKicks: 0, throwIns: 0, freeKicks: 0, penalties: 0,
  yellowCards: 0, redCards: 0, fouls: 0, offsides: 0,
  passes: 0, passesCompleted: 0, saves: 0, dribbling: 0, aerialBattlesWon: 0,
  interceptions: 0, tackles: 0, clearances: 0,
});

function toPartial(acc: TeamAccumulator, opponentGoals: number): PartialTeamStats {
  return {
    goals: acc.goals,
    xg: roundTo(acc.xg, 2),
    xgPerShot: acc.shots > 0 ? roundTo(acc.xg / acc.shots, 3) : null,
    shots: acc.shots,
    shotsOnTarget: acc.shotsOnTarget,
    shotsOffTarget: acc.shotsOffTarget,
    blockedShots: acc.blockedShots,
    corners: acc.corners,
    goalKicks: acc.goalKicks,
    throwIns: acc.throwIns,
    freeKicks: acc.freeKicks,
    penalties: acc.penalties,
    yellowCards: acc.yellowCards,
    redCards: acc.redCards,
    fouls: acc.fouls,
    offsides: acc.offsides,
    possession: null, // filled after both sides are known
    passes: acc.passes,
    passAccuracy: pct(acc.passesCompleted, acc.passes),
    saves: acc.saves,
    goalsConceded: opponentGoals,
    cleanSheet: opponentGoals === 0,
    dribbling: acc.dribbling,
    aerialBattlesWon: acc.aerialBattlesWon,
    interceptions: acc.interceptions,
    tackles: acc.tackles,
    clearances: acc.clearances,
  };
}

/**
 * Aggregate a StatsBomb events timeline into partial home/away team stats.
 * Pure and side-effect-free — the unit-test entry point.
 */
export function normaliseStatsBombEvents(
  events: unknown[],
  homeName: string,
  awayName: string,
): SourcePayload {
  const home = newAccumulator();
  const away = newAccumulator();
  let hasData = false;

  for (const raw of events) {
    const ev = asRecord(raw);
    const typeName = asString(getPath(ev, "type.name")) ?? "";
    const teamName = asString(getPath(ev, "team.name"));
    const acc = teamName == null
      ? null
      : namesMatch(teamName, homeName) ? home
      : namesMatch(teamName, awayName) ? away
      : null;

    if (RECOGNISED_TYPES.has(typeName)) hasData = true;

    switch (typeName) {
      case "Shot": {
        if (!acc) break;
        acc.shots++;
        const xg = asNumber(getPath(ev, "shot.statsbomb_xg")) ?? 0;
        acc.xg += xg;
        const outcome = asString(getPath(ev, "shot.outcome.name")) ?? "";
        if (outcome === "Goal") acc.goals++;
        if (ON_TARGET_OUTCOMES.has(outcome)) acc.shotsOnTarget++;
        else if (OFF_TARGET_OUTCOMES.has(outcome)) acc.shotsOffTarget++;
        else if (outcome === "Blocked") acc.blockedShots++;
        if (asString(getPath(ev, "shot.type.name")) === "Penalty") acc.penalties++;
        break;
      }
      case "Pass": {
        if (!acc) break;
        acc.passes++;
        const passType = asString(getPath(ev, "pass.type.name")) ?? "";
        if (passType === "Corner") acc.corners++;
        else if (passType === "Throw-in") acc.throwIns++;
        else if (passType === "Goal Kick") acc.goalKicks++;
        else if (passType === "Free Kick") acc.freeKicks++;
        const outcome = asString(getPath(ev, "pass.outcome.name"));
        if (outcome === null) acc.passesCompleted++;
        if (outcome === "Offside") acc.offsides++;
        break;
      }
      case "Foul Committed": {
        if (!acc) break;
        acc.fouls++;
        const card = asString(getPath(ev, "foul_committed.card.name")) ?? "";
        if (card === "Yellow Card" || card === "Second Yellow") acc.yellowCards++;
        if (card === "Red Card") acc.redCards++;
        break;
      }
      case "Bad Behaviour": {
        if (!acc) break;
        const card = asString(getPath(ev, "bad_behaviour.card.name")) ?? "";
        if (card === "Yellow Card" || card === "Second Yellow") acc.yellowCards++;
        if (card === "Red Card") acc.redCards++;
        break;
      }
      case "Interception":
        if (acc) acc.interceptions++;
        break;
      case "Clearance":
        if (acc) acc.clearances++;
        break;
      case "Dribble": {
        if (!acc) break;
        const outcome = asString(getPath(ev, "dribble.outcome.name")) ?? "";
        if (outcome === "Complete") acc.dribbling++;
        break;
      }
      case "Duel": {
        if (!acc) break;
        const duelType = asString(getPath(ev, "duel.type.name")) ?? "";
        if (duelType === "Aerial Won") acc.aerialBattlesWon++;
        else if (duelType === "Tackle") acc.tackles++;
        break;
      }
      case "Goal Keeper": {
        if (!acc) break;
        const gkType = asString(getPath(ev, "goalkeeper.type.name")) ?? "";
        if (SAVE_OUTCOME(gkType)) acc.saves++;
        break;
      }
      default:
        break;
    }
  }

  if (!hasData) return { home: {}, away: {} };

  const homeOut = toPartial(home, away.goals);
  const awayOut = toPartial(away, home.goals);
  const totalPasses = home.passes + away.passes;
  if (totalPasses > 0) {
    homeOut.possession = roundTo((home.passes / totalPasses) * 100, 2);
    awayOut.possession = roundTo((away.passes / totalPasses) * 100, 2);
  }

  const hasAny =
    Object.values(homeOut).some((v) => v !== null) ||
    Object.values(awayOut).some((v) => v !== null);
  return hasAny ? { home: homeOut, away: awayOut } : { home: {}, away: {} };
}

// ─── match_id resolution ──────────────────────────────────────────────────────

interface ResolvedStatsBombMatch {
  matchId: number;
  homeName: string;
  awayName: string;
}

/**
 * Discriminated outcome so the skip log can tell "the repo was searched and
 * does not contain this match" (genuine not-found) apart from "we could not
 * even reach the repo" (environment failure).
 */
type ResolveOutcome =
  | { status: "found"; match: ResolvedStatsBombMatch }
  | { status: "not-found" }
  | { status: "lookup-failed"; detail: string };

function sameDay(a: string | null, b: string): boolean {
  if (!a) return true;
  return a.slice(0, 10) === b.slice(0, 10);
}

async function resolveMatch(
  match: MatchStatsQuery,
  ctx: SourceContext,
): Promise<ResolveOutcome> {
  const comps = await ctx.http(`${BASE}/competitions.json`, { timeoutMs: ctx.timeoutMs });
  if (comps.status !== "ok") {
    return { status: "lookup-failed", detail: `competitions catalogue fetch failed (${comps.status})` };
  }

  const year = Number(match.date.slice(0, 4)) || new Date().getFullYear();
  // Narrow to the league's own competition when we know it — the open-data
  // repo is mostly historical domestic + international data, so scanning every
  // competition's every season is how most recent matches end up "not found".
  const hintedCompetition = LEAGUE_COMPETITIONS[match.leagueSlug];
  const candidates: Array<{ competition: number; season: number }> = [];
  for (const c of asArray(comps.data)) {
    const rec = asRecord(c);
    const competition = asNumber(rec?.competition_id);
    const season = asNumber(rec?.season_id);
    const seasonName = asString(rec?.season_name) ?? "";
    if (competition == null || season == null) continue;
    if (hintedCompetition != null && competition !== hintedCompetition) continue;
    const parts = seasonName.split("/").map((s) => s.trim());
    const matchesYear = parts.some((n) => {
      const y = Number(n);
      return Number.isFinite(y) && (y === year || y === year + 1);
    });
    if (matchesYear) candidates.push({ competition, season });
  }

  // No season of the hinted competition covers this year → the open-data repo
  // (static, mostly historical) simply does not carry it. Do NOT widen back to
  // a full scan: that is the slow path for every recent match in a
  // competition the repo stopped updating. Return null and let fetch() skip
  // gracefully with a clear log.

  for (const { competition, season } of candidates.slice(0, 12)) {
    const res = await ctx.http(`${BASE}/matches/${competition}/${season}.json`, {
      timeoutMs: ctx.timeoutMs,
    });
    if (res.status !== "ok") continue;
    for (const m of asArray(res.data)) {
      const rec = asRecord(m);
      const homeName = asString(getPath(rec, "home_team.home_team_name"));
      const awayName = asString(getPath(rec, "away_team.away_team_name"));
      const matchId = asNumber(rec?.match_id);
      const date = asString(rec?.match_date);
      if (!homeName || !awayName || matchId == null) continue;
      if (!namesMatch(homeName, match.homeTeam) || !namesMatch(awayName, match.awayTeam)) continue;
      if (!sameDay(date, match.date)) continue;
      return { status: "found", match: { matchId, homeName, awayName } };
    }
  }
  // The catalogue was read and every candidate season searched (or none of
  // the hinted competition's seasons cover this year): the repo genuinely does
  // not contain this match.
  return { status: "not-found" };
}

export const statsbombSource: SourceHandler = {
  name: "StatsBomb",
  capabilities: STATSBOMB_CAPABILITIES,

  available: () => true,

  async fetch(match, ctx): Promise<SourcePayload | null> {
    const outcome = await resolveMatch(match, ctx);
    if (outcome.status !== "found") {
      if (outcome.status === "lookup-failed") {
        ctx.log(`[StatsBomb] Open-data lookup failed (${outcome.detail}) — check network allowlist for raw.githubusercontent.com; skipping.`);
      } else {
        // StatsBomb open data is mostly historical; most current Premier League
        // (and other) matches are simply not in the repo. Skip gracefully with
        // a clear log so the aggregator trace can distinguish "not in repo"
        // from "network failure" or "parse failure".
        ctx.log(`[StatsBomb] Match ${match.eventId} not in StatsBomb open data — skipping.`);
      }
      return null;
    }

    const eventsRes = await ctx.http(`${BASE}/events/${outcome.match.matchId}.json`, {
      timeoutMs: ctx.timeoutMs,
    });
    if (eventsRes.status !== "ok") return null;

    const payload = normaliseStatsBombEvents(
      asArray(eventsRes.data),
      outcome.match.homeName,
      outcome.match.awayName,
    );
    const hasAny =
      Object.values(payload.home).some((v) => v !== null) ||
      Object.values(payload.away).some((v) => v !== null);
    return hasAny ? payload : null;
  },
};
