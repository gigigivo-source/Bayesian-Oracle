// ĞIGI GIVØ — Live Backtest Engine
// Runs the oracle on real finished matches, evaluates every market against
// real ESPN boxscore data, and reports tier accuracy (Top-1/3/5/10).
// This is the ground-truth accuracy measurement for the engine.

import { fetchScoreboard, fetchSummary } from "@/lib/espn";
import { runEngineFromReal, evaluateFinishedMatch } from "@/lib/engine";
import type { FixtureLite } from "@/lib/espn";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// Leagues with the richest ESPN boxscore data (best for backtesting)
const BACKTEST_LEAGUES = [
  { slug: "eng.1",   name: "Premier League" },
  { slug: "esp.1",   name: "LaLiga" },
  { slug: "ger.1",   name: "Bundesliga" },
  { slug: "ita.1",   name: "Serie A" },
  { slug: "fra.1",   name: "Ligue 1" },
  { slug: "ned.1",   name: "Eredivisie" },
  { slug: "por.1",   name: "Primeira Liga" },
  { slug: "usa.1",   name: "MLS" },
  { slug: "bra.1",   name: "Brasileirão" },
  { slug: "mex.1",   name: "Liga MX" },
  { slug: "arg.1",   name: "Liga Profesional" },
  { slug: "sco.1",   name: "Scottish Prem" },
  { slug: "tur.1",   name: "Süper Lig" },
  { slug: "bel.1",   name: "Pro League" },
  { slug: "ksa.1",   name: "Saudi Pro League" },
];

interface BoxstatEntry { name: string; displayValue: string }

async function fetchBoxscore(slug: string, eventId: string): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`${ESPN_BASE}/${slug}/summary?event=${eventId}`, {
      next: { revalidate: 86400 },
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      boxscore?: { teams?: Array<{ statistics?: BoxstatEntry[] }> }
    };
    const teams = data.boxscore?.teams;
    if (!teams || teams.length < 2) return null;
    const parse = (stats: BoxstatEntry[] = []) => {
      const m: Record<string, number> = {};
      for (const s of stats) m[s.name] = parseFloat(s.displayValue) || 0;
      return m;
    };
    const h = parse(teams[0]?.statistics); const a = parse(teams[1]?.statistics);
    return {
      homeShots: h.totalShots ?? 0, awayShots: a.totalShots ?? 0,
      homeSot: h.shotsOnTarget ?? 0, awaySot: a.shotsOnTarget ?? 0,
      homeCorners: h.wonCorners ?? 0, awayCorners: a.wonCorners ?? 0,
      homeCards: h.yellowCards ?? 0, awayCards: a.yellowCards ?? 0,
      homeOffsides: h.offsides ?? 0, awayOffsides: a.offsides ?? 0,
      homeSaves: h.saves ?? 0, awaySaves: a.saves ?? 0,
      homeInterceptions: h.interceptions ?? 0, awayInterceptions: a.interceptions ?? 0,
      homeFouls: h.foulsCommitted ?? 0, awayFouls: a.foulsCommitted ?? 0,
      homeRedCards: h.redCards ?? 0, awayRedCards: a.redCards ?? 0,
    };
  } catch { return null; }
}

function fmt(d: Date): string { return d.toISOString().slice(0, 10).replace(/-/g, ""); }

