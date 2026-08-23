// ĞIGI GIVØ — Ranking-mode performance analytics.
//
// Pure aggregation layer behind `/api/performance/modes`. Everything in this
// file is deterministic and side-effect free so it can be unit tested without
// a database: the API route loads rows from Postgres, normalises them into
// `ModeBet` records and hands them to `buildModeReport`.
//
// Transparency rules kept from the rest of the performance section:
//   · every aggregate is a plain sum/count over the underlying bets,
//   · nothing is simulated — missing data yields `null`, never a stand-in,
//   · percentages are PERCENT NUMBERS (62.5 === 62.5%), fractions (EV, model
//     probability) stay fractions and are formatted in the UI.

// ─── Core types ───────────────────────────────────────────────────────────────

export const RANKING_MODES = ["A", "B", "C", "D"] as const;
export type RankingModeKey = (typeof RANKING_MODES)[number];

export const MODE_META: Record<
  RankingModeKey,
  { key: RankingModeKey; short: string; label: string; description: string }
> = {
  A: {
    key: "A",
    short: "Classic A",
    label: "Rank A · Classic",
    description: "Classic 11-factor composite — the original calibration-led ranking.",
  },
  B: {
    key: "B",
    short: "12-Factor B",
    label: "Rank B · 12-Factor",
    description: "Balanced 12-factor composite with dynamic weight redistribution.",
  },
  C: {
    key: "C",
    short: "Hybrid C",
    label: "Rank C · Hybrid",
    description: "Hybrid ranking blending the classic and 12-factor composites.",
  },
  D: {
    key: "D",
    short: "Consensus D",
    label: "Rank D · Consensus",
    description: "Consensus ranking — picks agreed on by the other ranking modes.",
  },
};

export type BetResult = "WIN" | "LOSS" | "PUSH" | "VOID" | "PENDING";
export type BetSource = "pick" | "valueBet" | "slip";

export interface FactorContribution {
  factor: string;
  /** 0..1 contribution when the engine persisted one, else null (derived bucket). */
  contribution: number | null;
}

/** One tracked bet, normalised from any of the three logging tables. */
export interface ModeBet {
  id: string;
  /** YYYY-MM-DD (match date, or slip creation date for accumulators). */
  date: string;
  match: string;
  league: string;
  leagueSlug: string | null;
  market: string;
  selection: string;
  odds: number | null;
  result: BetResult;
  stake: number | null;
  pnl: number | null;
  returnAmount: number | null;
  /** Expected value as a fraction of stake (0.08 === +8% EV). */
  ev: number | null;
  /** Oracle model probability 0..1 when known. */
  modelProb: number | null;
  mode: RankingModeKey;
  source: BetSource;
  /** Position inside the Top 10 (1-based) when the bet came from a ranked pick. */
  rank: number | null;
  lowConfidence: boolean;
  factors: FactorContribution[];
  /** True when factors were bucketed from the market family (no persisted weights). */
  factorsDerived: boolean;
  eventId: string | null;
}

// ─── Small helpers ────────────────────────────────────────────────────────────

