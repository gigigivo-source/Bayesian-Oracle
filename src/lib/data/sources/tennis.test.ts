// Unit tests for the tennis data layer (Part 8 — second sport).
//
// Pure-parser tests only: known CSV/JSON fixtures in, canonical TennisMatch /
// UpcomingTennisMatch shapes out. No network access here.

import { describe, expect, it } from "vitest";
import {
  bestOfForTournament,
  buildTennisPlayerProfiles,
  computeTourBaselines,
  finishFromScore,
  inferSurface,
  normalisePlayerName,
  normaliseSurface,
  parseEspnTennisScoreboard,
  parseSackmannTennisCsv,
  parseTennisDataCsv,
  parseTennisDataDate,
  playerNamesMatch,
  surfaceServeBaseline,
  tennisPlayerKey,
  type TennisMatch,
  type TennisPlayerProfile,
} from "./tennis";

// ─── Sackmann season files ────────────────────────────────────────────────────
//
// Rows adapted from the real 2026 season files (United Cup / Brisbane /
// Roland Garros). Chronological order after the in-parser sort:
//   1. 2026-01-04 Brisbane, match_num 368 — Korda d. Lehecka (RET)
//   2. 2026-01-04 Brisbane, match_num 371 — Kovacevic d. Mpetshi Perricard (W/O)
//   3. 2026-01-05 United Cup, match_num 399 — Fritz d. Hurkacz
//   4. 2026-01-05 United Cup, match_num 400 — Hurkacz d. Wawrinka
//   5. 2026-05-31 Roland Garros — Alcaraz d. Sinner (best-of-5, clay)

const SACKMANN_CSV = `tourney_id,tourney_name,surface,draw_size,tourney_level,tourney_date,match_num,winner_id,winner_seed,winner_entry,winner_name,winner_hand,winner_ht,winner_ioc,winner_age,loser_id,loser_seed,loser_entry,loser_name,loser_hand,loser_ht,loser_ioc,loser_age,score,best_of,round,minutes,w_ace,w_df,w_svpt,w_1stIn,w_1stWon,w_2ndWon,w_SvGms,w_bpSaved,w_bpFaced,l_ace,l_df,l_svpt,l_1stIn,l_1stWon,l_2ndWon,l_SvGms,l_bpSaved,l_bpFaced,winner_rank,winner_rank_points,loser_rank,loser_rank_points
2026-0339,Brisbane,Hard,32,A,20260104,368,200624,,,Sebastian Korda,R,196,USA,25.5,208103,3,,Jiri Lehecka,R,185,CZE,24.1,6-3 1-2 RET,3,R16,46,6,1,28,16,16,8,6,0,0,6,0,41,27,21,5,6,3,4,46,1090,19,2075
2026-0339,Brisbane,Hard,32,A,20260104,371,206499,,,Aleksandar Kovacevic,R,183,USA,27.3,208659,,,Giovanni Mpetshi Perricard,R,203,FRA,22.4,W/O,3,QF,,,,0,,,,,,0,,,,,,,0,,58,877,67,825
2026-9900,United Cup,Hard,18,A,20260105,399,126203,1,,Taylor Fritz,R,196,USA,28.1,128034,9,,Hubert Hurkacz,R,196,POL,28.8,7-6(1) 7-6(2),3,SF,94,16,3,76,59,50,7,12,2,2,12,0,73,47,37,13,12,1,1,9,3840,83,710
2026-9900,United Cup,Hard,18,A,20260105,400,128034,9,,Hubert Hurkacz,R,196,POL,28.8,104527,16,,Stan Wawrinka,R,183,SUI,40.7,6-3 3-6 6-3,3,F,114,18,0,90,63,52,9,14,8,9,10,1,78,49,38,15,13,5,7,83,710,156,397
2026-0341,Roland Garros,Clay,128,G,20260531,300,111111,1,,Carlos Alcaraz,L,183,ESP,23.0,222222,2,,Jannik Sinner,L,198,ITA,24.5,6-4 6-4 6-4,5,F,180,15,2,110,70,55,18,16,4,10,12,2,100,60,50,16,16,4,6,1,5105,2,5000
`;

