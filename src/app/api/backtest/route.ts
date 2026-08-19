import { fetchScoreboard, fetchSummary, type FixtureLite } from "@/lib/espn";
import { runEngineFromReal, evaluateFinishedMatch } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

async function fetchBoxscore(slug: string, eventId: string): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`${ESPN_BASE}/${slug}/summary?event=${eventId}`, {
      next: { revalidate: 86400 },
    });
    if (!res.ok) return null;
    const data = await res.json() as { boxscore?: { teams?: Array<{ statistics?: Array<{ name: string; displayValue: string }> }> } };
    const teams = data.boxscore?.teams;
    if (!teams || teams.length < 2) return null;

    const parse = (stats: Array<{ name: string; displayValue: string }>) => {
      const m: Record<string, number> = {};
      for (const s of stats) m[s.name] = parseFloat(s.displayValue) || 0;
      return m;
    };

    const h = parse(teams[0]?.statistics ?? []);
    const a = parse(teams[1]?.statistics ?? []);

    return {
      homeShots:         h.totalShots        ?? 0, awayShots:         a.totalShots        ?? 0,
      homeSot:           h.shotsOnTarget      ?? 0, awaySot:           a.shotsOnTarget      ?? 0,
      homeCorners:       h.wonCorners         ?? 0, awayCorners:       a.wonCorners         ?? 0,
      homeCards:         h.yellowCards        ?? 0, awayCards:         a.yellowCards        ?? 0,
      homeOffsides:      h.offsides           ?? 0, awayOffsides:      a.offsides           ?? 0,
      homeSaves:         h.saves              ?? 0, awaySaves:         a.saves              ?? 0,
      homeInterceptions: h.interceptions      ?? 0, awayInterceptions: a.interceptions      ?? 0,
      homeFouls:         h.foulsCommitted     ?? 0, awayFouls:         a.foulsCommitted     ?? 0,
    };
  } catch {
    return null;
  }
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const league = searchParams.get("league") ?? "eng.1";
  const months = Math.min(parseInt(searchParams.get("months") ?? "3"), 6);
  const limit  = Math.min(parseInt(searchParams.get("limit")  ?? "30"), 50);

  // Build ESPN date-range string covering the requested window
  const now  = new Date();
  const from = new Date(now);
  from.setMonth(from.getMonth() - months);
  const dateRange = `${fmt(from)}-${fmt(now)}`;

  // fetchScoreboard now accepts an optional dateRange string
  const fixtures = await fetchScoreboard(league, dateRange);
  const finished = (fixtures as FixtureLite[])
    .filter((f) => f.state === "post" && f.home.score !== null)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit);

  let totalHits    = 0;
  let totalMisses  = 0;
  let totalPending = 0;
  let totalPicks   = 0;
  let matchesProcessed = 0;

  const matchResults: Array<{
    match: string;
    score: string;
    date: string;
    hits: number;
    misses: number;
    pending: number;
    accuracy: number;
  }> = [];

  for (const fx of finished) {
    try {
      const summary   = await fetchSummary(league, fx.id);
      const prediction = runEngineFromReal(fx, summary);
      const boxscore  = await fetchBoxscore(league, fx.id);

      evaluateFinishedMatch(fx, prediction, boxscore);

      const h = prediction.hitCount ?? 0;
      const m = prediction.top10.filter((p) => p.outcome === "MISS").length;
      const p = prediction.top10.filter((p) => p.outcome === "PENDING" || !p.outcome).length;

      totalHits    += h;
      totalMisses  += m;
      totalPending += p;
      totalPicks   += prediction.top10.length;
      matchesProcessed++;

      matchResults.push({
        match:    `${fx.home.name} vs ${fx.away.name}`,
        score:    `${fx.home.score}-${fx.away.score}`,
        date:     fx.date.slice(0, 10),
        hits:     h,
        misses:   m,
        pending:  p,
        accuracy: (h + m) > 0 ? h / (h + m) : 0,
      });

      // Polite rate-limit — avoid hammering ESPN
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // Skip individual failed matches silently
    }
  }

  const totalVerified   = totalHits + totalMisses;
  const overallAccuracy = totalVerified > 0 ? totalHits / totalVerified : 0;

  return Response.json({
    league,
    months,
    matchesFound:     finished.length,
    matchesProcessed,
    totalPicks,
    totalHits,
    totalMisses,
    totalPending,
    overallAccuracy,
    matchResults,
  });
}
