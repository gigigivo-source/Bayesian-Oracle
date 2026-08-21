// ĞIGI GIVØ — League-specific performance API.
//
// Aggregated, advanced metrics per competition calculated DIRECTLY from the
// database (performance_log, value_bet_log, saved_slips). No hidden math:
// every aggregate is a sum/count over the underlying bets, and every number
// in the response can be traced to the per-bet breakdown returned alongside.
//
// Query parameters:
//   leagueSlug  (optional)  slug of one competition → adds detailed breakdown
//   days        (optional)  only consider records from the last N days (default 30)
//   sortBy      (optional)  totalBets | hitRate | roi | totalPnl (default totalBets)
//   limit       (optional)  max leagues returned (default 50, max 200)
//
// NOTE: hitRate / roi / trend values are PERCENT NUMBERS (e.g. 62.5 = 62.5%).

import { db } from "@/db";
import { performanceLog, savedSlips, valueBetLog } from "@/db/schema";
import { gte } from "drizzle-orm";
import { LEAGUE_MAP } from "@/lib/leagues";

export const dynamic = "force-dynamic";

// ─── Types ────────────────────────────────────────────────────────────────────

type PickOutcome = "HIT" | "MISS" | "PUSH" | "VOID" | "PENDING";

interface StoredPick {
  name: string;
  selection: string;
  hitRate?: number | null;
  outcome?: string | null;
  family?: string | null;
  odds?: number | null;
  ev?: number | null;
}

interface BetRow {
  date: string;
  match: string;
  market: string;
  selection: string;
  odds: number | null;
  result: PickOutcome;
  pnl: number | null;
  source: "pick" | "valueBet" | "slip";
}

interface FactorStat {
  factor: string;
  hitRate: number;      // percent
  hits: number;
  totalBets: number;    // settled bets (hits + misses)
  trend: "up" | "down" | "flat";
}

export interface LeagueMetrics {
  leagueSlug: string;
  competitionName: string;
  region: string | null;
  // Combined bet counts across performance picks + value bets + slips.
  totalBets: number;
  totalWins: number;
  totalLosses: number;
  totalPushes: number;
  totalVoids: number;
  totalPending: number;
  settledBets: number;
  // Percent numbers.
  hitRate: number;        // wins / (wins + losses) * 100
  roi: number | null;     // totalPnl / totalStake * 100 (null without stake data)
  // Money metrics (staked products: value bets + slips).
  totalStake: number;
  totalPnl: number;
  last7DaysPnl: number;
  last30DaysPnl: number;
  last7DaysHitRate: number;
  last30DaysHitRate: number;
  // Odds & EV.
  averageOdds: number | null; // stake-weighted
  averageEv: number | null;   // simple mean over bets with EV data (fraction)
  // Streak + tier hit rates (percent).
  currentStreak: string;
  top1HitRate: number | null;
  top3HitRate: number | null;
  top10HitRate: number | null;
  // Trend over the window (percent points, 7d vs previous 7d).
  hitRateTrend: number;
  trendDirection: "up" | "down" | "flat";
  // Transparency: source-level counts.
  sourceBreakdown: {
    picks: { total: number; wins: number; losses: number; pushes: number; voids: number; pending: number };
    valueBets: { total: number; wins: number; losses: number; voids: number; pending: number };
    slips: { total: number; wins: number; losses: number; pending: number };
  };
}

interface TrendPoint {
  label: string;   // YYYY-MM-DD
  value: number;   // cumulative P&L at end of day
  delta: number;   // that day's P&L
}

interface LeagueDetail extends LeagueMetrics {
  bets: BetRow[];
  factorAccuracy: FactorStat[];
  pnlTrend: TrendPoint[];
}

// ─── Factor mapping (market family → ranking factor bucket) ──────────────────
// Derives the factor accuracy breakdown from the market families stored on
// every verified pick. Transparent: each bucket lists exactly which families
// feed it, and every bucket is computed from the same settled-pick stream.

