// Unit tests for the API-Football PRE-MATCH path (upcoming fixtures).
//
// Root cause under test: API-Football only publishes /fixtures/statistics for
// LIVE/FINISHED matches. For upcoming fixtures that endpoint returns empty,
// which used to send EVERY match to the synthetic baseline. The fix routes
// pre-match queries to historical team data:
//
//   GET /teams?search={name}(&league={id})        → team id (cached)
//   GET /teams/statistics?league=&season=&team=   → season totals
//   GET /fixtures?team={id}&last=10               → last-10 form (logged)
//
// Season totals are converted to per-match averages. Finished matches keep
// using /fixtures/statistics (settlement must use the real match stats).

import { beforeEach, describe, expect, it } from "vitest";
import { StatsAggregator } from "../aggregator";
import type { HttpResult } from "../http";
import type { MatchStatsQuery, SourcePayload } from "../types";
import type { SourceContext, SourceHandler } from "./context";
import {
  apiFootballSource,
  clearFixtureIdCache,
  clearTeamIdCache,
} from "./apiFootball";

// ─── Canned API-Football responses ───────────────────────────────────────────

/** Arsenal season totals: 5 games played. */
function arsenalSeasonStats(season: number, games = 5) {
  return {
    results: 1,
    response: [
      {
        team: { id: 35, name: "Arsenal", code: "ARS", country: "England" },
        league: { id: 39, name: "Premier League", country: "England", season },
        season,
        statistics: [
          { type: "Games", value: games },
          { type: "Games - Win", value: games },
          { type: "Games - Clean Sheet", value: 3 },
          { type: "Form", value: "WWWWD" },
          { type: "Goals", value: 12 },
          { type: "Goals - Conceded", value: 4 },
          { type: "Expected Goals (xG)", value: 11.5 },
          { type: "Expected Goals Against (xGA)", value: 3.9 },
          { type: "Total Shots", value: 62 },
          { type: "Shots On Goal", value: 24 },
          { type: "Shots Off Goal", value: 30 },
          { type: "Blocked Shots", value: 9 },
          { type: "Corner Kicks", value: 27 },
          { type: "Goal Kicks", value: 121 },
          { type: "Throw-Ins", value: 98 },
          { type: "Free Kicks", value: 61 },
          { type: "Fouls", value: 48 },
          { type: "Offsides", value: 7 },
          { type: "Yellow Cards", value: 4 },
          { type: "Red Cards", value: 0 },
          { type: "Ball Possession %", value: 56.2 },
          { type: "Total Passes", value: 1012 },
          { type: "Passes Accurate", value: 879 },
          { type: "Passes Accurate %", value: 86.8 },
          { type: "Keeper Saves", value: 18 },
          { type: "Clearances", value: 104 },
          { type: "Aerials Won", value: 41 },
          { type: "Dribbles Successful", value: 22 },
          { type: "Interceptions", value: 19 },
          { type: "Tackles", value: 23 },
          { type: "Penalty Goals", value: 2 },
        ],
      },
    ],
  };
}

/** Chelsea season totals: 5 games played (different numbers). */
function chelseaSeasonStats(season: number) {
  return {
    results: 1,
    response: [
      {
        team: { id: 49, name: "Chelsea", code: "CHE", country: "England" },
        league: { id: 39, name: "Premier League", country: "England", season },
        season,
        statistics: [
          { type: "Games", value: 5 },
          { type: "Games - Clean Sheet", value: 1 },
          { type: "Form", value: "WDLWW" },
          { type: "Goals", value: 8 },
          { type: "Goals - Conceded", value: 7 },
          { type: "Expected Goals (xG)", value: 7.6 },
          { type: "Total Shots", value: 50 },
          { type: "Shots On Goal", value: 18 },
          { type: "Shots Off Goal", value: 26 },
          { type: "Blocked Shots", value: 6 },
          { type: "Corner Kicks", value: 20 },
          { type: "Goal Kicks", value: 110 },
          { type: "Throw-Ins", value: 88 },
          { type: "Free Kicks", value: 55 },
          { type: "Fouls", value: 42 },
          { type: "Offsides", value: 5 },
          { type: "Yellow Cards", value: 6 },
          { type: "Red Cards", value: 1 },
          { type: "Ball Possession %", value: 54.9 },
          { type: "Total Passes", value: 940 },
          { type: "Passes Accurate", value: 800 },
          { type: "Passes Accurate %", value: 85.1 },
          { type: "Keeper Saves", value: 21 },
          { type: "Clearances", value: 96 },
          { type: "Aerials Won", value: 33 },
          { type: "Dribbles Successful", value: 17 },
          { type: "Interceptions", value: 15 },
          { type: "Tackles", value: 18 },
          { type: "Penalty Goals", value: 1 },
        ],
      },
    ],
  };
}

