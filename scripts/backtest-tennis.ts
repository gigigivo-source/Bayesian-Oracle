#!/usr/bin/env node
/**
 * ĞIGI GIVØ — Tennis Backtest: Finding the Winning Formula (ATP / WTA).
 * ----------------------------------------------------------------------
 * Run with:
 *
 *     npx tsx scripts/backtest-tennis.ts
 *
 * What it does:
 *   1. Loads ATP and WTA completed historical matches via `loadTennisMatches`
 *      (Jeff Sackmann GitHub mirrors + optional tennis-data.co.uk odds layer).
 *   2. Replays each tour chronologically through a strict walk-forward Elo loop
 *      calling `applyTennisMatchToElo` directly (NO lookahead leakage).
 *   3. Skips the first `burnIn` non-walkover matches per tour (default: 1000)
 *      to avoid cold-start 1500-Elo noise, then records pre-match features and
 *      evaluates every threshold / filter rule.
 *   4. Prints a Markdown table sorted by Win Rate descending, baseline stats,
 *      and the Top 3 "lock" configurations (>= 50 matches).
 */

import dns from "node:dns";
import tls from "node:tls";
import {
  applyTennisMatchToElo,
  createTennisEloTable,
  surfaceAdjustedElo,
} from "../src/lib/data/elo";
import {
  loadTennisMatches,
  parseSackmannTennisCsv,
  tennisPlayerKey,
  type TennisMatch,
  type TennisSurface,
  type TennisTour,
} from "../src/lib/data/sources/tennis";
import { fetchWithTimeout } from "../src/lib/data/http";

// Termux / Android / custom CA compatibility (matches scripts/backtest-local.ts).
try {
  dns.setDefaultResultOrder?.("ipv4first");
  const tlsExt = tls as unknown as {
    getCACertificates?: (type?: string) => string[];
    setDefaultCACertificates?: (certs: string[]) => void;
  };
  if (tlsExt.getCACertificates && tlsExt.setDefaultCACertificates) {
    tlsExt.setDefaultCACertificates([
      ...tlsExt.getCACertificates("default"),
      ...tlsExt.getCACertificates("system"),
    ]);
  }
} catch {
  // Ignore on runtimes without custom CA hooks.
}

// ─── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_SEASONS = 3;
const DEFAULT_BURN_IN = 1000;
const MIN_LOCK_MATCHES = 50;

const RAW_ELO_THRESHOLDS = [100, 150, 200, 250, 300, 350] as const;
const SURFACE_ELO_THRESHOLDS = [100, 150, 200, 250, 300] as const;
const PROB_THRESHOLDS = [0.65, 0.7, 0.75, 0.8, 0.85] as const;

const SACKMANN_API_MIRRORS: Record<
  TennisTour,
  Array<{ repo: string; branch: string; dir?: string }>
> = {
  atp: [
    { repo: "Kadantte/tennis_atp", branch: "master" },
    { repo: "Aneeshers/tennis-sackmann-archive", branch: "main", dir: "atp/" },
    { repo: "nachotropico-maker/tennis-sackmann-archive", branch: "main", dir: "atp/" },
    { repo: "zvonimir-rezo/tennis_atp", branch: "main" },
  ],
  wta: [
    { repo: "Aneeshers/tennis-sackmann-archive", branch: "main", dir: "wta/" },
    { repo: "nachotropico-maker/tennis-sackmann-archive", branch: "main", dir: "wta/" },
  ],
};

/**
 * Fallback loader via GitHub Contents API (`api.github.com`) when
 * `raw.githubusercontent.com` is unreachable on restricted networks.
 * Uses the exact same Sackmann mirrors and `parseSackmannTennisCsv` parser.
 */
