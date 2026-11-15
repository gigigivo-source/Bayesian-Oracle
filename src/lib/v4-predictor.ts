// V4 Predictor — True V2 Strict 3-Snipe System.
//
// The rule tree (Snipes + Locks) is pure and deterministic. A handful of rules
// consult expected goals when — and only when — the Engine's xG math supports a
// change from the flat V2 default:
//
//   · Mid-Table Deadlock — the 1-1 Snipe is dropped for a favourite's win when
//                      the Engine separates the two Mid-Table sides by more
//                      than a goal (the MW4 fix).
//   · Chaos Rule     — a 1-1 only while the Engine cannot separate the two
//                      sides; past the draw band the higher-xG side wins, home
//                      or away (the MW9, MW4 and draw-rule fixes). The one
//                      exception is a visitor at a Chaos host, which needs a
//                      much bigger edge for its away win.
//   · Top 4 Derby    — a Top 4 host loses its flat 2-0 to a narrow away win
//                      when the Engine cannot separate the two sides.
//   · Standard Away  — the flat 0-1 becomes a draw when the Engine cannot
//                      separate the two sides (the MW4 fix).
//
// Every one of those gates was fitted on the MW1–MW10 replay of the 2026-27
// season; the measurements behind them, including the variants that were
// measured and rejected, live next to the rule they gate.
//
// `generateV2Predictions` stays synchronous and engine-free; callers hand it an
// optional `xg` resolver (see `createMatchXgResolver`) when they can build one.

import { dixonColesGrid, DEFAULT_RHO, type DixonColesCell } from "./data/dixonColes";

export const TOP_4 = ["Arsenal", "Liverpool", "Man City", "Brighton"];
export const MID_TABLE = ["Fulham", "Brentford", "Everton", "Leeds", "Crystal Palace", "Newcastle", "Aston Villa"];
// Hull is deliberately in none of the lists: it plays as a Standard side.
// Hull was a Bottom 5 club until MW10 and lost only 3 of its first 10 matches.
// Measured on the MW1–MW10 replay, Standard instead of Bottom 5 scores 810
// against 790 (81.0 against 79.0, Floor 50 both ways): MW2 Coventry 0-1 Hull
// becomes an exact 0-1 (+20), MW7 Fulham 1-0 Hull an exact 1-0 (+10), and MW5
// Newcastle 2-1 Hull drops from an exact 2-1 to a 1-0 (-10), which leaves MW5
// on its guardrail of 100. Hull in MID_TABLE was measured too: 780, MW5 and
// MW7 at 90.
export const BOTTOM_5 = ["Coventry", "Ipswich", "Sunderland", "Burnley"];
export const CHAOS_TEAMS = ["Chelsea", "Man Utd", "Spurs"];

export const TEAM_NAME_MAP: Record<string, string> = {
  "Manchester City": "Man City",
  "Manchester United": "Man Utd",
  "Man United": "Man Utd",
  "Tottenham Hotspur": "Spurs",
  "Tottenham": "Spurs",
  "Brighton & Hove Albion": "Brighton",
  "Newcastle United": "Newcastle",
  "Nottingham Forest": "Nott'm Forest",
  "Leeds United": "Leeds",
  "Coventry City": "Coventry",
  "Hull City": "Hull",
  "Ipswich Town": "Ipswich",
  "AFC Bournemouth": "Bournemouth",
  "Wolverhampton Wanderers": "Wolves",
  "West Ham United": "West Ham",
  "Leicester City": "Leicester",
};

export function translateTeamName(espnName: string): string {
  const trimmed = espnName.trim();
  if (TEAM_NAME_MAP[trimmed]) return TEAM_NAME_MAP[trimmed];
  const stripped = trimmed
    .replace(/^AFC\s+/i, "")
    .replace(/\s+(?:AFC|FC)$/i, "")
    .trim();
  return TEAM_NAME_MAP[stripped] || stripped;
}

export type V2FixtureInput = [string, string] | { home: string; away: string };

export type Fixture = {
  home: string;
  away: string;
  prediction?: string | null;
  category?: string | null;
  targetPts?: number | null;
};

export type Actual = [number, number];
export type Prediction = {
  Match: string;
  Category: string;
  Prediction: string;
  Target_Pts: number;
};
export type ScoredPrediction = {
  Match: string;
  Prediction: string;
  Actual: string;
  Points: number;
  Status: string;
  MissReason: string;
};

