import { fetchScoreboard, type FixtureLite } from "@/lib/espn";
import { LEAGUE_MAP } from "@/lib/leagues";

export const dynamic = "force-dynamic";

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const league = searchParams.get("league");
  const dates  = searchParams.get("dates") ?? undefined;
  const event  = searchParams.get("event");

  if (!league || !LEAGUE_MAP[league]) {
    return Response.json({ error: "Unknown or missing league slug." }, { status: 400 });
  }

  const now   = new Date();
  const from7 = new Date(now); from7.setDate(now.getDate() - 7);
  const to60  = new Date(now); to60.setDate(now.getDate() + 60);  // 60-day lookahead

  // Fetch all windows in parallel for maximum coverage
  const [current, recent, ahead] = await Promise.all([
    fetchScoreboard(league, dates),                               // provided dates or 3-day default
    fetchScoreboard(league, `${fmt(from7)}-${fmt(now)}`),         // last 7 days (results)
    fetchScoreboard(league, `${fmt(now)}-${fmt(to60)}`),          // next 60 days (upcoming)
  ]);

  // Merge and deduplicate by fixture ID
  const seen = new Set<string>();
  const all: FixtureLite[] = [];
  for (const fx of [...current, ...recent, ...ahead]) {
    if (!seen.has(fx.id)) { seen.add(fx.id); all.push(fx); }
  }

  const live     = all.filter((f) => f.state === "in");
  const upcoming = all
    .filter((f) => f.state === "pre")
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const finished = all
    .filter((f) => f.state === "post")
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 20);

  const allUpcoming = [...live, ...upcoming];

  return Response.json({
    league:        LEAGUE_MAP[league],
    fixture:       event ? all.find((fixture) => fixture.id === event) ?? null : undefined,
    fixtures:      [...allUpcoming, ...finished],
    upcoming:      allUpcoming,
    results:       finished,
    upcomingCount: allUpcoming.length,
    resultsCount:  finished.length,
  });
}
