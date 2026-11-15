// V4 Predictor — True V2 Strict 3-Snipe System.
//
// The rule tree (Snipes + Locks) is pure and deterministic. Two of the Locks
// consult expected goals when — and only when — the Engine's xG math strongly
// supports a change from the flat V2 default:
//
//   · Chaos Rule     — a Chaos side only gets the 2-1 / 1-2 win line when the
//                      xG edge says it is the better team (never 2-2).
//   · Standard Lock  — standard-vs-standard matches move to a blowout or a 2-2
//                      only when xG clears the documented thresholds.
//
// The third fix (Top 4 Derby) was measured and reverted: see Rule 2 below.
//
// `generateV2Predictions` stays synchronous and engine-free; callers hand it an
// optional `xg` resolver (see `createMatchXgResolver`) when they can build one.

import {
  buildAttackDefenceTable,
  computeMatchExpectedGoals,
  type AttackDefenceTable,
} from "./data/attackDefence";
import type { HistoricalMatch } from "./data/historical";

export const TOP_4 = ["Arsenal", "Liverpool", "Man City", "Brighton"];
export const MID_TABLE = ["Fulham", "Brentford", "Everton", "Leeds", "Crystal Palace", "Newcastle", "Aston Villa"];
export const BOTTOM_5 = ["Coventry", "Ipswich", "Hull", "Sunderland", "Burnley"];
export const CHAOS_TEAMS = ["Chelsea", "Man Utd", "Spurs"];

export const TEAM_NAME_MAP: Record<string, string> = {
  "Manchester City": "Man City",
  "Manchester United": "Man Utd",
  "Man United": "Man Utd",
  "Tottenham Hotspur": "Spurs",
  "Tottenham": "Spurs",
  "Brighton & Hove Albion": "Brighton",
  "Newcastle United": "Newcastle",
  "Nottingham Forest": "Nott'm Forest",
  "Leeds United": "Leeds",
  "Coventry City": "Coventry",
  "Hull City": "Hull",
  "Ipswich Town": "Ipswich",
  "AFC Bournemouth": "Bournemouth",
  "Wolverhampton Wanderers": "Wolves",
  "West Ham United": "West Ham",
  "Leicester City": "Leicester",
};

export function translateTeamName(espnName: string): string {
  const trimmed = espnName.trim();
  if (TEAM_NAME_MAP[trimmed]) return TEAM_NAME_MAP[trimmed];
  const stripped = trimmed
    .replace(/^AFC\s+/i, "")
    .replace(/\s+(?:AFC|FC)$/i, "")
    .trim();
  return TEAM_NAME_MAP[stripped] || stripped;
}

export type V2FixtureInput = [string, string] | { home: string; away: string };

export type Fixture = {
  home: string;
  away: string;
  prediction?: string | null;
  category?: string | null;
  targetPts?: number | null;
};

export type Actual = [number, number];
export type Prediction = {
  Match: string;
  Category: string;
  Prediction: string;
  Target_Pts: number;
};
export type ScoredPrediction = {
  Match: string;
  Prediction: string;
  Actual: string;
  Points: number;
  Status: string;
  MissReason: string;
};

const MAX_SNIPES = 3;

// ─── xG thresholds (V2 fix) ───────────────────────────────────────────────────
//
// Every threshold below is a *guard*: below it, the flat V2 rule is kept. These
// values were fitted by replaying MW1–MW10 of the 2026-27 season against the
// Engine's attack/defence model and keeping the tightest gate that preserves
// the MW5 (100), MW7 (100) and MW10 (90+) guardrails.

/** xG edge a Chaos side needs before 1-1 becomes 2-1 (home) / 1-2 (away). */
export const CHAOS_XG_EDGE = 0.55;
/**
 * The xG edge a visiting Top 4 side needed to flip a Top 4 Derby to 1-2.
 *
 * NOT APPLIED — the Step 2 derby flip is reverted (see Rule 2 in
 * `generateV2Predictions`). Kept, documented, so the rejected design and its
 * measurement are not silently lost and the idea can be retried only when the
 * model demonstrably separates the two sides.
 */