const MAX_SNIPES = 3;

// ─── xG thresholds (V2 fix) ───────────────────────────────────────────────────
//
// Every threshold below is a *guard*: below it, the flat V2 rule is kept. These
// values were fitted by replaying MW1–MW10 of the 2026-27 season against the
// Engine's attack/defence model and keeping the tightest gate that preserves
// the MW5 (100), MW7 (100) and MW10 (90+) guardrails.

/**
 * Chaos Rule draw band: the pick is a 1-1 only while the xG gap is at or below
 * this. Past it the higher-xG side wins (2-1 at home, 1-2 away) — whether the
 * Chaos side is at home, away, or both sides are Chaos.
 *
 * Fitted on MW1–MW10 at the spec value. It is worth +30 there, all from a Chaos
 * side away from home that used to be locked to a 1-1 (MW1 Hull 2-0 Man Utd,
 * MW5 Brentford 3-0 Chelsea, MW7 Everton 0-2 Chelsea), and it sits inside a
 * narrow window: Brentford–Chelsea is a 0.153 gap, while the draws it must keep
 * are MW3 Nott'm Forest 0-0 Spurs at 0.135, MW5 Fulham 1-1 Man Utd at 0.106 and
 * MW7 Leeds 1-1 Man Utd at 0.092. See Rule 1 in `generateV2Predictions`.
 */
export const CHAOS_DRAW_MAX_XG_GAP = 0.15;
/**
 * xG edge a non-Chaos *visitor* needs over a Chaos host before the 1-1 becomes
 * a 1-2 — the one Chaos case that does not use the draw band.
 *
 * Measured at the draw band (0.15) and reverted: it wins MW2 Spurs 0-2
 * Newcastle (+10, a 0.20 away edge) but turns MW4 Chelsea 2-2 Hull (a 0.31 away
 * edge) from a correct 1-1 into a wrong 1-2, which drops MW4 from 50 to 40 and
 * takes the floor with it. Nothing on MW1–MW10 clears this bar, so the 1-2
 * branch behind it is unmeasured.
 */
export const CHAOS_VISITOR_XG_EDGE = 0.55;
/**
 * The xG edge a visiting Top 4 side needed to flip a Top 4 Derby to 0-1 / 1-2
 * on its own. Superseded by the tolerance pair below, kept documented so the
 * first (unconditional) derby design and its measurement are not lost.
 */
export const TOP4_DERBY_MIN_XG_EDGE = 0.4;
/**
 * Top 4 Derby: how much *better* the home side's xG may be and still lose the
 * flat 2-0 lock — the spec's "the away xG is higher, or within 0.1".
 */
export const TOP4_DERBY_AWAY_TOLERANCE = 0.1;
/**
 * Top 4 Derby: how big the visiting side's xG edge may be before the flip stops.
 *
 * This is the narrowing that keeps the MW5 guardrail. Flipping on *any* away
 * edge turns MW5's correct 2-0 into a wrong 0-1 (the Engine rates Brighton 0.86
 * vs Arsenal 1.72; Brighton won 3-0), so the flip only fires when the Engine
 * cannot separate the two sides. See Rule 2 for the measurement.
 */
export const TOP4_DERBY_MAX_AWAY_EDGE = 0.2;
/**
 * Mid-Table Deadlock: the xG gap above which two Mid-Table sides are no longer
 * a deadlock. Past it the 1-1 Snipe is dropped and the Engine's favourite takes
 * a win Lock instead; at or below it the 1-1 Snipe stands.
 *
 * The Chaos draw band (0.15) was measured here and reverted: it breaks the MW9
 * guardrail (80 -> 60, Aston Villa 1-1 Fulham is a 0.65 gap) and nets -40 over
 * MW1–MW10 — see the Deadlock Snipe in `generateV2Predictions`.
 */
export const MID_DEADLOCK_MAX_XG_GAP = 1.0;
/** Favourite xG from which the Mid-Table favourite's 2-1 becomes a 3-1. */
export const MID_FAVOURITE_BIG_WIN_XG = 2.5;
/**
 * Standard Away: the xG gap below which the flat 0-1 becomes a draw — the
 * Engine cannot separate the two sides, so the tier edge is not trusted alone.
 */
