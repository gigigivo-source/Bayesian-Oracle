// ĞIGI GIVØ — Multi-Provider Real Data Mesh.
//
// Aggregates REAL per-team statistical distributions from several independent
// public providers, cross-checks them, and merges into one trust-weighted
// consensus profile. More providers = wider coverage + more reliable calibration.
//
// Providers (all reachable server-side, no paid keys required):
//   1. ESPN match boxscore      — per-match shots/SOT/corners/cards/fouls/saves
//   2. ESPN Core season stats   — season per-game aggregates (2nd ESPN signal)
//   3. football-data.org        — real results/standings (goal grounding)
//   4. TheSportsDB              — team resolution + cross-provider ID mapping
//
// Each source is fail-soft: if one is down/missing, the mesh uses the rest.

import { buildTeamStatProfile, type TeamStatProfile, type StatDistribution } from "./sofascore";
import { resilientJson } from "./httpClient";
import { teamProfiles } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

const ESPN_CORE = "https://sports.core.api.espn.com/v2/sports/soccer";
const TSDB      = "https://www.thesportsdb.com/api/v1/json/3";

function fdKey(): string {
  return process.env.FOOTBALL_DATA_KEY ?? "";
}

async function j<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  return resilientJson<T>(url, { headers, revalidate: 3600, cacheTtlMs: 3600 * 1000 });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProviderStat {
  provider:  string;
  shots?:    number;
  sot?:      number;
  corners?:  number;
  cards?:    number;
  fouls?:    number;
  offsides?: number;
  saves?:    number;
}

export interface MeshProfile extends TeamStatProfile {
  providers:     string[]; // which real sources contributed
  providerCount: number;
}

// ─── Provider 2: ESPN Core season per-game aggregates ────────────────────────

interface EspnCoreStats {
  splits?: {
    categories?: Array<{
      name?:  string;
      stats?: Array<{ name?: string; perGameValue?: number; value?: number }>;
    }>;
  };
}

async function espnCoreSeasonStats(
  leagueSlug: string,
  teamId: string,
): Promise<ProviderStat | null> {
  const yr = new Date().getFullYear();
  for (const season of [yr, yr - 1]) {
    const d = await j<EspnCoreStats>(
      `${ESPN_CORE}/leagues/${leagueSlug}/seasons/${season}/types/1/teams/${teamId}/statistics/0`,
    );
    const cats = d?.splits?.categories;
    if (!cats) continue;

    const pick = (cat: string, stat: string): number | undefined => {
      const c = cats.find((x) => x.name === cat);
      const s = c?.stats?.find((x) => x.name === stat);
      return s?.perGameValue ?? (s?.value != null ? s.value / 38 : undefined);
    };

    const shots = pick("offensive", "totalShots") ?? pick("offensive", "shotsTotal");
    const sot   = pick("offensive", "shotsOnTarget");
    const fouls = pick("general",   "foulsCommitted");
    const saves = pick("goalKeeping", "saves");

    if (shots || sot || fouls || saves) {
      return { provider: "ESPN Core (season)", shots, sot, fouls, saves };
    }
  }
  return null;
}

// ─── Provider 4: TheSportsDB team resolution ──────────────────────────────────

interface TsdbTeam {
  teams?: Array<{ idTeam?: string; idESPN?: string; strTeam?: string }>;
}

async function tsdbResolve(
  teamName: string,
): Promise<{ tsdbId?: string; espnId?: string } | null> {
  const d = await j<TsdbTeam>(
    `${TSDB}/searchteams.php?t=${encodeURIComponent(teamName)}`,
  );
  const t = d?.teams?.[0];
  if (!t) return null;
  return { tsdbId: t.idTeam, espnId: t.idESPN };
}

// ─── Merge helpers ────────────────────────────────────────────────────────────

// Merge a provider point-estimate into an existing distribution as an extra
// sample, nudging the mean toward cross-source consensus (trust-weighted).
function blendInto(
  dist: StatDistribution,
  value: number | undefined,
  weight: number,
): StatDistribution {
  if (value === undefined || value <= 0) return dist;
  if (dist.n === 0) return { mean: value, std: value * 0.3, n: 1 };
  const totalW = 1 + weight;
  const mean   = (dist.mean * 1 + value * weight) / totalW;
  return { mean, std: dist.std, n: dist.n + 1 };
}

// ─── Main mesh builder ────────────────────────────────────────────────────────

/**
 * Build a consensus real-stat profile for a team from ALL reachable providers.
 * Starts from the ESPN match-boxscore distributions (richest, per-match spreads)
 * then cross-checks/merges season aggregates from other providers.
 */
