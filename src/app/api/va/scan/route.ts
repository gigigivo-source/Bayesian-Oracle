import { performScan } from "@/lib/va/performScan";
import type { VaScanMode } from "@/lib/va/scanner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function getCronSecret(): string {
  return (process.env.CRON_SECRET ?? "").trim();
}

/**
 * Runs the VA scan; ?finished=true skips authentication for local backtests.
 * All other requests retain the existing CRON_SECRET authentication check.
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
  const url = new URL(req.url);
  const finished = url.searchParams.get("finished") === "true";
  const forceRefresh = url.searchParams.get("freshOdds") === "true";

  if (!finished) {
    // Protected by CRON_SECRET header
    const auth = req.headers.get("authorization") || req.headers.get("x-cron-secret") || "";
    const secret = getCronSecret();
    const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : auth.trim();
    // Also allow ?secret= or header CRON_SECRET
    const querySecret = url.searchParams.get("secret")?.trim() ?? "";

    if (secret) {
      const ok = provided === secret || querySecret === secret || req.headers.get("cron_secret") === secret;
      if (!ok) {
        return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
      }
    }
  }

  const modeParam = url.searchParams.get("mode")?.trim().toLowerCase();
  const mode: VaScanMode = modeParam === "stack" ? "stack" : "value";

  const result = await performScan(mode, finished, forceRefresh);
  return Response.json(result.body, { status: result.status });
}