export const STANDARD_AWAY_DRAW_MAX_XG_GAP = 0.3;
/** xG gap that turns a Standard match into a 3-0 / 4-0 / 0-3 / 0-4 blowout. */
export const STANDARD_BLOWOUT_GAP = 1.2;
/** Per-side xG floor for the high-scoring Standard draw (2-2). */
export const STANDARD_DRAW_XG = 1.8;
/**
 * The Correct Score grid covers 0..maxGoals per side. V2 never chases 7+ goal
 * routs, and the argmax cell never depends on the tail, so this only needs to
 * cover realistic exact scores (e.g. 4-2).
 */
export const CORRECT_SCORE_MAX_GOALS = 6;

export type XgPair = readonly [homeXg: number, awayXg: number];

/**
 * Optional expected-goals lookup handed to `generateV2Predictions`.
 * Index-aligned with the fixture list, or `null` when no model is available —
 * in which case every xG-aware rule falls back to its flat V2 default.
 */
export type MatchXgResolver = (index: number, home: string, away: string) => XgPair | null;

/** Accepts only well-formed scorelines like "2-1"; anything else is ignored. */
export function isScoreline(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,2}-\d{1,2}$/.test(value);
}

/** Return the outcome implied by a prediction scoreline. */
export function getScorelineOutcome(prediction: string): "H" | "D" | "A" {
  const [h, a] = prediction.split("-").map(Number);
  if (h > a) return "H";
  if (h < a) return "A";
  return "D";
}

function normalizeFixturePair(fixture: V2FixtureInput): [string, string] {
  if (Array.isArray(fixture)) {
    return [translateTeamName(fixture[0]), translateTeamName(fixture[1])];
  }
  return [translateTeamName(fixture.home), translateTeamName(fixture.away)];
}

/**
 * Exact V2 Strict 3-Snipe System.
 *
 * 1. Counters: `fortressUsed`, `deadlocksUsed`, `eliteAwayUsed`. Max 3 Snipes total.
 * 2. Snipes (20-Point Targets):
 *    - Chaos teams are PERMANENTLY BANNED from Snipes.
 *    - Snipe 1: Top 4 (Home) vs Bottom 5 -> 2-0 (Max 1).
 *    - Snipe 2 & 3: Mid (Home) vs Mid -> 1-1 (Max 2), unless the Engine
 *      separates the two sides by more than MID_DEADLOCK_MAX_XG_GAP — that
 *      fixture is not a deadlock and falls through to the Mid-Table Favourite
 *      Lock without using a Snipe.
 *    - Snipe 3 Alternative: If there are not 2 Mid-Table Deadlocks, Top 4 (Away) -> 0-1.
 * 3. Locks (10-Point Targets):
 *    - Rule 1 (Chaos): 1-1 while the xG gap is within CHAOS_DRAW_MAX_XG_GAP;
 *      past it the higher-xG side wins, 2-1 at home or 1-2 away. A visitor at
 *      a Chaos host needs CHAOS_VISITOR_XG_EDGE for its 1-2 and gets a 1-1
 *      below that. Without xG: 2-1 for a Chaos host, 1-1 otherwise. NEVER 2-2.
 *    - Rule 2 (Smart Top 4 Home): Top 4 at Home (not vs Bottom 5) -> 2-0.
 *      Top 4 Derby: the visiting Top 4 side takes 0-1 when the Engine rates the
 *      two sides level; the flat 2-0 stands otherwise.
 *    - Rule 3 (Mid vs Bottom): Mid at Home vs Bottom 5 -> 2-1.
 *    - Rule 3b (Mid-Table Favourite): Mid vs Mid that the Engine separates by
 *      more than MID_DEADLOCK_MAX_XG_GAP -> the favourite wins 2-1 / 1-2
 *      (3-1 / 1-3 from MID_FAVOURITE_BIG_WIN_XG).
 *    - Rule 4 (Standard Default): Any other match -> 1-0 (Home) or 0-1 (Away).
 *      Standard Away becomes a 1-1 (2-2 when both sides clear STANDARD_DRAW_XG)
 *      when the xG gap is under STANDARD_AWAY_DRAW_MAX_XG_GAP.
 *
 * Without an `xg` resolver every rule above keeps its flat V2 line.
 */
