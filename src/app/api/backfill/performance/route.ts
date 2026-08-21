// ĞIGI GIVØ — One-time historical performance backfill.
//
// Fetches historical fixtures for ALL competitions (multi-source aggregator:
// ESPN primary, TheSportsDB / OpenLigaDB / API-Football fallbacks), runs each
// finished match through the current prediction engine (multi-source
// enrichment + confidence gate) and writes the settled verifications to the
// performance tables with leagueSlug + competitionName populated.
//
// Trigger manually via POST. Protected by BACKFILL_SECRET (or Authorization
// Bearer header / ?key= query). Idempotent: re-running skips matches already
// in performance_log, so partial runs can simply be repeated.
//
//   curl -X POST "https://…/api/backfill/performance" \
//     -H "Authorization: Bearer $BACKFILL_SECRET" \
//     -H "Content-Type: application/json" \
//     -d '{ "days": 60 }'
//
// Body (all optional):
//   days         number   look-back window in days            (default 60)
//   from / to    string   explicit YYYY-MM-DD range (overrides days)
//   leagues      string[] subset of league slugs               (default: ALL)
//   timeBudgetMs number   stop starting new matches after      (default 240000)
//
// Response: { totalProcessed, totalSucceeded, totalFailed, ... }

import { db } from "@/db";
import { performanceLog } from "@/db/schema";
import { eq } from "drizzle-orm";
import { LEAGUES } from "@/lib/leagues";
import { runOracleWithStandings } from "@/lib/engine/oracle";
import { evaluateFinishedMatch } from "@/lib/engine";
import {
  fetchApiFootballFixtures,
  fetchEspnFixtures,
  fetchOpenLigaDbFixtures,
  fetchTheSportsDbFixtures,
  savePerformanceLog,
  buildTop10Detail,
  fetchEspnBoxscore,
  saveValueBets,
  oddsFromFixture,
  statsToBoxscore,
  type AggregatedFixture,
  type CompetitionFixtures,
} from "../../cron/daily-picks/route";
import { statsAggregator } from "@/lib/data/aggregator";
import type { FixtureLite } from "@/lib/espn";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const env = (name: string): string => (process.env[name] ?? "").trim();

// ─── Historical stats priority (Part 5) ──────────────────────────────────────
// Live APIs rarely serve matches older than a few days. For backfill, the
// aggregator tries the GitHub-backed sources FIRST, then falls through to the
// live sources for whatever they still serve.
const GITHUB_FIRST_PRIORITY = [
  "StatsBomb",
  "GitHubDatasets",
  "SportScore",
  "API-Football",
  "datafc",
  "worldcup2026",
  "FBref",
  "TheSportsDB",
  "OpenLigaDB",
  "Highlightly",
  "Understat",
];

/** Read the (already cached) canonical stats for a fixture — populated by the
 *  oracle run above with the GitHub-first priority. */
function peekStats(fx: FixtureLite) {
  return statsAggregator.peek({
    leagueSlug: fx.leagueSlug,
    eventId: fx.id,
    homeTeam: fx.home.name,
    awayTeam: fx.away.name,
    date: fx.date,
  });
}

// ─── Date window helpers ──────────────────────────────────────────────────────

