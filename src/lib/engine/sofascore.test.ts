// Tests for the ESPN-backed per-team stat profile (mesh Provider 1).
//
// buildTeamStatProfile aggregates a team's recent finished matches into
// mean±std distributions (corners, cards, …). ESPN is stubbed at the
// httpClient boundary (resilientJson) so these exercise the real aggregation
// pipeline: team-ID resolution → season schedule scan → per-match boxscore.
//
// Coverage (First 5 Minutes corner/card omission fix):
//   1. a single usable match still yields a profile (samples = 1) — a weak
//      signal beats no signal; callers see the count via `samples`;
//   2. zero matches with any usable stat still returns null;
//   3. the default look-back window now spans up to 20 recent finished
//      matches (was 10), keeping the most recent ones;
//   4. the bounded-parallel (8-wide) boxscore walk still visits all 20
//      finished matches and yields samples = 20;
//   5. rejected boxscore calls degrade to skipped rows instead of failing
//      the build (3 of 20 wiped out → samples = 17).

import { beforeEach, describe, expect, it, vi } from "vitest";

const espnJson = vi.hoisted(() =>
  vi.fn(async (_url?: string): Promise<unknown> => null),
);
vi.mock("@/lib/httpClient", () => ({ resilientJson: espnJson }));

const { buildTeamStatProfile, buildHistoricalTeamForm, findTeamId } = await import("./sofascore");

// ─── ESPN response builders ──────────────────────────────────────────────────

const TEAM_ID  = "359";
const RIVAL_ID = "432";

function teamsResponse(): unknown {
  return {
    sports: [{
      leagues: [{
        teams: [{ team: { id: TEAM_ID, displayName: "Arsenal", abbreviation: "ARS" } }],
      }],
    }],
  };
}

function scheduleResponse(eventIds: string[]): unknown {
  return {
    events: eventIds.map((id) => ({
      id,
      competitions: [{
        status: { type: { state: "post" } },
        competitors: [
          { id: TEAM_ID,  homeAway: "home" },
          { id: RIVAL_ID, homeAway: "away" },
        ],
      }],
    })),
  };
}

function boxscoreResponse(
  stats: Array<{ name: string; displayValue: string }>,
): unknown {
  return {
    boxscore: {
      teams: [
        { team: { id: TEAM_ID },  statistics: stats },
        { team: { id: RIVAL_ID }, statistics: [] },
      ],
    },
  };
}

/**
 * Wire the resilientJson stub: team list + season schedule + one summary
 * boxscore per event id (a null entry = no boxscore for that match, and the
 * REJECT sentinel = the summary call itself rejects, e.g. an ESPN timeout).
 */
const REJECT = { reject: true } as const;

function stubEspn(boxscores: Record<string, unknown>): void {
  espnJson.mockImplementation(async (url?: string) => {
    const u = url ?? "";
    if (u.includes("/schedule")) return scheduleResponse(Object.keys(boxscores));
    if (u.includes("/summary")) {
      const id = new URL(u).searchParams.get("event");
      const res = boxscores[id ?? ""] ?? null;
      if (res === REJECT) throw new Error("ESPN boxscore timeout");
      return res;
    }
    if (u.endsWith("/teams")) return teamsResponse();
    return null;
  });
}

/** Event ids (in call order) of every summary/boxscore call the stub saw. */
function summaryCalls(): string[] {
  return espnJson.mock.calls
    .map((call) => String(call[0]))
    .filter((u) => u.includes("/summary"))
    .map((u) => new URL(u).searchParams.get("event") ?? "");
}

