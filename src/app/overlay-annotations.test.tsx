// @vitest-environment happy-dom

// Renders the feature overlays with realistic API payloads to guard the
// Data Quality badge / Confidence Score UI (paths, tones, hover breakdown) and
// the correct-score detail overlay (top-10 table, metadata, close paths).

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import MatchOverlay, {
  type SureCornerMatch,
} from "./sure-corners/components/MatchOverlay";
import ScoreDetailOverlay, {
  type CorrectScoreMatch,
  type Scoreline,
} from "./correct-score/components/ScoreDetailOverlay";
import { MarketTile } from "./first-5-minutes/components/MarketTile";
import type { First5Market } from "./first-5-minutes/components/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

const sureMatch: SureCornerMatch = {
  fixtureId: "fx-1",
  homeTeam: "Arsenal",
  awayTeam: "Ipswich",
  homeLogo: null,
  awayLogo: null,
  league: "English Premier League",
  leagueSlug: "eng.1",
  leagueTier: 1,
  date: new Date(Date.now() + 86400_000).toISOString(),
  confidence: "HIGH",
  realStats: true,
  statsSource: "SportScore",
  predictedCorners: { home: 6.4, away: 3.9, difference: 2.5, strongerTeam: "Arsenal" },
  markets: [
    {
      id: "total-corners-9.5",
      marketType: "Total Corners",
      name: "Total Corners O/U 9.5",
      selection: "Over 9.5",
      line: 9.5,
      hitRate: 0.934,
      confidence: "HIGH",
      reason: "...",
      dataQuality: "real",
      confidenceScore: 85,
      dataSourceDetail: "SportScore (Real)",
      confidenceBreakdown: {
        dataQuality: "real",
        dataQualityPoints: 40,
        sourceCount: 1,
        sourceAgreementPoints: 15,
        completenessPct: 100,
        completenessPoints: 30,
      },
    },
    {
      id: "total-corners-11.5",
      marketType: "Total Corners",
      name: "Total Corners O/U 11.5",
      selection: "Under 11.5",
      line: 11.5,
      hitRate: 0.961,
      confidence: "HIGH",
      reason: "...",
      dataQuality: "synthetic",
      confidenceScore: 23,
      dataSourceDetail: "Synthetic Baseline (League Avg)",
      confidenceBreakdown: {
        dataQuality: "synthetic",
        dataQualityPoints: 12,
        sourceCount: 0,
        sourceAgreementPoints: 0,
        completenessPct: 37.5,
        completenessPoints: 11,
      },
    },
  ],
};

function side(label: "Yes" | "No", hitRate: number) {
  return {
    label,
    probability: hitRate,
    hitRate,
    fairOdds: 1 / hitRate,
    odds1xBet: 1 / hitRate,
    confidence: hitRate >= 0.8 ? ("HIGH" as const) : hitRate >= 0.6 ? ("MEDIUM" as const) : ("LOW" as const),
  };
}

const first5Market: First5Market = {
  id: "fx-2-goal",
  key: "goal",
  label: "Goal in First 5 Minutes",
  shortLabel: "Goal",
  icon: "⚽",
  outcome: "No",
  probability: 0.1148,
  hitRate: 0.8852,
  fairOdds: 1.13,
  odds: { yes: 8.7, no: 1.13, selected: 1.13 },
  yes: side("Yes", 0.1148),
  no: side("No", 0.8852),
  isGuaranteed: false,
  confidence: "MEDIUM",
  expectedInWindow: 0.122,
  expectedPerMatch: 2.6,
  origin: "real",
  statsSource: "SportScore",
  source: "SportScore",
  reason: "combined xG 3.20 → ...",
  dataQuality: "mixed",
  confidenceScore: 62,
  dataSourceDetail: "SportScore (Real) + Synthetic",
  confidenceBreakdown: {
    dataQuality: "mixed",
    dataQualityPoints: 24,
    sourceCount: 1,
    sourceAgreementPoints: 15,
    completenessPct: 75,
    completenessPoints: 23,
  },
};

