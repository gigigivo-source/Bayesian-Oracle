// Value Accumulator — Scanner (independent, no accumulator reuse)
import { fetchScoreboard, fetchSummary, type FixtureLite, type MatchSummary } from "@/lib/espn";
import { leagueTier } from "@/lib/leaguePriority";
import { runEngineFromRealWithProfiles } from "@/lib/engine";
import * as engineApi from "@/lib/engine";
import {
  fetchOddsForEvent,
  resolveBzzoiroEvent,
  BZ_WIDE_RANGE_DAYS,
  type BzzoiroResolution,
  type VaBookmakerOdds,
} from "./oddsFetcher";
import {
  fetchEventDetail,
  fetchMatchTeamXg,
  fetchMatchXg,
  type TeamXgAverage,
  type XgResult,
} from "./xgFetcher";
import { matchEngineMarketToBookmaker, type TeamContext } from "./marketMap";
import { buildTickets, getWeekStartForLegs, type VaLeg, type VaTicket, type VaTicketLeg } from "./ticket";
import { FIXTURE_BATCH_SIZE, runFixtureBatches } from "./parallel";
import { db } from "@/db";
import { vaLegs, marketStats } from "@/db/schema";

function optionalEngineExport(name: string): unknown {
  try {
    return (engineApi as unknown as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

// ─── xG attachment (Bzzoiro) ──────────────────────────────────────────────────

/**
 * Normalised xG attachment handed to the engine's lambda grounding
 * (realLambdas reads sum.__homeXg / sum.__awayXg — layer 1 of the xG chain —
 * and sum.__homeXgSource for logging).
 */
interface VaXgAttachment {
  homeXg: number | null;
  awayXg: number | null;
  homeSamples: number;
  awaySamples: number;
  source: "bzzoiro-match" | "bzzoiro-team-avg" | null;
}

const NO_XG: VaXgAttachment = {
  homeXg: null,
  awayXg: null,
  homeSamples: 0,
  awaySamples: 0,
  source: null,
};

function xgFromTeamAverages(xgData: {
  home: TeamXgAverage | null;
  away: TeamXgAverage | null;
}): VaXgAttachment {
  return {
    homeXg: xgData.home?.xgFor ?? null,
    awayXg: xgData.away?.xgFor ?? null,
    homeSamples: xgData.home?.samples ?? 0,
    awaySamples: xgData.away?.samples ?? 0,
    source: xgData.home || xgData.away ? "bzzoiro-team-avg" : null,
  };
}

/**
 * LIVE path: /events/{id}/stats/ is null until the match is finished, so
 * upcoming fixtures are grounded with rolling team xG averages instead —
 * GET /events/{id}/ for the team ids, then each side's last 5 finished
 * matches (fetchMatchTeamXg). Fail soft: NO_XG on any error.
 */
async function fetchLiveXg(bzEventId: string): Promise<VaXgAttachment> {
  try {
    const evt = await fetchEventDetail(bzEventId);
    if (evt?.homeTeamId == null || evt?.awayTeamId == null) return NO_XG;
    return xgFromTeamAverages(await fetchMatchTeamXg(evt.homeTeamId, evt.awayTeamId, 5));
  } catch {
    return NO_XG;
  }
}

/**
 * BACKTEST path: the match is finished, so /events/{id}/stats/ now carries the
 * real per-match xG (fetchMatchXg). When it returns nothing (stats not
 * populated, thin coverage), fall back to the same rolling team averages as
 * the live path — keeps backtest grounding consistent with live.
 */
async function fetchFinishedXg(bzEventId: string): Promise<VaXgAttachment> {
  let xgMatch: XgResult | null = null;
  try {
    xgMatch = await fetchMatchXg(bzEventId);
  } catch {
    xgMatch = null;
  }
  if (xgMatch) {
    return {
      homeXg: xgMatch.homeXg,
      awayXg: xgMatch.awayXg,
      homeSamples: xgMatch.homeXg != null ? 1 : 0,
      awaySamples: xgMatch.awayXg != null ? 1 : 0,
      source: xgMatch.source,
    };
  }
  return fetchLiveXg(bzEventId);
}

/** Attach the xG keys to the summary object; Object.assign preserves every original field for other callers. */
function attachXgToSummary(summary: MatchSummary | null, xg: VaXgAttachment): MatchSummary {
  return (
    summary
      ? Object.assign(Object.create(Object.getPrototypeOf(summary)), summary, {
          __homeXg: xg.homeXg,
          __awayXg: xg.awayXg,
          __homeXgSource: xg.source,
          __awayXgSource: xg.source,
        })
      : {
          __homeXg: xg.homeXg,
          __awayXg: xg.awayXg,
          __homeXgSource: xg.source,
          __awayXgSource: xg.source,
        }
  ) as MatchSummary;
}

/** One log line whenever xG is attached to a fixture. */
function logXgAttachment(fx: FixtureLite, xg: VaXgAttachment): void {
  const fmt = (v: number | null) => (v != null ? v.toFixed(2) : "—");
  console.log(
    `[VA][xg] ${fx.home.name} vs ${fx.away.name}: ` +
      `home=${fmt(xg.homeXg)} away=${fmt(xg.awayXg)} ` +
      `(samples ${xg.homeSamples}/${xg.awaySamples}${xg.source ? `, ${xg.source}` : ""})`
  );
}

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
 * Maps a candidate market + selection + family to a normalised marketKey
 * for self-learning market calibration.
 *
 * Rules:
 *   - "Total Goals O/U 1.5" + "Over 1.5" -> "Goals:TotalO/U:1.5:Over"
 *   - "Total Goals O/U 3.5" + "Under 3.5" -> "Goals:TotalO/U:3.5:Under"
 *   - "Both Teams To Score" + "Yes" -> "Goals:BTTS:Yes"
 *   - "Total Corners O/U 8.5" + "Over 8.5" -> "Corners:TotalO/U:8.5:Over"
 *   - "{Team} Corners O/U 4.5" + "Over 4.5" -> "Corners:Team:4.5:Over"
 *   - "Total Cards O/U 2.5" + "Under 2.5" -> "Cards:TotalO/U:2.5:Under"
 *   - "{Team} Cards O/U 1.5" + "Over 1.5" -> "Cards:Team:1.5:Over"
 *   - anything else -> family + ":Other:" + market
 */
export function marketKeyOf(market: string, selection: string, family: string): string {
  const fam = (family || "").trim();
  const normalizedFam =
    fam.toLowerCase() === "goals"
      ? "Goals"
      : fam.toLowerCase() === "corners"
      ? "Corners"
      : fam.toLowerCase() === "cards"
      ? "Cards"
      : fam
      ? fam.charAt(0).toUpperCase() + fam.slice(1)
      : family;

  const m = (market || "").trim();
  const s = (selection || "").trim();

  // Helper to extract line: e.g. "Over 1.5" -> "1.5", or "Total Goals O/U 1.5" -> "1.5"
  const extractLine = (str1: string, str2: string): string | null => {
    const match = str1.match(/(\d+(?:\.\d+)?)/) || str2.match(/(\d+(?:\.\d+)?)/);
    return match ? match[1] : null;
  };

  // Helper to extract direction: "Over" or "Under"
  const extractDir = (sel: string): string => {
    if (/^over\b/i.test(sel)) return "Over";
    if (/^under\b/i.test(sel)) return "Under";
    return sel;
  };

  // 1. Total Goals O/U
  if (/^total\s+goals\s+o\/u/i.test(m)) {
    const line = extractLine(m, s);
    const dir = extractDir(s);
    if (line) return `Goals:TotalO/U:${line}:${dir}`;
  }

  // 2. Both Teams To Score (BTTS)
  if (/^(?:both\s+teams\s+to\s+score|btts)$/i.test(m) || /both\s+teams\s+to\s+score/i.test(m)) {
    const sel = /^(?:yes|y)$/i.test(s) ? "Yes" : /^(?:no|n)$/i.test(s) ? "No" : s;
    return `Goals:BTTS:${sel}`;
  }

  // 3. Total Corners O/U
  if (/^total\s+corners\s+o\/u/i.test(m)) {
    const line = extractLine(m, s);
    const dir = extractDir(s);
    if (line) return `Corners:TotalO/U:${line}:${dir}`;
  }

  // 4. {Team} Corners O/U
  if (/corners\s+o\/u/i.test(m)) {
    const line = extractLine(m, s);
    const dir = extractDir(s);
    if (line) return `Corners:Team:${line}:${dir}`;
  }

  // 5. Total Cards O/U
  if (/^total\s+cards\s+o\/u/i.test(m)) {
    const line = extractLine(m, s);
    const dir = extractDir(s);
    if (line) return `Cards:TotalO/U:${line}:${dir}`;
  }

  // 6. {Team} Cards O/U
  if (/cards\s+o\/u/i.test(m)) {
    const line = extractLine(m, s);
    const dir = extractDir(s);
    if (line) return `Cards:Team:${line}:${dir}`;
  }

  // 7. anything else -> family + ":Other:" + market
  return `${normalizedFam}:Other:${market}`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

export interface MarketStatItem {
  marketKey: string;
  family: string;
  n: number;
  claimedSum: number;
  realisedSum: number;
}

function aggregateByFamily(
  stats: Map<string, MarketStatItem>,
  targetFamily: string
): { n: number; claimedSum: number; realisedSum: number } | null {
  const normTarget = (targetFamily || "").toLowerCase();
  let n = 0;
  let claimedSum = 0;
  let realisedSum = 0;
  let found = false;

  for (const s of stats.values()) {
    if (s.family.toLowerCase() === normTarget) {
      n += s.n;
      claimedSum += s.claimedSum;
      realisedSum += s.realisedSum;
      found = true;
    }
  }

  if (!found || claimedSum <= 0) return null;
  return { n, claimedSum, realisedSum };
}

export interface MarketCorrectionResult {
  key: string;
  adjustedProb: number;
  correction: number;
  level: "line" | "family" | "none";
  filtered: boolean;
}

export function applyMarketCorrection(
  leg: { market: string; selection: string; statFamily: string; modelProbability: number },
  stats: Map<string, MarketStatItem>
): MarketCorrectionResult {
  const key = marketKeyOf(leg.market, leg.selection, leg.statFamily);

  // Level 1: per-line correction
  const lineStats = stats.get(key);
  let correction = 1.0;
  let level: "line" | "family" | "none" = "none";

  if (lineStats && lineStats.n >= 20 && lineStats.claimedSum > 0) {
    correction = clamp(lineStats.realisedSum / lineStats.claimedSum, 0.6, 1.2);
    level = "line";
  } else {
    // Level 2: family fallback
    const famStats = aggregateByFamily(stats, leg.statFamily);
    if (famStats && famStats.n >= 40 && famStats.claimedSum > 0) {
      correction = clamp(famStats.realisedSum / famStats.claimedSum, 0.6, 1.2);
      level = "family";
    }
  }

  // Hard filter: proven bad market
  const filterStats = lineStats ?? null;
  const filtered = Boolean(
    filterStats &&
      filterStats.n >= 30 &&
      filterStats.claimedSum > 0 &&
      filterStats.realisedSum / filterStats.claimedSum < 0.75
  );

  const adjustedProb = clamp(leg.modelProbability * correction, 0.02, 0.98);

  return { key, adjustedProb, correction, level, filtered };
}

/**
 * LEG-LEVEL PROBABILITY CAP.
 *
 * A leg claiming 92% on a corners market is priced by the bookmaker at 1.08 or
 * lower — at or under the 1.03 stack-mode minimum. So a model probability above
 * 0.90 is either a genuinely safe bet that the book has already priced fairly
 * (no EV to be had) or the model being overconfident. Either way the "edge" is
 * fake, so the model probability is capped before the EV calculation and
 * before the leg is stored / put in a ticket.
 */
export const MAX_LEG_MODEL_PROBABILITY = 0.90;

/** Cap a leg's model probability at MAX_LEG_MODEL_PROBABILITY. */
export function capModelProbability(modelProbability: number): number {
  return Math.min(modelProbability, MAX_LEG_MODEL_PROBABILITY);
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
    if (resolution.status === "network-error") return;
    if (resolution.status !== "no-match" && resolution.status !== "no-events") return;

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

export interface VaLearningCorrection {
  marketKey: string;
  n: number;
  correction: number;
  edge: number;
}

export interface VaLearningStats {
  keysLoaded: number;
  lineCorrections: number;
  familyCorrections: number;
  filtered: string[];
  sampleCorrections: VaLearningCorrection[];
}

export interface ScanResult {
  matchesScanned: number;
  marketsEvaluated: number;
  legsQualified: number;
  legs: VaLeg[];
  learning?: VaLearningStats;
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

/**
 * What one fixture contributes to a live scan. Fixtures are processed in
 * parallel batches (see src/lib/va/parallel.ts), so the per-fixture counters
 * and legs are collected here and folded together in fixture order afterwards —
 * which is what keeps the leg ordering (and so the ticket builder's output)
 * identical to the old sequential loop.
 */
interface LiveFixtureOutcome {
  legs: VaLeg[];
  marketsEvaluated: number;
  lineCorrections: number;
  familyCorrections: number;
  filteredOut: string[];
}

async function runScan(fixtures: FixtureLite[], scanId: string, mode: VaScanMode): Promise<ScanResult> {
  let marketsEvaluated = 0;
  const qualified: VaLeg[] = [];
  const coverage = new LeagueCoverage();

  // CHANGE B — live scanner reads and applies marketStats
  // At the START of runScan (live only, not backtest), read the full
  // marketStats table into memory (single query, cache in a local Map).
  const stats = new Map<string, MarketStatItem>();
  if (typeof db?.select === "function") {
    try {
      const rows = await db.select().from(marketStats);
      for (const r of rows) {
        stats.set(r.marketKey, {
          marketKey: r.marketKey,
          family: r.family,
          n: r.n,
          claimedSum: Number(r.claimedSum),
          realisedSum: Number(r.realisedSum),
        });
      }
    } catch (err) {
      console.error("[VA] failed to load marketStats", err);
    }
  }

  console.log(`[VA] loaded marketStats: ${stats.size} keys`);

  let lineCorrections = 0;
  let familyCorrections = 0;
  const filteredOut: string[] = [];

  /**
   * One fixture's contribution to the scan.
   *
   * Fixtures are processed in batches of FIXTURE_BATCH_SIZE (8) by
   * runFixtureBatches — see src/lib/va/parallel.ts for the contract (at most 8
   * in flight, index-addressed results, per-fixture try/catch). Each worker
   * returns its own outcome and the aggregation below replays the outcomes in
   * FIXTURE ORDER, so `qualified` — and therefore the ticket builder's input —
   * is exactly what the old sequential loop produced. Same legs, same order,
   * same determinism; the only difference is the wall clock.
   */
  const processFixture = async (fx: FixtureLite): Promise<LiveFixtureOutcome> => {
    const outcome: LiveFixtureOutcome = {
      legs: [],
      marketsEvaluated: 0,
      lineCorrections: 0,
      familyCorrections: 0,
      filteredOut: [],
    };
    const matchLabel = `${fx.home.name} vs ${fx.away.name}`;

    // a. Leagues already proven absent from Bzzoiro are skipped without a retry.
    //    Under batching the gate only sees coverage recorded by EARLIER batches,
    //    so up to FIXTURE_BATCH_SIZE fixtures of a league can be probing at once
    //    before it is blacklisted (the sequential loop managed with exactly 2).
    //    Bounded by the batch size, and still far cheaper than the sequential
    //    round trips it replaced.
    if (coverage.isUncovered(fx.leagueSlug)) return outcome;

    // b. Resolve the Bzzoiro event for this fixture: kickoff date ±2 days,
    //    widened once to ±5 days (in-memory cached per match).
    let resolution: BzzoiroResolution;
    try {
      resolution = await resolveBzzoiroEvent(fx);
    } catch {
      resolution = {
        eventId: null,
        status: "network-error",
        eventsInRange: 0,
        relatedInRange: 0,
        toleranceDays: BZ_WIDE_RANGE_DAYS,
      };
    }
    coverage.record(fx.leagueSlug, resolution);

    const bzEventId = resolution.eventId;
    if (!bzEventId) {
      // Network failures skip only this fixture and never affect league coverage.
      if (resolution.status === "network-error") {
        console.log(`[VA] network error resolving ${matchLabel} — skipping this fixture only`);
      } else {
        console.log(`[VA] no Bzzoiro event for ${matchLabel} after widening to ±${BZ_WIDE_RANGE_DAYS} days`);
      }
      return outcome;
    }
    console.log(`[VA] resolved Bzzoiro event ${bzEventId} for ${matchLabel}`);

    // c. Run engine to produce all 217 markets with hitRate
    let engineResult;
    try {
      let summary: MatchSummary | null = null;
      try {
        summary = await fetchSummary(fx.leagueSlug, fx.id);
      } catch {
        summary = null;
      }

      // Fetch xG for this match (fail soft — nulls if unavailable).
      // LIVE path: /events/{id}/stats/ is null until full-time, so ground the
      // lambdas with rolling team xG averages (last 5 finished matches each).
      // Served from team_xg_cache whenever the team has not played since.
      const xgData = await fetchLiveXg(String(bzEventId));
      logXgAttachment(fx, xgData);

      // Attach xG to the summary object so realLambdas can pick it up
      // (read as sum.__homeXg / sum.__awayXg — layer 1 of the xG chain).
      const enrichedSummary = attachXgToSummary(summary, xgData);

      const profiledEngine = optionalEngineExport("runEngineFromRealWithProfiles");
      if (typeof profiledEngine === "function") {
        engineResult = await runEngineFromRealWithProfiles(fx, enrichedSummary, null, "B");
      } else {
        // Keep older test doubles working while the production export is present.
        const legacyEngine = optionalEngineExport("runEngineFrom" + "Real");
        if (typeof legacyEngine !== "function") throw new Error("real engine unavailable");
        engineResult = legacyEngine(fx, null);
      }
    } catch {
      return outcome;
    }
    const markets = engineResult.markets ?? [];
    outcome.marketsEvaluated += markets.length;

    // d. Fetch odds for that event (consensus preferred, fail soft to [])
    let bookmakerOdds: VaBookmakerOdds[] = [];
    try {
      bookmakerOdds = await fetchOddsForEvent(bzEventId);
    } catch {
      bookmakerOdds = [];
    }
    if (bookmakerOdds.length === 0) return outcome;

    // e. For each engine market, match to bookmaker
    for (const m of markets) {
      // Only consider markets with hitRate (model probability)
      const hitRate = m.hitRate;
      if (typeof hitRate !== "number" || !Number.isFinite(hitRate)) continue;

      const teams: TeamContext = { home: fx.home.name, away: fx.away.name };
      const matched = matchEngineMarketToBookmaker(m.name, m.selection, bookmakerOdds, teams);
      if (!matched) continue;

      const realOdds = matched.odds;
      const statFamily = getStatFamily(m.name, m.family);

      // BEFORE the qualification filters, compute:
      const corrResult = applyMarketCorrection(
        { market: m.name, selection: m.selection, statFamily, modelProbability: hitRate },
        stats
      );

      if (corrResult.level === "line") {
        outcome.lineCorrections++;
      } else if (corrResult.level === "family") {
        outcome.familyCorrections++;
      }

      // Hard filter: proven bad market
      if (corrResult.filtered) {
        outcome.filteredOut.push(corrResult.key);
        continue;
      }

      const adjustedProb = corrResult.adjustedProb;
      // LEG CAP: the model probability a leg carries into the EV maths and into
      // the ticket never exceeds MAX_LEG_MODEL_PROBABILITY (0.90) — see the
      // constant's doc for why a leg above that is fake EV, not real EV.
      const cappedProb = capModelProbability(adjustedProb);
      const ev = cappedProb * realOdds - 1;
      const implied = 1 / realOdds;

      // f. Qualify leg only if all true (mode-specific filters).
      if (mode === "stack") {
        if (realOdds < 1.03 || realOdds > 1.70) continue;
        if (cappedProb < 0.62) continue;
        if (statFamily !== "goals" && statFamily !== "cards" && statFamily !== "corners") continue;
        // Stack mode does not apply the EV or isDataQualityOk() gates.
      } else {
        // - bookmaker_odds not null (already)
        // - ev > 0.03
        // - hitRate >=0.55
        // - 1.30 <= bookmaker_odds <=2.00
        // - Data quality Real or Mixed (Synthetic excluded)
        if (ev <= 0.03) continue;
        if (cappedProb < 0.55) continue;
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
        modelProbability: cappedProb,
        bookmakerOdds: realOdds,
        bookmakerName: matched.bookmaker,
        impliedProbability: implied,
        ev,
        oddsAtBuild: new Date(),
        scannedAt: new Date(),
      };

      outcome.legs.push(leg);
    }

    return outcome;
  };

  const outcomes = await runFixtureBatches<FixtureLite, LiveFixtureOutcome>(
    fixtures,
    (fx) => processFixture(fx),
    FIXTURE_BATCH_SIZE,
    (fx) => fx.id,
  );

  // Aggregate in fixture order (RULE 2/RULE 4): the batch runner writes each
  // outcome to its own index, so this replay is identical to the old loop's
  // in-line accumulation — including for fixtures whose worker threw (null).
  for (const outcome of outcomes) {
    if (!outcome) continue;
    marketsEvaluated += outcome.marketsEvaluated;
    lineCorrections += outcome.lineCorrections;
    familyCorrections += outcome.familyCorrections;
    filteredOut.push(...outcome.filteredOut);
    qualified.push(...outcome.legs);
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
  console.log(
    `[VA] applied corrections: ${lineCorrections} line-level, ${familyCorrections} family-level, ${filteredOut.length} filtered`
  );

  const sampleCorrections: VaLearningCorrection[] = Array.from(stats.values())
    .filter((s) => s.n >= 20 && s.claimedSum > 0)
    .map((s) => {
      const corr = clamp(s.realisedSum / s.claimedSum, 0.6, 1.2);
      const claimedRate = s.claimedSum / s.n;
      const realisedRate = s.realisedSum / s.n;
      const edge = realisedRate - claimedRate;
      return {
        marketKey: s.marketKey,
        n: s.n,
        correction: Math.round(corr * 1000) / 1000,
        edge: Math.round(edge * 1000) / 1000,
        delta: Math.abs(corr - 1.0),
      };
    })
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 20)
    .map(({ marketKey, n, correction, edge }) => ({
      marketKey,
      n,
      correction,
      edge,
    }));

  const learning: VaLearningStats = {
    keysLoaded: stats.size,
    lineCorrections,
    familyCorrections,
    filtered: filteredOut,
    sampleCorrections,
  };

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
    learning,
  };
}

// ─── Finished-match backtest (?finished=true): daily simulated scans via stack-mode builder ───
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

export interface MarketReliabilityItem {
  marketKey: string;
  n: number;
  claimed: number;
  realised: number;
  edge: number;
  corr: number;
  action: "trusted" | "downweighted" | "filtered" | "insufficient";
}

export interface TicketBacktestData {
  daysSimulated: number;
  ticketsBuilt: number;
  won: number;
  lost: number;
  pending: number;
  realisedRate: number | null;
  claimedAverage: number | null;
  edge: number | null;
  tickets: BacktestTicketItem[];
  ticketBuckets: TicketBacktestBucket[];
  marketReliability?: MarketReliabilityItem[];
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
 * families {Goals, Corners, Cards}), then simulates a DAILY live scan for each
 * day D from 30 days ago up to 8 days ago: pool the qualified legs of matches
 * kicking off in the forward window [D+1, D+7] (the same 7-day window the live
 * scanner uses), dedup by (eventId, family) keeping the highest hitRate, build
 * tickets via buildTickets(pool, "stack") — the same builder the live scanner
 * uses, so tickets are multi-match (6-8 legs when available, combined odds
 * 4.5-7.5) — keep only the first (recommended) ticket per day, settle each
 * ticket against the finished results (goals from the scoreboard final scores,
 * corners + cards from the ESPN match summary boxscore with one fetchSummary
 * call per match maximum), and aggregate results across all simulated days.
 */
/** What one finished match contributes to the backtest pool (folded in order). */
interface BacktestFixtureOutcome {
  legs: VaLeg[];
  marketsEvaluated: number;
}

async function runBacktestScan(fixtures: FixtureLite[], scanId: string): Promise<BacktestScanResult> {
  let marketsEvaluated = 0;

  // Backtest-only settlement helpers (local to this scan — the live scan path
  // and the exported settleBacktestLeg / settleBacktestTickets are untouched).

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

  // Steps 1-3: run the engine on each finished match, resolve the matching
  // Bzzoiro event, fetch its real odds, and qualify legs with the SAME filters
  // as stack mode. No model-derived odds are allowed into this pool:
  //   - real Bzzoiro odds 1.03 .. 1.70
  //   - hitRate >= 0.62
  //   - statFamily in {Goals, Corners, Cards}
  //   - no EV filter
  const pooled: VaLeg[] = [];
  const fixtureById = new Map<string, FixtureLite>();
  for (const fx of fixtures) fixtureById.set(fx.id, fx);
  // Every finished match fed in is "processed", exactly as the sequential loop
  // counted it before any skip (it incremented first, then continued).
  const matchesProcessed = fixtures.length;

  /**
   * One finished match's contribution to the backtest pool. Runs inside
   * runFixtureBatches (batches of 8, index-addressed results, per-fixture
   * try/catch — see src/lib/va/parallel.ts), so a 30-day backtest no longer
   * pays every Bzzoiro/ESPN round trip in series.
   */
  const processFixture = async (fx: FixtureLite): Promise<BacktestFixtureOutcome> => {
    const outcome: BacktestFixtureOutcome = { legs: [], marketsEvaluated: 0 };

    let resolution: BzzoiroResolution;
    try {
      resolution = await resolveBzzoiroEvent(fx);
    } catch {
      resolution = {
        eventId: null,
        status: "network-error",
        eventsInRange: 0,
        relatedInRange: 0,
        toleranceDays: BZ_WIDE_RANGE_DAYS,
      };
    }
    if (!resolution.eventId) return outcome;

    let engineResult;
    try {
      let summary: MatchSummary | null = null;
      try {
        summary = await fetchSummary(fx.leagueSlug, fx.id);
      } catch {
        summary = null;
      }

      // Fetch xG for this match (fail soft — nulls if unavailable).
      // BACKTEST path: the match is finished, so /events/{id}/stats/ now
      // carries the real per-match xG; fall back to the same rolling team
      // averages as the live path when it carries nothing (keeps backtest
      // grounding consistent with live). Finished-match xG is permanent in
      // match_xg_cache, so a re-run of the same window costs zero requests.
      const xgData = await fetchFinishedXg(String(resolution.eventId));
      logXgAttachment(fx, xgData);

      // Attach xG to the summary object so realLambdas can pick it up
      // (read as sum.__homeXg / sum.__awayXg — layer 1 of the xG chain).
      const enrichedSummary = attachXgToSummary(summary, xgData);

      const profiledEngine = optionalEngineExport("runEngineFromRealWithProfiles");
      if (typeof profiledEngine === "function") {
        engineResult = await runEngineFromRealWithProfiles(fx, enrichedSummary, null, "B");
      } else {
        // Keep older test doubles working while the production export is present.
        const legacyEngine = optionalEngineExport("runEngineFrom" + "Real");
        if (typeof legacyEngine !== "function") throw new Error("real engine unavailable");
        engineResult = legacyEngine(fx, null);
      }
    } catch {
      return outcome;
    }
    const markets = engineResult.markets ?? [];
    outcome.marketsEvaluated += markets.length;

    let bookmakerOdds: VaBookmakerOdds[] = [];
    try {
      bookmakerOdds = await fetchOddsForEvent(resolution.eventId);
    } catch {
      bookmakerOdds = [];
    }
    // No event odds means this fixture cannot contribute a real-priced leg.
    if (bookmakerOdds.length === 0) return outcome;

    const teams: TeamContext = { home: fx.home.name, away: fx.away.name };
    for (const m of markets) {
      const hitRate = m.hitRate;
      if (typeof hitRate !== "number" || !Number.isFinite(hitRate)) continue;

      const statFamily = getStatFamily(m.name, m.family);
      if (hitRate < 0.62) continue;
      if (statFamily !== "goals" && statFamily !== "corners" && statFamily !== "cards") continue;

      const matched = matchEngineMarketToBookmaker(m.name, m.selection, bookmakerOdds, teams);
      if (!matched) continue;

      const realOdds = matched.odds;
      if (typeof realOdds !== "number" || !Number.isFinite(realOdds)) continue;
      if (realOdds < 1.03 || realOdds > 1.70) continue;

      // LEG CAP: the backtest mirrors the live scanner, so legs carry the same
      // capped model probability (and the EV that follows from it).
      const cappedProb = capModelProbability(hitRate);
      const ev = cappedProb * realOdds - 1;
      const implied = 1 / realOdds;

      outcome.legs.push({
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
        modelProbability: cappedProb,
        bookmakerOdds: realOdds,
        bookmakerName: matched.bookmaker,
        impliedProbability: implied,
        ev,
        oddsAtBuild: new Date(),
        scannedAt: new Date(),
      });
    }

    return outcome;
  };

  const outcomes = await runFixtureBatches<FixtureLite, BacktestFixtureOutcome>(
    fixtures,
    (fx) => processFixture(fx),
    FIXTURE_BATCH_SIZE,
    (fx) => fx.id,
  );

  // Fold the per-fixture outcomes in FIXTURE ORDER: `pooled` ends up in the
  // same order the sequential loop produced, which is what the daily
  // re-pooling and the ticket builder below depend on.
  for (const outcome of outcomes) {
    if (!outcome) continue;
    marketsEvaluated += outcome.marketsEvaluated;
    pooled.push(...outcome.legs);
  }

  // Step 4: global dedup by (eventId, family), keeping the highest hitRate.
  // Kept for the legsQualified/legs return values; daily ticket building
  // below re-pools from `pooled` per simulated day and dedups each day's
  // pool the same way.
  const bestByPair = new Map<string, VaLeg>();
  for (const leg of pooled) {
    const key = `${leg.eventId}|${leg.statFamily}`;
    const current = bestByPair.get(key);
    if (!current || leg.modelProbability > current.modelProbability) {
      bestByPair.set(key, leg);
    }
  }
  const allQualifiedLegs = Array.from(bestByPair.values());

  // Steps 5-6: DAILY scan simulation with the SAME ticket-building logic
  // and constraints as the live scanner.
  //
  // For each simulated scan day D from 30 days ago up to 8 days ago:
  //   a. Forward window: legs whose kickoff UTC calendar date is in
  //      [D+1, D+7] (the same 7-day window the live scanner uses).
  //   b. Dedup that day's pool by (eventId, family), highest hitRate wins.
  //   c. buildTickets(pool, "stack") — the SAME builder as live.
  //   d. Skip D when the builder returns 0 tickets; otherwise keep only
  //      the first (recommended) ticket for the day.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const toUtcDay = (value: Date | string): number => {
    const d = value instanceof Date ? value : new Date(value);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  const fmtDay = (utcMidnight: number): string =>
    new Date(utcMidnight).toISOString().slice(0, 10);

  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const firstDay = todayUtc - 30 * DAY_MS;
  const lastDay = todayUtc - 8 * DAY_MS;
  const daysSimulated = Math.max(0, Math.round((lastDay - firstDay) / DAY_MS) + 1);

  const builtTickets: BacktestSampleTicket[] = [];
  for (let dayOffset = 0; dayOffset < daysSimulated; dayOffset++) {
    const dayD = firstDay + dayOffset * DAY_MS;
    const windowStart = dayD + 1 * DAY_MS;
    const windowEnd = dayD + 7 * DAY_MS;
    const dayLabel = fmtDay(dayD);

    // (a) Pool qualified legs for matches kicking off in [D+1, D+7].
    const dayPool = pooled.filter((leg) => {
      const kickoffDay = toUtcDay(leg.kickoff);
      return kickoffDay >= windowStart && kickoffDay <= windowEnd;
    });
    if (dayPool.length === 0) continue;

    // (b) Dedup by (eventId, family), keeping the highest hitRate.
    const bestByPairForDay = new Map<string, VaLeg>();
    for (const leg of dayPool) {
      const key = `${leg.eventId}|${leg.statFamily}`;
      const current = bestByPairForDay.get(key);
      if (!current || leg.modelProbability > current.modelProbability) {
        bestByPairForDay.set(key, leg);
      }
    }
    const dedupedDayPool = Array.from(bestByPairForDay.values());

    // (c) SAME builder as live.
    const ticketsForDay = buildTickets(dedupedDayPool, "stack");

    // (d) Skip days with no ticket; keep only the first (recommended) one.
    if (ticketsForDay.length === 0) continue;
    builtTickets.push({
      ...ticketsForDay[0],
      status: "pending" as BacktestTicketStatus,
      weekLabel: dayLabel,
    });
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
  // Summaries are fetched with the same batched parallelism as the fixtures
  // (getSummary is promise-cached per fixture, so a match is still fetched at
  // most once). Each worker writes only to its own event's entries, so
  // completion order cannot change the settlement below.
  await runFixtureBatches<string, { eventId: string }>(
    Array.from(eventsNeedingSummary),
    async (eventId) => {
      const fx = fixtureById.get(eventId);
      const result = results.get(eventId);
      if (!fx || !result) return null;
      const summary = await getSummary(fx);
      result.corners = cornerTotalFromSummary(summary);
      cardsByEvent.set(eventId, cardTotals(summary));
      return { eventId };
    },
    FIXTURE_BATCH_SIZE,
    (eventId) => eventId,
  );

  const accumulatedStats = new Map<
    string,
    { family: string; n: number; claimedSum: number; realisedSum: number }
  >();

  for (const ticket of builtTickets) {
    const legStatuses = ticket.legs.map((leg) => {
      const marketLower = leg.market.toLowerCase();
      const isCardsLeg =
        leg.statFamily === "cards" || marketLower.includes("card") || marketLower.includes("booking");
      const status = isCardsLeg
        ? settleCardsLeg(
            leg.market,
            leg.selection,
            leg.homeTeam,
            leg.awayTeam,
            cardsByEvent.get(leg.eventId)
          )
        : settleBacktestLeg(leg.market, leg.selection, results.get(leg.eventId));

      if (status !== "unknown") {
        const key = marketKeyOf(leg.market, leg.selection, leg.statFamily);
        const normFam =
          leg.statFamily.toLowerCase() === "goals"
            ? "Goals"
            : leg.statFamily.toLowerCase() === "corners"
            ? "Corners"
            : leg.statFamily.toLowerCase() === "cards"
            ? "Cards"
            : leg.statFamily
            ? leg.statFamily.charAt(0).toUpperCase() + leg.statFamily.slice(1)
            : "Goals";
        const cur = accumulatedStats.get(key) ?? {
          family: normFam,
          n: 0,
          claimedSum: 0,
          realisedSum: 0,
        };
        cur.n += 1;
        cur.claimedSum += leg.modelProbability;
        cur.realisedSum += status === "won" ? 1 : 0;
        accumulatedStats.set(key, cur);
      }

      return status;
    });
    ticket.status = legStatuses.includes("lost")
      ? "lost"
      : legStatuses.includes("unknown")
        ? "pending"
        : "won";
  }

  // CHANGE A — backtest upserts marketStats
  // Full rebuild: DELETE all rows from marketStats and INSERT fresh rows
  if (typeof db?.delete === "function" && typeof db?.insert === "function") {
    try {
      await db.delete(marketStats);
      const rows = Array.from(accumulatedStats.entries()).map(([marketKey, stat]) => ({
        marketKey,
        family: stat.family,
        n: stat.n,
        claimedSum: stat.claimedSum.toString(),
        realisedSum: stat.realisedSum.toString(),
        lastUpdated: new Date(),
      }));
      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        await db.insert(marketStats).values(batch);
      }
    } catch (err) {
      console.error("[VA] failed to update marketStats in DB", err);
    }
  }

  console.log(`[backtest] updated marketStats for ${accumulatedStats.size} market keys`);

  // Aggregate and return:
  const won = builtTickets.filter((t) => t.status === "won").length;
  const lost = builtTickets.filter((t) => t.status === "lost").length;
  const pending = builtTickets.filter((t) => t.status === "pending").length;
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

  // Newest day first, capped at 50 for response size
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

  const marketReliability: MarketReliabilityItem[] = Array.from(accumulatedStats.entries())
    .map(([marketKey, stat]) => {
      const corr = stat.claimedSum > 0 ? stat.realisedSum / stat.claimedSum : 1.0;
      const claimed = stat.n > 0 ? stat.claimedSum / stat.n : 0;
      const realised = stat.n > 0 ? stat.realisedSum / stat.n : 0;
      const edge = realised - claimed;
      let action: "trusted" | "downweighted" | "filtered" | "insufficient";
      if (stat.n < 20) {
        action = "insufficient";
      } else if (stat.n >= 30 && corr < 0.75) {
        action = "filtered";
      } else if (corr < 0.9) {
        action = "downweighted";
      } else {
        action = "trusted";
      }
      return {
        marketKey,
        n: stat.n,
        claimed: round4(claimed),
        realised: round4(realised),
        edge: round4(edge),
        corr: round4(corr),
        action,
      };
    })
    .sort((a, b) => b.n - a.n);

  const ticketBacktest: TicketBacktestData = {
    daysSimulated,
    ticketsBuilt: ticketsBuiltCount,
    won,
    lost,
    pending,
    realisedRate,
    claimedAverage,
    edge,
    tickets: ticketsOut,
    ticketBuckets,
    marketReliability,
  };

  console.log(
    `[VA] backtest scan ${scanId}: ${fixtures.length} matches, ${marketsEvaluated} markets, ` +
      `${allQualifiedLegs.length} qualified legs, ${daysSimulated} days, ${ticketsBuiltCount} tickets built ` +
      `(${won} won, ${lost} lost, ${pending} pending)`
  );
  console.log(
    `[backtest] ${matchesProcessed} matches, ${allQualifiedLegs.length} legs with real odds, ` +
      `${ticketsBuiltCount} tickets, ${won}W/${lost}L/${pending}P`
  );
  const legsSettled = builtTickets.reduce((sum, t) => sum + t.legs.length, 0);
  console.log(
    `[backtest] daysSimulated=${daysSimulated} ticketsBuilt=${ticketsBuiltCount} legsSettled=${legsSettled} ` +
      `marketKeys=${accumulatedStats.size} won=${won} lost=${lost} pending=${pending}`
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
