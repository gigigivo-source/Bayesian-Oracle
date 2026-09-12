"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACTION_AMBER,
  CARD_SURFACE,
  CHIP,
  CHIP_ON_AMBER,
  GLASS_PANEL,
  NAV_PILL,
  NAV_PILL_OFF,
  OUTLINE_NEUTRAL,
} from "../_components/design";

// ─── API types (mirror /api/weekly-accumulator) ───────────────────────────────

type StatFamily = "goals" | "corners" | "cards" | "shots" | "other";
type DataQuality = "Real" | "Mixed" | "Synthetic";

interface TicketLeg {
  eventId: string;
  match: string;
  league: string;
  kickoff: string;
  market: string;
  selection: string;
  odds: number;
  hitRate: number;
  ev: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  dataQuality: DataQuality;
  statFamily: StatFamily;
}

interface Ticket {
  legs: TicketLeg[];
  combinedOdds: number;
  combinedProbability: number;
  combinedEv: number;
  recommendedStakePercent: number;
}

interface WeeklyAccumulatorData {
  week: string;
  candidates: number;
  qualified: number;
  ticket: Ticket | null;
  rejected: Array<{ match: string; reason: string }>;
  generatedAt: string;
  reason?: string;
}

// ─── Presentational helpers ───────────────────────────────────────────────────

const FAMILY_BADGE: Record<StatFamily, string> = {
  goals: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  corners: "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
  cards: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  shots: "border-violet-400/30 bg-violet-400/10 text-violet-200",
  other: "border-slate-400/30 bg-slate-400/10 text-slate-300",
};