export function generateV2Predictions(
  fixtures: readonly V2FixtureInput[],
  xg?: MatchXgResolver | null,
): Prediction[] {
  const pairs = fixtures.map(normalizeFixturePair);
  const picks: Array<Prediction | null> = new Array(pairs.length).fill(null);

  /** Ask the resolver for one fixture's xG, normalised to a pair of finite numbers. */
  const readXg = (index: number, home: string, away: string): XgPair | null => {
    if (!xg) return null;
    let pair: XgPair | null;
    try {
      pair = xg(index, home, away);
    } catch {
      return null;
    }
    if (!pair) return null;
    const [homeXg, awayXg] = pair;
    if (!Number.isFinite(homeXg) || !Number.isFinite(awayXg)) return null;
    return [homeXg, awayXg];
  };

  /** xG for one fixture, resolved once — the Deadlock Snipe and the Locks both read it. */
  const xgCache = new Map<number, XgPair | null>();
  const resolveXg = (index: number, home: string, away: string): XgPair | null => {
    if (!xgCache.has(index)) xgCache.set(index, readXg(index, home, away));
    return xgCache.get(index) ?? null;
  };

  let fortressUsed = 0;
  let deadlocksUsed = 0;
  let eliteAwayUsed = 0;
  const totalSnipes = () => fortressUsed + deadlocksUsed + eliteAwayUsed;

  // Snipe 1: Top 4 (Home) vs Bottom 5 -> 2-0 (Max 1)
  for (let i = 0; i < pairs.length; i += 1) {
    const [home, away] = pairs[i];
    if (CHAOS_TEAMS.includes(home) || CHAOS_TEAMS.includes(away)) continue;
    if (TOP_4.includes(home) && BOTTOM_5.includes(away) && fortressUsed < 1 && totalSnipes() < MAX_SNIPES) {
      fortressUsed += 1;
      picks[i] = {
        Match: `${home} vs ${away}`,
        Category: "SNIPE: Home Fortress",
        Prediction: "2-0",
        Target_Pts: 20,
      };
    }
  }

  // Snipe 2 & 3: Mid (Home) vs Mid -> 1-1 (Max 2)
  //
  // The MW4 fix (the Leeds trap): two Mid-Table sides are only a deadlock while
  // the Engine cannot separate them. When the xG gap is over
  // MID_DEADLOCK_MAX_XG_GAP the fixture is skipped here — it uses no Snipe and
  // becomes the Mid-Table Favourite Lock (Rule 3b) below.
  //
  // Measured on MW1–MW10: the widest Mid-vs-Mid gap on the window is 0.96
  // (MW9 Newcastle–Everton), so this gate changes no pick and no score there.
  // It also cannot rescue the fixture it is named after: the Engine rated
  // MW4 Leeds 1.26 vs Newcastle 1.73 — a 0.47 edge for the *away* side — and
  // Leeds won 4-1, so any gap low enough to fire would have picked Newcastle.
  //
  // Lowering the gate to the Chaos draw band (0.15) was measured and reverted.
  // Eight of the eleven Deadlocks on the window sit above 0.15 and the Engine's
  // favourite won one of them (MW8 Crystal Palace 0-2 Newcastle, +10). Three
  // were draws the Snipe already had: MW2 Leeds 1-1 Brentford (-20), MW6 Aston
  // Villa 2-2 Brentford (-10) and MW9 Aston Villa 1-1 Fulham (-20), which takes
  // MW9 from 80 to 60 and breaks the guardrail. Net -40.
  for (let i = 0; i < pairs.length; i += 1) {
    if (picks[i] !== null) continue;
    const [home, away] = pairs[i];
    if (CHAOS_TEAMS.includes(home) || CHAOS_TEAMS.includes(away)) continue;
    if (MID_TABLE.includes(home) && MID_TABLE.includes(away) && deadlocksUsed < 2 && totalSnipes() < MAX_SNIPES) {
      const midXg = resolveXg(i, home, away);
      if (midXg !== null && Math.abs(midXg[0] - midXg[1]) > MID_DEADLOCK_MAX_XG_GAP) continue;
      deadlocksUsed += 1;
      picks[i] = {
        Match: `${home} vs ${away}`,
        Category: "SNIPE: Mid-Table Deadlock",
        Prediction: "1-1",
        Target_Pts: 20,
      };
    }
  }

  // Snipe 3 Alternative: If there are not 2 Mid-Table Deadlocks, Top 4 (Away) -> 0-1
  //
  // This Snipe stays a pure rule. A "home xG more than 0.5 ahead -> home win"
  // override was specified for it and for Standard Away; no Top 4 visitor on
  // MW1–MW10 faces a home edge that large (the widest is MW1 Newcastle 1.90 vs
  // Liverpool 1.57, a 0.33 edge, and that match was drawn), so it could not be
  // measured here, and the Standard Away half of the same override lost points
  // (see Rule 4). Neither half is applied.
  if (deadlocksUsed < 2) {
    for (let i = 0; i < pairs.length; i += 1) {
      if (picks[i] !== null) continue;
      const [home, away] = pairs[i];
      if (CHAOS_TEAMS.includes(home) || CHAOS_TEAMS.includes(away)) continue;
      if (!TOP_4.includes(home) && TOP_4.includes(away) && totalSnipes() < MAX_SNIPES) {
        eliteAwayUsed += 1;
        picks[i] = {
          Match: `${home} vs ${away}`,
          Category: "SNIPE: Elite Away",
          Prediction: "0-1",
          Target_Pts: 20,
        };
      }
    }
  }

  // Locks (10-Point Targets)
  return pairs.map(([home, away], i) => {
    if (picks[i] !== null) return picks[i]!;

    const homeIsTop4 = TOP_4.includes(home);
    const awayIsTop4 = TOP_4.includes(away);
    const homeIsMid = MID_TABLE.includes(home);
    const awayIsMid = MID_TABLE.includes(away);
    const homeIsBottom5 = BOTTOM_5.includes(home);
    const awayIsBottom5 = BOTTOM_5.includes(away);
    const homeIsChaos = CHAOS_TEAMS.includes(home);
    const awayIsChaos = CHAOS_TEAMS.includes(away);
    const homeIsStandard = !homeIsTop4 && !homeIsMid && !homeIsBottom5 && !homeIsChaos;
    const awayIsStandard = !awayIsTop4 && !awayIsMid && !awayIsBottom5 && !awayIsChaos;

    // Resolve the Engine's xG once per fixture; `null` means the flat V2 line.
    const xg = resolveXg(i, home, away);

    /** The locked winner (`"H"` / `"D"` / `"A"`) and the flat V2 fallback. */
    let outcome: "H" | "D" | "A";
    let fallback: string;
    let category: string;

    // Rule 1 (Chaos): a 1-1 while the Engine cannot separate the two sides, the
    // higher-xG side's win line (2-1 home / 1-2 away) once it can. NEVER 2-2.
    //
    // The draw band is CHAOS_DRAW_MAX_XG_GAP. History of the rule on MW1–MW10:
    //
    //   · The MW9 fix gave a Chaos host and the better of two Chaos sides the
    //     win line (Spurs 2-0 Crystal Palace, Chelsea 2-0 Man Utd).
    //   · The draw-rule fix extended that to a Chaos side away from home, in
    //     both directions. Until then it needed a 0.55 edge for its 1-2 and the
    //     home side could never win, so MW1 Hull 2-0 Man Utd (Hull +0.19), MW5
    //     Brentford 3-0 Chelsea (Brentford +0.15) and MW7 Everton 0-2 Chelsea
    //     (Chelsea +0.21) were all 1-1 misses: +30, taking MW5 and MW7 to 110.
    //     MW10 Leeds 1-0 Spurs (Spurs +0.29) is still a miss, now as a 1-2.
    //   · The band has to stay this narrow *and* this wide. The fully
    //     unconditional away 1-2 costs MW5 and MW7 an exact 1-1 each (Fulham
    //     1-1 Man Utd at 0.11, Leeds 1-1 Man Utd at 0.09). A stricter host gate
    //     of 0.3 costs MW9 its guardrail (Spurs 2-0 Crystal Palace is a 0.25
    //     edge). Spurs 0-0 Everton (MW4) is a 0.35 edge for Spurs and stays a
    //     2-1 miss under every one of these gates.
    //   · A visitor at a Chaos host is the exception: it needs
    //     CHAOS_VISITOR_XG_EDGE, not the draw band, because the band turns MW4
    //     Chelsea 2-2 Hull (Hull +0.31) from a correct 1-1 into a wrong 1-2 and
    //     drops the floor from 50 to 40.
    //
    // Top 4 precedence is unchanged: a Chaos side hosting a Top 4 side stays
    // 1-2 (MW4 Man Utd 0-1 Man City), and a Top 4 host of a Chaos side stays
    // 2-1 (MW3 Arsenal 2-1 Chelsea, an exact 20).
    if (homeIsChaos || awayIsChaos) {
      category = "LOCK: Chaos Rule";
      const chaosGap = xg === null ? null : xg[0] - xg[1];
      const chaosHostsVisitor = homeIsChaos && !awayIsChaos;
      const awayWinEdge = chaosHostsVisitor ? CHAOS_VISITOR_XG_EDGE : CHAOS_DRAW_MAX_XG_GAP;
      if (homeIsTop4) {
        outcome = "H";
        fallback = "2-1";
      } else if (awayIsTop4) {
        outcome = "A";
        fallback = "1-2";
      } else if (chaosGap === null ? chaosHostsVisitor : chaosGap > CHAOS_DRAW_MAX_XG_GAP) {
        outcome = "H";
        fallback = "2-1";
      } else if (chaosGap !== null && -chaosGap > awayWinEdge) {
        outcome = "A";
        fallback = "1-2";
      } else {
        outcome = "D";
        fallback = "1-1";
      }
    } else if (homeIsTop4) {

    // Rule 2 (Smart Top 4 Home): Top 4 at Home -> 2-0. In a Top 4 Derby the flat
    // lock is dropped when the Engine cannot separate the two sides, and the
    // visiting Top 4 side takes a narrow away win instead.
    //
    // The MW9 fix: Liverpool 0-1 Arsenal was locked to a 2-0 home win.
    //
    // Why the flip is bounded on *both* sides — the full MW1–MW10 measurement:
    //   · Flipping on any away xG edge (the unconditional version) is worth +20
    //     net and also lifts MW9 to 80, but the Engine rates Brighton 0.86 vs
    //     Arsenal 1.72, so it turns MW5's correct 2-0 (Brighton won 3-0) into a
    //     wrong 0-1: MW5 100 → 90, which breaks the guardrail. No xG-based rule
    //     separates the two games: Liverpool–Arsenal is a 0.18 away edge and
    //     Brighton–Arsenal a 0.86 away edge, so anything that flips the first
    //     flips the second. Bounding the flip to a coin flip (TOP4_DERBY_MAX_
    //     AWAY_EDGE) keeps Brighton at 2-0 and MW5 at 100.
    //   · The Engine's *direction* is not trusted in derbies — it picks the
    //     winner in only 2 of the 5 derbies on this window (it rated Arsenal
    //     1.72 at Brighton, who won 3-0, and Man City 2.65 vs Brighton, who lost
    //     0-1). Only its *indecision* is used here.
    //   · Man City 0-1 Brighton, the other MW9 derby miss, is therefore not
    //     fixable by xG at all: the home edge is 1.50, far outside the band, so
    //     the 2-0 stands. That miss is variance, not a rule bug.
      const derbyGap = xg === null ? null : xg[0] - xg[1];
      const derbyIsCoinFlip =
        derbyGap !== null &&
        derbyGap <= TOP4_DERBY_AWAY_TOLERANCE &&
        derbyGap >= -TOP4_DERBY_MAX_AWAY_EDGE;
      if (awayIsTop4 && derbyIsCoinFlip) {
        outcome = "A";
        fallback = "0-1";
      } else {
        outcome = "H";
        fallback = "2-0";
      }
      category = "LOCK: Smart Top 4 Home";
    } else if (homeIsMid && awayIsBottom5) {

    // Rule 3 (Mid vs Bottom): Mid at Home vs Bottom 5 -> 2-1.
      outcome = "H";
      fallback = "2-1";
      category = "LOCK: Mid vs Bottom";
    } else if (
      homeIsMid &&
      awayIsMid &&
      xg !== null &&
      Math.abs(xg[0] - xg[1]) > MID_DEADLOCK_MAX_XG_GAP
    ) {

    // Rule 3b (Mid-Table Favourite): two Mid-Table sides the Engine separates
    // by more than MID_DEADLOCK_MAX_XG_GAP are not a deadlock — the favourite
    // wins 2-1, or 3-1 once its own xG reaches MID_FAVOURITE_BIG_WIN_XG.
      const homeIsFavourite = xg[0] > xg[1];
      const bigWin = Math.max(xg[0], xg[1]) >= MID_FAVOURITE_BIG_WIN_XG;
      outcome = homeIsFavourite ? "H" : "A";
      fallback = homeIsFavourite ? (bigWin ? "3-1" : "2-1") : bigWin ? "1-3" : "1-2";
      category = "LOCK: Mid-Table Favourite";
    } else {

    // Rule 4 (Standard Default): Any other match -> Home or Away win.
    const awayIsStronger =
      awayIsTop4 ||
      (homeIsBottom5 && awayIsMid) ||
      (homeIsStandard && awayIsMid) ||
      (homeIsBottom5 && awayIsStandard);

    if (awayIsStronger) {

    // Standard Away — the MW4 fix (the Bournemouth trap): the tier edge alone
    // locked a 0-1, but when the Engine cannot separate the two sides (gap
    // under STANDARD_AWAY_DRAW_MAX_XG_GAP) these matches are draws: MW2
    // Bournemouth 1-1 Everton, MW4 Bournemouth 2-2 Brentford and MW8 Hull 1-1
    // Brentford were all 0-1 misses (+50 over MW1–MW10). The draw is a 1-1, or
    // a 2-2 when both sides clear STANDARD_DRAW_XG.
    //
    // Outside the draw band the away win stands, and two parts of the MW4 spec
    // were measured and reverted:
    //   · "Away edge -> 0-1 or 0-2" would bypass the Correct Score hybrid, which
    //     is what lands MW10 Ipswich 1-2 Bournemouth exactly; a flat 0-1 / 0-2
    //     there drops MW10 from 90 to 80 and breaks the guardrail. The hybrid
    //     keeps choosing the away scoreline.
    //   · "Home edge -> 1-0 or 2-1" is right once (MW9 Bournemouth 2-0 Leeds,
    //     +10) and wrong once where the flat line was exact (MW1 Nott'm Forest
    //     0-1 Leeds, -20), with the other three fixtures drawn either way. It
    //     nets -10 and pulls MW1 from 60 to 40, back to the old floor, so a home
    //     xG edge keeps the tier's away win.
    //     Re-measured with a 0.5 gate (the tier-override spec): the same two
    //     fixtures decide it — MW1 -20, MW9 +10, and MW3 Hull 0-0 Aston Villa
    //     scores 0 either way — so it still nets -10 and stays off.
      const standardGap = xg === null ? null : xg[0] - xg[1];
      category = "LOCK: Standard Away";
      if (standardGap !== null && Math.abs(standardGap) < STANDARD_AWAY_DRAW_MAX_XG_GAP) {
        const highScoring = xg !== null && Math.min(xg[0], xg[1]) >= STANDARD_DRAW_XG;
        outcome = "D";
        fallback = highScoring ? "2-2" : "1-1";
      } else {
        outcome = "A";
        fallback = "0-1";
      }
    } else {
      outcome = "H";
      fallback = "1-0";
      category = "LOCK: Standard Home";
    }
    }

    // Turn the locked winner into an exact score using the conservative
    // hybrid: keep the flat V2 scoreline when it is a top-3 grid cell for the
    // locked winner, otherwise take the Engine's #1 grid cell. Fall back to
    // the flat V2 line when the Engine is unavailable.
    const exact =
      xg === null ? null : pickCorrectScoreHybrid(xg[0], xg[1], outcome, fallback);

    return {
      Match: `${home} vs ${away}`,
      Category: category,
      Prediction: exact ?? fallback,
      Target_Pts: 10,
    };
  });
}

