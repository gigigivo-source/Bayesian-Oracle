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

export const TOP_4 = ["Arsenal", "Liverpool", "Man City", "Brighton"];
export const MID_TABLE = ["Fulham", "Brentford", "Everton", "Leeds", "Crystal Palace", "Newcastle", "Aston Villa"];
export const BOTTOM_5 = ["Coventry", "Ipswich", "Hull", "Sunderland", "Burnley"];
export const CHAOS_TEAMS = ["Chelsea", "Man Utd", "Spurs"];

export type Fixture = [string, string];
export type Actual = [number, number];
export type MatchType = "Chaos" | "Home_Fortress" | "Mid_Table_Deadlock" | "Elite_Away" | "Standard";
export type Prediction = { Match: string; Category: string; Prediction: string; Target_Pts: number };
export type ScoredPrediction = { Match: string; Prediction: string; Actual: string; Points: number; Status: string };

export const MW11_FIXTURES: Fixture[] = [
  ["Man City", "Fulham"], ["Bournemouth", "Nott'm Forest"], ["Coventry", "Crystal Palace"],
  ["Spurs", "Ipswich"], ["Chelsea", "Leeds"], ["Aston Villa", "Sunderland"],
  ["Newcastle", "Arsenal"], ["Hull", "Brighton"], ["Liverpool", "Man Utd"], ["Brentford", "Everton"],
];

export function determineMatchType(home: string, away: string): MatchType {
  if (CHAOS_TEAMS.includes(home) || CHAOS_TEAMS.includes(away)) return "Chaos";
  if (TOP_4.includes(home) && BOTTOM_5.includes(away)) return "Home_Fortress";
  if (MID_TABLE.includes(home) && MID_TABLE.includes(away)) return "Mid_Table_Deadlock";
  if (TOP_4.includes(away)) return "Elite_Away";
  return "Standard";
}

export function generatePredictions(fixtures: Fixture[]): Prediction[] {
  let fortressUsed = 0;
  let deadlocksUsed = 0;
  return fixtures.map(([home, away]) => {
    const matchType = determineMatchType(home, away);
    let prediction: string;
    let category: string;
    let targetPts: number;
    if (matchType === "Home_Fortress" && fortressUsed < 1) {
      [prediction, category, targetPts] = ["2-0", "SNIPE: Home Fortress", 20];
      fortressUsed++;
    } else if (matchType === "Mid_Table_Deadlock" && deadlocksUsed < 2) {
      [prediction, category, targetPts] = ["1-1", "SNIPE: Deadlock", 20];
      deadlocksUsed++;
    } else {
      targetPts = 10;
      if (matchType === "Chaos") {
        category = "LOCK: Chaos Rule";
        prediction = TOP_4.includes(home) ? "2-1" : TOP_4.includes(away) ? "1-2" : "2-2";
      } else if (matchType === "Elite_Away") {
        category = "LOCK: Elite Away";
        prediction = "0-1";
      } else if (matchType === "Home_Fortress") {
        category = "LOCK: Standard (Fortress Fallback)";
        prediction = "2-0";
      } else {
        category = "LOCK: Standard";
        prediction = "1-0";
      }
    }
    return { Match: `${home} vs ${away}`, Category: category, Prediction: prediction, Target_Pts: targetPts };
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
