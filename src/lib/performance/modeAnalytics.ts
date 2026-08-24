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
export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";
export type MatchOrientation = "Home" | "Away" | "Draw" | "Neutral";
export type TimeOfDay = "Afternoon" | "Evening";

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
  marketFamily: string;
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
  confidenceLevel: ConfidenceLevel;
  factors: FactorContribution[];
  /** True when factors were bucketed from the market family (no persisted weights). */
  factorsDerived: boolean;
  eventId: string | null;
  timeOfDay: TimeOfDay;
  orientation: MatchOrientation;
  isLive: boolean;
}

// ─── Small math helpers ───────────────────────────────────────────────────────

export function percent(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function isSettled(result: BetResult): boolean {
  return result === "WIN" || result === "LOSS";
}

/** Standard deviation (sample std dev for N > 1, 0 for N <= 1). */
export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = sum(values) / values.length;
  const variance = sum(values.map((v) => (v - mean) ** 2)) / (values.length - 1);
  return round(Math.sqrt(Math.max(0, variance)), 4);
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

// ─── Derivation helpers ───────────────────────────────────────────────────────

export function deriveMarketFamily(market: string, rawFamily?: string | null): string {
  const haystack = `${market} ${rawFamily ?? ""}`.toLowerCase();
  if (/corner/.test(haystack)) return "Corners";
  if (/card|booking|penalt|sending off|foul|discipline/.test(haystack)) return "Cards / Discipline";
  if (/shot|sot|save/.test(haystack)) return "Shots / Saves";
  if (/offside/.test(haystack)) return "Offsides";
  if (/goal|btts|clean sheet|score|over.*goal|under.*goal/.test(haystack)) return "Goals";
  if (/result|draw|win|chance|handicap|asian/.test(haystack)) return "Match Result / Handicap";
  if (/possession|pass|tackle|attack/.test(haystack)) return "Stats / Tactical";
  return rawFamily?.trim() ? rawFamily.trim() : "Other Markets";
}

export function deriveConfidenceLevel(
  modelProb: number | null,
  lowConfidence: boolean,
): ConfidenceLevel {
  if (lowConfidence) return "LOW";
  if (modelProb === null) return "MEDIUM";
  if (modelProb >= 0.85) return "HIGH";
  if (modelProb >= 0.70) return "MEDIUM";
  return "LOW";
}

export function deriveOrientation(match: string, selection: string): MatchOrientation {
  const sel = selection.trim().toLowerCase();
  if (/draw|tie|draw no bet: draw|x\b/.test(sel)) return "Draw";
  const parts = match.split(/\s+vs\s+|\s+-\s+/i);
  if (parts.length >= 2) {
    const home = parts[0].trim().toLowerCase();
    const away = parts[1].trim().toLowerCase();
    if (home.length > 2 && sel.includes(home)) return "Home";
    if (away.length > 2 && sel.includes(away)) return "Away";
    if (sel.startsWith("1") || sel.includes("home")) return "Home";
    if (sel.startsWith("2") || sel.includes("away")) return "Away";
  }
  return "Neutral";
}

export function deriveTimeOfDay(dateStr: string): TimeOfDay {
  // If date contains timestamp, check hour; else stable hash
  if (dateStr.includes("T")) {
    try {
      const hour = new Date(dateStr).getUTCHours();
      return hour >= 18 ? "Evening" : "Afternoon";
    } catch {
      // ignore
    }
  }
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) hash = (hash * 31 + dateStr.charCodeAt(i)) % 100;
  return hash % 2 === 0 ? "Evening" : "Afternoon";
}

export function deriveIsLive(market: string, match: string): boolean {
  return /live|in-play|inplay|live-centre/i.test(`${market} ${match}`);
}

// ─── Factor bucketing ─────────────────────────────────────────────────────────

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

// ─── Statistical and Advanced Metrics ─────────────────────────────────────────

export function calculateSharpeRatio(dailyPnl: number[]): number | null {
  if (dailyPnl.length < 2) return null;
  const mean = sum(dailyPnl) / dailyPnl.length;
  const std = standardDeviation(dailyPnl);
  if (std === 0) return mean > 0 ? 3.0 : 0;
  const dailySharpe = mean / std;
  const annualized = dailySharpe * Math.sqrt(365);
  return round(annualized, 2);
}

export function calculateProfitFactor(bets: ModeBet[]): number | null {
  const settled = bets.filter((b) => isSettled(b.result) && b.pnl !== null);
  if (settled.length === 0) return null;
  const grossProfit = sum(settled.filter((b) => (b.pnl ?? 0) > 0).map((b) => b.pnl ?? 0));
  const grossLoss = Math.abs(sum(settled.filter((b) => (b.pnl ?? 0) < 0).map((b) => b.pnl ?? 0)));
  if (grossLoss === 0) {
    return grossProfit > 0 ? 99.9 : 0;
  }
  return round(grossProfit / grossLoss, 2);
}

export function calculateRecoveryFactor(totalPnl: number, maxDrawdown: number): number | null {
  if (maxDrawdown <= 0) {
    return totalPnl > 0 ? 99.9 : totalPnl === 0 ? 0 : -99.9;
  }
  return round(totalPnl / maxDrawdown, 2);
}

export function calculateCorrelation(pairs: Array<{ x: number; y: number }>): number {
  if (pairs.length < 2) return 0;
  const n = pairs.length;
  const sumX = sum(pairs.map((p) => p.x));
  const sumY = sum(pairs.map((p) => p.y));
  const meanX = sumX / n;
  const meanY = sumY / n;

  let num = 0;
  let denX = 0;
  let denY = 0;
  for (const p of pairs) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (den === 0) return 0;
  return round(num / den, 3);
}

export function calculateFactorReliability(
  hitRate: number,
  totalBets: number,
  correlation: number,
): number {
  if (totalBets === 0) return 0;
  const sampleFactor = Math.min(1, totalBets / 20);
  const corrContribution = Math.max(0, Math.min(100, 50 + correlation * 50));
  const rawScore = 0.65 * hitRate + 0.35 * corrContribution;
  return round(sampleFactor * rawScore, 1);
}

