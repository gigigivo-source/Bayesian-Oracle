// ĞIGI GIVØ — Player-Level Prediction Engine + Formation Tactical Profiles
// Uses per-90 stats to generate individual player market probabilities.
// Formation analysis feeds into the lambda builder for goal/corner/card multipliers.

import { poissonSf } from "./stats";

// ─── Player props ─────────────────────────────────────────────────────────────

export interface PlayerProfile {
  name:           string;
  team:           string;
  position:       string;
  goals:          number;
  assists:        number;
  shots:          number;
  shotsOnTarget:  number;
  appearances:    number;
  // Per-90 rates
  goalsP90:       number;
  shotsP90:       number;
  sotP90:         number;
}

export interface PlayerMarket {
  player:      string;
  team:        string;
  market:      string;
  selection:   string;
  probability: number;
  fairOdds:    number;
}

/** Calculate player markets from season stats */
export function generatePlayerMarkets(player: PlayerProfile): PlayerMarket[] {
  const markets: PlayerMarket[] = [];

  // ── Anytime Goalscorer: P(≥1) = 1 - e^(-λ) ────────────────────────────────
  const scorerProb = 1 - Math.exp(-Math.max(player.goalsP90, 0.001));
  markets.push({
    player:      player.name,
    team:        player.team,
    market:      "Anytime Goalscorer",
    selection:   "Yes",
    probability: Math.round(scorerProb * 1000) / 1000,
    fairOdds:    Math.round((1 / scorerProb) * 100) / 100,
  });

  // ── Brace (2+ Goals): P(≥2) = 1 - e^(-λ)(1 + λ) ──────────────────────────
  const braceProb = 1 - Math.exp(-player.goalsP90) * (1 + player.goalsP90);
  if (braceProb > 0.01) {
    markets.push({
      player:      player.name,
      team:        player.team,
      market:      "2+ Goals (Brace)",
      selection:   "Yes",
      probability: Math.round(braceProb * 1000) / 1000,
      fairOdds:    Math.round((1 / braceProb) * 100) / 100,
    });
  }

  // ── Shots on Target O/U 0.5 / 1.5 / 2.5 ─────────────────────────────────
  for (const line of [0.5, 1.5, 2.5]) {
    const overProb = poissonSf(Math.ceil(line), player.sotP90);
    const best     = Math.max(overProb, 1 - overProb);
    markets.push({
      player:      player.name,
      team:        player.team,
      market:      `Shots on Target O/U ${line}`,
      selection:   overProb >= 0.5 ? `Over ${line}` : `Under ${line}`,
      probability: Math.round(best * 1000) / 1000,
      fairOdds:    Math.round((1 / best) * 100) / 100,
    });
  }

  // ── Total Shots O/U 0.5 / 1.5 / 2.5 ────────────────────────────────────────
  for (const line of [0.5, 1.5, 2.5]) {
    const overProb = poissonSf(Math.ceil(line), player.shotsP90);
    const best     = Math.max(overProb, 1 - overProb);
    markets.push({
      player:      player.name,
      team:        player.team,
      market:      `Total Shots O/U ${line}`,
      selection:   overProb >= 0.5 ? `Over ${line}` : `Under ${line}`,
      probability: Math.round(best * 1000) / 1000,
      fairOdds:    Math.round((1 / best) * 100) / 100,
    });
  }

  return markets;
}

// ─── Formation tactical profiles ──────────────────────────────────────────────

export interface FormationProfile {
  formation:         string;
  label:             string;
  style:             "attacking" | "defensive" | "balanced" | "wing-play" | "possession";
  defenderCount:     number;
  midfielderCount:   number;
  forwardCount:      number;
  attackingStrength: number; // 0-1
  defensiveStrength: number; // 0-1
  wingFocus:         number; // 0-1
  strengths:         string[];
  weaknesses:        string[];
  xGModifier:        number;
  cornerModifier:    number;
  cardRiskModifier:  number;
}

