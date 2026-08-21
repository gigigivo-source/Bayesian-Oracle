// ĞIGI GIVØ — All-league settlement cron.
//
// Part 2 of the coverage overhaul. In addition to the settlement engine
// (ESPN-based), this job:
//   1. settles EVERY pending tracked item across ALL competitions — including
//      matches sourced from TheSportsDB / OpenLigaDB / API-Football, via the
//      multi-source result lookup;
//   2. refreshes performance_log rows whose stat markets were still pending
//      (boxscore arrives later than the final whistle);
//   3. backfills leagueSlug / competitionName on legacy performance rows so
//      the league dashboard has full transparency across old + new data.
//
// Fail-soft: a broken league or provider never aborts the whole job.

import { db } from "@/db";
import { performanceLog, savedSlips, valueBetLog } from "@/db/schema";
import { and, eq, isNull, gt } from "drizzle-orm";
import { runSettlementEngine } from "@/lib/settlement/engine";
import {
  getPendingSettlementItems,
  settleAccumulator,
  settleDailyPick,
  settleValueBet,
} from "@/db/queries/settlement";
import { evaluateLeg, type MatchResult } from "@/lib/settlement/evaluate";
import {
  fetchEspnBoxscore,
  lookupMultiSourceResult,
} from "../daily-picks/route";
import { evaluateFinishedMatch } from "@/lib/engine";
import { runOracleWithStandings } from "@/lib/engine/oracle";
import { LEAGUE_MAP } from "@/lib/leagues";
import type { FixtureLite } from "@/lib/espn";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const env = (name: string): string => (process.env[name] ?? "").trim();
/** Cap on rows refreshed / settled per run (0 = unlimited, bounded by time). */
const SWEEP_LIMIT = () => {
  const raw = Number(env("CRON_SETTLE_SWEEP_LIMIT"));
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
};

// ─── Fixture reconstruction for performance_log refresh ─────────────────────

function fixtureFromPerformanceRow(row: typeof performanceLog.$inferSelect): FixtureLite | null {
  if (!row.leagueSlug) return null;
  return {
    id:          row.eventId,
    leagueSlug:  row.leagueSlug,
    leagueName:  row.competitionName ?? row.league,
    date:        `${row.matchDate}T00:00:00Z`,
    state:       "post",
    statusDetail: "Match Finished",
    venue:       null,
    neutralSite: false,
    home: {
      id: "", name: row.homeTeam, shortName: row.homeTeam, abbrev: row.homeTeam.slice(0, 3),
      logo: null, color: null, score: String(row.homeScore), homeAway: "home",
    },
    away: {
      id: "", name: row.awayTeam, shortName: row.awayTeam, abbrev: row.awayTeam.slice(0, 3),
      logo: null, color: null, score: String(row.awayScore), homeAway: "away",
    },
    odds: null,
  };
}

// ─── Task 1: refresh performance_log rows with still-pending stat markets ────

async function refreshPendingPerformanceRows(): Promise<number> {
  const rows = await db
    .select()
    .from(performanceLog)
    .where(gt(performanceLog.pending, 0))
    .limit(SWEEP_LIMIT());
  let refreshed = 0;

  for (const row of rows) {
    try {
      const fx = fixtureFromPerformanceRow(row);
      if (!fx) continue;
      const pred = await runOracleWithStandings(fx);
      if (!pred) continue;
      const boxscore = await fetchEspnBoxscore(fx.leagueSlug, fx.id);
      evaluateFinishedMatch(fx, pred, boxscore);

      // Merge fresh outcomes into the stored detail, keeping original fields.
      const fresh = new Map(
        pred.top10.map((m) => [`${m.name}|${m.selection}`, m.outcome ?? "PENDING"]),
      );
      const detail = (row.top10Detail as Array<{ name: string; selection: string; outcome?: string }>)
        .map((p) => ({ ...p, outcome: fresh.get(`${p.name}|${p.selection}`) ?? p.outcome ?? "PENDING" }));

      const hits    = detail.filter((p) => p.outcome === "HIT").length;
      const misses  = detail.filter((p) => p.outcome === "MISS").length;
      const pending = detail.filter((p) => p.outcome === "PENDING" || !p.outcome).length;
      const decided = hits + misses;

      await db.update(performanceLog).set({
        top10Detail: detail,
        hits, misses, pending,
        accuracy: decided > 0 ? hits / decided : row.accuracy,
      }).where(eq(performanceLog.id, row.id));
      refreshed++;
    } catch {
      // best-effort per row
    }
  }
  return refreshed;
}

// ─── Task 2: multi-source settlement of every pending tracked item ───────────

interface SettlePass {
  dailyPicks: number;
  valueBets: number;
  accumulators: number;
  won: number;
  lost: number;
  void: number;
  stillPending: number;
}

