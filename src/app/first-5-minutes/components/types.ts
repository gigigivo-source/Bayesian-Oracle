export type First5MarketKey = "goal" | "corner" | "card" | "penalty";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type BaselineOrigin = "real" | "partial" | "league";
export type First5DataQuality = "real" | "mixed" | "synthetic";

export interface First5ConfidenceBreakdown {
  dataQuality: First5DataQuality;
  /** Out of 40. */
  dataQualityPoints: number;
  /** Distinct real aggregator sources backing the prediction. */
  sourceCount: number;
  /** Out of 30. */
  sourceAgreementPoints: number;
  /** 0–100 — share of required inputs grounded in team-specific data. */
  completenessPct: number;
  /** Out of 30. */
  completenessPoints: number;
}

export interface First5OutcomeSide {
  label: "Yes" | "No";
  probability: number;
  hitRate: number;
  fairOdds: number;
  odds1xBet: number;
  confidence: Confidence;
}

export interface First5Market {
  id: string;
  key: First5MarketKey;
  label: string;
  shortLabel: string;
  icon: string;
  outcome: "Yes" | "No";
  probability: number;
  hitRate: number;
  fairOdds: number;
  odds: { yes: number; no: number; selected: number };
  yes: First5OutcomeSide;
  no: First5OutcomeSide;
  isGuaranteed: boolean;
  confidence: Confidence;
  expectedInWindow: number;
  expectedPerMatch: number;
  origin: BaselineOrigin;
  statsSource: string;
  source: string;
  reason: string;
  /** Where this market's baseline came from (display-only annotation). */
  dataQuality: First5DataQuality;
  /** 0–100 model-confidence score (quality 40% / source agreement 30% / completeness 30%). */
  confidenceScore: number;
  /** e.g. "SportScore (Real)" / "Synthetic Baseline (League Avg)" / "X (Real) + Synthetic". */
  dataSourceDetail: string;
  /** Per-factor breakdown behind the confidence score (hover tooltip). */
  confidenceBreakdown: First5ConfidenceBreakdown;
}

export interface First5Match {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  homeLogo: string | null;
  awayLogo: string | null;
  league: string;
  leagueSlug: string;
  leagueTier: number;
  date: string;
  venue: string | null;
  statsSource: string;
  dataOrigin: BaselineOrigin;
  realMarketCount: number;
  markets: First5Market[];
}

export interface First5MinutesData {
  generatedAt: string;
  windowMinutes: number;
  lookaheadDays: number;
  totalFixturesChecked: number;
  totalMatches: number;
  marketTypes: Array<{ key: First5MarketKey; label: string; icon: string }>;
  model: {
    description: string;
    matchMinutes: number;
    openingIntensity: Record<First5MarketKey, number>;
  };
  cache: { ttlMinutes: number; hit: boolean };
  matches: First5Match[];
  error?: string;
}