export const TOP4_DERBY_MIN_XG_EDGE = 0.4;
/** xG gap that turns a Standard match into a 3-0 / 4-0 / 0-3 / 0-4 blowout. */
export const STANDARD_BLOWOUT_GAP = 1.2;
/** Per-side xG floor for the high-scoring Standard draw (2-2). */
export const STANDARD_DRAW_XG = 1.8;

export type XgPair = readonly [homeXg: number, awayXg: number];

/**
 * Optional expected-goals lookup handed to `generateV2Predictions`.
 * Index-aligned with the fixture list, or `null` when no model is available —
 * in which case every xG-aware rule falls back to its flat V2 default.
 */
export type MatchXgResolver = (index: number, home: string, away: string) => XgPair | null;

/** Accepts only well-formed scorelines like "2-1"; anything else is ignored. */
export function isScoreline(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,2}-\d{1,2}$/.test(value);
}

/** Return the outcome implied by a prediction scoreline. */
export function getScorelineOutcome(prediction: string): "H" | "D" | "A" {
  const [h, a] = prediction.split("-").map(Number);
  if (h > a) return "H";
  if (h < a) return "A";
  return "D";
}

function normalizeFixturePair(fixture: V2FixtureInput): [string, string] {
  if (Array.isArray(fixture)) {
    return [translateTeamName(fixture[0]), translateTeamName(fixture[1])];
  }
  return [translateTeamName(fixture.home), translateTeamName(fixture.away)];
}

/**
 * Exact V2 Strict 3-Snipe System.
 *
 * 1. Counters: `fortressUsed`, `deadlocksUsed`, `eliteAwayUsed`. Max 3 Snipes total.
 * 2. Snipes (20-Point Targets):
 *    - Chaos teams are PERMANENTLY BANNED from Snipes.
 *    - Snipe 1: Top 4 (Home) vs Bottom 5 -> 2-0 (Max 1).
 *    - Snipe 2 & 3: Mid (Home) vs Mid -> 1-1 (Max 2).
 *    - Snipe 3 Alternative: If there are not 2 Mid-Table Deadlocks, Top 4 (Away) -> 0-1.
 * 3. Locks (10-Point Targets):
 *    - Rule 1 (Chaos): 2-1 (if Top 4 Home), 1-2 (if Top 4 Away), 1-1 (if no Top 4). NEVER 2-2.
 *      xG fix: against a non-Top-4 opponent a Chaos side only takes its win line
 *      when it is clearly the better side by xG (CHAOS_XG_EDGE); two Chaos sides
 *      always cancel out to 1-1. Fallback when no model is available: 1-1.
 *    - Rule 2 (Smart Top 4 Home): Top 4 at Home (not vs Bottom 5) -> 2-0,
 *      Top 4 Derby included. The xG derby flip is deliberately NOT applied.
 *    - Rule 3 (Mid vs Bottom): Mid at Home vs Bottom 5 -> 2-1.
 *    - Rule 4 (Standard Default): Any other match -> 1-0 (Home) or 0-1 (Away).
 *      xG fix: standard-vs-standard matches take a blowout or a 2-2 draw only
 *      when the xG math clears STANDARD_BLOWOUT_GAP / STANDARD_DRAW_XG.
 */
