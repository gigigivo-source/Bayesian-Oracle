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
        top10Detail:     prediction.top10.map((m) => ({
          name:      m.name,
          selection: m.selection,
          hitRate:   m.hitRate,
          outcome:   m.outcome,
          family:    m.family,
        })),
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
 * Layer 1 + 2 + 3 bookmaker-odds enrichment. Shared across all three ranking
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
  if (!LEAGUE_MAP[fixture.leagueSlug]) {
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

  // ── ?ranking=all — return every mode in a single payload ────────────────────
  if (isAll) {
    const rankings = {} as Record<RankingMode, {
      prediction: EngineResult;
      boxscore: Record<string, number> | null;
      valueBets: ValueBet[];
      rankingMode: RankingMode;
    }>;
    for (const mode of modes) {
      rankings[mode] = {
        prediction:  predictions.get(mode)!,
        boxscore:    boxscores.get(mode) ?? null,
        valueBets:   valueBetsByMode.get(mode) ?? [],
        rankingMode: mode,
      };
    }
    return Response.json({
      fixture,
      summary,
      bookOdds,
      multiBookOdds,
      rankings,
    });
  }

  // ── Single-mode response (legacy shape, unchanged) ──────────────────────────
  const singleMode = modes[0];
  return Response.json({
    fixture,
    summary,
    prediction: predictions.get(singleMode),
    boxscore:   boxscores.get(singleMode) ?? null,
    bookOdds,
    valueBets:  valueBetsByMode.get(singleMode) ?? [],
    multiBookOdds,
    rankingMode: singleMode,
  });
}

export const POST = withMonitoring("api/match", handlePost);
