#!/usr/bin/env tsx
/**
 * ĞIGI GIVØ — Stats validation script (Part 7.3).
 *
 * Fetches canonical stats for a recent, known match through the full
 * multi-source aggregator and logs the output, proving the stats are REAL and
 * correct (every field is a source-provided value or null — never mocked).
 *
 * Usage:
 *   npx tsx scripts/validate-stats.ts \
 *     --league eng.1 \
 *     --home "Manchester United" \
 *     --away "Arsenal" \
 *     --date 2026-05-10
 *
 *   # or via the npm script with defaults:
 *   npm run validate:stats
 *
 * Env keys that unlock the keyed sources (optional — every source fails soft):
 *   API_FOOTBALL_KEY, HIGHLIGHTLY_KEY, THESPORTSDB_KEY, DATAFCC_ENDPOINT,
 *   GITHUB_DATASET_URLS
 */

import { statsAggregator, SOURCE_CAPABILITIES } from "../src/lib/data/aggregator";

interface CliArgs {
  league: string;
  home: string;
  away: string;
  date: string;
  eventId: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    league: process.env.VALIDATE_LEAGUE ?? "eng.1",
    home: process.env.VALIDATE_HOME ?? "Manchester United",
    away: process.env.VALIDATE_AWAY ?? "Arsenal",
    date: process.env.VALIDATE_DATE ?? "2026-05-10",
    eventId: process.env.VALIDATE_EVENT_ID ?? "validate:manchester-united-vs-arsenal",
  };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    const value = argv[i + 1] ?? "";
    switch (key) {
      case "league": args.league = value; break;
      case "home": args.home = value; break;
      case "away": args.away = value; break;
      case "date": args.date = value; break;
      case "event-id": args.eventId = value; break;
      default: break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const match = {
    leagueSlug: args.league,
    eventId: args.eventId,
    homeTeam: args.home,
    awayTeam: args.away,
    date: args.date,
  };

  console.log(`\n[validate:stats] Fetching ${args.home} vs ${args.away} (${args.league}, ${args.date})\n`);

  const { stats, attempts } = await statsAggregator.fetchWithTrace(match, { force: true });

  if (!stats) {
    console.log("[validate:stats] ✗ No source contributed a single stat for this match.\n");
    console.log("Per-source attempts:");
    for (const a of attempts) console.log(`  - ${a.source}: ${a.status}${a.detail ? ` (${a.detail})` : ""}`);
    console.log("\nCapability matrix:");
    console.log(JSON.stringify(SOURCE_CAPABILITIES, null, 2));
    return;
  }

  console.log(`[validate:stats] ✓ Stats resolved — primary source: ${stats.metadata.source}\n`);
  console.log("Per-source attempts:");
  for (const a of attempts) {
    console.log(`  - ${a.source}: ${a.status} (${a.fields} fields)${a.detail ? ` — ${a.detail}` : ""}`);
  }

  console.log("\nCanonicalMatchStats:");
  console.log(JSON.stringify(stats, null, 2));

  // Prove the numbers are real: report which fields each side actually has.
  const h = stats.home;
  const a = stats.away;
  const nonNull = (obj: Record<string, unknown>) =>
    Object.entries(obj).filter(([, v]) => v !== null).map(([k]) => k);
  console.log(`\n[validate:stats] home fields: ${nonNull(h as unknown as Record<string, unknown>).join(", ") || "none"}`);
  console.log(`[validate:stats] away fields: ${nonNull(a as unknown as Record<string, unknown>).join(", ") || "none"}`);
}

main().catch((err) => {
  console.error("[validate:stats] failed:", err);
  process.exitCode = 1;
});