export function generateV2Predictions(
  fixtures: readonly V2FixtureInput[],
  xg?: MatchXgResolver | null,
): Prediction[] {
  const pairs = fixtures.map(normalizeFixturePair);
  const picks: Array<Prediction | null> = new Array(pairs.length).fill(null);

  /** Resolve xG for one fixture, normalised to a pair of finite numbers. */
  const resolveXg = (index: number, home: string, away: string): XgPair | null => {
    if (!xg) return null;
    let pair: XgPair | null;
    try {
      pair = xg(index, home, away);
    } catch {
      return null;
    }
    if (!pair) return null;
    const [homeXg, awayXg] = pair;
    if (!Number.isFinite(homeXg) || !Number.isFinite(awayXg)) return null;
    return [homeXg, awayXg];
  };

  let fortressUsed = 0;
  let deadlocksUsed = 0;
  let eliteAwayUsed = 0;
  const totalSnipes = () => fortressUsed + deadlocksUsed + eliteAwayUsed;

  // Snipe 1: Top 4 (Home) vs Bottom 5 -> 2-0 (Max 1)
  for (let i = 0; i < pairs.length; i += 1) {
    const [home, away] = pairs[i];
    if (CHAOS_TEAMS.includes(home) || CHAOS_TEAMS.includes(away)) continue;
    if (TOP_4.includes(home) && BOTTOM_5.includes(away) && fortressUsed < 1 && totalSnipes() < MAX_SNIPES) {
      fortressUsed += 1;
      picks[i] = {
        Match: `${home} vs ${away}`,
        Category: "SNIPE: Home Fortress",
        Prediction: "2-0",
        Target_Pts: 20,
      };
    }
  }

  // Snipe 2 & 3: Mid (Home) vs Mid -> 1-1 (Max 2)
  for (let i = 0; i < pairs.length; i += 1) {
    if (picks[i] !== null) continue;
    const [home, away] = pairs[i];
    if (CHAOS_TEAMS.includes(home) || CHAOS_TEAMS.includes(away)) continue;
    if (MID_TABLE.includes(home) && MID_TABLE.includes(away) && deadlocksUsed < 2 && totalSnipes() < MAX_SNIPES) {
      deadlocksUsed += 1;
      picks[i] = {
        Match: `${home} vs ${away}`,
        Category: "SNIPE: Mid-Table Deadlock",
        Prediction: "1-1",
        Target_Pts: 20,
      };
    }
  }

  // Snipe 3 Alternative: If there are not 2 Mid-Table Deadlocks, Top 4 (Away) -> 0-1
  if (deadlocksUsed < 2) {
    for (let i = 0; i < pairs.length; i += 1) {
      if (picks[i] !== null) continue;
      const [home, away] = pairs[i];
      if (CHAOS_TEAMS.includes(home) || CHAOS_TEAMS.includes(away)) continue;
      if (!TOP_4.includes(home) && TOP_4.includes(away) && totalSnipes() < MAX_SNIPES) {
        eliteAwayUsed += 1;
        picks[i] = {
          Match: `${home} vs ${away}`,
          Category: "SNIPE: Elite Away",
          Prediction: "0-1",
          Target_Pts: 20,
        };
      }
    }
  }

  // Locks (10-Point Targets)
  return pairs.map(([home, away], i) => {
    if (picks[i] !== null) return picks[i]!;

    const homeIsTop4 = TOP_4.includes(home);
    const awayIsTop4 = TOP_4.includes(away);
    const homeIsMid = MID_TABLE.includes(home);
    const awayIsMid = MID_TABLE.includes(away);
    const homeIsBottom5 = BOTTOM_5.includes(home);
    const awayIsBottom5 = BOTTOM_5.includes(away);
    const homeIsChaos = CHAOS_TEAMS.includes(home);
    const awayIsChaos = CHAOS_TEAMS.includes(away);
    const homeIsStandard = !homeIsTop4 && !homeIsMid && !homeIsBottom5 && !homeIsChaos;
    const awayIsStandard = !awayIsTop4 && !awayIsMid && !awayIsBottom5 && !awayIsChaos;

    // Rule 1 (Chaos): 2-1 (if Top 4 Home), 1-2 (if Top 4 Away), 1-1 (if no Top 4). NEVER 2-2.
    //
    // The xG fix: a Chaos side at home against an ordinary opponent used to be
    // locked to a 1-1 draw even when it was the clearly better team (MW2:
    // Chelsea 4-3 Brighton, Man Utd 5-2 Ipswich). It now takes the 2-1 (home) /
    // 1-2 (away) win line, but only when its xG edge clears CHAOS_XG_EDGE — so
    // the draw is still the default for a genuine coin-flip (MW5: Fulham 1-1
    // Man Utd). Two Chaos sides always cancel out to 1-1, and 2-2 stays banned.
    if (homeIsChaos || awayIsChaos) {
      if (homeIsChaos && awayIsChaos) {
        return {
          Match: `${home} vs ${away}`,
          Category: "LOCK: Chaos Rule",
          Prediction: "1-1",
          Target_Pts: 10,
        };
      }
      if (homeIsTop4) {
        return {
          Match: `${home} vs ${away}`,
          Category: "LOCK: Chaos Rule",
          Prediction: "2-1",
          Target_Pts: 10,
        };
      }
      if (awayIsTop4) {
        return {
          Match: `${home} vs ${away}`,
          Category: "LOCK: Chaos Rule",
          Prediction: "1-2",
          Target_Pts: 10,
        };
      }
      const edge = resolveXg(i, home, away);
      const chaosEdge = edge === null ? null : homeIsChaos ? edge[0] - edge[1] : edge[1] - edge[0];
      const chaosWinner = chaosEdge !== null && chaosEdge >= CHAOS_XG_EDGE;
      return {
        Match: `${home} vs ${away}`,
        Category: "LOCK: Chaos Rule",
        Prediction: chaosWinner ? (homeIsChaos ? "2-1" : "1-2") : "1-1",
        Target_Pts: 10,
      };
    }

    // Rule 2 (Smart Top 4 Home): Top 4 at Home -> 2-0 — including in a Top 4 Derby.
    //
    // The Step 2 xG fix (flip the derby to 1-2 when the away side clears an xG
    // edge) was implemented, measured and REVERTED: over the MW1–MW10 replay it
    // costs MW5 exactly 10 points (the model's 0.91 vs 1.65 xG for Brighton–
    // Arsenal flips a correct 2-0 into a wrong 1-2, taking the week from 100 to
    // 90) while adding nothing to MW9, because the model rates *Man City* as the
    // stronger side in City 0-1 Brighton (2.65 vs 1.15) and Liverpool–Arsenal is
    // only a 0.18 edge. The MW9 miss is variance the xG cannot see, not a bug
    // the rule can fix — see TOP4_DERBY_MIN_XG_EDGE.
    if (homeIsTop4) {
      return {
        Match: `${home} vs ${away}`,
        Category: "LOCK: Smart Top 4 Home",
        Prediction: "2-0",
        Target_Pts: 10,
      };
    }

    // Rule 3 (Mid vs Bottom): Mid at Home vs Bottom 5 -> 2-1.
    if (homeIsMid && awayIsBottom5) {
      return {
        Match: `${home} vs ${away}`,
        Category: "LOCK: Mid vs Bottom",
        Prediction: "2-1",
        Target_Pts: 10,
      };
    }

    // Rule 4 (Standard Default): Any other match -> 1-0 (Home) or 0-1 (Away).
    const awayIsStronger =
      awayIsTop4 ||
      (homeIsBottom5 && awayIsMid) ||
      (homeIsStandard && awayIsMid) ||
      (homeIsBottom5 && awayIsStandard);

    // The xG fix: standard-vs-standard matches (no Top 4, no Bottom 5, no Mid,
    // no Chaos) used to be pinned to 1-0 / 0-1 even when the model expected a
    // rout (MW4: Bournemouth 2-2 Brentford, Aston Villa 1-2 Nott'm Forest).
    // The flat pick is kept unless xG clears one of the documented thresholds.
    if (homeIsStandard && awayIsStandard) {
      const standard = resolveXg(i, home, away);
      if (standard !== null) {
        const [homeXg, awayXg] = standard;
        if (homeXg - awayXg >= STANDARD_BLOWOUT_GAP) {
          return {
            Match: `${home} vs ${away}`,
            Category: "LOCK: Standard Blowout",
            Prediction: `${blowoutGoals(homeXg)}-0`,
            Target_Pts: 10,
          };
        }
        if (awayXg - homeXg >= STANDARD_BLOWOUT_GAP) {
          return {
            Match: `${home} vs ${away}`,
            Category: "LOCK: Standard Blowout",
            Prediction: `0-${blowoutGoals(awayXg)}`,
            Target_Pts: 10,
          };
        }
        if (homeXg >= STANDARD_DRAW_XG && awayXg >= STANDARD_DRAW_XG) {
          return {
            Match: `${home} vs ${away}`,
            Category: "LOCK: Standard Draw",
            Prediction: "2-2",
            Target_Pts: 10,
          };
        }
      }
    }

    if (awayIsStronger) {
      return {
        Match: `${home} vs ${away}`,
        Category: "LOCK: Standard Away",
        Prediction: "0-1",
        Target_Pts: 10,
      };
    }

    return {
      Match: `${home} vs ${away}`,
      Category: "LOCK: Standard Home",
      Prediction: "1-0",
      Target_Pts: 10,
    };
  });
}

