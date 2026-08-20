import { db } from "@/db";
import {
  accumulatorPerformance, dailyPickPerformance, dailyPicks, savedSlips,
  valueBetLog, valueBetPerformance,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";

export type PendingAccumulator = typeof savedSlips.$inferSelect;
export type PendingDailyPick = typeof dailyPicks.$inferSelect;
export type PendingValueBet = typeof valueBetLog.$inferSelect;

export interface AccumulatorSettlement {
  status: "won" | "lost"; wonLegs: number; lostLegs: number; voidLegs: number;
  returnAmount: number; pnl: number; legResults: unknown;
}
export interface DailyPickSettlement {
  hits: number; misses: number; voids: number; homeScore: number; awayScore: number; pickResults: unknown;
}
export interface ValueBetSettlement {
  outcome: "won" | "lost" | "void"; actualReturn: number; pnl: number;
}

/** Read all queues once so result requests can be batched. */
export async function getPendingSettlementItems(limits = { accumulators: 50, dailyPicks: 100, valueBets: 100 }) {
  const [accumulators, picks, valueBets] = await Promise.all([
    db.select().from(savedSlips).where(eq(savedSlips.status, "pending")).limit(limits.accumulators),
    db.select().from(dailyPicks).where(eq(dailyPicks.status, "pending")).limit(limits.dailyPicks),
    db.select().from(valueBetLog).where(eq(valueBetLog.outcome, "pending")).limit(limits.valueBets),
  ]);
  return { accumulators, dailyPicks: picks, valueBets };
}

export async function settleAccumulator(slip: PendingAccumulator, value: AccumulatorSettlement): Promise<boolean> {
  return db.transaction(async (tx) => {
    const changed = await tx.update(savedSlips).set({ status: value.status })
      .where(and(eq(savedSlips.id, slip.id), eq(savedSlips.status, "pending")))
      .returning({ id: savedSlips.id });
    if (!changed[0]) return false;
    await tx.insert(accumulatorPerformance).values({
      slipId: slip.id, name: slip.name, slipType: slip.slipType,
      totalLegs: Array.isArray(slip.picks) ? slip.picks.length : 0,
      wonLegs: value.wonLegs, lostLegs: value.lostLegs, voidLegs: value.voidLegs,
      combinedOdds: slip.combinedOdds, stake: slip.stake ?? 0, status: value.status,
      returnAmount: value.returnAmount, pnl: value.pnl, legResults: value.legResults,
    }).onConflictDoNothing({ target: accumulatorPerformance.slipId });
    return true;
  });
}

export async function settleDailyPick(row: PendingDailyPick, value: DailyPickSettlement): Promise<boolean> {
  return db.transaction(async (tx) => {
    const changed = await tx.update(dailyPicks).set({
      picks: value.pickResults, hits: value.hits, misses: value.misses, pending: 0, status: "settled",
    }).where(and(eq(dailyPicks.id, row.id), eq(dailyPicks.status, "pending")))
      .returning({ id: dailyPicks.id });
    if (!changed[0]) return false;
    const decided = value.hits + value.misses;
    await tx.insert(dailyPickPerformance).values({
      dailyPickId: row.id, pickDate: row.pickDate, eventId: row.eventId, match: row.match,
      league: row.league, totalPicks: Array.isArray(row.picks) ? row.picks.length : 0,
      hits: value.hits, misses: value.misses, voids: value.voids,
      accuracy: decided ? value.hits / decided : 0,
      homeScore: value.homeScore, awayScore: value.awayScore, pickResults: value.pickResults,
    }).onConflictDoNothing({ target: dailyPickPerformance.dailyPickId });
    return true;
  });
}

export async function settleValueBet(row: PendingValueBet, value: ValueBetSettlement): Promise<boolean> {
  return db.transaction(async (tx) => {
    const changed = await tx.update(valueBetLog).set(value)
      .where(and(eq(valueBetLog.id, row.id), eq(valueBetLog.outcome, "pending")))
      .returning({ id: valueBetLog.id });
    if (!changed[0]) return false;
    await tx.insert(valueBetPerformance).values({
      valueBetId: row.id, eventId: row.eventId, match: row.match, marketName: row.marketName,
      selection: row.selection, oracleProb: row.oracleProb, bookOdds: row.bookOdds,
      valueEdge: row.valueEdge, stake: row.stake, outcome: value.outcome,
      actualReturn: value.actualReturn, pnl: value.pnl,
    }).onConflictDoNothing({ target: valueBetPerformance.valueBetId });
    return true;
  });
}

export const getPendingItems = getPendingSettlementItems;
