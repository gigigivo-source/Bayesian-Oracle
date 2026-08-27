import Link from "next/link";
import type { ReactNode } from "react";

// ĞIGI GIVØ — First 5 Minutes track record.
//
// Dedicated performance dashboard for First 5 Minutes picks, stored in
// performance_log with feature = 'first5' (rankingMode 'F5') — fully
// independent of the A–D ranking-mode system. Picks are recorded when the
// feed generates them (Goal / Corner / Card / Penalty, Yes / No), and the
// settle cron's feature sweep resolves each one from the actual opening-
// phase event data of the match (timestamped goal events where available,
// otherwise the real match totals — a pick is voided, never guessed, when
// the data cannot prove the opening five minutes).
//
// Server component on purpose: it reads the database directly (fail-soft —
// a missing DATABASE_URL renders an honest error state instead of a 500)
// and needs no client JavaScript. Filters, sorting, the trend window and
// the CSV export are plain URL state, so everything works without JS.
//
// Money convention (disclosed on the page): a $10 unit stake at the stored
// model odds — the fair price 1 / hitRate for corner lines — so P&L and ROI
// describe the track record of the model, not a bookmaker line.

export const dynamic = "force-dynamic";

const FEATURE = "first5";
const ROWS_LIMIT = 5000;
const TABLE_LIMIT = 500;
const UNIT_STAKE = 10;

const ACCENT = {
  text: "text-cyan-300",
  textSoft: "text-cyan-200/80",
  chip: "border-cyan-400/30 bg-cyan-500/10 text-cyan-200",
  ring: "border-cyan-400/40",
  softBg: "bg-cyan-500/10",
  gradient: "bg-gradient-to-br from-cyan-400 to-teal-400",
  link: "text-cyan-300 hover:text-cyan-200",
};

/** The four tracked first-5 market types. */
const MARKET_TYPES = ["Goal", "Corner", "Card", "Penalty"];

type Result = "WIN" | "LOSS" | "PUSH" | "VOID" | "PENDING";

interface Bet {
  id: number;
  date: string; // YYYY-MM-DD (match date)
  match: string;
  league: string;
  leagueSlug: string;
  score: string | null;
  market: string;
  selection: string;
  hitRate: number | null;
  odds: number | null;
  result: Result;
  confidence: string | null;
  pnl: number | null;
  settledKey: string; // sort key for the streak (settledAt or match date)
}

interface TrendPoint {
  label: string;
  value: number;
  delta: number;
}

interface DailyPoint {
  label: string;
  rate: number | null; // 0..1, null when nothing settled that day
  hits: number;
  settled: number;
}

// ─── Data loading (fail-soft) ─────────────────────────────────────────────────

interface RawRow {
  id: number;
  matchLabel: string;
  league: string;
  leagueSlug: string | null;
  competitionName: string | null;
  matchDate: string;
  homeScore: number;
  awayScore: number;
  market: string | null;
  selection: string | null;
  outcome: string | null;
  hitRate: number | null;
  confidence: string | null;
  settledAt: Date | null;
  top10Detail: unknown;
}

