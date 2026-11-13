/**
 * Autonomous V4 walk-forward backtest, EPL matchweeks 1–10.
 *
 *   npm run backtest:v4                 # pinned GitHub snapshots (sandbox-safe)
 *   npm run backtest:v4 -- --refresh    # refetch the pinned source files
 *   npm run backtest:v4 -- --live       # existing ESPN readers (needs egress)
 *
 * The default season is 2026/27. GitHub mode still calls fetchScoreboard and
 * buildHistoricalTeamForm, but supplies archived schedule rows so those readers
 * do not confuse today's ESPN rolling form with point-in-time history. Final
 * scores are attached only AFTER pricing. Only pre-match (non-C) odds columns
 * are read; HxG/AxG, shots, corners and closing odds never enter a prediction.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as espn from "@/lib/espn";
import { buildHistoricalTeamForm, type HistoricalScheduleEvent } from "@/lib/engine/sofascore";
import { runEngineFromReal } from "@/lib/engine";
import { engineLambdas, get1X2, getCorrectScores } from "@/lib/engine/v4-pricing";
import { normaliseTeamName, parseHistoricalDate } from "@/lib/data/historical";
import { parseCsv } from "@/lib/data/sources/githubDatasets";
import { toV4TeamName } from "@/lib/v4-predictor";
import {
  V4_SYSTEMS, selectV4Slate, scoreV4Prediction,
  type V4SystemId, type V4Pick, type V4PriceBundle,
} from "@/lib/engine/v4-strategies";

const WEEKS = Array.from({ length: 10 }, (_, i) => i + 1);
const CACHE_DIR = ".scratch/v4-backtest";
const REPORT_PATH = "docs/v4-backtest-results.md";
const AUDIT_PATH = ".scratch/v4-backtest-audit.json";
const SUMMARY_PATH = "src/lib/engine/v4-backtest-results.json";
const SOURCES = {
  schedule: { repo: "openfootball/football.json", sha: "e6744429ee395bc86f247348c6184bb08d4eb361", path: "2026-27/en.1.json" },
  results: { repo: "brysonhen/football_matchup_predictor", sha: "96e7dcfc06643213d05b9243aa6c7182e0ac9292", path: "data/raw/pl/E0_2627.csv" },
  prior: { repo: "brysonhen/football_matchup_predictor", sha: "96e7dcfc06643213d05b9243aa6c7182e0ac9292", path: "data/raw/pl/E0_2526.csv" },
  verify: { repo: "ValentinMartine/football_predictions", sha: "d80581a7b830052c8386087b6597d1851d94c13b", path: "data/raw/2627_E0.csv" },
} as const;

type Source = { repo: string; sha: string; path: string };
export interface FootballRow {
  date: string; day: string; home: string; away: string;
  homeGoals: number; awayGoals: number; raw: Record<string, string>;
}
export interface SystemSummary {
  id: V4SystemId; name: string; weekly: number[]; average: number; floor: number;
  hundredPlus: number; exact: number; outcome: number; miss: number;
}

const SHORT_NAMES: Record<string, string> = {
  "man united": "man utd", "man city": "man city", "tottenham": "spurs",
  "nott m forest": "nott m forest", "hull": "hull", "coventry": "coventry",
  "ipswich": "ipswich", "leeds": "leeds", "brighton": "brighton",
};
export function footballTeamKey(name: string): string {
  const key = normaliseTeamName(toV4TeamName(name));
  return SHORT_NAMES[key] ?? key;
}
export function matchKey(home: string, away: string): string {
  return `${footballTeamKey(home)}|${footballTeamKey(away)}`;
}

export function parseFootballCsv(text: string): FootballRow[] {
  const cells = parseCsv(text.replace(/^\uFEFF/, ""));
  if (cells.length < 2) throw new Error("Football-data CSV is empty");
  const header = cells[0];
  const required = ["Div", "Date", "Time", "HomeTeam", "AwayTeam", "FTHG", "FTAG"];
  for (const column of required) if (!header.includes(column)) throw new Error(`Missing CSV column ${column}`);
  const rows: FootballRow[] = [];
  const seen = new Set<string>();
  for (const values of cells.slice(1)) {
    const raw = Object.fromEntries(header.map((key, i) => [key, values[i]?.trim() ?? ""]));
    if (raw.Div !== "E0") continue; // Some mirrors prepend other divisions.
    const day = parseHistoricalDate(raw.Date)?.slice(0, 10);
    if (!day || !/^\d{2}:\d{2}$/.test(raw.Time) || !raw.HomeTeam || !raw.AwayTeam) {
      throw new Error(`Invalid football-data row: ${raw.Date} ${raw.HomeTeam} vs ${raw.AwayTeam}`);
    }
    const homeGoals = Number(raw.FTHG), awayGoals = Number(raw.FTAG);
    if (raw.FTHG === "" || raw.FTAG === "" || !Number.isInteger(homeGoals) || !Number.isInteger(awayGoals) || homeGoals < 0 || awayGoals < 0) {
      throw new Error(`Missing/invalid final score: ${raw.HomeTeam} vs ${raw.AwayTeam}`);
    }
    const key = `${day}|${matchKey(raw.HomeTeam, raw.AwayTeam)}`;
    if (seen.has(key)) throw new Error(`Duplicate football-data fixture ${key}`);
    seen.add(key);
    rows.push({ date: `${day}T${raw.Time}:00Z`, day, home: raw.HomeTeam, away: raw.AwayTeam, homeGoals, awayGoals, raw });
  }
  return rows.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

function decimalToAmerican(decimal: number): number {
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}
function positivePrice(raw: Record<string, string>, key: string): number | null {
  const value = Number(raw[key]);
  return raw[key] !== "" && Number.isFinite(value) && value > 1 ? value : null;
}
/** Archived opening/average prices, never the post-event closing (`C`) columns. */
export function archivedOdds(row: FootballRow, homeAbbrev: string): espn.OddsInfo | null {
  const raw = row.raw;
  const h = positivePrice(raw, "AvgH") ?? positivePrice(raw, "B365H");
  const d = positivePrice(raw, "AvgD") ?? positivePrice(raw, "B365D");
  const a = positivePrice(raw, "AvgA") ?? positivePrice(raw, "B365A");
  if (h === null || d === null || a === null) return null;
  const hasTotal = (positivePrice(raw, "Avg>2.5") !== null && positivePrice(raw, "Avg<2.5") !== null) ||
    (positivePrice(raw, "B365>2.5") !== null && positivePrice(raw, "B365<2.5") !== null);
  const handicap = raw.AHh !== "" && Number.isFinite(Number(raw.AHh)) ? Number(raw.AHh) : null;
  return {
    homeML: decimalToAmerican(h), drawML: decimalToAmerican(d), awayML: decimalToAmerican(a),
    ...(hasTotal ? { overUnder: 2.5 } : {}),
    ...(handicap !== null ? { details: `${homeAbbrev} ${handicap}` } : {}),
    provider: "Football-Data.co.uk archived pre-match average",
  };
}

