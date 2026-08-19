// ĞIGI GIVØ — Value Detection Engine & Kelly Criterion Staking
import type { Market } from "./types";

// ─── Odds utilities ───────────────────────────────────────────────────────────

/** Convert American moneyline odds to decimal odds */
export function mlToDecimal(ml: number): number {
  if (ml > 0) return ml / 100 + 1;
  return 100 / Math.abs(ml) + 1;
}

/** Convert American moneyline to implied probability (no vig removal) */
export function mlToImpliedProb(ml: number): number {
  if (ml > 0) return 100 / (ml + 100);
  return Math.abs(ml) / (Math.abs(ml) + 100);
}

/** Remove vig from a two-way market to get fair probabilities */
export function devig(prob1: number, prob2: number): [number, number] {
  const total = prob1 + prob2;
  return [prob1 / total, prob2 / total];
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BookmakerOdds {
  provider:       string;
  homeML?:        number;
  drawML?:        number;
  awayML?:        number;
  overUnder?:     number;
  overOdds?:      number;   // American ML for Over
  underOdds?:     number;   // American ML for Under
  spreadHome?:    number;   // American ML for home spread
  spreadAway?:    number;   // American ML for away spread
  spreadLine?:    number;   // e.g. -2.5
  // Opening odds for CLV tracking
  openHomeML?:    number;
  openAwayML?:    number;
  openDrawML?:    number;
  openOverOdds?:  number;
  openUnderOdds?: number;
}

export interface ValueBet {
  market:                 Market;
  oracleProbability:      number;  // our calibrated probability
  bookImpliedProbability: number;  // bookmaker's implied prob (after devig)
  valueEdge:              number;  // oracle − book (positive = value)
  bookDecimalOdds:        number;  // what the bookmaker pays
  kellyStake:             number;  // optimal stake as fraction of bankroll
  expectedROI:            number;  // expected return per unit staked
  clvDirection:           "STEAM" | "DRIFT" | "STABLE" | null;
  provider:               string;
}

// ─── Main value-finder ────────────────────────────────────────────────────────

/** Find value bets: markets where oracle probability > bookmaker implied probability */
export function findValueBets(
  markets:  Market[],
  odds:     BookmakerOdds | null,
  homeName: string,
  awayName: string,
): ValueBet[] {
  if (!odds) return [];

  const valueBets: ValueBet[] = [];

  for (const m of markets) {
    if (m.rejected) continue;

    let bookOddsML:  number | null = null;
    let bookImplied  = 0;
    let clv: ValueBet["clvDirection"] = null;

    // ── Match market to bookmaker odds line ─────────────────────────────────

    // Total Goals O/U
    if (
      m.name.includes("Total Goals O/U") &&
      odds.overUnder &&
      odds.overOdds !== undefined &&
      odds.underOdds !== undefined
    ) {
      const line = parseFloat(m.name.split("O/U ")[1]);
      if (Math.abs(line - (odds.overUnder ?? 0)) < 0.01) {
        if (m.selection.startsWith("Over")) {
          bookOddsML = odds.overOdds;
          if (odds.openOverOdds) {
            const d = mlToDecimal(odds.overOdds);
            const od = mlToDecimal(odds.openOverOdds);
            clv = d < od ? "STEAM" : d > od ? "DRIFT" : "STABLE";
          }
        } else {
          bookOddsML = odds.underOdds;
          if (odds.openUnderOdds) {
            const d = mlToDecimal(odds.underOdds);
            const od = mlToDecimal(odds.openUnderOdds);
            clv = d < od ? "STEAM" : d > od ? "DRIFT" : "STABLE";
          }
        }
      }
    }

    // Match Result / Double Chance
    else if (m.name.startsWith("Match Result") || m.name.includes("Double Chance")) {
      if ((m.selection.includes(homeName) || m.selection.includes("Home")) && odds.homeML) {
        bookOddsML = odds.homeML;
        if (odds.openHomeML)
          clv = mlToDecimal(odds.homeML) < mlToDecimal(odds.openHomeML) ? "STEAM" : "DRIFT";
      } else if (m.selection === "Draw" && odds.drawML) {
        bookOddsML = odds.drawML;
      } else if ((m.selection.includes(awayName) || m.selection.includes("Away")) && odds.awayML) {
        bookOddsML = odds.awayML;
        if (odds.openAwayML)
          clv = mlToDecimal(odds.awayML) < mlToDecimal(odds.openAwayML) ? "STEAM" : "DRIFT";
      }

      // Double Chance: derive implied prob from de-vigged 1X2 components
      if (m.name.includes("Double Chance") && odds.homeML && odds.drawML && odds.awayML) {
        const pH = mlToImpliedProb(odds.homeML);
        const pD = mlToImpliedProb(odds.drawML);
        const pA = mlToImpliedProb(odds.awayML);
        const tot = pH + pD + pA;
        const fairH = pH / tot, fairD = pD / tot, fairA = pA / tot;

        const pushDc = (implied: number) => {
          const dcDecimal = 1 / implied;
          const edge      = m.hitRate - implied;
          const b         = dcDecimal - 1;
          const kelly     = Math.max(0, Math.min(b > 0 ? (b * m.hitRate - (1 - m.hitRate)) / b : 0, 0.25));
          valueBets.push({
            market: m, oracleProbability: m.hitRate, bookImpliedProbability: implied,
            valueEdge: edge, bookDecimalOdds: dcDecimal, kellyStake: kelly,
            expectedROI: m.hitRate * (dcDecimal - 1) - (1 - m.hitRate),
            clvDirection: null, provider: odds.provider ?? "Unknown",
          });
        };

        if      (m.name.includes("1X")) pushDc(fairH + fairD);
        else if (m.name.includes("X2")) pushDc(fairD + fairA);
        else if (m.name.includes("12")) pushDc(fairH + fairA);
        continue;
      }
    }

    // ── Compute edge & Kelly ────────────────────────────────────────────────

    let bookDecimal: number;

    if (bookOddsML !== null) {
      // Real bookmaker moneyline available for this market.
      bookDecimal  = mlToDecimal(bookOddsML);
      bookImplied  = 1 / bookDecimal; // raw implied (includes vig)
    } else {
      // SYNTHETIC FAIR-MARKET LINE (fallback for markets with no ML feed).
      // Estimate market's implied prob as the oracle prob pulled slightly toward
      // the coin-flip (a book that hasn't fully priced the edge) plus vig.
      // Value exists where the oracle's calibrated probability clears that
      // estimated market price by a meaningful margin.
      const marketBelief = 0.5 + (m.hitRate - 0.5) * 0.88;
      const fairImplied   = Math.min(0.97, marketBelief);
      bookImplied  = fairImplied;
      bookDecimal  = 1 / Math.max(0.02, fairImplied);
      // Require the WORST-CASE oracle probability (ciLower) to still beat the
      // market price by ≥3% — honest, conservative value only.
      if (m.ciLower - fairImplied < 0.03) continue;
    }

    const oracleProb = bookOddsML !== null ? m.hitRate : m.ciLower;
    const edge       = oracleProb - bookImplied;
    if (edge <= 0) continue;

    // Kelly Criterion: f* = (bp − q) / b
    const b      = bookDecimal - 1;
    const p      = oracleProb;
    const q      = 1 - p;
    const kelly  = Math.max(0, Math.min(b > 0 ? (b * p - q) / b : 0, 0.25));
    const expROI = p * (bookDecimal - 1) - q;

    valueBets.push({
      market:                 m,
      oracleProbability:      oracleProb,
      bookImpliedProbability: bookImplied,
      valueEdge:              edge,
      bookDecimalOdds:        bookDecimal,
      kellyStake:             kelly,
      expectedROI:            expROI,
      clvDirection:           clv,
      provider:               bookOddsML !== null ? (odds.provider ?? "Unknown") : "Fair Market Model",
    });
  }

  // Sort by edge descending
  return valueBets.sort((a, b) => b.valueEdge - a.valueEdge);
}

// ─── Staking utilities ────────────────────────────────────────────────────────

/** Calculate Kelly stake for a given probability and decimal odds */
export function kellyStake(
  probability:  number,
  decimalOdds:  number,
  fraction     = 0.25,
): number {
  const b         = decimalOdds - 1;
  const fullKelly = b > 0 ? (b * probability - (1 - probability)) / b : 0;
  // Fractional Kelly (quarter Kelly is standard for safety), capped at 10%
  return Math.max(0, Math.min(fullKelly * fraction, 0.10));
}

/** Calculate accumulator expected value */
export function accaExpectedValue(
  legs: Array<{ probability: number; decimalOdds: number }>,
): { combinedProb: number; combinedOdds: number; ev: number } {
  const combinedProb = legs.reduce((p, l) => p * l.probability, 1);
  const combinedOdds = legs.reduce((o, l) => o * l.decimalOdds, 1);
  const ev           = combinedProb * combinedOdds - 1;
  return { combinedProb, combinedOdds, ev };
}
