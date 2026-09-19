"use client";

// ĞIGI GIVØ — First 5 Minutes analytics sheet.
//
// Bottom sheet behind the "📊 Analytics" chip of the First 5 Minutes board.
// One read of /api/first-5-minutes/analytics per open, rendered as an always
// visible summary line plus six tabs: Markets, Confidence, Leagues, Buckets,
// Trend and Trust. Same visual pattern as the Value Accumulator's Backtest
// Tickets sheet — a fixed semi-transparent overlay, a bottom-anchored panel
// with rounded top corners, a header row with a close button, and a
// scrollable body; tapping outside or the ✕ closes it.
//
// The payload is normalised defensively (the same discipline as the board's
// settled-results feed), so a malformed response degrades to zeros and empty
// tables instead of breaking the sheet.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

// ─── Payload types (shape of /api/first-5-minutes/analytics) ──────────────────

type AnalyticsAction = "trusted" | "watch" | "avoid" | "insufficient";

interface AnalyticsTotals {
  settled: number;
  won: number;
  lost: number;
  push: number;
  void: number;
  realisedRate: number;
  claimedAverage: number;
  edge: number;
}

interface AnalyticsSplit {
  n: number;
  won: number;
  lost: number;
  realised: number;
  claimed: number;
  edge: number;
}

interface MarketRow extends AnalyticsSplit {
  market: string;
  action: AnalyticsAction;
}

interface SelectionRow extends AnalyticsSplit {
  selection: string;
}

interface ConfidenceRow extends AnalyticsSplit {
  band: string;
}

interface LeagueRow extends AnalyticsSplit {
  leagueSlug: string;
  leagueName: string;
}

interface BucketRow {
  bucket: string;
  n: number;
  realised: number;
  claimed: number;
  diff: number;
}

interface TrustRow {
  marketKey: string;
  n: number;
  edge: number;
  action: AnalyticsAction;
}

interface AnalyticsPayload {
  totals: AnalyticsTotals;
  byMarket: MarketRow[];
  bySelection: SelectionRow[];
  byConfidence: ConfidenceRow[];
  byLeague: LeagueRow[];
  byBucket: BucketRow[];
  trend: { last7d: AnalyticsSplit; previous: AnalyticsSplit };
  trust: { best: TrustRow[]; worst: TrustRow[] };
}

export interface AnalyticsSheetProps {
  open: boolean;
  onClose: () => void;
}

// ─── Defensive payload normalisation ──────────────────────────────────────────