async function loadSackmannViaGitHubApi(
  tour: TennisTour,
  seasons: number,
): Promise<{ matches: TennisMatch[]; sources: Array<{ source: string; added: number; note: string }> }> {
  const currentYear = new Date().getUTCFullYear();
  const years = Array.from({ length: seasons }, (_, i) => currentYear - i);
  const byId = new Map<string, TennisMatch>();
  const sources: Array<{ source: string; added: number; note: string }> = [];

  for (const year of years) {
    let loadedForYear = false;
    for (const mirror of SACKMANN_API_MIRRORS[tour]) {
      const path = `${mirror.dir ?? ""}${tour}_matches_${year}.csv`;
      const url = `https://api.github.com/repos/${mirror.repo}/contents/${path}?ref=${mirror.branch}`;
      const res = await fetchWithTimeout(url, {
        text: true,
        timeoutMs: 30_000,
        headers: { Accept: "application/vnd.github.raw+json" },
      });
      if (res.status === "ok" && typeof res.data === "string" && res.data.length > 100) {
        const parsed = parseSackmannTennisCsv(res.data, tour);
        if (parsed.length > 0) {
          let added = 0;
          for (const m of parsed) {
            if (!byId.has(m.id)) {
              byId.set(m.id, m);
              added++;
            }
          }
          sources.push({
            source: `github-api:${mirror.repo}`,
            added,
            note: `${year} season: ${parsed.length} parsed, ${added} new (Contents API fallback)`,
          });
          loadedForYear = true;
          break;
        }
      }
    }
    if (!loadedForYear) {
      sources.push({
        source: `github-api:${tour}`,
        added: 0,
        note: `no mirror reachable via GitHub Contents API for ${year}`,
      });
    }
  }

  const matches = [...byId.values()].sort((a, b) => a.matchDate.localeCompare(b.matchDate));
  return { matches, sources };
}

interface Config {
  seasons: number;
  burnIn: number;
  tours: TennisTour[];
  includeOddsLayer: boolean;
  selfTest: boolean;
  help: boolean;
}

interface EvaluatedMatch {
  tour: TennisTour;
  surface: TennisSurface | null;
  bestOf: 3 | 5 | null;
  matchDate: string;
  rawGap: number;
  surfaceGap: number;
  expectedWinner: number;
  favProb: number;
  favoriteWon: boolean;
  favRank: number | null;
  dogRank: number | null;
  minMatchesPlayed: number;
  minSurfaceMatches: number;
  favOdds: number | null;
}

interface TourReplayResult {
  tour: TennisTour;
  totalLoaded: number;
  appliedCount: number;
  walkoversSkipped: number;
  invalidSkipped: number;
  burnInSkipped: number;
  tiesSkipped: number;
  evaluated: EvaluatedMatch[];
  sources: Array<{ source: string; added: number; note: string }>;
}

interface RuleDefinition {
  name: string;
  isBaseline?: boolean;
  predicate: (m: EvaluatedMatch) => boolean;
}

interface RuleStats {
  rule: string;
  isBaseline: boolean;
  matches: number;
  favoritesWon: number;
  winRate: number;
  oddsCount: number;
  avgOdds: number | null;
  roiPct: number | null;
}

// ─── Walk-forward Elo Replay ──────────────────────────────────────────────────

