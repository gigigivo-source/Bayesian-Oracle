import dns from "node:dns";
import tls from "node:tls";
import * as espn from "@/lib/espn";
import {
  loadMatchesFromOpenfootball,
  matchesBefore,
  parseHistoricalDate,
  seasonCodes,
  seasonOf,
  type HistoricalMatch,
} from "@/lib/data/historical";
import { parseCsv } from "@/lib/data/sources/githubDatasets";
import {
  generateV2Predictions,
  translateTeamName,
  V4_LIVE_CONFIG,
  type MatchXgResolver,
} from "@/lib/v4-predictor";
import {
  buildFormTable,
  createMatchXgResolver,
  formResolverFrom,
  type FormResolver,
} from "@/lib/v4-predictor-server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DEFAULT_WEEK = 11;
const RESULTS_CSV_SEASON = "2026-27";
const RESULTS_CSV_API_URL =
  "https://api.github.com/repos/brysonhen/football_matchup_predictor/contents/data/raw/pl/E0_2627.csv";
const RESULTS_TTL_MS = 30 * 60_000;

try {
  dns.setDefaultResultOrder?.("ipv4first");
  const tlsExt = tls as unknown as {
    getCACertificates?: (type?: string) => string[];
    setDefaultCACertificates?: (certs: string[]) => void;
  };
  if (tlsExt.getCACertificates && tlsExt.setDefaultCACertificates) {
    tlsExt.setDefaultCACertificates([
      ...tlsExt.getCACertificates("default"),
      ...tlsExt.getCACertificates("system"),
    ]);
  }
} catch {
  // Ignore on runtimes without custom CA hooks.
}

interface CompletedMatchResult {
  homeGoals: number;
  awayGoals: number;
  isoDate: string | null;
  /** Real home xG (`HxG`), when the CSV provides it. */
  homeXg: number | null;
  /** Real away xG (`AxG`). */
  awayXg: number | null;
}

let cachedResults: { at: number; map: Map<string, CompletedMatchResult> } | null = null;

function parseWeekParam(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 38) return NaN;
  return parsed;
}

