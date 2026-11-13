"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { TeamBadge } from "@/app/_components/ui";
import {
  buildPredictions,
  calculateScore,
  isScoreline,
  type Actual,
  type Fixture,
  type Prediction,
  type ScoredPrediction,
} from "@/lib/v4-predictor";

type AutoFixtureRow = {
  home: { name: string; logo: string | null };
  away: { name: string; logo: string | null };
  state: "pre" | "in" | "post";
  actual: Actual | null;
  enginePrediction: string | null;
  prediction: string | null;
  category: string | null;
  /** Expected Points the pick was chosen on: 10 × P(outcome) + 10 × P(exact). */
  ep: number | null;
  v2Category: string | null;
  v2Prediction: string | null;
};

type StrategyInfo = {
  id: string;
  name: string;
  description: string;
  backtest: {
    season: string;
    weeks: number[];
    fixtureCount: number;
    average: number;
    floor: number;
    hundredPlus: number;
    weekly: number[];
    mode: string;
  } | null;
};

const MATCHWEEKS = Array.from({ length: 38 }, (_, i) => i + 1);

function normalizeTeam(
  value: unknown,
): { name: string; logo: string | null } | null {
  if (typeof value === "string") {
    return value ? { name: value, logo: null } : null;
  }
  if (value && typeof value === "object") {
    const team = value as { name?: unknown; logo?: unknown };
    if (typeof team.name === "string" && team.name) {
      return {
        name: team.name,
        logo: typeof team.logo === "string" ? team.logo : null,
      };
    }
  }
  return null;
}

function normalizeRow(raw: unknown): AutoFixtureRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as {
    home?: unknown;
    away?: unknown;
    state?: unknown;
    actual?: unknown;
    enginePrediction?: unknown;
    prediction?: unknown;
    category?: unknown;
    ep?: unknown;
    v2Category?: unknown;
    v2Prediction?: unknown;
  };
  const home = normalizeTeam(row.home);
  const away = normalizeTeam(row.away);
  if (!home || !away) return null;
  const state: AutoFixtureRow["state"] =
    row.state === "post" || row.state === "in" || row.state === "pre"
      ? row.state
      : "pre";
  const enginePrediction =
    typeof row.enginePrediction === "string" && isScoreline(row.enginePrediction)
      ? row.enginePrediction
      : null;
  const prediction =
    typeof row.prediction === "string" && isScoreline(row.prediction)
      ? row.prediction
      : null;
  const category =
    typeof row.category === "string" && row.category.trim() !== ""
      ? row.category.trim()
      : null;
  const actual: Actual | null =
    Array.isArray(row.actual) &&
    row.actual.length === 2 &&
    Number.isFinite(Number(row.actual[0])) &&
    Number.isFinite(Number(row.actual[1]))
      ? [Number(row.actual[0]), Number(row.actual[1])]
      : null;
  const ep =
    typeof row.ep === "number" && Number.isFinite(row.ep) && row.ep >= 0
      ? row.ep
      : null;
  const v2Category = typeof row.v2Category === "string" && row.v2Category.trim() ? row.v2Category.trim() : null;
  const v2Prediction = typeof row.v2Prediction === "string" && isScoreline(row.v2Prediction) ? row.v2Prediction : null;
  return { home, away, state, actual, enginePrediction, prediction, category, ep, v2Category, v2Prediction };
}

function normalizeStrategy(raw: unknown): StrategyInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.description !== "string") return null;
  const bt = value.backtest as Record<string, unknown> | null | undefined;
  const backtest = bt && typeof bt === "object" &&
    typeof bt.season === "string" && Array.isArray(bt.weeks) &&
    typeof bt.fixtureCount === "number" && Number.isFinite(bt.fixtureCount) &&
    typeof bt.average === "number" && Number.isFinite(bt.average) &&
    typeof bt.floor === "number" && Number.isFinite(bt.floor) &&
    typeof bt.hundredPlus === "number" && Number.isFinite(bt.hundredPlus) &&
    Array.isArray(bt.weekly) && typeof bt.mode === "string"
    ? {
        season: bt.season, weeks: bt.weeks.filter((n): n is number => typeof n === "number"),
        fixtureCount: bt.fixtureCount, average: bt.average, floor: bt.floor,
        hundredPlus: bt.hundredPlus, weekly: bt.weekly.filter((n): n is number => typeof n === "number"), mode: bt.mode,
      }
    : null;
  return { id: value.id, name: value.name, description: value.description, backtest };
}