export function factorForPick(name: string, family?: string | null): string {
  const n = `${name ?? ""} ${family ?? ""}`.toLowerCase();
  if (n.includes("corner"))            return "Poisson λ (Corners)";
  if (n.includes("card") || n.includes("penalty") || n.includes("red card") || n.includes("sending off"))
    return "Poisson λ (Cards / Discipline)";
  if (n.includes("sot") || n.includes("shot") || n.includes("save"))
    return "Poisson λ (Shots / SOT / Saves)";
  if (
    n.includes("goal") || n.includes("btts") || n.includes("clean sheet") ||
    n.includes("correct score") || n.includes("score")
  )
    return "Poisson λ (Goals)";
  if (n.includes("result") || n.includes("chance") || n.includes("draw"))
    return "Match Result / Double Chance";
  return "Tactical & Misc";
}

const FACTOR_ORDER = [
  "Poisson λ (Goals)",
  "Poisson λ (Corners)",
  "Poisson λ (Cards / Discipline)",
  "Poisson λ (Shots / SOT / Saves)",
  "Match Result / Double Chance",
  "Tactical & Misc",
];

// ─── Loading records within the window ────────────────────────────────────────

async function loadWindow(since: Date) {
  // Filter by the BET date (matchDate) so backfilled historical matches are
  // windowed correctly regardless of when the row was inserted. Slips carry no
  // match date, so they window on creation.
  const sinceDay = since.toISOString().slice(0, 10);
  const [perfRows, vbRows, slipRows] = await Promise.all([
    db.select().from(performanceLog).where(gte(performanceLog.matchDate, sinceDay)).limit(20000),
    db.select().from(valueBetLog).where(gte(valueBetLog.matchDate, sinceDay)).limit(20000),
    db.select().from(savedSlips).where(gte(savedSlips.createdAt, since)).limit(5000),
  ]);
  return { perfRows, vbRows, slipRows };
}

function nameFor(slug: string | null, storedName: string | null, fallback: string): string {
  if (slug) {
    const def = LEAGUE_MAP[slug];
    if (def) return def.name;
  }
  return storedName ?? fallback;
}

function regionFor(slug: string | null): string | null {
  if (!slug) return null;
  return LEAGUE_MAP[slug]?.region ?? null;
}

// ─── Per-league accumulation ──────────────────────────────────────────────────

interface Accumulator {
  slug: string;
  name: string;
  region: string | null;
  picks: Array<{ pick: StoredPick; match: string; matchDate: string; createdAt: string }>;
  valueBets: Array<{
    date: string; stake: number; odds: number; prob: number; pnl: number | null;
    outcome: string; match: string; market: string; selection: string;
  }>;
  slips: Array<{ date: string; stake: number; odds: number; pnl: number | null; status: string; name: string }>;
}

function pickResult(outcome: string | null | undefined): PickOutcome {
  const v = (outcome ?? "PENDING").toUpperCase();
  if (v === "HIT") return "HIT";
  if (v === "MISS") return "MISS";
  if (v === "PUSH") return "PUSH";
  if (v === "VOID") return "VOID";
  return "PENDING";
}

export function groupRecords(perfRows: Awaited<ReturnType<typeof loadWindow>>["perfRows"], vbRows: Awaited<ReturnType<typeof loadWindow>>["vbRows"], slipRows: Awaited<ReturnType<typeof loadWindow>>["slipRows"]): Map<string, Accumulator> {
  const groups = new Map<string, Accumulator>();
  const get = (slug: string, fallbackName: string): Accumulator => {
    let a = groups.get(slug);
    if (!a) {
      a = { slug, name: fallbackName, region: regionFor(slug), picks: [], valueBets: [], slips: [] };
      groups.set(slug, a);
    }
    return a;
  };

  for (const row of perfRows) {
    const slug = row.leagueSlug ?? "unknown";
    const a = get(slug, nameFor(row.leagueSlug, row.competitionName, row.league));
    const detail = (row.top10Detail ?? []) as StoredPick[];
    for (const p of detail) {
      a.picks.push({
        pick: p,
        match: row.matchLabel,
        matchDate: row.matchDate,
        createdAt: row.createdAt.toISOString(),
      });
    }
  }

  for (const row of vbRows) {
    const slug = row.leagueSlug ?? "unknown";
    const a = get(slug, nameFor(row.leagueSlug, row.competitionName, "Unknown Competition"));
    a.valueBets.push({
      date: row.matchDate,
      stake: row.stake,
      odds: row.bookOdds,
      prob: row.oracleProb,
      pnl: row.pnl,
      outcome: row.outcome,
      match: row.match,
      market: row.marketName,
      selection: row.selection,
    });
  }

  for (const row of slipRows) {
    const slug = row.leagueSlug ?? "unknown";
    const a = get(slug, nameFor(row.leagueSlug, row.competitionName, row.name));
    const stake = row.stake ?? 0;
    const pnl = row.status === "won" ? stake * row.combinedOdds - stake
      : row.status === "lost" ? -stake
      : null;
    a.slips.push({ date: row.createdAt.toISOString().slice(0, 10), stake, odds: row.combinedOdds, pnl, status: row.status, name: row.name });
  }

  return groups;
}

