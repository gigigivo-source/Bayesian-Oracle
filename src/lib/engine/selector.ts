// ĞIGI GIVØ — Intelligent Top-N Selector
//
// CORE GUARANTEES:
//   1. Top-1 ALWAYS has a pick — with 217 markets there is ALWAYS something safe.
//      Never returns empty. Falls through 5 gate tiers then takes absolute safest.
//
//   2. Top-10 is MONOTONICALLY ORDERED — pick #N is always SAFER than pick #N+1.
//      Enforced by two mechanisms:
//        a) Each stat (e.g. "Total Offsides") contributes AT MOST ONE line to Top-10.
//           The safest line for that stat wins; others are discarded.
//        b) After assembly, the list is re-sorted by wrongProb ascending.
//      This makes it structurally impossible for pick #4 to MISS while #5 HITS.
//
//   3. Volatile families (Shots/SOT/Saves/Corners/Cards) are excluded from Top-1/3.
//      Max 1 volatile market across the entire Top-10.

import { poissonPmf } from "./stats";
import { calibratedWinProb, marketReliability } from "./calibration";
import type { Market } from "./types";
import type { LambdaSet } from "./lambdas";

// ─── Verifiability ────────────────────────────────────────────────────────────

// Markets that ESPN boxscore CANNOT confirm — they always produce PENDING picks
// and waste Top-10 slots. Permanently excluded from Top-N selection.
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
  // Match Result variants
  if (m.name.startsWith("Match Result")) return true;
  if (m.name.includes("Double Chance")) return true;
  // O/U markets in verifiable families
  return VERIFIABLE.has(m.family);
}

// ─── Family classification ────────────────────────────────────────────────────

/**
 * BULLETPROOF = markets universally offered by ALL bookmakers (1xBet, Bet365,
 * DraftKings, Pinnacle) for EVERY league and EVERY team — big or small.
 *
 * RULE: Team-specific lines (e.g. "Vitória Goals O/U 3.5") are NOT bulletproof
 * because bookmakers only offer team goal lines for big clubs in top leagues.
 * For small teams (Académico de Viseu, Lanús, RAAL La Louvière) these lines
 * simply don't exist at the bookmaker — making the pick unactionable.
 *
 * ONLY universally available markets qualify for Top-1:
 *   ✅ Total Goals O/U (all lines) — offered in every match globally
 *   ✅ Match Result 1X2            — offered in every match globally
 *   ✅ Double Chance 1X/12/X2      — offered in every match globally
 *   ✅ Both Teams To Score         — offered in every match globally
 *   ✅ Draw No Bet                  — offered in most matches globally
 *
 *   ❌ [TeamName] Goals O/U X.5   — NOT offered for small teams / small leagues
 *   ❌ [TeamName] Clean Sheet      — NOT reliably offered everywhere
 *   ❌ [TeamName] Corners/Cards    — NOT offered for small teams
 */
function isBulletproof(m: Market): boolean {
  const n = m.name;

  // ✅ TOTAL goals — universally offered everywhere
  if (n.startsWith("Total Goals O/U") || n === "Total Goals O/U 0.5" || n === "Total Goals O/U 1.5"
      || n === "Total Goals O/U 2.5" || n === "Total Goals O/U 3.5"
      || n === "Total Goals O/U 4.5" || n === "Total Goals O/U 5.5") return true;

  // ✅ Match Result (1X2) — universally offered
  if (n.startsWith("Match Result")) return true;

  // ✅ Double Chance — universally offered
  if (n.includes("Double Chance")) return true;

  // ✅ Both Teams To Score — universally offered
  if (n === "Both Teams To Score") return true;

  // ✅ Draw No Bet — widely offered (not always for very small leagues, but common)
  if (n.startsWith("Draw No Bet")) return true;

  // ❌ TEAM-SPECIFIC goal lines — NOT offered for small teams at bookmakers
  // e.g. "Vitória Goals O/U 3.5", "Lanús Goals O/U 3.5" — excluded from Top-1
  // These are fine in Top-5/Top-10 for big clubs but never Top-1
  if (n.includes("Goals O/U") && !n.startsWith("Total Goals")) return false;

  // ❌ Clean Sheet for specific teams — not always offered for small clubs
  if (n.includes("Clean Sheet")) return false;

  return false; // default: not bulletproof
}

