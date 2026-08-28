// ĞIGI GIVØ — Data Quality & Model Confidence scoring.
//
// Shared by /api/sure-corners and /api/first-5-minutes to annotate every
// market with WHY the prediction can be trusted — a 90%+ hit rate on top of a
// synthetic league-average baseline is far less reliable than the same hit
// rate grounded in real team-specific stats from several agreeing sources.
//
// The score is deliberately presentation-only: no route consumes it to
// accept or reject a market, so core prediction logic is untouched.
//
// ── Scoring model (0–100) ───────────────────────────────────────────────────
//   Factor              Weight  Mapping
//   Data Quality         40%    real = 100, mixed = 60, synthetic = 30
//   Source Agreement     30%    3+ sources = 100, 2 = 75, 1 = 50, 0 = 0
//   Stat Completeness    30%    % of required inputs grounded in real
//                               team-specific data (league/default-substituted
//                               inputs count as half, missing as zero)
//
// Each factor's points are rounded first (X/40, X/30, X/30) and the final
// confidenceScore is their SUM, so the displayed breakdown always adds up to
// the displayed score.
//
// Worked examples:
//   real + 3 sources + all stats present  → 40 + 30 + 30 = 100
//   real + 1 source  + all stats present  → 40 + 15 + 30 =  85
//   mixed + 2 sources + ~62% present      → 24 + 23 + 19  =  66
//   synthetic + 0 sources + 0% present    → 12 +  0 +  0  =  12

/** Where a market's prediction inputs ultimately came from. */
export type MarketDataQuality = "real" | "mixed" | "synthetic";

/** Raw (pre-weight) factor score for each data-quality tier. */
export const DATA_QUALITY_POINTS: Record<MarketDataQuality, number> = {
  real: 100,
  mixed: 60,
  synthetic: 30,
};

/** Factor weights of the 100-point confidence score. */
export const CONFIDENCE_WEIGHTS = {
  dataQuality: 0.4,
  sourceAgreement: 0.3,
  statCompleteness: 0.3,
} as const;

/** Synthetic-tier label used by the data-source detail string. */
export const SYNTHETIC_BASELINE_DETAIL = "Synthetic Baseline (League Avg)";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Source-agreement sub-score (0–100): how many distinct aggregator sources
 * contributed fields to the prediction. Multiple independent sources backing
 * the same stats is a strong signal; a single source cannot agree with
 * anything, so it caps at 50, and zero real sources scores 0.
 */
export function sourceAgreementScore(sourceCount: number): number {
  if (sourceCount >= 3) return 100;
  if (sourceCount === 2) return 75;
  if (sourceCount === 1) return 50;
  return 0;
}

/** Short human label for the stat-completeness factor. */
export function completenessLabel(completenessPct: number): string {
  if (completenessPct >= 100) return "All stats present";
  if (completenessPct <= 0) return "No team-specific stats";
  return `${Math.round(completenessPct)}% of stats present`;
}

/** Per-factor breakdown shipped with each market (drives the hover tooltip). */
export interface MarketConfidenceBreakdown {
  dataQuality: MarketDataQuality;
  /** Out of 40. */
  dataQualityPoints: number;
  /** Distinct real aggregator sources that contributed to this prediction. */
  sourceCount: number;
  /** Out of 30. */
  sourceAgreementPoints: number;
  /** 0–100 share of required inputs grounded in team-specific data. */
  completenessPct: number;
  /** Out of 30. */
  completenessPoints: number;
}

/** Full assessment returned by {@link assessMarketConfidence}. */
export interface MarketConfidenceAssessment extends MarketConfidenceBreakdown {
  /** 0–100 — sum of the three factor point scores. */
  confidenceScore: number;
  /** e.g. "SportScore (Real)", "Synthetic Baseline (League Avg)", "SportScore (Real) + Synthetic". */
  dataSourceDetail: string;
}

/**
 * Extract the per-factor display breakdown from a full assessment — shared by
 * both features so their API payloads stay identical in shape.
 */
export function toConfidenceBreakdown(
  assessment: MarketConfidenceAssessment,
): MarketConfidenceBreakdown {
  return {
    dataQuality: assessment.dataQuality,
    dataQualityPoints: assessment.dataQualityPoints,
    sourceCount: assessment.sourceCount,
    sourceAgreementPoints: assessment.sourceAgreementPoints,
    completenessPct: assessment.completenessPct,
    completenessPoints: assessment.completenessPoints,
  };
}

/**
 * Combine the three factors into the per-market confidence score and the
 * human-readable data-source detail string.
 */
export function assessMarketConfidence(args: {
  dataQuality: MarketDataQuality;
  /** Number of real aggregator sources that contributed (0 when synthetic). */
  sourceCount: number;
  /** 0–100 — share of required stats grounded in real team-specific data. */
  completenessPct: number;
  /** Names of the contributing real sources, priority order (may be empty). */
  sourceNames: string[];
}): MarketConfidenceAssessment {
  const dataQualityPoints = Math.round(
    DATA_QUALITY_POINTS[args.dataQuality] * CONFIDENCE_WEIGHTS.dataQuality,
  );
  const sourceAgreementPoints = Math.round(
    sourceAgreementScore(Math.max(0, Math.trunc(args.sourceCount))) * CONFIDENCE_WEIGHTS.sourceAgreement,
  );
  const completenessPct = clamp(args.completenessPct, 0, 100);
  const completenessPoints = Math.round(completenessPct * CONFIDENCE_WEIGHTS.statCompleteness);

  const names = [...new Set(args.sourceNames.map((name) => name.trim()).filter(Boolean))];
  let dataSourceDetail: string;
  if (args.dataQuality === "synthetic" || names.length === 0) {
    dataSourceDetail = SYNTHETIC_BASELINE_DETAIL;
  } else if (args.dataQuality === "mixed") {
    dataSourceDetail = `${names.join(" + ")} (Real) + Synthetic`;
  } else {
    dataSourceDetail = `${names.join(" + ")} (Real)`;
  }

  return {
    dataQuality: args.dataQuality,
    dataQualityPoints,
    sourceCount: Math.max(0, Math.trunc(args.sourceCount)),
    sourceAgreementPoints,
    completenessPct: Math.round(completenessPct * 10) / 10,
    completenessPoints,
    confidenceScore: clamp(
      dataQualityPoints + sourceAgreementPoints + completenessPoints,
      0,
      100,
    ),
    dataSourceDetail,
  };
}
