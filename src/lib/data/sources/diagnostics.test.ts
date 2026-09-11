// Source-level tests for the fixture-id resolution, 403 diagnostics, league
// gates and the aggregator's end-of-walk summary + diagnostics trace.
//
// The global `fetch` is stubbed per test; sources go through the real
// fail-soft HTTP layer, so status classification (403 / 404 / rate-limit)
// behaves exactly as in production.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "../http";
import { StatsAggregator } from "../aggregator";
import type { SourceContext, SourceHandler } from "./context";
import type { MatchStatsQuery } from "../types";

import {
  apiFootballSource,
  checkApiFootballKey,
  clearFixtureIdCache,
  footballSeason,
  LEAGUE_IDS,
} from "./apiFootball";
import { statsbombSource } from "./statsbomb";
import {
  findFbrefMatchId,
  fbrefSource,
  resetFbrefRateLimiter,
} from "./fbref";
import {
  leagueCovered,
  worldcup2026Source,
} from "./worldcup2026";
import {
  findUnderstatMatchId,
  understatSource,
} from "./understat";
import {
  thesportsdbSource,
  resetTheSportsDbNotice,
} from "./thesportsdb";
import { highlightlySource } from "./highlightly";
import { githubDatasetsSource } from "./githubDatasets";

const MATCH: MatchStatsQuery = {
  leagueSlug: "eng.1",
  eventId: "401879288",
  homeTeam: "Arsenal",
  awayTeam: "Chelsea",
  date: "2026-08-21T19:00:00Z",
};

// ─── stub helpers ─────────────────────────────────────────────────────────────

interface Route {
  match: RegExp;
  status?: number;
  body: unknown;
}

function stubFetch(routes: Route[]): { calls: string[]; headers: Record<string, Record<string, string>> } {
  const calls: string[] = [];
  const headers: Record<string, Record<string, string>> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      calls.push(u);
      headers[u] = (init?.headers ?? {}) as Record<string, string>;
      for (const r of routes) {
        if (r.match.test(u)) {
          const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
          return new Response(body, {
            status: r.status ?? 200,
            headers: { "content-type": typeof r.body === "string" ? "text/html" : "application/json" },
          });
        }
      }
      return new Response(JSON.stringify({ error: "no route" }), { status: 500 });
    }),
  );
  return { calls, headers };
}

function makeCtx(env: Record<string, string> = {}, lines: string[] = [], reportRateLimit?: (reason?: string) => void): SourceContext {
  return {
    http: (u, o) => fetchWithTimeout(u, o),
    env: (n) => (env[n] ?? "").trim(),
    timeoutMs: 4000,
    now: () => Date.now(),
    log: (m) => lines.push(m),
    ...(reportRateLimit ? { reportRateLimit } : {}),
  };
}

