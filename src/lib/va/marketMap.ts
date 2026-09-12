// Value Accumulator — Market name mapping (independent)
import type { VaBookmakerOdds } from "./oddsFetcher";

export interface EngineMarketRef {
  name: string; // engine market name, e.g. "Total Goals O/U 2.5"
  selection: string; // e.g. "Over 2.5"
  family?: string;
}

/** Optional team context so 1X2 selections like "Arsenal Win" can match Bzzoiro's HOME/AWAY outcomes. */
export interface TeamContext {
  home: string;
  away: string;
}

// Explicit map table for common pairs
// Key: normalized engine market base, Value: array of possible bookmaker market labels (normalized)
//
// Bzzoiro market vocabulary (verified against sports.bzzoiro.com/docs/football/odds-predictions/):
//   1x2            → HOME / DRAW / AWAY
//   over_under_15 / over_under_25 / over_under_35 → over / under (+ line)
//   btts           → yes / no
//   double_chance  → 1X / 12 / X2
//   total_corners  → over / under (+ line, 7.5–11.5)
//   draw_no_bet    → HOME / AWAY
// Cards / shots / SOT / offsides markets are NOT priced by Bzzoiro — engine legs
// for those families simply find no bookmaker row and are skipped (never fabricated).
const EXPLICIT_MAP: Array<{ engine: string[]; bookmaker: string[] }> = [
  {
    engine: ["total goals", "total goals o/u"],
    bookmaker: [
      "goals over/under",
      "over/under",
      "total goals",
      "over_under", // matches over_under_15 / _25 / _35 after normalization
    ],
  },
  {
    engine: ["match result", "match winner", "match result:"],
    bookmaker: ["match winner", "1x2", "match result"],
  },
  {
    engine: ["double chance"],
    bookmaker: ["double chance", "double_chance"],
  },
  {
    engine: ["both teams to score", "btts", "both teams to score"],
    bookmaker: ["both teams score", "both teams to score", "btts"],
  },
  {
    engine: ["total corners", "corners"],
    bookmaker: ["total corners", "corners over/under", "corners", "corner", "total corners over/under", "total_corners"],
  },
  {
    engine: ["draw no bet"],
    bookmaker: ["draw no bet", "draw_no_bet"],
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

const NOISE_TOKENS = new Set(["fc", "cf", "afc", "sc", "ac", "as", "fk", "club", "the", "de", "del"]);

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !NOISE_TOKENS.has(t));
}

/** Does the text reference this team (any significant token appears)? */
function mentionsTeam(text: string, team: string | undefined): boolean {
  if (!team) return false;
  const tokens = nameTokens(team).filter((t) => t.length >= 3);
  if (tokens.length === 0) return false;
  const t = normalize(text);
  return tokens.some((tok) => t.includes(tok));
}

/** Extract a double-chance code ("1x" | "12" | "x2") from normalized text, if any. */
function dcCode(text: string): string | null {
  const m = text.match(/\b(1x|12|x2)\b/);
  return m ? m[1] : null;
}

function selectionMatches(
  engineMarket: string,
  engineSelection: string,
  bm: VaBookmakerOdds,
  teams?: TeamContext
): boolean {
  const e = normalize(engineSelection);
  const b = normalize(bm.selection);
  // Bzzoiro outcome enum (HOME/DRAW/AWAY/over/under/yes/no/1X/12/X2) — authoritative when present
  const o = normalize(bm.outcome ?? "");
  const bCombined = `${b} ${o}`.trim();

  if (e === b || (o.length > 0 && e === o)) return true;

  // Double chance: both sides must carry the same code. This also guards the
  // reverse — a 1X2 "Draw" selection must never price a Double Chance row.
  // The engine-side code is only read for actual Double Chance markets, so
  // corner lines like "Under 12.5" are never mistaken for a DC code.
  const isDcMarket = normalize(engineMarket).includes("double chance");
  const eDc = isDcMarket ? dcCode(normalize(engineMarket)) ?? dcCode(e) : null;
  const bDc = dcCode(o) ?? dcCode(b);
  if (eDc !== null || bDc !== null) {
    return eDc !== null && bDc !== null && eDc === bDc;
  }

  // Over/Under matching
  if (e.includes("over") && bCombined.includes("over")) return true;
  if (e.includes("under") && bCombined.includes("under")) return true;
  // Yes/No (BTTS)
  if (e === "yes" && bCombined.includes("yes")) return true;
  if (e === "no" && bCombined.includes("no") && !bCombined.includes("yes")) return true;

  // 1X2 outcome enums — engine selection is usually "{Team} Win" / "Draw".
  if (o === "home" && (e.includes("home") || mentionsTeam(e, teams?.home))) return true;
  if (o === "away" && (e.includes("away") || mentionsTeam(e, teams?.away))) return true;
  if (o === "draw" && e.includes("draw")) return true;

  // Home/Away/Draw etc — check inclusion (legacy label style)
  if (e.includes("home") && b.includes("home")) return true;
  if (e.includes("away") && b.includes("away")) return true;
  if (e.includes("draw") && b.includes("draw")) return true;

  // For exact team names, require some overlap
  if (e.length > 3 && b.length > 3 && (e.includes(b) || b.includes(e))) return true;
  return false;
}

export function matchEngineMarketToBookmaker(
  engineMarket: string,
  engineSelection: string,
  bookmakerMarkets: VaBookmakerOdds[],
  teams?: TeamContext
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
        // Guard against empty normalized labels (digit-only slugs like "1x2")
        if (!bn && !bs) return false;
        return bmNorm.includes(bn) || (bs.length > 0 && bmStripped.includes(bs)) || (bn.length > 0 && bmStripped.includes(bn)) || (bs.length > 0 && bmNorm.includes(bs));
      });
      if (!explicitBmMatch) continue;
      // Line must agree
      const bmLine = bm.line ?? extractLineFromString(bm.selection) ?? extractLineFromString(bm.marketLabel);
      if (!linesMatch(engineLine, bmLine)) continue;
      if (!selectionMatches(engineMarket, engineSelection, bm, teams)) continue;
      return bm;
    }
  }

  // 2. Normalized fallback: compare stripped names
  for (const bm of bookmakerMarkets) {
    const bmNorm = normalize(bm.marketLabel);
    const bmStripped = stripNumbers(bm.marketLabel);
    if (bmStripped.length === 0) continue; // digit-only labels ("1x2") must not substring-match everything
    // Direct stripped equality or containment
    const nameMatch =
      (engineStripped.length > 0 && engineStripped === bmStripped) ||
      (engineNorm.length > 0 && engineNorm === bmNorm) ||
      engineStripped.includes(bmStripped) ||
      bmStripped.includes(engineStripped) ||
      engineNorm.includes(bmNorm) ||
      bmNorm.includes(engineNorm);

    if (!nameMatch) continue;
    const bmLine = bm.line ?? extractLineFromString(bm.selection) ?? extractLineFromString(bm.marketLabel);
    if (!linesMatch(engineLine, bmLine)) continue;
    if (!selectionMatches(engineMarket, engineSelection, bm, teams)) continue;
    return bm;
  }

  return null;
}
