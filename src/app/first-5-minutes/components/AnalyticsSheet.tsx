"use client";

// ĞIGI GIVØ — First 5 Minutes analytics bottom sheet.
//
// Opened by the "📊 Analytics" chip on the First 5 Minutes board. On open it
// fetches /api/first-5-minutes/analytics and presents the settled record:
// realised vs claimed per market, confidence band, league and calibration
// bucket, a last-7-days vs prior-week trend, and the best/worst markets by
// edge. Same visual pattern as the Value Accumulator's Backtest Tickets
// sheet: fixed semi-transparent overlay, white bottom sheet with rounded top
// corners, header row with a ✕ close button, scrollable body. Tapping the
// overlay or the ✕ closes it; the endpoint fails soft, so a database hiccup
// shows an error line inside the sheet, never a broken board.

import { useEffect, useState } from "react";

/** Below this many settled picks a row is muted and marked "(low sample)". */
const MIN_SAMPLE = 20;
/** Edge points: green when calibrated, amber when drifting, red when gone. */
const EDGE_GREEN_POINTS = 5;
const EDGE_AMBER_POINTS = 15;
/** Buckets whose calibration gap exceeds 10 points are highlighted. */
const BUCKET_DIFF_ALERT = 0.1;

const ANALYTICS_URL = "/api/first-5-minutes/analytics";

// ─── API payload types (shape of /api/first-5-minutes/analytics) ──────────────

export type AnalyticsAction = "trusted" | "watch" | "avoid" | "insufficient";

export interface AnalyticsGroupRow {
  n: number;
  won: number;
  lost: number;
  realised: number;
  claimed: number;
  edge: number;
}

export interface AnalyticsTotals {
  settled: number;
  won: number;
  lost: number;
  push: number;
  void: number;
  realisedRate: number;
  claimedAverage: number;
  edge: number;
}

export interface AnalyticsMarketRow extends AnalyticsGroupRow {
  market: string;
  action: AnalyticsAction;
}

export interface AnalyticsSelectionRow extends AnalyticsGroupRow {
  selection: string;
}

export interface AnalyticsConfidenceRow extends AnalyticsGroupRow {
  band: string;
}

export interface AnalyticsLeagueRow extends AnalyticsGroupRow {
  leagueSlug: string;
  leagueName: string;
}

export interface AnalyticsBucketRow {
  bucket: string;
  n: number;
  realised: number;
  claimed: number;
  diff: number;
}

export interface AnalyticsTrustRow {
  marketKey: string;
  n: number;
  edge: number;
  action: AnalyticsAction;
}

export interface First5AnalyticsResponse {
  ok: true;
  generatedAt: string;
  windowDays: number;
  totals: AnalyticsTotals;
  byMarket: AnalyticsMarketRow[];
  bySelection: AnalyticsSelectionRow[];
  byConfidence: AnalyticsConfidenceRow[];
  byLeague: AnalyticsLeagueRow[];
  byBucket: AnalyticsBucketRow[];
  trend: { last7d: AnalyticsGroupRow; previous: AnalyticsGroupRow };
  trust: { best: AnalyticsTrustRow[]; worst: AnalyticsTrustRow[] };
}

// ─── Payload normalisation ────────────────────────────────────────────────────
// The endpoint fails soft with zeros, but the sheet still defends itself: any
// malformed field is coerced to its zero value instead of crashing a render.

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list<T>(value: unknown, map: (entry: Record<string, unknown>) => T): T[] {
  return Array.isArray(value) ? value.map((entry) => map((entry ?? {}) as Record<string, unknown>)) : [];
}

function groupRow(entry: Record<string, unknown>): AnalyticsGroupRow {
  return {
    n: num(entry.n),
    won: num(entry.won),
    lost: num(entry.lost),
    realised: num(entry.realised),
    claimed: num(entry.claimed),
    edge: num(entry.edge),
  };
}

