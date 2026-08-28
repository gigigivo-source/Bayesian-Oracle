// @vitest-environment happy-dom

// Renders both feature overlays with realistic API payloads to guard the
// Data Quality badge / Confidence Score UI (paths, tones, hover breakdown).

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import MatchOverlay, {
  type SureCornerMatch,
} from "./sure-corners/components/MatchOverlay";
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