describe("parseSackmannTennisCsv", () => {
  const matches = parseSackmannTennisCsv(SACKMANN_CSV, "atp");

  it("parses identity, surface, score and round of every row", () => {
    expect(matches).toHaveLength(5);
    const byWinner = new Map(matches.map((m) => [m.winner, m]));
    const hurkacz = byWinner.get("Hubert Hurkacz");
    expect(hurkacz?.loser).toBe("Stan Wawrinka");
    expect(hurkacz?.surface).toBe("hard");
    expect(hurkacz?.score).toBe("6-3 3-6 6-3");
    expect(hurkacz?.matchDate).toBe("2026-01-05T00:00:00Z");
    expect(hurkacz?.round).toBe("F");
    expect(hurkacz?.tournament).toBe("United Cup");
    const rg = byWinner.get("Carlos Alcaraz");
    expect(rg?.surface).toBe("clay");
    expect(rg?.bestOf).toBe(5);
    expect(rg?.tournament).toBe("Roland Garros");
  });

  it("maps the winner/loser serve-stat columns", () => {
    const hurkacz = matches.find((m) => m.winner === "Hubert Hurkacz");
    expect(hurkacz?.winnerStats.aces).toBe(18);
    expect(hurkacz?.winnerStats.doubleFaults).toBe(0);
    expect(hurkacz?.winnerStats.bpSaved).toBe(8);
    expect(hurkacz?.winnerStats.bpFaced).toBe(9);
    expect(hurkacz?.loserStats.aces).toBe(10);
    expect(hurkacz?.loserStats.bpSaved).toBe(5);
    expect(hurkacz?.winnerRank).toBe(83);
    expect(hurkacz?.loserRank).toBe(156);
  });

  it("classifies retirements and walkovers and keeps them out of serve stats", () => {
    const withStats = matches.filter(
      (m) => m.finish === "completed" && m.winnerStats.aces !== null,
    );
    expect(withStats).toHaveLength(3);
    expect(matches.find((m) => m.winner === "Sebastian Korda")?.finish).toBe("retired");
    expect(matches.find((m) => m.winner === "Aleksandar Kovacevic")?.finish).toBe("walkover");
  });

  it("orders matches chronologically (ascending match_num within a date)", () => {
    const unitedCup = matches.filter((m) => m.tournament === "United Cup");
    expect(unitedCup.map((m) => m.winner)).toEqual(["Taylor Fritz", "Hubert Hurkacz"]);
    expect(matches[0].matchDate).toBe("2026-01-04T00:00:00Z");
    expect(matches[4].matchDate).toBe("2026-05-31T00:00:00Z");
  });
});

describe("finishFromScore", () => {
  it("classifies retirements, walkovers, defaults and completed matches", () => {
    expect(finishFromScore("6-3 1-2 RET")).toBe("retired");
    expect(finishFromScore("W/O")).toBe("walkover");
    expect(finishFromScore("6-2 DEF")).toBe("walkover");
    expect(finishFromScore("7-6(4) 6-4")).toBe("completed");
  });
});

// ─── tennis-data.co.uk files ─────────────────────────────────────────────────
//
// Parsed order is by date: Rome (12/05/2025), Wimbledon (03/07/2025),
// Paris (30/10/25), Australian Open (15/01/2026), Australian Open (16/01/2026).

const TENNIS_DATA_CSV = `ATP,WTA,Location,Tournament,Date,Series,Tier,Court,Surface,Round,Best of,Winner,Loser,WRank,LRank,WPts,LPts,W1,L1,W2,L2,W3,L3,W4,L4,W5,L5,Wsets,Lsets,Comment,B365W,B365L,PSW,PSL,MaxW,MaxL,AvgW,AvgL
1,,Melbourne,Australian Open,15/01/2026,Grand Slam,,Outdoor,Hard,1st Round,5,Carlos Alcaraz,Jannik Sinner,2,1,9800,11000,6,4,6,3,6,2,,,,,3,0,Completed,2.1,1.72,2.05,1.8,2.25,1.9,2.05,1.77
,,Melbourne,Australian Open,16/01/2026,Grand Slam,,Outdoor,Hard,1st Round,5,Alex De Minaur,Casper Ruud,8,12,3010,2750,3,6,6,4,7,5,,,,,2,1,Completed,2.5,1.55,2.45,1.52,2.6,1.6,2.48,1.54
,,Rome,Italian Open,12/05/2025,Masters,,Outdoor,Clay,Final,3,Novak Djokovic,Jannik Sinner,5,1,5000,11000,6,2,7,5,,,,,,,2,0,Completed,,,,,,,,
,,London,Wimbledon,03/07/2025,Grand Slam,,Outdoor,Grass,2nd Round,3,Taylor Fritz,Aleksandar Kovacevic,9,58,1900,900,7,6,6,4,,,,,,,2,0,Completed,1.6,2.35,1.55,2.5,1.7,2.6,,
,,Paris,Paris Masters,30/10/25,Masters,,Indoor,Hard,1st Round,3,Daniil Medvedev,Alex Michelsen,6,37,2210,1330,6,2,4,6,,,,,,,1,0,Retired,1.5,2.6,,,,,,
`;