async function settlePendingAcrossAllSources(): Promise<SettlePass> {
  const queues = await getPendingSettlementItems({
    accumulators: SWEEP_LIMIT(),
    dailyPicks:   SWEEP_LIMIT(),
    valueBets:    SWEEP_LIMIT(),
  });

  const cache = new Map<string, MatchResult | null>();
  const resolve = async (eventId: string, leagueSlug: string, matchLabel: string, matchDate: string) => {
    const key = `${leagueSlug}|${eventId}`;
    if (!cache.has(key)) {
      cache.set(key, await lookupMultiSourceResult({ eventId, leagueSlug, matchLabel, matchDate }));
    }
    return cache.get(key) ?? null;
  };

  const pass: SettlePass = {
    dailyPicks: 0, valueBets: 0, accumulators: 0, won: 0, lost: 0, void: 0, stillPending: 0,
  };

  // ── Daily picks ─────────────────────────────────────────────────────────────
  for (const row of queues.dailyPicks) {
    try {
      if (!row.eventId || !row.leagueSlug) { pass.stillPending++; continue; }
      const result = await resolve(row.eventId, row.leagueSlug, row.match, row.pickDate);
      if (!result || !Array.isArray(row.picks) || row.picks.length === 0) { pass.stillPending++; continue; }

      const picks = row.picks.map((raw) => {
        const pick = raw as { name?: string; marketName?: string; selection?: string; outcome?: string };
        const outcome = evaluateLeg(
          { marketName: pick.marketName ?? pick.name, selection: pick.selection },
          result,
        );
        const stored = outcome === "won" ? "HIT" : outcome === "lost" ? "MISS" : outcome.toUpperCase();
        return { pick: { ...pick, outcome: stored }, outcome };
      });
      if (picks.some(({ outcome }) => outcome === "pending")) { pass.stillPending++; continue; }

      const hits   = picks.filter(({ outcome }) => outcome === "won").length;
      const misses = picks.filter(({ outcome }) => outcome === "lost").length;
      const voids  = picks.filter(({ outcome }) => outcome === "void").length;
      const changed = await settleDailyPick(row, {
        hits, misses, voids,
        homeScore: result.homeScore,
        awayScore: result.awayScore,
        pickResults: picks.map(({ pick }) => pick),
      });
      if (changed) {
        pass.dailyPicks++;
        if (hits > 0) pass.won++;
        if (misses > 0) pass.lost++;
        if (voids > 0) pass.void++;
      }
    } catch {
      pass.stillPending++;
    }
  }

  // ── Value bets ──────────────────────────────────────────────────────────────
  for (const row of queues.valueBets) {
    try {
      const result = await resolve(row.eventId, row.leagueSlug, row.match, row.matchDate);
      if (!result) { pass.stillPending++; continue; }
      const outcome = evaluateLeg({ marketName: row.marketName, selection: row.selection }, result);
      if (outcome === "pending") { pass.stillPending++; continue; }
      const actualReturn = outcome === "won" ? row.stake * row.bookOdds : outcome === "void" ? row.stake : 0;
      const changed = await settleValueBet(row, { outcome, actualReturn, pnl: actualReturn - row.stake });
      if (changed) {
        pass.valueBets++;
        if (outcome === "won") pass.won++; else if (outcome === "lost") pass.lost++; else pass.void++;
      }
    } catch {
      pass.stillPending++;
    }
  }

  // ── Accumulator slips ───────────────────────────────────────────────────────
  for (const slip of queues.accumulators) {
    try {
      if (!Array.isArray(slip.picks) || slip.picks.length === 0) { pass.stillPending++; continue; }
      interface Leg { fixtureId?: string; leagueSlug?: string; matchLabel?: string; date?: string; marketName?: string; selection?: string }
      const legs = slip.picks as Leg[];

      let allSettled = true;
      let allHit     = true;
      const evaluated: Array<{ outcome: string }> = [];

      for (const leg of legs) {
        if (!leg?.fixtureId || !leg?.leagueSlug) { allSettled = false; continue; }
        const result = await resolve(leg.fixtureId, leg.leagueSlug, leg.matchLabel ?? "", leg.date ?? "");
        if (!result) { allSettled = false; continue; }
        const outcome = evaluateLeg({ marketName: leg.marketName, selection: leg.selection }, result);
        evaluated.push({ outcome });
        if (outcome === "pending") allSettled = false;
        if (outcome === "lost") allHit = false;
      }
      if (!allSettled || evaluated.length !== legs.length) { pass.stillPending++; continue; }

      const wonLegs  = evaluated.filter((l) => l.outcome === "won").length;
      const lostLegs = evaluated.filter((l) => l.outcome === "lost").length;
      const voidLegs = evaluated.filter((l) => l.outcome === "void").length;
      const stake = slip.stake ?? 0;
      const status = allHit ? "won" as const : "lost" as const;
      const returnAmount = status === "won" ? stake * slip.combinedOdds : 0;
      const changed = await settleAccumulator(slip, {
        status, wonLegs, lostLegs, voidLegs,
        returnAmount, pnl: returnAmount - stake,
        legResults: legs,
      });
      if (changed) {
        pass.accumulators++;
        if (status === "won") pass.won++; else pass.lost++;
      }
    } catch {
      pass.stillPending++;
    }
  }

  return pass;
}

