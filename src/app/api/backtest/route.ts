// Calibration backtest — replays the VA scanner's prediction path (blind
// pre-match fixture, null summary, no odds anchor) over recently finished
// matches and reports claimed hit rates vs actual outcomes, bucketed by the
// probability the model claimed. Read-only: no auth, no DB access.
//
// Markets the engine flags `rejected` are deliberately NOT skipped: on the
// null-summary, odds-free path the engine's completeness gate (score 30 < 45)
// rejects every market, and the VA scanner itself iterates engine markets
// without a rejected check — so the table measures every Goals claim the
// model actually emits on that path.
import { fetchScoreboard, type FixtureLite, type TeamLite } from "@/lib/espn";
import { runEngineFromReal } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_LEAGUES = "eng.1,esp.1,ita.1,ger.1,fra.1,ned.1,por.1";

interface Bucket {
  claimed: number;
  n: number;
  hits: number;
  actual: number;
  diff: number;
}

function yyyymmdd(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
}

/** Blind pre-match fixture — the engine must not see the result or the line. */
function toBlindFixture(fx: FixtureLite): FixtureLite {
  const blind = (t: TeamLite, homeAway: "home" | "away"): TeamLite => ({
    id: t.id,
    name: t.name,
    shortName: t.shortName,
    abbrev: t.abbrev,
    logo: null,
    color: null,
    score: null,
    homeAway,
    record: null,
    form: null,
  });
  return {
    id: fx.id,
    leagueSlug: fx.leagueSlug,
    leagueName: fx.leagueName,
    date: fx.date,
    state: "pre",
    statusDetail: "Scheduled",
    venue: null,
    home: blind(fx.home, "home"),
    away: blind(fx.away, "away"),
    neutralSite: false,
    odds: null,
  };
}

export async function POST(req: Request) {
  const started = Date.now();
  const { searchParams } = new URL(req.url);
  const daysRaw = parseInt(searchParams.get("days") ?? "21", 10);
  const days = Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 21, 1), 30);
  const leagues = (searchParams.get("leagues") ?? DEFAULT_LEAGUES)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // 1. Finished matches — one day at a time (ESPN returns nothing for ranges).
  const byId = new Map<string, FixtureLite>();
  for (let i = 1; i <= days; i++) {
    const date = yyyymmdd(i);
    const settled = await Promise.allSettled(
      leagues.map(async (slug) => {
        try {
          return await fetchScoreboard(slug, date);
        } catch {
          return [];
        }
      }),
    );
    for (const s of settled) {
      if (s.status !== "fulfilled") continue;
      for (const fx of s.value) {
        if (fx.state !== "post") continue;
        if (fx.home.score === null || fx.away.score === null) continue;
        if (!Number.isFinite(Number(fx.home.score)) || !Number.isFinite(Number(fx.away.score))) continue;
        if (!byId.has(fx.id)) byId.set(fx.id, fx);
      }
    }
  }
  const finished = Array.from(byId.values());

  // 2-4. Blind prediction + outcome measurement, bucketed by claimed hitRate.
  const buckets = new Map<number, { n: number; hits: number }>();
  let matchesProcessed = 0;
  let totalPredictions = 0;

  for (const ev of finished) {
    const homeScore = Number(ev.home.score);
    const awayScore = Number(ev.away.score);

    let result;
    try {
      result = runEngineFromReal(toBlindFixture(ev), null);
    } catch {
      continue; // skip match on engine error
    }
    matchesProcessed++;

    for (const m of result.markets ?? []) {
      if (m.family !== "Goals") continue;
      const hitRate = m.hitRate;
      if (typeof hitRate !== "number" || !Number.isFinite(hitRate) || hitRate < 0.5) continue;

      let hit: boolean;
      if (m.name.startsWith("Total Goals O/U")) {
        const line = Number(/O\/U\s+([\d.]+)/.exec(m.name)?.[1]);
        if (!Number.isFinite(line)) continue;
        const total = homeScore + awayScore;
        hit = m.selection.startsWith("Over") ? total > line : total < line;
      } else if (m.name === "Both Teams To Score") {
        const btts = homeScore >= 1 && awayScore >= 1;
        hit = m.selection === "Yes" ? btts : !btts;
      } else {
        continue;
      }

      const idx = Math.floor(hitRate * 20 + 1e-6); // floor(hitRate / 0.05), FP-safe
      const b = buckets.get(idx) ?? { n: 0, hits: 0 };
      b.n += 1;
      b.hits += hit ? 1 : 0;
      buckets.set(idx, b);
      totalPredictions++;
    }
  }

  // 5. Bucket table — ascending, only buckets with enough samples to read.
  const round4 = (v: number) => Math.round(v * 10000) / 10000;
  const table: Bucket[] = Array.from(buckets.entries())
    .filter(([, b]) => b.n >= 5)
    .map(([idx, b]) => {
      const claimed = idx / 20;
      const actual = b.hits / b.n;
      return { claimed, n: b.n, hits: b.hits, actual: round4(actual), diff: round4(actual - claimed) };
    })
    .sort((a, b) => a.claimed - b.claimed);

  const elapsedMs = Date.now() - started;
  console.log(`[backtest] ${matchesProcessed} matches, ${totalPredictions} predictions, ${elapsedMs}ms`);

  return Response.json({
    ok: true,
    elapsedMs,
    matchesFound: finished.length,
    matchesProcessed,
    totalPredictions,
    buckets: table,
  });
}
