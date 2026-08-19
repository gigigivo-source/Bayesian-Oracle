import { db } from "@/db";
import { performanceLog, savedSlips, dailyPicks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { fetchScoreboard, fetchSummary, type FixtureLite } from "@/lib/espn";
import { runEngineFromReal, evaluateFinishedMatch } from "@/lib/engine";
import { TOP_FEED_SLUGS } from "@/lib/leagues";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// ─── ESPN response shape for boxscore ───────────────────────────────────────
interface EspnStatEntry { name: string; displayValue: string }
interface EspnTeamStats { statistics?: EspnStatEntry[] }
interface EspnBoxscoreResponse {
  header?: {
    competitions?: Array<{
      status?: { type?: { state?: string } };
      competitors?: Array<{ homeAway?: string; score?: string | number }>;
    }>;
  };
  boxscore?: { teams?: EspnTeamStats[] };
}

function parseBoxTeams(teams: EspnTeamStats[]): Record<string, number> {
  const parse = (stats: EspnStatEntry[]) => {
    const m: Record<string, number> = {};
    for (const s of stats) m[s.name] = parseFloat(s.displayValue) || 0;
    return m;
  };
  const h = parse(teams[0]?.statistics ?? []);
  const a = parse(teams[1]?.statistics ?? []);
  return {
    homeShots:         h.totalShots      ?? 0, awayShots:         a.totalShots      ?? 0,
    homeSot:           h.shotsOnTarget   ?? 0, awaySot:           a.shotsOnTarget   ?? 0,
    homeCorners:       h.wonCorners      ?? 0, awayCorners:       a.wonCorners      ?? 0,
    homeCards:         h.yellowCards     ?? 0, awayCards:         a.yellowCards     ?? 0,
    homeOffsides:      h.offsides        ?? 0, awayOffsides:      a.offsides        ?? 0,
    homeSaves:         h.saves           ?? 0, awaySaves:         a.saves           ?? 0,
    homeInterceptions: h.interceptions   ?? 0, awayInterceptions: a.interceptions   ?? 0,
    homeFouls:         h.foulsCommitted  ?? 0, awayFouls:         a.foulsCommitted  ?? 0,
    homeRedCards:      h.redCards        ?? 0, awayRedCards:      a.redCards        ?? 0,
  };
}

async function fetchBoxscore(slug: string, eventId: string): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`${ESPN}/${slug}/summary?event=${eventId}`, {
      next: { revalidate: 600 },
    });
    if (!res.ok) return null;
    const data = await res.json() as EspnBoxscoreResponse;
    const teams = data.boxscore?.teams;
    if (!teams || teams.length < 2) return null;
    return parseBoxTeams(teams);
  } catch {
    return null;
  }
}

interface MatchResult {
  finished: boolean;
  homeScore: number;
  awayScore: number;
  box: Record<string, number> | null;
}

/**
 * Fetch a specific match's final result + boxscore by slug + eventId.
 * Works for ANY finished match on any date — not limited to today's scoreboard.
 */
async function fetchMatchById(slug: string, eventId: string): Promise<MatchResult | null> {
  try {
    const res = await fetch(`${ESPN}/${slug}/summary?event=${eventId}`, {
      next: { revalidate: 600 },
    });
    if (!res.ok) return null;
    const data = await res.json() as EspnBoxscoreResponse;

    const comp = data.header?.competitions?.[0];
    const state = comp?.status?.type?.state;
    const competitors = comp?.competitors ?? [];
    const home = competitors.find((c) => c.homeAway === "home");
    const away = competitors.find((c) => c.homeAway === "away");

    if (state !== "post") {
      return { finished: false, homeScore: 0, awayScore: 0, box: null };
    }

    const teams = data.boxscore?.teams;
    const box = teams && teams.length >= 2 ? parseBoxTeams(teams) : null;

    return {
      finished: true,
      homeScore: Number(home?.score) || 0,
      awayScore: Number(away?.score) || 0,
      box,
    };
  } catch {
    return null;
  }
}

/**
 * Scheduled verification job — three tasks:
 *  1) Auto-log post-match Top-10 verification for recently finished matches
 *     (idempotent: skips matches already in performanceLog).
 *  2) Settle pending accumulator slips whose ALL legs have finished.
 *  3) Settle pending dailyPicks against their own finished matches.
 *
 * Trigger via GET/POST from an external cron (e.g. every 30–60 min).
 * Protect with CRON_SECRET env var; if unset the endpoint is open (dev mode).
 */