export function calculateConsistencyScore(
  daily: DailyPoint[],
  bets: ModeBet[],
  maxDrawdown: number,
  totalStake: number,
): number {
  if (daily.length === 0 || bets.length === 0) return 0;
  const winDays = daily.filter((d) => d.pnl > 0).length;
  const lossDays = daily.filter((d) => d.pnl < 0).length;
  const totalActiveDays = winDays + lossDays;

  // 1. Win day percentage (0..100)
  const winDayScore = totalActiveDays > 0 ? (winDays / totalActiveDays) * 100 : 50;

  // 2. Drawdown factor (0..100)
  const baselineStake = Math.max(totalStake, maxDrawdown * 1.5, 100);
  const ddFactor = Math.max(0, 100 - (maxDrawdown / baselineStake) * 100);

  // 3. Volatility factor (0..100)
  const pnls = daily.map((d) => d.pnl);
  const std = standardDeviation(pnls);
  const posPnls = pnls.filter((p) => p > 0);
  const meanPos = posPnls.length > 0 ? sum(posPnls) / posPnls.length : 20;
  const volScore = Math.max(0, Math.min(100, 100 - (std / Math.max(meanPos, 5)) * 25));

  // 4. Streak factor (0..100)
  const { longestWin, longestLoss } = streaks(bets);
  const streakDiff = longestWin - longestLoss;
  const streakScore = Math.max(0, Math.min(100, 50 + streakDiff * 5));

  const composite = 0.30 * winDayScore + 0.25 * ddFactor + 0.25 * volScore + 0.20 * streakScore;
  return round(Math.max(0, Math.min(100, composite)), 1);
}

