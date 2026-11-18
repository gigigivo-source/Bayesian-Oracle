// ĞIGI GIVØ — Value Bet Tracking & Post-Match Verification
// Logs value bets and verifies them against real match outcomes.

import { apiError } from "@/lib/apiErrors";
import { db } from "@/db";
import { valueBetLog } from "@/db/schema";
import { desc } from "drizzle-orm";
import { asNumber, asRecord, roundTo } from "@/lib/data/sources/shared";

export const dynamic = "force-dynamic";

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function serverError(label: string, err: unknown): Response {
  console.error(label, err);
  return apiError("Database query failed", err);
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function safeNumber(value: unknown, fallback = 0): number {
  return asNumber(value) ?? fallback;
}

// ─── GET: fetch all value bets with performance stats ─────────────────────────
export async function GET() {
  try {
  try {
    const bets = await db.select().from(valueBetLog).orderBy(desc(valueBetLog.createdAt)).limit(200);

    const settled  = bets.filter((b) => b.outcome === "won" || b.outcome === "lost");
    const won      = bets.filter((b) => b.outcome === "won");
    const lost     = bets.filter((b) => b.outcome === "lost");
    const pending  = bets.filter((b) => b.outcome === "pending");

    const totalStaked = settled.reduce((s, b) => s + safeNumber(b.stake, 10), 0);
    const totalReturns = won.reduce((s, b) => {
      if (b.actualReturn !== null && b.actualReturn !== undefined) {
        return s + safeNumber(b.actualReturn, 0);
      }
      return s + safeNumber(b.stake, 10) * safeNumber(b.bookOdds, 1);
    }, 0);
    const totalPnl = totalReturns - totalStaked;
    const roi = totalStaked > 0 ? (totalPnl / totalStaked) * 100 : 0;
    const winRate = settled.length > 0 ? (won.length / settled.length) * 100 : 0;
    const avgEdge = bets.length > 0
      ? bets.reduce((s, b) => s + safeNumber(b.valueEdge, 0), 0) / bets.length
      : 0;

    return Response.json({
      bets: bets.map((b) => ({
        id:             b.id,
        match:          b.match,
        league:         b.leagueSlug,
        matchDate:      b.matchDate,
        marketName:     b.marketName,
        selection:      b.selection,
        oracleProb:     safeNumber(b.oracleProb),
        bookOdds:       safeNumber(b.bookOdds, 1),
        valueEdge:      safeNumber(b.valueEdge),
        kellyStake:     safeNumber(b.kellyStake),
        stake:          safeNumber(b.stake, 10),
        potentialReturn: safeNumber(b.potentialReturn),
        outcome:        b.outcome,
        actualReturn:   b.actualReturn === null ? null : safeNumber(b.actualReturn, 0),
        pnl:            b.pnl === null ? null : safeNumber(b.pnl, 0),
        createdAt:      b.createdAt,
      })),
      stats: {
        total:       bets.length,
        won:         won.length,
        lost:        lost.length,
        pending:     pending.length,
        settled:     settled.length,
        winRate:     roundTo(winRate, 1),
        roi:         roundTo(roi, 1),
        totalStaked: roundTo(totalStaked, 2),
        totalReturns: roundTo(totalReturns, 2),
        totalPnl:    roundTo(totalPnl, 2),
        avgEdge:     roundTo(avgEdge * 100, 1),
      },
    });
  } catch (err) {
    return serverError("Value bet GET error:", err);
  }

  } catch (__routeError) {
    return apiError("GET /api/value-bets failed", __routeError);
  }
}

// ─── POST: log a new value bet ────────────────────────────────────────────────
export async function POST(req: Request) {
  try {
  let body: unknown;
  try {
    body = await req.json();
  } catch (__caughtError) {
    console.error("[API] Swallowed upstream error at src/app/api/value-bets/route.ts:101", __caughtError);
    return badRequest("Invalid JSON body");
  }

  const data = asRecord(body);
  if (!data) return badRequest("Invalid request body");

  const eventId = requiredString(data.eventId);
  const leagueSlug = requiredString(data.leagueSlug);
  const match = requiredString(data.match);
  const matchDate = requiredString(data.matchDate);
  const marketName = requiredString(data.marketName);
  const selection = requiredString(data.selection);
  const oracleProb = asNumber(data.oracleProb);
  const bookOdds = asNumber(data.bookOdds);
  const valueEdge = asNumber(data.valueEdge);
  const kellyStake = data.kellyStake === undefined ? 0 : asNumber(data.kellyStake);
  const stake = data.stake === undefined ? 10 : asNumber(data.stake);

  if (!eventId || !leagueSlug || !match || !matchDate || !marketName || !selection) {
    return badRequest("Missing required fields");
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(matchDate)) {
    return badRequest("Invalid matchDate");
  }
  if (oracleProb === null || oracleProb < 0 || oracleProb > 1) {
    return badRequest("Invalid oracleProb");
  }
  if (bookOdds === null || bookOdds <= 1) {
    return badRequest("Invalid bookOdds");
  }
  if (valueEdge === null) {
    return badRequest("Invalid valueEdge");
  }
  if (kellyStake === null || kellyStake < 0) {
    return badRequest("Invalid kellyStake");
  }
  if (stake === null || stake < 0) {
    return badRequest("Invalid stake");
  }

  const potentialReturn = roundTo(stake * bookOdds, 2);
  if (!Number.isFinite(potentialReturn)) {
    return badRequest("Invalid potentialReturn");
  }

  try {
    await db.insert(valueBetLog).values({
      eventId,
      leagueSlug,
      match,
      matchDate,
      marketName,
      selection,
      oracleProb,
      bookOdds,
      valueEdge,
      kellyStake,
      stake,
      potentialReturn,
      outcome: "pending",
    });
    return Response.json({ ok: true });
  } catch (err) {
    return serverError("Value bet POST error:", err);
  }

  } catch (__routeError) {
    return apiError("POST /api/value-bets failed", __routeError);
  }
}
