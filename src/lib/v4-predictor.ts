// V4 Predictor — V2 Strict 3-Snipe System; qualified Standard locks may use Engine xG.
import type { FixtureLite, MatchSummary } from "./espn";
import type { CanonicalMatchStats } from "./data/types";

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
export type V2ExpectedGoals = { homeXG: number; awayXG: number };
export type V2EngineContext = {
  fixture: FixtureLite;
  summary?: MatchSummary | null;
  stats?: CanonicalMatchStats | null;
};

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

function validExpectedGoals(value: V2ExpectedGoals | null | undefined): V2ExpectedGoals | null {
  return value && Number.isFinite(value.homeXG) && Number.isFinite(value.awayXG) &&
    value.homeXG >= 0 && value.awayXG >= 0 ? value : null;
}

function isStandardMatch(home: string, away: string): boolean {
  return !TOP_4.includes(home) && !TOP_4.includes(away) &&
    !BOTTOM_5.includes(home) && !BOTTOM_5.includes(away) &&
    !CHAOS_TEAMS.includes(home) && !CHAOS_TEAMS.includes(away) &&
    !(MID_TABLE.includes(home) && MID_TABLE.includes(away));
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
 *    - Rule 2 (Smart Top 4 Home): Top 4 at Home (not vs Bottom 5) -> 2-0.
 *    - Rule 3 (Mid vs Bottom): Mid at Home vs Bottom 5 -> 2-1.
 *    - Rule 4 (Standard): strong Engine xG overrides to 3/4-0, 0-3/4, or 2-2;
 *      otherwise keep the existing 1-0 (Home) / 0-1 (Away) lock.
 */
export function generateV2Predictions(
  fixtures: readonly V2FixtureInput[],
  xgByFixture?: ReadonlyMap<number, V2ExpectedGoals>,
): Prediction[] {
  const pairs = fixtures.map(normalizeFixturePair);
  const picks: Array<Prediction | null> = new Array(pairs.length).fill(null);

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
    if (homeIsChaos || awayIsChaos) {
      const prediction = homeIsTop4 ? "2-1" : awayIsTop4 ? "1-2" : "1-1";
      return {
        Match: `${home} vs ${away}`,
        Category: "LOCK: Chaos Rule",
        Prediction: prediction,
        Target_Pts: 10,
      };
    }

    // Rule 2 (Smart Top 4 Home): Top 4 at Home -> 2-0.
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

    // Step 3 (guardrail-safe): only non-snipe Standard locks can change. If
    // Engine xG is absent or inconclusive, preserve the original V2 score.
    if (isStandardMatch(home, away)) {
      const xg = validExpectedGoals(xgByFixture?.get(i));
      if (xg) {
        if (xg.homeXG - xg.awayXG >= 1.2) {
          const goals = Math.min(4, Math.max(3, Math.round(xg.homeXG)));
          return { Match: `${home} vs ${away}`, Category: "LOCK: Standard Home Blowout", Prediction: `${goals}-0`, Target_Pts: 10 };
        }
        if (xg.awayXG - xg.homeXG >= 1.2) {
          const goals = Math.min(4, Math.max(3, Math.round(xg.awayXG)));
          return { Match: `${home} vs ${away}`, Category: "LOCK: Standard Away Blowout", Prediction: `0-${goals}`, Target_Pts: 10 };
        }
        if (xg.homeXG >= 1.8 && xg.awayXG >= 1.8) {
          return { Match: `${home} vs ${away}`, Category: "LOCK: Standard High Draw", Prediction: "2-2", Target_Pts: 10 };
        }
      }
    }

    // Rule 4 (Standard Default): Any other match -> 1-0 (Home) or 0-1 (Away).
    const awayIsStronger =
      awayIsTop4 ||
      (homeIsBottom5 && awayIsMid) ||
      (homeIsStandard && awayIsMid) ||
      (homeIsBottom5 && awayIsStandard);

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

/** Run Engine real-lambda xG for eligible non-snipe Standard fixtures only. */
export async function generateV2PredictionsWithEngine(
  fixtures: readonly V2FixtureInput[],
  contexts: readonly (V2EngineContext | null | undefined)[],
): Promise<Prediction[]> {
  const baseline = generateV2Predictions(fixtures);
  const pairs = fixtures.map(normalizeFixturePair);
  const eligible = pairs.map(([home, away], index) => ({ home, away, index, context: contexts[index] }))
    .filter(({ home, away, index, context }) => {
      if (!context || !isStandardMatch(home, away) || baseline[index].Category.startsWith("SNIPE:")) return false;
      return translateTeamName(context.fixture.home.name) === home &&
        translateTeamName(context.fixture.away.name) === away;
    });
  if (eligible.length === 0) return baseline;
  const xgByFixture = new Map<number, V2ExpectedGoals>();
  try {
    const { buildRealLambdas } = await import("./engine/realLambdas");
    for (const { index, context } of eligible) {
      try {
        const result = buildRealLambdas(context!.fixture, context!.summary ?? null, undefined, context!.stats ?? null);
        const xg = validExpectedGoals(result.deepStats ? {
          homeXG: result.deepStats.homeXg,
          awayXG: result.deepStats.awayXg,
        } : null);
        if (xg) xgByFixture.set(index, xg);
      } catch (error) {
        console.warn(`[V2] Engine xG unavailable for ${baseline[index].Match}; keeping V2 lock`, error);
      }
    }
  } catch (error) {
    console.warn("[V2] Engine xG unavailable; keeping V2 locks", error);
    return baseline;
  }
  return generateV2Predictions(fixtures, xgByFixture);
}

export const generatePredictions = generateV2Predictions;

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