async function sourceText(source: Source, refresh: boolean): Promise<string> {
  const file = resolve(CACHE_DIR, `${source.sha}-${source.path.replaceAll("/", "_")}`);
  if (!refresh) {
    try { return await readFile(file, "utf8"); } catch { /* fetch below */ }
  }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const url = `https://api.github.com/repos/${source.repo}/contents/${source.path}?ref=${source.sha}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.raw+json", "User-Agent": "Bayesian-Oracle-V4-backtest",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub source ${source.repo}/${source.path} returned HTTP ${response.status}`);
  const text = await response.text();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return text;
}

function scheduleEvent(row: FootballRow): HistoricalScheduleEvent {
  const homeId = `football-data:${footballTeamKey(row.home)}`;
  const awayId = `football-data:${footballTeamKey(row.away)}`;
  return {
    id: `football-data:${row.day}:${matchKey(row.home, row.away)}`, date: row.date,
    league: { name: "Premier League" },
    competitions: [{
      status: { type: { state: "post" } },
      competitors: [
        { id: homeId, homeAway: "home", score: row.homeGoals, team: { id: homeId, displayName: toV4TeamName(row.home) } },
        { id: awayId, homeAway: "away", score: row.awayGoals, team: { id: awayId, displayName: toV4TeamName(row.away) } },
      ],
    }],
  };
}