function settledRate(wins: number, losses: number): number {
  const n = wins + losses;
  return n > 0 ? (wins / n) * 100 : 0;
}

export function buildMetrics(a: Accumulator, days: number): LeagueMetrics {
  // ── Picks ──
  let pickWins = 0, pickLosses = 0, pickPushes = 0, pickVoids = 0, pickPending = 0;
  const evs: number[] = [];
  for (const { pick: p } of a.picks) {
    const r = pickResult(p.outcome);
    if (r === "HIT") pickWins++;
    else if (r === "MISS") pickLosses++;
    else if (r === "PUSH") pickPushes++;
    else if (r === "VOID") pickVoids++;
    else pickPending++;
    if (typeof p.ev === "number" && Number.isFinite(p.ev)) evs.push(p.ev);
  }

  // ── Value bets ──
  let vbWins = 0, vbLosses = 0, vbVoids = 0, vbPending = 0, vbPnl = 0, vbStake = 0, vbStakeWeightedOdds = 0;
  for (const vb of a.valueBets) {
    if (vb.outcome === "won") vbWins++;
    else if (vb.outcome === "lost") vbLosses++;
    else if (vb.outcome === "void") vbVoids++;
    else vbPending++;
    vbPnl += vb.pnl ?? 0;
    vbStake += vb.stake;
    vbStakeWeightedOdds += vb.stake * vb.odds;
    evs.push(vb.prob * vb.odds - 1);
  }

  // ── Slips ──
  let slipWins = 0, slipLosses = 0, slipPending = 0, slipPnl = 0, slipStake = 0, slipStakeWeightedOdds = 0;
  for (const s of a.slips) {
    if (s.status === "won") slipWins++;
    else if (s.status === "lost") slipLosses++;
    else slipPending++;
    slipPnl += s.pnl ?? 0;
    slipStake += s.stake;
    slipStakeWeightedOdds += s.stake * s.odds;
  }

  const totalWins = pickWins + vbWins + slipWins;
  const totalLosses = pickLosses + vbLosses + slipLosses;
  const totalBets = a.picks.length + a.valueBets.length + a.slips.length;
  const settledBets = totalWins + totalLosses;
  const totalStake = vbStake + slipStake;
  const totalPnl = vbPnl + slipPnl;

  // ── Windows (relative to "now", within the requested N-day window) ──
  const now = Date.now();
  const within = (date: string | null | undefined, ms: number): boolean => {
    if (!date) return false;
    const t = new Date(date).getTime();
    return Number.isFinite(t) && now - t <= ms;
  };

  const last7 = 7 * 24 * 3600_000;
  const last30 = 30 * 24 * 3600_000;

  const vbPnl7 = a.valueBets.filter((v) => within(v.date, last7)).reduce((s, v) => s + (v.pnl ?? 0), 0);
  const slipPnl7 = a.slips.filter((s) => within(s.date, last7)).reduce((s, x) => s + (x.pnl ?? 0), 0);
  const vbPnl30 = a.valueBets.filter((v) => within(v.date, last30)).reduce((s, v) => s + (v.pnl ?? 0), 0);
  const slipPnl30 = a.slips.filter((s) => within(s.date, last30)).reduce((s, x) => s + (x.pnl ?? 0), 0);

  const settledIn7 = (outcome: string, date: string) =>
    (outcome === "won" || outcome === "lost" || outcome === "HIT" || outcome === "MISS") && within(date, last7);
  const settledIn30 = (outcome: string, date: string) =>
    (outcome === "won" || outcome === "lost" || outcome === "HIT" || outcome === "MISS") && within(date, last30);

  const wins7 = pickWins7(a) + a.valueBets.filter((v) => settledIn7(v.outcome, v.date) && v.outcome === "won").length
    + a.slips.filter((s) => settledIn7(s.status, s.date) && s.status === "won").length;
  const losses7 = pickLosses7(a) + a.valueBets.filter((v) => settledIn7(v.outcome, v.date) && v.outcome === "lost").length
    + a.slips.filter((s) => settledIn7(s.status, s.date) && s.status === "lost").length;
  const wins30 = pickWins30(a) + a.valueBets.filter((v) => settledIn30(v.outcome, v.date) && v.outcome === "won").length
    + a.slips.filter((s) => settledIn30(s.status, s.date) && s.status === "won").length;
  const losses30 = pickLosses30(a) + a.valueBets.filter((v) => settledIn30(v.outcome, v.date) && v.outcome === "lost").length
    + a.slips.filter((s) => settledIn30(s.status, s.date) && s.status === "lost").length;

  // ── Streak (match-level from picks' created dates) ──
  const streak = buildStreak(a);

  // ── Tier hit rates are attached by the caller from per-row pick positions ──
  const tier = { top1: { hits: 0, total: 0 }, top3: { hits: 0, total: 0 }, top10: { hits: 0, total: 0 } };

  const averageOdds = totalStake > 0 ? (vbStakeWeightedOdds + slipStakeWeightedOdds) / totalStake : null;
  const averageEv = evs.length > 0 ? evs.reduce((s, e) => s + e, 0) / evs.length : null;

  const last7HitRate = settledRate(wins7, losses7);
  const last30HitRate = settledRate(wins30, losses30);

  // Trend: 7d hit rate vs the previous 7d (percent-point delta).
  const prev7Wins = wins30 - wins7;
  const prev7Losses = losses30 - losses7;
  const prev7Rate = settledRate(prev7Wins, prev7Losses);
  const hitRateTrend = wins7 + losses7 > 0 && prev7Wins + prev7Losses > 0 ? last7HitRate - prev7Rate : 0;
  const trendDirection: "up" | "down" | "flat" =
    hitRateTrend > 0.5 ? "up" : hitRateTrend < -0.5 ? "down" : "flat";

  return {
    leagueSlug: a.slug,
    competitionName: a.name,
    region: a.region,
    totalBets,
    totalWins,
    totalLosses,
    totalPushes: pickPushes,
    totalVoids: pickVoids + vbVoids,
    totalPending: pickPending + vbPending + slipPending,
    settledBets,
    hitRate: settledRate(totalWins, totalLosses),
    roi: totalStake > 0 ? (totalPnl / totalStake) * 100 : null,
    totalStake,
    totalPnl: Math.round(totalPnl * 100) / 100,
    last7DaysPnl: Math.round((vbPnl7 + slipPnl7) * 100) / 100,
    last30DaysPnl: Math.round((vbPnl30 + slipPnl30) * 100) / 100,
    last7DaysHitRate: last7HitRate,
    last30DaysHitRate: last30HitRate,
    averageOdds,
    averageEv,
    currentStreak: streak,
    top1HitRate: tier.top1.total > 0 ? (tier.top1.hits / tier.top1.total) * 100 : null,
    top3HitRate: tier.top3.total > 0 ? (tier.top3.hits / tier.top3.total) * 100 : null,
    top10HitRate: tier.top10.total > 0 ? (tier.top10.hits / tier.top10.total) * 100 : null,
    hitRateTrend,
    trendDirection,
    sourceBreakdown: {
      picks: { total: a.picks.length, wins: pickWins, losses: pickLosses, pushes: pickPushes, voids: pickVoids, pending: pickPending },
      valueBets: { total: a.valueBets.length, wins: vbWins, losses: vbLosses, voids: vbVoids, pending: vbPending },
      slips: { total: a.slips.length, wins: slipWins, losses: slipLosses, pending: slipPending },
    },
  };
}

