// Value Accumulator — Scanner (independent, no accumulator reuse)
import { fetchScoreboard, fetchSummary, type FixtureLite, type MatchSummary } from "@/lib/espn";
import { leagueTier } from "@/lib/leaguePriority";
import { runEngineFromReal } from "@/lib/engine";
import {
  fetchOddsForEvent,
  resolveBzzoiroEvent,
  BZ_WIDE_RANGE_DAYS,
  type BzzoiroResolution,
  type VaBookmakerOdds,
} from "./oddsFetcher";
import { matchEngineMarketToBookmaker, type TeamContext } from "./marketMap";
import { buildTickets, getWeekStartForLegs, type VaLeg, type VaTicket, type VaTicketLeg } from "./ticket";
import { db } from "@/db";
import { vaLegs } from "@/db/schema";

const ALLOWED_LEAGUES = new Set([
  "eng.1",
  "esp.1",
  "ger.1",
  "ita.1",
  "fra.1",
  "uefa.champions",
  "uefa.europa",
  "uefa.europa.conf",
]);

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function dateRange(days: number): string {
  const now = new Date();
  const to = new Date(now);
  to.setDate(now.getDate() + days);
  return `${fmtDate(now)}-${fmtDate(to)}`;
}

function getStatFamily(marketName: string, family: string): string {
  const nameLower = marketName.toLowerCase();
  const famLower = (family || "").toLowerCase();

  if (famLower.includes("corner") || nameLower.includes("corner")) return "corners";
  if (famLower.includes("card") || nameLower.includes("card") || nameLower.includes("booking")) return "cards";
  if (
    famLower.includes("shot") ||
    famLower.includes("sot") ||
    nameLower.includes("shot") ||
    nameLower.includes("sot") ||
    nameLower.includes("save")
  )
    return "shots";
  if (
    famLower.includes("goal") ||
    nameLower.includes("goal") ||
    nameLower.includes("btts") ||
    nameLower.includes("both teams") ||
    nameLower.includes("match result") ||
    nameLower.includes("double chance") ||
    nameLower.includes("win") ||
    nameLower.includes("draw")
  )
    return "goals";
  return "other";
}

/**
 * A league is declared "not covered by Bzzoiro" once this many of its matches
 * come back with zero events across the widened (±5 day) range. One probe could
 * be a blip (a timeout, a single missing fixture); two in a row is the feed
 * simply not carrying the competition.
 */
const LEAGUE_UNCOVERED_THRESHOLD = 2;

/** Per-scan bookkeeping for leagues that Bzzoiro does not carry. */
class LeagueCoverage {
  private emptyByLeague = new Map<string, number>();
  private announced = new Set<string>();

  /** True when we already know the league is uncovered — skip without retrying. */
  isUncovered(leagueSlug: string): boolean {
    return (this.emptyByLeague.get(leagueSlug) ?? 0) >= LEAGUE_UNCOVERED_THRESHOLD;
  }

  /** Record a resolution outcome for a league; logs the skip notice once. */
  record(leagueSlug: string, resolution: BzzoiroResolution): void {
    if (resolution.status === "resolved") {
      // Coverage proven — reset any earlier empty probes for this league.
      this.emptyByLeague.delete(leagueSlug);
      return;
    }
    if (resolution.status !== "no-events") return; // names didn't match, but the league IS carried

    const count = (this.emptyByLeague.get(leagueSlug) ?? 0) + 1;
    this.emptyByLeague.set(leagueSlug, count);
    if (count >= LEAGUE_UNCOVERED_THRESHOLD && !this.announced.has(leagueSlug)) {
      this.announced.add(leagueSlug);
      console.log(`[VA] league ${leagueSlug} not covered by Bzzoiro — skipping all its matches`);
    }
  }

  /** Leagues declared uncovered during this scan. */
  uncoveredLeagues(): string[] {
    return Array.from(this.announced);
  }
}

function isDataQualityOk(completeness: number): boolean {
  // Real or Mixed: completeness >=45 (not fallbackMode)
  // Synthetic excluded: completeness <45
  return completeness >= 45;
}

