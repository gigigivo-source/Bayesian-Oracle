import { fetchScoreboard, fetchSummary, type FixtureLite } from "@/lib/espn";
import { runEngineFromRealWithProfiles } from "@/lib/engine";
import { findValueBets, type BookmakerOdds } from "@/lib/engine/value";
import { ALL_RANKING_MODES, type RankingMode } from "@/lib/engine/selector";
import { db } from "@/db";
import { savedSlips } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ELITE_SLUGS = new Set([
  "eng.1", "esp.1", "ita.1", "fra.1", "ger.1",
  "fifa.world", "uefa.champions", "uefa.europa", "uefa.euro", "conmebol.america",
]);

const ALL_SLUGS = [
  "eng.1", "esp.1", "ita.1", "fra.1", "ger.1",
  "fifa.world", "uefa.champions", "uefa.europa",
  "conmebol.libertadores", "ned.1", "por.1", "usa.1", "bra.1", "mex.1", "arg.1",
  "bel.1", "sco.1", "tur.1", "nor.1", "swe.1",
];

const STANDARD_MARKETS = new Set([
  "Total Goals O/U 0.5", "Total Goals O/U 1.5", "Total Goals O/U 2.5", "Total Goals O/U 3.5", "Total Goals O/U 4.5",
  "Both Teams To Score", "Double Chance 1X", "Double Chance 12", "Double Chance X2",
  "Total Cards O/U 1.5", "Total Cards O/U 2.5", "Total Cards O/U 3.5",
  "Total Corners O/U 7.5", "Total Corners O/U 8.5", "Total Corners O/U 9.5", "Total Corners O/U 10.5", "Total Corners O/U 11.5",
]);

function isStandardMarket(name: string): boolean {
  if (STANDARD_MARKETS.has(name)) return true;
  if (name.includes("Goals O/U 0.5") || name.includes("Goals O/U 1.5") || name.includes("Goals O/U 2.5")) return true;
  if (name.includes("Cards O/U 0.5") || name.includes("Cards O/U 1.5")) return true;
  if (name.includes("Corners O/U 3.5") || name.includes("Corners O/U 4.5")) return true;
  if (name.startsWith("Match Result")) return true;
  if (name.includes("Clean Sheet")) return true;
  return false;
}

interface AccaPick {
  matchLabel: string; league: string; leagueSlug: string; date: string;
  homeTeam: string; awayTeam: string; homeLogo: string | null; awayLogo: string | null;
  marketName: string; selection: string; hitRate: number; fairOdds: number;
  reason: string; family: string; fixtureId: string; isElite: boolean;
  valueEdge: number; bookOdds: number;
  rankingMode: RankingMode;
}

interface Accumulator {
  name: string; picks: AccaPick[]; combinedProbability: number;
  combinedOdds: number; legs: number; risk: "LOW" | "MEDIUM" | "HIGH";
  type: "highhit" | "value";
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const save = searchParams.get("save") === "true";

  // Ranking mode: ?ranking=A|B|C|D — the engine run AND the persisted slips
  // are stamped with this mode (defaults to B, the historical default).
  const qMode = searchParams.get("ranking")?.toUpperCase() ?? "";
  const rankingMode: RankingMode = (ALL_RANKING_MODES as string[]).includes(qMode)
    ? (qMode as RankingMode)
    : "B";

