/**
 * V4 Predictor — The 70-Floor / 100+ Ceiling Tournament Backtest (MW1–MW10)
 *
 * Simulates all five candidate V4 scoreline-selection systems across the 100
 * completed 2026–27 English Premier League matches from Matchweek 1 through
 * Matchweek 10 under strict pre-kickoff temporal isolation (no closing-line
 * odds, no post-kickoff form or boxscore leakage):
 *
 *   · System A: The Kelly Criterion Maximizer
 *   · System B: The Goal-Bucket Specialist
 *   · System C: The Bayesian Prior Blend
 *   · System D: The Draw-First Value Hunter
 *   · System E: The Expected Points Champion (Weighted)
 *
 * Run with:
 *   npx tsx scripts/tournament.ts
 */

import { parseCsv } from "../src/lib/data/sources/githubDatasets";
import {
  makeMatchId,
  normaliseTeamName,
  teamsMatch,
  type HistoricalMatch,
} from "../src/lib/data/historical";
import {
  buildAttackDefenceTable,
  getTeamAttackDefence,
} from "../src/lib/data/attackDefence";
import { runEngineFromReal } from "../src/lib/engine/engine";
import {
  engineLambdas,
  get1X2,
  getCorrectScores,
} from "../src/app/api/v4-predictor/auto/route";
import {
  calculateScore,
  translateTeamName,
  type Actual,
  type Prediction,
} from "../src/lib/v4-predictor";
import {
  systemAKellyPick,
  systemBBucketPick,
  systemCBayesianBlendPick,
  systemDDrawFirstPick,
  systemEWeightedEpPick,
  type V4SystemPick,
} from "../src/lib/v4-tournament";
import type { FixtureLite, FormGame, MatchSummary, TeamForm } from "../src/lib/espn";
import type { StatDistribution, TeamStatProfile } from "../src/lib/engine/sofascore";

interface RichEplMatch {
  isoDate: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  season: string;
  hs?: number;
  as?: number;
  hst?: number;
  ast?: number;
  hc?: number;
  ac?: number;
  hf?: number;
  af?: number;
  hCards?: number;
  aCards?: number;
}

interface OpenFootballFixture {
  round: string;
  date: string;
  time?: string;
  team1: string;
  team2: string;
  score?: { ft?: [number, number] };
}

const CANONICAL_ALIASES: Record<string, string> = {
  "man united": "manchester united",
  "man utd": "manchester united",
  "manchester utd": "manchester united",
  "man city": "manchester city",
  spurs: "tottenham hotspur",
  tottenham: "tottenham hotspur",
  "nott m forest": "nottingham forest",
  "nottm forest": "nottingham forest",
  forest: "nottingham forest",
  wolves: "wolverhampton wanderers",
  wolverhampton: "wolverhampton wanderers",
  brighton: "brighton hove albion",
  "brighton and hove albion": "brighton hove albion",
  "west ham": "west ham united",
  newcastle: "newcastle united",
  leeds: "leeds united",
  leicester: "leicester city",
  ipswich: "ipswich town",
  coventry: "coventry city",
  hull: "hull city",
  "afc bournemouth": "bournemouth",
};

function canonTeam(raw: string): string {
  const s = normaliseTeamName(raw)
    .replace(/\b(?:fc|afc)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return CANONICAL_ALIASES[s] ?? s;
}

function sameClub(a: string, b: string): boolean {
  const ca = canonTeam(a);
  const cb = canonTeam(b);
  return ca !== "" && (ca === cb || teamsMatch(ca, cb));
}

function distribution(values: number[]): StatDistribution {
  if (values.length === 0) return { mean: 0, std: 0, n: 0 };
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance), n: values.length };
}

