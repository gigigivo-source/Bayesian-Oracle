"use client";

// ĞIGI GIVØ — First 5 Minutes Markets.
//
// Cyan/teal opening-phase board. Dual-outcome tiles show Yes and No side by
// side with hit rate, fair odds, 1xBet odds and confidence. Data comes from
// /api/first-5-minutes (1-hour cache, force-refresh via the Refresh button).

import Link from "next/link";
import { LEAGUE_MAP } from "@/lib/leagues";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "./components/EmptyState";
import { MARKET_LABEL, MARKET_ORDER, formatDateTime } from "./components/format";
import { MatchCard } from "./components/MatchCard";
import type { First5MarketKey, First5MinutesData } from "./components/types";

const LEAGUE_ORDER = [
  "eng.1", "esp.1", "ita.1", "ger.1", "fra.1",
  "uefa.champions", "uefa.europa", "uefa.europa.conf",
  "eng.fa", "eng.league_cup", "esp.copa_del_rey",
  "ita.coppa_italia", "ger.dfb_pokal", "fra.coupe_de_france",
];

const LEAGUE_PRIORITY = new Map(LEAGUE_ORDER.map((slug, index) => [slug, index]));

// ─── Settled results (Recent Results section) ─────────────────────────────────
// Payload of /api/first-5-minutes/results, normalised once at load time so the
// render path never has to defend against a partial body. The window is a
// constant here because the heading ("LAST 14 DAYS") and the query param must
// never drift apart.

const RECENT_RESULTS_DAYS = 14;
/** Matches shown before the "Show all" toggle appears. */
const RECENT_RESULTS_VISIBLE = 10;
const SETTLED_OUTCOMES = ["WIN", "LOSS", "PUSH", "VOID"] as const;

type SettledOutcome = (typeof SETTLED_OUTCOMES)[number];

interface SettledMarket {
  market: string;
  selection: string;
  /** The model's claimed probability at pick time (0–1). */
  hitRate: number;
  confidence: string;
  outcome: SettledOutcome;
}

interface SettledMatch {
  eventId: string;
  matchLabel: string;
  league: string;
  leagueSlug: string;
  matchDate: string;
  homeScore: number | null;
  awayScore: number | null;
  markets: SettledMarket[];
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asSettledOutcome(value: unknown): SettledOutcome | null {
  const outcome = asText(value).toUpperCase();
  return (SETTLED_OUTCOMES as readonly string[]).includes(outcome)
    ? (outcome as SettledOutcome)
    : null;
}

function asScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read the endpoint's `matches` array defensively: anything malformed (or a
 * market whose outcome is not settled) is dropped rather than rendered. The
 * section then falls back to its placeholder instead of breaking the board.
 */
function normaliseSettledMatches(payload: unknown): SettledMatch[] {
  const raw = (payload as { matches?: unknown } | null)?.matches;
  if (!Array.isArray(raw)) return [];

  const matches: SettledMatch[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const match = entry as Record<string, unknown>;
    const eventId = asText(match.eventId);
    if (!eventId) continue;

    const markets: SettledMarket[] = [];
    for (const rawMarket of Array.isArray(match.markets) ? match.markets : []) {
      if (rawMarket === null || typeof rawMarket !== "object") continue;
      const market = rawMarket as Record<string, unknown>;
      const outcome = asSettledOutcome(market.outcome);
      if (!outcome) continue;
      markets.push({
        market: asText(market.market),
        selection: asText(market.selection),
        hitRate: typeof market.hitRate === "number" && Number.isFinite(market.hitRate)
          ? market.hitRate
          : 0,
        confidence: asText(market.confidence) || "LOW",
        outcome,
      });
    }

    matches.push({
      eventId,
      matchLabel: asText(match.matchLabel) || "Finished match",
      league: asText(match.league),
      leagueSlug: asText(match.leagueSlug),
      matchDate: asText(match.matchDate).slice(0, 10),
      homeScore: asScore(match.homeScore),
      awayScore: asScore(match.awayScore),
      markets,
    });
  }
  return matches;
}

