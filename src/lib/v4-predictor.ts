// V4 Predictor — True V2 Strict 3-Snipe System.
//
// Snipes stay pure rules (zero Engine). The three V2 lock fixes — the Chaos
// rule, the Top 4 derby, and the conservative Standard lock — consult the
// Engine's xG math (`computeMatchExpectedGoals`, the Maher attack × defence
// model) through an offline season strength snapshot, and only change the
// legacy pick when the math STRONGLY supports it (xG margin ≥ 0.4).

import {
  FALLBACK_LEAGUE_AVERAGES,
  computeMatchExpectedGoals,
  type AttackDefenceTable,
  type TeamAttackDefence,
} from "./data/attackDefence";
import { normaliseTeamName } from "./data/historical";

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

// ─── V2 xG snapshot (Engine Maher strengths, 2026-27) ────────────────────────
//
// Per-team venue strengths in the Engine's attack/defence parametrisation
// (see `src/lib/data/attackDefence.ts`): strengths are ratios against the
// league scoring baseline, so 1.00 = league average. Fed into
// `computeMatchExpectedGoals` — the same xG function the correct-score route
// runs — this gives the V2 locks a deterministic, offline expected-goals read.
type V2XgStrength = {
  attackHome: number;
  defenceAway: number;
  attackAway: number;
  defenceHome: number;
};

export const V2_XG_STRENGTH: Record<string, V2XgStrength> = {
  "Arsenal":        { attackHome: 0.98, defenceAway: 0.98, attackAway: 0.96, defenceHome: 0.95 },
  "Liverpool":      { attackHome: 1.21, defenceAway: 0.98, attackAway: 1.00, defenceHome: 0.89 },
  "Man City":       { attackHome: 0.83, defenceAway: 0.95, attackAway: 0.96, defenceHome: 1.19 },
  "Brighton":       { attackHome: 1.07, defenceAway: 0.95, attackAway: 1.14, defenceHome: 0.92 },
  "Fulham":         { attackHome: 0.80, defenceAway: 0.97, attackAway: 1.05, defenceHome: 1.06 },
  "Brentford":      { attackHome: 1.00, defenceAway: 0.99, attackAway: 1.27, defenceHome: 1.04 },
  "Everton":        { attackHome: 0.94, defenceAway: 1.09, attackAway: 1.27, defenceHome: 1.17 },
  "Leeds":          { attackHome: 0.97, defenceAway: 1.38, attackAway: 1.16, defenceHome: 0.98 },
  "Crystal Palace": { attackHome: 0.93, defenceAway: 1.02, attackAway: 0.91, defenceHome: 0.93 },
  "Newcastle":      { attackHome: 0.93, defenceAway: 0.91, attackAway: 1.03, defenceHome: 1.00 },
  "Aston Villa":    { attackHome: 1.03, defenceAway: 1.01, attackAway: 1.09, defenceHome: 0.91 },
  "Coventry":       { attackHome: 0.96, defenceAway: 1.12, attackAway: 1.04, defenceHome: 0.97 },
  "Ipswich":        { attackHome: 0.97, defenceAway: 0.98, attackAway: 0.81, defenceHome: 0.96 },
  "Hull":           { attackHome: 0.85, defenceAway: 0.92, attackAway: 0.95, defenceHome: 1.04 },
  "Sunderland":     { attackHome: 1.01, defenceAway: 0.92, attackAway: 1.00, defenceHome: 1.33 },
  "Burnley":        { attackHome: 1.08, defenceAway: 1.01, attackAway: 1.12, defenceHome: 0.88 },
  "Chelsea":        { attackHome: 1.01, defenceAway: 0.84, attackAway: 1.16, defenceHome: 0.93 },
  "Man Utd":        { attackHome: 1.02, defenceAway: 0.96, attackAway: 1.10, defenceHome: 0.92 },
  "Spurs":          { attackHome: 1.04, defenceAway: 0.87, attackAway: 0.89, defenceHome: 1.00 },
  "Bournemouth":    { attackHome: 1.45, defenceAway: 1.01, attackAway: 0.94, defenceHome: 1.21 },
  "Nott'm Forest":  { attackHome: 0.83, defenceAway: 1.06, attackAway: 0.82, defenceHome: 1.03 },
};

