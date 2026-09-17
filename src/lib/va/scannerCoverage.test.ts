import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FixtureLite } from "@/lib/espn";
import type { BzzoiroResolution, VaBookmakerOdds } from "./oddsFetcher";

const resolveBzzoiroEvent = vi.fn<(fx: { home: { name: string } }) => Promise<BzzoiroResolution>>();
const fetchOddsForEvent = vi.fn(async () => [] as VaBookmakerOdds[]);
const insertValues = vi.fn(async () => undefined);

vi.mock("./oddsFetcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./oddsFetcher")>();
  return {
    ...actual,
    resolveBzzoiroEvent: (fx: { home: { name: string } }) => resolveBzzoiroEvent(fx),
    fetchOddsForEvent: () => fetchOddsForEvent(),
  };
});

vi.mock("@/db", () => ({
  db: { insert: () => ({ values: insertValues }) },
}));

vi.mock("@/db/schema", () => ({ vaLegs: {} }));

const fetchScoreboard = vi.fn<(slug: string, range: string) => Promise<FixtureLite[]>>();
vi.mock("@/lib/espn", () => ({ fetchScoreboard: (s: string, r: string) => fetchScoreboard(s, r) }));

const runEngineFromReal = vi.fn<() => {
  match: { dataCompletenessScore: number };
  markets: Array<{ name: string; selection: string; family?: string; hitRate: number; ev?: number }>;
}>(() => ({
  match: { dataCompletenessScore: 80 },
  markets: [],
}));
vi.mock("@/lib/engine", () => ({ runEngineFromReal }));

function fixture(id: string, leagueSlug: string, home: string, away: string): FixtureLite {
  return {
    id,
    leagueSlug,
    leagueName: leagueSlug,
    date: "2026-09-15T19:00:00Z",
    state: "pre",
    statusDetail: "Scheduled",
    venue: null,
    home: { id: `${id}h`, name: home, abbrev: home.slice(0, 3), logo: null, score: null, record: null } as FixtureLite["home"],
    away: { id: `${id}a`, name: away, abbrev: away.slice(0, 3), logo: null, score: null, record: null } as FixtureLite["away"],
    neutralSite: false,
  };
}

const uncovered: BzzoiroResolution = {
  eventId: null,
  status: "no-events",
  eventsInRange: 30,
  relatedInRange: 0,
  toleranceDays: 5,
};

function resolved(id: string): BzzoiroResolution {
  return { eventId: id, status: "resolved", eventsInRange: 30, relatedInRange: 1, toleranceDays: 2 };
}

describe("Value Accumulator — league coverage skipping", () => {
  let logs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs an uncovered league once and stops probing its remaining matches", async () => {
    const { scanValueLegs } = await import("./scanner");

    const esp = [
      fixture("e1", "esp.1", "Real Madrid", "Athletic Club"),
      fixture("e2", "esp.1", "Barcelona", "Getafe"),
      fixture("e3", "esp.1", "Sevilla", "Valencia"),
      fixture("e4", "esp.1", "Girona", "Osasuna"),
    ];
    fetchScoreboard.mockImplementation(async (slug) => (slug === "esp.1" ? esp : []));
    resolveBzzoiroEvent.mockResolvedValue(uncovered);

    await scanValueLegs("scan_test");

    const notices = logs.filter((l) => l.includes("not covered by Bzzoiro"));
    expect(notices).toEqual(["[VA] league esp.1 not covered by Bzzoiro — skipping all its matches"]);

    // Two probes establish the gap; matches 3 and 4 are skipped without retrying.
    expect(resolveBzzoiroEvent).toHaveBeenCalledTimes(2);
  });

  it("logs the widened-range miss per unresolved match", async () => {
    const { scanValueLegs } = await import("./scanner");

    fetchScoreboard.mockImplementation(async (slug) =>
      slug === "esp.1" ? [fixture("e1", "esp.1", "Rayo Vallecano", "Espanyol")] : [],
    );
    resolveBzzoiroEvent.mockResolvedValue(uncovered);

    await scanValueLegs("scan_test");

    expect(logs).toContain("[VA] no Bzzoiro event for Rayo Vallecano vs Espanyol after widening to ±5 days");
  });

  it("keeps scanning a league whose matches do resolve", async () => {
    const { scanValueLegs } = await import("./scanner");

    fetchScoreboard.mockImplementation(async (slug) =>
      slug === "eng.1"
        ? [fixture("p1", "eng.1", "Arsenal", "Chelsea"), fixture("p2", "eng.1", "Liverpool", "Everton")]
        : [],
    );
    resolveBzzoiroEvent.mockResolvedValue(resolved("555"));

    await scanValueLegs("scan_test");

    expect(logs).toContain("[VA] resolved Bzzoiro event 555 for Arsenal vs Chelsea");
    expect(logs).toContain("[VA] resolved Bzzoiro event 555 for Liverpool vs Everton");
    expect(logs.some((l) => l.includes("not covered by Bzzoiro"))).toBe(false);
    expect(resolveBzzoiroEvent).toHaveBeenCalledTimes(2);
  });

  it("does not blacklist a league when a single match merely fails to pair up", async () => {
    const { scanValueLegs } = await import("./scanner");

    fetchScoreboard.mockImplementation(async (slug) =>
      slug === "ita.1"
        ? [
            fixture("i1", "ita.1", "Juventus", "Inter"),
            fixture("i2", "ita.1", "Milan", "Napoli"),
            fixture("i3", "ita.1", "Roma", "Lazio"),
          ]
        : [],
    );
    // Teams are in the feed (relatedInRange > 0) but never pair up — a naming
    // problem, not a coverage gap, so every fixture still gets its own probe.
    resolveBzzoiroEvent.mockResolvedValue({
      eventId: null,
      status: "no-match",
      eventsInRange: 40,
      relatedInRange: 2,
      toleranceDays: 5,
    });

    await scanValueLegs("scan_test");

    expect(logs.some((l) => l.includes("not covered by Bzzoiro"))).toBe(false);
    expect(resolveBzzoiroEvent).toHaveBeenCalledTimes(3);
  });

  it("qualifies a stack leg with negative EV when odds and hit rate qualify", async () => {
    const { scanValueLegs } = await import("./scanner");

    fetchScoreboard.mockImplementation(async (slug) =>
      slug === "eng.1" ? [fixture("s1", "eng.1", "Arsenal", "Chelsea")] : [],
    );
    resolveBzzoiroEvent.mockResolvedValue(resolved("stack-event"));
    runEngineFromReal.mockReturnValue({
      match: { dataCompletenessScore: 10 },
      markets: [{ name: "Total Goals O/U 2.5", selection: "Over 2.5", family: "goals", hitRate: 0.63, ev: -0.02 }],
    });
    fetchOddsForEvent.mockResolvedValue([
      { bookmaker: "1xBet", marketLabel: "Goals Over/Under", line: 2.5, selection: "Over 2.5", odds: 1.2 },
    ]);

    const result = await scanValueLegs("scan_stack_test", 7, "stack");

    expect(result.legs).toHaveLength(1);
    expect(result.legs[0].modelProbability).toBe(0.63);
    expect(result.legs[0].ev).toBeCloseTo(-0.244);
    expect(logs).toContain("[VA][stack] qualified=1 from 1 markets");
  });
});
