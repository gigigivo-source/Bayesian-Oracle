"use client";

import { useEffect, useMemo, useState } from "react";
import type { EngineResult, Market, DeepStatsVector } from "@/lib/engine/types";
import type { FixtureLite, MatchSummary, TeamForm } from "@/lib/espn";
import { ConfidenceBar, GradeBadge, MarketTable, Section, TeamBadge } from "./ui";
import { EventIcon, OutcomeBadge } from "./Icons";
import { CHIP, CHIP_OFF, CHIP_ON_AMBER, CHIP_ON_EMERALD, CHIP_ON_ROSE, OUTLINE_NEUTRAL } from "./design";

function getActualStat(
  marketName: string,
  fx: FixtureLite,
  bs?: Record<string, number> | null
): string | null {
  const hScore = Number(fx.home.score) || 0;
  const aScore = Number(fx.away.score) || 0;
  const hn = fx.home.name;
  const an = fx.away.name;

  if (marketName.includes("Total Goals")) return String(hScore + aScore);
  if (marketName.includes(`${hn} Goals`)) return String(hScore);
  if (marketName.includes(`${an} Goals`)) return String(aScore);
  if (marketName === "Both Teams To Score") return hScore > 0 && aScore > 0 ? "Yes" : "No";
  if (marketName.includes("Clean Sheet")) {
    return marketName.includes(hn) ? (aScore === 0 ? "Yes" : "No") : (hScore === 0 ? "Yes" : "No");
  }

  if (!bs) return null;

  if (marketName.includes("Total Shots") && !marketName.includes("SOT")) return String((bs.homeShots ?? 0) + (bs.awayShots ?? 0));
  if (marketName.includes(`${hn} Shots`) && !marketName.includes("SOT")) return String(bs.homeShots ?? 0);
  if (marketName.includes(`${an} Shots`) && !marketName.includes("SOT")) return String(bs.awayShots ?? 0);
  if (marketName.includes("Total SOT")) return String((bs.homeSot ?? 0) + (bs.awaySot ?? 0));
  if (marketName.includes(`${hn} SOT`)) return String(bs.homeSot ?? 0);
  if (marketName.includes(`${an} SOT`)) return String(bs.awaySot ?? 0);
  if (marketName.includes("Total Corners")) return String((bs.homeCorners ?? 0) + (bs.awayCorners ?? 0));
  if (marketName.includes(`${hn} Corners`)) return String(bs.homeCorners ?? 0);
  if (marketName.includes(`${an} Corners`)) return String(bs.awayCorners ?? 0);
  if (marketName.includes("Total Cards")) return String((bs.homeCards ?? 0) + (bs.awayCards ?? 0));
  if (marketName.includes(`${hn} Cards`)) return String(bs.homeCards ?? 0);
  if (marketName.includes(`${an} Cards`)) return String(bs.awayCards ?? 0);
  if (marketName.includes("Total Offsides")) return String((bs.homeOffsides ?? 0) + (bs.awayOffsides ?? 0));
  if (marketName.includes(`${hn} GK Saves`)) return String(bs.homeSaves ?? 0);
  if (marketName.includes(`${an} GK Saves`)) return String(bs.awaySaves ?? 0);
  if (marketName.includes("Total Saves")) return String((bs.homeSaves ?? 0) + (bs.awaySaves ?? 0));
  if (marketName.includes("Total Fouls")) return bs.homeFouls != null ? String((bs.homeFouls ?? 0) + (bs.awayFouls ?? 0)) : null;
  if (marketName.includes("Throw-ins")) return "N/A";
  if (marketName.includes("Aerial") || marketName.includes("Dribbles")) return "N/A";

  return null;
}

// ─── Ranking factors toggle (additive — hidden when a pick has no factors) ───

function factorBarColor(v: number): string {
  if (v >= 0.85) return "bg-emerald-400";
  if (v >= 0.70) return "bg-amber-400";
  if (v >= 0.55) return "bg-cyan-400";
  return "bg-rose-400";
}