function parseUkDateTime(dateRaw: string, timeRaw: string): string {
  const [dd, mm, yyyy] = dateRaw.trim().split("/");
  const cleanTime =
    timeRaw && /^\d{1,2}:\d{2}/.test(timeRaw.trim()) ? timeRaw.trim() : "15:00";
  const [hh, min] = cleanTime.split(":");
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T${hh.padStart(2, "0")}:${min}:00Z`;
}

async function fetchGitHubRaw(repoContentPath: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${repoContentPath}`, {
    headers: {
      Accept: "application/vnd.github.raw+json",
      "User-Agent": "Bayesian-Oracle-V4-Tournament/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub fetch failed (${response.status}) for ${repoContentPath}`);
  }
  return response.text();
}

function parseSeasonCsv(csvText: string, season: string): RichEplMatch[] {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return [];
  const header = rows[0];
  const col = (name: string) => header.indexOf(name);

  return rows
    .slice(1)
    .map((row) => {
      const optNum = (name: string): number | undefined => {
        const idx = col(name);
        if (idx < 0 || row[idx] === "" || row[idx] === undefined) return undefined;
        const n = Number(row[idx]);
        return Number.isFinite(n) ? n : undefined;
      };
      const hy = optNum("HY");
      const hr = optNum("HR");
      const ay = optNum("AY");
      const ar = optNum("AR");
      return {
        isoDate: parseUkDateTime(
          row[col("Date")] ?? "",
          col("Time") >= 0 ? (row[col("Time")] ?? "15:00") : "15:00",
        ),
        homeTeam: canonTeam(row[col("HomeTeam")] ?? ""),
        awayTeam: canonTeam(row[col("AwayTeam")] ?? ""),
        homeGoals: Number(row[col("FTHG")]),
        awayGoals: Number(row[col("FTAG")]),
        season,
        hs: optNum("HS"),
        as: optNum("AS"),
        hst: optNum("HST"),
        ast: optNum("AST"),
        hc: optNum("HC"),
        ac: optNum("AC"),
        hf: optNum("HF"),
        af: optNum("AF"),
        hCards: hy !== undefined ? hy + (hr ?? 0) : undefined,
        aCards: ay !== undefined ? ay + (ar ?? 0) : undefined,
      };
    })
    .filter((m) => Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals));
}

function buildPreMatchForm(
  allMatches: RichEplMatch[],
  team: string,
  cutoffMs: number,
): TeamForm | null {
  const prior = allMatches
    .filter(
      (m) =>
        Date.parse(m.isoDate) < cutoffMs &&
        (sameClub(m.homeTeam, team) || sameClub(m.awayTeam, team)),
    )
    .slice(-5);
  if (prior.length === 0) return null;

  const games: FormGame[] = prior.map((m) => {
    const isHome = sameClub(m.homeTeam, team);
    const scoreFor = isHome ? m.homeGoals : m.awayGoals;
    const scoreAgainst = isHome ? m.awayGoals : m.homeGoals;
    return {
      date: m.isoDate,
      opponent: isHome ? m.awayTeam : m.homeTeam,
      opponentLogo: null,
      result: scoreFor > scoreAgainst ? "W" : scoreFor < scoreAgainst ? "L" : "D",
      scoreFor,
      scoreAgainst,
      atVs: isHome ? "vs" : "@",
      competition: "Premier League",
    };
  });

  const gfAvg = games.reduce((s, g) => s + g.scoreFor, 0) / games.length;
  const gaAvg = games.reduce((s, g) => s + g.scoreAgainst, 0) / games.length;
  const points = games.reduce(
    (s, g) => s + (g.result === "W" ? 3 : g.result === "D" ? 1 : 0),
    0,
  );
  return {
    teamId: canonTeam(team),
    teamName: team,
    games,
    gfAvg,
    gaAvg,
    points,
  };
}

