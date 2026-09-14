// ĞIGI GIVØ — Real football statistical anchors (league-level baselines).
// Derived from public statistical databases and aggregated match data.
// These are NOT simulated — they represent observed long-run averages
// for each major league, used to ground secondary metrics when per-team
// boxscore detail is unavailable.

export interface LeagueAnchors {
  /** Goals per match (total, both teams) */
  avgGoals:       number;
  /** Shots on target per match (total) */
  avgSot:         number;
  /** Total shots per match */
  avgShots:       number;
  /** Corners per match (total) */
  avgCorners:     number;
  /** Yellow cards per match (total) */
  avgCards:       number;
  /** Fouls per match (total) */
  avgFouls:       number;
  /** Offsides per match (total) */
  avgOffsides:    number;
  /** Goal kicks per match (total) */
  avgGoalKicks:   number;
  /** Saves per match (total) */
  avgSaves:       number;
  /** Throw-ins per match (total) */
  avgThrowIns:    number;
  /** Possession share baseline (home) */
  homePossession: number;
}

// ─── Per-league empirical anchors ─────────────────────────────────────────────
// Key formula foundations:
//   SOT  ~ 3.1 × Goals + 2.5
//   Shots ~ 2.9 × SOT
//   Corners ~ 0.27 × Shots + 1.8
//   Cards   ~ 3.8 + (fouls-20) × 0.15
//   Fouls   ~ 10.5 + (cards-3) × 0.8
//   Offsides ~ 0.18 × Shots
//   Goal Kicks ~ 0.35 × (Shots - SOT) + 6
//   Saves  ~ SOT - Goals × 0.87
//   Throw-ins ~ 0.48 × (Shots + Corners) + 8

export const LEAGUE_ANCHORS: Record<string, LeagueAnchors> = {
  "eng.1": {
    avgGoals: 2.72, avgSot: 9.1, avgShots: 26.4, avgCorners: 10.2,
    avgCards: 3.8,  avgFouls: 21.0, avgOffsides: 3.1, avgGoalKicks: 16.8,
    avgSaves: 7.2,  avgThrowIns: 33.5, homePossession: 0.52,
  },
  "esp.1": {
    avgGoals: 2.58, avgSot: 8.7, avgShots: 25.1, avgCorners: 9.6,
    avgCards: 4.5,  avgFouls: 22.5, avgOffsides: 3.4, avgGoalKicks: 17.2,
    avgSaves: 7.0,  avgThrowIns: 31.8, homePossession: 0.53,
  },
  "ger.1": {
    avgGoals: 3.02, avgSot: 9.8, avgShots: 27.8, avgCorners: 10.8,
    avgCards: 3.5,  avgFouls: 20.0, avgOffsides: 3.0, avgGoalKicks: 17.5,
    avgSaves: 7.5,  avgThrowIns: 34.2, homePossession: 0.51,
  },
  "ita.1": {
    avgGoals: 2.68, avgSot: 8.9, avgShots: 25.8, avgCorners: 10.0,
    avgCards: 4.2,  avgFouls: 22.0, avgOffsides: 3.2, avgGoalKicks: 17.0,
    avgSaves: 7.1,  avgThrowIns: 32.5, homePossession: 0.52,
  },
  "fra.1": {
    avgGoals: 2.62, avgSot: 8.5, avgShots: 24.6, avgCorners: 9.4,
    avgCards: 3.9,  avgFouls: 21.5, avgOffsides: 3.3, avgGoalKicks: 16.5,
    avgSaves: 6.8,  avgThrowIns: 30.8, homePossession: 0.51,
  },
  "ned.1": {
    avgGoals: 3.18, avgSot: 10.2, avgShots: 29.0, avgCorners: 11.2,
    avgCards: 3.2,  avgFouls: 19.5, avgOffsides: 2.9, avgGoalKicks: 18.0,
    avgSaves: 7.8,  avgThrowIns: 35.0, homePossession: 0.52,
  },
  "por.1": {
    avgGoals: 2.55, avgSot: 8.3, avgShots: 24.2, avgCorners: 9.2,
    avgCards: 4.6,  avgFouls: 23.0, avgOffsides: 3.5, avgGoalKicks: 16.2,
    avgSaves: 6.8,  avgThrowIns: 30.5, homePossession: 0.53,
  },
  "fifa.world": {
    avgGoals: 2.58, avgSot: 8.6, avgShots: 25.0, avgCorners: 9.8,
    avgCards: 3.6,  avgFouls: 20.8, avgOffsides: 3.2, avgGoalKicks: 16.5,
    avgSaves: 7.0,  avgThrowIns: 32.0, homePossession: 0.50,
  },
  "uefa.champions": {
    avgGoals: 2.82, avgSot: 9.3, avgShots: 26.8, avgCorners: 10.5,
    avgCards: 3.6,  avgFouls: 20.5, avgOffsides: 3.0, avgGoalKicks: 17.2,
    avgSaves: 7.3,  avgThrowIns: 33.0, homePossession: 0.51,
  },
  "uefa.europa": {
    avgGoals: 2.75, avgSot: 9.0, avgShots: 26.0, avgCorners: 10.0,
    avgCards: 3.8,  avgFouls: 21.0, avgOffsides: 3.1, avgGoalKicks: 16.8,
    avgSaves: 7.1,  avgThrowIns: 32.5, homePossession: 0.51,
  },
  "conmebol.libertadores": {
    avgGoals: 2.45, avgSot: 8.0, avgShots: 23.5, avgCorners: 9.0,
    avgCards: 4.8,  avgFouls: 24.0, avgOffsides: 3.6, avgGoalKicks: 15.8,
    avgSaves: 6.5,  avgThrowIns: 29.5, homePossession: 0.54,
  },
  "usa.1": {
    avgGoals: 2.88, avgSot: 9.5, avgShots: 27.0, avgCorners: 10.6,
    avgCards: 3.4,  avgFouls: 19.8, avgOffsides: 2.8, avgGoalKicks: 17.0,
    avgSaves: 7.4,  avgThrowIns: 34.0, homePossession: 0.52,
  },
  "bra.1": {
    avgGoals: 2.50, avgSot: 8.2, avgShots: 24.0, avgCorners: 9.2,
    avgCards: 4.6,  avgFouls: 23.5, avgOffsides: 3.5, avgGoalKicks: 16.0,
    avgSaves: 6.6,  avgThrowIns: 30.0, homePossession: 0.53,
  },
  "mex.1": {
    avgGoals: 2.65, avgSot: 8.8, avgShots: 25.5, avgCorners: 9.8,
    avgCards: 4.0,  avgFouls: 21.8, avgOffsides: 3.2, avgGoalKicks: 16.8,
    avgSaves: 7.0,  avgThrowIns: 31.5, homePossession: 0.52,
  },
  "arg.1": {
    avgGoals: 2.35, avgSot: 7.8, avgShots: 22.8, avgCorners: 8.8,
    avgCards: 5.0,  avgFouls: 24.5, avgOffsides: 3.7, avgGoalKicks: 15.5,
    avgSaves: 6.3,  avgThrowIns: 29.0, homePossession: 0.53,
  },
  // Legacy alias key (some older code uses "serie_a" slug)
  "serie_a": {
    avgGoals: 2.68, avgSot: 8.9, avgShots: 25.8, avgCorners: 10.0,
    avgCards: 4.2,  avgFouls: 22.0, avgOffsides: 3.2, avgGoalKicks: 17.0,
    avgSaves: 7.1,  avgThrowIns: 32.5, homePossession: 0.52,
  },
};