export default function First5MinutesPage() {
  const [data, setData] = useState<First5MinutesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marketFilter, setMarketFilter] = useState<First5MarketKey | "all">("all");
  // Settled history: null while the first read is in flight, [] when the
  // window holds nothing (or the read failed — the endpoint fails soft, so the
  // placeholder is the honest state either way).
  const [settledMatches, setSettledMatches] = useState<SettledMatch[] | null>(null);
  const [settledLoading, setSettledLoading] = useState(true);

  const dataRef = useRef<First5MinutesData | null>(null);
  const initialFetchDone = useRef(false);

  const load = useCallback(async (forceRefresh = false) => {
    if (forceRefresh || dataRef.current) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const url = forceRefresh
        ? "/api/first-5-minutes?refresh=true"
        : "/api/first-5-minutes";
      const response = await fetch(url, { cache: "no-store" });
      const payload = (await response.json()) as First5MinutesData;
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      dataRef.current = payload;
      setData(payload);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to load First 5 Minutes Markets.",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Settled history for the same feature — a second, independent read that
  // mirrors load()'s shape. It fails soft: a failed read leaves the section on
  // its placeholder and never touches the upcoming-fixtures board.
  const loadRecentResults = useCallback(async () => {
    setSettledLoading(true);
    try {
      const response = await fetch(
        `/api/first-5-minutes/results?days=${RECENT_RESULTS_DAYS}`,
        { cache: "no-store" },
      );
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSettledMatches(normaliseSettledMatches(payload));
    } catch {
      setSettledMatches([]);
    } finally {
      setSettledLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialFetchDone.current) return;
    initialFetchDone.current = true;
    void load(false);
    void loadRecentResults();
  }, [load, loadRecentResults]);

  const groupedMatches = useMemo(() => {
    if (!data?.matches?.length) return [];
    const groups = new Map<string, First5MinutesData["matches"]>();
    for (const match of data.matches) {
      const bucket = groups.get(match.leagueSlug) ?? [];
      bucket.push(match);
      groups.set(match.leagueSlug, bucket);
    }
    return Array.from(groups.entries())
      .map(([leagueSlug, matches]) => ({
        leagueSlug,
        // Keep the requested spacing for La Liga; all other names use the catalogue.
        leagueName: leagueSlug === "esp.1"
          ? "La Liga"
          : LEAGUE_MAP[leagueSlug]?.name ?? matches[0].league,
        matches: matches.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()),
      }))
      .sort((a, b) =>
        (LEAGUE_PRIORITY.get(a.leagueSlug) ?? LEAGUE_ORDER.length) -
          (LEAGUE_PRIORITY.get(b.leagueSlug) ?? LEAGUE_ORDER.length) ||
        a.leagueName.localeCompare(b.leagueName) ||
        a.leagueSlug.localeCompare(b.leagueSlug),
      );
  }, [data]);

  const highConfidenceCount = useMemo(() => {
    if (!data?.matches?.length) return 0;
    return data.matches.reduce(
      (sum, match) =>
        sum + match.markets.filter((market) => market.confidence === "HIGH").length,
      0,
    );
  }, [data]);

  const guaranteedCount = useMemo(() => {
    if (!data?.matches?.length) return 0;
    return data.matches.reduce(
      (sum, match) => sum + match.markets.filter((market) => market.isGuaranteed).length,
      0,
    );
  }, [data]);

  const publishedMarkets = useMemo(
    () => data?.matches.reduce((sum, match) => sum + match.markets.length, 0) ?? 0,
    [data],
  );

  const skippedFixtures = useMemo(
    () => (data ? Math.max(0, data.totalFixturesChecked - data.totalMatches) : 0),
    [data],
  );

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0F1117] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(6,182,212,0.16)_0%,_rgba(15,17,23,0.2)_42%,_#0F1117_72%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 right-0 h-80 w-80 rounded-full bg-violet-600/10 blur-3xl"
      />

      <style>{`
        @keyframes first5-title-glow {
          0%, 100% { text-shadow: 0 0 12px rgba(6,182,212,0.35), 0 0 2px rgba(139,92,246,0.2); }
          50% { text-shadow: 0 0 28px rgba(6,182,212,0.95), 0 0 12px rgba(139,92,246,0.55); }
        }
        @keyframes first5-stagger-in {
          from { opacity: 0; transform: translateY(14px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .first5-title-glow { animation: first5-title-glow 1.8s ease-in-out infinite; }
        .first5-stagger { animation: first5-stagger-in 0.55s ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .first5-title-glow, .first5-stagger { animation: none; }
        }
      `}</style>

      <div className="relative mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-cyan-200">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75 motion-safe:animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
              </span>
              Opening 5 minutes · 7-day window
            </div>
            <h1 className="first5-title-glow text-3xl font-extrabold tracking-tight text-cyan-50 sm:text-4xl">
              ⏱️ First 5 Minutes
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400 sm:text-base">
              Fast-start markets — what will happen in the opening 5 minutes?
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="inline-flex items-center rounded-full border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-slate-700 hover:text-white"
            >
              ← Oracle
            </Link>
            <Link
              href="/performance/first5"
              title="First 5 Minutes track record — historical picks, hit rate, P&L and ROI"
              aria-label="Open the First 5 Minutes performance tracker"
              className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-cyan-400 to-teal-400 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-cyan-500/30 transition-all duration-300 hover:scale-105 hover:shadow-cyan-400/50 active:scale-95"
            >
              📊 Track Records
            </Link>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading || refreshing}
              className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-cyan-400 to-teal-400 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-cyan-500/30 transition-all duration-300 hover:scale-105 hover:shadow-cyan-400/50 active:scale-95 disabled:opacity-60"
              aria-label="Refresh first 5 minutes markets"
            >
              {refreshing ? (
                <>
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  Refreshing…
                </>
              ) : (
                <>🔄 Refresh</>
              )}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 rounded-2xl border border-cyan-500/15 bg-cyan-500/5 p-4 text-xs sm:grid-cols-3">
          <div>
            <div className="font-mono uppercase tracking-wider text-cyan-300">
              Poisson opening-phase model
            </div>
            <p className="mt-1 text-slate-400">
              λ(0–5&apos;) = λ(match) × 5/{data?.model.matchMinutes ?? 96} × opening
              intensity × tempo. P(Yes) = 1 − e<sup>−λ</sup>.
            </p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-violet-300">
              Real data only
            </div>
            <p className="mt-1 text-slate-400">
              Goals come from Bzzoiro rolling xG or ESPN form averages; corners
              and cards come from mesh team distributions. A market with no real
              baseline is omitted — never synthesised.
            </p>
          </div>
          <div>
            <div className="font-mono uppercase tracking-wider text-teal-300">
              Cached for {(data?.cache.ttlMinutes ?? 60) / 60} hour
            </div>
            <p className="mt-1 text-slate-400">
              Results are cached for one hour. Refresh forces a fresh
              calculation across every upcoming fixture.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
            Markets
          </span>
          <FilterChip
            active={marketFilter === "all"}
            onClick={() => setMarketFilter("all")}
            label="All 3 markets"
          />
          {/* No penalty market exists — the API publishes goal/corner/card only. */}
          {MARKET_ORDER.filter((key) => key !== "penalty").map((key) => (
            <FilterChip
              key={key}
              active={marketFilter === key}
              onClick={() => setMarketFilter(key)}
              label={MARKET_LABEL[key]}
            />
          ))}
        </div>

        {error && (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5 text-sm text-rose-200">
            <div className="font-bold">
              First 5 Minutes Markets are temporarily unavailable
            </div>
            <p className="mt-1 text-rose-200/70">{error}</p>
            <button
              type="button"
              onClick={() => void load(false)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-rose-400/30 bg-rose-400/10 px-4 py-2 text-xs font-semibold text-rose-200 transition hover:bg-rose-400/20"
            >
              🔄 Retry
            </button>
          </div>
        )}

        {loading && !data ? (
          <LoadingSkeleton />
        ) : data && data.matches.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>
                {data.matches.length} upcoming match
                {data.matches.length === 1 ? "" : "es"} ·{" "}
                {publishedMarkets} markets published · {skippedFixtures} fixtures
                skipped (no data) · {highConfidenceCount} HIGH confidence ·{" "}
                {guaranteedCount} likely guaranteed
              </span>
              <span className="font-mono">
                Updated {formatDateTime(data.generatedAt)}
                {data.cache.hit ? " · cached" : ""}
              </span>
            </div>

            {refreshing && (
              <div className="flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs text-cyan-200">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-300" />
                Recalculating every market from fresh pre-match statistics…
              </div>
            )}

            <div className="space-y-8">
              {groupedMatches.map((group) => (
                <div key={group.leagueSlug} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="h-px flex-1 bg-cyan-400/15" />
                    <h2 className="rounded-full border border-violet-400/20 bg-violet-500/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-violet-200">
                      {group.leagueName}
                    </h2>
                    <div className="h-px flex-1 bg-cyan-400/15" />
                  </div>

                  <div className="grid gap-4 xl:grid-cols-2">
                    {group.matches.map((match, index) => (
                      <MatchCard
                        key={match.fixtureId}
                        match={match}
                        index={index}
                        marketFilter={marketFilter}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : !error ? (
          <EmptyState onRetry={() => void load(true)} />
        ) : null}

        <RecentResults matches={settledMatches} loading={settledLoading} />

        <p className="border-t border-cyan-400/10 pt-4 text-center text-[11px] leading-relaxed text-slate-500">
          Opening-phase markets are inherently volatile. Odds shown are model
          prices (fair odds plus a 1xBet-style tick round), not a bookmaker quote,
          and no model can guarantee a sports result.
        </p>
      </div>
    </main>
  );
}

// ─── Recent Results (settled history) ─────────────────────────────────────────
// Below the upcoming board: what the model actually got right, newest first.
// Outcome palette follows the track-record dashboards — green WIN, red LOSS,
// amber PUSH, grey VOID.

const OUTCOME_STYLES: Record<SettledOutcome, { chip: string; dot: string; note: string }> = {
  WIN: {
    chip: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
    dot: "bg-emerald-400",
    note: "HIT — the pick won",
  },
  LOSS: {
    chip: "border-rose-500/40 bg-rose-500/15 text-rose-300",
    dot: "bg-rose-400",
    note: "MISS — the pick lost",
  },
  PUSH: {
    chip: "border-amber-500/40 bg-amber-500/15 text-amber-300",
    dot: "bg-amber-400",
    note: "PUSH — stake returned",
  },
  VOID: {
    chip: "border-slate-500/40 bg-slate-500/15 text-slate-300",
    dot: "bg-slate-400",
    note: "VOID — market void, stake returned",
  },
};

/** Claimed probability as a percentage: 0.87 → "87", 0.875 → "87.5". */
function formatHitRate(hitRate: number): string {
  const percent = hitRate * 100;
  if (!Number.isFinite(percent)) return "0";
  return String(Math.round(percent * 10) / 10);
}

function settledLeagueName(match: SettledMatch): string {
  // Same spacing rule the upcoming board applies to La Liga.
  if (match.leagueSlug === "esp.1") return "La Liga";
  return LEAGUE_MAP[match.leagueSlug]?.name ?? match.league ?? "Unknown competition";
}

function OutcomeBadge({ outcome }: { outcome: SettledOutcome }) {
  const style = OUTCOME_STYLES[outcome];
  return (
    <span
      title={style.note}
      aria-label={`${outcome} — ${style.note}`}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] font-bold tracking-wide ${style.chip}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {outcome}
    </span>
  );
}

function RecentResultRow({ match }: { match: SettledMatch }) {
  const score =
    match.homeScore === null || match.awayScore === null
      ? "—"
      : `${match.homeScore}-${match.awayScore}`;

  return (
    <article className="rounded-2xl border border-emerald-500/15 bg-emerald-500/[0.04] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-100">{match.matchLabel}</h3>
        <span className="font-mono text-sm font-bold text-cyan-200" title="Final score">
          {score}
        </span>
      </div>
      <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
        {settledLeagueName(match)} · {match.matchDate}
      </div>

      <div className="mt-2 space-y-1.5">
        {match.markets.map((entry, index) => (
          <div
            key={`${entry.market}-${entry.selection}-${index}`}
            className="rounded-xl border border-white/5 bg-black/25 px-2.5 py-2"
          >
            <div className="text-[11px] font-semibold text-slate-300">
              {entry.market || "First 5 market"} · {entry.selection || "—"}
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-slate-400">
              Model: {formatHitRate(entry.hitRate)}% ({entry.confidence})
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
                Result:
              </span>
              <OutcomeBadge outcome={entry.outcome} />
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function RecentResults({
  matches,
  loading,
}: {
  matches: SettledMatch[] | null;
  loading: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Newest first. The endpoint already orders the window this way; sorting here
  // keeps that guarantee at the point of rendering.
  const all = useMemo(
    () => [...(matches ?? [])].sort((left, right) => right.matchDate.localeCompare(left.matchDate)),
    [matches],
  );
  const visible = expanded ? all : all.slice(0, RECENT_RESULTS_VISIBLE);

  // Tallies are per settled MARKET (a match usually carries several), exactly
  // how the performance tracker counts picks: won = WIN rows, lost = LOSS rows,
  // and pushes/voids are neither.
  const won = all.reduce(
    (sum, match) => sum + match.markets.filter((market) => market.outcome === "WIN").length,
    0,
  );
  const lost = all.reduce(
    (sum, match) => sum + match.markets.filter((market) => market.outcome === "LOSS").length,
    0,
  );
  const decided = won + lost;
  const realisedRate = decided > 0 ? `${((won / decided) * 100).toFixed(1)}%` : null;

  return (
    <section
      id="recent-results"
      aria-labelledby="recent-results-heading"
      className="space-y-4"
    >
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-emerald-400/15" />
        <h2
          id="recent-results-heading"
          className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-emerald-200"
        >
          📊 RECENT RESULTS — LAST {RECENT_RESULTS_DAYS} DAYS
        </h2>
        <div className="h-px flex-1 bg-emerald-400/15" />
      </div>

      {loading && matches === null ? (
        <div className="flex items-center gap-2 text-xs text-slate-500" aria-busy="true">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-700 border-t-emerald-400" />
          <span className="font-mono">Loading settled results…</span>
        </div>
      ) : all.length === 0 ? (
        <p className="rounded-2xl border border-slate-700/40 bg-slate-800/20 px-4 py-3 text-xs text-slate-500">
          No settled predictions in the last {RECENT_RESULTS_DAYS} days yet.
        </p>
      ) : (
        <>
          <p className="text-xs text-slate-400">
            <span className="font-semibold text-slate-200">{all.length}</span> finished matches ·{" "}
            <span className="font-semibold text-emerald-300">{won} won</span> ·{" "}
            <span className="font-semibold text-rose-300">{lost} lost</span> ·{" "}
            <span className="font-semibold text-cyan-200">{realisedRate ?? "—"}</span> hit rate
          </p>

          <div className="space-y-2">
            {visible.map((match) => (
              <RecentResultRow key={match.eventId} match={match} />
            ))}
          </div>

          {all.length > RECENT_RESULTS_VISIBLE && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
                className="rounded-full border border-slate-700 bg-slate-800 px-4 py-1.5 text-[11px] font-semibold text-slate-300 transition hover:bg-slate-700 hover:text-white"
              >
                {expanded ? "Show fewer" : `Show all ${all.length}`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all duration-200 ${
        active
          ? "bg-gradient-to-r from-cyan-400 to-teal-400 text-white shadow-lg shadow-cyan-500/30"
          : "bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white"
      }`}
    >
      {label}
    </button>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-400" />
        <span className="font-mono text-cyan-200">
          Pricing opening-phase markets from real pre-match statistics…
        </span>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {[1, 2, 3, 4].map((card) => (
          <div
            key={card}
            className="rounded-2xl border border-cyan-500/15 bg-cyan-500/5 p-4"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="h-4 w-28 animate-pulse rounded-full bg-cyan-400/10" />
              <div className="h-4 w-20 animate-pulse rounded-full bg-cyan-400/10" />
            </div>
            <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <div className="flex items-center justify-end gap-1.5">
                <div className="h-4 w-20 animate-pulse rounded bg-white/[0.06]" />
                <div className="h-6 w-6 animate-pulse rounded-full bg-cyan-400/15" />
              </div>
              <div className="h-3 w-5 animate-pulse rounded bg-white/[0.04]" />
              <div className="flex items-center gap-1.5">
                <div className="h-6 w-6 animate-pulse rounded-full bg-cyan-400/15" />
                <div className="h-4 w-20 animate-pulse rounded bg-white/[0.06]" />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {[1, 2, 3, 4].map((tile) => (
                <div
                  key={tile}
                  className="space-y-2 rounded-xl border border-cyan-500/15 bg-black/20 p-3"
                >
                  <div className="h-3 w-16 animate-pulse rounded-full bg-cyan-400/10" />
                  <div className="grid grid-cols-2 gap-2">
                    <div className="h-16 animate-pulse rounded-lg bg-emerald-500/10" />
                    <div className="h-16 animate-pulse rounded-lg bg-rose-500/10" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