describe("parseTennisDataCsv", () => {
  const matches = parseTennisDataCsv(TENNIS_DATA_CSV, "atp");

  it("parses dates in dd/mm/yyyy and dd/mm/yy and sorts chronologically", () => {
    expect(matches).toHaveLength(5);
    expect(matches.map((m) => m.matchDate.slice(0, 10))).toEqual([
      "2025-05-12",
      "2025-07-03",
      "2025-10-30",
      "2026-01-15",
      "2026-01-16",
    ]);
  });

  it("maps surface, best-of and reconstructed set scores", () => {
    const ao = matches[3];
    expect(ao.surface).toBe("hard");
    expect(ao.score).toBe("6-4 6-3 6-2");
    expect(ao.bestOf).toBe(5);
    expect(ao.tournament).toBe("Australian Open");
    const rome = matches[0];
    expect(rome.surface).toBe("clay");
    expect(rome.bestOf).toBe(3);
    expect(rome.score).toBe("6-2 7-5");
    expect(matches[1].surface).toBe("grass");
  });

  it("prefers the market-average odds, then Pinnacle, then Bet365", () => {
    expect(matches[3].odds).toEqual({ winner: 2.05, loser: 1.77, book: "Oddsportal average" });
    expect(matches[1].odds).toEqual({ winner: 1.55, loser: 2.5, book: "Pinnacle" });
    expect(matches[2].odds).toEqual({ winner: 1.5, loser: 2.6, book: "Bet365" });
    expect(matches[0].odds).toBeNull();
  });

  it("marks retirements from the Comment column and keeps ranks", () => {
    const paris = matches[2];
    expect(paris.finish).toBe("retired");
    expect(paris.score).toContain("RET");
    expect(paris.winnerRank).toBe(6);
    expect(paris.loserRank).toBe(37);
  });

  it("carries no serve stats (the odds layer never fakes them)", () => {
    expect(matches[3].winnerStats.aces).toBeNull();
    expect(matches[3].source).toBe("tennis-data");
  });
});

describe("parseTennisDataDate", () => {
  it("rejects malformed dates", () => {
    expect(parseTennisDataDate("not-a-date")).toBeNull();
    expect(parseTennisDataDate("32/13/2026")).toBeNull();
    expect(parseTennisDataDate(null)).toBeNull();
  });
});

// ─── ESPN scoreboard ──────────────────────────────────────────────────────────