// ─── Task 3: legacy leagueSlug / competitionName backfill ────────────────────

async function backfillLegacyLeagueFields(): Promise<{
  performanceRows: number;
  valueBetRows: number;
  slipRows: number;
}> {
  let performanceRows = 0;
  let valueBetRows = 0;
  let slipRows = 0;

  // performance_log — competitionName from slug (or stored league name).
  const perfSlugs = await db
    .selectDistinct({ leagueSlug: performanceLog.leagueSlug, league: performanceLog.league })
    .from(performanceLog)
    .where(isNull(performanceLog.competitionName));
  for (const row of perfSlugs) {
    const name = LEAGUE_MAP[row.leagueSlug ?? ""]?.name ?? row.league ?? "Unknown Competition";
    const cond = row.leagueSlug
      ? and(eq(performanceLog.leagueSlug, row.leagueSlug), isNull(performanceLog.competitionName))
      : and(isNull(performanceLog.leagueSlug), isNull(performanceLog.competitionName));
    const updated = await db.update(performanceLog).set({ competitionName: name }).where(cond);
    performanceRows += updated.rowCount ?? 0;
  }

  // value_bet_log — competitionName from slug.
  const vbSlugs = await db
    .selectDistinct({ leagueSlug: valueBetLog.leagueSlug })
    .from(valueBetLog)
    .where(isNull(valueBetLog.competitionName));
  for (const row of vbSlugs) {
    const name = LEAGUE_MAP[row.leagueSlug]?.name ?? row.leagueSlug;
    const updated = await db.update(valueBetLog).set({ competitionName: name })
      .where(and(eq(valueBetLog.leagueSlug, row.leagueSlug), isNull(valueBetLog.competitionName)));
    valueBetRows += updated.rowCount ?? 0;
  }

  // saved_slips — leagueSlug + competitionName from the first leg when available.
  const slips = await db
    .select()
    .from(savedSlips)
    .where(isNull(savedSlips.leagueSlug))
    .limit(200);
  for (const slip of slips) {
    const legs = Array.isArray(slip.picks) ? (slip.picks as Array<{ leagueSlug?: string }>) : [];
    const slug = legs[0]?.leagueSlug ?? null;
    if (!slug) continue;
    const updated = await db.update(savedSlips).set({
      leagueSlug: slug,
      competitionName: LEAGUE_MAP[slug]?.name ?? slug,
    }).where(eq(savedSlips.id, slip.id));
    slipRows += updated.rowCount ?? 0;
  }

  return { performanceRows, valueBetRows, slipRows };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export interface SettleSweepSummary {
  ok: boolean;
  engine: Awaited<ReturnType<typeof runSettlementEngine>> | null;
  multiSource: SettlePass;
  refreshedPerformanceRows: number;
  legacyBackfill: { performanceRows: number; valueBetRows: number; slipRows: number };
  failures: string[];
  ranAt: string;
}

async function runAllLeagueSettlement(): Promise<SettleSweepSummary> {
  const failures: string[] = [];

  // 1) The existing settlement engine (accumulators / daily picks / value bets via ESPN).
  let engine: Awaited<ReturnType<typeof runSettlementEngine>> | null = null;
  try {
    engine = await runSettlementEngine();
  } catch (err) {
    failures.push(`settlement engine: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2) Multi-source pass — everything still pending across ALL competitions.
  let multiSource: SettlePass = {
    dailyPicks: 0, valueBets: 0, accumulators: 0, won: 0, lost: 0, void: 0, stillPending: 0,
  };
  try {
    multiSource = await settlePendingAcrossAllSources();
  } catch (err) {
    failures.push(`multi-source settlement: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3) Refresh performance rows with late-arriving boxscores.
  let refreshedPerformanceRows = 0;
  try {
    refreshedPerformanceRows = await refreshPendingPerformanceRows();
  } catch (err) {
    failures.push(`performance refresh: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4) Legacy league field backfill.
  let legacyBackfill = { performanceRows: 0, valueBetRows: 0, slipRows: 0 };
  try {
    legacyBackfill = await backfillLegacyLeagueFields();
  } catch (err) {
    failures.push(`legacy backfill: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(
    `[Cron][settle] engine settled ${engine?.settled.total ?? 0} · multi-source settled ` +
    `${multiSource.dailyPicks + multiSource.valueBets + multiSource.accumulators} ` +
    `(${multiSource.stillPending} still pending) · refreshed ${refreshedPerformanceRows} performance rows · ` +
    `legacy backfill ${legacyBackfill.performanceRows + legacyBackfill.valueBetRows + legacyBackfill.slipRows} rows`,
  );

  return { ok: true, engine, multiSource, refreshedPerformanceRows, legacyBackfill, failures, ranAt: new Date().toISOString() };
}

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    new URL(req.url).searchParams.get("key");
  return provided === secret;
}

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return Response.json(await runAllLeagueSettlement());
  } catch (error) {
    console.error("[Cron][settle] failed:", error);
    return Response.json({ error: "Settlement failed" }, { status: 500 });
  }
}

export const POST = GET;
