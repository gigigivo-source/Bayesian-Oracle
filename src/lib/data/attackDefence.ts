// ĞIGI GIVØ — Attack / defence strength parameters (Maher-style goal model).
//
// Each team is reduced to four venue-specific strengths, all expressed relative
// to the league's own scoring baseline:
//
//   attack_home   = avg goals scored at home   ÷ leagueAverageHome
//   defence_home  = avg goals conceded at home ÷ leagueAverageAway
//   attack_away   = avg goals scored away      ÷ leagueAverageAway
//   defence_away  = avg goals conceded away    ÷ leagueAverageHome
//
// so that a strength of 1.0 means exactly league average. Expected goals then
// follow the specified formula:
//
//   homeExpectedGoals = attack_home × defence_away × leagueAverageHome
//   awayExpectedGoals = attack_away × defence_home × leagueAverageAway
//
// Substituting the definitions collapses these to the familiar Maher form
// `homeScored × awayConceded ÷ leagueAverageHome`, which is why defence_home is
// normalised against the *away* scoring baseline (those goals were scored by
// away attacks) and defence_away against the *home* one.
//
// Two-level Bayesian shrinkage keeps small samples honest: a venue split is
// shrunk toward the team's overall rate, and the overall rate toward the league
// average. A team with no history therefore scores exactly league average
// instead of dividing by zero or being treated as infinitely strong/weak.

import {
  aggregateTeamStats,
  matchWeight,
  normaliseTeamName,
  teamsMatch,
  DEFAULT_HALF_LIFE_DAYS,
  type DecayOptions,
  type HistoricalMatch,
  type TeamAggregate,
} from "./historical";
import { eloLambdaMultipliers } from "./elo";

// ─── Configuration ────────────────────────────────────────────────────────────

/** Pseudo-matches of league-average scoring added to a team's overall totals. */
export const PRIOR_OVERALL_MATCHES = 6;
/** Pseudo-matches of the team's own overall rate added to each venue split. */
export const PRIOR_VENUE_MATCHES = 4;

/** Expected goals are clamped to this range before they reach the Poisson layer. */
export const MIN_EXPECTED_GOALS = 0.05;
export const MAX_EXPECTED_GOALS = 6.5;

/** League scoring baseline used when a dataset is too thin to measure one. */
export const FALLBACK_LEAGUE_AVERAGES = { home: 1.5, away: 1.22 };

/** Weight of the structural model when the legacy composite carries real xG. */
export const STRUCTURAL_MODEL_WEIGHT = 0.6;
/** Weight when the legacy composite only has season averages and form. */
export const STRUCTURAL_WEIGHT_WITHOUT_XG = 0.8;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LeagueGoalAverages {
  leagueSlug: string | null;
  matches: number;
  /** Mean goals scored by the home side per match. */
  leagueAverageHome: number;
  /** Mean goals scored by the away side per match. */
  leagueAverageAway: number;
  leagueAverageTotal: number;
  /** True when no match data was available and the fallback baseline is used. */
  fallback: boolean;
}

export interface TeamAttackDefence {
  team: string;
  key: string;
  leagueSlug: string;
  matchesPlayed: number;
  homeMatches: number;
  awayMatches: number;
  attackHome: number;
  defenceHome: number;
  attackAway: number;
  defenceAway: number;
  /** Venue-agnostic strength, kept for diagnostics and for thin venue splits. */
  attack: number;
  defence: number;
  avgGoalsScoredHome: number;
  avgGoalsConcededHome: number;
  avgGoalsScoredAway: number;
  avgGoalsConcededAway: number;
}

export interface AttackDefenceTable {
  leagueSlug: string | null;
  league: LeagueGoalAverages;
  teams: Map<string, TeamAttackDefence>;
  matchesProcessed: number;
}

export interface ExpectedGoalsComponents {
  attackHome: number;
  defenceAway: number;
  attackAway: number;
  defenceHome: number;
  leagueAverageHome: number;
  leagueAverageAway: number;
  /** Structural λ before the ELO multipliers are applied. */
  structuralHome: number;
  structuralAway: number;
  eloMultiplierHome: number;
  eloMultiplierAway: number;
  eloDelta: number;
  eloApplied: boolean;
  /** Where each side's attacking figure came from. */
  homeAttackSource: AttackSource;
  awayAttackSource: AttackSource;
}

export type AttackSource = "venue" | "overall" | "league";

export interface MatchExpectedGoals {
  homeExpectedGoals: number;
  awayExpectedGoals: number;
  components: ExpectedGoalsComponents;
}

export interface MatchExpectedGoalsInput {
  homeTeam: string;
  awayTeam: string;
  table: AttackDefenceTable;
  /** Current ELO ratings; omit either to skip the ELO adjustment. */
  eloHome?: number | null;
  eloAway?: number | null;
  applyElo?: boolean;
  /** Override `ELO_GOAL_ELASTICITY` — see `eloLambdaMultipliers`. */
  eloElasticity?: number;
}

