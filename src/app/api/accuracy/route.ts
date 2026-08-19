// ĞIGI GIVØ — Rolling accuracy tracker.
// Returns the app's real hit rates over time from performance_log.
// Used by the Performance tab to show trend charts and current accuracy.

import { db } from "@/db";
import { performanceLog } from "@/db/schema";
import { desc, gte } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const days = Math.min(parseInt(searchParams.get("days") ?? "30"), 90);

  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const records = await db
      .select()
      .from(performanceLog)
      .where(gte(performanceLog.createdAt, cutoff))
      .orderBy(desc(performanceLog.createdAt))
      .limit(500);

    if (records.length === 0) {
      return Response.json({ records: 0, days, daily: [], cumulative: null });
    }

    // Group by date for daily trend
    const byDate: Record<string, { hits: number; misses: number; matches: number; t1Hits: number; t1Total: number }> = {};

    for (const rec of records) {
      const date   = rec.matchDate;
      const picks  = rec.top10Detail as Array<{ name: string; selection: string; outcome: string }>;
      const hits   = picks.filter((p) => p.outcome === "HIT").length;
      const misses = picks.filter((p) => p.outcome === "MISS").length;

      if (!byDate[date]) byDate[date] = { hits: 0, misses: 0, matches: 0, t1Hits: 0, t1Total: 0 };
      byDate[date].hits    += hits;
      byDate[date].misses  += misses;
      byDate[date].matches++;

      // Track Top-1 specifically (first pick)
      if (picks[0]?.outcome === "HIT" || picks[0]?.outcome === "MISS") {
        byDate[date].t1Total++;
        if (picks[0].outcome === "HIT") byDate[date].t1Hits++;
      }
    }

    const daily = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { hits, misses, matches, t1Hits, t1Total }]) => ({
        date,
        matches,
        hits,
        misses,
        accuracy: hits + misses > 0 ? hits / (hits + misses) : 0,
        accuracyPct: hits + misses > 0 ? `${(hits / (hits + misses) * 100).toFixed(1)}%` : "N/A",
        top1Rate: t1Total > 0 ? t1Hits / t1Total : 0,
        top1RatePct: t1Total > 0 ? `${(t1Hits / t1Total * 100).toFixed(1)}%` : "N/A",
      }));

    // Cumulative overall
    const totalHits   = records.reduce((s, r) => s + r.hits, 0);
    const totalMisses = records.reduce((s, r) => s + r.misses, 0);
    const total       = totalHits + totalMisses;
    const perfect     = records.filter((r) => r.misses === 0 && r.hits > 0).length;

    // 7-day rolling window (latest)
    const last7 = daily.slice(-7);
    const last7Hits   = last7.reduce((s, d) => s + d.hits, 0);
    const last7Misses = last7.reduce((s, d) => s + d.misses, 0);

    // Trend: is accuracy improving?
    const firstHalf = daily.slice(0, Math.floor(daily.length / 2));
    const secondHalf = daily.slice(Math.floor(daily.length / 2));
    const firstAcc  = firstHalf.reduce((s, d) => s + d.hits, 0) / Math.max(1, firstHalf.reduce((s, d) => s + d.hits + d.misses, 0));
    const secondAcc = secondHalf.reduce((s, d) => s + d.hits, 0) / Math.max(1, secondHalf.reduce((s, d) => s + d.hits + d.misses, 0));
    const trend = secondAcc > firstAcc + 0.02 ? "IMPROVING ↑" : secondAcc < firstAcc - 0.02 ? "DECLINING ↓" : "STABLE →";

    return Response.json({
      records:  records.length,
      days,
      cumulative: {
        matches:     records.length,
        hits:        totalHits,
        misses:      totalMisses,
        total,
        accuracy:    total > 0 ? totalHits / total : 0,
        accuracyPct: total > 0 ? `${(totalHits / total * 100).toFixed(1)}%` : "N/A",
        perfectMatches: perfect,
        perfectRate: records.length > 0 ? perfect / records.length : 0,
        trend,
      },
      rolling7d: {
        hits:        last7Hits,
        misses:      last7Misses,
        accuracy:    last7Hits + last7Misses > 0 ? last7Hits / (last7Hits + last7Misses) : 0,
        accuracyPct: last7Hits + last7Misses > 0 ? `${(last7Hits / (last7Hits + last7Misses) * 100).toFixed(1)}%` : "N/A",
      },
      daily,
    });
  } catch (err) {
    console.error("Accuracy error:", err);
    return Response.json({ error: "Failed to compute accuracy" }, { status: 500 });
  }
}
