#!/usr/bin/env node
/**
 * ĞIGI GIVØ — V4 Predictor: LOCAL, REAL-DATA backtest.
 * ---------------------------------------------------------------------------
 * Run this on your own machine (Termux) against the live ESPN API:
 *
 *     npx tsx scripts/backtest-local.ts
 *
 * What it does, for every fixture in Matchweeks 1–10 of the current season:
 *
 *   1. Fetch the slate from ESPN with the existing `fetchScoreboard`.
 *   2. Run `runEngineFromRealWithProfiles` with the fixture's OWN kickoff
 *      passed as `beforeDate`, so the mesh profiles, team form and H2H can
 *      only ever see matches that finished BEFORE that kickoff (time travel).
 *   3. Apply the deployed V4 decision rules:
 *        • top exact score probability >= 0.13  → take that exact score
 *        • P(Draw) >= 0.32                      → force a draw scoreline
 *        • otherwise                            → V2 Tiers fallback
 *   4. Score the pick against the real final score: 20 / 10 / 0.
 *   5. Print a clean Markdown table: MW1 … MW10 + Average + Floor.
 *
 * There is NO mock data and NO local JSON here. Every number comes from a live
 * ESPN request; if the network is unavailable the script says so and exits.
 */

import type { FixtureLite, MatchSummary, TeamForm } from "../src/lib/espn";
import type { EngineResult } from "../src/lib/engine/types";
import type { ScoreCell } from "../src/lib/engine/markets";

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap — the engine's mesh cache module requires DATABASE_URL at import
// time even though a point-in-time run never touches it (`getCachedMeshProfile`
// bypasses the cache whenever `beforeDate` is supplied). Provide an inert
// placeholder so the import succeeds; nothing is ever connected or written.
// ─────────────────────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://backtest:backtest@127.0.0.1:5432/backtest";
}

// ─────────────────────────────────────────────────────────────────────────────
// Deployed V4 constants
// ─────────────────────────────────────────────────────────────────────────────

/** Take the top exact scoreline outright at or above this probability. */
const EXACT_SCORE_THRESHOLD = 0.13;
/** Force a draw scoreline at or above this draw probability. */
const DRAW_THRESHOLD = 0.32;
/**
 * Threshold tolerance. Probabilities here are sums of normalised grid cells,
 * so a genuine 32.0% can land on 31.999999999% in binary floating point. A
 * sub-nanoscopic epsilon keeps the deployed thresholds exact without ever
 * accepting a line that is meaningfully below them.
 */
const THRESHOLD_EPSILON = 1e-9;
/** Points: exact scoreline / correct outcome / miss. */
const PTS_EXACT = 20;
const PTS_OUTCOME = 10;
const PTS_MISS = 0;
/** Matchweeks covered by the backtest. */
const DEFAULT_WEEKS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
/** Default league: the Premier League, which is what the V4 page prices. */
const DEFAULT_LEAGUE = "eng.1";
/** Fixtures priced in parallel (each fixture fans out to several ESPN calls). */
const DEFAULT_CONCURRENCY = 2;

/**
 * V2 Tiers — the fallback ladder used when neither the exact-score threshold
 * nor the draw guard fires.
 *
 * The ladder only ever offers "bankable" scorelines, and a line is only pickable
 * when its implied outcome equals the Engine's most likely outcome:
 *
 *   Tier 1 — the three banker lines (1-0, 0-1, 1-1)
 *   Tier 2 — standard winning margins (2-1, 1-2, 2-0, 0-2, 0-0)
 *   Tier 3 — wide margins / goal fests (2-2, 3-1, 1-3, 3-0, 0-3)
 *
 * The first tier that contains a line for the locked outcome wins, and inside
 * that tier the highest-probability line is taken. If no tier qualifies, the
 * best scoreline for the locked outcome is used (rule "locked"), so a pick is
 * never an outright outlier.
 */
