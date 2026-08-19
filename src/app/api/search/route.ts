import { fetchScoreboard, type FixtureLite } from "@/lib/espn";
import { LEAGUES } from "@/lib/leagues";

export const dynamic = "force-dynamic";

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// ─── In-process fixture cache ─────────────────────────────────────────────────
// Avoids rescanning all leagues on every keystroke. TTL = 5 minutes.
let fixtureCache: FixtureLite[] = [];
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getFixtureCache(): Promise<FixtureLite[]> {
  if (Date.now() - cacheTime < CACHE_TTL && fixtureCache.length > 0) {
    return fixtureCache;
  }

  const now  = new Date();
  const from = new Date(now); from.setDate(from.getDate() - 7);
  const to14 = new Date(now); to14.setDate(now.getDate() + 14);
  // Wide range: last 7 days results + next 14 days upcoming
  const range = `${fmt(from)}-${fmt(to14)}`;

  const all: FixtureLite[] = [];

  // Always-active leagues — fetch with wide range
  const activeLeagues = [
    "bra.1","arg.1","mex.1","usa.1","ksa.1","jpn.1","kor.1","col.1","chi.1",
    "uru.1","per.1","ecu.1","ven.1","par.1","uae.1","qat.1","egy.1","rsa.1",
    "nor.1","swe.1","den.1","tur.1","bel.1","sco.1","pol.1","cze.1","rou.1",
    "conmebol.libertadores","conmebol.sudamericana","caf.champions","afc.champions",
    "fifa.friendly","fifa.world","uefa.champions","uefa.europa","conmebol.america",
    "eng.1","esp.1","ger.1","ita.1","fra.1","ned.1","por.1",
  ];

  // Fetch active leagues with range
  const activeResults = await Promise.all(
    activeLeagues.map((s) => fetchScoreboard(s, range).catch(() => [] as FixtureLite[]))
  );
  all.push(...activeResults.flat());

  // Also fetch current 3-day window for all
  const currentResults = await Promise.all(
    activeLeagues.slice(0, 20).map((s) => fetchScoreboard(s).catch(() => [] as FixtureLite[]))
  );
  all.push(...currentResults.flat());

  // Deduplicate by fixture ID
  const seen = new Set<string>();
  fixtureCache = [];
  for (const f of all) {
    if (!seen.has(f.id)) {
      seen.add(f.id);
      fixtureCache.push(f);
    }
  }
  cacheTime = Date.now();
  return fixtureCache;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").toLowerCase().trim();

  if (q.length < 2) {
    return Response.json({ results: [] });
  }

  const fixtures = await getFixtureCache();

  const matches = fixtures.filter((f) => {
    const text = `${f.home.name} ${f.away.name} ${f.home.shortName} ${f.away.shortName} ${f.leagueName}`.toLowerCase();
    return text.includes(q);
  });

  // Live → upcoming → finished; within each group sort by date ascending
  matches.sort((a, b) => {
    const rank = (s: string) => (s === "in" ? 0 : s === "pre" ? 1 : 2);
    if (rank(a.state) !== rank(b.state)) return rank(a.state) - rank(b.state);
    return new Date(a.date).getTime() - new Date(b.date).getTime();
  });

  return Response.json({
    results: matches.slice(0, 20),
    cached:  true,
    total:   fixtures.length,
  });
}
