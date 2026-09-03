"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GLASS_PANEL } from "../../_components/design";

type DataQuality = "Real" | "Mixed" | "Synthetic";

interface CalibrationBucket {
  label: string;
  lowerBound: number;
  upperBound: number;
  predictedProbability: number;
  actualFrequency: number;
  observations: number;
}

interface BacktestMetrics {
  matchesTested: number;
  top1Accuracy: number;
  top3Accuracy: number;
  top5Accuracy: number;
  meanAbsoluteError: number;
  meanAbsoluteErrorTop3: number;
  calibrationScore: number;
  brierScore: number;
  calibrationBuckets: CalibrationBucket[];
}

interface LeagueResult extends BacktestMetrics {
  league: string;
  leagueSlug: string;
}

interface MatchLog {
  fixtureId: string;
  match: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  leagueSlug: string;
  date: string;
  predictedTop1: string;
  predictedTop1Probability: number;
  predictedTop3: string[];
  predictedTop5: string[];
  actualScore: string;
  actualRank: number | null;
  correctTop1: boolean;
  correctTop3: boolean;
  correctTop5: boolean;
  dataQuality: DataQuality;
}

interface BacktestResponse {
  generatedAt: string;
  days: number;
  model: string;
  dataSource: string;
  overall: BacktestMetrics;
  byLeague: LeagueResult[];
  matches: MatchLog[];
  error?: string;
}

const RANGES = [7, 30, 90] as const;
const PAGE_SIZE = 12;

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function MetricCard({
  label,
  value,
  hint,
  accent = "text-white",
}: {
  label: string;
  value: string;
  hint: string;
  accent?: string;
}) {
  return (
    <div className={`rounded-2xl p-4 ${GLASS_PANEL}`}>
      <div className="font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-black tracking-tight ${accent}`}>{value}</div>
      <div className="mt-1 text-[10px] text-slate-500">{hint}</div>
    </div>
  );
}

function BacktestSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-2xl bg-slate-800/80" />
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="h-80 animate-pulse rounded-3xl bg-slate-800/70" />
        <div className="h-80 animate-pulse rounded-3xl bg-slate-800/70" />
      </div>
    </div>
  );
}

function CorrectBadge({ match }: { match: MatchLog }) {
  if (match.correctTop1) {
    return <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-[9px] font-bold text-emerald-200">TOP 1</span>;
  }
  if (match.correctTop3) {
    return <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 text-[9px] font-bold text-cyan-200">TOP 3</span>;
  }
  if (match.correctTop5) {
    return <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[9px] font-bold text-amber-200">TOP 5</span>;
  }
  return <span className="rounded-full border border-slate-600 bg-slate-800 px-2 py-1 text-[9px] font-bold text-slate-500">MISS</span>;
}

function ScoreList({ scores, limit }: { scores: string[]; limit: number }) {
  return (
    <div className="flex min-w-32 flex-wrap gap-1">
      {scores.slice(0, limit).map((score, index) => (
        <span key={`${score}:${index}`} className="rounded-md border border-white/[0.07] bg-black/20 px-1.5 py-1 font-mono text-[10px] text-slate-300">
          {score}
        </span>
      ))}
    </div>
  );
}