const V2_TIER_LADDER: readonly (readonly string[])[] = [
  ["1-0", "0-1", "1-1"],
  ["2-1", "1-2", "2-0", "0-2", "0-0"],
  ["2-2", "3-1", "1-3", "3-0", "0-3"],
];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Outcome = "H" | "D" | "A";
type Rule = "exact" | "draw" | "v2-tier" | "locked";
type Status = "exact" | "outcome" | "miss" | "skipped";

interface Scoreline {
  home: number;
  away: number;
}

interface Decision {
  scoreline: string;
  home: number;
  away: number;
  outcome: Outcome;
  rule: Rule;
  /** 1-based V2 tier; null for the threshold rules. */
  tier: number | null;
  exactProbability: number;
  drawProbability: number;
  lockedOutcome: Outcome;
}

interface Config {
  league: string;
  season: number;
  weeks: number[];
  concurrency: number;
  detail: boolean;
  help: boolean;
  selfTest: boolean;
}

interface Deps {
  espn: typeof import("../src/lib/espn");
  engine: typeof import("../src/lib/engine");
  markets: typeof import("../src/lib/engine/markets");
  sofascore: typeof import("../src/lib/engine/sofascore");
}

interface FixtureOutcome {
  week: number;
  match: string;
  kickoff: string;
  prediction: string | null;
  rule: Rule | null;
  tier: number | null;
  exactProbability: number | null;
  drawProbability: number | null;
  actual: string | null;
  points: number;
  status: Status;
  note: string;
}

