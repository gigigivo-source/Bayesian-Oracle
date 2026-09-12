// ĞIGI GIVØ — Settlement engine.
//
// Settles pending accumulator slips, daily picks and value bets from real
// final scores (ESPN scoreboard feed) + the FULL multi-source boxscore for
// every finished match (see ./results — ESPN boxscore endpoint + SportScore →
// API-Football /fixtures/statistics → StatsBomb → FBref → TheSportsDB →
// Understat → … all registered sources, first-wins merged, memo-cached so
// repeated runs don't re-fetch). Markets are resolved against real data only:
//   · score-backed markets settle immediately on the final score;
//   · stat-backed markets (corners/cards/shots/throw-ins/offside/saves…)
//     settle as soon as any source supplies the stat;
//   · while the match is younger than the 24h stats-void grace a missing stat
//     keeps the market PENDING (late boxscores can still arrive);
//   · once the grace has elapsed a market no source can resolve is VOID —
//     stake returned, never guessed and never left pending forever.
// Logging is per MARKET (one line per match listing every market's status)
// plus a per-run summary — see [Settle] lines.

import {
  getPendingSettlementItems, settleAccumulator, settleDailyPick, settleValueBet,
  type PendingAccumulator, type PendingDailyPick, type PendingValueBet,
} from "@/db/queries/settlement";
import {
  evaluateLegDetailed,
  statsGraceElapsed,
  type LegEvaluation,
  type MatchResult,
} from "./evaluate";
import { fetchSettlementResults, getSettlementBoxscore, prefetchBoxscores, type ResultsProvider } from "./results";
import type { CanonicalMatchStats } from "@/lib/data/types";

interface StoredLeg {
  fixtureId?: string; eventId?: string; matchLabel?: string; match?: string;
  marketName?: string; name?: string; selection?: string; outcome?: string;
}

/** Human status label per market — WIN | LOSS | PUSH | VOID (no stats) | PENDING. */
export function settlementStatusLabel(evaluation: LegEvaluation): string {
  switch (evaluation.outcome) {
    case "won": return "WIN";
    case "lost": return "LOSS";
    case "void": return evaluation.push ? "PUSH" : "VOID (no stats)";
    default: return "PENDING";
  }
}

/** Counters over every MARKET (not row) touched by a settlement run. */
export interface MarketTally {
  resolved: number; win: number; loss: number; push: number; void: number; pending: number;
}

function emptyTally(): MarketTally {
  return { resolved: 0, win: 0, loss: 0, push: 0, void: 0, pending: 0 };
}

function recordTally(tally: MarketTally, evaluation: LegEvaluation): void {
  if (evaluation.outcome === "won") { tally.win++; tally.resolved++; }
  else if (evaluation.outcome === "lost") { tally.loss++; tally.resolved++; }
  else if (evaluation.outcome === "void") {
    if (evaluation.push) tally.push++; else tally.void++;
    tally.resolved++;
  } else tally.pending++;
}

export interface SettlementSummary {
  checked: { accumulators: number; dailyPicks: number; valueBets: number };
  settled: { accumulators: number; dailyPicks: number; valueBets: number; total: number };
  won: number; lost: number; void: number; stillPending: number; ranAt: string;
  /** Distinct finished matches whose markets this run evaluated. */
  matches: number;
  /** Per-market outcome tally across all queues. */
  markets: MarketTally;
  /** Pending markets on matches past the 24h grace (escalation keeps this 0). */
  stuckPending: number;
}

/**
 * Resolve the canonical boxscore for a stored leg: memo cache first, then the
 * aggregator's shared cache (filled ahead of time by the daily-picks cron),
 * then the full multi-source walk. Null when no source has the stats — stat
 * legs then stay pending until the 24h grace elapses and void (never guessed).
 */
async function statsForLeg(result: MatchResult | undefined): Promise<CanonicalMatchStats | null> {
  if (!result) return null;
  return (await getSettlementBoxscore(result)).stats;
}

interface EvaluatedLeg extends StoredLeg {
  evaluation: LegEvaluation;
  result?: MatchResult;
}

async function evaluateStoredLeg(leg: StoredLeg, results: ResultsProvider): Promise<EvaluatedLeg> {
  const result = results.find(leg.fixtureId ?? leg.eventId, leg.matchLabel ?? leg.match);
  const stats = await statsForLeg(result);
  const evaluation = result
    ? evaluateLegDetailed({ marketName: leg.marketName ?? leg.name, selection: leg.selection }, result, stats)
    : { outcome: "pending" as const, push: false };
  return { ...leg, evaluation, result };
}

function legMarketLabel(leg: StoredLeg): string {
  return (leg.marketName ?? leg.name ?? "Unknown market").trim();
}

