import { db } from "@/db";
import { performanceLog, valueBetLog, savedSlips } from "@/db/schema";
import { gte } from "drizzle-orm";

export const dynamic = "force-dynamic";

const MODES = ["A", "B", "C", "D"] as const;
type Mode = (typeof MODES)[number];
const MODE_LABEL: Record<Mode, string> = { A: "Rank A · Classic", B: "Rank B · 12-Factor", C: "Rank C · Hybrid", D: "Rank D · Consensus" };
type Result = "WIN" | "LOSS" | "PUSH" | "VOID" | "PENDING";

type Pick = { name?: string; selection?: string; outcome?: string; odds?: number; ev?: number; family?: string; factorBreakdown?: Record<string, number> };
type Row = { date: string; match: string; selection: string; market: string; odds: number | null; result: Result; pnl: number | null; rankingMode: Mode; league: string; stake: number | null; ev: number | null };

function result(value?: string | null): Result {
  const v = (value ?? "pending").toLowerCase();
  if (v === "hit" || v === "won" || v === "win") return "WIN";
  if (v === "miss" || v === "lost" || v === "loss") return "LOSS";
  if (v === "push") return "PUSH";
  if (v === "void") return "VOID";
  return "PENDING";
}
function factor(p: Pick) {
  const f = p.factorBreakdown;
  if (f && typeof f === "object" && Object.keys(f).length) return Object.keys(f);
  const s = `${p.name ?? ""} ${p.family ?? ""}`.toLowerCase();
  if (s.includes("corner") || s.includes("card") || s.includes("goal") || s.includes("shot")) return ["Poisson"];
  if (s.includes("result") || s.includes("draw")) return ["Tactical"];
  return ["Calibration"];
}
function pct(n: number, d: number) { return d ? (n / d) * 100 : 0; }

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const daysParam = url.searchParams.get("days") ?? "30";
    const days = daysParam === "all" ? 3650 : Math.min(Math.max(Number(daysParam) || 30, 1), 3650);
    const modeFilter = url.searchParams.get("mode");
    const leagueFilter = url.searchParams.get("league")?.toLowerCase() ?? "";
    const resultFilter = url.searchParams.get("result")?.toUpperCase() ?? "";
    const since = new Date(); since.setDate(since.getDate() - days);
    const day = since.toISOString().slice(0, 10);
    const [performance, values, slips] = await Promise.all([
      db.select().from(performanceLog).where(gte(performanceLog.matchDate, day)).limit(30000),
      db.select().from(valueBetLog).where(gte(valueBetLog.matchDate, day)).limit(30000),
      db.select().from(savedSlips).where(gte(savedSlips.createdAt, since)).limit(5000),
    ]);
    const byMode = new Map<Mode, Row[]>(MODES.map((m) => [m, []]));
    const factors = new Map<Mode, Map<string, { wins: number; total: number }>>(MODES.map((m) => [m, new Map()]));
    const perfect = new Map<Mode, number>(MODES.map((m) => [m, 0]));
    for (const record of performance) {
      const mode = (MODES.includes(record.rankingMode as Mode) ? record.rankingMode : "B") as Mode;
      const picks = (record.top10Detail ?? []) as Pick[];
      if (picks.length === 10 && picks.every((p) => result(p.outcome) === "WIN")) perfect.set(mode, (perfect.get(mode) ?? 0) + 1);
      for (const p of picks) {
        const r = result(p.outcome);
        byMode.get(mode)!.push({ date: record.matchDate, match: record.matchLabel, selection: p.selection ?? p.name ?? "—", market: p.name ?? "Pick", odds: p.odds ?? null, result: r, pnl: null, rankingMode: mode, league: record.competitionName ?? record.league, stake: null, ev: p.ev ?? null });
        for (const name of factor(p)) {
          const b = factors.get(mode)!.get(name) ?? { wins: 0, total: 0 };
          if (r === "WIN" || r === "LOSS") { b.total++; if (r === "WIN") b.wins++; }
          factors.get(mode)!.set(name, b);
        }
      }
    }
    for (const bet of values) {
      const mode = (MODES.includes(bet.rankingMode as Mode) ? bet.rankingMode : "B") as Mode;
      byMode.get(mode)!.push({ date: bet.matchDate, match: bet.match, selection: bet.selection, market: bet.marketName, odds: bet.bookOdds, result: result(bet.outcome), pnl: bet.pnl, rankingMode: mode, league: bet.competitionName ?? bet.leagueSlug, stake: bet.stake, ev: bet.oracleProb * bet.bookOdds - 1 });
    }
    // saved_slips currently has no ranking_mode schema column. Only attribute slips when their persisted pick JSON carries one.
    for (const slip of slips) {
      const stored = slip.picks as Array<{ rankingMode?: string }>;
      const raw = stored?.[0]?.rankingMode;
      if (!raw || !MODES.includes(raw as Mode)) continue;
      const mode = raw as Mode, r = result(slip.status), stake = slip.stake ?? 0;
      byMode.get(mode)!.push({ date: slip.createdAt.toISOString().slice(0, 10), match: slip.name, selection: "Accumulator", market: "Saved Slip", odds: slip.combinedOdds, result: r, pnl: r === "WIN" ? stake * (slip.combinedOdds - 1) : r === "LOSS" ? -stake : null, rankingMode: mode, league: slip.competitionName ?? slip.leagueSlug ?? "—", stake, ev: null });
    }
    const make = (mode: Mode) => {
      let rows = byMode.get(mode)!;
      if (leagueFilter) rows = rows.filter((r) => r.league.toLowerCase().includes(leagueFilter));
      if (resultFilter) rows = rows.filter((r) => r.result === resultFilter);
      rows.sort((a, b) => b.date.localeCompare(a.date));
      const count = (r: Result) => rows.filter((x) => x.result === r).length;
      const wins = count("WIN"), losses = count("LOSS"), pushes = count("PUSH"), voids = count("VOID"), pending = count("PENDING");
      const stakeRows = rows.filter((x) => x.stake !== null);
      const stake = stakeRows.reduce((n, x) => n + (x.stake ?? 0), 0), pnl = rows.reduce((n, x) => n + (x.pnl ?? 0), 0);
      const oddsWeight = stakeRows.reduce((n, x) => n + (x.odds ?? 0) * (x.stake ?? 0), 0);
      const evs = rows.flatMap((x) => x.ev === null ? [] : [x.ev]);
      const chronological = [...rows].sort((a, b) => b.date.localeCompare(a.date));
      let streak = 0; const first = chronological.find((x) => x.result === "WIN" || x.result === "LOSS");
      if (first) for (const x of chronological) { if (x.result === first.result) streak++; else if (x.result === "WIN" || x.result === "LOSS") break; }
      const daily = new Map<string, { pnl: number; wins: number; losses: number }>();
      for (const r of rows) { const d = daily.get(r.date) ?? { pnl: 0, wins: 0, losses: 0 }; d.pnl += r.pnl ?? 0; if (r.result === "WIN") d.wins++; if (r.result === "LOSS") d.losses++; daily.set(r.date, d); }
      let cumulative = 0;
      const trends = [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, d]) => ({ date, pnl: (cumulative += d.pnl), dailyHitRate: pct(d.wins, d.wins + d.losses) }));
      return { mode, label: MODE_LABEL[mode], totalBets: rows.length, wins, losses, pushes, voids, pending, hitRate: pct(wins, wins + losses), totalPnl: pnl, totalStake: stake, roi: pct(pnl, stake), averageOdds: stake ? oddsWeight / stake : null, averageEv: evs.length ? evs.reduce((a,b) => a+b, 0) / evs.length : null, currentStreak: first ? `${streak} ${first.result === "WIN" ? "Wins" : "Losses"}` : "—", tenOfTenHits: perfect.get(mode) ?? 0, factorAccuracy: [...factors.get(mode)!.entries()].map(([name, b]) => ({ factor: name, hits: b.wins, totalBets: b.total, hitRate: pct(b.wins, b.total) })), trends, rows };
    };
    const modes = MODES.filter((m) => !modeFilter || modeFilter === "all" || m === modeFilter).map(make);
    return Response.json({ ok: true, days: daysParam, modes, generatedAt: new Date().toISOString() });
  } catch (error) { console.error("Mode performance API error", error); return Response.json({ ok: false, error: "Unable to load ranking mode performance." }, { status: 500 }); }
}
