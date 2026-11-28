// V4 Predictor — Server-only xG resolver. Do not import from client components.
import {
  buildAttackDefenceTable,
  computeMatchExpectedGoals,
  type AttackDefenceTable,
} from "./data/attackDefence";
import type { HistoricalMatch } from "./data/historical";
import {
  CHAOS_TEAMS,
  TOP_4,
  MID_TABLE,
  BOTTOM_5,
  translateTeamName,
  type MatchXgResolver,
  type FormResolver,
  type TeamForm,
} from "./v4-predictor";

export type { FormResolver, TeamForm };

export interface XgHistoryMatch {
  homeTeam: string;
  awayTeam: string;
  matchDate: string;
  homeGoals: number;
  awayGoals: number;
  leagueSlug?: string | null;
  /** Real home xG, when the source provides it (Football-Data `HxG`). */
  homeXg?: number | null;
  /** Real away xG (Football-Data `AxG`). */
  awayXg?: number | null;
}

export interface MatchXgResolverOptions {
  /** Completed matches available *before* the slate kicks off. */
  history: readonly XgHistoryMatch[];
  leagueSlug?: string;
  /**
   * Only hand xG to the fixtures whose rule actually reads it. Defaults to
   * `true`; `fixtureReadsXg` mirrors the rule tree exactly, including Mid-vs-Mid
   * (Rule 3b and the Deadlock gap check), which the earlier predicate wrongly
   * excluded and which silently disabled Rule 3b at the default.
   */
  onlyRelevant?: boolean;
  /**
   * Exponential half-life in days for match weighting. `null`/omitted keeps the
   * historical behaviour (every match weight 1.0).
   *
   * This is the time-decay fix: with no half-life a 2022-23 result carries the
   * same weight as last week's, so 150 old matches drown out the current season.
   * Measured against `now`, which callers MUST set to the slate's first kickoff.
   */
  halfLifeDays?: number | null;
  /** Reference date for the decay. Defaults to `new Date()`. */
  now?: Date | string;
  /**
   * Weight `[0,1]` on *real* rolling xG when it is available, blended with the
   * goals-based attack/defence lambda.
   *
   * This is what makes the Lock tree read `HxG`/`AxG`: the attack/defence model
   * is fitted on goals, so a club that creates 2.5 xG and scores 0.5 looks
   * ordinary to it. With a weight of 0 the lambda is pure attack/defence
   * (legacy); at 1 it is pure rolling xG. Defaults to 0.
   */
  xgLambdaWeight?: number;
}

/** A completed match that may carry real xG (per-match expected goals). */
export interface XgResultRow {
  homeTeam: string;
  awayTeam: string;
  matchDate: string;
  homeGoals: number;
  awayGoals: number;
  /** Real home xG, when the source provides it (Football-Data `HxG`). */
  homeXg?: number | null;
  /** Real away xG (Football-Data `AxG`). */
  awayXg?: number | null;
}

export interface FormBuilderOptions {
  /** Matches strictly before the slate; most recent last. */
  history: readonly XgResultRow[];
  /** How many matches per side to look back over (the "last 5 matchweeks" default). */
  window: number;
}

/**
 * Build the rolling form table used by Slump Detection and the Dynamic Tier
 * modifier. Pure and synchronous, so the backtest can rebuild it per fixture.
 *
 * xG is taken from the row when present and ignored otherwise, so a side whose
 * recent matches predate the xG columns still gets a points/winless reading.
 * `xgFor`/`xgAgainst` stay `null` until at least one windowed match has real xG.
 */
export function buildFormTable(options: FormBuilderOptions): Map<string, TeamForm> {
  const window = Math.max(1, Math.floor(options.window));
  type Entry = { date: string; gf: number; ga: number; xgf: number | null; xga: number | null };
  const per = new Map<string, Entry[]>();

  for (const row of options.history) {
    const home = translateTeamName(row.homeTeam);
    const away = translateTeamName(row.awayTeam);
    const date = row.matchDate.slice(0, 10);
    const hx = typeof row.homeXg === "number" && Number.isFinite(row.homeXg) ? row.homeXg : null;
    const ax = typeof row.awayXg === "number" && Number.isFinite(row.awayXg) ? row.awayXg : null;
    if (!per.has(home)) per.set(home, []);
    if (!per.has(away)) per.set(away, []);
    per.get(home)!.push({ date, gf: row.homeGoals, ga: row.awayGoals, xgf: hx, xga: ax });
    per.get(away)!.push({ date, gf: row.awayGoals, ga: row.homeGoals, xgf: ax, xga: hx });
  }

  const table = new Map<string, TeamForm>();
  for (const [team, entries] of per) {
    entries.sort((a, b) => a.date.localeCompare(b.date));
    const last = entries.slice(-window);
    const recent = [...last].reverse().map((e) => (e.gf > e.ga ? "W" : e.gf === e.ga ? "D" : "L"));
    let winless = 0;
    for (const r of recent) {
      if (r === "W") break;
      winless += 1;
    }
    const points = last.reduce((sum, e) => sum + (e.gf > e.ga ? 3 : e.gf === e.ga ? 1 : 0), 0);
    const withXg = last.filter((e) => e.xgf !== null && e.xga !== null);
    table.set(team, {
      n: last.length,
      points,
      ppg: last.length ? points / last.length : 0,
      recent,
      winless,
      xgFor: withXg.length ? withXg.reduce((s, e) => s + (e.xgf as number), 0) / withXg.length : null,
      xgAgainst: withXg.length ? withXg.reduce((s, e) => s + (e.xga as number), 0) / withXg.length : null,
      xgSamples: withXg.length,
      lastDate: last.length ? last[last.length - 1].date : null,
    });
  }
  return table;
}