function normaliseAnalytics(payload: unknown): First5AnalyticsResponse {
  const body = (payload ?? {}) as Record<string, unknown>;
  const trend = (body.trend ?? {}) as Record<string, unknown>;
  const trust = (body.trust ?? {}) as Record<string, unknown>;
  const totals = (body.totals ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    generatedAt: text(body.generatedAt),
    windowDays: num(body.windowDays),
    totals: {
      settled: num(totals.settled),
      won: num(totals.won),
      lost: num(totals.lost),
      push: num(totals.push),
      void: num(totals.void),
      realisedRate: num(totals.realisedRate),
      claimedAverage: num(totals.claimedAverage),
      edge: num(totals.edge),
    },
    byMarket: list(body.byMarket, (entry) => ({
      market: text(entry.market) || "Unknown market",
      ...groupRow(entry),
      action: (text(entry.action) || "insufficient") as AnalyticsAction,
    })),
    bySelection: list(body.bySelection, (entry) => ({
      selection: text(entry.selection) || "—",
      ...groupRow(entry),
    })),
    byConfidence: list(body.byConfidence, (entry) => ({
      band: text(entry.band) || "LOW",
      ...groupRow(entry),
    })),
    byLeague: list(body.byLeague, (entry) => ({
      leagueSlug: text(entry.leagueSlug) || "unknown",
      leagueName: text(entry.leagueName) || "Unknown competition",
      ...groupRow(entry),
    })),
    byBucket: list(body.byBucket, (entry) => ({
      bucket: text(entry.bucket) || "—",
      n: num(entry.n),
      realised: num(entry.realised),
      claimed: num(entry.claimed),
      diff: num(entry.diff),
    })),
    trend: { last7d: groupRow((trend.last7d ?? {}) as Record<string, unknown>), previous: groupRow((trend.previous ?? {}) as Record<string, unknown>) },
    trust: {
      best: list(trust.best, (entry) => ({
        marketKey: text(entry.marketKey) || "—",
        n: num(entry.n),
        edge: num(entry.edge),
        action: (text(entry.action) || "insufficient") as AnalyticsAction,
      })),
      worst: list(trust.worst, (entry) => ({
        marketKey: text(entry.marketKey) || "—",
        n: num(entry.n),
        edge: num(entry.edge),
        action: (text(entry.action) || "insufficient") as AnalyticsAction,
      })),
    },
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function pct(value: number): string {
  return `${(num(value) * 100).toFixed(1)}%`;
}

/** Edge as signed percentage points: 0.034 → "+3.4 pts". */
function pts(value: number): string {
  const points = num(value) * 100;
  return `${points >= 0 ? "+" : "−"}${Math.abs(points).toFixed(1)} pts`;
}

function edgeColour(edge: number): string {
  const points = Math.abs(num(edge) * 100);
  if (points < EDGE_GREEN_POINTS) return "#059669";
  if (points <= EDGE_AMBER_POINTS) return "#d97706";
  return "#dc2626";
}

function isLowSample(row: { n: number; action?: AnalyticsAction }): boolean {
  return row.n < MIN_SAMPLE || row.action === "insufficient";
}

const ACTION_BADGES: Record<AnalyticsAction, { background: string; color: string; label: string }> = {
  trusted: { background: "#d1fae5", color: "#065f46", label: "trusted" },
  watch: { background: "#fef3c7", color: "#92400e", label: "watch" },
  avoid: { background: "#fee2e2", color: "#991b1b", label: "avoid" },
  insufficient: { background: "#f3f4f6", color: "#6b7280", label: "insufficient" },
};

const MUTED = "#9ca3af";
const INK = "#111827";
const SUBTLE = "#6b7280";
const BORDER = "#e5e7eb";
const ROW_BORDER = "#f3f4f6";

// ─── Sheet chrome (same pattern as the VA Backtest Tickets sheet) ─────────────

const spinnerStyle = {
  width: 14,
  height: 14,
  borderRadius: "50%",
  border: "2px solid #cbd5e1",
  borderTopColor: "#0e7490",
  display: "inline-block",
  animation: "f5a-spin 0.8s linear infinite",
} as const;

const sheetStyle = {
  background: "white",
  width: "100%",
  maxWidth: 760,
  maxHeight: "85vh",
  borderRadius: "16px 16px 0 0",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  boxShadow: "0 -4px 24px rgba(0,0,0,0.2)",
  animation: "f5a-slide-up 0.25s ease-out",
} as const;

function headerRowStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 20px",
    borderBottom: `1px solid ${BORDER}`,
  };
}

function closeButtonStyle(): React.CSSProperties {
  return {
    background: "#f3f4f6",
    border: "none",
    borderRadius: 8,
    width: 28,
    height: 28,
    fontSize: 14,
    lineHeight: 1,
    color: SUBTLE,
    cursor: "pointer",
  };
}

