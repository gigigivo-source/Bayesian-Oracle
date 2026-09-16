// Tests for the /api/backtest calibration route.
//
// The ESPN fetch boundary — @/lib/espn's fetchScoreboard, the only network
// edge the route touches — is mocked to return two finished matches with
// known scores: a 2-1 (ger.1) and a 0-0 (ned.1). The REAL engine then runs
// against the blind pre-match fixtures the route builds, so every claimed
// hit rate below is genuine engine output for those teams (the engine seeds
// its RNG from team names + date, hence the specific fixtures and dates).
//
// The two leagues are chosen so their predictions collide usefully:
//   • the 2-1 match's Total Goals O/U 2.5 picks Over 2.5 (3 goals → hit) and
//     its O/U 0.5 claims [0.80, 0.85) (3 goals → hit);
//   • the 0-0 match's O/U 0.5 claims the same [0.80, 0.85) bucket and misses;
//   • five predictions land in the 0.55 bucket, enough to survive the route's
//     n >= 5 emission threshold with only two matches.
//
// Note: no fixture pair can also demonstrate "Under 2.5 on a 3-goal match
// counts as a miss" — the engine only selects Under 2.5 for low-λ leagues
// (arg.1 and friends), and such a fixture contributes too few predictions to
// any single bucket for a two-match mock to clear the n >= 5 threshold. The
// under-direction is covered by the Under 3.5 / Under 4.5 hits, and the full
// expected-table equality pins the route's over/under/BTTS measurement rule
// for every prediction it emits.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FixtureLite, TeamLite } from "@/lib/espn";

// The route (via @/lib/engine → ./dataMesh) statically imports @/db; mock it
// so the tests run without a DATABASE_URL — same convention as
// scannerCoverage.test.ts and engine.test.ts.
vi.mock("@/db", () => ({ db: {}, pool: {} }));

// The ESPN fetch boundary. The route calls fetchScoreboard(slug, "YYYYMMDD")
// once per league per day — always a single day, never a multi-day range.
const fetchScoreboard = vi.fn<(slug: string, dates?: string) => Promise<FixtureLite[]>>();
vi.mock("@/lib/espn", () => ({
  fetchScoreboard: (slug: string, dates?: string) => fetchScoreboard(slug, dates),
}));

import { POST } from "./route";
import { runEngineFromReal } from "@/lib/engine";

type EngineMarket = ReturnType<typeof runEngineFromReal>["markets"][number];

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function team(name: string, abbrev: string, homeAway: "home" | "away", score: string | null): TeamLite {
  return {
    id: `${abbrev.toLowerCase()}-${homeAway}`,
    name,
    shortName: name,
    abbrev,
    logo: null,
    color: null,
    score,
    homeAway,
    record: null,
    form: null,
  };
}

function finishedFixture(
  id: string,
  slug: string,
  leagueName: string,
  date: string,
  home: [name: string, abbrev: string, score: string],
  away: [name: string, abbrev: string, score: string],
): FixtureLite {
  return {
    id,
    leagueSlug: slug,
    leagueName,
    date,
    state: "post",
    statusDetail: "FT",
    venue: null,
    home: team(home[0], home[1], "home", home[2]),
    away: team(away[0], away[1], "away", away[2]),
    neutralSite: false,
    odds: null,
  };
}

// 2-1 — Bundesliga anchors: the engine's O/U 2.5 picks Over 2.5.
const MATCH_2_1 = finishedFixture(
  "bt-1",
  "ger.1",
  "German Bundesliga",
  "2026-09-15T18:30:00Z",
  ["Bayern München", "BAY", "2"],
  ["Borussia Dortmund", "BOR", "1"],
);

// 0-0 — Eredivisie anchors: the Over picks all miss, the Unders all hit.
const MATCH_0_0 = finishedFixture(
  "bt-2",
  "ned.1",
  "Dutch Eredivisie",
  "2026-09-10T19:00:00Z",
  ["SC Cambuur", "CAM", "0"],
  ["De Graafschap", "GRA", "0"],
);

// ─── Test-side oracle: the route's rules, re-derived independently ────────────

interface Prediction {
  name: string;
  selection: string;
  hitRate: number;
  hit: boolean;
}

interface ResponseBucket {
  claimed: number;
  n: number;
  hits: number;
  actual: number;
  diff: number;
}

interface BacktestResponse {
  ok: boolean;
  elapsedMs: number;
  matchesFound: number;
  matchesProcessed: number;
  totalPredictions: number;
  buckets: ResponseBucket[];
}

/** The blind pre-match fixture the route must build from a finished match. */
function blindFixture(fx: FixtureLite): FixtureLite {
  const blind = (t: TeamLite, homeAway: "home" | "away"): TeamLite => ({
    id: t.id,
    name: t.name,
    shortName: t.shortName,
    abbrev: t.abbrev,
    logo: null,
    color: null,
    score: null,
    homeAway,
    record: null,
    form: null,
  });
  return {
    id: fx.id,
    leagueSlug: fx.leagueSlug,
    leagueName: fx.leagueName,
    date: fx.date,
    state: "pre",
    statusDetail: "Scheduled",
    venue: null,
    home: blind(fx.home, "home"),
    away: blind(fx.away, "away"),
    neutralSite: false,
    odds: null,
  };
}