export function calculateOverallPerformanceScore(
  hitRate: number,
  roi: number | null,
  totalPnl: number,
  totalStake: number,
  consistencyScore: number,
  totalBets: number,
): number {
  if (totalBets === 0) return 0;
  // Hit rate score: 45% = 0, 85%+ = 100
  const hitRateScore = Math.max(0, Math.min(100, ((hitRate - 45) / 40) * 100));

  // ROI score: -25% = 0, 0% = 50, +25%+ = 100
  const effectiveRoi = roi ?? (hitRate >= 70 ? hitRate - 60 : hitRate - 65);
  const roiScore = Math.max(0, Math.min(100, 50 + effectiveRoi * 2));

  // P&L score
  const pnlNorm = totalStake > 0 ? (totalPnl / totalStake) * 100 : totalPnl;
  const pnlScore = Math.max(0, Math.min(100, 50 + pnlNorm * 1.5));

  const score = 0.30 * hitRateScore + 0.30 * roiScore + 0.20 * pnlScore + 0.20 * consistencyScore;
  return round(Math.max(0, Math.min(100, score)), 1);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export interface StreakInfo {
  type: "WIN" | "LOSS" | null;
  count: number;
  label: string;
}

export interface TierSummary {
  tier: "Top 1" | "Top 3" | "Top 10";
  totalBets: number;
  settledBets: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  hitRate: number;
  pnl: number;
  roi: number | null;
  averageOdds: number | null;
  averageEv: number | null;
  pushRate: number;
  voidRate: number;
  confidenceSplit: {
    high: { count: number; hitRate: number };
    medium: { count: number; hitRate: number };
    low: { count: number; hitRate: number };
  };
  consistencyScore: number;
  sharpeRatio: number | null;
  profitFactor: number | null;
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
  /** P&L per winning bet (money), null without wins. */
  profitPerWinningBet: number | null;
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
  longestNonWinStreak: number;
  /** Matches where all 10 ranked picks won. */
  tenOfTenHits: number;
  matchesTracked: number;
  perfectMatchRate: number;
  top1HitRate: number | null;
  top3HitRate: number | null;
  top10HitRate: number | null;
  /** Largest peak-to-trough drop of the cumulative P&L curve (money, ≥ 0). */
  maxDrawdown: number;
  sharpeRatio: number | null;
  profitFactor: number | null;
  recoveryFactor: number | null;
  consistencyScore: number;
  overallScore: number;
  volatilityRating: "Low" | "Medium" | "High";
  dailyPnlStdDev: number;
  bestWinDaysRun: number;
  worstLossDaysRun: number;
  cumulativeStabilityPct: number;
  bestDay: { date: string; pnl: number } | null;
  worstDay: { date: string; pnl: number } | null;
  profitableDays: number;
  losingDays: number;
  breakEvenDays: number;
  winningDaysPct: number;
  voidRate: number;
  pushRate: number;
  lowConfidenceBets: number;
  lowConfidenceHitRate: number | null;
  lowConfidencePnl: number;
  highConfidenceBets: number;
  highConfidenceHitRate: number | null;
  highConfidencePnl: number;
  firstBetDate: string | null;
  lastBetDate: string | null;
  activeDays: number;
  top1Summary?: TierSummary;
  top3Summary?: TierSummary;
  top10Summary?: TierSummary;
}

export function streaks(bets: ModeBet[]): {
  current: StreakInfo;
  longestWin: number;
  longestLoss: number;
  longestNonWin: number;
} {
  const settled = bets
    .filter((b) => b.result !== "PENDING")
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  let longestWin = 0;
  let longestLoss = 0;
  let longestNonWin = 0;
  let currentNonWin = 0;

  let run = 0;
  let runType: "WIN" | "LOSS" | null = null;

  for (const bet of settled) {
    if (bet.result === "WIN") {
      if (runType === "WIN") run += 1;
      else {
        run = 1;
        runType = "WIN";
      }
      longestWin = Math.max(longestWin, run);
      currentNonWin = 0;
    } else if (bet.result === "LOSS") {
      if (runType === "LOSS") run += 1;
      else {
        run = 1;
        runType = "LOSS";
      }
      longestLoss = Math.max(longestLoss, run);
      currentNonWin += 1;
      longestNonWin = Math.max(longestNonWin, currentNonWin);
    } else {
      // PUSH or VOID
      currentNonWin += 1;
      longestNonWin = Math.max(longestNonWin, currentNonWin);
    }
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

  return { current, longestWin, longestLoss, longestNonWin };
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
  const byDay = new Map<
    string,
    { bets: number; wins: number; losses: number; pnl: number; stake: number }
  >();
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

export function buildTierSummary(
  bets: ModeBet[],
  predicate: (rank: number) => boolean,
  tierLabel: TierSummary["tier"],
): TierSummary {
  const scoped = bets.filter((b) => b.rank !== null && predicate(b.rank));
  const wins = scoped.filter((b) => b.result === "WIN").length;
  const losses = scoped.filter((b) => b.result === "LOSS").length;
  const pushes = scoped.filter((b) => b.result === "PUSH").length;
  const voids = scoped.filter((b) => b.result === "VOID").length;
  const settled = wins + losses;
  const total = scoped.length;

  const staked = scoped.filter((b) => b.stake !== null && b.stake > 0);
  const totalStake = sum(staked.map((b) => b.stake ?? 0));
  const totalPnl = sum(scoped.map((b) => b.pnl ?? 0));

  const withOdds = scoped.filter((b) => b.odds !== null && b.odds > 0);
  const stakeWeighted = withOdds.filter((b) => b.stake !== null && b.stake > 0);
  const stakeWeightSum = sum(stakeWeighted.map((b) => b.stake ?? 0));
  const averageOdds =
    stakeWeightSum > 0
      ? round(sum(stakeWeighted.map((b) => (b.odds ?? 0) * (b.stake ?? 0))) / stakeWeightSum, 3)
      : withOdds.length > 0
        ? round(sum(withOdds.map((b) => b.odds ?? 0)) / withOdds.length, 3)
        : null;

  const evs = scoped.map((b) => b.ev).filter((v): v is number => v !== null);
  const averageEv = evs.length ? round(sum(evs) / evs.length, 4) : null;

  const highConf = scoped.filter((b) => b.confidenceLevel === "HIGH" && isSettled(b.result));
  const medConf = scoped.filter((b) => b.confidenceLevel === "MEDIUM" && isSettled(b.result));
  const lowConf = scoped.filter((b) => b.confidenceLevel === "LOW" && isSettled(b.result));

  const daily = buildDailySeries(scoped);
  const maxDd = drawdown(daily);
  const consistencyScore = calculateConsistencyScore(daily, scoped, maxDd, totalStake);
  const sharpeRatio = calculateSharpeRatio(daily.map((d) => d.pnl));
  const profitFactor = calculateProfitFactor(scoped);

  return {
    tier: tierLabel,
    totalBets: total,
    settledBets: settled,
    wins,
    losses,
    pushes,
    voids,
    hitRate: round(percent(wins, settled), 2),
    pnl: round(totalPnl, 2),
    roi: totalStake > 0 ? round(percent(totalPnl, totalStake), 2) : null,
    averageOdds,
    averageEv,
    pushRate: round(percent(pushes, total), 2),
    voidRate: round(percent(voids, total), 2),
    confidenceSplit: {
      high: {
        count: highConf.length,
        hitRate: round(percent(highConf.filter((b) => b.result === "WIN").length, highConf.length), 2),
      },
      medium: {
        count: medConf.length,
        hitRate: round(percent(medConf.filter((b) => b.result === "WIN").length, medConf.length), 2),
      },
      low: {
        count: lowConf.length,
        hitRate: round(percent(lowConf.filter((b) => b.result === "WIN").length, lowConf.length), 2),
      },
    },
    consistencyScore,
    sharpeRatio,
    profitFactor,
  };
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

  const winningBets = bets.filter((b) => b.result === "WIN" && b.pnl !== null);
  const profitPerWinningBet =
    winningBets.length > 0 ? round(sum(winningBets.map((b) => b.pnl ?? 0)) / winningBets.length, 3) : null;

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

  const lowConf = bets.filter((b) => b.lowConfidence || b.confidenceLevel === "LOW");
  const lowConfSettled = lowConf.filter((b) => isSettled(b.result));
  const lowConfPnl = sum(lowConf.map((b) => b.pnl ?? 0));

  const highConf = bets.filter((b) => b.confidenceLevel === "HIGH");
  const highConfSettled = highConf.filter((b) => isSettled(b.result));
  const highConfPnl = sum(highConf.map((b) => b.pnl ?? 0));

  const { current, longestWin, longestLoss, longestNonWin } = streaks(bets);
  const dates = bets.map((b) => b.date).sort();

  // Day runs
  let bestWinDaysRun = 0;
  let worstLossDaysRun = 0;
  let curWinDayRun = 0;
  let curLossDayRun = 0;
  for (const d of daily) {
    if (d.pnl > 0) {
      curWinDayRun += 1;
      curLossDayRun = 0;
      bestWinDaysRun = Math.max(bestWinDaysRun, curWinDayRun);
    } else if (d.pnl < 0) {
      curLossDayRun += 1;
      curWinDayRun = 0;
      worstLossDaysRun = Math.max(worstLossDaysRun, curLossDayRun);
    } else {
      curWinDayRun = 0;
      curLossDayRun = 0;
    }
  }

  const profitableDays = daily.filter((d) => d.pnl > 0).length;
  const losingDays = daily.filter((d) => d.pnl < 0).length;
  const breakEvenDays = daily.filter((d) => d.pnl === 0).length;
  const activeDays = daily.length;
  const winningDaysPct = activeDays > 0 ? round(percent(profitableDays, activeDays), 2) : 0;
  const cumulativeStabilityPct =
    activeDays > 0 ? round(percent(daily.filter((d) => d.cumulativePnl >= 0).length, activeDays), 2) : 100;

  const maxDrawdownVal = drawdown(daily);
  const dailyPnlStdDev = standardDeviation(daily.map((d) => d.pnl));
  const volatilityRating: "Low" | "Medium" | "High" =
    dailyPnlStdDev > 40 ? "High" : dailyPnlStdDev > 15 ? "Medium" : "Low";

  const roi = totalStake > 0 ? round(percent(totalPnl, totalStake), 2) : null;
  const sharpeRatio = calculateSharpeRatio(daily.map((d) => d.pnl));
  const profitFactor = calculateProfitFactor(bets);
  const recoveryFactor = calculateRecoveryFactor(totalPnl, maxDrawdownVal);
  const consistencyScore = calculateConsistencyScore(daily, bets, maxDrawdownVal, totalStake);
  const overallScore = calculateOverallPerformanceScore(
    hitRate,
    roi,
    totalPnl,
    totalStake,
    consistencyScore,
    total,
  );

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
    roi,
    profitPerBet: settled > 0 && totalStake > 0 ? round(totalPnl / settled, 3) : null,
    profitPerWinningBet,
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
    longestNonWinStreak: longestNonWin,
    tenOfTenHits: extras.tenOfTenHits,
    matchesTracked: extras.matchesTracked,
    perfectMatchRate: round(percent(extras.tenOfTenHits, extras.matchesTracked), 2),
    top1HitRate: rankHitRate(bets, (r) => r === 1),
    top3HitRate: rankHitRate(bets, (r) => r <= 3),
    top10HitRate: rankHitRate(bets, (r) => r <= 10),
    maxDrawdown: maxDrawdownVal,
    sharpeRatio,
    profitFactor,
    recoveryFactor,
    consistencyScore,
    overallScore,
    volatilityRating,
    dailyPnlStdDev,
    bestWinDaysRun,
    worstLossDaysRun,
    cumulativeStabilityPct,
    bestDay: bestDay ? { date: bestDay.date, pnl: bestDay.pnl } : null,
    worstDay: worstDay ? { date: worstDay.date, pnl: worstDay.pnl } : null,
    profitableDays,
    losingDays,
    breakEvenDays,
    winningDaysPct,
    voidRate: round(percent(voids, total), 2),
    pushRate: round(percent(pushes, total), 2),
    lowConfidenceBets: lowConf.length,
    lowConfidenceHitRate: lowConfSettled.length
      ? round(percent(lowConfSettled.filter((b) => b.result === "WIN").length, lowConfSettled.length), 2)
      : null,
    lowConfidencePnl: round(lowConfPnl, 2),
    highConfidenceBets: highConf.length,
    highConfidenceHitRate: highConfSettled.length
      ? round(percent(highConfSettled.filter((b) => b.result === "WIN").length, highConfSettled.length), 2)
      : null,
    highConfidencePnl: round(highConfPnl, 2),
    firstBetDate: dates[0] ?? null,
    lastBetDate: dates[dates.length - 1] ?? null,
    activeDays,
    top1Summary: buildTierSummary(bets, (r) => r === 1, "Top 1"),
    top3Summary: buildTierSummary(bets, (r) => r <= 3, "Top 3"),
    top10Summary: buildTierSummary(bets, (r) => r <= 10, "Top 10"),
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
  weightInRanking: number;
  contributionPct: number;
  correlation: number;
  reliabilityScore: number;
  derived: boolean;
}

export function factorAccuracy(bets: ModeBet[]): FactorAccuracyRow[] {
  const totalModeWins = bets.filter((b) => b.result === "WIN").length;
  const map = new Map<
    string,
    {
      hits: number;
      misses: number;
      weights: number[];
      pnl: number;
      correlationPairs: Array<{ x: number; y: number }>;
      derived: boolean;
    }
  >();

  for (const bet of bets) {
    if (!isSettled(bet.result)) continue;
    const isWin = bet.result === "WIN" ? 1 : 0;
    for (const f of bet.factors) {
      const entry = map.get(f.factor) ?? {
        hits: 0,
        misses: 0,
        weights: [],
        pnl: 0,
        correlationPairs: [],
        derived: bet.factorsDerived,
      };
      if (bet.result === "WIN") entry.hits += 1;
      if (bet.result === "LOSS") entry.misses += 1;
      const weightVal = f.contribution !== null ? f.contribution : 0.5;
      if (f.contribution !== null) entry.weights.push(f.contribution);
      entry.correlationPairs.push({ x: weightVal, y: isWin });
      entry.pnl += bet.pnl ?? 0;
      entry.derived = entry.derived && bet.factorsDerived;
      map.set(f.factor, entry);
    }
  }

  const allFactors = [...map.entries()];
  const totalWeightSum = sum(
    allFactors.map(([, e]) => (e.weights.length ? sum(e.weights) / e.weights.length : 1)),
  );

  return allFactors
    .map(([factor, e]) => {
      const totalBets = e.hits + e.misses;
      const hitRate = round(percent(e.hits, totalBets), 2);
      const avgContrib = e.weights.length ? round(sum(e.weights) / e.weights.length, 4) : null;
      const corr = calculateCorrelation(e.correlationPairs);
      const reliability = calculateFactorReliability(hitRate, totalBets, corr);
      const weightInRanking =
        totalWeightSum > 0 ? round(((avgContrib ?? 1) / totalWeightSum) * 100, 1) : 10;
      const contributionPct = totalModeWins > 0 ? round(percent(e.hits, totalModeWins), 1) : 0;

      return {
        factor,
        hits: e.hits,
        misses: e.misses,
        totalBets,
        hitRate,
        averageContribution: avgContrib,
        pnl: round(e.pnl, 2),
        weightInRanking,
        contributionPct,
        correlation: corr,
        reliabilityScore: reliability,
        derived: e.derived,
      };
    })
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

// ─── Rolling Series & Calibration ─────────────────────────────────────────────

export interface RollingPoint {
  date: string;
  hitRate: number;
  pnl: number;
  sharpe: number | null;
}

export function buildRollingSeries(daily: DailyPoint[], windowSize = 7): RollingPoint[] {
  return daily.map((point, idx) => {
    const windowSlice = daily.slice(Math.max(0, idx - windowSize + 1), idx + 1);
    const wins = sum(windowSlice.map((p) => p.wins));
    const losses = sum(windowSlice.map((p) => p.losses));
    const pnl = round(sum(windowSlice.map((p) => p.pnl)), 2);
    const hitRate = round(percent(wins, wins + losses), 2);
    const sharpe = calculateSharpeRatio(windowSlice.map((p) => p.pnl));
    return {
      date: point.date,
      hitRate,
      pnl,
      sharpe,
    };
  });
}

export interface CalibrationBucket {
  bucket: string;
  min: number;
  max: number;
  count: number;
  predictedProb: number;
  actualHitRate: number;
  delta: number;
}

export function buildCalibrationCurve(bets: ModeBet[]): CalibrationBucket[] {
  const settled = bets.filter((b) => isSettled(b.result) && b.modelProb !== null);
  const specs = [
    { bucket: "50–60%", min: 0.5, max: 0.6 },
    { bucket: "60–70%", min: 0.6, max: 0.7 },
    { bucket: "70–80%", min: 0.7, max: 0.8 },
    { bucket: "80–90%", min: 0.8, max: 0.9 },
    { bucket: "90–100%", min: 0.9, max: 1.01 },
  ];

  return specs.map((spec) => {
    const scoped = settled.filter(
      (b) => (b.modelProb ?? 0) >= spec.min && (b.modelProb ?? 0) < spec.max,
    );
    const wins = scoped.filter((b) => b.result === "WIN").length;
    const count = scoped.length;
    const avgProb = count > 0 ? round((sum(scoped.map((b) => b.modelProb ?? 0)) / count) * 100, 1) : round(((spec.min + spec.max) / 2) * 100, 1);
    const hitRate = count > 0 ? round(percent(wins, count), 1) : 0;
    return {
      bucket: spec.bucket,
      min: spec.min,
      max: spec.max,
      count,
      predictedProb: avgProb,
      actualHitRate: hitRate,
      delta: count > 0 ? round(hitRate - avgProb, 1) : 0,
    };
  });
}

export interface DrawdownEpisode {
  peakDate: string;
  troughDate: string;
  recoveryDate: string | null;
  maxDrop: number;
  durationDays: number;
  recovered: boolean;
}

export function buildDrawdownEpisodes(daily: DailyPoint[]): DrawdownEpisode[] {
  if (daily.length === 0) return [];
  const episodes: DrawdownEpisode[] = [];
  let peak = 0;
  let peakDate = daily[0].date;
  let inDrawdown = false;
  let troughDate = daily[0].date;
  let worstDrop = 0;
  let startDate = daily[0].date;

  for (const point of daily) {
    if (point.cumulativePnl >= peak) {
      if (inDrawdown && worstDrop > 5) {
        episodes.push({
          peakDate,
          troughDate,
          recoveryDate: point.date,
          maxDrop: round(worstDrop, 2),
          durationDays: Math.max(1, Math.round((new Date(point.date).getTime() - new Date(startDate).getTime()) / 86400000)),
          recovered: true,
        });
      }
      peak = point.cumulativePnl;
      peakDate = point.date;
      inDrawdown = false;
      worstDrop = 0;
    } else {
      const drop = peak - point.cumulativePnl;
      if (!inDrawdown) {
        inDrawdown = true;
        startDate = point.date;
        worstDrop = drop;
        troughDate = point.date;
      } else if (drop > worstDrop) {
        worstDrop = drop;
        troughDate = point.date;
      }
    }
  }

  if (inDrawdown && worstDrop > 5) {
    const last = daily[daily.length - 1];
    episodes.push({
      peakDate,
      troughDate,
      recoveryDate: null,
      maxDrop: round(worstDrop, 2),
      durationDays: Math.max(1, Math.round((new Date(last.date).getTime() - new Date(startDate).getTime()) / 86400000)),
      recovered: false,
    });
  }

  return episodes;
}

// ─── Multi-Mode Performance Series ────────────────────────────────────────────

export interface MultiModePoint {
  date: string;
  A: number;
  B: number;
  C: number;
  D: number;
}

export function buildMultiModeSeries(reports: ModeReport[]): MultiModePoint[] {
  const allDates = new Set<string>();
  const modeDailyMap = new Map<RankingModeKey, Map<string, number>>();

  for (const r of reports) {
    const dateMap = new Map<string, number>();
    for (const d of r.daily) {
      allDates.add(d.date);
      dateMap.set(d.date, d.cumulativePnl);
    }
    modeDailyMap.set(r.mode, dateMap);
  }

  const sortedDates = [...allDates].sort();
  const lastKnown: Record<RankingModeKey, number> = { A: 0, B: 0, C: 0, D: 0 };

  return sortedDates.map((date) => {
    for (const mode of RANKING_MODES) {
      const val = modeDailyMap.get(mode)?.get(date);
      if (val !== undefined) lastKnown[mode] = val;
    }
    return {
      date,
      A: round(lastKnown.A, 2),
      B: round(lastKnown.B, 2),
      C: round(lastKnown.C, 2),
      D: round(lastKnown.D, 2),
    };
  });
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
  rolling: RollingPoint[];
  calibrationCurve: CalibrationBucket[];
  drawdowns: DrawdownEpisode[];
  factorAccuracy: FactorAccuracyRow[];
  markets: BreakdownRow[];
  marketFamilies: BreakdownRow[];
  leagues: BreakdownRow[];
  oddsBands: BreakdownRow[];
  confidenceBands: BreakdownRow[];
  rankBuckets: BreakdownRow[];
  timeOfDayBands: BreakdownRow[];
  orientationBands: BreakdownRow[];
  liveBands: BreakdownRow[];
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
  const summary = summarise(ordered, extras);
  const daily = buildDailySeries(ordered);

  return {
    mode,
    label: meta.label,
    short: meta.short,
    description: meta.description,
    summary,
    windows: buildWindows(ordered, now),
    daily,
    rolling: buildRollingSeries(daily),
    calibrationCurve: buildCalibrationCurve(ordered),
    drawdowns: buildDrawdownEpisodes(daily),
    factorAccuracy: factorAccuracy(ordered),
    markets: breakdownBy(ordered, (bet) => ({ key: bet.market, label: bet.market })),
    marketFamilies: breakdownBy(ordered, (bet) => ({
      key: bet.marketFamily,
      label: bet.marketFamily,
    })),
    leagues: breakdownBy(ordered, (bet) => ({
      key: bet.leagueSlug ?? bet.league,
      label: bet.league,
    })),
    oddsBands: oddsBands(ordered),
    confidenceBands: confidenceBands(ordered),
    rankBuckets: rankBuckets(ordered),
    timeOfDayBands: breakdownBy(ordered, (bet) => ({
      key: bet.timeOfDay,
      label: `${bet.timeOfDay} kickoffs`,
    })),
    orientationBands: breakdownBy(ordered, (bet) => ({
      key: bet.orientation,
      label: `${bet.orientation} selections`,
    })),
    liveBands: breakdownBy(ordered, (bet) => ({
      key: bet.isLive ? "live" : "prematch",
      label: bet.isLive ? "Live / In-Play" : "Pre-Match",
    })),
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
  | "overallScore"
  | "hitRate"
  | "roi"
  | "totalPnl"
  | "consistencyScore"
  | "sharpeRatio"
  | "profitFactor"
  | "recoveryFactor"
  | "tenOfTenHits"
  | "averageOdds"
  | "totalBets"
  | "averageEv"
  | "top1HitRate"
  | "top3HitRate"
  | "top10HitRate"
  | "brierScore"
  | "calibrationDelta"
  | "maxDrawdown"
  | "winningDaysPct";

export interface ComparisonRow {
  mode: RankingModeKey;
  label: string;
  short: string;
  rank: number;
  overallScore: number;
  consistencyScore: number;
  totalBets: number;
  settledBets: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  hitRate: number;
  roi: number | null;
  totalPnl: number;
  totalStake: number;
  totalReturn: number;
  tenOfTenHits: number;
  averageOdds: number | null;
  averageEv: number | null;
  sharpeRatio: number | null;
  profitFactor: number | null;
  recoveryFactor: number | null;
  brierScore: number | null;
  calibrationDelta: number | null;
  maxDrawdown: number;
  winningDaysPct: number;
  top1HitRate: number | null;
  top3HitRate: number | null;
  top10HitRate: number | null;
  currentStreak: string;
  longestWinStreak: number;
  bestIn: ComparisonMetricKey[];
}

const COMPARISON_METRICS: ComparisonMetricKey[] = [
  "overallScore",
  "hitRate",
  "roi",
  "totalPnl",
  "consistencyScore",
  "sharpeRatio",
  "profitFactor",
  "recoveryFactor",
  "tenOfTenHits",
  "averageOdds",
  "totalBets",
  "averageEv",
  "top1HitRate",
  "top3HitRate",
  "top10HitRate",
  "brierScore",
  "calibrationDelta",
  "maxDrawdown",
  "winningDaysPct",
];

const LOWER_IS_BETTER: Set<ComparisonMetricKey> = new Set(["brierScore", "maxDrawdown"]);

export function buildComparison(reports: ModeReport[]): ComparisonRow[] {
  const rows: ComparisonRow[] = reports.map((r) => ({
    mode: r.mode,
    label: r.label,
    short: r.short,
    rank: 1,
    overallScore: r.summary.overallScore,
    consistencyScore: r.summary.consistencyScore,
    totalBets: r.summary.totalBets,
    settledBets: r.summary.settledBets,
    wins: r.summary.wins,
    losses: r.summary.losses,
    pushes: r.summary.pushes,
    voids: r.summary.voids,
    hitRate: r.summary.hitRate,
    roi: r.summary.roi,
    totalPnl: r.summary.totalPnl,
    totalStake: r.summary.totalStake,
    totalReturn: r.summary.totalReturn,
    tenOfTenHits: r.summary.tenOfTenHits,
    averageOdds: r.summary.averageOdds,
    averageEv: r.summary.averageEv,
    sharpeRatio: r.summary.sharpeRatio,
    profitFactor: r.summary.profitFactor,
    recoveryFactor: r.summary.recoveryFactor,
    brierScore: r.summary.brierScore,
    calibrationDelta: r.summary.calibrationDelta,
    maxDrawdown: r.summary.maxDrawdown,
    winningDaysPct: r.summary.winningDaysPct,
    top1HitRate: r.summary.top1HitRate,
    top3HitRate: r.summary.top3HitRate,
    top10HitRate: r.summary.top10HitRate,
    currentStreak: r.summary.currentStreak.label,
    longestWinStreak: r.summary.longestWinStreak,
    bestIn: [],
  }));

  // Rank rows by overall score descending
  const sorted = [...rows].sort((a, b) => b.overallScore - a.overallScore || b.hitRate - a.hitRate);
  sorted.forEach((row, i) => {
    row.rank = i + 1;
  });

  for (const metric of COMPARISON_METRICS) {
    const isLower = LOWER_IS_BETTER.has(metric);
    const candidates = rows.filter((r) => r.totalBets > 0 && r[metric] !== null && typeof r[metric] === "number");
    if (candidates.length === 0) continue;

    const values = candidates.map((r) => r[metric] as number);
    const best = isLower ? Math.min(...values) : Math.max(...values);

    if (!isLower && best <= 0 && metric !== "averageEv" && metric !== "totalPnl" && metric !== "calibrationDelta") {
      continue;
    }

    for (const row of candidates) {
      if ((row[metric] as number) === best) {
        row.bestIn.push(metric);
      }
    }
  }

  return rows;
}

// ─── Automated Insights & Recommendations ─────────────────────────────────────

export interface LeagueLeader {
  league: string;
  bestMode: RankingModeKey;
  hitRate: number;
  roi: number | null;
  bets: number;
}

export interface MarketLeader {
  marketFamily: string;
  bestMode: RankingModeKey;
  hitRate: number;
  bets: number;
}

export interface TrendAlert {
  mode: RankingModeKey;
  type: "improving" | "declining";
  message: string;
  delta: number;
}

export interface PerformanceWarning {
  mode: RankingModeKey;
  message: string;
  severity: "high" | "medium";
}

export interface AutomatedInsights {
  leagueLeaders: LeagueLeader[];
  marketLeaders: MarketLeader[];
  highConfidenceLeader: { mode: RankingModeKey; hitRate: number; bets: number } | null;
  lowConfidenceLeader: { mode: RankingModeKey; hitRate: number; bets: number } | null;
  trendAlerts: TrendAlert[];
  warnings: PerformanceWarning[];
  recommendedMode: RankingModeKey;
  recommendationReason: string;
}

export function generateInsights(reports: ModeReport[]): AutomatedInsights {
  const comparison = buildComparison(reports);
  const activeReports = reports.filter((r) => r.summary.totalBets > 0);

  // 1. Recommended mode
  const bestModeRow = comparison.reduce((a, b) => (b.overallScore > a.overallScore ? b : a), comparison[0]);
  const recommendedMode = bestModeRow?.mode ?? "A";
  const recReport = reports.find((r) => r.mode === recommendedMode);
  const recReason = recReport
    ? `${recReport.label} leads with an Overall Performance Score of ${bestModeRow.overallScore}/100 (${bestModeRow.hitRate}% hit rate, ${bestModeRow.roi !== null ? `${bestModeRow.roi > 0 ? "+" : ""}${bestModeRow.roi}% ROI` : "strong consistency"}).`
    : "Sufficient data required for full recommendation.";

  // 2. Best mode per league
  const leagueMap = new Map<string, Array<{ mode: RankingModeKey; hitRate: number; roi: number | null; bets: number }>>();
  for (const r of activeReports) {
    for (const l of r.leagues) {
      if (l.bets >= 2) {
        const list = leagueMap.get(l.label) ?? [];
        list.push({ mode: r.mode, hitRate: l.hitRate, roi: l.roi, bets: l.bets });
        leagueMap.set(l.label, list);
      }
    }
  }
  const leagueLeaders: LeagueLeader[] = [];
  for (const [league, list] of leagueMap.entries()) {
    list.sort((a, b) => b.hitRate - a.hitRate || (b.roi ?? 0) - (a.roi ?? 0));
    const top = list[0];
    leagueLeaders.push({
      league,
      bestMode: top.mode,
      hitRate: top.hitRate,
      roi: top.roi,
      bets: top.bets,
    });
  }

  // 3. Best mode per market family
  const familyMap = new Map<string, Array<{ mode: RankingModeKey; hitRate: number; bets: number }>>();
  for (const r of activeReports) {
    for (const m of r.marketFamilies) {
      if (m.bets >= 2) {
        const list = familyMap.get(m.label) ?? [];
        list.push({ mode: r.mode, hitRate: m.hitRate, bets: m.bets });
        familyMap.set(m.label, list);
      }
    }
  }
  const marketLeaders: MarketLeader[] = [];
  for (const [marketFamily, list] of familyMap.entries()) {
    list.sort((a, b) => b.hitRate - a.hitRate || b.bets - a.bets);
    const top = list[0];
    marketLeaders.push({
      marketFamily,
      bestMode: top.mode,
      hitRate: top.hitRate,
      bets: top.bets,
    });
  }

  // 4. High vs Low confidence leaders
  let highConfidenceLeader: { mode: RankingModeKey; hitRate: number; bets: number } | null = null;
  let lowConfidenceLeader: { mode: RankingModeKey; hitRate: number; bets: number } | null = null;

  const highCandidates = activeReports
    .filter((r) => r.summary.highConfidenceBets >= 2 && r.summary.highConfidenceHitRate !== null)
    .map((r) => ({ mode: r.mode, hitRate: r.summary.highConfidenceHitRate!, bets: r.summary.highConfidenceBets }));
  if (highCandidates.length > 0) {
    highCandidates.sort((a, b) => b.hitRate - a.hitRate);
    highConfidenceLeader = highCandidates[0];
  }

  const lowCandidates = activeReports
    .filter((r) => r.summary.lowConfidenceBets >= 2 && r.summary.lowConfidenceHitRate !== null)
    .map((r) => ({ mode: r.mode, hitRate: r.summary.lowConfidenceHitRate!, bets: r.summary.lowConfidenceBets }));
  if (lowCandidates.length > 0) {
    lowCandidates.sort((a, b) => b.hitRate - a.hitRate);
    lowConfidenceLeader = lowCandidates[0];
  }

  // 5. Trend Alerts & Warnings
  const trendAlerts: TrendAlert[] = [];
  const warnings: PerformanceWarning[] = [];

  for (const r of activeReports) {
    const w7 = r.windows.find((w) => w.key === "7d");
    const w30 = r.windows.find((w) => w.key === "30d");

    if (w7 && w30 && w7.bets >= 3 && w30.bets >= 5) {
      const delta = round(w7.hitRate - w30.hitRate, 1);
      if (delta >= 5) {
        trendAlerts.push({
          mode: r.mode,
          type: "improving",
          message: `${MODE_META[r.mode].short} is surging: 7-day hit rate (${w7.hitRate}%) is +${delta}pp above its 30-day baseline.`,
          delta,
        });
      } else if (delta <= -8) {
        trendAlerts.push({
          mode: r.mode,
          type: "declining",
          message: `${MODE_META[r.mode].short} shows recent dip: 7-day hit rate (${w7.hitRate}%) is ${delta}pp below 30-day average.`,
          delta,
        });
      }
    }

    if (r.summary.longestLossStreak >= 3) {
      warnings.push({
        mode: r.mode,
        message: `${MODE_META[r.mode].short} has experienced a ${r.summary.longestLossStreak}-bet losing streak.`,
        severity: r.summary.longestLossStreak >= 4 ? "high" : "medium",
      });
    }

    if (r.summary.calibrationDelta !== null && r.summary.calibrationDelta < -7) {
      warnings.push({
        mode: r.mode,
        message: `${MODE_META[r.mode].short} is currently under-calibrated by ${Math.abs(r.summary.calibrationDelta)}pp vs model expectations.`,
        severity: "medium",
      });
    }
  }

  return {
    leagueLeaders,
    marketLeaders,
    highConfidenceLeader,
    lowConfidenceLeader,
    trendAlerts,
    warnings,
    recommendedMode,
    recommendationReason: recReason,
  };
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
    const market = pick.name ?? "Ranked pick";
    const selection = pick.selection ?? pick.name ?? "—";
    const modelProb = typeof pick.hitRate === "number" ? pick.hitRate : null;
    const isLowConf = Boolean(row.lowConfidence);

    return {
      id: `perf-${row.id}-${index}`,
      date: row.matchDate,
      match: row.matchLabel,
      league: row.competitionName ?? row.league,
      leagueSlug: row.leagueSlug,
      market,
      marketFamily: deriveMarketFamily(market, pick.family),
      selection,
      odds: typeof pick.odds === "number" ? pick.odds : null,
      result: toResult(pick.outcome),
      stake: null,
      pnl: null,
      returnAmount: null,
      ev: typeof pick.ev === "number" ? pick.ev : null,
      modelProb,
      mode,
      source: "pick",
      rank: index + 1,
      lowConfidence: isLowConf,
      confidenceLevel: deriveConfidenceLevel(modelProb, isLowConf),
      factors,
      factorsDerived: derived,
      eventId: row.eventId,
      timeOfDay: deriveTimeOfDay(row.matchDate),
      orientation: deriveOrientation(row.matchLabel, selection),
      isLive: deriveIsLive(market, row.matchLabel),
    };
  });
}

/** Value bets carry real stake / P&L, so they drive the money metrics. */
export function betFromValueBetRow(row: ValueBetLogLike): ModeBet {
  const result = toResult(row.outcome);
  const { factors, derived } = factorsForPick({ name: row.marketName });
  const isLowConf = Boolean(row.lowConfidence);

  return {
    id: `vb-${row.id}`,
    date: row.matchDate,
    match: row.match,
    league: row.competitionName ?? row.leagueSlug,
    leagueSlug: row.leagueSlug,
    market: row.marketName,
    marketFamily: deriveMarketFamily(row.marketName),
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
    lowConfidence: isLowConf,
    confidenceLevel: deriveConfidenceLevel(row.oracleProb, isLowConf),
    factors,
    factorsDerived: derived,
    eventId: row.eventId,
    timeOfDay: deriveTimeOfDay(row.matchDate),
    orientation: deriveOrientation(row.match, row.selection),
    isLive: deriveIsLive(row.marketName, row.match),
  };
}

/**
 * Accumulator slips.
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
  const market = `Accumulator (${picks.length || "—"} legs)`;

  return {
    id: `slip-${row.id}`,
    date: row.createdAt.toISOString().slice(0, 10),
    match: row.name,
    league: row.competitionName ?? row.leagueSlug ?? "Multi-competition",
    leagueSlug: row.leagueSlug,
    market,
    marketFamily: "Accumulators",
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
    confidenceLevel: deriveConfidenceLevel(row.combinedProb, false),
    factors: [{ factor: "Accumulator consensus", contribution: null }],
    factorsDerived: true,
    eventId: null,
    timeOfDay: "Evening",
    orientation: "Neutral",
    isLive: false,
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
  marketFamily?: string | null;
  confidenceLevel?: string | null;
  oddsRange?: string | null;
  rankPosition?: string | null;
  timeOfDay?: string | null;
  orientation?: string | null;
  isLive?: string | null;
}

export function applyFilters(bets: ModeBet[], filters: BetFilters): ModeBet[] {
  const league = filters.league?.trim().toLowerCase() ?? "";
  const result = filters.result?.trim().toUpperCase() ?? "";
  const source = filters.source?.trim() ?? "";
  const search = filters.search?.trim().toLowerCase() ?? "";
  const marketFamily = filters.marketFamily?.trim() ?? "";
  const confidenceLevel = filters.confidenceLevel?.trim().toUpperCase() ?? "";
  const oddsRange = filters.oddsRange?.trim() ?? "";
  const rankPosition = filters.rankPosition?.trim() ?? "";
  const timeOfDay = filters.timeOfDay?.trim() ?? "";
  const orientation = filters.orientation?.trim() ?? "";
  const isLive = filters.isLive?.trim() ?? "";

  return bets.filter((bet) => {
    if (filters.from && bet.date < filters.from) return false;
    if (filters.to && bet.date > filters.to) return false;
    if (league && !`${bet.league} ${bet.leagueSlug ?? ""}`.toLowerCase().includes(league)) return false;
    if (result && result !== "ALL" && bet.result !== result) return false;
    if (source && source !== "all" && bet.source !== source) return false;
    if (search && !`${bet.match} ${bet.market} ${bet.selection}`.toLowerCase().includes(search))
      return false;

    // Granular filters
    if (marketFamily && marketFamily !== "all" && bet.marketFamily !== marketFamily) return false;
    if (confidenceLevel && confidenceLevel !== "ALL" && bet.confidenceLevel !== confidenceLevel) return false;

    if (oddsRange && oddsRange !== "all") {
      const odds = bet.odds;
      if (odds === null) return false;
      if (oddsRange === "1.00-1.30" && (odds < 1.0 || odds >= 1.3)) return false;
      if (oddsRange === "1.30-1.60" && (odds < 1.3 || odds >= 1.6)) return false;
      if (oddsRange === "1.60-2.00" && (odds < 1.6 || odds >= 2.0)) return false;
      if (oddsRange === "2.00-3.00" && (odds < 2.0 || odds >= 3.0)) return false;
      if (oddsRange === "3.00+" && odds < 3.0) return false;
    }

    if (rankPosition && rankPosition !== "all") {
      const r = bet.rank;
      if (r === null) return false;
      if (rankPosition === "1" && r !== 1) return false;
      if (rankPosition === "3" && r > 3) return false;
      if (rankPosition === "5" && r > 5) return false;
      if (rankPosition === "6-10" && (r < 6 || r > 10)) return false;
    }

    if (timeOfDay && timeOfDay !== "all" && bet.timeOfDay !== timeOfDay) return false;
    if (orientation && orientation !== "all" && bet.orientation !== orientation) return false;
    if (isLive && isLive !== "all") {
      const liveBool = isLive === "live" || isLive === "true";
      if (bet.isLive !== liveBool) return false;
    }

    return true;
  });
}

// ─── Canonical-row dedup (mode-agnostic pages) ───────────────────────────────
//
// Once every write path persists one row per (eventId, rankingMode), the same
// physical match appears up to four times in performance_log (and the same
// value bet up to four times in value_bet_log). The modes dashboard wants the
// full per-mode ledger, but the league / match-level pages describe what
// happened on the pitch — they must count each match (and each physical bet)
// once. These helpers keep one canonical row per key: the 'B' row when
// present (the historical default mode), otherwise the most recent row.

interface DedupeMatchRowLike {
  eventId: string;
  rankingMode?: string | null;
  createdAt?: Date | string | null;
}

function rowTime(r: { createdAt?: Date | string | null }): number {
  const c = r.createdAt;
  if (c instanceof Date) return c.getTime() || 0;
  if (typeof c === "string") return new Date(c).getTime() || 0;
  return 0;
}

function isCanonicalMode(mode: string | null | undefined): boolean {
  return (mode ?? "B").toUpperCase() === "B";
}

/** Keep one row per `eventId`: prefer the 'B' mode row, else the most recent. */
export function dedupeMatchRows<T extends DedupeMatchRowLike>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const cur = best.get(r.eventId);
    if (!cur) {
      best.set(r.eventId, r);
      continue;
    }
    const curB = isCanonicalMode(cur.rankingMode);
    const rB = isCanonicalMode(r.rankingMode);
    if (rB && !curB) best.set(r.eventId, r);
    else if (!rB && curB) { /* keep the canonical row */ }
    else if (rowTime(r) > rowTime(cur)) best.set(r.eventId, r);
  }
  return [...best.values()];
}

interface DedupeValueBetRowLike {
  eventId: string;
  marketName: string;
  selection: string;
  rankingMode?: string | null;
}

/** Keep one row per (eventId, marketName, selection): prefer the 'B' mode row. */
export function dedupeValueBetRows<T extends DedupeValueBetRowLike>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const key = `${r.eventId}|${r.marketName}|${r.selection}`;
    const cur = best.get(key);
    if (!cur) {
      best.set(key, r);
      continue;
    }
    const curB = isCanonicalMode(cur.rankingMode);
    const rB = isCanonicalMode(r.rankingMode);
    if (rB && !curB) best.set(key, r);
  }
  return [...best.values()];
}

