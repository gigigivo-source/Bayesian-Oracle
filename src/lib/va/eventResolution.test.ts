import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The module caches resolutions in memory, so every test gets a fresh copy.
async function freshModule() {
  vi.resetModules();
  return import("./oddsFetcher");
}

interface StubEvent {
  id: number;
  home_team: string;
  away_team: string;
  event_date: string;
}

/** Records every /events/ query the resolver issues and replies with `events`. */
function stubFetch(events: StubEvent[] | ((from: string, to: string) => StubEvent[])) {
  const calls: Array<{ from: string; to: string }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const from = new URL(url).searchParams.get("date_from") ?? "";
    const to = new URL(url).searchParams.get("date_to") ?? "";
    calls.push({ from, to });
    const results = typeof events === "function" ? events(from, to) : events;
    return {
      ok: true,
      status: 200,
      json: async () => ({ count: results.length, next: null, results }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("Value Accumulator — Bzzoiro event resolution", () => {
  beforeEach(() => {
    vi.stubEnv("BZOOIRO_KEY", "test-key");
    vi.stubEnv("BZOOIRO_BASE", "https://sports.bzzoiro.test/api/v2");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("queries a ±2-day range around the UTC kickoff date, not a single exact date", async () => {
    const { resolveBzzoiroEvent } = await freshModule();
    const calls = stubFetch([
      { id: 900, home_team: "Real Madrid", away_team: "Athletic Club", event_date: "2026-09-15T19:00:00Z" },
    ]);

    const res = await resolveBzzoiroEvent({
      date: "2026-09-15T19:00:00Z",
      home: { name: "Real Madrid" },
      away: { name: "Athletic Club" },
    });

    expect(calls[0]).toEqual({ from: "2026-09-13", to: "2026-09-17" });
    expect(res.eventId).toBe("900");
    expect(res.status).toBe("resolved");
  });

  it("derives the kickoff day in UTC, not local time", async () => {
    const { resolveBzzoiroEvent } = await freshModule();
    // 23:30Z on the 15th is the 16th in CEST — the UTC day must win.
    const calls = stubFetch([]);
    await resolveBzzoiroEvent({
      date: "2026-09-15T23:30:00Z",
      home: { name: "Valencia" },
      away: { name: "Getafe" },
    });
    expect(calls[0]).toEqual({ from: "2026-09-13", to: "2026-09-17" });
  });

  it("matches on fuzzy team names across FC/CF/AFC suffixes and punctuation", async () => {
    const { resolveBzzoiroEvent } = await freshModule();
    stubFetch([
      { id: 1, home_team: "Sevilla FC", away_team: "Villarreal CF", event_date: "2026-09-15T17:00:00Z" },
    ]);

    const res = await resolveBzzoiroEvent({
      date: "2026-09-15T17:00:00Z",
      home: { name: "Sevilla" },
      away: { name: "Villarreal" },
    });
    expect(res.eventId).toBe("1");
  });

  it("accepts an event dated one day off the fixture kickoff", async () => {
    const { resolveBzzoiroEvent } = await freshModule();
    stubFetch([
      { id: 42, home_team: "Girona", away_team: "Celta Vigo", event_date: "2026-09-16T20:00:00Z" },
    ]);

    const res = await resolveBzzoiroEvent({
      date: "2026-09-15T20:00:00Z",
      home: { name: "Girona FC" },
      away: { name: "Celta Vigo" },
    });
    expect(res.eventId).toBe("42");
    expect(res.toleranceDays).toBe(2);
  });

  it("rejects a same-named event more than 2 days away, then finds it after widening to ±5", async () => {
    const { resolveBzzoiroEvent } = await freshModule();
    const calls = stubFetch((from) =>
      // The far-away event only appears once the wider window is requested.
      from === "2026-09-10"
        ? [{ id: 77, home_team: "Osasuna", away_team: "Alaves", event_date: "2026-09-19T18:00:00Z" }]
        : [],
    );

    const res = await resolveBzzoiroEvent({
      date: "2026-09-15T18:00:00Z",
      home: { name: "Osasuna" },
      away: { name: "Alaves" },
    });

    expect(calls).toEqual([
      { from: "2026-09-13", to: "2026-09-17" },
      { from: "2026-09-10", to: "2026-09-20" },
    ]);
    expect(res.eventId).toBe("77");
    expect(res.toleranceDays).toBe(5);
  });

  it("reports no-events when the league is absent from the whole ±5-day range", async () => {
    const { resolveBzzoiroEvent } = await freshModule();
    const calls = stubFetch([
      // Bzzoiro carries other competitions that window, just not this one.
      { id: 5, home_team: "Arsenal", away_team: "Chelsea", event_date: "2026-09-15T14:00:00Z" },
    ]);

    const res = await resolveBzzoiroEvent({
      date: "2026-09-15T19:00:00Z",
      home: { name: "Rayo Vallecano" },
      away: { name: "Espanyol" },
    });

    expect(res.eventId).toBeNull();
    expect(res.status).toBe("no-events");
    expect(res.relatedInRange).toBe(0);
    expect(calls).toHaveLength(2); // tried ±2 then widened to ±5
  });

  it("reports no-match (not a coverage gap) when the teams are present but unpaired", async () => {
    const { resolveBzzoiroEvent } = await freshModule();
    stubFetch([
      { id: 8, home_team: "Barcelona", away_team: "Mallorca", event_date: "2026-09-15T19:00:00Z" },
    ]);

    const res = await resolveBzzoiroEvent({
      date: "2026-09-15T19:00:00Z",
      home: { name: "Barcelona" },
      away: { name: "Real Betis" },
    });

    expect(res.eventId).toBeNull();
    expect(res.status).toBe("no-match");
    expect(res.relatedInRange).toBeGreaterThan(0);
  });

  it("caches per match so a repeated fixture issues no further HTTP calls", async () => {
    const { resolveBzzoiroEvent } = await freshModule();
    const calls = stubFetch([
      { id: 3, home_team: "Atletico Madrid", away_team: "Valencia", event_date: "2026-09-15T19:00:00Z" },
    ]);
    const fx = {
      date: "2026-09-15T19:00:00Z",
      home: { name: "Atletico Madrid" },
      away: { name: "Valencia CF" },
    };

    await resolveBzzoiroEvent(fx);
    const before = calls.length;
    const again = await resolveBzzoiroEvent(fx);

    expect(calls.length).toBe(before);
    expect(again.eventId).toBe("3");
  });

  it("logs the range query and returns null without throwing when Bzzoiro errors", async () => {
    const { resolveBzzoiroEventId } = await freshModule();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const id = await resolveBzzoiroEventId({
      date: "2026-09-15T19:00:00Z",
      home: { name: "Levante" },
      away: { name: "Elche" },
    });
    expect(id).toBeNull();
  });
});
