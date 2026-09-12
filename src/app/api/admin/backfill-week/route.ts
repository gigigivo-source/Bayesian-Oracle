// ĞIGI GIVØ — One-time backfill for the Weekly Accumulator window.
//
// Runs the same 7-day sweep as the daily-picks cron (next 7 days, 8
// accumulator competitions) but only ensures `predictions` rows exist — it
// bypasses the cron's daily_picks / performance_log "already exists" checks
// and fills in every missing prediction for the current week immediately,
// instead of waiting for tomorrow's cron.
//
// Trigger manually via POST. Protected by CRON_SECRET (same guard as
// /api/cron/daily-picks: Authorization Bearer header or ?key= query; open
// when CRON_SECRET is unset).
//
//   curl -X POST "http://localhost:3000/api/admin/backfill-week" \
//     -H "Authorization: Bearer $CRON_SECRET"
//
// Response: { processed, inserted, skipped, failed }
//   processed — fixtures seen in the 7-day window
//   inserted  — predictions rows written (new or refreshed)
//   skipped   — already had a row, unplayable, or pure-Synthetic
//   failed    — engine/DB errors

import { db } from "@/db";
import { predictions } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  aggregateAllCompetitions,
  DAILY_PICKS_7DAY_LEAGUES,
  DAILY_PICKS_SWEEP_DAYS,
  isPureSyntheticPrediction,
  savePredictionRow,
} from "@/app/api/cron/daily-picks/route";
import { runOracleAllModesWithStandings } from "@/lib/engine/oracle";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const env = (name: string): string => (process.env[name] ?? "").trim();

const TIME_BUDGET_MS = () => {
  const raw = Number(env("BACKFILL_WEEK_TIME_BUDGET_MS"));
  return Number.isFinite(raw) && raw > 0 ? raw : 240_000;
};

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured → open (dev/local)
  const url = new URL(req.url);
  const provided =
    req.headers.get("authorization")?.replace("Bearer ", "") ??
    url.searchParams.get("key");
  return provided === secret;
}

export interface BackfillWeekSummary {
  processed: number;
  inserted: number;
  skipped: number;
  failed: number;
}

async function runBackfillWeek(): Promise<BackfillWeekSummary> {
  const startedAt = Date.now();
  const deadline = startedAt + TIME_BUDGET_MS();

  const competitions = await aggregateAllCompetitions({
    leagueSlugs: [...DAILY_PICKS_7DAY_LEAGUES],
    days: DAILY_PICKS_SWEEP_DAYS,
  });

  const total = competitions.reduce((n, c) => n + c.fixtures.length, 0);
  console.log(`[DailyPicks] 7-day sweep: ${total} matches across ${competitions.length} competitions`);

  const summary: BackfillWeekSummary = { processed: 0, inserted: 0, skipped: 0, failed: 0 };

  for (const comp of competitions) {
    for (const { fixture: fx } of comp.fixtures) {
      if (Date.now() > deadline) {
        console.log(
          `[DailyPicks] Backfill time budget reached — ${summary.processed}/${total} processed; re-run to continue.`,
        );
        return summary;
      }
      summary.processed++;
      try {
        if (!fx.id) {
          summary.skipped++;
          continue;
        }

        // Fill missing predictions only — eventIds that already have a row
        // are skipped without re-running the engine. daily_picks /
        // performance_log existence is deliberately ignored (bypassed): this
        // route backfills the predictions learning log, nothing else.
        const existing = await db
          .select({ id: predictions.id })
          .from(predictions)
          .where(eq(predictions.eventId, fx.id))
          .limit(1);
        if (existing[0]) {
          summary.skipped++;
          continue;
        }

        const preds = await runOracleAllModesWithStandings(fx);
        if (preds.size === 0) {
          summary.skipped++; // unplayable — integrity over volume
          continue;
        }
        const canonical = preds.get("B") ?? preds.values().next().value;
        if (!canonical) {
          summary.skipped++;
          continue;
        }

        // Same Real/Mixed-only gate as the cron — pure-Synthetic outputs are
        // never written so the accumulator never sees unusable rows.
        if (isPureSyntheticPrediction(canonical)) {
          summary.skipped++;
          const completeness = Math.round(canonical.match?.dataCompletenessScore ?? 0);
          console.log(
            `[DailyPicks] Skipped prediction for ${fx.home.name} vs ${fx.away.name} — synthetic data (completeness ${completeness})`,
          );
          continue;
        }

        const persisted = await savePredictionRow(fx, comp.competitionName, canonical);
        if (persisted === "new" || persisted === "updated") summary.inserted++;
        else summary.failed++;
      } catch (err) {
        summary.failed++;
        console.error(
          `[DailyPicks] Backfill failed for ${fx.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  console.log(
    `[DailyPicks] Backfill-week finished: ${summary.processed} processed, ` +
      `${summary.inserted} inserted, ${summary.skipped} skipped, ${summary.failed} failed`,
  );
  return summary;
}

async function handle(req: Request): Promise<Response> {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return Response.json({ ...(await runBackfillWeek()) });
  } catch (err) {
    console.error("[DailyPicks] backfill-week failed:", err);
    return Response.json({ error: "Backfill failed" }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}

export async function GET(req: Request): Promise<Response> {
  return handle(req);
}
