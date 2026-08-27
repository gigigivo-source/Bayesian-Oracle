import type { Confidence, First5Market, First5OutcomeSide } from "./types";
import { formatOdds, percentage, sourceBadgeTone } from "./format";

const CONFIDENCE_TONE: Record<Confidence, string> = {
  HIGH: "bg-cyan-500/20 text-cyan-300 border-cyan-400/30",
  MEDIUM: "bg-amber-500/20 text-amber-300 border-amber-400/30",
  LOW: "bg-rose-500/20 text-rose-300 border-rose-400/30",
};

function OutcomeColumn({
  side,
  tone,
}: {
  side: First5OutcomeSide;
  tone: "yes" | "no";
}) {
  const shell =
    tone === "yes"
      ? "from-emerald-500/20 to-emerald-500/5 border-emerald-400/30 text-emerald-300"
      : "from-rose-500/20 to-rose-500/5 border-rose-400/30 text-rose-300";

  return (
    <div className={`flex flex-col gap-1.5 rounded-xl border bg-gradient-to-b p-3 ${shell}`}>
      <div className="text-lg font-extrabold uppercase tracking-wide">{side.label}</div>
      <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
        <dt className="font-mono uppercase tracking-wider text-white/40">Hit rate</dt>
        <dd className="text-right font-mono text-sm font-bold text-white">
          {percentage(side.hitRate)}
        </dd>
        <dt className="font-mono uppercase tracking-wider text-white/40">Fair odds</dt>
        <dd className="text-right font-mono text-sm font-semibold text-white/90">
          {formatOdds(side.fairOdds)}
        </dd>
        <dt className="font-mono uppercase tracking-wider text-white/40">1xBet</dt>
        <dd className="text-right font-mono text-sm font-bold text-white">
          {formatOdds(side.odds1xBet)}
        </dd>
      </dl>
      <span
        className={`mt-1 inline-flex w-fit rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${CONFIDENCE_TONE[side.confidence]}`}
      >
        {side.confidence}
      </span>
    </div>
  );
}

export function MarketTile({ market }: { market: First5Market }) {
  return (
    <article
      className="group/tile rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-3 shadow-[0_0_24px_-12px_rgba(6,182,212,0.55)] transition-all duration-300 ease-in-out hover:scale-[1.02] hover:border-cyan-400/40 hover:shadow-[0_0_36px_-8px_rgba(6,182,212,0.75)]"
      title={market.reason}
    >
      <div className="mb-2.5 flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-400/10 text-base shadow-[0_0_12px_rgba(6,182,212,0.35)] motion-safe:animate-pulse">
            {market.icon}
          </span>
          <div>
            <div className="text-sm font-bold tracking-tight text-white">{market.shortLabel}</div>
            <div className="font-mono text-[9px] uppercase tracking-wider text-slate-500">
              First 5 minutes
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <span
            className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider ${sourceBadgeTone(market.statsSource)}`}
          >
            📊 {market.statsSource}
          </span>
          {market.isGuaranteed && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/50 bg-gradient-to-r from-amber-400/30 to-yellow-300/20 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-amber-200 shadow-[0_0_14px_rgba(251,191,36,0.45)] motion-safe:animate-pulse">
              ⚡ 🔥 Likely Guaranteed
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <OutcomeColumn side={market.yes} tone="yes" />
        <div className="relative">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -left-1 top-2 bottom-2 w-px bg-gradient-to-b from-transparent via-cyan-300/40 to-transparent"
          />
          <OutcomeColumn side={market.no} tone="no" />
        </div>
      </div>
    </article>
  );
}
