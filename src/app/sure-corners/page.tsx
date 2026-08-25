"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { TeamBadge } from "../_components/ui";
import {
  CARD_SURFACE,
  CHIP,
  CHIP_ON_AMBER,
  GLASS_PANEL,
  NAV_PILL,
  NAV_PILL_OFF,
  OUTLINE_NEUTRAL,
} from "../_components/design";

type SureCornerMarketType =
  | "Total Corners"
  | "Team 1 Corners"
  | "Team 2 Corners"
  | "Corner Winner"
  | "Corner Handicap";

interface SureCornerMarket {
  id: string;
  marketType: SureCornerMarketType;
  name: string;
  selection: string;
  line: number | null;
  hitRate: number;
  confidence: "HIGH";
  reason: string;
}

interface SureCornerMatch {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  homeLogo: string | null;
  awayLogo: string | null;
  league: string;
  leagueSlug: string;
  leagueTier: number;
  date: string;
  confidence: "HIGH";
  realStats: true;
  statsSource: string;
  predictedCorners: {
    home: number;
    away: number;
    difference: number;
    strongerTeam: string | null;
  };
  markets: SureCornerMarket[];
}

interface SureCornersData {
  generatedAt: string;
  totalFixturesChecked: number;
  rejectedMatches: number;
  matches: SureCornerMatch[];
  filters: {
    minimumHitRate: number;
    requiredConfidence: "HIGH";
    requiresRealPerMatchCorners: true;
    allowedLeagueTiers: number[];
  };
}

const MARKET_TONES: Record<SureCornerMarketType, string> = {
  "Total Corners": "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
  "Team 1 Corners": "border-amber-400/30 bg-amber-400/10 text-amber-200",
  "Team 2 Corners": "border-violet-400/30 bg-violet-400/10 text-violet-200",
  "Corner Winner": "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  "Corner Handicap": "border-rose-400/30 bg-rose-400/10 text-rose-200",
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export default function SureCornersPage() {
  const [data, setData] = useState<SureCornersData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/sure-corners", { cache: "no-store" });
      const payload = await response.json() as SureCornersData & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setData(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load Sure Bet Corners.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(initialLoad);
  }, [load]);

  return (
    <main className="min-h-screen bg-[#05070d] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className={`${CHIP} ${CHIP_ON_AMBER} mb-3 inline-flex px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider`}>
              🎯 Strict corner filter
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">Sure Bet Corners</h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400 sm:text-base">
              matches with the highest-confidence corner bets with strict filters applied.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/" className={`${NAV_PILL} ${NAV_PILL_OFF} px-3 py-2 text-xs font-semibold`}>
              ← Oracle
            </Link>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className={`${OUTLINE_NEUTRAL} px-3 py-2 text-xs`}
            >
              {loading ? "Checking…" : "Refresh"}
            </button>
          </div>
        </div>

        <div className={`${GLASS_PANEL} grid grid-cols-1 gap-3 p-4 text-xs sm:grid-cols-3`}>
          <div>
            <div className="font-mono uppercase tracking-wider text-amber-300">98%+ hit-rate gate</div>
            <p className="mt-1 text-slate-400">A market is shown only when the engine predicts at least 98.0%.</p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-cyan-300">Real stats only</div>
            <p className="mt-1 text-slate-400">Both teams must have per-match corner data from the stats aggregator.</p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-emerald-300">Top tiers only</div>
            <p className="mt-1 text-slate-400">Only Tier 1 elite competitions and Tier 2 top-five leagues are eligible.</p>
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5 text-sm text-rose-200">
            <div className="font-bold">Sure Bet Corners is temporarily unavailable</div>
            <p className="mt-1 text-rose-200/70">{error}</p>
            <p className="mt-2 font-mono text-xs text-rose-200/60">No match is shown without passing every gate.</p>
          </div>
        )}

        {loading && !data ? (
          <LoadingState />
        ) : data && data.matches.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>{data.matches.length} qualifying match{data.matches.length === 1 ? "" : "es"} · {data.totalFixturesChecked} fixtures checked</span>
              <span className="font-mono">Updated {formatDate(data.generatedAt)}</span>
            </div>
            <div className="space-y-5">
              {data.matches.map((match) => <MatchCard key={match.fixtureId} match={match} />)}
            </div>
          </>
        ) : !error ? (
          <EmptyState />
        ) : null}

        <p className="border-t border-white/[0.06] pt-4 text-center text-[11px] leading-relaxed text-slate-500">
          No model can guarantee a sports result. This view deliberately returns no match rather than relax a gate when the evidence is not strong enough.
        </p>
      </div>
    </main>
  );
}

