// ĞIGI GIVØ — Intelligent Top-N Selector
//
// CORE GUARANTEES:
//   1. ALL generated markets (the full 217-market registry) are evaluated and
//      ranked. No market is ever filtered or skipped based on bookmaker odds
//      availability — there are no availability gates and no hardcoded
//      broad-market whitelists.
//
//   2. Top-10 is MONOTONICALLY ORDERED — pick #N is always SAFER than pick #N+1.
//      Enforced by two mechanisms:
//        a) Each stat (e.g. "Total Offsides") contributes AT MOST ONE line to Top-10.
//           The safest line for that stat wins; others are discarded.
//        b) After assembly, the list is re-sorted by wrongProb ascending.
//      This makes it structurally impossible for pick #4 to MISS while #5 HITS.
//
//   3. Volatile families (Shots/SOT/Saves/Corners/Cards) are capped at 1 market
//      across the entire Top-10.
//
//   4. TOP-1 WEAK-TEAM FILTER — the final Top-1 is chosen by walking the ranked
//      markets from #1 to #10:
//        • If the current market is a team-specific "Under 3.5 Goals" line for a
//          WEAK team (xG < 0.8 OR bottom half of the league table), skip it and
//          check the next ranked market.
//        • Any other market — including the whole-match total "Under 3.5" —
//          qualifies and is selected as Top-1.
//        • Only if NONE of the top 10 ranked markets qualify is the match skipped.
//
//   5. Top-1 is PINNED across Top 1/3/5/10 so a skipped weak-team line can
//      never outrank the headline pick after the final safety sort.

import { poissonPmf } from "./stats";
import { calibratedWinProb } from "./calibration";
import type { Market } from "./types";
import type { LambdaSet } from "./lambdas";

// ─── Verifiability ────────────────────────────────────────────────────────────

// Markets that ESPN boxscore CANNOT confirm — they always produce PENDING picks.
// They are still evaluated and ranked (nothing is dropped from the ranking),
// but only verifiable markets occupy Top-N slots.
const UNVERIFIABLE_PATTERNS = [
  // Family-level blocks
  "Throw-ins", "Goal Kicks", "Possession / Metrics",
  "Goal Sequence", "Advanced Events",
  // Market-level blocks — ESPN has no half-time score, no exact-goals, no sequential data
  "1st Half Goals", "2nd Half Goals",     // HT score not in ESPN post-match boxscore
  "Exact",                                 // "Exact 0 Goals" etc — too low probability anyway
  "Correct Score",                         // requires exact score match — consistently PENDING
  "4 or more Goals", "4+ Goals",           // very rare, always PENDING from boxscore
  "Penalty Awarded",                       // ESPN doesn't flag penalties reliably post-match
  "Red Card Shown",                        // ESPN redCards field unreliable in many leagues
  "HT/FT",                                // half-time/full-time combo needs both scores
  "Race to",                               // sequential data not available post-match
  "Consecutive Goals",                     // play-by-play not available post-match
  "Comeback Win",                          // narrative data not available
  "Win to Nil",                            // derived but ESPN doesn't flag explicitly
  "At Least 3 Goals After",               // live-only data point
  "Goal in Both Halves",                   // requires half-time score not stored
  "BTTS & Over",                           // compound — HT data gap makes it unreliable
];

// Families that CAN be confirmed from ESPN boxscore
const VERIFIABLE = new Set([
  "Goals", "Corners", "Yellow Cards", "Shots on Target",
  "Shots Towards Goal", "Saves",
  "Match Result", "Double Chance", "Draw No Bet / Asian Handicap",
]);

