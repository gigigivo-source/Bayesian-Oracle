// Value Accumulator — Real bookmaker odds (The Odds API)
//
// Provider: The Odds API (v4) — https://api.the-odds-api.com/v4
//   Auth:    ?apiKey=${ODDS_API_KEY}
//   Endpoint: GET /sports/{sport_key}/odds  — ONE call returns EVERY fixture of
//             that league (h2h + totals, all bookmakers, decimal odds).
//             `btts` is a paid-tier market: requesting it on the free tier fails
//             the whole call with 422 INVALID_MARKET, so it is not requested.
//
// Free tier is 500 requests/month and The Odds API charges 1 credit per
// (region × market) per request, so quota is the binding constraint and this
// module is built around four hard rules:
//
//   1. ONE REGION — `regions=uk` only (1 region, not the eu+uk pair), so the
//      h2h + totals request costs 2 credits instead of 4. Unibet UK, Pinnacle
//      and Betfair UK are all in that region.
//   2. ONE CALL PER LEAGUE — never per fixture, and only for leagues that
//      actually need a price (the scanner fetches AFTER qualification and
//      skips leagues with fewer than 3 qualified legs). One response carries
//      every fixture of the league.
//   3. 24h CACHE, 6h NEAR KICKOFF — results are persisted in
//      `league_odds_cache`. A valid row (now() < expires_at) is served with
//      ZERO HTTP calls. The TTL comes from ttlForLeague(): 24h normally, but
//      6h for a league whose earliest unpriced kickoff is inside 24h, so the
//      prices on the matches that are about to be played stay fresh.
//   4. FAIL SOFT — unset key, unsupported league, network error, non-200, or
//      an unparseable body all return [] and the caller falls back to Bzzoiro
//      Consensus. Nothing here ever throws, and no price is ever fabricated.
//
// Cache discipline: ONLY successful 200 responses with a parseable body are
// written. A failed fetch is never cached — otherwise a transient outage would
// be served as "no real odds" for the next 6-24 hours.
//
// Corners and Cards are NOT served by The Odds API. BTTS is a paid-tier market
// we do not request (see the URL builder). Those legs always resolve to null
// here and the scanner keeps their Consensus price.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { leagueOddsCache } from "@/db/schema";

export interface RealBookOdds {
  fixtureHome: string; // normalised home team name
  fixtureAway: string;
  bookmaker: string; // "Bet365", "Pinnacle", "1xBet", etc
  marketLabel: string; // "h2h" | "totals" | "btts"
  line: number | null;
  selection: string; // "Home" | "Away" | "Draw" | "Over" | "Under" | "Yes" | "No"
  odds: number; // decimal
}

const ODDS_API_BASE = (() => {
  const raw = (process.env.ODDS_API_BASE ?? "https://api.the-odds-api.com/v4").trim();
  return raw.replace(/\/+$/, "");
})();
const TIMEOUT_MS = 8000;
/** Default cache TTL — one league is fetched at most once per 24 hours. */
export const ODDS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Shortened TTL for a league whose next unpriced kickoff is inside 24 hours. */
export const ODDS_CACHE_TTL_NEAR_KICKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * Cache lifetime for one league, driven by the earliest kickoff still to be
 * priced in that league:
 *
 *   - no known kickoff            → 24h (nothing time-critical to keep fresh)
 *   - earliest kickoff >= 24h out → 24h (one fetch a day is plenty)
 *   - earliest kickoff <  24h out → 6h  (kicking off soon: prices move fast)
 *
 * This is what keeps a daily refresh cheap while a match day still gets a
 * handful of refreshes instead of stale morning prices.
 */
export function ttlForLeague(earliestKickoff: Date | null): number {
  if (!earliestKickoff) return ODDS_CACHE_TTL_MS;
  const hoursUntil =
    (earliestKickoff.getTime() - Date.now()) / 3_600_000;
  return hoursUntil < 24 ? ODDS_CACHE_TTL_NEAR_KICKOFF_MS : ODDS_CACHE_TTL_MS;
}

/** App leagueSlug → The Odds API sport key. Anything absent is not served. */
const SPORT_KEYS: Record<string, string> = {
  "eng.1": "soccer_epl",
  "esp.1": "soccer_spain_la_liga",
  "ita.1": "soccer_italy_serie_a",
  "ger.1": "soccer_germany_bundesliga",
  "fra.1": "soccer_france_ligue_one",
  "uefa.champions": "soccer_uefa_champs_league",
  "uefa.europa": "soccer_uefa_europa_league",
};

