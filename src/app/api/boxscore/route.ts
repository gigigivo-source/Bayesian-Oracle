import { LEAGUE_MAP } from "@/lib/leagues";

export const dynamic = "force-dynamic";

const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

interface BoxscoreStat {
  name: string;
  home: string;
  away: string;
}

interface EspnStatEntry {
  name: string;
  displayValue?: string;
}

interface EspnTeamEntry {
  team?: { displayName?: string };
  statistics?: EspnStatEntry[];
}

interface EspnSummaryResponse {
  boxscore?: {
    teams?: EspnTeamEntry[];
  };
}

const STAT_NAMES: Array<{ key: string; label: string }> = [
  { key: "possessionPct",    label: "Possession %" },
  { key: "totalShots",       label: "Total Shots" },
  { key: "shotsOnTarget",    label: "Shots on Target" },
  { key: "wonCorners",       label: "Corners" },
  { key: "yellowCards",      label: "Yellow Cards" },
  { key: "redCards",         label: "Red Cards" },
  { key: "foulsCommitted",   label: "Fouls" },
  { key: "offsides",         label: "Offsides" },
  { key: "saves",            label: "Saves" },
  { key: "totalPasses",      label: "Total Passes" },
  { key: "accuratePasses",   label: "Accurate Passes" },
  { key: "passPct",          label: "Pass Accuracy" },
  { key: "totalTackles",     label: "Tackles" },
  { key: "interceptions",    label: "Interceptions" },
  { key: "totalClearance",   label: "Clearances" },
  { key: "blockedShots",     label: "Blocked Shots" },
];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const league  = searchParams.get("league");
  const eventId = searchParams.get("event");

  if (!league || !eventId || !LEAGUE_MAP[league]) {
    return Response.json({ error: "Missing league or event." }, { status: 400 });
  }

  try {
    const res = await fetch(`${BASE}/${league}/summary?event=${eventId}`, {
      next: { revalidate: 120 },
    });
    if (!res.ok) return Response.json({ stats: [], error: "Feed unavailable" });

    const data = await res.json() as EspnSummaryResponse;
    const teams = data.boxscore?.teams ?? [];
    if (teams.length < 2) return Response.json({ stats: [], error: "No boxscore data" });

    const toMap = (entries: EspnStatEntry[] = {}  as unknown as EspnStatEntry[]): Record<string, string> => {
      const m: Record<string, string> = {};
      for (const s of entries) m[s.name] = s.displayValue ?? "";
      return m;
    };

    const homeStats = toMap(teams[0]?.statistics ?? []);
    const awayStats = toMap(teams[1]?.statistics ?? []);

    const stats: BoxscoreStat[] = STAT_NAMES
      .filter((s) => homeStats[s.key] !== undefined || awayStats[s.key] !== undefined)
      .map((s) => ({
        name: s.label,
        home: homeStats[s.key] ?? "—",
        away: awayStats[s.key] ?? "—",
      }));

    const homeTeam = teams[0]?.team?.displayName ?? "Home";
    const awayTeam = teams[1]?.team?.displayName ?? "Away";

    return Response.json({ homeTeam, awayTeam, stats });
  } catch {
    return Response.json({ stats: [], error: "Failed to fetch boxscore" });
  }
}
