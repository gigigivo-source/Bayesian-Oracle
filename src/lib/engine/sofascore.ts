// ĞIGI GIVØ — Real per-team statistical distributions.
// Primary source: ESPN public API (reachable from server, no key, real boxscore
// stats). Aggregates each team's recent finished matches into mean±std spreads
// for shots, SOT, corners, cards, fouls, offsides, saves — so calibration is
// grounded in OBSERVED data instead of Poisson estimates from goal λ.
//
// (SofaScore's public API 403s datacenter IPs, so ESPN is used as the reliable
//  equivalent real-data source. Interface is source-agnostic.)

import { LEAGUES } from "../leagues";
import { resilientJson } from "../httpClient";
import type { FormGame, TeamForm } from "../espn";

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const CORE = "https://sports.core.api.espn.com/v2/sports/soccer";

async function ej<T>(url: string): Promise<T | null> {
  return resilientJson<T>(url, { revalidate: 3600, cacheTtlMs: 3600 * 1000 });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StatDistribution {
  mean: number;
  std:  number;
  n:    number;
}

export interface TeamStatProfile {
  teamId:        string;
  samples:       number;
  shots:         StatDistribution;
  sot:           StatDistribution;
  corners:       StatDistribution;
  cards:         StatDistribution;
  fouls:         StatDistribution;
  offsides:      StatDistribution;
  saves:         StatDistribution;
  possession:    StatDistribution;
  // Extended real distributions (all from ESPN's 28-stat boxscore)
  passes:        StatDistribution;
  passAccuracy:  StatDistribution;
  crosses:       StatDistribution;
  longBalls:     StatDistribution;
  tackles:       StatDistribution;
  clearances:    StatDistribution;
  interceptions: StatDistribution;
  blockedShots:  StatDistribution;
}

// ─── ESPN raw shapes ──────────────────────────────────────────────────────────

interface EspnTeamEntry {
  team?: {
    id?:              string;
    displayName?:     string;
    shortDisplayName?: string;
    abbreviation?:    string;
  };
}

interface EspnTeamsResponse {
  sports?: Array<{
    leagues?: Array<{ teams?: EspnTeamEntry[] }>;
  }>;
}

interface EspnScheduleCompetitor {
  id?:       string;
  homeAway?: string;
  score?:    number | string | { value?: number; displayValue?: string } | null;
  team?:     {
    id?:               string;
    displayName?:      string;
    shortDisplayName?: string;
    logo?:             string;
    logos?:            Array<{ href?: string }>;
  };
}

interface EspnScheduleResponse {
  events?: Array<{
    id?:           string;
    date?:         string;
    seasonType?:   { name?: string };
    league?:       { name?: string };
    competitions?: Array<{
      status?:      { type?: { state?: string } };
      competitors?: EspnScheduleCompetitor[];
    }>;
  }>;
}

interface EspnSummaryBox {
  boxscore?: {
    teams?: Array<{
      team?:       { id?: string };
      statistics?: Array<{ name?: string; displayValue?: string }>;
    }>;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function num(v: string | undefined): number {
  if (!v) return 0;
  const m = v.match(/[\d.]+/);
  return m ? Number(m[0]) : 0;
}

function distribution(values: number[]): StatDistribution {
  const n = values.length;
  if (n === 0) return { mean: 0, std: 0, n: 0 };
  const mean     = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance), n };
}

interface OneMatch {
  shots: number; sot: number; corners: number; cards: number;
  fouls: number; offsides: number; saves: number; possession: number;
  passes: number; passAccuracy: number; crosses: number; longBalls: number;
  tackles: number; clearances: number; interceptions: number; blockedShots: number;
}

// ─── Team ID resolution ───────────────────────────────────────────────────────

/**
 * Resolve a team NAME to an ESPN team ID by scanning league team lists.
 * Searches the fixture's own league first, then the big-5, then the full
 * catalog (capped at 20 unique leagues for latency).
 */
export async function findTeamId(
  teamName:    string,
  preferSlug?: string,
): Promise<{ id: string; slug: string } | null> {
  const target = teamName.toLowerCase();
  const slugs  = [
    ...(preferSlug ? [preferSlug] : []),
    "eng.1", "esp.1", "ita.1", "ger.1", "fra.1",
    "usa.1", "mex.1", "bra.1", "ned.1", "por.1",
  ];
  const tried = new Set<string>();

  for (const slug of slugs) {
    if (tried.has(slug)) continue;
    tried.add(slug);
    const data  = await ej<EspnTeamsResponse>(`${ESPN}/${slug}/teams`);
    const teams = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];
    for (const t of teams) {
      const names = [t.team?.displayName, t.team?.shortDisplayName, t.team?.abbreviation]
        .filter(Boolean)
        .map((x) => x!.toLowerCase());
      if (names.some((nm) => nm === target) && t.team?.id) {
        return { id: t.team.id, slug };
      }
    }
    for (const t of teams) {
      const names = [t.team?.displayName, t.team?.shortDisplayName]
        .filter(Boolean)
        .map((x) => x!.toLowerCase());
      if (
        names.some((nm) => nm.length >= 4 && (nm.includes(target) || target.includes(nm))) &&
        t.team?.id
      ) {
        return { id: t.team.id, slug };
      }
    }
  }

  // Broaden across the full catalog as a last resort (capped at 20 unique leagues).
  for (const lg of LEAGUES) {
    if (tried.has(lg.slug)) continue;
    tried.add(lg.slug);
    const data  = await ej<EspnTeamsResponse>(`${ESPN}/${lg.slug}/teams`);
    const teams = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];
    for (const t of teams) {
      const names = [t.team?.displayName, t.team?.shortDisplayName]
        .filter(Boolean)
        .map((x) => x!.toLowerCase());
      if (names.some((nm) => nm === target) && t.team?.id) {
        return { id: t.team.id, slug: lg.slug };
      }
    }
    for (const t of teams) {
      const names = [t.team?.displayName, t.team?.shortDisplayName]
        .filter(Boolean)
        .map((x) => x!.toLowerCase());
      if (names.some((nm) => nm.length >= 4 && nm.includes(target)) && t.team?.id) {
        return { id: t.team.id, slug: lg.slug };
      }
    }
    if (tried.size > 20) break;
  }
  return null;
}

