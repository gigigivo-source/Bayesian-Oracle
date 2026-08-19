import { fetchScoreboard, fetchSummary } from "@/lib/espn";
import { runEngineFromRealWithProfiles } from "@/lib/engine";
import { findValueBets, type BookmakerOdds } from "@/lib/engine/value";
import { TOP_FEED_SLUGS } from "@/lib/leagues";
import { db } from "@/db";
import { dailyPicks } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  // Fetch upcoming fixtures — use a 14-day window to catch leagues with sparse schedules
  const now  = new Date();
  const to14 = new Date(now); to14.setDate(now.getDate() + 14);
  const fmt  = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const upcomingRange = `${fmt(now)}-${fmt(to14)}`;

  // Also include always-active leagues (South America, Asia, Middle East)
  const activeSlugs = [
    "bra.1","arg.1","mex.1","usa.1","ksa.1","jpn.1","kor.1","col.1","chi.1",
    "conmebol.libertadores","conmebol.sudamericana","uae.1","qat.1","tur.1",
    "nor.1","swe.1","den.1","bel.1","sco.1","pol.1",
    ...TOP_FEED_SLUGS.slice(0, 12),
  ];
  const uniqueSlugs = [...new Set(activeSlugs)].slice(0, 20);

  const results = await Promise.all(
    uniqueSlugs.map((s) => fetchScoreboard(s, upcomingRange).catch(() => []))
  );
  // Also check 3-day default window
  const current = await Promise.all(
    uniqueSlugs.slice(0, 12).map((s) => fetchScoreboard(s).catch(() => []))
  );

  const seen = new Set<string>();
  const upcoming = [...results.flat(), ...current.flat()]
    .filter((f) => {
      if (f.state !== "pre") return false;
      if (seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, 20);

  const picks: Array<{
    match: string;
    league: string;
    date: string;
    homeLogo: string | null;
    awayLogo: string | null;
    top3: Array<{ name: string; selection: string; hitRate: number; reason: string }>;
    valueBets: Array<{ name: string; selection: string; edge: number; odds: number; kelly: number }>;
  }> = [];

  for (const fx of upcoming.slice(0, 10)) {
    try {
      const sum  = await fetchSummary(fx.leagueSlug, fx.id);
      const pred = await runEngineFromRealWithProfiles(fx, sum);

      const odds: BookmakerOdds | null = sum?.odds
        ? {
            provider: sum.odds.provider ?? "DK",
            homeML:    sum.odds.homeML    ?? undefined,
            drawML:    sum.odds.drawML    ?? undefined,
            awayML:    sum.odds.awayML    ?? undefined,
            overUnder: sum.odds.overUnder ?? undefined,
          }
        : null;

      const vb = findValueBets(pred.markets, odds, fx.home.name, fx.away.name);

      const top3 = pred.top10.slice(0, 3).map((m) => ({
        name:      m.name,
        selection: m.selection,
        hitRate:   m.hitRate,
        reason:    m.reason ?? "",
      }));

      picks.push({
        match:  `${fx.home.name} vs ${fx.away.name}`,
        league: fx.leagueName,
        date:   fx.date.slice(0, 10),
        homeLogo: fx.home.logo,
        awayLogo: fx.away.logo,
        top3,
        valueBets: vb
          .filter((v) => v.valueEdge > 0)
          .slice(0, 2)
          .map((v) => ({
            name:      v.market.name,
            selection: v.market.selection,
            edge:      v.valueEdge,
            odds:      v.bookDecimalOdds,
            kelly:     v.kellyStake,
          })),
      });

      // AUTO-TRACK: record this match's top-3 picks once per day so their real
      // outcomes can be settled and surfaced in the Performance dashboard.
      // Idempotent by (pickDate, eventId) — safe to call on every page load.
      try {
        const pickDate = new Date().toISOString().slice(0, 10);
        const existing = await db
          .select({ id: dailyPicks.id })
          .from(dailyPicks)
          .where(and(eq(dailyPicks.pickDate, pickDate), eq(dailyPicks.eventId, fx.id)))
          .limit(1);

        if (!existing[0]) {
          await db.insert(dailyPicks).values({
            pickDate,
            match:      `${fx.home.name} vs ${fx.away.name}`,
            league:     fx.leagueName,
            leagueSlug: fx.leagueSlug,
            eventId:    fx.id,
            picks:      top3.map((p) => ({ ...p, outcome: "PENDING" })),
            hits:    0,
            misses:  0,
            pending: top3.length,
            status:  "pending",
          });
        }
      } catch {
        // tracking is best-effort — never fail the main response
      }
    } catch {
      // skip any fixture that errors — keep processing the rest
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  return Response.json({ date: today, totalMatches: picks.length, picks });
}
