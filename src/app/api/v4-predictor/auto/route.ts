import * as espn from "@/lib/espn";
import { runEngineFromRealWithProfiles } from "@/lib/engine";
import type { Market } from "@/lib/engine/types";
import { translateTeamName } from "@/lib/v4-predictor";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// The engine runs once per fixture, so allow the same budget as daily-picks.
export const maxDuration = 60;

const DEFAULT_WEEK = 11;

const EXTRA_TEAM_MAP: Record<string, string> = {
  "AFC Bournemouth": "Bournemouth",
  "Wolverhampton Wanderers": "Wolves",
  "West Ham United": "West Ham",
  "Leicester City": "Leicester",
};

function toV4TeamName(name: string): string {
  const trimmed = name.trim();
  const stripped = trimmed.replace(/\s+(?:AFC|FC)$/i, "").trim();
  const mapped = EXTRA_TEAM_MAP[trimmed] ?? EXTRA_TEAM_MAP[stripped] ?? stripped;
  return translateTeamName(mapped);
}

function parseWeekParam(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 38) return NaN;
  return parsed;
}

/**
 * The engine's top predicted scoreline: the Correct Score market with the
 * highest probability (e.g. "2-1"). Returns null if none is present.
 */
function topCorrectScore(markets: Market[]): string | null {
  let best: { score: string; prob: number } | null = null;
  for (const m of markets) {
    const match = /^Correct Score (\d{1,2})-(\d{1,2})$/.exec(m.name);
    if (!match) continue;
    if (!best || m.hitRate > best.prob) {
      best = { score: `${match[1]}-${match[2]}`, prob: m.hitRate };
    }
  }
  return best ? best.score : null;
}

/** Runs the Prediction Engine for one fixture. Any failure yields null. */
async function fetchEnginePrediction(
  fixture: espn.FixtureLite,
): Promise<string | null> {
  try {
    const summary = await espn.fetchSummary(fixture.leagueSlug, fixture.id).catch(() => null);
    const result = await runEngineFromRealWithProfiles(fixture, summary);
    return topCorrectScore(result.markets);
  } catch (error) {
    console.error("V4 engine prediction failed", fixture.id, error);
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const rawWeek = new URL(request.url).searchParams.get("week");
    const requestedWeek = parseWeekParam(rawWeek);
    if (Number.isNaN(requestedWeek)) {
      return NextResponse.json(
        { error: "Invalid week parameter. Expected an integer between 1 and 38." },
        { status: 400 },
      );
    }

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

    const fixtures = await espn.fetchScoreboard("eng.1", undefined, week);

    const hasMatchweeks = fixtures.some((f) => typeof f.matchweek === "number");
    const forWeek = hasMatchweeks
      ? fixtures.filter((f) => f.matchweek === week)
      : fixtures;

    const sorted = [...forWeek].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    const result = await Promise.all(sorted.map(async (f) => {
      const enginePrediction = await fetchEnginePrediction(f);
      const homeScore = f.home.score;
      const awayScore = f.away.score;
      const hasScore =
        homeScore !== null && homeScore !== "" && awayScore !== null && awayScore !== "";
      const actual =
        f.state === "post" &&
        hasScore &&
        Number.isFinite(Number(homeScore)) &&
        Number.isFinite(Number(awayScore))
          ? [Number(homeScore), Number(awayScore)]
          : null;
      return {
        home: { name: toV4TeamName(f.home.name), logo: f.home.logo ?? null },
        away: { name: toV4TeamName(f.away.name), logo: f.away.logo ?? null },
        state: f.state,
        actual,
        enginePrediction,
      };
    }));

    return NextResponse.json({ week, fixtures: result });
  } catch (error) {
    console.error("V4 auto-fetch error", error);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}
