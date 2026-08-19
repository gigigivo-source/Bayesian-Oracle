// ĞIGI GIVØ — Auto-settle accumulator slips cron.
// Runs every 2 hours. Checks all pending slips against finished match results.
// Marks slips as won/lost automatically when all legs are resolved.

import { db } from "@/db";
import { savedSlips } from "@/db/schema";
import { eq } from "drizzle-orm";
import { fetchScoreboard } from "@/lib/espn";
import { TOP_FEED_SLUGS } from "@/lib/leagues";
import type { FixtureLite } from "@/lib/espn";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const url      = new URL(req.url);
  const provided = req.headers.get("authorization")?.replace("Bearer ", "") ?? url.searchParams.get("key");
  return provided === secret;
}

async function buildScoreMap(): Promise<Map<string, { home: number; away: number }>> {
  const now  = new Date();
  const from = new Date(now); from.setDate(now.getDate() - 2);
  const fmt  = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const range = `${fmt(from)}-${fmt(now)}`;

  const slugs = TOP_FEED_SLUGS.slice(0, 15);
  const boards = await Promise.allSettled(
    slugs.map((s) => fetchScoreboard(s, range).catch(() => [] as FixtureLite[]))
  );

  const scoreMap = new Map<string, { home: number; away: number }>();
  for (const r of boards) {
    if (r.status !== "fulfilled") continue;
    for (const fx of r.value) {
      if (fx.state !== "post" || fx.home.score === null) continue;
      const hGoals = Number(fx.home.score) || 0;
      const aGoals = Number(fx.away.score) || 0;
      // Index by both orderings
      scoreMap.set(`${fx.home.name} vs ${fx.away.name}`.toLowerCase(), { home: hGoals, away: aGoals });
      scoreMap.set(`${fx.away.name} vs ${fx.home.name}`.toLowerCase(), { home: aGoals, away: hGoals });
    }
  }
  return scoreMap;
}

function settlePick(
  marketName: string,
  selection: string,
  matchLabel: string,
  scoreMap: Map<string, { home: number; away: number }>,
): "HIT" | "MISS" | "PENDING" {
  const score = scoreMap.get(matchLabel.toLowerCase());
  if (!score) return "PENDING";

  const { home: hScore, away: aScore } = score;
  const total = hScore + aScore;
  const lineM = marketName.match(/O\/U\s+([\d.]+)/);
  const line  = lineM ? Number(lineM[1]) : NaN;
  const isOver = selection.startsWith("Over");

  // Goals
  if (marketName.includes("Total Goals") && !isNaN(line))
    return (isOver ? total > line : total < line) ? "HIT" : "MISS";
  // BTTS
  if (marketName.includes("Both Teams"))
    return ((hScore > 0 && aScore > 0) === (selection === "Yes")) ? "HIT" : "MISS";
  // Result
  if (marketName.includes("Match Result") || selection.includes("Win") || selection === "Draw") {
    const actual = hScore > aScore ? "Home Win" : hScore === aScore ? "Draw" : "Away Win";
    if (selection.includes("Home") || selection === "Home Win") return hScore > aScore ? "HIT" : "MISS";
    if (selection === "Draw") return hScore === aScore ? "HIT" : "MISS";
    if (selection.includes("Away") || selection === "Away Win") return aScore > hScore ? "HIT" : "MISS";
    return selection.includes(actual.split(" ")[0]) ? "HIT" : "MISS";
  }
  // Double Chance
  if (selection.includes("1X") || (selection.includes("Home") && selection.includes("Draw")))
    return hScore >= aScore ? "HIT" : "MISS";
  if (selection.includes("X2") || (selection.includes("Draw") && selection.includes("Away")))
    return aScore >= hScore ? "HIT" : "MISS";
  if (selection.includes("12"))
    return hScore !== aScore ? "HIT" : "MISS";
  // Generic O/U from score
  if (!isNaN(line))
    return (isOver ? total > line : total < line) ? "HIT" : "MISS";

  return "PENDING";
}

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const pending = await db
      .select()
      .from(savedSlips)
      .where(eq(savedSlips.status, "pending"))
      .limit(50);

    if (pending.length === 0)
      return Response.json({ settled: 0, message: "No pending slips" });

    const scoreMap = await buildScoreMap();
    let settled = 0;

    for (const slip of pending) {
      const picks = slip.picks as Array<{
        matchLabel?: string;
        marketName?: string;
        selection?: string;
        hitRate?: number;
      }>;

      if (!picks || picks.length === 0) continue;

      let allResolved = true;
      let allWon = true;

      for (const pick of picks) {
        if (!pick.matchLabel || !pick.marketName || !pick.selection) {
          allResolved = false;
          continue;
        }
        const outcome = settlePick(pick.marketName, pick.selection, pick.matchLabel, scoreMap);
        if (outcome === "PENDING") { allResolved = false; }
        if (outcome === "MISS")    { allWon = false; }
      }

      if (allResolved) {
        await db
          .update(savedSlips)
          .set({ status: allWon ? "won" : "lost" })
          .where(eq(savedSlips.id, slip.id));
        settled++;
      }
    }

    return Response.json({ settled, totalPending: pending.length, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error("Settle error:", err);
    return Response.json({ error: "Settlement failed" }, { status: 500 });
  }
}

export async function POST(req: Request) { return GET(req); }
