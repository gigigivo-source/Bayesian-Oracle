// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FixtureLite } from "@/lib/espn";
import { TEAM_NAME_MAP, translateTeamName } from "@/lib/v4-predictor";

const fetchScoreboardMock = vi.fn();

vi.mock("@/lib/espn", () => ({
  fetchScoreboard: (...args: unknown[]) => fetchScoreboardMock(...args),
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
  };
}

beforeEach(() => {
  fetchScoreboardMock.mockReset();
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
  it("filters to today +/- 4 days, translates names, and extracts actual scores", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));

    fetchScoreboardMock.mockResolvedValue([
      makeFixture("old", "2026-11-05T15:00:00Z", "Arsenal", "Chelsea", "post", "2", "1"),
      makeFixture("m1", "2026-11-09T15:00:00Z", "Manchester City", "Hull City", "post", "2", "0"),
      makeFixture("m2", "2026-11-11T19:45:00Z", "Tottenham Hotspur", "Brighton & Hove Albion", "post", "0", "0"),
      makeFixture("m3", "2026-11-14T15:00:00Z", "Manchester United", "Newcastle United", "pre", "0", "0"),
      makeFixture("far", "2026-11-20T15:00:00Z", "Liverpool", "Everton", "pre"),
    ]);

    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(fetchScoreboardMock).toHaveBeenCalledWith("eng.1", "20261107-20261115");
    expect(body).toEqual({
      fixtures: [
        { home: "Man City", away: "Hull", state: "post", actual: [2, 0] },
        { home: "Spurs", away: "Brighton", state: "post", actual: [0, 0] },
        { home: "Man Utd", away: "Newcastle", state: "pre", actual: null },
      ],
    });
  });

  it("returns 500 with { error: 'Failed to fetch' } when fetching throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchScoreboardMock.mockRejectedValue(new Error("ESPN down"));

    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to fetch" });

    errSpy.mockRestore();
  });
});

describe("V4PredictorPage auto-fetch UI", () => {
  it("auto-fetches on mount, populates translated fixtures, predictions, actuals, and scorecard, and supports refresh", async () => {
    let resolveAuto!: (value: Response) => void;
    let autoCallCount = 0;

    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/v4-predictor") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [],
        } as unknown as Response);
      }
      if (url === "/api/v4-predictor/auto") {
        autoCallCount++;
        if (autoCallCount === 1) {
          return new Promise<Response>((resolve) => {
            resolveAuto = resolve;
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
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

    expect(container.textContent).toContain("⚡ Fetch Real Fixtures");
    expect(container.textContent).toContain("Loading real fixtures...");
    expect(container.textContent).toContain("Refresh Fixtures");

    await act(async () => {
      resolveAuto({
        ok: true,
        status: 200,
        json: async () => ({
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

    const refreshButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Refresh Fixtures",
    )!;
    await act(async () => {
      refreshButton.click();
      await Promise.resolve();
    });

    expect(autoCallCount).toBe(2);
    const refreshedHome = container.querySelector('input[aria-label="Fixture 1 home"]') as HTMLInputElement;
    expect(refreshedHome.value).toBe("Liverpool");
    expect(container.textContent).toContain("Liverpool vs Burnley");
    expect(container.textContent).toContain("SNIPE: Home Fortress");
  });
});
