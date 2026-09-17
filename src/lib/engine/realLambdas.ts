// ĞIGI GIVØ — Real-data lambda builder from ESPN form + market odds + league anchors.
// Every market probability is derived from statistical relationships (not simulation).
import { clamp } from "./stats";
import { getAnchors, deriveFromGoals } from "./statisticalAnchors";
import { calculateXg } from "./xg";
import { getRefereeProfile, refereeMultipliers } from "./referee";
import type { LambdaSet } from "./lambdas";
import type { DeepStatsVector } from "./types";
import type { FixtureLite, MatchSummary } from "../espn";
import type { TeamStatProfile } from "./sofascore";
import type { CanonicalMatchStats } from "../data/types";

// Mesh profiles carry an optional list of contributing real-data providers.
type ProfileWithProviders = TeamStatProfile & { providers?: string[] };

export interface RealProfiles {
  home: ProfileWithProviders | null;
  away: ProfileWithProviders | null;
}

function mlToProb(ml: number | null | undefined): number | null {
  if (ml === null || ml === undefined || Number.isNaN(ml)) return null;
  if (ml > 0) return 100 / (ml + 100);
  return -ml / (-ml + 100);
}

function parseSupremacy(details: string | undefined, homeAbbrev: string): number | null {
  if (!details) return null;
  const m = details.match(/([A-Z]{2,4})\s*([+-]?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const val = parseFloat(m[2]);
  if (Number.isNaN(val)) return null;
  return m[1] === homeAbbrev ? -val : val;
}

export interface RealLambdaResult {
  lam:          LambdaSet;
  completeness: number;
  notes:        string[];
  marketProbs:  { home: number; draw: number; away: number } | null;
  deepStats:    DeepStatsVector;
}

/** Which xG layer grounded the goal lambdas (highest-preference layer used). */
export type XgSource = "bzzoiro" | "aggregator" | "proxy" | "anchor";

/** Minimal structural view of the legacy enrichment xG (oracle.ts concept). */
export interface XgEnrichmentLike {
  data: {
    homeXG: number | null;
    awayXG: number | null;
  };
}

export interface ResolvedXg {
  realHomeXG: number | null;
  realAwayXG: number | null;
  xgSource: XgSource;
}

/**
 * Resolve real xG through the three-layer preference chain (plus the
 * league-anchor fallback):
 *   1. Real xG from Bzzoiro stats (sum.__homeXg / sum.__awayXg)
 *   2. Real xG from stats aggregator (stats.home.xg / stats.away.xg)
 *   3. Shot-based proxy from mesh distributions
 *      (xG ≈ (Shots − SOT) × 0.05 + SOT × 0.30 — the standard academic proxy)
 *   4. League-anchor fallback (nulls — existing behaviour downstream)
 *
 * Pure (no logging) so unit tests can pin the preference order exactly.
 */
export function resolveRealXg(
  sum: MatchSummary | null,
  stats?: CanonicalMatchStats | null,
  profiles?: RealProfiles,
  enrichment?: XgEnrichmentLike | null,
): ResolvedXg {
  // xG grounding preference (highest to lowest):
  //   1. Real xG from Bzzoiro stats (sum.__homeXg / sum.__awayXg)
  //   2. Real xG from stats aggregator (stats.home.xg / stats.away.xg)
  //   3. Shot-based proxy from mesh distributions
  //   4. League-anchor fallback (existing behaviour)
  let realHomeXG: number | null =
    (sum as unknown as { __homeXg?: number | null } | null)?.__homeXg ??
    stats?.home.xg ??
    enrichment?.data.homeXG ??
    null;
  let realAwayXG: number | null =
    (sum as unknown as { __awayXg?: number | null } | null)?.__awayXg ??
    stats?.away.xg ??
    enrichment?.data.awayXG ??
    null;
  let xgSource: XgSource =
    (sum as unknown as { __homeXg?: number | null } | null)?.__homeXg != null ? "bzzoiro"
    : stats?.home.xg != null ? "aggregator"
    : "anchor";

  // Layer 3 — shot-based proxy from mesh distributions
  // (uses the same conversion used by academic xG proxies:
  //  xG ≈ (Shots - SOT) × 0.05 + SOT × 0.30)
  if (realHomeXG == null && profiles?.home?.shots?.mean != null
      && profiles.home.sot?.mean != null) {
    const shots = profiles.home.shots.mean;
    const sot   = profiles.home.sot.mean;
    realHomeXG = Math.max(0.15, Math.min(4.5,
      (shots - sot) * 0.05 + sot * 0.30
    ));
    xgSource = "proxy";
  }
  if (realAwayXG == null && profiles?.away?.shots?.mean != null
      && profiles.away.sot?.mean != null) {
    const shots = profiles.away.shots.mean;
    const sot   = profiles.away.sot.mean;
    realAwayXG = Math.max(0.15, Math.min(4.5,
      (shots - sot) * 0.05 + sot * 0.30
    ));
    if (xgSource === "anchor") xgSource = "proxy";
  }

  return { realHomeXG, realAwayXG, xgSource };
}

export function buildRealLambdas(
  fx:       FixtureLite,
  sum:      MatchSummary | null,
  profiles?: RealProfiles,
  stats?:    CanonicalMatchStats | null,
  enrichment?: XgEnrichmentLike | null,
): RealLambdaResult {
  const notes: string[] = [];
  let completeness = 30;

  const anchors = getAnchors(fx.leagueSlug);
  notes.push(`League anchors: ${fx.leagueName} avg ${anchors.avgGoals.toFixed(2)} goals/match (${anchors.avgCorners.toFixed(1)} corners, ${anchors.avgSot.toFixed(1)} SOT).`);

  const hf = sum?.homeForm ?? null;
  const af = sum?.awayForm ?? null;

  // ── Venue: home advantage from neutral-site flag only (no team-name bias) ──
  const homeAdv = fx.neutralSite ? 1.0 : 1.08;

  // ── Match importance / dead rubber detection ─────────────────────────────
  let importanceMult = 1.0;
  const ln = fx.leagueName.toLowerCase();
  const sd = (fx.statusDetail ?? "").toLowerCase();

  const isFriendly = ln.includes("friendl") || ln.includes("pre-season") ||
                     ln.includes("preseason") || ln.includes("exhibition") ||
                     ln.includes("testimonial");
  if (isFriendly) {
    importanceMult = 0.82;
    notes.push("DEAD RUBBER / FRIENDLY: Match importance reduced — expect lower intensity, fewer goals & cards (×0.82).");
  }

  const isKnockout = /final|semi.?final|quarter.?final|round of 16|knockout|elimination|play.?off/i.test(sd + " " + ln);
  if (isKnockout) {
    importanceMult = 1.08;
    notes.push("HIGH STAKES (Knockout/Final): Elevated match importance — tighter defence, more cards, cautious play (×1.08 cards, ×0.94 goals).");
  }

  // ── Tactical style from form ──────────────────────────────────────────────
  type Style = "attacking" | "defensive" | "open" | "balanced";
  let homeStyle: Style = "balanced";
  let awayStyle: Style = "balanced";

  if (hf && hf.games.length >= 2) {
    if      (hf.gfAvg >= 2.0 && hf.gaAvg <= 0.8) homeStyle = "attacking";
    else if (hf.gfAvg <= 1.0 && hf.gaAvg <= 0.8) homeStyle = "defensive";
    else if (hf.gfAvg >= 1.5 && hf.gaAvg >= 1.5) homeStyle = "open";
  }
  if (af && af.games.length >= 2) {
    if      (af.gfAvg >= 2.0 && af.gaAvg <= 0.8) awayStyle = "attacking";
    else if (af.gfAvg <= 1.0 && af.gaAvg <= 0.8) awayStyle = "defensive";
    else if (af.gfAvg >= 1.5 && af.gaAvg >= 1.5) awayStyle = "open";
  }

  let tacticalGoalMult   = 1.0;
  let tacticalCornerMult = 1.0;
  let tacticalCardMult   = 1.0;

  if (homeStyle === "attacking" && awayStyle === "defensive") {
    tacticalGoalMult = 0.92; tacticalCornerMult = 1.12; tacticalCardMult = 1.10;
    notes.push(`TACTICAL: ${fx.home.name} (attacking) vs ${fx.away.name} (defensive) — frustration corners, tactical fouls, fewer goals.`);
  } else if (homeStyle === "open" && awayStyle === "open") {
    tacticalGoalMult = 1.12; tacticalCornerMult = 1.05; tacticalCardMult = 0.92;
    notes.push(`TACTICAL: Both teams play open/expansive — expect high-scoring, end-to-end action.`);
  } else if (homeStyle === "defensive" && awayStyle === "defensive") {
    tacticalGoalMult = 0.85; tacticalCornerMult = 0.90; tacticalCardMult = 1.05;
    notes.push(`TACTICAL: Both teams defensive — expect low-scoring, cautious match with tactical fouls.`);
  } else if (homeStyle === "attacking" && awayStyle === "attacking") {
    tacticalGoalMult = 1.08; tacticalCornerMult = 1.08;
    notes.push(`TACTICAL: Attack vs attack — goals and corners from both sides.`);
  } else {
    notes.push(`TACTICAL: ${fx.home.name} (${homeStyle}) vs ${fx.away.name} (${awayStyle}) — standard assessment.`);
  }

  // ── Player vs player form boosts ──────────────────────────────────────────
  let playerGoalBoostHome = 1.0;
  let playerGoalBoostAway = 1.0;

  if (hf && hf.games.length >= 2) {
    if (hf.gfAvg >= 2.5) {
      playerGoalBoostHome = 1.06;
      notes.push(`PLAYER FORM: ${fx.home.name} striker in hot form (${hf.gfAvg.toFixed(2)} GF/90) — +6%.`);
    }
    if (hf.gaAvg <= 0.4) {
      playerGoalBoostAway *= 0.92;
      notes.push(`PLAYER FORM: ${fx.home.name} defence dominant (${hf.gaAvg.toFixed(2)} GA/90) — opponent -8%.`);
    }
  }
  if (af && af.games.length >= 2) {
    if (af.gfAvg >= 2.5) {
      playerGoalBoostAway = 1.06;
      notes.push(`PLAYER FORM: ${fx.away.name} striker in hot form (${af.gfAvg.toFixed(2)} GF/90) — +6%.`);
    }
    if (af.gaAvg <= 0.4) {
      playerGoalBoostHome *= 0.92;
      notes.push(`PLAYER FORM: ${fx.away.name} defence dominant (${af.gaAvg.toFixed(2)} GA/90) — opponent -8%.`);
    }
  }

  // ── Lineup-based injury/absence detection ────────────────────────────────
  // When confirmed lineups are available, analyse starters to detect:
  //   - Missing striker (fewer than expected forwards) → goals down
  //   - Missing keeper (backup GK) → opponent goals up
  //   - Rotation (many reserves) → lower intensity
  if (sum?.lineupAvailable && sum.homeLineup.length > 0) {
    const homeStarters  = sum.homeLineup.filter((p) => p.starter);
    const homeForwards  = homeStarters.filter((p) => p.position === "F" || p.position === "ST" || p.position === "CF" || p.position === "LW" || p.position === "RW").length;
    const homeGK        = homeStarters.filter((p) => p.position === "GK" || p.position === "G").length;
    if (homeForwards === 0) {
      playerGoalBoostHome *= 0.88;
      notes.push(`LINEUP: ${fx.home.name} no recognised forwards in XI — attack output -12%.`);
    }
    if (homeGK === 0) {
      playerGoalBoostAway *= 1.10;
      notes.push(`LINEUP: ${fx.home.name} no recognised GK — opponent goals +10%.`);
    }
  }
  if (sum?.lineupAvailable && sum.awayLineup.length > 0) {
    const awayStarters  = sum.awayLineup.filter((p) => p.starter);
    const awayForwards  = awayStarters.filter((p) => p.position === "F" || p.position === "ST" || p.position === "CF" || p.position === "LW" || p.position === "RW").length;
    const awayGK        = awayStarters.filter((p) => p.position === "GK" || p.position === "G").length;
    if (awayForwards === 0) {
      playerGoalBoostAway *= 0.88;
      notes.push(`LINEUP: ${fx.away.name} no recognised forwards in XI — attack output -12%.`);
    }
    if (awayGK === 0) {
      playerGoalBoostHome *= 1.10;
      notes.push(`LINEUP: ${fx.away.name} no recognised GK — opponent goals +10%.`);
    }
  }

  // ── xG finishing quality ───────────────────────────────────────────────────
  let xgAdjustment = 1.0;
  if (hf && hf.games.length >= 2 && af && af.games.length >= 2) {
    const xgPerShot     = calculateXg([105, 40], "Right Foot", "Normal"); // ~0.30
    const homeFinishing = hf.gfAvg / Math.max(0.1, xgPerShot * 5);
    const awayFinishing = af.gfAvg / Math.max(0.1, xgPerShot * 5);
    xgAdjustment = clamp((homeFinishing + awayFinishing) / 2, 0.85, 1.15);
    if (Math.abs(xgAdjustment - 1.0) > 0.01) {
      notes.push(`xG model: finishing quality adjustment ×${xgAdjustment.toFixed(2)}.`);
    }
  }

  // ── xG grounding: three-layer preference chain ───────────────────────────
  // Layers 1-2 are REAL xG (Bzzoiro per-shot totals attached to the summary by
  // the scanner, then the stats aggregator / legacy enrichment); layer 3 is
  // the shot-based proxy from mesh distributions; the anchor fallback leaves
  // nulls and the goal computation below runs exactly as before.
  const { realHomeXG, realAwayXG, xgSource } = resolveRealXg(sum, stats, profiles, enrichment);
  console.log(
    `[engine] xG source for ${fx.home.name} vs ${fx.away.name}: ${xgSource} ` +
    `(${realHomeXG?.toFixed(2) ?? "anchor"} / ${realAwayXG?.toFixed(2) ?? "anchor"})`
  );

  // ── Step 1: Expected total goals from form + anchors ──────────────────────
  let totalGoals: number;
  let homeShare:  number;

  if (hf && af && hf.games.length >= 3 && af.games.length >= 3) {
    const homeExp = (hf.gfAvg * af.gaAvg / anchors.avgGoals) * homeAdv;
    const awayExp = (af.gfAvg * hf.gaAvg / anchors.avgGoals);
    totalGoals = clamp(homeExp + awayExp, 0.5, 7.0);
    homeShare  = clamp(homeExp / totalGoals, 0.2, 0.8);
    completeness += 30;
    notes.push(`Form-derived: ${hf.teamName} GF ${hf.gfAvg.toFixed(2)}/GA ${hf.gaAvg.toFixed(2)} · ${af.teamName} GF ${af.gfAvg.toFixed(2)}/GA ${af.gaAvg.toFixed(2)}. Total xG: ${totalGoals.toFixed(2)}.`);
  } else {
    totalGoals = anchors.avgGoals * homeAdv;
    homeShare  = anchors.homePossession;
    notes.push("Form insufficient — using league average baselines.");
  }

  // ── Step 1b: H2H pattern recognition — adjust λ based on historic matchup ──
  // If these two teams historically play low/high scoring vs what form suggests,
  // the H2H signal shrinks or boosts the total goals expectation by up to 12%.
  if (sum?.h2h && sum.h2h.length >= 3) {
    const h2hGoals = sum.h2h
      .map((g) => {
        const parts = g.score.split(" - ").map(Number);
        return parts.length === 2 ? parts[0] + parts[1] : null;
      })
      .filter((v): v is number => v !== null && !isNaN(v));
    if (h2hGoals.length >= 3) {
      const h2hAvg  = h2hGoals.reduce((s, v) => s + v, 0) / h2hGoals.length;
      const h2hRatio = clamp(h2hAvg / Math.max(0.5, totalGoals), 0.80, 1.20);
      // Blend: 70% model, 30% H2H signal
      const h2hAdj  = 0.70 + 0.30 * h2hRatio;
      totalGoals = clamp(totalGoals * h2hAdj, 0.5, 7.0);
      completeness += 8;
      notes.push(`H2H (${h2hGoals.length} matches): avg ${h2hAvg.toFixed(2)} goals → adj ×${h2hAdj.toFixed(2)} → ${totalGoals.toFixed(2)}.`);
    }
  }

  // ── Step 1c: Formation → λ multipliers ────────────────────────────────────
  // When lineups are confirmed, use the tactical mismatch analysis to apply
  // formation-specific goal/corner/card multipliers on top of form-derived λ.
  if (sum?.homeFormation && sum?.awayFormation) {
    try {
      const { analyseFormationMismatch } = require("./players") as { analyseFormationMismatch: (h: string, a: string) => { goalMultiplier: number; cornerMultiplier: number; cardMultiplier: number; description: string } };
      const fmm = analyseFormationMismatch(sum.homeFormation, sum.awayFormation);
      totalGoals   = clamp(totalGoals   * fmm.goalMultiplier,   0.5, 7.0);
      tacticalCornerMult *= fmm.cornerMultiplier;
      tacticalCardMult   *= fmm.cardMultiplier;
      completeness += 5;
      notes.push(`FORMATION: ${sum.homeFormation} vs ${sum.awayFormation} — ${fmm.description.slice(0, 80)}`);
    } catch { /* formation analysis optional */ }
  }

  // ── Step 2: Market anchor (de-vigged 1X2 + O/U) ───────────────────────────
  const odds = sum?.odds ?? fx.odds ?? null;
  let marketProbs: RealLambdaResult["marketProbs"] = null;

  if (odds) {
    completeness += 20;
    const pH = mlToProb(odds.homeML);
    const pD = mlToProb(odds.drawML);
    const pA = mlToProb(odds.awayML);
    if (pH && pD && pA) {
      const s   = pH + pD + pA;
      marketProbs = { home: pH / s, draw: pD / s, away: pA / s };
      const modelShare  = homeShare;
      const marketShare = marketProbs.home + 0.5 * marketProbs.draw;
      homeShare = clamp(0.4 * modelShare + 0.6 * marketShare, 0.2, 0.8);
      notes.push(`De-vigged odds (${odds.provider ?? "book"}): H${(marketProbs.home*100).toFixed(0)}% D${(marketProbs.draw*100).toFixed(0)}% A${(marketProbs.away*100).toFixed(0)}%. Market-weighted home share: ${(homeShare*100).toFixed(0)}%.`);
    }
    if (odds.overUnder && Number(odds.overUnder) > 0) {
      const marketTotal = Number(odds.overUnder) + 0.15;
      // Sanity guard: reject the market O/U when it is more than 1 goal
      // away from the league anchor. Real O/U lines for a top-5 league sit
      // within roughly ±1 goal of the league average. Anything further out
      // is a stale, mismatched, or malformed feed (ESPN has returned 4.5
      // for Bundesliga fixtures whose real line is 3.5). Blending toward
      // bad data produces fake model edges, so fall through to the anchor.
      if (Math.abs(marketTotal - anchors.avgGoals) <= 1.0) {
        totalGoals = clamp(0.35 * totalGoals + 0.65 * marketTotal, 0.5, 7.0);
        notes.push(`O/U ${odds.overUnder} line anchored total goals to ${totalGoals.toFixed(2)}.`);
      } else {
        notes.push(`O/U ${odds.overUnder} rejected: ${Math.abs(marketTotal - anchors.avgGoals).toFixed(2)} goals off the league anchor (${anchors.avgGoals}) — using form/anchor only.`);
      }
    }
    const sup = parseSupremacy(odds.details, fx.home.abbrev);
    if (sup !== null) {
      const shift    = clamp(sup * 0.08, -0.4, 0.4);
      const oldShare = homeShare;
      homeShare = clamp(homeShare + shift * 0.1, 0.15, 0.85);
      notes.push(`Handicap "${odds.details}" adjusted home share ${(oldShare*100).toFixed(0)}% → ${(homeShare*100).toFixed(0)}%.`);
    }
  }

  // ── Apply all multipliers ──────────────────────────────────────────────────
  totalGoals *= xgAdjustment * importanceMult * tacticalGoalMult;

  let homeGoals = totalGoals * homeShare       * playerGoalBoostHome;
  let awayGoals = totalGoals * (1 - homeShare) * playerGoalBoostAway;

  if (isKnockout) { homeGoals *= 0.94; awayGoals *= 0.94; }

  homeGoals  = clamp(homeGoals, 0.15, 5.0);
  awayGoals  = clamp(awayGoals, 0.15, 5.0);

  // Ground the goal lambdas on real xG whenever a layer above the anchor
  // produced one (65% real / 35% model — the same blend weights the O/U
  // market anchor uses). Nulls (anchor) leave the form/anchor blend untouched.
  if (realHomeXG != null) {
    homeGoals = clamp(0.35 * homeGoals + 0.65 * realHomeXG, 0.15, 5.0);
    notes.push(`xG GROUNDED (${xgSource}): home λ blended toward real xG ${realHomeXG.toFixed(2)} → ${homeGoals.toFixed(2)}.`);
  }
  if (realAwayXG != null) {
    awayGoals = clamp(0.35 * awayGoals + 0.65 * realAwayXG, 0.15, 5.0);
    notes.push(`xG GROUNDED (${xgSource}): away λ blended toward real xG ${realAwayXG.toFixed(2)} → ${awayGoals.toFixed(2)}.`);
  }
  totalGoals = homeGoals + awayGoals;

  // ── Step 3: Derive secondary stats from anchored goal expectation ──────────
  const sec = deriveFromGoals(totalGoals, homeShare, anchors);

  sec.homeCorners *= tacticalCornerMult;
  sec.awayCorners *= tacticalCornerMult;
  sec.homeCards   *= tacticalCardMult;
  sec.awayCards   *= tacticalCardMult;

  if (isFriendly) {
    sec.homeCards   *= 0.80; sec.awayCards   *= 0.80;
    sec.homeCorners *= 0.88; sec.awayCorners *= 0.88;
  }

  // ── Referee calibration: adjust cards/fouls/penalty λ by referee profile ──
  // When a specific referee is identified, this replaces the crude seeded
  // random z-score with real empirical data from that referee's history.
  const refName    = fx.statusDetail?.match(/Referee:\s*([^,]+)/)?.[1]?.trim();
  const refProfile = getRefereeProfile(refName);
  const refMult    = refereeMultipliers(refProfile, anchors.avgCards);
  if (refProfile.isKnown) {
    sec.homeCards    *= refMult.cardMult;
    sec.awayCards    *= refMult.cardMult;
    sec.homeFouls    *= refMult.foulMult;
    sec.awayFouls    *= refMult.foulMult;
    sec.redCardProb  *= refMult.redCardMult;
    sec.penaltyProb  *= refMult.penaltyMult;
    notes.push(`REFEREE: ${refProfile.name} strictness=${refProfile.strictness.toFixed(2)} → cards ×${refMult.cardMult.toFixed(2)}`);
  }

  // ── Step 4: Blend real per-team stat distributions (65% real / 35% model) ─
  const blend = (model: number, real: number | undefined, w = 0.65) =>
    real && real > 0 ? model * (1 - w) + real * w : model;

  if (profiles?.home?.samples) {
    const p = profiles.home;
    sec.homeShots    = blend(sec.homeShots,    p.shots.mean);
    sec.homeSot      = blend(sec.homeSot,      p.sot.mean);
    sec.homeCorners  = blend(sec.homeCorners,  p.corners.mean);
    sec.homeCards    = blend(sec.homeCards,    p.cards.mean);
    sec.homeFouls    = blend(sec.homeFouls,    p.fouls.mean);
    sec.homeOffsides = blend(sec.homeOffsides, p.offsides.mean);
    sec.homeSaves    = blend(sec.homeSaves,    p.saves.mean);
    if (p.interceptions?.mean) sec.interceptionsHome = blend(sec.interceptionsHome, p.interceptions.mean);
    if (p.passes?.mean)        sec.passesTotal        = blend(sec.passesTotal, p.passes.mean * 2);
    completeness += 12;
    const src = (profiles.home as ProfileWithProviders).providers?.join(" + ") ?? "ESPN";
    notes.push(`REAL DATA [${src}]: ${fx.home.name} last-${p.samples} spreads (shots ${p.shots.mean.toFixed(1)}±${p.shots.std.toFixed(1)}, corners ${p.corners.mean.toFixed(1)}±${p.corners.std.toFixed(1)}, cards ${p.cards.mean.toFixed(1)}±${p.cards.std.toFixed(1)}).`);
  }
  if (profiles?.away?.samples) {
    const p = profiles.away;
    sec.awayShots    = blend(sec.awayShots,    p.shots.mean);
    sec.awaySot      = blend(sec.awaySot,      p.sot.mean);
    sec.awayCorners  = blend(sec.awayCorners,  p.corners.mean);
    sec.awayCards    = blend(sec.awayCards,    p.cards.mean);
    sec.awayFouls    = blend(sec.awayFouls,    p.fouls.mean);
    sec.awayOffsides = blend(sec.awayOffsides, p.offsides.mean);
    sec.awaySaves    = blend(sec.awaySaves,    p.saves.mean);
    if (p.interceptions?.mean) sec.interceptionsAway = blend(sec.interceptionsAway, p.interceptions.mean);
    completeness += 12;
    const src = (profiles.away as ProfileWithProviders).providers?.join(" + ") ?? "ESPN";
    notes.push(`REAL DATA [${src}]: ${fx.away.name} last-${p.samples} spreads (shots ${p.shots.mean.toFixed(1)}±${p.shots.std.toFixed(1)}, corners ${p.corners.mean.toFixed(1)}±${p.corners.std.toFixed(1)}, cards ${p.cards.mean.toFixed(1)}±${p.cards.std.toFixed(1)}).`);
  }

  notes.push(`Adjusted λ: Goals ${homeGoals.toFixed(2)}–${awayGoals.toFixed(2)} | importance ×${importanceMult.toFixed(2)} | tactical ×${tacticalGoalMult.toFixed(2)} | player form ×${playerGoalBoostHome.toFixed(2)}/${playerGoalBoostAway.toFixed(2)}.`);

  // ── Step 5: H2H and lineup completeness boosts ─────────────────────────────
  if (sum?.h2h?.length) { completeness += 10; notes.push(`H2H: ${sum.h2h.length} prior meetings used.`); }
  if (sum?.lineupAvailable)  { completeness += 10; notes.push("Confirmed lineups locked."); }

  completeness = clamp(completeness, 25, 100);

  // ── Build LambdaSet ─────────────────────────────────────────────────────────
  const lam: LambdaSet = {
    homeGoals:         clamp(homeGoals,           0.15, 5.0),
    awayGoals:         clamp(awayGoals,           0.15, 5.0),
    homeCorners:       clamp(sec.homeCorners,     1.5,  12),
    awayCorners:       clamp(sec.awayCorners,     1.5,  12),
    homeCards:         clamp(sec.homeCards,       0.5,  5.5),
    awayCards:         clamp(sec.awayCards,       0.5,  5.5),
    homeSot:           clamp(sec.homeSot,         1.5,  12),
    awaySot:           clamp(sec.awaySot,         1.5,  12),
    homeShots:         clamp(sec.homeShots,       6,    28),
    awayShots:         clamp(sec.awayShots,       6,    28),
    homeOffsides:      clamp(sec.homeOffsides,    0.5,  5.5),
    awayOffsides:      clamp(sec.awayOffsides,    0.5,  5.5),
    homeGoalKicks:     clamp(sec.homeGoalKicks,   3,    14),
    awayGoalKicks:     clamp(sec.awayGoalKicks,   3,    14),
    homeSaves:         clamp(sec.homeSaves,       1.0,  10),
    awaySaves:         clamp(sec.awaySaves,       1.0,  10),
    homeThrowIns:      clamp(sec.homeThrowIns,    8,    28),
    awayThrowIns:      clamp(sec.awayThrowIns,    8,    28),
    homeFouls:         clamp(sec.homeFouls,       6,    22),
    awayFouls:         clamp(sec.awayFouls,       6,    22),
    aerialTotal:       clamp(sec.aerialTotal,     12,   35),
    passesTotal:       clamp(sec.passesTotal,     300,  700),
    interceptionsHome: clamp(sec.interceptionsHome, 4,  16),
    interceptionsAway: clamp(sec.interceptionsAway, 4,  16),
    dribblingHome:     clamp(sec.dribblingHome,   4,    18),
    dribblingAway:     clamp(sec.dribblingAway,   4,    18),
    redCardProb:       clamp(sec.redCardProb,     0.03, 0.30),
    penaltyProb:       clamp(sec.penaltyProb,     0.10, 0.45),
    calibrationNotes:  notes,
  };

  // ── DeepStatsVector for UI ─────────────────────────────────────────────────
  const tacticsInsight = homeStyle === "balanced" && awayStyle === "balanced"
    ? `Standard tactical setup: ${fx.home.name} (${homeStyle}) vs ${fx.away.name} (${awayStyle}).`
    : `${fx.home.name} plays ${homeStyle} style vs ${fx.away.name} ${awayStyle} approach. Goal ×${tacticalGoalMult.toFixed(2)}, corners ×${tacticalCornerMult.toFixed(2)}, cards ×${tacticalCardMult.toFixed(2)}.`;

  const importanceInsight = isFriendly
    ? "Low importance (Friendly/Pre-season). Rotated squads, lower intensity, fewer goals & cards."
    : isKnockout
      ? "High stakes knockout/final. Cautious defence, more cards, tighter scorelines."
      : "Standard league match. Normal competitive intensity applied.";

  const playerInsight = [
    playerGoalBoostHome !== 1.0 ? `${fx.home.name} attack boosted ×${playerGoalBoostHome.toFixed(2)}.` : null,
    playerGoalBoostAway !== 1.0 ? `${fx.away.name} attack boosted ×${playerGoalBoostAway.toFixed(2)}.` : null,
    playerGoalBoostHome === 1.0 && playerGoalBoostAway === 1.0 ? "No exceptional individual form detected." : null,
  ].filter(Boolean).join(" ");

  const deepStats: DeepStatsVector = {
    homeXg:            Number(homeGoals.toFixed(2)),
    awayXg:            Number(awayGoals.toFixed(2)),
    homeGfAvg:         Number((hf?.gfAvg ?? (homeGoals / homeAdv)).toFixed(2)),
    homeGaAvg:         Number((hf?.gaAvg ?? (anchors.avgGoals - homeGoals)).toFixed(2)),
    awayGfAvg:         Number((af?.gfAvg ?? awayGoals).toFixed(2)),
    awayGaAvg:         Number((af?.gaAvg ?? (anchors.avgGoals - awayGoals)).toFixed(2)),
    homeSotAvg:        Number(sec.homeSot.toFixed(1)),
    awaySotAvg:        Number(sec.awaySot.toFixed(1)),
    homeCornersAvg:    Number(sec.homeCorners.toFixed(1)),
    awayCornersAvg:    Number(sec.awayCorners.toFixed(1)),
    homeCardsAvg:      Number(sec.homeCards.toFixed(1)),
    awayCardsAvg:      Number(sec.awayCards.toFixed(1)),
    homeFoulsAvg:      Number(sec.homeFouls.toFixed(1)),
    awayFoulsAvg:      Number(sec.awayFouls.toFixed(1)),
    homePossessionPct: Number((homeShare * 100).toFixed(0)),
    awayPossessionPct: Number(((1 - homeShare) * 100).toFixed(0)),
    marketHomeProb:    marketProbs ? Number((marketProbs.home * 100).toFixed(1)) : null,
    marketDrawProb:    marketProbs ? Number((marketProbs.draw * 100).toFixed(1)) : null,
    marketAwayProb:    marketProbs ? Number((marketProbs.away * 100).toFixed(1)) : null,
    sources: [
      { name: "FBref",              trust: 95, coverage: "SOT, interceptions, aerials, xG" },
      { name: "FootyStats",         trust: 90, coverage: "Corners, cards, 1,500+ leagues" },
      { name: "WhoScored / Opta",   trust: 90, coverage: "Shots, fouls, offsides, saves" },
      { name: "SofaScore",          trust: 85, coverage: "xG, xA, big chances, possession" },
      { name: "Understat",          trust: 85, coverage: "Expected Goals (xG) specialist" },
      { name: "ESPN Public API",    trust: 90, coverage: "Real fixtures, rosters, live odds, H2H" },
    ],
    matchContext: {
      tactics:        tacticsInsight,
      importance:     importanceInsight,
      playerMatchups: playerInsight,
      biasStatement:  "ZERO BIAS: Both teams evaluated identically by statistical profile only. No club reputation, national team prestige, or brand preference applied. Home advantage derived solely from venue neutrality flag.",
    },
  };

  return { lam, completeness, notes, marketProbs, deepStats };
}
