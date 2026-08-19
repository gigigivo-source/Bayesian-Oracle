import { LEAGUE_MAP } from "@/lib/leagues";

export const dynamic = "force-dynamic";

// ESPN v2 standings endpoint
const ESPN_V2 = "https://site.api.espn.com/apis/v2/sports/soccer";
// ESPN site endpoint (some leagues use this format)
const ESPN_V1 = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// Cup competitions that use knockout format — no standings table
const KNOCKOUT_CUPS = new Set([
  "eng.fa", "eng.league_cup", "eng.trophy",
  "esp.copa_del_rey", "esp.super_cup",
  "ger.dfb_pokal", "ger.super_cup",
  "ita.coppa_italia", "ita.super_cup",
  "fra.coupe_de_france", "fra.coupe_de_la_ligue",
  "ned.cup", "por.cup", "sco.fa", "sco.league_cup",
  "bel.cup", "tur.cup", "gre.cup", "sui.2",
  "fifa.cwc", "uefa.super_cup",
  "concacaf.gold", "concacaf.champions",
  "caf.champions", "caf.confed", "caf.supercup",
  "ofc.champions", "afc.cup",
  "bra.copa", "bra.gaucho", "bra.paulista", "bra.carioca", "bra.mineiro",
  "arg.copa", "col.2", "chi.2", "uru.2",
  "fifa.friendly", "usa.open",
]);

interface StandingsEntry {
  rank:           number;
  team:           string;
  teamLogo:       string | null;
  played:         number;
  won:            number;
  drawn:          number;
  lost:           number;
  goalsFor:       number;
  goalsAgainst:   number;
  goalDifference: number;
  points:         number;
  form:           string;
}

interface EspnStat { name?: string; abbreviation?: string; displayValue?: string; value?: number }
interface EspnEntry {
  team?: { displayName?: string; name?: string; logos?: Array<{ href?: string }> };
  stats?: EspnStat[];
  note?: { rank?: number };
  rank?: number;
}
interface EspnGroup { standings?: { entries?: EspnEntry[] }; entries?: EspnEntry[] }
interface EspnStandings { children?: EspnGroup[]; standings?: { entries?: EspnEntry[] } }

function parseEntries(groups: EspnGroup[]): StandingsEntry[] {
  const entries: StandingsEntry[] = [];
  for (const group of groups) {
    const rows = (group.standings?.entries ?? group.entries ?? []) as EspnEntry[];
    for (const row of rows) {
      const stats: Record<string, string> = {};
      for (const s of row.stats ?? []) {
        const key = s.name ?? s.abbreviation ?? "";
        if (key) stats[key] = s.displayValue ?? String(s.value ?? "");
      }
      const rank = Number(row.note?.rank ?? row.rank ?? entries.length + 1);
      entries.push({
        rank,
        team:           row.team?.displayName ?? row.team?.name ?? "Unknown",
        teamLogo:       row.team?.logos?.[0]?.href ?? null,
        played:         Number(stats.gamesPlayed   ?? stats.GP ?? 0),
        won:            Number(stats.wins           ?? stats.W  ?? 0),
        drawn:          Number(stats.ties           ?? stats.D  ?? stats.draws ?? 0),
        lost:           Number(stats.losses         ?? stats.L  ?? 0),
        goalsFor:       Number(stats.pointsFor      ?? stats.GF ?? stats.goals ?? 0),
        goalsAgainst:   Number(stats.pointsAgainst  ?? stats.GA ?? 0),
        goalDifference: Number(stats.pointDifferential ?? stats.GD ?? stats.goalDifference ?? 0),
        points:         Number(stats.points         ?? stats.PTS ?? 0),
        form:           stats.overall ?? stats.form ?? "",
      });
    }
  }
  return entries.sort((a, b) => a.rank - b.rank);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const league = searchParams.get("league");

  if (!league || !LEAGUE_MAP[league]) {
    return Response.json({ error: "Unknown or missing league slug." }, { status: 400 });
  }

  const leagueDef = LEAGUE_MAP[league];

  // Cups with knockout format — return helpful message, not an error
  if (KNOCKOUT_CUPS.has(league)) {
    return Response.json({
      league: leagueDef,
      entries: [],
      knockoutFormat: true,
      message: `${leagueDef.name} uses a knockout/cup format — no standings table available. Check the Fixtures tab for match results and brackets.`,
    });
  }

  // Try ESPN v2 first, fall back to v1
  try {
    const res = await fetch(`${ESPN_V2}/${league}/standings`, {
      headers: { "User-Agent": "Mozilla/5.0 GigiGivo/2.0" },
      next: { revalidate: 600 },
    });

    if (res.ok) {
      const data = await res.json() as EspnStandings;
      const groups = data.children ?? (data.standings ? [{ standings: data.standings }] : []);
      const entries = parseEntries(groups);
      if (entries.length > 0) {
        return Response.json({ league: leagueDef, entries, knockoutFormat: false });
      }
    }
  } catch { /* try v1 */ }

  // Fall back to ESPN v1 scoreboard-derived standings
  try {
    const res = await fetch(`${ESPN_V1}/${league}/standings`, {
      headers: { "User-Agent": "Mozilla/5.0 GigiGivo/2.0" },
      next: { revalidate: 600 },
    });
    if (res.ok) {
      const data = await res.json() as EspnStandings;
      const groups = data.children ?? (data.standings ? [{ standings: data.standings }] : []);
      const entries = parseEntries(groups);
      if (entries.length > 0) {
        return Response.json({ league: leagueDef, entries, knockoutFormat: false });
      }
    }
  } catch { /* no standings available */ }

  // No standings found — return graceful empty response
  return Response.json({
    league: leagueDef,
    entries: [],
    knockoutFormat: false,
    message: `No standings data available for ${leagueDef.name}. The season may not have started or standings are not published for this competition.`,
  });
}