/** `[Settle] Arsenal vs Chelsea — Match Winner: WIN, Total Corners O/U: VOID (no stats), …` */
function logMatchMarkets(matchLabel: string, parts: string[]): void {
  if (parts.length === 0) return;
  console.log(`[Settle] ${matchLabel} — ${parts.join(", ")}`);
}

async function processAccumulator(
  slip: PendingAccumulator,
  results: ResultsProvider,
  tally: MarketTally,
  matches: Set<string>,
): Promise<"won" | "lost" | null> {
  if (!Array.isArray(slip.picks) || slip.picks.length === 0) return null;
  const legs = await Promise.all(slip.picks.map((leg) => evaluateStoredLeg(leg as StoredLeg, results)));
  const outcomes = legs.map((leg) => leg.evaluation.outcome);
  for (const leg of legs) {
    recordTally(tally, leg.evaluation);
    if (leg.result && leg.evaluation.outcome !== "pending") matches.add(`${leg.result.leagueSlug}|${leg.result.eventId}`);
  }
  logMatchMarkets(
    `Slip ${slip.name ? `"${slip.name}"` : `#${slip.id}`}`,
    legs.map((leg) => `${leg.matchLabel ?? leg.match ?? legMarketLabel(leg)} · ${legMarketLabel(leg)}: ${settlementStatusLabel(leg.evaluation)}`),
  );
  const hasLoss = outcomes.includes("lost");
  const resolved = outcomes.every((outcome) => outcome !== "pending");
  // A losing leg makes an accumulator irreversibly lost. A winning slip waits
  // until every leg is final.
  if (!hasLoss && !resolved) return null;

  const status = hasLoss ? "lost" : "won";
  const stake = slip.stake ?? 0;
  const returnAmount = status === "won" ? stake * slip.combinedOdds : 0;
  const changed = await settleAccumulator(slip, {
    status,
    wonLegs: outcomes.filter((x) => x === "won").length,
    lostLegs: outcomes.filter((x) => x === "lost").length,
    voidLegs: outcomes.filter((x) => x === "void").length,
    returnAmount,
    pnl: returnAmount - stake,
    legResults: legs.map(({ result: _result, evaluation, ...leg }) => ({
      ...leg,
      outcome: evaluation.outcome,
      finalScore: _result ? `${_result.homeScore}-${_result.awayScore}` : undefined,
    })),
  });
  return changed ? status : null;
}

async function processDailyPick(
  row: PendingDailyPick,
  results: ResultsProvider,
  tally: MarketTally,
  matches: Set<string>,
): Promise<boolean> {
  const result = results.find(row.eventId, row.match);
  if (!result || !Array.isArray(row.picks) || row.picks.length === 0) return false;
  const stats = await statsForLeg(result);
  const evaluated = row.picks.map((raw) => {
    const pick = raw as StoredLeg;
    const evaluation = evaluateLegDetailed(
      { marketName: pick.marketName ?? pick.name, selection: pick.selection },
      result,
      stats,
    );
    recordTally(tally, evaluation);
    const storedOutcome =
      evaluation.outcome === "won" ? "HIT" :
      evaluation.outcome === "lost" ? "MISS" :
      evaluation.push ? "PUSH" : evaluation.outcome.toUpperCase();
    return { pick: { ...pick, outcome: storedOutcome }, evaluation };
  });
  const outcomes = evaluated.map(({ evaluation }) => evaluation.outcome);
  matches.add(`${result.leagueSlug}|${result.eventId}`);
  logMatchMarkets(
    `${result.homeName} vs ${result.awayName}`,
    evaluated.map(({ pick, evaluation }) => `${legMarketLabel(pick)}: ${settlementStatusLabel(evaluation)}`),
  );
  if (outcomes.includes("pending")) return false;
  return settleDailyPick(row, {
    hits: outcomes.filter((x) => x === "won").length,
    misses: outcomes.filter((x) => x === "lost").length,
    voids: outcomes.filter((x) => x === "void").length,
    homeScore: result.homeScore, awayScore: result.awayScore, pickResults: evaluated.map(({ pick }) => pick),
  });
}

async function processValueBet(
  row: PendingValueBet,
  results: ResultsProvider,
  tally: MarketTally,
  matches: Set<string>,
): Promise<LegEvaluation | null> {
  const result = results.find(row.eventId, row.match);
  if (!result) return null;
  const stats = await statsForLeg(result);
  const evaluation = evaluateLegDetailed({ marketName: row.marketName, selection: row.selection }, result, stats);
  recordTally(tally, evaluation);
  logMatchMarkets(`${result.homeName} vs ${result.awayName}`, [
    `${row.marketName ?? "Unknown market"}: ${settlementStatusLabel(evaluation)}`,
  ]);
  // (pending → returns null; the caller decides awaiting-vs-stuck below)
  if (evaluation.outcome === "pending") return null;
  matches.add(`${result.leagueSlug}|${result.eventId}`);
  // The value-bet ledger stores the refundable outcome as "void" whether it is
  // a line-push or a data-void (both return the stake); PUSH vs VOID shows in
  // the [Settle] log above and the per-run tally.
  const dbOutcome = evaluation.outcome === "won" ? "won" : evaluation.outcome === "lost" ? "lost" : "void";
  const actualReturn = dbOutcome === "won" ? row.stake * row.bookOdds : dbOutcome === "void" ? row.stake : 0;
  const changed = await settleValueBet(row, { outcome: dbOutcome, actualReturn, pnl: actualReturn - row.stake });
  return changed ? evaluation : null;
}

