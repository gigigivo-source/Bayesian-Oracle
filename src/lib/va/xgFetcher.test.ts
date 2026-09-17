import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// xgFetcher reads BZOOIRO_BASE at module scope, so every network test gets a
// fresh copy (same convention as eventResolution.test.ts).
async function freshXgModule() {
  vi.resetModules();
  return import("./xgFetcher");
}

function stubFetchJson(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })) as unknown as typeof fetch,
  );
}

describe("Value Accumulator — Bzzoiro xG fetcher", () => {
  beforeEach(async () => {
    vi.stubEnv("BZOOIRO_KEY", "test-key");
    vi.stubEnv("BZOOIRO_BASE", "https://sports.bzzoiro.test/api/v2");
    const { __clearXgCacheForTests } = await freshXgModule();
    __clearXgCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("1. fetchMatchXg returns null when BZOOIRO_KEY is unset", async () => {
    vi.stubEnv("BZOOIRO_KEY", "");
    const { fetchMatchXg } = await freshXgModule();
    const fetchMock = vi.fn(async () => {
      throw new Error("must not hit the network without a key");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchMatchXg("223510")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("2. fetchMatchXg parses a mocked Bzzoiro stats response with two shots", async () => {
    const { fetchMatchXg } = await freshXgModule();
    stubFetchJson({
      event_id: 223510,
      xg_estimated: false,
      stats: {
        home: { ball_possession: 54, xg: { actual: 0.15, estimated: false } },
        away: { ball_possession: 46, xg: { actual: 0.3, estimated: false } },
      },
      shotmap: [
        {
          home: true, min: 23, type: "goal", sit: "assisted",
          pos: { x: 88.2, y: 44.1 }, xg: 0.15, xg_estimated: false,
        },
        {
          home: false, min: 55, type: "save", sit: "open-play",
          pos: { x: 91.0, y: 50.0 }, xg: 0.3, xg_estimated: false,
        },
      ],
    });

    const result = await fetchMatchXg("223510");
    expect(result).toEqual({
      homeXg: 0.15,
      awayXg: 0.3,
      perShot: [
        { x: 88.2, y: 44.1, xg: 0.15, team: "home" },
        { x: 91.0, y: 50.0, xg: 0.3, team: "away" },
      ],
      source: "bzzoiro",
    });
  });

  it("3. fetchMatchXg returns null when the response has no xg fields", async () => {
    const { fetchMatchXg } = await freshXgModule();
    stubFetchJson({
      event_id: 999,
      stats: {
        home: { ball_possession: 50, total_shots: null },
        away: { ball_possession: 50 },
      },
      shotmap: [],
    });

    await expect(fetchMatchXg("999")).resolves.toBeNull();
  });
});

describe("Engine — xG preference chain (realLambdas)", () => {
  it("4. shot-based proxy: 12 shots / 4 SOT → (12-4)*0.05 + 4*0.30 = 1.60", async () => {
    const { resolveRealXg } = await import("@/lib/engine/realLambdas");
    const profiles = {
      home: { shots: { mean: 12 }, sot: { mean: 4 } },
      away: null,
    } as never;

    const { realHomeXG, xgSource } = resolveRealXg(null, null, profiles);
    expect(realHomeXG).toBeCloseTo(1.6, 2);
    expect(xgSource).toBe("proxy");
  });

  it("5. sum.__homeXg wins outright (bzzoiro, not proxy, not anchor)", async () => {
    const { resolveRealXg } = await import("@/lib/engine/realLambdas");
    const sum = { __homeXg: 1.85, __awayXg: null } as never;
    const profiles = {
      home: { shots: { mean: 12 }, sot: { mean: 4 } },
      away: null,
    } as never;

    const { realHomeXG, realAwayXG, xgSource } = resolveRealXg(sum, null, profiles);
    expect(realHomeXG).toBe(1.85);
    expect(realAwayXG).toBeNull();
    expect(xgSource).toBe("bzzoiro");
  });
});
