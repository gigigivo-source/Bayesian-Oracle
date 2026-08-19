// ĞIGI GIVØ — Intelligent Top-N Selector
//
// CORE GUARANTEES:
//   1. Top-1 ALWAYS has a pick — with 217 markets there is ALWAYS something safe.
//      Never returns empty unless 1xBet is confirmed for the fixture and offers
//      none of the 217 registry markets (match is then skipped).
//      Falls through 5 gate tiers then takes the first matchup-aware candidate.
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
//
//   4. Top-1 is PINNED across Top 1/3/5/10 so a team-specific extreme line can
//      never outrank the headline pick after the final safety sort.
//
//   5. Final Top-1 is gated by live 1xBet availability when API_FOOTBALL_KEY is set:
//      walk the statistically ranked list (#1, then #2, then #3, …) and take the
//      first market 1xBet actually offers.

import { execFileSync } from "node:child_process";
import { poissonPmf } from "./stats";
import { calibratedWinProb } from "./calibration";
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

/**
 * BROADLY OFFERED = the five market families bookmakers list on virtually every
 * fixture (1xBet, Bet365, DraftKings, Pinnacle). These are the default Top-1
 * pool. Team-specific lines are NOT in this set — they may still become Top-1
 * when the Poisson λ gate in `isMatchupAwareTeamGoalLine` says the line is
 * reasonable for THIS matchup (never by hard-coding a league or club as "big").
 *
 *   ✅ Total Goals O/U
 *   ✅ Match Result 1X2
 *   ✅ Double Chance 1X/12/X2
 *   ✅ Both Teams To Score
 *   ✅ Draw No Bet
 */
function isBroadlyOffered(m: Market): boolean {
  const n = m.name;

  if (n.startsWith("Total Goals O/U") || n.startsWith("Total Goals")) return true;
  if (n.startsWith("Match Result")) return true;
  if (n.includes("Double Chance")) return true;
  if (n === "Both Teams To Score" || n.startsWith("Both Teams To Score")) return true;
  if (n.startsWith("Draw No Bet") || n.includes("Draw No Bet")) return true;

  return false;
}

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

/** Raw (uncalibrated) Poisson probability of the selected O/U side. */
function rawOuProbability(m: Market, lambda: number): number | null {
  const lineMatch = m.name.match(/O\/U\s+([\d.]+)/);
  if (!lineMatch) return null;
  const line      = Number(lineMatch[1]);
  const isOver    = m.selection.startsWith("Over");
  const threshold = Math.ceil(line);
  let overMass = 0;
  for (let k = threshold; k <= threshold + 40; k++) overMass += poissonPmf(k, lambda);
  overMass = Math.max(0, Math.min(1, overMass));
  return isOver ? overMass : 1 - overMass;
}

const TRIVIAL_RAW_PROB = 0.90;

function isTrivialSureThing(
  m:        Market,
  lam:      LambdaSet,
  homeName: string,
  awayName: string,
): boolean {
  const lambda = lambdaFor(m, lam, homeName, awayName);
  if (lambda === null) return false;
  const raw = rawOuProbability(m, lambda);
  return raw !== null && raw > TRIVIAL_RAW_PROB;
}

/**
 * Matchup-aware Top-1 gate for a team-goal line.
 * Eligible only when the posted line sits within two Poisson standard deviations
 * of THAT team's expected goals for THIS match — no league/club allow-lists.
 */
function isMatchupAwareTeamGoalLine(
  m:        Market,
  lam:      LambdaSet,
  homeName: string,
  awayName: string,
): boolean {
  if (!isTeamGoalOu(m)) return false;
  const lambda = lambdaFor(m, lam, homeName, awayName);
  const lineMatch = m.name.match(/O\/U\s+([\d.]+)/);
  if (lambda === null || !lineMatch) return false;
  const line = Number(lineMatch[1]);
  const sd   = Math.sqrt(Math.max(lambda, 0.05));
  if (Math.abs(line - lambda) > 2 * sd) return false;
  const raw = rawOuProbability(m, lambda);
  if (raw !== null && raw > TRIVIAL_RAW_PROB) return false;
  return true;
}

/**
 * Top-1 eligibility:
 *   • broadly offered bookmaker families (Fix 2), OR a team-goal line whose
 *     line is within 2σ of this matchup's λ (Fix 3)
 *   • never a trivial raw Poisson probability above 90%
 *   • never a volatile / unverifiable family
 */
