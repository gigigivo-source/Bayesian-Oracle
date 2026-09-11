// ĞIGI GIVØ — Sure Bet Corners post-match verification.
//
// Settles every pending Sure Bet corner pick — performance_log rows with
// rankingMode = 'S' and outcome = 'pending' — against real match data:
//
//   · the final result comes from the multi-source result lookup used by the
//     settlement cron (ESPN summary first, then TheSportsDB / OpenLigaDB /
//     API-Football by team names + date);
//   · the corner statistics come from the multi-source stats aggregator
//     (CanonicalMatchStats), cache-first like the settlement engine;
//   · the outcome is resolved by src/lib/settlement/sureCornerOutcomes,
//     which reuses the settlement engine's evaluateLeg for O/U lines.
//
// A pick stays pending while its match has no final result anywhere or its
// corner stats have not been published yet — the next run retries it.
//
// Auth: the same CRON_SECRET as the settlement cron, sent as
// `Authorization: Bearer <secret>` (or `?key=<secret>` for cron-style calls).

import { db } from "@/db";
import { performanceLog } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import type { MatchResult } from "@/lib/settlement/evaluate";
import {
  resolveSureCornerOutcome,
  type SureCornerOutcome,
} from "@/lib/settlement/sureCornerOutcomes";
import { statsAggregator } from "@/lib/data/aggregator";
import type { CanonicalMatchStats } from "@/lib/data/types";
import { lookupMultiSourceResult } from "../../cron/daily-picks/route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export interface VerifyDetail {
  eventId: string;
  match: string;
  market: string;
  /** A still-pending pick reports "PENDING" (not counted as failed). */
  outcome: SureCornerOutcome | "PENDING";
}

export interface VerifySummary {
  total: number;
  updated: number;
  failed: number;
  details: VerifyDetail[];
}

type SurePickRow = typeof performanceLog.$inferSelect;

// ─── Data lookups ────────────────────────────────────────────────────────────

/** Same CRON_SECRET guard as the settlement cron (open only when unset). */
function authorized(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return true;
  const provided =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    new URL(req.url).searchParams.get("key");
  return provided === secret;
}

async function resolveResult(row: SurePickRow): Promise<MatchResult | null> {
  return lookupMultiSourceResult({
    eventId: row.eventId,
    leagueSlug: row.leagueSlug,
    matchLabel: row.matchLabel,
    matchDate: row.matchDate,
  });
}

/** Cache-first canonical stats, exactly like the settlement engine. */
async function resolveStats(result: MatchResult): Promise<CanonicalMatchStats | null> {
  const query = {
    leagueSlug: result.leagueSlug,
    eventId: result.eventId,
    homeTeam: result.homeName,
    awayTeam: result.awayName,
    date: result.date,
    // Settlement rows are finished matches — per-match stats only, and the
    // cache key is state-aware, so this must match the settle engine's key.
    state: "post" as const,
  };
  return statsAggregator.peek(query) ?? statsAggregator.fetch(query);
}

function detailOutcomeForUpdate(outcome: SureCornerOutcome): string {
  return outcome === "WIN" ? "HIT" : outcome === "LOSS" ? "MISS" : outcome;
}

// ─── Route handlers ──────────────────────────────────────────────────────────

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const pending = await db
      .select()
      .from(performanceLog)
      .where(and(
        eq(performanceLog.rankingMode, "S"),
        eq(performanceLog.outcome, "pending"),
      ));

    console.info(`[SureCorners] Verifying ${pending.length} pending picks...`);
    if (pending.length === 0) {
      console.info("[SureCorners] Verification complete: 0 updated, 0 failed");
      return Response.json({ total: 0, updated: 0, failed: 0, details: [] } satisfies VerifySummary);
    }

    // Group by eventId so each match's result + stats is fetched only once.
    const byEvent = new Map<string, SurePickRow[]>();
    for (const row of pending) {
      const group = byEvent.get(row.eventId) ?? [];
      group.push(row);
      byEvent.set(row.eventId, group);
    }

    let updated = 0;
    let failed = 0;
    const details: VerifyDetail[] = [];

    for (const [eventId, picks] of byEvent) {
      const first = picks[0];
      try {
        let result: MatchResult | null = null;
        try {
          result = await resolveResult(first);
        } catch (error) {
          console.warn(
            `[SureCorners] ${first.matchLabel}: result lookup failed (${error instanceof Error ? error.message : String(error)})`,
          );
        }

        if (!result) {
          // The match has not finished anywhere yet — keep every pick pending.
          for (const pick of picks) {
            details.push({ eventId, match: pick.matchLabel, market: pick.market ?? "", outcome: "PENDING" });
          }
          continue;
        }

        const stats = await resolveStats(result).catch(() => null);

        for (const pick of picks) {
          const market = pick.market ?? "";
          const selection = pick.selection ?? "";
          const outcome = resolveSureCornerOutcome(market, selection, result, stats);
          if (outcome === null) {
            details.push({ eventId, match: pick.matchLabel, market, outcome: "PENDING" });
            continue;
          }

          // Guarded update: only settle rows still 'pending' so a concurrent
          // verify run can never settle the same pick twice.
          const previousDetail = Array.isArray(pick.top10Detail)
            ? (pick.top10Detail as Array<Record<string, unknown>>)
            : [];
          const changed = await db
            .update(performanceLog)
            .set({
              outcome,
              settledAt: new Date(),
              homeScore: result.homeScore,
              awayScore: result.awayScore,
              hits: outcome === "WIN" ? 1 : 0,
              misses: outcome === "LOSS" ? 1 : 0,
              pending: 0,
              accuracy: outcome === "WIN" ? 1 : 0,
              top10Detail: previousDetail.map((entry) =>
                entry.name === market
                  ? { ...entry, outcome: detailOutcomeForUpdate(outcome) }
                  : entry,
              ),
            })
            .where(and(eq(performanceLog.id, pick.id), eq(performanceLog.outcome, "pending")))
            .returning({ id: performanceLog.id });

          if (!changed[0]) {
            failed++;
            continue;
          }

          updated++;
          console.info(`[SureCorners] Match ${pick.matchLabel}: ${market} → ${outcome}`);
          details.push({ eventId, match: pick.matchLabel, market, outcome });
        }
      } catch (error) {
        failed += picks.length;
        console.error(
          `[SureCorners] ${first.matchLabel}: verification error (${error instanceof Error ? error.message : String(error)})`,
        );
        for (const pick of picks) {
          details.push({ eventId, match: pick.matchLabel, market: pick.market ?? "", outcome: "PENDING" });
        }
      }
    }

    console.info(`[SureCorners] Verification complete: ${updated} updated, ${failed} failed`);
    return Response.json({ total: pending.length, updated, failed, details } satisfies VerifySummary);
  } catch (error) {
    console.error("[SureCorners] Verification failed:", error);
    return Response.json({ error: "Verification failed" }, { status: 500 });
  }
}

export const GET = (req: Request): Promise<Response> => POST(req);