async function runVerification() {
  let matchesLogged = 0;
  let slipsSettled = 0;
  let dailyPicksSettled = 0;

  // ── Task 1: post-match performance logging ──────────────────────────────────
  const slugs = TOP_FEED_SLUGS.slice(0, 8);
  const boards = await Promise.all(
    slugs.map((s) => fetchScoreboard(s).catch(() => [] as FixtureLite[]))
  );
  const finished = boards
    .flat()
    .filter((f) => f.state === "post" && f.home.score !== null)
    .slice(0, 20);

  for (const fx of finished) {
    try {
      // Idempotency: skip if this match is already logged
      const existing = await db
        .select({ id: performanceLog.id })
        .from(performanceLog)
        .where(eq(performanceLog.eventId, fx.id))
        .limit(1);
      if (existing[0]) continue;

      const summary  = await fetchSummary(fx.leagueSlug, fx.id);
      const prediction = runEngineFromReal(fx, summary);
      const boxscore = await fetchBoxscore(fx.leagueSlug, fx.id);
      evaluateFinishedMatch(fx, prediction, boxscore);

      const hits    = prediction.hitCount ?? 0;
      const misses  = prediction.top10.filter((m) => m.outcome === "MISS").length;
      const pending = prediction.top10.filter((m) => m.outcome === "PENDING" || !m.outcome).length;
      const evalC   = prediction.evaluatedCount ?? 0;

      await db.insert(performanceLog).values({
        eventId:    fx.id,
        matchLabel: `${fx.home.name} vs ${fx.away.name}`,
        homeTeam:   fx.home.name,
        awayTeam:   fx.away.name,
        league:     fx.leagueName,
        leagueSlug: fx.leagueSlug,
        matchDate:  fx.date.slice(0, 10),
        homeScore:  Number(fx.home.score) || 0,
        awayScore:  Number(fx.away.score) || 0,
        totalPicks: prediction.top10.length,
        hits,
        misses,
        pending,
        accuracy: evalC > 0 ? hits / evalC : 0,
        top10Detail: prediction.top10.map((m) => ({
          name:      m.name,
          selection: m.selection,
          hitRate:   m.hitRate,
          outcome:   m.outcome,
          family:    m.family,
        })),
      });
      matchesLogged++;
    } catch {
      // skip individual failed match — keep the job running
    }
  }

  // ── Task 2: settle pending accumulator slips ────────────────────────────────
  const matchCache = new Map<string, MatchResult | null>();
  const getMatch = async (slug: string, id: string) => {
    const key = `${slug}|${id}`;
    if (!matchCache.has(key)) matchCache.set(key, await fetchMatchById(slug, id));
    return matchCache.get(key) ?? null;
  };

  try {
    const pendingSlips = await db
      .select()
      .from(savedSlips)
      .where(eq(savedSlips.status, "pending"))
      .limit(40);

    for (const slip of pendingSlips) {
      type PickShape = {
        fixtureId?: string;
        leagueSlug?: string;
        matchLabel?: string;
        marketName?: string;
        selection?: string;
      };
      const picks = slip.picks as PickShape[];
      let allSettled = true;
      let allHit     = true;

      for (const pick of picks) {
        if (!pick?.fixtureId || !pick?.leagueSlug) { allSettled = false; continue; }
        const mr = await getMatch(pick.leagueSlug, pick.fixtureId);
        if (!mr || !mr.finished) { allSettled = false; continue; }

        const fx = {
          home: { name: pick.matchLabel?.split(" vs ")[0] ?? "", score: String(mr.homeScore) },
          away: { name: pick.matchLabel?.split(" vs ")[1] ?? "", score: String(mr.awayScore) },
        } as unknown as FixtureLite;

        const outcome = settlePick(
          pick.marketName ?? "",
          pick.selection  ?? "",
          fx,
          mr.box,
          mr.homeScore + mr.awayScore,
        );
        if (outcome === "PENDING") { allSettled = false; continue; }
        if (outcome === "MISS") allHit = false;
      }

      if (allSettled) {
        await db
          .update(savedSlips)
          .set({ status: allHit ? "won" : "lost" })
          .where(eq(savedSlips.id, slip.id));
        slipsSettled++;
      }
    }
  } catch {
    // slip settlement is best-effort; don't abort the whole job
  }

  // ── Task 3: settle pending daily picks ─────────────────────────────────────
  try {
    const pendingDaily = await db
      .select()
      .from(dailyPicks)
      .where(eq(dailyPicks.status, "pending"))
      .limit(50);

    for (const dp of pendingDaily) {
      if (!dp.eventId || !dp.leagueSlug) continue;

      const mr = await fetchMatchById(dp.leagueSlug, dp.eventId);
      if (!mr || !mr.finished) continue;

      const { homeScore: hScore, awayScore: aScore, box } = mr;
      const total = hScore + aScore;
      const fx = {
        home: { name: dp.match.split(" vs ")[0] ?? "", score: String(hScore) },
        away: { name: dp.match.split(" vs ")[1] ?? "", score: String(aScore) },
      } as unknown as FixtureLite;

      type DailyPickEntry = { name: string; selection: string; hitRate: number; outcome: string };
      const picks = dp.picks as DailyPickEntry[];
      let hits = 0, misses = 0, pending = 0;

      for (const p of picks) {
        const o = settlePick(p.name, p.selection, fx, box, total);
        p.outcome = o;
        if (o === "HIT") hits++;
        else if (o === "MISS") misses++;
        else pending++;
      }

      await db
        .update(dailyPicks)
        .set({
          picks,
          hits,
          misses,
          pending,
          status: pending === 0 ? "settled" : "pending",
        })
        .where(eq(dailyPicks.id, dp.id));

      if (pending === 0) dailyPicksSettled++;
    }
  } catch {
    // best-effort
  }

  return {
    matchesLogged,
    slipsSettled,
    dailyPicksSettled,
    finishedScanned: finished.length,
  };
}

