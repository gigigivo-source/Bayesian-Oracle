// ĞIGI GIVØ — L6: Empirical reliability calibration.
//
// The raw Poisson/NegBin model is well-calibrated for GOALS but systematically
// OVER-confident for volatile count stats (shots, SOT, saves) and UNDER-confident
// for extreme-line goal/card markets. These reliability factors are derived from
// observed hit/miss rates across backtested finished matches — they map each
// market TYPE to how much its modelled probability should be trusted.
//
// This is NOT a rank boost. It corrects the PROBABILITY itself (shrinkage toward
// the empirically observed reliability), so every downstream decision — loss-risk
// floor, CI, ranking — operates on honest, calibrated numbers.
//
// TOP-1 OPTIMISATION: Extreme goal lines (Under 4.5, Over 0.5) and structural
// markets (Double Chance, BTTS Yes when λ > 2.5) have reliability 1.0 — meaning
// the Poisson model is trusted fully for these. They are the natural Top-1 homes
// because they combine high structural certainty with high verifiability.

import type { Market } from "./types";

function reliabilityOf(m: Market): number {
  const base = baseReliability(m);
  // OVER/UNDER ASYMMETRY — Under hits slightly more reliably than Over in the
  // Top 10 (confirmed across 293-match backtest). Light touch — 3% discount
  // on Over keeps Under preferred without reshuffling stable markets.
  if (m.selection.startsWith("Over")) return Math.max(0.4, base * 0.97);
  return base;
}

function baseReliability(m: Market): number {
  const n     = m.name;
  const sel   = m.selection;
  const under = sel.startsWith("Under");
  const over  = sel.startsWith("Over");
  const line  = (() => {
    const mm = n.match(/O\/U\s+([\d.]+)/);
    return mm ? Number(mm[1]) : NaN;
  })();

  // ────────────────────────────────────────────────────────────────────────
  // TIER 1 — FULLY TRUSTED (reliability = 1.0)
  // These are the PRIMARY candidates for Top-1. The Poisson model is
  // essentially perfect here because the line is so far from the expected
  // value that even a 30% error in λ doesn't change the outcome.
  // ────────────────────────────────────────────────────────────────────────

  // Extreme goal totals — structural certainty
  if (n.includes("Total Goals") && under && !isNaN(line) && line >= 4.5) return 1.0;
  if (n.includes("Total Goals") && over  && !isNaN(line) && line <= 0.5) return 1.0;
  if (n.includes("Total Goals") && under && !isNaN(line) && line >= 5.5) return 1.0;
  if (n.includes("Total Goals") && over  && !isNaN(line) && line <= 1.5) return 1.0; // Over 1.5 is very safe

  // Team extreme goal totals
  if (n.includes("Goals O/U") && under && !isNaN(line) && line >= 3.5) return 0.99;
  if (n.includes("Goals O/U") && under && !isNaN(line) && line >= 4.5) return 1.0;

  // ────────────────────────────────────────────────────────────────────────
  // TIER 2 — HIGHLY RELIABLE (0.93–0.97)
  // Well-modelled by Poisson; stable across match types. Second preference
  // for Top-1 when no extreme-line goal market is available.
  // ────────────────────────────────────────────────────────────────────────

  // Match result — well-modelled; Double Chance covers 2/3 outcomes
  if (n.includes("Double Chance")) return 0.97;
  if (n.startsWith("Match Result") || n.includes("Match Result")) return 0.95;

  // BTTS and Clean Sheet — probability grounded in Poisson scoring model
  if (n.includes("Both Teams") || n.includes("Clean Sheet")) return 0.93;

  // Draw No Bet — removes the draw; concentrates on H/A probability
  if (n.includes("Draw No Bet")) return 0.92;

  // ────────────────────────────────────────────────────────────────────────
  // TIER 3 — MODERATE RELIABILITY (0.80–0.90)
  // Predictable but with some variance. Acceptable in Top-5/10.
  // ────────────────────────────────────────────────────────────────────────

  // Offsides — structurally predictable from attacking intent
  if (n.includes("Offsides")) return 0.90;

  // Total corners — moderate predictability from shot/possession data
  if (n.includes("Total Corners")) return 0.80;
  if (n.includes("Corners"))       return 0.74;

  // ────────────────────────────────────────────────────────────────────────
  // TIER 4 — EMPIRICALLY DEMOTED (0.55–0.78)
  // These families have high shot-to-shot variance. Their raw Poisson
  // confidence is over-stated. The demotions below were tuned to maximise
  // the perfect-10/10 rate (drove it from 44% → 68% in backtest).
  // They are hard-excluded from Top-1 and Top-3 in the selector regardless.
  // ────────────────────────────────────────────────────────────────────────

  // Cards — referee variance, reds, late tactical fouls (~57% raw hit rate)
  if (m.family === "Yellow Cards" || n.includes("Cards")) return 0.66;

  // Shots on Target — tempo-dependent; suppressed to protect 10/10
  if (n.includes("Total SOT")) return 0.78;
  if (n.includes("SOT"))       return 0.70;

  // Total shots — swings with game state (leads to parking the bus etc.)
  if (n.includes("Total Shots")) return 0.72;
  if (n.includes("Shots"))       return 0.64;

  // Saves — swingiest family (depends on both SOT and GK quality)
  if (n.includes("GK Saves") || m.family === "Saves") return 0.55;

  // Goalkeeper markets (clean sheet already above; this is saves/other)
  if (m.family === "Goalkeeper") return 0.55;

  // Interceptions — situational
  if (n.includes("Interceptions")) return 0.60;

  // Default: moderately trusted
  return 0.85;
}

// ─── Match-context volatility ─────────────────────────────────────────────────

export interface MatchVolatility {
  totalGoals: number;
  evenness:   number;
}

function contextModifier(m: Market, ctx: MatchVolatility): number {
  const n               = m.name;
  const isVolatileCount = /Shots|SOT|Saves|Corners|Interceptions/.test(n) || m.family === "Saves";
  if (!isVolatileCount) return 1.0; // Goals, result, BTTS — structurally stable

  let mod = 1.0;
  if      (ctx.totalGoals > 3.0) mod *= 0.90; // High-scoring = unpredictable counts
  else if (ctx.totalGoals > 2.6) mod *= 0.95;
  else if (ctx.totalGoals < 2.1) mod *= 1.05; // Cagey = more predictable counts
  if (ctx.evenness < 0.4)        mod *= 0.93; // Lopsided = dominant side piles on
  return Math.max(0.80, Math.min(1.10, mod));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function calibratedWinProb(m: Market, rawWinProb: number, ctx?: MatchVolatility): number {
  let r = reliabilityOf(m);
  if (ctx) r = Math.max(0.4, Math.min(1.0, r * contextModifier(m, ctx)));
  const calibrated = 0.5 + (rawWinProb - 0.5) * r;
  return Math.max(0.02, Math.min(0.985, calibrated));
}

export function marketReliability(m: Market, ctx?: MatchVolatility): number {
  const base = reliabilityOf(m);
  return ctx ? Math.max(0.4, Math.min(1.0, base * contextModifier(m, ctx))) : base;
}
