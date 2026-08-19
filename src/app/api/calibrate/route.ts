// ĞIGI GIVØ — Self-tuning calibration endpoint.
// Reads the last 90 days of performance_log records, computes real hit rates
// per market family, and returns calibration coefficients.
// These are displayed in the Performance tab and can be used to update
// calibration.ts coefficients continuously.

import { db } from "@/db";
import { performanceLog } from "@/db/schema";
import { gte } from "drizzle-orm";

export const dynamic = "force-dynamic";

interface PickRecord {
  name: string;
  selection: string;
  outcome: string;
  family?: string;
}

export async function GET() {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);

    const records = await db
      .select()
      .from(performanceLog)
      .where(gte(performanceLog.createdAt, cutoff))
      .limit(500);

    if (records.length === 0) {
      return Response.json({ message: "No data yet — run matches first", families: [], overall: null });
    }

    // Aggregate hit/miss by market family and by market name prefix
    const familyStats: Record<string, { hits: number; misses: number }> = {};
    const nameStats:   Record<string, { hits: number; misses: number }> = {};

    for (const rec of records) {
      const picks = rec.top10Detail as PickRecord[];
      for (const p of picks) {
        if (p.outcome !== "HIT" && p.outcome !== "MISS") continue;

        // Family-level tracking
        const family = p.family ?? detectFamily(p.name);
        if (!familyStats[family]) familyStats[family] = { hits: 0, misses: 0 };
        if (p.outcome === "HIT") familyStats[family].hits++;
        else familyStats[family].misses++;

        // Name-prefix tracking (for specific lines like "Total Goals O/U 4.5")
        const prefix = p.name.replace(/\s*O\/U\s*[\d.]+\s*/, " O/U X").trim();
        if (!nameStats[prefix]) nameStats[prefix] = { hits: 0, misses: 0 };
        if (p.outcome === "HIT") nameStats[prefix].hits++;
        else nameStats[prefix].misses++;
      }
    }

    // Build family calibration table
    const families = Object.entries(familyStats)
      .map(([family, { hits, misses }]) => {
        const total    = hits + misses;
        const observed = total > 0 ? hits / total : 0;
        const current  = currentReliability(family);
        const suggested = total >= 10
          ? Math.round(clamp(observed, 0.50, 1.00) * 100) / 100
          : current;
        const drift    = suggested - current;
        return {
          family, hits, misses, total, observed,
          observedPct:  `${(observed * 100).toFixed(1)}%`,
          currentCoeff: current,
          suggestedCoeff: suggested,
          drift:         parseFloat(drift.toFixed(3)),
          driftPct:     `${(drift * 100).toFixed(1)}%`,
          confident:    total >= 10,
          action:       Math.abs(drift) >= 0.05 && total >= 10
            ? drift > 0 ? "INCREASE ↑" : "DECREASE ↓"
            : "STABLE",
        };
      })
      .sort((a, b) => b.total - a.total);

    // Overall stats
    const totalHits   = Object.values(familyStats).reduce((s, v) => s + v.hits, 0);
    const totalMisses = Object.values(familyStats).reduce((s, v) => s + v.misses, 0);
    const total       = totalHits + totalMisses;

    // Top performing market names
    const topNames = Object.entries(nameStats)
      .filter(([, v]) => v.hits + v.misses >= 5)
      .map(([name, { hits, misses }]) => ({
        name, hits, misses,
        total: hits + misses,
        hitRate: hits / (hits + misses),
        hitRatePct: `${(hits / (hits + misses) * 100).toFixed(1)}%`,
      }))
      .sort((a, b) => b.hitRate - a.hitRate);

    return Response.json({
      records: records.length,
      daysCovered: 90,
      overall: {
        hits: totalHits,
        misses: totalMisses,
        total,
        accuracy: total > 0 ? totalHits / total : 0,
        accuracyPct: total > 0 ? `${(totalHits / total * 100).toFixed(1)}%` : "N/A",
      },
      families,
      topPerformingMarkets: topNames.slice(0, 15),
      worstPerformingMarkets: [...topNames].sort((a, b) => a.hitRate - b.hitRate).slice(0, 10),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Calibrate error:", err);
    return Response.json({ error: "Failed to compute calibration" }, { status: 500 });
  }
}

function detectFamily(name: string): string {
  if (name.includes("Goals") || name.includes("BTTS") || name.includes("Both Teams") || name.includes("Clean Sheet")) return "Goals";
  if (name.includes("Match Result") || name.includes("Double Chance") || name.includes("Draw No Bet")) return "Match Result";
  if (name.includes("Corners")) return "Corners";
  if (name.includes("Cards")) return "Yellow Cards";
  if (name.includes("SOT")) return "Shots on Target";
  if (name.includes("Shots")) return "Shots Towards Goal";
  if (name.includes("Saves") || name.includes("GK")) return "Saves";
  if (name.includes("Offsides")) return "Offsides";
  if (name.includes("Fouls")) return "Fouls";
  if (name.includes("Interceptions")) return "Interceptions";
  return "Other";
}

function currentReliability(family: string): number {
  const map: Record<string, number> = {
    "Goals":              0.97,
    "Match Result":       0.97,
    "Corners":            0.80,
    "Yellow Cards":       0.66,
    "Shots on Target":    0.78,
    "Shots Towards Goal": 0.72,
    "Saves":              0.55,
    "Offsides":           0.90,
    "Fouls":              0.75,
    "Interceptions":      0.60,
  };
  return map[family] ?? 0.85;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
