"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ACTION_AMBER } from "../_components/design";
import { calculateScore, generatePredictions, MW11_FIXTURES, type Actual, type Fixture, type Prediction, type ScoredPrediction } from "@/lib/v4-predictor";

type HistoryRow = { id: number; matchweek: string; predictions: Prediction[]; actuals: Actual[] | null; totalScore: number | null; createdAt: string };
type AutoFixtureRow = { home: string; away: string; state: "pre" | "in" | "post"; actual: Actual | null };
const input = "rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-amber-400 font-mono";
const card = "rounded-2xl p-4 bg-white/[0.03] border border-white/[0.08]";
const heading = "text-lg font-semibold text-white";

export default function V4PredictorPage() {
  const [matchweek, setMatchweek] = useState("Matchweek 11");
  const [fixtures, setFixtures] = useState<Fixture[]>(() => MW11_FIXTURES.map(([h, a]) => [h, a]));
  const [snapshot, setSnapshot] = useState<Fixture[]>([]);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [actuals, setActuals] = useState<[string, string][]>(() => Array.from({ length: 10 }, () => ["", ""]));
  const [scorecard, setScorecard] = useState<ScoredPrediction[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState("");
  const [loadingFixtures, setLoadingFixtures] = useState(true);
  const [autoError, setAutoError] = useState("");
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const changed = predictions.length > 0 && JSON.stringify(fixtures) !== JSON.stringify(snapshot);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/v4-predictor", { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load history.");
      setHistory(await response.json());
      setHistoryError("");
    } catch { setHistoryError("Unable to load history. Please try again."); }
  }, []);
  useEffect(() => {
    let active = true;
    fetch("/api/v4-predictor", { cache: "no-store" })
      .then(response => { if (!response.ok) throw new Error("Unable to load history"); return response.json(); })
      .then(rows => { if (active) setHistory(rows); })
      .catch(() => { if (active) setHistoryError("Unable to load history. Please try again."); });
    return () => { active = false; };
  }, []);

  const applyAutoFixtures = useCallback((rows: AutoFixtureRow[]) => {
    if (rows.length === 0) {
      setAutoError("No real fixtures found right now. Manual input still available.");
      return;
    }
    const newFixtures: Fixture[] = rows.map(row => [row.home, row.away]);
    const newPredictions = generatePredictions(newFixtures);
    const newActuals: [string, string][] = rows.map(row =>
      Array.isArray(row.actual) && row.actual.length === 2
        ? [String(row.actual[0]), String(row.actual[1])]
        : ["0", "0"],
    );
    setFixtures(newFixtures);
    setSnapshot(newFixtures.map(([h, a]) => [h, a] as Fixture));
    setPredictions(newPredictions);
    setActuals(newActuals);

    const finished = rows
      .map((row, index) =>
        Array.isArray(row.actual) && row.actual.length === 2
          ? { prediction: newPredictions[index], actual: row.actual }
          : null,
      )
      .filter((entry): entry is { prediction: Prediction; actual: Actual } => entry !== null);

    if (finished.length > 0) {
      const [scored, points] = calculateScore(
        finished.map(entry => entry.prediction),
        finished.map(entry => entry.actual),
      );
      setScorecard(scored);
      setTotal(points);
    } else {
      setScorecard([]);
      setTotal(null);
    }
    setError("");
    setSaveMessage("");
  }, []);

  const fetchRealFixtures = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadingFixtures(true);
    setAutoError("");
    try {
      const response = await fetch("/api/v4-predictor/auto", { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to fetch");
      const data = await response.json();
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      const rawRows = Array.isArray(data?.fixtures) ? (data.fixtures as AutoFixtureRow[]) : [];
      const rows = rawRows.filter(row => row && typeof row.home === "string" && typeof row.away === "string");
      applyAutoFixtures(rows);
    } catch {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setAutoError("Failed to fetch real fixtures. Manual input still available.");
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoadingFixtures(false);
      }
    }
  }, [applyAutoFixtures]);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    fetch("/api/v4-predictor/auto", { cache: "no-store" })
      .then(response => {
        if (!response.ok) throw new Error("Failed to fetch");
        return response.json();
      })
      .then(data => {
        if (!mountedRef.current || requestId !== requestIdRef.current) return;
        const rawRows = Array.isArray(data?.fixtures) ? (data.fixtures as AutoFixtureRow[]) : [];
        const rows = rawRows.filter(row => row && typeof row.home === "string" && typeof row.away === "string");
        applyAutoFixtures(rows);
      })
      .catch(() => {
        if (!mountedRef.current || requestId !== requestIdRef.current) return;
        setAutoError("Failed to fetch real fixtures. Manual input still available.");
      })
      .finally(() => {
        if (mountedRef.current && requestId === requestIdRef.current) {
          setLoadingFixtures(false);
        }
      });
  }, [applyAutoFixtures]);

  function generate() {
    if (fixtures.some(([h, a]) => !h.trim() || !a.trim() || h.trim().toLowerCase() === a.trim().toLowerCase())) {
      setError("Enter two different teams for every fixture."); return;
    }
    // Keep names exactly as entered: the reference rules are case-sensitive.
    setSnapshot(fixtures.map(([h, a]) => [h, a]));
    setPredictions(generatePredictions(fixtures));
    setActuals(Array.from({ length: fixtures.length }, () => ["", ""]));
    setScorecard([]); setTotal(null); setError(""); setSaveMessage("");
  }

  async function scoreAndSave() {
    if (!matchweek.trim() || matchweek.length > 200) { setError("Enter a matchweek (up to 200 characters)."); return; }
    if (!predictions.length || changed) { setError("Generate predictions for the current fixtures first."); return; }
    if (actuals.some(pair => pair.some(value => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))))) {
      setError("Enter a non-negative whole number of goals for every team."); return;
    }
    const results: Actual[] = actuals.map(([h, a]) => [Number(h), Number(a)]);
    const [scored, points] = calculateScore(predictions, results);
    setScorecard(scored); setTotal(points); setError("");
    const payload = { matchweek: matchweek.trim(), fixtures: snapshot, predictions, actuals: results, totalScore: points };
    const key = JSON.stringify(payload);
    if (key === lastSaved) { setSaveMessage("Already saved."); return; }
    setSaving(true); setSaveMessage("Saving…");
    try {
      const response = await fetch("/api/v4-predictor", { method: "POST", headers: { "Content-Type": "application/json" }, body: key });
      if (!response.ok) throw new Error("Save failed");
      setLastSaved(key); setSaveMessage("Saved to history.");
      await loadHistory();
    } catch { setSaveMessage("Save failed. Click Calculate Score to retry."); }
    finally { setSaving(false); }
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0F1117] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="relative mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/" className="inline-flex items-center rounded-full border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700">← Oracle</Link>
          <button type="button" className={`${ACTION_AMBER} inline-flex items-center rounded-full px-3 py-2 text-xs font-semibold`} disabled={loadingFixtures} onClick={() => void fetchRealFixtures()}>⚡ Fetch Real Fixtures</button>
        </div>
        {loadingFixtures && <p role="status" className="text-sm text-slate-300">Loading real fixtures...</p>}
        {autoError && <p role="alert" className="text-sm text-red-300">{autoError}</p>}
        <header><h1 className="text-3xl font-black text-white">🔮 V4 Ultimate Predictor</h1><p className="mt-2 text-sm text-slate-400">Rule-based Premier League score predictions. Team names are case-sensitive.</p></header>
        <div className={card}>
          <h2 className={heading}>1. Input Fixtures</h2>
          <label className="mt-4 block text-sm text-slate-300">Matchweek <input className={`${input} ml-2`} value={matchweek} onChange={e => setMatchweek(e.target.value)} maxLength={200} /></label>
          <div className="mt-4 space-y-2">{fixtures.map(([home, away], i) => (
            <div key={i} className="grid grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
              <span className="text-sm text-slate-500">{i + 1}</span>
              <input className={`${input} min-w-0`} aria-label={`Fixture ${i + 1} home`} placeholder="Home" maxLength={200} value={home} onChange={e => setFixtures(old => old.map((f, j) => j === i ? [e.target.value, f[1]] : f))} />
              <input className={`${input} min-w-0`} aria-label={`Fixture ${i + 1} away`} placeholder="Away" maxLength={200} value={away} onChange={e => setFixtures(old => old.map((f, j) => j === i ? [f[0], e.target.value] : f))} />
            </div>
          ))}</div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" className={`${ACTION_AMBER} px-4 py-2 text-sm`} onClick={generate}>Generate Predictions</button>
            <button type="button" className="inline-flex items-center rounded-full border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700" disabled={loadingFixtures} onClick={() => void fetchRealFixtures()}>Refresh Fixtures</button>
          </div>
          {changed && <p className="mt-2 text-sm text-amber-300">Fixtures changed — regenerate predictions before scoring.</p>}
        </div>
        <div className={card}><h2 className={heading}>2. V4 Predictions</h2>
          {predictions.length ? <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className="p-2">Match</th><th className="p-2">Category</th><th className="p-2">Prediction</th><th className="p-2">Target pts</th></tr></thead><tbody>{predictions.map((p, i) => <tr key={i} className="border-t border-white/10"><td className="p-2">{p.Match}</td><td className="p-2">{p.Category}</td><td className="p-2 font-mono">{p.Prediction}</td><td className="p-2">{p.Target_Pts}</td></tr>)}</tbody></table></div> : <p className="mt-2 text-sm text-slate-400">Generate predictions to get started.</p>}
        </div>
        <div className={card}><h2 className={heading}>3. Enter Actual Results</h2>
          <div className="mt-4 space-y-2">{actuals.map(([home, away], i) => <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,6rem)_minmax(0,6rem)] items-center gap-2"><span className="text-sm text-slate-300">{predictions[i]?.Match ?? `${fixtures[i][0]} vs ${fixtures[i][1]}`}</span><input className={`${input} min-w-0`} aria-label={`Match ${i + 1} home goals`} placeholder="Home" type="number" min="0" step="1" value={home} onChange={e => { setActuals(old => old.map((a, j) => j === i ? [e.target.value, a[1]] : a)); setScorecard([]); setTotal(null); setSaveMessage(""); }} /><input className={`${input} min-w-0`} aria-label={`Match ${i + 1} away goals`} placeholder="Away" type="number" min="0" step="1" value={away} onChange={e => { setActuals(old => old.map((a, j) => j === i ? [a[0], e.target.value] : a)); setScorecard([]); setTotal(null); setSaveMessage(""); }} /></div>)}</div>
          <button type="button" className={`${ACTION_AMBER} mt-4 px-4 py-2 text-sm`} disabled={saving} onClick={() => void scoreAndSave()}>Calculate Score</button>
          {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}{saveMessage && <p role="status" className="mt-2 text-sm text-slate-300">{saveMessage}</p>}
        </div>
        <div className={card}><h2 className={heading}>Scorecard {total !== null && <span className="text-amber-300">— {total} pts</span>}</h2>
          {scorecard.length ? <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className="p-2">Match</th><th className="p-2">Prediction</th><th className="p-2">Actual</th><th className="p-2">Points</th><th className="p-2">Status</th></tr></thead><tbody>{scorecard.map((s, i) => <tr key={i} className="border-t border-white/10"><td className="p-2">{s.Match}</td><td className="p-2">{s.Prediction}</td><td className="p-2">{s.Actual}</td><td className="p-2">{s.Points}</td><td className="p-2">{s.Status}</td></tr>)}</tbody></table></div> : <p className="mt-2 text-sm text-slate-400">Enter the results to see your scorecard.</p>}
        </div>
        <div className={card}><h2 className={heading}>History</h2>{historyError && <p className="mt-2 text-sm text-red-300">{historyError} <button type="button" className="underline" onClick={() => void loadHistory()}>Retry</button></p>}{!history.length && !historyError && <p className="mt-2 text-sm text-slate-400">No saved weeks yet.</p>}
          {history.map(row => <details key={row.id} className="mt-3 border-t border-white/10 pt-3"><summary className="cursor-pointer text-sm">{row.matchweek} — {row.totalScore ?? "—"} pts <span className="text-slate-400">· {new Date(row.createdAt).toLocaleString()}</span></summary>{row.actuals && <div className="mt-2 space-y-1 text-sm text-slate-300">{calculateScore(row.predictions, row.actuals)[0].map((s, i) => <p key={i}>{s.Match}: {s.Prediction} → {s.Actual} · {s.Status}</p>)}</div>}</details>)}
        </div>
      </div>
    </main>
  );
}
