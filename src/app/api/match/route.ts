import { db } from "@/db";
import { predictions, performanceLog, valueBetLog } from "@/db/schema";
import { fetchSummary, type FixtureLite } from "@/lib/espn";
import type { RankingMode } from "@/lib/engine/selector";
import { resolveRankingMode } from "@/lib/engine/selector";
import { runEngineFromRealWithProfiles, evaluateFinishedMatch } from "@/lib/engine";
import { findValueBets, type BookmakerOdds, type ValueBet } from "@/lib/engine/value";
import { evaluateLeg } from "@/lib/settlement/evaluate";
import { searchFixture, getMultiBookOdds } from "@/lib/apiFootball";
import { LEAGUE_MAP } from "@/lib/leagues";
import { withMonitoring } from "@/lib/monitoring";
import { simulateMatch } from "@/lib/data/monteCarlo";
import { getRhoForLeague } from "@/lib/data/dixonColes";
import { statsAggregator } from "@/lib/data/aggregator";
import { MATCH_STAT_FIELDS, type CanonicalMatchStats, type StatKey } from "@/lib/data/types";

export const dynamic = "force-dynamic";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// ─── ESPN types ───────────────────────────────────────────────────────────────

interface BoxStat {
  name: string;
  displayValue: string;
}

interface EspnTeamStats {
  statistics?: BoxStat[];
}

interface EspnBoxscoreResponse {
  boxscore?: { teams?: EspnTeamStats[] };
}

interface EspnPickcenter {
  provider?:    { name?: string };
  overUnder?:   number;
  moneyline?: {
    home?: { close?: { odds?: number }; open?: { odds?: number } };
    draw?: { close?: { odds?: number }; open?: { odds?: number } };
    away?: { close?: { odds?: number }; open?: { odds?: number } };
  };
  total?: {
    over?:  { close?: { odds?: number }; open?: { odds?: number } };
    under?: { close?: { odds?: number }; open?: { odds?: number } };
  };
  pointSpread?: {
    home?: { close?: { odds?: number; line?: number } };
    away?: { close?: { odds?: number } };
  };
}

interface EspnSummaryWithPickcenter {
  pickcenter?: EspnPickcenter[];
}

// ─── Boxscore fetch ───────────────────────────────────────────────────────────

