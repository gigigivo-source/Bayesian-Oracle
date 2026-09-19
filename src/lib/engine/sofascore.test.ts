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
//      matches (was 10), keeping the most recent ones.

import { beforeEach, describe, expect, it, vi } from "vitest";

const espnJson = vi.hoisted(() =>
  vi.fn(async (_url?: string): Promise<unknown> => null),
);
vi.mock("@/lib/httpClient", () => ({ resilientJson: espnJson }));

const { buildTeamStatProfile } = await import("./sofascore");

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
 * boxscore per event id (a null entry = no boxscore for that match).
 */
function stubEspn(boxscores: Record<string, unknown>): void {
  espnJson.mockImplementation(async (url?: string) => {
    const u = url ?? "";
    if (u.includes("/schedule")) return scheduleResponse(Object.keys(boxscores));
    if (u.includes("/summary")) {
      const id = new URL(u).searchParams.get("event");
      return boxscores[id ?? ""] ?? null;
    }
    if (u.endsWith("/teams")) return teamsResponse();
    return null;
  });
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
