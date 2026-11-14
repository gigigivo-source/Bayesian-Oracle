import dns from "node:dns";
import tls from "node:tls";
import * as espn from "@/lib/espn";
import { parseHistoricalDate } from "@/lib/data/historical";
import { parseCsv } from "@/lib/data/sources/githubDatasets";
import { generateV2Predictions, translateTeamName } from "@/lib/v4-predictor";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DEFAULT_WEEK = 11;
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
    if (homeIdx < 0 || awayIdx < 0 || fthgIdx < 0 || ftagIdx < 0) return null;

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
      map.set(`${home}|${away}`, { homeGoals, awayGoals, isoDate });
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
  const needsBackfill = fixtures.some(
    (fx) =>
      fx.id.startsWith("openfootball:") &&
      fx.state !== "post" &&
      Date.parse(fx.date) < now,
  );
  if (!needsBackfill) return fixtures;

  const results = await loadCompletedEplResults();
  if (!results) return fixtures;

  return fixtures.map((fx) => {
    if (!fx.id.startsWith("openfootball:") || fx.state === "post") return fx;
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
    const v2Predictions = generateV2Predictions(v2Fixtures);

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