interface MatchBacktestResult {
  match:       string;
  league:      string;
  score:       string;
  date:        string;
  // Tier results
  top1:        { pick: string; selection: string; hitRate: number; outcome: "HIT" | "MISS" | "PENDING" | "EMPTY" };
  top3:        Array<{ pick: string; selection: string; outcome: "HIT" | "MISS" | "PENDING" }>;
  top5:        Array<{ pick: string; selection: string; outcome: "HIT" | "MISS" | "PENDING" }>;
  top10:       Array<{ pick: string; selection: string; outcome: "HIT" | "MISS" | "PENDING" }>;
  // Counts
  top1Hit:     boolean;
  top3Hits:    number; top3Total:   number; top3Perfect: boolean;
  top5Hits:    number; top5Total:   number; top5Perfect: boolean;
  top10Hits:   number; top10Total:  number; top10Perfect: boolean;
  // Meta
  boxscoreAvailable: boolean;
  dataCompleteness:  number;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const league    = searchParams.get("league");    // optional: filter to one league
  const days      = Math.min(parseInt(searchParams.get("days") ?? "7"), 30);
  const maxMatches = Math.min(parseInt(searchParams.get("limit") ?? "20"), 50);

  const now  = new Date();
  const from = new Date(now); from.setDate(from.getDate() - days);
  const dateRange = `${fmt(from)}-${fmt(now)}`;

  const leaguesToCheck = league
    ? BACKTEST_LEAGUES.filter((l) => l.slug === league)
    : BACKTEST_LEAGUES;

  // Fetch finished matches across all target leagues
  const allBoards = await Promise.allSettled(
    leaguesToCheck.map(async (l) => {
      const fixtures = await fetchScoreboard(l.slug, dateRange).catch(() => [] as FixtureLite[]);
      return { slug: l.slug, name: l.name, fixtures };
    })
  );

  const finished: Array<{ slug: string; name: string; fx: FixtureLite }> = [];
  for (const r of allBoards) {
    if (r.status !== "fulfilled") continue;
    for (const fx of r.value.fixtures) {
      if (fx.state === "post" && fx.home.score !== null && fx.away.score !== null) {
        finished.push({ slug: r.value.slug, name: r.value.name, fx });
      }
    }
  }

  // Sort newest first, cap
  finished.sort((a, b) => new Date(b.fx.date).getTime() - new Date(a.fx.date).getTime());
  const toProcess = finished.slice(0, maxMatches);

  const matchResults: MatchBacktestResult[] = [];

  // Process each finished match
  for (const { slug, name, fx } of toProcess) {
    try {
      const [summary, boxscore] = await Promise.all([
        fetchSummary(slug, fx.id).catch(() => null),
        fetchBoxscore(slug, fx.id),
      ]);

      const result = runEngineFromReal(fx, summary);
      evaluateFinishedMatch(fx, result, boxscore);

      const hScore = Number(fx.home.score) || 0;
      const aScore = Number(fx.away.score) || 0;

      // Top-1
      const t1 = result.top1[0];
      const top1Hit = t1 ? t1.outcome === "HIT" : false;
      const top1Entry = t1
        ? { pick: t1.name, selection: t1.selection, hitRate: t1.hitRate, outcome: t1.outcome ?? "PENDING" as const }
        : { pick: "EMPTY", selection: "—", hitRate: 0, outcome: "EMPTY" as const };

      // Top-3
      const top3 = result.top3.map((m) => ({
        pick: m.name, selection: m.selection, outcome: m.outcome ?? "PENDING" as const,
      }));
      const top3Hits   = top3.filter((m) => m.outcome === "HIT").length;
      const top3Total  = top3.filter((m) => m.outcome !== "PENDING").length;

      // Top-5
      const top5 = result.top5.map((m) => ({
        pick: m.name, selection: m.selection, outcome: m.outcome ?? "PENDING" as const,
      }));
      const top5Hits   = top5.filter((m) => m.outcome === "HIT").length;
      const top5Total  = top5.filter((m) => m.outcome !== "PENDING").length;

      // Top-10
      const top10 = result.top10.map((m) => ({
        pick: m.name, selection: m.selection, outcome: m.outcome ?? "PENDING" as const,
      }));
      const top10Hits  = top10.filter((m) => m.outcome === "HIT").length;
      const top10Total = top10.filter((m) => m.outcome !== "PENDING").length;

      matchResults.push({
        match:    `${fx.home.name} vs ${fx.away.name}`,
        league:   name,
        score:    `${hScore}-${aScore}`,
        date:     fx.date.slice(0, 10),
        top1:     top1Entry,
        top3, top5, top10,
        top1Hit,
        top3Hits,  top3Total,  top3Perfect:  top3Total > 0 && top3Hits  === top3Total,
        top5Hits,  top5Total,  top5Perfect:  top5Total > 0 && top5Hits  === top5Total,
        top10Hits, top10Total, top10Perfect: top10Total > 0 && top10Hits === top10Total,
        boxscoreAvailable: !!boxscore,
        dataCompleteness:  result.match.dataCompletenessScore,
      });
    } catch { /* skip */ }
  }

