// End-to-end tests for the tennis predictions API with the network mocked:
// the Sackmann season CSV (via the Kadantte mirror — the canonical repo is
// stubbed as offline, exactly like production in 2026), the tennis-data.co.uk
// odds layer and the ESPN scoreboard, so the full route pipeline (load →
// surface ELO replay → profiles → fixtures → market engine) runs offline.
//
// The two contracts under test:
//   · the response shape of the prediction spec (home/away, match winner,
//     total games, set winner, score distribution, scorelines, serve markets);
//   · the refusal rules — a 503 with the spec's error object when nothing can
//     be priced honestly, and `unavailable` entries instead of fake cards.

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TENNIS_API_UNAVAILABLE_MESSAGE } from "@/lib/data/sources/tennis";
import { GET } from "./route";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const HEADER =
  "tourney_id,tourney_name,surface,draw_size,tourney_level,tourney_date,match_num,winner_id,winner_seed,winner_entry,winner_name,winner_hand,winner_ht,winner_ioc,winner_age,loser_id,loser_seed,loser_entry,loser_name,loser_hand,loser_ht,loser_ioc,loser_age,score,best_of,round,minutes,w_ace,w_df,w_svpt,w_1stIn,w_1stWon,w_2ndWon,w_SvGms,w_bpSaved,w_bpFaced,l_ace,l_df,l_svpt,l_1stIn,l_1stWon,l_2ndWon,l_SvGms,l_bpSaved,l_bpFaced,winner_rank,winner_rank_points,loser_rank,loser_rank_points";

function row(fields: {
  id: string;
  tournament: string;
  surface: string;
  date: string;
  num: number;
  winner: string;
  loser: string;
  score: string;
  bestOf?: 3 | 5;
  round?: string;
  wAce: number;
  wDf: number;
  wSvpt: number;
  w1stWon: number;
  w2ndWon: number;
  wBpFaced: number;
  lAce: number;
  lDf: number;
  lSvpt: number;
  l1stWon: number;
  l2ndWon: number;
  lBpFaced: number;
  wRank: number;
  lRank: number;
}): string {
  return [
    fields.id,
    fields.tournament,
    fields.surface,
    "32",
    "A",
    fields.date,
    fields.num,
    "100",
    "",
    "",
    fields.winner,
    "R",
    "185",
    "ESP",
    "24.0",
    "200",
    "",
    "",
    fields.loser,
    "R",
    "185",
    "ITA",
    "24.0",
    fields.score,
    fields.bestOf ?? 3,
    fields.round ?? "R32",
    "90",
    fields.wAce,
    fields.wDf,
    fields.wSvpt,
    "40",
    fields.w1stWon,
    fields.w2ndWon,
    "10",
    "2",
    fields.wBpFaced,
    fields.lAce,
    fields.lDf,
    fields.lSvpt,
    "35",
    fields.l1stWon,
    fields.l2ndWon,
    "10",
    "1",
    fields.lBpFaced,
    fields.wRank,
    "4000",
    fields.lRank,
    "3000",
  ].join(",");
}