// ─── Single-pick settlement logic ────────────────────────────────────────────
function settlePick(
  name: string,
  selection: string,
  fx: FixtureLite,
  box: Record<string, number> | null,
  total: number,
): "HIT" | "MISS" | "PENDING" {
  const hn     = fx.home.name;
  const an     = fx.away.name;
  const hScore = Number(fx.home.score) || 0;
  const aScore = Number(fx.away.score) || 0;

  const lineM  = name.match(/O\/U\s+([\d.]+)/);
  const line   = lineM ? Number(lineM[1]) : NaN;
  const isOver = selection.startsWith("Over");
  const ou = (v: number): "HIT" | "MISS" =>
    (isOver ? v > line : v < line) ? "HIT" : "MISS";

  // Goals (score-only — no boxscore needed)
  if (name.includes("Total Goals"))  return isNaN(line) ? "PENDING" : ou(total);
  if (name.includes(`${hn} Goals`)) return isNaN(line) ? "PENDING" : ou(hScore);
  if (name.includes(`${an} Goals`)) return isNaN(line) ? "PENDING" : ou(aScore);

  // Match result
  if (name.startsWith("Match Result")) {
    const r = hScore > aScore ? "Home Win" : hScore === aScore ? "Draw" : "Away Win";
    return selection === r ? "HIT" : "MISS";
  }

  // BTTS
  if (name.includes("Both Teams")) {
    const both = hScore > 0 && aScore > 0;
    return (selection === "Yes" ? both : !both) ? "HIT" : "MISS";
  }

  // Boxscore-dependent markets
  if (!box || isNaN(line)) return "PENDING";

  if (name.includes("Total Corners"))  return ou((box.homeCorners  ?? 0) + (box.awayCorners  ?? 0));
  if (name.includes("Total Cards"))    return ou((box.homeCards     ?? 0) + (box.awayCards     ?? 0));
  if (name.includes("Total SOT"))      return ou((box.homeSot       ?? 0) + (box.awaySot       ?? 0));
  if (name.includes("Total Shots"))    return ou((box.homeShots     ?? 0) + (box.awayShots     ?? 0));
  if (name.includes("Total Offsides")) return ou((box.homeOffsides  ?? 0) + (box.awayOffsides  ?? 0));
  if (name.includes("Total Saves"))    return ou((box.homeSaves     ?? 0) + (box.awaySaves     ?? 0));

  return "PENDING";
}

// ─── Auth guard ───────────────────────────────────────────────────────────────
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured → open (dev/local)
  const url      = new URL(req.url);
  const provided =
    req.headers.get("authorization")?.replace("Bearer ", "") ??
    url.searchParams.get("key");
  return provided === secret;
}

// ─── Route handlers ───────────────────────────────────────────────────────────
export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await runVerification();
    return Response.json({ ok: true, ...result, ranAt: new Date().toISOString() });
  } catch {
    return Response.json({ ok: false, error: "Verification job failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return GET(req);
}
