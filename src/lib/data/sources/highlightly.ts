// ĞIGI GIVØ — Highlightly normaliser.
//
// Endpoint: https://api.highlightly.com/v1/matches/{eventId}
// Key:      HIGHLIGHTLY_KEY via env.
//
// Maps xg, shots on target, possession and (when present) timeline-derived
// counts. The response shape varies, so the normaliser extracts defensively.

import type { SourceHandler } from "./context";
import { asNumberLoose, asRecord, asString, getPath, roundTo } from "./shared";
import type { MatchStatsQuery, PartialTeamStats, SourcePayload, StatKey } from "../types";

const BASE = "https://api.highlightly.com/v1";

export const HIGHLIGHTLY_CAPABILITIES: StatKey[] = [
  "goals", "xg", "xgPerShot", "shotsOnTarget", "possession",
];

const FIELD_ALIASES: Record<string, StatKey> = {
  xg: "xg",
  expectedgoals: "xg",
  shotsontarget: "shotsOnTarget",
  possession: "possession",
  ballpossession: "possession",
  goals: "goals",
  score: "goals",
};

const normKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function extractStats(node: unknown, out: PartialTeamStats, depth = 0): void {
  if (depth > 6 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) extractStats(item, out, depth + 1);
    return;
  }
  const rec = asRecord(node);
  if (!rec) return;
  for (const [key, value] of Object.entries(rec)) {
    const field = FIELD_ALIASES[normKey(key)];
    if (field) {
      const n = asNumberLoose(value);
      if (n !== null && out[field] === undefined) out[field] = n;
      continue;
    }
    if (typeof value === "object" && value !== null) extractStats(value, out, depth + 1);
  }
}

export const highlightlySource: SourceHandler = {
  name: "Highlightly",
  capabilities: HIGHLIGHTLY_CAPABILITIES,

  available: (_match, ctx) => ctx.env("HIGHLIGHTLY_KEY").length > 0,

  async fetch(match, ctx): Promise<SourcePayload | null> {
    const key = ctx.env("HIGHLIGHTLY_KEY");
    if (!key) return null;

    const url = `${BASE}/matches/${encodeURIComponent(match.eventId)}`;
    const res = await ctx.http(url, {
      headers: { "x-api-key": key },
      timeoutMs: ctx.timeoutMs,
    });

    // Network failures are an ENVIRONMENT problem (egress allowlist), not a
    // data problem — say so explicitly, then skip gracefully.
    if (res.status === "network-error") {
      ctx.log("[Highlightly] Host unreachable — check network allowlist.");
      return null;
    }
    if (res.status === "timeout") {
      ctx.log(`[Highlightly] Host ${url} timed out after ${ctx.timeoutMs}ms — check network allowlist / egress latency.`);
      return null;
    }
    if (res.status === "http-error" && (res.httpStatus === 401 || res.httpStatus === 403)) {
      ctx.log(`[Highlightly] HTTP ${res.httpStatus} — HIGHLIGHTLY_KEY was rejected by api.highlightly.com; check the key in .env.local.`);
      return null;
    }
    if (res.status !== "ok") return null;

    const root = asRecord(res.data);
    const data = root ? (asRecord(root.data) ?? root) : null;
    if (!data) return null;

    const home: PartialTeamStats = {};
    const away: PartialTeamStats = {};
    const homeRaw = data.home ?? data.home_team ?? data.team_home ?? getPath(data, "stats.home");
    const awayRaw = data.away ?? data.away_team ?? data.team_away ?? getPath(data, "stats.away");
    if (homeRaw != null && awayRaw != null) {
      extractStats(homeRaw, home);
      extractStats(awayRaw, away);
    } else {
      // Home/away split unavailable → cannot attribute stats honestly.
      return null;
    }

    // xG per shot when both are available.
    if (home.xg != null && home.shotsOnTarget != null) {
      home.xgPerShot = roundTo(home.xg / Math.max(1, home.shotsOnTarget), 3);
    }
    if (away.xg != null && away.shotsOnTarget != null) {
      away.xgPerShot = roundTo(away.xg / Math.max(1, away.shotsOnTarget), 3);
    }

    const hasAny =
      Object.values(home).some((v) => v !== null) ||
      Object.values(away).some((v) => v !== null);
    return hasAny ? { home, away } : null;
  },
};