/** Hard (Brisbane), clay (Roland Garros) and grass (Wimbledon) samples. */
const SACKMANN_CSV = [
  HEADER,
  row({
    id: "2026-0339",
    tournament: "Brisbane",
    surface: "Hard",
    date: "20260104",
    num: 368,
    winner: "Carlos Alcaraz",
    loser: "Jannik Sinner",
    score: "6-3 6-4",
    wAce: 8, wDf: 2, wSvpt: 60, w1stWon: 30, w2ndWon: 12, wBpFaced: 3,
    lAce: 5, lDf: 1, lSvpt: 55, l1stWon: 24, l2ndWon: 8, lBpFaced: 7,
    wRank: 1, lRank: 2,
  }),
  row({
    id: "2026-0339",
    tournament: "Brisbane",
    surface: "Hard",
    date: "20260104",
    num: 369,
    winner: "Taylor Fritz",
    loser: "Casper Ruud",
    score: "7-6(4) 6-3",
    round: "QF",
    wAce: 14, wDf: 3, wSvpt: 72, w1stWon: 40, w2ndWon: 15, wBpFaced: 5,
    lAce: 4, lDf: 2, lSvpt: 68, l1stWon: 30, l2ndWon: 12, lBpFaced: 9,
    wRank: 9, lRank: 12,
  }),
  row({
    id: "2026-0339",
    tournament: "Brisbane",
    surface: "Hard",
    date: "20260105",
    num: 370,
    winner: "Jannik Sinner",
    loser: "Taylor Fritz",
    score: "6-4 3-6 6-2",
    round: "SF",
    wAce: 11, wDf: 1, wSvpt: 80, w1stWon: 44, w2ndWon: 16, wBpFaced: 6,
    lAce: 9, lDf: 4, lSvpt: 78, l1stWon: 38, l2ndWon: 14, lBpFaced: 8,
    wRank: 2, lRank: 9,
  }),
  row({
    id: "2026-0341",
    tournament: "Roland Garros",
    surface: "Clay",
    date: "20260531",
    num: 300,
    winner: "Carlos Alcaraz",
    loser: "Jannik Sinner",
    score: "6-4 6-4 6-4",
    bestOf: 5,
    round: "F",
    wAce: 15, wDf: 2, wSvpt: 110, w1stWon: 55, w2ndWon: 18, wBpFaced: 10,
    lAce: 12, lDf: 2, lSvpt: 100, l1stWon: 50, l2ndWon: 16, lBpFaced: 6,
    wRank: 1, lRank: 2,
  }),
  row({
    id: "2026-0341",
    tournament: "Roland Garros",
    surface: "Clay",
    date: "20260529",
    num: 298,
    winner: "Casper Ruud",
    loser: "Taylor Fritz",
    score: "6-2 7-5",
    round: "SF",
    wAce: 6, wDf: 1, wSvpt: 65, w1stWon: 34, w2ndWon: 12, wBpFaced: 4,
    lAce: 10, lDf: 3, lSvpt: 62, l1stWon: 30, l2ndWon: 10, lBpFaced: 8,
    wRank: 12, lRank: 9,
  }),
  row({
    id: "2026-0340",
    tournament: "Wimbledon",
    surface: "Grass",
    date: "20260710",
    num: 250,
    winner: "Carlos Alcaraz",
    loser: "Taylor Fritz",
    score: "7-6(3) 6-4",
    round: "QF",
    wAce: 18, wDf: 1, wSvpt: 70, w1stWon: 42, w2ndWon: 14, wBpFaced: 3,
    lAce: 16, lDf: 2, lSvpt: 68, l1stWon: 38, l2ndWon: 12, lBpFaced: 5,
    wRank: 1, lRank: 9,
  }),
  row({
    id: "2026-0340",
    tournament: "Wimbledon",
    surface: "Grass",
    date: "20260711",
    num: 251,
    winner: "Jannik Sinner",
    loser: "Casper Ruud",
    score: "6-3 6-4",
    round: "QF",
    wAce: 13, wDf: 2, wSvpt: 58, w1stWon: 34, w2ndWon: 12, wBpFaced: 2,
    lAce: 7, lDf: 1, lSvpt: 56, l1stWon: 28, l2ndWon: 10, lBpFaced: 6,
    wRank: 2, lRank: 12,
  }),
].join("\n");

interface EspnCompetition {
  id: string;
  date: string;
  state: "pre" | "in" | "post";
  players: [string, string];
  round?: string;
  periods?: number;
}

function board(
  tournament: string,
  competitions: EspnCompetition[],
  slug = "mens-singles",
): unknown {
  const displayName = slug === "mens-singles" ? "Men's Singles" : "Women's Singles";
  return {
    events: [
      {
        name: tournament,
        groupings: [
          {
            grouping: { displayName, slug },
            competitions: competitions.map((comp) => ({
              id: comp.id,
              date: comp.date,
              status: { type: { state: comp.state } },
              venue: { fullName: "Venue" },
              ...(comp.round ? { round: { displayName: comp.round } } : {}),
              ...(comp.periods ? { format: { regulation: { periods: comp.periods } } } : {}),
              competitors: comp.players.map((name) => ({
                type: "athlete",
                athlete: { displayName: name, flag: { alt: "ESP" } },
              })),
            })),
          },
        ],
      },
    ],
  };
}