/** Sport key for an app league slug, or null when The Odds API does not cover it. */
export function sportKeyForLeague(leagueSlug: string): string | null {
  return SPORT_KEYS[leagueSlug] ?? null;
}

let warnedNoKey = false;

function getApiKey(): string {
  return (process.env.ODDS_API_KEY ?? "").trim();
}

// ─── Team-name normalisation ─────────────────────────────────────────────────

/** Club-type suffixes that differ between feeds: "Manchester United FC" vs "Manchester United". */
const SUFFIX_TOKENS = new Set(["fc", "cf", "sc", "afc"]);

/**
 * Normalise a team name for comparison: lowercase, accents stripped,
 * punctuation collapsed, club suffixes removed.
 */
export function normalizeTeamName(name: string): string {
  const tokens = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const kept = tokens.filter((t) => !SUFFIX_TOKENS.has(t));
  return (kept.length > 0 ? kept : tokens).join(" ");
}

/** Do two team names refer to the same club? "Manchester United FC" === "Manchester United". */
export function teamNamesMatch(a: string, b: string): boolean {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const ta = na.split(" ");
  const tb = nb.split(" ");
  const hits = ta.filter((t) =>
    tb.some((u) => u === t || (t.length >= 4 && u.startsWith(t)) || (u.length >= 4 && t.startsWith(u))),
  ).length;
  return hits / Math.max(ta.length, tb.length) >= 0.7;
}

