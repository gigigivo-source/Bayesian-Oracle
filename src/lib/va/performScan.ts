import { db } from "@/db";
import { vaScanLock, vaTickets } from "@/db/schema";
import { sql } from "drizzle-orm";
import { scanValueLegs, scanFinishedLegs, type VaScanMode } from "./scanner";
import { buildTickets } from "./ticket";
import { flushXgCache, resetXgCacheQueue } from "./xgFetcher";
import {
  acquireScanLock,
  findBlockingScanLock,
  newScanId,
  pruneStaleScanLocks,
  type VaScanLockMode,
} from "./scanLock";

// The batching primitive itself lives in ./parallel so scanner.ts can use it
// without importing this module (this module imports scanner.ts — a cycle).
// Re-exported here because performScan is the shared scan entry point, so the
// scan's concurrency contract is discoverable from one place.
export { FIXTURE_BATCH_SIZE, compactFixtureResults, runFixtureBatches } from "./parallel";
export type { FixtureWorker } from "./parallel";

/**
 * Shared implementation of the VA scan, used by both `POST /api/va/scan` and
 * the `runLiveScan` server action. Authentication is NOT handled here — the
 * route owns that; the server action is a trusted in-process call.
 *
 * `status` is the HTTP status the route should respond with; `body` is the
 * exact JSON payload the route has always returned.
 *
 * Fixtures inside the scan are processed in batches of FIXTURE_BATCH_SIZE (8)
 * rather than one at a time — see ./parallel for the ordering/isolation rules
 * the ticket builder depends on.
 */
export interface PerformScanResult {
  status: number;
  body: Record<string, unknown> & { ok: boolean };
}

/**
 * Optional controls for callers that own the job record themselves — namely the
 * route's background mode, which writes the status='running' va_scan_lock row
 * BEFORE firing the scan so GET /api/va/tickets/status can report it, and
 * updates that same row to done/error when the detached promise settles.
 */
export interface PerformScanOptions {
  /** Scan id to use (and to report in the body). Generated when omitted. */
  scanId?: string;
  /**
   * True when the caller already acquired the lock: skips the "is a scan
   * already running" check, the lock insert, and the end-of-scan lock release,
   * so the caller's row stays intact for the status endpoint.
   */
  lockHeld?: boolean;
}

export function getMondayCat(): string {
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

export async function performScan(
  mode: VaScanMode,
  finished: boolean,
  opts: PerformScanOptions = {},
): Promise<PerformScanResult> {
  const scanId = opts.scanId ?? newScanId();
  const lockHeld = opts.lockHeld === true;
  /** `backtest` is the finished=true flavour — that is how the page tells its two chips apart. */
  const lockMode: VaScanLockMode = finished ? "backtest" : mode;

  if (!lockHeld) {
    // Mutual exclusion. A running job (background or foreground, younger than
    // 15 minutes) or a legacy lock row younger than 5 minutes blocks this scan;
    // completed/failed rows are history, not locks. Fail-soft: if the lock
    // table is unreadable we scan anyway, exactly as before.
    try {
      const blocking = await findBlockingScanLock();
      if (blocking && blocking.scanId !== scanId) {
        return { status: 200, body: { ok: false, reason: "scan already in progress" } };
      }
    } catch (e) {
      console.error("[VA] lock check failed", e);
      // Continue anyway
    }

    // Stale rows (older than 15 minutes) are overwritten rather than honoured.
    await pruneStaleScanLocks();

    const acquired = await acquireScanLock({ scanId, mode: lockMode });
    if (!acquired) {
      return { status: 500, body: { ok: false, reason: "failed to acquire lock" } };
    }
  }

  /**
   * A foreground scan deletes its own lock row when it finishes — the behaviour
   * this function has always had. A background scan's row belongs to the route:
   * it is flipped to done/error there, after the response has already gone out,
   * so the status endpoint (and the page polling it) can see the outcome.
   */
  const releaseLock = async (): Promise<void> => {
    if (lockHeld) return;
    try {
      await db.delete(vaScanLock).where(sql`${vaScanLock.scanId} = ${scanId}`);
    } catch {}
  };

  try {
    // xG rows fetched during this scan are queued and persisted in ONE batched
    // UPSERT per table by flushXgCache() in the finally block below. Resetting
    // first means a scan that died halfway never leaks its queue into the next
    // scan's flush.
    resetXgCacheQueue();

    try {
      if (finished) {
        const finishedScan = await scanFinishedLegs(scanId, mode);

        await releaseLock();

        return {
          status: 200,
          body: {
            ok: true,
            scanId,
            matchesScanned: finishedScan.matchesScanned,
            marketsEvaluated: finishedScan.marketsEvaluated,
            legsQualified: finishedScan.legsQualified,
            ticketsBuilt: finishedScan.tickets.length,
            recommendedTicketId: null,
            legsQualifiedBacktest: finishedScan.legsQualified,
            ticketsBuiltBacktest: finishedScan.tickets.length,
            settled: {
              won: finishedScan.ticketBacktest.won,
              lost: finishedScan.ticketBacktest.lost,
              pending: finishedScan.ticketBacktest.pending,
              realisedRate: finishedScan.ticketBacktest.realisedRate,
            },
            ticketBacktest: finishedScan.ticketBacktest,
          },
        };
      }

      const scanResult = await scanValueLegs(scanId, 7, mode);
      const built = buildTickets(scanResult.legs, mode);

      // Write tickets to va_tickets. Once written, immutable — never updated by later scans.
      const persistCount = built.length;
      const weekStart = getMondayCat();
      const insertedIds: number[] = [];
      let recommendedTicketId: number | null = null;

      for (let i = 0; i < persistCount; i++) {
        const ticket = built[i];
        try {
          const inserted = await db
            .insert(vaTickets)
            .values({
              scanId,
              weekStart: weekStart as any,
              legs: ticket.legs as any,
              combinedOdds: ticket.combinedOdds,
              combinedProbability: ticket.combinedProbability,
              independentProbability: ticket.independentProbability?.toString() ?? null,
              combinedEv: ticket.combinedEv,
              kellyScore: ticket.kellyScore,
              stakePercent: ticket.stakePercent,
              isRecommended: ticket.isRecommended,
              isReferenceOnly: ticket.isReferenceOnly,
              status: "pending",
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

      await releaseLock();

      return {
        status: 200,
        body: {
          ok: true,
          scanId,
          matchesScanned: scanResult.matchesScanned,
          marketsEvaluated: scanResult.marketsEvaluated,
          legsQualified: scanResult.legsQualified,
          ticketsBuilt: built.length,
          recommendedTicketId,
        },
      };
    } catch (err) {
      console.error("[VA] scan failed", err);
      await releaseLock();
      return {
        status: 500,
        body: {
          ok: false,
          reason: "scan failed",
          error: String(err),
          scanId,
        },
      };
    }
  } finally {
    // Bank every xG row this scan fetched, whatever happened above: a scan that
    // threw halfway still paid for the data it did get. Fail-soft by contract.
    await flushXgCache();
  }
}