const ESPN_ATP_BOARD = {
  events: [
    ...(board("US Open", [
      {
        id: "184001",
        date: "2099-09-05T17:30Z",
        state: "pre",
        players: ["Carlos Alcaraz", "Jannik Sinner"],
        round: "Round of 32",
        periods: 5,
      },
      {
        id: "184002",
        date: "2099-09-05T15:00Z",
        state: "in",
        players: ["Taylor Fritz", "Casper Ruud"],
        round: "Round of 32",
      },
      {
        id: "184003",
        date: "2099-09-05T11:00Z",
        state: "post",
        players: ["Carlos Alcaraz", "Taylor Fritz"],
        round: "Round of 32",
      },
    ]) as { events: unknown[] }).events,
    ...(board("Italian Open", [
      {
        id: "185001",
        date: "2099-09-06T13:00Z",
        state: "pre",
        players: ["Taylor Fritz", "Casper Ruud"],
        round: "Round of 16",
      },
    ]) as { events: unknown[] }).events,
    ...(board("Wimbledon", [
      {
        // A player with no history at all → the fixture must be refused.
        id: "186001",
        date: "2099-09-07T13:00Z",
        state: "pre",
        players: ["Carlos Alcaraz", "Qualifier Nobody"],
        round: "Round of 16",
      },
    ]) as { events: unknown[] }).events,
    ...(board("Mystery Cup", [
      {
        // A tournament with no surface hint and no history → unknown surface.
        id: "187001",
        date: "2099-09-08T13:00Z",
        state: "pre",
        players: ["Carlos Alcaraz", "Jannik Sinner"],
      },
    ]) as { events: unknown[] }).events,
  ],
};

/** WTA fixtures: real players, but none of them exist in the loaded dataset. */
const ESPN_WTA_BOARD = board(
  "Antalya Open",
  [
    {
      id: "284001",
      date: "2099-09-05T12:00Z",
      state: "pre",
      players: ["Iga Swiatek", "Elise Mertens"],
      round: "Round 1",
    },
  ],
  "womens-singles",
);

// ─── Fetch stub ───────────────────────────────────────────────────────────────

let mode: "ok" | "all-sources-down" = "ok";

