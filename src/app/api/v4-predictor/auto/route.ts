import { fetchScoreboard } from "@/lib/espn";
import { translateTeamName } from "@/lib/v4-predictor";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function startOfDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export async function GET() {
  try {
    const now = new Date();
    const from = new Date(now);
    from.setUTCDate(now.getUTCDate() - 4);
    const to = new Date(now);
    to.setUTCDate(now.getUTCDate() + 4);
    const dateRange = `${fmt(from)}-${fmt(to)}`;

    const fixtures = await fetchScoreboard("eng.1", dateRange);

    const todayStart = startOfDay(now);
    const inCurrentGameweek = fixtures.filter((f) => {
      const fixtureDay = startOfDay(new Date(f.date));
      const diffDays = Math.round((fixtureDay - todayStart) / 86_400_000);
      return diffDays >= -4 && diffDays <= 4;
    });

    const sorted = [...inCurrentGameweek].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    const result = sorted.map((f) => {
      const homeScore = f.home.score;
      const awayScore = f.away.score;
      const hasScore =
        homeScore !== null && homeScore !== "" && awayScore !== null && awayScore !== "";
      const actual =
        f.state === "post" && hasScore && Number.isFinite(Number(homeScore)) && Number.isFinite(Number(awayScore))
          ? [Number(homeScore), Number(awayScore)]
          : null;
      return {
        home: translateTeamName(f.home.name),
        away: translateTeamName(f.away.name),
        state: f.state,
        actual,
      };
    });

    return NextResponse.json({ fixtures: result });
  } catch (error) {
    console.error("V4 auto-fetch error", error);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}
