// Value Accumulator — va_scan_lock access (mutex + background-job record).
//
// The table has always been the "don't run two scans at once" mutex. Since
// drizzle/0008_extend_scan_lock.sql it is also the job record that
// GET /api/va/tickets/status reads, so a background scan survives the tab that
// started it: the row says whether a scan is running, which flavour it is, when
// it started/finished and why it failed.
//
// Two rules shape everything below:
//
//   1. STALE AFTER 15 MINUTES. A row left in status='running' by a process that
//      died (a serverless function being recycled is the normal case) must not
//      block scans forever, so a running row only counts while it is younger
//      than STALE_SCAN_LOCK_MS. Older rows are pruned and overwritten.
//   2. FAIL SOFT. The new columns may not exist yet on a database where 0008 has
//      not been applied, and drizzle selects every mapped column by name. Every
//      read therefore falls back to the legacy (locked_at + scan_id) projection
//      and every write is guarded: losing the job record must never fail a scan
//      that is otherwise healthy.
//
// Kept out of performScan.ts so the API routes can read the lock without
// importing the whole scan pipeline.

import { db } from "@/db";
import { vaScanLock, type VaScanLockRow } from "@/db/schema";
import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import crypto from "crypto";

/** Background-job lifecycle stored in va_scan_lock.status. */
export type VaScanLockStatus = "running" | "done" | "error";

/**
 * Scan flavour stored in va_scan_lock.mode. `backtest` is the finished=true
 * scan; `value` / `stack` are the live ones. Both page chips POST mode=stack,
 * so this is what lets the page tell which of its two scans completed.
 */
export type VaScanLockMode = "value" | "stack" | "backtest";

/** A running row older than this is stale: ignored, pruned, overwritten. */
export const STALE_SCAN_LOCK_MS = 15 * 60 * 1000;

/**
 * Window in which a legacy lock row (no status — written before 0008, or by a
 * build that could not write the new columns) still counts as "a scan is in
 * flight". This is the 5-minute rule performScan has always applied.
 */
export const FOREGROUND_LOCK_WINDOW_MS = 5 * 60 * 1000;

/** Normalised view of a va_scan_lock row (legacy rows included). */
export interface ScanLockRecord {
  id: number | null;
  scanId: string | null;
  status: VaScanLockStatus | null;
  mode: VaScanLockMode | null;
  startedAt: Date | null;
  completedAt: Date | null;
  /** Legacy column; used as startedAt when the new one is absent. */
  lockedAt: Date | null;
  error: string | null;
}

export interface ScanLockPatch {
  status?: VaScanLockStatus;
  mode?: VaScanLockMode;
  scanId?: string;
  startedAt?: Date | null;
  completedAt?: Date | null;
  error?: string | null;
}

