import { TeamBadge } from "../../_components/ui";
import type { First5MarketKey, First5Match } from "./types";
import { formatDateTime, sourceBadgeTone } from "./format";
import { MarketTile } from "./MarketTile";

export function MatchCard({
  match,
  index,
  marketFilter,
}: {
  match: First5Match;
  index: number;
  marketFilter: First5MarketKey | "all";
}) {
  const markets =
    marketFilter === "all"
      ? match.markets
      : match.markets.filter((market) => market.key === marketFilter);
  const guaranteed = match.markets.some((market) => market.isGuaranteed);

  return (
    <article
      style={{ animationDelay: `${index * 70}ms` }}
      className="first5-stagger rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4 shadow-[0_18px_40px_-24px_rgba(6,182,212,0.55)] backdrop-blur-xl transition-all duration-300 ease-in-out hover:scale-[1.02] hover:rotate-1 hover:border-cyan-400/40 hover:shadow-[0_24px_50px_-18px_rgba(139,92,246,0.35)]"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-400">
          <span className="rounded-full border border-violet-400/40 bg-violet-500/15 px-1.5 py-0.5 text-violet-200">
            T{match.leagueTier}
          </span>
          <span className="max-w-[180px] truncate">{match.league}</span>
        </div>
        <span className="font-mono text-[10px] text-cyan-200/70">
          {formatDateTime(match.date)}
        </span>
      </div>

      <div className="mb-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        <div className="flex min-w-0 items-center justify-end gap-1.5">
          <span className="truncate text-right text-sm font-bold text-white">
            {match.homeTeam}
          </span>
          <TeamBadge logo={match.homeLogo} name={match.homeTeam} size={24} />
        </div>
        <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2 py-0.5 font-mono text-[10px] text-cyan-200">
          VS
        </span>
        <div className="flex min-w-0 items-center justify-start gap-1.5">
          <TeamBadge logo={match.awayLogo} name={match.awayTeam} size={24} />
          <span className="truncate text-sm font-bold text-white">{match.awayTeam}</span>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span
          className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${sourceBadgeTone(match.statsSource)}`}
        >
          📊 {match.statsSource}
        </span>
        {guaranteed && (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/50 bg-gradient-to-r from-amber-400/25 to-yellow-300/15 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-amber-200 motion-safe:animate-pulse">
            ⚡ ✅ Sure Bet
          </span>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {markets.map((market) => (
          <MarketTile key={market.id} market={market} />
        ))}
      </div>
    </article>
  );
}