  // Fetch from leagues in parallel, cap at 15 for speed
  const results = await Promise.all(
    ALL_SLUGS.slice(0, 15).map((s) => fetchScoreboard(s).catch(() => [] as FixtureLite[]))
  );
  const upcoming = results
    .flat()
    .filter((f) => f.state === "pre")
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, 30);

  if (upcoming.length < 2) {
    return Response.json({ accumulators: [], message: "Not enough upcoming matches" });
  }

  const matchPicks: Array<{ fixture: FixtureLite; picks: AccaPick[] }> = [];

  for (const fx of upcoming.slice(0, 12)) {
    try {
      const summary = await fetchSummary(fx.leagueSlug, fx.id);
      const prediction = await runEngineFromRealWithProfiles(fx, summary, null, rankingMode);
      const isElite = ELITE_SLUGS.has(fx.leagueSlug);

      const odds: BookmakerOdds | null = summary?.odds
        ? {
            provider: summary.odds.provider ?? "DK",
            homeML: summary.odds.homeML ?? undefined,
            drawML: summary.odds.drawML ?? undefined,
            awayML: summary.odds.awayML ?? undefined,
            overUnder: summary.odds.overUnder ?? undefined,
          }
        : null;

      const vb = findValueBets(prediction.markets, odds, fx.home.name, fx.away.name);
      const valueMap = new Map(vb.map((v) => [v.market.name + v.market.selection, v]));

      const eligible = prediction.markets
        .filter((m) => !m.rejected && m.hitRate >= 0.75 && (isElite || isStandardMarket(m.name)))
        .sort((a, b) => b.hitRate - a.hitRate)
        .slice(0, 3)
        .map((m) => {
          const val = valueMap.get(m.name + m.selection);
          return {
            matchLabel: `${fx.home.name} vs ${fx.away.name}`,
            league: fx.leagueName,
            leagueSlug: fx.leagueSlug,
            date: fx.date.slice(0, 10),
            homeTeam: fx.home.name,
            awayTeam: fx.away.name,
            homeLogo: fx.home.logo,
            awayLogo: fx.away.logo,
            marketName: m.name,
            selection: m.selection,
            hitRate: m.hitRate,
            fairOdds: m.fairOddsWorst,
            reason: m.reason ?? "",
            family: m.family,
            fixtureId: fx.id,
            isElite,
            valueEdge: val?.valueEdge ?? 0,
            bookOdds: val?.bookDecimalOdds ?? m.fairOddsWorst,
            rankingMode,
          } satisfies AccaPick;
        });

      if (eligible.length > 0) matchPicks.push({ fixture: fx, picks: eligible });
    } catch {
      /* skip fixture on error */
    }
  }

  if (matchPicks.length < 2) {
    return Response.json({ accumulators: [], totalMatchesAnalysed: matchPicks.length });
  }

  const accumulators: Accumulator[] = [];

  // ── HIGH HIT accumulators ─────────────────────────────────────────────────
  const hhTiers = [
    ["Safe Double",   2, 0.88],
    ["Safe Treble",   3, 0.85],
    ["Banker 4-Fold", 4, 0.82],
    ["Value 5-Fold",  5, 0.78],
    ["Mega 6-Fold",   6, 0.75],
  ] as const;

  for (const [name, legs, min] of hhTiers) {
    const a = buildAcca(name, matchPicks, legs, min, "highhit");
    if (a && a.picks.length >= 2) accumulators.push(a);
  }

  // ── VALUE accumulators — only picks with positive edge ────────────────────
  const valuePicks = matchPicks
    .map((mp) => ({ ...mp, picks: mp.picks.filter((p) => p.valueEdge > 0) }))
    .filter((mp) => mp.picks.length > 0);

  if (valuePicks.length >= 2) {
    const valTiers = [
      ["Value Double",  2, 0.70],
      ["Value Treble",  3, 0.65],
      ["Value 4-Fold",  4, 0.60],
    ] as const;
    for (const [name, legs, min] of valTiers) {
      const a = buildAcca(name, valuePicks, legs, min, "value");
      if (a && a.picks.length >= 2) accumulators.push(a);
    }
  }

  // ── Cross-league accumulator ──────────────────────────────────────────────
  const cl = buildCrossLeague(matchPicks);
  if (cl) accumulators.push(cl);

  // ── Winning Combo — best single pick from each of several different
  //    matches, ranked by hit rate for maximum combined safety ───────────────
  const combo = buildWinningCombo(matchPicks);
  if (combo) accumulators.push(combo);

  // ── AUTO-TRACK: persist each accumulator once per day ────────────────────
  // Idempotent — slip name is stamped with today's date; skipped if already exists.
  const today = new Date().toISOString().slice(0, 10);
  const alwaysSave = save || true; // always track now (was opt-in via ?save=true)
  if (alwaysSave) {
    for (const a of accumulators) {
      try {
        const stampedName = `${a.name} · ${today}`;
        const existing = await db
          .select({ id: savedSlips.id })
          .from(savedSlips)
          .where(eq(savedSlips.name, stampedName))
          .limit(1);
        if (existing[0]) continue; // already tracked today
        await db.insert(savedSlips).values({
          name: stampedName,
          slipType: a.type,
          picks: a.picks,
          combinedOdds: a.combinedOdds,
          combinedProb: a.combinedProbability,
          stake: 10,
          status: "pending",
          rankingMode,
        });
      } catch {
        /* skip DB write on error */
      }
    }
  }

  return Response.json({
    accumulators,
    totalMatchesAnalysed: matchPicks.length,
    highHitCount: accumulators.filter((a) => a.type === "highhit").length,
    valueCount: accumulators.filter((a) => a.type === "value").length,
  });
}

