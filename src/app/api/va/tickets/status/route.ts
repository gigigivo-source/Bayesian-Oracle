import {
  isRunningRecord,
  readLatestScanLock,
  recordStartedAt,
} from "@/lib/va/scanLock";

export const dynamic = "force-dynamic";

/** Payload of GET /api/va/tickets/status. */
export interface VaScanStatusBody {
  running: boolean;
  mode: "value" | "stack" | "backtest" | null;
  startedAt: string | null;
  completedAt: string | null;
  scanId: string | null;
  error: string | null;
  elapsedSeconds: number | null;
}

const IDLE: VaScanStatusBody = {
  running: false,
  mode: null,
  startedAt: null,
  completedAt: null,
  scanId: null,
  error: null,
  elapsedSeconds: null,
};

/**
 * Background-scan job status: the latest va_scan_lock row, normalised.
 *
 * No auth — it exposes no odds, no stakes and no picks, only whether a scan is
 * in flight, and the /value-accumulator page polls it every 15s so a scan
 * started in a tab that was later closed can still be picked up.
 *
 * `running` is false for a row older than 15 minutes even if it still says
 * 'running': a recycled serverless function leaves the row behind, and the page
 * must not poll a dead job forever.
 *
 * Reads fail soft to the idle payload (HTTP 200): a database blip should cost a
 * poll cycle, not surface as an error sheet while a scan is healthy. The page
 * only stops polling on a mode match, and the idle payload has mode=null, so a
 * failed read can never be mistaken for "your scan finished".
 */
export async function GET(): Promise<Response> {
  let record;
  try {
    record = await readLatestScanLock();
  } catch (err) {
    console.error("[VA] scan status read failed", err);
    return Response.json(IDLE);
  }
  if (!record) return Response.json(IDLE);

  const startedAt = recordStartedAt(record);
  const completedAt = record.completedAt;
  const running = isRunningRecord(record);
  // Elapsed = up to completion for a finished job, up to now for a running one.
  const endReference = completedAt ?? (running ? new Date() : startedAt);
  const elapsedSeconds =
    startedAt !== null && endReference !== null
      ? Math.max(0, Math.round((endReference.getTime() - startedAt.getTime()) / 1000))
      : null;

  const body: VaScanStatusBody = {
    running,
    mode: record.mode,
    startedAt: startedAt !== null ? startedAt.toISOString() : null,
    completedAt: completedAt !== null ? completedAt.toISOString() : null,
    scanId: record.scanId,
    error: record.error,
    elapsedSeconds,
  };
  return Response.json(body);
}
