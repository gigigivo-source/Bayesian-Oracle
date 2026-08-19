import { fetchScoreboard, fetchSummary } from "@/lib/espn";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const team1  = searchParams.get("team1")  ?? "";
  const team2  = searchParams.get("team2")  ?? "";
  const league = searchParams.get("league") ?? "eng.1";

  if (!team1 || !team2) {
    return Response.json({ error: "Provide team1 and team2" }, { status: 400 });
  }

  // Find a fixture between these two teams in today's scoreboard
  const fixtures = await fetchScoreboard(league);
  const match = fixtures.find((f) => {
    const names = `${f.home.name} ${f.away.name}`.toLowerCase();
    return (
      names.includes(team1.toLowerCase()) &&
      names.includes(team2.toLowerCase())
    );
  });

  if (!match) {
    return Response.json({
      error: "No fixture found between these teams",
      team1,
      team2,
    });
  }

  const summary = await fetchSummary(league, match.id);

  return Response.json({
    match:       `${match.home.name} vs ${match.away.name}`,
    league:      match.leagueName,
    date:        match.date,
    homeForm:    summary?.homeForm    ?? null,
    awayForm:    summary?.awayForm    ?? null,
    h2h:         summary?.h2h         ?? [],
    odds:        summary?.odds        ?? match.odds ?? null,
    homeLineup:  summary?.homeLineup  ?? [],
    awayLineup:  summary?.awayLineup  ?? [],
    venue:       match.venue          ?? null,
  });
}