export function percent(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function isSettled(result: BetResult): boolean {
  return result === "WIN" || result === "LOSS";
}

/** Canonicalise any outcome string used across the codebase. */
export function toResult(raw: string | null | undefined): BetResult {
  const v = (raw ?? "").toString().trim().toUpperCase();
  if (v === "HIT" || v === "WON" || v === "WIN") return "WIN";
  if (v === "MISS" || v === "LOST" || v === "LOSS") return "LOSS";
  if (v === "PUSH") return "PUSH";
  if (v === "VOID" || v === "CANCELLED" || v === "CANCELED") return "VOID";
  return "PENDING";
}

export function toMode(raw: string | null | undefined): RankingModeKey | null {
  const v = (raw ?? "").toString().trim().toUpperCase();
  return (RANKING_MODES as readonly string[]).includes(v) ? (v as RankingModeKey) : null;
}

// ─── Factor bucketing ─────────────────────────────────────────────────────────
// Newer engine runs persist a `factors` map ({ "Poisson": 0.83, … }) on every
// stored pick. Older rows only carry the market family, so we fall back to a
// documented family → factor bucket mapping (identical wording to the league
// dashboard) and flag the result as derived so the UI can say so.

const DERIVED_FACTORS: Array<{ test: RegExp; factor: string }> = [
  { test: /corner/, factor: "Poisson λ (Corners)" },
  { test: /card|booking|penalt|sending off/, factor: "Poisson λ (Cards / Discipline)" },
  { test: /shot|sot|save/, factor: "Poisson λ (Shots / SOT / Saves)" },
  { test: /offside/, factor: "Poisson λ (Offsides)" },
  { test: /foul|tackle/, factor: "Tactical analysis" },
  { test: /goal|btts|clean sheet|score/, factor: "Poisson λ (Goals)" },
  { test: /result|chance|draw|win|handicap/, factor: "Match result / Double chance" },
  { test: /possession|pass|attack/, factor: "Deep statistical vector" },
];

export function deriveFactorBucket(name: string, family?: string | null): string {
  const haystack = `${name ?? ""} ${family ?? ""}`.toLowerCase();
  for (const entry of DERIVED_FACTORS) if (entry.test.test(haystack)) return entry.factor;
  return "Calibration";
}

export function factorsForPick(pick: {
  name?: string | null;
  family?: string | null;
  factors?: Record<string, number> | null;
}): { factors: FactorContribution[]; derived: boolean } {
  const raw = pick.factors;
  if (raw && typeof raw === "object") {
    const entries = Object.entries(raw)
      .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
      .map(([factor, contribution]) => ({ factor, contribution: round(contribution) }))
      .sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0));
    if (entries.length > 0) return { factors: entries, derived: false };
  }
  return {
    factors: [{ factor: deriveFactorBucket(pick.name ?? "", pick.family), contribution: null }],
    derived: true,
  };
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export interface StreakInfo {
  type: "WIN" | "LOSS" | null;
  count: number;
  label: string;
}

export interface ModeSummary {
  totalBets: number;
  settledBets: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  pending: number;
  /** Share of ALL tracked bets (percent). */
  winPct: number;
  lossPct: number;
  pushPct: number;
  voidPct: number;
  pendingPct: number;
  /** wins / (wins + losses) — the headline hit rate (percent). */
  hitRate: number;
  totalPnl: number;
  totalStake: number;
  totalReturn: number;
  /** P&L ÷ stake (percent), null when nothing was staked. */
  roi: number | null;
  /** P&L per settled bet (money), null without settled bets. */
  profitPerBet: number | null;
  averageStake: number | null;
  /** Stake-weighted average odds; falls back to the plain mean without stakes. */
  averageOdds: number | null;
  averageOddsUnweighted: number | null;
  /** Mean EV as a fraction of stake. */
  averageEv: number | null;
  /** Mean oracle probability of the settled bets. */
  averageModelProb: number | null;
  /** Actual hit rate − model expectation (percentage points; >0 = beat model). */
  calibrationDelta: number | null;
  /** Brier score over settled bets (lower is better). */
  brierScore: number | null;
  currentStreak: StreakInfo;
  longestWinStreak: number;
  longestLossStreak: number;
  /** Matches where all 10 ranked picks won. */
  tenOfTenHits: number;
  matchesTracked: number;
  perfectMatchRate: number;
  top1HitRate: number | null;
  top3HitRate: number | null;
  top10HitRate: number | null;
  /** Largest peak-to-trough drop of the cumulative P&L curve (money, ≥ 0). */
  maxDrawdown: number;
  bestDay: { date: string; pnl: number } | null;
  worstDay: { date: string; pnl: number } | null;
  profitableDays: number;
  losingDays: number;
  lowConfidenceBets: number;
  lowConfidenceHitRate: number | null;
  firstBetDate: string | null;
  lastBetDate: string | null;
  activeDays: number;
}

function streaks(bets: ModeBet[]): {
  current: StreakInfo;
  longestWin: number;
  longestLoss: number;
} {
  // Chronological, settled only.
  const settled = bets
    .filter((b) => isSettled(b.result))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  let longestWin = 0;
  let longestLoss = 0;
  let run = 0;
  let runType: "WIN" | "LOSS" | null = null;
  for (const bet of settled) {
    const type = bet.result as "WIN" | "LOSS";
    if (type === runType) run += 1;
    else {
      run = 1;
      runType = type;
    }
    if (type === "WIN") longestWin = Math.max(longestWin, run);
    else longestLoss = Math.max(longestLoss, run);
  }

  const label =
    runType === "WIN"
      ? `${run} Win${run === 1 ? "" : "s"}`
      : runType === "LOSS"
        ? `${run} Loss${run === 1 ? "" : "es"}`
        : "—";
  const current: StreakInfo = runType
    ? { type: runType, count: run, label }
    : { type: null, count: 0, label: "—" };

  return { current, longestWin, longestLoss };
}