/** /teams?search response for a single team. */
function teamSearchResponse(teamId: number, teamName: string) {
  return {
    results: 1,
    response: [
      {
        team: { id: teamId, name: teamName, code: "X", country: "England" },
        country: "England",
      },
    ],
  };
}

/** /fixtures?team={id}&last=10 with a W/D/L record for the queried team. */
function last10Fixtures(teamId: number, teamName: string, w: number, d: number, l: number) {
  const results: Array<{
    fixture: { id: number; date: string; status: { short: string } };
    teams: { home: { id: number; name: string }; away: { id: number; name: string } };
    goals: { home: number; away: number };
  }> = [];
  const opp = { id: 999, name: "Generic Rivals" };
  let n = 0;
  const plan: Array<"W" | "D" | "L"> = [
    ...Array.from({ length: w }, () => "W" as const),
    ...Array.from({ length: d }, () => "D" as const),
    ...Array.from({ length: l }, () => "L" as const),
  ];
  plan.forEach((result, i) => {
    n++;
    const teamGoals = result === "W" ? 2 : result === "D" ? 1 : 0;
    const oppGoals = result === "W" ? 0 : result === "D" ? 1 : 2;
    const home = i % 2 === 0;
    results.push({
      fixture: { id: 1000 + n, date: "2026-09-01T15:00:00Z", status: { short: "FT" } },
      teams: {
        home: home ? { id: teamId, name: teamName } : { ...opp },
        away: home ? { ...opp } : { id: teamId, name: teamName },
      },
      goals: { home: home ? teamGoals : oppGoals, away: home ? oppGoals : teamGoals },
    });
  });
  return { results: results.length, response: results };
}

// ─── Test harness ─────────────────────────────────────────────────────────────

const PRE_MATCH: MatchStatsQuery = {
  leagueSlug: "eng.1",
  eventId: "401879288",
  homeTeam: "Arsenal",
  awayTeam: "Chelsea",
  date: "2026-09-12T15:00:00Z",
  state: "pre",
};

/** A canned response: either ok data or a typed error status. */
type Canned =
  | { ok: unknown }
  | { status: Exclude<HttpResult["status"], "ok">; httpStatus: number | null };

const ok = (data: unknown): Canned => ({ ok: data });
const fail = (status: Exclude<HttpResult["status"], "ok">, httpStatus: number | null): Canned => ({
  status,
  httpStatus,
});

function respond(c: Canned): HttpResult {
  if ("ok" in c) return { status: "ok", data: c.ok, httpStatus: 200 };
  return { status: c.status, httpStatus: c.httpStatus } as HttpResult;
}

interface Harness {
  ctx: SourceContext;
  calls: string[]; // every requested URL, in order
  logs: string[];
  rateLimited: boolean;
}

/**
 * Fake SourceContext. `routes` maps deterministic keys to canned responses:
 *   teams:search:{name}:league:{id}    → /teams?search=&league=
 *   teams:statistics:{team}:{season}   → /teams/statistics?team=&season=
 *   fixtures:last10:{team}             → /fixtures?team=&last=10
 *   fixtures:byDate                    → /fixtures?date=...
 *   fixtures:statistics:{fixtureId}    → /fixtures/statistics?fixture=
 */