const FORMATION_DB: Record<string, FormationProfile> = {
  "4-3-3": {
    formation: "4-3-3", label: "4-3-3",
    style: "attacking", defenderCount: 4, midfielderCount: 3, forwardCount: 3,
    attackingStrength: 0.80, defensiveStrength: 0.60, wingFocus: 0.85,
    strengths:  ["High press traps opposition", "Wide forwards stretch defence"],
    weaknesses: ["Exposed through midfield", "High-line vulnerability"],
    xGModifier: 0.08, cornerModifier: 0.6, cardRiskModifier: 0.1,
  },
  "4-4-2": {
    formation: "4-4-2", label: "4-4-2",
    style: "balanced", defenderCount: 4, midfielderCount: 4, forwardCount: 2,
    attackingStrength: 0.65, defensiveStrength: 0.70, wingFocus: 0.70,
    strengths:  ["Compact midfield block", "Strong wide channels"],
    weaknesses: ["Outnumbered centrally vs 3-man mids"],
    xGModifier: 0.00, cornerModifier: 0.0, cardRiskModifier: 0.0,
  },
  "4-2-3-1": {
    formation: "4-2-3-1", label: "4-2-3-1",
    style: "balanced", defenderCount: 4, midfielderCount: 5, forwardCount: 1,
    attackingStrength: 0.70, defensiveStrength: 0.72, wingFocus: 0.75,
    strengths:  ["Double pivot protects defence", "No.10 links play between lines"],
    weaknesses: ["Lone striker can be isolated"],
    xGModifier: 0.04, cornerModifier: 0.3, cardRiskModifier: -0.05,
  },
  "3-5-2": {
    formation: "3-5-2", label: "3-5-2",
    style: "wing-play", defenderCount: 3, midfielderCount: 5, forwardCount: 2,
    attackingStrength: 0.75, defensiveStrength: 0.55, wingFocus: 0.90,
    strengths:  ["Wing-backs provide width", "Dominant midfield numerically"],
    weaknesses: ["Wing-back channels exposed on transition"],
    xGModifier: 0.06, cornerModifier: 0.8, cardRiskModifier: 0.0,
  },
  "3-4-3": {
    formation: "3-4-3", label: "3-4-3",
    style: "attacking", defenderCount: 3, midfielderCount: 4, forwardCount: 3,
    attackingStrength: 0.85, defensiveStrength: 0.45, wingFocus: 0.80,
    strengths:  ["Three-pronged attack", "High press wins ball in dangerous areas"],
    weaknesses: ["Risky defensively at the back"],
    xGModifier: 0.14, cornerModifier: 1.0, cardRiskModifier: 0.15,
  },
  "5-3-2": {
    formation: "5-3-2", label: "5-3-2",
    style: "defensive", defenderCount: 5, midfielderCount: 3, forwardCount: 2,
    attackingStrength: 0.50, defensiveStrength: 0.85, wingFocus: 0.40,
    strengths:  ["Solid back five", "Good on set pieces defensively"],
    weaknesses: ["Limited width in attack"],
    xGModifier: -0.12, cornerModifier: -0.8, cardRiskModifier: -0.05,
  },
  "5-4-1": {
    formation: "5-4-1", label: "5-4-1",
    style: "defensive", defenderCount: 5, midfielderCount: 4, forwardCount: 1,
    attackingStrength: 0.35, defensiveStrength: 0.90, wingFocus: 0.30,
    strengths:  ["Ultra compact", "Extremely hard to score against"],
    weaknesses: ["Minimal attacking threat"],
    xGModifier: -0.18, cornerModifier: -1.0, cardRiskModifier: 0.05,
  },
  "4-1-4-1": {
    formation: "4-1-4-1", label: "4-1-4-1",
    style: "possession", defenderCount: 4, midfielderCount: 5, forwardCount: 1,
    attackingStrength: 0.60, defensiveStrength: 0.75, wingFocus: 0.65,
    strengths:  ["Overloaded midfield wins second balls", "Dangerous counters from deep"],
    weaknesses: ["Lone striker isolated"],
    xGModifier: -0.06, cornerModifier: -0.4, cardRiskModifier: 0.0,
  },
  "4-5-1": {
    formation: "4-5-1", label: "4-5-1",
    style: "defensive", defenderCount: 4, midfielderCount: 5, forwardCount: 1,
    attackingStrength: 0.45, defensiveStrength: 0.80, wingFocus: 0.50,
    strengths:  ["Narrow compactness", "Good counter-attack platform"],
    weaknesses: ["Lack of width", "Low corner output"],
    xGModifier: -0.06, cornerModifier: -0.4, cardRiskModifier: 0.0,
  },
  "4-3-2-1": {
    formation: "4-3-2-1", label: "4-3-2-1",
    style: "attacking", defenderCount: 4, midfielderCount: 5, forwardCount: 1,
    attackingStrength: 0.72, defensiveStrength: 0.65, wingFocus: 0.55,
    strengths:  ["Strong triangle midfield", "Two shadow strikers create chaos"],
    weaknesses: ["Exposed wide"],
    xGModifier: 0.03, cornerModifier: 0.1, cardRiskModifier: 0.0,
  },
  "4-4-1-1": {
    formation: "4-4-1-1", label: "4-4-1-1",
    style: "balanced", defenderCount: 4, midfielderCount: 5, forwardCount: 1,
    attackingStrength: 0.58, defensiveStrength: 0.73, wingFocus: 0.60,
    strengths:  ["Support striker links play", "Solid defensive shape"],
    weaknesses: ["Can become passive in possession"],
    xGModifier: 0.02, cornerModifier: 0.0, cardRiskModifier: 0.0,
  },
};