const ENV_KEYS = ["API_FOOTBALL_KEY", "FOOTBALL_API_KEY", "THESPORTSDB_KEY", "HIGHLIGHTLY_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  clearFixtureIdCache();
  resetFbrefRateLimiter();
  resetTheSportsDbNotice();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─── API-Football: fixture id resolution (Problems 1 + 2) ────────────────────

describe("API-Football fixture resolution", () => {
  const fixturesList = {
    errors: [],
    results: 1,
    response: [
      {
        fixture: { id: 9988877, date: "2026-08-21T19:00:00Z" },
        teams: { home: { name: "Arsenal" }, away: { name: "Chelsea" } },
        goals: { home: 1, away: 2 },
      },
    ],
  };
  const statsBody = {
    errors: [],
    results: 2,
    response: [
      {
        team: { name: "Arsenal" },
        statistics: [
          { type: "Total Shots", value: "14" },
          { type: "Expected Goals (xG)", value: "1.4" },
          { type: "Ball Possession %", value: "55%" },
        ],
      },
      {
        team: { name: "Chelsea" },
        statistics: [
          { type: "Total Shots", value: "9" },
          { type: "Expected Goals (xG)", value: "0.9" },
          { type: "Ball Possession %", value: "45%" },
        ],
      },
    ],
  };

  it("queries /fixtures by date + league + season and resolves the real fixture id", async () => {
    process.env.API_FOOTBALL_KEY = "test-key";
    const { calls } = stubFetch([
      { match: /\/fixtures\?date=2026-08-21&league=39&season=2026/, body: fixturesList },
      { match: /\/fixtures\/statistics\?fixture=9988877/, body: statsBody },
    ]);
    const lines: string[] = [];
    const payload = await apiFootballSource.fetch(MATCH, makeCtx({}, lines));

    expect(payload).not.toBeNull();
    expect(payload!.home.shots).toBe(14);
    expect(payload!.home.xg).toBe(1.4);
    expect(payload!.home.possession).toBe(55);
    expect(payload!.away.goals).toBe(2);
    expect(payload!.home.goals).toBe(1);
    expect(payload!.home.cleanSheet).toBe(false);

    // League id map: eng.1 → 39; season from an August date is the same year.
    expect(calls[0]).toContain("date=2026-08-21");
    expect(calls[0]).toContain("league=39");
    expect(calls[0]).toContain("season=2026");
    expect(calls[1]).toContain("fixture=9988877");
    expect(lines.some((l) => l.includes("[API-Football] Resolved fixture 9988877 for Arsenal vs Chelsea"))).toBe(true);
  });

  it("caches the resolved fixture id — a repeated query never re-looks-up", async () => {
    process.env.API_FOOTBALL_KEY = "test-key";
    const { calls } = stubFetch([
      { match: /\/fixtures\?date=2026-08-21/, body: fixturesList },
      { match: /\/fixtures\/statistics\?fixture=9988877/, body: statsBody },
    ]);
    const ctx = makeCtx({});
    await apiFootballSource.fetch(MATCH, ctx);
    await apiFootballSource.fetch(MATCH, ctx);

    const fixtureLookups = calls.filter((u) => /\/fixtures\?/.test(u));
    const statsCalls = calls.filter((u) => /\/fixtures\/statistics/.test(u));
    expect(fixtureLookups).toHaveLength(1); // second fetch hit the cache
    expect(statsCalls).toHaveLength(2);
  });

  it("computes the football season from the match date", () => {
    expect(footballSeason("2026-08-21")).toBe(2026); // Aug → new season starts
    expect(footballSeason("2026-03-05")).toBe(2025); // March → previous year
    expect(footballSeason("2027-01-10")).toBe(2026);
  });

  it("logs the exact 403 body, classifies it and arms the rate-limit backoff", async () => {
    process.env.API_FOOTBALL_KEY = "test-key";
    const body403 = {
      errors: [{ code: 1004, info: "Your daily requests limit has been reached" }],
      results: 0,
      response: [],
    };
    stubFetch([
      { match: /\/fixtures\?/, status: 403, body: body403 },
    ]);
    const lines: string[] = [];
    const rateLimitCalls: string[] = [];
    const ctx = makeCtx({}, lines, (reason) => rateLimitCalls.push(reason ?? ""));

    const payload = await apiFootballSource.fetch(MATCH, ctx);
    expect(payload).toBeNull();

    // Exact body printed (once — repeated 403s across fallback URLs are deduped).
    const bodyLines = lines.filter((l) => l.includes("response body:"));
    expect(bodyLines).toHaveLength(1);
    expect(bodyLines[0]).toContain("Your daily requests limit has been reached");
    expect(lines.some((l) => l.includes("403 classification: RATE LIMIT"))).toBe(true);
    expect(rateLimitCalls.length).toBeGreaterThan(0);

    // Negative result is cached — the retry does not hit the network again.
    const { calls: secondCalls } = stubFetch([
      { match: /\/fixtures\?/, status: 403, body: body403 },
    ]);
    await apiFootballSource.fetch(MATCH, makeCtx({}));
    expect(secondCalls).toHaveLength(0);
  });
});

// ─── API-Football: key health check (Problem 1) ──────────────────────────────

describe("checkApiFootballKey", () => {
  it("reports no-key cleanly without any network call", async () => {
    delete process.env.API_FOOTBALL_KEY;
    delete process.env.FOOTBALL_API_KEY;
    const { calls } = stubFetch([]);
    const lines: string[] = [];
    const report = await checkApiFootballKey({ log: (m) => lines.push(m) });
    expect(report.configured).toBe(false);
    expect(report.valid).toBeNull();
    expect(calls).toHaveLength(0);
    expect(lines.some((l) => l.includes("NO KEY CONFIGURED"))).toBe(true);
  });

  it("verifies a valid key against /status", async () => {
    process.env.API_FOOTBALL_KEY = "test-key";
    stubFetch([
      { match: /\/status$/, body: { errors: [], results: 202, response: [] } },
    ]);
    const lines: string[] = [];
    const report = await checkApiFootballKey({ log: (m) => lines.push(m) });
    expect(report.valid).toBe(true);
    expect(report.resultsCount).toBe(202);
    expect(lines.some((l) => l.includes("key check: OK"))).toBe(true);
  });

  it("logs the exact body when the key is rejected", async () => {
    process.env.API_FOOTBALL_KEY = "expired-key";
    stubFetch([
      {
        match: /\/status$/,
        status: 403,
        body: { errors: [{ code: 1003, info: "Invalid API key. Please log in to your account in order to obtain your API key." }], results: 0, response: [] },
      },
    ]);
    const lines: string[] = [];
    const report = await checkApiFootballKey({ log: (m) => lines.push(m) });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes("Invalid API key"))).toBe(true);
    expect(lines.some((l) => l.includes("key check: REJECTED"))).toBe(true);
  });
});