export interface DailyPoint {
  date: string;
  bets: number;
  wins: number;
  losses: number;
  /** Percent — wins / (wins + losses) for that day. */
  hitRate: number;
  pnl: number;
  cumulativePnl: number;
  stake: number;
}

export function buildDailySeries(bets: ModeBet[]): DailyPoint[] {
  const byDay = new Map<string, { bets: number; wins: number; losses: number; pnl: number; stake: number }>();
  for (const bet of bets) {
    const day = byDay.get(bet.date) ?? { bets: 0, wins: 0, losses: 0, pnl: 0, stake: 0 };
    day.bets += 1;
    if (bet.result === "WIN") day.wins += 1;
    if (bet.result === "LOSS") day.losses += 1;
    day.pnl += bet.pnl ?? 0;
    day.stake += bet.stake ?? 0;
    byDay.set(bet.date, day);
  }
  let cumulative = 0;
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => {
      cumulative += d.pnl;
      return {
        date,
        bets: d.bets,
        wins: d.wins,
        losses: d.losses,
        hitRate: round(percent(d.wins, d.wins + d.losses), 2),
        pnl: round(d.pnl, 2),
        cumulativePnl: round(cumulative, 2),
        stake: round(d.stake, 2),
      };
    });
}

function drawdown(daily: DailyPoint[]): number {
  let peak = 0;
  let worst = 0;
  for (const point of daily) {
    peak = Math.max(peak, point.cumulativePnl);
    worst = Math.min(worst, point.cumulativePnl - peak);
  }
  return round(Math.abs(worst), 2);
}

function rankHitRate(bets: ModeBet[], predicate: (rank: number) => boolean): number | null {
  const scoped = bets.filter((b) => b.rank !== null && predicate(b.rank) && isSettled(b.result));
  if (scoped.length === 0) return null;
  return round(percent(scoped.filter((b) => b.result === "WIN").length, scoped.length), 2);
}

