"use client";

import { useEffect, useState } from "react";
import { runLiveScan } from "./actions";

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
  /** "real" = real bookmaker price, "consensus" = Bzzoiro fair line. Absent on tickets built before this existed. */
  oddsSource?: "real" | "consensus";
}

/** Legs priced at real bookmaker odds (older tickets carry no oddsSource and count as 0). */
function realOddsCountOf(ticket: VaTicketRow): number {
  return ticket.realOddsCount ?? ticket.legs.filter((leg) => leg.oddsSource === "real").length;
}

/**
 * EV of the real-priced legs alone: (Π modelProbability) × (Π real odds) − 1.
 * "—" when no leg in the ticket has a real bookmaker price.
 */
function realOddsEvOf(ticket: VaTicketRow): string {
  const real = ticket.legs.filter((leg) => leg.oddsSource === "real");
  if (real.length === 0) return "—";
  const prob = real.reduce((acc, leg) => acc * leg.modelProbability, 1);
  const odds = real.reduce((acc, leg) => acc * leg.odds, 1);
  return `${((prob * odds - 1) * 100).toFixed(1)}%`;
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
  /** Number of legs priced at real bookmaker odds (absent on tickets built before this existed). */
  realOddsCount?: number;
}

interface TicketsResponse {
  ok: boolean;
  tickets: VaTicketRow[];
  scanId: string | null;
  learning?: VaLearningStats;
}

interface VaBacktestRunRow {
  id: number;
  runId: string;
  status: string | null;
  startedAt: string;
  completedAt: string | null;
  daysSimulated: number;
  matchesProcessed: number;
  ticketsBuilt: number;
  won: number;
  lost: number;
  pending: number;
  realisedRate: number | string | null;
  claimedAverage: number | string | null;
  edge: number | string | null;
  error: string | null;
}

interface VaBacktestTicketLeg {
  match?: string;
  matchLabel?: string;
  market: string;
  selection: string;
  odds?: number;
  bookmakerOdds?: number;
  modelProbability?: number;
  outcome?: string;
}