/** Wrap a form table as the index-aligned resolver `generateV2Predictions` expects. */
export function formResolverFrom(table: Map<string, TeamForm>): FormResolver {
  return (_index, team) => table.get(team) ?? null;
}

/** True when the Lock for this fixture consults xG. */
function fixtureReadsXg(home: string, away: string): boolean {
  const homeIsChaos = CHAOS_TEAMS.includes(home);
  const awayIsChaos = CHAOS_TEAMS.includes(away);
  if (homeIsChaos || awayIsChaos) {
    // Chaos vs Chaos reads xG too: the 1-1 stands only while the gap between
    // the two sides stays under CHAOS_DRAW_MAX_XG_GAP.
    if (TOP_4.includes(home) || TOP_4.includes(away)) return false;
    return true;
  }
  // A Top 4 host only reads xG in a Top 4 Derby — that is the one case where
  // the flat 2-0 lock can be dropped.
  if (TOP_4.includes(home)) return TOP_4.includes(away);
  const homeIsStandard =
    !TOP_4.includes(home) && !MID_TABLE.includes(home) && !BOTTOM_5.includes(home);
  const awayIsStandard =
    !TOP_4.includes(away) && !MID_TABLE.includes(away) && !BOTTOM_5.includes(away);
  return homeIsStandard && awayIsStandard;
}

/**
 * Build a `MatchXgResolver` from the Engine's Maher-style attack/defence model.
 *
 * The model is the same one the Engine uses for its λ: per-team, venue-split
 * attack and defence strengths shrunk toward the league baseline, multiplied
 * out into home/away expected goals (`computeMatchExpectedGoals`). Team names
 * are translated through `translateTeamName` on *both* sides of every lookup so
 * the short V2 names ("Man Utd", "Spurs") resolve against the long feed names
 * ("Manchester United", "Tottenham Hotspur").
 *
 * Returns `null` when there is no usable history — the caller then runs the
 * flat V2 tree, which is the documented fallback.
 */
export function createMatchXgResolver(
  options: MatchXgResolverOptions,
): MatchXgResolver | null {
  const {
    history,
    leagueSlug = "eng.1",
    onlyRelevant = true,
    halfLifeDays = null,
    xgLambdaWeight = 0,
  } = options;
  if (!history.length) return null;
  const now = options.now === undefined ? new Date() : options.now instanceof Date ? options.now : new Date(options.now);
  const decay =
    halfLifeDays === null || !Number.isFinite(halfLifeDays) || halfLifeDays <= 0
      ? {}
      : { halfLifeDays, now };

  const matches: HistoricalMatch[] = history.map((match, index) => ({
    id: `${leagueSlug}|${match.homeTeam}|${match.awayTeam}|${match.matchDate}|${index}`,
    homeTeam: translateTeamName(match.homeTeam),
    awayTeam: translateTeamName(match.awayTeam),
    leagueSlug: match.leagueSlug ?? leagueSlug,
    matchDate: match.matchDate,
    homeGoals: match.homeGoals,
    awayGoals: match.awayGoals,
    competitionName: null,
    source: "github-datasets",
  }));

  let table: AttackDefenceTable;
  try {
    table = buildAttackDefenceTable(matches, leagueSlug, decay);
  } catch {
    return null;
  }

  // Rolling real-xG rate per side, from the rows that carry xG. Used only when
  // `xgLambdaWeight > 0`; otherwise the attack/defence lambda is returned as-is.
  const xgWeight = Math.max(0, Math.min(1, xgLambdaWeight));
  const xgRates = new Map<string, { for: number; against: number; n: number }>();
  if (xgWeight > 0) {
    for (const row of history) {
      const hx = typeof row.homeXg === "number" && Number.isFinite(row.homeXg) ? row.homeXg : null;
      const ax = typeof row.awayXg === "number" && Number.isFinite(row.awayXg) ? row.awayXg : null;
      if (hx === null || ax === null) continue;
      const home = translateTeamName(row.homeTeam);
      const away = translateTeamName(row.awayTeam);
      const bump = (team: string, xf: number, xa: number) => {
        const cur = xgRates.get(team) ?? { for: 0, against: 0, n: 0 };
        cur.for += xf;
        cur.against += xa;
        cur.n += 1;
        xgRates.set(team, cur);
      };
      bump(home, hx, ax);
      bump(away, ax, hx);
    }
  }

  return (_index, home, away) => {
    if (onlyRelevant && !fixtureReadsXg(home, away)) return null;
    try {
      const { homeExpectedGoals, awayExpectedGoals } = computeMatchExpectedGoals({
        homeTeam: home,
        awayTeam: away,
        table,
        applyElo: false,
      });
      if (!Number.isFinite(homeExpectedGoals) || !Number.isFinite(awayExpectedGoals)) {
        return null;
      }
      if (xgWeight === 0) return [homeExpectedGoals, awayExpectedGoals];

      // Real rolling xG vs the goals-based lambda. A side with no xG rows keeps
      // the model figure, so the blend degrades to legacy rather than to zero.
      const homeRate = xgRates.get(translateTeamName(home));
      const awayRate = xgRates.get(translateTeamName(away));
      const blend = (model: number, rate: { against: number; n: number } | undefined) =>
        rate && rate.n > 0 ? (1 - xgWeight) * model + xgWeight * (rate.against / rate.n) : model;
      return [blend(homeExpectedGoals, homeRate), blend(awayExpectedGoals, awayRate)];
    } catch {
      return null;
    }
  };
}
