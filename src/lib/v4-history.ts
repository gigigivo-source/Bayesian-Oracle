import { parseHistoricalDate } from "./data/historical";
import { parseCsv } from "./data/sources/githubDatasets";
import type { FixtureLite, MatchSummary, TeamForm } from "./espn";
import { translateTeamName, type V2EngineContext } from "./v4-predictor";

export const EPL_RESULTS_CSV_API_URL = "https://api.github.com/repos/brysonhen/football_matchup_predictor/contents/data/raw/pl/E0_2627.csv";
export interface CompletedEplResult {
  home: string; away: string; homeGoals: number; awayGoals: number;
  isoDate: string | null;
}

const numberOrNull = (raw?: string): number | null => {
  if (!raw?.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

export function parseCompletedEplResults(csv: string): CompletedEplResult[] {
  const rows = parseCsv(csv.replace(/^\uFEFF/, ""));
  if (rows.length < 2) return [];
  const header = rows[0];
  const col = (name: string) => header.indexOf(name);
  const di = col("Div"), datei = col("Date"), timei = col("Time");
  const hi = col("HomeTeam"), ai = col("AwayTeam"), hgi = col("FTHG"), agi = col("FTAG");
  if (hi < 0 || ai < 0 || hgi < 0 || agi < 0) return [];
  const result: CompletedEplResult[] = [];
  for (const row of rows.slice(1)) {
    if (di >= 0 && row[di] && row[di] !== "E0") continue;
    const homeGoals = numberOrNull(row[hgi]);
    const awayGoals = numberOrNull(row[agi]);
    const home = translateTeamName(row[hi] ?? ""), away = translateTeamName(row[ai] ?? "");
    if (!home || !away || homeGoals === null || awayGoals === null ||
        !Number.isInteger(homeGoals) || !Number.isInteger(awayGoals)) continue;
    const day = datei >= 0 ? parseHistoricalDate(row[datei]) : null;
    const time = timei >= 0 && /^\d{2}:\d{2}$/.test(row[timei] ?? "") ? row[timei] : "15:00";
    result.push({ home, away, homeGoals, awayGoals,
      isoDate: day ? `${day.slice(0, 10)}T${time}:00Z` : null });
  }
  return result;
}

export function completedEplResultsByKey(rows: readonly CompletedEplResult[]) {
  return new Map(rows.map((row) => [`${row.home}|${row.away}`, row]));
}

export async function fetchCompletedEplResults(timeoutMs = 15_000): Promise<CompletedEplResult[] | null> {
  try {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const response = await fetch(EPL_RESULTS_CSV_API_URL, {
      headers: { Accept: "application/vnd.github.raw+json", "User-Agent": "Mozilla/5.0 (compatible; GigiGivo/1.0)", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const rows = parseCompletedEplResults(await response.text());
    return rows.length ? rows : null;
  } catch { return null; }
}

function teamForm(team: string, prior: readonly CompletedEplResult[]): TeamForm | null {
  const games = prior.flatMap((row) => {
    const atHome = row.home === team;
    if (!atHome && row.away !== team) return [];
    const scoreFor = atHome ? row.homeGoals : row.awayGoals;
    const scoreAgainst = atHome ? row.awayGoals : row.homeGoals;
    return [{ date: row.isoDate!, opponent: atHome ? row.away : row.home, opponentLogo: null,
      result: scoreFor > scoreAgainst ? "W" as const : scoreFor < scoreAgainst ? "L" as const : "D" as const,
      scoreFor, scoreAgainst, atVs: atHome ? "vs" as const : "@" as const, competition: "Premier League" }];
  }).slice(-5);
  if (!games.length) return null;
  return { teamId: "", teamName: team, games,
    gfAvg: games.reduce((s, g) => s + g.scoreFor, 0) / games.length,
    gaAvg: games.reduce((s, g) => s + g.scoreAgainst, 0) / games.length,
    points: games.reduce((s, g) => s + (g.result === "W" ? 3 : g.result === "D" ? 1 : 0), 0) };
}

/** Construct an as-of context: only results with kickoff strictly before this fixture. */
export function buildV2EngineContext(fixture: FixtureLite, history: readonly CompletedEplResult[]): V2EngineContext {
  const cutoff = Date.parse(fixture.date);
  const prior = Number.isFinite(cutoff) ? history.filter((r) => r.isoDate && Date.parse(r.isoDate) < cutoff)
    .sort((a, b) => Date.parse(a.isoDate!) - Date.parse(b.isoDate!)) : [];
  const home = translateTeamName(fixture.home.name), away = translateTeamName(fixture.away.name);
  const summary: MatchSummary = { odds: null, homeForm: teamForm(home, prior), awayForm: teamForm(away, prior),
    h2h: [], homeLineup: [], awayLineup: [], lineupAvailable: false, homeFormation: null, awayFormation: null, venue: null, boxscore: null };
  return { fixture: { ...fixture, state: "pre", statusDetail: "Scheduled", odds: null,
    home: { ...fixture.home, score: null, record: null, form: null }, away: { ...fixture.away, score: null, record: null, form: null } }, summary, stats: null };
}
