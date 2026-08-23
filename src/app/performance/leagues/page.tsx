"use client";

// ĞIGI GIVØ — League Performance Dashboard.
// Every league, cup and competition tracked by the oracle is summarised in a
// card grid (search + sort), and clicking any card opens a full league-specific
// breakdown — summary cards, factor accuracy, P&L trend and the raw bet-by-bet
// table behind every number.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PerformanceShell } from "@/app/_components/perf/PerformanceShell";
import { PnLTrendChart, type TrendPoint as ChartPoint } from "@/app/_components/perf/charts";
import { ErrorState, LoadingState, Section, cn } from "@/app/_components/perf/ui";
import { CHIP, CHIP_OFF, CHIP_ON_AMBER, OUTLINE_AMBER } from "@/app/_components/design";
import {
  FactorAccuracyTable,
  LeagueBetsTable,
  LeagueCard,
  LeagueSkeletonGrid,
  LeagueSummaryCards,
  money,
  pctNum,
  TrendArrow,
  usePnlWindow,
  type LeagueDetail,
  type LeagueMetrics,
  type LeaguesResponse,
} from "@/app/_components/perf/leagues";

type SortKey = "totalBets" | "hitRate" | "roi" | "totalPnl";
const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: "totalBets", label: "Total Bets" },
  { key: "hitRate", label: "Hit Rate" },
  { key: "roi", label: "ROI" },
  { key: "totalPnl", label: "P&L" },
];

const DAYS_OPTIONS = [7, 30, 90] as const;

export default function LeaguePerformancePage() {
  return (
    <Suspense fallback={<PerformanceShell title="League Performance" subtitle="Loading…"><LoadingState label="Loading league performance…" /></PerformanceShell>}>
      <LeaguePerformanceInner />
    </Suspense>
  );
}

