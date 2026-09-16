import { db } from "@/db";
import { vaScanLock, vaTickets } from "@/db/schema";
import { desc, lt, sql } from "drizzle-orm";
import { scanValueLegs, scanFinishedLegs, type BacktestSampleTicket, type VaScanMode } from "@/lib/va/scanner";
import { buildTickets } from "@/lib/va/ticket";
import crypto from "crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function getCronSecret(): string {
  return (process.env.CRON_SECRET ?? "").trim();
}

interface TicketBacktestBucket {
  claimed: number;
  n: number;
  won: number;
  lost: number;
  realised: number;
  diff: number;
}

interface TicketBacktest {
  totalTickets: number;
  settledTickets: number;
  pendingTickets: number;
  overallRealisedRate: number | null;
  ticketBuckets: TicketBacktestBucket[];
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

/**
 * Runs the VA scan; ?finished=true skips authentication for local backtests.
 * All other requests retain the existing CRON_SECRET authentication check.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const finished = url.searchParams.get("finished") === "true";

  if (!finished) {
    // Protected by CRON_SECRET header
    const auth = req.headers.get("authorization") || req.headers.get("x-cron-secret") || "";
    const secret = getCronSecret();
    const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : auth.trim();
    // Also allow ?secret= or header CRON_SECRET
    const querySecret = url.searchParams.get("secret")?.trim() ?? "";

    if (secret) {
      const ok = provided === secret || querySecret === secret || req.headers.get("cron_secret") === secret;
      if (!ok) {
        return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
      }
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

    // Run scanner (?finished=true backtests the last 30 days of finished matches).
    // Backtest mode: the scanner samples 3-leg combinations itself (settled,
    // fair-odds priced) and hands them back as `tickets`.
    let backtestTickets: BacktestSampleTicket[] = [];
    if (finished) {
      const finishedScan = await scanFinishedLegs(scanId, mode);
      scanResult = finishedScan;
      backtestTickets = finishedScan.tickets;
    } else {
      scanResult = await scanValueLegs(scanId, 7, mode);
    }

    // Partitioner — live path only. The backtest path does NOT use buildTickets:
    // its odds-window/family-cap/exposure constraints don't belong in a
    // calibration sample, so the scanner's combination samples are used instead.
    const built = finished ? backtestTickets : buildTickets(scanResult.legs, mode);

    // Backtest mode: every sample was settled inside the scanner (combinations
    // containing a leg with an unknown result are skipped there), so the
    // statuses come straight off the samples themselves.
    const settledStatuses = finished ? backtestTickets.map((t) => t.status) : null;

    // Write tickets to va_tickets. Once written, immutable — never updated by later scans.
    // Backtest samples: persist only the first 5 — the sheet's sample list is a
    // preview; the full sample set (up to 2000 combinations) is reported in the
    // scan response, not in the ticket table.
    const persistCount = finished ? Math.min(5, built.length) : built.length;
    const weekStart = getMondayCat();
    const insertedIds: number[] = [];

    for (let i = 0; i < persistCount; i++) {
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

    let settled: { won: number; lost: number; pending: number; realisedRate: number | null } | null = null;
    let ticketBacktest: TicketBacktest | null = null;
    if (settledStatuses) {
      const won = settledStatuses.filter((s) => s === "won").length;
      const lost = settledStatuses.filter((s) => s === "lost").length;
      const settledCount = won + lost;
      // realisedRate = won / (won + lost); null when nothing has settled yet.
      settled = {
        won,
        lost,
        pending: settledStatuses.length - settledCount,
        realisedRate: settledCount === 0 ? null : won / settledCount,
      };

      // Ticket-level calibration: bucket the settled samples (won/lost only —
      // pending samples are counted separately, never bucketed) by the combined
      // probability the model claimed for the sample, in 0.05-wide buckets.
      // Threshold n >= 5: combination sampling yields far more samples than the
      // old ticket builder ever did, so each bucket can afford a higher bar.
      const round3 = (v: number) => Math.round(v * 1000) / 1000;
      const buckets = new Map<number, { won: number; lost: number }>();
      for (let i = 0; i < built.length; i++) {
        const status = settledStatuses[i];
        if (status === "pending") continue;
        // Bucket key = Math.floor(combinedProbability / 0.05) * 0.05 (FP-safe).
        const idx = Math.floor(built[i].combinedProbability / 0.05 + 1e-6);
        const bucket = buckets.get(idx) ?? { won: 0, lost: 0 };
        bucket[status === "won" ? "won" : "lost"] += 1;
        buckets.set(idx, bucket);
      }
      const ticketBuckets: TicketBacktestBucket[] = Array.from(buckets.entries())
        .filter(([, bucket]) => bucket.won + bucket.lost >= 5)
        .map(([idx, bucket]) => {
          const claimed = round3(idx / 20); // bucket start on the 0.05 grid
          const realised = bucket.won / (bucket.won + bucket.lost);
          return {
            claimed,
            n: bucket.won + bucket.lost,
            won: bucket.won,
            lost: bucket.lost,
            realised: round3(realised),
            diff: round3(realised - claimed),
          };
        })
        .sort((a, b) => a.claimed - b.claimed);

      ticketBacktest = {
        totalTickets: built.length,
        settledTickets: settledCount,
        pendingTickets: settledStatuses.length - settledCount,
        overallRealisedRate: settledCount === 0 ? null : won / settledCount,
        ticketBuckets,
      };
    }

    return Response.json({
      ok: true,
      scanId,
      matchesScanned: scanResult.matchesScanned,
      marketsEvaluated: scanResult.marketsEvaluated,
      legsQualified: scanResult.legsQualified,
      ticketsBuilt: built.length,
      recommendedTicketId,
      ...(finished
        ? { legsQualifiedBacktest: scanResult.legsQualified, ticketsBuiltBacktest: built.length }
        : {}),
      ...(settled ? { settled } : {}),
      ...(ticketBacktest ? { ticketBacktest } : {}),
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
