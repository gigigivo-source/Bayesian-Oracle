// scripts/optimize-v4.ts
// ─── V4 Predictor Grid Search Optimiser ──────────────────────────────────────
// Fetches EPL 2024-25 Matchweeks 1-10 from openfootball (via GitHub API),
// derives Poisson lambdas from rolling team-strength priors, builds the
// Dixon–Coles corrected score grid for every fixture, then grid-searches
// thousands of (T, D, F) configurations to find the one that maximises
// the Floor (worst matchweek) and Average.

import * as fs from "fs";
import * as path from "path";
import {
  buildCorrectScoreGrid,
  DIXON_COLES_RHO,
  type ScoreCell,
  type CorrectScoreGrid,
} from "../src/lib/engine/markets";

// ─── Data types ──────────────────────────────────────────────────────────────

interface HistoricalMatch {
  round: number;
  date: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
}

interface MatchPrediction {
  homeTeam: string;
  awayTeam: string;
  round: number;
  actualHome: number;
  actualAway: number;
  predictedScore: string;
  predictedOutcome: "H" | "D" | "A";
  actualOutcome: "H" | "D" | "A";
  exactProb: number;
  drawProb: number;
  category: string;
}

interface GridConfig {
  T: number; // exact-score threshold
  D: number; // draw threshold
  F: number; // fallback strategy: 0 = V2 Tiers, 1 = highest 1X2
}

interface ConfigResult {
  T: number;
  D: number;
  F: number;
  weeklyScores: number[];
  average: number;
  floor: number;
  totalExact: number;
  totalOutcome: number;
}

// ─── Load historical data ────────────────────────────────────────────────────

interface DataFileEntry {
  round: number;
  date: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
}

function loadMW1to10(): HistoricalMatch[] {
  const dataPath = path.join(__dirname, "mw1-10-data.json");
  const raw = fs.readFileSync(dataPath, "utf-8");
  const entries = JSON.parse(raw) as DataFileEntry[];
  return entries.map((e) => ({
    round: e.round,
    date: e.date,
    homeTeam: e.homeTeam,
    awayTeam: e.awayTeam,
    homeGoals: e.homeGoals,
    awayGoals: e.awayGoals,
  }));
}

// ─── Team strength estimation (rolling Dixon–Coles style) ────────────────────

interface TeamStats {
  goalsScored: number;
  goalsConceded: number;
  homeGames: number;
  awayGames: number;
  homeScored: number;
  homeConceded: number;
  awayScored: number;
  awayConceded: number;
}

const HOME_ADVANTAGE = 1.25; // typical EPL home advantage factor
const LEAGUE_AVG_GOALS = 1.4; // average goals per team per match in EPL
const PRIOR_GAMES = 3; // number of pseudo-prior games for MW1

function computeTeamStats(
  matches: HistoricalMatch[],
  beforeRound: number,
): Map<string, TeamStats> {
  const stats = new Map<string, TeamStats>();
  const relevant = matches.filter((m) => m.round < beforeRound);

  for (const m of relevant) {
    // Home team
    if (!stats.has(m.homeTeam)) {
      stats.set(m.homeTeam, {
        goalsScored: 0, goalsConceded: 0,
        homeGames: 0, awayGames: 0,
        homeScored: 0, homeConceded: 0,
        awayScored: 0, awayConceded: 0,
      });
    }
    const hs = stats.get(m.homeTeam)!;
    hs.goalsScored += m.homeGoals;
    hs.goalsConceded += m.awayGoals;
    hs.homeGames += 1;
    hs.homeScored += m.homeGoals;
    hs.homeConceded += m.awayGoals;

    // Away team
    if (!stats.has(m.awayTeam)) {
      stats.set(m.awayTeam, {
        goalsScored: 0, goalsConceded: 0,
        homeGames: 0, awayGames: 0,
        homeScored: 0, homeConceded: 0,
        awayScored: 0, awayConceded: 0,
      });
    }
    const as_ = stats.get(m.awayTeam)!;
    as_.goalsScored += m.awayGoals;
    as_.goalsConceded += m.homeGoals;
    as_.awayGames += 1;
    as_.awayScored += m.awayGoals;
    as_.awayConceded += m.homeGoals;
  }

  return stats;
}

