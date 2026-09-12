// ĞIGI GIVØ — All-league settlement cron.
//
// In addition to the settlement engine (ESPN-based), this job:
//   1. settles EVERY pending tracked item across ALL competitions — including
//      matches sourced from TheSportsDB / OpenLigaDB / API-Football, via the
//      live fixture-feed catalogue plus the multi-source result lookup;
//   2. settles the dedicated feature picks (performance_log rows whose
//      `feature` column is not NULL):
//        · feature = 'corners' — Sure Bet Corners picks, resolved from real
//          corner counts via the same evaluator the verification endpoint uses;
//        · feature = 'first5'  — First 5 Minutes picks, resolved from real
//          first-5-minute event data (minute-stamped goal / corner / card /
//          penalty events, with the aggregator's full-match totals as the
//          zero-event proof);
//   3. refreshes performance_log rows whose stat markets were still pending
//      (boxscore arrives later than the final whistle) — resolving them from
//      the FULL multi-source boxscore, and marking any market no source can
//      provide VOID (stake returned) once the match is older than the 24h
//      settlement grace window, so finished matches never keep markets stuck
//      in PENDING indefinitely. This pass is feature-agnostic: it sweeps every
//      row with unsettled markets, regular ranking-mode rows (feature IS NULL)
//      included — the `feature` column never gates which rows get processed;
//   4. backfills leagueSlug / competitionName on legacy performance rows so
//      the league dashboard has full transparency across old + new data.
//
// POST /api/cron/settle?force=true manually runs an immediate uncapped sweep.
// Fail-soft: a broken league or provider never aborts the whole job.

import { db } from "@/db";
import { dailyPicks, performanceLog, savedSlips, valueBetLog } from "@/db/schema";
import { and, count, eq, isNull, isNotNull, gt } from "drizzle-orm";
import { runSettlementEngine, settlementStatusLabel } from "@/lib/settlement/engine";
import {
  getPendingSettlementItems,
  settleAccumulator,
  settleDailyPick,
  settleValueBet,
} from "@/db/queries/settlement";
import {
  evaluateLegDetailed, statsGraceElapsed, STATS_SETTLEMENT_GRACE_HOURS, type MatchResult,
} from "@/lib/settlement/evaluate";
import { resolveSureCornerOutcome } from "@/lib/settlement/sureCornerOutcomes";
import type { CanonicalMatchStats } from "@/lib/data/types";
import { resilientJson } from "@/lib/httpClient";
import {
  lookupMultiSourceResult,
  resultFromFixture,
  statsToBoxscore,
} from "../daily-picks/route";
import { GET as fixturesGET } from "@/app/api/fixtures/route";
import { statsAggregator } from "@/lib/data/aggregator";
import {
  fetchSettlementResults,
  getSettlementBoxscore,
  type ResultsProvider,
  type SettlementQueues,
} from "@/lib/settlement/results";
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

/**
 * Rebuild a post-match fixture from a summary-first lookup result, for legacy
 * rows whose own `leagueSlug` is NULL / namespaced / stale. The summary-first
 * provider (PR #103/#104) indexes the match by event id AND "Home vs Away" and
 * derives the ESPN slug FROM THE MATCH, so it can supply the slug the row is
 * missing — dropping such a row on the floor would leave its markets pending
 * forever, which is exactly what the 24h grace pass exists to prevent.
 */
function fixtureFromResult(
  row: typeof performanceLog.$inferSelect,
  lookedUp: MatchResult,
): FixtureLite {
  const homeName = lookedUp.homeName || row.homeTeam;
  const awayName = lookedUp.awayName || row.awayTeam;
  return {
    id:          lookedUp.eventId || row.eventId,
    leagueSlug:  lookedUp.leagueSlug,
    leagueName:  row.competitionName ?? row.league,
    date:        `${lookedUp.date || row.matchDate}T00:00:00Z`,
    state:       "post",
    statusDetail: "Match Finished",
    venue:       null,
    neutralSite: false,
    home: {
      id: "", name: homeName, shortName: homeName, abbrev: homeName.slice(0, 3),
      logo: null, color: null, score: String(lookedUp.homeScore), homeAway: "home",
    },
    away: {
      id: "", name: awayName, shortName: awayName, abbrev: awayName.slice(0, 3),
      logo: null, color: null, score: String(lookedUp.awayScore), homeAway: "away",
    },
    odds: null,
  };
}

// ─── Task 1: refresh performance_log rows with still-pending stat markets ────

export interface PerformanceRefreshResult {
  /** Markets newly resolved (PENDING → any final status) this run. */
  resolved: number;
  /** Markets newly marked VOID because no source ever had the stat. */
  voided: number;
  /** Newly HIT / newly MISS / newly PUSH entries, for the run summary line. */
  win: number;
  loss: number;
  push: number;
  /** Matches touched by the refresh. */
  matches: number;
}

/** Stored top10Detail outcome → canonical per-market label for the log line. */
function performanceStatusLabel(outcome: string): string {
  switch (outcome) {
    case "HIT": return "WIN";
    case "MISS": return "LOSS";
    case "PUSH": return "PUSH";
    case "VOID": return "VOID (no stats)";
    default: return "PENDING";
  }
}

