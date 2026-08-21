import {
  getPendingSettlementItems, settleAccumulator, settleDailyPick, settleValueBet,
  type PendingAccumulator, type PendingDailyPick, type PendingValueBet,
} from "@/db/queries/settlement";
import { evaluateLeg, type LegOutcome, type MatchResult } from "./evaluate";
import { fetchSettlementResults, type ResultsProvider } from "./results";
import { statsAggregator } from "@/lib/data/aggregator";
import type { CanonicalMatchStats } from "@/lib/data/types";

interface StoredLeg {
  fixtureId?: string; eventId?: string; matchLabel?: string; match?: string;
  marketName?: string; name?: string; selection?: string; outcome?: string;
}

export interface SettlementSummary {
  checked: { accumulators: number; dailyPicks: number; valueBets: number };
  settled: { accumulators: number; dailyPicks: number; valueBets: number; total: number };
  won: number; lost: number; void: number; stillPending: number; ranAt: string;
}

/**
 * Resolve the canonical stats for a stored leg: cache-first (filled ahead of
 * time by the daily-picks cron), then a fail-soft aggregator fetch. Null when
 * no stats are obtainable — stat legs then stay pending (never guessed).
 */
async function statsForLeg(
  leg: { fixtureId?: string | null; eventId?: string | null; leagueSlug?: string | null },
  result: MatchResult | undefined,
): Promise<CanonicalMatchStats | null> {
  const eventId = leg.fixtureId ?? leg.eventId;
  if (!result || !eventId) return null;
  const query = {
    leagueSlug: leg.leagueSlug ?? result.leagueSlug,
    eventId,
    homeTeam: result.homeName,
    awayTeam: result.awayName,
    date: result.date,
  };
  return statsAggregator.peek(query) ?? statsAggregator.fetch(query);
}

async function evaluateStoredLeg(leg: StoredLeg, results: ResultsProvider) {
  const result = results.find(leg.fixtureId ?? leg.eventId, leg.matchLabel ?? leg.match);
  const stats = result ? await statsForLeg(leg, result) : null;
  const outcome = result
    ? evaluateLeg({ marketName: leg.marketName ?? leg.name, selection: leg.selection }, result, stats)
    : "pending";
  return { ...leg, outcome, result };
}

async function processAccumulator(slip: PendingAccumulator, results: ResultsProvider): Promise<"won" | "lost" | null> {
  if (!Array.isArray(slip.picks) || slip.picks.length === 0) return null;
  const legs = await Promise.all(slip.picks.map((leg) => evaluateStoredLeg(leg as StoredLeg, results)));
  const outcomes = legs.map((leg) => leg.outcome);
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
    legResults: legs.map(({ result, ...leg }) => ({
      ...leg,
      finalScore: result ? `${result.homeScore}-${result.awayScore}` : undefined,
    })),
  });
  return changed ? status : null;
}

async function processDailyPick(row: PendingDailyPick, results: ResultsProvider): Promise<boolean> {
  const result = results.find(row.eventId, row.match);
  if (!result || !Array.isArray(row.picks) || row.picks.length === 0) return false;
  const stats = await statsForLeg({ eventId: row.eventId, leagueSlug: row.leagueSlug }, result);
  const evaluated = row.picks.map((raw) => {
    const pick = raw as StoredLeg;
    const outcome = evaluateLeg({ marketName: pick.marketName ?? pick.name, selection: pick.selection }, result, stats);
    const storedOutcome = outcome === "won" ? "HIT" : outcome === "lost" ? "MISS" : outcome.toUpperCase();
    return { pick: { ...pick, outcome: storedOutcome }, outcome };
  });
  const picks = evaluated.map(({ pick }) => pick);
  const outcomes = evaluated.map(({ outcome }) => outcome);
  if (outcomes.includes("pending")) return false;
  return settleDailyPick(row, {
    hits: outcomes.filter((x) => x === "won").length,
    misses: outcomes.filter((x) => x === "lost").length,
    voids: outcomes.filter((x) => x === "void").length,
    homeScore: result.homeScore, awayScore: result.awayScore, pickResults: picks,
  });
}

async function processValueBet(row: PendingValueBet, results: ResultsProvider): Promise<LegOutcome | null> {
  const result = results.find(row.eventId, row.match);
  if (!result) return null;
  const stats = await statsForLeg({ eventId: row.eventId, leagueSlug: row.leagueSlug }, result);
  const outcome = evaluateLeg({ marketName: row.marketName, selection: row.selection }, result, stats);
  if (outcome === "pending") return null;
  const actualReturn = outcome === "won" ? row.stake * row.bookOdds : outcome === "void" ? row.stake : 0;
  const changed = await settleValueBet(row, { outcome, actualReturn, pnl: actualReturn - row.stake });
  return changed ? outcome : null;
}

export async function runSettlementEngine(): Promise<SettlementSummary> {
  const queues = await getPendingSettlementItems();
  const results = await fetchSettlementResults(queues);
  let accumulators = 0, dailyPicks = 0, valueBets = 0, won = 0, lost = 0, voidCount = 0;

  for (const slip of queues.accumulators) {
    const outcome = await processAccumulator(slip, results);
    if (outcome) { accumulators++; outcome === "won" ? won++ : lost++; }
  }
  for (const row of queues.dailyPicks) if (await processDailyPick(row, results)) dailyPicks++;
  for (const row of queues.valueBets) {
    const outcome = await processValueBet(row, results);
    if (!outcome) continue;
    valueBets++;
    if (outcome === "won") won++; else if (outcome === "lost") lost++; else voidCount++;
  }

  const total = accumulators + dailyPicks + valueBets;
  const checkedTotal = queues.accumulators.length + queues.dailyPicks.length + queues.valueBets.length;
  return {
    checked: { accumulators: queues.accumulators.length, dailyPicks: queues.dailyPicks.length, valueBets: queues.valueBets.length },
    settled: { accumulators, dailyPicks, valueBets, total },
    won, lost, void: voidCount, stillPending: checkedTotal - total, ranAt: new Date().toISOString(),
  };
}

export const settlePending = runSettlementEngine;
