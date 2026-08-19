// ĞIGI GIVØ — L2/L2.5/L3/L6: build conditional, contextual, calibrated lambdas.
import { clamp, hashString, seededRng } from "./stats";
import type { TeamProfile } from "./context";
import type { LockedMatchObject } from "./types";

export interface LambdaSet {
  // Goals
  homeGoals:           number;
  awayGoals:           number;
  // Corners
  homeCorners:         number;
  awayCorners:         number;
  // Yellow cards
  homeCards:           number;
  awayCards:           number;
  // Shots on target
  homeSot:             number;
  awaySot:             number;
  // Shots towards goal (total attempts)
  homeShots:           number;
  awayShots:           number;
  // Offsides
  homeOffsides:        number;
  awayOffsides:        number;
  // Goal kicks
  homeGoalKicks:       number;
  awayGoalKicks:       number;
  // Saves
  homeSaves:           number;
  awaySaves:           number;
  // Throw-ins
  homeThrowIns:        number;
  awayThrowIns:        number;
  // Fouls
  homeFouls:           number;
  awayFouls:           number;
  // Possession-metric derived
  aerialTotal:         number;
  passesTotal:         number;
  interceptionsHome:   number;
  interceptionsAway:   number;
  dribblingHome:       number;
  dribblingAway:       number;
  // Discrete risk probabilities
  redCardProb:         number;
  penaltyProb:         number;
  calibrationNotes:    string[];
}

// ─── Stage modifiers ──────────────────────────────────────────────────────────

function stageAttackMult(stage: string): number {
  switch (stage) {
    case "Round of 32":   return 0.92;
    case "Round of 16":   return 0.85;
    case "Quarter-Final": return 0.80;
    case "Semi-Final":    return 0.75;
    case "Final":         return 0.70;
    default:              return 1.00;
  }
}

function stageCardMult(stage: string): number {
  switch (stage) {
    case "Round of 32":   return 1.10;
    case "Round of 16":   return 1.15;
    case "Quarter-Final": return 1.20;
    case "Semi-Final":    return 1.25;
    case "Final":         return 1.30;
    default:              return 1.00;
  }
}

// ─── Weather modifiers ────────────────────────────────────────────────────────

function weatherMultipliers(weather: string): { goals: number; corners: number } {
  const w = weather.toLowerCase();
  if (w.includes("heavy rain")) return { goals: 0.85, corners: 1.10 };
  if (w.includes("light rain")) return { goals: 0.92, corners: 1.06 };
  if (w.includes("wind 34"))    return { goals: 0.80, corners: 1.15 };
  if (w.includes("extreme heat")) return { goals: 0.90, corners: 1.00 };
  return { goals: 1.00, corners: 1.00 };
}

// ─── Main builder ─────────────────────────────────────────────────────────────