function MatchCard({ match }: { match: SureCornerMatch }) {
  return (
    <article className={`${CARD_SURFACE} overflow-hidden p-4 sm:p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.07] pb-4">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-slate-400">
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-amber-200">Tier {match.leagueTier}</span>
            <span>{match.league}</span>
            <span className="text-slate-600">·</span>
            <span>{formatDate(match.date)}</span>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 sm:gap-5">
            <TeamName logo={match.homeLogo} name={match.homeTeam} align="right" />
            <span className="font-mono text-xs text-slate-500">VS</span>
            <TeamName logo={match.awayLogo} name={match.awayTeam} align="left" />
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 text-right">
          <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2">
            <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300">Real corner stats</div>
            <div className="mt-1 text-xs font-semibold text-emerald-100">{match.statsSource}</div>
          </div>
          <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2">
            <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-300">Match confidence</div>
            <div className="mt-1 text-xs font-bold text-cyan-100">{match.confidence}</div>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-white/[0.06] bg-black/15 px-3 py-2.5 text-xs font-mono text-slate-400">
        <span>Engine corner expectation: <strong className="text-slate-200">{match.predictedCorners.home.toFixed(1)} — {match.predictedCorners.away.toFixed(1)}</strong></span>
        <span>Difference: <strong className="text-amber-200">{match.predictedCorners.difference.toFixed(1)}</strong></span>
        {match.predictedCorners.strongerTeam && <span>Strength edge: <strong className="text-cyan-200">{match.predictedCorners.strongerTeam}</strong></span>}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {match.markets.map((market) => (
          <MarketCard key={market.id} market={market} />
        ))}
      </div>
    </article>
  );
}

function TeamName({ logo, name, align }: { logo: string | null; name: string; align: "left" | "right" }) {
  return (
    <div className={`flex min-w-0 items-center gap-2 ${align === "right" ? "justify-end" : "justify-start"}`}>
      {align === "right" && <span className="truncate text-right text-sm font-bold text-white sm:text-base">{name}</span>}
      <TeamBadge logo={logo} name={name} size={30} />
      {align === "left" && <span className="truncate text-sm font-bold text-white sm:text-base">{name}</span>}
    </div>
  );
}

function MarketCard({ market }: { market: SureCornerMarket }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-slate-950/40 p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${MARKET_TONES[market.marketType]}`}>
            {market.marketType}
          </span>
          <div className="mt-2 text-sm font-semibold text-slate-100">{market.name}</div>
        </div>
        <div className="flex items-center gap-2 font-mono">
          <span className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-sm font-extrabold text-emerald-300">
            {percentage(market.hitRate)}
          </span>
          <span className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-[10px] font-bold text-emerald-200">
            {market.confidence}
          </span>
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-sm font-bold text-amber-100">
        {market.selection}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-slate-400">{market.reason}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className={`${GLASS_PANEL} p-10 text-center sm:p-14`}>
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-400/20 bg-amber-400/10 text-2xl">🎯</div>
      <h2 className="text-xl font-bold text-slate-200">no sure bet corners available right now</h2>
      <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-400">
        Only corner bets with a predicted hit rate above 98 percent, real stats, and top-tier leagues are shown. If every market does not pass every strict filter, nothing is listed.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className={`${GLASS_PANEL} p-10 text-center sm:p-14`}>
      <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-slate-700 border-t-amber-400" />
      <div className="font-mono text-sm text-amber-200">Checking real corner stats and strict engine gates…</div>
      <p className="mt-2 text-xs text-slate-500">Matches are withheld until every filter passes.</p>
    </div>
  );
}
