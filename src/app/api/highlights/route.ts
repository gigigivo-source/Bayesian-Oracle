import {
  getLatestHighlights,
  searchHighlights,
  getMatchHighlights,
  getCompetitionHighlights,
} from "@/lib/highlightly";

export const dynamic = "force-dynamic";

/**
 * GET /api/highlights
 *   ?q=Arsenal            → search by team/competition
 *   ?home=Arsenal&away=Chelsea  → match-specific highlights
 *   ?competition=Champions+League → competition highlights
 *   (no params)           → latest highlights
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q           = searchParams.get("q");
  const home        = searchParams.get("home");
  const away        = searchParams.get("away");
  const competition = searchParams.get("competition");
  const limit       = Math.min(parseInt(searchParams.get("limit") ?? "20"), 50);

  if (!process.env.HIGHLIGHTLY_KEY) {
    return Response.json({ highlights: [], error: "Highlightly key not configured" });
  }

  let highlights;

  if (home && away) {
    highlights = await getMatchHighlights(home, away);
  } else if (q) {
    highlights = await searchHighlights(q, limit);
  } else if (competition) {
    highlights = await getCompetitionHighlights(competition, limit);
  } else {
    highlights = await getLatestHighlights(limit);
  }

  return Response.json({ highlights, count: highlights.length });
}
