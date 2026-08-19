import { getFinishedMatches, getStandings } from "@/lib/footballData";

export const dynamic = "force-dynamic";

/**
 * GET /api/football-data
 *   ?action=standings&league=eng.1   → league table
 *   ?action=matches&league=eng.1     → recent finished matches
 *   (default)                        → recent PL matches
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") ?? "matches";
  const league = searchParams.get("league") ?? "eng.1";
  const limit  = Math.min(parseInt(searchParams.get("limit") ?? "10"), 50);

  if (!process.env.FOOTBALL_DATA_KEY) {
    return Response.json({ error: "Football-Data.org key not configured" }, { status: 503 });
  }

  if (action === "standings") {
    const standings = await getStandings(league);
    return Response.json({ league, standings, count: standings.length });
  }

  // default: recent finished matches
  const matches = await getFinishedMatches(league, limit);
  return Response.json({ league, matches, count: matches.length });
}