/**
 * Round a blowout margin to a legal scoreline: `3` for anything up to 3.5 xG,
 * `4` from 3.5 upward (and no further — V2 never predicts 5+ goals).
 */
export function blowoutGoals(xg: number): number {
  if (!Number.isFinite(xg)) return 3;
  return Math.min(4, Math.max(3, Math.round(xg)));
}

/**
 * The most probable exact scoreline from the Engine's Correct Score grid
 * (Dixon–Coles over the attack/defence xG lambdas) that is consistent with the
 * locked winner (`"H"` / `"D"` / `"A"`).
 *
 * Grid cells are Poisson × τ probabilities; only cells matching `outcome` are
 * eligible, and the absolute highest-probability cell wins. Ties resolve to the
 * first cell in grid order (fewer home goals, then fewer away goals), which is
 * deterministic across runs.
 *
 * Returns `null` when the grid holds no eligible cell — the caller then falls
 * back to the flat V2 scoreline.
 */
export function pickCorrectScore(
  homeXg: number,
  awayXg: number,
  outcome: "H" | "D" | "A",
  maxGoals: number = CORRECT_SCORE_MAX_GOALS,
  rho: number = DEFAULT_RHO,
): string | null {
  const grid = dixonColesGrid(homeXg, awayXg, rho, maxGoals);
  let best: DixonColesCell | null = null;
  for (const cell of grid.cells) {
    const cellOutcome =
      cell.homeGoals > cell.awayGoals
        ? "H"
        : cell.homeGoals < cell.awayGoals
          ? "A"
          : "D";
    if (cellOutcome !== outcome) continue;
    if (best === null || cell.probability > best.probability) best = cell;
  }
  return best ? `${best.homeGoals}-${best.awayGoals}` : null;
}

