// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FixtureLite } from "@/lib/espn";
import { buildCorrectScoreGrid, DIXON_COLES_RHO, pickBestScoreForOutcome } from "@/lib/engine/markets";
import { TEAM_NAME_MAP, translateTeamName } from "@/lib/v4-predictor";

const fetchScoreboardMock = vi.fn();
const getCurrentMatchweekMock = vi.fn();
const fetchSummaryMock = vi.fn();
const buildHistoricalTeamFormMock = vi.fn();
const runEngineMock = vi.fn();

vi.mock("@/lib/espn", () => ({
  fetchScoreboard: (...args: unknown[]) => fetchScoreboardMock(...args),
  getCurrentMatchweek: (...args: unknown[]) => getCurrentMatchweekMock(...args),
  fetchSummary: (...args: unknown[]) => fetchSummaryMock(...args),
}));

vi.mock("@/lib/engine/sofascore", () => ({
  buildHistoricalTeamForm: (...args: unknown[]) => buildHistoricalTeamFormMock(...args),
}));

// The real engine needs a database; the route only needs its markets.
vi.mock("@/lib/engine", () => ({
  runEngineFromRealWithProfiles: (...args: unknown[]) => runEngineMock(...args),
}));

/**
 * Engine-shaped result priced off the same Dixon–Coles grid the real
 * MarketEngine publishes (1X2 split + Correct Score cells + lambdas), so the
 * route can read probabilities exactly as it does in production.
 */
function engineResult(
  homeTeam: string,
  awayTeam: string,
  homeLambda: number,
  awayLambda: number,
  completeness = 82,
) {
  const grid = buildCorrectScoreGrid(homeLambda, awayLambda, DIXON_COLES_RHO);
  return {
    match: { homeTeam, awayTeam, dataCompletenessScore: completeness },
    lambdas: { "λ Home Goals": homeLambda, "λ Away Goals": awayLambda },
    markets: [
      { family: "Goals", name: `Match Result: ${homeTeam} Win`, selection: `${homeTeam} Win`, hitRate: grid.outcome.home },
      { family: "Goals", name: "Match Result: Draw", selection: "Draw", hitRate: grid.outcome.draw },
      { family: "Goals", name: `Match Result: ${awayTeam} Win`, selection: `${awayTeam} Win`, hitRate: grid.outcome.away },
      ...grid.cells
        .filter((cell) => cell.homeGoals <= 3 && cell.awayGoals <= 3)
        .map((cell) => ({
          family: "Goals",
          name: `Correct Score ${cell.homeGoals}-${cell.awayGoals}`,
          selection: `Score ${cell.homeGoals}-${cell.awayGoals}`,
          hitRate: cell.probability,
        })),
    ],
  };
}

/** The λ pair the mocked Engine returns for a given fixture. */
function lambdasFor(home: string, away: string): [number, number] {
  const table: Record<string, [number, number]> = {
    "Arsenal FC|Chelsea FC": [2.2, 0.6],
    "Tottenham Hotspur FC|Aston Villa FC": [1.0, 1.0],
    "Everton FC|Leeds United FC": [1.0, 1.0],
    "Tottenham Hotspur FC|Ipswich Town FC": [0.7, 1.8],
    "Hull City AFC|Liverpool FC": [0.6, 2.0],
  };
  return table[`${home}|${away}`] ?? [1.35, 1.15];
}

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function makeFixture(
  id: string,
  date: string,
  homeName: string,
  awayName: string,
  state: "pre" | "in" | "post",
  homeScore: string | null = null,
  awayScore: string | null = null,
  matchweek?: number,
  homeLogo: string | null = null,
  awayLogo: string | null = null,
): FixtureLite {
  return {
    id,
    leagueSlug: "eng.1",
    leagueName: "Premier League",
    date,
    state,
    statusDetail: state === "post" ? "FT" : "Scheduled",
    venue: null,
    neutralSite: false,
    home: {
      id: `${id}-h`,
      name: homeName,
      shortName: homeName,
      abbrev: homeName.slice(0, 3).toUpperCase(),
      logo: homeLogo,
      color: null,
      score: homeScore,
      homeAway: "home",
    },
    away: {
      id: `${id}-a`,
      name: awayName,
      shortName: awayName,
      abbrev: awayName.slice(0, 3).toUpperCase(),
      logo: awayLogo,
      color: null,
      score: awayScore,
      homeAway: "away",
    },
    ...(matchweek !== undefined ? { matchweek } : {}),
  };
}