function isTop1Candidate(
  m:        Market,
  lam:      LambdaSet,
  homeName: string,
  awayName: string,
): boolean {
  if (isVolatile(m) || !isVerifiable(m)) return false;
  if (isTrivialSureThing(m, lam, homeName, awayName)) return false;
  if (isBroadlyOffered(m)) return true;
  if (isMatchupAwareTeamGoalLine(m, lam, homeName, awayName)) return true;
  return false;
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
  const bullet     = isTop1Candidate(m, lam, homeName, awayName);
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

// ─── 1xBet availability ───────────────────────────────────────────────────────

const AF_BASE = "https://v3.football.api-sports.io";
const ONEXBET_ID = 11;

export interface OneXBetBet {
  name:   string;
  values: Array<{ value: string; odd: string }>;
}

/** Confirmed 1xBet book for a fixture. `bets` may be empty if they list the match with no markets. */
export interface OneXBetBook {
  fixtureId: number;
  bets:      OneXBetBet[];
}

export type OneXBetResolution =
  | { status: "unknown" }                 // no key / lookup failed — fail-open
  | { status: "absent" }                  // fixture found, 1xBet not listing it
  | { status: "present"; book: OneXBetBook };

export interface SelectOptions {
  /** YYYY-MM-DD — improves fixture lookup when auto-fetching 1xBet. */
  date?:            string;
  /** Full club names for API-Football search (may differ from market-title short names). */
  homeSearchName?:  string;
  awaySearchName?:  string;
  /** Pre-fetched book. `null` = caller already tried and got nothing (fail-open). */
  oneXBet?:         OneXBetBook | null;
  /** Skip the live 1xBet walk even if a key is configured. */
  skipBookGate?:    boolean;
}

interface AfFixtureRow {
  fixture: { id: number; date?: string };
  teams:   { home: { name: string }; away: { name: string } };
}

interface AfOddsRow {
  bookmakers?: Array<{
    id?:   number;
    name:  string;
    bets?: OneXBetBet[];
  }>;
}

function footballKey(): string {
  return process.env.API_FOOTBALL_KEY ?? process.env.FOOTBALL_API_KEY ?? "";
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function teamScore(a: string, b: string): number {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 3;
  if (na.includes(nb) || nb.includes(na)) return 2;
  const stop = new Set(["fc", "cf", "afc", "sc", "club", "de", "the", "and"]);
  const words = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3 && !stop.has(w));
  const overlap = words(a).filter((w) => words(b).includes(w));
  if (overlap.length >= 2) return 2;
  if (overlap.length === 1) return 1;
  return 0;
}

function fixtureMatches(row: AfFixtureRow, home: string, away: string): boolean {
  const h = row.teams.home.name;
  const a = row.teams.away.name;
  const direct  = teamScore(h, home) + teamScore(a, away);
  const swapped = teamScore(h, away) + teamScore(a, home);
  return Math.max(direct, swapped) >= 3;
}

function pick1xBet(bookmakers: NonNullable<AfOddsRow["bookmakers"]>): OneXBetBet[] | null {
  const hit = bookmakers.find((b) => b.id === ONEXBET_ID || /1x\s*bet/i.test(b.name ?? ""));
  if (!hit) return null;
  return hit.bets ?? [];
}

/** Shared in-process cache so a match is only resolved once per few minutes. */
const bookCache = new Map<string, { at: number; resolution: OneXBetResolution }>();
const BOOK_TTL_MS = 8 * 60 * 1000;

function cacheKey(home: string, away: string, date?: string): string {
  return `${normName(home)}|${normName(away)}|${date ?? "*"}`;
}

function readCache(home: string, away: string, date?: string): OneXBetResolution | null {
  const keys = [cacheKey(home, away, date), cacheKey(home, away)];
  for (const k of keys) {
    const hit = bookCache.get(k);
    if (hit && Date.now() - hit.at < BOOK_TTL_MS) return hit.resolution;
  }
  return null;
}

function writeCache(home: string, away: string, date: string | undefined, resolution: OneXBetResolution) {
  bookCache.set(cacheKey(home, away, date), { at: Date.now(), resolution });
  bookCache.set(cacheKey(home, away), { at: Date.now(), resolution });
}

function parseJsonSafe(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

/** Synchronous GET used by selectTopPicks so the live engine path stays sync. */
function syncAfGet(path: string): unknown {
  const key = footballKey();
  if (!key) return null;
  const url = `${AF_BASE}${path}`;
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const payload = JSON.stringify({ url, key });
    const script = `
      const {url, key} = ${payload};
      fetch(url, { headers: { "x-apisports-key": key } })
        .then(async (r) => { process.stdout.write(await r.text()); process.exit(r.ok ? 0 : 1); })
        .catch(() => process.exit(2));
    `;
    const out = execFileSync(process.execPath, ["-e", script], {
      encoding:  "utf8",
      timeout:   12000,
      maxBuffer: 4 * 1024 * 1024,
      stdio:     ["ignore", "pipe", "ignore"],
    });
    return out ? parseJsonSafe(out) : null;
  } catch {
    return null;
  }
}

async function asyncAfGet(path: string): Promise<unknown> {
  const key = footballKey();
  if (!key) return null;
  try {
    const res = await fetch(`${AF_BASE}${path}`, {
      headers: { "x-apisports-key": key },
      next:    { revalidate: 180 },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function findFixtureInList(rows: AfFixtureRow[] | undefined, home: string, away: string): number | null {
  if (!rows?.length) return null;
  const hit = rows.find((r) => r?.teams && fixtureMatches(r, home, away));
  return hit?.fixture.id ?? null;
}

function resolveFixtureIdWith(
  getJson: (path: string) => unknown,
  home: string,
  away: string,
  date?: string,
): number | null {
  if (date) {
    const data = getJson(`/fixtures?date=${date}`) as { response?: AfFixtureRow[] } | null;
    const id = findFixtureInList(data?.response, home, away);
    if (id) return id;
  }

  const today = new Date().toISOString().slice(0, 10);
  if (today !== date) {
    const data = getJson(`/fixtures?date=${today}`) as { response?: AfFixtureRow[] } | null;
    const id = findFixtureInList(data?.response, home, away);
    if (id) return id;
  }

  const teams = getJson(`/teams?search=${encodeURIComponent(home)}`) as {
    response?: Array<{ team?: { id?: number; name?: string } }>;
  } | null;
  const teamId = teams?.response?.[0]?.team?.id;
  if (!teamId) return null;

  for (const path of [`/fixtures?team=${teamId}&next=15`, `/fixtures?team=${teamId}&last=5`]) {
    const data = getJson(path) as { response?: AfFixtureRow[] } | null;
    const id = findFixtureInList(data?.response, home, away);
    if (id) return id;
  }
  return null;
}

function pull1xBetBets(
  getJson: (path: string) => unknown,
  fixtureId: number,
): OneXBetBet[] | null {
  const filtered = getJson(`/odds?fixture=${fixtureId}&bookmaker=${ONEXBET_ID}`) as { response?: AfOddsRow[] } | null;
  const fromFiltered = pick1xBet(filtered?.response?.[0]?.bookmakers ?? []);
  if (fromFiltered) return fromFiltered;

  const all = getJson(`/odds?fixture=${fixtureId}`) as { response?: AfOddsRow[] } | null;
  return pick1xBet(all?.response?.[0]?.bookmakers ?? []);
}

function resolve1xBetWith(
  getJson: (path: string) => unknown,
  home: string,
  away: string,
  date?: string,
): OneXBetResolution {
  if (!footballKey()) return { status: "unknown" };
  const cached = readCache(home, away, date);
  if (cached) return cached;

  const fixtureId = resolveFixtureIdWith(getJson, home, away, date);
  if (!fixtureId) {
    const res: OneXBetResolution = { status: "unknown" };
    writeCache(home, away, date, res);
    return res;
  }

  const bets = pull1xBetBets(getJson, fixtureId);
  const res: OneXBetResolution = bets === null
    ? { status: "absent" }
    : { status: "present", book: { fixtureId, bets } };
  writeCache(home, away, date, res);
  return res;
}

/** Async 1xBet lookup — prefer this from async callers. */
export async function load1xBetBook(
  home: string,
  away: string,
  date?: string,
): Promise<OneXBetResolution> {
  if (!footballKey()) return { status: "unknown" };
  const cached = readCache(home, away, date);
  if (cached) return cached;

  const fixtureId = await (async () => {
    const tryDate = async (d: string) => {
      const data = await asyncAfGet(`/fixtures?date=${d}`) as { response?: AfFixtureRow[] } | null;
      return findFixtureInList(data?.response, home, away);
    };
    if (date) {
      const id = await tryDate(date);
      if (id) return id;
    }
    const today = new Date().toISOString().slice(0, 10);
    if (today !== date) {
      const id = await tryDate(today);
      if (id) return id;
    }
    const teams = await asyncAfGet(`/teams?search=${encodeURIComponent(home)}`) as {
      response?: Array<{ team?: { id?: number } }>;
    } | null;
    const teamId = teams?.response?.[0]?.team?.id;
    if (!teamId) return null;
    for (const path of [`/fixtures?team=${teamId}&next=15`, `/fixtures?team=${teamId}&last=5`]) {
      const data = await asyncAfGet(path) as { response?: AfFixtureRow[] } | null;
      const id = findFixtureInList(data?.response, home, away);
      if (id) return id;
    }
    return null;
  })();

  if (!fixtureId) {
    const res: OneXBetResolution = { status: "unknown" };
    writeCache(home, away, date, res);
    return res;
  }

  const filtered = await asyncAfGet(`/odds?fixture=${fixtureId}&bookmaker=${ONEXBET_ID}`) as { response?: AfOddsRow[] } | null;
  let bets = pick1xBet(filtered?.response?.[0]?.bookmakers ?? []);
  if (bets === null) {
    const all = await asyncAfGet(`/odds?fixture=${fixtureId}`) as { response?: AfOddsRow[] } | null;
    bets = pick1xBet(all?.response?.[0]?.bookmakers ?? []);
  }

  const res: OneXBetResolution = bets === null
    ? { status: "absent" }
    : { status: "present", book: { fixtureId, bets } };
  writeCache(home, away, date, res);
  return res;
}

function resolve1xBetSync(home: string, away: string, date?: string): OneXBetResolution {
  return resolve1xBetWith(syncAfGet, home, away, date);
}

function hasValue(bet: OneXBetBet, ...needles: string[]): boolean {
  const vs = bet.values.map((v) => v.value.toLowerCase().replace(/\s+/g, " ").trim());
  return needles.some((n) => {
    const needle = n.toLowerCase().replace(/\s+/g, " ").trim();
    return vs.some((v) => v === needle || v.includes(needle));
  });
}

function betsNamed(bets: OneXBetBet[], ...patterns: RegExp[]): OneXBetBet[] {
  return bets.filter((b) => patterns.some((p) => p.test(b.name)));
}

/**
 * True when 1xBet's odds payload contains this registry market
 * (same line + side, or the parent family for discrete markets).
 */
export function isMarketOn1xBet(
  m:        Market,
  book:     OneXBetBook,
  homeName: string,
  awayName: string,
): boolean {
  const n    = m.name;
  const sel  = m.selection;
  const bets = book.bets;
  const lineM = n.match(/O\/U\s+([\d.]+)/);
  const line  = lineM ? lineM[1] : null;
  const dir   = sel.startsWith("Over") ? "Over" : sel.startsWith("Under") ? "Under" : "";

  if (/^Total Goals/.test(n) && line) {
    const gs = betsNamed(bets, /^Goals Over\/Under$/i, /^Goal Line$/i);
    return gs.some((b) => hasValue(b, `${dir} ${line}`));
  }

  if (isTeamGoalOu(m) && line) {
    const homeSide = teamMentions(n, homeName);
    const gs = homeSide
      ? betsNamed(bets, /Total - Home/i, /Goals Over\/Under - Home/i, /Home Team.*Goals/i, /Team Total.*Home/i)
      : betsNamed(bets, /Total - Away/i, /Goals Over\/Under - Away/i, /Away Team.*Goals/i, /Team Total.*Away/i);
    return gs.some((b) => hasValue(b, `${dir} ${line}`));
  }

  if (n.startsWith("Match Result") || n.includes("Match Result")) {
    return betsNamed(bets, /^Match Winner$/i, /Full Time Result/i, /1X2/i).length > 0;
  }

  if (n.includes("Double Chance")) {
    return betsNamed(bets, /Double Chance/i).length > 0;
  }

  if (n.includes("Both Teams To Score") || n.includes("Both Teams Score")) {
    return betsNamed(bets, /Both Teams Score/i).length > 0;
  }

  if (n.includes("Draw No Bet")) {
    return betsNamed(bets, /^Home\/Away$/i, /Draw No Bet/i).length > 0;
  }

  if (n.includes("Clean Sheet")) {
    return betsNamed(bets, /Clean Sheet/i).length > 0;
  }

  if (/Total Corners/.test(n) && line) {
    const gs = betsNamed(bets, /Corners Over/i, /Total Corners/i, /Corners \/ Over/i);
    return gs.some((b) => hasValue(b, `${dir} ${line}`));
  }

  if (/Corners/.test(n) && line) {
    const homeSide = teamMentions(n, homeName);
    const gs = homeSide
      ? betsNamed(bets, /Home Corners/i, /Corners.*Home/i)
      : betsNamed(bets, /Away Corners/i, /Corners.*Away/i);
    return gs.some((b) => hasValue(b, `${dir} ${line}`));
  }

  if (/Total Cards/.test(n) && line) {
    const gs = betsNamed(bets, /Cards Over/i, /Yellow Cards Over/i, /Total Cards/i);
    return gs.some((b) => hasValue(b, `${dir} ${line}`));
  }

  if (/Asian Handicap|Handicap/.test(n) && !n.includes("Draw No Bet")) {
    return betsNamed(bets, /Asian Handicap/i, /^Handicap$/i).length > 0;
  }

  if (n.includes("Correct Score") || n.includes("Exact Score")) {
    return betsNamed(bets, /Exact Score/i, /Correct Score/i).length > 0;
  }

  if (/1st Half Goals|First Half Goals/.test(n) && line) {
    const gs = betsNamed(bets, /Goals Over\/Under First Half/i, /First Half Goals/i);
    return gs.some((b) => hasValue(b, `${dir} ${line}`));
  }

  if (/2nd Half Goals|Second Half Goals/.test(n) && line) {
    const gs = betsNamed(bets, /Goals Over\/Under Second Half/i, /Second Half Goals/i);
    return gs.some((b) => hasValue(b, `${dir} ${line}`));
  }

  // Unmapped registry families (throw-ins, interceptions, …) are not on 1xBet.
  return false;
}

function offeredPredicate(
  resolution: OneXBetResolution,
  homeName:   string,
  awayName:   string,
): ((m: Market) => boolean) | null {
  if (resolution.status !== "present") return null;
  const book = resolution.book;
  return (m: Market) => isMarketOn1xBet(m, book, homeName, awayName);
}

// ─── Selection result ─────────────────────────────────────────────────────────

export interface SelectionResult {
  top1:     Market[];
  top3:     Market[];
  top5:     Market[];
  top10:    Market[];
  /** Set when the match is skipped because 1xBet offers none of the 217 markets. */
  skipped?: string;
}

const EMPTY_SELECTION = (reason: string): SelectionResult => ({
  top1: [], top3: [], top5: [], top10: [], skipped: reason,
});

// ─── Main selector ────────────────────────────────────────────────────────────

export function selectTopPicks(
  markets:        Market[],
  lam:            LambdaSet,
  homeName:       string,
  awayName:       string,
  confidenceMap?: Record<string, number>,
  opts?:          SelectOptions,
): SelectionResult {

  // ── Step 0: Resolve 1xBet availability ───────────────────────────────────
  let resolution: OneXBetResolution = { status: "unknown" };
  if (!opts?.skipBookGate) {
    if (opts?.oneXBet) {
      resolution = { status: "present", book: opts.oneXBet };
    } else if (opts?.oneXBet === null) {
      resolution = { status: "unknown" }; // caller looked up and got nothing
    } else {
      const searchHome = opts?.homeSearchName ?? homeName;
      const searchAway = opts?.awaySearchName ?? awayName;
      resolution = resolve1xBetSync(searchHome, searchAway, opts?.date);
    }
  }

  const isOffered = offeredPredicate(resolution, homeName, awayName);

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

  // Confirmed 1xBet book that offers none of the 217 registry markets → skip match.
  if (resolution.status === "absent") {
    return EMPTY_SELECTION("1xBet is not listing this fixture — match skipped.");
  }
  if (resolution.status === "present" && isOffered) {
    const anyOffered = markets.some((m) => isOffered(m));
    if (!anyOffered) {
      return EMPTY_SELECTION("1xBet offers none of the 217 registry markets for this match.");
    }
  }

  const passesBook = (m: Market): boolean => !isOffered || isOffered(m);

  // ── Step 2: TOP-1 from the FULL ranked list (before stat-line dedup) ──────
  // Dedup keeps the safest line per stat, which is often the trivial extreme
  // (Under 4.5 / Under 5.5). Top-1 must see the non-trivial siblings (Under 2.5)
  // or it will walk off the end of the eligible pool.
  // Walk #1, then #2, then #3, … of the statistically ranked eligible set.
  const bulletSorted = allScored
    .filter((s) => s.bulletproof && !isVolatile(s.market) && passesBook(s.market))
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
  // Fallback: first broadly offered, book-available market in statistical order.
  // Prefer Total Goals, then Double Chance, then Match Result, then BTTS, then DNB.
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
      const candidate = allScored.find((s) =>
        !isVolatile(s.market) && test(s.market) && s.wrongProb <= 0.20 && passesBook(s.market)
        && !isTrivialSureThing(s.market, lam, homeName, awayName),
      );
      if (candidate) top1Pick = candidate.market;
    }
  }
  // Absolute last resort: safest non-trivial Total Goals line on the board.
  if (!top1Pick) {
    const totalGoals = allScored.find((s) =>
      s.market.name.startsWith("Total Goals O/U")
      && passesBook(s.market)
      && !isTrivialSureThing(s.market, lam, homeName, awayName),
    );
    if (totalGoals) top1Pick = totalGoals.market;
  }
  // If 1xBet has the fixture but no Top-1-eligible market, take the first
  // offered non-trivial market so we only skip when NOTHING is offered.
  if (!top1Pick && isOffered) {
    const firstOffered = allScored.find((s) =>
      isOffered(s.market) && !isTrivialSureThing(s.market, lam, homeName, awayName),
    ) ?? allScored.find((s) => isOffered(s.market));
    if (firstOffered) top1Pick = firstOffered.market;
  }

  const top1: Market[] = top1Pick ? [top1Pick] : [];

  // ── Step 3: Deduplicate — ONE line per underlying stat ─────────────────────
  // Keep the Top-1 line for its stat; for every other stat keep the safest line.
  // This prevents two lines of the same stat from appearing in Top-10 where one
  // misses and the other hits, breaking monotonic order.
  const seenInDedup = new Set<string>();
  if (top1Pick) seenInDedup.add(statKey(top1Pick));
  const scored = allScored.filter((s) => {
    if (s.market === top1Pick) return true;
    const key = statKey(s.market);
    if (seenInDedup.has(key)) return false;
    seenInDedup.add(key);
    return true;
  });

  // ── Step 4: Separate into STABLE (safe) and VOLATILE pools ────────────────
  const stablePool   = scored.filter((s) => !isVolatile(s.market));
  const volatilePool = scored.filter((s) =>  isVolatile(s.market));

  // ── Step 5: Build Top-10 from stable pool only (volatile comes last) ───────
  // We fill Top-10 positions 1-9 entirely from stable picks, THEN add
  // at most 1 volatile pick as position 10 if we have room.
  const picked: Market[] = [...top1];
  const famCount: Record<string, number> = {};
  if (top1Pick) famCount[top1Pick.family] = 1;

  // Fill positions 2-9 from stable pool (no volatile). Prefer book-offered lines.
  for (const s of stablePool) {
    if (picked.length >= 9) break;
    if (picked.includes(s.market)) continue;
    if (!passesBook(s.market)) continue;
    const fam = s.market.family;
    const cap = STABLE_FAMILIES.has(fam) ? 3 : 2;
    if ((famCount[fam] ?? 0) >= cap) continue;
    picked.push(s.market);
    famCount[fam] = (famCount[fam] ?? 0) + 1;
  }

  // Position 10: ONE volatile pick if we still need a market
  if (picked.length < 10) {
    const bestVolatile = volatilePool.find((s) => !picked.includes(s.market) && passesBook(s.market));
    if (bestVolatile) picked.push(bestVolatile.market);
    // If still < 10, fill from stable remainder (offered first, then any)
    for (const s of stablePool) {
      if (picked.length >= 10) break;
      if (picked.includes(s.market)) continue;
      if (!passesBook(s.market)) continue;
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

  // Pin the filtered Top-1 so Top 3/5/10 never promote a disallowed headline.
  const remainder = finalSorted.filter((m) => m !== top1Pick);
  const pinned    = top1Pick ? [top1Pick, ...remainder] : finalSorted;

  return {
    top1,
    top3:  pinned.slice(0, 3),
    top5:  pinned.slice(0, 5),
    top10: pinned.slice(0, 10),
  };
}
