// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FixtureLite } from "@/lib/espn";
import { TEAM_NAME_MAP, translateTeamName } from "@/lib/v4-predictor";

const fetchScoreboardMock = vi.fn();
const getCurrentMatchweekMock = vi.fn();
const fetchSummaryMock = vi.fn();
const runEngineMock = vi.fn();

vi.mock("@/lib/espn", () => ({
  fetchScoreboard: (...args: unknown[]) => fetchScoreboardMock(...args),
  getCurrentMatchweek: (...args: unknown[]) => getCurrentMatchweekMock(...args),
  fetchSummary: (...args: unknown[]) => fetchSummaryMock(...args),
}));

// The real engine needs a database; the route only needs its markets.
vi.mock("@/lib/engine/engine", () => ({
  runEngineFromRealWithProfiles: (...args: unknown[]) => runEngineMock(...args),
}));

/** Engine result with a home-win market and a matching top score. */
function engineResultWithTopScore(score: string) {
  return {
    match: { dataCompletenessScore: 70 },
    markets: [
      { family: "Goals", name: "Correct Score 0-0", selection: "Score 0-0", hitRate: 0.08 },
      { family: "Goals", name: score, selection: "Score 3-1", hitRate: 0.19 },
      { family: "Goals", name: "1X2", selection: "Home", hitRate: 0.6 },
    ],
  };
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
  runEngineMock.mockReset();
  runEngineMock.mockResolvedValue({ match: { dataCompletenessScore: 30 }, markets: [] });
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

describe("GET /api/v4-predictor/auto", () => {
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
    expect(body).toEqual({
      week: 10,
      fixtures: [
        { home: { name: "Man City", logo: "https://example.com/mancity.png" }, away: { name: "Hull", logo: "https://example.com/hull.png" }, state: "post", actual: [2, 0], enginePrediction: null, finalPrediction: "2-0", finalCategory: "SNIPE: Home Fortress" },
        { home: { name: "Spurs", logo: "https://example.com/spurs.png" }, away: { name: "Brighton", logo: "https://example.com/brighton.png" }, state: "post", actual: [0, 0], enginePrediction: null, finalPrediction: "1-2", finalCategory: "LOCK: Chaos Rule" },
        { home: { name: "Bournemouth", logo: null }, away: { name: "Newcastle", logo: null }, state: "pre", actual: null, enginePrediction: null, finalPrediction: "0-1", finalCategory: "LOCK: Standard vs Mid" },
      ],
    });
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
    expect(body).toEqual({
      week: 12,
      fixtures: [
        { home: { name: "Arsenal", logo: "https://example.com/arsenal.png" }, away: { name: "Man City", logo: "https://example.com/mancity.png" }, state: "pre", actual: null, enginePrediction: null, finalPrediction: "0-1", finalCategory: "SNIPE: Elite Away" },
      ],
    });
  });

  it("uses the engine for a non-snipe but skips it for a snipe", async () => {
    const summary = { venue: "Emirates" };
    fetchSummaryMock.mockResolvedValue(summary);
    fetchScoreboardMock.mockResolvedValue([
      makeFixture("m1", "2026-11-07T15:00:00Z", "Arsenal FC", "Chelsea FC", "pre", null, null, 8),
      makeFixture("m2", "2026-11-08T15:00:00Z", "Everton FC", "Leeds United FC", "pre", null, null, 8),
    ]);
    runEngineMock
      .mockResolvedValueOnce(engineResultWithTopScore("Correct Score 3-1"));

    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    const response = await GET(new Request("http://localhost:3000/api/v4-predictor/auto?week=8"));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(fetchSummaryMock).toHaveBeenCalledWith("eng.1", "m1");
    expect(runEngineMock).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }), summary);
    expect(body.fixtures.map((f: { enginePrediction: string | null }) => f.enginePrediction)).toEqual(["3-1", null]);
    expect(body.fixtures.map((f: { finalPrediction: string }) => f.finalPrediction)).toEqual(["3-1", "1-1"]);
    expect(runEngineMock).toHaveBeenCalledTimes(1);
  });

  it("returns enginePrediction null for a fixture when the engine or summary fails, without failing the request", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchScoreboardMock.mockResolvedValue([
      makeFixture("m1", "2026-11-07T15:00:00Z", "Arsenal FC", "Chelsea FC", "pre", null, null, 8),
    ]);
    runEngineMock.mockRejectedValue(new Error("engine down"));

    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    const response = await GET(new Request("http://localhost:3000/api/v4-predictor/auto?week=8"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.fixtures[0].enginePrediction).toBeNull();

    errSpy.mockRestore();
  });

  it("returns 400 when week parameter is invalid", async () => {
    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    for (const bad of ["0", "39", "abc", "-1"]) {
      const response = await GET(new Request(`http://localhost:3000/api/v4-predictor/auto?week=${bad}`));
      expect(response.status).toBe(400);
    }
  });

  it("propagates scoreboard fetch errors to Next.js", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchScoreboardMock.mockRejectedValue(new Error("ESPN down"));

    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    await expect(GET(new Request("http://localhost:3000/api/v4-predictor/auto"))).rejects.toThrow("ESPN down");

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
        { home: { name: "Man City", logo: "https://example.com/mancity.png" }, away: { name: "Hull", logo: "https://example.com/hull.png" }, state: "post", actual: [2, 0] },
        { home: { name: "Spurs", logo: "https://example.com/spurs.png" }, away: { name: "Brighton", logo: "https://example.com/brighton.png" }, state: "pre", actual: null },
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
              { home: { name: "Arsenal", logo: "https://example.com/arsenal.png" }, away: { name: "Hull", logo: "https://example.com/hull.png" }, state: "post", actual: [2, 0] },
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

    // Predictions populated with V4 rules applied to translated team names
    expect(container.textContent).toContain("Man City vs Hull");
    expect(container.textContent).toContain("SNIPE: Home Fortress");
    expect(container.textContent).toContain("Spurs vs Brighton");
    expect(container.textContent).toContain("LOCK: Chaos Rule");
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
            fixtures: [{ home: { name: "Man City", logo: "https://example.com/mancity.png" }, away: { name: "Fulham", logo: "https://example.com/fulham.png" }, state: "pre", actual: null }],
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
          fixtures: [{ home: { name: "Arsenal", logo: "https://example.com/arsenal.png" }, away: { name: "Hull", logo: "https://example.com/hull.png" }, state: "post", actual: [2, 0] }],
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
              { home: { name: "Arsenal", logo: "https://example.com/arsenal.png" }, away: { name: "Hull", logo: "https://example.com/hull.png" }, state: "in", actual: null },
              { home: { name: "Fulham", logo: "https://example.com/fulham.png" }, away: { name: "Brentford", logo: "https://example.com/brentford.png" }, state: "post", actual: [2, 0] },
              { home: { name: "Chelsea", logo: "https://example.com/chelsea.png" }, away: { name: "Leeds", logo: "https://example.com/leeds.png" }, state: "post", actual: [0, 1] },
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

    // Fulham vs Brentford: Mid_Table_Deadlock SNIPE 1-1, actual 2-0 -> missed (0)
    // Chelsea vs Leeds: Chaos 2-2, actual 0-1 -> missed (0) => total 0
    expect(container.textContent).toContain("TOTAL SCORE: 0 / 200");
    const missedPoints = Array.from(container.querySelectorAll("span")).find((s) => s.textContent?.includes("❌"));
    expect(missedPoints?.className).toContain("text-red-400");
    expect(missedPoints?.className).toContain("font-bold");
  });
});