async function loadCompletedEplResults(): Promise<Map<string, CompletedMatchResult> | null> {
  if (cachedResults && Date.now() - cachedResults.at < RESULTS_TTL_MS) {
    return cachedResults.map;
  }
  try {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const response = await fetch(RESULTS_CSV_API_URL, {
      headers: {
        Accept: "application/vnd.github.raw+json",
        "User-Agent": "Mozilla/5.0 (compatible; GigiGivo/1.0)",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const rows = parseCsv((await response.text()).replace(/^\uFEFF/, ""));
    if (rows.length < 2) return null;
    const header = rows[0];
    const divIdx = header.indexOf("Div");
    const dateIdx = header.indexOf("Date");
    const timeIdx = header.indexOf("Time");
    const homeIdx = header.indexOf("HomeTeam");
    const awayIdx = header.indexOf("AwayTeam");
    const fthgIdx = header.indexOf("FTHG");
    const ftagIdx = header.indexOf("FTAG");
    // Real per-match expected goals. Optional: older seasons and some files omit
    // them, in which case the refactor degrades to goals-only form.
    const hxgIdx = header.indexOf("HxG");
    const axgIdx = header.indexOf("AxG");
    if (homeIdx < 0 || awayIdx < 0 || fthgIdx < 0 || ftagIdx < 0) return null;
    const readXg = (idx: number, row: string[]): number | null => {
      if (idx < 0) return null;
      const raw = (row[idx] ?? "").trim();
      if (raw === "") return null;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : null;
    };

    const map = new Map<string, CompletedMatchResult>();
    for (const row of rows.slice(1)) {
      if (divIdx >= 0 && row[divIdx] && row[divIdx] !== "E0") continue;
      const home = translateTeamName(row[homeIdx] ?? "");
      const away = translateTeamName(row[awayIdx] ?? "");
      const homeGoals = Number(row[fthgIdx]);
      const awayGoals = Number(row[ftagIdx]);
      if (
        !home ||
        !away ||
        row[fthgIdx] === "" ||
        row[ftagIdx] === "" ||
        !Number.isInteger(homeGoals) ||
        !Number.isInteger(awayGoals) ||
        homeGoals < 0 ||
        awayGoals < 0
      ) {
        continue;
      }
      const dayIso = dateIdx >= 0 ? parseHistoricalDate(row[dateIdx]) : null;
      const rawTime = timeIdx >= 0 ? (row[timeIdx] ?? "").trim() : "";
      const hhmm = /^\d{2}:\d{2}$/.test(rawTime) ? rawTime : "15:00";
      const isoDate = dayIso ? `${dayIso.slice(0, 10)}T${hhmm}:00Z` : null;
      map.set(`${home}|${away}`, {
        homeGoals,
        awayGoals,
        isoDate,
        homeXg: readXg(hxgIdx, row),
        awayXg: readXg(axgIdx, row),
      });
    }
    cachedResults = { at: Date.now(), map };
    return map;
  } catch {
    return null;
  }
}

async function backfillOpenfootballResults(
  fixtures: espn.FixtureLite[],
): Promise<espn.FixtureLite[]> {
  const now = Date.now();
  const needsBackfill = (fx: espn.FixtureLite) =>
    fx.id.startsWith("openfootball:") &&
    fx.state !== "post" &&
    Date.parse(fx.date) < now &&
    seasonOf(fx.date) === RESULTS_CSV_SEASON;
  if (!fixtures.some(needsBackfill)) return fixtures;

  const results = await loadCompletedEplResults();
  if (!results) return fixtures;

  return fixtures.map((fx) => {
    if (!needsBackfill(fx)) return fx;
    const key = `${translateTeamName(fx.home.name)}|${translateTeamName(fx.away.name)}`;
    const settled = results.get(key);
    if (!settled) return fx;
    return {
      ...fx,
      date: settled.isoDate ?? fx.date,
      state: "post",
      statusDetail: "FT",
      home: { ...fx.home, score: String(settled.homeGoals) },
      away: { ...fx.away, score: String(settled.awayGoals) },
    };
  });
}

const SEASONS_BACK = 4;
/** Rolling-form window: the last 5 matches, matching the "last 5 matchweeks". */
const FORM_WINDOW_MATCHES = 5;
const EPL_SEASON_FIXTURES = 20 * 19; // Each club hosts the other 19 once.
const XG_HISTORY_TTL_MS = 60 * 60_000;
const priorSeasonCache = new Map<string, { at: number; matches: HistoricalMatch[] }>();

async function loadPriorSeason(season: string): Promise<HistoricalMatch[]> {
  const cached = priorSeasonCache.get(season);
  if (cached && Date.now() - cached.at < XG_HISTORY_TTL_MS) return cached.matches;

  try {
    const { matches, notes } = await loadMatchesFromOpenfootball("eng.1", [season]);
    if (!notes.length && matches.length === EPL_SEASON_FIXTURES) {
      priorSeasonCache.set(season, { at: Date.now(), matches });
      return matches;
    }
    // A readable season file may still be incomplete. Prefer the last full
    // season; otherwise use the available rows once, without caching them.
    return cached?.matches ?? matches;
  } catch {
    return cached?.matches ?? [];
  }
}

/** Completed matches strictly before `cutoffIso`, from the CSV results map. */
function csvHistoryBefore(
  results: Map<string, CompletedMatchResult> | null,
  cutoffIso: string,
) {
  if (!results) return [];
  const cutoff = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoff)) return [];
  const history: Array<{
    homeTeam: string;
    awayTeam: string;
    matchDate: string;
    homeGoals: number;
    awayGoals: number;
    leagueSlug: string;
    homeXg: number | null;
    awayXg: number | null;
  }> = [];
  for (const [key, result] of results) {
    if (!result.isoDate) continue;
    if (Date.parse(result.isoDate) >= cutoff) continue;
    const [home, away] = key.split("|");
    if (!home || !away) continue;
    history.push({
      homeTeam: home,
      awayTeam: away,
      matchDate: result.isoDate,
      homeGoals: result.homeGoals,
      awayGoals: result.awayGoals,
      leagueSlug: "eng.1",
      homeXg: result.homeXg,
      awayXg: result.awayXg,
    });
  }
  return history;
}

/**
 * Engine xG for the slate: the Maher-style attack/defence model rebuilt from
 * completed matches before the first kickoff. Missing history degrades the
 * xG-aware Locks back to their flat V2 lines — never to fabricated odds.
 */
async function buildMatchXgResolver(cutoffIso: string): Promise<MatchXgResolver | null> {
  const built = await buildSlateContext(cutoffIso);
  return built?.xg ?? null;
}

interface SlateContext {
  xg: MatchXgResolver | null;
  form: FormResolver;
}

/**
 * Everything the refactor needs from history, built once per request from the
 * same strictly pre-kickoff slice:
 *
 *  · the xG resolver (goals-based attack/defence λ, optional decay)
 *  · the rolling form table (points, winless streak, and **real** HxG/AxG)
 *
 * The form table is what Slump Detection and the Snipe xG override read, so the
 * real xG columns now reach the prediction path for the first time.
 */
async function buildSlateContext(cutoffIso: string): Promise<SlateContext | null> {
  const kickoff = new Date(cutoffIso);
  if (!Number.isFinite(kickoff.getTime())) return null;

  // seasonCodes ends with the slate's season. Skip it and replay the four
  // previous seasons newest first, in the same order as backtest-local.ts.
  const [season, ...priorSeasons] = seasonCodes(kickoff, SEASONS_BACK + 1).reverse();
  const priorHistory = await Promise.all(priorSeasons.map(loadPriorSeason));
  const results = season === RESULTS_CSV_SEASON ? await loadCompletedEplResults() : null;

  const history = [
    ...matchesBefore(priorHistory.flat(), cutoffIso),
    ...csvHistoryBefore(results, cutoffIso),
  ];

  // Rolling form is built from whatever history exists — it degrades to an empty
  // table rather than disabling the whole refactor when a prior season is thin,
  // because form is per-side and needs far less data than the λ model.
  const form = formResolverFrom(buildFormTable({ history, window: FORM_WINDOW_MATCHES }));

  // If a prior season is missing, fall back to the flat V2 xG path (as before)
  // rather than fitting λ to an incomplete window.
  if (priorHistory.some((matches) => matches.length === 0)) return { xg: null, form };

  const xg = createMatchXgResolver({
    history,
    leagueSlug: "eng.1",
    onlyRelevant: false,
    now: cutoffIso,
  });
  return { xg, form };
}

export async function GET(request: Request) {
  const rawWeek = new URL(request.url).searchParams.get("week");
  const requestedWeek = parseWeekParam(rawWeek);
  if (Number.isNaN(requestedWeek)) {
    return NextResponse.json(
      { error: "Invalid week parameter. Expected an integer between 1 and 38." },
      { status: 400 },
    );
  }

  try {
    let week = requestedWeek;
    if (week === null) {
      try {
        week =
          typeof espn.getCurrentMatchweek === "function"
            ? await espn.getCurrentMatchweek("eng.1")
            : DEFAULT_WEEK;
      } catch {
        week = DEFAULT_WEEK;
      }
    }

    const rawFixtures = await espn.fetchScoreboard("eng.1", undefined, week);
    const hasMatchweeks = rawFixtures.some((f) => typeof f.matchweek === "number");
    const forWeek = hasMatchweeks
      ? rawFixtures.filter((f) => f.matchweek === week)
      : rawFixtures;

    const enriched = await backfillOpenfootballResults(forWeek);
    const sorted = [...enriched].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    const v2Fixtures = sorted.map((fx) => ({
      home: translateTeamName(fx.home.name),
      away: translateTeamName(fx.away.name),
    }));
    const context = sorted.length ? await buildSlateContext(sorted[0].date) : null;
    const v2Predictions = generateV2Predictions(
      v2Fixtures,
      context?.xg ?? null,
      V4_LIVE_CONFIG,
      context?.form ?? null,
    );

    const result = sorted.map((fx, index) => {
      const { home: homeName, away: awayName } = v2Fixtures[index];
      const pick = v2Predictions[index];

      const homeScore = fx.home.score;
      const awayScore = fx.away.score;
      const hasScore =
        homeScore !== null &&
        homeScore !== "" &&
        awayScore !== null &&
        awayScore !== "";
      const actual =
        fx.state === "post" &&
        hasScore &&
        Number.isFinite(Number(homeScore)) &&
        Number.isFinite(Number(awayScore))
          ? [Number(homeScore), Number(awayScore)]
          : null;

      return {
        home: { name: homeName, logo: fx.home.logo ?? null },
        away: { name: awayName, logo: fx.away.logo ?? null },
        state: fx.state,
        actual,
        prediction: pick.Prediction,
        category: pick.Category,
        targetPts: pick.Target_Pts,
      };
    });

    return NextResponse.json({ week, fixtures: result });
  } catch (error) {
    console.error("V4 auto predictor failed", error);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}