function LeaguePerformanceInner() {
  const [data, setData] = useState<LeaguesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [days, setDays] = useState<number>(30);
  const [sortBy, setSortBy] = useState<SortKey>("totalBets");
  const searchParams = useSearchParams();
  // Deep-link support (?league=eng.1) — read once during initial render.
  const [selectedSlug, setSelectedSlug] = useState<string | null>(() => searchParams.get("league"));
  const [detail, setDetail] = useState<LeagueDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);

  // Async-only loader (no synchronous setState — safe to call from effects).
  const load = useCallback((d: number, sort: SortKey) => {
    fetch(`/api/performance/leagues?days=${d}&sortBy=${sort}&limit=100`)
      .then((r) => {
        if (!r.ok) throw new Error(`League performance API returned ${r.status}`);
        return r.json() as Promise<LeaguesResponse>;
      })
      .then((res) => {
        setData(res);
        // Keep selection if still present, otherwise pick the top league.
        setSelectedSlug((prev) => {
          if (prev && res.leagues.some((l) => l.leagueSlug === prev)) return prev;
          return res.leagues[0]?.leagueSlug ?? null;
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load league performance"))
      .finally(() => setLoading(false));
  }, []);

  const loadDetail = useCallback((slug: string | null, d: number) => {
    if (!slug) return; // no selection yet — detail section stays hidden
    fetch(`/api/performance/leagues?leagueSlug=${encodeURIComponent(slug)}&days=${d}`)
      .then((r) => {
        if (!r.ok) throw new Error(`League detail API returned ${r.status}`);
        return r.json() as Promise<LeaguesResponse>;
      })
      .then((res) => setDetail(res.league))
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  }, []);

  // Initial load.
  useEffect(() => {
    load(days, sortBy);
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadDetail(selectedSlug, days);
  }, [selectedSlug, days, loadDetail]);

  // User picks a league card — show the loading state immediately (event handler).
  const selectLeague = useCallback((slug: string) => {
    setSelectedSlug(slug);
    setDetail(null);
    setDetailLoading(true);
  }, []);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    load(days, sortBy);
  }, [days, load, sortBy]);

  const filtered = useMemo(() => {
    const list = data?.leagues ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (l) =>
        l.competitionName.toLowerCase().includes(q) ||
        l.leagueSlug.toLowerCase().includes(q) ||
        (l.region ?? "").toLowerCase().includes(q),
    );
  }, [data, search]);

  const totals = useMemo(() => {
    const list = data?.leagues ?? [];
    return list.reduce(
      (acc, l) => ({
        bets: acc.bets + l.totalBets,
        wins: acc.wins + l.totalWins,
        losses: acc.losses + l.totalLosses,
        pnl: acc.pnl + l.totalPnl,
        stake: acc.stake + l.totalStake,
      }),
      { bets: 0, wins: 0, losses: 0, pnl: 0, stake: 0 },
    );
  }, [data]);

  const selected = useMemo(
    () => filtered.find((l) => l.leagueSlug === selectedSlug) ?? null,
    [filtered, selectedSlug],
  );

  return (
    <PerformanceShell
      title="League Performance"
      subtitle="Every league, cup and competition — hit rate, ROI, P&L, 10/10 hits, factor accuracy and the raw bets behind every number. Filter by name, sort, and drill into any competition."
    >
      {loading && !data ? (
        <>
          <LoadingState label="Aggregating league performance from the database…" />
          <LeagueSkeletonGrid count={8} />
        </>
      ) : error && !data ? (
        <ErrorState message={error} onRetry={retry} />
      ) : !data || data.leagues.length === 0 ? (
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-10 text-center">
          <div className="mb-3 text-3xl">🌍</div>
          <div className="mb-2 text-base font-bold text-slate-300">No league data yet</div>
          <p className="mx-auto max-w-sm font-mono text-xs text-slate-400">
            The daily all-league cron (/api/cron/daily-picks) records verified picks per competition.
            Run it once — or POST /api/backfill/performance — and every league with data appears here.
          </p>
        </div>
      ) : (
        <>
          {/* ── Global strip ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <GlobalStat label="Leagues Tracked" value={String(data!.totalLeagues)} sub={`last ${data!.days} days`} />
            <GlobalStat label="Total Bets" value={String(totals.bets)} sub="picks + value bets + slips" />
            <GlobalStat
              label="Overall Hit Rate"
              value={totals.wins + totals.losses > 0 ? pctNum((totals.wins / (totals.wins + totals.losses)) * 100) : "—"}
              sub={`${totals.wins}W · ${totals.losses}L settled`}
            />
            <GlobalStat
              label="Total P&L"
              value={money(totals.pnl)}
              sub={totals.stake > 0 ? `ROI ${((totals.pnl / totals.stake) * 100).toFixed(1)}%` : "no stake data"}
              tone={totals.pnl >= 0 ? "positive" : "negative"}
            />
          </div>

          {/* ── Controls: search / days / sort ───────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">⌕</span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search competitions (e.g. Premier League, Champions, LaLiga)…"
                className="w-full rounded-lg border border-slate-700 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-200 placeholder:text-slate-500 focus:border-amber-400/50 focus:outline-none"
              />
            </div>
            <div className="flex gap-1.5">
              {DAYS_OPTIONS.map((d) => (
                <button
                  key={d}
                  onClick={() => setDays(d)}
                  className={cn(
                    CHIP,
                    "px-2.5 py-1.5 font-mono text-[11px] font-medium",
                    days === d ? CHIP_ON_AMBER : CHIP_OFF,
                  )}
                >
                  {d}d
                </button>
              ))}
            </div>
            <div className="flex gap-1.5">
              {SORT_OPTIONS.map((o) => (
                <button
                  key={o.key}
                  onClick={() => setSortBy(o.key)}
                  className={cn(
                    CHIP,
                    "px-2.5 py-1.5 text-[11px] font-medium",
                    sortBy === o.key ? CHIP_ON_AMBER : CHIP_OFF,
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── League overview grid ─────────────────────────────────────── */}
          <Section
            title="League Overview"
            subtitle={`${filtered.length} of ${data!.totalLeagues} competitions · sorted by ${SORT_OPTIONS.find((o) => o.key === sortBy)?.label ?? sortBy} · last ${days} days`}
          >
            {filtered.length === 0 ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-8 text-center font-mono text-xs text-slate-400">
                No competitions match “{search}”.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filtered.map((m) => (
                  <LeagueCard
                    key={m.leagueSlug}
                    m={m}
                    selected={m.leagueSlug === selectedSlug}
                    onClick={() => selectLeague(m.leagueSlug)}
                  />
                ))}
              </div>
            )}
          </Section>

          {/* ── Selected league detail ───────────────────────────────────── */}
          {selectedSlug ? (
            <LeagueDetailSection
              league={selected}
              detail={detail}
              loading={detailLoading}
              days={days}
            />
          ) : null}
        </>
      )}
    </PerformanceShell>
  );
}

