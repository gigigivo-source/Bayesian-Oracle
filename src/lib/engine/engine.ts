// ĞIGI GIVØ — Orchestrator (L0→L11)
import { buildMatchContext } from "./context";
import { buildLambdas, type LambdaSet } from "./lambdas";
import { buildRealLambdas, type RealProfiles } from "./realLambdas";
import { getCachedMeshProfile } from "./dataMesh";
import { MarketEngine } from "./markets";
import { selectTopPicks } from "./selector";
import { round } from "./stats";
import type { AgentSignal, EngineResult, LockedMatchObject, Market, PredictInput, DeepStatsVector } from "./types";
import type { FixtureLite, MatchSummary } from "../espn";

const AGENTS: AgentSignal[] = [
  { name: "Statistical Agent",    weight: 0.16, description: "Poisson/NegBin/Beta on split λ from real form." },
  { name: "Tactical Agent",       weight: 0.12, description: "Formation & pressing mismatch analysis." },
  { name: "Market Agent",         weight: 0.13, description: "De-vigged bookmaker odds consensus calibration." },
  { name: "Historical Agent",     weight: 0.14, description: "H2H + Elo similarity across match database." },
  { name: "Context Agent",        weight: 0.12, description: "Stage, venue, congestion & fatigue multipliers." },
  { name: "Adversarial Agent",    weight: 0.10, description: "Model-break & overperformance detection." },
  { name: "Psychological Agent",  weight: 0.11, description: "Momentum swings & recent-form spirals." },
  { name: "Referee Agent",        weight: 0.12, description: "Discipline profile vs team styles." },
];

function isActionablePick(m: Market): boolean {
  if (m.rejected) return false;
  if (
    m.selection === "Other Score" ||
    m.selection === "Other Goal Count" ||
    m.selection.startsWith("Not ") ||
    m.selection === "No Home Win" ||
    m.selection === "No Away Win" ||
    m.selection === "No Draw"
  ) return false;
  if (m.name.includes("Correct Score"))                      return false;
  if (m.name.includes("Exact") && m.name.includes("Goals")) return false;
  return true;
}

function rankByHit(qualified: Market[], size: number): Market[] {
  const actionable = qualified.filter(isActionablePick);
  const sorted = [...actionable].sort((a, b) => {
    if (b.ciLower !== a.ciLower) return b.ciLower - a.ciLower;
    if (b.hitRate !== a.hitRate) return b.hitRate - a.hitRate;
    return a.disagreementIndex - b.disagreementIndex;
  });

  const picked: Market[] = [];
  const familyCount: Record<string, number> = {};
  for (const m of sorted) {
    if (picked.length >= size) break;
    const count = familyCount[m.family] ?? 0;
    if (count < 2) { picked.push(m); familyCount[m.family] = count + 1; }
  }
  if (picked.length < size) {
    for (const m of sorted) {
      if (picked.length >= size) break;
      if (!picked.includes(m)) picked.push(m);
    }
  }
  return picked;
}