beforeEach(() => {
  mode = "ok";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (mode === "all-sources-down") {
        return { ok: false, status: 500, text: async () => "", json: async () => ({}) } as unknown as Response;
      }
      if (url.includes("site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard")) {
        return { ok: true, status: 200, json: async () => ESPN_ATP_BOARD } as unknown as Response;
      }
      if (url.includes("site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard")) {
        return { ok: true, status: 200, json: async () => ESPN_WTA_BOARD } as unknown as Response;
      }
      // The canonical Sackmann repos are offline in production — mirror only.
      if (url.startsWith("https://raw.githubusercontent.com/JeffSackmann/")) {
        return { ok: false, status: 404, text: async () => "404: Not Found" } as unknown as Response;
      }
      if (url.startsWith("https://raw.githubusercontent.com/Kadantte/")) {
        return { ok: true, status: 200, text: async () => SACKMANN_CSV } as unknown as Response;
      }
      if (url.includes("tennis-data.co.uk")) {
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
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

interface RoutePrediction {
  home: number;
  away: number;
  fairOddsHome: number;
  fairOddsAway: number;
  eloHome: number;
  eloAway: number;
}

interface RouteMatch {
  id: string;
  tour: string;
  tournament: string;
  round: string | null;
  surface: string;
  bestOf: number;
  status: string;
  dataQuality: string;
  home: {
    name: string;
    elo: number;
    eloBySurface: Record<string, number | null>;
    surfaceMatches: number;
    rank: number | null;
    serveWinRate: number | null;
    returnWinRate: number | null;
  };
  away: {
    name: string;
    elo: number;
    rank: number | null;
    serveWinRate: number | null;
    returnWinRate: number | null;
  };
  matchWinner: RoutePrediction;
  totalGames: { expected: number; probabilities: Record<string, number> };
  setWinner: { sets: Array<{ set: number; home: number; away: number }>; setBetting: Array<{ score: string; prob: number }> };
  scoreDistribution: Record<string, number>;
  projectedScoreline: string;
  projectedWinner: string;
  topScorelines: Array<{ score: string; prob: number }>;
  aces: { home: { expected: number; probabilities: Record<string, number> }; away: { expected: number } } | null;
  doubleFaults: { home: { expected: number }; away: { expected: number } } | null;
  markets: Array<{ family: string; selection: string; probability: number }>;
  notes: string[];
}

interface RouteBody {
  generatedAt: string;
  dataStatus: Record<string, { ok: boolean; matches: number; playersRated: number; error: string | null }>;
  count: number;
  matches: RouteMatch[];
  unavailable: Array<{ tournament: string; home: string; away: string; reason: string }>;
  error?: string;
  details?: string;
}

async function getJson(query: string): Promise<RouteBody> {
  const response = await GET(request(query));
  const body = (await response.json()) as RouteBody & { status?: number };
  return Object.assign(body, { __status: response.status }) as RouteBody & { __status: number };
}

async function getWithStatus(query: string): Promise<{ status: number; body: RouteBody }> {
  const response = await GET(request(query));
  return { status: response.status, body: (await response.json()) as RouteBody };
}

describe("GET /api/tennis/predictions", () => {
  it("predicts scheduled singles matches end-to-end from the mocked sources", async () => {
    const { status, body } = await getWithStatus("?tour=atp&limit=10&refresh=1");

    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    // Three scheduled singles matches; the live one is excluded by default, the
    // completed one never, and the two unrateable ones are refused.
    expect(body.matches.map((m) => m.id).sort()).toEqual(["atp-184001", "atp-185001"].sort());

    const usOpen = body.matches.find((m) => m.id === "atp-184001");
    expect(usOpen?.tour).toBe("atp");
    expect(usOpen?.surface).toBe("hard");
    expect(usOpen?.bestOf).toBe(5);
    expect(usOpen?.status).toBe("scheduled");
    expect(usOpen?.round).toBe("Round of 32");

    // Players: real names, surface ELO, rank and serve/return rates.
    expect(usOpen?.home.name).toBe("Carlos Alcaraz");
    expect(usOpen?.away.name).toBe("Jannik Sinner");
    expect(usOpen?.home.elo).toBeGreaterThan(1500);
    expect(usOpen?.away.elo).toBeGreaterThan(1400);
    expect(usOpen?.home.surfaceMatches).toBeGreaterThan(0);
    expect(usOpen?.home.rank).toBe(1);
    expect(usOpen?.home.serveWinRate).toBeGreaterThan(0.5);
    expect(usOpen?.home.returnWinRate).toBeGreaterThan(0.2);
    // Only the surface in play is guaranteed; the others come from real samples.
    expect(usOpen?.home.eloBySurface.hard).toBeGreaterThan(0);
    expect(usOpen?.home.eloBySurface.clay).not.toBeNull();

    // Match winner market.
    const winner = usOpen?.matchWinner;
    expect((winner?.home ?? 0) + (winner?.away ?? 0)).toBeCloseTo(1, 5);
    expect(winner?.fairOddsHome).toBeCloseTo(1 / (winner?.home ?? 1), 1);
    expect(winner?.fairOddsAway).toBeCloseTo(1 / (winner?.away ?? 1), 1);

    // Total games: expectation plus over/under probability keys.
    expect(usOpen?.totalGames.expected).toBeGreaterThan(30); // best-of-5
    const tgKeys = Object.keys(usOpen?.totalGames.probabilities ?? {});
    expect(tgKeys.some((k) => k.startsWith("over_"))).toBe(true);
    expect(tgKeys.some((k) => k.startsWith("under_"))).toBe(true);

    // Set winner + score distribution.
    expect(usOpen?.setWinner.sets).toHaveLength(5);
    for (const set of usOpen?.setWinner.sets ?? []) {
      expect(set.home + set.away).toBeCloseTo(1, 5);
    }
    const scoreKeys = Object.keys(usOpen?.scoreDistribution ?? {}).sort();
    expect(scoreKeys).toEqual(["0-3", "1-3", "2-3", "3-0", "3-1", "3-2"]);
    const distSum = Object.values(usOpen?.scoreDistribution ?? {}).reduce((a, b) => a + b, 0);
    expect(distSum).toBeCloseTo(1, 4);

    // Projected scoreline + top 5.
    expect(usOpen?.projectedScoreline).toMatch(/^[0-9]-[0-9]( [0-9]-[0-9]){2,4}$/);
    expect(usOpen?.projectedWinner).toBeTruthy();
    expect(usOpen?.topScorelines.length).toBeGreaterThan(0);
    expect(usOpen?.topScorelines.length).toBeLessThanOrEqual(5);

    // Serve-stat markets from real baselines.
    expect(usOpen?.aces).not.toBeNull();
    expect(usOpen?.aces?.home.expected).toBeGreaterThan(0);
    expect(Object.keys(usOpen?.aces?.home.probabilities ?? {}).some((k) => k.startsWith("over_"))).toBe(true);
    expect(usOpen?.doubleFaults).not.toBeNull();

    // Market families + data quality.
    const families = new Set(usOpen?.markets.map((m) => m.family));
    for (const family of ["Match Winner", "Total Games", "Set Winner", "Correct Score", "Aces", "Double Faults"]) {
      expect(families.has(family)).toBe(true);
    }
    expect(usOpen?.dataQuality).toBe("real");

    // Data status for the UI badge.
    expect(body.dataStatus.atp?.ok).toBe(true);
    expect(body.dataStatus.atp?.matches).toBeGreaterThan(0);
    expect(body.dataStatus.atp?.playersRated).toBeGreaterThan(0);
  });

  it("refuses fixtures it cannot rate instead of predicting them", async () => {
    const body = await getJson("?tour=atp&limit=10&refresh=1");
    const reasons = body.unavailable.map((u) => `${u.home}|${u.away}|${u.reason}`);
    // No ELO for the unknown qualifier, and no surface for the unknown tournament.
    expect(reasons.some((r) => r.includes("Qualifier Nobody") && r.includes("no Elo"))).toBe(true);
    expect(reasons.some((r) => r.includes("unknown surface"))).toBe(true);
    // Neither appears in the priced list.
    expect(body.matches.some((m) => m.id === "atp-186001")).toBe(false);
    expect(body.matches.some((m) => m.id === "atp-187001")).toBe(false);
  });

  it("filters predictions by surface (clay vs hard)", async () => {
    const clay = await getJson("?tour=atp&surface=clay&refresh=1");
    expect(clay.count).toBe(1);
    expect(clay.matches[0].id).toBe("atp-185001");
    expect(clay.matches[0].surface).toBe("clay");
    expect(clay.matches[0].tournament).toBe("Italian Open");
    expect(clay.matches[0].bestOf).toBe(3);
    expect(clay.matches[0].totalGames.expected).toBeLessThan(30);

    const hard = await getJson("?tour=atp&surface=hard&refresh=1");
    expect(hard.count).toBe(1);
    expect(hard.matches[0].id).toBe("atp-184001");
    expect(hard.matches[0].surface).toBe("hard");
  });

  it("includes in-progress matches only when includeLive is set", async () => {
    const withLive = await getJson("?tour=atp&includeLive=1&refresh=1");
    expect(withLive.count).toBe(3);
    expect(withLive.matches.some((m) => m.status === "live")).toBe(true);

    const withoutLive = await getJson("?tour=atp&refresh=1");
    expect(withoutLive.matches.some((m) => m.status === "live")).toBe(false);
  });

  it("rejects an unknown surface with a 400", async () => {
    const response = await GET(request("?surface=carpet"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("carpet");
  });

  it("returns 503 with the spec's error object when no source is reachable", async () => {
    mode = "all-sources-down";
    const { status, body } = await getWithStatus("?tour=atp&refresh=1");

    expect(status).toBe(503);
    expect(body.error).toBe(TENNIS_API_UNAVAILABLE_MESSAGE);
    expect(body.details).toBeTruthy();
    expect(body.matches).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.dataStatus.atp?.ok).toBe(false);
  });

  it("returns 503 when the only fixtures cannot be rated", async () => {
    // The WTA board lists players with no history in the loaded dataset, so
    // every fixture is refused and the endpoint reports the blocking matchup.
    const { status, body } = await getWithStatus("?tour=wta&refresh=1");
    expect(status).toBe(503);
    expect(body.error).toBe(TENNIS_API_UNAVAILABLE_MESSAGE);
    expect(body.details).toContain("Players:");
  });
});
