// ĞIGI GIVØ — Value Bet Tracking & Post-Match Verification
// Logs value bets and verifies them against real match outcomes.

import { db } from "@/db";
import { valueBetLog } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { fetchScoreboard } from "@/lib/espn";
import { TOP_FEED_SLUGS } from "@/lib/leagues";
import type { FixtureLite } from "@/lib/espn";

export const dynamic = "force-dynamic";

// ─── GET: fetch all value bets with performance stats ─────────────────────────
export async function GET() {
  try {
    const bets = await db.select().from(valueBetLog).orderBy(desc(valueBetLog.createdAt)).limit(200);

    const settled  = bets.filter((b) => b.outcome === "won" || b.outcome === "lost");
    const won      = bets.filter((b) => b.outcome === "won");
    const lost     = bets.filter((b) => b.outcome === "lost");
    const pending  = bets.filter((b) => b.outcome === "pending");

    const totalStaked   = settled.reduce((s, b) => s + (b.stake ?? 10), 0);
    const totalReturns  = won.reduce((s, b) => s + (b.actualReturn ?? (b.stake ?? 10) * (b.bookOdds ?? 1)), 0);
    const totalPnl      = totalReturns - totalStaked;
    const roi           = totalStaked > 0 ? (totalPnl / totalStaked) * 100 : 0;
    const winRate       = settled.length > 0 ? (won.length / settled.length) * 100 : 0;
    const avgEdge       = bets.length > 0 ? bets.reduce((s, b) => s + b.valueEdge, 0) / bets.length : 0;

    return Response.json({
      bets: bets.map((b) => ({
        id:             b.id,
        match:          b.match,
        league:         b.leagueSlug,
        matchDate:      b.matchDate,
        marketName:     b.marketName,
        selection:      b.selection,
        oracleProb:     b.oracleProb,
        bookOdds:       b.bookOdds,
        valueEdge:      b.valueEdge,
        kellyStake:     b.kellyStake,
        stake:          b.stake,
        potentialReturn: b.potentialReturn,
        outcome:        b.outcome,
        actualReturn:   b.actualReturn,
        pnl:            b.pnl,
        createdAt:      b.createdAt,
      })),
      stats: {
        total:       bets.length,
        won:         won.length,
        lost:        lost.length,
        pending:     pending.length,
        settled:     settled.length,
        winRate:     parseFloat(winRate.toFixed(1)),
        roi:         parseFloat(roi.toFixed(1)),
        totalStaked: parseFloat(totalStaked.toFixed(2)),
        totalReturns: parseFloat(totalReturns.toFixed(2)),
        totalPnl:    parseFloat(totalPnl.toFixed(2)),
        avgEdge:     parseFloat((avgEdge * 100).toFixed(1)),
      },
    });
  } catch (err) {
    console.error("Value bet GET error:", err);
    return Response.json({ error: "Failed" }, { status: 500 });
  }
}

// ─── POST: log a new value bet ────────────────────────────────────────────────
export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      eventId: string; leagueSlug: string; match: string; matchDate: string;
      marketName: string; selection: string; oracleProb: number; bookOdds: number;
      valueEdge: number; kellyStake?: number; stake?: number;
    };

    const stake = body.stake ?? 10;
    const potentialReturn = parseFloat((stake * body.bookOdds).toFixed(2));

    await db.insert(valueBetLog).values({
      eventId:         body.eventId,
      leagueSlug:      body.leagueSlug,
      match:           body.match,
      matchDate:       body.matchDate,
      marketName:      body.marketName,
      selection:       body.selection,
      oracleProb:      body.oracleProb,
      bookOdds:        body.bookOdds,
      valueEdge:       body.valueEdge,
      kellyStake:      body.kellyStake ?? 0,
      stake,
      potentialReturn,
      outcome:         "pending",
    });

    return Response.json({ ok: true });
  } catch (err) {
    console.error("Value bet POST error:", err);
    return Response.json({ error: "Failed to log bet" }, { status: 500 });
  }
}