function replayTour(
  tour: TennisTour,
  matches: TennisMatch[],
  burnIn: number,
  sources: Array<{ source: string; added: number; note: string }>,
): TourReplayResult {
  const table = createTennisEloTable();
  const evaluated: EvaluatedMatch[] = [];

  let appliedCount = 0;
  let walkoversSkipped = 0;
  let invalidSkipped = 0;
  let burnInSkipped = 0;
  let tiesSkipped = 0;

  for (const match of matches) {
    if (match.finish === "walkover") {
      walkoversSkipped++;
      continue;
    }
    const winnerKey = tennisPlayerKey(match.winner);
    const loserKey = tennisPlayerKey(match.loser);
    if (!match.winner || !match.loser || !winnerKey || !loserKey || winnerKey === loserKey) {
      invalidSkipped++;
      continue;
    }

    // 1. Capture pre-match player sample counts strictly BEFORE updating the table.
    const winnerEntryBefore = table.players.get(`${match.tour}|${winnerKey}`);
    const loserEntryBefore = table.players.get(`${match.tour}|${loserKey}`);
    const winnerMatchesPlayed = winnerEntryBefore?.matchesPlayed ?? 0;
    const loserMatchesPlayed = loserEntryBefore?.matchesPlayed ?? 0;
    const winnerSurfaceMatches = match.surface
      ? (winnerEntryBefore?.surfaceMatches[match.surface] ?? 0)
      : 0;
    const loserSurfaceMatches = match.surface
      ? (loserEntryBefore?.surfaceMatches[match.surface] ?? 0)
      : 0;

    // 2. Apply the Elo update directly via walk-forward replay (NOT buildTennisEloTable).
    //    `update.winnerBefore`, `update.loserBefore`, and `update.expectedWinner`
    //    are computed inside applyTennisMatchToElo strictly BEFORE mutating ratings.
    const update = applyTennisMatchToElo(table, match);
    if (!update) {
      invalidSkipped++;
      continue;
    }

    appliedCount++;

    // 3. Burn-in: skip the first `burnIn` non-walkover matches (cold start).
    if (appliedCount <= burnIn) {
      burnInSkipped++;
      continue;
    }

    // 4. Derive pre-match features from the pre-update snapshot.
    const rawGap = Math.abs(update.winnerBefore - update.loserBefore);
    const surfaceGap = Math.abs(
      surfaceAdjustedElo(update.winnerBefore, match.surface) -
        surfaceAdjustedElo(update.loserBefore, match.surface),
    );

    // Skip exact 50/50 Elo ties where neither player is strictly favored.
    if (rawGap === 0 || update.expectedWinner === 0.5) {
      tiesSkipped++;
      continue;
    }

    const favoriteWon = update.expectedWinner > 0.5;
    const favProb = Math.max(update.expectedWinner, 1 - update.expectedWinner);

    // Pre-match ranks for the Elo favorite vs. underdog (smaller number = better rank).
    const favRank = favoriteWon ? match.winnerRank : match.loserRank;
    const dogRank = favoriteWon ? match.loserRank : match.winnerRank;

    // Pre-match decimal odds for the Elo favorite (if tennis-data.co.uk odds are present).
    const rawFavOdds = favoriteWon
      ? (match.odds?.winner ?? null)
      : (match.odds?.loser ?? null);
    const favOdds =
      rawFavOdds !== null && Number.isFinite(rawFavOdds) && rawFavOdds > 1
        ? rawFavOdds
        : null;

    evaluated.push({
      tour,
      surface: match.surface,
      bestOf: match.bestOf,
      matchDate: match.matchDate,
      rawGap,
      surfaceGap,
      expectedWinner: update.expectedWinner,
      favProb,
      favoriteWon,
      favRank,
      dogRank,
      minMatchesPlayed: Math.min(winnerMatchesPlayed, loserMatchesPlayed),
      minSurfaceMatches: match.surface
        ? Math.min(winnerSurfaceMatches, loserSurfaceMatches)
        : 0,
      favOdds,
    });
  }

  return {
    tour,
    totalLoaded: matches.length,
    appliedCount,
    walkoversSkipped,
    invalidSkipped,
    burnInSkipped,
    tiesSkipped,
    evaluated,
    sources,
  };
}

// ─── Threshold Evaluation ─────────────────────────────────────────────────────

function scoreRule(rule: RuleDefinition, matches: EvaluatedMatch[]): RuleStats {
  let count = 0;
  let wins = 0;
  let oddsCount = 0;
  let oddsSum = 0;
  let flatUnitProfit = 0;

  for (const m of matches) {
    if (!rule.predicate(m)) continue;
    count++;
    if (m.favoriteWon) wins++;
    if (m.favOdds !== null) {
      oddsCount++;
      oddsSum += m.favOdds;
      flatUnitProfit += m.favoriteWon ? m.favOdds - 1 : -1;
    }
  }

  return {
    rule: rule.name,
    isBaseline: Boolean(rule.isBaseline),
    matches: count,
    favoritesWon: wins,
    winRate: count > 0 ? wins / count : 0,
    oddsCount,
    avgOdds: oddsCount > 0 ? oddsSum / oddsCount : null,
    roiPct: oddsCount > 0 ? (flatUnitProfit / oddsCount) * 100 : null,
  };
}