/**
 * Conservative hybrid for Lock exact scores.
 *
 * Keeps the tuned flat V2 scoreline when it is among the top 3 most probable
 * cells of the Engine's Correct Score grid (filtered to the locked winner),
 * otherwise takes the grid's #1 cell. This preserves flat-V2 guardrail weeks
 * (e.g. MW7 Fulham–Hull 1-0, MW7 Nott'm Forest–Arsenal 0-1) while still
 * letting the Engine override when it clearly disagrees with the flat line.
 *
 * Returns `null` when the grid holds no eligible cell — the caller then falls
 * back to the flat V2 scoreline.
 */
export function pickCorrectScoreHybrid(
  homeXg: number,
  awayXg: number,
  outcome: "H" | "D" | "A",
  flatScore: string,
  maxGoals: number = CORRECT_SCORE_MAX_GOALS,
  rho: number = DEFAULT_RHO,
): string | null {
  const grid = dixonColesGrid(homeXg, awayXg, rho, maxGoals);
  const eligible: DixonColesCell[] = [];
  for (const cell of grid.cells) {
    const cellOutcome =
      cell.homeGoals > cell.awayGoals
        ? "H"
        : cell.homeGoals < cell.awayGoals
          ? "A"
          : "D";
    if (cellOutcome !== outcome) continue;
    eligible.push(cell);
  }
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => b.probability - a.probability);
  const flatRank = eligible.findIndex(
    (c) => `${c.homeGoals}-${c.awayGoals}` === flatScore,
  );
  if (flatRank !== -1 && flatRank < 3) return flatScore;
  return `${eligible[0].homeGoals}-${eligible[0].awayGoals}`;
}

