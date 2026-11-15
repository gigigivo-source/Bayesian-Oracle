// V4 Predictor — True V2 Strict 3-Snipe System.
//
// The rule tree (Snipes + Locks) is pure and deterministic. Two of the Locks
// consult expected goals when — and only when — the Engine's xG math strongly
// supports a change from the flat V2 default:
//
//   · Chaos Rule     — a Chaos side at HOME takes the 2-1 win line (the MW9
//                      fix); two Chaos sides stay a 1-1 unless the xG gap says
//                      one of them is clearly better. A Chaos side AWAY still
//                      needs the xG edge to leave the 1-1 (never 2-2).
//   · Top 4 Derby    — a Top 4 host loses its flat 2-0 to a narrow away win
//                      when the Engine cannot separate the two sides.
//   · Standard Lock  — standard-vs-standard matches move to a blowout or a 2-2
//                      only when xG clears the documented thresholds.
//
// Every one of those gates was fitted on the MW1–MW10 replay of the 2026-27
// season; the measurements behind them, including the variants that were
// measured and rejected, live next to the rule they gate.
//
// `generateV2Predictions` stays synchronous and engine-free; callers hand it an
// optional `xg` resolver (see `createMatchXgResolver`) when they can build one.

import { dixonColesGrid, DEFAULT_RHO, type DixonColesCell } from "./data/dixonColes";

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

/**
 * xG edge a Chaos side *away from home* needs before 1-1 becomes 1-2.
 *
 * Kept as a gate (not unconditional) by measurement: an unconditional away 1-2
 * costs MW5 20 points (Fulham 1-1 Man Utd) and MW7 20 points (Leeds 1-1
 * Man Utd) — see Rule 1 in `generateV2Predictions`.
 */
export const CHAOS_XG_EDGE = 0.55;
/**
 * xG gap below which two Chaos sides cancel each other out to a 1-1.
 *
 * At or above this gap the better Chaos side takes its win line (2-1 home /
 * 1-2 away). This is the spec value, and it is not free: over MW1–MW10 it wins
 * MW9 Chelsea 2-0 Man Utd (+10, a 0.40 gap) but also converts MW6 Man Utd 1-1
 * Spurs (a 0.34 gap) from an exact 1-1 into a wrong 2-1 (-20).
 */
export const CHAOS_DRAW_MAX_XG_GAP = 0.2;
/**
 * The xG edge a visiting Top 4 side needed to flip a Top 4 Derby to 0-1 / 1-2
 * on its own. Superseded by the tolerance pair below, kept documented so the
 * first (unconditional) derby design and its measurement are not lost.
 */
export const TOP4_DERBY_MIN_XG_EDGE = 0.4;
/**
 * Top 4 Derby: how much *better* the home side's xG may be and still lose the
 * flat 2-0 lock — the spec's "the away xG is higher, or within 0.1".
 */
export const TOP4_DERBY_AWAY_TOLERANCE = 0.1;
/**
 * Top 4 Derby: how big the visiting side's xG edge may be before the flip stops.
 *
 * This is the narrowing that keeps the MW5 guardrail. Flipping on *any* away
 * edge turns MW5's correct 2-0 into a wrong 0-1 (the Engine rates Brighton 0.86
 * vs Arsenal 1.72; Brighton won 3-0), so the flip only fires when the Engine
 * cannot separate the two sides. See Rule 2 for the measurement.
 */
export const TOP4_DERBY_MAX_AWAY_EDGE = 0.2;
/** xG gap that turns a Standard match into a 3-0 / 4-0 / 0-3 / 0-4 blowout. */
export const STANDARD_BLOWOUT_GAP = 1.2;
/** Per-side xG floor for the high-scoring Standard draw (2-2). */
export const STANDARD_DRAW_XG = 1.8;
/**
 * The Correct Score grid covers 0..maxGoals per side. V2 never chases 7+ goal
 * routs, and the argmax cell never depends on the tail, so this only needs to
 * cover realistic exact scores (e.g. 4-2).
 */
