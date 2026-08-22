import { fetchScoreboard, type FixtureLite } from "@/lib/espn";
import { LEAGUE_MAP } from "@/lib/leagues";
import { compareLeaguePriority } from "@/lib/leaguePriority";

export const dynamic = "force-dynamic";

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const league = searchParams.get("league");
  const dates  = searchParams.get("dates") ?? undefined;

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

  // League-priority comparator (biggest competitions first); ties fall through
  // to date ordering handled per-section below.
  const byPriorityThenDateAsc = (a: FixtureLite, b: FixtureLite) =>
    compareLeaguePriority(a, b) ||
    new Date(a.date).getTime() - new Date(b.date).getTime();
  const byPriorityThenDateDesc = (a: FixtureLite, b: FixtureLite) =>
    compareLeaguePriority(a, b) ||
    new Date(b.date).getTime() - new Date(a.date).getTime();

  const live     = all
    .filter((f) => f.state === "in")
    .sort(byPriorityThenDateAsc);
  const upcoming = all
    .filter((f) => f.state === "pre")
    .sort(byPriorityThenDateAsc);
  const finished = all
    .filter((f) => f.state === "post")
    .sort(byPriorityThenDateDesc)
    .slice(0, 20);

  const allUpcoming = [...live, ...upcoming].sort(byPriorityThenDateAsc);

  return Response.json({
    league:        LEAGUE_MAP[league],
    fixtures:      [...allUpcoming, ...finished],
    upcoming:      allUpcoming,
    results:       finished,
    upcomingCount: allUpcoming.length,
    resultsCount:  finished.length,
  });
}