// ─── Accumulator builders ─────────────────────────────────────────────────────

function buildAcca(
  name: string,
  matchPicks: Array<{ fixture: FixtureLite; picks: AccaPick[] }>,
  legs: number,
  minHitRate: number,
  type: "highhit" | "value",
): Accumulator | null {
  const candidates: AccaPick[] = [];
  // At most 1 leg per eventId per market family (goals, corners, cards)
  const used = new Set<string>(); // key = fixtureId|family
  const all = matchPicks
    .flatMap((mp) => mp.picks)
    .filter((p) => p.hitRate >= minHitRate)
    .sort((a, b) =>
      type === "value" ? b.valueEdge - a.valueEdge : b.hitRate - a.hitRate
    );
  for (const p of all) {
    if (candidates.length >= legs) break;
    const key = `${p.fixtureId}|${p.family}`;
    if (used.has(key)) continue;
    candidates.push(p);
    used.add(key);
  }
  if (candidates.length < Math.min(legs, 2)) return null;
  const prob = candidates.reduce((p, c) => p * c.hitRate, 1);
  const odds = candidates.reduce((o, c) => o * c.bookOdds, 1);
  return {
    name,
    picks: candidates,
    combinedProbability: prob,
    combinedOdds: Math.round(odds * 100) / 100,
    legs: candidates.length,
    risk: prob > 0.65 ? "LOW" : prob > 0.40 ? "MEDIUM" : "HIGH",
    type,
  };
}

function buildWinningCombo(
  matchPicks: Array<{ fixture: FixtureLite; picks: AccaPick[] }>,
): Accumulator | null {
  // Take ONLY the single strongest pick from each different match, then combine
  // the safest 3–5 into one slip. One leg per fixture guarantees independence.
  const bestPerMatch: AccaPick[] = [];
  for (const mp of matchPicks) {
    const best = [...mp.picks].sort((a, b) => b.hitRate - a.hitRate)[0];
    if (best && best.hitRate >= 0.82) bestPerMatch.push(best);
  }
  bestPerMatch.sort((a, b) => b.hitRate - a.hitRate);
  const legs = bestPerMatch.slice(0, 5);
  if (legs.length < 3) return null;

  const prob = legs.reduce((p, c) => p * c.hitRate, 1);
  const odds = legs.reduce((o, c) => o * c.bookOdds, 1);
  return {
    name: `Winning Combo (${legs.length} Matches)`,
    picks: legs,
    combinedProbability: prob,
    combinedOdds: Math.round(odds * 100) / 100,
    legs: legs.length,
    risk: prob > 0.55 ? "LOW" : prob > 0.35 ? "MEDIUM" : "HIGH",
    type: "highhit",
  };
}

function buildCrossLeague(
  matchPicks: Array<{ fixture: FixtureLite; picks: AccaPick[] }>,
): Accumulator | null {
  const byLeague = new Map<string, AccaPick>();
  for (const p of matchPicks
    .flatMap((mp) => mp.picks)
    .filter((p) => p.hitRate >= 0.80)
    .sort((a, b) => b.hitRate - a.hitRate)) {
    if (!byLeague.has(p.leagueSlug)) byLeague.set(p.leagueSlug, p);
  }
  const c = [...byLeague.values()].slice(0, 5);
  if (c.length < 2) return null;
  const prob = c.reduce((p, pk) => p * pk.hitRate, 1);
  const odds = c.reduce((o, pk) => o * pk.bookOdds, 1);
  return {
    name: `Cross-League ${c.length}-Fold`,
    picks: c,
    combinedProbability: prob,
    combinedOdds: Math.round(odds * 100) / 100,
    legs: c.length,
    risk: prob > 0.55 ? "LOW" : "MEDIUM",
    type: "highhit",
  };
}