async function fetchMatchesForLeague(leagueSlug: string, days: number): Promise<FixtureLite[]> {
  const range = dateRange(days);
  try {
    const fixtures = await fetchScoreboard(leagueSlug, range);
    // Filter to pre-match only (upcoming)
    return fixtures.filter((f) => f.state === "pre");
  } catch {
    return [];
  }
}

export interface ScanResult {
  matchesScanned: number;
  marketsEvaluated: number;
  legsQualified: number;
  legs: VaLeg[];
}

export type VaScanMode = "value" | "stack";

export async function scanValueLegs(scanId: string, days = 7, mode: VaScanMode = "value"): Promise<ScanResult> {
  // 1. Fetch matches in next days from fixture feed, leagues only allowed
  const leagueSlugs = Array.from(ALLOWED_LEAGUES);
  const allFixtures: FixtureLite[] = [];

  const settled = await Promise.allSettled(leagueSlugs.map((slug) => fetchMatchesForLeague(slug, days)));
  for (const res of settled) {
    if (res.status === "fulfilled") {
      allFixtures.push(...res.value);
    }
  }

  // Deduplicate by id
  const seen = new Set<string>();
  const deduped: FixtureLite[] = [];
  for (const fx of allFixtures) {
    if (!seen.has(fx.id)) {
      seen.add(fx.id);
      if (ALLOWED_LEAGUES.has(fx.leagueSlug)) {
        deduped.push(fx);
      }
    }
  }

  // Sort by league priority (Tier 1 first) then by date
  deduped.sort((a, b) => {
    const tierA = leagueTier(a);
    const tierB = leagueTier(b);
    if (tierA !== tierB) return tierA - tierB;
    return new Date(a.date).getTime() - new Date(b.date).getTime();
  });

  // Cap at 40 matches per run
  const capped = deduped.slice(0, 40);

  return runScan(capped, scanId, mode);
}