interface VaBacktestTicketRow {
  id: number;
  runId: string;
  simulatedDay: string;
  weekStart: string | null;
  legs: VaBacktestTicketLeg[];
  combinedOdds: number | string;
  combinedProbability: number | string;
  status: string;
  createdAt: string;
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

/** Small inline spinner shared by the chip and the backtest sheet. */
const spinnerStyle = {
  width: 12,
  height: 12,
  borderRadius: "50%",
  border: "2px solid #334155",
  borderTopColor: "#F59E0B",
  display: "inline-block",
  animation: "va-spin 0.8s linear infinite",
} as const;

/**
 * Value Accumulator tickets view.
 *
 * The live scan is triggered via a Next.js server action (`runLiveScan`), which
 * runs the scan in-process on the server. The CRON_SECRET that protects the
 * /api/va/scan HTTP route is therefore never needed in — and never reaches —
 * the browser. Scans also still run on the Vercel cron schedule or via an
 * authenticated curl call from a trusted machine.
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
  const [btHistoryOpen, setBtHistoryOpen] = useState(false);
  const [btViewAllRuns, setBtViewAllRuns] = useState(false);
  const [btRuns, setBtRuns] = useState<VaBacktestRunRow[]>([]);
  const [btTickets, setBtTickets] = useState<VaBacktestTicketRow[]>([]);

  async function startLiveScan() {
    if (liveScanStatus === "running") return;
    setLiveScanStatus("running");
    setLiveScanError(null);
    setLiveScanToast(null);
    try {
      // Server action — runs in-process on the server, no HTTP hop, no secret.
      const result = await runLiveScan();
      if (!result.ok) throw new Error(result.error || "Live scan failed");
      setLiveScanStatus("done");
      await loadTickets();
      const n = result.ticketsBuilt ?? 0;
      setLiveScanToast(`Scan complete — ${n} ticket${n === 1 ? "" : "s"} built`);
      setLiveScanStatus("idle");
    } catch (e) {
      setLiveScanError(e instanceof Error ? e.message : String(e));
      setLiveScanStatus("error");
      setLiveScanErrorOpen(true);
    }
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

  async function runTicketBacktest() {
    if (ticketBacktestStatus === "running") return;
    setTicketBacktestStatus("running");
    setTicketBacktestError(null);
    setTicketBacktestResult(null);
    try {
      const res = await fetch("/api/va/scan?mode=stack&finished=true", {
        method: "POST",
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as VaScanResponse;
      if (!data.ok) throw new Error(data.reason || data.error || "Ticket backtest failed");
      setTicketBacktestResult(data);
      if (data.learning) setLearning(data.learning);
      setTicketBacktestStatus("done");
      setTicketBacktestOpen(true);
    } catch (e) {
      setTicketBacktestError(e instanceof Error ? e.message : String(e));
      setTicketBacktestStatus("error");
      setTicketBacktestOpen(true);
    }
  }

  function closeTicketBacktest() {
    setTicketBacktestOpen(false);
    setTicketBacktestStatus("idle");
  }


  async function loadTickets(specificScanId?: string) {
    setLoading(true);
    setError(null);
    try {
      const url = specificScanId ? `/api/va/tickets?scanId=${encodeURIComponent(specificScanId)}` : "/api/va/tickets";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as TicketsResponse;
      setTickets(data.tickets ?? []);
      setScanId(data.scanId);
      if (data.learning) setLearning(data.learning);
    } catch (e) {
      setError(String(e));
      setTickets([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetch("/api/va/backtest-tickets", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { ok?: boolean; runs?: VaBacktestRunRow[]; tickets?: VaBacktestTicketRow[] }) => {
        setBtRuns(data.runs ?? []);
        setBtTickets(data.tickets ?? []);
      })
      .catch(() => {
        setBtRuns([]);
        setBtTickets([]);
      });
  }, [ticketBacktestStatus]);

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
    <div style={{ background: "#0F1117", minHeight: "100vh", padding: "0 16px 48px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        * { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }
        @keyframes va-spin { to { transform: rotate(360deg); } }
        @keyframes va-slide-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
      `}</style>

      <div style={{ maxWidth: 720, margin: "0 auto", paddingTop: 32 }}>
        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <h1 style={{ fontSize: 32, fontWeight: 700, color: "#fcd34d", margin: 0, letterSpacing: "-0.02em" }}>
            Value Accumulator
          </h1>
          <p style={{ fontSize: 16, color: "#94a3b8", margin: "8px 0 0", fontWeight: 400 }}>
            Ranked tickets this week, best first
          </p>
          <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: "#94a3b8", fontWeight: 500 }}>
              Scan is run from the server. Refresh to see latest tickets.
            </span>
            <button
              type="button"
              onClick={runBacktest}
              disabled={backtestStatus === "running"}
              style={{
                background: "linear-gradient(to right, #F59E0B, #FF8C00)",
                color: "white",
                border: "1px solid #F59E0B",
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
              disabled={liveScanStatus === "running"}
              style={{
                background: "linear-gradient(to right, #F59E0B, #FF8C00)",
                color: "white",
                border: "1px solid #F59E0B",
                borderRadius: 999,
                padding: "4px 12px",
                fontSize: 13,
                fontWeight: 600,
                cursor: liveScanStatus === "running" ? "default" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {liveScanStatus === "running" ? (
                <>
                  <span style={spinnerStyle} aria-hidden="true" />
                  Scanning…
                </>
              ) : (
                "Run Live Scan"
              )}
            </button>
            <button
              type="button"
              onClick={runTicketBacktest}
              disabled={ticketBacktestStatus === "running"}
              style={{
                background: "linear-gradient(to right, #F59E0B, #FF8C00)",
                color: "white",
                border: "1px solid #F59E0B",
                borderRadius: 999,
                padding: "4px 12px",
                fontSize: 13,
                fontWeight: 600,
                cursor: ticketBacktestStatus === "running" ? "default" : "pointer",
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
              <span style={{ fontSize: 12, color: "#64748b", fontFamily: "monospace" }}>
                Scan: {scanId.slice(0, 20)}…
              </span>
            )}
          </div>
        </div>

        {/* Live scan in-progress banner */}
        {liveScanStatus === "running" && (
          <div
            role="status"
            style={{
              background: "#292524",
              border: "1px solid #fcd34d",
              borderRadius: 12,
              padding: "14px 20px",
              marginBottom: 24,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span
              style={{ ...spinnerStyle, border: "2px solid #334155", borderTopColor: "#F59E0B" }}
              aria-hidden="true"
            />
            <div style={{ fontSize: 13, color: "#fcd34d", fontWeight: 500 }}>
              Scan running — this takes 4-6 minutes. Matches are being analysed. Do not close this tab.
            </div>
          </div>
        )}

        {/* Exposure indicator */}
        {hasTickets && (
          <div
            style={{
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: 12,
              padding: "16px 20px",
              marginBottom: 24,
              boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
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
                background: "#1e293b",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#F59E0B",
                fontWeight: 700,
                fontSize: 16,
              }}
            >
              %
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#f1f5f9" }}>
                Placing the recommended tickets uses {totalExposure.toFixed(2)}% of bankroll.
              </div>
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
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
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: 12,
              padding: 32,
              textAlign: "center",
              color: "#94a3b8",
            }}
          >
            Loading tickets…
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div
            style={{
              background: "#450a0a",
              border: "1px solid #7f1d1d",
              borderRadius: 12,
              padding: 16,
              color: "#fca5a5",
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
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: 12,
              padding: 32,
              textAlign: "center",
              boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, color: "#f1f5f9", marginBottom: 8 }}>
              No value legs found this week. Try again tomorrow.
            </div>
            <div style={{ fontSize: 14, color: "#94a3b8" }}>
              The scanner looks for legs where model probability beats bookmaker price with EV &gt; 3% and
              hitRate ≥ 55% within 1.30–2.00 odds.
            </div>
          </div>
        )}

        {/* Tickets */}
        {!loading && hasLearningActive && activeLearning && (
          <div style={{ fontSize: 13, color: "#cbd5e1", marginBottom: 16 }}>
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
                  background: "#0f172a",
                  border: `1px solid ${ticket.isRecommended ? "#F59E0B" : "#334155"}`,
                  borderRadius: 12,
                  padding: 20,
                  boxShadow: ticket.isRecommended
                    ? "0 4px 12px rgba(245,158,11,0.12)"
                    : "0 1px 3px rgba(0,0,0,0.4)",
                  position: "relative",
                }}
              >
                {/* Rank + badges */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                  <div
                    style={{
                      background: ticket.isRecommended ? "#F59E0B" : "#1e293b",
                      color: ticket.isRecommended ? "white" : "#e2e8f0",
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
                        background: "#1e293b",
                        color: "#F59E0B",
                        border: "1px solid #334155",
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
                        background: "#1e293b",
                        color: "#94a3b8",
                        border: "1px solid #334155",
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
                      color: "#94a3b8",
                      display: "flex",
                      gap: 12,
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        background:
                          ticket.status === "win"
                            ? "#1e293b"
                            : ticket.status === "loss"
                            ? "#450a0a"
                            : ticket.status === "partial"
                            ? "#292524"
                            : "#1e293b",
                        color:
                          ticket.status === "win"
                            ? "#F59E0B"
                            : ticket.status === "loss"
                            ? "#f87171"
                            : ticket.status === "partial"
                            ? "#fbbf24"
                            : "#94a3b8",
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

                {/* Real-odds coverage line */}
                <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>
                  {realOddsCountOf(ticket)} of {ticket.legs.length} legs at real bookmaker odds
                </div>

                {/* Legs table */}
                <div style={{ overflowX: "auto", marginBottom: 16 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ textAlign: "left", borderBottom: "1px solid #334155" }}>
                        <th style={{ padding: "8px 6px", color: "#94a3b8", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
                          Match
                        </th>
                        <th style={{ padding: "8px 6px", color: "#94a3b8", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
                          Market
                        </th>
                        <th style={{ padding: "8px 6px", color: "#94a3b8", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
                          Selection
                        </th>
                        <th style={{ padding: "8px 6px", color: "#94a3b8", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
                          Odds
                        </th>
                        <th style={{ padding: "8px 6px", color: "#94a3b8", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
                          EV
                        </th>
                        <th style={{ padding: "8px 6px", color: "#94a3b8", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
                          Kickoff
                        </th>
                        <th style={{ padding: "8px 6px", color: "#94a3b8", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
                          Bookmaker
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {ticket.legs.map((leg, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid #1e293b" }}>
                          <td style={{ padding: "10px 6px", color: "#f1f5f9", fontWeight: 500 }}>
                            <div>{leg.match}</div>
                            <div style={{ fontSize: 11, color: "#64748b" }}>{leg.statFamily}</div>
                          </td>
                          <td style={{ padding: "10px 6px", color: "#e2e8f0" }}>{leg.market}</td>
                          <td style={{ padding: "10px 6px", color: "#f1f5f9", fontWeight: 600 }}>{leg.selection}</td>
                          <td style={{ padding: "10px 6px", color: "#f1f5f9" }}>
                            {leg.odds.toFixed(2)}
                            {leg.oddsSource === "real" ? (
                              <span
                                style={{
                                  marginLeft: 6,
                                  background: "#1e293b",
                                  color: "#F59E0B",
                                  border: "1px solid #334155",
                                  borderRadius: 4,
                                  padding: "1px 5px",
                                  fontSize: 10,
                                  fontWeight: 700,
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {leg.bookmaker}
                              </span>
                            ) : (
                              <span
                                style={{
                                  marginLeft: 6,
                                  background: "#1e293b",
                                  color: "#94a3b8",
                                  border: "1px solid #334155",
                                  borderRadius: 4,
                                  padding: "1px 5px",
                                  fontSize: 10,
                                  fontWeight: 600,
                                  whiteSpace: "nowrap",
                                }}
                              >
                                fair line
                              </span>
                            )}
                          </td>
                          <td style={{ padding: "10px 6px", color: leg.ev > 0 ? "#F59E0B" : "#f87171", fontWeight: 600 }}>
                            {(leg.ev * 100).toFixed(1)}%
                          </td>
                          <td style={{ padding: "10px 6px", color: "#94a3b8", fontSize: 12 }}>
                            {new Date(leg.kickoff).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </td>
                          <td style={{ padding: "10px 6px", color: "#94a3b8", fontSize: 12 }}>{leg.bookmaker}</td>
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
                    background: "#1e293b",
                    borderRadius: 8,
                    padding: "12px 16px",
                    fontSize: 13,
                  }}
                >
                  <div>
                    <div style={{ color: "#94a3b8", fontSize: 11, textTransform: "uppercase", fontWeight: 600 }}>Combined odds</div>
                    <div style={{ color: "#f1f5f9", fontWeight: 700, fontSize: 14 }}>{ticket.combinedOdds.toFixed(2)}</div>
                  </div>
                  <div>
                    <div style={{ color: "#94a3b8", fontSize: 11, textTransform: "uppercase", fontWeight: 600 }}>Combined prob (adjusted)</div>
                    <div style={{ color: "#f1f5f9", fontWeight: 600 }}>{(ticket.combinedProbability * 100).toFixed(1)}%</div>
                    {ticket.legs.length >= 2 && ticket.independentProbability != null && (() => {
                      const ind = typeof ticket.independentProbability === "number"
                        ? ticket.independentProbability
                        : Number(ticket.independentProbability);
                      return (
                        <div style={{ color: "#64748b", fontSize: 10, fontWeight: 400, marginTop: 2 }}>
                          Independent: {(ind * 100).toFixed(1)}% · {ticket.legs.length}-leg discount ×{Math.pow(0.92, ticket.legs.length).toFixed(3)}
                        </div>
                      );
                    })()}
                  </div>
                  <div>
                    <div style={{ color: "#94a3b8", fontSize: 11, textTransform: "uppercase", fontWeight: 600 }}>Combined EV</div>
                    <div style={{ color: ticket.combinedEv > 0 ? "#F59E0B" : "#f87171", fontWeight: 700 }}>
                      {(ticket.combinedEv * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div>
                    <div style={{ color: "#94a3b8", fontSize: 11, textTransform: "uppercase", fontWeight: 600 }}>Stake</div>
                    <div style={{ color: "#f1f5f9", fontWeight: 600 }}>{ticket.stakePercent.toFixed(2)}% bankroll</div>
                  </div>
                  <div>
                    <div style={{ color: "#94a3b8", fontSize: 11, textTransform: "uppercase", fontWeight: 600 }}>Kelly</div>
                    <div style={{ color: "#e2e8f0", fontWeight: 600 }}>{ticket.kellyScore.toFixed(4)}</div>
                  </div>
                </div>

                {/* Real-odds EV — EV of the real-priced legs alone */}
                <div style={{ marginTop: 8, fontSize: 12, color: "#94a3b8" }}>
                  Real-odds EV: {realOddsEvOf(ticket)}
                </div>
              </div>
            ))}
          </div>
        )}


        {/* Backtest History — persisted runs, separate from the live ticket list */}
        <div style={{ marginTop: 32 }}>
          <button
            type="button"
            onClick={() => setBtHistoryOpen((o) => !o)}
            style={{
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: 12,
              padding: "14px 20px",
              width: "100%",
              textAlign: "left",
              cursor: "pointer",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 15, fontWeight: 700, color: "#f1f5f9" }}>Backtest History</span>
            <span style={{ fontSize: 12, color: "#94a3b8" }}>{btHistoryOpen ? "Hide" : "Show"}</span>
          </button>
          {btHistoryOpen && (
            <div
              style={{
                background: "#0f172a",
                border: "1px solid #334155",
                borderTop: "none",
                borderRadius: "0 0 12px 12px",
                padding: 20,
              }}
            >
              {(() => {
                const totalTickets = btRuns.reduce((s, r) => s + (r.ticketsBuilt ?? 0), 0);
                const wonN = btRuns.reduce((s, r) => s + (r.won ?? 0), 0);
                const lostN = btRuns.reduce((s, r) => s + (r.lost ?? 0), 0);
                const settled = wonN + lostN;
                const rate = settled > 0 ? ((wonN / settled) * 100).toFixed(1) : "—";
                const latest = btRuns[0];
                const latestTickets = latest
                  ? btTickets.filter((t) => t.runId === latest.runId)
                  : [];
                const showTickets =
                  latestTickets.length >= 20 ? latestTickets : btTickets;
                const sorted = [...showTickets].sort((a, b) =>
                  (b.simulatedDay ?? "").localeCompare(a.simulatedDay ?? ""),
                );
                const outcomeBadge = (outcome?: string) => {
                  const o = (outcome ?? "unknown").toLowerCase();
                  const palette =
                    o === "won"
                      ? { bg: "#1e293b", fg: "#F59E0B", label: "WON" }
                      : o === "lost"
                      ? { bg: "#450a0a", fg: "#f87171", label: "LOST" }
                      : { bg: "#1e293b", fg: "#94a3b8", label: "UNKNOWN" };
                  return (
                    <span
                      style={{
                        background: palette.bg,
                        color: palette.fg,
                        padding: "2px 8px",
                        borderRadius: 4,
                        fontWeight: 600,
                        fontSize: 11,
                      }}
                    >
                      {palette.label}
                    </span>
                  );
                };
                return (
                  <>
                    <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 16 }}>
                      {btRuns.length} runs · {totalTickets} tickets · {wonN}W / {lostN}L ({rate}%)
                    </div>
                    <button
                      type="button"
                      onClick={() => setBtViewAllRuns((v) => !v)}
                      style={{
                        background: "#1e293b",
                        border: "1px solid #334155",
                        borderRadius: 8,
                        padding: "6px 12px",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#e2e8f0",
                        cursor: "pointer",
                        marginBottom: 16,
                      }}
                    >
                      {btViewAllRuns ? "Hide runs" : "View all runs"}
                    </button>
                    {btViewAllRuns && (
                      <div style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                        {btRuns.map((r) => (
                          <div
                            key={r.runId}
                            style={{
                              fontSize: 12,
                              color: "#e2e8f0",
                              fontFamily: "monospace",
                              padding: "8px 10px",
                              background: "#1e293b",
                              borderRadius: 8,
                            }}
                          >
                            {r.runId} · {r.status} · {r.ticketsBuilt} tickets · {r.won}W/{r.lost}L
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                      {sorted.map((ticket) => {
                        const odds = Number(ticket.combinedOdds);
                        const claimed = Number(ticket.combinedProbability);
                        return (
                          <div
                            key={ticket.id}
                            style={{
                              border: "1px solid #334155",
                              borderRadius: 10,
                              padding: 14,
                            }}
                          >
                            <div
                              style={{
                                fontSize: 11,
                                color: "#94a3b8",
                                fontWeight: 700,
                                letterSpacing: "0.04em",
                                marginBottom: 6,
                              }}
                            >
                              SIMULATED DAY: {ticket.simulatedDay}
                            </div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#f1f5f9", marginBottom: 10 }}>
                              ODDS {Number.isFinite(odds) ? odds.toFixed(2) : "—"} · CLAIMED{" "}
                              {Number.isFinite(claimed) ? `${(claimed * 100).toFixed(1)}%` : "—"} · STATUS:{" "}
                              {ticket.status.toUpperCase()}
                            </div>
                            <div style={{ overflowX: "auto" }}>
                              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                <thead>
                                  <tr style={{ textAlign: "left", borderBottom: "1px solid #334155" }}>
                                    {["MATCH", "MARKET", "SELECTION", "ODDS", "PROB", "OUTCOME"].map((h) => (
                                      <th
                                        key={h}
                                        style={{
                                          padding: "6px 4px",
                                          color: "#94a3b8",
                                          fontWeight: 600,
                                          fontSize: 10,
                                        }}
                                      >
                                        {h}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {(ticket.legs ?? []).map((leg, i) => (
                                    <tr key={i} style={{ borderBottom: "1px solid #1e293b" }}>
                                      <td style={{ padding: "8px 4px" }}>{leg.match ?? leg.matchLabel ?? "—"}</td>
                                      <td style={{ padding: "8px 4px" }}>{leg.market}</td>
                                      <td style={{ padding: "8px 4px" }}>{leg.selection}</td>
                                      <td style={{ padding: "8px 4px" }}>
                                        {Number(leg.odds ?? leg.bookmakerOdds ?? 0).toFixed(2)}
                                      </td>
                                      <td style={{ padding: "8px 4px" }}>
                                        {leg.modelProbability != null
                                          ? `${(Number(leg.modelProbability) * 100).toFixed(1)}%`
                                          : "—"}
                                      </td>
                                      <td style={{ padding: "8px 4px" }}>{outcomeBadge(leg.outcome)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
            </div>
          )}
        </div>

        {/* Edge case: 1-2 legs */}
        {!loading && tickets.length === 0 && scanId && (
          <div style={{ marginTop: 16, fontSize: 13, color: "#94a3b8", textAlign: "center" }}>
            Only {tickets.length} value legs found. Need at least 3 across different stat families.
          </div>
        )}

        <div style={{ marginTop: 32, textAlign: "center", fontSize: 11, color: "#64748b" }}>
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
              background: "#0f172a",
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
                borderBottom: "1px solid #334155",
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>Calibration Backtest</div>
              <button
                type="button"
                onClick={closeBacktest}
                aria-label="Close"
                style={{
                  background: "#1e293b",
                  border: "none",
                  borderRadius: 8,
                  width: 28,
                  height: 28,
                  fontSize: 14,
                  lineHeight: 1,
                  color: "#94a3b8",
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
                    color: "#94a3b8",
                    fontSize: 14,
                    padding: "24px 0",
                  }}
                >
                  <span style={spinnerStyle} aria-hidden="true" />
                  Scanning recent matches…
                </div>
              )}

              {backtestStatus === "error" && (
                <div style={{ color: "#f87171", fontSize: 14, padding: "8px 0" }}>{backtestError}</div>
              )}

              {backtestStatus === "done" && backtestResult && (
                <>
                  <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 12 }}>
                    {backtestResult.matchesProcessed} matches · {backtestResult.totalPredictions} predictions ·{" "}
                    {backtestResult.elapsedMs}ms
                  </div>
                  {backtestResult.buckets.length > 0 ? (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ textAlign: "left", borderBottom: "1px solid #334155" }}>
                          {["Claimed", "N", "Hits", "Actual", "Diff"].map((h) => (
                            <th
                              key={h}
                              style={{
                                padding: "8px 6px",
                                color: "#94a3b8",
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
                          <tr key={b.claimed} style={{ borderBottom: "1px solid #1e293b" }}>
                            <td style={{ padding: "10px 6px", color: "#f1f5f9", fontWeight: 600 }}>
                              {(b.claimed * 100).toFixed(0)}%
                            </td>
                            <td style={{ padding: "10px 6px", color: "#e2e8f0" }}>{b.n}</td>
                            <td style={{ padding: "10px 6px", color: "#e2e8f0" }}>{b.hits}</td>
                            <td style={{ padding: "10px 6px", color: "#f1f5f9", fontWeight: 600 }}>
                              {(b.actual * 100).toFixed(1)}%
                            </td>
                            <td
                              style={{
                                padding: "10px 6px",
                                fontWeight: 600,
                                color: b.diff > -0.05 ? "#F59E0B" : b.diff >= -0.1 ? "#fbbf24" : "#f87171",
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
                    <div style={{ fontSize: 13, color: "#94a3b8", padding: "8px 0" }}>
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
            background: "#1e293b",
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
              background: "#0f172a",
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
                borderBottom: "1px solid #334155",
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>Live Scan</div>
              <button
                type="button"
                onClick={closeLiveScanError}
                aria-label="Close"
                style={{
                  background: "#1e293b",
                  border: "none",
                  borderRadius: 8,
                  width: 28,
                  height: 28,
                  fontSize: 14,
                  lineHeight: 1,
                  color: "#94a3b8",
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ overflowY: "auto", padding: "16px 20px 24px" }}>
              <div style={{ color: "#f87171", fontSize: 14, padding: "8px 0" }}>{liveScanError}</div>
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
              background: "#0f172a",
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
                borderBottom: "1px solid #334155",
              }}
            >
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>Ticket Backtest</div>
                {ticketBacktestStatus === "done" && ticketBacktestResult?.ticketBacktest && (
                  <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>
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
                  background: "#1e293b",
                  border: "none",
                  borderRadius: 8,
                  width: 28,
                  height: 28,
                  fontSize: 14,
                  lineHeight: 1,
                  color: "#94a3b8",
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
                    color: "#94a3b8",
                    fontSize: 14,
                    padding: "24px 0",
                  }}
                >
                  <span style={spinnerStyle} aria-hidden="true" />
                  Settling finished matches…
                </div>
              )}

              {ticketBacktestStatus === "error" && (
                <div style={{ color: "#f87171", fontSize: 14, padding: "8px 0" }}>{ticketBacktestError}</div>
              )}

              {ticketBacktestStatus === "done" && ticketBacktestResult?.ticketBacktest && (
                <>
                  <div
                    style={{
                      padding: "16px 0 20px",
                      textAlign: "center",
                      borderBottom: "1px solid #1e293b",
                      marginBottom: 16,
                    }}
                  >
                    <div style={{ fontSize: 11, color: "#94a3b8", textTransform: "uppercase", fontWeight: 600 }}>
                      Realised hit rate
                    </div>
                    <div style={{ fontSize: 40, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.02em", marginTop: 4 }}>
                      {ticketBacktestResult.ticketBacktest.realisedRate == null
                        ? "—"
                        : `${(ticketBacktestResult.ticketBacktest.realisedRate * 100).toFixed(1)}%`}
                    </div>
                    <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>
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
                          <tr style={{ textAlign: "left", borderBottom: "1px solid #334155" }}>
                            {["Legs", "Combined Odds", "Model Claimed Prob", "Status"].map((h) => (
                              <th
                                key={h}
                                style={{
                                  padding: "8px 6px",
                                  color: "#94a3b8",
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
                                ? { bg: "#1e293b", fg: "#F59E0B" }
                                : status === "lost"
                                ? { bg: "#450a0a", fg: "#f87171" }
                                : { bg: "#1e293b", fg: "#94a3b8" };
                            return (
                              <tr key={`${t.weekLabel}-${idx}`} style={{ borderBottom: "1px solid #1e293b" }}>
                                <td style={{ padding: "10px 6px", color: "#f1f5f9", fontWeight: 600 }}>
                                  {t.legsCount}
                                </td>
                                <td style={{ padding: "10px 6px", color: "#f1f5f9", fontWeight: 600 }}>
                                  {t.combinedOdds.toFixed(2)}
                                </td>
                                <td style={{ padding: "10px 6px", color: "#e2e8f0" }}>
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
                    <div style={{ fontSize: 13, color: "#94a3b8", padding: "8px 0" }}>
                      No tickets were built for this scan.
                    </div>
                  )}

                  {ticketBacktestResult.ticketBacktest && (
                    <div style={{ marginTop: 20 }}>
                      <div
                        style={{
                          fontSize: 11,
                          color: "#94a3b8",
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
                              <tr style={{ textAlign: "left", borderBottom: "1px solid #334155" }}>
                                {["Claimed", "N", "Won", "Lost", "Realised", "Diff"].map((h) => (
                                  <th
                                    key={h}
                                    style={{
                                      padding: "8px 6px",
                                      color: "#94a3b8",
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
                                <tr key={b.claimed} style={{ borderBottom: "1px solid #1e293b" }}>
                                  <td style={{ padding: "10px 6px", color: "#f1f5f9", fontWeight: 600 }}>
                                    {(b.claimed * 100).toFixed(0)}%
                                  </td>
                                  <td style={{ padding: "10px 6px", color: "#e2e8f0" }}>{b.n}</td>
                                  <td style={{ padding: "10px 6px", color: "#e2e8f0" }}>{b.won}</td>
                                  <td style={{ padding: "10px 6px", color: "#e2e8f0" }}>{b.lost}</td>
                                  <td style={{ padding: "10px 6px", color: "#f1f5f9", fontWeight: 600 }}>
                                    {(b.realised * 100).toFixed(1)}%
                                  </td>
                                  <td
                                    style={{
                                      padding: "10px 6px",
                                      fontWeight: 600,
                                      color:
                                        Math.abs(b.diff) <= 0.05
                                          ? "#F59E0B"
                                          : Math.abs(b.diff) <= 0.1
                                          ? "#fbbf24"
                                          : "#f87171",
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
                        <div style={{ fontSize: 13, color: "#94a3b8", padding: "8px 0" }}>
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
                          color: "#94a3b8",
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
                              <tr style={{ textAlign: "left", borderBottom: "1px solid #334155" }}>
                                {["Market Key", "N", "Claimed", "Realised", "Edge", "Corr", "Action"].map((h) => (
                                  <th
                                    key={h}
                                    style={{
                                      padding: "8px 6px",
                                      color: "#94a3b8",
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
                                      ? { bg: "#1e293b", fg: "#F59E0B" }
                                      : action === "downweighted"
                                      ? { bg: "#292524", fg: "#fbbf24" }
                                      : action === "filtered"
                                      ? { bg: "#450a0a", fg: "#f87171" }
                                      : { bg: "#1e293b", fg: "#94a3b8" };

                                  return (
                                    <tr key={item.marketKey} style={{ borderBottom: "1px solid #1e293b" }}>
                                      <td
                                        style={{
                                          padding: "10px 6px",
                                          color: "#f1f5f9",
                                          fontWeight: 600,
                                          fontFamily: "monospace",
                                          fontSize: 12,
                                        }}
                                      >
                                        {item.marketKey}
                                      </td>
                                      <td style={{ padding: "10px 6px", color: "#e2e8f0" }}>{item.n}</td>
                                      <td style={{ padding: "10px 6px", color: "#e2e8f0" }}>
                                        {(item.claimed * 100).toFixed(1)}%
                                      </td>
                                      <td style={{ padding: "10px 6px", color: "#f1f5f9", fontWeight: 600 }}>
                                        {(item.realised * 100).toFixed(1)}%
                                      </td>
                                      <td
                                        style={{
                                          padding: "10px 6px",
                                          fontWeight: 600,
                                          color:
                                            item.edge >= 0
                                              ? "#F59E0B"
                                              : item.edge >= -0.05
                                              ? "#fbbf24"
                                              : "#f87171",
                                        }}
                                      >
                                        {item.edge >= 0 ? "+" : ""}
                                        {(item.edge * 100).toFixed(1)}%
                                      </td>
                                      <td style={{ padding: "10px 6px", color: "#e2e8f0", fontFamily: "monospace" }}>
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
                        <div style={{ fontSize: 13, color: "#94a3b8", padding: "8px 0" }}>
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
