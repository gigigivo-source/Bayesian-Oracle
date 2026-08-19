import { fetchScoreboard, fetchSummary, type FixtureLite } from "@/lib/espn";
import { runEngineFromReal, evaluateFinishedMatch } from "@/lib/engine";
import { LEAGUE_MAP } from "@/lib/leagues";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// ── Competition set grouped by category ──────────────────────────────────────
type Category = "League" | "Domestic Cup" | "Continental" | "International";

const COMPETITIONS: Array<{ slug: string; category: Category }> = [
  // Top domestic leagues
  { slug: "eng.1",  category: "League" },
  { slug: "esp.1",  category: "League" },
  { slug: "ita.1",  category: "League" },
  { slug: "ger.1",  category: "League" },
  { slug: "fra.1",  category: "League" },
  { slug: "ned.1",  category: "League" },
  { slug: "por.1",  category: "League" },
  { slug: "usa.1",  category: "League" },
  { slug: "mex.1",  category: "League" },
  { slug: "bra.1",  category: "League" },
  { slug: "arg.1",  category: "League" },
  { slug: "eng.2",  category: "League" },
  { slug: "tur.1",  category: "League" },
  { slug: "bel.1",  category: "League" },
  { slug: "sco.1",  category: "League" },
  // Domestic cups
  { slug: "eng.fa",               category: "Domestic Cup" },
  { slug: "eng.league_cup",       category: "Domestic Cup" },
  { slug: "esp.copa_del_rey",     category: "Domestic Cup" },
  { slug: "ita.coppa_italia",     category: "Domestic Cup" },
  { slug: "ger.dfb_pokal",        category: "Domestic Cup" },
  { slug: "fra.coupe_de_france",  category: "Domestic Cup" },
  // Continental club competitions
  { slug: "uefa.champions",        category: "Continental" },
  { slug: "uefa.europa",           category: "Continental" },
  { slug: "uefa.europa.conf",      category: "Continental" },
  { slug: "conmebol.libertadores", category: "Continental" },
  { slug: "conmebol.sudamericana", category: "Continental" },
  { slug: "concacaf.champions",    category: "Continental" },
  { slug: "afc.champions",         category: "Continental" },
  // International (national teams)
  { slug: "fifa.world",       category: "International" },
  { slug: "uefa.euro",        category: "International" },
  { slug: "uefa.nations",     category: "International" },
  { slug: "conmebol.america", category: "International" },
  { slug: "caf.nations",      category: "International" },
  { slug: "fifa.friendly",    category: "International" },
];

async function fetchBoxscore(
  slug: string,
  eventId: string,
): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`${ESPN_BASE}/${slug}/summary?event=${eventId}`, {
      next: { revalidate: 86400 },
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      boxscore?: { teams?: Array<{ statistics?: Array<{ name: string; displayValue: string }> }> };
    };
    const teams = data.boxscore?.teams;
    if (!teams || teams.length < 2) return null;

    const parse = (stats: Array<{ name: string; displayValue: string }>) => {
      const m: Record<string, number> = {};
      for (const s of stats) m[s.name] = parseFloat(s.displayValue) || 0;
      return m;
    };
    const h = parse(teams[0]?.statistics ?? []);
    const a = parse(teams[1]?.statistics ?? []);

    return {
      homeShots:         h.totalShots        ?? 0, awayShots:         a.totalShots        ?? 0,
      homeSot:           h.shotsOnTarget      ?? 0, awaySot:           a.shotsOnTarget      ?? 0,
      homeCorners:       h.wonCorners         ?? 0, awayCorners:       a.wonCorners         ?? 0,
      homeCards:         h.yellowCards        ?? 0, awayCards:         a.yellowCards        ?? 0,
      homeOffsides:      h.offsides           ?? 0, awayOffsides:      a.offsides           ?? 0,
      homeSaves:         h.saves              ?? 0, awaySaves:         a.saves              ?? 0,
      homeInterceptions: h.interceptions      ?? 0, awayInterceptions: a.interceptions      ?? 0,
      homeFouls:         h.foulsCommitted     ?? 0, awayFouls:         a.foulsCommitted     ?? 0,
    };
  } catch {
    return null;
  }
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