const ACTIONS: readonly AnalyticsAction[] = ["trusted", "watch", "avoid", "insufficient"];

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNum(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asAction(value: unknown): AnalyticsAction {
  const action = asText(value) as AnalyticsAction;
  return ACTIONS.includes(action) ? action : "insufficient";
}

function asList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function asSplit(value: unknown): AnalyticsSplit {
  const row = asRecord(value);
  return {
    n: asNum(row.n),
    won: asNum(row.won),
    lost: asNum(row.lost),
    realised: asNum(row.realised),
    claimed: asNum(row.claimed),
    edge: asNum(row.edge),
  };
}

function asTrustRow(row: Record<string, unknown>): TrustRow {
  return {
    marketKey: asText(row.marketKey),
    n: asNum(row.n),
    edge: asNum(row.edge),
    action: asAction(row.action),
  };
}

function normalisePayload(raw: unknown): AnalyticsPayload {
  const body = asRecord(raw);
  const totals = asRecord(body.totals);
  const trend = asRecord(body.trend);
  const trust = asRecord(body.trust);
  return {
    totals: {
      settled: asNum(totals.settled),
      won: asNum(totals.won),
      lost: asNum(totals.lost),
      push: asNum(totals.push),
      void: asNum(totals.void),
      realisedRate: asNum(totals.realisedRate),
      claimedAverage: asNum(totals.claimedAverage),
      edge: asNum(totals.edge),
    },
    byMarket: asList(body.byMarket).map((row) => ({
      ...asSplit(row),
      market: asText(row.market),
      action: asAction(row.action),
    })),
    bySelection: asList(body.bySelection).map((row) => ({
      ...asSplit(row),
      selection: asText(row.selection),
    })),
    byConfidence: asList(body.byConfidence).map((row) => ({
      ...asSplit(row),
      band: asText(row.band),
    })),
    byLeague: asList(body.byLeague).map((row) => ({
      ...asSplit(row),
      leagueSlug: asText(row.leagueSlug),
      leagueName: asText(row.leagueName),
    })),
    byBucket: asList(body.byBucket).map((row) => ({
      bucket: asText(row.bucket),
      n: asNum(row.n),
      realised: asNum(row.realised),
      claimed: asNum(row.claimed),
      diff: asNum(row.diff),
    })),
    trend: { last7d: asSplit(trend.last7d), previous: asSplit(trend.previous) },
    trust: {
      best: asList(trust.best).map(asTrustRow),
      worst: asList(trust.worst).map(asTrustRow),
    },
  };
}

// ─── Formatting + verdict tones ───────────────────────────────────────────────

/** Rows under this many settled picks (or verdict "insufficient") read as low sample. */
const MIN_SAMPLE = 20;

/** 0.607 → "60.7%". */
function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Signed percentage points: 0.02 → "+2.0", −0.083 → "-8.3". */
function formatEdge(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}`;
}

/** Edge tone in points: green under 5, amber up to 15, red beyond. */
function edgeToneClass(edge: number): string {
  const pts = Math.abs(edge) * 100;
  if (pts < 5) return "text-emerald-300";
  if (pts <= 15) return "text-amber-300";
  return "text-rose-300";
}

function isLowSample(n: number, action?: AnalyticsAction): boolean {
  return n < MIN_SAMPLE || action === "insufficient";
}

const ACTION_STYLES: Record<AnalyticsAction, string> = {
  trusted: "border-emerald-400/40 bg-emerald-500/15 text-emerald-300",
  watch: "border-amber-400/40 bg-amber-500/15 text-amber-300",
  avoid: "border-rose-400/40 bg-rose-500/15 text-rose-300",
  insufficient: "border-slate-500/40 bg-slate-500/15 text-slate-400",
};

function ActionBadge({ action }: { action: AnalyticsAction }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide ${ACTION_STYLES[action]}`}
    >
      {action}
    </span>
  );
}

// ─── Table shell ──────────────────────────────────────────────────────────────

const TD_CLASS = "whitespace-nowrap px-2 py-1.5";

