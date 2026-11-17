// @vitest-environment happy-dom

// UI tests for /tennis Value Market Extractor and Lock Value Accumulator Builder.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { predictTennisMatch } from "@/lib/engine/markets";
import TennisPage from "./page";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function buildFixture(params: {
  id: string;
  tournament: string;
  date: string;
  nameA: string;
  eloA: number;
  acesA: number;
  nameB: string;
  eloB: number;
  acesB: number;
}) {
  const prediction = predictTennisMatch({
    tour: "atp",
    tournament: params.tournament,
    surface: "hard",
    round: "Round of 32",
    date: params.date,
    bestOf: 3,
    playerA: {
      name: params.nameA,
      elo: params.eloA,
      ratingSource: "elo",
      matchesPlayed: 50,
      lastPlayed: "2026-11-10T00:00:00Z",
      rank: 3,
      acesPerMatch: params.acesA,
      doubleFaultsPerMatch: 2.5,
      bpFacedPerMatch: 4.5,
      baselineSource: "surface",
    },
    playerB: {
      name: params.nameB,
      elo: params.eloB,
      ratingSource: "elo",
      matchesPlayed: 50,
      lastPlayed: "2026-11-10T00:00:00Z",
      rank: 95,
      acesPerMatch: params.acesB,
      doubleFaultsPerMatch: 3.5,
      bpFacedPerMatch: 7.5,
      baselineSource: "surface",
    },
    tourBaselines: { acesPerMatch: 6.5, doubleFaultsPerMatch: 3.0, bpFacedPerMatch: 6.0 },
  });

  return {
    id: params.id,
    tour: "atp" as const,
    tournament: params.tournament,
    surface: "hard" as const,
    round: "Round of 32",
    date: params.date,
    venue: "Centre Court",
    status: "scheduled" as const,
    bestOf: 3 as const,
    eloGap: prediction.eloGap,
    lockTier: prediction.lockTier,
    lockReasons: prediction.lockReasons,
    ...(prediction.bestValueMarket ? { bestValueMarket: prediction.bestValueMarket } : {}),
    players: [
      {
        name: params.nameA,
        country: "ESP",
        rating: params.eloA,
        ratingSource: "elo" as const,
        matchesPlayed: 50,
        lastPlayed: "2026-11-10T00:00:00Z",
        rank: 3,
        acesPerMatch: params.acesA,
        doubleFaultsPerMatch: 2.5,
        bpFacedPerMatch: 4.5,
        baselineSource: "surface" as const,
      },
      {
        name: params.nameB,
        country: "FRA",
        rating: params.eloB,
        ratingSource: "elo" as const,
        matchesPlayed: 50,
        lastPlayed: "2026-11-10T00:00:00Z",
        rank: 95,
        acesPerMatch: params.acesB,
        doubleFaultsPerMatch: 3.5,
        bpFacedPerMatch: 7.5,
        baselineSource: "surface" as const,
      },
    ],
    prediction,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TennisPage Value Market Extractor & Accumulator Builder", () => {
  it("highlights Best Value Market only on playable Locks and builds a > 1.50 accumulator", async () => {
    // 1. Heavy Platinum Lock (gap 480) → Set Betting ("Carlos Alcaraz 2-0", @1.38)
    const platSetBetting = buildFixture({
      id: "atp-plat-1",
      tournament: "ATP Finals",
      date: "2026-11-17T14:00:00Z",
      nameA: "Carlos Alcaraz",
      eloA: 1980,
      acesA: 7.0,
      nameB: "Qualifier One",
      eloB: 1500,
      acesB: 4.0,
    });

    // 2. Gold Lock (gap 240, Player B favorite) → Total Games ("Under 23.5", @1.71)
    const goldTotalGames = buildFixture({
      id: "atp-gold-2",
      tournament: "ATP Finals",
      date: "2026-11-17T16:00:00Z",
      nameA: "Qualifier Two",
      eloA: 1500,
      acesA: 4.2,
      nameB: "Jannik Sinner",
      eloB: 1740,
      acesB: 7.5,
    });

    // 3. Trap-flagged AVOID match (big-server underdog >= 8.5 aces) → NO Value Market banner
    const avoidTrap = buildFixture({
      id: "atp-avoid-3",
      tournament: "ATP Finals",
      date: "2026-11-17T18:00:00Z",
      nameA: "Novak Djokovic",
      eloA: 1850,
      acesA: 6.5,
      nameB: "Ace Bot",
      eloB: 1500,
      acesB: 12.4,
    });

    // 4. Even match (NONE, gap 40) → NO Value Market banner
    const evenMatch = buildFixture({
      id: "atp-none-4",
      tournament: "ATP Finals",
      date: "2026-11-17T20:00:00Z",
      nameA: "Taylor Fritz",
      eloA: 1720,
      acesA: 8.0,
      nameB: "Alex de Minaur",
      eloB: 1680,
      acesB: 4.0,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          generatedAt: "2026-11-16T22:00:00Z",
          filters: { surface: null, tour: "both", limit: 100, days: 7, locksOnly: false },
          locksSummary: {
            platinum: 1,
            gold: 1,
            silver: 0,
            bronze: 0,
            avoid: 1,
            total: 2,
            valueMarketsCount: 2,
          },
          ratings: { atp: { asOf: "2026-11-16", matchesProcessed: 1200, playersRated: 250 } },
          sources: [],
          count: 4,
          matches: [platSetBetting, goldTotalGames, avoidTrap, evenMatch],
        }),
      })),
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<TennisPage />);
    });
    await flush();

    // Exactly 2 Best Value Market banners rendered (Platinum & Gold; NOT Avoid or None).
    const banners = container.querySelectorAll('[data-testid="best-value-market"]');
    expect(banners.length).toBe(2);
    const pageText = container.textContent ?? "";
    expect(pageText).toContain("Carlos Alcaraz 2-0");
    expect(pageText).toContain("Set Betting");
    expect(pageText).toContain("Total Games");
    expect(pageText).toContain(goldTotalGames.bestValueMarket!.selection);

    // Lock Value Accumulator Builder panel is visible.
    const builder = container.querySelector('[data-testid="lock-value-acca-builder"]');
    expect(builder).not.toBeNull();

    // Click "Auto-Pick > 1.50 Acca" → picks both Locks, combined fair odds > 1.50.
    const autoPickBtn = [...container.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes("Auto-Pick"),
    );
    expect(autoPickBtn).toBeDefined();

    await act(async () => {
      autoPickBtn!.click();
    });

    const combinedOddsEl = container.querySelector('[data-testid="acca-combined-odds"]');
    expect(combinedOddsEl).not.toBeNull();
    const expectedCombined =
      Math.round(
        platSetBetting.bestValueMarket!.fairOdds * goldTotalGames.bestValueMarket!.fairOdds * 100,
      ) / 100;
    expect(combinedOddsEl?.textContent).toBe(expectedCombined.toFixed(2));
    expect(expectedCombined).toBeGreaterThan(1.5);
    expect(container.textContent).toContain("> 1.50 Target Met");

    // Both Lock cards now show "✓ In Acca".
    const inAccaButtons = [...container.querySelectorAll("button")].filter((btn) =>
      btn.textContent?.includes("✓ In Acca"),
    );
    expect(inAccaButtons.length).toBe(2);

    // Clicking Clear removes all legs from the accumulator.
    const clearBtn = [...container.querySelectorAll("button")].find(
      (btn) => btn.textContent?.trim() === "Clear",
    );
    expect(clearBtn).toBeDefined();
    await act(async () => {
      clearBtn!.click();
    });
    expect(container.querySelector('[data-testid="acca-combined-odds"]')).toBeNull();

    // Manual toggle via "+ Add to Acca" adds a single leg.
    const addButtons = [...container.querySelectorAll("button")].filter((btn) =>
      btn.textContent?.includes("+ Add to Acca"),
    );
    expect(addButtons.length).toBe(2);
    await act(async () => {
      addButtons[0].click();
    });
    expect(container.querySelector('[data-testid="acca-combined-odds"]')?.textContent).toBe(
      platSetBetting.bestValueMarket!.fairOdds.toFixed(2),
    );
  });
});