async function runScan(fixtures: FixtureLite[], scanId: string, mode: VaScanMode): Promise<ScanResult> {
  let marketsEvaluated = 0;
  const qualified: VaLeg[] = [];
  const coverage = new LeagueCoverage();

  for (const fx of fixtures) {
    const matchLabel = `${fx.home.name} vs ${fx.away.name}`;

    // a. Leagues already proven absent from Bzzoiro are skipped without a retry.
    if (coverage.isUncovered(fx.leagueSlug)) continue;

    // b. Resolve the Bzzoiro event for this fixture: kickoff date ±2 days,
    //    widened once to ±5 days (in-memory cached per match).
    let resolution: BzzoiroResolution;
    try {
      resolution = await resolveBzzoiroEvent(fx);
    } catch {
      resolution = {
        eventId: null,
        status: "no-match",
        eventsInRange: 0,
        relatedInRange: 0,
        toleranceDays: BZ_WIDE_RANGE_DAYS,
      };
    }
    coverage.record(fx.leagueSlug, resolution);

    const bzEventId = resolution.eventId;
    if (!bzEventId) {
      // No Bzzoiro event for this match — skip it entirely (no odds, no fabricated prices)
      console.log(`[VA] no Bzzoiro event for ${matchLabel} after widening to ±${BZ_WIDE_RANGE_DAYS} days`);
      continue;
    }
    console.log(`[VA] resolved Bzzoiro event ${bzEventId} for ${matchLabel}`);

    // c. Run engine to produce all 217 markets with hitRate
    let engineResult;
    try {
      engineResult = runEngineFromReal(fx, null);
    } catch {
      continue;
    }
    const markets = engineResult.markets ?? [];
    marketsEvaluated += markets.length;

    // d. Fetch odds for that event (consensus preferred, fail soft to [])
    let bookmakerOdds: VaBookmakerOdds[] = [];
    try {
      bookmakerOdds = await fetchOddsForEvent(bzEventId);
    } catch {
      bookmakerOdds = [];
    }
    if (bookmakerOdds.length === 0) continue;

    // e. For each engine market, match to bookmaker
    for (const m of markets) {
      // Only consider markets with hitRate (model probability)
      const hitRate = m.hitRate;
      if (typeof hitRate !== "number" || !Number.isFinite(hitRate)) continue;

      const teams: TeamContext = { home: fx.home.name, away: fx.away.name };
      const matched = matchEngineMarketToBookmaker(m.name, m.selection, bookmakerOdds, teams);
      if (!matched) continue;

      const realOdds = matched.odds;
      const ev = hitRate * realOdds - 1;
      const implied = 1 / realOdds;

      const statFamily = getStatFamily(m.name, m.family);

      // f. Qualify leg only if all true (mode-specific filters).
      if (mode === "stack") {
        if (realOdds < 1.03 || realOdds > 1.70) continue;
        if (hitRate < 0.62) continue;
        if (statFamily !== "goals" && statFamily !== "cards" && statFamily !== "corners") continue;
        // Stack mode does not apply the EV or isDataQualityOk() gates.
      } else {
        // - bookmaker_odds not null (already)
        // - ev > 0.03
        // - hitRate >=0.55
        // - 1.30 <= bookmaker_odds <=2.00
        // - Data quality Real or Mixed (Synthetic excluded)
        if (ev <= 0.03) continue;
        if (hitRate < 0.55) continue;
        if (realOdds < 1.3 || realOdds > 2.0) continue;
        if (!isDataQualityOk(engineResult.match.dataCompletenessScore)) continue;
      }

      const leg: VaLeg = {
        scanId,
        eventId: fx.id,
        matchLabel: `${fx.home.name} vs ${fx.away.name}`,
        homeTeam: fx.home.name,
        awayTeam: fx.away.name,
        leagueSlug: fx.leagueSlug,
        kickoff: new Date(fx.date),
        market: m.name,
        selection: m.selection,
        statFamily,
        modelProbability: hitRate,
        bookmakerOdds: realOdds,
        bookmakerName: matched.bookmaker,
        impliedProbability: implied,
        ev,
        oddsAtBuild: new Date(),
        scannedAt: new Date(),
      };

      qualified.push(leg);
    }
  }

  // Source-of-truth cleanup (applies in BOTH modes): at most one qualified leg
  // per (eventId, statFamily) pair — if several markets from the same match
  // land in the same stat family, keep only the highest-EV one.
  const bestByPair = new Map<string, VaLeg>();
  for (const leg of qualified) {
    const key = `${leg.eventId}|${leg.statFamily}`;
    const current = bestByPair.get(key);
    if (!current || leg.ev > current.ev) {
      bestByPair.set(key, leg);
    }
  }
  const uniqueQualified = Array.from(bestByPair.values());
  if (uniqueQualified.length !== qualified.length) {
    console.log(`[VA] dedup (eventId, statFamily): ${qualified.length} -> ${uniqueQualified.length} qualified legs`);
    qualified.length = 0;
    qualified.push(...uniqueQualified);
  }

  // 5. Insert each qualified leg into va_legs
  if (mode === "stack") {
    console.log(`[VA][stack] qualified=${qualified.length} from ${marketsEvaluated} markets`);
  }
  if (qualified.length > 0) {
    try {
      const rows = qualified.map((l) => ({
        scanId: l.scanId,
        eventId: l.eventId,
        matchLabel: l.matchLabel,
        homeTeam: l.homeTeam,
        awayTeam: l.awayTeam,
        leagueSlug: l.leagueSlug,
        kickoff: new Date(l.kickoff as Date),
        market: l.market,
        selection: l.selection,
        statFamily: l.statFamily,
        modelProbability: l.modelProbability,
        bookmakerOdds: l.bookmakerOdds,
        bookmakerName: l.bookmakerName,
        impliedProbability: l.impliedProbability,
        ev: l.ev,
        oddsAtBuild: new Date(l.oddsAtBuild as Date),
        scannedAt: new Date(),
      }));
      // Insert in batches of 50 to avoid too large payload
      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        await db.insert(vaLegs).values(batch);
      }
    } catch (err) {
      console.error("[VA] failed to insert legs", err);
    }
  }

  // 6. Log
  const uncovered = coverage.uncoveredLeagues();
  if (uncovered.length > 0) {
    console.log(`[VA] scan ${scanId}: skipped leagues (no Bzzoiro coverage): ${uncovered.join(", ")}`);
  }
  console.log(`[VA] scan ${scanId}: ${fixtures.length} matches, ${marketsEvaluated} markets, ${qualified.length} qualified legs`);

  return {
    matchesScanned: fixtures.length,
    marketsEvaluated,
    legsQualified: qualified.length,
    legs: qualified,
  };
}