describe("MatchOverlay (sure corners) annotations", () => {
  it("renders data quality badges, numeric scores and source details", () => {
    const container = render(<MatchOverlay match={sureMatch} onClose={() => {}} />);
    const html = container.innerHTML;
    expect(html).toContain("🔵 Real");
    expect(html).toContain("⚪ Synthetic");
    expect(html).toContain("SportScore (Real)");
    expect(html).toContain("Synthetic Baseline (League Avg)");
    // 85 → teal/amber band classes present; both numeric scores rendered.
    expect(html).toContain("teal-300"); // 85 = high band (>=80 → green/teal)
    expect(html).toContain("rose-300"); // 23 = low band (<50 → rose)
    const text = container.textContent ?? "";
    expect(text).toMatch(/conf\s*85/);
    expect(text).toMatch(/conf\s*23/);
    // Hover tooltip content present on the score pills.
    const scoreEl = [...container.querySelectorAll("span[title]")]
      .find((el) => (el.getAttribute("title") ?? "").startsWith("Confidence: 85"));
    expect(scoreEl).toBeTruthy();
    const tooltip = scoreEl!.getAttribute("title")!;
    expect(tooltip).toContain("Data Quality: Real (40/40)");
    expect(tooltip).toContain("Source Agreement: 1 source (no cross-check) (15/30)");
    expect(tooltip).toContain("Stat Completeness: All stats present (30/30)");
  });
});

describe("MarketTile (first 5 minutes) annotations", () => {
  it("renders mixed badge, confidence score and hover breakdown", () => {
    const container = render(<MarketTile market={first5Market} />);
    const text = container.textContent ?? "";
    expect(text).toContain("🟡 Mixed");
    expect(text).toContain("SportScore (Real) + Synthetic");
    expect(text).toMatch(/conf\s*62/);
    const html = container.innerHTML;
    expect(html).toContain("amber-300"); // 62 = medium band (50–79 → amber)
    // Tooltip overlay present (hidden until hover via opacity-0 + group-hover).
    expect(html).toContain("opacity-0");
    expect(html).toContain("group-hover/tile:opacity-100");
    expect(text).toContain("Data Quality: Mixed (24/40)");
    expect(text).toContain("Source Agreement: 1 source (no cross-check) (15/30)");
    expect(text).toContain("Stat Completeness: 75% of stats present (23/30)");
  });
});

// ─── Correct Score detail overlay ─────────────────────────────────────────────

function scoreline(score: string, probability: number): Scoreline {
  return {
    score,
    homeGoals: Number(score.split("-")[0]),
    awayGoals: Number(score.split("-")[1]),
    probability,
    impliedOdds: Math.round((1 / probability) * 100) / 100,
    confidence: probability > 0.15 ? "HIGH" : probability > 0.08 ? "MEDIUM" : "LOW",
    dataQuality: "Real",
  };
}

const correctScoreMatch: CorrectScoreMatch = {
  fixtureId: "cs-1",
  homeTeam: "Coventry City",
  awayTeam: "Arsenal",
  homeLogo: null,
  awayLogo: null,
  league: "English Premier League",
  leagueSlug: "eng.1",
  date: "2026-09-12T14:00:00Z",
  venue: "Coventry Building Society Arena",
  homeExpectedGoals: 1.02,
  awayExpectedGoals: 1.84,
  h2hGoalAverage: 2.75,
  dataQuality: "Real",
  statsSources: ["SportScore", "ESPN Standings (season)"],
  topScorelines: [
    scoreline("1-2", 0.142),
    scoreline("1-1", 0.121),
    scoreline("0-2", 0.108),
    scoreline("1-3", 0.087),
    scoreline("0-1", 0.081),
    scoreline("2-2", 0.064),
    scoreline("0-3", 0.058),
    scoreline("1-0", 0.052),
    scoreline("2-1", 0.047),
    scoreline("0-0", 0.041),
  ],
  model: "supercomputer-v2",
  modelBadge: "🧠 Supercomputer",
  simulations: 10000,
  simulationMethod: "stratified",
  rho: -0.055,
  homeElo: 1583,
  awayElo: 1902,
  eloDelta: -319,
  structuralWeight: 0.8,
  modelSources: ["openfootball (1140)"],
  context: {
    homeForm: {
      team: "Coventry City",
      games: [
        { date: "2026-08-30", opponent: "Hull City", result: "W", score: "3-1", venue: "H", competition: "Premier League" },
        { date: "2026-08-23", opponent: "Chelsea", result: "L", score: "0-2", venue: "A", competition: "Premier League" },
      ],
      wins: 1,
      draws: 0,
      losses: 1,
      points: 3,
      goalsForAverage: 1.5,
      goalsAgainstAverage: 1.5,
    },
    awayForm: {
      team: "Arsenal",
      games: [
        { date: "2026-08-30", opponent: "Fulham", result: "W", score: "2-0", venue: "H", competition: "Premier League" },
      ],
      wins: 1,
      draws: 0,
      losses: 0,
      points: 3,
      goalsForAverage: 2,
      goalsAgainstAverage: 0,
    },
    h2h: [
      { date: "2001-04-14", home: "Coventry City", away: "Arsenal", score: "0 - 1" },
      { date: "2000-11-04", home: "Arsenal", away: "Coventry City", score: "2 - 1" },
    ],
    h2hHomeWins: 0,
    h2hDraws: 0,
    h2hAwayWins: 2,
    h2hAverageGoals: 2,
  },
};