function makeHarness(routes: Map<string, Canned>): Harness {
  const calls: string[] = [];
  const logs: string[] = [];
  const rateLimited = { value: false };

  const ctx: SourceContext = {
    env: (name) => (name === "API_FOOTBALL_KEY" ? "test-key" : ""),
    timeoutMs: 5_000,
    now: () => Date.now(),
    log: (message) => logs.push(message),
    reportRateLimit: () => {
      rateLimited.value = true;
    },
    http: async (url) => {
      calls.push(url);
      const u = new URL(url);
      const q = u.searchParams;

      if (u.pathname === "/teams") {
        const key = `teams:search:${q.get("search") ?? ""}:league:${q.get("league") ?? ""}`;
        const c = routes.get(key);
        return c ? respond(c) : { status: "ok", data: { results: 0, response: [] }, httpStatus: 200 };
      }

      if (u.pathname === "/teams/statistics") {
        const key = `teams:statistics:${q.get("team") ?? ""}:${q.get("season") ?? ""}`;
        const c = routes.get(key);
        return c ? respond(c) : { status: "not-found", httpStatus: 404 };
      }

      if (u.pathname === "/fixtures/statistics") {
        const key = `fixtures:statistics:${q.get("fixture") ?? ""}`;
        const c = routes.get(key);
        return c ? respond(c) : { status: "ok", data: { results: 0, response: [] }, httpStatus: 200 };
      }

      if (u.pathname === "/fixtures") {
        if (q.get("last") !== null) {
          const key = `fixtures:last10:${q.get("team") ?? ""}`;
          const c = routes.get(key);
          return c ? respond(c) : { status: "not-found", httpStatus: 404 };
        }
        const c = routes.get("fixtures:byDate");
        return c ? respond(c) : { status: "ok", data: { results: 0, response: [] }, httpStatus: 200 };
      }

      return { status: "not-found", httpStatus: 404 };
    },
  };

  return {
    ctx,
    calls,
    logs,
    get rateLimited() {
      return rateLimited.value;
    },
  };
}

/** URLs of `h` containing `needle`, in order. */
function callsWith(h: Harness, needle: string): string[] {
  return h.calls.filter((u) => u.includes(needle));
}

function standardRoutes(): Map<string, Canned> {
  return new Map<string, Canned>([
    ["teams:search:Arsenal:league:39", ok(teamSearchResponse(35, "Arsenal"))],
    ["teams:search:Chelsea:league:39", ok(teamSearchResponse(49, "Chelsea"))],
    ["teams:statistics:35:2026", ok(arsenalSeasonStats(2026))],
    ["teams:statistics:49:2026", ok(chelseaSeasonStats(2026))],
    ["fixtures:last10:35", ok(last10Fixtures(35, "Arsenal", 6, 3, 1))],
    ["fixtures:last10:49", ok(last10Fixtures(49, "Chelsea", 4, 4, 2))],
  ]);
}