export function getFormationProfile(formation: string): FormationProfile {
  return FORMATION_DB[formation] ?? {
    ...FORMATION_DB["4-4-2"],
    formation,
    label: formation,
  };
}

/** Analyse tactical mismatch between two formations */
export function analyseFormationMismatch(
  homeFormation: string,
  awayFormation: string,
): {
  homeAdvantage:    number;   // -0.3 to +0.3
  goalMultiplier:   number;
  cornerMultiplier: number;
  cardMultiplier:   number;
  description:      string;
  marketImplications: string[];
} {
  const h = getFormationProfile(homeFormation);
  const a = getFormationProfile(awayFormation);

  const atkVsDef = h.attackingStrength - a.defensiveStrength;
  const defVsAtk = a.attackingStrength - h.defensiveStrength;

  let goalMult   = 1.0;
  let cornerMult = 1.0;
  let cardMult   = 1.0;
  let desc       = "";
  const implications: string[] = [];

  if (h.style === "attacking" && a.style === "defensive") {
    goalMult   = 0.88; cornerMult = 1.15; cardMult = 1.12;
    desc = `${homeFormation} (attacking) vs ${awayFormation} (defensive) — expect frustration, corners from blocked attacks, tactical fouls.`;
    implications.push("Under 2.5 Goals has value — defensive block likely to hold.");
    implications.push("Corners Over 10.5 supported by attacking pressure vs deep block.");
  } else if (h.style === "attacking" && a.style === "attacking") {
    goalMult   = 1.15; cornerMult = 1.08; cardMult = 0.92;
    desc = `${homeFormation} vs ${awayFormation} — both attacking = open, high-scoring potential.`;
    implications.push("Over 2.5 Goals highly likely with both teams attacking.");
    implications.push("BTTS Yes supported — both formations create chances.");
  } else if (h.style === "defensive" && a.style === "defensive") {
    goalMult   = 0.80; cornerMult = 0.85; cardMult = 1.08;
    desc = `${homeFormation} vs ${awayFormation} — both defensive = low-scoring, cautious match.`;
    implications.push("Under 1.5 Goals has strong value.");
    implications.push("Elevated card risk from tactical fouling in low-tempo game.");
  } else if (h.style === "wing-play" || a.style === "wing-play") {
    cornerMult = 1.12;
    desc = `Wing-play formation (${h.style === "wing-play" ? homeFormation : awayFormation}) — expect more crosses and corners.`;
    implications.push("Corners Over 10.5 supported by wing-play style.");
  } else if (h.style === "possession" || a.style === "possession") {
    goalMult   = 0.95; cardMult = 0.90;
    desc = `Possession formation — controlled tempo, fewer cards, moderate goal expectancy.`;
    implications.push("Under 3.5 Cards supported — possession style limits aggressive challenges.");
  } else {
    desc = `${homeFormation} vs ${awayFormation} — standard tactical balance.`;
  }

  // Wing focus modifier
  if (h.wingFocus > 0.80 || a.wingFocus > 0.80) {
    cornerMult *= 1.05;
    implications.push("High wing focus from one or both sides — additional corners likely.");
  }

  const homeAdv = (atkVsDef - defVsAtk) * 0.15;

  return {
    homeAdvantage:      homeAdv,
    goalMultiplier:     goalMult,
    cornerMultiplier:   cornerMult,
    cardMultiplier:     cardMult,
    description:        desc,
    marketImplications: implications,
  };
}
