// ĞIGI GIVØ — GitHub datasets normaliser (historical / backfill only).
//
// Sources:
//   · football-catalogs       — CSV dumps of 1M+ matches
//   · schochastics/football-data — 1,237,935 matches across 207 leagues
//
// Fetch logic: download the CSV (a static URL, cacheable upstream) and parse it
// locally. Because these files are enormous, the normaliser is a pure,
// line-bounded parser (testable without the network) and the fetch attempts the
// configured URLs with a hard budget, failing soft.
//
// It maps goals and — when a dataset carries the columns — shots and corners,
// plus season averages for corners / cards for the two involved teams.

import type { SourceHandler } from "./context";
import { asNumberLoose, namesMatch, roundTo } from "./shared";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatField } from "../types";

export const GITHUB_CAPABILITIES: StatField[] = [
  "goals", "shots", "corners", "yellowCards", "redCards", "goalsConceded",
  "cleanSheet", "avgCornersPerGame", "avgCardsPerGame",
];

const DEFAULT_URLS = [
  // schochastics/football-data — consolidated matches.csv
  "https://raw.githubusercontent.com/schochastics/football-data/main/data/matches.csv",
];

/** Parse a CSV document into rows of string cells (quotes handled minimally). */
export function parseCsv(text: string, maxRows = 300_000): string[][] {
  const rows: string[][] = [];
  const lines = text.split(/\r?\n/);
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === "," || ch === ";") {
        row.push(field.trim());
        field = "";
      } else {
        field += ch;
      }
    }
    // End of physical line: if still in quotes, it's an embedded newline.
    if (!inQuotes) {
      row.push(field.trim());
      field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      if (rows.length >= maxRows) break;
    } else {
      field += "\n";
    }
  }
  return rows;
}

const COL_ALIASES: Record<string, string> = {
  // identity
  home: "home", hometeam: "home", home_team: "home", team1: "home", hometeamname: "home",
  away: "away", awayteam: "away", away_team: "away", team2: "away", awayteamname: "away",
  date: "date", matchdate: "date", match_date: "date", utcdate: "date", day: "date",
  league: "league", country: "league", comp: "league", competition: "league", division: "league",
  season: "season", seasonid: "season",
  // goals
  hg: "homeGoals", homegoals: "homeGoals", home_score: "homeGoals", home_goals: "homeGoals", fthg: "homeGoals",
  ag: "awayGoals", awaygoals: "awayGoals", away_score: "awayGoals", away_goals: "awayGoals", ftag: "awayGoals",
  // shots
  hs: "homeShots", homeshots: "homeShots", home_shots: "homeShots", shotshome: "homeShots",
  as: "awayShots", awayshots: "awayShots", away_shots: "awayShots", shotsaway: "awayShots",
  // corners
  hc: "homeCorners", homecorners: "homeCorners", home_corners: "homeCorners", cornershome: "homeCorners",
  ac: "awayCorners", awaycorners: "awayCorners", away_corners: "awayCorners", cornersaway: "awayCorners",
  // cards
  hy: "homeYellows", homeyellows: "homeYellows", home_yellows: "homeYellows", homeyellowcards: "homeYellows",
  ay: "awayYellows", awayyellows: "awayYellows", away_yellows: "awayYellows", awayyellowcards: "awayYellows",
  hr: "homeReds", homereds: "homeReds", home_reds: "homeReds", homeredcards: "homeReds",
  ar: "awayReds", awayreds: "awayReds", away_reds: "awayReds", awayredcards: "awayReds",
};

const normCol = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

interface CsvIndex {
  home: number;
  away: number;
  date: number;
  league: number;
  season: number;
  homeGoals: number;
  awayGoals: number;
  homeShots: number;
  awayShots: number;
  homeCorners: number;
  awayCorners: number;
  homeYellows: number;
  awayYellows: number;
  homeReds: number;
  awayReds: number;
}

const NO_INDEX = -1;

