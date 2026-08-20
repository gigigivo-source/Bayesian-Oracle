export type LegOutcome = "won" | "lost" | "void" | "pending";

export interface MatchResult {
  eventId: string;
  leagueSlug: string;
  date: string;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
}

export interface SettlementLeg {
  marketName?: string | null;
  selection?: string | null;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

function lineFrom(market: string, selection: string): number | null {
  const directional = selection.match(/\b(?:over|under)\s*([0-9]+(?:\.[0-9]+)?)/i);
  const marketLine = market.match(/(?:o\s*\/\s*u|over\s*\/\s*under|goals?|corners?|cards?)\s*([0-9]+(?:\.[0-9]+)?)/i);
  const raw = directional?.[1] ?? marketLine?.[1];
  return raw === undefined ? null : Number(raw);
}

function compareLine(actual: number, line: number, over: boolean): LegOutcome {
  if (actual === line) return "void";
  return over ? (actual > line ? "won" : "lost") : actual < line ? "won" : "lost";
}

/** Evaluate a football betting leg from a final score. Unsupported/stat-based
 * markets remain pending; they must not be guessed from score data. */
export function evaluateLeg(leg: SettlementLeg, result: MatchResult): LegOutcome {
  const rawMarket = leg.marketName?.trim() ?? "";
  const rawSelection = leg.selection?.trim() ?? "";
  if (!rawMarket || !rawSelection) return "pending";

  const market = normalise(rawMarket);
  const selection = normalise(rawSelection);
  const home = normalise(result.homeName);
  const away = normalise(result.awayName);
  const homeScore = result.homeScore;
  const awayScore = result.awayScore;
  const total = homeScore + awayScore;

  // Score-only settlement cannot reliably resolve these markets.
  if (/cards?|corners?|shots?|offsides?|fouls?|penalt/.test(market)) return "pending";

  if (/both teams.*score|btts/.test(market)) {
    const happened = homeScore > 0 && awayScore > 0;
    if (/^(yes|btts yes)$/.test(selection)) return happened ? "won" : "lost";
    if (/^(no|btts no)$/.test(selection)) return happened ? "lost" : "won";
    return "pending";
  }

  if (/double chance/.test(market) || /^(1x|x2|12)$/.test(selection)) {
    if (selection === "1x" || (selection.includes("home") && selection.includes("draw")) || (selection.includes(home) && selection.includes("draw")))
      return homeScore >= awayScore ? "won" : "lost";
    if (selection === "x2" || (selection.includes("away") && selection.includes("draw")) || (selection.includes(away) && selection.includes("draw")))
      return awayScore >= homeScore ? "won" : "lost";
    if (selection === "12" || (selection.includes("home") && selection.includes("away")))
      return homeScore !== awayScore ? "won" : "lost";
    return "pending";
  }

  if (/draw no bet|dnb/.test(market)) {
    if (homeScore === awayScore) return "void";
    if (selection.includes("home") || selection.includes(home)) return homeScore > awayScore ? "won" : "lost";
    if (selection.includes("away") || selection.includes(away)) return awayScore > homeScore ? "won" : "lost";
    return "pending";
  }

  if (/match result|moneyline|1x2|winner/.test(market) || selection === "draw" || /\bwin(?:ner)?\b/.test(selection)) {
    if (selection === "draw" || selection === "x") return homeScore === awayScore ? "won" : "lost";
    if (selection === "1" || selection === "home" || selection === "home win" || selection.includes(home))
      return homeScore > awayScore ? "won" : "lost";
    if (selection === "2" || selection === "away" || selection === "away win" || selection.includes(away))
      return awayScore > homeScore ? "won" : "lost";
    return "pending";
  }

  if (/clean sheet/.test(market)) {
    const yes = selection === "yes";
    const homeMarket = market.includes("home") || market.includes(home);
    const awayMarket = market.includes("away") || market.includes(away);
    if (!homeMarket && !awayMarket) return "pending";
    const clean = homeMarket ? awayScore === 0 : homeScore === 0;
    return clean === yes ? "won" : "lost";
  }

  if (/odd\s*\/\s*even|total.*odd|total.*even/.test(market)) {
    const odd = total % 2 === 1;
    if (selection.includes("odd")) return odd ? "won" : "lost";
    if (selection.includes("even")) return odd ? "lost" : "won";
  }

  const line = lineFrom(rawMarket, rawSelection);
  const over = selection.startsWith("over") || /\bover\b/.test(selection);
  const under = selection.startsWith("under") || /\bunder\b/.test(selection);
  if (line !== null && (over || under)) {
    let actual = total;
    const homeMarket = /home (?:team )?goals?/.test(market) || market.includes(`${home} goals`);
    const awayMarket = /away (?:team )?goals?/.test(market) || market.includes(`${away} goals`);
    if (homeMarket) actual = homeScore;
    else if (awayMarket) actual = awayScore;
    return compareLine(actual, line, over);
  }

  return "pending";
}

/** Compatibility alias used by older verification code. */
export const evaluatePick = evaluateLeg;