function isVerifiable(m: Market): boolean {
  // Block any market matching an unverifiable pattern
  if (UNVERIFIABLE_PATTERNS.some((p) => m.name.includes(p) || m.family === p)) return false;
  // BTTS Yes/No — only the simple form (no compound versions)
  if (m.name === "Both Teams To Score") return true;
  // Clean Sheet — derivable from final score
  if (m.name.includes("Clean Sheet")) return true;
  // Match Result / DC / DNB variants (name-based so oracle + registry both match)
  if (m.name.startsWith("Match Result")) return true;
  if (m.name.includes("Double Chance")) return true;
  if (m.name.includes("Draw No Bet")) return true;
  if (VERIFIABLE.has(m.family)) return true;
  // oracle.ts uses lowercase/underscore family slugs
  const fam = m.family.toLowerCase().replace(/_/g, " ");
  return fam === "goals" || fam === "match result" || fam === "corners"
    || fam === "yellow cards" || fam === "cards" || fam === "shots on target"
    || fam === "shots towards goal" || fam === "shots" || fam === "saves";
}

// ─── Family classification ────────────────────────────────────────────────────

function isTeamGoalOu(m: Market): boolean {
  const n = m.name;
  if (!n.includes("Goals O/U")) return false;
  if (n.startsWith("Total Goals")) return false;
  if (/Corners|Cards|SOT|Shots|Saves|Throw|Fouls|Offsides|Goal Kicks/i.test(n)) return false;
  return true;
}

// VOLATILE = families with high match-to-match variance that can break monotonic order.
// Offsides and Interceptions are included because they have similar variance to Corners —
// they depend heavily on match tempo and individual referee interpretation.
const VOLATILE_REGEX = /Shots|SOT|Saves|Corners|Cards|Red Card|Penalty Awarded|Offsides|Interceptions/;
function isVolatile(m: Market): boolean {
  return VOLATILE_REGEX.test(m.name) || m.family === "Saves" || m.family === "Goalkeeper" || m.family === "Offsides"
    || m.family.toLowerCase() === "saves";
}

const STABLE_FAMILIES = new Set(["Goals", "Match Result", "Double Chance", "goals", "match_result"]);

// ─── Name helpers ─────────────────────────────────────────────────────────────

function teamMentions(text: string, teamName: string): boolean {
  if (!teamName) return false;
  if (text.includes(teamName)) return true;
  const first = teamName.split(/\s+/).find((t) => t.length >= 4);
  return !!first && text.includes(first);
}

// ─── λ resolver ───────────────────────────────────────────────────────────────

function lambdaFor(m: Market, lam: LambdaSet, homeName: string, awayName: string): number | null {
  const n   = m.name;
  const sum = (a: number, b: number) => a + b;
  if (n.includes("Total Goals"))          return sum(lam.homeGoals,    lam.awayGoals);
  if (teamMentions(n, homeName) && n.includes("Goals")) return lam.homeGoals;
  if (teamMentions(n, awayName) && n.includes("Goals")) return lam.awayGoals;
  if (n.includes("Total Corners"))        return sum(lam.homeCorners,  lam.awayCorners);
  if (teamMentions(n, homeName) && n.includes("Corners")) return lam.homeCorners;
  if (teamMentions(n, awayName) && n.includes("Corners")) return lam.awayCorners;
  if (n.includes("Total Cards"))          return sum(lam.homeCards,    lam.awayCards);
  if (teamMentions(n, homeName) && n.includes("Cards")) return lam.homeCards;
  if (teamMentions(n, awayName) && n.includes("Cards")) return lam.awayCards;
  if (n.includes("Total SOT"))            return sum(lam.homeSot,      lam.awaySot);
  if (teamMentions(n, homeName) && n.includes("SOT")) return lam.homeSot;
  if (teamMentions(n, awayName) && n.includes("SOT")) return lam.awaySot;
  if (n.includes("Total Shots"))          return sum(lam.homeShots,    lam.awayShots);
  if (teamMentions(n, homeName) && n.includes("Shots")) return lam.homeShots;
  if (teamMentions(n, awayName) && n.includes("Shots")) return lam.awayShots;
  if (n.includes("Total Offsides"))       return sum(lam.homeOffsides, lam.awayOffsides);
  if (n.includes("Total Saves"))          return sum(lam.homeSaves,    lam.awaySaves);
  if (teamMentions(n, homeName) && n.includes("GK Saves")) return lam.homeSaves;
  if (teamMentions(n, awayName) && n.includes("GK Saves")) return lam.awaySaves;
  return null;
}

