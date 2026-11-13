// V4 scoreline systems. The backtest and the production route share these
// selectors so a reported result cannot come from a different implementation
// than the one users see. All probabilities are supplied by the same Engine
// price bundle; no selector reads a final score.
import {
  pickBestScoreForOutcome,
  pickMaxExpectedPoints,
  scoreOutcome,
  type ScoreCell,
} from "./markets";

export type V4Outcome = "H" | "D" | "A";
export type V4SystemId = "pure-ep" | "v2-hybrid" | "consensus" | "pure-engine" | "ep-draw-guard";
export interface V4PriceBundle {
  probs: { h: number; d: number; a: number };
  scores: ScoreCell[];
}
export interface V4Pick {
  system: V4SystemId;
  prediction: string;
  category: string;
  outcome: V4Outcome;
  ep: number;
  outcomeProbability: number;
  exactProbability: number;
  /** Consensus keeps the originating V2 rule visible for audit/UI purposes. */
  v2Category?: string;
  v2Prediction?: string;
}
export interface V4SystemDefinition {
  id: V4SystemId;
  name: string;
  description: string;
}

export const V4_SYSTEMS: readonly V4SystemDefinition[] = [
  { id: "pure-ep", name: "Pure EP (Current)", description: "Maximise 10 × P(outcome) + 10 × P(exact score) over the Engine grid." },
  { id: "v2-hybrid", name: "V2 Hybrid", description: "Keep V2 Home Fortress 2-0 and Mid-Table Deadlock 1-1 snipes (with the original quotas); use the Engine's modal score elsewhere." },
  { id: "consensus", name: "Consensus Override", description: "V2 chooses H/D/A, including its snipe quotas; the Engine chooses the most probable score in that outcome." },
  { id: "pure-engine", name: "Pure Engine", description: "Choose the highest-probability exact score on the Engine grid." },
  { id: "ep-draw-guard", name: "EP + Draw Guard", description: "Use Pure EP unless max(P(H), P(D), P(A)) is strictly below 45%; then force 1-1." },
];

export const DRAW_GUARD_THRESHOLD = 0.45;
export const V4_TOP_4 = ["Arsenal", "Liverpool", "Man City", "Brighton"] as const;
export const V4_MID_TABLE = ["Fulham", "Brentford", "Everton", "Leeds", "Crystal Palace", "Newcastle", "Aston Villa"] as const;
export const V4_BOTTOM_5 = ["Coventry", "Ipswich", "Hull", "Sunderland", "Burnley"] as const;
export const V4_CHAOS_TEAMS = ["Chelsea", "Man Utd", "Spurs"] as const;

export interface V2Prediction {
  home: string;
  away: string;
  prediction: string;
  category: string;
  targetPts: 10 | 20;
}

/**
 * Exact V2 Strict 3-Snipe hierarchy recovered from merged PR #191 (commit
 * 2e101f1d2b70660b59392dda5713e46b494d90b7). Input must be in kickoff order:
 * at most one fortress, two deadlocks and three total snipes; chaos teams are
 * never snipes. These are historical comparison rules, not team-strength claims.
 */
