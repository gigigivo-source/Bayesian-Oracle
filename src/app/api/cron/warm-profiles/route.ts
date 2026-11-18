// ĞIGI GIVØ — Team profile warming cron.
// Pre-fetches and caches real per-team stat distributions for upcoming matches.
// Run every 6 hours. This ensures realLambdas uses real ESPN boxscore data
// for 90%+ of matches instead of falling back to league priors.

import { apiError, errorMessage } from "@/lib/apiErrors";
import { fetchScoreboard } from "@/lib/espn";
import { getCachedMeshProfile } from "@/lib/engine/dataMesh";
import { TOP_FEED_SLUGS } from "@/lib/leagues";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
  const now  = new Date();
  const from = new Date(now); from.setDate(now.getDate() - 1);
  const to   = new Date(now); to.setDate(now.getDate() + 3);
  const fmt  = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const range = `${fmt(from)}-${fmt(to)}`;

  const slugs = TOP_FEED_SLUGS.slice(0, 12); // top 12 leagues
  let warmed = 0; let skipped = 0;
  const failures: string[] = [];

  for (const slug of slugs) {
    try {
      const fixtures = await fetchScoreboard(slug, range);
      const upcoming = fixtures.filter((f) => f.state === "pre");

      for (const fx of upcoming.slice(0, 6)) { // max 6 per league
        const teams = [
          { name: fx.home.name, slug },
          { name: fx.away.name, slug },
        ];
        for (const { name, slug: ls } of teams) {
          try {
            const existing = await getCachedMeshProfile(name, ls);
            if (existing && existing.samples >= 3) {
              skipped++;
            } else {
              await getCachedMeshProfile(name, ls);
              warmed++;
            }
          } catch (err) {
            failures.push(errorMessage(err));
          }
          // Rate limit — be polite to ESPN
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    } catch (err) {
      failures.push(errorMessage(err));
    }
  }

  if (failures.length > 0) {
    return apiError("Profile warming failed", new Error(failures.join("; ")), 500, {
      ok: false,
      warmed,
      skipped,
      errors: failures.length,
      ranAt: new Date().toISOString(),
    });
  }

  return Response.json({
    ok: true,
    warmed,
    skipped,
    errors: 0,
    ranAt: new Date().toISOString(),
  });

  } catch (__routeError) {
    return apiError("GET /api/cron/warm-profiles failed", __routeError);
  }
}