function buildPreMatchProfile(
  allMatches: RichEplMatch[],
  team: string,
  cutoffMs: number,
): TeamStatProfile | null {
  const prior = allMatches
    .filter(
      (m) =>
        Date.parse(m.isoDate) < cutoffMs &&
        m.hs !== undefined &&
        (sameClub(m.homeTeam, team) || sameClub(m.awayTeam, team)),
    )
    .slice(-20);
  if (prior.length === 0) return null;

  const shots: number[] = [];
  const sot: number[] = [];
  const corners: number[] = [];
  const cards: number[] = [];
  const fouls: number[] = [];
  const saves: number[] = [];

  for (const m of prior) {
    const isHome = sameClub(m.homeTeam, team);
    const myShots = (isHome ? m.hs : m.as) ?? 0;
    const mySot = (isHome ? m.hst : m.ast) ?? 0;
    const oppSot = (isHome ? m.ast : m.hst) ?? 0;
    const oppGoals = isHome ? m.awayGoals : m.homeGoals;
    shots.push(myShots);
    sot.push(mySot);
    corners.push((isHome ? m.hc : m.ac) ?? 0);
    cards.push((isHome ? m.hCards : m.aCards) ?? 0);
    fouls.push((isHome ? m.hf : m.af) ?? 0);
    saves.push(Math.max(0, oppSot - oppGoals));
  }

  const zero: StatDistribution = { mean: 0, std: 0, n: 0 };
  return {
    teamId: canonTeam(team),
    samples: prior.length,
    shots: distribution(shots),
    sot: distribution(sot),
    corners: distribution(corners),
    cards: distribution(cards),
    fouls: distribution(fouls),
    saves: distribution(saves),
    offsides: zero,
    possession: zero,
    passes: zero,
    passAccuracy: zero,
    crosses: zero,
    longBalls: zero,
    tackles: zero,
    clearances: zero,
    interceptions: zero,
    blockedShots: zero,
  };
}

const SYSTEM_META = [
  { id: "A", name: "System A: Kelly Criterion Maximizer" },
  { id: "B", name: "System B: Goal-Bucket Specialist" },
  { id: "C", name: "System C: Bayesian Prior Blend" },
  { id: "D", name: "System D: Draw-First Value Hunter" },
  { id: "E", name: "System E: Expected Points Champion (Weighted)" },
] as const;

type SystemId = (typeof SYSTEM_META)[number]["id"];

