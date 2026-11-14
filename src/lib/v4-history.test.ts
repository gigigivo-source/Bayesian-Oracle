import { describe, expect, it } from "vitest";
import type { FixtureLite } from "./espn";
import { buildV2EngineContext, type CompletedEplResult } from "./v4-history";

describe("V2 Engine context point-in-time guard", () => {
  it("uses only strictly prior form and strips target/post-match fields", () => {
    const history: CompletedEplResult[] = [
      { home: "Chelsea", away: "Leeds", homeGoals: 1, awayGoals: 0, isoDate: "2026-10-01T15:00:00Z" },
      { home: "Fulham", away: "Chelsea", homeGoals: 0, awayGoals: 2, isoDate: "2026-10-03T15:00:00Z" },
      { home: "Chelsea", away: "Everton", homeGoals: 3, awayGoals: 1, isoDate: "2026-10-05T15:00:00Z" },
      { home: "Leeds", away: "Fulham", homeGoals: 0, awayGoals: 1, isoDate: "2026-10-02T15:00:00Z" },
      { home: "Everton", away: "Fulham", homeGoals: 1, awayGoals: 1, isoDate: "2026-10-06T15:00:00Z" },
      { home: "Arsenal", away: "Fulham", homeGoals: 2, awayGoals: 1, isoDate: "2026-10-07T15:00:00Z" },
      // Same-day target record and later results must not leak into its context.
      { home: "Chelsea", away: "Fulham", homeGoals: 5, awayGoals: 4, isoDate: "2026-10-10T15:00:00Z" },
      { home: "Chelsea", away: "Arsenal", homeGoals: 6, awayGoals: 0, isoDate: "2026-10-12T15:00:00Z" },
    ];
    const fixture = {
      id: "target", leagueSlug: "eng.1", leagueName: "Premier League", date: "2026-10-10T15:00:00Z",
      state: "post", statusDetail: "FT", venue: null, neutralSite: false,
      home: { id: "c", name: "Chelsea", shortName: "Chelsea", abbrev: "CHE", logo: null, color: null, score: "5", homeAway: "home" },
      away: { id: "f", name: "Fulham", shortName: "Fulham", abbrev: "FUL", logo: null, color: null, score: "4", homeAway: "away" },
    } as FixtureLite;

    const context = buildV2EngineContext(fixture, history);
    expect(context.stats).toBeNull(); // observed HxG/AxG columns are never consumed
    expect(context.summary?.homeForm?.games).toHaveLength(3);
    expect(context.summary?.homeForm?.gfAvg).toBe(2);
    expect(context.summary?.awayForm?.gfAvg).toBe(0.75);
    expect(context.fixture.state).toBe("pre");
    expect(context.fixture.home.score).toBeNull();
    expect(context.fixture.away.score).toBeNull();
    expect(context.summary?.odds).toBeNull();
  });
});