// ─── League baseline ──────────────────────────────────────────────────────────

/** Mean home and away goals per match — the denominator of every strength. */
export function computeLeagueAverages(
  matches: HistoricalMatch[],
  leagueSlug: string | null = null,
  decay: DecayOptions = {},
): LeagueGoalAverages {
  if (!matches.length) {
    return {
      leagueSlug,
      matches: 0,
      leagueAverageHome: FALLBACK_LEAGUE_AVERAGES.home,
      leagueAverageAway: FALLBACK_LEAGUE_AVERAGES.away,
      leagueAverageTotal: FALLBACK_LEAGUE_AVERAGES.home + FALLBACK_LEAGUE_AVERAGES.away,
      fallback: true,
    };
  }
  const halfLifeDays = decay.halfLifeDays ?? null;
  const nowMs = (decay.now ?? new Date()).getTime();
  let home = 0;
  let away = 0;
  let weight = 0;
  for (const match of matches) {
    const w = matchWeight(match.matchDate, halfLifeDays, nowMs);
    home += w * match.homeGoals;
    away += w * match.awayGoals;
    weight += w;
  }
  if (weight <= 0) weight = matches.length;
  const leagueAverageHome = home / weight;
  const leagueAverageAway = away / weight;
  return {
    leagueSlug,
    matches: matches.length,
    leagueAverageHome,
    leagueAverageAway,
    leagueAverageTotal: leagueAverageHome + leagueAverageAway,
    fallback: false,
  };
}

// ─── Shrinkage ────────────────────────────────────────────────────────────────

/** Pull a raw average toward a prior: `(goals + prior × priorRate) / (n + prior)`. */
function shrink(goals: number, played: number, priorRate: number, priorMatches: number): number {
  return (goals + priorMatches * priorRate) / (played + priorMatches);
}

// ─── Table construction ───────────────────────────────────────────────────────

/**
 * Build the per-team attack/defence table from completed matches.
 *
 * Pure and synchronous, so the backtest can rebuild it from a strictly
 * pre-kickoff slice of history for every fixture it replays.
 */
export function buildAttackDefenceTable(
  matches: HistoricalMatch[],
  leagueSlug: string | null = null,
  decay: DecayOptions = {},
): AttackDefenceTable {
  const league = computeLeagueAverages(matches, leagueSlug, decay);
  const aggregates = aggregateTeamStats(matches, leagueSlug, decay);
  const teams = new Map<string, TeamAttackDefence>();

  for (const aggregate of aggregates.teams.values()) {
    teams.set(aggregate.key, toAttackDefence(aggregate, league));
  }

  return { leagueSlug, league, teams, matchesProcessed: matches.length };
}

/**
 * Convert raw goal counts into shrunk strength parameters.
 *
 * The weighted (time-decayed) totals drive the estimates, so a match from last
 * month counts for more than one from two seasons ago; the effective sample
 * size fed to the shrinkage prior is the weighted match count, which is what
 * makes the shrinkage track the amount of *recent* evidence rather than the
 * raw row count.
 */
export function toAttackDefence(aggregate: TeamAggregate, league: LeagueGoalAverages): TeamAttackDefence {
  const w = aggregate.weighted;
  // Venue-agnostic rate first, shrunk toward the league baseline.
  const overallScored = shrink(w.goalsScored, w.matches, league.leagueAverageTotal / 2, PRIOR_OVERALL_MATCHES);
  const overallConceded = shrink(w.goalsConceded, w.matches, league.leagueAverageTotal / 2, PRIOR_OVERALL_MATCHES);

  // Then each venue split, shrunk toward that team's own overall rate. With zero
  // home (or away) matches these collapse exactly to the overall figure.
  const scoredHome = shrink(w.homeGoalsScored, w.homeMatches, overallScored, PRIOR_VENUE_MATCHES);
  const concededHome = shrink(w.homeGoalsConceded, w.homeMatches, overallConceded, PRIOR_VENUE_MATCHES);
  const scoredAway = shrink(w.awayGoalsScored, w.awayMatches, overallScored, PRIOR_VENUE_MATCHES);
  const concededAway = shrink(w.awayGoalsConceded, w.awayMatches, overallConceded, PRIOR_VENUE_MATCHES);

  return {
    team: aggregate.team,
    key: aggregate.key,
    leagueSlug: aggregate.leagueSlug,
    matchesPlayed: aggregate.matchesPlayed,
    homeMatches: aggregate.homeMatches,
    awayMatches: aggregate.awayMatches,
    attackHome: scoredHome / league.leagueAverageHome,
    defenceHome: concededHome / league.leagueAverageAway,
    attackAway: scoredAway / league.leagueAverageAway,
    defenceAway: concededAway / league.leagueAverageHome,
    attack: overallScored / (league.leagueAverageTotal / 2),
    defence: overallConceded / (league.leagueAverageTotal / 2),
    avgGoalsScoredHome: scoredHome,
    avgGoalsConcededHome: concededHome,
    avgGoalsScoredAway: scoredAway,
    avgGoalsConcededAway: concededAway,
  };
}