export function summarise(
  bets: ModeBet[],
  extras: { tenOfTenHits: number; matchesTracked: number },
): ModeSummary {
  const total = bets.length;
  const wins = bets.filter((b) => b.result === "WIN").length;
  const losses = bets.filter((b) => b.result === "LOSS").length;
  const pushes = bets.filter((b) => b.result === "PUSH").length;
  const voids = bets.filter((b) => b.result === "VOID").length;
  const pending = bets.filter((b) => b.result === "PENDING").length;
  const settled = wins + losses;

  const staked = bets.filter((b) => b.stake !== null && b.stake > 0);
  const totalStake = sum(staked.map((b) => b.stake ?? 0));
  const totalPnl = sum(bets.map((b) => b.pnl ?? 0));
  const totalReturn = sum(bets.map((b) => b.returnAmount ?? 0));

  const withOdds = bets.filter((b) => b.odds !== null && b.odds > 0);
  const stakeWeighted = withOdds.filter((b) => b.stake !== null && b.stake > 0);
  const stakeWeightSum = sum(stakeWeighted.map((b) => b.stake ?? 0));
  const averageOdds =
    stakeWeightSum > 0
      ? round(sum(stakeWeighted.map((b) => (b.odds ?? 0) * (b.stake ?? 0))) / stakeWeightSum, 3)
      : withOdds.length > 0
        ? round(sum(withOdds.map((b) => b.odds ?? 0)) / withOdds.length, 3)
        : null;

  const evs = bets.map((b) => b.ev).filter((v): v is number => v !== null);
  const settledBets = bets.filter((b) => isSettled(b.result));
  const probs = settledBets.map((b) => b.modelProb).filter((v): v is number => v !== null);
  const brierPool = settledBets.filter((b) => b.modelProb !== null);
  const hitRate = round(percent(wins, settled), 2);
  const averageModelProb = probs.length ? round(sum(probs) / probs.length, 4) : null;

  const daily = buildDailySeries(bets);
  const withPnlDays = daily.filter((d) => d.pnl !== 0);
  const bestDay = withPnlDays.length
    ? withPnlDays.reduce((a, b) => (b.pnl > a.pnl ? b : a))
    : null;
  const worstDay = withPnlDays.length
    ? withPnlDays.reduce((a, b) => (b.pnl < a.pnl ? b : a))
    : null;

  const lowConf = bets.filter((b) => b.lowConfidence);
  const lowConfSettled = lowConf.filter((b) => isSettled(b.result));

  const { current, longestWin, longestLoss } = streaks(bets);
  const dates = bets.map((b) => b.date).sort();

  return {
    totalBets: total,
    settledBets: settled,
    wins,
    losses,
    pushes,
    voids,
    pending,
    winPct: round(percent(wins, total), 2),
    lossPct: round(percent(losses, total), 2),
    pushPct: round(percent(pushes, total), 2),
    voidPct: round(percent(voids, total), 2),
    pendingPct: round(percent(pending, total), 2),
    hitRate,
    totalPnl: round(totalPnl, 2),
    totalStake: round(totalStake, 2),
    totalReturn: round(totalReturn, 2),
    roi: totalStake > 0 ? round(percent(totalPnl, totalStake), 2) : null,
    profitPerBet: settled > 0 && totalStake > 0 ? round(totalPnl / settled, 3) : null,
    averageStake: staked.length > 0 ? round(totalStake / staked.length, 2) : null,
    averageOdds,
    averageOddsUnweighted: withOdds.length
      ? round(sum(withOdds.map((b) => b.odds ?? 0)) / withOdds.length, 3)
      : null,
    averageEv: evs.length ? round(sum(evs) / evs.length, 4) : null,
    averageModelProb,
    calibrationDelta:
      averageModelProb !== null && settled > 0 ? round(hitRate - averageModelProb * 100, 2) : null,
    brierScore: brierPool.length
      ? round(
          sum(
            brierPool.map((b) => {
              const p = b.modelProb ?? 0;
              const actual = b.result === "WIN" ? 1 : 0;
              return (p - actual) ** 2;
            }),
          ) / brierPool.length,
          4,
        )
      : null,
    currentStreak: current,
    longestWinStreak: longestWin,
    longestLossStreak: longestLoss,
    tenOfTenHits: extras.tenOfTenHits,
    matchesTracked: extras.matchesTracked,
    perfectMatchRate: round(percent(extras.tenOfTenHits, extras.matchesTracked), 2),
    top1HitRate: rankHitRate(bets, (r) => r === 1),
    top3HitRate: rankHitRate(bets, (r) => r <= 3),
    top10HitRate: rankHitRate(bets, (r) => r <= 10),
    maxDrawdown: drawdown(daily),
    bestDay: bestDay ? { date: bestDay.date, pnl: bestDay.pnl } : null,
    worstDay: worstDay ? { date: worstDay.date, pnl: worstDay.pnl } : null,
    profitableDays: daily.filter((d) => d.pnl > 0).length,
    losingDays: daily.filter((d) => d.pnl < 0).length,
    lowConfidenceBets: lowConf.length,
    lowConfidenceHitRate: lowConfSettled.length
      ? round(percent(lowConfSettled.filter((b) => b.result === "WIN").length, lowConfSettled.length), 2)
      : null,
    firstBetDate: dates[0] ?? null,
    lastBetDate: dates[dates.length - 1] ?? null,
    activeDays: daily.length,
  };
}

// ─── Generic breakdowns ───────────────────────────────────────────────────────

export interface BreakdownRow {
  key: string;
  label: string;
  bets: number;
  wins: number;
  losses: number;
  pending: number;
  hitRate: number;
  pnl: number;
  stake: number;
  roi: number | null;
  averageOdds: number | null;
}

