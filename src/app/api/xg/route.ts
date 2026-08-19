import { analyseMatchXg, getStatsBombMatches } from "@/lib/engine/xg";

export const dynamic = "force-dynamic";

// StatsBomb open-data competition IDs
const COMPETITIONS: Record<string, { id: number; seasonId: number; name: string }> = {
  worldcup2022:    { id: 43,  seasonId: 106, name: "FIFA World Cup 2022" },
  euro2024:        { id: 55,  seasonId: 282, name: "UEFA Euro 2024" },
  euro2020:        { id: 55,  seasonId: 43,  name: "UEFA Euro 2020" },
  ucl2019:         { id: 16,  seasonId: 4,   name: "Champions League 2018/19" },
  bundesliga2024:  { id: 9,   seasonId: 281, name: "Bundesliga 2023/24" },
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const matchId     = searchParams.get("match");
  const competition = searchParams.get("competition");

  // ── Analyse a specific match ──────────────────────────────────────────────────
  if (matchId) {
    const result = await analyseMatchXg(Number(matchId));
    if (!result) {
      return Response.json({ error: "Match not found or no shot data" }, { status: 404 });
    }
    return Response.json(result);
  }

  // ── List matches for a competition ────────────────────────────────────────────
  if (competition && COMPETITIONS[competition]) {
    const comp    = COMPETITIONS[competition];
    const matches = await getStatsBombMatches(comp.id, comp.seasonId);
    return Response.json({ competition: comp.name, matches, count: matches.length });
  }

  // ── List available competitions ───────────────────────────────────────────────
  return Response.json({
    competitions: Object.entries(COMPETITIONS).map(([key, comp]) => ({ key, ...comp })),
  });
}