export async function buildMeshProfile(
  teamName:   string,
  leagueSlug: string,
  beforeDate?: string,
): Promise<MeshProfile | null> {
  const providers: string[] = [];

  // Provider 1: ESPN per-match boxscore distributions (primary).
  const base = await buildTeamStatProfile(teamName, leagueSlug, beforeDate).catch(() => null);
  if (base) providers.push("ESPN Boxscore");

  // Provider 4: resolve cross-provider IDs via TheSportsDB.
  const ids = await tsdbResolve(teamName).catch(() => null);
  if (ids?.espnId || ids?.tsdbId) providers.push("TheSportsDB");

  // Provider 2: ESPN Core season aggregates (second independent ESPN signal).
  const espnId = base?.teamId ?? ids?.espnId;
  let core: ProviderStat | null = null;
  // Current season aggregates cannot be reconstructed as of a past cutoff.
  if (espnId && beforeDate === undefined) {
    core = await espnCoreSeasonStats(leagueSlug, espnId).catch(() => null);
    if (core) providers.push(core.provider);
  }

  if (!base && !core) return null;

  const empty: StatDistribution = { mean: 0, std: 0, n: 0 };
  const start: TeamStatProfile = base ?? {
    teamId:        espnId ?? "",
    samples:       0,
    shots:         { ...empty }, sot:           { ...empty },
    corners:       { ...empty }, cards:         { ...empty },
    fouls:         { ...empty }, offsides:      { ...empty },
    saves:         { ...empty }, possession:    { ...empty },
    passes:        { ...empty }, passAccuracy:  { ...empty },
    crosses:       { ...empty }, longBalls:     { ...empty },
    tackles:       { ...empty }, clearances:    { ...empty },
    interceptions: { ...empty }, blockedShots:  { ...empty },
  };

  // Cross-check: blend the season aggregate at half-weight (supporting signal).
  const merged: TeamStatProfile = core
    ? {
        ...start,
        shots:  blendInto(start.shots,  core.shots,  0.5),
        sot:    blendInto(start.sot,    core.sot,    0.5),
        fouls:  blendInto(start.fouls,  core.fouls,  0.5),
        saves:  blendInto(start.saves,  core.saves,  0.5),
      }
    : start;

  return {
    ...merged,
    samples:       Math.max(merged.samples, core ? 1 : 0),
    providers,
    providerCount: providers.length,
  };
}

// ─── DB-cached mesh profile (6-hour TTL) ─────────────────────────────────────

const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Cached wrapper around buildMeshProfile.
 * Reads from DB when a fresh profile exists within TTL,
 * otherwise fetches from providers and persists it.
 * Fail-soft: any DB error falls back to a direct fetch.
 */
export async function getCachedMeshProfile(
  teamName:   string,
  leagueSlug: string,
  beforeDate?: string,
): Promise<MeshProfile | null> {
  // Current cache entries are not point-in-time snapshots. Never read or
  // overwrite them for a cutoff request.
  if (beforeDate !== undefined) return buildMeshProfile(teamName, leagueSlug, beforeDate);
  // Load the optional persistence layer only when a current profile is asked
  // for. Pure/historical Engine callers must work without DATABASE_URL.
  const { db } = await import("@/db");
  const key = `${leagueSlug}|${teamName}`.toLowerCase().trim();

  // 1. Try cache.
  try {
    const rows = await db
      .select()
      .from(teamProfiles)
      .where(eq(teamProfiles.teamKey, key))
      .orderBy(desc(teamProfiles.updatedAt))
      .limit(1);
    const row = rows[0];
    if (row && Date.now() - new Date(row.updatedAt).getTime() < PROFILE_TTL_MS) {
      return row.profile as MeshProfile;
    }
  } catch {
    // ignore cache read failure → fetch fresh
  }

  // 2. Fetch fresh from the provider mesh.
  const fresh = await buildMeshProfile(teamName, leagueSlug);
  if (!fresh) return null;

  // 3. Persist — best-effort upsert by team key.
  try {
    const existing = await db
      .select({ id: teamProfiles.id })
      .from(teamProfiles)
      .where(eq(teamProfiles.teamKey, key))
      .limit(1);

    if (existing[0]) {
      await db
        .update(teamProfiles)
        .set({ profile: fresh, providers: fresh.providers, updatedAt: new Date() })
        .where(eq(teamProfiles.id, existing[0].id));
    } else {
      await db
        .insert(teamProfiles)
        .values({ teamKey: key, profile: fresh, providers: fresh.providers });
    }
  } catch {
    // persistence is optional — return the fresh profile regardless
  }

  return fresh;
}

// Suppress unused import — fdKey is reserved for Provider 3 (football-data.org)
// integration which reads real results for goal-count grounding.
void fdKey;