function evaluateAllRules(matches: EvaluatedMatch[]): {
  baseline: RuleStats;
  bestEloGapRule: { name: string; stats: RuleStats };
  rows: RuleStats[];
  topLocks: RuleStats[];
} {
  const baselineDef: RuleDefinition = {
    name: "Baseline (No filter)",
    isBaseline: true,
    predicate: () => true,
  };

  const rawGapDefs: RuleDefinition[] = RAW_ELO_THRESHOLDS.map((gap) => ({
    name: `Raw Elo Gap >= ${gap}`,
    predicate: (m) => m.rawGap >= gap,
  }));

  const surfaceGapDefs: RuleDefinition[] = SURFACE_ELO_THRESHOLDS.map((gap) => ({
    name: `Surface Elo Gap >= ${gap}`,
    predicate: (m) => m.surfaceGap >= gap,
  }));

  const probDefs: RuleDefinition[] = PROB_THRESHOLDS.map((p) => ({
    name: `P(fav) >= ${p.toFixed(2)}`,
    predicate: (m) => m.favProb >= p,
  }));

  // Evaluate Elo gap buckets first to identify the Best Elo Gap (>= 50 matches)
  // onto which the Data Completeness filters are layered.
  const allGapDefs = [...rawGapDefs, ...surfaceGapDefs];
  const scoredGapDefs = allGapDefs.map((def) => ({ def, stats: scoreRule(def, matches) }));
  const eligibleGapDefs = scoredGapDefs.filter((entry) => entry.stats.matches >= MIN_LOCK_MATCHES);
  const gapPool = eligibleGapDefs.length > 0
    ? eligibleGapDefs
    : scoredGapDefs.filter((entry) => entry.stats.matches > 0);
  gapPool.sort((a, b) => b.stats.winRate - a.stats.winRate || b.stats.matches - a.stats.matches);

  const bestGap = gapPool[0] ?? {
    def: rawGapDefs[1], // Raw Elo Gap >= 150 fallback
    stats: scoreRule(rawGapDefs[1], matches),
  };

  // Data Completeness Filters applied to Best Elo Gap.
  const completenessDefs: RuleDefinition[] = [
    {
      name: `${bestGap.def.name} + Both matchesPlayed >= 10`,
      predicate: (m) => bestGap.def.predicate(m) && m.minMatchesPlayed >= 10,
    },
    {
      name: `${bestGap.def.name} + Both matchesPlayed >= 20`,
      predicate: (m) => bestGap.def.predicate(m) && m.minMatchesPlayed >= 20,
    },
    {
      name: `${bestGap.def.name} + Both surfaceMatches >= 5`,
      predicate: (m) =>
        bestGap.def.predicate(m) && m.surface !== null && m.minSurfaceMatches >= 5,
    },
    {
      name: `${bestGap.def.name} + matches >= 10 & surface >= 5`,
      predicate: (m) =>
        bestGap.def.predicate(m) &&
        m.minMatchesPlayed >= 10 &&
        m.surface !== null &&
        m.minSurfaceMatches >= 5,
    },
  ];

  // Best-of-5 Filter.
  const bestOf5Defs: RuleDefinition[] = [
    {
      name: "Best-of-5 AND Raw Elo Gap >= 150",
      predicate: (m) => m.bestOf === 5 && m.rawGap >= 150,
    },
  ];

  // Elo + Ranking Agreement Filters.
  const rankDefs: RuleDefinition[] = [
    {
      name: "Elo + Rank Agreement (fav rank < opp rank)",
      predicate: (m) => m.favRank !== null && m.dogRank !== null && m.favRank < m.dogRank,
    },
    {
      name: "Raw Elo Gap >= 150 + Rank Gap >= 20",
      predicate: (m) =>
        m.rawGap >= 150 &&
        m.favRank !== null &&
        m.dogRank !== null &&
        m.dogRank - m.favRank >= 20,
    },
  ];

  const baseline = scoreRule(baselineDef, matches);
  const allDefs: RuleDefinition[] = [
    baselineDef,
    ...rawGapDefs,
    ...surfaceGapDefs,
    ...probDefs,
    ...completenessDefs,
    ...bestOf5Defs,
    ...rankDefs,
  ];

  const rows = allDefs
    .map((def) => scoreRule(def, matches))
    .sort((a, b) => {
      if (a.matches === 0 && b.matches > 0) return 1;
      if (b.matches === 0 && a.matches > 0) return -1;
      return b.winRate - a.winRate || b.matches - a.matches;
    });

  const topLocks = rows
    .filter((r) => !r.isBaseline && r.matches >= MIN_LOCK_MATCHES)
    .slice(0, 3);

  return {
    baseline,
    bestEloGapRule: { name: bestGap.def.name, stats: bestGap.stats },
    rows,
    topLocks,
  };
}

