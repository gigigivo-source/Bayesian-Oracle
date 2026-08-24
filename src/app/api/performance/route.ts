import { db } from "@/db";
import { performanceLog, savedSlips, dailyPicks } from "@/db/schema";
import { desc } from "drizzle-orm";
import { dedupeMatchRows } from "@/lib/performance/modeAnalytics";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Every finished match can carry up to one row PER RANKING MODE (A/B/C/D).
    // Fetch enough rows to recover 100 distinct matches, then keep one row per
    // match (canonical mode B first, else most recent) so match-level metrics
    // count each physical match exactly once.
    const rawRecords = await db
      .select()
      .from(performanceLog)
      .orderBy(desc(performanceLog.createdAt))
      .limit(400);
    const records = dedupeMatchRows(rawRecords).slice(0, 100);

    let totalHits    = 0;
    let totalMisses  = 0;
    let totalPending = 0;
    let totalPicks   = 0;
    let perfectMatches = 0;
    const byLeague: Record<string, { hits: number; misses: number; matches: number }> = {};

    for (const r of records) {
      totalHits    += r.hits;
      totalMisses  += r.misses;
      totalPending += r.pending;
      totalPicks   += r.totalPicks;
      if (r.misses === 0 && r.hits > 0) perfectMatches++;

      const lg = r.league;
      if (!byLeague[lg]) byLeague[lg] = { hits: 0, misses: 0, matches: 0 };
      byLeague[lg].hits    += r.hits;
      byLeague[lg].misses  += r.misses;
      byLeague[lg].matches++;
    }

    const totalVerified   = totalHits + totalMisses;
    const overallAccuracy = totalVerified > 0 ? totalHits / totalVerified : 0;

    // ── Current streak ───────────────────────────────────────────────────────────
    let currentStreak = 0;
    let streakType: "W" | "L" | null = null;
    for (const r of records) {
      if (r.misses === 0 && r.hits > 0) {
        if (streakType === "W" || streakType === null) { currentStreak++; streakType = "W"; }
        else break;
      } else {
        if (streakType === "L" || streakType === null) { currentStreak++; streakType = "L"; }
        else break;
      }
    }

    // ── Best accuracy match ──────────────────────────────────────────────────────
    const bestMatch = records.reduce<(typeof records)[0] | null>(
      (best, r) => (r.accuracy > (best?.accuracy ?? 0) ? r : best),
      null,
    );

    // ── Per-league breakdown ─────────────────────────────────────────────────────
    const leagueBreakdown = Object.entries(byLeague)
      .map(([league, data]) => ({
        league,
        ...data,
        accuracy: (data.hits + data.misses) > 0 ? data.hits / (data.hits + data.misses) : 0,
      }))
      .sort((a, b) => b.accuracy - a.accuracy);

    // ── Position-level and tier clean-sweep accuracy ──────────────────────────────
    let top1Hits  = 0, top1Total  = 0;
    let top3Hits  = 0, top3Total  = 0;
    let top10Hits = 0, top10Total = 0;
    let sweep1  = 0, sweep1N  = 0;
    let sweep3  = 0, sweep3N  = 0;
    let sweep5  = 0, sweep5N  = 0;
    let sweep10 = 0, sweep10N = 0;

    const swept = (arr: Array<{ outcome: string }>) => {
      const ev = arr.filter((x) => x.outcome === "HIT" || x.outcome === "MISS");
      return ev.length > 0 && ev.every((x) => x.outcome === "HIT");
    };

    for (const r of records) {
      const detail = r.top10Detail as Array<{ outcome: string }>;
      if (!detail || detail.length === 0) continue;

      // Top-1
      if (detail[0]) {
        top1Total++;
        if (detail[0].outcome === "HIT") top1Hits++;
      }
      // Top-3
      for (let i = 0; i < Math.min(3, detail.length); i++) {
        top3Total++;
        if (detail[i].outcome === "HIT") top3Hits++;
      }
      // Top-10
      for (const pick of detail) {
        top10Total++;
        if (pick.outcome === "HIT") top10Hits++;
      }

      // Tier clean-sweep counters
      const t1 = detail.slice(0, 1);
      const t3 = detail.slice(0, 3);
      const t5 = detail.slice(0, 5);
      if (t1.some((x)     => x.outcome === "HIT" || x.outcome === "MISS")) { sweep1N++;  if (swept(t1))     sweep1++;  }
      if (t3.some((x)     => x.outcome === "HIT" || x.outcome === "MISS")) { sweep3N++;  if (swept(t3))     sweep3++;  }
      if (t5.some((x)     => x.outcome === "HIT" || x.outcome === "MISS")) { sweep5N++;  if (swept(t5))     sweep5++;  }
      if (detail.some((x) => x.outcome === "HIT" || x.outcome === "MISS")) { sweep10N++; if (swept(detail)) sweep10++; }
    }

    return Response.json({
      totalMatches: records.length,
      totalPicks,
      totalHits,
      totalMisses,
      totalPending,
      totalVerified,
      overallAccuracy,
      perfectMatches,
      currentStreak,
      streakType,
      tierSweep: {
        top1:  sweep1N  > 0 ? sweep1  / sweep1N  : 0,
        top3:  sweep3N  > 0 ? sweep3  / sweep3N  : 0,
        top5:  sweep5N  > 0 ? sweep5  / sweep5N  : 0,
        top10: sweep10N > 0 ? sweep10 / sweep10N : 0,
        counts: { top1: sweep1N, top3: sweep3N, top5: sweep5N, top10: sweep10N },
      },
      top1:  { hits: top1Hits,  total: top1Total,  accuracy: top1Total  > 0 ? top1Hits  / top1Total  : 0 },
      top3:  { hits: top3Hits,  total: top3Total,  accuracy: top3Total  > 0 ? top3Hits  / top3Total  : 0 },
      top10: { hits: top10Hits, total: top10Total, accuracy: top10Total > 0 ? top10Hits / top10Total : 0 },
      bestMatch: bestMatch
        ? {
            matchLabel: bestMatch.matchLabel,
            score:      `${bestMatch.homeScore}-${bestMatch.awayScore}`,
            accuracy:   bestMatch.accuracy,
            hits:       bestMatch.hits,
            total:      bestMatch.totalPicks,
          }
        : null,
      leagueBreakdown,
      accumulatorPerformance: await getAccaPerformance(),
      dailyPicksPerformance:  await getDailyPicksPerformance(),
      recentMatches: records.slice(0, 20).map((r) => ({
        id:          r.id,
        matchLabel:  r.matchLabel,
        league:      r.league,
        matchDate:   r.matchDate,
        homeScore:   r.homeScore,
        awayScore:   r.awayScore,
        hits:        r.hits,
        misses:      r.misses,
        pending:     r.pending,
        accuracy:    r.accuracy,
        totalPicks:  r.totalPicks,
        top10Detail: r.top10Detail,
        createdAt:   r.createdAt,
      })),
    });
  } catch {
    return Response.json({
      totalMatches:   0,
      totalHits:      0,
      totalMisses:    0,
      overallAccuracy: 0,
      recentMatches:  [],
      leagueBreakdown: [],
      accumulatorPerformance: {
        total: 0, won: 0, lost: 0, pending: 0, roi: 0, winRate: 0, slips: [],
      },
    });
  }
}

