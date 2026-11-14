import dns from "node:dns";
import tls from "node:tls";
import * as espn from "@/lib/espn";
import { buildV2EngineContext, completedEplResultsByKey, fetchCompletedEplResults, type CompletedEplResult } from "@/lib/v4-history";
import { generateV2PredictionsWithEngine, translateTeamName } from "@/lib/v4-predictor";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DEFAULT_WEEK = 11;
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

let cachedResults: { at: number; rows: CompletedEplResult[] } | null = null;

function parseWeekParam(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 38) return NaN;
  return parsed;
}

async function loadCompletedEplResults(): Promise<CompletedEplResult[] | null> {
  if (cachedResults && Date.now() - cachedResults.at < RESULTS_TTL_MS) return cachedResults.rows;
  const rows = await fetchCompletedEplResults(8_000);
  if (rows) cachedResults = { at: Date.now(), rows };
  return rows;
}

async function backfillOpenfootballResults(
  fixtures: espn.FixtureLite[],
  history: readonly CompletedEplResult[],
): Promise<espn.FixtureLite[]> {
  const now = Date.now();
  const needsBackfill = fixtures.some(
    (fx) =>
      fx.id.startsWith("openfootball:") &&
      fx.state !== "post" &&
      Date.parse(fx.date) < now,
  );
  if (!needsBackfill) return fixtures;

  const results = completedEplResultsByKey(history);

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

    const history = await loadCompletedEplResults();
    const enriched = history ? await backfillOpenfootballResults(forWeek, history) : forWeek;
    const sorted = [...enriched].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    const v2Fixtures = sorted.map((fx) => ({
      home: translateTeamName(fx.home.name),
      away: translateTeamName(fx.away.name),
    }));
    const contexts = sorted.map((fx) => history ? buildV2EngineContext(fx, history) : undefined);
    const v2Predictions = await generateV2PredictionsWithEngine(v2Fixtures, contexts);

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