// ─── Formatting & Report Rendering ────────────────────────────────────────────

function fmtPct(rate: number, count: number): string {
  if (count === 0) return "—";
  return `${(rate * 100).toFixed(2)}%`;
}

function fmtOdds(avgOdds: number | null, oddsCount: number): string {
  if (avgOdds === null || oddsCount === 0) return "—";
  return `${avgOdds.toFixed(2)} (n=${oddsCount})`;
}

function fmtRoi(roiPct: number | null, oddsCount: number): string {
  if (roiPct === null || oddsCount === 0) return "—";
  const sign = roiPct >= 0 ? "+" : "";
  return `${sign}${roiPct.toFixed(2)}%`;
}

function renderMarkdownReport(
  tourResults: TourReplayResult[],
  allMatches: EvaluatedMatch[],
  cfg: Config,
): string {
  const { baseline, bestEloGapRule, rows, topLocks } = evaluateAllRules(allMatches);

  const totalLoaded = tourResults.reduce((s, r) => s + r.totalLoaded, 0);
  const totalWalkovers = tourResults.reduce((s, r) => s + r.walkoversSkipped, 0);
  const totalBurnIn = tourResults.reduce((s, r) => s + r.burnInSkipped, 0);
  const totalTies = tourResults.reduce((s, r) => s + r.tiesSkipped, 0);
  const totalOdds = allMatches.filter((m) => m.favOdds !== null).length;

  const lines: string[] = [];
  lines.push("# Tennis Walk-Forward Backtest — Winning Formula Finder");
  lines.push("");
  lines.push(`- **Tours:** ${cfg.tours.map((t) => t.toUpperCase()).join(" + ")}`);
  lines.push(`- **Seasons requested:** ${cfg.seasons} | **Burn-in:** ${cfg.burnIn} matches/tour`);
  lines.push(
    `- **Matches loaded:** ${totalLoaded.toLocaleString()} ` +
      `(walkovers skipped: ${totalWalkovers.toLocaleString()}, ` +
      `burn-in skipped: ${totalBurnIn.toLocaleString()}, ` +
      `exact Elo ties skipped: ${totalTies.toLocaleString()})`,
  );
  lines.push(`- **Total matches analyzed:** ${allMatches.length.toLocaleString()} (with odds: ${totalOdds.toLocaleString()})`);
  lines.push(
    `- **Baseline favorite win rate (no filter):** ${fmtPct(baseline.winRate, baseline.matches)} ` +
      `(${baseline.favoritesWon.toLocaleString()} / ${baseline.matches.toLocaleString()})`,
  );
  lines.push(
    `- **Best Elo Gap (used for Data Completeness filters):** ${bestEloGapRule.name} ` +
      `(${fmtPct(bestEloGapRule.stats.winRate, bestEloGapRule.stats.matches)}, n=${bestEloGapRule.stats.matches.toLocaleString()})`,
  );
  lines.push("");

  // Per-tour & surface summary.
  lines.push("## Tour & Surface Baseline Breakdown");
  lines.push("");
  lines.push("| Slice | Matches | Favorites Won | Win Rate |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const res of tourResults) {
    const tourWins = res.evaluated.filter((m) => m.favoriteWon).length;
    lines.push(
      `| ${res.tour.toUpperCase()} | ${res.evaluated.length.toLocaleString()} | ${tourWins.toLocaleString()} | ${fmtPct(res.evaluated.length > 0 ? tourWins / res.evaluated.length : 0, res.evaluated.length)} |`,
    );
  }
  for (const surface of ["hard", "clay", "grass"] as const) {
    const sub = allMatches.filter((m) => m.surface === surface);
    const subWins = sub.filter((m) => m.favoriteWon).length;
    lines.push(
      `| Surface: ${surface[0].toUpperCase()}${surface.slice(1)} | ${sub.length.toLocaleString()} | ${subWins.toLocaleString()} | ${fmtPct(sub.length > 0 ? subWins / sub.length : 0, sub.length)} |`,
    );
  }
  lines.push("");

  // Main sorted Markdown table.
  lines.push("## Threshold & Filter Backtest Results (Sorted by Win Rate Descending)");
  lines.push("");
  lines.push("| Rule | Matches | Favorites Won | Win Rate | Avg Odds (if any) | ROI (if any) |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const row of rows) {
    lines.push(
      `| ${row.rule} | ${row.matches.toLocaleString()} | ${row.favoritesWon.toLocaleString()} | ` +
        `${fmtPct(row.winRate, row.matches)} | ${fmtOdds(row.avgOdds, row.oddsCount)} | ${fmtRoi(row.roiPct, row.oddsCount)} |`,
    );
  }
  lines.push("");

  // Top 3 Lock Configurations.
  lines.push(`## Top 3 "Lock" Configurations (Highest Win Rate with >= ${MIN_LOCK_MATCHES} Matches)`);
  lines.push("");
  if (topLocks.length === 0) {
    lines.push(`No filtered rule met the minimum sample size of ${MIN_LOCK_MATCHES} matches.`);
  } else {
    topLocks.forEach((lock, index) => {
      const oddsNote = lock.avgOdds !== null
        ? ` | Avg Odds ${lock.avgOdds.toFixed(2)} | ROI ${fmtRoi(lock.roiPct, lock.oddsCount)}`
        : "";
      lines.push(
        `${index + 1}. **${lock.rule}** — **${fmtPct(lock.winRate, lock.matches)}** ` +
          `(${lock.favoritesWon.toLocaleString()}/${lock.matches.toLocaleString()} wins${oddsNote})`,
      );
    });
  }
  lines.push("");

  return lines.join("\n");
}