/**
 * Round a blowout margin to a legal scoreline: `3` for anything up to 3.5 xG,
 * `4` from 3.5 upward (and no further — V2 never predicts 5+ goals).
 */
export function blowoutGoals(xg: number): number {
  if (!Number.isFinite(xg)) return 3;
  return Math.min(4, Math.max(3, Math.round(xg)));
}

export const generatePredictions = generateV2Predictions;

// ─── Engine xG wiring ────────────────────────────────────────────────────────

/** Minimal shape of one completed match, as the history loaders return it. */
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
}

/** True when the Lock for this fixture consults xG. */
function fixtureReadsXg(home: string, away: string): boolean {
  const homeIsChaos = CHAOS_TEAMS.includes(home);
  const awayIsChaos = CHAOS_TEAMS.includes(away);
  if (homeIsChaos || awayIsChaos) {
    if (homeIsChaos && awayIsChaos) return false;
    if (TOP_4.includes(home) || TOP_4.includes(away)) return false;
    return true;
  }
  if (TOP_4.includes(home)) return false;
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
  const { history, leagueSlug = "eng.1", onlyRelevant = true } = options;
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
      return [homeExpectedGoals, awayExpectedGoals];
    } catch {
      return null;
    }
  };
}

/**
 * Project route rows into the table's `Prediction` shape, falling back to
 * `generateV2Predictions` when the row carries only team names.
 */