beforeEach(() => {
  fetchScoreboardMock.mockReset();
  getCurrentMatchweekMock.mockReset();
  getCurrentMatchweekMock.mockResolvedValue(11);
  fetchSummaryMock.mockReset();
  fetchSummaryMock.mockResolvedValue(null);
  buildHistoricalTeamFormMock.mockReset();
  buildHistoricalTeamFormMock.mockResolvedValue(null);
  runEngineMock.mockReset();
  runEngineMock.mockImplementation(
    async (fx: FixtureLite) => engineResult(fx.home.name, fx.away.name, ...lambdasFor(fx.home.name, fx.away.name)),
  );
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("V4 team name translation", () => {
  it("translates ESPN full names to V4 short names and passes through others", () => {
    expect(TEAM_NAME_MAP["Manchester City"]).toBe("Man City");
    expect(translateTeamName("Manchester City")).toBe("Man City");
    expect(translateTeamName("Manchester United")).toBe("Man Utd");
    expect(translateTeamName("Tottenham Hotspur")).toBe("Spurs");
    expect(translateTeamName("Brighton & Hove Albion")).toBe("Brighton");
    expect(translateTeamName("Newcastle United")).toBe("Newcastle");
    expect(translateTeamName("Nottingham Forest")).toBe("Nott'm Forest");
    expect(translateTeamName("Leeds United")).toBe("Leeds");
    expect(translateTeamName("Coventry City")).toBe("Coventry");
    expect(translateTeamName("Hull City")).toBe("Hull");
    expect(translateTeamName("Ipswich Town")).toBe("Ipswich");
    expect(translateTeamName("Arsenal")).toBe("Arsenal");
  });
});

describe("GET /api/v4-predictor/auto — Portfolio Tranching", () => {
  it("accepts ?week=X, passes week to fetchScoreboard, translates names, extracts logos and actual scores", async () => {
    fetchScoreboardMock.mockResolvedValue([
      makeFixture("other", "2026-11-21T15:00:00Z", "Arsenal FC", "Chelsea FC", "pre", null, null, 11, "https://example.com/arsenal.png", "https://example.com/chelsea.png"),
      makeFixture("m2", "2026-11-08T16:30:00Z", "Tottenham Hotspur FC", "Brighton & Hove Albion FC", "post", "0", "0", 10, "https://example.com/spurs.png", "https://example.com/brighton.png"),
      makeFixture("m1", "2026-11-07T15:00:00Z", "Manchester City FC", "Hull City AFC", "post", "2", "0", 10, "https://example.com/mancity.png", "https://example.com/hull.png"),
      makeFixture("m3", "2026-11-09T20:00:00Z", "AFC Bournemouth", "Newcastle United FC", "pre", "0", "0", 10),
    ]);

    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    const response = await GET(new Request("http://localhost:3000/api/v4-predictor/auto?week=10"));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(fetchScoreboardMock).toHaveBeenCalledWith("eng.1", undefined, 10);
    expect(body.week).toBe(10);
    expect(body.fixtures.map((f: { home: { name: string }; away: { name: string }; state: string; actual: number[] | null }) => [
      f.home.name, f.away.name, f.state, f.actual,
    ])).toEqual([
      ["Man City", "Hull", "post", [2, 0]],
      ["Spurs", "Brighton", "post", [0, 0]],
      ["Bournemouth", "Newcastle", "pre", null],
    ]);
    expect(body.fixtures[0].home.logo).toBe("https://example.com/mancity.png");
    expect(body.fixtures[2].home.logo).toBeNull();

    // Every row is tranched: a safe favourite or a draw snipe.
    for (const row of body.fixtures) {
      expect(row.category).toMatch(/^(FLOOR: (Home|Away) Win|CEILING: Draw Snipe)$/);
      expect(row.prediction).toMatch(/^\d{1,2}-\d{1,2}$/);
      expect(["FLOOR", "CEILING"]).toContain(row.tranche);
      expect(row.probabilities.home + row.probabilities.draw + row.probabilities.away).toBeCloseTo(1, 2);
    }
    // Man City (default λ 1.35 / 1.15) floors as a Home win; the toss-up Spurs
    // fixture against Brighton (same λ pair) is a 1-0 / draw away from it.
    expect(body.fixtures[0]).toMatchObject({ category: "FLOOR: Home Win", prediction: "1-0" });
  });

  it("uses current matchweek when ?week is omitted", async () => {
    getCurrentMatchweekMock.mockResolvedValue(12);
    fetchScoreboardMock.mockResolvedValue([
      makeFixture("m1", "2026-11-28T15:00:00Z", "Arsenal", "Manchester City", "pre", null, null, undefined, "https://example.com/arsenal.png", "https://example.com/mancity.png"),
    ]);

    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    const response = await GET(new Request("http://localhost:3000/api/v4-predictor/auto"));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(getCurrentMatchweekMock).toHaveBeenCalledWith("eng.1");
    expect(fetchScoreboardMock).toHaveBeenCalledWith("eng.1", undefined, 12);
    expect(body.week).toBe(12);
    expect(body.fixtures).toHaveLength(1);
    expect(body.fixtures[0]).toMatchObject({
      home: { name: "Arsenal", logo: "https://example.com/arsenal.png" },
      away: { name: "Man City", logo: "https://example.com/mancity.png" },
      state: "pre",
      actual: null,
      category: "FLOOR: Home Win",
      tranche: "FLOOR",
    });
  });

  it("runs the Engine on every fixture and splits the slate into floor and ceiling tranches", async () => {
    const summary = { venue: "Emirates" };
    fetchSummaryMock.mockResolvedValue(summary);
    // Ten fixtures: eight lopsided favourites plus two true toss-ups.
    const names: Array<[string, string]> = [
      ["Arsenal FC", "Chelsea FC"],
      ["Manchester City FC", "Hull City AFC"],
      ["Liverpool FC", "Coventry City FC"],
      ["Newcastle United FC", "Burnley FC"],
      ["Aston Villa FC", "Sunderland FC"],
      ["Brighton & Hove Albion FC", "Ipswich Town FC"],
      ["Fulham FC", "Brentford FC"],
      ["Everton FC", "Leeds United FC"],
      ["Tottenham Hotspur FC", "Aston Villa FC"],
      ["Wolverhampton Wanderers FC", "West Ham United FC"],
    ];
    const lambdaTable: Record<string, [number, number]> = {
      "Arsenal FC|Chelsea FC": [2.4, 0.5],
      "Manchester City FC|Hull City AFC": [2.2, 0.6],
      "Liverpool FC|Coventry City FC": [2.1, 0.7],
      "Newcastle United FC|Burnley FC": [0.6, 2.0],
      "Aston Villa FC|Sunderland FC": [0.7, 1.9],
      "Brighton & Hove Albion FC|Ipswich Town FC": [1.8, 0.8],
      "Fulham FC|Brentford FC": [0.8, 1.8],
      "Everton FC|Leeds United FC": [1.7, 0.9],
      "Tottenham Hotspur FC|Aston Villa FC": [1.0, 1.0],
      "Wolverhampton Wanderers FC|West Ham United FC": [1.0, 1.0],
    };
    fetchScoreboardMock.mockResolvedValue(
      names.map(([home, away], i) =>
        makeFixture(`m${i}`, `2026-11-0${1 + Math.floor(i / 3)}T1${i % 9}:00:00Z`, home, away, "pre", null, null, 8),
      ),
    );
    runEngineMock.mockImplementation(async (fx: FixtureLite) => {
      const pair = lambdaTable[`${fx.home.name}|${fx.away.name}`] ?? [1.35, 1.15];
      return engineResult(fx.home.name, fx.away.name, pair[0], pair[1]);
    });

    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    const response = await GET(new Request("http://localhost:3000/api/v4-predictor/auto?week=8"));
    expect(response.status).toBe(200);
    const body = await response.json();

    // The Engine runs on all ten fixtures — no static-rule bypass.
    expect(runEngineMock).toHaveBeenCalledTimes(10);
    expect(fetchSummaryMock).toHaveBeenCalledTimes(10);
    expect(body.fixtures).toHaveLength(10);

    const floor = body.fixtures.filter((f: { tranche: string }) => f.tranche === "FLOOR");
    const ceiling = body.fixtures.filter((f: { tranche: string }) => f.tranche === "CEILING");
    expect(floor).toHaveLength(8);
    expect(ceiling).toHaveLength(2);

    // Ceiling: the two coin-flips, sniped as the modal draw (0-0 at λ = 1 / 1).
    for (const row of ceiling) {
      expect(row.category).toBe("CEILING: Draw Snipe");
      expect(row.prediction).toBe("0-0");
      expect(row.probabilities.draw).toBeGreaterThanOrEqual(0.29);
    }
    expect(ceiling.map((r: { home: { name: string } }) => r.home.name).sort()).toEqual(["Spurs", "Wolves"]);

    // Floor: modal scoreline inside the favourite's outcome.
    for (const row of floor) {
      const homeFav = row.probabilities.home > row.probabilities.away;
      expect(row.category).toBe(`FLOOR: ${homeFav ? "Home" : "Away"} Win`);
      const [h, a] = row.prediction.split("-").map(Number);
      if (homeFav) expect(h).toBeGreaterThan(a);
      else expect(h).toBeLessThan(a);
    }
    // Arsenal (2.4 vs 0.5) is the biggest favourite: modal Home win is 2-0.
    const arsenal = body.fixtures.find((f: { home: { name: string } }) => f.home.name === "Arsenal");
    expect(arsenal).toMatchObject({ category: "FLOOR: Home Win", prediction: "2-0" });
    // Newell-to-Burnley is the strongest away favourite: 0-1 or 0-2.
    const newcastle = body.fixtures.find((f: { home: { name: string } }) => f.home.name === "Newcastle");
    expect(newcastle.category).toBe("FLOOR: Away Win");
    expect(newcastle.prediction.startsWith("0-")).toBe(true);
  });

  it("anchors upcoming fixtures to the bookmaker odds and strips them for finished ones", async () => {
    const odds = { homeML: -180, drawML: 320, awayML: 520, provider: "ESPN BET" };
    fetchScoreboardMock.mockResolvedValue([
      makeFixture("pre-1", "2026-11-07T15:00:00Z", "Arsenal FC", "Chelsea FC", "pre", null, null, 8),
      makeFixture("post-1", "2026-11-01T15:00:00Z", "Everton FC", "Leeds United FC", "post", "1", "1", 8),
    ]);
    fetchSummaryMock.mockImplementation(async (_slug: string, id: string) => ({
      venue: id === "pre-1" ? "Emirates" : "Goodison Park",
      odds,
    }));

    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    const response = await GET(new Request("http://localhost:3000/api/v4-predictor/auto?week=8"));
    expect(response.status).toBe(200);
    await response.json();

    const byId = new Map(
      runEngineMock.mock.calls.map(([fx, summary]) => [(fx as FixtureLite).id, { fx, summary }]),
    );
    const upcoming = byId.get("pre-1")! as { fx: { odds: unknown }; summary: { odds: unknown } };
    expect(upcoming.fx.odds).toMatchObject({ homeML: -180 });
    expect(upcoming.summary.odds).toMatchObject({ homeML: -180 });

    const finished = byId.get("post-1")! as { fx: { odds: unknown }; summary: { odds: unknown } };
    expect(finished.fx.odds).toBeNull();
    expect(finished.summary.odds).toBeNull();
  });

  it("isolates a finished fixture while preserving its scorecard result", async () => {
    const fixture = makeFixture("m1", "2020-08-15T15:00:00Z", "Arsenal FC", "Chelsea FC", "post", "4", "2", 1);
    fetchScoreboardMock.mockResolvedValue([fixture]);
    const game = (date: string, scoreFor: number) => ({ date, scoreFor, scoreAgainst: 1, result: "W" });
    fetchSummaryMock.mockResolvedValue({
      venue: "Emirates", odds: { homeML: -100 }, boxscore: { homeCorners: 12 }, __homeXg: 5,
      // Polluted today's lastFiveGames — must be ignored for finished ("post") fixtures!
      homeForm: { teamId: "a", teamName: "Arsenal", games: [game("2020-09-01T15:00:00Z", 10)], gfAvg: 10, gaAvg: 1, points: 3 },
      awayForm: { teamId: "c", teamName: "Chelsea", games: [game("2020-09-01T15:00:00Z", 8)], gfAvg: 8, gaAvg: 0, points: 3 },
      h2h: [{ date: "2020-08-01T15:00:00Z", score: "1 - 0" }, { date: "2020-08-15T15:00:00Z", score: "4 - 2" }],
      homeLineup: [{ starter: true }], awayLineup: [{ starter: true }], lineupAvailable: true,
      homeFormation: "4-4-2", awayFormation: "4-3-3",
    });
    buildHistoricalTeamFormMock.mockImplementation(async (teamName: string) => {
      if (teamName === "Arsenal FC") {
        return { teamId: "a", teamName: "Arsenal", games: [game("2020-08-01T15:00:00Z", 2)], gfAvg: 2, gaAvg: 1, points: 3 };
      }
      return null;
    });
    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    const response = await GET(new Request("http://localhost/api/v4-predictor/auto?week=1"));
    const body = await response.json();
    expect(body.fixtures[0].actual).toEqual([4, 2]);
    expect(buildHistoricalTeamFormMock).toHaveBeenCalledWith("Arsenal FC", "eng.1", fixture.date);
    expect(buildHistoricalTeamFormMock).toHaveBeenCalledWith("Chelsea FC", "eng.1", fixture.date);
    const [fx, summary, , , cutoff] = runEngineMock.mock.calls[0];
    expect(fx).toMatchObject({ state: "pre", statusDetail: "", odds: null, home: { score: null }, away: { score: null } });
    expect(cutoff).toBe(fixture.date);
    expect(summary).toMatchObject({ boxscore: null, odds: null, lineupAvailable: false, homeFormation: null,
      homeForm: { gfAvg: 2, gaAvg: 1, points: 3, games: [game("2020-08-01T15:00:00Z", 2)] },
      awayForm: null,
      h2h: [{ date: "2020-08-01T15:00:00Z", score: "1 - 0" }] });
    expect(summary).not.toHaveProperty("__homeXg");
    expect(fixture.home.score).toBe("4");
    // Finished fixtures are priced too — the tranching engine covers the slate.
    expect(body.fixtures[0].category).toBe("FLOOR: Home Win");
    expect(body.fixtures[0].prediction).toBe("2-0");
  });

  it("prices every fixture from the model when the engine throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchScoreboardMock.mockResolvedValue([
      makeFixture("m1", "2026-11-07T15:00:00Z", "Arsenal FC", "Chelsea FC", "pre", null, null, 8),
      makeFixture("m2", "2026-11-07T17:30:00Z", "Tottenham Hotspur FC", "Ipswich Town FC", "pre", null, null, 8),
    ]);
    runEngineMock.mockRejectedValue(new Error("engine down"));

    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    const response = await GET(new Request("http://localhost:3000/api/v4-predictor/auto?week=8"));
    expect(response.status).toBe(200);
    const body = await response.json();

    // Model-only pricing (λ 1.35 / 1.15): every row is still tranched.
    expect(body.fixtures).toHaveLength(2);
    for (const row of body.fixtures) {
      expect(row.category).toBe("FLOOR: Home Win");
      expect(row.prediction).toBe("1-0");
      expect(row.tranche).toBe("FLOOR");
    }
    errSpy.mockRestore();
  });

  it("returns 400 when week parameter is invalid", async () => {
    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    for (const bad of ["0", "39", "abc", "-1"]) {
      const response = await GET(new Request(`http://localhost:3000/api/v4-predictor/auto?week=${bad}`));
      expect(response.status).toBe(400);
    }
  });

  it("returns 500 with { error: 'Failed to fetch' } when fetching throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchScoreboardMock.mockRejectedValue(new Error("ESPN down"));

    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    const response = await GET(new Request("http://localhost:3000/api/v4-predictor/auto"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to fetch" });

    errSpy.mockRestore();
  });
});

