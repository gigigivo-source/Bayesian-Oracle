// ĞIGI GIVØ — Per-source data health diagnostics.
//
//   GET /api/diagnostics/data-sources
//   GET /api/diagnostics/data-sources?timeout=8000
//
// Reports EVERY stats source's status:
//   · reachable    — a live probe answered (any HTTP status proves the host
//                    responded; only network-error/timeout mean blocked)
//   · key valid    — env var present; API-Football is additionally verified
//                    live against /status (checkApiFootballKey)
//   · last success — last time the aggregator merged real fields from it
//                    (and how many), plus last failure reason + http status
//   · diagnostics.perSourceFailures — the exact per-source failure reasons
//                    from the aggregator's most recent walk
//
// Read-only: performs lightweight GET probes and reads aggregator state. It
// never writes, caches, or mutates aggregator state.

import { statsAggregator } from "@/lib/data/aggregator";
import { checkApiFootballKey } from "@/lib/data/sources/apiFootball";
import { fetchWithTimeout } from "@/lib/data/http";
import type { StatSourceName } from "@/lib/data/types";

export const dynamic = "force-dynamic";

interface SourceProbe {
  /** Host as it must appear in a network allowlist. */
  host?: string;
  /** Lightweight probe URL (any answer proves reachability). */
  url?: string;
  /** Env vars gating this source (informational — the handler may have a default). */
  keyEnv?: string[];
  note?: string;
}

