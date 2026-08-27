// ĞIGI GIVØ — All-league settlement cron.
//
// In addition to the settlement engine (ESPN-based), this job:
//   1. settles EVERY pending tracked item across ALL competitions — including
//      matches sourced from TheSportsDB / OpenLigaDB / API-Football, via the
//      live fixture-feed catalogue plus the multi-source result lookup;
//   2. settles feature picks (performance_log.feature: 'corners' / 'first5')
//      using the real match stats from the multi-source stats aggregator;
//   3. refreshes performance_log rows whose stat markets were still pending
//      (boxscore arrives later than the final whistle);
//   4. backfills leagueSlug / competitionName on legacy performance rows so
//      the league dashboard has full transparency across old + new data.
//
// POST /api/cron/settle?force=true manually runs an immediate uncapped sweep.
// Fail-soft: a broken league or provider never aborts the whole job.

import { db } from "@/db";
import { dailyPicks, performanceLog, savedSlips, valueBetLog } from "@/db/schema";
import { and, count, eq, isNull, isNotNull, gt } from "drizzle-orm";
import { runSettlementEngine } from "@/lib/settlement/engine";
import {
  getPendingSettlementItems,
  settleAccumulator,
  settleDailyPick,
  settleValueBet,
} from "@/db/queries/settlement";
import { evaluateLeg, type MatchResult } from "@/lib/settlement/evaluate";
import { resolveSureCornerOutcome } from "@/lib/settlement/sureCornerOutcomes";
import type { CanonicalMatchStats, TeamStats } from "@/lib/data/types";
import {
  fetchEspnBoxscore,
  lookupMultiSourceResult,
  resultFromFixture,
  statsToBoxscore,
} from "../daily-picks/route";
import { GET as fixturesGET } from "@/app/api/fixtures/route";
import { statsAggregator } from "@/lib/data/aggregator";
import { canonicalLeagueSlug } from "@/lib/leaguePriority";
import { evaluateFinishedMatch } from "@/lib/engine";
import { runOracleWithStandings } from "@/lib/engine/oracle";
import type { RankingMode } from "@/lib/engine/selector";
import { LEAGUE_MAP } from "@/lib/leagues";
import type { FixtureLite } from "@/lib/espn";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const env = (name: string): string => (process.env[name] ?? "").trim();
/** Optional cap; by default every pending row is swept (bounded by maxDuration). */
const SWEEP_LIMIT = (force = false) => {
  if (force) return 100_000;
  const raw = Number(env("CRON_SETTLE_SWEEP_LIMIT"));
  return Number.isFinite(raw) && raw > 0 ? raw : 100_000;
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

async function refreshPendingPerformanceRows(force = false): Promise<number> {
  const rows = await db
    .select()
    .from(performanceLog)
    .where(gt(performanceLog.pending, 0))
    .limit(SWEEP_LIMIT(force));
  let refreshed = 0;
  const resolvedByLeague: Record<string, number> = {};

  for (const row of rows) {
    try {
      const fx = fixtureFromPerformanceRow(row);
      if (!fx) continue;
      const rankingMode = (row.rankingMode as RankingMode) || "B";
      const pred = await runOracleWithStandings(fx, { rankingMode });
      if (!pred) continue;
      const boxscore =
        (await fetchEspnBoxscore(fx.leagueSlug, fx.id)) ??
        statsToBoxscore(
          await statsAggregator
            .fetch({
              leagueSlug: fx.leagueSlug,
              eventId: fx.id,
              homeTeam: fx.home.name,
              awayTeam: fx.away.name,
              date: fx.date,
            })
            .catch(() => null),
        );
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
      const resolved = Math.max(0, row.pending - pending);
      refreshed += resolved;
      if (resolved > 0) {
        const label = LEAGUE_MAP[row.leagueSlug ?? ""]?.name ?? row.competitionName ?? row.league;
        resolvedByLeague[label] = (resolvedByLeague[label] ?? 0) + resolved;
      }
    } catch {
      // best-effort per row
    }
  }
  for (const [league, resolved] of Object.entries(resolvedByLeague)) {
    console.log(`[Settle] Resolved ${resolved} pending bets for ${league}`);
  }
  return refreshed;
}

// ─── Feature settlement: picks tracked via performance_log.feature ───────────
//
// Feature rows (feature = 'corners' | 'first5', outcome = 'pending') are
// settled here — independently of the A–D ranking-mode system:
//
//   · 'corners' → the sure-bet corner resolvers
//     (src/lib/settlement/sureCornerOutcomes), i.e. the exact evaluators the
//     /api/sure-corners/verify endpoint uses, driven by the real corner
//     counts from the multi-source stats aggregator.
//   · 'first5'  → resolveFirst5Outcome below, driven by the actual opening-
//     phase event data available for the match (timestamped goal events when
//     a provider supplies them, otherwise the real match totals from the
//     stats aggregator).
//
// Integrity rules (same contract as the rest of the settlement engine):
//   · no final result anywhere  → the pick stays 'pending', retried next run
//   · no stats object yet       → stays 'pending' (stats arrive late), except
//     goals, whose total is the real final score
//   · finished match, stat that will never arrive → 'VOID' (stake returned)
//   · a 'Yes'/'No' outcome is only decided when REAL data proves it — never
//     guessed from partial or whole-match numbers alone.

export type FeatureOutcome = "WIN" | "LOSS" | "PUSH" | "VOID";

/** Map a stored first-5 market name ("Goal" / "Goal in First 5 Minutes"…) to its event kind. */
export function first5EventKind(market: string): "goal" | "corner" | "card" | "penalty" | null {
  const m = market.toLowerCase();
  if (m.includes("goal")) return "goal";
  if (m.includes("corner")) return "corner";
  if (m.includes("card")) return "card";
  if (m.includes("penalt")) return "penalty";
  return null;
}

/** Whole-match actual event count; null when real data cannot prove it. */
function first5EventTotal(
  kind: "goal" | "corner" | "card" | "penalty",
  result: MatchResult,
  stats: CanonicalMatchStats | null,
): number | null {
  if (kind === "goal") {
    // The final score is the real, complete goals total — available the
    // moment the result is known, before any stats source publishes.
    if (stats && stats.home.goals !== null && stats.away.goals !== null) {
      return stats.home.goals + stats.away.goals;
    }
    return result.homeScore + result.awayScore;
  }
  if (!stats) return null;
  const home = stats.home;
  const away = stats.away;
  const cardsOf = (t: TeamStats): number | null =>
    t.yellowCards === null || t.redCards === null ? null : t.yellowCards + t.redCards;
  switch (kind) {
    case "corner":
      return home.corners === null || away.corners === null ? null : home.corners + away.corners;
    case "card": {
      const h = cardsOf(home);
      const a = cardsOf(away);
      return h === null || a === null ? null : h + a;
    }
    case "penalty":
      return home.penalties === null || away.penalties === null ? null : home.penalties + away.penalties;
  }
}

/**
 * Resolve one stored First 5 Minutes pick (market = Goal/Corner/Card/Penalty,
 * selection = Yes/No) against real match data. Returns null while the pick is
 * still pending (no final result, or stats not published yet).
 */
export function resolveFirst5Outcome(
  market: string,
  selection: string,
  result: MatchResult,
  stats: CanonicalMatchStats | null,
): FeatureOutcome | null {
  const kind = first5EventKind(market);
  const yes = selection.trim().toLowerCase() === "yes";
  if (!kind || (selection.trim() !== "Yes" && selection.trim() !== "No")) return null;

  // Goals with real timestamps (MatchResult.goals) settle EXACTLY on the
  // opening five minutes — the only fully verifiable path for a 'Yes'.
  if (kind === "goal" && Array.isArray(result.goals)) {
    const earlyGoals = result.goals.filter((g) => typeof g.minute === "number" && g.minute <= 5).length;
    const happened = earlyGoals > 0;
    return (yes === happened) ? "WIN" : "LOSS";
  }

  const total = first5EventTotal(kind, result, stats);
  if (total === null) {
    // No stats object yet → the next sweep may find them (retry). Stats
    // object present but the event count will never be published → VOID.
    return stats === null ? null : "VOID";
  }
  if (total === 0) {
    // Provably no such event anywhere in the match → none in minutes 0–5.
    return selection.trim() === "No" ? "WIN" : "LOSS";
  }
  // The event happened somewhere in the match, but the available data cannot
  // prove it landed inside the opening five minutes → never guess.
  return "VOID";
}

interface FeaturePass {
  total: number;
  corners: number;
  first5: number;
  stillPending: number;
  failed: number;
  outcomes: Record<FeatureOutcome, number>;
}

const detailOutcomeForFeature = (outcome: FeatureOutcome): string =>
  outcome === "WIN" ? "HIT" : outcome === "LOSS" ? "MISS" : outcome;

/** Task: settle every pending performance row carrying a feature value. */
async function settleFeaturePicks(force = false): Promise<FeaturePass> {
  const pass: FeaturePass = {
    total: 0, corners: 0, first5: 0, stillPending: 0, failed: 0,
    outcomes: { WIN: 0, LOSS: 0, PUSH: 0, VOID: 0 },
  };

  const rows = await db
    .select()
    .from(performanceLog)
    .where(and(isNotNull(performanceLog.feature), eq(performanceLog.outcome, "pending")))
    .limit(SWEEP_LIMIT(force));

  if (rows.length === 0) return pass;

  // Group by event so each match's result + stats is fetched only once.
  const byEvent = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byEvent.get(row.eventId) ?? [];
    group.push(row);
    byEvent.set(row.eventId, group);
  }

  const resultCache = new Map<string, MatchResult | null>();
  const statsCache = new Map<string, CanonicalMatchStats | null>();

  for (const [eventId, picks] of byEvent) {
    const first = picks[0];
    pass.total += picks.length;
    try {
      let result: MatchResult | null;
      if (!resultCache.has(eventId)) {
        result = await lookupMultiSourceResult({
          eventId: first.eventId,
          leagueSlug: first.leagueSlug,
          matchLabel: first.matchLabel,
          matchDate: first.matchDate,
        }).catch(() => null);
        resultCache.set(eventId, result);
      } else {
        result = resultCache.get(eventId) ?? null;
      }
      if (!result) {
        // The match has no final result anywhere yet — keep everything pending.
        pass.stillPending += picks.length;
        continue;
      }

      if (!statsCache.has(eventId)) {
        statsCache.set(
          eventId,
          (await statsAggregator.peek({
            leagueSlug: result.leagueSlug,
            eventId: result.eventId,
            homeTeam: result.homeName,
            awayTeam: result.awayName,
            date: result.date,
          })) ?? (await statsAggregator.fetch({
            leagueSlug: result.leagueSlug,
            eventId: result.eventId,
            homeTeam: result.homeName,
            awayTeam: result.awayName,
            date: result.date,
          }).catch(() => null)),
        );
      }
      const stats = statsCache.get(eventId) ?? null;

      for (const pick of picks) {
        const feature = pick.feature;
        const market = pick.market ?? "";
        const selection = pick.selection ?? "";
        const outcome =
          feature === "corners"
            ? resolveSureCornerOutcome(market, selection, result, stats)
            : feature === "first5"
              ? resolveFirst5Outcome(market, selection, result, stats)
              : null;
        if (outcome === null) {
          pass.stillPending++;
          continue;
        }
        if (feature === "corners") pass.corners++;
        else if (feature === "first5") pass.first5++;

        // Guarded update: only settle rows still 'pending' so concurrent
        // runs (this sweep or /api/sure-corners/verify) never settle twice.
        const previousDetail = Array.isArray(pick.top10Detail)
          ? (pick.top10Detail as Array<Record<string, unknown>>)
          : [];
        const changed = await db
          .update(performanceLog)
          .set({
            outcome,
            settledAt: new Date(),
            homeScore: result.homeScore,
            awayScore: result.awayScore,
            hits: outcome === "WIN" ? 1 : 0,
            misses: outcome === "LOSS" ? 1 : 0,
            pending: 0,
            accuracy: outcome === "WIN" ? 1 : outcome === "LOSS" ? 0 : pick.accuracy,
            top10Detail: previousDetail.map((entry) =>
              entry.name === market ? { ...entry, outcome: detailOutcomeForFeature(outcome) } : entry,
            ),
          })
          .where(and(eq(performanceLog.id, pick.id), eq(performanceLog.outcome, "pending")))
          .returning({ id: performanceLog.id });

        if (!changed[0]) {
          pass.failed++;
          continue;
        }
        pass.outcomes[outcome]++;
        console.log(`[Settle] Feature pick ${first.matchLabel}: ${market} ${selection} → ${outcome} (${feature})`);
      }
    } catch (error) {
      pass.failed += picks.length;
      console.error(`[Settle] Feature settlement error for ${first.matchLabel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (pass.corners + pass.first5 > 0) {
    console.log(
      `[Settle] Feature sweep settled ${pass.corners} corner pick(s) and ${pass.first5} first-5 pick(s) ` +
      `(${pass.outcomes.WIN} WIN, ${pass.outcomes.LOSS} LOSS, ${pass.outcomes.PUSH} PUSH, ${pass.outcomes.VOID} VOID; ${pass.stillPending} still pending)`,
    );
  }
  return pass;
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
  failed: number;
  resolvedByLeague: Record<string, number>;
}

function namesLooseMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const nb = b.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** Seed finished results from the live fixture-feed catalogue (all competitions). */
async function seedResultsFromFixtureFeed(): Promise<MatchResult[]> {
  const feed = await fixturesGET(new Request("http://gigi.local/api/fixtures?days=3&stats=0")).catch(
    (err) => {
      console.warn("[Settle] Fixture-feed result seed failed:", err);
      return null;
    },
  );
  if (!feed || !feed.ok) return [];
  const payload = (await feed.json()) as { fixtures?: FixtureLite[] };
  const results: MatchResult[] = [];
  for (const fx of payload.fixtures ?? []) {
    const result = resultFromFixture(fx);
    if (result) results.push(result);
  }
  console.log(`[Settle] Seeded ${results.length} finished results from the fixture-feed catalogue`);
  return results;
}

function matchFeedResult(
  seeded: MatchResult[],
  eventId: string,
  leagueSlug: string,
  matchLabel: string,
  matchDate: string,
): MatchResult | null {
  const byId = seeded.find((r) => r.eventId === eventId);
  if (byId) return byId;
  const home = matchLabel.split(" vs ")[0]?.trim() ?? "";
  const away = matchLabel.split(" vs ")[1]?.trim() ?? "";
  const day = matchDate.slice(0, 10);
  const slug = canonicalLeagueSlug(leagueSlug);
  return (
    seeded.find((r) => {
      const sameDay = !day || r.date.slice(0, 10) === day;
      const sameSlug = !slug || canonicalLeagueSlug(r.leagueSlug) === slug;
      return sameDay && sameSlug && namesLooseMatch(r.homeName, home) && namesLooseMatch(r.awayName, away);
    }) ?? null
  );
}

async function settlePendingAcrossAllSources(force = false): Promise<SettlePass> {
  const queues = await getPendingSettlementItems({
    accumulators: SWEEP_LIMIT(force),
    dailyPicks:   SWEEP_LIMIT(force),
    valueBets:    SWEEP_LIMIT(force),
  });

  const seeded = await seedResultsFromFixtureFeed();

  const cache = new Map<string, MatchResult | null>();
  const resolve = async (eventId: string, leagueSlug: string, matchLabel: string, matchDate: string) => {
    const key = `${leagueSlug}|${eventId}`;
    if (!cache.has(key)) {
      const fromFeed = matchFeedResult(seeded, eventId, leagueSlug, matchLabel, matchDate);
      cache.set(
        key,
        fromFeed ??
          (await lookupMultiSourceResult({ eventId, leagueSlug, matchLabel, matchDate })),
      );
    }
    return cache.get(key) ?? null;
  };

  // Canonical stats cache-first lookup so stat legs settle from real data.
  const statsCache = new Map<string, Awaited<ReturnType<typeof statsAggregator.peek>>>();
  const resolveStats = async (result: MatchResult | null) => {
    if (!result) return null;
    const key = `${result.leagueSlug}|${result.eventId}`;
    if (!statsCache.has(key)) {
      statsCache.set(key, await statsAggregator.fetch({
        leagueSlug: result.leagueSlug,
        eventId: result.eventId,
        homeTeam: result.homeName,
        awayTeam: result.awayName,
        date: result.date,
      }));
    }
    return statsCache.get(key) ?? null;
  };

  const pass: SettlePass = {
    dailyPicks: 0, valueBets: 0, accumulators: 0, won: 0, lost: 0, void: 0, stillPending: 0,
    failed: 0, resolvedByLeague: {},
  };
  const recordResolved = (leagueSlug: string | null | undefined) => {
    const label = LEAGUE_MAP[leagueSlug ?? ""]?.name ?? leagueSlug ?? "Unknown League";
    pass.resolvedByLeague[label] = (pass.resolvedByLeague[label] ?? 0) + 1;
  };

  // ── Daily picks ─────────────────────────────────────────────────────────────
  for (const row of queues.dailyPicks) {
    try {
      if (!row.eventId || !row.leagueSlug) { pass.stillPending++; continue; }
      const result = await resolve(row.eventId, row.leagueSlug, row.match, row.pickDate);
      if (!result || !Array.isArray(row.picks) || row.picks.length === 0) { pass.stillPending++; continue; }
      const stats = await resolveStats(result);

      const picks = row.picks.map((raw) => {
        const pick = raw as { name?: string; marketName?: string; selection?: string; outcome?: string };
        const outcome = evaluateLeg(
          { marketName: pick.marketName ?? pick.name, selection: pick.selection },
          result,
          stats,
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
        recordResolved(row.leagueSlug);
        if (hits > 0) pass.won++;
        if (misses > 0) pass.lost++;
        if (voids > 0) pass.void++;
      }
    } catch {
      pass.failed++;
    }
  }

  // ── Value bets ──────────────────────────────────────────────────────────────
  for (const row of queues.valueBets) {
    try {
      const result = await resolve(row.eventId, row.leagueSlug, row.match, row.matchDate);
      if (!result) { pass.stillPending++; continue; }
      const stats = await resolveStats(result);
      const outcome = evaluateLeg({ marketName: row.marketName, selection: row.selection }, result, stats);
      if (outcome === "pending") { pass.stillPending++; continue; }
      const actualReturn = outcome === "won" ? row.stake * row.bookOdds : outcome === "void" ? row.stake : 0;
      const changed = await settleValueBet(row, { outcome, actualReturn, pnl: actualReturn - row.stake });
      if (changed) {
        pass.valueBets++;
        recordResolved(row.leagueSlug);
        if (outcome === "won") pass.won++; else if (outcome === "lost") pass.lost++; else pass.void++;
      }
    } catch {
      pass.failed++;
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
        const stats = await resolveStats(result);
        const outcome = evaluateLeg({ marketName: leg.marketName, selection: leg.selection }, result, stats);
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
        recordResolved(slip.leagueSlug);
        if (status === "won") pass.won++; else pass.lost++;
      }
    } catch {
      pass.failed++;
    }
  }

  for (const [league, resolved] of Object.entries(pass.resolvedByLeague)) {
    console.log(`[Settle] Resolved ${resolved} pending bets for ${league}`);
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
  featurePicks: FeaturePass;
  refreshedPerformanceRows: number;
  legacyBackfill: { performanceRows: number; valueBetRows: number; slipRows: number };
  failures: string[];
  totalPending: number;
  resolved: number;
  failed: number;
  ranAt: string;
}

async function countPendingRows(): Promise<number> {
  const [daily, value, slips, performance, features] = await Promise.all([
    db.select({ value: count() }).from(dailyPicks).where(eq(dailyPicks.status, "pending")),
    db.select({ value: count() }).from(valueBetLog).where(eq(valueBetLog.outcome, "pending")),
    db.select({ value: count() }).from(savedSlips).where(eq(savedSlips.status, "pending")),
    db.select({ value: count() }).from(performanceLog).where(gt(performanceLog.pending, 0)),
    db.select({ value: count() }).from(performanceLog)
      .where(and(isNotNull(performanceLog.feature), eq(performanceLog.outcome, "pending"))),
  ]);
  return Number(daily[0]?.value ?? 0) + Number(value[0]?.value ?? 0) + Number(slips[0]?.value ?? 0) + Number(performance[0]?.value ?? 0) + Number(features[0]?.value ?? 0);
}

async function runAllLeagueSettlement(force = false): Promise<SettleSweepSummary> {
  const failures: string[] = [];
  const totalPending = await countPendingRows();

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
    failed: 0, resolvedByLeague: {},
  };
  try {
    multiSource = await settlePendingAcrossAllSources(force);
  } catch (err) {
    failures.push(`multi-source settlement: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3) Feature picks (performance_log.feature: 'corners' / 'first5').
  let featurePicks: FeaturePass = {
    total: 0, corners: 0, first5: 0, stillPending: 0, failed: 0,
    outcomes: { WIN: 0, LOSS: 0, PUSH: 0, VOID: 0 },
  };
  try {
    featurePicks = await settleFeaturePicks(force);
  } catch (err) {
    failures.push(`feature settlement: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4) Refresh performance rows with late-arriving boxscores.
  let refreshedPerformanceRows = 0;
  try {
    refreshedPerformanceRows = await refreshPendingPerformanceRows(force);
  } catch (err) {
    failures.push(`performance refresh: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5) Legacy league field backfill.
  let legacyBackfill = { performanceRows: 0, valueBetRows: 0, slipRows: 0 };
  try {
    legacyBackfill = await backfillLegacyLeagueFields();
  } catch (err) {
    failures.push(`legacy backfill: ${err instanceof Error ? err.message : String(err)}`);
  }

  const featureSettled = featurePicks.corners + featurePicks.first5;
  console.log(
    `[Cron][settle] engine settled ${engine?.settled.total ?? 0} · multi-source settled ` +
    `${multiSource.dailyPicks + multiSource.valueBets + multiSource.accumulators} ` +
    `(${multiSource.stillPending} still pending) · feature picks settled ${featureSettled} ` +
    `(${featurePicks.corners} corners, ${featurePicks.first5} first-5; ${featurePicks.stillPending} still pending) · ` +
    `refreshed ${refreshedPerformanceRows} performance rows · ` +
    `legacy backfill ${legacyBackfill.performanceRows + legacyBackfill.valueBetRows + legacyBackfill.slipRows} rows`,
  );

  const resolved = (engine?.settled.total ?? 0) + multiSource.dailyPicks + multiSource.valueBets + multiSource.accumulators + featureSettled + refreshedPerformanceRows;
  return { ok: failures.length === 0, engine, multiSource, featurePicks, refreshedPerformanceRows, legacyBackfill, failures, totalPending, resolved, failed: multiSource.failed + featurePicks.failed + failures.length, ranAt: new Date().toISOString() };
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
    const force = new URL(req.url).searchParams.get("force") === "true";
    return Response.json(await runAllLeagueSettlement(force));
  } catch (error) {
    console.error("[Cron][settle] failed:", error);
    return Response.json({ error: "Settlement failed" }, { status: 500 });
  }
}

export const POST = GET;