function StatusBadge({ state }: { state: AutoFixtureRow["state"] }) {
  if (state === "post") {
    return (
      <span className="bg-slate-800 text-slate-300 text-xs px-2 py-1 rounded">
        FT
      </span>
    );
  }
  if (state === "in") {
    return (
      <span className="bg-red-500/20 text-red-400 text-xs px-2 py-1 rounded animate-pulse">
        LIVE
      </span>
    );
  }
  return (
    <span className="bg-amber-500/20 text-amber-400 text-xs px-2 py-1 rounded">
      UPCOMING
    </span>
  );
}

function PointsCell({ points }: { points: number }) {
  if (points === 20) {
    return <span className="text-green-400 font-bold">🎯 20 pts</span>;
  }
  if (points === 10) {
    return <span className="text-yellow-400 font-bold">✅ 10 pts</span>;
  }
  return <span className="text-red-400 font-bold">❌ {points} pts</span>;
}

function MatchCell({ row }: { row: AutoFixtureRow }) {
  return (
    <span className="flex items-center gap-2">
      <TeamBadge logo={row.home.logo} name={row.home.name} />
      <span className="text-white">{row.home.name}</span>
      {" "}
      <span className="text-slate-400">vs</span>
      {" "}
      <TeamBadge logo={row.away.logo} name={row.away.name} />
      <span className="text-white">{row.away.name}</span>
      <span className="sr-only">{`${row.home.name} vs ${row.away.name}`}</span>
    </span>
  );
}