describe("V4PredictorPage auto-dashboard", () => {
  it("renders 1-38 dropdown, auto-fetches ?week=11 on mount, has zero inputs and no manual buttons, shows logos, FT/UPCOMING badges, predictions and scorecard", async () => {
    let resolveInitial!: (value: Response) => void;
    const requestedUrls: string[] = [];
    let week11Calls = 0;

    const week11Body = {
      week: 11,
      fixtures: [
        { home: { name: "Man City", logo: "https://example.com/mancity.png" }, away: { name: "Hull", logo: "https://example.com/hull.png" }, state: "post", actual: [2, 0], prediction: "2-0", category: "FLOOR: Home Win", tranche: "FLOOR" },
        { home: { name: "Spurs", logo: "https://example.com/spurs.png" }, away: { name: "Brighton", logo: "https://example.com/brighton.png" }, state: "pre", actual: null, prediction: "1-2", category: "FLOOR: Away Win", tranche: "FLOOR" },
      ],
    };

    const fetchMock = vi.fn((url: string) => {
      requestedUrls.push(url);
      if (url === "/api/v4-predictor/auto?week=11") {
        week11Calls += 1;
        if (week11Calls === 1) {
          return new Promise<Response>((resolve) => {
            resolveInitial = resolve;
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => week11Body,
        } as unknown as Response);
      }
      if (url === "/api/v4-predictor/auto?week=10") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            week: 10,
            fixtures: [
              { home: { name: "Arsenal", logo: "https://example.com/arsenal.png" }, away: { name: "Hull", logo: "https://example.com/hull.png" }, state: "post", actual: [2, 0], prediction: "2-0", category: "FLOOR: Home Win", tranche: "FLOOR" },
            ],
          }),
        } as unknown as Response);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { default: V4PredictorPage } = await import("./page");
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<V4PredictorPage />);
    });

    const select = container.querySelector('select[aria-label="Select Matchweek"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.options).toHaveLength(38);
    expect(select.options[0].value).toBe("1");
    expect(select.options[37].value).toBe("38");
    expect(select.value).toBe("11");

    // Zero manual inputs and no manual action buttons
    expect(container.querySelectorAll("input")).toHaveLength(0);
    const buttonTexts = Array.from(container.querySelectorAll("button")).map((b) => b.textContent?.trim() ?? "");
    expect(buttonTexts).not.toContain("Generate Predictions");
    expect(buttonTexts).not.toContain("Refresh Fixtures");
    expect(buttonTexts).not.toContain("Calculate Score");
    expect(container.textContent).not.toContain("Generate Predictions");
    expect(container.textContent).not.toContain("Refresh Fixtures");
    expect(container.textContent).not.toContain("Calculate Score");

    expect(requestedUrls).toContain("/api/v4-predictor/auto?week=11");
    expect(container.textContent).toContain("Loading real fixtures...");

    await act(async () => {
      resolveInitial({
        ok: true,
        status: 200,
        json: async () => week11Body,
      } as unknown as Response);
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Loading real fixtures...");
    expect(container.querySelectorAll("input")).toHaveLength(0);

    // Status badges
    expect(container.textContent).toContain("FT");
    expect(container.textContent).toContain("UPCOMING");
    const ftBadge = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === "FT");
    expect(ftBadge?.className).toContain("bg-slate-800");
    expect(ftBadge?.className).toContain("text-slate-300");
    const upcomingBadge = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === "UPCOMING");
    expect(upcomingBadge?.className).toContain("bg-amber-500/20");
    expect(upcomingBadge?.className).toContain("text-amber-400");

    // Team logos via TeamBadge (next/image renders <img alt=name>)
    const images = Array.from(container.querySelectorAll("img"));
    expect(images.some((img) => img.getAttribute("alt") === "Man City")).toBe(true);
    expect(images.some((img) => img.getAttribute("alt") === "Hull")).toBe(true);
    expect(images.some((img) => (img.getAttribute("src") ?? "").includes("mancity.png"))).toBe(true);

    // Predictions populated by the tranching engine (translated team names)
    expect(container.textContent).toContain("Man City vs Hull");
    expect(container.textContent).toContain("FLOOR: Home Win");
    expect(container.textContent).toContain("Spurs vs Brighton");
    expect(container.textContent).toContain("FLOOR: Away Win");
    expect(container.textContent).toContain("2-0");

    // Scorecard populated automatically for the finished match (2-0 vs 2-0 = 20 pts)
    expect(container.textContent).toContain("TOTAL SCORE: 20 / 200");
    expect(container.textContent).toContain("🎯");
    const totalEl = Array.from(container.querySelectorAll("span")).find((s) => s.textContent?.includes("TOTAL SCORE:"));
    expect(totalEl?.className).toContain("text-amber-400");
    const exactPoints = Array.from(container.querySelectorAll("span")).find((s) => s.textContent?.includes("🎯"));
    expect(exactPoints?.className).toContain("text-green-400");
    expect(exactPoints?.className).toContain("font-bold");

    // Change dropdown to Matchweek 10
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "10");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(requestedUrls).toContain("/api/v4-predictor/auto?week=10");
    expect(select.value).toBe("10");
    expect(container.textContent).toContain("Arsenal vs Hull");
    expect(container.textContent).toContain("TOTAL SCORE: 20 / 200");
    expect(container.querySelectorAll("input")).toHaveLength(0);

    // Change dropdown back to Matchweek 11
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "11");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(requestedUrls).toContain("/api/v4-predictor/auto?week=11");
    expect(container.textContent).toContain("Man City vs Hull");
    expect(requestedUrls.filter((u) => u === "/api/v4-predictor/auto?week=11")).toHaveLength(2);
  });

  it("shows Loading real fixtures... while switching matchweeks and shows UPCOMING with no scorecard for pre-only week", async () => {
    let resolveMw10!: (value: Response) => void;

    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/v4-predictor/auto?week=11") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            week: 11,
            fixtures: [{ home: { name: "Man City", logo: "https://example.com/mancity.png" }, away: { name: "Fulham", logo: "https://example.com/fulham.png" }, state: "pre", actual: null, prediction: "2-0", category: "FLOOR: Home Win", tranche: "FLOOR" }],
          }),
        } as unknown as Response);
      }
      if (url === "/api/v4-predictor/auto?week=10") {
        return new Promise<Response>((resolve) => {
          resolveMw10 = resolve;
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { default: V4PredictorPage } = await import("./page");
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<V4PredictorPage />);
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Loading real fixtures...");
    expect(container.textContent).toContain("UPCOMING");
    expect(container.textContent).not.toContain("TOTAL SCORE:");
    expect(container.querySelectorAll("input")).toHaveLength(0);
    const images = Array.from(container.querySelectorAll("img"));
    expect(images.some((img) => img.getAttribute("alt") === "Man City")).toBe(true);
    expect(images.some((img) => img.getAttribute("alt") === "Fulham")).toBe(true);

    const select = container.querySelector('select[aria-label="Select Matchweek"]') as HTMLSelectElement;

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "10");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.textContent).toContain("Loading real fixtures...");

    await act(async () => {
      resolveMw10({
        ok: true,
        status: 200,
        json: async () => ({
          week: 10,
          fixtures: [{ home: { name: "Arsenal", logo: "https://example.com/arsenal.png" }, away: { name: "Hull", logo: "https://example.com/hull.png" }, state: "post", actual: [2, 0], prediction: "2-0", category: "FLOOR: Home Win", tranche: "FLOOR" }],
        }),
      } as unknown as Response);
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Loading real fixtures...");
    expect(container.textContent).toContain("Arsenal vs Hull");
    expect(container.textContent).toContain("FT");
    expect(container.textContent).toContain("TOTAL SCORE: 20 / 200");
  });

  it("renders LIVE badge for in-play matches and outcome/missed points styling", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/v4-predictor/auto?week=11") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            week: 11,
            fixtures: [
              { home: { name: "Arsenal", logo: "https://example.com/arsenal.png" }, away: { name: "Hull", logo: "https://example.com/hull.png" }, state: "in", actual: null, prediction: "2-0", category: "FLOOR: Home Win", tranche: "FLOOR" },
              { home: { name: "Fulham", logo: "https://example.com/fulham.png" }, away: { name: "Brentford", logo: "https://example.com/brentford.png" }, state: "post", actual: [2, 0], prediction: "1-1", category: "CEILING: Draw Snipe", tranche: "CEILING" },
              { home: { name: "Chelsea", logo: "https://example.com/chelsea.png" }, away: { name: "Leeds", logo: "https://example.com/leeds.png" }, state: "post", actual: [0, 1], prediction: "1-1", category: "CEILING: Draw Snipe", tranche: "CEILING" },
            ],
          }),
        } as unknown as Response);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { default: V4PredictorPage } = await import("./page");
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<V4PredictorPage />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("LIVE");
    const liveBadge = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === "LIVE");
    expect(liveBadge?.className).toContain("bg-red-500/20");
    expect(liveBadge?.className).toContain("text-red-400");
    expect(liveBadge?.className).toContain("animate-pulse");

    // Fulham vs Brentford: ceiling draw snipe 1-1, actual 2-0 -> missed (0)
    // Chelsea vs Leeds: ceiling draw snipe 1-1, actual 0-1 -> missed (0) => total 0
    expect(container.textContent).toContain("TOTAL SCORE: 0 / 200");
    const missedPoints = Array.from(container.querySelectorAll("span")).find((s) => s.textContent?.includes("❌"));
    expect(missedPoints?.className).toContain("text-red-400");
    expect(missedPoints?.className).toContain("font-bold");
  });

  it("renders Portfolio Tranching picks (floor wins + a ceiling draw snipe) and scores accurately", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/v4-predictor/auto?week=11") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            week: 11,
            fixtures: [
              {
                home: { name: "Arsenal", logo: null },
                away: { name: "Coventry", logo: null },
                state: "post",
                actual: [2, 0],
                prediction: "2-0",
                category: "FLOOR: Home Win",
                enginePrediction: "2-0",
              },
              {
                home: { name: "Chelsea", logo: null },
                away: { name: "Spurs", logo: null },
                state: "post",
                actual: [2, 1],
                prediction: "2-1",
                category: "FLOOR: Home Win",
                enginePrediction: "2-1",
              },
              {
                home: { name: "Spurs", logo: null },
                away: { name: "Aston Villa", logo: null },
                state: "post",
                actual: [0, 2],
                prediction: "0-2",
                category: "FLOOR: Away Win",
                enginePrediction: "0-2",
              },
              {
                home: { name: "Wolves", logo: null },
                away: { name: "West Ham", logo: null },
                state: "post",
                actual: [1, 1],
                prediction: "1-1",
                category: "CEILING: Draw Snipe",
                enginePrediction: "1-1",
              },
            ],
          }),
        } as unknown as Response);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { default: V4PredictorPage } = await import("./page");
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<V4PredictorPage />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("FLOOR: Home Win");
    expect(container.textContent).toContain("FLOOR: Away Win");
    expect(container.textContent).toContain("CEILING: Draw Snipe");
    expect(container.textContent).toContain("2-1");
    expect(container.textContent).toContain("0-2");
    // 2-0 exact (20) + 2-1 exact (20) + 0-2 exact (20) + 1-1 exact (20) = 80.
    expect(container.textContent).toContain("TOTAL SCORE: 80 / 200");
  });
});
