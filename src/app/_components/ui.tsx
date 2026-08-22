"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import type { Market } from "@/lib/engine/types";
import type { FixtureLite } from "@/lib/espn";
import { OutcomeBadge, IconLive } from "./Icons";
import {
  CARD_ACCENT_ORDER,
  CARD_GLASS,
  CARD_GLASS_SKIN,
  GLASS_TEXT_SHADOW,
  type CardAccent,
} from "./design";
import { leagueTier, tierLabel, LOWEST_TIER } from "@/lib/leaguePriority";

// Tailwind classes per tier so the badge colour reflects competition size.
const TIER_BADGE_CLASS: Record<number, string> = {
  1: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30",
  2: "bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30",
  3: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30",
  4: "bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/30",
  5: "bg-slate-500/15 text-slate-300 ring-1 ring-slate-500/30",
  6: "bg-slate-700/40 text-slate-400 ring-1 ring-slate-600/40",
};

export function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function TeamBadge({
  logo,
  name,
  size = 28,
}: {
  logo: string | null;
  name: string;
  size?: number;
}) {
  if (!logo) {
    const initials = name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
    return (
      <span
        style={{ width: size, height: size }}
        className="flex shrink-0 items-center justify-center rounded-full bg-slate-950/60 text-[10px] font-bold text-slate-100 ring-1 ring-white/10"
      >
        {initials}
      </span>
    );
  }
  return (
    <Image
      src={logo}
      alt={name}
      width={size}
      height={size}
      className="object-contain"
      unoptimized
    />
  );
}

export function GradeBadge({ grade }: { grade: string }) {
  const colors: Record<string, string> = {
    A: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    B: "bg-cyan-500/20 text-cyan-300 border-cyan-500/40",
    C: "bg-amber-500/20 text-amber-300 border-amber-500/40",
    D: "bg-rose-500/20 text-rose-300 border-rose-500/40",
    // Legacy HIGH/MEDIUM/LOW aliases
    HIGH:   "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    MEDIUM: "bg-amber-500/20 text-amber-300 border-amber-500/40",
    LOW:    "bg-rose-500/20 text-rose-300 border-rose-500/40",
  };
  // Map legacy grades to letters for display
  const label = grade === "HIGH" ? "A" : grade === "MEDIUM" ? "B" : grade === "LOW" ? "C" : grade;
  return (
    <span
      className={`inline-flex h-5 w-5 items-center justify-center rounded border text-[11px] font-bold ${
        colors[grade] ?? colors.D
      }`}
    >
      {label}
    </span>
  );
}

export function ConfidenceBar({
  value,
  lower,
  upper,
}: {
  value: number;
  lower?: number;
  upper?: number;
}) {
  const filled = Math.round(value * 20);
  const bars = "█".repeat(filled) + "░".repeat(20 - filled);
  const hue =
    value > 0.9
      ? "text-emerald-400"
      : value > 0.75
      ? "text-cyan-400"
      : value > 0.6
      ? "text-amber-400"
      : "text-rose-400";
  const margin =
    lower !== undefined && upper !== undefined
      ? ((upper - lower) / 2) * 100
      : null;
  return (
    <span className={`font-mono text-xs ${hue}`}>
      {bars} {pct(value)}
      {margin !== null ? ` ± ${margin.toFixed(1)}%` : ""}
    </span>
  );
}

