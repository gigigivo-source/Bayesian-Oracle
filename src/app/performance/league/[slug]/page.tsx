"use client";

// ĞIGI GIVØ — Dedicated league performance page.
// Full transparency for one competition: summary cards, factor accuracy,
// P&L trend (7d / 30d / all time) and every individual bet behind the numbers.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { PerformanceShell } from "@/app/_components/perf/PerformanceShell";
import { PnLTrendChart, type TrendPoint as ChartPoint } from "@/app/_components/perf/charts";
import { ErrorState, LoadingState, Section, cn } from "@/app/_components/perf/ui";
import { OUTLINE_CYAN } from "@/app/_components/design";
import {
  FactorAccuracyTable,
  LeagueBetsTable,
  LeagueSkeletonGrid,
  LeagueSummaryCards,
  money,
  TrendArrow,
  usePnlWindow,
  type LeagueDetail,
  type LeaguesResponse,
} from "@/app/_components/perf/leagues";

export default function LeaguePage() {
  return (
    <Suspense fallback={<PerformanceShell title="League Performance" subtitle="Loading…"><LoadingState label="Loading league detail…" /></PerformanceShell>}>
      <LeaguePageInner />
    </Suspense>
  );
}

function LeaguePageInner() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const slug = decodeURIComponent(params.slug ?? "");
  const days = Number(searchParams.get("days")) || 30;

  const [detail, setDetail] = useState<LeagueDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/performance/leagues?leagueSlug=${encodeURIComponent(slug)}&days=${days}`)
      .then((r) => {
        if (!r.ok) throw new Error(`League API returned ${r.status}`);
        return r.json() as Promise<LeaguesResponse>;
      })
      .then((res) => setDetail(res.league))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load league detail"))
      .finally(() => setLoading(false));
  }, [slug, days]);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    load();
  }, [load]);

  useEffect(() => {
    load();
  }, [load]);

  const { visible: trendPoints, WindowSwitcher } = usePnlWindow(detail?.pnlTrend ?? []);
  const chartPoints: ChartPoint[] = trendPoints.map((p) => ({ label: p.label, value: p.value, delta: p.delta }));

  const title = detail?.competitionName ?? "League Performance";

  return (
    <PerformanceShell
      title={title}
      subtitle={`${detail?.region ? `${detail.region} · ` : ""}${slug} · hit rate, ROI, P&L, 10/10 hits, factor accuracy and every individual bet — all derived directly from settled data.`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/performance/leagues"
          className={cn(OUTLINE_CYAN, "px-3 py-1.5 text-xs")}
        >
          ← All leagues
        </Link>
        <span className="font-mono text-[11px] text-slate-500">window: last {days} days</span>
      </div>

      {loading && !detail ? (
        <>
          <LoadingState label="Loading league detail…" />
          <LeagueSkeletonGrid count={6} />
        </>
      ) : error ? (
        <ErrorState message={error} onRetry={retry} />
      ) : !detail ? (
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-10 text-center">
          <div className="mb-3 text-3xl">🌍</div>
          <div className="mb-2 text-base font-bold text-slate-300">No data for this competition</div>
          <p className="mx-auto max-w-sm font-mono text-xs text-slate-400">
            No verified bets recorded for “{slug}” in the selected window. Try a wider window,
            run the all-league cron, or POST /api/backfill/performance to backfill history.
          </p>
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <LeagueSummaryCards m={detail} />

          {/* W/L/P/V strip from the raw counts */}
          <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
            <div className="mb-2 font-mono text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Win / Loss / Push / Void / Pending
            </div>
            <div className="flex flex-wrap items-stretch gap-2">
              <Strip label="Wins" value={detail.totalWins} cls="border-emerald-500/40 bg-emerald-500/15 text-emerald-300" />
              <Strip label="Losses" value={detail.totalLosses} cls="border-rose-500/40 bg-rose-500/15 text-rose-300" />
              <Strip label="Pushes" value={detail.totalPushes} cls="border-slate-500/40 bg-slate-500/15 text-slate-300" />
              <Strip label="Voids" value={detail.totalVoids} cls="border-slate-600/40 bg-slate-600/15 text-slate-400" />
              <Strip label="Pending" value={detail.totalPending} cls="border-amber-500/40 bg-amber-500/15 text-amber-300" />
            </div>
            <div className="mt-2 font-mono text-[11px] text-slate-500">
              Hit Rate (Wins / Settled Bets):{" "}
              <span className={detail.hitRate >= 60 ? "text-emerald-300" : detail.hitRate >= 45 ? "text-amber-300" : "text-rose-300"}>
                {detail.totalWins + detail.totalLosses > 0 ? `${detail.hitRate.toFixed(1)}%` : "—"}
              </span>{" "}
              · 10/10 hits: <span className="text-amber-300" title="Matches where all Top 10 predictions won.">{detail.total10of10Hits}</span>
            </div>
          </div>

          {/* Factor accuracy + P&L trend */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Section title="Accuracy Breakdown by Factor" subtitle="empirical hit rate per ranking factor — derived from settled picks">
              <FactorAccuracyTable factors={detail.factorAccuracy} />
            </Section>
            <Section
              title="P&L Trend"
              subtitle="cumulative profit/loss from staked products (value bets + slips)"
              right={
                <div className="flex items-center gap-2">
                  <TrendArrow dir={detail.trendDirection} />
                  {WindowSwitcher}
                </div>
              }
            >
              {chartPoints.length > 0 ? (
                <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
                  <PnLTrendChart points={chartPoints} />
                  <div className="mt-2 flex flex-wrap gap-2 font-mono text-[11px] text-slate-400">
                    <span>7d: <span className={detail.last7DaysPnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{money(detail.last7DaysPnl)}</span></span>
                    <span>30d: <span className={detail.last30DaysPnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{money(detail.last30DaysPnl)}</span></span>
                    <span>Total: <span className={detail.totalPnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{money(detail.totalPnl)}</span></span>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-700 bg-slate-900 p-8 text-center font-mono text-xs text-slate-500">
                  No staked P&L yet for this league.
                </div>
              )}
            </Section>
          </div>

          {/* All bets */}
          <Section
            title="All Bets — Full Transparency"
            subtitle={`${detail.bets.length} individual bets (verification picks, value bets, slips) · every aggregate above is computed from these rows`}
          >
            <LeagueBetsTable bets={detail.bets} />
          </Section>

          {/* Source breakdown */}
          <Section title="Source Breakdown" subtitle="where each bet came from">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <SourceCard
                title="Verification Picks"
                data={detail.sourceBreakdown.picks}
                extra={`Top-1 ${detail.top1HitRate !== null ? detail.top1HitRate.toFixed(0) + "%" : "—"} · Top-3 ${detail.top3HitRate !== null ? detail.top3HitRate.toFixed(0) + "%" : "—"} · Top-10 ${detail.top10HitRate !== null ? detail.top10HitRate.toFixed(0) + "%" : "—"}`}
              />
              <SourceCard title="Value Bets" data={detail.sourceBreakdown.valueBets} />
              <SourceCard title="Accumulator Slips" data={detail.sourceBreakdown.slips} />
            </div>
          </Section>
        </>
      )}
    </PerformanceShell>
  );
}

function Strip({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className={cn("flex flex-1 flex-col items-center justify-center rounded-lg border px-3 py-2 min-w-[68px]", cls)}>
      <span className="font-mono text-lg font-extrabold tabular-nums">{value}</span>
      <span className="text-[10px] font-bold uppercase tracking-wide">{label}</span>
    </div>
  );
}

function SourceCard({
  title,
  data,
  extra,
}: {
  title: string;
  data: { total: number; wins: number; losses: number; pending: number };
  extra?: string;
}) {
  const settled = data.wins + data.losses;
  const rate = settled > 0 ? (data.wins / settled) * 100 : 0;
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
      <div className="text-xs font-bold uppercase tracking-wider text-slate-400">{title}</div>
      <div className="mt-2 font-mono text-2xl font-extrabold text-white">{data.total}</div>
      <div className="mt-1 text-[11px] text-slate-400">
        {data.wins}W · {data.losses}L · {data.pending} pending
      </div>
      <div className="mt-2">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-900">
          <div
            className={cn("h-full rounded-full", rate >= 60 ? "bg-emerald-500" : rate >= 45 ? "bg-amber-500" : "bg-rose-500")}
            style={{ width: `${settled > 0 ? rate : 0}%` }}
          />
        </div>
        <div className="mt-1 font-mono text-[11px] text-slate-500">
          hit rate {settled > 0 ? `${rate.toFixed(1)}%` : "—"}
        </div>
      </div>
      {extra ? <div className="mt-2 font-mono text-[10px] text-slate-500">{extra}</div> : null}
    </div>
  );
}
