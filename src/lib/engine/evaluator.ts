// ĞIGI GIVØ — Post-match market evaluator.
// Evaluates every market against real ESPN boxscore data.
// Only markets that the selector marks as verifiable should reach here —
// all PENDING-prone markets (Exact, 4+, HT, Correct Score) are excluded upstream.

import type { FixtureLite } from "../espn";
import type { EngineResult, Market } from "./types";

function ou(actual: number, line: number, isOver: boolean): "HIT" | "MISS" {
  return (isOver ? actual > line : actual < line) ? "HIT" : "MISS";
}

export function evaluateFinishedMatch(
  fx:        FixtureLite,
  res:       EngineResult,
  boxscore?: Record<string, number> | null,
): void {
  if (fx.home.score === null || fx.away.score === null) return;

  const hScore     = Number(fx.home.score) || 0;
  const aScore     = Number(fx.away.score) || 0;
  const totalGoals = hScore + aScore;
  const bs         = boxscore ?? null;
  const hn         = fx.home.name;
  const an         = fx.away.name;

  const stat = (key: string): number => bs?.[key] ?? -1;
  const both = (a: string, b: string): number => {
    const va = stat(a); const vb = stat(b);
    return (va >= 0 && vb >= 0) ? va + vb : -1;
  };

  for (const m of res.markets) {
    let outcome: "HIT" | "MISS" | "PENDING" = "PENDING";
    const n    = m.name;
    const sel  = m.selection;
    const lineM = n.match(/O\/U\s+([\d.]+)/);
    const line  = lineM ? Number(lineM[1]) : NaN;
    const over  = sel.startsWith("Over");

    // ── Goals (from final score — always available) ─────────────────────────
    if (n.includes("Total Goals O/U") && !n.includes("Half")) {
      if (!isNaN(line)) outcome = ou(totalGoals, line, over);
    }
    else if (n.includes(`${hn} Goals O/U`)) {
      if (!isNaN(line)) outcome = ou(hScore, line, over);
    }
    else if (n.includes(`${an} Goals O/U`)) {
      if (!isNaN(line)) outcome = ou(aScore, line, over);
    }
    else if (n === "Both Teams To Score") {
      const btts = hScore > 0 && aScore > 0;
      outcome = (sel === "Yes" ? btts : !btts) ? "HIT" : "MISS";
    }
    else if (n.includes("Clean Sheet")) {
      const isHomeCS = n.includes(hn);
      const clean    = isHomeCS ? aScore === 0 : hScore === 0;
      outcome = (sel === "Yes" ? clean : !clean) ? "HIT" : "MISS";
    }

    // ── Match result (from final score) ────────────────────────────────────
    else if (n.startsWith("Match Result")) {
      const actual = hScore > aScore ? `${hn} Win` : hScore === aScore ? "Draw" : `${an} Win`;
      // Match against the selection (handles "Home Win", "Draw or Away Win" etc.)
      if (sel.includes("Win") && sel.includes(hn))          outcome = hScore > aScore  ? "HIT" : "MISS";
      else if (sel === "Draw")                               outcome = hScore === aScore ? "HIT" : "MISS";
      else if (sel.includes("Win") && sel.includes(an))      outcome = aScore > hScore  ? "HIT" : "MISS";
      else if (sel === "Draw or Away Win")                   outcome = hScore <= aScore  ? "HIT" : "MISS";
      else if (sel === "Home Win or Draw")                   outcome = hScore >= aScore  ? "HIT" : "MISS";
      else if (sel === "Home or Away Win")                   outcome = hScore !== aScore ? "HIT" : "MISS";
      else outcome = sel.includes(actual.split(" ")[0])     ? "HIT" : "MISS";
    }
    else if (n.includes("Double Chance 1X") || sel.includes(`${hn} or Draw`)) {
      outcome = hScore >= aScore ? "HIT" : "MISS";
    }
    else if (n.includes("Double Chance 12") || (sel.includes(hn) && sel.includes(an))) {
      outcome = hScore !== aScore ? "HIT" : "MISS";
    }
    else if (n.includes("Double Chance X2") || sel.includes(`Draw or ${an}`)) {
      outcome = aScore >= hScore ? "HIT" : "MISS";
    }
    else if (n.includes("Draw No Bet")) {
      if (hScore === aScore) outcome = "PENDING"; // push
      else if (sel.includes(hn) || sel.includes("Home")) outcome = hScore > aScore ? "HIT" : "MISS";
      else outcome = aScore > hScore ? "HIT" : "MISS";
    }

    // ── Boxscore-dependent markets ─────────────────────────────────────────
    else if (!isNaN(line) && n.includes("O/U")) {
      let actual = -1;
      // Shots on Target
      if      (n.includes("Total SOT"))            actual = both("homeSot",          "awaySot");
      else if (n.includes(`${hn} SOT`))            actual = stat("homeSot");
      else if (n.includes(`${an} SOT`))            actual = stat("awaySot");
      // Shots
      else if (n.includes("Total Shots"))           actual = both("homeShots",        "awayShots");
      else if (n.includes(`${hn} Shots`))           actual = stat("homeShots");
      else if (n.includes(`${an} Shots`))           actual = stat("awayShots");
      // Corners
      else if (n.includes("Total Corners"))         actual = both("homeCorners",      "awayCorners");
      else if (n.includes(`${hn} Corners`))         actual = stat("homeCorners");
      else if (n.includes(`${an} Corners`))         actual = stat("awayCorners");
      // Cards
      else if (n.includes("Total Cards"))           actual = both("homeCards",        "awayCards");
      else if (n.includes(`${hn} Cards`))           actual = stat("homeCards");
      else if (n.includes(`${an} Cards`))           actual = stat("awayCards");
      // Saves
      else if (n.includes("Total Saves"))           actual = both("homeSaves",        "awaySaves");
      else if (n.includes(`${hn} GK Saves`))        actual = stat("homeSaves");
      else if (n.includes(`${an} GK Saves`))        actual = stat("awaySaves");
      // Fouls
      else if (n.includes("Total Fouls"))           actual = both("homeFouls",        "awayFouls");
      // Offsides
      else if (n.includes("Total Offsides"))        actual = both("homeOffsides",     "awayOffsides");
      else if (n.includes(`${hn} Offsides`))        actual = stat("homeOffsides");
      else if (n.includes(`${an} Offsides`))        actual = stat("awayOffsides");
      // Interceptions
      else if (n.includes("Total Interceptions"))   actual = both("homeInterceptions","awayInterceptions");
      else if (n.includes(`${hn} Interceptions`))   actual = stat("homeInterceptions");
      else if (n.includes(`${an} Interceptions`))   actual = stat("awayInterceptions");

      if (actual >= 0) outcome = ou(actual, line, over);
      // If actual === -1, boxscore didn't have this stat → stays PENDING
    }

    m.outcome = outcome;
  }

  // Tally Top-10 outcomes
  let t10Hits = 0, t10Eval = 0;
  for (const m of res.top10) {
    if      (m.outcome === "HIT")  { t10Eval++; t10Hits++; }
    else if (m.outcome === "MISS") { t10Eval++; }
    // PENDING stays — it means the stat source didn't have it
  }
  res.hitCount       = t10Hits;
  res.evaluatedCount = t10Eval;
}
