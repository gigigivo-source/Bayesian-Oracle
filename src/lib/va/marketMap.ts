// Value Accumulator — Market name mapping (independent)
import type { VaBookmakerOdds } from "./oddsFetcher";

export interface EngineMarketRef {
  name: string; // engine market name, e.g. "Total Goals O/U 2.5"
  selection: string; // e.g. "Over 2.5"
  family?: string;
}

// Explicit map table for common pairs
// Key: normalized engine market base, Value: array of possible bookmaker market labels (normalized)
const EXPLICIT_MAP: Array<{ engine: string[]; bookmaker: string[] }> = [
  {
    engine: ["total goals", "total goals o/u"],
    bookmaker: ["goals over/under", "over/under", "total goals", "total"],
  },
  {
    engine: ["match result", "match winner", "match result:"],
    bookmaker: ["match winner", "1x2", "match result"],
  },
  {
    engine: ["double chance"],
    bookmaker: ["double chance"],
  },
  {
    engine: ["both teams to score", "btts", "both teams to score"],
    bookmaker: ["both teams score", "both teams to score", "btts"],
  },
  {
    engine: ["total corners", "corners"],
    bookmaker: ["total corners", "corners over/under", "corners", "corner", "total corners over/under"],
  },
  {
    engine: ["total cards", "cards", "yellow cards"],
    bookmaker: ["cards over/under", "total cards", "cards", "total bookings"],
  },
  {
    engine: ["total sot", "total shots on target", "shots on target"],
    bookmaker: ["shots on target", "total shots on target", "total shots on goal"],
  },
  {
    engine: ["total shots", "shots"],
    bookmaker: ["total shots", "shots over/under", "total shots"],
  },
  {
    engine: ["total offsides"],
    bookmaker: ["offsides", "total offsides"],
  },
  {
    engine: ["total goal kicks"],
    bookmaker: ["goal kicks", "total goal kicks"],
  },
  {
    engine: ["total saves"],
    bookmaker: ["saves", "total saves"],
  },
  {
    engine: ["total throw-ins", "throw-ins"],
    bookmaker: ["throw-ins", "total throw-ins"],
  },
];

function normalize(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripNumbers(str: string): string {
  return normalize(str).replace(/\d+(\.\d+)?/g, "").replace(/\s+/g, " ").trim();
}

function extractLineFromString(str: string): number | null {
  const m = str.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function linesMatch(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) {
    // If one has no line, allow match when the other also has no line concept?
    // For markets without line (e.g. Match Winner), both should be null.
    // If one is null and other is not, treat as mismatch unless the market is known to be line-less.
    return false;
  }
  // Allow tiny epsilon
  return Math.abs(a - b) < 0.001;
}

function selectionMatches(engineSelection: string, bookmakerSelection: string): boolean {
  const e = normalize(engineSelection);
  const b = normalize(bookmakerSelection);
  if (e === b) return true;
  // Over/Under matching
  if (e.includes("over") && b.includes("over")) return true;
  if (e.includes("under") && b.includes("under")) return true;
  // Yes/No
  if (e === "yes" && b === "yes") return true;
  if (e === "no" && b === "no") return true;
  // Home/Away/Draw etc — check inclusion
  // For team-specific markets, engine selection may be team name; bookmaker selection may be "Home" etc.
  // We try loose contains for home/away/draw
  if (e.includes("home") && b.includes("home")) return true;
  if (e.includes("away") && b.includes("away")) return true;
  if (e.includes("draw") && b.includes("draw")) return true;
  // For exact team names, require some overlap
  // If both contain over/under, already matched, so now check direct substring
  if (e.length > 3 && b.length > 3 && (e.includes(b) || b.includes(e))) return true;
  return false;
}

export function matchEngineMarketToBookmaker(
  engineMarket: string,
  engineSelection: string,
  bookmakerMarkets: VaBookmakerOdds[]
): VaBookmakerOdds | null {
  if (!bookmakerMarkets || bookmakerMarkets.length === 0) return null;
  const engineNorm = normalize(engineMarket);
  const engineStripped = stripNumbers(engineMarket);
  const engineLine = extractLineFromString(engineMarket) ?? extractLineFromString(engineSelection);

  // 1. Try explicit map
  for (const mapping of EXPLICIT_MAP) {
    const engineMatch = mapping.engine.some((e) => {
      const en = normalize(e);
      const es = stripNumbers(e);
      return engineNorm.includes(en) || engineStripped.includes(es) || engineStripped.includes(en) || engineNorm.includes(es);
    });
    if (!engineMatch) continue;
    // Find bookmaker markets that match this explicit mapping
    for (const bm of bookmakerMarkets) {
      const bmNorm = normalize(bm.marketLabel);
      const bmStripped = stripNumbers(bm.marketLabel);
      const explicitBmMatch = mapping.bookmaker.some((b) => {
        const bn = normalize(b);
        const bs = stripNumbers(b);
        return bmNorm.includes(bn) || bmStripped.includes(bs) || bmStripped.includes(bn) || bmNorm.includes(bs);
      });
      if (!explicitBmMatch) continue;
      // Line must agree
      const bmLine = bm.line ?? extractLineFromString(bm.selection) ?? extractLineFromString(bm.marketLabel);
      if (!linesMatch(engineLine, bmLine)) continue;
      if (!selectionMatches(engineSelection, bm.selection)) continue;
      return bm;
    }
  }

  // 2. Normalized fallback: compare stripped names
  for (const bm of bookmakerMarkets) {
    const bmNorm = normalize(bm.marketLabel);
    const bmStripped = stripNumbers(bm.marketLabel);
    // Direct stripped equality or containment
    const nameMatch =
      engineStripped === bmStripped ||
      engineNorm === bmNorm ||
      engineStripped.includes(bmStripped) ||
      bmStripped.includes(engineStripped) ||
      engineNorm.includes(bmNorm) ||
      bmNorm.includes(engineNorm);

    if (!nameMatch) continue;
    const bmLine = bm.line ?? extractLineFromString(bm.selection) ?? extractLineFromString(bm.marketLabel);
    if (!linesMatch(engineLine, bmLine)) continue;
    if (!selectionMatches(engineSelection, bm.selection)) continue;
    return bm;
  }

  return null;
}