function GlobalStat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "positive" | "negative" | "neutral";
}) {
  const text =
    tone === "positive" ? "text-emerald-300" : tone === "negative" ? "text-rose-300" : "text-white";
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={cn("mt-1.5 font-mono text-2xl font-extrabold tabular-nums", text)}>{value}</div>
      <div className="mt-1 text-[11px] text-slate-400">{sub}</div>
    </div>
  );
}

function LeagueDetailSection({
  league,
  detail,
  loading,
  days,
}: {
  league: LeagueMetrics | null;
  detail: LeagueDetail | null;
  loading: boolean;
  days: number;
}) {
  const { visible: trendPoints, WindowSwitcher } = usePnlWindow(detail?.pnlTrend ?? []);
  const chartPoints: ChartPoint[] = trendPoints.map((p) => ({ label: p.label, value: p.value, delta: p.delta }));

  return (
    <section id="league-detail" className="scroll-mt-28 space-y-6 rounded-2xl border border-amber-400/20 bg-slate-800 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-block rounded-lg bg-slate-900 px-4 py-2">
          <h2 className="text-base font-bold text-white">
            {league?.competitionName ?? detail?.competitionName ?? "League detail"}
          </h2>
          <p className="text-[11px] text-slate-300/80">
            {league?.region ?? ""}
            {league?.region ? " · " : ""}
            window: last {days} days · select a card above to switch league
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {WindowSwitcher}
          {league ? (
            <Link
              href={`/performance/league/${encodeURIComponent(league.leagueSlug)}?days=${days}`}
              className={cn(OUTLINE_AMBER, "px-3 py-1.5 text-xs")}
            >
              Open dedicated page ↗
            </Link>
          ) : null}
        </div>
      </div>

      {loading && !detail ? (
        <LeagueSkeletonGrid count={4} />
      ) : !detail ? (
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-8 text-center font-mono text-xs text-slate-400">
          No data recorded for this competition in the selected window.
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <LeagueSummaryCards m={detail} />

          {/* Factor accuracy + P&L trend */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Section title="Accuracy Breakdown by Factor" subtitle="empirical hit rate per ranking factor — derived from settled picks">
              <FactorAccuracyTable factors={detail.factorAccuracy} />
            </Section>
            <Section
              title="P&L Trend"
              subtitle="cumulative profit/loss from staked products (value bets + slips)"
              right={<TrendArrow dir={detail.trendDirection} />}
            >
              {chartPoints.length > 0 ? (
                <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
                  <PnLTrendChart points={chartPoints} />
                  <div className="mt-2 flex flex-wrap gap-2 font-mono text-[11px] text-slate-400">
                    <span>
                      7d: <span className={detail.last7DaysPnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{money(detail.last7DaysPnl)}</span>
                    </span>
                    <span>
                      30d: <span className={detail.last30DaysPnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{money(detail.last30DaysPnl)}</span>
                    </span>
                    <span>
                      All: <span className={detail.totalPnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{money(detail.totalPnl)}</span>
                    </span>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-700 bg-slate-900 p-8 text-center font-mono text-xs text-slate-500">
                  No staked P&L yet for this league — trend appears once value bets or slips settle.
                </div>
              )}
            </Section>
          </div>

          {/* Bet-by-bet table */}
          <Section
            title="All Bets — Full Transparency"
            subtitle={`${detail.bets.length} individual bets (verification picks, value bets, slips) · every aggregate above is computed from these rows`}
          >
            <LeagueBetsTable bets={detail.bets} />
          </Section>
        </>
      )}
    </section>
  );
}
