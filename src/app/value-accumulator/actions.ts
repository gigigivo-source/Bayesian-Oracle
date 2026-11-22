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
 * Shape returned by the finished-match ticket backtest (?finished=true on the
 * route). Only the fields the page's result sheet reads are typed here.
 */
export interface TicketBacktestScanResult {
  ok: boolean;
  scanId?: string;
  matchesScanned?: number;
  marketsEvaluated?: number;
  legsQualified?: number;
  ticketsBuilt?: number;
  legsQualifiedBacktest?: number;
  ticketsBuiltBacktest?: number;
  settled?: {
    won: number;
    lost: number;
    pending: number;
    realisedRate: number;
  };
  ticketBacktest?: unknown;
  reason?: string;
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

/**
 * Finished-match ticket backtest — the in-process equivalent of
 * `POST /api/va/scan?mode=stack&finished=true`.
 *
 * The route used to skip authentication for `?finished=true`, and the page
 * relied on that to trigger the backtest from the browser. With the endpoint
 * now gated (a production deploy always requires the bearer secret), the page
 * calls this server action instead: same work, no secret in the browser bundle.
 */
export async function runTicketBacktest(): Promise<TicketBacktestScanResult> {
  const ping = setInterval(() => {
    void keepDbAlive();
  }, 60_000);
  try {
    const result = await performScan("stack", true);
    const body = result.body;
    if (!body.ok) {
      const reason = typeof body.reason === "string" ? body.reason : "backtest failed";
      const detail = typeof body.error === "string" ? `: ${body.error}` : "";
      return { ok: false, reason, error: `${reason}${detail}` };
    }
    return {
      ok: true,
      scanId: body.scanId as string,
      matchesScanned: body.matchesScanned as number,
      marketsEvaluated: body.marketsEvaluated as number,
      legsQualified: body.legsQualified as number,
      ticketsBuilt: body.ticketsBuilt as number,
      legsQualifiedBacktest: body.legsQualifiedBacktest as number,
      ticketsBuiltBacktest: body.ticketsBuiltBacktest as number,
      settled: body.settled as TicketBacktestScanResult["settled"],
      ticketBacktest: body.ticketBacktest,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    clearInterval(ping);
  }
}