interface CompResult {
  slug: string;
  name: string;
  category: Category;
  matches: number;
  hits: number;
  misses: number;
  pending: number;
  perfect: number;   // 10/10 matches
  nineOrTen: number; // ≥9 hits
  accuracy: number;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const months         = Math.min(parseInt(searchParams.get("months")   ?? "3"), 12);
  const perComp        = Math.min(parseInt(searchParams.get("perComp")  ?? "6"),  12);
  const categoryFilter = searchParams.get("category"); // optional filter

  const now  = new Date();
  const from = new Date(now);
  from.setMonth(from.getMonth() - months);
  const dateRange = `${fmt(from)}-${fmt(now)}`;

  const comps = categoryFilter
    ? COMPETITIONS.filter((c) => c.category === categoryFilter)
    : COMPETITIONS;

  const perComp_results: CompResult[] = [];

  // Family-level diagnostics (all evaluated markets)
  const familyStats: Record<string, { hits: number; misses: number }> = {};
  // Top-10-only diagnostics (which families break slips)
  const top10Family: Record<string, { hits: number; misses: number }> = {};
  // Over/Under/Other direction stats
  const dirStats: Record<string, { hits: number; misses: number }> = {
    Over:  { hits: 0, misses: 0 },
    Under: { hits: 0, misses: 0 },
    Other: { hits: 0, misses: 0 },
  };
  // Tier perfect-rate counters
  const tier = { t1H: 0, t1N: 0, t3P: 0, t3N: 0, t5P: 0, t5N: 0 };

