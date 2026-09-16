import { db } from "@/db";
import { vaScanLock, vaTickets } from "@/db/schema";
import { desc, lt, sql } from "drizzle-orm";
import { scanValueLegs, scanFinishedLegs, settleBacktestTickets, type BacktestMatchResult, type VaScanMode } from "@/lib/va/scanner";
import { buildTickets } from "@/lib/va/ticket";
import crypto from "crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function getCronSecret(): string {
  return (process.env.CRON_SECRET ?? "").trim();
}

function getMondayCat(): string {
  const now = new Date();
  const catMs = now.getTime() + 2 * 60 * 60 * 1000;
  const catDate = new Date(catMs);
  const day = catDate.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(catDate);
  monday.setUTCDate(catDate.getUTCDate() + diff);
  monday.setUTCHours(0, 0, 0, 0);
  const y = monday.getUTCFullYear();
  const m = String(monday.getUTCMonth() + 1).padStart(2, "0");
  const d = String(monday.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function POST(req: Request) {
  // Protected by CRON_SECRET header
  const auth = req.headers.get("authorization") || req.headers.get("x-cron-secret") || "";
  const secret = getCronSecret();
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : auth.trim();
  // Also allow ?secret= or header CRON_SECRET
  const url = new URL(req.url);
  const querySecret = url.searchParams.get("secret")?.trim() ?? "";

  if (secret) {
    const ok = provided === secret || querySecret === secret || req.headers.get("cron_secret") === secret;
    if (!ok) {
      return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
  }

  // Check va_scan_lock. If a lock row exists younger than 5 minutes, return already in progress
  try {
    const existingLocks = await db.select().from(vaScanLock).orderBy(desc(vaScanLock.lockedAt)).limit(1);
    if (existingLocks.length > 0) {
      const lock = existingLocks[0];
      const lockedAt = new Date(lock.lockedAt as any).getTime();
      const now = Date.now();
      if (now - lockedAt < 5 * 60 * 1000) {
        return Response.json({ ok: false, reason: "scan already in progress" }, { status: 200 });
      } else {
        // Stale lock, delete it
        await db.delete(vaScanLock).where(lt(vaScanLock.lockedAt, new Date(now - 5 * 60 * 1000) as any));
      }
    }
  } catch (e) {
    console.error("[VA] lock check failed", e);
    // Continue anyway
  }

  const scanId = `va_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  try {
    await db.insert(vaScanLock).values({
      scanId,
      lockedAt: new Date(),
    });
  } catch (e) {
    console.error("[VA] failed to insert lock", e);
    return Response.json({ ok: false, reason: "failed to acquire lock" }, { status: 500 });
  }

  let scanResult;
  let ticketsBuilt: any[] = [];
  let recommendedTicketId: number | null = null;

  try {
    const modeParam = url.searchParams.get("mode")?.trim().toLowerCase();
    const mode: VaScanMode = modeParam === "stack" ? "stack" : "value";
    const finished = url.searchParams.get("finished") === "true";

    // Run scanner (?finished=true backtests the last 14 days of finished matches)
    let finishedResults: Map<string, BacktestMatchResult> | null = null;
    if (finished) {
      scanResult = await scanFinishedLegs(scanId, mode);
      finishedResults = scanResult.results;
    } else {
      scanResult = await scanValueLegs(scanId, 7, mode);
    }

    // Partitioner
    const built = buildTickets(scanResult.legs, mode);

    // Backtest mode: settle tickets immediately against the finished results
    const settledStatuses = finishedResults ? await settleBacktestTickets(built, finishedResults) : null;

    // Write tickets to va_tickets. Once written, immutable — never updated by later scans
    const weekStart = getMondayCat();
    const insertedIds: number[] = [];

    for (let i = 0; i < built.length; i++) {
      const ticket = built[i];
      const ticketStatus = settledStatuses ? settledStatuses[i] : "pending";
      try {
        const inserted = await db
          .insert(vaTickets)
          .values({
            scanId,
            weekStart: weekStart as any,
            legs: ticket.legs as any,
            combinedOdds: ticket.combinedOdds,
            combinedProbability: ticket.combinedProbability,
            combinedEv: ticket.combinedEv,
            kellyScore: ticket.kellyScore,
            stakePercent: ticket.stakePercent,
            isRecommended: ticket.isRecommended,
            isReferenceOnly: ticket.isReferenceOnly,
            status: ticketStatus,
            ...(settledStatuses ? { settledAt: new Date() } : {}),
          })
          .returning({ id: vaTickets.id });
        if (inserted.length > 0) {
          insertedIds.push(inserted[0].id);
          if (ticket.isRecommended) {
            recommendedTicketId = inserted[0].id;
          }
        }
      } catch (err) {
        console.error("[VA] failed to insert ticket", err);
      }
    }

    ticketsBuilt = built;

    // Delete lock
    try {
      await db.delete(vaScanLock).where(sql`${vaScanLock.scanId} = ${scanId}`);
    } catch {}

    let settled: { won: number; lost: number; pending: number; realisedRate: number } | null = null;
    if (settledStatuses) {
      const won = settledStatuses.filter((s) => s === "won").length, lost = settledStatuses.filter((s) => s === "lost").length;
      settled = { won, lost, pending: settledStatuses.length - won - lost, realisedRate: (won + lost) / Math.max(1, settledStatuses.length) };
    }

    return Response.json({
      ok: true,
      scanId,
      matchesScanned: scanResult.matchesScanned,
      marketsEvaluated: scanResult.marketsEvaluated,
      legsQualified: scanResult.legsQualified,
      ticketsBuilt: built.length,
      recommendedTicketId,
      ...(settled ? { settled } : {}),
    });
  } catch (err) {
    console.error("[VA] scan failed", err);
    try {
      await db.delete(vaScanLock).where(sql`${vaScanLock.scanId} = ${scanId}`);
    } catch {}
    return Response.json(
      {
        ok: false,
        reason: "scan failed",
        error: String(err),
        scanId,
      },
      { status: 500 }
    );
  }
}