function formatKickoff(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function buildCopyText(data: WeeklyAccumulatorData): string {
  const ticket = data.ticket;
  if (!ticket) return "No value ticket this week.";
  const lines: string[] = [
    `Weekly Accumulator — ${data.week}`,
    "",
  ];
  ticket.legs.forEach((leg, i) => {
    lines.push(
      `${i + 1}. ${leg.match} (${leg.league})`,
      `   ${leg.market} — ${leg.selection}`,
      `   Odds ${leg.odds.toFixed(2)} · Hit rate ${pct(leg.hitRate)} · ${leg.statFamily}`,
    );
  });
  lines.push(
    "",
    `Combined odds: ${ticket.combinedOdds.toFixed(2)}`,
    `Combined probability: ${pct(ticket.combinedProbability)}`,
    `Combined EV: ${(ticket.combinedEv * 100).toFixed(1)}%`,
    `Recommended stake: ${ticket.recommendedStakePercent.toFixed(1)}% of bankroll`,
  );
  return lines.join("\n");
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WeeklyAccumulatorPage() {
  const [data, setData] = useState<WeeklyAccumulatorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  const [copied, setCopied] = useState(false);

  // Tracks the latest payload without making `load` depend on `data` state
  // (a data-dependent callback re-arms the mount effect on every fetch).
  const dataRef = useRef<WeeklyAccumulatorData | null>(null);
  const initialFetchDone = useRef(false);

  const load = useCallback(async (forceRefresh = false) => {
    if (forceRefresh || dataRef.current) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const url = forceRefresh ? "/api/weekly-accumulator?refresh=true" : "/api/weekly-accumulator";
      const response = await fetch(url, { cache: "no-store" });
      const payload = (await response.json()) as WeeklyAccumulatorData & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      dataRef.current = payload;
      setData(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load the weekly accumulator.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (initialFetchDone.current) return;
    initialFetchDone.current = true;
    void load(false);
  }, [load]);

  const copyTicket = useCallback(async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(buildCopyText(data));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [data]);

  const ticket = data?.ticket ?? null;
  const rejectedCount = data?.rejected?.length ?? 0;

  return (
    <main className="min-h-screen bg-[#05070d] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        {/* ── Header ── */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div
              className={`${CHIP} ${CHIP_ON_AMBER} mb-3 inline-flex px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider`}
            >
              🎟️ One ticket · Europe&apos;s top competitions
            </div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">
              Weekly Accumulator — 3–4 legs, one ticket per week
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400 sm:text-base">
              The best high hit-rate, positive-EV markets from the Premier
              League, LaLiga, Bundesliga, Serie A, Ligue 1 and UEFA competitions,
              combined into a single ticket with combined odds between 3.0 and
              4.5.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/" className={`${NAV_PILL} ${NAV_PILL_OFF} px-3 py-2 text-xs font-semibold`}>
              ← Oracle
            </Link>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading || refreshing}
              className={`${OUTLINE_NEUTRAL} inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-xs font-semibold transition hover:bg-white/10 disabled:opacity-60`}
              aria-label="Refresh weekly accumulator"
            >
              {refreshing ? (
                <>
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-400 border-t-white" />
                  Refreshing…
                </>
              ) : (
                <>🔄 Refresh</>
              )}
            </button>
          </div>
        </div>

        {loading && (
          <div className={`${GLASS_PANEL} rounded-2xl p-10 text-center`}>
            <div className="animate-pulse font-mono text-sm text-amber-300">
              Scanning this week&apos;s matches and reusing the Top-10 output…
            </div>
          </div>
        )}

        {error && !loading && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300 font-mono">
            {error}
          </div>
        )}

        {/* ── No ticket ── */}
        {!loading && !error && data && !ticket && (
          <div className={`${GLASS_PANEL} rounded-2xl p-10 text-center`}>
            <div className="mb-3 text-3xl">🎫</div>
            <div className="text-base font-bold text-slate-200">
              No value ticket this week.
            </div>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-400 font-mono">
              {data.candidates} candidate{data.candidates === 1 ? "" : "s"} scanned,{" "}
              {data.qualified} qualified. Need at least 3 legs across different
              stat families.
            </p>
            {data.reason && (
              <p className="mx-auto mt-3 max-w-md text-xs text-slate-500 font-mono">
                {data.reason}
              </p>
            )}
          </div>
        )}

        {/* ── Ticket ── */}
        {!loading && !error && ticket && (
          <div className="space-y-4">
            <div className={`${CARD_SURFACE} overflow-hidden`}>
              {/* Legs */}
              <div className="divide-y divide-slate-700">
                {ticket.legs.map((leg, i) => (
                  <div key={leg.eventId + leg.market} className="flex items-start gap-3 px-4 py-3">
                    <span className="mt-0.5 w-5 shrink-0 font-mono text-sm text-slate-500">{i + 1}.</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-white">{leg.match}</div>
                      <div className="truncate text-xs text-slate-400">
                        {leg.market} — <span className="text-amber-300 font-medium">{leg.selection}</span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-500 font-mono">
                        {leg.league} · {formatKickoff(leg.kickoff)}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="font-mono text-sm font-bold text-amber-300">{leg.odds.toFixed(2)}</span>
                      <span className="font-mono text-xs text-emerald-300">{pct(leg.hitRate)}</span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${FAMILY_BADGE[leg.statFamily]}`}
                      >
                        {leg.statFamily}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Combined summary */}
              <div className="grid grid-cols-2 gap-3 border-t border-slate-700 bg-slate-800/50 p-4 sm:grid-cols-4">
                <SummaryCell label="Combined odds" value={ticket.combinedOdds.toFixed(2)} tone="text-amber-300" />
                <SummaryCell label="Combined probability" value={pct(ticket.combinedProbability)} tone="text-emerald-300" />
                <SummaryCell
                  label="Combined EV"
                  value={`${(ticket.combinedEv * 100).toFixed(1)}%`}
                  tone={ticket.combinedEv >= 0 ? "text-emerald-300" : "text-rose-300"}
                />
                <SummaryCell
                  label="Recommended stake"
                  value={`${ticket.recommendedStakePercent.toFixed(1)}%`}
                  tone="text-cyan-300"
                  sub="of bankroll"
                />
              </div>

              {/* Copy */}
              <div className="flex items-center justify-end gap-3 border-t border-slate-700 px-4 py-3">
                <button
                  type="button"
                  onClick={() => void copyTicket()}
                  className={`${ACTION_AMBER} px-4 py-2 text-xs`}
                >
                  {copied ? "✓ Copied" : "📋 Copy ticket"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Rejected panel (collapsed by default) ── */}
        {!loading && !error && data && rejectedCount > 0 && (
          <div className={`${GLASS_PANEL} rounded-2xl overflow-hidden`}>
            <button
              type="button"
              onClick={() => setShowRejected((s) => !s)}
              className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-slate-300 transition hover:bg-white/[0.04]"
              aria-expanded={showRejected}
            >
              <span>
                Nearly qualified ({rejectedCount})
              </span>
              <span className="font-mono text-slate-500">{showRejected ? "▲" : "▼"}</span>
            </button>
            {showRejected && (
              <div className="max-h-72 divide-y divide-slate-800 overflow-y-auto border-t border-white/[0.06]">
                {data.rejected.map((r, i) => (
                  <div key={i} className="flex items-baseline justify-between gap-4 px-4 py-2 text-xs">
                    <span className="min-w-0 flex-1 truncate text-slate-300">{r.match}</span>
                    <span className="shrink-0 font-mono text-slate-500">{r.reason}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Footer meta ── */}
        {!loading && !error && data && (
          <p className="text-center text-[10px] text-slate-600 font-mono">
            {data.week} · {data.candidates} candidates · {data.qualified} qualified · generated{" "}
            {new Date(data.generatedAt).toLocaleString()}
          </p>
        )}
      </div>
    </main>
  );
}

function SummaryCell({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg bg-slate-900/60 px-3 py-2 text-center">
      <div className={`font-mono text-lg font-extrabold ${tone}`}>{value}</div>
      <div className="text-[10px] text-slate-400">{label}</div>
      {sub && <div className="text-[9px] text-slate-500">{sub}</div>}
    </div>
  );
}