export function breakdownBy(
  bets: ModeBet[],
  keyFn: (bet: ModeBet) => { key: string; label: string } | null,
): BreakdownRow[] {
  const groups = new Map<string, { label: string; bets: ModeBet[] }>();
  for (const bet of bets) {
    const k = keyFn(bet);
    if (!k) continue;
    const group = groups.get(k.key) ?? { label: k.label, bets: [] };
    group.bets.push(bet);
    groups.set(k.key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const wins = group.bets.filter((b) => b.result === "WIN").length;
      const losses = group.bets.filter((b) => b.result === "LOSS").length;
      const pnl = sum(group.bets.map((b) => b.pnl ?? 0));
      const stake = sum(group.bets.map((b) => b.stake ?? 0));
      const withOdds = group.bets.filter((b) => b.odds !== null);
      return {
        key,
        label: group.label,
        bets: group.bets.length,
        wins,
        losses,
        pending: group.bets.filter((b) => b.result === "PENDING").length,
        hitRate: round(percent(wins, wins + losses), 2),
        pnl: round(pnl, 2),
        stake: round(stake, 2),
        roi: stake > 0 ? round(percent(pnl, stake), 2) : null,
        averageOdds: withOdds.length
          ? round(sum(withOdds.map((b) => b.odds ?? 0)) / withOdds.length, 3)
          : null,
      };
    })
    .sort((a, b) => b.bets - a.bets || b.hitRate - a.hitRate);
}

export interface FactorAccuracyRow {
  factor: string;
  hits: number;
  misses: number;
  totalBets: number;
  hitRate: number;
  /** Mean persisted contribution weight (0..1), null for derived buckets. */
  averageContribution: number | null;
  pnl: number;
  derived: boolean;
}

export function factorAccuracy(bets: ModeBet[]): FactorAccuracyRow[] {
  const map = new Map<
    string,
    { hits: number; misses: number; weights: number[]; pnl: number; derived: boolean }
  >();
  for (const bet of bets) {
    for (const f of bet.factors) {
      const entry =
        map.get(f.factor) ?? { hits: 0, misses: 0, weights: [], pnl: 0, derived: bet.factorsDerived };
      if (bet.result === "WIN") entry.hits += 1;
      if (bet.result === "LOSS") entry.misses += 1;
      if (f.contribution !== null) entry.weights.push(f.contribution);
      entry.pnl += bet.pnl ?? 0;
      entry.derived = entry.derived && bet.factorsDerived;
      map.set(f.factor, entry);
    }
  }
  return [...map.entries()]
    .map(([factor, e]) => ({
      factor,
      hits: e.hits,
      misses: e.misses,
      totalBets: e.hits + e.misses,
      hitRate: round(percent(e.hits, e.hits + e.misses), 2),
      averageContribution: e.weights.length ? round(sum(e.weights) / e.weights.length, 4) : null,
      pnl: round(e.pnl, 2),
      derived: e.derived,
    }))
    .sort((a, b) => b.totalBets - a.totalBets || b.hitRate - a.hitRate);
}

// ─── Odds / probability buckets ───────────────────────────────────────────────

const ODDS_BANDS: Array<{ key: string; label: string; min: number; max: number }> = [
  { key: "1.00-1.30", label: "1.00 – 1.30", min: 1, max: 1.3 },
  { key: "1.30-1.60", label: "1.30 – 1.60", min: 1.3, max: 1.6 },
  { key: "1.60-2.00", label: "1.60 – 2.00", min: 1.6, max: 2 },
  { key: "2.00-3.00", label: "2.00 – 3.00", min: 2, max: 3 },
  { key: "3.00+", label: "3.00+", min: 3, max: Number.POSITIVE_INFINITY },
];

export function oddsBands(bets: ModeBet[]): BreakdownRow[] {
  return breakdownBy(bets, (bet) => {
    if (bet.odds === null) return null;
    const band = ODDS_BANDS.find((b) => (bet.odds ?? 0) >= b.min && (bet.odds ?? 0) < b.max);
    return band ? { key: band.key, label: band.label } : null;
  }).sort((a, b) => a.key.localeCompare(b.key));
}

const CONFIDENCE_BANDS: Array<{ key: string; label: string; min: number }> = [
  { key: "95", label: "≥ 95% model", min: 0.95 },
  { key: "90", label: "90 – 95%", min: 0.9 },
  { key: "85", label: "85 – 90%", min: 0.85 },
  { key: "75", label: "75 – 85%", min: 0.75 },
  { key: "00", label: "< 75%", min: 0 },
];

export function confidenceBands(bets: ModeBet[]): BreakdownRow[] {
  return breakdownBy(bets, (bet) => {
    if (bet.modelProb === null) return null;
    const band = CONFIDENCE_BANDS.find((b) => (bet.modelProb ?? 0) >= b.min);
    return band ? { key: band.key, label: band.label } : null;
  }).sort((a, b) => b.key.localeCompare(a.key));
}

