// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { scoreboard, summary, engine } = vi.hoisted(() => ({
  scoreboard: vi.fn(), summary: vi.fn(), engine: vi.fn(),
}));
vi.mock("@/lib/espn", () => ({ fetchScoreboard: scoreboard, fetchSummary: summary }));
vi.mock("@/lib/engine/engine", () => ({ runEngineFromRealWithProfiles: engine }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const fixture = (id: string, home: string, away: string, week = 8) => ({
  id, date: `2026-10-${id.padStart(2, "0")}T12:00:00Z`, leagueSlug: "eng.1", matchweek: week,
  state: "post", home: { name: home, score: "0" }, away: { name: away, score: "2" },
});
const result = (home: string, away: string, outcome: "home" | "draw" | "away", completeness = 50) => ({
  match: { dataCompletenessScore: completeness },
  markets: [
    { family: "Goals", name: `Match Result: ${home} Win`, selection: `${home} Win`, hitRate: outcome === "home" ? 0.6 : 0.2 },
    { family: "Goals", name: "Match Result: Draw", selection: "Draw", hitRate: outcome === "draw" ? 0.6 : 0.2 },
    { family: "Goals", name: `Match Result: ${away} Win`, selection: `${away} Win`, hitRate: outcome === "away" ? 0.6 : 0.2 },
    { family: "Goals", name: "Correct Score 0-0", selection: "Score 0-0", hitRate: 0.5 },
    { family: "Goals", name: "Correct Score 1-1", selection: "Score 1-1", hitRate: 0.6 },
    { family: "Goals", name: "Correct Score 2-1", selection: "Score 2-1", hitRate: 0.3 },
    { family: "Goals", name: "Correct Score 3-1", selection: "Score 3-1", hitRate: 0.2 },
    { family: "Goals", name: "Correct Score 0-2", selection: "Score 0-2", hitRate: 0.3 },
    { family: "Goals", name: "Correct Score 1-2", selection: "Score 1-2", hitRate: 0.2 },
    { family: "Corners", name: "Correct Score 8-0", selection: "Score 8-0", hitRate: 0.99 },
    { family: "Goals", name: "Double Chance 1X", selection: "Draw", hitRate: 0.99 },
  ],
});

beforeEach(() => { scoreboard.mockReset(); summary.mockReset().mockResolvedValue(null); engine.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("winner-first hybrid route", () => {
  it("preserves all snipes, skips their engine calls, and selects scores for each engine outcome", async () => {
    const matches = [fixture("1", "Arsenal", "Coventry City"), fixture("2", "Fulham", "Leeds United"),
      fixture("3", "Hull City", "Liverpool"), fixture("4", "Chelsea", "Wolves"),
      fixture("5", "Tottenham Hotspur", "Burnley"), fixture("6", "Manchester United", "Everton")];
    scoreboard.mockResolvedValue([...matches].reverse());
    engine.mockImplementation(async (fx) => result(fx.home.name, fx.away.name, fx.id === "4" ? "away" : fx.id === "5" ? "draw" : "home"));
    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    const body = await (await GET(new Request("http://localhost/api/v4-predictor/auto?week=8"))).json();
    expect(body.fixtures.map((r: { finalPrediction: string }) => r.finalPrediction)).toEqual(["2-0", "1-1", "0-1", "0-2", "1-1", "2-1"]);
    expect(body.fixtures.map((r: { finalCategory: string }) => r.finalCategory)).toEqual([
      "SNIPE: Home Fortress", "SNIPE: Mid-Table Deadlock", "SNIPE: Elite Away",
      "ENGINE: Winner-First", "ENGINE: Winner-First", "ENGINE: Winner-First",
    ]);
    expect(engine.mock.calls.map(([fx]) => fx.id)).toEqual(["4", "5", "6"]);
    expect(summary.mock.calls.map(([, id]) => id)).toEqual(["4", "5", "6"]);
  });

  it("falls back independently for low or invalid completeness, failures, and missing markets", async () => {
    const matches = Array.from({ length: 5 }, (_, i) => fixture(String(i + 1), "Chelsea", "Wolves", 1));
    scoreboard.mockResolvedValue(matches);
    engine.mockImplementation(async (fx) => {
      if (fx.id === "3") throw new Error("engine down");
      if (fx.id === "4") return { match: { dataCompletenessScore: 80 }, markets: [] };
      return result("Chelsea", "Wolves", "away", fx.id === "1" ? 49 : fx.id === "2" ? NaN : 50);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    const body = await (await GET(new Request("http://localhost/api/v4-predictor/auto?week=1"))).json();
    expect(body.fixtures.map((r: { finalPrediction: string }) => r.finalPrediction)).toEqual(["2-1", "2-1", "2-1", "2-1", "0-2"]);
    expect(body.fixtures.map((r: { finalCategory: string }) => r.finalCategory)).toEqual([
      "LOCK: Chaos Rule", "LOCK: Chaos Rule", "LOCK: Chaos Rule", "LOCK: Chaos Rule", "ENGINE: Winner-First",
    ]);
  });

  it("supports generic Result and Correct Score market names", async () => {
    scoreboard.mockResolvedValue([fixture("1", "Chelsea", "Wolves")]);
    engine.mockResolvedValue({ match: { dataCompletenessScore: 50 }, markets: [
      { family: "Goals", name: "Result", selection: "Away", hitRate: 0.55 },
      { family: "Goals", name: "Result", selection: "Home", hitRate: 0.35 },
      { family: "Goals", name: "Correct Score", selection: "Score 0-2", hitRate: 0.18 },
      { family: "Goals", name: "Correct Score", selection: "2-1", hitRate: 0.30 },
    ] });
    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    const body = await (await GET(new Request("http://localhost/api/v4-predictor/auto?week=8"))).json();
    expect(body.fixtures[0]).toMatchObject({ finalPrediction: "0-2", finalCategory: "ENGINE: Winner-First" });
  });

  it("falls back when summary fetch fails or the winning outcome has no valid scores", async () => {
    scoreboard.mockResolvedValue([fixture("1", "Chelsea", "Wolves"), fixture("2", "Spurs", "Wolves")]);
    summary.mockImplementation(async (_league, id) => { if (id === "1") throw new Error("summary down"); return null; });
    engine.mockResolvedValue({ match: { dataCompletenessScore: 60 }, markets: [
      { family: "Goals", name: "1X2", selection: "Away", hitRate: 0.6 },
      { family: "Goals", name: "Correct Score 2-1", selection: "Score 2-1", hitRate: 0.3 },
      { family: "Goals", name: "Correct Score 0-1", selection: "Score 0-1", hitRate: NaN },
    ] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/v4-predictor/auto/route");
    const body = await (await GET(new Request("http://localhost/api/v4-predictor/auto?week=8"))).json();
    expect(body.fixtures.map((r: { finalCategory: string }) => r.finalCategory)).toEqual(["LOCK: Chaos Rule", "LOCK: Chaos Rule"]);
    expect(engine).toHaveBeenCalledTimes(1);
  });
});

describe("hybrid dashboard", () => {
  it("shows and scores the API decision even when it disagrees with V2", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ week: 11, fixtures: [{
      home: { name: "Chelsea", logo: null }, away: { name: "Wolves", logo: null }, state: "post", actual: [0, 2],
      enginePrediction: "0-2", finalPrediction: "0-2", finalCategory: "ENGINE: Winner-First",
    }] }) }));
    const { default: Page } = await import("./page");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<Page />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain("ENGINE: Winner-First");
    expect(container.textContent).toContain("0-2");
    expect(container.textContent).toContain("20 pts");
    act(() => root.unmount());
    container.remove();
  });
});
