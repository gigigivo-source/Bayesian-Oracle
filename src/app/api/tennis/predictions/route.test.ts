// End-to-end tests for the tennis predictions API with the network mocked:
// the Sackmann season CSV, the tennis-data.co.uk odds layer and the ESPN
// scoreboard are all stubbed, so the full route pipeline (load → ELO replay →
// profiles → fixtures → market engine → surface filter) runs offline.

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SACKMANN_CSV = `tourney_id,tourney_name,surface,draw_size,tourney_level,tourney_date,match_num,winner_id,winner_seed,winner_entry,winner_name,winner_hand,winner_ht,winner_ioc,winner_age,loser_id,loser_seed,loser_entry,loser_name,loser_hand,loser_ht,loser_ioc,loser_age,score,best_of,round,minutes,w_ace,w_df,w_svpt,w_1stIn,w_1stWon,w_2ndWon,w_SvGms,w_bpSaved,w_bpFaced,l_ace,l_df,l_svpt,l_1stIn,l_1stWon,l_2ndWon,l_SvGms,l_bpSaved,l_bpFaced,winner_rank,winner_rank_points,loser_rank,loser_rank_points
2026-0339,Brisbane,Hard,32,A,20260104,368,200624,,,Sebastian Korda,R,196,USA,25.5,208103,3,,Jiri Lehecka,R,185,CZE,24.1,6-3 1-2 RET,3,R16,46,6,1,28,16,16,8,6,0,0,6,0,41,27,21,5,6,3,4,46,1090,19,2075
2026-0339,Brisbane,Hard,32,A,20260104,371,206499,,,Aleksandar Kovacevic,R,183,USA,27.3,208659,,,Giovanni Mpetshi Perricard,R,203,FRA,22.4,W/O,3,QF,,,,0,,,,,,0,,,,,,,0,,58,877,67,825
2026-9900,United Cup,Hard,18,A,20260105,399,126203,1,,Taylor Fritz,R,196,USA,28.1,128034,9,,Hubert Hurkacz,R,196,POL,28.8,7-6(1) 7-6(2),3,SF,94,16,3,76,59,50,7,12,2,2,12,0,73,47,37,13,12,1,1,9,3840,83,710
2026-9900,United Cup,Hard,18,A,20260105,400,128034,9,,Hubert Hurkacz,R,196,POL,28.8,104527,16,,Stan Wawrinka,R,183,SUI,40.7,6-3 3-6 6-3,3,F,114,18,0,90,63,52,9,14,8,9,10,1,78,49,38,15,13,5,7,83,710,156,397
2026-0341,Roland Garros,Clay,128,G,20260531,300,111111,1,,Carlos Alcaraz,L,183,ESP,23.0,222222,2,,Jannik Sinner,L,198,ITA,24.5,6-4 6-4 6-4,5,F,180,15,2,110,70,55,18,16,4,10,12,2,100,60,50,16,16,4,6,1,5105,2,5000
`;

