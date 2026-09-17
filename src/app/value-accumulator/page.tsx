"use client";

import { useCallback, useEffect, useState } from "react";

interface VaTicketLeg {
  match: string;
  market: string;
  selection: string;
  odds: number;
  ev: number;
  kickoff: string;
  statFamily: string;
  homeTeam: string;
  awayTeam: string;
  bookmaker: string;
  eventId: string;
  modelProbability: number;
}

interface VaTicketRow {
  id: number;
  scanId: string;
  weekStart: string;
  legs: VaTicketLeg[];
  combinedOdds: number;
  combinedProbability: number;
  independentProbability: number | string | null;
  combinedEv: number;
  kellyScore: number;
  stakePercent: number;
  isRecommended: boolean;
  isReferenceOnly: boolean;
  status: string;
  settledAt: string | null;
  createdAt: string;
}

interface TicketsResponse {
  ok: boolean;
  tickets: VaTicketRow[];
  scanId: string | null;
  learning?: VaLearningStats;
}

interface BacktestBucket {
  claimed: number;
  n: number;
  hits: number;
  actual: number;
  diff: number;
}

interface BacktestResponse {
  ok: boolean;
  elapsedMs: number;
  matchesFound: number;
  matchesProcessed: number;
  totalPredictions: number;
  buckets: BacktestBucket[];
}

interface VaScanSettled {
  won: number;
  lost: number;
  pending: number;
  realisedRate: number | null;
}

interface TicketBacktestItem {
  weekLabel: string;
  legsCount: number;
  combinedOdds: number;
  claimedProbability: number;
  status: "won" | "lost" | "pending";
}

interface TicketBacktestBucket {
  claimed: number;
  n: number;
  won: number;
  lost: number;
  realised: number;
  diff: number;
}

interface MarketReliabilityItem {
  marketKey: string;
  n: number;
  claimed: number;
  realised: number;
  edge: number;
  corr: number;
  action: "trusted" | "downweighted" | "filtered" | "insufficient";
}

interface VaLearningStats {
  keysLoaded: number;
  lineCorrections: number;
  familyCorrections: number;
  filtered: string[];
  sampleCorrections: Array<{
    marketKey: string;
    n: number;
    correction: number;
    edge: number;
  }>;
}

interface TicketBacktest {
  daysSimulated: number;
  ticketsBuilt: number;
  won: number;
  lost: number;
  pending: number;
  realisedRate: number | null;
  claimedAverage: number | null;
  edge: number | null;
  tickets: TicketBacktestItem[];
  ticketBuckets: TicketBacktestBucket[];
  marketReliability?: MarketReliabilityItem[];
}

interface VaScanResponse {
  ok: boolean;
  scanId?: string;
  matchesScanned?: number;
  marketsEvaluated?: number;
  legsQualified?: number;
  ticketsBuilt?: number;
  legsQualifiedBacktest?: number;
  ticketsBuiltBacktest?: number;
  recommendedTicketId?: number | null;
  settled?: VaScanSettled;
  ticketBacktest?: TicketBacktest;
  reason?: string;
  error?: string;
  learning?: VaLearningStats;
}

type BacktestStatus = "idle" | "running" | "done" | "error";
type TicketBacktestStatus = "idle" | "running" | "done" | "error";
type LiveScanStatus = "idle" | "running" | "done" | "error";

/** Which chip owns the background job that is currently running. */
type BackgroundScanKind = "live" | "backtest";

/** va_scan_lock.mode as reported by GET /api/va/tickets/status. */
type ScanLockMode = "value" | "stack" | "backtest";

interface ScanStatusResponse {
  running: boolean;
  mode: ScanLockMode | null;
  startedAt: string | null;
  completedAt: string | null;
  scanId: string | null;
  error: string | null;
  elapsedSeconds: number | null;
}

/** Both chips poll the status endpoint at this interval while a job runs. */
const STATUS_POLL_MS = 15_000;

/**
 * On mount, a job that finished this recently is reported with a toast — the
 * "you closed the tab, here is what happened while you were away" case. Older
 * completions are history, not news.
 */
const RESUME_TOAST_WINDOW_MS = 60_000;

/** Ticket-count phrasing shared by the completion toasts. */
function ticketsPhrase(count: number): string {
  return `${count} ticket${count === 1 ? "" : "s"}`;
}

/** Small inline spinner shared by the chip and the backtest sheet. */
const spinnerStyle = {
  width: 12,
  height: 12,
  borderRadius: "50%",
  border: "2px solid #a7f3d0",
  borderTopColor: "#0a7d4f",
  display: "inline-block",
  animation: "va-spin 0.8s linear infinite",
} as const;