const tableStyle = { width: "100%", borderCollapse: "collapse", fontSize: 13 } as const;

function thStyle(): React.CSSProperties {
  return {
    textAlign: "left",
    borderBottom: `1px solid ${BORDER}`,
    padding: "6px 8px",
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: SUBTLE,
  };
}

function tdStyle(): React.CSSProperties {
  return { padding: "7px 8px", borderBottom: `1px solid ${ROW_BORDER}`, color: INK };
}

function ActionBadge({ action }: { action: AnalyticsAction }) {
  const badge = ACTION_BADGES[action] ?? ACTION_BADGES.insufficient;
  return (
    <span
      style={{
        background: badge.background,
        color: badge.color,
        borderRadius: 999,
        padding: "2px 8px",
        fontSize: 10,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
      }}
    >
      {badge.label}
    </span>
  );
}

/** The N cell: count plus the "(low sample)" marker for thin rows. */
function SampleCell({ row }: { row: { n: number; action?: AnalyticsAction } }) {
  return (
    <td style={tdStyle()}>
      {row.n}
      {isLowSample(row) ? " (low sample)" : ""}
    </td>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

type TabKey = "markets" | "confidence" | "leagues" | "buckets" | "trend" | "trust";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "markets", label: "Markets" },
  { key: "confidence", label: "Confidence" },
  { key: "leagues", label: "Leagues" },
  { key: "buckets", label: "Buckets" },
  { key: "trend", label: "Trend" },
  { key: "trust", label: "Trust" },
];

const BAND_ORDER = ["HIGH", "MEDIUM", "LOW"];

function tabButtonStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? INK : "#f3f4f6",
    color: active ? "white" : "#374151",
    border: "none",
    borderRadius: 999,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  };
}