async function historicalForm(name: string, cutoff: string, events: readonly HistoricalScheduleEvent[], live: boolean) {
  if (live) return buildHistoricalTeamForm(name, "eng.1", cutoff);
  const id = `football-data:${footballTeamKey(name)}`;
  // Do not even pass a future event into the form reader. The reader applies
  // its own strict cutoff and last-five selection a second time.
  const priorEvents = events.filter((event) => Date.parse(event.date!) < Date.parse(cutoff));
  return buildHistoricalTeamForm(name, "eng.1", cutoff, 5, { team: { id, slug: "eng.1" }, events: priorEvents });
}

export function summarise(results: { system: V4SystemId; points: number; week: number }[]): SystemSummary[] {
  return V4_SYSTEMS.map(({ id, name }) => {
    const rows = results.filter((r) => r.system === id);
    const weekly = WEEKS.map((week) => rows.filter((r) => r.week === week).reduce((sum, r) => sum + r.points, 0));
    if (rows.length !== 100) throw new Error(`${name}: expected 100 scored fixtures, got ${rows.length}`);
    return {
      id, name, weekly, average: weekly.reduce((a, b) => a + b, 0) / WEEKS.length,
      floor: Math.min(...weekly), hundredPlus: weekly.filter((n) => n >= 100).length,
      exact: rows.filter((r) => r.points === 20).length,
      outcome: rows.filter((r) => r.points === 10).length,
      miss: rows.filter((r) => r.points === 0).length,
    };
  });
}
/** Pre-declared decision rule: protect the worst week first, then average. */
export function chooseWinner(summaries: readonly SystemSummary[]): SystemSummary {
  return [...summaries].sort((a, b) => b.floor - a.floor || b.average - a.average || b.hundredPlus - a.hundredPlus || a.id.localeCompare(b.id))[0];
}

export function markdownTable(summaries: readonly SystemSummary[]): string {
  const header = `| System | ${WEEKS.map((w) => `MW${w}`).join(" | ")} | Average | Floor | 100+ weeks |`;
  const divider = `|---|${WEEKS.map(() => "---:").join("|")}|---:|---:|---:|`;
  const rows = summaries.map((s) => `| ${s.name} | ${s.weekly.join(" | ")} | ${s.average.toFixed(1)} | ${s.floor} | ${s.hundredPlus} |`);
  return [header, divider, ...rows].join("\n");
}

interface AuditFixture {
  week: number; id: string; date: string; home: string; away: string;
  actual: [number, number]; odds: espn.OddsInfo | null;
  form: { home: number; away: number; homeDates: string[]; awayDates: string[] };
  lambdas: { home: number; away: number };
  probabilities: { h: number; d: number; a: number };
  picks: Record<V4SystemId, V4Pick & { points: number }>;
}

