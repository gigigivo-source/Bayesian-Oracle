// Value Accumulator — Scanner (independent, no accumulator reuse)
import { fetchScoreboard, type FixtureLite } from "@/lib/espn";
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
import { getWeekStartForLegs, type VaLeg, type VaTicket, type VaTicketLeg } from "./ticket";
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

// ─── Finished-match backtest (?finished=true): calibration probe — qualifies by model probability alone, no odds/EV filter ───
const BACKTEST_LEAGUES = ["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"];

/** Fixed seed for the backtest sample shuffle — makes the random sample reproducible. */
const BACKTEST_SAMPLE_SEED = 0x9e3779b9;

/** Mulberry32: a tiny, deterministic PRNG from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle of a copy of `legs`, driven by a seeded PRNG. */
function shuffleSeeded<T>(input: T[], seed: number): T[] {
  const shuffled = [...input];
  const rand = mulberry32(seed);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/** Final result of a finished match; corners stays null unless the ESPN boxscore supplies it. */
export interface BacktestMatchResult { leagueSlug: string; homeScore: number; awayScore: number; corners: number | null }
export type BacktestLegStatus = "won" | "lost" | "unknown";
export type BacktestTicketStatus = "won" | "lost" | "pending";

/**
 * A backtest calibration sample: a 3-leg combination (three different events)
 * priced entirely at the model's own fair odds — combinedOdds is the product
 * of 1/modelProbability per leg, so combinedEv is ~0 by construction. The
 * sample exists to compare combinedProbability against the realised win rate.
 */
export interface BacktestSampleTicket extends VaTicket {
  status: BacktestTicketStatus;
}

/** runBacktestScan result: the qualified legs plus the settled combination samples. */
export interface BacktestScanResult extends ScanResult {
  tickets: BacktestSampleTicket[];
}

export interface FinishedScanResult extends ScanResult {
  results: Map<string, BacktestMatchResult>;
  /** Combination samples settled by the scanner — the backtest path's replacement for buildTickets. */
  tickets: BacktestSampleTicket[];
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
  void _mode; // Backtest qualification is mode-independent (model probability alone); mode still selects the ticket shape in buildTickets.
  const fixtures = await fetchFinishedFixtures(30);
  const results = new Map(fixtures.map((fx): [string, BacktestMatchResult] =>
    [fx.id, { leagueSlug: fx.leagueSlug, homeScore: Number(fx.home.score), awayScore: Number(fx.away.score), corners: null }]));
  return { ...(await runBacktestScan(fixtures, scanId)), results };
}

/**
 * Backtest-only scan: engine-driven, no Bzzoiro resolution, no bookmaker odds.
 * Qualifies legs by model probability alone (hitRate >= 0.60, family in
 * Goals/Corners/Cards) with the same per-(eventId, statFamily) dedup as the
 * live path. Instead of running buildTickets (whose odds windows, family caps
 * and exposure caps don't belong in a calibration sample), it samples 3-leg
 * combinations — three different eventIds — priced at the model's own fair
 * odds (combinedOdds = Π 1/modelProbability), settles every leg against the
 * finished result (Over/Under Goals, Over/Under Corners from the ESPN boxscore,
 * BTTS Yes/No), skips any combination with an unknown leg, and returns the
 * settled samples as `tickets`.
 */
async function runBacktestScan(fixtures: FixtureLite[], scanId: string): Promise<BacktestScanResult> {
  let marketsEvaluated = 0;
  const qualified: VaLeg[] = [];

  for (const fx of fixtures) {
    // Run engine to produce all 217 markets with hitRate (no odds lookups).
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

      // No odds-range filter, no EV filter — model probability alone.
      if (hitRate < 0.6) continue;
      if (statFamily !== "goals" && statFamily !== "corners" && statFamily !== "cards") continue;

      // Fair price for the ticket's combined-odds display.
      const fairOdds = m.fairOddsWorst;
      if (typeof fairOdds !== "number" || !Number.isFinite(fairOdds) || fairOdds <= 1) continue;
      const ev = hitRate * fairOdds - 1;
      const implied = 1 / fairOdds;

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
        bookmakerOdds: fairOdds,
        bookmakerName: "Model Fair",
        impliedProbability: implied,
        ev,
        oddsAtBuild: new Date(),
        scannedAt: new Date(),
      };

      qualified.push(leg);
    }
  }

  // Same source-of-truth cleanup as the live path: at most one qualified leg
  // per (eventId, statFamily) pair — keep only the highest-EV one.
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

  // NOTE: the backtest path intentionally does NOT persist to va_legs — these
  // are finished-match samples, not live qualified legs, and writing them would
  // leak historical fixtures into the live scan state.

  console.log(`[VA] backtest scan ${scanId}: ${fixtures.length} matches, ${marketsEvaluated} markets, ${qualified.length} qualified legs`);

  // ─── Combination sampling (replaces buildTickets on the backtest path) ───
  // Enumerate 3-leg combinations straight from the qualified pool. Every
  // combination is priced at the model's OWN fair odds (1/modelProbability per
  // leg), so combinedProbability is exactly what the model claims and
  // combinedOdds is its mirror image — no bookmaker prices enter the sample.
  const MAX_COMBINATION_SAMPLES = 2000; // keep the sample size (and runtime) bounded

  // Random, reproducible order: a seeded Fisher–Yates shuffle over a copy of the
  // qualified pool. Sorting by probability (as before) biased the first 2000
  // combinations toward the same few top legs, so the "samples" measured the
  // outcome of two legs instead of the pool — and the realised rate blew past
  // the claimed probability. The shuffle keeps every leg's chance of appearing
  // in the first N combinations uniform, and the fixed seed keeps the sample
  // reproducible across scans.
  const legs = shuffleSeeded([...qualified], BACKTEST_SAMPLE_SEED);

  // Final results for settlement (same map scanFinishedLegs returns), with
  // corner totals pulled from the ESPN boxscore for every event that has a
  // qualified corners leg — settleBacktestLeg cannot settle corners without it.
  const results = new Map(
    fixtures.map((fx): [string, BacktestMatchResult] => [
      fx.id,
      { leagueSlug: fx.leagueSlug, homeScore: Number(fx.home.score), awayScore: Number(fx.away.score), corners: null },
    ]),
  );
  const cornerEventIds = new Set(legs.filter((l) => l.market.toLowerCase().includes("corner")).map((l) => l.eventId));
  await Promise.all(
    Array.from(cornerEventIds).map(async (eventId) => {
      const result = results.get(eventId);
      if (result && result.corners === null) {
        result.corners = await fetchEventCornerTotal(result.leagueSlug, eventId);
      }
    }),
  );

  // Pre-settle every leg once: Over/Under Goals, Over/Under Corners, BTTS
  // Yes/No — any other market (cards included) settles "unknown".
  const legStatuses = legs.map((leg) => settleBacktestLeg(leg.market, leg.selection, results.get(leg.eventId)));

  const toIso = (d: Date | string): string => (d instanceof Date ? d : new Date(d)).toISOString();
  const toSampleLeg = (l: VaLeg): VaTicketLeg => ({
    match: l.matchLabel,
    market: l.market,
    selection: l.selection,
    odds: 1 / l.modelProbability, // fair odds — the sample prices the model's own probability
    ev: l.ev,
    kickoff: toIso(l.kickoff),
    statFamily: l.statFamily,
    homeTeam: l.homeTeam,
    awayTeam: l.awayTeam,
    bookmaker: l.bookmakerName,
    eventId: l.eventId,
    modelProbability: l.modelProbability,
  });

  const tickets: BacktestSampleTicket[] = [];
  for (let i = 0; i < legs.length && tickets.length < MAX_COMBINATION_SAMPLES; i++) {
    for (let j = i + 1; j < legs.length && tickets.length < MAX_COMBINATION_SAMPLES; j++) {
      if (legs[j].eventId === legs[i].eventId) continue; // the three legs need three DIFFERENT eventIds
      for (let k = j + 1; k < legs.length && tickets.length < MAX_COMBINATION_SAMPLES; k++) {
        if (legs[k].eventId === legs[i].eventId || legs[k].eventId === legs[j].eventId) continue;
        // A leg that cannot be settled against the finished result poisons the
        // whole sample — skip the combination entirely.
        if (legStatuses[i] === "unknown" || legStatuses[j] === "unknown" || legStatuses[k] === "unknown") continue;

        const a = legs[i], b = legs[j], c = legs[k];
        const combinedProbability = a.modelProbability * b.modelProbability * c.modelProbability;
        // Fair odds, not bookmaker odds — this measures the model's own
        // probability, not the market's price.
        const combinedOdds = (1 / a.modelProbability) * (1 / b.modelProbability) * (1 / c.modelProbability);
        const sampleLegs = [a, b, c];
        tickets.push({
          scanId,
          weekStart: getWeekStartForLegs(sampleLegs),
          legs: sampleLegs.map(toSampleLeg),
          combinedOdds,
          combinedProbability,
          combinedEv: combinedProbability * combinedOdds - 1, // ~0 by construction (fair price)
          independentProbability: combinedProbability,
          effectiveProbability: combinedProbability,
          kellyScore: 0, // fair price → no edge → no stake recommendation
          stakePercent: 0,
          isRecommended: false,
          isReferenceOnly: false,
          // All 3 legs won → "won"; any leg lost → "lost" (unknown legs never reach here).
          status:
            legStatuses[i] === "won" && legStatuses[j] === "won" && legStatuses[k] === "won" ? "won" : "lost",
        });
      }
    }
  }

  console.log(`[VA] backtest scan ${scanId}: sampled ${tickets.length} 3-leg combinations (cap ${MAX_COMBINATION_SAMPLES})`);

  return {
    matchesScanned: fixtures.length,
    marketsEvaluated,
    legsQualified: qualified.length,
    legs: qualified,
    tickets,
  };
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