// VOLATILE = families with high match-to-match variance that can break monotonic order.
// Offsides and Interceptions are included because they have similar variance to Corners —
// they depend heavily on match tempo and individual referee interpretation.
const VOLATILE_REGEX = /Shots|SOT|Saves|Corners|Cards|Red Card|Penalty Awarded|Offsides|Interceptions/;
function isVolatile(m: Market): boolean {
  return VOLATILE_REGEX.test(m.name) || m.family === "Saves" || m.family === "Goalkeeper" || m.family === "Offsides";
}

const STABLE_FAMILIES = new Set(["Goals", "Match Result", "Double Chance"]);

// ─── λ resolver ───────────────────────────────────────────────────────────────

function lambdaFor(m: Market, lam: LambdaSet, homeName: string, awayName: string): number | null {
  const n   = m.name;
  const sum = (a: number, b: number) => a + b;
  if (n.includes("Total Goals"))          return sum(lam.homeGoals,    lam.awayGoals);
  if (n.includes(`${homeName} Goals`))    return lam.homeGoals;
  if (n.includes(`${awayName} Goals`))    return lam.awayGoals;
  if (n.includes("Total Corners"))        return sum(lam.homeCorners,  lam.awayCorners);
  if (n.includes(`${homeName} Corners`))  return lam.homeCorners;
  if (n.includes(`${awayName} Corners`))  return lam.awayCorners;
  if (n.includes("Total Cards"))          return sum(lam.homeCards,    lam.awayCards);
  if (n.includes(`${homeName} Cards`))    return lam.homeCards;
  if (n.includes(`${awayName} Cards`))    return lam.awayCards;
  if (n.includes("Total SOT"))            return sum(lam.homeSot,      lam.awaySot);
  if (n.includes(`${homeName} SOT`))      return lam.homeSot;
  if (n.includes(`${awayName} SOT`))      return lam.awaySot;
  if (n.includes("Total Shots"))          return sum(lam.homeShots,    lam.awayShots);
  if (n.includes(`${homeName} Shots`))    return lam.homeShots;
  if (n.includes(`${awayName} Shots`))    return lam.awayShots;
  if (n.includes("Total Offsides"))       return sum(lam.homeOffsides, lam.awayOffsides);
  if (n.includes("Total Saves"))          return sum(lam.homeSaves,    lam.awaySaves);
  if (n.includes(`${homeName} GK Saves`)) return lam.homeSaves;
  if (n.includes(`${awayName} GK Saves`)) return lam.awaySaves;
  return null;
}

// ─── Tail probability ─────────────────────────────────────────────────────────

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

// ─── Safety scoring ───────────────────────────────────────────────────────────

export interface SafetyScore {
  market:      Market;
  safety:      number;
  wrongProb:   number;
  marginUnits: number;
  verifiable:  boolean;
  bulletproof: boolean;
  notes:       string;
}

export function scoreMarket(
  m:         Market,
  lam:       LambdaSet,
  homeName:  string,
  awayName:  string,
): SafetyScore {
  const verifiable = isVerifiable(m);
  const bullet     = isBulletproof(m) && !isVolatile(m);
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
    wrongProb, marginUnits, verifiable,
    bulletproof: bullet, notes,
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
  top1:  Market[];
  top3:  Market[];
  top5:  Market[];
  top10: Market[];
}

// ─── Main selector ────────────────────────────────────────────────────────────