// ─── Finished-match backtest (?finished=true): weekly multi-match tickets via stack-mode builder ───
const BACKTEST_LEAGUES = ["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"];

/** Final result of a finished match; corners stays null unless the ESPN boxscore supplies it. */
export interface BacktestMatchResult { leagueSlug: string; homeScore: number; awayScore: number; corners: number | null }
export type BacktestLegStatus = "won" | "lost" | "unknown";
export type BacktestTicketStatus = "won" | "lost" | "pending";

export interface BacktestTicketItem {
  weekLabel: string;
  legsCount: number;
  combinedOdds: number;
  claimedProbability: number;
  status: BacktestTicketStatus;
}

export interface TicketBacktestBucket {
  claimed: number;
  n: number;
  won: number;
  lost: number;
  realised: number;
  diff: number;
}

export interface TicketBacktestData {
  weeksScanned: number;
  ticketsBuilt: number;
  won: number;
  lost: number;
  pending: number;
  realisedRate: number | null;
  claimedAverage: number | null;
  edge: number | null;
  tickets: BacktestTicketItem[];
  ticketBuckets: TicketBacktestBucket[];
}

export interface BacktestSampleTicket extends VaTicket {
  status: BacktestTicketStatus;
  matchLabel?: string;
  weekLabel?: string;
}

/** runBacktestScan result: the qualified legs plus the settled combination samples. */
export interface BacktestScanResult extends ScanResult {
  tickets: BacktestSampleTicket[];
  ticketBacktest: TicketBacktestData;
}

export interface FinishedScanResult extends ScanResult {
  results: Map<string, BacktestMatchResult>;
  tickets: BacktestSampleTicket[];
  ticketBacktest: TicketBacktestData;
}

async function fetchFinishedFixtures(days: number): Promise<FixtureLite[]> {
  const to = new Date(), from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const settled = await Promise.allSettled(BACKTEST_LEAGUES.map((slug) => fetchScoreboard(slug, `${fmtDate(from)}-${fmtDate(to)}`)));
  const fixtures: FixtureLite[] = [], seen = new Set<string>();
  for (const res of settled) {
    if (res.status !== "fulfilled") continue;
    for (const fx of res.value) {
      if (seen.has(fx.id) || fx.state !== "post" || !Number.isFinite(Number(fx.home.score)) || !Number.isFinite(Number(fx.away.score))) continue;
      seen.add(fx.id);
      fixtures.push({ ...fx, state: "post" }); // FixtureLite pinned to "post" with the real final scores
    }
  }
  return fixtures;
}

export async function scanFinishedLegs(scanId: string, _mode: VaScanMode = "value"): Promise<FinishedScanResult> {
  void _mode;
  const fixtures = await fetchFinishedFixtures(30);
  const backtestResult = await runBacktestScan(fixtures, scanId);
  const results = new Map(
    fixtures.map((fx): [string, BacktestMatchResult] => [
      fx.id,
      { leagueSlug: fx.leagueSlug, homeScore: Number(fx.home.score), awayScore: Number(fx.away.score), corners: null },
    ])
  );
  return { ...backtestResult, results };
}

async function fetchEventCornerTotal(leagueSlug: string, eventId: string): Promise<number | null> {
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${encodeURIComponent(leagueSlug)}/summary?event=${encodeURIComponent(eventId)}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { boxscore?: { teams?: Array<{ statistics?: Array<{ name?: string; label?: string; displayValue?: string }> }> } };
    let total = 0, found = false;
    for (const team of data.boxscore?.teams ?? []) {
      const stat = (team.statistics ?? []).find((s) => s.name === "wonCorners" || /corner/i.test(`${s.name ?? ""} ${s.label ?? ""}`));
      if (stat && Number.isFinite(Number(stat.displayValue))) { total += Number(stat.displayValue); found = true; }
    }
    return found ? total : null;
  } catch { return null; }
}