function RankingFactorsToggle({ market }: { market: Market }) {
  const [open, setOpen] = useState(false);
  const factors = market.factors;

  // Optional by design: picks without a factor breakdown render nothing.
  if (!factors || Object.keys(factors).length === 0) return null;

  const entries = Object.entries(factors);
  const composite = market.compositeScore;

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`${CHIP} ${open ? CHIP_ON_AMBER : CHIP_OFF} px-3 py-1 text-xs font-semibold`}
      >
        {open ? "Hide Ranking Factors ▴" : "Show Ranking Factors ▾"}
      </button>

      {open && (
        <div className="mt-3 rounded-lg border border-slate-700 bg-[#0F1117] p-3">
          <div className="mb-2 flex items-center justify-between font-mono text-[11px] uppercase tracking-wider text-slate-400">
            <span>12-Factor Ranking Breakdown</span>
            {composite !== undefined && (
              <span className="text-amber-300 font-bold">
                Composite: {(composite * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <ul className="space-y-1.5">
            {entries.map(([name, value]) => (
              <li key={name} className="flex items-center gap-2 text-xs">
                <span className="w-44 shrink-0 truncate text-slate-300 font-mono">{name}</span>
                <span className="flex-1 h-2 rounded-full bg-slate-800 overflow-hidden">
                  <span
                    className={`block h-full rounded-full ${factorBarColor(value)}`}
                    style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
                  />
                </span>
                <span className="w-12 shrink-0 text-right font-mono font-bold text-slate-200">
                  {(value * 100).toFixed(0)}%
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-slate-500 font-mono">
            Unavailable factors are excluded and their weight redistributed — real data only.
          </p>
        </div>
      )}
    </div>
  );
}

interface ValueBetData {
  market: { name: string; selection: string; hitRate: number; family: string };
  oracleProbability: number;
  bookImpliedProbability: number;
  valueEdge: number;
  bookDecimalOdds: number;
  kellyStake: number;
  expectedROI: number;
  clvDirection: "STEAM" | "DRIFT" | "STABLE" | null;
  provider: string;
}

interface MatchResponse {
  fixture: FixtureLite;
  summary: MatchSummary | null;
  prediction: EngineResult;
  boxscore?: Record<string, number> | null;
  valueBets?: ValueBetData[];
}

export function MatchDetail({ fixture, onClose }: { fixture: FixtureLite; onClose: () => void }) {
  // Response is keyed by the fixture it was fetched for, so loading/error states
  // are derived and never need to be reset synchronously inside the effect.
  const [response, setResponse] = useState<{ fixture: FixtureLite; data: MatchResponse | null; error: string | null } | null>(null);
  const [familyFilter, setFamilyFilter] = useState("ALL");
  const [showJson, setShowJson] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixture }),
    })
      .then((r) => r.json())
      .then((d: MatchResponse & { error?: string }) => {
        if (!active) return;
        if (d.error) setResponse({ fixture, data: null, error: d.error });
        else setResponse({ fixture, data: d, error: null });
      })
      .catch(() => { if (active) setResponse({ fixture, data: null, error: "Failed to reach oracle." }); });
    return () => { active = false; };
  }, [fixture]);

  const current = response && response.fixture === fixture ? response : null;
  const loading = !current;
  const data = current?.data ?? null;
  const error = current?.error ?? null;

  const result = data?.prediction ?? null;
  const summary = data?.summary ?? null;

  const families = useMemo(() => (result ? Object.keys(result.familyCounts).sort() : []), [result]);
  const registry: Market[] = useMemo(() => {
    if (!result) return [];
    const list = familyFilter === "ALL" ? result.markets : result.markets.filter((m) => m.family === familyFilter);
    return [...list].sort((a, b) => b.hitRate - a.hitRate);
  }, [result, familyFilter]);

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#0F1117] ">
      <div className="mx-auto my-6 max-w-6xl px-4">
        {/* Modal Top Bar */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <h2 className="font-mono text-sm font-bold text-amber-300">ĞIGI GIVØ · DEEP STATISTICAL ORACLE</h2>
          </div>
          <button
            onClick={onClose}
            className={`${OUTLINE_NEUTRAL} px-4 py-1.5 text-sm`}
          >
            ✕ Close
          </button>
        </div>

        {/* Match Score & Teams Header */}
        <div className="mb-4 rounded-lg bg-slate-900 p-4">
          <div className="mb-2 text-center text-xs text-slate-400 font-mono">
            {fixture.leagueName} · {new Date(fixture.date).toLocaleString()}
          </div>
          <div className="flex items-center justify-center gap-6">
            <div className="flex flex-1 items-center justify-end gap-3">
              <span className="text-right text-lg font-bold text-slate-100">{fixture.home.name}</span>
              <TeamBadge logo={fixture.home.logo} name={fixture.home.name} size={48} />
            </div>
            <div className="text-center min-w-[100px]">
              <div className="font-mono text-3xl font-extrabold text-amber-300">
                {fixture.state === "pre" ? "VS" : `${fixture.home.score ?? 0} - ${fixture.away.score ?? 0}`}
              </div>
              <div className="text-[11px] font-mono text-emerald-400 mt-1">{fixture.statusDetail}</div>
            </div>
            <div className="flex flex-1 items-center gap-3">
              <TeamBadge logo={fixture.away.logo} name={fixture.away.name} size={48} />
              <span className="text-lg font-bold text-slate-100">{fixture.away.name}</span>
            </div>
          </div>
          {fixture.venue ? (
            <div className="mt-3 text-center text-xs text-slate-400">{fixture.venue}</div>
          ) : null}

          {/* SECTION JUMP NAVIGATION CHIPS */}
          {result ? (
            <div className="mt-4 flex flex-wrap items-center gap-1.5 pt-3 border-t border-slate-700 text-xs font-mono">
              <span className="text-amber-300 font-bold mr-1">JUMP TO:</span>
              {[
                { id: "sec-deep-stats", label: "Deep Stats" },
                { id: "sec-top-pick", label: "Top Pick" },
                { id: "sec-top-10", label: "Top 10 Picks" },
                { id: "sec-safe-modes", label: "Safe Modes" },
                { id: "sec-lineups", label: "Lineups & H2H" },
                { id: "sec-registry", label: `Full Registry (${result.totalMarkets})` },
              ].map((s) => (
                <button
                  key={s.id}
                  onClick={() => scrollToSection(s.id)}
                  className={`${CHIP} ${CHIP_OFF} px-3 py-1 text-xs font-medium hover:text-amber-200`}
                >
                  {s.label}
                </button>
              ))}
              {fixture.state === "pre" && (
                <button
                  onClick={() => scrollToSection("sec-value")}
                  className={`${CHIP} ${CHIP_ON_EMERALD} px-3 py-1 text-xs`}
                >
                  Value Bets
                </button>
              )}
              {fixture.state === "in" && (
                <button
                  onClick={() => scrollToSection("sec-live-centre")}
                  className={`${CHIP} ${CHIP_ON_ROSE} animate-pulse px-3 py-1 text-xs`}
                >
                  Live Match Centre
                </button>
              )}
              {(fixture.state === "post" || (fixture.home.score !== null && fixture.away.score !== null && fixture.state !== "pre")) && (
                <button
                  onClick={() => scrollToSection("sec-verified")}
                  className={`${CHIP} ${CHIP_ON_EMERALD} animate-pulse px-3 py-1 text-xs`}
                >
                  Post-Match Verification
                </button>
              )}
            </div>
          ) : null}
        </div>

        {loading ? (
          <div className="rounded-lg bg-slate-900 p-10 text-center text-slate-200">
            <div className="mb-3 animate-pulse font-mono text-lg text-amber-300">
              Running Deep Statistical Analysis…
            </div>
            <div className="text-xs text-slate-400 font-mono">
              Fetching xG · Cross-matching GF/GA Form · De-vigging Bookmaker Odds · Calculating Markets via Poisson &amp; Negative Binomial
            </div>
          </div>
        ) : error ? (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-6 text-rose-300">{error}</div>
        ) : result ? (
          <div className="space-y-6">
            {/* POST MATCH VERIFICATION ACCURACY BANNER */}
            {result.evaluatedCount && result.evaluatedCount > 0 ? (
              <div className="rounded-xl border border-emerald-500/40 bg-gradient-to-r from-emerald-950/60 via-slate-900 to-emerald-950/60 p-5 shadow-2xl">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-extrabold text-emerald-300 font-mono">
                      POST-MATCH ORACLE VERIFICATION: {result.hitCount}/{result.evaluatedCount} HIT ({((result.hitCount! / result.evaluatedCount!) * 100).toFixed(0)}% ACCURACY)
                    </h3>
                    <p className="text-xs text-slate-300 mt-1 font-mono">
                      Final Score: {fixture.home.name} {fixture.home.score} - {fixture.away.score} {fixture.away.name}. Evaluated against Bayesian Top 10 Picks.
                    </p>
                  </div>
                  <div className="rounded-lg bg-emerald-500/20 border border-emerald-500/40 px-4 py-2 font-mono text-center">
                    <div className="text-2xl font-extrabold text-emerald-300">
                      {result.hitCount}/{result.evaluatedCount}
                    </div>
                    <div className="text-[10px] text-emerald-200 font-bold uppercase">SUCCESS SCORE</div>
                  </div>
                </div>
              </div>
            ) : null}

            {/* DEEP STATISTICS DASHBOARD */}
            {result.deepStats ? (
              <Section
                id="sec-deep-stats"
                title="DEEP STATISTICAL VECTOR"
                subtitle="Raw per-90 metrics & de-vigged bookmaker probabilities used to generate market hit-rates"
              >
                <DeepStatsDashboard
                  stats={result.deepStats}
                  homeName={fixture.home.name}
                  awayName={fixture.away.name}
                />
              </Section>
            ) : null}

            {/* MATCH INTELLIGENCE CONTEXT */}
            {result.deepStats?.matchContext ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-lg border border-slate-700 p-3">
                  <div className="text-xs font-bold text-amber-300 font-mono mb-2">TACTICAL ANALYSIS</div>
                  <p className="text-sm text-slate-200 leading-relaxed">{result.deepStats.matchContext.tactics}</p>
                </div>
                <div className="rounded-lg border border-slate-700 p-3">
                  <div className="text-xs font-bold text-cyan-300 font-mono mb-2">MATCH IMPORTANCE</div>
                  <p className="text-sm text-slate-200 leading-relaxed">{result.deepStats.matchContext.importance}</p>
                </div>
                <div className="rounded-lg border border-slate-700 p-3">
                  <div className="text-xs font-bold text-emerald-300 font-mono mb-2">PLAYER vs PLAYER FORM</div>
                  <p className="text-sm text-slate-200 leading-relaxed">{result.deepStats.matchContext.playerMatchups}</p>
                </div>
                <div className="rounded-lg border border-slate-700 p-3">
                  <div className="text-xs font-bold text-rose-300 font-mono mb-2">ZERO BIAS GUARANTEE</div>
                  <p className="text-sm text-slate-200 leading-relaxed">{result.deepStats.matchContext.biasStatement}</p>
                </div>
              </div>
            ) : null}

            {/* LIVE MATCH CENTRE */}
            {(fixture.state === "in" || fixture.state === "post") && (
              <LiveMatchCentre leagueSlug={fixture.leagueSlug} eventId={fixture.id} isLive={fixture.state === "in"} />
            )}

            {/* Odds and form panels */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Section title="Live Bookmaker Feed" subtitle={summary?.odds?.provider ?? "Statistical Model"}>
                {summary?.odds ? (
                  <OddsView odds={summary.odds} home={fixture.home.abbrev} away={fixture.away.abbrev} />
                ) : fixture.odds ? (
                  <OddsView odds={fixture.odds} home={fixture.home.abbrev} away={fixture.away.abbrev} />
                ) : (
                  <p className="text-sm text-slate-500">Pure statistical model mode active.</p>
                )}
              </Section>
              <FormPanel title={fixture.home.name} form={summary?.homeForm ?? null} />
              <FormPanel title={fixture.away.name} form={summary?.awayForm ?? null} />
            </div>

            {/* Top Pick */}
            {result.top1[0] ? (
              <Section
                id="sec-top-pick"
                title="HIGH-LIKELIHOOD TOP PICK"
                subtitle={`Data Completeness ${result.match.dataCompletenessScore}% · ${result.qualifiedMarkets}/${result.totalMarkets} Markets Scanned`}
              >
                <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-5 shadow-inner">
                  <div className="flex flex-wrap items-center gap-3">
                    <GradeBadge grade={result.top1[0].grade} />
                    <span className="text-xl font-bold text-amber-200">{result.top1[0].name}</span>
                    <span className="rounded bg-emerald-500/20 px-2.5 py-1 text-xs font-bold text-emerald-300 border border-emerald-500/30">
                      {result.top1[0].selection}
                    </span>
                  </div>
                  <div className="mt-3">
                    <ConfidenceBar value={result.top1[0].hitRate} lower={result.top1[0].ciLower} upper={result.top1[0].ciUpper} />
                  </div>
                  <div className="mt-3 text-sm text-slate-300 flex flex-wrap gap-4 font-mono">
                    <span>Fair Odds (Worst Case): <strong className="text-amber-300">{result.top1[0].fairOddsWorst.toFixed(2)}</strong></span>
                    <span>MQS: <strong className="text-slate-100">{result.top1[0].mqs.toFixed(1)}/10</strong></span>
                    <span>Disagreement Index: <strong className="text-slate-100">{(result.top1[0].disagreementIndex * 100).toFixed(1)}%</strong></span>
                  </div>
                </div>
              </Section>
            ) : null}

            {/* Lambda Vector */}
            <Section title="CONDITIONAL λ VALUES (EXPECTED EVENT RATES)" subtitle="Grounded strictly in deep statistics & de-vigged market odds">
              <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 font-mono">
                {Object.entries(result.lambdas).map(([k, v]) => (
                  <div key={k} className="rounded-md border border-slate-700 px-3 py-2">
                    <div className="text-[11px] text-slate-400">{k}</div>
                    <div className="text-base font-bold text-amber-300">{v}</div>
                  </div>
                ))}
              </div>
            </Section>

            {/* Top 10 */}
            <Section
              id="sec-top-10"
              title="TOP 10 HIGHEST HIT RATE MARKETS"
              subtitle="Every pick contains rationale: Why Qualified · Why Selected · Why Outcome is Possible"
            >
              <MarketTable
                markets={result.top10}
                showDeepExplanation={true}
                renderPickFooter={(m) => <RankingFactorsToggle market={m} />}
              />
            </Section>

            {/* VALUE BETS */}
            {data?.valueBets && data.valueBets.length > 0 && fixture.state === "pre" && (
              <Section
                id="sec-value"
                title="VALUE BETS — Edge Over Bookmaker"
                subtitle={`Markets where oracle probability exceeds bookmaker implied probability`}
              >
                <div className="space-y-2">
                  {data.valueBets.filter(v => v.valueEdge > 0).slice(0, 8).map((v, i) => (
                    <div key={i} className="bg-slate-800 rounded-lg p-3 border border-emerald-500/20">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <div>
                          <div className="text-sm font-bold text-white">{v.market.name}</div>
                          <span className="rounded bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-xs font-mono font-bold text-emerald-300">
                            {v.market.selection}
                          </span>
                        </div>
                        <div className="text-right">
                          <div className="text-lg font-extrabold font-mono text-emerald-300">+{(v.valueEdge * 100).toFixed(1)}%</div>
                          <div className="text-[10px] text-slate-400">value edge</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-2 text-center text-xs">
                        <div className="bg-slate-800 rounded p-2">
                          <div className="text-[10px] text-slate-400 font-mono">ORACLE</div>
                          <div className="font-mono font-bold text-amber-300">{(v.oracleProbability * 100).toFixed(1)}%</div>
                        </div>
                        <div className="bg-slate-800 rounded p-2">
                          <div className="text-[10px] text-slate-400 font-mono">BOOK IMPLIED</div>
                          <div className="font-mono font-bold text-slate-300">{(v.bookImpliedProbability * 100).toFixed(1)}%</div>
                        </div>
                        <div className="bg-slate-800 rounded p-2">
                          <div className="text-[10px] text-slate-400 font-mono">BOOK ODDS</div>
                          <div className="font-mono font-bold text-white">{v.bookDecimalOdds.toFixed(2)}</div>
                        </div>
                        <div className="bg-slate-800 rounded p-2">
                          <div className="text-[10px] text-slate-400 font-mono">KELLY STAKE</div>
                          <div className="font-mono font-bold text-cyan-300">{(v.kellyStake * 100).toFixed(1)}%</div>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-[10px] font-mono text-slate-400">
                        <span>Expected ROI: <strong className={v.expectedROI > 0 ? "text-emerald-300" : "text-rose-300"}>{v.expectedROI > 0 ? "+" : ""}{(v.expectedROI * 100).toFixed(1)}%</strong></span>
                        <span>{v.provider}</span>
                      </div>
                      {v.kellyStake > 0 && (
                        <div className="mt-2 bg-emerald-500/5 border border-emerald-500/20 rounded p-2 text-xs text-emerald-300 font-mono">
                          Bankroll $1000 → Recommended stake: <strong>${(v.kellyStake * 1000).toFixed(2)}</strong> at {v.bookDecimalOdds.toFixed(2)} odds → Potential return: <strong>${(v.kellyStake * 1000 * v.bookDecimalOdds).toFixed(2)}</strong>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Safe / Ultra-Safe Modes */}
            <div id="sec-safe-modes" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Section title="SAFE MODE" subtitle="Hit Rate > 80% · DI < 8% · Tight CI">
                {result.safeMode.length ? <MarketTable markets={result.safeMode} /> : <Empty />}
              </Section>
              <Section title="ULTRA-SAFE MODE" subtitle="Hit Rate > 93% · CI-Lower > 88%">
                {result.ultraSafe.length ? <MarketTable markets={result.ultraSafe} /> : <Empty />}
              </Section>
            </div>

            {/* Lineups & H2H */}
            <div id="sec-lineups" className="space-y-4">
              {summary?.lineupAvailable ? (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <LineupPanel title={`${fixture.home.name} Confirmed XI`} players={summary.homeLineup} />
                  <LineupPanel title={`${fixture.away.name} Confirmed XI`} players={summary.awayLineup} />
                </div>
              ) : (
                <Section title="LINEUPS STATUS" subtitle="Confirmed XIs publish ~1 hour before kickoff">
                  <p className="text-sm text-slate-400">
                    Lineups not yet published for this fixture. The oracle is running on recent-form and market signals.
                  </p>
                </Section>
              )}

              {summary?.h2h?.length ? (
                <Section title="HEAD-TO-HEAD HISTORY" subtitle="Real prior match outcomes">
                  <div className="space-y-1.5 text-sm">
                    {summary.h2h.map((g, i) => (
                      <div key={i} className="flex items-center justify-between rounded-md border border-slate-700 px-3 py-2 font-mono">
                        <span className="text-slate-400 text-xs">{g.date?.slice(0, 10)}</span>
                        <span className="text-slate-200">
                          {g.home} <span className="font-bold text-amber-300 mx-2">{g.score}</span> {g.away}
                        </span>
                      </div>
                    ))}
                  </div>
                </Section>
              ) : null}
            </div>

            {/* Post-match boxscore */}
            {fixture.state === "post" ? (
              <BoxscorePanel leagueSlug={fixture.leagueSlug} eventId={fixture.id} homeName={fixture.home.name} awayName={fixture.away.name} />
            ) : null}

            {/* POST-MATCH TOP 10 VERIFICATION */}
            {(fixture.state === "post" || (fixture.home.score !== null && fixture.away.score !== null)) && result.evaluatedCount && result.evaluatedCount > 0 ? (
              <Section
                id="sec-verified"
                title="POST-MATCH TOP 10 VERIFICATION"
                subtitle={`Oracle predictions verified against real ESPN boxscore · Final Score: ${fixture.home.name} ${fixture.home.score} - ${fixture.away.score} ${fixture.away.name}`}
              >
                <div className="bg-slate-800 rounded-lg p-4 mb-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm text-slate-300 font-mono">Accuracy Score</div>
                      <div className="text-3xl font-extrabold font-mono text-emerald-300">
                        {result.hitCount}/{result.evaluatedCount}
                        <span className="text-lg ml-2 text-emerald-400">
                          ({((result.hitCount! / result.evaluatedCount!) * 100).toFixed(0)}%)
                        </span>
                      </div>
                    </div>
                    <div className={`rounded-lg px-4 py-2 text-center font-mono text-sm font-bold ${
                      result.hitCount === result.evaluatedCount
                        ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-300"
                        : "bg-amber-500/20 border border-amber-500/40 text-amber-300"
                    }`}>
                      {result.hitCount === result.evaluatedCount ? "PERFECT" : "VERIFIED"}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  {result.top10.map((m, i) => {
                    const bgColor = m.outcome === "HIT" ? "bg-emerald-500/5 border-emerald-500/30" : m.outcome === "MISS" ? "bg-rose-500/5 border-rose-500/30" : "bg-slate-800 border-slate-700";
                    const bs = data?.boxscore;
                    const actual = getActualStat(m.name, fixture, bs);
                    const line = parseFloat(m.name.split("O/U ")[1]);
                    return (
                      <div key={m.id} className={`rounded-lg border ${bgColor} p-4`}>
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-slate-500 w-6 text-right text-lg">{i + 1}.</span>
                          <OutcomeBadge outcome={m.outcome} />
                          <div className="flex-1 min-w-0">
                            <div className="font-bold text-white">{m.name}</div>
                            <div className="text-xs text-amber-300 font-mono mt-0.5">{m.family}</div>
                          </div>
                          <span className={`text-sm font-extrabold font-mono ${
                            m.outcome === "HIT" ? "text-emerald-300" : m.outcome === "MISS" ? "text-rose-300" : "text-slate-400"
                          }`}>
                            {m.outcome ?? "PENDING"}
                          </span>
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                          <div className="bg-slate-800 rounded-md p-2">
                            <div className="text-[10px] text-slate-500 font-mono uppercase">Predicted</div>
                            <div className="font-mono font-bold text-amber-300 text-sm">{m.selection}</div>
                            <div className="text-[10px] text-slate-500">Hit Rate: {(m.hitRate * 100).toFixed(1)}%</div>
                          </div>
                          <div className="bg-slate-800 rounded-md p-2">
                            <div className="text-[10px] text-slate-500 font-mono uppercase">Line</div>
                            <div className="font-mono font-bold text-white text-sm">{!isNaN(line) ? line.toFixed(1) : "—"}</div>
                            <div className="text-[10px] text-slate-500">Threshold</div>
                          </div>
                          <div className="bg-slate-800 rounded-md p-2">
                            <div className="text-[10px] text-slate-500 font-mono uppercase">Actual</div>
                            <div className={`font-mono font-bold text-sm ${
                              m.outcome === "HIT" ? "text-emerald-300" : m.outcome === "MISS" ? "text-rose-300" : "text-slate-300"
                            }`}>
                              {actual !== null ? actual : "—"}
                            </div>
                            <div className="text-[10px] text-slate-500">Real Result</div>
                          </div>
                        </div>
                        {m.reason && (
                          <div className="mt-2 text-[11px] text-slate-400 font-mono">{m.reason}</div>
                        )}
                        <div className="mt-2">
                          <RankingFactorsToggle market={m} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Section>
            ) : null}

            {/* Full Market Registry */}
            <Section
              id="sec-registry"
              title="FULL MARKET REGISTRY"
              subtitle={`Scanned across 18 market families (${registry.length} lines shown)`}
              right={
                <button
                  onClick={() => setShowJson((s) => !s)}
                  className={`${OUTLINE_NEUTRAL} px-2.5 py-1 text-xs font-mono`}
                >
                  {showJson ? "Hide JSON" : "JSON Export"}
                </button>
              }
            >
              {/* Family filter chips */}
              <div className="mb-4 flex flex-wrap items-center gap-1.5 font-mono text-xs border-b border-slate-700 pb-3">
                <span className="text-amber-300 font-bold mr-1">FAMILIES:</span>
                <button
                  onClick={() => setFamilyFilter("ALL")}
                  className={`${CHIP} px-3 py-1 text-xs font-medium ${
                    familyFilter === "ALL" ? CHIP_ON_AMBER : CHIP_OFF
                  }`}
                >
                  All ({result.totalMarkets})
                </button>
                {families.map((f) => (
                  <button
                    key={f}
                    onClick={() => setFamilyFilter(f)}
                    className={`${CHIP} px-3 py-1 text-xs font-medium ${
                      familyFilter === f ? CHIP_ON_AMBER : CHIP_OFF
                    }`}
                  >
                    {f} ({result.familyCounts[f]})
                  </button>
                ))}
              </div>

              {showJson && (
                <pre className="mb-4 max-h-80 overflow-auto rounded-lg border border-slate-700 bg-[#0F1117] p-3 text-[11px] text-emerald-300 font-mono">
                  {JSON.stringify({ match: result.input.match, date: result.input.date, markets: registry.slice(0, 30) }, null, 2)}
                </pre>
              )}
              <MarketTable markets={registry} />
            </Section>

            {/* Calibration & Rejections */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Section title="REJECTED MARKETS" subtitle="Grade D (entropy/disagreement penalties)">
                {result.rejected.length ? (
                  <div className="grid grid-cols-1 gap-1.5 max-h-60 overflow-y-auto pr-1">
                    {result.rejected.map((m) => (
                      <div key={m.id} className="rounded-md border border-rose-500/20 bg-rose-500/5 px-3 py-1.5 text-xs">
                        <span className="text-slate-300 font-medium">{m.name}</span>
                        <span className="ml-2 text-rose-400 font-mono">✗ {m.rejectReason ?? "hitRate < 0.5"}</span>
                      </div>
                    ))}
                  </div>
                ) : <Empty />}
              </Section>
              <Section title="DATA PROVENANCE & CALIBRATION NOTES" subtitle="Real data tracking log">
                <ul className="space-y-1 text-xs text-slate-400 font-mono">
                  {result.calibrationNotes.map((n, i) => (
                    <li key={i}>• {n}</li>
                  ))}
                </ul>
              </Section>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DeepStatsDashboard({ stats, homeName, awayName }: { stats: DeepStatsVector; homeName: string; awayName: string }) {
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-800 p-4">
        <table className="w-full text-center text-xs font-mono">
          <thead>
            <tr className="border-b border-slate-700 text-slate-400 text-[11px] uppercase">
              <th className="py-2 text-left font-sans text-amber-300">{homeName}</th>
              <th className="py-2 px-3">Metric</th>
              <th className="py-2 text-right font-sans text-amber-300">{awayName}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700 text-slate-200">
            {[
              [stats.homeXg.toFixed(2), "Expected Goals (xG)", stats.awayXg.toFixed(2)],
              [`${stats.homeGfAvg.toFixed(2)} / ${stats.homeGaAvg.toFixed(2)}`, "Goals Scored / Conceded per 90", `${stats.awayGfAvg.toFixed(2)} / ${stats.awayGaAvg.toFixed(2)}`],
              [stats.homeSotAvg.toFixed(1), "SOT per match", stats.awaySotAvg.toFixed(1)],
              [stats.homeCornersAvg.toFixed(1), "Corners per match", stats.awayCornersAvg.toFixed(1)],
              [stats.homeCardsAvg.toFixed(1), "Yellow Cards per match", stats.awayCardsAvg.toFixed(1)],
              [stats.homeFoulsAvg.toFixed(1), "Fouls Committed per match", stats.awayFoulsAvg.toFixed(1)],
              [`${stats.homePossessionPct}%`, "Possession Share Baseline", `${stats.awayPossessionPct}%`],
            ].map(([h, label, a], i) => (
              <tr key={i}>
                <td className="py-2 text-left font-bold text-amber-300">{h}</td>
                <td className="py-2 px-3 text-slate-400 font-sans">{label}</td>
                <td className="py-2 text-right font-bold text-amber-300">{a}</td>
              </tr>
            ))}
            {stats.marketHomeProb !== null && (
              <tr className="bg-amber-400/5">
                <td className="py-2 text-left font-bold text-emerald-300">{stats.marketHomeProb}%</td>
                <td className="py-2 px-3 text-slate-300 font-sans font-medium">De-vigged Bookmaker Implied Probs (1X2)</td>
                <td className="py-2 text-right font-bold text-emerald-300">{stats.marketAwayProb}% (X: {stats.marketDrawProb}%)</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div>
        <div className="mb-2 text-xs font-semibold text-slate-300 uppercase tracking-wider">
          Autonomous Multi-Source Data Mesh (100% Fetched — Zero Simulation)
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 text-xs font-mono">
          {stats.sources.map((src) => (
            <div key={src.name} className="rounded-md border border-slate-700 p-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-200">{src.name}</span>
                <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300 font-bold">
                  Trust {src.trust}
                </span>
              </div>
              <div className="mt-1 text-[10px] text-slate-400 truncate">{src.coverage}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Empty() {
  return <p className="text-sm text-slate-500">No markets met these strict thresholds for this fixture.</p>;
}

function OddsView({ odds, home, away }: { odds: FixtureLite["odds"]; home: string; away: string }) {
  if (!odds) return null;
  return (
    <div className="space-y-2 text-sm font-mono">
      {odds.details ? (
        <div className="flex justify-between">
          <span className="text-slate-400 font-sans text-xs">Handicap</span>
          <span className="font-bold text-slate-200">{odds.details}</span>
        </div>
      ) : null}
      {odds.overUnder ? (
        <div className="flex justify-between">
          <span className="text-slate-400 font-sans text-xs">Total Goals (O/U)</span>
          <span className="font-bold text-amber-300">{odds.overUnder}</span>
        </div>
      ) : null}
      <div className="grid grid-cols-3 gap-2 pt-1 text-center">
        <MlBox label={home} ml={odds.homeML} />
        <MlBox label="Draw" ml={odds.drawML} />
        <MlBox label={away} ml={odds.awayML} />
      </div>
    </div>
  );
}

function MlBox({ label, ml }: { label: string; ml: number | null | undefined }) {
  return (
    <div className="rounded-md border border-slate-700 px-2 py-2">
      <div className="text-[10px] uppercase text-slate-400 font-sans">{label}</div>
      <div className="font-mono text-slate-200 font-bold">
        {ml === null || ml === undefined ? "—" : ml > 0 ? `+${ml}` : ml}
      </div>
    </div>
  );
}

function FormPanel({ title, form }: { title: string; form: TeamForm | null }) {
  return (
    <Section title={`Form · ${title}`} subtitle={form ? `Last ${form.games.length} · ${form.points} pts` : "Recent matches"}>
      {form && form.games.length ? (
        <div className="space-y-2">
          <div className="flex gap-1.5">
            {form.games.map((g, i) => (
              <span
                key={i}
                title={`${g.atVs} ${g.opponent} ${g.scoreFor}-${g.scoreAgainst}`}
                className={`flex h-7 w-7 items-center justify-center rounded text-xs font-bold font-mono ${
                  g.result === "W" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                  : g.result === "L" ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                  : "bg-slate-500/20 text-slate-300 border border-slate-500/30"
                }`}
              >
                {g.result}
              </span>
            ))}
          </div>
          <div className="text-xs text-slate-400 font-mono">
            GF Avg: <strong className="text-slate-200">{form.gfAvg.toFixed(2)}</strong> · GA Avg: <strong className="text-slate-200">{form.gaAvg.toFixed(2)}</strong>
          </div>
        </div>
      ) : (
        <p className="text-sm text-slate-500">Form feed unavailable.</p>
      )}
    </Section>
  );
}

function LineupPanel({ title, players }: { title: string; players: MatchSummary["homeLineup"] }) {
  const starters = players.filter((p) => p.starter);
  return (
    <Section title={title} subtitle={`${starters.length} starters`}>
      <div className="grid grid-cols-2 gap-2 text-xs">
        {starters.map((p, i) => (
          <div key={i} className="flex items-center gap-2 rounded border border-slate-700 px-2 py-1">
            <span className="w-5 font-mono text-slate-400 font-bold">{p.jersey ?? "-"}</span>
            <span className="flex-1 truncate text-slate-200">{p.name}</span>
            <span className="text-[10px] font-mono text-amber-300">{p.position}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function BoxscorePanel({ leagueSlug, eventId, homeName, awayName }: {
  leagueSlug: string; eventId: string; homeName: string; awayName: string;
}) {
  const [stats, setStats] = useState<Array<{ name: string; home: string; away: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/boxscore?league=${leagueSlug}&event=${eventId}`)
      .then((r) => r.json())
      .then((d: { stats?: Array<{ name: string; home: string; away: string }> }) => setStats(d.stats ?? []))
      .catch(() => setStats([]))
      .finally(() => setLoading(false));
  }, [leagueSlug, eventId]);

  if (loading || stats.length === 0) return null;

  return (
    <Section title="FINAL MATCH STATISTICS" subtitle="Real post-match boxscore from ESPN live feed">
      <div className="rounded-lg bg-slate-900 overflow-hidden">
        <div className="grid grid-cols-3 text-center text-xs font-mono px-3 py-2 bg-slate-800">
          <span className="text-amber-300 font-bold text-left">{homeName}</span>
          <span className="text-slate-400">Stat</span>
          <span className="text-amber-300 font-bold text-right">{awayName}</span>
        </div>
        {stats.map((s, i) => {
          const h = parseFloat(s.home) || 0;
          const a = parseFloat(s.away) || 0;
          const total = h + a || 1;
          const hPct = (h / total) * 100;
          return (
            <div key={i} className="px-3 py-1.5 border-t border-slate-700">
              <div className="grid grid-cols-3 text-center text-xs">
                <span className={`text-left font-mono ${h >= a ? "text-white font-bold" : "text-slate-300"}`}>{s.home}</span>
                <span className="text-slate-400 text-[11px]">{s.name}</span>
                <span className={`text-right font-mono ${a >= h ? "text-white font-bold" : "text-slate-300"}`}>{s.away}</span>
              </div>
              <div className="mt-1 flex h-1 rounded-full bg-emerald-500/20 overflow-hidden">
                <div className="bg-amber-400/70" style={{ width: `${hPct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function LiveMatchCentre({ leagueSlug, eventId, isLive }: { leagueSlug: string; eventId: string; isLive: boolean }) {
  const [data, setData] = useState<{
    keyEvents: Array<{ minute: string; type: string; text: string; team?: string }>;
    commentary: Array<{ minute: string; text: string }>;
    stats: Array<{ name: string; home: string; away: string }>;
    homeTeam: string;
    awayTeam: string;
  } | null>(null);
  const [tab, setTab] = useState<"events" | "stats" | "commentary">("events");

  useEffect(() => {
    function load() {
      fetch(`/api/live-centre?league=${leagueSlug}&event=${eventId}`)
        .then((r) => r.json())
        .then((d: typeof data & { error?: string }) => { if (!d?.error) setData(d); })
        .catch(() => {});
    }
    load();
    if (isLive) {
      const t = setInterval(load, 30000);
      return () => clearInterval(t);
    }
  }, [leagueSlug, eventId, isLive]);

  if (!data) return null;

  return (
    <Section
      id="sec-live-centre"
      title={isLive ? "LIVE MATCH CENTRE" : "MATCH CENTRE"}
      subtitle={isLive ? "Auto-refreshing every 30s" : "Key events, stats & commentary"}
    >
      <div className="flex gap-1.5 mb-4 font-mono text-xs">
        {(["events", "stats", "commentary"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`${CHIP} px-3 py-1 text-xs font-semibold capitalize ${
              tab === t ? CHIP_ON_AMBER : CHIP_OFF
            }`}
          >
            {t === "events" ? "Key Events" : t === "stats" ? "Match Stats" : "Commentary"}
          </button>
        ))}
        {isLive && (
          <span className="flex items-center gap-1.5 ml-auto text-rose-400 font-bold font-mono text-xs">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
            </span>
            LIVE
          </span>
        )}
      </div>

      {tab === "events" && (
        <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
          {data.keyEvents.length === 0 ? (
            <p className="text-sm text-slate-500 font-mono">No key events yet.</p>
          ) : data.keyEvents.map((e, i) => (
            <div key={i} className="flex items-center gap-3 bg-slate-800 rounded-md px-3 py-2">
              <span className="font-mono text-xs text-amber-300 w-8 text-right font-bold">{e.minute}</span>
              <EventIcon type={e.type} />
              <div className="flex-1 min-w-0">
                <span className="text-sm text-white">{e.text}</span>
                {e.team && <span className="text-[10px] text-slate-400 ml-2 font-mono">({e.team})</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "stats" && (
        <div className="bg-slate-800 rounded-lg overflow-hidden">
          <div className="grid grid-cols-3 text-center text-xs font-mono px-3 py-2 bg-slate-800 font-bold">
            <span className="text-amber-300 text-left">{data.homeTeam}</span>
            <span className="text-slate-400">Stat</span>
            <span className="text-amber-300 text-right">{data.awayTeam}</span>
          </div>
          {data.stats.length === 0 ? (
            <p className="text-sm text-slate-500 font-mono p-4 text-center">Stats not yet available.</p>
          ) : data.stats.map((s, i) => {
            const h = parseFloat(s.home) || 0;
            const a = parseFloat(s.away) || 0;
            const total = h + a || 1;
            return (
              <div key={i} className="px-3 py-2 border-t border-slate-700">
                <div className="grid grid-cols-3 text-center text-xs">
                  <span className={`text-left font-mono ${h >= a ? "text-white font-bold" : "text-slate-300"}`}>{s.home}</span>
                  <span className="text-slate-400 text-[11px]">{s.name}</span>
                  <span className={`text-right font-mono ${a >= h ? "text-white font-bold" : "text-slate-300"}`}>{s.away}</span>
                </div>
                <div className="mt-1 flex h-1 rounded-full bg-slate-800 overflow-hidden">
                  <div className="bg-amber-400/70" style={{ width: `${(h / total) * 100}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === "commentary" && (
        <div className="space-y-1 max-h-96 overflow-y-auto pr-1">
          {data.commentary.length === 0 ? (
            <p className="text-sm text-slate-500 font-mono">No commentary available.</p>
          ) : data.commentary.map((c, i) => (
            <div key={i} className="flex gap-3 bg-slate-800 rounded px-3 py-2 text-xs">
              <span className="font-mono text-amber-300 w-8 text-right font-bold shrink-0">{c.minute}</span>
              <span className="text-slate-200">{c.text}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