export function buildPredictions(fixtures: Fixture[]): Prediction[] {
  const computed = generateV2Predictions(
    fixtures.map(({ home, away }) => ({ home, away })),
  );
  return fixtures.map((row, index) => {
    const v2 = computed[index];
    const resolved = isScoreline(row.prediction) ? row.prediction : v2.Prediction;
    const label =
      typeof row.category === "string" && row.category.trim() !== ""
        ? row.category.trim()
        : v2.Category;
    const targetPts =
      typeof row.targetPts === "number" && Number.isFinite(row.targetPts) && row.targetPts > 0
        ? row.targetPts
        : label.startsWith("SNIPE:")
          ? 20
          : 10;
    return {
      Match: v2.Match,
      Category: label,
      Prediction: resolved,
      Target_Pts: targetPts,
    };
  });
}

export function calculateScore(
  predictions: Prediction[],
  actuals: Actual[],
): [ScoredPrediction[], number] {
  let total = 0;
  const scored = predictions.map((row, index) => {
    const [predH, predA] = row.Prediction.split("-").map(Number);
    const [actH, actA] = actuals[index];
    const predOutcome = predH > predA ? "H" : predH < predA ? "A" : "D";
    const actOutcome = actH > actA ? "H" : actH < actA ? "A" : "D";
    let points: number;
    let status: string;
    if (predH === actH && predA === actA) [points, status] = [20, "🎯 EXACT (20 pts)"];
    else if (predOutcome === actOutcome) [points, status] = [10, "✅ OUTCOME (10 pts)"];
    else [points, status] = [0, "❌ MISSED (0 pts)"];
    total += points;
    const missReason =
      !isScoreline(row.Prediction)
        ? "—"
        : points === 0
          ? "❌ MISS: Wrong Outcome"
          : points === 10
            ? "❌ MISS: Wrong Score"
            : "—";
    return {
      Match: row.Match,
      Prediction: row.Prediction,
      Actual: `${actH}-${actA}`,
      Points: points,
      Status: status,
      MissReason: missReason,
    };
  });
  return [scored, total];
}
