import { fetchScoreboard, type FixtureLite } from "@/lib/espn";
import { compareLeaguePriority, leagueTier } from "@/lib/leaguePriority";

export const dynamic = "force-dynamic";

// Featured leagues on the Top Matches home feed.
// PROFESSIONAL RULE: Only shows TODAY's matches (±1 day window).
// This is the live sportsbook feed — not a fixture calendar.
const FEATURED = [
  { slug: "bra.1",                 label: "Brasileirão" },
  { slug: "arg.1",                 label: "Liga Profesional" },
  { slug: "mex.1",                 label: "Liga MX" },
  { slug: "usa.1",                 label: "MLS" },
  { slug: "ksa.1",                 label: "Saudi Pro League" },
  { slug: "jpn.1",                 label: "J1 League" },
  { slug: "conmebol.libertadores", label: "Copa Libertadores" },
  { slug: "conmebol.sudamericana", label: "Copa Sudamericana" },
  { slug: "eng.1",                 label: "Premier League" },
  { slug: "esp.1",                 label: "LaLiga" },
  { slug: "ita.1",                 label: "Serie A" },
  { slug: "ger.1",                 label: "Bundesliga" },
  { slug: "fra.1",                 label: "Ligue 1" },
  { slug: "ned.1",                 label: "Eredivisie" },
  { slug: "por.1",                 label: "Primeira Liga" },
  { slug: "uefa.champions",        label: "Champions League" },
  { slug: "uefa.europa",           label: "Europa League" },
  { slug: "conmebol.america",      label: "Copa América" },
  { slug: "fifa.world",            label: "FIFA World Cup" },
  { slug: "uefa.euro",             label: "UEFA Euro" },
];