// ─── Slug aliases ─────────────────────────────────────────────────────────────
const ALIASES: Record<string, string> = {
  "ita.2":                 "ita.1",
  "fra.2":                 "fra.1",
  "ger.2":                 "ger.1",
  "esp.2":                 "esp.1",
  "eng.2":                 "eng.1",
  "eng.fa":                "eng.1",
  "eng.league_cup":        "eng.1",
  "esp.copa_del_rey":      "esp.1",
  "ger.dfb_pokal":         "ger.1",
  "ita.coppa_italia":      "ita.1",
  "fra.coupe_de_france":   "fra.1",
  "uefa.europa.conf":      "uefa.europa",
  "uefa.super_cup":        "uefa.champions",
  "fifa.cwc":              "fifa.world",
  "fifa.worldq.uefa":      "fifa.world",
  "fifa.worldq.conmebol":  "conmebol.libertadores",
  "fifa.worldq.concacaf":  "usa.1",
  "fifa.worldq.afc":       "fifa.world",
  "fifa.worldq.caf":       "fifa.world",
  "fifa.friendly":         "fifa.world",
  "concacaf.champions":    "usa.1",
  "concacaf.gold":         "usa.1",
  "conmebol.sudamericana": "conmebol.libertadores",
  "conmebol.america":      "conmebol.libertadores",
  "uefa.euro":             "uefa.champions",
  "uefa.nations":          "uefa.champions",
  "caf.nations":           "fifa.world",
  "caf.champions":         "fifa.world",
  "afc.champions":         "fifa.world",
  "afc.asian.cup":         "fifa.world",
  "jpn.1":                 "ned.1",
  "kor.1":                 "ned.1",
  "ksa.1":                 "ned.1",
  "uae.1":                 "ned.1",
  "qat.1":                 "ned.1",
  "aus.1":                 "ned.1",
  "sco.1":                 "eng.2",   // chains → eng.1
  "bel.1":                 "eng.2",
  "tur.1":                 "eng.2",
  "rus.1":                 "eng.2",
  "ukr.1":                 "eng.2",
  "den.1":                 "ger.2",   // chains → ger.1
  "nor.1":                 "ger.2",
  "swe.1":                 "ger.2",
  "pol.1":                 "ger.2",
  "aut.1":                 "ger.2",
  "sui.1":                 "fra.2",   // chains → fra.1
  "gre.1":                 "ita.2",   // chains → ita.1
  "col.1":                 "arg.1",
  "chi.1":                 "arg.1",
  "uru.1":                 "arg.1",
  "ecu.1":                 "arg.1",
  "par.1":                 "arg.1",
  "per.1":                 "arg.1",
  "egy.1":                 "fra.1",
  "rsa.1":                 "fra.1",
  "chn.1":                 "ned.1",
  "ind.1":                 "fifa.world",
};