// ─── Tail / raw Poisson probability ───────────────────────────────────────────

function tailRisk(m: Market, lambda: number): number {
  const lineMatch = m.name.match(/O\/U\s+([\d.]+)/);
  if (!lineMatch) return 1 - m.hitRate;
  const line      = Number(lineMatch[1]);
  const isOver    = m.selection.startsWith("Over");
  const threshold = Math.ceil(line);
  let overMass = 0;
  for (let k = threshold; k <= threshold + 40; k++) overMass += poissonPmf(k, lambda);
  overMass = Math.max(0, Math.min(1, overMass));
  return isOver ? 1 - overMass : overMass;
}

function sigmaCushion(lambda: number, line: number): number {
  return Math.abs(lambda - line) / Math.sqrt(Math.max(0.5, lambda));
}

// ─── Weak-team detection (Top-1 "Under 3.5" filter) ───────────────────────────

/** League-table context for one team. Optional — when absent, only the xG rule applies. */
export interface TeamTableInfo {
  /** 1-based position in the league table. */
  position?:   number;
  /** Number of teams in the league table. */
  leagueSize?: number;
}

/** A team is WEAK when its expected goals (xG) is below this threshold… */
const WEAK_XG_THRESHOLD = 0.8;

/** …OR when it sits in the bottom half of the league table. */
function isBottomHalf(table?: TeamTableInfo): boolean {
  if (!table?.position || !table?.leagueSize) return false;
  return table.position > table.leagueSize / 2;
}

/**
 * True when `m` is a TEAM-SPECIFIC "Under 3.5" goals line
 * (e.g. "Coventry Goals O/U 3.5" · "Under 3.5"), including the equivalent
 * "{Team} 4+ Goals" · "3 or fewer Goals" form — the identical bet.
 * The whole-match total "Total Goals O/U 3.5 · Under 3.5" is NOT team-specific
 * and never matches here.
 */
function isTeamUnder35GoalLine(m: Market): boolean {
  // "{Team} 4+ Goals" · "3 or fewer Goals" ≡ team Under 3.5
  if (/4\+ Goals/.test(m.name) && !m.name.startsWith("Total Goals")
    && m.selection.includes("3 or fewer")) return true;
  if (!isTeamGoalOu(m)) return false;
  const lineMatch = m.name.match(/O\/U\s+([\d.]+)/);
  if (!lineMatch || Number(lineMatch[1]) !== 3.5) return false;
  return m.selection.startsWith("Under");
}

/**
 * Top-1 weak-team filter:
 * skip a market ONLY when it is a team-specific "Under 3.5 Goals" line whose
 * team is WEAK — xG below 0.8 OR bottom half of the league table.
 */
function isWeakTeamUnder35(
  m:        Market,
  lam:      LambdaSet,
  homeName: string,
  awayName: string,
  opts?:    SelectOptions,
): boolean {
  if (!isTeamUnder35GoalLine(m)) return false;

  // Resolve which team the line belongs to (home wins ties on ambiguous names).
  const isHome = teamMentions(m.name, homeName);
  const isAway = !isHome && teamMentions(m.name, awayName);
  if (!isHome && !isAway) return false; // cannot attribute the line — don't skip

  const xg    = isHome ? lam.homeGoals : lam.awayGoals;
  const table = isHome ? opts?.homeTable : opts?.awayTable;

  return xg < WEAK_XG_THRESHOLD || isBottomHalf(table);
}

// ─── Safety scoring ───────────────────────────────────────────────────────────

export interface SafetyScore {
  market:      Market;
  safety:      number;
  wrongProb:   number;
  marginUnits: number;
  verifiable:  boolean;
  notes:       string;
}