const EXTRA = [
  { slug: "sco.1",   label: "Scottish Premiership" },
  { slug: "bel.1",   label: "Belgian Pro League" },
  { slug: "tur.1",   label: "Süper Lig" },
  { slug: "kor.1",   label: "K League 1" },
  { slug: "chn.1",   label: "Chinese Super League" },
  { slug: "aus.1",   label: "A-League" },
  { slug: "col.1",   label: "Primera A Colombia" },
  { slug: "chi.1",   label: "Primera División Chile" },
  { slug: "uru.1",   label: "Primera División Uruguay" },
  { slug: "per.1",   label: "Liga 1 Perú" },
  { slug: "ecu.1",   label: "LigaPro Ecuador" },
  { slug: "par.1",   label: "Primera División Paraguay" },
  { slug: "ven.1",   label: "Liga FUTVE" },
  { slug: "can.1",   label: "Canadian Premier League" },
  { slug: "ind.1",   label: "Indian Super League" },
  { slug: "tha.1",   label: "Thai League 1" },
  { slug: "mys.1",   label: "Malaysia Super League" },
  { slug: "idn.1",   label: "Liga 1 Indonesia" },
  { slug: "uae.1",   label: "UAE Pro League" },
  { slug: "qat.1",   label: "Qatar Stars League" },
  { slug: "egy.1",   label: "Egyptian Premier League" },
  { slug: "rsa.1",   label: "South African Premiership" },
  { slug: "nga.1",   label: "Nigeria Premier League" },
  { slug: "mar.1",   label: "Botola Pro (Morocco)" },
  { slug: "nor.1",   label: "Eliteserien" },
  { slug: "swe.1",   label: "Allsvenskan" },
  { slug: "den.1",   label: "Danish Superliga" },
  { slug: "eng.2",   label: "Championship" },
  { slug: "ger.2",   label: "2. Bundesliga" },
  { slug: "esp.2",   label: "LaLiga 2" },
  { slug: "ita.2",   label: "Serie B" },
  { slug: "fra.2",   label: "Ligue 2" },
  { slug: "pol.1",   label: "Ekstraklasa" },
  { slug: "cze.1",   label: "Czech First League" },
  { slug: "gre.1",   label: "Super League Greece" },
  { slug: "srb.1",   label: "SuperLiga Serbia" },
  { slug: "cro.1",   label: "HNL Croatia" },
  { slug: "ukr.1",   label: "Ukrainian Premier League" },
  { slug: "isr.1",   label: "Israeli Premier League" },
  { slug: "caf.champions",         label: "CAF Champions League" },
  { slug: "afc.champions",         label: "AFC Champions League" },
  { slug: "concacaf.champions",    label: "CONCACAF Champions Cup" },
  { slug: "fifa.cwc",              label: "FIFA Club World Cup" },
  { slug: "uefa.nations",          label: "UEFA Nations League" },
  { slug: "concacaf.gold",         label: "CONCACAF Gold Cup" },
  { slug: "caf.nations",           label: "Africa Cup of Nations" },
  { slug: "afc.asian.cup",         label: "AFC Asian Cup" },
  { slug: "fifa.friendly",         label: "International Friendlies" },
];

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function GET() {
  const now  = new Date();

  // TOP FEED: professional sportsbook window = yesterday, today, tomorrow only.
  // Do NOT show matches 7, 14, or 60 days away on the home feed.
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const tomorrow  = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const todayWindow = `${fmt(yesterday)}-${fmt(tomorrow)}`;

  // Recent results: last 7 days (for the results section below each league)
  const from7 = new Date(now); from7.setDate(now.getDate() - 7);
  const recentRange = `${fmt(from7)}-${fmt(now)}`;

  // Fetch featured leagues — TODAY window for live/upcoming + recent for results
  const results = await Promise.all(
    FEATURED.map(async (l) => {
      const [todayFx, recentFx] = await Promise.all([
        fetchScoreboard(l.slug, todayWindow).catch(() => [] as FixtureLite[]),
        fetchScoreboard(l.slug, recentRange).catch(() => [] as FixtureLite[]),
      ]);

      // Dedup
      const seen = new Set<string>();
      const all: FixtureLite[] = [];
      for (const fx of [...todayFx, ...recentFx]) {
        if (!seen.has(fx.id)) { seen.add(fx.id); all.push(fx); }
      }

      const upcoming = todayFx.filter((f) => f.state === "pre" || f.state === "in")
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      const finished = recentFx
        .filter((f) => f.state === "post")
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 8);

      return { slug: l.slug, label: l.label, fixtures: all, upcoming, results: finished };
    }),
  );

  // Extra leagues — today window only
  const BATCH = 8;
  const extraResults: typeof results = [];

  for (let i = 0; i < EXTRA.length; i += BATCH) {
    const batch = EXTRA.slice(i, i + BATCH);
    const batchData = await Promise.allSettled(
      batch.map(async (l) => {
        const fixtures = await fetchScoreboard(l.slug, todayWindow).catch(() => [] as FixtureLite[]);
        return {
          slug:     l.slug,
          label:    l.label,
          fixtures,
          upcoming: fixtures.filter((f) => f.state === "pre" || f.state === "in"),
          results:  fixtures.filter((f) => f.state === "post").slice(0, 5),
        };
      }),
    );
    for (const r of batchData) {
      if (r.status === "fulfilled" && r.value.fixtures.length > 0) {
        extraResults.push(r.value);
      }
    }
  }

  // Live matches across everything
  const seen = new Set<string>();
  const live = [...results, ...extraResults]
    .flatMap((r) => r.fixtures)
    .filter((f) => {
      if (f.state !== "in" || seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    })
    // Live feed ordered by league importance (biggest leagues first),
    // then by kickoff time within the same tier.
    .sort(
      (a, b) =>
        compareLeaguePriority(a, b) ||
        new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

  // Sort featured leagues by importance tier (Champions League, Premier League,
  // … at the top), keeping leagues with live/active matches ahead of quiet ones
  // within the same tier.
  const activityScore = (r: { upcoming: FixtureLite[]; results: FixtureLite[] }) =>
    r.upcoming.length * 2 + r.results.length;
  const byLeaguePriority = (
    a: { slug: string; upcoming: FixtureLite[]; results: FixtureLite[] },
    b: { slug: string; upcoming: FixtureLite[]; results: FixtureLite[] },
  ) =>
    leagueTier({ leagueSlug: a.slug }) - leagueTier({ leagueSlug: b.slug }) ||
    activityScore(b) - activityScore(a);

  const sortedResults = [...results].sort(byLeaguePriority);
  const sortedExtra = [...extraResults].sort(byLeaguePriority);

  return Response.json({
    featured:  sortedResults,
    extra:     sortedExtra,
    live,
    liveCount: live.length,
  });
}