export function generateV2Predictions(fixtures: readonly { home: string; away: string }[]): V2Prediction[] {
  let fortressUsed = 0;
  let deadlocksUsed = 0;
  let totalSnipesUsed = 0;
  return fixtures.map(({ home, away }) => {
    const base = { home, away };
    const homeTop = (V4_TOP_4 as readonly string[]).includes(home);
    const awayTop = (V4_TOP_4 as readonly string[]).includes(away);
    const homeMid = (V4_MID_TABLE as readonly string[]).includes(home);
    const awayMid = (V4_MID_TABLE as readonly string[]).includes(away);
    const homeBottom = (V4_BOTTOM_5 as readonly string[]).includes(home);
    const awayBottom = (V4_BOTTOM_5 as readonly string[]).includes(away);
    const homeChaos = (V4_CHAOS_TEAMS as readonly string[]).includes(home);
    const awayChaos = (V4_CHAOS_TEAMS as readonly string[]).includes(away);
    const homeStandard = !homeTop && !homeMid && !homeBottom && !homeChaos;
    const awayStandard = !awayTop && !awayMid && !awayBottom && !awayChaos;
    const snipe = (prediction: string, category: string): V2Prediction => ({ ...base, prediction, category, targetPts: 20 });
    const lock = (prediction: string, category: string): V2Prediction => ({ ...base, prediction, category, targetPts: 10 });

    if (!homeChaos && !awayChaos) {
      if (homeTop && awayBottom && fortressUsed < 1) {
        fortressUsed++; totalSnipesUsed++;
        return snipe("2-0", "SNIPE: Home Fortress");
      }
      if (homeMid && awayMid && deadlocksUsed < 2) {
        deadlocksUsed++; totalSnipesUsed++;
        return snipe("1-1", "SNIPE: Mid-Table Deadlock");
      }
      if (awayTop && totalSnipesUsed < 3) {
        totalSnipesUsed++;
        return snipe("0-1", "SNIPE: Elite Away");
      }
    }
    if (homeChaos || awayChaos) {
      if (homeTop) return lock("2-1", "LOCK: Chaos Rule");
      if (awayTop) return lock("1-2", "LOCK: Chaos Rule");
      if (homeChaos && awayChaos) return lock("1-1", "LOCK: Chaos Rule");
      return homeChaos ? lock("2-1", "LOCK: Chaos Rule") : lock("1-2", "LOCK: Chaos Rule");
    }
    if (homeTop) return lock("2-0", "LOCK: Smart Top 4 Home");
    if (awayTop) return lock("0-1", "LOCK: Elite Away (Exhausted)");
    if (homeMid && awayBottom) return lock("2-1", "LOCK: Mid vs Bottom");
    if (homeBottom && awayMid) return lock("0-1", "LOCK: Bottom vs Mid");
    if (homeMid && awayStandard) return lock("1-0", "LOCK: Mid vs Standard");
    if (homeStandard && awayMid) return lock("0-1", "LOCK: Standard vs Mid");
    if (homeBottom && awayStandard) return lock("0-1", "LOCK: Bottom vs Standard");
    if (homeStandard && awayBottom) return lock("1-0", "LOCK: Standard vs Bottom");
    return lock("1-0", "LOCK: Standard Home");
  });
}

export function v4ScoreOutcome(homeGoals: number, awayGoals: number): V4Outcome {
  return scoreOutcome(homeGoals, awayGoals);
}

function pickFromCell(system: V4SystemId, bundle: V4PriceBundle, cell: ScoreCell | null | undefined, categoryPrefix: string, fallback = "1-1"): V4Pick {
  const [fh, fa] = fallback.split("-").map(Number);
  const homeGoals = cell?.homeGoals ?? fh;
  const awayGoals = cell?.awayGoals ?? fa;
  const outcome = scoreOutcome(homeGoals, awayGoals);
  const outcomeProbability = outcome === "H" ? bundle.probs.h : outcome === "D" ? bundle.probs.d : bundle.probs.a;
  const exactProbability = cell?.probability ?? 0;
  const prediction = `${homeGoals}-${awayGoals}`;
  return {
    system, prediction, category: `${categoryPrefix}: ${prediction}`, outcome,
    ep: 10 * outcomeProbability + 10 * exactProbability,
    outcomeProbability, exactProbability,
  };
}

export function pureExpectedPointsPick(bundle: V4PriceBundle): V4Pick {
  const best = pickMaxExpectedPoints(bundle.scores, { home: bundle.probs.h, draw: bundle.probs.d, away: bundle.probs.a });
  const cell = best && bundle.scores.find((c) => c.homeGoals === best.homeGoals && c.awayGoals === best.awayGoals);
  const pick = pickFromCell("pure-ep", bundle, cell, "MAX EP");
  // Preserve the legacy degenerate-grid contract: no priced cell means EP 0.
  return cell ? pick : { ...pick, ep: 0 };
}