function StatTable({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-white/10">
            {headers.map((header) => (
              <th
                key={header}
                scope="col"
                className="px-2 py-1.5 text-left font-mono text-[10px] uppercase tracking-wider text-slate-500"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function TableEmpty({ note }: { note: string }) {
  return <p className="py-3 text-xs text-slate-500">{note}</p>;
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = ["Markets", "Confidence", "Leagues", "Buckets", "Trend", "Trust"] as const;
type AnalyticsTab = (typeof TABS)[number];

function MarketsTable({ rows }: { rows: MarketRow[] }) {
  const sorted = [...rows].sort((a, b) => b.n - a.n);
  if (sorted.length === 0) return <TableEmpty note="No settled markets in this window yet." />;
  return (
    <StatTable headers={["Market", "N", "W", "L", "Realised", "Claimed", "Edge", "Action"]}>
      {sorted.map((row) => {
        const low = isLowSample(row.n, row.action);
        return (
          <tr
            key={row.market}
            className={`border-t border-white/5 ${low ? "text-slate-500" : "text-slate-200"}`}
          >
            <td className={TD_CLASS}>{row.market || "Unknown market"}</td>
            <td className={TD_CLASS}>
              {row.n}
              {low && " (low sample)"}
            </td>
            <td className={TD_CLASS}>{row.won}</td>
            <td className={TD_CLASS}>{row.lost}</td>
            <td className={TD_CLASS}>{formatPct(row.realised)}</td>
            <td className={TD_CLASS}>{formatPct(row.claimed)}</td>
            <td className={`${TD_CLASS} font-semibold ${edgeToneClass(row.edge)}`}>
              {formatEdge(row.edge)}
            </td>
            <td className={TD_CLASS}>
              <ActionBadge action={row.action} />
            </td>
          </tr>
        );
      })}
    </StatTable>
  );
}

function ConfidenceTable({ rows }: { rows: ConfidenceRow[] }) {
  const sorted = [...rows].sort((a, b) => b.n - a.n);
  if (sorted.length === 0) return <TableEmpty note="No settled picks carry a confidence tier yet." />;
  return (
    <StatTable headers={["Band", "N", "W", "L", "Realised", "Claimed", "Edge"]}>
      {sorted.map((row) => {
        const low = isLowSample(row.n);
        return (
          <tr
            key={row.band}
            className={`border-t border-white/5 ${low ? "text-slate-500" : "text-slate-200"}`}
          >
            <td className={`${TD_CLASS} font-mono`}>{row.band}</td>
            <td className={TD_CLASS}>
              {row.n}
              {low && " (low sample)"}
            </td>
            <td className={TD_CLASS}>{row.won}</td>
            <td className={TD_CLASS}>{row.lost}</td>
            <td className={TD_CLASS}>{formatPct(row.realised)}</td>
            <td className={TD_CLASS}>{formatPct(row.claimed)}</td>
            <td className={`${TD_CLASS} font-semibold ${edgeToneClass(row.edge)}`}>
              {formatEdge(row.edge)}
            </td>
          </tr>
        );
      })}
    </StatTable>
  );
}

function LeaguesTable({ rows }: { rows: LeagueRow[] }) {
  const sorted = [...rows].sort((a, b) => b.n - a.n);
  if (sorted.length === 0) return <TableEmpty note="No settled leagues in this window yet." />;
  return (
    <StatTable headers={["League", "N", "W", "L", "Realised", "Claimed", "Edge"]}>
      {sorted.map((row) => {
        const low = isLowSample(row.n);
        return (
          <tr
            key={row.leagueSlug || row.leagueName}
            className={`border-t border-white/5 ${low ? "text-slate-500" : "text-slate-200"}`}
          >
            <td className={TD_CLASS}>{row.leagueName || row.leagueSlug || "Unknown league"}</td>
            <td className={TD_CLASS}>
              {row.n}
              {low && " (low sample)"}
            </td>
            <td className={TD_CLASS}>{row.won}</td>
            <td className={TD_CLASS}>{row.lost}</td>
            <td className={TD_CLASS}>{formatPct(row.realised)}</td>
            <td className={TD_CLASS}>{formatPct(row.claimed)}</td>
            <td className={`${TD_CLASS} font-semibold ${edgeToneClass(row.edge)}`}>
              {formatEdge(row.edge)}
            </td>
          </tr>
        );
      })}
    </StatTable>
  );
}

function BucketsTable({ rows }: { rows: BucketRow[] }) {
  const sorted = [...rows].sort((a, b) => a.bucket.localeCompare(b.bucket));
  if (sorted.length === 0) {
    return <TableEmpty note="No settled picks claimed a probability inside 0.50–1.00 yet." />;
  }
  return (
    <StatTable headers={["Bucket", "N", "Realised", "Claimed", "Diff"]}>
      {sorted.map((row) => {
        const low = isLowSample(row.n);
        // Calibration drift beyond 10 points is the amber flag: the model's
        // claimed probability and the realised rate disagree materially.
        const hot = Math.abs(row.diff) > 0.1;
        return (
          <tr
            key={row.bucket}
            className={`border-t border-white/5 ${
              hot ? "bg-amber-500/10 text-amber-200" : low ? "text-slate-500" : "text-slate-200"
            }`}
          >
            <td className={`${TD_CLASS} font-mono`}>{row.bucket}</td>
            <td className={TD_CLASS}>
              {row.n}
              {low && " (low sample)"}
            </td>
            <td className={TD_CLASS}>{formatPct(row.realised)}</td>
            <td className={TD_CLASS}>{formatPct(row.claimed)}</td>
            <td className={`${TD_CLASS} font-semibold`}>{formatEdge(row.diff)}</td>
          </tr>
        );
      })}
    </StatTable>
  );
}

function TrendTable({ trend }: { trend: AnalyticsPayload["trend"] }) {
  const windows: Array<{ label: string; stats: AnalyticsSplit }> = [
    { label: "Last 7 days", stats: trend.last7d },
    { label: "8-14 days ago", stats: trend.previous },
  ];
  return (
    <div>
      <StatTable headers={["Window", "N", "W", "L", "Realised", "Claimed", "Edge"]}>
        {windows.map(({ label, stats }) => {
          const low = isLowSample(stats.n);
          return (
            <tr
              key={label}
              className={`border-t border-white/5 ${low ? "text-slate-500" : "text-slate-200"}`}
            >
              <td className={TD_CLASS}>{label}</td>
              <td className={TD_CLASS}>
                {stats.n}
                {low && " (low sample)"}
              </td>
              <td className={TD_CLASS}>{stats.won}</td>
              <td className={TD_CLASS}>{stats.lost}</td>
              <td className={TD_CLASS}>{formatPct(stats.realised)}</td>
              <td className={TD_CLASS}>{formatPct(stats.claimed)}</td>
              <td className={`${TD_CLASS} font-semibold ${edgeToneClass(stats.edge)}`}>
                {formatEdge(stats.edge)}
              </td>
            </tr>
          );
        })}
      </StatTable>
      <p className="mt-3 text-[11px] text-slate-500">
        Shows whether recent performance differs from the preceding week.
      </p>
    </div>
  );
}

function TrustList({
  title,
  subtitle,
  rows,
  accent,
}: {
  title: string;
  subtitle: string;
  rows: TrustRow[];
  accent: string;
}) {
  return (
    <div className={`rounded-xl border p-3 ${accent}`}>
      <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">{title}</div>
      <div className="mb-2 text-[11px] text-slate-500">{subtitle}</div>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500">
          No market has {MIN_SAMPLE}+ settled picks yet.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row) => {
            const low = isLowSample(row.n, row.action);
            return (
              <li
                key={row.marketKey}
                className={`flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-black/25 px-2.5 py-1.5 ${
                  low ? "text-slate-500" : "text-slate-200"
                }`}
              >
                <span className="truncate text-xs">{row.marketKey}</span>
                <span className="flex shrink-0 items-center gap-2 font-mono text-[10px]">
                  <span>
                    {row.n}
                    {low && " (low sample)"}
                  </span>
                  <span className={edgeToneClass(row.edge)}>{formatEdge(row.edge)}</span>
                  <ActionBadge action={row.action} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function TrustBoard({ trust }: { trust: AnalyticsPayload["trust"] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <TrustList
        title="Best"
        subtitle="Top 5 by edge · n ≥ 20"
        rows={trust.best}
        accent="border-emerald-400/25 bg-emerald-500/[0.04]"
      />
      <TrustList
        title="Worst"
        subtitle="Bottom 5 by edge · n ≥ 20"
        rows={trust.worst}
        accent="border-rose-400/25 bg-rose-500/[0.04]"
      />
    </div>
  );
}

// ─── Summary (always visible, above the tabs) ─────────────────────────────────

function AnalyticsSummary({ totals }: { totals: AnalyticsTotals }) {
  return (
    <div
      data-testid="analytics-summary"
      className="rounded-xl border border-cyan-400/20 bg-cyan-500/5 px-4 py-3 text-xs text-slate-300"
    >
      <div>
        <span className="font-semibold text-slate-100">{totals.settled} settled</span>
        {" · "}
        <span className="font-semibold text-emerald-300">{totals.won}W</span>
        {" / "}
        <span className="font-semibold text-rose-300">{totals.lost}L</span>
        {" / "}
        <span className="font-semibold text-amber-300">{totals.push}P</span>
        {" / "}
        <span className="font-semibold text-slate-400">{totals.void}V</span>
      </div>
      <div className="mt-1">
        Realised{" "}
        <span className="font-semibold text-slate-100">{formatPct(totals.realisedRate)}</span>
        {" · "}Claimed{" "}
        <span className="font-semibold text-slate-100">{formatPct(totals.claimedAverage)}</span>
        {" · "}Edge{" "}
        <span className={`font-semibold ${edgeToneClass(totals.edge)}`}>
          {formatEdge(totals.edge)} pts
        </span>
      </div>
    </div>
  );
}

// ─── Sheet ────────────────────────────────────────────────────────────────────

export function AnalyticsSheet({ open, onClose }: AnalyticsSheetProps) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="First 5 Minutes Analytics"
      className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/60"
      onClick={onClose}
    >
      <style>{`
        @keyframes first5-sheet-slide-up {
          from { opacity: 0; transform: translateY(28px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .first5-sheet-panel { animation: none !important; }
        }
      `}</style>

      <div
        onClick={(event) => event.stopPropagation()}
        className="first5-sheet-panel flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-b-0 border-white/10 bg-[#111827] text-slate-200 shadow-[0_-4px_24px_rgba(0,0,0,0.45)]"
        style={{ animation: "first5-sheet-slide-up 0.25s ease-out" }}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <h2 className="text-sm font-bold text-slate-100">First 5 Minutes Analytics</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close analytics"
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/5 text-xs text-slate-400 transition hover:bg-white/10 hover:text-white"
          >
            ✕
          </button>
        </div>

        {/* The content mounts fresh on every open (the shell renders nothing
            while closed), so each open starts on its own loading state and
            re-reads the endpoint. */}
        <AnalyticsContent />
      </div>
    </div>
  );
}

function AnalyticsContent() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [payload, setPayload] = useState<AnalyticsPayload | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [activeTab, setActiveTab] = useState<AnalyticsTab>("Markets");

  // One fresh read per open — the endpoint caches server-side for 5 minutes,
  // so this stays cheap while never showing stale aggregates after a settle
  // run. A slow response that outlives the sheet is dropped via `cancelled`.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/first-5-minutes/analytics", { cache: "no-store" });
        const raw: unknown = await response.json();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (cancelled) return;
        setPayload(normalisePayload(raw));
        setStatus("ready");
      } catch (reason) {
        if (cancelled) return;
        setErrorMessage(reason instanceof Error ? reason.message : "Unable to load analytics.");
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="overflow-y-auto px-5 py-4">
      {status === "loading" && (
        <div role="status" aria-busy="true" className="flex items-center gap-2 py-8 text-xs text-cyan-200">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-300" />
          <span className="font-mono">Crunching settled First 5 Minutes picks…</span>
        </div>
      )}

      {status === "error" && (
        <div
          role="alert"
          className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-300"
        >
          Analytics are unavailable right now: {errorMessage || "the read failed."}
        </div>
      )}

      {status === "ready" && payload && (
        <>
          <AnalyticsSummary totals={payload.totals} />

          {payload.totals.settled === 0 ? (
            <p className="py-6 text-sm text-slate-400">
              No settled picks yet. Settle runs hourly — check back after the next batch of
              matches finishes.
            </p>
          ) : (
            <>
              <div
                role="tablist"
                aria-label="Analytics views"
                className="mt-4 flex gap-1 overflow-x-auto border-b border-white/10 pb-2"
              >
                {TABS.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab}
                    onClick={() => setActiveTab(tab)}
                    className={`whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-semibold transition ${
                      activeTab === tab
                        ? "bg-gradient-to-r from-cyan-400 to-teal-400 text-white shadow-lg shadow-cyan-500/30"
                        : "bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white"
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              <div role="tabpanel" className="pt-3">
                {activeTab === "Markets" && <MarketsTable rows={payload.byMarket} />}
                {activeTab === "Confidence" && <ConfidenceTable rows={payload.byConfidence} />}
                {activeTab === "Leagues" && <LeaguesTable rows={payload.byLeague} />}
                {activeTab === "Buckets" && <BucketsTable rows={payload.byBucket} />}
                {activeTab === "Trend" && <TrendTable trend={payload.trend} />}
                {activeTab === "Trust" && <TrustBoard trust={payload.trust} />}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
