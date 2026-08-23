import { describe, it, expect } from "vitest";
import {
  leagueTier,
  compareLeaguePriority,
  compareFixturesByPriority,
  compareLeagueBlockPriority,
  tierLabel,
  LOWEST_TIER,
} from "./leaguePriority";

describe("leagueTier", () => {
  it("maps elite competitions to tier 1", () => {
    expect(leagueTier({ leagueSlug: "uefa.champions" })).toBe(1);
    expect(leagueTier({ leagueSlug: "uefa.europa" })).toBe(1);
    expect(leagueTier({ leagueSlug: "fifa.world" })).toBe(1);
    expect(leagueTier({ leagueSlug: "conmebol.america" })).toBe(1);
  });

  it("maps the top-5 leagues to tier 2", () => {
    for (const slug of ["eng.1", "esp.1", "ger.1", "ita.1", "fra.1"]) {
      expect(leagueTier({ leagueSlug: slug })).toBe(2);
    }
  });

  it("maps second-tier European leagues to tier 3", () => {
    for (const slug of ["eng.2", "ned.1", "por.1", "sco.1", "tur.1"]) {
      expect(leagueTier({ leagueSlug: slug })).toBe(3);
    }
  });

  it("maps major Americas leagues to tier 4", () => {
    for (const slug of ["usa.1", "mex.1", "bra.1", "arg.1"]) {
      expect(leagueTier({ leagueSlug: slug })).toBe(4);
    }
  });

  it("maps Asian & African top leagues to tier 5", () => {
    for (const slug of ["ksa.1", "jpn.1", "kor.1", "egy.1", "mar.1"]) {
      expect(leagueTier({ leagueSlug: slug })).toBe(5);
    }
  });

  it("falls back to the lowest tier for unknown competitions", () => {
    expect(leagueTier({ leagueSlug: "xyz.99" })).toBe(LOWEST_TIER);
    expect(leagueTier({})).toBe(LOWEST_TIER);
  });

  it("falls back to name matching when the slug is unknown", () => {
    expect(leagueTier({ leagueSlug: "??", leagueName: "UEFA Champions League" })).toBe(1);
    expect(leagueTier({ leagueName: "Premier League" })).toBe(2);
    expect(leagueTier({ leagueName: "Some Regional Cup" })).toBe(LOWEST_TIER);
  });

  it("prefers the slug map over the name fallback", () => {
    // Slug says tier 2 even though the name would also resolve to tier 2 —
    // ensure the slug path wins deterministically.
    expect(leagueTier({ leagueSlug: "eng.1", leagueName: "unused" })).toBe(2);
  });
});

describe("compareLeaguePriority", () => {
  it("orders bigger leagues before smaller ones", () => {
    const fixtures = [
      { leagueSlug: "xyz.99" }, // tier 6
      { leagueSlug: "eng.1" }, // tier 2
      { leagueSlug: "uefa.champions" }, // tier 1
      { leagueSlug: "usa.1" }, // tier 4
    ];
    const sorted = [...fixtures].sort(compareLeaguePriority).map((f) => f.leagueSlug);
    expect(sorted).toEqual(["uefa.champions", "eng.1", "usa.1", "xyz.99"]);
  });
});

describe("compareLeagueBlockPriority", () => {
  it("orders Today blocks globally across featured and extra groups", () => {
    const featured = [
      { slug: "eng.1", label: "Premier League" },
      { slug: "xyz.99", label: "Regional Cup" },
    ];
    const extra = [
      { slug: "uefa.champions", label: "UEFA Champions League" },
      { slug: "usa.1", label: "MLS" },
    ];

    expect([...featured, ...extra].sort(compareLeagueBlockPriority).map((b) => b.slug)).toEqual([
      "uefa.champions",
      "eng.1",
      "usa.1",
      "xyz.99",
    ]);
  });

  it("uses a block label when a global-scoreboard slug is unavailable", () => {
    const blocks = [
      { slug: "all", label: "Regional Cup" },
      { slug: "all", label: "UEFA Europa League" },
    ];

    expect([...blocks].sort(compareLeagueBlockPriority).map((b) => b.label)).toEqual([
      "UEFA Europa League",
      "Regional Cup",
    ]);
  });
});

describe("compareFixturesByPriority", () => {
  it("breaks ties within a tier by earliest date", () => {
    const fixtures = [
      { leagueSlug: "eng.1", date: "2026-08-22T18:00:00Z" },
      { leagueSlug: "uefa.champions", date: "2026-08-22T20:00:00Z" },
      { leagueSlug: "eng.1", date: "2026-08-22T12:00:00Z" },
    ];
    const sorted = [...fixtures]
      .sort((a, b) => compareFixturesByPriority(a, b, (x) => x.date))
      .map((f) => `${f.leagueSlug}@${f.date}`);
    expect(sorted).toEqual([
      "uefa.champions@2026-08-22T20:00:00Z",
      "eng.1@2026-08-22T12:00:00Z",
      "eng.1@2026-08-22T18:00:00Z",
    ]);
  });
});

describe("tierLabel", () => {
  it("renders a compact badge label", () => {
    expect(tierLabel(1)).toBe("T1");
    expect(tierLabel(6)).toBe("T6");
  });
});
