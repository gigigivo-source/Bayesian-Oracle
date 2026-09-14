"use client";

import { useEffect, useState } from "react";

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
}

/**
 * Read-only view of Value Accumulator tickets.
 *
 * This page intentionally has NO client-side scan trigger: the scan API route is
 * authenticated with a server-side bearer secret, and that secret must never
 * reach the browser. Any env var exposed to client code is inlined into the
 * public bundle at build time, so every visitor could read it and fire scans at
 * will. Scans therefore run server-side only: on the Vercel cron schedule, or
 * via an authenticated curl call from a trusted machine. This page just reads
 * whatever tickets the last scan produced.
 */
export default function ValueAccumulatorPage() {
  const [tickets, setTickets] = useState<VaTicketRow[]>([]);
  const [scanId, setScanId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    } catch (e) {
      setError(String(e));
      setTickets([]);
    } finally {
      setLoading(false);
    }
  }

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

  return (
    <div style={{ background: "#f7f8fa", minHeight: "100vh", padding: "0 16px 48px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        * { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }
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
              Scan is run from the server. Refresh to see latest tickets.
            </span>
            {scanId && (
              <span style={{ fontSize: 12, color: "#9ca3af", fontFamily: "monospace" }}>
                Scan: {scanId.slice(0, 20)}…
              </span>
            )}
          </div>
        </div>

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
                    <div style={{ color: "#6b7280", fontSize: 11, textTransform: "uppercase", fontWeight: 600 }}>Combined prob</div>
                    <div style={{ color: "#111827", fontWeight: 600 }}>{(ticket.combinedProbability * 100).toFixed(1)}%</div>
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
    </div>
  );
}
