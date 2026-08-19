import { generatePlayerMarkets, type PlayerProfile } from "@/lib/engine/players";

export const dynamic = "force-dynamic";

const API_FOOTBALL_KEY =
  process.env.API_FOOTBALL_KEY ?? process.env.FOOTBALL_API_KEY ?? "";

interface ApiFootballPlayer {
  player?: { name?: string };
  statistics?: Array<{
    team?:  { name?: string };
    games?: { appearences?: number; position?: string };
    goals?: { total?: number; assists?: number };
    shots?: { total?: number; on?: number };
  }>;
}

interface ApiFootballResponse {
  errors?:   { plan?: string };
  response?: ApiFootballPlayer[];
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const league = searchParams.get("league") ?? "39"; // EPL default
  const season = searchParams.get("season") ?? "2024";

  if (!API_FOOTBALL_KEY) {
    return Response.json({ players: [], error: "API-Football key not configured" });
  }

  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/players/topscorers?league=${league}&season=${season}`,
      {
        headers: { "x-apisports-key": API_FOOTBALL_KEY },
        next:    { revalidate: 3600 },
      },
    );

    if (!res.ok) {
      return Response.json({ players: [], error: "API-Football unavailable" });
    }

    const data = await res.json() as ApiFootballResponse;
    if (data.errors?.plan) {
      return Response.json({ players: [], error: data.errors.plan });
    }

    const players: Array<PlayerProfile & { markets: ReturnType<typeof generatePlayerMarkets> }> = [];

    for (const p of data.response ?? []) {
      const s = p.statistics?.[0];
      if (!s) continue;

      const apps    = s.games?.appearences ?? 1;
      const goals   = s.goals?.total       ?? 0;
      const assists = s.goals?.assists      ?? 0;
      const shots   = s.shots?.total        ?? 0;
      const sot     = s.shots?.on           ?? 0;

      const profile: PlayerProfile = {
        name:          p.player?.name      ?? "Unknown",
        team:          s.team?.name        ?? "Unknown",
        position:      s.games?.position   ?? "F",
        goals,
        assists,
        shots,
        shotsOnTarget: sot,
        appearances:   apps,
        goalsP90:      goals   / Math.max(1, apps),
        shotsP90:      shots   / Math.max(1, apps),
        sotP90:        sot     / Math.max(1, apps),
      };

      players.push({ ...profile, markets: generatePlayerMarkets(profile) });
    }

    return Response.json({ players, league, season, count: players.length });
  } catch {
    return Response.json({ players: [], error: "Failed to fetch player data" });
  }
}