function buildIndex(header: string[]): CsvIndex {
  const idx: CsvIndex = {
    home: NO_INDEX, away: NO_INDEX, date: NO_INDEX, league: NO_INDEX, season: NO_INDEX,
    homeGoals: NO_INDEX, awayGoals: NO_INDEX, homeShots: NO_INDEX, awayShots: NO_INDEX,
    homeCorners: NO_INDEX, awayCorners: NO_INDEX, homeYellows: NO_INDEX, awayYellows: NO_INDEX,
    homeReds: NO_INDEX, awayReds: NO_INDEX,
  };
  header.forEach((cell, i) => {
    const alias = COL_ALIASES[normCol(cell)];
    if (alias && (idx as unknown as Record<string, number>)[alias] === NO_INDEX) {
      (idx as unknown as Record<string, number>)[alias] = i;
    }
  });
  return idx;
}

const cell = (row: string[], i: number): string | null =>
  i >= 0 && i < row.length ? row[i] : null;

interface CsvMatchRow {
  row: string[];
  homeGoals: number | null;
  awayGoals: number | null;
  homeShots: number | null;
  awayShots: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  homeYellows: number | null;
  awayYellows: number | null;
  homeReds: number | null;
  awayReds: number | null;
  season: string | null;
  league: string | null;
}

/**
 * Pure normaliser: find the match in a CSV document and map its goals / shots /
 * corners / cards, plus season averages for corners and cards.
 */
export function normaliseFootballCsv(csvText: string, match: MatchStatsQuery): SourcePayload {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { home: {}, away: {} };
  const idx = buildIndex(rows[0]);
  if (idx.home === NO_INDEX || idx.away === NO_INDEX) return { home: {}, away: {} };

  let matchRow: CsvMatchRow | null = null;

  // First pass: locate the exact match by team + date.
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const home = cell(row, idx.home);
    const away = cell(row, idx.away);
    if (!home || !away) continue;
    if (!namesMatch(home, match.homeTeam) || !namesMatch(away, match.awayTeam)) continue;
    const date = cell(row, idx.date);
    if (date && date.slice(0, 10) !== match.date.slice(0, 10)) continue;
    matchRow = {
      row,
      homeGoals: asNumberLoose(cell(row, idx.homeGoals)),
      awayGoals: asNumberLoose(cell(row, idx.awayGoals)),
      homeShots: asNumberLoose(cell(row, idx.homeShots)),
      awayShots: asNumberLoose(cell(row, idx.awayShots)),
      homeCorners: asNumberLoose(cell(row, idx.homeCorners)),
      awayCorners: asNumberLoose(cell(row, idx.awayCorners)),
      homeYellows: asNumberLoose(cell(row, idx.homeYellows)),
      awayYellows: asNumberLoose(cell(row, idx.awayYellows)),
      homeReds: asNumberLoose(cell(row, idx.homeReds)),
      awayReds: asNumberLoose(cell(row, idx.awayReds)),
      season: cell(row, idx.season),
      league: cell(row, idx.league),
    };
    break;
  }
  if (!matchRow) return { home: {}, away: {} };

  const home: PartialTeamStats = {};
  const away: PartialTeamStats = {};
  if (matchRow.homeGoals !== null && matchRow.awayGoals !== null) {
    home.goals = matchRow.homeGoals;
    away.goals = matchRow.awayGoals;
    home.goalsConceded = matchRow.awayGoals;
    away.goalsConceded = matchRow.homeGoals;
    home.cleanSheet = matchRow.awayGoals === 0;
    away.cleanSheet = matchRow.homeGoals === 0;
  }
  if (matchRow.homeShots !== null) home.shots = matchRow.homeShots;
  if (matchRow.awayShots !== null) away.shots = matchRow.awayShots;
  if (matchRow.homeCorners !== null) home.corners = matchRow.homeCorners;
  if (matchRow.awayCorners !== null) away.corners = matchRow.awayCorners;
  if (matchRow.homeYellows !== null) home.yellowCards = matchRow.homeYellows;
  if (matchRow.awayYellows !== null) away.yellowCards = matchRow.awayYellows;
  if (matchRow.homeReds !== null) home.redCards = matchRow.homeReds;
  if (matchRow.awayReds !== null) away.redCards = matchRow.awayReds;

  // Season averages for corners / cards (scoped to the same season/league).
  const sameScope = (row: string[]): boolean => {
    const season = cell(row, idx.season);
    const league = cell(row, idx.league);
    const sOk = idx.season === NO_INDEX || !matchRow?.season || season === matchRow.season;
    const lOk = idx.league === NO_INDEX || !matchRow?.league || league === matchRow.league;
    return sOk && lOk;
  };

  const avgFor = (team: string, homeColIdx: number, awayColIdx: number): number | null => {
    if (homeColIdx === NO_INDEX && awayColIdx === NO_INDEX) return null;
    let sum = 0;
    let count = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!sameScope(row)) continue;
      const homeName = cell(row, idx.home);
      const awayName = cell(row, idx.away);
      const isHome = homeName != null && namesMatch(homeName, team);
      const isAway = awayName != null && namesMatch(awayName, team);
      if (!isHome && !isAway) continue;
      const colIdx = isHome ? homeColIdx : awayColIdx;
      if (colIdx === NO_INDEX) continue;
      const v = asNumberLoose(cell(row, colIdx));
      if (v !== null) { sum += v; count++; }
    }
    return count > 0 ? roundTo(sum / count, 2) : null;
  };

  home.avgCornersPerGame = avgFor(match.homeTeam, idx.homeCorners, idx.awayCorners);
  away.avgCornersPerGame = avgFor(match.awayTeam, idx.homeCorners, idx.awayCorners);

  const homeCardsAvg = avgFor(match.homeTeam, idx.homeYellows, idx.awayYellows);
  const awayCardsAvg = avgFor(match.awayTeam, idx.homeYellows, idx.awayYellows);
  if (homeCardsAvg !== null) {
    home.avgCardsPerGame = homeCardsAvg + (avgFor(match.homeTeam, idx.homeReds, idx.awayReds) ?? 0);
  }
  if (awayCardsAvg !== null) {
    away.avgCardsPerGame = awayCardsAvg + (avgFor(match.awayTeam, idx.homeReds, idx.awayReds) ?? 0);
  }

  const hasAny =
    Object.values(home).some((v) => v !== null) ||
    Object.values(away).some((v) => v !== null);
  return hasAny ? { home, away } : { home: {}, away: {} };
}