/** Wait out the 300ms reverse animation the overlay plays before unmounting. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
}

describe("ScoreDetailOverlay (correct score)", () => {
  it("renders the full top-10 scoreline table with metadata", () => {
    const container = render(<ScoreDetailOverlay match={correctScoreMatch} onClose={() => {}} />);
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(10);

    const text = container.textContent ?? "";
    // Rank, scoreline, probability, implied odds and confidence for the top pick.
    expect(text).toContain("#1");
    expect(text).toContain("1-2");
    expect(text).toContain("14.2%");
    expect(text).toContain("7.04");
    expect(text).toContain("#10");
    expect(text).toContain("0-0");

    // Header row: teams, ELO, league, quality badge.
    expect(text).toContain("Coventry City");
    expect(text).toContain("Arsenal");
    expect(text).toContain("ELO 1583");
    expect(text).toContain("ELO 1902");
    expect(text).toContain("England Premier League");
    expect(text).toContain("● Real");

    // Expected goals + model metadata.
    expect(text).toContain("1.02");
    expect(text).toContain("1.84");
    expect(text).toContain("-319");
    expect(text).toContain("-0.055");
    expect(text).toContain("Supercomputer");

    // Rank 1 carries the gold accent.
    expect(rows[0].className).toContain("amber-400/40");

    // Backdrop + panel contract.
    const backdrop = container.firstElementChild as HTMLElement;
    expect(backdrop.className).toContain("fixed inset-0");
    expect(backdrop.className).toContain("bg-black/70");
    expect(backdrop.className).toContain("backdrop-blur-sm");
    expect(backdrop.className).toContain("z-50");
    const panel = backdrop.firstElementChild as HTMLElement;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.className).toContain("max-w-4xl");
    expect(panel.className).toContain("max-h-[90vh]");
    expect(panel.className).toContain("overflow-y-auto");
    expect(panel.className).toContain("bg-slate-900/95");
  });

  it("renders recent form and the head-to-head summary", () => {
    const container = render(<ScoreDetailOverlay match={correctScoreMatch} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Match context");
    expect(text).toContain("1W 0D 1L · 3 pts");
    expect(text).toContain("Head-to-head");
    expect(text).toContain("Draws 0");
    expect(text).toContain("avg 2.00 goals");
    expect(text).toContain("Hull City");
  });

  it("closes via the Close button, the backdrop and the Escape key", async () => {
    const onClose = vi.fn();
    const container = render(<ScoreDetailOverlay match={correctScoreMatch} onClose={onClose} />);
    const backdrop = container.firstElementChild as HTMLElement;
    const panel = backdrop.firstElementChild as HTMLElement;

    const closeButton = [...container.querySelectorAll("button")].find((button) =>
      (button.textContent ?? "").includes("Close"),
    );
    expect(closeButton).toBeTruthy();
    act(() => {
      closeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // Reverse animation starts immediately, unmount follows it.
    expect(panel.className).toContain("scale-95");
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("unmounts after the backdrop is clicked", async () => {
    const onClose = vi.fn();
    const container = render(<ScoreDetailOverlay match={correctScoreMatch} onClose={onClose} />);
    const backdrop = container.firstElementChild as HTMLElement;
    act(() => {
      backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("unmounts on Escape", async () => {
    const onClose = vi.fn();
    render(<ScoreDetailOverlay match={correctScoreMatch} onClose={onClose} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
