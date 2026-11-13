// V4 presentation and scorecard helpers.

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
export type ScoredPrediction = { Match: string; Prediction: string; Actual: string; Points: number; Status: string; MissReason: string };

/** Legacy target-points presentation helper. */
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
 * The route is the single source of truth: it selects the scoreline for every
 * fixture using the blended-anchor strategy. Rows without a usable scoreline
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
    const missReason = !isScoreline(row.Prediction) ? "—" : points === 0 ? "❌ MISS: Wrong Outcome" : points === 10 ? "❌ MISS: Wrong Score" : "—";
    return { Match: row.Match, Prediction: row.Prediction, Actual: `${actH}-${actA}`, Points: points, Status: status, MissReason: missReason };
  });
  return [scored, total];
}
