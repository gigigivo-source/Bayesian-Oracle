import { describe, expect, it } from "vitest";
import type { FixtureLite } from "./espn";
import { liveScoreboardDates, selectLiveFixtures } from "./liveFixtures";

function fixture(
  id: string,
  leagueSlug: string,
  state: FixtureLite["state"],
  date: string,
  leagueName = leagueSlug,
): FixtureLite {
  const team = (side: "home" | "away") => ({
    id: `${id}-${side}`,
    name: side,
    shortName: side,
    abbrev: side.toUpperCase(),
    logo: null,
    color: null,
    score: state === "pre" ? null : "0",
    homeAway: side,
  });

  return {
    id,
    leagueSlug,
    leagueName,
    date,
    state,
    statusDetail: "",
    venue: null,
    neutralSite: false,
    home: team("home"),
    away: team("away"),
  };
}

describe("liveScoreboardDates", () => {
  it("uses only the current UTC day after the overnight crossover window", () => {
    expect(liveScoreboardDates(new Date("2026-08-23T12:00:00Z"))).toBe("20260823");
  });

  it("also requests yesterday shortly after UTC midnight", () => {
    expect(liveScoreboardDates(new Date("2026-08-23T02:00:00Z"))).toBe("20260822-20260823");
  });
});

describe("selectLiveFixtures", () => {
  it("keeps all unique live matches and sorts them T1 through T6", () => {
    const selected = selectLiveFixtures([
      fixture("regional", "unknown.1", "in", "2026-08-23T10:00:00Z"),
      fixture("premier-late", "eng.1", "in", "2026-08-23T18:00:00Z"),
      fixture("finished", "uefa.champions", "post", "2026-08-23T09:00:00Z"),
      fixture("ucl", "uefa.champions", "in", "2026-08-23T20:00:00Z"),
      fixture("premier-early", "eng.1", "in", "2026-08-23T12:00:00Z"),
      fixture("premier-early", "eng.1", "in", "2026-08-23T12:00:00Z"),
    ]);

    expect(selected.map((match) => match.id)).toEqual([
      "ucl",
      "premier-early",
      "premier-late",
      "regional",
    ]);
  });

  it("uses global-scoreboard competition names for priority fallback", () => {
    const selected = selectLiveFixtures([
      fixture("other", "all", "in", "2026-08-23T10:00:00Z", "Regional Cup"),
      fixture("europa", "all", "in", "2026-08-23T11:00:00Z", "UEFA Europa League"),
    ]);

    expect(selected.map((match) => match.id)).toEqual(["europa", "other"]);
  });
});