/** Same format performScan has always used: `va_<epoch-ms>_<8 hex>`. */
export function newScanId(): string {
  return `va_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const d = new Date(value.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function normaliseStatus(value: unknown): VaScanLockStatus | null {
  return value === "running" || value === "done" || value === "error" ? value : null;
}

function normaliseMode(value: unknown): VaScanLockMode | null {
  return value === "value" || value === "stack" || value === "backtest" ? value : null;
}

function toRecord(row: Partial<VaScanLockRow>): ScanLockRecord {
  return {
    id: typeof row.id === "number" ? row.id : null,
    scanId: typeof row.scanId === "string" ? row.scanId : null,
    status: normaliseStatus(row.status),
    mode: normaliseMode(row.mode),
    startedAt: toDate(row.startedAt),
    completedAt: toDate(row.completedAt),
    lockedAt: toDate(row.lockedAt),
    error: typeof row.error === "string" ? row.error : null,
  };
}

/** Best-effort "when did this row's scan start" (started_at, else locked_at). */
export function recordStartedAt(record: ScanLockRecord): Date | null {
  return record.startedAt ?? record.lockedAt;
}

/** True while the row describes a scan that is still plausibly in flight. */
export function isRunningRecord(record: ScanLockRecord, now: number = Date.now()): boolean {
  const startedAt = recordStartedAt(record);
  if (startedAt === null) return false;
  if (now - startedAt.getTime() >= STALE_SCAN_LOCK_MS) return false; // stale
  // A NULL status is a legacy row: foreground scans insert one for the duration
  // of the scan and delete it when they finish, so a fresh one means "running".
  return record.status === "running" || record.status === null;
}

/**
 * The running (non-stale) scan, or null. Spec'd query — status='running' AND
 * started_at > now() - INTERVAL '15 minutes' — with the 15-minute rule
 * re-applied in JS so a stale row can never block a new scan even if the DB
 * clock or session timezone disagrees with the app's.
 */
export async function findRunningScanLock(): Promise<ScanLockRecord | null> {
  try {
    const rows = await db
      .select()
      .from(vaScanLock)
      .where(
        and(
          eq(vaScanLock.status, "running"),
          gt(vaScanLock.startedAt, sql`now() - interval '15 minutes'`),
        ),
      )
      .orderBy(desc(vaScanLock.startedAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const record = toRecord(row);
    return record.status === "running" && isRunningRecord(record) ? record : null;
  } catch (err) {
    // Almost always "column status/started_at does not exist" — 0008 not applied
    // yet. Fall back to the legacy projection rather than failing the request.
    console.error("[VA] scan-lock running check failed, falling back to locked_at", err);
    return findLegacyRunningLock();
  }
}

async function findLegacyRunningLock(): Promise<ScanLockRecord | null> {
  try {
    const rows = await db
      .select({ id: vaScanLock.id, scanId: vaScanLock.scanId, lockedAt: vaScanLock.lockedAt })
      .from(vaScanLock)
      .orderBy(desc(vaScanLock.lockedAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const record = toRecord(row);
    return isRunningRecord(record) ? record : null;
  } catch {
    return null;
  }
}

/**
 * Is a scan already in flight? Used by performScan before it starts work, so a
 * foreground scan (cron, curl, server action) and a background scan (the page's
 * chips) can never run at the same time.
 *
 *   - status='running' and younger than 15 minutes → blocked
 *   - a legacy row (no status) younger than 5 minutes → blocked
 *   - status='done' / 'error' → NOT a lock: those rows are kept as the history
 *     GET /api/va/tickets/status reports.
 */
export async function findBlockingScanLock(): Promise<ScanLockRecord | null> {
  const running = await findRunningScanLock();
  if (running) return running;

  try {
    const rows = await db.select().from(vaScanLock).orderBy(desc(vaScanLock.id)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const record = toRecord(row);
    if (record.status === "done" || record.status === "error") return null;
    const startedAt = recordStartedAt(record);
    if (startedAt === null) return null;
    return Date.now() - startedAt.getTime() < FOREGROUND_LOCK_WINDOW_MS ? record : null;
  } catch (err) {
    console.error("[VA] scan-lock blocking check failed", err);
    return null;
  }
}

/**
 * Latest row by insertion order (id is a serial, so the newest row wins) —
 * what GET /api/va/tickets/status reports. Null when the table is empty or
 * unreadable.
 */
export async function readLatestScanLock(): Promise<ScanLockRecord | null> {
  try {
    const rows = await db.select().from(vaScanLock).orderBy(desc(vaScanLock.id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  } catch (err) {
    console.error("[VA] latest scan-lock read failed, falling back to locked_at", err);
    try {
      const rows = await db
        .select({ id: vaScanLock.id, scanId: vaScanLock.scanId, lockedAt: vaScanLock.lockedAt })
        .from(vaScanLock)
        .orderBy(desc(vaScanLock.id))
        .limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    } catch {
      return null;
    }
  }
}

/**
 * Deletes stale locks — the "rows older than 15 min are stale, overwrite them"
 * half of the background-job contract:
 *   - status='running' rows whose started_at is older than 15 minutes (a process
 *     that died mid-scan; the normal case on a serverless runtime)
 *   - legacy rows (status IS NULL) whose locked_at is older than 15 minutes
 * Completed and failed rows are deliberately KEPT: they are the history the
 * status endpoint reports, including the "finished while your tab was closed"
 * resume path on the page.
 */
export async function pruneStaleScanLocks(): Promise<void> {
  try {
    await db
      .delete(vaScanLock)
      .where(
        or(
          and(
            eq(vaScanLock.status, "running"),
            lt(vaScanLock.startedAt, sql`now() - interval '15 minutes'`),
          ),
          and(
            isNull(vaScanLock.status),
            lt(vaScanLock.lockedAt, sql`now() - interval '15 minutes'`),
          ),
        ),
      );
  } catch {
    // Legacy schema (no status/started_at) or no DB: nothing to prune. A
    // foreground scan still clears its own row when it finishes.
  }
}

/**
 * Writes the status='running' row for a scan that is about to start.
 * Returns false only when even the legacy insert fails (no database at all),
 * which the caller turns into a 500 rather than a scan nobody can observe.
 */
export async function acquireScanLock(opts: {
  scanId: string;
  mode: VaScanLockMode;
  startedAt?: Date;
}): Promise<boolean> {
  const startedAt = opts.startedAt ?? new Date();
  try {
    await db.insert(vaScanLock).values({
      scanId: opts.scanId,
      lockedAt: startedAt,
      status: "running",
      mode: opts.mode,
      startedAt,
    });
    return true;
  } catch (err) {
    // Most likely cause: drizzle/0008 has not been applied yet. Note that a
    // second drizzle insert would NOT help — drizzle always lists every mapped
    // column (filling the omitted ones with `default`), so the statement fails
    // on the missing columns again. Raw SQL naming only the two columns that
    // have existed since 0004 is what actually degrades gracefully: the scan
    // still gets its mutex, it just isn't observable via /status until the
    // migration lands.
    console.error("[VA] scan-lock insert failed, retrying with legacy columns only", err);
    try {
      await db.execute(
        sql`insert into va_scan_lock (scan_id, locked_at) values (${opts.scanId}, ${startedAt})`,
      );
      return true;
    } catch (err2) {
      console.error("[VA] scan-lock insert failed (legacy columns too)", err2);
      return false;
    }
  }
}

/**
 * Patches the job record of a scan (status/completed_at/error/…). Fail-soft:
 * the scan itself already succeeded or failed on its own merits, so a missing
 * column here is logged, not thrown.
 */
export async function updateScanLock(scanId: string, patch: ScanLockPatch): Promise<void> {
  try {
    await db.update(vaScanLock).set(patch).where(eq(vaScanLock.scanId, scanId));
  } catch (err) {
    console.error(`[VA] failed to update scan lock ${scanId}`, err);
  }
}