async function loadRows(): Promise<RawRow[] | null> {
  try {
    const { db } = await import("@/db");
    const { performanceLog } = await import("@/db/schema");
    const { desc, eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(performanceLog)
      .where(eq(performanceLog.feature, FEATURE))
      .orderBy(desc(performanceLog.id))
      .limit(ROWS_LIMIT);
    return rows as unknown as RawRow[];
  } catch {
    return null; // DATABASE_URL missing / DB unreachable — render error state
  }
}

function normaliseOutcome(outcome: string | null): Result {
  const v = (outcome ?? "PENDING").toUpperCase();
  if (v === "WIN" || v === "HIT") return "WIN";
  if (v === "LOSS" || v === "MISS") return "LOSS";
  if (v === "PUSH") return "PUSH";
  if (v === "VOID") return "VOID";
  return "PENDING";
}

function toBets(rows: RawRow[]): Bet[] {
  const bets: Bet[] = [];
  for (const row of rows) {
    const result = normaliseOutcome(row.outcome);
    const detail = Array.isArray(row.top10Detail)
      ? (row.top10Detail as Array<Record<string, unknown>>)[0]
      : null;
    const storedOdds = detail && typeof detail.odds === "number" ? detail.odds : null;
    const hitRate = typeof row.hitRate === "number" ? row.hitRate : null;
    const odds = storedOdds ?? (hitRate && hitRate > 0 ? Math.round((1 / hitRate) * 100) / 100 : null);
    const settled = result === "WIN" || result === "LOSS";
    const scoreKnown = settled || result === "PUSH" || result === "VOID";
    const pnl =
      result === "WIN"
        ? odds !== null
          ? Math.round(UNIT_STAKE * (odds - 1) * 100) / 100
          : null
        : result === "LOSS"
          ? -UNIT_STAKE
          : result === "PUSH" || result === "VOID"
            ? 0
            : null;
    bets.push({
      id: row.id,
      date: (row.matchDate ?? "").slice(0, 10),
      match: row.matchLabel,
      league: row.competitionName ?? row.league ?? "Unknown Competition",
      leagueSlug: row.leagueSlug ?? "unknown",
      score: scoreKnown ? `${row.homeScore}–${row.awayScore}` : null,
      market: row.market ?? "—",
      selection: row.selection ?? "—",
      hitRate,
      odds,
      result,
      confidence: row.confidence ?? null,
      pnl,
      settledKey: (row.settledAt ? row.settledAt.toISOString() : `${row.matchDate}T00:00:00Z`),
    });
  }
  return bets;
}

// ─── Filters (URL state) ──────────────────────────────────────────────────────

interface Filters {
  from: string;
  to: string;
  league: string;
  result: string;
  market: string;
  sort: "date" | "odds" | "pnl";
  dir: "asc" | "desc";
  window: "7" | "30" | "all";
}

function readFilters(sp: Record<string, string | string[] | undefined>): Filters {
  const s = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");
  const sort = s(sp.sort) === "odds" || s(sp.sort) === "pnl" ? (s(sp.sort) as Filters["sort"]) : "date";
  const dir = s(sp.dir) === "asc" ? "asc" : "desc";
  const window = s(sp.window) === "7" || s(sp.window) === "all" ? (s(sp.window) as Filters["window"]) : "30";
  const market = MARKET_TYPES.includes(s(sp.market)) ? s(sp.market) : "";
  return { from: s(sp.from), to: s(sp.to), league: s(sp.league), result: s(sp.result), market, sort, dir, window };
}

function hrefWith(base: string, filters: Filters, overrides: Partial<Filters> = {}): string {
  const f = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (f.league) params.set("league", f.league);
  if (f.result) params.set("result", f.result);
  if (f.market) params.set("market", f.market);
  if (f.sort !== "date") params.set("sort", f.sort);
  if (f.dir !== "desc") params.set("dir", f.dir);
  if (f.window !== "30") params.set("window", f.window);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function applyFilters(bets: Bet[], f: Filters): Bet[] {
  return bets.filter((b) => {
    if (f.from && b.date < f.from) return false;
    if (f.to && b.date > f.to) return false;
    if (f.league && b.leagueSlug !== f.league) return false;
    if (f.result && b.result !== f.result) return false;
    if (f.market && b.market !== f.market) return false;
    return true;
  });
}

function sortBets(bets: Bet[], f: Filters): Bet[] {
  const arr = [...bets];
  const factor = f.dir === "asc" ? 1 : -1;
  arr.sort((a, b) => {
    let cmp = 0;
    if (f.sort === "date") cmp = a.settledKey.localeCompare(b.settledKey) || a.id - b.id;
    else if (f.sort === "odds") cmp = (a.odds ?? -1) - (b.odds ?? -1);
    else cmp = (a.pnl ?? -Infinity) - (b.pnl ?? -Infinity);
    return cmp * factor;
  });
  return arr;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

interface Stats {
  total: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  pending: number;
  hitRate: number | null;
  pnl: number;
  staked: number;
  roi: number | null;
  avgOdds: number | null;
  streak: { count: number; type: "WIN" | "LOSS" | null };
  leagues: Array<{ slug: string; name: string; count: number }>;
}

function computeStats(bets: Bet[]): Stats {
  const wins = bets.filter((b) => b.result === "WIN").length;
  const losses = bets.filter((b) => b.result === "LOSS").length;
  const pushes = bets.filter((b) => b.result === "PUSH").length;
  const voids = bets.filter((b) => b.result === "VOID").length;
  const pending = bets.filter((b) => b.result === "PENDING").length;
  const settled = wins + losses;
  const pnl = bets.reduce((sum, b) => sum + (b.pnl ?? 0), 0);
  const staked = settled * UNIT_STAKE;
  const settledWithOdds = bets.filter((b) => (b.result === "WIN" || b.result === "LOSS") && b.odds !== null);
  const avgOdds = settledWithOdds.length > 0
    ? settledWithOdds.reduce((s, b) => s + (b.odds ?? 0), 0) / settledWithOdds.length
    : null;

  // Current streak over settled picks, most recently settled first.
  const ordered = [...bets]
    .filter((b) => b.result === "WIN" || b.result === "LOSS")
    .sort((a, b) => b.settledKey.localeCompare(a.settledKey) || b.id - a.id);
  let streak = { count: 0, type: null as "WIN" | "LOSS" | null };
  for (const b of ordered) {
    if (streak.type === null) streak = { count: 1, type: b.result as "WIN" | "LOSS" };
    else if (streak.type === b.result) streak.count++;
    else break;
  }

  const leagueMap = new Map<string, { slug: string; name: string; count: number }>();
  for (const b of bets) {
    const existing = leagueMap.get(b.leagueSlug);
    if (existing) existing.count++;
    else leagueMap.set(b.leagueSlug, { slug: b.leagueSlug, name: b.league, count: 1 });
  }

  return {
    total: bets.length,
    wins, losses, pushes, voids, pending,
    hitRate: settled > 0 ? wins / settled : null,
    pnl: Math.round(pnl * 100) / 100,
    staked,
    roi: staked > 0 ? (pnl / staked) * 100 : null,
    avgOdds,
    streak,
    leagues: [...leagueMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function windowCutoff(window: Filters["window"]): string | null {
  if (window === "all") return null;
  const d = new Date();
  d.setDate(d.getDate() - Number(window));
  return d.toISOString().slice(0, 10);
}

function pnlTrend(bets: Bet[], window: Filters["window"]): TrendPoint[] {
  const cutoff = windowCutoff(window);
  const byDay = new Map<string, number>();
  for (const b of bets) {
    if (!cutoff || b.date >= cutoff) byDay.set(b.date, (byDay.get(b.date) ?? 0) + (b.pnl ?? 0));
  }
  let cumulative = 0;
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, delta]) => {
      cumulative += delta;
      return { label, value: Math.round(cumulative * 100) / 100, delta: Math.round(delta * 100) / 100 };
    });
}

function dailyHitRate(bets: Bet[], window: Filters["window"]): DailyPoint[] {
  const cutoff = windowCutoff(window);
  const byDay = new Map<string, { hits: number; settled: number }>();
  for (const b of bets) {
    if (cutoff && b.date < cutoff) continue;
    if (b.result !== "WIN" && b.result !== "LOSS") continue;
    const d = byDay.get(b.date) ?? { hits: 0, settled: 0 };
    d.settled++;
    if (b.result === "WIN") d.hits++;
    byDay.set(b.date, d);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, d]) => ({
      label,
      rate: d.settled > 0 ? d.hits / d.settled : null,
      hits: d.hits,
      settled: d.settled,
    }));
}

// ─── CSV export (server-generated, no JS required) ───────────────────────────

function csvFor(bets: Bet[], name: string): string {
  const esc = (v: string | number | null): string => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["Date", "Match", "League", "Market", "Selection", "Odds", "Hit Rate %", "Confidence", "Result", "Profit/Loss"];
  const lines = bets.map((b) => [
    b.date, b.match, b.league, b.market, b.selection,
    b.odds === null ? "" : b.odds.toFixed(2),
    b.hitRate === null ? "" : (b.hitRate * 100).toFixed(1),
    b.confidence ?? "", b.result, b.pnl === null ? "" : b.pnl.toFixed(2),
  ].map(esc).join(","));
  const csv = [header.join(","), ...lines].join("\n");
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function First5MinutesPerformancePage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const BASE = "/performance/first5";
  const filters = readFilters(await props.searchParams);
  const rows = await loadRows();

  return (
    <div className="min-h-screen bg-[#0F1117] text-slate-100 antialiased">
      <Shell />
      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className={`mb-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider ${ACCENT.chip}`}>
              ⏱ Feature Track Record
            </div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">
              First 5 Minutes Performance
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">
              Every First 5 Minutes pick (performance_log feature = &lsquo;first5&rsquo;) — independent of
              the A–D ranking modes. Goal / Corner / Card / Penalty, Yes / No, settled automatically from
              the actual opening-phase event data once each match finishes.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/first-5-minutes" className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-700 hover:text-white">
              ← First 5 Minutes
            </Link>
            <Link href="/performance" className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-700 hover:text-white">
              ← All Performance
            </Link>
          </div>
        </header>

        {rows === null ? (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-6 text-sm text-rose-200">
            <div className="font-bold">Database unavailable</div>
            <p className="mt-1 text-rose-200/70">
              The performance database could not be reached (DATABASE_URL missing or the Postgres instance is
              down), so no First 5 Minutes track record can be shown right now.
            </p>
          </div>
        ) : (
          <Content bets={toBets(rows)} filters={filters} base={BASE} />
        )}
      </main>
      <footer className="mx-auto max-w-7xl px-4 pb-8">
        <p className="border-t border-slate-700/60 pt-4 text-center text-[11px] leading-relaxed text-slate-500">
          P&amp;L and ROI assume a ${UNIT_STAKE} unit stake at the stored model odds (fair price 1 / hit-rate).
          PUSH and VOID picks return the stake. A pick is never settled without real match data — when the
          evidence is missing it stays pending or is voided, never guessed.
        </p>
      </footer>
    </div>
  );
}

// ─── Shell (header, matches the performance section) ──────────────────────────

function Shell() {
  const nav = [
    { href: "/performance/modes", label: "Modes" },
    { href: "/performance/leagues", label: "Leagues" },
    { href: "/performance/value-bets", label: "Value Bets" },
    { href: "/performance/corners", label: "Corners" },
    { href: "/performance/first5", label: "First 5", active: true },
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-slate-700 bg-slate-900 shadow-lg">
      <div className="mx-auto max-w-7xl px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/" className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-400/20 text-xl">⏱</div>
            <div>
              <div className="bg-gradient-to-r from-cyan-400 to-teal-400 bg-clip-text font-mono text-base font-extrabold tracking-tight text-transparent">
                ĞIGI GIVØ
              </div>
              <p className="font-mono text-[10px] text-slate-400">Performance · First 5 Minutes</p>
            </div>
          </Link>
          <nav className="flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800 p-1.5">
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                  n.active
                    ? "bg-gradient-to-r from-cyan-400 to-teal-400 text-white shadow"
                    : "text-slate-300 hover:bg-slate-700 hover:text-white"
                }`}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </header>
  );
}

// ─── Content (cards, filters, trends, table) ──────────────────────────────────

function Content({ bets, filters, base }: { bets: Bet[]; filters: Filters; base: string }) {
  if (bets.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-700 bg-slate-900 p-10 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-500/10 text-2xl">📊</div>
        <h2 className="text-lg font-bold text-slate-200">No First 5 Minutes picks tracked yet</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-slate-400">
          Picks are recorded automatically when the <Link href="/first-5-minutes" className={ACCENT.link}>First 5 Minutes</Link> feed
          generates them (Goal / Corner / Card / Penalty), and each pick settles from the actual
          opening-phase event data after the match finishes.
        </p>
      </div>
    );
  }

  const filtered = sortBets(applyFilters(bets, filters), filters);
  const stats = computeStats(filtered);
  const pnlPoints = pnlTrend(filtered, filters.window);
  const dailyPoints = dailyHitRate(filtered, filters.window);
  const csvHref = csvFor(filtered, "first-5-minutes-performance.csv");

  return (
    <>
      {/* ── Summary cards ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Total Bets" value={String(stats.total)} sub={`${stats.pending} pending`} tone="neutral" />
        <StatCard label="Wins" value={String(stats.wins)} sub={`${stats.losses} losses`} tone="positive" />
        <StatCard label="Pushes / Voids" value={`${stats.pushes} / ${stats.voids}`} sub="stake returned" tone="neutral" />
        <StatCard
          label="Hit Rate"
          value={stats.hitRate === null ? "—" : `${(stats.hitRate * 100).toFixed(1)}%`}
          sub={stats.hitRate === null ? "no settled picks" : `${stats.wins}W – ${stats.losses}L`}
          tone={stats.hitRate === null ? "neutral" : stats.hitRate >= 0.5 ? "positive" : "negative"}
        />
        <StatCard
          label="P&L"
          value={money(stats.pnl)}
          sub={`of ${money(stats.staked)} staked`}
          tone={stats.pnl === 0 ? "neutral" : stats.pnl > 0 ? "positive" : "negative"}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          label="ROI"
          value={stats.roi === null ? "—" : `${stats.roi >= 0 ? "+" : ""}${stats.roi.toFixed(1)}%`}
          sub="settled picks only"
          tone={stats.roi === null ? "neutral" : stats.roi >= 0 ? "positive" : "negative"}
        />
        <StatCard
          label="Average Odds"
          value={stats.avgOdds === null ? "—" : stats.avgOdds.toFixed(2)}
          sub="settled picks"
          tone="info"
        />
        <StreakCard streak={stats.streak} />
        <div className="flex flex-col justify-between rounded-xl border border-slate-700 bg-slate-900 p-4">
          <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Result Mix</span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Pill tone="win">{stats.wins} W</Pill>
            <Pill tone="loss">{stats.losses} L</Pill>
            {stats.pushes > 0 ? <Pill tone="push">{stats.pushes} P</Pill> : null}
            {stats.voids > 0 ? <Pill tone="void">{stats.voids} V</Pill> : null}
            <Pill tone="pending">{stats.pending} ⏳</Pill>
          </div>
        </div>
        <div className="flex flex-col justify-between rounded-xl border border-slate-700 bg-slate-900 p-4">
          <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Export</span>
          <a
            href={csvHref}
            download="first-5-minutes-performance.csv"
            className={`mt-2 inline-flex w-fit items-center gap-1.5 rounded-full ${ACCENT.gradient} px-3.5 py-1.5 text-xs font-bold text-white shadow transition hover:brightness-110`}
          >
            ⬇ CSV ({filtered.length})
          </a>
          <p className="mt-1.5 text-[10px] text-slate-500">the exact rows shown below</p>
        </div>
      </div>

      {/* ── Filters ── */}
      <form
        method="GET"
        action={base}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-700 bg-slate-900 p-4"
      >
        <Field label="From">
          <input type="date" name="from" defaultValue={filters.from} className={inputCls} />
        </Field>
        <Field label="To">
          <input type="date" name="to" defaultValue={filters.to} className={inputCls} />
        </Field>
        <Field label="League">
          <select name="league" defaultValue={filters.league} className={inputCls}>
            <option value="">All leagues ({bets.length})</option>
            {stats.leagues.map((l) => (
              <option key={l.slug} value={l.slug}>{l.name} ({l.count})</option>
            ))}
          </select>
        </Field>
        <Field label="Market">
          <select name="market" defaultValue={filters.market} className={inputCls}>
            <option value="">All markets</option>
            {MARKET_TYPES.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label="Result">
          <select name="result" defaultValue={filters.result} className={inputCls}>
            <option value="">All results</option>
            {["WIN", "LOSS", "PUSH", "VOID", "PENDING"].map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </Field>
        {/* preserved across the date/league/market/result submit */}
        <input type="hidden" name="sort" value={filters.sort} />
        <input type="hidden" name="dir" value={filters.dir} />
        <input type="hidden" name="window" value={filters.window} />
        <button type="submit" className="rounded-lg bg-gradient-to-r from-cyan-400 to-teal-400 px-4 py-1.5 text-xs font-bold text-white shadow transition hover:brightness-110">
          Apply
        </button>
        <Link href={base} className="rounded-lg border border-slate-700 px-4 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-800">
          Reset
        </Link>
      </form>

      {/* ── Trends ── */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300">Trends</h2>
        <div className="flex items-center gap-1 rounded-full border border-slate-700 bg-slate-800 p-1">
          {(["7", "30", "all"] as const).map((w) => (
            <Link
              key={w}
              href={hrefWith(base, filters, { window: w })}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                filters.window === w ? "bg-slate-600 text-white" : "text-slate-400 hover:text-white"
              }`}
            >
              {w === "all" ? "All" : `${w}d`}
            </Link>
          ))}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartPanel title="Cumulative P&L" subtitle={`settled picks, ${filters.window === "all" ? "all time" : `last ${filters.window} days`}`}>
          <PnLChart points={pnlPoints} />
        </ChartPanel>
        <ChartPanel title="Daily Hit Rate" subtitle={`wins / settled per match day, ${filters.window === "all" ? "all time" : `last ${filters.window} days`}`}>
          <DailyHitRateChart points={dailyPoints} />
        </ChartPanel>
      </div>

      {/* ── Detailed table ── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300">
          Detailed Performance Table
          <span className="ml-2 font-mono text-[11px] font-normal normal-case text-slate-500">
            {filtered.length} picks · newest {filters.dir === "desc" ? "first" : "last"}
          </span>
        </h2>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-700 bg-slate-800">
            <tr>
              <SortHeader label="Date" active={filters.sort === "date"} dir={filters.dir} href={sortHref(base, filters, "date")} />
              <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Match</th>
              <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">League</th>
              <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Market</th>
              <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Selection</th>
              <SortHeader label="Odds" active={filters.sort === "odds"} dir={filters.dir} href={sortHref(base, filters, "odds")} align="right" />
              <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">Result</th>
              <SortHeader label="P&L" active={filters.sort === "pnl"} dir={filters.dir} href={sortHref(base, filters, "pnl")} align="right" />
              <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">Confidence</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {filtered.slice(0, TABLE_LIMIT).map((b) => (
              <tr key={b.id} className="transition hover:bg-slate-800">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-slate-400">{b.date}</td>
                <td className="max-w-[220px] px-3 py-2">
                  <div className="truncate font-medium text-slate-100">{b.match}</div>
                  {b.score && <div className="font-mono text-[10px] text-slate-500">FT {b.score}</div>}
                </td>
                <td className="max-w-[140px] truncate px-3 py-2 text-[11px] text-slate-300">{b.league}</td>
                <td className="max-w-[180px] truncate px-3 py-2 text-[11px] text-slate-300">{b.market}</td>
                <td className="px-3 py-2">
                  <span className="whitespace-nowrap rounded border border-cyan-500/20 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[11px] font-bold text-cyan-200">
                    {b.selection}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-100">
                  {b.odds === null ? "—" : b.odds.toFixed(2)}
                </td>
                <td className="px-3 py-2 text-center">
                  <ResultBadge result={b.result} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[11px] font-bold">
                  {b.pnl === null ? (
                    <span className="text-slate-500">—</span>
                  ) : (
                    <span className={b.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{money(b.pnl)}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  <ConfidenceBadge value={b.confidence} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length > TABLE_LIMIT && (
        <p className="text-center text-[11px] text-slate-500">
          Showing the newest {TABLE_LIMIT} of {filtered.length} picks — the CSV export contains every row.
        </p>
      )}
    </>
  );
}

function sortHref(base: string, f: Filters, sort: Filters["sort"]): string {
  if (f.sort === sort) return hrefWith(base, f, { dir: f.dir === "desc" ? "asc" : "desc" });
  return hrefWith(base, f, { sort, dir: sort === "date" ? "desc" : "asc" });
}

// ─── Small UI pieces ──────────────────────────────────────────────────────────

const inputCls =
  "rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 focus:border-cyan-400/50 focus:outline-none";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function money(v: number): string {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: "neutral" | "positive" | "negative" | "info" }) {
  const valueColor =
    tone === "positive" ? "text-emerald-300" : tone === "negative" ? "text-rose-300" : tone === "info" ? "text-cyan-300" : "text-slate-100";
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
      <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">{label}</span>
      <div className={`mt-2 font-mono text-xl font-extrabold ${valueColor}`}>{value}</div>
      <div className="mt-1 text-[11px] text-slate-500">{sub}</div>
    </div>
  );
}

function StreakCard({ streak }: { streak: { count: number; type: "WIN" | "LOSS" | null } }) {
  return (
    <div className="flex flex-col justify-between rounded-xl border border-slate-700 bg-slate-900 p-4">
      <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Current Streak</span>
      <div className="mt-2 font-mono text-xl font-extrabold">
        {streak.count === 0 ? (
          <span className="text-slate-500">—</span>
        ) : (
          <span className={streak.type === "WIN" ? "text-emerald-300" : "text-rose-300"}>
            {streak.count} {streak.type === "WIN" ? "W" : "L"}
          </span>
        )}
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        {streak.count === 0 ? "no settled picks" : streak.type === "WIN" ? "winning run" : "losing run"}
      </div>
    </div>
  );
}

function Pill({ tone, children }: { tone: "win" | "loss" | "push" | "void" | "pending"; children: ReactNode }) {
  const cls =
    tone === "win" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : tone === "loss" ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
    : tone === "push" ? "border-slate-500/30 bg-slate-500/10 text-slate-300"
    : tone === "void" ? "border-violet-500/30 bg-violet-500/10 text-violet-300"
    : "border-amber-500/30 bg-amber-500/10 text-amber-300";
  return <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold ${cls}`}>{children}</span>;
}

function ResultBadge({ result }: { result: Result }) {
  const cls =
    result === "WIN" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : result === "LOSS" ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
    : result === "PUSH" ? "border-slate-500/30 bg-slate-500/10 text-slate-300"
    : result === "VOID" ? "border-violet-500/30 bg-violet-500/10 text-violet-300"
    : "border-amber-500/30 bg-amber-500/10 text-amber-300";
  const label = result === "PENDING" ? "⏳" : result;
  return <span className={`inline-block rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold ${cls}`}>{label}</span>;
}

function ConfidenceBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-slate-600">—</span>;
  const cls =
    value === "HIGH" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : value === "MEDIUM" ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-300"
    : "border-slate-500/30 bg-slate-500/10 text-slate-400";
  return <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold ${cls}`}>{value}</span>;
}

function ChartPanel({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-700 bg-slate-900 p-4">
      <div className="mb-3">
        <h3 className="text-sm font-bold text-slate-200">{title}</h3>
        <p className="text-[11px] text-slate-500">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function SortHeader({ label, active, dir, href, align = "left" }: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  href: string;
  align?: "left" | "right";
}) {
  return (
    <th className={`px-3 py-2.5 ${align === "right" ? "text-right" : "text-left"}`}>
      <Link href={href} className={`inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider transition ${active ? "text-cyan-300" : "text-slate-400 hover:text-slate-200"}`}>
        {label}
        {active ? (dir === "desc" ? "↓" : "↑") : ""}
      </Link>
    </th>
  );
}

// ─── Charts (hand-rolled SVG — no client JS needed) ───────────────────────────

function PnLChart({ points }: { points: TrendPoint[] }) {
  if (points.length === 0) {
    return <ChartEmpty text="No settled picks in this window yet." />;
  }
  const W = 640;
  const H = 170;
  const PAD = 10;
  const values = points.map((p) => p.value);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const x = (i: number) => (points.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (points.length - 1));
  const y = (v: number) => H - PAD - ((v - min) * (H - 2 * PAD)) / span;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const last = points[points.length - 1].value;
  const color = last >= 0 ? "#34d399" : "#fb7185";
  return (
    <div>
      <div className="mb-2 flex items-center justify-between font-mono text-xs">
        <span className="text-slate-400">
          {points[0].label} → {points[points.length - 1].label}
        </span>
        <span className={last >= 0 ? "text-emerald-300" : "text-rose-300"}>
          {money(last)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Cumulative P and L trend">
        <line x1={PAD} x2={W - PAD} y1={y(0)} y2={y(0)} stroke="#475569" strokeWidth={1} strokeDasharray="4 4" />
        <path d={area} fill={color} opacity={0.12} />
        <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(points.length - 1)} cy={y(last)} r={3.5} fill={color} />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
        <span>min {money(min)}</span>
        <span>max {money(max)}</span>
      </div>
    </div>
  );
}

function DailyHitRateChart({ points }: { points: DailyPoint[] }) {
  if (points.length === 0) {
    return <ChartEmpty text="No settled picks in this window yet." />;
  }
  const W = 640;
  const H = 170;
  const PAD = 10;
  const n = points.length;
  const slot = (W - 2 * PAD) / n;
  const bw = Math.min(28, slot * 0.7);
  const y = (rate: number) => H - PAD - rate * (H - 2 * PAD);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between font-mono text-xs text-slate-400">
        <span>{points.length} match day{points.length === 1 ? "" : "s"}</span>
        <span>
          {points.reduce((s, p) => s + p.hits, 0)}W / {points.reduce((s, p) => s + p.settled, 0)} settled
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Daily hit rate">
        <line x1={PAD} x2={W - PAD} y1={y(0.5)} y2={y(0.5)} stroke="#475569" strokeWidth={1} strokeDasharray="4 4" />
        {points.map((p, i) => {
          const cx = PAD + slot * i + slot / 2;
          if (p.rate === null) return null;
          const barTop = y(p.rate);
          const fill = p.rate >= 0.5 ? "#34d399" : p.rate > 0 ? "#fbbf24" : "#fb7185";
          return (
            <g key={p.label}>
              <rect
                x={cx - bw / 2}
                y={barTop}
                width={bw}
                height={Math.max(1.5, H - PAD - barTop)}
                rx={2}
                fill={fill}
                opacity={0.85}
              >
                <title>{`${p.label}: ${(p.rate * 100).toFixed(1)}% (${p.hits}/${p.settled})`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
        <span>{points[0].label}</span>
        <span>50% line · emerald ≥ 50%</span>
        <span>{points[points.length - 1].label}</span>
      </div>
    </div>
  );
}

function ChartEmpty({ text }: { text: string }) {
  return (
    <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-slate-700 text-xs text-slate-500">
      {text}
    </div>
  );
}