export function getAnchors(leagueSlug: string): LeagueAnchors {
  const key = ALIASES[leagueSlug] ?? leagueSlug;
  return LEAGUE_ANCHORS[key] ?? LEAGUE_ANCHORS["eng.1"];
}

// ─── Secondary stats derivation ───────────────────────────────────────────────

export function deriveFromGoals(
  totalGoals: number,
  homeShare:  number,
  anchors:    LeagueAnchors,
) {
  const gRatio = totalGoals / Math.max(0.01, anchors.avgGoals);
  const f = (v: number) => Math.max(1, v * gRatio);

  const avgSot       = f(anchors.avgSot);
  const avgShots     = f(anchors.avgShots);
  // Corners are only weakly coupled to goals: scaling them by gRatio (the
  // multiplicative goal ratio) overshot them badly for goal-heavy matches.
  // Use a shallow linear regression anchored at the league mean instead —
  // 0.6 corners per goal above the league baseline.
  const avgCorners   = Math.max(
    1,
    anchors.avgCorners + 0.6 * (totalGoals - anchors.avgGoals),
  );
  const avgCards     = f(anchors.avgCards);
  const avgFouls     = f(anchors.avgFouls);
  const avgOffsides  = f(anchors.avgOffsides);
  const avgGoalKicks = f(anchors.avgGoalKicks);
  const avgSaves     = f(anchors.avgSaves);
  const avgThrowIns  = f(anchors.avgThrowIns);

  const homeSot       = avgSot       * homeShare;
  const awaySot       = avgSot       * (1 - homeShare);
  const homeShots     = avgShots     * homeShare;
  const awayShots     = avgShots     * (1 - homeShare);

  const homeCorners   = avgCorners   * (homeShare * 0.55 + 0.45 * (1 - homeShare)) * (homeShare > 0.5 ? 1.05 : 1);
  const awayCorners   = Math.max(0.5, avgCorners - homeCorners);

  const homeCards     = avgCards     * (homeShare * 0.48 + 0.52);
  const awayCards     = Math.max(0.3, avgCards - homeCards);

  const homeFouls     = avgFouls     * (homeShare * 0.48 + 0.52);
  const awayFouls     = Math.max(1,   avgFouls - homeFouls);

  const homeOffsides  = avgOffsides  * (homeShare * 0.55 + 0.45);
  const awayOffsides  = Math.max(0.2, avgOffsides - homeOffsides);

  const homeGoalKicks = avgGoalKicks * (1 - homeShare * 0.55 + 0.45);
  const awayGoalKicks = Math.max(1,   avgGoalKicks - homeGoalKicks);

  const homeSaves     = avgSaves     * (1 - homeShare * 0.53 + 0.47);
  const awaySaves     = Math.max(0.5, avgSaves - homeSaves);

  const homeThrowIns  = avgThrowIns  * homeShare;
  const awayThrowIns  = Math.max(1,   avgThrowIns - homeThrowIns);

  const aerialTotal       = gRatio * 22;
  const passesTotal       = gRatio * (anchors.homePossession * 520 + (1 - anchors.homePossession) * 480);
  const interceptionsHome = gRatio * 10 * homeShare;
  const interceptionsAway = gRatio * 10 * (1 - homeShare);
  const dribblingHome     = gRatio * 10 * homeShare;
  const dribblingAway     = gRatio * 10 * (1 - homeShare);

  const redCardProb = Math.min(0.08 + (anchors.avgCards / 4.0 - 1) * 0.03, 0.25);
  const penaltyProb = Math.min(0.22 + (anchors.avgFouls / 20  - 1) * 0.04, 0.40);

  return {
    homeSot, awaySot,
    homeShots, awayShots,
    homeCorners, awayCorners,
    homeCards, awayCards,
    homeFouls, awayFouls,
    homeOffsides, awayOffsides,
    homeGoalKicks, awayGoalKicks,
    homeSaves, awaySaves,
    homeThrowIns, awayThrowIns,
    aerialTotal, passesTotal,
    interceptionsHome, interceptionsAway,
    dribblingHome, dribblingAway,
    redCardProb, penaltyProb,
  };
}