  // Aggregate stats
  const n = matchResults.length;
  const withTop1      = matchResults.filter((m) => m.top1.outcome !== "EMPTY" && m.top1.outcome !== "PENDING");
  const top1HitRate   = withTop1.length > 0 ? withTop1.filter((m) => m.top1Hit).length / withTop1.length : 0;
  const top3Settled   = matchResults.filter((m) => m.top3Total > 0);
  const top5Settled   = matchResults.filter((m) => m.top5Total > 0);
  const top10Settled  = matchResults.filter((m) => m.top10Total > 0);

  const aggregate = {
    matchesAnalysed: n,
    daysWindow:      days,
    // Top-1
    top1: {
      matchesWithPick: withTop1.length,
      matchesEmpty:    matchResults.filter((m) => m.top1.outcome === "EMPTY").length,
      hits:            withTop1.filter((m) => m.top1Hit).length,
      hitRate:         top1HitRate,
      hitRatePct:      `${(top1HitRate * 100).toFixed(1)}%`,
    },
    // Top-3
    top3: {
      settled:     top3Settled.length,
      perfectMatches: top3Settled.filter((m) => m.top3Perfect).length,
      perfectRate: top3Settled.length > 0 ? top3Settled.filter((m) => m.top3Perfect).length / top3Settled.length : 0,
      avgHits:     top3Settled.length > 0 ? top3Settled.reduce((s, m) => s + m.top3Hits, 0) / top3Settled.length : 0,
      totalHits:   top3Settled.reduce((s, m) => s + m.top3Hits, 0),
      totalPicks:  top3Settled.reduce((s, m) => s + m.top3Total, 0),
    },
    // Top-5
    top5: {
      settled:     top5Settled.length,
      perfectMatches: top5Settled.filter((m) => m.top5Perfect).length,
      perfectRate: top5Settled.length > 0 ? top5Settled.filter((m) => m.top5Perfect).length / top5Settled.length : 0,
      avgHits:     top5Settled.length > 0 ? top5Settled.reduce((s, m) => s + m.top5Hits, 0) / top5Settled.length : 0,
      totalHits:   top5Settled.reduce((s, m) => s + m.top5Hits, 0),
      totalPicks:  top5Settled.reduce((s, m) => s + m.top5Total, 0),
    },
    // Top-10
    top10: {
      settled:     top10Settled.length,
      perfectMatches: top10Settled.filter((m) => m.top10Perfect).length,
      perfectRate: top10Settled.length > 0 ? top10Settled.filter((m) => m.top10Perfect).length / top10Settled.length : 0,
      avgHits:     top10Settled.length > 0 ? top10Settled.reduce((s, m) => s + m.top10Hits, 0) / top10Settled.length : 0,
      totalHits:   top10Settled.reduce((s, m) => s + m.top10Hits, 0),
      totalPicks:  top10Settled.reduce((s, m) => s + m.top10Total, 0),
      overallAccuracy: (() => {
        const totalH = top10Settled.reduce((s, m) => s + m.top10Hits, 0);
        const totalP = top10Settled.reduce((s, m) => s + m.top10Total, 0);
        return totalP > 0 ? totalH / totalP : 0;
      })(),
    },
  };

  return Response.json({ aggregate, matches: matchResults });
}
