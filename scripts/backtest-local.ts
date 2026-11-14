#!/usr/bin/env node
/**
 * ĞIGI GIVØ — V4 Predictor: LOCAL, REAL-DATA backtest (True V2 Strict 3-Snipe System).
 * ------------------------------------------------------------------------------------
 * Run with:
 *
 *     npx tsx scripts/backtest-local.ts
 *
 * What it does, for every fixture in Matchweeks 1–10 of the current season:
 *
 *   1. Fetch the matchweek slate with `fetchScoreboard` (backfilling completed
 *      `openfootball:` fixtures from the real 2026-27 Football-Data EPL CSV on
 *      GitHub when `site.api.espn.com` is blocked).
 *   2. Sort fixtures chronologically and pass them directly into
 *      `generateV2Predictions(fixtures)` — Snipes stay pure rules; the three
 *      V2 lock fixes (Chaos gate, Top 4 derby, Standard blowouts) consult the
 *      Engine's offline Maher xG (`computeMatchExpectedGoals` + season
 *      snapshot), deviating from the legacy pick only when the margin is
 *      strongly supported (xG gap >= 0.4).
 *   3. Score the V2 predictions against the real final scores with
 *      `calculateScore` (20 exact / 10 outcome / 0 miss).
 *   4. Print a clean Markdown table: MW1 … MW10 + Average + Floor.
 */

import dns from "node:dns";
import tls from "node:tls";
import * as espn from "../src/lib/espn";
import { parseHistoricalDate } from "../src/lib/data/historical";
import { parseCsv } from "../src/lib/data/sources/githubDatasets";
import {
  calculateScore,
  generateV2Predictions,
  translateTeamName,
  type Actual,
  type Prediction,
} from "../src/lib/v4-predictor";

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

const PTS_EXACT = 20;
const PTS_OUTCOME = 10;
const PTS_MISS = 0;
const DEFAULT_WEEKS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const DEFAULT_LEAGUE = "eng.1";
const RESULTS_CSV_API_URL =
  "https://api.github.com/repos/brysonhen/football_matchup_predictor/contents/data/raw/pl/E0_2627.csv";

interface Config {
  league: string;
  season: number;
  weeks: number[];
  detail: boolean;
  help: boolean;
  selfTest: boolean;
}

interface CompletedMatchResult {
  homeGoals: number;
  awayGoals: number;
  isoDate: string | null;
}

interface FixtureOutcome {
  week: number;
  match: string;
  kickoff: string;
  category: string;
  prediction: string;
  targetPts: number;
  actual: string | null;
  points: number;
  status: "exact" | "outcome" | "miss" | "skipped";
  note: string;
}

interface WeekResult {
  week: number;
  fixtures: FixtureOutcome[];
  snipes: number;
  points: number;
  scored: number;
  exact: number;
  outcomeHits: number;
  misses: number;
  note: string | null;
}

let cachedResults: Map<string, CompletedMatchResult> | null | undefined;

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** European season window: 1 July of the season start year → 30 June the next. */
function inSeason(iso: string, seasonStartYear: number): boolean {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return false;
  const start = Date.UTC(seasonStartYear, 6, 1);
  const end = Date.UTC(seasonStartYear + 1, 6, 1);
  return time >= start && time < end;
}

function seasonLabel(seasonStartYear: number): string {
  return `${seasonStartYear}-${String((seasonStartYear + 1) % 100).padStart(2, "0")}`;
}