/** xG margin the Engine must show before a V2 lock may deviate from its legacy pick. */
export const STRONG_XG_MARGIN = 0.4;
/** xG gap that turns a Standard lock into a blowout prediction. */
export const BLOWOUT_XG_MARGIN = 1.2;
/** Both sides projected at/above this → the Standard lock plays a 2-2 thriller. */
export const HIGH_DRAW_XG = 1.8;

function buildV2XgTable(): AttackDefenceTable {
  const teams = new Map<string, TeamAttackDefence>();
  for (const [name, s] of Object.entries(V2_XG_STRENGTH)) {
    const key = normaliseTeamName(name);
    teams.set(key, {
      team: name,
      key,
      leagueSlug: "eng.1",
      matchesPlayed: 10,
      homeMatches: 5,
      awayMatches: 5,
      attackHome: s.attackHome,
      defenceHome: s.defenceHome,
      attackAway: s.attackAway,
      defenceAway: s.defenceAway,
      attack: (s.attackHome + s.attackAway) / 2,
      defence: (s.defenceHome + s.defenceAway) / 2,
      avgGoalsScoredHome: FALLBACK_LEAGUE_AVERAGES.home,
      avgGoalsConcededHome: FALLBACK_LEAGUE_AVERAGES.away,
      avgGoalsScoredAway: FALLBACK_LEAGUE_AVERAGES.away,
      avgGoalsConcededAway: FALLBACK_LEAGUE_AVERAGES.home,
    });
  }
  return {
    leagueSlug: "eng.1",
    league: {
      leagueSlug: "eng.1",
      matches: 0,
      leagueAverageHome: FALLBACK_LEAGUE_AVERAGES.home,
      leagueAverageAway: FALLBACK_LEAGUE_AVERAGES.away,
      leagueAverageTotal: FALLBACK_LEAGUE_AVERAGES.home + FALLBACK_LEAGUE_AVERAGES.away,
      fallback: true,
    },
    teams,
    matchesProcessed: 0,
  };
}

const V2_XG_TABLE = buildV2XgTable();

/**
 * Run the Engine's xG math for one fixture (offline, deterministic).
 * Teams missing from the snapshot fall back to league-average strengths.
 */
export function estimateFixtureXg(
  home: string,
  away: string,
): { homeXg: number; awayXg: number } {
  const result = computeMatchExpectedGoals({
    homeTeam: home,
    awayTeam: away,
    table: V2_XG_TABLE,
    applyElo: false,
  });
  return { homeXg: result.homeExpectedGoals, awayXg: result.awayExpectedGoals };
}

/**
 * Exact V2 Strict 3-Snipe System (with the three V2 lock fixes).
 *
 * 1. Counters: `fortressUsed`, `deadlocksUsed`, `eliteAwayUsed`. Max 3 Snipes total.
 * 2. Snipes (20-Point Targets) — pure rules, zero Engine:
 *    - Chaos teams are PERMANENTLY BANNED from Snipes.
 *    - Snipe 1: Top 4 (Home) vs Bottom 5 -> 2-0 (Max 1).
 *    - Snipe 2 & 3: Mid (Home) vs Mid -> 1-1 (Max 2).
 *    - Snipe 3 Alternative: If there are not 2 Mid-Table Deadlocks, Top 4 (Away) -> 0-1.
 * 3. Locks (10-Point Targets) — Engine xG consulted, changes only when the
 *    math STRONGLY supports them (margin >= STRONG_XG_MARGIN):
 *    - Rule 1 (Chaos): both Chaos -> 1-1. Vs Top 4 keeps the legacy 2-1/1-2.
 *      Vs Mid / Bottom 5 / Standard: HOME -> 2-1, AWAY -> 1-2 — but only when
 *      the Engine's xG margin is >= 0.4 in that direction, else 1-1. NEVER 2-2.
 *    - Rule 2 (Top 4 Home): Top 4 Home (not vs Bottom 5) vs non-Top 4 -> 2-0.
 *      Top 4 DERBY (home also faces an away Top 4 side) -> Engine xG:
 *      home xG > away xG + 0.4 -> 2-1 · away xG > home xG + 0.4 -> 1-2 · else 1-1.
 *    - Rule 3 (Mid vs Bottom): Mid at Home vs Bottom 5 -> 2-1.
 *    - Rule 4 (Standard xG): matches with no Top 4, no Bottom 5, no Chaos and
 *      not Mid-vs-Mid run the Engine xG:
 *      home diff >= 1.2 -> 3-0/4-0 · away diff >= 1.2 -> 0-3/0-4 ·
 *      both xG >= 1.8 -> 2-2 · otherwise the legacy 1-0 / 0-1 default.
 */
