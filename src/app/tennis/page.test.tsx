// @vitest-environment happy-dom

// UI contract tests for /tennis (Part 5 of the tennis spec):
//   · 🟢 data-status badge + full match cards when the API answers 200;
//   · 🔴 badge + the exact "currently unavailable" copy — and no placeholder
//     cards — when the API refuses with 503.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** A 200 payload in the exact shape /api/tennis/predictions returns. */
function okPayload() {
  return {
    generatedAt: "2026-09-04T22:00:00.000Z",
    filters: { surface: null, tour: "atp", limit: 60, days: 4 },
    dataStatus: {
      atp: {
        ok: true,
        matches: 4_213,
        playersRated: 812,
        matchesRated: 4_100,
        asOf: "2026-09-02T00:00:00Z",
        fixtures: 3,
        error: null,
        sources: [],
      },
    },
    count: 1,
    total: 1,
    matches: [
      {
        id: "atp-900001",
        tour: "atp",
        tournament: "US Open",
        round: "Round of 16",
        surface: "hard",
        bestOf: 5,
        date: "2026-09-05T17:30Z",
        venue: "New York, USA",
        status: "scheduled",
        dataQuality: "real",
        home: {
          name: "Hubert Hurkacz",
          country: "Poland",
          elo: 1621,
          eloBySurface: { clay: 1580, grass: 1604, hard: 1621 },
          surfaceMatches: 24,
          matchesPlayed: 48,
          rank: 21,
          serveWinRate: 0.705,
          returnWinRate: 0.313,
          acesPerMatch: 17.6,
          doubleFaultsPerMatch: 1,
          bpFacedPerMatch: 5,
          baselineSource: "surface",
        },
        away: {
          name: "Taylor Fritz",
          country: "USA",
          elo: 1574,
          eloBySurface: { clay: 1540, grass: 1566, hard: 1574 },
          surfaceMatches: 30,
          matchesPlayed: 52,
          rank: 9,
          serveWinRate: 0.679,
          returnWinRate: 0.304,
          acesPerMatch: 14.2,
          doubleFaultsPerMatch: 2.2,
          bpFacedPerMatch: 4.5,
          baselineSource: "surface",
        },
        matchWinner: {
          home: 0.5662,
          away: 0.4338,
          fairOddsHome: 1.77,
          fairOddsAway: 2.31,
          favourite: "Hubert Hurkacz",
          eloHome: 1621,
          eloAway: 1574,
          surfaceEloHome: 1621,
          surfaceEloAway: 1574,
        },
        totalGames: {
          expected: 42.4,
          probabilities: { "over_41.5": 0.652, "under_41.5": 0.348 },
          lines: [{ line: 41.5, overProb: 0.652, underProb: 0.348 }],
          basis: "exact set-score model",
        },
        setWinner: {
          sets: [
            { set: 1, home: 0.5451, away: 0.4549 },
            { set: 2, home: 0.5451, away: 0.4549 },
            { set: 3, home: 0.5451, away: 0.4549 },
            { set: 4, home: 0.5451, away: 0.4549 },
            { set: 5, home: 0.5451, away: 0.4549 },
          ],
          setBetting: [
            { score: "3-1", prob: 0.226 },
            { score: "3-2", prob: 0.2025 },
            { score: "3-0", prob: 0.1681 },
            { score: "2-3", prob: 0.1644 },
            { score: "1-3", prob: 0.149 },
            { score: "0-3", prob: 0.09 },
          ],
        },
        scoreDistribution: {
          "3-1": 0.226,
          "3-2": 0.2025,
          "3-0": 0.1681,
          "2-3": 0.1644,
          "1-3": 0.149,
          "0-3": 0.09,
        },
        projectedScoreline: "7-6 6-4 7-6",
        projectedScorelineHomeFirst: "7-6 6-4 7-6",
        projectedWinner: "Hubert Hurkacz",
        topScorelines: [
          { score: "7-6 6-4 7-6", prob: 0.0112, winner: "Hubert Hurkacz" },
          { score: "6-4 7-6 6-3", prob: 0.0098, winner: "Taylor Fritz" },
        ],
        aces: {
          home: {
            expected: 28.6,
            probabilities: { "over_28.5": 0.51, "under_28.5": 0.49 },
            lines: [{ line: 28.5, overProb: 0.51, underProb: 0.49 }],
            basis: "surface split",
            scope: "home",
            name: "Hubert Hurkacz",
          },
          away: {
            expected: 23.1,
            probabilities: { "over_23.5": 0.48, "under_23.5": 0.52 },
            lines: [{ line: 23.5, overProb: 0.48, underProb: 0.52 }],
            basis: "surface split",
            scope: "away",
            name: "Taylor Fritz",
          },
        },
        doubleFaults: {
          home: {
            expected: 1.7,
            probabilities: { "over_1.5": 0.52, "under_1.5": 0.48 },
            lines: [{ line: 1.5, overProb: 0.52, underProb: 0.48 }],
            basis: "surface split",
            scope: "home",
            name: "Hubert Hurkacz",
          },
          away: {
            expected: 3.8,
            probabilities: { "over_3.5": 0.55, "under_3.5": 0.45 },
            lines: [{ line: 3.5, overProb: 0.55, underProb: 0.45 }],
            basis: "surface split",
            scope: "away",
            name: "Taylor Fritz",
          },
        },
        model: {
          mode: "serve-elo",
          pointProbHomeServe: 0.727,
          pointProbAwayServe: 0.702,
          holdHome: 0.898,
          holdAway: 0.871,
          setProbHome: 0.5451,
          shift: 0.213,
          expectedServiceGamesHome: 21.2,
          expectedServiceGamesAway: 21.2,
        },
        notes: ["Match-win probability from the surface ELO gap (47 points on hard)."],
      },
    ],
    unavailable: [],
    unavailableCount: 0,
  };
}