async function fetchBoxscore(
  slug: string,
  eventId: string,
): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`${ESPN_BASE}/${slug}/summary?event=${eventId}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    const data = await res.json() as EspnBoxscoreResponse;
    const teams = data.boxscore?.teams;
    if (!teams || teams.length < 2) return null;

    const parse = (stats: BoxStat[]): Record<string, number> => {
      const m: Record<string, number> = {};
      for (const s of stats) m[s.name] = parseFloat(s.displayValue) || 0;
      return m;
    };

    const home = parse(teams[0]?.statistics ?? []);
    const away = parse(teams[1]?.statistics ?? []);

    return {
      homeGoals:         home.totalGoals           ?? 0, awayGoals:         away.totalGoals           ?? 0,
      homeShots:         home.totalShots            ?? 0, awayShots:         away.totalShots            ?? 0,
      homeSot:           home.shotsOnTarget         ?? 0, awaySot:           away.shotsOnTarget         ?? 0,
      homeCorners:       home.wonCorners            ?? 0, awayCorners:       away.wonCorners            ?? 0,
      homeCards:         home.yellowCards           ?? 0, awayCards:         away.yellowCards           ?? 0,
      homeFouls:         home.foulsCommitted        ?? 0, awayFouls:         away.foulsCommitted        ?? 0,
      homeOffsides:      home.offsides              ?? 0, awayOffsides:      away.offsides              ?? 0,
      homeSaves:         home.saves                 ?? 0, awaySaves:         away.saves                 ?? 0,
      homeInterceptions: home.interceptions         ?? 0, awayInterceptions: away.interceptions         ?? 0,
      homeTackles:       home.totalTackles          ?? 0, awayTackles:       away.totalTackles          ?? 0,
      homeClearances:    home.totalClearance        ?? 0, awayClearances:    away.totalClearance        ?? 0,
      homePasses:        home.totalPasses           ?? 0, awayPasses:        away.totalPasses           ?? 0,
      homeRedCards:      home.redCards              ?? 0, awayRedCards:      away.redCards              ?? 0,
      homePenaltyGoals:  home.penaltyKickGoals      ?? 0, awayPenaltyGoals:  away.penaltyKickGoals      ?? 0,
    };
  } catch {
    return null;
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

/**
 * Parse the `?ranking=` query param. Accepts "A", "B", "C", "D", or the special
 * "all" sentinel that triggers a single-response payload containing all four
 * ranking modes (A Classic 11-factor, B 12-Factor, C Hybrid, D Consensus). Anything else
 * falls back to the env-var default (B).
 */
type RankingRequest = RankingMode | "all";

function parseRankingMode(req: Request): RankingRequest {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get('ranking');
    if (q) {
      const upper = q.toUpperCase();
      if (upper === 'A' || upper === 'B' || upper === 'C' || upper === 'D') return upper as RankingMode;
      if (upper === 'ALL') return 'all';
    }
  } catch {
    /* fall through */
  }
  return resolveRankingMode(undefined);
}

type EngineResult = Awaited<ReturnType<typeof runEngineFromRealWithProfiles>>;
type MatchSummaryLite = Awaited<ReturnType<typeof fetchSummary>>;

/**
 * Run the engine for a single ranking mode. Sets RANKING_MODE for the duration
 * of the call so the selector picks up the requested mode via
 * `resolveRankingMode`. The env var is restored in a `finally` block.
 */
async function runEngineForMode(
  fixture: FixtureLite,
  summary: MatchSummaryLite,
  liveStats: Record<string, number> | null,
  rankingMode: RankingMode,
): Promise<EngineResult> {
  const prevRankingEnv = process.env.RANKING_MODE;
  process.env.RANKING_MODE = rankingMode;
  try {
    return await runEngineFromRealWithProfiles(fixture, summary, liveStats, rankingMode);
  } finally {
    if (prevRankingEnv === undefined) delete process.env.RANKING_MODE;
    else process.env.RANKING_MODE = prevRankingEnv;
  }
}

/**
 * Persist one prediction + performance log row, and evaluate the post-match
 * top-10 against the real boxscore when applicable. Wraps the side effects the
 * single-mode route has always performed, so the engine output reaches the
 * DB unchanged. Failures here are logged and swallowed — they must never
 * fail the request.
 */
async function persistAndEvaluate(
  fixture: FixtureLite,
  prediction: EngineResult,
  rankingMode: RankingMode,
  valueBets: ValueBet[] = [],
): Promise<Record<string, number> | null> {
  // ── Post-match: fetch real boxscore, verify Top-10, log performance ──────────
  let boxscore: Record<string, number> | null = null;
  if (fixture.state === "post" && fixture.home.score !== null) {
    boxscore = await fetchBoxscore(fixture.leagueSlug, fixture.id);
    evaluateFinishedMatch(fixture, prediction, boxscore);

    const h     = prediction.hitCount ?? 0;
    const evalC = prediction.evaluatedCount ?? 0;
    const miss  = prediction.top10.filter((m) => m.outcome === "MISS").length;
    const pend  = prediction.top10.filter((m) => m.outcome === "PENDING" || !m.outcome).length;

    try {
      await db.insert(performanceLog).values({
        eventId:         fixture.id,
        matchLabel:      `${fixture.home.name} vs ${fixture.away.name}`,
        homeTeam:        fixture.home.name,
        awayTeam:        fixture.away.name,
        league:          fixture.leagueName,
        leagueSlug:      fixture.leagueSlug,
        competitionName: fixture.leagueName,
        matchDate:       fixture.date.slice(0, 10),
        homeScore:       Number(fixture.home.score) || 0,
        awayScore:       Number(fixture.away.score) || 0,
        totalPicks:      prediction.top10.length,
        hits:            h,
        misses:          miss,
        pending:         pend,
        accuracy:        evalC > 0 ? h / evalC : 0,
        top10Detail:     prediction.top10.map((m) => {
          const odds = m.marketOdds ?? m.fairOdds ?? null;
          return {
            name:      m.name,
            selection: m.selection,
            hitRate:   m.hitRate,
            outcome:   m.outcome,
            family:    m.family,
            reason:    m.reason,
            odds,
            // Edge vs market (hitRate × odds − 1); null when no market price.
            ev:        odds !== null ? Math.round((m.hitRate * odds - 1) * 1000) / 1000 : null,
            // Per-pick ranking-factor breakdown (factor label → 0..1
            // contribution) so the dashboard's factor analysis uses the REAL
            // weights the selector applied, not derived family buckets.
            factors:   m.factors ?? null,
          };
        }),
        rankingMode,
      });
    } catch (e) {
      console.error("performance log failed", e);
    }
  }

  // ── Persist value bets for this ranking mode ─────────────────────────────────
  if (valueBets.length > 0) {
    const isPost = fixture.state === "post" && fixture.home.score !== null;
    const result = isPost ? {
      eventId: fixture.id,
      leagueSlug: fixture.leagueSlug,
      date: fixture.date,
      homeName: fixture.home.name,
      awayName: fixture.away.name,
      homeScore: Number(fixture.home.score) || 0,
      awayScore: Number(fixture.away.score) || 0,
    } : null;

    for (const vb of valueBets) {
      try {
        const stake = 10;
        const outcome = result
          ? evaluateLeg({ marketName: vb.market.name, selection: vb.market.selection }, result)
          : "pending";
        const actualReturn =
          outcome === "won" ? stake * vb.bookDecimalOdds : outcome === "void" ? stake : outcome === "lost" ? 0 : null;

        await db.insert(valueBetLog).values({
          eventId:         fixture.id,
          leagueSlug:      fixture.leagueSlug,
          competitionName: fixture.leagueName,
          match:           `${fixture.home.name} vs ${fixture.away.name}`,
          matchDate:       fixture.date.slice(0, 10),
          marketName:      vb.market.name,
          selection:       vb.market.selection,
          oracleProb:      vb.oracleProbability,
          bookOdds:        vb.bookDecimalOdds,
          valueEdge:       vb.valueEdge,
          kellyStake:      vb.kellyStake,
          stake,
          potentialReturn: parseFloat((stake * vb.bookDecimalOdds).toFixed(2)),
          outcome,
          actualReturn,
          pnl:             actualReturn !== null ? actualReturn - stake : null,
          rankingMode,
        });
      } catch (e) {
        console.error("value bet log failed", e);
      }
    }
  }

  // ── Persist the full prediction (all states) ─────────────────────────────────
  try {
    await db.insert(predictions).values({
      matchLabel:       `${fixture.home.name} vs ${fixture.away.name}`,
      homeTeam:         fixture.home.name,
      awayTeam:         fixture.away.name,
      league:           fixture.leagueName,
      leagueSlug:       fixture.leagueSlug,
      eventId:          fixture.id,
      matchDate:        fixture.date.slice(0, 10),
      tournamentStage:  prediction.match.tournamentStage ?? "",
      topPick:          prediction.top1[0]?.name ?? "N/A",
      topHitRate:       prediction.top1[0]?.hitRate ?? 0,
      totalMarkets:     prediction.totalMarkets,
      qualifiedMarkets: prediction.qualifiedMarkets,
      dataCompleteness: prediction.match.dataCompletenessScore,
      result:           prediction,
    });
  } catch (e) {
    console.error("persist match prediction failed", e);
  }

  return boxscore;
}

/**
 * Layer 1 + 2 + 3 bookmaker-odds enrichment. Shared across all four ranking
 * modes for a given fixture (the odds do not depend on which ranking engine
 * was used). Returns { bookOdds, multiBookOdds }.
 */
async function enrichBookmakerOdds(
  fixture: FixtureLite,
  summary: MatchSummaryLite,
): Promise<{
  bookOdds: BookmakerOdds | null;
  multiBookOdds: Array<{ bookmaker: string; homeOdds: number; drawOdds: number; awayOdds: number }>;
}> {
  // ── Bookmaker odds — layer 1: ESPN summary ───────────────────────────────────
  let bookOdds: BookmakerOdds | null = null;
  if (summary?.odds) {
    const o = summary.odds;
    bookOdds = {
      provider:  o.provider ?? "DraftKings",
      homeML:    o.homeML    ?? undefined,
      drawML:    o.drawML    ?? undefined,
      awayML:    o.awayML    ?? undefined,
      overUnder: o.overUnder ?? undefined,
    };
  }

  // ── Bookmaker odds — layer 2: ESPN pickcenter (richer, line history) ─────────
  try {
    const summaryRes = await fetch(
      `${ESPN_BASE}/${fixture.leagueSlug}/summary?event=${fixture.id}`,
      { next: { revalidate: 300 } },
    );
    if (summaryRes.ok) {
      const raw = await summaryRes.json() as EspnSummaryWithPickcenter;
      const pc  = raw.pickcenter?.[0];
      if (pc) {
        bookOdds = {
          provider:       pc.provider?.name ?? bookOdds?.provider ?? "DraftKings",
          homeML:         pc.moneyline?.home?.close?.odds  ?? bookOdds?.homeML,
          drawML:         pc.moneyline?.draw?.close?.odds  ?? bookOdds?.drawML,
          awayML:         pc.moneyline?.away?.close?.odds  ?? bookOdds?.awayML,
          overUnder:      pc.overUnder                     ?? bookOdds?.overUnder,
          overOdds:       pc.total?.over?.close?.odds,
          underOdds:      pc.total?.under?.close?.odds,
          openHomeML:     pc.moneyline?.home?.open?.odds,
          openDrawML:     pc.moneyline?.draw?.open?.odds,
          openAwayML:     pc.moneyline?.away?.open?.odds,
          openOverOdds:   pc.total?.over?.open?.odds,
          openUnderOdds:  pc.total?.under?.open?.odds,
          spreadHome:     pc.pointSpread?.home?.close?.odds,
          spreadAway:     pc.pointSpread?.away?.close?.odds,
          spreadLine:     pc.pointSpread?.home?.close?.line,
        };
      }
    }
  } catch {
    // keep whatever odds we already have
  }

  // ── Bookmaker odds — layer 3: API-Football multi-book (optional) ─────────────
  const multiBookOdds: Array<{ bookmaker: string; homeOdds: number; drawOdds: number; awayOdds: number }> = [];
  if (fixture.state === "pre") {
    try {
      const apiFootballId = await searchFixture(
        fixture.home.name,
        fixture.away.name,
        fixture.date.slice(0, 10),
      );
      if (apiFootballId) {
        const multiOdds = await getMultiBookOdds(apiFootballId);
        if (multiOdds) {
          multiBookOdds.push(...multiOdds.bookmakers);
          // Prefer Pinnacle (sharpest market); fall back to first bookmaker
          const pinnacle = multiOdds.bookmakers.find((b) => b.bookmaker === "Pinnacle");
          const best     = pinnacle ?? multiOdds.bookmakers[0];
          if (best) {
            const toML = (dec: number) =>
              dec >= 2 ? (dec - 1) * 100 : -100 / (dec - 1);
            bookOdds = {
              ...(bookOdds ?? {}),
              provider: best.bookmaker,
              homeML:   toML(best.homeOdds),
              drawML:   toML(best.drawOdds),
              awayML:   toML(best.awayOdds),
            };
          }
        }
      }
    } catch {
      // API-Football is optional enrichment — never fail the request
    }
  }

  return { bookOdds, multiBookOdds };
}

/** Detect value bets for a given ranking mode's market set. */
function computeValueBets(
  prediction: EngineResult,
  bookOdds: BookmakerOdds | null,
  fixture: FixtureLite,
): ValueBet[] {
  if (!bookOdds || fixture.state !== "pre") return [];
  return findValueBets(
    prediction.markets,
    bookOdds,
    fixture.home.name,
    fixture.away.name,
  );
}

// ─── Top 10 Criteria + Monte Carlo response enrichment ───────────────────────

/** Predicted 1X2 outcome label surfaced by both prediction banners. */
export type PredictedWinner = "Home Win" | "Draw" | "Away Win";
export type PredictionDataQuality = "Real" | "Mixed" | "Synthetic";

export interface Top10CriteriaPrediction {
  winner: PredictedWinner | null;
  winnerProbability: number | null;
  scoreline: string | null;
  scorelineProbability: number | null;
  dataQuality: PredictionDataQuality | null;
  available: boolean;
  reason: string | null;
}

export interface MonteCarloPrediction {
  winner: PredictedWinner;
  winnerProbability: number;
  scoreline: string;
  scorelineProbability: number;
  dataQuality: PredictionDataQuality;
}

/**
 * Additive response fields. The legacy flat Monte Carlo fields are retained
 * below for cached clients; the nested objects are the explicit API contract
 * consumed by the match-detail panel.
 */
export interface MatchPredictionExtras {
  winningTeam: PredictedWinner;
  winningTeamProbability: number;
  expectedScoreline: string;
  expectedScorelineProbability: number;
  /** Existing Monte Carlo quality label. */
  dataQuality: "Real" | "Synthetic";
  top10Criteria?: Top10CriteriaPrediction;
  monteCarlo?: MonteCarloPrediction;
}

function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
}

function finiteLambda(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(5, Math.max(0.05, value));
  }
  return fallback;
}

const TOP10_UNAVAILABLE_REASON = "No reliable prediction available — data quality insufficient.";

/**
 * Match OUTCOMES that cannot exist before kickoff. Including them in the
 * pre-match completeness gate makes "Real" unreachable (cleanSheet is the
 * canonical example) and was hiding otherwise-complete API-Football data.
 */
const POST_MATCH_ONLY_FIELDS = ["cleanSheet"] as const;

/**
 * Pre-match fields the Top-10 banner gate inspects. These are historical /
 * season-average inputs API-Football can supply before kickoff — the same
 * metrics the match-detail stats table displays (xG, goals, SOT, corners,
 * cards, fouls, possession). One or two optional gaps must not kill the
 * whole prediction, so the gate requires ≥ 80% of these slots (home+away).
 */
const PRE_MATCH_GATE_FIELDS: readonly StatKey[] = [
  "xg",
  "goals",
  "goalsConceded",
  "shotsOnTarget",
  "corners",
  "yellowCards",
  "fouls",
  "possession",
];

/** Fraction of applicable (pre-match or in/post) slots that must be filled. */
const TOP10_COMPLETENESS_THRESHOLD = 0.8;

interface Top10FieldInspection {
  present: number;
  total: number;
  missing: string[];
  quality: PredictionDataQuality;
  /** True when the fixture has not been played — post-match-only fields excluded. */
  preMatch: boolean;
}

function isPreMatchState(state?: "pre" | "in" | "post" | null): boolean {
  // Unknown state is treated as pre-match: cleanSheet still cannot exist, and
  // requiring it would repeat the original false-rejection.
  return state !== "in" && state !== "post";
}

function teamFieldFilled(stats: CanonicalMatchStats, side: "home" | "away", field: StatKey | "cleanSheet"): boolean {
  const value = stats[side][field];
  return value !== null && value !== undefined;
}

/**
 * Inspect the canonical stats object the selector just consumed and decide
 * whether the Top-10 banner may claim Real data.
 *
 * Pre-match: 8 core fields × 2 teams = 16 slots; cleanSheet (and any other
 * post-match-only field) is excluded. In/post: every per-match numeric field
 * plus cleanSheet. Pass mark is ≥ 80% of those slots — not 100%.
 */
function inspectTop10CriteriaFields(
  stats: CanonicalMatchStats | null,
  state?: "pre" | "in" | "post" | null,
): Top10FieldInspection {
  const preMatch = isPreMatchState(state);
  const numericFields: readonly StatKey[] = preMatch ? PRE_MATCH_GATE_FIELDS : MATCH_STAT_FIELDS;
  const includeCleanSheet = !preMatch;
  const total = numericFields.length * 2 + (includeCleanSheet ? POST_MATCH_ONLY_FIELDS.length * 2 : 0);

  if (!stats) {
    const missing = [
      ...numericFields,
      ...(includeCleanSheet ? POST_MATCH_ONLY_FIELDS : []),
    ];
    return { present: 0, total, missing: [...missing], quality: "Synthetic", preMatch };
  }

  const missing: string[] = [];
  let present = 0;

  for (const field of numericFields) {
    const homeOk = teamFieldFilled(stats, "home", field);
    const awayOk = teamFieldFilled(stats, "away", field);
    if (homeOk) present++;
    if (awayOk) present++;
    if (!homeOk || !awayOk) missing.push(field);
  }

  if (includeCleanSheet) {
    for (const field of POST_MATCH_ONLY_FIELDS) {
      const homeOk = teamFieldFilled(stats, "home", field);
      const awayOk = teamFieldFilled(stats, "away", field);
      if (homeOk) present++;
      if (awayOk) present++;
      if (!homeOk || !awayOk) missing.push(field);
    }
  }

  const ratio = total === 0 ? 0 : present / total;
  const quality: PredictionDataQuality =
    ratio >= TOP10_COMPLETENESS_THRESHOLD ? "Real" : present > 0 ? "Mixed" : "Synthetic";

  return { present, total, missing, quality, preMatch };
}

function logTop10CriteriaGate(inspection: Top10FieldInspection): void {
  const fieldLabel = inspection.preMatch ? "pre-match fields" : "fields";
  if (inspection.quality === "Real") {
    console.log(
      `[Match] top10Criteria accepted: ${inspection.present}/${inspection.total} ${fieldLabel} present`,
    );
    return;
  }
  console.log(
    `[Match] top10Criteria rejected: missing fields [${inspection.missing.join(", ")}]`,
  );
}

function emptyTop10Criteria(
  reason: string,
  dataQuality: PredictionDataQuality | null = null,
): Top10CriteriaPrediction {
  return {
    winner: null,
    winnerProbability: null,
    scoreline: null,
    scorelineProbability: null,
    dataQuality,
    available: false,
    reason,
  };
}

function marketRankValue(
  m: EngineResult["markets"][number],
  rankingMode: RankingMode,
): number {
  if (typeof m.compositeScore === "number" && Number.isFinite(m.compositeScore)) {
    // Consensus D stores average rank position, where lower is better. The
    // other modes store a higher-is-better composite score.
    return rankingMode === "D" ? -m.compositeScore : m.compositeScore;
  }
  return m.hitRate;
}

function topRankedMarket(
  markets: EngineResult["markets"],
  predicate: (market: EngineResult["markets"][number]) => boolean,
  rankingMode: RankingMode,
  includeRejected = false,
): EngineResult["markets"][number] | null {
  return [...markets]
    .filter((market) => (includeRejected || !market.rejected) && predicate(market))
    .sort((a, b) => {
      const scoreDelta = marketRankValue(b, rankingMode) - marketRankValue(a, rankingMode);
      if (Math.abs(scoreDelta) > 1e-9) return scoreDelta;
      const hitDelta = b.hitRate - a.hitRate;
      if (Math.abs(hitDelta) > 1e-9) return hitDelta;
      return a.id.localeCompare(b.id);
    })[0] ?? null;
}

function outcomeForMarket(
  market: EngineResult["markets"][number],
  fixture: FixtureLite,
): PredictedWinner | null {
  if (market.name === `Match Result: ${fixture.home.name} Win`) return "Home Win";
  if (market.name === "Match Result: Draw") return "Draw";
  if (market.name === `Match Result: ${fixture.away.name} Win`) return "Away Win";
  return null;
}

function isCorrectScoreMarket(market: EngineResult["markets"][number]): boolean {
  return /^Correct Score \d+-\d+$/.test(market.name);
}

/**
 * Read the final selector output, not a second λ/simulation, for the Top 10
 * banner. The selector has already applied the 12-factor composite, confidence
 * gate, verifiability filter, and safety net. Correct-score markets are
 * settled by the final real fixture score, so they are read from the same
 * selector-scored market pool when the legacy Top-10 verifiability list keeps
 * them out of its ten display slots.
 */
function buildTop10Criteria(
  prediction: EngineResult,
  fixture: FixtureLite,
  dataQuality: PredictionDataQuality,
  rankingMode: RankingMode,
  inspection?: Top10FieldInspection,
): Top10CriteriaPrediction {
  // The banner may only claim a prediction when ≥ 80% of the applicable
  // (pre-match or in/post) fields are present. Mixed/Synthetic means the
  // gate failed — log the exact missing field names.
  if (dataQuality !== "Real") {
    const missing = inspection?.missing ?? [];
    const reason = missing.length
      ? `${TOP10_UNAVAILABLE_REASON} Missing fields: ${missing.join(", ")}.`
      : dataQuality === "Synthetic"
        ? "Stats aggregator returned no real match statistics; the data-quality gate requires real data."
        : TOP10_UNAVAILABLE_REASON;
    return emptyTop10Criteria(reason, dataQuality);
  }

  // An empty Top-10 is the selector's explicit confidence/hard-gate failure.
  if (prediction.top10.length === 0 || prediction.top1.length === 0) {
    return emptyTop10Criteria(
      prediction.match.fallbackMode
        ? "The confidence and data-quality gates rejected this match."
        : "The confidence, verifiability, or safety gates rejected this match.",
      dataQuality,
    );
  }

  // Prefer the already-finalised Top-10 order. If the outcome family was not
  // one of the ten diverse slots, use the selector-scored pool (the same
  // composite/factors) rather than calculating an independent probability.
  // 1X2 / Correct Score lines are often Grade-D rejected on raw probability
  // (noAutoFlip + a 20–40% favourite) even when the data is Real — fall back
  // to the rejected pool so a passing field gate can still surface a banner.
  const outcome = prediction.top10.find((market) => outcomeForMarket(market, fixture))
    ?? topRankedMarket(prediction.markets, (market) => outcomeForMarket(market, fixture) !== null, rankingMode)
    ?? topRankedMarket(prediction.markets, (market) => outcomeForMarket(market, fixture) !== null, rankingMode, true);
  const scoreline = prediction.top10.find(isCorrectScoreMarket)
    ?? topRankedMarket(prediction.markets, isCorrectScoreMarket, rankingMode)
    ?? topRankedMarket(prediction.markets, isCorrectScoreMarket, rankingMode, true);

  if (!outcome) {
    return emptyTop10Criteria("No match-outcome market survived the Top 10 gates.", dataQuality);
  }
  if (!scoreline) {
    return emptyTop10Criteria("No correct-score market survived the Top 10 gates.", dataQuality);
  }

  const winner = outcomeForMarket(outcome, fixture);
  const scorelineMatch = scoreline.name.match(/^Correct Score (\d+-\d+)$/);
  if (!winner || !scorelineMatch) {
    return emptyTop10Criteria(TOP10_UNAVAILABLE_REASON, dataQuality);
  }

  return {
    winner,
    winnerProbability: round4(outcome.hitRate),
    scoreline: scorelineMatch[1],
    scorelineProbability: round4(scoreline.hitRate),
    dataQuality,
    available: true,
    reason: null,
  };
}

/**
 * Fallback when Monte Carlo is unavailable: read the model's own 1X2 and
 * Correct Score markets (analytic Poisson) so the banner still matches the
 * model's output.
 */
function fallbackExtrasFromMarkets(
  prediction: EngineResult,
  fixture: FixtureLite,
  dataQuality: "Real" | "Synthetic",
): MatchPredictionExtras {
  const homeName = fixture.home.name;
  const awayName = fixture.away.name;
  const markets = prediction.markets ?? [];

  const findHit = (predicate: (name: string) => boolean): number | null => {
    const hit = markets.find((m) => predicate(m.name))?.hitRate;
    return typeof hit === "number" && Number.isFinite(hit) ? hit : null;
  };

  const pHome =
    findHit((n) => n === `Match Result: ${homeName} Win`) ?? 0.33;
  const pDraw = findHit((n) => n === "Match Result: Draw") ?? 0.33;
  const pAway =
    findHit((n) => n === `Match Result: ${awayName} Win`) ?? 0.34;

  let winningTeam: PredictedWinner = "Home Win";
  let winningTeamProbability = pHome;
  if (pDraw >= pHome && pDraw >= pAway) {
    winningTeam = "Draw";
    winningTeamProbability = pDraw;
  } else if (pAway >= pHome && pAway >= pDraw) {
    winningTeam = "Away Win";
    winningTeamProbability = pAway;
  }

  let expectedScoreline = "1-1";
  let expectedScorelineProbability = 0;
  for (const m of markets) {
    if (!m.name.startsWith("Correct Score ")) continue;
    const score = m.name.replace("Correct Score ", "");
    if (!/^\d+-\d+$/.test(score)) continue;
    if (m.hitRate > expectedScorelineProbability) {
      expectedScoreline = score;
      expectedScorelineProbability = m.hitRate;
    }
  }

  return {
    winningTeam,
    winningTeamProbability: round4(winningTeamProbability),
    expectedScoreline,
    expectedScorelineProbability: round4(expectedScorelineProbability),
    dataQuality,
  };
}

/**
 * Run the existing Monte Carlo simulation (Dixon–Coles corrected, stratified
 * 10k draws) over the engine's goal lambdas and read off the predicted
 * winner + most likely scoreline. Purely additive — the input prediction is
 * never mutated; a new object is returned.
 */
function enrichPredictionWithMonteCarlo(
  prediction: EngineResult,
  fixture: FixtureLite,
  top10Criteria: Top10CriteriaPrediction,
): EngineResult & MatchPredictionExtras {
  const completeness = prediction.match?.dataCompletenessScore ?? 100;
  const dataQuality: "Real" | "Synthetic" =
    prediction.match?.fallbackMode === true || completeness < 45
      ? "Synthetic"
      : "Real";

  try {
    const homeLambda = finiteLambda(
      prediction.lambdas?.["λ Home Goals"] ?? prediction.deepStats?.homeXg,
      1.35,
    );
    const awayLambda = finiteLambda(
      prediction.lambdas?.["λ Away Goals"] ?? prediction.deepStats?.awayXg,
      1.15,
    );
    const rho = getRhoForLeague(fixture.leagueSlug);

    const simulation = simulateMatch({
      homeLambda,
      awayLambda,
      rho,
      options: {
        simulations: 10_000,
        maxGoals: 5,
        method: "stratified",
        topScorelines: 10,
      },
    });

    const pHome = simulation.markets.homeWin;
    const pDraw = simulation.markets.draw;
    const pAway = simulation.markets.awayWin;

    let winningTeam: PredictedWinner = "Home Win";
    let winningTeamProbability = pHome;
    if (pDraw >= pHome && pDraw >= pAway) {
      winningTeam = "Draw";
      winningTeamProbability = pDraw;
    } else if (pAway >= pHome && pAway >= pDraw) {
      winningTeam = "Away Win";
      winningTeamProbability = pAway;
    }

    const top = simulation.topScorelines[0];
    const extras: MatchPredictionExtras = {
      winningTeam,
      winningTeamProbability: round4(winningTeamProbability),
      expectedScoreline: top?.score ?? "1-1",
      expectedScorelineProbability: round4(top?.probability ?? 0),
      dataQuality,
      top10Criteria,
      monteCarlo: {
        winner: winningTeam,
        winnerProbability: round4(winningTeamProbability),
        scoreline: top?.score ?? "1-1",
        scorelineProbability: round4(top?.probability ?? 0),
        dataQuality,
      },
    };
    return { ...prediction, ...extras };
  } catch {
    const fallback = fallbackExtrasFromMarkets(prediction, fixture, dataQuality);
    return {
      ...prediction,
      ...fallback,
      top10Criteria,
      monteCarlo: {
        winner: fallback.winningTeam,
        winnerProbability: fallback.winningTeamProbability,
        scoreline: fallback.expectedScoreline,
        scorelineProbability: fallback.expectedScorelineProbability,
        dataQuality: fallback.dataQuality,
      },
    };
  }
}

async function handlePost(req: Request): Promise<Response> {
  // Ranking mode: ?ranking=A|B|C|D|all — A = Classic 11-factor, B = 12-Factor,
  // C = Hybrid (A+B averaged), D = Consensus, "all" returns every mode in a single response.
  const rankingRequest = parseRankingMode(req);
  const isAll = rankingRequest === 'all';
  const rankingMode: RankingMode = isAll ? 'B' : rankingRequest;

  let fixture: FixtureLite;
  try {
    const body = await req.json() as { fixture?: FixtureLite };
    fixture = body.fixture as FixtureLite;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!fixture?.id || !fixture?.leagueSlug || !fixture?.home || !fixture?.away) {
    return Response.json({ error: "Missing fixture data." }, { status: 400 });
  }
  // Fixtures discovered through ESPN's comprehensive global scoreboard carry
  // the special `all` slug. ESPN supports it for summary/boxscore requests, so
  // accept it even though it is not a browsable league in our local catalog.
  if (fixture.leagueSlug !== "all" && !LEAGUE_MAP[fixture.leagueSlug]) {
    return Response.json({ error: "Unknown league." }, { status: 400 });
  }

  const summary = await fetchSummary(fixture.leagueSlug, fixture.id);

  // For LIVE matches, fetch current in-play stats so the engine can calibrate
  // against live reality
  let liveStats: Record<string, number> | null = null;
  if (fixture.state === "in") {
    liveStats = await fetchBoxscore(fixture.leagueSlug, fixture.id);
  }

  // Bookmaker odds are ranking-independent — fetched once and shared.
  const { bookOdds, multiBookOdds } = await enrichBookmakerOdds(fixture, summary);

  // ── Run the engine for one (single mode) or four (all) ranking modes ────────
  const modes: RankingMode[] = isAll ? ['A', 'B', 'C', 'D'] : [rankingMode];
  const predictions = new Map<RankingMode, EngineResult>();
  for (const mode of modes) {
    predictions.set(mode, await runEngineForMode(fixture, summary, liveStats, mode));
  }

  // The engine has just consumed this exact aggregator cache entry for the
  // Top-10 factors. Reading it back avoids a second stats source or a banner-
  // only quality calculation; a null peek is the same synthetic fallback the
  // engine saw when no canonical source contributed data.
  const statsInspection = inspectTop10CriteriaFields(
    statsAggregator.peek({
      leagueSlug: fixture.leagueSlug,
      eventId: fixture.id,
      homeTeam: fixture.home.name,
      awayTeam: fixture.away.name,
      date: fixture.date,
      state: fixture.state,
    }),
    fixture.state,
  );
  logTop10CriteriaGate(statsInspection);
  const statsDataQuality = statsInspection.quality;

  // ── Value bet detection (per mode; markets differ per ranking) ───────────────
  const valueBetsByMode = new Map<RankingMode, ValueBet[]>();
  for (const mode of modes) {
    const pred = predictions.get(mode);
    if (!pred) continue;
    valueBetsByMode.set(mode, computeValueBets(pred, bookOdds, fixture));
  }

  // ── Side effects (DB writes + post-match evaluation) per ranking mode ───────
  // We keep the same behaviour as the single-mode route: every mode's result
  // is evaluated against the boxscore and persisted, so DB consumers see one
  // row per (eventId, rankingMode).
  const boxscores = new Map<RankingMode, Record<string, number> | null>();
  for (const mode of modes) {
    const pred = predictions.get(mode);
    if (!pred) continue;
    const vbs = valueBetsByMode.get(mode) ?? [];
    boxscores.set(mode, await persistAndEvaluate(fixture, pred, mode, vbs));
  }

  // ── Monte Carlo enrichment (additive, response-only) ────────────────────────
  // Ranking + markets are already finalised + persisted above; this only
  // attaches winningTeam / expectedScoreline derived from the same goal λ
  // via the existing Monte Carlo simulation. The input predictions are never
  // mutated.
  const enrichedByMode = new Map<RankingMode, EngineResult & MatchPredictionExtras>();
  for (const mode of modes) {
    const pred = predictions.get(mode);
    if (!pred) continue;
    const top10Criteria = buildTop10Criteria(pred, fixture, statsDataQuality, mode, statsInspection);
    enrichedByMode.set(mode, enrichPredictionWithMonteCarlo(pred, fixture, top10Criteria));
  }

  // ── ?ranking=all — return every mode in a single payload ────────────────────
  if (isAll) {
    const rankings = {} as Record<RankingMode, {
      prediction: EngineResult & Partial<MatchPredictionExtras>;
      boxscore: Record<string, number> | null;
      valueBets: ValueBet[];
      rankingMode: RankingMode;
    }>;
    for (const mode of modes) {
      rankings[mode] = {
        prediction:  enrichedByMode.get(mode) ?? predictions.get(mode)!,
        boxscore:    boxscores.get(mode) ?? null,
        valueBets:   valueBetsByMode.get(mode) ?? [],
        rankingMode: mode,
      };
    }
    const defaultPrediction = enrichedByMode.get(rankingMode) ?? predictions.get(rankingMode);
    return Response.json({
      fixture,
      summary,
      bookOdds,
      multiBookOdds,
      rankings,
      // The UI consumes the per-mode copies above. These default-B aliases keep
      // the response contract convenient for non-mode-aware API consumers.
      top10Criteria: defaultPrediction && "top10Criteria" in defaultPrediction
        ? defaultPrediction.top10Criteria
        : null,
      monteCarlo: defaultPrediction && "monteCarlo" in defaultPrediction
        ? defaultPrediction.monteCarlo
        : null,
    });
  }

  // ── Single-mode response (legacy shape + additive Monte Carlo extras) ───────
  const singleMode = modes[0];
  const singlePrediction = enrichedByMode.get(singleMode) ?? predictions.get(singleMode);
  return Response.json({
    fixture,
    summary,
    prediction: singlePrediction,
    top10Criteria: enrichedByMode.get(singleMode)?.top10Criteria ?? null,
    monteCarlo: enrichedByMode.get(singleMode)?.monteCarlo ?? null,
    boxscore:   boxscores.get(singleMode) ?? null,
    bookOdds,
    valueBets:  valueBetsByMode.get(singleMode) ?? [],
    multiBookOdds,
    rankingMode: singleMode,
  });
}

export const POST = withMonitoring("api/match", handlePost);
