// V4 Predictor — Server-only xG resolver. Do not import from client components.
import {
  buildAttackDefenceTable,
  computeMatchExpectedGoals,
  type AttackDefenceTable,
} from "./data/attackDefence";
import type { HistoricalMatch } from "./data/historical";
import {
  PRESEASON_TIERS,
  translateTeamName,
  type DynamicTiers,
  type MatchXgResolver,
} from "./v4-predictor";

export interface XgHistoryMatch {
  homeTeam: string;
  awayTeam: string;
  matchDate: string;
  homeGoals: number;
  awayGoals: number;
  leagueSlug?: string | null;
}

export interface MatchXgResolverOptions {
  /** Completed matches available *before* the slate kicks off. */
  history: readonly XgHistoryMatch[];
  leagueSlug?: string;
  /**
   * Only hand xG to the fixtures whose rule actually reads it (Chaos, Top 4
   * Derby, Standard-vs-Standard). Defaults to true so a large slate does not
   * pay for xG it never uses.
   */
  onlyRelevant?: boolean;
  /**
   * The tiers the slate is predicted with; only read by `onlyRelevant`.
   * Defaults to the fixed lists, like `generateV2Predictions`.
   */
  tiers?: DynamicTiers;
}

/** True when the Lock for this fixture consults xG. */
function fixtureReadsXg(home: string, away: string, tiers: DynamicTiers): boolean {
  const { top4, midTable, bottom5, chaos } = tiers;
  const homeIsChaos = chaos.includes(home);
  const awayIsChaos = chaos.includes(away);
  if (homeIsChaos || awayIsChaos) {
    // Chaos vs Chaos reads xG too: the 1-1 stands only while the gap between
    // the two sides stays under CHAOS_DRAW_MAX_XG_GAP.
    if (top4.includes(home) || top4.includes(away)) return false;
    return true;
  }
  // A Top 4 host only reads xG in a Top 4 Derby — that is the one case where
  // the flat 2-0 lock can be dropped.
  if (top4.includes(home)) return top4.includes(away);
  const homeIsStandard =
    !top4.includes(home) && !midTable.includes(home) && !bottom5.includes(home);
  const awayIsStandard =
    !top4.includes(away) && !midTable.includes(away) && !bottom5.includes(away);
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
  const { history, leagueSlug = "eng.1", onlyRelevant = true, tiers = PRESEASON_TIERS } = options;
  if (!history.length) return null;

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
    table = buildAttackDefenceTable(matches, leagueSlug, {});
  } catch {
    return null;
  }

  return (_index, home, away) => {
    if (onlyRelevant && !fixtureReadsXg(home, away, tiers)) return null;
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
      return [homeExpectedGoals, awayExpectedGoals];
    } catch {
      return null;
    }
  };
}