export function scoreMarket(
  m:         Market,
  lam:       LambdaSet,
  homeName:  string,
  awayName:  string,
): SafetyScore {
  const verifiable = isVerifiable(m);
  const lambda     = lambdaFor(m, lam, homeName, awayName);

  const totalGoals = lam.homeGoals + lam.awayGoals;
  const evenness   = 1 - Math.min(1, Math.abs(lam.homeGoals - lam.awayGoals) / Math.max(0.5, totalGoals));
  const ctx        = { totalGoals, evenness };

  let wrongProb   = 1 - m.hitRate;
  let marginUnits = 0;
  let notes       = "";

  if (lambda !== null) {
    const lineMatch = m.name.match(/O\/U\s+([\d.]+)/);
    if (lineMatch) {
      const line     = Number(lineMatch[1]);
      const rawWrong = tailRisk(m, lambda);
      const calWin   = calibratedWinProb(m, 1 - rawWrong, ctx);
      wrongProb      = 1 - calWin;
      marginUnits    = sigmaCushion(lambda, line);
      notes = `λ=${lambda.toFixed(2)} line=${line} σ=${marginUnits.toFixed(2)} loss=${(wrongProb*100).toFixed(1)}%`;
    }
  } else {
    const calWin   = calibratedWinProb(m, m.ciLower, ctx);
    wrongProb      = 1 - calWin;
    marginUnits    = (calWin - 0.5) * 6;
    notes = `Discrete CI-floor ${(calWin*100).toFixed(0)}% loss=${(wrongProb*100).toFixed(1)}%`;
  }

  const safety =
    (1 - wrongProb)                * 0.55 +
    Math.min(1, marginUnits / 3.0) * 0.30 +
    m.ciLower                      * 0.10 +
    (1 - m.disagreementIndex)      * 0.05;

  return {
    market: m, safety: Math.max(0, Math.min(1, safety)),
    wrongProb, marginUnits, verifiable, notes,
  };
}

// ─── Key deduplication ────────────────────────────────────────────────────────

// Extract the stat identity without the line number.
// "Total Offsides O/U 7.5" → "Total Offsides"
// "Racing Club Goals O/U 3.5" → "Racing Club Goals"
// "Red Card Shown" → "Red Card Shown"
function statKey(m: Market): string {
  return m.name.replace(/\s*O\/U\s*[\d.]+\s*/, "").trim();
}

// ─── Selection result ─────────────────────────────────────────────────────────

export interface SelectionResult {
  top1:     Market[];
  top3:     Market[];
  top5:     Market[];
  top10:    Market[];
  /** Set only when NONE of the top 10 ranked markets pass the weak-team filter. */
  skipped?: string;
}

const EMPTY_SELECTION = (reason: string): SelectionResult => ({
  top1: [], top3: [], top5: [], top10: [], skipped: reason,
});

export interface SelectOptions {
  /** League-table context for the home team (weak-team bottom-half check). */
  homeTable?: TeamTableInfo;
  /** League-table context for the away team (weak-team bottom-half check). */
  awayTable?: TeamTableInfo;
}

// ─── Main selector ────────────────────────────────────────────────────────────