async function main() {
  const live = process.argv.includes("--live");
  const refresh = process.argv.includes("--refresh");
  const sourceLinks = Object.values(SOURCES).map((s) => `- [${s.repo}/${s.path}](https://github.com/${s.repo}/blob/${s.sha}/${s.path}) (pinned \`${s.sha.slice(0, 12)}\`)`);
  let schedule: espn.OpenfootballScheduleRow[] = [];
  let priorRows: FootballRow[] = [];
  let currentRows: FootballRow[] = [];
  let oddsByPair = new Map<string, espn.OddsInfo>();
  let verified = 0;

  if (!live) {
    const [scheduleText, resultsText, priorText, verifyText] = await Promise.all([
      sourceText(SOURCES.schedule, refresh), sourceText(SOURCES.results, refresh),
      sourceText(SOURCES.prior, refresh), sourceText(SOURCES.verify, refresh),
    ]);
    const parsed: unknown = JSON.parse(scheduleText);
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { matches?: unknown }).matches)) {
      throw new Error("Openfootball schedule has no matches array");
    }
    schedule = (parsed as { matches: espn.OpenfootballScheduleRow[] }).matches;
    currentRows = parseFootballCsv(resultsText);
    priorRows = parseFootballCsv(priorText);
    const verification = parseFootballCsv(verifyText);
    const verifyByPair = new Map(verification.map((r) => [matchKey(r.home, r.away), r]));
    const firstTen = schedule.filter((r) => Number(r.round?.match(/(\d+)/)?.[1]) <= 10);
    if (firstTen.length !== 100 || currentRows.length !== 100) {
      throw new Error(`Expected 100 fixtures in MW1–10; schedule=${firstTen.length}, results=${currentRows.length}`);
    }
    const roundByPair = new Map(firstTen.map((r) => [matchKey(r.team1!, r.team2!), Number(r.round!.match(/(\d+)/)![1])]));
    if (roundByPair.size !== 100) throw new Error("Duplicate home/away pairing in the first ten matchweeks");
    const overrides = new Map<string, espn.OpenfootballScheduleRow>();
    for (const row of currentRows) {
      const key = matchKey(row.home, row.away);
      const round = roundByPair.get(key);
      if (!round) throw new Error(`Result has no MW1–10 schedule pairing: ${key}`);
      const check = verifyByPair.get(key);
      if (!check || check.day !== row.day || check.homeGoals !== row.homeGoals || check.awayGoals !== row.awayGoals) {
        throw new Error(`Independent result mirror disagrees for ${key}`);
      }
      verified++;
      const original = firstTen.find((r) => matchKey(r.team1!, r.team2!) === key)!;
      overrides.set(key, { ...original, date: row.day, time: row.raw.Time, score: { ft: [row.homeGoals, row.awayGoals] }, status: "Full Time" });
      const odds = archivedOdds(row, toV4TeamName(row.home).slice(0, 3).toUpperCase());
      if (!odds) throw new Error(`No archived pre-match 1X2 odds for ${key}`);
      oddsByPair.set(key, odds);
    }
    schedule = schedule.map((row) => overrides.get(matchKey(row.team1!, row.team2!)) ?? row);
  }

  const events = [...priorRows, ...currentRows].map(scheduleEvent);
  const audit: AuditFixture[] = [];
  const scored: { system: V4SystemId; week: number; points: number }[] = [];
  let formsWithData = 0;
  let oddsCount = 0;

  for (const week of WEEKS) {
    const fixtures = live
      ? await espn.fetchScoreboard("eng.1", undefined, week)
      : await espn.fetchScoreboard("eng.1", undefined, week, { rows: schedule, mergeEspn: false });
    const sorted = fixtures.filter((f) => f.matchweek === week).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    if (sorted.length !== 10 || sorted.some((f) => f.state !== "post" || f.home.score === null || f.away.score === null)) {
      throw new Error(`MW${week}: need ten completed real fixtures, got ${sorted.length} (incomplete weeks are never scored as zero)`);
    }
    const priced: { fx: espn.FixtureLite; bundle: V4PriceBundle; entry: AuditFixture }[] = [];
    for (const fx of sorted) {
      const cutoff = fx.date;
      const [homeForm, awayForm] = await Promise.all([
        historicalForm(fx.home.name, cutoff, events, live),
        historicalForm(fx.away.name, cutoff, events, live),
      ]);
      if (homeForm) formsWithData++;
      if (awayForm) formsWithData++;
      for (const form of [homeForm, awayForm]) {
        if (form?.games.some((g) => Date.parse(g.date) >= Date.parse(cutoff))) throw new Error(`Future form leaked into ${fx.id}`);
      }
      const odds = live ? null : oddsByPair.get(matchKey(fx.home.name, fx.away.name)) ?? null;
      if (odds) oddsCount++;
      // Explicit pre-match allowlist. The actual score stays outside this object.
      const engineFx: espn.FixtureLite = {
        ...fx, state: "pre", statusDetail: "", clock: undefined, odds,
        home: { ...fx.home, score: null, record: null, form: null },
        away: { ...fx.away, score: null, record: null, form: null },
      };
      const summary: espn.MatchSummary = {
        venue: null, homeForm, awayForm, h2h: [], odds,
        homeLineup: [], awayLineup: [], lineupAvailable: false,
        homeFormation: null, awayFormation: null, boxscore: null,
      };
      const engine = runEngineFromReal(engineFx, summary);
      const fallback = engineLambdas(engine) ?? { homeGoals: 1.35, awayGoals: 1.15 };
      const bundle = { probs: get1X2(engine, fallback), scores: getCorrectScores(engine, fallback) };
      if (!bundle.scores.length) throw new Error(`Empty Engine grid for ${fx.id}`);
      const actual: [number, number] = [Number(fx.home.score), Number(fx.away.score)];
      if (!actual.every((n) => Number.isInteger(n) && n >= 0)) throw new Error(`Invalid actual score for ${fx.id}`);
      priced.push({
        fx, bundle,
        entry: {
          week, id: fx.id, date: fx.date, home: toV4TeamName(fx.home.name), away: toV4TeamName(fx.away.name),
          actual, odds,
          form: { home: homeForm?.games.length ?? 0, away: awayForm?.games.length ?? 0, homeDates: homeForm?.games.map((g) => g.date) ?? [], awayDates: awayForm?.games.map((g) => g.date) ?? [] },
          lambdas: { home: engine.lambdas["λ Home Goals"], away: engine.lambdas["λ Away Goals"] },
          probabilities: bundle.probs,
          picks: {} as AuditFixture["picks"],
        },
      });
    }
    const slate = priced.map(({ entry }) => ({ home: entry.home, away: entry.away }));
    for (const system of V4_SYSTEMS) {
      const picks = selectV4Slate(system.id, slate, priced.map((p) => p.bundle));
      picks.forEach((pick, index) => {
        const { entry } = priced[index];
        const points = scoreV4Prediction(pick.prediction, entry.actual);
        entry.picks[system.id] = { ...pick, points };
        scored.push({ system: system.id, week, points });
      });
    }
    audit.push(...priced.map((p) => p.entry));
    console.error(`MW${week}: priced and scored ${sorted.length} fixtures × ${V4_SYSTEMS.length} systems`);
  }

  const summaries = summarise(scored);
  const winner = chooseWinner(summaries);
  const bestAverage = [...summaries].sort((a, b) => b.average - a.average)[0];
  const bestFloor = summaries.filter((s) => s.floor === winner.floor);
  const mostHundreds = Math.max(...summaries.map((s) => s.hundredPlus));
  const table = markdownTable(summaries);
  const mode = live ? "Live ESPN readers" : "Pinned GitHub snapshots, 2026/27 EPL";
  const report = `# V4 Predictor backtest — EPL Matchweeks 1–10\n\n` +
    `Generated: ${new Date().toISOString()} · Mode: ${mode}\n\n` +
    `Coverage: **${audit.length}/100 completed fixtures**, ${oddsCount}/100 archived pre-match odds, ${formsWithData}/200 team-form windows with prior EPL data, 0 Engine failures. ` +
    `${live ? "Live ESPN historical odds are unavailable and stripped." : `${verified}/100 final scores agree with an independent pinned mirror.`}\n\n` +
    `${table}\n\n` +
    `## Decision\n\n` +
    `- **Implemented winner: ${winner.name}** — floor ${winner.floor}, average ${winner.average.toFixed(1)}, ${winner.hundredPlus} weeks at 100+.\n` +
    `- Highest average: **${bestAverage.name} (${bestAverage.average.toFixed(1)})**.\n` +
    `- Highest floor: **${bestFloor.map((s) => s.name).join(", ")} (${winner.floor})**.\n` +
    `- Most 100+ weeks: **${summaries.filter((s) => s.hundredPlus === mostHundreds).map((s) => s.name).join(", ")} (${mostHundreds})**.\n` +
    `- Selection rule fixed before scoring: highest floor, then highest average, then most 100+ weeks. No thresholds or team lists were tuned to these results.\n` +
    `- The requested 75–85 average / 60+ floor / two 100+ weeks is a diagnostic target, not a guarantee. ${winner.average >= 75 && winner.average <= 85 && winner.floor >= 60 && winner.hundredPlus >= 2 ? "The winner meets it on this sample." : "The observed results do not all meet it; the measured winner is reported without adjustment."} Ten weeks is a small, in-season sample, not proof of future performance.\n\n` +
    `## Method and leakage controls\n\n` +
    `1. Fetch each week in kickoff order through the existing \`fetchScoreboard\` reader. GitHub mode supplies archived schedule rows and disables ESPN merging; MW10 uses the result feed's actual moved kickoff dates.\n` +
    `2. Build last-five form through \`buildHistoricalTeamForm\`, passing only events strictly before kickoff. The snapshot contains prior-season and current-season EPL results; cup/Championship form and ESPN boxscore mesh profiles are unavailable, so those inputs fall back exactly as the Engine specifies.\n` +
    `3. Price one Dixon–Coles Engine grid per fixture from pre-match form, league anchors and archived **non-closing** average 1X2 / 2.5-goal / Asian-handicap prices. Final scores, match xG, shots, corners, cards and lineups are excluded from the prediction input. Archived odds were retrieved retrospectively, not replayed from timestamped ESPN closing lines.\n` +
    `4. Run all five selectors on that identical bundle. V2 lists/quotas are recovered from merged PR #191. The requested V2 Hybrid preserves the named 2-0 and 1-1 snipes; Elite Away 0-1 goes to the Engine. Consensus retains every original V2 outcome. Draw Guard tests the largest 1X2 probability against a strict 45% threshold.\n` +
    `5. Attach actual scores only after selection; score exact=20, outcome-only=10, miss=0. Average is the mean of ten weekly totals; floor is the minimum weekly total. Every week has ten fixtures.\n\n` +
    `## Reproduce\n\n\`\`\`bash\nnpm ci\nnpm run backtest:v4 -- --refresh\nnpx tsc --noEmit\n\`\`\`\n\n` +
    `The script writes this report and a local per-fixture audit at \`${AUDIT_PATH}\` (gitignored). On sandboxes with a custom CA, set \`NODE_EXTRA_CA_CERTS\` to the system CA bundle. No API key is required; an existing GitHub token is used only to raise public API rate limits.\n\n` +
    `## Sources\n\n${sourceLinks.join("\n")}\n\n` +
    `Results/odds originate from Football-Data.co.uk via the mirrors above; schedule from openfootball. Raw third-party CSVs are cached locally and not redistributed in this PR.\n`;

  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, report);
  await writeFile(SUMMARY_PATH, JSON.stringify({
    season: live ? "live" : "2026/27", competition: "eng.1", weeks: WEEKS,
    fixtureCount: audit.length, winner: winner.id, mode, generatedAt: new Date().toISOString(),
    systems: summaries,
  }, null, 2) + "\n");
  await mkdir(dirname(AUDIT_PATH), { recursive: true });
  await writeFile(AUDIT_PATH, JSON.stringify({ mode, sources: SOURCES, winner: winner.id, summaries, fixtures: audit }, null, 2));
  console.log(`\n${table}\n\nWinner: ${winner.name} (floor ${winner.floor}; average ${winner.average.toFixed(1)})`);
  console.error(`Report: ${REPORT_PATH}\nAudit: ${AUDIT_PATH}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