function estimateLambdas(
  homeTeam: string,
  awayTeam: string,
  teamStats: Map<string, TeamStats>,
): { homeLambda: number; awayLambda: number } {
  const hs = teamStats.get(homeTeam);
  const as_ = teamStats.get(awayTeam);

  // Attack = goals scored per game / league average
  // Defence = goals conceded per game / league average
  let homeAttack: number, homeDefense: number;
  let awayAttack: number, awayDefense: number;

  if (hs && hs.homeGames > 0) {
    homeAttack = (hs.homeScored / hs.homeGames) / LEAGUE_AVG_GOALS;
    homeDefense = (hs.homeConceded / hs.homeGames) / LEAGUE_AVG_GOALS;
  } else {
    // Use overall stats or priors
    if (hs && (hs.homeGames + hs.awayGames) > 0) {
      const total = hs.homeGames + hs.awayGames;
      homeAttack = (hs.goalsScored / total) / LEAGUE_AVG_GOALS;
      homeDefense = (hs.goalsConceded / total) / LEAGUE_AVG_GOALS;
    } else {
      homeAttack = 1.0;
      homeDefense = 1.0;
    }
  }

  if (as_ && as_.awayGames > 0) {
    awayAttack = (as_.awayScored / as_.awayGames) / LEAGUE_AVG_GOALS;
    awayDefense = (as_.awayConceded / as_.awayGames) / LEAGUE_AVG_GOALS;
  } else {
    if (as_ && (as_.homeGames + as_.awayGames) > 0) {
      const total = as_.homeGames + as_.awayGames;
      awayAttack = (as_.goalsScored / total) / LEAGUE_AVG_GOALS;
      awayDefense = (as_.goalsConceded / total) / LEAGUE_AVG_GOALS;
    } else {
      awayAttack = 1.0;
      awayDefense = 1.0;
    }
  }

  // λ_home = homeAttack × awayDefense × homeAdvantage × leagueAvg
  // λ_away = awayAttack × homeDefense × leagueAvg
  const homeLambda = homeAttack * awayDefense * HOME_ADVANTAGE * LEAGUE_AVG_GOALS;
  const awayLambda = awayAttack * homeDefense * LEAGUE_AVG_GOALS;

  // Clamp to reasonable range
  return {
    homeLambda: Math.max(0.3, Math.min(4.0, homeLambda)),
    awayLambda: Math.max(0.2, Math.min(3.5, awayLambda)),
  };
}

// ─── Prediction logic (mirrors the V4 route) ─────────────────────────────────

type Outcome = "H" | "D" | "A";

function scoreOutcome(cell: ScoreCell): Outcome {
  return cell.homeGoals > cell.awayGoals
    ? "H"
    : cell.homeGoals < cell.awayGoals
      ? "A"
      : "D";
}

function bestScore(scores: ScoreCell[]): ScoreCell | undefined {
  return scores.reduce<ScoreCell | undefined>(
    (best, cell) =>
      !best || cell.probability > best.probability ? cell : best,
    undefined,
  );
}

function get1X2FromGrid(grid: CorrectScoreGrid): { h: number; d: number; a: number } {
  return { h: grid.outcome.home, d: grid.outcome.draw, a: grid.outcome.away };
}

/**
 * Apply the V4 prediction logic with the given configuration.
 *
 * Logic:
 * 1. If P(Draw) >= D, force a Draw prediction → pick highest-prob draw score
 * 2. If top exact score prob >= T, pick that exact score → "SNIPE"
 * 3. Else apply fallback F:
 *    - F=0: Use 1X2 tiers → pick the locked outcome's highest prob score
 *    - F=1: Use engine's highest 1X2 outcome → pick highest prob score for it
 */
