// @vitest-environment happy-dom

// Verifies the /sure-corners fixture-card → MatchOverlay interaction contract:
//   · cards render with the best-market summary
//   · clicking a card opens the overlay instantly with markets ranked by hit
//     rate — WITHOUT any additional fetch (the overlay is data already on page)
//   · "← Back to Fixture Cards" closes the overlay and returns to the cards
//   · the Escape key closes the overlay too

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import SureCornersPage from "./page";
import type { SureCornersData } from "./page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Roots created by the current test — unmounted in afterEach so body-level side effects (scroll lock) are cleanly restored. */
const roots: Root[] = [];

/** Wait out the overlay's 300ms close animation inside an act() scope. */
async function waitForCloseAnimation() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 420));
  });
}

function makePayload(): SureCornersData {
  const kickoff = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  return {
    generatedAt: new Date().toISOString(),
    totalFixturesChecked: 120,
    rejectedMatches: 119,
    matches: [
      {
        fixtureId: "1239401",
        homeTeam: "Arsenal",
        awayTeam: "Chelsea",
        homeLogo: null,
        awayLogo: null,
        league: "Premier League",
        leagueSlug: "eng.1",
        leagueTier: 1,
        date: kickoff,
        confidence: "HIGH",
        realStats: true,
        statsSource: "sofascore-aggregator",
        predictedCorners: { home: 6.1, away: 5.2, total: 11.3, difference: 0.9, strongerTeam: "Arsenal" },
        markets: [
          {
            id: "m-10-5",
            marketType: "Total Corners",
            name: "Total Corners O/U 10.5",
            selection: "Over 10.5",
            line: 10.5,
            hitRate: 0.912,
            confidence: "HIGH",
            reason: "Expected total of 11.3 clears the line in similar historical samples.",
          },
          {
            id: "m-5-5",
            marketType: "Team 1 Corners",
            name: "Arsenal Corners O/U 5.5",
            selection: "Over 5.5",
            line: 5.5,
            hitRate: 0.987,
            confidence: "HIGH",
            reason: "Arsenal's home corner floor is well above this line.",
          },
          {
            id: "m-9-5",
            marketType: "Total Corners",
            name: "Total Corners O/U 9.5",
            selection: "Over 9.5",
            line: 9.5,
            hitRate: 0.962,
            confidence: "HIGH",
            reason: "Expected total of 11.3 clears the line with margin to spare.",
          },
        ],
      },
    ],
    filters: {
      minimumHitRate: 0.95,
      requiredConfidence: "HIGH",
      requiresRealPerMatchCorners: true,
      allowedLeagueTiers: [1, 2],
    },
  };
}

describe("sure-corners fixture card overlay", () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => {
        root.unmount();
      });
    }
    document.body.innerHTML = "";
    document.body.style.overflow = "";
    vi.unstubAllGlobals();
  });

  async function renderPage(fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<SureCornersPage />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    return { container, root };
  }

  it("opens the overlay instantly with hit-rate-ranked markets and no extra API request", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => makePayload(),
    }) as Response);
    const { container } = await renderPage(fetchMock);

    // Fixture card is present with the best corner-market summary (highest hit rate).
    const card = container.querySelector<HTMLButtonElement>('button[aria-label^="Open corner markets for"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Arsenal Corners O/U 5.5");
    expect(card?.textContent).toContain("98.7% hit rate");

    const fetchesBeforeOpen = fetchMock.mock.calls.length;
    expect(fetchesBeforeOpen).toBe(1);

    await act(async () => {
      card?.click();
    });

    // Overlay opened with zero additional fetches — instant, page data only.
    expect(fetchMock.mock.calls.length).toBe(fetchesBeforeOpen);
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.textContent).toContain("Corner Markets");

    // Markets are ranked by hit rate, highest first: 98.7 → 96.2 → 91.2.
    const rows = [...dialog!.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(3);
    const names = rows.map((row) => row.querySelector("td:nth-child(2) .text-sm")?.textContent);
    expect(names).toEqual([
      "Arsenal Corners O/U 5.5",
      "Total Corners O/U 9.5",
      "Total Corners O/U 10.5",
    ]);
    const hitRates = rows.map((row) => row.querySelectorAll("td")[3]?.textContent);
    expect(hitRates).toEqual(["98.7%", "96.2%", "91.2%"]);

    // Pending fixture → every outcome renders as PENDING.
    expect(dialog!.textContent).toContain("PENDING");
  });

  it("returns to the fixture cards via the Back button without reloading the page", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => makePayload(),
    }) as Response);
    const { container } = await renderPage(fetchMock);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label^="Open corner markets for"]')?.click();
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    const backButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Back to Fixture Cards"),
    );
    expect(backButton).toBeDefined();

    await act(async () => {
      backButton?.click();
    });
    await waitForCloseAnimation();

    // Overlay closed, cards untouched, still exactly one fetch in total.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('button[aria-label^="Open corner markets for"]')).not.toBeNull();
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(document.body.style.overflow).toBe("");
  });

  it("closes the overlay when the Escape key is pressed", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => makePayload(),
    }) as Response);
    const { container } = await renderPage(fetchMock);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label^="Open corner markets for"]')?.click();
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await waitForCloseAnimation();

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('button[aria-label^="Open corner markets for"]')).not.toBeNull();
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});
