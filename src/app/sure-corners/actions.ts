"use server";

// ĞIGI GIVØ — Server actions for the Sure Bet Corners page.
//
// The post-match verification used to be called from the browser as
//   fetch("/api/sure-corners/verify", { headers: { Authorization: `Bearer
//     ${process.env.NEXT_PUBLIC_CRON_SECRET}` } })
// Because `NEXT_PUBLIC_*` variables are inlined into the client bundle, that
// shipped the cron secret — which also protects /api/cron, /api/cron/settle,
// /api/cron/daily-picks and /api/va/scan — to every visitor.
//
// This action runs the same code path in-process on the server, so no secret
// ever reaches the browser and none is needed here at all.

import { keepDbAlive } from "@/db";
import {
  runSureCornersVerify,
  SureCornersVerifyError,
  type VerifySummary,
} from "@/app/api/sure-corners/verify/core";

export interface SureCornersVerifyResult {
  ok: boolean;
  summary?: VerifySummary;
  error?: string;
}

/**
 * Settles every pending Sure Bet Corners pick against real match data.
 * Mirrors what POST /api/sure-corners/verify returns, minus the HTTP hop.
 */
export async function runSureCornersVerifyAction(): Promise<SureCornersVerifyResult> {
  // Picks are resolved with multi-source result + stats lookups that can run
  // for a couple of minutes; keep the pooled connection warm so the final
  // writes don't land on a connection Neon already closed.
  const ping = setInterval(() => {
    void keepDbAlive();
  }, 60_000);

  try {
    const summary = await runSureCornersVerify();
    return { ok: true, summary };
  } catch (error) {
    if (error instanceof SureCornersVerifyError) {
      return { ok: false, error: error.message };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Verification failed",
    };
  } finally {
    clearInterval(ping);
  }
}
