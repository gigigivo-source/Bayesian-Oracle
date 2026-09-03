// @vitest-environment happy-dom

// End-to-end check of the /correct-score client flow: the feed is loaded, every
// card is a real click target, and clicking one opens the detail overlay (and
// closing it returns to the list) without a navigation.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import CorrectScorePage from "./page";
import type { CorrectScoreMatch, Scoreline } from "./components/ScoreDetailOverlay";

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

function match(id: string, homeTeam: string, awayTeam: string): CorrectScoreMatch {
  return {
    fixtureId: id,
    homeTeam,
    awayTeam,
    homeLogo: null,
    awayLogo: null,
    league: "English Premier League",
    leagueSlug: "eng.1",
    date: "2026-09-12T14:00:00Z",
    venue: null,
    homeExpectedGoals: 1.4,
    awayExpectedGoals: 1.1,
    h2hGoalAverage: 2.5,
    dataQuality: "Real",
    statsSources: ["SportScore"],
    topScorelines: [
      scoreline("2-1", 0.162),
      scoreline("1-1", 0.131),
      scoreline("1-0", 0.112),
      scoreline("2-0", 0.094),
      scoreline("1-2", 0.081),
      scoreline("0-0", 0.071),
      scoreline("2-2", 0.064),
      scoreline("3-1", 0.052),
      scoreline("0-1", 0.047),
      scoreline("3-0", 0.031),
    ],
    model: "supercomputer-v2",
    modelBadge: "Supercomputer",
    simulations: 10000,
    rho: -0.055,
    homeElo: 1720,
    awayElo: 1679,
    eloDelta: 41,
    structuralWeight: 0.8,
    context: null,
  };
}

async function renderPage(feed: CorrectScoreMatch[]): Promise<HTMLElement> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => feed }) as unknown as Response,
    ),
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<CorrectScorePage />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe("/correct-score fixture cards", () => {
  it("renders one clickable card per England Premier League fixture", async () => {
    const container = await renderPage([
      match("cs-1", "Coventry City", "Arsenal"),
      match("cs-2", "Hull City", "Manchester United"),
    ]);

    const cards = [...container.querySelectorAll<HTMLElement>('[role="button"][aria-label^="Open the detailed analysis"]')];
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.className).toContain("cursor-pointer");
      expect(card.getAttribute("tabindex")).toBe("0");
    }
    expect(container.textContent).toContain("Coventry City");
    expect(container.textContent).toContain("Hull City");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens the detail overlay on click and closes it again", async () => {
    const container = await renderPage([match("cs-1", "Coventry City", "Arsenal")]);

    const card = container.querySelector<HTMLElement>(
      '[role="button"][aria-label^="Open the detailed analysis"]',
    );
    expect(card).not.toBeNull();

    await act(async () => {
      card!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    expect(dialog!.textContent).toContain("Coventry City");
    expect(dialog!.textContent).toContain("Top 10 scorelines");
    // All ten scorelines, not just the headline pick.
    expect(dialog!.querySelectorAll("tbody tr")).toHaveLength(10);
    expect(dialog!.textContent).toContain("2-1");
    expect(dialog!.textContent).toContain("ELO 1720");
    expect(dialog!.textContent).toContain("+41");
    expect(dialog!.textContent).toContain("-0.055");

    // "Back to Predictions" dismisses it after the reverse animation.
    const backButton = [...dialog!.querySelectorAll("button")].find((button) =>
      (button.textContent ?? "").includes("Back to Predictions"),
    );
    expect(backButton).toBeTruthy();
    await act(async () => {
      backButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens the overlay from the keyboard as well", async () => {
    const container = await renderPage([match("cs-1", "Coventry City", "Arsenal")]);
    const card = container.querySelector<HTMLElement>(
      '[role="button"][aria-label^="Open the detailed analysis"]',
    );
    await act(async () => {
      card!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("shows the empty-feed notice when no England Premier League fixture survives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            matches: [],
            message:
              "No England Premier League matches available in the current fixture window.",
            diagnostics: { totalFixturesScanned: 0, filteredByLeague: 0, filteredByTeamList: 0 },
          }),
        }) as unknown as Response,
      ),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<CorrectScorePage />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "No England Premier League matches available in the current fixture window.",
    );
    expect(container.querySelectorAll('[role="button"][aria-label^="Open the detailed analysis"]')).toHaveLength(0);
  });
});