// ─── Per-match boxscore ───────────────────────────────────────────────────────

async function matchStatsForTeam(
  slug:    string,
  eventId: string,
  teamId:  string,
): Promise<OneMatch | null> {
  const data  = await ej<EspnSummaryBox>(`${ESPN}/${slug}/summary?event=${eventId}`);
  const teams = data?.boxscore?.teams;
  if (!teams || teams.length < 2) return null;

  const side  = teams.find((t) => t.team?.id === teamId) ?? teams[0];
  const stats = side.statistics ?? [];

  const g = (names: string[]): number => {
    for (const s of stats) {
      if (names.some((nm) => (s.name ?? "").toLowerCase() === nm.toLowerCase())) {
        return num(s.displayValue);
      }
    }
    return 0;
  };

  return {
    shots:         g(["totalShots",       "shotsSummary"]),
    sot:           g(["shotsOnTarget",    "onTargetShots"]),
    corners:       g(["wonCorners",       "corners"]),
    cards:         g(["yellowCards"])     + g(["redCards"]),
    fouls:         g(["foulsCommitted",   "fouls"]),
    offsides:      g(["offsides"]),
    saves:         g(["saves",            "goalKeeperSaves"]),
    possession:    g(["possessionPct"]),
    passes:        g(["totalPasses"]),
    passAccuracy:  g(["passPct"]),
    crosses:       g(["totalCrosses"]),
    longBalls:     g(["totalLongBalls"]),
    tackles:       g(["totalTackles"]),
    clearances:    g(["totalClearance"]),
    interceptions: g(["interceptions"]),
    blockedShots:  g(["blockedShots"]),
  };
}

// ─── Public: build profile ────────────────────────────────────────────────────