/** One poll of the background-job status endpoint; null when it is unreadable. */
async function fetchScanStatus(): Promise<ScanStatusResponse | null> {
  try {
    const res = await fetch("/api/va/tickets/status", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as ScanStatusResponse;
  } catch {
    return null; // a failed poll costs one cycle — polling carries on
  }
}

/**
 * Value Accumulator tickets view.
 *
 * Both scan chips run in BACKGROUND mode: they POST /api/va/scan?background=true,
 * which claims a va_scan_lock row, fires the scan without awaiting it and
 * answers `{ ok: true, status: "started" }` in about a second. This page then
 * polls GET /api/va/tickets/status every 15s, so the browser is never blocked
 * for the 4-6 minutes a scan takes and the tab can be closed — on remount the
 * page asks the status endpoint once and either resumes polling a job that is
 * still running or reports one that finished in the last minute.
 *
 * Auth: the live (unfinished) scan is still protected by CRON_SECRET, and the
 * browser sends it as `Authorization: Bearer NEXT_PUBLIC_CRON_SECRET` — the same
 * convention the Sure Bet Corners verification chip uses (see .env.example;
 * leave both unset in local development and the route stays open). The backtest
 * chip needs no secret because ?finished=true is unauthenticated by design.
 */
export default function ValueAccumulatorPage() {
  const [tickets, setTickets] = useState<VaTicketRow[]>([]);
  const [scanId, setScanId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backtestStatus, setBacktestStatus] = useState<BacktestStatus>("idle");
  const [backtestResult, setBacktestResult] = useState<BacktestResponse | null>(null);
  const [backtestError, setBacktestError] = useState<string | null>(null);
  const [backtestOpen, setBacktestOpen] = useState(false);
  const [ticketBacktestStatus, setTicketBacktestStatus] = useState<TicketBacktestStatus>("idle");
  const [ticketBacktestResult, setTicketBacktestResult] = useState<VaScanResponse | null>(null);
  const [ticketBacktestError, setTicketBacktestError] = useState<string | null>(null);
  const [ticketBacktestOpen, setTicketBacktestOpen] = useState(false);
  const [learning, setLearning] = useState<VaLearningStats | null>(null);
  const [liveScanStatus, setLiveScanStatus] = useState<LiveScanStatus>("idle");
  const [liveScanError, setLiveScanError] = useState<string | null>(null);
  const [liveScanErrorOpen, setLiveScanErrorOpen] = useState(false);
  const [liveScanToast, setLiveScanToast] = useState<string | null>(null);
  /**
   * The background job this page is waiting on: which chip started it (or
   * adopted it on remount) and the va_scan_lock mode that identifies it. Non-null
   * == "started/polling"; null == idle. There is no client-side timeout — polling
   * only stops when that mode reports done or error.
   */
  const [bgScan, setBgScan] = useState<{ kind: BackgroundScanKind; mode: ScanLockMode } | null>(null);

  /** Refreshes the ticket list and hands the rows back to the caller. */
  const loadTickets = useCallback(async (specificScanId?: string): Promise<VaTicketRow[]> => {
    setLoading(true);
    setError(null);
    try {
      const url = specificScanId ? `/api/va/tickets?scanId=${encodeURIComponent(specificScanId)}` : "/api/va/tickets";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as TicketsResponse;
      const rows = data.tickets ?? [];
      setTickets(rows);
      setScanId(data.scanId);
      if (data.learning) setLearning(data.learning);
      return rows;
    } catch (e) {
      setError(String(e));
      setTickets([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  /** Puts the chip that owns a background job into its "Running…" state. */
  const markRunning = useCallback((kind: BackgroundScanKind) => {
    if (kind === "live") {
      setLiveScanStatus("running");
      setLiveScanError(null);
    } else {
      setTicketBacktestStatus("running");
      setTicketBacktestError(null);
      setTicketBacktestResult(null);
    }
  }, []);

  /** Clears a chip's "Running…" state without touching the other one. */
  const markIdle = useCallback((kind: BackgroundScanKind) => {
    if (kind === "live") setLiveScanStatus("idle");
    else setTicketBacktestStatus("idle");
  }, []);

  /** Reports a failed job on the chip that owns it (error bottom-sheet). */
  const markFailed = useCallback((kind: BackgroundScanKind, message: string) => {
    if (kind === "live") {
      setLiveScanError(message);
      setLiveScanStatus("error");
      setLiveScanErrorOpen(true);
    } else {
      setTicketBacktestError(message);
      setTicketBacktestStatus("error");
      setTicketBacktestOpen(true);
    }
  }, []);

  /** A job finished: refresh the tickets, toast, and open the sheet for a backtest. */
  const markDone = useCallback(
    async (kind: BackgroundScanKind, status: ScanStatusResponse) => {
      const rows = await loadTickets();
      if (kind === "backtest") {
        // A detached job's response body is not persisted, so the per-day
        // settlement tables are unavailable here — the sheet says so and shows
        // the scan id. The ticket list below is the durable output.
        setTicketBacktestResult({ ok: true, scanId: status.scanId ?? undefined });
        setTicketBacktestStatus("done");
        setTicketBacktestOpen(true);
        setLiveScanToast(`Backtest complete — ${ticketsPhrase(rows.length)} refreshed`);
        return;
      }
      setLiveScanStatus("idle");
      setLiveScanToast(`Scan complete — ${ticketsPhrase(rows.length)} ready`);
    },
    [loadTickets],
  );

  /**
   * Starts a background scan and enters the polling state. Both chips share this
   * path; only the query string and the expected lock mode differ.
   */
  const startBackgroundScan = useCallback(
    async (kind: BackgroundScanKind) => {
      if (bgScan) return; // one job at a time — the server enforces it too (409)
      const expectedMode: ScanLockMode = kind === "live" ? "stack" : "backtest";
      const query =
        kind === "live"
          ? "/api/va/scan?mode=stack&background=true"
          : "/api/va/scan?mode=stack&finished=true&background=true";

      setLiveScanToast(null);
      markRunning(kind);

      try {
        const res = await fetch(query, {
          method: "POST",
          cache: "no-store",
          // Only the live (unfinished) scan is secret-protected; the header is
          // harmless when CRON_SECRET is unset.
          headers: { Authorization: `Bearer ${process.env.NEXT_PUBLIC_CRON_SECRET ?? ""}` },
        });
        // Parsed before the status is judged, so the server's own reason reaches
        // the error sheet instead of a bare "HTTP 500".
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          status?: string;
          error?: string;
          reason?: string;
        } | null;

        if (res.status === 409) {
          // A scan is already running — adopt it instead of erroring, so the
          // page still reports the outcome of the job that is in flight.
          const status = await fetchScanStatus();
          const adoptedMode: ScanLockMode = status?.mode ?? expectedMode;
          const adoptedKind: BackgroundScanKind = adoptedMode === "backtest" ? "backtest" : "live";
          if (adoptedKind !== kind) markIdle(kind); // this chip never started a job
          markRunning(adoptedKind);
          setBgScan({ kind: adoptedKind, mode: adoptedMode });
          return;
        }

        if (res.status === 401) {
          throw new Error(
            "Unauthorized — set NEXT_PUBLIC_CRON_SECRET to the same value as CRON_SECRET " +
              "(see .env.example), or start the scan server-side with the bearer secret.",
          );
        }
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error ?? data?.reason ?? `Scan failed to start (HTTP ${res.status})`);
        }

        // "started": the server answered in ~1s and the scan runs detached.
        setBgScan({ kind, mode: expectedMode });
      } catch (e) {
        setBgScan(null);
        markFailed(kind, e instanceof Error ? e.message : String(e));
      }
    },
    [bgScan, markFailed, markIdle, markRunning],
  );

  function startLiveScan() {
    void startBackgroundScan("live");
  }

  function closeLiveScanError() {
    setLiveScanErrorOpen(false);
    setLiveScanStatus("idle");
  }

  useEffect(() => {
    if (!liveScanToast) return;
    const t = setTimeout(() => setLiveScanToast(null), 4000);
    return () => clearTimeout(t);
  }, [liveScanToast]);

  async function runBacktest() {
    if (backtestStatus === "running") return;
    setBacktestStatus("running");
    setBacktestError(null);
    setBacktestResult(null);
    try {
      const res = await fetch("/api/backtest", { method: "POST", cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as BacktestResponse;
      if (!data.ok) throw new Error("Backtest failed");
      setBacktestResult(data);
      setBacktestStatus("done");
      setBacktestOpen(true);
    } catch (e) {
      setBacktestError(e instanceof Error ? e.message : String(e));
      setBacktestStatus("error");
      setBacktestOpen(true);
    }
  }

  function closeBacktest() {
    setBacktestOpen(false);
    setBacktestStatus("idle");
  }

  function runTicketBacktest() {
    void startBackgroundScan("backtest");
  }

  function closeTicketBacktest() {
    setTicketBacktestOpen(false);
    setTicketBacktestStatus("idle");
  }

  /**
   * POLLING — every 15s while a background job is ours to wait for. Stops on
   * done (refresh + toast, plus the sheet for a backtest) or on error (error
   * sheet). A job that is still running, a status we cannot read, and a mode
   * that is not ours all simply keep the poll going: there is no client timeout.
   */
  useEffect(() => {
    if (!bgScan) return;
    const { kind, mode } = bgScan;
    let cancelled = false;

    const tick = async () => {
      const status = await fetchScanStatus();
      if (cancelled || !status) return;
      if (status.running) return; // still in flight — poll again
      if (status.mode !== mode) return; // a different scan's row — not ours
      setBgScan(null); // stop polling before any awaiting, so it cannot re-fire
      if (status.error) {
        markFailed(kind, status.error);
        return;
      }
      if (!status.completedAt) {
        // Neither done, nor errored, nor running: the row went STALE (its
        // process died — a recycled serverless function, a killed dev server)
        // and nothing will ever flip it to done. Say so instead of reporting a
        // completion that never happened.
        markFailed(
          kind,
          "The scan stopped reporting before it finished (its job record went stale after 15 minutes). " +
            "Whatever it wrote is on this page, but the run is incomplete — start it again if you need the rest.",
        );
        return;
      }
      await markDone(kind, status);
    };

    const id = setInterval(() => {
      void tick();
    }, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [bgScan, markDone, markFailed]);

  /**
   * RESUME — on mount, ask the status endpoint once. A job still running (this
   * tab was reopened, or the scan was started elsewhere) puts the owning chip
   * back into "Running…" and restarts polling; a job that finished within the
   * last 60s is reported with a toast; anything older is just history.
   */
  useEffect(() => {
    let cancelled = false;

    const resume = async () => {
      const status = await fetchScanStatus();
      if (cancelled || !status || !status.mode) return;

      if (status.running) {
        const kind: BackgroundScanKind = status.mode === "backtest" ? "backtest" : "live";
        markRunning(kind);
        setBgScan({ kind, mode: status.mode });
        return;
      }

      if (status.error || !status.completedAt) return;
      const ageMs = Date.now() - new Date(status.completedAt).getTime();
      if (ageMs < 0 || ageMs > RESUME_TOAST_WINDOW_MS) return;

      const rows = await loadTickets();
      if (cancelled) return;
      const what = status.mode === "backtest" ? "Backtest" : "Scan";
      setLiveScanToast(`${what} finished while you were away — ${ticketsPhrase(rows.length)} ready`);
      if (status.mode === "backtest") {
        setTicketBacktestResult({ ok: true, scanId: status.scanId ?? undefined });
        setTicketBacktestStatus("done");
        setTicketBacktestOpen(true);
      }
    };

    void resume();
    return () => {
      cancelled = true;
    };
  }, [loadTickets, markRunning]);

  // Initial ticket load. Kept as its own inline fetch (rather than a call to
  // loadTickets) so the effect body does not set state synchronously — the
  // resume effect above runs alongside it and only re-loads the list when a
  // background job finished in the last minute.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/va/tickets", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<TicketsResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setTickets(data.tickets ?? []);
        setScanId(data.scanId);
        if (data.learning) setLearning(data.learning);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setTickets([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const totalExposure = tickets
    .filter((t) => !t.isReferenceOnly)
    .reduce((sum, t) => sum + t.stakePercent, 0);

  const hasTickets = tickets.length > 0;
  const hasQualifiedLegs = tickets.some((t) => t.legs.length > 0);

  const activeLearning = learning ?? ticketBacktestResult?.learning ?? null;
  const hasLearningActive = Boolean(
    activeLearning &&
      activeLearning.lineCorrections + activeLearning.familyCorrections + activeLearning.filtered.length > 0
  );

  return (
    <div style={{ background: "#f7f8fa", minHeight: "100vh", padding: "0 16px 48px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        * { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }
        @keyframes va-spin { to { transform: rotate(360deg); } }
        @keyframes va-slide-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
      `}</style>

      <div style={{ maxWidth: 720, margin: "0 auto", paddingTop: 32 }}>
        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <h1 style={{ fontSize: 32, fontWeight: 700, color: "#111827", margin: 0, letterSpacing: "-0.02em" }}>
            Value Accumulator
          </h1>
          <p style={{ fontSize: 16, color: "#6b7280", margin: "8px 0 0", fontWeight: 400 }}>
            Ranked tickets this week, best first
          </p>
          <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 500 }}>
              Scans run in the background on the server — start one and close the tab if you like.
            </span>
            <button
              type="button"
              onClick={runBacktest}
              disabled={backtestStatus === "running"}
              style={{
                background: "#ecfdf5",
                color: "#0a7d4f",
                border: "1px solid #a7f3d0",
                borderRadius: 999,
                padding: "4px 12px",
                fontSize: 13,
                fontWeight: 600,
                cursor: backtestStatus === "running" ? "default" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {backtestStatus === "running" ? (
                <>
                  <span style={spinnerStyle} aria-hidden="true" />
                  Running…
                </>
              ) : (
                "Run Backtest"
              )}
            </button>
            <button
              type="button"
              onClick={startLiveScan}
              disabled={bgScan !== null}
              style={{
                background: "#ecfdf5",
                color: "#0a7d4f",
                border: "1px solid #a7f3d0",
                borderRadius: 999,
                padding: "4px 12px",
                fontSize: 13,
                fontWeight: 600,
                cursor: bgScan !== null ? "default" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {liveScanStatus === "running" ? (
                <>
                  <span style={spinnerStyle} aria-hidden="true" />
                  Running…
                </>
              ) : (
                "Run Live Scan"
              )}
            </button>
            <button
              type="button"
              onClick={runTicketBacktest}
              disabled={bgScan !== null}
              style={{
                background: "#ecfdf5",
                color: "#0a7d4f",
                border: "1px solid #a7f3d0",
                borderRadius: 999,
                padding: "4px 12px",
                fontSize: 13,
                fontWeight: 600,
                cursor: bgScan !== null ? "default" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {ticketBacktestStatus === "running" ? (
                <>
                  <span style={spinnerStyle} aria-hidden="true" />
                  Running…
                </>
              ) : (
                "Backtest Tickets"
              )}
            </button>
            {scanId && (
              <span style={{ fontSize: 12, color: "#9ca3af", fontFamily: "monospace" }}>
                Scan: {scanId.slice(0, 20)}…
              </span>
            )}
          </div>
        </div>

        {/* Background scan in-progress banner — shown for either chip while its
            detached job is being polled. */}
        {bgScan !== null && (
          <div
            role="status"
            style={{
              background: "#fffbeb",
              border: "1px solid #fde68a",
              borderRadius: 12,
              padding: "14px 20px",
              marginBottom: 24,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span
              style={{ ...spinnerStyle, border: "2px solid #fde68a", borderTopColor: "#d97706" }}
              aria-hidden="true"
            />
            <div>
              <div style={{ fontSize: 13, color: "#92400e", fontWeight: 500 }}>
                Scan running in the background. You can close this tab. Results will appear here when
                ready.
              </div>
              <div style={{ fontSize: 12, color: "#b45309", marginTop: 4 }}>
                {bgScan.kind === "backtest" ? "Ticket backtest" : "Live scan"} · status polled every
                15s
              </div>
            </div>
          </div>
        )}

        {/* Exposure indicator */}
        {hasTickets && (
          <div
            style={{
              background: "white",
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              padding: "16px 20px",
              marginBottom: 24,
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: "#ecfdf5",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#0a7d4f",
                fontWeight: 700,
                fontSize: 16,
              }}
            >
              %
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>
                Placing the recommended tickets uses {totalExposure.toFixed(2)}% of bankroll.
              </div>
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                {tickets.filter((t) => !t.isReferenceOnly).length} active ticket
                {tickets.filter((t) => !t.isReferenceOnly).length !== 1 ? "s" : ""} within 6% cap
                {tickets.filter((t) => t.isReferenceOnly).length > 0
                  ? `, ${tickets.filter((t) => t.isReferenceOnly).length} reference only`
                  : ""}
              </div>
            </div>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div
            style={{
              background: "white",
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              padding: 32,
              textAlign: "center",
              color: "#6b7280",
            }}
          >
            Loading tickets…
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 12,
              padding: 16,
              color: "#991b1b",
              fontSize: 14,
              marginBottom: 16,
            }}
          >
            {error}
          </div>
        )}

        {/* Empty states */}
        {!loading && !hasTickets && !error && (
          <div
            style={{
              background: "white",
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              padding: 32,
              textAlign: "center",
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, color: "#111827", marginBottom: 8 }}>
              No value legs found this week. Try again tomorrow.
            </div>
            <div style={{ fontSize: 14, color: "#6b7280" }}>
              The scanner looks for legs where model probability beats bookmaker price with EV &gt; 3% and
              hitRate ≥ 55% within 1.30–2.00 odds.
            </div>
          </div>
        )}

        {/* Tickets */}
        {!loading && hasLearningActive && activeLearning && (
          <div style={{ fontSize: 13, color: "#4b5563", marginBottom: 16 }}>
            Learning active: {activeLearning.lineCorrections} line corrections ·{" "}
            {activeLearning.familyCorrections} family corrections ·{" "}
            {activeLearning.filtered.length} filtered
          </div>
        )}
        {!loading && hasTickets && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {tickets.map((ticket, idx) => (
              <div
                key={ticket.id}
                style={{
                  background: "white",
                  border: `1px solid ${ticket.isRecommended ? "#0a7d4f" : "#e5e7eb"}`,
                  borderRadius: 12,
                  padding: 20,
                  boxShadow: ticket.isRecommended
                    ? "0 4px 12px rgba(10,125,79,0.12)"
                    : "0 1px 3px rgba(0,0,0,0.05)",
                  position: "relative",
                }}
              >
                {/* Rank + badges */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                  <div
                    style={{
                      background: ticket.isRecommended ? "#0a7d4f" : "#f3f4f6",
                      color: ticket.isRecommended ? "white" : "#374151",
                      borderRadius: 6,
                      padding: "4px 10px",
                      fontSize: 13,
                      fontWeight: 700,
                    }}
                  >
                    #{idx + 1}
                  </div>
                  {ticket.isRecommended && (
                    <div
                      style={{
                        background: "#ecfdf5",
                        color: "#0a7d4f",
                        border: "1px solid #a7f3d0",
                        borderRadius: 6,
                        padding: "4px 10px",
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: "0.02em",
                      }}
                    >
                      ★ RECOMMENDED
                    </div>
                  )}
                  {ticket.isReferenceOnly && (
                    <div
                      style={{
                        background: "#f9fafb",
                        color: "#6b7280",
                        border: "1px solid #e5e7eb",
                        borderRadius: 6,
                        padding: "4px 10px",
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      Reference only
                    </div>
                  )}
                  <div
                    style={{
                      marginLeft: "auto",
                      fontSize: 12,
                      color: "#6b7280",
                      display: "flex",
                      gap: 12,
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        background:
                          ticket.status === "win"
                            ? "#ecfdf5"
                            : ticket.status === "loss"
                            ? "#fef2f2"
                            : ticket.status === "partial"
                            ? "#fffbeb"
                            : "#f3f4f6",
                        color:
                          ticket.status === "win"
                            ? "#0a7d4f"
                            : ticket.status === "loss"
                            ? "#dc2626"
                            : ticket.status === "partial"
                            ? "#d97706"
                            : "#6b7280",
                        padding: "2px 8px",
                        borderRadius: 4,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        fontSize: 11,
                      }}
                    >
                      {ticket.status}
                    </span>
                    <span>{new Date(ticket.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>

                {/* Legs table */}
                <div style={{ overflowX: "auto", marginBottom: 16 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
                        <th style={{ padding: "8px 6px", color: "#6b7280", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
                          Match
                        </th>
                        <th style={{ padding: "8px 6px", color: "#6b7280", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
                          Market
                        </th>
                        <th style={{ padding: "8px 6px", color: "#6b7280", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
                          Selection
                        </th>
                        <th style={{ padding: "8px 6px", color: "#6b7280", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
                          Odds
                        </th>
                        <th style={{ padding: "8px 6px", color: "#6b7280", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
                          EV
                        </th>
                        <th style={{ padding: "8px 6px", color: "#6b7280", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
                          Kickoff
                        </th>
                        <th style={{ padding: "8px 6px", color: "#6b7280", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
                          Bookmaker
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {ticket.legs.map((leg, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                          <td style={{ padding: "10px 6px", color: "#111827", fontWeight: 500 }}>
                            <div>{leg.match}</div>
                            <div style={{ fontSize: 11, color: "#9ca3af" }}>{leg.statFamily}</div>
                          </td>
                          <td style={{ padding: "10px 6px", color: "#374151" }}>{leg.market}</td>
                          <td style={{ padding: "10px 6px", color: "#111827", fontWeight: 600 }}>{leg.selection}</td>
                          <td style={{ padding: "10px 6px", color: "#111827" }}>{leg.odds.toFixed(2)}</td>
                          <td style={{ padding: "10px 6px", color: leg.ev > 0 ? "#0a7d4f" : "#dc2626", fontWeight: 600 }}>
                            {(leg.ev * 100).toFixed(1)}%
                          </td>
                          <td style={{ padding: "10px 6px", color: "#6b7280", fontSize: 12 }}>
                            {new Date(leg.kickoff).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </td>
                          <td style={{ padding: "10px 6px", color: "#6b7280", fontSize: 12 }}>{leg.bookmaker}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Summary row */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
                    gap: 12,
                    background: "#f9fafb",
                    borderRadius: 8,
                    padding: "12px 16px",
                    fontSize: 13,
                  }}
                >
                  <div>
                    <div style={{ color: "#6b7280", fontSize: 11, textTransform: "uppercase", fontWeight: 600 }}>Combined odds</div>
                    <div style={{ color: "#111827", fontWeight: 700, fontSize: 14 }}>{ticket.combinedOdds.toFixed(2)}</div>
                  </div>
                  <div>
                    <div style={{ color: "#6b7280", fontSize: 11, textTransform: "uppercase", fontWeight: 600 }}>Combined prob (adjusted)</div>
                    <div style={{ color: "#111827", fontWeight: 600 }}>{(ticket.combinedProbability * 100).toFixed(1)}%</div>
                    {ticket.legs.length >= 2 && ticket.independentProbability != null && (() => {
                      const ind = typeof ticket.independentProbability === "number"
                        ? ticket.independentProbability
                        : Number(ticket.independentProbability);
                      return (
                        <div style={{ color: "#9ca3af", fontSize: 10, fontWeight: 400, marginTop: 2 }}>
                          Independent: {(ind * 100).toFixed(1)}% · {ticket.legs.length}-leg discount ×{Math.pow(0.92, ticket.legs.length).toFixed(3)}
                        </div>
                      );
                    })()}
                  </div>
                  <div>
                    <div style={{ color: "#6b7280", fontSize: 11, textTransform: "uppercase", fontWeight: 600 }}>Combined EV</div>
                    <div style={{ color: ticket.combinedEv > 0 ? "#0a7d4f" : "#dc2626", fontWeight: 700 }}>
                      {(ticket.combinedEv * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div>
                    <div style={{ color: "#6b7280", fontSize: 11, textTransform: "uppercase", fontWeight: 600 }}>Stake</div>
                    <div style={{ color: "#111827", fontWeight: 600 }}>{ticket.stakePercent.toFixed(2)}% bankroll</div>
                  </div>
                  <div>
                    <div style={{ color: "#6b7280", fontSize: 11, textTransform: "uppercase", fontWeight: 600 }}>Kelly</div>
                    <div style={{ color: "#374151", fontWeight: 600 }}>{ticket.kellyScore.toFixed(4)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Edge case: 1-2 legs */}
        {!loading && tickets.length === 0 && scanId && (
          <div style={{ marginTop: 16, fontSize: 13, color: "#6b7280", textAlign: "center" }}>
            Only {tickets.length} value legs found. Need at least 3 across different stat families.
          </div>
        )}

        <div style={{ marginTop: 32, textAlign: "center", fontSize: 11, color: "#9ca3af" }}>
          Value Accumulator scans upcoming matches for EV &gt; 3% where model beats bookmaker. Tickets are immutable once
          built. Settlement runs automatically after matches finish.
        </div>
      </div>

      {/* Calibration backtest — bottom-sheet modal */}
      {backtestOpen && (
        <div
          onClick={closeBacktest}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(17, 24, 39, 0.55)",
            zIndex: 1000,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              width: "100%",
              maxWidth: 720,
              maxHeight: "70vh",
              borderRadius: "16px 16px 0 0",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              boxShadow: "0 -4px 24px rgba(0,0,0,0.2)",
              animation: "va-slide-up 0.25s ease-out",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>Calibration Backtest</div>
              <button
                type="button"
                onClick={closeBacktest}
                aria-label="Close"
                style={{
                  background: "#f3f4f6",
                  border: "none",
                  borderRadius: 8,
                  width: 28,
                  height: 28,
                  fontSize: 14,
                  lineHeight: 1,
                  color: "#6b7280",
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ overflowY: "auto", padding: "16px 20px 24px" }}>
              {backtestStatus === "running" && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    color: "#6b7280",
                    fontSize: 14,
                    padding: "24px 0",
                  }}
                >
                  <span style={spinnerStyle} aria-hidden="true" />
                  Scanning recent matches…
                </div>
              )}

              {backtestStatus === "error" && (
                <div style={{ color: "#dc2626", fontSize: 14, padding: "8px 0" }}>{backtestError}</div>
              )}

              {backtestStatus === "done" && backtestResult && (
                <>
                  <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 12 }}>
                    {backtestResult.matchesProcessed} matches · {backtestResult.totalPredictions} predictions ·{" "}
                    {backtestResult.elapsedMs}ms
                  </div>
                  {backtestResult.buckets.length > 0 ? (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
                          {["Claimed", "N", "Hits", "Actual", "Diff"].map((h) => (
                            <th
                              key={h}
                              style={{
                                padding: "8px 6px",
                                color: "#6b7280",
                                fontWeight: 600,
                                fontSize: 11,
                                textTransform: "uppercase",
                              }}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {backtestResult.buckets.map((b) => (
                          <tr key={b.claimed} style={{ borderBottom: "1px solid #f3f4f6" }}>
                            <td style={{ padding: "10px 6px", color: "#111827", fontWeight: 600 }}>
                              {(b.claimed * 100).toFixed(0)}%
                            </td>
                            <td style={{ padding: "10px 6px", color: "#374151" }}>{b.n}</td>
                            <td style={{ padding: "10px 6px", color: "#374151" }}>{b.hits}</td>
                            <td style={{ padding: "10px 6px", color: "#111827", fontWeight: 600 }}>
                              {(b.actual * 100).toFixed(1)}%
                            </td>
                            <td
                              style={{
                                padding: "10px 6px",
                                fontWeight: 600,
                                color: b.diff > -0.05 ? "#0a7d4f" : b.diff >= -0.1 ? "#d97706" : "#dc2626",
                              }}
                            >
                              {b.diff >= 0 ? "+" : ""}
                              {(b.diff * 100).toFixed(1)}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div style={{ fontSize: 13, color: "#6b7280", padding: "8px 0" }}>
                      No bucket reached 5 predictions yet — scan more days first.
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Live scan — completion toast */}
      {liveScanToast && (
        <div
          role="status"
          style={{
            position: "fixed",
            left: "50%",
            bottom: 24,
            transform: "translateX(-50%)",
            background: "#111827",
            color: "white",
            borderRadius: 999,
            padding: "10px 18px",
            fontSize: 13,
            fontWeight: 600,
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            zIndex: 1100,
            animation: "va-slide-up 0.25s ease-out",
            whiteSpace: "nowrap",
          }}
        >
          {liveScanToast}
        </div>
      )}

      {/* Live scan — error bottom-sheet (same visual pattern as Ticket Backtest error path) */}
      {liveScanErrorOpen && (
        <div
          onClick={closeLiveScanError}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(17, 24, 39, 0.55)",
            zIndex: 1000,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              width: "100%",
              maxWidth: 720,
              maxHeight: "70vh",
              borderRadius: "16px 16px 0 0",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              boxShadow: "0 -4px 24px rgba(0,0,0,0.2)",
              animation: "va-slide-up 0.25s ease-out",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>Live Scan</div>
              <button
                type="button"
                onClick={closeLiveScanError}
                aria-label="Close"
                style={{
                  background: "#f3f4f6",
                  border: "none",
                  borderRadius: 8,
                  width: 28,
                  height: 28,
                  fontSize: 14,
                  lineHeight: 1,
                  color: "#6b7280",
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ overflowY: "auto", padding: "16px 20px 24px" }}>
              <div style={{ color: "#dc2626", fontSize: 14, padding: "8px 0" }}>{liveScanError}</div>
            </div>
          </div>
        </div>
      )}

      {/* Ticket backtest — bottom-sheet modal (same visual pattern as Calibration Backtest) */}
      {ticketBacktestOpen && (
        <div
          onClick={closeTicketBacktest}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(17, 24, 39, 0.55)",
            zIndex: 1000,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              width: "100%",
              maxWidth: 720,
              maxHeight: "70vh",
              borderRadius: "16px 16px 0 0",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              boxShadow: "0 -4px 24px rgba(0,0,0,0.2)",
              animation: "va-slide-up 0.25s ease-out",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>Ticket Backtest</div>
                {ticketBacktestStatus === "done" && ticketBacktestResult?.ticketBacktest && (
                  <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                    {ticketBacktestResult.ticketBacktest.daysSimulated} days ·{" "}
                    {ticketBacktestResult.ticketBacktest.ticketsBuilt} tickets ·{" "}
                    {ticketBacktestResult.ticketBacktest.won} won ·{" "}
                    {ticketBacktestResult.ticketBacktest.lost} lost ·{" "}
                    {ticketBacktestResult.ticketBacktest.pending} pending
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={closeTicketBacktest}
                aria-label="Close"
                style={{
                  background: "#f3f4f6",
                  border: "none",
                  borderRadius: 8,
                  width: 28,
                  height: 28,
                  fontSize: 14,
                  lineHeight: 1,
                  color: "#6b7280",
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ overflowY: "auto", padding: "16px 20px 24px" }}>
              {ticketBacktestStatus === "running" && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    color: "#6b7280",
                    fontSize: 14,
                    padding: "24px 0",
                  }}
                >
                  <span style={spinnerStyle} aria-hidden="true" />
                  Settling finished matches…
                </div>
              )}

              {ticketBacktestStatus === "error" && (
                <div style={{ color: "#dc2626", fontSize: 14, padding: "8px 0" }}>{ticketBacktestError}</div>
              )}

              {/* Background job: the scan finished, but a detached job's response
                  body is not persisted, so the per-day settlement tables this
                  sheet normally renders are unavailable. Say so plainly instead
                  of showing an empty sheet. */}
              {ticketBacktestStatus === "done" && !ticketBacktestResult?.ticketBacktest && (
                <div style={{ padding: "8px 0 16px" }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>
                    Backtest finished in the background.
                  </div>
                  <div style={{ fontSize: 13, color: "#6b7280", marginTop: 6, lineHeight: 1.6 }}>
                    {ticketBacktestResult?.scanId ? `Scan ${ticketBacktestResult.scanId}. ` : ""}
                    The per-day won/lost tables are only returned by a foreground run (POST
                    /api/va/scan with finished=true and no background flag), because the detached
                    job has nowhere to persist its response body. The ticket list on this page has
                    been refreshed with the scan output.
                  </div>
                </div>
              )}

              {ticketBacktestStatus === "done" && ticketBacktestResult?.ticketBacktest && (
                <>
                  <div
                    style={{
                      padding: "16px 0 20px",
                      textAlign: "center",
                      borderBottom: "1px solid #f3f4f6",
                      marginBottom: 16,
                    }}
                  >
                    <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", fontWeight: 600 }}>
                      Realised hit rate
                    </div>
                    <div style={{ fontSize: 40, fontWeight: 700, color: "#111827", letterSpacing: "-0.02em", marginTop: 4 }}>
                      {ticketBacktestResult.ticketBacktest.realisedRate == null
                        ? "—"
                        : `${(ticketBacktestResult.ticketBacktest.realisedRate * 100).toFixed(1)}%`}
                    </div>
                    <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                      Claimed avg{" "}
                      {ticketBacktestResult.ticketBacktest.claimedAverage != null
                        ? `${(ticketBacktestResult.ticketBacktest.claimedAverage * 100).toFixed(1)}%`
                        : "—"}{" "}
                      · Edge{" "}
                      {ticketBacktestResult.ticketBacktest.edge != null
                        ? `${ticketBacktestResult.ticketBacktest.edge >= 0 ? "+" : ""}${(
                            ticketBacktestResult.ticketBacktest.edge * 100
                          ).toFixed(1)}%`
                        : "—"}
                    </div>
                  </div>

                  {ticketBacktestResult.ticketBacktest.tickets && ticketBacktestResult.ticketBacktest.tickets.length > 0 ? (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
                            {["Legs", "Combined Odds", "Model Claimed Prob", "Status"].map((h) => (
                              <th
                                key={h}
                                style={{
                                  padding: "8px 6px",
                                  color: "#6b7280",
                                  fontWeight: 600,
                                  fontSize: 11,
                                  textTransform: "uppercase",
                                }}
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {ticketBacktestResult.ticketBacktest.tickets.slice(0, 20).map((t, idx) => {
                            const status =
                              t.status === "won" || t.status === "lost" || t.status === "pending"
                                ? t.status
                                : "pending";
                            const palette =
                              status === "won"
                                ? { bg: "#ecfdf5", fg: "#0a7d4f" }
                                : status === "lost"
                                ? { bg: "#fef2f2", fg: "#dc2626" }
                                : { bg: "#f3f4f6", fg: "#6b7280" };
                            return (
                              <tr key={`${t.weekLabel}-${idx}`} style={{ borderBottom: "1px solid #f3f4f6" }}>
                                <td style={{ padding: "10px 6px", color: "#111827", fontWeight: 600 }}>
                                  {t.legsCount}
                                </td>
                                <td style={{ padding: "10px 6px", color: "#111827", fontWeight: 600 }}>
                                  {t.combinedOdds.toFixed(2)}
                                </td>
                                <td style={{ padding: "10px 6px", color: "#374151" }}>
                                  {(t.claimedProbability * 100).toFixed(1)}%
                                </td>
                                <td style={{ padding: "10px 6px" }}>
                                  <span
                                    style={{
                                      background: palette.bg,
                                      color: palette.fg,
                                      padding: "2px 8px",
                                      borderRadius: 4,
                                      fontWeight: 600,
                                      textTransform: "uppercase",
                                      fontSize: 11,
                                    }}
                                  >
                                    {status}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: "#6b7280", padding: "8px 0" }}>
                      No tickets were built for this scan.
                    </div>
                  )}

                  {ticketBacktestResult.ticketBacktest && (
                    <div style={{ marginTop: 20 }}>
                      <div
                        style={{
                          fontSize: 11,
                          color: "#6b7280",
                          textTransform: "uppercase",
                          fontWeight: 600,
                          letterSpacing: "0.02em",
                          marginBottom: 8,
                        }}
                      >
                        Ticket Calibration
                      </div>
                      {ticketBacktestResult.ticketBacktest.ticketBuckets.length > 0 ? (
                        <div style={{ overflowX: "auto" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                            <thead>
                              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
                                {["Claimed", "N", "Won", "Lost", "Realised", "Diff"].map((h) => (
                                  <th
                                    key={h}
                                    style={{
                                      padding: "8px 6px",
                                      color: "#6b7280",
                                      fontWeight: 600,
                                      fontSize: 11,
                                      textTransform: "uppercase",
                                    }}
                                  >
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {ticketBacktestResult.ticketBacktest.ticketBuckets.map((b) => (
                                <tr key={b.claimed} style={{ borderBottom: "1px solid #f3f4f6" }}>
                                  <td style={{ padding: "10px 6px", color: "#111827", fontWeight: 600 }}>
                                    {(b.claimed * 100).toFixed(0)}%
                                  </td>
                                  <td style={{ padding: "10px 6px", color: "#374151" }}>{b.n}</td>
                                  <td style={{ padding: "10px 6px", color: "#374151" }}>{b.won}</td>
                                  <td style={{ padding: "10px 6px", color: "#374151" }}>{b.lost}</td>
                                  <td style={{ padding: "10px 6px", color: "#111827", fontWeight: 600 }}>
                                    {(b.realised * 100).toFixed(1)}%
                                  </td>
                                  <td
                                    style={{
                                      padding: "10px 6px",
                                      fontWeight: 600,
                                      color:
                                        Math.abs(b.diff) <= 0.05
                                          ? "#0a7d4f"
                                          : Math.abs(b.diff) <= 0.1
                                          ? "#d97706"
                                          : "#dc2626",
                                    }}
                                  >
                                    {b.diff >= 0 ? "+" : ""}
                                    {(b.diff * 100).toFixed(1)}%
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div style={{ fontSize: 13, color: "#6b7280", padding: "8px 0" }}>
                          No bucket reached 3 settled tickets yet — run more scans first.
                        </div>
                      )}
                    </div>
                  )}

                  {ticketBacktestResult.ticketBacktest && (
                    <div style={{ marginTop: 24 }}>
                      <div
                        style={{
                          fontSize: 11,
                          color: "#6b7280",
                          textTransform: "uppercase",
                          fontWeight: 600,
                          letterSpacing: "0.02em",
                          marginBottom: 8,
                        }}
                      >
                        Market Reliability
                      </div>
                      {ticketBacktestResult.ticketBacktest.marketReliability &&
                      ticketBacktestResult.ticketBacktest.marketReliability.length > 0 ? (
                        <div style={{ overflowX: "auto" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                            <thead>
                              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
                                {["Market Key", "N", "Claimed", "Realised", "Edge", "Corr", "Action"].map((h) => (
                                  <th
                                    key={h}
                                    style={{
                                      padding: "8px 6px",
                                      color: "#6b7280",
                                      fontWeight: 600,
                                      fontSize: 11,
                                      textTransform: "uppercase",
                                    }}
                                  >
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {ticketBacktestResult.ticketBacktest.marketReliability
                                .slice()
                                .sort((a, b) => b.n - a.n)
                                .map((item) => {
                                  const corr = item.corr;
                                  let action: "trusted" | "downweighted" | "filtered" | "insufficient";
                                  if (item.n < 20) {
                                    action = "insufficient";
                                  } else if (item.n >= 30 && corr < 0.75) {
                                    action = "filtered";
                                  } else if (corr < 0.9) {
                                    action = "downweighted";
                                  } else {
                                    action = "trusted";
                                  }

                                  const palette =
                                    action === "trusted"
                                      ? { bg: "#ecfdf5", fg: "#0a7d4f" }
                                      : action === "downweighted"
                                      ? { bg: "#fef3c7", fg: "#d97706" }
                                      : action === "filtered"
                                      ? { bg: "#fef2f2", fg: "#dc2626" }
                                      : { bg: "#f3f4f6", fg: "#6b7280" };

                                  return (
                                    <tr key={item.marketKey} style={{ borderBottom: "1px solid #f3f4f6" }}>
                                      <td
                                        style={{
                                          padding: "10px 6px",
                                          color: "#111827",
                                          fontWeight: 600,
                                          fontFamily: "monospace",
                                          fontSize: 12,
                                        }}
                                      >
                                        {item.marketKey}
                                      </td>
                                      <td style={{ padding: "10px 6px", color: "#374151" }}>{item.n}</td>
                                      <td style={{ padding: "10px 6px", color: "#374151" }}>
                                        {(item.claimed * 100).toFixed(1)}%
                                      </td>
                                      <td style={{ padding: "10px 6px", color: "#111827", fontWeight: 600 }}>
                                        {(item.realised * 100).toFixed(1)}%
                                      </td>
                                      <td
                                        style={{
                                          padding: "10px 6px",
                                          fontWeight: 600,
                                          color:
                                            item.edge >= 0
                                              ? "#0a7d4f"
                                              : item.edge >= -0.05
                                              ? "#d97706"
                                              : "#dc2626",
                                        }}
                                      >
                                        {item.edge >= 0 ? "+" : ""}
                                        {(item.edge * 100).toFixed(1)}%
                                      </td>
                                      <td style={{ padding: "10px 6px", color: "#374151", fontFamily: "monospace" }}>
                                        {item.corr.toFixed(3)}
                                      </td>
                                      <td style={{ padding: "10px 6px" }}>
                                        <span
                                          style={{
                                            background: palette.bg,
                                            color: palette.fg,
                                            padding: "2px 8px",
                                            borderRadius: 4,
                                            fontWeight: 600,
                                            textTransform: "lowercase",
                                            fontSize: 11,
                                          }}
                                        >
                                          {action}
                                        </span>
                                      </td>
                                    </tr>
                                  );
                                })}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div style={{ fontSize: 13, color: "#6b7280", padding: "8px 0" }}>
                          No market reliability data available yet.
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
