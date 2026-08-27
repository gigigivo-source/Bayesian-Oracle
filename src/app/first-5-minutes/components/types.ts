export type First5MarketKey = "goal" | "corner" | "card" | "penalty";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type BaselineOrigin = "real" | "partial" | "league";

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