export default function V4PredictorPage() {
  const [selectedWeek, setSelectedWeek] = useState(11);
  const [fixtures, setFixtures] = useState<AutoFixtureRow[]>([]);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [scorecard, setScorecard] = useState<ScoredPrediction[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingFixtures, setLoadingFixtures] = useState(true);
  const [error, setError] = useState("");
  const [strategy, setStrategy] = useState<StrategyInfo | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchFixtures = useCallback(async (week: number) => {
    const requestId = ++requestIdRef.current;
    setLoadingFixtures(true);
    setError("");
    try {
      const response = await fetch(`/api/v4-predictor/auto?week=${week}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Failed to fetch");
      const data: { week?: unknown; fixtures?: unknown; strategy?: unknown } =
        await response.json();
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      if (
        typeof data?.week === "number" &&
        Number.isInteger(data.week) &&
        data.week >= 1 &&
        data.week <= 38
      ) {
        setSelectedWeek(data.week);
      }
      const rawRows: unknown[] = Array.isArray(data?.fixtures)
        ? (data.fixtures as unknown[])
        : [];
      const rows = rawRows
        .map(normalizeRow)
        .filter((row): row is AutoFixtureRow => row !== null);
      const v4Fixtures: Fixture[] = rows.map((row) => ({
        home: row.home.name,
        away: row.away.name,
        enginePrediction: row.enginePrediction,
        prediction: row.prediction,
        category: row.category,
        ep: row.ep,
      }));
      const newPredictions = buildPredictions(v4Fixtures);
      const finished = rows
        .map((row, index) =>
          Array.isArray(row.actual) && row.actual.length === 2
            ? { prediction: newPredictions[index], actual: row.actual }
            : null,
        )
        .filter(
          (entry): entry is { prediction: Prediction; actual: Actual } =>
            entry !== null,
        );
      let newScorecard: ScoredPrediction[] = [];
      let newTotal: number | null = null;
      if (finished.length > 0) {
        const [scored, points] = calculateScore(
          finished.map((entry) => entry.prediction),
          finished.map((entry) => entry.actual),
        );
        newScorecard = scored;
        newTotal = points;
      }
      setStrategy(normalizeStrategy(data?.strategy));
      setFixtures(rows);
      setPredictions(newPredictions);
      setScorecard(newScorecard);
      setTotal(newTotal);
    } catch {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setError("Failed to fetch real fixtures.");
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoadingFixtures(false);
      }
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchFixtures(selectedWeek);
  }, [selectedWeek, fetchFixtures]);

  function handleWeekChange(nextWeek: number) {
    if (!Number.isInteger(nextWeek) || nextWeek < 1 || nextWeek > 38) return;
    setSelectedWeek(nextWeek);
  }

  const finishedFixtures = fixtures.filter(
    (row) => Array.isArray(row.actual) && row.actual.length === 2,
  );

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0F1117] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="relative mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/"
            className="inline-flex items-center rounded-full border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700"
          >
            ← Oracle
          </Link>
          <label className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200">
            <span>Matchweek</span>
            <select
              aria-label="Select Matchweek"
              className="rounded bg-slate-900 px-2 py-1 text-xs font-semibold text-amber-300 outline-none focus:ring-1 focus:ring-amber-400"
              value={selectedWeek}
              onChange={(e) => handleWeekChange(Number(e.target.value))}
            >
              {MATCHWEEKS.map((w) => (
                <option key={w} value={w}>
                  Matchweek {w}
                </option>
              ))}
            </select>
          </label>
        </div>

        {loadingFixtures && (
          <div
            role="status"
            className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4 text-sm text-slate-300"
          >
            <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-slate-700 border-t-amber-400" />
            <span>Loading real fixtures...</span>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}

        <header>
          <h1 className="text-3xl font-black text-white">
            🔮 V4 Ultimate Predictor
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            {strategy?.description ?? "V2 chooses the outcome; the Engine chooses the most probable scoreline matching that outcome."}{" "}
            Loaded automatically for Matchweek {selectedWeek}.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 font-semibold text-amber-300">
              {strategy?.name ?? "Consensus Override"}
            </span>
            {strategy?.backtest && (
              <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-slate-300">
                MW1–10 backtest: {strategy.backtest.average.toFixed(1)} avg · {strategy.backtest.floor} floor · {strategy.backtest.hundredPlus}×100+
              </span>
            )}
          </div>
          {strategy?.backtest && (
            <p className="mt-2 text-xs text-slate-500">
              {strategy.backtest.fixtureCount} fixtures · archived pre-match odds replay. Historical live scorecards may differ because closing odds are stripped; past results do not guarantee future scores.
            </p>
          )}
        </header>

        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
          <h2 className="text-lg font-semibold text-white">V4 Predictions</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-slate-400">
                <tr>
                  <th className="p-2 text-slate-400">Status</th>
                  <th className="p-2 text-slate-400">Match</th>
                  <th className="p-2 text-slate-400">Category</th>
                  <th className="p-2 text-slate-400">Prediction</th>
                  <th className="p-2 text-slate-400">Expected Pts</th>
                </tr>
              </thead>
              <tbody>
                {fixtures.map((row, i) => (
                  <tr key={i} className="border-t border-white/10">
                    <td className="p-2">
                      <StatusBadge state={row.state} />
                    </td>
                    <td className="p-2">
                      <MatchCell row={row} />
                    </td>
                    <td className="p-2 text-slate-100">
                      <span>{predictions[i]?.Category ?? ""}</span>
                      {row.v2Category && (
                        <span className="mt-0.5 block text-xs text-slate-500" title={`V2 pick: ${row.v2Prediction ?? ""}`}>
                          {row.v2Category}
                        </span>
                      )}
                    </td>
                    <td className="p-2 font-mono text-slate-100">
                      {predictions[i]?.Prediction ?? ""}
                    </td>
                    <td className="p-2 font-mono text-amber-400">
                      {row.ep === null ? "" : row.ep.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!loadingFixtures && fixtures.length === 0 && (
              <p className="mt-2 text-sm text-slate-400">
                No fixtures found for this matchweek.
              </p>
            )}
          </div>
        </section>

        {scorecard.length > 0 && total !== null && (
          <section className="rounded-2xl border border-white/[0.08] bg-slate-900 p-4">
            <h2 className="text-lg font-semibold text-white">Scorecard</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-slate-400">
                  <tr>
                    <th className="p-2 text-slate-400">Match</th>
                    <th className="p-2 text-slate-400">Prediction</th>
                    <th className="p-2 text-slate-400">Actual Result</th>
                    <th className="p-2 text-slate-400">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {scorecard.map((s, i) => {
                    const fixture = finishedFixtures[i];
                    return (
                      <tr key={i} className="border-t border-white/10">
                        <td className="p-2">
                          {fixture ? (
                            <MatchCell row={fixture} />
                          ) : (
                            <span className="text-white">{s.Match}</span>
                          )}
                        </td>
                        <td className="p-2 font-mono text-slate-100">
                          {s.Prediction}
                        </td>
                        <td className="p-2 font-mono text-slate-100">
                          {s.Actual}
                        </td>
                        <td className="p-2">
                          <PointsCell points={s.Points} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-center">
              <span className="text-2xl font-black text-amber-400">
                TOTAL SCORE: {total} / 200
              </span>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