beforeEach(() => {
  clearTeamIdCache();
  clearFixtureIdCache();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("API-Football pre-match path (upcoming fixtures)", () => {
  it("builds per-match averages from /teams/statistics + last-10 form and never calls /fixtures/statistics", async () => {
    const h = makeHarness(standardRoutes());
    const payload = await apiFootballSource.fetch(PRE_MATCH, h.ctx);

    expect(payload).not.toBeNull();

    // Endpoints called — the exact contract of the pre-match chain.
    expect(callsWith(h, "/teams?search=Arsenal&league=39")).toHaveLength(1);
    expect(callsWith(h, "/teams?search=Chelsea&league=39")).toHaveLength(1);
    expect(callsWith(h, "/teams/statistics?")).toHaveLength(2);
    expect(callsWith(h, "/teams/statistics?")).toContain(
      "https://v3.football.api-sports.io/teams/statistics?team=35&season=2026&league=39",
    );
    expect(callsWith(h, "/teams/statistics?")).toContain(
      "https://v3.football.api-sports.io/teams/statistics?team=49&season=2026&league=39",
    );
    expect(callsWith(h, "last=10")).toHaveLength(2);
    expect(callsWith(h, "last=10")).toContain("https://v3.football.api-sports.io/fixtures?team=35&last=10");
    // THE BUG: /fixtures/statistics has no data for upcoming fixtures —
    // and the pre-match path must not even bother calling it.
    expect(callsWith(h, "/fixtures/statistics?")).toHaveLength(0);
    expect(callsWith(h, "/fixtures?date=")).toHaveLength(0);

    // Arsenal: season totals ÷ 5 games → per-match averages.
    const home = payload!.home;
    expect(home.goals).toBe(2.4);
    expect(home.goalsConceded).toBe(0.8);
    expect(home.xg).toBe(2.3);
    expect(home.shots).toBe(12.4);
    expect(home.shotsOnTarget).toBe(4.8);
    expect(home.shotsOffTarget).toBe(6);
    expect(home.blockedShots).toBe(1.8);
    expect(home.corners).toBe(5.4);
    expect(home.fouls).toBe(9.6);
    expect(home.offsides).toBe(1.4);
    expect(home.yellowCards).toBe(0.8);
    expect(home.possession).toBe(56.2); // already a percentage
    expect(home.passes).toBe(202.4);
    expect(home.passAccuracy).toBe(86.8); // already a percentage
    expect(home.saves).toBe(3.6);
    expect(home.xgPerShot).toBe(0.185); // derived 2.3 / 12.4
    expect(home.avgCornersPerGame).toBe(5.4); // historical context
    expect(home.avgCardsPerGame).toBe(0.8); // (4Y + 0R) / 5

    // Chelsea.
    const away = payload!.away;
    expect(away.goals).toBe(1.6);
    expect(away.corners).toBe(4);
    expect(away.fouls).toBe(8.4);
    expect(away.xg).toBe(1.52);
    expect(away.possession).toBe(54.9);
    expect(away.avgCardsPerGame).toBe(1.4); // (6Y + 1R) / 5

    // cleanSheet is a match OUTCOME — unknown pre-match, never fabricated.
    expect(home.cleanSheet).toBeUndefined();
    expect(away.cleanSheet).toBeUndefined();

    // Every step logged.
    const log = h.logs.join("\n");
    expect(log).toContain("[API-Football] Resolved team Arsenal → id 35");
    expect(log).toContain("[API-Football] Resolved team Chelsea → id 49");
    expect(log).toContain("[API-Football] Season stats for Arsenal: 5.4 corners, 9.6 fouls, 2.3 xG");
    expect(log).toContain("[API-Football] Season stats for Chelsea: 4.0 corners, 8.4 fouls, 1.5 xG");
    expect(log).toContain("[API-Football] Last 10: 6W 3D 1L");
    expect(log).toContain("[API-Football] Last 10: 4W 4D 2L");
  });

  it("caches team ids — a second fetch does not re-call /teams?search", async () => {
    const h = makeHarness(standardRoutes());
    await apiFootballSource.fetch(PRE_MATCH, h.ctx);
    expect(callsWith(h, "/teams?search=")).toHaveLength(2);

    await apiFootballSource.fetch(PRE_MATCH, h.ctx);
    expect(callsWith(h, "/teams?search=")).toHaveLength(2); // still 2 — cached
    expect(h.logs.join("\n")).toContain("[API-Football] Using cached team id 35 for Arsenal");
    expect(h.logs.join("\n")).toContain("[API-Football] Using cached team id 49 for Chelsea");
  });

  it("falls back to the previous season when the current one has no games yet", async () => {
    const routes = new Map<string, Canned>([
      ["teams:search:Arsenal:league:39", ok(teamSearchResponse(35, "Arsenal"))],
      ["teams:search:Chelsea:league:39", ok(teamSearchResponse(49, "Chelsea"))],
      ["teams:statistics:35:2026", ok({
        results: 1,
        response: [{ team: { id: 35, name: "Arsenal" }, season: 2026, statistics: [{ type: "Games", value: 0 }] }],
      })],
      ["teams:statistics:35:2025", ok(arsenalSeasonStats(2025))],
      ["teams:statistics:49:2026", ok(chelseaSeasonStats(2026))],
      ["fixtures:last10:35", ok(last10Fixtures(35, "Arsenal", 6, 3, 1))],
      ["fixtures:last10:49", ok(last10Fixtures(49, "Chelsea", 4, 4, 2))],
    ]);
    const h = makeHarness(routes);
    const payload = await apiFootballSource.fetch(PRE_MATCH, h.ctx);

    // Arsenal: 2026 had 0 games → 2025 used. Chelsea: 2026 was fine.
    expect(callsWith(h, "team=35&season=2026")).toHaveLength(1);
    expect(callsWith(h, "team=35&season=2025")).toHaveLength(1);
    expect(callsWith(h, "team=49&season=2025")).toHaveLength(0);
    expect(payload!.home.goals).toBe(2.4); // from the 2025 season
    expect(payload!.away.goals).toBe(1.6);
    expect(h.logs.join("\n")).toContain(
      "No season statistics with games played for Arsenal (season 2026)",
    );
  });

  it("unknown state + empty match stats → historical fallback (legacy callers still get pre-match data)", async () => {
    const scheduled = {
      results: 1,
      response: [
        {
          fixture: { id: 505_001, date: "2026-09-12T15:00:00Z", status: { short: "NS" } },
          league: { id: 39, name: "Premier League" },
          teams: { home: { id: 35, name: "Arsenal" }, away: { id: 49, name: "Chelsea" } },
          goals: { home: null, away: null },
        },
      ],
    };
    const routes = new Map<string, Canned>([
      ...standardRoutes(),
      ["fixtures:byDate", ok(scheduled)],
      // /fixtures/statistics for an upcoming fixture: 200 with an empty body.
      ["fixtures:statistics:505001", ok({ results: 0, response: [] })],
    ]);
    const h = makeHarness(routes);
    const query: MatchStatsQuery = { ...PRE_MATCH, state: undefined };

    const payload = await apiFootballSource.fetch(query, h.ctx);

    expect(payload).not.toBeNull();
    expect(payload!.home.goals).toBe(2.4);
    // The empty /fixtures/statistics call happened, then the fallback kicked in.
    expect(callsWith(h, "/fixtures/statistics?")).toHaveLength(1);
    expect(callsWith(h, "/teams/statistics?")).toHaveLength(2);
    expect(h.logs.join("\n")).toContain(
      "No match statistics for this fixture — falling back to pre-match historical team stats",
    );
  });

  it("finished match (state post) never substitutes season averages for empty match stats", async () => {
    const finished = {
      results: 1,
      response: [
        {
          fixture: { id: 505_002, date: "2026-09-05T15:00:00Z", status: { short: "FT" } },
          league: { id: 39, name: "Premier League" },
          teams: { home: { id: 35, name: "Arsenal" }, away: { id: 49, name: "Chelsea" } },
          goals: { home: 2, away: 1 },
        },
      ],
    };
    const routes = new Map<string, Canned>([
      ["fixtures:byDate", ok(finished)],
      // Statistics unavailable (e.g. API lag) — settlement must NOT get averages.
      ["fixtures:statistics:505002", ok({ results: 0, response: [] })],
    ]);
    const h = makeHarness(routes);
    const query: MatchStatsQuery = { ...PRE_MATCH, date: "2026-09-05T15:00:00Z", state: "post" };

    const payload = await apiFootballSource.fetch(query, h.ctx);

    expect(payload).toBeNull();
    expect(callsWith(h, "/teams/statistics?")).toHaveLength(0);
    expect(callsWith(h, "/teams?search=")).toHaveLength(0);
  });

  it("live match (state in) keeps using /fixtures/statistics", async () => {
    const live = {
      results: 1,
      response: [
        {
          fixture: { id: 505_003, date: "2026-09-12T15:00:00Z", status: { short: "1H" } },
          league: { id: 39, name: "Premier League" },
          teams: { home: { id: 35, name: "Arsenal" }, away: { id: 49, name: "Chelsea" } },
          goals: { home: 1, away: 0 },
        },
      ],
    };
    const fixtureStats = {
      results: 2,
      response: [
        {
          team: { id: 35, name: "Arsenal" },
          statistics: [
            { type: "Total Shots", value: 8 },
            { type: "Shots on Goal", value: 3 },
            { type: "Corner Kicks", value: 4 },
          ],
        },
        {
          team: { id: 49, name: "Chelsea" },
          statistics: [
            { type: "Total Shots", value: 5 },
            { type: "Shots on Goal", value: 1 },
            { type: "Corner Kicks", value: 2 },
          ],
        },
      ],
    };
    const routes = new Map<string, Canned>([
      ["fixtures:byDate", ok(live)],
      ["fixtures:statistics:505003", ok(fixtureStats)],
    ]);
    const h = makeHarness(routes);
    const query: MatchStatsQuery = { ...PRE_MATCH, state: "in" };

    const payload = await apiFootballSource.fetch(query, h.ctx);

    expect(payload).not.toBeNull();
    expect(payload!.home.shots).toBe(8);
    expect(payload!.away.corners).toBe(2);
    expect(callsWith(h, "/teams/statistics?")).toHaveLength(0);
    expect(callsWith(h, "/teams?search=")).toHaveLength(0);
  });

  it("team lookup failure → logs 'No team stats found' and returns the other team's data", async () => {
    const routes = new Map<string, Canned>([
      ["teams:search:Arsenal:league:39", ok(teamSearchResponse(35, "Arsenal"))],
      // Chelsea search returns nothing.
      ["teams:search:Chelsea:league:39", ok({ results: 0, response: [] })],
      ["teams:statistics:35:2026", ok(arsenalSeasonStats(2026))],
      ["fixtures:last10:35", ok(last10Fixtures(35, "Arsenal", 6, 3, 1))],
    ]);
    const h = makeHarness(routes);

    const payload = await apiFootballSource.fetch(PRE_MATCH, h.ctx);

    expect(payload).not.toBeNull();
    expect(payload!.home.goals).toBe(2.4);
    expect(Object.keys(payload!.away)).toHaveLength(0);
    expect(h.logs.join("\n")).toContain(
      "[API-Football] No team stats found for Chelsea (team id could not be resolved)",
    );
  });

  it("caches pre and post match stats under separate keys (no state shadowing)", async () => {
    const payloads: Record<string, SourcePayload> = {
      pre: { home: { corners: 5.4, fouls: 9.6 }, away: { corners: 4, fouls: 8.4 } },
      post: { home: { goals: 2, corners: 7 }, away: { goals: 1, corners: 3 } },
    };
    const handler: SourceHandler = {
      name: "API-Football",
      capabilities: ["corners", "fouls", "goals"],
      available: () => true,
      fetch: async (m) => payloads[m.state ?? "post"] ?? null,
    };
    const agg = new StatsAggregator({ handlers: { "API-Football": handler } });
    const base: MatchStatsQuery = {
      leagueSlug: "eng.1", eventId: "e1", homeTeam: "A", awayTeam: "B", date: "2026-09-12",
    };

    const pre = await agg.fetch({ ...base, state: "pre" });
    const post = await agg.fetch({ ...base, state: "post" });

    // The post-match entry must NOT be the pre-match averages (or vice versa).
    expect(pre!.home.corners).toBe(5.4);
    expect(post!.home.goals).toBe(2);
    const keys = agg.snapshot().map((e) => e.key);
    expect(keys).toContain("stats:eng.1:e1:pre");
    expect(keys).toContain("stats:eng.1:e1:post");
  });

  it("429 on any pre-match call reports the rate limit (cooldown arm)", async () => {
    const routes = new Map<string, Canned>([
      ["teams:search:Arsenal:league:39", fail("rate-limited", 429)],
      ["teams:search:Chelsea:league:39", ok(teamSearchResponse(49, "Chelsea"))],
      ["teams:statistics:49:2026", ok(chelseaSeasonStats(2026))],
      ["fixtures:last10:49", ok(last10Fixtures(49, "Chelsea", 4, 4, 2))],
    ]);
    const h = makeHarness(routes);

    const payload = await apiFootballSource.fetch(PRE_MATCH, h.ctx);

    // Arsenal lookup 429s; Chelsea still succeeds (independent lookup).
    expect(payload!.away.goals).toBe(1.6);
    expect(Object.keys(payload!.home)).toHaveLength(0);
    expect(h.rateLimited).toBe(true);
  });
});