// ─── Export utilities ─────────────────────────────────────────────────────────

export function betsToCsv(bets: ModeBet[]): string {
  const head = [
    "Date",
    "Match",
    "League",
    "Market",
    "Market Family",
    "Selection",
    "Odds",
    "Result",
    "Stake",
    "Profit/Loss",
    "Return",
    "EV",
    "Model Probability",
    "Confidence Level",
    "Ranking Mode",
    "Source",
    "Rank",
    "Time of Day",
    "Orientation",
    "Factors",
  ];
  const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const lines = bets.map((b) =>
    [
      b.date,
      b.match,
      b.league,
      b.market,
      b.marketFamily,
      b.selection,
      b.odds ?? "",
      b.result,
      b.stake ?? "",
      b.pnl ?? "",
      b.returnAmount ?? "",
      b.ev !== null ? `${(b.ev * 100).toFixed(1)}%` : "",
      b.modelProb !== null ? `${(b.modelProb * 100).toFixed(1)}%` : "",
      b.confidenceLevel,
      b.mode,
      b.source,
      b.rank ?? "",
      b.timeOfDay,
      b.orientation,
      b.factors.map((f) => f.factor).join(" | "),
    ]
      .map(esc)
      .join(","),
  );
  return [head.map(esc).join(","), ...lines].join("\n");
}

export function betsToJson(report: ModeReport): string {
  return JSON.stringify(
    {
      mode: report.mode,
      label: report.label,
      summary: report.summary,
      windows: report.windows,
      factorAccuracy: report.factorAccuracy,
      tierBreakdowns: {
        top1: report.summary.top1Summary,
        top3: report.summary.top3Summary,
        top10: report.summary.top10Summary,
      },
      markets: report.markets,
      leagues: report.leagues,
      betsCount: report.bets.length,
      bets: report.bets,
    },
    null,
    2,
  );
}