async function loadCompletedEplResults(): Promise<Map<string, CompletedMatchResult> | null> {
  if (cachedResults !== undefined) return cachedResults;
  try {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const response = await fetch(RESULTS_CSV_API_URL, {
      headers: {
        Accept: "application/vnd.github.raw+json",
        "User-Agent": "Mozilla/5.0 (compatible; GigiGivo/1.0)",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      cachedResults = null;
      return null;
    }
    const rows = parseCsv((await response.text()).replace(/^\uFEFF/, ""));
    if (rows.length < 2) {
      cachedResults = null;
      return null;
    }
    const header = rows[0];
    const divIdx = header.indexOf("Div");
    const dateIdx = header.indexOf("Date");
    const timeIdx = header.indexOf("Time");
    const homeIdx = header.indexOf("HomeTeam");
    const awayIdx = header.indexOf("AwayTeam");
    const fthgIdx = header.indexOf("FTHG");
    const ftagIdx = header.indexOf("FTAG");
    if (homeIdx < 0 || awayIdx < 0 || fthgIdx < 0 || ftagIdx < 0) {
      cachedResults = null;
      return null;
    }

    const map = new Map<string, CompletedMatchResult>();
    for (const row of rows.slice(1)) {
      if (divIdx >= 0 && row[divIdx] && row[divIdx] !== "E0") continue;
      const home = translateTeamName(row[homeIdx] ?? "");
      const away = translateTeamName(row[awayIdx] ?? "");
      const homeGoals = Number(row[fthgIdx]);
      const awayGoals = Number(row[ftagIdx]);
      if (
        !home ||
        !away ||
        row[fthgIdx] === "" ||
        row[ftagIdx] === "" ||
        !Number.isInteger(homeGoals) ||
        !Number.isInteger(awayGoals) ||
        homeGoals < 0 ||
        awayGoals < 0
      ) {
        continue;
      }
      const dayIso = dateIdx >= 0 ? parseHistoricalDate(row[dateIdx]) : null;
      const rawTime = timeIdx >= 0 ? (row[timeIdx] ?? "").trim() : "";
      const hhmm = /^\d{2}:\d{2}$/.test(rawTime) ? rawTime : "15:00";
      const isoDate = dayIso ? `${dayIso.slice(0, 10)}T${hhmm}:00Z` : null;
      map.set(`${home}|${away}`, { homeGoals, awayGoals, isoDate });
    }
    cachedResults = map;
    return map;
  } catch {
    cachedResults = null;
    return null;
  }
}

async function backfillOpenfootballResults(
  fixtures: espn.FixtureLite[],
): Promise<espn.FixtureLite[]> {
  const now = Date.now();
  const needsBackfill = fixtures.some(
    (fx) =>
      fx.id.startsWith("openfootball:") &&
      fx.state !== "post" &&
      Date.parse(fx.date) < now,
  );
  if (!needsBackfill) return fixtures;

  const results = await loadCompletedEplResults();
  if (!results) return fixtures;

  return fixtures.map((fx) => {
    if (!fx.id.startsWith("openfootball:") || fx.state === "post") return fx;
    const key = `${translateTeamName(fx.home.name)}|${translateTeamName(fx.away.name)}`;
    const settled = results.get(key);
    if (!settled) return fx;
    return {
      ...fx,
      date: settled.isoDate ?? fx.date,
      state: "post",
      statusDetail: "FT",
      home: { ...fx.home, score: String(settled.homeGoals) },
      away: { ...fx.away, score: String(settled.awayGoals) },
    };
  });
}

function emptyWeek(week: number, note: string): WeekResult {
  return {
    week,
    fixtures: [],
    snipes: 0,
    points: 0,
    scored: 0,
    exact: 0,
    outcomeHits: 0,
    misses: 0,
    note,
  };
}

async function backtestWeek(week: number, cfg: Config): Promise<WeekResult> {
  log(`\n── Matchweek ${week} ──────────────────────────────────────────────`);

  let raw: espn.FixtureLite[];
  try {
    raw = await espn.fetchScoreboard(cfg.league, undefined, week);
  } catch (error) {
    log(`   Fixture fetch failed: ${errorMessage(error)}`);
    return emptyWeek(week, `Fixture fetch failed: ${errorMessage(error)}`);
  }

  const hasMatchweeks = raw.some((f) => typeof f.matchweek === "number");
  const filteredWeek = hasMatchweeks ? raw.filter((f) => f.matchweek === week) : raw;
  const deduped = [...new Map(filteredWeek.map((fx) => [fx.id, fx])).values()];
  const seasonal = deduped.filter((fx) => inSeason(fx.date, cfg.season));
  const enriched =
    cfg.league === "eng.1" && cfg.season === 2026
      ? await backfillOpenfootballResults(seasonal)
      : seasonal;

  if (enriched.length === 0) {
    log(`   No ${seasonLabel(cfg.season)} fixtures returned for MW${week}.`);
    return emptyWeek(week, `No ${seasonLabel(cfg.season)} fixtures returned`);
  }

  const sorted = [...enriched].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  const v2Inputs = sorted.map((fx) => ({
    home: translateTeamName(fx.home.name),
    away: translateTeamName(fx.away.name),
  }));
  const predictions = generateV2Predictions(v2Inputs);
  const snipes = predictions.filter((p) => p.Category.startsWith("SNIPE:")).length;

  const finishedIndices: number[] = [];
  const finishedPredictions: Prediction[] = [];
  const finishedActuals: Actual[] = [];

  sorted.forEach((fx, idx) => {
    const homeScore = fx.home.score === null || fx.home.score === "" ? NaN : Number(fx.home.score);
    const awayScore = fx.away.score === null || fx.away.score === "" ? NaN : Number(fx.away.score);
    if (
      fx.state === "post" &&
      Number.isFinite(homeScore) &&
      Number.isFinite(awayScore) &&
      homeScore >= 0 &&
      awayScore >= 0
    ) {
      finishedIndices.push(idx);
      finishedPredictions.push(predictions[idx]);
      finishedActuals.push([homeScore, awayScore]);
    }
  });

  const [scoredRows] = calculateScore(finishedPredictions, finishedActuals);
  const scoredByIndex = new Map<number, (typeof scoredRows)[number]>();
  finishedIndices.forEach((origIdx, scoredIdx) => {
    scoredByIndex.set(origIdx, scoredRows[scoredIdx]);
  });

  const outcomes: FixtureOutcome[] = sorted.map((fx, idx) => {
    const pred = predictions[idx];
    const scored = scoredByIndex.get(idx);
    if (!scored) {
      log(
        `   [${idx + 1}/${sorted.length}] ${pred.Match} :: ${pred.Category} → ${pred.Prediction} vs — → SKIP (state=${fx.state})`,
      );
      return {
        week,
        match: pred.Match,
        kickoff: fx.date,
        category: pred.Category,
        prediction: pred.Prediction,
        targetPts: pred.Target_Pts,
        actual: null,
        points: PTS_MISS,
        status: "skipped",
        note: `fixture not finished (state=${fx.state})`,
      };
    }

    const status: FixtureOutcome["status"] =
      scored.Points === PTS_EXACT
        ? "exact"
        : scored.Points === PTS_OUTCOME
          ? "outcome"
          : "miss";
    log(
      `   [${idx + 1}/${sorted.length}] ${pred.Match} :: ${pred.Category} → ${pred.Prediction} vs actual ${scored.Actual} → ${scored.Points} pts`,
    );
    return {
      week,
      match: pred.Match,
      kickoff: fx.date,
      category: pred.Category,
      prediction: pred.Prediction,
      targetPts: pred.Target_Pts,
      actual: scored.Actual,
      points: scored.Points,
      status,
      note: scored.Status,
    };
  });

  const scoredOutcomes = outcomes.filter((o) => o.status !== "skipped");
  return {
    week,
    fixtures: outcomes,
    snipes,
    points: scoredOutcomes.reduce((sum, o) => sum + o.points, 0),
    scored: scoredOutcomes.length,
    exact: scoredOutcomes.filter((o) => o.status === "exact").length,
    outcomeHits: scoredOutcomes.filter((o) => o.status === "outcome").length,
    misses: scoredOutcomes.filter((o) => o.status === "miss").length,
    note: scoredOutcomes.length === 0 ? "no finished fixture could be scored" : null,
  };
}

function gameCount(week: WeekResult): string {
  return week.scored > 0 ? String(week.scored) : "—";
}

function renderMarkdown(weeks: WeekResult[], cfg: Config, leagueName: string): string {
  const lines: string[] = [];
  const scoredWeeks = weeks.filter((week) => week.scored > 0);
  const maxFixtures = weeks.reduce((max, week) => Math.max(max, week.scored), 0);
  const maxPoints = PTS_EXACT * maxFixtures;

  const average =
    scoredWeeks.length > 0
      ? scoredWeeks.reduce((sum, week) => sum + week.points, 0) / scoredWeeks.length
      : null;
  const floor =
    scoredWeeks.length > 0
      ? scoredWeeks.reduce((min, week) => Math.min(min, week.points), Number.POSITIVE_INFINITY)
      : null;

  lines.push(
    `## V4 Predictor — V2 Strict 3-Snipe Backtest (MW${weeks[0]?.week ?? 1}–MW${weeks[weeks.length - 1]?.week ?? 10})`,
    "",
  );
  lines.push(`- **League:** ${leagueName} (\`${cfg.league}\`)`);
  lines.push(`- **Season:** ${seasonLabel(cfg.season)}`);
  lines.push(`- **System:** True V2 Strict 3-Snipe System (Snipes = pure rules · Locks = Engine-xG-gated V2 fixes)`);
  lines.push(`- **Scoring:** exact = ${PTS_EXACT} · correct outcome = ${PTS_OUTCOME} · miss = ${PTS_MISS}`);
  lines.push("");

  const header = [
    "| Matchweek",
    ...weeks.map((week) => `MW${week.week}`),
    "**Average**",
    "**Floor**",
  ];
  const divider = ["| ---", ...weeks.map(() => "---:"), "---:", "---:"];
  const pointsRow = [
    `| **Points${maxPoints > 0 ? ` (max ${maxPoints})` : ""}**`,
    ...weeks.map((week) => (week.scored > 0 ? String(week.points) : "—")),
    `**${average === null ? "—" : average.toFixed(1)}**`,
    `**${floor === null ? "—" : floor}**`,
  ];
  const fixtureRow = [
    "| Fixtures scored",
    ...weeks.map((week) => gameCount(week)),
    average === null
      ? "—"
      : (
          scoredWeeks.reduce((sum, week) => sum + week.scored, 0) /
          scoredWeeks.length
        ).toFixed(1),
    scoredWeeks.length > 0
      ? String(
          scoredWeeks.reduce(
            (min, week) => Math.min(min, week.scored),
            Number.POSITIVE_INFINITY,
          ),
        )
      : "—",
  ];

  lines.push(header.join(" | ") + " |");
  lines.push(divider.join(" | ") + " |");
  lines.push(pointsRow.join(" | ") + " |");
  lines.push(fixtureRow.join(" | ") + " |");
  lines.push("");
  lines.push(`_Average = mean of the scored matchweeks · Floor = lowest matchweek score._`);
  lines.push("");

  lines.push(
    "| Matchweek | Fixtures scored | Snipes | Exact (20) | Outcome (10) | Miss (0) | Points |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const week of weeks) {
    lines.push(
      `| MW${week.week} | ${gameCount(week)} | ${week.scored > 0 ? week.snipes : "—"} | ` +
        `${week.scored > 0 ? week.exact : "—"} | ${week.scored > 0 ? week.outcomeHits : "—"} | ` +
        `${week.scored > 0 ? week.misses : "—"} | ${week.scored > 0 ? week.points : "—"} |`,
    );
  }
  const totalScored = weeks.reduce((sum, week) => sum + week.scored, 0);
  const totalSnipes = weeks.reduce((sum, week) => sum + week.snipes, 0);
  const totalPoints = weeks.reduce((sum, week) => sum + week.points, 0);
  lines.push(
    `| **Total** | **${totalScored}** | **${totalSnipes}** | **${weeks.reduce((sum, week) => sum + week.exact, 0)}** | ` +
      `**${weeks.reduce((sum, week) => sum + week.outcomeHits, 0)}** | ` +
      `**${weeks.reduce((sum, week) => sum + week.misses, 0)}** | **${totalPoints}** |`,
  );
  lines.push("");

  const notes = weeks.filter((week) => week.note !== null);
  if (notes.length > 0) {
    lines.push("**Warnings**");
    for (const week of notes) lines.push(`- MW${week.week}: ${week.note}`);
    lines.push("");
  }

  if (cfg.detail) {
    lines.push("### Fixture detail", "");
    lines.push("| MW | Match | Kickoff (UTC) | Category | Pick | Actual | Pts |");
    lines.push("| ---: | --- | --- | --- | ---: | ---: | ---: |");
    for (const week of weeks) {
      for (const fixture of week.fixtures) {
        lines.push(
          `| ${week.week} | ${fixture.match} | ${fixture.kickoff.slice(0, 16).replace("T", " ")} | ` +
            `${fixture.category} | ${fixture.prediction} | ${fixture.actual ?? "—"} | ` +
            `${fixture.status === "skipped" ? "—" : fixture.points} |`,
        );
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function runSelfTest(): void {
  const slate: Array<[string, string]> = [
    ["Crystal Palace", "Liverpool"], // Elite Away candidate (only if <2 deadlocks)
    ["Arsenal", "Coventry"],         // Snipe 1: Home Fortress -> 2-0
    ["Fulham", "Brentford"],         // Snipe 2: Mid-Table Deadlock -> 1-1
    ["Everton", "Leeds"],            // Snipe 3: Mid-Table Deadlock -> 1-1
    ["Chelsea", "Ipswich"],          // Chaos banned from Snipes; xG gap >= 0.4 -> 2-1 (NEVER 2-2)
    ["Man City", "Newcastle"],       // Smart Top 4 Home -> 2-0
    ["Aston Villa", "Hull"],         // Mid vs Bottom -> 2-1
    ["Sunderland", "Fulham"],        // Standard Default (Away stronger) -> 0-1
    ["Bournemouth", "Nott'm Forest"],// Standard Default (Home) -> 1-0
    ["Spurs", "Brighton"],           // Chaos vs Top 4 Away -> 1-2
  ];

  const preds = generateV2Predictions(slate);
  const expected: Array<[string, string, number]> = [
    ["LOCK: Standard Away", "0-1", 10],
    ["SNIPE: Home Fortress", "2-0", 20],
    ["SNIPE: Mid-Table Deadlock", "1-1", 20],
    ["SNIPE: Mid-Table Deadlock", "1-1", 20],
    ["LOCK: Chaos Rule", "2-1", 10],
    ["LOCK: Smart Top 4 Home", "2-0", 10],
    ["LOCK: Mid vs Bottom", "2-1", 10],
    ["LOCK: Standard Away", "0-1", 10],
    ["LOCK: Standard Home", "1-0", 10],
    ["LOCK: Chaos Rule", "1-2", 10],
  ];

  let failures = 0;
  preds.forEach((p, idx) => {
    const [cat, score, target] = expected[idx];
    const ok = p.Category === cat && p.Prediction === score && p.Target_Pts === target;
    if (!ok) failures += 1;
    log(`${ok ? "PASS" : "FAIL"}  ${p.Match} → ${p.Category} (${p.Prediction}, ${p.Target_Pts} pts)`);
  });

  if (failures > 0) {
    log(`\n${failures} self-test(s) failed.`);
    process.exitCode = 1;
    return;
  }
  log(`\nAll ${preds.length} V2 Strict 3-Snipe self-tests passed.`);
}

function currentSeasonYear(now = new Date()): number {
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

function parseWeeks(raw: string): number[] | null {
  const weeks = new Set<number>();
  for (const chunk of raw.split(",")) {
    const part = chunk.trim();
    if (part === "") continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to) return null;
      for (let week = from; week <= to; week += 1) weeks.add(week);
      continue;
    }
    if (!/^\d+$/.test(part)) return null;
    weeks.add(Number(part));
  }
  if (weeks.size === 0) return null;
  return [...weeks].sort((a, b) => a - b);
}

function parseArgs(argv: readonly string[]): Config {
  const cfg: Config = {
    league: DEFAULT_LEAGUE,
    season: currentSeasonYear(),
    weeks: [...DEFAULT_WEEKS],
    detail: false,
    help: false,
    selfTest: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [flag, inlineValue] = token.includes("=")
      ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
      : [token, undefined];

    const value = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case "--help":
      case "-h":
        cfg.help = true;
        break;
      case "--self-test":
        cfg.selfTest = true;
        break;
      case "--detail":
        cfg.detail = true;
        break;
      case "--league": {
        const slug = value().trim();
        if (!/^[a-z0-9._-]+$/i.test(slug)) throw new Error(`invalid league slug: ${slug}`);
        cfg.league = slug;
        break;
      }
      case "--season": {
        const season = Number(value());
        if (!Number.isInteger(season) || season < 1990 || season > 2100) {
          throw new Error(`invalid season year: ${value()}`);
        }
        cfg.season = season;
        break;
      }
      case "--weeks": {
        const weeks = parseWeeks(value());
        if (!weeks || weeks.some((week) => week < 1 || week > 38)) {
          throw new Error(`invalid --weeks value: ${value()} (expected e.g. 1-10 or 1,2,3)`);
        }
        cfg.weeks = weeks;
        break;
      }
      default:
        throw new Error(`unknown option: ${flag} (try --help)`);
    }
  }

  return cfg;
}

function printHelp(): void {
  log(
    [
      "V4 Predictor — V2 Strict 3-Snipe local backtest",
      "",
      "Usage:",
      "  npx tsx scripts/backtest-local.ts [options]",
      "",
      "Options:",
      `  --league <slug>   ESPN league slug (default: ${DEFAULT_LEAGUE} = Premier League)`,
      `  --season <year>   Season start year (default: ${currentSeasonYear()} = ${seasonLabel(currentSeasonYear())})`,
      `  --weeks <list>    Matchweeks, e.g. 1-10 or 1,2,3 (default: ${DEFAULT_WEEKS[0]}-${DEFAULT_WEEKS[DEFAULT_WEEKS.length - 1]})`,
      "  --detail          Also print a per-fixture table",
      "  --self-test       Run the V2 rule self-test (no network)",
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
    runSelfTest();
    return;
  }

  log(
    `V4 local backtest (V2 Strict 3-Snipe System) — ${cfg.league}, season ${seasonLabel(cfg.season)}, ` +
      `matchweeks ${cfg.weeks.join(", ")}`,
  );

  const weeks: WeekResult[] = [];
  for (const week of cfg.weeks) {
    weeks.push(await backtestWeek(week, cfg));
  }

  const leagueName = cfg.league === DEFAULT_LEAGUE ? "Premier League" : cfg.league;
  const report = renderMarkdown(weeks, cfg, leagueName);
  console.log(report);

  if (weeks.every((week) => week.scored === 0)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`Backtest failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