function assemble(
  match:      LockedMatchObject,
  lam:        LambdaSet,
  input:      PredictInput,
  extraNotes: string[],
  deepStats?: DeepStatsVector,
): EngineResult {
  const engine    = new MarketEngine(match, lam);
  const markets   = engine.buildAll();
  const qualified = markets.filter((m) => !m.rejected);
  const rejected  = markets.filter((m) => m.rejected);

  const rankOrder = rankByHit(qualified, qualified.length);
  const confidenceMap: Record<string, number> = {};
  rankOrder.forEach((m, i) => {
    confidenceMap[m.id] = 1 - i / Math.max(1, rankOrder.length - 1);
  });

  const selection = selectTopPicks(qualified, lam, match.homeTeam, match.awayTeam, confidenceMap);
  const { top10, top5, top3, top1 } = selection;

  const safeMode = qualified
    .filter((m) => isActionablePick(m) && m.hitRate > 0.8 && m.disagreementIndex < 0.08 && m.ciWidth < 0.05 && m.mqs > 8.0)
    .sort((a, b) => b.hitRate - a.hitRate)
    .slice(0, 12);

  const ultraSafe = qualified
    .filter((m) => isActionablePick(m) && m.hitRate > 0.9 && m.disagreementIndex < 0.04 && m.ciLower > 0.88 && m.mqs > 8.8)
    .sort((a, b) => b.ciLower - a.ciLower)
    .slice(0, 8);

  const familyCounts: Record<string, number> = {};
  for (const m of markets) familyCounts[m.family] = (familyCounts[m.family] ?? 0) + 1;

  const lambdas: Record<string, number> = {
    "λ Home Goals":     round(lam.homeGoals, 2),
    "λ Away Goals":     round(lam.awayGoals, 2),
    "λ Home Corners":   round(lam.homeCorners, 2),
    "λ Away Corners":   round(lam.awayCorners, 2),
    "λ Home Cards":     round(lam.homeCards, 2),
    "λ Away Cards":     round(lam.awayCards, 2),
    "λ Home SOT":       round(lam.homeSot, 2),
    "λ Away SOT":       round(lam.awaySot, 2),
    "λ Total Shots":    round(lam.homeShots + lam.awayShots, 2),
    "λ Total Throw-ins":round(lam.homeThrowIns + lam.awayThrowIns, 2),
    "P(Red Card)":      round(lam.redCardProb, 3),
    "P(Penalty)":       round(lam.penaltyProb, 3),
  };

  return {
    match, input, lambdas, deepStats, agents: AGENTS,
    markets, top1, top3, top5, top10,
    safeMode, ultraSafe, rejected, familyCounts,
    totalMarkets:    markets.length,
    qualifiedMarkets: qualified.length,
    calibrationNotes: [...extraNotes, "Empirical calibration applied across 13 market families."],
    generatedAt:     new Date().toISOString(),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Manual / simulated entry (text-based, L0 kernel). */
export function runEngine(input: PredictInput): EngineResult {
  const { match, home, away } = buildMatchContext(input);
  const lam = buildLambdas(match, home, away);
  return assemble(match, lam, input, lam.calibrationNotes);
}

/** Real-data entry — grounds oracle in ESPN form + market odds. */
export function runEngineFromReal(
  fx:       FixtureLite,
  sum:      MatchSummary | null,
  profiles?: RealProfiles,
): EngineResult {
  const { lam, completeness, notes, deepStats } = buildRealLambdas(fx, sum, profiles);

  const stage = /final/i.test(fx.statusDetail ?? "")
    ? "Final"
    : /cup|copa|champions|europa|libertadores|world|euro|nations/i.test(fx.leagueName)
      ? "Knockout / Group"
      : "League Match";

  const injuryFlags = sum?.lineupAvailable
    ? ["Confirmed lineups available in feed"]
    : ["Lineups not yet released — predicted XI (pre-match window)"];

  const match: LockedMatchObject = {
    homeTeam:  fx.home.name,
    awayTeam:  fx.away.name,
    venue:     sum?.venue ?? fx.venue ?? (fx.neutralSite ? "Neutral Venue" : `${fx.home.name} (Home)`),
    venueType: fx.neutralSite ? "NEUTRAL" : "HOME",
    date:      fx.date.slice(0, 10),
    timeUtc:   new Date(fx.date).toISOString().slice(11, 16) + " UTC",
    tournamentStage:       stage,
    refereeName:           "Assigned near kickoff",
    weatherForecast:       "Live venue conditions applied at kickoff",
    keyInjuryFlags:        injuryFlags,
    dataCompletenessScore: Math.round(completeness),
    fallbackMode:          completeness < 45,
  };

  const input: PredictInput = {
    auto:   true,
    match:  `${fx.home.name} vs ${fx.away.name}`,
    league: fx.leagueName,
    date:   fx.date.slice(0, 10),
  };

  return assemble(match, lam, input, notes, deepStats);
}

/** Real-data + mesh profiles (async — used by live single-match route). */
export async function runEngineFromRealWithProfiles(
  fx:          FixtureLite,
  sum:         MatchSummary | null,
  liveStats?:  Record<string, number> | null,
): Promise<EngineResult> {
  let profiles: RealProfiles | undefined;
  try {
    const [home, away] = await Promise.all([
      getCachedMeshProfile(fx.home.name, fx.leagueSlug).catch(() => null),
      getCachedMeshProfile(fx.away.name, fx.leagueSlug).catch(() => null),
    ]);
    if (home || away) profiles = { home, away };
  } catch {
    profiles = undefined;
  }

  const result = runEngineFromReal(fx, sum, profiles);

  // In-play re-calibration — lock markets already decided mid-match
  if (fx.state === "in" && liveStats) {
    applyLiveLock(fx, result, liveStats);
  }
  return result;
}

// ─── Post-match verification ──────────────────────────────────────────────────
export { evaluateFinishedMatch } from "./evaluator";

// ─── Live lock ────────────────────────────────────────────────────────────────
function applyLiveLock(fx: FixtureLite, res: EngineResult, bs: Record<string, number>) {
  const hn = fx.home.name;
  const an = fx.away.name;
  const hScore    = Number(fx.home.score) || 0;
  const aScore    = Number(fx.away.score) || 0;
  const totalGoals = hScore + aScore;

  const currentFor = (m: Market): number | null => {
    const n = m.name;
    if (n.includes("Total Goals"))   return totalGoals;
    if (n.includes(`${hn} Goals`))   return hScore;
    if (n.includes(`${an} Goals`))   return aScore;
    if (n.includes("Total Shots"))   return (bs.homeShots ?? 0) + (bs.awayShots ?? 0);
    if (n.includes("Total SOT"))     return (bs.homeSot   ?? 0) + (bs.awaySot   ?? 0);
    if (n.includes("Total Corners")) return (bs.homeCorners ?? 0) + (bs.awayCorners ?? 0);
    if (n.includes("Total Cards"))   return (bs.homeCards ?? 0) + (bs.awayCards ?? 0);
    if (n.includes("Total Offsides"))return (bs.homeOffsides ?? 0) + (bs.awayOffsides ?? 0);
    if (n.includes("Total Saves"))   return (bs.homeSaves ?? 0) + (bs.awaySaves ?? 0);
    return null;
  };

  const lock = (m: Market) => {
    const lineM = m.name.match(/O\/U\s+([\d.]+)/);
    if (!lineM) return;
    const line   = Number(lineM[1]);
    const cur    = currentFor(m);
    if (cur === null) return;
    const isOver = m.selection.startsWith("Over");
    if (isOver && cur > line)  m.outcome = "HIT";
    else if (!isOver && cur >= line) m.outcome = "MISS";
  };

  for (const m of res.markets) lock(m);
  for (const m of res.top10)   lock(m);
}