function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function fmtCompact(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

interface Window {
  from: Date;
  to: Date;
  days: string[];       // YYYY-MM-DD, inclusive
  compactDays: string[];// YYYYMMDD
}

function resolveWindow(body: { from?: string; to?: string; days?: number }): Window {
  const to = body.to ? new Date(`${body.to}T23:59:59Z`) : new Date();
  const days = Number.isFinite(body.days) && (body.days ?? 0) > 0 ? Math.round(body.days!) : 60;
  const from = body.from
    ? new Date(`${body.from}T00:00:00Z`)
    : new Date(to.getTime() - (days - 1) * 24 * 3600_000);

  const daysList: string[] = [];
  const compact: string[] = [];
  const cursor = new Date(from);
  while (cursor <= to) {
    daysList.push(fmtDay(cursor));
    compact.push(fmtCompact(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return { from, to, days: daysList, compactDays: compact };
}

// ─── Multi-source historical fixture fetching per league ─────────────────────

async function fetchHistoricalForLeague(
  slug: string,
  window: Window,
): Promise<AggregatedFixture[]> {
  // ESPN primary — scoreboard range queries in ≤7-day chunks (limit=50).
  const chunks: AggregatedFixture[] = [];
  for (let i = 0; i < window.compactDays.length; i += 7) {
    const range = `${window.compactDays[i]}-${window.compactDays[Math.min(i + 6, window.compactDays.length - 1)]}`;
    chunks.push(...(await fetchEspnFixtures(slug, range)));
  }

  // Fallbacks only when ESPN returned nothing for the league (smaller leagues).
  if (chunks.length === 0) {
    if (slug.startsWith("ger.")) {
      chunks.push(...(await fetchOpenLigaDbFixtures(window.from, window.to)));
    }
    if (chunks.length === 0) {
      chunks.push(...(await fetchTheSportsDbFixtures(window.days)));
    }
    if (chunks.length === 0) {
      chunks.push(...(await fetchApiFootballFixtures(window.days)));
    }
  }
  return chunks;
}

// ─── Main backfill ────────────────────────────────────────────────────────────

export interface BackfillSummary {
  ok: boolean;
  totalProcessed: number;
  totalSucceeded: number;
  totalFailed: number;
  leaguesSwept: number;
  valueBetsLogged: number;
  window: { from: string; to: string };
  failures: Array<{ leagueSlug: string; eventId: string; error: string }>;
  ranAt: string;
}

async function runBackfill(body: {
  from?: string; to?: string; days?: number; leagues?: string[]; timeBudgetMs?: number;
}): Promise<BackfillSummary> {
  const window = resolveWindow(body);
  const budget = Number.isFinite(body.timeBudgetMs) && (body.timeBudgetMs ?? 0) > 0
    ? body.timeBudgetMs!
    : 240_000;
  const deadline = Date.now() + budget;

  const allowlist = new Set((body.leagues ?? []).filter(Boolean));
  const slugs = LEAGUES.map((l) => l.slug).filter((s) => allowlist.size === 0 || allowlist.has(s));

  const summary: BackfillSummary = {
    ok: true,
    totalProcessed: 0,
    totalSucceeded: 0,
    totalFailed: 0,
    leaguesSwept: 0,
    valueBetsLogged: 0,
    window: { from: fmtDay(window.from), to: fmtDay(window.to) },
    failures: [],
    ranAt: new Date().toISOString(),
  };

  console.log(
    `[Backfill] Starting historical sweep ${summary.window.from} → ${summary.window.to} ` +
    `(${slugs.length} competitions, budget ${Math.round(budget / 1000)}s)`,
  );

  for (const slug of slugs) {
    if (Date.now() > deadline) {
      console.log(`[Backfill] Time budget reached — ${summary.totalProcessed} matches processed; re-run to continue.`);
      break;
    }
    try {
      const fixtures = await fetchHistoricalForLeague(slug, window);
      if (fixtures.length === 0) continue;
      summary.leaguesSwept++;

      const comp: CompetitionFixtures = {
        leagueSlug: slug,
        competitionName: fixtures[0].fixture.leagueName,
        fixtures,
      };

      for (const { fixture: fx } of fixtures) {
        if (Date.now() > deadline) break;
        if (fx.state !== "post" || fx.home.score === null || fx.away.score === null) continue;
        summary.totalProcessed++;

        try {
          // Already processed in a previous run? (idempotent)
          const existing = await db
            .select({ id: performanceLog.id, pending: performanceLog.pending })
            .from(performanceLog)
            .where(eq(performanceLog.eventId, fx.id))
            .limit(1);
          if (existing[0]) {
            // Existing rows may pre-date late provider/boxscore data. Re-evaluate
            // them during backfill instead of leaving their individual bets pending.
            if (existing[0].pending > 0) {
              const pred = await runOracleWithStandings(fx, { statsPriority: GITHUB_FIRST_PRIORITY });
              if (!pred) {
                summary.totalFailed++;
                summary.failures.push({ leagueSlug: slug, eventId: fx.id, error: "pending row could not be re-evaluated" });
                continue;
              }
              const boxscore = (await fetchEspnBoxscore(fx.leagueSlug, fx.id))
                ?? statsToBoxscore(peekStats(fx));
              evaluateFinishedMatch(fx, pred, boxscore);
              const detail = buildTop10Detail(pred);
              const hits = detail.filter((pick) => pick.outcome === "HIT").length;
              const misses = detail.filter((pick) => pick.outcome === "MISS").length;
              const pending = detail.filter((pick) => pick.outcome === "PENDING").length;
              const decided = hits + misses;
              await db.update(performanceLog).set({
                top10Detail: detail,
                hits,
                misses,
                pending,
                accuracy: decided > 0 ? hits / decided : 0,
              }).where(eq(performanceLog.id, existing[0].id));
            }
            summary.totalSucceeded++;
            continue;
          }

          const pred = await runOracleWithStandings(fx, { statsPriority: GITHUB_FIRST_PRIORITY });
          if (!pred) {
            // Unplayable by the engine — integrity over volume.
            summary.totalFailed++;
            summary.failures.push({ leagueSlug: slug, eventId: fx.id, error: "unplayable (no real data sources)" });
            continue;
          }

          const saved = await savePerformanceLog(
            fx,
            comp.competitionName,
            pred,
            (await fetchEspnBoxscore(fx.leagueSlug, fx.id)) ?? statsToBoxscore(peekStats(fx)),
          );
          if (saved) {
            summary.totalSucceeded++;
            const vbs = await saveValueBets(fx, comp.competitionName, pred, oddsFromFixture(fx));
            summary.valueBetsLogged += vbs;
          }
        } catch (err) {
          summary.totalFailed++;
          summary.failures.push({
            leagueSlug: slug,
            eventId: fx.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (summary.totalProcessed % 25 === 0) {
          console.log(`[Backfill] ${summary.totalProcessed} matches processed (${summary.totalSucceeded} succeeded, ${summary.totalFailed} failed)`);
        }
      }
    } catch (err) {
      console.error(`[Backfill] SKIPPED league ${slug}:`, err instanceof Error ? err.message : String(err));
    }
  }

  console.log(
    `[Backfill] Done: ${summary.totalProcessed} processed, ${summary.totalSucceeded} succeeded, ${summary.totalFailed} failed across ${summary.leaguesSwept} competitions`,
  );
  return summary;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function authorized(req: Request): boolean {
  const secret = process.env.BACKFILL_SECRET;
  if (!secret) return true; // no secret configured → open (dev/local only)
  const url = new URL(req.url);
  const provided =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    url.searchParams.get("key");
  return provided === secret;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({})) as {
      from?: string; to?: string; days?: number; leagues?: string[]; timeBudgetMs?: number;
    };
    return Response.json(await runBackfill(body));
  } catch (err) {
    console.error("[Backfill] failed:", err);
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "Backfill failed" },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  // GET exposes a dry-run of the window only (no processing).
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const window = resolveWindow({});
  return Response.json({
    ok: true,
    hint: "POST to this endpoint to run the backfill (see route docs).",
    defaultWindow: { from: fmtDay(window.from), to: fmtDay(window.to), days: window.days.length },
  });
}
