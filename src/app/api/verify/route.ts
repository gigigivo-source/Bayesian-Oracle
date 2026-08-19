import { fetchSummary, fetchScoreboard, type FixtureLite } from "@/lib/espn";
import { runEngineFromReal, evaluateFinishedMatch } from "@/lib/engine";
import { TOP_FEED_SLUGS } from "@/lib/leagues";

export const dynamic = "force-dynamic";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// ─── ESPN types ───────────────────────────────────────────────────────────────

interface EspnStatEntry { name: string; displayValue: string }
interface EspnBoxscoreResponse {
  boxscore?: { teams?: Array<{ statistics?: EspnStatEntry[] }> };
}

// ─── Boxscore fetch ───────────────────────────────────────────────────────────

async function fetchBoxscore(
  slug: string,
  eventId: string,
): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`${ESPN_BASE}/${slug}/summary?event=${eventId}`, {
      next: { revalidate: 600 },
    });
    if (!res.ok) return null;
    const data = await res.json() as EspnBoxscoreResponse;
    const teams = data.boxscore?.teams;
    if (!teams || teams.length < 2) return null;

    const parse = (stats: EspnStatEntry[]): Record<string, number> => {
      const m: Record<string, number> = {};
      for (const s of stats) m[s.name] = parseFloat(s.displayValue) || 0;
      return m;
    };

    const home = parse(teams[0]?.statistics ?? []);
    const away = parse(teams[1]?.statistics ?? []);

    return {
      homeShots:   home.totalShots    ?? 0, awayShots:   away.totalShots    ?? 0,
      homeSot:     home.shotsOnTarget ?? 0, awaySot:     away.shotsOnTarget ?? 0,
      homeCorners: home.wonCorners    ?? 0, awayCorners: away.wonCorners    ?? 0,
      homeCards:   home.yellowCards   ?? 0, awayCards:   away.yellowCards   ?? 0,
      homeOffsides:home.offsides      ?? 0, awayOffsides:away.offsides      ?? 0,
      homeSaves:   home.saves         ?? 0, awaySaves:   away.saves         ?? 0,
    };
  } catch {
    return null;
  }
}

// ─── Response type ────────────────────────────────────────────────────────────

interface VerifiedMatch {
  fixture:        FixtureLite;
  hitCount:       number;
  evaluatedCount: number;
  top10: Array<{
    name:       string;
    selection:  string;
    hitRate:    number;
    outcome:    string;
    reason?:    string;
  }>;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET() {
  const slugsToCheck = TOP_FEED_SLUGS.slice(0, 8);
  const boards = await Promise.all(slugsToCheck.map((s) => fetchScoreboard(s)));

  const allFinished: FixtureLite[] = boards
    .flat()
    .filter((f) => f.state === "post" && f.home.score !== null)
    .slice(0, 12);

  const verified: VerifiedMatch[] = [];

  // Sequential to avoid flooding ESPN with parallel summary requests
  for (const fx of allFinished.slice(0, 6)) {
    try {
      const [summary, boxscore] = await Promise.all([
        fetchSummary(fx.leagueSlug, fx.id),
        fetchBoxscore(fx.leagueSlug, fx.id),
      ]);

      const prediction = runEngineFromReal(fx, summary);
      evaluateFinishedMatch(fx, prediction, boxscore);

      verified.push({
        fixture:        fx,
        hitCount:       prediction.hitCount       ?? 0,
        evaluatedCount: prediction.evaluatedCount ?? 0,
        top10: prediction.top10.map((m) => ({
          name:      m.name,
          selection: m.selection,
          hitRate:   m.hitRate,
          outcome:   m.outcome ?? "PENDING",
          reason:    m.reason,
        })),
      });
    } catch {
      // Skip individual failed matches — keep processing the rest
    }
  }

  return Response.json({ verified, count: verified.length });
}
