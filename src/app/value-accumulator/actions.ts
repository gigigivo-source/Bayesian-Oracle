"use server";

import { keepDbAlive } from "@/db";
import { performScan } from "@/lib/va/performScan";

export interface ScanResult {
  ok: boolean;
  scanId?: string;
  matchesScanned?: number;
  marketsEvaluated?: number;
  legsQualified?: number;
  ticketsBuilt?: number;
  error?: string;
}

/**
 * Runs the live VA scan (mode=stack, finished=false) in-process from the
 * /value-accumulator page. No HTTP hop, so no CRON_SECRET is needed and the
 * secret never reaches the browser.
 *
 * Scans take 4-6 minutes. Neon closes idle connections well before that, so
 * we ping the DB every 60s for the duration of the scan; otherwise the ticket
 * writes at the end land on a dead connection.
 */
export async function runLiveScan(): Promise<ScanResult> {
  const ping = setInterval(() => {
    void keepDbAlive();
  }, 60_000);
  try {
    const result = await performScan("stack", false);
    const body = result.body;
    if (!body.ok) {
      const reason = typeof body.reason === "string" ? body.reason : "scan failed";
      const detail = typeof body.error === "string" ? `: ${body.error}` : "";
      return {
        ok: false,
        scanId: typeof body.scanId === "string" ? body.scanId : undefined,
        error: `${reason}${detail}`,
      };
    }
    return {
      ok: true,
      scanId: body.scanId as string,
      matchesScanned: body.matchesScanned as number,
      marketsEvaluated: body.marketsEvaluated as number,
      legsQualified: body.legsQualified as number,
      ticketsBuilt: body.ticketsBuilt as number,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    clearInterval(ping);
  }
}
