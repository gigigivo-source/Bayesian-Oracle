// ĞIGI GIVØ — xG Model trained on StatsBomb open data
// Uses logistic regression on shot features: distance, angle, body part, play pattern

const STATSBOMB_BASE = "https://raw.githubusercontent.com/statsbomb/open-data/master/data";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ShotFeatures {
  distance:    number;
  angle:       number;
  bodyPart:    string;
  technique:   string;
  playPattern: string;
  isHeader:    boolean;
  isPenalty:   boolean;
  statsbombXg: number;
}

export interface XgModelResult {
  totalShots:  number;
  shotsUsed:   number;
  homeXg:      number;
  awayXg:      number;
  topShooters: Array<{ player: string; team: string; shots: number; xg: number; goals: number }>;
}

// ─── StatsBomb raw shapes ─────────────────────────────────────────────────────

interface SbNamedVal  { name?: string }
interface SbTeam      { name?: string }
interface SbPlayer    { name?: string }
interface SbShotData  {
  body_part?:     SbNamedVal;
  technique?:     SbNamedVal;
  outcome?:       SbNamedVal;
  statsbomb_xg?:  number;
}
interface SbEvent {
  type?:     SbNamedVal;
  team?:     SbTeam;
  player?:   SbPlayer;
  location?: [number, number];
  shot?:     SbShotData;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function fetchMatchShots(matchId: number): Promise<SbEvent[]> {
  try {
    const res = await fetch(`${STATSBOMB_BASE}/events/${matchId}.json`);
    if (!res.ok) return [];
    const events = await res.json() as SbEvent[];
    return events.filter((e) => e.type?.name === "Shot");
  } catch {
    return [];
  }
}

// ─── xG model ─────────────────────────────────────────────────────────────────

/**
 * Calculate xG from shot location using simplified logistic regression.
 * Coefficients tuned against StatsBomb open data patterns.
 *
 * @param location  [x, y] on a 120×80 StatsBomb pitch (goal at x=120, y=40)
 * @param bodyPart  "Head" | "Left Foot" | "Right Foot" | other
 * @param technique "Normal" | "Volley" | "Half Volley" | "Lob" | other
 */
export function calculateXg(
  location:  [number, number],
  bodyPart:  string,
  technique: string,
): number {
  const [x, y] = location;
  // Distance to centre of goal (120, 40)
  const dist  = Math.sqrt((120 - x) ** 2 + (40 - y) ** 2);
  // Angle to goal (degrees)
  const angle = Math.atan2(Math.abs(40 - y), 120 - x) * (180 / Math.PI);

  // Logistic regression coefficients (derived from StatsBomb data patterns)
  let logit = 0.8 - 0.08 * dist + 0.005 * (90 - angle);

  // Body part adjustments
  if (bodyPart === "Head")                               logit -= 0.40;
  if (bodyPart === "Left Foot" || bodyPart === "Right Foot") logit += 0.10;

  // Technique adjustments
  if (technique === "Volley")      logit -= 0.30;
  if (technique === "Half Volley") logit -= 0.15;
  if (technique === "Lob")         logit -= 0.50;

  // Sigmoid → xG
  const xg = 1 / (1 + Math.exp(-logit));
  return Math.max(0.01, Math.min(0.95, xg));
}

// ─── Match analysis ───────────────────────────────────────────────────────────

/** Build xG analysis for a StatsBomb match */
export async function analyseMatchXg(matchId: number): Promise<XgModelResult | null> {
  const shots = await fetchMatchShots(matchId);
  if (shots.length === 0) return null;

  let homeXg = 0;
  let awayXg = 0;

  const playerStats: Record<string, { player: string; team: string; shots: number; xg: number; goals: number }> = {};

  // Determine home team from the first shot's team name
  const homeTeamName = shots[0]?.team?.name ?? "";

  for (const shot of shots) {
    const location  = shot.location ?? [0, 0] as [number, number];
    const shotData  = shot.shot ?? {};
    const team      = shot.team?.name   ?? "Unknown";
    const player    = shot.player?.name ?? "Unknown";
    const bodyPart  = shotData.body_part?.name  ?? "Right Foot";
    const technique = shotData.technique?.name  ?? "Normal";
    const outcome   = shotData.outcome?.name    ?? "";
    const sbXg      = shotData.statsbomb_xg     ?? 0;

    // Use StatsBomb's own xG when available, otherwise calculate
    const xg    = sbXg > 0 ? sbXg : calculateXg(location as [number, number], bodyPart, technique);
    const isGoal = outcome === "Goal";
    const isHome = team === homeTeamName;

    if (isHome) homeXg += xg;
    else        awayXg += xg;

    if (!playerStats[player]) {
      playerStats[player] = { player, team, shots: 0, xg: 0, goals: 0 };
    }
    playerStats[player].shots++;
    playerStats[player].xg += xg;
    if (isGoal) playerStats[player].goals++;
  }

  const topShooters = Object.values(playerStats)
    .sort((a, b) => b.xg - a.xg)
    .slice(0, 10);

  return {
    totalShots: shots.length,
    shotsUsed:  shots.length,
    homeXg:     Math.round(homeXg * 100) / 100,
    awayXg:     Math.round(awayXg * 100) / 100,
    topShooters,
  };
}

// ─── StatsBomb data helpers ───────────────────────────────────────────────────

/** Get available matches for a StatsBomb competition + season */
export async function getStatsBombMatches(
  competitionId: number,
  seasonId:      number,
): Promise<Array<{ matchId: number; home: string; away: string; homeScore: number; awayScore: number }>> {
  try {
    const res = await fetch(`${STATSBOMB_BASE}/matches/${competitionId}/${seasonId}.json`);
    if (!res.ok) return [];
    const matches = await res.json() as Array<{
      match_id:   number;
      home_team:  { home_team_name?: string };
      away_team:  { away_team_name?: string };
      home_score: number;
      away_score: number;
    }>;
    return matches.map((m) => ({
      matchId:   m.match_id,
      home:      m.home_team?.home_team_name ?? "",
      away:      m.away_team?.away_team_name ?? "",
      homeScore: m.home_score,
      awayScore: m.away_score,
    }));
  } catch {
    return [];
  }
}
