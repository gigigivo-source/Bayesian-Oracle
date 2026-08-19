// ĞIGI GIVØ — Self-hosted error monitoring (Sentry-style) + health telemetry.
// Captures runtime errors into the DB error_log, always fail-soft (logging must
// never throw and never break a request). Read/aggregate via /api/monitoring.

import { db } from "@/db";
import { errorLog } from "@/db/schema";

export type LogLevel = "error" | "warn" | "info";

interface CaptureOpts {
  level?:   LogLevel;
  context?: Record<string, unknown>;
}

/**
 * Capture an error/event. Never throws — a failed capture is swallowed so it
 * can't cascade into the request it was trying to log.
 */
export async function captureError(
  source: string,
  err:    unknown,
  opts:   CaptureOpts = {},
): Promise<void> {
  try {
    const message = err instanceof Error ? err.message : String(err);
    const stack   = err instanceof Error ? (err.stack ?? null) : null;
    // Surface to server logs for real-time visibility.
    console.error(`[${opts.level ?? "error"}] ${source}: ${message}`);
    await db.insert(errorLog).values({
      level:   opts.level ?? "error",
      source,
      message: message.slice(0, 2000),
      stack:   stack?.slice(0, 6000) ?? null,
      context: opts.context ?? null,
    });
  } catch {
    // Logging must never break anything.
  }
}

/**
 * Wrap an async route handler so any thrown error is captured to the monitor
 * and a clean 500 is returned instead of an unhandled crash.
 */
export function withMonitoring<T extends unknown[]>(
  source:  string,
  handler: (...args: T) => Promise<Response>,
): (...args: T) => Promise<Response> {
  return async (...args: T): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      const url = args[0] instanceof Request ? args[0].url : undefined;
      await captureError(source, err, {
        context: url ? { url } : undefined,
      });
      return Response.json({ error: "Internal error", monitored: true }, { status: 500 });
    }
  };
}