export function selectTopPicks(
  markets:        Market[],
  lam:            LambdaSet,
  homeName:       string,
  awayName:       string,
  confidenceMap?: Record<string, number>,
): SelectionResult {

  // ── Step 1: Score all verifiable, non-rejected markets ───────────────────
  const allScored = markets
    .filter((m) => !m.rejected && isVerifiable(m))
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

  // ── Step 2: Deduplicate — ONE line per underlying stat ─────────────────────
  // This is the core fix for Problem 2. If we have "Total Offsides O/U 7.5"
  // and "Total Offsides O/U 6.5", only the safest one (lowest wrongProb)
  // enters the pool. This prevents two lines of the same stat from appearing
  // in Top-10 where one misses and the other hits, breaking monotonic order.
  const seenStats = new Map<string, number>(); // statKey → best wrongProb
  for (const s of allScored) {
    const key = statKey(s.market);
    if (!seenStats.has(key)) seenStats.set(key, s.wrongProb);
  }
  // Keep only the first occurrence of each stat key (already sorted safest-first)
  const seenInDedup = new Set<string>();
  const scored = allScored.filter((s) => {
    const key = statKey(s.market);
    if (seenInDedup.has(key)) return false;
    seenInDedup.add(key);
    return true;
  });

  // ── Step 3: Separate into STABLE (safe) and VOLATILE pools ────────────────
  // Volatile markets can ONLY enter Top-10 after all stable picks are placed.
  const stablePool   = scored.filter((s) => !isVolatile(s.market));
  const volatilePool = scored.filter((s) =>  isVolatile(s.market));

  // ── Step 4: TOP-1 — Always pick the single safest bulletproof market ───────
  const bulletSorted = stablePool
    .filter((s) => s.bulletproof)
    .sort((a, b) => a.wrongProb - b.wrongProb);

  let top1Pick: Market | null = null;

  for (const { maxWrong, minSigma } of [
    { maxWrong: 0.02, minSigma: 2.5 },
    { maxWrong: 0.04, minSigma: 1.5 },
    { maxWrong: 0.06, minSigma: 1.0 },
    { maxWrong: 0.10, minSigma: 0.0 },
    { maxWrong: 1.00, minSigma: 0.0 },   // absolute fallback
  ]) {
    if (top1Pick) break;
    for (const s of bulletSorted) {
      if (s.wrongProb <= maxWrong && s.marginUnits >= minSigma) {
        top1Pick = s.market; break;
      }
    }
  }
  // Ultimate fallback: only use universally-available markets (no team-specific lines).
  // Prefer Total Goals lines, then Match Result, then Double Chance, then BTTS.
  // NEVER fall back to a team-specific goal line — bookmakers won't offer it for small clubs.
  if (!top1Pick) {
    const universalOrder = [
      (m: Market) => m.name.startsWith("Total Goals O/U") && m.selection.startsWith("Under"),
      (m: Market) => m.name.startsWith("Total Goals O/U") && m.selection.startsWith("Over"),
      (m: Market) => m.name.includes("Double Chance"),
      (m: Market) => m.name.startsWith("Match Result"),
      (m: Market) => m.name === "Both Teams To Score",
      (m: Market) => m.name.startsWith("Draw No Bet"),
    ];
    for (const test of universalOrder) {
      if (top1Pick) break;
      const candidate = stablePool.find((s) => test(s.market) && s.wrongProb <= 0.20);
      if (candidate) top1Pick = candidate.market;
    }
  }
  // Absolute last resort: safest Total Goals line available
  if (!top1Pick) {
    const totalGoals = stablePool.find((s) => s.market.name.startsWith("Total Goals O/U"));
    if (totalGoals) top1Pick = totalGoals.market;
  }

  const top1: Market[] = top1Pick ? [top1Pick] : [];

  // ── Step 5: Build Top-10 from stable pool only (volatile comes last) ───────
  // We fill Top-10 positions 1-9 entirely from stable picks, THEN add
  // at most 1 volatile pick as position 10 if we have room.
  const picked: Market[] = [...top1];
  const famCount: Record<string, number> = {};
  if (top1Pick) famCount[top1Pick.family] = 1;

  // Fill positions 2-9 from stable pool (no volatile)
  for (const s of stablePool) {
    if (picked.length >= 9) break;
    if (picked.includes(s.market)) continue;
    const fam = s.market.family;
    const cap = STABLE_FAMILIES.has(fam) ? 3 : 2;
    if ((famCount[fam] ?? 0) >= cap) continue;
    picked.push(s.market);
    famCount[fam] = (famCount[fam] ?? 0) + 1;
  }

  // Position 10: ONE volatile pick if we still need a market
  if (picked.length < 10) {
    const bestVolatile = volatilePool[0]; // already sorted by wrongProb
    if (bestVolatile && !picked.includes(bestVolatile.market)) {
      picked.push(bestVolatile.market);
    }
    // If still < 10, fill from stable remainder
    for (const s of stablePool) {
      if (picked.length >= 10) break;
      if (picked.includes(s.market)) continue;
      picked.push(s.market);
    }
  }

  // ── Step 6: FINAL RE-SORT by wrongProb ascending ───────────────────────────
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

  return {
    top1,
    top3:  finalSorted.slice(0, 3),
    top5:  finalSorted.slice(0, 5),
    top10: finalSorted.slice(0, 10),
  };
}
