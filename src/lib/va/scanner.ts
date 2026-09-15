// Value Accumulator — Scanner (independent, no accumulator reuse)
import { fetchScoreboard, fetchSummary, type FixtureLite } from "@/lib/espn";
import { leagueTier } from "@/lib/leaguePriority";
import { runEngineFromRealWithProfiles } from "@/lib/engine";
import {
  fetchOddsForEvent,
  resolveBzzoiroEvent,
  BZ_WIDE_RANGE_DAYS,
  type BzzoiroResolution,
  type VaBookmakerOdds,
} from "./oddsFetcher";
import { matchEngineMarketToBookmaker, type TeamContext } from "./marketMap";
import type { VaLeg } from "./ticket";
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

export async function scanValueLegs(scanId: string, days = 7): Promise<ScanResult> {
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

  let marketsEvaluated = 0;
  const qualified: VaLeg[] = [];
  const coverage = new LeagueCoverage();

  for (const fx of capped) {
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
    //    Real per-fixture data (form, H2H, lineups, xG) from ESPN feeds the
    //    12-factor selector; without it the engine runs on league anchors only.
    let summary = null;
    try {
      summary = await fetchSummary(fx.leagueSlug, fx.id);
    } catch {
      // fail soft: keep summary null, engine falls back to anchors
    }
    let engineResult;
    try {
      engineResult = await runEngineFromRealWithProfiles(fx, summary);
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

      // f. Qualify leg only if all true:
      // - bookmaker_odds not null (already)
      // - ev > 0.03
      // - hitRate >=0.55
      // - 1.30 <= bookmaker_odds <=2.00
      // - Data quality Real or Mixed (Synthetic excluded)
      if (ev <= 0.03) continue;
      if (hitRate < 0.55) continue;
      if (realOdds < 1.3 || realOdds > 2.0) continue;
      if (!isDataQualityOk(engineResult.match.dataCompletenessScore)) continue;

      const statFamily = getStatFamily(m.name, m.family);

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

  // 5. Insert each qualified leg into va_legs
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
  console.log(`[VA] scan ${scanId}: ${capped.length} matches, ${marketsEvaluated} markets, ${qualified.length} qualified legs`);

  return {
    matchesScanned: capped.length,
    marketsEvaluated,
    legsQualified: qualified.length,
    legs: qualified,
  };
}