const PROBES: Record<StatSourceName, SourceProbe> = {
  "SportScore": {
    host: "sportscore.com",
    url: "https://sportscore.com/api/v1/sports",
  },
  "API-Football": {
    host: "v3.football.api-sports.io",
    url: "https://v3.football.api-sports.io/status",
    keyEnv: ["API_FOOTBALL_KEY", "FOOTBALL_API_KEY"],
  },
  "StatsBomb": {
    host: "raw.githubusercontent.com",
    url: "https://raw.githubusercontent.com/statsbomb/open-data/master/data/competitions.json",
    note: "open data is static and mostly historical — recent matches are skipped gracefully",
  },
  "datafc": {
    keyEnv: ["DATAFCC_ENDPOINT"],
    note: "self-hosted sidecar — probed only when DATAFCC_ENDPOINT is set",
  },
  "FBref": {
    host: "fbref.com",
    url: "https://fbref.com/en/",
    note: "403s from their WAF are environment issues; the handler logs them and moves on",
  },
  "Understat": {
    host: "understat.com",
    url: "https://understat.com/",
    note: "Big-5 leagues only",
  },
  "OpenLigaDB": {
    host: "api.openligadb.de",
    url: "https://api.openligadb.de/getavailableleagues",
    note: "German leagues only",
  },
  "Highlightly": {
    host: "api.highlightly.com",
    url: "https://api.highlightly.com/v1/matches",
    keyEnv: ["HIGHLIGHTLY_KEY"],
    note: "an unreachable host is an egress/allowlist problem — the handler skips with a clear log",
  },
  "worldcup2026": {
    host: "worldcup2026-api.vercel.app",
    url: "https://worldcup2026-api.vercel.app/api/teams",
    note: "World Cup feed only — other leagues are gated off before any request",
  },
  "TheSportsDB": {
    host: "www.thesportsdb.com",
    url: "https://www.thesportsdb.com/api/v1/json/3/all_leagues.php",
    keyEnv: ["THESPORTSDB_KEY"],
    note: "falls back to the public free test key \"3\" (rate-limited) when unset",
  },
  "GitHubDatasets": {
    host: "raw.githubusercontent.com",
    url: "https://raw.githubusercontent.com/schochastics/football-data/main/README.md",
    note: "historical CSV backfill — matches located by date + teams, not ESPN ids",
  },
};

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
    Math.max(Number(url.searchParams.get("timeout")) || 6000, 1000),
    15_000,
  );
  const started = Date.now();

  // Aggregator state: per-source health + the last walk's failure trace.
  const diag = statsAggregator.diagnostics();

  // Live key check for API-Football (GET /status with the configured key).
  const apiFootballKey = await checkApiFootballKey({ timeoutMs });

  const rows = await Promise.all(
    diag.sources.map(async (s) => {
      const probe = PROBES[s.source as StatSourceName] ?? {};
      // datafc is self-hosted: probe the configured endpoint when present.
      const probeUrl = s.source === "datafc"
        ? (process.env.DATAFCC_ENDPOINT ?? "").trim()
        : (probe.url ?? "");

      let live: {
        url: string;
        outcome: string;
        httpStatus: number | null;
        ms: number;
        reachable: boolean;
      } | null = null;
      if (probeUrl) {
        const t0 = Date.now();
        const res = await fetchWithTimeout(probeUrl, { timeoutMs, text: true });
        live = {
          url: probeUrl,
          outcome: res.status,
          httpStatus: res.httpStatus,
          ms: Date.now() - t0,
          reachable: REACHED.has(res.status),
        };
      }

      // Key validity: API-Football is verified live; TheSportsDB is always
      // usable (free test key default); other keyed sources are env-based.
      let keyValid: boolean | null;
      if (s.source === "API-Football") keyValid = apiFootballKey.valid;
      else if (s.source === "TheSportsDB") keyValid = true;
      else keyValid = s.keyPresent;

      let status: string;
      if (!s.registered) status = "no-handler";
      else if (keyValid === false) status = "key-missing-or-invalid";
      else if (s.coolingDown) status = "cooldown";
      else if (live && !live.reachable) status = "host-unreachable";
      else if (s.lastSuccessAt) status = "ok";
      else if (s.lastFailureAt) status = "ok-no-data";
      else status = "not-attempted";

      return {
        source: s.source,
        priority: s.priority,
        host: probe.host ?? null,
        status,
        reachable: live ? live.reachable : null,
        probe: live,
        requiresEnv: s.requiresEnv,
        keyPresent: s.keyPresent,
        keyValid,
        ...(s.source === "API-Football" ? { keyNote: apiFootballKey.note } : {}),
        ...(probe.note ? { note: probe.note } : {}),
        coolingDown: s.coolingDown,
        lastAttemptAt: s.lastAttemptAt,
        lastSuccessAt: s.lastSuccessAt,
        lastSuccessFields: s.lastSuccessFields,
        lastFailureAt: s.lastFailureAt,
        lastFailureReason: s.lastFailureReason,
        lastFailureShort: s.lastFailureShort,
        lastFailureHttpStatus: s.lastFailureHttpStatus,
        lastReachableAt: s.lastReachableAt,
      };
    }),
  );

  const count = (f: (r: (typeof rows)[number]) => boolean): number =>
    rows.filter(f).length;

  const summary = {
    total: rows.length,
    ok: count((r) => r.status === "ok"),
    keyMissingOrInvalid: count((r) => r.status === "key-missing-or-invalid"),
    hostUnreachable: count((r) => r.status === "host-unreachable"),
    cooldown: count((r) => r.status === "cooldown"),
    okNoData: count((r) => r.status === "ok-no-data"),
    notAttempted: count((r) => r.status === "not-attempted"),
  };

  return Response.json(
    {
      checkedAt: new Date().toISOString(),
      timeoutMs,
      elapsedMs: Date.now() - started,
      summary,
      sources: rows,
      apiFootballKey,
      // The exact per-source failure reasons from the aggregator's last walk —
      // this is what the UI can surface next to a Synthetic data-quality badge.
      diagnostics: {
        lastWalkAt: diag.lastWalkAt,
        lastCacheKey: diag.lastCacheKey,
        lastOutcome: diag.lastOutcome,
        lastPrimarySource: diag.lastPrimarySource,
        lastFieldCount: diag.lastFieldCount,
        perSourceFailures: diag.perSourceFailures,
      },
      hint:
        summary.hostUnreachable > 0
          ? "One or more hosts are unreachable — an egress/allowlist problem. Add the hosts to the allowlist (docs/NETWORK_ALLOWLIST.md) and re-run GET /api/diagnostics/connectivity."
          : summary.keyMissingOrInvalid > 0
            ? "One or more sources have a missing/invalid key — check .env.local. TheSportsDB always works via its free test key."
            : "All sources are reachable and keyed. 'ok-no-data' means the host answered but has no record of recent matches (expected for historical sources).",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