function settleTotal(total: number | null, line: number, selection: string): BacktestLegStatus {
  if (total === null) return "unknown";
  const diff = total - line;
  if (/^over\b/i.test(selection)) return diff > 0 ? "won" : diff < 0 ? "lost" : "unknown";
  if (/^under\b/i.test(selection)) return diff < 0 ? "won" : diff > 0 ? "lost" : "unknown";
  return "unknown";
}

export function settleBacktestLeg(market: string, selection: string, result: BacktestMatchResult | undefined): BacktestLegStatus {
  if (!result) return "unknown";
  const m = market.toLowerCase();
  if (m.includes("card")) return "unknown";
  const lineMatch = selection.match(/(\d+(?:\.\d+)?)/);
  const line = lineMatch ? Number(lineMatch[1]) : null;
  if (m.includes("total goals") && line !== null) return settleTotal(result.homeScore + result.awayScore, line, selection);
  if (m.includes("both teams to score") || m.includes("btts")) {
    const bothScored = result.homeScore > 0 && result.awayScore > 0;
    if (/^yes\b/i.test(selection)) return bothScored ? "won" : "lost";
    if (/^no\b/i.test(selection)) return bothScored ? "lost" : "won";
  }
  if (m.includes("corner") && line !== null) return settleTotal(result.corners, line, selection);
  return "unknown";
}

/** Settle tickets: won = ALL legs won, lost = ANY leg lost, pending = no loss but unknown legs. */
export async function settleBacktestTickets(tickets: VaTicket[], results: Map<string, BacktestMatchResult>): Promise<BacktestTicketStatus[]> {
  const needCorners = new Set(tickets.flatMap((t) => t.legs).filter((l) => l.market.toLowerCase().includes("corner")).map((l) => l.eventId));
  for (const eventId of needCorners) {
    const result = results.get(eventId);
    if (result && result.corners === null) result.corners = await fetchEventCornerTotal(result.leagueSlug, eventId);
  }
  return tickets.map((ticket) => {
    const statuses = ticket.legs.map((leg) => settleBacktestLeg(leg.market, leg.selection, results.get(leg.eventId)));
    return statuses.includes("lost") ? "lost" : statuses.includes("unknown") ? "pending" : "won";
  });
}

/**
 * Backtest scan: runs the engine for each finished match in the 30-day window,
 * qualifies legs with stack-mode filters (odds 1.03..1.70, hitRate >= 0.62,
 * families {Goals, Corners, Cards}), pools every qualified leg across ALL
 * matches, dedups globally per (eventId, family) keeping the highest hitRate,
 * groups the pool by ISO week (Monday-based, UTC), builds tickets per week via
 * buildTickets(weekLegs, "stack") — the same builder the live scanner uses, so
 * tickets are multi-match (6-8 legs when available, combined odds 4.5-7.5) —
 * settles each ticket against the finished results (goals from the scoreboard
 * final scores, corners + cards from the ESPN match summary boxscore with one
 * fetchSummary call per match maximum), and aggregates results.
 */