/** Does `text` (an engine market or selection) reference this team by name? */
function textReferencesTeam(text: string, team: string): boolean {
  const nt = normalizeTeamName(text);
  const tt = normalizeTeamName(team);
  if (!nt || !tt) return false;
  if (nt.includes(tt)) return true;
  // Every distinctive token of the team must appear in the text, so
  // "Manchester City" never matches "Manchester United Win".
  const teamTokens = tt.split(" ").filter((t) => t.length >= 3);
  if (teamTokens.length === 0) return false;
  const textTokens = nt.split(" ");
  return teamTokens.every((t) =>
    textTokens.some((u) => u === t || (t.length >= 4 && u.startsWith(t)) || (u.length >= 4 && t.startsWith(u))),
  );
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

interface OddsApiOutcome {
  name?: unknown;
  price?: unknown;
  point?: unknown;
}
interface OddsApiMarket {
  key?: unknown;
  outcomes?: OddsApiOutcome[];
}
interface OddsApiBookmaker {
  key?: unknown;
  title?: unknown;
  markets?: OddsApiMarket[];
}
interface OddsApiEvent {
  id?: unknown;
  home_team?: unknown;
  away_team?: unknown;
  bookmakers?: OddsApiBookmaker[];
}

const SERVED_MARKETS = new Set(["h2h", "totals", "btts"]);

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Map a raw h2h outcome name (team name or "Draw") onto Home / Away / Draw. */
function h2hSelection(outcomeName: string, home: string, away: string): string | null {
  if (/^draw$/i.test(outcomeName)) return "Draw";
  if (teamNamesMatch(outcomeName, home)) return "Home";
  if (teamNamesMatch(outcomeName, away)) return "Away";
  return null;
}

/**
 * Flatten one league response into RealBookOdds rows — every fixture in the
 * league comes back in this single payload, so the scan costs one call.
 */
export function parseLeagueOdds(data: unknown): RealBookOdds[] {
  if (!Array.isArray(data)) return [];
  const out: RealBookOdds[] = [];

  for (const rawEvent of data as OddsApiEvent[]) {
    const home = str(rawEvent?.home_team);
    const away = str(rawEvent?.away_team);
    if (!home || !away) continue;

    for (const book of Array.isArray(rawEvent?.bookmakers) ? rawEvent.bookmakers : []) {
      const bookmaker = str(book?.title) || str(book?.key);
      if (!bookmaker) continue;

      for (const market of Array.isArray(book?.markets) ? book.markets : []) {
        const marketLabel = str(market?.key);
        if (!SERVED_MARKETS.has(marketLabel)) continue;

        for (const outcome of Array.isArray(market?.outcomes) ? market.outcomes : []) {
          const odds = num(outcome?.price);
          if (odds === null || odds <= 1) continue; // never fabricate a price
          const name = str(outcome?.name);
          if (!name) continue;

          let selection: string | null = null;
          if (marketLabel === "totals") {
            if (/^over$/i.test(name)) selection = "Over";
            else if (/^under$/i.test(name)) selection = "Under";
          } else if (marketLabel === "btts") {
            if (/^yes$/i.test(name)) selection = "Yes";
            else if (/^no$/i.test(name)) selection = "No";
          } else {
            selection = h2hSelection(name, home, away);
          }
          if (!selection) continue;

          out.push({
            fixtureHome: home,
            fixtureAway: away,
            bookmaker,
            marketLabel,
            line: marketLabel === "totals" ? num(outcome?.point) : null,
            selection,
            odds,
          });
        }
      }
    }
  }
  return out;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

interface OddsFetchOutcome {
  ok: boolean;
  status: number;
  /** x-requests-remaining as reported by The Odds API. */
  quotaRemaining: string | null;
  /** null when the body was missing or unparseable (a failure, not an empty league). */
  rows: RealBookOdds[] | null;
}

/** GET with an 8s timeout. Never throws — returns null on any transport error. */
async function oddsGet(path: string): Promise<OddsFetchOutcome | null> {
  const url = `${ODDS_API_BASE}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    let quotaRemaining: string | null = null;
    try {
      quotaRemaining = res.headers?.get?.("x-requests-remaining") ?? null;
    } catch {
      quotaRemaining = null;
    }
    if (!res.ok) {
      return { ok: false, status: res.status, quotaRemaining, rows: null };
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!Array.isArray(body)) {
      return { ok: false, status: res.status, quotaRemaining, rows: null };
    }
    return { ok: true, status: res.status, quotaRemaining, rows: parseLeagueOdds(body) };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Cache (quota protection) ────────────────────────────────────────────────

function isRowShape(row: unknown): row is RealBookOdds {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.fixtureHome === "string" &&
    typeof r.fixtureAway === "string" &&
    typeof r.bookmaker === "string" &&
    typeof r.marketLabel === "string" &&
    typeof r.selection === "string" &&
    typeof r.odds === "number" &&
    Number.isFinite(r.odds)
  );
}

/** Re-hydrate cached rows, dropping anything that no longer matches the shape. */
function parseCachedRows(json: unknown): RealBookOdds[] {
  if (!Array.isArray(json)) return [];
  return json.filter(isRowShape).map((r) => ({
    fixtureHome: r.fixtureHome,
    fixtureAway: r.fixtureAway,
    bookmaker: r.bookmaker,
    marketLabel: r.marketLabel,
    line: typeof r.line === "number" && Number.isFinite(r.line) ? r.line : null,
    selection: r.selection,
    odds: r.odds,
  }));
}

function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }
  return NaN;
}

/**
 * Read a valid cache row for this league. Valid = now() < expires_at.
 * Returns null on miss, on an expired row, on unparseable JSON, or if the
 * database is unreachable (logged, then the caller falls through to HTTP).
 */
async function readCache(leagueSlug: string): Promise<RealBookOdds[] | null> {
  try {
    const rows = await db
      .select()
      .from(leagueOddsCache)
      .where(eq(leagueOddsCache.leagueSlug, leagueSlug))
      .limit(1);
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) {
      console.log(`[VA][odds-api] CACHE MISS ${leagueSlug}: no row — fetching`);
      return null;
    }
    const expiresAt = toMs(row.expiresAt);
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
      console.log(`[VA][odds-api] CACHE MISS ${leagueSlug}: row expired — fetching`);
      return null;
    }
    const parsed = parseCachedRows(row.responseJson);
    console.log(
      `[VA][odds-api] CACHE HIT ${leagueSlug}: ${parsed.length} rows, 0 requests used ` +
        `(valid until ${new Date(expiresAt).toISOString()})`,
    );
    return parsed;
  } catch (err) {
    console.log(`[VA][odds-api] CACHE READ FAILED ${leagueSlug}: ${String(err)} — fetching`);
    return null;
  }
}

/**
 * UPSERT the parsed rows with the league's TTL (see ttlForLeague). Called ONLY
 * after a successful 200 with a parseable body: a failure must never be served
 * for the life of a cache row. A write failure is logged and swallowed — the
 * caller still gets the rows.
 */
async function writeCache(
  leagueSlug: string,
  sportKey: string,
  rows: RealBookOdds[],
  ttlMs: number = ODDS_CACHE_TTL_MS,
): Promise<void> {
  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    await db
      .insert(leagueOddsCache)
      .values({ leagueSlug, sportKey, responseJson: rows, fetchedAt: now, expiresAt })
      .onConflictDoUpdate({
        target: leagueOddsCache.leagueSlug,
        set: { sportKey, responseJson: rows, fetchedAt: now, expiresAt },
      });
    console.log(
      `[VA][odds-api] CACHE WRITE ${leagueSlug}: ${rows.length} rows, valid until ${expiresAt.toISOString()}`,
    );
  } catch (err) {
    console.log(`[VA][odds-api] CACHE WRITE FAILED ${leagueSlug}: ${String(err)}`);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Real bookmaker odds for every fixture of one league. ONE HTTP call per
 * league per cache window at most (cached), never per fixture.
 *
 * @param earliestKickoff earliest kickoff still to be priced in this league;
 *   drives the cache TTL (24h normally, 6h when the kickoff is inside 24h).
 *   `null`/omitted means unknown → the 24h default.
 * @param forceRefresh `true` skips the cache READ (`?freshOdds=true` on
 *   /api/va/scan) so the scan always prices from a fresh response. The
 *   response is still written to the cache on success, and failures are still
 *   never cached.
 *
 * Returns [] when: ODDS_API_KEY is unset, the league has no sport key (no
 * request is made at all), a cache miss is followed by a failed fetch, or the
 * body is unparseable. The caller must fall back to Bzzoiro Consensus.
 */
export async function fetchLeagueRealOdds(
  leagueSlug: string,
  earliestKickoff?: Date | null,
  forceRefresh?: boolean,
): Promise<RealBookOdds[]> {
  if (!getApiKey()) {
    if (!warnedNoKey) {
      console.log("[VA][odds-api] ODDS_API_KEY not set — every leg uses Bzzoiro Consensus");
      warnedNoKey = true;
    }
    return [];
  }

  const sportKey = sportKeyForLeague(leagueSlug);
  if (!sportKey) {
    console.log(`[VA][odds-api] ${leagueSlug} has no sport key — skipping (0 requests used)`);
    return [];
  }

  const ttlMs = ttlForLeague(earliestKickoff ?? null);

  if (forceRefresh) {
    console.log(
      `[VA][odds-api] FORCE REFRESH ${leagueSlug}: freshOdds=true — cache read skipped` +
        ` (ttl ${Math.round(ttlMs / 3_600_000)}h)`,
    );
  } else {
    const cached = await readCache(leagueSlug);
    if (cached) return cached;
  }

  const path =
    `/sports/${sportKey}/odds` +
    `?apiKey=${encodeURIComponent(getApiKey())}` +
    // ONE region: The Odds API bills 1 credit per (region × market), so the
    // `uk` region alone costs h2h + totals = 2 credits per league instead of
    // the 4 that `eu,uk` costs. Unibet UK, Pinnacle and Betfair UK live in it.
    `&regions=uk` +
    // `btts` is NOT part of The Odds API free tier. Asking for it makes the whole
    // request fail with 422 INVALID_MARKET ("Markets not supported by this
    // endpoint: btts") — no fixtures at all, so every leg silently fell back to
    // Consensus. BTTS legs therefore resolve to null here and keep their
    // Consensus price; the parser below still handles a btts market, so if we
    // ever move to a paid tier, just add `btts` back to this list.
    `&markets=h2h,totals` +
    `&oddsFormat=decimal` +
    `&dateFormat=iso`;

  const outcome = await oddsGet(path);
  if (!outcome || !outcome.ok || outcome.rows === null) {
    console.log(
      `[VA][odds-api] ${leagueSlug} fetch failed (${outcome ? `HTTP ${outcome.status}` : "network error/timeout"})` +
        ` — falling back to Consensus, nothing cached` +
        `${outcome?.quotaRemaining ? ` · quota remaining: ${outcome.quotaRemaining}` : ""}`,
    );
    return [];
  }

  const rows = outcome.rows;
  const fixtures = new Set(rows.map((r) => `${r.fixtureHome}|${r.fixtureAway}`)).size;
  console.log(
    `[VA][odds-api] ${leagueSlug} (${sportKey}) → ${rows.length} rows across ${fixtures} fixtures` +
      ` · quota remaining: ${outcome.quotaRemaining ?? "unknown"}`,
  );

  await writeCache(leagueSlug, sportKey, rows, ttlMs);
  return rows;
}

// ─── Matching ────────────────────────────────────────────────────────────────

interface TargetOutcome {
  marketLabel: string;
  selection: string;
  line: number | null;
}

function extractLine(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function linesMatch(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < 0.001;
}

/** Families The Odds API does not serve. Corners and Cards are the big two. */
const UNSERVED = /corner|card|booking|shot|save|offsid|throw|goal kick|foul|penalty/i;

/**
 * Translate an engine market + selection into the The Odds API
 * (market, selection, line) triple we should look for, or null when the
 * family is not served — corners, cards, shots, saves and friends.
 */
function targetOutcome(
  engineMarket: string,
  engineSelection: string,
  fixtureHome: string,
  fixtureAway: string,
): TargetOutcome | null {
  const market = engineMarket.trim();
  const selection = engineSelection.trim();
  if (!market || !selection) return null;
  const marketLower = market.toLowerCase();
  const selectionLower = selection.toLowerCase();

  // Corners and Cards are NOT served by The Odds API — never attempt to match.
  if (UNSERVED.test(marketLower) || UNSERVED.test(selectionLower)) return null;

  // Both Teams To Score → btts / Yes | No
  if (/both teams to score|btts/i.test(marketLower)) {
    if (/^yes\b/i.test(selection)) return { marketLabel: "btts", selection: "Yes", line: null };
    if (/^no\b/i.test(selection)) return { marketLabel: "btts", selection: "No", line: null };
    return null;
  }

  // Total Goals O/U N → totals / Over | Under, line N
  if (/total\s+goals\s+o\/u/i.test(marketLower)) {
    const line = extractLine(selection) ?? extractLine(market);
    if (line === null) return null;
    if (/^over\b/i.test(selection)) return { marketLabel: "totals", selection: "Over", line };
    if (/^under\b/i.test(selection)) return { marketLabel: "totals", selection: "Under", line };
    return null;
  }

  // Match Result: {Team} Win → h2h / Home | Away ;  Match Result: Draw → h2h / Draw
  if (/match result|match winner|\b1x2\b|\bmoneyline\b|to win|\bwin\b/i.test(marketLower)) {
    if (/^draw\b/i.test(selection) || /^draw\b/i.test(market)) return { marketLabel: "h2h", selection: "Draw", line: null };
    const mentionsHome = textReferencesTeam(selection, fixtureHome) || textReferencesTeam(market, fixtureHome);
    const mentionsAway = textReferencesTeam(selection, fixtureAway) || textReferencesTeam(market, fixtureAway);
    // A team name must be unambiguous: "Manchester United" must not price the
    // "Manchester City Win" row.
    if (mentionsHome && !mentionsAway) return { marketLabel: "h2h", selection: "Home", line: null };
    if (mentionsAway && !mentionsHome) return { marketLabel: "h2h", selection: "Away", line: null };
    return null;
  }

  return null;
}

/**
 * Highest-odds selection across all bookmakers for this fixture + engine
 * market + selection, or null when no book prices it (corners, cards, an
 * unavailable line, a league The Odds API does not carry, …).
 */
export function bestPriceFor(
  options: RealBookOdds[],
  fixtureHome: string,
  fixtureAway: string,
  engineMarket: string,
  engineSelection: string,
): { odds: number; bookmaker: string } | null {
  if (!options || options.length === 0) return null;

  const target = targetOutcome(engineMarket, engineSelection, fixtureHome, fixtureAway);
  if (!target) return null;

  let best: { odds: number; bookmaker: string } | null = null;
  for (const row of options) {
    if (!teamNamesMatch(row.fixtureHome, fixtureHome)) continue;
    if (!teamNamesMatch(row.fixtureAway, fixtureAway)) continue;
    if (row.marketLabel !== target.marketLabel) continue;
    if (row.selection !== target.selection) continue;
    if (!linesMatch(row.line, target.line)) continue;
    if (!Number.isFinite(row.odds) || row.odds <= 1) continue;
    if (!best || row.odds > best.odds) best = { odds: row.odds, bookmaker: row.bookmaker };
  }
  return best;
}