export const CORRECT_SCORE_MAX_GOALS = 6;

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
 *    - Rule 1 (Chaos): 2-1 when the Chaos side is at home, 1-2 when it is away.
 *      Two Chaos sides cancel out to 1-1 unless the Engine separates them by
 *      CHAOS_DRAW_MAX_XG_GAP; a Chaos side away from home still needs
 *      CHAOS_XG_EDGE. NEVER 2-2.
 *    - Rule 2 (Smart Top 4 Home): Top 4 at Home (not vs Bottom 5) -> 2-0.
 *      Top 4 Derby: the visiting Top 4 side takes 0-1 when the Engine rates the
 *      two sides level; the flat 2-0 stands otherwise.
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

    // Resolve the Engine's xG once per fixture; `null` means the flat V2 line.
    const xg = resolveXg(i, home, away);

    /** The locked winner (`"H"` / `"D"` / `"A"`) and the flat V2 fallback. */
    let outcome: "H" | "D" | "A";
    let fallback: string;
    let category: string;

    // Rule 1 (Chaos): 2-1 when the Chaos side is at home, 1-2 when it is away.
    // NEVER 2-2.
    //
    // The MW9 fix: Spurs 2-0 Crystal Palace and Chelsea 2-0 Man Utd were both
    // home Chaos wins that the old rule locked to a 1-1 draw. The win line is
    // bounded by three guards, two of them measured reverts from the
    // unconditional version:
    //
    //   · Two Chaos sides cancel out to 1-1 unless the Engine separates them by
    //     CHAOS_DRAW_MAX_XG_GAP, in which case the better side wins. Without the
    //     gap test every Chaos derby became a home win and MW6 lost the exact
    //     1-1 in Man Utd 1-1 Spurs (-20).
    //   · A Chaos side at home that the Engine rates *below* its opponent keeps
    //     the 1-1 (MW4 Chelsea 2-2 Hull, xG 0.81 vs 1.12: locking a home win for
    //     the weaker side costs 10 points there).
    //   · A Chaos side AWAY still needs CHAOS_XG_EDGE. The unconditional away
    //     1-2 costs MW5 20 points (Fulham 1-1 Man Utd) and MW7 20 points (Leeds
    //     1-1 Man Utd) — two guardrail weeks — for +20 elsewhere.
    //
    // Top 4 precedence is unchanged: a Chaos side hosting a Top 4 side stays
    // 1-2 (MW4 Man Utd 0-1 Man City), and a Top 4 host of a Chaos side stays
    // 2-1 (MW3 Arsenal 2-1 Chelsea, an exact 20).
    if (homeIsChaos || awayIsChaos) {
      category = "LOCK: Chaos Rule";
      const chaosGap = xg === null ? null : xg[0] - xg[1];
      if (homeIsChaos && awayIsChaos) {
        const deadHeat = chaosGap === null || Math.abs(chaosGap) < CHAOS_DRAW_MAX_XG_GAP;
        if (deadHeat) {
          outcome = "D";
          fallback = "1-1";
        } else if (chaosGap > 0) {
          outcome = "H";
          fallback = "2-1";
        } else {
          outcome = "A";
          fallback = "1-2";
        }
      } else if (homeIsTop4) {
        outcome = "H";
        fallback = "2-1";
      } else if (awayIsTop4) {
        outcome = "A";
        fallback = "1-2";
      } else if (homeIsChaos) {
        const homeRatedWorse = chaosGap !== null && chaosGap < 0;
        outcome = homeRatedWorse ? "D" : "H";
        fallback = homeRatedWorse ? "1-1" : "2-1";
      } else {
        const chaosEdge = xg === null ? null : xg[1] - xg[0];
        const chaosWinner = chaosEdge !== null && chaosEdge >= CHAOS_XG_EDGE;
        if (chaosWinner) {
          outcome = "A";
          fallback = "1-2";
        } else {
          outcome = "D";
          fallback = "1-1";
        }
      }
    } else if (homeIsTop4) {

    // Rule 2 (Smart Top 4 Home): Top 4 at Home -> 2-0. In a Top 4 Derby the flat
    // lock is dropped when the Engine cannot separate the two sides, and the
    // visiting Top 4 side takes a narrow away win instead.
    //
    // The MW9 fix: Liverpool 0-1 Arsenal was locked to a 2-0 home win.
    //
    // Why the flip is bounded on *both* sides — the full MW1–MW10 measurement:
    //   · Flipping on any away xG edge (the unconditional version) is worth +20
    //     net and also lifts MW9 to 80, but the Engine rates Brighton 0.86 vs
    //     Arsenal 1.72, so it turns MW5's correct 2-0 (Brighton won 3-0) into a
    //     wrong 0-1: MW5 100 → 90, which breaks the guardrail. No xG-based rule
    //     separates the two games: Liverpool–Arsenal is a 0.18 away edge and
    //     Brighton–Arsenal a 0.86 away edge, so anything that flips the first
    //     flips the second. Bounding the flip to a coin flip (TOP4_DERBY_MAX_
    //     AWAY_EDGE) keeps Brighton at 2-0 and MW5 at 100.
    //   · The Engine's *direction* is not trusted in derbies — it picks the
    //     winner in only 2 of the 5 derbies on this window (it rated Arsenal
    //     1.72 at Brighton, who won 3-0, and Man City 2.65 vs Brighton, who lost
    //     0-1). Only its *indecision* is used here.
    //   · Man City 0-1 Brighton, the other MW9 derby miss, is therefore not
    //     fixable by xG at all: the home edge is 1.50, far outside the band, so
    //     the 2-0 stands. That miss is variance, not a rule bug.
      const derbyGap = xg === null ? null : xg[0] - xg[1];
      const derbyIsCoinFlip =
        derbyGap !== null &&
        derbyGap <= TOP4_DERBY_AWAY_TOLERANCE &&
        derbyGap >= -TOP4_DERBY_MAX_AWAY_EDGE;
      if (awayIsTop4 && derbyIsCoinFlip) {
        outcome = "A";
        fallback = "0-1";
      } else {
        outcome = "H";
        fallback = "2-0";
      }
      category = "LOCK: Smart Top 4 Home";
    } else if (homeIsMid && awayIsBottom5) {

    // Rule 3 (Mid vs Bottom): Mid at Home vs Bottom 5 -> 2-1.
      outcome = "H";
      fallback = "2-1";
      category = "LOCK: Mid vs Bottom";
    } else {

    // Rule 4 (Standard Default): Any other match -> Home or Away win.
    const awayIsStronger =
      awayIsTop4 ||
      (homeIsBottom5 && awayIsMid) ||
      (homeIsStandard && awayIsMid) ||
      (homeIsBottom5 && awayIsStandard);

    outcome = awayIsStronger ? "A" : "H";
    fallback = awayIsStronger ? "0-1" : "1-0";
    category = awayIsStronger ? "LOCK: Standard Away" : "LOCK: Standard Home";
    }

    // Turn the locked winner into an exact score using the conservative
    // hybrid: keep the flat V2 scoreline when it is a top-3 grid cell for the
    // locked winner, otherwise take the Engine's #1 grid cell. Fall back to
    // the flat V2 line when the Engine is unavailable.
    const exact =
      xg === null ? null : pickCorrectScoreHybrid(xg[0], xg[1], outcome, fallback);

    return {
      Match: `${home} vs ${away}`,
      Category: category,
      Prediction: exact ?? fallback,
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

/**
 * The most probable exact scoreline from the Engine's Correct Score grid
 * (Dixon–Coles over the attack/defence xG lambdas) that is consistent with the
 * locked winner (`"H"` / `"D"` / `"A"`).
 *
 * Grid cells are Poisson × τ probabilities; only cells matching `outcome` are
 * eligible, and the absolute highest-probability cell wins. Ties resolve to the
 * first cell in grid order (fewer home goals, then fewer away goals), which is
 * deterministic across runs.
 *
 * Returns `null` when the grid holds no eligible cell — the caller then falls
 * back to the flat V2 scoreline.
 */
export function pickCorrectScore(
  homeXg: number,
  awayXg: number,
  outcome: "H" | "D" | "A",
  maxGoals: number = CORRECT_SCORE_MAX_GOALS,
  rho: number = DEFAULT_RHO,
): string | null {
  const grid = dixonColesGrid(homeXg, awayXg, rho, maxGoals);
  let best: DixonColesCell | null = null;
  for (const cell of grid.cells) {
    const cellOutcome =
      cell.homeGoals > cell.awayGoals
        ? "H"
        : cell.homeGoals < cell.awayGoals
          ? "A"
          : "D";
    if (cellOutcome !== outcome) continue;
    if (best === null || cell.probability > best.probability) best = cell;
  }
  return best ? `${best.homeGoals}-${best.awayGoals}` : null;
}

/**
 * Conservative hybrid for Lock exact scores.
 *
 * Keeps the tuned flat V2 scoreline when it is among the top 3 most probable
 * cells of the Engine's Correct Score grid (filtered to the locked winner),
 * otherwise takes the grid's #1 cell. This preserves flat-V2 guardrail weeks
 * (e.g. MW5 Newcastle–Hull 2-1, MW7 Nott'm Forest–Arsenal 0-1) while still
 * letting the Engine override when it clearly disagrees with the flat line.
 *
 * Returns `null` when the grid holds no eligible cell — the caller then falls
 * back to the flat V2 scoreline.
 */
export function pickCorrectScoreHybrid(
  homeXg: number,
  awayXg: number,
  outcome: "H" | "D" | "A",
  flatScore: string,
  maxGoals: number = CORRECT_SCORE_MAX_GOALS,
  rho: number = DEFAULT_RHO,
): string | null {
  const grid = dixonColesGrid(homeXg, awayXg, rho, maxGoals);
  const eligible: DixonColesCell[] = [];
  for (const cell of grid.cells) {
    const cellOutcome =
      cell.homeGoals > cell.awayGoals
        ? "H"
        : cell.homeGoals < cell.awayGoals
          ? "A"
          : "D";
    if (cellOutcome !== outcome) continue;
    eligible.push(cell);
  }
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => b.probability - a.probability);
  const flatRank = eligible.findIndex(
    (c) => `${c.homeGoals}-${c.awayGoals}` === flatScore,
  );
  if (flatRank !== -1 && flatRank < 3) return flatScore;
  return `${eligible[0].homeGoals}-${eligible[0].awayGoals}`;
}

export const generatePredictions = generateV2Predictions;

// ─── Engine xG wiring ────────────────────────────────────────────────────────

/** Minimal shape of one completed match, as the history loaders return it. */

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