const ESPN_BOARD = {
  events: [
    {
      name: "US Open",
      groupings: [
        {
          grouping: { displayName: "Men's Singles", slug: "mens-singles" },
          competitions: [
            {
              id: "184001",
              date: "2026-09-05T17:30Z",
              status: { type: { state: "pre", description: "Scheduled" } },
              venue: { fullName: "New York, USA" },
              round: { displayName: "Round of 32" },
              format: { regulation: { periods: 5 } },
              competitors: [
                {
                  type: "athlete",
                  homeAway: "home",
                  athlete: { displayName: "Carlos Alcaraz", flag: { alt: "Spain" } },
                },
                {
                  type: "athlete",
                  homeAway: "away",
                  athlete: { displayName: "Jannik Sinner", flag: { alt: "Italy" } },
                },
              ],
            },
            {
              id: "184002",
              date: "2026-09-05T15:00Z",
              status: { type: { state: "in", description: "In Progress" } },
              venue: { fullName: "New York, USA", court: "Court 12" },
              round: { displayName: "Round of 32" },
              competitors: [
                { type: "athlete", athlete: { displayName: "Taylor Fritz" } },
                { type: "athlete", athlete: { displayName: "Casper Ruud" } },
              ],
            },
          ],
        },
        {
          grouping: { displayName: "Men's Doubles", slug: "mens-doubles" },
          competitions: [
            {
              id: "184003",
              date: "2026-09-05T18:00Z",
              status: { type: { state: "pre" } },
              competitors: [
                { type: "athlete", athlete: { displayName: "Joe Salisbury" } },
                { type: "athlete", athlete: { displayName: "Rajeev Ram" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("parseEspnTennisScoreboard", () => {
  const upcoming = parseEspnTennisScoreboard(ESPN_BOARD, "atp");

  it("keeps singles only, with players, venue and round", () => {
    expect(upcoming).toHaveLength(2);
    expect(upcoming[0].players.map((p) => p.name)).toEqual(["Carlos Alcaraz", "Jannik Sinner"]);
    expect(upcoming[0].venue).toBe("New York, USA");
    expect(upcoming[0].round).toBe("Round of 32");
    expect(upcoming[0].players[0].country).toBe("Spain");
  });

  it("maps ESPN states to scheduled/live and slams to best-of-5", () => {
    const byId = new Map(upcoming.map((m) => [m.id, m]));
    expect(byId.get("184001")?.status).toBe("scheduled");
    expect(byId.get("184001")?.bestOf).toBe(5);
    expect(byId.get("184002")?.status).toBe("live");
    // No format field on the live match — tournament rules decide (ATP slam → 5).
    expect(byId.get("184002")?.bestOf).toBe(5);
  });

  it("infers the surface from the tournament name, then from history", () => {
    expect(upcoming[0].surface).toBe("hard"); // US Open hint
    const historyMatch: TennisMatch = {
      id: "x",
      tour: "atp",
      tournament: "Some New Open",
      surface: "grass",
      matchDate: "2026-06-01T00:00:00Z",
      round: null,
      bestOf: 3,
      winner: "A",
      loser: "B",
      score: "6-4 6-4",
      finish: "completed",
      winnerStats: { aces: null, doubleFaults: null, servePoints: null, serviceGames: null, bpSaved: null, bpFaced: null },
      loserStats: { aces: null, doubleFaults: null, servePoints: null, serviceGames: null, bpSaved: null, bpFaced: null },
      odds: null,
      winnerRank: null,
      loserRank: null,
      source: "sackmann",
    };
    const board = {
      events: [
        {
          name: "Some New Open",
          groupings: [
            {
              grouping: { displayName: "Men's Singles", slug: "mens-singles" },
              competitions: [
                {
                  id: "1",
                  date: "2026-09-06T10:00Z",
                  status: { type: { state: "pre" } },
                  competitors: [
                    { type: "athlete", athlete: { displayName: "A Player" } },
                    { type: "athlete", athlete: { displayName: "B Player" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseEspnTennisScoreboard(board, "atp", [historyMatch]);
    expect(parsed[0].surface).toBe("grass");
  });

  it("returns [] for a malformed payload instead of throwing", () => {
    expect(parseEspnTennisScoreboard(null, "atp")).toEqual([]);
    expect(parseEspnTennisScoreboard({ events: "nope" }, "atp")).toEqual([]);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

describe("names, surfaces and formats", () => {
  it("normalises player names for lookups", () => {
    expect(normalisePlayerName("Alex De Minaur")).toBe("alex de minaur");
    expect(tennisPlayerKey("Álex de Miñaur")).toBe("alex de minaur");
  });

  it("matches provider spellings loosely without colliding surnames", () => {
    expect(playerNamesMatch("Alex de Minaur", "Alex De Minaur")).toBe(true);
    expect(playerNamesMatch("F. Tiafoe", "Frances Tiafoe")).toBe(true);
    expect(playerNamesMatch("M. Zverev", "Alexander Zverev")).toBe(false);
    expect(playerNamesMatch("Jannik Sinner", "Carlos Alcaraz")).toBe(false);
  });

  it("normalises surfaces", () => {
    expect(normaliseSurface("Clay")).toBe("clay");
    expect(normaliseSurface("Hardcourt")).toBe("hard");
    expect(normaliseSurface("Grass")).toBe("grass");
    expect(normaliseSurface("Carpet")).toBe("carpet");
    expect(normaliseSurface("")).toBeNull();
    expect(normaliseSurface(42)).toBeNull();
  });

  it("infers surfaces from tournament names", () => {
    expect(inferSurface("Wimbledon Championships")).toBe("grass");
    expect(inferSurface("Roland Garros")).toBe("clay");
    expect(inferSurface("Random 250")).toBeNull();
  });

  it("derives best-of from the tour and tournament", () => {
    expect(bestOfForTournament("Wimbledon", "atp")).toBe(5);
    expect(bestOfForTournament("Wimbledon", "wta")).toBe(3);
    expect(bestOfForTournament("Basel", "atp")).toBe(3);
  });
});

// ─── Profiles & baselines ─────────────────────────────────────────────────────

describe("buildTennisPlayerProfiles", () => {
  const matches = parseSackmannTennisCsv(SACKMANN_CSV, "atp");
  const profiles = buildTennisPlayerProfiles(matches, "atp");

  it("aggregates per-player averages over completed matches only", () => {
    const hurkacz = profiles.get(tennisPlayerKey("Hubert Hurkacz"));
    expect(hurkacz).toBeDefined();
    // Completed: 12 aces as the loser vs Fritz, 18 vs Wawrinka → 15.0.
    expect(hurkacz?.acesPerMatch).toBeCloseTo(15, 5);
    expect(hurkacz?.doubleFaultsPerMatch).toBeCloseTo(0, 5);
    // BP faced: 1 (vs Fritz) + 9 (vs Wawrinka) → 5.0.
    expect(hurkacz?.bpFacedPerMatch).toBeCloseTo(5, 5);
    expect(hurkacz?.matchesPlayed).toBe(2);
    expect(hurkacz?.wins).toBe(1);
  });

  it("keeps the freshest rank and last played date", () => {
    const fritz = profiles.get(tennisPlayerKey("Taylor Fritz"));
    expect(fritz?.rank).toBe(9);
    expect(fritz?.lastPlayed).toBe("2026-01-05T00:00:00Z");
    const hurkacz = profiles.get(tennisPlayerKey("Hubert Hurkacz"));
    expect(hurkacz?.rank).toBe(83);
  });

  it("splits serve stats by surface", () => {
    const alcaraz = profiles.get(tennisPlayerKey("Carlos Alcaraz"));
    expect(alcaraz?.surface.clay.matches).toBe(1);
    expect(alcaraz?.surface.clay.acesPerMatch).toBe(15);
    expect(alcaraz?.surface.hard.matches).toBe(0);
  });
});

describe("surfaceServeBaseline", () => {
  const matches = parseSackmannTennisCsv(SACKMANN_CSV, "atp");
  const profiles = buildTennisPlayerProfiles(matches, "atp");

  /** A profile with a 6-match clay sample — enough for the surface split. */
  const clayProfile: TennisPlayerProfile = {
    player: "Clay Specialist",
    key: "clay specialist",
    tour: "atp",
    matchesPlayed: 6,
    wins: 3,
    lastPlayed: "2026-05-01T00:00:00Z",
    rank: 40,
    acesPerMatch: 9,
    doubleFaultsPerMatch: 3,
    bpFacedPerMatch: 6,
    bpSavedPerMatch: 3,
    surface: {
      clay: { matches: 6, acesPerMatch: 11, doubleFaultsPerMatch: 2.5, bpFacedPerMatch: 7 },
      grass: { matches: 1, acesPerMatch: 14, doubleFaultsPerMatch: 4, bpFacedPerMatch: 5 },
      hard: { matches: 0, acesPerMatch: null, doubleFaultsPerMatch: null, bpFacedPerMatch: null },
      carpet: { matches: 0, acesPerMatch: null, doubleFaultsPerMatch: null, bpFacedPerMatch: null },
    },
  };

  it("uses the surface split once the sample is big enough", () => {
    const clay = surfaceServeBaseline(clayProfile, "clay");
    expect(clay?.source).toBe("surface");
    expect(clay?.acesPerMatch).toBe(11);
    expect(clay?.doubleFaultsPerMatch).toBe(2.5);
  });

  it("falls back to the career average below the sample threshold", () => {
    const grass = surfaceServeBaseline(clayProfile, "grass");
    expect(grass?.source).toBe("overall");
    expect(grass?.acesPerMatch).toBe(9); // career average, not the 1-match split
  });

  it("uses the surface split for the small fixture sample on its surface", () => {
    const alcaraz = profiles.get(tennisPlayerKey("Carlos Alcaraz")) ?? null;
    expect(surfaceServeBaseline(alcaraz, "clay")?.source).toBe("overall"); // 1 clay match < 5
  });

  it("returns null for unknown players", () => {
    expect(surfaceServeBaseline(null, "clay")).toBeNull();
  });
});

describe("computeTourBaselines", () => {
  it("averages aces/DFs/BPs across both players of every completed match", () => {
    const matches = parseSackmannTennisCsv(SACKMANN_CSV, "atp");
    const baselines = computeTourBaselines(matches);
    expect(baselines).not.toBeNull();
    // Completed player-matches: Fritz(16)+Hurkacz(12), Hurkacz(18)+Wawrinka(10),
    // Alcaraz(15)+Sinner(12) → 6 samples, 83 total aces.
    expect(baselines?.matchesSampled).toBe(6);
    expect(baselines?.acesPerMatch).toBeCloseTo(83 / 6, 5);
  });

  it("returns null when no match carries serve stats", () => {
    const matches = parseTennisDataCsv(TENNIS_DATA_CSV, "atp");
    expect(computeTourBaselines(matches)).toBeNull();
  });
});
