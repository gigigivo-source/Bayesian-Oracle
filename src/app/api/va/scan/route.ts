import { performScan } from "@/lib/va/performScan";
import type { VaScanMode } from "@/lib/va/scanner";
import { requireCronAuth } from "@/lib/apiAuth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Runs the VA scan.
 *
 * Auth: bearer header only, via `requireCronAuth` (@/lib/apiAuth) — constant
 * time compare, no `?secret=`/`x-cron-secret`/`cron_secret` variants (query
 * secrets leak into access logs), and FAIL CLOSED in production when
 * CRON_SECRET is unset.
 *
 * `?finished=true` runs the read-only backtest scan. It used to skip auth
 * entirely; it still queries live fixture and odds providers, so it is now
 * gated exactly like the live scan.
 *
 * `?freshOdds=true` bypasses the `league_odds_cache` read for every league the
 * scan actually fetches, so every leg is priced from a response fetched right
 * now (the response is still cached afterwards). Omit it for the normal scan,
 * which serves cached odds with ZERO Odds API requests when they are still
 * inside their TTL.
 *
 * The scan itself lives in `@/lib/va/performScan` so the in-app server action
 * (`runLiveScan`) can share it without an HTTP hop or the bearer secret.
 */
export async function POST(req: Request) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const finished = url.searchParams.get("finished") === "true";
  const forceRefresh = url.searchParams.get("freshOdds") === "true";

  const modeParam = url.searchParams.get("mode")?.trim().toLowerCase();
  const mode: VaScanMode = modeParam === "stack" ? "stack" : "value";

  const result = await performScan(mode, finished, forceRefresh);
  return Response.json(result.body, { status: result.status });
}