interface WeekResult {
  week: number;
  fixtures: FixtureOutcome[];
  points: number;
  scored: number;
  exact: number;
  outcomeHits: number;
  misses: number;
  note: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure decision logic (self-testable, no network, no Engine)
// ─────────────────────────────────────────────────────────────────────────────

function parseScoreline(value: string): Scoreline | null {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  return { home: Number(match[1]), away: Number(match[2]) };
}

function outcomeOf(line: Scoreline): Outcome {
  if (line.home > line.away) return "H";
  if (line.home < line.away) return "A";
  return "D";
}

function lineKey(line: Scoreline): string {
  return `${line.home}-${line.away}`;
}

interface ProbableLine {
  line: Scoreline;
  probability: number;
}

/** Highest-probability line in the map that satisfies `accept`. */
function bestLine(
  probabilities: ReadonlyMap<string, number>,
  accept: (outcome: Outcome) => boolean,
): ProbableLine | null {
  let best: ProbableLine | null = null;
  for (const [key, probability] of probabilities) {
    const line = parseScoreline(key);
    if (!line || probability <= 0) continue;
    if (!accept(outcomeOf(line))) continue;
    if (!best || probability > best.probability) best = { line, probability };
  }
  return best;
}

function buildDecision(
  pick: ProbableLine,
  rule: Rule,
  tier: number | null,
  drawProbability: number,
  lockedOutcome: Outcome,
): Decision {
  const line = pick.line;
  return {
    scoreline: lineKey(line),
    home: line.home,
    away: line.away,
    outcome: outcomeOf(line),
    rule,
    tier,
    exactProbability: pick.probability,
    drawProbability,
    lockedOutcome,
  };
}

/**
 * Apply the deployed V4 rules to a Dixon–Coles score grid.
 *
 *  1. top exact score probability >= 0.13 → that exact scoreline
 *  2. P(Draw) >= 0.32                     → best draw scoreline
 *  3. otherwise                           → V2 Tiers, locked to the Engine's
 *                                           most likely outcome
 */
function decide(cells: readonly ScoreCell[]): Decision | null {
  const probabilities = new Map<string, number>();
  const outcomeTotals: Record<Outcome, number> = { H: 0, D: 0, A: 0 };
  let drawProbability = 0;
  let top: ProbableLine | null = null;

  for (const cell of cells) {
    const probability = cell.probability;
    if (!Number.isFinite(probability) || probability <= 0) continue;
    const line: Scoreline = { home: cell.homeGoals, away: cell.awayGoals };
    const key = lineKey(line);
    probabilities.set(key, (probabilities.get(key) ?? 0) + probability);
    const outcome = outcomeOf(line);
    outcomeTotals[outcome] += probability;
    if (outcome === "D") drawProbability += probability;
    if (!top || probability > top.probability) top = { line, probability };
  }

  if (!top) return null;

  const lockedOutcome = (["H", "D", "A"] as Outcome[]).reduce<Outcome>(
    (best, outcome) => (outcomeTotals[outcome] > outcomeTotals[best] ? outcome : best),
    "D",
  );

  // Rule 1 — a strong exact scoreline is taken as-is.
  if (top.probability >= EXACT_SCORE_THRESHOLD - THRESHOLD_EPSILON) {
    return buildDecision(top, "exact", null, drawProbability, lockedOutcome);
  }

  // Rule 2 — the draw guard.
  if (drawProbability >= DRAW_THRESHOLD - THRESHOLD_EPSILON) {
    const bestDraw = bestLine(probabilities, (outcome) => outcome === "D");
    if (bestDraw) {
      return buildDecision(bestDraw, "draw", null, drawProbability, lockedOutcome);
    }
  }

  // Rule 3 — V2 Tiers, walking the ladder from the safest tier down.
  for (let index = 0; index < V2_TIER_LADDER.length; index += 1) {
    const tierLines = V2_TIER_LADDER[index]
      .map(parseScoreline)
      .filter((line): line is Scoreline => line !== null);

    let tierPick: ProbableLine | null = null;
    for (const line of tierLines) {
      if (outcomeOf(line) !== lockedOutcome) continue;
      const probability = probabilities.get(lineKey(line)) ?? 0;
      if (probability <= 0) continue;
      if (!tierPick || probability > tierPick.probability) {
        tierPick = { line, probability };
      }
    }

    if (tierPick) {
      return buildDecision(tierPick, "v2-tier", index + 1, drawProbability, lockedOutcome);
    }
  }

  // Last resort — the best real scoreline for the locked outcome.
  const lockedBest =
    bestLine(probabilities, (outcome) => outcome === lockedOutcome) ?? top;
  return buildDecision(lockedBest, "locked", null, drawProbability, lockedOutcome);
}

/** Points for a decision against the real final score. */
function scoreDecision(
  decision: Decision,
  actual: Scoreline,
): { points: number; status: Exclude<Status, "skipped">; note: string } {
  if (decision.home === actual.home && decision.away === actual.away) {
    return { points: PTS_EXACT, status: "exact", note: "exact scoreline" };
  }
  if (decision.outcome === outcomeOf(actual)) {
    return { points: PTS_OUTCOME, status: "outcome", note: "right outcome, wrong score" };
  }
  const wanted = decision.outcome === "D" ? "draw" : decision.outcome === "H" ? "home win" : "away win";
  return { points: PTS_MISS, status: "miss", note: `wrong outcome (pick needed ${wanted})` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine plumbing
// ─────────────────────────────────────────────────────────────────────────────

/** Strictly-before predicate: no match on the fixture's own day can leak in. */
function beforeCutoff(cutoffIso: string): (iso: string) => boolean {
  const cutoff = Date.parse(cutoffIso);
  return (iso: string): boolean => {
    const time = Date.parse(iso);
    if (!Number.isFinite(cutoff) || !Number.isFinite(time) || time >= cutoff) return false;
    // A date-only value on the match day cannot prove pre-kickoff availability.
    return iso.includes("T") || iso.slice(0, 10) < cutoffIso.slice(0, 10);
  };
}

/** The Engine's Dixon–Coles grid, or one rebuilt from its own lambdas. */
function scoreCells(
  result: EngineResult | null,
  markets: Deps["markets"],
): ScoreCell[] | null {
  const published = result?.scoreGrid?.cells;
  if (published && published.length > 0) return published;

  const home = result?.lambdas?.["λ Home Goals"];
  const away = result?.lambdas?.["λ Away Goals"];
  if (
    typeof home !== "number" || typeof away !== "number" ||
    !Number.isFinite(home) || !Number.isFinite(away) || home < 0 || away < 0
  ) {
    return null;
  }
  return markets.buildCorrectScoreGrid(home, away, markets.DIXON_COLES_RHO).cells;
}

/**
 * Price one finished fixture as if we were standing at kickoff.
 *
 * Every input the Engine can read is filtered to the fixture's own kickoff:
 *   • `beforeDate` → mesh profiles (last 20 boxscores BEFORE the cutoff)
 *   • buildHistoricalTeamForm → form strictly before the cutoff
 *   • H2H entries strictly before the cutoff
 *   • odds stripped (a finished fixture's summary carries the closing line,
 *     and the deployed V4 route never prices a played fixture off the book)
 *   • scores stripped from the fixture object, state forced to "pre"
 */
async function runEngineAtKickoff(fx: FixtureLite, deps: Deps): Promise<EngineResult> {
  const [summary, homeForm, awayForm] = await Promise.all([
    deps.espn.fetchSummary(fx.leagueSlug, fx.id).catch(() => null),
    deps.sofascore.buildHistoricalTeamForm(fx.home.name, fx.leagueSlug, fx.date).catch(() => null),
    deps.sofascore.buildHistoricalTeamForm(fx.away.name, fx.leagueSlug, fx.date).catch(() => null),
  ]);

  const isBefore = beforeCutoff(fx.date);
  const sanitized: MatchSummary = {
    venue: summary?.venue ?? fx.venue ?? null,
    homeForm: homeForm as TeamForm | null,
    awayForm: awayForm as TeamForm | null,
    h2h: (summary?.h2h ?? []).filter((game) => isBefore(game.date)),
    // No bookmaker line: a played fixture's summary exposes the closing price.
    odds: null,
    // No lineups / xG / boxscore: they are only published for played matches.
    homeLineup: [],
    awayLineup: [],
    lineupAvailable: false,
    homeFormation: null,
    awayFormation: null,
    boxscore: null,
  };

  const engineFixture: FixtureLite = {
    ...fx,
    state: "pre",
    statusDetail: "",
    clock: undefined,
    odds: null,
    home: { ...fx.home, score: null, record: null, form: null },
    away: { ...fx.away, score: null, record: null, form: null },
  };

  return deps.engine.runEngineFromRealWithProfiles(
    engineFixture,
    sanitized,
    null,
    undefined,
    fx.date,
  );
}

/**
 * Preflight reachability probe. `fetchScoreboard` is fail-soft by design — a
 * blocked network and an empty matchweek both look like `[]` — so a single
 * cheap probe up front lets the script tell the user the difference instead of
 * silently reporting ten empty weeks.
 */
async function probeEspn(league: string): Promise<{ ok: boolean; detail: string }> {
  const url =
    `https://site.api.espn.com/apis/site/v2/sports/soccer/` +
    `${encodeURIComponent(league)}/scoreboard?limit=1`;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GigiGivo/1.0)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: response.ok, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

/** pct formatter for console output. */
function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function gameCount(week: WeekResult): string {
  return week.scored > 0 ? String(week.scored) : "—";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Backtest
// ─────────────────────────────────────────────────────────────────────────────

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

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

async function scoreFixture(
  fx: FixtureLite,
  week: number,
  deps: Deps,
): Promise<FixtureOutcome> {
  const base: FixtureOutcome = {
    week,
    match: `${fx.home.name} vs ${fx.away.name}`,
    kickoff: fx.date,
    prediction: null,
    rule: null,
    tier: null,
    exactProbability: null,
    drawProbability: null,
    actual: null,
    points: PTS_MISS,
    status: "skipped",
    note: "",
  };

  if (fx.state !== "post") {
    return { ...base, note: `fixture not finished (state=${fx.state})` };
  }

  const homeScore = fx.home.score === null || fx.home.score === "" ? NaN : Number(fx.home.score);
  const awayScore = fx.away.score === null || fx.away.score === "" ? NaN : Number(fx.away.score);
  if (
    !Number.isFinite(homeScore) || !Number.isFinite(awayScore) ||
    homeScore < 0 || awayScore < 0
  ) {
    return { ...base, note: "ESPN payload has no final score" };
  }
  const actual: Scoreline = { home: homeScore, away: awayScore };
  const actualLabel = lineKey(actual);

  if (!Number.isFinite(Date.parse(fx.date))) {
    return { ...base, actual: actualLabel, note: `unparseable kickoff date: ${fx.date}` };
  }

  try {
    const engineResult = await runEngineAtKickoff(fx, deps);
    const cells = scoreCells(engineResult, deps.markets);
    const decision = cells ? decide(cells) : null;
    if (!decision) {
      return { ...base, actual: actualLabel, note: "engine produced no usable score grid" };
    }

    const scored = scoreDecision(decision, actual);
    return {
      ...base,
      actual: actualLabel,
      prediction: decision.scoreline,
      rule: decision.rule,
      tier: decision.tier,
      exactProbability: decision.exactProbability,
      drawProbability: decision.drawProbability,
      points: scored.points,
      status: scored.status,
      note: scored.note,
    };
  } catch (error) {
    return { ...base, actual: actualLabel, note: `engine error: ${errorMessage(error)}` };
  }
}

function emptyWeek(week: number, note: string): WeekResult {
  return {
    week,
    fixtures: [],
    points: 0,
    scored: 0,
    exact: 0,
    outcomeHits: 0,
    misses: 0,
    note,
  };
}

async function backtestWeek(week: number, cfg: Config, deps: Deps): Promise<WeekResult> {
  log(`\n── Matchweek ${week} ──────────────────────────────────────────────`);

  let raw: FixtureLite[];
  try {
    // The exact deployed fetch: ESPN scoreboard for this matchweek.
    raw = await deps.espn.fetchScoreboard(cfg.league, undefined, week);
  } catch (error) {
    log(`   ESPN request failed: ${errorMessage(error)}`);
    return emptyWeek(week, `ESPN request failed: ${errorMessage(error)}`);
  }

  const deduped = [...new Map(raw.map((fx) => [fx.id, fx])).values()];
  const fixtures = deduped.filter((fx) => inSeason(fx.date, cfg.season));
  if (fixtures.length !== deduped.length) {
    log(
      `   Ignored ${deduped.length - fixtures.length} fixture(s) outside the ` +
      `${seasonLabel(cfg.season)} season window.`,
    );
  }

  if (fixtures.length === 0) {
    log(`   No ${seasonLabel(cfg.season)} fixtures returned by ESPN for MW${week}.`);
    return emptyWeek(week, `ESPN returned no ${seasonLabel(cfg.season)} fixtures`);
  }

  fixtures.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  log(`   ${fixtures.length} fixture(s) found — pricing each one as of its own kickoff…`);

  let done = 0;
  const outcomes = await mapLimit(fixtures, cfg.concurrency, async (fx) => {
    const outcome = await scoreFixture(fx, week, deps);
    done += 1;
    log(
      `   [${done}/${fixtures.length}] ${outcome.match} :: ` +
      `pick ${outcome.prediction ?? "—"} (${outcome.rule ?? "no pick"}` +
      `${outcome.tier ? ` T${outcome.tier}` : ""}, top ${pct(outcome.exactProbability)}, ` +
      `draw ${pct(outcome.drawProbability)}) vs actual ${outcome.actual ?? "—"} → ` +
      `${outcome.status === "skipped" ? "SKIP" : `${outcome.points} pts`}` +
      `${outcome.status === "skipped" ? ` (${outcome.note})` : ""}`,
    );
    return outcome;
  });

  const scored = outcomes.filter((outcome) => outcome.status !== "skipped");
  return {
    week,
    fixtures: outcomes,
    points: scored.reduce((sum, outcome) => sum + outcome.points, 0),
    scored: scored.length,
    exact: scored.filter((outcome) => outcome.status === "exact").length,
    outcomeHits: scored.filter((outcome) => outcome.status === "outcome").length,
    misses: scored.filter((outcome) => outcome.status === "miss").length,
    note: scored.length === 0 ? "no finished fixture could be scored" : null,
  };
}

async function runBacktest(cfg: Config, deps: Deps): Promise<WeekResult[]> {
  const weeks: WeekResult[] = [];
  for (const week of cfg.weeks) {
    weeks.push(await backtestWeek(week, cfg, deps));
  }
  return weeks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

function ruleLabel(rule: Rule | null, tier: number | null): string {
  if (rule === null) return "—";
  if (rule === "v2-tier") return `V2 tier ${tier ?? "?"}`;
  if (rule === "locked") return "locked outcome";
  return rule === "exact" ? "exact ≥13%" : "draw ≥32%";
}

function renderMarkdown(weeks: WeekResult[], cfg: Config, leagueName: string): string {
  const lines: string[] = [];
  const scoredWeeks = weeks.filter((week) => week.scored > 0);
  const maxFixtures = weeks.reduce((max, week) => Math.max(max, week.scored), 0);
  const maxPoints = PTS_EXACT * maxFixtures;

  const average = scoredWeeks.length > 0
    ? scoredWeeks.reduce((sum, week) => sum + week.points, 0) / scoredWeeks.length
    : null;
  const floor = scoredWeeks.length > 0
    ? scoredWeeks.reduce((min, week) => Math.min(min, week.points), Number.POSITIVE_INFINITY)
    : null;

  lines.push(`## V4 Predictor — Local Backtest (MW${weeks[0]?.week ?? 1}–MW${weeks[weeks.length - 1]?.week ?? 10})`, "");
  lines.push(`- **League:** ${leagueName} (\`${cfg.league}\`)`);
  lines.push(`- **Season:** ${seasonLabel(cfg.season)}`);
  lines.push(`- **Data source:** live ESPN API (\`site.api.espn.com\`) — no local JSON, no mock data`);
  lines.push(`- **Time travel:** every Engine call receives the fixture's own kickoff as \`beforeDate\``);
  lines.push(
    `- **Rules:** top exact score ≥ ${(EXACT_SCORE_THRESHOLD * 100).toFixed(0)}% → exact · ` +
    `P(Draw) ≥ ${(DRAW_THRESHOLD * 100).toFixed(0)}% → draw · otherwise V2 Tiers`,
  );
  lines.push(`- **Scoring:** exact = ${PTS_EXACT} · correct outcome = ${PTS_OUTCOME} · miss = ${PTS_MISS}`);
  lines.push(`- **Generated:** ${new Date().toISOString()}`);
  lines.push("");

  // Headline table: the per-matchweek scores, the average and the floor.
  const header = [
    "| Matchweek",
    ...weeks.map((week) => `MW${week.week}`),
    "**Average**",
    "**Floor**",
  ];
  const divider = [
    "| ---",
    ...weeks.map(() => "---:"),
    "---:",
    "---:",
  ];
  const pointsRow = [
    `| **Points${maxPoints > 0 ? ` (max ${maxPoints})` : ""}**`,
    ...weeks.map((week) => (week.scored > 0 ? String(week.points) : "—")),
    `**${average === null ? "—" : average.toFixed(1)}**`,
    `**${floor === null ? "—" : floor}**`,
  ];
  const fixtureRow = [
    "| Fixtures scored",
    ...weeks.map((week) => gameCount(week)),
    average === null ? "—" : (scoredWeeks.reduce((sum, week) => sum + week.scored, 0) / scoredWeeks.length).toFixed(1),
    scoredWeeks.length > 0 ? String(scoredWeeks.reduce((min, week) => Math.min(min, week.scored), Number.POSITIVE_INFINITY)) : "—",
  ];

  lines.push(header.join(" | ") + " |");
  lines.push(divider.join(" | ") + " |");
  lines.push(pointsRow.join(" | ") + " |");
  lines.push(fixtureRow.join(" | ") + " |");
  lines.push("");
  lines.push(`_Average = mean of the scored matchweeks · Floor = lowest matchweek score._`);
  lines.push("");

  // Breakdown table.
  lines.push("| Matchweek | Fixtures scored | Exact (20) | Outcome (10) | Miss (0) | Points |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const week of weeks) {
    lines.push(
      `| MW${week.week} | ${gameCount(week)} | ${week.scored > 0 ? week.exact : "—"} | ` +
      `${week.scored > 0 ? week.outcomeHits : "—"} | ${week.scored > 0 ? week.misses : "—"} | ` +
      `${week.scored > 0 ? week.points : "—"} |`,
    );
  }
  const totalScored = weeks.reduce((sum, week) => sum + week.scored, 0);
  const totalPoints = weeks.reduce((sum, week) => sum + week.points, 0);
  lines.push(
    `| **Total** | **${totalScored}** | **${weeks.reduce((sum, week) => sum + week.exact, 0)}** | ` +
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
    lines.push("| MW | Match | Kickoff (UTC) | Pick | Rule | P(exact) | P(draw) | Actual | Pts |");
    lines.push("| ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |");
    for (const week of weeks) {
      for (const fixture of week.fixtures) {
        lines.push(
          `| ${week.week} | ${fixture.match} | ${fixture.kickoff.slice(0, 16).replace("T", " ")} | ` +
          `${fixture.prediction ?? "—"} | ${ruleLabel(fixture.rule, fixture.tier)} | ` +
          `${pct(fixture.exactProbability)} | ${pct(fixture.drawProbability)} | ` +
          `${fixture.actual ?? "—"} | ${fixture.status === "skipped" ? "—" : fixture.points} |`,
        );
      }
    }
    lines.push("");
  }

  if (totalScored === 0) {
    lines.push(
      "> ⚠️ **No finished fixtures could be scored.** This season's matchweeks are not " +
      "complete yet, ESPN returned no fixtures, or the machine could not reach the ESPN API. " +
      "Re-run once the matches have finished.",
    );
    lines.push("");
  }

  lines.push("### Run this in Termux", "");
  lines.push("```bash");
  lines.push("npx tsx scripts/backtest-local.ts");
  lines.push("```");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-test (decision logic only — no network)
// ─────────────────────────────────────────────────────────────────────────────

function syntheticCell(homeGoals: number, awayGoals: number, probability: number): ScoreCell {
  return {
    homeGoals,
    awayGoals,
    poisson: probability,
    tau: 1,
    probability,
    poissonProbability: probability,
  };
}

function runSelfTest(): void {
  const cases: Array<{ name: string; cells: ScoreCell[]; scoreline: string; rule: Rule; tier: number | null }> = [
    {
      name: "top exact at 14% wins outright",
      cells: [
        syntheticCell(1, 1, 0.14),
        syntheticCell(1, 0, 0.13),
        syntheticCell(0, 1, 0.12),
        syntheticCell(2, 1, 0.10),
      ],
      scoreline: "1-1",
      rule: "exact",
      tier: null,
    },
    {
      name: "draw guard fires at 32% with no strong exact line",
      cells: [
        syntheticCell(1, 1, 0.12),
        syntheticCell(0, 0, 0.11),
        syntheticCell(2, 2, 0.09),
        syntheticCell(2, 1, 0.12),
        syntheticCell(1, 2, 0.08),
      ],
      scoreline: "1-1",
      rule: "draw",
      tier: null,
    },
    {
      name: "V2 tiers pick the bankable line for the locked outcome",
      cells: [
        syntheticCell(2, 1, 0.12),
        syntheticCell(3, 1, 0.06),
        syntheticCell(2, 0, 0.04),
        syntheticCell(3, 0, 0.02),
        syntheticCell(1, 1, 0.09),
        syntheticCell(0, 0, 0.05),
        syntheticCell(2, 2, 0.03),
        syntheticCell(0, 1, 0.07),
        syntheticCell(1, 3, 0.03),
      ],
      scoreline: "2-1",
      rule: "v2-tier",
      tier: 2,
    },
    {
      name: "locked-outcome fallback when no tier line fits",
      cells: [
        syntheticCell(2, 3, 0.11),
        syntheticCell(1, 4, 0.07),
        syntheticCell(3, 4, 0.06),
        syntheticCell(1, 1, 0.10),
        syntheticCell(0, 0, 0.05),
        syntheticCell(2, 1, 0.06),
        syntheticCell(1, 0, 0.05),
        syntheticCell(2, 0, 0.04),
      ],
      scoreline: "2-3",
      rule: "locked",
      tier: null,
    },
  ];

  let failures = 0;
  for (const testCase of cases) {
    const decision = decide(testCase.cells);
    const ok =
      decision !== null &&
      decision.scoreline === testCase.scoreline &&
      decision.rule === testCase.rule &&
      decision.tier === testCase.tier;
    if (!ok) failures += 1;
    log(
      `${ok ? "PASS" : "FAIL"}  ${testCase.name}` +
      `${decision ? ` → ${decision.scoreline} (${ruleLabel(decision.rule, decision.tier)})` : " → no decision"}`,
    );
  }

  if (failures > 0) {
    log(`\n${failures} self-test(s) failed.`);
    process.exitCode = 1;
    return;
  }
  log(`\nAll ${cases.length} decision-logic self-tests passed.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function currentSeasonYear(now = new Date()): number {
  // European seasons start in July; before July we are still in last year's.
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
    concurrency: DEFAULT_CONCURRENCY,
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
      case "--concurrency": {
        const concurrency = Number(value());
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
          throw new Error(`invalid --concurrency value: ${value()} (expected 1–8)`);
        }
        cfg.concurrency = concurrency;
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
      "V4 Predictor — local, real-data backtest (Termux)",
      "",
      "Usage:",
      "  npx tsx scripts/backtest-local.ts [options]",
      "",
      "Options:",
      `  --league <slug>     ESPN league slug (default: ${DEFAULT_LEAGUE} = Premier League)`,
      `  --season <year>     Season start year (default: ${currentSeasonYear()} = ${seasonLabel(currentSeasonYear())})`,
      `  --weeks <list>      Matchweeks, e.g. 1-10 or 1,2,3 (default: ${DEFAULT_WEEKS[0]}-${DEFAULT_WEEKS[DEFAULT_WEEKS.length - 1]})`,
      `  --concurrency <n>   Fixtures priced in parallel, 1–8 (default: ${DEFAULT_CONCURRENCY})`,
      "  --detail            Also print a per-fixture table",
      "  --self-test         Run the decision-logic self-test (no network)",
      "  --help              Show this help",
      "",
      "Notes:",
      "  • Every fixture is priced as of its own kickoff (`beforeDate`); no future",
      "    match can influence a prediction.",
      "  • All data is fetched live from ESPN. No local JSON, no mock fixtures.",
      "  • No database is required: the mesh cache is bypassed in point-in-time mode.",
    ].join("\n"),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Route third-party engine chatter to stderr so stdout stays a clean Markdown
 * report (`npx tsx scripts/backtest-local.ts > report.md`).
 */
function silenceEngineLogs(): () => void {
  const original = console.log;
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };
  return () => {
    console.log = original;
  };
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

  // Dynamic imports — they must run AFTER the DATABASE_URL placeholder above.
  const espn = await import("../src/lib/espn");
  const engine = await import("../src/lib/engine");
  const markets = await import("../src/lib/engine/markets");
  const sofascore = await import("../src/lib/engine/sofascore");
  const deps: Deps = { espn, engine, markets, sofascore };

  log(
    `V4 local backtest — ${cfg.league}, season ${seasonLabel(cfg.season)}, ` +
    `matchweeks ${cfg.weeks.join(", ")}`,
  );
  log("Data source: live ESPN API (no local files). Each fixture is priced as of its own kickoff.");

  const probe = await probeEspn(cfg.league);
  if (!probe.ok) {
    log("");
    log(`Cannot reach the ESPN API from this machine (${probe.detail}).`);
    log("This backtest only uses live ESPN data — there is no offline or mock fallback.");
    log("Check your connection/DNS in Termux (e.g. `ping -c1 site.api.espn.com`) and re-run:");
    log("  npx tsx scripts/backtest-local.ts");
    process.exitCode = 1;
    return;
  }

  const restoreConsole = silenceEngineLogs();
  let weeks: WeekResult[];
  try {
    weeks = await runBacktest(cfg, deps);
  } finally {
    restoreConsole();
  }

  const leagueName =
    cfg.league === DEFAULT_LEAGUE ? "Premier League" : cfg.league;

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