// ─── TheSportsDB: free test key default (Problem 5) ──────────────────────────

describe("TheSportsDB", () => {
  it("always available and falls back to the free test key 3 with a log", async () => {
    delete process.env.THESPORTSDB_KEY;
    const { calls } = stubFetch([
      {
        match: /\/api\/v1\/json\/3\/events\.php\?id=123456/,
        body: {
          event: [
            {
              idEvent: "123456",
              strHomeTeam: "Arsenal",
              strAwayTeam: "Chelsea",
              intHomeScore: "1",
              intAwayScore: "2",
              intHomeShots: "14",
            },
          ],
        },
      },
    ]);
    const lines: string[] = [];
    const available = thesportsdbSource.available(MATCH, makeCtx({}, lines));
    expect(available).toBe(true);

    const payload = await thesportsdbSource.fetch(
      { ...MATCH, eventId: "tsdb:123456" },
      makeCtx({}, lines),
    );
    expect(payload).not.toBeNull();
    expect(payload!.away.goals).toBe(2);
    expect(calls[0]).toContain("/api/v1/json/3/events.php");
    expect(lines.some((l) => l.includes("[TheSportsDB] Using free test key (rate-limited)."))).toBe(true);
  });
});

// ─── worldcup2026: covered-league gate (Problem 7) ───────────────────────────

describe("worldcup2026 gate", () => {
  it("skips uncovered leagues with a clear log, before any request", async () => {
    const { calls } = stubFetch([]);
    const lines: string[] = [];
    const available = worldcup2026Source.available(MATCH, makeCtx({}, lines));
    expect(available).toBe(false);
    expect(calls).toHaveLength(0);
    expect(lines.some((l) => l.includes("[worldcup2026] League not covered — skipping."))).toBe(true);
  });

  it("allows the World Cup slugs through", () => {
    expect(leagueCovered("fifa.world")).toBe(true);
    expect(leagueCovered("fifa.worldcup")).toBe(true);
    expect(leagueCovered("eng.1")).toBe(false);
  });
});

// ─── StatsBomb: graceful skip for missing matches (Problem 3) ────────────────

describe("StatsBomb", () => {
  it("skips with a clear log when the match is not in the open data", async () => {
    // competitions.json with only a historical 2017/18 Premier League season:
    // no candidate season covers 2026 → nothing to fetch, clean skip.
    stubFetch([
      {
        match: /competitions\.json$/,
        body: [
          { competition_id: 2, season_id: 31, season_name: "2017/2018", competition_name: "Barclays Premier League" },
        ],
      },
    ]);
    const lines: string[] = [];
    const payload = await statsbombSource.fetch(MATCH, makeCtx({}, lines));
    expect(payload).toBeNull();
    expect(lines.some((l) => l.includes("[StatsBomb] Match 401879288 not in StatsBomb open data — skipping."))).toBe(true);
  });
});

// ─── FBref: id resolution + headers + 403 handling (Problem 4) ───────────────