/**
 * Build a real per-team stat profile from the team's most recent finished
 * matches (via ESPN). Returns null if unavailable — caller falls back to the
 * Poisson-derived anchors.
 */
export async function buildTeamStatProfile(
  teamName:    string,
  preferSlug?: string,
  beforeDate?: string,
): Promise<TeamStatProfile | null> {
  const lastN = 20;
  const cutoff = beforeDate === undefined ? null : Date.parse(beforeDate);
  if (cutoff !== null && !Number.isFinite(cutoff)) return null;
  const resolved = await findTeamId(teamName, preferSlug);
  if (!resolved) return null;
  const { id, slug } = resolved;

  // Historical requests must choose seasons relative to the fixture, not today.
  const yr = cutoff === null ? new Date().getFullYear() : new Date(cutoff).getUTCFullYear();
  let events: NonNullable<EspnScheduleResponse["events"]> = [];
  for (const season of [yr, yr - 1]) {
    const sched = await ej<EspnScheduleResponse>(
      `${ESPN}/${slug}/teams/${id}/schedule?season=${season}`,
    );
    const seasonEvents = sched?.events ?? [];
    if (cutoff === null) {
      events = seasonEvents;
      if (events.some((e) => e.competitions?.[0]?.status?.type?.state === "post")) break;
    } else {
      events.push(...seasonEvents);
    }
  }

  const eligible = events.filter((e) => {
    if (e.competitions?.[0]?.status?.type?.state !== "post" || !e.id) return false;
    if (cutoff === null) return true;
    if (!e.date) return false;
    const time = Date.parse(e.date);
    return Number.isFinite(time) && time < cutoff &&
      (e.date.includes("T") || e.date.slice(0, 10) < beforeDate!.slice(0, 10));
  });
  // Deduplicate overlapping season schedules and sort before selecting the window.
  const unique = [...new Map(eligible.map((e) => [e.id, e])).values()];
  if (cutoff !== null) unique.sort((a, b) => Date.parse(a.date!) - Date.parse(b.date!));
  const finished = unique.slice(-lastN);
  if (finished.length === 0) return null;

  // Walk the finished matches with bounded concurrency (8 in flight) instead
  // of a strictly sequential loop — each ESPN boxscore can take up to ~12s,
  // so 20 sequential calls can stall a single team profile for minutes.
  // Same rows collected: per-call failures still degrade to a skipped row,
  // and the usable-stat filter below is unchanged.
  const CONCURRENCY = 8;
  const rows: OneMatch[] = [];
  for (let i = 0; i < finished.length; i += CONCURRENCY) {
    const batch = finished.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((e) => matchStatsForTeam(slug, e.id!, id).catch(() => null)),
    );
    for (const st of results) {
      if (st && (st.shots > 0 || st.corners > 0 || st.fouls > 0)) rows.push(st);
    }
  }
  // A single match's corner/card counts are a weak signal but real data —
  // callers already see the sample count via `samples` and can down-weight it.
  if (rows.length < 1) return null;

  return {
    teamId:        id,
    samples:       rows.length,
    shots:         distribution(rows.map((r) => r.shots)),
    sot:           distribution(rows.map((r) => r.sot)),
    corners:       distribution(rows.map((r) => r.corners)),
    cards:         distribution(rows.map((r) => r.cards)),
    fouls:         distribution(rows.map((r) => r.fouls)),
    offsides:      distribution(rows.map((r) => r.offsides)),
    saves:         distribution(rows.map((r) => r.saves)),
    possession:    distribution(rows.map((r) => r.possession)),
    passes:        distribution(rows.map((r) => r.passes)),
    passAccuracy:  distribution(rows.map((r) => r.passAccuracy)),
    crosses:       distribution(rows.map((r) => r.crosses)),
    longBalls:     distribution(rows.map((r) => r.longBalls)),
    tackles:       distribution(rows.map((r) => r.tackles)),
    clearances:    distribution(rows.map((r) => r.clearances)),
    interceptions: distribution(rows.map((r) => r.interceptions)),
    blockedShots:  distribution(rows.map((r) => r.blockedShots)),
  };
}

