// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FixtureLite } from "@/lib/espn";
import { TEAM_NAME_MAP, translateTeamName } from "@/lib/v4-predictor";

const fetchScoreboardMock = vi.fn();
const getCurrentMatchweekMock = vi.fn();

vi.mock("@/lib/espn", () => ({
  fetchScoreboard: (...args: unknown[]) => fetchScoreboardMock(...args),
  getCurrentMatchweek: (...args: unknown[]) => getCurrentMatchweekMock(...args),
}));

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
      logo: null,
      color: null,
      score: homeScore,
      homeAway: "home",
    },
    away: {
      id: `${id}-a`,
      name: awayName,
      shortName: awayName,
      abbrev: awayName.slice(0, 3).toUpperCase(),
      logo: null,
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
  it("accepts ?week=X, passes week to fetchScoreboard, translates names, and extracts actual scores", async () => {
    fetchScoreboardMock.mockResolvedValue([
      makeFixture("other", "2026-11-21T15:00:00Z", "Arsenal FC", "Chelsea FC", "pre", null, null, 11),
      makeFixture("m2", "2026-11-08T16:30:00Z", "Tottenham Hotspur FC", "Brighton & Hove Albion FC", "post", "0", "0", 10),
      makeFixture("m1", "2026-11-07T15:00:00Z", "Manchester City FC", "Hull City AFC", "post", "2", "0", 10),
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
        { home: "Man City", away: "Hull", state: "post", actual: [2, 0] },
        { home: "Spurs", away: "Brighton", state: "post", actual: [0, 0] },
        { home: "Bournemouth", away: "Newcastle", state: "pre", actual: null },
      ],
    });
  });

  it("uses current matchweek when ?week is omitted", async () => {
    getCurrentMatchweekMock.mockResolvedValue(12);
    fetchScoreboardMock.mockResolvedValue([
      makeFixture("m1", "2026-11-28T15:00:00Z", "Arsenal", "Manchester City", "pre"),
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
        { home: "Arsenal", away: "Man City", state: "pre", actual: null },
      ],
    });
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

describe("V4PredictorPage matchweek selector & auto-fetch UI", () => {
  it("renders 1-38 dropdown, auto-fetches on mount, fetches ?week=X on dropdown change, and supports refresh", async () => {
    let resolveInitial!: (value: Response) => void;
    const requestedUrls: string[] = [];

    const fetchMock = vi.fn((url: string) => {
      requestedUrls.push(url);
      if (url === "/api/v4-predictor") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [],
        } as unknown as Response);
      }
      if (url === "/api/v4-predictor/auto") {
        return new Promise<Response>((resolve) => {
          resolveInitial = resolve;
        });
      }
      if (url === "/api/v4-predictor/auto?week=10") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            week: 10,
            fixtures: [
              { home: "Arsenal", away: "Hull", state: "post", actual: [2, 0] },
            ],
          }),
        } as unknown as Response);
      }
      if (url === "/api/v4-predictor/auto?week=11") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            week: 11,
            fixtures: [
              { home: "Liverpool", away: "Burnley", state: "pre", actual: null },
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

    expect(container.textContent).toContain("⚡ Fetch Real Fixtures");
    expect(container.textContent).toContain("Loading real fixtures...");
    expect(container.textContent).toContain("Refresh Fixtures");

    await act(async () => {
      resolveInitial({
        ok: true,
        status: 200,
        json: async () => ({
          week: 11,
          fixtures: [
            { home: "Man City", away: "Hull", state: "post", actual: [2, 0] },
            { home: "Spurs", away: "Brighton", state: "pre", actual: null },
          ],
        }),
      } as unknown as Response);
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Loading real fixtures...");
    const home1 = container.querySelector('input[aria-label="Fixture 1 home"]') as HTMLInputElement;
    const away1 = container.querySelector('input[aria-label="Fixture 1 away"]') as HTMLInputElement;
    expect(home1.value).toBe("Man City");
    expect(away1.value).toBe("Hull");

    const goal1Home = container.querySelector('input[aria-label="Match 1 home goals"]') as HTMLInputElement;
    const goal1Away = container.querySelector('input[aria-label="Match 1 away goals"]') as HTMLInputElement;
    const goal2Home = container.querySelector('input[aria-label="Match 2 home goals"]') as HTMLInputElement;
    const goal2Away = container.querySelector('input[aria-label="Match 2 away goals"]') as HTMLInputElement;
    expect(goal1Home.value).toBe("2");
    expect(goal1Away.value).toBe("0");
    expect(goal2Home.value).toBe("0");
    expect(goal2Away.value).toBe("0");

    // Predictions populated with V4 rules applied to translated team names
    expect(container.textContent).toContain("Man City vs Hull");
    expect(container.textContent).toContain("SNIPE: Home Fortress");
    expect(container.textContent).toContain("Spurs vs Brighton");
    expect(container.textContent).toContain("LOCK: Chaos Rule");
    // Scorecard populated automatically for the finished match (2-0 vs 2-0 = 20 pts)
    expect(container.textContent).toContain("— 20 pts");
    expect(container.textContent).toContain("🎯 EXACT (20 pts)");

    // Change dropdown to Matchweek 10
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "10");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(requestedUrls).toContain("/api/v4-predictor/auto?week=10");
    expect(select.value).toBe("10");
    expect((container.querySelector('input[aria-label="Fixture 1 home"]') as HTMLInputElement).value).toBe("Arsenal");
    expect((container.querySelector('input[aria-label="Fixture 1 away"]') as HTMLInputElement).value).toBe("Hull");
    expect(container.textContent).toContain("Arsenal vs Hull");
    expect(container.textContent).toContain("— 20 pts");

    // Change dropdown back to Matchweek 11
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "11");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(requestedUrls).toContain("/api/v4-predictor/auto?week=11");
    expect((container.querySelector('input[aria-label="Fixture 1 home"]') as HTMLInputElement).value).toBe("Liverpool");
    expect(container.textContent).toContain("Liverpool vs Burnley");

    const refreshButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Refresh Fixtures",
    )!;
    await act(async () => {
      refreshButton.click();
      await Promise.resolve();
    });

    expect(requestedUrls.filter((u) => u === "/api/v4-predictor/auto?week=11")).toHaveLength(2);
  });

  it("shows Loading real fixtures... while switching matchweeks", async () => {
    let resolveMw10!: (value: Response) => void;

    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/v4-predictor") {
        return Promise.resolve({ ok: true, status: 200, json: async () => [] } as unknown as Response);
      }
      if (url === "/api/v4-predictor/auto") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            week: 11,
            fixtures: [{ home: "Man City", away: "Fulham", state: "pre", actual: null }],
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
          fixtures: [{ home: "Arsenal", away: "Hull", state: "post", actual: [2, 0] }],
        }),
      } as unknown as Response);
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Loading real fixtures...");
    expect(container.textContent).toContain("Arsenal vs Hull");
  });
});
