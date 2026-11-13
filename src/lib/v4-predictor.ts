// ĞIGI GIVØ — V4 Predictor client model.
//
// The blind V2 static rules (SNIPE / LOCK tiers driven by hard-coded team
// lists) are gone. Predictions are produced by the Portfolio Tranching engine
// in `/api/v4-predictor/auto`: every fixture is priced by the MarketEngine
// (Dixon–Coles corrected 1X2 + Correct Score grid) and the slate is split into
// a FLOOR tranche of safe favourites and a CEILING tranche of draw snipes.
//
// This module keeps the presentation helpers the dashboard needs — team-name
// translation, scoreline validation, and the points scorecard — plus a thin
// projection of the route's rows into the shape the table renders.

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

/** The two tranches the portfolio is split into. */
export type Tranche = "FLOOR" | "CEILING";

/**
 * A fixture as delivered by `/api/v4-predictor/auto`. `prediction` and
 * `category` are the tranching engine's output ("2-1", "FLOOR: Home Win",
 * "CEILING: Draw Snipe"); `enginePrediction` mirrors the scoreline for callers
 * that only read that field.
 */
export type Fixture = {
  home: string;
  away: string;
  enginePrediction?: string | null;
  prediction?: string | null;
  category?: string | null;
};
export type Actual = [number, number];
export type Prediction = { Match: string; Category: string; Prediction: string; Target_Pts: number };
export type ScoredPrediction = { Match: string; Prediction: string; Actual: string; Points: number; Status: string };

/** Points the tranche is aiming for: safe floor vs. the 20-point ceiling snipe. */
export function targetPointsForCategory(category: string): number {
  return category.trim().toUpperCase().startsWith("CEILING") ? 20 : 10;
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
 * fixture and assigned each one to a tranche. Rows without a usable scoreline
 * (a malformed payload, a fixture the Engine could not price at all) render
 * with no prediction rather than silently falling back to a static rule.
 */
export function buildPredictions(fixtures: Fixture[]): Prediction[] {
  return fixtures.map(({ home, away, prediction, category, enginePrediction }) => {
    const resolved =
      isScoreline(prediction) ? prediction : isScoreline(enginePrediction) ? enginePrediction : "";
    const label = typeof category === "string" ? category.trim() : "";
    return {
      Match: `${home} vs ${away}`,
      Category: label,
      Prediction: resolved,
      Target_Pts: resolved ? targetPointsForCategory(label) : 0,
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