export default function CorrectScoreBacktestPage() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<BacktestResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const initialLoad = useRef(false);

  const load = useCallback(async (range: number, fresh = false) => {
    if (fresh) setRunning(true);
    else setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/correct-score/backtest?days=${range}`, {
        method: fresh ? "POST" : "GET",
        cache: "no-store",
      });
      const body = (await response.json()) as BacktestResponse;
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setData(body);
      setPage(1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to run the correct-score backtest.");
    } finally {
      setLoading(false);
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    if (initialLoad.current) return;
    initialLoad.current = true;
    void load(days);
  }, [days, load]);

  const pageCount = Math.max(1, Math.ceil((data?.matches.length ?? 0) / PAGE_SIZE));
  const visibleMatches = useMemo(
    () => data?.matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) ?? [],
    [data, page],
  );

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0F1117] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,_rgba(139,92,246,0.13)_0%,_rgba(6,182,212,0.06)_38%,_#0F1117_70%)]"
      />
      <div aria-hidden="true" className="pointer-events-none absolute -right-24 top-80 h-80 w-80 rounded-full bg-violet-600/10 blur-3xl" />

      <div className="relative mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-violet-400/25 bg-violet-400/[0.08] px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-violet-200">
              <span className="h-1.5 w-1.5 rounded-full bg-violet-300 shadow-[0_0_8px_rgba(196,181,253,0.8)]" />
              Leakage-free historical replay
            </div>
            <h1 className="bg-gradient-to-r from-white via-violet-100 to-cyan-200 bg-clip-text text-3xl font-black tracking-tight text-transparent sm:text-4xl">
              Correct Score Backtest
            </h1>
            <p className="mt-2 text-sm text-slate-400 sm:text-base">
              How accurate is the model? Past performance metrics.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/correct-score"
              className="inline-flex items-center rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/[0.09] hover:text-white"
            >
              ← Predictions
            </Link>
            <div className="flex rounded-full border border-white/[0.08] bg-white/[0.04] p-1 backdrop-blur-xl" role="group" aria-label="Backtest date range">
              {RANGES.map((range) => (
                <button
                  key={range}
                  type="button"
                  onClick={() => {
                    setDays(range);
                    void load(range);
                  }}
                  aria-pressed={days === range}
                  className={`rounded-full px-3 py-1.5 text-[10px] font-bold transition ${
                    days === range
                      ? "bg-violet-500 text-white shadow-[0_0_15px_-5px_rgba(139,92,246,0.8)]"
                      : "text-slate-500 hover:bg-white/[0.06] hover:text-white"
                  }`}
                >
                  {range}D
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void load(days, true)}
              disabled={running || loading}
              className="inline-flex items-center gap-2 rounded-full border border-violet-300/25 bg-gradient-to-r from-violet-600 to-cyan-600 px-4 py-2 text-xs font-bold text-white shadow-[0_0_20px_-7px_rgba(139,92,246,0.75)] transition hover:scale-[1.03] disabled:cursor-wait disabled:opacity-60"
            >
              <span className={running ? "animate-spin" : ""}>↻</span>
              {running ? "Running…" : "Run Backtest"}
            </button>
          </div>
        </header>

        <div className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl p-4 text-xs text-slate-400 ${GLASS_PANEL}`}>
          <span>Each match is predicted from results available strictly before its kickoff. The target score is never a model input.</span>
          {data && <span className="font-mono text-[9px] uppercase tracking-wider text-slate-600">{data.model}</span>}
        </div>

        {error && (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5 text-sm text-rose-200">
            <div className="font-bold">Backtest unavailable</div>
            <p className="mt-1 text-rose-200/70">{error}</p>
            <button
              type="button"
              onClick={() => void load(days, true)}
              className="mt-3 rounded-full border border-rose-400/30 px-4 py-2 text-xs font-bold hover:bg-rose-400/10"
            >
              Try again
            </button>
          </div>
        )}

        {loading && !data ? (
          <BacktestSkeleton />
        ) : data ? (
          <>
            <section aria-labelledby="summary-heading">
              <div className="mb-3 flex items-end justify-between">
                <h2 id="summary-heading" className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Summary metrics</h2>
                <span className="text-[10px] text-slate-600">Last {data.days} days</span>
              </div>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <MetricCard label="Matches Tested" value={data.overall.matchesTested.toLocaleString("en-GB")} hint="finished fixtures replayed" />
                <MetricCard label="Top 1 Accuracy" value={percent(data.overall.top1Accuracy)} hint="exact top prediction" accent="text-emerald-300" />
                <MetricCard label="Top 3 Accuracy" value={percent(data.overall.top3Accuracy)} hint="actual score in top three" accent="text-cyan-300" />
                <MetricCard label="Top 5 Accuracy" value={percent(data.overall.top5Accuracy)} hint="actual score in top five" accent="text-violet-300" />
                <MetricCard label="Mean Absolute Error" value={data.overall.meanAbsoluteError.toFixed(2)} hint="top 1 · both teams combined" accent="text-amber-300" />
              </div>
            </section>

            <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
              <section className={`overflow-hidden rounded-3xl ${GLASS_PANEL}`} aria-labelledby="league-heading">
                <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
                  <div>
                    <h2 id="league-heading" className="text-sm font-bold text-white">Accuracy by League</h2>
                    <p className="mt-0.5 text-[10px] text-slate-500">Exact-score hit rates and probabilistic error</p>
                  </div>
                  <span className="rounded-full border border-violet-400/20 bg-violet-400/[0.08] px-2 py-1 font-mono text-[9px] text-violet-300">
                    {data.byLeague.length} leagues
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-left text-xs">
                    <thead className="bg-black/15 font-mono text-[9px] uppercase tracking-wider text-slate-600">
                      <tr>
                        <th className="px-5 py-3">League</th>
                        <th className="px-3 py-3 text-right">Matches</th>
                        <th className="px-3 py-3 text-right">Top 1</th>
                        <th className="px-3 py-3 text-right">Top 3</th>
                        <th className="px-3 py-3 text-right">Top 5</th>
                        <th className="px-3 py-3 text-right">MAE</th>
                        <th className="px-5 py-3 text-right">Brier</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.05]">
                      {data.byLeague.map((league) => (
                        <tr key={league.leagueSlug} className="transition hover:bg-white/[0.025]">
                          <td className="px-5 py-3 font-semibold text-slate-200">{league.league}</td>
                          <td className="px-3 py-3 text-right font-mono text-slate-500">{league.matchesTested}</td>
                          <td className="px-3 py-3 text-right font-mono font-bold text-emerald-300">{percent(league.top1Accuracy)}</td>
                          <td className="px-3 py-3 text-right font-mono text-cyan-300">{percent(league.top3Accuracy)}</td>
                          <td className="px-3 py-3 text-right font-mono text-violet-300">{percent(league.top5Accuracy)}</td>
                          <td className="px-3 py-3 text-right font-mono text-slate-300">{league.meanAbsoluteError.toFixed(2)}</td>
                          <td className="px-5 py-3 text-right font-mono text-slate-400">{league.brierScore.toFixed(3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!data.byLeague.length && <div className="p-8 text-center text-sm text-slate-500">No league samples in this date range.</div>}
                </div>
              </section>

              <section className={`rounded-3xl p-5 ${GLASS_PANEL}`} aria-labelledby="calibration-heading">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 id="calibration-heading" className="text-sm font-bold text-white">Calibration Plot</h2>
                    <p className="mt-0.5 text-[10px] text-slate-500">Predicted probability vs actual frequency</p>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-xl font-black text-violet-300">{percent(data.overall.calibrationScore)}</div>
                    <div className="font-mono text-[8px] uppercase tracking-wider text-slate-600">Calibration score</div>
                  </div>
                </div>

                <div className="mt-5 flex items-center gap-4 text-[9px] text-slate-500">
                  <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-violet-400" /> Predicted</span>
                  <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-cyan-300" /> Actual</span>
                </div>
                <div className="mt-4 space-y-4">
                  {data.overall.calibrationBuckets.map((bucket) => {
                    const scale = Math.max(0.05, bucket.predictedProbability, bucket.actualFrequency);
                    return (
                      <div key={bucket.label} className="grid grid-cols-[48px_1fr_44px] items-center gap-2">
                        <div className="font-mono text-[9px] text-slate-500">{bucket.label}</div>
                        <div className="space-y-1.5">
                          <div className="h-2 overflow-hidden rounded-full bg-black/25">
                            <div className="h-full rounded-full bg-violet-400" style={{ width: `${(bucket.predictedProbability / scale) * 100}%` }} />
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-black/25">
                            <div className="h-full rounded-full bg-cyan-300" style={{ width: `${(bucket.actualFrequency / scale) * 100}%` }} />
                          </div>
                        </div>
                        <div className="text-right font-mono text-[8px] text-slate-500">
                          <div>{percent(bucket.predictedProbability)}</div>
                          <div>{percent(bucket.actualFrequency)}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3 border-t border-white/[0.06] pt-4">
                  <div className="rounded-xl bg-black/15 p-3">
                    <div className="font-mono text-[8px] uppercase tracking-wider text-slate-600">Brier Score</div>
                    <div className="mt-1 font-mono text-lg font-bold text-slate-200">{data.overall.brierScore.toFixed(3)}</div>
                    <div className="text-[9px] text-slate-600">lower is better</div>
                  </div>
                  <div className="rounded-xl bg-black/15 p-3">
                    <div className="font-mono text-[8px] uppercase tracking-wider text-slate-600">MAE · Top 3</div>
                    <div className="mt-1 font-mono text-lg font-bold text-slate-200">{data.overall.meanAbsoluteErrorTop3.toFixed(2)}</div>
                    <div className="text-[9px] text-slate-600">average of top three</div>
                  </div>
                </div>
              </section>
            </div>

            <section className={`overflow-hidden rounded-3xl ${GLASS_PANEL}`} aria-labelledby="log-heading">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
                <div>
                  <h2 id="log-heading" className="text-sm font-bold text-white">Match-Level Log</h2>
                  <p className="mt-0.5 text-[10px] text-slate-500">Predicted ranks compared with the final score</p>
                </div>
                <span className="font-mono text-[9px] text-slate-600">
                  Page {page} of {pageCount}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1050px] text-left text-xs">
                  <thead className="bg-black/15 font-mono text-[9px] uppercase tracking-wider text-slate-600">
                    <tr>
                      <th className="px-5 py-3">Match</th>
                      <th className="px-3 py-3">League / Date</th>
                      <th className="px-3 py-3">Predicted Top 1</th>
                      <th className="px-3 py-3">Top 3</th>
                      <th className="px-3 py-3">Top 5</th>
                      <th className="px-3 py-3 text-center">Actual</th>
                      <th className="px-5 py-3 text-center">Was Correct?</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05]">
                    {visibleMatches.map((match) => (
                      <tr key={`${match.leagueSlug}:${match.fixtureId}`} className="transition hover:bg-white/[0.025]">
                        <td className="max-w-56 px-5 py-3 font-semibold text-slate-200">{match.match}</td>
                        <td className="px-3 py-3">
                          <div className="text-[10px] text-slate-400">{match.league}</div>
                          <time dateTime={match.date} className="font-mono text-[9px] text-slate-600">{dateLabel(match.date)}</time>
                        </td>
                        <td className="px-3 py-3">
                          <div className="inline-flex rounded-lg border border-violet-400/20 bg-violet-400/[0.08] px-2 py-1 font-mono font-black text-violet-200">{match.predictedTop1}</div>
                          <div className="mt-1 font-mono text-[8px] text-slate-600">{percent(match.predictedTop1Probability)}</div>
                        </td>
                        <td className="px-3 py-3"><ScoreList scores={match.predictedTop3} limit={3} /></td>
                        <td className="px-3 py-3"><ScoreList scores={match.predictedTop5} limit={5} /></td>
                        <td className="px-3 py-3 text-center">
                          <div className="inline-flex rounded-lg border border-white/10 bg-black/25 px-2.5 py-1 font-mono text-base font-black text-white">{match.actualScore}</div>
                          <div className="mt-1 font-mono text-[8px] text-slate-600">rank {match.actualRank ?? "outside grid"}</div>
                        </td>
                        <td className="px-5 py-3 text-center"><CorrectBadge match={match} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!data.matches.length && (
                  <div className="p-10 text-center">
                    <div className="text-2xl">📊</div>
                    <div className="mt-2 text-sm font-semibold text-slate-300">No completed matches found</div>
                    <p className="mt-1 text-xs text-slate-600">Try a longer date range or run again when the fixture cache has results.</p>
                  </div>
                )}
              </div>
              {data.matches.length > PAGE_SIZE && (
                <div className="flex items-center justify-between border-t border-white/[0.06] px-5 py-4">
                  <button
                    type="button"
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                    disabled={page === 1}
                    className="rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-[10px] font-bold text-slate-300 transition hover:bg-white/[0.08] disabled:opacity-30"
                  >
                    ← Previous
                  </button>
                  <span className="text-[10px] text-slate-600">{data.matches.length} matches</span>
                  <button
                    type="button"
                    onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                    disabled={page === pageCount}
                    className="rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-[10px] font-bold text-slate-300 transition hover:bg-white/[0.08] disabled:opacity-30"
                  >
                    Next →
                  </button>
                </div>
              )}
            </section>

            <footer className="flex flex-wrap items-center justify-between gap-2 pb-4 text-[10px] text-slate-600">
              <span>{data.dataSource}</span>
              <span>Generated {new Date(data.generatedAt).toLocaleString("en-GB")}</span>
            </footer>
          </>
        ) : null}
      </div>
    </main>
  );
}