export async function runSettlementEngine(): Promise<SettlementSummary> {
  const queues = await getPendingSettlementItems();
  const results = await fetchSettlementResults(queues);
  // Result-provenance line: how many finished matches the result pass indexed
  // and which source answered for them (the per-match [Settle] lines from
  // ./results name the league slug + endpoint used for each one).
  const sources = results.sourceCounts();
  const pendingItems = queues.accumulators.length + queues.dailyPicks.length + queues.valueBets.length;
  console.log(
    `[Settle] ${pendingItems} pending item(s) against ${results.all().length} finished match(es) ` +
    `(ESPN summary ${sources.espnSummary}, scoreboard ${sources.scoreboard})`,
  );
  // Rows whose match no source could resolve are the reason a sweep reports
  // "0 matches" — name them so the next run is diagnosable at a glance.
  const pendingRefs: Array<{ label: string; eventId?: string | null }> = [
    ...queues.dailyPicks.map((row) => ({ label: row.match, eventId: row.eventId })),
    ...queues.valueBets.map((row) => ({ label: row.match, eventId: row.eventId })),
    ...queues.accumulators.flatMap((slip) => Array.isArray(slip.picks)
      ? (slip.picks as StoredLeg[]).map((leg) => ({
          label: leg.matchLabel ?? leg.match ?? `slip #${slip.id}`,
          eventId: leg.fixtureId ?? leg.eventId,
        }))
      : []),
  ];
  const unresolved = pendingRefs.filter((ref) => !results.find(ref.eventId, ref.label));
  if (unresolved.length > 0) {
    const shown = unresolved.slice(0, 10).map((ref) => `${ref.label} (event ${ref.eventId ?? "?"})`);
    console.log(
      `[Settle] No finished result yet for ${unresolved.length} pending match(es): ` +
      `${shown.join("; ")}${unresolved.length > shown.length ? " …" : ""}`,
    );
  }
  // Fetch the full boxscore for every finished match up-front (memo-cached,
  // bounded concurrency) so per-leg evaluation below is a cache read.
  await prefetchBoxscores(results.all());

  const tally = emptyTally();
  const matches = new Set<string>();
  let accumulators = 0, dailyPicks = 0, valueBets = 0, won = 0, lost = 0, voidCount = 0;
  let stuckPending = 0;

  for (const slip of queues.accumulators) {
    const outcome = await processAccumulator(slip, results, tally, matches);
    if (outcome) { accumulators++; outcome === "won" ? won++ : lost++; }
  }
  for (const row of queues.dailyPicks) if (await processDailyPick(row, results, tally, matches)) dailyPicks++;
  for (const row of queues.valueBets) {
    const evaluation = await processValueBet(row, results, tally, matches);
    if (!evaluation) {
      // Defensive: evaluateLegDetailed escalates finished-match pendings to
      // VOID once the grace window elapses, so a pending on a match past the
      // grace should be impossible — count any occurrence (regression alarm,
      // expected value: 0 stuck).
      const result = results.find(row.eventId, row.match);
      if (result && statsGraceElapsed(result)) stuckPending++;
      continue;
    }
    valueBets++;
    if (evaluation.outcome === "won") won++;
    else if (evaluation.outcome === "lost") lost++;
    else voidCount++;
  }

  const total = accumulators + dailyPicks + valueBets;
  const checkedTotal = queues.accumulators.length + queues.dailyPicks.length + queues.valueBets.length;
  const summary: SettlementSummary = {
    checked: { accumulators: queues.accumulators.length, dailyPicks: queues.dailyPicks.length, valueBets: queues.valueBets.length },
    settled: { accumulators, dailyPicks, valueBets, total },
    won, lost, void: voidCount, stillPending: checkedTotal - total, ranAt: new Date().toISOString(),
    matches: matches.size,
    markets: tally,
    stuckPending,
  };
  // The cron sweep prints the aggregated "[Settle] Run complete" line for the
  // whole job; this is the engine pass' own contribution.
  console.log(
    `[Settle] Engine pass: ${summary.matches} matches, ${tally.resolved} markets resolved ` +
    `(WIN ${tally.win}, LOSS ${tally.loss}, PUSH ${tally.push}, VOID ${tally.void}), ${stuckPending} stuck pending`,
  );
  return summary;
}

export const settlePending = runSettlementEngine;