/** The route's market filters + outcome measurement, re-implemented here. */
function measurePredictions(markets: EngineMarket[], homeScore: number, awayScore: number): Prediction[] {
  const out: Prediction[] = [];
  for (const m of markets) {
    if (m.family !== "Goals") continue;
    if (typeof m.hitRate !== "number" || !Number.isFinite(m.hitRate) || m.hitRate < 0.5) continue;

    let hit: boolean;
    if (m.name.startsWith("Total Goals O/U")) {
      const line = Number(/O\/U\s+([\d.]+)/.exec(m.name)?.[1]);
      if (!Number.isFinite(line)) continue;
      const total = homeScore + awayScore;
      hit = m.selection.startsWith("Over") ? total > line : total < line;
    } else if (m.name === "Both Teams To Score") {
      const btts = homeScore >= 1 && awayScore >= 1;
      hit = m.selection === "Yes" ? btts : !btts;
    } else {
      continue;
    }
    out.push({ name: m.name, selection: m.selection, hitRate: m.hitRate, hit });
  }
  return out;
}

/** The route's bucketing: floor(hitRate / 0.05), n >= 5 only, ascending. */
function expectedBuckets(predictions: Prediction[]): ResponseBucket[] {
  const byIdx = new Map<number, { n: number; hits: number }>();
  for (const p of predictions) {
    const idx = Math.floor(p.hitRate * 20 + 1e-6);
    const b = byIdx.get(idx) ?? { n: 0, hits: 0 };
    b.n += 1;
    b.hits += p.hit ? 1 : 0;
    byIdx.set(idx, b);
  }
  const round4 = (v: number) => Math.round(v * 10000) / 10000;
  return Array.from(byIdx.entries())
    .filter(([, b]) => b.n >= 5)
    .map(([idx, b]) => {
      const claimed = idx / 20;
      const actual = b.hits / b.n;
      return { claimed, n: b.n, hits: b.hits, actual: round4(actual), diff: round4(actual - claimed) };
    })
    .sort((a, b) => a.claimed - b.claimed);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/api/backtest — calibration bucket table", () => {
  beforeEach(() => {
    fetchScoreboard.mockReset();
    fetchScoreboard.mockImplementation(async (slug) =>
      slug === "ger.1" ? [MATCH_2_1] : slug === "ned.1" ? [MATCH_0_0] : [],
    );
  });

  async function runRoute(): Promise<BacktestResponse> {
    const res = await POST(
      new Request("http://localhost/api/backtest?days=1&leagues=ger.1,ned.1", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as BacktestResponse;
  }

  it("processes both finished matches and returns at least one bucket with n >= 1", async () => {
    const data = await runRoute();

    expect(data.ok).toBe(true);
    expect(data.matchesFound).toBe(2);
    expect(data.matchesProcessed).toBe(2);
    expect(data.totalPredictions).toBeGreaterThan(0);
    expect(data.buckets.length).toBeGreaterThan(0);
    expect(data.buckets.some((b) => b.n >= 1)).toBe(true);

    // One fetch per league, and always a single day — never a multi-day range.
    expect(fetchScoreboard).toHaveBeenCalledTimes(2);
    expect(fetchScoreboard).toHaveBeenCalledWith("ger.1", expect.stringMatching(/^\d{8}$/));
    expect(fetchScoreboard).toHaveBeenCalledWith("ned.1", expect.stringMatching(/^\d{8}$/));
  });

  it("counts an [0.80, 0.85) Over on the 2-1 match as a hit and the same-bucket market on the 0-0 match as a miss", async () => {
    const predictions21 = measurePredictions(runEngineFromReal(blindFixture(MATCH_2_1), null).markets, 2, 1);
    const predictions00 = measurePredictions(runEngineFromReal(blindFixture(MATCH_0_0), null).markets, 0, 0);

    // The [0.80, 0.85) claims are Total Goals O/U overs. On the 2-1 match
    // (3 goals) every one of them is a hit; on the 0-0 match every one
    // resolves to the under side of its line and misses.
    const top21 = predictions21.filter((p) => p.hitRate >= 0.8 && p.hitRate < 0.85);
    const top00 = predictions00.filter((p) => p.hitRate >= 0.8 && p.hitRate < 0.85);
    expect(top21.length).toBeGreaterThan(0);
    expect(top00.length).toBeGreaterThan(0);
    expect(top21.every((p) => p.name.startsWith("Total Goals O/U") && p.selection.startsWith("Over"))).toBe(true);
    expect(top21.every((p) => p.hit)).toBe(true);
    expect(top00.every((p) => !p.hit)).toBe(true);

    // Over 2.5 on the 2-1 match is a hit; the same market on the 0-0 match
    // resolves to Under 2.5 and misses.
    const over25a = predictions21.find((p) => p.name === "Total Goals O/U 2.5");
    const over25b = predictions00.find((p) => p.name === "Total Goals O/U 2.5");
    expect(over25a?.selection).toBe("Over 2.5");
    expect(over25a?.hit).toBe(true);
    expect(over25b?.selection).toBe("Over 2.5");
    expect(over25b?.hit).toBe(false);

    // Under-direction: Unders hit when the goal count is below the line.
    const under35a = predictions21.find((p) => p.name === "Total Goals O/U 3.5");
    expect(under35a?.selection).toBe("Under 3.5");
    expect(under35a?.hit).toBe(true); // 3 < 3.5
    const under45b = predictions00.find((p) => p.name === "Total Goals O/U 4.5");
    expect(under45b?.selection).toBe("Under 4.5");
    expect(under45b?.hit).toBe(true); // 0 < 4.5

    // BTTS: Yes hits on 2-1, misses on 0-0.
    const bttsA = predictions21.find((p) => p.name === "Both Teams To Score");
    const bttsB = predictions00.find((p) => p.name === "Both Teams To Score");
    expect(bttsA?.selection).toBe("Yes");
    expect(bttsA?.hit).toBe(true);
    expect(bttsB?.hit).toBe(false);

    // And the route's response reflects exactly these measurements.
    const data = await runRoute();
    expect(data.totalPredictions).toBe(predictions21.length + predictions00.length);
    expect(data.buckets).toEqual(expectedBuckets([...predictions21, ...predictions00]));
  });
});