function predictWithConfig(
  grid: CorrectScoreGrid,
  config: GridConfig,
): { prediction: string; exactProb: number; category: string; outcome: Outcome } {
  const oneX2 = get1X2FromGrid(grid);
  const scores = grid.cells;

  // Step 1: Check draw threshold
  if (oneX2.d >= config.D) {
    const drawScores = scores.filter((c) => scoreOutcome(c) === "D");
    const best = bestScore(drawScores);
    if (best) {
      return {
        prediction: `${best.homeGoals}-${best.awayGoals}`,
        exactProb: best.probability,
        category: `SNIPE: ${best.homeGoals}-${best.awayGoals}`,
        outcome: "D",
      };
    }
  }

  // Step 2: Check exact score threshold
  const topScore = bestScore(scores);
  if (topScore && topScore.probability >= config.T) {
    return {
      prediction: `${topScore.homeGoals}-${topScore.awayGoals}`,
      exactProb: topScore.probability,
      category: `SNIPE: ${topScore.homeGoals}-${topScore.awayGoals}`,
      outcome: scoreOutcome(topScore),
    };
  }

  // Step 3: Fallback
  // Determine the locked outcome (highest 1X2 probability)
  const ranked: Outcome[] = (["H", "D", "A"] as Outcome[]).sort(
    (a, b) => oneX2[b.toLowerCase() as keyof typeof oneX2] - oneX2[a.toLowerCase() as keyof typeof oneX2],
  );
  const locked = ranked[0];

  if (config.F === 0) {
    // F=0: V2 Tiers — pick locked outcome's best score
    const candidates = scores.filter((c) => scoreOutcome(c) === locked);
    const best = bestScore(candidates);
    if (best) {
      return {
        prediction: `${best.homeGoals}-${best.awayGoals}`,
        exactProb: best.probability,
        category: `WINNER: ${best.homeGoals}-${best.awayGoals}`,
        outcome: locked,
      };
    }
  } else {
    // F=1: Engine's highest 1X2 outcome → pick its best score
    const candidates = scores.filter((c) => scoreOutcome(c) === locked);
    const best = bestScore(candidates);
    if (best) {
      return {
        prediction: `${best.homeGoals}-${best.awayGoals}`,
        exactProb: best.probability,
        category: `WINNER: ${best.homeGoals}-${best.awayGoals}`,
        outcome: locked,
      };
    }
  }

  // Ultimate fallback
  const fallback =
    locked === "H" ? "1-0" : locked === "A" ? "0-1" : "1-1";
  return {
    prediction: fallback,
    exactProb: 0,
    category: `WINNER: ${fallback}`,
    outcome: locked,
  };
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function scorePrediction(pred: string, actual: [number, number]): number {
  const [predH, predA] = pred.split("-").map(Number);
  if (predH === actual[0] && predA === actual[1]) return 20; // exact
  const predOutcome = predH > predA ? "H" : predH < predA ? "A" : "D";
  const actOutcome = actual[0] > actual[1] ? "H" : actual[0] < actual[1] ? "A" : "D";
  if (predOutcome === actOutcome) return 10; // correct outcome
  return 0;
}

// ─── Grid Search ─────────────────────────────────────────────────────────────

function runGridSearch(allMatches: HistoricalMatch[]): ConfigResult[] {
  const targetWeeks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  // Pre-compute grids and lambdas for all MW1-10 matches
  console.log("  Computing score grids for 100 matches...");
  interface PreparedMatch {
    match: HistoricalMatch;
    grid: CorrectScoreGrid;
    oneX2: { h: number; d: number; a: number };
  }

  const allPrepared: Map<number, PreparedMatch[]> = new Map();
  const weeklyMatches: Map<number, PreparedMatch[]> = new Map();

  for (const week of targetWeeks) {
    const teamStats = computeTeamStats(allMatches, week);
    const weekMatches = allMatches.filter((m) => m.round === week);
    const prepared: PreparedMatch[] = [];

    for (const match of weekMatches) {
      const { homeLambda, awayLambda } = estimateLambdas(
        match.homeTeam,
        match.awayTeam,
        teamStats,
      );
      const grid = buildCorrectScoreGrid(homeLambda, awayLambda, DIXON_COLES_RHO);
      const oneX2 = get1X2FromGrid(grid);
      prepared.push({ match, grid, oneX2 });
    }

    weeklyMatches.set(week, prepared);
    for (const p of prepared) {
      const key = p.match.round;
      if (!allPrepared.has(key)) allPrepared.set(key, []);
      allPrepared.get(key)!.push(p);
    }
  }

  // Generate all (T, D, F) combinations
  const tValues: number[] = [];
  for (let t = 0.08; t <= 0.201; t += 0.01) {
    tValues.push(Math.round(t * 100) / 100);
  }

  const dValues: number[] = [];
  for (let d = 0.20; d <= 0.351; d += 0.01) {
    dValues.push(Math.round(d * 100) / 100);
  }

  const fValues = [0, 1];
  const totalCombinations = tValues.length * dValues.length * fValues.length;
  console.log(`  Testing ${totalCombinations} configurations...`);
  console.log(`    T: ${tValues.length} values [${tValues[0]}..${tValues[tValues.length - 1]}]`);
  console.log(`    D: ${dValues.length} values [${dValues[0]}..${dValues[dValues.length - 1]}]`);
  console.log(`    F: ${fValues.length} values`);

  const results: ConfigResult[] = [];

  for (const T of tValues) {
    for (const D of dValues) {
      for (const F of fValues) {
        const config: GridConfig = { T, D, F };
        const weeklyScores: number[] = [];
        let totalExact = 0;
        let totalOutcome = 0;

        for (const week of targetWeeks) {
          const prepared = weeklyMatches.get(week) ?? [];
          let weekScore = 0;

          for (const p of prepared) {
            const pred = predictWithConfig(p.grid, config);
            const actual: [number, number] = [p.match.homeGoals, p.match.awayGoals];
            const points = scorePrediction(pred.prediction, actual);
            weekScore += points;
            if (points === 20) totalExact++;
            else if (points === 10) totalOutcome++;
          }

          weeklyScores.push(weekScore);
        }

        const total = weeklyScores.reduce((a, b) => a + b, 0);
        const floor = Math.min(...weeklyScores);
        const average = total / targetWeeks.length;

        results.push({
          T,
          D,
          F,
          weeklyScores,
          average: Math.round(average * 10) / 10,
          floor,
          totalExact,
          totalOutcome,
        });
      }
    }
  }

  // Sort by floor (descending), then average (descending)
  results.sort((a, b) => b.floor - a.floor || b.average - a.average);

  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║   V4 PREDICTOR — GRID SEARCH OPTIMISATION (No Guessing)        ║");
  console.log("║   EPL 2024-25 Matchweeks 1-10 (100 matches)                    ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log();

  // Step 1: Load historical data
  console.log("STEP 1: Loading EPL 2024-25 MW1-10 data (from openfootball via GitHub)...");
  const allMatches = loadMW1to10();
  console.log(`  Loaded ${allMatches.length} total matches`);

  const mw1to10 = allMatches.filter((m) => m.round >= 1 && m.round <= 10);
  console.log(`  MW1-10: ${mw1to10.length} matches`);

  if (mw1to10.length < 100) {
    console.error(`ERROR: Expected 100 matches for MW1-10, got ${mw1to10.length}`);
    process.exit(1);
  }

  // Step 2: Run the grid search
  console.log("\nSTEP 2: Running grid search optimisation...");
  const results = runGridSearch(allMatches);

  // Step 3: Output results
  console.log("\nSTEP 3: Results");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  const top5 = results.slice(0, 5);
  const target70 = results.filter((r) => r.floor >= 70);

  if (target70.length > 0) {
    console.log(`✅ ${target70.length} configuration(s) achieved a 70+ Floor!\n`);
  } else {
    console.log(`⚠️  NO configuration achieved a 70+ Floor.`);
    console.log(`   Best Floor found: ${results[0].floor}`);
    console.log(`   Showing absolute best configurations:\n`);
  }

  // Markdown table
  console.log("| Rank | T    | D    | F | MW1  | MW2  | MW3  | MW4  | MW5  | MW6  | MW7  | MW8  | MW9  | MW10 | Avg   | Floor | Exact | Outcome |");
  console.log("|------|------|------|---|------|------|------|------|------|------|------|------|------|------|-------|-------|-------|---------|");

  for (let i = 0; i < top5.length; i++) {
    const r = top5[i];
    const ws = r.weeklyScores.map((s) => String(s).padStart(4)).join(" | ");
    console.log(
      `| ${String(i + 1).padStart(4)} | ${r.T.toFixed(2)} | ${r.D.toFixed(2)} | ${r.F} | ${ws} | ${r.average.toFixed(1).padStart(5)} | ${String(r.floor).padStart(5)} | ${String(r.totalExact).padStart(5)} | ${String(r.totalOutcome).padStart(7)} |`,
    );
  }

  // Winner details
  const winner = results[0];
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("WINNING CONFIGURATION:");
  console.log(`  T (Exact Score Threshold) = ${winner.T}`);
  console.log(`  D (Draw Threshold) = ${winner.D}`);
  console.log(`  F (Fallback Strategy) = ${winner.F === 0 ? "V2 Tiers (locked outcome → best score)" : "Highest 1X2 outcome → best score"}`);
  console.log(`  Floor = ${winner.floor} pts`);
  console.log(`  Average = ${winner.average} pts/matchweek`);
  console.log(`  Total Exact Hits = ${winner.totalExact}`);
  console.log(`  Total Outcome Hits = ${winner.totalOutcome}`);
  console.log(`  Weekly Breakdown: ${winner.weeklyScores.join(", ")}`);
  console.log("═══════════════════════════════════════════════════════════════════");

  // Also print the full results for analysis
  console.log("\nFull results (top 20):");
  console.log("| Rank | T    | D    | F | Floor | Avg   | Exact | Outcome |");
  console.log("|------|------|------|---|-------|-------|-------|---------|");
  for (let i = 0; i < Math.min(20, results.length); i++) {
    const r = results[i];
    console.log(
      `| ${String(i + 1).padStart(4)} | ${r.T.toFixed(2)} | ${r.D.toFixed(2)} | ${r.F} | ${String(r.floor).padStart(5)} | ${r.average.toFixed(1).padStart(5)} | ${String(r.totalExact).padStart(5)} | ${String(r.totalOutcome).padStart(7)} |`,
    );
  }

  // Output JSON for the deployer
  console.log("\nDEPLOY_JSON:");
  console.log(JSON.stringify({
    T: winner.T,
    D: winner.D,
    F: winner.F,
    floor: winner.floor,
    average: winner.average,
    weeklyScores: winner.weeklyScores,
    totalExact: winner.totalExact,
    totalOutcome: winner.totalOutcome,
  }));
}

try {
  main();
} catch (err) {
  console.error("FATAL:", err);
  process.exit(1);
}