/** Exported for tests — the cron sweeps it through runAllLeagueSettlement(). */
export async function refreshPendingPerformanceRows(force = false): Promise<PerformanceRefreshResult> {
  // Feature-agnostic by design. The only gate on this pass is the per-row
  // `pending` market counter, so it sweeps EVERY row that still has unsettled
  // Top-10 markets — ranking-mode rows (feature IS NULL, the vast majority)
  // and dedicated feature rows ('corners' / 'first5') alike. `feature` is
  // carried in the projection purely so the log below can break the sweep down
  // by pick family; it is deliberately NOT part of the WHERE clause. Rows whose
  // market family needs different evaluation are separated further down, in the
  // settlement logic, never here in the row selection.
  const rows = await db
    .select()
    .from(performanceLog)
    .where(gt(performanceLog.pending, 0))
    .limit(SWEEP_LIMIT(force));
  const result: PerformanceRefreshResult = { resolved: 0, voided: 0, win: 0, loss: 0, push: 0, matches: 0 };

  // Debug: the exact sweep size plus its feature breakdown, so a run that
  // refreshes nothing can be told apart at a glance — "no pending rows to
  // sweep" vs "rows found, but every one bailed out further down the loop".
  const byFeature = rows.reduce<Record<string, number>>((acc, row) => {
    const key = row.feature ?? "regular (feature=NULL)";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `[Settle][refresh] Found ${rows.length} pending performance rows to refresh` +
      (rows.length > 0
        ? ` — ${Object.entries(byFeature).map(([feature, n]) => `${feature}: ${n}`).join(", ")}`
        : ""),
  );
  const resolvedByLeague: Record<string, number> = {};

  // Resolve every pending match's FINAL SCORE through the fixed summary-first
  // lookup — the same fetchSettlementResults PR #103 rewrote — instead of the
  // old scoreboard-only path (which read the row's own stored score and asked
  // ESPN under the row's stored league slug). Each performance row is fed in
  // as a daily-pick-shaped probe so the provider indexes the match by event id
  // AND "Home vs Away" label, with the ESPN slug derived FROM THE MATCH
  // (competition name first, stored slug second). That is the piece that makes
  // a Champions League row resolve as `uefa.champions` even when its stored
  // slug is stale, namespaced, "all" or blank.
  let resultsProvider: ResultsProvider | null = null;
  try {
    resultsProvider = await fetchSettlementResults({
      accumulators: [],
      valueBets: [],
      dailyPicks: rows.map((row) => ({
        id: row.id,
        eventId: row.eventId,
        leagueSlug: row.leagueSlug,
        league: row.competitionName ?? row.league,
        match: row.matchLabel,
        pickDate: row.matchDate,
      })) as unknown as SettlementQueues["dailyPicks"],
    });
  } catch (err) {
    console.warn("[Settle][refresh] Summary-first result lookup failed — falling back to stored scores:", err);
  }

  for (const row of rows) {
    try {
      console.log(`[Settle][refresh] Fetching result for ${row.matchLabel} (event ${row.eventId})`);
      const lookedUp = resultsProvider?.find(row.eventId, row.matchLabel);

      // Prefer the row's own fixture; fall back to one rebuilt from the
      // summary-first result when the row carries no usable leagueSlug. Either
      // way a row is only skipped with a logged reason — never silently.
      let fx = fixtureFromPerformanceRow(row);
      if (!fx && lookedUp) fx = fixtureFromResult(row, lookedUp);
      if (!fx) {
        console.log(
          `[Settle][refresh] Skipped ${row.matchLabel} (event ${row.eventId}) — no leagueSlug on the row ` +
          `and the summary-first lookup has no result for this match yet`,
        );
        continue;
      }
      const rankingMode = (row.rankingMode as RankingMode) || "B";
      const pred = await runOracleWithStandings(fx, { rankingMode });
      if (!pred) {
        console.log(
          `[Settle][refresh] Skipped ${row.matchLabel} (event ${row.eventId}) — oracle returned no prediction`,
        );
        continue;
      }

      // The real final score + league slug come from the summary-first lookup.
      // When the provider cannot see the match (not finished anywhere yet, or
      // a non-ESPN event with no summary endpoint) fall back to the row's own
      // stored score so the multi-source boxscore below still resolves stat
      // markets, and the 24h grace pass can still VOID what no source has.
      const matchResult: MatchResult = lookedUp
        ? {
            eventId:    lookedUp.eventId,
            leagueSlug: lookedUp.leagueSlug,
            date:       lookedUp.date || row.matchDate,
            kickoffAt:  lookedUp.kickoffAt,
            homeName:   lookedUp.homeName,
            awayName:   lookedUp.awayName,
            homeScore:  lookedUp.homeScore,
            awayScore:  lookedUp.awayScore,
          }
        : {
            eventId:    fx.id,
            leagueSlug: fx.leagueSlug,
            date:       row.matchDate,
            homeName:   row.homeTeam,
            awayName:   row.awayTeam,
            homeScore:  row.homeScore,
            awayScore:  row.awayScore,
          };
      if (lookedUp) {
        console.log(`[Settle][refresh] ESPN summary returned: home ${lookedUp.homeScore}, away ${lookedUp.awayScore}`);
        // Keep the reconstructed fixture's score in sync so the engine's own
        // evaluator (evaluateFinishedMatch) sees the real final score too.
        fx.home.score = String(lookedUp.homeScore);
        fx.away.score = String(lookedUp.awayScore);
      }

      // FULL boxscore supply for settlement: the summary-first ESPN boxscore
      // (getSettlementBoxscore asks under the match's own derived league slug)
      // plus the multi-source aggregator walk (API-Football /fixtures/
      // statistics, StatsBomb, FBref, TheSportsDB, Understat, … — first-wins,
      // memo-cached, so repeated settlement runs never re-fetch).
      const canonicalStats = (await getSettlementBoxscore(matchResult)).stats;
      const boxscore = statsToBoxscore(canonicalStats);
      evaluateFinishedMatch(fx, pred, boxscore);

      // Merge fresh outcomes into the stored detail, keeping original fields.
      const fresh = new Map(
        pred.top10.map((m) => [`${m.name}|${m.selection}`, m.outcome ?? "PENDING"]),
      );
      // Markets the ESPN boxscore key space cannot see (throw-ins, goal
      // kicks, saves …) get a second resolution pass through the settlement
      // evaluator against the canonical multi-source stats. Whatever still
      // cannot be resolved is decided by the 24h grace window: recent games
      // wait for late data (PENDING), older ones VOID — stake returned — so
      // no finished match can keep a market pending forever.
      const graceElapsed = statsGraceElapsed(matchResult);
      const newlyResolved: string[] = [];
      let voidedHere = 0;
      const detail = (row.top10Detail as Array<{ name: string; selection: string; outcome?: string }>)
        .map((p) => {
          const previous = p.outcome ?? "PENDING";
          let outcome = fresh.get(`${p.name}|${p.selection}`) ?? previous ?? "PENDING";
          if (outcome === "PENDING") {
            const evaluation = evaluateLegDetailed(
              { marketName: p.name, selection: p.selection },
              matchResult,
              canonicalStats,
            );
            if (evaluation.outcome === "won") outcome = "HIT";
            else if (evaluation.outcome === "lost") outcome = "MISS";
            else if (evaluation.outcome === "void") outcome = evaluation.push ? "PUSH" : "VOID";
            if (outcome === "PENDING" && graceElapsed) outcome = "VOID";
            if (outcome === "VOID") voidedHere++;
          }
          if (outcome !== previous) {
            newlyResolved.push(`${p.name}: ${performanceStatusLabel(outcome)}`);
            if (outcome === "HIT") result.win++;
            else if (outcome === "MISS") result.loss++;
            else if (outcome === "PUSH") result.push++;
          }
          return { ...p, outcome };
        });

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
      result.resolved += resolved;
      result.voided += voidedHere;
      if (newlyResolved.length > 0) {
        result.matches++;
        // Per-market settlement log (Part 4).
        console.log(`[Settle] ${row.matchLabel} — ${newlyResolved.join(", ")}`);
      }
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
  return result;
}

// ─── Task 2: multi-source settlement of every pending tracked item ───────────

interface SettlePass {
  dailyPicks: number;
  valueBets: number;
  accumulators: number;
  won: number;
  lost: number;
  void: number;
  push: number;
  stillPending: number;
  failed: number;
  /** Per-MARKET outcome tally across every row this pass evaluated. */
  markets: { resolved: number; win: number; loss: number; push: number; void: number; pending: number };
  /** Distinct finished matches touched by this pass. */
  matches: number;
  /** Pending markets on matches already past the 24h grace (expected: 0). */
  stuckPending: number;
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
    // Keep the exact kickoff timestamp so the 24h stats-void grace measures
    // from the real final whistle (resultFromFixture truncates the date).
    if (result) results.push({ ...result, kickoffAt: fx.date });
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

  // Full boxscore, cache-first (settlement memo → aggregator cache → the
  // multi-source walk). Memoised per match, so repeated settlement runs and
  // multi-leg slips never re-fetch the same fixture.
  const matchesTouched = new Set<string>();
  const resolveStats = async (result: MatchResult | null) => {
    if (!result) return null;
    return (await getSettlementBoxscore(result)).stats;
  };

  const pass: SettlePass = {
    dailyPicks: 0, valueBets: 0, accumulators: 0, won: 0, lost: 0, void: 0, push: 0,
    stillPending: 0, failed: 0, stuckPending: 0, matches: 0,
    markets: { resolved: 0, win: 0, loss: 0, push: 0, void: 0, pending: 0 },
    resolvedByLeague: {},
  };
  const recordResolved = (leagueSlug: string | null | undefined) => {
    const label = LEAGUE_MAP[leagueSlug ?? ""]?.name ?? leagueSlug ?? "Unknown League";
    pass.resolvedByLeague[label] = (pass.resolvedByLeague[label] ?? 0) + 1;
  };
  /** Count one MARKET outcome (per-market, unlike the row counters above). */
  const countMarket = (
    result: MatchResult | null,
    evaluation: ReturnType<typeof evaluateLegDetailed>,
  ): void => {
    pass.markets.pending += evaluation.outcome === "pending" ? 1 : 0;
    if (evaluation.outcome === "pending") {
      // Past the grace window a pending market is stuck — evaluateLegDetailed
      // escalates those to VOID, so this branch is a regression alarm only.
      if (result && statsGraceElapsed(result)) pass.stuckPending++;
      return;
    }
    pass.markets.resolved++;
    if (result) matchesTouched.add(`${result.leagueSlug}|${result.eventId}`);
    if (evaluation.outcome === "won") pass.markets.win++;
    else if (evaluation.outcome === "lost") pass.markets.loss++;
    else if (evaluation.push) pass.markets.push++;
    else pass.markets.void++;
  };
  /** `[Settle] Arsenal vs Chelsea — Market A: WIN, Market B: VOID (no stats)` */
  const logMarkets = (matchLabel: string, parts: string[]): void => {
    if (parts.length > 0) console.log(`[Settle] ${matchLabel} — ${parts.join(", ")}`);
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
        const evaluation = evaluateLegDetailed(
          { marketName: pick.marketName ?? pick.name, selection: pick.selection },
          result,
          stats,
        );
        countMarket(result, evaluation);
        const stored =
          evaluation.outcome === "won" ? "HIT" :
          evaluation.outcome === "lost" ? "MISS" :
          evaluation.push ? "PUSH" : evaluation.outcome.toUpperCase();
        return { pick: { ...pick, outcome: stored }, evaluation };
      });
      // One log line per match listing every market's status (Part 4).
      logMarkets(
        `${result.homeName} vs ${result.awayName}`,
        picks.map(({ pick, evaluation }) =>
          `${(pick.marketName ?? pick.name ?? "Unknown market").trim()}: ${settlementStatusLabel(evaluation)}`,
        ),
      );
      if (picks.some(({ evaluation }) => evaluation.outcome === "pending")) { pass.stillPending++; continue; }

      const hits    = picks.filter(({ evaluation }) => evaluation.outcome === "won").length;
      const misses  = picks.filter(({ evaluation }) => evaluation.outcome === "lost").length;
      const pushes  = picks.filter(({ evaluation }) => evaluation.outcome === "void" && evaluation.push).length;
      const voids   = picks.filter(({ evaluation }) => evaluation.outcome === "void" && !evaluation.push).length;
      const changed = await settleDailyPick(row, {
        hits, misses, voids: voids + pushes,
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
        if (pushes > 0) pass.push++;
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
      const evaluation = evaluateLegDetailed({ marketName: row.marketName, selection: row.selection }, result, stats);
      countMarket(result, evaluation);
      logMarkets(`${result.homeName} vs ${result.awayName}`, [
        `${(row.marketName ?? "Unknown market").trim()}: ${settlementStatusLabel(evaluation)}`,
      ]);
      if (evaluation.outcome === "pending") { pass.stillPending++; continue; }
      // Line-pushes return the stake exactly like a void — the ledger's
      // vocabulary is won | lost | void; PUSH vs VOID shows in the log + tally.
      const outcome = evaluation.outcome === "won" ? "won" : evaluation.outcome === "lost" ? "lost" : "void";
      const actualReturn = outcome === "won" ? row.stake * row.bookOdds : outcome === "void" ? row.stake : 0;
      const changed = await settleValueBet(row, { outcome, actualReturn, pnl: actualReturn - row.stake });
      if (changed) {
        pass.valueBets++;
        recordResolved(row.leagueSlug);
        if (outcome === "won") pass.won++;
        else if (outcome === "lost") pass.lost++;
        else if (evaluation.push) pass.push++;
        else pass.void++;
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
      const evaluated: Array<{ outcome: string; push?: boolean }> = [];
      const legLabels: string[] = [];

      for (const leg of legs) {
        if (!leg?.fixtureId || !leg?.leagueSlug) { allSettled = false; continue; }
        const result = await resolve(leg.fixtureId, leg.leagueSlug, leg.matchLabel ?? "", leg.date ?? "");
        if (!result) { allSettled = false; continue; }
        const stats = await resolveStats(result);
        const evaluation = evaluateLegDetailed({ marketName: leg.marketName, selection: leg.selection }, result, stats);
        countMarket(result, evaluation);
        legLabels.push(
          `${(leg.matchLabel ?? `${result.homeName} vs ${result.awayName}`)} · ${(leg.marketName ?? "Unknown market").trim()}: ${settlementStatusLabel(evaluation)}`,
        );
        evaluated.push({ outcome: evaluation.outcome, push: evaluation.push });
        if (evaluation.outcome === "pending") allSettled = false;
        if (evaluation.outcome === "lost") allHit = false;
      }
      logMarkets(`Slip #${slip.id}`, legLabels);
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

  pass.matches = matchesTouched.size;
  for (const [league, resolved] of Object.entries(pass.resolvedByLeague)) {
    console.log(`[Settle] Resolved ${resolved} pending bets for ${league}`);
  }
  return pass;
}

// ─── Task 2b: dedicated feature picks (Sure Bet Corners / First 5 Minutes) ───
//
// performance_log rows whose `feature` column is set are tracked products with
// their own dashboards (/performance/corners, /performance/first5), fully
// separate from the A–D ranking-mode rows. They settle through the `outcome`
// column (pending | WIN | LOSS | PUSH | VOID) exactly like the Sure Bet
// Corners verification endpoint, so both settlement paths are idempotent and
// whichever runs first wins.
//
// Evidence used per feature:
//   · corners — the final result + canonical corner stats, resolved by the
//     shared sureCornerOutcomes evaluator (O/U via the settlement engine's
//     evaluateLeg, plus the Corner Winner / Corner Handicap resolvers).
//   · first5  — minute-stamped match events (ESPN summary `details`) decide
//     whether a goal / corner / card / penalty happened inside the opening
//     window; the aggregator's full-match totals only ever prove the NEGATIVE
//     side (a zero total proves the event never happened anywhere in the
//     match, a non-zero total says nothing about the first five minutes, so
//     the pick stays pending until a timeline is available).

/** An event counts as "in the first 5 minutes" when its match minute is ≤ 5. */
const FIRST5_WINDOW_MINUTES = 5;

type First5Family = "goal" | "corner" | "card" | "penalty";

/** One entry of the ESPN summary `details` event timeline. */
interface EspnTimelineEvent {
  type?: { text?: string } | null;
  clock?: { displayValue?: string; value?: number } | null;
}

/** Which First 5 Minutes family a stored market label belongs to. */
export function first5FamilyOf(market: string): First5Family | null {
  const m = market.toLowerCase();
  if (m.includes("goal")) return "goal";
  if (m.includes("corner")) return "corner";
  if (m.includes("card")) return "card";
  if (m.includes("penalty")) return "penalty";
  return null;
}

/**
 * Match minute of a timeline event. `displayValue` looks like "5'", "45+2'" or
 * "90+4'"; stoppage time is folded into the running minute so an event at
 * 45+2 counts as minute 47. Falls back to the seconds `value` when the display
 * string is missing or unparsable.
 */
export function eventMinute(clock: EspnTimelineEvent["clock"]): number | null {
  const raw = clock?.displayValue ?? "";
  const match = raw.match(/(\d+)(?:\s*\+\s*(\d+))?/);
  if (match) {
    const base = Number(match[1]);
    const stoppage = match[2] ? Number(match[2]) : 0;
    const minute = base + stoppage;
    return Number.isFinite(minute) ? minute : null;
  }
  const seconds = clock?.value;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds / 60);
  }
  return null;
}

/**
 * Whether a timeline event's type belongs to a First 5 Minutes family:
 *   goal    — "Goal", "Own Goal" and scored penalties (a scored penalty IS a goal)
 *   corner  — "Corner Kick"
 *   card    — "Yellow Card" / "Red Card" (any card)
 *   penalty — any awarded penalty ("Penalty - Scored" / "Saved" / "Missed" / VAR awards)
 */
export function eventMatchesFamily(typeText: string, family: First5Family): boolean {
  const t = typeText.toLowerCase();
  switch (family) {
    case "goal":
      return t.includes("goal") || t.includes("penalty - scored");
    case "corner":
      return t.includes("corner");
    case "card":
      return t.includes("card");
    case "penalty":
      return t.includes("penalty");
  }
}

/** Full-match total for a family from the canonical stats, or null if unknowable. */
export function first5TotalFromStats(
  family: First5Family,
  stats: CanonicalMatchStats | null,
): number | null {
  if (!stats) return null;
  const h = stats.home;
  const a = stats.away;
  const sum = (...values: Array<number | null>): number | null =>
    values.some((v) => v === null)
      ? null
      : values.reduce<number>((acc, v) => acc + (v ?? 0), 0);
  switch (family) {
    case "goal":
      return sum(h.goals, a.goals);
    case "corner":
      return sum(h.corners, a.corners);
    case "card":
      return sum(h.yellowCards, a.yellowCards, h.redCards, a.redCards);
    case "penalty":
      return sum(h.penalties, a.penalties);
  }
}

/**
 * The most authoritative full-match total available for a family. For goals
 * the final score IS the goal count, so it needs no stats object at all.
 */
function first5AuthoritativeTotal(
  family: First5Family,
  result: MatchResult,
  stats: CanonicalMatchStats | null,
): number | null {
  if (family === "goal") return result.homeScore + result.awayScore;
  return first5TotalFromStats(family, stats);
}

/**
 * Resolve one stored First 5 Minutes pick (market + "Yes"/"No" selection)
 * against real match data. Returns WIN | LOSS, or null while the outcome
 * cannot be determined honestly yet (the next cron run retries).
 *
 *   1. Minute-stamped timeline — an event of the family inside the window
 *      proves "Yes"; a timeline that is complete for the family (it saw at
 *      least as many family events as the aggregate total) proves "No".
 *   2. Aggregate totals — a zero full-match total proves the event never
 *      happened, settling "No" as a win and "Yes" as a loss. A non-zero
 *      total alone never guesses: the pick stays pending.
 */
export function resolveFirst5Outcome(
  market: string,
  selection: string,
  result: MatchResult,
  stats: CanonicalMatchStats | null,
  timeline: EspnTimelineEvent[] | null,
): "WIN" | "LOSS" | null {
  const family = first5FamilyOf(market);
  if (!family) return null;
  const sel = selection.trim().toLowerCase();
  if (sel !== "yes" && sel !== "no") return null;
  const wantsYes = sel === "yes";

  const total = first5AuthoritativeTotal(family, result, stats);

  // 1) Minute-stamped event timeline — direct first-5 evidence.
  if (timeline && timeline.length > 0) {
    const early = timeline.some((event) => {
      if (!eventMatchesFamily(event.type?.text ?? "", family)) return false;
      const minute = eventMinute(event.clock);
      return minute !== null && minute <= FIRST5_WINDOW_MINUTES;
    });
    // A detected early event is always trustworthy.
    if (early) return wantsYes ? "WIN" : "LOSS";
    // No early event: trustworthy only when the timeline is complete for the
    // family — a partial feed must never fabricate a "No".
    const timelineTotal = timeline.filter((event) =>
      eventMatchesFamily(event.type?.text ?? "", family),
    ).length;
    if (total === null || timelineTotal >= total) return wantsYes ? "LOSS" : "WIN";
  }

  // 2) Aggregate totals — only ever prove the negative side.
  if (total === 0) return wantsYes ? "LOSS" : "WIN";

  return null;
}

/**
 * ESPN's event timeline (`details` array of the summary endpoint — the same
 * payload fetchEspnBoxscore reads). Returns null for non-ESPN events (their
 * ids are provider-namespaced with a colon) or when no timeline exists.
 */
async function fetchEspnEventTimeline(
  leagueSlug: string | null | undefined,
  eventId: string,
): Promise<EspnTimelineEvent[] | null> {
  if (!leagueSlug || leagueSlug.includes(":") || !eventId || eventId.includes(":")) return null;
  const data = await resilientJson<{ details?: EspnTimelineEvent[] }>(
    `https://site.api.espn.com/apis/site/v2/sports/soccer/${leagueSlug}/summary?event=${eventId}`,
    { revalidate: 600 },
  ).catch(() => null);
  const details = data?.details;
  return Array.isArray(details) && details.length > 0 ? details : null;
}

interface FeatureSettlePass {
  /** Legacy rankingMode='S' rows tagged feature='corners' by the backfill. */
  backfilledCorners: number;
  /** Corner picks settled this run. */
  corners: number;
  /** First 5 Minutes picks settled this run. */
  first5: number;
  won: number;
  lost: number;
  push: number;
  voided: number;
  stillPending: number;
  failed: number;
  /** Distinct matches with at least one feature pick settled this run. */
  matches: number;
  resolvedByLeague: Record<string, number>;
}

/** Stamp a settled detail entry: WIN → HIT, LOSS → MISS, pushes/voids kept. */
function detailOutcomeForUpdate(outcome: string): string {
  return outcome === "WIN" ? "HIT" : outcome === "LOSS" ? "MISS" : outcome;
}

export async function settleFeaturePicks(force = false): Promise<FeatureSettlePass> {
  const pass: FeatureSettlePass = {
    backfilledCorners: 0, corners: 0, first5: 0, won: 0, lost: 0, push: 0,
    voided: 0, stillPending: 0, failed: 0, matches: 0, resolvedByLeague: {},
  };

  // Legacy backfill: every rankingMode='S' row is a Sure Bet Corners pick by
  // definition — tag it so /performance/corners covers the full history.
  try {
    const backfill = await db
      .update(performanceLog)
      .set({ feature: "corners" })
      .where(and(
        eq(performanceLog.rankingMode, "S"),
        isNull(performanceLog.feature),
        isNotNull(performanceLog.market),
      ));
    pass.backfilledCorners = backfill.rowCount ?? 0;
  } catch {
    // best-effort — retried on the next sweep
  }

  const pending = await db
    .select()
    .from(performanceLog)
    .where(and(isNotNull(performanceLog.feature), eq(performanceLog.outcome, "pending")))
    .limit(SWEEP_LIMIT(force));
  if (pending.length === 0) return pass;

  // Group by eventId so each match's result + stats + timeline is fetched once.
  const byEvent = new Map<string, Array<typeof performanceLog.$inferSelect>>();
  for (const row of pending) {
    const group = byEvent.get(row.eventId) ?? [];
    group.push(row);
    byEvent.set(row.eventId, group);
  }

  const seeded = await seedResultsFromFixtureFeed();

  const resultCache = new Map<string, MatchResult | null>();
  const statsCache = new Map<string, CanonicalMatchStats | null>();
  const timelineCache = new Map<string, EspnTimelineEvent[] | null>();

  const recordResolved = (leagueSlug: string | null | undefined) => {
    const label = LEAGUE_MAP[leagueSlug ?? ""]?.name ?? leagueSlug ?? "Unknown League";
    pass.resolvedByLeague[label] = (pass.resolvedByLeague[label] ?? 0) + 1;
  };

  for (const [eventId, picks] of byEvent) {
    const first = picks[0];
    try {
      let result: MatchResult | null = null;
      const resultKey = `${first.leagueSlug ?? ""}|${eventId}`;
      if (!resultCache.has(resultKey)) {
        resultCache.set(
          resultKey,
          matchFeedResult(seeded, eventId, first.leagueSlug ?? "", first.matchLabel, first.matchDate) ??
            (await lookupMultiSourceResult({
              eventId,
              leagueSlug: first.leagueSlug,
              matchLabel: first.matchLabel,
              matchDate: first.matchDate,
            })),
        );
      }
      result = resultCache.get(resultKey) ?? null;

      if (!result) {
        // The match has not finished anywhere yet — every pick stays pending.
        pass.stillPending += picks.length;
        continue;
      }

      // Cache-first canonical stats, exactly like the settlement engine.
      const statsKey = `${result.leagueSlug}|${result.eventId}`;
      if (!statsCache.has(statsKey)) {
        const query = {
          leagueSlug: result.leagueSlug,
          eventId: result.eventId,
          homeTeam: result.homeName,
          awayTeam: result.awayName,
          date: result.date,
          // Settlement rows are finished matches: per-match stats only.
          state: "post" as const,
        };
        statsCache.set(
          statsKey,
          statsAggregator.peek(query) ??
            (await statsAggregator.fetch(query).catch(() => null)),
        );
      }
      const stats = statsCache.get(statsKey) ?? null;

      // Minute-stamped event timeline — only needed for first5 picks.
      if (picks.some((pick) => pick.feature === "first5")) {
        const timelineKey = `${result.leagueSlug}|${result.eventId}`;
        if (!timelineCache.has(timelineKey)) {
          timelineCache.set(
            timelineKey,
            await fetchEspnEventTimeline(result.leagueSlug, result.eventId),
          );
        }
      }
      const timeline = timelineCache.get(`${result.leagueSlug}|${result.eventId}`) ?? null;

      for (const pick of picks) {
        try {
          // Market-family separation lives HERE, in the settlement logic — not
          // in the row-selection query. Only the dedicated feature families are
          // evaluated by this pass. A row with no feature (the ranking-mode
          // rows, feature IS NULL) must never be settled as a feature pick: it
          // belongs to the ranking-mode passes and the performance refresh, and
          // letting it fall through below would leave `outcome` unresolved and
          // wrongly VOID it once the stats grace elapsed.
          if (pick.feature !== "corners" && pick.feature !== "first5") continue;
          const market = pick.market ?? "";
          const selection = pick.selection ?? "";
          let outcome: "WIN" | "LOSS" | "PUSH" | "VOID" | null = null;
          if (pick.feature === "corners") {
            outcome = resolveSureCornerOutcome(market, selection, result, stats);
          } else if (pick.feature === "first5") {
            outcome = resolveFirst5Outcome(market, selection, result, stats, timeline);
          }
          if (outcome === null || outcome === undefined) {
            // The match has a confirmed final result but the data this feature
            // needs (corner counts / first-5 event timeline) is still missing.
            // Inside the 24h grace the pick waits — feeds publish late; once
            // the grace elapsed, no future run can honestly resolve it, so
            // the market is VOIDED (stake returned) instead of rotting in
            // 'pending' forever.
            if (statsGraceElapsed(result)) {
              outcome = "VOID";
              console.log(
                `[Settle] ${pick.matchLabel} — ${market || "Unknown market"}: VOID ` +
                `(no stats after ${STATS_SETTLEMENT_GRACE_HOURS}h grace)`,
              );
            } else {
              pass.stillPending++;
              continue;
            }
          }

          // Guarded update: only settle rows still 'pending' so a concurrent
          // run (or the sure-corners verify endpoint) can never settle the
          // same pick twice.
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
              accuracy: outcome === "WIN" ? 1 : 0,
              top10Detail: previousDetail.map((entry) =>
                entry.name === market
                  ? { ...entry, outcome: detailOutcomeForUpdate(outcome) }
                  : entry,
              ),
            })
            .where(and(eq(performanceLog.id, pick.id), eq(performanceLog.outcome, "pending")))
            .returning({ id: performanceLog.id });

          if (!changed[0]) {
            pass.failed++;
            continue;
          }

          if (pick.feature === "corners") pass.corners++;
          else pass.first5++;
          pass.matches++;
          recordResolved(pick.leagueSlug);
          if (outcome === "WIN") pass.won++;
          else if (outcome === "LOSS") pass.lost++;
          else if (outcome === "PUSH") pass.push++;
          else pass.voided++;
          console.log(
            `[Settle] Feature ${pick.feature} · ${pick.matchLabel}: ${market} → ${selection} ${outcome}`,
          );
        } catch {
          pass.failed++;
        }
      }
    } catch {
      pass.failed += picks.length;
    }
  }

  for (const [league, resolved] of Object.entries(pass.resolvedByLeague)) {
    console.log(`[Settle] Resolved ${resolved} feature pick(s) for ${league}`);
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
  featurePicks: FeatureSettlePass;
  refreshedPerformanceRows: number;
  performanceRefresh: PerformanceRefreshResult;
  /** Aggregated per-MARKET outcome tally for the whole sweep. */
  markets: { resolved: number; win: number; loss: number; push: number; void: number; pending: number };
  /** Distinct finished matches touched across all passes. */
  matches: number;
  /** Pending markets past the 24h grace — the escalation keeps this at 0. */
  stuckPending: number;
  legacyBackfill: { performanceRows: number; valueBetRows: number; slipRows: number };
  failures: string[];
  totalPending: number;
  resolved: number;
  failed: number;
  ranAt: string;
}

async function countPendingRows(): Promise<number> {
  // Two performance_log terms, two different notions of "pending":
  //   · `performance`   — rows with unsettled Top-10 markets (the `pending`
  //                       market counter > 0). Covers regular ranking-mode rows
  //                       (feature IS NULL) AND feature rows; this is the count
  //                       the refresh pass sweeps.
  //   · `featurePicks`  — dedicated feature rows whose ROW-level `outcome`
  //                       column is still 'pending'. That column is only ever
  //                       stamped by the feature pass and the sure-corners
  //                       verify endpoint, so it is meaningless for regular
  //                       rows — filtering on it alone here would either
  //                       double-count settled feature rows or, if the feature
  //                       clause were dropped, count every regular row ever
  //                       written. Keep both terms.
  const [daily, value, slips, performance, featurePicks] = await Promise.all([
    db.select({ value: count() }).from(dailyPicks).where(eq(dailyPicks.status, "pending")),
    db.select({ value: count() }).from(valueBetLog).where(eq(valueBetLog.outcome, "pending")),
    db.select({ value: count() }).from(savedSlips).where(eq(savedSlips.status, "pending")),
    db.select({ value: count() }).from(performanceLog).where(gt(performanceLog.pending, 0)),
    db.select({ value: count() }).from(performanceLog)
      .where(and(isNotNull(performanceLog.feature), eq(performanceLog.outcome, "pending"))),
  ]);
  return Number(daily[0]?.value ?? 0) + Number(value[0]?.value ?? 0) + Number(slips[0]?.value ?? 0) +
    Number(performance[0]?.value ?? 0) + Number(featurePicks[0]?.value ?? 0);
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
    dailyPicks: 0, valueBets: 0, accumulators: 0, won: 0, lost: 0, void: 0, push: 0,
    stillPending: 0, failed: 0, stuckPending: 0, matches: 0,
    markets: { resolved: 0, win: 0, loss: 0, push: 0, void: 0, pending: 0 },
    resolvedByLeague: {},
  };
  try {
    multiSource = await settlePendingAcrossAllSources(force);
  } catch (err) {
    failures.push(`multi-source settlement: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3) Dedicated feature picks — Sure Bet Corners (feature = 'corners') and
  //    First 5 Minutes (feature = 'first5').
  let featurePicks: FeatureSettlePass = {
    backfilledCorners: 0, corners: 0, first5: 0, won: 0, lost: 0, push: 0, voided: 0,
    stillPending: 0, failed: 0, matches: 0, resolvedByLeague: {},
  };
  try {
    featurePicks = await settleFeaturePicks(force);
  } catch (err) {
    failures.push(`feature pick settlement: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4) Refresh performance rows with late-arriving boxscores (and VOID the
  //    markets no source will ever provide once the 24h grace elapsed).
  let performanceRefresh: PerformanceRefreshResult = { resolved: 0, voided: 0, win: 0, loss: 0, push: 0, matches: 0 };
  try {
    performanceRefresh = await refreshPendingPerformanceRows(force);
  } catch (err) {
    failures.push(`performance refresh: ${err instanceof Error ? err.message : String(err)}`);
  }
  const refreshedPerformanceRows = performanceRefresh.resolved;

  // 5) Legacy league field backfill.
  let legacyBackfill = { performanceRows: 0, valueBetRows: 0, slipRows: 0 };
  try {
    legacyBackfill = await backfillLegacyLeagueFields();
  } catch (err) {
    failures.push(`legacy backfill: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(
    `[Cron][settle] engine settled ${engine?.settled.total ?? 0} · multi-source settled ` +
    `${multiSource.dailyPicks + multiSource.valueBets + multiSource.accumulators} ` +
    `(${multiSource.stillPending} still pending) · feature picks settled ` +
    `${featurePicks.corners + featurePicks.first5} ` +
    `(${featurePicks.stillPending} still pending, ${featurePicks.backfilledCorners} legacy rows backfilled) · ` +
    `refreshed ${refreshedPerformanceRows} performance rows · ` +
    `legacy backfill ${legacyBackfill.performanceRows + legacyBackfill.valueBetRows + legacyBackfill.slipRows} rows`,
  );

  const resolved = (engine?.settled.total ?? 0) + multiSource.dailyPicks + multiSource.valueBets +
    multiSource.accumulators + featurePicks.corners + featurePicks.first5 + refreshedPerformanceRows;

  // ── End-of-run summary over EVERY market the sweep touched (Part 4) ───────
  const markets = {
    resolved:
      (engine?.markets.resolved ?? 0) + multiSource.markets.resolved +
      featurePicks.won + featurePicks.lost + featurePicks.push + featurePicks.voided +
      performanceRefresh.win + performanceRefresh.loss + performanceRefresh.push + performanceRefresh.voided,
    win:
      (engine?.markets.win ?? 0) + multiSource.markets.win + featurePicks.won + performanceRefresh.win,
    loss:
      (engine?.markets.loss ?? 0) + multiSource.markets.loss + featurePicks.lost + performanceRefresh.loss,
    push:
      (engine?.markets.push ?? 0) + multiSource.markets.push + featurePicks.push + performanceRefresh.push,
    void:
      (engine?.markets.void ?? 0) + multiSource.markets.void + featurePicks.voided + performanceRefresh.voided,
    pending: (engine?.markets.pending ?? 0) + multiSource.markets.pending + featurePicks.stillPending,
  };
  const matches =
    (engine?.matches ?? 0) + multiSource.matches + featurePicks.matches + performanceRefresh.matches;
  // Stuck = still pending on a match already past the grace window. The
  // escalation above guarantees this is 0; the counter alarms on regressions.
  const stuckPending = (engine?.stuckPending ?? 0) + multiSource.stuckPending;
  console.log(
    `[Settle] Run complete: ${matches} matches, ${markets.resolved} markets resolved ` +
    `(WIN ${markets.win}, LOSS ${markets.loss}, PUSH ${markets.push}, VOID ${markets.void}), ` +
    `${stuckPending} stuck pending`,
  );

  return {
    ok: failures.length === 0, engine, multiSource, featurePicks, refreshedPerformanceRows,
    performanceRefresh, markets, matches, stuckPending,
    legacyBackfill, failures, totalPending, resolved,
    failed: multiSource.failed + featurePicks.failed + failures.length,
    ranAt: new Date().toISOString(),
  };
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
