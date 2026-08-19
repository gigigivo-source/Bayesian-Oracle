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

interface EspnScheduleResponse {
  events?: Array<{
    id?:           string;
    competitions?: Array<{
      status?:      { type?: { state?: string } };
      competitors?: Array<{ id?: string; homeAway?: string }>;
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
      if (
        names.some((nm) => nm === target || nm.includes(target) || target.includes(nm)) &&
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
      if (names.some((nm) => nm === target || nm.includes(target)) && t.team?.id) {
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
  lastN        = 10,
): Promise<TeamStatProfile | null> {
  const resolved = await findTeamId(teamName, preferSlug);
  if (!resolved) return null;
  const { id, slug } = resolved;

  // Soccer seasons span two calendar years — try current and previous.
  const yr = new Date().getFullYear();
  let events: NonNullable<EspnScheduleResponse["events"]> = [];
  for (const season of [yr, yr - 1]) {
    const sched = await ej<EspnScheduleResponse>(
      `${ESPN}/${slug}/teams/${id}/schedule?season=${season}`,
    );
    events = sched?.events ?? [];
    if (events.some((e) => e.competitions?.[0]?.status?.type?.state === "post")) break;
  }

  const finished = events
    .filter((e) => e.competitions?.[0]?.status?.type?.state === "post" && e.id)
    .slice(-lastN);
  if (finished.length === 0) return null;

  const rows: OneMatch[] = [];
  for (const e of finished) {
    const st = await matchStatsForTeam(slug, e.id!, id);
    if (st && (st.shots > 0 || st.corners > 0 || st.fouls > 0)) rows.push(st);
  }
  if (rows.length < 2) return null;

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

// CORE reference kept for potential future season-stats endpoint use.
void CORE;