function dayCutoff(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function pickWins7(a: Accumulator): number {
  const cutoff = dayCutoff(7);
  let n = 0;
  for (const entry of a.picks) {
    const r = pickResult(entry.pick.outcome);
    if ((r === "HIT" || r === "MISS") && entry.matchDate >= cutoff) {
      if (r === "HIT") n++;
    }
  }
  return n;
}
function pickLosses7(a: Accumulator): number {
  const cutoff = dayCutoff(7);
  let n = 0;
  for (const entry of a.picks) {
    const r = pickResult(entry.pick.outcome);
    if ((r === "HIT" || r === "MISS") && entry.matchDate >= cutoff) {
      if (r === "MISS") n++;
    }
  }
  return n;
}
function pickWins30(a: Accumulator): number {
  const cutoff = dayCutoff(30);
  let n = 0;
  for (const entry of a.picks) {
    const r = pickResult(entry.pick.outcome);
    if ((r === "HIT" || r === "MISS") && entry.matchDate >= cutoff) {
      if (r === "HIT") n++;
    }
  }
  return n;
}
function pickLosses30(a: Accumulator): number {
  const cutoff = dayCutoff(30);
  let n = 0;
  for (const entry of a.picks) {
    const r = pickResult(entry.pick.outcome);
    if ((r === "HIT" || r === "MISS") && entry.matchDate >= cutoff) {
      if (r === "MISS") n++;
    }
  }
  return n;
}

export function buildStreak(a: Accumulator): string {
  // Match-level streak: bucket picks by match, decide each match by its
  // settled picks (a match with any MISS counts as a loss), newest first.
  const byMatch = new Map<string, { matchDate: string; hits: number; misses: number }>();
  for (const entry of a.picks) {
    const key = `${entry.match}|${entry.matchDate}`;
    const cur = byMatch.get(key) ?? { matchDate: entry.matchDate, hits: 0, misses: 0 };
    const r = pickResult(entry.pick.outcome);
    if (r === "HIT") cur.hits++;
    else if (r === "MISS") cur.misses++;
    byMatch.set(key, cur);
  }
  const matches = [...byMatch.values()]
    .filter((m) => m.hits + m.misses > 0)
    .sort((x, y) => y.matchDate.localeCompare(x.matchDate));

  let winStreak = 0;
  let lossStreak = 0;
  for (const m of matches) {
    if (m.misses === 0) {
      if (lossStreak > 0) break;
      winStreak++;
    } else {
      if (winStreak > 0) break;
      lossStreak++;
    }
  }
  if (winStreak > 0) return `${winStreak} Win${winStreak > 1 ? "s" : ""}`;
  if (lossStreak > 0) return `${lossStreak} Loss${lossStreak > 1 ? "es" : ""}`;
  return "No settled bets";
}

// ─── Tier hit rates + factor accuracy need per-row data, computed here ────────

interface RowDerived {
  top1: { hits: number; total: number };
  top3: { hits: number; total: number };
  top10: { hits: number; total: number };
  factorBuckets: Map<string, { hits: number; total: number; recent: { hits: number; total: number }; prior: { hits: number; total: number } }>;
}

export function deriveFromRows(rows: Array<{ top10Detail: unknown; matchDate: string }>): RowDerived {
  const top1 = { hits: 0, total: 0 };
  const top3 = { hits: 0, total: 0 };
  const top10 = { hits: 0, total: 0 };
  const buckets = new Map<string, { hits: number; total: number; recent: { hits: number; total: number }; prior: { hits: number; total: number } }>();
  const now = Date.now();
  const day7 = 7 * 24 * 3600_000;
  const day14 = 14 * 24 * 3600_000;

  const bump = (factor: string, outcome: string | null | undefined, matchDate: string) => {
    const r = pickResult(outcome);
    if (r !== "HIT" && r !== "MISS") return;
    let b = buckets.get(factor);
    if (!b) {
      b = { hits: 0, total: 0, recent: { hits: 0, total: 0 }, prior: { hits: 0, total: 0 } };
      buckets.set(factor, b);
    }
    b.total++;
    if (r === "HIT") b.hits++;
    const t = new Date(`${matchDate}T00:00:00Z`).getTime();
    const age = Number.isFinite(t) ? now - t : Infinity;
    if (age <= day7) {
      b.recent.total++;
      if (r === "HIT") b.recent.hits++;
    } else if (age <= day14) {
      b.prior.total++;
      if (r === "HIT") b.prior.hits++;
    }
  };

  for (const row of rows) {
    const detail = (row.top10Detail ?? []) as StoredPick[];
    for (let i = 0; i < detail.length; i++) {
      const p = detail[i];
      const r = pickResult(p.outcome);
      if (i === 0) {
        top1.total++;
        if (r === "HIT") top1.hits++;
      }
      if (i < 3) {
        top3.total++;
        if (r === "HIT") top3.hits++;
      }
      top10.total++;
      if (r === "HIT") top10.hits++;
      bump(factorForPick(p.name, p.family), p.outcome, row.matchDate);
    }
  }
  return { top1, top3, top10, factorBuckets: buckets };
}

// ─── Detailed breakdown for one league ────────────────────────────────────────

export function buildBets(a: Accumulator): BetRow[] {
  const bets: BetRow[] = [];

  for (const entry of a.picks) {
    const p = entry.pick;
    bets.push({
      date: entry.matchDate,
      match: entry.match,
      market: p.name,
      selection: p.selection,
      odds: p.odds ?? null,
      result: pickResult(p.outcome),
      pnl: null, // verification picks carry no stake
      source: "pick",
    });
  }
  for (const vb of a.valueBets) {
    bets.push({
      date: vb.date,
      match: vb.match,
      market: vb.market,
      selection: vb.selection,
      odds: vb.odds,
      result: vb.outcome === "won" ? "HIT" : vb.outcome === "lost" ? "MISS" : vb.outcome === "void" ? "VOID" : "PENDING",
      pnl: vb.pnl,
      source: "valueBet",
    });
  }
  for (const s of a.slips) {
    bets.push({
      date: s.date,
      match: s.name,
      market: "Accumulator Slip",
      selection: s.status.toUpperCase(),
      odds: s.odds,
      result: s.status === "won" ? "HIT" : s.status === "lost" ? "MISS" : "PENDING",
      pnl: s.pnl,
      source: "slip",
    });
  }

  return bets
    .sort((x, y) => y.date.localeCompare(x.date) || y.source.localeCompare(x.source))
    .slice(0, 500);
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const leagueSlug = url.searchParams.get("leagueSlug")?.trim() || null;
    const daysRaw = Number(url.searchParams.get("days"));
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(Math.round(daysRaw), 3650) : 30;
    const sortBy = (url.searchParams.get("sortBy") ?? "totalBets") as "totalBets" | "hitRate" | "roi" | "totalPnl";
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? Math.round(limitRaw) : 50, 200);

    const since = new Date();
    since.setDate(since.getDate() - days);

    const { perfRows, vbRows, slipRows } = await loadWindow(since);
    const groups = groupRecords(perfRows, vbRows, slipRows);

    // Row-derived stats (tier rates + factor buckets) per slug.
    const rowDerived = new Map<string, RowDerived>();
    const rowsBySlug = new Map<string, Array<{ top10Detail: unknown; matchDate: string }>>();
    for (const row of perfRows) {
      const slug = row.leagueSlug ?? "unknown";
      const list = rowsBySlug.get(slug) ?? [];
      list.push(row);
      rowsBySlug.set(slug, list);
    }
    for (const [slug, rows] of rowsBySlug) rowDerived.set(slug, deriveFromRows(rows));

    const metrics = [...groups.values()].map((a) => {
      const m = buildMetrics(a, days);
      const derived = rowDerived.get(a.slug);
      if (derived) {
        m.top1HitRate = derived.top1.total > 0 ? (derived.top1.hits / derived.top1.total) * 100 : null;
        m.top3HitRate = derived.top3.total > 0 ? (derived.top3.hits / derived.top3.total) * 100 : null;
        m.top10HitRate = derived.top10.total > 0 ? (derived.top10.hits / derived.top10.total) * 100 : null;
      }
      return m;
    });

    // ── Sorting ──
    const sortVal: Record<string, (m: LeagueMetrics) => number> = {
      totalBets: (m) => m.totalBets,
      hitRate:   (m) => m.hitRate,
      roi:       (m) => m.roi ?? -Infinity,
      totalPnl:  (m) => m.totalPnl,
    };
    const sorted = metrics.sort((x, y) => {
      const key = sortVal[sortBy] ?? sortVal.totalBets;
      return key(y) - key(x);
    });

    // ── Detailed breakdown when a slug is requested ──
    let league: LeagueDetail | null = null;
    if (leagueSlug) {
      const a = groups.get(leagueSlug);
      if (a) {
        const base = buildMetrics(a, days);
        const derived = rowDerived.get(leagueSlug);
        if (derived) {
          base.top1HitRate = derived.top1.total > 0 ? (derived.top1.hits / derived.top1.total) * 100 : null;
          base.top3HitRate = derived.top3.total > 0 ? (derived.top3.hits / derived.top3.total) * 100 : null;
          base.top10HitRate = derived.top10.total > 0 ? (derived.top10.hits / derived.top10.total) * 100 : null;
        }

        const factorAccuracy: FactorStat[] = [];
        for (const factor of FACTOR_ORDER) {
          const b = derived?.factorBuckets.get(factor);
          if (!b || b.total === 0) continue;
          const rate = b.total > 0 ? (b.hits / b.total) * 100 : 0;
          const recent = b.recent.total > 0 ? b.recent.hits / b.recent.total : null;
          const prior = b.prior.total > 0 ? b.prior.hits / b.prior.total : null;
          const trend: FactorStat["trend"] =
            recent !== null && prior !== null
              ? recent > prior + 0.005 ? "up" : recent < prior - 0.005 ? "down" : "flat"
              : "flat";
          factorAccuracy.push({
            factor,
            hitRate: rate,
            hits: b.hits,
            totalBets: b.total,
            trend,
          });
        }
        // Composite calibration bucket = every settled pick in the league.
        const all = derived?.factorBuckets;
        if (all) {
          let hits = 0, total = 0, rHits = 0, rTotal = 0, pHits = 0, pTotal = 0;
          for (const b of all.values()) {
            hits += b.hits; total += b.total;
            rHits += b.recent.hits; rTotal += b.recent.total;
            pHits += b.prior.hits; pTotal += b.prior.total;
          }
          if (total > 0) {
            const recent = rTotal > 0 ? rHits / rTotal : null;
            const prior = pTotal > 0 ? pHits / pTotal : null;
            factorAccuracy.unshift({
              factor: "Calibration (All Picks)",
              hitRate: (hits / total) * 100,
              hits,
              totalBets: total,
              trend: recent !== null && prior !== null
                ? recent > prior + 0.005 ? "up" : recent < prior - 0.005 ? "down" : "flat"
                : "flat",
            });
          }
        }

        // ── P&L trend: daily buckets, cumulative within the window ──
        const money: Array<{ date: string; pnl: number }> = [
          ...a.valueBets.map((v) => ({ date: v.date.slice(0, 10), pnl: v.pnl ?? 0 })),
          ...a.slips.map((s) => ({ date: s.date.slice(0, 10), pnl: s.pnl ?? 0 })),
        ];
        const byDay = new Map<string, number>();
        for (const m of money) byDay.set(m.date, (byDay.get(m.date) ?? 0) + m.pnl);
        const daysArr = [...byDay.entries()].sort((x, y) => x[0].localeCompare(y[0]));
        let cumulative = 0;
        const pnlTrend: TrendPoint[] = daysArr.map(([label, delta]) => {
          cumulative += delta;
          return { label, value: Math.round(cumulative * 100) / 100, delta: Math.round(delta * 100) / 100 };
        });

        league = { ...base, bets: buildBets(a), factorAccuracy, pnlTrend };
      }
    }

    return Response.json({
      ok: true,
      days,
      sortBy,
      totalLeagues: sorted.length,
      leagues: sorted.slice(0, limit),
      league, // full detailed breakdown when leagueSlug was provided
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("League performance API error:", err);
    return Response.json({ ok: false, error: "Failed to compute league performance" }, { status: 500 });
  }
}
