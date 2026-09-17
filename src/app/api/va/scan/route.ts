import { keepDbAlive } from "@/db";
import { performScan } from "@/lib/va/performScan";
import type { VaScanMode } from "@/lib/va/scanner";
import {
  acquireScanLock,
  findRunningScanLock,
  newScanId,
  pruneStaleScanLocks,
  updateScanLock,
  type VaScanLockMode,
} from "@/lib/va/scanLock";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function getCronSecret(): string {
  return (process.env.CRON_SECRET ?? "").trim();
}

/** Human-readable failure reason for the job record's `error` column. */
function reasonFromBody(body: Record<string, unknown>): string {
  const reason = typeof body.reason === "string" ? body.reason : null;
  const error = typeof body.error === "string" ? body.error : null;
  return [reason, error].filter((part): part is string => Boolean(part)).join(": ") || "scan failed";
}

/**
 * Runs the VA scan; ?finished=true skips authentication for local backtests.
 * All other requests retain the existing CRON_SECRET authentication check.
 *
 * The scan itself lives in `@/lib/va/performScan` so the in-app server action
 * (`runLiveScan`) can share it without an HTTP hop or the bearer secret.
 *
 * ── ?background=true ─────────────────────────────────────────────────────────
 * Detaches the scan: the lock row is written first (status='running'), the scan
 * is fired WITHOUT awaiting, and `{ ok: true, status: "started" }` goes out
 * immediately (~1s instead of 4-6 minutes). The caller then polls
 * GET /api/va/tickets/status, which reads that same row — so the tab that
 * started the scan can be closed and the page picks the result up when it comes
 * back. A second background request while one is running (< 15 minutes old)
 * gets 409; rows older than 15 minutes are stale and are overwritten.
 *
 * KNOWN LIMITATION (serverless): a detached promise is not guaranteed to
 * survive the response on a serverless runtime — Vercel/Next.js may freeze or
 * recycle the function once the response is flushed, which leaves the row stuck
 * at status='running' until the 15-minute staleness rule clears it. This works
 * on a long-lived Node process (local dev, `next start`, a container) and is
 * what the /value-accumulator page targets. Production needs a real job queue
 * (or Vercel's `waitUntil`) to make background scans durable; the status
 * endpoint and the lock table are already shaped for that swap.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const finished = url.searchParams.get("finished") === "true";
  const background = url.searchParams.get("background") === "true";

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

  const modeParam = url.searchParams.get("mode")?.trim().toLowerCase();
  const mode: VaScanMode = modeParam === "stack" ? "stack" : "value";

  // Foreground (default): await the scan and return its full body, as before.
  if (!background) {
    const result = await performScan(mode, finished);
    return Response.json(result.body, { status: result.status });
  }

  // Background job mode. `backtest` is the finished=true flavour, which is how
  // the page tells its two chips apart when it polls the status endpoint.
  const lockMode: VaScanLockMode = finished ? "backtest" : mode;

  // 1. Refuse while another scan is running. Stale (> 15 min) rows don't count.
  const running = await findRunningScanLock();
  if (running) {
    return Response.json({ ok: false, error: "a scan is already running" }, { status: 409 });
  }

  // 2. Claim the job record before firing, so the very first status poll after
  //    this response already sees status='running'.
  const scanId = newScanId();
  await pruneStaleScanLocks();
  const acquired = await acquireScanLock({ scanId, mode: lockMode });
  if (!acquired) {
    return Response.json({ ok: false, error: "failed to acquire scan lock" }, { status: 500 });
  }

  // Keep the pooled connection warm for the duration of the detached scan
  // (Neon closes idle connections long before a 4-6 minute scan finishes — the
  // same reason actions.ts pings). unref'd so it can never hold a test or a
  // draining process open.
  const ping = setInterval(() => {
    void keepDbAlive();
  }, 60_000);
  (ping as { unref?: () => void }).unref?.();

  // 3. Fire WITHOUT awaiting. The lock row this route wrote is the job record:
  //    performScan is told the lock is already held so it neither re-checks nor
  //    deletes it, and the outcome is written here when the promise settles.
  void performScan(mode, finished, { scanId, lockHeld: true })
    .then((result) => {
      // performScan reports its own failures as { ok: false } with status 500
      // rather than throwing, so both paths have to land in the job record —
      // otherwise a failed scan would be published as "done".
      const ok = result.status < 400 && result.body.ok === true;
      return updateScanLock(scanId, {
        status: ok ? "done" : "error",
        completedAt: new Date(),
        scanId: typeof result.body.scanId === "string" ? result.body.scanId : scanId,
        error: ok ? null : reasonFromBody(result.body),
      });
    })
    .catch((err) =>
      updateScanLock(scanId, { status: "error", completedAt: new Date(), error: String(err) }),
    )
    .finally(() => clearInterval(ping));

  // 4. Return immediately; the page polls /api/va/tickets/status from here on.
  return Response.json({ ok: true, status: "started" });
}