export function selectTopPicks(
  markets:        Market[],
  lam:            LambdaSet,
  homeName:       string,
  awayName:       string,
  confidenceMap?: Record<string, number>,
  opts?:          SelectOptions,
): SelectionResult {

  // ── Step 1: Score and rank ALL markets — no availability gates ────────────
  // Every generated market (all 217 registry lines) is evaluated and ranked.
  const allScored = markets
    .filter((m) => !m.rejected)
    .map((m) => {
      const s    = scoreMarket(m, lam, homeName, awayName);
      const conf = confidenceMap?.[m.id];
      const combined = conf !== undefined
        ? s.safety * 0.60 + Math.min(1, conf) * 0.40
        : s.safety;
      return { ...s, combined };
    })
    .sort((a, b) => {
      // Primary: wrongProb ascending (safest first)
      const diff = a.wrongProb - b.wrongProb;
      if (Math.abs(diff) > 0.005) return diff;
      // Secondary: combined score descending
      return b.combined - a.combined;
    });

  if (allScored.length === 0) {
    return EMPTY_SELECTION("No qualified markets to rank.");
  }

  // ── Step 2: Deduplicate — ONE line per underlying stat ────────────────────
  // For every stat keep the safest line. This prevents two lines of the same
  // stat from appearing in Top-10 where one misses and the other hits,
  // breaking monotonic order.
  const seenInDedup = new Set<string>();
  const scored = allScored.filter((s) => {
    const key = statKey(s.market);
    if (seenInDedup.has(key)) return false;
    seenInDedup.add(key);
    return true;
  });

  // ── Step 3: Separate into STABLE (safe) and VOLATILE pools ────────────────
  // Top-10 assembly draws from VERIFIABLE markets only (ESPN can confirm
  // them post-match). Unverifiable markets stay in the full ranking above —
  // nothing is dropped from evaluation — they just never occupy Top-N slots.
  const stablePool   = scored.filter((s) => s.verifiable && !isVolatile(s.market));
  const volatilePool = scored.filter((s) => s.verifiable &&  isVolatile(s.market));

  // ── Step 4: Build the ranked Top-10 (stable first, volatile last) ─────────
  // Positions 1-9 are filled entirely from stable picks, THEN at most 1
  // volatile pick is added as position 10.
  const picked: Market[] = [];
  const famCount: Record<string, number> = {};

  const fillStable = (limit: number, ignoreCaps = false) => {
    for (const s of stablePool) {
      if (picked.length >= limit) break;
      if (picked.includes(s.market)) continue;
      if (!ignoreCaps) {
        const fam = s.market.family;
        const cap = STABLE_FAMILIES.has(fam) ? 3 : 2;
        if ((famCount[fam] ?? 0) >= cap) continue;
        famCount[fam] = (famCount[fam] ?? 0) + 1;
      }
      picked.push(s.market);
    }
  };

  fillStable(9);   // family-capped stable picks first

  // Position 10: ONE volatile pick if we still need a market
  if (picked.length < 10) {
    const bestVolatile = volatilePool.find((s) => !picked.includes(s.market));
    if (bestVolatile) picked.push(bestVolatile.market);
    // If still < 10, fill from the stable remainder ignoring family caps.
    fillStable(10, true);
  }

  // ── Step 5: FINAL RE-SORT by wrongProb ascending ───────────────────────────
  // Absolute guarantee of monotonic safety ordering.
  // After family diversity selection, the order may be disturbed.
  // This final sort restores it: pick #1 is always safer than pick #2, etc.
  const scoreOf = (m: Market): number => {
    const s = allScored.find((x) => x.market === m);
    return s?.wrongProb ?? (1 - m.hitRate);
  };
  const marginOf = (m: Market): number => {
    const s = allScored.find((x) => x.market === m);
    return s?.marginUnits ?? 0;
  };

  const finalSorted = [...picked].sort((a, b) => {
    const wa = scoreOf(a), wb = scoreOf(b);
    const diff = wa - wb;
    if (Math.abs(diff) > 0.003) return diff;
    return marginOf(b) - marginOf(a); // tiebreak: more σ cushion first
  });

  const rankedTop10 = finalSorted.slice(0, 10);

  // ── Step 6: TOP-1 — walk the ranked markets #1 → #10 ──────────────────────
  // Take the first ranked market that is NOT a weak-team "Under 3.5" goal
  // line. A team is weak when its xG < 0.8 OR it sits in the bottom half of
  // the league table. The whole-match "Total Goals Under 3.5" always
  // qualifies. Only if none of the 10 qualify is the match skipped.
  let top1Pick: Market | null = null;
  for (const m of rankedTop10) {
    if (isWeakTeamUnder35(m, lam, homeName, awayName, opts)) continue;
    top1Pick = m;
    break;
  }

  if (!top1Pick) {
    return EMPTY_SELECTION(
      "All top-10 ranked markets are weak-team Under 3.5 goal lines — match skipped.",
    );
  }

  // Pin the chosen Top-1 so Top 3/5/10 never promote a skipped weak-team line.
  const top1: Market[] = [top1Pick];
  const remainder = rankedTop10.filter((m) => m !== top1Pick);
  const pinned    = [top1Pick, ...remainder];

  return {
    top1,
    top3:  pinned.slice(0, 3),
    top5:  pinned.slice(0, 5),
    top10: pinned.slice(0, 10),
  };
}