  // Process competitions in batches of 4 (rate-limit friendly)
  const CONCURRENCY = 4;
  for (let i = 0; i < comps.length; i += CONCURRENCY) {
    const batch = comps.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async ({ slug, category }) => {
        const name = LEAGUE_MAP[slug]?.name ?? slug;
        try {
          const fixtures = await fetchScoreboard(slug, dateRange);
          const finished = (fixtures as FixtureLite[])
            .filter((f) => f.state === "post" && f.home.score !== null)
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
            .slice(0, perComp);

          let hits = 0, misses = 0, pending = 0,
              perfect = 0, nineOrTen = 0, processed = 0;

          for (const fx of finished) {
            try {
              const summary    = await fetchSummary(slug, fx.id);
              const prediction = runEngineFromReal(fx, summary);
              const box        = await fetchBoxscore(slug, fx.id);
              evaluateFinishedMatch(fx, prediction, box);

              const h = prediction.hitCount ?? 0;
              const m = prediction.top10.filter((p) => p.outcome === "MISS").length;
              const p = prediction.top10.filter(
                (p) => p.outcome === "PENDING" || !p.outcome,
              ).length;

              hits += h; misses += m; pending += p; processed++;
              if (m === 0 && h > 0) perfect++;
              if (h >= 9) nineOrTen++;

              // Tier clean-sweep tracking
              const outc = (arr: typeof prediction.top10) => {
                const ev = arr.filter(
                  (x) => x.outcome === "HIT" || x.outcome === "MISS",
                );
                return ev.length > 0 && ev.every((x) => x.outcome === "HIT");
              };
              const t1 = prediction.top10.slice(0, 1);
              const t3 = prediction.top10.slice(0, 3);
              const t5 = prediction.top10.slice(0, 5);
              if (t1.some((x) => x.outcome === "HIT" || x.outcome === "MISS")) {
                tier.t1N++; if (outc(t1)) tier.t1H++;
              }
              if (t3.some((x) => x.outcome === "HIT" || x.outcome === "MISS")) {
                tier.t3N++; if (outc(t3)) tier.t3P++;
              }
              if (t5.some((x) => x.outcome === "HIT" || x.outcome === "MISS")) {
                tier.t5N++; if (outc(t5)) tier.t5P++;
              }

              // Per-family accuracy across ALL evaluated markets
              for (const mk of prediction.markets) {
                if (mk.outcome !== "HIT" && mk.outcome !== "MISS") continue;
                const fs = (familyStats[mk.family] ??= { hits: 0, misses: 0 });
                if (mk.outcome === "HIT") fs.hits++; else fs.misses++;
              }

              // Top-10-only family / direction diagnostics
              for (const mk of prediction.top10) {
                if (mk.outcome !== "HIT" && mk.outcome !== "MISS") continue;
                const t = (top10Family[mk.family] ??= { hits: 0, misses: 0 });
                if (mk.outcome === "HIT") t.hits++; else t.misses++;
                const dir = mk.selection.startsWith("Over")
                  ? "Over"
                  : mk.selection.startsWith("Under")
                  ? "Under"
                  : "Other";
                if (mk.outcome === "HIT") dirStats[dir].hits++;
                else dirStats[dir].misses++;
              }
            } catch {
              /* skip individual match */
            }
          }

          const verified = hits + misses;
          return {
            slug, name, category,
            matches: processed, hits, misses, pending, perfect, nineOrTen,
            accuracy: verified > 0 ? hits / verified : 0,
          } satisfies CompResult;
        } catch {
          return {
            slug, name, category,
            matches: 0, hits: 0, misses: 0, pending: 0, perfect: 0, nineOrTen: 0,
            accuracy: 0,
          } satisfies CompResult;
        }
      }),
    );
    perComp_results.push(...batchResults);
  }

  const withMatches = perComp_results.filter((r) => r.matches > 0);

  // ── Category rollups ────────────────────────────────────────────────────────
  const categories: Category[] = ["League", "Domestic Cup", "Continental", "International"];
  const byCategory = categories
    .map((cat) => {
      const rows     = withMatches.filter((r) => r.category === cat);
      const hits     = rows.reduce((s, r) => s + r.hits, 0);
      const misses   = rows.reduce((s, r) => s + r.misses, 0);
      const matches  = rows.reduce((s, r) => s + r.matches, 0);
      const perfect  = rows.reduce((s, r) => s + r.perfect, 0);
      const nineOrTen = rows.reduce((s, r) => s + r.nineOrTen, 0);
      const verified = hits + misses;
      return {
        category: cat,
        competitions: rows.length,
        matches, hits, misses, perfect, nineOrTen,
        accuracy:     verified > 0 ? hits / verified : 0,
        perfectRate:  matches  > 0 ? perfect / matches : 0,
      };
    })
    .filter((c) => c.matches > 0);

  // ── Overall totals ──────────────────────────────────────────────────────────
  const totalHits      = withMatches.reduce((s, r) => s + r.hits, 0);
  const totalMisses    = withMatches.reduce((s, r) => s + r.misses, 0);
  const totalMatches   = withMatches.reduce((s, r) => s + r.matches, 0);
  const totalPerfect   = withMatches.reduce((s, r) => s + r.perfect, 0);
  const totalNineOrTen = withMatches.reduce((s, r) => s + r.nineOrTen, 0);
  const totalVerified  = totalHits + totalMisses;

  return Response.json({
    months,
    competitionsScanned:   comps.length,
    competitionsWithData:  withMatches.length,
    overall: {
      matches:         totalMatches,
      hits:            totalHits,
      misses:          totalMisses,
      accuracy:        totalVerified  > 0 ? totalHits    / totalVerified  : 0,
      perfectMatches:  totalPerfect,
      perfectRate:     totalMatches   > 0 ? totalPerfect / totalMatches   : 0,
      nineOrTenMatches: totalNineOrTen,
      nineOrTenRate:   totalMatches   > 0 ? totalNineOrTen / totalMatches : 0,
    },
    byCategory,
    byCompetition: withMatches.sort((a, b) => b.accuracy - a.accuracy),
    byFamily: Object.entries(familyStats)
      .map(([family, s]) => ({
        family,
        picks:    s.hits + s.misses,
        hits:     s.hits,
        misses:   s.misses,
        accuracy: s.hits + s.misses > 0 ? s.hits / (s.hits + s.misses) : 0,
      }))
      .sort((a, b) => a.accuracy - b.accuracy), // worst performers first
    top10ByFamily: Object.entries(top10Family)
      .map(([family, s]) => ({
        family,
        picks:    s.hits + s.misses,
        misses:   s.misses,
        accuracy: s.hits + s.misses > 0 ? s.hits / (s.hits + s.misses) : 0,
      }))
      .sort((a, b) => b.misses - a.misses), // highest-miss families first
    byDirection: Object.entries(dirStats)
      .map(([dir, s]) => ({
        dir,
        picks:    s.hits + s.misses,
        misses:   s.misses,
        accuracy: s.hits + s.misses > 0 ? s.hits / (s.hits + s.misses) : 0,
      }))
      .filter((x) => x.picks > 0),
    tierPerfectRate: {
      top1:  tier.t1N > 0 ? tier.t1H / tier.t1N : 0,
      top3:  tier.t3N > 0 ? tier.t3P / tier.t3N : 0,
      top5:  tier.t5N > 0 ? tier.t5P / tier.t5N : 0,
      top10: totalMatches > 0 ? totalPerfect / totalMatches : 0,
    },
  });
}
