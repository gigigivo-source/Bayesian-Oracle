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

/** UTC day key ("YYYYMMDD") for a fixture's ISO kickoff time. */
function dayKey(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : fmt(new Date(t));
}

interface LeagueBlock {
  slug:     string;
  label:    string;
  fixtures: FixtureLite[];
  upcoming: FixtureLite[];
  results:  FixtureLite[];
}

interface TopPayload {
  featured:  LeagueBlock[];
  extra:     LeagueBlock[];
  live:      FixtureLite[];
  liveCount: number;
}

// ─── Snapshot cache ───────────────────────────────────────────────────────────
// The home feed fans out to ~70 upstream league scoreboards. Rebuilding that on
// every request (the page loads it on mount and the Live tab polls it) is what
// made the app feel frozen. We keep one shared snapshot per server instance:
//   • fresh  (< FRESH_MS)  → served immediately
//   • stale  (< MAX_AGE)   → served immediately, refreshed in the background
//   • absent               → built once; concurrent callers await the same build
const FRESH_MS   = Number(process.env.TOP_FEED_FRESH_MS ?? 30_000);
const MAX_AGE_MS = Number(process.env.TOP_FEED_MAX_AGE_MS ?? 5 * 60_000);

interface Snapshot { at: number; payload: TopPayload }

const globalForTop = globalThis as typeof globalThis & {
  __gigiTopSnapshot?: Snapshot | null;
  __gigiTopInFlight?: Promise<TopPayload> | null;
};

function getSnapshot(): Promise<TopPayload> {
  const snap = globalForTop.__gigiTopSnapshot ?? null;
  const age  = snap ? Date.now() - snap.at : Infinity;

  if (snap && age < FRESH_MS) return Promise.resolve(snap.payload);

  // Single-flight: only one rebuild runs at a time, however many requests land.
  if (!globalForTop.__gigiTopInFlight) {
    globalForTop.__gigiTopInFlight = buildTopFeed()
      .then((payload) => {
        globalForTop.__gigiTopSnapshot = { at: Date.now(), payload };
        return payload;
      })
      .catch((err) => {
        // Keep serving the last good snapshot if a rebuild fails.
        if (snap) return snap.payload;
        throw err;
      })
      .finally(() => { globalForTop.__gigiTopInFlight = null; });
  }

  // Stale-while-revalidate: return the old payload now, let the rebuild finish.
  if (snap && age < MAX_AGE_MS) {
    void globalForTop.__gigiTopInFlight;
    return Promise.resolve(snap.payload);
  }

  return globalForTop.__gigiTopInFlight;
}

// ─── Feed builder ─────────────────────────────────────────────────────────────

async function buildTopFeed(): Promise<TopPayload> {
  const now = new Date();

  // TOP FEED: professional sportsbook window = yesterday, today, tomorrow only.
  // Do NOT show matches 7, 14, or 60 days away on the home feed.
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const tomorrow  = new Date(now); tomorrow.setDate(now.getDate() + 1);

  // Recent results: last 7 days (for the results section below each league)
  const from7 = new Date(now); from7.setDate(now.getDate() - 7);

  const yKey = fmt(yesterday);
  const tKey = fmt(tomorrow);
  const nKey = fmt(now);
  const rKey = fmt(from7);

  // One upstream call per featured league covering BOTH windows (-7d → +1d).
  // Previously this issued two overlapping requests per league; the union range
  // returns a superset, so today's window and the 7-day results window are just
  // filtered out of the same response. Halves featured-league traffic.
  const fullRange   = `${rKey}-${tKey}`;
  const todayWindow = `${yKey}-${tKey}`;

  const inWindow = (f: FixtureLite, from: string, to: string) => {
    const k = dayKey(f.date);
    return k !== "" && k >= from && k <= to;
  };

  const featuredSettled = await Promise.allSettled(
    FEATURED.map(async (l): Promise<LeagueBlock> => {
      const all = await fetchScoreboard(l.slug, fullRange).catch(() => [] as FixtureLite[]);

      const todayFx  = all.filter((f) => inWindow(f, yKey, tKey));
      const recentFx = all.filter((f) => inWindow(f, rKey, nKey));

      const upcoming = todayFx
        .filter((f) => f.state === "pre" || f.state === "in")
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      const finished = recentFx
        .filter((f) => f.state === "post")
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 8);

      // Dedup (fetchScoreboard already dedupes, kept for shape parity)
      const seen = new Set<string>();
      const fixtures: FixtureLite[] = [];
      for (const fx of [...todayFx, ...recentFx]) {
        if (!seen.has(fx.id)) { seen.add(fx.id); fixtures.push(fx); }
      }

      return { slug: l.slug, label: l.label, fixtures, upcoming, results: finished };
    }),
  );

  const results: LeagueBlock[] = featuredSettled
    .filter((r): r is PromiseFulfilledResult<LeagueBlock> => r.status === "fulfilled")
    .map((r) => r.value);

  // Extra leagues — today window only. Fired in one parallel wave; the shared
  // HTTP client's concurrency limiter throttles them, so the previous manual
  // sequential batching only added dead time between batches.
  const extraSettled = await Promise.allSettled(
    EXTRA.map(async (l): Promise<LeagueBlock> => {
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

  const extraResults: LeagueBlock[] = extraSettled
    .filter((r): r is PromiseFulfilledResult<LeagueBlock> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((r) => r.fixtures.length > 0);

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
  const activityScore = (r: LeagueBlock) => r.upcoming.length * 2 + r.results.length;
  const byLeaguePriority = (a: LeagueBlock, b: LeagueBlock) =>
    leagueTier({ leagueSlug: a.slug }) - leagueTier({ leagueSlug: b.slug }) ||
    activityScore(b) - activityScore(a);

  return {
    featured:  [...results].sort(byLeaguePriority),
    extra:     [...extraResults].sort(byLeaguePriority),
    live,
    liveCount: live.length,
  };
}

export async function GET() {
  const payload = await getSnapshot();
  return Response.json(payload, {
    headers: {
      // Let any CDN/proxy in front of the app absorb the polling traffic too.
      "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=300",
    },
  });
}