export const githubDatasetsSource: SourceHandler = {
  name: "GitHubDatasets",
  capabilities: GITHUB_CAPABILITIES,

  available: () => true,

  async fetch(match, ctx): Promise<SourcePayload | null> {
    const urls = ctx.env("GITHUB_DATASET_URLS")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    const targets = urls.length ? urls : DEFAULT_URLS;
    let searchedAnyDataset = false;

    for (const url of targets) {
      const res = await ctx.http(url, {
        timeoutMs: Math.max(ctx.timeoutMs, 20_000),
        text: true,
      });
      if (res.status !== "ok" || typeof res.data !== "string") {
        // Distinguish "dataset unreachable" from "dataset searched, match
        // absent" — the former is an environment problem, the latter a
        // coverage gap.
        ctx.log(`[GitHubDatasets] Dataset fetch failed (${res.status}) for ${url} — skipping this dataset.`);
        continue;
      }
      searchedAnyDataset = true;
      // The CSV carries no ESPN ids — the match is located by its own format:
      // date + team names inside the dataset rows.
      const payload = normaliseFootballCsv(res.data, match);
      const hasAny =
        Object.values(payload.home).some((v) => v !== null) ||
        Object.values(payload.away).some((v) => v !== null);
      if (hasAny) return payload;
    }
    if (searchedAnyDataset) {
      ctx.log(`[GitHubDatasets] Match not found for ${match.date.slice(0, 10)} ${match.homeTeam} vs ${match.awayTeam}.`);
    }
    return null;
  },
};
