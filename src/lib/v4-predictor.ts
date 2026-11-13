// ĞIGI GIVØ — V4 Predictor client model.
//
// The API owns selection: the MW1–10 backtest winner is Consensus Override
// (V2 chooses the outcome; the Engine chooses its most likely matching score).
// This module only translates names and projects the API's decision into the
// dashboard/scorecard. It never applies team lists or re-picks a scoreline.

export const TEAM_NAME_MAP: Record<string, string> = {
  "Manchester City": "Man City",
  "Manchester United": "Man Utd",
  "Tottenham Hotspur": "Spurs",
  "Brighton & Hove Albion": "Brighton",
  "Newcastle United": "Newcastle",
  "Nottingham Forest": "Nott'm Forest",
  "Leeds United": "Leeds",
  "Coventry City": "Coventry",
  "Hull City": "Hull",
  "Ipswich Town": "Ipswich",
  // Teams that don't need translation fall through to themselves
};

export function translateTeamName(espnName: string): string {
  return TEAM_NAME_MAP[espnName] || espnName;
}

const EXTRA_TEAM_NAME_MAP: Record<string, string> = {
  "AFC Bournemouth": "Bournemouth",
  "Wolverhampton Wanderers": "Wolves",
  "West Ham United": "West Ham",
  "Leicester City": "Leicester",
};

/** Normalise ESPN/openfootball club names to the labels the V4 rules use. */
export function toV4TeamName(name: string): string {
  const trimmed = name.trim();
  const stripped = trimmed.replace(/\s+(?:AFC|FC)$/i, "").trim();
  const mapped = EXTRA_TEAM_NAME_MAP[trimmed] ?? EXTRA_TEAM_NAME_MAP[stripped] ?? stripped;
  return translateTeamName(mapped);
}

/**
 * A fixture as delivered by `/api/v4-predictor/auto`. `prediction` and
 * `category` are the consensus selector's output; `ep` describes that pick's
 * expected points and `enginePrediction` mirrors it for legacy callers.
 */
export type Fixture = {
  home: string;
  away: string;
  enginePrediction?: string | null;
  prediction?: string | null;
  category?: string | null;
  ep?: number | null;
};
export type Actual = [number, number];
export type Prediction = { Match: string; Category: string; Prediction: string; Target_Pts: number };
export type ScoredPrediction = { Match: string; Prediction: string; Actual: string; Points: number; Status: string };

/**
 * Points the pick is aiming for.
 *
 * The maximiser targets the full 20 — 10 for the outcome plus 10 for the exact
 * scoreline — so the target is 20 whenever the route returned a scoreline, and
 * the pick's own Expected Points when the payload carries them (a value
 * between 0 and 20 that says how much of that 20 the math actually expects).
 */
export function targetPointsForPick(ep?: number | null): number {
  if (typeof ep !== "number" || !Number.isFinite(ep) || ep < 0) return 20;
  return Math.min(20, Math.round(ep));
}

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

/**
 * Project the route's rows into the table's `Prediction` shape.
 *
 * The route is the single source of truth: it already ran the Engine on every
 * fixture and published the consensus scoreline. Rows without a usable scoreline
 * (a malformed payload, a fixture the Engine could not price at all) render
 * with no prediction rather than silently falling back to a static rule.
 */
export function buildPredictions(fixtures: Fixture[]): Prediction[] {
  return fixtures.map(({ home, away, prediction, category, enginePrediction, ep }) => {
    const resolved =
      isScoreline(prediction) ? prediction : isScoreline(enginePrediction) ? enginePrediction : "";
    const label = typeof category === "string" ? category.trim() : "";
    return {
      Match: `${home} vs ${away}`,
      Category: label,
      Prediction: resolved,
      Target_Pts: resolved ? targetPointsForPick(ep) : 0,
    };
  });
}

export function calculateScore(predictions: Prediction[], actuals: Actual[]): [ScoredPrediction[], number] {
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
    return { Match: row.Match, Prediction: row.Prediction, Actual: `${actH}-${actA}`, Points: points, Status: status };
  });
  return [scored, total];
}