export const generatePredictions = generateV2Predictions;

// ─── Engine xG wiring ────────────────────────────────────────────────────────

/** Minimal shape of one completed match, as the history loaders return it. */

/**
 * Project route rows into the table's `Prediction` shape, falling back to
 * `generateV2Predictions` when the row carries only team names.
 */
export function buildPredictions(fixtures: Fixture[]): Prediction[] {
  const computed = generateV2Predictions(
    fixtures.map(({ home, away }) => ({ home, away })),
  );
  return fixtures.map((row, index) => {
    const v2 = computed[index];
    const resolved = isScoreline(row.prediction) ? row.prediction : v2.Prediction;
    const label =
      typeof row.category === "string" && row.category.trim() !== ""
        ? row.category.trim()
        : v2.Category;
    const targetPts =
      typeof row.targetPts === "number" && Number.isFinite(row.targetPts) && row.targetPts > 0
        ? row.targetPts
        : label.startsWith("SNIPE:")
          ? 20
          : 10;
    return {
      Match: v2.Match,
      Category: label,
      Prediction: resolved,
      Target_Pts: targetPts,
    };
  });
}

export function calculateScore(
  predictions: Prediction[],
  actuals: Actual[],
): [ScoredPrediction[], number] {
  let total = 0;
  const scored = predictions.map((row, index) => {
    const [predH, predA] = row.Prediction.split("-").map(Number);
    const [actH, actA] = actuals[index];
    const predOutcome = predH > predA ? "H" : predH < predA ? "A" : "D";
    const actOutcome = actH > actA ? "H" : actH < actA ? "A" : "D";
    let points: number;
    let status: string;
    if (predH === actH && predA === actA) [points, status] = [20, "🎯 EXACT (20 pts)"];
    else if (predOutcome === actOutcome) [points, status] = [10, "✅ OUTCOME (10 pts)"];
    else [points, status] = [0, "❌ MISSED (0 pts)"];
    total += points;
    const missReason =
      !isScoreline(row.Prediction)
        ? "—"
        : points === 0
          ? "❌ MISS: Wrong Outcome"
          : points === 10
            ? "❌ MISS: Wrong Score"
            : "—";
    return {
      Match: row.Match,
      Prediction: row.Prediction,
      Actual: `${actH}-${actA}`,
      Points: points,
      Status: status,
      MissReason: missReason,
    };
  });
  return [scored, total];
}