export function pureEnginePick(bundle: V4PriceBundle): V4Pick {
  const best = [...bundle.scores].sort((a, b) =>
    b.probability - a.probability ||
    a.homeGoals + a.awayGoals - (b.homeGoals + b.awayGoals) ||
    a.homeGoals - b.homeGoals,
  )[0];
  return pickFromCell("pure-engine", bundle, best, "ENGINE");
}

export function consensusPick(bundle: V4PriceBundle, v2: V2Prediction): V4Pick {
  const outcome = v4ScoreOutcome(...v2.prediction.split("-").map(Number) as [number, number]);
  const modal = pickBestScoreForOutcome(bundle.scores, outcome);
  const cell = modal && bundle.scores.find((c) => c.homeGoals === modal.homeGoals && c.awayGoals === modal.awayGoals);
  return { ...pickFromCell("consensus", bundle, cell, "CONSENSUS", v2.prediction), v2Category: v2.category, v2Prediction: v2.prediction };
}

export function expectedPointsDrawGuardPick(bundle: V4PriceBundle): V4Pick {
  if (Math.max(bundle.probs.h, bundle.probs.d, bundle.probs.a) < DRAW_GUARD_THRESHOLD) {
    const oneOne = bundle.scores.find((c) => c.homeGoals === 1 && c.awayGoals === 1);
    return pickFromCell("ep-draw-guard", bundle, oneOne, "DRAW GUARD");
  }
  return { ...pureExpectedPointsPick(bundle), system: "ep-draw-guard" };
}

/** Select an entire slate. V2 quotas are consumed once, in kickoff order. */
export function selectV4Slate(
  system: V4SystemId,
  fixtures: readonly { home: string; away: string }[],
  bundles: readonly V4PriceBundle[],
): V4Pick[] {
  if (fixtures.length !== bundles.length) throw new Error("V4 fixtures and price bundles must align");
  const v2 = system === "v2-hybrid" || system === "consensus" ? generateV2Predictions(fixtures) : null;
  return bundles.map((bundle, index) => {
    const legacy = v2?.[index];
    switch (system) {
      case "pure-ep": return pureExpectedPointsPick(bundle);
      case "pure-engine": return pureEnginePick(bundle);
      case "ep-draw-guard": return expectedPointsDrawGuardPick(bundle);
      case "consensus": return consensusPick(bundle, legacy!);
      case "v2-hybrid": {
        // The requested hybrid names the 2-0 / 1-1 snipes explicitly. V2's
        // third snipe (Elite Away 0-1) is therefore Engine-priced here; the
        // consensus system still honours its original outcome and quotas.
        if (legacy!.targetPts === 20 && (legacy!.prediction === "2-0" || legacy!.prediction === "1-1")) {
          const [h, a] = legacy!.prediction.split("-").map(Number);
          const cell = bundle.scores.find((c) => c.homeGoals === h && c.awayGoals === a);
          return { ...pickFromCell(system, bundle, cell, legacy!.category), category: legacy!.category };
        }
        const enginePick = pureEnginePick(bundle);
        return { ...enginePick, system, category: `HYBRID: ${enginePick.prediction}` };
      }
    }
  });
}

/** The only realised-points rule used by the backtest: 20 / 10 / 0. */
export function scoreV4Prediction(prediction: string, actual: readonly [number, number]): 0 | 10 | 20 {
  if (!/^\d{1,2}-\d{1,2}$/.test(prediction)) throw new Error(`Invalid prediction: ${prediction}`);
  const [h, a] = prediction.split("-").map(Number);
  if (h === actual[0] && a === actual[1]) return 20;
  return scoreOutcome(h, a) === scoreOutcome(actual[0], actual[1]) ? 10 : 0;
}