export function generateV2Predictions(fixtures: readonly V2FixtureInput[]): Prediction[] {
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

    // Rule 1 (Chaos): both Chaos -> 1-1. Vs Top 4 keeps the legacy 2-1 / 1-2.
    // Vs Mid / Bottom 5 / Standard: HOME -> 2-1, AWAY -> 1-2 — but ONLY when
    // the Engine's xG margin strongly supports it (>= STRONG_XG_MARGIN),
    // otherwise the legacy 1-1 stands. NEVER 2-2.
    if (homeIsChaos || awayIsChaos) {
      let prediction: string;
      if (homeIsChaos && awayIsChaos) {
        prediction = "1-1";
      } else if (homeIsTop4 || awayIsTop4) {
        prediction = homeIsTop4 ? "2-1" : "1-2";
      } else {
        const { homeXg, awayXg } = estimateFixtureXg(home, away);
        const chaosIsHome = homeIsChaos;
        const support = chaosIsHome ? homeXg - awayXg : awayXg - homeXg;
        prediction =
          support >= STRONG_XG_MARGIN
            ? chaosIsHome
              ? "2-1"
              : "1-2"
            : "1-1";
      }
      return {
        Match: `${home} vs ${away}`,
        Category: "LOCK: Chaos Rule",
        Prediction: prediction,
        Target_Pts: 10,
      };
    }

    // Rule 2 (Top 4 Home): non-Top 4 opponent -> legacy 2-0.
    // Top 4 DERBY -> Engine xG decides: 2-1 / 1-2 / 1-1.
    if (homeIsTop4) {
      if (!awayIsTop4) {
        return {
          Match: `${home} vs ${away}`,
          Category: "LOCK: Smart Top 4 Home",
          Prediction: "2-0",
          Target_Pts: 10,
        };
      }
      const { homeXg, awayXg } = estimateFixtureXg(home, away);
      const prediction =
        homeXg - awayXg >= STRONG_XG_MARGIN
          ? "2-1"
          : awayXg - homeXg >= STRONG_XG_MARGIN
            ? "1-2"
            : "1-1";
      return {
        Match: `${home} vs ${away}`,
        Category: "LOCK: Top 4 Derby",
        Prediction: prediction,
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

    // Rule 4 (Conservative Standard): no Top 4, no Bottom 5, no Chaos and not
    // Mid-vs-Mid → run the Engine xG. Only STRONG math deviates from the
    // legacy default: a >= 1.2 gap becomes a blowout, two >= 1.8 projections
    // become a 2-2 thriller, anything tighter keeps the old 1-0 / 0-1.
    const xgEligible =
      !homeIsTop4 && !awayIsTop4 && !homeIsBottom5 && !awayIsBottom5 && !(homeIsMid && awayIsMid);
    if (xgEligible) {
      const { homeXg, awayXg } = estimateFixtureXg(home, away);
      const margin = homeXg - awayXg;
      if (margin >= BLOWOUT_XG_MARGIN) {
        return {
          Match: `${home} vs ${away}`,
          Category: "LOCK: xG Blowout",
          Prediction: Math.round(homeXg) >= 4 ? "4-0" : "3-0",
          Target_Pts: 10,
        };
      }
      if (margin <= -BLOWOUT_XG_MARGIN) {
        return {
          Match: `${home} vs ${away}`,
          Category: "LOCK: xG Blowout",
          Prediction: Math.round(awayXg) >= 4 ? "0-4" : "0-3",
          Target_Pts: 10,
        };
      }
      if (homeXg >= HIGH_DRAW_XG && awayXg >= HIGH_DRAW_XG) {
        return {
          Match: `${home} vs ${away}`,
          Category: "LOCK: xG High Draw",
          Prediction: "2-2",
          Target_Pts: 10,
        };
      }
    }

    // Rule 5 (Standard Default): tight game -> 1-0 (Home) or 0-1 (Away).
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