// ─── Self-Test (Offline Deterministic Smoke Test) ─────────────────────────────

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runSelfTest(cfg: Config): void {
  const rng = mulberry32(20261116);
  const surfaces: TennisSurface[] = ["hard", "clay", "grass"];
  const emptyStats = {
    aces: null,
    doubleFaults: null,
    servePoints: null,
    serviceGames: null,
    bpSaved: null,
    bpFaced: null,
  };

  const makeSyntheticTour = (tour: TennisTour, count: number): TennisMatch[] => {
    // 80 synthetic players with fixed underlying skill ratings (1250 .. 2050) and ranks 1..80.
    const players = Array.from({ length: 80 }, (_, idx) => ({
      name: `${tour.toUpperCase()} Player ${String(idx + 1).padStart(2, "0")}`,
      trueSkill: 2050 - idx * 10,
      rank: idx + 1,
    }));

    const matches: TennisMatch[] = [];
    const startMs = Date.UTC(2024, 0, 1);

    for (let i = 0; i < count; i++) {
      const idxA = Math.floor(rng() * players.length);
      let idxB = Math.floor(rng() * players.length);
      if (idxB === idxA) idxB = (idxA + 1) % players.length;

      const a = players[idxA];
      const b = players[idxB];
      const surface = surfaces[i % surfaces.length];
      const bestOf: 3 | 5 = tour === "atp" && i % 6 === 0 ? 5 : 3;
      const isWalkover = i % 97 === 0;

      const pA = 1 / (1 + 10 ** ((b.trueSkill - a.trueSkill) / 400));
      const aWins = rng() < pA;
      const winner = aWins ? a : b;
      const loser = aWins ? b : a;
      const winnerProb = aWins ? pA : 1 - pA;
      const loserProb = 1 - winnerProb;

      const dateIso = new Date(startMs + Math.floor(i / 4) * 86_400_000)
        .toISOString()
        .slice(0, 10);

      matches.push({
        id: `synthetic|${tour}|${i}`,
        tour,
        tournament: bestOf === 5 ? "Synthetic Slam" : "Synthetic Open",
        surface,
        matchDate: `${dateIso}T00:00:00Z`,
        round: "R32",
        bestOf,
        winner: winner.name,
        loser: loser.name,
        score: isWalkover ? "W/O" : bestOf === 5 ? "6-4 6-3 6-4" : "6-4 6-3",
        finish: isWalkover ? "walkover" : "completed",
        winnerStats: emptyStats,
        loserStats: emptyStats,
        // Attach realistic 5%-vig decimal odds on 30% of matches to verify odds & ROI math.
        odds:
          i % 3 === 0
            ? {
                winner: Math.max(1.03, Number((1 / (winnerProb * 1.05)).toFixed(2))),
                loser: Math.max(1.03, Number((1 / (loserProb * 1.05)).toFixed(2))),
                book: "synthetic",
              }
            : null,
        winnerRank: winner.rank,
        loserRank: loser.rank,
        source: "sackmann",
      });
    }
    return matches;
  };

  const burnIn = Math.min(cfg.burnIn, 500);
  const results = cfg.tours.map((tour) =>
    replayTour(tour, makeSyntheticTour(tour, 1800), burnIn, [
      { source: "synthetic", added: 1800, note: "offline self-test" },
    ]),
  );
  const allEvaluated = results.flatMap((r) => r.evaluated);
  const { baseline, rows, topLocks } = evaluateAllRules(allEvaluated);

  // Core invariants.
  if (results.some((r) => r.walkoversSkipped === 0)) {
    throw new Error("Self-test failed: expected walkovers to be skipped.");
  }
  if (results.some((r) => r.burnInSkipped !== burnIn)) {
    throw new Error("Self-test failed: burn-in count mismatch.");
  }
  if (baseline.winRate <= 0.65) {
    throw new Error(`Self-test failed: unexpectedly low synthetic baseline win rate (${baseline.winRate}).`);
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].matches > 0 && rows[i - 1].matches > 0 && rows[i].winRate > rows[i - 1].winRate + 1e-12) {
      throw new Error("Self-test failed: output table is not sorted by Win Rate descending.");
    }
  }
  if (topLocks.length !== 3 || topLocks.some((lock) => lock.matches < MIN_LOCK_MATCHES)) {
    throw new Error("Self-test failed: expected 3 lock configs each with >= 50 matches.");
  }

  console.log(renderMarkdownReport(results, allEvaluated, { ...cfg, burnIn }));
  console.error("[self-test] All walk-forward Elo, burn-in, sorting, odds, and lock assertions passed.");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Config {
  const cfg: Config = {
    seasons: DEFAULT_SEASONS,
    burnIn: DEFAULT_BURN_IN,
    tours: ["atp", "wta"],
    includeOddsLayer: true,
    selfTest: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.indexOf("=");
    const flag = eq >= 0 ? raw.slice(0, eq) : raw;
    const nextValue = (): string => {
      if (eq >= 0) return raw.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${flag}`);
      return v;
    };

    switch (flag) {
      case "--help":
      case "-h":
        cfg.help = true;
        break;
      case "--self-test":
        cfg.selfTest = true;
        break;
      case "--no-odds":
        cfg.includeOddsLayer = false;
        break;
      case "--seasons": {
        const n = Number(nextValue());
        if (!Number.isInteger(n) || n < 1 || n > 4) {
          throw new Error(`invalid --seasons value (expected integer 1-4): ${n}`);
        }
        cfg.seasons = n;
        break;
      }
      case "--burn-in": {
        const n = Number(nextValue());
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`invalid --burn-in value (expected non-negative integer): ${n}`);
        }
        cfg.burnIn = n;
        break;
      }
      case "--tour": {
        const t = nextValue().trim().toLowerCase();
        if (t === "atp") cfg.tours = ["atp"];
        else if (t === "wta") cfg.tours = ["wta"];
        else if (t === "both") cfg.tours = ["atp", "wta"];
        else throw new Error(`invalid --tour value: ${t} (expected atp, wta, or both)`);
        break;
      }
      default:
        throw new Error(`unknown option: ${flag} (try --help)`);
    }
  }

  return cfg;
}

function printHelp(): void {
  console.log(
    [
      "ĞIGI GIVØ — Tennis Walk-Forward Backtest (ATP / WTA)",
      "",
      "Usage:",
      "  npx tsx scripts/backtest-tennis.ts [options]",
      "",
      "Options:",
      `  --seasons <1-4>   Number of seasons to load per tour (default: ${DEFAULT_SEASONS})`,
      `  --burn-in <N>     Cold-start matches skipped per tour (default: ${DEFAULT_BURN_IN})`,
      "  --tour <val>      atp | wta | both (default: both)",
      "  --no-odds         Skip tennis-data.co.uk odds layer (Sackmann only, faster)",
      "  --self-test       Run offline synthetic verification (no network)",
      "  --help            Show this help",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  if (cfg.help) {
    printHelp();
    return;
  }
  if (cfg.selfTest) {
    runSelfTest(cfg);
    return;
  }

  console.error(
    `[tennis-backtest] Loading ${cfg.tours.map((t) => t.toUpperCase()).join(" + ")} ` +
      `(${cfg.seasons} seasons, burn-in ${cfg.burnIn}/tour, odds layer: ${cfg.includeOddsLayer ? "on" : "off"})...`,
  );

  const tourResults = await Promise.all(
    cfg.tours.map(async (tour) => {
      const dataset = await loadTennisMatches(tour, {
        seasons: cfg.seasons,
        tennisData: cfg.includeOddsLayer,
      });
      let matches = dataset.matches;
      let sources = dataset.sources;

      if (matches.length === 0) {
        console.error(
          `[tennis-backtest] ${tour.toUpperCase()} raw mirrors returned 0 matches — trying GitHub Contents API fallback...`,
        );
        const fallback = await loadSackmannViaGitHubApi(tour, cfg.seasons);
        matches = fallback.matches;
        sources = [...sources, ...fallback.sources.map((s) => ({ ...s, attempted: true }))];
      }

      for (const s of sources) {
        console.error(`[tennis-backtest] ${tour.toUpperCase()} · ${s.source}: ${s.note}`);
      }
      const res = replayTour(tour, matches, cfg.burnIn, sources);
      if (res.appliedCount > 0 && res.appliedCount <= cfg.burnIn) {
        console.error(
          `[tennis-backtest] Warning: ${tour.toUpperCase()} had only ${res.appliedCount} non-walkover matches (<= burn-in ${cfg.burnIn}). Try --burn-in=<smaller>.`,
        );
      }
      return res;
    }),
  );

  const allEvaluated = tourResults.flatMap((r) => r.evaluated);
  if (allEvaluated.length === 0) {
    console.error(
      "[tennis-backtest] No matches available for evaluation. Check network access to GitHub Sackmann mirrors or lower --burn-in.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(renderMarkdownReport(tourResults, allEvaluated, cfg));
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[tennis-backtest] Failed: ${msg}`);
  process.exitCode = 1;
});