export function rankBuckets(bets: ModeBet[]): BreakdownRow[] {
  return breakdownBy(bets, (bet) => {
    if (bet.rank === null) return null;
    if (bet.rank === 1) return { key: "1", label: "Top 1" };
    if (bet.rank <= 3) return { key: "2", label: "Top 2 – 3" };
    if (bet.rank <= 5) return { key: "3", label: "Top 4 – 5" };
    return { key: "4", label: "Top 6 – 10" };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

// ─── Windowed sub-summaries ───────────────────────────────────────────────────

export interface WindowSummary {
  key: "7d" | "30d" | "all";
  label: string;
  bets: number;
  wins: number;
  losses: number;
  hitRate: number;
  pnl: number;
  roi: number | null;
  series: DailyPoint[];
}

/** ISO day string N days before `reference` (inclusive window boundary). */
export function dayOffset(reference: Date, days: number): string {
  const d = new Date(reference.getTime());
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function buildWindows(bets: ModeBet[], now: Date): WindowSummary[] {
  const specs: Array<{ key: WindowSummary["key"]; label: string; days: number | null }> = [
    { key: "7d", label: "Last 7 days", days: 7 },
    { key: "30d", label: "Last 30 days", days: 30 },
    { key: "all", label: "All time", days: null },
  ];
  return specs.map((spec) => {
    const since = spec.days === null ? null : dayOffset(now, spec.days);
    const scoped = since ? bets.filter((b) => b.date >= since) : bets;
    const wins = scoped.filter((b) => b.result === "WIN").length;
    const losses = scoped.filter((b) => b.result === "LOSS").length;
    const pnl = sum(scoped.map((b) => b.pnl ?? 0));
    const stake = sum(scoped.map((b) => b.stake ?? 0));
    return {
      key: spec.key,
      label: spec.label,
      bets: scoped.length,
      wins,
      losses,
      hitRate: round(percent(wins, wins + losses), 2),
      pnl: round(pnl, 2),
      roi: stake > 0 ? round(percent(pnl, stake), 2) : null,
      series: buildDailySeries(scoped),
    };
  });
}

// ─── Full per-mode report ─────────────────────────────────────────────────────

export interface ModeReport {
  mode: RankingModeKey;
  label: string;
  short: string;
  description: string;
  summary: ModeSummary;
  windows: WindowSummary[];
  daily: DailyPoint[];
  factorAccuracy: FactorAccuracyRow[];
  markets: BreakdownRow[];
  leagues: BreakdownRow[];
  oddsBands: BreakdownRow[];
  confidenceBands: BreakdownRow[];
  rankBuckets: BreakdownRow[];
  sources: BreakdownRow[];
  bets: ModeBet[];
}

export function buildModeReport(
  mode: RankingModeKey,
  bets: ModeBet[],
  extras: { tenOfTenHits: number; matchesTracked: number; now?: Date },
): ModeReport {
  const now = extras.now ?? new Date();
  const ordered = [...bets].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const meta = MODE_META[mode];
  return {
    mode,
    label: meta.label,
    short: meta.short,
    description: meta.description,
    summary: summarise(ordered, extras),
    windows: buildWindows(ordered, now),
    daily: buildDailySeries(ordered),
    factorAccuracy: factorAccuracy(ordered),
    markets: breakdownBy(ordered, (bet) => ({ key: bet.market, label: bet.market })),
    leagues: breakdownBy(ordered, (bet) => ({
      key: bet.leagueSlug ?? bet.league,
      label: bet.league,
    })),
    oddsBands: oddsBands(ordered),
    confidenceBands: confidenceBands(ordered),
    rankBuckets: rankBuckets(ordered),
    sources: breakdownBy(ordered, (bet) => ({
      key: bet.source,
      label:
        bet.source === "pick" ? "Ranked picks" : bet.source === "valueBet" ? "Value bets" : "Accumulator slips",
    })),
    bets: ordered,
  };
}

// ─── Mode comparison ──────────────────────────────────────────────────────────

export type ComparisonMetricKey =
  | "hitRate"
  | "roi"
  | "totalPnl"
  | "tenOfTenHits"
  | "averageOdds"
  | "totalBets"
  | "averageEv";

export interface ComparisonRow {
  mode: RankingModeKey;
  label: string;
  short: string;
  totalBets: number;
  hitRate: number;
  roi: number | null;
  totalPnl: number;
  tenOfTenHits: number;
  averageOdds: number | null;
  averageEv: number | null;
  currentStreak: string;
  /** Metrics on which this mode is the best of the four. */
  bestIn: ComparisonMetricKey[];
}

const COMPARISON_METRICS: ComparisonMetricKey[] = [
  "hitRate",
  "roi",
  "totalPnl",
  "tenOfTenHits",
  "averageOdds",
  "totalBets",
  "averageEv",
];

export function buildComparison(reports: ModeReport[]): ComparisonRow[] {
  const rows: ComparisonRow[] = reports.map((r) => ({
    mode: r.mode,
    label: r.label,
    short: r.short,
    totalBets: r.summary.totalBets,
    hitRate: r.summary.hitRate,
    roi: r.summary.roi,
    totalPnl: r.summary.totalPnl,
    tenOfTenHits: r.summary.tenOfTenHits,
    averageOdds: r.summary.averageOdds,
    averageEv: r.summary.averageEv,
    currentStreak: r.summary.currentStreak.label,
    bestIn: [],
  }));

  for (const metric of COMPARISON_METRICS) {
    // Only modes with tracked bets can win a metric — an empty mode is not "best".
    const candidates = rows.filter((r) => r.totalBets > 0 && r[metric] !== null);
    if (candidates.length === 0) continue;
    const best = Math.max(...candidates.map((r) => (r[metric] as number) ?? 0));
    if (best <= 0 && metric !== "averageEv") continue;
    for (const row of candidates) if (((row[metric] as number) ?? 0) === best) row.bestIn.push(metric);
  }
  return rows;
}

// ─── Row normalisers (DB shape → ModeBet) ─────────────────────────────────────

export interface StoredPick {
  name?: string | null;
  selection?: string | null;
  outcome?: string | null;
  family?: string | null;
  hitRate?: number | null;
  odds?: number | null;
  ev?: number | null;
  factors?: Record<string, number> | null;
}

export interface PerformanceLogLike {
  id: number;
  eventId: string;
  matchLabel: string;
  league: string;
  leagueSlug: string | null;
  competitionName: string | null;
  matchDate: string;
  rankingMode: string;
  lowConfidence?: boolean | null;
  top10Detail: unknown;
}

export interface ValueBetLogLike {
  id: number;
  eventId: string;
  match: string;
  matchDate: string;
  leagueSlug: string;
  competitionName: string | null;
  marketName: string;
  selection: string;
  oracleProb: number;
  bookOdds: number;
  valueEdge: number;
  stake: number;
  potentialReturn: number;
  actualReturn: number | null;
  pnl: number | null;
  outcome: string;
  lowConfidence?: boolean | null;
  rankingMode: string;
}

export interface SavedSlipLike {
  id: number;
  name: string;
  leagueSlug: string | null;
  competitionName: string | null;
  picks: unknown;
  combinedOdds: number;
  combinedProb: number;
  stake: number | null;
  status: string;
  createdAt: Date;
  /** Present once the column exists on the table; also read from the picks JSON. */
  rankingMode?: string | null;
}

/** Ranked picks stored on a settled match row. */
export function betsFromPerformanceRow(row: PerformanceLogLike): ModeBet[] {
  const mode = toMode(row.rankingMode) ?? "B";
  const picks = Array.isArray(row.top10Detail) ? (row.top10Detail as StoredPick[]) : [];
  return picks.map((pick, index) => {
    const { factors, derived } = factorsForPick(pick);
    return {
      id: `perf-${row.id}-${index}`,
      date: row.matchDate,
      match: row.matchLabel,
      league: row.competitionName ?? row.league,
      leagueSlug: row.leagueSlug,
      market: pick.name ?? "Ranked pick",
      selection: pick.selection ?? pick.name ?? "—",
      odds: typeof pick.odds === "number" ? pick.odds : null,
      result: toResult(pick.outcome),
      stake: null,
      pnl: null,
      returnAmount: null,
      ev: typeof pick.ev === "number" ? pick.ev : null,
      modelProb: typeof pick.hitRate === "number" ? pick.hitRate : null,
      mode,
      source: "pick",
      rank: index + 1,
      lowConfidence: Boolean(row.lowConfidence),
      factors,
      factorsDerived: derived,
      eventId: row.eventId,
    };
  });
}

/** Value bets carry real stake / P&L, so they drive the money metrics. */
export function betFromValueBetRow(row: ValueBetLogLike): ModeBet {
  const result = toResult(row.outcome);
  const { factors, derived } = factorsForPick({ name: row.marketName });
  return {
    id: `vb-${row.id}`,
    date: row.matchDate,
    match: row.match,
    league: row.competitionName ?? row.leagueSlug,
    leagueSlug: row.leagueSlug,
    market: row.marketName,
    selection: row.selection,
    odds: row.bookOdds,
    result,
    stake: row.stake,
    pnl:
      row.pnl ??
      (result === "WIN"
        ? round(row.stake * (row.bookOdds - 1), 2)
        : result === "LOSS"
          ? -row.stake
          : result === "PUSH" || result === "VOID"
            ? 0
            : null),
    returnAmount: row.actualReturn ?? (result === "WIN" ? round(row.stake * row.bookOdds, 2) : null),
    ev: round(row.oracleProb * row.bookOdds - 1, 4),
    modelProb: row.oracleProb,
    mode: toMode(row.rankingMode) ?? "B",
    source: "valueBet",
    rank: null,
    lowConfidence: Boolean(row.lowConfidence),
    factors,
    factorsDerived: derived,
    eventId: row.eventId,
  };
}

/**
 * Accumulator slips. The ranking mode comes from the `ranking_mode` column when
 * the deployment has it, otherwise from the mode persisted inside the picks
 * JSON. Slips without any attribution are skipped (never guessed).
 */
export function betFromSlipRow(row: SavedSlipLike): ModeBet | null {
  const picks = Array.isArray(row.picks) ? (row.picks as Array<{ rankingMode?: string }>) : [];
  const mode = toMode(row.rankingMode) ?? toMode(picks[0]?.rankingMode);
  if (!mode) return null;
  const result = toResult(row.status);
  const stake = row.stake ?? null;
  const pnl =
    stake === null
      ? null
      : result === "WIN"
        ? round(stake * (row.combinedOdds - 1), 2)
        : result === "LOSS"
          ? -stake
          : result === "PUSH" || result === "VOID"
            ? 0
            : null;
  return {
    id: `slip-${row.id}`,
    date: row.createdAt.toISOString().slice(0, 10),
    match: row.name,
    league: row.competitionName ?? row.leagueSlug ?? "Multi-competition",
    leagueSlug: row.leagueSlug,
    market: `Accumulator (${picks.length || "—"} legs)`,
    selection: "All legs win",
    odds: row.combinedOdds,
    result,
    stake,
    pnl,
    returnAmount: result === "WIN" && stake !== null ? round(stake * row.combinedOdds, 2) : null,
    ev: row.combinedProb > 0 ? round(row.combinedProb * row.combinedOdds - 1, 4) : null,
    modelProb: row.combinedProb,
    mode,
    source: "slip",
    rank: null,
    lowConfidence: false,
    factors: [{ factor: "Accumulator consensus", contribution: null }],
    factorsDerived: true,
    eventId: null,
  };
}

/** Matches where every one of the 10 ranked picks won. */
export function perfectMatch(row: PerformanceLogLike): boolean {
  const picks = Array.isArray(row.top10Detail) ? (row.top10Detail as StoredPick[]) : [];
  return picks.length === 10 && picks.every((p) => toResult(p.outcome) === "WIN");
}

// ─── Filtering ────────────────────────────────────────────────────────────────

export interface BetFilters {
  from?: string | null;
  to?: string | null;
  league?: string | null;
  result?: string | null;
  source?: string | null;
  search?: string | null;
}

export function applyFilters(bets: ModeBet[], filters: BetFilters): ModeBet[] {
  const league = filters.league?.trim().toLowerCase() ?? "";
  const result = filters.result?.trim().toUpperCase() ?? "";
  const source = filters.source?.trim() ?? "";
  const search = filters.search?.trim().toLowerCase() ?? "";
  return bets.filter((bet) => {
    if (filters.from && bet.date < filters.from) return false;
    if (filters.to && bet.date > filters.to) return false;
    if (league && !`${bet.league} ${bet.leagueSlug ?? ""}`.toLowerCase().includes(league)) return false;
    if (result && result !== "ALL" && bet.result !== result) return false;
    if (source && source !== "all" && bet.source !== source) return false;
    if (search && !`${bet.match} ${bet.market} ${bet.selection}`.toLowerCase().includes(search))
      return false;
    return true;
  });
}
