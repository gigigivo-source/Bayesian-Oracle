import { fetchAllScoreboard } from "@/lib/espn";
import { liveScoreboardDates, selectLiveFixtures } from "@/lib/liveFixtures";

export const dynamic = "force-dynamic";

/**
 * Complete, lightweight live feed.
 *
 * ESPN's `soccer/all` scoreboard discovers every competition in one request.
 * This avoids both failure modes of the old implementation: curated league
 * lists omitted live matches, while polling `/api/top` rebuilt ~70 unrelated
 * schedule feeds and could return a stale snapshot.
 */
export async function GET() {
  const fixtures = await fetchAllScoreboard(liveScoreboardDates());

  // Treat an upstream outage differently from a valid no-live-games response.
  // The client can then retain its last good scores instead of incorrectly
  // replacing them with a "No matches" state.
  if (fixtures === null) {
    return Response.json(
      { error: "Live scoreboard is temporarily unavailable." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const live = selectLiveFixtures(fixtures);
  return Response.json(
    {
      live,
      liveCount: live.length,
      updatedAt: new Date().toISOString(),
    },
    {
      // Browser/CDN responses must not outlive the 15-second polling cycle.
      // The provider request itself is protected by a short in-memory cache and
      // single-flight coalescing in the shared HTTP client.
      headers: { "Cache-Control": "no-store" },
    },
  );
}
