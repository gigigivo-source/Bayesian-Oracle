import { apiError } from "@/lib/apiErrors";
import { LEAGUES, leaguesByRegion } from "@/lib/leagues";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
  return Response.json({
    leagues:  LEAGUES,
    byRegion: leaguesByRegion(),
    count:    LEAGUES.length,
  });

  } catch (__routeError) {
    return apiError("GET /api/leagues failed", __routeError);
  }
}