async function runBacktestScan(fixtures: FixtureLite[], scanId: string): Promise<BacktestScanResult> {
  let marketsEvaluated = 0;

  // Backtest-only settlement helpers (local to this scan — the live scan path
  // and the exported settleBacktestLeg / settleBacktestTickets are untouched).

  /** ISO week label (Monday-based, UTC) for a kickoff: YYYY-MM-DD. */
  const isoWeekMondayUtc = (kickoff: Date | string): string => {
    const date = kickoff instanceof Date ? kickoff : new Date(kickoff);
    const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = monday.getUTCDay(); // 0 = Sunday … 6 = Saturday
    monday.setUTCDate(monday.getUTCDate() + (day === 0 ? -6 : 1 - day));
    return monday.toISOString().slice(0, 10);
  };

  /** Numeric O/U line from a selection ("Over 2.5" → 2.5); null when absent. */
  const parseLine = (selection: string): number | null => {
    const lineMatch = selection.match(/(\d+(?:\.\d+)?)/);
    return lineMatch ? Number(lineMatch[1]) : null;
  };

  /** Card totals (yellow + red) from a cached summary boxscore; null = no card data. */
  const cardTotals = (
    summary: MatchSummary | null | undefined
  ): { home: number; away: number; total: number } | null => {
    const box = summary?.boxscore;
    if (!box) return null;
    const hasAny =
      box.homeYellowCards !== null ||
      box.awayYellowCards !== null ||
      box.homeRedCards !== null ||
      box.awayRedCards !== null;
    if (!hasAny) return null;
    const home = (box.homeYellowCards ?? 0) + (box.homeRedCards ?? 0);
    const away = (box.awayYellowCards ?? 0) + (box.awayRedCards ?? 0);
    return { home, away, total: home + away };
  };

  /** Corner total from a cached summary boxscore; null = no corner data. */
  const cornerTotalFromSummary = (summary: MatchSummary | null | undefined): number | null => {
    const box = summary?.boxscore;
    if (!box || (box.homeCorners === null && box.awayCorners === null)) return null;
    return (box.homeCorners ?? 0) + (box.awayCorners ?? 0);
  };

  /** Which side a team-scoped cards market ("{Team} Cards O/U N") refers to; null when unparseable. */
  const cardsMarketSide = (market: string, homeTeam: string, awayTeam: string): "home" | "away" | null => {
    const teamPart = market.match(/^(.*?)\s+cards?\s+o\/u/i)?.[1]?.trim();
    if (!teamPart) return null;
    const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const want = normalise(teamPart);
    if (!want) return null;
    if (normalise(homeTeam) === want) return "home";
    if (normalise(awayTeam) === want) return "away";
    return null;
  };

  /** Settle one cards leg (total or team-scoped O/U) from cached card totals. */
  const settleCardsLeg = (
    market: string,
    selection: string,
    homeTeam: string,
    awayTeam: string,
    totals: { home: number; away: number; total: number } | null | undefined
  ): BacktestLegStatus => {
    if (!totals) return "unknown";
    const line = parseLine(selection);
    const isOver = /^over\b/i.test(selection);
    const isUnder = /^under\b/i.test(selection);
    if (line === null || (!isOver && !isUnder)) return "unknown";
    let actual: number;
    if (market.toLowerCase().startsWith("total cards")) {
      actual = totals.total;
    } else {
      // Team-specific line ("{Team} Cards O/U N"); anything else (cards
      // handicap, cards exact, …) stays unknown for this leg only.
      const side = cardsMarketSide(market, homeTeam, awayTeam);
      if (!side) return "unknown";
      actual = side === "home" ? totals.home : totals.away;
    }
    if (isOver) return actual > line ? "won" : "lost";
    return actual < line ? "won" : "lost";
  };

  // Steps 1-3: run the engine on each finished match, qualify legs with the
  // SAME filters as stack mode, and pool every qualified leg across matches:
  //   - fairOddsWorst 1.03 .. 1.70
  //   - hitRate >= 0.62
  //   - statFamily in {Goals, Corners, Cards}
  //   - no EV filter
  const pooled: VaLeg[] = [];
  const fixtureById = new Map<string, FixtureLite>();
  for (const fx of fixtures) {
    fixtureById.set(fx.id, fx);

    let engineResult;
    try {
      engineResult = runEngineFromReal(fx, null);
    } catch {
      continue;
    }
    const markets = engineResult.markets ?? [];
    marketsEvaluated += markets.length;

    for (const m of markets) {
      const hitRate = m.hitRate;
      if (typeof hitRate !== "number" || !Number.isFinite(hitRate)) continue;

      const statFamily = getStatFamily(m.name, m.family);
      if (hitRate < 0.62) continue;
      if (statFamily !== "goals" && statFamily !== "corners" && statFamily !== "cards") continue;

      const realOdds = m.fairOddsWorst;
      if (typeof realOdds !== "number" || !Number.isFinite(realOdds)) continue;
      if (realOdds < 1.03 || realOdds > 1.70) continue;

      const ev = hitRate * realOdds - 1;
      const implied = 1 / realOdds;

      pooled.push({
        scanId,
        eventId: fx.id,
        matchLabel: `${fx.home.name} vs ${fx.away.name}`,
        homeTeam: fx.home.name,
        awayTeam: fx.away.name,
        leagueSlug: fx.leagueSlug,
        kickoff: new Date(fx.date),
        market: m.name,
        selection: m.selection,
        statFamily,
        modelProbability: hitRate,
        bookmakerOdds: realOdds,
        bookmakerName: "Model Fair",
        impliedProbability: implied,
        ev,
        oddsAtBuild: new Date(),
        scannedAt: new Date(),
      });
    }
  }

  // Step 4: global dedup by (eventId, family), keeping the highest hitRate.
  const bestByPair = new Map<string, VaLeg>();
  for (const leg of pooled) {
    const key = `${leg.eventId}|${leg.statFamily}`;
    const current = bestByPair.get(key);
    if (!current || leg.modelProbability > current.modelProbability) {
      bestByPair.set(key, leg);
    }
  }
  const allQualifiedLegs = Array.from(bestByPair.values());

  // Step 5: group legs by ISO week (Monday-based, UTC).
  const legsByWeek = new Map<string, VaLeg[]>();
  for (const leg of allQualifiedLegs) {
    const weekLabel = isoWeekMondayUtc(leg.kickoff);
    const bucket = legsByWeek.get(weekLabel);
    if (bucket) bucket.push(leg);
    else legsByWeek.set(weekLabel, [leg]);
  }

  // Step 6: one buildTickets(weekLegs, "stack") call per week — the same
  // builder the live scanner uses, so tickets are multi-match.
  const builtTickets: BacktestSampleTicket[] = [];
  const weekLabels = Array.from(legsByWeek.keys()).sort();
  for (const weekLabel of weekLabels) {
    const weekLegs = legsByWeek.get(weekLabel) ?? [];
    const ticketsForWeek = buildTickets(weekLegs, "stack");
    for (const ticket of ticketsForWeek) {
      builtTickets.push({ ...ticket, status: "pending" as BacktestTicketStatus, weekLabel });
    }
  }

  // Step 7: settle each ticket's legs against the finished match results.
  // Goals/BTTS settle from the scoreboard final scores; corners and cards
  // settle from the ESPN match summary boxscore. Summaries are cached per
  // fixture id — one fetchSummary call per match maximum — and a single
  // cached summary serves both the corners and the cards legs of a ticket.
  const summaryCache = new Map<string, Promise<MatchSummary | null>>();
  const getSummary = (fx: FixtureLite): Promise<MatchSummary | null> => {
    const cached = summaryCache.get(fx.id);
    if (cached) return cached;
    const pending = fetchSummary(fx.leagueSlug, fx.id).then(
      (summary) => summary,
      () => null
    );
    summaryCache.set(fx.id, pending);
    return pending;
  };

  // Final scores for every fixture are already known; corners fill in below.
  const results = new Map<string, BacktestMatchResult>();
  for (const fx of fixtures) {
    results.set(fx.id, {
      leagueSlug: fx.leagueSlug,
      homeScore: Number(fx.home.score),
      awayScore: Number(fx.away.score),
      corners: null,
    });
  }

  // Only matches with corners/cards legs in a built ticket need a summary.
  const eventsNeedingSummary = new Set<string>();
  for (const ticket of builtTickets) {
    for (const leg of ticket.legs) {
      const marketLower = leg.market.toLowerCase();
      if (
        leg.statFamily === "corners" ||
        leg.statFamily === "cards" ||
        marketLower.includes("corner") ||
        marketLower.includes("card") ||
        marketLower.includes("booking")
      ) {
        eventsNeedingSummary.add(leg.eventId);
      }
    }
  }
  const cardsByEvent = new Map<string, { home: number; away: number; total: number } | null>();
  for (const eventId of eventsNeedingSummary) {
    const fx = fixtureById.get(eventId);
    const result = results.get(eventId);
    if (!fx || !result) continue;
    const summary = await getSummary(fx);
    result.corners = cornerTotalFromSummary(summary);
    cardsByEvent.set(eventId, cardTotals(summary));
  }

  for (const ticket of builtTickets) {
    const legStatuses = ticket.legs.map((leg) => {
      const marketLower = leg.market.toLowerCase();
      const isCardsLeg =
        leg.statFamily === "cards" || marketLower.includes("card") || marketLower.includes("booking");
      if (isCardsLeg) {
        return settleCardsLeg(
          leg.market,
          leg.selection,
          leg.homeTeam,
          leg.awayTeam,
          cardsByEvent.get(leg.eventId)
        );
      }
      return settleBacktestLeg(leg.market, leg.selection, results.get(leg.eventId));
    });
    ticket.status = legStatuses.includes("lost")
      ? "lost"
      : legStatuses.includes("unknown")
        ? "pending"
        : "won";
  }

  // Aggregate and return:
  const won = builtTickets.filter((t) => t.status === "won").length;
  const lost = builtTickets.filter((t) => t.status === "lost").length;
  const pending = builtTickets.filter((t) => t.status === "pending").length;
  const weeksScanned = weekLabels.length;
  const ticketsBuiltCount = builtTickets.length;
  const settledCount = won + lost;

  const round4 = (v: number) => Math.round(v * 10000) / 10000;
  const round3 = (v: number) => Math.round(v * 1000) / 1000;

  const realisedRate = settledCount > 0 ? round4(won / settledCount) : null;

  const settledTickets = builtTickets.filter((t) => t.status === "won" || t.status === "lost");
  const claimedAverage =
    settledCount > 0
      ? round4(settledTickets.reduce((sum, t) => sum + t.combinedProbability, 0) / settledCount)
      : null;

  const edge =
    realisedRate !== null && claimedAverage !== null
      ? round4(realisedRate - claimedAverage)
      : null;

  // Newest week first, capped at 50 for response size
  const sortedTickets = [...builtTickets].sort((a, b) =>
    (b.weekLabel ?? "").localeCompare(a.weekLabel ?? "")
  );

  const ticketsOut: BacktestTicketItem[] = sortedTickets.slice(0, 50).map((t) => ({
    weekLabel: t.weekLabel ?? "Unknown week",
    legsCount: t.legs.length,
    combinedOdds: round4(t.combinedOdds),
    claimedProbability: round4(t.combinedProbability),
    status: t.status,
  }));

  const buckets = new Map<number, { won: number; lost: number }>();
  for (const t of builtTickets) {
    if (t.status === "pending") continue;
    const idx = Math.floor(t.combinedProbability / 0.05 + 1e-6);
    const bucket = buckets.get(idx) ?? { won: 0, lost: 0 };
    bucket[t.status === "won" ? "won" : "lost"] += 1;
    buckets.set(idx, bucket);
  }
  const ticketBuckets: TicketBacktestBucket[] = Array.from(buckets.entries())
    .filter(([, bucket]) => bucket.won + bucket.lost >= 3)
    .map(([idx, bucket]) => {
      const claimed = round3(idx / 20); // bucket start on the 0.05 grid
      const realised = bucket.won / (bucket.won + bucket.lost);
      return {
        claimed,
        n: bucket.won + bucket.lost,
        won: bucket.won,
        lost: bucket.lost,
        realised: round3(realised),
        diff: round3(realised - claimed),
      };
    })
    .sort((a, b) => a.claimed - b.claimed);

  const ticketBacktest: TicketBacktestData = {
    weeksScanned,
    ticketsBuilt: ticketsBuiltCount,
    won,
    lost,
    pending,
    realisedRate,
    claimedAverage,
    edge,
    tickets: ticketsOut,
    ticketBuckets,
  };

  console.log(
    `[VA] backtest scan ${scanId}: ${fixtures.length} matches, ${marketsEvaluated} markets, ` +
      `${allQualifiedLegs.length} qualified legs, ${weeksScanned} weeks, ${ticketsBuiltCount} tickets built ` +
      `(${won} won, ${lost} lost, ${pending} pending)`
  );

  return {
    matchesScanned: fixtures.length,
    marketsEvaluated,
    legsQualified: allQualifiedLegs.length,
    legs: allQualifiedLegs,
    tickets: builtTickets,
    ticketBacktest,
  };
}