function parseCompetitorScore(
  raw: EspnScheduleCompetitor["score"],
): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  if (raw && typeof raw === "object") {
    if (typeof raw.value === "number" && Number.isFinite(raw.value)) return raw.value;
    if (typeof raw.displayValue === "string" && raw.displayValue.trim() !== "") {
      const n = Number(raw.displayValue.trim());
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/**
 * Build a point-in-time TeamForm from the last `lastN` (default 5) completed
 * matches played strictly BEFORE `beforeDate` using the team's ESPN schedule.
 */
export async function buildHistoricalTeamForm(
  teamName:   string,
  preferSlug: string | undefined,
  beforeDate: string,
  lastN = 5,
): Promise<TeamForm | null> {
  const cutoff = Date.parse(beforeDate);
  if (!Number.isFinite(cutoff)) return null;

  const resolved = await findTeamId(teamName, preferSlug);
  if (!resolved) return null;
  const { id, slug } = resolved;

  const yr = new Date(cutoff).getUTCFullYear();
  const events: NonNullable<EspnScheduleResponse["events"]> = [];
  for (const season of [yr, yr - 1]) {
    const sched = await ej<EspnScheduleResponse>(
      `${ESPN}/${slug}/teams/${id}/schedule?season=${season}`,
    );
    events.push(...(sched?.events ?? []));
  }

  const eligible = events.filter((e) => {
    if (e.competitions?.[0]?.status?.type?.state !== "post" || !e.id || !e.date) return false;
    const time = Date.parse(e.date);
    return (
      Number.isFinite(time) &&
      time < cutoff &&
      (e.date.includes("T") || e.date.slice(0, 10) < beforeDate.slice(0, 10))
    );
  });

  // Deduplicate overlapping season schedules and sort chronologically ascending.
  const unique = [...new Map(eligible.map((e) => [e.id, e])).values()];
  unique.sort((a, b) => Date.parse(a.date!) - Date.parse(b.date!));

  const parsedGames: FormGame[] = [];
  let resolvedTeamName = teamName;

  for (const ev of unique) {
    const competitors = ev.competitions?.[0]?.competitors ?? [];
    if (competitors.length < 2) continue;

    const us = competitors.find((c) => (c.id ?? c.team?.id) === id);
    const opp = competitors.find((c) => (c.id ?? c.team?.id) !== id);
    if (!us || !opp) continue;

    const scoreFor = parseCompetitorScore(us.score);
    const scoreAgainst = parseCompetitorScore(opp.score);
    if (scoreFor === null || scoreAgainst === null) continue;

    if (us.team?.displayName) resolvedTeamName = us.team.displayName;

    const result: "W" | "L" | "D" =
      scoreFor > scoreAgainst ? "W" : scoreFor < scoreAgainst ? "L" : "D";

    parsedGames.push({
      date: ev.date!,
      opponent: opp.team?.displayName ?? opp.team?.shortDisplayName ?? "?",
      opponentLogo: opp.team?.logo ?? opp.team?.logos?.[0]?.href ?? null,
      result,
      scoreFor,
      scoreAgainst,
      atVs: us.homeAway === "away" ? "@" : "vs",
      competition: ev.league?.name ?? ev.seasonType?.name ?? slug,
    });
  }

  const games = parsedGames.slice(-lastN);
  if (games.length === 0) return null;

  const gfTotal = games.reduce((sum, g) => sum + g.scoreFor, 0);
  const gaTotal = games.reduce((sum, g) => sum + g.scoreAgainst, 0);
  const points = games.reduce(
    (sum, g) => sum + (g.result === "W" ? 3 : g.result === "D" ? 1 : 0),
    0,
  );

  return {
    teamId: id,
    teamName: resolvedTeamName,
    games,
    gfAvg: gfTotal / games.length,
    gaAvg: gaTotal / games.length,
    points,
  };
}

// CORE reference kept for potential future season-stats endpoint use.
void CORE;