function errorPayload() {
  return {
    error: "Tennis data unavailable — missing Elo or historical data.",
    details: "ATP: [tennis] CRITICAL: No data source reachable. Tennis predictions are unavailable.",
    generatedAt: "2026-09-04T22:00:00.000Z",
    dataStatus: {
      atp: { ok: false, matches: 0, playersRated: 0, error: "no source", sources: [] },
    },
    count: 0,
    matches: [],
    unavailable: [],
  };
}

async function render(fetchImpl: () => Promise<Response>): Promise<string> {
  vi.stubGlobal("fetch", vi.fn(fetchImpl) as unknown as typeof fetch);
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<TennisPage />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container.textContent ?? "";
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("/tennis page", () => {
  it("shows the green data badge and a full match card when data is available", async () => {
    const text = await render(async () => jsonResponse(okPayload()));

    // 🟢 status badge with the per-tour match counts.
    expect(text).toContain("Data loaded: ATP (4,213 matches)");
    expect(text).toContain("🟢");

    // Header: tournament, round, surface, best-of, data quality.
    expect(text).toContain("US Open");
    expect(text).toContain("Round of 16");
    expect(text).toContain("Hard");
    expect(text).toContain("Bo5");
    expect(text).toContain("Real");

    // Players with ELO and rank.
    expect(text).toContain("Hubert Hurkacz");
    expect(text).toContain("Taylor Fritz");
    expect(text).toContain("ELO 1621");
    expect(text).toContain("ELO 1574");
    expect(text).toContain("#21");
    expect(text).toContain("#9");
    // Serve / return rates from real data.
    expect(text).toContain("serve 70.5%");
    expect(text).toContain("return 31.3%");

    // Markets.
    expect(text).toContain("Projected score");
    expect(text).toContain("7-6 6-4 7-6");
    expect(text).toContain("Expected total: 42.4");
    expect(text).toContain("Over 41.5");
    expect(text).toContain("Set Winner");
    expect(text).toContain("Total Games O/U");
    expect(text).toContain("Aces O/U");
    expect(text).toContain("Double Faults O/U");
    expect(text).toContain("Score Distribution");
    expect(text).toContain("Top Scorelines");
    expect(text).toContain("fair odds Hurkacz: 1.77");
  });

  it("shows the error state and no placeholder cards when the API refuses with 503", async () => {
    const text = await render(async () => jsonResponse(errorPayload(), 503));

    expect(text).toContain("Tennis predictions are currently unavailable. Please check back later.");
    expect(text).toContain("🔴");
    expect(text).toContain("Data unavailable");
    // No placeholder match, no invented scoreline or default ELO.
    expect(text).not.toContain("TBD");
    expect(text).not.toContain("ELO 1500");
    expect(text).not.toContain("6-4 6-4");
    expect(text).not.toContain("24.2");
  });

  it("shows the error state when a 200 response carries an error payload", async () => {
    const text = await render(async () => jsonResponse(errorPayload(), 200));
    expect(text).toContain("Tennis predictions are currently unavailable. Please check back later.");
  });
});
