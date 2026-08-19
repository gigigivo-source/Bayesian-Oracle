// football-data.org integration — 13 competitions, match results, standings
const BASE = "https://api.football-data.org/v4";

function getKey(): string {
  return process.env.FOOTBALL_DATA_KEY ?? "";
}

async function fdFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { "X-Auth-Token": getKey() },
      next: { revalidate: 600 },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ── ESPN slug → football-data.org competition code ────────────────────────────
const COMP_MAP: Record<string, string> = {
  "eng.1":          "PL",
  "esp.1":          "PD",
  "ger.1":          "BL1",
  "ita.1":          "SA",
  "fra.1":          "FL1",
  "ned.1":          "DED",
  "por.1":          "PPL",
  "eng.2":          "ELC",
  "bra.1":          "BSA",
  "uefa.champions": "CL",
  "uefa.euro":      "EC",
  "fifa.world":     "WC",
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FdMatch {
  homeTeam:    string;
  awayTeam:    string;
  homeScore:   number | null;
  awayScore:   number | null;
  date:        string;
  status:      string;
  competition: string;
}

// ─── Internal ESPN shapes ─────────────────────────────────────────────────────

interface FdRawMatch {
  homeTeam:    { name: string };
  awayTeam:    { name: string };
  score:       { fullTime: { home: number | null; away: number | null } };
  utcDate:     string;
  status:      string;
  competition: { name: string };
}

interface FdStandingsEntry {
  position:       number;
  team:           { name: string };
  playedGames:    number;
  won:            number;
  draw:           number;
  lost:           number;
  goalsFor:       number;
  goalsAgainst:   number;
  goalDifference: number;
  points:         number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Get recent finished matches from football-data.org */
export async function getFinishedMatches(
  leagueSlug: string,
  limit = 10,
): Promise<FdMatch[]> {
  const comp = COMP_MAP[leagueSlug];
  if (!comp) return [];

  const data = await fdFetch<{ matches: FdRawMatch[] }>(
    `/competitions/${comp}/matches?status=FINISHED&limit=${limit}`,
  );
  if (!data?.matches) return [];

  return data.matches.map((m) => ({
    homeTeam:    m.homeTeam.name,
    awayTeam:    m.awayTeam.name,
    homeScore:   m.score?.fullTime?.home ?? null,
    awayScore:   m.score?.fullTime?.away ?? null,
    date:        m.utcDate?.slice(0, 10) ?? "",
    status:      m.status,
    competition: m.competition?.name ?? "",
  }));
}

/** Get standings from football-data.org */
export async function getStandings(leagueSlug: string): Promise<Array<{
  position:       number;
  team:           string;
  played:         number;
  won:            number;
  draw:           number;
  lost:           number;
  goalsFor:       number;
  goalsAgainst:   number;
  goalDifference: number;
  points:         number;
}>> {
  const comp = COMP_MAP[leagueSlug];
  if (!comp) return [];

  const data = await fdFetch<{ standings: Array<{ table: FdStandingsEntry[] }> }>(
    `/competitions/${comp}/standings`,
  );
  if (!data?.standings?.[0]?.table) return [];

  return data.standings[0].table.map((t) => ({
    position:       t.position,
    team:           t.team.name,
    played:         t.playedGames,
    won:            t.won,
    draw:           t.draw,
    lost:           t.lost,
    goalsFor:       t.goalsFor,
    goalsAgainst:   t.goalsAgainst,
    goalDifference: t.goalDifference,
    points:         t.points,
  }));
}