// ─── Accumulator slip performance ─────────────────────────────────────────────

async function getAccaPerformance() {
  try {
    const slips = await db
      .select()
      .from(savedSlips)
      .orderBy(desc(savedSlips.createdAt))
      .limit(100);

    function calcStats(filtered: typeof slips) {
      const won     = filtered.filter((s) => s.status === "won");
      const lost    = filtered.filter((s) => s.status === "lost");
      const pending = filtered.filter((s) => s.status === "pending");
      const settled = won.length + lost.length;
      const totalStaked   = filtered
        .filter((s) => s.status !== "pending")
        .reduce((sum, s) => sum + (s.stake ?? 10), 0);
      const totalReturns  = won
        .reduce((sum, s) => sum + (s.stake ?? 10) * (s.combinedOdds ?? 1), 0);
      return {
        total:        filtered.length,
        won:          won.length,
        lost:         lost.length,
        pending:      pending.length,
        settled,
        winRate:      settled > 0 ? (won.length / settled) * 100 : 0,
        roi:          totalStaked > 0 ? ((totalReturns - totalStaked) / totalStaked) * 100 : 0,
        totalStaked,
        totalReturns,
        slips: filtered.slice(0, 20).map((s) => ({
          id:              s.id,
          name:            s.name,
          type:            s.slipType,
          legs:            (s.picks as unknown[]).length,
          odds:            s.combinedOdds,
          prob:            s.combinedProb,
          stake:           s.stake,
          status:          s.status,
          potentialReturn: (s.stake ?? 10) * (s.combinedOdds ?? 1),
        })),
      };
    }

    return {
      all:     calcStats(slips),
      highHit: calcStats(slips.filter((s) => s.slipType === "highhit")),
      value:   calcStats(slips.filter((s) => s.slipType === "value")),
    };
  } catch {
    const empty = {
      total: 0, won: 0, lost: 0, pending: 0, settled: 0,
      roi: 0, winRate: 0, totalStaked: 0, totalReturns: 0, slips: [],
    };
    return { all: empty, highHit: empty, value: empty };
  }
}

// ─── Daily picks performance ──────────────────────────────────────────────────

async function getDailyPicksPerformance() {
  try {
    const rows = await db
      .select()
      .from(dailyPicks)
      .orderBy(desc(dailyPicks.createdAt))
      .limit(200);

    let hits = 0, misses = 0, pending = 0;
    let settledMatches = 0, perfectMatches = 0;

    for (const r of rows) {
      hits    += r.hits;
      misses  += r.misses;
      pending += r.pending;
      if (r.status === "settled") {
        settledMatches++;
        if (r.misses === 0 && r.hits > 0) perfectMatches++;
      }
    }

    const verified = hits + misses;
    return {
      totalMatches: rows.length,
      settledMatches,
      perfectMatches,
      hits, misses, pending,
      accuracy: verified > 0 ? hits / verified : 0,
      recent: rows.slice(0, 20).map((r) => ({
        id:      r.id,
        date:    r.pickDate,
        match:   r.match,
        league:  r.league,
        hits:    r.hits,
        misses:  r.misses,
        pending: r.pending,
        status:  r.status,
        picks:   r.picks,
      })),
    };
  } catch {
    return {
      totalMatches: 0, settledMatches: 0, perfectMatches: 0,
      hits: 0, misses: 0, pending: 0, accuracy: 0, recent: [],
    };
  }
}
