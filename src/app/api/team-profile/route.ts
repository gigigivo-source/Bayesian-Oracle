import { getCachedMeshProfile } from "@/lib/engine/dataMesh";

export const dynamic = "force-dynamic";

/**
 * GET /api/team-profile?team=Arsenal&league=eng.1
 *
 * Returns the multi-provider real-stat mesh profile for a team.
 * Cached in DB for 6 hours. Fail-soft — returns 404 if no data available.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const team   = searchParams.get("team")   ?? "";
  const league = searchParams.get("league") ?? "eng.1";

  if (!team.trim()) {
    return Response.json({ error: "team parameter is required" }, { status: 400 });
  }

  const profile = await getCachedMeshProfile(team.trim(), league);

  if (!profile) {
    return Response.json(
      { error: `No stat data found for "${team}" in ${league}. Try after a matchday.` },
      { status: 404 },
    );
  }

  return Response.json({
    team,
    league,
    profile,
    providers:     profile.providers,
    providerCount: profile.providerCount,
    samples:       profile.samples,
  });
}
