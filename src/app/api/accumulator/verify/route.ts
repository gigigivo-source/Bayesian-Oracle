// ĞIGI GIVØ — Accumulator Post-Match Verification
// Checks all pending accumulator slips against real finished match results
// and settles them as WON or LOST.

import { db } from "@/db";
import { savedSlips } from "@/db/schema";
import { eq } from "drizzle-orm";
import { fetchScoreboard } from "@/lib/espn";
import { TOP_FEED_SLUGS } from "@/lib/leagues";
import type { FixtureLite } from "@/lib/espn";

export const dynamic = "force-dynamic";

interface AccaPick {
  matchLabel?:  string;
  marketName?:  string;
  selection?:   string;
  hitRate?:     number;
  fixtureId?:   string;
  leagueSlug?:  string;
}

async function buildResultsMap(): Promise<Map<string, { home: number; away: number; homeName: string; awayName: string }>> {
  const now  = new Date();
  const from = new Date(now); from.setDate(now.getDate() - 3);
  const fmt  = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const range = `${fmt(from)}-${fmt(now)}`;

  const slugs = [...new Set([...TOP_FEED_SLUGS.slice(0, 15), "bra.1","arg.1","mex.1","usa.1","ksa.1","jpn.1","col.1","chi.1"])];
  const boards = await Promise.allSettled(
    slugs.map((s) => fetchScoreboard(s, range).catch(() => [] as FixtureLite[]))
  );

  const map = new Map<string, { home: number; away: number; homeName: string; awayName: string }>();

  for (const r of boards) {
    if (r.status !== "fulfilled") continue;
    for (const fx of r.value) {
      if (fx.state !== "post" || fx.home.score === null || fx.away.score === null) continue;
      const h = Number(fx.home.score) || 0;
      const a = Number(fx.away.score) || 0;
      // Index by match label (both directions)
      const key1 = `${fx.home.name} vs ${fx.away.name}`.toLowerCase();
      const key2 = `${fx.away.name} vs ${fx.home.name}`.toLowerCase();
      const val  = { home: h, away: a, homeName: fx.home.name, awayName: fx.away.name };
      map.set(key1, val);
      map.set(key2, { home: a, away: h, homeName: fx.away.name, awayName: fx.home.name });
      // Also index by event ID
      map.set(fx.id, val);
    }
  }
  return map;
}

function evaluatePick(
  marketName: string,
  selection: string,
  homeName: string,
  awayName: string,
  hScore: number,
  aScore: number,
): "HIT" | "MISS" | "PENDING" {
  const total  = hScore + aScore;
  const lineM  = marketName.match(/O\/U\s+([\d.]+)/i);
  const line   = lineM ? Number(lineM[1]) : NaN;
  const isOver = selection.startsWith("Over");

  // Goals O/U
  if ((marketName.includes("Total Goals") || marketName.includes("Goals O/U")) && !isNaN(line)) {
    const actual = marketName.includes(homeName) ? hScore : marketName.includes(awayName) ? aScore : total;
    return (isOver ? actual > line : actual < line) ? "HIT" : "MISS";
  }
  // BTTS
  if (marketName.includes("Both Teams")) {
    const btts = hScore > 0 && aScore > 0;
    return ((selection === "Yes") === btts) ? "HIT" : "MISS";
  }
  // Match Result
  if (selection.includes("Win") || selection === "Draw") {
    if (selection.includes(homeName) || selection === `${homeName} Win` || selection === "Home Win")
      return hScore > aScore ? "HIT" : "MISS";
    if (selection === "Draw") return hScore === aScore ? "HIT" : "MISS";
    if (selection.includes(awayName) || selection === "Away Win")
      return aScore > hScore ? "HIT" : "MISS";
  }
  // Double Chance
  if (selection.includes("1X") || (selection.includes(homeName) && selection.includes("Draw")))
    return hScore >= aScore ? "HIT" : "MISS";
  if (selection.includes("X2") || (selection.includes("Draw") && selection.includes(awayName)))
    return aScore >= hScore ? "HIT" : "MISS";
  if (selection.includes("12")) return hScore !== aScore ? "HIT" : "MISS";
  // Clean Sheet
  if (marketName.includes("Clean Sheet")) {
    const homeCS = marketName.includes(homeName) ? aScore === 0 : hScore === 0;
    return ((selection === "Yes") === homeCS) ? "HIT" : "MISS";
  }
  // Generic O/U
  if (!isNaN(line)) {
    return (isOver ? total > line : total < line) ? "HIT" : "MISS";
  }

  return "PENDING";
}

export async function POST() {
  try {
    const pending = await db.select().from(savedSlips).where(eq(savedSlips.status, "pending")).limit(50);
    if (pending.length === 0) return Response.json({ message: "No pending slips", verified: 0, settled: 0 });

    const resultsMap = await buildResultsMap();
    let verified = 0; let settled = 0; let won = 0; let lost = 0;

    for (const slip of pending) {
      const picks = slip.picks as AccaPick[];
      if (!picks?.length) continue;

      let allResolved = true;
      let allWon      = true;
      const pickResults: Array<{ matchLabel: string; marketName: string; selection: string; outcome: "HIT" | "MISS" | "PENDING" }> = [];

      for (const pick of picks) {
        const label = pick.matchLabel ?? "";
        const result = resultsMap.get(label.toLowerCase()) ?? (pick.fixtureId ? resultsMap.get(pick.fixtureId) : null);

        if (!result) { allResolved = false; pickResults.push({ matchLabel: label, marketName: pick.marketName ?? "", selection: pick.selection ?? "", outcome: "PENDING" }); continue; }

        const outcome = evaluatePick(
          pick.marketName ?? "",
          pick.selection ?? "",
          result.homeName,
          result.awayName,
          result.home,
          result.away,
        );
        pickResults.push({ matchLabel: label, marketName: pick.marketName ?? "", selection: pick.selection ?? "", outcome });
        if (outcome === "PENDING") { allResolved = false; }
        if (outcome === "MISS")    { allWon = false; }
      }

      verified++;
      if (allResolved) {
        const newStatus = allWon ? "won" : "lost";
        await db.update(savedSlips)
          .set({ status: newStatus })
          .where(eq(savedSlips.id, slip.id));
        settled++;
        if (allWon) won++; else lost++;
      }
    }

    return Response.json({
      ok: true,
      slipsChecked: pending.length,
      verified,
      settled,
      won,
      lost,
      stillPending: pending.length - settled,
      ranAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Accumulator verify error:", err);
    return Response.json({ error: "Verification failed" }, { status: 500 });
  }
}

export async function GET() { return POST(); }
