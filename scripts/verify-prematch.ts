#!/usr/bin/env tsx
/**
 * ĞIGI GIVØ — Pre-match REAL-data verification (live).
 *
 * Picks a REAL upcoming Premier League fixture, runs it through the full
 * multi-source StatsAggregator with state="pre", and verifies that the
 * API-Football source now returns REAL historical data (season averages +
 * last-10 form) instead of falling into the synthetic baseline.
 *
 * What it reports:
 *   1. API-Football key health (GET /status)
 *   2. The upcoming fixture it tested
 *   3. Every endpoint the API-Football source called (URL + HTTP status + ms)
 *   4. What the response contained (the per-team payload fields)
 *   5. Whether the data-quality badge flips to REAL (not Synthetic)
 *
 * Usage (run where API_FOOTBALL_KEY / FOOTBALL_API_KEY is set, e.g. .env.local):
 *   npx tsx scripts/verify-prematch.ts
 *   npx tsx scripts/verify-prematch.ts --home "Arsenal" --away "Chelsea" --date 2026-09-19
 *
 * Exit codes: 0 = REAL data confirmed · 1 = synthetic fallback (bug) ·
 *             2 = key not configured/valid · 3 = no upcoming fixture found
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { StatsAggregator } from "../src/lib/data/aggregator";
import {
  checkApiFootballKey,
  footballSeason,
} from "../src/lib/data/sources/apiFootball";
import {
  BOOLEAN_FIELDS,
  MATCH_STAT_FIELDS,
  STAT_FIELDS,
  nonNullFieldCount,
  type CanonicalMatchStats,
} from "../src/lib/data/types";

const BASE =
  (process.env.API_FOOTBALL_BASE ?? "").trim() || "https://v3.football.api-sports.io";
const LEAGUE_ID = 39; // Premier League

interface CliArgs {
  home: string | null;
  away: string | null;
  date: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { home: null, away: null, date: null };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    const value = argv[i + 1] ?? "";
    switch (key) {
      case "home": args.home = value || null; break;
      case "away": args.away = value || null; break;
      case "date": args.date = value || null; break;
      default: break;
    }
  }
  return args;
}

interface AfFixture {
  id: number;
  date: string;
  statusShort: string;
  home: string;
  away: string;
}

async function nextPremierLeagueFixtures(key: string, season: number): Promise<AfFixture[]> {
  const res = await fetch(`${BASE}/fixtures?league=${LEAGUE_ID}&season=${season}&next=38`, {
    headers: { "x-apisports-key": key },
  });
  if (!res.ok) throw new Error(`/fixtures?next=38 → HTTP ${res.status}`);
  const body = (await res.json()) as {
    response?: Array<{
      fixture: { id: number; date: string; status: { short: string } };
      teams: { home: { name: string }; away: { name: string } };
    }>;
  };
  return (body.response ?? [])
    .map((f) => ({
      id: f.fixture.id,
      date: f.fixture.date,
      statusShort: f.fixture.status.short,
      home: f.teams.home.name,
      away: f.teams.away.name,
    }))
    .filter((f) => f.statusShort === "NS");
}

/** Same gate the /api/match route uses for the badge (state="pre" aware). */
function classifyForBadge(stats: CanonicalMatchStats | null): "Real" | "Mixed" | "Synthetic" {
  if (!stats) return "Synthetic";
  const required = MATCH_STAT_FIELDS.length * 2; // cleanSheet excluded pre-match
  return nonNullFieldCount(stats) >= required ? "Real" : "Mixed";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  console.log("═".repeat(72));
  console.log("GIGI GIVO — pre-match REAL-data verification (API-Football)");
  console.log("═".repeat(72));

  // ── 1. Key health ──────────────────────────────────────────────────────────
  const key = ((process.env.API_FOOTBALL_KEY ?? "") || (process.env.FOOTBALL_API_KEY ?? "")).trim();
  if (!key) {
    console.error("\n✗ API_FOOTBALL_KEY (or FOOTBALL_API_KEY) is not set.");
    console.error("  Set it in .env.local and re-run:  npx tsx scripts/verify-prematch.ts");
    process.exit(2);
  }
  const keyReport = await checkApiFootballKey();
  if (keyReport.valid !== true) {
    console.error(`\n✗ Key check failed: ${keyReport.note}`);
    process.exit(2);
  }
  console.log(`\n✓ Key check: ${keyReport.note}`);

  // ── 2. Pick the fixture ────────────────────────────────────────────────────
  const season = footballSeason(new Date().toISOString());
  let fixture: AfFixture | null = null;
  if (args.home && args.away && args.date) {
    fixture = { id: 0, date: `${args.date}T15:00:00Z`, statusShort: "NS", home: args.home, away: args.away };
    console.log(`\nFixture (CLI): ${args.home} vs ${args.away} on ${args.date}`);
  } else {
    const upcoming = await nextPremierLeagueFixtures(key, season);
    fixture = upcoming[0] ?? null;
    if (!fixture) {
      console.error(`\n✗ No upcoming (NS) Premier League fixtures found for season ${season}.`);
      console.error("  Off-season? Pass one explicitly: --home X --away Y --date YYYY-MM-DD");
      process.exit(3);
    }
    console.log(`\nFixture: ${fixture.home} vs ${fixture.away}`);
    console.log(`  kickoff: ${fixture.date} (API-Football fixture ${fixture.id}, season ${season})`);
  }

  const query = {
    leagueSlug: "eng.1",
    eventId: fixture!.id ? `apif:${fixture!.id}` : `verify:${fixture!.home}-vs-${fixture!.away}`,
    homeTeam: fixture!.home,
    awayTeam: fixture!.away,
    date: fixture!.date,
    state: "pre" as const,
  };

  // ── 3. Run the real aggregator (full source walk, fresh) ───────────────────
  console.log("\nRunning the multi-source aggregator (state=pre)…\n");
  const aggregator = new StatsAggregator();
  const { stats, attempts } = await aggregator.fetchWithTrace(query, { force: true });

  // ── 4. Endpoints the API-Football source called ────────────────────────────
  const afAttempt = attempts.find((a) => a.source === "API-Football");
  console.log("─".repeat(72));
  console.log("API-Football source trace");
  console.log("─".repeat(72));
  if (afAttempt) {
    for (const call of afAttempt.http ?? []) {
      console.log(`  [${call.status}${call.httpStatus !== null ? ` ${call.httpStatus}` : ""}] ${call.url}  (${call.ms}ms)`);
    }
    console.log(`  → status=${afAttempt.status} reason=${afAttempt.reason ?? "-"} fields=${afAttempt.fields}`);
  } else {
    console.log("  (the API-Football source was not attempted — see readiness above)");
  }
  const other = attempts.filter((a) => a.source !== "API-Football");
  if (other.length) {
    console.log("\nOther sources:");
    for (const a of other) {
      console.log(`  ${a.source}: ${a.status}${a.reason ? ` (${a.reason})` : ""} fields=${a.fields}`);
    }
  }

  // ── 5. What the response contained ─────────────────────────────────────────
  console.log("\n" + "─".repeat(72));
  console.log("Resulting canonical stats (per-match values)");
  console.log("─".repeat(72));
  if (stats) {
    console.log(`  primary source: ${stats.metadata.source}  ·  fetched ${stats.metadata.fetchedAt}`);
    const fmt = (v: number | boolean | null | undefined) => (v === null || v === undefined ? "null" : String(v));
    const pad = (s: string, n: number) => s.padEnd(n);
    console.log(`  ${pad("field", 24)} ${pad("home", 14)} ${pad("away", 14)}`);
    for (const field of STAT_FIELDS) {
      console.log(`  ${pad(field, 24)} ${pad(fmt(stats.home[field]), 14)} ${pad(fmt(stats.away[field]), 14)}`);
    }
    for (const field of BOOLEAN_FIELDS) {
      console.log(`  ${pad(field, 24)} ${pad(fmt(stats.home[field]), 14)} ${pad(fmt(stats.away[field]), 14)}`);
    }
    console.log(`\n  filled fields: ${nonNullFieldCount(stats)} / ${STAT_FIELDS.length * 2 + BOOLEAN_FIELDS.length * 2}`);
  } else {
    console.log("  (none — no source contributed a single field)");
  }

  // ── 6. Data-quality badge ──────────────────────────────────────────────────
  const quality = classifyForBadge(stats);
  const required = MATCH_STAT_FIELDS.length * 2;
  const filled = stats ? nonNullFieldCount(stats) : 0;
  console.log("\n" + "─".repeat(72));
  console.log("Data-quality badge (pre-match gate: cleanSheet excluded)");
  console.log("─".repeat(72));
  console.log(`  filled ${filled} / required ${required} (per-match numeric fields, both teams)`);
  console.log(`  badge: ${quality}`);

  const pass = stats !== null && quality === "Real";
  console.log("\n" + "═".repeat(72));
  if (pass) {
    console.log("PASS — upcoming fixture produced REAL data (not synthetic).");
    console.log("═".repeat(72));
    process.exit(0);
  } else if (stats !== null) {
    console.log("PARTIAL — real data exists but not every pre-match field was filled (badge Mixed).");
    console.log("═".repeat(72));
    process.exit(1);
  } else {
    console.log("FAIL — synthetic fallback: no source contributed any field.");
    console.log("═".repeat(72));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("verify-prematch crashed:", err);
  process.exit(1);
});