const ESPN_ATP_BOARD = {
  events: [
    {
      name: "US Open",
      groupings: [
        {
          grouping: { displayName: "Men's Singles", slug: "mens-singles" },
          competitions: [
            {
              // Scheduled, hard, best-of-5 (ESPN format), both players rated.
              id: "184001",
              date: "2099-09-05T17:30Z",
              status: { type: { state: "pre" } },
              venue: { fullName: "New York, USA" },
              round: { displayName: "Round of 32" },
              format: { regulation: { periods: 5 } },
              competitors: [
                { type: "athlete", athlete: { displayName: "Carlos Alcaraz", flag: { alt: "Spain" } } },
                { type: "athlete", athlete: { displayName: "Jannik Sinner", flag: { alt: "Italy" } } },
              ],
            },
            {
              // In progress — excluded unless includeLive is set.
              id: "184002",
              date: "2099-09-05T15:00Z",
              status: { type: { state: "in" } },
              venue: { fullName: "New York, USA" },
              competitors: [
                { type: "athlete", athlete: { displayName: "Hubert Hurkacz" } },
                { type: "athlete", athlete: { displayName: "Stan Wawrinka" } },
              ],
            },
            {
              // Completed — never predicted.
              id: "184003",
              date: "2099-09-05T11:00Z",
              status: { type: { state: "post" } },
              competitors: [
                { type: "athlete", athlete: { displayName: "Taylor Fritz" } },
                { type: "athlete", athlete: { displayName: "Aleksandar Kovacevic" } },
              ],
            },
          ],
        },
      ],
    },
    {
      name: "Italian Open",
      groupings: [
        {
          grouping: { displayName: "Men's Singles", slug: "mens-singles" },
          competitions: [
            {
              // Scheduled clay match — the surface hint map resolves it.
              id: "185001",
              date: "2099-09-06T13:00Z",
              status: { type: { state: "pre" } },
              venue: { fullName: "Rome, Italy" },
              round: { displayName: "Round of 16" },
              competitors: [
                { type: "athlete", athlete: { displayName: "Taylor Fritz" } },
                { type: "athlete", athlete: { displayName: "Sebastian Korda" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// ─── Fetch stub ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard")) {
        return { ok: true, status: 200, json: async () => ESPN_ATP_BOARD } as Response;
      }
      if (url.includes("site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard")) {
        return { ok: true, status: 200, json: async () => ({ events: [] }) } as Response;
      }
      if (url.startsWith("https://raw.githubusercontent.com/")) {
        return { ok: true, status: 200, text: async () => SACKMANN_CSV } as Response;
      }
      if (url.includes("tennis-data.co.uk")) {
        return { ok: true, status: 200, text: async () => "" } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(query: string): Request {
  return new Request(`http://localhost/api/tennis/predictions${query}`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

interface RouteMatch {
  id: string;
  tour: string;
  tournament: string;
  surface: string | null;
  status: string;
  bestOf: number;
  players: Array<{
    name: string;
    rating: number;
    ratingSource: string;
    acesPerMatch: number | null;
    baselineSource: string;
  }>;
  prediction: {
    projectedScoreline: string;
    projectedWinner: string;
    matchWinner: { probA: number; probB: number; favorite: string };
    totalGames: { expected: number; lines: Array<{ line: number }> };
    aces: unknown;
    markets: Array<{ family: string }>;
  };
}

async function getJson(query: string): Promise<{
  count: number;
  matches: RouteMatch[];
  ratings: Record<string, { playersRated: number; matchesProcessed: number }>;
  sources: Array<{ source: string; note: string }>;
  error?: string;
}> {
  const response = await GET(request(query));
  const body = (await response.json()) as Record<string, unknown>;
  return body as never;
}

describe("GET /api/tennis/predictions", () => {
  it("predicts scheduled singles matches end-to-end from the mocked sources", async () => {
    const body = await getJson("?tour=atp&limit=10");

    expect(body.error).toBeUndefined();
    // Two scheduled matches (live and completed are excluded by default).
    expect(body.count).toBe(2);
    expect(body.matches.map((m) => m.id).sort()).toEqual(["atp-184001", "atp-185001"]);

    const usOpen = body.matches.find((m) => m.id === "atp-184001");
    expect(usOpen).toBeDefined();
    expect(usOpen?.tour).toBe("atp");
    expect(usOpen?.surface).toBe("hard");
    expect(usOpen?.bestOf).toBe(5);
    expect(usOpen?.status).toBe("scheduled");

    // Ratings resolved from the replayed ELO table, baselines from real stats.
    const alcaraz = usOpen?.players[0];
    expect(alcaraz?.name).toBe("Carlos Alcaraz");
    expect(alcaraz?.ratingSource).toBe("elo");
    expect(alcaraz?.rating).toBeGreaterThan(1500); // won his only fixture match
    expect(alcaraz?.acesPerMatch).toBe(15);
    expect(alcaraz?.baselineSource).toBe("overall"); // 1 clay match < 5 threshold

    // Full prediction payload.
    const prediction = usOpen?.prediction;
    const probA = prediction?.matchWinner.probA ?? 0;
    const probB = prediction?.matchWinner.probB ?? 0;
    expect(probA + probB).toBeCloseTo(1, 5);
    expect(prediction?.matchWinner.favorite).toBe("Carlos Alcaraz");
    expect(prediction?.projectedScoreline).toMatch(/^[0-9]-[0-9]( [0-9]-[0-9]){2,4}$/);
    expect(prediction?.projectedWinner).toBe("Carlos Alcaraz");
    expect(prediction?.totalGames.expected).toBeGreaterThan(30); // best-of-5
    expect(prediction?.totalGames.lines.length).toBeGreaterThan(0);

    const families = new Set(prediction?.markets.map((m) => m.family));
    for (const family of [
      "Match Winner",
      "Total Games",
      "Set Winner",
      "Aces",
      "Double Faults",
      "Break Points",
    ]) {
      expect(families.has(family)).toBe(true);
    }

    // Ratings summary + source reports expose the mocked pipeline.
    expect(body.ratings.atp?.playersRated).toBeGreaterThan(5);
    expect(body.ratings.atp?.matchesProcessed).toBeGreaterThan(0);
    expect(body.sources.some((s) => s.source.startsWith("sackmann:"))).toBe(true);
    expect(body.sources.some((s) => s.source === "espn-scoreboard")).toBe(true);
  });

  it("filters predictions by surface (clay vs hard)", async () => {
    const clay = await getJson("?tour=atp&surface=clay");
    expect(clay.count).toBe(1);
    expect(clay.matches[0].id).toBe("atp-185001");
    expect(clay.matches[0].surface).toBe("clay");
    expect(clay.matches[0].tournament).toBe("Italian Open");
    // Clay match, ATP non-slam → best of 3, lower total-games expectation.
    expect(clay.matches[0].bestOf).toBe(3);

    const hard = await getJson("?tour=atp&surface=hard");
    expect(hard.count).toBe(1);
    expect(hard.matches[0].id).toBe("atp-184001");
    expect(hard.matches[0].surface).toBe("hard");
  });

  it("includes in-progress matches only when includeLive is set", async () => {
    const withLive = await getJson("?tour=atp&includeLive=1");
    expect(withLive.count).toBe(3);
    expect(withLive.matches.some((m) => m.status === "live")).toBe(true);
  });

  it("rejects an unknown surface with a 400", async () => {
    const response = await GET(request("?surface=quick carpet"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("quick carpet");
  });
});
