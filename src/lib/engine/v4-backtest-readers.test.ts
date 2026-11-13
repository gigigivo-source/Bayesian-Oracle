import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchScoreboard } from "@/lib/espn";
import { buildHistoricalTeamForm, type HistoricalScheduleEvent } from "./sofascore";

afterEach(() => vi.unstubAllGlobals());

describe("V4 archived reader inputs", () => {
  it("fetchScoreboard normalises a supplied matchweek without touching ESPN", async () => {
    const network = vi.fn(() => { throw new Error("offline snapshot must not fetch"); });
    vi.stubGlobal("fetch", network);
    const fixtures = await fetchScoreboard("eng.1", undefined, 3, {
      mergeEspn: false,
      rows: [
        { round: "Matchday 3", date: "2026-09-05", time: "15:00", team1: "Arsenal FC", team2: "Hull City AFC", score: { ft: [2, 0] } },
        { round: "Matchday 4", date: "2026-09-12", time: "15:00", team1: "Chelsea FC", team2: "Leeds United FC" },
      ],
    });
    expect(network).not.toHaveBeenCalled();
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatchObject({ matchweek: 3, state: "post", home: { name: "Arsenal FC", score: "2" }, away: { name: "Hull City AFC", score: "0" } });
  });

  it("buildHistoricalTeamForm applies strict cutoff, dedup and last-five selection to snapshot events", async () => {
    const network = vi.fn(() => { throw new Error("offline snapshot must not fetch"); });
    vi.stubGlobal("fetch", network);
    const event = (id: string, date: string, goals: number): HistoricalScheduleEvent => ({
      id, date, league: { name: "Premier League" },
      competitions: [{
        status: { type: { state: "post" } },
        competitors: [
          { id: "arsenal", homeAway: "home", score: goals, team: { id: "arsenal", displayName: "Arsenal FC" } },
          { id: "opponent", homeAway: "away", score: 0, team: { id: "opponent", displayName: "Opponent FC" } },
        ],
      }],
    });
    const events = [
      event("old", "2026-07-01T15:00:00Z", 1),
      ...Array.from({ length: 5 }, (_, i) => event(`g${i}`, `2026-08-0${i + 1}T15:00:00Z`, i + 1)),
      event("g4", "2026-08-05T15:00:00Z", 5), // duplicate season overlap
      event("future", "2026-09-01T15:00:00Z", 9),
      event("kickoff", "2026-08-10T15:00:00Z", 9),
    ];
    const form = await buildHistoricalTeamForm("Arsenal FC", "eng.1", "2026-08-10T15:00:00Z", 5, {
      team: { id: "arsenal", slug: "eng.1" }, events,
    });
    expect(network).not.toHaveBeenCalled();
    expect(form?.games.map((g) => g.date)).toEqual(Array.from({ length: 5 }, (_, i) => `2026-08-0${i + 1}T15:00:00Z`));
    expect(form).toMatchObject({ gfAvg: 3, gaAvg: 0, points: 15 });
  });
});
