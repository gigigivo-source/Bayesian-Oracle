import { LEAGUES, leaguesByRegion } from "@/lib/leagues";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    leagues:  LEAGUES,
    byRegion: leaguesByRegion(),
    count:    LEAGUES.length,
  });
}
