// ĞIGI GIVØ — Value Bet Post-Match Verification
// Checks all pending value bets against real match results and settles them.

import { db } from "@/db";
import { valueBetLog } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { fetchScoreboard } from "@/lib/espn";
import type { FixtureLite } from "@/lib/espn";

export const dynamic = "force-dynamic";

type PendingValueBet = typeof valueBetLog.$inferSelect;

type MatchResult = {
  hScore: number;
  aScore: number;
  total: number;
  homeName: string;
  awayName: string;
};

async function buildResultsMap(pending: PendingValueBet[]) {
  // Query the exact league/date for every pending bet. The previous global
  // three-day scan omitted bets from leagues outside its hard-coded list and
  // left older pending bets unresolved before their DB update could run.
  const requests = new Map<string, { slug: string; date: string }>();
  for (const bet of pending) {
    const date = bet.matchDate.replace(/-/g, "").slice(0, 8);
    if (!bet.leagueSlug || date.length !== 8) continue;
    requests.set(`${bet.leagueSlug}|${date}`, { slug: bet.leagueSlug, date });
  }

  const boards = await Promise.allSettled(
    [...requests.values()].map(({ slug, date }) =>
      fetchScoreboard(slug, date).catch(() => [] as FixtureLite[]),
    ),
  );

  const map = new Map<string, MatchResult>();
  for (const r of boards) {
    if (r.status !== "fulfilled") continue;
    for (const fx of r.value) {
      if (fx.state !== "post" || fx.home.score === null || fx.away.score === null) continue;
      const h = Number(fx.home.score) || 0;
      const a = Number(fx.away.score) || 0;
      const entry = { hScore: h, aScore: a, total: h + a, homeName: fx.home.name, awayName: fx.away.name };
      map.set(fx.id, entry);
      map.set(`${fx.home.name} vs ${fx.away.name}`.toLowerCase(), entry);
      map.set(`${fx.away.name} vs ${fx.home.name}`.toLowerCase(), { ...entry, hScore: a, aScore: h, homeName: fx.away.name, awayName: fx.home.name });
    }
  }
  return map;
}

function evaluateValueBet(
  marketName: string,
  selection:  string,
  homeName:   string,
  awayName:   string,
  hScore:     number,
  aScore:     number,
): "won" | "lost" | "void" | "pending" {
  const total  = hScore + aScore;
  const lineM  = marketName.match(/O\/U\s+([\d.]+)/i);
  const line   = lineM ? Number(lineM[1]) : NaN;
  const isOver = selection.startsWith("Over");

  // Total Goals O/U
  if (marketName.includes("Total Goals") && !isNaN(line)) {
    const hit = isOver ? total > line : total < line;
    return hit ? "won" : "lost";
  }
  // Team Goals O/U
  if ((marketName.includes(`${homeName} Goals`) || marketName.includes("Home Goals")) && !isNaN(line)) {
    return (isOver ? hScore > line : hScore < line) ? "won" : "lost";
  }
  if ((marketName.includes(`${awayName} Goals`) || marketName.includes("Away Goals")) && !isNaN(line)) {
    return (isOver ? aScore > line : aScore < line) ? "won" : "lost";
  }
  // BTTS
  if (marketName.includes("Both Teams")) {
    const btts = hScore > 0 && aScore > 0;
    return ((selection === "Yes") === btts) ? "won" : "lost";
  }
  // Match Result
  if (selection === "Draw" || selection.includes("Win")) {
    const actualWinner = hScore > aScore ? "home" : hScore < aScore ? "away" : "draw";
    if (selection === "Draw") return actualWinner === "draw" ? "won" : "lost";
    if (selection.includes(homeName) || selection === "Home Win") return actualWinner === "home" ? "won" : "lost";
    if (selection.includes(awayName) || selection === "Away Win") return actualWinner === "away" ? "won" : "lost";
  }
  // Double Chance
  if (selection.includes("1X") || (selection.includes(homeName) && selection.includes("Draw")))
    return hScore >= aScore ? "won" : "lost";
  if (selection.includes("X2") || (selection.includes(awayName) && selection.includes("Draw")))
    return aScore >= hScore ? "won" : "lost";
  if (selection.includes("12")) return hScore !== aScore ? "won" : "lost";
  // Generic O/U
  if (!isNaN(line)) {
    return (isOver ? total > line : total < line) ? "won" : "lost";
  }

  return "void";
}

export async function POST() {
  try {
    const pending = await db.select().from(valueBetLog).where(eq(valueBetLog.outcome, "pending")).limit(100);
    if (pending.length === 0) return Response.json({ message: "No pending value bets", settled: 0 });

    const resultsMap = await buildResultsMap(pending);
    let settled = 0; let won = 0; let lost = 0; let voidBets = 0;
    const results: Array<{ id: number; match: string; market: string; outcome: string; pnl: number }> = [];

    for (const bet of pending) {
      const result = resultsMap.get(bet.eventId) ??
                     resultsMap.get(bet.match.toLowerCase());
      if (!result) continue; // match not yet finished

      const outcome = evaluateValueBet(
        bet.marketName, bet.selection,
        result.homeName, result.awayName,
        result.hScore, result.aScore,
      );

      if (outcome === "pending") continue;

      const actualReturn = outcome === "won" ? bet.stake * bet.bookOdds : 0;
      const pnl = outcome === "won" ? actualReturn - bet.stake :
                  outcome === "lost" ? -bet.stake : 0;

      const updated = await db
        .update(valueBetLog)
        .set({ outcome, actualReturn, pnl })
        .where(and(eq(valueBetLog.id, bet.id), eq(valueBetLog.outcome, "pending")))
        .returning({ id: valueBetLog.id });

      // Only report a settlement after PostgreSQL confirms the row was updated.
      // The pending guard also prevents concurrent cron/manual runs from settling
      // and counting the same value bet twice.
      if (!updated[0]) continue;

      settled++;
      if (outcome === "won")  { won++;  }
      if (outcome === "lost") { lost++; }
      if (outcome === "void") { voidBets++; }

      results.push({ id: bet.id, match: bet.match, market: bet.marketName, outcome, pnl });
    }

    const totalPnl = results.reduce((s, r) => s + r.pnl, 0);

    return Response.json({
      ok: true,
      pendingChecked: pending.length,
      settled, won, lost, void: voidBets,
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      results,
      ranAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Value bet verify error:", err);
    return Response.json({ error: "Verification failed" }, { status: 500 });
  }
}

export async function GET() { return POST(); }