async function runTournament(): Promise<void> {
  const [csv2425, csv2526, csv2627, champ2526Raw, openFootballRaw] =
    await Promise.all([
      fetchGitHubRaw(
        "ezekiel27egoun/football-predictor/contents/data/raw/premier_league/premier_league_2024-2025.csv",
      ),
      fetchGitHubRaw(
        "ezekiel27egoun/football-predictor/contents/data/raw/premier_league/premier_league_2025-2026.csv",
      ),
      fetchGitHubRaw(
        "ezekiel27egoun/football-predictor/contents/data/raw/premier_league/premier_league_2026-2027.csv",
      ),
      fetchGitHubRaw("openfootball/football.json/contents/2025-26/en.2.json"),
      fetchGitHubRaw("openfootball/football.json/contents/2026-27/en.1.json"),
    ]);

  const m2425 = parseSeasonCsv(csv2425, "2024-25");
  const m2526 = parseSeasonCsv(csv2526, "2025-26");
  const m2627 = parseSeasonCsv(csv2627, "2026-27");
  const champJson = JSON.parse(champ2526Raw) as { matches: OpenFootballFixture[] };
  const mChamp2526: RichEplMatch[] = champJson.matches
    .filter((m) => Array.isArray(m.score?.ft) && m.score!.ft!.length === 2)
    .map((m) => ({
      isoDate: `${m.date}T${m.time && /^\d{2}:\d{2}/.test(m.time) ? m.time : "15:00"}:00Z`,
      homeTeam: canonTeam(m.team1),
      awayTeam: canonTeam(m.team2),
      homeGoals: m.score!.ft![0],
      awayGoals: m.score!.ft![1],
      season: "2025-26-champ",
    }));

  const allEpl = [...m2425, ...m2526, ...m2627].sort(
    (a, b) => Date.parse(a.isoDate) - Date.parse(b.isoDate),
  );
  const allFormMatches = [...m2425, ...m2526, ...mChamp2526, ...m2627].sort(
    (a, b) => Date.parse(a.isoDate) - Date.parse(b.isoDate),
  );
  const schedule = JSON.parse(openFootballRaw) as { matches: OpenFootballFixture[] };

  // Build System C's Bayesian prior strictly from completed prior EPL seasons
  // (2024–25 and 2025–26, before the 2026–27 season kicked off on 2026-08-21).
  const priorHistory: HistoricalMatch[] = [...m2425, ...m2526].map((m) => ({
    id: makeMatchId("eng.1", m.homeTeam, m.awayTeam, m.isoDate),
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    leagueSlug: "eng.1",
    matchDate: m.isoDate,
    homeGoals: m.homeGoals,
    awayGoals: m.awayGoals,
    competitionName: "Premier League",
    source: "openfootball",
  }));
  const priorTable = buildAttackDefenceTable(priorHistory, "eng.1", {
    halfLifeDays: 300,
    now: new Date("2026-08-15T00:00:00Z"),
  });

  const weeklyScores: Record<SystemId, number[]> = {
    A: [],
    B: [],
    C: [],
    D: [],
    E: [],
  };
  const exactCounts: Record<SystemId, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const outcomeCounts: Record<SystemId, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };

  // Silence internal engine diagnostic logs while pricing 100 fixtures.
  const print = console.log.bind(console);
  console.log = () => {};

  try {
    for (let mw = 1; mw <= 10; mw++) {
      const roundFixtures = schedule.matches.filter(
        (m) => m.round === `Matchday ${mw}`,
      );
      if (roundFixtures.length !== 10) {
        throw new Error(
          `Expected 10 fixtures in Matchday ${mw}, found ${roundFixtures.length}`,
        );
      }

      const predictionsBySystem: Record<SystemId, Prediction[]> = {
        A: [],
        B: [],
        C: [],
        D: [],
        E: [],
      };
      const actuals: Actual[] = [];

      for (const rf of roundFixtures) {
        const completed = m2627.find(
          (m) => sameClub(m.homeTeam, rf.team1) && sameClub(m.awayTeam, rf.team2),
        );
        if (!completed) {
          throw new Error(
            `Missing completed MW${mw} result for ${rf.team1} vs ${rf.team2}`,
          );
        }

        const cutoffMs = Date.parse(completed.isoDate);
        const homeForm = buildPreMatchForm(allFormMatches, rf.team1, cutoffMs);
        const awayForm = buildPreMatchForm(allFormMatches, rf.team2, cutoffMs);
        const homeEplForm = buildPreMatchForm(allEpl, rf.team1, cutoffMs);
        const awayEplForm = buildPreMatchForm(allEpl, rf.team2, cutoffMs);
        const homeProfile = buildPreMatchProfile(allEpl, rf.team1, cutoffMs);
        const awayProfile = buildPreMatchProfile(allEpl, rf.team2, cutoffMs);
        const h2h = allEpl
          .filter(
            (m) =>
              Date.parse(m.isoDate) < cutoffMs &&
              ((sameClub(m.homeTeam, rf.team1) && sameClub(m.awayTeam, rf.team2)) ||
                (sameClub(m.homeTeam, rf.team2) && sameClub(m.awayTeam, rf.team1))),
          )
          .slice(-6)
          .map((m) => ({
            date: m.isoDate,
            home: m.homeTeam,
            away: m.awayTeam,
            score: `${m.homeGoals} - ${m.awayGoals}`,
            winner:
              m.homeGoals > m.awayGoals
                ? m.homeTeam
                : m.awayGoals > m.homeGoals
                  ? m.awayTeam
                  : "Draw",
          }));

        const fixture: FixtureLite = {
          id: `2026-27-mw${mw}-${canonTeam(rf.team1)}-${canonTeam(rf.team2)}`,
          leagueSlug: "eng.1",
          leagueName: "Premier League",
          date: completed.isoDate,
          state: "pre",
          statusDetail: "",
          venue: null,
          neutralSite: false,
          odds: null,
          home: {
            id: canonTeam(rf.team1),
            name: rf.team1,
            shortName: translateTeamName(rf.team1),
            abbrev: translateTeamName(rf.team1).slice(0, 3).toUpperCase(),
            logo: null,
            color: null,
            score: null,
            homeAway: "home",
          },
          away: {
            id: canonTeam(rf.team2),
            name: rf.team2,
            shortName: translateTeamName(rf.team2),
            abbrev: translateTeamName(rf.team2).slice(0, 3).toUpperCase(),
            logo: null,
            color: null,
            score: null,
            homeAway: "away",
          },
        };

        const summary: MatchSummary = {
          venue: null,
          homeForm,
          awayForm,
          h2h,
          odds: null,
          homeLineup: [],
          awayLineup: [],
          lineupAvailable: false,
          homeFormation: null,
          awayFormation: null,
          boxscore: null,
        };

        const engineOut = runEngineFromReal(fixture, summary, {
          home: homeProfile,
          away: awayProfile,
        });
        const fallback = engineLambdas(engineOut) ?? {
          homeGoals: 1.35,
          awayGoals: 1.15,
        };
        const probs = get1X2(engineOut, fallback);
        const scores = getCorrectScores(engineOut, fallback);

        const matchLabel = `${translateTeamName(rf.team1)} vs ${translateTeamName(rf.team2)}`;
        const picks: Record<SystemId, V4SystemPick> = {
          A: systemAKellyPick({ probs, scores }),
          B: systemBBucketPick({ probs, scores }),
          C: systemCBayesianBlendPick({
            homePrior: getTeamAttackDefence(priorTable, canonTeam(rf.team1)),
            awayPrior: getTeamAttackDefence(priorTable, canonTeam(rf.team2)),
            leagueAvgHomeGoals: priorTable.league.leagueAverageHome,
            leagueAvgAwayGoals: priorTable.league.leagueAverageAway,
            homeLast5: homeEplForm,
            awayLast5: awayEplForm,
          }),
          D: systemDDrawFirstPick({ probs, scores }),
          E: systemEWeightedEpPick({ probs, scores }),
        };

        for (const sys of SYSTEM_META) {
          const p = picks[sys.id];
          predictionsBySystem[sys.id].push({
            Match: matchLabel,
            Category: p.category,
            Prediction: p.prediction,
            Target_Pts: Math.round(p.ep),
          });
        }

        actuals.push([completed.homeGoals, completed.awayGoals]);
      }

      for (const sys of SYSTEM_META) {
        const [scored, total] = calculateScore(predictionsBySystem[sys.id], actuals);
        weeklyScores[sys.id].push(total);
        for (const item of scored) {
          if (item.Points === 20) {
            exactCounts[sys.id]++;
            outcomeCounts[sys.id]++;
          } else if (item.Points === 10) {
            outcomeCounts[sys.id]++;
          }
        }
      }
    }
  } finally {
    console.log = print;
  }

  print("# V4 Predictor Tournament Backtest (2026–27 EPL MW1–MW10)\n");
  print(
    "| System | MW1 | MW2 | MW3 | MW4 | MW5 | MW6 | MW7 | MW8 | MW9 | MW10 | Average Score | Floor (Lowest Week) | 100+ Weeks |",
  );
  print(
    "| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |",
  );

  for (const sys of SYSTEM_META) {
    const scores = weeklyScores[sys.id];
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const floor = Math.min(...scores);
    const weeks100Plus = scores.filter((s) => s >= 100).length;
    const cells = scores.map((s) => String(s)).join(" | ");
    print(
      `| ${sys.name} | ${cells} | **${avg.toFixed(1)}** | **${floor}** | **${weeks100Plus}** |`,
    );
  }

  print("\n## Accuracy Breakdown (100 Matches)\n");
  print("| System | Total Points | Right Outcomes (incl. Exacts) | Exact Scorelines (20 pts) |");
  print("| :--- | :---: | :---: | :---: |");
  for (const sys of SYSTEM_META) {
    const total = weeklyScores[sys.id].reduce((a, b) => a + b, 0);
    print(
      `| ${sys.name} | ${total} | ${outcomeCounts[sys.id]}/100 | ${exactCounts[sys.id]}/100 |`,
    );
  }
}

runTournament().catch((err) => {
  console.error("Tournament backtest failed:", err);
  process.exit(1);
});