function groupTable(headers: string[], rows: React.ReactNode[][]): React.ReactElement {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={tableStyle}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            {headers.map((header) => (
              <th key={header} style={thStyle()}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, index) => (
            <tr key={index}>{cells}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function groupCells(
  row: AnalyticsGroupRow,
  labelCells: React.ReactNode[],
  extraCells: React.ReactNode[] = [],
): React.ReactNode[] {
  return [
    ...labelCells,
    <SampleCell key="n" row={row} />,
    <td key="won" style={tdStyle()}>{row.won}</td>,
    <td key="lost" style={tdStyle()}>{row.lost}</td>,
    <td key="realised" style={tdStyle()}>{pct(row.realised)}</td>,
    <td key="claimed" style={tdStyle()}>{pct(row.claimed)}</td>,
    <td key="edge" style={{ ...tdStyle(), color: edgeColour(row.edge), fontWeight: 600 }}>{pts(row.edge)}</td>,
    ...extraCells,
  ];
}

function byNDesc<T extends { n: number }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => right.n - left.n);
}

function MarketsTab({ rows }: { rows: AnalyticsMarketRow[] }) {
  const sorted = byNDesc(rows);
  if (sorted.length === 0) return <p style={{ color: SUBTLE, fontSize: 13 }}>No settled markets yet.</p>;
  return groupTable(
    ["Market", "N", "W", "L", "Realised", "Claimed", "Edge", "Action"],
    sorted.map((row) => {
      const muted = isLowSample(row);
      const label = (
        <td key="market" style={{ ...tdStyle(), color: muted ? MUTED : INK, fontWeight: 600 }}>
          {row.market}
        </td>
      );
      return groupCells(
        row,
        [label],
        [
          <td key="action" style={tdStyle()}>
            <ActionBadge action={row.action} />
          </td>,
        ],
      );
    }),
  );
}

function ConfidenceTab({ rows }: { rows: AnalyticsConfidenceRow[] }) {
  const sorted = [...rows].sort(
    (left, right) => BAND_ORDER.indexOf(left.band) - BAND_ORDER.indexOf(right.band),
  );
  if (sorted.length === 0) return <p style={{ color: SUBTLE, fontSize: 13 }}>No settled picks yet.</p>;
  return groupTable(
    ["Band", "N", "W", "L", "Realised", "Claimed", "Edge"],
    sorted.map((row) => {
      const muted = isLowSample(row);
      const label = (
        <td key="band" style={{ ...tdStyle(), color: muted ? MUTED : INK, fontWeight: 700 }}>{row.band}</td>
      );
      return groupCells(row, [label]);
    }),
  );
}

function LeaguesTab({ rows }: { rows: AnalyticsLeagueRow[] }) {
  const sorted = byNDesc(rows);
  if (sorted.length === 0) return <p style={{ color: SUBTLE, fontSize: 13 }}>No settled leagues yet.</p>;
  return groupTable(
    ["League", "N", "W", "L", "Realised", "Claimed", "Edge"],
    sorted.map((row) => {
      const muted = isLowSample(row);
      const label = (
        <td key="league" style={{ ...tdStyle(), color: muted ? MUTED : INK, fontWeight: 600 }}>
          {row.leagueName}
        </td>
      );
      return groupCells(row, [label]);
    }),
  );
}

function BucketsTab({ rows }: { rows: AnalyticsBucketRow[] }) {
  const sorted = [...rows].sort((left, right) => left.bucket.localeCompare(right.bucket));
  if (sorted.length === 0) return <p style={{ color: SUBTLE, fontSize: 13 }}>No claimed probabilities in the 0.50–1.00 range yet.</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={tableStyle}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            {["Bucket", "N", "Realised", "Claimed", "Diff"].map((header) => (
              <th key={header} style={thStyle()}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const muted = isLowSample(row);
            // Whole-row amber highlight for buckets that drifted > 10 points.
            const alert = Math.abs(row.diff) > BUCKET_DIFF_ALERT;
            const rowStyle: React.CSSProperties = alert ? { background: "#fef3c7" } : {};
            const cell = (extra: Partial<React.CSSProperties> = {}): React.CSSProperties => ({
              ...tdStyle(),
              color: muted ? MUTED : alert ? "#92400e" : INK,
              ...extra,
            });
            return (
              <tr key={row.bucket} style={rowStyle}>
                <td style={cell({ fontWeight: 600 })}>{row.bucket}</td>
                <td style={cell()}>
                  {row.n}
                  {muted ? " (low sample)" : ""}
                </td>
                <td style={cell()}>{pct(row.realised)}</td>
                <td style={cell()}>{pct(row.claimed)}</td>
                <td style={cell({ fontWeight: alert ? 700 : 400 })}>{pts(row.diff)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TrendTab({ trend }: { trend: First5AnalyticsResponse["trend"] }) {
  const rows: Array<{ label: string; point: AnalyticsGroupRow }> = [
    { label: "Last 7 days", point: trend.last7d },
    { label: "8-14 days ago", point: trend.previous },
  ];
  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              {["Window", "N", "W", "L", "Realised", "Claimed", "Edge"].map((header) => (
                <th key={header} style={thStyle()}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, point }) => {
              const muted = isLowSample(point);
              return (
                <tr key={label}>
                  <td style={{ ...tdStyle(), color: muted ? MUTED : INK, fontWeight: 600 }}>{label}</td>
                  {groupCells(point, [])}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ marginTop: 10, fontSize: 12, color: SUBTLE }}>
        Shows whether recent performance differs from the preceding week.
      </p>
    </div>
  );
}

function TrustList({ title, rows, tone }: { title: string; rows: AnalyticsTrustRow[]; tone: string }) {
  return (
    <div style={{ flex: "1 1 0", minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: tone, marginBottom: 6 }}>
        {title}
      </div>
      {rows.length === 0 ? (
        <p style={{ color: SUBTLE, fontSize: 12 }}>No markets with n ≥ {MIN_SAMPLE} yet.</p>
      ) : (
        rows.map((row) => (
          <div
            key={`${title}-${row.marketKey}`}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "6px 0",
              borderBottom: `1px solid ${ROW_BORDER}`,
              color: isLowSample(row) ? MUTED : INK,
              fontSize: 12,
            }}
          >
            <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {row.marketKey}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ color: SUBTLE }}>
                n={row.n}
                {isLowSample(row) ? " (low sample)" : ""}
              </span>
              <span style={{ color: edgeColour(row.edge), fontWeight: 700 }}>{pts(row.edge)}</span>
              <ActionBadge action={row.action} />
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function TrustTab({ trust }: { trust: First5AnalyticsResponse["trust"] }) {
  return (
    <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
      <TrustList title="BEST" rows={trust.best} tone="#059669" />
      <TrustList title="WORST" rows={trust.worst} tone="#dc2626" />
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

type LoadStatus = "idle" | "loading" | "done" | "error";

export function AnalyticsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [data, setData] = useState<First5AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("markets");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    // State is only touched from the async continuations and the cleanup —
    // never synchronously inside the effect body (react-hooks/set-state-in-effect).
    // `status === "idle"` while open therefore means "fetch in flight".
    fetch(ANALYTICS_URL, { cache: "no-store" })
      .then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setData(normaliseAnalytics(payload));
        setStatus("done");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "Unable to load analytics.");
        setStatus("error");
      });

    return () => {
      cancelled = true;
      // Reset on close/unmount so the next open starts from a clean spinner.
      setStatus("idle");
      setData(null);
      setError(null);
      setTab("markets");
    };
  }, [open]);

  if (!open) return null;

  const totals = data?.totals;
  const empty = (totals?.settled ?? 0) === 0;
  const loading = status === "loading" || status === "idle";

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.55)",
        zIndex: 1000,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      {/* Sheet animation + spinner keyframes (namespaced to avoid collisions). */}
      <style>{`
        @keyframes f5a-spin { to { transform: rotate(360deg); } }
        @keyframes f5a-slide-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
      `}</style>

      <div
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="First 5 Minutes Analytics"
        style={sheetStyle}
      >
        <div style={headerRowStyle()}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: INK }}>First 5 Minutes Analytics</div>
            {status === "done" && data && (
              <div style={{ fontSize: 12, color: SUBTLE, marginTop: 4 }}>
                Last {data.windowDays} days · updated {data.generatedAt ? new Date(data.generatedAt).toISOString().slice(0, 16).replace("T", " ") : "—"}
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={closeButtonStyle()}>
            ✕
          </button>
        </div>

        <div style={{ overflowY: "auto", padding: "16px 20px 24px" }}>
          {loading && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, color: SUBTLE, fontSize: 14, padding: "24px 0" }}>
              <span style={spinnerStyle} aria-hidden="true" />
              Loading analytics…
            </div>
          )}

          {status === "error" && (
            <div style={{ color: "#dc2626", fontSize: 14, padding: "8px 0" }}>
              {error || "Unable to load analytics."}
            </div>
          )}

          {status === "done" && totals && (
            <>
              {/* Summary — always visible, above the tabs. */}
              <div
                data-testid="f5a-summary"
                style={{ padding: "12px 14px", background: "#f9fafb", borderRadius: 10, marginBottom: 14, fontSize: 13, color: INK }}
              >
                <div style={{ fontWeight: 700 }}>
                  {totals.settled} settled · {totals.won}W / {totals.lost}L / {totals.push}P / {totals.void}V
                </div>
                <div style={{ marginTop: 4, color: SUBTLE }}>
                  Realised {pct(totals.realisedRate)} · Claimed {pct(totals.claimedAverage)} ·{" "}
                  <span style={{ color: edgeColour(totals.edge), fontWeight: 700 }}>Edge {pts(totals.edge)}</span>
                </div>
              </div>

              {empty ? (
                <p style={{ color: SUBTLE, fontSize: 13, lineHeight: 1.6, padding: "12px 0" }}>
                  No settled picks yet. Settle runs hourly — check back after the next batch of matches
                  finishes.
                </p>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                    {TABS.map((entry) => (
                      <button
                        key={entry.key}
                        type="button"
                        onClick={() => setTab(entry.key)}
                        aria-pressed={tab === entry.key}
                        style={tabButtonStyle(tab === entry.key)}
                      >
                        {entry.label}
                      </button>
                    ))}
                  </div>

                  <div>
                    {tab === "markets" && <MarketsTab rows={data?.byMarket ?? []} />}
                    {tab === "confidence" && <ConfidenceTab rows={data?.byConfidence ?? []} />}
                    {tab === "leagues" && <LeaguesTab rows={data?.byLeague ?? []} />}
                    {tab === "buckets" && <BucketsTab rows={data?.byBucket ?? []} />}
                    {tab === "trend" && <TrendTab trend={data?.trend ?? { last7d: { n: 0, won: 0, lost: 0, realised: 0, claimed: 0, edge: 0 }, previous: { n: 0, won: 0, lost: 0, realised: 0, claimed: 0, edge: 0 } }} />}
                    {tab === "trust" && <TrustTab trust={data?.trust ?? { best: [], worst: [] }} />}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