describe("FBref", () => {
  const scheduleHtml = `
    <table>
      <tr>
        <td class="fw-bold">Aug 21</td>
        <td><span class="table_team table_home"><a href="/en/squads/123/Arsenal">Arsenal</a></span></td>
        <td class="score">1</td>
        <td><span class="table_team table_away"><a href="/en/squads/456/Chelsea">Chelsea</a></span></td>
        <td><a href="/en/matches/abc12345/2026-08-21/Arsenal-vs-Chelsea">match report</a></td>
      </tr>
      <tr>
        <td class="fw-bold">Aug 22</td>
        <td><span class="table_team table_home"><a href="/en/squads/789/Liverpool">Liverpool</a></span></td>
        <td class="score">2</td>
        <td><span class="table_team table_away"><a href="/en/squads/321/Spurs">Tottenham</a></span></td>
        <td><a href="/en/matches/ffff0000/2026-08-22/Liverpool-vs-Tottenham">match report</a></td>
      </tr>
    </table>`;
  const matchHtml = `
    <table class="stats">
      <tr><th>Possession %</th><td>55</td><td>45</td></tr>
      <tr><th>Expected Goals (xG)</th><td>1.5</td><td>0.8</td></tr>
      <tr><th>Shots on target</th><td>7</td><td>4</td></tr>
    </table>`;

  it("finds the FBref hex id on the schedule page (fixture URL pattern)", () => {
    const id = findFbrefMatchId(scheduleHtml, MATCH);
    expect(id).toBe("abc12345");
    // The reversed pair must not match the row.
    expect(findFbrefMatchId(scheduleHtml, { ...MATCH, homeTeam: "Chelsea", awayTeam: "Arsenal" })).toBeNull();
  });

  it("resolves via the schedule, sends browser headers + Referer, and parses the match page", async () => {
    const { calls, headers } = stubFetch([
      { match: /\/comps\/9\/schedule\/2026\/Premier-League-Schedule-and-Results/, body: scheduleHtml },
      { match: /\/en\/matches\/abc12345\//, body: matchHtml },
      { match: /\/en\/comps\/9\//, body: "<table></table>" },
    ]);
    const lines: string[] = [];
    const payload = await fbrefSource.fetch(MATCH, makeCtx({}, lines));
    expect(payload).not.toBeNull();
    expect(payload!.home.possession).toBe(55);
    expect(payload!.home.xg).toBe(1.5);
    expect(calls[0]).toContain("/comps/9/schedule/2026/Premier-League-Schedule-and-Results");
    expect(calls[1]).toContain("/en/matches/abc12345/");
    expect(headers[calls[1]].Referer).toBe("https://fbref.com/");
    expect(headers[calls[1]]["User-Agent"]).toContain("Mozilla/5.0");
    expect(lines.some((l) => l.includes("[FBref] Resolved match id abc12345"))).toBe(true);
  });

  it("logs clearly and moves on when FBref 403s the schedule lookup", async () => {
    stubFetch([
      { match: /\/comps\/9\/schedule\//, status: 403, body: "Access denied" },
    ]);
    const lines: string[] = [];
    const payload = await fbrefSource.fetch(MATCH, makeCtx({}, lines));
    expect(payload).toBeNull();
    expect(lines.some((l) => l.includes("[FBref] HTTP 403") && l.includes("blocked"))).toBe(true);
  });

  it("respects the fbref: namespaced id and skips resolution", async () => {
    const { calls } = stubFetch([
      { match: /\/en\/matches\/ffff0000\//, body: matchHtml },
      { match: /\/en\/comps\/9\//, body: "<table></table>" },
    ]);
    await fbrefSource.fetch({ ...MATCH, eventId: "fbref:ffff0000" }, makeCtx({}));
    expect(calls.some((u) => u.includes("/schedule/"))).toBe(false);
  });
});

// ─── Understat: schedule-based id resolution (Problem 9) ─────────────────────

describe("Understat", () => {
  const scheduleHtml = `
    <table>
      <tr><td>21.08.26</td><td><a href="/match/1234567">Arsenal</a> - <a href="/match/1234567">Chelsea</a></td><td>1 - 2</td></tr>
      <tr><td>22.08.26</td><td><a href="/match/7654321">Man City</a> - <a href="/match/7654321">Wolves</a></td><td>3 - 0</td></tr>
    </table>`;
  const matchHtml = `
    <script>
    var teamsData = JSON.parse('{"h":{"title":"Arsenal"},"a":{"title":"Chelsea"}}');
    var shotsData = JSON.parse('[{"xG":0.4,"h_a":"h","result":"Goal"},{"xG":0.1,"h_a":"a","result":"No result"},{"xG":0.2,"h_a":"a","result":"No result"}]');
    </script>`;

  it("resolves the match id from the season schedule by date + teams", () => {
    expect(findUnderstatMatchId(scheduleHtml, MATCH)).toBe("1234567");
    // Different date → no row matches.
    expect(findUnderstatMatchId(scheduleHtml, { ...MATCH, date: "2026-08-22T15:00:00Z" })).toBeNull();
  });

  it("bridges Understat short names (Man City → Manchester City)", () => {
    expect(
      findUnderstatMatchId(scheduleHtml, {
        ...MATCH,
        date: "2026-08-22T15:00:00Z",
        homeTeam: "Manchester City",
        awayTeam: "Wolverhampton",
      }),
    ).toBe("7654321");
  });

  it("fetches xG for the resolved match", async () => {
    const { calls } = stubFetch([
      { match: /\/league\/EPL\/2026/, body: scheduleHtml },
      { match: /\/match\/1234567/, body: matchHtml },
    ]);
    const lines: string[] = [];
    const payload = await understatSource.fetch(MATCH, makeCtx({}, lines));
    expect(payload).not.toBeNull();
    expect(payload!.home.goals).toBe(1);
    expect(payload!.home.xg).toBeCloseTo(0.4, 2);
    expect(payload!.away.shots).toBe(2);
    expect(calls[0]).toContain("/league/EPL/2026");
    expect(calls[1]).toContain("/match/1234567");
    expect(lines.some((l) => l.includes("[Understat] Resolved match id 1234567"))).toBe(true);
  });

  it("logs clearly when the match is not on the schedule", async () => {
    stubFetch([
      { match: /\/league\/EPL\/2026/, body: "<table><tr><td>1.1.26</td><td><a href=\"/match/1\">A</a> - <a href=\"/match/1\">B</a></td></tr></table>" },
    ]);
    const lines: string[] = [];
    const payload = await understatSource.fetch(MATCH, makeCtx({}, lines));
    expect(payload).toBeNull();
    expect(lines.some((l) => l.includes("[Understat] Match not found on schedule for 2026-08-21 Arsenal vs Chelsea"))).toBe(true);
  });

  it("still rejects non-Big-5 leagues at the gate", () => {
    const lines: string[] = [];
    expect(understatSource.available({ ...MATCH, leagueSlug: "ned.1" }, makeCtx({}, lines))).toBe(false);
  });
});

// ─── Highlightly: network-error log (Problem 6) ──────────────────────────────

describe("Highlightly", () => {
  it("logs the allowlist hint and skips when the host is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const lines: string[] = [];
    const payload = await highlightlySource.fetch(
      { ...MATCH, eventId: "hl-1" },
      makeCtx({ HIGHLIGHTLY_KEY: "k" }, lines),
    );
    expect(payload).toBeNull();
    expect(lines.some((l) => l.includes("[Highlightly] Host unreachable — check network allowlist."))).toBe(true);
  });
});

// ─── GitHubDatasets: not-found log (Problem 8) ───────────────────────────────

describe("GitHubDatasets", () => {
  it("searches by date + teams and logs clearly when the match is absent", async () => {
    const csv = "league,season,date,home,away,HG,AG\nPremier League,2024/2025,2025-08-16,Arsenal,Chelsea,1,0\n";
    stubFetch([
      { match: /matches\.csv$/, body: csv },
    ]);
    const lines: string[] = [];
    const payload = await githubDatasetsSource.fetch(MATCH, makeCtx({}, lines));
    expect(payload).toBeNull();
    expect(lines.some((l) => l.includes("[GitHubDatasets] Match not found for 2026-08-21 Arsenal vs Chelsea."))).toBe(true);
  });
});

// ─── Aggregator: end-of-walk summary + diagnostics (Problem 10) ──────────────

describe("aggregator summary + diagnostics", () => {
  it("logs a per-source failure summary and exposes diagnostics.perSourceFailures", async () => {
    delete process.env.API_FOOTBALL_KEY;
    delete process.env.FOOTBALL_API_KEY;

    const emptySource: SourceHandler = {
      name: "SportScore",
      capabilities: ["goals"],
      available: () => true,
      fetch: async () => null,
    };
    const keyedSource: SourceHandler = {
      name: "API-Football",
      capabilities: ["goals"],
      available: (_m, ctx) => ctx.env("API_FOOTBALL_KEY").length > 0,
      fetch: async () => ({ home: { goals: 1 }, away: { goals: 1 } }),
    };
    const lines: string[] = [];
    const agg = new StatsAggregator({
      handlers: { SportScore: emptySource, "API-Football": keyedSource },
      log: (m) => lines.push(m),
    });

    const result = await agg.fetchWithTrace(MATCH);
    expect(result.stats).toBeNull();

    // The walk covers the full 11-slot priority list; unregistered slots are
    // named as failures too (here "no handler"), so every source is accounted
    // for in the summary line.
    const summary = lines.find((l) => l.startsWith("[aggregator]"));
    expect(summary).toBeTruthy();
    expect(summary).toContain("eng.1:401879288");
    expect(summary).toContain("11 sources tried");
    expect(summary).toContain("SportScore (id unresolved)");
    expect(summary).toContain("API-Football (no key)");
    expect(summary).toContain("→ SYNTHETIC");

    const diag = agg.diagnostics();
    expect(diag.lastOutcome).toBe("synthetic");
    const bySource = Object.fromEntries(diag.perSourceFailures.map((f) => [f.source, f]));
    expect(bySource["SportScore"].reason).toBe("no-requests");
    expect(bySource["SportScore"].short).toBe("id unresolved");
    expect(bySource["API-Football"].reason).toBe("key-missing");
    expect(bySource["API-Football"].short).toBe("no key");
    // Every priority slot appears exactly once.
    expect(diag.perSourceFailures).toHaveLength(11);
  });

  it("names HTTP 403 failures with their status code in the summary + trace", async () => {
    stubFetch([
      { match: /example\.invalid/, status: 403, body: { error: "denied" } },
    ]);
    const fetching: SourceHandler = {
      name: "FBref",
      capabilities: ["xg"],
      available: () => true,
      fetch: async (_m, ctx) => {
        await ctx.http("https://example.invalid/match");
        return null;
      },
    };
    const lines: string[] = [];
    const agg = new StatsAggregator({
      handlers: { FBref: fetching },
      log: (m) => lines.push(m),
    });
    await agg.fetchWithTrace(MATCH);

    const summary = lines.find((l) => l.startsWith("[aggregator]"))!;
    expect(summary).toContain("FBref (403)");

    const diag = agg.diagnostics();
    const fbrefFailure = diag.perSourceFailures.find((f) => f.source === "FBref")!;
    expect(fbrefFailure.httpStatus).toBe(403);
    expect(fbrefFailure.reason).toBe("http-error");
    // A 403 response proves the host answered — reachability is recorded.
    expect(diag.sources.find((s) => s.source === "FBref")?.lastReachableAt).toBeTruthy();
  });

  it("arms a cooldown when a source reports a rate limit (403-style quota)", async () => {
    const rateLimitedSource: SourceHandler = {
      name: "API-Football",
      capabilities: ["goals"],
      available: () => true,
      fetch: async (_m, ctx) => {
        ctx.reportRateLimit?.("API-Football 403 quota");
        return { home: { goals: 2 }, away: { goals: 0 } };
      },
    };
    const lines: string[] = [];
    const agg = new StatsAggregator({
      handlers: { "API-Football": rateLimitedSource },
      rateLimitCooldownMs: 60_000,
      log: (m) => lines.push(m),
    });

    const first = await agg.fetch(MATCH);
    expect(first).not.toBeNull();
    expect(lines.some((l) => l.includes("rate limit detected") && l.includes("cooldown armed"))).toBe(true);

    // Next match: the source is in cooldown, not refetched.
    const second = await agg.fetchWithTrace({ ...MATCH, eventId: "other-1" });
    const afAttempt = second.attempts.find((a) => a.source === "API-Football")!;
    expect(afAttempt.reason).toBe("cooldown");
    expect(afAttempt.http).toEqual([]);
  });

  it("logs a cache-hit summary without re-walking the sources", async () => {
    const counting: SourceHandler = {
      name: "SportScore",
      capabilities: ["goals"],
      available: () => true,
      fetch: async () => ({ home: { goals: 3 }, away: { goals: 1 } }),
    };
    const lines: string[] = [];
    const agg = new StatsAggregator({
      handlers: { SportScore: counting },
      log: (m) => lines.push(m),
    });
    await agg.fetch(MATCH);
    await agg.fetch(MATCH);

    const hitLines = lines.filter((l) => l.includes("cache hit"));
    expect(hitLines).toHaveLength(1);
    expect(hitLines[0]).toContain("no sources tried");
    expect(agg.diagnostics().lastOutcome).toBe("real-data");
    expect(agg.diagnostics().lastPrimarySource).toBe("SportScore");
  });
});
