// ĞIGI GIVØ — Network connectivity diagnostics.
//
// Probes every external host the stats aggregator depends on and reports
// whether it is reachable from THIS environment. Use it to distinguish
// "the league genuinely has no data" from "egress to the data source is
// blocked" — the two look identical from /api/stats (both yield null).
//
//   GET /api/diagnostics/connectivity
//   GET /api/diagnostics/connectivity?timeout=5000
//
// Read-only: performs lightweight GETs and reports status only. It never
// writes, caches, or mutates aggregator state.

import { fetchWithTimeout } from "@/lib/data/http";

export const dynamic = "force-dynamic";

interface Probe {
  /** Host as it must appear in a network allowlist. */
  host: string;
  /** URL actually requested. */
  url: string;
  /** Which data source / feature depends on this host. */
  usedBy: string;
  /** Env var gating this source, if any. */
  requiresKey?: string;
}

const PROBES: Probe[] = [
  {
    host: "sportscore.com",
    url: "https://sportscore.com/api/v1/sports",
    usedBy: "SportScore (aggregator priority #1)",
  },
  {
    host: "v3.football.api-sports.io",
    url: "https://v3.football.api-sports.io/status",
    usedBy: "API-Football (aggregator priority #2)",
    requiresKey: "API_FOOTBALL_KEY",
  },
  {
    host: "raw.githubusercontent.com",
    url: "https://raw.githubusercontent.com/openfootball/football.json/master/README.md",
    usedBy: "StatsBomb / GitHubDatasets handlers",
  },
  {
    host: "a.espncdn.com",
    url: "https://a.espncdn.com/favicon.ico",
    usedBy: "Team & league crests (UI imagery)",
  },
  {
    host: "site.api.espn.com",
    url: "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard",
    usedBy: "ESPN fixture feed (schedule / event IDs)",
  },
  {
    host: "www.thesportsdb.com",
    url: "https://www.thesportsdb.com/api/v1/json/3/all_leagues.php",
    usedBy: "TheSportsDB handler",
  },
  {
    host: "fbref.com",
    url: "https://fbref.com/en/",
    usedBy: "FBref handler (advanced stats)",
  },
  {
    host: "understat.com",
    url: "https://understat.com/",
    usedBy: "Understat handler (xG)",
  },
  {
    host: "api.openligadb.de",
    url: "https://api.openligadb.de/getavailableleagues",
    usedBy: "OpenLigaDB handler (German football)",
  },
  {
    host: "api.highlightly.com",
    url: "https://api.highlightly.com/football/leagues?limit=1",
    usedBy: "Highlightly handler",
    requiresKey: "HIGHLIGHTLY_KEY",
  },
  {
    host: "worldcup2026-api.vercel.app",
    url: "https://worldcup2026-api.vercel.app/api/teams",
    usedBy: "worldcup2026 handler",
  },
];

/** Outcomes that prove the host was actually contacted. */
const REACHED = new Set([
  "ok",
  "not-found",
  "rate-limited",
  "server-error",
  "http-error",
  "invalid-json",
  "empty",
]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const timeoutMs = Math.min(
    Math.max(Number(url.searchParams.get("timeout")) || 8000, 1000),
    20_000,
  );

  const started = Date.now();

  const results = await Promise.all(
    PROBES.map(async (probe) => {
      const t0 = Date.now();
      const res = await fetchWithTimeout(probe.url, {
        timeoutMs,
        text: true,
      });
      const ms = Date.now() - t0;

      const reachable = REACHED.has(res.status);
      const keyConfigured = probe.requiresKey
        ? (process.env[probe.requiresKey] ?? "").length > 0
        : null;

      return {
        host: probe.host,
        usedBy: probe.usedBy,
        reachable,
        outcome: res.status,
        httpStatus: res.httpStatus,
        ms,
        ...(probe.requiresKey
          ? { requiresKey: probe.requiresKey, keyConfigured }
          : {}),
      };
    }),
  );

  const reachableCount = results.filter((r) => r.reachable).length;
  const blocked = results.filter((r) => !r.reachable).map((r) => r.host);

  return Response.json(
    {
      checkedAt: new Date().toISOString(),
      timeoutMs,
      elapsedMs: Date.now() - started,
      summary: {
        total: results.length,
        reachable: reachableCount,
        blocked: blocked.length,
        allReachable: blocked.length === 0,
      },
      blockedHosts: blocked,
      hint:
        blocked.length > 0
          ? "Blocked hosts must be added to the network allowlist. While they are unreachable the aggregator returns null for every match, which is an environment failure — not missing league coverage."
          : "All data-source hosts are reachable.",
      results,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