beforeEach(() => {
  espnJson.mockReset();
  espnJson.mockResolvedValue(null);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("buildTeamStatProfile — minimum-sample & look-back policy", () => {
  it("returns a profile from a single usable match (samples = 1), not null", async () => {
    stubEspn({
      "ev-1": boxscoreResponse([
        { name: "wonCorners",  displayValue: "6" },
        { name: "yellowCards", displayValue: "2" },
        { name: "redCards",    displayValue: "1" },
      ]),
    });

    const profile = await buildTeamStatProfile("Arsenal", "eng.1");

    // Before the fix, one sample fell below the < 2 guard and the profile was
    // dropped — which is exactly why corner/card markets went missing.
    expect(profile).not.toBeNull();
    expect(profile!.teamId).toBe(TEAM_ID);
    expect(profile!.samples).toBe(1);
    expect(profile!.corners).toEqual({ mean: 6, std: 0, n: 1 });
    expect(profile!.cards).toEqual({ mean: 3, std: 0, n: 1 }); // 2 yellow + 1 red
  });

  it("still returns null when no match has any usable stat", async () => {
    stubEspn({
      // Boxscore present but zero usable fields → row filtered out…
      "ev-1": boxscoreResponse([]),
      // …and a match with no boxscore at all → matchStatsForTeam null.
      "ev-2": null,
    });

    const profile = await buildTeamStatProfile("Arsenal", "eng.1");

    expect(profile).toBeNull();
  });

  it("uses up to 20 recent finished matches (default lastN), keeping the most recent", async () => {
    // 25 finished matches with corner counts 1..25 — the window must cap at 20
    // and keep the LAST 20 (6..25), not the first 20 (1..20).
    const twentyFive: Record<string, unknown> = {};
    for (let i = 1; i <= 25; i++) {
      twentyFive[`ev-${i}`] = boxscoreResponse([
        { name: "wonCorners", displayValue: String(i) },
      ]);
    }
    stubEspn(twentyFive);

    const capped = await buildTeamStatProfile("Arsenal", "eng.1");

    expect(capped).not.toBeNull();
    expect(capped!.samples).toBe(20);
    expect(capped!.corners.n).toBe(20);
    expect(capped!.corners.mean).toBeCloseTo(15.5, 10); // mean of 6..25

    // Fewer than 20 available → all of them are used.
    const twelve: Record<string, unknown> = {};
    for (let i = 1; i <= 12; i++) {
      twelve[`ev-${i}`] = boxscoreResponse([
        { name: "wonCorners", displayValue: String(i) },
      ]);
    }
    stubEspn(twelve);

    const all = await buildTeamStatProfile("Arsenal", "eng.1");

    expect(all).not.toBeNull();
    expect(all!.samples).toBe(12);
    expect(all!.corners.n).toBe(12);
    expect(all!.corners.mean).toBeCloseTo(6.5, 10); // mean of 1..12
  });
});

describe("buildTeamStatProfile — bounded-parallel boxscore walk", () => {
  it("fetches all 20 finished boxscores and builds a profile with samples = 20", async () => {
    const twenty: Record<string, unknown> = {};
    for (let i = 1; i <= 20; i++) {
      twenty[`ev-${i}`] = boxscoreResponse([
        { name: "totalShots", displayValue: String(i) },
        { name: "wonCorners", displayValue: String(i) },
      ]);
    }
    stubEspn(twenty);

    const profile = await buildTeamStatProfile("Arsenal", "eng.1");

    // Every one of the 20 finished events got its own summary call — the
    // bounded-parallel walk visits the full window, not just the first batch.
    const calls = summaryCalls();
    expect(calls).toHaveLength(20);
    expect(new Set(calls).size).toBe(20);
    for (let i = 1; i <= 20; i++) expect(calls).toContain(`ev-${i}`);

    expect(profile).not.toBeNull();
    expect(profile!.samples).toBe(20);
    expect(profile!.corners.n).toBe(20);
    expect(profile!.corners.mean).toBeCloseTo(10.5, 10); // mean of 1..20
  });

  it("swallows 3 rejected boxscore calls and still returns samples = 17", async () => {
    const twenty: Record<string, unknown> = {};
    for (let i = 1; i <= 20; i++) {
      twenty[`ev-${i}`] =
        i <= 3
          ? REJECT // three ESPN calls blow up entirely (e.g. timeout/reject)
          : boxscoreResponse([{ name: "wonCorners", displayValue: String(i) }]);
    }
    stubEspn(twenty);

    const profile = await buildTeamStatProfile("Arsenal", "eng.1");

    // All 20 were attempted, but the 3 failures degrade to skipped rows
    // instead of failing the whole profile build.
    expect(summaryCalls()).toHaveLength(20);
    expect(profile).not.toBeNull();
    expect(profile!.samples).toBe(17);
    expect(profile!.corners.n).toBe(17);
    expect(profile!.corners.mean).toBeCloseTo(12, 10); // mean of 4..20
  });
});


describe("point-in-time profile", () => {
  it("uses only dated completed events before the cutoff and selects seasons relative to it", async () => {
    const events = [
      { id: "future", date: "2020-10-01T15:00:00Z" },
      { id: "target", date: "2020-08-15T15:00:00Z" },
      { id: "prior", date: "2020-08-01T15:00:00Z" },
      { id: "undated" },
      { id: "same-day-unknown", date: "2020-08-15" },
    ].map((e) => ({ ...e, competitions: [{ status: { type: { state: "post" } } }] }));
    espnJson.mockImplementation(async (url?: string) => {
      const u = url ?? "";
      if (u.endsWith("/teams")) return teamsResponse();
      if (u.includes("/schedule")) return { events };
      if (u.includes("/summary")) return boxscoreResponse([{ name: "totalShots", displayValue: "12" }]);
      return null;
    });
    const result = await buildTeamStatProfile("Arsenal", "eng.1", "2020-08-15T15:00:00Z");
    expect(result?.samples).toBe(1);
    expect(summaryCalls()).toEqual(["prior"]);
    const schedules = espnJson.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/schedule"));
    expect(schedules).toHaveLength(2);
    expect(schedules[0]).toContain("season=2020");
    expect(schedules[1]).toContain("season=2019");
  });

  it("fails closed on an invalid cutoff", async () => {
    expect(await buildTeamStatProfile("Arsenal", "eng.1", "not-a-date")).toBeNull();
    expect(espnJson).not.toHaveBeenCalled();
  });
});

describe("buildHistoricalTeamForm — point-in-time schedule form", () => {
  it("constructs last-5 form strictly before beforeDate across [yr, yr-1] schedules", async () => {
    const mkEvent = (
      id: string,
      date: string,
      usHome: boolean,
      usScore: unknown,
      oppScore: unknown,
      oppName: string,
      state = "post",
    ) => ({
      id,
      date,
      league: { name: "Premier League" },
      competitions: [{
        status: { type: { state } },
        competitors: [
          {
            id: usHome ? TEAM_ID : RIVAL_ID,
            homeAway: "home",
            score: usHome ? usScore : oppScore,
            team: { id: usHome ? TEAM_ID : RIVAL_ID, displayName: usHome ? "Arsenal" : oppName },
          },
          {
            id: usHome ? RIVAL_ID : TEAM_ID,
            homeAway: "away",
            score: usHome ? oppScore : usScore,
            team: { id: usHome ? RIVAL_ID : TEAM_ID, displayName: usHome ? oppName : "Arsenal" },
          },
        ],
      }],
    });

    const events2026 = [
      mkEvent("old-1", "2026-08-01T15:00:00Z", true, { value: 5, displayValue: "5" }, { value: 0, displayValue: "0" }, "Old Rival"),
      mkEvent("g-1", "2026-08-08T15:00:00Z", true, { value: 2, displayValue: "2" }, { value: 1, displayValue: "1" }, "Fulham"),
      mkEvent("g-2", "2026-08-15T15:00:00Z", false, { value: 1, displayValue: "1" }, { value: 1, displayValue: "1" }, "Everton"),
      mkEvent("g-3", "2026-08-22T15:00:00Z", true, "3", "0", "Leeds"),
      mkEvent("g-4", "2026-08-29T15:00:00Z", false, 0, 2, "Liverpool"),
      mkEvent("g-5", "2026-09-12T15:00:00Z", true, { displayValue: "2" }, { displayValue: "0" }, "Wolves"),
      mkEvent("same-time", "2026-09-19T15:00:00Z", true, { value: 4 }, { value: 0 }, "Target Match"),
      mkEvent("same-day-date-only", "2026-09-19", true, { value: 4 }, { value: 0 }, "Same Day Unknown"),
      mkEvent("future", "2026-09-26T15:00:00Z", true, { value: 6 }, { value: 0 }, "Future Match"),
      mkEvent("pre-before", "2026-09-05T15:00:00Z", true, { value: 0 }, { value: 0 }, "Postponed", "pre"),
    ];

    espnJson.mockImplementation(async (url?: string) => {
      const u = url ?? "";
      if (u.endsWith("/teams")) return teamsResponse();
      if (u.includes("schedule?season=2026")) return { events: events2026 };
      if (u.includes("schedule?season=2025")) return { events: [events2026[0]] }; // duplicate old-1
      return null;
    });

    const form = await buildHistoricalTeamForm("Arsenal FC", "eng.1", "2026-09-19T15:00:00Z");
    expect(form).not.toBeNull();
    expect(form!.teamId).toBe(TEAM_ID);
    expect(form!.teamName).toBe("Arsenal");
    expect(form!.games).toHaveLength(5);
    expect(form!.games.map((g) => [g.opponent, g.result, g.scoreFor, g.scoreAgainst, g.atVs])).toEqual([
      ["Fulham", "W", 2, 1, "vs"],
      ["Everton", "D", 1, 1, "@"],
      ["Leeds", "W", 3, 0, "vs"],
      ["Liverpool", "L", 0, 2, "@"],
      ["Wolves", "W", 2, 0, "vs"],
    ]);
    // GF = 2+1+3+0+2 = 8 (/5 = 1.6), GA = 1+1+0+2+0 = 4 (/5 = 0.8), Pts = 3+1+3+0+3 = 10
    expect(form!.gfAvg).toBeCloseTo(1.6, 5);
    expect(form!.gaAvg).toBeCloseTo(0.8, 5);
    expect(form!.points).toBe(10);
  });

  it("does not let 3-letter abbreviations like CHE hijack Manchester City in findTeamId", async () => {
    espnJson.mockImplementation(async (url?: string) => {
      if ((url ?? "").endsWith("/teams")) {
        return {
          sports: [{
            leagues: [{
              teams: [
                { team: { id: "363", displayName: "Chelsea", shortDisplayName: "Chelsea", abbreviation: "CHE" } },
                { team: { id: "382", displayName: "Manchester City", shortDisplayName: "Man City", abbreviation: "MCI" } },
              ],
            }],
          }],
        };
      }
      return null;
    });

    const resolved = await findTeamId("Manchester City", "eng.1");
    expect(resolved).toEqual({ id: "382", slug: "eng.1" });
  });

  it("returns null on invalid cutoff or when no completed matches precede cutoff", async () => {
    expect(await buildHistoricalTeamForm("Arsenal", "eng.1", "invalid")).toBeNull();
    expect(espnJson).not.toHaveBeenCalled();

    espnJson.mockImplementation(async (url?: string) => {
      if ((url ?? "").endsWith("/teams")) return teamsResponse();
      if ((url ?? "").includes("/schedule")) return { events: [] };
      return null;
    });
    expect(await buildHistoricalTeamForm("Arsenal", "eng.1", "2026-08-10T15:00:00Z")).toBeNull();
  });
});