/** Resolve a team by exact key, then by fuzzy name containment. */
export function getTeamAttackDefence(
  table: AttackDefenceTable,
  team: string,
): TeamAttackDefence | null {
  const direct = table.teams.get(normaliseTeamName(team));
  if (direct) return direct;
  for (const entry of table.teams.values()) {
    if (teamsMatch(entry.team, team)) return entry;
  }
  return null;
}

/** League-average stand-in used when a team has no history at all. */
function neutralStrengths(league: LeagueGoalAverages, team: string, leagueSlug: string): TeamAttackDefence {
  return {
    team,
    key: normaliseTeamName(team),
    leagueSlug,
    matchesPlayed: 0,
    homeMatches: 0,
    awayMatches: 0,
    attackHome: 1,
    defenceHome: 1,
    attackAway: 1,
    defenceAway: 1,
    attack: 1,
    defence: 1,
    avgGoalsScoredHome: league.leagueAverageHome,
    avgGoalsConcededHome: league.leagueAverageAway,
    avgGoalsScoredAway: league.leagueAverageAway,
    avgGoalsConcededAway: league.leagueAverageHome,
  };
}

/**
 * Expected goals for one fixture: attack/defence product, scaled by league
 * scoring, then modulated by the ELO gap when both ratings are supplied.
 */
export function computeMatchExpectedGoals(input: MatchExpectedGoalsInput): MatchExpectedGoals {
  const { table } = input;
  const league = table.league;

  const homeKnown = getTeamAttackDefence(table, input.homeTeam);
  const awayKnown = getTeamAttackDefence(table, input.awayTeam);
  const home = homeKnown ?? neutralStrengths(league, input.homeTeam, table.leagueSlug ?? "");
  const away = awayKnown ?? neutralStrengths(league, input.awayTeam, table.leagueSlug ?? "");

  const structuralHome = home.attackHome * away.defenceAway * league.leagueAverageHome;
  const structuralAway = away.attackAway * home.defenceHome * league.leagueAverageAway;

  const eloAvailable =
    input.applyElo !== false &&
    typeof input.eloHome === "number" &&
    Number.isFinite(input.eloHome) &&
    typeof input.eloAway === "number" &&
    Number.isFinite(input.eloAway);
  const multipliers = eloAvailable
    ? eloLambdaMultipliers(input.eloHome as number, input.eloAway as number, input.eloElasticity)
    : { home: 1, away: 1, eloDelta: 0 };

  return {
    homeExpectedGoals: clampExpectedGoals(structuralHome * multipliers.home),
    awayExpectedGoals: clampExpectedGoals(structuralAway * multipliers.away),
    components: {
      attackHome: home.attackHome,
      defenceAway: away.defenceAway,
      attackAway: away.attackAway,
      defenceHome: home.defenceHome,
      leagueAverageHome: league.leagueAverageHome,
      leagueAverageAway: league.leagueAverageAway,
      structuralHome,
      structuralAway,
      eloMultiplierHome: multipliers.home,
      eloMultiplierAway: multipliers.away,
      eloDelta: multipliers.eloDelta,
      eloApplied: eloAvailable,
      homeAttackSource: attackSourceOf(homeKnown, "home"),
      awayAttackSource: attackSourceOf(awayKnown, "away"),
    },
  };
}

function attackSourceOf(entry: TeamAttackDefence | null, side: "home" | "away"): AttackSource {
  if (!entry || entry.matchesPlayed === 0) return "league";
  const venueMatches = side === "home" ? entry.homeMatches : entry.awayMatches;
  return venueMatches > 0 ? "venue" : "overall";
}

export function clampExpectedGoals(value: number): number {
  if (!Number.isFinite(value)) return MIN_EXPECTED_GOALS;
  return Math.max(MIN_EXPECTED_GOALS, Math.min(MAX_EXPECTED_GOALS, value));
}

/**
 * Blend the structural (attack/defence + ELO) λ with a legacy xG-weighted λ.
 * Weights are renormalised, so passing a null legacy value returns the
 * structural figure untouched rather than dragging it toward zero.
 */
export function blendExpectedGoals(
  structural: number,
  legacy: number | null,
  structuralWeight: number = STRUCTURAL_MODEL_WEIGHT,
): number {
  if (legacy === null || !Number.isFinite(legacy)) return clampExpectedGoals(structural);
  const weight = Math.max(0, Math.min(1, structuralWeight));
  return clampExpectedGoals(weight * structural + (1 - weight) * legacy);
}

/**
 * Decay default, kept next to the parameters it affects. Dixon & Coles
 * estimate the decay jointly with the attack/defence terms; a one-year
 * half-life is their published ballpark.
 */
export const ATTACK_DEFENCE_HALF_LIFE_DAYS = DEFAULT_HALF_LIFE_DAYS;
