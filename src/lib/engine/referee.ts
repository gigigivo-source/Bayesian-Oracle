// ĞIGI GIVØ — Referee calibration module.
// Maps known referee names to their empirical cards/fouls rates.
// When a specific referee is identified (from ESPN summary or match data),
// this adjusts the cards and fouls λ to reflect that referee's actual style.

// Known referee profiles — sourced from multi-season aggregated stats.
// strictness > 1.0 = more cards than league avg; < 1.0 = lenient
const KNOWN_REFEREES: Record<string, {
  cardsPerGame:     number;
  foulsPerGame:     number;
  penaltiesPerGame: number;
  redCardRate:      number;
  strictness:       number;
}> = {
  // Premier League
  "M. Oliver":    { cardsPerGame: 4.8, foulsPerGame: 22.5, penaltiesPerGame: 0.32, redCardRate: 0.10, strictness: 1.38 },
  "A. Taylor":    { cardsPerGame: 4.5, foulsPerGame: 21.8, penaltiesPerGame: 0.28, redCardRate: 0.09, strictness: 1.29 },
  "C. Kavanagh":  { cardsPerGame: 3.2, foulsPerGame: 20.1, penaltiesPerGame: 0.22, redCardRate: 0.06, strictness: 0.91 },
  "P. Tierney":   { cardsPerGame: 3.0, foulsPerGame: 19.5, penaltiesPerGame: 0.20, redCardRate: 0.05, strictness: 0.86 },
  "S. Attwell":   { cardsPerGame: 3.8, foulsPerGame: 21.0, penaltiesPerGame: 0.25, redCardRate: 0.07, strictness: 1.09 },
  "J. Gillett":   { cardsPerGame: 4.1, foulsPerGame: 21.5, penaltiesPerGame: 0.26, redCardRate: 0.08, strictness: 1.17 },
  // UEFA
  "D. Orsato":    { cardsPerGame: 2.8, foulsPerGame: 19.0, penaltiesPerGame: 0.30, redCardRate: 0.07, strictness: 0.80 },
  "S. Marciniak": { cardsPerGame: 3.5, foulsPerGame: 20.5, penaltiesPerGame: 0.28, redCardRate: 0.08, strictness: 1.00 },
  "F. Zwayer":    { cardsPerGame: 3.9, foulsPerGame: 21.0, penaltiesPerGame: 0.35, redCardRate: 0.09, strictness: 1.11 },
  "I. Kovács":    { cardsPerGame: 4.2, foulsPerGame: 22.0, penaltiesPerGame: 0.29, redCardRate: 0.10, strictness: 1.20 },
  "C. Turpin":    { cardsPerGame: 4.4, foulsPerGame: 22.8, penaltiesPerGame: 0.31, redCardRate: 0.11, strictness: 1.26 },
  "A. Mateu Lahoz": { cardsPerGame: 6.2, foulsPerGame: 24.5, penaltiesPerGame: 0.38, redCardRate: 0.16, strictness: 1.77 },
  "G. Rocchi":    { cardsPerGame: 3.1, foulsPerGame: 19.8, penaltiesPerGame: 0.22, redCardRate: 0.06, strictness: 0.89 },
  "W. Kruzliak":  { cardsPerGame: 3.3, foulsPerGame: 20.2, penaltiesPerGame: 0.24, redCardRate: 0.07, strictness: 0.94 },
  "B. Dabanovic": { cardsPerGame: 5.1, foulsPerGame: 23.5, penaltiesPerGame: 0.33, redCardRate: 0.12, strictness: 1.46 },
  "J. Gil Manzano": { cardsPerGame: 5.8, foulsPerGame: 24.0, penaltiesPerGame: 0.36, redCardRate: 0.14, strictness: 1.66 },
  // Bundesliga
  "F. Brych":     { cardsPerGame: 3.6, foulsPerGame: 20.5, penaltiesPerGame: 0.30, redCardRate: 0.08, strictness: 1.03 },
  "D. Siebert":   { cardsPerGame: 3.4, foulsPerGame: 20.0, penaltiesPerGame: 0.25, redCardRate: 0.07, strictness: 0.97 },
  // Ligue 1
  "F. Letexier":  { cardsPerGame: 3.2, foulsPerGame: 20.0, penaltiesPerGame: 0.22, redCardRate: 0.06, strictness: 0.91 },
  // Serie A
  "M. Irrati":    { cardsPerGame: 4.3, foulsPerGame: 22.5, penaltiesPerGame: 0.28, redCardRate: 0.10, strictness: 1.23 },
  "L. Massa":     { cardsPerGame: 4.0, foulsPerGame: 21.8, penaltiesPerGame: 0.26, redCardRate: 0.09, strictness: 1.14 },
};

export interface RefereeProfile {
  name:             string;
  cardsPerGame:     number;
  foulsPerGame:     number;
  penaltiesPerGame: number;
  redCardRate:      number;
  strictness:       number;
  isKnown:          boolean;
}

/** League-average default profile used when referee is unknown */
const DEFAULT_PROFILE: Omit<RefereeProfile, "name" | "isKnown"> = {
  cardsPerGame:     3.5,
  foulsPerGame:     21.0,
  penaltiesPerGame: 0.27,
  redCardRate:      0.08,
  strictness:       1.0,
};

/**
 * Look up a referee by name (fuzzy match on last name or partial).
 * Returns the profile if found, or a league-average default if not.
 */
export function getRefereeProfile(refereeName?: string | null): RefereeProfile {
  if (!refereeName || refereeName === "Assigned near kickoff") {
    return { name: "Unknown", ...DEFAULT_PROFILE, isKnown: false };
  }

  // Exact match
  if (KNOWN_REFEREES[refereeName]) {
    return { name: refereeName, ...KNOWN_REFEREES[refereeName], isKnown: true };
  }

  // Fuzzy: last name match
  const lastName = refereeName.split(/[\s.]+/).filter(Boolean).pop()?.toLowerCase() ?? "";
  for (const [name, profile] of Object.entries(KNOWN_REFEREES)) {
    if (name.toLowerCase().includes(lastName) || lastName.length > 3 && name.toLowerCase().endsWith(lastName)) {
      return { name, ...profile, isKnown: true };
    }
  }

  return { name: refereeName, ...DEFAULT_PROFILE, isKnown: false };
}

/**
 * Apply a referee's strictness profile to card/foul λ values.
 * Returns multipliers to apply to the base λ set.
 */
export function refereeMultipliers(profile: RefereeProfile, leagueAvgCards: number): {
  cardMult:    number;
  foulMult:    number;
  penaltyMult: number;
  redCardMult: number;
} {
  const leagueAvg = leagueAvgCards || 3.5;
  const cardMult    = profile.isKnown
    ? profile.cardsPerGame / leagueAvg
    : profile.strictness;
  const foulMult    = profile.isKnown
    ? profile.foulsPerGame / 21.0
    : Math.sqrt(profile.strictness); // fouls scale less than cards
  const penaltyMult = profile.isKnown ? profile.penaltiesPerGame / 0.27 : 1.0;
  const redCardMult = profile.isKnown ? profile.redCardRate      / 0.08 : 1.0;

  return {
    cardMult:    Math.max(0.5, Math.min(2.5, cardMult)),
    foulMult:    Math.max(0.6, Math.min(2.0, foulMult)),
    penaltyMult: Math.max(0.4, Math.min(2.5, penaltyMult)),
    redCardMult: Math.max(0.3, Math.min(3.0, redCardMult)),
  };
}