export function MarketTable({
  markets,
  showDeepExplanation = false,
  renderPickFooter,
}: {
  markets: Market[];
  showDeepExplanation?: boolean;
  /**
   * Optional additive footer rendered inside each deep-explanation pick card.
   * Purely opt-in — when omitted the table renders exactly as before.
   */
  renderPickFooter?: (market: Market, index: number) => ReactNode;
}) {
  return (
    <div className="space-y-3">
      {showDeepExplanation ? (
        <div className="space-y-3">
          {markets.map((m, idx) => (
            <div key={m.id} className="rounded-lg bg-slate-900 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 pb-2.5">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-400/20 text-xs font-bold font-mono text-amber-300 border border-amber-400/40">
                    #{idx + 1}
                  </span>
                  <span className="font-bold text-base text-slate-100">{m.name}</span>
                  <span className="rounded bg-amber-400/10 px-2 py-0.5 text-xs font-mono text-amber-300 border border-amber-400/20">
                    {m.family}
                  </span>
                  <GradeBadge grade={m.grade} />
                </div>
                <div className="flex items-center gap-3 font-mono">
                  <span className="text-xs text-slate-400">Selection:</span>
                  <span className="rounded bg-emerald-500/20 px-2.5 py-1 text-xs font-bold text-emerald-300 border border-emerald-500/30">
                    {m.selection}
                  </span>
                  <span className="text-base font-bold text-emerald-300">{pct(m.hitRate)}</span>
                  <OutcomeBadge outcome={m.outcome} />
                </div>
              </div>

              {/* 3-part Rationale */}
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3 text-xs">
                <div className="rounded-lg border border-slate-700 p-2.5">
                  <div className="font-bold text-amber-300 mb-1 font-mono">1. WHY QUALIFIED</div>
                  <p className="text-slate-300 leading-relaxed text-[11px]">
                    {m.explanation?.whyQualified ??
                      "Passed 5-step gate with low agent disagreement & tight Wilson score CI."}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-700 p-2.5">
                  <div className="font-bold text-cyan-300 mb-1 font-mono">
                    2. WHY SELECTED FOR THIS MATCH
                  </div>
                  <p className="text-slate-300 leading-relaxed text-[11px]">
                    {m.explanation?.whySelectedForMatch ??
                      m.reason ??
                      "Grounded in recent form, xG, and de-vigged bookmaker probabilities."}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-700 p-2.5">
                  <div className="font-bold text-emerald-300 mb-1 font-mono">
                    3. WHY OUTCOME IS POSSIBLE
                  </div>
                  <p className="text-slate-300 leading-relaxed text-[11px]">
                    {m.explanation?.whyOutcomePossible ??
                      `Poisson/NegBinom distribution yields ${pct(m.hitRate)} high-likelihood density.`}
                  </p>
                </div>
              </div>

              <div className="mt-2.5 flex items-center justify-between text-[11px] font-mono text-slate-500 pt-2 border-t border-slate-700">
                <span>
                  Fair Odds Worst:{" "}
                  <strong className="text-slate-300">{m.fairOddsWorst.toFixed(2)}</strong>
                </span>
                <span>
                  MQS Score:{" "}
                  <strong className="text-slate-300">{m.mqs.toFixed(1)}/10</strong>
                </span>
                <span>
                  Disagreement Index:{" "}
                  <strong className="text-slate-300">
                    {(m.disagreementIndex * 100).toFixed(1)}%
                  </strong>
                </span>
              </div>

              {/* Additive footer (e.g. ranking-factors toggle) — only when provided */}
              {renderPickFooter ? (
                <div className="mt-2.5 pt-2 border-t border-slate-700">
                  {renderPickFooter(m, idx)}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-slate-900">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-800 text-[11px] uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-3 py-2.5">Market &amp; Rationale</th>
                <th className="px-3 py-2.5">Pick</th>
                <th className="px-3 py-2.5">Hit Rate (90% CI)</th>
                <th className="px-3 py-2.5 text-right">Fair Odds</th>
                <th className="px-3 py-2.5 text-right">MQS</th>
                <th className="px-3 py-2.5 text-center">Grade</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {markets.map((m) => (
                <tr key={m.id} className="hover:bg-slate-700 transition">
                  <td className="px-3 py-2.5 max-w-xs sm:max-w-md">
                    <div className="font-semibold text-slate-100">{m.name}</div>
                    <div className="text-[11px] text-amber-300/80 font-mono mt-0.5">{m.family}</div>
                    {m.reason ? (
                      <div className="text-[11px] text-slate-400 mt-1 leading-relaxed p-1.5 rounded border border-slate-700">
                        <span className="text-slate-300 font-sans">{m.reason}</span>
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 font-bold">
                    <div className="flex items-center gap-1.5">
                      <span className="text-emerald-300 bg-emerald-500/10 px-2 py-1 rounded border border-emerald-500/20 font-mono">
                        {m.selection}
                      </span>
                      {m.outcome === "HIT" ? (
                        <span className="rounded bg-emerald-500/30 px-2 py-0.5 text-xs font-bold text-emerald-300 border border-emerald-500/50">
                          HIT
                        </span>
                      ) : m.outcome === "MISS" ? (
                        <span className="rounded bg-rose-500/30 px-2 py-0.5 text-xs font-bold text-rose-300 border border-rose-500/50">
                          MISS
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="font-bold font-mono text-emerald-300">{pct(m.hitRate)}</div>
                    <div className="text-[11px] font-mono text-slate-500">
                      [{pct(m.ciLower)} – {pct(m.ciUpper)}]
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-slate-200 font-bold">
                    {m.fairOddsWorst.toFixed(2)}
                    <span className="text-[10px] text-slate-500 font-normal"> (worst)</span>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-slate-300">
                    {m.mqs.toFixed(1)}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <GradeBadge grade={m.grade} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Section({
  id,
  title,
  subtitle,
  children,
  right,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-28">
      <div className="mb-2 inline-block bg-slate-900 rounded-lg px-4 py-2">
        <h2 className="text-base font-semibold text-white">{title}</h2>
        {subtitle ? <p className="text-[11px] text-slate-300">{subtitle}</p> : null}
        {right ? <div className="mt-1">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

function kickoffLabel(dateIso: string): string {
  const d = new Date(dateIso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Stable fallback tint for cards rendered without a list index: hashes the
 * fixture id so a card always wears the same colour, even across re-renders.
 */
function accentForId(id: string): CardAccent {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return CARD_ACCENT_ORDER[Math.abs(h) % CARD_ACCENT_ORDER.length];
}

export function FixtureCard({
  fx,
  onSelect,
  live,
  accentIndex,
}: {
  fx: FixtureLite;
  onSelect: (fx: FixtureLite) => void;
  live?: boolean;
  /**
   * Position in the deck's colour cycle (amber → teal → violet → cyan →
   * rose → emerald). Pass the `.map()` index so sibling cards alternate in a
   * repeating rhythm; omitted, the tint is derived from the fixture id.
   */
  accentIndex?: number;
}) {
  const isLive = fx.state === "in" || live === true;
  // Live cards always burn rose (live-state colour); the rest cycle the deck.
  const accent: CardAccent = isLive
    ? "rose"
    : accentIndex === undefined
    ? accentForId(fx.id)
    : CARD_ACCENT_ORDER[
        ((accentIndex % CARD_ACCENT_ORDER.length) + CARD_ACCENT_ORDER.length) %
          CARD_ACCENT_ORDER.length
      ];
  const glass = `${CARD_GLASS} ${CARD_GLASS_SKIN[accent]}`;
  const isFinished = fx.state === "post";
  const stateColor = isLive
    ? "text-rose-400"
    : fx.state === "pre"
    ? "text-emerald-400"
    : "text-slate-500";
  const stateText = isLive
    ? fx.clock ?? "LIVE"
    : fx.state === "pre"
    ? kickoffLabel(fx.date)
    : "FT";
  const showScore =
    (isLive || isFinished) &&
    fx.home.score !== null &&
    fx.away.score !== null;

  // Small league-importance badge (T1 = biggest competitions … T6 = smallest).
  const tier = leagueTier({ leagueSlug: fx.leagueSlug, leagueName: fx.leagueName });
  const tierClass = TIER_BADGE_CLASS[tier] ?? TIER_BADGE_CLASS[LOWEST_TIER];

  return (
    <button
      onClick={() => onSelect(fx)}
      className={`group p-3 text-left ${glass} ${GLASS_TEXT_SHADOW}`}
    >
      <div className="mb-2 flex items-center justify-between text-[11px]">
        <span
          className={`flex min-w-0 items-center gap-1.5 truncate ${isLive ? "text-rose-300 font-bold" : "text-slate-400"}`}
        >
          {isLive && (
            <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-rose-500" />
          )}
          <span
            className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-bold leading-none tracking-wide ${tierClass}`}
            title={`League priority tier ${tier}`}
          >
            {tierLabel(tier)}
          </span>
          <span className="truncate">{fx.leagueName}</span>
        </span>
        <span className={`font-mono font-bold flex items-center gap-1 ${stateColor}`}>
          {isLive && <IconLive size={8} />}
          {stateText}
        </span>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <TeamBadge logo={fx.home.logo} name={fx.home.name} size={22} />
          <span
            className={`flex-1 truncate text-sm ${
              isLive ? "font-bold text-slate-100" : "text-slate-200"
            }`}
          >
            {fx.home.name}
          </span>
          {showScore && (
            <span
              className={`font-mono text-lg font-bold tabular-nums ${
                isLive ? "text-amber-300" : "text-slate-300"
              }`}
            >
              {fx.home.score}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <TeamBadge logo={fx.away.logo} name={fx.away.name} size={22} />
          <span
            className={`flex-1 truncate text-sm ${
              isLive ? "font-bold text-slate-100" : "text-slate-200"
            }`}
          >
            {fx.away.name}
          </span>
          {showScore && (
            <span
              className={`font-mono text-lg font-bold tabular-nums ${
                isLive ? "text-amber-300" : "text-slate-300"
              }`}
            >
              {fx.away.score}
            </span>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between border-t border-white/10 pt-2 text-[11px] text-slate-400">
        <span className="truncate">
          {fx.venue ?? (fx.neutralSite ? "Neutral" : "Home venue")}
        </span>
        {fx.odds?.overUnder ? (
          <span className="text-amber-300/80 font-mono font-semibold">
            O/U {fx.odds.overUnder}
          </span>
        ) : (
          <span className="text-amber-300/70 font-mono font-semibold opacity-0 transition group-hover:opacity-100">
            Oracle →
          </span>
        )}
      </div>
    </button>
  );
}