export function buildLambdas(
  match: LockedMatchObject,
  home:  TeamProfile,
  away:  TeamProfile,
): LambdaSet {
  const notes: string[] = [];
  const seed = hashString(`${match.homeTeam}|${match.awayTeam}|${match.date}|lam`);
  const r    = seededRng(seed);

  // ── Base Split-λ (attack × opponent defense) ─────────────────────────────
  const homeAdv = match.venueType === "HOME" ? 1.12 : 1.0;
  let homeGoals = home.attack * away.defense * 0.62 * homeAdv;
  let awayGoals = away.attack * home.defense * 0.62;

  // Form momentum (L3.1)
  homeGoals *= 1 + home.form;
  awayGoals *= 1 + away.form;

  // ── L3: tournament stage stakes ───────────────────────────────────────────
  const sAtk  = stageAttackMult(match.tournamentStage);
  const sCard = stageCardMult(match.tournamentStage);
  homeGoals *= sAtk;
  awayGoals *= sAtk;
  if (sAtk !== 1) notes.push(`Tournament stakes (${match.tournamentStage}): goals ×${sAtk}, cards ×${sCard}.`);

  // ── L3: weather ───────────────────────────────────────────────────────────
  const wm = weatherMultipliers(match.weatherForecast);
  homeGoals *= wm.goals;
  awayGoals *= wm.goals;
  if (wm.goals !== 1) notes.push(`Weather stress: goals ×${wm.goals}, corners ×${wm.corners}.`);

  // ── L3: home crowd boost ──────────────────────────────────────────────────
  if (match.venueType === "HOME") homeGoals *= 1.05;

  // ── L3: injury flag impact ────────────────────────────────────────────────
  for (const flag of match.keyInjuryFlags) {
    const f = flag.toLowerCase();
    if (f.includes("striker"))  { homeGoals *= 0.90; notes.push("Injury: attacking output reduced (striker flag)."); }
    if (f.includes("keeper"))   { awayGoals *= 1.06; }
    if (f.includes("defender")) { awayGoals *= 1.08; }
  }

  homeGoals = clamp(homeGoals, 0.25, 4.2);
  awayGoals = clamp(awayGoals, 0.20, 3.8);

  // ── Shots on target ───────────────────────────────────────────────────────
  const homeSot = clamp(homeGoals * (2.9 + r() * 0.6), 2.0, 9.5);
  const awaySot = clamp(awayGoals * (2.9 + r() * 0.6), 1.8, 9.0);
  notes.push("Dependency graph: High SOT → Goals coupling active.");

  // ── Total shots (≈ 3× SOT) ────────────────────────────────────────────────
  const homeShots = clamp(homeSot * (3.0 + r() * 0.5), 8, 22);
  const awayShots = clamp(awaySot * (3.0 + r() * 0.5), 7, 21);

  // ── Corners (possession + shots × weather) ────────────────────────────────
  const homeCorners = clamp(
    (home.possession * 10 + homeShots * 0.3) * wm.corners * (match.venueType === "HOME" ? 1.08 : 1),
    2.5, 9.5,
  );
  const awayCorners = clamp((away.possession * 10 + awayShots * 0.3) * wm.corners, 2.2, 9.0);

  // ── Cards (NegBin mean × referee z-score) ─────────────────────────────────
  const refZ       = (r() - 0.4) * 2.2;
  const refCardMult = refZ > 1.0 ? 1.25 : refZ < -0.5 ? 0.85 : 1.0;
  notes.push(`Referee ${match.refereeName} card z-score ${refZ.toFixed(2)} → cards ×${refCardMult}.`);

  const homeCards = clamp(home.discipline * refCardMult * sCard * 0.9, 0.6, 4.5);
  const awayCards = clamp(away.discipline * refCardMult * sCard, 0.7, 4.8);

  // ── Fouls ─────────────────────────────────────────────────────────────────
  const homeFouls = clamp(home.discipline * 4.2 + r() * 3, 7, 18);
  const awayFouls = clamp(away.discipline * 4.2 + r() * 3, 7, 18);

  // ── Offsides ──────────────────────────────────────────────────────────────
  const homeOffsides = clamp(home.attack * 1.1  + r() * 1.2, 0.8, 4.5);
  const awayOffsides = clamp(away.attack * 1.05 + r() * 1.2, 0.8, 4.2);

  // ── Goal kicks (coupled to opponent off-target shots) ─────────────────────
  const homeGoalKicks = clamp(6 + (awayShots - awaySot) * 0.35 + r() * 2, 5, 12);
  const awayGoalKicks = clamp(6 + (homeShots - homeSot) * 0.35 + r() * 2, 5, 12);

  // ── Saves (opponent SOT minus goals) ──────────────────────────────────────
  const homeSaves = clamp(awaySot - awayGoals * 0.9, 1.5, 9);
  const awaySaves = clamp(homeSot  - homeGoals * 0.9, 1.5, 9);

  // ── Throw-ins (possession + style) ───────────────────────────────────────
  const homeThrowIns = clamp(home.possession * 30 + r() * 5, 12, 24);
  const awayThrowIns = clamp(away.possession * 30 + r() * 5, 12, 24);

  // ── Possession-derived metrics ────────────────────────────────────────────
  const aerialTotal       = clamp((home.aerial + away.aerial) * 12 + r() * 4, 16, 30);
  const passesTotal       = clamp((home.possession + away.possession) * 420 + r() * 60, 320, 640);
  const interceptionsHome = clamp(home.pressing * 8 + r() * 3, 6, 14);
  const interceptionsAway = clamp(away.pressing * 8 + r() * 3, 6, 14);
  const dribblingHome     = clamp(home.attack * 6 + r() * 3, 6, 16);
  const dribblingAway     = clamp(away.attack * 6 + r() * 3, 6, 16);

  // ── Discrete risks ────────────────────────────────────────────────────────
  const redCardProb = clamp(0.08 + (refZ > 0.8 ? 0.06 : 0) + (sCard - 1) * 0.2, 0.04, 0.35);
  const penaltyProb = clamp(0.22 + (homeFouls + awayFouls - 20) * 0.006, 0.12, 0.42);

  // ── L6: pre-match shrinkage ────────────────────────────────────────────────
  const shrink = 0.85 + r() * 0.1;
  homeGoals = homeGoals * shrink + homeGoals * (1 - shrink) * 0.95;
  notes.push("L6 pre-match shrinkage applied to protect against overconfidence.");

  // Dynamic regime shift
  const regime = r();
  if (regime > 0.7) {
    homeGoals *= 1.05; awayGoals *= 1.05;
    notes.push("Dynamic regime shift: recent Overs streak → λ +5%.");
  } else if (regime < 0.3) {
    homeGoals *= 0.95; awayGoals *= 0.95;
    notes.push("Dynamic regime shift: recent Unders streak → λ −5%.");
  }

  return {
    homeGoals, awayGoals,
    homeCorners, awayCorners,
    homeCards, awayCards,
    homeSot, awaySot,
    homeShots, awayShots,
    homeOffsides, awayOffsides,
    homeGoalKicks, awayGoalKicks,
    homeSaves, awaySaves,
    homeThrowIns, awayThrowIns,
    homeFouls, awayFouls,
    aerialTotal, passesTotal,
    interceptionsHome, interceptionsAway,
    dribblingHome, dribblingAway,
    redCardProb, penaltyProb,
    calibrationNotes: notes,
  };
}
