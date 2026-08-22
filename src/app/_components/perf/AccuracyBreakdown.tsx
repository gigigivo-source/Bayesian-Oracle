"use client";

import { cn, pct, ProgressBar, type Tone } from "./ui";

export interface FactorStat {
  label: string;
  hits: number;
  total: number; // hits + misses (settled)
  /** Optional description / sub-label, e.g. agent description. */
  description?: string;
  /** Optional model-side expected reliability, for comparison. */
  expected?: number;
}

function toneForRate(rate: number): Tone {
  if (rate >= 0.8) return "positive";
  if (rate >= 0.65) return "info";
  if (rate >= 0.5) return "warning";
  return "negative";
}

/**
 * Accuracy breakdown by factor — shows the empirical hit rate for each ranking
 * factor / market family so the user can see which signals are most reliable.
 * All values are derived directly from settled picks (no hidden calculations).
 */
export function AccuracyBreakdown({
  factors,
  emptyLabel = "No factor data yet — settles automatically as picks resolve.",
}: {
  factors: FactorStat[];
  emptyLabel?: string;
}) {
  const settled = factors.filter((f) => f.total > 0);
  if (settled.length === 0) {
    return (
      <div className="responsive-card rounded-lg border border-slate-700 bg-slate-800 text-center font-mono text-sm text-slate-400">
        {emptyLabel}
      </div>
    );
  }

  const ranked = [...settled].sort((a, b) => {
    const ar = a.total > 0 ? a.hits / a.total : 0;
    const br = b.total > 0 ? b.hits / b.total : 0;
    if (br !== ar) return br - ar;
    return b.total - a.total;
  });

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:gap-6">
      {ranked.map((f) => {
        const rate = f.total > 0 ? f.hits / f.total : 0;
        const tone = toneForRate(rate);
        const text =
          tone === "positive"
            ? "text-emerald-300"
            : tone === "info"
              ? "text-cyan-300"
              : tone === "warning"
                ? "text-amber-300"
                : "text-rose-300";
        return (
          <div
            key={f.label}
            className="responsive-card rounded-lg border border-slate-700 bg-slate-800 transition-all duration-200 hover:-translate-y-2 hover:shadow-2xl"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="responsive-card-title truncate text-slate-100">{f.label}</span>
                  {f.expected !== undefined ? (
                    <span
                      className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400"
                      title="Model reliability coefficient"
                    >
                      model {pct(f.expected, 0)}
                    </span>
                  ) : null}
                </div>
                {f.description ? (
                  <p className="mt-0.5 truncate text-[11px] text-slate-400">{f.description}</p>
                ) : null}
              </div>
              <div className="flex items-baseline gap-2">
                <span className={cn("font-mono text-xl font-extrabold tabular-nums", text)}>{pct(rate, 1)}</span>
                <span className="font-mono text-[11px] text-slate-500">
                  {f.hits}/{f.total}
                </span>
              </div>
            </div>
            <ProgressBar value={rate} tone={tone} className="mt-2" />
          </div>
        );
      })}
    </div>
  );
}
