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
  let totalSnipesUsed = 0;

  return fixtures.map(([home, away]) => {
    let prediction: string;
    let category: string;
    let targetPts: number;

    const homeIsTop4 = TOP_4.includes(home);
    const awayIsTop4 = TOP_4.includes(away);
    const homeIsMid = MID_TABLE.includes(home);
    const awayIsMid = MID_TABLE.includes(away);
    const homeIsBottom5 = BOTTOM_5.includes(home);
    const awayIsBottom5 = BOTTOM_5.includes(away);
    const homeIsChaos = CHAOS_TEAMS.includes(home);
    const awayIsChaos = CHAOS_TEAMS.includes(away);
    // "Standard" = not in any tier (not Top 4, Mid, Bottom 5, or Chaos)
    const homeIsStandard = !homeIsTop4 && !homeIsMid && !homeIsBottom5 && !homeIsChaos;
    const awayIsStandard = !awayIsTop4 && !awayIsMid && !awayIsBottom5 && !awayIsChaos;

    // 1. Snipes (20-Point Targets)
    // Crucial Rule: Chaos Teams are PERMANENTLY BANNED from being Snipes.
    if (!homeIsChaos && !awayIsChaos) {
      if (homeIsTop4 && awayIsBottom5 && fortressUsed < 1) {
        prediction = "2-0";
        category = "SNIPE: Home Fortress";
        targetPts = 20;
        fortressUsed++;
        totalSnipesUsed++;
        return { Match: `${home} vs ${away}`, Category: category, Prediction: prediction, Target_Pts: targetPts };
      }

      if (homeIsMid && awayIsMid && deadlocksUsed < 2) {
        prediction = "1-1";
        category = "SNIPE: Mid-Table Deadlock";
        targetPts = 20;
        deadlocksUsed++;
        totalSnipesUsed++;
        return { Match: `${home} vs ${away}`, Category: category, Prediction: prediction, Target_Pts: targetPts };
      }

      if (awayIsTop4 && totalSnipesUsed < 3) {
        prediction = "0-1";
        category = "SNIPE: Elite Away";
        targetPts = 20;
        totalSnipesUsed++;
        return { Match: `${home} vs ${away}`, Category: category, Prediction: prediction, Target_Pts: targetPts };
      }
    }

    // 2. Locks (10-Point Targets)
    targetPts = 10;

    if (homeIsChaos || awayIsChaos) {
      category = "LOCK: Chaos Rule";
      if (homeIsTop4) prediction = "2-1";
      else if (awayIsTop4) prediction = "1-2";
      else if (homeIsChaos && awayIsChaos) prediction = "1-1";
      else if (homeIsChaos) prediction = "2-1"; // Chaos team at home beats Mid/Standard/Bottom
      else prediction = "1-2"; // Chaos team away beats Mid/Standard/Bottom
    } else if (homeIsTop4) {
      category = "LOCK: Smart Top 4 Home";
      prediction = "2-0";
    } else if (awayIsTop4) {
      category = "LOCK: Elite Away (Exhausted)";
      prediction = "0-1"; // Top 4 away always wins, even if Snipe is used
    } else if (homeIsMid && awayIsBottom5) {
      category = "LOCK: Mid vs Bottom";
      prediction = "2-1";
    } else if (homeIsBottom5 && awayIsMid) {
      category = "LOCK: Bottom vs Mid";
      prediction = "0-1"; // Mid always beats Bottom, even away
    } else if (homeIsMid && awayIsStandard) {
      category = "LOCK: Mid vs Standard";
      prediction = "1-0";
    } else if (homeIsStandard && awayIsMid) {
      category = "LOCK: Standard vs Mid";
      prediction = "0-1"; // Mid always beats Standard, even away
    } else if (homeIsBottom5 && awayIsStandard) {
      category = "LOCK: Bottom vs Standard";
      prediction = "0-1";
    } else if (homeIsStandard && awayIsBottom5) {
      category = "LOCK: Standard vs Bottom";
      prediction = "1-0";
    } else {
      // Both Standard, both Bottom5, or Mid vs Mid (if deadlock used up)
      category = "LOCK: Standard Home";
      prediction = "1-0";
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
